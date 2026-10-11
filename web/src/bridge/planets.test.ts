// R41: the colony decoder, and the small amount of arranging it does.
//
// The raw payload below is the ACTUAL body GET /api/bridge/planets answers for
// a colony captured out of eve.js's own planetRuntimeStore normalizers — the
// same fixture test/bridgePlanets.test.js drives the BFF with, taken from the
// other side of the wire. Nothing in it was invented to make an assertion pass.
//
// What is checked, and why each matters:
//
//   1. NULL IS NOT ZERO AND NULL IS NOT EMPTY. An instant the server did not
//      give is null, never 0 (which would read as the year 1601); an unnamed
//      planet is null, never its own id.
//
//   2. `coloniesReadable` SURVIVES. It is the only thing that separates "you
//      have built nothing" from "we could not see whether you have", and if it
//      is dropped here the panel cannot tell them apart either.
//
//   3. EXPIRY IS DECIDED ON THE SERVER'S CLOCK. Every "has this finished?"
//      goes through serverNow(clockOffsetMs), so a browser whose clock is an
//      hour out still sees the truth.

import test from "node:test";
import assert from "node:assert/strict";

import {
  colonyPlaceWords,
  decodeColonyReport,
  formatDuration,
  pooledContents,
  programHasExpired,
  programProgress,
  serverNow,
  summarizeColony,
} from "./planets.ts";
import type { JsonValue } from "./wire.ts";

const PLANET_ID = 40000002;
const SERVER_NOW = Date.UTC(2026, 6, 21, 12, 0, 0);
const HOUR = 3_600_000;

const AQUEOUS = 2268;
const WATER = 3645;
const BACTERIA = 2393;

