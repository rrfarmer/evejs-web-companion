"use strict";

// The client's side of the ballpark: what arrives, when it is applied, and how
// the client keeps to the server's tick.
//
// ballpark.js steps the balls. This decides what tick it is. It is the retail
// client's own logic, from its `michelle` service (decompiled:
// eve/client/script/remote/michelle.py, class Park) and from the copy of the
// same logic CCP ships with destiny (python/destiny/net/client), which has
// tests:
//
//   michelle.py  FlushState (1098)                  an update joins the queue
//                DoPreTick (900)                    each tick, apply what is due
//                RealFlushState (1142)              apply one tick's group of entries
//                SynchroniseToSimulationTime (1074) step forward, or go back and step
//                StoreState (919), FlushSimulationHistory (1059), DoPostTick (859)
//                SetState (968), AddBalls (1235), AddBalls2 (1256),
//                RemoveBall (1303), RemoveBalls (1332)
//
// There is no clock exchange. The park's tick is whatever the last state it
// read said, plus one for each second of its own. An update for a tick one or
// two ahead waits; three or more ahead, the park is stepped up to it; behind,
// the park goes back to a snapshot of itself and is stepped forward to it, and
// stays there.
//
// One thing is read from the bytecode rather than the decompiled text: in
// RealFlushState the decompiler shows the "synchronise" steps beside the test
// for an entry that is not part of the simulation, which would reset the park
// on every special effect. They belong to its else, and a recorded update that
// begins with OnSpecialFX is applied without a reset.
//
// docs/game-port-destiny-notes.md, sections 3 and 6, is the map.

const { marshalDecode } = require("../../gameProtocol/marshal");
const { Ballpark, DSTLOCALBALLS } = require("./ballpark");

/** Park.__init__: handled here, in Python on the client, rather than by the simulation. */
const LOCAL_ACTIONS = new Set(["AddBalls", "AddBalls2", "RemoveBalls", "SetState", "RemoveBall", "TerminalPlayDestructionEffect"]);
/** Applied at once and in order, without moving the simulation to the entry's tick. */
const NON_DESTINY_CRITICAL = new Set([
  "OnDamageStateChange", "OnSpecialFX", "OnFleetDamageStateChange", "OnShipStateUpdate", "OnSlimItemChange",
  "OnDroneStateChange", "OnSovereigntyChanged", "OnDbuffUpdated", "OnClientControllerEvent", "OnDotVictimUpdated",
]);

/** destructionEffect/destructionType.py. */
const DESTRUCTION_EFFECT = { NONE: 0, EXPLOSION: 3 };

const text = (value) => (Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : value && typeof value.value === "string" ? value.value : null);
/** An argument the engine reads as a C int: Python 2.7 refuses a float there, and the entry fails. */
function wholeNumber(value, funcName) {
  if (!Number.isInteger(value)) throw new TypeError(`${funcName}: integer argument expected`);
  return value;
}
/** A ball id as the simulation keys it: a number when a number holds it. */
const ballId = (value) => (typeof value === "bigint" && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value);
const number = (value) => (typeof value === "bigint" ? Number(value) : value);
const items = (value) => (Array.isArray(value) ? value : value && Array.isArray(value.items) ? value.items : []);
/** The entries of a dict, of an object's state (util.KeyVal, a SlimItem), or nothing. */
function fieldsOf(value) {
  const dict = value && value.type === "object" ? value.args : value;
  return new Map((dict && Array.isArray(dict.entries) ? dict.entries : []).map(([key, entry]) => [text(key) ?? key, entry]));
}

/**
 * merge_state_into_history (destiny/net/client/_util.py), which is the second
 * half of Park.FlushState. The queue is a list of [entries, waitForBubble], one
 * per tick, in tick order; an incoming batch may not be in order, and may hold
 * more than one tick.
 */
