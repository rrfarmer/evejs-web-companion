// Expansion: free slots go to the basic furthest behind, on the best planet in reach.

import test from "node:test";
import assert from "node:assert/strict";

import type { Colony, ColonyPin } from "../../../web/src/store/types.ts";
import type { PiCommodity, PiRecipeBook, PiSchematic, PiTier } from "../../../web/src/bridge/piRecipes.ts";
import type { PilotColonyReading } from "../lib/piRoster.ts";
import { balancedDemand, buildCoverage } from "../lib/piCoverage.ts";
import {
  basicSources,
  commandCentresToBuy,
  expansionGroups,
  expansionPilots,
  homeSystems,
  layoutToCopy,
  proposeExpansion,
  rowState,
  type ExpansionPilot,
  type PlanetNear,
} from "../lib/piExpansion.ts";

const RAW_A = 100;
const RAW_B = 101;
const RAW_C = 102;
const BASIC_A = 200;
const BASIC_B = 201;
const BASIC_C = 202;
const REFINED_X = 300;
const REFINED_Y = 301;
const TOP = 400;
const PILOT = 90000001;
const OTHER_PILOT = 90000002;
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function recipe(schematicID: number, inputs: readonly [number, number][], output: [number, number], cycle: number): PiSchematic {
  return {
    schematicID,
    name: `Recipe ${schematicID}`,
    cycleTimeSeconds: cycle,
    factoryTypeIDs: [2473],
    inputs: inputs.map(([typeID, quantity]) => ({ typeID, typeName: null, quantity })),
    output: { typeID: output[0], typeName: null, quantity: output[1] },
  };
}

// C feeds both refined products, so it weighs twice what A or B does.
const SCHEMATICS = [
  recipe(1, [[RAW_A, 3000]], [BASIC_A, 20], 1800),
  recipe(2, [[RAW_B, 3000]], [BASIC_B, 20], 1800),
  recipe(3, [[RAW_C, 3000]], [BASIC_C, 20], 1800),
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
    pinID: nextPin++, typeID: 0, typeName: "", kind: "other", contents: [], usedM3: null, capacityM3: null,
    schematicID: null, schematicName: null, hasReceivedInputs: null, receivedInputsLastCycle: null,
    lastRunAtMs: null, lastLaunchAtMs: null, program: null, ...fields,
  };
}

function extractor(resourceTypeID: number, perHour: number, headCount = 7): ColonyPin {
  return pin({
    kind: "extractor-control",
    program: {
      resourceTypeID, resourceTypeName: null, cycleTimeSeconds: 7200, quantityPerCycle: perHour * 2,
      installedAtMs: NOW - HOUR, expiresAtMs: NOW + 96 * HOUR, headCount,
    },
  });
}

function factory(schematicID: number): ColonyPin {
  return pin({ kind: "factory", typeID: 2473, schematicID, active: true });
}

function colony(planetID: number, solarSystemID: number, pins: readonly ColonyPin[], level = 5): Colony {
  return {
    planetID, planetName: `Planet ${planetID}`, solarSystemID, solarSystemName: "Alpha", planetTypeID: 2016,
    planetTypeName: "Planet (Barren)", commandCenterLevel: level, lastSimulatedAtMs: null, pins,
    linkCount: 0, links: [], routes: [], resources: null,
  };
}

/** A basic-making colony: one resource, refined in four factories. */
function making(planetID: number, raw: number, schematicID: number, perHour = 3000, solarSystemID = 30000001): Colony {
  return colony(planetID, solarSystemID, [extractor(raw, perHour), factory(schematicID), factory(schematicID), factory(schematicID), factory(schematicID)]);
}

function readings(byPilot: Record<number, readonly Colony[]>): Map<number, PilotColonyReading> {
  return new Map(Object.entries(byPilot).map(([id, colonies]) => [Number(id), {
    characterID: Number(id), readAtMs: NOW, report: { colonies, coloniesReadable: true, clockOffsetMs: 0 },
  }]));
}

function planet(planetID: number, security: number, resourceTypeIDs: readonly number[], jumps = 1, solarSystemID = 30000002): PlanetNear {
  return {
    planetID, planetName: `Near ${planetID}`, planetTypeID: 2016, planetTypeName: "Planet (Barren)",
    solarSystemID, solarSystemName: "Beta", security, jumps, resourceTypeIDs,
  };
}

const NAMES = new Map([[PILOT, "Pilot One"], [OTHER_PILOT, "Pilot Two"]]);

