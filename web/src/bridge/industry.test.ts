// Goal R15: decoding the industry reads into named blueprints, jobs and
// facilities.
//
// The properties worth pinning here are the ones that would fail SILENTLY in
// front of a player:
//
//   - the blueprint read is a 2-TUPLE, not a list;
//   - material efficiency and time efficiency are distinct fields (a
//     transposition looks plausible and is wrong);
//   - the location choices hide their fields in header[2], not `dict`;
//   - an unknown activityID decodes to null rather than leaking the number;
//   - material efficiency applies to MANUFACTURING only.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVITY_LABELS,
  ACTIVITY_ORDER,
  MOST_COPIES_A_JOB,
  MOST_INVENTIONS_A_JOB,
  STATUS_LABELS,
  activityIDOf,
  activityIsFor,
  activityOfID,
  decodeBlueprints,
  decodeDefinition,
  decodeFacilities,
  decodeFacilityLocations,
  decodeJob,
  decodeJobs,
  decodeSlotUsage,
  formatDuration,
  decodeJobFee,
  decodeJobMaterials,
  jobFeeParts,
  materialsToUse,
  industryRefusalMessage,
  inventionChoices,
  isActiveJob,
  jobAsChosen,
  jobCannotBeAsked,
  matchesIndustryFilter,
  mostRunsToAsk,
  previewMaterials,
  previewTimeSeconds,
  recipeFor,
  researchStanding,
  secondsUntil,
} from "./industry.ts";
import type { JsonValue } from "./wire.ts";

test("Industry filters match an exact blueprint item ID or the joined retail row text", () => {
  const fields = ["Antimatter Charge S Blueprint", "Jita IV", "Test Pilot"];
  assert.equal(matchesIndustryFilter(" +07100000001 ", 7_100_000_001, fields), true);
  assert.equal(matchesIndustryFilter("710000000", 7_100_000_001, fields), false);
  assert.equal(matchesIndustryFilter("7100000001", 7_100_000_002, fields), false);
  assert.equal(matchesIndustryFilter(" blueprintjita ivtest ", 7_100_000_001, fields), true);
});

// --- fixtures ---------------------------------------------------------------

function keyVal(fields: Record<string, JsonValue>): JsonValue {
  return {
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries: Object.entries(fields) },
  } as unknown as JsonValue;
}

function list(items: readonly JsonValue[]): JsonValue {
  return { type: "list", items } as unknown as JsonValue;
}

function dict(entries: readonly (readonly [JsonValue, JsonValue])[]): JsonValue {
  return { type: "dict", entries } as unknown as JsonValue;
}

function long(value: string): JsonValue {
  return { type: "long", value } as unknown as JsonValue;
}

/** An industry.Location, with its fields where buildObjectEx1 really puts
 * them: header[2], NOT the (empty) top-level `dict`. */
function locationObject(fields: Record<string, JsonValue>): JsonValue {
  return {
    type: "objectex1",
    header: [
      { type: "token", value: "industry.Location" },
      [],
      { type: "dict", entries: Object.entries(fields) },
    ],
    list: [],
    dict: [],
  } as unknown as JsonValue;
}

const BLUEPRINT_ROW = keyVal({
  typeID: 681,
  itemID: 7_100_000_001,
  timeEfficiency: 20,
  materialEfficiency: 10,
  runs: 40,
  locationID: 60003760,
  facilityID: null,
  ownerID: 7,
  jobID: null,
  original: false,
  solarSystemID: 30000142,
});

const JOB_ROW = keyVal({
  activityID: 1,
  jobID: 4_200_001,
  blueprintID: 7_100_000_001,
  blueprintTypeID: 681,
  facilityID: 60003760,
  solarSystemID: 30000142,
  ownerID: 7,
  status: 3,
  runs: 3,
  successfulRuns: 0,
  cost: 1250,
  timeInSeconds: 1800,
  productTypeID: 165,
  startDate: long("133000000000000000"),
  endDate: long("133000000018000000"),
});

// --- blueprints -------------------------------------------------------------

test("the blueprint read is a 2-TUPLE; only the first element holds the rows", () => {
  const result = [list([BLUEPRINT_ROW]), dict([[60003760, 1]])] as unknown as JsonValue;
  const rows = decodeBlueprints(result);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.itemID, 7_100_000_001);
  assert.equal(rows[0]!.typeID, 681);
});

test("reading the tuple as a plain list yields nothing (the shape trap)", () => {
  // The list ALONE, without the tuple wrapper, is what a naive decoder assumes.
  assert.deepEqual(decodeBlueprints(list([BLUEPRINT_ROW])), []);
});

test("material efficiency and time efficiency are NOT transposed", () => {
  const rows = decodeBlueprints([list([BLUEPRINT_ROW]), dict([])] as unknown as JsonValue);
  assert.equal(rows[0]!.materialEfficiency, 10);
  assert.equal(rows[0]!.timeEfficiency, 20);
  assert.equal(rows[0]!.runs, 40);
  assert.equal(rows[0]!.original, false);
});

