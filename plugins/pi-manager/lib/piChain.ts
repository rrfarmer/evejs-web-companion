// The chain resolver: given a target commodity and a quantity, expand its
// recipe down to the leaves and say what each step needs (goal R108 slice 1).
//
// ---------------------------------------------------------------------------
// A RUN IS ATOMIC, AND THE CEILING SAYS SO.
//
// You cannot run a factory four fifths of the way. `needed` is what the next
// step up actually requires; `runs` is `needed` rounded UP to a whole number
// of cycles; `produced` is what those whole runs actually yield, which is
// often more than `needed`. Asking piRecipes.ts's own example for 1
// Superconductor still costs a full run of 5 — the surplus is real and must
// stay visible, never be silently dropped by rounding `needed` itself.
//
// Every child's `needed` is `runs * input.quantity`, not `needed *
// input.quantity` — the ceiling has already been taken at this node, and
// taking it again from the wrong number would double-round.
//
// ---------------------------------------------------------------------------
// A LEAF IS A FACT, NOT A FAILURE.
//
// A type nothing in the book makes — a raw resource, or a target the caller
// just made up — is a valid answer: "nothing you own makes this" is exactly
// what a planner needs rendered. Only a nonsensical REQUEST (a bad quantity,
// a bad target id) is null. See piRecipes.ts's own header: null, never zero,
// and here that extends to "leaf, never null".
//
// ---------------------------------------------------------------------------
// THE TREE IS A TREE. PRODUCTION IS NOT.
//
// ⚠ `resolveChain` RETURNS A SHAPE TO RENDER, NOT A PLAN TO FOLLOW, and the
// difference is a real number on a real screen. A commodity that two branches
// both need appears twice in the tree, and each of those nodes rounds up to
// whole runs on its own. Two branches each needing 2 of something made 5 at a
// time come out as two runs producing 10 — when ONE run of 5 covers both.
//
// This is not hypothetical: in the real table Supercomputers reaches Water down
// two separate paths. So a caller that adds up `runs` or `runSeconds` across the
// tree will overstate the work, and it will overstate it MORE the more the
// chain shares. `chainTotals` is safe — it sums `needed`, which is a
// requirement and not a rounding — but anything about runs, time or the inputs
// those runs consume must come from `planProduction`, which consolidates each
// commodity ONCE across the whole chain and then rounds.
//
// ---------------------------------------------------------------------------
// THE PATH GUARD IS FOR CORRUPT DATA, NOT REAL DATA.
//
// Every row in the real table has exactly one output and the tiers form a
// strict hierarchy (piRecipes.ts's ONE OUTPUT, AND ONLY ONE RECIPE MAKES IT),
// so a real chain cannot cycle. This guard exists anyway, for a hand-edited or
// hostile table: it carries the set of typeIDs on the CURRENT PATH from the
// root, and the moment a type recurs on its own path, that node is treated as
// a leaf instead of being expanded again. A depth cap backs it up for a chain
// that grows without ever repeating a typeID — 8 levels is generous, since the
// real tree bottoms out at 5.

import { commodityName, recipeFor, tierOf } from "../../../web/src/plugin-api/index.ts";
import type { PiRecipeBook, PiSchematic, PiTier } from "../../../web/src/plugin-api/index.ts";

/** One step of a resolved chain: how much of it is needed, and by what. */
export interface ChainNode {
  readonly typeID: number;
  readonly typeName: string | null;
  readonly tier: PiTier | null;
  /** How much of this is required. Always > 0. */
  readonly needed: number;
  /** The one recipe that makes it, or null at a leaf. */
  readonly madeBy: PiSchematic | null;
  /** Whole runs of madeBy needed to cover `needed`. Null at a leaf. */
  readonly runs: number | null;
  /** runs * output.quantity. At least `needed`, often more. Null at a leaf. */
  readonly produced: number | null;
  /** runs * cycleTimeSeconds, or null when the cycle length is unknown. */
  readonly runSeconds: number | null;
  readonly inputs: readonly ChainNode[];
}

