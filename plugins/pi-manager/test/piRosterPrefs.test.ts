// R108 slice 3: the PI Manager's roster — who is on planetary industry, and the
// last thing each pilot's colonies were read to say.
//
// What is checked, and why each matters:
//
//   1. A STORED READING COMES BACK THROUGH THE DECODER. localStorage is
//      untrusted bytes; a reading is kept as the route sent it and decoded on
//      the way out by the same code a live answer goes through, so a stored row
//      and a fresh one can never be read two ways.
//
//   2. THE READ-AT SURVIVES A RELOAD. A board reopened tomorrow must say
//      yesterday's reading is a day old, not present it as current.
//
//   3. SEEDED FROM A SQUAD, NOT LINKED TO ONE. Adding a squad copies its pilots
//      once; the roster is a job list and does not follow the squad after.

import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_PI_ROSTER,
  addPiMember,
  addPiMembers,
  loadPiRoster,
  piReadings,
  recordPiAnswer,
  removePiMember,
  savePiRoster,
  setPiRosterStorage,
  type PiRosterStorage,
} from "../lib/piRosterPrefs.ts";

const FARMER = 90000001;
const HAULER = 90000002;
const STRANGER = 90000009;
const SERVER_NOW_MS = Date.UTC(2026, 8, 23, 9, 10, 0);
const BROWSER_NOW_MS = SERVER_NOW_MS - 2 * 60_000;

function memoryStorage(): PiRosterStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function answer() {
  return {
    ok: true,
    serverNowMs: SERVER_NOW_MS,
    pilots: [
      {
        characterID: FARMER,
        readAtMs: SERVER_NOW_MS - 500,
        coloniesReadable: true,
        colonies: [
          {
            planetID: 40000002,
            planetName: "Alpha I",
            solarSystemID: 30000001,
            solarSystemName: "Alpha",
            planetTypeID: 2016,
            planetTypeName: "Planet (Barren)",
            commandCenterLevel: 5,
            lastSimulatedAtMs: SERVER_NOW_MS - 60_000,
            pins: [],
            linkCount: 0,
            links: [],
            routes: [],
          },
        ],
      },
      { characterID: HAULER, readAtMs: SERVER_NOW_MS - 100, coloniesReadable: true, colonies: [] },
      // Not on the roster: an answer for them is not kept.
      { characterID: STRANGER, readAtMs: SERVER_NOW_MS, coloniesReadable: true, colonies: [] },
    ],
  };
}

test.afterEach(() => {
  setPiRosterStorage(null);
});

test("members are added once, in order, and junk is refused", () => {
  let prefs = addPiMember(EMPTY_PI_ROSTER, FARMER);
  prefs = addPiMember(prefs, HAULER);
  prefs = addPiMember(prefs, FARMER);
  prefs = addPiMember(prefs, 0);
  prefs = addPiMember(prefs, Number.NaN);
  assert.deepEqual(prefs.members, [FARMER, HAULER]);
});

test("a squad seeds the roster once, keeping who is already there", () => {
  const prefs = addPiMembers(addPiMember(EMPTY_PI_ROSTER, HAULER), [FARMER, HAULER, STRANGER]);
  assert.deepEqual(prefs.members, [HAULER, FARMER, STRANGER]);
});

test("an answer is kept per member, and a non-member's is not", () => {
  const prefs = recordPiAnswer(
    addPiMembers(EMPTY_PI_ROSTER, [FARMER, HAULER]),
    answer(),
    BROWSER_NOW_MS,
  );
  const readings = piReadings(prefs);
  assert.deepEqual([...readings.keys()].sort(), [FARMER, HAULER]);
  // Not merely hidden: a stranger's colonies are never written to storage.
  assert.deepEqual(Object.keys(prefs.readings).sort(), [String(FARMER), String(HAULER)]);
  const farmer = readings.get(FARMER)!;
  assert.equal(farmer.readAtMs, SERVER_NOW_MS - 500);
  assert.equal(farmer.report.clockOffsetMs, SERVER_NOW_MS - BROWSER_NOW_MS);
  assert.equal(farmer.report.colonies[0]!.planetName, "Alpha I");
  assert.deepEqual(readings.get(HAULER)!.report.colonies, []);
});

