// SAVED PI EXPANSION PLANS -- where to look and the colonies the player
// accepted, kept on the server (src/piExpansionStore.js) beside the PI plans.
//
// ⚠ A PLAN IS WHAT YOU ACCEPTED, NOT WHAT IS BUILT. Settings and rows only.
// Whether each row stands built is re-derived from live colonies every time
// the plan is shown (bridge/piExpansion.ts rowState), so a plan reopened a
// week later is never a week stale.
//
// ⚠ A SIGN-IN, NEVER A SELECT: the PI plans' rule and their very helper
// (app/piPlans.ts signedIn).

import { createPiExpansion as apiCreate, deletePiExpansion as apiDelete, listPiExpansions as apiList, updatePiExpansion as apiUpdate, type PiExpansionFields } from "./piApi.ts";
import { DEFAULT_PI_PLAN_DEPS, signedIn, type PiPlanDeps } from "./piPlans.ts";
import type { JsonValue } from "../../../web/src/plugin-api/index.ts";

export type { PiExpansionFields };

export interface PiExpansionSettings {
  readonly homeSystemID: number;
  readonly maxJumps: number;
  readonly nullsecTolerance: number;
  readonly characterIDs: readonly number[];
}

export interface PiExpansionRowRef {
  readonly characterID: number;
  readonly planetID: number;
  readonly resourceTypeID: number;
  readonly productTypeID: number;
}

export interface SavedPiExpansion {
  readonly planID: string;
  readonly settings: PiExpansionSettings;
  readonly rows: readonly PiExpansionRowRef[];
  readonly note: string;
  readonly status: "active" | "done";
  readonly rev: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function decodeRow(value: JsonValue): PiExpansionRowRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, JsonValue>;
  return positiveInteger(o.characterID) && positiveInteger(o.planetID) && positiveInteger(o.resourceTypeID) && positiveInteger(o.productTypeID)
    ? { characterID: o.characterID, planetID: o.planetID, resourceTypeID: o.resourceTypeID, productTypeID: o.productTypeID }
    : null;
}

/** One plan from the server, or null when it is not one. */
export function decodePiExpansion(value: JsonValue | undefined): SavedPiExpansion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, JsonValue>;
  if (typeof o.planID !== "string" || o.planID.length === 0 || !positiveInteger(o.rev)) return null;
  if (o.status !== "active" && o.status !== "done") return null;
  const s = o.settings && typeof o.settings === "object" && !Array.isArray(o.settings) ? o.settings as Record<string, JsonValue> : {};
  // A plan whose settings never named a home is still shown, rows and all; it just cannot be re-proposed.
  const homeSystemID = positiveInteger(s.homeSystemID) ? s.homeSystemID : 0;
  return {
    planID: o.planID,
    settings: {
      homeSystemID,
      maxJumps: typeof s.maxJumps === "number" ? s.maxJumps : 0,
      nullsecTolerance: typeof s.nullsecTolerance === "number" ? s.nullsecTolerance : 0,
      characterIDs: Array.isArray(s.characterIDs) ? s.characterIDs.filter(positiveInteger) : [],
    },
    rows: Array.isArray(o.rows) ? o.rows.map(decodeRow).filter((row): row is PiExpansionRowRef => row !== null) : [],
    note: typeof o.note === "string" ? o.note : "",
    status: o.status,
    rev: o.rev,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : "",
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : "",
  };
}

export function decodePiExpansions(value: JsonValue | undefined): SavedPiExpansion[] {
  if (!Array.isArray(value)) return [];
  return value.map(decodePiExpansion).filter((plan): plan is SavedPiExpansion => plan !== null);
}

/** What the calls need from the outside world; tests supply their own. */
export interface PiExpansionDeps extends Pick<PiPlanDeps, "signIn" | "signOut"> {
  list(token: string): Promise<JsonValue>;
  create(fields: PiExpansionFields, token: string): Promise<JsonValue>;
  update(planID: string, fields: PiExpansionFields, baseRev: number, token: string): Promise<JsonValue>;
  remove(planID: string, token: string): Promise<void>;
}

export const DEFAULT_PI_EXPANSION_DEPS: PiExpansionDeps = {
  signIn: DEFAULT_PI_PLAN_DEPS.signIn,
  signOut: DEFAULT_PI_PLAN_DEPS.signOut,
  list: (token) => apiList({ token, priority: "user" }),
  create: (fields, token) => apiCreate(fields, { token, priority: "user" }),
  update: (planID, fields, baseRev, token) => apiUpdate(planID, fields, baseRev, { token, priority: "user" }),
  remove: (planID, token) => apiDelete(planID, { token, priority: "user" }),
};

function decodedOrThrow(value: JsonValue): SavedPiExpansion {
  const plan = decodePiExpansion(value);
  if (plan === null) throw new Error("The server answered with something that is not an expansion plan.");
  return plan;
}

export async function loadPiExpansions(accounts: readonly string[], deps = DEFAULT_PI_EXPANSION_DEPS): Promise<SavedPiExpansion[]> {
  return decodePiExpansions(await signedIn(accounts, deps, (token) => deps.list(token)));
}

export async function createPiExpansion(
  accounts: readonly string[],
  fields: PiExpansionFields,
  deps = DEFAULT_PI_EXPANSION_DEPS,
): Promise<SavedPiExpansion> {
  return decodedOrThrow(await signedIn(accounts, deps, (token) => deps.create(fields, token)));
}

export async function updatePiExpansion(
  accounts: readonly string[],
  plan: SavedPiExpansion,
  fields: PiExpansionFields,
  deps = DEFAULT_PI_EXPANSION_DEPS,
): Promise<SavedPiExpansion> {
  return decodedOrThrow(await signedIn(accounts, deps, (token) => deps.update(plan.planID, fields, plan.rev, token)));
}

export async function deletePiExpansion(
  accounts: readonly string[],
  planID: string,
  deps = DEFAULT_PI_EXPANSION_DEPS,
): Promise<void> {
  await signedIn(accounts, deps, (token) => deps.remove(planID, token));
}
