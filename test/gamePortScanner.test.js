"use strict";

// The pilot's scan probes as the retail client's scan service knows them
// (src/gamePort/pilotScanner.js), and the launcher godma shows for them
// (src/gamePort/pilotDogma.js).
//
// The bytes are a real server's (test/fixtures/probeFlight.json, made by
// scripts/record-probes.js): a Reaper with a Core Probe Launcher I and eight
// Core Scanner Probe I loaded, undocked at Jita; four probes launched, a scan
// asked for with them, the four recalled.

const test = require("node:test");
const assert = require("node:assert/strict");
const { AU, FIRST_RANGE_STEP, MAX_PROBES, MAX_PROBE_DIST_FROM_SUN_SQUARED, PROBE_STATE, RANGE_STEPS, createPilotScanner, readProbe } = require("../src/gamePort/pilotScanner");
const { ATTRIBUTE, createPilotDogma } = require("../src/gamePort/pilotDogma");
const flight = require("./fixtures/probeFlight.json");
const { answers, notifications } = require("./helpers/destinyRecording");

const SHIP = flight.shipID;
const PILOT = flight.characterID;
const LAUNCHER = flight.moduleID;
const PROBE_TYPE = 30013;
const LAUNCHER_GROUP = 481;
/** The probe type's two attributes as the game's static data has them: a quarter of an AU, doubling each step. */
const typeAttribute = (typeID, attributeID) => (typeID === PROBE_TYPE ? { 1370: 0.25, 1373: 2 }[attributeID] ?? null : null);
const during = (step) => notifications(flight).filter((notification) => notification.during === step);
const allInfo = (step) => answers(flight).find((answer) => answer.during === step && answer.value && answer.value.type === "object").value;

const keyVal = (fields) => ({ type: "object", name: Buffer.from("util.KeyVal"), args: { type: "dict", entries: Object.entries(fields).map(([name, value]) => [Buffer.from(name), value]) } });
const probe = (probeID, more = {}) => keyVal({ probeID: BigInt(probeID), typeID: PROBE_TYPE, pos: [1000, 2000, 3000], destination: [1000, 2000, 3000], scanRange: 5, rangeStep: 3, state: 1, expiry: 134359490166880000n, ...more });
const told = (method, ...args) => ({ method, args });
const states = (scanner) => scanner.probes().map((each) => [each.probeID, each.state]);

// ── the client's constants ───────────────────────────────────────────────────

test("the scanner's numbers are the client's", () => {
  assert.deepEqual(PROBE_STATE, { INACTIVE: 0, IDLE: 1, MOVING: 2, WARPING: 3, SCANNING: 4, RETURNING: 5 });
  assert.deepEqual([MAX_PROBES, RANGE_STEPS, FIRST_RANGE_STEP, AU], [8, 8, 7, 149597870700.0]);
  assert.equal(MAX_PROBE_DIST_FROM_SUN_SQUARED, (AU * 250) ** 2);
});

test("a probe type's range steps are its base range, times its factor for each step, in astronomical units", () => {
  const scanner = createPilotScanner({ typeAttribute });
  assert.deepEqual(scanner.rangeSteps(PROBE_TYPE), [0.25, 0.5, 1, 2, 4, 8, 16, 32].map((au) => au * AU));
  // A type whose attributes the static data has not, or has as nothing usable, has no steps.
  assert.equal(scanner.rangeSteps(999), null);
  for (const [base, factor] of [[0, 2], [0.25, 0], [-1, 2], [Number.NaN, 2], ["x", 2], [null, null]]) {
    assert.equal(createPilotScanner({ typeAttribute: (_typeID, attributeID) => (attributeID === 1370 ? base : factor) }).rangeSteps(1), null, `${base}, ${factor}`);
  }
  assert.equal(createPilotScanner().rangeSteps(PROBE_TYPE), null, "with no static data at all");
});

// ── a real flight ────────────────────────────────────────────────────────────