function mergeStateIntoHistory(state, history, waitForBubble) {
  const entriesByTime = new Map();
  for (const entry of state) {
    if (!entriesByTime.has(entry[0])) entriesByTime.set(entry[0], []);
    entriesByTime.get(entry[0]).push(entry);
  }
  const timeList = [...entriesByTime.keys()].sort((a, b) => a - b);
  let timeListIdx = 0;
  // The list grows while it is walked, as it does under Python's enumerate.
  for (let historyIdx = 0; historyIdx < history.length; historyIdx += 1) {
    const historyTimeEntries = history[historyIdx];
    const historyTime = historyTimeEntries[0][0][0];
    const entryTime = timeList[timeListIdx];
    if (historyTime < entryTime) {
      // If a bubble's batch were still to come, it would be for an earlier tick than this.
      waitForBubble = false;
      continue;
    }
    if (historyTime === entryTime) {
      historyTimeEntries[0].push(...entriesByTime.get(entryTime));
      historyTimeEntries[1] = false;
    } else {
      history.splice(historyIdx, 0, [entriesByTime.get(entryTime), waitForBubble]);
      waitForBubble = false;
    }
    timeListIdx += 1;
    if (timeListIdx >= timeList.length) break;
  }
  for (let index = timeListIdx; index < timeList.length; index += 1) {
    history.push([entriesByTime.get(timeList[index]), waitForBubble]);
  }
}

class Park {
  /**
   * `onEvent(name, args, stamp)` is told of each entry as it is applied.
   * `requestState()` is called when the park has lost its place and needs the
   * server to send the whole state again (remoteBallpark.UpdateStateRequest).
   * `onMultiEvent(messages)` is given the dogma messages that ride along with
   * an update (the client scatters them as OnMultiEvent).
   * `onBallsRemoved(list)` is told which balls are leaving, and which of them
   * are being destroyed rather than going out of sight.
   */
  constructor({ ballpark = new Ballpark(), onEvent = null, requestState = null, onMultiEvent = null, onBallsRemoved = null, pilot = null } = {}) {
    this.ballpark = ballpark;
    /**
     * `pilot()` answers the session's character and ship, { charID, shipID }: a drone's state is kept only while the
     * drone is that character's or is controlled by that ship (Park.OnDroneStateChange, 1496). With none given the
     * character is not known, and the ship is the park's own (its ego).
     */
    this.pilot = pilot;
    /**
     * The drones the pilot has out, as michelle's park keeps them (stateByDroneID): by drone, { droneID, ownerID,
     * controllerID, activityState, typeID, controllerOwnerID, targetID }. Filled by a whole state's droneState and
     * changed by OnDroneStateChange. And what each is busy with, (activity, activityID), from OnDroneActivityChange.
     */
    this.stateByDroneID = new Map();
    this.activityByDrone = new Map();
    this.onEvent = onEvent;
    this.requestState = requestState;
    this.onMultiEvent = onMultiEvent;
    /** Given [{ id, slim, terminal }] for the balls about to go: the client's DoBallsRemove. `terminal` is "it blew up". */
    this.onBallsRemoved = onBallsRemoved;
    this.lastStamp = -1;
    /** Snapshots of the park to go back to: [bytes, tick, midTick]. */
    this.states = [];
    this.slimItems = new Map();
    this.damageState = new Map();
    /**
     * The tick at which each damage state arrived. The client files a state
     * with its clock's reading (blue.os.GetSimTime()) so that the shield, which
     * recharges by itself, can be brought forward from then; the park's tick is
     * that clock in whole seconds.
     */
    this.damageSeen = new Map();
    this.destructionEffects = new Map();
    this.validState = false;
    /** The queue: [entries, waitForBubble] per tick, in tick order. */
    this.history = [];
    this.latestSetStateTime = 0;
    this.shouldRebase = false;
    this.ego = null;
    /**
     * Where the pilot's own ship was last sent in warp: the point in the server's WarpTo. The client's space
     * service keeps it from the same call (spaceMgr.OnBallparkCall) and words its warp from it.
     */
    this.warpPoint = null;
    this.isRunning = false;
    this.solItem = null;
    /** Entries that could not be applied, by name: an order this port does not carry out yet, or one the client has no method for. */
    this.failed = new Map();
    /** Told of each entry that fails, with the error: `onFail(name, error)`. */
    this.onFail = null;
    this.resets = 0;
    /** Updates that held more than one tick: the client reports each to its statistics and carries on. */
    this.fatalDesyncs = 0;
    /** Ballpark::mFirstTime: nothing has stepped the park by the clock yet. */
    this.firstTime = true;
  }

  /** Ballpark::mTime: the sim clock's reading at the park's last step, in milliseconds, less what was left over. */
  get time() {
    return this.ballpark.time;
  }

