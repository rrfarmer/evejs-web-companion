// Coverage: what every colony on the roster makes, tier by tier, and how evenly
// the extracted basics (P1) cover the whole recipe tree.
//
// ---------------------------------------------------------------------------
// ONE GENERAL AIM, AND IT IS STATED IN THE RECIPES.
//
// A target needs an aim, and the aim here is the general one: be able to make
// anything. Its arithmetic is "one of every top product" (the commodities no
// recipe takes as an input, which on the real table are the P4s), walked down
// the recipes with fractional runs, so each basic gets the share of the whole
// tree that actually consumes it. Water, Reactive Metals and Bacteria feed five
// refined products each and come out heaviest; nothing here lists them by hand.
//
// The shares are spread over what the roster makes NOW: the target for a basic
// is its share of the basics made in total. So the target column says how the
// same output would be split if it were balanced, never "build more", which is
// a different question and the expansion plan's.
//
// ---------------------------------------------------------------------------
// NOTHING HERE SIMULATES A COLONY (bridge/piRecipes.ts says why).
//
// An extractor's rate is the server's `quantityPerCycle` over its cycle, for
// the program installed now, exactly as the planner reads it. A factory's rate
// is recipe arithmetic for the factories the server says are running. A basic
// is credited with the smaller of the two on its colony, because a factory can
// only refine what the colony pulls up, and both are "up to" figures.

import type { Colony } from "../../../web/src/plugin-api/index.ts";
import { colonyPlaceWords, formatDuration, serverNow } from "../../../web/src/plugin-api/index.ts";
import { commodityName, recipeFor, tierOf, type PiRecipeBook, type PiSchematic, type PiTier } from "../../../web/src/plugin-api/index.ts";
import type { PilotColonyReading } from "./piRoster.ts";

/** A basic made at under this share of its target reads as short. */
export const SHORT_SHARE = 0.85;
/**
 * A colony making under this share of the median colony for the same
 * commodity reads as weak: a poor planet, or a thin extractor layout.
 */
export const WEAK_SHARE = 0.75;

/** One colony's part in making a commodity. */
export interface CoverageSource {
  readonly characterID: number;
  readonly ownerName: string;
  readonly planetID: number;
  readonly placeWords: string;
  /** Up to this many an hour, from this colony. */
  readonly perHour: number;
  /** The planet's richness in the resource pulled up for this; null when unknown or not extracted. */
  readonly quality: number | null;
  /** "ends in 4d 19h", "ended", or null for a factory-only source. */
  readonly programWords: string | null;
  readonly weak: boolean;
}

export type CoverageState = "ok" | "short" | "none" | "untargeted";

export interface CoverageLine {
  readonly typeID: number;
  readonly typeName: string;
  readonly tier: PiTier;
  /** Distinct colonies making it. */
  readonly colonies: number;
  readonly perHour: number;
  /** Basics only: the balanced share of what the roster makes now. */
  readonly targetPerHour: number | null;
  /** Basics only, when short: how many median colonies would close the gap. */
  readonly colonyGap: number | null;
  readonly state: CoverageState;
  readonly weakCount: number;
  readonly sources: readonly CoverageSource[];
}

export interface CoverageSummary {
  readonly colonies: number;
  /** Basics made at all, out of every basic the recipes know. */
  readonly basicsMade: number;
  readonly basicsKnown: number;
  readonly short: number;
  readonly weak: number;
}

export interface Coverage {
  readonly lines: readonly CoverageLine[];
  readonly summary: CoverageSummary;
}

export interface CoverageInput {
  readonly book: PiRecipeBook;
  readonly readings: ReadonlyMap<number, PilotColonyReading>;
  readonly names: ReadonlyMap<number, string>;
  readonly browserNowMs: number;
}

/**
 * How much of every commodity one of each top product takes, with fractional
 * runs. Keyed by typeID; the tops themselves are included at 1.
 */
