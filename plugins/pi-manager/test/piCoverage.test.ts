// Coverage: what the roster makes per tier, and how evenly its basics cover the tree.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import type { Colony, ColonyPin } from "../../../web/src/store/types.ts";
import { decodeRecipeBook, type PiCommodity, type PiRecipeBook, type PiSchematic, type PiTier } from "../../../web/src/bridge/piRecipes.ts";
import type { PilotColonyReading } from "../lib/piRoster.ts";
import type { JsonValue } from "../../../web/src/bridge/wire.ts";
import { balancedDemand, buildCoverage, SHORT_SHARE } from "../lib/piCoverage.ts";

// --- a small book: two basics feed one refined product, a third feeds two ---

const RAW_A = 100;
const RAW_B = 101;
const RAW_C = 102;
const BASIC_A = 200;
const BASIC_B = 201;
const BASIC_C = 202;
const REFINED_X = 300;
const REFINED_Y = 301;
const TOP = 400;
const BASIC_FACTORY = 2473;
const PILOT = 90000001;
const OTHER_PILOT = 90000002;
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function recipe(
  schematicID: number,
  inputs: readonly [number, number][],
  output: [number, number],
  cycleTimeSeconds: number,
): PiSchematic {
  return {
    schematicID,
    name: `Recipe ${schematicID}`,
    cycleTimeSeconds,
    factoryTypeIDs: [BASIC_FACTORY],
    inputs: inputs.map(([typeID, quantity]) => ({ typeID, typeName: null, quantity })),
    output: { typeID: output[0], typeName: null, quantity: output[1] },
  };
}

const SCHEMATICS = [
  recipe(1, [[RAW_A, 3000]], [BASIC_A, 20], 1800),
  recipe(2, [[RAW_B, 3000]], [BASIC_B, 20], 1800),
  recipe(3, [[RAW_C, 3000]], [BASIC_C, 20], 1800),
  // X takes A and C, Y takes B and C: C feeds both, so it carries twice the weight.
  recipe(4, [[BASIC_A, 40], [BASIC_C, 40]], [REFINED_X, 5], 3600),
  recipe(5, [[BASIC_B, 40], [BASIC_C, 40]], [REFINED_Y, 5], 3600),
  recipe(6, [[REFINED_X, 10], [REFINED_Y, 10]], [TOP, 3], 3600),
] as const;

const TIERS: readonly [number, string, PiTier][] = [
  [RAW_A, "Raw A", 0], [RAW_B, "Raw B", 0], [RAW_C, "Raw C", 0],
  [BASIC_A, "Basic A", 1], [BASIC_B, "Basic B", 1], [BASIC_C, "Basic C", 1],
  [REFINED_X, "Refined X", 2], [REFINED_Y, "Refined Y", 2], [TOP, "Top", 3],
];

const BOOK: PiRecipeBook = {
  schematics: SCHEMATICS,
  bySchematicID: new Map(SCHEMATICS.map((row) => [row.schematicID, row])),
  byOutputTypeID: new Map(SCHEMATICS.map((row) => [row.output.typeID, row])),
  commodities: new Map<number, PiCommodity>(TIERS.map(([typeID, typeName, tier]) => [typeID, { typeID, typeName, tier }])),
  readable: true,
};

let nextPin = 1;

function pin(fields: Partial<ColonyPin>): ColonyPin {
  return {
    pinID: nextPin++,
    typeID: 0,
    typeName: "",
    kind: "other",
    contents: [],
    usedM3: null,
    capacityM3: null,
    schematicID: null,
    schematicName: null,
    hasReceivedInputs: null,
    receivedInputsLastCycle: null,
    lastRunAtMs: null,
    lastLaunchAtMs: null,
    program: null,
    ...fields,
  };
}

/** An extractor pulling `perHour` of a raw resource, ending in `endsInMs`. */
function extractor(resourceTypeID: number, perHour: number, endsInMs = 4 * 24 * HOUR): ColonyPin {
  return pin({
    kind: "extractor-control",
    program: {
      resourceTypeID,
      resourceTypeName: null,
      cycleTimeSeconds: 7200,
      quantityPerCycle: perHour * 2,
      installedAtMs: NOW - HOUR,
      expiresAtMs: NOW + endsInMs,
      headCount: 7,
    },
  });
}

function factory(schematicID: number, active = true): ColonyPin {
  return pin({ kind: "factory", typeID: BASIC_FACTORY, schematicID, active });
}

