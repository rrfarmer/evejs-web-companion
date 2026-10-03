// R109 slice 1: the industry resolver. Each case below is written to FAIL
// against the obvious wrong implementation it names, not merely to agree with
// this one. The real-table cases at the bottom drive it through the BFF's own
// index over the real blueprint table, so the wire shape is not re-imagined
// here.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { decodeBlueprintSearch, decodeRecipeClosure, EMPTY_INDUSTRY_BOOK } from "./industryRecipes.ts";
import type { IndustryRecipeBook } from "./industryRecipes.ts";
import {
  assumedTerms,
  materialQuantity,
  resolveIndustryChain,
  shortLines,
  splitRuns,
} from "./industryChain.ts";
import type { IndustryChain, IndustryLine } from "./industryChain.ts";
import type { JsonValue } from "./wire.ts";

// Types in the hand-written book:
//   900 Widget II  <- 1x Widget(101) + 5x Plate(203)      (T2, invented, 10 runs/copy)
//   101 Widget     <- 10x Tritanium(201) + 2x Gizmo(102)
//   102 Gizmo      <- 100x Goo(202), 200 per run           (reaction)
//   203 Plate      <- 3x Tritanium(201)
//   205 Guidance   planetary commodity, no recipe
const WIRE = {
  recipes: [
    {
      productTypeID: 900, activity: "manufacturing", blueprintTypeID: 1900,
      blueprintName: "Widget II Blueprint", quantityPerRun: 1, timeSeconds: 900, maxRunsPerBlueprint: 10,
      materials: [{ typeID: 101, quantity: 1 }, { typeID: 203, quantity: 5 }, { typeID: 205, quantity: 1 }],
      inventedFrom: [{
        blueprintTypeID: 1101, blueprintName: "Widget Blueprint", runsPerCopy: 10,
        probability: 0.34, timeSeconds: 7800, materials: [{ typeID: 301, quantity: 2 }],
      }],
    },
    {
      productTypeID: 101, activity: "manufacturing", blueprintTypeID: 1101,
      blueprintName: "Widget Blueprint", quantityPerRun: 1, timeSeconds: 600, maxRunsPerBlueprint: 300,
      materials: [{ typeID: 201, quantity: 10 }, { typeID: 102, quantity: 2 }], inventedFrom: [],
    },
    {
      productTypeID: 102, activity: "reaction", blueprintTypeID: 1102,
      blueprintName: "Gizmo Reaction Formula", quantityPerRun: 200, timeSeconds: 10800, maxRunsPerBlueprint: null,
      materials: [{ typeID: 202, quantity: 100 }], inventedFrom: [],
    },
    {
      productTypeID: 203, activity: "manufacturing", blueprintTypeID: 1203,
      blueprintName: "Plate Blueprint", quantityPerRun: 1, timeSeconds: 60, maxRunsPerBlueprint: 1000,
      materials: [{ typeID: 201, quantity: 3 }], inventedFrom: [],
    },
  ],
  types: {
    900: { name: "Widget II", groupID: 11, categoryID: 7 },
    101: { name: "Widget", groupID: 11, categoryID: 7 },
    102: { name: "Gizmo", groupID: 12, categoryID: 4 },
    201: { name: "Tritanium", groupID: 18, categoryID: 4 },
    202: { name: "Goo", groupID: 19, categoryID: 4 },
    203: { name: "Plate", groupID: 20, categoryID: 17 },
    205: { name: "Guidance Systems", groupID: 1040, categoryID: 43 },
    301: null,
  },
  missing: [],
  capped: false,
};

const BOOK = decodeRecipeClosure(WIRE as unknown as JsonValue);

function line(chain: IndustryChain | null, typeID: number): IndustryLine {
  assert.ok(chain);
  const found = chain.lines.get(typeID);
  assert.ok(found, `type ${typeID} has a line`);
  return found;
}

// --- the decoder -----------------------------------------------------------

test("the closure decodes into maps; an unnamed type is simply absent, never 'Type 301'", () => {
  assert.equal(BOOK.readable, true);
  assert.equal(BOOK.byProduct.get(102)?.activity, "reaction");
  assert.equal(BOOK.byProduct.get(900)?.inventedFrom[0]?.runsPerCopy, 10);
  assert.equal(BOOK.types.get(201)?.name, "Tritanium");
  assert.equal(BOOK.types.has(301), false);
});

test("an answer with no recipe list is unreadable, not empty", () => {
  assert.equal(decodeRecipeClosure({ ok: false } as unknown as JsonValue).readable, false);
  assert.equal(decodeRecipeClosure({ recipes: [] } as unknown as JsonValue).readable, true);
});

