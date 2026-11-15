import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canMergeStacks,
  decodeCapacity,
  decodeContainer,
  decodeInventoryRows,
  divisionLabel,
  isBoardableShip,
  isOpenableContainer,
} from "./inventoryShip.ts";
import type { JsonValue } from "./wire.ts";

// Handler-shaped fixtures: invbroker List returns a packed-row list (or, when
// empty and flag-scoped, a python set wrapping an empty list); GetCapacity
// returns a util.KeyVal {capacity, used}.

function packedRow(fields: Record<string, JsonValue>): JsonValue {
  return { type: "packedrow", fields };
}

test("the native blueprint-copy singleton stays identified and counts as one item", () => {
  const [copy] = decodeInventoryRows({ type: "list", items: [
    packedRow({ itemID: 700, typeID: 950, groupID: 105, categoryID: 9, flagID: 4, quantity: -2, stacksize: 1, singleton: 2 }),
  ] });
  assert.equal(copy?.blueprintCopy, true);
  assert.equal(copy?.singleton, true);
  assert.equal(copy?.quantity, 1);
});

const HANGAR_LIST: JsonValue = {
  type: "list",
  items: [
    packedRow({ itemID: 100, typeID: 34, groupID: 18, categoryID: 4, flagID: 4, quantity: 750, singleton: 0 }),
    packedRow({ itemID: 200, typeID: 597, groupID: 25, categoryID: 6, flagID: 4, quantity: 1, singleton: 1 }),
  ],
};

// The real wire shape of a python set (objectex1 with a __builtin__.set token
// header wrapping the inner list) — what invbroker List actually emits for the
// empty/flag-scoped case, not the {type:"object"} shape a prior fixture assumed.
function pythonSet(inner: JsonValue): JsonValue {
  return {
    type: "objectex1",
    header: [{ type: "token", value: "__builtin__.set" }, [inner]],
    list: [],
    dict: [],
  };
}

const EMPTY_SET: JsonValue = pythonSet({ type: "list", items: [] });

const CAPACITY: JsonValue = {
  type: "object",
  name: "util.KeyVal",
  args: { type: "dict", entries: [["capacity", 135], ["used", 7.5]] },
};

test("decodeInventoryRows decodes a packed-row list, dropping rows without an itemID", () => {
  const rows = decodeInventoryRows(HANGAR_LIST);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    itemID: 100,
    typeID: 34,
    groupID: 18,
    categoryID: 4,
    flagID: 4,
    quantity: 750,
    singleton: false,
    volume: null, // no volume map supplied → unknown
  });
  assert.equal(rows[1]!.itemID, 200);
  assert.equal(rows[1]!.singleton, true);
  assert.equal(rows[1]!.categoryID, 6);
});

test("decodeInventoryRows attaches per-unit volume from the supplied map", () => {
  // Tritanium (typeID 34) at 0.01 m³/unit; an unknown type stays null.
  const rows = decodeInventoryRows(HANGAR_LIST, { "34": 0.01 });
  assert.equal(rows[0]!.typeID, 34);
  assert.equal(rows[0]!.volume, 0.01);
  assert.equal(rows[1]!.volume, null, "a type absent from the map is unknown, never zero");
});

test("decodeInventoryRows unwraps an empty python set to no rows", () => {
  assert.deepEqual(decodeInventoryRows(EMPTY_SET), []);
});

test("decodeInventoryRows unwraps a NON-empty python set (real objectex1 shape)", () => {
  const set = pythonSet({
    type: "list",
    items: [packedRow({ itemID: 300, typeID: 34, flagID: 5, quantity: 10, singleton: 0 })],
  });
  const rows = decodeInventoryRows(set);
  assert.equal(rows.length, 1, "a populated docked-ship set must not silently drop its rows");
  assert.equal(rows[0]!.itemID, 300);
  assert.equal(rows[0]!.quantity, 10);
});

test("decodeInventoryRows decodes long-encoded numeric fields (no silent zero)", () => {
  const rows = decodeInventoryRows({
    type: "list",
    items: [
      packedRow({
        itemID: { type: "long", value: "1002000300040005" },
        typeID: 34,
        flagID: 5,
        quantity: { type: "long", value: 250 },
        singleton: 0,
      }),
    ],
  });
  assert.equal(rows[0]!.itemID, 1002000300040005, "a {type:long} id must not read as 0");
  assert.equal(rows[0]!.quantity, 250);
});

test("decodeInventoryRows falls back to stacksize when quantity is absent", () => {
  const rows = decodeInventoryRows({
    type: "list",
    items: [packedRow({ itemID: 5, typeID: 34, flagID: 5, stacksize: 42 })],
  });
  assert.equal(rows[0]!.quantity, 42);
});

test("an assembled item counts as ONE, not as the -1 the wire carries", () => {
  // ⚠ THE BUG THIS PINS. A dropped module in a wreck crosses as `quantity: -1`
  // — retail's marker for "one object", the same convention personalAssets and
  // shipBays already normalise. Kept raw, it was a negative quantity fed to
  // every consumer that measures a stack: `planLootTransfers` saw -1 <= 0 and
  // placed the row NOWHERE, so a wreck of nothing but modules planned no
  // transfers and the loot path announced "There is no room aboard" at a hull
  // with every hold empty.
  const rows = decodeInventoryRows({
    type: "list",
    items: [
      packedRow({ itemID: 90061, typeID: 485, groupID: 55, categoryID: 7, flagID: null, quantity: -1, stacksize: 1, singleton: 1 }),
    ],
  });
  assert.equal(rows[0]!.quantity, 1, "one object is one, never minus one");
  assert.equal(rows[0]!.singleton, true, "and it is still flagged assembled");
});

