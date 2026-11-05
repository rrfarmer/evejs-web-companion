// Jobs against a plan (goal R109 slice 5): what is already being made, and
// what can be started next. Pure; the panel hands in each online pilot's own
// industry read.
//
// ---------------------------------------------------------------------------
// A JOB IS SUPPLY THAT HAS NOT ARRIVED YET.
//
// A running, paused or ready job will put its product in a hangar; until it is
// delivered it is counted as in production, which the resolver treats like
// stock (bridge/industryChain.ts). Delivered, it is stock, and the next stock
// read sees it there. Units are runs times what one run makes, from the recipe.
//
// ---------------------------------------------------------------------------
// START NEXT IS A LIST, NOT A SCHEDULER.
//
// It says which steps of the plan have every input in hand, grouped by stage the
// way a build is worked (buy, then reactions, then components, then the final
// item). Starting one is the Industry panel's job, behind its own confirm; this
// only says which pilot holds the blueprint to start it with.

import type { IndustryJobRow } from "../store/types.ts";
import { isActiveJob } from "./industry.ts";
import type { IndustryChain, IndustryLine } from "./industryChain.ts";
import type { PlanInvention } from "./industryInvention.ts";
import type { IndustryRecipeBook } from "./industryRecipes.ts";
import type { OwnedBlueprint } from "./industryOwned.ts";
import type { PilotStockStack } from "./stockHoldings.ts";

/** Units being made per product type, and how many of them are ready to deliver. */
export interface JobSupply {
  readonly inProduction: Map<number, number>;
  readonly ready: Map<number, number>;
  /**
   * Invention attempts underway, per T2 blueprint type they invent. One run is
   * one attempt; it counts until delivered, as the server rolls the outcome at
   * install but hands the copy over only then.
   */
  readonly inventing: Map<number, number>;
}

/**
 * Every pilot's active jobs, counted once each (two sessions on one pilot read
 * the same jobs), as units of their product.
 */
export function jobSupply(jobLists: readonly (readonly IndustryJobRow[])[], book: IndustryRecipeBook | null): JobSupply {
  const inProduction = new Map<number, number>();
  const ready = new Map<number, number>();
  const inventing = new Map<number, number>();
  const seen = new Set<number>();
  for (const jobs of jobLists) {
    for (const job of jobs) {
      if (seen.has(job.jobID)) continue;
      seen.add(job.jobID);
      if (!isActiveJob(job.status)) continue;
      if (job.activity === "invention" && job.productTypeID > 0 && job.runs > 0) {
        inventing.set(job.productTypeID, (inventing.get(job.productTypeID) ?? 0) + job.runs);
        continue;
      }
      if (job.activity !== "manufacturing" && job.activity !== "reaction") continue;
      if (job.productTypeID <= 0 || job.runs <= 0) continue;
      const perRun = book?.byProduct.get(job.productTypeID)?.quantityPerRun ?? 1;
      const units = job.runs * perRun;
      inProduction.set(job.productTypeID, (inProduction.get(job.productTypeID) ?? 0) + units);
      if (job.status === "ready") {
        ready.set(job.productTypeID, (ready.get(job.productTypeID) ?? 0) + units);
      }
    }
  }
  return { inProduction, ready, inventing };
}

export type StartStage = "reactions" | "components" | "final";

/** One step still to start. */
export interface StartStep {
  readonly line: IndustryLine;
  /** Every input held or already being made. */
  readonly canStart: boolean;
}

export interface StartGroup {
  readonly stage: StartStage;
  readonly label: string;
  readonly steps: readonly StartStep[];
}

const STAGE_LABEL: Readonly<Record<StartStage, string>> = {
  reactions: "Reactions",
  components: "Components",
  final: "Final",
};

/**
 * The steps that still have runs to start, deepest first within each stage,
 * stages in the order a build is worked. Bought items are the Missing list's.
 */
