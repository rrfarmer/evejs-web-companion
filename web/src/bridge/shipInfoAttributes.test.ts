import assert from "node:assert/strict";
import test from "node:test";
import { BASE_UPWELL_JUMP_COST, BASE_WARP_SPEED, SHIP_INFO_GROUPS, shipInfoValues } from "./shipInfoAttributes.ts";

test("24.02 ship navigation orders Ansiblex cost after agility and before warp speed", () => {
  assert.deepEqual(
    SHIP_INFO_GROUPS.find(group => group.label === "UI/Fitting/Navigation")?.attributes,
    [37, 4, 70, BASE_UPWELL_JUMP_COST, BASE_WARP_SPEED],
  );
  assert.equal(SHIP_INFO_GROUPS.find(group => group.title === "Jump Drive Systems")?.attributes.includes(BASE_UPWELL_JUMP_COST), false);
});

test("loaded ship dogma can modify base attributes with zero and leaves absent prices absent", () => {
  const base = [[37, 325], [4, 997000], [70, 3.6], [BASE_UPWELL_JUMP_COST, 4000], [BASE_WARP_SPEED, 4], [600, 1.25]] as const;
  const loaded = shipInfoValues(base, [
    { attributeID: 37, value: 389 },
    { attributeID: BASE_UPWELL_JUMP_COST, value: 0 },
    { attributeID: 70, value: null },
    { attributeID: 867, value: 1.5 },
  ]);
  assert.equal(loaded.get(37), 389);
  assert.equal(loaded.get(70), 3.6);
  assert.equal(loaded.get(BASE_UPWELL_JUMP_COST), 0);
  assert.equal(loaded.get(BASE_WARP_SPEED), 5);
  assert.equal(loaded.has(867), false);
  assert.equal(shipInfoValues(base).get(BASE_UPWELL_JUMP_COST), 4000);
  assert.equal(shipInfoValues([]).has(BASE_UPWELL_JUMP_COST), false);
  assert.equal(shipInfoValues([]).get(BASE_WARP_SPEED), 3);
});
