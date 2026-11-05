// The consolidated plan's proof: a chain is a TREE to look at but a DAG to
// work, and the difference is a number a player would act on.
//
// `resolveChain` rounds up to whole runs at every node independently. When two
// branches both want the same commodity, that rounding happens twice, so adding
// `runs` up over the tree overstates the work — and overstates it more the more
// the chain shares. `planProduction` consolidates each commodity once across the
// whole chain and rounds after, which is the figure that belongs on screen.
//
// Every case here is written so that it FAILS against a plan that simply walks
// the tree and sums it. That is the whole point: the two numbers agree on a
// chain that shares nothing, and only diverge where the sharing is.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { decodeRecipeBook } from "../../../web/src/bridge/piRecipes.ts";
import type { PiIngredient, PiRecipeBook, PiSchematic } from "../../../web/src/bridge/piRecipes.ts";
import type { JsonValue } from "../../../web/src/bridge/wire.ts";
import { planProduction, resolveChain } from "../lib/piChain.ts";
import type { ChainNode } from "../lib/piChain.ts";

// EVEJS_ROOT is the variable the BFF's own config reads; the fallback is only
// this host's usual place. Absent either way, the real-table cases SKIP.
const EVE_ROOT = process.env.EVEJS_ROOT ?? "D:/evet";
const REAL_DATA_PATH = `${EVE_ROOT}/_local/gameStore/data/planetSchematics/data.json`;

interface RealRow {
  readonly schematicID: number;
  readonly name: string;
  readonly cycleTime: number;
  readonly pinTypeIDs: readonly number[];
  readonly inputs: readonly { typeID: number; quantity: number }[];
  readonly outputs: readonly { typeID: number; quantity: number }[];
}

/** The real table, shaped into the wire form the BFF sends. */
function loadRealBook(): PiRecipeBook | null {
  if (!existsSync(REAL_DATA_PATH)) {
    return null;
  }
  const rows = JSON.parse(readFileSync(REAL_DATA_PATH, "utf8")).schematics as readonly RealRow[];
  const wire = {
    schematics: rows
      .filter((row) => Array.isArray(row.outputs) && row.outputs.length === 1)
      .map((row) => ({
        schematicID: row.schematicID,
        name: row.name,
        cycleTimeSeconds: row.cycleTime,
        factoryTypeIDs: row.pinTypeIDs,
        inputs: row.inputs,
        output: row.outputs[0],
      })),
    commodities: {},
  };
  return decodeRecipeBook(wire as unknown as JsonValue);
}

const REAL = loadRealBook();

function skipIfNoRealData(t: { skip: (msg?: string) => void }): boolean {
  if (REAL === null) {
    t.skip(`the real schematic table is not on this machine (${REAL_DATA_PATH})`);
    return true;
  }
  return false;
}

function ingredient(typeID: number, quantity: number): PiIngredient {
  return { typeID, typeName: null, quantity };
}

function schematic(
  overrides: Partial<PiSchematic> & Pick<PiSchematic, "schematicID" | "output">,
): PiSchematic {
  return {
    name: `Schematic ${overrides.schematicID}`,
    cycleTimeSeconds: 3600,
    factoryTypeIDs: [],
    inputs: [],
    ...overrides,
  };
}

function makeBook(schematics: readonly PiSchematic[]): PiRecipeBook {
  return {
    schematics: Object.freeze(schematics),
    bySchematicID: new Map(schematics.map((s) => [s.schematicID, s])),
    byOutputTypeID: new Map(schematics.map((s) => [s.output.typeID, s])),
    commodities: new Map(),
    readable: true,
  };
}