test("a real flight: four probes out, a scan with them, and the four recalled", () => {
  const scanner = createPilotScanner({ typeAttribute });
  const feed = (step) => during(step).map((notification) => scanner.feed(notification));
  for (const step of ["login", "select", "GetAllInfo docked", "undock", "enter space", "GetAllInfo in space"]) feed(step);
  assert.deepEqual(scanner.probes(), [], "none until one is launched");

  feed("launch");
  const out = scanner.probes();
  assert.deepEqual(out.map((each) => each.probeID), flight.probeIDs);
  assert.deepEqual(flight.probeIDs, [990000000001, 990000000002, 990000000003, 990000000004]);
  for (const each of out) {
    // Idle, on the seventh range step, sixteen AU: the client's own choice, and here the server's too.
    assert.deepEqual([each.typeID, each.state, each.rangeStep, each.scanRange], [PROBE_TYPE, PROBE_STATE.IDLE, 7, 16 * AU]);
    assert.equal(each.scanRange, 2393565931200);
    assert.deepEqual(each.destination, each.pos);
    assert.equal(each.pos.length, 3);
    assert.equal(typeof each.expiry, "bigint");
  }
  assert.deepEqual(out[0].pos, [-107303380589.52992, -18744981743.58154, 436488992639.86847]);
  assert.equal(scanner.activeProbes().length, 4);
  assert.equal(scanner.idleProbes().length, 4);

  // The server says the scan has started before it answers the request for one, so the client marks its
  // probes as scanning and then, when its call comes back, as moving. That is the order here too.
  feed("GetAllInfo after launch");
  feed("bind scan manager");
  assert.deepEqual(during("scan").map((each) => each.method).filter((method) => /Scan/.test(method)), ["OnSystemScanStarted"]);
  feed("scan");
  assert.deepEqual(states(scanner).map(([, state]) => state), [4, 4, 4, 4]);
  scanner.moving(flight.probeIDs);
  assert.deepEqual(states(scanner).map(([, state]) => state), [2, 2, 2, 2]);
  assert.equal(scanner.idleProbes().length, 0);
  assert.equal(scanner.activeProbes().length, 4, "moving is not inactive");

  feed("scanning");
  assert.deepEqual(states(scanner).map(([, state]) => state), [1, 1, 1, 1], "the scan is over: idle again");

  // Recalled: the ones the server answered with are moving, and then each is taken away.
  assert.deepEqual(flight.recovered, flight.probeIDs);
  feed("recover");
  scanner.moving(flight.recovered);
  assert.deepEqual(states(scanner).map(([, state]) => state), [2, 2, 2, 2]);
  assert.equal(during("recovering").filter((each) => each.method === "OnRemoveProbe").length, 4);
  feed("recovering");
  assert.deepEqual(scanner.probes(), []);
});

// ── each thing the server can say ────────────────────────────────────────────

test("a new probe is idle where it is, on the range step last used, whatever the server said of those", () => {
  const scanner = createPilotScanner({ typeAttribute });
  assert.equal(scanner.feed(told("OnNewProbe", probe(11, { state: 4, destination: [9, 9, 9], rangeStep: 3, scanRange: 5 }))), true);
  assert.deepEqual(scanner.probes(), [{ probeID: 11, typeID: PROBE_TYPE, pos: [1000, 2000, 3000], destination: [1000, 2000, 3000], scanRange: 16 * AU, rangeStep: 7, state: 1, expiry: 134359490166880000n }]);
  // A list where a tuple was, a number where a long was: the same probe.
  scanner.feed(told("OnNewProbe", probe(12, { probeID: 12, pos: { type: "list", items: [1, 2, 3] } })));
  assert.deepEqual(scanner.probes()[1].pos, [1, 2, 3]);
  // Of a type the static data does not know: the server's own step and range stand.
  scanner.feed(told("OnNewProbe", probe(13, { typeID: 999 })));
  assert.deepEqual([scanner.probes()[2].rangeStep, scanner.probes()[2].scanRange], [3, 5]);
  // With no ID it is no probe; with no position it is at the sun.
  scanner.feed(told("OnNewProbe", keyVal({ typeID: PROBE_TYPE })));
  scanner.feed(told("OnNewProbe", null));
  scanner.feed(told("OnNewProbe"));
  assert.equal(scanner.probes().length, 3);
  assert.deepEqual(readProbe(keyVal({ probeID: 5n })), { probeID: 5, typeID: null, pos: [0, 0, 0], destination: [0, 0, 0], scanRange: 0, rangeStep: 0, state: 1, expiry: null });
  assert.equal(readProbe(keyVal({ probeID: "5" })), null);
  // A position that is not three numbers is no position.
  for (const pos of [[1, "x", 3], [1, 2], "here", [1, 2, null]]) {
    assert.deepEqual(readProbe(keyVal({ probeID: 5n, pos })).pos, [0, 0, 0], JSON.stringify(pos));
  }
  assert.deepEqual(readProbe(keyVal({ probeID: 5n, pos: [1, 2, 3, 4] })).pos, [1, 2, 3]);
  // The same probe told of again replaces what was held, and keeps its place.
  scanner.feed(told("OnNewProbe", probe(11, { pos: [7, 8, 9] })));
  assert.deepEqual([scanner.probes().length, scanner.probes()[0].pos], [3, [7, 8, 9]]);
});

