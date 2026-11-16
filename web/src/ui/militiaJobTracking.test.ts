import assert from "node:assert/strict";
import test from "node:test";
import { isFreelanceJobTracked, readTrackedMilitiaJob, setDungeonTracked, trackFreelanceJob, trackedJobsChanged, trackedMilitiaJob, trackedDungeonJobs, trackMilitiaJob, untrackMilitiaJob } from "./jobTracking.ts";
import { dungeonTravelAction, dungeonTravelProgress, isCurrentDungeonSite, warDungeonCanBrowse, dungeonJobID, warDungeonProviders } from "../bridge/dungeonJobs.ts";

test("war site travel uses the selected route, then the local scanner result", () => {
  const remote = { local: false, inside: false, docked: false, destinationSet: false, jumps: 2, targetID: null };
  assert.equal(dungeonTravelAction(remote), "destination");
  assert.equal(dungeonTravelAction({ ...remote, destinationSet: true }), "jump");
  assert.equal(dungeonTravelAction({ ...remote, destinationSet: true, docked: true }), "undock");
  assert.equal(dungeonTravelAction({ ...remote, jumps: null }), null);
  assert.equal(dungeonTravelAction({ ...remote, local: true, targetID: "VIM-273" }), "warp");
  assert.equal(dungeonTravelAction({ ...remote, local: true, inside: true, targetID: "VIM-273" }), null);
  assert.equal(dungeonTravelProgress(2, true, 2), 0);
  assert.equal(dungeonTravelProgress(1, true, 2), 0.5);
  assert.equal(dungeonTravelProgress(1, false, 2), 0);
});

test("war site arrival requires the same system, dungeon and instance", () => {
  const site = { solarSystemID: 30004980, dungeonID: 9667, instanceID: 108 };
  const inside = { dungeonID: 9667, roomID: 28468, instanceID: 108 };
  assert.equal(isCurrentDungeonSite(site, 30004980, inside), true);
  assert.equal(isCurrentDungeonSite(site, 30004980, { ...inside, instanceID: 107 }), false);
  assert.equal(isCurrentDungeonSite(site, 30004980, { ...inside, dungeonID: 10477 }), false);
  assert.equal(isCurrentDungeonSite(site, 30004979, inside), false);
});
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
  const homefrontSite = { kind: "homefront", instanceID: 150 } as const;
  setDungeonTracked(140000001, gallenteSite, true);
  setDungeonTracked(140000001, guristasSite, true);
  setDungeonTracked(140000001, secondGuristasSite, true);
  setDungeonTracked(140000002, guristasSite, true);
  setDungeonTracked(140000001, homefrontSite, true);
  assert.deepEqual(trackedDungeonJobs(140000001).map(dungeonJobID), ["factional_warfare:150", "pirate_insurgencies:150", "pirate_insurgencies:151", "homefront:150"]);
  assert.deepEqual(Object.keys(JSON.parse(settings.get("evejs.play.140000001.tracked_opportunities_factional_warfare")!)), ["factional_warfare:150"]);
  const siteRevision = trackedJobsChanged.get();
  setDungeonTracked(140000001, guristasSite, true);
  assert.equal(trackedJobsChanged.get(), siteRevision);
  setDungeonTracked(140000001, guristasSite, false);
  assert.deepEqual(trackedDungeonJobs(140000001).map(dungeonJobID), ["factional_warfare:150", "pirate_insurgencies:151", "homefront:150"]);
  assert.deepEqual(trackedDungeonJobs(140000002).map(dungeonJobID), ["pirate_insurgencies:150"]);
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
