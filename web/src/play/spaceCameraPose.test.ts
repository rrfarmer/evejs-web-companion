import { Vector3 } from "three";
import assert from "node:assert/strict";
import test from "node:test";
import { isOwnStargateDeparture, MAX_JUMP_CAMERA_COORDINATE, setCameraDistance, setCameraPose, translateCameraPose } from "./spaceCameraPose.ts";

test("the jump camera starts only on the pilot's own stargate departure effect", () => {
  const shipID = 9988400000871;
  assert.equal(isOwnStargateDeparture(["effects.JumpOut"], shipID, true, shipID), true);
  assert.equal(isOwnStargateDeparture(["effects.JumpOut"], shipID + 1, true, shipID), false);
  assert.equal(isOwnStargateDeparture(["effects.JumpOut"], shipID, true, null), false);
  assert.equal(isOwnStargateDeparture(["effects.JumpOut"], shipID, false, shipID), false);
  assert.equal(isOwnStargateDeparture(["effects.JumpIn"], shipID, true, shipID), false);
});

test("a jump rebases both camera points and preserves the sightline", () => {
  const eye = new Vector3(80, 12, -50), target = new Vector3(10, 0, -3);
  const sightline = target.clone().sub(eye);
  assert.equal(translateCameraPose(eye, target, new Vector3(-6, -8, 30), MAX_JUMP_CAMERA_COORDINATE), true);
  assert.deepEqual(eye.toArray(), [74, 4, -20]);
  assert.deepEqual(target.toArray(), [4, -8, 27]);
  assert.deepEqual(target.clone().sub(eye), sightline);
});

test("an invalid jump pose leaves both previous points intact", () => {
  const eye = new Vector3(1, 2, 3), target = new Vector3(1, 0, 0);
  for (const x of [NaN, Infinity, MAX_JUMP_CAMERA_COORDINATE + 1]) {
    assert.equal(setCameraPose(eye, target, new Vector3(40, 0, 0), new Vector3(x, 0, 0), MAX_JUMP_CAMERA_COORDINATE), false);
    assert.equal(translateCameraPose(eye, target, new Vector3(x, 0, 0), MAX_JUMP_CAMERA_COORDINATE), false);
  }
  assert.equal(setCameraPose(eye, target, new Vector3(4, 5, 6), new Vector3(4, 5, 6)), false);
  assert.deepEqual(eye.toArray(), [1, 2, 3]);
  assert.deepEqual(target.toArray(), [1, 0, 0]);
});

test("zoom and aim preserve the current eye when given an invalid or coincident direction", () => {
  const eye = new Vector3(0, 0, 30), target = new Vector3();
  assert.equal(setCameraDistance(eye, target, new Vector3(1, 0, 0), 30), true);
  assert.deepEqual(eye.toArray(), [30, 0, 0]);
  assert.equal(setCameraDistance(eye, target, new Vector3(), 30), false);
  assert.equal(setCameraDistance(eye, target, new Vector3(NaN, 0, 0), 30), false);
  assert.equal(setCameraDistance(eye, target, new Vector3(1, 0, 0), 0), false);
  assert.equal(setCameraDistance(eye, target, new Vector3(1, 0, 0), Infinity), false);
  assert.deepEqual(eye.toArray(), [30, 0, 0]);
});
