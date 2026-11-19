import assert from "node:assert/strict";
import test from "node:test";
import { basicMiningScan, miningScanInWarp, miningScanRows } from "./miningScanResults.ts";
import type { SpaceEntity, SpaceShipStatus, SpaceSnapshot } from "../store/types.ts";

const position = (x: number) => ({ x, y: 0, z: 0 });
const rock = (itemID: number, x: number) => ({
  itemID, position: position(x), radius: 20, typeID: 17470, miningYieldTypeID: 1230,
  categoryID: 25, groupID: 462, oreValuePerM3: 52.8,
} as SpaceEntity);
const ship = { position: position(0), radius: 10, mode: "STOP" } as SpaceShipStatus;
const snapshot: SpaceSnapshot = {
  inSpace: true, ship, entities: [rock(11, 249_980), rock(12, 249_981)],
  solarSystemID: 30000144, shipID: 101, sampledAtMs: 100,
};

test("basic mining scans use the rock's far edge and leave quantities undisclosed", () => {
  assert.deepEqual(basicMiningScan(snapshot), [{ itemID: 11, yieldTypeID: 1230, remainingQuantity: null }]);
  assert.equal(miningScanInWarp({ ...snapshot, ship: { ...ship, mode: "WARP" } }), true);
  assert.equal(miningScanInWarp(snapshot), false);
});

test("scan rows use the ore's facts, preserve a real zero, and drop departed rocks", () => {
  const rows = miningScanRows([
    { itemID: 11, yieldTypeID: 1230, remainingQuantity: 30 },
    { itemID: 12, yieldTypeID: 1230, remainingQuantity: 0 },
    { itemID: 13, yieldTypeID: 1230, remainingQuantity: 999 },
  ], snapshot, new Map([[1230, { groupID: 462, unitVolume: 0.1, unitPrice: 6 }]]));
  assert.deepEqual(rows, [
    { itemID: 11, typeID: 1230, quantity: 30, volume: 3, value: 180, distance: 249_950, groupID: 462, pricePerM3: 52.8 },
    { itemID: 12, typeID: 1230, quantity: 0, volume: 0, value: 0, distance: 249_951, groupID: 462, pricePerM3: 52.8 },
  ]);
});
