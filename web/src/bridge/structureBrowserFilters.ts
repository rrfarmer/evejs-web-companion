import type { CorporationStructure } from "./structures.ts";

// 3698585 Structure Browser browserUIConst and ExtraColumnProvider.
export const STATION_TYPE_FILTER = -3;
export const LOW_POWER = 2;
export const ABANDONED = 3;
export const NO_REINFORCEMENT_WEEKDAY = 255;
export const DEFAULT_REINFORCEMENT_HOUR = 18;

const BLOCKED_DECOMMISSION_STATES = new Set([0, 1, 2, 101, 111, 112, 113, 114, 115, 116]);

export function structureDecommissionAction(row: CorporationStructure, corpRole: string | null): "start" | "cancel" | null {
  if ((BigInt(corpRole ?? "0") & 1n) === 0n) return null;
  if (row.unanchoring !== null) return "cancel";
  return BLOCKED_DECOMMISSION_STATES.has(row.state) ? null : "start";
}

export function isFlexStructure(typeID: number): boolean {
  return [35841, 35840, 37534, 81826].includes(typeID);
}

export function structureDecommissionSeconds(typeID: number): number {
  if (typeID === 81826) return 259_200;
  if (isFlexStructure(typeID)) return 2_700;
  return 604_800;
}

export const OWNED_STRUCTURE_STATES: Readonly<Record<number, string>> = {
  1: "Unanchored", 2: "Anchoring", 100: "Secure", 101: "Invulnerable", 102: "Onlining",
  110: "Vulnerable", 111: "Reinforced", 112: "Vulnerable", 113: "Reinforced",
  114: "Vulnerable", 115: "Vulnerable", 116: "Deploying", 118: "Invulnerable",
};

// FilterContControllerMyStructures excludes NPC and standard services.
export const OWNED_STRUCTURE_SERVICE_FILTERS: ReadonlySet<number> = new Set([4, 5, 6, 14, 15, 16, 17, 18, 20]);

export const STRUCTURE_TYPE_GROUPS = [
  { id: 1657, label: "Citadel", types: [
    { id: 35832, label: "Astrahus", ids: [35832] },
    { id: 35833, label: "Fortizar", ids: [35833, 47512, 47513, 47514, 47515, 47516] },
    { id: 35834, label: "Keepstar", ids: [35834, 40340] },
  ] },
  { id: 1404, label: "Engineering Complex", types: [
    { id: 35825, label: "Raitaru", ids: [35825] },
    { id: 35826, label: "Azbel", ids: [35826] },
    { id: 35827, label: "Sotiyo", ids: [35827] },
  ] },
  { id: 1406, label: "Refinery", types: [
    { id: 35836, label: "Tatara", ids: [35836] },
    { id: 35835, label: "Athanor", ids: [35835] },
  ] },
  { id: -2, label: "FLEX Structures", types: [
    { id: 35841, label: "Ansiblex Jump Bridge", ids: [35841] },
    { id: 35840, label: "Pharolux Cyno Beacon", ids: [35840] },
    { id: 37534, label: "Tenebrex Cyno Jammer", ids: [37534] },
    { id: 81826, label: "Metenox Moon Drill", ids: [81826] },
  ] },
] as const;

type ServiceDetailFormat = "access" | "percentage" | "isk" | "number";
interface ServiceDetailSetting {
  readonly path: string;
  readonly label: string;
  readonly format: ServiceDetailFormat;
}

const dockingAccess = { path: "UI/StructureSettings/DockingAccess", label: "Docking Access", format: "access" } as const;

export const STRUCTURE_SERVICE_DETAILS: ReadonlyMap<number, ServiceDetailSetting> = new Map<number, ServiceDetailSetting>([
  [2, dockingAccess],
  [4, { path: "UI/StructureSettings/ReprocessingTax", label: "Reprocessing Tax", format: "percentage" }],
  [5, { path: "UI/StructureSettings/MarketTax", label: "Market Tax", format: "percentage" }],
  [6, { path: "UI/StructureSettings/CloneBayTax", label: "Jump Clone Installation", format: "isk" }],
  [8, dockingAccess],
  [9, dockingAccess],
  [11, dockingAccess],
  [14, { path: "UI/StructureSettings/CanControlStructure", label: "Assume structure control", format: "number" }],
  [15, { path: "UI/StructureSettings/CanActivateJumpBridge", label: "Activate an Upwell Jump Bridge", format: "access" }],
  [16, { path: "UI/StructureSettings/CanConnectToCynoBeacon", label: "Link and jump to an Upwell Cynosural Beacon", format: "number" }],
  [18, { path: "UI/StructureSettings/CanAccessAutoMoonDrill", label: "Access moon materials from an Upwell Moon Drill", format: "number" }],
]);
