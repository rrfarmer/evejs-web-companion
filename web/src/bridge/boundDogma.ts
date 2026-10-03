// R74 — the 11 RB-DOGMA BOUND reads, decoded from real captured bytes
// (PLUMBING ONLY — no UI, no writes).
//
// These are the raw retail dogma reads the client issues against the OID handle
// dogmaIM.MachoBindObject mints (the R72 dogma bind). Unlike R73's skills (a
// Moniker on the top-level /call seam), these ride the real bound two-step —
// GET /api/bridge/bound-dogma binds dogma once and issues all 11 off boundCall.
// Every read resolves its ship/char/scene from the SESSION and ignores the bound
// OID, so bound and top-level dispatch return identical own-scoped data (verified
// live cross-account Farmer 140000005 vs Test Two — a foreign itemID reads the
// caller's OWN ship / a zeroed sentinel, never the foreign item).
//
// ---------------------------------------------------------------------------
// WIRE SHAPES (captured LIVE 2026-07-22, Farmer 140000005, docked Perimeter):
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
    const decoded: number | boolean | null =
      typeof value === "boolean" ? value : asFloat(value);
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
export function decodeItemInfo(entry: JsonValue | undefined, key?: JsonValue): DogmaItemInfo | null {
  if (asObject(entry).type !== "object") {
    return null;
  }
  const invItem = readKeyVal(entry, "invItem");
  const identity = readKeyVal(entry, "itemID") ?? key;
  const tuple = Array.isArray(identity) ? identity : asObject(identity).items;
  const sublocation = Array.isArray(tuple) && tuple.length === 3 &&
    tuple.every(value => typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    ? tuple as [number, number, number] : null;
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

// --- GetAllInfo -------------------------------------------------------------
// The full ship+char+module dogma snapshot (the retail undock/dock bootstrap).
// The flat, high-value pieces are decoded; the deep/rare pieces (shipState, the
// character brain, systemWideEffects) are passed through LOSSLESSLY so a future
// fitting/ship UI keeps every field without this plumbing pass rendering them.

export interface BoundDogmaAllInfo {
  readonly activeShipID: number | string | null;
  /** The active ship followed by its fitted items (each a GET-INFO ENTRY). */
  readonly ships: readonly DogmaItemInfo[];
  /** The character's own entry from charInfo, with its dogma attributes. */
  readonly character: DogmaItemInfo | null;
  readonly characterID: number | string | null;
  /** shipModifiedCharAttribs — the ship-modified character attribute entry. */
  readonly shipModifiedCharAttributes: DogmaItemInfo | null;
  /** Activation state (module/charge online state) — passthrough, lossless. */
  readonly shipState: JsonValue;
  /** The character brain (skills/implants effect graph) — passthrough, lossless. */
  readonly charBrain: JsonValue;
  readonly systemWideEffectsOnShip: JsonValue;
  readonly structureInfo: JsonValue;
  readonly locationInfo: JsonValue;
}

/**
 * Dogma attribute 73, "Activation time / duration" -- how long one cycle of
 * this module takes.
 *
 * ⚠ IT IS THE ONLY HONEST "CAN THIS BE CYCLED" SIGNAL WE HAVE, and the group
 * NAME is not one. Checked against the SDE on 2026-09-11: group 60 "Damage
 * Control" holds Damage Control II with NO duration (passive the moment it is
 * online) AND Assault Damage Control II with a duration of 10125 (a real burst
 * module worth running), so no test on the group name can separate them. Group
 * 295 "Shield Resistance Amplifier" is passive throughout and matched the old
 * classifier's `/resistance/` arm.
 */
export const DOGMA_ATTR_DURATION = 73;

/**
 * Whether one fitted item has a cycle of its own -- that is, whether activating
 * it means anything.
 *
 * Three-state on purpose. `null` is "we cannot say": no dogma snapshot, or this
 * item is not in the one we have. A caller must not read that as "passive", or
 * an unread dogma would quietly stop a ship hardening.
 */
export function itemHasActivationCycle(
  dogma: BoundDogmaAllInfo | null,
  itemID: number,
): boolean | null {
  if (dogma === null) {
    return null;
  }
  const entry = dogma.ships.find((item) => Number(item.itemID) === itemID);
  if (entry === undefined) {
    return null;
  }
  const duration = entry.attributes.find((attr) => attr.attributeID === DOGMA_ATTR_DURATION);
  if (duration === undefined || typeof duration.value !== "number") {
    // Present in the snapshot and carrying no duration at all: that IS the
    // passive answer, and it is the one the Damage Control case needs.
    return false;
  }
  return duration.value > 0;
}

/** The inner dict entries of the util.KeyVal top-level wrapper, name-agnostic. */
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

function topField(value: JsonValue | undefined, key: string): JsonValue | undefined {
  for (const entry of keyValEntries(value)) {
    if (Array.isArray(entry) && (entry as readonly JsonValue[])[0] === key) {
      return (entry as readonly JsonValue[])[1];
    }
  }
  return undefined;
}

export function decodeGetAllInfo(result: JsonValue | undefined): BoundDogmaAllInfo {
  // shipInfo: dict[ itemID -> GET-INFO ENTRY ].
  const ships: DogmaItemInfo[] = [];
  for (const [key, entry] of readDictPairs(topField(result, "shipInfo"))) {
    const decoded = decodeItemInfo(entry, key);
    if (decoded) {
      ships.push(decoded);
    }
  }
  // charInfo: [ dict[ charID -> GET-INFO ENTRY ], charBrain ].
  const charInfo = topField(result, "charInfo");
  const charList = Array.isArray(charInfo) ? (charInfo as readonly JsonValue[]) : [];
  let character: DogmaItemInfo | null = null;
  let characterID: number | string | null = null;
  const charEntry = readDictPairs(charList[0])[0];
  if (charEntry) {
    characterID = idData(charEntry[0] as JsonValue);
    character = decodeItemInfo(charEntry[1] as JsonValue);
  }
  const shipModified = topField(result, "shipModifiedCharAttribs");
  return {
    activeShipID: idData(topField(result, "activeShipID")),
    ships,
    character,
    characterID,
    shipModifiedCharAttributes:
      shipModified === null || shipModified === undefined ? null : decodeItemInfo(shipModified),
    shipState: (topField(result, "shipState") ?? null) as JsonValue,
    charBrain: (charList[1] ?? null) as JsonValue,
    systemWideEffectsOnShip: (topField(result, "systemWideEffectsOnShip") ?? null) as JsonValue,
    structureInfo: (topField(result, "structureInfo") ?? null) as JsonValue,
    locationInfo: (topField(result, "locationInfo") ?? null) as JsonValue,
  };
}

// --- GetTargeters -----------------------------------------------------------

/** The itemIDs of entities currently locking YOU (empty when nobody is). */
export function decodeTargeters(result: JsonValue | undefined): readonly (number | string)[] {
  const items = isListValue(result) ? result.items : [];
  const out: (number | string)[] = [];
  for (const item of items) {
    const id = idData(item as JsonValue);
    if (id !== null) {
      out.push(id);
    }
  }
  return out;
}

// --- GetRequiredSkillLevels -------------------------------------------------

export interface DogmaRequiredSkill {
  readonly skillTypeID: number;
  readonly level: number;
}

/** STATIC: the skills (and min level) a type requires. Empty for typeID 0. */
export function decodeRequiredSkillLevels(
  result: JsonValue | undefined,
): readonly DogmaRequiredSkill[] {
  const out: DogmaRequiredSkill[] = [];
  for (const [key, value] of readDictPairs(result)) {
    const skillTypeID = smallInt(key as JsonValue, 0);
    if (skillTypeID <= 0) {
      continue;
    }
    out.push({ skillTypeID, level: Math.max(1, smallInt(value, 1)) });
  }
  return out;
}

// --- GetLayerDamageValuesByItems --------------------------------------------

export interface DogmaShieldLayer {
  readonly current: number | null;
  readonly max: number | null;
  readonly recharge: number | null;
}

export interface DogmaLayerDamage {
  readonly itemID: number | string | null;
  /** [current, max, recharge] when the item has a shield, else null. */
  readonly shield: DogmaShieldLayer | null;
  readonly armorInfo: number | null;
  readonly hullInfo: number | null;
  readonly armorDamage: number | null;
  readonly hullDamage: number | null;
  readonly shieldRatio: number | null;
  readonly armorRatio: number | null;
  readonly hullRatio: number | null;
  readonly armorMax: number | null;
  readonly hullMax: number | null;
}

function decodeShieldInfo(value: JsonValue | undefined): DogmaShieldLayer | null {
  if (!isListValue(value)) {
    // A bare real means "no shield layer" — expose null rather than a fake layer.
    return null;
  }
  const items = value.items;
  return {
    current: asFloat(items[0] as JsonValue),
    max: asFloat(items[1] as JsonValue),
    recharge: asFloat(items[2] as JsonValue),
  };
}

/** Per-item shield/armor/hull layer values + absolute damage (drone-bay tracker). */
export function decodeLayerDamageValues(
  result: JsonValue | undefined,
): readonly DogmaLayerDamage[] {
  const out: DogmaLayerDamage[] = [];
  for (const [key, kv] of readDictPairs(result)) {
    out.push({
      itemID: idData(key as JsonValue),
      shield: decodeShieldInfo(readKeyVal(kv, "shieldInfo")),
      armorInfo: asFloat(readKeyVal(kv, "armorInfo")),
      hullInfo: asFloat(readKeyVal(kv, "hullInfo")),
      armorDamage: asFloat(readKeyVal(kv, "armorDamage")),
      hullDamage: asFloat(readKeyVal(kv, "hullDamage")),
      shieldRatio: asFloat(readKeyVal(kv, "shieldRatio")),
      armorRatio: asFloat(readKeyVal(kv, "armorRatio")),
      hullRatio: asFloat(readKeyVal(kv, "hullRatio")),
      armorMax: asFloat(readKeyVal(kv, "armorMax")),
      hullMax: asFloat(readKeyVal(kv, "hullMax")),
    });
  }
  return out;
}

// --- QueryAttributeValue ----------------------------------------------------

/** A single attribute's current value on an item (a double), or null when absent. */
export function decodeAttributeValue(result: JsonValue | undefined): number | null {
  return result === null || result === undefined ? null : asFloat(result);
}

// --- FullyDescribeAttribute -------------------------------------------------

/** The human-readable debug lines describing an attribute's modifier graph. */
export function decodeAttributeDescription(result: JsonValue | undefined): readonly string[] {
  const items = isListValue(result) ? result.items : [];
  return items.filter((line): line is string => typeof line === "string");
}

// --- GetLocationInfo --------------------------------------------------------

export interface DogmaLocationInfo {
  /** The session's own account/userid (the handler returns session.userid here). */
  readonly ownerID: number | string | null;
  readonly locationID: number | string | null;
  /** A trailing flag (0 live). */
  readonly extra: number | null;
}

/** The session's current location — a bare [ownerID, locationID, 0] tuple. */
export function decodeLocationInfo(result: JsonValue | undefined): DogmaLocationInfo {
  const tuple = Array.isArray(result) ? (result as readonly JsonValue[]) : [];
  return {
    ownerID: idData(tuple[0]),
    locationID: idData(tuple[1]),
    extra: tuple[2] === undefined ? null : smallInt(tuple[2], 0),
  };
}

// --- The whole GET /api/bridge/bound-dogma envelope -------------------------
//
// The BFF issues all 11 reads independently (Promise.allSettled) and returns each
// as `{result}` on success or `{error: <code>}` on failure/refusal — an empty
// targeter list, an empty required-skill dict (typeID 0) and an empty layer-damage
// dict (no items requested) are legitimate states, never a blanking failure. This
// decoder folds that envelope into typed data, carrying each read's error through.

export interface BoundDogmaCell<T> {
  readonly value: T;
  /** The failure/refusal code when the read did not succeed, else null. */
  readonly error: string | null;
}

export interface BoundDogma {
  readonly allInfo: BoundDogmaCell<BoundDogmaAllInfo | null>;
  readonly itemInfo: BoundDogmaCell<DogmaItemInfo | null>;
  readonly targeters: BoundDogmaCell<readonly (number | string)[]>;
  readonly droneSettingAttributes: BoundDogmaCell<readonly DogmaAttribute[]>;
  readonly characterAttributes: BoundDogmaCell<readonly DogmaAttribute[]>;
  readonly requiredSkillLevels: BoundDogmaCell<readonly DogmaRequiredSkill[]>;
  readonly layerDamageValues: BoundDogmaCell<readonly DogmaLayerDamage[]>;
  readonly allAttributesForItem: BoundDogmaCell<readonly DogmaAttribute[]>;
  readonly attributeValue: BoundDogmaCell<number | null>;
  readonly attributeDescription: BoundDogmaCell<readonly string[]>;
  readonly locationInfo: BoundDogmaCell<DogmaLocationInfo | null>;
}

function pick(
  reads: Record<string, JsonValue>,
  key: string,
): { result: JsonValue | undefined; error: string | null } {
  const cell = asObject(reads[key]);
  const error = typeof cell.error === "string" && cell.error.length > 0 ? cell.error : null;
  return { result: cell.result, error };
}

/** Decode the /api/bridge/bound-dogma envelope. */
export function decodeBoundDogma(raw: JsonValue | null | undefined): BoundDogma {
  const reads = asObject(asObject(raw).reads);
  const map = <T>(
    key: string,
    decode: (r: JsonValue | undefined) => T,
  ): BoundDogmaCell<T> => {
    const { result, error } = pick(reads, key);
    return { value: decode(result), error };
  };
  return {
    allInfo: map("GetAllInfo", (r) => (r === undefined ? null : decodeGetAllInfo(r))),
    itemInfo: map("ItemGetInfo", (r) => (r === undefined ? null : decodeItemInfo(r))),
    targeters: map("GetTargeters", decodeTargeters),
    droneSettingAttributes: map("GetDroneSettingAttributes", decodeAttributes),
    characterAttributes: map("GetCharacterAttributes", decodeAttributes),
    requiredSkillLevels: map("GetRequiredSkillLevels", decodeRequiredSkillLevels),
    layerDamageValues: map("GetLayerDamageValuesByItems", decodeLayerDamageValues),
    allAttributesForItem: map("QueryAllAttributesForItem", decodeAttributes),
    attributeValue: map("QueryAttributeValue", decodeAttributeValue),
    attributeDescription: map("FullyDescribeAttribute", decodeAttributeDescription),
    locationInfo: map("GetLocationInfo", (r) => (r === undefined ? null : decodeLocationInfo(r))),
  };
}