test("a probe taken away is gone, and one that was never held is nothing", () => {
  const scanner = createPilotScanner({ typeAttribute });
  scanner.feed(told("OnNewProbe", probe(11)));
  scanner.feed(told("OnNewProbe", probe(12)));
  assert.equal(scanner.feed(told("OnRemoveProbe", 11n)), true);
  scanner.feed(told("OnRemoveProbe", 99));
  scanner.feed(told("OnRemoveProbe"));
  assert.deepEqual(states(scanner), [[12, 1]]);
});

test("probes said to be idle are idle and bound for where the server says; one the client does not hold stops the list there", () => {
  const scanner = createPilotScanner({ typeAttribute });
  for (const probeID of [11, 12, 13]) scanner.feed(told("OnNewProbe", probe(probeID)));
  scanner.moving([11, 12, 13]);
  // 11 is held, 99 is not, 13 is: the client's handler fails at 99 and never reaches 13.
  assert.equal(scanner.feed(told("OnProbesIdle", [probe(11, { destination: [5, 6, 7] }), probe(99), probe(13, { destination: [1, 1, 1] })])), true);
  assert.deepEqual(states(scanner), [[11, 1], [12, 2], [13, 2]]);
  assert.deepEqual(scanner.probes()[0].destination, [5, 6, 7]);
  assert.deepEqual(scanner.probes()[0].pos, [1000, 2000, 3000], "where it is has not changed");
  assert.deepEqual(scanner.probes()[2].destination, [1000, 2000, 3000]);
  // As a list, as the server sends it on a reconnect.
  scanner.feed(told("OnProbesIdle", { type: "list", items: [probe(12), probe(13)] }));
  assert.deepEqual(states(scanner), [[11, 1], [12, 1], [13, 1]]);
  scanner.feed(told("OnProbesIdle"));
});

test("a probe's state is what the server says it has changed to", () => {
  const scanner = createPilotScanner({ typeAttribute });
  scanner.feed(told("OnNewProbe", probe(11)));
  assert.equal(scanner.feed(told("OnProbeStateChanged", 11n, 3)), true);
  assert.deepEqual(states(scanner), [[11, 3]]);
  scanner.feed(told("OnProbeStateChanged", 99, 4));
  scanner.feed(told("OnProbeStateChanged", 11, 0));
  assert.deepEqual(states(scanner), [[11, 0]]);
  assert.deepEqual([scanner.activeProbes().length, scanner.idleProbes().length], [0, 0], "inactive is neither active nor idle");
});

test("a scan starting: its probes are scanning and are where the server says, pulled in from beyond a probe's reach", () => {
  const scanner = createPilotScanner({ typeAttribute });
  for (const probeID of [11, 12, 13]) scanner.feed(told("OnNewProbe", probe(probeID)));
  const far = [AU * 500, 0, 0];
  const probes = { type: "dict", entries: [[11n, probe(11, { pos: [4, 5, 6] })], [99n, probe(99)], [12n, probe(12, { pos: far })]] };
  assert.equal(scanner.feed(told("OnSystemScanStarted", 134359450183540000n, 7600, probes)), true);
  // 99 is not held and is passed over; 13 was not in the scan.
  assert.deepEqual(states(scanner), [[11, 4], [12, 4], [13, 1]]);
  assert.deepEqual([scanner.probes()[0].pos, scanner.probes()[0].destination], [[4, 5, 6], [4, 5, 6]]);
  // The client scales by the ratio of the squares: 500 AU out becomes 125, not 250.
  assert.deepEqual(scanner.probes()[1].pos, [AU * 125, 0, 0]);
  assert.deepEqual(scanner.probes()[1].destination, [AU * 125, 0, 0]);
  // Exactly at the limit is left alone.
  scanner.feed(told("OnSystemScanStarted", 0n, 1, { type: "dict", entries: [[13n, probe(13, { pos: [AU * 250, 0, 0] })]] }));
  assert.deepEqual(scanner.probes()[2].pos, [AU * 250, 0, 0]);
  // With no position the probe is scanning where it was.
  scanner.feed(told("OnSystemScanStarted", 0n, 1, { type: "dict", entries: [[11n, keyVal({ probeID: 11n })]] }));
  assert.deepEqual(scanner.probes()[0].pos, [4, 5, 6]);
  scanner.feed(told("OnSystemScanStarted", 0n, 1));
});

