// Crimewatch/security reads, including the native engagement dictionary.
// The original quiet capture below is one case, not a populated-state contract.
//
// These are the raw retail crimewatch reads on service "crimewatch". Retail
// obtains crimewatch as a bound Moniker (CrimewatchService defines MachoBindObject
// and it is NOT in machoNet's serviceInfo table). The game-port transport uses
// that location-bound moniker. The historical gateway fallback dispatches
// serviceManager.lookup("crimewatch") directly — a real registered service
// (super("crimewatch")) — and all four handlers are session/arg-derived with NO
// bound-state dependency, so that fallback dispatches each as heldTopLevelCall
// ("crimewatch", <method>) on the ORDINARY top-level /call seam (mirrors R73
// skillHandler / R76 jumpCloneSvc), NOT a bound two-step.
//
// ⚠ OWNERSHIP (verified LIVE cross-account 2026-07-22, Farmer 140000005 sec 0.1404
// vs Test Two 140000002 sec 0). ALL SESSION-SCOPED or STATIC-PUBLIC — SAFE:
//   - GetClientStates / GetMySecurityStatus derive the char from the SESSION and
//     IGNORE any injected charID (Farmer injecting Test Two's id still returned
//     Farmer's own 0.1404; Test Two injecting Farmer's id still returned 0 — the
//     distinct values make it decisive).
//   - GetSecurityStatusTransactions takes no args and returns [] (no history is
//     persisted server-side — a legitimately empty private-history read).
//   - GetCharacterSecurityStatus(charID) returns ONLY the requested char's PUBLIC
//     sec-status FLOAT (rendered on every EVE overview), never private crimewatch
//     state — public-by-design, no leak.
//
// ---------------------------------------------------------------------------
// WIRE SHAPES (captured LIVE 2026-07-22, Farmer 140000005 unless noted):
//
//  GetClientStates: a 4-tuple ARRAY:
//    [0] combat-timer tuples: [[stateCode, expiry], …] — Farmer's clean state is
//        [[100,null],[200,null],[400,null],[300,null],[500,null]] (weapon/pvp/npc/
//        criminal/disapproval, all idle). An IDLE timer is [code, null]; an ACTIVE
//        one is [code+2, {type:"long", value:<FILETIME>}] (server buildTimerTuple).
//    [1] engagements dict: other character -> FILETIME timeout, or -1 ongoing.
//        crimewatchSvc.ProcessSessionChange96-104 keeps this as myEngagements;
//        Farmer's captured clean state happened to have none.
//    [2] flagged-character sets: [criminalsSet, suspectsSet] — each a Python set
//        objectex1 {type:"objectex1", header:[{token:"__builtin__.set"},
//        [{type:"list", items:[<charID>, …]}]], …}; members ride header[1][0].items
//        (EMPTY for Farmer's clean state).
//    [3] safetyLevel: a bare int (Farmer 2 = full/green).
//  GetMySecurityStatus: a BARE float (Farmer 0.1404) — the session char's own sec.
//  GetCharacterSecurityStatus: a BARE float (Farmer own 0.1404; foreign public
//    lookup returns THAT char's public sec, e.g. Test Two 0).
//  GetSecurityStatusTransactions: {type:"list", items:[]} — the sec-change history,
//    EMPTY (the handler returns buildList([]) unconditionally; no history persisted).
//
// This module decodes the raw marshaled reads for GET /api/bridge/bound-crimewatch;
// The HUD, security panels and native Duel guard consume these decoded values.

import { isListValue, unwrapLong, type JsonValue } from "./wire.ts";

// --- local coercions (do NOT import from market*.ts — separate session) -----

function asObject(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

function asArray(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? (value as readonly JsonValue[]) : [];
}

/**
 * An EXACT integer as a decimal string — a FILETIME (100ns ticks since 1601)
 * which can exceed 2^53 and must never pass through Number. Accepts a bare
 * integer, a {type:"long"} wrapper, or a bare decimal string; null for a
 * genuinely absent/null field (an idle timer's null expiry).
 */
function exactInt(value: JsonValue | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const long = unwrapLong(value);
  if (long !== null) {
    return long.toString();
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return value;
  }
  return null;
}

/**
 * A positive game id as a Number when it is a safe integer, else its exact decimal
 * string (R7d — data, never coerced into a label, never truncated). null when
 * absent/unparseable.
 */
function idData(value: JsonValue | undefined): number | string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const long = unwrapLong(value);
  if (long !== null) {
    return long <= BigInt(Number.MAX_SAFE_INTEGER) && long >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(long)
      : long.toString();
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return value;
  }
  return null;
}

