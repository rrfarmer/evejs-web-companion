// R108 slice 3: the PI Manager's board, as a pure function of what was read.
//
// What is checked, and why each matters:
//
//   1. FOUR OUTCOMES, PER PILOT. Being read, could not be read, has not built,
//      and the server reported no colony table are four different facts. On a
//      board spanning pilots each is said about THAT pilot, never collapsed into
//      one message for the whole board.
//
//   2. EVERY ROW CARRIES ITS OWN AGE. Pilots are read at different moments; a
//      merged list says how old each row is and says when they differ.
//
//   3. A FAILED READ DOES NOT ERASE A GOOD ONE. The last reading stays on the
//      board, aged, beside the sentence saying the new one failed.
//
//   4. WORST FIRST ACROSS PILOTS, by the same rule one colony list uses.
//
//   5. NO NUMBER AS DATA (R7d), NO MACHINERY WORDS (R9a).

import test from "node:test";
import assert from "node:assert/strict";

import { buildPiBoard, piHaulDispatchWords, piHaulWords, pilotsByAccount, type PiBoardInput, type PilotAttempt } from "./piBoard.ts";
import type { PilotColonyReading } from "./piRoster.ts";
import type { Colony, ColonyPin } from "../store/types.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

const FARMER = 90000001;
const HAULER = 90000002;
const NEWBIE = 90000003;
const LOST = 90000004;

function pin(overrides: Partial<ColonyPin> & Pick<ColonyPin, "pinID" | "kind">): ColonyPin {
  return {
    typeID: 2848,
    typeName: "Barren Extractor Control Unit",
    contents: [],
    usedM3: 0,
    capacityM3: null,
    schematicID: null,
    schematicName: null,
    hasReceivedInputs: null,
    receivedInputsLastCycle: null,
    lastRunAtMs: NOW - MINUTE,
    lastLaunchAtMs: null,
    program: null,
    ...overrides,
  };
}

function extractor(pinID: number, expiresAtMs: number): ColonyPin {
  return pin({
    pinID,
    kind: "extractor-control",
    program: {
      resourceTypeID: 2268,
      resourceTypeName: "Aqueous Liquids",
      cycleTimeSeconds: 7200,
      quantityPerCycle: 4591,
      installedAtMs: expiresAtMs - 48 * HOUR,
      expiresAtMs,
      headCount: 7,
    },
  });
}

function colony(planetID: number, planetName: string | null, pins: readonly ColonyPin[]): Colony {
  return {
    planetID,
    planetName,
    solarSystemID: 30000001,
    solarSystemName: "Alpha",
    planetTypeID: 2016,
    planetTypeName: "Planet (Barren)",
    commandCenterLevel: 5,
    lastSimulatedAtMs: NOW - MINUTE,
    pins,
    linkCount: 0,
    links: [],
    routes: [],
  };
}

function reading(
  characterID: number,
  colonies: readonly Colony[],
  readAtMs: number | null,
  coloniesReadable = true,
): PilotColonyReading {
  return { characterID, readAtMs, report: { colonies, coloniesReadable, clockOffsetMs: 0 } };
}

function input(overrides: Partial<PiBoardInput> = {}): PiBoardInput {
  return {
    members: [FARMER, HAULER, NEWBIE],
    names: new Map([[FARMER, "Ada Farmer"], [HAULER, "Bo Hauler"], [NEWBIE, "Cy Newbie"]]),
    readings: new Map(),
    attempts: new Map(),
    browserNowMs: NOW,
    ...overrides,
  };
}

const QUIET = colony(40000002, "Alpha I", [extractor(2, NOW + 30 * HOUR)]);
const STOPPED = colony(40000004, "Alpha II", [extractor(2, NOW - HOUR)]);
const STARVED = colony(40000006, "Alpha III", [
  extractor(2, NOW + 30 * HOUR),
  pin({ pinID: 4, kind: "factory", schematicID: 121, schematicName: "Water", receivedInputsLastCycle: false }),
]);
const COMING_UP = colony(40000008, "Alpha IV", [extractor(2, NOW + 2 * HOUR)]);