function colony(planetID: number, planetName: string, pins: readonly ColonyPin[], quality: number | null = null): Colony {
  return {
    planetID,
    planetName,
    solarSystemID: 30000001,
    solarSystemName: "Alpha",
    planetTypeID: 2016,
    planetTypeName: "Planet (Barren)",
    commandCenterLevel: 5,
    lastSimulatedAtMs: null,
    pins,
    linkCount: 0,
    links: [],
    routes: [],
    resources: quality === null ? null : [RAW_A, RAW_B, RAW_C].map((typeID) => ({ typeID, typeName: null, quality })),
  };
}

function readings(byPilot: Record<number, readonly Colony[]>): Map<number, PilotColonyReading> {
  return new Map(Object.entries(byPilot).map(([id, colonies]) => [Number(id), {
    characterID: Number(id),
    readAtMs: NOW,
    report: { colonies, coloniesReadable: true, clockOffsetMs: 0 },
  }]));
}

const NAMES = new Map([[PILOT, "Pilot One"], [OTHER_PILOT, "Pilot Two"]]);

function coverageOf(byPilot: Record<number, readonly Colony[]>) {
  return buildCoverage({ book: BOOK, readings: readings(byPilot), names: NAMES, browserNowMs: NOW });
}

function line(result: ReturnType<typeof coverageOf>, typeID: number) {
  const found = result.lines.find((entry) => entry.typeID === typeID);
  assert.ok(found, `a line for ${typeID}`);
  return found;
}

test("the balanced aim weighs a basic by how much of the tree consumes it", () => {
  const demand = balancedDemand(BOOK);
  // One Top = 1/3 run = 10/3 of X and of Y; each is 2/3 run = 80/3 of each input.
  assert.ok(Math.abs(demand.get(BASIC_A)! - 80 / 3) < 1e-9);
  assert.ok(Math.abs(demand.get(BASIC_B)! - 80 / 3) < 1e-9);
  assert.ok(Math.abs(demand.get(BASIC_C)! - 160 / 3) < 1e-9, "C feeds both refined products");
  assert.equal(demand.get(TOP), 1);
});

test("a basic is credited with the smaller of what the colony pulls up and what its factories refine", () => {
  // 1,500 raw an hour is 10 basic an hour; four factories could do 160.
  const pulledShort = coverageOf({ [PILOT]: [colony(1, "Alpha I", [extractor(RAW_A, 1500), factory(1), factory(1), factory(1), factory(1)])] });
  assert.equal(line(pulledShort, BASIC_A).perHour, 10);
  // 30,000 raw an hour is 200 basic; one factory refines 40 of it.
  const refinedShort = coverageOf({ [PILOT]: [colony(1, "Alpha I", [extractor(RAW_A, 30000), factory(1)])] });
  assert.equal(line(refinedShort, BASIC_A).perHour, 40);
  assert.equal(line(refinedShort, RAW_A).perHour, 30000, "the raw line keeps the full extraction");
});

test("a factory fed by its own colony counts between batches; an ended program makes nothing", () => {
  // Read between batches: every factory idle. The colony still pulls up
  // 3,000 an hour, which is 20 basic an hour, so that is what it makes.
  const result = coverageOf({
    [PILOT]: [
      colony(1, "Alpha I", [extractor(RAW_A, 3000), factory(1, false), factory(1, false)]),
      colony(2, "Alpha II", [extractor(RAW_B, 3000, -HOUR), factory(2)]),
    ],
  });
  assert.equal(line(result, BASIC_A).perHour, 20);
  assert.equal(line(result, BASIC_A).colonies, 1);
  assert.equal(line(result, BASIC_B).perHour, 0);
  assert.equal(line(result, BASIC_B).sources[0]!.programWords, "ended");
});

test("targets split what is made now by the balanced shares, and say how many colonies close a gap", () => {
  // A and B at 20 an hour each, C at 20: C should carry half, so it is short.
  const result = coverageOf({
    [PILOT]: [
      colony(1, "Alpha I", [extractor(RAW_A, 3000), factory(1)]),
      colony(2, "Alpha II", [extractor(RAW_B, 3000), factory(2)]),
      colony(3, "Alpha III", [extractor(RAW_C, 3000), factory(3)]),
    ],
  });
  const c = line(result, BASIC_C);
  assert.equal(c.perHour, 20);
  assert.equal(c.targetPerHour, 30, "half of the 60 made");
  assert.equal(c.state, "short");
  assert.equal(c.colonyGap, 1, "a 10-an-hour gap is one typical 20-an-hour colony, rounded up to at least one");
  assert.equal(line(result, BASIC_A).targetPerHour, 15);
  assert.equal(line(result, BASIC_A).state, "ok", `over ${SHORT_SHARE} of target is covered`);
  assert.equal(result.summary.short, 1);
  assert.equal(result.summary.basicsMade, 3);
  assert.equal(result.summary.basicsKnown, 3);
});

