import { filetimeToUnixMs } from "./activity.ts";
import { isListValue, readDictPairs, readKeyVal, unwrapLong, unwrapReal } from "./wire.ts";

// Build 3698585, moonmining/const.py and the half-hour scheduler in planningCont.py.
export const MIN_MOON_PULL_SECONDS = 518460;
export const MAX_MOON_PULL_SECONDS = 4838400;
export const MOON_FRACTURE_MS = 30_000;
export const MOON_PLAN_STEP_MS = 30 * 60_000;

export interface MoonRefinery {
  readonly id: number;
  readonly name: string;
  readonly ownerID: number | null;
  readonly fuelExpiresAtMs: number | null;
  readonly canControl: boolean;
}

export interface MoonResource {
  readonly typeID: number;
  readonly fraction: number;
}

export interface MoonPull {
  readonly id: number;
  readonly startedAtMs: number;
  readonly readyAtMs: number;
  readonly automaticAtMs: number;
}

export interface MoonSchedule {
  readonly pull: MoonPull | null;
  readonly calendarEventID: number | null;
  readonly nowMs: number;
}

export function moonMiningID(value: unknown): number | null {
  const id = Number(unwrapLong(value));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function decodeMoonResources(result: unknown): MoonResource[] {
  return readDictPairs(result).flatMap(([type, amount]) => {
    const typeID = moonMiningID(type);
    const fraction = unwrapReal(amount);
    return typeID !== null && fraction !== null && fraction > 0 && fraction <= 1 ? [{ typeID, fraction }] : [];
  }).sort((a, b) => b.fraction - a.fraction || a.typeID - b.typeID);
}

export function decodeMoonSchedule(result: unknown, structureID: number, nowMs: number): MoonSchedule {
  const pair = Array.isArray(result) ? result : isListValue(result) ? result.items : [];
  if (pair.length === 2 && pair[0] === null && pair[1] === null) return { pull: null, calendarEventID: null, nowMs };
  const row: unknown = pair[0];
  const id = moonMiningID(readKeyVal(row, "extractionID"));
  const readTime = (key: string) => filetimeToUnixMs(unwrapLong(readKeyVal(row, key)));
  const startedAtMs = readTime("startMoveTime");
  const readyAtMs = readTime("chunkAvailableTime");
  const automaticAtMs = readTime("naturalDecayTime");
  if (pair.length !== 2 || moonMiningID(readKeyVal(row, "structureID")) !== structureID || id === null
    || startedAtMs === null || readyAtMs === null || automaticAtMs === null
    || startedAtMs >= readyAtMs || automaticAtMs < readyAtMs) {
    throw new Error("The refinery returned an unreadable moon schedule.");
  }
  return { pull: { id, startedAtMs, readyAtMs, automaticAtMs }, calendarEventID: moonMiningID(pair[1]), nowMs };
}

export function moonPullDuration(readyAtMs: number, nowMs: number): number | null {
  const duration = Math.ceil((readyAtMs - nowMs) / 1000);
  return duration >= MIN_MOON_PULL_SECONDS && duration <= MAX_MOON_PULL_SECONDS ? duration : null;
}

export function canManageMoonPull(ownerID: number | null, corporationID: number | null, corpRole: string | null): boolean {
  return ownerID !== null && ownerID === corporationID && (BigInt(corpRole ?? "0") & 2048n) !== 0n;
}

export function moonPullStage(pull: MoonPull | null, nowMs: number, fracturing: boolean): "idle" | "pulling" | "ready" | "fracturing" {
  if (pull === null) return "idle";
  if (fracturing) return "fracturing";
  return pull.readyAtMs > nowMs ? "pulling" : "ready";
}
