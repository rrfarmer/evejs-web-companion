"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createPilotTargets, TARGETS, TARGETERS } = require("../src/gamePort/pilotTargets");

const listOf = (...ids) => ({ type: "list", items: ids });
const notice = (method, args) => ({ method, args });
/** A list as it is kept now, or "unknown". */
const read = (targets, which = TARGETS) => { const kept = targets.read(which); return kept === undefined ? "unknown" : kept.items; };
/** Both lists answered by the server as given. */
function answered(locked = [], lockedBy = []) {
  const targets = createPilotTargets();
  assert.equal(targets.keep(TARGETS, listOf(...locked), targets.asking()), true);
  assert.equal(targets.keep(TARGETERS, listOf(...lockedBy), targets.asking()), true);
  return targets;
}

test("neither list is known until the server has answered it, and each is answered as the server would", () => {
  const targets = createPilotTargets();
  assert.deepEqual([targets.read(TARGETS), targets.read(TARGETERS)], [undefined, undefined]);
  targets.keep(TARGETS, listOf(9001, 9002), targets.asking());
  assert.deepEqual([targets.read(TARGETS), targets.read(TARGETERS)], [listOf(9001, 9002), undefined]);
  targets.keep(TARGETERS, listOf(7001), targets.asking());
  assert.deepEqual(targets.read(TARGETERS), listOf(7001));
  // What is read is not what is kept: a reader cannot change it.
  targets.read(TARGETS).items.push(1);
  assert.deepEqual(read(targets), [9001, 9002]);
  // An answer that is no list keeps nothing.
  const none = createPilotTargets();
  assert.deepEqual([none.keep(TARGETS, null, none.asking()), none.keep(TARGETS, 5, none.asking()), read(none)], [false, false, "unknown"]);
});

test("the server's word of a target is worked into what is kept, as the client's OnTarget does", () => {
  const targets = answered([9001], [7001]);
  const told = (...args) => targets.feed(notice("OnTarget", args));
  assert.equal(told(Buffer.from("add"), 9002), true);
  assert.deepEqual(read(targets), [9001, 9002]);
  // One the ship has already is not there twice, whichever way its ID came.
  told("add", 9002);
  told("add", 9002n);
  told("add", { type: "long", value: "9002" });
  assert.deepEqual(read(targets), [9001, 9002]);
  told(Buffer.from("lost"), 9001, Buffer.from("Docking"));
  assert.deepEqual(read(targets), [9002]);
  // Lost by a bigint, added by a number: the same item.
  told("lost", 9002n);
  assert.deepEqual(read(targets), []);
  // What has the ship locked is a list of its own.
  told("otheradd", 7002);
  assert.deepEqual([read(targets), read(targets, TARGETERS)], [[], [7001, 7002]]);
  told("otherlost", 7001);
  assert.deepEqual(read(targets, TARGETERS), [7002]);
  // 'clear' is of what the ship has locked, and not of what has it locked.
  told("add", 9003);
  told("clear");
  assert.deepEqual([read(targets), read(targets, TARGETERS)], [[], [7002]]);
  // Something else, or nothing that is an ID: nothing changes.
  told("somethingElse", 9009);
  told("add", null);
  told("add", 0);
  told("add", "text");
  assert.deepEqual([read(targets), read(targets, TARGETERS)], [[], [7002]]);
});

test("OnTargets is each of its entries as an OnTarget, without the time it starts with", () => {
  const targets = answered([9001]);
  assert.equal(targets.feed(notice("OnTargets", [[[133000000000000000n, Buffer.from("add"), 9002, null], [133000000000000000n, Buffer.from("lost"), 9001, Buffer.from("Exploding")]]])), true);
  assert.deepEqual(read(targets), [9002]);
  // The entries as a list off the wire.
  targets.feed(notice("OnTargets", [{ type: "list", items: [{ type: "tuple", items: [1n, "otheradd", 7001] }] }]));
  assert.deepEqual(read(targets, TARGETERS), [7001]);
});

test("a notification that is not the target service's is not taken, and one with no arguments changes nothing", () => {
  const targets = answered([9001]);
  assert.equal(targets.feed(notice("OnItemsChanged", [1, 2])), false);
  assert.equal(targets.feed({ method: "OnTarget", args: null }), false);
  assert.deepEqual(read(targets), [9001]);
});

