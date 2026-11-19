import assert from "node:assert/strict";
import { test } from "node:test";
import { unixMsToFiletime } from "../bridge/activity.ts";
import { hasJumpPolarization, polarizationTime, readWormholePolarization } from "./wormholePolarization.ts";

test("wormhole components read an exact expiry and a duration from the pilot's reply", () => {
  const expiresAt = 1_795_098_500_123;
  const time = { type: "long", value: String(unixMsToFiletime(expiresAt)) };
  assert.deepEqual(readWormholePolarization([time, 300]), { expiresAt, durationMs: 300_000 });
  assert.equal(readWormholePolarization(null), null);
  assert.equal(readWormholePolarization([time, 0]), null);
  assert.equal(readWormholePolarization(["bogus", 300]), null);
  assert.equal(hasJumpPolarization(30831), true);
  assert.equal(hasJumpPolarization(6), false);
  assert.equal(polarizationTime(299_999), "04:59");
  assert.equal(polarizationTime(3_661_001), "01:01:01");
});
