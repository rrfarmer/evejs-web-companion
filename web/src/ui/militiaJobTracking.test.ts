import assert from "node:assert/strict";
import test from "node:test";
import { isFreelanceJobTracked, readTrackedMilitiaJob, trackFreelanceJob, trackedJobsChanged, trackedMilitiaJob, trackMilitiaJob, untrackMilitiaJob } from "./jobTracking.ts";

test("militia initiation replaces the pilot's previous faction and leaves other jobs and pilots alone", (t) => {
  const settings = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => settings.get(key) ?? null,
    setItem: (key: string, value: string) => { settings.set(key, value); },
    removeItem: (key: string) => { settings.delete(key); },
  } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  trackFreelanceJob(140000001, "test-freelance-job");
  trackMilitiaJob(140000001, 500004);
  const entry = readTrackedMilitiaJob(140000001);
  assert.equal(entry?.factionID, 500004);
  assert.ok((entry?.since ?? 0) > 0);
  const revision = trackedJobsChanged.get();
  trackMilitiaJob(140000001, 500004);
  assert.deepEqual(readTrackedMilitiaJob(140000001), entry);
  assert.equal(trackedJobsChanged.get(), revision);

  trackMilitiaJob(140000001, 500010);
  trackMilitiaJob(140000002, 500001);
  untrackMilitiaJob(140000001, 500004);
  assert.equal(trackedMilitiaJob(140000001), 500010);
  untrackMilitiaJob(140000001);
  assert.equal(trackedMilitiaJob(140000001), null);
  assert.equal(trackedMilitiaJob(140000002), 500001);
  assert.equal(isFreelanceJobTracked(140000001, "test-freelance-job"), true);
});
