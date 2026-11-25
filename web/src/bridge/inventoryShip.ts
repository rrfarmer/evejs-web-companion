// Inventory & ship bound-object reads decoded to plain rows (goal R3, "how to
// add a page"). The retail two-step (bind then bound method) runs entirely on
// the BFF, which holds the bound-object handles server-side and returns the
// raw retail-shaped List / GetCapacity results here; this module decodes them.
//
// A List answers with a packed-row list, or (when empty and flag-scoped) a
// python set wrapping an empty list; GetCapacity answers a util.KeyVal
// {capacity, used}. See docs/retail-call-inventory.md Steps 5-6 and
// docs/bridge-wire-contract.md.

import {
  isKeyValValue,
  isListValue,
  readKeyVal,
  unwrapLong,
  type JsonValue,
} from "./wire.ts";
import type {
  CapacityInfo,
  InventoryContainerState,
  InventoryItemRow,
} from "../store/types.ts";

// Numeric fields may cross the wire as a plain number OR a retail long
// ({type:"long"} / BigInt→decimal string). Decode both so a long-encoded id or
// quantity never silently reads as 0 (a trap R4/R5 rows would otherwise inherit).
function toNumber(value: JsonValue | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const long = unwrapLong(value);
  return long === null ? 0 : Number(long);
}

function toNumberOrNull(value: JsonValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const long = unwrapLong(value);
  return long === null ? null : Number(long);
}

/**
 * Unwrap a python-set-wrapped list to the inner list. The empty/flag-scoped
 * List case answers with a __builtin__.set, whose real wire shape is
 * `{type:"objectex1", header:[{type:"token",value:"__builtin__.set"}, [innerList]]}`.
 * (An older `{type:"object", args:[list]}` shape is also tolerated.)
 */
function unwrapRowList(result: JsonValue): JsonValue {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return result;
  }
  const obj = result as { type?: unknown; header?: unknown; args?: unknown };
  if (obj.type === "objectex1" && Array.isArray(obj.header)) {
    const header = obj.header as readonly JsonValue[];
    const token = header[0] as { value?: unknown } | undefined;
    if (token && token.value === "__builtin__.set" && Array.isArray(header[1])) {
      const inner = (header[1] as readonly JsonValue[])[0];
      return inner ?? { type: "list", items: [] };
    }
  }
  if (obj.type === "object" && Array.isArray(obj.args)) {
    const args = obj.args as readonly JsonValue[];
    return args.length > 0 ? args[0]! : { type: "list", items: [] };
  }
  return result;
}

/** Raw inventory rows in the supplied cache order, retaining signed quantities and identities. */
export { unwrapRowList as inventoryRowList };

/** typeID → m³ per unit, keyed by the string the wire sends; null when unknown. */
/**
 * A type's volume by its typeID; and, under "p" and the typeID, a packaged stack's where the client's packaged volume
 * is another than the type's own (a packaged ship: inventorycommon/util.py GetItemVolume, GetPackagedVolume).
 */
export type VolumeMap = Readonly<Record<string, number>>;

