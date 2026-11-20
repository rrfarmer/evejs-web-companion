// R37 — decoding the retail PERSONAL ASSETS surface (charMgr global assets).
//
// ⚠ THE TWO READS SEND DIFFERENT PACKEDROW VARIANTS, and this is exactly the
// shape of the R32 contract-detail defect. Both were confirmed against bytes
// captured from the live handlers, not assumed:
//
//   ListStations     -> {type:"objectex2", header:[…], list:[…], dict:[]}
//                       a CRowset. Its rows are the POSITIONAL packedrow —
//                       `columns:[["stationID",20],…]` with a parallel
//                       `values:[60003760,30000142,52678,1,null]` and NO
//                       `fields` object at all, because buildDbRowset feeds
//                       buildPackedRowFromRowsetLine an ARRAY per row.
//                       ⚠ THE ROWS ARE ON `list`, NOT ON `items`.
//
//   ListStationItems -> {type:"list", items:[…]}
//                       an ordinary list. Its rows are the NAME-KEYED packedrow
//                       — `fields:{itemID:…, typeID:…, …}` and NO `values`.
//
// A decoder that commits to one variant returns undefined for every field of
// the other, which does not throw and does not log: the panel simply renders an
// absence indistinguishable from "you own nothing". Every field here is read
// through `readRowField`, which dispatches on the shape it is given.
//
// ⚠ VALUE ENCODING, VERIFIED RATHER THAN ASSUMED. stationID, solarSystemID,
// itemID and locationID are declared int64 (type code 0x14 = 20) in the row
// descriptors, so the R32 bare-string-bigint trap was the expected hazard here.
// It does not bite: charMgrGlobalAssets builds every one of them with
// `toInteger()`, so they cross the wire as PLAIN JS NUMBERS — no {type:"long"}
// wrapper and no decimal string. Measured on a live read: stationID 60003760,
// itemID 9988400022007 (>2^32, still well under 2^53). `toNumber` below still
// accepts the wrapper and the bare string, because the gateway renders any
// genuine BigInt as a bare decimal string and a future handler change must not
// silently zero this panel.
//
// ⚠ `quantity` IS -1 FOR AN ASSEMBLED ITEM, NOT A COUNT. Every singleton row
// measured live carried `quantity:-1, singleton:1, stacksize:1` — the retail
// convention for a unique assembled thing (a ship, a fitted module). Rendering
// that field raw puts "-1 Badger" on screen. `units` below is the server's own
// rule (charMgrGlobalAssets._calculateItemUnits): a singleton is 1, everything
// else is its stacksize.

import type { AssetItemRow, AssetStationRow } from "../store/types.ts";
import type { AssetSearchItem } from "./assetSearch.ts";
import type { JsonValue } from "./wire.ts";
import { readRowField, unwrapLong } from "./wire.ts";

/**
 * A number from a row field, whatever encoding it arrived in: a plain number
 * (what these handlers send today), a {type:"long"} wrapper, or a BARE DECIMAL
 * STRING (what the gateway emits for any genuine BigInt). 0 when absent.
 */
function toNumber(value: JsonValue | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  const long = unwrapLong(value);
  return long !== null ? Number(long) : 0;
}

/**
 * The rows of a CRowset. They live on `list` — an objectex2's rows are NOT on
 * `items`, and reading `items` here yields an empty panel with no error.
 */
function crowsetRows(result: JsonValue | null | undefined): readonly JsonValue[] {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return [];
  }
  const list = (result as { list?: unknown }).list;
  return Array.isArray(list) ? (list as readonly JsonValue[]) : [];
}

/** The rows of a plain marshaled list. */
function listRows(result: JsonValue | null | undefined): readonly JsonValue[] {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return [];
  }
  const items = (result as { items?: unknown }).items;
  return Array.isArray(items) ? (items as readonly JsonValue[]) : [];
}

/**
 * Decode charMgr.ListStations — every station holding this character's items.
 *
 * Sorted by system then station so the list is stable across reloads; the
 * server already sorts the same way, and re-sorting here keeps the panel
 * independent of that.
 */
export function decodeAssetStations(
  result: JsonValue | null | undefined,
): readonly AssetStationRow[] {
  const rows: AssetStationRow[] = [];
  for (const row of crowsetRows(result)) {
    const stationID = toNumber(readRowField(row, "stationID"));
    if (stationID <= 0) {
      continue;
    }
    // A station's own typeID may legitimately be null (an unknown structure);
    // 0 is not a type, so it is carried as null rather than as a fake id.
    const typeID = toNumber(readRowField(row, "typeID"));
    rows.push({
      stationID,
      solarSystemID: toNumber(readRowField(row, "solarSystemID")),
      typeID: typeID > 0 ? typeID : null,
      itemCount: toNumber(readRowField(row, "itemCount")),
    });
  }
  return rows.sort(
    (left, right) =>
      left.solarSystemID - right.solarSystemID || left.stationID - right.stationID,
  );
}