test("search hits with no name or an unknown activity are dropped", () => {
  const result = decodeBlueprintSearch({
    matches: [
      { blueprintTypeID: 1, blueprintName: "Widget Blueprint", productTypeID: 2, productName: "Widget", activity: "manufacturing" },
      { blueprintTypeID: 3, blueprintName: null, productTypeID: 4, activity: "manufacturing" },
      { blueprintTypeID: 5, blueprintName: "Copy", productTypeID: 6, activity: "copying" },
    ],
    total: 3,
    capped: false,
  } as unknown as JsonValue);
  assert.deepEqual(result.matches.map((match) => match.blueprintTypeID), [1]);
  assert.equal(result.total, 3);
});

// --- the formula -----------------------------------------------------------

test("materialQuantity: rounds to hundredths BEFORE the ceil, as the server does", () => {
  // 67 x 3 x 0.99 (ME 1) x 0.99 (a facility) = 197.0001. A bare ceil says 198;
  // the server consumes 197.
  assert.equal(materialQuantity(67, 3, 0.99 * 0.99), 197);
  assert.equal(materialQuantity(10, 10, 0.98), 98);
});

test("materialQuantity: never less than one unit per run", () => {
  // 1 x 10 x 0.9 = 9, but a run cannot consume less than one.
  assert.equal(materialQuantity(1, 10, 0.9), 10);
  assert.equal(materialQuantity(5, 0, 1), 0);
});

test("splitRuns: even, larger jobs first, never more jobs than runs", () => {
  assert.deepEqual(splitRuns(10, 3), [4, 3, 3]);
  assert.deepEqual(splitRuns(2, 5), [1, 1]);
  assert.deepEqual(splitRuns(7, 0), [7]);
  assert.deepEqual(splitRuns(0, 2), []);
});

// --- the resolver ----------------------------------------------------------

test("a whole tree, unowned: the T2 copy is assumed ME 2 and its invented copies are counted", () => {
  const chain = resolveIndustryChain({ book: BOOK, productTypeID: 900, runs: 10 });
  const top = line(chain, 900);
  assert.equal(top.obtain, "build");
  assert.equal(top.made, 10);
  assert.equal(top.blueprint?.assumed, true);
  assert.equal(top.blueprint?.materialEfficiency, 2);
  assert.deepEqual(top.blueprint?.invention && {
    copies: top.blueprint.invention.copies,
    runsPerCopy: top.blueprint.invention.runsPerCopy,
  }, { copies: 1, runsPerCopy: 10 });
  // 5 Plate x 10 runs x 0.98 = 49.
  assert.equal(top.materials.get(203), 49);
  // A T1 blueprint nobody owns is taken as unresearched.
  assert.equal(line(chain, 101).blueprint?.materialEfficiency, 0);
  assert.equal(line(chain, 101).blueprint?.invention, null);
});

test("a type under two parents is worked ONCE: Tritanium is summed, then each recipe rounds once", () => {
  const chain = resolveIndustryChain({ book: BOOK, productTypeID: 900, runs: 10 });
  // Widget: 10 runs x 10 = 100. Plate: 49 runs x 3 = 147.
  assert.equal(line(chain, 201).needed, 247);
  assert.equal(line(chain, 201).obtain, "buy");
  assert.equal(line(chain, 201).buyReason, "no-recipe");
  // Drawn twice in the tree would be fine; WORKED twice would not.
  assert.ok(chain);
  assert.equal(chain.order.filter((typeID) => typeID === 201).length, 1);
});

test("a reaction is made in whole runs and the surplus is shown, not hidden", () => {
  const chain = resolveIndustryChain({ book: BOOK, productTypeID: 900, runs: 10 });
  const gizmo = line(chain, 102);
  assert.equal(gizmo.obtain, "react");
  assert.equal(gizmo.needed, 20);
  assert.equal(gizmo.runs, 1);
  assert.equal(gizmo.made, 200);
  assert.equal(gizmo.leftover, 180);
  // A reaction has no material efficiency, even if a blueprint term says so.
  const withTerms = resolveIndustryChain({
    book: BOOK, productTypeID: 900, runs: 10,
    choices: { blueprints: new Map([[1102, { materialEfficiency: 10, timeEfficiency: 20, owned: true }]]) },
  });
  assert.equal(line(withTerms, 102).materials.get(202), 100);
});

