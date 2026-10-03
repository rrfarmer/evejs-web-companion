import type { SupplyResult } from "../bridge/provisioning.ts";

export interface MiningPreparationFitting { readonly fittingID?: number; readonly providerCharacterID?: number }
export interface MiningPreparationSupply {
  readonly typeID: number; readonly target: number; readonly mode: "CARRIED_SPARES" | "TOTAL_ABOARD";
  readonly eligibleFlags: readonly (5 | 133 | 143)[]; readonly required: boolean;
}
export interface MiningPreparationConfig extends MiningPreparationFitting {
  readonly source: { readonly kind: "hangar" } | { readonly kind: "corp"; readonly corporationID: number; readonly division: number };
  readonly suppliesRequired: boolean;
  readonly supplies?: readonly MiningPreparationSupply[];
}
export type MiningPreparationState = "PENDING" | "PREPARING" | "VERIFIED" | "DEGRADED" | "BLOCKED" | "RECOVERY_REQUIRED";
export interface MiningMemberPreparation {
  readonly characterID: number; readonly role: string; readonly state: MiningPreparationState;
  readonly equipment: string; readonly supplies: string;
  readonly targets: readonly (SupplyResult & { readonly required?: boolean })[];
  readonly reason: string | null; readonly sourceLabel: string; readonly fittingName: string | null;
  readonly observedAt?: string | number | null;
}
export interface MiningPreparationProjection {
  readonly state: MiningPreparationState | "READY";
  readonly members?: readonly MiningMemberPreparation[];
  readonly reason?: string | null;
}
export interface MiningPreparationOptions {
  readonly definitions: { readonly status: string; readonly corporationID: number | null; readonly providerCharacterID: number;
    readonly contracts: readonly { readonly name: string; readonly shipTypeID: number; readonly definition: { readonly fittingID: number } }[] };
  readonly pilot: { readonly characterID: number; readonly name: string; readonly corporationID?: number | null };
  readonly candidateSource: { readonly kind: string; readonly quality?: string; readonly query?: string; readonly take?: string };
}

export interface MiningPreparationDraft {
  sourceKind: "hangar" | "corp"; corporationID: number; division: number;
  providerCharacterID: number; fittingID: number; suppliesRequired: boolean;
  supplies: { typeID: number; target: number; mode: MiningPreparationSupply["mode"]; eligibleFlags: (5 | 133 | 143)[]; required: boolean }[];
}
export function miningPreparationDraft(config?: MiningPreparationConfig): MiningPreparationDraft {
  return { sourceKind: config?.source.kind ?? "hangar", corporationID: config?.source.kind === "corp" ? config.source.corporationID : 0,
    division: config?.source.kind === "corp" ? config.source.division : 1,
    providerCharacterID: config?.providerCharacterID ?? 0, fittingID: config?.fittingID ?? 0,
    suppliesRequired: config?.suppliesRequired ?? false,
    supplies: (config?.supplies ?? []).map(row => ({ ...row, eligibleFlags: [...row.eligibleFlags] })) };
}
export function miningPreparationConfig(draft: MiningPreparationDraft): MiningPreparationConfig {
  if (draft.sourceKind === "corp" && (!Number.isSafeInteger(draft.corporationID) || draft.corporationID <= 0 ||
      !Number.isSafeInteger(draft.division) || draft.division < 1 || draft.division > 7)) throw new Error("Choose an exact supply corporation and division 1–7.");
  for (const row of draft.supplies) if (!Number.isSafeInteger(row.typeID) || row.typeID <= 0 ||
      !Number.isSafeInteger(row.target) || row.target <= 0 || !row.eligibleFlags.length ||
      row.eligibleFlags.some(flag => ![5, 133, 143].includes(flag))) throw new Error("Every extra supply needs a valid type, positive target and supported bay.");
  return { source: draft.sourceKind === "corp" ? { kind: "corp", corporationID: draft.corporationID, division: draft.division } : { kind: "hangar" },
    ...(draft.providerCharacterID ? { providerCharacterID: draft.providerCharacterID } : {}),
    ...(draft.fittingID ? { fittingID: draft.fittingID } : {}), suppliesRequired: draft.suppliesRequired,
    ...(draft.supplies.length ? { supplies: draft.supplies.map(row => ({ ...row, eligibleFlags: [...row.eligibleFlags] })) } : {}) };
}
export function preparationStateLabel(state?: string): string {
  return state === "RECOVERY_REQUIRED" ? "RECOVERY REQUIRED" : state ?? "UNKNOWN";
}
