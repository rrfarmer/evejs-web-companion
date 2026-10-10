"use strict";

// A game-port pilot in space: the ballpark it keeps (src/gamePort/pilotSpace.js)
// and what the web client is shown of it (src/gamePort/spaceProjection.js).
//
// The ballpark's own logic is tested in destinyPark.test.js and
// destinyBallpark.test.js. Here: that it is made, fed, stepped and let go as
// the retail client's michelle does those things, and that the projection says
// what the gateway's snapshot says wherever a client is in a position to know.

const test = require("node:test");
const assert = require("node:assert/strict");
const { BIND_TRIES, FRAME_MS, createPilotSpace, rebaseDelta } = require("../src/gamePort/pilotSpace");
const { CATEGORY, checkWarpDestination, compressionFacilityOf, healthOf, kindOf, npcKindOf, projectEntity, projectFlight, projectSpace } = require("../src/gamePort/spaceProjection");
const { Ballpark } = require("../src/gamePort/destiny/ballpark");
const { Park } = require("../src/gamePort/destiny/park");
const { MODE } = require("../src/gamePort/destiny/state");
const undock = require("./fixtures/destinyUndock.json");
const { destinyUpdates, notifications, timeline } = require("./helpers/destinyRecording");
const { AU } = require("../src/gamePort/destiny/ballpark");
const jumpTrip = require("./fixtures/destinyJump.json");

const SYSTEM = 30000142;

/** A stand-in session that keeps what it was asked, in order. */
function fakeSession({ bindFailures = 0, formationsError = null } = {}) {
  const session = {
    asked: [],
    async call(service, method, args) {
      session.asked.push(`call ${service}.${method}`);
      if (formationsError) throw formationsError;
      return [service, method, args];
    },
    async bind(service, params) {
      session.asked.push(`bind ${service} ${params}`);
      if (bindFailures > 0) {
        bindFailures -= 1;
        throw new Error("not yet");
      }
      return { objectID: "N=1:7", nodeID: 1, result: null };
    },
    async callBound(objectID, method, args) {
      session.asked.push(`bound ${objectID} ${method}`);
      return [objectID, method, args];
    },
  };
  return session;
}

/**
 * A pilot's space whose clock moves only when the test says so. `state.frame()`
 * shows the park the clock as it stands; `state.tick()` moves the clock on a
 * second first, so the park takes one step.
 */
function handTicked(sessionOptions = {}, options = {}) {
  const session = fakeSession(sessionOptions);
  const state = { tick: null, frame: null, sim: 1_000_000, started: 0, stopped: 0, slept: [], errors: [] };
  const space = createPilotSpace({
    session,
    solarSystemID: SYSTEM,
    simTime: () => state.sim,
    startTicking: (frame, ms) => {
      state.frame = frame;
      state.tick = () => { state.sim += 1000; frame(); };
      state.started += 1;
      state.frameMs = ms;
      session.asked.push("the park starts ticking");
      return "timer";
    },
    stopTicking: (timer) => { state.stopped += timer === "timer" ? 1 : 100; },
    sleep: async (ms) => { state.slept.push(ms); },
    onError: (error, what) => state.errors.push([what, error.message]),
    ...options,
  });
  return { session, space, state };
}

test("a ballpark is made as michelle makes one: formations asked for, the park ticking, the system's ballpark bound", async () => {
  const { session, space, state } = handTicked();
  assert.deepEqual([state.started, space.remotePark, space.park.validState], [0, null, false]);
  assert.equal(await space.start(), "N=1:7");
  assert.deepEqual(session.asked, ["call beyonce.GetFormations", "the park starts ticking", `bind beyonce ${SYSTEM}`]);
  assert.deepEqual([state.started, state.frameMs, space.remotePark, space.solarSystemID], [1, FRAME_MS, "N=1:7", SYSTEM]);
  assert.equal(FRAME_MS, 50);
  assert.deepEqual(space.formations, ["beyonce", "GetFormations", []]);
  // Asked again, by whoever wants the remote ballpark: the same one, not another.
  assert.equal(await space.remote(), "N=1:7");
  assert.equal(await space.start(), "N=1:7");
  assert.deepEqual([session.asked.length, state.started], [3, 1]);
});

test("the bind is tried again a second later, ten times at most", async () => {
  const late = handTicked({ bindFailures: 2 });
  assert.equal(await late.space.start(), "N=1:7");
  assert.deepEqual([late.state.slept, late.state.errors.map(([what]) => what)], [[1000, 1000], ["bind", "bind"]]);
  assert.equal(late.session.asked.filter((line) => line.startsWith("bind")).length, 3);

  const never = handTicked({ bindFailures: 99 });
  assert.equal(await never.space.start(), null);
  assert.equal(never.session.asked.filter((line) => line.startsWith("bind")).length, BIND_TRIES);
  assert.deepEqual([BIND_TRIES, never.state.slept.length, never.space.remotePark], [10, 9, null]);
  // The park ticks all the same: it is the server's state that has not come.
  assert.equal(never.state.started, 1);

  // Let go while still trying: it stops trying.
  const gone = handTicked({ bindFailures: 99 });
  gone.state.slept.push = function push(ms) {
    Array.prototype.push.call(this, ms);
    if (this.length === 2) gone.space.release();
    return this.length;
  };
  assert.equal(await gone.space.start(), null);
  assert.equal(gone.session.asked.filter((line) => line.startsWith("bind")).length, 2);
});

test("a drone of the pilot's left in space with no state asks once for the whole state, and again only if it strays again", async () => {
  const clock = { ms: 0 };
  const { session, space, state } = handTicked({}, { now: () => clock.ms });
  session.attributes = { charid: 90000001, shipid: undock.shipID };
  await space.start();
  for (const notification of notifications(undock)) space.feed(notification);
  state.tick();
  state.sim += 1;
  state.frame();
  assert.equal(space.park.validState, true);
  const asks = () => session.asked.filter((line) => line.endsWith("UpdateStateRequest")).length;
  const slim = (fields) => new Map(Object.entries(fields));
  // Three drones in space: the pilot's without a state, the pilot's with one, and somebody else's.
  const [lost, kept, theirs] = [9100000000001, 9100000000002, 9100000000003];
  for (const [id, ownerID] of [[lost, 90000001], [kept, 90000001], [theirs, 90000002]]) {
    space.park.ballpark.addBall({ id, isFree: true, mass: 5000, x: id % 10 });
    space.park.slimItems.set(id, slim({ itemID: BigInt(id), typeID: 2454, groupID: 100, categoryID: 18, ownerID }));
  }
  space.park.OnDroneStateChange(kept, 90000001, undock.shipID, 0, 2454, 90000001, null);
  // Within the grace a state may still be on its way: nothing is asked.
  state.frame();
  clock.ms = 4999;
  state.frame();
  assert.equal(asks(), 0);
  // Past it, the whole state, and on record.
  clock.ms = 5000;
  state.frame();
  assert.equal(asks(), 1);
  assert.deepEqual(state.errors.map(([what]) => what), ["drone state"]);
  assert.match(state.errors[0][1], new RegExp(`^1 of the pilot's drones .*\\(${lost}\\).*ask 1 of 3`));
  // The park is not thrown away while the answer is on its way: an answer that never comes leaves the pilot flying.
  assert.equal(space.park.validState, true);
  // An answer that leaves the drone out is asked again, 15 s on, three times in all and no more.
  clock.ms = 19999;
  state.frame();
  assert.equal(asks(), 1);
  clock.ms = 20000;
  state.frame();
  clock.ms = 35000;
  state.frame();
  assert.equal(asks(), 3);
  clock.ms = 120000;
  state.frame();
  assert.equal(asks(), 3, "three asks, then it stops");
  // Given its state, then losing it again, it starts over.
  space.park.OnDroneStateChange(lost, 90000001, undock.shipID, 0, 2454, 90000001, null);
  state.frame();
  space.park.stateByDroneID.delete(lost);
  state.frame();
  clock.ms = 125000;
  state.frame();
  assert.equal(asks(), 4);
});

test("a park is fed the session's ballpark updates and nothing else, and steps when ticked", async () => {
  const { space, state } = handTicked();
  await space.start();
  const all = notifications(undock);
  const fed = all.map((notification) => [notification.method, space.feed(notification)]);
  assert.ok(fed.some(([method]) => method !== "DoDestinyUpdate"), "the recording holds other notifications too");
  for (const [method, taken] of fed) assert.equal(taken, method === "DoDestinyUpdate" || method === "DoSimClockRebase", method);
  assert.equal(space.park.validState, false, "nothing is applied until the park ticks");
  state.tick();
  // On the way into space the recording's server rebased the clock by a millisecond, and the park's second ends that much later.
  assert.equal(rebaseDelta(all.find((notification) => notification.method === "DoSimClockRebase").args[0]), 1);
  assert.equal(space.park.validState, false);
  state.sim += 1;
  state.frame();
  assert.deepEqual([space.park.validState, space.park.ego], [true, undock.shipID]);

  // Given only what had arrived by the first second of the flight, each tick is one step.
  const updates = destinyUpdates(undock);
  const first = handTicked();
  await first.space.start();
  for (const update of updates.slice(0, 5)) first.space.feed({ method: "DoDestinyUpdate", args: [{ type: "list", items: update.entries }, update.waitForBubble] });
  first.state.tick();
  const stamp = updates[2].entries[0][0];
  assert.deepEqual([first.space.park.currentTime, first.space.park.ballpark.balls.size], [stamp + 1, 76]);
  first.state.tick();
  assert.equal(first.space.park.currentTime, stamp + 2);
  // An update is handed over whole: its entries, whether more is to come for that tick, and the dogma messages riding with it.
  const whole = handTicked();
  await whole.space.start();
  const messages = [];
  whole.space.park.onMultiEvent = (list) => messages.push(list);
  whole.space.feed({ method: "DoDestinyUpdate", args: [{ type: "list", items: updates[0].entries }, true, { type: "list", items: [["OnModuleAttributeChanges", []]] }] });
  assert.deepEqual([whole.space.park.history.map(([, wait]) => wait), messages], [[true], [[["OnModuleAttributeChanges", []]]]]);
  // Several updates in one notification.
  const other = handTicked();
  await other.space.start();
  assert.equal(other.space.feed({ method: "DoDestinyUpdates", args: [{ type: "list", items: updates.slice(0, 5).map((update) => [update.entries, update.waitForBubble]) }] }), true);
  other.state.tick();
  assert.equal(other.space.park.ballpark.balls.size, 76);
  assert.deepEqual([state.errors, other.state.errors], [[], []]);
});

