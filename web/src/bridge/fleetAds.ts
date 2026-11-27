// Fleet-finder (fleetProxy) advert reads decoded to plain rows (goal R69, PLUMBING
// ONLY — no UI).
//
// GET /api/bridge/fleet-ads bundles the two fleetProxy read set. Built from bytes
// captured LIVE from Farmer (char 140000005) on 2026-07-22 and cross-checked against
// the server builders (eve.js .../services/fleets/fleetPayloads.js buildAdvertMapPayload /
// buildAdvertPayload / buildLeaderPayload). Farmer is not in a fleet, so live
// GetAvailableFleetAds is an empty dict and GetMyFleetFinderAdvert is null — real states.
// The POPULATED fixtures in the test mirror buildAdvertPayload exactly (bare dict body,
// util.KeyVal leader, __builtin__.set entity sets, long advertTime/dateCreated).
//
// OWNERSHIP-SAFETY (R63): GetAvailableFleetAds is the fleet-finder listing but
// session-FILTERED server-side (isAdvertOpenToSession), so a caller sees only ads open
// to them. GetMyFleetFinderAdvert — DESPITE the "My" prefix — derives its fleet purely
// from getSessionCharacterID(session) with no caller id, returning ONLY the session's own
// fleet advert (null when not in a fleet). Verified null for a docked session live.
//
// R7d: every id (fleetID / leader charID / corpID / allianceID / warFactionID /
// solarSystemID / allowed+disallowed entity ids) stays numeric. FILETIMEs (advertTime /
// dateCreated) are bigint-safe.

import {
  isListValue,
  readDictEntry,
  readDictPairs,
  readKeyVal,
  unwrapLong,
  type JsonValue,
} from "./wire.ts";

// --- shared field coercions -------------------------------------------------

function toNumber(value: JsonValue | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  const long = unwrapLong(value);
  return long !== null ? Number(long) : 0;
}

function toOptionalID(value: JsonValue | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const id = toNumber(value);
  return id > 0 ? id : null;
}

/** A number that preserves the absent/null distinction (null stays null, not 0). */
function toNullableNumber(value: JsonValue | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return toNumber(value);
}

function toFiletime(value: JsonValue | undefined): bigint | null {
  const long =
    typeof value === "string" && /^-?\d+$/.test(value) ? BigInt(value) : unwrapLong(value);
  return long !== null && long > 0n ? long : null;
}

function toBool(value: JsonValue | undefined): boolean {
  return value === true || toNumber(value) === 1;
}

/**
 * Text as the wire has it. EveJS answers a name as a plain string; Tranquility answers a name and a description
 * as unicode, which is a wire string ({type:"wstring", value}). What is neither is no text: a number is written
 * out, and anything else is nothing (never "[object Object]").
 */
function toText(value: JsonValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    const wide = value as { type?: unknown; value?: unknown };
    return wide.type === "wstring" && typeof wide.value === "string" ? wide.value : "";
  }
  return typeof value === "number" ? String(value) : "";
}

/**
 * Read a buildPythonSet payload -> a number[] of its members. The wire is
 * `{type:"objectex1", header:[{type:"token", value:"__builtin__.set"},
 * [{type:"list", items:[id, ...]}]], ...}`; the id list is header[1][0]. `[]` for
 * anything else (including an absent set).
 */
function readPythonSet(value: JsonValue | undefined): number[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const candidate = value as { type?: unknown; header?: unknown };
  if (candidate.type !== "objectex1" || !Array.isArray(candidate.header)) {
    return [];
  }
  const args = candidate.header[1];
  const inner = Array.isArray(args) ? (args[0] as JsonValue) : null;
  if (!isListValue(inner)) {
    return [];
  }
  const ids: number[] = [];
  for (const item of inner.items) {
    const id = toNumber(item);
    if (id > 0) {
      ids.push(id);
    }
  }
  return ids;
}

// --- advert decode ----------------------------------------------------------

export interface FleetAdvertLeader {
  readonly charID: number | null;
  readonly corpID: number | null;
  readonly allianceID: number | null;
  readonly warFactionID: number | null;
  readonly securityStatus: number;
}

export interface FleetAdvert {
  readonly fleetID: number | null;
  readonly leader: FleetAdvertLeader;
  readonly solarSystemID: number | null;
  readonly numMembers: number;
  readonly advertTime: bigint | null;
  readonly dateCreated: bigint | null;
  readonly fleetName: string;
  readonly description: string;
  readonly inviteScope: number;
  readonly activityValue: number | null;
  readonly useAdvanceOptions: boolean;
  readonly newPlayerFriendly: boolean;
  readonly public_minStanding: number | null;
  readonly public_minSecurity: number | null;
  readonly public_allowedEntities: readonly number[];
  readonly public_disallowedEntities: readonly number[];
  readonly membergroups_minStanding: number | null;
  readonly membergroups_minSecurity: number | null;
  readonly membergroups_allowedEntities: readonly number[];
  readonly membergroups_disallowedEntities: readonly number[];
  readonly joinNeedsApproval: boolean;
  readonly hideInfo: boolean;
  readonly updateOnBossChange: boolean;
  readonly advertJoinLimit: number | null;
}

