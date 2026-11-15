// Industry reads decoded to named blueprints, jobs and facilities (goal R15).
//
// THE ID BOUNDARY (R7d). Every industry identifier the server speaks in — the
// activityID, the job status code, the blueprint typeID, the product typeID,
// the facilityID — is translated HERE and only here:
//
//   activityID  1/3/4/5/8/9  -> "manufacturing" / "research_time" / ...
//                               -> a player-facing label ("Manufacturing")
//   status      1/3/101/102  -> "running" / "ready" / "delivered" / ...
//   blueprint/product typeID -> a NAME, via the shared name cache
//   facilityID               -> a station NAME, via the shared name cache
//                               (an NPC facility's id IS its station id)
//
// Past this module the panel only ever handles names and the semantic string
// unions in store/types.ts, so no numeric identifier can reach rendered text.
//
// WHAT IS LIVE AND WHAT IS STATIC. The live calls answer the things that are
// true of THIS PLAYER: which blueprints they hold and at what efficiencies,
// which jobs are running, which facilities their region offers. Static data
// answers the things that are true of the GAME: what a blueprint is called,
// what it makes, and what each activity consumes. Neither is derived from the
// other, and nothing here recomputes a job outcome — the server stays
// authoritative for every number a job actually produced.

import { isListValue, readKeyVal, unwrapLong, type JsonValue } from "./wire.ts";
import type {
  IndustryActivity,
  IndustryBlueprintRow,
  IndustryDefinition,
  IndustryFacilityRow,
  IndustryJobRow,
  IndustryJobStatus,
  IndustryMaterial,
  IndustryRecipe,
  IndustrySlotUsage,
  IndustryFacilityModifier,
  IndustryFacilityModifiers,
} from "../store/types.ts";

/**
 * activityID -> activity name (industryConstants.INDUSTRY_ACTIVITY). Note the
 * gap: there is no activity 2, 6 or 7. An id outside this map decodes to null
 * and the panel shows the job without an activity label rather than inventing
 * one — it never falls back to printing the number.
 */
const ACTIVITY_BY_ID: Readonly<Record<number, IndustryActivity>> = {
  1: "manufacturing",
  3: "research_time",
  4: "research_material",
  5: "copying",
  8: "invention",
  9: "reaction",
};

const ACTIVITY_ID_BY_NAME: Readonly<Record<IndustryActivity, number>> = {
  manufacturing: 1,
  research_time: 3,
  research_material: 4,
  copying: 5,
  invention: 8,
  reaction: 9,
};

/**
 * Player-facing activity names — plain language (R9a), never an id and never
 * the static-data snake_case key. "Time research", not "research_time".
 */
export const ACTIVITY_LABELS: Readonly<Record<IndustryActivity, string>> = {
  manufacturing: "Manufacturing",
  research_time: "Time research",
  research_material: "Material research",
  copying: "Copying",
  invention: "Invention",
  reaction: "Reactions",
};

/** Render order: how an industry window reads top to bottom. */
export const ACTIVITY_ORDER: readonly IndustryActivity[] = [
  "manufacturing",
  "copying",
  "research_material",
  "research_time",
  "invention",
  "reaction",
];

/**
 * Whether a kind of work is for a blueprint as it is, an original or a copy. A copy is not copied or researched,
 * nor is a reaction run from one, and only a copy is invented from. The game's own client offers a blueprint no
 * other work, and the server refuses any other (INCOMPATIBLE_ACTIVITY).
 */
export function activityIsFor(activity: IndustryActivity, original: boolean): boolean {
  if (activity === "manufacturing") {
    return true;
  }
  return activity === "invention" ? !original : original;
}

/** industry.ACTIVITIES (industry/const.py 15 to 21): the order the client's window looks for a blueprint's work in. */
const CLIENT_ACTIVITY_ORDER: readonly IndustryActivity[] = ["manufacturing", "research_material", "research_time", "copying", "invention", "reaction"];

/**
 * The work and the place of a job as its blueprint is chosen, as the client's industry window makes one
 * (industryWnd.py 131 to 160 and 191 to 211; industrySvc.CreateJob, 92 to 110): at the blueprint's own facility, by
 * the first kind of work, in the client's own order, that the blueprint is for and that facility takes. Where the
 * facility takes none of them, or is not one the page has to work at, the work is the blueprint's first in that
 * order and no place is chosen: the pilot is left to choose one.
 *
 * (The client looks first for the work the pilot used last, a setting of its own. The page keeps none.)
 *
 * `activities` are the kinds of work the blueprint is for, as it is; `blueprintFacilityID` the facility the
 * blueprint is in, or null; `facilities` those the page has read.
 */
