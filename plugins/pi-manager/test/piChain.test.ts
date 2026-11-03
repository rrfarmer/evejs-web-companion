// The chain resolver's proof: given a target and a quantity, walk to the
// leaves and get the arithmetic right — this is the spine three views render
// their output from, so a wrong number here is a wrong number everywhere.
//
// What is checked, and why each matters:
//
//   1. THE CEILING IS NOT OPTIONAL. A factory run is atomic; `needed` and
//      `produced` are different numbers on purpose, and the gap between them
//      is real surplus a player will be holding. Driven off the real
//      Superconductors ratio (5 per run) because a fixture that shares the
//      assumption would never catch a bug in it.
//   2. A CYCLE OR A RUNAWAY DEPTH MUST NOT HANG THE RESOLVER. Real planetary
//      data is a strict tier hierarchy and cannot cycle, but corrupt or
//      hostile data must not be trusted to know that either — both guards are
//      proved against hand-built books built specifically to violate the
//      assumption real data never would.
//   3. A LEAF ONLY LACKS A RECIPE; IT IS NEVER null. "Nothing you own makes
//      this" is an answer a planner renders, not a failure — null is reserved
//      for a caller that asked a nonsensical question.
//
// The tier-4 expansion, the ceiling and the shared-branch total are driven
// from the real schematic table (D:/evet/_local/gameStore/data/planetSchematics
// /data.json) rather than a fixture that shares this file's assumptions about
// the ratios. The cycle guard, the depth cap and the bad-input cases are
// hand-built on purpose: the real table is a strict hierarchy and cannot
// exercise them.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { decodeRecipeBook } from "../../../web/src/bridge/piRecipes.ts";
import type { PiIngredient, PiRecipeBook, PiSchematic } from "../../../web/src/bridge/piRecipes.ts";
import type { JsonValue } from "../../../web/src/bridge/wire.ts";
import { chainLeaves, chainTotals, resolveChain } from "../lib/piChain.ts";

// ---------------------------------------------------------------------------
// The real recipe table, decoded through the same wire shape the BFF sends.

// Where the emulator's own copy of the table lives. EVEJS_ROOT is the same
// variable the BFF's config reads, so this follows the server rather than
// assuming one machine's layout; the fallback is only this host's usual place.
// Absent either way, the real-table cases SKIP — they never fail for it.
const EVE_ROOT = process.env.EVEJS_ROOT ?? "D:/evet";
const REAL_DATA_PATH = `${EVE_ROOT}/_local/gameStore/data/planetSchematics/data.json`;

interface RealSchematicRow {
  readonly schematicID: number;
  readonly name: string;
  readonly cycleTime: number;
  readonly pinTypeIDs: readonly number[];
  readonly inputs: readonly { typeID: number; quantity: number }[];
  readonly outputs: readonly { typeID: number; quantity: number }[];
}

function loadRealBook(): PiRecipeBook | null {
  if (!existsSync(REAL_DATA_PATH)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(REAL_DATA_PATH, "utf8")) as {
    schematics: readonly RealSchematicRow[];
  };
  // Reshape into the wire form piRecipes.ts's decoder expects: cycleTimeSeconds
  // (not cycleTime), factoryTypeIDs (not pinTypeIDs), a single `output` (not
  // an `outputs` array) — see decodeSchematic in piRecipes.ts.
  const wire = {
    schematics: parsed.schematics.map((row) => ({
      schematicID: row.schematicID,
      name: row.name,
      cycleTimeSeconds: row.cycleTime,
      factoryTypeIDs: row.pinTypeIDs,
      inputs: row.inputs,
      output: row.outputs[0] ?? null,
    })),
  };
  return decodeRecipeBook(wire as unknown as JsonValue);
}

const REAL = loadRealBook();

