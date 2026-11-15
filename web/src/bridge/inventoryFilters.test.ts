import assert from "node:assert/strict";
import test from "node:test";
import type { InventoryItemRow } from "../store/types.ts";
import {
  addInventoryFilterTypes, FILTER_FIELD as F, FILTER_OP as O, matchInventoryFilter,
  parseInventoryFilterLink, readInventoryFilters, readSharedInventoryFilter, roundInventoryFilterPrice,
  shareInventoryFilter, writeInventoryFilters, type InventoryFilter,
} from "./inventoryFilters.ts";

test("inventory filters load the retail YAML sequence and retain every condition on save", () => {
  const native = "- - 'Ore: basics'\n  - 2\n  - - - 7\n      - 3\n      - Veldspar\n    - - 14\n      - 3\n      - true\n";
  const filters: InventoryFilter[] = [["Ore: basics", 2, [[F.name, O.is, "Veldspar"], [F.blueprintCopy, O.is, true]]]];
  assert.deepEqual(readInventoryFilters(native), filters);
  const examples: InventoryFilter[] = [...filters, ["Yes", 1, [[F.name, O.is, "on"]]]];
  assert.deepEqual(readInventoryFilters(writeInventoryFilters(examples)), examples);
  assert.deepEqual(readInventoryFilters(writeInventoryFilters([])), []);
  assert.throws(() => readInventoryFilters("- bad entry\n"));
});

test("item-filter links store the draft and load the native shared-settings YAML", async () => {
  const hash = "9a".repeat(20);
  const filter: InventoryFilter = ["On", 1, [[F.name, O.is, "no"], [F.blueprintCopy, O.is, true]]];
  const url = await shareInventoryFilter(async (service, method, args) => {
    assert.equal(`${service}.${method}`, "sharedSettingsMgr.StoreSettingLinkAndGetID");
    assert.deepEqual(args, [2, filter]);
    return { type: "object", name: "util.KeyVal", args: { type: "dict", entries: [["hashvalue", hash], ["sqID", 12], ["settingTypeID", 2]] } };
  }, filter);
  assert.equal(url, `sharedSetting:${hash}//12//2`);
  assert.equal(parseInventoryFilterLink(`sharedSetting:${hash}//12//3`), null);
  assert.equal(parseInventoryFilterLink(`sharedSetting:${hash}//0//2`), null);
  assert.deepEqual(await readSharedInventoryFilter(async (service, method, args) => {
    assert.equal(`${service}.${method}`, "sharedSettingsMgr.GetStoredSharedSetting");
    assert.deepEqual(args, [[hash, 12, 2]]);
    return "- [filter, ['On', 1, [[7, 3, 'no'], [14, 3, true]]]]\n";
  }, url), filter);
  await assert.rejects(readSharedInventoryFilter(async () => null, url), /could not be read/);
});

test("dropping types appends unique Name Is rows in drop order", () => {
  assert.deepEqual(addInventoryFilterTypes([[F.name, O.is, "Veldspar"]], ["Veldspar", "Tritanium", "", "Pyerite", "Tritanium"]), [
    [F.name, O.is, "Veldspar"], [F.name, O.is, "Tritanium"], [F.name, O.is, "Pyerite"],
  ]);
});

const ore: InventoryItemRow = { itemID: 156, typeID: 1230, categoryID: 25, groupID: 462, flagID: 4, quantity: 50, singleton: false, volume: 0.1 };

test("all/any conditions use case-insensitive names and the full stack's volume", () => {
  const conditions = [[F.name, O.starts, "VELD"], [F.volume, O.equal, 5], [F.assembled, O.isnt, true]] as const;
  assert.equal(matchInventoryFilter(ore, "Veldspar", ["Ore", 1, conditions]), true);
  assert.equal(matchInventoryFilter(ore, "Tritanium", ["Ore", 1, conditions]), false);
  assert.equal(matchInventoryFilter(ore, "Tritanium", ["Ore", 2, conditions]), true);
  assert.equal(matchInventoryFilter(ore, "Veldspar", ["Ore", 1, [[F.name, O.notContains, "SPAR"]]]), false);
});

test("prices use retail rounding, with missing and pending values kept distinct", () => {
  assert.equal(roundInventoryFilterPrice(7.656), 7.66);
  assert.equal(roundInventoryFilterPrice(100_499), 100_000);
  assert.equal(roundInventoryFilterPrice(1_234_578_000), 1_235_000_000);
  const filter: InventoryFilter = ["Valuable", 1, [[F.price, O.greater, 100_000]]];
  assert.equal(matchInventoryFilter(ore, "Veldspar", filter), undefined);
  assert.equal(matchInventoryFilter(ore, "Veldspar", filter, { [F.price]: null }), false);
  assert.equal(matchInventoryFilter(ore, "Veldspar", filter, { [F.price]: 101_000 }), true);
});

test("the copy flag and assembled test distinguish singleton 2 from an original", () => {
  const original = { ...ore, quantity: 1, singleton: true, categoryID: 9 };
  const copy = { ...original, blueprintCopy: true } as const;
  assert.equal(matchInventoryFilter(original, "Merlin Blueprint", ["Copies", 1, [[F.blueprintCopy, O.is, true]]]), false);
  assert.equal(matchInventoryFilter(copy, "Merlin Blueprint", ["Copies", 1, [[F.blueprintCopy, O.is, true]]]), true);
  assert.equal(matchInventoryFilter(copy, "Merlin Blueprint", ["Assembled", 1, [[F.assembled, O.is, true]]]), false);
});
