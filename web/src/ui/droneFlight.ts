// Which drones this hull may actually order — the R33 gate, as a pure function.
//
// ⚠ IT IS A MODULE BECAUSE TWO PANELS NEED IT NOW. The drones window commands
// the flight; the overview's threat strip has a "Send drones" on each hostile
// row. Both have to answer the same question — "which of these drones will the
// server obey?" — and two copies of that answer would not diverge loudly. They
// would diverge in ONE branch: the `null` one, where the snapshot did not carry
// a drone and neither panel can tell. That is the branch a second copy gets
// wrong, and the failure is a group order that quietly acts on fewer drones
// than the player is looking at.

import { canMyShipOrderDrone } from "../space/overview.ts";
import { droneRoleForGroup } from "../nav/droneRoles.ts";
import type { DroneInSpace, SpaceEntity } from "../store/types.ts";

/**
 * The ids a group order may be sent with.
 *
 * ⚠ THIS INCLUDES THE ONES WE CANNOT JUDGE, and that is the point. Only a drone
 * we have POSITIVELY established is not ours to fly is dropped:
 *
 *   • `controlled === false` is the BFF's own answer, always present, and hard.
 *   • `canMyShipOrderDrone` reads the SNAPSHOT, which may simply not carry the
 *     drone's row — and then honestly answers `null`, "cannot tell". A `null`
 *     keeps the drone IN, because "we could not check" must never quietly
 *     narrow what a group order does.
 *
 * A `null` list of drones in space is "we could not look", which is not "none":
 * it yields no ids, and the caller is expected to say so in words rather than
 * drawing an empty flight.
 */
export function orderableDroneIDs(
  dronesInSpace: readonly DroneInSpace[] | null,
  entities: readonly SpaceEntity[] | null,
  myShipID: number | null,
): readonly number[] {
  if (dronesInSpace === null) {
    return [];
  }
  const byID = new Map<number, SpaceEntity>();
  for (const entity of entities ?? []) {
    byID.set(entity.itemID, entity);
  }
  return dronesInSpace
    .filter((drone) => {
      if (drone.controlled === false) {
        return false;
      }
      return canMyShipOrderDrone(byID.get(drone.itemID) ?? null, myShipID) !== false;
    })
    .map((drone) => drone.itemID);
}

/**
 * The salvage drones among those a group order may act on: the ones a salvage order is for.
 *
 * The client offers Salvage for a drone its ship controls that is a salvage drone, and for no other
 * (droneCheckers.OfferSalvage: the item's group is groupSalvageDrone). The page knows a drone's kind by its
 * group's name, once that has been read; `groupNameOf` answers null or an empty name until then, and a drone
 * whose kind is not known is not taken for one.
 */
export function salvageDroneIDs(
  orderable: readonly number[],
  dronesInSpace: readonly DroneInSpace[] | null,
  groupNameOf: (typeID: number) => string | null,
): readonly number[] {
  if (dronesInSpace === null) {
    return [];
  }
  const mayOrder = new Set(orderable);
  return dronesInSpace
    .filter((drone) => mayOrder.has(drone.itemID) && drone.typeID !== null && droneRoleForGroup(groupNameOf(drone.typeID)) === "salvage")
    .map((drone) => drone.itemID);
}
