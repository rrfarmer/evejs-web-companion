// The client's Neocom inventory badging (neocomInventoryBadging.NeocomInventoryBadging, 3698585), as far as space goes:
// the items new to the active ship's cargo (flagCargo) that the pilot has not looked at yet. A new item is one the
// server made (its location before was locationAbstract), one handed over from the system owner or another character,
// or crate loot - unless it is mined ore, ammo, salvage or PLEX from the vault (customInfo), the pilot's ship or
// capsule, an emptied or removed stack, something come in from space or from the ship itself, a booster used (flagBooster, never the cargo); and
// never while an Inventory window is open on that cargo. The unseen ones are kept per ship as the client keeps
// settings.char.unseenInventoryItems ('ShipCargo_<shipID>'); the Inventory button is important with
// UI/Neocom/UnseenItemsHint while there are any, the cargo's tree entry carries its tag and each unseen item its line.
// The cargo is seen when the Inventory shows another place after it or is closed (OnInventoryContainerShown /
// OnInventoryClosed), an item when it is selected (InvItem.Select -> MarkAsSeen).
import { writable, get } from "svelte/store";
import { readDictPairs, readRowField } from "../bridge/wire.ts";

const FLAG_CARGO = 5;
const FLAG_CRATE_LOOT = 174;
const LOCATION_ABSTRACT = 0;
const LOCATION_JUNKYARD = 10;
const OWNER_SYSTEM = 1;
const GROUP_CAPSULE = 29;
const IX_OWNER = 2, IX_LOCATION = 3, IX_FLAG = 4;

/** The ship whose cargo is tracked (the one flown in space), and its unseen items. */
export const badgedShip = writable<number | null>(null);
export const unseenCargo = writable<readonly number[]>([]);
/** Inventory windows open (Inventory.IsOpenByWindowClass). */
export const inventoryWindowsOpen = writable(0);

const key = (shipID: number) => `evejs.unseenInventoryItems.ShipCargo_${shipID}`;
function load(shipID: number): number[] {
  try { const v = JSON.parse(localStorage.getItem(key(shipID)) ?? "[]"); return Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : []; } catch { return []; }
}
function save(shipID: number, ids: readonly number[]): void {
  try { if (ids.length) localStorage.setItem(key(shipID), JSON.stringify(ids)); else localStorage.removeItem(key(shipID)); } catch { /* none kept */ }
}

/** start_tracking: the ship flown in space (null docked or without one); the ship itself is seen (on_session_updated). */
export function trackShip(shipID: number | null): void {
  if (get(badgedShip) === shipID) return;
  badgedShip.set(shipID);
  unseenCargo.set(shipID === null ? [] : load(shipID).filter((id) => id !== shipID));
}

function setUnseen(ids: readonly number[]): void {
  const ship = get(badgedShip);
  if (ship === null) return;
  unseenCargo.set(ids);
  save(ship, ids);
}

const isSolarSystem = (id: number) => id >= 30000000 && id <= 32999999;
const isCharacter = (id: number) => (id >= 3000000 && id < 4000000) || (id >= 90000000 && id < 98000000)
  || (id >= 100000000 && id <= 2147483647);

/**
 * process_item_change for one item of an OnItemChange / OnItemsChanged: marks it unseen or seen in the tracked cargo.
 * `inventoryOpen` is Inventory.IsOpenByWindowClass(); `charID` the pilot.
 */
export function itemChanged(row: unknown, change: unknown, inventoryOpen: boolean, charID: number | null): void {
  const ship = get(badgedShip);
  if (ship === null) return;
  const num = (k: string) => Number(readRowField(row, k));
  const itemID = num("itemID"), flagID = num("flagID"), locationID = num("locationID");
  if (!Number.isFinite(itemID)) return;
  const was = new Map<number, number>();
  for (const [k, v] of readDictPairs(change)) was.set(Number(k), Number(v));
  const list = get(unseenCargo);
  // _get_item_location: only the cargo of the ship tracked is badged here
  if (flagID !== FLAG_CARGO || locationID !== ship) {
    if (list.includes(itemID)) setUnseen(list.filter((id) => id !== itemID));
    return;
  }
  let custom = "";
  try { custom = JSON.stringify(readRowField(row, "customInfo") ?? null); } catch { /* none */ }
  const automatic = was.get(IX_LOCATION) === LOCATION_ABSTRACT;
  const seen = (automatic && num("groupID") === GROUP_CAPSULE)
    || itemID === ship
    || /isPlexFromVault|isMined|isAmmo|isSalvaged/.test(custom)
    || (num("quantity") === 0 && num("stacksize") === 0)
    || locationID === LOCATION_JUNKYARD
    || (was.has(IX_LOCATION) && isSolarSystem(was.get(IX_LOCATION)!))
    || (was.has(IX_LOCATION) && was.get(IX_LOCATION) === ship);
  const prevOwner = was.get(IX_OWNER);
  const fresh = automatic
    || prevOwner === OWNER_SYSTEM
    || (prevOwner !== undefined && prevOwner !== charID && isCharacter(prevOwner))
    || was.get(IX_FLAG) === FLAG_CRATE_LOOT;
  const unseen = !inventoryOpen && !seen && fresh;
  if (unseen && !list.includes(itemID)) setUnseen([...list, itemID]);
  else if (!unseen && list.includes(itemID)) setUnseen(list.filter((id) => id !== itemID));
}

/** mark_items_seen_in_location('ShipCargo'): the Inventory closed, or showing another place after the cargo. */
export function markCargoSeen(): void { if (get(unseenCargo).length) setUnseen([]); }

/** mark_item_seen: an unseen item selected. */
export function markItemSeen(itemID: number): void {
  const list = get(unseenCargo);
  if (list.includes(itemID)) setUnseen(list.filter((id) => id !== itemID));
}

/** remove_obsolete_unseen: the unseen items no longer in the cargo dropped. */
export function keepPresent(itemIDs: readonly number[]): void {
  const list = get(unseenCargo);
  const kept = list.filter((id) => itemIDs.includes(id));
  if (kept.length !== list.length) setUnseen(kept);
}
