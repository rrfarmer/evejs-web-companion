import assert from "node:assert/strict";
import { test } from "node:test";
import { sampleGrannyTrack, type GrannyTrack } from "./grannyTrack.ts";

const track: GrannyTrack = { times: [0, 0.25, 1, 2], values: [0, 2, 9, 0], width: 1, degree: 2 };
const sample = (t: number, loop = 0) => sampleGrannyTrack(track, t, [], loop)[0]!;
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, String(actual));

test("quadratic track follows the installed Granny evaluator at uneven knots", () => {
  close(sample(0.25), 0.5);
  close(sample(0.5), 1.6666667461395264);
  close(sample(1.5), 5.75);
  close(sample(0.125), 0.125);
  assert.equal(sample(-1), 0);
  assert.equal(sample(2), 0);

  const repeated = { ...track, times: [0, 0.1, 0.1, 0.1, 1, 2].map(Math.fround), values: [0, 10, 20, 30, 40, 50] };
  assert.deepEqual(sampleGrannyTrack(repeated, 0.1, []), [20]);
});

test("a loop joins to the first control of the next cycle", () => {
  close(sample(0, 2), 1.8);
  assert.ok(Math.abs(sample(2 - 1e-6, 2) - sample(0, 2)) < 2e-5);
});

test("quaternion signs stay continuous where a clamped span extends the edge", () => {
  const q = { times: [0, 1, 2], values: [0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 0, -1], width: 4, degree: 2 };
  assert.deepEqual(sampleGrannyTrack(q, 0.5, []), [0, 0, 0, 1]);
});

test("an old baked track still interpolates its keys", () => {
  const previous = { times: [0, 1], values: [0, 2], width: 1 };
  assert.deepEqual(sampleGrannyTrack(previous, 0.25, []), [0.5]);
});
