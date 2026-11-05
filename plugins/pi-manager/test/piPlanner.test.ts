// The planner's proof (R108 slice 5): held stock is taken off before inputs are
// worked out, every shortfall is named as one of the three gaps, in order, and the
// chain is drawn as a tree whose colours and tags say how each step stands.
//
// Most cases run on a hand-built book so every number is known in advance; the
// real-table case at the end checks the netting against the emulator's own
// recipes and SKIPS when that table is not on this machine.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { decodeRecipeBook, type PiCommodity, type PiRecipeBook, type PiSchematic, type PiTier } from "../../../web/src/bridge/piRecipes.ts";
import type { JsonValue } from "../../../web/src/bridge/wire.ts";
import type { Colony, ColonyPin } from "../../../web/src/store/types.ts";
import type { Holding } from "../../../web/src/bridge/stockHoldings.ts";
import { missingByTier, planStepCounts, planWithStock, type PlannerColony, type PlannerInput } from "../lib/piPlanner.ts";

// --- a small book with known numbers ---------------------------------------

const RAW_A = 100;
const RAW_B = 101;
const P1_A = 200;
const P1_B = 201;
const P2_C = 300;
const P2_X = 301;
const P3_Y = 400;
const BASIC_FACTORY = 2473;
const ADVANCED_FACTORY = 2474;
const HOUR = 3_600_000;

function recipe(
  schematicID: number,
  name: string,
  inputs: readonly [number, number][],
  output: [number, number],
  factoryTypeID: number,
  cycleTimeSeconds: number,
): PiSchematic {
  return {
    schematicID,
    name,
    cycleTimeSeconds,
    factoryTypeIDs: [factoryTypeID],
    inputs: inputs.map(([typeID, quantity]) => ({ typeID, typeName: null, quantity })),
    output: { typeID: output[0], typeName: name, quantity: output[1] },
  };
}

const SCHEMATICS = [
  recipe(1, "Alpha", [[RAW_A, 3000]], [P1_A, 20], BASIC_FACTORY, 1800),
  recipe(2, "Beta", [[RAW_B, 3000]], [P1_B, 20], BASIC_FACTORY, 1800),
  recipe(3, "Gamma", [[P1_A, 40], [P1_B, 40]], [P2_C, 5], ADVANCED_FACTORY, 3600),
  recipe(4, "Xi", [[P1_A, 40], [P1_B, 40]], [P2_X, 5], ADVANCED_FACTORY, 3600),
  recipe(5, "Upsilon", [[P2_C, 10], [P2_X, 10]], [P3_Y, 3], ADVANCED_FACTORY, 3600),
] as const;
const [, , GAMMA_RECIPE, XI_RECIPE] = SCHEMATICS;

const TIERS: readonly [number, string, PiTier][] = [
  [RAW_A, "Raw A", 0],
  [RAW_B, "Raw B", 0],
  [P1_A, "Alpha", 1],
  [P1_B, "Beta", 1],
  [P2_C, "Gamma", 2],
  [P2_X, "Xi", 2],
  [P3_Y, "Upsilon", 3],
];

const BOOK: PiRecipeBook = {
  schematics: SCHEMATICS,
  bySchematicID: new Map(SCHEMATICS.map((row) => [row.schematicID, row])),
  byOutputTypeID: new Map(SCHEMATICS.map((row) => [row.output.typeID, row])),
  commodities: new Map<number, PiCommodity>(TIERS.map(([typeID, typeName, tier]) => [typeID, { typeID, typeName, tier }])),
  readable: true,
};