test("⚠ an answer that left a pilot out does not erase that pilot's last reading", () => {
  const first = recordPiAnswer(addPiMembers(EMPTY_PI_ROSTER, [FARMER, HAULER]), answer(), BROWSER_NOW_MS);
  const onlyHauler = { ...answer(), pilots: [answer().pilots[1]!] };
  const second = recordPiAnswer(first, onlyHauler, BROWSER_NOW_MS + 60_000);
  assert.equal(piReadings(second).get(FARMER)!.report.colonies.length, 1);
});

test("removing a pilot forgets its reading too", () => {
  const prefs = removePiMember(
    recordPiAnswer(addPiMembers(EMPTY_PI_ROSTER, [FARMER, HAULER]), answer(), BROWSER_NOW_MS),
    FARMER,
  );
  assert.deepEqual(prefs.members, [HAULER]);
  assert.equal(piReadings(prefs).has(FARMER), false);
  // Put back on later, the pilot starts unread — not with a reading from before
  // it was taken off, presented as if it were the latest.
  assert.equal(piReadings(addPiMember(prefs, FARMER)).has(FARMER), false);
});

test("⚠ the roster and its read-at survive a reload, through the decoder", () => {
  const storage = memoryStorage();
  setPiRosterStorage(storage);
  savePiRoster(recordPiAnswer(addPiMembers(EMPTY_PI_ROSTER, [FARMER, HAULER]), answer(), BROWSER_NOW_MS));

  const reloaded = loadPiRoster();
  assert.deepEqual(reloaded.members, [FARMER, HAULER]);
  const farmer = piReadings(reloaded).get(FARMER)!;
  assert.equal(farmer.readAtMs, SERVER_NOW_MS - 500);
  assert.equal(farmer.report.clockOffsetMs, SERVER_NOW_MS - BROWSER_NOW_MS);
  assert.equal(farmer.report.colonies.length, 1);
});

test("untrusted storage: garbage loads as an empty roster, bad rows are dropped", () => {
  const storage = memoryStorage();
  setPiRosterStorage(storage);
  for (const raw of ["not json", "[]", "null", JSON.stringify({ members: "x" })]) {
    storage.data.clear();
    storage.setItem("evejs-web-pi-roster:v1", raw);
    assert.deepEqual(loadPiRoster(), EMPTY_PI_ROSTER, raw);
  }
  storage.setItem("evejs-web-pi-roster:v1", JSON.stringify({
    members: [FARMER, FARMER, -1, "x", HAULER],
    readings: {
      [FARMER]: { pilot: { characterID: FARMER, coloniesReadable: true, colonies: [] }, serverNowMs: null, browserNowMs: "late" },
      [HAULER]: { pilot: { characterID: HAULER, readAtMs: 5, coloniesReadable: true, colonies: [] }, serverNowMs: 10, browserNowMs: 8 },
      [STRANGER]: { pilot: { characterID: STRANGER, coloniesReadable: true, colonies: [] }, serverNowMs: 10, browserNowMs: 8 },
    },
  }));
  const prefs = loadPiRoster();
  assert.deepEqual(prefs.members, [FARMER, HAULER]);
  assert.deepEqual([...piReadings(prefs).keys()], [HAULER]);
});

test("a stored reading filed under the wrong pilot is not believed", () => {
  const storage = memoryStorage();
  setPiRosterStorage(storage);
  storage.setItem("evejs-web-pi-roster:v1", JSON.stringify({
    members: [FARMER],
    readings: {
      [FARMER]: { pilot: { characterID: HAULER, coloniesReadable: true, colonies: [] }, serverNowMs: 10, browserNowMs: 8 },
    },
  }));
  assert.equal(piReadings(loadPiRoster()).size, 0);
});

test("no storage at all is an empty roster, and saving is harmless", () => {
  setPiRosterStorage(null);
  assert.deepEqual(loadPiRoster(), EMPTY_PI_ROSTER);
  savePiRoster(addPiMember(EMPTY_PI_ROSTER, FARMER));
});