test("what goes wrong in the park's own time is reported and does not stop it", async () => {
  const { space, state } = handTicked();
  await space.start();
  assert.equal(space.feed({ method: "DoDestinyUpdate", args: [{ type: "list", items: [[7, null]] }, false] }), true);
  space.park.onTick = () => { throw new Error("a step that cannot be taken"); };
  state.tick();
  assert.deepEqual(state.errors.map(([what]) => what), ["DoDestinyUpdate", "tick"]);
  assert.equal(state.errors[1][1], "a step that cannot be taken");

  // An entry the park cannot apply is passed over inside the park; that is reported too, by name.
  const other = handTicked();
  await other.space.start();
  for (const update of destinyUpdates(undock).slice(0, 5)) other.space.feed({ method: "DoDestinyUpdate", args: [{ type: "list", items: update.entries }, update.waitForBubble] });
  other.state.tick();
  other.space.feed({ method: "DoDestinyUpdate", args: [{ type: "list", items: [[other.space.park.currentTime, [Buffer.from("LaunchMissile"), [1, 2, 3, 4]]]] }, false] });
  other.state.tick();
  assert.deepEqual(other.state.errors, [["entry LaunchMissile", "LaunchMissile cannot be applied"]]);
});

test("a park that has lost its place asks its remote ballpark for the whole state, as the client does", async () => {
  const { session, space, state } = handTicked();
  space.park.requestReset(); // before anything is bound there is nobody to ask
  assert.deepEqual(session.asked, []);
  await space.start();
  space.park.requestReset();
  assert.equal(session.asked.at(-1), "bound N=1:7 UpdateStateRequest");
  // If the asking fails, that is reported like anything else in the park's own time.
  session.callBound = async () => { throw new Error("gone"); };
  space.park.requestReset();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.errors, [["UpdateStateRequest", "gone"]]);
});

test("a park let go stops ticking, takes nothing more, and asks for nothing", async () => {
  const { session, space, state } = handTicked();
  await space.start();
  space.release();
  space.release();
  assert.deepEqual([state.stopped, space.released, space.remotePark], [1, true, null]);
  assert.equal(space.feed(notifications(undock).find((notification) => notification.method === "DoDestinyUpdate")), false);
  const asked = session.asked.length;
  space.park.requestReset();
  assert.equal(session.asked.length, asked);

  // Let go while the formations are still being asked for: it never starts.
  const early = handTicked();
  const starting = early.space.start();
  early.space.release();
  assert.equal(await starting, null);
  assert.deepEqual([early.state.started, early.session.asked], [0, ["call beyonce.GetFormations"]]);
});

test("formations that cannot be had do not keep the pilot blind: the park still starts", async () => {
  // The retail client would be left without a ballpark here. A web pilot with no view of space is worse than one without formations.
  const { session, space, state } = handTicked({ formationsError: new Error("no formations") });
  assert.equal(await space.start(), "N=1:7");
  assert.deepEqual([state.errors, state.started, session.asked.at(-1)], [[["GetFormations", "no formations"]], 1, `bind beyonce ${SYSTEM}`]);
});

test("a park steps by the pilot's clock: once for each second of it, however many frames that takes", async () => {
  const { space, state } = handTicked();
  await space.start();
  // The first frame came with the start, before anything was bound: one bare step of an empty park.
  assert.deepEqual([space.park.firstTime, space.park.time, space.park.currentTime], [false, 1_000_000, 1]);
  for (const update of destinyUpdates(undock).slice(0, 5)) space.feed({ method: "DoDestinyUpdate", args: [{ type: "list", items: update.entries }, update.waitForBubble] });
  const stamp = destinyUpdates(undock)[2].entries[0][0];
  // Nineteen frames, 50 ms apart: not yet a second.
  for (let frames = 0; frames < 19; frames += 1) {
    state.sim += FRAME_MS;
    state.frame();
  }
  assert.equal(space.park.validState, false);
  state.sim += FRAME_MS;
  state.frame();
  assert.deepEqual([space.park.validState, space.park.currentTime], [true, stamp + 1]);
  // A clock at half pace: forty frames to the next step.
  for (let frames = 0; frames < 39; frames += 1) {
    state.sim += FRAME_MS / 2;
    state.frame();
  }
  assert.equal(space.park.currentTime, stamp + 1);
  state.sim += FRAME_MS / 2;
  state.frame();
  assert.equal(space.park.currentTime, stamp + 2);
  assert.deepEqual(state.errors, []);
});

test("told its clock was rebased, a park moves its own times by the difference, as michelle does", async () => {
  const { space, state } = handTicked();
  await space.start();
  const rebase = (from, to) => space.feed({ method: "DoSimClockRebase", args: [[from, to]] });
  // 134359651870960000 and ...970000 are two of blue's readings a millisecond apart, as eve.js sent them.
  assert.equal(rebase(134359651870960000n, 134359651870970000n), true);
  assert.equal(space.park.time, 1_000_001);
  // Three seconds back: the park is three steps behind its clock, and takes them at the next frame.
  assert.equal(rebase(134359651870960000n, 134359651870960000n - 30_000_000n), true);
  assert.equal(space.park.time, 997_001);
  const before = space.park.currentTime;
  state.frame();
  assert.deepEqual([space.park.currentTime - before, space.park.time], [2, 999_001]);
  state.sim += 1;
  state.frame();
  assert.deepEqual([space.park.currentTime - before, space.park.time], [3, 1_000_001]);
  // Forward: the next step waits that much longer.
  rebase(0n, 5_000_000n);
  state.tick();
  assert.equal(space.park.currentTime - before, 3);
  state.sim += 500;
  state.frame();
  assert.equal(space.park.currentTime - before, 4);
  // The readings come as the wire gives a tuple or a list, as numbers or longs; anything else moves nothing.
  assert.deepEqual([rebaseDelta([10_000, 30_000]), rebaseDelta({ type: "tuple", items: [10_000n, 30_000n] }), rebaseDelta([30_000n, 10_000n])], [2, 2, -2]);
  assert.deepEqual([rebaseDelta(null), rebaseDelta([1n]), rebaseDelta([1n, 2n, 3n]), rebaseDelta(["a", 2n]), rebaseDelta([1.5, 2]), rebaseDelta(7)], [null, null, null, null, null, null]);
  const at = space.park.time;
  assert.equal(space.feed({ method: "DoSimClockRebase", args: [["a", "b"]] }), true);
  assert.equal(space.feed({ method: "DoSimClockRebase", args: null }), true);
  assert.equal(space.park.time, at);
  assert.deepEqual(state.errors, []);
});

test("the clock a park is stepped by is the one its balls are drawn at", async () => {
  const { space, state } = handTicked();
  assert.equal(space.simTime(), 1_000_000);
  state.sim += 123;
  assert.equal(space.simTime(), 1_000_123);
});

test("a park given no clock keeps one of its own, with the real clock", async () => {
  const session = fakeSession();
  let frame = null;
  const space = createPilotSpace({ session, solarSystemID: SYSTEM, startTicking: (each) => { frame = each; return "timer"; }, stopTicking: () => {} });
  await space.start();
  // The first frame stepped it, at the real clock's reading.
  assert.equal(space.park.firstTime, false);
  assert.ok(Math.abs(space.park.time - Date.now()) < 5_000, String(space.park.time));
  assert.ok(Math.abs(space.simTime() - Date.now()) < 5_000);
  frame();
  assert.equal(space.park.currentTime, 1, "and no second has gone by since");
  space.release();
});

// ── what the web client is shown ─────────────────────────────────────────────

test("what a thing is, told from its slim item's category and group", () => {
  assert.deepEqual(
    [[6, 237], [3, 15], [65, 1657], [18, 100], [87, 1652], [25, 462], [46, 1025], [11, 99], [11, 323], [11, 550], [2, 6], [2, 7], [2, 8], [2, 9], [2, 10], [2, 186], [2, 12], [2, 340], [2, 448], [2, 649], [2, 226], [7, 53], [null, null]]
      .map(([category, group]) => kindOf(category, group)),
    ["ship", "station", "structure", "drone", "fighter", "asteroid", "orbital", "sentryGun", "billboard", "ship", "sun", "planet", "moon", "asteroidBelt", "stargate", "wreck", "container", "container", "container", "container", "celestial", null, null],
  );
  assert.equal(CATEGORY.ENTITY, 11);
});

test("health is what the damage state says, with the shield brought forward by its own recharge", () => {
  // ((shield, tau in ms, when), armour, hull). One second on, a quarter shield with tau 1000 ms has recharged to (1 - 0.5/e)^2.
  const state = [[0.25, 1000, 134359116934190000n], 0.5, 0.75];
  assert.deepEqual(healthOf(state, 0), { shieldRatio: 0.25, armorRatio: 0.5, hullRatio: 0.75 });
  const later = healthOf(state, 1);
  assert.ok(Math.abs(later.shieldRatio - (1 - 0.5 / Math.E) ** 2) < 1e-15);
  assert.deepEqual([later.armorRatio, later.hullRatio], [0.5, 0.75]);
  assert.ok(healthOf(state, 3600).shieldRatio > 0.999999, "given long enough it is full");
  // No recharge time: the shield is as stated. Fractions are kept within 0 and 1.
  assert.equal(healthOf([[0.25, 0, 0], 1, 1], 99).shieldRatio, 0.25);
  assert.deepEqual(healthOf([[1.5, 0, 0], -0.1, 2], 0), { shieldRatio: 1, armorRatio: 0, hullRatio: 1 });
  // A shield given as nothing, and no damage state at all.
  assert.deepEqual(healthOf([null, 0.5, 0.75], 5), { shieldRatio: null, armorRatio: 0.5, hullRatio: 0.75 });
  for (const nothing of [null, undefined, [], [1, 2]]) assert.deepEqual(healthOf(nothing, 0), { shieldRatio: null, armorRatio: null, hullRatio: null });
});

