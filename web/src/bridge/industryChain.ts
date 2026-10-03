// The industry resolver: a blueprint and a number of runs, expanded into
// everything it takes to build (goal R109 slice 1). Pure; no I/O.
//
// ---------------------------------------------------------------------------
// A TREE TO LOOK AT, A DAG TO WORK.
//
// The same intermediate turns up under several parents (fuel blocks under every
// reaction, a mineral under every component). Walking the tree and summing it
// rounds each occurrence on its own and overstates the work, the lesson
// `piChainPlan.test.ts` pins for PI. So the quantities are worked once per TYPE,
// over the graph in consumers-first order, and each type is rounded once. The
// tree is drawn afterwards from those per-type lines, and a type's second
// appearance is marked `repeat` rather than expanded again.
//
// ---------------------------------------------------------------------------
// THE SERVER'S FORMULA, NOT A LOOKALIKE.
//
// Materials are worked per JOB, exactly as the emulator consumes them
// (server/src/services/industry/industryParityHelpers.js,
// `buildIndustryActivityMaterials` and `roundMaterialQuantity`):
//
//     max(runs, trunc(ceil(round(base * runs * me * facility * 100) / 100)))
//
// with `me = 1 - ME/100` for manufacturing only (a reaction has no efficiency).
// The round-to-hundredths step matters: it absorbs float error before the ceil,
// so 9.000000000000002 becomes 9 and not 10. Because the ceil and the max apply
// per job, two jobs of five runs can consume more than one job of ten; a node's
// job split is therefore part of the plan, not a display detail.
//
// ---------------------------------------------------------------------------
// WHAT IS NETTED, AND WHAT IS NOT.
//
// Stock held of an intermediate is used before building it, and the subtree
// below is expanded for the remainder only. The TARGET itself is never netted:
// a plan says "build ten of these", and ten already in a hangar do not make
// that plan done. Progress on the target is a job matter (slice 5).
//
// Everything is judged against one stock pool for this plan alone. Two plans
// needing the same stock each see all of it (the PI planner's rule too).

import type { IndustryRecipe, IndustryRecipeBook, IndustryInvention } from "./industryRecipes.ts";
import { isPlanetaryType } from "./industryRecipes.ts";

/** How one type is obtained in this plan. */
export type IndustryObtain = "build" | "react" | "buy";

/** Why a type with a recipe is bought anyway. */
export type IndustryBuyReason = "chosen" | "no-recipe" | "cycle";

/** The terms one blueprint type is run at. */
export interface BlueprintTerms {
  /** 0..10, in percent. */
  readonly materialEfficiency: number;
  /** 0..20, in percent. */
  readonly timeEfficiency: number;
  /** False when nobody owns it and these numbers are an assumption. */
  readonly owned: boolean;
}

/** Everything the player decides about a plan. All optional. */
export interface IndustryChoices {
  /** Per product type. A type with a recipe is built unless this says buy. */
  readonly obtain?: ReadonlyMap<number, "build" | "buy">;
  /** Per BLUEPRINT type. Absent means assumed, see `assumedTerms`. */
  readonly blueprints?: ReadonlyMap<number, BlueprintTerms>;
  /** Per product type: how many jobs its runs are split into. Default 1. */
  readonly jobs?: ReadonlyMap<number, number>;
  /**
   * Per BLUEPRINT type: the material multiplier of the facility its job runs
   * in, for its product (bridge/industryFacility.ts facilityMultiplier).
   * Absent means 1.0, and the plan should say no bonus was counted.
   */
  readonly materialModifiers?: ReadonlyMap<number, number>;
  /**
   * Per T2 BLUEPRINT type: extra runs each invented copy carries, from the
   * chosen decryptor (slice 6). The server gives a copy its base runs plus
   * these, and never fewer than one.
   */
  readonly inventionRunsBonus?: ReadonlyMap<number, number>;
}

