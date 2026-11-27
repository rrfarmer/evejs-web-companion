import { readDictPairs, unwrapLong } from "./wire.ts";

export interface FleetLootEntry {
  readonly characterID: number;
  readonly typeID: number;
  readonly solarSystemID: number | null;
  readonly quantity: number;
  readonly atMs: number;
}

export function decodeFleetLoot(payload: unknown, solarSystemID: number | null, atMs: number): FleetLootEntry[] {
  return readDictPairs(payload).flatMap(([key, rawQuantity]) => {
    const tuple = key as unknown;
    const ids = Array.isArray(tuple) ? tuple
      : tuple && typeof tuple === "object" && "items" in tuple && Array.isArray(tuple.items) ? tuple.items : [];
    const characterID = Number(unwrapLong(ids[0])), typeID = Number(unwrapLong(ids[1]));
    const quantity = Number(unwrapLong(rawQuantity));
    const valid = [characterID, typeID, quantity].every(value => Number.isSafeInteger(value) && value > 0);
    return ids.length === 2 && valid ? [{ characterID, typeID, solarSystemID, quantity, atMs }] : [];
  });
}

/** FleetSvc.OnFleetLootEvent combines matching stacks without moving their entries. */
export function mergeFleetLoot(history: readonly FleetLootEntry[], arrivals: readonly FleetLootEntry[]): FleetLootEntry[] {
  const rows = [...history];
  for (const entry of arrivals) {
    const index = rows.findIndex(row => row.characterID === entry.characterID && row.typeID === entry.typeID && row.solarSystemID === entry.solarSystemID);
    if (index < 0) rows.unshift(entry);
    else rows[index] = { ...entry, quantity: rows[index]!.quantity + entry.quantity };
  }
  return rows.slice(0, 500);
}

export const FLEET_LOOT_HEADER = "Time\tCharacter\tItem Type\tQuantity\tItem Group";

export function fleetLootTime(atMs: number, seconds = false): string {
  const stamp = new Date(atMs).toISOString();
  return `${stamp.slice(0, 10).replaceAll("-", ".")} ${stamp.slice(11, seconds ? 19 : 16)}`;
}

export function fleetLootFile(rows: readonly FleetLootEntry[], nowMs: number,
  names: (kind: "character" | "type" | "typeGroup", id: number) => string): { filename: string; text: string } {
  const lines = rows.map(row => [fleetLootTime(row.atMs), names("character", row.characterID),
    names("type", row.typeID), row.quantity, names("typeGroup", row.typeID), ""].join("\t"));
  return { filename: `Loot - ${fleetLootTime(nowMs, true).replaceAll(":", ".")}.txt`,
    text: [FLEET_LOOT_HEADER, ...lines, "", ""].join("\r\n") };
}