/** A park fed the first updates of the undock recording and ticked until the grid is whole. */
function undockedPark() {
  const park = new Park();
  const updates = destinyUpdates(undock);
  for (const update of updates.slice(0, 5)) park.doDestinyUpdate(update.entries, update.waitForBubble);
  for (let i = 0; i < 4; i += 1) park.tick();
  return park;
}

test("the snapshot of a real grid: every ball that has a slim item, in the gateway's shape", () => {
  const park = undockedPark();
  const space = projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID });
  assert.deepEqual([space.inSpace, space.solarSystemID, space.shipID, space.sampledAtMs, space.entities.length], [true, SYSTEM, undock.shipID, park.currentTime * 1000, 95]);
  const kinds = new Map();
  for (const row of space.entities) kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + 1);
  assert.deepEqual([...kinds].sort(), [["celestial", 3], ["moon", 33], ["orbital", 8], ["planet", 8], ["sentryGun", 16], ["ship", 1], ["stargate", 7], ["station", 18], ["sun", 1]]);
  const row = (id) => space.entities.find((entity) => entity.itemID === id);
  const ball = park.ballpark.ball(undock.shipID);

  // The pilot's own ship.
  assert.deepEqual(row(undock.shipID), {
    kind: "ship", itemID: undock.shipID, typeID: 588, groupID: 237, categoryID: 6, name: "Reaper", ownerID: undock.characterID,
    radius: ball.radius, position: { ...ball.newPos }, velocity: { ...ball.newVel }, isSelf: true,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1,
    characterID: undock.characterID, corporationID: 1000044, allianceID: null, securityStatus: 0, maxVelocity: 341, mode: "GOTO",
    targetEntityID: null, capacitorRatio: null, isNpc: false, npcEntityType: null, compressionFacility: null,
  });
  assert.deepEqual(space.ship, {
    itemID: undock.shipID, typeID: 588, name: "Reaper", mode: "GOTO", followRange: null, gotoPoint: { ...ball.goto }, alignTarget: null, warp: null, maxVelocity: 341, radius: ball.radius,
    position: { ...ball.newPos }, velocity: { ...ball.newVel }, shieldRatio: 1, armorRatio: 1, hullRatio: 1,
    capacitorRatio: null, shieldCapacity: null, armorCapacity: null, hullCapacity: null,
    // Dogma has not been asked: what only it knows is not known, which is null and not "none".
    activeModuleIDs: [], overloadedModuleIDs: [], moduleDamage: null, weaponBanks: null, rackHeat: null,
  });
  // A station: no ship's fields, and the health the server sent for it.
  const station = row(60003760);
  assert.deepEqual(Object.keys(station), ["kind", "itemID", "typeID", "groupID", "categoryID", "name", "ownerID", "radius", "position", "velocity", "isSelf", "shieldRatio", "armorRatio", "hullRatio"]);
  assert.deepEqual([station.kind, station.name, station.typeID, station.ownerID, station.isSelf, station.velocity], ["station", "Jita IV - Moon 4 - Caldari Navy Assembly Plant", 52678, 1000035, false, { x: 0, y: 0, z: 0 }]);
  // A moon has no health; a sentry gun's slim item has no name.
  const moon = row(40009081);
  assert.deepEqual([moon.kind, moon.name, moon.radius, moon.shieldRatio, moon.armorRatio, moon.hullRatio], ["moon", "Jita III - Moon 1", 560000, null, null, null]);
  const gun = space.entities.find((entity) => entity.kind === "sentryGun");
  assert.deepEqual([gun.name, gun.categoryID, gun.groupID, gun.typeID > 0], [null, 11, 99, true]);
});

test("given the clock's reading, the snapshot has every ball where the client draws it, and how fast it says it is going", () => {
  // The recorded undock played through a park stepped by a clock, a frame every 50 ms.
  const park = new Park();
  const updates = destinyUpdates(undock);
  let clock = 9_000_000;
  park.onTick(clock);
  for (const update of updates.slice(0, 5)) park.doDestinyUpdate(update.entries, update.waitForBubble);
  for (let frames = 0; frames < 60; frames += 1) park.onTick((clock += 50));
  const ball = park.ballpark.ball(undock.shipID);
  assert.deepEqual([park.time, ball.newTime, ball.oldTime], [9_003_000, 9_002_000, 9_001_000]);
  const shown = (simTime) => projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID, ...(simTime === undefined ? {} : { simTime }) });
  const ship = (space) => space.entities.find((row) => row.isSelf);
  const at = (point) => [point.x, point.y, point.z];

  // Without a reading: the park's own, at its last tick.
  assert.deepEqual([at(ship(shown()).position), at(ship(shown()).velocity)], [at(ball.newPos), at(ball.newVel)]);
  // At the reading of the step itself the ship is drawn where it was a tick ago; the ship flies straight at 341 m/s here.
  const stepped = shown(9_003_000);
  assert.deepEqual(at(ship(stepped).position), at(ball.oldPos));
  assert.deepEqual([stepped.ship.position, stepped.ship.velocity], [ship(stepped).position, ship(stepped).velocity]);
  // A quarter of a second on, a quarter of a tick's travel further; three quarters, three.
  const far = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const quarter = shown(9_003_250);
  const three = shown(9_003_750);
  assert.ok(Math.abs(far(ship(quarter).position, ball.oldPos) - 341 / 4) < 1e-3, String(far(ship(quarter).position, ball.oldPos)));
  assert.ok(Math.abs(far(ship(three).position, ball.oldPos) - 341 * 0.75) < 1e-3);
  assert.ok(Math.abs(Math.hypot(...at(ship(three).velocity)) - 341) < 1e-6);
  // The tick the snapshot names is still the park's.
  assert.deepEqual([stepped.sampledAtMs, three.sampledAtMs], [park.currentTime * 1000, park.currentTime * 1000]);
  // What does not move is where it is, whenever it is asked.
  const station = (space) => space.entities.find((row) => row.kind === "station");
  assert.deepEqual(station(three).position, station(shown()).position);
  assert.deepEqual(at(station(three).velocity), [0, 0, 0]);
  // Slowing down, the speed is the drawn one too: at the step, what it was a tick ago, and less as the second goes by.
  park.ballpark.stop(undock.shipID);
  park.onTick((clock += 1000));
  const speed = (space) => Math.hypot(...at(ship(space).velocity));
  const slower = Math.hypot(...at(ball.newVel));
  assert.ok(slower < 300, String(slower));
  assert.ok(Math.abs(speed(shown(clock)) - 341) < 1e-6);
  const half = speed(shown(clock + 500));
  assert.ok(half < 341 - 1 && half > slower + 1, String(half));
  assert.equal(speed(shown()), slower);
});

test("what dogma says of the pilot's own ship goes where the ballpark has nothing to say", () => {
  const park = undockedPark();
  const readings = { capacitorRatio: 0.625, shieldCapacity: 175, armorCapacity: 150, hullCapacity: 151, activeModuleIDs: [9988400103292], overloadedModuleIDs: [9988400103293] };
  const space = projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID, readings });
  assert.deepEqual([space.ship.activeModuleIDs, space.ship.overloadedModuleIDs], [[9988400103292], [9988400103293]]);
  // Readings that do not say how healthy the ship is leave the ballpark's word standing; ones that do are the panel's.
  assert.deepEqual([space.ship.shieldRatio, space.ship.armorRatio, space.ship.hullRatio, space.ship.moduleDamage, space.ship.weaponBanks], [1, 1, 1, null, null]);
  const hurt = projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID, readings: { ...readings, shieldRatio: 0.4, armorRatio: 0.65, hullRatio: 0, moduleDamage: { 9988400103292: 0.18 }, weaponBanks: { 9988400103292: [9988400103293] } } }).ship;
  assert.deepEqual([hurt.shieldRatio, hurt.armorRatio, hurt.hullRatio], [0.4, 0.65, 0], "a hull with none left is 0, not the ballpark's");
  const stripped = projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID, readings: { ...readings, shieldRatio: 0, armorRatio: 0, hullRatio: 0.5 } }).ship;
  assert.deepEqual([stripped.shieldRatio, stripped.armorRatio, stripped.hullRatio], [0, 0, 0.5], "and so are a shield and an armour with none left");
  assert.deepEqual([hurt.moduleDamage, hurt.weaponBanks], [{ 9988400103292: 0.18 }, { 9988400103292: [9988400103293] }]);
  // How hot the racks are is dogma's too: said as it says it, and not known when it does not say.
  assert.equal(space.ship.rackHeat, null);
  assert.equal(hurt.rackHeat, null, "readings that carry no heat");
  const hot = projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID, readings: { ...readings, rackHeat: { high: 0.42, mid: 0, low: 0 } } }).ship;
  assert.deepEqual(hot.rackHeat, { high: 0.42, mid: 0, low: 0 });
  const partly = projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID, readings: { ...readings, shieldRatio: null, armorRatio: 0.5, moduleDamage: {}, weaponBanks: {} } }).ship;
  assert.deepEqual([partly.shieldRatio, partly.armorRatio, partly.hullRatio, partly.moduleDamage, partly.weaponBanks], [1, 0.5, 1, {}, {}]);
  // The row everyone sees of the ship keeps the ballpark's health: that is what another pilot is shown.
  assert.deepEqual((() => { const own = projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID, readings: { ...readings, armorRatio: 0.5 } }).entities.find((entity) => entity.isSelf); return [own.shieldRatio, own.armorRatio, own.hullRatio]; })(), [1, 1, 1]);
  // With nothing from dogma, nothing is said to be running.
  const bare = projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID }).ship;
  assert.deepEqual([bare.activeModuleIDs, bare.overloadedModuleIDs, bare.capacitorRatio], [[], [], null]);
  assert.deepEqual([space.ship.capacitorRatio, space.ship.shieldCapacity, space.ship.armorCapacity, space.ship.hullCapacity], [0.625, 175, 150, 151]);
  assert.equal(space.entities.find((row) => row.isSelf).capacitorRatio, 0.625);
  // Nobody else's capacitor is known, and health is still the ballpark's.
  assert.ok(space.entities.filter((row) => !row.isSelf).every((row) => row.capacitorRatio === undefined || row.capacitorRatio === null));
  assert.deepEqual([space.ship.shieldRatio, space.ship.armorRatio, space.ship.hullRatio], [1, 1, 1]);
});

