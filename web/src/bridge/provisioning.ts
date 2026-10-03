export interface ProvisioningInput {
  providerCharacterID: number;
  corporationID: number;
  fittingID: number;
  source: { kind: "hangar" } | { kind: "corp"; corporationID: number; division: number } | { kind: "container"; itemID: number };
}
export interface ProvisioningOptions {
  providers: readonly { characterID: number; corporationID: number; name: string }[];
  corporationID: number;
  providerCharacterID: number;
  definitionCorporationID: number | null;
  definitionStatus: string;
  fittings: readonly { fittingID: number; name: string; invalid: boolean }[];
  containers: readonly { itemID: number; name: string; location: string }[];
  pending: readonly { operationID: string; state: string }[];
}
export interface SupplyResult {
  typeID: number; name: string; target: number; mode: string; current: number | null; deficit: number | null;
  state: "FULL" | "LOW" | "MISSING" | "UNKNOWN";
}
export interface ProvisioningStatus {
  equipment: "VERIFIED" | "MODIFIED" | "UNKNOWN";
  supplies: "FULL" | "LOW" | "MISSING" | "UNKNOWN";
  targets: readonly SupplyResult[];
}
export interface ProvisioningReview {
  reviewID: string; reviewHash: string; expiresAt: number; canApply: boolean;
  contract: { name: string };
  status: ProvisioningStatus;
  matches: { state: "MATCH" | "AMBIGUOUS" | "MODIFIED" | "UNKNOWN"; alternatives: readonly { name: string }[] };
  source: { access: { query: boolean; take: boolean }; available: readonly { typeID: number; quantity: number }[] };
  pending: readonly { operationID: string; state: string }[];
}
export interface ReplenishmentResult { operationID: string; state: string; result: ProvisioningStatus | null }