test("two jobs consume more than one: rounding is per job, so the split is part of the plan", () => {
  const book = decodeRecipeClosure({
    recipes: [{
      productTypeID: 1, activity: "manufacturing", blueprintTypeID: 11, blueprintName: "Thing Blueprint",
      quantityPerRun: 1, materials: [{ typeID: 2, quantity: 3 }], inventedFrom: [],
    }],
    types: {},
  } as unknown as JsonValue);
  const terms = new Map([[11, { materialEfficiency: 10, timeEfficiency: 0, owned: true }]]);
  const one = resolveIndustryChain({ book, productTypeID: 1, runs: 10, choices: { blueprints: terms } });
  const two = resolveIndustryChain({
    book, productTypeID: 1, runs: 10,
    choices: { blueprints: terms, jobs: new Map([[1, 2]]) },
  });
  // 3 x 10 x 0.9 = 27 in one job; 3 x 5 x 0.9 = 13.5 -> 14, twice = 28.
  assert.equal(line(one, 2).needed, 27);
  assert.equal(line(two, 2).needed, 28);
  assert.deepEqual(line(two, 1).jobRuns, [5, 5]);
});

test("stock of an intermediate is used before building it, and its subtree shrinks to match", () => {
  const chain = resolveIndustryChain({
    book: BOOK, productTypeID: 900, runs: 10,
    held: new Map([[101, 4]]),
  });
  const widget = line(chain, 101);
  assert.equal(widget.needed, 10);
  assert.equal(widget.held, 4);
  assert.equal(widget.short, 6);
  assert.equal(widget.runs, 6);
  // Only the six built Widgets ask for Gizmos: 6 x 2 = 12.
  assert.equal(line(chain, 102).needed, 12);
});

test("the target is never netted: ten held do not make a plan to build ten done", () => {
  const chain = resolveIndustryChain({
    book: BOOK, productTypeID: 900, runs: 10,
    held: new Map([[900, 10]]),
  });
  assert.equal(line(chain, 900).held, 0);
  assert.equal(line(chain, 900).runs, 10);
});

test("buying an intermediate collapses its subtree", () => {
  const chain = resolveIndustryChain({
    book: BOOK, productTypeID: 900, runs: 10,
    choices: { obtain: new Map([[101, "buy" as const]]) },
  });
  const widget = line(chain, 101);
  assert.equal(widget.obtain, "buy");
  assert.equal(widget.buyReason, "chosen");
  assert.equal(widget.canBuild, true);
  assert.equal(widget.short, 10);
  assert.ok(chain);
  assert.equal(chain.lines.has(102), false, "nothing asks for Gizmos any more");
  // Tritanium now comes from Plates alone.
  assert.equal(line(chain, 201).needed, 147);
});

test("an owned blueprint's terms are used and nothing is called assumed or invented", () => {
  const chain = resolveIndustryChain({
    book: BOOK, productTypeID: 900, runs: 10,
    choices: { blueprints: new Map([[1900, { materialEfficiency: 0, timeEfficiency: 0, owned: true }]]) },
  });
  const top = line(chain, 900);
  assert.equal(top.blueprint?.assumed, false);
  assert.equal(top.blueprint?.invention, null);
  assert.equal(top.materials.get(203), 50);
});

test("a facility modifier multiplies with efficiency, for its own blueprint only", () => {
  const widgetBlueprint = BOOK.byProduct.get(101)!.blueprintTypeID;
  const gooFormula = BOOK.byProduct.get(102)!.blueprintTypeID;
  const chain = resolveIndustryChain({
    book: BOOK, productTypeID: 900, runs: 10,
    choices: { materialModifiers: new Map([[widgetBlueprint, 0.99]]) },
  });
  // Widget, unresearched: 10 Tritanium x 10 runs x 0.99 = 99, not 100.
  assert.equal(line(chain, 101).materials.get(201), 99);
  // Goo runs elsewhere: the Widget's facility leaves it alone.
  assert.equal(line(chain, 102).materials.get(202), 100);
  const reacted = resolveIndustryChain({
    book: BOOK, productTypeID: 900, runs: 10,
    choices: { materialModifiers: new Map([[gooFormula, 0.9]]) },
  });
  assert.equal(line(reacted, 102).materials.get(202), 90);
  assert.equal(line(reacted, 101).materials.get(201), 100);
});

test("a planetary commodity is a leaf, marked so it can be handed to Planetary Industry", () => {
  const chain = resolveIndustryChain({ book: BOOK, productTypeID: 900, runs: 10 });
  const guidance = line(chain, 205);
  assert.equal(guidance.planetary, true);
  assert.equal(guidance.obtain, "buy");
  assert.equal(line(chain, 201).planetary, false);
});