test("a ball with no slim item, and one on its way out, are not rows", () => {
  const park = undockedPark();
  park.ballpark.addBall({ id: -2000000001, x: 5 }); // a ball of the client's own
  park.ballpark.addBall({ id: 777, x: 9 }); // added, slim item not come
  park.ballpark.removeBall(60003466, 30); // exploding for 30 ticks
  const space = projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID });
  assert.equal(space.entities.length, 94);
  assert.deepEqual([-2000000001, 777, 60003466].map((id) => space.entities.some((row) => row.itemID === id)), [false, false, false]);
});

test("a ship's row says what it is doing, who it follows, and whether anyone is flying it", () => {
  const park = undockedPark();
  const slim = (fields) => new Map(Object.entries(fields));
  // A rat: a ship of the Entity category, orbiting the pilot.
  park.ballpark.addBall({ id: 9000000000001, isFree: true, mass: 1e6, x: 1e3, maxVelocity: 250 });
  park.slimItems.set(9000000000001, slim({ itemID: 9000000000001, typeID: 23707, groupID: 550, categoryID: 11, ownerID: 500010 }));
  park.ballpark.orbit(9000000000001, undock.shipID, 7500);
  // Another pilot, stopped, damaged, with a shield that recharges.
  park.ballpark.addBall({ id: 9000000000002, isFree: true, mass: 1e6, x: 2e3, maxVelocity: 0 });
  park.slimItems.set(9000000000002, slim({ itemID: 9000000000002n, typeID: 587, groupID: 25, categoryID: 6, ownerID: 140000009, charID: 140000009, corpID: 98000001, allianceID: 99000001, securityStatus: -2.5, name: Buffer.from("Rifter") }));
  park._damage(9000000000002, [[0.25, 1000, 0n], 0.5, 0.75]);
  park.tick();
  const space = projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID });
  const rat = space.entities.find((row) => row.itemID === 9000000000001);
  assert.deepEqual([rat.kind, rat.isNpc, rat.mode, rat.targetEntityID, rat.maxVelocity, rat.characterID, rat.name], ["ship", true, "ORBIT", undock.shipID, 250, null, null]);
  const pilot = space.entities.find((row) => row.itemID === 9000000000002);
  assert.deepEqual([pilot.kind, pilot.isNpc, pilot.mode, pilot.targetEntityID, pilot.maxVelocity, pilot.characterID, pilot.corporationID, pilot.allianceID, pilot.securityStatus, pilot.name],
    ["ship", false, "STOP", null, null, 140000009, 98000001, 99000001, -2.5, "Rifter"]);
  assert.ok(Math.abs(pilot.shieldRatio - (1 - 0.5 / Math.E) ** 2) < 1e-15, "one tick of recharge since the state came");
  assert.deepEqual([pilot.armorRatio, pilot.hullRatio], [0.5, 0.75]);

  // A structure carries the same fields a ship does. An empty name is no name.
  park.ballpark.addBall({ id: 1030000000001, x: 9e5, radius: 5000 });
  park.slimItems.set(1030000000001, slim({ itemID: 1030000000001n, typeID: 35832, groupID: 1657, categoryID: 65, ownerID: 98000001, corpID: 98000001, allianceID: 0, name: Buffer.alloc(0) }));
  // A ball that once followed something and is now only flying keeps no target.
  Object.assign(park.ballpark.ball(9000000000002), { followId: undock.shipID });
  const again = projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID });
  const structure = again.entities.find((row) => row.itemID === 1030000000001);
  assert.deepEqual([structure.kind, structure.name, structure.corporationID, structure.allianceID, structure.mode, structure.isNpc, structure.maxVelocity], ["structure", null, 98000001, null, "STOP", false, null]);
  assert.equal(again.entities.find((row) => row.itemID === 9000000000002).targetEntityID, null);
});

test("the flight status's movement is the pilot's own ball; with no ball there is nothing to say", () => {
  const park = undockedPark();
  assert.deepEqual(projectFlight(park), { shipMode: "GOTO", shipSpeedFraction: 1 });
  park.ballpark.setSpeedFraction(undock.shipID, 0.5);
  park.ballpark.stop(undock.shipID);
  assert.deepEqual(projectFlight(park), { shipMode: "STOP", shipSpeedFraction: 0.5 });
  park.ballpark.ball(undock.shipID).mode = MODE.WARP;
  assert.equal(projectFlight(park).shipMode, "WARP");
  assert.deepEqual(projectFlight(new Park({ ballpark: new Ballpark() })), { shipMode: null, shipSpeedFraction: null });
  park.ballpark.removeBall(undock.shipID);
  assert.deepEqual(projectFlight(park), { shipMode: null, shipSpeedFraction: null });
  assert.equal(projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID }).ship, null);
});

// ── through a gate and back ──────────────────────────────────────────────────
//
// test/fixtures/destinyJump.json (scripts/record-jump.js): the pilot undocks
// at Jita 4-4, warps 40 AU to the Perimeter gate, jumps, flies up to the gate
// it came out of, jumps back, warps to its station and docks. The recorder
// kept a park for each system with the transport's own park keeper, and wrote
// down what each held when it was let go.

/** The recording played through: a park for the system the session is in, replaced when the system changes, ticked once a second. */
function replayTrip() {
  const where = {};
  const parks = [];
  let current = null;
  let clock = 0;
  const close = () => {
    if (current) parks.push(current);
    current = null;
  };
  for (const item of timeline(jumpTrip)) {
    if (current) {
      while (clock + 1000 <= item.atMs) {
        current.park.tick();
        clock += 1000;
        const { park } = current;
        if (!park.validState) continue;
        current.first ??= park.currentTime;
        if (current.counts.at(-1)?.[1] !== park.ballpark.balls.size) current.counts.push([park.currentTime - current.first, park.ballpark.balls.size]);
        const ego = park.ego === null ? null : park.ballpark.ball(park.ego);
        if (ego) current.peak = Math.max(current.peak, Math.hypot(ego.newVel.x, ego.newVel.y, ego.newVel.z));
        if (ego) current.arrivedAt ??= { ...ego.newPos };
      }
    }
    if (item.kind === "sessionChange") {
      for (const [name, [, value]] of Object.entries(item.changes)) where[name] = value === null || value === undefined ? null : Number(value);
      // michelle.UpdateBallpark: none while docked; another for another system.
      const wanted = where.stationid ? null : where.solarsystemid ?? null;
      if (current && current.system !== wanted) close();
      if (wanted && !current) {
        const made = { system: wanted, first: null, counts: [], peak: 0, posted: [] };
        made.park = new Park({ ballpark: new Ballpark({ onPost: (name) => made.posted.push([name, made.park.currentTime - made.first]) }) });
        current = made;
        clock = item.atMs;
      }
    } else if (current && item.method === "DoDestinyUpdate") {
      current.park.doDestinyUpdate(item.args[0], item.args[1], item.args[2]);
    }
  }
  close();
  return parks;
}

test("a recorded trip through a gate and back: a park for each system, each ending with what the live one held", () => {
  const parks = replayTrip();
  assert.deepEqual(parks.map((each) => each.system), [jumpTrip.homeSystemID, jumpTrip.farSystemID, jumpTrip.homeSystemID]);
  assert.deepEqual(parks.map((each) => [each.park.ballpark.balls.size, each.park.slimItems.size]), jumpTrip.parks.map((live) => [live.balls, live.slimItems]));
  assert.deepEqual(jumpTrip.parks.map((live) => live.balls), [111, 89, 95]);
  for (const [index, each] of parks.entries()) {
    assert.deepEqual([[...each.park.failed], each.park.resets, each.park.fatalDesyncs, each.park.validState], [[], 0, 0, true]);
    // What kinds of thing, by the slim items' category and group: the same as the live park's.
    const kinds = {};
    for (const slim of each.park.slimItems.values()) kinds[`${slim.get("categoryID")}/${slim.get("groupID")}`] = (kinds[`${slim.get("categoryID")}/${slim.get("groupID")}`] ?? 0) + 1;
    assert.deepEqual(kinds, jumpTrip.parks[index].byCategoryAndGroup);
  }
  assert.deepEqual([jumpTrip.parkErrors, jumpTrip.docked], [[], true]);
});

test("what is at a gate, by kind, is what the gateway's snapshot of the same gates called it", () => {
  const [out, far] = replayTrip();
  const kinds = (each) => {
    const counted = {};
    for (const row of projectSpace(each.park, { solarSystemID: each.system, shipID: jumpTrip.shipID }).entities) counted[row.kind] = (counted[row.kind] ?? 0) + 1;
    return counted;
  };
  // Jita's Perimeter gate, as the gateway listed it: 3 billboard, 33 moon, 8 orbital, 8 planet, 24 sentryGun, 9 ship, 7 stargate, 18 station, 1 sun.
  assert.deepEqual(kinds(out), { billboard: 3, moon: 33, orbital: 8, planet: 8, sentryGun: 24, ship: 9, stargate: 7, station: 18, sun: 1 });
  // Perimeter's Jita gate: the same as the gateway's, but for the scenery the server placed, which it alone calls authoredSpaceProp.
  assert.deepEqual(kinds(far), { asteroidBelt: 3, billboard: 1, celestial: 27, moon: 10, orbital: 10, planet: 10, sentryGun: 8, ship: 8, stargate: 5, station: 5, structure: 1, sun: 1 });
  // A billboard is nobody's ship: it carries none of a ship's fields.
  const billboard = projectSpace(far.park, { solarSystemID: far.system, shipID: jumpTrip.shipID }).entities.find((row) => row.kind === "billboard");
  assert.deepEqual([billboard.isNpc, billboard.mode, billboard.categoryID, billboard.groupID], [undefined, undefined, 11, 323]);
});

