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

export interface CorporationMoonPull extends MoonPull {
  readonly structureID: number;
  readonly solarSystemID: number;
}

export interface CorporationMoonExtraction extends CorporationMoonPull {
  readonly name: string;
  readonly typeID: number;
  readonly profileID: number | null;
  readonly jumps: number | null;
  readonly security: number | null;
}

export interface CorporationMoonSchedule {
  readonly extractions: readonly CorporationMoonExtraction[];
  readonly profiles: readonly { id: number; name: string }[];
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

function decodeMoonPull(row: unknown): MoonPull | null {
  const id = moonMiningID(readKeyVal(row, "extractionID"));
  const readTime = (key: string) => filetimeToUnixMs(unwrapLong(readKeyVal(row, key)));
  const startedAtMs = readTime("startMoveTime");
  const readyAtMs = readTime("chunkAvailableTime");
  const automaticAtMs = readTime("naturalDecayTime");
  return id !== null && startedAtMs !== null && readyAtMs !== null && automaticAtMs !== null
    && startedAtMs < readyAtMs && automaticAtMs >= readyAtMs ? { id, startedAtMs, readyAtMs, automaticAtMs } : null;
}

export function decodeMoonSchedule(result: unknown, structureID: number, nowMs: number): MoonSchedule {
  const pair = Array.isArray(result) ? result : isListValue(result) ? result.items : [];
  if (pair.length === 2 && pair[0] === null && pair[1] === null) return { pull: null, calendarEventID: null, nowMs };
  const pull = decodeMoonPull(pair[0]);
  if (pair.length !== 2 || moonMiningID(readKeyVal(pair[0], "structureID")) !== structureID || pull === null) {
    throw new Error("The refinery returned an unreadable moon schedule.");
  }
  return { pull, calendarEventID: moonMiningID(pair[1]), nowMs };
}

export function decodeCorporationMoonPulls(result: unknown, corporationID: number): CorporationMoonPull[] {
  const rows: readonly unknown[] | null = Array.isArray(result) ? result : isListValue(result) ? result.items : null;
  if (rows === null) throw new Error("The corporation moon schedule could not be read.");
  return rows.flatMap(row => {
    const pull = decodeMoonPull(row);
    const structureID = moonMiningID(readKeyVal(row, "structureID"));
    const solarSystemID = moonMiningID(readKeyVal(row, "solarSystemID"));
    const ownerID = moonMiningID(readKeyVal(row, "ownerID"));
    return pull && structureID !== null && solarSystemID !== null && ownerID === corporationID
      ? [{ ...pull, structureID, solarSystemID }] : [];
  }).sort((a, b) => a.readyAtMs - b.readyAtMs || a.id - b.id);
}

export function moonPullDuration(readyAtMs: number, nowMs: number): number | null {
  const duration = Math.ceil((readyAtMs - nowMs) / 1000);
  return duration >= MIN_MOON_PULL_SECONDS && duration <= MAX_MOON_PULL_SECONDS ? duration : null;
}

export function hasMoonStationManagerRole(corpRole: string | null): boolean {
  return (BigInt(corpRole ?? "0") & 2048n) !== 0n;
}

export function canManageMoonPull(ownerID: number | null, corporationID: number | null, corpRole: string | null): boolean {
  return ownerID !== null && ownerID === corporationID && hasMoonStationManagerRole(corpRole);
}

export function moonPullStage(pull: MoonPull | null, nowMs: number, fracturing: boolean): "idle" | "pulling" | "ready" | "fracturing" {
  if (pull === null) return "idle";
  if (fracturing) return "fracturing";
  return pull.readyAtMs > nowMs ? "pulling" : "ready";
}