test("a roster nobody has read yet says so per pilot, and offers no colonies", () => {
  const board = buildPiBoard(input());
  assert.deepEqual(board.pilots.map((pilot) => pilot.noteWords), [
    "Not looked at yet.",
    "Not looked at yet.",
    "Not looked at yet.",
  ]);
  assert.deepEqual(board.colonies, []);
  assert.deepEqual(board.needsYou, []);
});

test("⚠ the four outcomes are told apart, and told about the right pilot", () => {
  const attempts = new Map<number, PilotAttempt>([
    [FARMER, "reading"],
    [HAULER, "failed"],
  ]);
  const board = buildPiBoard(input({
    members: [FARMER, HAULER, NEWBIE, LOST],
    attempts,
    readings: new Map([
      [NEWBIE, reading(NEWBIE, [], NOW - MINUTE)],
      [LOST, reading(LOST, [], NOW - MINUTE, false)],
    ]),
    names: new Map([[FARMER, "Ada Farmer"], [HAULER, "Bo Hauler"], [NEWBIE, "Cy Newbie"], [LOST, "Di Lost"]]),
  }));
  assert.deepEqual(board.pilots.map((pilot) => pilot.noteWords), [
    "Looking at Ada Farmer's colonies...",
    "Bo Hauler's colonies could not be read just now.",
    "Cy Newbie has not built on a planet yet.",
    "The server did not report colony information for Di Lost. That is not the same as having none.",
  ]);
  assert.equal(board.pilots[0]!.busy, true);
  assert.equal(board.pilots[1]!.busy, false);
});

test("a pilot no longer in the hangar is named as such, never by number", () => {
  const board = buildPiBoard(input({
    members: [FARMER],
    names: new Map(),
    attempts: new Map([[FARMER, "no-account"]]),
  }));
  const [pilot] = board.pilots;
  assert.equal(pilot!.pilotName, "A pilot no longer in the hangar");
  assert.equal(
    pilot!.noteWords,
    "This pilot is no longer in the hangar, so there is no account to read with.",
  );
  assert.doesNotMatch(`${pilot!.pilotName} ${pilot!.noteWords}`, new RegExp(String(FARMER)));
});

test("an unanswered pilot reads as a failed read, not as 'has not built'", () => {
  const board = buildPiBoard(input({ members: [HAULER], attempts: new Map([[HAULER, "unanswered"]]) }));
  assert.equal(board.pilots[0]!.noteWords, "Bo Hauler's colonies could not be read just now.");
});

test("⚠ a failed read keeps the last good reading on the board, aged", () => {
  const board = buildPiBoard(input({
    members: [FARMER],
    attempts: new Map([[FARMER, "failed"]]),
    readings: new Map([[FARMER, reading(FARMER, [QUIET], NOW - 3 * HOUR)]]),
  }));
  assert.equal(board.pilots[0]!.noteWords, "Ada Farmer's colonies could not be read just now.");
  assert.equal(board.colonies.length, 1);
  assert.equal(board.colonies[0]!.readAgeWords, "Read 3 hours ago");
});

test("every colony row carries its pilot, its place, its line and its own age", () => {
  const board = buildPiBoard(input({
    readings: new Map([
      [FARMER, reading(FARMER, [QUIET], NOW - 2 * MINUTE)],
      [HAULER, reading(HAULER, [colony(40000010, null, [])], NOW - 90 * MINUTE)],
    ]),
  }));
  assert.deepEqual(
    board.colonies.map((row) => [row.pilotName, row.placeWords, row.stateWords, row.readAgeWords]),
    [
      ["Ada Farmer", "Alpha I", "Extracting — next program ends in 1d 6h", "Read 2 minutes ago"],
      ["Bo Hauler", "a planet in Alpha", "No extractors here yet", "Read 1h 30m ago"],
    ],
  );
  // Keys are unique across pilots, for a keyed each; they are never printed.
  assert.equal(new Set(board.colonies.map((row) => row.key)).size, 2);
});