test("R109: a blueprint carries the system it sits in, and 0 reads as unstated", () => {
  const rows = decodeBlueprints([list([BLUEPRINT_ROW]), dict([])] as unknown as JsonValue);
  assert.equal(rows[0]!.solarSystemID, 30000142);
  const nowhere = keyVal({ ...fieldsOf(BLUEPRINT_ROW), solarSystemID: 0 });
  assert.equal(decodeBlueprints([list([nowhere]), dict([])] as unknown as JsonValue)[0]!.solarSystemID, null);
});

test("a blueprint locked into a job carries that job; a free one carries null", () => {
  const busy = keyVal({ ...fieldsOf(BLUEPRINT_ROW), jobID: 4_200_001 });
  const rows = decodeBlueprints([list([BLUEPRINT_ROW, busy]), dict([])] as unknown as JsonValue);
  assert.equal(rows[0]!.jobID, null);
  assert.equal(rows[1]!.jobID, 4_200_001);
});

/** Pull the plain field map back out of a util.KeyVal fixture. */
function fieldsOf(row: JsonValue): Record<string, JsonValue> {
  const entries = (row as unknown as { args: { entries: [string, JsonValue][] } }).args.entries;
  return Object.fromEntries(entries);
}

// --- jobs -------------------------------------------------------------------

test("a job decodes to activity + status NAMES, never their numbers", () => {
  const job = decodeJob(JOB_ROW)!;
  assert.equal(job.activity, "manufacturing");
  assert.equal(job.status, "ready");
  assert.equal(job.productTypeID, 165);
  assert.equal(job.runs, 3);
  assert.equal(job.cost, 1250);
  // The job's own solar system, which the client sends back with a delivery or a stop (industrySvc.py 150, 160).
  assert.equal(job.solarSystemID, 30000142);
  assert.equal(decodeJob(keyVal({ jobID: 9, status: 1 }))!.solarSystemID, 0);
  // FILETIME longs survive as bigints, not lossy numbers.
  assert.equal(job.startDate, 133000000000000000n);
  assert.equal(job.endDate, 133000000018000000n);
});

test("every status code maps to a label, and active jobs are the unfinished ones", () => {
  const byCode: Record<number, string> = {
    0: "unsubmitted",
    1: "running",
    2: "paused",
    3: "ready",
    100: "completed",
    101: "delivered",
    102: "cancelled",
    103: "reverted",
  };
  for (const [code, expected] of Object.entries(byCode)) {
    const job = decodeJob(keyVal({ ...fieldsOf(JOB_ROW), status: Number(code) }))!;
    assert.equal(job.status, expected);
    assert.ok(STATUS_LABELS[job.status], `${expected} must have a player-facing label`);
  }
  assert.equal(isActiveJob("running"), true);
  assert.equal(isActiveJob("ready"), true);
  assert.equal(isActiveJob("paused"), true);
  assert.equal(isActiveJob("delivered"), false);
  assert.equal(isActiveJob("cancelled"), false);
});

test("an unknown activityID decodes to null rather than leaking the number", () => {
  // 2, 6 and 7 are gaps in the activity table.
  const job = decodeJob(keyVal({ ...fieldsOf(JOB_ROW), activityID: 6 }))!;
  assert.equal(job.activity, null);
  assert.equal(activityOfID(6), null);
});

test("a row with no jobID is not a job", () => {
  assert.equal(decodeJob(keyVal({ jobID: 0 })), null);
  assert.deepEqual(decodeJobs(list([keyVal({ jobID: 0 })])), []);
});

test("job slot usage is keyed by activity NAME", () => {
  const usage = decodeSlotUsage(dict([[1, 2], [5, 1], [6, 9]]));
  assert.deepEqual(usage, { manufacturing: 2, copying: 1 });
  // The unknown activity 6 is dropped, not surfaced as a number.
});

// --- facilities -------------------------------------------------------------

test("a facility decodes its supported activities to NAMES, in render order", () => {
  const row = keyVal({
    facilityID: 60003760,
    typeID: 52678,
    ownerID: 1000035,
    tax: 0.01,
    solarSystemID: 30000142,
    online: true,
    activities: dict([
      [5, { type: "tuple", items: [] } as unknown as JsonValue],
      [1, { type: "tuple", items: [] } as unknown as JsonValue],
    ]),
  });
  const facilities = decodeFacilities(list([row]));
  assert.equal(facilities.length, 1);
  assert.deepEqual(facilities[0]!.activities, ["manufacturing", "copying"]);
  assert.equal(facilities[0]!.tax, 0.01);
  assert.equal(facilities[0]!.online, true);
});

test("a facility with no `online` field counts as online", () => {
  const facilities = decodeFacilities(list([keyVal({ facilityID: 60003760 })]));
  assert.equal(facilities[0]!.online, true);
});