  set time(value) {
    this.ballpark.time = value;
  }

  get currentTime() {
    return this.ballpark.currentTime;
  }

  // ── an update arrives ─────────────────────────────────────────────────────

  /**
   * Michelle.DoDestinyUpdate (482): `state` is a list of (stamp, (name, args))
   * and `waitForBubble` says a second batch for the same tick is still to come.
   */
  doDestinyUpdate(state, waitForBubble, dogmaMessages = null) {
    if (items(dogmaMessages).length > 0 && typeof this.onMultiEvent === "function") this.onMultiEvent(items(dogmaMessages));
    const entries = [];
    for (const action of items(state)) {
      if (text(action[1][0]) !== "PackagedAction") {
        entries.push(action);
        continue;
      }
      // A marshalled list of entries, spliced in where it stood. One that
      // cannot be read is logged by the client and left out.
      try {
        entries.push(...items(marshalDecode(action[1][1])));
      } catch (error) {
        this._fail("PackagedAction", error);
      }
    }
    const expanded = entries.map(([stamp, [name, args]]) => [number(stamp), [text(name), items(args)]]);
    if (new Set(expanded.map(([stamp]) => stamp)).size > 1) this.fatalDesyncs += 1; // clientStatsSvc.OnFatalDesync, and on it goes
    this.flushState(expanded, Boolean(waitForBubble));
  }

  /** Michelle.DoDestinyUpdates (514): several updates in one notification, each (state, waitForBubble[, dogmaMessages]). */
  doDestinyUpdates(updates) {
    for (const update of items(updates)) this.doDestinyUpdate(...update);
  }

  /** Park.FlushState (1098). */
  flushState(state, waitForBubble) {
    if (state.length === 0) return;
    if (state[0][1][0] === "SetState") {
      // A whole new state: whatever was queued for before it no longer matters.
      this.latestSetStateTime = state[0][0];
      this.history = this.history.filter((entry) => entry[0][0][0] >= this.latestSetStateTime);
    } else if (state[0][0] < this.latestSetStateTime) {
      return; // older than the state we hold
    }
    mergeStateIntoHistory(state, this.history, waitForBubble);
  }

  // ── a tick ────────────────────────────────────────────────────────────────

  /**
   * One iteration of the engine's driver (Ballpark::OnTick): apply what is due,
   * step, then keep a snapshot if this tick calls for one.
   */
  tick() {
    this.ballpark.bringOutDeadBalls();
    this._step();
  }

  _step(timestamp = 0) {
    this.doPreTick(this.currentTime);
    this.ballpark.evolve(timestamp);
    this.doPostTick(this.currentTime);
  }

  /**
   * Ballpark::OnTick (Ballpark.cpp 217): the engine's driver. The client calls
   * it every frame with its sim clock's reading; the park takes one step for
   * each whole tick of that clock gone by since its last, and keeps what is
   * left over towards the next. So a park steps once a second of game time,
   * however long that second is, and takes at once all the steps a stalled
   * client has missed.
   *
   * The first call only steps the simulation: nothing queued is applied by it
   * (the engine's first Evolve is made without DoPreTick or DoPostTick).
   * `simTime` is in milliseconds. Returns how many steps were taken.
   */
  onTick(simTime) {
    let sinceLast = simTime - this.time;
    this.ballpark.bringOutDeadBalls();
    const interval = this.ballpark.tickInterval;
    if (sinceLast < interval) return 0;
    let steps = 1;
    if (this.firstTime) {
      this.ballpark.evolve(simTime);
      sinceLast = 0;
      this.firstTime = false;
    } else {
      steps = Math.trunc(sinceLast / interval);
      for (let step = 0; step < steps; step += 1) {
        // Each step is handed the clock's reading at the step before it.
        this._step(simTime - sinceLast);
        sinceLast -= interval;
      }
    }
    this.time = simTime - sinceLast;
    return steps;
  }

  /**
   * Ballpark::AdjustTimes (4416): the park's own times moved by `delta`
   * milliseconds. The client does this when it is told its sim clock has been
   * rebased (michelle.DoSimClockRebase), so that the park's next step falls
   * where it would have.
   */
  adjustTimes(delta) {
    this.ballpark.adjustTimes(delta);
  }

