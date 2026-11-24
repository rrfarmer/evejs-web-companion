// The client's Neocom inventory badging (neocomInventoryBadging.NeocomInventoryBadging, 3698585). One storage is
// tracked at a time (_get_current_inventory): docked in a station its hangar - the ships hangar (StationShips) and
// the items hangar (StationItems), flagHangar, a ship by its category - and in space the active ship's cargo
// (ShipCargo, flagCargo). An item is new when the server made it (its location before was locationAbstract), when it
// was handed over from the system owner or another character, or when it was crate loot - unless it is mined ore,
// ammo, salvage or PLEX from the vault (customInfo), the pilot's ship or capsule, an emptied or removed stack,
// something come in from space or from the ship itself; and never while an Inventory window is open on that storage.
// The unseen ones are kept per storage as the client keeps settings.char.unseenInventoryItems
// ('<location>_<storageID>'); the Inventory button is important with UI/Neocom/UnseenItemsHint while there are any, a
// location's tree entry carries its tag and each unseen item its line. A location is seen when the Inventory shows
// another place after it or is closed (OnInventoryContainerShown / OnInventoryClosed / OnStationServicesHangarDeselected),
// an item when it is selected (InvItem.Select -> MarkAsSeen).
import { writable, derived, get } from "svelte/store";
import { readDictPairs, readRowField } from "../bridge/wire.ts";

const FLAG_HANGAR = 4;
const FLAG_CARGO = 5;
const FLAG_CRATE_LOOT = 174;
const LOCATION_ABSTRACT = 0;
const LOCATION_JUNKYARD = 10;
const OWNER_SYSTEM = 1;
const GROUP_CAPSULE = 29;
const CATEGORY_SHIP = 6;
const IX_OWNER = 2, IX_LOCATION = 3, IX_FLAG = 4;

/** INVENTORY_ID_SHIP_CARGO, INVENTORY_ID_STATION_ITEMS, INVENTORY_ID_STATION_SHIPS. */
export type BadgePlace = "ShipCargo" | "StationItems" | "StationShips";
interface Unseen { readonly itemID: number; readonly place: BadgePlace }

/** The storage tracked: the ship flown in space, or the station docked in. */
export const badgedStorage = writable<{ readonly kind: "ship" | "station"; readonly id: number } | null>(null);
/** Every unseen item of the tracked storage, with its location. */
export const unseenItems = writable<readonly Unseen[]>([]);
/** The unseen items of the ship's cargo (the space Inventory window's tags). */
export const unseenCargo = derived(unseenItems, (all) => all.filter((u) => u.place === "ShipCargo").map((u) => u.itemID));
/** Inventory windows open (Inventory.IsOpenByWindowClass). */
export const inventoryWindowsOpen = writable(0);

const key = (storage: { kind: string; id: number }) => `evejs.unseenInventoryItems.${storage.kind === "ship" ? "ShipCargo" : "Station"}_${storage.id}`;
function load(storage: { kind: "ship" | "station"; id: number }): Unseen[] {
  try {
    const v = JSON.parse(localStorage.getItem(key(storage)) ?? "[]");
    if (!Array.isArray(v)) return [];
    // (a cargo kept by an earlier page: its ids alone)
    return v.flatMap((e): Unseen[] => typeof e === "number" ? [{ itemID: e, place: "ShipCargo" }]
      : e && typeof e.itemID === "number" && typeof e.place === "string" ? [{ itemID: e.itemID, place: e.place as BadgePlace }] : []);
  } catch { return []; }
}
function save(list: readonly Unseen[]): void {
  const storage = get(badgedStorage);
  if (!storage) return;
  try { if (list.length) localStorage.setItem(key(storage), JSON.stringify(list)); else localStorage.removeItem(key(storage)); } catch { /* none kept */ }
}
function setUnseen(list: readonly Unseen[]): void { unseenItems.set(list); save(list); }