export function startNext(chain: IndustryChain): StartGroup[] {
  const groups = new Map<StartStage, StartStep[]>([["reactions", []], ["components", []], ["final", []]]);
  const rootTypeID = chain.root.typeID;
  for (const typeID of [...chain.order].reverse()) {
    const line = chain.lines.get(typeID);
    if (!line || line.obtain === "buy" || line.runs <= 0) continue;
    let canStart = true;
    for (const materialTypeID of line.materials.keys()) {
      const input = chain.lines.get(materialTypeID);
      if (input && input.short > 0) {
        canStart = false;
        break;
      }
    }
    const stage: StartStage = typeID === rootTypeID ? "final" : line.obtain === "react" ? "reactions" : "components";
    groups.get(stage)?.push({ line, canStart });
  }
  return (["reactions", "components", "final"] as const)
    .map((stage) => ({ stage, label: STAGE_LABEL[stage], steps: groups.get(stage) ?? [] }))
    .filter((group) => group.steps.length > 0);
}

// ---------------------------------------------------------------------------
// WHERE A JOB CAN START — the server's rules, checked before the button shows.
//
// From server/src/services/industry/ (industryRuntimeState.js validation and
// industryRestrictions.js resolveIndustryFacilityDistanceRestriction):
//   1. the blueprint sits in an industry facility, and the job runs in that
//      facility only (INVALID_BLUEPRINT_LOCATION, BLUEPRINT_WRONG_FACILITY);
//   2. the facility is no more stargate jumps from the pilot's current system
//      than 5 per level of the activity's range skill (FACILITY_DISTANCE);
//   3. the materials are in the job's input hangar there (MISSING_MATERIAL).
// A copy picked without these was refused live (2026-10-01). The facility must
// also be one the pilot's own industry read offers: that list is what the
// Industry panel lets the player pick from.

/** Jumps of remote reach per level of the range skill (server FACILITY_RANGE_BY_SKILL_LEVEL). */
export const RANGE_JUMPS_PER_LEVEL = 5;

/** The work a job does, as far as the manager starts any. */
export type InstallActivity = "manufacturing" | "reaction" | "invention";

/** The range skill per activity (server INDUSTRY_DISTANCE_SKILL_BY_ACTIVITY). */
export const RANGE_SKILL_BY_ACTIVITY: Readonly<Record<InstallActivity, number>> = {
  manufacturing: 24268, // Supply Chain Management
  reaction: 45750, // Remote Reactions
  invention: 24270, // Scientific Networking
};

/** A facility the pilot's own industry read lists. */
export interface InstallFacility {
  readonly solarSystemID: number;
  /** The work it hosts, by the read's activity names. */
  readonly activities: ReadonlySet<string>;
}

/** What the check needs to know about one online pilot. */
export interface InstallPilot {
  readonly characterName: string;
  /** The system it is in now, and the station or structure it is docked in. */
  readonly solarSystemID: number | null;
  readonly dockedAt: number | null;
  /** Trained level per skill type; null when its skills have not been read. */
  readonly skills: ReadonlyMap<number, number> | null;
  /** Facility -> where it is and what it hosts, from the pilot's own industry read. */
  readonly facilities: ReadonlyMap<number, InstallFacility>;
  /** Its own stacks with where they sit, from the stock read; null when unread. */
  readonly stock: readonly PilotStockStack[] | null;
}

export type InstallBlock =
  | "no-copy"
  | "not-in-facility"
  | "skills-unknown"
  | "out-of-range"
  | "facility-not-offered"
  | "work-not-offered"
  | "materials-elsewhere";

export type InstallCheck =
  | {
      readonly ok: true;
      readonly from: OwnedBlueprint;
      readonly activity: InstallActivity;
      /** Runs to fill in: the step's, or for invention what the copy carries. */
      readonly runs: number;
      /** Invention only: the plan's decryptor, used one per run; null without one. */
      readonly decryptorTypeID: number | null;
      /** Invention only: the blueprint the plan wants invented; null for any other work. */
      readonly productTypeID: number | null;
    }
  | {
      readonly ok: false;
      readonly block: InstallBlock;
      readonly activity: InstallActivity;
      readonly decryptorTypeID: number | null;
      /** The copy that got furthest, and the numbers that stopped it. */
      readonly from: OwnedBlueprint | null;
      readonly jumps: number | null;
      readonly range: number | null;
    };

