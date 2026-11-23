import type { DroneBayQualification } from "../../provisioning/resourceQualification.ts";
type SupplyState = "FULL" | "LOW" | "MISSING" | "UNKNOWN";
interface SupplyTarget {
  typeID: number;
  name: string;
  target: number;
  mode: string;
  current: number | null;
  deficit: number | null;
  state: SupplyState;
}
export interface ProvisioningStatus {
  equipment: "VERIFIED" | "MODIFIED" | "UNKNOWN";
  equipmentMatch?: "REQUIRED_WITH_RETAINED_RIGS";
  supplies: SupplyState;
  targets: readonly SupplyTarget[];
  charges?: readonly (Pick<SupplyTarget, "typeID" | "name" | "target" | "current" | "state"> & { flagID: number })[];
}
export interface Requirement { typeID: number; name?: string; kind: string; flagID: number; quantity: number; current?: number; missing?: number }
export interface EquipmentRow extends Requirement { itemID: number | null; loaded: boolean }
export interface Contract { name: string; hullName?: string; shipTypeID: number; hullGroupID?: number | null; hullGroupName?: string | null; equipmentFingerprint: string; supplyPolicyFingerprint: string; definitionFingerprint: string;
  definition: { accountID: number; characterID: number; corporationID: number; fittingID: number; savedDate: string; fullFingerprint: string } }
export interface Match { state: string; alternatives: readonly { name: string; definition: Contract["definition"] }[] }
export interface Pilot { serviceAccess?:string|null;characterID: number; name: string; corporationID: number | null; corporationName?: string | null; locationID: number | null; stationID: number | null;
  dockState: string; shipID: number | null; shipTypeID: number | null; shipName: string | null; hullName: string | null;
  locationName?: string | null; quality: string; reasons: readonly string[]; control: { state: string; owner: string; online: boolean | null };
  status: ProvisioningStatus; matches: Match }
export interface Evidence { boundary: string; digest: string; startedAt: number; completedAt: number; stable: boolean; unsupported: readonly string[] }
export interface Roster { quality: string; completeRoster: boolean; reasons: readonly string[]; evidence: Evidence; pilots: readonly Pilot[];
  providers: readonly { characterID: number; name: string; corporationID: number | null; corporationName?: string | null }[] }
export interface CenterReview { pilot: Pilot; matches: Match; status: ProvisioningStatus; selected: Contract | null; equipment: readonly EquipmentRow[]; requirements: readonly Requirement[];
  hullReview?: { current: string; required: string; matches: boolean; newHullRequired: boolean;
    packagedQuantity: number | null; preserveCurrentShip: boolean; ready: boolean };
  fittingService?: "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
  stockAuthority?: "VERIFIED_SOURCE" | "OFFLINE_PERSONAL_SNAPSHOT" | null;
  relevantStock?: readonly { typeID: number; name: string; quantity: number }[] | null;
  nativeResources?: any; rawReview?: unknown; droneBay?: DroneBayQualification;
  fittingResources?: { status: "READY" | "BLOCKED" | "UNKNOWN";
    cpu: { used: number | null; total: number | null } | null;
    powergrid: { used: number | null; total: number | null } | null; reasons: readonly string[] };
  skills?: { state: "READY" | "NOT_READY" | "UNAVAILABLE"; missing: readonly { name: string; level: number; trainedLevel: number | null }[] };
  applyReview: { reviewID: string; reviewHash: string | null; expiresAt: number | null; canApply: boolean; reasons: readonly string[]; suppliesPolicy: string;
    plan: { mode: string; hullQuantity: number | null; targetHullName: string; targetHullID?: number | null; hullSelection?: {kind:"READY"|"PARTIAL"|"EMPTY";origin:"active"|"hangar"|"corp";division?:number}; retainedRigs?: readonly {typeID:number;flagID:number;quantity:number;name:string}[]; hullCandidateCount?: number; hullCandidates?: readonly {itemID:number;name:string}[]; oldShipDestination?: {kind:"hangar"} | {kind:"corp";division:number} | null; steps: readonly string[]; unsupported: readonly string[]; shortages: readonly string[]; destructiveActions: readonly string[] } | null };
  definitions: { status: string; corporationID: number | null; providerCharacterID: number; contracts: readonly Contract[]; invalid: readonly { fittingID: number; reason: string }[] };
  candidateSource: { kind: string; quality: string; query: string; take: string; rows: readonly EquipmentRow[] | null; corporationID: number | null; division: number | null;
    officeID: number | null; contentsLocationID: number | null; flag: number; reasons: readonly string[]; revalidateOnApply: boolean }; evidence: Evidence }
export interface ApplyOutcome { operationID: string; state: string; reason: string | null;
  control: { state: string; generation: string | null; characterID?: number } | null;
  revalidation: { state: string; generation: string } | null;
  provisioning: { operationID: string; state: string; manifest?: { targetHullID: number | null; previousShipStorage?: { itemID: number; division: number; location: number; contentsCount: number } }; result?: ProvisioningStatus } | null;
  release: { state: string }; nativeResources?: any; rawReadout?: unknown; finalReview: { status: ProvisioningStatus; context: { shipID: number } } | null }
export function matchLabel(match: Match): string { return match.state === "MATCH" ? match.alternatives[0]?.name || "Fit unknown" : match.state === "AMBIGUOUS" ? `Multiple exact matches: ${match.alternatives.map(f => f.name).join(" · ")}` : match.state === "MODIFIED" ? "Modified / no exact equipment match" : "Fit unknown"; }

/** Sum per-slot comparisons only after the server has checked every exact slot. */
export function groupEquipment(rows: readonly Requirement[]): Requirement[] {
  const grouped = new Map<string, Requirement>();
  for (const row of rows) {
    const key = `${row.typeID}:${row.kind}`;
    const previous = grouped.get(key);
    grouped.set(key, { ...row, quantity: (previous?.quantity ?? 0) + row.quantity,
      current: row.current === undefined || previous && previous.current === undefined ? undefined : (previous?.current ?? 0) + row.current, missing: row.missing === undefined || previous && previous.missing === undefined ? undefined : (previous?.missing ?? 0) + row.missing });
  }
  return [...grouped.values()];
}
