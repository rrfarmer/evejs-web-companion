import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { loadDds3D, parseDds, uploadDds3DMipmaps } from "./ddsTexture.ts";

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

test("retains authored uncompressed color mips and applies the texture quality skip", () => {
  const buffer = new ArrayBuffer(128 + 4 * (16 ** 2 + 8 ** 2 + 4 ** 2));
  const header = new DataView(buffer);
  header.setUint32(0, 0x20534444, true);
  header.setUint32(8, 0x20000, true);
  header.setUint32(12, 16, true);
  header.setUint32(16, 16, true);
  header.setUint32(28, 3, true);
  header.setUint32(80, 0x41, true);
  header.setUint32(88, 32, true);
  header.setUint32(92, 0xff0000, true);
  header.setUint32(96, 0xff00, true);
  header.setUint32(100, 0xff, true);
  header.setUint32(104, 0xff000000, true);
  new Uint8Array(buffer, 128 + 4 * (16 ** 2 + 8 ** 2)).set([7, 13, 83, 221]);

  const texture = parseDds(buffer, "effect mask", 1);
  assert.ok(texture instanceof THREE.DataTexture);
  assert.equal(texture.image.width, 8);
  assert.equal(texture.generateMipmaps, false);
  assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
  assert.deepEqual(texture.mipmaps.map(mip => mip.width), [8, 4]);
  const last = texture.mipmaps[1]!;
  assert.ok("data" in last);
  assert.deepEqual(last.data.slice(0, 4), Uint8Array.of(83, 13, 7, 221));
});

test("retains the float mip chain of a one-dimensional effect gradient", () => {
  const buffer = new ArrayBuffer(128 + 3 * 16);
  const header = new DataView(buffer);
  header.setUint32(0, 0x20534444, true);
  header.setUint32(8, 0x20000, true);
  header.setUint32(12, 2, true);
  header.setUint32(16, 1, true);
  header.setUint32(28, 2, true);
  header.setUint32(80, 4, true);
  header.setUint32(84, 116, true);
  new Float32Array(buffer, 128 + 2 * 16).set([1.5, 0.25, 0, 0.875]);

  const texture = parseDds(buffer, "effect gradient", 2);
  assert.ok(texture instanceof THREE.DataTexture);
  assert.equal(texture.type, THREE.FloatType);
  assert.equal(texture.generateMipmaps, false);
  assert.deepEqual(texture.mipmaps.map(mip => mip.height), [2, 1]);
  const last = texture.mipmaps[1]!;
  assert.ok("data" in last);
  assert.deepEqual(last.data, Float32Array.of(1.5, 0.25, 0, 0.875));
});

test("an authored DDS volume mip is uploaded once and restored with its renderer", async () => {
  const buffer = new ArrayBuffer(128 + 8 + 1);
  const header = new DataView(buffer);
  header.setUint32(0, 0x20534444, true);
  header.setUint32(4, 124, true);
  header.setUint32(12, 2, true);
  header.setUint32(16, 2, true);
  header.setUint32(24, 2, true);
  header.setUint32(28, 2, true);
  header.setUint32(88, 8, true);
  new Uint8Array(buffer, 128).set([1, 2, 3, 4, 5, 6, 7, 8, 93]);
  const url = `data:application/octet-stream;base64,${Buffer.from(buffer).toString("base64")}`;
  const texture = await loadDds3D(url, THREE.RepeatWrapping, true);
  assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);

  const domElement = new EventTarget();
  const copies: number[][] = [];
  const renderer = {
    domElement,
    initTexture(target: THREE.Data3DTexture) { assert.equal(target, texture); },
    copyTextureToTexture(source: THREE.Data3DTexture, target: THREE.Data3DTexture,
      _region: null, _position: null, sourceLevel: number, targetLevel: number) {
      assert.equal(target, texture);
      const { data, width, height, depth } = source.image;
      assert.ok(data instanceof Uint8Array);
      copies.push([sourceLevel, targetLevel, width, height, depth, ...data]);
    },
  } as unknown as THREE.WebGLRenderer;
  uploadDds3DMipmaps(renderer, texture);
  uploadDds3DMipmaps(renderer, texture);
  assert.deepEqual(copies, [[0, 1, 1, 1, 1, 93]]);
  domElement.dispatchEvent(new Event("webglcontextrestored"));
  uploadDds3DMipmaps(renderer, texture);
  assert.deepEqual(copies, [[0, 1, 1, 1, 1, 93], [0, 1, 1, 1, 1, 93]]);
});
