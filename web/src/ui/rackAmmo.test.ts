// Reloading from the rack (rackAmmo.ts): which slots take charges, what an
// empty gun's tap means, how cargo becomes a menu, and what "Reload all" sends.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ammoChoices,
  rackChargeBadge,
  rackReloadPercent,
  rackReloading,
  rackSlotAction,
  rackTakesCharges,
  weaponGroups,
} from "./rackAmmo.ts";
import {
  applyChargeQuantityChanges,
  decodeChargeLoadNotification,
  decodeChargeQuantityChanges,
  shipEffectsInMultiEvent,
} from "../bridge/reloadNotifications.ts";
import type { RackModule, RackRow } from "./moduleRack.ts";
import type { FittingSlot, InventoryItemRow } from "../store/types.ts";

const LAUNCHER = 2410;
const SHIELD_BOOSTER = 10858;
const HAM_GROUP = 772;
const SCOURGE = 2629;
const INFERNO = 2621;
const LIGHT_MISSILE = 210;
const LIGHT_GROUP = 384;

const FITS = {
  [LAUNCHER]: { size: null, groups: [HAM_GROUP] },
};

function gun(
  itemID: number,
  charge: { typeID: number; quantity: number } | null = null,
  extra: Partial<RackModule> = {},
): RackModule {
  return {
    itemID,
    typeID: LAUNCHER,
    online: true,
    active: false,
    charge,
    overloaded: false,
    damage: 0,
    bankMasterID: null,
    bankMaster: false,
    bankSize: 1,
    ...extra,
  };
}

function rack(high: readonly (RackModule | null)[], mid: readonly (RackModule | null)[] = []): RackRow[] {
  return [
    { family: "high", label: "High", heat: null, slots: high.map((module) => ({ module })) },
    { family: "mid", label: "Mid", heat: null, slots: mid.map((module) => ({ module })) },
    { family: "low", label: "Low", heat: null, slots: [] },
  ];
}

function cargo(itemID: number, typeID: number, groupID: number, quantity: number): InventoryItemRow {
  return { itemID, typeID, groupID, categoryID: 8, flagID: 5, quantity, singleton: false } as InventoryItemRow;
}

test("a slot takes charges when the fit's table says so, or when something is already loaded", () => {
  assert.equal(rackTakesCharges(gun(1), FITS), true);
  assert.equal(rackTakesCharges({ ...gun(2), typeID: SHIELD_BOOSTER }, FITS), false);
  // No table entry, but a charge in it: proof enough.
  assert.equal(
    rackTakesCharges({ ...gun(3, { typeID: SCOURGE, quantity: 40 }), typeID: SHIELD_BOOSTER }, FITS),
    true,
  );
  // An unread table makes nothing a gun.
  assert.equal(rackTakesCharges(gun(4), {}), false);
});

test("⚠ an empty gun's tap opens the picker instead of a doomed activate", () => {
  assert.equal(rackSlotAction(gun(1), "activate", true, false), "load");
  // Even offline: loading is not activating.
  assert.equal(rackSlotAction(gun(1, null, { online: false }), null, true, false), "load");
});

test("a loaded gun, a reloading gun and a non-gun keep the plain tap", () => {
  assert.equal(rackSlotAction(gun(1, { typeID: SCOURGE, quantity: 40 }), "activate", true, false), "activate");
  assert.equal(rackSlotAction(gun(1), "activate", true, true), "activate", "charges are on their way");
  assert.equal(rackSlotAction(gun(1), "activate", false, false), "activate");
  assert.equal(rackSlotAction(gun(1, null, { active: true }), "deactivate", true, false), "deactivate");
});

test("cargo becomes one choice per charge type, likely fits first, stacks merged", () => {
  const rows = [
    cargo(10, LIGHT_MISSILE, LIGHT_GROUP, 500),
    cargo(11, SCOURGE, HAM_GROUP, 1000),
    cargo(12, INFERNO, HAM_GROUP, 30000),
    cargo(13, SCOURGE, HAM_GROUP, 2000),
    // Not a charge: never offered.
    { ...cargo(14, 34, 18, 100), categoryID: 4 },
  ];
  const choices = ammoChoices(LAUNCHER, rows, FITS);
  assert.deepEqual(
    choices.map((choice) => [choice.typeID, choice.quantity, choice.verdict]),
    [
      [INFERNO, 30000, true],
      [SCOURGE, 3000, true],
      [LIGHT_MISSILE, 500, false],
    ],
  );
  assert.deepEqual(choices[1]!.itemIDs, [11, 13], "every stack goes to the server");
});

