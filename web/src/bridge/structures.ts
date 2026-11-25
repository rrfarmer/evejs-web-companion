// R63 — decoding the structureDirectory SESSION/ACCESS-SCOPED reads (PLUMBING
// ONLY — no UI). GET /api/bridge/structures returns raw retail-shaped results for
// TEN allowlisted structureDirectory reads; the decoders below were built from
// bytes captured LIVE from Farmer (char 140000005, corp 98000001) on 2026-07-22.
//
// GetMyCharacterStructures uses the public directory payload for dockable
// structures and NPC stations. Corporation management fields use the owned read.
//
// R7d at the decoder level: every id (structureID / ownerID / allianceID /
// solarSystemID / typeID) survives as a numeric field for a future UI to resolve;
// none is forced into a label, none is lost. FILETIME longs (fuelExpires /
// timerEnd / next_reinforce_apply / unanchoring) are read bigint-safe, never
// through Number. Empty results (no cyno beacons, no jump bridges, an empty bio)
// are legitimate states in Farmer's world, not failures.

import {
  isListValue,
  readDictPairs,
  readKeyVal,
  readRowField,
  unwrapLong,
  type JsonValue,
} from "./wire.ts";
import { unwrapCachedResult } from "./market.ts";

// --- shared readers ---------------------------------------------------------

/**
 * A number from a wire field, whatever encoding it arrived in: a plain number, a
 * {type:"long"} wrapper, or a bare decimal string. 0 when absent/unreadable.
 * Structure ids here are ~1e12 (> 2^32, well under 2^53) so they hold exactly.
 */
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

/** A number that keeps null when the field is genuinely absent/null (not zero). */
function toNullableNumber(value: JsonValue | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return toNumber(value);
}

/**
 * A boolean from a wire field. ⚠ inSpace arrives TWO ways on this service:
 * buildStructureDirectoryInfo emits a real boolean (`!destroyedAt`), while
 * buildWarHQPayload emits the number 1/0 — both must read true/false.
 */
function toBool(value: JsonValue | undefined): boolean {
  return value === true || toNumber(value) === 1;
}

/** Unwrap a wstring / token / rawstr wrapper or a bare string; "" otherwise. */
function readText(value: JsonValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string") {
      return inner;
    }
  }
  return "";
}

/** The items of a marshaled {type:"list"} wrapper, or [] for anything else. */
function listItems(value: JsonValue | null | undefined): readonly JsonValue[] {
  return isListValue(value) ? value.items : [];
}

interface StructureDirectoryEntry {
  readonly structureID: number;
  readonly typeID: number;
  readonly ownerID: number;
  readonly solarSystemID: number;
  readonly itemName?: string;
  readonly serviceIDs: readonly number[];
}

export interface StructureBrowserEntry extends StructureDirectoryEntry {
  readonly constellationID: number | null;
  readonly regionID: number | null;
  readonly security: number | null;
  readonly jumps: number | null;
}

export interface StructureBrowserDirectory {
  readonly entries: readonly StructureBrowserEntry[];
  readonly currentConstellationID: number | null;
  readonly currentRegionID: number | null;
}

/** GetMyCharacterStructures: a dict keyed by ID with plain dict records. */
export function decodeCharacterStructureDirectory(result: JsonValue): StructureDirectoryEntry[] {
  const rows: StructureDirectoryEntry[] = [];
  for (const [, value] of readDictPairs(result)) {
    const fields = new Map(readDictPairs(value));
    const structureID = toNumber(fields.get("structureID"));
    const typeID = toNumber(fields.get("typeID"));
    const ownerID = toNumber(fields.get("ownerID"));
    const solarSystemID = toNumber(fields.get("solarSystemID"));
    if (structureID > 0 && typeID > 0 && ownerID > 0 && solarSystemID > 0) {
      const serviceIDs = decodeServices(fields.get("services")).map(service => service.serviceID);
      rows.push({ structureID, typeID, ownerID, solarSystemID, serviceIDs });
    }
  }
  return rows;
}

