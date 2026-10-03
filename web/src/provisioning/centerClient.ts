import type { ProvisioningStatus } from "../bridge/provisioning.ts";
export interface Requirement { typeID: number; name?: string; kind: string; flagID: number; quantity: number }
export interface EquipmentRow extends Requirement { itemID: number; loaded: boolean }
export interface Contract { name: string; shipTypeID: number; equipmentFingerprint: string; supplyPolicyFingerprint: string; definitionFingerprint: string;
  definition: { accountID: number; characterID: number; corporationID: number; fittingID: number; savedDate: string; fullFingerprint: string } }
export interface Match { state: string; alternatives: readonly { name: string; definition: Contract["definition"] }[] }
export interface Pilot { characterID: number; name: string; corporationID: number | null; locationID: number | null; stationID: number | null;
  dockState: string; shipID: number | null; shipTypeID: number | null; shipName: string | null; hullName: string | null;
  locationName?: string | null; quality: string; reasons: readonly string[]; control: { state: string; owner: string; online: boolean | null };
  status: ProvisioningStatus; matches: Match }
export interface Evidence { boundary: string; digest: string; startedAt: number; completedAt: number; stable: boolean; unsupported: readonly string[] }
export interface Roster { quality: string; completeRoster: boolean; reasons: readonly string[]; evidence: Evidence; pilots: readonly Pilot[];
  providers: readonly { characterID: number; name: string; corporationID: number | null }[] }
export interface CenterReview { pilot: Pilot; matches: Match; status: ProvisioningStatus; selected: Contract | null; equipment: readonly EquipmentRow[]; requirements: readonly Requirement[];
  applyReview: { reviewID: string; reviewHash: string | null; canApply: boolean; reasons: readonly string[]; suppliesPolicy: string;
    plan: { mode: string; hullQuantity: number; targetHullName: string; steps: readonly string[]; unsupported: readonly string[]; shortages: readonly string[]; destructiveActions: readonly string[] } | null };
  pendingApply: readonly { operationID: string; state: string; reason: string | null }[];
  definitions: { status: string; corporationID: number | null; providerCharacterID: number; contracts: readonly Contract[]; invalid: readonly { fittingID: number; reason: string }[] };
  candidateSource: { kind: string; quality: string; query: string; take: string; rows: readonly EquipmentRow[]; corporationID: number | null; division: number | null;
    officeID: number | null; contentsLocationID: number | null; flag: number; reasons: readonly string[]; revalidateOnApply: boolean }; evidence: Evidence }
async function request(path: string, token: string | null, body?: object): Promise<any> {
  const response = await fetch(path, { method: body ? "POST" : "GET", credentials: "omit", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok || !value.ok) throw new Error(value.message || value.error || "Observation unavailable");
  return value;
}
export const centerLogin = (username: string, password: string) => request("/api/ship-provisioning/login", null, { username, password });
export const centerRoster = (token: string, provider: number | null = null): Promise<Roster> => request(`/api/ship-provisioning/roster${provider ? `?providerCharacterID=${provider}` : ""}`, token);
export const centerReview = (token: string, input: { characterID: number; providerCharacterID: number; fittingID: number; sourceKind: string; corporationID: number; division: number }): Promise<CenterReview> =>
  request(`/api/ship-provisioning/review?${new URLSearchParams(Object.entries(input).map(([k,v]) => [k,String(v)]))}`,token);
export interface ApplyOutcome { operationID: string; state: string; reason: string | null;
  control: { state: string; generation: string | null; characterID?: number } | null;
  revalidation: { state: string; generation: string } | null;
  provisioning: { operationID: string; state: string; manifest?: { targetHullID: number | null }; result?: ProvisioningStatus } | null;
  release: { state: string }; finalReview: { status: ProvisioningStatus; context: { shipID: number } } | null }
export const centerApply = (token: string, reviewID: string, reviewHash: string): Promise<{ outcome: ApplyOutcome }> =>
  request("/api/ship-provisioning/apply",token,{ reviewID,reviewHash,confirm:true });
export const centerOperation = (token: string, operationID: string): Promise<{ outcome: ApplyOutcome }> =>
  request(`/api/ship-provisioning/operation?${new URLSearchParams({ operationID })}`,token);
export const centerRecover = (token: string, operationID: string): Promise<{ outcome: ApplyOutcome }> =>
  request("/api/ship-provisioning/recover",token,{ operationID });
export function matchLabel(match: Match): string { return match.state === "MATCH" ? match.alternatives[0]?.name || "Fit unknown" : match.state === "AMBIGUOUS" ? `Multiple exact matches: ${match.alternatives.map(f => f.name).join(" · ")}` : match.state === "MODIFIED" ? "Modified / no exact equipment match" : "Fit unknown"; }
