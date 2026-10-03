import type { MinerStage, TrainingEquipmentSource } from "./types.ts";
import type { FactoryStorage } from "./factory.ts";
export function equipmentState(stage: MinerStage | undefined, now: number) {
  const evidence = stage?.equipment;
  const fresh = !!evidence && evidence.observedAt <= now && evidence.validUntil > now;
  const equipment = fresh ? evidence.status.equipment : "UNKNOWN";
  return { equipment, supplies: fresh ? evidence.status.supplies : "UNKNOWN",
    duty: stage?.skillQualification === "READY" && equipment === "VERIFIED" ? "DUTY READY" : "NOT DUTY READY", fresh };
}
export const equipmentSourceKey = (account: string, id: number) => `pilot-training:equipment-source:v1:${account}:${id}`;
export function readEquipmentSource(storage: FactoryStorage, account: string, id: number): TrainingEquipmentSource {
  const source = JSON.parse(storage.getItem(equipmentSourceKey(account, id)) || '{"kind":"hangar"}');
  if (source?.kind === "hangar") return { kind: "hangar" };
  if (source?.kind === "corp" && Number.isSafeInteger(source.corporationID) && source.corporationID > 0 && Number.isInteger(source.division) && source.division >= 1 && source.division <= 7) return source;
  throw new Error("Equipment physical source is unreadable; choose a source explicitly.");
}
