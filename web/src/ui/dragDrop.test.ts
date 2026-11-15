// Drag and drop (goal R78): a payload that survives a hostile string, and drop
// rules that a target can consult BEFORE it promises the cursor a drop.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DRAG_MIME,
  carriesOurPayload,
  decodeDrag,
  decodeFittingChargeType,
  dropOnPlaceVerdict,
  dropOnSocketVerdict,
  encodeDrag,
  samePlace,
  type DragPayload,
} from "./dragDrop.ts";
import type { InventoryPlace } from "../store/types.ts";

const HANGAR: InventoryPlace = { kind: "hangar" };
const CARGO: InventoryPlace = { kind: "cargo" };
const ORE_BAY: InventoryPlace = { kind: "shipBay", bay: "ore" };

const ITEM: DragPayload = {
  kind: "inventoryItem",
  itemID: 1_001,
  typeID: 483,
  from: HANGAR,
};
const FITTED: DragPayload = { kind: "fittedModule", itemID: 7_700_001, typeID: 483 };

// --- the payload survives the round trip -------------------------------------

test("an inventory drag survives encode and decode", () => {
  assert.deepEqual(decodeDrag(encodeDrag(ITEM)), ITEM);
  const selection: DragPayload = { ...ITEM, itemIDs: [1002, ITEM.itemID] };
  assert.deepEqual(decodeDrag(encodeDrag(selection)), selection);
});

test("a catalogue charge drag carries a positive type ID and cannot decode as an inventory item", () => {
  assert.equal(decodeFittingChargeType("215"), 215);
  assert.equal(decodeDrag("215"), null);
  for (const invalid of [undefined, "", "0", "-215", "215.5", "1e3", "9007199254740993"]) {
    assert.equal(decodeFittingChargeType(invalid), null);
  }
});

test("a fitted-module drag survives encode and decode", () => {
  assert.deepEqual(decodeDrag(encodeDrag(FITTED)), FITTED);
});

test("every kind of source container survives the trip", () => {
  for (const from of [
    HANGAR,
    CARGO,
    ORE_BAY,
    { kind: "container", itemID: 42 } as InventoryPlace,
    { kind: "corp", division: 3 } as InventoryPlace,
  ]) {
    const payload: DragPayload = { kind: "inventoryItem", itemID: 5, typeID: 6, from };
    assert.deepEqual(decodeDrag(encodeDrag(payload)), payload, `${from.kind} did not survive`);
  }
});

// --- and refuses everything else ---------------------------------------------

test("a hostile or foreign string decodes to null rather than throwing", () => {
  // ⚠ A drag can start in another tab, another application, or as a file. A
  // throw inside a drop handler leaves the page stuck mid-drag with no way out.
  for (const raw of [
    null,
    undefined,
    "",
    "not json at all",
    "{",
    "[]",
    "null",
    '"a string"',
    "42",
    JSON.stringify({ kind: "inventoryItem" }),
    JSON.stringify({ kind: "somethingElse", itemID: 1, typeID: 2 }),
    JSON.stringify({ kind: "inventoryItem", itemID: "not a number", typeID: 2, from: HANGAR }),
    JSON.stringify({ kind: "inventoryItem", itemID: 1, typeID: 2, from: { kind: "nowhere" } }),
    JSON.stringify({ kind: "inventoryItem", itemID: 1, typeID: 2 }),
  ]) {
    assert.equal(decodeDrag(raw as string), null, `${String(raw)} should not decode`);
  }
});

test("a malformed shipBay or container source is refused, not half-read", () => {
  assert.equal(
    decodeDrag(JSON.stringify({ kind: "inventoryItem", itemID: 1, typeID: 2, from: { kind: "shipBay" } })),
    null,
    "a bay with no name is not a place",
  );
  assert.equal(
    decodeDrag(JSON.stringify({ kind: "inventoryItem", itemID: 1, typeID: 2, from: { kind: "container" } })),
    null,
    "a container with no id is not a place",
  );
});

// --- what a dragover can see -------------------------------------------------

test("a target can recognise our payload from the types alone", () => {
  // During dragover the CONTENTS are unreadable; only the types are exposed.
  assert.equal(carriesOurPayload([DRAG_MIME, "text/plain"]), true);
});