function propose(
  byPilot: Record<number, readonly Colony[]>,
  pilots: readonly ExpansionPilot[],
  planets: readonly PlanetNear[],
  richness: Record<number, Record<number, number>> = {},
  nullsecTolerance = 0.2,
) {
  const reads = readings(byPilot);
  const coverage = buildCoverage({ book: BOOK, readings: reads, names: NAMES, browserNowMs: NOW });
  return proposeExpansion({
    book: BOOK,
    coverage,
    demand: balancedDemand(BOOK),
    pilots,
    planets,
    richness: new Map(Object.entries(richness).map(([id, byType]) =>
      [Number(id), new Map(Object.entries(byType).map(([typeID, quality]) => [Number(typeID), quality]))])),
    readings: reads,
    nullsecTolerance,
  });
}

const PILOT_ONE = (freeSlots: number): ExpansionPilot => ({ characterID: PILOT, name: "Pilot One", freeSlots, commandCenterLevel: 5 });

test("each basic comes from the raw resource its one recipe refines", () => {
  assert.deepEqual([...basicSources(BOOK)].sort(), [[BASIC_A, RAW_A], [BASIC_B, RAW_B], [BASIC_C, RAW_C]]);
});

test("slots fill the basic furthest behind its weight first, and level out", () => {
  // A, B and C each made by one colony. C weighs double, so it is furthest behind.
  const result = propose(
    { [PILOT]: [making(1, RAW_A, 1), making(2, RAW_B, 2), making(3, RAW_C, 3)] },
    [PILOT_ONE(3)],
    [planet(10, -0.3, [RAW_A, RAW_B, RAW_C]), planet(11, -0.3, [RAW_A, RAW_B, RAW_C]), planet(12, -0.3, [RAW_A, RAW_B, RAW_C])],
  );
  assert.deepEqual(result.rows.map((row) => row.productTypeID), [BASIC_C, BASIC_A, BASIC_B],
    "C first; then C sits at 2 per 2 weight, level with A and B at 1 per 1, and A wins the tie by id");
  assert.equal(result.unusedSlots, 0);
});

test("nullsec wins unless it is poorer by more than the tolerance", () => {
  const byPilot = { [PILOT]: [making(1, RAW_A, 1), making(2, RAW_B, 2)] };
  // Lowsec 135 vs nullsec 104: 104 < 0.8 x 135, so lowsec.
  const poorer = propose(byPilot, [PILOT_ONE(1)], [planet(20, 0.3, [RAW_C]), planet(21, -0.3, [RAW_C])], { 20: { [RAW_C]: 135 }, 21: { [RAW_C]: 104 } });
  assert.equal(poorer.rows[0]!.planet.planetID, 20);
  // Lowsec 125 vs nullsec 104: 104 >= 0.8 x 125, so nullsec.
  const close = propose(byPilot, [PILOT_ONE(1)], [planet(20, 0.3, [RAW_C]), planet(21, -0.3, [RAW_C])], { 20: { [RAW_C]: 125 }, 21: { [RAW_C]: 104 } });
  assert.equal(close.rows[0]!.planet.planetID, 21);
  assert.equal(close.rows[0]!.quality, 104);
});

test("a planet whose richness was never read ranks below every one that was", () => {
  const result = propose(
    { [PILOT]: [making(1, RAW_A, 1), making(2, RAW_B, 2)] },
    [PILOT_ONE(1)],
    [planet(30, -0.5, [RAW_C]), planet(31, 0.4, [RAW_C])],
    { 31: { [RAW_C]: 60 } },
  );
  assert.equal(result.rows[0]!.planet.planetID, 31);
});

test("never a resource already drilled on that planet, nor a second colony for one pilot on one planet", () => {
  const result = propose(
    // Pilot One drills C on planet 40; Pilot Two has a colony on planet 41.
    {
      [PILOT]: [making(40, RAW_C, 3)],
      [OTHER_PILOT]: [making(41, RAW_A, 1)],
    },
    [{ characterID: OTHER_PILOT, name: "Pilot Two", freeSlots: 2, commandCenterLevel: 4 }],
    [planet(40, -0.3, [RAW_B, RAW_C]), planet(41, -0.3, [RAW_B, RAW_C]), planet(42, -0.3, [RAW_C])],
    { 40: { [RAW_C]: 150, [RAW_B]: 90 }, 41: { [RAW_C]: 140, [RAW_B]: 140 }, 42: { [RAW_C]: 100 } },
  );
  for (const row of result.rows) {
    assert.notEqual(`${row.planet.planetID}:${row.resourceTypeID}`, `40:${RAW_C}`, "C on 40 is already drilled");
    assert.notEqual(row.planet.planetID, 41, "Pilot Two is already on 41");
  }
  assert.equal(result.rows[0]!.commandCenterLevel, 4);
});

test("slots no basic can use are reported, not forced", () => {
  const result = propose({ [PILOT]: [making(1, RAW_A, 1)] }, [PILOT_ONE(3)], [planet(50, -0.3, [RAW_B])]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.unusedSlots, 2);
});

