"use strict";

// The pilot's own ship as dogma has it (src/gamePort/pilotDogma.js): the part
// of the retail client's godma that the ship's panel reads.
//
// The bytes are a real server's (test/fixtures/dogmaFlight.json, made by
// scripts/record-dogma.js): GetAllInfo docked and in space, an afterburner run
// for twelve seconds, GetAllInfo again. The last answer is the server's own
// account of the capacitor after all that, which is what ours is held up to.

const test = require("node:test");
const assert = require("node:assert/strict");
const { ATTRIBUTE, CHARGED, DGM_TAU_CONSTANT, EFFECT_CATEGORY, EFFECT_ONLINE, chargeValue, createPilotDogma, filetimeNow } = require("../src/gamePort/pilotDogma");
const flight = require("./fixtures/dogmaFlight.json");
const { answers, notifications } = require("./helpers/destinyRecording");

const SHIP = flight.shipID;
const PILOT = flight.characterID;
const MS = BigInt(DGM_TAU_CONSTANT);
/** The three GetAllInfo answers of the recording, by the step they were asked in. */
const allInfo = (during) => answers(flight).find((answer) => answer.during === during && answer.value && answer.value.type === "object").value;
/** A change as it arrives inside OnModuleAttributeChanges. */
const change = (itemID, attributeID, time, newValue, { owner = PILOT, old = null, stamp = time } = {}) => ["OnModuleAttributeChange", owner, itemID, attributeID, time, newValue, old, stamp];
const changes = (...list) => ({ method: "OnModuleAttributeChanges", args: [{ type: "list", items: list }] });
/** A dogma holding one ship: 100 GJ of capacitor that takes 500 s to recharge, 200 shield, at time T0. */
const T0 = 134359220000000000n;
function small({ charge = 100, capacity = 100, rechargeRate = 500000, now = () => T0 } = {}) {
  const dogma = createPilotDogma({ characterID: PILOT, now });
  const keyVal = (entries) => ({ type: "object", name: Buffer.from("util.KeyVal"), args: { type: "dict", entries: entries.map(([name, value]) => [Buffer.from(name), value]) } });
  const attributes = { type: "dict", entries: [[ATTRIBUTE.CHARGE, charge], [ATTRIBUTE.CAPACITOR_CAPACITY, capacity], [ATTRIBUTE.RECHARGE_RATE, rechargeRate], [ATTRIBUTE.SHIELD_CAPACITY, 200], [ATTRIBUTE.SHIELD_CHARGE, 200], [ATTRIBUTE.SHIELD_RECHARGE_RATE, 800000], [ATTRIBUTE.ARMOR_HP, 300], [ATTRIBUTE.HP, 400], [4, 1e6]] };
  dogma.loadAllInfo(keyVal([["shipInfo", { type: "dict", entries: [[5001n, keyVal([["itemID", 5001n], ["time", T0], ["attributes", attributes]])]] }]]));
  return dogma;
}
const seconds = (n) => T0 + BigInt(Math.round(n * 1000)) * MS;

test("a recharging attribute, by godma's formula", () => {
  // Empty, capacity 100, tau 1000 ms: after one tau it is (1 - 1/e)^2 of full.
  assert.ok(Math.abs(chargeValue(0, T0, 1000, 100, T0 + 1000n * MS) - 100 * (1 - 1 / Math.E) ** 2) < 1e-12);
  // No time passed: what it was. Full stays full. Asked about a time before the reading: what it was.
  assert.ok(Math.abs(chargeValue(37, T0, 1000, 100, T0) - 37) < 1e-12);
  assert.equal(chargeValue(100, T0, 1000, 100, T0 + 999999n * MS), 100);
  assert.equal(chargeValue(37, T0, 1000, 100, T0 - 5000n * MS), chargeValue(37, T0, 1000, 100, T0));
  // It only ever climbs towards its capacity, and nothing can be had of no capacity.
  const at = (ms) => chargeValue(25, T0, 1000, 100, T0 + BigInt(ms) * MS);
  assert.ok(at(100) > 25 && at(1000) > at(100) && at(100000) > 99.999 && at(100000) <= 100);
  assert.equal(chargeValue(5, T0, 1000, 0, T0 + 1000n * MS), 0);
  assert.equal(chargeValue(-3, T0, 1000, 100, T0), 0, "a charge below nothing is none");
  assert.deepEqual([...CHARGED], [[ATTRIBUTE.CHARGE, [ATTRIBUTE.RECHARGE_RATE, ATTRIBUTE.CAPACITOR_CAPACITY]], [ATTRIBUTE.SHIELD_CHARGE, [ATTRIBUTE.SHIELD_RECHARGE_RATE, ATTRIBUTE.SHIELD_CAPACITY]]]);
});

test("the clock is the server's: 100 ns since 1601", () => {
  assert.equal(filetimeNow(0), 116444736000000000n);
  assert.equal(filetimeNow(1791446717607), 134359203176070000n);
});

test("GetAllInfo from a real server: the ship and its module are held, and the ship's numbers are the gateway's", () => {
  const dogma = createPilotDogma({ characterID: PILOT });
  assert.equal(dogma.shipReadings(SHIP), null, "nothing until it is loaded");
  const held = dogma.loadAllInfo(allInfo("GetAllInfo docked"));
  // The ship, its module, and the pilot's own character, which godma primes from the first of charInfo's two.
  assert.deepEqual(held, [SHIP, flight.moduleID, PILOT]);
  assert.deepEqual([dogma.has(SHIP), dogma.has(flight.moduleID), dogma.has(PILOT), dogma.has(1)], [true, true, true, false]);
  // Of the character: its manufacturing time (219), which no skill of this pilot's shortens, and its repair cost
  // (187), off its own row of 66 attributes, the whole character as Tranquility's item lists it. The server says
  // nothing of what the ship changes (shipModifiedCharAttribs is None, as Tranquility's is for a ship that
  // changes nothing of its pilot), so the character's are its row's: an attribute its type has not and nothing
  // gives it (979) is not held.
  assert.deepEqual([dogma.attribute(PILOT, 219), dogma.attribute(PILOT, 187), dogma.attribute(PILOT, 979), dogma.attributesOf(PILOT).length], [1, 0.1, null, 66]);
  // In space the same.
  const flying = createPilotDogma({ characterID: PILOT });
  flying.loadAllInfo(allInfo("GetAllInfo in space"));
  assert.deepEqual([flying.attribute(PILOT, 219), flying.attribute(PILOT, 187), flying.attribute(PILOT, 979), flying.attributesOf(PILOT).length], [1, 0.1, null, 66]);
  assert.deepEqual([ATTRIBUTE.HP, ATTRIBUTE.ARMOR_HP, ATTRIBUTE.SHIELD_CAPACITY, ATTRIBUTE.CAPACITOR_CAPACITY, ATTRIBUTE.RECHARGE_RATE, ATTRIBUTE.SHIELD_RECHARGE_RATE, ATTRIBUTE.DAMAGE, ATTRIBUTE.ARMOR_DAMAGE].map((id) => dogma.attribute(SHIP, id)),
    [150, 150, 175, 125, 62500, 730000, 0, 0]);
  // What the gateway's snapshot said of the same ship: capacitor 1, capacities 175, 150, 150.
  assert.deepEqual(dogma.shipReadings(SHIP), {
    capacitorRatio: 1, shieldRatio: 1, armorRatio: 1, hullRatio: 1, shieldCapacity: 175, armorCapacity: 150, hullCapacity: 150,
    activeModuleIDs: [], activeModuleTargets: [], moduleRanges: [], overloadedModuleIDs: [], moduleDamage: {}, weaponBanks: {},
    // A real ship's row carries its racks' heat capacities, so its racks are known, and cold.
    rackHeat: { high: 0, mid: 0, low: 0 },
  });
  assert.deepEqual([dogma.attribute(SHIP, ATTRIBUTE.CHARGE), dogma.attribute(SHIP, ATTRIBUTE.SHIELD_CHARGE)], [125, 175]);
  assert.equal(dogma.attribute(SHIP, 999999), null);
  dogma.clear();
  assert.deepEqual([dogma.has(SHIP), dogma.shipReadings(SHIP), dogma.attribute(SHIP, ATTRIBUTE.CHARGE)], [false, null, null]);
});

test("what is loaded is true at the time the server gave for it, and replaces what was held", () => {
  // Loaded 100 s ago by the server's clock at 40 of 100: read now, it has been recharging since then.
  const dogma = small({ charge: 40, now: () => seconds(100) });
  const expected = chargeValue(40, T0, 500000 / 5, 100, seconds(100));
  assert.equal(dogma.attribute(5001, ATTRIBUTE.CHARGE), expected);
  assert.ok(expected > 60, `${expected} of 100 after 100 s`);
  // Loaded again as something with a charge and nothing to recharge it by: the charge is a plain number, and the old recharge is gone.
  const keyVal = (entries) => ({ type: "object", name: Buffer.from("util.KeyVal"), args: { type: "dict", entries: entries.map(([name, value]) => [Buffer.from(name), value]) } });
  dogma.loadAllInfo(keyVal([["shipInfo", { type: "dict", entries: [[5001n, keyVal([["itemID", 5001n], ["time", T0], ["attributes", { type: "dict", entries: [[ATTRIBUTE.CHARGE, 7]] }]])]] }]]));
  assert.deepEqual([dogma.attribute(5001, ATTRIBUTE.CHARGE), dogma.attribute(5001, ATTRIBUTE.CAPACITOR_CAPACITY), dogma.shipReadings(5001).capacitorRatio], [7, null, null]);
  dogma.loadAllInfo(keyVal([["shipInfo", { type: "dict", entries: [[5001n, keyVal([["itemID", 5001n], ["time", T0], ["attributes", { type: "dict", entries: [[4, 5]] }]])]] }]]));
  assert.equal(dogma.attribute(5001, ATTRIBUTE.CHARGE), null);
});

