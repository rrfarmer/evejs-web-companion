"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isCameraTaskEvent, recordCameraTaskEvents } = require("../src/gamePort/cameraTasks");
const { isBridgeWritePair, isPageWritePair } = require("../src/bridgeCallPolicy");

const dict = (...entries) => ({ type: "dict", entries });
const long = value => ({ type: "long", value: String(value) });
const tasks = [
  { id: 60, conditions: [{ event: "client_mouseZoom_in", target: 1 }, { event: "client_mouseZoom_out", target: 1 }] },
  { id: 61, conditions: [{ event: "client_spinCamera", target: 1 }] },
];

test("camera events add the native counts and completion times without discarding other tasks", async () => {
  const unrelatedTime = long("134273341290000000");
  let completed = dict([9, unrelatedTime]);
  let counters = dict(["client_openMap", long(7)]);
  const writes = [];
  async function ask(method, args) {
    if (method === "GetCompletedAchievementsAndClientEventCount") return dict(["completedDict", completed], ["eventDict", counters]);
    assert.equal(method, "UpdateClientAchievmentsAndCounters");
    [completed, counters] = args;
    writes.push(args);
  }
  const now = () => 1_800_000_000_000;
  assert.deepEqual(await recordCameraTaskEvents(tasks, ["zoomIn"], ask, now), ["zoomIn", "zoomOut", "orbit"]);
  assert.deepEqual(completed, dict([9, unrelatedTime]));
  assert.deepEqual(await recordCameraTaskEvents(tasks, ["orbit", "zoomOut", "orbit"], ask, now), []);
  const timestamp = long("134444736000000000");
  assert.deepEqual(completed, dict([9, unrelatedTime], [61, timestamp], [60, timestamp]));
  assert.deepEqual(counters, dict(["client_openMap", long(7)], ["client_mouseZoom_in", long(1)],
    ["client_spinCamera", long(1)], ["client_mouseZoom_out", long(1)]));
  assert.deepEqual(await recordCameraTaskEvents(tasks, ["zoomIn"], ask, now), []);
  assert.equal(writes.length, 2);
});

test("the camera route accepts only the three authored gestures", () => {
  for (const event of ["orbit", "zoomIn", "zoomOut"]) assert.equal(isCameraTaskEvent(event), true);
  for (const event of ["client_openMap", "constructor", null, ["orbit"]]) assert.equal(isCameraTaskEvent(event), false);
});

test("the generic page call cannot replace the native tracker's dictionaries directly", () => {
  const service = "monolithTaskTrackerMgr", method = "UpdateClientAchievmentsAndCounters";
  assert.equal(isBridgeWritePair(service, method), true);
  assert.equal(isPageWritePair(service, method), false);
});