  /**
   * How far through its present tick the park is at the sim clock's reading
   * `simTime`: what the client hands to the placing of a ball between two
   * ticks (ClientBall::InterpolatedPosition, with its two-tick shift and the
   * times each step leaves on a ball; Ballpark.between takes the result).
   */
  fraction(simTime) {
    return (simTime - this.time) / this.ballpark.tickInterval;
  }

  /** Park.DoPreTick (900). */
  doPreTick() {
    while (this.history.length > 0) {
      const [state, waitForBubble] = this.history[0];
      if (waitForBubble) return;
      const eventStamp = state[0][0];
      // One or two ticks ahead: our own ticking will get there. Leave it.
      if (eventStamp > this.currentTime && eventStamp - this.currentTime < 3) break;
      this.realFlushState(state);
      this.history.shift();
      if (this.validState && this.shouldRebase) this.storeState(true);
      if (this.history.length > 1) {
        if (this.history[0][1]) return;
        this.ballpark.evolve();
      }
    }
  }

  /** Park.DoPostTick (859). */
  doPostTick(stamp) {
    if (this.shouldRebase) {
      this.flushSimulationHistory();
      this.shouldRebase = false;
    } else if (stamp > this.lastStamp + 10) {
      this.storeState();
    }
  }

  // ── snapshots, and going back ─────────────────────────────────────────────

  /** Park.StoreState (919). */
  storeState(midTick = false) {
    if (!this.isRunning) return;
    this.states.push([this.ballpark.writeState(), this.currentTime, midTick]);
    // Python: states[:1] + states[3:3] + states[-5:]. The middle slice is empty.
    if (this.states.length > 10) this.states = [...this.states.slice(0, 1), ...this.states.slice(-5)];
    this.lastStamp = this.currentTime;
  }

  /** Park.FlushSimulationHistory (1059). */
  flushSimulationHistory(newBaseSnapshot = true) {
    let lastMidState = null;
    if (newBaseSnapshot && this.states.length) {
      lastMidState = this.states[this.states.length - 1];
      if (!lastMidState[2] || lastMidState[1] !== this.currentTime - 1) lastMidState = null;
    }
    this.states = [];
    if (newBaseSnapshot) {
      if (lastMidState) this.states.push(lastMidState);
      this.storeState();
    }
  }

  /**
   * Park.SynchroniseToSimulationTime (1074): bring the simulation to `stamp`.
   * Forward is stepping. Backward is reading the latest snapshot at or before
   * `stamp` and stepping from there; the park's tick is then `stamp`, and what
   * had been applied after it is gone. False when there is no such snapshot.
   */
  synchroniseToSimulationTime(stamp) {
    let lastStamp;
    if (stamp < this.currentTime) {
      lastStamp = 0;
      let lastState = null;
      for (const item of this.states) {
        if (item[1] <= stamp) {
          lastStamp = item[1];
          lastState = item[0];
        }
      }
      if (!lastState) return false;
      this.ballpark.readState(lastState, 1);
    } else {
      lastStamp = this.currentTime;
    }
    for (let step = 0; step < stamp - lastStamp; step += 1) this.ballpark.evolve();
    return true;
  }

  /** Park.RequestReset (848): the park no longer knows where it is. */
  requestReset() {
    this.validState = false;
    this.flushSimulationHistory(false);
    this.resets += 1;
    if (typeof this.requestState === "function") this.requestState();
  }

  // ── applying one tick's entries ───────────────────────────────────────────

  _fail(name, error = null) {
    this.failed.set(name, (this.failed.get(name) ?? 0) + 1);
    // The client writes "<name> failed." with the traceback to its log; whoever keeps this park can do the same.
    if (typeof this.onFail === "function") this.onFail(name, error);
  }

