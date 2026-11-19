import test from "node:test";
import assert from "node:assert/strict";
import { miningGaugeSegments } from "./targetBar.ts";

test("the mining gauge separates yield, residue and critical bonus from remaining ore", () => {
  const reading = {
    originalQuantity: 200,
    remainingQuantity: 100,
    extraction: { atMs: 1, yieldQuantity: 50, residueQuantity: 25, criticalQuantity: 50 },
  };
  assert.deepEqual(miningGaugeSegments(reading, true), {
    remaining: 0.5,
    segments: [
      { kind: "yield", left: 0.5, width: 0.25 },
      { kind: "residue", left: 0.75, width: 0.125 },
      { kind: "critical", left: 0.875, width: 0.125 },
    ],
  });
  assert.deepEqual(miningGaugeSegments(reading, false), { remaining: 0.5, segments: [] });
  assert.deepEqual(miningGaugeSegments({
    originalQuantity: 1000, remainingQuantity: 0,
    extraction: { atMs: 1, yieldQuantity: 1, residueQuantity: 0, criticalQuantity: 0 },
  }, true), { remaining: 0, segments: [{ kind: "yield", left: 0, width: 0.02 }] });
});