test("a reading with no instant says its age is unknown rather than inventing one", () => {
  const board = buildPiBoard(input({
    members: [FARMER],
    readings: new Map([[FARMER, reading(FARMER, [QUIET], null)]]),
  }));
  assert.equal(board.colonies[0]!.readAgeWords, "Read at an unknown time");
});

test("the age is judged on the server's clock, not the browser's", () => {
  const skewed: PilotColonyReading = {
    characterID: FARMER,
    readAtMs: NOW - 10 * MINUTE,
    // The browser is five minutes slow, so the server's now is NOW + 5m, and a
    // read stamped NOW - 10m on the server's clock is fifteen minutes old.
    report: { colonies: [QUIET], coloniesReadable: true, clockOffsetMs: 5 * MINUTE },
  };
  const board = buildPiBoard(input({ members: [FARMER], readings: new Map([[FARMER, skewed]]) }));
  assert.equal(board.colonies[0]!.readAgeWords, "Read 15 minutes ago");
});

test("⚠ worst first ACROSS pilots, and quiet colonies after every noisy one", () => {
  const board = buildPiBoard(input({
    readings: new Map([
      [FARMER, reading(FARMER, [QUIET, COMING_UP], NOW - MINUTE)],
      [HAULER, reading(HAULER, [STARVED], NOW - MINUTE)],
      [NEWBIE, reading(NEWBIE, [STOPPED], NOW - MINUTE)],
    ]),
  }));
  assert.deepEqual(board.colonies.map((row) => row.placeWords), ["Alpha II", "Alpha III", "Alpha IV", "Alpha I"]);
  assert.deepEqual(board.colonies.map((row) => row.needsYouNow), [true, true, false, false]);

  // The "needs you" list holds only what has something to say, worst first,
  // each line naming the pilot whose colony it is.
  assert.deepEqual(
    board.needsYou.map((item) => [item.pilotName, item.placeWords, item.urgency]),
    [
      ["Cy Newbie", "Alpha II", "now"],
      ["Bo Hauler", "Alpha III", "now"],
      ["Ada Farmer", "Alpha IV", "soon"],
    ],
  );
  assert.equal(board.needsYou[0]!.words, "1 extractor has finished its program");
  assert.equal(board.needsYou[1]!.words, "1 factory has nothing coming in");
  // Coming up has no "now" sentence, so it is told in the finding's own words.
  assert.match(board.needsYou[2]!.words, /Aqueous Liquids/);
});

test("readings from different moments say so, with the oldest age", () => {
  const apart = buildPiBoard(input({
    readings: new Map([
      [FARMER, reading(FARMER, [QUIET], NOW - 2 * MINUTE)],
      [HAULER, reading(HAULER, [STOPPED], NOW - 4 * HOUR)],
    ]),
  }));
  assert.equal(apart.staleWords, "Read at different times; the oldest is 4 hours old.");

  // Read together (inside a minute of each other): nothing to warn about.
  const together = buildPiBoard(input({
    readings: new Map([
      [FARMER, reading(FARMER, [QUIET], NOW - 2 * MINUTE)],
      [HAULER, reading(HAULER, [STOPPED], NOW - 2 * MINUTE - 20_000)],
    ]),
  }));
  assert.equal(together.staleWords, null);
});

test("the whole-board sentences: nobody assigned, and nobody has built", () => {
  assert.equal(
    buildPiBoard(input({ members: [] })).emptyWords,
    "No pilots are on planetary industry yet. Add one below.",
  );
  const nobodyBuilt = buildPiBoard(input({
    members: [FARMER, HAULER],
    readings: new Map([
      [FARMER, reading(FARMER, [], NOW - MINUTE)],
      [HAULER, reading(HAULER, [], NOW - MINUTE)],
    ]),
  }));
  assert.equal(nobodyBuilt.emptyWords, "None of your pilots has built on a planet yet.");
  // One unread pilot means we do not know that yet.
  const unsure = buildPiBoard(input({
    members: [FARMER, HAULER],
    readings: new Map([[FARMER, reading(FARMER, [], NOW - MINUTE)]]),
  }));
  assert.equal(unsure.emptyWords, null);
});