// --- structure directory info (GetMyCorporationStructures / GetCorporationStructures)

/**
 * One structure from the OWNED-corp directory. Carries the operational fields
 * (fuel / reinforce / vulnerability) — SAFE here because listOwnedStructures
 * returns strictly the session corp's OWN structures (ownerCorpID === corp,
 * role-gated). FILETIMEs are bigint-safe; every id stays a number for R7d.
 */
export interface CorporationStructure {
  readonly structureID: number;
  readonly itemName: string;
  readonly solarSystemID: number;
  readonly ownerID: number;
  readonly allianceID: number | null;
  readonly typeID: number;
  readonly groupID: number;
  readonly categoryID: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly inSpace: boolean;
  readonly profileID: number | null;
  /** serviceID -> raw service value (an online-service map); [] when none. */
  readonly services: readonly { readonly serviceID: number; readonly value: number }[];
  readonly fuelExpires: bigint | null;
  readonly upkeepState: number;
  readonly state: number;
  readonly timerEnd: bigint | null;
  readonly reinforceWeekday: number | null;
  readonly reinforceHour: number | null;
  readonly nextReinforceWeekday: number | null;
  readonly nextReinforceHour: number | null;
  readonly nextReinforceApply: bigint | null;
  readonly unanchoring: bigint | null;
  readonly liquidOzoneQty: number;
  /** Number of active wars on the structure (the raw wars list length). */
  readonly warsCount: number;
}

function decodeServices(
  value: JsonValue | undefined,
): readonly { serviceID: number; value: number }[] {
  const out: { serviceID: number; value: number }[] = [];
  for (const [key, raw] of readDictPairs(value)) {
    const serviceID = toNumber(key as JsonValue);
    if (serviceID > 0) {
      out.push({ serviceID, value: toNumber(raw) });
    }
  }
  return out;
}

function decodeCorporationStructureRow(kv: JsonValue): CorporationStructure | null {
  const structureID = toNumber(readKeyVal(kv, "structureID"));
  if (structureID <= 0) {
    return null;
  }
  const allianceID = toNullableNumber(readKeyVal(kv, "allianceID"));
  const profileID = toNullableNumber(readKeyVal(kv, "profileID"));
  return {
    structureID,
    itemName: readText(readKeyVal(kv, "itemName")),
    solarSystemID: toNumber(readKeyVal(kv, "solarSystemID")),
    ownerID: toNumber(readKeyVal(kv, "ownerID")),
    allianceID: allianceID && allianceID > 0 ? allianceID : null,
    typeID: toNumber(readKeyVal(kv, "typeID")),
    groupID: toNumber(readKeyVal(kv, "groupID")),
    categoryID: toNumber(readKeyVal(kv, "categoryID")),
    x: toNumber(readKeyVal(kv, "x")),
    y: toNumber(readKeyVal(kv, "y")),
    z: toNumber(readKeyVal(kv, "z")),
    inSpace: toBool(readKeyVal(kv, "inSpace")),
    profileID: profileID && profileID > 0 ? profileID : null,
    services: decodeServices(readKeyVal(kv, "services")),
    fuelExpires: unwrapLong(readKeyVal(kv, "fuelExpires")),
    upkeepState: toNumber(readKeyVal(kv, "upkeepState")),
    state: toNumber(readKeyVal(kv, "state")),
    timerEnd: unwrapLong(readKeyVal(kv, "timerEnd")),
    reinforceWeekday: toNullableNumber(readKeyVal(kv, "reinforce_weekday")),
    reinforceHour: toNullableNumber(readKeyVal(kv, "reinforce_hour")),
    nextReinforceWeekday: toNullableNumber(readKeyVal(kv, "next_reinforce_weekday")),
    nextReinforceHour: toNullableNumber(readKeyVal(kv, "next_reinforce_hour")),
    nextReinforceApply: unwrapLong(readKeyVal(kv, "next_reinforce_apply")),
    unanchoring: unwrapLong(readKeyVal(kv, "unanchoring")),
    liquidOzoneQty: toNumber(readKeyVal(kv, "liquidOzoneQty")),
    warsCount: listItems(readKeyVal(kv, "wars")).length,
  };
}