test("a real flight with the afterburner running: between the server's own reports, godma's recharge lands on the next one", () => {
  // The server reports the capacitor about twice a second while it changes.
  // From each report the client works out the charge for itself until the
  // next; so each next report is a check on that working, by the server.
  let clockNow = 0n;
  const dogma = createPilotDogma({ characterID: PILOT, now: () => clockNow });
  const loaded = answers(flight).find((answer) => answer.during === "GetAllInfo in space" && answer.value && answer.value.type === "object");
  const last = answers(flight).find((answer) => answer.during === "GetAllInfo after" && answer.value && answer.value.type === "object");
  dogma.loadAllInfo(loaded.value);
  const reports = [];
  for (const notification of notifications(flight)) {
    // Only what had arrived when the server was asked for the last time.
    if (notification.atMs < loaded.atMs || notification.atMs > last.atMs) continue;
    const mine = (notification.method === "OnModuleAttributeChanges" ? notification.args[0].items : [])
      .filter((each) => Number(each[2]) === SHIP && Number(each[3]) === ATTRIBUTE.CHARGE);
    for (const each of mine) {
      clockNow = each[4];
      reports.push({ time: each[4], reported: each[5], previous: each[6], predicted: dogma.attribute(SHIP, ATTRIBUTE.CHARGE, each[4]) });
    }
    dogma.feed(notification);
  }
  assert.ok(reports.length >= 30, `${reports.length} reports of the capacitor`);
  // Two of them are the afterburner's cycles starting: five units gone at once.
  const drains = reports.filter((report) => report.reported < report.predicted - 1);
  assert.deepEqual(drains.map((report) => Math.round(report.predicted - report.reported)), [5, 5]);
  // The report straight after each is the server's own first step from the new value, and is not on the curve.
  const settling = new Set(drains.map((drain) => reports[reports.indexOf(drain) + 1]));
  const recharging = reports.filter((report) => !drains.includes(report) && !settling.has(report) && report !== reports[0]);
  assert.ok(recharging.length >= 26, `${recharging.length} reports while only recharging`);
  for (const report of recharging) {
    // The server rounds what it sends to six places.
    assert.ok(Math.abs(report.predicted - report.reported) < 2e-6, `predicted ${report.predicted}, the server then said ${report.reported}`);
  }
  for (const report of settling) assert.ok(Math.abs(report.predicted - report.reported) < 0.1);
  // The capacitor fell and had not simply come back to full.
  assert.ok(Math.min(...reports.map((report) => report.reported)) < 118);

  // The server's last GetAllInfo repeats its last report, under a later time: ours for that time has recharged a little further.
  const after = flight.capacitor.after;
  assert.deepEqual([after.capacity, after.rechargeRate, after.charge], [125, 62500, reports.at(-1).reported]);
  const ours = dogma.attribute(SHIP, ATTRIBUTE.CHARGE, BigInt(after.time));
  assert.ok(ours > after.charge && ours - after.charge < 0.1, `ours ${ours}, the server's ${after.charge}`);
  // What the live run worked out at the time is what the replay works out.
  assert.ok(Math.abs(ours - flight.capacitor.oursThen.chargeAtServersTime) < 1e-9);
  assert.ok(Math.abs(dogma.shipReadings(SHIP, BigInt(after.time)).capacitorRatio - ours / 125) < 1e-12);
});

test("a change is applied as godma applies one", () => {
  const dogma = small();
  // The charge is set, and recharges from the change's own moment.
  assert.equal(dogma.feed(changes(change(5001n, ATTRIBUTE.CHARGE, seconds(10), 40, { old: 100 }))), true);
  assert.ok(Math.abs(dogma.attribute(5001, ATTRIBUTE.CHARGE, seconds(10)) - 40) < 1e-12);
  const expected = chargeValue(40, seconds(10), 500000 / 5, 100, seconds(30));
  assert.equal(dogma.attribute(5001, ATTRIBUTE.CHARGE, seconds(30)), expected);
  assert.ok(expected > 44 && expected < 50, `${expected} after twenty seconds`);
  // A plain attribute simply takes the value.
  dogma.feed(changes(change(5001n, 4, seconds(11), 2e6)));
  assert.equal(dogma.attribute(5001, 4), 2e6);
  // An item that was never loaded is not made up from a change.
  assert.equal(dogma.applyAttributeChange(7777, 4, seconds(11), 5), false);
  assert.equal(dogma.has(7777), false);
  // The same value again changes nothing (and does not restart a recharge).
  assert.equal(dogma.applyAttributeChange(5001, 4, seconds(12), 2e6), false);
});

test("a change that is someone else's, stale, or for a charge that is not held is not taken", () => {
  const dogma = small();
  dogma.feed(changes(change(5001n, 4, seconds(1), 7, { owner: 140000099 })));
  assert.equal(dogma.attribute(5001, 4), 1e6, "another character's item");
  dogma.feed(changes(change(5001n, 4, seconds(5), 8, { stamp: seconds(5) }), change(5001n, 4, seconds(4), 9, { stamp: seconds(4) })));
  assert.equal(dogma.attribute(5001, 4), 8, "an older change arriving after a newer one is dropped");
  dogma.feed(changes(change([5001n, 27, 2488], 805, seconds(6), 3)));
  assert.equal(dogma.has(5001), true);
  // One change that cannot be read does not lose the ones after it.
  dogma.feed(changes(null, change(5001n, 4, seconds(7), 11)));
  assert.equal(dogma.attribute(5001, 4), 11);
  // The single form of the notification.
  assert.equal(dogma.feed({ method: "OnModuleAttributeChange", args: [PILOT, 5001n, 4, seconds(8), 12, 11, seconds(8)] }), true);
  assert.equal(dogma.attribute(5001, 4), 12);
  // What is not dogma's is not taken at all.
  assert.equal(dogma.feed({ method: "OnSkillsChanged", args: [] }), false);
});

test("when the capacity or the recharge time changes, the charge carries on from what it is", () => {
  // A full capacitor stays full when the capacity grows, and none is ever over a smaller one.
  const full = small({ now: () => seconds(50) });
  full.feed(changes(change(5001n, ATTRIBUTE.CAPACITOR_CAPACITY, seconds(50), 150)));
  assert.equal(full.attribute(5001, ATTRIBUTE.CHARGE, seconds(50)), 150);
  full.feed(changes(change(5001n, ATTRIBUTE.CAPACITOR_CAPACITY, seconds(50), 60)));
  assert.equal(full.attribute(5001, ATTRIBUTE.CHARGE, seconds(50)), 60);
  // A part-full one above a smaller capacity is brought down to it.
  const over = small({ charge: 80, now: () => T0 });
  over.feed(changes(change(5001n, ATTRIBUTE.CAPACITOR_CAPACITY, T0, 50)));
  assert.equal(over.attribute(5001, ATTRIBUTE.CHARGE, T0), 50);
  // A part-full one keeps its charge and recharges towards the new capacity.
  const part = small({ charge: 40, now: () => T0 });
  part.feed(changes(change(5001n, ATTRIBUTE.CAPACITOR_CAPACITY, T0, 200)));
  assert.ok(Math.abs(part.attribute(5001, ATTRIBUTE.CHARGE, T0) - 40) < 1e-9);
  assert.ok(part.attribute(5001, ATTRIBUTE.CHARGE, seconds(100000)) > 199.9);
  // A new recharge time: from what the charge is now, at the new rate.
  const slow = small({ charge: 40, now: () => seconds(20) });
  const before = slow.attribute(5001, ATTRIBUTE.CHARGE, seconds(20));
  slow.feed(changes(change(5001n, ATTRIBUTE.RECHARGE_RATE, seconds(20), 5000000)));
  assert.ok(Math.abs(slow.attribute(5001, ATTRIBUTE.CHARGE, seconds(20)) - before) < 1e-9);
  assert.equal(slow.attribute(5001, ATTRIBUTE.CHARGE, seconds(40)), chargeValue(before, seconds(20), 5000000 / 5, 100, seconds(40)));
  // The shield is the other one that recharges; the readings are fractions and capacities.
  // What was never said (no armour damage, no hull damage, no ship state) is not known, and is not made up.
  assert.deepEqual(small().shipReadings(5001), {
    capacitorRatio: 1, shieldRatio: 1, armorRatio: null, hullRatio: null, shieldCapacity: 200, armorCapacity: 300, hullCapacity: 400,
    activeModuleIDs: [], activeModuleTargets: [], moduleRanges: [], overloadedModuleIDs: [], moduleDamage: {}, weaponBanks: null, rackHeat: null,
  });
  assert.ok(Math.abs(small({ charge: 25 }).shipReadings(5001, T0).capacitorRatio - 0.25) < 1e-12);
});

test("OnMultiEvent: a moment at a time in order, and within one the last change for an attribute is the one that counts", () => {
  const dogma = small();
  const events = {
    type: "list",
    items: [
      // The later moment first: it is still applied second.
      [change(5001n, 4, seconds(9), 30), seconds(9)],
      [change(5001n, 4, seconds(3), 10), seconds(3)],
      [change(5001n, 4, seconds(2), 20), seconds(3)],
      [["OnGodmaShipEffect", 5002n, 6731, seconds(3), 1, 1], seconds(3)],
      [change(5001n, ATTRIBUTE.CHARGE, seconds(3), 50), seconds(3)],
    ],
  };
  assert.equal(dogma.feed({ method: "OnMultiEvent", args: [events] }), true);
  assert.equal(dogma.attribute(5001, 4), 30);
  assert.ok(Math.abs(dogma.attribute(5001, ATTRIBUTE.CHARGE, seconds(3)) - 50) < 1e-9);
  // Within one moment: of 10 (at 3 s) and 20 (at 2 s), the one with the later time wins.
  const one = small();
  one.multiEvent([[change(5001n, 4, seconds(3), 10), seconds(3)], [change(5001n, 4, seconds(2), 20), seconds(3)]]);
  assert.equal(one.attribute(5001, 4), 10);
  one.multiEvent([null, [change(5001n, 4, seconds(4), 44), seconds(4)]]);
  assert.equal(one.attribute(5001, 4), 44);
  // Moments are taken in their own order whatever order they arrive in, even when the changes carry no time of their own to be judged stale by.
  const bare = (attributeID, time, value) => ["OnModuleAttributeChange", PILOT, 5001n, attributeID, time, value, null];
  const ordered = small();
  ordered.multiEvent([[bare(4, seconds(9), 90), seconds(9)], [bare(4, seconds(3), 30), seconds(3)]]);
  assert.equal(ordered.attribute(5001, 4), 90);
});

// ── which modules are running ────────────────────────────────────────────────

/**
 * What kind each effect of a 1MN Civilian Afterburner is, as the game's static
 * data has it (staticData.getEffect): its slot, being online, overloading it,
 * and the afterburner itself. Being online is filed as an activation.
 */
const AFTERBURNER = 6731;
const OVERLOAD_SPEED = 3175;
const KIND = new Map([[13, EFFECT_CATEGORY.PASSIVE], [EFFECT_ONLINE, EFFECT_CATEGORY.ACTIVATION], [OVERLOAD_SPEED, EFFECT_CATEGORY.OVERLOAD], [AFTERBURNER, EFFECT_CATEGORY.ACTIVATION]]);
const effectCategory = (effectID) => KIND.get(effectID) ?? null;
const MODULE = flight.moduleID;

test("a real flight: the afterburner is running from the server's word that it started until its word that it stopped", () => {
  const dogma = createPilotDogma({ characterID: PILOT, effectCategory });
  const loaded = answers(flight).find((answer) => answer.during === "GetAllInfo in space" && answer.value && answer.value.type === "object");
  dogma.loadAllInfo(loaded.value);
  // Fitted and online, which is an active effect, and not running.
  assert.deepEqual([dogma.effect(MODULE, EFFECT_ONLINE).isActive, dogma.effect(MODULE, AFTERBURNER)], [true, null]);
  assert.deepEqual([dogma.shipReadings(SHIP).activeModuleIDs, dogma.shipReadings(SHIP).overloadedModuleIDs], [[], []]);

  const seen = [];
  for (const notification of notifications(flight)) {
    if (notification.atMs < loaded.atMs) continue;
    const taken = dogma.feed(notification);
    if (notification.method === "OnGodmaShipEffect") {
      assert.equal(taken, true);
      seen.push({ during: notification.during, running: dogma.shipReadings(SHIP).activeModuleIDs, effect: { ...dogma.effect(MODULE, AFTERBURNER) } });
    }
  }
  // Two cycles begin, each said by the server; then the stop, at the end of the cycle that was running when it was asked for.
  assert.deepEqual(seen.map((each) => each.running), [[MODULE], [MODULE], []]);
  assert.deepEqual(seen.map((each) => [each.effect.isActive, each.effect.duration, each.effect.repeat, each.effect.targetID]), [[true, 10000, 1000, null], [true, 10000, 1000, null], [false, 10000, 0, null]]);
  // The second cycle began ten seconds after the first, to the tick of the server's clock.
  assert.equal(seen[1].effect.startTime - seen[0].effect.startTime, 10000n * MS);
  assert.deepEqual(seen.map((each) => each.during), ["module running", "module running", "dock"]);
});