  /** Park.RealFlushState (1142). */
  realFlushState(state) {
    if (state.length === 0) return;
    {
      const [, [funcName, args]] = state[0];
      // A SetState counts only as the first entry of its group.
      if (funcName === "SetState") this.SetState(...args);
    }
    if (!this.validState) return; // events ignored until a state arrives
    this.shouldRebase = false;
    let synchronised = false;
    const exploders = new Map(state.filter((entry) => entry[1][0] === "TerminalPlayDestructionEffect").map((entry) => [ballId(entry[1][1][0]), entry[1][1][entry[1][1].length - 1]]));
    for (const [eventStamp, [funcName, args]] of state) {
      if (funcName === "SetState") continue;
      try {
        if (NON_DESTINY_CRITICAL.has(funcName)) {
          this._notSimulation(funcName, args);
        } else {
          if (!synchronised) synchronised = this.synchroniseToSimulationTime(eventStamp);
          if (!synchronised) {
            this.requestReset();
            return;
          }
          this.shouldRebase = true;
          if (LOCAL_ACTIONS.has(funcName)) {
            if (funcName === "RemoveBalls") this.RemoveBalls(args[0], exploders);
            else this[funcName](...args);
          } else {
            this._order(funcName, args);
            if (funcName === "WarpTo" && this.ego !== null && ballId(args[0]) === this.ego) {
              this.warpPoint = { x: number(args[1]), y: number(args[2]), z: number(args[3]) };
            }
            if (funcName === "CloakBall") {
              const eventBallID = ballId(args[0]);
              if (this.ego && this.ego !== eventBallID) this.RemoveBall(eventBallID);
            }
          }
        }
        if (typeof this.onEvent === "function") this.onEvent(funcName, args, eventStamp);
      } catch (error) {
        // The client logs "<funcName> failed." and goes on to the next entry.
        this._fail(funcName, error);
      }
    }
  }

  /** File a ball's damage state, with the tick it arrived at. */
  _damage(id, state) {
    this.damageState.set(id, state);
    this.damageSeen.set(id, this.currentTime);
  }

  /** An entry that touches nothing in the simulation. What the web client needs of these is kept. */
  _notSimulation(funcName, args) {
    if (funcName === "OnDamageStateChange" || funcName === "OnFleetDamageStateChange") this._damage(ballId(args[0]), args[1]);
    if (funcName === "OnSlimItemChange") this.slimItems.set(ballId(args[0]), fieldsOf(args[1]));
    if (funcName === "OnDroneStateChange") this.OnDroneStateChange(...items(args));
  }

  /**
   * Park.OnDroneStateChange (1496): (itemID, ownerID, controllerID, activityState, typeID, controllerOwnerID,
   * targetID). A drone that is neither the pilot's own nor controlled by the pilot's ship is forgotten: control of
   * it is lost. Any other is kept as told. It comes as an entry of a ballpark update (recorded on Tranquility, as a
   * list of the seven) and as a notice of its own (michelle.OnDroneStateChange, 265).
   */
  OnDroneStateChange(itemID, ownerID, controllerID, activityState, typeID, controllerOwnerID, targetID) {
    const droneID = ballId(itemID);
    const who = typeof this.pilot === "function" ? this.pilot() : null;
    const charID = who && who.charID !== undefined && who.charID !== null ? ballId(who.charID) : null;
    const shipID = who && who.shipID !== undefined && who.shipID !== null ? ballId(who.shipID) : this.ego;
    if (charID !== ballId(ownerID) && shipID !== ballId(controllerID)) {
      this.stateByDroneID.delete(droneID);
      this.activityByDrone.delete(droneID);
      return;
    }
    this.stateByDroneID.set(droneID, { droneID, ownerID: ballId(ownerID), controllerID: ballId(controllerID), activityState: number(activityState), typeID: number(typeID), controllerOwnerID: ballId(controllerOwnerID), targetID: targetID === null || targetID === undefined ? null : ballId(targetID) });
  }

  /** Park.OnDroneActivityChange (1520): (droneID, activityID, activity). With no activity, what was kept of the drone's is let go. */
  OnDroneActivityChange(droneID, activityID, activity) {
    const id = ballId(droneID);
    if (!activity || (Buffer.isBuffer(activity) && activity.length === 0)) this.activityByDrone.delete(id);
    else this.activityByDrone.set(id, [activity, activityID]);
  }