export interface IndustryChainInput {
  readonly book: IndustryRecipeBook;
  /** The product to build: the top blueprint's product. */
  readonly productTypeID: number;
  /** Runs of the top blueprint. Whole and positive. */
  readonly runs: number;
  readonly choices?: IndustryChoices;
  /** Units held, per type, already merged across places by the caller. */
  readonly held?: ReadonlyMap<number, number>;
  /**
   * Units already being made, per product type: running, paused or ready jobs
   * (slice 5). They cover a type like stock does, and for the TARGET they are
   * the one thing that does: runs already installed are runs not to start again,
   * and their materials are already spent.
   */
  readonly inProduction?: ReadonlyMap<number, number>;
}

export interface IndustryBlueprintUse {
  readonly blueprintTypeID: number;
  readonly materialEfficiency: number;
  readonly timeEfficiency: number;
  /** True when no owned blueprint was given and the terms are assumed. */
  readonly assumed: boolean;
  /**
   * For an unowned T2 blueprint: the invented copies these runs need. Null for
   * anything that is not invented.
   */
  readonly invention: {
    readonly copies: number;
    readonly runsPerCopy: number;
    readonly sources: readonly IndustryInvention[];
  } | null;
}

/** One type, worked once for the whole plan. */
export interface IndustryLine {
  readonly typeID: number;
  readonly name: string | null;
  readonly obtain: IndustryObtain;
  /** Set only when `obtain` is "buy". */
  readonly buyReason: IndustryBuyReason | null;
  /** True when a recipe exists, so build/buy is the player's to choose. */
  readonly canBuild: boolean;
  /** Planetary goods: a leaf here, planned in Planetary Industry. */
  readonly planetary: boolean;
  /** Units the plan consumes of this type, all parents together. */
  readonly needed: number;
  /** Units of `needed` covered from stock. Always 0 for the target. */
  readonly held: number;
  /** Units of `needed` covered by jobs already running, after stock. */
  readonly inProduction: number;
  /** needed - held: what has to be built or bought. */
  readonly short: number;
  /** For a build: runs in total, and per job. Empty for a buy. */
  readonly runs: number;
  readonly jobRuns: readonly number[];
  /** Units the runs make: runs x quantityPerRun. 0 for a buy. */
  readonly made: number;
  /** made - short: surplus of whole runs. Never hidden. */
  readonly leftover: number;
  /** Consumed by this type's jobs, all jobs together. Empty for a buy. */
  readonly materials: ReadonlyMap<number, number>;
  readonly recipe: IndustryRecipe | null;
  readonly blueprint: IndustryBlueprintUse | null;
}

/** One place a type appears in the tree. */
export interface IndustryNode {
  /** Path of type ids from the root, joined by ">". Stable across reloads. */
  readonly key: string;
  readonly typeID: number;
  /** What the parent consumes of it (for the root: what the plan makes). */
  readonly quantity: number;
  readonly line: IndustryLine;
  readonly children: readonly IndustryNode[];
  /** Expanded elsewhere in the tree already; children left out here. */
  readonly repeat: boolean;
}

export interface IndustryChain {
  readonly root: IndustryNode;
  readonly lines: ReadonlyMap<number, IndustryLine>;
  /** Every type, consumers before what they consume. The target is first. */
  readonly order: readonly number[];
}

/** The emulator's own rounding. See the header. */
export function materialQuantity(base: number, runs: number, modifier: number): number {
  if (runs <= 0 || base <= 0) {
    return 0;
  }
  const raw = base * runs * modifier;
  return Math.max(Math.trunc(Math.ceil(Math.round(raw * 100) / 100)), runs);
}

/**
 * Runs split as evenly as jobs allow, larger jobs first: 10 runs in 3 jobs is
 * [4, 3, 3]. Never more jobs than runs, never fewer than one.
 */
export function splitRuns(runs: number, jobs: number): number[] {
  if (runs <= 0) {
    return [];
  }
  const count = Math.min(Math.max(Math.trunc(jobs) || 1, 1), runs);
  const base = Math.floor(runs / count);
  const extra = runs % count;
  return Array.from({ length: count }, (_, index) => base + (index < extra ? 1 : 0));
}

/**
 * The terms a blueprint nobody owns is assumed to run at: an invented T2 copy
 * comes out at ME 2 / TE 4, anything else is taken as unresearched.
 */
export function assumedTerms(recipe: IndustryRecipe): BlueprintTerms {
  return recipe.inventedFrom.length > 0
    ? { materialEfficiency: 2, timeEfficiency: 4, owned: false }
    : { materialEfficiency: 0, timeEfficiency: 0, owned: false };
}