function volumeFor(typeID: number, volumes: VolumeMap | undefined, packaged = false): number | null {
  if (volumes === undefined) {
    return null;
  }
  const v = (packaged ? volumes[`p${typeID}`] : undefined) ?? volumes[String(typeID)];
  // Nought is a type's volume where its type's is nought (blueprints and others), as the client's GetItemVolume has it.
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function decodeRowFields(fields: Record<string, JsonValue>, volumes: VolumeMap | undefined): InventoryItemRow {
  const quantity = toNumber(fields.quantity);
  const stacksize = toNumber(fields.stacksize);
  const typeID = toNumber(fields.typeID);
  const singletonCode = toNumber(fields.singleton);
  const blueprintCopy = singletonCode === 2;
  const singleton = fields.singleton === true || singletonCode === 1 || blueprintCopy;
  return {
    itemID: toNumber(fields.itemID),
    ...(toNumberOrNull(fields.ownerID) !== null ? { ownerID: toNumber(fields.ownerID) } : {}),
    ...(toNumberOrNull(fields.locationID) !== null ? { locationID: toNumber(fields.locationID) } : {}),
    typeID,
    groupID: toNumberOrNull(fields.groupID),
    categoryID: toNumberOrNull(fields.categoryID),
    flagID: toNumberOrNull(fields.flagID),
    // ⚠ AN ASSEMBLED ITEM CROSSES THE WIRE AS `quantity: -1`. That is retail's
    // MARKER for "one object, not a count" — personalAssets, corpAssets,
    // contractItems and shipBays each normalise it to 1 — and it is not a
    // number anything may do arithmetic with. Left raw here, as it was, it fed
    // a NEGATIVE quantity to every consumer that measures a stack:
    //
    //   * `planLootTransfers` starts at `left = row.quantity`, sees -1 <= 0 and
    //     places the row nowhere. A wreck holding nothing but dropped modules
    //     therefore planned NO transfers, and the loot path read that as "the
    //     ship has no room for this can" — reporting "There is no room aboard"
    //     against a hull whose holds were completely empty, and looting nothing.
    //   * `moveQuantityFor` asks `unitsThatFit(-1, ...)`, gets 0 back, and
    //     refuses a hand-drag into a ship bay with that same untrue "no room".
    //   * `totalVolume` answered MINUS one unit's m3 for the row.
    //
    // One object is one. `singleton` is still what the panel reads to caption
    // such a row "assembled" rather than "1", so this number is never shown for
    // it — it exists for the arithmetic, and the arithmetic wants a count.
    quantity: singleton ? 1 : quantity || stacksize,
    singleton,
    ...(blueprintCopy ? { blueprintCopy: true as const } : {}),
    volume: volumeFor(typeID, volumes, !singleton),
  };
}

/**
 * Decode an invbroker List result into plain rows; malformed rows are dropped.
 * `volumes` (from the inventory read) attaches per-unit m³ where known.
 */
export function decodeInventoryRows(result: JsonValue, volumes?: VolumeMap): InventoryItemRow[] {
  const listValue = unwrapRowList(result);
  if (!isListValue(listValue)) {
    return [];
  }
  const rows: InventoryItemRow[] = [];
  // itemID is the row key everywhere these rows are rendered, and a keyed
  // `{#each}` handed the same key twice throws rather than draws — taking the
  // whole render flush with it (see distinctIDs in bridge/space.ts). One
  // itemID is one stack; a repeat on the wire is not a second stack.
  const seen = new Set<number>();
  for (const item of listValue.items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const candidate = item as { type?: unknown; fields?: unknown };
    const fields =
      candidate.type === "packedrow" &&
      typeof candidate.fields === "object" &&
      candidate.fields !== null
        ? (candidate.fields as Record<string, JsonValue>)
        : (item as Record<string, JsonValue>);
    const row = decodeRowFields(fields, volumes);
    if (row.itemID > 0 && !seen.has(row.itemID)) {
      seen.add(row.itemID);
      rows.push(row);
    }
  }
  return rows;
}

/** Automation proof read: malformed or repeated rows are unknown, never empty. */
export function decodeInventoryRowsChecked(result: JsonValue, volumes?: VolumeMap): InventoryItemRow[] | null {
  const list = unwrapRowList(result);
  if (!isListValue(list)) return null;
  // The permissive decoder tolerates an absent inner list for display. That
  // tolerance must not certify that a source container was emptied.
  if (list !== result && typeof result === "object" && result !== null && !Array.isArray(result)) {
    const raw = result as Record<string, JsonValue>;
    if (raw.type === "objectex1" && (!Array.isArray(raw.header) || !Array.isArray(raw.header[1]) || raw.header[1].length !== 1)) return null;
    if (raw.type === "object" && (!Array.isArray(raw.args) || raw.args.length !== 1)) return null;
  }
  const rows = decodeInventoryRows(result, volumes);
  return rows.length === list.items.length && rows.every(row =>
    Number.isSafeInteger(row.itemID) && row.itemID > 0 && Number.isSafeInteger(row.typeID) && row.typeID > 0 &&
    Number.isSafeInteger(row.quantity) && row.quantity > 0) ? rows : null;
}

/** Decode invbroker.GetCapacity (util.KeyVal {capacity, used}); null if malformed. */
export function decodeCapacity(result: JsonValue): CapacityInfo | null {
  if (!isKeyValValue(result)) {
    return null;
  }
  const capacity = readKeyVal(result, "capacity");
  const used = readKeyVal(result, "used");
  if (capacity === undefined && used === undefined) {
    return null;
  }
  return { capacity: toNumber(capacity), used: toNumber(used) };
}

/** Decode one container's (hangar/cargo) raw reads into store state. */
export function decodeContainer(
  list: JsonValue,
  capacity: JsonValue,
  error: string | null,
  volumes?: VolumeMap,
  reprocessableTypes?: ReadonlySet<number>,
): InventoryContainerState {
  return {
    rows: list === null || list === undefined ? [] : decodeInventoryRows(list, volumes).map(row =>
      reprocessableTypes?.has(row.typeID) ? { ...row, reprocessable: true as const } : row),
    capacity: capacity === null || capacity === undefined ? null : decodeCapacity(capacity),
    error,
  };
}

/**
 * A hangar row is a boardable ship when it is a ship (category 6), assembled, and not active: the client boards an
 * assembled ship alone (menusvc.ActivateShip, 3381: `if invItem.singleton`); a packaged one is assembled first.
 */
export function isBoardableShip(
  row: InventoryItemRow,
  activeShipID: number | null,
): boolean {
  return row.categoryID === 6 && row.singleton && row.itemID !== activeShipID;
}

// --- R14 inventory depth ----------------------------------------------------

/**
 * The inventory groups whose items are containers you can open and put things
 * into. Container-ness is a purely CLIENT-side static-data question — the
 * protocol has no notion of it, and the bind for a container is byte-for-byte
 * the bind for a ship's cargo hold.
 *
 *   12   Cargo Container      (the standard/secure/giant station containers)
 *   340  Secure Cargo Container
 *   448  Audit Log Secure Container
 *   649  Freight Container
 */
const CONTAINER_GROUP_IDS = new Set([12, 340, 448, 649]);
/**
 * inventorycommon/const.py playerDeployedContainers (the cargo, secure, audit log secure and freight containers and
 * groupSiphonPseudoSilo), less the siphon's silo, which itemCheckers.OfferAssembleContainer leaves out.
 */
const ASSEMBLED_FROM_THE_MENU_GROUP_IDS = new Set([12, 340, 448, 649]);
/** item.py _CONTAINER_GROUPS: the groups whose packaged item a double click assembles (a wreck's among them). */
const ASSEMBLED_BY_A_DOUBLE_CLICK_GROUP_IDS = new Set([186, 12, 340, 448, 649]);

/**
 * Does the item's menu offer Assemble Container (itemCheckers.OfferAssembleContainer, 79 to 90)? A player's container
 * that is not a siphon's silo, packaged, with the pilot docked and the container where the pilot is
 * (IsInPilotLocation), which the caller reads from the place it is listed in.
 */
export function offersAssembleContainer(row: InventoryItemRow, docked: boolean, inPilotLocation: boolean): boolean {
  return row.groupID !== null && ASSEMBLED_FROM_THE_MENU_GROUP_IDS.has(row.groupID) && !row.singleton && docked && inPilotLocation;
}

/** Does a double click on it assemble it (item.py isUnassembledContainer, 420; OnDblClick 838 and 839)? */
export function isUnassembledContainer(row: InventoryItemRow): boolean {
  return row.groupID !== null && ASSEMBLED_BY_A_DOUBLE_CLICK_GROUP_IDS.has(row.groupID) && !row.singleton;
}
const CATEGORY_CELESTIAL = 2;

/**
 * Is this row a container the player can open? It must be an assembled
 * (singleton) item of a container group. An UNASSEMBLED container is just
 * cargo — it stacks, and it holds nothing.
 */
export function isOpenableContainer(row: InventoryItemRow): boolean {
  if (!row.singleton) {
    return false;
  }
  if (row.groupID !== null && CONTAINER_GROUP_IDS.has(row.groupID)) {
    return true;
  }
  // Fall back to the category when a row carries no groupID: every container
  // group above sits in the Celestial category.
  return row.groupID === null && row.categoryID === CATEGORY_CELESTIAL;
}

/**
 * Can these two rows be merged into one stack? Only same-type, non-assembled
 * stacks — an assembled item is a single object, not a quantity.
 */
export function canMergeStacks(
  source: InventoryItemRow,
  destination: InventoryItemRow,
): boolean {
  return (
    source.itemID !== destination.itemID &&
    source.typeID === destination.typeID &&
    !source.singleton &&
    !destination.singleton
  );
}

/**
 * The label for a corporation hangar division. A corporation that never
 * renamed a division has no name for it, and the fallback is the plain
 * ordinal — NEVER the underlying flag number, which the browser never sees.
 */
export function divisionLabel(division: number, name: string | null): string {
  return name && name.trim() !== "" ? name : `Division ${division}`;
}
