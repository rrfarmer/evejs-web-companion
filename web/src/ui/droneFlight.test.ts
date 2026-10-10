// Which drones a salvage order is for, as a pure function.
//
// The client offers Salvage for a drone its ship controls that is a salvage
// drone (droneCheckers.OfferSalvage: the item's group is groupSalvageDrone), and
// its drones' primary action sends the order to the salvage drones among those
// chosen (droneFunctions.PerformPrimaryAction). The page knows a drone's group
// by its name, once that has been read.

import test from "node:test";
import assert from "node:assert/strict";

import { salvageDroneIDs } from "./droneFlight.ts";
import type { DroneInSpace } from "../store/types.ts";

const drone = (itemID: number, typeID: number | null): DroneInSpace => ({
  itemID, typeID, name: null, activity: "idle", targetID: null, shieldRatio: 1, armorRatio: 1, hullRatio: 1, controlled: true,
});
const [SALVAGER, HOBGOBLIN, MINER] = [32787, 2456, 10246];
const GROUPS: Record<number, string> = { [SALVAGER]: "Salvage Drone", [HOBGOBLIN]: "Combat Drone", [MINER]: "Mining Drone" };
const groupOf = (typeID: number): string | null => GROUPS[typeID] ?? null;

test("the salvage order is for the salvage drones among those the ship may order, and no others", () => {
  const out = [drone(11, SALVAGER), drone(12, HOBGOBLIN), drone(13, SALVAGER), drone(14, MINER)];
  assert.deepEqual(salvageDroneIDs([11, 12, 13, 14], out, groupOf), [11, 13]);
  // A salvage drone the ship may not order is not sent the order.
  assert.deepEqual(salvageDroneIDs([12, 13, 14], out, groupOf), [13]);
  assert.deepEqual(salvageDroneIDs([12, 14], out, groupOf), []);
});

test("a drone whose kind is not known yet is not taken for a salvage drone", () => {
  // The group's name has not been read, or the drone's type is not known: "cannot tell" offers nothing.
  const out = [drone(11, SALVAGER), drone(12, null), drone(13, 99999)];
  assert.deepEqual(salvageDroneIDs([11, 12, 13], out, () => null), []);
  assert.deepEqual(salvageDroneIDs([11, 12, 13], out, groupOf), [11]);
});

test("the group is known by its name whatever its case, and nothing like it will do", () => {
  const out = [drone(11, 1), drone(12, 2), drone(13, 3)];
  const names: Record<number, string> = { 1: "salvage drone", 2: "Salvage Drones", 3: "Salvager" };
  assert.deepEqual(salvageDroneIDs([11, 12, 13], out, (typeID) => names[typeID] ?? null), [11]);
});

test("drones that could not be read are no drones to order", () => {
  assert.deepEqual(salvageDroneIDs([11], null, groupOf), []);
});