export function jobAsChosen(
  activities: readonly IndustryActivity[],
  blueprintFacilityID: number | null,
  facilities: readonly IndustryFacilityRow[],
): { readonly activity: IndustryActivity | null; readonly facilityID: number | null } {
  const own = facilities.find((facility) => facility.facilityID === blueprintFacilityID && facility.online) ?? null;
  const inOrder = CLIENT_ACTIVITY_ORDER.filter((activity) => activities.includes(activity));
  const taken = own ? inOrder.find((activity) => own.activities.includes(activity)) : undefined;
  return { activity: taken ?? inOrder[0] ?? null, facilityID: own !== null && taken !== undefined ? own.facilityID : null };
}

/**
 * What keeps a job from being asked about, by what the pilot has chosen for it: no work or no place, no runs, a
 * research that is finished, an invention with none of its several products chosen, or a copy job whose copies
 * are licensed for no runs or for more than the blueprint allows.
 */
export function jobCannotBeAsked(job: {
  readonly activity: IndustryActivity | null;
  readonly facilityID: number | null;
  readonly runs: number;
  readonly researchFinished: boolean;
  readonly productUnchosen: boolean;
  readonly licensedRuns: number;
  readonly mostLicensedRuns: number;
}): boolean {
  return (
    job.activity === null || job.facilityID === null || job.runs < 1 || job.researchFinished || job.productUnchosen ||
    (job.activity === "copying" && !(job.licensedRuns >= 1 && job.licensedRuns <= job.mostLicensedRuns))
  );
}

/** The most copies one copy job makes: the game's own client holds a job to it, and the server refuses more. */
export const MOST_COPIES_A_JOB = 500;

/** The most runs of one invention: the game's own client holds a job to it, and the server refuses more. */
export const MOST_INVENTIONS_A_JOB = 500;

/**
 * The blueprints an invention could make, where its recipe has more than one: the job makes the one the pilot
 * chooses, and the game's own client sends no such job until one is chosen. None where the recipe has the one,
 * which the job makes with nothing said, and none for any other kind of work.
 */
export function inventionChoices(recipe: IndustryRecipe | null): readonly number[] {
  return recipe && recipe.activity === "invention" && recipe.products.length > 1 ? recipe.products.map((product) => product.typeID) : [];
}

/** What one run of a research takes of its recipe's time, by the level the run starts from: the game's own table. */
const RESEARCH_TIMES: readonly number[] = [1.0, 29 / 21.0, 23 / 7.0, 39 / 5.0, 278 / 15.0, 928 / 21.0, 2200 / 21.0, 5251 / 21.0, 4163 / 7.0, 29660 / 21.0];

/** The two researches: which of a blueprint's researches each is of, the step one run raises it by, and the most it comes to. */
const RESEARCH_OF: Readonly<Partial<Record<IndustryActivity, { readonly of: "timeEfficiency" | "materialEfficiency"; readonly step: number; readonly most: number }>>> = {
  research_time: { of: "timeEfficiency", step: 2, most: 20 },
  research_material: { of: "materialEfficiency", step: 1, most: 10 },
};

/** Where a blueprint stands in a research, and what a job of some runs would bring it to. */
export interface ResearchStanding {
  /** The level it is at: the level its next run starts from. */
  readonly level: number;
  /** The runs left to it. */
  readonly runsLeft: number;
  /** True at the last level: it cannot be researched any further. */
  readonly finished: boolean;
  /** Its research of that kind now, and after the runs said, in percent. */
  readonly from: number;
  readonly to: number;
}

/**
 * Where a blueprint stands in a research, as the game's own client reads it of the blueprint, and what `runs` of
 * the research would bring the blueprint's research to (never past the most). Null for a kind of work that is no
 * research.
 */
export function researchStanding(
  activity: IndustryActivity,
  blueprint: Pick<IndustryBlueprintRow, "timeEfficiency" | "materialEfficiency">,
  runs = 0,
): ResearchStanding | null {
  const research = RESEARCH_OF[activity];
  if (!research) {
    return null;
  }
  const from = Math.max(0, Math.min(research.most, Math.trunc(blueprint[research.of]) || 0));
  return {
    level: Math.floor(from / research.step),
    runsLeft: Math.floor((research.most - from) / research.step),
    finished: from >= research.most,
    from,
    to: Math.min(from + research.step * Math.max(0, Math.trunc(runs) || 0), research.most),
  };
}