function skipIfNoRealData(t: { skip: (msg?: string) => void }): boolean {
  if (REAL === null) {
    t.skip(`real recipe table not found at ${REAL_DATA_PATH} — skipping real-data cases`);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Hand-made books: full control over shape, used for the cases real data
// cannot exercise (it is a strict hierarchy and never cycles).

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
  const bySchematicID = new Map(schematics.map((s) => [s.schematicID, s]));
  const byOutputTypeID = new Map(schematics.map((s) => [s.output.typeID, s]));
  return {
    schematics: Object.freeze(schematics),
    bySchematicID,
    byOutputTypeID,
    commodities: new Map(),
    readable: true,
  };
}

/** A straight chain of `length` single-input, 1:1 recipes: 1 <- 2 <- 3 <- ... */
function chainOfSchematics(length: number): readonly PiSchematic[] {
  const list: PiSchematic[] = [];
  for (let i = 1; i <= length; i++) {
    list.push(
      schematic({
        schematicID: i,
        output: ingredient(i, 1),
        inputs: [ingredient(i + 1, 1)],
      }),
    );
  }
  return list;
}

// ---------------------------------------------------------------------------
// 1. A one-input recipe expands to a single leaf with the right quantity.

test("a one-input recipe expands to a single leaf with the right quantity", (t) => {
  if (skipIfNoRealData(t)) {
    return;
  }
  // Schematic 121, "Water": 3000 of 2268 (raw) makes 20 of 3645.
  const node = resolveChain(REAL!, 3645, 20);
  assert.ok(node);
  assert.equal(node!.typeID, 3645);
  assert.equal(node!.needed, 20);
  assert.equal(node!.runs, 1);
  assert.equal(node!.produced, 20);
  assert.equal(node!.inputs.length, 1);

  const leaf = node!.inputs[0]!;
  assert.equal(leaf.typeID, 2268);
  assert.equal(leaf.needed, 3000);
  assert.equal(leaf.madeBy, null);
  assert.equal(leaf.runs, null);
  assert.equal(leaf.produced, null);
  assert.equal(leaf.runSeconds, null);
  assert.deepEqual(leaf.inputs, []);
});

// ---------------------------------------------------------------------------
// 2. A tier-4 target expands all the way down and every leaf is something
//    nothing makes.

test("a tier-4 target expands all the way down and every leaf is something nothing makes", (t) => {
  if (skipIfNoRealData(t)) {
    return;
  }
  // "Organic Mortar Applicators" (typeID 2870) is the deepest chain in the
  // real table: four recipe levels down to raw resources.
  const node = resolveChain(REAL!, 2870, 1);
  assert.ok(node);
  assert.equal(node!.madeBy?.name, "Organic Mortar Applicators");

  const leaves = chainLeaves(node!);
  assert.ok(leaves.length > 0);
  for (const leaf of leaves) {
    assert.equal(leaf.madeBy, null, `leaf ${leaf.typeID} should have no recipe`);
    assert.equal(leaf.runs, null);
    assert.equal(
      REAL!.byOutputTypeID.has(leaf.typeID),
      false,
      `leaf ${leaf.typeID} must not be something the book knows how to make`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. The ceiling: runs are whole, produced can exceed needed, and children
//    are sized from runs, not from needed.

test("the ceiling: a run is atomic and children are sized from runs, not needed", (t) => {
  if (skipIfNoRealData(t)) {
    return;
  }
  // Superconductors (typeID 9838) is made 5 at a time from 40 Plasmoids (2389)
  // and 40 Water (3645) per run — the exact example the header documents.
  const one = resolveChain(REAL!, 9838, 1);
  assert.ok(one);
  assert.equal(one!.needed, 1);
  assert.equal(one!.runs, 1);
  assert.equal(one!.produced, 5); // a full run, not 1/5 of one

  // Ask for 6: ceil(6/5) = 2 runs, 10 produced (4 more than needed), and each
  // input's `needed` must come from runs (2 * 40 = 80), not from the
  // requested quantity (6 * 40 would be 240, and 1 * 40 would be 40 — both
  // wrong).
  const six = resolveChain(REAL!, 9838, 6);
  assert.ok(six);
  assert.equal(six!.needed, 6);
  assert.equal(six!.runs, 2);
  assert.equal(six!.produced, 10);
  assert.equal(six!.inputs.length, 2);
  for (const input of six!.inputs) {
    assert.equal(input.needed, 80, `input ${input.typeID} should need runs(2) * quantity(40)`);
  }
});

// ---------------------------------------------------------------------------
// 4. A commodity needed by two different branches appears once in
//    chainTotals, with the combined total.

test("a commodity needed by two branches appears once in chainTotals with the summed quantity", (t) => {
  if (skipIfNoRealData(t)) {
    return;
  }
  // Supercomputers (typeID 2349) needs both a Water-Cooled CPU and Coolant,
  // and both of those need Water (3645) — a real two-branch overlap, verified
  // by hand against the table before writing this assertion:
  //   runs(root)=1 -> Water-Cooled CPU needed=10, runs=2 -> Water needed=80
  //                -> Coolant needed=10, runs=2 -> Water needed=80
  //   total for 3645 = 80 + 80 = 160
  //   each Water branch's leaf (2268) needs runs(4) * 3000 = 12000, so the
  //   combined leaf total is 24000.
  const node = resolveChain(REAL!, 2349, 1);
  assert.ok(node);

  const totals = chainTotals(node!);
  assert.equal(totals.get(3645), 160);
  assert.equal(totals.get(2268), 24000);
  assert.equal(totals.get(2349), 1); // the root itself is included

  // chainLeaves must also dedupe the same raw resource across both branches
  // into one entry rather than listing it twice.
  const leaves = chainLeaves(node!);
  const waterLeaf = leaves.filter((leaf) => leaf.typeID === 2268);
  assert.equal(waterLeaf.length, 1, "the shared leaf must appear once, not once per branch");
  assert.equal(waterLeaf[0]!.needed, 24000);
});

// ---------------------------------------------------------------------------
// 5. The cycle guard terminates on a deliberately cyclic hand-made book.

test("the cycle guard stops recursion when a type recurs on its own path", () => {
  // A book that could never occur in real data: A (10) is made from B's
  // output (20), and B (20) is made from A's output (10).
  const book = makeBook([
    schematic({ schematicID: 1, output: ingredient(10, 2), inputs: [ingredient(20, 3)] }),
    schematic({ schematicID: 2, output: ingredient(20, 5), inputs: [ingredient(10, 1)] }),
  ]);

  const node = resolveChain(book, 10, 3);
  assert.ok(node);
  assert.equal(node!.typeID, 10);
  assert.equal(node!.madeBy?.schematicID, 1);
  assert.equal(node!.runs, 2); // ceil(3/2)

  const b = node!.inputs[0]!;
  assert.equal(b.typeID, 20);
  assert.equal(b.needed, 6); // runs(2) * 3
  assert.equal(b.madeBy?.schematicID, 2);
  assert.equal(b.runs, 2); // ceil(6/5)

  // B's own input is type 10 again — already on the path from the root — so
  // it must stop here as a leaf instead of recursing back into schematic 1.
  const aAgain = b.inputs[0]!;
  assert.equal(aAgain.typeID, 10);
  assert.equal(aAgain.needed, 2); // runs(2) * 1
  assert.equal(aAgain.madeBy, null);
  assert.equal(aAgain.runs, null);
  assert.equal(aAgain.produced, null);
  assert.equal(aAgain.runSeconds, null);
  assert.deepEqual(aAgain.inputs, []);
});

// ---------------------------------------------------------------------------
// 6. The depth cap terminates on a deliberately deep hand-made book.

test("the depth cap stops recursion even when a recipe would still apply", () => {
  // A straight chain 12 levels deep — deeper than the cap of 8, and deeper
  // than any real tier hierarchy (5 levels at most).
  const book = makeBook(chainOfSchematics(12));

  const node = resolveChain(book, 1, 1);
  assert.ok(node);

  let current = node!;
  for (let depth = 0; depth < 8; depth++) {
    assert.equal(current.typeID, depth + 1);
    assert.ok(current.madeBy, `expected a recipe still applying at depth ${depth}`);
    current = current.inputs[0]!;
  }

  // `current` is now the node at depth 8 (typeID 9). The book still has a
  // recipe for it (schematic 9 makes 9 from 10) — the cap, not a missing
  // recipe, is what forces it to stop here.
  assert.equal(current.typeID, 9);
  assert.ok(book.byOutputTypeID.has(9), "a recipe for type 9 exists — the cap stopped the walk, not the data");
  assert.equal(current.madeBy, null);
  assert.equal(current.runs, null);
  assert.equal(current.produced, null);
  assert.equal(current.runSeconds, null);
  assert.deepEqual(current.inputs, []);
});

// ---------------------------------------------------------------------------
// 7. A missing cycle time yields runSeconds null, never 0.

test("a missing cycle time yields runSeconds null, never 0", () => {
  const book = makeBook([
    schematic({
      schematicID: 1,
      output: ingredient(1, 5),
      inputs: [ingredient(2, 3)],
      cycleTimeSeconds: null,
    }),
  ]);
  const node = resolveChain(book, 1, 5);
  assert.ok(node);
  assert.equal(node!.runs, 1);
  assert.equal(node!.runSeconds, null);
  assert.notEqual(node!.runSeconds, 0);
});

// ---------------------------------------------------------------------------
// 8. Bad quantity or bad target yields null.

test("a non-positive or non-finite quantity yields null", () => {
  const book = makeBook([schematic({ schematicID: 1, output: ingredient(1, 5) })]);
  for (const bad of [0, -1, -5.5, NaN, Infinity, -Infinity]) {
    assert.equal(resolveChain(book, 1, bad), null, `quantity ${bad} should yield null`);
  }
});

test("a non-positive-integer target yields null", () => {
  const book = makeBook([schematic({ schematicID: 1, output: ingredient(1, 5) })]);
  for (const bad of [0, -1, 1.5, NaN, Infinity, -Infinity]) {
    assert.equal(resolveChain(book, bad, 1), null, `target ${bad} should yield null`);
  }
});

// ---------------------------------------------------------------------------
// 9. A target nothing makes yields a leaf node, not null.

test("a target nothing makes yields a leaf node, not null", () => {
  const book = makeBook([schematic({ schematicID: 1, output: ingredient(1, 5) })]);
  const node = resolveChain(book, 999, 7);
  assert.notEqual(node, null);
  assert.equal(node!.typeID, 999);
  assert.equal(node!.needed, 7);
  assert.equal(node!.madeBy, null);
  assert.equal(node!.runs, null);
  assert.equal(node!.produced, null);
  assert.equal(node!.runSeconds, null);
  assert.deepEqual(node!.inputs, []);
});