test("location choices read their fields from header[2], not the empty `dict`", () => {
  const result = list([
    locationObject({
      itemID: 60003760,
      typeID: 52678,
      ownerID: 7,
      flagID: 4,
      solarSystemID: 30000142,
      canView: true,
      canTake: true,
    }),
    locationObject({ itemID: 60003760, flagID: 62, ownerID: 7, canTake: false, canView: true }),
  ]);
  const choices = decodeFacilityLocations(result);
  assert.equal(choices.length, 2);
  assert.equal(choices[0]!.itemID, 60003760);
  assert.equal(choices[0]!.flagID, 4);
  assert.equal(choices[0]!.canTake, true);
  // The take permission is what decides whether a hangar may be an INPUT.
  assert.equal(choices[1]!.canTake, false);
});

// --- static definitions -----------------------------------------------------

const RAW_DEFINITION = {
  blueprintTypeID: 681,
  blueprintName: "Clone Grade Beta Blueprint",
  productTypeID: 165,
  productName: "Clone Grade Beta",
  maxProductionLimit: 300,
  activities: {
    manufacturing: {
      materials: [{ typeID: 38, quantity: 86 }],
      products: [{ typeID: 165, quantity: 1 }],
      time: 600,
    },
    copying: { time: 480 },
    research_material: { time: 210 },
  },
};

test("a definition decodes only the activities the blueprint actually has", () => {
  const definition = decodeDefinition(RAW_DEFINITION)!;
  assert.equal(definition.blueprintName, "Clone Grade Beta Blueprint");
  assert.equal(definition.productName, "Clone Grade Beta");
  assert.deepEqual(
    definition.recipes.map((recipe) => recipe.activity),
    // Render order, not object-key order.
    ["manufacturing", "copying", "research_material"],
  );
  const manufacturing = recipeFor(definition, "manufacturing")!;
  assert.deepEqual(manufacturing.materials, [{ typeID: 38, quantity: 86 }]);
  assert.equal(manufacturing.timeSeconds, 600);
  // Invention is absent, so it is not offered.
  assert.equal(recipeFor(definition, "invention"), null);
});

test("a missing definition decodes to null", () => {
  assert.equal(decodeDefinition(null), null);
  assert.equal(decodeDefinition({ blueprintTypeID: 0 }), null);
});

// --- previews ---------------------------------------------------------------

test("the material preview scales with runs and applies material efficiency", () => {
  const recipe = recipeFor(decodeDefinition(RAW_DEFINITION), "manufacturing")!;
  // 86 x 3 = 258 at 0% efficiency.
  assert.deepEqual(previewMaterials(recipe, 3, 0), [{ typeID: 38, quantity: 258 }]);
  // 258 x 0.9 = 232.2 -> 233 (rounded UP, as the server does).
  assert.deepEqual(previewMaterials(recipe, 3, 10), [{ typeID: 38, quantity: 233 }]);
});

test("material efficiency applies to MANUFACTURING only", () => {
  // A copy job consumes its full listed materials however well researched the
  // blueprint is — the server sets the blueprint modifier to 1.0 for every
  // non-manufacturing activity, so discounting here would under-quote.
  const copying = {
    activity: "copying" as const,
    materials: [{ typeID: 38, quantity: 100 }],
    products: [],
    timeSeconds: 480,
  };
  assert.deepEqual(previewMaterials(copying, 2, 50), [{ typeID: 38, quantity: 200 }]);
});

test("the material preview never falls below one unit per run", () => {
  const tiny = {
    activity: "manufacturing" as const,
    materials: [{ typeID: 38, quantity: 1 }],
    products: [],
    timeSeconds: 60,
  };
  assert.deepEqual(previewMaterials(tiny, 5, 90), [{ typeID: 38, quantity: 5 }]);
});

test("the time preview applies time efficiency", () => {
  const recipe = recipeFor(decodeDefinition(RAW_DEFINITION), "manufacturing")!;
  assert.equal(previewTimeSeconds(recipe, 2, 0), 1200);
  assert.equal(previewTimeSeconds(recipe, 2, 20), 960);
  assert.equal(previewTimeSeconds(null, 2, 0), 0);
});

test("a kind of work is for an original or for a copy, and manufacturing for either", () => {
  // The game's own client's activities (industry/activities: REQUIRES_ORIGINAL on copying, the two researches and
  // a reaction, REQUIRES_COPY on invention), and the server's own refusal of any other.
  assert.deepEqual(ACTIVITY_ORDER.filter((activity) => activityIsFor(activity, true)), ["manufacturing", "copying", "research_material", "research_time", "reaction"]);
  assert.deepEqual(ACTIVITY_ORDER.filter((activity) => activityIsFor(activity, false)), ["manufacturing", "invention"]);
  assert.equal(MOST_COPIES_A_JOB, 500);
});