/** start_tracking: the station docked in, else the ship flown (null for neither); the ship itself is seen. */
export function trackStorage(storage: { kind: "ship" | "station"; id: number } | null): void {
  const now = get(badgedStorage);
  if (now?.kind === storage?.kind && now?.id === storage?.id) return;
  badgedStorage.set(storage);
  unseenItems.set(storage === null ? [] : load(storage).filter((u) => !(storage.kind === "ship" && u.itemID === storage.id)));
}
/** (the space-only name it had) */
export function trackShip(shipID: number | null): void { trackStorage(shipID === null ? null : { kind: "ship", id: shipID }); }

const isSolarSystem = (id: number) => id >= 30000000 && id <= 32999999;
const isCharacter = (id: number) => (id >= 3000000 && id < 4000000) || (id >= 90000000 && id < 98000000)
  || (id >= 100000000 && id <= 2147483647);

/**
 * process_item_change for one item of an OnItemChange / OnItemsChanged: marks it unseen or seen in the tracked storage.
 * `inventoryOpen` is Inventory.IsOpenByWindowClass(); `charID` the pilot; `shipID` the ship flown or boarded.
 */
export function itemChanged(row: unknown, change: unknown, inventoryOpen: boolean, charID: number | null, shipID: number | null = null): void {
  const storage = get(badgedStorage);
  if (storage === null) return;
  const num = (k: string) => Number(readRowField(row, k));
  const itemID = num("itemID"), flagID = num("flagID"), locationID = num("locationID");
  if (!Number.isFinite(itemID)) return;
  const was = new Map<number, number>();
  for (const [k, v] of readDictPairs(change)) was.set(Number(k), Number(v));
  const list = get(unseenItems);
  const drop = () => { if (list.some((u) => u.itemID === itemID)) setUnseen(list.filter((u) => u.itemID !== itemID)); };
  // _get_item_location: the place of the storage tracked, or none
  const place: BadgePlace | null = storage.kind === "ship"
    ? (flagID === FLAG_CARGO && locationID === storage.id ? "ShipCargo" : null)
    : (flagID === FLAG_HANGAR && locationID === storage.id ? (num("categoryID") === CATEGORY_SHIP ? "StationShips" : "StationItems") : null);
  if (place === null) { drop(); return; }
  const ship = storage.kind === "ship" ? storage.id : shipID;
  let custom = "";
  try { custom = JSON.stringify(readRowField(row, "customInfo") ?? null); } catch { /* none */ }
  const automatic = was.get(IX_LOCATION) === LOCATION_ABSTRACT;
  const seen = (automatic && num("groupID") === GROUP_CAPSULE)
    || itemID === ship
    || /isPlexFromVault|isMined|isAmmo|isSalvaged/.test(custom)
    || (num("quantity") === 0 && num("stacksize") === 0)
    || locationID === LOCATION_JUNKYARD
    || (was.has(IX_LOCATION) && isSolarSystem(was.get(IX_LOCATION)!))
    || (ship !== null && was.has(IX_LOCATION) && was.get(IX_LOCATION) === ship);
  const prevOwner = was.get(IX_OWNER);
  const fresh = automatic
    || prevOwner === OWNER_SYSTEM
    || (prevOwner !== undefined && prevOwner !== charID && isCharacter(prevOwner))
    || was.get(IX_FLAG) === FLAG_CRATE_LOOT;
  const unseen = !inventoryOpen && !seen && fresh;
  if (unseen && !list.some((u) => u.itemID === itemID)) setUnseen([...list, { itemID, place }]);
  else if (!unseen) drop();
}

/** mark_items_seen_in_location: a location shown and left, or its window closed. */
export function markPlaceSeen(place: BadgePlace): void {
  const list = get(unseenItems);
  if (list.some((u) => u.place === place)) setUnseen(list.filter((u) => u.place !== place));
}
/** mark_items_seen_in_location('ShipCargo'). */
export function markCargoSeen(): void { markPlaceSeen("ShipCargo"); }

/** mark_item_seen: an unseen item selected. */
export function markItemSeen(itemID: number): void {
  const list = get(unseenItems);
  if (list.some((u) => u.itemID === itemID)) setUnseen(list.filter((u) => u.itemID !== itemID));
}

