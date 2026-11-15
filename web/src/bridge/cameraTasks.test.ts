import assert from "node:assert/strict";
import test from "node:test";
import { CameraTaskGestures, type CameraTaskEvent } from "./cameraTasks.ts";

test("camera task yaw is counted once per left drag across the ±π seam", () => {
  const events: CameraTaskEvent[] = [];
  const gestures = new CameraTaskGestures(event => events.push(event));
  gestures.moveOrbit(1);
  gestures.beginOrbit(3);
  gestures.moveOrbit(-3);
  assert.deepEqual(events, []);
  gestures.moveOrbit(-2.3);
  gestures.moveOrbit(-1);
  assert.deepEqual(events, ["orbit"]);
  gestures.beginOrbit(0);
  gestures.moveOrbit(Math.PI / 4);
  gestures.endOrbit();
  gestures.moveOrbit(1.2);
  assert.deepEqual(events, ["orbit"]);
});

test("wheel input records the two native directions and ignores zero", () => {
  const events: CameraTaskEvent[] = [];
  const gestures = new CameraTaskGestures(event => events.push(event));
  gestures.zoom(-50);
  gestures.zoom(0);
  gestures.zoom(50);
  assert.deepEqual(events, ["zoomIn", "zoomOut"]);
});
