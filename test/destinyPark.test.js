"use strict";

// src/gamePort/destiny/park.js is the retail client's side of the ballpark:
// the queue of updates, which tick it is, when to step, and what to do with an
// update that is early or late. Three kinds of evidence:
//
//   - CCP's own tests for the copy of this logic that ships with destiny
//     (python/destiny/test/net/client/test_mergestateintohistory.py and
//     test_ticker.py), carried over case for case;
//   - the recording of a real server (test/fixtures/destinyUndock.json),
//     played through the park as the client would receive it;
//   - cases for what the retail client's michelle.py does beyond CCP's copy.

const test = require("node:test");
const assert = require("node:assert/strict");
const { Park, mergeStateIntoHistory } = require("../src/gamePort/destiny/park");
const { Ballpark } = require("../src/gamePort/destiny/ballpark");
const { MODE } = require("../src/gamePort/destiny/state");
const { marshalEncode } = require("../src/gameProtocol/marshal");
const recording = require("./fixtures/destinyUndock.json");
const { destinyUpdates } = require("./helpers/destinyRecording");

// ── CCP: test_mergestateintohistory.py ───────────────────────────────────────

const SHIP_ID_1 = 1000000176143;
const GOTO_DIRECTION = ["GotoDirection", [SHIP_ID_1, 1.0, 0.0, 0.0]];
const STOP = ["Stop", [SHIP_ID_1]];
/** Merge each [state, wait] in turn into an empty history. */
const merged = (...steps) => {
  const history = [];
  for (const [state, wait] of steps) mergeStateIntoHistory(state, history, wait);
  return history;
};

test("CCP merge: an empty state changes nothing", () => {
  assert.deepEqual(merged([[], true], [[], false]), []);
});

test("CCP merge: one state, with and without waiting for its bubble", () => {
  const state = [[101, GOTO_DIRECTION]];
  assert.deepEqual(merged([state, true]), [[state, true]]);
  assert.deepEqual(merged([state, false]), [[state, false]]);
});

test("CCP merge: two states for the same tick join, and the wait is cleared whichever asked for it", () => {
  const [one, two] = [[[101, GOTO_DIRECTION]], [[101, STOP]]];
  const joined = [[[...one, ...two], false]];
  assert.deepEqual(merged([[...one], true], [[...two], false]), joined);
  assert.deepEqual(merged([[...one], false], [[...two], true]), joined);
  assert.deepEqual(merged([[...one], false], [[...two], false]), joined);
});

test("CCP merge: a newer state goes behind, and an older tick's wait stays", () => {
  const [one, two] = [[[101, GOTO_DIRECTION]], [[102, STOP]]];
  assert.deepEqual(merged([one, true], [two, false]), [[one, true], [two, false]]);
  // The newer one cannot be the first half of a bubble's pair: that would have been for an earlier tick.
  assert.deepEqual(merged([one, false], [two, true]), [[one, false], [two, false]]);
});

test("CCP merge: an older state goes in front, each keeping its own wait", () => {
  const [newer, older] = [[[101, GOTO_DIRECTION]], [[100, STOP]]];
  assert.deepEqual(merged([newer, false], [older, false]), [[older, false], [newer, false]]);
  assert.deepEqual(merged([newer, false], [older, true]), [[older, true], [newer, false]]);
  assert.deepEqual(merged([newer, true], [older, false]), [[older, false], [newer, true]]);
});

test("merge: a batch holding several ticks, out of order, is sorted into the queue", () => {
  // The case the merge was rewritten for: a later tick first in the batch must
  // not leave an earlier group waiting for ever.
  const history = merged([[[22168, STOP]], true]);
  mergeStateIntoHistory([[22169, GOTO_DIRECTION], [22168, GOTO_DIRECTION], [22167, STOP]], history, true);
  assert.deepEqual(history.map(([entries, wait]) => [entries.map(([stamp, [name]]) => `${stamp} ${name}`), wait]), [
    [["22167 Stop"], true],
    [["22168 Stop", "22168 GotoDirection"], false],
    [["22169 GotoDirection"], false],
  ]);
});

// ── CCP: test_ticker.py ──────────────────────────────────────────────────────

const TICKS_ELAPSED = 10;
const keyVal = (entries) => ({ type: "object", name: "util.KeyVal", args: { type: "dict", entries } });
const slim = (itemID, extra = []) => ({ type: "dict", entries: [["itemID", itemID], ...extra] });
/** A SetState bag as the server sends one. */
const bag = (state, ego, slims = []) => keyVal([["state", state], ["ego", ego], ["slims", { type: "list", items: slims }], ["damageState", { type: "dict", entries: [] }]]);

/** destiny.test.net.client.helpers.add_ball_to_park. */
const addBall = (park, id, x) => park.addBall({ id, mass: 1, radius: 1.0, maxVelocity: 1.0, isFree: true, isMassive: true, isInteractive: true, x, agility: 1.0, speedFraction: 1.0 });

/** _get_park_with_state: three balls, ten ticks old. */
function parkWithState() {
  const bp = new Ballpark();
  addBall(bp, 1, 0);
  addBall(bp, 2, 1000);
  addBall(bp, 3, -1000);
  bp.orbit(2, 1);
  bp.gotoPoint(3, 0, 0, 0);
  bp.gotoDirection(1, 0.0, 1.0, 0.0);
  for (let tick = 0; tick < TICKS_ELAPSED; tick += 1) bp.evolve();
  return bp;
}

/** setUp: a park given that state at tick 0 of its own, then ticked once. */
function ccpTicker() {
  const park = new Park();
  const source = parkWithState();
  park.flushState([[0, ["SetState", [bag(source.writeState(), 1, [slim(1), slim(2), slim(3)])]]]], false);
  const tick = (stamp) => {
    park.doPreTick();
    park.ballpark.evolve();
    park.doPostTick(stamp);
  };
  tick(TICKS_ELAPSED);
  return { park, tick, ball: (id) => park.ballpark.ball(id) };
}

test("CCP ticker test_setstate: the state is read, and the park is one tick on from it", () => {
  const { park, ball } = ccpTicker();
  assert.equal(park.currentTime, TICKS_ELAPSED + 1);
  assert.equal(ball(2).mode, MODE.ORBIT);
  assert.deepEqual([park.ego, park.validState, park.slimItems.size, park.resets], [1, true, 3, 0]);
});

test("CCP ticker test_stopball: an order for the tick the park is at is applied at once", () => {
  const { park, ball } = ccpTicker();
  park.flushState([[TICKS_ELAPSED + 1, ["Stop", [2]]]], false);
  park.doPreTick();
  park.doPostTick(TICKS_ELAPSED);
  assert.equal(ball(2).mode, MODE.STOP);
});

test("CCP ticker test_future_state_gets_applied_at_correct_time: an order one tick ahead waits for its tick", () => {
  const { park, tick, ball } = ccpTicker();
  park.flushState([[TICKS_ELAPSED + 2, ["Stop", [2]]]], false);
  tick(TICKS_ELAPSED + 1);
  assert.equal(ball(2).mode, MODE.ORBIT);
  tick(TICKS_ELAPSED + 2);
  assert.equal(ball(2).mode, MODE.STOP);
});

test("CCP ticker test_late_arrival: an order for a tick already past is still applied", () => {
  const { park, tick, ball } = ccpTicker();
  tick(TICKS_ELAPSED + 1);
  tick(TICKS_ELAPSED + 2);
  assert.equal(ball(2).mode, MODE.ORBIT);
  park.flushState([[TICKS_ELAPSED + 2, ["Stop", [2]]]], false);
  tick(TICKS_ELAPSED + 3);
  assert.equal(ball(2).mode, MODE.STOP);
});

test("CCP ticker: the park cannot go back to before its first snapshot", () => {
  const { park } = ccpTicker();
  assert.equal(park.synchroniseToSimulationTime(TICKS_ELAPSED - 1), false);
});

test("CCP ticker: going back a tick restores a ball removed since", () => {
  const { park, tick } = ccpTicker();
  tick(TICKS_ELAPSED + 1);
  park.ballpark.removeBall(1);
  assert.equal(park.ballpark.ball(1), null);
  assert.equal(park.currentTime, TICKS_ELAPSED + 2);
  assert.equal(park.synchroniseToSimulationTime(TICKS_ELAPSED + 1), true);
  assert.equal(park.currentTime, TICKS_ELAPSED + 1);
  assert.notEqual(park.ballpark.ball(1), null);
});

test("CCP ticker: going back two ticks", () => {
  const { park, tick } = ccpTicker();
  tick(TICKS_ELAPSED + 1);
  park.ballpark.removeBall(1);
  tick(TICKS_ELAPSED + 2);
  assert.equal(park.currentTime, TICKS_ELAPSED + 3);
  assert.equal(park.synchroniseToSimulationTime(TICKS_ELAPSED + 1), true);
  assert.equal(park.currentTime, TICKS_ELAPSED + 1);
});

test("CCP ticker: an update handled in step reports no desync; one that cannot be synchronised to asks for a new state", () => {
  const fine = ccpTicker();
  fine.park.flushState([[TICKS_ELAPSED + 1, ["Stop", [2]]]], false);
  fine.park.doPreTick();
  assert.deepEqual([fine.park.resets, fine.park.fatalDesyncs], [0, 0]);

  let asked = 0;
  const lost = ccpTicker();
  lost.park.requestState = () => { asked += 1; };
  lost.park.flushState([[TICKS_ELAPSED + 1, ["Stop", [2]]]], false);
  lost.park.synchroniseToSimulationTime = () => false;
  lost.park.doPreTick();
  assert.deepEqual([lost.park.resets, asked, lost.park.validState, lost.park.states.length], [1, 1, false, 0]);
  assert.equal(lost.ball(2).mode, MODE.ORBIT, "and the order was not applied");
});