test("no machinery words and no bare ids anywhere a player reads", () => {
  const board = buildPiBoard(input({
    readings: new Map([
      [FARMER, reading(FARMER, [QUIET, STOPPED], NOW - MINUTE)],
      [HAULER, reading(HAULER, [STARVED], NOW - 2 * HOUR)],
    ]),
    attempts: new Map([[NEWBIE, "failed"]]),
  }));
  const printed = JSON.stringify({
    pilots: board.pilots.map(({ pilotName, noteWords, readAgeWords }) => ({ pilotName, noteWords, readAgeWords })),
    colonies: board.colonies.map(({ pilotName, placeWords, stateWords, readAgeWords }) =>
      ({ pilotName, placeWords, stateWords, readAgeWords })),
    needsYou: board.needsYou.map(({ pilotName, placeWords, words }) => ({ pilotName, placeWords, words })),
    staleWords: board.staleWords,
  });
  assert.doesNotMatch(printed, /\d{5,}/, "no id-length number");
  assert.doesNotMatch(printed, /schematic|\bpin\b|\bECU\b|characterID|planetID/i);
  // And the sweep does catch an id when one is there.
  assert.match(JSON.stringify({ x: `${FARMER}` }), /\d{5,}/);
});

test("the board judges a starved factory by its recipe when it has the table", async () => {
  const { decodeRecipeBook } = await import("./piRecipes.ts");
  const recipes = decodeRecipeBook({
    schematics: [{
      schematicID: 121,
      name: "Water",
      cycleTimeSeconds: 1800,
      factoryTypeIDs: [2473],
      inputs: [{ typeID: 2268, quantity: 3000, typeName: "Aqueous Liquids" }],
      output: { typeID: 3645, quantity: 20, typeName: "Water" },
    }],
  } as never);
  // Unfed last cycle and holding a full batch: the recipe says it has what it
  // needs. Without the table its inputs are what its routes bring, and one of
  // them (contrived: a commodity Water does not take) comes from an empty
  // storage - dead supply. Wired in and out for Water itself, so the game's
  // own routing rules have nothing to say either way.
  const stocked = {
    ...colony(40000012, "Alpha V", [
      pin({ pinID: 3, kind: "storage" }),
      pin({ pinID: 5, kind: "launchpad" }),
      pin({
        pinID: 4,
        kind: "factory",
        schematicID: 121,
        schematicName: "Water",
        receivedInputsLastCycle: false,
        contents: [{ typeID: 2268, typeName: "Aqueous Liquids", quantity: 3000 }],
      }),
    ]),
    routes: [
      { routeID: 1, path: [3, 4], commodityTypeID: 2268, commodityTypeName: null, commodityQuantity: 3000 },
      { routeID: 2, path: [4, 5], commodityTypeID: 3645, commodityTypeName: null, commodityQuantity: 20 },
      { routeID: 3, path: [3, 4], commodityTypeID: 2393, commodityTypeName: null, commodityQuantity: 3000 },
    ],
  };
  const readings = new Map([[FARMER, reading(FARMER, [stocked], NOW - MINUTE)]]);
  assert.equal(buildPiBoard(input({ members: [FARMER], readings })).needsYou.length, 1);
  assert.deepEqual(buildPiBoard(input({ members: [FARMER], readings, recipes })).needsYou, []);
});

// --- R108 slice 4: dispatch ---------------------------------------------------