test("⚠ a likely misfit is sorted last, never removed", () => {
  const choices = ammoChoices(LAUNCHER, [cargo(10, LIGHT_MISSILE, LIGHT_GROUP, 500)], FITS);
  assert.equal(choices.length, 1);
  assert.equal(choices[0]!.verdict, false);
});

test("weapon groups are the high rack's charge-taking modules, by type", () => {
  const rows = rack(
    [
      gun(1, { typeID: SCOURGE, quantity: 40 }),
      gun(2, { typeID: SCOURGE, quantity: 40 }),
      gun(3),
      { ...gun(4), typeID: SHIELD_BOOSTER },
      null,
    ],
    // Mid-rack charge takers stay out of the strip.
    [gun(5)],
  );
  const groups = weaponGroups(rows, FITS);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.modules.map((module) => module.itemID), [1, 2, 3]);
  assert.equal(groups[0]!.loaded, 2);
  assert.deepEqual(groups[0]!.chargeTypeIDs, [SCOURGE]);
  assert.equal(groups[0]!.rounds, 80);
});

// The three tests of reloadAllPlan went with it (2026-10-18): Reload all is the client's OnReloadAmmo, in the flow.

test("the badge counts rounds, shortens big stacks, and reads 0 when empty", () => {
  assert.equal(rackChargeBadge(gun(1)), "0");
  assert.equal(rackChargeBadge(gun(1, { typeID: SCOURGE, quantity: 40 })), "40");
  assert.equal(rackChargeBadge(gun(1, { typeID: SCOURGE, quantity: -1 })), "1");
  assert.equal(rackChargeBadge(gun(1, { typeID: SCOURGE, quantity: 12500 })), "12k");
});

test("a reload runs from its announcement for the reload time it gave", () => {
  const reload = { chargeTypeID: SCOURGE, startedAtMs: 1000, durationMs: 10000 };
  assert.equal(rackReloading(reload, 1000), true);
  assert.equal(rackReloadPercent(reload, 6000), 50);
  assert.equal(rackReloading(reload, 11000), false);
  assert.equal(rackReloadPercent(reload, 11000), null);
  assert.equal(rackReloading(undefined, 0), false);
});

test("OnChargeBeingLoadedToModule decodes in either list shape", () => {
  assert.deepEqual(
    decodeChargeLoadNotification("OnChargeBeingLoadedToModule", [{ type: "list", items: [11, 12] }, SCOURGE, 10000]),
    { moduleIDs: [11, 12], chargeTypeID: SCOURGE, durationMs: 10000 },
  );
  assert.deepEqual(
    decodeChargeLoadNotification("OnChargeBeingLoadedToModule", [[{ type: "long", value: "13" }], null, 5000]),
    { moduleIDs: [13], chargeTypeID: null, durationMs: 5000 },
  );
  assert.equal(decodeChargeLoadNotification("OnChargeBeingLoadedToModule", [[], SCOURGE, 10000]), null);
  assert.equal(decodeChargeLoadNotification("OnChargeBeingLoadedToModule", [[11], SCOURGE, 0]), null);
  assert.equal(decodeChargeLoadNotification("OnTarget", [[11], SCOURGE, 10000]), null);
});

// --- round counts while firing -------------------------------------------

const SHIP = 1000000001;

/** One OnModuleAttributeChange row, as attributeChangeNotification.js builds it. */
function quantityChange(flagID: number, chargeTypeID: number, next: number, previous: number) {
  return ["OnModuleAttributeChange", 90000001, [SHIP, flagID, chargeTypeID], 805, 1, next, previous, 1];
}

test("OnModuleAttributeChanges yields the charge-tuple quantity changes and nothing else", () => {
  const changes = decodeChargeQuantityChanges("OnModuleAttributeChanges", [
    {
      type: "list",
      items: [
        quantityChange(27, INFERNO, 65, 66),
        // Another attribute on the same charge: not a round count.
        ["OnModuleAttributeChange", 90000001, [SHIP, 27, INFERNO], 3, 1, 0.1, 0, 1],
        // A quantity on a real item id: some other stack.
        ["OnModuleAttributeChange", 90000001, 555, 805, 1, 10, 11, 1],
      ],
    },
  ]);
  assert.deepEqual(changes, [{ shipID: SHIP, flagID: 27, chargeTypeID: INFERNO, quantity: 65 }]);
  assert.deepEqual(decodeChargeQuantityChanges("OnGodmaShipEffect", []), []);
});