test("the tree: keys are paths, quantities are what each parent consumes, a second appearance is a repeat", () => {
  const book = decodeRecipeClosure({
    recipes: [
      { productTypeID: 1, activity: "manufacturing", blueprintTypeID: 11, quantityPerRun: 1,
        materials: [{ typeID: 2, quantity: 1 }, { typeID: 3, quantity: 1 }], inventedFrom: [] },
      { productTypeID: 2, activity: "manufacturing", blueprintTypeID: 12, quantityPerRun: 1,
        materials: [{ typeID: 3, quantity: 2 }], inventedFrom: [] },
      { productTypeID: 3, activity: "manufacturing", blueprintTypeID: 13, quantityPerRun: 1,
        materials: [{ typeID: 4, quantity: 5 }], inventedFrom: [] },
    ],
    types: {},
  } as unknown as JsonValue);
  const chain = resolveIndustryChain({ book, productTypeID: 1, runs: 1 });
  assert.ok(chain);
  const [two, three] = chain.root.children;
  assert.ok(two && three);
  const underTwo = two.children[0];
  assert.ok(underTwo);
  assert.equal(two.key, "1>2");
  assert.equal(underTwo.key, "1>2>3");
  assert.equal(underTwo.quantity, 2);
  assert.equal(underTwo.repeat, false);
  assert.equal(three.key, "1>3");
  assert.equal(three.quantity, 1);
  assert.equal(three.repeat, true);
  assert.equal(three.children.length, 0);
  // The line under both is the one worked total: 2 + 1.
  assert.equal(three.line.needed, 3);
});

test("a cycle is refused, not followed", () => {
  const book = decodeRecipeClosure({
    recipes: [
      { productTypeID: 1, activity: "manufacturing", blueprintTypeID: 11, quantityPerRun: 1,
        materials: [{ typeID: 2, quantity: 1 }], inventedFrom: [] },
      { productTypeID: 2, activity: "manufacturing", blueprintTypeID: 12, quantityPerRun: 1,
        materials: [{ typeID: 3, quantity: 1 }], inventedFrom: [] },
      { productTypeID: 3, activity: "manufacturing", blueprintTypeID: 13, quantityPerRun: 1,
        materials: [{ typeID: 2, quantity: 1 }], inventedFrom: [] },
    ],
    types: {},
  } as unknown as JsonValue);
  const chain = resolveIndustryChain({ book, productTypeID: 1, runs: 1 });
  assert.ok(chain);
  assert.equal(line(chain, 2).buyReason, "cycle");
  assert.equal(chain.lines.has(3), false);
});

test("nonsense in, null out; a target nothing makes is a single bought line", () => {
  assert.equal(resolveIndustryChain({ book: BOOK, productTypeID: 900, runs: 0 }), null);
  assert.equal(resolveIndustryChain({ book: BOOK, productTypeID: 0, runs: 1 }), null);
  const nothing = resolveIndustryChain({ book: EMPTY_INDUSTRY_BOOK, productTypeID: 201, runs: 3 });
  assert.equal(line(nothing, 201).obtain, "buy");
  assert.equal(line(nothing, 201).short, 3);
});

test("shortLines lists what is missing, deepest first", () => {
  const chain = resolveIndustryChain({ book: BOOK, productTypeID: 900, runs: 10 });
  assert.ok(chain);
  const order = shortLines(chain).map((entry) => entry.typeID);
  assert.equal(order[order.length - 1], 900);
  assert.ok(order.indexOf(202) < order.indexOf(102), "Goo before the Gizmo made of it");
});

test("assumedTerms: an invented copy is ME 2 / TE 4, anything else ME 0 / TE 0", () => {
  assert.deepEqual(assumedTerms(BOOK.byProduct.get(900)!), { materialEfficiency: 2, timeEfficiency: 4, owned: false });
  assert.deepEqual(assumedTerms(BOOK.byProduct.get(101)!), { materialEfficiency: 0, timeEfficiency: 0, owned: false });
});

// --- the real table, through the BFF's own index ----------------------------

const require = createRequire(import.meta.url);
const EVE_ROOT = process.env.EVEJS_ROOT ?? "D:/evet";
const DATA_DIR = process.env.EVEJS_GAMESTORE_DATA_DIR ?? `${EVE_ROOT}/_local/gameStore/data`;
const SERVER_MODULE = new URL("../../../src/industryRecipes.js", import.meta.url);

