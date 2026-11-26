import { isListValue, readDictPairs, readKeyVal, unwrapLong, unwrapReal, type JsonValue } from "./wire.ts";

export interface ProfileSettingRow {
  readonly settingID: number;
  readonly groupID: number;
  readonly value: number | boolean | string;
}

export interface ProfileSettingDefinition {
  readonly id: number;
  readonly label: string;
  readonly fallback: string;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: "%" | "ISK";
}

const access = (id: number, label: string, fallback: string): ProfileSettingDefinition =>
  ({ id, label: `UI/StructureSettings/${label}`, fallback });
const tax = (id: number, label: string, fallback: string, max = 10, step = 0.01): ProfileSettingDefinition =>
  ({ ...access(id, label, fallback), max, step, unit: "%" });
const isk = (id: number, label: string, fallback: string, max: number): ProfileSettingDefinition =>
  ({ ...access(id, label, fallback), max, step: 1, unit: "ISK" });

export const PROFILE_SETTING_CATEGORIES = [
  { id: 1004, label: "ServiceDocking", fallback: "Docking", settings: [access(19, "DockingAccess", "Docking Access")] },
  { id: 1009, label: "ServiceCorpOffices", fallback: "Corporation Offices", settings: [isk(20, "CorpOffice", "Office Rental", 1e9)] },
  { id: 1003, label: "ServiceDefense", fallback: "Control", settings: [access(17, "CanControlStructure", "Assume structure control")] },
  { id: 1011, label: "ServiceCloneBay", fallback: "Clone Bay", settings: [isk(23, "CloneBayTax", "Clone Bay Tax", 1e8)] },
  { id: 1012, label: "ServiceIndustry", fallback: "Industry", settings: [
    tax(26, "ReactionsBiochemical", "Biochemical Reactions"),
    tax(27, "ReactionsHybrid", "Hybrid Reactions"),
    tax(28, "ReactionsComposite", "Composite Reactions"),
    tax(29, "ManufacturingTax", "Manufacturing Tax"),
    tax(30, "ManufacturingCapitalTax", "Capital Manufacturing Tax"),
    tax(31, "ManufacturingSuperCapitalTax", "Supercapital Manufacturing Tax"),
    tax(32, "ResearchTax", "Research Tax"),
    tax(33, "InventionTax", "Invention Tax"),
    access(36, "CanAccessAutoMoonDrill", "Automated Moon Drill Access"),
  ] },
  { id: 1008, label: "ServiceMarket", fallback: "Market", settings: [tax(4, "MarketTax", "Market Tax", 11.5, 0.1)] },
  { id: 1013, label: "ServiceNavigation", fallback: "Navigation", settings: [
    access(34, "CanActivateJumpBridge", "Activate Jump Bridge"),
    access(35, "CanConnectToCynoBeacon", "Connect to Cyno Beacon"),
  ] },
  { id: 1010, label: "ServiceReprocessing", fallback: "Reprocessing", settings: [tax(3, "ReprocessingTax", "Reprocessing Tax", 50, 0.1)] },
] as const;

export function profileSettingSignature(rows: readonly ProfileSettingRow[]): string {
  return JSON.stringify([...rows].sort((a, b) => a.settingID - b.settingID || a.groupID - b.groupID)
    .map(row => [row.settingID, row.value, row.groupID]));
}

export function decodeProfileSettingRows(reply: JsonValue): ProfileSettingRow[] {
  if (!reply || typeof reply !== "object" || !("type" in reply) || reply.type !== "dict") {
    throw new Error("The server did not return profile settings.");
  }
  return readDictPairs(reply).flatMap(([key, groups]) => {
    const settingID = Number(unwrapLong(key));
    if (!Number.isSafeInteger(settingID) || settingID <= 0 || !isListValue(groups)) {
      throw new Error("A profile setting could not be read.");
    }
    return groups.items.map(group => {
      const groupID = Number(unwrapLong(readKeyVal(group, "groupID")) ?? NaN);
      const raw = readKeyVal(group, "value");
      const value = typeof raw === "boolean" || typeof raw === "string" ? raw : unwrapReal(raw);
      if (!Number.isSafeInteger(groupID) || groupID < 0 || value === null) {
        throw new Error("A profile access list could not be read.");
      }
      return { settingID, groupID, value };
    });
  });
}
