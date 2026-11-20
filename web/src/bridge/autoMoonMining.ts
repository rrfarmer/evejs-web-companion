import { filetimeToUnixMs } from "./activity.ts";
import { moonMiningID } from "./moonMining.ts";
import { readDictEntry, readDictPairs, unwrapLong, unwrapReal } from "./wire.ts";
import type { CapacityInfo, InventoryItemRow } from "../store/types.ts";

export const METENOX_TYPE_ID = 81826;
export const METENOX_ACCESS_SETTING = 36;
export const METENOX_CONTROL_SETTING = 17;
export const METENOX_BOARD_RANGE = 6_550;
export const METENOX_DEPOSIT_RANGE = 10_000;
export const METENOX_MATERIAL_RANGE = 2_500;
export const METENOX_FUEL_FLAG = 172;
export const METENOX_DRILL_SLOT = 164;
export const METENOX_DRILL_TYPE_ID = 82941;
export const METENOX_GAS_TYPE_ID = 81143;
export const FUEL_BLOCK_GROUP_ID = 1136;
// Build 3698585 inventorycommon.const.cargoHoldsValidForDeliveryService.
export const CARGO_DEPOSIT_FLAGS: ReadonlySet<number> = new Set([5, 90, 133, 134, 135, 136, 143, 148, 149, 154,
  155, 174, 176, 177, 181, 182, 183, 185, 188]);
// Build 3698585 spacecomponentsbytype for 81826 and module 82941's attribute 2109.
export const METENOX_CYCLE_SECONDS = 3600;
export const METENOX_GAS_PER_CYCLE = 200;
export const METENOX_BLOCKS_PER_HOUR = 5;

export interface AutoMoonMiner {
  readonly id: number;
  readonly name: string;
  readonly ownerID: number;
  readonly solarSystemID: number;
}

export interface MoonMaterialBay {
  readonly structureID: number;
  readonly shipID: number;
  readonly rows: readonly InventoryItemRow[];
  readonly capacity: CapacityInfo | null;
}

export interface AutoMoonDetails {
  readonly moonID: number;
  readonly nextHarvestAtMs: number | null;
  readonly fuel: ReadonlyMap<number, number>;
  readonly materials: ReadonlyMap<number, number>;
  readonly remainingCapacity: number;
  readonly nowMs: number;
}

export function decodeAutoMoonQuantities(value: unknown): ReadonlyMap<number, number> {
  if (value === null || typeof value !== "object" || !("type" in value) || value.type !== "dict"
    || !("entries" in value) || !Array.isArray(value.entries)) {
    throw new Error("The moon drill returned an unreadable quantity list.");
  }
  const amounts = new Map<number, number>();
  for (const [key, raw] of readDictPairs(value)) {
    const id = moonMiningID(key);
    const amount = Number(unwrapLong(raw));
    if (id !== null && Number.isSafeInteger(amount) && amount > 0) amounts.set(id, amount);
  }
  return amounts;
}

export function decodeAutoMoonDetails(value: unknown, nowMs: number): AutoMoonDetails {
  const moonID = moonMiningID(readDictEntry(value, "moonID"));
  const remainingCapacity = unwrapReal(readDictEntry(value, "remainingOutputBayCapacity"));
  const next = readDictEntry(value, "nextHarvestTime");
  const nextHarvestAtMs = filetimeToUnixMs(unwrapLong(next));
  if (moonID === null || remainingCapacity === null || remainingCapacity < 0 || (next !== null && nextHarvestAtMs === null)) {
    throw new Error("The moon drill returned unreadable mining details.");
  }
  return { moonID, nextHarvestAtMs, remainingCapacity, nowMs,
    fuel: decodeAutoMoonQuantities(readDictEntry(value, "availableFuel")),
    materials: decodeAutoMoonQuantities(readDictEntry(value, "outputMaterials")) };
}

export function autoMoonStatus(details: AutoMoonDetails): "Stopped" | "Low Gas" | "Output Bay Full" | "Operational" {
  if (details.nextHarvestAtMs === null) return "Stopped";
  if ((details.fuel.get(METENOX_GAS_TYPE_ID) ?? 0) < METENOX_GAS_PER_CYCLE) return "Low Gas";
  return details.remainingCapacity === 0 ? "Output Bay Full" : "Operational";
}