test("a pilot with ended extractors is offered a restart, with what it does said first", () => {
  const board = buildPiBoard(input({
    members: [FARMER, HAULER],
    readings: new Map([
      [FARMER, reading(FARMER, [STOPPED, colony(40000014, "Alpha VI", [extractor(3, NOW - 2 * HOUR), extractor(4, NOW - HOUR)])], NOW - MINUTE)],
      [HAULER, reading(HAULER, [QUIET], NOW - MINUTE)],
    ]),
  }));
  const [farmer, hauler] = board.pilots;
  assert.deepEqual(farmer!.restart, {
    enabled: true,
    label: "Restart 3 extractors",
    words: "3 extractors have ended on 2 colonies. This starts a server run for Ada Farmer that restarts every ended extractor on all of its colonies, re-sizes the storage routes of any extractor that yields more than they carry, then stops. It changes nothing else and runs for an hour at most.",
  });
  // A pilot with nothing ended is offered nothing.
  assert.equal(hauler!.restart, null);
});

test("⚠ a pilot a server bot is already flying is not offered a start", () => {
  const board = buildPiBoard(input({
    members: [FARMER],
    readings: new Map([[FARMER, reading(FARMER, [STOPPED], NOW - MINUTE)]]),
    activeBots: new Set([FARMER]),
  }));
  const [farmer] = board.pilots;
  assert.equal(farmer!.restart!.enabled, false);
  assert.equal(farmer!.botWords, "A server bot is flying this pilot now.");
});

test("no start while the pilot is being read, or while a start is on its way", () => {
  const readings = new Map([[FARMER, reading(FARMER, [STOPPED], NOW - MINUTE)]]);
  const reading_ = buildPiBoard(input({ members: [FARMER], readings, attempts: new Map([[FARMER, "reading"]]) }));
  assert.equal(reading_.pilots[0]!.restart!.enabled, false);
  const starting = buildPiBoard(input({ members: [FARMER], readings, dispatch: new Map([[FARMER, { kind: "starting" }]]) }));
  assert.equal(starting.pilots[0]!.restart!.enabled, false);
  assert.equal(starting.pilots[0]!.dispatchWords, "Starting the run on the server...");
});

test("what a start did is said on the pilot's row, a refusal in the server's own words", () => {
  const readings = new Map([[FARMER, reading(FARMER, [STOPPED], NOW - MINUTE)]]);
  const started = buildPiBoard(input({ members: [FARMER], readings, dispatch: new Map([[FARMER, { kind: "started" }]]) }));
  assert.equal(
    started.pilots[0]!.dispatchWords,
    "The run has started on the server. Refresh once it has finished to see the extractors running.",
  );
  const inUse = "A web session is flying this character. Log it out (or wait for it to expire), then start the bot.";
  const refused = buildPiBoard(input({ members: [FARMER], readings, dispatch: new Map([[FARMER, { kind: "refused", sentence: inUse }]]) }));
  assert.equal(refused.pilots[0]!.dispatchWords, inUse);
  // Refused is not final: the button is offered again.
  assert.equal(refused.pilots[0]!.restart!.enabled, true);
});

test("an extractor with no program is not offered: the macro has no resource to restart it on", () => {
  // restart-extractors reuses the resource an extractor last pulled and never
  // guesses, so offering it here would start a run that does nothing.
  const idle = colony(40000016, "Alpha VII", [pin({ pinID: 2, kind: "extractor-control", program: null })]);
  const board = buildPiBoard(input({ members: [FARMER], readings: new Map([[FARMER, reading(FARMER, [idle], NOW - MINUTE)]]) }));
  assert.equal(board.pilots[0]!.restart, null);
});

test("a program that states no end is one the macro restarts, so it is offered", () => {
  // restart-extractors treats a program with no expiry as never having run,
  // and restarts it on its known resource.
  const undated = extractor(2, NOW);
  const colonyWithUndated = colony(40000018, "Alpha VIII", [
    { ...undated, program: { ...undated.program!, expiresAtMs: null } },
  ]);
  const board = buildPiBoard(input({
    members: [FARMER],
    readings: new Map([[FARMER, reading(FARMER, [colonyWithUndated], NOW - MINUTE)]]),
  }));
  assert.match(board.pilots[0]!.restart!.words, /^1 extractor has ended on 1 colony\./);
});

