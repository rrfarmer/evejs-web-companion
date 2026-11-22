// inventorySvc's temporary inventory locations (AddTemporaryInvLocation): a can or a wreck opened in space
// (menusvc._OpenCargo, for a thing with no cargo bay component of its own) stays a root entry of the inventory windows'
// trees (invWindow.ProcessTempInvLocationAdded, after the ship's own) until its remove button takes it away
// (RemoveTemporaryInvLocation byUser) or it leaves the grid.
import { writable } from "svelte/store";

export const tempInvLocations = writable<readonly number[]>([]);

/** The temporary location the Active ship cargo window's tree is showing: its read opens no window of its own. */
export const treeShownContainer = writable<number | null>(null);

export function addTempInvLocation(itemID: number): void {
  tempInvLocations.update((ids) => (ids.includes(itemID) ? ids : [...ids, itemID]));
}

export function removeTempInvLocation(itemID: number): void {
  tempInvLocations.update((ids) => ids.filter((id) => id !== itemID));
}