const STAGE: Readonly<Record<InstallBlock, number>> = {
  "no-copy": 0,
  "not-in-facility": 1,
  "skills-unknown": 2,
  "out-of-range": 3,
  "facility-not-offered": 4,
  "work-not-offered": 5,
  "materials-elsewhere": 6,
};

type Blocked = Extract<InstallCheck, { ok: false }>;

/**
 * Where a copy stands before materials: in an industry facility, its pilot's
 * skills read, that facility within the pilot's reach, listed by the pilot's
 * own Industry panel, and hosting the work. Null when all of that holds.
 */
function reachBlock(
  copy: OwnedBlueprint,
  pilot: InstallPilot,
  activity: InstallActivity,
  jumpsBetween: (fromSystemID: number, toSystemID: number) => number | null,
): Blocked | null {
  const blocked = (block: InstallBlock, jumps: number | null = null, range: number | null = null): Blocked =>
    ({ ok: false, block, activity, decryptorTypeID: null, from: copy, jumps, range });
  if (copy.facilityID === null) return blocked("not-in-facility");
  if (pilot.skills === null || pilot.solarSystemID === null) return blocked("skills-unknown");
  const facility = pilot.facilities.get(copy.facilityID);
  // The blueprint's own system, as the server states it on the row; the
  // facility list only covers the pilot's current region, so it cannot be
  // the source of a far copy's whereabouts.
  const facilitySystem = copy.solarSystemID ?? facility?.solarSystemID ?? null;
  const range = RANGE_JUMPS_PER_LEVEL * Math.min(Math.max(pilot.skills.get(RANGE_SKILL_BY_ACTIVITY[activity]) ?? 0, 0), 5);
  const jumps = facilitySystem === null ? null : jumpsBetween(pilot.solarSystemID, facilitySystem);
  if (jumps === null || jumps > range) return blocked("out-of-range", jumps, range);
  // In reach, but the Industry panel can only start a job in a facility its
  // own read lists, and the server only where the facility hosts the work
  // (seen live: a factory that offers manufacturing and no invention).
  if (!facility) return blocked("facility-not-offered", jumps, range);
  if (!facility.activities.has(activity)) return blocked("work-not-offered", jumps, range);
  return null;
}

/** Idle copies of one blueprint held by online pilots, docked first, then best first. */
function candidatesFor(
  blueprintTypeID: number,
  owned: readonly OwnedBlueprint[],
  pilots: ReadonlyMap<number, InstallPilot>,
): OwnedBlueprint[] {
  const docked = (copy: OwnedBlueprint): number =>
    Number(copy.facilityID !== null && copy.facilityID === pilots.get(copy.characterID)?.dockedAt);
  return owned
    .filter((blueprint) => blueprint.blueprintTypeID === blueprintTypeID && !blueprint.busy && pilots.has(blueprint.characterID))
    .sort((a, b) => docked(b) - docked(a));
}

/** The copy a plan is worked out with, and whether a job can start from it. */
export interface PlannedCopy {
  readonly copy: OwnedBlueprint;
  /** True when the copy passes every check but materials (reachBlock). */
  readonly inReach: boolean;
}

/**
 * Per owned blueprint type, the copy a job would actually run from: the best
 * one in reach of its pilot (where it is docked breaking a tie), else the best
 * owned one. A plan worked out with a copy nobody can start a job from asks for
 * materials no job will use (seen live: planned at material 10% from a copy in
 * a container, run at 0% from the one in the hangar). `reactions` holds the
 * blueprint types that are reaction formulas, for which range skill applies.
 */
