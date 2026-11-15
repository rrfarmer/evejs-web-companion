"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

test("turret bake preserves the authored Granny curve degree", async () => {
  const { decodeCurve } = await import("../tools/client-extract/lib/grannyAnim.mjs");
  const controls = [1, 0, 0, 3, 0, 0, 2, 0, 0];
  const knots = [0, 0.25, 1];
  const curve = { CurveData: { CurveDataHeader_DaK32fC32f: { Format: 1, Degree: 2 }, Knots: knots, Controls: controls } };
  assert.deepEqual(decodeCurve(curve, 3), { times: knots, values: controls, width: 3, degree: 2 });
});