function pin(pinID: number, fields: Partial<ColonyPin>): ColonyPin {
  return {
    pinID,
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

function colony(planetID: number, planetName: string, pins: readonly ColonyPin[], resources: Colony["resources"] = null): PlannerColony {
  return {
    clockOffsetMs: 0,
    colony: {
      planetID,
      planetName,
      solarSystemID: 30000001,
      solarSystemName: "Alpha",
      planetTypeID: 2016,
      planetTypeName: "Planet (Lava)",
      commandCenterLevel: 4,
      lastSimulatedAtMs: null,
      pins,
      linkCount: 0,
      links: [],
      routes: [],
      resources,
    },
  };
}

function factory(pinID: number, typeID: number, schematic: PiSchematic | null): ColonyPin {
  return pin(pinID, {
    typeID,
    kind: "factory",
    schematicID: schematic?.schematicID ?? null,
    schematicName: schematic?.name ?? null,
  });
}

function extractor(pinID: number, resourceTypeID: number, quantityPerCycle: number, expiresAtMs: number | null): ColonyPin {
  return pin(pinID, {
    kind: "extractor-control",
    program: {
      resourceTypeID,
      resourceTypeName: null,
      cycleTimeSeconds: 1800,
      quantityPerCycle,
      installedAtMs: null,
      expiresAtMs,
      headCount: 4,
    },
  });
}

function held(typeID: number, quantity: number, source: Holding["source"] = "hangar", placeWords = "Station hangar"): Holding {
  return {
    typeID,
    typeName: null,
    quantity,
    source,
    placeWords,
    ownerWords: "Pilot One",
    planetID: null,
    readAtMs: null,
    clockOffsetMs: 0,
  };
}

const NOW = 1_800_000_000_000;

function plan(overrides: Partial<PlannerInput>) {
  const result = planWithStock({
    book: BOOK,
    targetTypeID: P2_C,
    quantity: 10,
    holdings: [],
    colonies: [],
    browserNowMs: NOW,
    ...overrides,
  });
  assert.ok(result);
  return result;
}

const rowOf = (result: ReturnType<typeof plan>, typeID: number) => result.rows.find((row) => row.typeID === typeID);

// --- netting -----------------------------------------------------------------

test("held stock is taken off BEFORE inputs are worked out", () => {
  // 10 Gamma, 5 held: one run of 5 is left, so 40 of each input — not 80.
  const result = plan({ holdings: [held(P2_C, 5)] });
  const target = rowOf(result, P2_C)!;
  assert.equal(target.needed, 10);
  assert.equal(target.held, 5);
  assert.equal(target.toMake, 5);
  assert.equal(target.runs, 1);
  assert.equal(rowOf(result, P1_A)!.needed, 40);
  assert.equal(rowOf(result, P1_B)!.needed, 40);
});

test("an input held in full stops the walk there: nothing below it is asked for", () => {
  const result = plan({ holdings: [held(P1_A, 100)] });
  const alpha = rowOf(result, P1_A)!;
  assert.equal(alpha.toMake, 0);
  assert.equal(alpha.runs, null);
  assert.equal(alpha.sourceWords, "held");
  assert.equal(rowOf(result, RAW_A), undefined, "no raw A is needed once Alpha is held");
  assert.ok(rowOf(result, RAW_B), "the other branch still expands");
});

test("held means everywhere: colony, hangar and corp hangar all count, and each keeps its place", () => {
  const result = plan({
    holdings: [
      held(P1_A, 10, "colony", "Alpha III launchpad"),
      held(P1_A, 15, "hangar", "Station hangar"),
      held(P1_A, 20, "corp", "Station office, division 3"),
    ],
  });
  const alpha = rowOf(result, P1_A)!;
  // 10 Gamma is 2 runs, so 80 Alpha: the 45 held everywhere leave 35.
  assert.equal(alpha.needed, 80);
  assert.equal(alpha.held, 45);
  assert.equal(alpha.toMake, 35);
  assert.deepEqual(alpha.holdings.map((holding) => holding.source), ["colony", "hangar", "corp"]);
});

test("what sits in a factory's input buffer is not counted: it is already committed", () => {
  const result = plan({
    holdings: [{ ...held(P1_A, 1000, "colony", "Alpha III factory input"), inFactory: true }, held(P1_A, 30)],
  });
  const alpha = rowOf(result, P1_A)!;
  assert.equal(alpha.held, 30);
  assert.equal(alpha.toMake, 50);
});

test("a commodity two branches share is one row, netted and rounded once", () => {
  // Upsilon needs Gamma and Xi, and both need Alpha: one Alpha row, whole need.
  const result = plan({ targetTypeID: P3_Y, quantity: 3 });
  const alphas = result.rows.filter((row) => row.typeID === P1_A);
  assert.equal(alphas.length, 1);
  // 1 run of Upsilon -> 10 Gamma (2 runs) + 10 Xi (2 runs) -> 80 + 80 Alpha.
  assert.equal(alphas[0]!.needed, 160);
  assert.equal(alphas[0]!.runs, 8);
  assert.deepEqual(result.rows.map((row) => row.depth), [...result.rows.map((row) => row.depth)].sort((a, b) => a - b));
  assert.equal(result.rows[0]!.typeID, P3_Y, "the target comes first");
});

// --- gaps ------------------------------------------------------------------

test("with no factory anywhere, the gap is 'nothing you own makes this'", () => {
  const result = plan({});
  const gamma = result.gaps.find((gap) => gap.typeID === P2_C)!;
  assert.equal(gamma.kind, "nothing-makes");
  assert.equal(gamma.headline, "Nothing you own makes Gamma.");
  assert.equal(result.covered, false);
});

test("a factory that could run the recipe but makes something else is named, with what it makes now", () => {
  const xi = XI_RECIPE;
  const result = plan({ colonies: [colony(1, "Alpha III", [factory(10, ADVANCED_FACTORY, xi)])] });
  const gamma = result.gaps.find((gap) => gap.typeID === P2_C)!;
  assert.equal(gamma.kind, "factory-busy");
  assert.equal(gamma.headline, "Alpha III could make Gamma.");
  assert.equal(gamma.detail, "Its factory makes Xi now.");
});

test("a factory making it gives the rate, labelled 'up to', and no gap", () => {
  const gammaRecipe = GAMMA_RECIPE;
  const result = plan({
    colonies: [colony(1, "Alpha III", [factory(10, ADVANCED_FACTORY, gammaRecipe), factory(11, ADVANCED_FACTORY, gammaRecipe)])],
    holdings: [held(P1_A, 1000), held(P1_B, 1000)],
  });
  const target = rowOf(result, P2_C)!;
  // Two factories, 5 a run, one run an hour each.
  assert.equal(target.sourceWords, "Alpha III (2), up to 10 an hour");
  assert.equal(target.coverWords, "1 hour at that rate");
  assert.equal(result.gaps.length, 0);
  assert.equal(result.covered, true);
  assert.match(result.verdict, /Nothing needs to change\.$/);
});

test("⚠ a factory set to the recipe but idle is not counted as making it", () => {
  // Live: the plan said a colony's factories were running while the game showed
  // them stopped - they kept their recipe with empty buffers.
  const running = { ...factory(10, ADVANCED_FACTORY, GAMMA_RECIPE), active: true };
  const idle = { ...factory(11, ADVANCED_FACTORY, GAMMA_RECIPE), active: false };
  const holdings = [held(P1_A, 1000), held(P1_B, 1000)];

  const mixed = rowOf(plan({ colonies: [colony(1, "Alpha III", [running, idle])], holdings }), P2_C)!;
  assert.equal(mixed.sourceWords, "Alpha III, up to 5 an hour; Alpha III idle");
  assert.equal(mixed.producers.reduce((total, producer) => total + producer.count, 0), 1);
  assert.ok(mixed.tags.some((tag) => tag.text === "idle Alpha III" && tag.tone === "act"));

  const allIdle = plan({ colonies: [colony(1, "Alpha III", [idle])], holdings });
  const target = rowOf(allIdle, P2_C)!;
  assert.equal(target.sourceWords, "Alpha III, set to it but idle now");
  assert.equal(target.coverWords, null);
  assert.equal(target.state, "act");
  // Nothing to switch or build, so not a gap - but not "nothing needs to change".
  assert.equal(allIdle.gaps.length, 0);
  assert.match(allIdle.verdict, /some factories are idle, waiting for inputs\.$/);

  // No state from the server (an older BFF): counted, as before.
  const unknown = rowOf(plan({ colonies: [colony(1, "Alpha III", [factory(10, ADVANCED_FACTORY, GAMMA_RECIPE)])], holdings }), P2_C)!;
  assert.equal(unknown.sourceWords, "Alpha III, up to 5 an hour");
});

test("slow production is not a gap: the row says how long the rest takes", () => {
  const colonies = [colony(1, "Alpha III", [factory(10, ADVANCED_FACTORY, GAMMA_RECIPE)])];
  const result = plan({ colonies, holdings: [held(P1_A, 1000), held(P1_B, 1000)], quantity: 50 });
  assert.equal(result.gaps.length, 0);
  assert.equal(rowOf(result, P2_C)!.coverWords, "10 hours at that rate");
});

test("a raw resource extracted nowhere names the colonised planets that carry it, richest first", () => {
  const colonies = [
    colony(1, "Alpha III", [], [{ typeID: RAW_B, typeName: "Raw B", quality: 96 }]),
    colony(2, "Alpha V", [], [{ typeID: RAW_B, typeName: "Raw B", quality: 140 }]),
  ];
  const result = plan({ colonies, holdings: [held(P1_A, 1000)] });
  const raw = result.gaps.find((gap) => gap.typeID === RAW_B)!;
  assert.equal(raw.kind, "not-extracted");
  assert.equal(raw.headline, "Nothing you own extracts Raw B.");
  assert.equal(raw.detail, "Alpha V (Lava) at quality 140 and Alpha III (Lava) at quality 96 carry it.");
});

test("an extractor whose program has ended is not a producer, and the gap says it ended", () => {
  const colonies = [colony(1, "Alpha III", [extractor(20, RAW_B, 6000, NOW - HOUR)])];
  const result = plan({ colonies, holdings: [held(P1_A, 1000)] });
  const raw = result.gaps.find((gap) => gap.typeID === RAW_B)!;
  assert.equal(raw.headline, "Raw B is extracted nowhere right now.");
  assert.equal(raw.detail, "Its program on Alpha III has ended. None of your colonised planets carries it.");
});

test("a running extractor's rate is the server's, for the installed program", () => {
  const colonies = [colony(1, "Alpha III", [extractor(20, RAW_B, 6000, NOW + HOUR)])];
  const result = plan({ colonies, holdings: [held(P1_A, 1000)] });
  assert.equal(rowOf(result, RAW_B)!.sourceWords, "Alpha III, 12,000 an hour on the installed program");
});

test("gaps come in the order worth telling: makes-nothing, busy factory, not extracted", () => {
  // Upsilon: no factory runs it (nothing-makes); Xi's advanced factory could
  // make Gamma (busy); Raw B is carried but not extracted.
  const xi = XI_RECIPE;
  const colonies = [
    colony(1, "Alpha III", [factory(10, ADVANCED_FACTORY, xi)], [{ typeID: RAW_B, typeName: null, quality: 50 }]),
  ];
  const result = plan({ targetTypeID: P3_Y, quantity: 3, colonies, holdings: [held(P1_A, 1000)] });
  const kinds = result.gaps.map((gap) => gap.kind);
  assert.deepEqual(kinds, [...kinds].sort((left, right) =>
    ["nothing-makes", "factory-busy", "not-extracted"].indexOf(left)
      - ["nothing-makes", "factory-busy", "not-extracted"].indexOf(right)));
  assert.equal(kinds[0], "nothing-makes");
  assert.equal(kinds.at(-1), "not-extracted");
  // Every gap is numbered on its row.
  const numbered = result.rows.filter((row) => row.gapNumber !== null).map((row) => row.gapNumber).sort();
  assert.deepEqual(numbered, result.gaps.map((_, index) => index + 1));
});

test("holding the target outright is the fifth kind: nothing needs to change", () => {
  const result = plan({ holdings: [held(P2_C, 12)] });
  assert.equal(result.verdict, "You hold 12 Gamma already. Nothing needs to change.");
  assert.equal(result.covered, true);
  assert.equal(result.rows.length, 1);
});

test("a nonsensical request is null, as resolveChain's is", () => {
  assert.equal(planWithStock({ book: BOOK, targetTypeID: P2_C, quantity: 0, holdings: [], colonies: [], browserNowMs: NOW }), null);
});

// --- the tree, the tags and the colours --------------------------------------

test("the tree puts each input under what it is used for, and a shared one is drawn once in full", () => {
  const result = plan({ targetTypeID: P3_Y, quantity: 3 });
  const tree = result.tree;
  assert.equal(tree.row.typeID, P3_Y);
  assert.deepEqual(tree.children.map((child) => child.row.typeID), [P2_C, P2_X]);
  const [gamma, xi] = tree.children;
  // Alpha is under Gamma in full, and under Xi only as a repeat with no inputs.
  const alphaUnderGamma = gamma!.children.find((child) => child.row.typeID === P1_A)!;
  const alphaUnderXi = xi!.children.find((child) => child.row.typeID === P1_A)!;
  assert.equal(alphaUnderGamma.repeat, false);
  assert.ok(alphaUnderGamma.children.length > 0);
  assert.equal(alphaUnderXi.repeat, true);
  assert.equal(alphaUnderXi.children.length, 0);
  assert.notEqual(alphaUnderGamma.key, alphaUnderXi.key);
});

test("a step is green, amber or red, and a parent knows the worst below it", () => {
  const colonies = [
    colony(1, "Alpha III", [factory(10, ADVANCED_FACTORY, XI_RECIPE)], [{ typeID: RAW_B, typeName: null, quality: 50 }]),
  ];
  const result = plan({ colonies, holdings: [held(P1_A, 1000)] });
  assert.equal(rowOf(result, P1_A)!.state, "ok");
  assert.equal(rowOf(result, P2_C)!.state, "act", "a factory that could be switched");
  assert.equal(rowOf(result, RAW_B)!.state, "bad");
  assert.equal(result.tree.worst, "bad");
});

test("tags are short; the sentence rides along as the title", () => {
  const colonies = [
    colony(1, "Alpha III", [factory(10, ADVANCED_FACTORY, XI_RECIPE)], [{ typeID: RAW_B, typeName: null, quality: 50 }]),
    colony(2, "Alpha V", [factory(11, BASIC_FACTORY, SCHEMATICS[0])]),
  ];
  const result = plan({ colonies, holdings: [held(P1_B, 1000)] });
  const tagsOf = (typeID: number) => rowOf(result, typeID)!.tags.map((tag) => [tag.text, tag.tone]);
  assert.deepEqual(tagsOf(P2_C), [["switch Alpha III", "act"], ["now Xi", null]]);
  assert.deepEqual(tagsOf(P1_A), [["Alpha V", null], ["40/h", null]]);
  assert.deepEqual(tagsOf(RAW_A), [["no extractor", "bad"]]);
  assert.match(rowOf(result, P2_C)!.tags[0]!.title!, /^Alpha III could make Gamma\. Its factory makes Xi now\.$/);
  const noFactory = plan({}).rows[0]!.tags;
  assert.deepEqual(noFactory.map((tag) => tag.text), ["no factory"]);
});

test("the missing summary runs raw first, blocked first, and leaves out what is held", () => {
  const colonies = [
    colony(1, "Alpha III", [factory(10, ADVANCED_FACTORY, XI_RECIPE), extractor(20, RAW_B, 100, null)]),
  ];
  // Beta held in full: neither it nor Raw B is missing.
  const result = plan({ targetTypeID: P3_Y, quantity: 3, colonies, holdings: [held(P1_B, 1000)] });
  const summary = missingByTier(result).map((entry) => [entry.tier, entry.rows.map((row) => row.typeName)]);
  assert.deepEqual(summary, [
    [0, ["Raw A"]],
    [1, ["Alpha"]],
    [2, ["Gamma", "Xi"]],
    [3, ["Upsilon"]],
  ]);
  const p2 = missingByTier(result).find((entry) => entry.tier === 2)!;
  assert.deepEqual(p2.rows.map((row) => row.state), ["act", "ok"], "the factory switch before what is already made");
});

test("step counts are one per commodity, by state, and add up to the steps", () => {
  const colonies = [
    colony(1, "Alpha III", [factory(10, ADVANCED_FACTORY, XI_RECIPE), extractor(20, RAW_B, 100, null)]),
  ];
  const result = plan({ targetTypeID: P3_Y, quantity: 3, colonies, holdings: [held(P1_B, 1000)] });
  const counts = planStepCounts(result);
  assert.equal(counts.steps, result.rows.length);
  assert.equal(counts.ok + counts.act + counts.bad, counts.steps);
  assert.equal(counts.act, result.rows.filter((row) => row.state === "act").length);
  assert.ok(counts.act >= 1, "the idle factory is a change you can make");
});

// --- the real table ---------------------------------------------------------

const EVE_ROOT = process.env.EVEJS_ROOT ?? "D:/evet";
const REAL_DATA_PATH = `${EVE_ROOT}/_local/gameStore/data/planetSchematics/data.json`;

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
  return decodeRecipeBook({
    schematics: parsed.schematics.map((row) => ({
      schematicID: row.schematicID,
      name: row.name,
      cycleTimeSeconds: row.cycleTime,
      factoryTypeIDs: row.pinTypeIDs,
      inputs: row.inputs,
      output: row.outputs[0] ?? null,
    })),
  } as unknown as JsonValue);
}

test("real table: Robotics nets held stock before expanding, and names every missing raw resource", (t) => {
  const book = loadRealBook();
  if (book === null) {
    t.skip(`real recipe table not found at ${REAL_DATA_PATH}`);
    return;
  }
  const robotics = book.schematics.find((row) => row.name === "Robotics")!;
  const firstInput = robotics.inputs[0]!;
  const secondInput = robotics.inputs[1]!;
  // 6 Robotics = 2 runs = 20 of each input. Hold 12 of the first: 8 are left.
  const result = planWithStock({
    book,
    targetTypeID: robotics.output.typeID,
    quantity: 6,
    holdings: [held(firstInput.typeID, 12)],
    colonies: [],
    browserNowMs: NOW,
  })!;
  const first = result.rows.find((row) => row.typeID === firstInput.typeID)!;
  const second = result.rows.find((row) => row.typeID === secondInput.typeID)!;
  assert.equal(first.needed, 20);
  assert.equal(first.toMake, 8);
  assert.equal(second.toMake, 20);
  // The first input's own recipe is taken for 8, not 20.
  const firstRecipe = book.byOutputTypeID.get(firstInput.typeID)!;
  assert.equal(first.runs, Math.ceil(8 / firstRecipe.output.quantity));
  // With no colonies at all, every leaf is a raw resource extracted nowhere.
  const leaves = result.rows.filter((row) => row.madeBy === null);
  assert.ok(leaves.length > 0);
  for (const leaf of leaves) {
    assert.equal(result.gaps.find((gap) => gap.typeID === leaf.typeID)?.kind, "not-extracted");
  }
});