export function plannedCopies(
  owned: readonly OwnedBlueprint[],
  pilots: ReadonlyMap<number, InstallPilot>,
  jumpsBetween: (fromSystemID: number, toSystemID: number) => number | null,
  reactions: ReadonlySet<number> = new Set(),
): Map<number, PlannedCopy> {
  const planned = new Map<number, PlannedCopy>();
  for (const blueprint of owned) {
    if (planned.has(blueprint.blueprintTypeID)) continue;
    const activity: InstallActivity = reactions.has(blueprint.blueprintTypeID) ? "reaction" : "manufacturing";
    const reachable = candidatesFor(blueprint.blueprintTypeID, owned, pilots)
      .filter((copy) => reachBlock(copy, pilots.get(copy.characterID) as InstallPilot, activity, jumpsBetween) === null);
    // `owned` is best first; the docked copy wins only among equals.
    const best = reachable.reduce<OwnedBlueprint | null>((kept, copy) =>
      kept === null || copy.materialEfficiency > kept.materialEfficiency ||
      (copy.materialEfficiency === kept.materialEfficiency && copy.timeEfficiency > kept.timeEfficiency) ? copy : kept, null);
    planned.set(blueprint.blueprintTypeID, best ? { copy: best, inReach: true } : { copy: blueprint, inReach: false });
  }
  return planned;
}

/** One job to check: from which blueprint, doing what, using what per copy. */
interface InstallSpec {
  readonly blueprintTypeID: number | null;
  readonly activity: InstallActivity;
  /** Copies worth trying; all idle ones when absent. */
  readonly accept?: (copy: OwnedBlueprint) => boolean;
  readonly runsFor: (copy: OwnedBlueprint) => number;
  readonly materialsFor: (copy: OwnedBlueprint) => ReadonlyMap<number, number>;
  /** Invention only: the decryptor the job adds. */
  readonly decryptorTypeID?: number | null;
  /** Invention only: the blueprint to invent. */
  readonly productTypeID?: number | null;
}

function checkInstall(
  spec: InstallSpec,
  owned: readonly OwnedBlueprint[],
  pilots: ReadonlyMap<number, InstallPilot>,
  jumpsBetween: (fromSystemID: number, toSystemID: number) => number | null,
): InstallCheck {
  const { activity } = spec;
  const decryptorTypeID = spec.decryptorTypeID ?? null;
  const candidates = spec.blueprintTypeID === null
    ? []
    : candidatesFor(spec.blueprintTypeID, owned, pilots).filter((copy) => spec.accept?.(copy) ?? true);

  let furthest: Blocked = { ok: false, block: "no-copy", activity, decryptorTypeID, from: null, jumps: null, range: null };
  const note = (blocked: Blocked): void => {
    if (STAGE[blocked.block] > STAGE[furthest.block]) furthest = { ...blocked, decryptorTypeID };
  };

  for (const copy of candidates) {
    const pilot = pilots.get(copy.characterID) as InstallPilot;
    const blocked = reachBlock(copy, pilot, activity, jumpsBetween);
    if (blocked) {
      note(blocked);
      continue;
    }
    if (pilot.stock !== null) {
      const here = new Map<number, number>();
      for (const stack of pilot.stock) {
        if (stack.holder === "hangar" && stack.locationID === copy.facilityID) {
          here.set(stack.typeID, (here.get(stack.typeID) ?? 0) + stack.quantity);
        }
      }
      const short = [...spec.materialsFor(copy)].some(([typeID, quantity]) => (here.get(typeID) ?? 0) < quantity);
      if (short) {
        note({ ok: false, block: "materials-elsewhere", activity, decryptorTypeID, from: copy, jumps: null, range: null });
        continue;
      }
    }
    return { ok: true, from: copy, activity, runs: spec.runsFor(copy), decryptorTypeID, productTypeID: spec.productTypeID ?? null };
  }
  return furthest;
}

/**
 * Whether `line` can be started now, and from which copy. `jumpsBetween` is
 * the fewest stargate jumps between two systems, or null when unknown.
 * Copies are tried where their pilot is docked first, then best first (`owned`
 * is already best-first, bridge/industryOwned.ts). With `planned`, only copies
 * at its material efficiency are tried: the line's materials were worked out
 * at that efficiency, and a job from any other copy would use different
 * amounts. When none passes, the copy that got furthest says why.
 */
