// R56 — decoding the retail CHARACTER SHEET reads (top-level charMgr).
//
// The four shapes below were captured from LIVE bytes (Farmer, read through the
// BFF), not assumed — the orchestrator's briefs have guessed char-sheet shapes
// wrong before, so every one here is pinned against a real read:
//
//   GetPublicInfo           -> a util.KeyVal of Tranquility's seventeen fields
//                              (characterID, characterName, corporationID,
//                              allianceID|null, ...): the retail client's cached
//                              answer of 2026-07-03. No security status among them:
//                              the sheet asks crimewatch.GetMySecurityStatus for it,
//                              a bare float (characterOverviewPanel 153). A list
//                              wrapping the KeyVal is read too.
//   GetCharacterDescription -> a BARE JS STRING (the bio). No marshaled wrapper,
//                              no ids — the simplest read on the bridge.
//   GetHomeStation          -> a SINGLE util.KeyVal (not a list) carrying the home
//                              stationID plus a redundant name/type/system set.
//                              Only the stationID is decoded; the NAME comes from
//                              /api/names (R7d), never the redundant string here.
//   GetCloneInfo            -> a SINGLE util.KeyVal{homeStationID, cloneStationID,
//                              clones(dict), implants(dict), timeLastJump(long)}.
//                              `clones`/`implants` are {type:"dict", entries:[[key,
//                              util.KeyVal], ...]} and are EMPTY for a clean clone
//                              (Farmer, measured live, has neither) — a real
//                              answer the page renders honestly, not a failure.
//
// R7d is the crux. Only ids that can resolve to a NAME are carried out of here;
// the rest are omitted rather than rendered raw:
//   • corporationID / allianceID / home stationID / implant typeIDs are kept and
//     name-resolved by the page. An id static data cannot name (a PLAYER
//     corporation — Farmer's own 98000001 resolves to null) degrades to
//     "Unknown …", NEVER the number.
//   • securityStatus is a FLOAT, not an id — shown as-is.
//   • bloodlineID / raceID / ancestryID are in the GetPublicInfo3 bytes but have
//     NO name path (no /api/names kind, no staticData resolver), so they are
//     DELIBERATELY NOT DECODED. A number with nowhere to resolve is exactly what
//     R7d forbids on screen.

import {
  isKeyValValue,
  isListValue,
  readKeyVal,
  unwrapBool,
  unwrapLong,
  type JsonValue,
} from "./wire.ts";
import type {
  CharacterIdentity,
  CharacterImplant,
  CloneSummary,
} from "../store/types.ts";

