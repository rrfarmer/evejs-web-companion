// THE PI MANAGER'S ROSTER (R108 slice 3) — which pilots the player has put on
// planetary industry, and the last thing each one's colonies were read to say.
//
// ⚠ IT IS NOT A HANGAR SQUAD, and is only SEEDED from one. A squad
// (app/hangarPrefs.ts) is a fleet grouping; this is a job list. "Add everyone in
// this squad" copies the pilots once and the two are not linked after, because
// a job list that silently followed a fleet grouping would drift in a way
// nobody chose.
//
// ⚠ BY CHARACTER, like the companion roster (companionRosterPrefs.ts), so it
// survives a reload with no session anywhere.
//
// ⚠ A STORED READING IS KEPT AS IT ARRIVED AND DECODED ON THE WAY OUT.
// localStorage is untrusted bytes — another tab, an older build, a hand edit —
// so each pilot's entry from GET /api/roster/planets is stored verbatim beside
// the clock samples of the answer it came in, and `piReadings` runs it back
// through `decodeRosterColonies`, the same door a live answer goes through. A
// stored row and a fresh row can never be read two ways, and the read-at
// survives a reload: a board reopened tomorrow says yesterday's reading is a
// day old.

import type { JsonValue } from "../../../web/src/plugin-api/index.ts";
import { decodeRosterColonies, type PilotColonyReading } from "./piRoster.ts";

/** One pilot's entry from the route, with the answer's two clock samples. */
export interface StoredPiReading {
  /** The route's entry for this pilot, exactly as it arrived. */
  readonly pilot: JsonValue;
  /** The answer's own clock sample (its envelope `serverNowMs`). */
  readonly serverNowMs: number | null;
  /** The browser's clock as that answer landed. */
  readonly browserNowMs: number;
}

export interface PiRosterPrefs {
  /** The assigned pilots, by characterID, in the order they were added. */
  readonly members: readonly number[];
  /** characterID -> the last reading that answered for that pilot. */
  readonly readings: Readonly<Record<string, StoredPiReading>>;
}

export const EMPTY_PI_ROSTER: PiRosterPrefs = Object.freeze({
  members: Object.freeze([]) as readonly number[],
  readings: Object.freeze({}) as Readonly<Record<string, StoredPiReading>>,
});

const STORAGE_VERSION = 1;
const STORAGE_KEY = `evejs-web-pi-roster:v${STORAGE_VERSION}`;

/** The slice of `Storage` this module needs; tests supply their own. */
export interface PiRosterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function detectStorage(): PiRosterStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: PiRosterStorage | null }).localStorage;
    if (
      candidate &&
      typeof candidate.getItem === "function" &&
      typeof candidate.setItem === "function"
    ) {
      return candidate;
    }
  } catch {
    // Some privacy modes throw on touching localStorage — treat as unavailable.
  }
  return null;
}

let storage: PiRosterStorage | null = detectStorage();

/** Point this module at a different store (tests). Passing null disables it. */
export function setPiRosterStorage(next: PiRosterStorage | null): void {
  storage = next;
}

function isCharacterID(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** characterIDs, deduplicated, order preserved. */
function memberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const entry of value) {
    if (isCharacterID(entry) && !out.includes(entry)) out.push(entry);
  }
  return out;
}

function storedReading(value: unknown): StoredPiReading | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.browserNowMs !== "number" || !Number.isFinite(o.browserNowMs)) return null;
  if (!o.pilot || typeof o.pilot !== "object" || Array.isArray(o.pilot)) return null;
  const serverNowMs = typeof o.serverNowMs === "number" && Number.isFinite(o.serverNowMs)
    ? o.serverNowMs
    : null;
  return { pilot: o.pilot as JsonValue, serverNowMs, browserNowMs: o.browserNowMs };
}

/** The saved roster, or an empty one when none is stored / storage is off. */
export function loadPiRoster(): PiRosterPrefs {
  if (!storage) return EMPTY_PI_ROSTER;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_PI_ROSTER;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_PI_ROSTER;
    const o = parsed as Record<string, unknown>;
    const members = memberList(o.members);
    const readings: Record<string, StoredPiReading> = {};
    const rawReadings = o.readings && typeof o.readings === "object" && !Array.isArray(o.readings)
      ? (o.readings as Record<string, unknown>)
      : {};
    for (const characterID of members) {
      const reading = storedReading(rawReadings[String(characterID)]);
      if (reading !== null) readings[String(characterID)] = reading;
    }
    return { members, readings };
  } catch {
    return EMPTY_PI_ROSTER;
  }
}

/** Write the roster. Best-effort: a full or blocked store is never fatal. */
export function savePiRoster(prefs: PiRosterPrefs): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // A quota or a privacy mode. The window keeps working on the in-memory copy.
  }
}

// --- the pure operations the window drives -----------------------------------

/** Put a pilot on planetary industry. Adding one already there changes nothing. */
export function addPiMember(prefs: PiRosterPrefs, characterID: number): PiRosterPrefs {
  if (!isCharacterID(characterID) || prefs.members.includes(characterID)) return prefs;
  return { ...prefs, members: [...prefs.members, characterID] };
}

/** Put several on at once — a squad's pilots, copied once. */
export function addPiMembers(prefs: PiRosterPrefs, characterIDs: readonly number[]): PiRosterPrefs {
  return characterIDs.reduce(addPiMember, prefs);
}

/** Take a pilot off, and forget what was read for them. */
export function removePiMember(prefs: PiRosterPrefs, characterID: number): PiRosterPrefs {
  if (!prefs.members.includes(characterID)) return prefs;
  const readings = { ...prefs.readings };
  delete readings[String(characterID)];
  return { members: prefs.members.filter((id) => id !== characterID), readings };
}

/**
 * Keep what one answer said about each member it answered for.
 *
 * A member the answer LEFT OUT keeps its previous reading: being left out means
 * "could not be read", which the window says beside that older reading.
 */
export function recordPiAnswer(
  prefs: PiRosterPrefs,
  answer: JsonValue,
  browserNowMs: number,
): PiRosterPrefs {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return prefs;
  const envelope = answer as Record<string, JsonValue>;
  const serverNowMs = typeof envelope.serverNowMs === "number" ? envelope.serverNowMs : null;
  const pilots = Array.isArray(envelope.pilots) ? envelope.pilots : [];
  const readings = { ...prefs.readings };
  for (const pilot of pilots) {
    if (!pilot || typeof pilot !== "object" || Array.isArray(pilot)) continue;
    const characterID = (pilot as Record<string, JsonValue>).characterID;
    if (!isCharacterID(characterID) || !prefs.members.includes(characterID)) continue;
    readings[String(characterID)] = { pilot, serverNowMs, browserNowMs };
  }
  return { ...prefs, readings };
}

/** Every member's last reading, decoded — the same door a live answer uses. */
export function piReadings(prefs: PiRosterPrefs): Map<number, PilotColonyReading> {
  const out = new Map<number, PilotColonyReading>();
  for (const characterID of prefs.members) {
    const stored = prefs.readings[String(characterID)];
    if (!stored) continue;
    const [reading] = decodeRosterColonies(
      { serverNowMs: stored.serverNowMs, pilots: [stored.pilot] },
      stored.browserNowMs,
    );
    // Filed under the wrong pilot is not a reading of this one.
    if (reading && reading.characterID === characterID) out.set(characterID, reading);
  }
  return out;
}
