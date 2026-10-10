// R74 — the 11 RB-DOGMA bound-read decoders against REAL captured bytes.
//
// The fixtures below are the exact retail shapes captured live through the BFF's
// GET /api/bridge/bound-dogma (+ targeted /api/bridge/call for the two reads that
// default to empty), Farmer 140000005 docked Perimeter, 2026-07-22. See the wire
// notes atop boundDogma.ts. Every fixture is a real wire fragment, not a guess.
//
// ⚠ R7d / bigint: item & FILETIME values here exceed 2^53. The tests assert an
// oversized itemID stays an EXACT string and a FILETIME is never pushed through
// Number — the "test that asserts nothing" trap is guarded by sabotage runs.

import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeAttributeDescription,
  decodeAttributes,
  decodeAttributeValue,
  decodeBoundDogma,
  decodeGetAllInfo,
  decodeItemInfo,
  decodeLayerDamageValues,
  decodeLocationInfo,
  decodeRequiredSkillLevels,
  decodeTargeters,
  DOGMA_ATTR_DURATION,
  itemHasActivationCycle,
  type BoundDogmaAllInfo,
} from "./boundDogma.ts";
import type { JsonValue } from "./wire.ts";

// --- fixture builders (real shapes) ----------------------------------------

const SHIP_ITEM_ID = 9988400023309; // safe integer (< 2^53)
const CHAR_ID = 140000005;
const STATION_ID = 60000358;
const SHIP_TIME = "134292246678390000"; // FILETIME string, > 2^53
const SHIP_WALLCLOCK = "134292246678389999";

/** A decoded packedrow as the BFF's JSON-safe encoder emits it (name-keyed fields). */
function packedRow(fields: Record<string, JsonValue>): JsonValue {
  return {
    type: "packedrow",
    header: { type: "objectex1", header: [], list: [], dict: [] },
    columns: [
      ["itemID", 20],
      ["typeID", 3],
      ["ownerID", 3],
      ["locationID", 20],
      ["flagID", 2],
      ["quantity", 3],
      ["groupID", 3],
      ["categoryID", 3],
      ["customInfo", 129],
    ],
    fields,
  };
}

/** A GET-INFO ENTRY: util.KeyVal{itemID, invItem, activeEffects, time, attributes, wallclockTime}. */
function getInfoEntry(opts: {
  itemID: number | string;
  typeID: number;
  ownerID: number;
  locationID: number;
  flagID: number;
  groupID: number;
  categoryID: number;
  quantity: number;
  stacksize: number;
  customInfo: JsonValue;
  attributes: readonly (readonly [number, JsonValue])[];
  time?: string;
  wallclockTime?: string;
}): JsonValue {
  return {
    type: "object",
    name: "util.KeyVal",
    args: {
      type: "dict",
      entries: [
        ["itemID", opts.itemID],
        [
          "invItem",
          packedRow({
            itemID: opts.itemID,
            typeID: opts.typeID,
            ownerID: opts.ownerID,
            locationID: opts.locationID,
            flagID: opts.flagID,
            quantity: opts.quantity,
            groupID: opts.groupID,
            categoryID: opts.categoryID,
            customInfo: opts.customInfo,
            stacksize: opts.stacksize,
          }),
        ],
        ["activeEffects", { type: "dict", entries: [] }],
        ["time", opts.time ?? SHIP_TIME],
        [
          "attributes",
          { type: "dict", entries: opts.attributes.map(([k, v]) => [k, v]) },
        ],
        ["wallclockTime", opts.wallclockTime ?? SHIP_WALLCLOCK],
      ],
    },
  };
}

const SHIP_ENTRY = getInfoEntry({
  itemID: SHIP_ITEM_ID,
  typeID: 17480,
  ownerID: CHAR_ID,
  locationID: STATION_ID,
  flagID: 4,
  groupID: 463,
  categoryID: 6,
  quantity: -1,
  stacksize: 1,
  customInfo: null,
  // [attributeID, value] — the real dict carries 471; a representative few here,
  // including a FLOAT (11 -> 112.5) so the float path is exercised.
  attributes: [
    [3, 0],
    [4, 25000000],
    [9, 6000],
    [11, 112.5],
  ],
});