test("a copy job's rough materials and time are for every run of every copy, and only a manufacturing job's time has the blueprint's time research", () => {
  const copying = { activity: "copying" as const, materials: [{ typeID: 38, quantity: 5 }], products: [], timeSeconds: 480 };
  // 25 copies of 2 runs each: 5 x 50. Said of no licensed runs, one each.
  assert.deepEqual(previewMaterials(copying, 25, 10, 2), [{ typeID: 38, quantity: 250 }]);
  assert.deepEqual(previewMaterials(copying, 25, 10), [{ typeID: 38, quantity: 125 }]);
  assert.deepEqual(previewMaterials(copying, 25, 10, 0), [{ typeID: 38, quantity: 125 }]);
  // 3 copies of 10 runs each at 480 s a run, and the blueprint's time research not in it.
  assert.equal(previewTimeSeconds(copying, 3, 20, 10), 14400);
  assert.equal(previewTimeSeconds(copying, 3, 20), 1440);
  // A manufacturing job's are by its runs alone, whatever is said of licensed runs, and its time has the research.
  const manufacturing = recipeFor(decodeDefinition(RAW_DEFINITION), "manufacturing")!;
  assert.deepEqual(previewMaterials(manufacturing, 3, 10, 30), [{ typeID: 38, quantity: 233 }]);
  assert.equal(previewTimeSeconds(manufacturing, 2, 20, 30), 960);
  // A research's time has none of it either: two runs from the first level, 600 and 600 x 29/21.
  assert.equal(previewTimeSeconds({ activity: "research_time" as const, materials: [], products: [], timeSeconds: 600 }, 2, 20, 30), 1429);
});

test("a blueprint stands in a research at the level its own research comes to, and a job of some runs brings it no further than the most", () => {
  // The game's own client's two researches (industry/activities/research_time.py and research_material.py): of a
  // blueprint's time by twos to twenty, of its materials by ones to ten.
  const blueprint = { timeEfficiency: 4, materialEfficiency: 9 };
  assert.deepEqual(researchStanding("research_time", blueprint, 2), { level: 2, runsLeft: 8, finished: false, from: 4, to: 8 });
  assert.deepEqual(researchStanding("research_time", blueprint), { level: 2, runsLeft: 8, finished: false, from: 4, to: 4 });
  assert.deepEqual(researchStanding("research_time", blueprint, 8), { level: 2, runsLeft: 8, finished: false, from: 4, to: 20 });
  assert.deepEqual(researchStanding("research_material", blueprint, 1), { level: 9, runsLeft: 1, finished: false, from: 9, to: 10 });
  // Never past the most, whatever runs are said.
  assert.equal(researchStanding("research_material", blueprint, 3)!.to, 10);
  assert.equal(researchStanding("research_time", blueprint, 50)!.to, 20);
  // At the most: finished, and nothing left.
  const done = { timeEfficiency: 20, materialEfficiency: 10 };
  assert.deepEqual(researchStanding("research_time", done, 1), { level: 10, runsLeft: 0, finished: true, from: 20, to: 20 });
  assert.deepEqual(researchStanding("research_material", done, 1), { level: 10, runsLeft: 0, finished: true, from: 10, to: 10 });
  // A whole division, as the client's: a time research of 5 is where one of 4 is, with seven runs left.
  assert.deepEqual(researchStanding("research_time", { timeEfficiency: 5, materialEfficiency: 0 }, 1), { level: 2, runsLeft: 7, finished: false, from: 5, to: 7 });
  // Any other kind of work is no research.
  for (const activity of ["manufacturing", "copying", "invention", "reaction"] as const) {
    assert.equal(researchStanding(activity, blueprint, 1), null, activity);
  }
});

test("a research's rough time is by the level each run starts from, each run a level above the last", () => {
  // (The first three are the game's own client's Python's answers for these, with no modifier of the pilot's or a
  // facility's: scripts/py27-oracle.py, 2026-10-12.)
  const ofTime = { activity: "research_time" as const, materials: [], products: [], timeSeconds: 210 };
  assert.equal(previewTimeSeconds(ofTime, 3, 0, 1, 0), 1190);
  assert.equal(previewTimeSeconds(ofTime, 4, 0), 2828);
  assert.equal(previewTimeSeconds(ofTime, 1, 0, 1, 8), 124890);
  // A research of materials is the same sum.
  const ofMaterials = { ...ofTime, activity: "research_material" as const };
  assert.equal(previewTimeSeconds(ofMaterials, 3, 0, 1, 0), 1190);
  assert.equal(previewTimeSeconds(ofMaterials, 1, 0, 1, 8), 124890);
  // Rounded, as the client rounds a job's time, and not taken up: 100 x 29/21 is 138.09...
  assert.equal(previewTimeSeconds({ ...ofTime, timeSeconds: 100 }, 1, 0, 1, 1), 138);
  // Past the last level each run is the last level's: 210 x 29660/21, twice.
  assert.equal(previewTimeSeconds(ofTime, 2, 0, 1, 9), 593200);
  // The blueprint's time efficiency and a copy's licensed runs are not in it; a level below nought is the first.
  assert.equal(previewTimeSeconds(ofTime, 3, 20, 30, 0), 1190);
  assert.equal(previewTimeSeconds(ofTime, 3, 0, 1, -4), 1190);
  // Any other work's rough time has no level in it.
  const manufacturing = recipeFor(decodeDefinition(RAW_DEFINITION), "manufacturing")!;
  assert.equal(previewTimeSeconds(manufacturing, 2, 20, 1, 5), 960);
});

// --- presentation helpers ---------------------------------------------------