test("a scan stopping makes its probes idle; the scanner's information removed leaves none", () => {
  const scanner = createPilotScanner({ typeAttribute });
  for (const probeID of [11, 12, 13]) scanner.feed(told("OnNewProbe", probe(probeID)));
  scanner.moving([11, 12, 13, 99]);
  assert.equal(scanner.feed(told("OnSystemScanStopped", [11n, 12n, 99n], [], [])), true);
  assert.deepEqual(states(scanner), [[11, 1], [12, 1], [13, 2]]);
  scanner.feed(told("OnSystemScanStopped", { type: "list", items: [13] }, null, null));
  assert.deepEqual(states(scanner), [[11, 1], [12, 1], [13, 1]]);
  assert.equal(scanner.feed(told("OnScannerInfoRemoved")), true);
  assert.deepEqual(scanner.probes(), []);
});

test("what the client does itself: moving after a scan or a recall is asked for, gone when destroyed, none after a flush", () => {
  const scanner = createPilotScanner({ typeAttribute });
  for (const probeID of [11, 12, 13]) scanner.feed(told("OnNewProbe", probe(probeID)));
  scanner.moving([11n, "12"]);
  assert.deepEqual(states(scanner), [[11, 2], [12, 1], [13, 1]], "a name that is not a number names nothing");
  // Only an idle or an inactive probe is dropped when destroyed: a moving one stays, as on the client.
  scanner.removed(11);
  scanner.removed(12);
  scanner.removed(99);
  assert.deepEqual(states(scanner), [[11, 2], [13, 1]]);
  scanner.feed(told("OnProbeStateChanged", 13, 0));
  scanner.removed(13n);
  assert.deepEqual(states(scanner), [[11, 2]]);
  // What is handed out is the caller's own.
  scanner.probes()[0].pos[0] = -1;
  scanner.activeProbes()[0].destination[0] = -1;
  assert.deepEqual([scanner.probes()[0].pos, scanner.probes()[0].destination], [[1000, 2000, 3000], [1000, 2000, 3000]]);
  scanner.flush();
  assert.deepEqual(scanner.probes(), []);
  // The range step last used outlives a flush; a probe launched afterwards gets it as before.
  scanner.feed(told("OnNewProbe", probe(21)));
  assert.equal(scanner.probes()[0].rangeStep, 7);
});

test("what is not the scanner's is left for others", () => {
  const scanner = createPilotScanner({ typeAttribute });
  for (const method of ["OnProbeWarpStart", "OnItemsChanged", "DoDestinyUpdate", "OnModuleAttributeChanges"]) {
    assert.equal(scanner.feed(told(method, 1, 2, 3)), false, method);
  }
  assert.equal(scanner.feed({ method: "OnNewProbe" }), true, "with no arguments at all it is still the scanner's, and adds nothing");
  assert.deepEqual(scanner.probes(), []);
});

// ── the launcher, from godma ─────────────────────────────────────────────────

test("GetAllInfo from a real server: the online probe launcher and the eight probes in it", () => {
  for (const step of ["GetAllInfo docked", "GetAllInfo in space"]) {
    const dogma = createPilotDogma({ characterID: PILOT });
    assert.equal(dogma.onlineModule(SHIP, LAUNCHER_GROUP), null, "nothing until the ship is loaded");
    dogma.loadAllInfo(allInfo(step));
    assert.deepEqual(dogma.onlineModule(SHIP, LAUNCHER_GROUP), { moduleID: LAUNCHER, typeID: 17938, flagID: 27, charge: { typeID: PROBE_TYPE, quantity: 8 } }, step);
    // The afterburner in the mid slot is of another group, and there is no launcher of a group that is not fitted.
    assert.equal(dogma.onlineModule(SHIP, 46).typeID, 21857);
    assert.equal(dogma.onlineModule(SHIP, 46).charge, null);
    assert.equal(dogma.onlineModule(SHIP, 999), null);
    assert.equal(dogma.onlineModule(SHIP + 1, LAUNCHER_GROUP), null, "another ship's");
    dogma.clear();
    assert.equal(dogma.onlineModule(SHIP, LAUNCHER_GROUP), null);
  }
});

