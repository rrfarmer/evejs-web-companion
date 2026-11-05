// R108 slice 3: the PI Manager's read, decoded — GET /api/roster/planets.
//
// The payload shape is the route's own (test/rosterPlanets.test.js pins that
// side; test/rosterPlanetsDecode.test.js feeds the route's real bytes through
// this decoder). What is checked here, and why each matters:
//
//   1. EVERY PILOT KEEPS ITS OWN READ-AT. Several pilots read at different
//      moments are not one moment, and a board that lost the per-pilot instant
//      could only ever present them as if they were.
//
//   2. THE CLOCK CORRECTION IS THE ENVELOPE'S. A pilot's read-at is when that
//      pilot was read; the browser's clock is corrected against the one sample
//      taken as the answer left, never against a pilot read earlier in it.
//
//   3. NOT ANSWERED IS NOT EMPTY. A pilot the route left out could not be read;
//      the board says so for THAT pilot, and does not say "has not built".

import test from "node:test";
import assert from "node:assert/strict";

import { decodeRosterColonies, unansweredPilots } from "../lib/piRoster.ts";

const FARMER_ID = 90000001;
const NOT_YET_BUILT_ID = 90000002;
const NO_TABLE_ID = 90000004;

const SERVER_NOW_MS = Date.UTC(2026, 8, 23, 9, 10, 0);
const FARMER_READ_AT_MS = SERVER_NOW_MS - 900;
const EMPTY_READ_AT_MS = SERVER_NOW_MS - 40;
// The browser's clock is five minutes slow.
const BROWSER_NOW_MS = SERVER_NOW_MS - 5 * 60_000;

function payload() {
  return {
    ok: true,
    serverNowMs: SERVER_NOW_MS,
    pilots: [
      {
        characterID: FARMER_ID,
        readAtMs: FARMER_READ_AT_MS,
        coloniesReadable: true,
        colonies: [
          {
            planetID: 40000002,
            planetName: "Alpha I",
            solarSystemID: 30000001,
            solarSystemName: "Alpha",
            planetTypeID: 11,
            planetTypeName: "Planet (Temperate)",
            commandCenterLevel: 4,
            lastSimulatedAtMs: FARMER_READ_AT_MS - 60_000,
            pins: [],
            linkCount: 0,
            links: [],
            routes: [],
          },
        ],
      },
      { characterID: NOT_YET_BUILT_ID, readAtMs: EMPTY_READ_AT_MS, coloniesReadable: true, colonies: [] },
      { characterID: NO_TABLE_ID, readAtMs: EMPTY_READ_AT_MS, coloniesReadable: false, colonies: [] },
    ],
  };
}

test("each pilot is decoded with its colonies and its OWN read-at", () => {
  const pilots = decodeRosterColonies(payload(), BROWSER_NOW_MS);
  assert.deepEqual(pilots.map((pilot) => pilot.characterID), [FARMER_ID, NOT_YET_BUILT_ID, NO_TABLE_ID]);
  assert.deepEqual(pilots.map((pilot) => pilot.readAtMs), [FARMER_READ_AT_MS, EMPTY_READ_AT_MS, EMPTY_READ_AT_MS]);
  assert.equal(pilots[0]!.report.colonies.length, 1);
  assert.equal(pilots[0]!.report.colonies[0]!.planetName, "Alpha I");
});

test("the clock correction comes from the envelope, the same for every pilot", () => {
  const pilots = decodeRosterColonies(payload(), BROWSER_NOW_MS);
  for (const pilot of pilots) {
    assert.equal(pilot.report.clockOffsetMs, SERVER_NOW_MS - BROWSER_NOW_MS);
  }
});

test("⚠ 'has not built' and 'no colony table' stay apart, per pilot", () => {
  const [, notYetBuilt, noTable] = decodeRosterColonies(payload(), BROWSER_NOW_MS);
  assert.equal(notYetBuilt!.report.coloniesReadable, true);
  assert.deepEqual(notYetBuilt!.report.colonies, []);
  assert.equal(noTable!.report.coloniesReadable, false);
});

test("a missing read-at is unknown, never the epoch", () => {
  const raw = payload();
  const { readAtMs: _dropped, ...withoutReadAt } = raw.pilots[1]!;
  const pilots = decodeRosterColonies({ ...raw, pilots: [withoutReadAt] }, BROWSER_NOW_MS);
  assert.equal(pilots[0]!.readAtMs, null);
});

test("junk entries and repeated pilots are dropped, the first kept", () => {
  const raw = payload();
  const pilots = decodeRosterColonies(
    {
      ...raw,
      pilots: [null, "nope", { characterID: 0 }, { characterID: -3 }, raw.pilots[0]!, { ...raw.pilots[1]!, characterID: FARMER_ID }],
    },
    BROWSER_NOW_MS,
  );
  assert.deepEqual(pilots.map((pilot) => pilot.characterID), [FARMER_ID]);
  assert.equal(pilots[0]!.report.colonies.length, 1);
});

test("a body that is not an answer decodes to no pilots", () => {
  assert.deepEqual(decodeRosterColonies(null, BROWSER_NOW_MS), []);
  assert.deepEqual(decodeRosterColonies({ ok: true }, BROWSER_NOW_MS), []);
});

test("⚠ a pilot asked about and not answered is named as unanswered, in ask order", () => {
  const pilots = decodeRosterColonies(payload(), BROWSER_NOW_MS);
  assert.deepEqual(
    unansweredPilots([90000007, FARMER_ID, 90000003, NO_TABLE_ID], pilots),
    [90000007, 90000003],
  );
  assert.deepEqual(unansweredPilots([FARMER_ID], pilots), []);
});

test("a pilot's planetary skills decode, and a missing or damaged sheet is unknown, not untrained", () => {
  const decode = (planetSkills: unknown) =>
    decodeRosterColonies({ serverNowMs: SERVER_NOW_MS, pilots: [{ characterID: FARMER_ID, planetSkills }] } as never, BROWSER_NOW_MS)[0]!.planetSkills;
  assert.deepEqual(decode({ consolidation: 4, commandCenterUpgrades: 5 }), { consolidation: 4, commandCenterUpgrades: 5 });
  assert.deepEqual(decode({ consolidation: 0, commandCenterUpgrades: 0 }), { consolidation: 0, commandCenterUpgrades: 0 });
  assert.equal(decode(undefined), null);
  assert.equal(decode({ consolidation: 7, commandCenterUpgrades: 5 }), null);
});