test("durations read as words, never as a raw second count", () => {
  assert.equal(formatDuration(30), "30 seconds");
  assert.equal(formatDuration(1), "1 second");
  assert.equal(formatDuration(90), "1 minute");
  assert.equal(formatDuration(3600), "1 hour");
  assert.equal(formatDuration(7500), "2 hours 5 minutes");
  assert.equal(formatDuration(0), "less than a minute");
  assert.equal(formatDuration(-5), "less than a minute");
});

test("secondsUntil converts a FILETIME instant against the wall clock", () => {
  // 133000000018000000 ticks = 13300000001.8 s since 1601; minus the epoch
  // offset that is 1655526401 (well-defined, so the arithmetic is checkable).
  const endDate = 133_000_000_018_000_000n;
  const endUnixSeconds = Number(endDate / 10_000_000n - 11_644_473_600n);
  assert.equal(secondsUntil(endDate, endUnixSeconds * 1000), 0);
  assert.equal(secondsUntil(endDate, (endUnixSeconds - 600) * 1000), 600);
  assert.equal(secondsUntil(null, Date.now()), null);
  assert.equal(secondsUntil(0n, Date.now()), null);
});

test("every activity has a plain-language label and a stable id round-trip", () => {
  for (const activity of ACTIVITY_ORDER) {
    const label = ACTIVITY_LABELS[activity];
    assert.ok(label && label.length > 0, `${activity} needs a label`);
    // R9a: a label is words a player would use, never the snake_case key.
    assert.equal(label.includes("_"), false, `${activity}'s label must not be a key`);
    assert.equal(activityOfID(activityIDOf(activity)), activity);
  }
});

// --- refusals ---------------------------------------------------------------

test("a STRUCTURED industry refusal becomes the server's own reasons, in words", () => {
  const message = industryRefusalMessage({
    message: "IndustryValidationError: MISSING_MATERIAL, ACCOUNT_FUNDS",
  });
  assert.match(message, /materials/i);
  assert.match(message, /installation fee/i);
  // The raw code is jargon and must never reach a player (R9a / R7d).
  assert.doesNotMatch(message, /MISSING_MATERIAL|ACCOUNT_FUNDS|IndustryValidationError/);
});

test("each mapped refusal name yields a distinct plain sentence", () => {
  const cases: readonly (readonly [string, RegExp])[] = [
    ["SLOTS_FULL", /job slots/i],
    ["BLUEPRINT_INSTALLED", /already busy/i],
    ["INVALID_RUNS", /number of runs/i],
    ["FACILITY_OFFLINE", /offline/i],
    ["MISSING_SKILL", /skills/i],
    ["INPUT_ACCESS", /hangar/i],
    ["RESEARCH_LIMIT", /researched/i],
    // (A research of many levels meets it: the last levels take weeks each.)
    ["RUN_LENGTH", /within thirty days/i],
  ];
  for (const [name, pattern] of cases) {
    const message = industryRefusalMessage({ message: `IndustryValidationError: ${name}` });
    assert.match(message, pattern, name);
    assert.doesNotMatch(message, new RegExp(name), `${name} must not leak its code`);
  }
});

test("an UNMAPPED refusal name falls back to a sentence, never the raw code", () => {
  const message = industryRefusalMessage({
    message: "IndustryValidationError: SOME_FUTURE_CODE",
  });
  assert.doesNotMatch(message, /SOME_FUTURE_CODE/);
  assert.match(message, /would not accept/i);
});

test("duplicate reasons are said once", () => {
  const message = industryRefusalMessage({
    message: "IndustryValidationError: MISSING_MATERIAL, MISSING_MATERIAL",
  });
  assert.equal(message, "You do not have enough of the materials this job needs.");
});

test("a bare IndustryValidationError with no reasons says exactly that", () => {
  const message = industryRefusalMessage({ message: "IndustryValidationError" });
  assert.match(message, /gave no reason/i);
});

test("a PROSE refusal is passed through verbatim - the handler's own words", () => {
  // Never reworded: the server said this, so the player sees it.
  assert.equal(
    industryRefusalMessage({ message: "That industry job is not ready yet." }),
    "That industry job is not ready yet.",
  );
  assert.equal(
    industryRefusalMessage({ message: "You do not have access to that industry job." }),
    "You do not have access to that industry job.",
  );
});

test("an empty or unrecognizable error reports a decline without inventing a cause", () => {
  const message = industryRefusalMessage({ message: "" });
  assert.match(message, /gave no reason/i);
  assert.doesNotMatch(message, /material|fee|slot|skill/i);
});

test("R109: a blueprint in the wrong place is refused in plain words, not the generic sentence", () => {
  assert.equal(
    industryRefusalMessage(new Error("IndustryValidationError: INVALID_BLUEPRINT_LOCATION")),
    "That blueprint is not somewhere a job can start from. Put it in a hangar where industry is offered.",
  );
  assert.equal(
    industryRefusalMessage(new Error("IndustryValidationError: BLUEPRINT_WRONG_FACILITY")),
    "That blueprint is in a different facility. A job starts where its blueprint is.",
  );
});

