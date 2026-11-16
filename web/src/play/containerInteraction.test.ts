import { strict as assert } from "node:assert";
import { test } from "node:test";
import { activateCargoTarget, selectedCargo } from "./containerInteraction.ts";

const authority = { kind: "container", typeID: 85362, groupID: 306 };
const wreck = { kind: "wreck", typeID: 26557, groupID: 186 };
const mission = { kind: "container", typeID: 19580, groupID: 952 };
const trader = { kind: "container", typeID: 34502, groupID: 952 };
const gate = { kind: "stargate", typeID: 16, groupID: 10 };

test("Selected Item offers the native cargo entry and disables it while the pilot warps", () => {
  assert.equal(selectedCargo(authority, false), "enabled");
  assert.equal(selectedCargo(wreck, false), "enabled");
  assert.equal(selectedCargo(mission, false), "enabled");
  assert.equal(selectedCargo(authority, true), "disabled");
  assert.equal(selectedCargo(trader, false), "disabled");
  assert.equal(selectedCargo(gate, false), "hidden");
});

test("double-click opens nearby loot, approaches mission containers and aligns at warp distance", () => {
  assert.equal(activateCargoTarget(authority, 149_999), "open");
  assert.equal(activateCargoTarget(authority, 150_000), "align");
  assert.equal(activateCargoTarget(wreck, 2_500), "open");
  assert.equal(activateCargoTarget(mission, 2_400), "approach");
  assert.equal(activateCargoTarget(mission, 150_000), "align");
  assert.equal(activateCargoTarget(gate, 2_400), "approach");
});
