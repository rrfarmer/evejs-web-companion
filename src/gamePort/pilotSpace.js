"use strict";

// A pilot in space: its ballpark, kept as the retail client keeps one.
//
// The client's `michelle` service makes a ballpark when the session is in a
// solar system and the view is of space, and lets it go when it is not
// (michelle.py UpdateBallpark, AddBallpark, RemoveBallpark):
//
//   AddBallpark(solarsystemID)
//     Park(...)                          and with it, on a thread of its own,
//       InitializeRemoteBallpark         eveMoniker.GetBallPark(solarsystemID).Bind(),
//                                        up to ten tries a second apart
//     sm.RemoteSvc('beyonce').GetFormations()
//     __bp.Start()                       the park begins to tick
//
// A ticking park is called every frame with the client's sim clock, and steps
// once for each second of that clock gone by (Park.onTick). So it steps once a
// second, and more slowly when the server has slowed the pilot's clock
// (pilotClock.js). Its first frame is the next one after Start, before the
// bind below has been answered.
//
// The server answers the bind with the ballpark's state (DoDestinyUpdate), and
// from then on sends what changes. Nothing else passes between the two about
// where things are: the park steps itself (destiny/park.js).
//
// One bound object serves the whole park. Everything the client asks of the
// ballpark (CmdGotoDirection, CmdWarpToStuff, CmdDock, UpdateStateRequest) goes
// to it, through michelle.GetRemotePark().
//
// When the client is told its sim clock has been rebased (DoSimClockRebase,
// with the old reading and the new) michelle moves the park's own times by the
// difference (michelle.DoSimClockRebase, Ballpark::AdjustTimes). eve.js sends
// that as a notice when a pilot enters space and when time dilation changes.
//
// Not here: the formations GetFormations answers with (they feed the FORMATION
// mode, which is not ported).
//
// NOT THE CLIENT'S: a drone of the pilot's own that is in the park with no
// state of its own (park.stateByDroneID) for DRONE_STATE_GRACE_MS. The client
// learns its drones from the state's drone rows and from OnDroneStateChange,
// and only those; a drone that misses both stays in space unrecallable, and
// CmdReconnectToDrones does not help, because the server reconnects only a
// drone nobody controls. Seen 2026-10-10: five drones launched on landing,
// owned and controlled by the pilot's ship on the server, absent from the
// park's states for the whole fight; UpdateStateRequest brought all five back.
// So a pilot's space asks for the whole state for each such drone, and asks
// again while the answer leaves it out: seen 2026-10-10 20:39, an answer with
// no drone rows at all while the server held eighteen controlled drones in the
// bubble; the same question two minutes later was answered in full.

/** How long a drone of the pilot's may be in the park with no state before the whole state is asked for. */
const DRONE_STATE_GRACE_MS = 5000;
/** How long after asking it is asked again, while the drone still has no state; and how many times in all. */
const DRONE_STATE_RETRY_MS = 15000;
const DRONE_STATE_ASKS = 3;
/** invCategories: Drone. */
const CATEGORY_DRONE = 18;

const { Ballpark } = require("./destiny/ballpark");
const { Park } = require("./destiny/park");
const { SimClock } = require("./simClock");

/** InitializeRemoteBallpark: tries, and the wait between them. */
const BIND_TRIES = 10;
const BIND_RETRY_MS = 1000;
/** How often the park is shown the clock. The client does it every frame it draws; a park needs it only often enough to step on time. */
const FRAME_MS = 50;
/** blue counts in 100 ns; the park's clock in milliseconds. */
const BLUE_TICKS_PER_MS = 10_000n;

/** The two readings of a DoSimClockRebase, as a difference in milliseconds; null if they are not two whole numbers. */
function rebaseDelta(times) {
  const pair = Array.isArray(times) ? times : times && Array.isArray(times.items) ? times.items : null;
  if (!pair || pair.length !== 2) return null;
  try {
    const [from, to] = pair.map((value) => BigInt(value));
    return Number(to - from) / Number(BLUE_TICKS_PER_MS);
  } catch {
    return null;
  }
}

/**
 * `session` is the pilot's game-port session. `simTime()` reads the pilot's
 * sim clock, in milliseconds (pilotClock.js); left out, the park has a clock
 * of its own that runs with the real one. `onError(error, what)` is told of
 * anything that goes wrong in the park's own time (a tick, an update, the
 * bind), since nobody is waiting on those.
 */
