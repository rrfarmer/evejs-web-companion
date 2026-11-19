import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { miningWaveSample, miningWaveTargets, MiningSurveyWave } from "./miningSurveyWave.ts";

const position = (x: number) => ({ x, y: 0, z: 0 });
const rock = (itemID: number, x: number, radius: number) => ({ itemID, typeID: null, position: position(x), radius });
const result = (itemID: number) => ({ itemID, yieldTypeID: null, remainingQuantity: null });

test("the authored mining scan radius moves linearly to 250 km in eight seconds", () => {
  assert.equal(miningWaveSample(0).radius, 0);
  assert.deepEqual(miningWaveSample(4000), { radius: 125_000, brightness: 1, finished: false });
  assert.equal(miningWaveSample(7200).brightness < 0.25, true);
  assert.deepEqual(miningWaveSample(8000), { radius: 250_000, brightness: 0, finished: true });
});

test("the wave considers surveyed rocks in far-edge order and omits rocks beyond its range", () => {
  const targets = miningWaveTargets([rock(1, 10_000, 1_000), rock(2, 10_500, 100), rock(3, 250_000, 10), rock(4, 10, 1)],
    [result(1), result(2), result(3)], position(0));
  assert.deepEqual(targets.map(({ itemID, distance }) => [itemID, distance]), [[2, 10_600], [1, 11_000]]);
});

test("the mining wave draws one highlight per reached rock and cleans up on warp", async () => {
  const wave = new MiningSurveyWave();
  const origin = position(0);
  const targets = miningWaveTargets([rock(1, 100, 10), rock(2, 60_000, 20)], [result(1), result(2)], origin);
  const done = wave.start(10, origin, 0, targets, Promise.resolve(new Map()), 0);
  const ego = { itemID: 10, position: origin, mode: "STOP" };
  const place = (id: number) => ({ position: new THREE.Vector3(id * 5, 0, 0), visibleRadius: 10 });
  wave.update(1000, ego, place);
  const marker = wave.group.children[1] as THREE.InstancedMesh;
  assert.equal(marker.count, 1);
  const drawn = new THREE.Matrix4();
  marker.getMatrixAt(0, drawn);
  assert.ok(Math.abs(drawn.elements[0]! - 10.8) < 1e-5);
  assert.equal(wave.group.children[0]?.visible, true);
  wave.update(8000, ego, place);
  await done;
  assert.equal(marker.count, 2);
  assert.equal(wave.group.children[0]?.visible, false);
  wave.update(8500, { ...ego, mode: "WARP" }, place);
  assert.equal(wave.group.children.length, 1);
  wave.dispose();
});

test("survey markers use the rock mesh, rotation and rendered scale", async () => {
  const wave = new MiningSurveyWave();
  const origin = position(0);
  const targets = miningWaveTargets([rock(1, 100, 400)], [result(1)], origin);
  const done = wave.start(10, origin, 0, targets, Promise.resolve(new Map()), 0);
  const geometry = new THREE.IcosahedronGeometry(1, 0);
  const pos = new THREE.Vector3(150, 25, -40);
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.5);
  wave.update(8000, { itemID: 10, position: origin, mode: "STOP" }, () => ({
    position: pos, visibleRadius: 450, geometry, rotation,
  }));
  await done;
  const marker = wave.group.children[1] as THREE.InstancedMesh;
  assert.equal(marker.geometry, geometry);
  const drawn = new THREE.Matrix4();
  marker.getMatrixAt(0, drawn);
  const expected = new THREE.Matrix4().compose(pos, rotation, new THREE.Vector3().setScalar(450 * 1.015));
  assert.ok(drawn.elements.every((value, index) => Math.abs(value - expected.elements[index]!) < 3e-5));
  wave.dispose();
  geometry.dispose();
});