/**
 * The most runs a job of a kind of work could be asked for of a blueprint. A copy is finite; a copy job makes only
 * so many copies; a research has only the levels that are left to the blueprint (one at the least, as the game's
 * own client has it); and an invention has only so many runs, and no more than its copy has.
 */
export function mostRunsToAsk(
  activity: IndustryActivity | null,
  blueprint: Pick<IndustryBlueprintRow, "original" | "runs" | "timeEfficiency" | "materialEfficiency">,
): number {
  if (activity === "copying") {
    return MOST_COPIES_A_JOB;
  }
  const research = activity === null ? null : researchStanding(activity, blueprint);
  if (research) {
    return Math.max(1, research.runsLeft);
  }
  const most = blueprint.original ? 1000 : Math.max(1, blueprint.runs);
  return activity === "invention" ? Math.min(most, MOST_INVENTIONS_A_JOB) : most;
}

/** status code -> status name (industryConstants.INDUSTRY_STATUS). */
const STATUS_BY_ID: Readonly<Record<number, IndustryJobStatus>> = {
  0: "unsubmitted",
  1: "running",
  2: "paused",
  3: "ready",
  100: "completed",
  101: "delivered",
  102: "cancelled",
  103: "reverted",
};

/** Player-facing job status text (R9a: what it means, not what it is called). */
export const STATUS_LABELS: Readonly<Record<IndustryJobStatus, string>> = {
  unsubmitted: "Not started",
  running: "In progress",
  ready: "Ready to deliver",
  paused: "Paused",
  completed: "Finished",
  delivered: "Delivered",
  cancelled: "Cancelled",
  reverted: "Reverted",
};

/** A job that is still going or waiting to be collected. */
export function isActiveJob(status: IndustryJobStatus): boolean {
  return status === "running" || status === "ready" || status === "paused";
}

export function activityIDOf(activity: IndustryActivity): number {
  return ACTIVITY_ID_BY_NAME[activity];
}

export function activityOfID(activityID: number): IndustryActivity | null {
  return ACTIVITY_BY_ID[activityID] ?? null;
}

function toNumberOrNull(value: JsonValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const long = unwrapLong(value);
  return long === null ? null : Number(long);
}

function toNumber(value: JsonValue | undefined): number {
  return toNumberOrNull(value) ?? 0;
}

function listItems(value: JsonValue | undefined): readonly JsonValue[] {
  return isListValue(value) ? value.items : [];
}

function dictEntries(value: JsonValue | undefined): readonly (readonly JsonValue[])[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const dict = value as { type?: unknown; entries?: unknown };
  if (dict.type !== "dict" || !Array.isArray(dict.entries)) {
    return [];
  }
  return (dict.entries as readonly JsonValue[]).filter(Array.isArray) as readonly (readonly JsonValue[])[];
}

// --- Blueprints ------------------------------------------------------------

/**
 * Decode blueprintManager.GetBlueprintDataByOwner.
 *
 * ⚠ The result is a 2-TUPLE — a plain JSON array of [list<instance>,
 * dict<facilityID -> count>] — not a list. Reading it as a list yields nothing.
 * Only the first element is the blueprints; the second is a per-facility tally
 * the panel does not need (it counts what it lists).
 */
export function decodeBlueprints(result: JsonValue): readonly IndustryBlueprintRow[] {
  const tuple = Array.isArray(result) ? (result as readonly JsonValue[]) : null;
  const rows = listItems(tuple ? tuple[0] : undefined);
  const blueprints: IndustryBlueprintRow[] = [];
  for (const row of rows) {
    const itemID = toNumber(readKeyVal(row, "itemID"));
    if (itemID <= 0) {
      continue;
    }
    const jobID = toNumberOrNull(readKeyVal(row, "jobID"));
    const facilityID = toNumberOrNull(readKeyVal(row, "facilityID"));
    blueprints.push({
      itemID,
      typeID: toNumber(readKeyVal(row, "typeID")),
      // Distinct fields with distinct meanings — do not transpose them. The
      // gateway suite seeds them to different values so a swap fails a test.
      materialEfficiency: toNumber(readKeyVal(row, "materialEfficiency")),
      timeEfficiency: toNumber(readKeyVal(row, "timeEfficiency")),
      runs: toNumber(readKeyVal(row, "runs")),
      original: readKeyVal(row, "original") === true,
      locationID: toNumber(readKeyVal(row, "locationID")),
      facilityID: facilityID && facilityID > 0 ? facilityID : null,
      solarSystemID: toNumber(readKeyVal(row, "solarSystemID")) > 0 ? toNumber(readKeyVal(row, "solarSystemID")) : null,
      // Non-null means BUSY: the blueprint is locked into a running job and
      // cannot be installed into another one.
      jobID: jobID && jobID > 0 ? jobID : null,
    });
  }
  return blueprints;
}