test("a real flight: the count in the launcher follows the server's word, and lands on what the server next says", () => {
  const dogma = createPilotDogma({ characterID: PILOT });
  dogma.loadAllInfo(allInfo("GetAllInfo in space"));
  const loaded = () => dogma.onlineModule(SHIP, LAUNCHER_GROUP).charge.quantity;
  const serverSays = (step) => {
    const fresh = createPilotDogma({ characterID: PILOT });
    fresh.loadAllInfo(allInfo(step));
    return fresh.onlineModule(SHIP, LAUNCHER_GROUP).charge.quantity;
  };
  const feed = (step) => during(step).forEach((notification) => dogma.feed(notification));
  assert.equal(loaded(), 8);
  feed("launch");
  assert.equal(loaded(), 4);
  assert.equal(serverSays("GetAllInfo after launch"), 4);
  for (const step of ["GetAllInfo after launch", "bind scan manager", "scan", "scanning"]) feed(step);
  assert.equal(loaded(), 4);
  feed("recover");
  feed("recovering");
  assert.equal(loaded(), 8);
  assert.equal(serverSays("GetAllInfo after recover"), 8);
});

const row = (fields) => ({ type: "packedrow", fields });
const item = (itemID, { typeID = 17938, groupID = LAUNCHER_GROUP, flagID = 27, locationID = 5001, online = 1, inventory = true } = {}) =>
  [BigInt(itemID), keyVal({ itemID: BigInt(itemID), invItem: inventory ? row({ itemID, typeID, ownerID: PILOT, locationID, flagID, quantity: -1, groupID, categoryID: 7 }) : null, time: 134359220000000000n, attributes: { type: "dict", entries: [[ATTRIBUTE.IS_ONLINE, online]] }, activeEffects: { type: "dict", entries: [] } })];
const charge = (shipID, flagID, typeID, quantity) =>
  [[BigInt(shipID), flagID, typeID], keyVal({ itemID: [BigInt(shipID), flagID, typeID], invItem: null, time: 134359220000000000n, attributes: { type: "dict", entries: [[ATTRIBUTE.QUANTITY, quantity]] }, activeEffects: { type: "dict", entries: [] } })];
const shipWith = (...rows) => {
  const dogma = createPilotDogma({ characterID: PILOT, now: () => 134359220000000000n });
  dogma.loadAllInfo(keyVal({ shipInfo: { type: "dict", entries: rows } }));
  return dogma;
};

test("the launcher is the first online module of its group that the server listed, on this ship, with what is at its flag", () => {
  // Offline first, then two online: the first online one, with the charge at ITS flag.
  const dogma = shipWith(item(101, { flagID: 27, online: 0 }), item(102, { flagID: 28 }), item(103, { flagID: 29 }), charge(5001, 29, PROBE_TYPE, 3), charge(5001, 28, 30488, 6), charge(5001, 27, PROBE_TYPE, 8));
  assert.deepEqual(dogma.onlineModule(5001, LAUNCHER_GROUP), { moduleID: 102, typeID: 17938, flagID: 28, charge: { typeID: 30488, quantity: 6 } });
  // None online, none of the group, one in another ship, one with no inventory row: no launcher.
  assert.equal(shipWith(item(101, { online: 0 })).onlineModule(5001, LAUNCHER_GROUP), null);
  assert.equal(shipWith(item(101, { groupID: 46 })).onlineModule(5001, LAUNCHER_GROUP), null);
  assert.equal(shipWith(item(101, { locationID: 6001 })).onlineModule(5001, LAUNCHER_GROUP), null);
  assert.equal(shipWith(item(101, { inventory: false })).onlineModule(5001, LAUNCHER_GROUP), null);
  // Nothing loaded, a charge that has run out, a charge at another flag or in another ship: no charge.
  assert.equal(shipWith(item(101)).onlineModule(5001, LAUNCHER_GROUP).charge, null);
  assert.equal(shipWith(item(101), charge(5001, 27, PROBE_TYPE, 0)).onlineModule(5001, LAUNCHER_GROUP).charge, null);
  assert.equal(shipWith(item(101), charge(5001, 28, PROBE_TYPE, 8)).onlineModule(5001, LAUNCHER_GROUP).charge, null);
  assert.equal(shipWith(item(101), charge(6001, 27, PROBE_TYPE, 8)).onlineModule(5001, LAUNCHER_GROUP).charge, null);
  // What is in one module, online or not, by its own flag: a module godma was not told of holds nothing.
  const two = shipWith(item(101, { flagID: 27, online: 0 }), item(102, { flagID: 28 }), charge(5001, 27, PROBE_TYPE, 8));
  assert.deepEqual([two.chargeIn(101), two.chargeIn(102), two.chargeIn(103)], [{ typeID: PROBE_TYPE, quantity: 8 }, null, null]);
  // The row spelled by position, as the codec also gives it.
  const byPosition = createPilotDogma({ characterID: PILOT });
  byPosition.loadAllInfo(keyVal({ shipInfo: { type: "dict", entries: [[101n, keyVal({ itemID: 101n, invItem: { type: "packedrow", columns: [["itemID", 20], ["typeID", 3], ["locationID", 20], ["flagID", 2], ["groupID", 3]], values: [101, 17938, 5001, 27, LAUNCHER_GROUP] }, time: 1n, attributes: { type: "dict", entries: [[ATTRIBUTE.IS_ONLINE, 1]] }, activeEffects: { type: "dict", entries: [] } })]] } }));
  assert.equal(byPosition.onlineModule(5001, LAUNCHER_GROUP).moduleID, 101);
});

