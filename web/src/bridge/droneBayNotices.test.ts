// Whether one item's move is the drone bay's business, judged as the client's drones window judges it.

import test from "node:test";
import assert from "node:assert/strict";

import { itemChangeTouchesDroneBay } from "./droneBayNotices.ts";

const [SHIP, OTHER_SHIP, SYSTEM, STATION] = [9988400109063, 9988400109999, 30000142, 60003760];
const [DRONE_BAY, CARGO, HANGAR, NONE] = [87, 5, 4, 0];
const [LOCATION, FLAG] = [3, 4];

// The row and the change as the server sent them for a Salvage Drone I, read in the tab on 2026-10-10: the item as
// it now is, and what it was before, by column.
const row = (locationID: number, flagID: number) => ({
  type: "packedrow",
  fields: { itemID: 9988400109075, typeID: 32787, ownerID: 140000001, locationID, flagID, quantity: -1, groupID: 1159, categoryID: 18, customInfo: "", stacksize: 1, singleton: 1 },
});
const was = (...entries: (readonly [number, number])[]) => ({ type: "dict", entries });
const judged = (item: unknown, change: unknown, shipID: number | null = SHIP) => itemChangeTouchesDroneBay([item, change, null], shipID);

test("a drone landed in the ship's bay is the bay's business", () => {
  assert.equal(judged(row(SHIP, DRONE_BAY), was([LOCATION, SYSTEM], [FLAG, NONE])), true);
});

test("an item in the ship's bay told of again, with nothing changed, is too", () => {
  // dronesWindow.py 256: the item's own flag is enough.
  assert.equal(judged(row(SHIP, DRONE_BAY), was()), true);
});

test("a drone launched from the ship's bay is: it has left the ship, and was in that bay", () => {
  assert.equal(judged(row(SYSTEM, NONE), was([LOCATION, SHIP], [FLAG, DRONE_BAY])), true);
});

test("a drone moved from the bay to the hold of the same ship is", () => {
  assert.equal(judged(row(SHIP, CARGO), was([FLAG, DRONE_BAY])), true);
});

test("an item come into the ship's hold is not", () => {
  assert.equal(judged(row(SHIP, CARGO), was([LOCATION, STATION], [FLAG, HANGAR])), false);
});

test("an item in ANOTHER ship's drone bay is not", () => {
  assert.equal(judged(row(OTHER_SHIP, DRONE_BAY), was()), false);
});

test("an item that left the ship, but not from the drone bay, is not", () => {
  assert.equal(judged(row(STATION, HANGAR), was([LOCATION, SHIP], [FLAG, CARGO])), false);
});

test("an item that left ANOTHER ship's drone bay is not", () => {
  assert.equal(judged(row(SYSTEM, NONE), was([LOCATION, OTHER_SHIP], [FLAG, DRONE_BAY])), false);
});

test("an item that left the ship with its flag unchanged is not: it was not in the drone bay", () => {
  assert.equal(judged(row(STATION, CARGO), was([LOCATION, SHIP])), false);
});

test("what cannot be read is not known to be something else's business", () => {
  assert.equal(judged(row(SHIP, CARGO), was([LOCATION, STATION], [FLAG, HANGAR]), null), true, "the ship is not known");
  assert.equal(judged({ type: "packedrow" }, was()), true, "the item has no fields");
  assert.equal(judged(row(SHIP, CARGO), null), true, "what it was is not a dict");
  assert.equal(judged(row(SHIP, CARGO), { type: "dict", entries: "no" }), true, "what it was has no entries");
  assert.equal(judged(row(SHIP, CARGO), { type: "dict", entries: [[LOCATION, STATION], "odd"] }), true, "one of them is no pair");
  assert.equal(judged(row(SHIP, CARGO), { type: "dict", entries: [["3", STATION]] }), true, "one is keyed by no number");
  assert.equal(itemChangeTouchesDroneBay([], SHIP), true, "there is nothing at all");
});