export function balancedDemand(book: PiRecipeBook): ReadonlyMap<number, number> {
  const consumed = new Set<number>();
  for (const recipe of book.schematics) {
    for (const input of recipe.inputs) consumed.add(input.typeID);
  }
  const demand = new Map<number, number>();
  const walk = (typeID: number, amount: number, path: ReadonlySet<number>): void => {
    demand.set(typeID, (demand.get(typeID) ?? 0) + amount);
    const recipe = recipeFor(book, typeID);
    if (recipe === null || path.has(typeID)) return;
    const next = new Set(path).add(typeID);
    const runs = amount / recipe.output.quantity;
    for (const input of recipe.inputs) walk(input.typeID, runs * input.quantity, next);
  };
  for (const recipe of book.schematics) {
    if (!consumed.has(recipe.output.typeID)) walk(recipe.output.typeID, 1, new Set());
  }
  return demand;
}

interface Contribution {
  readonly source: CoverageSource;
  readonly typeID: number;
}

function perHourOf(recipe: PiSchematic, count: number): number {
  return recipe.cycleTimeSeconds && recipe.cycleTimeSeconds > 0
    ? (count * recipe.output.quantity * 3600) / recipe.cycleTimeSeconds
    : 0;
}

/** What one colony makes, per commodity, as the server describes it now. */
function colonyContributions(
  book: PiRecipeBook,
  colony: Colony,
  characterID: number,
  ownerName: string,
  nowMs: number,
): Contribution[] {
  const quality = (typeID: number): number | null =>
    colony.resources?.find((resource) => resource.typeID === typeID)?.quality ?? null;
  const base = { characterID, ownerName, planetID: colony.planetID, placeWords: colonyPlaceWords(colony) };

  // Raw: every running extractor, summed per resource; the latest expiry says when it stops.
  const raw = new Map<number, { perHour: number; endsAtMs: number | null; ended: boolean }>();
  for (const pin of colony.pins) {
    const program = pin.program;
    if (pin.kind !== "extractor-control" || program === null) continue;
    const ended = program.expiresAtMs !== null && program.expiresAtMs <= nowMs;
    const perHour = ended || program.cycleTimeSeconds <= 0 ? 0 : (program.quantityPerCycle * 3600) / program.cycleTimeSeconds;
    const known = raw.get(program.resourceTypeID);
    const endsAtMs = known?.endsAtMs != null && program.expiresAtMs != null
      ? Math.max(known.endsAtMs, program.expiresAtMs)
      : known?.endsAtMs ?? program.expiresAtMs;
    raw.set(program.resourceTypeID, {
      perHour: (known?.perHour ?? 0) + perHour,
      endsAtMs,
      ended: (known?.ended ?? true) && ended,
    });
  }
  const programWords = (entry: { endsAtMs: number | null; ended: boolean }): string | null =>
    entry.ended ? "ended" : entry.endsAtMs === null ? null : `ends in ${formatDuration(entry.endsAtMs - nowMs)}`;

  const out: Contribution[] = [];
  for (const [typeID, entry] of raw) {
    out.push({ typeID, source: { ...base, perHour: entry.perHour, quality: quality(typeID), programWords: programWords(entry), weak: false } });
  }

  // Made, per recipe. ⚠ A FACTORY FED BY ITS OWN COLONY IS NOT JUDGED BY THIS
  // INSTANT. It runs a batch whenever a batch's worth has arrived and sits
  // idle between, so whether it is mid-cycle at the moment of the read says
  // nothing about its rate: a whole colony read between batches would count as
  // making nothing. Such a basic is credited with what the colony pulls up,
  // capped by every factory set to the recipe. A factory fed from elsewhere
  // (P2 and up) is counted only while the server says it is running.
  const setTo = new Map<number, number>();
  const running = new Map<number, number>();
  for (const pin of colony.pins) {
    if (pin.kind !== "factory" || pin.schematicID === null) continue;
    setTo.set(pin.schematicID, (setTo.get(pin.schematicID) ?? 0) + 1);
    if (pin.active !== false) running.set(pin.schematicID, (running.get(pin.schematicID) ?? 0) + 1);
  }
  for (const [schematicID, count] of setTo) {
    const recipe = book.bySchematicID.get(schematicID);
    if (!recipe) continue;
    let perHour = perHourOf(recipe, running.get(schematicID) ?? 0);
    let resource: number | null = null;
    const only = recipe.inputs.length === 1 ? recipe.inputs[0] : null;
    if (only && tierOf(book, only.typeID) === 0 && raw.has(only.typeID)) {
      const pulled = raw.get(only.typeID)!;
      perHour = Math.min(perHourOf(recipe, count), (pulled.perHour * recipe.output.quantity) / only.quantity);
      resource = only.typeID;
    }
    if (perHour <= 0 && resource === null) continue;
    const pulled = resource === null ? null : raw.get(resource)!;
    out.push({
      typeID: recipe.output.typeID,
      source: {
        ...base,
        perHour,
        quality: resource === null ? null : quality(resource),
        programWords: pulled ? programWords(pulled) : null,
        weak: false,
      },
    });
  }
  return out;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2;
}

