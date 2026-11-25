import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
export interface NativeInventoryRow {
  readonly itemID: number;
  readonly typeID: number;
  readonly ownerID: number;
  readonly locationID: number;
  readonly flagID: number;
  readonly quantity: number;
  readonly categoryID: number | null;
}
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
export function corpDivisionFlag(division: number): number {
  if (!positive(division) || division > 7)
    throw Error("That is no division of a corporation's hangar.");
  return 114 + division;
}
/** Preserve every native row or refuse the observation; malformed data is never an empty hold. */
export function checkedInventory(raw: unknown): NativeInventoryRow[] {
  let v: any = raw;
  if (
    v?.type === "objectex1" &&
    v.header?.[0]?.value === "__builtin__.set" &&
    Array.isArray(v.header?.[1]) &&
    v.header[1].length === 1
  )
    v = v.header[1][0];
  if (v?.type !== "list" || !Array.isArray(v.items)) throw Error("Inventory list is unreadable.");
  const ids = new Set<number>();
  return v.items.map((entry: any) => {
    const row = entry?.type === "packedrow" ? entry.fields : entry;
    const quantity =
      row?.quantity === -1 || row?.quantity === -2
        ? (row.stacksize ?? 1)
        : (row?.quantity ?? row?.stacksize);
    if (
      !row ||
      !positive(row.itemID) ||
      !positive(row.typeID) ||
      !positive(row.ownerID) ||
      !positive(row.locationID) ||
      !Number.isSafeInteger(row.flagID) ||
      !positive(quantity) ||
      ids.has(row.itemID)
    )
      throw Error("Inventory row is malformed or repeated.");
    ids.add(row.itemID);
    return {
      itemID: row.itemID,
      typeID: row.typeID,
      ownerID: row.ownerID,
      locationID: row.locationID,
      flagID: row.flagID,
      quantity,
      categoryID: positive(row.categoryID) ? row.categoryID : null,
    };
  });
}
/** Read each ship hold through stock public inventory List, with identity and flag checked. */
export async function readNativeShipHolds(
  session: PilotSession,
  current: () => void,
  characterID: number,
  shipID: number,
  flags: readonly number[] = [5, 134, 135, 181, 182],
): Promise<readonly NativeInventoryRow[]> {
  if (!positive(characterID) || !positive(shipID)) throw Error("Invalid held pilot or ship.");
  const rows: NativeInventoryRow[] = [];
  const ids = new Set<number>();
  current();
  await session.flow.flying.bridgeDo("invCache", "InvalidateLocationCache", [shipID]);
  current();
  for (const flag of flags) {
    current();
    const raw = await session.flow.flying.bridgeAsk("invbroker", "List", [], { flag }, shipID);
    current();
    for (const row of checkedInventory(raw)) {
      if (
        row.ownerID !== characterID ||
        row.locationID !== shipID ||
        row.flagID !== flag ||
        ids.has(row.itemID)
      )
        throw Error("Inventory hold identity is uncertain.");
      ids.add(row.itemID);
      rows.push(row);
    }
  }
  return rows;
}