// ── what kind of ship nobody is flying ───────────────────────────────────────
//
// The gateway says "concord", "npc" or "drifter" of such a ship, from the server's own record of it. A client is
// sent the ship's type, so its group, and the slim item's hostile_response_threshold: above nought the ship is
// hostile whatever the pilot's standing (npcs/client/entitystandings.py). The recorded trip has the law at both
// its gates, as this server sent it: customs officials at Jita's (group 446, thresholds -11 and -11) and CONCORD
// at Perimeter's (groups 301 and 182, thresholds -11 and 11).

test("the ships nobody flies at the two recorded gates are the law's, told from each one's group and the threshold sent with it", () => {
  const [out, far] = replayTrip();
  const ships = (each) => projectSpace(each.park, { solarSystemID: each.system, shipID: jumpTrip.shipID }).entities.filter((row) => row.kind === "ship");
  const sent = (each, row) => {
    const slim = [...each.park.slimItems.values()].find((one) => Number(one.get("itemID")) === row.itemID);
    return [row.groupID, slim.get("hostile_response_threshold") ?? null, slim.get("friendly_response_threshold") ?? null, row.isNpc, row.npcEntityType];
  };
  const tally = (each) => {
    const counted = {};
    for (const row of ships(each)) counted[sent(each, row).join(" ")] = (counted[sent(each, row).join(" ")] ?? 0) + 1;
    return counted;
  };
  // Jita's Perimeter gate: eight customs officials, and the pilot's own ship, which is nobody's NPC.
  assert.deepEqual(tally(out), { "446 -11 -11 true concord": 8, "237   false ": 1 });
  // Perimeter's Jita gate: five of CONCORD's own group and two of the police's.
  assert.deepEqual(tally(far), { "301 -11 11 true concord": 5, "182 -11 11 true concord": 2, "237   false ": 1 });
  const own = ships(out).find((row) => row.itemID === jumpTrip.shipID);
  assert.deepEqual([own.isNpc, own.npcEntityType], [false, null]);
});

test("a ship nobody flies is the law's only if it is of the law's groups and not sent as hostile; a drifter is told by its group", () => {
  const park = undockedPark();
  const slim = (fields) => new Map(Object.entries(fields));
  let next = 9000000000100;
  const kindOfShip = (fields) => {
    next += 1;
    park.ballpark.addBall({ id: next, isFree: true, mass: 1e6, x: 1e3 + (next % 100) * 500, maxVelocity: 250 });
    park.slimItems.set(next, slim({ itemID: BigInt(next), categoryID: 11, ownerID: 1000125, ...fields }));
    const row = projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID }).entities.find((each) => each.itemID === next);
    return [row.kind, row.isNpc, row.npcEntityType];
  };
  // The law, as this server and Tranquility send it: CONCORD, the police, the customs officials, a faction's navy.
  for (const groupID of [301, 182, 446, 288]) {
    assert.deepEqual(kindOfShip({ typeID: 3863, groupID, hostile_response_threshold: -11, friendly_response_threshold: 11 }), ["ship", true, "concord"], `group ${groupID}`);
  }
  // A pirate (a Guristas frigate's group), sent as hostile; and one sent with no threshold at all.
  assert.deepEqual(kindOfShip({ typeID: 23707, groupID: 550, hostile_response_threshold: 11, friendly_response_threshold: 11 }), ["ship", true, "npc"]);
  assert.deepEqual(kindOfShip({ typeID: 23707, groupID: 550 }), ["ship", true, "npc"]);
  // A ship of a CONCORD type that the server sends as hostile, as it does one put out from its catalogue: not the law.
  assert.deepEqual(kindOfShip({ typeID: 3863, groupID: 301, hostile_response_threshold: 11, friendly_response_threshold: 11 }), ["ship", true, "npc"]);
  // Of the law's groups with no threshold sent, or one of nought: not sent as hostile, so the law's.
  assert.deepEqual(kindOfShip({ typeID: 3863, groupID: 301 }), ["ship", true, "concord"]);
  assert.deepEqual(kindOfShip({ typeID: 3863, groupID: 301, hostile_response_threshold: 0 }), ["ship", true, "concord"]);
  // Not hostile, and not of the law's groups (the ORE mining fleet's Venture, sent with -5 and 5): the gateway's word for it is "npc".
  assert.deepEqual(kindOfShip({ typeID: 42533, groupID: 1764, hostile_response_threshold: -5, friendly_response_threshold: 5 }), ["ship", true, "npc"]);
  // A Drifter Battleship, whatever is sent with it.
  assert.deepEqual(kindOfShip({ typeID: 34495, groupID: 1310, hostile_response_threshold: 11, friendly_response_threshold: 11 }), ["ship", true, "drifter"]);
  assert.deepEqual(kindOfShip({ typeID: 34495, groupID: 1310 }), ["ship", true, "drifter"]);
  // A ship somebody is flying has no such kind, whatever its slim item carries.
  assert.deepEqual(kindOfShip({ typeID: 587, groupID: 25, categoryID: 6, ownerID: 140000009, charID: 140000009, hostile_response_threshold: -11 }), ["ship", false, null]);

  // A player's hull that an NPC owns is nobody's to fly either: the ORE mining fleet's Hulk, as this server sends
  // it (the Hulk's own type, of the Ship category, owned by the ORE corporation, thresholds -5 and 5).
  const hulk = { typeID: 22544, groupID: 543, categoryID: 6, hostile_response_threshold: -5, friendly_response_threshold: 5 };
  assert.deepEqual(kindOfShip({ ...hulk, ownerID: 1000129 }), ["ship", true, "npc"]);
  // The owners a client takes for an NPC: above the system's own, below the players' (idCheckers.IsNPC).
  assert.deepEqual([9999, 10000, 500014, 3008416, 89999999, 90000000, 98000001, 140000009].map((ownerID) => kindOfShip({ ...hulk, ownerID })[1]), [false, true, true, true, true, false, false, false]);
  // With no owner said, or the system's, a player's hull is not taken for an NPC's.
  assert.deepEqual([kindOfShip({ ...hulk, ownerID: null }), kindOfShip({ ...hulk, ownerID: 1 })], [["ship", false, null], ["ship", false, null]]);
  // A structure an NPC corporation owns is not a ship nobody flies.
  next += 1;
  park.ballpark.addBall({ id: next, x: 8e5, radius: 5000 });
  park.slimItems.set(next, slim({ itemID: BigInt(next), typeID: 35832, groupID: 1657, categoryID: 65, ownerID: 1000125, corpID: 1000125 }));
  const structure = projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID }).entities.find((each) => each.itemID === next);
  assert.deepEqual([structure.kind, structure.isNpc, structure.npcEntityType], ["structure", false, null]);

  // The same, asked of the table itself.
  assert.deepEqual([npcKindOf(301), npcKindOf(301, null), npcKindOf(301, -11), npcKindOf(301, 0), npcKindOf(301, 0.5), npcKindOf(301, 11)], ["concord", "concord", "concord", "concord", "npc", "npc"]);
  assert.deepEqual([npcKindOf(550), npcKindOf(550, -11), npcKindOf(550, 11), npcKindOf(1310), npcKindOf(1310, -11), npcKindOf(null), npcKindOf(null, -11)], ["npc", "npc", "npc", "drifter", "drifter", "npc", "npc"]);
});

// ── a ship that compresses ore ───────────────────────────────────────────────
//
// A client is told on the ship's slim item: compression_facility_typelists, a dict of the type lists the ship
// takes, each with the range it takes them at (itemcompression/__init__.py; inSpaceCompression.py reads it).
// This server puts it there while the ship runs an industrial core and a compressor, and sends the slim item
// again when either starts or stops. No recording of Tranquility has one. The values here are what a Porpoise
// with a Medium Industrial Core I and a Medium Asteroid Ore Compressor I was given on this server (2026-10-10):
// list 334, at 66,000 m.

const dict = (pairs) => ({ type: "dict", entries: pairs });

test("a ship that is compressing says how far it reaches and which lists it takes, from its slim item; no other row says so", () => {
  const park = undockedPark();
  const slim = (fields) => new Map(Object.entries(fields));
  const PORPOISE = 9000000000201;
  const flown = { itemID: BigInt(PORPOISE), typeID: 42244, groupID: 1283, categoryID: 6, ownerID: 140000009, charID: 140000009, corpID: 98000001 };
  park.ballpark.addBall({ id: PORPOISE, isFree: true, mass: 1e6, x: 3e3, maxVelocity: 100 });
  const facilityOf = (itemID) => projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID }).entities.find((row) => row.itemID === itemID).compressionFacility;

  // Not compressing: the slim item has no such thing.
  park.slimItems.set(PORPOISE, slim(flown));
  assert.equal(facilityOf(PORPOISE), null);
  // Compressing: told by a slim item sent again, as an entry of a ballpark update.
  park._notSimulation("OnSlimItemChange", [BigInt(PORPOISE), dict(Object.entries({ ...flown, compression_facility_typelists: dict([[334, 66000]]) }))]);
  assert.deepEqual(facilityOf(PORPOISE), { rangeMeters: 66000, typeListIDs: [334] });
  // Two lists at two ranges: the widest, and the lists in order whatever order they came in.
  park.slimItems.set(PORPOISE, slim({ ...flown, compression_facility_typelists: dict([[336, 20000n], [334, 66000], [335, 1]]) }));
  assert.deepEqual(facilityOf(PORPOISE), { rangeMeters: 66000, typeListIDs: [334, 335, 336] });
  // Stopped: the slim item comes again without it, or with nothing in it.
  park._notSimulation("OnSlimItemChange", [BigInt(PORPOISE), dict(Object.entries(flown))]);
  assert.equal(facilityOf(PORPOISE), null);
  park.slimItems.set(PORPOISE, slim({ ...flown, compression_facility_typelists: dict([]) }));
  assert.equal(facilityOf(PORPOISE), null);

  // The pilot's own ship is read the same way.
  const own = park.slimItems.get(undock.shipID);
  assert.equal(facilityOf(undock.shipID), null);
  own.set("compression_facility_typelists", dict([[334, 66000]]));
  assert.deepEqual(facilityOf(undock.shipID), { rangeMeters: 66000, typeListIDs: [334] });
  own.delete("compression_facility_typelists");

  // It is a ship's and a structure's field and no other row's, as on the gateway.
  const rows = projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID }).entities;
  assert.deepEqual([...new Set(rows.filter((row) => "compressionFacility" in row).map((row) => row.kind))].sort(), ["ship"]);
  assert.ok(rows.filter((row) => !("compressionFacility" in row)).length > 90);

  // The reading itself: what is not a dict, or has nothing a list could be, is no facility.
  assert.deepEqual([compressionFacilityOf(undefined), compressionFacilityOf(null), compressionFacilityOf(334), compressionFacilityOf({ type: "list", items: [[334, 66000]] }), compressionFacilityOf(dict([]))], [null, null, null, null, null]);
  // A list with no range is listed, and the reach is none: the page takes that for no facility, as it does the gateway's.
  assert.deepEqual(compressionFacilityOf(dict([[334, 0]])), { rangeMeters: null, typeListIDs: [334] });
  assert.deepEqual(compressionFacilityOf(dict([[0, 66000], [334n, 20000n]])), { rangeMeters: 66000, typeListIDs: [334] });
});

