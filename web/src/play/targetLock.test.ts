import assert from "node:assert/strict";
import test from "node:test";
import { retimeTargetLockStart, targetLockDurationMs } from "./targetLock.ts";

test("the installed lock countdown uses signature, ball, then type radius", () => {
  const duration = (radius: number) => 40_000_000 / 111 / Math.asinh(radius) ** 2;
  assert.equal(targetLockDurationMs(111, 500, 335, 95), duration(500));
  assert.equal(targetLockDurationMs(111, 0, 335, 95), duration(335));
  assert.equal(targetLockDurationMs(111, null, 0, 95), duration(95));
  assert.equal(targetLockDurationMs(450, null, null, null), 40_000_000 / 450 / Math.asinh(1) ** 2);
  assert.equal(targetLockDurationMs(null, 500, 335, 95), 2000);
  assert.equal(targetLockDurationMs(1, 1, 335, 95), 180_000);
});

test("a changed scan duration keeps the elapsed fraction", () => {
  assert.equal(retimeTargetLockStart(1000, 4000, 8000, 6000), 1750);
  assert.equal(retimeTargetLockStart(1750, 4000, 6000, 8000), 1000);
});