test("GetAllInfo taken while a module is running says so by itself", () => {
  const dogma = createPilotDogma({ characterID: PILOT, effectCategory });
  dogma.loadAllInfo(allInfo("GetAllInfo after"));
  const effect = dogma.effect(MODULE, AFTERBURNER);
  assert.deepEqual([effect.isActive, effect.duration, effect.repeat], [true, 10000, 1000]);
  assert.deepEqual(dogma.shipReadings(SHIP).activeModuleIDs, [MODULE]);
  // Without the static data to say what kind an effect is, nothing can be called running.
  const blind = createPilotDogma({ characterID: PILOT });
  blind.loadAllInfo(allInfo("GetAllInfo after"));
  assert.deepEqual(blind.shipReadings(SHIP).activeModuleIDs, []);
  dogma.clear();
  assert.equal(dogma.effect(MODULE, AFTERBURNER), null);
});

/** A dogma holding a ship (5001) and two modules (5003, 5002), nothing running. */
function fitted() {
  const dogma = createPilotDogma({ characterID: PILOT, effectCategory, now: () => T0 });
  const keyVal = (entries) => ({ type: "object", name: Buffer.from("util.KeyVal"), args: { type: "dict", entries: entries.map(([name, value]) => [Buffer.from(name), value]) } });
  const online = (itemID) => [EFFECT_ONLINE, [itemID, PILOT, 5001n, null, null, [], EFFECT_ONLINE, T0, -1, 1]];
  const row = (itemID, activeEffects) => [itemID, keyVal([["itemID", itemID], ["time", T0], ["attributes", { type: "dict", entries: [[4, 1]] }], ["activeEffects", { type: "dict", entries: activeEffects }]])];
  dogma.loadAllInfo(keyVal([["shipInfo", { type: "dict", entries: [row(5001n, []), row(5003n, [online(5003n)]), row(5002n, [online(5002n)])] }]]));
  return dogma;
}
const effectEvent = (itemID, effectID, time, active, { target = null, repeat = 1000 } = {}) => [itemID, effectID, time, active, active, [itemID, PILOT, 5001n, target, null, [], effectID, null], time, 5000, active ? repeat : false, null];
const shipEffect = (...args) => ({ method: "OnGodmaShipEffect", args: effectEvent(...args) });

test("running and overloaded are told apart by the kind of effect, and listed in order", () => {
  const dogma = fitted();
  const of = () => [dogma.shipReadings(5001).activeModuleIDs, dogma.shipReadings(5001).overloadedModuleIDs];
  assert.deepEqual(of(), [[], []]);
  dogma.feed(shipEffect(5003n, AFTERBURNER, seconds(1), 1, { target: 9000000000001n }));
  dogma.feed(shipEffect(5002n, AFTERBURNER, seconds(2), 1));
  assert.deepEqual(of(), [[5002, 5003], []]);
  assert.equal(dogma.effect(5003, AFTERBURNER).targetID, 9000000000001n);
  // Overloading a module is an effect of its own kind: the module is overloaded, and that alone does not make it running.
  dogma.feed(shipEffect(5002n, OVERLOAD_SPEED, seconds(3), 1));
  dogma.feed(shipEffect(5002n, AFTERBURNER, seconds(4), 0));
  assert.deepEqual(of(), [[5003], [5002]]);
  // A passive effect, and an effect of a kind the static data does not know, are neither.
  dogma.feed(shipEffect(5003n, 13, seconds(5), 1));
  dogma.feed(shipEffect(5003n, 424242, seconds(5), 1));
  dogma.feed(shipEffect(5003n, AFTERBURNER, seconds(6), 0));
  assert.deepEqual(of(), [[], [5002]]);
  // The ship itself is not one of its modules, and an item that is not held is not made up.
  dogma.feed(shipEffect(5001n, AFTERBURNER, seconds(7), 1));
  assert.equal(dogma.feed(shipEffect(7777n, AFTERBURNER, seconds(7), 1)), true);
  assert.deepEqual([of(), dogma.effect(7777, AFTERBURNER)], [[[], [5002]], null]);
});

test("OnMultiEvent: of the starts and stops of one effect in one moment, the last one is what stands", () => {
  const dogma = fitted();
  const event = (...args) => ["OnGodmaShipEffect", ...effectEvent(...args)];
  // Stop (at 3 s) and start (at 2 s) in one moment, out of order: the stop is the later.
  dogma.multiEvent([[event(5003n, AFTERBURNER, seconds(3), 0), seconds(3)], [event(5003n, AFTERBURNER, seconds(2), 1), seconds(3)], [event(5002n, AFTERBURNER, seconds(2), 1), seconds(3)]]);
  assert.deepEqual(dogma.shipReadings(5001).activeModuleIDs, [5002]);
  assert.equal(dogma.feed({ method: "OnMultiEvent", args: [{ type: "list", items: [[event(5003n, AFTERBURNER, seconds(4), 1), seconds(4)]] }] }), true);
  assert.deepEqual(dogma.shipReadings(5001).activeModuleIDs, [5002, 5003]);
  // Two different effects on one module in one moment are two things, and both stand.
  const both = fitted();
  both.multiEvent([[event(5002n, AFTERBURNER, seconds(2), 1), seconds(2)], [event(5002n, OVERLOAD_SPEED, seconds(2), 1), seconds(2)]]);
  assert.deepEqual([both.shipReadings(5001).activeModuleIDs, both.shipReadings(5001).overloadedModuleIDs], [[5002], [5002]]);
});

test("an active effect that cannot be read is passed over, and the rest of the item is still loaded", () => {
  const dogma = createPilotDogma({ characterID: PILOT, effectCategory, now: () => T0 });
  const keyVal = (entries) => ({ type: "object", name: Buffer.from("util.KeyVal"), args: { type: "dict", entries: entries.map(([name, value]) => [Buffer.from(name), value]) } });
  const good = [5002n, PILOT, 5001n, null, null, [], AFTERBURNER, T0, 5000, 1000];
  dogma.loadAllInfo(keyVal([["shipInfo", { type: "dict", entries: [
    [5001n, keyVal([["itemID", 5001n], ["time", T0], ["attributes", { type: "dict", entries: [[4, 1]] }]])],
    [5002n, keyVal([["itemID", 5002n], ["time", T0], ["attributes", { type: "dict", entries: [[4, 1]] }], ["activeEffects", { type: "dict", entries: [[OVERLOAD_SPEED, null], [AFTERBURNER, good]] }]])],
  ] }]]));
  assert.deepEqual([dogma.has(5002), dogma.effect(5002, OVERLOAD_SPEED), dogma.shipReadings(5001).activeModuleIDs], [true, null, [5002]]);
});

// ── the ship's health, its modules' damage and its weapon banks ──────────────
//
// The ship's panel reads its own health from godma (activeShipController.py):
// shieldCharge / shieldCapacity, (armorHP - armorDamage) / armorHP,
// (hp - damage) / hp. A module's damage is its damage over its hp. The banks
// are the third part of the ship's state in GetAllInfo.

const HEALTH_T = 134359220000000000n;
const row7 = (fields) => ({ type: "packedrow", fields });
const kv = (fields) => ({ type: "object", name: Buffer.from("util.KeyVal"), args: { type: "dict", entries: Object.entries(fields).map(([name, value]) => [Buffer.from(name), value]) } });
const attrs = (pairs) => ({ type: "dict", entries: pairs });
const shipRow = (shipID, pairs) => [BigInt(shipID), kv({ itemID: BigInt(shipID), invItem: row7({ itemID: shipID, typeID: 588, locationID: 30000142, flagID: 0, groupID: 237, categoryID: 6 }), time: HEALTH_T, attributes: attrs(pairs), activeEffects: attrs([]) })];
const fittedModule = (itemID, { damage = 0, hp = 40, categoryID = 7, locationID = 5001, flagID = 27 } = {}) =>
  [BigInt(itemID), kv({ itemID: BigInt(itemID), invItem: row7({ itemID, typeID: 3636, locationID, flagID, groupID: 53, categoryID }), time: HEALTH_T, attributes: attrs([[ATTRIBUTE.DAMAGE, damage], [ATTRIBUTE.HP, hp]]), activeEffects: attrs([]) })];
const HEALTHY = [[ATTRIBUTE.HP, 150], [ATTRIBUTE.DAMAGE, 0], [ATTRIBUTE.ARMOR_HP, 150], [ATTRIBUTE.ARMOR_DAMAGE, 0], [ATTRIBUTE.SHIELD_CAPACITY, 175], [ATTRIBUTE.SHIELD_CHARGE, 175], [ATTRIBUTE.SHIELD_RECHARGE_RATE, 730000], [ATTRIBUTE.CAPACITOR_CAPACITY, 125], [ATTRIBUTE.CHARGE, 125], [ATTRIBUTE.RECHARGE_RATE, 62500]];
const withAttributes = (changes) => HEALTHY.map(([id, value]) => [id, id in changes ? changes[id] : value]);
function loaded(rows, { shipState, activeShipID = 5001n } = {}) {
  const dogma = createPilotDogma({ characterID: PILOT, now: () => HEALTH_T });
  const fields = { shipInfo: attrs(rows) };
  if (shipState !== undefined) Object.assign(fields, { shipState, activeShipID });
  dogma.loadAllInfo(kv(fields));
  return dogma;
}
const bankState = (banks) => [attrs([]), attrs([]), attrs(Object.entries(banks).map(([master, slaves]) => [BigInt(master), { type: "list", items: slaves.map(BigInt) }])), attrs([])];
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test("the ship's health is what is left of each of its three, as godma has them", () => {
  const readings = (changes) => loaded([shipRow(5001, withAttributes(changes))]).shipReadings(5001);
  assert.deepEqual([readings({}).shieldRatio, readings({}).armorRatio, readings({}).hullRatio], [1, 1, 1]);
  // Armour 52.5 down of 150, hull 30 down of 150: 0.65 and 0.8.
  const hurt = readings({ [ATTRIBUTE.ARMOR_DAMAGE]: 52.5, [ATTRIBUTE.DAMAGE]: 30 });
  near(hurt.armorRatio, 0.65);
  near(hurt.hullRatio, 0.8);
  // The shield recharges by itself: read at the moment it was true, it is what was said.
  near(readings({ [ATTRIBUTE.SHIELD_CHARGE]: 70 }).shieldRatio, 0.4);
  const later = loaded([shipRow(5001, withAttributes({ [ATTRIBUTE.SHIELD_CHARGE]: 70 }))]).shipReadings(5001, HEALTH_T + 600n * 10000000n);
  assert.ok(later.shieldRatio > 0.4 && later.shieldRatio <= 1, "and ten minutes on it has climbed");
  // More damage than there is to damage is none left, not less than none; and damage below nothing is whole.
  assert.deepEqual([readings({ [ATTRIBUTE.ARMOR_DAMAGE]: 500 }).armorRatio, readings({ [ATTRIBUTE.DAMAGE]: 500 }).hullRatio], [0, 0]);
  assert.deepEqual([readings({ [ATTRIBUTE.ARMOR_DAMAGE]: -5 }).armorRatio, readings({ [ATTRIBUTE.DAMAGE]: -5 }).hullRatio], [1, 1]);
  // Nothing to be a fraction of: not known.
  assert.deepEqual([readings({ [ATTRIBUTE.ARMOR_HP]: 0 }).armorRatio, readings({ [ATTRIBUTE.HP]: 0 }).hullRatio, readings({ [ATTRIBUTE.SHIELD_CAPACITY]: 0 }).shieldRatio], [null, null, null]);
});