export function installCheck(
  line: IndustryLine,
  owned: readonly OwnedBlueprint[],
  pilots: ReadonlyMap<number, InstallPilot>,
  jumpsBetween: (fromSystemID: number, toSystemID: number) => number | null,
  planned: OwnedBlueprint | null = null,
): InstallCheck {
  return checkInstall({
    blueprintTypeID: line.blueprint?.blueprintTypeID ?? null,
    activity: line.obtain === "react" ? "reaction" : "manufacturing",
    accept: (copy) => planned === null || copy.materialEfficiency === planned.materialEfficiency,
    runsFor: () => line.jobRuns[0] ?? line.runs,
    materialsFor: () => line.materials,
  }, owned, pilots, jumpsBetween);
}

/**
 * Whether the attempts `row` still has to start can be started now, from
 * which T1 copy, and how many runs (one run is one attempt; at most what the
 * copy carries, as the server allows no more). An original cannot be invented
 * from, so only copies are tried. A decryptor the plan chose goes with the
 * job, one per run like the datacores, and must be in the same hangar; the
 * Industry panel adds it to the install (web/src/bridge/industryReckonings.mjs says how).
 * The blueprint the row is for is named too: a T1 blueprint can invent one
 * of several, and the job makes the one that is chosen.
 */
export function inventionCheck(
  row: PlanInvention,
  owned: readonly OwnedBlueprint[],
  pilots: ReadonlyMap<number, InstallPilot>,
  jumpsBetween: (fromSystemID: number, toSystemID: number) => number | null,
): InstallCheck {
  const runsFor = (copy: OwnedBlueprint): number => Math.max(1, Math.min(row.need.toStart, copy.runs ?? 0));
  const decryptorTypeID = row.decryptor?.typeID ?? null;
  return checkInstall({
    blueprintTypeID: row.source.blueprintTypeID,
    activity: "invention",
    accept: (copy) => !copy.original && (copy.runs ?? 0) > 0,
    runsFor,
    materialsFor: (copy) => {
      const runs = runsFor(copy);
      const materials = new Map(row.source.materials.map((material) => [material.typeID, material.quantity * runs]));
      if (decryptorTypeID !== null) materials.set(decryptorTypeID, (materials.get(decryptorTypeID) ?? 0) + runs);
      return materials;
    },
    decryptorTypeID,
    productTypeID: row.line.blueprint?.blueprintTypeID ?? null,
  }, owned, pilots, jumpsBetween);
}

/** Plain words for why a step cannot be set up yet. */
export function installBlockWords(check: Extract<InstallCheck, { ok: false }>): string {
  const who = check.from ? check.from.characterName : "Nobody online here";
  const work = check.activity === "invention" ? "invention" : check.activity === "reaction" ? "reactions" : "manufacturing";
  switch (check.block) {
    case "no-copy":
      return check.activity === "invention"
        ? "Nobody online here holds an idle copy of the blueprint it is invented from."
        : "Nobody online here holds an idle copy of its blueprint.";
    case "not-in-facility":
      return `${who}'s copy is not in a hangar where industry is offered.`;
    case "facility-not-offered":
      return `${who}'s copy is in a facility ${who}'s Industry panel does not list.`;
    case "work-not-offered":
      return `${who}'s copy is in a facility that does not offer ${work}.`;
    case "skills-unknown":
      return `${who}'s skills have not been read yet.`;
    case "out-of-range":
      return check.jumps === null
        ? `${who}'s copy is in a facility no route reaches.`
        : `${who}'s copy is ${check.jumps} ${check.jumps === 1 ? "jump" : "jumps"} away; ${who} can start ${work} jobs ${check.range === 0 ? "only in the same system" : `up to ${check.range} jumps away`}.`;
    case "materials-elsewhere":
      return check.activity === "invention"
        ? `The datacores${check.decryptorTypeID !== null ? " and the decryptor" : ""} are not all in ${who}'s hangar where the blueprint is.`
        : `The materials are not all in ${who}'s hangar where the blueprint is.`;
  }
}