// ── an ice site and an ore anomaly ───────────────────────────────────────────
//
// Set beside the gateway's rows on the same grids (Halaima, 2026-10-10): the same number of rows on each, and the
// rocks the same field for field but for what is left in them, which a client is not told. Ice is a rock to both:
// a chunk of White Glaze is an asteroid that yields its own type. The words differ for a site's furniture only,
// where the gateway has the server's own names and a client has the slim item's category and group: the ice
// field's anchor and its marker are of the asteroid belt's group, and an anomaly's marker and its scenery are
// plain celestials. The types and groups here are the rows' own; the slim items are made up round them.

test("at an ice site and an ore anomaly: ice is a rock that yields its own type, and the site's furniture is told by its group", () => {
  const park = undockedPark();
  const slim = (fields) => new Map(Object.entries(fields));
  let next = 9000000000300;
  const rowOf = (fields) => {
    next += 1;
    park.ballpark.addBall({ id: next, x: 4e4 + (next % 100) * 1e3, radius: 900 });
    park.slimItems.set(next, slim({ itemID: BigInt(next), ownerID: 1, ...fields }));
    return projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID }).entities.find((row) => row.itemID === next);
  };
  const mining = (row) => [row.kind, row.miningYieldTypeID, row.beltID, row.remainingQuantity];
  const none = (row) => ["miningYieldTypeID" in row, "beltID" in row, "remainingQuantity" in row];

  // A chunk of White Glaze, and a rock of an ore anomaly (Omber): the gateway's rows say the same, with what is left.
  assert.deepEqual(mining(rowOf({ typeID: 16265, groupID: 465, categoryID: 25 })), ["asteroid", 16265, null, null]);
  assert.deepEqual(mining(rowOf({ typeID: 1227, groupID: 469, categoryID: 25 })), ["asteroid", 1227, null, null]);

  // The ice field's anchor and its objective marker (the gateway: "iceFieldAnchor", "siteObjectiveMarker").
  const anchor = rowOf({ typeID: 17774, groupID: 9, categoryID: 2, name: "White Glaze Belt" });
  assert.deepEqual([anchor.kind, anchor.groupID, anchor.name, none(anchor)], ["asteroidBelt", 9, "White Glaze Belt", [false, false, false]]);
  // An anomaly's own marker, and a piece of its scenery (the gateway: "universeAnomalySite" or "siteObjectiveMarker", and "siteEnvironmentProp").
  const marker = rowOf({ typeID: 28356, groupID: 885, categoryID: 2, name: "Halaima Asteroid Cluster" });
  assert.deepEqual([marker.kind, marker.groupID, none(marker)], ["celestial", 885, [false, false, false]]);
  const scenery = rowOf({ typeID: 23753, groupID: 226, categoryID: 2 });
  assert.deepEqual([scenery.kind, scenery.name, none(scenery)], ["celestial", null, [false, false, false]]);
});

test("a new system arrives in two pieces: everything fixed in it, then the gate's own grid two ticks later", () => {
  const [, far, home] = replayTrip();
  assert.deepEqual(far.counts, [[0, 53], [2, 89]]);
  assert.deepEqual(home.counts.slice(0, 2), [[0, 84], [2, 111]]);
  // The pilot's ship is in the first piece, some 15 km from the gate it came out of.
  const ego = far.park.ballpark.ball(far.park.ego);
  const gate = far.park.ballpark.ball(jumpTrip.farGateID);
  const from = (position) => Math.hypot(position.x - gate.newPos.x, position.y - gate.newPos.y, position.z - gate.newPos.z);
  assert.equal(far.park.ego, jumpTrip.shipID);
  assert.ok(Math.abs(from(far.arrivedAt) - 15570) < 400, `${from(far.arrivedAt)} m from the gate on arrival`);
  // By the time it jumped back it had flown to within the 2,500 m a gate is used from.
  assert.ok(from(ego.newPos) - gate.radius - ego.radius < 2500, `${from(ego.newPos) - gate.radius - ego.radius} m from the gate when it jumped`);
  assert.deepEqual(far.posted, [], "nothing warped there");
});

test("a 40 AU warp in the recording: 43 ticks, cruising at exactly three AU a second, the grids changing under it", () => {
  const [out, , back] = replayTrip();
  for (const each of [out, back]) {
    const [[, entered], [, left]] = each.posted;
    assert.deepEqual(each.posted.map(([name]) => name), ["OnActivatingWarp", "OnDeactivatingWarp", "OnExitWarp"]);
    assert.equal(left - entered, 43);
    assert.ok(Math.abs(each.peak / AU - 3) < 1e-12, `${each.peak / AU} AU/s at the peak`);
  }
  // The live park saw the same 43: the recorder wrote down the ticks.
  const live = jumpTrip.warpEvents.filter((event) => event.name !== "OnExitWarp").map((event) => event.value);
  assert.deepEqual([live[1] - live[0], live[3] - live[2]], [43, 43]);
  // Out: the station's grid (95), left behind in warp (76), then the gate's (111). Back: the reverse.
  assert.deepEqual(out.counts.map(([, count]) => count), [76, 95, 76, 111]);
  assert.deepEqual(back.counts.map(([, count]) => count), [84, 111, 76, 95]);
});

test("the pilot's own ship says the range it was told to follow or orbit at, and nothing when it follows nothing", () => {
  const park = undockedPark();
  const slim = (fields) => new Map(Object.entries(fields));
  park.ballpark.addBall({ id: 9000000000001, isFree: true, mass: 1e6, x: 1e4, maxVelocity: 250 });
  park.slimItems.set(9000000000001, slim({ itemID: 9000000000001, typeID: 23707, groupID: 550, categoryID: 11, ownerID: 500010 }));
  const ship = () => projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID }).ship;
  // Flying to a point: it follows nothing, and says the point.
  assert.deepEqual([ship().mode, ship().followRange], ["GOTO", null]);
  assert.deepEqual(ship().gotoPoint, { ...park.ballpark.ball(undock.shipID).goto });
  assert.ok(Number.isFinite(ship().gotoPoint.x) && Math.hypot(ship().gotoPoint.x, ship().gotoPoint.y, ship().gotoPoint.z) > 1e9);
  // Told to orbit at 7.5 km: the range in the order, not how far off the thing is.
  park.ballpark.orbit(undock.shipID, 9000000000001, 7500);
  assert.deepEqual([ship().mode, ship().followRange, ship().gotoPoint], ["ORBIT", 7500, null], "and it is flying to no point");
  // An approach is a follow at 50 m; keeping at range is a follow at the range.
  park.ballpark.followBall(undock.shipID, 9000000000001, 50);
  assert.deepEqual([ship().mode, ship().followRange], ["FOLLOW", 50]);
  park.ballpark.followBall(undock.shipID, 9000000000001, 2500);
  assert.deepEqual([ship().mode, ship().followRange], ["FOLLOW", 2500]);
  // Stopped: it follows nothing, and says no range.
  park.ballpark.stop(undock.shipID);
  assert.deepEqual([ship().mode, ship().followRange, ship().gotoPoint], ["STOP", null, null]);
  // A ball that is only flying, with a range left on it from before, still says none.
  park.ballpark.gotoDirection(undock.shipID, 1, 0, 0);
  park.ballpark.ball(undock.shipID).followRange = 900;
  assert.deepEqual([ship().mode, ship().followRange], ["GOTO", null]);
});

// ── the warp, as the client's HUD is told of it ──────────────────────────────

test("CheckWarpDestination: a thing lies where the warp points if it is in the same direction, or near the point", () => {
  const ego = { x: 0, y: 0, z: 0 };
  const point = { x: 1e11, y: 0, z: 0 };
  const check = (thing, angle = Math.PI / 32, reach = 20000000) => checkWarpDestination(point, thing, ego, angle, reach);
  // The very place.
  assert.equal(check({ x: 1e11, y: 0, z: 0 }), true);
  // Farther along the same line: the direction is the same.
  assert.equal(check({ x: 3e11, y: 0, z: 0 }), true);
  // Off to one side by less than pi/32 of the direction, and by more.
  assert.equal(check({ x: 3e11, y: 3e11 * Math.tan(Math.PI / 32 - 0.001), z: 0 }), true);
  assert.equal(check({ x: 3e11, y: 3e11 * Math.tan(Math.PI / 32 + 0.001), z: 0 }), false);
  // A long way round, but within 20,000 km of the point itself.
  const beside = (metres) => ({ x: 0, y: metres, z: 0 });
  assert.equal(checkWarpDestination(beside(1.9e7), beside(0), { x: 1e3, y: 0, z: 0 }, Math.PI / 32, 20000000), true);
  assert.equal(checkWarpDestination(beside(2.1e7), beside(0), { x: 1e3, y: 0, z: 0 }, Math.PI / 32, 20000000), false);
  // Behind the ship: neither.
  assert.equal(check({ x: -1e11, y: 0, z: 0 }), false);
  // The directions are taken from the ship, wherever it is: straight up from a ship that is itself far out.
  const out = { x: 1e11, y: 0, z: 0 };
  assert.equal(checkWarpDestination({ x: 1e11, y: 1e11, z: 0 }, { x: 1e11, y: 3e11, z: 0 }, out, Math.PI / 32, 20000000), true);
  assert.equal(checkWarpDestination({ x: 1e11, y: 1e11, z: 0 }, { x: 3e11, y: 3e11, z: 0 }, out, Math.PI / 32, 20000000), false);
  // The ship at the point itself has no direction to it: only the distance can say.
  assert.equal(checkWarpDestination(ego, { x: 1e6, y: 0, z: 0 }, ego, Math.PI / 32, 20000000), true);
  assert.equal(checkWarpDestination(ego, { x: 1e9, y: 0, z: 0 }, ego, Math.PI / 32, 20000000), false);
});

