import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { gfx, setGfx } from "../play/gfxSettings.ts";
import { dynamicLightUniforms, offerLights } from "./dynamicLights.ts";

test("the ship preview and the play scene publish each renderer's lights", () => {
  const renderer = () => ({ info: { render: { frame: 1 } }, domElement: { width: 640 } });
  const play = renderer(), preview = renderer();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  camera.updateMatrixWorld();
  const emitter = (color: number[]) => {
    const light = new THREE.Object3D();
    light.userData.lights = [{ position: [0, 0, -3], radius: 6, color, brightness: 1 }];
    return light;
  };
  const empty = new THREE.Object3D();
  const offer = (scene: ReturnType<typeof renderer>, light: THREE.Object3D) => offerLights(scene as unknown as THREE.WebGLRenderer, camera, light);

  offer(play, emitter([1, 0, 0]));
  offer(preview, emitter([0, 1, 0]));
  play.info.render.frame++;
  preview.info.render.frame++;
  offer(play, empty);
  assert.equal(dynamicLightUniforms.dynCount.value, 1);
  assert.deepEqual(dynamicLightUniforms.dynColor.value[0]!.toArray(), [6, 0, 0]);
  offer(preview, empty);
  assert.deepEqual(dynamicLightUniforms.dynColor.value[0]!.toArray(), [0, 6, 0]);
  offer(play, empty);
  assert.deepEqual(dynamicLightUniforms.dynColor.value[0]!.toArray(), [6, 0, 0]);
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
  const renderer = () => ({ info: { render: { frame: 1 } }, domElement: { width: 640 } });
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
  play.info.render.frame++;
  offer(play);
  assert.equal(dynamicLightUniforms.dynShape.value[0]!.w, 0);
  await new Promise<void>(resolve => setImmediate(resolve));
  play.info.render.frame++;
  offer(play);
  const texture = dynamicLightUniforms.dynProfiles.value;
  assert.ok(texture);
  assert.equal(dynamicLightUniforms.dynShape.value[0]!.w, 1 / 32);
  const axis = dynamicLightUniforms.dynSpot.value[0]!;
  assert.ok(Math.hypot(axis.x + 1, axis.y, axis.z, axis.w) < 1e-6);
  assert.equal(texture.type, THREE.HalfFloatType);
  const pixels = texture.image.data;
  assert.ok(pixels);
  assert.equal(pixels[0], 0x3800);
  assert.equal(pixels[1023], 0x3c00);
  preview.info.render.frame++;
  offer(preview, plain);
  assert.equal(dynamicLightUniforms.dynShape.value[0]!.w, 0);
  assert.equal(dynamicLightUniforms.dynProfiles.value, null);
  offer(play);
  assert.equal(dynamicLightUniforms.dynProfiles.value, texture);
  assert.equal(fetchProfile.mock.callCount(), 1);

  const savedQuality = gfx().shaderQuality;
  t.after(() => setGfx({ shaderQuality: savedQuality }));
  setGfx({ shaderQuality: 2 });
  play.info.render.frame++;
  offer(play);
  assert.equal(dynamicLightUniforms.dynCount.value, 0);
  assert.equal(dynamicLightUniforms.dynProfiles.value, null);
  setGfx({ shaderQuality: 3 });
  play.info.render.frame++;
  offer(play);
  assert.equal(dynamicLightUniforms.dynCount.value, 1);
  assert.equal(dynamicLightUniforms.dynProfiles.value, texture);
});