function loadRealBook(productTypeName: string): { book: IndustryRecipeBook; productTypeID: number } | null {
  if (!existsSync(`${DATA_DIR}/industryBlueprints/data.json`) || !existsSync(SERVER_MODULE)) {
    return null;
  }
  const recipes = require(fileURLToPath(SERVER_MODULE));
  const raw = JSON.parse(readFileSync(`${DATA_DIR}/industryBlueprints/data.json`, "utf8"));
  const index = recipes.buildIndustryRecipeIndex(raw.blueprintDefinitions);
  const target = [...index.byProduct.values()].find(
    (recipe: { blueprintName: string | null }) => recipe.blueprintName === `${productTypeName} Blueprint`,
  );
  if (!target) {
    return null;
  }
  const closure = recipes.recipeClosure(index, [target.productTypeID]);
  const book = decodeRecipeClosure({ ...closure, types: {} } as unknown as JsonValue);
  return { book, productTypeID: target.productTypeID };
}

const REAL = loadRealBook("Hobgoblin II");
const SKIP_REAL = REAL === null ? "real blueprint table or BFF module not present" : false;

test("real table: Hobgoblin II, ten runs, reaches reactions and fuel blocks with nothing left as a stray buy", { skip: SKIP_REAL }, () => {
  assert.ok(REAL);
  const chain = resolveIndustryChain({ book: REAL.book, productTypeID: REAL.productTypeID, runs: 10 });
  assert.ok(chain);
  const lines = [...chain.lines.values()];
  assert.ok(lines.some((entry) => entry.obtain === "react"), "composites are reacted, not bought");
  // Every bought line is genuinely unmakeable by default.
  for (const entry of lines.filter((candidate) => candidate.obtain === "buy")) {
    assert.equal(entry.buyReason, "no-recipe");
  }
  const top = line(chain, REAL.productTypeID);
  assert.equal(top.blueprint?.invention?.copies, 1, "ten runs from one ten-run invented copy");
  // Every built line makes at least what it is short.
  for (const entry of lines.filter((candidate) => candidate.obtain !== "buy")) {
    assert.ok(entry.made >= entry.short, `${entry.typeID} makes enough`);
  }
});

// --- slice 5: units already in production ------------------------------------

test("a running job covers its type after stock, and the subtree shrinks to what is left", () => {
  const chain = resolveIndustryChain({
    book: BOOK, productTypeID: 900, runs: 10,
    held: new Map([[101, 4]]),
    inProduction: new Map([[101, 3]]),
  });
  const widget = line(chain, 101);
  assert.equal(widget.held, 4);
  assert.equal(widget.inProduction, 3);
  assert.equal(widget.short, 3);
  assert.equal(widget.runs, 3);
  // Only the three still to build ask for Gizmos: 3 x 2.
  assert.equal(line(chain, 102).needed, 6);
});

test("runs of the target already installed are not started again, and their materials are spent", () => {
  const chain = resolveIndustryChain({
    book: BOOK, productTypeID: 900, runs: 10,
    inProduction: new Map([[900, 4]]),
  });
  const top = line(chain, 900);
  assert.equal(top.needed, 10);
  assert.equal(top.inProduction, 4);
  assert.equal(top.runs, 6);
  assert.equal(line(chain, 101).needed, 6);
  assert.ok(chain);
  assert.equal(chain.root.quantity, 10, "the root still says what the plan makes");
  const all = resolveIndustryChain({ book: BOOK, productTypeID: 900, runs: 10, inProduction: new Map([[900, 10]]) });
  assert.equal(line(all, 900).short, 0);
  assert.equal(line(all, 900).runs, 0);
  assert.equal(line(all, 900).materials.size, 0);
});

test("a job for something the plan buys does not count: buying is not building", () => {
  const chain = resolveIndustryChain({
    book: BOOK, productTypeID: 900, runs: 10,
    choices: { obtain: new Map([[101, "buy" as const]]) },
    inProduction: new Map([[101, 5]]),
  });
  assert.equal(line(chain, 101).inProduction, 0);
  assert.equal(line(chain, 101).short, 10);
});

test("an intermediate held in full asks for nothing below it: no zero lines in the tree", () => {
  const chain = resolveIndustryChain({ book: BOOK, productTypeID: 900, runs: 10, held: new Map([[101, 10]]) });
  assert.ok(chain);
  assert.equal(line(chain, 101).runs, 0);
  assert.equal(chain.lines.has(102), false, "nothing asks for Gizmos");
  const widgetNode = chain.root.children.find((child) => child.typeID === 101);
  assert.deepEqual(widgetNode?.children, []);
});

test("stock is used before jobs, and the two together never make a shortfall negative", () => {
  const chain = resolveIndustryChain({
    book: BOOK, productTypeID: 900, runs: 10,
    held: new Map([[101, 8]]),
    inProduction: new Map([[101, 5]]),
  });
  const widget = line(chain, 101);
  assert.equal(widget.held, 8);
  assert.equal(widget.inProduction, 2);
  assert.equal(widget.short, 0);
});