/**
 * Decode charMgr.ListStationItems — what is at one station.
 *
 * `volumes` is the static per-type m³ map the BFF attaches; a type it does not
 * know is carried as `volume: null`, never as 0.
 */
export function decodeAssetItems(
  result: JsonValue | null | undefined,
  volumes: Readonly<Record<string, number>> = {},
): readonly AssetItemRow[] {
  const rows: AssetItemRow[] = [];
  for (const row of listRows(result)) {
    const itemID = toNumber(readRowField(row, "itemID"));
    const typeID = toNumber(readRowField(row, "typeID"));
    if (itemID <= 0 || typeID <= 0) {
      continue;
    }
    const singleton = toNumber(readRowField(row, "singleton")) === 1;
    const stacksize = toNumber(readRowField(row, "stacksize"));
    const quantity = toNumber(readRowField(row, "quantity"));
    const volume = Number(volumes[String(typeID)]);
    const locationID = toNumber(readRowField(row, "locationID"));
    const flagID = toNumber(readRowField(row, "flagID"));
    rows.push({
      itemID,
      typeID,
      ...(locationID > 0 ? { locationID } : {}),
      ...(flagID > 0 ? { flagID } : {}),
      // ⚠ NOT the raw `quantity` field. See the header note: an assembled item
      // reports -1 there. This is the server's own rule.
      units: singleton ? 1 : Math.max(0, stacksize || quantity || 0),
      singleton,
      categoryID: toNumber(readRowField(row, "categoryID")),
      groupID: toNumber(readRowField(row, "groupID")),
      volume: Number.isFinite(volume) && volume >= 0 && volumes[String(typeID)] !== null && volumes[String(typeID)] !== undefined ? volume : null,
    });
  }
  // Biggest stacks first, then by type, so the same station reads the same way
  // twice running.
  return rows.sort((left, right) => right.units - left.units || left.typeID - right.typeID);
}

/** The total m³ of a station's contents; null when no row had a known volume. */
/**
 * charMgr.ListIncludingContainers' packed rows as the assets search reads them (assetSearching.GetFakeRowset): each
 * thing's number, type, group, category, where it lies (location and flag) and its quantity (-1 for a thing assembled).
 */
export function decodeAssetSearchItems(result: JsonValue | null | undefined): AssetSearchItem[] {
  const rows: AssetSearchItem[] = [];
  for (const row of listRows(result)) {
    const itemID = toNumber(readRowField(row, "itemID"));
    const typeID = toNumber(readRowField(row, "typeID"));
    if (itemID <= 0 || typeID <= 0) continue;
    rows.push({
      itemID,
      typeID,
      groupID: toNumber(readRowField(row, "groupID")),
      categoryID: toNumber(readRowField(row, "categoryID")),
      locationID: toNumber(readRowField(row, "locationID")),
      flagID: toNumber(readRowField(row, "flagID")),
      quantity: toNumber(readRowField(row, "quantity")),
    });
  }
  return rows;
}

export function totalVolume(items: readonly AssetItemRow[]): number | null {
  let total = 0;
  let known = false;
  for (const item of items) {
    if (item.volume !== null) {
      total += item.volume * item.units;
      known = true;
    }
  }
  return known ? total : null;
}

/** A volume in cubic metres, or an em dash when it is genuinely not known. */
export function formatAssetVolume(volume: number | null): string {
  if (volume === null || !Number.isFinite(volume) || volume <= 0) {
    return "—";
  }
  return `${volume.toLocaleString(undefined, { maximumFractionDigits: 2 })} m³`;
}

/** A stack size in plain digits. */
export function formatUnits(units: number): string {
  return Number.isFinite(units) ? units.toLocaleString() : "—";
}

/**
 * Turn a failed asset read into a sentence a player can act on. An UNMAPPED
 * code passes through verbatim rather than being reworded — inventing a cause
 * the server never gave is the failure mode this avoids.
 */
const REFUSAL_SENTENCES: Readonly<Record<string, string>> = {
  ASSET_LOCATION_INVALID: "No location was named.",
  NO_LIVE_SESSION: "No character is online; pick your character again.",
  READ_FAILED: "Your assets could not be read just now.",
};

export function assetRefusalMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (code && code in REFUSAL_SENTENCES) {
    return REFUSAL_SENTENCES[code] as string;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message && message in REFUSAL_SENTENCES) {
    return REFUSAL_SENTENCES[message] as string;
  }
  return message || "Your assets could not be read.";
}