test("CCP ticker: an update with more than one tick in it is reported as a fatal desync, and still queued", () => {
  const { park } = ccpTicker();
  park.doDestinyUpdate([[TICKS_ELAPSED + 1, ["Stop", [2]]], [TICKS_ELAPSED + 2, ["Stop", [2]]]], false);
  assert.equal(park.fatalDesyncs, 1);
  assert.equal(park.history.length, 2);
});

// ── a real server's updates, played through ──────────────────────────────────

/**
 * Feed the recording to a park as a client would get it: each update when it
 * arrived, and a tick of the park's own for every second in between.
 */
function replay({ until = Infinity, onTick = () => {} } = {}) {
  const park = new Park();
  const updates = destinyUpdates(recording);
  let clock = updates[0].atMs; // the park starts ticking when the first update lands
  const tickTo = (atMs) => {
    while (clock + 1000 <= atMs) {
      park.tick();
      clock += 1000;
      onTick(park);
    }
  };
  for (const update of updates) {
    if (update.atMs > until) break;
    tickTo(update.atMs);
    park.doDestinyUpdate(update.entries, update.waitForBubble);
  }
  if (Number.isFinite(until)) tickTo(until);
  return { park, updates, tickOn: (seconds) => tickTo(clock + seconds * 1000) };
}

const speed = (ball) => Math.hypot(ball.newVel.x, ball.newVel.y, ball.newVel.z);

test("the recorded updates queue as the client queues them: the state supersedes what came before it", () => {
  const park = new Park();
  const updates = destinyUpdates(recording);
  const [addShip, placeShip, setState, tune, addMore] = updates;
  const stamp = setState.entries[0][0];

  // The ship alone, asking the client to wait for the rest of that tick.
  park.doDestinyUpdate(addShip.entries, addShip.waitForBubble);
  assert.deepEqual(park.history.map(([entries, wait]) => [entries.length, wait]), [[1, true]]);
  // The rest of that tick: joined to it, and no longer waiting.
  park.doDestinyUpdate(placeShip.entries, placeShip.waitForBubble);
  assert.deepEqual(park.history.map(([entries, wait]) => [entries.map(([, [name]]) => name), wait]), [
    [["AddBalls2", "OnSpecialFX", "SetBallPosition", "SetBallMassive", "SetBallMass", "SetBallVelocity", "GotoDirection"], false],
  ]);
  // A whole state for the next tick: everything queued for before it is dropped unapplied.
  park.doDestinyUpdate(setState.entries, setState.waitForBubble);
  assert.equal(park.latestSetStateTime, stamp);
  assert.deepEqual(park.history.map(([entries]) => entries.map(([at, [name]]) => `${at - stamp} ${name}`)), [["0 SetState"]]);
  // More for the state's own tick joins it; a later tick queues behind.
  park.doDestinyUpdate(tune.entries, tune.waitForBubble);
  park.doDestinyUpdate(addMore.entries, addMore.waitForBubble);
  assert.deepEqual(park.history.map(([entries]) => entries.map(([at, [name]]) => `${at - stamp} ${name}`)), [
    ["0 SetState", "0 SetBallAgility", "0 SetMaxSpeed"],
    ["2 AddBalls2"],
  ]);
  // Anything older than the state that now arrives is discarded.
  park.doDestinyUpdate([[stamp - 1, ["Stop", [recording.shipID]]]], false);
  assert.equal(park.history.length, 2);
  assert.equal(park.validState, false, "nothing is applied until the park ticks");
});

test("a state keeps what is already queued for its own tick", () => {
  const park = new Park();
  park.flushState([[50, STOP]], false);
  park.flushState([[51, GOTO_DIRECTION]], false);
  park.flushState([[51, ["SetState", [null]]]], false);
  assert.deepEqual(park.history.map(([entries]) => entries.map(([at, [name]]) => `${at} ${name}`)), [["51 GotoDirection", "51 SetState"]]);
});

test("played through, the park holds the grid the server described, and nothing failed", () => {
  const { park, tickOn } = replay();
  assert.equal(park.history.length, 1, "the last update landed after the last tick");
  tickOn(1);
  assert.deepEqual([...park.failed], [], "no entry failed");
  assert.deepEqual([park.resets, park.fatalDesyncs, park.validState, park.ego], [0, 0, true, recording.shipID]);
  assert.equal(park.ballpark.balls.size, 95);
  assert.equal(park.slimItems.size, 95);
  assert.equal(park.history.length, 0, "everything that arrived has been applied");
  const ship = park.ballpark.ball(recording.shipID);
  assert.deepEqual([ship.maxVelocity, ship.agility, ship.mass], [341, Math.fround(4.35), 1157000]);
  // The pilot's own slim item says who and what it is.
  const own = park.slimItems.get(recording.shipID);
  assert.deepEqual([own.get("typeID"), own.get("charID"), own.get("name").toString()], [588, recording.characterID, "Reaper"]);
  // Its damage is filed under the same id, though the server sent that one as a long.
  assert.equal(park.damageState.size, 46, "the state's 27, and one for each ball added after it, known or not");
  assert.deepEqual(park.damageState.get(recording.shipID).slice(1), [1, 1], "armour and hull whole");
});

test("played through, the ship flies out along its heading at its top speed, then stops when told", () => {
  const updates = destinyUpdates(recording);
  const stopAt = updates.find((update) => update.entries.some(([, [name]]) => name === "Stop")).atMs;
  const samples = [];
  const { park } = replay({ until: stopAt - 1, onTick: (p) => { const s = p.ballpark.ball(recording.shipID); if (s) samples.push({ tick: p.currentTime, mode: s.mode, speed: speed(s), pos: { ...s.newPos } }); } });
  const ship = park.ballpark.ball(recording.shipID);

  // Before the Stop: in GOTO at 341 m/s the whole way, never faster.
  assert.ok(samples.length >= 6, `${samples.length} ticks before the stop`);
  for (const sample of samples) {
    assert.equal(sample.mode, MODE.GOTO);
    assert.ok(Math.abs(sample.speed - 341) < 1e-6, `tick ${sample.tick}: ${sample.speed} m/s`);
  }
  // Along the heading the server gave when it sent the ship off.
  const direction = updates[1].entries.find(([, [name]]) => name === "GotoDirection")[1][1].slice(1);
  const [first, last] = [samples[0], samples.at(-1)];
  const travelled = [last.pos.x - first.pos.x, last.pos.y - first.pos.y, last.pos.z - first.pos.z];
  const distance = Math.hypot(...travelled);
  assert.ok(Math.abs(distance - 341 * (samples.length - 1)) < 0.01, `${distance} m in ${samples.length - 1} ticks`);
  for (const [index, component] of travelled.entries()) assert.ok(Math.abs(component / distance - direction[index]) < 1e-6);
  assert.equal(ship.mode, MODE.GOTO);
});

test("played through, the Stop takes effect at the tick it is stamped for and the ship coasts down", () => {
  const speeds = [];
  const { park, tickOn } = replay({ onTick: (p) => { const s = p.ballpark.ball(recording.shipID); if (s) speeds.push([p.currentTime, s.mode, speed(s)]); } });
  tickOn(20);
  const ship = park.ballpark.ball(recording.shipID);
  assert.equal(ship.mode, MODE.STOP);
  const stopStamp = destinyUpdates(recording).flatMap((update) => update.entries).find(([, [name]]) => name === "Stop")[0];
  // Up to its stamp the ship is still flying; from the tick after, slowing every tick.
  const before = speeds.filter(([tick]) => tick <= stopStamp);
  const after = speeds.filter(([tick]) => tick > stopStamp);
  assert.ok(before.length > 0 && before.every(([, mode]) => mode === MODE.GOTO), "flying until the stamp");
  assert.ok(after.length >= 20 && after.every(([, mode]) => mode === MODE.STOP));
  for (let index = 1; index < after.length; index += 1) assert.ok(after[index][2] < after[index - 1][2], "slower each tick");
  // It loses a fixed share of its speed each tick: exp(-k*dt/(mass*agility)).
  const factor = Math.exp((-1000000.0 * 1.0) / (1157000 * Math.fround(4.35)));
  assert.ok(Math.abs(after[5][2] / after[4][2] - factor) < 1e-9);
  assert.ok(speed(ship) < 341 * factor ** 20 * 1.01);
});

test("a group that begins with a special effect is applied without losing the park's place", () => {
  // The decompiled RealFlushState reads as if this reset the park. It does not.
  const { park, tickOn } = replay();
  tickOn(1);
  const before = park.currentTime;
  const applied = [];
  park.onEvent = (name) => applied.push(name);
  park.doDestinyUpdate([[before, ["OnSpecialFX", [recording.shipID, null, null, null, null, "effects.Uncloak", 0, 1, 0]]], [before, ["SetBallMassive", [recording.shipID, 1]]]], false);
  park.doPreTick();
  assert.deepEqual([park.resets, applied, park.ballpark.ball(recording.shipID).isMassive], [0, ["OnSpecialFX", "SetBallMassive"], true]);
});

// ── the rules of time, beyond CCP's cases ────────────────────────────────────

