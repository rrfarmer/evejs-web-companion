import type { DogmaAttribute } from "./boundDogma.ts";

export const BASE_UPWELL_JUMP_COST = 6364;
export const BASE_WARP_SPEED = 1281;
export const WARP_SPEED_MULTIPLIER = 600;

/** PanelAttributes.get_ship_attributes, in the order used by the 24.02 ship window. */
export const SHIP_INFO_GROUPS: readonly {
  readonly label: string; readonly title: string; readonly icon: string;
  readonly attributes: readonly number[]; readonly resistance?: readonly number[];
}[] = [
  { label: "UI/Common/Shield", title: "Shield", icon: "category_icons/shields", attributes: [263, 479, 2034], resistance: [271, 274, 273, 272] },
  { label: "UI/Common/Armor", title: "Armor", icon: "category_icons/armor", attributes: [265, 2035], resistance: [267, 270, 269, 268] },
  { label: "UI/Fitting/Structure", title: "Structure", icon: "system_icons/inventory", attributes: [9, 2036], resistance: [113, 110, 109, 111] },
  { label: "UI/Fitting/FittingWindow/Capacitor", title: "Capacitor", icon: "system_icons/capacitor_plus", attributes: [482, 55] },
  { label: "UI/Fitting/Navigation", title: "Navigation", icon: "control_icons/warp_to", attributes: [37, 4, 70, BASE_UPWELL_JUMP_COST, BASE_WARP_SPEED] },
  { label: "UI/Fitting/FittingWindow/Targeting", title: "Targeting", icon: "control_icons/target", attributes: [76, 54, 192, 552, 620, 564, 209, 210, 208, 211, 154, 158, 160, 5796] },
  { label: "UI/Drones/Drones", title: "Drones", icon: "category_icons/drones", attributes: [283, 1271] },
  { label: "UI/Neocom/InventoryBtn", title: "Inventory", icon: "system_icons/inventory", attributes: [161, 38, 3020, 1573, 1557, 3136, 1564, 1563, 1562, 1558, 1556, 3227, 1559, 1560, 1561, 1646, 1653, 2675, 2467, 2657, 5325, 5646, 5944] },
  { label: "UI/Common/EWarResistances", title: "EWar Resistances", icon: "system_icons/capacitor_warfare", attributes: [2253, 2135, 2116, 2045, 2112, 2115, 2114, 2113] },
  { label: "UI/InfoWindow/SharedFacilities", title: "Shared Facilities", icon: "system_icons/shared_folder", attributes: [912, 908, 979, 3105] },
  { label: "UI/InfoWindow/FighterFacilities", title: "Fighter Facilities", icon: "category_icons/drones", attributes: [2055, 2216, 2217, 2218, 2219, 2737, 2738, 2739] },
  { label: "UI/InfoWindow/OnDeath", title: "On Death", icon: "system_icons/inventory", attributes: [2275, 2276, 2271, 2272, 2273, 2274] },
  { label: "UI/InfoWindow/JumpDriveSystems", title: "Jump Drive Systems", icon: "control_icons/broadcast_warp_to_jump_beacon", attributes: [898, 867, 866, 868, 869, 1005, 1001, 1002, 1549, 3131, 3133] },
];

/** An inspected ship's loaded dogma can modify a row that exists on its type. */
export function shipInfoValues(
  base: readonly (readonly [number, number | null])[],
  live: readonly DogmaAttribute[] = [],
): ReadonlyMap<number, number> {
  const result = new Map<number, number>();
  for (const [id, value] of base) if (value !== null && Number.isFinite(value)) result.set(id, value);
  for (const { attributeID, value } of live) {
    if (result.has(attributeID) && typeof value === "number" && Number.isFinite(value)) result.set(attributeID, value);
  }
  // Info.GetBaseWarpSpeed constructs this row from base warp speed and its multiplier.
  result.set(BASE_WARP_SPEED, Math.max(1, result.get(BASE_WARP_SPEED) ?? 3) * (result.get(WARP_SPEED_MULTIPLIER) ?? 1));
  return result;
}