const FITTED_ENTRY = getInfoEntry({
  itemID: 9988400023307,
  typeID: 2456,
  ownerID: CHAR_ID,
  locationID: SHIP_ITEM_ID,
  flagID: 27,
  groupID: 53,
  categoryID: 7,
  quantity: -1,
  stacksize: 1,
  customInfo: "",
  attributes: [[6, 1]],
});

const CHAR_ATTR_ENTRY = getInfoEntry({
  itemID: CHAR_ID,
  typeID: 1386,
  ownerID: CHAR_ID,
  locationID: SHIP_ITEM_ID,
  flagID: 57,
  groupID: 1,
  categoryID: 3,
  quantity: -1,
  stacksize: 1,
  customInfo: "",
  attributes: [
    [164, 20],
    [165, 20],
  ],
});

function getAllInfoResult(): JsonValue {
  return {
    type: "object",
    name: "util.KeyVal",
    args: {
      type: "dict",
      entries: [
        ["systemWideEffectsOnShip", { type: "dict", entries: [] }],
        ["shipModifiedCharAttribs", CHAR_ATTR_ENTRY],
        ["structureInfo", { type: "dict", entries: [] }],
        ["locationInfo", { type: "dict", entries: [] }],
        [
          "shipInfo",
          {
            type: "dict",
            entries: [
              [SHIP_ITEM_ID, SHIP_ENTRY],
              [9988400023307, FITTED_ENTRY],
            ],
          },
        ],
        ["activeShipID", SHIP_ITEM_ID],
        [
          "shipState",
          [
            { type: "dict", entries: [["online", true]] },
            { type: "dict", entries: [] },
            { type: "dict", entries: [] },
            { type: "dict", entries: [["a", 1]] },
          ],
        ],
        [
          "charInfo",
          [
            { type: "dict", entries: [[CHAR_ID, CHAR_ATTR_ENTRY]] },
            [0, [], [], []],
          ],
        ],
      ],
    },
  };
}

// GetLayerDamageValuesByItems([shipID]) — captured verbatim (own ship, undamaged).
function layerDamageResult(): JsonValue {
  return {
    type: "dict",
    entries: [
      [
        SHIP_ITEM_ID,
        {
          type: "object",
          name: "util.KeyVal",
          args: {
            type: "dict",
            entries: [
              [
                "shieldInfo",
                {
                  type: "list",
                  items: [
                    { type: "real", value: 6000 },
                    { type: "real", value: 6000 },
                    { type: "real", value: 2500000 },
                  ],
                },
              ],
              ["armorInfo", { type: "real", value: 5000 }],
              ["hullInfo", { type: "real", value: 6000 }],
              ["armorDamage", { type: "real", value: 0 }],
              ["hullDamage", { type: "real", value: 0 }],
              ["shieldRatio", { type: "real", value: 1 }],
              ["armorRatio", { type: "real", value: 1 }],
              ["hullRatio", { type: "real", value: 1 }],
              ["armorMax", { type: "real", value: 5000 }],
              ["hullMax", { type: "real", value: 6000 }],
            ],
          },
        },
      ],
    ],
  };
}

// --- decodeItemInfo ---------------------------------------------------------

test("decodeItemInfo reads the invItem packedrow fields + attributes", () => {
  const info = decodeItemInfo(SHIP_ENTRY);
  assert.ok(info);
  assert.equal(info.itemID, SHIP_ITEM_ID);
  assert.equal(info.typeID, 17480);
  assert.equal(info.ownerID, CHAR_ID);
  assert.equal(info.locationID, STATION_ID);
  assert.equal(info.flagID, 4);
  assert.equal(info.groupID, 463);
  assert.equal(info.categoryID, 6);
  assert.equal(info.quantity, -1);
  assert.equal(info.stacksize, 1);
  assert.equal(info.customInfo, null);
  // 4 attributes incl. the float 112.5.
  assert.equal(info.attributes.length, 4);
  const mass = info.attributes.find((a) => a.attributeID === 4);
  assert.equal(mass?.value, 25000000);
  const frac = info.attributes.find((a) => a.attributeID === 11);
  assert.equal(frac?.value, 112.5);
});

