import test from "node:test";
import assert from "node:assert/strict";
import type { FittingSlot, SlotFamily } from "../store/types.ts";
import { classifySalvageModules, maxRangeFromDogma, tractorsInReach, NO_SALVAGE_MODULES } from "./salvageModules.ts";

const slot = (family: SlotFamily, index: number, itemID: number, typeID: number, online = true): FittingSlot =>
  ({ family, index, module: { itemID, typeID, groupID: null, online, charge: null } });

const GROUPS: Record<number, string | null> = {
  9000001: "Salvager", 9000002: "Tractor Beam", 9000003: "Mining Laser", 9000004: null, 9000005: "Mobile Tractor Unit",
};
const groupOf = (typeID: number) => GROUPS[typeID] ?? null;

test("salvagers and tractor beams are told apart by group name, high slots, online only", () => {
  const slots: FittingSlot[] = [
    slot("high", 0, 1001, 9000001), slot("high", 1, 1002, 9000002), slot("high", 2, 1003, 9000003),
    slot("high", 3, 1004, 9000002, false), slot("mid", 0, 1005, 9000002), slot("high", 4, 1006, 9000004),
    slot("high", 5, 1007, 9000005), slot("high", 6, 1008, 9000001),
  ];
  const got = classifySalvageModules(slots, groupOf);
  assert.deepEqual(got.salvagers.map(m => m.moduleID), [1001, 1008]);
  assert.deepEqual(got.tractors.map(m => m.moduleID), [1002]);
  assert.equal(got.tractors[0]!.typeID, 9000002);
  assert.equal(got.tractors[0]!.rangeM, null);
});

test("an unreadable fit lists nothing, and an empty slot is skipped", () => {
  assert.equal(classifySalvageModules(null, groupOf), NO_SALVAGE_MODULES);
  const empty: FittingSlot = { family: "high", index: 0, module: null };
  assert.deepEqual(classifySalvageModules([empty], groupOf), { tractors: [], salvagers: [] });
});

test("ranges come from the lookup; non-finite or negative reads stay null", () => {
  const slots = [slot("high", 0, 1001, 9000001), slot("high", 1, 1002, 9000002), slot("high", 2, 1003, 9000002)];
  const ranges: Record<number, number> = { 1001: 5000, 1002: 45000, 1003: Number.NaN };
  const got = classifySalvageModules(slots, groupOf, id => ranges[id] ?? null);
  assert.equal(got.salvagers[0]!.rangeM, 5000);
  assert.deepEqual(got.tractors.map(m => m.rangeM), [45000, null]);
});

test("maxRangeFromDogma reads attribute 54 of the module's own row in the ship", () => {
  const rows = [
    { itemID: 1002, typeID: 9000002, locationID: 5001, attributes: [{ attributeID: 6, value: 10 }, { attributeID: 54, value: 48000 }] },
    { itemID: 1001, typeID: 9000001, locationID: 5001, attributes: [{ attributeID: 6, value: 10 }] },
    { itemID: 1003, typeID: 9000002, locationID: 5999, attributes: [{ attributeID: 54, value: 1 }] },
  ];
  const rangeOf = maxRangeFromDogma(rows, 5001);
  assert.equal(rangeOf(1002, 9000002), 48000);
  assert.equal(rangeOf(1001, 9000001), null);
  assert.equal(rangeOf(1003, 9000002), null);
  assert.equal(rangeOf(1002, 1), null);
  assert.equal(maxRangeFromDogma(null, 5001)(1002, 9000002), null);
});

test("tractorsInReach keeps the ones that reach, longest first, never an unknown reach", () => {
  const modules = { salvagers: [], tractors: [
    { moduleID: 3, typeID: 1, rangeM: 20000 }, { moduleID: 1, typeID: 1, rangeM: 45000 },
    { moduleID: 2, typeID: 1, rangeM: null }, { moduleID: 4, typeID: 1, rangeM: 45000 },
  ] };
  assert.deepEqual(tractorsInReach(modules, 30000).map(m => m.moduleID), [1, 4]);
  assert.deepEqual(tractorsInReach(modules, 10000).map(m => m.moduleID), [1, 4, 3]);
  assert.deepEqual(tractorsInReach(modules, 50000), []);
});