test("the ship's health follows the server's changes", () => {
  const dogma = loaded([shipRow(5001, HEALTHY)]);
  const stamp = HEALTH_T + 10000000n;
  dogma.feed(changes(change(5001n, ATTRIBUTE.ARMOR_DAMAGE, stamp, 75, { stamp }), change(5001n, ATTRIBUTE.DAMAGE, stamp, 15, { stamp })));
  const now = dogma.shipReadings(5001, stamp);
  near(now.armorRatio, 0.5);
  near(now.hullRatio, 0.9);
});

test("each fitted module's damage is its damage over its hp, and only the damaged ones are named", () => {
  const dogma = loaded([
    shipRow(5001, withAttributes({ [ATTRIBUTE.DAMAGE]: 30 })),
    fittedModule(101, { damage: 7.2 }),
    fittedModule(102),
    fittedModule(103, { damage: 40 }),
    fittedModule(104, { damage: 55 }),
    // Not modules of this ship: a charge at a slot's flag, a module in another ship, a module with no hp.
    fittedModule(105, { damage: 5, categoryID: 8 }),
    fittedModule(106, { damage: 5, locationID: 6001 }),
    fittedModule(107, { damage: 5, hp: 0 }),
  ]);
  // The ship's own hull damage is not a module's; burnt out is 1, and so is more than that.
  assert.deepEqual(dogma.shipReadings(5001).moduleDamage, { 101: 0.18, 103: 1, 104: 1 });
  // Heat does more, and a repair undoes it.
  const stamp = HEALTH_T + 10000000n;
  dogma.feed(changes(change(102n, ATTRIBUTE.DAMAGE, stamp, 10, { stamp }), change(101n, ATTRIBUTE.DAMAGE, stamp, 0, { stamp })));
  assert.deepEqual(dogma.shipReadings(5001).moduleDamage, { 102: 0.25, 103: 1, 104: 1 });
  assert.deepEqual(loaded([shipRow(5001, HEALTHY), fittedModule(101)]).shipReadings(5001).moduleDamage, {});
});

test("the weapon banks are the third part of the active ship's state, and null when no state came", () => {
  const dogma = loaded([shipRow(5001, HEALTHY)], { shipState: bankState({ 102: [103, 101, 102], 200: [201] }) });
  // Slaves in order, and a master is not its own slave.
  assert.deepEqual(dogma.weaponBanks(5001), { 102: [101, 103], 200: [201] });
  assert.deepEqual(dogma.shipReadings(5001).weaponBanks, { 102: [101, 103], 200: [201] });
  assert.equal(dogma.weaponBanks(6001), null, "another ship's are not known");
  // A state with no banks is no banks, which is not the same as not knowing.
  assert.deepEqual(loaded([shipRow(5001, HEALTHY)], { shipState: bankState({}) }).weaponBanks(5001), {});
  assert.equal(loaded([shipRow(5001, HEALTHY)]).weaponBanks(5001), null);
  // The banks go to the ship the answer names as the active one.
  assert.deepEqual(loaded([shipRow(5001, HEALTHY)], { shipState: bankState({ 102: [103] }), activeShipID: 6001n }).weaponBanks(5001), null);
  // A state that is not the four parts, or names no active ship, is no state.
  assert.equal(loaded([shipRow(5001, HEALTHY)], { shipState: [attrs([]), attrs([])] }).weaponBanks(5001), null);
  const unnamed = loaded([shipRow(5001, HEALTHY)], { shipState: bankState({ 102: [103] }), activeShipID: null });
  assert.deepEqual([unnamed.weaponBanks(5001), unnamed.weaponBanks(null)], [null, null], "and is kept under no ship at all");
  dogma.clear();
  assert.equal(dogma.weaponBanks(5001), null);
});

test("the banks change by the server's word, and by the answers to the client's own grouping calls", () => {
  const dogma = loaded([shipRow(5001, HEALTHY)], { shipState: bankState({ 102: [103] }) });
  // OnWeaponBanksChanged: the whole set, anew.
  assert.equal(dogma.feed({ method: "OnWeaponBanksChanged", args: [5001n, attrs([[104n, { type: "list", items: [105n, 106n] }]])] }), true);
  assert.deepEqual(dogma.weaponBanks(5001), { 104: [105, 106] });
  // As a tuple of slaves, and for a ship not seen before.
  dogma.feed({ method: "OnWeaponBanksChanged", args: [6001n, attrs([[1n, [2n]]])] });
  assert.deepEqual([dogma.weaponBanks(6001), dogma.weaponBanks(5001)], [{ 1: [2] }, { 104: [105, 106] }]);
  // OnWeaponGroupDestroyed: that master's bank is gone.
  assert.equal(dogma.feed({ method: "OnWeaponGroupDestroyed", args: [5001n, 104n] }), true);
  assert.deepEqual(dogma.weaponBanks(5001), {});
  dogma.feed({ method: "OnWeaponGroupDestroyed", args: [7001n, 1n] });
  dogma.feed({ method: "OnWeaponGroupDestroyed" });
  dogma.feed({ method: "OnWeaponBanksChanged" });
  assert.deepEqual(dogma.weaponBanks(6001), { 1: [2] });
  // The client's own: the answer to a link is the banks; an unlink takes one slave out, and an empty bank is gone.
  dogma.setWeaponBanks(5001n, attrs([[102n, { type: "list", items: [103n, 104n] }]]));
  assert.deepEqual(dogma.weaponBanks(5001), { 102: [103, 104] });
  dogma.unlinkModule(5001n, 102n, 104n);
  assert.deepEqual(dogma.weaponBanks(5001), { 102: [103] });
  dogma.unlinkModule(5001n, 999n, 103n);
  dogma.unlinkModule(7001n, 102n, 103n);
  assert.deepEqual(dogma.weaponBanks(5001), { 102: [103] });
  dogma.unlinkModule(5001n, 102n, 103n);
  assert.deepEqual(dogma.weaponBanks(5001), {});
  dogma.setWeaponBanks(5001n, attrs([[102n, [103n]]]));
  dogma.setWeaponBanks(5001n, null);
  assert.deepEqual(dogma.weaponBanks(5001), {}, "no banks is none, and known");
});

// ── a real damaged ship ──────────────────────────────────────────────────────
//
// test/fixtures/dogmaDamaged.json (scripts/record-dogma.js): a Reaper given
// the GM's medium test damage while docked, with two guns grouped, undocked.
// The server tells a client of that ship's health twice over: in GetAllInfo,
// as dogma attributes, and in the ballpark, as a damage state. The two have to
// agree, or the ship's own panel and everyone else's view of it differ.

const damaged = require("./fixtures/dogmaDamaged.json");
const damagedInfo = (during) => answers(damaged).find((answer) => answer.during === during && answer.value && answer.value.type === "object").value;
/** The damage state the ballpark was sent for a ship: ((shield, tau, when), armour, hull), wherever it is in the updates. */
function damageStateOf(recording, shipID) {
  const wanted = BigInt(shipID);
  let found = null;
  const walk = (node, depth) => {
    if (found || depth > 12 || node === null || typeof node !== "object" || Buffer.isBuffer(node)) return;
    if (node.type === "dict" && Array.isArray(node.entries)) {
      for (const [name, value] of node.entries) {
        if ((name === wanted || name === Number(wanted)) && Array.isArray(value) && Array.isArray(value[0])) found = value;
        else walk(value, depth + 1);
      }
      return;
    }
    for (const value of Array.isArray(node) ? node : Object.values(node)) walk(value, depth + 1);
  };
  for (const notification of notifications(recording)) if (notification.method === "DoDestinyUpdate") walk(notification.args, 0);
  return found;
}

test("a real damaged ship: godma's health is the health the server's own ballpark gives for it", () => {
  const dogma = createPilotDogma({ characterID: damaged.characterID });
  dogma.loadAllInfo(damagedInfo("GetAllInfo in space"));
  const state = damageStateOf(damaged, damaged.shipID);
  assert.ok(state, "the recording has the ship's damage state");
  const [[shield], armour, hull] = state;
  assert.deepEqual([shield, armour, hull], [1, 0.65, 0.8], "the GM's medium damage");
  const time = BigInt(new Map(damagedInfo("GetAllInfo in space").args.entries.map(([name, value]) => [name.toString(), value])).get("shipInfo").entries[0][1].args.entries.find(([name]) => name.toString() === "time")[1]);
  const readings = dogma.shipReadings(damaged.shipID, time);
  assert.ok(Math.abs(readings.shieldRatio - shield) < 1e-6, `shield ${readings.shieldRatio}`);
  assert.ok(Math.abs(readings.armorRatio - armour) < 1e-6, `armour ${readings.armorRatio}`);
  assert.ok(Math.abs(readings.hullRatio - hull) < 1e-6, `hull ${readings.hullRatio}`);
});

test("a real damaged ship: each fitted module's damage, and the two guns in one bank", () => {
  const dogma = createPilotDogma({ characterID: damaged.characterID });
  dogma.loadAllInfo(damagedInfo("GetAllInfo in space"));
  const readings = dogma.shipReadings(damaged.shipID);
  // Three fitted modules, each 7.2 down of 40: what the web gateway's own snapshot said of them, 0.18.
  const modules = Object.keys(readings.moduleDamage).map(Number).sort((a, b) => a - b);
  assert.equal(modules.length, 3);
  for (const moduleID of modules) assert.ok(Math.abs(readings.moduleDamage[moduleID] - 0.18) < 1e-9, `${moduleID}: ${readings.moduleDamage[moduleID]}`);
  assert.ok(modules.includes(damaged.moduleID));
  // The bank the server answered LinkWeapons with when the two were grouped: the master, and its one slave.
  const banks = Object.entries(readings.weaponBanks);
  assert.equal(banks.length, 1);
  const [master, slaves] = banks[0];
  assert.equal(slaves.length, 1);
  assert.ok(modules.includes(Number(master)) && modules.includes(slaves[0]) && Number(master) !== slaves[0]);
  // Docked, the same ship says the same of its modules and its bank.
  const docked = createPilotDogma({ characterID: damaged.characterID });
  docked.loadAllInfo(damagedInfo("GetAllInfo docked"));
  assert.deepEqual(docked.shipReadings(damaged.shipID).weaponBanks, readings.weaponBanks);
  assert.deepEqual(Object.keys(docked.shipReadings(damaged.shipID).moduleDamage).map(Number).sort((a, b) => a - b), modules);
});

// ── rack heat ────────────────────────────────────────────────────────────────

const { HEAT, calculateHeat } = require("../src/gamePort/pilotDogma");

