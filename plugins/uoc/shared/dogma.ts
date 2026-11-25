// ItemGetInfo pure decoding from WC75 web/src/bridge/boundDogma.ts.
// Bound Dogma reads use the caller's held GamePort session. The BFF binds
// dogmaIM once and issues the same own-scoped queries over that handle.
// The decoder handles the following native wire shapes.
//
//  GetAllInfo: util.KeyVal{args:dict[
//     systemWideEffectsOnShip: dict (EMPTY docked),
//     shipModifiedCharAttribs: a GET-INFO ENTRY for the CHARACTER (itemID=charID,
//        invItem packedrow typeID 1386, attributes dict of 71) or null,
//     structureInfo: dict (EMPTY), locationInfo: dict (EMPTY),
//     shipInfo: dict[ itemID -> GET-INFO ENTRY ] (12: active ship + 11 fitted),
//     activeShipID: <shipID>,
//     shipState: [dict, dict, dict, dict] (activation state — passthrough),
//     charInfo: [ dict[ charID -> GET-INFO ENTRY ], charBrain ] ]}
//  A GET-INFO ENTRY is a util.KeyVal{itemID, invItem:PACKEDROW{fields:{itemID,
//     typeID, ownerID, locationID, flagID, quantity, groupID, categoryID,
//     customInfo, stacksize}}, activeEffects:dict, time:FILETIME-string,
//     attributes:dict[attributeID -> float], wallclockTime:FILETIME-string}.
//  ItemGetInfo(itemID): a single GET-INFO ENTRY ([] -> the own active ship).
//  GetTargeters: {type:"list", items:[itemID, …]} — who is locking YOU (EMPTY docked).
//  GetDroneSettingAttributes: dict[attributeID -> value] (bool or number;
//     [[1275,true],[1297,false]] live).
//  GetCharacterAttributes: dict[attributeID -> number] (20 entries).
//  GetRequiredSkillLevels(typeID): dict[skillTypeID -> requiredLevel] — STATIC
//     type metadata; typeID 0 -> EMPTY dict, type 597 -> [[3331,1]].
//  GetLayerDamageValuesByItems([itemIDs]): dict[itemID -> util.KeyVal{shieldInfo:
//     list[cur,max,recharge] (or a bare real when no shield), armorInfo, hullInfo,
//     armorDamage, hullDamage, shieldRatio, armorRatio, hullRatio, armorMax,
//     hullMax — all {type:"real"}}]. [[]] -> EMPTY dict.
//  QueryAllAttributesForItem(itemID): dict[attributeID -> float] ([] -> own ship,
//     471 entries).
//  QueryAttributeValue(itemID, attributeID): a BARE number ([0,4] -> own-ship
//     mass 25000000).
//  FullyDescribeAttribute(itemID, attributeID, reason): {type:"list", items:[
//     "Item ID:…", "Reason:…", "Server value:…", "Base value:…", …]} — debug strings.
//  GetLocationInfo: a BARE 3-tuple [ownerID(session userid), locationID, 0].
//
// ⚠ FILETIME (time/wallclockTime) exceeds 2^53 — kept as EXACT decimal strings.
// Attribute VALUES are doubles (measurements, not ids) — Number is correct for
// them; the ATTRIBUTE IDS and item/type/location IDs stay as data (R7d). Carry
// LOCAL coercions; do NOT import from web/src/bridge/market*.ts (separate session).

import {
  readKeyVal,
  readRowField,
  readDictPairs,
  isListValue,
  unwrapLong,
  type JsonValue,
} from "./wire.ts";

// --- local coercions (do NOT import from market*.ts — separate session) -----