test("a facility keeps its own time and material modifiers per activity, as the server sends them", () => {
  // The shape captured live from GetFacilities: activities is a dict of
  // activityID to a tuple of plain lists [time, material, cost, ...], each
  // entry [value, categoryID, groupID, typeID, reference].
  const row = keyVal({
    facilityID: 1035000000001,
    activities: dict([
      [1, { type: "tuple", items: [[[0.85, null, null, null, 7]], [[0.99, null, 0, null, 7], [0.976, 18, null, null, 8]], [[0.97, null, null, null, 7]], [], [], []] } as unknown as JsonValue],
      [8, { type: "tuple", items: [[[0.98, null, null, null, 5]], [], [[0.04, null, null, null, 4]], [], [], []] } as unknown as JsonValue],
      [5, { type: "tuple", items: [] } as unknown as JsonValue],
    ]),
  });
  const facility = decodeFacilities(list([row]))[0]!;
  assert.deepEqual(facility.modifiers.manufacturing, {
    time: [{ value: 0.85, categoryID: null, groupID: null, typeID: null }],
    material: [
      { value: 0.99, categoryID: null, groupID: null, typeID: null },
      { value: 0.976, categoryID: 18, groupID: null, typeID: null },
    ],
  });
  // A 0 id reads as "any", the same as null (the server checks <= 0).
  // An NPC station's invention: time only, no material entry at all.
  assert.deepEqual(facility.modifiers.invention, { time: [{ value: 0.98, categoryID: null, groupID: null, typeID: null }], material: [] });
  // Listed with nothing to say: no entry.
  assert.equal(facility.modifiers.copying, undefined);
  assert.deepEqual(facility.activities, ["manufacturing", "copying", "invention"]);

  // The game port has each of those tuples as a plain array, off the wire. It reads the same.
  const bare = keyVal({
    facilityID: 1035000000001,
    activities: dict([
      [1, [[[0.85, null, null, null, 7]], [[0.99, null, 0, null, 7], [0.976, 18, null, null, 8]], [[0.97, null, null, null, 7]], [], [], []] as unknown as JsonValue],
      [8, [[[0.98, null, null, null, 5]], [], [[0.04, null, null, null, 4]], [], [], []] as unknown as JsonValue],
      [5, [] as unknown as JsonValue],
    ]),
  });
  assert.deepEqual(decodeFacilities(list([bare]))[0], facility);
});

// --- what a job costs to start ----------------------------------------------

test("a fee out of the preview's answer is five whole amounts that add up, or none", () => {
  const fee = { cost: 5284, tax: 1321, sccSurcharge: 5284, securityTax: 0, total: 11889 };
  assert.deepEqual(decodeJobFee(fee), fee);
  assert.deepEqual(decodeJobFee({ ...fee, more: "ignored" } as unknown as JsonValue), fee);
  // (An amount below nought, and one that is no whole number, each in a fee that adds up all the same.)
  const belowNought = { cost: 5284, tax: -1, sccSurcharge: 5284, securityTax: 0, total: 10567 };
  const notWhole = { cost: 1.5, tax: 0.5, sccSurcharge: 0, securityTax: 0, total: 2 };
  for (const none of [null, undefined, 11889, "11889", [], { cost: 5284 }, belowNought, notWhole, { ...fee, total: 11888 }, { ...fee, sccSurcharge: "5284" }]) {
    assert.equal(decodeJobFee(none as unknown as JsonValue), null, JSON.stringify(none));
  }
});

test("a job's materials out of the preview's answer are whole quantities by type, or none", () => {
  const materials = { "34": 31680, "35": 5940, "36": 2475 };
  assert.deepEqual(decodeJobMaterials(materials), materials);
  // A job that takes nothing takes nothing.
  assert.deepEqual(decodeJobMaterials({}), {});
  // None where they were not reckoned, or where any of them is no quantity of a type.
  for (const none of [null, undefined, 31680, "31680", [], [31680], { "34": "31680" }, { "34": 0 }, { "34": -1 }, { "34": 1.5 }, { "34": null },
    { tritanium: 31680 }, { "-34": 31680 }, { "3.4": 31680 }, { "034": 31680 }, { "0": 5 }, { "34": 31680, "35": "5940" }]) {
    assert.equal(decodeJobMaterials(none as unknown as JsonValue), null, JSON.stringify(none));
  }
});

test("what a job will use is the preview's reckoning where it has every material, and the page's estimate otherwise", () => {
  const estimate = [{ typeID: 34, quantity: 32000 }, { typeID: 35, quantity: 6000 }];
  // The reckoning's quantities, in the estimate's order, and said to be exact.
  assert.deepEqual(materialsToUse(estimate, { "35": 5940, "34": 31680 }), { materials: [{ typeID: 34, quantity: 31680 }, { typeID: 35, quantity: 5940 }], exact: true });
  // None made: the estimate, and not exact.
  assert.deepEqual(materialsToUse(estimate, null), { materials: estimate, exact: false });
  // One that has not every material the page lists, or has one the page does not: the estimate, whole.
  assert.deepEqual(materialsToUse(estimate, { "34": 31680 }), { materials: estimate, exact: false });
  assert.deepEqual(materialsToUse(estimate, { "34": 31680, "35": 5940, "36": 2475 }), { materials: estimate, exact: false });
  assert.deepEqual(materialsToUse(estimate, { "34": 31680, "36": 2475 }), { materials: estimate, exact: false });
  // A job that uses nothing uses nothing, exactly.
  assert.deepEqual(materialsToUse([], {}), { materials: [], exact: true });
});