// What the client's own compiled CalculateHeat (dogma/attributes/heatAttribute) gave, run in the client's own
// Python: currentHeat, timeDiff in ms, incomingHeat, dissipationRate, heatGenerationMul, heatCap, and the answer.
const CLIENT_HEAT = [
  [0, 0, 0, 0.01, 1, 100, 0],
  [50, 1000, 0, 0.01, 1, 100, 49.5024916874584],
  [50, 60000, 0, 0.01, 1, 100, 27.440581804701324],
  [0.6, 1000, 0, 0.01, 1, 100, 0.5940299002495009],
  [0.5, 1000, 0, 0.01, 1, 100, 0],
  [0.4, 0, 0, 0.01, 1, 100, 0],
  [100, 600000, 0, 0.01, 1, 100, 0],
  [0, 1000, 0.04, 0.01, 1, 100, 3.9210560847676845],
  [0, 10000, 0.04, 0.01, 1, 100, 32.967995396436066],
  [30, 5000, 0.04, 0.01, 1, 100, 42.68884728454127],
  [30, 5000, 0.08, 0.01, 1.5, 100, 61.583185473418155],
  [30, 5000, 0.01, 0.01, 1, 120, 34.389351794935735],
  [99, 600000, 0.02, 0.01, 1, 100, 99.99999385578765],
  [30, 5000, 5e-8, 0.01, 1, 100, 30.000017499997806],
  [30, 5000, 4.9e-8, 0.01, 1, 100, 28.536882735021422],
  [30, 0, 0.04, 0.01, 1, 100, 30],
];

test("calculateHeat is the client's own CalculateHeat, case for case", () => {
  for (const [currentHeat, timeDiff, incomingHeat, dissipationRate, heatGenerationMul, heatCap, expected] of CLIENT_HEAT) {
    const got = calculateHeat(currentHeat, timeDiff, incomingHeat, dissipationRate, heatGenerationMul, heatCap);
    const told = `(${[currentHeat, timeDiff, incomingHeat, dissipationRate, heatGenerationMul, heatCap].join(", ")}) gave ${got}, the client ${expected}`;
    if (expected === 0) assert.equal(got, 0, told);
    else assert.ok(Math.abs(got - expected) <= 1e-12 * expected, told);
  }
});

const HEAT_HI = 1175;
const HEAT_MED = 1176;
const HEAT_LOW = 1177;
const RACKS = [[1178, 100], [1199, 100], [1200, 100], [1179, 0.01], [1196, 0.01], [1198, 0.01], [1224, 1]];
/** A module that heats: its heatAbsorbtionRateModifier, fitted to a ship. */
const heater = (itemID, rate = 0.04, locationID = 5001) =>
  [BigInt(itemID), kv({ itemID: BigInt(itemID), invItem: row7({ itemID, typeID: 21857, locationID, flagID: 19, groupID: 46, categoryID: 7 }), time: HEALTH_T, attributes: attrs([[1180, rate], [ATTRIBUTE.HP, 40]]), activeEffects: attrs([]) })];
/** A ship with racks and its heaters, on a clock that can be moved: `at(seconds)` is that long after the load. */
function heated({ racks = RACKS, rows = [heater(101), heater(102), heater(103, 0.02)] } = {}) {
  const at = (s) => HEALTH_T + BigInt(Math.round(s * 1000)) * MS;
  const clock = { now: HEALTH_T };
  const dogma = createPilotDogma({ characterID: PILOT, now: () => clock.now });
  dogma.loadAllInfo(kv({ shipInfo: attrs([shipRow(5001, [...HEALTHY, ...racks]), ...rows]) }));
  const told = (seconds, notification) => {
    clock.now = at(seconds);
    return dogma.feed(notification);
  };
  const heat = (seconds, shipID = 5001) => dogma.rackHeat(shipID, at(seconds));
  return { dogma, clock, at, told, heat };
}
const heatAdded = (heatID, moduleID) => ({ method: "OnHeatAdded", args: [heatID, BigInt(moduleID)] });
const heatRemoved = (heatID, moduleID) => ({ method: "OnHeatRemoved", args: [heatID, BigInt(moduleID)] });
const withRacks = (changes) => RACKS.map(([id, value]) => [id, id in changes ? changes[id] : value]);

test("a ship with racks starts with what its row says of their heat, and a ship that names none has no heat reading", () => {
  assert.deepEqual([...HEAT].map(([heatID, { family }]) => [heatID, family]), [[HEAT_HI, "high"], [HEAT_MED, "mid"], [HEAT_LOW, "low"]]);
  const cold = heated();
  assert.deepEqual(cold.heat(0), { high: 0, mid: 0, low: 0 });
  assert.deepEqual(cold.heat(3600), { high: 0, mid: 0, low: 0 }, "and stays cold");
  assert.deepEqual(cold.dogma.shipReadings(5001).rackHeat, { high: 0, mid: 0, low: 0 });
  // No capacities in the row: nothing is known of its racks, which is not the same as cold.
  const bare = loaded([shipRow(5001, HEALTHY)]);
  assert.equal(bare.rackHeat(5001), null);
  assert.equal(bare.shipReadings(5001).rackHeat, null);
  assert.equal(cold.dogma.rackHeat(6001), null, "a ship that was never loaded");
  assert.equal(cold.dogma.rackHeat(101), null, "a module has no racks");
  // HeatAttribute.__init__: the row's value, no more than the capacity, true from the load.
  const warm = heated({ racks: [...RACKS, [HEAT_HI, 250], [HEAT_MED, 50]] });
  assert.deepEqual(warm.heat(0), { high: 1, mid: 0.5, low: 0 });
  near(warm.heat(60).mid, 27.440581804701324 / 100);
  // Each rack has its own capacity and its own rate of cooling.
  const each = heated({ racks: [...withRacks({ 1178: 100, 1199: 80, 1200: 120, 1179: 0.01, 1196: 0.02, 1198: 0.03 }), [HEAT_HI, 40], [HEAT_MED, 40], [HEAT_LOW, 40]] });
  assert.deepEqual(each.heat(0), { high: 0.4, mid: 0.5, low: 40 / 120 });
  const minute = each.heat(60);
  near(minute.high, (40 * Math.exp(-0.6)) / 100);
  near(minute.mid, (40 * Math.exp(-1.2)) / 80);
  near(minute.low, (40 * Math.exp(-1.8)) / 120);
  // One capacity is enough to say the ship has racks; a rack whose capacity is nothing reads nothing.
  const one = heated({ racks: [[1178, 100], [1179, 0.01], [1224, 1], [HEAT_HI, 50], [HEAT_LOW, 50]] });
  assert.deepEqual(one.heat(0), { high: 0.5, mid: 0, low: 0 });
});

test("the server's word for a rack's heat stands from the moment it arrives, and cools from there as the client reckons", () => {
  const ship = heated();
  // Stamped three seconds in, arriving ten seconds in: SetBaseValue takes the moment it arrives.
  assert.equal(ship.told(10, changes(change(5001n, HEAT_HI, ship.at(3), 50))), true);
  assert.deepEqual(ship.heat(10), { high: 0.5, mid: 0, low: 0 });
  near(ship.heat(11).high, 49.5024916874584 / 100);
  near(ship.heat(70).high, 27.440581804701324 / 100);
  near(ship.dogma.shipReadings(5001, ship.at(70)).rackHeat.high, 27.440581804701324 / 100);
  assert.equal(ship.heat(610).high, 0, "cooled to what rounds to nothing, it is nothing");
  // The same number again a minute on is news: by then the gauge had it at 27.
  ship.told(70, changes(change(5001n, HEAT_HI, ship.at(70), 50)));
  assert.equal(ship.heat(70).high, 0.5);
  near(ship.heat(71).high, 49.5024916874584 / 100);
  // A new number replaces the old, and each rack is its own.
  ship.told(80, changes(change(5001n, HEAT_HI, ship.at(80), 12), change(5001n, HEAT_LOW, ship.at(80), 0.6)));
  assert.equal(ship.heat(80).high, 0.12);
  near(ship.heat(81).low, 0.5940299002495009 / 100);
  assert.equal(ship.heat(80).mid, 0);
  // Half a point, a second on, rounds to nothing.
  ship.told(90, changes(change(5001n, HEAT_MED, ship.at(90), 0.5)));
  assert.equal(ship.heat(91).mid, 0);
  // Someone else's change is not taken; nor one that carries no number.
  ship.told(100, changes(change(5001n, HEAT_HI, ship.at(100), 90, { owner: PILOT + 1 })));
  assert.ok(ship.heat(100).high < 0.12);
  ship.told(101, changes(change(5001n, HEAT_HI, ship.at(101), null)));
  assert.ok(ship.heat(101).high < 0.12 && ship.heat(101).high > 0);
  // A heat change for something with no racks is an attribute change like any other.
  assert.doesNotThrow(() => ship.told(102, changes(change(101n, HEAT_HI, ship.at(102), 5))));
  assert.equal(ship.dogma.attribute(101, HEAT_HI), 5);
  assert.equal(ship.dogma.rackHeat(101), null);
  // The ship's own rates changing: what went before is reckoned at the old rate, what comes after at the new.
  const faster = heated();
  faster.told(10, changes(change(5001n, HEAT_HI, faster.at(10), 50)));
  faster.told(70, changes(change(5001n, 1179, faster.at(70), 0.02)));
  near(faster.heat(70).high, 27.440581804701324 / 100);
  near(faster.heat(130).high, (27.440581804701324 * Math.exp(-1.2)) / 100);
  // A capacity of nothing reads nothing, whatever the heat is said to be.
  const none = heated({ racks: withRacks({ 1178: 0 }) });
  none.told(0, changes(change(5001n, HEAT_HI, none.at(0), 30)));
  assert.equal(none.heat(0).high, 0);
});

test("a module the server says is heating a rack adds its absorption rate, and the rack climbs toward its capacity", () => {
  // From cold, one module of 0.04.
  const cold = heated();
  assert.equal(cold.told(0, heatAdded(HEAT_HI, 101)), true);
  near(cold.heat(1).high, 3.9210560847676845 / 100);
  near(cold.heat(10).high, 32.967995396436066 / 100);
  assert.deepEqual([cold.heat(10).mid, cold.heat(10).low], [0, 0], "the other racks are not heated");
  // From 30, five seconds: one module, then two with a generation multiplier of 1.5, then a slow one under a capacity of 120.
  const one = heated();
  one.told(0, changes(change(5001n, HEAT_HI, one.at(0), 30)));
  one.told(0, heatAdded(HEAT_HI, 101));
  assert.equal(one.heat(0).high, 0.3);
  near(one.heat(5).high, 42.68884728454127 / 100);
  const two = heated({ racks: withRacks({ 1224: 1.5 }) });
  two.told(0, changes(change(5001n, HEAT_MED, two.at(0), 30)));
  two.told(0, heatAdded(HEAT_MED, 101));
  two.told(0, heatAdded(HEAT_MED, 102));
  near(two.heat(5).mid, 61.583185473418155 / 100);
  const slow = heated({ racks: withRacks({ 1200: 120 }), rows: [heater(101, 0.01)] });
  slow.told(0, changes(change(5001n, HEAT_LOW, slow.at(0), 30)));
  slow.told(0, heatAdded(HEAT_LOW, 101));
  near(slow.heat(5).low, 34.389351794935735 / 120);
  // A module joining later: the rack is brought to that moment at the old rate, and goes on at the new.
  cold.told(10, heatAdded(HEAT_HI, 103));
  near(cold.heat(10).high, 32.967995396436066 / 100);
  near(cold.heat(15).high, calculateHeat(32.967995396436066, 5000, 0.06, 0.01, 1, 100) / 100);
  // The same module said twice is one module.
  cold.told(15, heatAdded(HEAT_HI, 103));
  near(cold.heat(20).high, calculateHeat(32.967995396436066, 10000, 0.06, 0.01, 1, 100) / 100);
});