// --- Jobs ------------------------------------------------------------------

/** Decode industryManager.GetJobsByOwner (or a single GetJob row). */
export function decodeJobs(result: JsonValue): readonly IndustryJobRow[] {
  return listItems(result)
    .map((row) => decodeJob(row))
    .filter((job): job is IndustryJobRow => job !== null);
}

/** Decode ONE job row — the shape GetJob answers and GetJobsByOwner repeats. */
export function decodeJob(row: JsonValue): IndustryJobRow | null {
  const jobID = toNumber(readKeyVal(row, "jobID"));
  if (jobID <= 0) {
    return null;
  }
  const statusID = toNumber(readKeyVal(row, "status"));
  return {
    jobID,
    activity: activityOfID(toNumber(readKeyVal(row, "activityID"))),
    // The SERVER's status, including its own "ready" derivation — the browser
    // never compares endDate to the clock to decide whether a job is done.
    status: STATUS_BY_ID[statusID] ?? "unsubmitted",
    blueprintID: toNumber(readKeyVal(row, "blueprintID")),
    blueprintTypeID: toNumber(readKeyVal(row, "blueprintTypeID")),
    productTypeID: toNumber(readKeyVal(row, "productTypeID")),
    facilityID: toNumber(readKeyVal(row, "facilityID")),
    solarSystemID: toNumber(readKeyVal(row, "solarSystemID")),
    runs: toNumber(readKeyVal(row, "runs")),
    successfulRuns: toNumber(readKeyVal(row, "successfulRuns")),
    cost: toNumber(readKeyVal(row, "cost")),
    startDate: unwrapLong(readKeyVal(row, "startDate")),
    endDate: unwrapLong(readKeyVal(row, "endDate")),
    timeSeconds: toNumber(readKeyVal(row, "timeInSeconds")),
  };
}

/** Decode industryManager.GetJobCounts (activityID -> slots in use). */
export function decodeSlotUsage(result: JsonValue): IndustrySlotUsage {
  const usage: Record<string, number> = {};
  for (const entry of dictEntries(result)) {
    const activity = activityOfID(toNumber(entry[0]));
    if (activity) {
      usage[activity] = toNumber(entry[1]);
    }
  }
  return usage as IndustrySlotUsage;
}

// --- Facilities ------------------------------------------------------------

/** Decode facilityManager.GetFacilities. */
export function decodeFacilities(result: JsonValue): readonly IndustryFacilityRow[] {
  const facilities: IndustryFacilityRow[] = [];
  for (const row of listItems(result)) {
    const facilityID = toNumber(readKeyVal(row, "facilityID"));
    if (facilityID <= 0) {
      continue;
    }
    const activities: IndustryActivity[] = [];
    const modifiers: Partial<Record<IndustryActivity, IndustryFacilityModifiers>> = {};
    for (const entry of dictEntries(readKeyVal(row, "activities"))) {
      const activity = activityOfID(toNumber(entry[0]));
      if (activity && !activities.includes(activity)) {
        activities.push(activity);
        // A tuple of modifier lists: [time, material, cost, ...].
        const lists = tupleItems(entry[1]);
        const time = decodeFacilityModifiers(lists[0]);
        const material = decodeFacilityModifiers(lists[1]);
        if (time.length > 0 || material.length > 0) {
          modifiers[activity] = { time, material };
        }
      }
    }
    facilities.push({
      facilityID,
      solarSystemID: toNumber(readKeyVal(row, "solarSystemID")),
      typeID: toNumber(readKeyVal(row, "typeID")),
      ownerID: toNumber(readKeyVal(row, "ownerID")),
      // A facility whose `online` flag is absent counts as online: the server
      // only ever sets it false deliberately.
      online: readKeyVal(row, "online") !== false,
      tax: toNumberOrNull(readKeyVal(row, "tax")),
      activities: activities.sort(
        (left, right) => ACTIVITY_ORDER.indexOf(left) - ACTIVITY_ORDER.indexOf(right),
      ),
      modifiers,
    });
  }
  return facilities;
}

/** A tuple's or list's items, or a plain array as it is. */
function tupleItems(value: JsonValue | undefined): readonly JsonValue[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "object" && value !== null && Array.isArray((value as { items?: unknown }).items)) {
    return (value as { items: JsonValue[] }).items;
  }
  return [];
}