test("a singleton spelled as a BOOLEAN is still a singleton", () => {
  // boundInventory accepts 1 and true for this field; the two decoders read the
  // same wire and must not disagree about what an assembled item is.
  const rows = decodeInventoryRows({
    type: "list",
    items: [packedRow({ itemID: 7, typeID: 485, quantity: -1, singleton: true })],
  });
  assert.equal(rows[0]!.quantity, 1);
  assert.equal(rows[0]!.singleton, true);
});

test("decodeInventoryRows tolerates malformed input", () => {
  assert.deepEqual(decodeInventoryRows(null), []);
  assert.deepEqual(decodeInventoryRows({ type: "dict", entries: [] } as JsonValue), []);
  assert.deepEqual(decodeInventoryRows([1, 2, 3] as unknown as JsonValue), []);
});

test("decodeCapacity reads the util.KeyVal capacity/used pair", () => {
  assert.deepEqual(decodeCapacity(CAPACITY), { capacity: 135, used: 7.5 });
});

test("decodeCapacity returns null for a non-KeyVal result", () => {
  assert.equal(decodeCapacity(null), null);
  assert.equal(decodeCapacity({ type: "list", items: [] } as JsonValue), null);
});

test("decodeContainer bundles rows, capacity, and a preserved per-container error", () => {
  const container = decodeContainer(HANGAR_LIST, CAPACITY, null);
  assert.equal(container.rows.length, 2);
  assert.deepEqual(container.capacity, { capacity: 135, used: 7.5 });
  assert.equal(container.error, null);

  // A failed read keeps its error and yields no rows/capacity (the other
  // container is unaffected — decoded independently).
  const failed = decodeContainer(null, null, "READ_FAILED");
  assert.deepEqual(failed.rows, []);
  assert.equal(failed.capacity, null);
  assert.equal(failed.error, "READ_FAILED");
});

test("isBoardableShip recognizes hangar ships that are not already active", () => {
  const ship = { itemID: 200, typeID: 597, groupID: 25, categoryID: 6, flagID: 4, quantity: 1, singleton: true };
  const trit = { itemID: 100, typeID: 34, groupID: 18, categoryID: 4, flagID: 4, quantity: 750, singleton: false };
  assert.equal(isBoardableShip(ship, null), true);
  assert.equal(isBoardableShip(ship, 200), false, "the active ship is not boardable");
  assert.equal(isBoardableShip(trit, null), false, "a non-ship is not boardable");
});

// --- R14 inventory depth ----------------------------------------------------

function row(overrides: Record<string, unknown> = {}) {
  return {
    itemID: 100,
    typeID: 34,
    groupID: 18,
    categoryID: 4,
    flagID: 4,
    quantity: 750,
    singleton: false,
    ...overrides,
  } as Parameters<typeof isOpenableContainer>[0];
}

test("isOpenableContainer accepts ASSEMBLED container groups only", () => {
  // Container-ness is a purely client-side static-data test: the protocol has
  // no notion of it, and the bind for a container is the ship-cargo bind.
  for (const groupID of [12, 340, 448, 649]) {
    assert.equal(
      isOpenableContainer(row({ groupID, categoryID: 2, typeID: 3297, singleton: true })),
      true,
      `group ${groupID} is a container`,
    );
  }
  // An UNASSEMBLED container is just cargo — it stacks and holds nothing.
  assert.equal(
    isOpenableContainer(row({ groupID: 12, categoryID: 2, typeID: 3297, singleton: false })),
    false,
    "an unassembled container cannot be opened",
  );
  // Ordinary cargo and ships are not containers.
  assert.equal(isOpenableContainer(row()), false);
  assert.equal(
    isOpenableContainer(row({ groupID: 25, categoryID: 6, typeID: 597, singleton: true })),
    false,
    "a ship is not an openable container here",
  );
});

test("canMergeStacks allows only two different LOOSE stacks of one type", () => {
  const first = row({ itemID: 100, quantity: 750 });
  const second = row({ itemID: 101, quantity: 250 });
  assert.equal(canMergeStacks(first, second), true);

  // Same stack.
  assert.equal(canMergeStacks(first, first), false);
  // Different types cannot merge.
  assert.equal(canMergeStacks(first, row({ itemID: 101, typeID: 35 })), false);
  // An ASSEMBLED item is a single object, not a quantity.
  assert.equal(canMergeStacks(row({ singleton: true }), second), false);
  assert.equal(canMergeStacks(first, row({ itemID: 101, singleton: true })), false);
});

test("divisionLabel falls back to the ordinal — never to a flag number", () => {
  assert.equal(divisionLabel(1, "Ore Bay"), "Ore Bay");
  // A corporation that never renamed a division has no name for it. The
  // fallback is plain player language, not flagCorpSAG3 and not 117.
  assert.equal(divisionLabel(3, null), "Division 3");
  assert.equal(divisionLabel(3, "   "), "Division 3");
  for (let division = 1; division <= 7; division += 1) {
    const label = divisionLabel(division, null);
    assert.equal(label, `Division ${division}`);
    assert.equal(
      label.includes(String(114 + division)),
      false,
      "no flag number leaks into a label",
    );
  }
});