/** A park with one free ball, its state valid at tick 100. */
function simplePark() {
  const source = new Ballpark();
  source.addBall({ id: 1, isFree: true, mass: 1e6, radius: 10, maxVelocity: 100, agility: 1, speedFraction: 1 });
  source.addBall({ id: 2, isFree: true, mass: 1e6, radius: 10, maxVelocity: 100, agility: 1, speedFraction: 1, x: 5000 });
  source.currentTime = 100;
  const park = new Park();
  park.flushState([[100, ["SetState", [bag(source.writeState(), 1, [slim(1), slim(2)])]]]], false);
  park.doPreTick();
  return park;
}

test("an update one or two ticks ahead waits; three ahead, the park is stepped up to it", () => {
  for (const ahead of [1, 2]) {
    const park = simplePark();
    park.flushState([[100 + ahead, ["GotoDirection", [1, 1, 0, 0]]]], false);
    park.doPreTick();
    assert.deepEqual([park.currentTime, park.ballpark.ball(1).mode, park.history.length], [100, MODE.STOP, 1], `${ahead} ahead waits`);
  }
  const park = simplePark();
  park.flushState([[103, ["GotoDirection", [1, 1, 0, 0]]]], false);
  park.doPreTick();
  assert.deepEqual([park.currentTime, park.ballpark.ball(1).mode, park.history.length], [103, MODE.GOTO, 0]);
});

test("an update for a tick already past takes the park back to it, and the park stays there", () => {
  const park = simplePark();
  for (let i = 0; i < 4; i += 1) park.tick();
  assert.equal(park.currentTime, 104);
  park.flushState([[102, ["GotoDirection", [1, 1, 0, 0]]]], false);
  park.doPreTick();
  assert.equal(park.currentTime, 102, "back at the update's tick, not stepped forward again");
  assert.equal(park.ballpark.ball(1).mode, MODE.GOTO);
  assert.deepEqual(park.ballpark.ball(1).newPos, { x: 0, y: 0, z: 0 }, "and the order starts from where the ball was then");
});

test("going back to a tick an order was applied in keeps that order", () => {
  const park = simplePark();
  park.tick();
  park.flushState([[101, ["GotoDirection", [2, 0, 1, 0]]]], false);
  park.tick(); // applied at 101, then stepped to 102
  park.tick();
  assert.deepEqual([park.currentTime, park.ballpark.ball(2).mode], [103, MODE.GOTO]);
  // A straggler for 101: the park goes back to the snapshot it took in the middle of that tick, order and all.
  park.flushState([[101, ["SetBallMassive", [1, 1]]]], false);
  park.doPreTick();
  assert.deepEqual([park.currentTime, park.ballpark.ball(2).mode, park.ballpark.ball(1).isMassive, park.resets], [101, MODE.GOTO, true, 0]);
  assert.deepEqual(park.ballpark.ball(2).newPos, { x: 5000, y: 0, z: 0 }, "and ball 2 is where it was when the order came");
});

test("an update from before the last order applied cannot be reached: the park asks for the whole state again", () => {
  // The step after an order drops every older snapshot, so there is nothing to go back to.
  let asked = 0;
  const park = simplePark();
  park.requestState = () => { asked += 1; };
  park.tick();
  park.flushState([[101, ["GotoDirection", [2, 0, 1, 0]]]], false);
  park.tick();
  park.tick();
  const seen = [];
  park.onEvent = (name) => seen.push(name);
  park.flushState([[100, ["SetBallMassive", [1, 1]]], [100, ["SetBallMassive", [2, 1]]]], false);
  park.doPreTick();
  assert.deepEqual([park.resets, asked, park.validState, park.states.length, park.currentTime, seen], [1, 1, false, 0, 103, []]);
  // From then on updates are dropped until a state arrives.
  park.flushState([[103, ["Stop", [2]]]], false);
  park.doPreTick();
  assert.deepEqual([park.ballpark.ball(2).mode, park.history.length], [MODE.GOTO, 0]);
});

test("a group still waiting for its bubble blocks the queue until the rest of its tick arrives", () => {
  const park = simplePark();
  park.flushState([[100, ["GotoDirection", [1, 1, 0, 0]]]], true);
  park.flushState([[101, ["Stop", [1]]]], false);
  park.doPreTick();
  assert.deepEqual([park.ballpark.ball(1).mode, park.history.length], [MODE.STOP, 2], "nothing applied");
  park.flushState([[100, ["SetBallMassive", [1, 1]]]], false);
  park.doPreTick();
  assert.deepEqual([park.ballpark.ball(1).mode, park.ballpark.ball(1).isMassive, park.history.length], [MODE.GOTO, true, 1]);
});

test("after one group, the next is not applied in the same breath unless more are queued behind it", () => {
  // DoPreTick steps the park between groups only when more than one is still queued.
  const park = simplePark();
  park.flushState([[100, ["SetBallMassive", [1, 1]]]], false);
  park.flushState([[101, ["SetBallMassive", [2, 1]]]], false);
  park.flushState([[102, ["GotoDirection", [1, 1, 0, 0]]]], false);
  park.doPreTick();
  // 100 applied; two still queued, so the park steps to 101 and applies it; then one is left, one ahead: it waits.
  assert.deepEqual([park.currentTime, park.ballpark.ball(2).isMassive, park.ballpark.ball(1).mode, park.history.length], [101, true, MODE.STOP, 1]);
});

test("the park is not stepped on to a group that is still waiting for its bubble", () => {
  const park = simplePark();
  park.flushState([[101, ["SetBallMassive", [2, 1]]]], true);
  park.flushState([[100, ["SetBallMassive", [1, 1]]]], false);
  park.flushState([[102, ["GotoDirection", [1, 1, 0, 0]]]], false);
  assert.deepEqual(park.history.map(([, wait]) => wait), [false, true, false]);
  park.doPreTick();
  assert.deepEqual([park.currentTime, park.ballpark.ball(1).isMassive, park.ballpark.ball(2).isMassive, park.history.length], [100, true, false, 2]);
});

test("a group of entries that are not the simulation's leaves no mark, even after one that was", () => {
  // RealFlushState forgets "this tick changed things" at the start of every group.
  const park = simplePark();
  const damage = [[1, 1, 1], 1, 1];
  park.flushState([[100, ["GotoDirection", [1, 1, 0, 0]]]], false);
  park.flushState([[101, ["OnDamageStateChange", [1, damage]]]], false);
  park.flushState([[102, ["OnDamageStateChange", [2, damage]]]], false);
  park.doPreTick();
  assert.deepEqual([park.currentTime, park.shouldRebase, park.history.length], [101, false, 1]);
  assert.deepEqual(park.states.map(([, tick, mid]) => `${tick}${mid ? "m" : ""}`), ["100", "100m"]);
});

test("until a state arrives, updates are dropped; a state makes the park valid", () => {
  const park = new Park();
  park.flushState([[50, ["GotoDirection", [1, 1, 0, 0]]]], false);
  park.doPreTick();
  assert.deepEqual([park.validState, park.history.length, park.ballpark.balls.size, park.currentTime], [false, 0, 0, 0], "ignored and gone, and the park not stepped to it");
  // And however long it ticks, it keeps no snapshot of a park it does not have.
  for (let i = 0; i < 25; i += 1) park.tick();
  assert.deepEqual([park.states.length, park.isRunning], [0, false]);
  const ticked = park.currentTime;
  // A SetState anywhere but first in its group is skipped.
  const source = new Ballpark();
  source.addBall({ id: 1 });
  park.flushState([[ticked, ["GotoDirection", [1, 1, 0, 0]]], [ticked, ["SetState", [bag(source.writeState(), 1, [slim(1)])]]]], false);
  park.doPreTick();
  assert.deepEqual([park.validState, park.history.length], [false, 0]);
});

test("a second state replaces the first: balls, slim items, damage, whose ship, and the snapshots", () => {
  const park = simplePark();
  park.flushState([[100, ["GotoDirection", [1, 1, 0, 0]]], [100, ["OnDamageStateChange", [1, [[1, 1, 1], 1, 1]]]]], false);
  park.doPreTick();
  assert.deepEqual(park.states.map(([, tick, mid]) => `${tick}${mid ? "m" : ""}`), ["100", "100m"]);
  const other = new Ballpark();
  other.addBall({ id: 5, isFree: true, mass: 1e6 });
  other.currentTime = 100;
  const state = keyVal([["state", other.writeState()], ["ego", 5n], ["slims", { type: "list", items: [slim(5)] }], ["damageState", { type: "dict", entries: [[5n, [[0, 0, 0], 0.25, 1]]] }], ["solItem", slim(30000142)]]);
  park.flushState([[100, ["SetState", [state]]]], false);
  park.doPreTick();
  assert.deepEqual([[...park.ballpark.balls.keys()], [...park.slimItems.keys()], [...park.damageState], park.ego], [[5], [5], [[5, [[0, 0, 0], 0.25, 1]]], 5]);
  assert.deepEqual(park.states.map(([, tick, mid]) => `${tick}${mid ? "m" : ""}`), ["100"], "the snapshot from the middle of the old park's tick is not carried over");
  assert.equal(new Map(park.solItem.entries).get("itemID"), 30000142);
});

test("a state whose slim items name a ball that is not in it is refused", () => {
  const source = new Ballpark();
  source.addBall({ id: 1 });
  const park = new Park();
  park.flushState([[10, ["SetState", [bag(source.writeState(), 1, [slim(1), slim(2)])]]]], false);
  assert.throws(() => park.doPreTick(), /BallNotInPark 2/);
});

