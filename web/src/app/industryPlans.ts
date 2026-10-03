// SAVED INDUSTRY PLANS (R109 slice 3) — the Industry Manager's intent, kept on
// the server (src/industryPlanStore.js, table industry_plans) so it outlives
// this browser. Shaped after app/piPlans.ts.
//
// ⚠ A PLAN IS WHAT YOU ASKED FOR, NOT WHAT THE RESOLVER SAID: a product, how
// many runs, a note, active or done, and the player's choices. Everything else
// is worked out again from live reads each time the plan is shown.
//
// ⚠ WHOSE TOKEN ASKS. The window belongs to no pilot. A pilot already online in
// this tab is asked through first, on its own session, which costs nothing.
// With nobody online it falls back to PI's way: sign one of the hangar's
// accounts in on a throwaway token, ask, sign it out. Plans and recipes are
// the same whoever asks, so it does not matter which one answers.
//
// ⚠ DECODED ON THE WAY IN. A row that fails the shape check is dropped here.

import {
  createIndustryPlan as apiCreate,
  deleteIndustryPlan as apiDelete,
  listIndustryPlans as apiList,
  login as apiLogin,
  logout as apiLogout,
  updateIndustryPlan as apiUpdate,
  type ApiOptions,
  type IndustryPlanChoices,
  type IndustryPlanFields,
} from "./api.ts";
import type { JsonValue } from "../bridge/wire.ts";
import type { BlueprintTerms, IndustryChoices } from "../bridge/industryChain.ts";
import {
  INVENTED_MATERIAL_EFFICIENCY,
  INVENTED_TIME_EFFICIENCY,
  type DecryptorTerms,
} from "../bridge/industryInvention.ts";

export type { IndustryPlanChoices, IndustryPlanFields };

export type IndustryPlanStatus = "active" | "done";