export function fleetAdvertUrl(fleetID: number): string {
  return `fleet:${fleetID}`;
}

export function parseFleetAdvertUrl(url: string): number | null {
  const id = /^fleet:([1-9]\d*)$/i.exec(url)?.[1];
  const fleetID = Number(id);
  return Number.isSafeInteger(fleetID) ? fleetID : null;
}

/** The leader is a util.KeyVal nested inside the advert's bare dict. */
function decodeLeader(value: JsonValue | undefined): FleetAdvertLeader {
  return {
    charID: toOptionalID(readKeyVal(value, "charID")),
    corpID: toOptionalID(readKeyVal(value, "corpID")),
    allianceID: toOptionalID(readKeyVal(value, "allianceID")),
    warFactionID: toOptionalID(readKeyVal(value, "warFactionID")),
    securityStatus: toNumber(readKeyVal(value, "securityStatus")),
  };
}

/**
 * Decode one advert (buildAdvertPayload) -> a plain FleetAdvert. The body is a BARE
 * marshaled dict; `leader` is a util.KeyVal and the four entity sets are __builtin__.set
 * payloads. null for a non-dict input (the server's null "no advert" answer).
 */
function decodeAdvert(value: JsonValue | undefined | null): FleetAdvert | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  if ((value as { type?: unknown }).type !== "dict") {
    return null;
  }
  return {
    fleetID: toOptionalID(readDictEntry(value, "fleetID")),
    leader: decodeLeader(readDictEntry(value, "leader")),
    solarSystemID: toOptionalID(readDictEntry(value, "solarSystemID")),
    numMembers: toNumber(readDictEntry(value, "numMembers")),
    advertTime: toFiletime(readDictEntry(value, "advertTime")),
    dateCreated: toFiletime(readDictEntry(value, "dateCreated")),
    fleetName: toText(readDictEntry(value, "fleetName")),
    description: toText(readDictEntry(value, "description")),
    inviteScope: toNumber(readDictEntry(value, "inviteScope")),
    activityValue: toNullableNumber(readDictEntry(value, "activityValue")),
    useAdvanceOptions: toBool(readDictEntry(value, "useAdvanceOptions")),
    newPlayerFriendly: toBool(readDictEntry(value, "newPlayerFriendly")),
    public_minStanding: toNullableNumber(readDictEntry(value, "public_minStanding")),
    public_minSecurity: toNullableNumber(readDictEntry(value, "public_minSecurity")),
    public_allowedEntities: readPythonSet(readDictEntry(value, "public_allowedEntities")),
    public_disallowedEntities: readPythonSet(readDictEntry(value, "public_disallowedEntities")),
    membergroups_minStanding: toNullableNumber(readDictEntry(value, "membergroups_minStanding")),
    membergroups_minSecurity: toNullableNumber(readDictEntry(value, "membergroups_minSecurity")),
    membergroups_allowedEntities: readPythonSet(readDictEntry(value, "membergroups_allowedEntities")),
    membergroups_disallowedEntities: readPythonSet(
      readDictEntry(value, "membergroups_disallowedEntities"),
    ),
    joinNeedsApproval: toBool(readDictEntry(value, "joinNeedsApproval")),
    hideInfo: toBool(readDictEntry(value, "hideInfo")),
    updateOnBossChange: toBool(readDictEntry(value, "updateOnBossChange")),
    advertJoinLimit: toNullableNumber(readDictEntry(value, "advertJoinLimit")),
  };
}

// --- GetAvailableFleetAds ---------------------------------------------------

/**
 * Decode GetAvailableFleetAds -> the session-visible fleet-finder listing. The wire is a
 * bare dict keyed by fleetID -> advert (buildAdvertMapPayload). `[]` when no open ads —
 * a real state.
 */
export function decodeAvailableFleetAds(result: JsonValue | null | undefined): FleetAdvert[] {
  const ads: FleetAdvert[] = [];
  for (const [, advertValue] of readDictPairs(result)) {
    const advert = decodeAdvert(advertValue);
    if (advert) {
      ads.push(advert);
    }
  }
  return ads;
}

// --- GetMyFleetFinderAdvert -------------------------------------------------

/**
 * Decode GetMyFleetFinderAdvert -> the SESSION's own fleet advert, or null when the
 * character is not in a fleet / the fleet has no registered advert (the real state for a
 * docked character). See ownership note: this is only ever the session's own advert.
 */
export function decodeMyFleetFinderAdvert(result: JsonValue | null | undefined): FleetAdvert | null {
  return decodeAdvert(result ?? null);
}
