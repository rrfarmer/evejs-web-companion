import assert from "node:assert/strict";
import test from "node:test";
import { isFreelanceJobTracked, readTrackedMilitiaJob, setWarDungeonTracked, trackFreelanceJob, trackedJobsChanged, trackedMilitiaJob, trackedWarDungeonJobs, trackMilitiaJob, untrackMilitiaJob } from "./jobTracking.ts";
import { warDungeonCanBrowse, warDungeonJobID, warDungeonProviders } from "../bridge/dungeonJobs.ts";
import { enterDungeonRoom } from "../bridge/dungeonTracking.ts";

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

  const gallenteSite = { kind: "factional_warfare", instanceID: 150 } as const;
  const guristasSite = { kind: "pirate_insurgencies", instanceID: 150 } as const;
  const secondGuristasSite = { ...guristasSite, instanceID: 151 };
  setWarDungeonTracked(140000001, gallenteSite, true);
  setWarDungeonTracked(140000001, guristasSite, true);
  setWarDungeonTracked(140000001, secondGuristasSite, true);
  setWarDungeonTracked(140000002, guristasSite, true);
  assert.deepEqual(trackedWarDungeonJobs(140000001).map(warDungeonJobID), ["factional_warfare:150", "pirate_insurgencies:150", "pirate_insurgencies:151"]);
  assert.deepEqual(Object.keys(JSON.parse(settings.get("evejs.play.140000001.tracked_opportunities_factional_warfare")!)), ["factional_warfare:150"]);
  const siteRevision = trackedJobsChanged.get();
  setWarDungeonTracked(140000001, guristasSite, true);
  assert.equal(trackedJobsChanged.get(), siteRevision);
  setWarDungeonTracked(140000001, guristasSite, false);
  assert.deepEqual(trackedWarDungeonJobs(140000001).map(warDungeonJobID), ["factional_warfare:150", "pirate_insurgencies:151"]);
  assert.deepEqual(trackedWarDungeonJobs(140000002).map(warDungeonJobID), ["pirate_insurgencies:150"]);
  assert.equal(isFreelanceJobTracked(140000001, "test-freelance-job"), true);
});

test("war site providers and Browse follow the client's enlistment and combat faction rules", () => {
  assert.deepEqual(warDungeonProviders(null), []);
  assert.deepEqual(warDungeonProviders(500001), ["factional_warfare", "pirate_insurgencies"]);
  assert.deepEqual(warDungeonProviders(500010), ["pirate_insurgencies"]);
  assert.equal(warDungeonCanBrowse(500001, 500001), true);
  assert.equal(warDungeonCanBrowse(500001, 500004), true);
  assert.equal(warDungeonCanBrowse(500001, 500010), true);
  assert.equal(warDungeonCanBrowse(500001, 500002), false);
  assert.equal(warDungeonCanBrowse(500010, 500003), false);
});

test("two sites sharing a dungeon template preserve the instance actually entered", () => {
  const first = { dungeonID: 10477, instanceID: 150, roomID: 1 };
  const second = { dungeonID: 10477, instanceID: 151, roomID: 1 };
  assert.deepEqual(enterDungeonRoom(first, { ...first, instanceID: null, roomID: 2 }), { ...first, roomID: 2 });
  assert.deepEqual(enterDungeonRoom(first, second), second);
});
