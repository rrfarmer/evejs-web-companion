import type { MiningOperationAssignment } from "./scriptConditions.ts";
import type { ScriptAction } from "./scriptDecide.ts";

/** A target claim and hosted operation run, not a remembered destination. */
export function defenderSiteIdentity(operation: MiningOperationAssignment | null | undefined): string | null {
  const target = operation?.currentTarget;
  return operation?.role === "DEFENDER" && !operation.stopRequested && operation.operationRunID && target &&
    target.claimedByOperationID === operation.operationID && ["RESERVED", "ACTIVE"].includes(target.state) &&
    operation.area.targetClasses.includes(target.targetType)
    ? `${operation.operationID}:${operation.operationRunID}:${target.targetKey}` : null;
}

/** Cleanup may retire old owned state; new work must use the fresh exact site. */
export function defenderActionCurrent(expected: MiningOperationAssignment, current: MiningOperationAssignment | null,
  action: ScriptAction): boolean {
  if (["deactivate", "recallDrones", "unlock", "stopShip"].includes(action.kind) ||
      action.kind === "callPrimary" && action.targetID === null) return true;
  const identity = defenderSiteIdentity(expected);
  return identity !== null && identity === defenderSiteIdentity(current);
}