/** The BFF's answer for the captured colony, verbatim in shape. */
function rawReport(overrides: Record<string, JsonValue> = {}): JsonValue {
  return {
    ok: true,
    characterID: 7,
    serverNowMs: SERVER_NOW,
    coloniesReadable: true,
    colonies: [
      {
        planetID: PLANET_ID,
        planetName: "Tanoo I",
        solarSystemID: 30000001,
        solarSystemName: "Tanoo",
        planetTypeID: 11,
        planetTypeName: "Planet (Temperate)",
        commandCenterLevel: 3,
        lastSimulatedAtMs: Date.UTC(2026, 6, 21, 11, 59, 0),
        linkCount: 4,
        links: [
          { endpoint1: 1, endpoint2: 2, level: 0 },
          { endpoint1: 1, endpoint2: 4, level: 1 },
          { endpoint1: 4, endpoint2: 5, level: 0 },
          { endpoint1: 1, endpoint2: 6, level: 0 },
        ],
        pins: [
          {
            pinID: 1,
            typeID: 2254,
            typeName: "Temperate Command Center",
            kind: "command",
            contents: [],
            usedM3: 0,
            capacityM3: 500,
            schematicID: null,
            schematicName: null,
            hasReceivedInputs: null,
            receivedInputsLastCycle: null,
            lastRunAtMs: SERVER_NOW - 60_000,
            lastLaunchAtMs: null,
            program: null,
          },
          {
            pinID: 2,
            typeID: 3068,
            typeName: "Temperate Extractor Control Unit",
            kind: "extractor-control",
            contents: [],
            usedM3: 0,
            capacityM3: null,
            schematicID: null,
            schematicName: null,
            hasReceivedInputs: null,
            receivedInputsLastCycle: null,
            lastRunAtMs: SERVER_NOW - 60_000,
            lastLaunchAtMs: null,
            program: {
              resourceTypeID: AQUEOUS,
              resourceTypeName: "Aqueous Liquids",
              cycleTimeSeconds: 3600,
              quantityPerCycle: 2841,
              installedAtMs: SERVER_NOW - 3 * HOUR,
              expiresAtMs: SERVER_NOW + 21 * HOUR,
              headCount: 3,
              headRadius: 0.012,
            },
          },
          {
            pinID: 3,
            typeID: 3068,
            typeName: "Temperate Extractor Control Unit",
            kind: "extractor-control",
            contents: [],
            usedM3: 0,
            capacityM3: null,
            schematicID: null,
            schematicName: null,
            hasReceivedInputs: null,
            receivedInputsLastCycle: null,
            lastRunAtMs: SERVER_NOW - 60_000,
            lastLaunchAtMs: null,
            program: {
              resourceTypeID: 2073,
              resourceTypeName: "Microorganisms",
              cycleTimeSeconds: 1800,
              quantityPerCycle: 1204,
              installedAtMs: SERVER_NOW - 48 * HOUR,
              expiresAtMs: SERVER_NOW - 2 * HOUR,
              headCount: 1,
            },
          },
          {
            pinID: 4,
            typeID: 2481,
            typeName: "Temperate Basic Industry Facility",
            kind: "factory",
            contents: [{ typeID: AQUEOUS, typeName: "Aqueous Liquids", quantity: 900 }],
            usedM3: 4.5,
            capacityM3: null,
            schematicID: 65,
            schematicName: "Superconductors",
            hasReceivedInputs: true,
            receivedInputsLastCycle: true,
            lastRunAtMs: SERVER_NOW - 60_000,
            lastLaunchAtMs: null,
            program: null,
          },
          {
            pinID: 5,
            typeID: 2256,
            typeName: "Temperate Launchpad",
            kind: "launchpad",
            contents: [
              { typeID: WATER, typeName: "Water", quantity: 4200 },
              { typeID: BACTERIA, typeName: "Bacteria", quantity: 300 },
            ],
            usedM3: 855,
            capacityM3: 10000,
            schematicID: null,
            schematicName: null,
            hasReceivedInputs: null,
            receivedInputsLastCycle: null,
            lastRunAtMs: SERVER_NOW - 60_000,
            lastLaunchAtMs: null,
            program: null,
          },
          {
            pinID: 6,
            typeID: 2562,
            typeName: "Temperate Storage Facility",
            kind: "storage",
            contents: [{ typeID: AQUEOUS, typeName: "Aqueous Liquids", quantity: 12000 }],
            usedM3: 60,
            capacityM3: 12000,
            schematicID: null,
            schematicName: null,
            hasReceivedInputs: null,
            receivedInputsLastCycle: null,
            lastRunAtMs: SERVER_NOW - 60_000,
            lastLaunchAtMs: null,
            program: null,
          },
        ],
        routes: [
          {
            routeID: 1,
            path: [2, 4],
            commodityTypeID: AQUEOUS,
            commodityTypeName: "Aqueous Liquids",
            commodityQuantity: 2841,
          },
          {
            routeID: 2,
            path: [4, 5],
            commodityTypeID: WATER,
            commodityTypeName: "Water",
            commodityQuantity: 20,
          },
        ],
      },
    ],
    ...overrides,
  } as JsonValue;
}

/** Decode as if the browser's clock agreed with the server's. */
function decoded(overrides?: Record<string, JsonValue>) {
  return decodeColonyReport(rawReport(overrides), SERVER_NOW);
}

test("a colony decodes with its place named and its planet type kept for the icon", () => {
  const report = decoded();
  assert.equal(report.colonies.length, 1);
  const colony = report.colonies[0]!;
  assert.equal(colony.planetName, "Tanoo I");
  assert.equal(colony.solarSystemName, "Tanoo");
  assert.equal(colony.planetTypeName, "Planet (Temperate)");
  assert.equal(colony.planetTypeID, 11);
  assert.equal(colony.commandCenterLevel, 3);
  assert.equal(colony.linkCount, 4);
});

test("pins are ordered by what you decide about first, not by id", () => {
  const colony = decoded().colonies[0]!;
  assert.deepEqual(
    colony.pins.map((pin) => pin.kind),
    ["extractor-control", "extractor-control", "factory", "launchpad", "storage", "command"],
  );
});

test("an unknown pin kind degrades to \"other\" rather than throwing the colony away", () => {
  const raw = rawReport() as unknown as {
    colonies: { pins: { kind: string }[] }[];
  };
  raw.colonies[0]!.pins[0]!.kind = "orbital-death-ray";
  const report = decodeColonyReport(raw as unknown as JsonValue, SERVER_NOW);
  assert.equal(report.colonies.length, 1);
  assert.ok(report.colonies[0]!.pins.some((pin) => pin.kind === "other"));
});

