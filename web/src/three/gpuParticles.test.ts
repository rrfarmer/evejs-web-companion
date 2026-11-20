import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { GpuEmitter, gpuSystemOf, shiftGpuParticles } from "./gpuParticles.ts";

function fixture() {
  const scene = new THREE.Scene();
  const system = gpuSystemOf(scene);
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 20_000);
  const renderer = {} as THREE.WebGLRenderer;
  const geometry = system.mesh.geometry;
  const rows = () => {
    const position = geometry.getAttribute("iPos");
    const velocity = geometry.getAttribute("iVel");
    const texture = geometry.getAttribute("iTex");
    return Array.from({ length: geometry.instanceCount }, (_, i) => ({
      texture: texture.getX(i),
      x: position.getX(i),
      velocity: [velocity.getX(i), velocity.getY(i), velocity.getZ(i)],
    }));
  };
  const emitter = (textureIndex: number, rate = 1) => new GpuEmitter({
    type: "Tr2GpuUniqueEmitter", textureIndex, rate, sizes: [100, 100, 100],
    minLifeTime: 5, maxLifeTime: 5, direction: [0, 1, 0], inheritVelocity: 0.5,
  });
  return { scene, system, rows, emitter, draw: () => system.prepareDraw(renderer, camera, 640, 640) };
}

test("an origin change preserves retained particles, queued impacts and new bursts", (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const { scene, system, rows, emitter, draw } = fixture();
  const position = new THREE.Vector3(1200, 0, -4000);
  const direction = new THREE.Vector3(0, 1, 0);
  const velocity = new THREE.Vector3(0, 0, 0);
  emitter(1).spawnOnce(system, position, direction, velocity, 1, 1);
  draw();
  assert.equal(rows().length, 1);

  emitter(2).spawnOnce(system, position, direction, velocity, 1, 1);
  shiftGpuParticles(scene, new THREE.Vector3(-1150, 0, 0));
  emitter(3).spawnAt(new THREE.Matrix4().makeTranslation(50, 0, -4000), system, null, null);
  now += 20;
  draw();
  assert.deepEqual(rows().map(row => [row.texture, row.x]).sort(), [[1, 50], [2, 50], [3, 50]]);
});

test("life emission keeps both endpoints and their velocities in one coordinate frame", (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const { scene, system, rows, emitter, draw } = fixture();
  draw();
  shiftGpuParticles(scene, new THREE.Vector3(-1150, 0, 0));
  const world = new THREE.Matrix4().makeTranslation(50, 0, -4000);
  const velocity = [0, 3, 4];
  emitter(1, 100).spawnAlong(world, system, [0, 0, 0], [2, 0, 0], velocity, velocity, 0.04);
  now += 20;
  draw();
  assert.equal(rows().length, 4);
  for (const row of rows()) {
    assert.ok(row.x >= 50 && row.x <= 52);
    assert.deepEqual(row.velocity, [0, 1.5, 2]);
  }
});