test("snapshots: one when a state is read, one in the middle of a tick that changed things, one after it, and one every eleventh quiet tick", () => {
  const park = simplePark();
  const kept = () => park.states.map(([, tick, mid]) => `${tick}${mid ? "m" : ""}`);
  assert.deepEqual(kept(), ["100"]);
  // Quiet ticks: nothing until the eleventh.
  for (let i = 0; i < 10; i += 1) park.tick();
  assert.deepEqual(kept(), ["100"]);
  park.tick();
  assert.deepEqual(kept(), ["100", "111"]);
  // A tick with an order: a mid-tick snapshot at the order's tick, then the history is rebased after the step.
  park.flushState([[111, ["GotoDirection", [1, 1, 0, 0]]]], false);
  park.doPreTick();
  assert.deepEqual(kept(), ["100", "111", "111m"]);
  park.ballpark.evolve();
  park.doPostTick(park.currentTime);
  assert.deepEqual(kept(), ["111m", "112"], "the mid-tick one from the tick before is kept, and a new base taken");
  assert.equal(park.shouldRebase, false);
});

test("snapshots: only one taken in the middle of the tick before is carried over a new base", () => {
  const park = simplePark();
  const kept = () => park.states.map(([, tick, mid]) => `${tick}${mid ? "m" : ""}`);
  // An ordinary snapshot of the tick before is not.
  park.ballpark.evolve();
  park.flushSimulationHistory();
  assert.deepEqual(kept(), ["101"]);
  // Nor a mid-tick one from longer ago.
  park.storeState(true);
  park.ballpark.evolve();
  park.ballpark.evolve();
  park.flushSimulationHistory();
  assert.deepEqual(kept(), ["103"]);
  park.storeState(true);
  park.ballpark.evolve();
  park.flushSimulationHistory();
  assert.deepEqual(kept(), ["103m", "104"]);
  // And asked for no new base, nothing is kept at all.
  park.flushSimulationHistory(false);
  assert.deepEqual(kept(), []);
});

test("a tick first lets go of the balls whose time is up", () => {
  const park = simplePark();
  park.ballpark.removeBall(2, 2); // an explosion two ticks long
  park.tick();
  assert.equal(park.ballpark.moribundBalls.size, 1);
  park.tick();
  park.tick();
  assert.equal(park.ballpark.moribundBalls.size, 0);
});

test("snapshots: no more than the oldest and the newest five are kept", () => {
  const park = simplePark();
  const store = (times) => {
    for (let i = 0; i < times; i += 1) {
      park.ballpark.evolve();
      park.storeState();
    }
    return park.states.map(([, tick]) => tick);
  };
  assert.deepEqual(store(9), [100, 101, 102, 103, 104, 105, 106, 107, 108, 109], "ten are kept");
  assert.deepEqual(store(1), [100, 106, 107, 108, 109, 110], "the eleventh cuts them to the oldest and the newest five");
  assert.deepEqual(store(2), [100, 106, 107, 108, 109, 110, 111, 112]);
  assert.equal(park.lastStamp, 112);
});

test("an entry that is not part of the simulation neither moves the park nor marks the tick as changed", () => {
  const park = simplePark();
  park.flushState([[105, ["OnDamageStateChange", [1, [[0.5, 1, 2], 0.8, 0.9]]]]], false);
  park.doPreTick();
  assert.deepEqual([park.currentTime, park.shouldRebase, park.states.length], [100, false, 1], "three ticks ahead, yet no stepping and no snapshot");
  assert.deepEqual(park.damageState.get(1), [[0.5, 1, 2], 0.8, 0.9]);
});

test("an entry that fails does not stop the ones after it, and is counted by name", () => {
  const park = simplePark();
  const told = [];
  park.onFail = (name, error) => told.push([name, error.message]);
  park.flushState([[100, ["AddMushroom", [1, 2, 3, 4]]], [100, ["NoSuchThing", [1]]], [100, ["GotoDirection", [1, 1, 0, 0]]]], false);
  park.doPreTick();
  assert.deepEqual([...park.failed].sort(), [["AddMushroom", 1], ["NoSuchThing", 1]]);
  assert.equal(park.ballpark.ball(1).mode, MODE.GOTO);
  // Whoever keeps the park is told which and why, as the client's log is.
  assert.deepEqual(told, [["AddMushroom", "AddMushroom cannot be applied"], ["NoSuchThing", "NoSuchThing cannot be applied"]]);
  park.doDestinyUpdate([[100, ["PackagedAction", Buffer.from("not marshal")]]], false);
  assert.equal(told.at(-1)[0], "PackagedAction");
});

test("orders reach the simulation with the client's defaults and conversions", () => {
  const park = simplePark();
  const ball = (id) => park.ballpark.ball(id);
  const apply = (...entries) => { park.flushState(entries.map((entry) => [park.currentTime, entry]), false); park.doPreTick(); };
  // An id that arrives as a Python long names the same ball.
  apply(["FollowBall", [1n, 2n]]);
  assert.deepEqual([ball(1).mode, ball(1).followId, ball(1).followRange], [MODE.FOLLOW, 2, 1], "the range defaults to 1.0");
  apply(["Orbit", [1, 2, 7500.5]]);
  assert.deepEqual([ball(1).mode, ball(1).followRange], [MODE.ORBIT, Math.fround(7500.5)]);
  apply(["Orbit", [1, 2]]);
  assert.deepEqual([ball(1).mode, ball(1).followRange], [MODE.ORBIT, 1], "and so does an orbit's");
  apply(["GotoPoint", [1, 100, 200, 300]]);
  assert.deepEqual([ball(1).mode, ball(1).goto], [MODE.GOTO, { x: 100, y: 200, z: 300 }]);
  apply(["Stop", [1]], ["SetSpeedFraction", [1, 0.5]], ["SetBallMass", [1, 2e6]], ["SetBallAgility", [1, 3.25]], ["SetMaxSpeed", [1, 250]], ["SetBallRadius", [1, 40]]);
  assert.deepEqual([ball(1).mode, ball(1).speedFraction, ball(1).mass, ball(1).agility, ball(1).maxVelocity, ball(1).radius], [MODE.STOP, 0.5, 2e6, 3.25, 250, 40]);
  apply(["SetBallPosition", [1, 1, 2, 3]], ["SetBallVelocity", [1, 4, 5, 6]], ["SetBallMassive", [1, 1]], ["SetBallGlobal", [1, 1]], ["SetBallInteractive", [1, 1]]);
  assert.deepEqual([ball(1).newPos, ball(1).newVel, ball(1).isMassive, ball(1).isGlobal, ball(1).isInteractive], [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }, true, true, true]);
  apply(["SetBallHarmonic", [1, 77n, 98000001, 99000001, 1]]);
  assert.deepEqual([ball(1).mode, ball(1).harmonic, ball(1).corporationID, ball(1).allianceID], [MODE.FIELD, 77, 98000001, 99000001]);
  apply(["SetBallHarmonic", [1, -1, -1, -1, 0]]);
  assert.equal(ball(1).mode, MODE.STOP, "no longer a field: stopped");
  apply(["SetBallRigid", [1]]);
  assert.equal(ball(1).mode, MODE.RIGID);
  apply(["SetBallFree", [2, 0]]);
  assert.equal(park.ballpark.freeBalls.has(2), false);
  assert.deepEqual([...park.failed], []);
  // The engine refuses to follow or orbit a negative id; the entry fails and the ball carries on as it was.
  apply(["SetBallFree", [1, 1]], ["GotoDirection", [1, 1, 0, 0]], ["FollowBall", [1, -3]], ["Orbit", [1, -3]]);
  assert.deepEqual([ball(1).mode, [...park.failed].sort()], [MODE.GOTO, [["FollowBall", 1], ["Orbit", 1]]]);
});

test("a missile launched by an entry flies after its target, and the park goes on stepping around it", () => {
  const park = simplePark();
  const ball = (id) => park.ballpark.ball(id);
  const apply = (...entries) => { park.flushState(entries.map((entry) => [park.currentTime, entry]), false); park.doPreTick(); };
  // The server adds the missile ball, then launches it: (missile, target, launcher, aimed, massive), as Python longs and ints.
  park.ballpark.addBall({ id: 3, isFree: true, mass: 1e4, radius: 5, maxVelocity: 3000, agility: 0.01, speedFraction: 1, x: 900 });
  apply(["LaunchMissile", [3n, 2n, 1n, 1, 1]]);
  assert.deepEqual([...park.failed], []);
  assert.deepEqual([ball(3).mode, ball(3).followId, ball(3).ownerId, ball(3).isMassive, ball(3).newPos, ball(3).newVel], [MODE.MISSILE, 2, 1, true, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]);
  // The step that froze every companion's picture of the grid when a missile was in it.
  const time = park.currentTime;
  for (let tick = 0; tick < 3; tick += 1) park.tick();
  assert.equal(park.currentTime, time + 3);
  assert.ok(ball(3).newPos.x > 0);
  // Five arguments, none optional, and no launch at a negative id: either way the entry fails and nothing moves.
  apply(["LaunchMissile", [1, 2, 3, 1]], ["LaunchMissile", [1, -2, 3, 1, 1]]);
  assert.deepEqual([...park.failed], [["LaunchMissile", 2]]);
});

