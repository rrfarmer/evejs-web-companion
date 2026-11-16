import test from "node:test";
import assert from "node:assert/strict";
import { PROXIMITY_TRAP_RANGES } from "./proximityTraps.ts";

test("native Observatory trap models use their component radii", () => {
  assert.equal(PROXIMITY_TRAP_RANGES.get(85362), 10_000);
  assert.equal(PROXIMITY_TRAP_RANGES.get(85436), 10_000);
  assert.equal(PROXIMITY_TRAP_RANGES.get(85505), 5_000);
  assert.equal(PROXIMITY_TRAP_RANGES.get(85231), undefined);
});
