import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
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