test("the warp orders reach the simulation, with the engine's defaults and its refusal of a fractional warp factor", () => {
  const park = simplePark();
  const ball = (id) => park.ballpark.ball(id);
  const apply = (...entries) => { park.flushState(entries.map((entry) => [park.currentTime, entry]), false); park.doPreTick(); };
  apply(["WarpTo", [1n, 1e9, 2e9, 3e9, 15000.5, 3000]]);
  assert.deepEqual([ball(1).mode, ball(1).goto, ball(1).effectStamp, ball(1).warpMinRange, ball(1).ownerId], [MODE.WARP, { x: 1e9, y: 2e9, z: 3e9 }, -1, 15000.5, 3000]);
  apply(["WarpTo", [1, 4e9, 0, 0]]);
  assert.deepEqual([ball(1).goto.x, ball(1).warpMinRange, ball(1).ownerId], [4e9, 20000, 20], "stopping 20 km short at warp factor 20 unless told");
  apply(["EntityWarpIn", [2, 3e11, 4e11, 0, 4500]]);
  assert.deepEqual([ball(2).mode, ball(2).effectStamp, ball(2).ownerId, ball(2).isMassive], [MODE.WARP, 95, 4500, false]);
  assert.deepEqual([...park.failed], []);
  // The engine takes the warp factor as a whole number; given anything else the entry fails and nothing changes.
  apply(["WarpTo", [1, 5e9, 0, 0, 0, 3000.5]], ["EntityWarpIn", [2, 1e11, 0, 0, 4500.5]], ["EntityWarpIn", [2, 1e11, 0, 0]]);
  assert.deepEqual([ball(1).goto.x, ball(2).goto.x, [...park.failed]], [4e9, 3e11, [["WarpTo", 1], ["EntityWarpIn", 2]]]);
});

test("a warp flown through the park's ticks, and gone back into", () => {
  const park = simplePark();
  const posted = [];
  park.ballpark.onPost = (...event) => posted.push(event);
  const ship = park.ballpark.ball(1);
  park.flushState([[100, ["SetBallVelocity", [1, 90, 0, 0]]], [100, ["WarpTo", [1, 3e11, 0, 0, 10000, 3000]]]], false);
  park.tick(); // applied at 100; lined up and fast enough, so the warp proper begins in that same step
  assert.deepEqual([ship.mode, ship.effectStamp, ship.isMassive, posted], [MODE.WARP, 100, false, [["OnActivatingWarp", 1, 100]]]);
  const track = new Map();
  for (let i = 0; i < 12; i += 1) {
    park.tick();
    track.set(park.currentTime, { ...park.ballpark.ball(1).newPos });
  }
  assert.ok(track.get(113).x > 1e11, "well on its way");
  // A late update for tick 108: the park goes back to a snapshot and steps up to it. The warp is placed by its clock, so it is where it was.
  park.flushState([[108, ["SetBallMassive", [2, 1]]]], false);
  park.doPreTick();
  const again = park.ballpark.ball(1);
  assert.deepEqual([park.currentTime, again.mode, again.effectStamp, park.resets], [108, MODE.WARP, 100, 0]);
  assert.deepEqual(again.newPos, track.get(108));
  // And from there it flies the same warp to its end.
  let ticks = 0;
  while (park.ballpark.ball(1).mode === MODE.WARP && ticks < 200) {
    park.tick();
    ticks += 1;
    if (track.has(park.currentTime) && park.ballpark.ball(1).mode === MODE.WARP) assert.deepEqual(park.ballpark.ball(1).newPos, track.get(park.currentTime));
  }
  const out = park.ballpark.ball(1);
  assert.deepEqual([out.mode, out.isMassive], [MODE.STOP, true]);
  assert.ok(Math.abs(out.newPos.x - (3e11 - 10000)) < 200, `${3e11 - 10000 - out.newPos.x} m short of 10 km short`);
  assert.deepEqual(posted.slice(-2).map(([name]) => name), ["OnDeactivatingWarp", "OnExitWarp"]);
});

test("a ball told to drift for a while turns to stone when its time comes", () => {
  const park = simplePark();
  park.flushState([[100, ["SetBallVelocity", [2, 50, 0, 0]]], [100, ["SetBallTroll", [2, 3]]]], false);
  park.doPreTick();
  const wreck = park.ballpark.ball(2);
  assert.deepEqual([wreck.mode, wreck.effectStamp, wreck.isFree, wreck.isInteractive], [MODE.TROLL, 103, true, true]);
  park.ballpark.evolve(); // 100 -> 101
  park.ballpark.evolve();
  park.ballpark.evolve();
  assert.equal(wreck.mode, MODE.TROLL, "still drifting: its stamp is not yet behind the tick being stepped");
  assert.ok(wreck.newPos.x > 5000);
  park.ballpark.evolve(); // the step taken at tick 103
  assert.deepEqual([wreck.mode, wreck.isFree, wreck.isInteractive, wreck.newVel], [MODE.RIGID, false, false, { x: 0, y: 0, z: 0 }]);
});

test("a ball that cloaks is removed from the park, unless it is the pilot's own", () => {
  const park = simplePark();
  park.flushState([[100, ["CloakBall", [2, 1]]], [100, ["CloakBall", [1, 1]]]], false);
  park.doPreTick();
  assert.equal(park.ballpark.ball(2), null);
  assert.equal(park.slimItems.has(2), false);
  const own = park.ballpark.ball(1);
  assert.deepEqual([own.isCloaked, own.isMassive], [1, false]);
  park.flushState([[100, ["UncloakBall", [1]]]], false);
  park.doPreTick();
  assert.deepEqual([own.isCloaked, own.isMassive], [0, true]);
});

test("balls are added with their slim items and damage, and removed with them", () => {
  const park = simplePark();
  const extra = new Ballpark();
  extra.addBall({ id: 7, isFree: true, mass: 1e6, x: 9000 });
  extra.addBall({ id: 8, x: 9500 });
  extra.currentTime = 100;
  // AddBalls2: a (slim, damage) pair, and a slim alone.
  park.flushState([[100, ["AddBalls2", [[extra.writeState([7, 8]), { type: "list", items: [[slim(7, [["typeID", 588]]), [[1, 2, 3], 1, 1]], slim(8)] }]]]]], false);
  park.doPreTick();
  assert.deepEqual([park.ballpark.balls.size, park.slimItems.get(7).get("typeID"), park.damageState.get(7), park.damageState.get(8)], [4, 588, [[1, 2, 3], 1, 1], null]);
  // AddBalls, the older form: (state, slims, damage by id).
  const more = new Ballpark();
  more.addBall({ id: 9, x: 12000 });
  more.currentTime = 100;
  park.flushState([[100, ["AddBalls", [[more.writeState([9]), { type: "list", items: [slim(9)] }, { type: "dict", entries: [[9, [[0, 0, 0], 0.5, 0.5]]] }]]]]], false);
  park.doPreTick();
  assert.deepEqual([park.ballpark.balls.size, park.damageState.get(9)], [5, [[0, 0, 0], 0.5, 0.5]]);
  assert.deepEqual([...park.ballpark.freeBalls.keys()].sort(), [1, 2, 7], "and the balls already here are still stepped");
  // A slim item already known is not replaced, by either form.
  park.flushState([[100, ["AddBalls2", [[extra.writeState([7]), { type: "list", items: [slim(7, [["typeID", 999]])] }]]]]], false);
  park.flushState([[100, ["AddBalls", [[more.writeState([9]), { type: "list", items: [slim(9, [["typeID", 999]])] }, { type: "dict", entries: [] }]]]]], false);
  park.doPreTick();
  assert.deepEqual([park.slimItems.get(7).get("typeID"), park.slimItems.get(9).get("typeID")], [588, undefined]);

  const gone = [];
  park.onBallsRemoved = (list) => gone.push(list.map(({ id, slim: item, terminal }) => [id, item.get("itemID"), terminal]));
  park.flushState([[100, ["TerminalPlayDestructionEffect", [7, 3]]], [100, ["RemoveBalls", [{ type: "list", items: [7, 8, 404, -5] }]]], [100, ["RemoveBall", [9]]]], false);
  park.doPreTick();
  assert.deepEqual([park.ballpark.balls.size, park.slimItems.size, park.damageState.has(7), park.damageState.has(9), park.destructionEffects.size], [2, 2, false, false, 0]);
  assert.deepEqual(gone, [[[7, 7, true], [8, 8, false]], [[9, 9, false]]], "told once per entry, with which of them blew up");
  assert.deepEqual([...park.failed], []);
});

test("a ball is known to be destroyed even when the entry saying so comes after its removal", () => {
  const park = simplePark();
  const gone = [];
  park.onBallsRemoved = (list) => gone.push(...list.map(({ id, terminal }) => [id, terminal]));
  // No effect named: an explosion. And one for a ball that is not here is not kept.
  park.flushState([[100, ["RemoveBalls", [[2]]]], [100, ["TerminalPlayDestructionEffect", [2, null]]], [100, ["TerminalPlayDestructionEffect", [404, 3]]]], false);
  park.doPreTick();
  assert.deepEqual([gone, park.ballpark.ball(2), park.destructionEffects.size], [[[2, true]], null, 0]);
  // A ball the park holds no slim item for goes without anyone being told.
  park.ballpark.addBall({ id: 30 });
  park.ballpark.addBall({ id: 31 });
  let told = 0;
  park.onBallsRemoved = (list) => { told += list.length; };
  park.flushState([[100, ["RemoveBalls", [[30]]]], [100, ["RemoveBall", [31]]]], false);
  park.doPreTick();
  assert.deepEqual([told, park.ballpark.ball(30), park.ballpark.ball(31)], [0, null, null]);
  park.onBallsRemoved = (list) => gone.push(...list.map(({ id, terminal }) => [id, terminal]));
  // An effect of "none" is not a destruction.
  park.flushState([[100, ["TerminalPlayDestructionEffect", [1, 0]]], [100, ["RemoveBalls", [[1]]]]], false);
  park.doPreTick();
  assert.deepEqual(gone, [[2, true], [1, false]]);
  assert.deepEqual([...park.failed], []);
});