/** Generous on purpose — the real tree bottoms out at 5. See the header. */
const MAX_DEPTH = 8;

function leafNode(
  book: PiRecipeBook,
  typeID: number,
  needed: number,
): ChainNode {
  return {
    typeID,
    typeName: commodityName(book, typeID),
    tier: tierOf(book, typeID),
    needed,
    madeBy: null,
    runs: null,
    produced: null,
    runSeconds: null,
    inputs: Object.freeze([]),
  };
}

function buildNode(
  book: PiRecipeBook,
  typeID: number,
  needed: number,
  pathTypeIDs: ReadonlySet<number>,
  depth: number,
): ChainNode {
  const recipe = recipeFor(book, typeID);
  // Corrupt-data guards: a type recurring on its own path, or a path grown
  // too deep to be real planetary data, is treated as a leaf rather than
  // expanded further. See the header — this can never fire on real data.
  if (recipe === null || pathTypeIDs.has(typeID) || depth >= MAX_DEPTH) {
    return leafNode(book, typeID, needed);
  }

  const runs = Math.ceil(needed / recipe.output.quantity);
  const produced = runs * recipe.output.quantity;
  const runSeconds = recipe.cycleTimeSeconds === null ? null : runs * recipe.cycleTimeSeconds;

  const nextPath = new Set(pathTypeIDs);
  nextPath.add(typeID);
  const inputs = recipe.inputs.map((input) =>
    buildNode(book, input.typeID, runs * input.quantity, nextPath, depth + 1),
  );

  return {
    typeID,
    typeName: commodityName(book, typeID),
    tier: tierOf(book, typeID),
    needed,
    madeBy: recipe,
    runs,
    produced,
    runSeconds,
    inputs: Object.freeze(inputs),
  };
}

/**
 * Expand `targetTypeID` down to its leaves for `quantity` of it.
 *
 * Null only for a nonsensical request — a quantity that is not a positive
 * finite number, or a target that is not a positive integer typeID. A target
 * nothing in the book makes is NOT one of those cases: it comes back as a
 * leaf, because "nothing you own makes this" is a fact worth rendering, not
 * an error.
 */
export function resolveChain(
  book: PiRecipeBook,
  targetTypeID: number,
  quantity: number,
): ChainNode | null {
  if (!Number.isSafeInteger(targetTypeID) || targetTypeID <= 0) {
    return null;
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return null;
  }
  return buildNode(book, targetTypeID, quantity, new Set<number>(), 0);
}

/**
 * Every typeID in the chain, summed by how much of it is needed in total —
 * the root included. A commodity two different branches both need is one
 * entry with the combined total: this is what a shopping list is rendered
 * from.
 */
export function chainTotals(root: ChainNode): ReadonlyMap<number, number> {
  const totals = new Map<number, number>();
  const stack: ChainNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    totals.set(node.typeID, (totals.get(node.typeID) ?? 0) + node.needed);
    for (const input of node.inputs) {
      stack.push(input);
    }
  }
  return totals;
}

/** One commodity in a consolidated plan: made once, for the whole chain. */
export interface PlanStep {
  readonly typeID: number;
  readonly typeName: string | null;
  readonly tier: PiTier | null;
  /** Total required across every branch that asked for it. Always > 0. */
  readonly needed: number;
  /** The recipe that makes it, or null when nothing in the book does. */
  readonly madeBy: PiSchematic | null;
  /** Whole runs to cover the CONSOLIDATED need. Null when nothing makes it. */
  readonly runs: number | null;
  /** runs * output.quantity. Null when nothing makes it. */
  readonly produced: number | null;
  /** runs * cycleTimeSeconds, or null when the cycle length is unknown. */
  readonly runSeconds: number | null;
}