/** [value, categoryID, groupID, typeID, reference] entries; null or 0 ids mean "any". */
function decodeFacilityModifiers(value: JsonValue | undefined): IndustryFacilityModifier[] {
  const out: IndustryFacilityModifier[] = [];
  for (const raw of tupleItems(value)) {
    const entry = tupleItems(raw);
    const factor = toNumberOrNull(entry[0]);
    if (factor === null) continue;
    const id = (field: JsonValue | undefined): number | null => {
      const number = toNumberOrNull(field);
      return number !== null && number > 0 ? Math.trunc(number) : null;
    };
    out.push({ value: factor, categoryID: id(entry[1]), groupID: id(entry[2]), typeID: id(entry[3]) });
  }
  return out;
}

/**
 * Decode facilityManager.GetFacilityLocations — the input/output hangar CHOICES
 * for an install.
 *
 * ⚠ SHAPE TRAP, pinned by the gateway suite. These arrive as `objectex1`
 * wrappers whose FIELDS live in `header[2]` as {type:"dict", entries:[...]}.
 * The top-level `dict` array is EMPTY and `header[1]` is the (empty) args list.
 * A decoder that reads `value.dict` finds nothing and silently leaves the
 * player with nowhere to draw materials from.
 */
export interface IndustryLocationChoice {
  readonly itemID: number;
  readonly typeID: number;
  readonly ownerID: number;
  readonly flagID: number;
  readonly solarSystemID: number;
  readonly canView: boolean;
  readonly canTake: boolean;
}

export function decodeFacilityLocations(result: JsonValue): readonly IndustryLocationChoice[] {
  const choices: IndustryLocationChoice[] = [];
  for (const item of listItems(result)) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const wrapper = item as { type?: unknown; header?: unknown };
    if (wrapper.type !== "objectex1" || !Array.isArray(wrapper.header)) {
      continue;
    }
    const header = wrapper.header as readonly JsonValue[];
    const stateDict = header[2];
    const fields: Record<string, JsonValue> = {};
    for (const entry of dictEntries(stateDict)) {
      if (typeof entry[0] === "string") {
        fields[entry[0]] = entry[1] ?? null;
      }
    }
    const itemID = toNumber(fields.itemID);
    if (itemID <= 0) {
      continue;
    }
    choices.push({
      itemID,
      typeID: toNumber(fields.typeID),
      ownerID: toNumber(fields.ownerID),
      flagID: toNumber(fields.flagID),
      solarSystemID: toNumber(fields.solarSystemID),
      canView: fields.canView !== false,
      canTake: fields.canTake !== false,
    });
  }
  return choices;
}

// --- Static definitions ----------------------------------------------------

/** The static-data activity keys, mapped to the activity names used here. */
const RECIPE_KEY_BY_ACTIVITY: Readonly<Record<IndustryActivity, string>> = {
  manufacturing: "manufacturing",
  research_time: "research_time",
  research_material: "research_material",
  copying: "copying",
  invention: "invention",
  reaction: "reaction",
};

function decodeMaterialList(value: unknown): readonly IndustryMaterial[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const materials: IndustryMaterial[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const row = entry as { typeID?: unknown; quantity?: unknown };
    const typeID = Number(row.typeID) || 0;
    const quantity = Number(row.quantity) || 0;
    if (typeID > 0 && quantity > 0) {
      materials.push({ typeID, quantity });
    }
  }
  return materials;
}

/**
 * Decode one /api/industry/blueprints definition into the recipes the panel
 * uses. Only activities the blueprint actually HAS become recipes, which is
 * what the install form offers — the server would refuse any other one
 * (INCOMPATIBLE_ACTIVITY), so offering it would only mislead.
 */
export function decodeDefinition(raw: unknown): IndustryDefinition | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const blueprintTypeID = Number(row.blueprintTypeID) || 0;
  if (blueprintTypeID <= 0) {
    return null;
  }
  const activities =
    typeof row.activities === "object" && row.activities !== null
      ? (row.activities as Record<string, unknown>)
      : {};
  const recipes: IndustryRecipe[] = [];
  for (const activity of ACTIVITY_ORDER) {
    const entry = activities[RECIPE_KEY_BY_ACTIVITY[activity]];
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const activityRow = entry as { materials?: unknown; products?: unknown; time?: unknown };
    recipes.push({
      activity,
      materials: decodeMaterialList(activityRow.materials),
      products: decodeMaterialList(activityRow.products),
      timeSeconds: Number(activityRow.time) || 0,
    });
  }
  const productTypeID = Number(row.productTypeID) || 0;
  return {
    blueprintTypeID,
    blueprintName: typeof row.blueprintName === "string" ? row.blueprintName : null,
    productTypeID: productTypeID > 0 ? productTypeID : null,
    productName: typeof row.productName === "string" ? row.productName : null,
    maxProductionLimit: Number(row.maxProductionLimit) || null,
    recipes,
  };
}