test("an update's names and ids arrive as the wire decodes them", () => {
  const park = simplePark();
  // Byte strings for names, a list object for the entries, a Python long for the id.
  park.doDestinyUpdate({ type: "list", items: [[100, [Buffer.from("GotoDirection"), [1n, 1, 0, 0]]]] }, false);
  park.doPreTick();
  assert.equal(park.ballpark.ball(1).mode, MODE.GOTO);
  park.doDestinyUpdate([], false); // an empty update is nothing
  assert.deepEqual([park.history.length, park.fatalDesyncs], [0, 0]);
});

test("a packaged action is unpacked where it stands; one that cannot be read is left out", () => {
  const park = simplePark();
  const packaged = marshalEncode({ type: "list", items: [[100, ["SetBallMassive", [1, 1]]], [100, ["GotoDirection", [2, 0, 1, 0]]]] });
  const seen = [];
  park.onEvent = (name) => seen.push(name);
  park.doDestinyUpdate([[100, ["SetBallMassive", [2, 1]]], [100, ["PackagedAction", packaged]], [100, ["PackagedAction", Buffer.from("not marshal")]], [100, ["Stop", [1]]]], false);
  park.doPreTick();
  assert.deepEqual(seen, ["SetBallMassive", "SetBallMassive", "GotoDirection", "Stop"]);
  assert.deepEqual([park.ballpark.ball(1).isMassive, park.ballpark.ball(2).mode], [true, MODE.GOTO]);
  assert.deepEqual([...park.failed], [["PackagedAction", 1]]);
  assert.equal(park.fatalDesyncs, 0);
});

test("several updates in one notification are taken in turn, and their dogma messages passed on", () => {
  const messages = [];
  const park = simplePark();
  park.onMultiEvent = (list) => messages.push(list);
  park.doDestinyUpdates({ type: "list", items: [
    [[[100, ["SetBallMassive", [1, 1]]]], true],
    [[[100, ["GotoDirection", [1, 1, 0, 0]]]], false, { type: "list", items: [["OnModuleAttributeChanges", []]] }],
  ] });
  assert.deepEqual(park.history.map(([entries, wait]) => [entries.length, wait]), [[2, false]]);
  assert.deepEqual(messages, [[["OnModuleAttributeChanges", []]]]);
});

// ── held up to the server's own account ──────────────────────────────────────
//
// test/fixtures/destinyUndockProbed.json is the same flight, but every three
// seconds the server was asked for its whole state again (UpdateStateRequest,
// which is what the client sends when it has lost its place). Each answer says
// where the server has the ship at that tick, so the park can be compared with
// it just before it is replaced by it.
//
// These answers are not the truth to the tick, and the bounds below are loose
// for that reason. eve.js builds such a state from where its ships are at the
// moment it is asked, and stamps it with the next whole second; its own
// one-second steps begin where the system was woken, not on the stamp's
// seconds. So the state can be most of a tick behind the tick it names, or
// ahead of it, depending on when in the second the question lands. Asked every
// three seconds, as here, it lands at about the same point each time: about a
// tick behind on the first answer, and close after that. Asked every three and
// a half it swings from -1.5 ticks to +0.6. The finer truth is the server's own
// movement log (eve.js/_local/logs/space-movement-debug.log).

const probed = require("./fixtures/destinyUndockProbed.json");
const { keyValField } = require("./helpers/destinyRecording");
const { readState } = require("../src/gamePort/destiny/state");

/** Play the probed recording; at each state after the first, note the park's ship beside the server's. */
function replayProbed() {
  const park = new Park();
  const updates = destinyUpdates(probed);
  const probes = [];
  const applied = [];
  const setState = park.SetState.bind(park);
  park.SetState = (...args) => {
    setState(...args);
    const ship = park.ballpark.ball(probed.shipID);
    applied.push({ tick: park.currentTime, position: { ...ship.newPos }, velocity: { ...ship.newVel }, mode: ship.mode });
  };
  let clock = updates[0].atMs;
  const tickTo = (atMs) => {
    while (clock + 1000 <= atMs) {
      park.tick();
      clock += 1000;
    }
  };
  for (const update of updates) {
    tickTo(update.atMs);
    const [stamp, [name, args]] = update.entries[0];
    if (name === "SetState" && park.validState) {
      // The park's own ship at that tick, on a copy so the park is not disturbed.
      const copy = new Ballpark();
      copy.readState(park.ballpark.writeState(), 0);
      assert.ok(stamp >= copy.currentTime && stamp - copy.currentTime < 3, `the park is at ${copy.currentTime}, the state for ${stamp}`);
      while (copy.currentTime < stamp) copy.evolve();
      const ours = copy.ball(probed.shipID);
      const theirs = readState(keyValField(args[0], "state")).balls.find((ball) => ball.id === probed.shipID);
      probes.push({ stamp, ours: { position: { ...ours.newPos }, velocity: { ...ours.newVel }, mode: ours.mode }, theirs });
    }
    park.doDestinyUpdate(update.entries, update.waitForBubble);
  }
  tickTo(clock + 1000);
  return { park, probes, applied, updates };
}

const apart = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const size = (v) => Math.hypot(v.x, v.y, v.z);

test("asked for its state again and again, the server's answers replace the park's and nothing is lost", () => {
  const { park, probes, applied, updates } = replayProbed();
  assert.equal(probes.length, 6);
  assert.deepEqual([[...park.failed], park.resets, park.fatalDesyncs, park.history.length], [[], 0, 0, 0]);
  assert.deepEqual([park.ballpark.balls.size, park.slimItems.size, park.ego], [95, 95, probed.shipID]);
  // Each state was applied at its own stamp, and the ship put exactly where it says.
  assert.equal(applied.length, 7);
  const states = updates.filter((update) => update.entries[0][1][0] === "SetState");
  for (const [index, update] of states.entries()) {
    const theirs = readState(keyValField(update.entries[0][1][1][0], "state")).balls.find((ball) => ball.id === probed.shipID);
    assert.deepEqual(applied[index], { tick: update.entries[0][0], position: theirs.position, velocity: theirs.velocity, mode: theirs.mode });
  }
  assert.equal(park.latestSetStateTime, states.at(-1).entries[0][0]);
});

test("in flight, the park's ship has the server's velocity to the last digits, and is about a tick's travel from it at most", () => {
  const { probes } = replayProbed();
  const flying = probes.filter((probe) => probe.theirs.mode === MODE.GOTO);
  assert.equal(flying.length, 3);
  for (const { stamp, ours, theirs } of flying) {
    assert.equal(ours.mode, MODE.GOTO);
    assert.ok(apart(ours.velocity, theirs.velocity) < 1e-9, `at ${stamp}: velocity ${apart(ours.velocity, theirs.velocity)} m/s apart`);
    assert.ok(Math.abs(size(theirs.velocity) - 341) < 1e-9);
    // The two differ only in how far along the heading the ship has got, and
    // by no more than such a state can be off from the tick it names.
    const lead = apart(ours.position, theirs.position) / 341;
    assert.ok(lead < 1.1, `at ${stamp}: ${lead} ticks of travel apart`);
    const along = { x: theirs.position.x - ours.position.x, y: theirs.position.y - ours.position.y, z: theirs.position.z - ours.position.z };
    const cosine = (along.x * theirs.velocity.x + along.y * theirs.velocity.y + along.z * theirs.velocity.z) / (size(along) * 341);
    assert.ok(Math.abs(cosine) > 0.999999, `at ${stamp}: the difference lies along the heading (${cosine})`);
  }
  // Once the park has been given the server's state, three ticks later it is within a twentieth of a tick's travel of it.
  for (const { stamp, ours, theirs } of flying.slice(1)) {
    assert.ok(apart(ours.position, theirs.position) < 341 / 20, `at ${stamp}: ${apart(ours.position, theirs.position)} m apart`);
  }
});

test("stopping, the park's ship slows as the server's does, to within a tick's worth of slowing", () => {
  const { probes } = replayProbed();
  const stopping = probes.filter((probe) => probe.theirs.mode === MODE.STOP);
  assert.equal(stopping.length, 3);
  const perTick = Math.exp((-1000000.0 * 1.0) / (1157000 * Math.fround(4.35)));
  for (const { stamp, ours, theirs } of stopping) {
    assert.equal(ours.mode, MODE.STOP);
    const ratio = size(ours.velocity) / size(theirs.velocity);
    assert.ok(ratio > perTick * 0.98 && ratio < 1 / (perTick * 0.98), `at ${stamp}: ours is ${ratio} of theirs`);
    // Same heading, to the last digits: both only ever scale the velocity.
    const cosine = (ours.velocity.x * theirs.velocity.x + ours.velocity.y * theirs.velocity.y + ours.velocity.z * theirs.velocity.z) / (size(ours.velocity) * size(theirs.velocity));
    assert.ok(Math.abs(cosine - 1) < 1e-12);
  }
  // Given the server's state while slowing, three ticks later the park's speed is within one part in a hundred of it.
  for (const { stamp, ours, theirs } of stopping.slice(1)) {
    assert.ok(Math.abs(size(ours.velocity) / size(theirs.velocity) - 1) < 0.01, `at ${stamp}`);
  }
});