test("the pilot's own ship in warp: lining up or under way, the server's point, and the thing asked for if the warp is aimed at it", () => {
  const park = undockedPark();
  const slim = (fields) => new Map(Object.entries(fields));
  const from = { ...park.ballpark.ball(undock.shipID).newPos };
  // Two things a long way off: one where the warp will point, one an eighth of a turn to the side.
  const there = { x: from.x + 4e11, y: from.y, z: from.z };
  park.ballpark.addBall({ id: 40000001, x: there.x, y: there.y, z: there.z, radius: 5000 });
  park.slimItems.set(40000001, slim({ itemID: 40000001, typeID: 14, groupID: 8, categoryID: 2, ownerID: 1 }));
  park.ballpark.addBall({ id: 40000002, x: from.x + 4e11, y: from.y + 4e11, z: from.z, radius: 5000 });
  park.slimItems.set(40000002, slim({ itemID: 40000002, typeID: 14, groupID: 8, categoryID: 2, ownerID: 1 }));
  const ship = (warpDestination) => projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID, warpDestination }).ship;
  assert.equal(ship(40000001).warp, null, "not in warp: nothing, whatever was asked for");

  park.ballpark.warpTo(undock.shipID, there.x, there.y, there.z, 20000, 3000);
  // The server has not said where the warp points (no WarpTo came through the park): no point, and no thing.
  assert.deepEqual([ship(40000001).mode, ship(40000001).warp], ["WARP", { preparing: true, point: null, destinationID: null }]);
  park.warpPoint = { ...there };
  // Lining up: the effect stamp is negative until the warp proper begins.
  assert.ok(park.ballpark.ball(undock.shipID).effectStamp < 0);
  assert.deepEqual(ship(40000001).warp, { preparing: true, point: there, destinationID: 40000001 });
  assert.notEqual(ship(40000001).warp.point, park.warpPoint, "a copy, not the park's own");
  // Asked for the other thing, or nothing, or something not in the park: the warp is not aimed at it.
  assert.deepEqual(ship(40000002).warp, { preparing: true, point: there, destinationID: null });
  assert.deepEqual(ship(null).warp, { preparing: true, point: there, destinationID: null });
  assert.deepEqual(ship(undefined).warp, { preparing: true, point: there, destinationID: null });
  assert.deepEqual(ship(49999999).warp, { preparing: true, point: there, destinationID: null });
  // The warp proper: no longer lining up.
  park.ballpark.realWarp(park.ballpark.ball(undock.shipID));
  assert.deepEqual(ship(40000001).warp, { preparing: false, point: there, destinationID: 40000001 });
  // A warp that began on the very first tick has begun.
  park.ballpark.ball(undock.shipID).effectStamp = 0;
  assert.equal(ship(40000001).warp.preparing, false);
  // A destination given as a long is said as a number.
  assert.equal(ship(40000001n).warp.destinationID, 40000001);
});

test("the pilot's own ship says what it was last aligned to while it flies that course, and not otherwise", () => {
  const park = undockedPark();
  const slim = (fields) => new Map(Object.entries(fields));
  park.ballpark.addBall({ id: 9000000000001, isFree: true, mass: 1e6, x: 1e4, maxVelocity: 250 });
  park.slimItems.set(9000000000001, slim({ itemID: 9000000000001, typeID: 23707, groupID: 550, categoryID: 11, ownerID: 500010 }));
  const ship = (alignTarget) => projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID, alignTarget }).ship;
  // Flying a course: a thing, or a bookmark; what the pilot keeps beside them (when it was ordered) is not said.
  assert.deepEqual([ship(null).mode, ship(null).alignTarget, ship(undefined).alignTarget], ["GOTO", null, null]);
  assert.deepEqual(ship({ itemID: 40009089, bookmark: false, since: 12 }).alignTarget, { itemID: 40009089, bookmark: false });
  assert.deepEqual(ship({ itemID: null, bookmark: true, since: 12 }).alignTarget, { itemID: null, bookmark: true });
  // Doing anything else, it is aligned to nothing.
  park.ballpark.orbit(undock.shipID, 9000000000001, 7500);
  assert.equal(ship({ itemID: 40009089, bookmark: false, since: 12 }).alignTarget, null);
  park.ballpark.stop(undock.shipID);
  assert.equal(ship({ itemID: 40009089, bookmark: false, since: 12 }).alignTarget, null);
});

// importExportUI.py 94: the client knows which planet a customs office is from the office's slim item (planetID),
// and opens the office's window for that planet's colony. The recording is this server's own undock.
test("a customs office's row says which planet it is, as its slim item does, and no other row has a planet", () => {
  const park = undockedPark();
  const space = projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID });
  const offices = space.entities.filter((row) => row.kind === "orbital");
  const planets = new Set(space.entities.filter((row) => row.kind === "planet").map((row) => row.itemID));
  assert.deepEqual([offices.length, planets.size], [8, 8]);
  // Each office is at one of the system's planets, and no two at the same one.
  for (const office of offices) assert.ok(planets.has(office.planetID), `office ${office.itemID} names planet ${office.planetID}`);
  assert.equal(new Set(offices.map((office) => office.planetID)).size, 8);
  assert.deepEqual(space.entities.filter((row) => row.kind !== "orbital" && "planetID" in row), []);
});

// The mining bots, and the overview's rocks, know something to mine by the mining fields of its row
// (web/src/nav/miningBotLoop.ts, isMineableRock). The gateway puts them on an asteroid's row from the server's own
// scene. A pilot on the game port had none, and its bots found every belt empty (seen live 2026-10-10: the same
// bot at the same belt said "Belt empty" on the game port and "Approaching a rock" on the gateway).
//
// The rock is one of 121 at a belt of Muvolailen, as the game-port BFF's snapshot had it that day; through the
// gateway's BFF the same rock had the same type, group and yield, and a belt and a quantity besides.
const ROCK = { itemID: 5020570318849, typeID: 17464, groupID: 460, name: "Scordite III-Grade", radius: 500 };

test("a rock's row says what a laser takes from it, which is its own type; its belt and what is left are not a client's to know", () => {
  const park = undockedPark();
  const slim = (fields) => new Map(Object.entries(fields));
  park.ballpark.addBall({ id: ROCK.itemID, x: 4e4, radius: ROCK.radius });
  park.slimItems.set(ROCK.itemID, slim({ itemID: BigInt(ROCK.itemID), typeID: ROCK.typeID, groupID: ROCK.groupID, categoryID: 25, name: ROCK.name, ownerID: 1 }));
  // And a rock whose type is not said: it yields nothing a bot could name.
  park.ballpark.addBall({ id: ROCK.itemID + 1, x: 5e4, radius: 900 });
  park.slimItems.set(ROCK.itemID + 1, slim({ itemID: BigInt(ROCK.itemID + 1), groupID: ROCK.groupID, categoryID: 25 }));
  const space = projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID });
  const rock = space.entities.find((row) => row.itemID === ROCK.itemID);
  assert.deepEqual([rock.kind, rock.typeID, rock.groupID, rock.categoryID, rock.name, rock.radius], ["asteroid", ROCK.typeID, ROCK.groupID, 25, ROCK.name, ROCK.radius]);
  assert.deepEqual([rock.miningYieldTypeID, rock.beltID, rock.remainingQuantity], [ROCK.typeID, null, null]);
  const untyped = space.entities.find((row) => row.itemID === ROCK.itemID + 1);
  assert.deepEqual([untyped.kind, untyped.typeID, untyped.miningYieldTypeID, untyped.beltID, untyped.remainingQuantity], ["asteroid", null, null, null, null]);
  // The three are an asteroid's and no other row's, as on the gateway: not the pilot's ship's, a station's or a belt's.
  const others = space.entities.filter((row) => row.kind !== "asteroid");
  // (The recorded grid at Jita's undock: 95 things, and no rock among them.)
  assert.equal(others.length, 95);
  assert.deepEqual(others.filter((row) => "miningYieldTypeID" in row || "beltID" in row || "remainingQuantity" in row), []);
  // A row is made in projectEntity: the same of the one ball.
  const ball = park.ballpark.ball(ROCK.itemID);
  const row = projectEntity(park, ball, park.slimItems.get(ROCK.itemID), park.ego, (each) => ({ p: each.newPos, v: each.newVel }));
  assert.deepEqual([row.kind, row.miningYieldTypeID, row.beltID, row.remainingQuantity], ["asteroid", ROCK.typeID, null, null]);
});