/** The recipe for one activity of a definition, or null when it has none. */
export function recipeFor(
  definition: IndustryDefinition | null | undefined,
  activity: IndustryActivity,
): IndustryRecipe | null {
  if (!definition) {
    return null;
  }
  return definition.recipes.find((recipe) => recipe.activity === activity) ?? null;
}

/**
 * What ONE install of `runs` runs would consume, mirroring the server's own
 * arithmetic: base quantity x runs x (1 - materialEfficiency/100), rounded up,
 * never below one unit per run.
 *
 * ⚠ MATERIAL EFFICIENCY APPLIES TO MANUFACTURING ONLY. The server sets the
 * blueprint modifier to 1.0 for every other activity, so a copy job consumes
 * its full listed materials no matter how well researched the blueprint is.
 * Applying the discount everywhere would under-quote the player.
 *
 * A COPY JOB'S MATERIALS ARE FOR EVERY RUN OF EVERY COPY: `licensedRuns` is
 * the runs each copy is licensed for, and counts for a copy job alone.
 *
 * AN INVENTION'S DECRYPTOR IS ONE OF ITS MATERIALS, one a run: `decryptorTypeID`,
 * which counts for an invention alone, and is listed last.
 *
 * ⚠ THIS IS A PREVIEW, NOT A PREDICTION. The server recomputes materials from
 * the same static definition PLUS facility rig/structure bonuses this cannot
 * see, so its final figure can be lower. The panel labels this "about", and
 * the authoritative numbers are always the ones the install response and the
 * re-read return. Nothing here is ever used to decide whether an install may
 * proceed — only to tell the player roughly what they are about to spend.
 */
export function previewMaterials(
  recipe: IndustryRecipe | null,
  runs: number,
  materialEfficiency: number,
  licensedRuns = 1,
  decryptorTypeID = 0,
): readonly IndustryMaterial[] {
  if (!recipe || runs <= 0) {
    return [];
  }
  const materialRuns = recipe.activity === "copying" ? runs * Math.max(1, licensedRuns) : runs;
  const efficiency =
    recipe.activity === "manufacturing"
      ? Math.max(0, Math.min(100, materialEfficiency)) / 100
      : 0;
  const listed = recipe.materials.map((material) => ({
    typeID: material.typeID,
    quantity: Math.max(
      runs,
      Math.ceil(material.quantity * materialRuns * (1 - efficiency)),
    ),
  }));
  return recipe.activity === "invention" && decryptorTypeID > 0 ? [...listed, { typeID: decryptorTypeID, quantity: runs }] : listed;
}

/**
 * Base seconds for `runs` runs. The blueprint's time efficiency is in a manufacturing job's time alone, and a
 * copy job's time is by the runs each copy is licensed for (`licensedRuns`) too. A research's is by the level each
 * run starts from: `researchLevel` is the level the blueprint is at, and each run starts a level higher.
 */
export function previewTimeSeconds(
  recipe: IndustryRecipe | null,
  runs: number,
  timeEfficiency: number,
  licensedRuns = 1,
  researchLevel = 0,
): number {
  if (!recipe || runs <= 0) {
    return 0;
  }
  if (RESEARCH_OF[recipe.activity]) {
    let seconds = 0;
    for (let run = 0; run < runs; run += 1) {
      seconds += recipe.timeSeconds * RESEARCH_TIMES[Math.min(Math.max(0, researchLevel) + run, RESEARCH_TIMES.length - 1)]!;
    }
    // (Rounded, as the game's own client rounds a job's time: the levels' shares are no whole numbers.)
    return Math.round(seconds);
  }
  const efficiency = recipe.activity === "manufacturing" ? Math.max(0, Math.min(100, timeEfficiency)) / 100 : 0;
  const eachRun = recipe.activity === "copying" ? Math.max(1, licensedRuns) : 1;
  return Math.ceil(recipe.timeSeconds * eachRun * runs * (1 - efficiency));
}

/**
 * What a job costs to start, as the game's own client adds it up before it sends the job: the job's cost, the
 * facility's tax, the SCC's surcharge and, in a safe system, a security tax. Whole ISK each, and their total.
 */
