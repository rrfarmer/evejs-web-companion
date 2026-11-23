// WC74 web/src/app/miningPreparation.ts @ 213da333; imports adapted for UOC plugin.
import type { SupplyResult } from "./preparationTypes.ts";

export interface MiningPreparationFitting { readonly fittingID?: number; readonly providerCharacterID?: number }
export interface MiningPreparationSupply {
  readonly typeID: number; readonly target: number; readonly mode: "CARRIED_SPARES" | "TOTAL_ABOARD";
  readonly eligibleFlags: readonly (5 | 133 | 143)[]; readonly required: boolean;
}
export type MiningSupplySource = { readonly kind: "hangar" } |
  { readonly kind: "corp"; readonly division: number; readonly corporationID?: number };
export function miningSupplySourceLabel(source?: MiningSupplySource): string {
  return source?.kind === "corp" ? "Corporation Division " + source.division : "Personal local hangar";
}
export interface MiningPreparationConfig extends MiningPreparationFitting {
  readonly source: MiningSupplySource;
  readonly suppliesRequired: boolean;
  readonly replenishSupplies?: boolean;
  readonly supplies?: readonly MiningPreparationSupply[];
}
export type MiningPreparationState = "PENDING" | "PREPARING" | "VERIFIED" | "DEGRADED" | "BLOCKED" | "RECOVERY_REQUIRED";
export interface MiningMemberPreparation {
  readonly characterID: number; readonly role: string; readonly state: MiningPreparationState;
  readonly equipment: string; readonly supplies: string;
  readonly targets: readonly (SupplyResult & { readonly required?: boolean })[];
  readonly reason: string | null; readonly sourceLabel: string; readonly fittingName: string | null;
  readonly currentHull?:string|null; readonly blockerCode?:string|null;
  readonly observedAt?: string | number | null;
}
export interface MiningPreparationProjection {
  readonly historical?: boolean;
  readonly state: MiningPreparationState | "READY";
  readonly members?: readonly MiningMemberPreparation[];
  readonly reason?: string | null;
}
export interface MiningPreparationOptions {
  readonly definitions: { readonly status: string; readonly corporationID: number | null; readonly providerCharacterID: number;
    readonly contracts: readonly { readonly name: string; readonly shipTypeID: number; readonly definition: { readonly fittingID: number } }[] };
  readonly pilot: { readonly characterID: number; readonly name: string; readonly corporationID?: number | null; readonly corporationName?: string | null };
  readonly candidateSource: { readonly kind: string; readonly quality?: string; readonly query?: string; readonly take?: string };
}

export interface MiningPreparationDraft {
  sourceKind: "hangar" | "corp"; corporationID: number; division: number;
  providerCharacterID: number; fittingID: number; suppliesRequired: boolean; replenishSupplies: boolean;
  supplies: { typeID: number; target: number; mode: MiningPreparationSupply["mode"]; eligibleFlags: (5 | 133 | 143)[]; required: boolean }[];
}
/** Explicit supply intent, not an effective Core startup quote. */
export function miningCommandFuelTarget():MiningPreparationDraft["supplies"][number] {
  return {typeID:16272,target:0,mode:"TOTAL_ABOARD",eligibleFlags:[5,133],required:false};
}
export function miningPreparationDraft(config?: MiningPreparationConfig): MiningPreparationDraft {
  return { sourceKind: config?.source.kind ?? "hangar", corporationID: config?.source.kind === "corp" ? config.source.corporationID ?? 0 : 0,
    division: config?.source.kind === "corp" ? config.source.division : 1,
    providerCharacterID: config?.providerCharacterID ?? 0, fittingID: config?.fittingID ?? 0,
    suppliesRequired: false, replenishSupplies: config?.replenishSupplies ?? false,
    supplies: (config?.supplies ?? []).map(row => ({ ...row, eligibleFlags: [...row.eligibleFlags] })) };
}
export function miningPreparationConfig(draft: MiningPreparationDraft): MiningPreparationConfig {
  if (draft.sourceKind === "corp" && (!Number.isSafeInteger(draft.division) || draft.division < 1 || draft.division > 7))
    throw new Error("Choose corporation division 1–7 for supplies.");
  if (draft.sourceKind === "corp" && draft.corporationID !== 0 && (!Number.isSafeInteger(draft.corporationID) || draft.corporationID < 1))
    throw new Error("The saved supply corporation identity is invalid.");
  for (const row of draft.supplies) if (!Number.isSafeInteger(row.typeID) || row.typeID <= 0 ||
      !Number.isSafeInteger(row.target) || row.target <= 0 || !row.eligibleFlags.length ||
      row.eligibleFlags.some(flag => ![5, 133, 143].includes(flag))) throw new Error("Every extra supply needs a valid type, positive target and supported bay.");
  return { source: draft.sourceKind === "corp" ? { kind: "corp", division: draft.division,
    ...(draft.corporationID ? { corporationID: draft.corporationID } : {}) } : { kind: "hangar" },
    ...(draft.providerCharacterID ? { providerCharacterID: draft.providerCharacterID } : {}),
    ...(draft.fittingID ? { fittingID: draft.fittingID } : {}), suppliesRequired: false, replenishSupplies: draft.replenishSupplies,
    ...(draft.supplies.length ? { supplies: draft.supplies.map(row => ({ ...row, eligibleFlags: [...row.eligibleFlags] })) } : {}) };
}
export function preparationStateLabel(state?: string): string {
  return state === "RECOVERY_REQUIRED" ? "RECOVERY REQUIRED" : state ?? "UNKNOWN";
}