test("a module that stops heating is taken off, and the rack cools from where it had got to", () => {
  const ship = heated();
  ship.told(0, changes(change(5001n, HEAT_HI, ship.at(0), 30)));
  ship.told(0, heatAdded(HEAT_HI, 101));
  assert.equal(ship.told(5, heatRemoved(HEAT_HI, 101)), true);
  near(ship.heat(5).high, 42.68884728454127 / 100);
  near(ship.heat(65).high, (42.68884728454127 * Math.exp(-0.6)) / 100);
  // Two heating, one stops: the other still heats.
  const pair = heated();
  pair.told(0, heatAdded(HEAT_HI, 101));
  pair.told(0, heatAdded(HEAT_HI, 103));
  pair.told(10, heatRemoved(HEAT_HI, 103));
  const atTen = calculateHeat(0, 10000, 0.06, 0.01, 1, 100);
  near(pair.heat(10).high, atTen / 100);
  near(pair.heat(20).high, calculateHeat(atTen, 10000, 0.04, 0.01, 1, 100) / 100);
  // What cannot be placed changes nothing and breaks nothing: a module not held, a rack that is no rack,
  // a module fitted to a ship that was not loaded, a notification with nothing in it.
  const before = pair.heat(20);
  for (const notification of [heatAdded(HEAT_HI, 999), heatAdded(9999, 101), heatRemoved(HEAT_MED, 999), { method: "OnHeatAdded", args: null }, { method: "OnHeatRemoved", args: [] }]) {
    assert.equal(pair.told(10, notification), true);
  }
  const elsewhere = heated({ rows: [heater(201, 0.04, 6001)] });
  elsewhere.told(0, heatAdded(HEAT_HI, 201));
  assert.deepEqual(elsewhere.heat(10), { high: 0, mid: 0, low: 0 });
  assert.deepEqual(pair.heat(20), before);
  // The rate is the module's as it is at the time: a module told of later, with a rate changed since.
  pair.told(20, changes(change(101n, 1180, pair.at(20), 0.08)));
  near(pair.heat(21).high, calculateHeat(before.high * 100, 1000, 0.08, 0.01, 1, 100) / 100);
});

test("a rack's heat is the ship item's: kept while that ship is loaded again, gone when another ship is", () => {
  const ship = heated();
  const reload = (seconds, rows) => {
    ship.clock.now = ship.at(seconds);
    ship.dogma.clear();
    assert.equal(ship.dogma.rackHeat(5001), null, "between the flush and the load nothing is said");
    ship.dogma.loadAllInfo(kv({ shipInfo: attrs(rows) }));
  };
  const again = shipRow(5001, [...HEALTHY, ...RACKS, [HEAT_HI, 20]]);
  ship.told(0, changes(change(5001n, HEAT_HI, ship.at(0), 60)));
  ship.told(0, heatAdded(HEAT_HI, 101));
  const atFive = calculateHeat(60, 5000, 0.04, 0.01, 1, 100);
  near(ship.heat(5).high, atFive / 100);
  // A dock, an undock or a jump in the same ship: godma is flushed and loaded again, and the heat carries on
  // with what was heating it. The row's own word for the heat is not taken: the item was not made anew.
  reload(5, [again, heater(101)]);
  near(ship.heat(5).high, atFive / 100);
  near(ship.heat(10).high, calculateHeat(atFive, 5000, 0.04, 0.01, 1, 100) / 100);
  // Loaded again without the module: it heats nothing from then, and what went before it left is not lost.
  reload(10, [again]);
  const atTen = calculateHeat(atFive, 5000, 0.04, 0.01, 1, 100);
  near(ship.heat(10).high, atTen / 100);
  near(ship.heat(20).high, (atTen * Math.exp(-0.1)) / 100);
  // The module back aboard does not heat until the server says so again.
  reload(20, [again, heater(101)]);
  near(ship.heat(30).high, (atTen * Math.exp(-0.2)) / 100);
  // Another ship: the old one was unloaded and its heat with it. Back in it, it is a new item, from its row.
  reload(30, [shipRow(6001, [...HEALTHY, ...RACKS])]);
  assert.equal(ship.dogma.rackHeat(5001), null);
  assert.deepEqual(ship.heat(30, 6001), { high: 0, mid: 0, low: 0 });
  reload(40, [again]);
  assert.equal(ship.heat(40).high, 0.2);
  near(ship.heat(100).high, (20 * Math.exp(-0.6)) / 100);
});

test("the ship's online modules, by the slot each is in: fitted to this ship, with the online effect running", () => {
  const online = [EFFECT_ONLINE, [0n, PILOT, 5001n, null, null, [], EFFECT_ONLINE, HEALTH_T, -1, 1]];
  const lit = (row) => {
    row[1].args.entries.find(([name]) => name.toString() === "activeEffects")[1] = attrs([online]);
    return row;
  };
  const dogma = loaded([
    shipRow(5001, HEALTHY),
    lit(fittedModule(5003, { flagID: 27 })),
    fittedModule(5004, { flagID: 28 }), // fitted, not online
    lit(fittedModule(5002, { flagID: 19 })),
    lit(fittedModule(6002, { flagID: 11, locationID: 6001 })), // online, in another ship
  ]);
  // In the order the server listed them: [flagID, moduleID].
  assert.deepEqual(dogma.onlineModules(5001), [[27, 5003], [19, 5002]]);
  assert.deepEqual(dogma.onlineModules(5001n), [[27, 5003], [19, 5002]]);
  assert.deepEqual(dogma.onlineModules(6001), [[11, 6002]]);
  assert.deepEqual(dogma.onlineModules(7000), []);
  // The server says one has gone offline.
  dogma.feed({ method: "OnGodmaShipEffect", args: [5003n, EFFECT_ONLINE, HEALTH_T, 0, 0, [5003n, PILOT, 5001n, null, null, [], EFFECT_ONLINE, null], HEALTH_T, 0, 0, null] });
  assert.deepEqual(dogma.onlineModules(5001), [[19, 5002]]);
  // What each is, for naming its effect.
  assert.deepEqual([dogma.typeOf(5002), dogma.typeOf(5002n), dogma.typeOf(5001), dogma.typeOf(9999)], [3636, 3636, 588, null]);
});

// ── an item fitted, moved or taken out while the ship is held ────────────────
//
// The server tells of an item that has moved with OnItemsChanged(items, change, location), each item its
// inventory row as it is now, and of one alone with OnItemChange(item, change, location). The client's dogma
// location takes the ones in its ship, or that were (clientDogmaIM.GodmaItemChanged), and goes by the row
// (clientDogmaLocation.OnItemChange): an item it did not hold that is now in a slot is fitted, one it held that
// is no longer in a slot is let go of, and one that is in a slot still is where the row says.

const HANGAR = 60000004;
const movedRow = (fields) => row7({ ownerID: Number(PILOT), quantity: -1, stacksize: 1, singleton: 1, customInfo: "", ...fields });
const itemsChanged = (rows, was = [[3, HANGAR], [4, 4]]) => ({ method: "OnItemsChanged", args: [{ type: "list", items: rows }, attrs(was), null] });
const EXPANDER = Object.freeze({ itemID: 7001, typeID: 1317, locationID: 5001, flagID: 11, groupID: 765, categoryID: 7 });
const onlineNow = (itemID, active) => ({ method: "OnGodmaShipEffect", args: [BigInt(itemID), EFFECT_ONLINE, HEALTH_T, active, active, [BigInt(itemID), PILOT, 5001n, null, null, [], EFFECT_ONLINE, null], HEALTH_T, -1, 1, null] });
function holding(rows = [shipRow(5001, HEALTHY)]) {
  const fitted = [];
  const asked = [];
  /** Both in the order the store said them: "ask 7001" for an item godma would ask the server about, "fit 7001" for one newly fitted. */
  const said = [];
  const dogma = createPilotDogma({
    characterID: PILOT,
    now: () => HEALTH_T,
    onSlotted: (item) => { asked.push(item); said.push(`ask ${item.itemID}`); },
    onFitted: (item) => { fitted.push(item); said.push(`fit ${item.itemID}`); },
  });
  dogma.loadAllInfo(kv({ shipInfo: attrs(rows) }));
  return { dogma, fitted, asked, said };
}

test("a module fitted while the ship is held is the ship's from then on: what it is, where, and what the server says of it after", () => {
  const { dogma, fitted } = holding();
  // Before it is told of, what the server says of the module is about nothing that is held.
  assert.equal(dogma.feed(onlineNow(7001, 1)), true);
  assert.deepEqual([dogma.item(7001), dogma.onlineModules(5001)], [null, []]);
  assert.equal(dogma.feed(itemsChanged([movedRow(EXPANDER)])), true);
  assert.deepEqual(dogma.item(7001), { typeID: 1317, groupID: 765, categoryID: 7, flagID: 11, locationID: 5001 });
  assert.deepEqual(fitted, [{ itemID: 7001, typeID: 1317, flagID: 11, locationID: 5001 }]);
  // Held, with nothing known of it yet: not online until something says so.
  assert.deepEqual([dogma.has(7001), dogma.attributesOf(7001), dogma.onlineModules(5001)], [true, [], []]);
  dogma.feed(onlineNow(7001, 1));
  dogma.feed(changes(change(7001n, ATTRIBUTE.IS_ONLINE, HEALTH_T, 1)));
  assert.deepEqual([dogma.onlineModules(5001), dogma.attribute(7001, ATTRIBUTE.IS_ONLINE)], [[[11, 7001]], 1]);
  // The ship itself is as it was.
  assert.equal(dogma.attribute(5001, ATTRIBUTE.HP), 150);
});

test("a module moved to another slot is in that slot, and is not fitted anew; one taken out is forgotten with all that was known of it", () => {
  const { dogma, fitted } = holding();
  dogma.feed(itemsChanged([movedRow(EXPANDER)]));
  dogma.feed(onlineNow(7001, 1));
  dogma.feed(itemsChanged([movedRow({ ...EXPANDER, flagID: 12 })], [[4, 11]]));
  assert.deepEqual([dogma.onlineModules(5001), fitted.length], [[[12, 7001]], 1]);
  // Out to the hangar: nothing of it is left, and what the server says of it after is about nothing held.
  dogma.feed(itemsChanged([movedRow({ ...EXPANDER, locationID: HANGAR, flagID: 4 })], [[3, 5001], [4, 12]]));
  assert.deepEqual([dogma.item(7001), dogma.has(7001), dogma.effect(7001, EFFECT_ONLINE), dogma.onlineModules(5001), fitted.length], [null, false, null, [], 1]);
  dogma.feed(onlineNow(7001, 1));
  assert.deepEqual(dogma.onlineModules(5001), []);
  // And back in: fitted anew.
  dogma.feed(itemsChanged([movedRow({ ...EXPANDER, flagID: 13 })]));
  assert.deepEqual([dogma.item(7001).flagID, fitted.map((item) => item.flagID)], [13, [11, 13]]);
});

