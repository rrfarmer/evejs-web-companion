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
  STATUS_LABELS,
  activityIDOf,
  activityOfID,
  decodeBlueprints,
  decodeDefinition,
  decodeFacilities,
  decodeFacilityLocations,
  decodeJob,
  decodeJobs,
  decodeSlotUsage,
  formatDuration,
  industryRefusalMessage,
  isActiveJob,
  previewMaterials,
  previewTimeSeconds,
  recipeFor,
  secondsUntil,
} from "./industry.ts";
import type { JsonValue } from "./wire.ts";

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
});
