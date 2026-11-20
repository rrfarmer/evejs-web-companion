import type { InventoryItemRow } from "../store/types.ts";
import type { Ask } from "./ask.ts";
import { decodeInventoryRowsChecked } from "./inventoryShip.ts";
import { isListValue, readDictEntry, readRowsetRows } from "./wire.ts";

// 3698585 inventorycommon.const and menucheckers.ItemChecker.OfferViewContents.
const CONTAINER_CATEGORIES = new Set([3, 6, 10, 23]);
const CONTAINER_GROUPS = new Set([12, 340, 448, 649, 4, 3, 5, 952, 1207]);

export function isAssetContentsContainer(categoryID: number | null, groupID: number | null): boolean {
  return groupID !== 29 && ((categoryID !== null && CONTAINER_CATEGORIES.has(categoryID)) ||
    (groupID !== null && CONTAINER_GROUPS.has(groupID)));
}

/** The remote list is a util.Rowset, with util.Row or ordinary tuple lines. */
export async function readContainerContents(ask: Ask, itemID: number, stationID: number): Promise<readonly InventoryItemRow[]> {
  const answer = await ask("invbroker", "GetContainerContents", [itemID, stationID]);
  const args = answer && typeof answer === "object" && "type" in answer && answer.type === "object" && "args" in answer
    ? answer.args : null;
  const header = readDictEntry(args, "columns") ?? readDictEntry(args, "header");
  const lines = readDictEntry(args, "lines");
  if (!isListValue(header) || !["itemID", "typeID", "locationID", "flagID", "quantity"]
    .every(column => header.items.includes(column)) || !isListValue(lines)) {
    throw new Error("The server did not return a container contents list.");
  }
  const rows = decodeInventoryRowsChecked({ type: "list", items: readRowsetRows(answer) });
  if (rows === null || rows.length !== lines.items.length || rows.some(row => row.locationID !== itemID || row.flagID === null)) {
    throw new Error("The server returned incomplete container contents.");
  }
  return rows.filter(row => row.flagID !== 57);
}

// eveCfg.GetShipFlagLocationName has no fallback label for an unlisted flag.
const BAY_LABELS: Readonly<Record<number, readonly [string, string]>> = {
  5: ["UI/Ship/CargoHold", "Cargo Hold"],
  87: ["UI/Ship/DroneBay", "Drone Bay"],
  90: ["UI/Ship/ShipMaintenanceBay", "Ship Maintenance Bay"],
  133: ["UI/Ship/FuelBay", "Fuel Bay"],
  134: ["UI/Ship/GeneralMiningHold", "Mining Hold"],
  135: ["UI/Ship/GasHold", "Gas Hold"],
  136: ["UI/Ship/MineralHold", "Mineral Hold"],
  137: ["UI/Ship/SalvageHold", "Salvage Hold"],
  138: ["UI/Ship/ShipHold", "Ship Hold"],
  139: ["UI/Ship/SmallShipHold", "Small Ship Hold"],
  140: ["UI/Ship/MediumShipHold", "Medium Ship Hold"],
  141: ["UI/Ship/LargeShipHold", "Large Ship Hold"],
  142: ["UI/Ship/IndustrialShipHold", "Industrial Ship Hold"],
  143: ["UI/Ship/AmmoHold", "Ammo Hold"],
  148: ["UI/Ship/CommandCenterHold", "Command Center Hold"],
  149: ["UI/Ship/PlanetaryCommoditiesHold", "Planetary Commodities Hold"],
  151: ["UI/Ship/MaterialBay", "Material Bay"],
  158: ["UI/Ship/FighterBay", "Fighter Bay"],
  179: ["UI/Ship/FrigateEscapeBay", "Frigate Escape Bay"],
  181: ["UI/Ship/IceHold", "Ice Hold"],
  182: ["UI/Ship/AsteroidHold", "Asteroid Hold"],
};

export function containerFlagLabel(flag: number | null): readonly [string, string] | undefined {
  if (flag === null) return undefined;
  if (flag >= 11 && flag <= 18) return ["UI/Ship/LowSlot", "Low Slot"];
  if (flag >= 19 && flag <= 26) return ["UI/Ship/MediumSlot", "Medium Slot"];
  if (flag >= 27 && flag <= 34) return ["UI/Ship/HighSlot", "High Slot"];
  if (flag >= 92 && flag <= 94) return ["UI/Ship/RigSlot", "Rig Slot"];
  if (flag >= 115 && flag <= 121) return ["UI/Corporations/Common/CorporateHangar", "Corporate Hangar"];
  if (flag >= 125 && flag <= 128) return ["UI/Ship/Subsystem", "Subsystem"];
  if (flag >= 159 && flag <= 163) return ["UI/Ship/FighterLaunchTube", "Fighter Launch Tube"];
  return BAY_LABELS[flag];
}
