// SAVED PI PLANS — the planner's intent, kept on the server (src/piPlanStore.js,
// table pi_plans in the companion's own data/companion.sqlite) so that it
// outlives this browser and so that automation can read it later.
//
// ⚠ A PLAN IS WHAT YOU ASKED FOR, NOT WHAT THE PLANNER SAID. A commodity, how
// many, a note, active or done. Held stock, gaps and verdicts are re-derived
// from live stock every time the plan is shown (bridge/piPlanner.ts), so a plan
// reopened a week later is never a week stale.
//
// ⚠ A SIGN-IN, NEVER A SELECT — the colony read's rule (app/piRosterRead.ts).
// The PI window belongs to no pilot and has no token, so each call signs one
// of the hangar's accounts in on a throwaway token, asks, and signs it out.
// Plans are global on the server, so it does not matter WHICH account answers;
// the first one that signs in is used.
//
// ⚠ DECODED ON THE WAY IN. A row that fails the shape check is dropped here,
// the one place the server's answer is trusted into a type.

import { createPiPlan as apiCreatePiPlan, deletePiPlan as apiDeletePiPlan, listPiPlans as apiListPiPlans, updatePiPlan as apiUpdatePiPlan, type PiPlanFields } from "./piApi.ts";
import { login as apiLogin, logout as apiLogout } from "../../../web/src/plugin-api/index.ts";
import type { JsonValue } from "../../../web/src/plugin-api/index.ts";

export type { PiPlanFields };

export type PiPlanStatus = "active" | "done";

export interface SavedPiPlan {
  readonly planID: string;
  readonly typeID: number;
  readonly quantity: number;
  readonly note: string;
  readonly status: PiPlanStatus;
  readonly rev: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** One row from the server, or null when it is not a plan. */
export function decodePiPlan(value: JsonValue | undefined): SavedPiPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, JsonValue>;
  if (typeof o.planID !== "string" || o.planID.length === 0) return null;
  if (!positiveInteger(o.typeID) || !positiveInteger(o.quantity) || !positiveInteger(o.rev)) return null;
  if (o.status !== "active" && o.status !== "done") return null;
  return {
    planID: o.planID,
    typeID: o.typeID,
    quantity: o.quantity,
    note: typeof o.note === "string" ? o.note : "",
    status: o.status,
    rev: o.rev,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : "",
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : "",
  };
}

/** Every row that decodes, in the server's order. */
export function decodePiPlans(value: JsonValue | undefined): SavedPiPlan[] {
  if (!Array.isArray(value)) return [];
  return value.map(decodePiPlan).filter((plan): plan is SavedPiPlan => plan !== null);
}

/** Put a changed plan in place of the one with its id, or first when new. */
export function withPlan(plans: readonly SavedPiPlan[], plan: SavedPiPlan): SavedPiPlan[] {
  const index = plans.findIndex((entry) => entry.planID === plan.planID);
  if (index < 0) return [plan, ...plans];
  const next = [...plans];
  next[index] = plan;
  return next;
}

export function withoutPlan(plans: readonly SavedPiPlan[], planID: string): SavedPiPlan[] {
  return plans.filter((entry) => entry.planID !== planID);
}

// --- talking to the server ----------------------------------------------------

/** What the calls need from the outside world; tests supply their own. */
export interface PiPlanDeps {
  /** A throwaway session token for this account. Throws when refused. */
  signIn(accountName: string): Promise<string>;
  signOut(token: string): Promise<void>;
  list(token: string): Promise<JsonValue>;
  create(fields: PiPlanFields, token: string): Promise<JsonValue>;
  update(planID: string, fields: PiPlanFields, baseRev: number, token: string): Promise<JsonValue>;
  remove(planID: string, token: string): Promise<void>;
}

export const DEFAULT_PI_PLAN_DEPS: PiPlanDeps = {
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
  list: (token) => apiListPiPlans({ token, priority: "user" }),
  create: (fields, token) => apiCreatePiPlan(fields, { token, priority: "user" }),
  update: (planID, fields, baseRev, token) => apiUpdatePiPlan(planID, fields, baseRev, { token, priority: "user" }),
  remove: (planID, token) => apiDeletePiPlan(planID, { token, priority: "user" }),
};

/** Said when no account in the hangar could sign in to ask. */
export const NO_ACCOUNT_WORDS = "Saved plans need an account in the hangar to read them with.";

/**
 * Run `ask` signed in as the first of `accounts` that signs in, and sign out
 * after. Throws `NO_ACCOUNT_WORDS` when none does; a refusal from `ask` itself
 * is thrown as it came, carrying the server's own sentence.
 */
export async function signedIn<T>(
  accounts: readonly string[],
  deps: Pick<PiPlanDeps, "signIn" | "signOut">,
  ask: (token: string) => Promise<T>,
): Promise<T> {
  for (const accountName of new Set(accounts)) {
    let token: string;
    try {
      token = await deps.signIn(accountName);
    } catch {
      continue;
    }
    try {
      return await ask(token);
    } finally {
      await deps.signOut(token).catch(() => {});
    }
  }
  throw new Error(NO_ACCOUNT_WORDS);
}

function decodedOrThrow(value: JsonValue): SavedPiPlan {
  const plan = decodePiPlan(value);
  if (plan === null) throw new Error("The server answered with something that is not a plan.");
  return plan;
}

export async function loadPiPlans(accounts: readonly string[], deps = DEFAULT_PI_PLAN_DEPS): Promise<SavedPiPlan[]> {
  return decodePiPlans(await signedIn(accounts, deps, (token) => deps.list(token)));
}

export async function createPiPlan(
  accounts: readonly string[],
  fields: PiPlanFields,
  deps = DEFAULT_PI_PLAN_DEPS,
): Promise<SavedPiPlan> {
  return decodedOrThrow(await signedIn(accounts, deps, (token) => deps.create(fields, token)));
}

export async function updatePiPlan(
  accounts: readonly string[],
  plan: SavedPiPlan,
  fields: PiPlanFields,
  deps = DEFAULT_PI_PLAN_DEPS,
): Promise<SavedPiPlan> {
  return decodedOrThrow(
    await signedIn(accounts, deps, (token) => deps.update(plan.planID, fields, plan.rev, token)),
  );
}

export async function deletePiPlan(
  accounts: readonly string[],
  planID: string,
  deps = DEFAULT_PI_PLAN_DEPS,
): Promise<void> {
  await signedIn(accounts, deps, (token) => deps.remove(planID, token));
}
