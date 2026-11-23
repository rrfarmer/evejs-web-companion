import type { CorporationSavedFitting } from "./types.ts";
import type { FactoryStorage, PlanMode } from "./factory.ts";

export interface TrainingConfiguration {
  configurationID: string; roleID: string; order: number; corporationOwnerID: number;
  fittingID: number; hullTypeID: number; acceptedSavedDate?: string; acceptedFingerprint?: string;
  supportPolicyKey?: string | null; supportPolicyVersion?: number | null;
}
export interface TrainingPreferences {
  version: 2; role: string; mode: PlanMode; targetStage: string | null;
  roles: Record<string, TrainingConfiguration[]>;
}
export const rolePattern = /^[A-Z][A-Z0-9_-]{0,39}$/;
export const configurationKey = (account: string, id: number) => `pilot-training:config:v2:${account}:${id}`;
const legacyHulls = { VENTURE: 32880, PIONEER: 89240, PROCURER: 17480 } as const;
export function validateConfigurations(role: string, configs: readonly TrainingConfiguration[]): void {
  if (!rolePattern.test(role) || !Array.isArray(configs) || configs.length > 3) throw new Error("At most three configurations per role.");
  const ids = new Set<string>(), contracts = new Set<string>();
  configs.forEach((c, i) => {
    if (!c || !/^[A-Za-z0-9_-]{1,100}$/.test(c.configurationID) || c.roleID !== role || c.order !== i ||
      [c.corporationOwnerID, c.fittingID, c.hullTypeID].some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      (c.acceptedFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(c.acceptedFingerprint)) ||
      (c.acceptedSavedDate !== undefined && !/^[1-9][0-9]{0,19}$/.test(c.acceptedSavedDate)) ||
      (c.supportPolicyKey != null && (role !== "MINER" || !Object.hasOwn(legacyHulls, c.supportPolicyKey) || c.supportPolicyVersion !== 1)))
      throw new Error("Invalid saved qualification contract.");
    const contract = `${c.corporationOwnerID}:${c.fittingID}`;
    if (ids.has(c.configurationID) || contracts.has(contract)) throw new Error("This qualification contract already exists.");
    ids.add(c.configurationID); contracts.add(contract);
  });
}
export function saveTrainingPreferences(storage: FactoryStorage, account: string, id: number, value: TrainingPreferences): void {
  if (value.version !== 2 || (value.role && !rolePattern.test(value.role)) || !["FAST", "BALANCED", "MASTERY"].includes(value.mode) || !value.roles || Array.isArray(value.roles)) throw new Error("Invalid training preferences.");
  for (const [role, configs] of Object.entries(value.roles)) validateConfigurations(role, configs);
  if (value.targetStage !== null && !(value.roles[value.role] || []).some((c) => c.configurationID === value.targetStage)) throw new Error("Target qualification is not configured for this role.");
  storage.setItem(configurationKey(account, id), JSON.stringify(value));
}
export function readTrainingPreferences(storage: FactoryStorage, account: string, id: number): TrainingPreferences {
  const key = configurationKey(account, id), raw = storage.getItem(key);
  if (raw !== null) {
    const value = JSON.parse(raw) as TrainingPreferences;
    // Validation without a write: a failed read never destroys recoverable data.
    saveTrainingPreferences({ getItem: () => null, setItem: () => {} }, account, id, value);
    return value;
  }
  const old = JSON.parse(storage.getItem(`goblin-factory:pilot:v1:${account}:${id}`) || "{}");
  const selected = JSON.parse(storage.getItem(`pilot-training:miner:${account}:${id}`) || "{}");
  if (!selected || typeof selected !== "object" || Array.isArray(selected) || !old || typeof old !== "object") throw new Error("Legacy training configuration is unreadable.");
  const configs: TrainingConfiguration[] = [];
  for (const [stage, hullTypeID] of Object.entries(legacyHulls)) {
    const fit = selected[stage];
    if (!fit) continue;
    const c = { configurationID: `legacy-miner-${stage.toLowerCase()}`, roleID: "MINER", order: configs.length,
      corporationOwnerID: fit.ownerID, fittingID: fit.fittingID, hullTypeID,
      acceptedSavedDate: fit.acceptedSavedDate, acceptedFingerprint: fit.acceptedFingerprint,
      supportPolicyKey: stage, supportPolicyVersion: 1 };
    if (fit.scope !== "CORPORATION") throw new Error("Legacy corporation selection is invalid.");
    validateConfigurations("MINER", [...configs, c]); configs.push(c);
  }
  const role = old.role === "MINER" ? "MINER" : "";
  const targetStage = role && configs.find((c) => c.configurationID === `legacy-miner-${String(old.targetStage).toLowerCase()}`)?.configurationID || null;
  const value: TrainingPreferences = { version: 2, role, mode: ["FAST", "BALANCED", "MASTERY"].includes(old.mode) ? old.mode : "FAST",
    targetStage, roles: configs.length ? { MINER: configs } : {} };
  // One atomic document becomes the only active source. Old keys remain backups.
  saveTrainingPreferences(storage, account, id, value);
  return value;
}
export function setRole(value: TrainingPreferences, role: string): TrainingPreferences {
  if (role && !rolePattern.test(role)) throw new Error("Use an uppercase role ID, letters/numbers/underscore/hyphen.");
  return { ...value, role, mode: role === "MINER" ? value.mode : "FAST", targetStage: null, roles: role ? { ...value.roles, [role]: value.roles[role] || [] } : value.roles };
}
export function configurationFromFit(role: string, fit: CorporationSavedFitting, order: number, id: string,
  supportPolicyKey: string | null = null): TrainingConfiguration {
  if (fit.invalid || !fit.shipTypeID || !fit.fingerprint || !fit.savedDate) throw new Error("Invalid corporation fitting.");
  return { configurationID: id, roleID: role, order, corporationOwnerID: fit.ownerID, fittingID: fit.fittingID,
    hullTypeID: fit.shipTypeID, supportPolicyKey, supportPolicyVersion: supportPolicyKey ? 1 : null };
}
export function putConfiguration(value: TrainingPreferences, config: TrainingConfiguration): TrainingPreferences {
  const before = value.roles[value.role] || [];
  const found = before.some((c) => c.configurationID === config.configurationID);
  const configs = found ? before.map((c) => c.configurationID === config.configurationID ? config : c) : [...before, config];
  validateConfigurations(value.role, configs);
  return { ...value, roles: { ...value.roles, [value.role]: configs } };
}
export function removeConfiguration(value: TrainingPreferences, id: string): TrainingPreferences {
  const configs = (value.roles[value.role] || []).filter((c) => c.configurationID !== id).map((c, order) => ({ ...c, order }));
  return { ...value, targetStage: value.targetStage === id ? null : value.targetStage, roles: { ...value.roles, [value.role]: configs } };
}
export function hullChoices(fittings: readonly CorporationSavedFitting[]) {
  return [...new Map(fittings.filter((f) => !f.invalid && f.shipTypeID).map((f) => [f.shipTypeID!, { typeID: f.shipTypeID!, name: f.hullName || `Hull ${f.shipTypeID}` }])).values()];
}
export function configSelections(configs: readonly TrainingConfiguration[]) {
  return Object.fromEntries(configs.map((c) => [c.configurationID, { scope: "CORPORATION" as const, ownerID: c.corporationOwnerID,
    fittingID: c.fittingID, acceptedSavedDate: c.acceptedSavedDate, acceptedFingerprint: c.acceptedFingerprint }]));
}
export function qualificationName(report: import("./types.ts").MinerReport | null | undefined, id: string | null | undefined): string {
  if (!id) return "None";
  const c = report?.stages.find((c) => c.id === id);
  return c ? `${c.hullName || c.id} · ${c.fitName}` : id;
}
