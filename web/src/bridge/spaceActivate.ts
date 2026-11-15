// A thing in space activated, as the client's menu service activates one (menusvc.py Activate, 2422 to 2454): the
// double click of a thing's own row where the client gives it (an objective's target: objective_task/target.py
// TargetTask.double_click).
//
//   the ship itself: a capsule stops (CmdStop); any other ship opens its cargo hold (OpenCargoHoldOfActiveShip);
//   within warp's least distance (minWarpDistance, by the surface; where the distance is not known, as near, since
//   Python 2 takes None for less than a number): a station within docking distance is docked at, a control bunker's
//   infrastructure hub opened, a container that is no mission container opened (CONTAINERGROUPS, menu/__init__.py),
//   and anything else approached (movementFunctions.ShipApproach);
//   beyond it: aligned to (AlignTo).
//
// The constants are the client's (eve/common/lib/appConst.py, inventorycommon/const.py).

/** appConst.minWarpDistance and maxDockingDistance, in metres. */
export const MIN_WARP_DISTANCE_M = 150_000;
export const MAX_DOCKING_DISTANCE_M = 50_000;
/** inventorycommon.const. */
const GROUP_CAPSULE = 29;
const GROUP_STATION = 15;
export const GROUP_CONTROL_BUNKER = 925;
const GROUP_MISSION_CONTAINER = 952;
/** menu.CONTAINERGROUPS: wreck, cargo, spawn, spew, secure, audit log and freight containers, overseer's belongings, mission container. */
const CONTAINER_GROUPS: ReadonlySet<number> = new Set([186, 12, 306, 1207, 340, 448, 649, 496, GROUP_MISSION_CONTAINER]);

/** Whether a thing's group is one of the client's containers (menucheckers baseCheckers.IsContainer), for Open Cargo. */
export function isContainerGroup(groupID: number | null | undefined): boolean {
  return groupID !== null && groupID !== undefined && CONTAINER_GROUPS.has(groupID);
}

export type ActivateStep = "stop" | "openCargoHold" | "dock" | "openInfrastructureHub" | "openCargo" | "approach" | "alignTo";

/** What activating a thing does: `shipGroupID` the pilot's ship's group, `surfaceDistance` from it in metres or null. */
export function activateStep(
  thing: { readonly groupID: number | null; readonly isSelf: boolean },
  shipGroupID: number | null,
  surfaceDistance: number | null,
): ActivateStep {
  if (thing.isSelf) return shipGroupID === GROUP_CAPSULE ? "stop" : "openCargoHold";
  if (surfaceDistance === null || surfaceDistance < MIN_WARP_DISTANCE_M) {
    if (thing.groupID === GROUP_STATION && (surfaceDistance === null || surfaceDistance < MAX_DOCKING_DISTANCE_M)) return "dock";
    if (thing.groupID === GROUP_CONTROL_BUNKER) return "openInfrastructureHub";
    if (thing.groupID !== null && thing.groupID !== GROUP_MISSION_CONTAINER && CONTAINER_GROUPS.has(thing.groupID)) return "openCargo";
    return "approach";
  }
  return "alignTo";
}
