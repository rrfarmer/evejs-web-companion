import assert from "node:assert/strict";
import test from "node:test";
import { Vector3 } from "three";
import { initialOrbitDistance } from "./spaceCameraPose.ts";
import { ENTRY_CAMERA_DURATION_MS, entryCameraFov, spaceEntryCamera } from "./spaceEntryCamera.ts";

const system = 30000142, radius = 20, nearest = 33.5;
const ship = new Vector3(1000, 0, 0), direction = new Vector3(0, 0, 1);
const planets = [
  { position: new Vector3(0, 0, 10_000), radius: 300 },
  { position: new Vector3(2000, 0, 0), radius: 500 },
];

test("a returning pilot zooms in over 12 seconds and changes angle for the full 15 seconds", () => {
  const camera = spaceEntryCamera(true, system, radius, nearest, ship, direction, planets)!;
  const initialDistance = initialOrbitDistance(radius, nearest, 700_000);
  assert.ok(Math.abs(camera.eyeAt(0).length() - 5 * initialDistance) < 1e-8);
  assert.ok(Math.abs(camera.eyeAt(12_000).length() - initialDistance) < 1e-8);
  assert.notDeepEqual(camera.eyeAt(12_000), camera.eyeAt(ENTRY_CAMERA_DURATION_MS));
  const final = camera.eyeAt(ENTRY_CAMERA_DURATION_MS);
  assert.ok(final.x < 0 && final.y < 0);
  assert.deepEqual(camera.eyeAt(16_000), final);
  assert.ok(entryCameraFov(initialDistance) < entryCameraFov(5 * initialDistance));
});

test("a pilot who has never warped is framed against the nearest planet outside Void Space", () => {
  const camera = spaceEntryCamera(false, system, radius, nearest, ship, direction, planets)!;
  const first = camera.eyeAt(0), final = camera.eyeAt(ENTRY_CAMERA_DURATION_MS);
  assert.ok(first.x > 0 && first.z > 0);
  assert.ok(final.distanceTo(new Vector3(-100, 20, 0)) < 1e-8);
  assert.ok(camera.eyeAt(ENTRY_CAMERA_DURATION_MS / 2).distanceTo(first.clone().lerp(final, 0.5)) < 1e-8);
  const voidCamera = spaceEntryCamera(false, 34000001, radius, nearest, ship, direction, planets)!;
  assert.deepEqual(voidCamera.eyeAt(0), spaceEntryCamera(true, system, radius, nearest, ship, direction, planets)!.eyeAt(0));
});

test("missing first-flight planet data uses a finite returning path", () => {
  const camera = spaceEntryCamera(false, system, radius, nearest, ship, direction, [])!;
  assert.deepEqual(camera.eyeAt(0), spaceEntryCamera(true, system, radius, nearest, ship, direction, [])!.eyeAt(0));
  assert.equal(spaceEntryCamera(true, system, radius, nearest, ship, new Vector3(), planets), null);
  assert.equal(spaceEntryCamera(true, system, radius, NaN, ship, direction, planets), null);
});