/**
 * Decode GetMyCorporationStructures / GetCorporationStructures -> the session
 * corp's OWN structures. The wire is a bare marshaled dict keyed by structureID
 * -> util.KeyVal. `[]` is a real "no structures" (or, when the read threw
 * CrpAccessDenied because the character lacks the manager role, the route reports
 * that as an error code — not an empty result). Sorted by structureID.
 */
export function decodeCorporationStructures(
  result: JsonValue | null | undefined,
): CorporationStructure[] {
  const rows: CorporationStructure[] = [];
  for (const [, kv] of readDictPairs((result ?? null) as JsonValue)) {
    const row = decodeCorporationStructureRow(kv);
    if (row) {
      rows.push(row);
    }
  }
  return rows.sort((left, right) => left.structureID - right.structureID);
}

// --- id lists (GetMyDockableStructures / GetSolarSystemsWithBeacons /
//     CheckMyDockingAccessToStructures) ------------------------------------

/**
 * Decode a bare id list — GetMyDockableStructures (structure ids the char can
 * dock at), GetSolarSystemsWithBeacons (solar-system ids), or
 * CheckMyDockingAccessToStructures (the subset of requested ids the char may dock
 * at). Ids stay data (R7d); the caller resolves them. `[]` is a real "none".
 */
export function decodeIDList(result: JsonValue | null | undefined): number[] {
  return listItems((result ?? null) as JsonValue)
    .map((item) => toNumber(item))
    .filter((id) => id > 0);
}

// --- structure map data (GetStructureMapData) -------------------------------

/** One structure on the system map. NO operational fields — location/name only. */
export interface StructureMapEntry {
  readonly structureID: number;
  readonly typeID: number;
  readonly groupID: number;
  readonly itemName: string;
  readonly solarSystemID: number;
  /** The celestial it orbits: the system's star, as Tranquility's rows carry it (never its owner). */
  readonly orbitID: number;
  readonly connector: boolean;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The row's celestialIndex and orbitIndex: None for a structure on Tranquility (the multibuy sorts by them). */
  readonly celestialIndex: number | null;
  readonly orbitIndex: number | null;
}

/**
 * Decode GetStructureMapData -> the structures on a system map. The wire is a
 * CachedMethodCallResult wrapping a CRowset (objectex2) — BOTH layers are peeled:
 * `unwrapCachedResult` (market.ts) reads the cache substream, then the rows live
 * on the objectex2's `list` (packedrows, name-keyed here; positional tolerated).
 * ⚠ The columns are the MAP shape, so `itemID` is the structureID, `locationID`
 * is the solarSystemID and `orbitID` the system's star (Tranquility's row, LOGS/Archive/Undock citadel and
 * stopping ship.txt: orbitID 40344201, Henebene's star; EveJS put the owner there until eve.js 8a2ce7e63) — NO
 * fuel/reinforce column exists, and no owner. Sorted by structureID. `[]` is a real "no structures in system".
 */