test("colonies are grouped by pilot, the pilot with the worst colony first", () => {
  const board = buildPiBoard(input({
    readings: new Map([
      [FARMER, reading(FARMER, [QUIET, COMING_UP], NOW - MINUTE)],
      [NEWBIE, reading(NEWBIE, [STOPPED], NOW - MINUTE)],
    ]),
  }));
  assert.deepEqual(
    board.groups.map((group) => [group.pilotName, group.countWords, group.rows.map((row) => row.placeWords)]),
    [
      ["Cy Newbie", "1 colony, Alpha", ["Alpha II"]],
      ["Ada Farmer", "2 colonies, Alpha", ["Alpha IV", "Alpha I"]],
    ],
  );
  assert.equal(board.groups[0]!.readAgeWords, "Read 1 minute ago");
});

test("a colony row says its kind, what it pulls, how far its program is, and its tone", () => {
  const board = buildPiBoard(input({
    readings: new Map([[FARMER, reading(FARMER, [QUIET, STOPPED, COMING_UP], NOW - MINUTE)]]),
  }));
  const byPlace = new Map(board.colonies.map((row) => [row.placeWords, row]));
  const quiet = byPlace.get("Alpha I")!;
  assert.equal(quiet.kindWords, "Barren - CC 5");
  assert.deepEqual(quiet.resources, ["Aqueous Liquids"]);
  assert.equal(quiet.tone, "ok");
  assert.equal(quiet.statusWords, "Ends in 1d 6h");
  // 18 of its 48 hours are gone.
  assert.equal(quiet.program!.ended, false);
  assert.ok(Math.abs(quiet.program!.fraction - 18 / 48) < 1e-9);

  const stopped = byPlace.get("Alpha II")!;
  assert.equal(stopped.tone, "stopped");
  assert.deepEqual(stopped.program, { fraction: 1, ended: true });
  assert.equal(stopped.statusWords, "1 extractor has finished its program");

  assert.equal(byPlace.get("Alpha IV")!.tone, "soon");
});

test("storage is the fullest hold, rounded down, and high from 80%", () => {
  const holds = colony(40000010, "Alpha V", [
    pin({ pinID: 3, kind: "storage", usedM3: 2000, capacityM3: 12000 }),
    pin({ pinID: 4, kind: "launchpad", usedM3: 8199, capacityM3: 10000 }),
  ]);
  const board = buildPiBoard(input({ readings: new Map([[FARMER, reading(FARMER, [holds, QUIET], NOW - MINUTE)]]) }));
  const row = board.colonies.find((candidate) => candidate.placeWords === "Alpha V")!;
  assert.equal(row.storage!.words, "Storage 81% full");
  assert.equal(row.storage!.high, true);
  assert.equal(row.program, null, "no extractor, no program bar");
  // A colony whose holds state no fill has no storage bar at all.
  assert.equal(board.colonies.find((candidate) => candidate.placeWords === "Alpha I")!.storage, null);
});

test("the strip counts colonies, those extracting, those that need you, and the next end", () => {
  const board = buildPiBoard(input({
    readings: new Map([[FARMER, reading(FARMER, [QUIET, STOPPED, COMING_UP], NOW - MINUTE)]]),
  }));
  assert.deepEqual(board.summary, { colonies: 3, extracting: 2, needYouNow: 1, nextEndsWords: "2 hours" });
});