test("a module godma was primed with is one of the ship's already: moved, it is not fitted anew; taken out, it is gone", () => {
  const online = [EFFECT_ONLINE, [0n, PILOT, 5001n, null, null, [], EFFECT_ONLINE, HEALTH_T, -1, 1]];
  const lit = fittedModule(5003, { flagID: 27 });
  lit[1].args.entries.find(([name]) => name.toString() === "activeEffects")[1] = attrs([online]);
  const { dogma, fitted } = holding([shipRow(5001, HEALTHY), lit]);
  const own = { itemID: 5003, typeID: 3636, locationID: 5001, groupID: 53, categoryID: 7 };
  dogma.feed(itemsChanged([movedRow({ ...own, flagID: 28 })], [[4, 27]]));
  assert.deepEqual([dogma.onlineModules(5001), fitted, dogma.attribute(5003, ATTRIBUTE.HP)], [[[28, 5003]], [], 40]);
  dogma.feed({ method: "OnItemChange", args: [movedRow({ ...own, locationID: HANGAR, flagID: 4 }), attrs([[3, 5001], [4, 28]]), null] });
  assert.deepEqual([dogma.item(5003), dogma.has(5003), dogma.onlineModules(5001)], [null, false, []]);
});

test("an item alone is told of with OnItemChange, and is taken the same way", () => {
  const { dogma, fitted } = holding();
  // Its IDs as the wire carries a row's, 64-bit: the same item, in the same ship.
  assert.equal(dogma.feed({ method: "OnItemChange", args: [movedRow({ ...EXPANDER, itemID: 7001n, locationID: 5001n }), attrs([[3, HANGAR], [4, 4]]), null] }), true);
  assert.deepEqual([dogma.item(7001), fitted], [{ typeID: 1317, groupID: 765, categoryID: 7, flagID: 11, locationID: 5001 }, [{ itemID: 7001, typeID: 1317, flagID: 11, locationID: 5001 }]]);
});

test("where on a ship an item is fitted: its slots, its hidden modifiers, its drone bay and its fighter tubes, and nowhere else", () => {
  const at = (flagID, more = {}) => {
    const { dogma } = holding();
    dogma.feed(itemsChanged([movedRow({ ...EXPANDER, flagID, ...more })]));
    return dogma.item(7001) !== null;
  };
  // inventorycommon.const: fittingFlags, flagHiddenModifers, flagDroneBay and the fighter tubes, each range by its ends.
  assert.deepEqual([11, 34, 92, 94, 125, 128, 164, 171, 156, 87, 159, 163].filter((flagID) => !at(flagID)), []);
  // The ship's hold, its hangar's flag, and what lies either side of each range.
  assert.deepEqual([0, 4, 5, 10, 35, 86, 88, 91, 95, 124, 129, 155, 157, 158, 172].filter((flagID) => at(flagID)), []);
  // A stack of none is not fitted, and a ship that is not held has nothing fitted to it here.
  assert.deepEqual([at(11, { stacksize: 0 }), at(11, { locationID: 6001 })], [false, false]);
});

test("what is not the ship's is left alone: the ship's own row, the pilot's, something moved about in the hangar, and what is not a row", () => {
  const { dogma, fitted } = holding();
  const before = JSON.stringify([dogma.item(5001), dogma.attributesOf(5001)]);
  // The ship itself, moved or renamed: it is not fitted to anything, and it is not let go of.
  dogma.feed(itemsChanged([movedRow({ itemID: 5001, typeID: 588, locationID: HANGAR, flagID: 4, groupID: 237, categoryID: 6 })], [[4, 0]]));
  assert.equal(JSON.stringify([dogma.item(5001), dogma.attributesOf(5001)]), before);
  // The pilot: godma's own, not the ship's.
  dogma.feed(itemsChanged([movedRow({ itemID: Number(PILOT), typeID: 1373, locationID: 5001, flagID: 57, groupID: 1, categoryID: 3 })]));
  // Something from one place in the hangar to another, something that is no row, a row that names no item, and a notice with nothing in it.
  dogma.feed(itemsChanged([movedRow({ ...EXPANDER, locationID: HANGAR, flagID: 4 }), null, "x", movedRow({ ...EXPANDER, itemID: undefined })]));
  assert.equal(dogma.feed({ method: "OnItemsChanged", args: null }), true);
  assert.equal(dogma.feed({ method: "OnItemChange", args: [] }), true);
  assert.deepEqual([fitted, dogma.item(7001), dogma.item(Number(PILOT)), dogma.has(5001)], [[], null, null, true]);
});

test("an effect the client starts or stops itself is running or not from then on, for an item that is held", () => {
  const { dogma } = holding();
  dogma.feed(itemsChanged([movedRow(EXPANDER)]));
  assert.equal(dogma.setEffect(7001, EFFECT_ONLINE, true), true);
  assert.deepEqual([dogma.onlineModules(5001), dogma.effect(7001, EFFECT_ONLINE).isActive], [[[11, 7001]], true]);
  assert.equal(dogma.setEffect(7001n, EFFECT_ONLINE, false), true);
  assert.deepEqual([dogma.onlineModules(5001), dogma.effect(7001, EFFECT_ONLINE).isActive], [[], false]);
  // One that is not held has no effects to start.
  assert.deepEqual([dogma.setEffect(9999, EFFECT_ONLINE, true), dogma.effect(9999, EFFECT_ONLINE)], [false, null]);
});

// ── what godma asks of a module in a slot ────────────────────────────────────
//
// Told of an item in its ship, the client's godma asks the server what dogma has of it,
// ItemGetInfo(itemID), and holds the answer: its attributes and the effects active on it (godma.OnItemChange,
// UpdateItem 1629). Recorded on Tranquility for a module put in a slot: the item change, ItemGetInfo, and only
// then the dogma location's own fitting of it. An item in the hold, the drone bay or a fighter tube is not asked
// about (UpdateItem 1580).

test("a module the server says is in a slot is one godma asks about: newly fitted, before it is fitted; moved, again", () => {
  const { dogma, asked, said } = holding();
  dogma.feed(itemsChanged([movedRow(EXPANDER)]));
  assert.deepEqual([asked, said], [[{ itemID: 7001, typeID: 1317, flagID: 11, locationID: 5001 }], ["ask 7001", "fit 7001"]]);
  dogma.feed(itemsChanged([movedRow({ ...EXPANDER, flagID: 12 })], [[4, 11]]));
  assert.deepEqual([asked.map((item) => item.flagID), said], [[11, 12], ["ask 7001", "fit 7001", "ask 7001"]]);
  // Taken out, there is nothing to ask.
  dogma.feed(itemsChanged([movedRow({ ...EXPANDER, locationID: HANGAR, flagID: 4 })], [[3, 5001], [4, 12]]));
  assert.equal(asked.length, 2);
});

test("what godma asks about: a module or a subsystem, in a slot or among the hidden modifiers; not a drone in its bay, a fighter in its tube, or a charge", () => {
  const askedAt = (flagID, more = {}) => {
    const { dogma, asked } = holding();
    dogma.feed(itemsChanged([movedRow({ ...EXPANDER, flagID, ...more })]));
    return asked.length === 1;
  };
  assert.deepEqual([11, 34, 92, 94, 125, 128, 164, 171, 156].filter((flagID) => !askedAt(flagID)), []);
  // Fitted, as the dogma location has it, and not asked about.
  assert.deepEqual([87, 159, 163].filter((flagID) => askedAt(flagID)), []);
  // A subsystem is; a charge put in a slot as an item, a drone, or anything else is not.
  assert.deepEqual([askedAt(125, { categoryID: 32 }), askedAt(27, { categoryID: 8 }), askedAt(27, { categoryID: 18 }), askedAt(27, { categoryID: 6 })], [true, false, false, false]);
});

test("what the server answers of an item that is held is held: its attributes and the effects active on it, in place of what was", () => {
  const { dogma } = holding();
  dogma.feed(itemsChanged([movedRow(EXPANDER)]));
  dogma.setEffect(7001, EFFECT_ONLINE, true);
  const online = [EFFECT_ONLINE, [0n, PILOT, 5001n, null, null, [], EFFECT_ONLINE, HEALTH_T, -1, 1]];
  const row = (effects) => kv({ itemID: 7001n, invItem: row7({ itemID: 7001, typeID: 1317, locationID: 5001, flagID: 11, groupID: 765, categoryID: 7 }), time: HEALTH_T, attributes: attrs([[ATTRIBUTE.HP, 40], [ATTRIBUTE.IS_ONLINE, 1]]), activeEffects: attrs(effects) });
  assert.equal(dogma.updateItem(7001, row([online])), true);
  assert.deepEqual([dogma.attribute(7001, ATTRIBUTE.HP), dogma.attribute(7001, ATTRIBUTE.IS_ONLINE), dogma.onlineModules(5001)], [40, 1, [[11, 7001]]]);
  // The server's word on its effects is the whole of it: one it does not list is not running.
  assert.equal(dogma.updateItem(7001n, row([])), true);
  assert.deepEqual(dogma.onlineModules(5001), []);
  // An answer of nothing changes nothing, and an answer about an item that is no longer held is not taken.
  assert.equal(dogma.updateItem(7001, null), false);
  assert.equal(dogma.attribute(7001, ATTRIBUTE.HP), 40);
  dogma.feed(itemsChanged([movedRow({ ...EXPANDER, locationID: HANGAR, flagID: 4 })], [[3, 5001], [4, 11]]));
  assert.deepEqual([dogma.updateItem(7001, row([online])), dogma.has(7001), dogma.item(7001)], [false, false, null]);
});

// ── godma's priming after the first ──────────────────────────────────────────
//
// godma.py, Prime (2399 to 2409): the dogma location is asked for what godma does not hold,
//
//   primeCharacter = session.charid and session.charid not in self.invByID
//   primeShip      = session.shipid and session.shipid not in self.invByID
//   GetDogmaLM().GetAllInfo(primeCharacter, primeShip, primeStructure)
//
// and at a change of place or of ship (ProcessSessionChange, 1154 to 1170) it lets every inventory go but the
// character's, and the ship's by name just after, so that every priming after a session's first asks for the
// ship and not the character: (False, True, None), 144 times of 164 in Tranquility's recordings.
//
// The bytes are a real server's (test/fixtures/godmaPriming.json, made by scripts/record-godma-priming.js): its
// answer to the first form docked, and to the later form docked, in space and docked again. In space the later
// answer has an empty charInfo and the ship's state, as Tranquility's has (this server sent None for both until
// 2026-10-12, when eve.js was mended and this was recorded again).
const priming = require("./fixtures/godmaPriming.json");
const primed = (during) => answers(priming).find((answer) => answer.during === during && answer.value && answer.value.type === "object").value;
const [P_SHIP, P_PILOT] = [priming.shipID, priming.characterID];