test("a basic nobody makes is listed, as none, with its target", () => {
  const result = coverageOf({ [PILOT]: [colony(1, "Alpha I", [extractor(RAW_A, 3000), factory(1)])] });
  const b = line(result, BASIC_B);
  assert.equal(b.perHour, 0);
  assert.equal(b.colonies, 0);
  assert.equal(b.state, "none");
  assert.equal(b.targetPerHour, 5, "a quarter of the 20 made");
  assert.equal(result.summary.basicsMade, 1);
});

test("a colony well under its commodity's median is weak, and every source names its pilot and planet", () => {
  const result = coverageOf({
    [PILOT]: [colony(1, "Alpha I", [extractor(RAW_A, 3000), factory(1)], 140)],
    [OTHER_PILOT]: [
      colony(2, "Alpha II", [extractor(RAW_A, 3000), factory(1)], 135),
      colony(3, "Alpha III", [extractor(RAW_A, 1200), factory(1)], 77),
    ],
  });
  const a = line(result, BASIC_A);
  assert.equal(a.colonies, 3);
  assert.equal(a.weakCount, 1);
  const weak = a.sources.find((source) => source.weak)!;
  assert.equal(weak.placeWords, "Alpha III");
  assert.equal(weak.ownerName, "Pilot Two");
  assert.equal(weak.quality, 77);
  assert.match(weak.programWords ?? "", /^ends in 4 days$/);
  assert.equal(result.summary.weak, 1);
});

test("refined products are listed with their running factories and no target", () => {
  const result = coverageOf({ [PILOT]: [colony(1, "Alpha I", [factory(4), factory(4), factory(5, false)])] });
  const x = line(result, REFINED_X);
  assert.equal(x.perHour, 10, "two factories, five an hour each");
  assert.equal(x.targetPerHour, null);
  assert.equal(x.state, "untargeted");
  assert.equal(result.lines.find((entry) => entry.typeID === REFINED_Y)?.perHour ?? 0, 0);
});

// --- the real table ---------------------------------------------------------

const EVE_ROOT = process.env.EVEJS_ROOT ?? "D:/evet";
const REAL_DATA_PATH = `${EVE_ROOT}/_local/gameStore/data/planetSchematics/data.json`;

/** The real recipes, with tiers worked out from the recipes themselves (the BFF sends them). */
function loadRealBook(): PiRecipeBook | null {
  if (!existsSync(REAL_DATA_PATH)) return null;
  const parsed = JSON.parse(readFileSync(REAL_DATA_PATH, "utf8")) as {
    schematics: readonly {
      schematicID: number;
      name: string;
      cycleTime: number;
      pinTypeIDs: readonly number[];
      inputs: readonly { typeID: number; quantity: number }[];
      outputs: readonly { typeID: number; quantity: number }[];
    }[];
  };
  const byOutput = new Map(parsed.schematics.map((row) => [row.outputs[0]!.typeID, row]));
  const tier = (typeID: number): number => {
    const row = byOutput.get(typeID);
    return row ? 1 + Math.max(...row.inputs.map((input) => tier(input.typeID))) : 0;
  };
  const commodities: Record<string, JsonValue> = {};
  for (const row of parsed.schematics) {
    for (const typeID of [row.outputs[0]!.typeID, ...row.inputs.map((input) => input.typeID)]) {
      commodities[String(typeID)] = { typeName: byOutput.get(typeID)?.name ?? null, tier: tier(typeID) };
    }
  }
  return decodeRecipeBook({
    schematics: parsed.schematics.map((row) => ({
      schematicID: row.schematicID,
      name: row.name,
      cycleTimeSeconds: row.cycleTime,
      factoryTypeIDs: row.pinTypeIDs,
      inputs: row.inputs,
      output: row.outputs[0] ?? null,
    })),
    commodities,
  } as unknown as JsonValue);
}

test("real table: the tops are the P4s, and Water, Reactive Metals and Bacteria weigh most", (t) => {
  const book = loadRealBook();
  if (book === null) {
    t.skip(`real recipe table not found at ${REAL_DATA_PATH}`);
    return;
  }
  const demand = balancedDemand(book);
  const tops = book.schematics.filter((row) => demand.get(row.output.typeID) === 1);
  assert.ok(tops.length > 0);
  assert.ok(tops.every((row) => book.commodities.get(row.output.typeID)?.tier === 4), "every top is a P4");
  const basics = [...book.commodities.values()]
    .filter((commodity) => commodity.tier === 1)
    .sort((left, right) => demand.get(right.typeID)! - demand.get(left.typeID)!);
  assert.equal(basics.length, 15);
  assert.deepEqual(
    basics.slice(0, 3).map((commodity) => commodity.typeName).sort(),
    ["Bacteria", "Reactive Metals", "Water"],
  );
});