test("a launcher going offline, and its charge running out, are taken from the server's changes", () => {
  const dogma = shipWith(item(101), charge(5001, 27, PROBE_TYPE, 2));
  const change = (itemKey, attributeID, seconds, value) => ({ method: "OnModuleAttributeChanges", args: [{ type: "list", items: [["OnModuleAttributeChange", PILOT, itemKey, attributeID, 134359220000000000n + BigInt(seconds) * 10000000n, value, null, 134359220000000000n + BigInt(seconds) * 10000000n]] }] });
  dogma.feed(change([5001n, 27, PROBE_TYPE], ATTRIBUTE.QUANTITY, 1, 1));
  assert.equal(dogma.onlineModule(5001, LAUNCHER_GROUP).charge.quantity, 1);
  dogma.feed(change([5001n, 27, PROBE_TYPE], ATTRIBUTE.QUANTITY, 2, 0));
  assert.equal(dogma.onlineModule(5001, LAUNCHER_GROUP).charge, null);
  // A change for a charge that is not held is not taken, as godma drops one for an item it has not got.
  dogma.feed(change([5001n, 28, PROBE_TYPE], ATTRIBUTE.QUANTITY, 3, 5));
  assert.equal(dogma.attribute("5001/28/30013", ATTRIBUTE.QUANTITY), null);
  // Someone else's charge is not this pilot's.
  dogma.feed({ method: "OnModuleAttributeChanges", args: [{ type: "list", items: [["OnModuleAttributeChange", 140000099, [5001n, 27, PROBE_TYPE], ATTRIBUTE.QUANTITY, 134359220090000000n, 7, null, 134359220090000000n]] }] });
  assert.equal(dogma.onlineModule(5001, LAUNCHER_GROUP).charge, null);
  dogma.feed(change(101n, ATTRIBUTE.IS_ONLINE, 4, 0));
  assert.equal(dogma.onlineModule(5001, LAUNCHER_GROUP), null);
});

test("a probe switched off and on goes between idle and inactive, and nothing else is moved by that", () => {
  const scanner = createPilotScanner({ typeAttribute });
  for (const probeID of [11, 12]) scanner.feed(told("OnNewProbe", probe(probeID)));
  scanner.setActive(11n, false);
  assert.deepEqual(states(scanner), [[11, 0], [12, 1]]);
  scanner.setActive(11, false);
  scanner.setActive(12, true);
  assert.deepEqual(states(scanner), [[11, 0], [12, 1]], "off when off and on when on change nothing");
  scanner.setActive(11, true);
  assert.deepEqual(states(scanner), [[11, 1], [12, 1]]);
  // A probe that is moving is neither switched off nor on.
  scanner.moving([12]);
  scanner.setActive(12, false);
  scanner.setActive(12, true);
  scanner.setActive(99, true);
  assert.deepEqual(states(scanner), [[11, 1], [12, 2]]);
});

