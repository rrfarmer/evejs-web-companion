// THE FLEET COMPANIONS WINDOW'S OWN ROSTER — which pilots are in the op, which
// fleet the op is, and the limits they all fly under.
//
// ⚠ THE WINDOW USED TO HAVE NO ROSTER AT ALL, and that is what this replaces. It
// listed every pilot signed into the tab, automatically: a pilot you brought
// online to check a contract sat in the fleet roster alongside the three you
// meant, and there was no way to say which was which. A companion op is a set
// of pilots the player CHOSE, so the window now holds that choice.
//
// ⚠ IT IS NOT A HANGAR SQUAD, and the two must not be merged. A squad
// (app/hangarPrefs.ts) is a durable label on pilots ACROSS accounts, used to
// bring them online and to launch headless runs from the landing screen; its
// companion configs are per pilot because the pilots in a squad do different
// jobs. This is one live operation in one tab: one fleet, one set of limits,
// and a list that is emptied when the op ends. Storing it in the squad map
// would make "who is in tonight's fleet" a permanent property of a pilot.
//
// ⚠ AND IT IS localStorage, SO IT IS NOT THE AUTHORITY FOR A RUNNING COMPANION.
// It is the template a start is built from. What a run is actually flying under
// is the request the loop was started with, which lives in the store.

import { decodeCompanionSetupValue } from "./companionRunPolicy.ts";
import { DEFAULT_COMPANION_SETUP } from "./fleetCompanionLoop.ts";
import type { CompanionSetup } from "./fleetCompanionLoop.ts";

export interface CompanionRosterPrefs {
  /**
   * The fleet every added pilot watches for, as it appears in the fleet finder.
   * Empty until the player types one — which is a legitimate resting state, not
   * an error: you can build the roster before the boss has advertised.
   */
  readonly fleetName: string;
  /**
   * The pilots in the op, by characterID, in the order they were added.
   *
   * ⚠ BY CHARACTER, NOT BY SESSION. A session id is minted per slot per tab and
   * is gone the moment the tab is (app/sessions.ts), so a roster keyed by one
   * would be empty after every reload while the pilots it named were still
   * flying on the BFF.
   */
  readonly members: readonly number[];
  /**
   * The limits every pilot in this op flies under.
   *
   * ⚠ ONE SETUP FOR THE WINDOW, NOT ONE PER PILOT, because adding a pilot now
   * starts it. A per-pilot form is a form somebody has to fill in before the
   * start it gates, and nobody fills in four of them while a fleet is forming;
   * what an op actually wants is "everyone flees at 30%".
   */
  readonly setup: CompanionSetup;
}

export const EMPTY_COMPANION_ROSTER: CompanionRosterPrefs = Object.freeze({
  fleetName: "",
  members: Object.freeze([]) as readonly number[],
  setup: DEFAULT_COMPANION_SETUP,
});

const STORAGE_VERSION = 1;
const STORAGE_KEY = `evejs-web-companion-roster:v${STORAGE_VERSION}`;

/** The slice of `Storage` this module needs; tests supply their own. */
export interface CompanionRosterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function detectStorage(): CompanionRosterStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: CompanionRosterStorage | null }).localStorage;
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

let storage: CompanionRosterStorage | null = detectStorage();

/** Point this module at a different store (tests). Passing null disables it. */
export function setCompanionRosterStorage(next: CompanionRosterStorage | null): void {
  storage = next;
}

/** characterIDs, deduplicated, order preserved. */
function memberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * The stored setup, or the default.
 *
 * ⚠ THROUGH THE CODEC THE BOT HOST ALREADY TRUSTS. localStorage is untrusted
 * bytes like any other input — another tab, an older build, a hand-edited value
 * — and `decodeCompanionSetupValue` is the door `botHost.start()` uses. A
 * refused value falls back to the DEFAULT rather than being dropped, because
 * unlike a hangar config (where absence means "this pilot is not a companion")
 * there is always exactly one setup here and the window must render something.
 */
function storedSetup(value: unknown): CompanionSetup {
  const decoded = decodeCompanionSetupValue(value);
  return decoded.ok ? decoded.setup : DEFAULT_COMPANION_SETUP;
}

/** The saved op, or an empty one when none is stored / storage is off. */
export function loadCompanionRoster(): CompanionRosterPrefs {
  if (!storage) return EMPTY_COMPANION_ROSTER;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_COMPANION_ROSTER;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return EMPTY_COMPANION_ROSTER;
    }
    const o = parsed as Record<string, unknown>;
    return {
      fleetName: typeof o.fleetName === "string" ? o.fleetName : "",
      members: memberList(o.members),
      setup: storedSetup(o.setup),
    };
  } catch {
    return EMPTY_COMPANION_ROSTER;
  }
}

/** Write the op. Best-effort: a full or blocked store is never fatal. */
export function saveCompanionRoster(prefs: CompanionRosterPrefs): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // A quota or a privacy mode. The window keeps working on the in-memory copy.
  }
}

// --- the pure operations the window drives -----------------------------------

/** Put a pilot in the op. Adding one that is already in it changes nothing. */
export function addRosterMember(
  prefs: CompanionRosterPrefs,
  characterID: number,
): CompanionRosterPrefs {
  if (!Number.isFinite(characterID) || characterID <= 0) return prefs;
  if (prefs.members.includes(characterID)) return prefs;
  return { ...prefs, members: [...prefs.members, characterID] };
}

/** Take a pilot out of the op. */
export function removeRosterMember(
  prefs: CompanionRosterPrefs,
  characterID: number,
): CompanionRosterPrefs {
  if (!prefs.members.includes(characterID)) return prefs;
  return { ...prefs, members: prefs.members.filter((id) => id !== characterID) };
}

/**
 * Name the fleet.
 *
 * ⚠ STORED AS TYPED, matched case-insensitively later. Echoing the player's own
 * capitalisation back at them in every row is how a roster reads as a record of
 * what they asked for rather than a normalisation of it.
 */
export function setRosterFleetName(
  prefs: CompanionRosterPrefs,
  fleetName: string,
): CompanionRosterPrefs {
  return { ...prefs, fleetName };
}

/** Change the limits every pilot in the op flies under. */
export function setRosterSetup(
  prefs: CompanionRosterPrefs,
  setup: CompanionSetup,
): CompanionRosterPrefs {
  return { ...prefs, setup };
}