test("the roster groups by account, and folds only a pilot read with no colony", () => {
  const board = buildPiBoard(input({
    members: [FARMER, HAULER, NEWBIE, LOST],
    attempts: new Map([[HAULER, "failed"]]),
    readings: new Map([
      [FARMER, reading(FARMER, [QUIET], NOW - MINUTE)],
      [NEWBIE, reading(NEWBIE, [], NOW - MINUTE)],
      [LOST, reading(LOST, [], NOW - MINUTE, false)],
    ]),
    names: new Map([[FARMER, "Ada Farmer"], [HAULER, "Bo Hauler"], [NEWBIE, "Cy Newbie"], [LOST, "Di Lost"]]),
  }));
  // Only a readable, empty colony table folds. "Could not be read" and "the
  // server did not say" are not "has none", so they keep their rows.
  assert.deepEqual(board.pilots.map((pilot) => pilot.notBuilt), [false, false, true, false]);

  const groups = pilotsByAccount(board.pilots, new Map([
    [FARMER, "beta"],
    [NEWBIE, "beta"],
    [LOST, "alpha"],
  ]));
  assert.deepEqual(
    groups.map((group) => ({
      accountName: group.accountName,
      rows: group.rows.map((pilot) => pilot.pilotName),
      notBuilt: group.notBuilt.map((pilot) => pilot.pilotName),
      colonyCount: group.colonyCount,
      readAgeWords: group.readAgeWords,
    })),
    [
      { accountName: "alpha", rows: ["Di Lost"], notBuilt: [], colonyCount: 0, readAgeWords: "Read 1 minute ago" },
      { accountName: "beta", rows: ["Ada Farmer"], notBuilt: ["Cy Newbie"], colonyCount: 1, readAgeWords: "Read 1 minute ago" },
      // An account nobody knows any more goes last, and has no one age.
      { accountName: null, rows: ["Bo Hauler"], notBuilt: [], colonyCount: 0, readAgeWords: null },
    ],
  );
});

// ── The Haul button's words (the customs-office export) ──────────────────────

test("the Haul offer says the launchpads go into the customs offices", () => {
  const { label, words } = piHaulWords("Ada Farmer", 2, "Industry", null);
  assert.equal(label, "Haul 2 colonies");
  assert.match(words, /launchpads hold up into their customs offices/);
  assert.match(words, /server run for Ada Farmer/);
  assert.match(words, /empties those customs offices/);
  assert.match(words, /the corporation's Industry/);
  // Both ways off a colony are said, because the lap does both.
  assert.match(words, /launches what their command centres hold/);
  assert.match(words, /collects the launches/);
});

test("a started haul says what went up before it says the run began", () => {
  const words = piHaulDispatchWords({
    kind: "started",
    exported: { units: 370, colonies: 2, refusals: [] },
  });
  assert.equal(
    words,
    "Launched 370 units from 2 colonies into their customs offices. The haul has started on the server. Its steps show in the Bot Manager.",
  );
});

test("⚠ a colony the server refused is named, and the haul still started", () => {
  const words = piHaulDispatchWords({
    kind: "started",
    exported: { units: 40, colonies: 1, refusals: ["Alpha IX: CannotLaunchCommoditiesNotFound"] },
  });
  assert.match(words ?? "", /Alpha IX: CannotLaunchCommoditiesNotFound/);
  assert.match(words ?? "", /The haul has started/);
});

test("an empty set of launchpads is said plainly, not as a failure", () => {
  const words = piHaulDispatchWords({ kind: "started", exported: { units: 0, colonies: 0, refusals: [] } });
  assert.match(words ?? "", /^Nothing was on the launchpads, so nothing new went up\./);
});

test("a restart's start carries no export sentence", () => {
  assert.equal(piHaulDispatchWords({ kind: "started" }), "The haul has started on the server. Its steps show in the Bot Manager.");
});

test("a haul whose run sends the launchpads up itself says so, and not that nothing was on them", () => {
  const words = piHaulDispatchWords({ kind: "started", exported: { units: 0, colonies: 0, refusals: [], atTheOffices: true } });
  assert.equal(words, "The haul has started on the server. It sends each colony's launchpads up at its customs office. Its steps show in the Bot Manager.");
});