test("decodeItemInfo keeps FILETIME time/wallclockTime as EXACT strings (never Number)", () => {
  const info = decodeItemInfo(SHIP_ENTRY);
  assert.ok(info);
  assert.equal(info.time, SHIP_TIME);
  assert.equal(info.wallclockTime, SHIP_WALLCLOCK);
  assert.equal(typeof info.time, "string");
  // A FILETIME whose low digits fall below the double ULP proves the string path
  // never passes through Number (which would round those digits away).
  const odd = getInfoEntry({
    itemID: SHIP_ITEM_ID,
    typeID: 17480,
    ownerID: CHAR_ID,
    locationID: STATION_ID,
    flagID: 4,
    groupID: 463,
    categoryID: 6,
    quantity: -1,
    stacksize: 1,
    customInfo: null,
    attributes: [],
    time: "134292246678390007",
  });
  const oddInfo = decodeItemInfo(odd);
  assert.equal(oddInfo?.time, "134292246678390007");
  assert.notEqual(Number("134292246678390007").toString(), "134292246678390007");
});

test("decodeItemInfo keeps an oversized itemID as an EXACT string (R7d, bigint-safe)", () => {
  const bigId = "9223372036854775807"; // > 2^53
  const entry = getInfoEntry({
    itemID: bigId,
    typeID: 17480,
    ownerID: CHAR_ID,
    locationID: STATION_ID,
    flagID: 4,
    groupID: 463,
    categoryID: 6,
    quantity: -1,
    stacksize: 1,
    customInfo: null,
    attributes: [],
  });
  const info = decodeItemInfo(entry);
  assert.equal(info?.itemID, bigId);
  assert.equal(typeof info?.itemID, "string");
});

test("decodeItemInfo returns null for a non-object", () => {
  assert.equal(decodeItemInfo(null), null);
  assert.equal(decodeItemInfo({ type: "list", items: [] }), null);
});

// --- decodeGetAllInfo -------------------------------------------------------

test("decodeGetAllInfo pulls activeShipID, the ship + fitted items, and the character", () => {
  const all = decodeGetAllInfo(getAllInfoResult());
  assert.equal(all.activeShipID, SHIP_ITEM_ID);
  assert.equal(all.ships.length, 2);
  const [ship, fitted] = all.ships;
  assert.ok(ship && fitted);
  assert.equal(ship.typeID, 17480);
  assert.equal(ship.categoryID, 6);
  assert.equal(fitted.itemID, 9988400023307);
  assert.equal(fitted.flagID, 27);
  assert.equal(all.characterID, CHAR_ID);
  assert.ok(all.character);
  assert.equal(all.character?.typeID, 1386);
  assert.equal(all.character?.attributes.length, 2);
  assert.ok(all.shipModifiedCharAttributes);
  assert.equal(all.shipModifiedCharAttributes?.itemID, CHAR_ID);
});

test("decodeGetAllInfo passes the deep pieces through losslessly", () => {
  const all = decodeGetAllInfo(getAllInfoResult());
  // shipState is a 4-tuple of dicts, carried verbatim.
  assert.ok(Array.isArray(all.shipState));
  assert.equal((all.shipState as readonly JsonValue[]).length, 4);
  // charBrain is charInfo[1], carried verbatim.
  assert.deepEqual(all.charBrain, [0, [], [], []]);
  // Empty-but-present docked keys survive as their real (empty dict) shape.
  assert.deepEqual(all.systemWideEffectsOnShip, { type: "dict", entries: [] });
  assert.deepEqual(all.structureInfo, { type: "dict", entries: [] });
});

// --- decodeTargeters --------------------------------------------------------

test("decodeTargeters returns [] for the empty (docked) state", () => {
  assert.deepEqual(decodeTargeters({ type: "list", items: [] }), []);
});

test("decodeTargeters returns the locking itemIDs when populated", () => {
  const ids = decodeTargeters({ type: "list", items: [9988400099999, 9988400088888] });
  assert.deepEqual(ids, [9988400099999, 9988400088888]);
});

// --- decodeAttributes (character / all-attrs / drone settings) --------------

test("decodeAttributes reads a numeric attribute dict (GetCharacterAttributes)", () => {
  const attrs = decodeAttributes({
    type: "dict",
    entries: [
      [164, 20],
      [165, 20],
      [166, 19],
    ],
  });
  assert.equal(attrs.length, 3);
  assert.deepEqual(
    attrs.map((a) => [a.attributeID, a.value]),
    [
      [164, 20],
      [165, 20],
      [166, 19],
    ],
  );
});

