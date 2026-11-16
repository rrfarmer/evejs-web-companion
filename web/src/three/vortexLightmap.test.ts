import assert from "node:assert/strict";
import { test } from "node:test";
import { Data3DTexture, RGFormat, UnsignedByteType, Vector3, type WebGL3DRenderTarget, type WebGLRenderer } from "three";
import { VortexLightmap } from "./vortexLightmap.ts";

test("publishes a complete lightmap and rebakes it when the sun or density source changes", () => {
  const draws: number[] = [];
  let selectedLayer = -1;
  const original = {} as WebGL3DRenderTarget;
  let target = original;
  const renderer = {
    getRenderTarget: () => target,
    getActiveCubeFace: () => 7,
    getActiveMipmapLevel: () => 2,
    setRenderTarget(next: WebGL3DRenderTarget, layer: number, mip: number) {
      target = next;
      selectedLayer = layer;
      if (next === original) assert.deepEqual([layer, mip], [7, 2]);
    },
    render() {
      assert.notEqual(target, original);
      draws.push(selectedLayer);
    },
  } as unknown as WebGLRenderer;
  const lightmap = new VortexLightmap();
  const volume = new Data3DTexture(new Uint8Array(20 * 12 * 18), 20, 12, 18);
  const direction = new Vector3(0, 0, 1);
  const bake = () => lightmap.update(renderer, volume, direction, 32);
  try {
    assert.equal(bake(), null);
    assert.deepEqual(draws, [0, 1, 2, 3]);
    assert.equal(target, original);
    assert.equal(bake(), null);
    const completed = bake();
    assert.deepEqual(draws, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual([completed?.image.width, completed?.image.height, completed?.image.depth], [10, 6, 9]);
    assert.equal(completed?.format, RGFormat);
    assert.equal(completed?.type, UnsignedByteType);
    assert.equal(bake(), completed);
    assert.equal(draws.length, 9);

    direction.set(0, 1, 0);
    assert.equal(bake(), null);
    assert.deepEqual(draws.slice(-4), [0, 1, 2, 3]);
    const replacement = new Data3DTexture(new Uint8Array(4 * 4 * 6), 4, 4, 6);
    const low = lightmap.update(renderer, replacement, direction, 32);
    assert.notEqual(low, completed);
    assert.deepEqual(draws.slice(-3), [0, 1, 2]);
    assert.equal(low?.image.depth, 3);
  } finally {
    lightmap.dispose();
  }
});
