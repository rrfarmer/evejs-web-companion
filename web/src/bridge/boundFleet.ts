// R85 — the 5 RB-FLEET BOUND reads (init-state/roster, wings, MOTD, join-requests,
// composition), the LAST Phase-2 bound-read batch — CLOSES Phase-2 bound reads
// (111/111). PLUMBING ONLY — no UI, no writes.
//
// These are the raw retail fleetObjectHandler reads addressed on the fleet bound
// Moniker (fleetObjectHandler.MachoBindObject, R72): the BFF binds it session-scoped
// (NO fleetID arg → the session's OWN fleet) and dispatches each read as a bound
// method (GET /api/bridge/bound-fleet). Each handler resolves the fleetID from the
// bound context via _resolveFleetIDFromSession.
//
// ⚠ OWNERSHIP: ALL FIVE reads are FLAGGED arg-injection leaks (the R72 fleet addendum
// in docs/arg-injection-leak-handoff.md). fleetObjectHandler.MachoBindObject is
// BINDS-ARBITRARY-OID — the bind takes bindParams[0] as the fleetID with NO membership
// check — and none of fleetRuntime.getFleetState / getWings / getMotd /
// getJoinRequests / getFleetComposition calls ensureFleetMembership (that gate guards
// only the fleet WRITES). So a browser POSTing /api/bridge/call {service:
// "fleetObjectHandler", method:"MachoBindObject", args:[[<rival fleetID>]]} mints a
// handle bound to a foreign fleet, and the bound read off it returns that fleet's
// roster / wings / MOTD / join-requests / composition. The BFF's dedicated route binds
// the session's own fleet, so THIS route never leaks; the leak is the /api/bridge/call
// verbatim-arg vector. Kept pre-plumbed (operator flag-only).
//
// ⚠ LIVE STATE (2026-07-22, rrfarmer → Farmer 140000005): Farmer is DOCKED and NOT in
// a fleet, so the session's fleetid is 0; ensureFleetExists(0) throws FleetNotFound and
// every read comes back as an ERROR envelope ({error:"CALL_REFUSED", message:
// "FleetNotFound"}) — the real "not in a fleet" state (captured live 2026-07-22). Populated bytes cannot be captured live (no fleet, no second fleet
// seeded), exactly as the R72 addendum notes for the foreign-fleetID leak. The fixtures
// below are therefore builder-mirrored: produced by running the REAL server payload
// builders (fleetPayloads.js buildFleetStatePayload / buildWingPayload /
// buildJoinRequestsPayload / buildCompositionPayload) against a realistic fleet record —
// genuine server bytes, not a hand-guessed shape.
//
// ---------------------------------------------------------------------------
// WIRE SHAPES (from the real fleetPayloads.js builders):
//
//  GetInitState(): util.KeyVal{motd(str), options(util.KeyVal{isFreeMove,isRegistered,
//    autoJoinSquadID(id|null)}), fleetID(id), members(dict{charID -> member KeyVal}),
//    isLootLogging(bool), squads(dict{squadID -> squad KeyVal}), wings(dict{wingID ->
//    wing KeyVal})}. A member KeyVal (buildMemberPayload): {squadID, wingID, skills(list
//    of 3 levels), timestamp(BARE-STRING FILETIME), stationID(id|null), clientID(id|
//    null), job(int), role(int), shipTypeID(id|null), solarSystemID(id|null),
//    memberOptOuts(util.KeyVal{acceptsConduitJumps,acceptsFleetRegroups,acceptsFleetWarp
//    bools}), charID(id)}. A wing KeyVal: {wingID, name, squads(dict{squadID -> squad
//    KeyVal{squadID, name}})}.
//  GetWings(): a BARE dict {wingID -> wing KeyVal} (same wing shape as above), NOT a
//    util.KeyVal.
//  GetMotd(): a plain STRING.
//
// BESIDE THE RECORDING ("Join Fleet - Receive Boss - Set other as boss - leave fleet", the one with a fleet in it):
//  Tranquility's GetInitState has six names and NO top-level `squads`: that one is this server's own, the client
//  reads no such thing (fleetSvc.InitFleet, 254 to 264, takes fleetID, members, wings, options and motd), and
//  nothing of the page reads it either. A recorded squad carries its wing's ID beside its own and its name; this
//  server's does not, and nothing of the client's reads a squad's wing off the squad. A member's twelve names are
//  the same twelve, in the same order. The recorded names and message are all empty.
//  GetJoinRequests(): a BARE dict {charID -> join-request KeyVal{charID, corpID(id|null),
//    allianceID(id|null), warFactionID(id|null), securityStatus(double)}}.
//  GetFleetComposition(): a list of composition KeyVals {characterID(id), solarSystemID(
//    id|null), stationID(id|null), shipTypeID(id|null), skills(list), skillIDs(list)}.
//
// This module decodes the raw marshaled reads for GET /api/bridge/bound-fleet; NO UI
// consumes it yet. ids (fleet/wing/squad/char/type ids) stay DATA (R7d); the member
// timestamp FILETIME is bigint-safe (never truncated through Number). LOCAL coercions
// only — nothing is imported from market*.ts (a separate session owns those).

