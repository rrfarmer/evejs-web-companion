import type {
  MinerReport,
  RequirementRow,
  StageFittingSelection,
  QueueApplyOutcome,
} from "./types.ts";
import { BridgeCallError } from "../../../../web/src/plugin-api/index.ts";
const panelErrorWords = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export function factoryError(cause: unknown): string {
  return cause instanceof BridgeCallError && cause.code === "UNKNOWN_EVEJS_ACCOUNT"
    ? "UNKNOWN_EVEJS_ACCOUNT: This account does not exist in the current EveJS runtime. Factory does not create accounts."
    : panelErrorWords(cause);
}

export type PlanMode = "FAST" | "BALANCED" | "MASTERY";
export interface PilotPreferences {
  role: "MINER" | "";
  mode: PlanMode;
  targetStage?: "VENTURE" | "PIONEER" | "PROCURER" | null;
}
export interface FactoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export type LastQueueApply = Pick<
  QueueApplyOutcome,
  "mode" | "stage" | "status" | "at" | "added" | "attemptedAdditions" | "verified" | "code"
>;
const applyKey = (account: string, id: number) => `goblin-factory:last-apply:v1:${account}:${id}`;
export function rememberQueueApply(
  storage: FactoryStorage,
  account: string,
  id: number,
  outcome: QueueApplyOutcome,
): LastQueueApply {
  const { mode, stage, status, at, added, attemptedAdditions, verified, code } = outcome;
  const record = { mode, stage, status, at, added, attemptedAdditions, verified, code };
  storage.setItem(applyKey(account, id), JSON.stringify(record));
  return record;
}
export function readLastQueueApply(
  storage: FactoryStorage,
  account: string,
  id: number,
): LastQueueApply | null {
  try {
    const value = JSON.parse(storage.getItem(applyKey(account, id)) || "null");
    return value &&
      ["FAST", "BALANCED", "MASTERY"].includes(value.mode) &&
      typeof value.stage === "string" &&
      ["APPLIED", "REFUSED", "APPLY_UNVERIFIED"].includes(value.status) &&
      typeof value.verified === "boolean" &&
      Number.isFinite(value.at)
      ? value
      : null;
  } catch {
    return null;
  }
}
export function skillTargetLabel(state: RequirementRow["state"]): string {
  return state === "MISSING" ? "NEEDS TRAINING" : state;
}
export const factoryAccountsKey = "goblin-factory:accounts:v1";
export function fittingConfigKey(account: string, characterID: number): string {
  // Compatibility contract: exactly the key and bare stage-map used by c15a514.
  return `pilot-training:miner:${account}:${characterID}`;
}
export function pilotPreferenceKey(account: string, characterID: number): string {
  return `goblin-factory:pilot:v1:${account}:${characterID}`;
}
export function readSelections(
  storage: FactoryStorage,
  account: string,
  characterID: number,
): Record<string, StageFittingSelection> {
  const value: unknown = JSON.parse(
    storage.getItem(fittingConfigKey(account, characterID)) || "{}",
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Saved fitting configuration is unreadable.");
  return value as Record<string, StageFittingSelection>;
}
export function saveSelections(
  storage: FactoryStorage,
  account: string,
  characterID: number,
  selections: Readonly<Record<string, StageFittingSelection>>,
): void {
  storage.setItem(fittingConfigKey(account, characterID), JSON.stringify(selections));
}
export function readPilotPreferences(
  storage: FactoryStorage,
  account: string,
  characterID: number,
): PilotPreferences {
  const value = JSON.parse(
    storage.getItem(pilotPreferenceKey(account, characterID)) || "{}",
  ) as Partial<PilotPreferences> | null;
  return {
    role: value?.role === "MINER" ? "MINER" : "",
    mode: value?.mode === "FAST" || value?.mode === "MASTERY" ? value.mode : "BALANCED",
    targetStage:
      value?.targetStage && ["VENTURE", "PIONEER", "PROCURER"].includes(value.targetStage)
        ? value.targetStage
        : null,
  };
}
export function savePilotPreferences(
  storage: FactoryStorage,
  account: string,
  characterID: number,
  prefs: PilotPreferences,
): void {
  storage.setItem(pilotPreferenceKey(account, characterID), JSON.stringify(prefs));
}
export function readFactoryAccounts(storage: FactoryStorage): string[] {
  const value: unknown = JSON.parse(storage.getItem(factoryAccountsKey) || "[]");
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}
export function rememberFactoryAccount(storage: FactoryStorage, account: string): void {
  storage.setItem(
    factoryAccountsKey,
    JSON.stringify([...new Set([...readFactoryAccounts(storage), account])]),
  );
}
export const factoryStatusLabels = {
  READY: "Plan ready · skills only",
  TRAINING: "Training",
  NEEDS_REVIEW: "Needs review",
  NOT_READY: "Not ready",
  UNKNOWN: "Unknown",
} as const;
export type FactoryStatus = keyof typeof factoryStatusLabels;
export function factoryStatus(
  report: MinerReport | null,
  mode: PlanMode,
  error = "",
): FactoryStatus {
  if (error || !report) return "UNKNOWN";
  if (report.stages.some((stage) => stage.fitting.status === "REVIEW_REQUIRED"))
    return "NEEDS_REVIEW";
  const preview = report.previews[mode];
  if (
    preview.targets.some((row) => row.state === "UNKNOWN") ||
    (preview.targets.length === 0 && preview.eta.kind === "UNKNOWN")
  )
    return "UNKNOWN";
  if (preview.targets.length === 0 && preview.eta.kind === "READY") return "READY";
  if (report.trainingState === "TRAINING") return "TRAINING";
  return "NOT_READY";
}
export function requirementCounts(
  rows: readonly RequirementRow[],
): Record<RequirementRow["state"], number> {
  const counts = { TRAINED: 0, TRAINING: 0, QUEUED: 0, MISSING: 0, UNKNOWN: 0 };
  for (const row of rows) counts[row.state]++;
  return counts;
}