test("the clock offset is the SERVER's now minus the browser's at read time", () => {
  // A browser running an hour fast.
  const report = decodeColonyReport(rawReport(), SERVER_NOW + HOUR);
  assert.equal(report.clockOffsetMs, -HOUR);
  assert.equal(serverNow(report.clockOffsetMs, SERVER_NOW + HOUR), SERVER_NOW);
});

test("expiry is judged on the server's clock, so a wrong browser clock cannot lie", () => {
  // Browser is an hour FAST. The finished extractor is finished either way, but
  // the running one must not be reported finished just because this machine
  // thinks it is later than it is.
  const report = decodeColonyReport(rawReport(), SERVER_NOW + HOUR);
  const now = serverNow(report.clockOffsetMs, SERVER_NOW + HOUR);
  const colony = report.colonies[0]!;
  const running = colony.pins.find((pin) => pin.pinID === 2)!;
  const finished = colony.pins.find((pin) => pin.pinID === 3)!;

  assert.equal(programHasExpired(running.program!, now), false);
  assert.equal(programHasExpired(finished.program!, now), true);

  // And the naive comparison — the one this guards against — would have been
  // wrong for a program with less than an hour left.
  const almostDone = { ...running.program!, expiresAtMs: SERVER_NOW + HOUR / 2 };
  assert.equal(programHasExpired(almostDone, now), false);
  assert.equal(programHasExpired(almostDone, SERVER_NOW + HOUR), true);
});

test("\"nothing there\" and \"nothing readable\" decode differently", () => {
  const empty = decodeColonyReport(
    { ok: true, serverNowMs: SERVER_NOW, coloniesReadable: true, colonies: [] },
    SERVER_NOW,
  );
  assert.equal(empty.coloniesReadable, true);
  assert.deepEqual(empty.colonies, []);

  const silent = decodeColonyReport(
    { ok: true, serverNowMs: SERVER_NOW, coloniesReadable: false, colonies: [] },
    SERVER_NOW,
  );
  assert.equal(silent.coloniesReadable, false);

  // A payload that says nothing at all about readability is NOT readable.
  const nothing = decodeColonyReport({ ok: true }, SERVER_NOW);
  assert.equal(nothing.coloniesReadable, false);
  assert.deepEqual(nothing.colonies, []);
});

test("an instant the server did not give stays null, never 0", () => {
  const raw = rawReport() as unknown as {
    colonies: { lastSimulatedAtMs: number | null; pins: { program: unknown }[] }[];
  };
  raw.colonies[0]!.lastSimulatedAtMs = null;
  (raw.colonies[0]!.pins[1]!.program as { expiresAtMs: number | null }).expiresAtMs = null;
  const colony = decodeColonyReport(raw as unknown as JsonValue, SERVER_NOW).colonies[0]!;

  assert.equal(colony.lastSimulatedAtMs, null);
  const program = colony.pins.find((pin) => pin.pinID === 2)!.program!;
  assert.equal(program.expiresAtMs, null);

  // ⚠ AND THE OTHER SPELLING OF "NONE". EveJS's "never" on the wire is the
  // NUMBER 0, not null — a launchpad that has never launched carries "0". A
  // decoder that only guards against null lets 0 through, and 0 epoch ms is
  // January 1970 on screen. This assertion is the one that catches that; the
  // null case above passes even for a decoder that coerces 0.
  const zeroed = rawReport() as unknown as {
    colonies: { lastSimulatedAtMs: number; pins: { program: unknown }[] }[];
  };
  zeroed.colonies[0]!.lastSimulatedAtMs = 0;
  (zeroed.colonies[0]!.pins[1]!.program as { installedAtMs: number }).installedAtMs = 0;
  const fromZero = decodeColonyReport(zeroed as unknown as JsonValue, SERVER_NOW).colonies[0]!;
  assert.equal(fromZero.lastSimulatedAtMs, null);
  assert.equal(fromZero.pins.find((pin) => pin.pinID === 2)!.program!.installedAtMs, null);

  // A negative instant is nonsense the same way and must not survive either.
  const negative = rawReport() as unknown as { colonies: { lastSimulatedAtMs: number }[] };
  negative.colonies[0]!.lastSimulatedAtMs = -1;
  assert.equal(
    decodeColonyReport(negative as unknown as JsonValue, SERVER_NOW)
      .colonies[0]!.lastSimulatedAtMs,
    null,
  );
  // Null expiry is NOT "expired" — we simply do not know.
  assert.equal(programHasExpired(program, SERVER_NOW), false);
  assert.equal(programProgress(program, SERVER_NOW), null);
});

