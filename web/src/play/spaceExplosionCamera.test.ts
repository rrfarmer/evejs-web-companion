import assert from "node:assert/strict";
import test from "node:test";
import { MathUtils, Vector3 } from "three";
import { explosionCameraFov, spaceExplosionCamera } from "./spaceExplosionCamera.ts";

test("a close Look At follows the authored spline and returns its aim over five seconds", () => {
  const eye = new Vector3(500, 50, 100), interest = new Vector3();
  const ship = new Vector3(-3500, 0, 500);
  const path = spaceExplosionCamera(eye, interest, ship, 500, 34, 1, 4200, 0.4)!;
  assert.equal(path.motionMs, 5040);
  assert.equal(path.returnMs, 5000);
  assert.deepEqual(path.eyeAt(0).toArray(), eye.toArray());
  const end = path.eyeAt(path.motionMs);
  assert.ok(Math.abs(end.distanceTo(ship) - eye.length()) < 1e-8);
  assert.ok(path.eyeAt(2520).distanceTo(eye.clone().lerp(end, 0.5)) > 1);
  assert.equal(path.targetAt(ship, 0).lengthSq(), 0);
  assert.ok(path.targetAt(ship, 2500).distanceTo(ship.clone().multiplyScalar(0.5)) < 1e-8);
  assert.deepEqual(path.targetAt(ship, 5000).toArray(), ship.toArray());
});

test("a distant Look At keeps the eye fixed and transfers its aim in three seconds", () => {
  const eye = new Vector3(4500, 0, 0), interest = new Vector3(10, 0, 0);
  const pilot = new Vector3(0, -1200, 0);
  const path = spaceExplosionCamera(eye, interest, pilot, 300, 34, 1, 4200, 0.5)!;
  assert.equal(path.motionMs, 0);
  assert.equal(path.returnMs, 3000);
  assert.deepEqual(path.eyeAt(400).toArray(), eye.toArray());
  assert.deepEqual(path.targetAt(pilot, 1500).toArray(), [5, -600, 0]);
  assert.deepEqual(path.targetAt(pilot, 3000).toArray(), pilot.toArray());
});

test("outside the blast bounds the translation spline retreats after its first phase", () => {
  const eye = new Vector3(-700, 50, 40), interest = new Vector3();
  const pilot = new Vector3(-3500, 0, 500);
  const path = spaceExplosionCamera(eye, interest, pilot, 10, 34, 1, 4200, 0.3)!;
  assert.equal(path.motionMs, 10040);
  const end = path.eyeAt(path.motionMs);
  const firstEnd = path.eyeAt(5040);
  assert.ok(firstEnd.distanceTo(eye.clone().lerp(end, 0.2)) < 1e-8);
  assert.ok(path.eyeAt(7540).distanceTo(firstEnd.lerp(end, 0.5)) < 1e-8);
});

test("the projection interpolates toward the installed one-radian default", () => {
  const nativeFov = MathUtils.radToDeg(1);
  assert.ok(explosionCameraFov(60, 1 / 60) < 60);
  assert.ok(explosionCameraFov(60, 1 / 60) > nativeFov);
  assert.equal(explosionCameraFov(60, 0.1), nativeFov);
  assert.equal(spaceExplosionCamera(new Vector3(), new Vector3(), new Vector3(50, 0, 0), 300, 34, 1, 4200), null);
});