test("the client's own doing: a lock made already is a target, and a ball that goes is none", () => {
  const targets = answered([9001], [9001]);
  targets.added(9002);
  targets.added(9002);
  assert.deepEqual(read(targets), [9001, 9002]);
  // An ID the BFF spelt as JSON, or as digits, is the number it is.
  targets.added({ type: "long", value: "9003" });
  targets.added("9004");
  assert.deepEqual(read(targets), [9001, 9002, 9003, 9004]);
  targets.feed(notice("OnTarget", ["lost", 9003]));
  targets.feed(notice("OnTarget", ["lost", 9004n]));
  assert.deepEqual(read(targets), [9001, 9002]);
  targets.ballsRemoved([9001, 5]);
  // The ball going is of what the ship has locked alone.
  assert.deepEqual([read(targets), read(targets, TARGETERS)], [[9002], [9001]]);
});

test("an OnMultiEvent's OnTarget events are worked in a moment at a time, and its other events are left alone", () => {
  const targets = answered([9001], [7001]);
  const event = (time, ...args) => [[Buffer.from("OnTarget"), ...args], time];
  const told = targets.feed(notice("OnMultiEvent", [[
    // Later moment first: what is taken is the order of the moments, whatever order they came in.
    event(20n, Buffer.from("lost"), 9002, Buffer.from("TargetingAttemptCancelled")),
    [[Buffer.from("OnGodmaShipEffect"), 9001, 2255], 10n],
    event(10n, Buffer.from("add"), 9002),
    event(10n, Buffer.from("add"), 9003),
    event(10n, Buffer.from("otheradd"), 7002),
    event(20n, Buffer.from("lost"), 9001, null),
  ]]));
  assert.equal(told, true);
  assert.deepEqual(read(targets), [9003]);
  assert.deepEqual(read(targets, TARGETERS), [7001, 7002]);

  // The same list as a destiny update's dogma messages, and a moment held on the wire as a number.
  targets.multiEvent([event(30, Buffer.from("add"), 9004)]);
  assert.deepEqual(read(targets), [9003, 9004]);
  // What is no event is passed over.
  targets.multiEvent([null, 5, [], [["OnTarget"]], event(40n, Buffer.from("add"))]);
  targets.multiEvent(null);
  assert.deepEqual(read(targets), [9003, 9004]);
});

test("a list that is not known is not made known by the server's word, a lock, or a ball going", () => {
  const targets = createPilotTargets();
  targets.feed(notice("OnTarget", ["add", 9001]));
  targets.feed(notice("OnTarget", ["clear"]));
  targets.feed(notice("OnTarget", ["otheradd", 7001]));
  targets.added(9002);
  targets.ballsRemoved([9001]);
  assert.deepEqual([read(targets), read(targets, TARGETERS)], ["unknown", "unknown"]);
});

test("an answer asked for before something changed is not kept after it", () => {
  for (const change of [
    (targets) => targets.feed(notice("OnTarget", ["add", 9005])),
    (targets) => targets.feed(notice("OnTarget", ["otherlost", 9005])),
    (targets) => targets.feed(notice("OnTargets", [[[1n, "add", 9005]]])),
    (targets) => targets.added(9005),
    (targets) => targets.ballsRemoved([9005]),
    (targets) => targets.emptied(),
    (targets) => targets.forget(),
  ]) {
    const targets = createPilotTargets();
    targets.forget();
    const asked = targets.asking();
    change(targets);
    assert.equal(targets.keep(TARGETS, listOf(9001), asked), false, String(change));
    // Asked for again after it, the answer is kept.
    assert.equal(targets.keep(TARGETS, listOf(9001), targets.asking()), true);
  }
  // A notification that is not the target service's is no change.
  const targets = createPilotTargets();
  const asked = targets.asking();
  targets.feed(notice("OnItemsChanged", [1]));
  assert.equal(targets.keep(TARGETS, listOf(9001), asked), true);
});

test("docked or the ballpark let go, both lists are empty and known; forgotten, neither is known", () => {
  const targets = answered([9001], [7001]);
  targets.emptied();
  assert.deepEqual([read(targets), read(targets, TARGETERS)], [[], []]);
  targets.feed(notice("OnTarget", ["add", 9002]));
  assert.deepEqual(read(targets), [9002]);
  targets.forget();
  assert.deepEqual([read(targets), read(targets, TARGETERS)], ["unknown", "unknown"]);
});
