import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { gfx, setGfx } from "../play/gfxSettings.ts";
import { dynamicLightUniforms, followDynamicLights, offerLights } from "./dynamicLights.ts";

function renderer(width = 640, height = 640, x = 0, y = 0) {
  return {
    info: { render: { frame: 1 } },
    capabilities: { maxTextureSize: 2048 },
    getCurrentViewport: (viewport: THREE.Vector4) => viewport.set(x, y, width, height),
  };
}

const material = followDynamicLights(new THREE.MeshStandardMaterial());
const scene = new THREE.Scene();
const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
const group = new THREE.Group();
const draw = (target: ReturnType<typeof renderer>, camera: THREE.Camera) =>
  material.onBeforeRender(target as unknown as THREE.WebGLRenderer, scene, camera, mesh.geometry, mesh, group);

function pixels(): Float32Array {
  const data = dynamicLightUniforms.dynLights.value?.image.data;
  assert.ok(data instanceof Float32Array);
  return data;
}

function light(index: number): Float32Array {
  const start = (dynamicLightUniforms.dynLightBase.value + index * 4) * 4;
  return pixels().slice(start, start + 16);
}

function indices(x: number, y: number): number[] {
  const offset = (x + y * dynamicLightUniforms.dynGrid.value.z) * 4;
  const data = pixels();
  return Array.from(data.subarray(data[offset]!, data[offset]! + data[offset + 1]!));
}

test("the ship preview and the play scene publish each renderer's lights", () => {
  const play = renderer(), preview = renderer();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  camera.updateMatrixWorld();
  const emitter = (color: number[]) => {
    const light = new THREE.Object3D();
    light.userData.lights = [{ position: [0, 0, -3], radius: 6, color, brightness: 1 }];
    return light;
  };
  const offer = (scene: ReturnType<typeof renderer>, light: THREE.Object3D) => offerLights(scene as unknown as THREE.WebGLRenderer, camera, light);

  offer(play, emitter([1, 0, 0]));
  offer(preview, emitter([0, 1, 0]));
  draw(play, camera);
  assert.equal(dynamicLightUniforms.dynCount.value, 1);
  assert.deepEqual(Array.from(light(0).subarray(4, 7)), [6, 0, 0]);
  draw(preview, camera);
  assert.deepEqual(Array.from(light(0).subarray(4, 7)), [0, 6, 0]);
  draw(play, camera);
  assert.deepEqual(Array.from(light(0).subarray(4, 7)), [6, 0, 0]);
  play.info.render.frame++;
  draw(play, camera);
  assert.equal(dynamicLightUniforms.dynCount.value, 0);
  assert.equal(dynamicLightUniforms.dynLights.value, null);
});

test("loaded IES profiles follow the selected light in each renderer", async (t) => {
  const bytes = new ArrayBuffer(128 + 1024 * 2 + 1022);
  const header = new DataView(bytes);
  for (const [offset, value] of [[0, 0x20534444], [4, 124], [12, 1], [16, 1024], [76, 32], [84, 111]] as const) {
    header.setUint32(offset, value, true);
  }
  header.setUint16(128, 0x3800, true);
  header.setUint16(128 + 1023 * 2, 0x3c00, true);
  const fetchProfile = t.mock.method(globalThis, "fetch", async () => new Response(bytes));
  const play = renderer(), preview = renderer();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  camera.updateMatrixWorld();
  const emitter = new THREE.Object3D();
  emitter.position.z = -3;
  emitter.rotation.y = Math.PI / 2;
  emitter.userData.lights = [{
    position: [0, 0, 0], radius: 6, color: [1, 1, 1], brightness: 1,
    profile: "/client-assets/test-24.02-ies.dds", direction: [0, 0, -1],
  }];
  const plain = emitter.clone();
  delete plain.userData.lights[0].profile;
  const offer = (scene: ReturnType<typeof renderer>, light = emitter) =>
    offerLights(scene as unknown as THREE.WebGLRenderer, camera, light);
  offer(play);
  offer(preview, plain);
  draw(play, camera);
  assert.equal(light(0)[13], 0);
  await new Promise<void>(resolve => setImmediate(resolve));
  play.info.render.frame++;
  offer(play);
  draw(play, camera);
  const texture = dynamicLightUniforms.dynLights.value;
  assert.ok(texture);
  const record = light(0);
  const profile = record[13]!;
  assert.ok(profile > 0);
  assert.ok(Math.hypot(record[8]! + 1, record[9]!, record[10]!, record[11]!) < 1e-6);
  assert.equal(texture.type, THREE.FloatType);
  assert.equal(pixels()[profile], 0.5);
  assert.equal(pixels()[profile + 1023], 1);
  draw(preview, camera);
  assert.equal(light(0)[13], 0);
  assert.notEqual(dynamicLightUniforms.dynLights.value, texture);
  draw(play, camera);
  assert.equal(dynamicLightUniforms.dynLights.value, texture);
  assert.equal(fetchProfile.mock.callCount(), 1);

  const savedQuality = gfx().shaderQuality;
  t.after(() => setGfx({ shaderQuality: savedQuality }));
  setGfx({ shaderQuality: 2 });
  play.info.render.frame++;
  offer(play);
  draw(play, camera);
  assert.equal(dynamicLightUniforms.dynCount.value, 0);
  assert.equal(dynamicLightUniforms.dynLights.value, null);
  setGfx({ shaderQuality: 3 });
  play.info.render.frame++;
  offer(play);
  draw(play, camera);
  assert.equal(dynamicLightUniforms.dynCount.value, 1);
  assert.equal(dynamicLightUniforms.dynLights.value, texture);
});

test("screen tiles retain eligible lights beyond sixteen and separate distant sources", () => {
  const target = renderer(64, 64, 24, 40);
  const camera = new THREE.OrthographicCamera(-4, 4, 4, -4, 0.1, 200);
  camera.updateMatrixWorld();
  const emitter = new THREE.Object3D();
  const source = (x: number, radius = 0.75) => ({ position: [x, 0.9, -3], radius, color: [1, 1, 1], brightness: 1 });
  emitter.userData.lights = [...Array.from({ length: 19 }, () => source(-3)), { ...source(3), affectsParticles: true }, source(20), source(0, 0.4)];
  offerLights(target as unknown as THREE.WebGLRenderer, camera, emitter);
  draw(target, camera);
  assert.equal(dynamicLightUniforms.dynCount.value, 20);
  assert.deepEqual(dynamicLightUniforms.dynGrid.value.toArray(), [24, 40, 4, 4]);
  assert.deepEqual(indices(0, 2), Array.from({ length: 19 }, (_, i) => i));
  assert.deepEqual(indices(1, 2), []);
  assert.deepEqual(indices(3, 2), [19]);
  assert.equal(light(0)[14], 0);
  assert.equal(light(19)[14], 1);
});