/** What a caller would get by naively adding the tree up: the thing to beat. */
function treeRuns(root: ChainNode, typeID: number): number {
  let total = 0;
  const stack: ChainNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.typeID === typeID && node.runs !== null) {
      total += node.runs;
    }
    for (const input of node.inputs) {
      stack.push(input);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// A shared intermediate is made ONCE, and the rounding happens once with it.

test("two branches wanting the same thing make it once, not once each", () => {
  // Target 1 needs one each of 2 and 3; both need 2 of commodity 4; and 4 is
  // made FIVE at a time. Branch by branch that is two runs of 5 for a total
  // need of 4. Consolidated it is one run of 5, which is the truth.
  const book = makeBook([
    schematic({
      schematicID: 1,
      output: ingredient(1, 1),
      inputs: [ingredient(2, 1), ingredient(3, 1)],
    }),
    schematic({ schematicID: 2, output: ingredient(2, 1), inputs: [ingredient(4, 2)] }),
    schematic({ schematicID: 3, output: ingredient(3, 1), inputs: [ingredient(4, 2)] }),
    schematic({ schematicID: 4, output: ingredient(4, 5), inputs: [ingredient(5, 10)] }),
  ]);

  const tree = resolveChain(book, 1, 1);
  assert.notEqual(tree, null);
  // The tree really does double-count — if this stops being true the whole
  // reason planProduction exists has gone away and this file should be reread.
  assert.equal(treeRuns(tree!, 4), 2, "the tree rounds up once per branch");

  const plan = planProduction(book, 1, 1);
  assert.notEqual(plan, null);
  const shared = plan!.find((step) => step.typeID === 4);
  assert.notEqual(shared, undefined, "the shared commodity appears in the plan");
  assert.equal(shared!.needed, 4, "both branches' demands are added before rounding");
  assert.equal(shared!.runs, 1, "one run of five covers a need of four");
  assert.equal(shared!.produced, 5);
  assert.equal(shared!.runSeconds, 3600, "one run's worth of time, not two");

  // And the saving carries downward: one run consumes 10 of commodity 5, not 20.
  const beneath = plan!.find((step) => step.typeID === 5);
  assert.equal(beneath!.needed, 10, "the input to the shared step is sized from ONE run");
});

test("a commodity appears exactly once in the plan, however many branches want it", () => {
  const book = makeBook([
    schematic({
      schematicID: 1,
      output: ingredient(1, 1),
      inputs: [ingredient(2, 1), ingredient(3, 1), ingredient(4, 1)],
    }),
    schematic({ schematicID: 2, output: ingredient(2, 1), inputs: [ingredient(9, 1)] }),
    schematic({ schematicID: 3, output: ingredient(3, 1), inputs: [ingredient(9, 1)] }),
    schematic({ schematicID: 4, output: ingredient(4, 1), inputs: [ingredient(9, 1)] }),
  ]);
  const plan = planProduction(book, 1, 1);
  const appearances = plan!.filter((step) => step.typeID === 9);
  assert.equal(appearances.length, 1, "the shared leaf is one row");
  assert.equal(appearances[0]!.needed, 3, "with every branch's demand in it");
});

// ---------------------------------------------------------------------------
// Order: the work reads bottom-up, so nothing depends on a row below it.

test("steps come back deepest first, with the target last", () => {
  const book = makeBook([
    schematic({ schematicID: 1, output: ingredient(1, 1), inputs: [ingredient(2, 1)] }),
    schematic({ schematicID: 2, output: ingredient(2, 1), inputs: [ingredient(3, 1)] }),
  ]);
  const plan = planProduction(book, 1, 1);
  assert.deepEqual(
    plan!.map((step) => step.typeID),
    [3, 2, 1],
    "raw first, target last",
  );

  // Everything a step consumes must already have appeared above it.
  const seen = new Set<number>();
  for (const step of plan!) {
    for (const input of step.madeBy?.inputs ?? []) {
      assert.ok(seen.has(input.typeID), `input ${input.typeID} appears before its consumer`);
    }
    seen.add(step.typeID);
  }
});

// ---------------------------------------------------------------------------
// Where nothing is shared, the plan and the tree must agree exactly.

test("a chain that shares nothing plans exactly as the tree resolves it", () => {
  const book = makeBook([
    schematic({ schematicID: 1, output: ingredient(1, 3), inputs: [ingredient(2, 7)] }),
    schematic({ schematicID: 2, output: ingredient(2, 2), inputs: [ingredient(3, 5)] }),
  ]);
  const tree = resolveChain(book, 1, 4);
  const plan = planProduction(book, 1, 4);
  let compared = 0;
  for (const step of plan!) {
    if (step.runs === null) {
      // A leaf is made by nothing, so there is no run count to compare.
      assert.equal(treeRuns(tree!, step.typeID), 0, `${step.typeID} is a leaf on both sides`);
      continue;
    }
    assert.equal(step.runs, treeRuns(tree!, step.typeID), `runs agree for ${step.typeID}`);
    compared += 1;
  }
  assert.equal(compared, 2, "both made steps were actually compared, not skipped");
  const target = plan!.find((step) => step.typeID === 1)!;
  assert.equal(target.needed, 4);
  assert.equal(target.runs, 2, "ceil(4/3)");
  assert.equal(target.produced, 6);
});

// ---------------------------------------------------------------------------
// The real table shares things, and this is the case that proves it matters.

test("the real chain for Supercomputers makes its shared Water once", (t) => {
  if (skipIfNoRealData(t)) {
    return;
  }
  // Supercomputers reaches Water (3645) down two separate paths — through a
  // Water-Cooled CPU and through Coolant. This is the real-data shape the
  // hand-built case above models.
  const tree = resolveChain(REAL!, 2349, 1);
  const plan = planProduction(REAL!, 2349, 1);
  assert.notEqual(plan, null);

  const waterRows = plan!.filter((step) => step.typeID === 3645);
  assert.equal(waterRows.length, 1, "Water is one row in the plan");

  const water = waterRows[0]!;
  assert.ok(water.runs !== null && water.runs > 0);
  assert.ok(
    water.runs <= treeRuns(tree!, 3645),
    "consolidating can only ever reduce the runs, never add any",
  );
  assert.equal(
    water.runs,
    Math.ceil(water.needed / water.madeBy!.output.quantity),
    "the plan's runs are the ceiling of the CONSOLIDATED need",
  );
});

test("every real tier-4 target plans without a commodity appearing twice", (t) => {
  if (skipIfNoRealData(t)) {
    return;
  }
  // Whatever the table holds, a plan is a set of distinct commodities. A
  // duplicate row would mean two places on screen telling a player to make the
  // same thing, each with part of the answer.
  let checked = 0;
  for (const recipe of REAL!.schematics) {
    const plan = planProduction(REAL!, recipe.output.typeID, 1);
    assert.notEqual(plan, null, `${recipe.name} plans`);
    const ids = plan!.map((step) => step.typeID);
    assert.equal(new Set(ids).size, ids.length, `${recipe.name} has no duplicate step`);
    checked += 1;
  }
  assert.ok(checked > 60, `checked the whole table, not a handful (${checked})`);
});