test("a fee's parts are named in plain words, and one that is nought is not listed", () => {
  assert.deepEqual(jobFeeParts({ cost: 10240, tax: 0, sccSurcharge: 10240, securityTax: 0, total: 20480 }), [
    { what: "the job itself", amount: 10240 },
    { what: "the SCC surcharge", amount: 10240 },
  ]);
  assert.deepEqual(jobFeeParts({ cost: 10240, tax: 25600, sccSurcharge: 10240, securityTax: 12800, total: 58880 }).map((part) => part.what),
    ["the job itself", "the facility's tax", "the SCC surcharge", "the security tax"]);
  // A job that costs nothing to start has no parts.
  assert.deepEqual(jobFeeParts({ cost: 0, tax: 0, sccSurcharge: 0, securityTax: 0, total: 0 }), []);
});

test("an invention's decryptor is among its rough materials, one a run, and among no other work's", () => {
  // industryCommon.GetDecryptors (458 to 482): the optional material is one of the job's materials, at a base of one.
  const invention = { activity: "invention" as const, materials: [{ typeID: 20418, quantity: 2 }], products: [{ typeID: 1900, quantity: 10 }], timeSeconds: 7800 };
  assert.deepEqual(previewMaterials(invention, 3, 10, 1, 34204), [{ typeID: 20418, quantity: 6 }, { typeID: 34204, quantity: 3 }]);
  assert.deepEqual(previewMaterials(invention, 3, 10, 1), [{ typeID: 20418, quantity: 6 }]);
  assert.deepEqual(previewMaterials(invention, 3, 10, 1, 0), [{ typeID: 20418, quantity: 6 }]);
  // The preview's reckoning of them is then the page's own list, and exact.
  assert.deepEqual(materialsToUse(previewMaterials(invention, 3, 10, 1, 34204), { "20418": 6, "34204": 3 }),
    { materials: [{ typeID: 20418, quantity: 6 }, { typeID: 34204, quantity: 3 }], exact: true });
  const manufacturing = recipeFor(decodeDefinition(RAW_DEFINITION), "manufacturing")!;
  assert.deepEqual(previewMaterials(manufacturing, 3, 0, 1, 34204), [{ typeID: 38, quantity: 258 }]);
  assert.deepEqual(previewMaterials({ ...invention, activity: "copying" as const }, 3, 0, 1, 34204), [{ typeID: 20418, quantity: 6 }]);
});

test("an invention that could make one of several blueprints has them to choose from, and one that makes the one has none", () => {
  // industry/job.py 181 to 190: a job whose recipe has several products has none until one is chosen.
  const invention = (products: readonly number[]) => ({ activity: "invention" as const, materials: [], products: products.map((typeID) => ({ typeID, quantity: 1 })), timeSeconds: 7800 });
  assert.deepEqual(inventionChoices(invention([11372, 11401])), [11372, 11401]);
  assert.deepEqual(inventionChoices(invention([11372])), []);
  assert.deepEqual(inventionChoices(invention([])), []);
  assert.deepEqual(inventionChoices(null), []);
  // No other kind of work has a choice of what it makes.
  assert.deepEqual(inventionChoices({ ...invention([11372, 11401]), activity: "manufacturing" as const }), []);
});

test("a job is asked for no more runs than its kind of work has of the blueprint", () => {
  const blueprint = (original: boolean, runs: number, timeEfficiency = 0, materialEfficiency = 0) => ({ original, runs, timeEfficiency, materialEfficiency });
  // An invention: what its copy has, and never more than five hundred (invention.py's MAX_RUNS).
  assert.equal(MOST_INVENTIONS_A_JOB, 500);
  assert.deepEqual([mostRunsToAsk("invention", blueprint(false, 10)), mostRunsToAsk("invention", blueprint(false, 501)), mostRunsToAsk("invention", blueprint(false, 500)), mostRunsToAsk("invention", blueprint(false, 0))], [10, 500, 500, 1]);
  // A manufacturing job: what a copy has, which may be more than that; and an original's thousand.
  assert.deepEqual([mostRunsToAsk("manufacturing", blueprint(false, 600)), mostRunsToAsk("manufacturing", blueprint(true, -1)), mostRunsToAsk("reaction", blueprint(true, -1))], [600, 1000, 1000]);
  // A copy job: its most copies. A research: the levels that are left, and one at the least.
  assert.equal(mostRunsToAsk("copying", blueprint(true, -1)), MOST_COPIES_A_JOB);
  assert.deepEqual([mostRunsToAsk("research_time", blueprint(true, -1, 16, 3)), mostRunsToAsk("research_material", blueprint(true, -1, 16, 3)), mostRunsToAsk("research_material", blueprint(true, -1, 20, 10))], [2, 7, 1]);
  // No work chosen: as a blueprint's own runs.
  assert.deepEqual([mostRunsToAsk(null, blueprint(false, 7)), mostRunsToAsk(null, blueprint(true, -1))], [7, 1000]);
});