test("a pin's fill decodes in m³, where 0 is a fact and absent is not", () => {
  const colony = decoded().colonies[0]!;
  const byID = new Map(colony.pins.map((pin) => [pin.pinID, pin]));

  assert.equal(byID.get(6)!.usedM3, 60);
  assert.equal(byID.get(6)!.capacityM3, 12000);
  assert.equal(byID.get(5)!.usedM3, 855);
  assert.equal(byID.get(5)!.capacityM3, 10000);

  // ⚠ 0 IS AN ANSWER AND NULL IS NOT. An empty command centre really holds
  // 0 m³, and that must survive; a pin whose capacity the static table could
  // not give is null, because the panel divides by it.
  assert.equal(byID.get(1)!.usedM3, 0);
  assert.equal(byID.get(1)!.capacityM3, 500);
  assert.equal(byID.get(2)!.capacityM3, null);

  // A payload from before the BFF answered any of this decodes to null rather
  // than to 0 — an old server must not make every pin look empty.
  const raw = rawReport() as unknown as {
    colonies: { pins: Record<string, unknown>[] }[];
  };
  for (const pin of raw.colonies[0]!.pins) {
    delete pin.usedM3;
    delete pin.capacityM3;
  }
  const older = decodeColonyReport(raw as unknown as JsonValue, SERVER_NOW).colonies[0]!;
  assert.equal(older.pins.find((pin) => pin.pinID === 6)!.usedM3, null);
  assert.equal(older.pins.find((pin) => pin.pinID === 6)!.capacityM3, null);

  // Nonsense is not a volume either.
  const negative = rawReport() as unknown as {
    colonies: { pins: { usedM3: number }[] }[];
  };
  negative.colonies[0]!.pins[5]!.usedM3 = -1;
  const fromNegative = decodeColonyReport(negative as unknown as JsonValue, SERVER_NOW)
    .colonies[0]!;
  assert.equal(fromNegative.pins.find((pin) => pin.pinID === 6)!.usedM3, null);
});

test("a factory keeps what it makes, and an absent feed flag stays null", () => {
  const colony = decoded().colonies[0]!;
  const factory = colony.pins.find((pin) => pin.pinID === 4)!;

  assert.equal(factory.schematicName, "Superconductors");
  assert.equal(factory.schematicID, 65);
  assert.equal(factory.receivedInputsLastCycle, true);

  // ⚠ THREE STATES, NOT TWO. false means the emulator fed this factory nothing
  // last cycle — a real alarm. null means the pin has no such state at all,
  // which every extractor answers. Collapsing them starves every colony.
  const extractor = colony.pins.find((pin) => pin.pinID === 2)!;
  assert.equal(extractor.receivedInputsLastCycle, null);
  assert.equal(extractor.hasReceivedInputs, null);
  assert.equal(extractor.schematicID, null);

  const starved = rawReport() as unknown as {
    colonies: { pins: { pinID: number; receivedInputsLastCycle: boolean }[] }[];
  };
  starved.colonies[0]!.pins.find((pin) => pin.pinID === 4)!.receivedInputsLastCycle = false;
  const dry = decodeColonyReport(starved as unknown as JsonValue, SERVER_NOW).colonies[0]!;
  assert.equal(dry.pins.find((pin) => pin.pinID === 4)!.receivedInputsLastCycle, false);
  assert.equal(dry.pins.find((pin) => pin.pinID === 4)!.hasReceivedInputs, true);
});

