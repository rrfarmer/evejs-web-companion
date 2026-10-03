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
): readonly IndustryMaterial[] {
  if (!recipe || runs <= 0) {
    return [];
  }
  const efficiency =
    recipe.activity === "manufacturing"
      ? Math.max(0, Math.min(100, materialEfficiency)) / 100
      : 0;
  return recipe.materials.map((material) => ({
    typeID: material.typeID,
    quantity: Math.max(
      runs,
      Math.ceil(material.quantity * runs * (1 - efficiency)),
    ),
  }));
}

/** Base seconds for `runs` runs, with the blueprint's time efficiency applied. */
export function previewTimeSeconds(
  recipe: IndustryRecipe | null,
  runs: number,
  timeEfficiency: number,
): number {
  if (!recipe || runs <= 0) {
    return 0;
  }
  const efficiency = Math.max(0, Math.min(100, timeEfficiency)) / 100;
  return Math.ceil(recipe.timeSeconds * runs * (1 - efficiency));
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
