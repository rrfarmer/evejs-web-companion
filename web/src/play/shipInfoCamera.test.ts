import assert from "node:assert/strict";
import test from "node:test";
import { shipInfoZoomRange } from "./shipInfoCamera.ts";

test("Ship Info scales the native zoom ranges by radius and limits the far plane", () => {
  assert.deepEqual(shipInfoZoomRange(100, [3, 3, 3]), [210, 450]);
  assert.deepEqual(shipInfoZoomRange(100, [5, 5, 2.8]), [180, 350]);
  assert.deepEqual(shipInfoZoomRange(100, [2, 2, 4]), [160, 350]);
  assert.deepEqual(shipInfoZoomRange(90_000, [2, 2, 4]), [144_000, 220_000]);
});