test("godma holds the character from the priming that brought it, and from no other", () => {
  const dogma = createPilotDogma({ characterID: P_PILOT });
  assert.equal(dogma.holdsCharacter(), false);
  dogma.loadAllInfo(primed("first, docked"));
  assert.equal(dogma.holdsCharacter(), true);
  // An answer with nothing of the character brings none, though it has the ship.
  const late = createPilotDogma({ characterID: P_PILOT });
  assert.deepEqual(late.loadAllInfo(primed("later, in space")), [P_SHIP]);
  assert.equal(late.holdsCharacter(), false);
  // Everything let go, the character is let go.
  dogma.clear();
  assert.deepEqual([dogma.holdsCharacter(), dogma.has(P_PILOT)], [false, false]);
  // A godma that is nobody's holds no character, whatever it is given.
  const nobodys = createPilotDogma();
  nobodys.loadAllInfo(primed("first, docked"));
  assert.equal(nobodys.holdsCharacter(), false);
});

test("at a priming after the first the ship is let go and loaded anew, and what godma held of the character is kept", () => {
  const dogma = createPilotDogma({ characterID: P_PILOT, now: () => T0 });
  dogma.loadAllInfo(primed("first, docked"));
  const [ofCharacter, whatItIs] = [dogma.attributesOf(P_PILOT), dogma.item(P_PILOT)];
  assert.ok(ofCharacter.length > 20, `${ofCharacter.length} attributes of the character`);
  // Something of the ship's the server's next answer will not have: told of since, by a notice.
  assert.equal(dogma.applyAttributeChange(P_SHIP, 990001, T0, 5), true);
  assert.equal(dogma.attribute(P_SHIP, 990001), 5);
  // And an effect of the ship's, and its capacitor, which godma reckons by itself between the server's words.
  dogma.setEffect(P_SHIP, EFFECT_ONLINE, true);
  assert.ok(dogma.effect(P_SHIP, EFFECT_ONLINE) !== null);
  assert.ok(dogma.attribute(P_SHIP, ATTRIBUTE.CHARGE) > 0);
  // godma.ProcessSessionChange: every inventory but the character's.
  dogma.purge();
  assert.deepEqual([dogma.effect(P_SHIP, EFFECT_ONLINE), dogma.attribute(P_SHIP, ATTRIBUTE.CHARGE)], [null, null]);
  assert.deepEqual([dogma.has(P_SHIP), dogma.item(P_SHIP), dogma.attribute(P_SHIP, 990001), dogma.shipReadings(P_SHIP)], [false, null, null, null]);
  assert.deepEqual([dogma.has(P_PILOT), dogma.holdsCharacter(), dogma.item(P_PILOT)], [true, true, whatItIs]);
  assert.deepEqual(dogma.attributesOf(P_PILOT), ofCharacter);
  // The later answer in space: the ship, and nothing of the character.
  assert.deepEqual(dogma.loadAllInfo(primed("later, in space")), [P_SHIP]);
  assert.deepEqual([dogma.has(P_SHIP), dogma.attribute(P_SHIP, 990001), dogma.holdsCharacter()], [true, null, true]);
  assert.ok(dogma.shipReadings(P_SHIP) !== null);
  assert.deepEqual(dogma.attributesOf(P_PILOT), ofCharacter);
  // The later answer docked has the character again: it is loaded as the answer has it.
  dogma.purge();
  assert.deepEqual(dogma.loadAllInfo(primed("later, docked again")), [P_SHIP, P_PILOT]);
  assert.equal(dogma.holdsCharacter(), true);
});

test("a purge forgets when each attribute last changed, as godma does, and keeps what the character's are", () => {
  // godma.ProcessSessionChange (1169): self.lastAttributeChange = {}.
  const dogma = createPilotDogma({ characterID: P_PILOT, now: () => T0 });
  dogma.loadAllInfo(primed("first, docked"));
  const later = T0 + 50n * MS;
  dogma.feed(changes(change(P_PILOT, 990002, later, 7, { owner: P_PILOT })));
  assert.equal(dogma.attribute(P_PILOT, 990002), 7);
  // An older change of the same attribute is not taken while the newer is remembered.
  dogma.feed(changes(change(P_PILOT, 990002, T0, 3, { owner: P_PILOT })));
  assert.equal(dogma.attribute(P_PILOT, 990002), 7);
  dogma.purge();
  assert.equal(dogma.attribute(P_PILOT, 990002), 7, "the character's own are kept");
  dogma.feed(changes(change(P_PILOT, 990002, T0, 3, { owner: P_PILOT })));
  assert.equal(dogma.attribute(P_PILOT, 990002), 3, "and the next change is taken whatever its time");
});

test("a ship's weapon banks are the dogma location's and outlive godma's purge; a ship's state in an answer replaces them", () => {
  const dogma = createPilotDogma({ characterID: P_PILOT });
  dogma.loadAllInfo(primed("first, docked"));
  dogma.setWeaponBanks(P_SHIP, { type: "dict", entries: [[7001, { type: "list", items: [7002, 7003] }]] });
  assert.deepEqual(dogma.weaponBanks(P_SHIP), { 7001: [7002, 7003] });
  // godma's purge leaves them.
  dogma.purge();
  assert.deepEqual(dogma.weaponBanks(P_SHIP), { 7001: [7002, 7003] });
  // An answer with no state of the ship leaves them too: the real answer in space, its state taken out.
  const later = primed("later, in space");
  const stateless = { ...later, args: { ...later.args, entries: later.args.entries.map(([name, value]) => [name, Buffer.from(name.data ?? name).toString() === "shipState" ? null : value]) } };
  assert.equal(stateless.args.entries.filter(([, value]) => value === null).length, later.args.entries.filter(([, value]) => value === null).length + 1);
  dogma.loadAllInfo(stateless);
  assert.deepEqual(dogma.weaponBanks(P_SHIP), { 7001: [7002, 7003] });
  // The real answer in space has the ship's state, with no banks in it, and that is what the ship has.
  dogma.purge();
  dogma.loadAllInfo(later);
  assert.deepEqual(dogma.weaponBanks(P_SHIP), {});
  // Docked again it has one too.
  dogma.setWeaponBanks(P_SHIP, { type: "dict", entries: [[7001, { type: "list", items: [7002] }]] });
  dogma.purge();
  dogma.loadAllInfo(primed("later, docked again"));
  assert.deepEqual(dogma.weaponBanks(P_SHIP), {});
  // And everything let go lets them go.
  dogma.setWeaponBanks(P_SHIP, { type: "dict", entries: [[7001, { type: "list", items: [7002] }]] });
  dogma.clear();
  assert.equal(dogma.weaponBanks(P_SHIP), null);
});

test("what is in the character is the character's: an implant godma holds outlives the purge with it, and the ship and its module do not", () => {
  const dogma = createPilotDogma({ characterID: PILOT, now: () => T0 });
  const keyVal = (entries) => ({ type: "object", name: Buffer.from("util.KeyVal"), args: { type: "dict", entries: entries.map(([name, value]) => [Buffer.from(name), value]) } });
  /** An item's row as godma is primed with one: what it is, where it is, and an attribute. */
  const item = (itemID, locationID, typeID) => [itemID, keyVal([["itemID", itemID], ["time", T0],
    ["invItem", { fields: { itemID, typeID, groupID: 300, categoryID: 20, flagID: 89, locationID } }], ["attributes", { type: "dict", entries: [[4, 1]] }], ["activeEffects", { type: "dict", entries: [] }]])];
  const [ship, module, implant] = [5001n, 5003n, 8001n];
  dogma.loadAllInfo(keyVal([
    ["shipInfo", { type: "dict", entries: [item(ship, 60000004n, 588), item(module, ship, 438)] }],
    ["charInfo", [{ type: "dict", entries: [item(BigInt(PILOT), ship, 1373), item(implant, BigInt(PILOT), 9899)] }, null]],
  ]));
  assert.deepEqual([dogma.has(PILOT), dogma.has(8001), dogma.has(5001), dogma.has(5003)], [true, true, true, true]);
  dogma.purge();
  assert.deepEqual([dogma.has(PILOT), dogma.has(8001), dogma.has(5001), dogma.has(5003)], [true, true, false, false]);
  assert.deepEqual([dogma.item(8001).typeID, dogma.item(8001).locationID, dogma.attribute(8001, 4), dogma.item(5003)], [9899, PILOT, 1, null]);
});

// What the ship changes of its pilot (godma.ProcessAllInfo, 2446). Tranquility says it at every priming of a ship
// that changes something, and None of every other: in its recordings one ship has it, a Caracal with three
// ballistic controls, {212: 1.1804337950307635}, in space and docked, at primings of the ship alone.
//
// The bytes are a real server's (test/fixtures/godmaShipModified.json, cut from a recording made by
// scripts/record-godma-priming.js with a Ballistic Control System I fitted to the pilot's ship): the later form,
// asked in space. The answer has nothing of the character but the one attribute the ship changes.
const shipModified = require("./fixtures/godmaShipModified.json");

test("what the ship changes of its pilot is laid over the character at a priming of the ship alone", () => {
  const answer = answers(shipModified).find((each) => each.during === "later, in space" && each.value && each.value.type === "object").value;
  assert.equal(shipModified.characterID, P_PILOT, "the pilot is the priming recording's");
  const MISSILE_DAMAGE = 212;
  // The character as the session's first priming brought it, with no ballistic control: its type's missile damage.
  const dogma = createPilotDogma({ characterID: P_PILOT, now: () => T0 });
  dogma.loadAllInfo(primed("first, docked"));
  const before = dogma.attributesOf(P_PILOT).length;
  assert.equal(dogma.attribute(P_PILOT, MISSILE_DAMAGE), 1);
  // The ship primed anew, with the ballistic control: the one attribute is changed, and the others are kept.
  dogma.purge();
  dogma.loadAllInfo(answer);
  assert.deepEqual([dogma.attribute(P_PILOT, MISSILE_DAMAGE), dogma.attributesOf(P_PILOT).length, dogma.holdsCharacter()], [1.07, before, true]);
  // The answer by itself has that of the character and no more, and primes no character.
  const late = createPilotDogma({ characterID: P_PILOT });
  late.loadAllInfo(answer);
  assert.deepEqual([late.attribute(P_PILOT, MISSILE_DAMAGE), late.attributesOf(P_PILOT).length, late.holdsCharacter()], [1.07, 1, false]);
});

test("a running module's target is said beside it: what a tractor beam or a salvager is cycling on", () => {
  const dogma = createPilotDogma({ characterID: PILOT, effectCategory });
  dogma.loadAllInfo(answers(flight).find((answer) => answer.during === "GetAllInfo in space" && answer.value && answer.value.type === "object").value);
  const WRECK = 9000000123;
  // OnGodmaShipEffect(itemID, effectID, when, ?, active, environment, startTime, duration, repeat): environment[3] is the target.
  assert.equal(dogma.feed({ method: "OnGodmaShipEffect", args: [MODULE, AFTERBURNER, 0n, null, 1, [MODULE, PILOT, SHIP, WRECK], 0n, 10000, 1000] }), true);
  assert.deepEqual(dogma.shipReadings(SHIP).activeModuleTargets, [[MODULE, WRECK]]);
  // Stopped: no longer said.
  dogma.feed({ method: "OnGodmaShipEffect", args: [MODULE, AFTERBURNER, 0n, null, 0, [MODULE, PILOT, SHIP, WRECK], 0n, 10000, 0] });
  assert.deepEqual(dogma.shipReadings(SHIP).activeModuleTargets, []);
});