/** Every commodity the roster makes, plus every basic it does not, with the balanced target. */
export function buildCoverage(input: CoverageInput): Coverage {
  const { book, readings, names, browserNowMs } = input;
  const byType = new Map<number, CoverageSource[]>();
  let colonyCount = 0;
  for (const [characterID, reading] of readings) {
    const ownerName = names.get(characterID) ?? "A pilot this browser does not name";
    const nowMs = serverNow(reading.report.clockOffsetMs, browserNowMs);
    for (const colony of reading.report.colonies) {
      colonyCount += 1;
      for (const { typeID, source } of colonyContributions(book, colony, characterID, ownerName, nowMs)) {
        const list = byType.get(typeID) ?? [];
        list.push(source);
        byType.set(typeID, list);
      }
    }
  }

  const demand = balancedDemand(book);
  const basics = [...book.commodities.values()].filter((commodity) => commodity.tier === 1).map((commodity) => commodity.typeID);
  for (const typeID of basics) if (!byType.has(typeID)) byType.set(typeID, []);
  const basicsMade = basics.filter((typeID) => (byType.get(typeID) ?? []).some((source) => source.perHour > 0));
  const madePerHour = basics.reduce((total, typeID) => total + (byType.get(typeID) ?? []).reduce((sum, source) => sum + source.perHour, 0), 0);
  const demandTotal = basics.reduce((total, typeID) => total + (demand.get(typeID) ?? 0), 0);
  const typicalColony = median(basics.flatMap((typeID) => (byType.get(typeID) ?? []).map((source) => source.perHour)).filter((rate) => rate > 0));

  const lines: CoverageLine[] = [];
  for (const [typeID, raw] of byType) {
    const tier = tierOf(book, typeID);
    if (tier === null) continue;
    const typical = median(raw.map((source) => source.perHour).filter((rate) => rate > 0));
    const sources = raw
      .map((source) => ({ ...source, weak: raw.length > 1 && source.perHour < typical * WEAK_SHARE }))
      .sort((left, right) => right.perHour - left.perHour);
    const perHour = sources.reduce((total, source) => total + source.perHour, 0);
    let targetPerHour: number | null = null;
    let colonyGap: number | null = null;
    let state: CoverageState = "untargeted";
    if (tier === 1 && demandTotal > 0 && madePerHour > 0) {
      targetPerHour = (madePerHour * (demand.get(typeID) ?? 0)) / demandTotal;
      state = perHour <= 0 ? "none" : perHour < targetPerHour * SHORT_SHARE ? "short" : "ok";
      if (state !== "ok" && typicalColony > 0) {
        colonyGap = Math.max(1, Math.round((targetPerHour - perHour) / typicalColony));
      }
    } else if (tier === 1 && perHour <= 0) {
      state = "none";
    }
    lines.push({
      typeID,
      typeName: commodityName(book, typeID) ?? "A commodity this table does not name",
      tier,
      colonies: new Set(sources.map((source) => `${source.planetID}:${source.characterID}`)).size,
      perHour,
      targetPerHour,
      colonyGap,
      state,
      weakCount: sources.filter((source) => source.weak).length,
      sources: Object.freeze(sources),
    });
  }
  lines.sort((left, right) => left.typeName.localeCompare(right.typeName));

  return {
    lines,
    summary: {
      colonies: colonyCount,
      basicsMade: basicsMade.length,
      basicsKnown: basics.length,
      short: lines.filter((line) => line.state === "short" || line.state === "none").length,
      // Weak is a planet's word: counted where the drilling is, on the raw lines.
      weak: lines.filter((line) => line.tier === 0).reduce((total, line) => total + line.weakCount, 0),
    },
  };
}