import { unwrapLong, type JsonValue } from "./wire.ts";

// --- local coercions (do NOT import from market*.ts — separate session) -----

function asObject(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

/**
 * An EXACT integer as a decimal string — a member FILETIME, which can exceed 2^53
 * and must never pass through Number. Accepts a bare integer, a {type:"long"}
 * wrapper, or a bare decimal string. `null` for a genuinely absent/null field.
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
 * string (R7d — data, never coerced into a label, never truncated). `null` when absent.
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
    const asBig = BigInt(value);
    return asBig <= BigInt(Number.MAX_SAFE_INTEGER) && asBig >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(asBig)
      : value;
  }
  return null;
}

/** A small structural integer (a job/role/skill level) as a Number, else fallback. */
function smallInt(value: JsonValue | undefined, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

/** A double (security status), else fallback. */
function asReal(value: JsonValue | undefined, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/** A boolean, defaulting to false when absent. */
function asBool(value: JsonValue | undefined): boolean {
  return value === true;
}

/**
 * Text as the wire has it: a plain string, as this server answers a fleet's names and its message, or a wire
 * string ({type:"wstring", value}), which is how Tranquility answers a text a pilot wrote where it is unicode.
 * "" when it is absent or neither.
 */
function asString(value: JsonValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  const wide = asObject(value);
  return wide.type === "wstring" && typeof wide.value === "string" ? wide.value : "";
}

/** The dict entries of a util.KeyVal / bare dict; [] when neither. */
function keyValEntries(value: JsonValue | undefined): readonly JsonValue[] {
  const obj = asObject(value);
  if (obj.type === "object") {
    const args = asObject(obj.args);
    if (args.type === "dict" && Array.isArray(args.entries)) {
      return args.entries as readonly JsonValue[];
    }
  }
  if (obj.type === "dict" && Array.isArray(obj.entries)) {
    return obj.entries as readonly JsonValue[];
  }
  return [];
}

/** One key from a util.KeyVal / bare dict; undefined when absent. */
function keyValField(value: JsonValue | undefined, key: string): JsonValue | undefined {
  const entry = keyValEntries(value).find(
    (row) => Array.isArray(row) && (row as readonly JsonValue[])[0] === key,
  );
  return Array.isArray(entry) ? (entry as readonly JsonValue[])[1] : undefined;
}

/** The [key, value] pairs of a marshaled dict ({type:"dict", entries:[…]}); [] when not. */
function dictPairs(value: JsonValue | undefined): readonly (readonly JsonValue[])[] {
  const obj = asObject(value);
  if (obj.type === "dict" && Array.isArray(obj.entries)) {
    return (obj.entries as readonly JsonValue[]).filter(
      (row): row is readonly JsonValue[] => Array.isArray(row),
    );
  }
  return [];
}

/** The items of a marshaled list ({type:"list", items:[…]}); [] when not a list. */
function listItems(value: JsonValue | undefined): readonly JsonValue[] {
  const obj = asObject(value);
  return obj.type === "list" && Array.isArray(obj.items)
    ? (obj.items as readonly JsonValue[])
    : [];
}

/** A list of small ints (skill levels). */
function smallIntList(value: JsonValue | undefined): readonly number[] {
  return listItems(value).map((v) => smallInt(v));
}

/** A list of ids kept as data (R7d) — skillIDs. */
function idDataList(value: JsonValue | undefined): readonly (number | string | null)[] {
  return listItems(value).map((v) => idData(v));
}

// --- shared decoders --------------------------------------------------------

export interface FleetMemberOptOuts {
  readonly acceptsConduitJumps: boolean;
  readonly acceptsFleetRegroups: boolean;
  readonly acceptsFleetWarp: boolean;
}

export interface FleetMember {
  readonly charID: number | string | null;
  readonly squadID: number | string | null;
  readonly wingID: number | string | null;
  readonly skills: readonly number[];
  /** ⚠ EXACT FILETIME decimal string (100ns ticks since 1601), or null. */
  readonly timestamp: string | null;
  readonly stationID: number | string | null;
  readonly clientID: number | string | null;
  readonly job: number;
  readonly role: number;
  readonly shipTypeID: number | string | null;
  readonly solarSystemID: number | string | null;
  readonly memberOptOuts: FleetMemberOptOuts;
}

function decodeMemberOptOuts(value: JsonValue | undefined): FleetMemberOptOuts {
  return {
    acceptsConduitJumps: asBool(keyValField(value, "acceptsConduitJumps")),
    acceptsFleetRegroups: asBool(keyValField(value, "acceptsFleetRegroups")),
    acceptsFleetWarp: asBool(keyValField(value, "acceptsFleetWarp")),
  };
}

function decodeMember(value: JsonValue | undefined): FleetMember {
  return {
    charID: idData(keyValField(value, "charID")),
    squadID: idData(keyValField(value, "squadID")),
    wingID: idData(keyValField(value, "wingID")),
    skills: smallIntList(keyValField(value, "skills")),
    timestamp: exactInt(keyValField(value, "timestamp")),
    stationID: idData(keyValField(value, "stationID")),
    clientID: idData(keyValField(value, "clientID")),
    job: smallInt(keyValField(value, "job")),
    role: smallInt(keyValField(value, "role")),
    shipTypeID: idData(keyValField(value, "shipTypeID")),
    solarSystemID: idData(keyValField(value, "solarSystemID")),
    memberOptOuts: decodeMemberOptOuts(keyValField(value, "memberOptOuts")),
  };
}

export interface FleetSquad {
  readonly squadID: number | string | null;
  readonly name: string;
}

function decodeSquad(value: JsonValue | undefined): FleetSquad {
  return {
    squadID: idData(keyValField(value, "squadID")),
    name: asString(keyValField(value, "name")),
  };
}

export interface FleetWing {
  readonly wingID: number | string | null;
  readonly name: string;
  readonly squads: readonly FleetSquad[];
}

function decodeWing(value: JsonValue | undefined): FleetWing {
  return {
    wingID: idData(keyValField(value, "wingID")),
    name: asString(keyValField(value, "name")),
    squads: dictPairs(keyValField(value, "squads")).map((pair) => decodeSquad(pair[1])),
  };
}

// --- GetInitState -----------------------------------------------------------

export interface FleetOptions {
  readonly isFreeMove: boolean;
  readonly isRegistered: boolean;
  readonly autoJoinSquadID: number | string | null;
}

function decodeOptions(value: JsonValue | undefined): FleetOptions {
  return {
    isFreeMove: asBool(keyValField(value, "isFreeMove")),
    isRegistered: asBool(keyValField(value, "isRegistered")),
    autoJoinSquadID: idData(keyValField(value, "autoJoinSquadID")),
  };
}

export interface FleetInitState {
  readonly motd: string;
  readonly options: FleetOptions;
  readonly fleetID: number | string | null;
  readonly members: readonly FleetMember[];
  readonly isLootLogging: boolean;
  readonly squads: readonly FleetSquad[];
  readonly wings: readonly FleetWing[];
}

/** Decode GetInitState — the full fleet roster/state KeyVal. */
export function decodeFleetInitState(result: JsonValue | undefined): FleetInitState {
  return {
    motd: asString(keyValField(result, "motd")),
    options: decodeOptions(keyValField(result, "options")),
    fleetID: idData(keyValField(result, "fleetID")),
    members: dictPairs(keyValField(result, "members")).map((pair) => decodeMember(pair[1])),
    isLootLogging: asBool(keyValField(result, "isLootLogging")),
    squads: dictPairs(keyValField(result, "squads")).map((pair) => decodeSquad(pair[1])),
    wings: dictPairs(keyValField(result, "wings")).map((pair) => decodeWing(pair[1])),
  };
}

// --- GetWings ---------------------------------------------------------------

/** Decode GetWings — a bare dict {wingID -> wing KeyVal} into a wing list. */
export function decodeFleetWings(result: JsonValue | undefined): readonly FleetWing[] {
  return dictPairs(result).map((pair) => decodeWing(pair[1]));
}

// --- GetMotd ----------------------------------------------------------------

/** Decode GetMotd — the plain MOTD string ("" when absent). */
export function decodeFleetMotd(result: JsonValue | undefined): string {
  return asString(result);
}

// --- GetJoinRequests --------------------------------------------------------

export interface FleetJoinRequest {
  readonly charID: number | string | null;
  readonly corpID: number | string | null;
  readonly allianceID: number | string | null;
  readonly warFactionID: number | string | null;
  readonly securityStatus: number;
}

export function decodeJoinRequest(value: JsonValue | undefined): FleetJoinRequest {
  return {
    charID: idData(keyValField(value, "charID")),
    corpID: idData(keyValField(value, "corpID")),
    allianceID: idData(keyValField(value, "allianceID")),
    warFactionID: idData(keyValField(value, "warFactionID")),
    securityStatus: asReal(keyValField(value, "securityStatus")),
  };
}

/** Decode GetJoinRequests — a bare dict {charID -> join-request KeyVal} into a list. */
export function decodeFleetJoinRequests(
  result: JsonValue | undefined,
): readonly FleetJoinRequest[] {
  return dictPairs(result).map((pair) => decodeJoinRequest(pair[1]));
}

// --- GetFleetComposition ----------------------------------------------------

export interface FleetCompositionEntry {
  readonly characterID: number | string | null;
  readonly solarSystemID: number | string | null;
  readonly stationID: number | string | null;
  readonly shipTypeID: number | string | null;
  readonly skills: readonly number[];
  readonly skillIDs: readonly (number | string | null)[];
}

function decodeCompositionEntry(value: JsonValue | undefined): FleetCompositionEntry {
  return {
    characterID: idData(keyValField(value, "characterID")),
    solarSystemID: idData(keyValField(value, "solarSystemID")),
    stationID: idData(keyValField(value, "stationID")),
    shipTypeID: idData(keyValField(value, "shipTypeID")),
    skills: smallIntList(keyValField(value, "skills")),
    skillIDs: idDataList(keyValField(value, "skillIDs")),
  };
}

/** Decode GetFleetComposition — a list of per-member composition KeyVals. */
export function decodeFleetComposition(
  result: JsonValue | undefined,
): readonly FleetCompositionEntry[] {
  return listItems(result).map(decodeCompositionEntry);
}

// --- The whole GET /api/bridge/bound-fleet envelope -------------------------
//
// The BFF issues all 5 reads independently (Promise.allSettled) and returns each as
// `{result}` on success or `{error: <code>}` on failure. With no fleet (Farmer docked),
// every read is an ERROR envelope (ensureFleetExists(0) throws FleetNotFound) — a
// legitimate "not in a fleet" state, not a blanking failure. This decoder folds the
// envelope into typed data, carrying each read's error through as a string.

export interface BoundFleetResult<T> {
  readonly value: T;
  /** The failure code when the read did not succeed, else null. */
  readonly error: string | null;
  /** The handler's failure detail (for example FleetNotFound), else null. */
  readonly message: string | null;
}

export interface BoundFleet {
  readonly characterID: number | null;
  readonly fleetID: number | null;
  /**
   * The route's word that the pilot's own session has no fleet, where it knows the session's (the game port): then
   * nothing was asked of a fleet, as the client asks nothing. False where the route did not say.
   */
  readonly sessionHasNoFleet: boolean;
  readonly initState: BoundFleetResult<FleetInitState>;
  readonly wings: BoundFleetResult<readonly FleetWing[]>;
  readonly motd: BoundFleetResult<string>;
  readonly joinRequests: BoundFleetResult<readonly FleetJoinRequest[]>;
  readonly composition: BoundFleetResult<readonly FleetCompositionEntry[]>;
}

function pick(
  reads: Record<string, JsonValue>,
  key: string,
): { result: JsonValue | undefined; error: string | null; message: string | null } {
  const cell = asObject(reads[key]);
  const error = typeof cell.error === "string" && cell.error.length > 0 ? cell.error : null;
  const message =
    typeof cell.message === "string" && cell.message.length > 0 ? cell.message : null;
  return { result: cell.result, error, message };
}

function numberOrNull(value: JsonValue | undefined): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric !== 0 ? Math.trunc(numeric) : null;
}

/** Decode the /api/bridge/bound-fleet envelope. */
export function decodeBoundFleet(raw: JsonValue | null | undefined): BoundFleet {
  const root = asObject(raw);
  const reads = asObject(root.reads);
  const map = <T>(key: string, decode: (r: JsonValue | undefined) => T): BoundFleetResult<T> => {
    const { result, error, message } = pick(reads, key);
    return { value: decode(result), error, message };
  };
  const initState = map("GetInitState", decodeFleetInitState);
  return {
    characterID: numberOrNull(root.characterID),
    // ⚠ THE READ OUTRANKS THE CACHED FIELD. `root.fleetID` is the BFF's held-session
    // snapshot, taken when the character came online and never refreshed — so a fleet
    // formed or joined SINCE then reads as no fleet at all. That is how the
    // create-fleet block could not notice it had just succeeded: caught live, with
    // GetInitState answering fleetID 654500010000 while this field still said null.
    // GetInitState is the fleet answering for itself, so it wins; the cached field
    // stays as the fallback for when that read failed.
    fleetID: numberOrNull(initState.value.fleetID) ?? numberOrNull(root.fleetID),
    sessionHasNoFleet: root.membership === "none",
    initState,
    wings: map("GetWings", decodeFleetWings),
    motd: map("GetMotd", decodeFleetMotd),
    joinRequests: map("GetJoinRequests", decodeFleetJoinRequests),
    composition: map("GetFleetComposition", decodeFleetComposition),
  };
}