/**
 * The chain as work to actually do: every commodity once, with its runs taken
 * against its whole-chain requirement rather than branch by branch.
 *
 * ⚠ THIS, NOT THE TREE, IS WHAT A NUMBER ON SCREEN COMES FROM. See the header:
 * summing `runs` over the tree double-counts anything two branches share.
 *
 * Steps come back in the order the work happens: deepest first, so everything a
 * step consumes is already above it in the list, and the target is last.
 *
 * HOW THE CONSOLIDATION TERMINATES. Each commodity is visited once, in
 * ascending order of its longest distance from the target. A consumer is always
 * strictly nearer the target than the thing it consumes, so by the time a
 * commodity is expanded every demand on it is already counted. That ordering is
 * taken from the resolved tree, which means it inherits the tree's cycle and
 * depth guards for free — on a corrupt book a guarded node is a leaf here too,
 * and the pass is a single walk of a finite list either way.
 */
export function planProduction(
  book: PiRecipeBook,
  targetTypeID: number,
  quantity: number,
): readonly PlanStep[] | null {
  const root = resolveChain(book, targetTypeID, quantity);
  if (root === null) {
    return null;
  }

  // Longest distance from the target, and the recipe the TREE used — not the
  // one the book holds, so a node the guards turned into a leaf stays a leaf.
  const depthOf = new Map<number, number>();
  const recipeOf = new Map<number, PiSchematic | null>();
  const walk = (node: ChainNode, depth: number): void => {
    const known = depthOf.get(node.typeID);
    if (known === undefined || depth > known) {
      depthOf.set(node.typeID, depth);
    }
    if (node.madeBy !== null || !recipeOf.has(node.typeID)) {
      recipeOf.set(node.typeID, node.madeBy);
    }
    for (const input of node.inputs) {
      walk(input, depth + 1);
    }
  };
  walk(root, 0);

  const order = [...depthOf.keys()].sort(
    (left, right) => (depthOf.get(left) ?? 0) - (depthOf.get(right) ?? 0),
  );

  const needs = new Map<number, number>([[root.typeID, root.needed]]);
  const steps: PlanStep[] = [];
  for (const typeID of order) {
    const needed = needs.get(typeID) ?? 0;
    const recipe = recipeOf.get(typeID) ?? null;
    if (needed <= 0) {
      continue;
    }
    if (recipe === null) {
      steps.push({
        typeID,
        typeName: commodityName(book, typeID),
        tier: tierOf(book, typeID),
        needed,
        madeBy: null,
        runs: null,
        produced: null,
        runSeconds: null,
      });
      continue;
    }
    const runs = Math.ceil(needed / recipe.output.quantity);
    steps.push({
      typeID,
      typeName: commodityName(book, typeID),
      tier: tierOf(book, typeID),
      needed,
      madeBy: recipe,
      runs,
      produced: runs * recipe.output.quantity,
      runSeconds: recipe.cycleTimeSeconds === null ? null : runs * recipe.cycleTimeSeconds,
    });
    for (const input of recipe.inputs) {
      needs.set(input.typeID, (needs.get(input.typeID) ?? 0) + runs * input.quantity);
    }
  }

  // Deepest first: the order the work happens in, target last.
  return Object.freeze(steps.reverse());
}

/**
 * Every leaf in the chain — the things that must be extracted or bought —
 * de-duplicated by typeID with their needs summed, in a deterministic order
 * (first encountered by a depth-first, left-to-right walk).
 *
 * ⚠ THESE NEEDS COME FROM THE TREE, so for a leaf two branches share they are
 * the sum of two independently rounded demands. For the figure to buy against,
 * take the leaf's step from `planProduction` instead.
 */
export function chainLeaves(root: ChainNode): readonly ChainNode[] {
  const order: number[] = [];
  const byTypeID = new Map<number, ChainNode>();

  function visit(node: ChainNode): void {
    if (node.madeBy === null) {
      const existing = byTypeID.get(node.typeID);
      if (existing === undefined) {
        order.push(node.typeID);
        byTypeID.set(node.typeID, node);
      } else {
        byTypeID.set(node.typeID, { ...existing, needed: existing.needed + node.needed });
      }
      return;
    }
    for (const input of node.inputs) {
      visit(input);
    }
  }

  visit(root);
  return Object.freeze(order.map((typeID) => byTypeID.get(typeID)!));
}