test("links decode with their upgrade level beside the count", () => {
  const colony = decoded().colonies[0]!;

  assert.equal(colony.linkCount, 4);
  assert.deepEqual(colony.links, [
    { endpoint1: 1, endpoint2: 2, level: 0 },
    { endpoint1: 1, endpoint2: 4, level: 1 },
    { endpoint1: 4, endpoint2: 5, level: 0 },
    { endpoint1: 1, endpoint2: 6, level: 0 },
  ]);

  // A link missing an endpoint is not half a link — it is dropped, the way a
  // colony with no planetID is, rather than rendered as a link to pin 0.
  const broken = rawReport() as unknown as {
    colonies: { links: Record<string, unknown>[] }[];
  };
  delete broken.colonies[0]!.links[1]!.endpoint2;
  const kept = decodeColonyReport(broken as unknown as JsonValue, SERVER_NOW).colonies[0]!;
  assert.equal(kept.links.length, 3);
  // The count is the SERVER's own and is not recomputed from what survived.
  assert.equal(kept.linkCount, 4);
});

test("a summary counts what is there and when the next program runs out", () => {
  const colony = decoded().colonies[0]!;
  const summary = summarizeColony(colony, SERVER_NOW);

  assert.equal(summary.extractorCount, 2);
  assert.equal(summary.factoryCount, 1);
  assert.equal(summary.storageCount, 2);
  assert.equal(summary.runningProgramCount, 1);
  assert.equal(summary.expiredProgramCount, 1);
  assert.equal(summary.nextExpiryMs, SERVER_NOW + 21 * HOUR);
});

test("progress is clamped at both ends and never runs past the server's word", () => {
  const program = decoded().colonies[0]!.pins.find((pin) => pin.pinID === 2)!.program!;

  assert.equal(programProgress(program, program.installedAtMs!), 0);
  assert.equal(programProgress(program, program.expiresAtMs!), 1);
  // A page left open past the expiry must not draw a bar past full.
  assert.equal(programProgress(program, program.expiresAtMs! + 10 * HOUR), 1);
  // Nor a negative bar for a clock that thinks it is before the install.
  assert.equal(programProgress(program, program.installedAtMs! - HOUR), 0);
  // 3 of 24 hours in.
  assert.equal(
    Math.round(programProgress(program, SERVER_NOW)! * 100),
    13,
  );
});

test("commodities pool across pins, biggest pile first", () => {
  const colony = decoded().colonies[0]!;
  assert.deepEqual(
    pooledContents(colony).map((item) => [item.typeName, item.quantity]),
    [
      // 12000 in storage + 900 in the factory.
      ["Aqueous Liquids", 12900],
      ["Water", 4200],
      ["Bacteria", 300],
    ],
  );
});

test("pooling really SORTS — the biggest pile wins even when it is added last", () => {
  // ⚠ The fixture above happens to arrive in descending order already, so it
  // cannot tell a sort from an accident. This one arrives in the WORST order:
  // the smallest pile is on the first pin and the largest on the last.
  const colony = decoded().colonies[0]!;
  const scrambled = {
    ...colony,
    pins: [
      {
        ...colony.pins[0]!,
        contents: [{ typeID: BACTERIA, typeName: "Bacteria", quantity: 5 }],
      },
      {
        ...colony.pins[1]!,
        contents: [{ typeID: WATER, typeName: "Water", quantity: 50 }],
      },
      {
        ...colony.pins[2]!,
        contents: [{ typeID: AQUEOUS, typeName: "Aqueous Liquids", quantity: 9000 }],
      },
    ],
  };
  assert.deepEqual(
    pooledContents(scrambled).map((item) => item.typeName),
    ["Aqueous Liquids", "Water", "Bacteria"],
  );
});

test("a place is words, and an unnamed planet is still words — never an id", () => {
  const colony = decoded().colonies[0]!;
  assert.equal(colonyPlaceWords(colony), "Tanoo I");

  const unnamed = { ...colony, planetName: null };
  assert.equal(colonyPlaceWords(unnamed), "a planet in Tanoo");
  assert.ok(!colonyPlaceWords(unnamed).includes(String(PLANET_ID)));

  const nowhere = { ...colony, planetName: null, solarSystemName: null };
  assert.equal(colonyPlaceWords(nowhere), "a planet this map does not name");
  assert.ok(!colonyPlaceWords(nowhere).includes(String(PLANET_ID)));
});

