import { test } from "node:test";
import assert from "node:assert/strict";

import { createModuleRepairs, createOverloadEffects, createWeaponGrouping, loadAmmo, repairWaitMs, setOverload, unloadAmmo } from "./dogmaWrites.ts";
import type { Ask } from "./ask.ts";
import type { JsonValue } from "./wire.ts";

/** A stand-in for the page's asking: what was asked, and `answer` (or what it throws) for each. */
function asking(answer: JsonValue | Error) {
  const asked: unknown[] = [];
  const act: Ask = async (service, method, args, kwargs) => {
    asked.push(kwargs === undefined ? [service, method, args] : [service, method, args, kwargs]);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { act, asked };
}

// godma.py 2074 and 2119. Tranquility has the first recorded: Overload(moduleID, 3001), on the dogma location.

test("a module is overloaded by godma's Overload, the module and its overload effect by place", async () => {
  const { act, asked } = asking(9988400023312);
  await setOverload(act, 9988400023312, 3001, true);
  assert.deepEqual(asked, [["dogmaIM", "Overload", [9988400023312, 3001]]]);
});

test("and cooled by StopOverload, with the same two", async () => {
  const { act, asked } = asking(9988400023312);
  await setOverload(act, 9988400023312, 3001, false);
  assert.deepEqual(asked, [["dogmaIM", "StopOverload", [9988400023312, 3001]]]);
});

test("setOverload fails as the call fails", async () => {
  await assert.rejects(() => setOverload(asking(new Error("DontHaveThermoDynamicsSkill")).act, 1, 3001, true), /DontHaveThermoDynamicsSkill/);
});

// ── What a type's overload effect is ─────────────────────────────────────────

/** The static read, standing in: what each asking named, and the answer it gets. */
function reading(answers: Readonly<Record<number, number | null>>, failing: () => boolean = () => false) {
  const asked: number[][] = [];
  const read = async (typeIDs: readonly number[]) => {
    asked.push([...typeIDs]);
    if (failing()) throw new Error("the static data could not be read");
    return Object.fromEntries(typeIDs.filter(typeID => Object.hasOwn(answers, typeID)).map(typeID => [typeID, answers[typeID]!]));
  };
  return { asked, effects: createOverloadEffects(read) };
}

test("a type's overload effect is asked for once and kept, and so is that it has none", async () => {
  const { asked, effects } = reading({ 527: 3001, 17482: null });
  assert.equal(await effects.of(527), 3001);
  assert.equal(await effects.of(527), 3001);
  assert.equal(await effects.of(17482), null);
  assert.equal(await effects.of(17482), null);
  assert.deepEqual(asked, [[527], [17482]]);
});

test("a reading that fails is not kept: the type is asked for again", async () => {
  let failing = true;
  const { asked, effects } = reading({ 527: 3001 }, () => failing);
  await assert.rejects(() => effects.of(527), /could not be read/);
  failing = false;
  assert.equal(await effects.of(527), 3001);
  assert.deepEqual(asked, [[527], [527]]);
});

test("an answer that does not speak of the type is no answer: it fails, and is not kept as none", async () => {
  const { asked, effects } = reading({});
  await assert.rejects(() => effects.of(527));
  await assert.rejects(() => effects.of(527));
  assert.equal(asked.length, 2);
});

// ── A module's repair ────────────────────────────────────────────────────────
// godma.RepairModule, RepairModule_thread and StopRepairModule (2225 to 2262): InitiateModuleRepair begins it, and
// godma itself sends StopModuleRepair when the repair's time is up, at Cancel Repair, and at a session's change.

test("a repair's time is the damage over the repair rate, in minutes, cut to whole milliseconds, and a second", () => {
  // 2248 to 2251: timeToSleep = dmg / rateOfRepair; int(timeToSleep * 60 * 1000); SleepSim(that + 1000).
  assert.equal(repairWaitMs(10, 10), 61_000);
  assert.equal(repairWaitMs(40, 10), 241_000);
  // 8571.428... milliseconds: the part of one is cut off, not rounded.
  assert.equal(repairWaitMs(1, 7), 9_571);
  assert.equal(repairWaitMs(2, 7), 18_142);
  assert.equal(repairWaitMs(0.5, 20), 2_500);
});

/** Repairs over a stand-in: what was asked, the waits armed (each with what it does when its time is up), and what was said to have ended. */
function repairing(answer: JsonValue | Error = true) {
  const { act, asked } = asking(answer);
  const waits: { ms: number; run: () => void }[] = [];
  const ended: number[] = [];
  const repairs = createModuleRepairs(act, { later: (ms, run) => { waits.push({ ms, run }); }, ended: moduleID => { ended.push(moduleID); } });
  return { asked, waits, ended, repairs };
}
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test("a repair begun is godma's InitiateModuleRepair, and is ended by StopModuleRepair when its time is up", async () => {
  const { asked, waits, ended, repairs } = repairing(true);
  assert.equal(repairs.beingRepaired(61001), false);
  assert.equal(await repairs.begin(61001, 61_000), true);
  assert.deepEqual(asked, [["dogmaIM", "InitiateModuleRepair", [61001]]]);
  assert.deepEqual([repairs.beingRepaired(61001), repairs.beingRepaired(61002), waits.map(wait => wait.ms), ended], [true, false, [61_000], []]);
  waits[0]!.run();
  await turn();
  assert.deepEqual(asked.slice(1), [["dogmaIM", "StopModuleRepair", [61001]]]);
  assert.deepEqual([repairs.beingRepaired(61001), ended], [false, [61001]]);
});

test("the server's answer of False begins nothing: no wait is armed, and nothing is ended", async () => {
  const { asked, waits, ended, repairs } = repairing(false);
  assert.equal(await repairs.begin(61001, 61_000), false);
  assert.deepEqual([asked.length, waits, ended, repairs.beingRepaired(61001)], [1, [], [], false]);
});

test("an answer that is not False begins it, as godma reads it", async () => {
  for (const answer of [null, 1, "yes"] as JsonValue[]) {
    const { waits, repairs } = repairing(answer);
    assert.equal(await repairs.begin(61001, 5_000), true, JSON.stringify(answer));
    assert.deepEqual([repairs.beingRepaired(61001), waits.length], [true, 1], JSON.stringify(answer));
  }
});

test("a beginning that fails begins nothing, and fails as the call fails", async () => {
  const { waits, repairs } = repairing(new Error("NotEnoughRepairMaterialToFinishAllRepairs"));
  await assert.rejects(() => repairs.begin(61001, 61_000), /NotEnoughRepairMaterial/);
  assert.deepEqual([waits, repairs.beingRepaired(61001)], [[], false]);
});

test("a repair ended before its time is not ended again when the time comes", async () => {
  const { asked, waits, ended, repairs } = repairing(true);
  await repairs.begin(61001, 61_000);
  await repairs.end(61001);
  assert.deepEqual(asked.slice(1), [["dogmaIM", "StopModuleRepair", [61001]]]);
  assert.deepEqual([repairs.beingRepaired(61001), ended], [false, [61001]]);
  waits[0]!.run();
  await turn();
  assert.equal(asked.length, 2);
  assert.deepEqual(ended, [61001]);
});

test("the time of an earlier beginning does not end a later one of the same module", async () => {
  // 2253: the time stamp kept with the module must be the thread's own.
  const { asked, waits, repairs } = repairing(true);
  await repairs.begin(61001, 61_000);
  await repairs.end(61001);
  await repairs.begin(61001, 30_000);
  waits[0]!.run();
  await turn();
  assert.deepEqual([asked.length, repairs.beingRepaired(61001)], [3, true]);
  waits[1]!.run();
  await turn();
  assert.deepEqual([asked.at(-1), repairs.beingRepaired(61001)], [["dogmaIM", "StopModuleRepair", [61001]], false]);
});

test("a module that is not being repaired is not ended", async () => {
  const { asked, ended, repairs } = repairing(true);
  await repairs.end(61001);
  assert.deepEqual([asked, ended], [[], []]);
});

test("every repair begun is ended at a word, each by its own call", async () => {
  const { asked, ended, repairs } = repairing(true);
  await repairs.begin(61001, 61_000);
  await repairs.begin(61002, 61_000);
  await repairs.endAll();
  assert.deepEqual(asked.slice(2), [["dogmaIM", "StopModuleRepair", [61001]], ["dogmaIM", "StopModuleRepair", [61002]]]);
  assert.deepEqual([ended, repairs.beingRepaired(61001), repairs.beingRepaired(61002)], [[61001, 61002], false, false]);
  await repairs.endAll();
  assert.equal(asked.length, 4);
});

test("an ending that fails still forgets the repair and says it ended, as godma's does", async () => {
  // 2259 to 2264: try StopModuleRepair, finally the event and the forgetting.
  const asked: unknown[] = [];
  const ended: number[] = [];
  const act: Ask = async (service, method, args) => {
    asked.push([service, method, args]);
    if (method === "StopModuleRepair") throw new Error("the connection went");
    return true;
  };
  const repairs = createModuleRepairs(act, { later: () => {}, ended: moduleID => { ended.push(moduleID); } });
  await repairs.begin(61001, 61_000);
  await assert.rejects(() => repairs.end(61001), /the connection went/);
  assert.deepEqual([repairs.beingRepaired(61001), ended], [false, [61001]]);
  // And one of several failing does not keep the rest from being ended.
  await repairs.begin(61001, 61_000);
  await repairs.begin(61002, 61_000);
  await repairs.endAll();
  assert.deepEqual([repairs.beingRepaired(61001), repairs.beingRepaired(61002), ended], [false, false, [61001, 61001, 61002]]);
});

// ── The weapons linked and unlinked all at once ──────────────────────────────
// clientDogmaLocation.LinkAllWeapons and UnlinkAllWeapons (793 to 803), from the group-all button
// (groupAllIcon.py 28 to 39), which is dead for two seconds after a request of its kind was answered.

/** Grouping over a stand-in, with a clock the test moves; `during` is run inside each call, before it answers. */
function grouping(answer: JsonValue | Error = null, during: (clock: { nowMs: number }) => void = () => {}) {
  const asked: unknown[] = [];
  const clock = { nowMs: 1_000_000 };
  const act: Ask = async (service, method, args) => {
    asked.push([service, method, args]);
    during(clock);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { asked, clock, weapons: createWeaponGrouping(act, () => clock.nowMs) };
}

test("the weapons are linked by LinkAllWeapons and unlinked by UnlinkAllModules, each naming the ship", async () => {
  const { asked, weapons } = grouping();
  assert.equal(await weapons.linkAll(9988400023309), true);
  assert.equal(await weapons.unlinkAll(9988400023309), true);
  assert.deepEqual(asked, [["dogmaIM", "LinkAllWeapons", [9988400023309]], ["dogmaIM", "UnlinkAllModules", [9988400023309]]]);
});

test("the first request of a kind is made whatever the clock says", async () => {
  const asked: unknown[] = [];
  const weapons = createWeaponGrouping(async (service, method, args) => { asked.push([service, method, args]); return null; }, () => 5);
  assert.deepEqual([await weapons.linkAll(1), await weapons.unlinkAll(1), asked.length], [true, true, 2]);
});

test("a request of the same kind is not made until the button would be alive again: just under two seconds", async () => {
  // UpdateGroupAllButton: dead while the time since the answer, over two seconds, is no more than 0.999.
  const { asked, clock, weapons } = grouping();
  await weapons.linkAll(7);
  clock.nowMs += 1998;
  assert.equal(await weapons.linkAll(7), false);
  assert.equal(asked.length, 1);
  clock.nowMs += 1;
  assert.equal(await weapons.linkAll(7), true);
  assert.equal(asked.length, 2);
  // What was not made does not start the wait again, and each kind has its own.
  await weapons.unlinkAll(7);
  clock.nowMs += 1998;
  assert.deepEqual([await weapons.unlinkAll(7), await weapons.linkAll(7)], [false, false]);
  clock.nowMs += 1;
  assert.deepEqual([await weapons.unlinkAll(7), await weapons.linkAll(7)], [true, true]);
  assert.equal(asked.length, 5);
});

test("the wait is from the answer, not from the asking", async () => {
  // clientDogmaLocation.py 802: the time is noted once the call has come back.
  const { asked, clock, weapons } = grouping(null, running => { running.nowMs += 700; });
  await weapons.linkAll(7);
  clock.nowMs += 1998;
  assert.equal(await weapons.linkAll(7), false, "2698 ms after the asking, 1998 after the answer");
  assert.equal(asked.length, 1);
});

test("a request that fails starts no wait, and fails as the call fails", async () => {
  const { asked, weapons } = grouping(new Error("CantLinkModuleNotOnline"));
  await assert.rejects(() => weapons.linkAll(7), /CantLinkModuleNotOnline/);
  await assert.rejects(() => weapons.linkAll(7), /CantLinkModuleNotOnline/);
  await assert.rejects(() => weapons.unlinkAll(7), /CantLinkModuleNotOnline/);
  await assert.rejects(() => weapons.unlinkAll(7), /CantLinkModuleNotOnline/);
  assert.equal(asked.length, 4);
});

// clientDogmaLocation.py 973 to 1141. Every LoadAmmo Tranquility has recorded is (shipID, moduleID, [chargeItemID], shipID).

const FLYING = { shipID: 9988400023309, characterID: 140000005, dockedAt: null };
const DOCKED = { ...FLYING, dockedAt: 60003760 };

test("ammunition is loaded into one module by its ID, the stacks as a list, from the ship's own hold: the ship twice", async () => {
  const { act, asked } = asking(null);
  await loadAmmo(act, FLYING, [9988400023312], [9988400023400, 9988400023401], "cargo");
  assert.deepEqual(asked, [["dogmaIM", "LoadAmmo", [9988400023309, 9988400023312, [9988400023400, 9988400023401], 9988400023309]]]);
});

test("several modules are named as a list", async () => {
  const { act, asked } = asking(null);
  await loadAmmo(act, DOCKED, [9988400023312, 9988400023313], [9988400023400], "cargo");
  assert.deepEqual(asked, [["dogmaIM", "LoadAmmo", [9988400023309, [9988400023312, 9988400023313], [9988400023400], 9988400023309]]]);
});

test("from the hangar the charges lie where the pilot is docked, and in space there is no hangar: nothing is asked", async () => {
  const { act, asked } = asking(null);
  await loadAmmo(act, DOCKED, [9988400023312], [9988400023400], "hangar");
  assert.deepEqual(asked, [["dogmaIM", "LoadAmmo", [9988400023309, 9988400023312, [9988400023400], 60003760]]]);
  await assert.rejects(() => loadAmmo(act, FLYING, [9988400023312], [9988400023400], "hangar"), /docked/);
  await assert.rejects(() => unloadAmmo(act, FLYING, [9988400023312], "hangar"), /docked/);
  assert.equal(asked.length, 1);
});

test("with no module, or no charges, nothing is asked: the client's own call is never made with none", async () => {
  // LoadChargesToModule raises before it calls where there are no charges.
  const { act, asked } = asking(null);
  await assert.rejects(() => loadAmmo(act, FLYING, [], [9988400023400], "cargo"), /module/);
  await assert.rejects(() => loadAmmo(act, FLYING, [9988400023312], [], "cargo"), /charges/);
  await assert.rejects(() => unloadAmmo(act, FLYING, [], "cargo"), /module/);
  assert.deepEqual(asked, []);
});

test("ammunition is unloaded from its modules as a list, to the hold as (the ship, the pilot, the cargo flag)", async () => {
  // fittingSlotController.py 186: (session.shipid, session.charid, const.flagCargo). No quantity is named.
  const { act, asked } = asking(null);
  await unloadAmmo(act, FLYING, [9988400023312], "cargo");
  await unloadAmmo(act, DOCKED, [9988400023312, 9988400023313], "cargo");
  assert.deepEqual(asked, [
    ["dogmaIM", "UnloadAmmo", [9988400023309, [9988400023312], [9988400023309, 140000005, 5]]],
    ["dogmaIM", "UnloadAmmo", [9988400023309, [9988400023312, 9988400023313], [9988400023309, 140000005, 5]]],
  ]);
});

test("and to the hangar as (where the pilot is docked, the pilot, the hangar flag)", async () => {
  // fittingSlotController.py 180: (session.structureid or session.stationid, session.charid, const.flagHangar).
  const { act, asked } = asking(null);
  await unloadAmmo(act, DOCKED, [9988400023312], "hangar");
  assert.deepEqual(asked, [["dogmaIM", "UnloadAmmo", [9988400023309, [9988400023312], [60003760, 140000005, 4]]]]);
});

test("a load or an unload the server refuses fails as the call fails", async () => {
  const { act, asked } = asking(new Error("CannotLoadNotEnoughCharges"));
  await assert.rejects(() => loadAmmo(act, FLYING, [9988400023312], [9988400023400], "cargo"), /CannotLoadNotEnoughCharges/);
  await assert.rejects(() => unloadAmmo(act, FLYING, [9988400023312], "cargo"), /CannotLoadNotEnoughCharges/);
  assert.equal(asked.length, 2);
});