test("where a probe is to go and how far it looks are the client's to keep, and the step chosen is the next probe's too", () => {
  const scanner = createPilotScanner({ typeAttribute });
  scanner.feed(told("OnNewProbe", probe(11)));
  scanner.setDestination(11n, [7, 8, 9]);
  scanner.setDestination(11, [1, 2]);
  scanner.setDestination(11, null);
  scanner.setDestination(99, [1, 1, 1]);
  assert.deepEqual([scanner.probes()[0].destination, scanner.probes()[0].pos], [[7, 8, 9], [1000, 2000, 3000]]);
  scanner.setDestination(11, { type: "list", items: [4, 5, 6] });
  assert.deepEqual(scanner.probes()[0].destination, [4, 5, 6]);

  scanner.setRangeStep(11, 3);
  assert.deepEqual([scanner.probes()[0].rangeStep, scanner.probes()[0].scanRange], [3, 1 * AU]);
  for (const step of [1, 8]) {
    scanner.setRangeStep(11, step);
    assert.deepEqual([scanner.probes()[0].rangeStep, scanner.probes()[0].scanRange], [step, [0.25, 32][step === 1 ? 0 : 1] * AU]);
  }
  // Outside the eight steps, or not a whole one, or for a probe not held: nothing changes, and the step last used stays.
  for (const bad of [0, 9, 2.5, -1, null, "3"]) scanner.setRangeStep(11, bad);
  scanner.setRangeStep(99, 2);
  assert.equal(scanner.probes()[0].rangeStep, 8);
  // The next probe out starts on the step chosen last.
  scanner.feed(told("OnNewProbe", probe(12)));
  assert.deepEqual([scanner.probes()[1].rangeStep, scanner.probes()[1].scanRange], [8, 32 * AU]);
  // Of a type with no known steps the step is kept and the range is left as it was.
  scanner.feed(told("OnNewProbe", probe(13, { typeID: 999, scanRange: 5, rangeStep: 3 })));
  scanner.setRangeStep(13, 2);
  assert.deepEqual([scanner.probes()[2].rangeStep, scanner.probes()[2].scanRange], [2, 5]);
});

test("a charge loaded into an empty launcher is told of on its own, and is then the launcher's", () => {
  // The row is in the form GetAllInfo lists a charge in (the real one above); the notification that carries it
  // is the server's OnGodmaPrimeItem(shipID, row).
  const dogma = shipWith(item(5001, { typeID: 588, groupID: 237, flagID: 0, locationID: 30000142 }), item(101));
  assert.equal(dogma.onlineModule(5001, LAUNCHER_GROUP).charge, null);
  const primed = charge(5001, 27, PROBE_TYPE, 8)[1];
  assert.equal(dogma.feed({ method: "OnGodmaPrimeItem", args: [5001n, primed] }), true);
  assert.deepEqual(dogma.onlineModule(5001, LAUNCHER_GROUP).charge, { typeID: PROBE_TYPE, quantity: 8 });
  // And from then on its count is changed like any other.
  dogma.feed({ method: "OnModuleAttributeChanges", args: [{ type: "list", items: [["OnModuleAttributeChange", PILOT, [5001n, 27, PROBE_TYPE], ATTRIBUTE.QUANTITY, 134359220090000000n, 5, 8, 134359220090000000n]] }] });
  assert.equal(dogma.onlineModule(5001, LAUNCHER_GROUP).charge.quantity, 5);
  // A module fitted afterwards arrives the same way.
  dogma.feed({ method: "OnGodmaPrimeItem", args: [5001n, item(102, { flagID: 28, groupID: 46, typeID: 21857 })[1]] });
  assert.equal(dogma.onlineModule(5001, 46).moduleID, 102);
  // One for a ship that is not held, or with nothing to say what it is, is left alone.
  dogma.feed({ method: "OnGodmaPrimeItem", args: [6001n, charge(6001, 27, PROBE_TYPE, 3)[1]] });
  assert.equal(dogma.attribute("6001/27/30013", ATTRIBUTE.QUANTITY), null);
  assert.equal(dogma.feed({ method: "OnGodmaPrimeItem", args: [5001n, keyVal({ time: 1n })] }), true);
  assert.equal(dogma.has(undefined), false, "a row that names no item is not kept under no name");
  assert.equal(dogma.feed({ method: "OnGodmaPrimeItem", args: [] }), true);
  assert.equal(dogma.feed({ method: "OnGodmaPrimeItem" }), true);
  assert.equal(dogma.onlineModule(5001, LAUNCHER_GROUP).charge.quantity, 5);
});