/** A small structural integer (a state/safety code) as a Number, else fallback. */
function smallInt(value: JsonValue | undefined, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

/**
 * A security-status FLOAT (−10.0..+5.0). A sec status is a measurement, not an id,
 * so Number is correct (R7d applies to ids). null when absent/non-finite.
 */
function floatOrNull(value: JsonValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const long = unwrapLong(value);
  if (long !== null) {
    return Number(long);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// --- GetClientStates --------------------------------------------------------

/** One crimewatch combat timer: a state code + optional expiry. */
export interface CrimewatchTimer {
  /** The crimewatch state code; an ACTIVE timer's code is the idle code + 2. */
  readonly state: number;
  /** ⚠ EXACT FILETIME decimal string when active, or null when idle. */
  readonly expiry: string | null;
}

/** A flagged-character Python set (criminals or suspects); charIDs kept as data. */
export interface CrimewatchFlaggedSet {
  readonly members: readonly (number | string)[];
}

export interface CrimewatchClientStates {
  readonly timers: readonly CrimewatchTimer[];
  readonly engagements: readonly { readonly characterID: number | string; readonly expiry: string }[];
  readonly criminals: CrimewatchFlaggedSet;
  readonly suspects: CrimewatchFlaggedSet;
  /** The client-safety level (0 none / 1 partial / 2 full), a bare int. */
  readonly safetyLevel: number;
}

/** Extract the members of a __builtin__.set objectex1 (from header[1][0].items). */
function decodeFlaggedSet(value: JsonValue | undefined): CrimewatchFlaggedSet {
  const obj = asObject(value);
  if (obj.type !== "objectex1") {
    return { members: [] };
  }
  const header = asArray(obj.header);
  // header[0] is the {token:"__builtin__.set"}; header[1] is the args array
  // [buildList(members)]; the members list is its first entry.
  const args = asArray(header[1]);
  const membersList = args[0];
  if (!isListValue(membersList)) {
    return { members: [] };
  }
  const members: (number | string)[] = [];
  for (const item of membersList.items) {
    const id = idData(item as JsonValue);
    if (id !== null) {
      members.push(id);
    }
  }
  return { members };
}

/** The pilots a crimewatch notice names (OnSystemDisapprovalFlagUpdates' newIdles / newNaughty): a list, or a set. */
export function crimewatchCharacterIDs(value: JsonValue | undefined): number[] {
  const items = Array.isArray(value) ? value : isListValue(value) ? value.items : decodeFlaggedSet(value).members;
  return items.map((item) => Number(idData(item as JsonValue))).filter((id) => Number.isSafeInteger(id) && id > 0);
}

/** Decode one combat-timer tuple [stateCode, expiry]. */
function decodeTimer(tuple: JsonValue): CrimewatchTimer {
  const cells = asArray(tuple);
  return {
    state: smallInt(cells[0], 0),
    expiry: exactInt(cells[1]),
  };
}

/** Decode GetClientStates — timers, engagements, flags and safety. */
export function decodeClientStates(result: JsonValue | undefined): CrimewatchClientStates {
  const tuple = asArray(result);
  const timers = asArray(tuple[0]).map(decodeTimer);
  const flagged = asArray(tuple[2]);
  return {
    timers,
    engagements: asArray(asObject(tuple[1]).entries).flatMap(value => {
      const pair = asArray(value), characterID = idData(pair[0]), expiry = exactInt(pair[1]);
      return characterID === null || expiry === null ? [] : [{ characterID, expiry }];
    }),
    criminals: decodeFlaggedSet(flagged[0]),
    suspects: decodeFlaggedSet(flagged[1]),
    safetyLevel: smallInt(tuple[3], 0),
  };
}

// --- GetMySecurityStatus / GetCharacterSecurityStatus -----------------------

/** Decode a bare security-status float; null when absent. */
export function decodeSecurityStatus(result: JsonValue | undefined): number | null {
  return floatOrNull(result);
}

// --- GetSecurityStatusTransactions ------------------------------------------
//
// The server returns buildList([]) unconditionally — no sec-change history is
// persisted, so the real wire is an EMPTY list for every character. This decoder
// reads the list items faithfully (empty in every live capture) rather than
// fabricating a populated row schema that never appears on this wire; a future UI
// decodes row fields once the handler actually emits rows.

/** Decode GetSecurityStatusTransactions — the (empty) sec-change history list. */
export function decodeSecurityStatusTransactions(
  result: JsonValue | undefined,
): readonly JsonValue[] {
  return isListValue(result) ? [...result.items] : [];
}

// --- The whole GET /api/bridge/bound-crimewatch envelope --------------------
//
// The BFF issues all 4 reads independently (Promise.allSettled) and returns each
// as `{result}` on success or `{error: <code>}` on failure — a clean criminal
// state (idle timers, no flagged chars, safety full) and an empty transaction
// history are legitimate states, not a blanking failure. This decoder folds that
// envelope into typed data, carrying each read's error through as a string.

export interface BoundCrimewatchResult<T> {
  readonly value: T;
  /** The failure code when the read did not succeed, else null. */
  readonly error: string | null;
}

export interface BoundCrimewatch {
  readonly clientStates: BoundCrimewatchResult<CrimewatchClientStates>;
  readonly mySecurityStatus: BoundCrimewatchResult<number | null>;
  readonly characterSecurityStatus: BoundCrimewatchResult<number | null>;
  readonly securityStatusTransactions: BoundCrimewatchResult<readonly JsonValue[]>;
}

function pick(
  reads: Record<string, JsonValue>,
  key: string,
): { result: JsonValue | undefined; error: string | null } {
  const cell = asObject(reads[key]);
  const error = typeof cell.error === "string" && cell.error.length > 0 ? cell.error : null;
  return { result: cell.result, error };
}

/** Decode the /api/bridge/bound-crimewatch envelope. */
export function decodeBoundCrimewatch(raw: JsonValue | null | undefined): BoundCrimewatch {
  const reads = asObject(asObject(raw).reads);
  const map = <T>(key: string, decode: (r: JsonValue | undefined) => T): BoundCrimewatchResult<T> => {
    const { result, error } = pick(reads, key);
    return { value: decode(result), error };
  };
  return {
    clientStates: map("GetClientStates", decodeClientStates),
    mySecurityStatus: map("GetMySecurityStatus", decodeSecurityStatus),
    characterSecurityStatus: map("GetCharacterSecurityStatus", decodeSecurityStatus),
    securityStatusTransactions: map("GetSecurityStatusTransactions", decodeSecurityStatusTransactions),
  };
}