export interface IndustryJobFee {
  readonly cost: number;
  readonly tax: number;
  readonly sccSurcharge: number;
  readonly securityTax: number;
  readonly total: number;
}

/**
 * A job's materials out of the preview's answer: each type to a whole quantity above nought, as the game's own
 * client reckons what the job will use. Null for anything else: none were reckoned.
 */
export function decodeJobMaterials(value: JsonValue | undefined): Readonly<Record<string, number>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const materials: Record<string, number> = {};
  for (const [typeID, quantity] of Object.entries(value)) {
    if (!/^[1-9][0-9]*$/.test(typeID) || typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity <= 0) {
      return null;
    }
    materials[typeID] = quantity;
  }
  return materials;
}

/**
 * What the window says a job will use: the preview's reckoning, where it made one that has every material the
 * page lists and no other, and is then exact; the page's own estimate otherwise, whole.
 */
export function materialsToUse(
  estimate: readonly IndustryMaterial[],
  reckoned: Readonly<Record<string, number>> | null,
): { readonly materials: readonly IndustryMaterial[]; readonly exact: boolean } {
  if (reckoned === null || Object.keys(reckoned).length !== estimate.length) {
    return { materials: estimate, exact: false };
  }
  const materials: IndustryMaterial[] = [];
  for (const material of estimate) {
    const quantity = reckoned[String(material.typeID)];
    if (quantity === undefined) {
      return { materials: estimate, exact: false };
    }
    materials.push({ typeID: material.typeID, quantity });
  }
  return { materials, exact: true };
}

const FEE_PARTS = ["cost", "tax", "sccSurcharge", "securityTax"] as const;

/** A fee out of the preview's answer: five whole amounts, the last the sum of the rest. Null for anything else. */
export function decodeJobFee(value: JsonValue | undefined): IndustryJobFee | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const said = value as Record<string, JsonValue>;
  const amount = (name: string): number | null => {
    const each = said[name];
    return typeof each === "number" && Number.isSafeInteger(each) && each >= 0 ? each : null;
  };
  const cost = amount("cost");
  const tax = amount("tax");
  const sccSurcharge = amount("sccSurcharge");
  const securityTax = amount("securityTax");
  const total = amount("total");
  if (cost === null || tax === null || sccSurcharge === null || securityTax === null || total === null) {
    return null;
  }
  return cost + tax + sccSurcharge + securityTax === total ? { cost, tax, sccSurcharge, securityTax, total } : null;
}

const FEE_WORDS: Readonly<Record<(typeof FEE_PARTS)[number], string>> = {
  cost: "the job itself",
  tax: "the facility's tax",
  sccSurcharge: "the SCC surcharge",
  securityTax: "the security tax",
};

/** The parts of a fee that are not nought, each with the words for it, in the order the game's client lists them. */
export function jobFeeParts(fee: IndustryJobFee): readonly { readonly what: string; readonly amount: number }[] {
  return FEE_PARTS.filter((part) => fee[part] > 0).map((part) => ({ what: FEE_WORDS[part], amount: fee[part] }));
}

/**
 * A duration in plain words: "2 hours 5 minutes", "45 seconds". Never a raw
 * second count, and never a bare "0" — an unknown duration reads as "unknown".
 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return "less than a minute";
  }
  const seconds = Math.round(totalSeconds);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days} day${days === 1 ? "" : "s"}`);
  }
  if (hours > 0) {
    parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  }
  if (minutes > 0 && days === 0) {
    parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) {
    const remaining = seconds % 60;
    return `${remaining} second${remaining === 1 ? "" : "s"}`;
  }
  return parts.join(" ");
}

// --- Refusals ---------------------------------------------------------------

/**
 * Plain-language sentences for the industry error names the SERVER refuses
 * with.
 *
 * These are NOT invented causes. When an install is refused the server raises a
 * structured `IndustryValidationError` carrying its own named reasons, and the
 * gateway forwards them verbatim as
 * `"IndustryValidationError: MISSING_MATERIAL, ACCOUNT_FUNDS"`. Turning a name
 * the server chose into a sentence a player can read is presentation, the same
 * job STATUS_LABELS does — nothing here decides WHY something failed.
 *
 * A name with no entry here falls back to a generic sentence rather than
 * leaking the raw code, which is jargon (R9a).
 */
