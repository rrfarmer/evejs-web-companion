import { isListValue, readDictEntry, readDictPairs, readKeyVal, unwrapLong, type JsonValue } from "./wire.ts";

export const MAP_COLOR_MODES = {
  empire: { label: "UI/Map/MapPallet/cbStarsByEmpireFactions", fallback: "Empire Factions", group: null },
  ore: { label: "UI/Map/MapPallet/cbOreAnomalies", fallback: "Ore Anomalies", group: "mining" },
  phased: { label: "UI/Map/MapPallet/PhasedFields", fallback: "Phased Fields", group: "mining" },
  convoys: { label: "UI/Map/StarModeHandler/VanguardNemesisConvoys", fallback: "Vanguard Nemesis Convoys", group: "npc" },
} as const;
export type StarMapColorMode = keyof typeof MAP_COLOR_MODES;
export type StarMapActivityMode = Exclude<StarMapColorMode, "empire">;

export interface StarMapActivity {
  readonly systemID: number;
  readonly count: number;
  /** Null for a projected count. Exact sites keep their dungeon-name message IDs. */
  readonly dungeonNameIDs?: readonly number[] | null;
}

const number = (value: unknown) => Number(unwrapLong(value as JsonValue) ?? 0n);
const system = (id: number) => Number.isSafeInteger(id) && id >= 30000000 && id < 40000000;
const list = (value: JsonValue): readonly JsonValue[] | null => isListValue(value) ? value.items : Array.isArray(value) ? value : null;

/** The installed client's precise lists replace projected counts, including an empty list. */
export function oreActivities(counts: JsonValue, known: JsonValue, here: number | null): StarMapActivity[] {
  const data = new Map<number, StarMapActivity>();
  for (const [id, value] of readDictPairs(counts)) {
    const systemID = number(id), count = number(value);
    if (system(systemID) && count > 0 && Number.isSafeInteger(count)) data.set(systemID, { systemID, count, dungeonNameIDs: null });
  }
  // BaseCosmicAnomalyTracker inserts an empty list for the pilot's system
  // when the precise reply omits it.
  if (here !== null) data.delete(here);
  for (const [id, value] of readDictPairs(known)) {
    const systemID = number(id);
    if (!system(systemID)) continue;
    const sites = list(value);
    const count = sites?.length ?? number(value);
    if (count <= 0 || !Number.isSafeInteger(count)) { data.delete(systemID); continue; }
    data.set(systemID, { systemID, count, dungeonNameIDs: sites ? sites.map(site => number(readKeyVal(site, "dungeonNameID"))).filter(id => id > 0) : null });
  }
  return [...data.values()];
}

/** TaleMgr already filters active tales by template. Count each active tale by its system. */
export function convoyActivities(replies: readonly JsonValue[]): StarMapActivity[] {
  const counts = new Map<number, number>();
  const seen = new Set<number>();
  for (const reply of replies) {
    for (const tale of list(reply) ?? []) {
      const id = number(readDictEntry(tale, "tale_id"));
      const systemID = number(readDictEntry(tale, "solar_system_id"));
      if (!system(systemID) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      counts.set(systemID, (counts.get(systemID) ?? 0) + 1);
    }
  }
  return [...counts].map(([systemID, count]) => ({ systemID, count }));
}
