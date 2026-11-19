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