test("in space the round counts come inside an OnMultiEvent, each change its own event, and are read in time order", () => {
  // runtime/dogmaEvents.js: each change paired with its time; a wrapped batch is read too.
  const changes = decodeChargeQuantityChanges("OnMultiEvent", [
    {
      type: "list",
      items: [
        [quantityChange(27, INFERNO, 63, 64), { type: "long", value: "133000000000000002" }],
        [quantityChange(27, INFERNO, 64, 65), { type: "long", value: "133000000000000001" }],
        [["OnModuleAttributeChanges", { type: "list", items: [quantityChange(28, INFERNO, 9, 10)] }], { type: "long", value: "133000000000000003" }],
        [["OnGodmaShipEffect", 127, 10, 1, 0], { type: "long", value: "133000000000000001" }],
      ],
    },
  ]);
  assert.deepEqual(changes.map((change) => [change.flagID, change.quantity]), [[27, 64], [27, 63], [28, 9]]);
  // One change alone reads the same.
  assert.deepEqual(decodeChargeQuantityChanges("OnModuleAttributeChange", quantityChange(27, INFERNO, 5, 6).slice(1)).map((change) => change.quantity), [5]);
});

test("the effects inside an OnMultiEvent are its OnGodmaShipEffect notices, as their arguments, in time order", () => {
  const at = (tick: number) => ({ type: "long", value: String(133000000000000000n + BigInt(tick)) });
  const stop = ["OnGodmaShipEffect", 127, 10, 1, 0];
  const start = ["OnGodmaShipEffect", 128, 10, 1, 1];
  const effects = shipEffectsInMultiEvent("OnMultiEvent", [
    [[stop, at(2)], [quantityChange(27, INFERNO, 0, 1), at(1)], [start, at(1)]],
  ]);
  assert.deepEqual(effects, [start.slice(1), stop.slice(1)]);
  assert.deepEqual(shipEffectsInMultiEvent("OnModuleAttributeChanges", [[]]), []);
});

function fitSlot(index: number, charge: { typeID: number; quantity: number } | null): FittingSlot {
  return {
    family: "high",
    index,
    module: {
      itemID: 100 + index,
      typeID: LAUNCHER,
      groupID: null,
      online: true,
      charge: charge ? { itemID: [SHIP, 27 + index, charge.typeID], ...charge } : null,
    },
  };
}

test("a shot takes the count down on the slot whose flag it names", () => {
  const slots = [fitSlot(0, { typeID: INFERNO, quantity: 66 }), fitSlot(1, { typeID: INFERNO, quantity: 66 })];
  const next = applyChargeQuantityChanges(slots, SHIP, [
    { shipID: SHIP, flagID: 28, chargeTypeID: INFERNO, quantity: 65 },
  ]);
  assert.equal(next[0], slots[0], "the other gun is untouched");
  assert.equal(next[1]!.module!.charge!.quantity, 65);
});

test("the last round empties the gun, and a new type going in is recorded as loaded", () => {
  const slots = [fitSlot(0, { typeID: INFERNO, quantity: 1 })];
  const empty = applyChargeQuantityChanges(slots, SHIP, [
    { shipID: SHIP, flagID: 27, chargeTypeID: INFERNO, quantity: 0 },
  ]);
  assert.equal(empty[0]!.module!.charge, null);
  const swapped = applyChargeQuantityChanges(empty, SHIP, [
    { shipID: SHIP, flagID: 27, chargeTypeID: SCOURGE, quantity: 66 },
  ]);
  assert.deepEqual(swapped[0]!.module!.charge, { itemID: [SHIP, 27, SCOURGE], typeID: SCOURGE, quantity: 66 });
});

test("a swap's old type going to 0 AFTER the new one is in does not empty the gun", () => {
  const slots = [fitSlot(0, { typeID: SCOURGE, quantity: 66 })];
  const next = applyChargeQuantityChanges(slots, SHIP, [
    { shipID: SHIP, flagID: 27, chargeTypeID: INFERNO, quantity: 0 },
  ]);
  assert.equal(next, slots);
});

test("another ship's push, or one that changes nothing, costs no redraw", () => {
  const slots = [fitSlot(0, { typeID: INFERNO, quantity: 66 })];
  assert.equal(applyChargeQuantityChanges(slots, SHIP, [{ shipID: 7, flagID: 27, chargeTypeID: INFERNO, quantity: 1 }]), slots);
  assert.equal(applyChargeQuantityChanges(slots, SHIP, [{ shipID: SHIP, flagID: 27, chargeTypeID: INFERNO, quantity: 66 }]), slots);
  assert.equal(applyChargeQuantityChanges(slots, null, [{ shipID: SHIP, flagID: 27, chargeTypeID: INFERNO, quantity: 1 }]), slots);
});
