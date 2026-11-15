import assert from "node:assert/strict";
import test from "node:test";
import type { InventoryItemRow } from "../store/types.ts";
import {
  addInventoryFilterTypes, FILTER_FIELD as F, FILTER_OP as O, matchInventoryFilter,
  readInventoryFilters, roundInventoryFilterPrice, writeInventoryFilters, type InventoryFilter,
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