export function decodeStructureMapData(
  result: JsonValue | null | undefined,
): StructureMapEntry[] {
  const rowset = unwrapCachedResult((result ?? null) as JsonValue);
  const list =
    typeof rowset === "object" &&
    rowset !== null &&
    !Array.isArray(rowset) &&
    Array.isArray((rowset as { list?: unknown }).list)
      ? ((rowset as { list: readonly JsonValue[] }).list)
      : [];
  const rows: StructureMapEntry[] = [];
  for (const row of list) {
    const structureID = toNumber(readRowField(row, "itemID"));
    if (structureID <= 0) {
      continue;
    }
    rows.push({
      structureID,
      typeID: toNumber(readRowField(row, "typeID")),
      groupID: toNumber(readRowField(row, "groupID")),
      itemName: readText(readRowField(row, "itemName")),
      solarSystemID: toNumber(readRowField(row, "locationID")),
      orbitID: toNumber(readRowField(row, "orbitID")),
      connector: readRowField(row, "connector") === true,
      x: toNumber(readRowField(row, "x")),
      y: toNumber(readRowField(row, "y")),
      z: toNumber(readRowField(row, "z")),
      celestialIndex: toNullableNumber(readRowField(row, "celestialIndex")),
      orbitIndex: toNullableNumber(readRowField(row, "orbitIndex")),
    });
  }
  return rows.sort((left, right) => left.structureID - right.structureID);
}

// --- structure description (GetStructureDescription) ------------------------

/**
 * Decode GetStructureDescription -> the structure's bio, a plain string. "" is a
 * real "no description set" answer (captured live: Farmer's corp structure has
 * none). Anything that is not a string decodes to "".
 */
export function decodeStructureDescription(
  result: JsonValue | null | undefined,
): string {
  return typeof result === "string" ? result : "";
}

// --- accessible cyno beacons (GetMyAccessibleOnlineCynoBeaconStructures) -----

/** One online cyno beacon the character has service access to. */
export interface CynoBeaconStructure {
  readonly structureID: number;
  readonly typeID: number;
  readonly ownerID: number;
  readonly solarSystemID: number;
  readonly state: number;
  readonly itemName: string;
}

/**
 * Decode GetMyAccessibleOnlineCynoBeaconStructures -> the online, non-jammed cyno
 * beacons the character has service access to. Each entry is a bare positional
 * list [structureID, typeID, ownerID, solarSystemID, state, itemName]
 * (buildCynoBeaconEntry). Captured live EMPTY (Farmer has access to none) — a real
 * state; the populated field order is pinned by the fixture test. ids stay data.
 */
export function decodeCynoBeacons(
  result: JsonValue | null | undefined,
): CynoBeaconStructure[] {
  const beacons: CynoBeaconStructure[] = [];
  for (const entry of listItems((result ?? null) as JsonValue)) {
    const cells = listItems(entry);
    const structureID = toNumber(cells[0]);
    if (structureID <= 0) {
      continue;
    }
    beacons.push({
      structureID,
      typeID: toNumber(cells[1]),
      ownerID: toNumber(cells[2]),
      solarSystemID: toNumber(cells[3]),
      state: toNumber(cells[4]),
      itemName: readText(cells[5]),
    });
  }
  return beacons;
}

// --- valid war HQs (GetValidWarHQs) -----------------------------------------

/** One valid war-HQ candidate (access-gated to the session corp/alliance). */
export interface WarHQStructure {
  readonly structureID: number;
  readonly typeID: number;
  readonly ownerID: number;
  readonly solarSystemID: number;
  readonly itemName: string;
  readonly upkeepState: number;
  readonly inSpace: boolean;
  readonly warsCount: number;
}

/**
 * Decode GetValidWarHQs -> the war-HQ candidates for the requested owner. The read
 * is GATED server-side (canRequestWarHQsForOwner: the owner must be the session
 * corp or alliance), so a browser only ever sees its OWN HQs. Each item is a
 * util.KeyVal (buildWarHQPayload) with the 8 public fields — NO fuel/reinforce.
 * Captured live POPULATED (one HQ, the session corp's own structure). Sorted by
 * structureID. `[]` is a real "no valid HQs / not my owner".
 */