function clampEfficiency(value: number, max: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), max) : 0;
}

/**
 * Expand one plan. Null only when the target or runs make no sense; a target
 * nothing makes still answers, as a single bought line.
 */
export function resolveIndustryChain(input: IndustryChainInput): IndustryChain | null {
  const { book, productTypeID } = input;
  const runs = Math.trunc(input.runs);
  if (!Number.isSafeInteger(productTypeID) || productTypeID <= 0 || !Number.isSafeInteger(runs) || runs <= 0) {
    return null;
  }
  const choices = input.choices ?? {};
  const held = input.held ?? new Map<number, number>();
  const making = input.inProduction ?? new Map<number, number>();

  // 1. Which types are built, and the edges between them. A type on a cycle is
  //    forced to a buy and the walk is redone, until there is none left.
  const cycled = new Set<number>();
  const builds = (typeID: number): IndustryRecipe | null => {
    const recipe = book.byProduct.get(typeID) ?? null;
    if (recipe === null || cycled.has(typeID)) {
      return null;
    }
    if (typeID !== productTypeID && choices.obtain?.get(typeID) === "buy") {
      return null;
    }
    return recipe;
  };

  let edges = new Map<number, number[]>();
  for (let attempt = 0; attempt < 64; attempt += 1) {
    edges = new Map();
    const state = new Map<number, "open" | "done">();
    let found: number | null = null;
    const visit = (typeID: number): void => {
      state.set(typeID, "open");
      const recipe = builds(typeID);
      const children = recipe ? [...new Set(recipe.materials.map((material) => material.typeID))] : [];
      edges.set(typeID, children);
      for (const child of children) {
        if (found !== null) {
          return;
        }
        const seen = state.get(child);
        if (seen === "open") {
          found = child;
          return;
        }
        if (seen === undefined) {
          visit(child);
        }
      }
      state.set(typeID, "done");
    };
    visit(productTypeID);
    if (found === null) {
      break;
    }
    cycled.add(found);
  }

  // 2. Consumers before what they consume (Kahn, over distinct edges).
  const consumers = new Map<number, number>();
  for (const [typeID, children] of edges) {
    consumers.set(typeID, consumers.get(typeID) ?? 0);
    for (const child of children) {
      consumers.set(child, (consumers.get(child) ?? 0) + 1);
    }
  }
  const order: number[] = [];
  const ready = [productTypeID];
  while (ready.length > 0) {
    const typeID = ready.shift() as number;
    order.push(typeID);
    for (const child of edges.get(typeID) ?? []) {
      const left = (consumers.get(child) ?? 0) - 1;
      consumers.set(child, left);
      if (left === 0) {
        ready.push(child);
      }
    }
  }

  // 3. Work each type once, in that order, pushing its materials down.
  const demand = new Map<number, number>();
  const lines = new Map<number, IndustryLine>();
  for (const typeID of order) {
    const recipe = builds(typeID);
    const isTarget = typeID === productTypeID;
    const target = isTarget && recipe !== null ? runs * recipe.quantityPerRun : 0;
    const needed = isTarget ? target : demand.get(typeID) ?? 0;
    const have = isTarget ? 0 : Math.min(Math.max(held.get(typeID) ?? 0, 0), needed);
    // Jobs count only toward what is built here; a bought line has no job.
    const running = recipe === null ? 0 : Math.min(Math.max(making.get(typeID) ?? 0, 0), needed - have);
    const short = needed - have - running;
    const name = book.types.get(typeID)?.name ?? null;
    const planetary = isPlanetaryType(book, typeID);
    const canBuild = book.byProduct.has(typeID);

    if (recipe === null) {
      const buyReason: IndustryBuyReason = cycled.has(typeID)
        ? "cycle"
        : canBuild ? "chosen" : "no-recipe";
      lines.set(typeID, {
        typeID, name, obtain: "buy", buyReason, canBuild, planetary,
        needed: isTarget ? runs : needed,
        held: have,
        inProduction: 0,
        short: isTarget ? runs : short,
        runs: 0, jobRuns: [], made: 0, leftover: 0,
        materials: new Map(), recipe: book.byProduct.get(typeID) ?? null, blueprint: null,
      });
      continue;
    }

    const lineRuns = Math.ceil(short / recipe.quantityPerRun);
    const jobRuns = splitRuns(lineRuns, choices.jobs?.get(typeID) ?? 1);
    const given = choices.blueprints?.get(recipe.blueprintTypeID);
    const terms = given ?? assumedTerms(recipe);
    const manufacturing = recipe.activity === "manufacturing";
    const materialEfficiency = manufacturing ? clampEfficiency(terms.materialEfficiency, 10) : 0;
    const timeEfficiency = manufacturing ? clampEfficiency(terms.timeEfficiency, 20) : 0;
    const facility = choices.materialModifiers?.get(recipe.blueprintTypeID) ?? 1;
    const modifier = (1 - materialEfficiency / 100) * (Number.isFinite(facility) && facility > 0 ? facility : 1);

    const materials = new Map<number, number>();
    for (const material of recipe.materials) {
      let total = 0;
      for (const jobRunCount of jobRuns) {
        total += materialQuantity(material.quantity, jobRunCount, modifier);
      }
      // No runs left to start means nothing to consume: not a zero line.
      if (total > 0) {
        materials.set(material.typeID, (materials.get(material.typeID) ?? 0) + total);
      }
    }
    for (const [childTypeID, quantity] of materials) {
      demand.set(childTypeID, (demand.get(childTypeID) ?? 0) + quantity);
    }

    const owned = given?.owned === true;
    const firstSource = recipe.inventedFrom[0];
    const runsPerCopy = firstSource === undefined
      ? 0
      : Math.max(1, Math.round(firstSource.runsPerCopy + (choices.inventionRunsBonus?.get(recipe.blueprintTypeID) ?? 0)));
    const invention = !owned && manufacturing && firstSource !== undefined
      ? {
          copies: Math.ceil(lineRuns / runsPerCopy),
          runsPerCopy,
          sources: recipe.inventedFrom,
        }
      : null;
    const made = lineRuns * recipe.quantityPerRun;
    lines.set(typeID, {
      typeID, name,
      obtain: manufacturing ? "build" : "react",
      buyReason: null, canBuild, planetary,
      needed, held: have, inProduction: running, short,
      runs: lineRuns, jobRuns, made,
      leftover: made - short,
      materials, recipe,
      blueprint: {
        blueprintTypeID: recipe.blueprintTypeID,
        materialEfficiency,
        timeEfficiency,
        assumed: !owned,
        invention,
      },
    });
  }

  // A type the graph reaches but nothing ends up consuming (everything above
  // it held or already running) has no place in the plan: no line, no order.
  for (const typeID of [...lines.keys()]) {
    if (typeID !== productTypeID && (lines.get(typeID) as IndustryLine).needed === 0) {
      lines.delete(typeID);
    }
  }
  const kept = order.filter((typeID) => lines.has(typeID));

  // 4. The tree, drawn from the lines. A type's first appearance (depth first,
  //    in recipe order) carries its children; later ones are marked repeat.
  const expanded = new Set<number>();
  const draw = (typeID: number, quantity: number, path: string): IndustryNode => {
    const line = lines.get(typeID) as IndustryLine;
    const repeat = expanded.has(typeID) && line.materials.size > 0;
    expanded.add(typeID);
    const children: IndustryNode[] = [];
    if (!repeat) {
      for (const [childTypeID, childQuantity] of line.materials) {
        children.push(draw(childTypeID, childQuantity, `${path}>${childTypeID}`));
      }
    }
    return { key: path, typeID, quantity, line, children, repeat };
  };
  const rootLine = lines.get(productTypeID) as IndustryLine;
  // The root says what the plan makes, whether or not some of it is running.
  const root = draw(productTypeID, rootLine.needed, String(productTypeID));

  return { root, lines, order: kept };
}

/** Lines still missing something, deepest first: the shopping and job list. */
export function shortLines(chain: IndustryChain): IndustryLine[] {
  return [...chain.order]
    .reverse()
    .map((typeID) => chain.lines.get(typeID) as IndustryLine)
    .filter((line) => line.short > 0);
}
