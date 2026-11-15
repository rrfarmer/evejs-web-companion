import type { FleetCompositionEntry, FleetMember } from "./boundFleet.ts";
import { FLEET_JOB_CREATOR } from "./fleetCommand.ts";
import { FLEET_ROLE } from "./fleetMemberMenu.ts";

export const BASE_UPWELL_JUMP_COST = 6364;

export function compositionID(id: number | string | null): number | null {
  const value = Number(id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** fleetSvc.IsMySubordinate and FleetComposition.LoadComposition. */
export function canSeeCompositionMember(viewer: FleetMember, member: FleetMember): boolean {
  return (viewer.job & FLEET_JOB_CREATOR) !== 0 || viewer.role === FLEET_ROLE.leader
    || (viewer.role === FLEET_ROLE.wingCmdr && String(viewer.wingID) === String(member.wingID))
    || (viewer.role === FLEET_ROLE.squadCmdr && String(viewer.squadID) === String(member.squadID));
}

/** FleetComposition.LoadSummary counts every composition entry and sums known base costs. */
export function summarizeFleetComposition(
  composition: readonly FleetCompositionEntry[],
  groupOf: (typeID: number) => number | null,
  costOf: (typeID: number) => number | undefined,
) {
  const countsByType = new Map<number, number>();
  let unknownShips = 0;
  for (const entry of composition) {
    const id = compositionID(entry.shipTypeID);
    if (id === null) {
      unknownShips++;
    } else {
      countsByType.set(id, (countsByType.get(id) ?? 0) + 1);
    }
  }

  const countsByGroup = new Map<number | null, number>();
  let totalCost = 0;
  const byType = [...countsByType].map(([typeID, count]) => {
    const groupID = groupOf(typeID);
    const cost = costOf(typeID);
    const jumpCost = cost === undefined ? null : cost * count;
    totalCost += jumpCost ?? 0;
    countsByGroup.set(groupID, (countsByGroup.get(groupID) ?? 0) + count);
    return { typeID, groupID, count, jumpCost };
  });
  const byGroup = [...countsByGroup].map(([groupID, count]) => ({ groupID, count }));
  return { byType, byGroup, unknownShips, totalCost };
}