  /**
   * An order for the simulation: on the client, a call of the C++ park's method
   * of that name (Ballpark_Blue.cpp). The argument types are the thunks'.
   */
  _order(funcName, args) {
    const park = this.ballpark;
    const id = ballId(args[0]);
    const n = (index, fallback) => (args[index] === undefined || args[index] === null ? fallback : number(args[index]));
    switch (funcName) {
      case "GotoDirection": return park.gotoDirection(id, n(1), n(2), n(3));
      case "GotoPoint": return park.gotoPoint(id, n(1), n(2), n(3));
      case "FollowBall":
      case "Orbit": {
        const leader = ballId(args[1]);
        // Thunkers.cpp 260, 345: "You can not Follow a negative ballID".
        if (leader < 0) throw new Error(`${funcName} of a negative ball id`);
        return funcName === "Orbit" ? park.orbit(id, leader, n(2, 1.0)) : park.followBall(id, leader, n(2, 1.0));
      }
      case "Stop": return park.stopOrder(id);
      case "WarpTo": return park.warpTo(id, n(1), n(2), n(3), n(4, 20000.0), wholeNumber(n(5, 20), funcName));
      case "EntityWarpIn": return park.entityWarpIn(id, n(1), n(2), n(3), wholeNumber(n(4), funcName));
      case "LaunchMissile": {
        // Thunkers.cpp 857, "LLLbb": the missile, its target, its launcher, then whether it is aimed and massive. None is optional.
        if (args.length < 5) throw new TypeError(`${funcName} takes exactly 5 arguments (${args.length} given)`);
        return park.launchMissile(id, ballId(args[1]), ballId(args[2]), wholeNumber(Number(n(3)), funcName), wholeNumber(Number(n(4)), funcName));
      }
      case "SetSpeedFraction": return park.setSpeedFraction(id, n(1));
      case "SetBallPosition": return park.setBallPosition(id, n(1), n(2), n(3));
      case "SetBallVelocity": return park.setBallVelocity(id, n(1), n(2), n(3));
      case "SetBallMass": return park.setBallMass(id, n(1));
      case "SetBallAgility": return park.setBallAgility(id, n(1));
      case "SetMaxSpeed": return park.setMaxSpeed(id, n(1));
      case "SetBallRadius": return park.setBallRadius(id, n(1));
      case "SetBallMassive": return park.setBallMassive(id, n(1));
      case "SetBallFree": return park.setBallFree(id, n(1));
      case "SetBallGlobal": return park.setBallGlobal(id, n(1));
      case "SetBallInteractive": return park.setBallInteractive(id, n(1));
      case "SetBallHarmonic": return park.setBallHarmonic(id, ballId(args[1]), n(2), n(3), n(4));
      case "SetBallTroll": return park.setBallTroll(id, n(1));
      case "SetBallRigid": return park.setBallRigid(id);
      case "CloakBall": return park.cloakBall(id, n(1));
      case "UncloakBall": return park.uncloakBall(id);
      default:
        // AddMushroom and the formation orders: not ported. Anything
        // else: the client has no such method. Either way the entry fails.
        throw new Error(`${funcName} cannot be applied`);
    }
  }

  // ── the entries the client handles itself ─────────────────────────────────

  /** Park.SetState (968): a whole new park. */
  SetState(bag) {
    const fields = fieldsOf(bag);
    // Park.SetState (970): the drones' states are the bag's, each row a drone; ClearAll then empties what each was busy with.
    this.stateByDroneID = new Map();
    this.activityByDrone = new Map();
    const droneState = fieldsOf(fields.get("droneState"));
    const columns = items(droneState.get("header")).map(text);
    for (const line of items(droneState.get("lines"))) {
      const row = Object.fromEntries(columns.map((column, index) => [column, items(line)[index]]));
      if (row.droneID === undefined || row.droneID === null) continue;
      const droneID = ballId(row.droneID);
      this.stateByDroneID.set(droneID, { droneID, ownerID: ballId(row.ownerID), controllerID: ballId(row.controllerID), activityState: number(row.activityState), typeID: number(row.typeID), controllerOwnerID: ballId(row.controllerOwnerID), targetID: row.targetID === null || row.targetID === undefined ? null : ballId(row.targetID) });
    }
    this.ballpark.clearAll();
    this.ballpark.readState(fields.get("state"), 0);
    this.ego = ballId(fields.get("ego"));
    this.isRunning = true; // _parent_Start()
    this.slimItems = new Map();
    for (const slimItem of items(fields.get("slims"))) {
      const slim = fieldsOf(slimItem);
      const itemID = ballId(slim.get("itemID"));
      if (!this.ballpark.balls.has(itemID)) throw new Error(`BallNotInPark ${itemID}`);
      this.slimItems.set(itemID, slim);
    }
    this.validState = true;
    this.flushSimulationHistory();
    this.damageState = new Map();
    this.damageSeen = new Map();
    for (const [id, damage] of fieldsOf(fields.get("damageState"))) this._damage(ballId(id), damage);
    this.solItem = fields.get("solItem") ?? null;
  }