test("a dragged file or text selection is not ours", () => {
  assert.equal(carriesOurPayload(["Files"]), false);
  assert.equal(carriesOurPayload(["text/plain"]), false);
  assert.equal(carriesOurPayload([]), false);
  assert.equal(carriesOurPayload(undefined), false);
});

// --- dropping on a fitting socket --------------------------------------------

test("an item from a hangar may be fitted", () => {
  assert.equal(dropOnSocketVerdict(ITEM), null);
});

test("an item from the cargo hold may be fitted", () => {
  assert.equal(
    dropOnSocketVerdict({ ...ITEM, from: CARGO } as DragPayload),
    null,
  );
});

test("an ALREADY-FITTED module is taken by the real ship's slots, and refused with a reason in a simulation", () => {
  // The fitting slot's OnDropData groups it (Shift) or moves it (AddRealItem); a simulation's slots take what comes
  // from the hangar.
  assert.equal(dropOnSocketVerdict(FITTED), null);
  const verdict = dropOnSocketVerdict(FITTED, true);
  assert.notEqual(verdict, null);
  assert.match(verdict!, /take it off the ship first/i);
});

test("something that is not ours is refused rather than accepted", () => {
  assert.notEqual(dropOnSocketVerdict(null), null);
});

// --- dropping on a container -------------------------------------------------

test("moving an item to a DIFFERENT container is allowed", () => {
  assert.equal(dropOnPlaceVerdict(ITEM, CARGO), null);
  assert.equal(dropOnPlaceVerdict(ITEM, ORE_BAY), null);
});

test("dropping an item back where it came from is refused, WITH a reason", () => {
  // Not an error — nothing to do. Saying so keeps the cursor honest rather than
  // inviting a drop that would be a no-op.
  const verdict = dropOnPlaceVerdict(ITEM, HANGAR);
  assert.notEqual(verdict, null);
  assert.match(verdict!, /already there/i);
});

test("same-place is judged by the container's identity, not just its kind", () => {
  const fromThree: DragPayload = { ...ITEM, from: { kind: "corp", division: 3 } };
  assert.equal(dropOnPlaceVerdict(fromThree, { kind: "corp", division: 3 }), "It is already there.");
  assert.equal(dropOnPlaceVerdict(fromThree, { kind: "corp", division: 4 }), null);
});

test("a fitted module dropped on the cargo is taken off into it, and is allowed", () => {
  // minihangar CargoCargoSlots.OnDropData and invCtrl.ShipCargo: UnloadModuleToContainer to the ship's cargo.
  assert.equal(dropOnPlaceVerdict(FITTED, CARGO), null);
});

test("a fitted module dropped on the hangar, a hold, a container or the corporation's hangar is taken off into it", () => {
  // invControllers BaseInvContainer.AddItems (505 to 517): each container's UnloadModuleToContainer and
  // UnloadAmmoToContainer with its own arguments and flag; the corporation's hangar's are its office's and its
  // division's flag, the pilot asked first (ConfirmOneWayItemMove), which is the flow's and not the verdict's.
  for (const to of [HANGAR, ORE_BAY, { kind: "container", itemID: 1 } as InventoryPlace, { kind: "corp", division: 1 } as InventoryPlace]) {
    assert.equal(dropOnPlaceVerdict(FITTED, to), null, `${to.kind} must take it`);
  }
});

// --- samePlace ---------------------------------------------------------------

test("samePlace distinguishes every container kind", () => {
  assert.equal(samePlace(HANGAR, HANGAR), true);
  assert.equal(samePlace(HANGAR, CARGO), false);
  assert.equal(samePlace(ORE_BAY, { kind: "shipBay", bay: "ore" }), true);
  assert.equal(samePlace(ORE_BAY, { kind: "shipBay", bay: "drone" }), false);
  assert.equal(samePlace({ kind: "container", itemID: 1 }, { kind: "container", itemID: 1 }), true);
  assert.equal(samePlace({ kind: "container", itemID: 1 }, { kind: "container", itemID: 2 }), false);
});