// ── a real warp ──────────────────────────────────────────────────────────────
//
// test/fixtures/destinyWarp.json: the pilot undocks at Jita 4-4, warps to
// Moon 6 (some 280,000 km of warp), comes to rest, warps back, and docks
// (scripts/record-warp.js). The recorder flew by this same park, live, and
// wrote down the ticks at which it saw the ship enter and leave warp. At rest
// after each warp it asked the server for its state; at rest there is no
// "which part of the second" to blur the answer, so that state is where the
// server has the ship.
//
// Between the order to warp and that state the server sends the pilot's ship
// nothing about where it is: a WarpTo, the old grid's balls removed (in a
// packaged action), the new grid's added, and a flag. The flying is the park's.

const warped = require("./fixtures/destinyWarp.json");

function replayWarp(rewrite = (stamp) => stamp) {
  const posted = [];
  const park = new Park({ ballpark: new Ballpark({ onPost: (name, id, value) => posted.push({ name, id, value, tick: park.currentTime }) }) });
  const updates = destinyUpdates(warped);
  const first = updates.find((update) => update.entries[0][1][0] === "SetState").entries[0][0];
  // `rewrite` may give an entry another stamp: (stamp counted from the first state, name) -> the same.
  for (const update of updates) update.entries = update.entries.map(([stamp, [name, args]]) => [first + rewrite(stamp - first, name), [name, args]]);
  const atRest = [];
  const grid = [];
  const flight = [];
  let clock = updates[0].atMs;
  const tickTo = (atMs) => {
    while (clock + 1000 <= atMs) {
      park.tick();
      clock += 1000;
      const ship = park.ballpark.ball(warped.shipID);
      if (ship) flight.push({ tick: park.currentTime - first, mode: ship.mode, warping: ship.mode === MODE.WARP && ship.effectStamp >= 0, speed: Math.hypot(ship.newVel.x, ship.newVel.y, ship.newVel.z), position: { ...ship.newPos }, massive: ship.isMassive, touched: [...ship.collisions], touchedAt: ship.lastCollision });
      if (grid.at(-1) !== park.ballpark.balls.size) grid.push(park.ballpark.balls.size);
    }
  };
  for (const update of updates) {
    tickTo(update.atMs);
    const [stamp, [name, args]] = update.entries[0];
    if (name === "SetState" && park.validState) {
      assert.equal(park.currentTime, stamp, "at rest the park and the state are at the same tick");
      const ours = park.ballpark.ball(warped.shipID);
      const theirs = readState(keyValField(args[0], "state")).balls.find((ball) => ball.id === warped.shipID);
      atRest.push({ stamp: stamp - first, ours: { position: { ...ours.newPos }, velocity: { ...ours.newVel }, mode: ours.mode }, theirs });
    }
    park.doDestinyUpdate(update.entries, update.waitForBubble);
  }
  tickTo(clock + 1000);
  return { park, posted: posted.map((event) => ({ ...event, tick: event.tick - first, value: event.value > first - 1e6 ? event.value - first : event.value })), atRest, grid, flight, first, updates };
}

test("a recorded warp, played through: the server's orders are the client's, and none fails", () => {
  const { park, updates, first, grid } = replayWarp();
  assert.deepEqual([[...park.failed], park.resets, park.fatalDesyncs, park.history.length], [[], 0, 0, 0]);
  // What the server sent the ship for the warp out: where to, no stopping short, and a warp factor of 3000 (3 AU a second).
  const orders = updates.flatMap((update) => update.entries).filter(([, [name]]) => name === "WarpTo").map(([stamp, [, args]]) => [stamp - first, args.length, args[4], args[5]]);
  assert.deepEqual(orders, [[6, 6, 0, 3000], [78, 6, 100076.8, 3000]]);
  // One update is a packaged action, holding the old grid's removal. Unpacked, the grid goes 95 -> 76 -> 100 on the way out.
  const names = updates.flatMap((update) => update.entries.map(([, [name]]) => name));
  assert.equal(names.filter((name) => name === "PackagedAction").length, 2);
  assert.deepEqual(grid, [76, 95, 76, 100, 76, 95]);
});

test("a recorded warp, played through: the ship lines up, warps and drops out at the ticks the live park saw", () => {
  const { posted, flight } = replayWarp();
  assert.deepEqual(posted.map(({ name, id, value, tick }) => [name, id === warped.shipID, value, tick]), [
    ["OnActivatingWarp", true, 16, 16],
    ["OnDeactivatingWarp", true, 37, 37],
    ["OnExitWarp", true, 0, 37],
    ["OnActivatingWarp", true, 85, 85],
    ["OnDeactivatingWarp", true, 106, 106],
    ["OnExitWarp", true, 0, 106],
  ]);
  // The recorder flew by a park of its own, ticked by a timer, and wrote down the same ticks.
  const first = replayWarp().first;
  assert.deepEqual(warped.warps.map((warp) => [warp.name, warp.enteredWarpAt - first, warp.leftWarpAt - first, warp.atRest]), [["out", 16, 37, true], ["back", 85, 106, true]]);
  assert.deepEqual([warped.parkFailed, warped.parkResets, warped.parkErrors], [[], 0, []]);
  // Ordered at +6: ten ticks lining up as an ordinary flight, never faster than its top speed.
  const liningUp = flight.filter((row) => row.mode === MODE.WARP && !row.warping && row.tick < 40);
  assert.deepEqual([liningUp.length, liningUp[0].tick, liningUp.at(-1).tick], [10, 7, 16]);
  assert.ok(liningUp.every((row) => row.speed <= 375.1 + 1e-9));
  // Twenty-one ticks in warp. 275,000 km is too short to reach 3 AU a second: the top speed is the capped one.
  const inWarp = flight.filter((row) => row.warping && row.tick < 40);
  assert.equal(inWarp.length, 21);
  const length = Math.hypot(inWarp.at(-1).position.x - inWarp[0].position.x, inWarp.at(-1).position.y - inWarp[0].position.y, inWarp.at(-1).position.z - inWarp[0].position.z);
  assert.ok(length > 2.7e8 && length < 2.9e8, `${length} m in warp`);
  const peak = Math.max(...inWarp.map((row) => row.speed));
  assert.ok(peak > 1e7 && peak < (length + 1e6) * 3 / 4, `peak ${peak} m/s`);
  // Out of warp under 100 m/s, and slowing from there.
  const after = flight.filter((row) => row.tick >= 38 && row.tick <= 44);
  assert.ok(after[0].speed < 100 && after.every((row, index) => row.mode === MODE.STOP && (index === 0 || row.speed < after[index - 1].speed)));
});

test("a recorded warp, played through: at rest after the warp out the park's ship is within a metre of where the server has it", () => {
  const { atRest } = replayWarp();
  assert.equal(atRest.length, 2);
  for (const { stamp, ours, theirs } of atRest) {
    assert.deepEqual([ours.mode, theirs.mode], [MODE.STOP, MODE.STOP]);
    assert.ok(size(ours.velocity) < 0.1 && size(theirs.velocity) < 0.1, `at +${stamp}: both all but still`);
  }
  // At the moon there is nothing to run into.
  assert.ok(apart(atRest[0].ours.position, atRest[0].theirs.position) < 1, `${apart(atRest[0].ours.position, atRest[0].theirs.position)} m apart after 275,000 km`);
  // The two rests are 275,000 km apart, so "within a metre" is one part in 3e8.
  assert.ok(apart(atRest[0].theirs.position, atRest[1].theirs.position) > 2.7e8);
});

// The warp back ends beside the station, which the server sends as a fixed,
// massive ball 100 km across the radius. A ball dropping out of warp makes
// itself massive (Ballpark::WarpDistance), and the server's word that the ship
// is not massive is stamped two ticks after the one it drops out in. For the
// tick between, the ship is a massive ball flying at a massive ball.
test("a recorded warp, played through: landing beside the station, the park's ship bounces off it for the one tick it is massive", () => {
  const { atRest, flight, updates, first } = replayWarp();
  const demotions = updates.flatMap((update) => update.entries).filter(([, [name]]) => name === "SetBallMassive").map(([stamp, [, args]]) => [stamp - first, args[1]]);
  assert.deepEqual(demotions.filter(([stamp]) => stamp > 0 && stamp < 144), [[37, 0], [39, 0], [106, 0], [108, 0]]);
  // Massive after the tick it drops out in and the one after, at each landing; and at the station it touches.
  assert.deepEqual(flight.filter((row) => row.massive).map((row) => row.tick), [38, 39, 107, 108]);
  assert.deepEqual(flight.filter((row) => row.touched.length).map((row) => [row.tick, row.touched]), [[108, [warped.stationID]]]);
  const bounce = flight.find((row) => row.tick === 108);
  assert.ok(bounce.touchedAt > 0.85 && bounce.touchedAt < 0.95, `touched ${bounce.touchedAt} of the way through the tick`);
  // The server's ship coasts on inside the station's ball; the park's has been turned back. They rest 413 m apart.
  const station = replayWarp().park.ballpark.ball(warped.stationID);
  const gap = (position) => apart(position, station.newPos) - station.radius - 38.400001525878906;
  assert.ok(gap(atRest[1].theirs.position) < -200 && gap(atRest[1].ours.position) > 150, `the server's ${gap(atRest[1].theirs.position)} m, the park's ${gap(atRest[1].ours.position)} m from the station's surface`);
  const between = apart(atRest[1].ours.position, atRest[1].theirs.position);
  assert.ok(between > 413 && between < 413.5, `${between} m apart`);
});