/** An integer field, tolerant of a {type:"long"} wrapper or a bare digit string. */
function toInt(value: JsonValue | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  const long = unwrapLong(value);
  if (long !== null) {
    return Number(long);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return 0;
}

/** A signed float (security status), tolerant of a decimal string. 0 when absent. */
function toFloat(value: JsonValue | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return 0;
}

function toStringOrEmpty(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

/**
 * The one util.KeyVal row inside a GetPublicInfo3 result. The retail shape wraps
 * the KeyVal in a list; `items[0]` is the row. A bare KeyVal is tolerated too, so
 * a handler tweak that stops wrapping (GetPublicInfo, the non-"3" sibling, returns
 * one directly) would not silently blank the panel. null for any other shape.
 */
function publicInfoRow(result: JsonValue | null | undefined): JsonValue | null {
  if (isListValue(result)) {
    const first = result.items[0];
    return first === undefined ? null : first;
  }
  if (isKeyValValue(result)) {
    return result;
  }
  return null;
}

/**
 * Decode charMgr.GetPublicInfo -> the character's PUBLIC identity, with its security status from its own read
 * (crimewatch.GetMySecurityStatus), the row having none. Only the name-resolvable ids and the plain security float
 * are carried out; bloodline / race / ancestry are deliberately dropped (no name path — R7d). null when the read
 * did not produce the KeyVal row (a shape we did not get / a failed read).
 */
export function decodeCharacterIdentity(
  result: JsonValue | null | undefined,
  securityStatus: JsonValue | null | undefined = null,
): CharacterIdentity | null {
  const row = publicInfoRow(result);
  if (row === null) {
    return null;
  }
  const characterID = toInt(readKeyVal(row, "characterID"));
  const characterName = toStringOrEmpty(readKeyVal(row, "characterName"));
  // A row that carries neither an id nor a name is not a public-info row.
  if (characterID <= 0 && characterName === "") {
    return null;
  }
  const allianceID = toInt(readKeyVal(row, "allianceID"));
  return {
    characterID,
    characterName,
    corporationID: toInt(readKeyVal(row, "corporationID")),
    // 0 (or absent) means no alliance; carried as null so the page omits the row.
    allianceID: allianceID > 0 ? allianceID : null,
    securityStatus: toFloat(securityStatus ?? undefined),
  };
}

/**
 * Decode charMgr.GetCharacterDescription -> the bio. A bare string on the wire.
 * "" is a REAL empty bio (a character who wrote none); null means the value was
 * not a string (an absent / failed read), which the flow's error handling covers.
 */
export function decodeCharacterDescription(
  result: JsonValue | null | undefined,
): string | null {
  return typeof result === "string" ? result : null;
}

/**
 * Decode charMgr.GetHomeStation -> the home station's id (the medical-clone home).
 * Only the id: the NAME is resolved through /api/names (R7d), so the redundant
 * `stationName` in the payload is never trusted onto the screen. null when the
 * KeyVal is absent or carries no station.
 */
export function decodeHomeStationID(
  result: JsonValue | null | undefined,
): number | null {
  // homestation.types.StationData, as the home station service answers: the station is its `id`.
  const station = stationData(result);
  if (station !== null) {
    const id = toInt(station.get("id"));
    return id > 0 ? id : null;
  }
  if (!isKeyValValue(result)) {
    return null;
  }
  const stationID = toInt(readKeyVal(result, "stationID"));
  return stationID > 0 ? stationID : null;
}

/**
 * A homestation.types.StationData as the generic call hands it on: an object of that class whose own fields are
 * `id`, `type_id`, `solar_system_id` and `is_fallback`. Its fields by name, or null for what is none.
 */
function stationData(result: JsonValue | null | undefined, className = "homestation.types.StationData"): ReadonlyMap<JsonValue, JsonValue> | null {
  if (typeof result !== "object" || result === null || Array.isArray(result) || (result as { type?: unknown }).type !== "objectex2") {
    return null;
  }
  // Its header is ((the class), the fields).
  const header = (result as { header?: unknown }).header;
  const named = Array.isArray(header) ? (header[0] as readonly ({ value?: unknown } | null)[] | undefined)?.[0] : undefined;
  if (named?.value !== className) {
    return null;
  }
  return new Map(dictEntries((header as JsonValue[])[1]));
}

export interface HomeStationCandidate {
  readonly id: number;
  readonly isCurrent: boolean;
  readonly isSchool: boolean;
  readonly errors: readonly number[];
}

export function decodeHomeStationCandidates(result: JsonValue): readonly HomeStationCandidate[] {
  const rows = isListValue(result) ? result.items : result;
  if (!Array.isArray(rows)) throw new Error("Home station choices could not be read.");
  return rows.map(row => {
    const data = stationData(row, "homestation.types.StationCandidateData");
    const id = toInt(data?.get("id"));
    const isCurrent = unwrapBool(data?.get("is_current_station"));
    const isSchool = unwrapBool(data?.get("is_school_hq"));
    const errors = data?.get("errors");
    if (!Number.isSafeInteger(id) || id <= 0 || isCurrent === null || isSchool === null || !isListValue(errors)) {
      throw new Error("A home station choice could not be read.");
    }
    return { id, isCurrent, isSchool, errors: errors.items.map(toInt) };
  });
}

/** The `[key, value]` pairs of a marshaled `{type:"dict", entries:[...]}`. */
function dictEntries(
  value: JsonValue | undefined,
): readonly (readonly [JsonValue, JsonValue])[] {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { type?: unknown }).type !== "dict"
  ) {
    return [];
  }
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.filter(
    (entry): entry is readonly [JsonValue, JsonValue] =>
      Array.isArray(entry) && entry.length >= 2,
  );
}

/**
 * Decode the `implants` dict of GetCloneInfo -> one row per implant. Each dict
 * VALUE is a util.KeyVal{typeID, name, slot}; the typeID is kept for name
 * resolution (R7d) and `name` in the bytes is ignored (the server sends "").
 * Sorted by slot so the same clone reads the same way twice running.
 */
function decodeImplants(
  value: JsonValue | undefined,
): readonly CharacterImplant[] {
  const rows: CharacterImplant[] = [];
  for (const [, entryValue] of dictEntries(value)) {
    const typeID = toInt(readKeyVal(entryValue, "typeID"));
    if (typeID <= 0) {
      continue;
    }
    rows.push({ typeID, slot: toInt(readKeyVal(entryValue, "slot")) });
  }
  return rows.sort((left, right) => left.slot - right.slot || left.typeID - right.typeID);
}

/**
 * Decode charMgr.GetCloneInfo -> the active clone's implants + the jump-clone
 * count. An empty implants dict is a real "clean clone" (Farmer live), not a
 * failure. null when the KeyVal is absent (a failed read; the flow carries the
 * reason).
 */
/** Whether an answer carries a field at all: the implants alone, as the client's own sheet reads them, carry no other. */
const said = (result: JsonValue, name: string): boolean => readKeyVal(result, name) !== undefined;

export function decodeCloneSummary(
  result: JsonValue | null | undefined,
): CloneSummary | null {
  if (!isKeyValValue(result)) {
    return null;
  }
  return {
    homeStationID: said(result, "homeStationID") ? toInt(readKeyVal(result, "homeStationID")) : null,
    cloneStationID: said(result, "cloneStationID") ? toInt(readKeyVal(result, "cloneStationID")) : null,
    implants: decodeImplants(readKeyVal(result, "implants")),
    jumpCloneCount: said(result, "clones") ? dictEntries(readKeyVal(result, "clones")).length : null,
  };
}

/** The signed security status to two decimals, e.g. "+0.14" / "−1.30" / "0.00". */
export function formatSecurityStatus(status: number): string {
  const rounded = Math.round(status * 100) / 100;
  if (rounded > 0) {
    return `+${rounded.toFixed(2)}`;
  }
  if (rounded < 0) {
    // A real minus sign, not a hyphen.
    return `−${Math.abs(rounded).toFixed(2)}`;
  }
  return "0.00";
}