test("decodeAttributes keeps BOOLEAN values (GetDroneSettingAttributes)", () => {
  const attrs = decodeAttributes({
    type: "dict",
    entries: [
      [1275, true],
      [1297, false],
    ],
  });
  assert.deepEqual(
    attrs.map((a) => [a.attributeID, a.value]),
    [
      [1275, true],
      [1297, false],
    ],
  );
});

test("decodeAttributes unwraps a real-wrapped float value", () => {
  const attrs = decodeAttributes({ type: "dict", entries: [[9, { type: "real", value: 112.5 }]] });
  assert.equal(attrs[0]?.value, 112.5);
});

// --- decodeRequiredSkillLevels ----------------------------------------------

test("decodeRequiredSkillLevels returns [] for typeID 0 (empty dict)", () => {
  assert.deepEqual(decodeRequiredSkillLevels({ type: "dict", entries: [] }), []);
});

test("decodeRequiredSkillLevels reads skillTypeID -> level (type 597 live shape)", () => {
  const reqs = decodeRequiredSkillLevels({ type: "dict", entries: [[3331, 1]] });
  assert.deepEqual(reqs, [{ skillTypeID: 3331, level: 1 }]);
});

// --- decodeLayerDamageValues ------------------------------------------------

test("decodeLayerDamageValues returns [] for the empty (no items) request", () => {
  assert.deepEqual(decodeLayerDamageValues({ type: "dict", entries: [] }), []);
});

test("decodeLayerDamageValues decodes the own-ship shield/armor/hull layers", () => {
  const rows = decodeLayerDamageValues(layerDamageResult());
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  assert.equal(row.itemID, SHIP_ITEM_ID);
  assert.deepEqual(row.shield, { current: 6000, max: 6000, recharge: 2500000 });
  assert.equal(row.armorInfo, 5000);
  assert.equal(row.hullInfo, 6000);
  assert.equal(row.armorDamage, 0);
  assert.equal(row.hullRatio, 1);
  assert.equal(row.armorMax, 5000);
});

test("decodeLayerDamageValues yields a null shield when the item has no shield layer", () => {
  const rows = decodeLayerDamageValues({
    type: "dict",
    entries: [
      [
        123,
        {
          type: "object",
          name: "util.KeyVal",
          args: { type: "dict", entries: [["shieldInfo", { type: "real", value: 0 }], ["armorInfo", { type: "real", value: 100 }]] },
        },
      ],
    ],
  });
  const only = rows[0];
  assert.ok(only);
  assert.equal(only.shield, null);
  assert.equal(only.armorInfo, 100);
});

// --- decodeAttributeValue ---------------------------------------------------

test("decodeAttributeValue reads a bare scalar (own-ship mass)", () => {
  assert.equal(decodeAttributeValue(25000000), 25000000);
  assert.equal(decodeAttributeValue({ type: "real", value: 112.5 }), 112.5);
  assert.equal(decodeAttributeValue(null), null);
});

// --- decodeAttributeDescription ---------------------------------------------

test("decodeAttributeDescription reads the debug string list", () => {
  const lines = decodeAttributeDescription({
    type: "list",
    items: ["Item ID:9988400023309", "Reason:", "Server value:25000000", "Base value:25000000"],
  });
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "Item ID:9988400023309");
});

// --- decodeLocationInfo -----------------------------------------------------

test("decodeLocationInfo reads the [ownerID, locationID, 0] tuple", () => {
  const loc = decodeLocationInfo([3, STATION_ID, 0]);
  assert.equal(loc.ownerID, 3);
  assert.equal(loc.locationID, STATION_ID);
  assert.equal(loc.extra, 0);
});

// --- decodeBoundDogma (whole envelope) --------------------------------------

