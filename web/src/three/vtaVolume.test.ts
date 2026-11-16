import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { decodeVta, decodeVtaRuns } from "./vtaVolume.ts";

test("reads an installed-format R8 VTA with literal and 256-texel repeat tokens", async () => {
  const encoded = new Uint8Array([1, 255, 5, 1, 252, 4]);
  const compressed = deflateSync(encoded);
  const bytes = new Uint8Array(92 + compressed.length);
  const header = new DataView(bytes.buffer);
  for (const [offset, value] of [[0, 0x415456], [4, 1], [8, 1], [12, 1], [24, bytes.length],
    [32, 61], [36, 3], [40, 65], [44, 2], [48, 2], [84, 92]]) header.setUint32(offset!, value!, true);
  bytes.set(compressed, 92);
  const decoded = await decodeVta(bytes.buffer);
  assert.equal(decoded.width, 65);
  assert.equal(decoded.height, 2);
  assert.equal(decoded.depth, 2);
  assert.equal(decoded.data.length, 260);
  assert.ok(decoded.data.subarray(0, 256).every((v) => v === 0));
  assert.deepEqual([...decoded.data.subarray(256)], [4, 4, 252, 4]);
});

test("rejects truncated or invalid VTA runs and inconsistent output sizes", () => {
  assert.throws(() => decodeVtaRuns(Uint8Array.of(1), 2), /Truncated/);
  assert.throws(() => decodeVtaRuns(Uint8Array.of(6), 1), /flags/);
  assert.throws(() => decodeVtaRuns(Uint8Array.of(1, 255), 10), /exceeds/);
  assert.throws(() => decodeVtaRuns(Uint8Array.of(4), 2), /Incomplete/);
});