test("durations are words a player reads, not milliseconds", () => {
  assert.equal(formatDuration(0), "under a minute");
  assert.equal(formatDuration(45_000), "under a minute");
  assert.equal(formatDuration(60_000), "1 minute");
  assert.equal(formatDuration(25 * 60_000), "25 minutes");
  assert.equal(formatDuration(2 * HOUR), "2 hours");
  assert.equal(formatDuration(7 * HOUR + 12 * 60_000), "7h 12m");
  assert.equal(formatDuration(48 * HOUR), "2 days");
  assert.equal(formatDuration(50 * HOUR), "2d 2h");
  // A negative span (a clock that slipped) reads as done, not as a huge number.
  assert.equal(formatDuration(-5 * HOUR), "under a minute");
});

test("a colony with no planetID is dropped rather than rendered as a blank row", () => {
  const raw = rawReport() as unknown as { colonies: { planetID: number }[] };
  raw.colonies[0]!.planetID = 0;
  assert.deepEqual(
    decodeColonyReport(raw as unknown as JsonValue, SERVER_NOW).colonies,
    [],
  );
});

test("a program carries the drill area it was installed with, for a restart to send back", () => {
  // The area sets how long the program runs, and the emulator refuses a
  // restart without a real one. An absent area is null, never a made-up number.
  const report = decodeColonyReport(rawReport(), SERVER_NOW);
  const pins = report.colonies[0]!.pins;
  assert.equal(pins.find((pin) => pin.pinID === 2)!.program!.headRadius, 0.012);
  assert.equal(pins.find((pin) => pin.pinID === 3)!.program!.headRadius, null);
});

// --- where an extractor's heads are -----------------------------------------
//
// What the planet is asked a programme's yield with (clientPlanet.InstallProgram): the BFF hands on the heads as
// the server has them and the unit's noise. A reading that lacks them, or has what is none, says so with null,
// and nothing may then guess.

function programOf(more: Record<string, JsonValue>) {
  const report = decodeColonyReport({ serverNowMs: SERVER_NOW, coloniesReadable: true, colonies: [{ planetID: PLANET_ID, pins: [{
    pinID: 7, typeID: 2848, kind: "extractor-control", contents: [],
    program: { resourceTypeID: AQUEOUS, cycleTimeSeconds: 900, quantityPerCycle: 471, headCount: 1, headRadius: 0.01, ...more },
  }], links: [], routes: [] }] } as JsonValue, SERVER_NOW);
  return report.colonies[0]!.pins[0]!.program!;
}

test("an extractor's heads and its noise are read as the BFF hands them on", () => {
  const program = programOf({ heads: [[0, 1.225, 1.225], [5, 1, 1.45]], noiseFactor: 0.8 });
  assert.deepEqual(program.heads, [[0, 1.225, 1.225], [5, 1, 1.45]]);
  assert.equal(program.noiseFactor, 0.8);
  assert.deepEqual(programOf({ heads: [], noiseFactor: 0 }).heads, []);
  assert.equal(programOf({ heads: [], noiseFactor: 0 }).noiseFactor, 0);
});

test("heads that are not said, or are not heads, are not known: null, never none", () => {
  assert.equal(programOf({}).heads, null);
  for (const heads of ["heads", null, [[0, 1.225]], [[0, 1.225, 1.225, 3]], [[0, "1.225", 1.225]], [[0, 1.225, "1.225"]], [[0, 1.2, null]], [[0, Number.NaN, 1.2]], [[0, 1.2, Number.POSITIVE_INFINITY]], [["0", 1.2, 1.2]], [[0.5, 1.2, 1.2]], [[-1, 1.2, 1.2]], [null], [[0, 1.2, 1.2], "more"]] as JsonValue[]) {
    assert.equal(programOf({ heads }).heads, null, JSON.stringify(heads));
  }
});

test("a noise that is not said, or is no number a noise can be, is not known", () => {
  assert.equal(programOf({}).noiseFactor, null);
  for (const noiseFactor of ["0.8", null, -0.1, [0.8]] as JsonValue[]) {
    assert.equal(programOf({ noiseFactor }).noiseFactor, null, JSON.stringify(noiseFactor));
  }
});