// ── drones ───────────────────────────────────────────────────────────────────
//
// michelle's park keeps the states of the pilot's drones (stateByDroneID): filled by a whole state's droneState
// (Park.SetState, 970), changed by OnDroneStateChange (1496), which comes as an entry of a ballpark update and as
// a notice of its own (michelle, 265). The entry is Tranquility's, from a recording of two drones launched: a
// list of the seven, (droneID, ownerID, controllerID, activityState, typeID, controllerOwnerID, targetID). The
// gateway's snapshot says the same four things of every drone on grid, from the server's scene; a client is told
// them of its own drones only.
const DRONE = { itemID: 1054657303648, ownerID: 2124510715, shipID: 1054619390032, typeID: 2203 };
const droneEntry = (more = {}) => ({ type: "list", items: [BigInt(more.itemID ?? DRONE.itemID), more.ownerID ?? DRONE.ownerID, BigInt(more.controllerID ?? DRONE.shipID), more.activityState ?? 0, DRONE.typeID, more.controllerOwnerID ?? DRONE.ownerID, more.targetID ?? null] });
const pilotOfTheDrone = () => ({ charID: DRONE.ownerID, shipID: BigInt(DRONE.shipID) });

test("a drone's state is kept as it is told, and forgotten when the drone is neither the pilot's nor its ship's", () => {
  const park = new Park({ pilot: pilotOfTheDrone });
  // As the recording has it: launched, idle, no target.
  park._notSimulation("OnDroneStateChange", droneEntry());
  assert.deepEqual(park.stateByDroneID.get(DRONE.itemID), { droneID: DRONE.itemID, ownerID: DRONE.ownerID, controllerID: DRONE.shipID, activityState: 0, typeID: DRONE.typeID, controllerOwnerID: DRONE.ownerID, targetID: null });
  // Told again, in combat on something: the state is the new one.
  park._notSimulation("OnDroneStateChange", droneEntry({ activityState: 1, targetID: 9000000000001n }));
  assert.deepEqual([park.stateByDroneID.get(DRONE.itemID).activityState, park.stateByDroneID.get(DRONE.itemID).targetID, park.stateByDroneID.size], [1, 9000000000001, 1]);
  // What it is busy with (Park.OnDroneActivityChange, 1520), kept and let go.
  park.OnDroneActivityChange(BigInt(DRONE.itemID), 3, "assisting");
  assert.deepEqual(park.activityByDrone.get(DRONE.itemID), ["assisting", 3]);
  park.OnDroneActivityChange(DRONE.itemID, null, null);
  assert.equal(park.activityByDrone.has(DRONE.itemID), false);
  park.OnDroneActivityChange(DRONE.itemID, 3, "assisting");
  // The pilot's own drone under another ship's control is still kept; so is another's drone under this ship's.
  park._notSimulation("OnDroneStateChange", droneEntry({ controllerID: 77 }));
  park._notSimulation("OnDroneStateChange", droneEntry({ itemID: 5, ownerID: 99, controllerOwnerID: 99 }));
  assert.deepEqual([park.stateByDroneID.get(DRONE.itemID).controllerID, park.stateByDroneID.get(5).ownerID], [77, 99]);
  // Neither the pilot's nor its ship's: control is lost, and the drone forgotten with what it was busy with.
  park._notSimulation("OnDroneStateChange", droneEntry({ ownerID: 99, controllerID: 77 }));
  assert.deepEqual([park.stateByDroneID.has(DRONE.itemID), park.activityByDrone.has(DRONE.itemID), park.stateByDroneID.size], [false, false, 1]);
  // A park that is told no pilot knows no character: the ship is its own (its ego), and only what that controls is kept.
  const alone = new Park();
  alone.ego = DRONE.shipID;
  alone.OnDroneStateChange(...droneEntry().items);
  alone.OnDroneStateChange(...droneEntry({ itemID: 6, controllerID: 77 }).items);
  assert.deepEqual([...alone.stateByDroneID.keys()], [DRONE.itemID]);
});

test("a whole state brings the drones' states with it and empties what each was busy with; the recorded one has none", () => {
  // The recording's own state, off the server: a rowset of the seven columns, with no drone in it.
  const recorded = undockedPark();
  assert.deepEqual([recorded.stateByDroneID.size, recorded.activityByDrone.size], [0, 0]);
  // The same bag with two drones in its rowset, as the server fills one (space/destiny/index.js, buildDroneState).
  const [, [, [bag]]] = destinyUpdates(undock).flatMap((update) => update.entries).find(([, [name]]) => String(name) === "SetState");
  const withDrones = { ...bag, args: { ...bag.args, entries: bag.args.entries.map(([key, value]) => (String(key) !== "droneState" ? [key, value] : [key, {
    ...value, args: { ...value.args, entries: value.args.entries.map(([name, part]) => (String(name) !== "lines" ? [name, part] : [name, { type: "list", items: [
      [BigInt(DRONE.itemID), DRONE.ownerID, BigInt(DRONE.shipID), 2, DRONE.typeID, DRONE.ownerID, 5020570318849n],
      { type: "list", items: [7n, 99, 77n, 0, 2454, 99, null] },
      [null, 1, 2, 0, 3, 1, null],
    ] }])) },
  }])) } };
  const park = new Park({ pilot: pilotOfTheDrone });
  park.OnDroneStateChange(8, DRONE.ownerID, DRONE.shipID, 0, DRONE.typeID, DRONE.ownerID, null);
  park.OnDroneActivityChange(8, 1, "guarding");
  park.SetState(withDrones);
  // Each row a drone, whoever's it is: the state is the server's word. One with no ID is no drone. What was kept before is gone.
  assert.deepEqual([...park.stateByDroneID.keys()], [DRONE.itemID, 7]);
  assert.deepEqual(park.stateByDroneID.get(DRONE.itemID), { droneID: DRONE.itemID, ownerID: DRONE.ownerID, controllerID: DRONE.shipID, activityState: 2, typeID: DRONE.typeID, controllerOwnerID: DRONE.ownerID, targetID: 5020570318849 });
  assert.deepEqual([park.stateByDroneID.get(7).controllerID, park.stateByDroneID.get(7).targetID, park.activityByDrone.size], [77, null, 0]);
});

test("a drone's row says whose it is, what it is doing and on what, where the park was told; of another's drone it says nothing", () => {
  const park = undockedPark();
  park.pilot = () => ({ charID: 140000002, shipID: undock.shipID });
  const slim = (fields) => new Map(Object.entries(fields));
  // A drone as this server sends one (a Hobgoblin I launched by Test Two, 2026-10-10): typeID 2454, group 100, the Drone category.
  for (const id of [9988400109060, 9988400109061, 9988400109062]) {
    park.ballpark.addBall({ id, isFree: true, mass: 3000, x: 500 + (id % 10) * 100, radius: 15 });
    park.slimItems.set(id, slim({ itemID: BigInt(id), typeID: 2454, groupID: 100, categoryID: 18, name: "Hobgoblin I", ownerID: id === 9988400109062 ? 140000009 : 140000002 }));
  }
  // The pilot's two, as the server's notice says each: (droneID, ownerID, controllerID, activityState, typeID, controllerOwnerID, targetID).
  park.OnDroneStateChange(9988400109060n, 140000002, BigInt(undock.shipID), 0, 2454, 140000002, null);
  park.OnDroneStateChange(9988400109061n, 140000002, BigInt(undock.shipID), 2, 2454, 140000002, 5020570318849n);
  const rows = () => projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID }).entities.filter((row) => row.kind === "drone");
  const said = (row) => [row.controllerID, row.controllerOwnerID, row.droneActivity, row.targetEntityID];
  assert.deepEqual(rows().map((row) => [row.itemID, row.name, row.ownerID, ...said(row)]), [
    [9988400109060, "Hobgoblin I", 140000002, undock.shipID, 140000002, "idle", null],
    [9988400109061, "Hobgoblin I", 140000002, undock.shipID, 140000002, "mining", 5020570318849],
    // Another pilot's drone: a client is told nothing of it, and each of the four is "not known".
    [9988400109062, "Hobgoblin I", 140000009, null, null, null, null],
  ]);
  // Each activity state in the gateway's word for it (appConst.py entityIdle to entitySalvaging); one with no word is not known, never idle.
  for (const [state, word] of [[0, "idle"], [1, "fighting"], [2, "mining"], [3, "approaching"], [4, "returning"], [6, "chasing"], [18, "salvaging"], [5, null], [7, null], [99, null]]) {
    park.OnDroneStateChange(9988400109060, 140000002, undock.shipID, state, 2454, 140000002, null);
    assert.equal(rows()[0].droneActivity, word, String(state));
  }
  // Control lost: the row says nothing again.
  park.OnDroneStateChange(9988400109061, 140000009, 77, 0, 2454, 140000009, null);
  assert.deepEqual(said(rows()[1]), [null, null, null, null]);
  // No other row has a drone's controller or activity.
  const others = projectSpace(park, { solarSystemID: SYSTEM, shipID: undock.shipID }).entities.filter((row) => row.kind !== "drone");
  assert.deepEqual(others.filter((row) => "controllerID" in row || "controllerOwnerID" in row || "droneActivity" in row), []);
});

test("a drone's notice of its own goes to the pilot's park, as michelle sends it on, and is left for the page as well", async () => {
  const { session, space, state } = handTicked();
  session.attributes = { charid: 140000002, shipid: 9988400109051n };
  await space.start();
  const taken = space.feed({ method: "OnDroneStateChange", args: [9988400109060n, 140000002, 9988400109051n, 0, 2454, 140000002, null] });
  assert.deepEqual([taken, space.park.stateByDroneID.get(9988400109060)?.controllerID, space.park.stateByDroneID.get(9988400109060)?.activityState], [false, 9988400109051, 0]);
  assert.equal(space.feed({ method: "OnDroneActivityChange", args: [9988400109060n, 2, "mining"] }), false);
  assert.deepEqual(space.park.activityByDrone.get(9988400109060), ["mining", 2]);
  // Another pilot's drone, told to this session: neither this character's nor this ship's, so nothing is kept of it.
  space.feed({ method: "OnDroneStateChange", args: [9988400109062n, 140000009, 77n, 0, 2454, 140000009, null] });
  assert.equal(space.park.stateByDroneID.has(9988400109062), false);
  // A notice with no arguments to read is passed over, and nothing is reported as gone wrong.
  assert.equal(space.feed({ method: "OnDroneStateChange", args: null }), false);
  assert.equal(space.feed({ method: "OnDroneActivityChange", args: undefined }), false);
  assert.deepEqual([space.park.stateByDroneID.size, state.errors], [1, []]);
});