function asObject(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

/**
 * A positive game id as a Number when it is a safe integer, else its exact
 * decimal string (R7d — data, never coerced into a label, never truncated).
 * `null` when absent.
 */
export function idData(value: JsonValue | undefined): number | string | null {
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

/**
 * An EXACT integer as a decimal string — FILETIMEs (100ns ticks since 1601),
 * which exceed 2^53 and must never pass through Number. Accepts a bare integer,
 * a {type:"long"} wrapper, or a bare decimal string. `null` otherwise.
 */
export function exactInt(value: JsonValue | undefined): string | null {
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

/** A GET-INFO entry's time (a FILETIME, exactInt's string) in milliseconds since 1970, to the tick; null without one. */
export function infoTimeMs(time: string | null): number | null {
  if (time === null || !/^\d+$/.test(time)) return null;
  return Number(BigInt(time) - 116444736000000000n) / 10000;
}

/**
 * A dogma attribute value / measurement as a JS number (a double server-side).
 * Unwraps a {type:"real"} or {type:"long"} wrapper, a bare number, or a numeric
 * string. `null` for anything else (including a genuinely absent field).
 */
export function asFloat(value: JsonValue | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null;
  }
  const obj = asObject(value);
  if (obj.type === "real" || obj.type === "long") {
    const inner = obj.value;
    if (typeof inner === "number") {
      return Number.isFinite(inner) ? inner : null;
    }
    if (typeof inner === "string" && /^-?\d+(\.\d+)?$/.test(inner)) {
      return Number(inner);
    }
  }
  return null;
}

/** A small structural integer (attributeID, level) as a Number, else fallback. */
function smallInt(value: JsonValue | undefined, fallback = 0): number {
  const long = unwrapLong(value);
  if (long !== null) {
    return Number(long);
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// --- attribute dicts (shared) ----------------------------------------------
// dict[attributeID -> value]. Values are floats for the attribute reads and
// booleans for drone settings, so the value keeps both losslessly.

export interface DogmaAttribute {
  readonly attributeID: number;
  /** A double measurement, a boolean (drone settings), or null when unreadable. */
  readonly value: number | boolean | null;
}

function decodeAttributeDict(result: JsonValue | undefined): readonly DogmaAttribute[] {
  const out: DogmaAttribute[] = [];
  for (const [key, value] of readDictPairs(result)) {
    const attributeID = smallInt(key as JsonValue, -1);
    if (attributeID < 0) {
      continue;
    }
    const decoded: number | boolean | null = typeof value === "boolean" ? value : asFloat(value);
    out.push({ attributeID, value: decoded });
  }
  return out;
}

/** GetCharacterAttributes / QueryAllAttributesForItem / GetDroneSettingAttributes. */
export function decodeAttributes(result: JsonValue | undefined): readonly DogmaAttribute[] {
  return decodeAttributeDict(result);
}

// --- a GET-INFO ENTRY (ItemGetInfo, each GetAllInfo shipInfo/char entry) -----

export interface DogmaItemInfo {
  /** Loaded charge identity: [ship, slot flag, type], not an inventory item ID. */
  readonly sublocation?: readonly [number, number, number] | null;
  readonly itemID: number | string | null;
  readonly typeID: number | null;
  readonly ownerID: number | string | null;
  readonly locationID: number | string | null;
  readonly flagID: number | null;
  readonly groupID: number | null;
  readonly categoryID: number | null;
  /** -1 for a singleton (ship/char); a positive stack count otherwise. */
  readonly quantity: number | null;
  readonly stacksize: number | null;
  readonly customInfo: string | null;
  /** ⚠ EXACT FILETIME decimal strings, never JS numbers. */
  readonly time: string | null;
  readonly wallclockTime: string | null;
  readonly attributes: readonly DogmaAttribute[];
  /** The active-effects dict, passed through losslessly (empty when docked). */
  readonly activeEffects: JsonValue;
}

function optInt(value: JsonValue | undefined): number | null {
  return value === null || value === undefined ? null : smallInt(value, 0);
}

/** Decode one GET-INFO ENTRY (a util.KeyVal wrapping an invItem packedrow). */
export function decodeItemInfo(
  entry: JsonValue | undefined,
  key?: JsonValue,
): DogmaItemInfo | null {
  if (asObject(entry).type !== "object") {
    return null;
  }
  const invItem = readKeyVal(entry, "invItem");
  const identity = readKeyVal(entry, "itemID") ?? key;
  const tuple = Array.isArray(identity) ? identity : asObject(identity).items;
  const sublocation =
    Array.isArray(tuple) &&
    tuple.length === 3 &&
    tuple.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0)
      ? (tuple as [number, number, number])
      : null;
  return {
    sublocation,
    itemID: idData(readKeyVal(entry, "itemID") ?? readRowField(invItem, "itemID")),
    typeID: sublocation?.[2] ?? optInt(readRowField(invItem, "typeID")),
    ownerID: idData(readRowField(invItem, "ownerID")),
    locationID: sublocation?.[0] ?? idData(readRowField(invItem, "locationID")),
    flagID: sublocation?.[1] ?? optInt(readRowField(invItem, "flagID")),
    groupID: optInt(readRowField(invItem, "groupID")),
    categoryID: optInt(readRowField(invItem, "categoryID")),
    quantity: optInt(readRowField(invItem, "quantity")),
    stacksize: optInt(readRowField(invItem, "stacksize")),
    customInfo: (() => {
      const raw = readRowField(invItem, "customInfo");
      return typeof raw === "string" ? raw : null;
    })(),
    time: exactInt(readKeyVal(entry, "time")),
    wallclockTime: exactInt(readKeyVal(entry, "wallclockTime")),
    attributes: decodeAttributeDict(readKeyVal(entry, "attributes")),
    activeEffects: (readKeyVal(entry, "activeEffects") ?? null) as JsonValue,
  };
}
