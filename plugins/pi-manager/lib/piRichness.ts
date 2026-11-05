// PLANET RICHNESS -- how rich each resource on a planet is, as the server
// states it, kept in this browser once learned.
//
// ⚠ STATIC, SO KEPT. A planet's richness is fixed (the server generates it
// once per planet and never changes it), so a number read once is good for
// ever and is never read again. Browser-local, like the planner's view state:
// it is a cache of server facts, not anything the player decided.
//
// ⚠ TWO SOURCES, NEITHER A SELECT. Planets a roster pilot has colonised carry
// their richness in the colony read already. Any other planet is asked with
// the game's own GetPlanetResourceInfo, on the session of a pilot ALREADY
// online in this tab (the corp-hangar read's rule, app/corpStockRead.ts). With
// nobody online, nothing is read and the plan says which planets are unknown.

import { getPlanetRichness, type ApiOptions } from "../../../web/src/plugin-api/index.ts";
import { decodePlanetResourceInfo } from "../../../web/src/plugin-api/index.ts";
import type { PilotColonyReading } from "./piRoster.ts";
import type { JsonValue } from "../../../web/src/plugin-api/index.ts";

/** planetID -> resourceTypeID -> quality. */
export type RichnessMap = ReadonlyMap<number, ReadonlyMap<number, number>>;

const STORAGE_KEY = "evejs-web-pi-richness:v1";
/** One ask carries at most this many planets (the route's own cap). */
export const RICHNESS_BATCH = 60;

export interface PiRichnessStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function detectStorage(): PiRichnessStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: PiRichnessStorage | null }).localStorage;
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") {
      return candidate;
    }
  } catch {
    // Some privacy modes throw on touching localStorage -- treat as unavailable.
  }
  return null;
}

let storage: PiRichnessStorage | null = detectStorage();

/** Point this module at a different store (tests). Passing null disables it. */
export function setPiRichnessStorage(next: PiRichnessStorage | null): void {
  storage = next;
}

function quality(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

export function loadRichness(): RichnessMap {
  const out = new Map<number, Map<number, number>>();
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [planetKey, byType] of Object.entries(parsed as Record<string, unknown>)) {
        const planetID = Number(planetKey);
        if (!Number.isSafeInteger(planetID) || planetID <= 0 || !byType || typeof byType !== "object") continue;
        const entry = new Map<number, number>();
        for (const [typeKey, value] of Object.entries(byType as Record<string, unknown>)) {
          const typeID = Number(typeKey);
          const q = quality(value);
          if (Number.isSafeInteger(typeID) && typeID > 0 && q !== null) entry.set(typeID, q);
        }
        if (entry.size > 0) out.set(planetID, entry);
      }
    }
  } catch {
    // A damaged store is an empty one: richness is only ever a cache.
  }
  return out;
}

export function saveRichness(map: RichnessMap): void {
  const plain: Record<string, Record<string, number>> = {};
  for (const [planetID, byType] of map) plain[String(planetID)] = Object.fromEntries([...byType].map(([typeID, q]) => [String(typeID), q]));
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(plain));
  } catch {
    // Full or refused: the plan still works on what it read this time.
  }
}

/** `base` with every planet in `more` added or replaced. */
export function mergeRichness(base: RichnessMap, more: RichnessMap): RichnessMap {
  const out = new Map(base);
  for (const [planetID, byType] of more) if (byType.size > 0) out.set(planetID, byType);
  return out;
}

/** What the roster's own colony reads already say about their planets. */
export function richnessFromReadings(readings: ReadonlyMap<number, PilotColonyReading>): RichnessMap {
  const out = new Map<number, Map<number, number>>();
  for (const reading of readings.values()) {
    for (const colony of reading.report.colonies) {
      const entry = new Map<number, number>();
      for (const resource of colony.resources ?? []) {
        const q = quality(resource.quality);
        if (q !== null) entry.set(resource.typeID, q);
      }
      if (entry.size > 0) out.set(colony.planetID, entry);
    }
  }
  return out;
}

/** Decode GET /api/pi/planet-richness: the planets that answered, each with its table. */
export function decodePlanetRichness(value: JsonValue): RichnessMap {
  const out = new Map<number, Map<number, number>>();
  const planets = value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as Record<string, JsonValue>).planets)
    ? (value as Record<string, JsonValue>).planets as JsonValue[]
    : [];
  for (const entry of planets) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const o = entry as Record<string, JsonValue>;
    const planetID = Number(o.planetID);
    if (!Number.isSafeInteger(planetID) || planetID <= 0 || o.result === undefined) continue;
    const table = new Map<number, number>();
    for (const row of decodePlanetResourceInfo(o.result)) {
      const typeID = Number(row.resourceTypeID);
      const q = quality(row.quality);
      if (Number.isSafeInteger(typeID) && typeID > 0 && q !== null) table.set(typeID, q);
    }
    if (table.size > 0) out.set(planetID, table);
  }
  return out;
}

/**
 * Read the richness of `planetIDs` on the session these options carry, a
 * batch at a time. Planets that fail to answer are simply left unknown.
 */
export async function readRichness(
  planetIDs: readonly number[],
  options: ApiOptions,
  ask: (ids: readonly number[], options: ApiOptions) => Promise<JsonValue> = getPlanetRichness,
): Promise<RichnessMap> {
  let found: RichnessMap = new Map();
  for (let start = 0; start < planetIDs.length; start += RICHNESS_BATCH) {
    found = mergeRichness(found, decodePlanetRichness(await ask(planetIDs.slice(start, start + RICHNESS_BATCH), options)));
  }
  return found;
}