const REFUSAL_SENTENCES: Readonly<Record<string, string>> = {
  MISSING_MATERIAL: "You do not have enough of the materials this job needs.",
  ACCOUNT_FUNDS: "You cannot afford the installation fee.",
  SLOTS_FULL: "You have no free job slots for that kind of work.",
  MISSING_BLUEPRINT: "That blueprint could not be found.",
  BLUEPRINT_INSTALLED: "That blueprint is already busy in another job.",
  BLUEPRINT_ACCESS: "You cannot use that blueprint.",
  INVALID_RUNS: "That number of runs is not allowed for this blueprint.",
  INVALID_LICENSED_RUNS: "That number of licensed runs is not allowed.",
  INVALID_ACTIVITY: "That kind of work cannot be done here.",
  INCOMPATIBLE_ACTIVITY: "That blueprint cannot be used for that kind of work.",
  MISSING_FACILITY: "That facility could not be found.",
  INVALID_BLUEPRINT_LOCATION: "That blueprint is not somewhere a job can start from. Put it in a hangar where industry is offered.",
  BLUEPRINT_WRONG_FACILITY: "That blueprint is in a different facility. A job starts where its blueprint is.",
  FACILITY_OFFLINE: "That facility is offline.",
  FACILITY_ACTIVITY: "That facility does not do that kind of work.",
  FACILITY_DENIED: "That facility will not take this job.",
  FACILITY_DISTANCE: "That facility is too far away.",
  FACILITY_TYPE: "That facility cannot handle this job.",
  MISSING_SKILL: "You do not have the skills this job needs.",
  MISSING_INPUT_LOCATION: "There is nowhere to take the materials from.",
  MISSING_OUTPUT_LOCATION: "There is nowhere to deliver the results to.",
  INPUT_ACCESS: "You cannot take materials from that hangar.",
  RESEARCH_LIMIT: "That blueprint cannot be researched any further.",
  RUN_LENGTH: "That job would run too long: all of its runs but the last must be done within thirty days.",
  STANDINGS_RESTRICTION: "Your standing is not good enough to work here.",
  INVALID_OWNER: "You cannot install a job for that owner.",
  INVALID_PRODUCT: "That blueprint does not make anything you can build here.",
  MISSING_ROLE: "You do not have the corporation role this needs.",
};

/**
 * Turn a bridge refusal into something a player can read.
 *
 * Three shapes arrive, and they are handled differently on purpose:
 *  - a STRUCTURED industry refusal (`IndustryValidationError: NAME, NAME`) —
 *    each name the server gave becomes its sentence;
 *  - a PROSE refusal (the handler's own words, e.g. "That industry job is not
 *    ready yet.") — passed through verbatim, because the server said it;
 *  - anything else — reported as a failure without a cause, never a guess.
 */
export function industryRefusalMessage(error: unknown): string {
  const raw =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error);
  if (!raw) {
    return "The server did not apply that change, and gave no reason.";
  }
  const structured = /^IndustryValidationError(?::\s*(.*))?$/.exec(raw);
  if (!structured) {
    // The handler's OWN sentence. Never reworded.
    return raw;
  }
  const names = (structured[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const sentences: string[] = [];
  for (const name of names) {
    const sentence = REFUSAL_SENTENCES[name];
    // An unmapped name is still a real reason the server gave — but printing
    // the code would be jargon, so it becomes the generic sentence instead.
    const text = sentence ?? "The server would not accept this job.";
    if (!sentences.includes(text)) {
      sentences.push(text);
    }
  }
  return sentences.length > 0
    ? sentences.join(" ")
    : "The server would not accept this job, and gave no reason.";
}

/**
 * Seconds until a retail FILETIME instant, from `nowMs`. FILETIME is 100 ns
 * ticks since 1601-01-01; the epoch offset is 11644473600 seconds.
 */
const FILETIME_TICKS_PER_SECOND = 10_000_000n;
const FILETIME_EPOCH_OFFSET_SECONDS = 11_644_473_600n;

export function secondsUntil(endDate: bigint | null, nowMs: number): number | null {
  if (endDate === null || endDate <= 0n) {
    return null;
  }
  const endUnixSeconds = endDate / FILETIME_TICKS_PER_SECOND - FILETIME_EPOCH_OFFSET_SECONDS;
  const nowSeconds = BigInt(Math.floor(nowMs / 1000));
  return Number(endUnixSeconds - nowSeconds);
}
/** MatchesItemID in 24.02 Industry: an exact instance ID, or the ordinary text filter. */
export function matchesIndustryFilter(query: string, itemID: number, fields: readonly string[]): boolean {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  if (itemID > 0 && /^\+?\d+$/.test(text) && Number(text) === itemID) return true;
  return fields.some(field => field.toLowerCase().includes(text));
}