test("a saved row is built only when that pilot drills that resource on that planet", () => {
  const reads = readings({ [PILOT]: [making(60, RAW_A, 1)] });
  assert.equal(rowState({ characterID: PILOT, planetID: 60, resourceTypeID: RAW_A }, reads), "built");
  assert.equal(rowState({ characterID: PILOT, planetID: 60, resourceTypeID: RAW_B }, reads), "other-resource");
  assert.equal(rowState({ characterID: PILOT, planetID: 61, resourceTypeID: RAW_A }, reads), "not-built");
  assert.equal(rowState({ characterID: OTHER_PILOT, planetID: 60, resourceTypeID: RAW_A }, reads), "not-built");
});

test("command centres to buy count only what is not built, by planet type", () => {
  assert.deepEqual(
    commandCentresToBuy([
      { planetTypeName: "Planet (Temperate)", state: "not-built" },
      { planetTypeName: "Planet (Barren)", state: "not-built" },
      { planetTypeName: "Planet (Temperate)", state: "not-built" },
      { planetTypeName: "Planet (Gas)", state: "built" },
    ]),
    [{ planetTypeName: "Temperate", count: 2 }, { planetTypeName: "Barren", count: 1 }],
  );
});

test("the layout to copy is the roster's strongest single-basic colony at that level", () => {
  const strong = colony(70, 30000001, [extractor(RAW_A, 2500, 7), extractor(RAW_A, 2400, 7), factory(1), factory(1), factory(1), factory(1)]);
  const weak = colony(71, 30000001, [extractor(RAW_B, 3000, 10), factory(2)]);
  const reads = readings({ [PILOT]: [strong], [OTHER_PILOT]: [weak] });
  assert.equal(layoutToCopy(5, reads, NAMES)?.words, "Layout like Pilot One's Planet 70: 2 extractors (7 + 7 heads), 4 factories");
  assert.equal(layoutToCopy(4, reads, NAMES), null);
});

test("pilots with a read skill sheet get their free slots; the rest are listed apart, never planned for", () => {
  const reads = readings({ [PILOT]: [making(1, RAW_A, 1), making(2, RAW_B, 2)] });
  const withSkills = new Map(reads);
  withSkills.set(PILOT, { ...reads.get(PILOT)!, planetSkills: { consolidation: 4, commandCenterUpgrades: 5 } });
  withSkills.set(OTHER_PILOT, { characterID: OTHER_PILOT, readAtMs: NOW, report: { colonies: [], coloniesReadable: true, clockOffsetMs: 0 } });
  const result = expansionPilots([PILOT, OTHER_PILOT], withSkills, NAMES);
  assert.deepEqual(result.pilots, [{ characterID: PILOT, name: "Pilot One", freeSlots: 3, commandCenterLevel: 5 }]);
  assert.deepEqual(result.unknown, [OTHER_PILOT]);
});

test("home systems are the systems the roster works, busiest first", () => {
  const reads = readings({
    [PILOT]: [making(1, RAW_A, 1, 3000, 30000001), making(2, RAW_B, 2, 3000, 30000002)],
    [OTHER_PILOT]: [making(3, RAW_C, 3, 3000, 30000002)],
  });
  assert.deepEqual(homeSystems(reads).map((system) => [system.solarSystemID, system.colonies]), [[30000002, 2], [30000001, 1]]);
});

test("a plan's rows group by pilot, named and placed, each with its live state", () => {
  const reads = readings({ [PILOT]: [making(80, RAW_A, 1)] });
  const groups = expansionGroups(
    [
      { characterID: PILOT, planetID: 80, resourceTypeID: RAW_A, productTypeID: BASIC_A },
      { characterID: OTHER_PILOT, planetID: 81, resourceTypeID: RAW_B, productTypeID: BASIC_B },
      { characterID: PILOT, planetID: 82, resourceTypeID: RAW_C, productTypeID: BASIC_C },
    ],
    new Map([[80, planet(80, -0.27, [RAW_A], 1)], [81, planet(81, 0.33, [RAW_B], 2)]]),
    new Map([[80, new Map([[RAW_A, 141]])]]),
    reads,
    NAMES,
    BOOK,
  );
  assert.deepEqual(groups.map((group) => [group.pilotName, group.rows.length]), [["Pilot One", 2], ["Pilot Two", 1]]);
  const [first, missing] = groups[0]!.rows;
  assert.equal(first!.state, "built");
  assert.equal(first!.quality, 141);
  assert.equal(first!.placeWords, "1 jump, -0.27");
  assert.equal(first!.planetTypeName, "Barren");
  assert.equal(first!.productName, "Basic A");
  assert.equal(missing!.planetName, "A planet out of reach of this plan's map");
  assert.equal(groups[1]!.rows[0]!.state, "not-built");
});
