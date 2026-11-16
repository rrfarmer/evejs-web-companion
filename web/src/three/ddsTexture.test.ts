import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { parseDds } from "./ddsTexture.ts";

test("decodes the A8L8 DDS used by the directional scanner sprite masks", () => {
  const buffer = new ArrayBuffer(132);
  const header = new DataView(buffer);
  header.setUint32(0, 0x20534444, true);
  header.setUint32(4, 124, true);
  header.setUint32(12, 1, true);
  header.setUint32(16, 2, true);
  header.setUint32(76, 32, true);
  header.setUint32(80, 0x20001, true);
  header.setUint32(88, 16, true);
  header.setUint32(92, 0xff, true);
  header.setUint32(104, 0xff00, true);
  new Uint8Array(buffer, 128).set([23, 255, 190, 7]);

  const texture = parseDds(buffer);
  assert.ok(texture instanceof THREE.DataTexture);
  assert.equal(texture.format, THREE.RGBAFormat);
  assert.equal(texture.image.width, 2);
  assert.equal(texture.image.height, 1);
  assert.deepEqual(texture.image.data, Uint8Array.of(23, 23, 23, 255, 190, 190, 190, 7));
});
