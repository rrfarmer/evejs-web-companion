import type { Ask } from "./ask.ts";
import { isListValue, readRowField, unwrapLong } from "./wire.ts";

// 3698585 repackaging.CanRepackageType and invItemFunctions.CheckRepackageItems.
export const ACADEMY_TYPE_LIST_ID = 992;
const REPACKABLE_CATEGORIES = new Set([23, 6, 18, 7, 32, 40, 22, 65, 66, 87, 34, 39]);
const CONTAINER_GROUPS = new Set([12, 340, 448, 649]);
const REPACKABLE_GROUPS = new Set([...CONTAINER_GROUPS, 332, 361, 1889, 1888, 1890, 4097]);

export function canRepackageAssetType(typeID: number, categoryID: number | null, groupID: number | null, dynamic: boolean): boolean {
  return typeID !== 3468 && !dynamic && groupID !== null &&
    (REPACKABLE_GROUPS.has(groupID) || (groupID !== 29 && categoryID !== null && REPACKABLE_CATEGORIES.has(categoryID)));
}

export function warnsAboutContainerContents(groupID: number | null): boolean {
  return groupID !== null && CONTAINER_GROUPS.has(groupID);
}

export async function insuredAssetShips(ask: Ask): Promise<ReadonlySet<number>> {
  const answer = await ask("insuranceSvc", "GetContracts", []);
  if (!isListValue(answer)) throw new Error("The ship insurance contracts could not be read.");
  return new Set(answer.items.map(row => Number(unwrapLong(readRowField(row, "shipID")))));
}

/** RepackageItems takes a station-keyed dict of lists of (itemID, locationID) tuples. */
export async function repackagePersonalHangar(act: Ask, stationID: number, itemIDs: readonly number[], destroyable = false): Promise<void> {
  await act("repackagingSvc", "RepackageItems", [{
    type: "dict", entries: [[stationID, { type: "list", items: itemIDs.map(itemID => [itemID, stationID]) }]],
  }], destroyable ? { destroyable: true } : undefined);
}
