// The drones window's own groups (droneGroupsController._DroneGroupsController, 3698585): named groups of the pilot's
// drones, each of one drone group only (droneGroupID; MoveToGroup refuses a mix with CannotMixDrones), kept in the
// client's settings (settings.user.ui "droneGroups") and so here in this browser. A favourite group per ship type
// (drones_favoriteGroupID_<shipTypeID>) is what CmdLaunchFavoriteDrones launches.
import { writable, get } from "svelte/store";

export interface DroneGroup {
  readonly label: string;
  readonly droneIDs: readonly number[];
  /** (groupname, wallclock time) as the client makes it; kept as "name|time". */
  readonly id: string;
  /** The drones' inventory group (the page names it by its group's name). */
  readonly droneGroupID: string;
}

const KEY = "evejs.ui.droneGroups";
const favoriteKey = (shipTypeID: number | null) => `evejs.ui.drones_favoriteGroupID_${shipTypeID ?? "None"}`;

function read(): Record<string, DroneGroup> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, DroneGroup>;
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}
function readFavorites(): Record<string, string> {
  const out: Record<string, string> = {};
  try { for (const k of Object.keys(localStorage)) if (k.startsWith("evejs.ui.drones_favoriteGroupID_")) out[k] = localStorage.getItem(k)!; } catch { /* none */ }
  return out;
}

/** The groups by name, and the favourites by setting name; written together so a window redraws on either. */
export const droneGroups = writable<{ groups: Record<string, DroneGroup>; favorites: Record<string, string> }>({ groups: read(), favorites: readFavorites() });

/** OnGroupsChanged / UpdateGroupSettings: the groups kept. */
function save(groups: Record<string, DroneGroup>): void {
  try { localStorage.setItem(KEY, JSON.stringify(groups)); } catch { /* they last the page */ }
  droneGroups.update((s) => ({ ...s, groups }));
}

/** GetDroneGroup: the group a drone is in, null where none. */
export function groupOf(groups: Record<string, DroneGroup>, droneID: number): DroneGroup | null {
  return Object.values(groups).find((g) => g.droneIDs.includes(droneID)) ?? null;
}

const without = (groups: Record<string, DroneGroup>, ids: readonly number[]) =>
  Object.fromEntries(Object.entries(groups).map(([name, g]) => [name, { ...g, droneIDs: g.droneIDs.filter((d) => !ids.includes(d)) }]));

/** RemoveFromGroup: the drones out of every group they are in (an emptied group stays, unseen, as in the client). */
export function removeFromGroup(ids: readonly number[]): void {
  save(without(get(droneGroups).groups, ids));
}

/** MoveToGroup: false (CannotMixDrones) where the group has drones of another drone group. */
export function moveToGroup(droneGroupID: string, name: string, ids: readonly number[]): boolean {
  const groups = get(droneGroups).groups;
  const group = groups[name];
  if (!group) return false;
  if (group.droneIDs.length && group.droneGroupID !== droneGroupID) return false;
  const next = without(groups, ids);
  const g = next[name]!;
  next[name] = { ...g, droneGroupID: g.droneIDs.length ? g.droneGroupID : droneGroupID, droneIDs: [...new Set([...g.droneIDs, ...ids])] };
  save(next);
  return true;
}

/** CreateSubGroup: the drones out of their groups and into a new one; a name taken gets _2, _3 ... */
export function createSubGroup(droneGroupID: string, ids: readonly number[], name: string): void {
  const next = without(get(droneGroups).groups, ids);
  let label = name;
  for (let i = 2; label in next; i++) label = `${name}_${i}`;
  next[label] = { label, droneIDs: [...ids], id: `${label}|${Date.now()}`, droneGroupID };
  save(next);
}

/** DeleteGroup: emptied and dropped. */
export function deleteGroup(name: string): void {
  const next = { ...get(droneGroups).groups };
  delete next[name];
  save(next);
}

/** GetFavoriteGroupID for the ship's type. */
export function favoriteGroupID(shipTypeID: number | null): string | null {
  return get(droneGroups).favorites[favoriteKey(shipTypeID)] ?? null;
}
/** SetFavoriteGroupID: the favourite set (null clears it). */
export function setFavoriteGroupID(shipTypeID: number | null, id: string | null): void {
  const key = favoriteKey(shipTypeID);
  try { if (id === null) localStorage.removeItem(key); else localStorage.setItem(key, id); } catch { /* lasts the page */ }
  droneGroups.update((s) => {
    const favorites = { ...s.favorites };
    if (id === null) delete favorites[key]; else favorites[key] = id;
    return { ...s, favorites };
  });
}

/**
 * eveCommands._GetDronesToLaunch: the favourite group's drones in the bay where any of its drones is in the bay or in
 * space, else every drone in the bay.
 */
export function dronesToLaunch(shipTypeID: number | null, bayIDs: readonly number[], spaceIDs: readonly number[]): number[] {
  const id = favoriteGroupID(shipTypeID);
  const group = id ? Object.values(get(droneGroups).groups).find((g) => g.id === id) : null;
  const present = group ? group.droneIDs.filter((d) => bayIDs.includes(d) || spaceIDs.includes(d)) : [];
  return present.length ? bayIDs.filter((d) => present.includes(d)) : [...bayIDs];
}

/** _DroneGroupsController.OnItemLaunch: a stack in a group launched, the drones it became are put in that group too. */
export function itemsLaunched(ids: ReadonlyMap<number, readonly number[]>): void {
  const groups = get(droneGroups).groups;
  let changed = false;
  const next = { ...groups };
  for (const [oldID, newIDs] of ids) {
    const g = groupOf(next, oldID);
    if (!g) continue;
    const add = newIDs.filter((id) => id !== oldID && !g.droneIDs.includes(id));
    if (!add.length) continue;
    next[g.label] = { ...g, droneIDs: [...g.droneIDs, ...add] };
    changed = true;
  }
  if (changed) save(next);
}
/** The controller registers for OnItemLaunch once (sm.RegisterNotify); here once per flow. */
const watched = new WeakSet<object>();
export function watchLaunches(flow: { onItemLaunch(listener: (ids: ReadonlyMap<number, readonly number[]>) => void): () => void }): void {
  if (watched.has(flow)) return;
  watched.add(flow);
  flow.onItemLaunch(itemsLaunched);
}

/** The drones window's drag payload (DronesDragData), for a drop outside the window: the 3D view's. */
export const DRONE_DRAG_TYPE = "application/x-evejs-drones";
/** The active ship's inventory items dragged out of its window (xtriui.InvItem drag data): each item and its type. */
export const INV_ITEMS_DRAG_TYPE = "application/x-evejs-inv-items";
export type InvItemsDragPayload = readonly { itemID: number; typeID: number }[];
/** Where an inventory drag's items lie (an InventoryPlace as JSON), for a drop that moves them (the HUD's cargo button). */
export const INV_FROM_DRAG_TYPE = "application/x-evejs-inv-from";
export interface DroneDragPayload { readonly section: "bay" | "space"; readonly ids: readonly number[] }