function envelope(): JsonValue {
  return {
    ok: true,
    characterID: CHAR_ID,
    reads: {
      GetAllInfo: { result: getAllInfoResult() },
      ItemGetInfo: { result: SHIP_ENTRY },
      GetTargeters: { result: { type: "list", items: [] } },
      GetDroneSettingAttributes: {
        result: { type: "dict", entries: [[1275, true], [1297, false]] },
      },
      GetCharacterAttributes: { result: { type: "dict", entries: [[164, 20], [165, 20]] } },
      GetRequiredSkillLevels: { result: { type: "dict", entries: [] } },
      GetLayerDamageValuesByItems: { result: { type: "dict", entries: [] } },
      QueryAllAttributesForItem: {
        result: { type: "dict", entries: [[4, 25000000], [9, 6000]] },
      },
      QueryAttributeValue: { result: 25000000 },
      FullyDescribeAttribute: { result: { type: "list", items: ["Item ID:x", "Reason:"] } },
      GetLocationInfo: { result: [3, STATION_ID, 0] },
    },
  };
}

test("decodeBoundDogma folds the whole envelope into typed reads", () => {
  const dogma = decodeBoundDogma(envelope());
  assert.equal(dogma.allInfo.value?.activeShipID, SHIP_ITEM_ID);
  assert.equal(dogma.allInfo.error, null);
  assert.equal(dogma.itemInfo.value?.typeID, 17480);
  assert.deepEqual(dogma.targeters.value, []);
  assert.equal(dogma.droneSettingAttributes.value.length, 2);
  assert.equal(dogma.characterAttributes.value.length, 2);
  assert.deepEqual(dogma.requiredSkillLevels.value, []);
  assert.deepEqual(dogma.layerDamageValues.value, []);
  assert.equal(dogma.allAttributesForItem.value.length, 2);
  assert.equal(dogma.attributeValue.value, 25000000);
  assert.equal(dogma.attributeDescription.value.length, 2);
  assert.equal(dogma.locationInfo.value?.locationID, STATION_ID);
});

test("decodeBoundDogma carries a per-read error through and never throws", () => {
  const dogma = decodeBoundDogma({
    ok: true,
    reads: {
      GetAllInfo: { error: "READ_FAILED", message: "boom" },
      GetTargeters: { result: { type: "list", items: [] } },
    },
  });
  assert.equal(dogma.allInfo.error, "READ_FAILED");
  assert.equal(dogma.allInfo.value, null);
  // A read absent from the envelope decodes to its empty value, error null.
  assert.deepEqual(dogma.characterAttributes.value, []);
  assert.equal(dogma.characterAttributes.error, null);
});

test("the envelope the route gives, all info alone, decodes the ship and its modules with nothing else asked", () => {
  // Since 2026-10-09 the route asks GetAllInfo and no more, as the retail client's godma does.
  const dogma = decodeBoundDogma({ ok: true, characterID: CHAR_ID, reads: { GetAllInfo: { result: getAllInfoResult() } } });
  assert.equal(dogma.allInfo.error, null);
  assert.equal(dogma.allInfo.value?.activeShipID, SHIP_ITEM_ID);
  assert.deepEqual(dogma.allInfo.value, decodeBoundDogma(envelope()).allInfo.value);
  // What was not asked is empty, and not a failure.
  assert.deepEqual([dogma.itemInfo.value, dogma.itemInfo.error, dogma.locationInfo.value, dogma.attributeValue.value], [null, null, null, null]);
  assert.deepEqual([dogma.targeters.value, dogma.layerDamageValues.value, dogma.requiredSkillLevels.value, dogma.attributeDescription.value], [[], [], [], []]);
  for (const cell of Object.values(dogma)) assert.equal(cell.error, null);
});

test("decodeBoundDogma tolerates a missing/empty envelope", () => {
  const dogma = decodeBoundDogma(null);
  assert.equal(dogma.allInfo.value, null);
  assert.deepEqual(dogma.targeters.value, []);
  assert.equal(dogma.attributeValue.value, null);
});


// --- can this module be cycled at all? --------------------------------------

function dogmaWith(
  items: readonly { itemID: number; duration?: number | null; speed?: number | null }[],
): BoundDogmaAllInfo {
  return {
    activeShipID: 90000700,
    ships: items.map((item) => ({
      itemID: item.itemID,
      typeID: 90000800,
      ownerID: null,
      locationID: null,
      flagID: null,
      groupID: null,
      categoryID: null,
      quantity: null,
      stacksize: null,
      customInfo: null,
      time: null,
      wallclockTime: null,
      attributes: [
        ...(item.duration === undefined ? [] : [{ attributeID: DOGMA_ATTR_DURATION, value: item.duration }]),
        // Attribute 51, speed: a weapon's rate of fire.
        ...(item.speed === undefined ? [] : [{ attributeID: 51, value: item.speed }]),
      ],
      activeEffects: null,
    })),
    character: null,
    characterID: null,
    shipModifiedCharAttributes: null,
    shipState: null,
    charBrain: null,
    systemWideEffectsOnShip: null,
    structureInfo: null,
    locationInfo: null,
  };
}