test("a recorded warp, played through: had the server's word come a tick sooner, the ship would have touched nothing", () => {
  // The same stream, with the two late "not massive" entries stamped one tick earlier: the tick after the drop.
  const { atRest, flight } = replayWarp((stamp, name) => (name === "SetBallMassive" && (stamp === 39 || stamp === 108) ? stamp - 1 : stamp));
  assert.deepEqual(flight.filter((row) => row.massive).map((row) => row.tick), [38, 107], "massive only as the tick it dropped out in ends");
  assert.deepEqual(flight.filter((row) => row.touched.length), []);
  for (const { stamp, ours, theirs } of atRest) assert.ok(apart(ours.position, theirs.position) < 1, `at +${stamp}: ${apart(ours.position, theirs.position)} m apart`);
});

test("a recorded warp, played through: the park keeps where the server last sent the pilot's own ship in warp", () => {
  const { park, updates } = replayWarp();
  const sent = updates.flatMap((update) => update.entries).filter(([, [name]]) => name === "WarpTo").map(([, [, args]]) => args);
  assert.equal(sent.length, 2);
  // The point in the last WarpTo, as the client's space service keeps it from the same call.
  assert.deepEqual(park.warpPoint, { x: Number(sent[1][1]), y: Number(sent[1][2]), z: Number(sent[1][3]) });
  assert.notDeepEqual(park.warpPoint, { x: Number(sent[0][1]), y: Number(sent[0][2]), z: Number(sent[0][3]) });
  // Another ball's warp is not the pilot's: it leaves the point alone.
  const kept = { ...park.warpPoint };
  park.ballpark.addBall({ id: 9000000000777, isFree: true, mass: 1e6, maxVelocity: 300 });
  park.doDestinyUpdate([[park.currentTime, ["WarpTo", [9000000000777, 1e12, 0, 0, 20000, 3000]]]], false);
  park.tick();
  assert.equal(park.ballpark.ball(9000000000777).mode, MODE.WARP, "the other ball was sent on its way");
  assert.deepEqual(park.warpPoint, kept);
});

// ── stepped by the clock ─────────────────────────────────────────────────────

/** A park holding the recorded undock's first state, with what the engine's driver has done to it written down. */
function clocked() {
  const park = new Park();
  const calls = [];
  for (const name of ["doPreTick", "doPostTick"]) {
    const real = park[name].bind(park);
    park[name] = (...args) => { calls.push(name); return real(...args); };
  }
  const evolve = park.ballpark.evolve.bind(park.ballpark);
  park.ballpark.evolve = () => { calls.push("evolve"); return evolve(); };
  const dead = park.ballpark.bringOutDeadBalls.bind(park.ballpark);
  park.ballpark.bringOutDeadBalls = () => { calls.push("dead"); return dead(); };
  return { park, calls };
}

test("the engine's driver: the first frame is one bare step, and after it one whole step for each second of the clock", () => {
  const { park, calls } = clocked();
  assert.deepEqual([park.time, park.firstTime], [0, true]);
  // The first frame, whatever the clock reads: the simulation is stepped and nothing else is done.
  assert.equal(park.onTick(5_000_000), 1);
  assert.deepEqual([calls.splice(0), park.time, park.firstTime, park.currentTime], [["dead", "evolve"], 5_000_000, false, 1]);
  // Less than a second on: the dead are brought out, as every frame, and no step is taken.
  assert.equal(park.onTick(5_000_999), 0);
  assert.deepEqual([calls.splice(0), park.time, park.currentTime], [["dead"], 5_000_000, 1]);
  // A second on: what is due is applied, the step taken, the snapshot seen to.
  assert.equal(park.onTick(5_001_000), 1);
  assert.deepEqual([calls.splice(0), park.time, park.currentTime], [["dead", "doPreTick", "evolve", "doPostTick"], 5_001_000, 2]);
  // What is left over of a second is kept towards the next.
  assert.equal(park.onTick(5_002_300), 1);
  assert.deepEqual([park.time, park.currentTime], [5_002_000, 3]);
  assert.equal(park.onTick(5_002_999), 0);
  assert.equal(park.onTick(5_003_000), 1);
  assert.deepEqual([park.time, park.currentTime], [5_003_000, 4]);
  calls.length = 0;
  // A client that stalled takes every step it missed at once, each a whole one; a client is not the master, which would give up past five.
  assert.equal(park.onTick(5_010_450), 7);
  assert.deepEqual([calls.filter((name) => name === "evolve").length, calls.slice(0, 4), park.time, park.currentTime], [7, ["dead", "doPreTick", "evolve", "doPostTick"], 5_010_000, 11]);
  // A clock that has not moved, or has gone back, steps nothing.
  assert.deepEqual([park.onTick(5_010_450), park.onTick(4_000_000), park.time, park.currentTime], [0, 0, 5_010_000, 11]);
});

test("the first frame waits for the clock to be a second past nothing, and tick() is a whole step without the clock", () => {
  const { park, calls } = clocked();
  assert.equal(park.onTick(999), 0);
  assert.deepEqual([park.firstTime, park.currentTime], [true, 0]);
  assert.equal(park.onTick(1000), 1);
  assert.deepEqual([park.firstTime, park.time, park.currentTime], [false, 1000, 1]);
  calls.length = 0;
  park.tick();
  assert.deepEqual([calls, park.time, park.currentTime], [["dead", "doPreTick", "evolve", "doPostTick"], 1000, 2]);
});

test("a park's times moved, and how far through its tick a park is by the clock", () => {
  const { park } = clocked();
  park.onTick(5_000_000);
  assert.deepEqual([park.fraction(5_000_000), park.fraction(5_000_250), park.fraction(5_001_000)], [0, 0.25, 1]);
  park.adjustTimes(400);
  assert.deepEqual([park.time, park.fraction(5_000_650)], [5_000_400, 0.25]);
  // The step that was a second off is now a second off from there.
  assert.deepEqual([park.onTick(5_001_399), park.onTick(5_001_400)], [0, 1]);
  park.adjustTimes(-2_000);
  assert.equal(park.time, 5_001_400 - 2_000);
  assert.equal(park.onTick(5_001_400), 2);
  // A slower park (CCP's tests run one at other intervals) counts its own interval.
  const slow = new Park({ ballpark: new Ballpark({ tickInterval: 2000 }) });
  slow.onTick(10_000);
  assert.deepEqual([slow.onTick(11_999), slow.onTick(12_000), slow.fraction(13_000)], [0, 1, 0.5]);
});

test("a recorded warp stepped by the clock a frame at a time is the same flight as one stepped a tick at a time", () => {
  const byTick = replayWarp().park;
  const park = new Park();
  const updates = destinyUpdates(warped);
  // The recording's own clock, a frame every 50 ms. The park is started when the first update lands, as replayWarp starts its own.
  let frames = 0;
  let steps = 0;
  const from = updates[0].atMs;
  let at = from;
  park.firstTime = false;
  park.time = 7_000_000;
  const frameTo = (atMs) => {
    for (; at + 50 <= atMs; at += 50) {
      steps += park.onTick(7_000_000 + (at + 50 - from));
      frames += 1;
    }
  };
  for (const update of updates) {
    frameTo(update.atMs);
    park.doDestinyUpdate(update.entries, update.waitForBubble);
  }
  frameTo(at + 1000);
  assert.ok(frames > 20 * steps - 20 && steps > 100, `${frames} frames, ${steps} steps`);
  assert.deepEqual([[...park.failed], park.resets, park.fatalDesyncs], [[], 0, 0]);
  const [ours, theirs] = [park.ballpark.ball(warped.shipID), byTick.ballpark.ball(warped.shipID)];
  assert.equal(park.currentTime, byTick.currentTime);
  assert.deepEqual([ours.newPos, ours.newVel, ours.mode], [theirs.newPos, theirs.newVel, theirs.mode]);
});

test("each step the driver takes is handed the clock's reading at the step before, and a ball keeps the last two", () => {
  // The very first step is handed the clock's reading itself.
  const early = new Park();
  early.ballpark.addBall({ id: 2, isFree: true, mass: 1e6, maxVelocity: 100 });
  early.onTick(5_000_000);
  assert.deepEqual([early.ballpark.ball(2).oldTime, early.ballpark.ball(2).newTime], [4_999_000, 5_000_000]);

  const park = new Park();
  park.onTick(5_000_000);
  park.ballpark.addBall({ id: 2, x: 0, y: 0, z: 0, vx: 4, vy: 0, vz: 0, isFree: true, mass: 1e6, maxVelocity: 100 });
  const ball = park.ballpark.ball(2);
  park.onTick(5_001_250);
  assert.deepEqual([park.time, ball.oldTime, ball.newTime], [5_001_000, 4_999_000, 5_000_000]);
  // Three steps at once: the last is handed the reading two steps on from the first.
  park.onTick(5_004_300);
  assert.deepEqual([park.time, ball.oldTime, ball.newTime], [5_004_000, 5_002_000, 5_003_000]);
  // So at the clock's reading the ball is drawn by how far through its tick the park is.
  assert.deepEqual(park.ballpark.drawn(ball, 5_004_300), park.ballpark.between(ball, park.fraction(5_004_300)));
  assert.ok(Math.abs(park.fraction(5_004_300) - 0.3) < 1e-12);
  // A rebase moves the park and its balls together: the same drawing at the moved reading.
  const expected = park.ballpark.between(ball, 0.5);
  park.adjustTimes(10_000);
  assert.deepEqual([park.time, ball.oldTime, ball.newTime], [5_014_000, 5_012_000, 5_013_000]);
  assert.deepEqual(park.ballpark.drawn(ball, 5_014_500), expected);
  // tick(), which steps without the clock, leaves a ball's times where they were.
  park.tick();
  assert.deepEqual([ball.oldTime, ball.newTime], [5_012_000, 5_013_000]);
});
