// A ship's BAYS, decoded (goal R40).
//
// A bay is an inventory flag on the ship's own inventory — the same mechanism
// R12 fitting uses for slot flags. The BFF enumerates them and hands over a KEY
// and a LABEL per bay; the flag numbers behind them (5 cargo, 87 drone bay, 134
// ore hold, 155 fleet hangar…) live only on the BFF and never reach here. R7d:
// the browser has no idea those numbers exist.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: absent, empty and unknown are three
// different things, and they must never collapse into each other.
//
//   present === true   the hull HAS this bay
//   present === false  the hull does NOT have it — the server said so
//   present === null   we could not tell, because the read FAILED
//
//   items === []       we looked, and the bay is empty
//   items === null     we did not manage to look
//
// A hull with no ore hold and a hull whose ore hold we could not read are not
// the same picture, and neither is an ore hold that is genuinely empty. This
// codebase has conflated empty-with-failed repeatedly — `worldHasNoContracts`
// exists for exactly that reason — so the decoder keeps the states apart even
// when that means carrying a null the caller must think about.

import { unwrapLong, type JsonValue } from "./wire.ts";
import type { CapacityInfo, InventoryItemRow, ShipBay } from "../store/types.ts";

function asObject(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

/** A positive game ID (long-aware), or null. */
function idOrNull(value: JsonValue | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const long = unwrapLong(value);
  if (long === null) {
    return null;
  }
  const numeric = Number(long);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/** A finite number, or null. Zero is a real answer and survives. */
function numberOrNull(value: JsonValue | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const long = unwrapLong(value);
  const numeric = Number(long === null ? value : long);
  return Number.isFinite(numeric) ? numeric : null;
}

function stringOr(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * A bay's contents as ordinary inventory rows, so the cards can reuse every
 * predicate the panel already has (isShip, isOpenableContainer, canMergeStacks)
 * without a second row shape. `null` means the read failed.
 *
 * flagID is deliberately always null here: the BFF strips it, and nothing in
 * the browser is allowed to learn which flag a bay is.
 */
function decodeBayItems(value: JsonValue | undefined): readonly InventoryItemRow[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const rows: InventoryItemRow[] = [];
  // One itemID, one row: these are rendered by a keyed `{#each}`, which throws
  // on a repeated key and freezes the render (see distinctIDs in space.ts).
  const seen = new Set<number>();
  for (const entry of value as JsonValue[]) {
    const raw = asObject(entry);
    const itemID = idOrNull(raw.itemID);
    const typeID = idOrNull(raw.typeID);
    // A row we cannot identify is DROPPED rather than kept with a zero — an
    // unreadable stack is not a stack of nothing.
    if (itemID === null || typeID === null || seen.has(itemID)) {
      continue;
    }
    seen.add(itemID);
    const singleton = raw.singleton === true;
    // A unit's volume where the read gives it (the route's readTypeVolumes), as the inventory's rows have theirs.
    const volume = numberOrNull(raw.volume);
    rows.push({
      itemID,
      typeID,
      groupID: idOrNull(raw.groupID),
      categoryID: idOrNull(raw.categoryID),
      flagID: null,
      // An assembled item crosses the wire with quantity -1 — that is a marker,
      // not an amount, and rendering it would put "-1 Warrior I" on screen. One
      // assembled object is one object; `singleton` is what the UI reads to
      // caption it, and this number is never shown for such a row.
      quantity: singleton ? 1 : Math.max(0, numberOrNull(raw.quantity) ?? 0),
      singleton,
      ...(raw.blueprintCopy === true ? { blueprintCopy: true as const } : {}),
      ...(volume !== null && volume >= 0 ? { volume } : {}),
    });
  }
  return rows;
}

function decodeBayCapacity(value: JsonValue | undefined): CapacityInfo | null {
  if (value === undefined || value === null) {
    return null;
  }
  const raw = asObject(value);
  const capacity = numberOrNull(raw.capacity);
  const used = numberOrNull(raw.used);
  if (capacity === null && used === null) {
    return null;
  }
  return { capacity: capacity ?? 0, used: used ?? 0 };
}

/**
 * Decode the BFF's bay list. A malformed payload decodes to an empty list
 * rather than throwing — but note that an empty list means "no bays were
 * reported", which the panel must not draw as "this ship has no bays".
 */
export function decodeShipBays(raw: JsonValue | undefined): readonly ShipBay[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const bays: ShipBay[] = [];
  for (const entry of raw as JsonValue[]) {
    const value = asObject(entry);
    const key = stringOr(value.key, "");
    if (key.length === 0) {
      continue;
    }
    bays.push({
      key,
      label: stringOr(value.label, "Bay"),
      // Strictly three-valued. Anything that is not an explicit true or false —
      // including a missing field — is "we do not know", never "absent".
      present: value.present === true ? true : value.present === false ? false : null,
      capacity: decodeBayCapacity(value.capacity),
      items: decodeBayItems(value.items),
      error: typeof value.error === "string" && value.error.length > 0 ? value.error : null,
    });
  }
  return bays;
}

/** Capacity/contents proof for automation; display's dropped/defaulted fields
 * cannot establish empty or full. Read only the bays the caller needs. */
export function decodeShipBaysChecked(raw: JsonValue | undefined): readonly ShipBay[] | null {
  if (!Array.isArray(raw)) return null;
  const bays = decodeShipBays(raw);
  if (bays.length !== raw.length || new Set(bays.map(bay => bay.key)).size !== bays.length) return null;
  const measurement = (value: JsonValue | undefined): number | null => {
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) return null;
    const numeric = Number(value); return Number.isFinite(numeric) ? numeric : null;
  };
  for (let i = 0; i < bays.length; i++) {
    const bay = bays[i]!, entry = asObject(raw[i]);
    if (bay.present === null) return null;
    if (bay.present === false) continue;
    const capacity = asObject(entry.capacity);
    if (bay.error !== null || measurement(capacity.capacity) === null || measurement(capacity.used) === null ||
      !Array.isArray(entry.items) || bay.items === null || bay.items.length !== entry.items.length ||
      !bay.items.every(row => Number.isSafeInteger(row.itemID) && row.itemID > 0 && Number.isSafeInteger(row.typeID) && row.typeID > 0 &&
        Number.isSafeInteger(row.quantity) && row.quantity > 0)) return null;
  }
  return bays;
}

/** The bays a hull actually has — the only ones worth drawing a gauge for. */
export function presentBays(bays: readonly ShipBay[]): readonly ShipBay[] {
  return bays.filter((bay) => bay.present === true);
}

/**
 * Bays we could not read at all. These are the reason the panel can never say
 * "this ship has one bay" with confidence: if any read failed, the honest
 * statement is "one bay, and some we could not check".
 */
export function unreadableBays(bays: readonly ShipBay[]): readonly ShipBay[] {
  return bays.filter((bay) => bay.present === null);
}