function createPilotSpace({
  session,
  solarSystemID,
  frameMs = FRAME_MS,
  simTime = null,
  startTicking = (tick, ms) => setInterval(tick, ms),
  stopTicking = (timer) => clearInterval(timer),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onError = () => {},
  onPost = null,
  // michelle.AddBallpark's own asking for the formations; a pilot's transport gives it one that asks the server once.
  askFormations = () => session.call("beyonce", "GetFormations", []),
  now = () => Date.now(),
} = {}) {
  let timer = null;
  let released = false;
  let remotePark = null;
  let formations = null;
  let bound = null;
  const park = new Park({
    ballpark: new Ballpark({ onPost }),
    // Whose drones the park keeps the states of: the session's character's, and those its ship controls.
    pilot: () => ({ charID: session.attributes?.charid ?? null, shipID: session.attributes?.shipid ?? null }),
    // Park.RequestReset: the park has lost its place and asks for the whole state again.
    requestState: () => {
      if (remotePark === null) return; // not bound yet, or let go
      Promise.resolve(session.callBound(remotePark, "UpdateStateRequest", [])).catch((error) => onError(error, "UpdateStateRequest"));
    },
  });
  // An entry the park could not apply is not thrown: the park goes on to the next, as the client does. It is still worth knowing.
  park.onFail = (name, error) => onError(error ?? new Error("the entry could not be applied"), `entry ${name}`);
  const ownClock = simTime === null ? new SimClock(Date.now()) : null;
  const readClock = simTime ?? (() => ownClock.frame(Date.now()));
  /** One frame: the park is shown the clock, and steps if a second of it has gone by. */
  const frame = () => {
    guard("tick", () => park.onTick(readClock()));
    guard("drone state", lostDrones);
  };

  // The pilot's drones the park has no state for, each with since when, and how often and when last the whole state was asked for.
  const strays = new Map();
  /** The pilot's own drones in the park (its slim items) that have no state of their own. */
  function statelessDrones() {
    const charID = Number(session.attributes?.charid);
    if (!park.validState || !Number.isFinite(charID) || !park.slimItems) return [];
    const stray = [];
    for (const [id, slim] of park.slimItems) {
      if (Number(slim.get("categoryID")) !== CATEGORY_DRONE || Number(slim.get("ownerID")) !== charID) continue;
      if (park.ballpark.balls.has(id) && !park.stateByDroneID.has(id)) stray.push(id);
    }
    return stray;
  }
  /** See "NOT THE CLIENT'S" above: a drone stateless past the grace asks for the whole state, and asks again while it stays so. */
  function lostDrones() {
    const stray = new Set(statelessDrones());
    // A drone that has its state again, or has gone, starts over if it strays again.
    for (const id of strays.keys()) if (!stray.has(id)) strays.delete(id);
    const at = now();
    const due = [];
    for (const id of stray) {
      if (!strays.has(id)) strays.set(id, { since: at, asks: 0, askedAt: null });
      const each = strays.get(id);
      if (each.asks >= DRONE_STATE_ASKS) continue;
      if (each.asks === 0 ? at - each.since >= DRONE_STATE_GRACE_MS : at - each.askedAt >= DRONE_STATE_RETRY_MS) due.push(id);
    }
    if (due.length === 0 || remotePark === null) return;
    for (const id of due) {
      const each = strays.get(id);
      each.asks += 1;
      each.askedAt = at;
    }
    // ⚠ ASKED FOR, NOT RESET. Park.RequestReset would also mark the park invalid until the state comes, and
    // every update meanwhile is dropped; seen 2026-10-10 20:01, two pilots blind for minutes when the answer
    // did not come. The park the pilot has is good but for these drones: it keeps flying on it, and the
    // state replaces it whenever the server sends one.
    park.requestState();
    // Told as the park's other troubles are, so that each time it happens is on record.
    const asks = Math.max(...due.map((id) => strays.get(id).asks));
    onError(new Error(`${due.length} of the pilot's drones in space had no state (${due.join(", ")}); the whole state was asked for (ask ${asks} of ${DRONE_STATE_ASKS})`), "drone state");
  }
  const guard = (what, action) => {
    try {
      action();
    } catch (error) {
      onError(error, what);
    }
  };

  async function bind() {
    for (let tries = BIND_TRIES; tries > 0 && !released; tries -= 1) {
      try {
        remotePark = (await session.bind("beyonce", solarSystemID)).objectID;
        return remotePark;
      } catch (error) {
        onError(error, "bind");
        if (tries > 1) await sleep(BIND_RETRY_MS);
      }
    }
    return null;
  }

  /** Michelle.AddBallpark. Resolves once the park is ticking and the remote ballpark is bound, or cannot be. */
  function start() {
    bound ??= (async () => {
      try {
        formations = await askFormations();
      } catch (error) {
        onError(error, "GetFormations");
      }
      if (released) return null;
      timer = startTicking(frame, frameMs);
      frame();
      return bind();
    })();
    return bound;
  }

  /** A notification from the session. True when it was the ballpark's. */
  function feed(notification) {
    if (released) return false;
    if (notification.method === "DoDestinyUpdate") {
      guard("DoDestinyUpdate", () => park.doDestinyUpdate(notification.args[0], notification.args[1], notification.args[2]));
      return true;
    }
    if (notification.method === "DoDestinyUpdates") {
      guard("DoDestinyUpdates", () => park.doDestinyUpdates(notification.args[0]));
      return true;
    }
    if (notification.method === "DoSimClockRebase") {
      const delta = rebaseDelta(Array.isArray(notification.args) ? notification.args[0] : null);
      if (delta !== null) park.adjustTimes(delta);
      return true;
    }
    // michelle.OnDroneStateChange and OnDroneActivityChange (265, 270): a drone's notice of its own goes to the
    // park, as the entry of a ballpark update does. The notice is the page's to hear as well.
    if (notification.method === "OnDroneStateChange" && Array.isArray(notification.args)) {
      guard("OnDroneStateChange", () => park.OnDroneStateChange(...notification.args));
    }
    if (notification.method === "OnDroneActivityChange" && Array.isArray(notification.args)) {
      guard("OnDroneActivityChange", () => park.OnDroneActivityChange(...notification.args));
    }
    return false;
  }

  /** Michelle.RemoveBallpark: the park stops, and its remote ballpark is let go. */
  function release() {
    if (released) return;
    released = true;
    if (timer !== null) stopTicking(timer);
    timer = null;
    remotePark = null;
  }

  return {
    solarSystemID,
    park,
    /** The reading of the clock the park is stepped by, in milliseconds: what a ball is drawn at (Ballpark.drawn). */
    simTime: readClock,
    start,
    feed,
    release,
    /** The bound remote ballpark's "N=...", once it is bound; null if it could not be. */
    remote: () => start(),
    get remotePark() {
      return remotePark;
    },
    get formations() {
      return formations;
    },
    get released() {
      return released;
    },
  };
}

module.exports = { BIND_TRIES, FRAME_MS, createPilotSpace, rebaseDelta };