export interface SavedIndustryPlan {
  readonly planID: string;
  readonly productTypeID: number;
  readonly runs: number;
  readonly choices: IndustryPlanChoices;
  readonly note: string;
  readonly status: IndustryPlanStatus;
  readonly rev: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const NO_CHOICES: IndustryPlanChoices = Object.freeze({
  buy: Object.freeze([]) as readonly number[],
  jobs: Object.freeze({}),
  blueprints: Object.freeze({}),
  decryptors: Object.freeze({}),
});

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Choices from the server; anything out of shape is left out, not guessed. */
export function decodeChoices(value: unknown): IndustryPlanChoices {
  const o = record(value);
  if (o === null) return NO_CHOICES;
  const buy = Array.isArray(o.buy) ? [...new Set(o.buy.filter(positiveInteger))].sort((a, b) => a - b) : [];
  const jobs: Record<string, number> = {};
  for (const [key, count] of Object.entries(record(o.jobs) ?? {})) {
    if (positiveInteger(Number(key)) && integerIn(count, 2, 1000)) jobs[key] = count;
  }
  const blueprints: Record<string, { materialEfficiency: number; timeEfficiency: number }> = {};
  for (const [key, raw] of Object.entries(record(o.blueprints) ?? {})) {
    const terms = record(raw);
    if (
      positiveInteger(Number(key)) &&
      terms !== null &&
      integerIn(terms.materialEfficiency, 0, 10) &&
      integerIn(terms.timeEfficiency, 0, 20)
    ) {
      blueprints[key] = { materialEfficiency: terms.materialEfficiency, timeEfficiency: terms.timeEfficiency };
    }
  }
  const decryptors: Record<string, number> = {};
  for (const [key, decryptorTypeID] of Object.entries(record(o.decryptors) ?? {})) {
    if (positiveInteger(Number(key)) && positiveInteger(decryptorTypeID)) decryptors[key] = decryptorTypeID;
  }
  const facilities: { manufacturing?: number; reaction?: number } = {};
  const facilitiesIn = record(o.facilities) ?? {};
  for (const key of ["manufacturing", "reaction"] as const) {
    if (positiveInteger(facilitiesIn[key])) facilities[key] = facilitiesIn[key];
  }
  return Object.keys(facilities).length > 0 ? { buy, jobs, blueprints, decryptors, facilities } : { buy, jobs, blueprints, decryptors };
}

/** The same choices with where one activity's jobs are built set (null clears it). */
export function withFacility(
  choices: IndustryPlanChoices,
  activity: "manufacturing" | "reaction",
  facilityID: number | null,
): IndustryPlanChoices {
  const next: { manufacturing?: number; reaction?: number } = { ...(choices.facilities ?? {}) };
  if (facilityID === null) delete next[activity];
  else next[activity] = facilityID;
  const { facilities: _dropped, ...rest } = choices;
  return Object.keys(next).length > 0 ? { ...rest, facilities: next } : rest;
}

/** One row from the server, or null when it is not a plan. */
export function decodeIndustryPlan(value: JsonValue | undefined): SavedIndustryPlan | null {
  const o = record(value);
  if (o === null) return null;
  if (typeof o.planID !== "string" || o.planID.length === 0) return null;
  if (!positiveInteger(o.productTypeID) || !positiveInteger(o.runs) || !positiveInteger(o.rev)) return null;
  if (o.status !== "active" && o.status !== "done") return null;
  return {
    planID: o.planID,
    productTypeID: o.productTypeID,
    runs: o.runs,
    choices: decodeChoices(o.choices),
    note: typeof o.note === "string" ? o.note : "",
    status: o.status,
    rev: o.rev,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : "",
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : "",
  };
}

export function decodeIndustryPlans(value: JsonValue | undefined): SavedIndustryPlan[] {
  if (!Array.isArray(value)) return [];
  return value.map(decodeIndustryPlan).filter((plan): plan is SavedIndustryPlan => plan !== null);
}

/** Put a changed plan in place of the one with its id, or first when new. */
export function withIndustryPlan(plans: readonly SavedIndustryPlan[], plan: SavedIndustryPlan): SavedIndustryPlan[] {
  const index = plans.findIndex((entry) => entry.planID === plan.planID);
  if (index < 0) return [plan, ...plans];
  const next = [...plans];
  next[index] = plan;
  return next;
}

export function withoutIndustryPlan(plans: readonly SavedIndustryPlan[], planID: string): SavedIndustryPlan[] {
  return plans.filter((entry) => entry.planID !== planID);
}

/**
 * Stored choices as the resolver takes them. `owned` (live, best owned terms)
 * wins over a stored assumption: a blueprint somebody now holds is planned at
 * what it really is.
 */
export function resolverChoices(
  choices: IndustryPlanChoices,
  owned: ReadonlyMap<number, BlueprintTerms>,
  decryptors: ReadonlyMap<number, DecryptorTerms> = new Map(),
): IndustryChoices {
  const obtain = new Map<number, "build" | "buy">(choices.buy.map((typeID) => [typeID, "buy"]));
  const jobs = new Map<number, number>(Object.entries(choices.jobs).map(([key, count]) => [Number(key), count]));
  const blueprints = new Map<number, BlueprintTerms>();
  const inventionRuns = new Map<number, number>();
  for (const [key, terms] of Object.entries(choices.blueprints)) {
    blueprints.set(Number(key), { ...terms, owned: false });
  }
  // A chosen decryptor fixes what an invented copy comes out at: the server's
  // ME 2 / TE 4 plus the decryptor's, and its extra runs (inventionRunsFor).
  for (const [key, decryptorTypeID] of Object.entries(choices.decryptors ?? {})) {
    const decryptor = decryptors.get(decryptorTypeID);
    if (!decryptor) continue;
    blueprints.set(Number(key), {
      materialEfficiency: INVENTED_MATERIAL_EFFICIENCY + decryptor.materialEfficiency,
      timeEfficiency: INVENTED_TIME_EFFICIENCY + decryptor.timeEfficiency,
      owned: false,
    });
    inventionRuns.set(Number(key), decryptor.maxRuns);
  }
  for (const [blueprintTypeID, terms] of owned) {
    blueprints.set(blueprintTypeID, terms);
  }
  return { obtain, jobs, blueprints, inventionRunsBonus: inventionRuns };
}

/** The same choices with one T2 blueprint's decryptor set (null clears it). */
export function withDecryptor(
  choices: IndustryPlanChoices,
  blueprintTypeID: number,
  decryptorTypeID: number | null,
): IndustryPlanChoices {
  const next = { ...(choices.decryptors ?? {}) };
  if (decryptorTypeID === null) delete next[String(blueprintTypeID)];
  else next[String(blueprintTypeID)] = decryptorTypeID;
  return { ...choices, decryptors: next };
}

/** The same choices with one type's buy flag set or cleared. */
export function withBuying(choices: IndustryPlanChoices, typeID: number, buy: boolean): IndustryPlanChoices {
  const set = new Set(choices.buy);
  if (buy) set.add(typeID);
  else set.delete(typeID);
  return { ...choices, buy: [...set].sort((a, b) => a - b) };
}

/** The same choices with one type's job split set (1 clears it). */
export function withJobs(choices: IndustryPlanChoices, typeID: number, jobs: number): IndustryPlanChoices {
  const next = { ...choices.jobs };
  if (jobs > 1) next[String(typeID)] = Math.min(Math.trunc(jobs), 1000);
  else delete next[String(typeID)];
  return { ...choices, jobs: next };
}

/** The same choices with one unowned blueprint's assumed terms set. */
export function withAssumedTerms(
  choices: IndustryPlanChoices,
  blueprintTypeID: number,
  materialEfficiency: number,
  timeEfficiency: number,
): IndustryPlanChoices {
  return {
    ...choices,
    blueprints: {
      ...choices.blueprints,
      [String(blueprintTypeID)]: {
        materialEfficiency: Math.min(Math.max(Math.trunc(materialEfficiency), 0), 10),
        timeEfficiency: Math.min(Math.max(Math.trunc(timeEfficiency), 0), 20),
      },
    },
  };
}

// --- talking to the server ----------------------------------------------------

/** Who may be asked: online pilots' own sessions first, then hangar accounts. */
export interface IndustryAskers {
  readonly online: readonly ApiOptions[];
  readonly accounts: readonly string[];
}

/** What the calls need from the outside world; tests supply their own. */
export interface IndustryPlanDeps {
  /** A throwaway session token for this account. Throws when refused. */
  signIn(accountName: string): Promise<string>;
  signOut(token: string): Promise<void>;
}

export const DEFAULT_INDUSTRY_PLAN_DEPS: IndustryPlanDeps = {
  async signIn(accountName) {
    // Any password, as the hangar signs in; `token: null` keeps the tab's own
    // session untouched.
    const result = await apiLogin(accountName, "", { token: null });
    if (result.sessionToken === null) throw new Error("The server did not return a session token.");
    return result.sessionToken;
  },
  async signOut(token) {
    await apiLogout({ token });
  },
};

/** Said when nobody is online and no hangar account could sign in to ask. */
export const NO_ASKER_WORDS = "Saved plans need a pilot signed in here, or an account in the hangar.";

/**
 * Run `ask` as the first online pilot, or else signed in as the first hangar
 * account that signs in (and signed out after). A refusal from `ask` itself
 * is thrown as it came, carrying the server's own sentence.
 */
export async function askAsAnyone<T>(
  askers: IndustryAskers,
  ask: (options: ApiOptions) => Promise<T>,
  deps: IndustryPlanDeps = DEFAULT_INDUSTRY_PLAN_DEPS,
): Promise<T> {
  const first = askers.online[0];
  if (first) {
    return ask({ ...first, priority: "user" });
  }
  for (const accountName of new Set(askers.accounts)) {
    let token: string;
    try {
      token = await deps.signIn(accountName);
    } catch {
      continue;
    }
    try {
      return await ask({ token, priority: "user" });
    } finally {
      await deps.signOut(token).catch(() => {});
    }
  }
  throw new Error(NO_ASKER_WORDS);
}

function decodedOrThrow(value: JsonValue): SavedIndustryPlan {
  const plan = decodeIndustryPlan(value);
  if (plan === null) throw new Error("The server answered with something that is not a plan.");
  return plan;
}

export async function loadIndustryPlans(askers: IndustryAskers, deps = DEFAULT_INDUSTRY_PLAN_DEPS): Promise<SavedIndustryPlan[]> {
  return decodeIndustryPlans(await askAsAnyone(askers, (options) => apiList(options), deps));
}

export async function createIndustryPlan(
  askers: IndustryAskers,
  fields: IndustryPlanFields,
  deps = DEFAULT_INDUSTRY_PLAN_DEPS,
): Promise<SavedIndustryPlan> {
  return decodedOrThrow(await askAsAnyone(askers, (options) => apiCreate(fields, options), deps));
}

export async function updateIndustryPlan(
  askers: IndustryAskers,
  plan: SavedIndustryPlan,
  fields: IndustryPlanFields,
  deps = DEFAULT_INDUSTRY_PLAN_DEPS,
): Promise<SavedIndustryPlan> {
  return decodedOrThrow(await askAsAnyone(askers, (options) => apiUpdate(plan.planID, fields, plan.rev, options), deps));
}

export async function deleteIndustryPlan(
  askers: IndustryAskers,
  planID: string,
  deps = DEFAULT_INDUSTRY_PLAN_DEPS,
): Promise<void> {
  await askAsAnyone(askers, (options) => apiDelete(planID, options), deps);
}
