// The PI Manager's own routes, answered by its backend (backend.ts) in the
// plugin's own process: saved plans and saved expansion plans.

import { pluginGetJson, pluginPostJson, type ApiOptions, type JsonValue } from "../../../web/src/plugin-api/index.ts";

const PLUGIN = "pi-manager";

// ─── Saved PI plans (backend/piPlanStore.cjs) ─────────────────────────────────
// Rows from the plugin's own database. The answers are handed back RAW:
// piPlans.ts decodes them, so a stored row and a fresh one go through the
// same door.

/** The fields a plan may carry on create or update. */
export interface PiPlanFields {
  readonly typeID?: number;
  readonly quantity?: number;
  readonly note?: string;
  readonly status?: "active" | "done";
}

export async function listPiPlans(options: ApiOptions = {}): Promise<JsonValue> {
  return (await pluginGetJson(PLUGIN, "/plans", options)).plans ?? null;
}

export async function createPiPlan(fields: PiPlanFields, options: ApiOptions = {}): Promise<JsonValue> {
  return (await pluginPostJson(PLUGIN, "/plans", fields, options)).plan ?? null;
}

export async function updatePiPlan(
  planID: string,
  fields: PiPlanFields,
  baseRev: number,
  options: ApiOptions = {},
): Promise<JsonValue> {
  const data = await pluginPostJson(PLUGIN, `/plans/${encodeURIComponent(planID)}`, { ...fields, baseRev }, options);
  return data.plan ?? null;
}

export async function deletePiPlan(planID: string, options: ApiOptions = {}): Promise<void> {
  await pluginPostJson(PLUGIN, `/plans/${encodeURIComponent(planID)}/delete`, {}, options);
}

// ─── Saved PI expansion plans (backend/piExpansionStore.cjs) ─────────────────
// Handed back RAW: piExpansions.ts decodes them.

export interface PiExpansionFields {
  readonly settings?: {
    readonly homeSystemID: number;
    readonly maxJumps: number;
    readonly nullsecTolerance: number;
    readonly characterIDs: readonly number[];
  };
  readonly rows?: readonly {
    readonly characterID: number;
    readonly planetID: number;
    readonly resourceTypeID: number;
    readonly productTypeID: number;
  }[];
  readonly note?: string;
  readonly status?: "active" | "done";
}

export async function listPiExpansions(options: ApiOptions = {}): Promise<JsonValue> {
  return (await pluginGetJson(PLUGIN, "/expansions", options)).plans ?? null;
}

export async function createPiExpansion(fields: PiExpansionFields, options: ApiOptions = {}): Promise<JsonValue> {
  return (await pluginPostJson(PLUGIN, "/expansions", fields, options)).plan ?? null;
}

export async function updatePiExpansion(
  planID: string,
  fields: PiExpansionFields,
  baseRev: number,
  options: ApiOptions = {},
): Promise<JsonValue> {
  const data = await pluginPostJson(PLUGIN, `/expansions/${encodeURIComponent(planID)}`, { ...fields, baseRev }, options);
  return data.plan ?? null;
}

export async function deletePiExpansion(planID: string, options: ApiOptions = {}): Promise<void> {
  await pluginPostJson(PLUGIN, `/expansions/${encodeURIComponent(planID)}/delete`, {}, options);
}
