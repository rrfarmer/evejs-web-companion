// splitNeverFits: which looted rows can never be carried, however empty the
// ship is. Capacity decides, never free space, and unknown is never a verdict.

import test from "node:test";
import assert from "node:assert/strict";

import { splitNeverFits } from "./bayRouting.ts";
import type { InventoryItemRow, ShipBay } from "../store/types.ts";

function row(itemID: number, categoryID: number | null, groupID: number | null, quantity: number, volume: number | null | undefined): InventoryItemRow {
  return { itemID, typeID: 1, groupID, categoryID, flagID: null, quantity, singleton: false, volume };
}

function bay(key: string, present: boolean | null): ShipBay {
  return { key, label: key, present, capacity: null, items: null, error: null };
}

const caps = (table: Record<string, number | null>) => (b: string | null): number | null => table[b ?? "cargo"] ?? null;
const ids = (rows: readonly InventoryItemRow[]): number[] => rows.map((r) => r.itemID);

test("a unit bigger than the empty cargo hold never fits", () => {
  const out = splitNeverFits([row(1, 7, 100, 1, 4000)], [], caps({ cargo: 350 }));
  assert.deepEqual(ids(out.neverFits), [1]);
  assert.deepEqual(ids(out.rest), []);
});

test("a unit that fits when empty is rest, however full the ship is now", () => {
  const out = splitNeverFits([row(1, 7, 100, 1, 300)], [], caps({ cargo: 350 }));
  assert.deepEqual(ids(out.neverFits), []);
  assert.deepEqual(ids(out.rest), [1]);
});

test("a unit exactly the size of the hold fits", () => {
  assert.deepEqual(ids(splitNeverFits([row(1, 7, 100, 1, 350)], [], caps({ cargo: 350 })).rest), [1]);
});

test("unknown volume is never a verdict", () => {
  const out = splitNeverFits(
    [row(1, 7, 100, 1, null), row(2, 7, 100, 1, undefined), row(3, 7, 100, 1, 0)],
    [],
    caps({ cargo: 1 }),
  );
  assert.deepEqual(ids(out.neverFits), []);
  assert.deepEqual(ids(out.rest), [1, 2, 3]);
});

test("unknown capacity is never a verdict", () => {
  const out = splitNeverFits([row(1, 7, 100, 1, 4000)], [], caps({ cargo: null }));
  assert.deepEqual(ids(out.neverFits), []);
  const zero = splitNeverFits([row(1, 7, 100, 1, 4000)], [], caps({ cargo: 0 }));
  assert.deepEqual(ids(zero.neverFits), []);
});

test("a stack whose single unit fits is not never-fit even if the stack does not", () => {
  const out = splitNeverFits([row(1, 7, 100, 1000, 1)], [], caps({ cargo: 350 }));
  assert.deepEqual(ids(out.neverFits), []);
  assert.deepEqual(ids(out.rest), [1]);
});

test("a row with a present specialised bay is judged against that bay, not cargo", () => {
  // Ore (category 25) with an ore hold of 5,000: a 4,000 unit fits the hold even
  // though it dwarfs the 350 cargo bay. Cargo is not its chain.
  const out = splitNeverFits([row(1, 25, 450, 1, 4000)], [bay("ore", true)], caps({ cargo: 350, ore: 5000 }));
  assert.deepEqual(ids(out.rest), [1]);
});

test("too big for its specialised bay is never-fit although cargo is larger", () => {
  const out = splitNeverFits([row(1, 25, 450, 1, 4000)], [bay("ore", true)], caps({ cargo: 9000, ore: 3000 }));
  assert.deepEqual(ids(out.neverFits), [1]);
});

test("a specialised bay that is absent or unread falls back to cargo", () => {
  const rows = [row(1, 25, 450, 1, 4000)];
  assert.deepEqual(ids(splitNeverFits(rows, [bay("ore", false)], caps({ cargo: 350, ore: 5000 })).neverFits), [1]);
  assert.deepEqual(ids(splitNeverFits(rows, [bay("ore", null)], caps({ cargo: 350, ore: 5000 })).neverFits), [1]);
  assert.deepEqual(ids(splitNeverFits(rows, [], caps({ cargo: 9000 })).rest), [1]);
});

test("a multi-bay chain needs every bay too small", () => {
  // Gas: gas hold then ore hold. Too big for gas but fits ore: rest.
  const gas = row(1, 25, 711, 1, 2000);
  const bays = [bay("gas", true), bay("ore", true)];
  assert.deepEqual(ids(splitNeverFits([gas], bays, caps({ gas: 1000, ore: 3000 })).rest), [1]);
  assert.deepEqual(ids(splitNeverFits([gas], bays, caps({ gas: 1000, ore: 1500 })).neverFits), [1]);
  // An unreadable second bay keeps the row alive.
  assert.deepEqual(ids(splitNeverFits([gas], bays, caps({ gas: 1000, ore: null })).neverFits), []);
});

test("mixed rows keep their order in each half", () => {
  const rows = [row(1, 7, 100, 1, 4000), row(2, 7, 100, 3, 10), row(3, 7, 100, 1, 9000), row(4, 7, 100, 1, null)];
  const out = splitNeverFits(rows, [], caps({ cargo: 350 }));
  assert.deepEqual(ids(out.neverFits), [1, 3]);
  assert.deepEqual(ids(out.rest), [2, 4]);
});

test("empty input yields empty halves", () => {
  const out = splitNeverFits([], [], caps({}));
  assert.deepEqual([out.neverFits.length, out.rest.length], [0, 0]);
});
