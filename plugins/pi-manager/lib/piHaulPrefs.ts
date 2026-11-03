// What the Planetary Industry window's Haul button remembers between hauls,
// in this browser (localStorage): per pilot, where the goods are unloaded
// (a corporation division) and which station they are delivered to; per
// corporation, what its seven hangar divisions are CALLED.
//
// ⚠ THE NAMES ARE LEARNED, NEVER GUESSED. A division's name comes only from
// corpRegistry.GetCorporation, which answers only on a session that is in
// game: a pilot of that corporation online in this tab, or flown by a server
// bot. The window reads them whenever one is, and keeps them here, so the
// picker can say "Industry" on a later day when nobody of that corporation is
// online. Until then it says the names are not known yet, by number.
//
// Every read and write is wrapped: a private window or blocked storage keeps
// the choices for the open window only, and never breaks the board.

import type { WorldRef } from "../../../web/src/plugin-api/index.ts";
import type { PiHaulDivision } from "./piDispatch.ts";

const STORAGE_KEY = "evejs.piHaul";

export interface DivisionName {
  readonly division: number;
  readonly name: string | null;
}

export interface PiHaulPrefs {
  /** Per pilot: the corporation division the goods go into. Absent = own hangar. */
  readonly divisions: ReadonlyMap<number, NonNullable<PiHaulDivision>>;
  /** Per pilot: the station the goods are delivered to. Absent = where the run starts. */
  readonly deliverTo: ReadonlyMap<number, WorldRef>;
  /** Per corporation: its divisions' names, as last read. */
  readonly divisionNames: ReadonlyMap<number, readonly DivisionName[]>;
}

export const EMPTY_PI_HAUL_PREFS: PiHaulPrefs = {
  divisions: new Map(),
  deliverTo: new Map(),
  divisionNames: new Map(),
};

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function ids<T>(raw: unknown, read: (value: unknown) => T | null): Map<number, T> {
  const out = new Map<number, T>();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(key);
    const parsed = read(value);
    if (Number.isSafeInteger(id) && id > 0 && parsed !== null) out.set(id, parsed);
  }
  return out;
}

function readDivision(value: unknown): NonNullable<PiHaulDivision> | null {
  const row = value as { division?: unknown; name?: unknown } | null;
  if (row === null || typeof row !== "object" || typeof row.division !== "number") return null;
  if (!Number.isSafeInteger(row.division) || row.division < 1 || row.division > 7) return null;
  return { division: row.division, name: typeof row.name === "string" ? row.name : null };
}

function readStation(value: unknown): WorldRef | null {
  const row = value as Partial<WorldRef> | null;
  if (row === null || typeof row !== "object" || row.entity !== "station") return null;
  if (row.starting === true) return { entity: "station", id: null, name: null, systemName: null, starting: true };
  if (typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id <= 0) return null;
  return {
    entity: "station",
    id: row.id,
    name: typeof row.name === "string" ? row.name : null,
    systemName: typeof row.systemName === "string" ? row.systemName : null,
  };
}

function readNames(value: unknown): readonly DivisionName[] | null {
  if (!Array.isArray(value)) return null;
  const names = value
    .map((entry) => readDivision(entry))
    .filter((entry): entry is NonNullable<PiHaulDivision> => entry !== null);
  return names.length > 0 ? names : null;
}

/** What this browser remembers; empty when nothing is, or storage is blocked. */
export function loadPiHaulPrefs(): PiHaulPrefs {
  try {
    const raw = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    return {
      divisions: ids(raw["divisions"], readDivision),
      deliverTo: ids(raw["deliverTo"], readStation),
      divisionNames: ids(raw["divisionNames"], readNames),
    };
  } catch {
    return EMPTY_PI_HAUL_PREFS;
  }
}

export function savePiHaulPrefs(prefs: PiHaulPrefs): void {
  try {
    storage()?.setItem(
      STORAGE_KEY,
      JSON.stringify({
        divisions: Object.fromEntries(prefs.divisions),
        // An empty ref is the open picker's search state, not a destination to
        // remember. Reopening the window uses the starting station again.
        deliverTo: Object.fromEntries([...prefs.deliverTo].filter(([, ref]) => ref.id !== null)),
        divisionNames: Object.fromEntries(prefs.divisionNames),
      }),
    );
  } catch {
    // Kept for the open window only.
  }
}

/** One map entry set, or removed when `value` is null. */
export function withEntry<T>(map: ReadonlyMap<number, T>, key: number, value: T | null): Map<number, T> {
  const next = new Map(map);
  if (value === null) next.delete(key);
  else next.set(key, value);
  return next;
}

/** Keep an empty ref while Change opens search; starting station clears the choice. */
export function withPiHaulDelivery(prefs: PiHaulPrefs, characterID: number, ref: WorldRef): PiHaulPrefs {
  return {
    ...prefs,
    deliverTo: withEntry(prefs.deliverTo, characterID, ref.starting === true ? null : ref),
  };
}

/**
 * The names a fresh read gave, merged over what was remembered. A read that
 * named nothing at all (every division unnamed) is kept too: an unnamed
 * corporation is an answer, and "Division N" is then its real label.
 */
export function learnDivisionNames(
  prefs: PiHaulPrefs,
  corporationID: number,
  divisions: readonly DivisionName[],
): PiHaulPrefs {
  if (!Number.isSafeInteger(corporationID) || corporationID <= 0 || divisions.length === 0) return prefs;
  return { ...prefs, divisionNames: withEntry(prefs.divisionNames, corporationID, [...divisions]) };
}

/**
 * A pilot's picked division as the player reads it, by its corporation's
 * names as last learned. A pick saved before the names were known carries no
 * name, and must not keep saying "Division 1" once the name is known.
 */
export function pickedDivisionWords(
  prefs: PiHaulPrefs,
  corporationID: number | null,
  division: PiHaulDivision,
): string | null {
  if (division === null) return null;
  const learned = corporationID === null
    ? null
    : prefs.divisionNames.get(corporationID)?.find((entry) => entry.division === division.division)?.name ?? null;
  return divisionLabel(division.division, learned ?? division.name);
}

/** A division as the player reads it: its name, else its number. */
export function divisionLabel(division: number, name: string | null): string {
  return name !== null && name.trim().length > 0 ? name : `Division ${division}`;
}