// --- a job as its blueprint is chosen -------------------------------------------
// The client's industry window makes a job the moment a blueprint is chosen (industryWnd.py 131 to 160 and 191 to
// 211; industrySvc.CreateJob, 92 to 110): at the blueprint's own facility, by the first kind of work in its own
// order (industry.ACTIVITIES, industry/const.py 15 to 21: manufacturing, the two researches, materials first, then
// copying, invention and reactions) that the blueprint is for and the facility takes. The numbers are made up.

const aFacility = (facilityID: number, activities: readonly string[], online = true) =>
  ({ facilityID, solarSystemID: 30000142, typeID: 1529, ownerID: 1000035, online, tax: 0.01, activities, modifiers: {} }) as never;

test("a job is made at its blueprint's own facility, by the first work in the client's order that the blueprint is for and the facility takes", () => {
  const facilities = [aFacility(60000001, ["manufacturing", "copying", "research_time", "research_material"]), aFacility(60000002, ["copying", "research_time", "research_material"]), aFacility(1030000000002, ["reaction"])];
  // An original in a factory: manufacturing.
  assert.deepEqual(jobAsChosen(["manufacturing", "copying", "research_material", "research_time"], 60000001, facilities), { activity: "manufacturing", facilityID: 60000001 });
  // The same original in a laboratory that manufactures nothing: the research of its materials, which is before
  // copying in the client's order, however the page lists a blueprint's work.
  assert.deepEqual(jobAsChosen(["manufacturing", "copying", "research_material", "research_time"], 60000002, facilities), { activity: "research_material", facilityID: 60000002 });
  assert.deepEqual(jobAsChosen(["copying", "research_time", "manufacturing"], 60000002, facilities), { activity: "research_time", facilityID: 60000002 });
  // A formula in a refinery.
  assert.deepEqual(jobAsChosen(["reaction"], 1030000000002, facilities), { activity: "reaction", facilityID: 1030000000002 });
  // A copy to invent from, in a laboratory that takes no invention: the blueprint's first work, and no place.
  assert.deepEqual(jobAsChosen(["manufacturing", "invention"], 60000002, facilities), { activity: "manufacturing", facilityID: null });
});

test("where the blueprint's own facility is not one to work at, the job has the blueprint's first work and no place chosen", () => {
  const facilities = [aFacility(60000001, ["manufacturing"]), aFacility(60000003, ["manufacturing", "copying"], false)];
  // Not among the facilities read; in none (in a container, or in space); in one that is not online.
  for (const where of [60000009, null, 60000003]) {
    assert.deepEqual(jobAsChosen(["copying", "manufacturing"], where, facilities), { activity: "manufacturing", facilityID: null }, String(where));
  }
  // No facilities read at all.
  assert.deepEqual(jobAsChosen(["copying", "research_time"], 60000001, []), { activity: "research_time", facilityID: null });
  // A blueprint that is for no work known has none, and no place.
  assert.deepEqual(jobAsChosen([], 60000001, facilities), { activity: null, facilityID: null });
  // Another facility's work is not the blueprint's facility's: a blueprint in the factory is not copied there.
  assert.deepEqual(jobAsChosen(["copying"], 60000001, [...facilities, aFacility(60000004, ["copying"])]), { activity: "copying", facilityID: null });
});

test("a job is not asked about while anything is wanting for it: its work, its place, its runs, a research left, an invention's product, a copy's licence", () => {
  const job = { activity: "manufacturing", facilityID: 60000001, runs: 1, researchFinished: false, productUnchosen: false, licensedRuns: 1, mostLicensedRuns: 300 } as const;
  assert.equal(jobCannotBeAsked(job), false);
  for (const wanting of [{ activity: null }, { facilityID: null }, { runs: 0 }, { runs: -1 }, { researchFinished: true }, { productUnchosen: true }] as const) {
    assert.equal(jobCannotBeAsked({ ...job, ...wanting }), true, JSON.stringify(wanting));
  }
  // The licence is a copy job's alone: any other work is asked about whatever it says.
  for (const licensedRuns of [0, 301, -5]) {
    assert.equal(jobCannotBeAsked({ ...job, licensedRuns }), false, String(licensedRuns));
    assert.equal(jobCannotBeAsked({ ...job, activity: "copying", licensedRuns }), true, String(licensedRuns));
  }
  for (const licensedRuns of [1, 150, 300]) assert.equal(jobCannotBeAsked({ ...job, activity: "copying", licensedRuns }), false, String(licensedRuns));
  // Many runs are the blueprint's and the server's to hold, not this rule's.
  assert.equal(jobCannotBeAsked({ ...job, runs: 100000 }), false);
});