  /** Park.AddBalls (1235): (state, slims, damageDict). */
  AddBalls(chunk) {
    const [state, slims, damageDict] = items(chunk);
    this.ballpark.readState(state, 2);
    for (const slimItem of items(slims)) {
      const slim = fieldsOf(slimItem);
      const itemID = ballId(slim.get("itemID"));
      if (!this.slimItems.has(itemID)) this.slimItems.set(itemID, slim);
    }
    for (const [id, damage] of fieldsOf(damageDict)) this._damage(ballId(id), damage);
  }

  /** Park.AddBalls2 (1256): (state, extraBallData), each of which is a slim item or a (slim item, damage) pair. */
  AddBalls2(chunk) {
    const [state, extraBallData] = items(chunk);
    this.ballpark.readState(state, 2);
    for (const data of items(extraBallData)) {
      const [slimItemDict, damageState] = Array.isArray(data) ? data : [data, null];
      const slim = fieldsOf(slimItemDict);
      const itemID = ballId(slim.get("itemID"));
      // The client files it with the time it arrived, for working out the shield since. That clock is not kept yet.
      this._damage(itemID, damageState ?? null);
      if (!this.slimItems.has(itemID)) this.slimItems.set(itemID, slim);
    }
  }

  /** Park.TerminalPlayDestructionEffect (1197): only what to show when the ball goes. */
  TerminalPlayDestructionEffect(shipID, destructionEffectId) {
    this._setDestructionEffectOnRemove(ballId(shipID), destructionEffectId);
  }

  /** Park.SetDestructionEffectOnRemove (1200): kept for a ball that is here, and an effect not named is an explosion. */
  _setDestructionEffectOnRemove(id, destructionEffectId) {
    if (!this.ballpark.balls.has(id)) return;
    this.destructionEffects.set(id, destructionEffectId ?? DESTRUCTION_EFFECT.EXPLOSION);
  }

  /**
   * Park.RemoveBall (1303). The client keeps a destroyed ball for as long as
   * its explosion plays, a number it gets from its graphics. A ball in that
   * state takes no part in the simulation, so here it simply goes.
   */
  RemoveBall(ballID, terminal = false) {
    const id = ballId(ballID);
    this.ballpark.removeBall(id, 0);
    this.damageState.delete(id);
    this.damageSeen.delete(id);
    this.destructionEffects.delete(id);
    const slim = this.slimItems.get(id);
    if (slim === undefined) return;
    if (id > DSTLOCALBALLS && typeof this.onBallsRemoved === "function") this.onBallsRemoved([{ id, slim, terminal: Boolean(terminal) }]);
    this.slimItems.delete(id);
  }

  /**
   * Park.RemoveBalls (1332). `exploders` is what the rest of the group says
   * will be destroyed, so that a ball removed before its
   * TerminalPlayDestructionEffect is reached is still known to be one.
   */
  RemoveBalls(ballIDs, exploders = null) {
    for (const [id, effect] of exploders ?? []) this._setDestructionEffectOnRemove(id, effect);
    const ids = items(ballIDs).map(ballId);
    const leaving = ids.filter((id) => !(id < 0) && this.ballpark.balls.has(id));
    const told = leaving
      .filter((id) => this.slimItems.has(id) && id > DSTLOCALBALLS)
      .map((id) => ({ id, slim: this.slimItems.get(id), terminal: (this.destructionEffects.get(id) ?? DESTRUCTION_EFFECT.NONE) !== DESTRUCTION_EFFECT.NONE }));
    if (typeof this.onBallsRemoved === "function") this.onBallsRemoved(told);
    for (const id of leaving) this.ballpark.removeBall(id, 0);
    for (const id of ids) {
      this.damageState.delete(id);
      this.damageSeen.delete(id);
      this.destructionEffects.delete(id);
      this.slimItems.delete(id);
    }
  }
}

module.exports = { DESTRUCTION_EFFECT, DSTLOCALBALLS, LOCAL_ACTIONS, NON_DESTINY_CRITICAL, Park, mergeStateIntoHistory };