test("a module with a cycle time can be activated; one without cannot", () => {
  // ⚠ THE REAL CASES, READ OFF THE SDE ON 2026-09-11 and the reason this
  // function exists at all. Damage Control II carries NO duration and is
  // passive the moment it is online. Assault Damage Control II carries 10125.
  // BOTH ARE IN GROUP 60 "Damage Control", so the group name -- which is all
  // the module classifier had -- cannot tell them apart, and never could.
  const dogma = dogmaWith([
    { itemID: 90000101 }, // Damage Control II: no duration attribute at all
    { itemID: 90000102, duration: 10125 }, // Assault Damage Control II
    { itemID: 90000103, duration: 10000 }, // Multispectrum Shield Hardener II
    { itemID: 90000104, duration: null }, // present, unreadable value
  ]);
  assert.equal(itemHasActivationCycle(dogma, 90000101), false, "plain Damage Control is passive");
  assert.equal(itemHasActivationCycle(dogma, 90000102), true, "Assault Damage Control cycles");
  assert.equal(itemHasActivationCycle(dogma, 90000103), true);
  assert.equal(itemHasActivationCycle(dogma, 90000104), false, "no usable duration is no cycle");
});

test("a weapon cycles by its rate of fire, which is an attribute of its own and not the duration", () => {
  // The static data's nine weapon effects (targetAttack, projectileFired, useMissiles, the disintegrator's and the
  // rest) name attribute 51, speed, as their duration, where 130 others name 73. A 250mm railgun carries a speed
  // of 5825 and no duration at all, and so does every turret and launcher: read off the static data on 2026-10-10.
  // With the duration alone asked for, a companion's guns were all taken for passive and it had none.
  const dogma = dogmaWith([
    { itemID: 90000201, speed: 5825 }, // a turret: a rate of fire, and no duration
    { itemID: 90000202, speed: 1500, duration: 10000 }, // a probe launcher has both
    { itemID: 90000203, speed: 0 }, // a rate of fire of nothing
    { itemID: 90000204, speed: null }, // present, unreadable
    { itemID: 90000205, speed: 0, duration: 3000 },
    { itemID: 90000206, speed: 4000, duration: 0 },
    { itemID: 90000207, speed: null, duration: null },
  ]);
  assert.equal(itemHasActivationCycle(dogma, 90000201), true, "a turret cycles");
  assert.equal(itemHasActivationCycle(dogma, 90000202), true);
  assert.equal(itemHasActivationCycle(dogma, 90000203), false, "no rate of fire and no duration is no cycle");
  assert.equal(itemHasActivationCycle(dogma, 90000204), false);
  assert.equal(itemHasActivationCycle(dogma, 90000205), true, "the duration alone is enough");
  assert.equal(itemHasActivationCycle(dogma, 90000206), true, "the rate of fire alone is enough");
  assert.equal(itemHasActivationCycle(dogma, 90000207), false);
});

test("no dogma, or an item that is not in it, is NOT KNOWN rather than passive", () => {
  // ⚠ THE THIRD STATE, AND THE CALLER DEPENDS ON IT. Reading "cannot say" as
  // "passive" would stop a ship hardening every time the dogma read stumbled --
  // which it is allowed to do, because loadFitting deliberately does not gate
  // the fit on it.
  assert.equal(itemHasActivationCycle(null, 90000101), null);
  assert.equal(itemHasActivationCycle(dogmaWith([]), 90000101), null);
  assert.equal(itemHasActivationCycle(dogmaWith([{ itemID: 90000999 }]), 90000101), null);
});

test("a zero duration is not a cycle", () => {
  assert.equal(itemHasActivationCycle(dogmaWith([{ itemID: 90000101, duration: 0 }]), 90000101), false);
});