export function decodeValidWarHQs(
  result: JsonValue | null | undefined,
): WarHQStructure[] {
  const hqs: WarHQStructure[] = [];
  for (const kv of listItems((result ?? null) as JsonValue)) {
    const structureID = toNumber(readKeyVal(kv, "structureID"));
    if (structureID <= 0) {
      continue;
    }
    hqs.push({
      structureID,
      typeID: toNumber(readKeyVal(kv, "typeID")),
      ownerID: toNumber(readKeyVal(kv, "ownerID")),
      solarSystemID: toNumber(readKeyVal(kv, "solarSystemID")),
      itemName: readText(readKeyVal(kv, "itemName")),
      upkeepState: toNumber(readKeyVal(kv, "upkeepState")),
      inSpace: toBool(readKeyVal(kv, "inSpace")),
      warsCount: listItems(readKeyVal(kv, "wars")).length,
    });
  }
  return hqs.sort((left, right) => left.structureID - right.structureID);
}

// --- jump bridges with my access (GetJumpBridgesWithMyAccess) ---------------

/** One end of an Ansiblex jump-bridge pair (buildJumpBridgeMapStructurePayload). */
export interface JumpBridgeEnd {
  readonly structureID: number;
  readonly typeID: number;
  readonly solarSystemID: number;
  readonly ownerID: number | null;
  readonly allianceID: number | null;
  readonly itemName: string;
  readonly destinationSolarSystemID: number | null;
}

/** A source/destination Ansiblex bridge pair. */
export interface JumpBridgePair {
  readonly source: JumpBridgeEnd | null;
  readonly destination: JumpBridgeEnd | null;
}

/** GetJumpBridgesWithMyAccess -> the bridge pairs split by the char's access. */
export interface JumpBridgeAccess {
  readonly pairs: readonly JumpBridgePair[];
  readonly hasAccess: readonly number[];
  readonly hasNoAccess: readonly number[];
}

function decodeJumpBridgeEnd(kv: JsonValue): JumpBridgeEnd | null {
  const structureID = toNumber(readKeyVal(kv, "structureID"));
  if (structureID <= 0) {
    return null;
  }
  const ownerID = toNullableNumber(readKeyVal(kv, "ownerID"));
  const allianceID = toNullableNumber(readKeyVal(kv, "allianceID"));
  const destination = toNullableNumber(readKeyVal(kv, "destinationSolarsystemID"));
  return {
    structureID,
    typeID: toNumber(readKeyVal(kv, "typeID")),
    solarSystemID: toNumber(readKeyVal(kv, "solarSystemID")),
    ownerID: ownerID && ownerID > 0 ? ownerID : null,
    allianceID: allianceID && allianceID > 0 ? allianceID : null,
    itemName: readText(readKeyVal(kv, "itemName")) || readText(readKeyVal(kv, "structureName")),
    destinationSolarSystemID: destination && destination > 0 ? destination : null,
  };
}

/**
 * Decode GetJumpBridgesWithMyAccess -> [pairsList, hasAccessIDs, hasNoAccessIDs].
 * ⚠ The wire is a bare 3-element JS ARRAY (buildJumpBridgeAccessPayload), not a
 * marshaled list wrapper: element 0 is a {type:"list"} of [srcKeyVal, dstKeyVal]
 * pairs, elements 1 and 2 are id lists. Captured live ALL EMPTY (no Ansiblex
 * bridges) — a real state; the populated pair shape is pinned by a fixture test.
 * ids stay data (R7d).
 */
export function decodeJumpBridgesWithMyAccess(
  result: JsonValue | null | undefined,
): JumpBridgeAccess {
  const outer = Array.isArray(result) ? (result as readonly JsonValue[]) : [];
  const pairs: JumpBridgePair[] = [];
  for (const pair of listItems(outer[0])) {
    const ends = listItems(pair);
    pairs.push({
      source: ends[0] !== undefined ? decodeJumpBridgeEnd(ends[0]) : null,
      destination: ends[1] !== undefined ? decodeJumpBridgeEnd(ends[1]) : null,
    });
  }
  return {
    pairs,
    hasAccess: decodeIDList(outer[1]),
    hasNoAccess: decodeIDList(outer[2]),
  };
}
