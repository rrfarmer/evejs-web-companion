import type { FactoryStorage } from "./factory.ts";
import { isTrainingFundingPolicy, resolveTrainingFundingPolicy, type FundingPolicy } from "../../training/funding.ts";
interface DockableLocation { readonly kind: "station" | "structure"; readonly id: number; readonly name: string; readonly solarSystemID: number; readonly solarSystemName: string | null }
export interface TrainingCorporation { corporationID: number; name: string; divisions: { accountKey: number; name: string }[] }
export interface TrainingAuthority { key: string; name: string; account: string; corporationID: number; eligible: boolean }
export interface TrainingSettingsContext {
  corporations: TrainingCorporation[];
  authorities: { characterID: number; name: string; corporationID: number; eligible: boolean; reason?: string }[];
}
export type TrainingHomeMatch = DockableLocation;
export interface TrainingWallet { corporationID: number; accountKey: number }
export interface TrainingSettings {
  onboarding: { enabled: boolean; corporationID: number | null; rights: "NONE" | "FULL_ACCESS_EXCEPT_CEO"; authorityKey: string };
  trainingWallet: TrainingWallet | null;
  fundingPolicy?: FundingPolicy;
  /** Legacy settings written before there were three funding modes. */
  automaticFunding?: boolean;
  home: { locationID: number; name: string; systemID: number | null; kind: string; relocation: string; capability: string } | null;
}
const key = "pilot-training:settings:v1";
export interface TrainingPilotRef { readonly account: string; readonly characterID: number }

export function trainingPilotKey(account: string, characterID: number): string {
  return JSON.stringify([account, characterID]);
}

export function trainingPilotRef(value: string): TrainingPilotRef | null {
  try {
    const key: unknown = JSON.parse(value);
    return Array.isArray(key) && key.length === 2 && typeof key[0] === "string" && key[0].trim() &&
      Number.isSafeInteger(key[1]) && key[1] > 0 ? { account: key[0], characterID: key[1] } : null;
  } catch { return null; }
}

export const defaultTrainingSettings = (): TrainingSettings => ({ onboarding: { enabled: false, corporationID: null, rights: "FULL_ACCESS_EXCEPT_CEO", authorityKey: "" }, trainingWallet: null, fundingPolicy: "CHARACTER_WALLET_ONLY", home: null });
function validate(value: TrainingSettings): void {
  const o = value?.onboarding;
  if (!o || typeof o.enabled !== "boolean" || !["NONE", "FULL_ACCESS_EXCEPT_CEO"].includes(o.rights) || typeof o.authorityKey !== "string" ||
    (o.corporationID !== null && (!Number.isSafeInteger(o.corporationID) || o.corporationID <= 0)) ||
    (o.enabled && (!o.corporationID || !o.authorityKey))) throw new Error("Onboarding requires a corporation and a dedicated non-CEO authority.");
  if (value.automaticFunding !== undefined && typeof value.automaticFunding !== "boolean") throw new Error("Invalid automatic funding setting.");
  if (value.fundingPolicy !== undefined && !isTrainingFundingPolicy(value.fundingPolicy)) throw new Error("Invalid training funding policy.");
  if (value.trainingWallet && (!Number.isSafeInteger(value.trainingWallet.corporationID) || value.trainingWallet.corporationID <= 0 ||
    !Number.isInteger(value.trainingWallet.accountKey) || value.trainingWallet.accountKey < 1000 || value.trainingWallet.accountKey > 1006)) throw new Error("Configure a corporation and training wallet division explicitly.");
  if (value.home && (!Number.isSafeInteger(value.home.locationID) || value.home.locationID <= 0 || typeof value.home.name !== "string" ||
      !((value.home.kind === "NPC_STATION" && value.home.relocation === "MANUAL_GM_ONLY") ||
        (value.home.kind === "PLAYER_STRUCTURE" && value.home.relocation === "CONFIG_ONLY" &&
          value.home.capability === "DOCKABLE_STRUCTURE" && value.home.locationID >= 1_000_000_000_000 &&
          typeof value.home.systemID === "number" && Number.isSafeInteger(value.home.systemID) &&
          value.home.systemID > 0 && value.home.name.trim().length > 0))))
    throw new Error("Unsupported home location. Resolve the location first.");
}
export function readTrainingSettings(storage: FactoryStorage): TrainingSettings {
  const raw = storage.getItem(key);
  if (raw === null) return defaultTrainingSettings();
  const value = JSON.parse(raw) as TrainingSettings;
  validate(value);
  return { ...value, fundingPolicy: resolveTrainingFundingPolicy(value.fundingPolicy, value.automaticFunding) };
}
export function saveTrainingSettings(storage: FactoryStorage, value: TrainingSettings): void { validate(value); storage.setItem(key, JSON.stringify(value)); }

export type TrainingReference = "onboarding" | "trainingWallet" | "home";
export function clearTrainingReferences(settings: TrainingSettings, keys: readonly TrainingReference[]): TrainingSettings {
  const next = { ...settings };
  const defaults = defaultTrainingSettings();
  for (const key of keys) {
    if (key === "onboarding") next.onboarding = defaults.onboarding;
    if (key === "trainingWallet") next.trainingWallet = null;
    if (key === "home") next.home = null;
  }
  return next;
}
