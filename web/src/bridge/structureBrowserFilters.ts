// 3698585 Structure Browser browserUIConst and ExtraColumnProvider.
export const STATION_TYPE_FILTER = -3;

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
