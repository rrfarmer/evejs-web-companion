import type { MiningObjective } from "../shared/missionTypes.ts";
import { readAcceptedMission } from "../civilian/acceptedMission.ts";
/** Stable native mission identity used by completion and retained custody checks. */
export const miningIdentity = (o: MiningObjective) =>
  JSON.stringify([
    o.characterID,
    o.agentID,
    o.content.contentID,
    o.content.dungeonID,
    o.acceptTimestamp,
    o.systemID,
    o.position,
  ]);
const positive = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;

export function miningAcceptedMission(state: any) {
  const legacy = state?.version === 2 ? state : state?.legacy;
  const objective = state?.mission ?? legacy?.objective;
  if (
    state?.completed ||
    objective?.missionState !== 2 ||
    !objective.content ||
    objective.characterID !== state.characterID ||
    !positive(objective.characterID) ||
    !/^[1-9]\d*$/.test(objective.acceptTimestamp ?? "")
  )
    return null;
  // The older native runner could copy a player's active objective into mission.
  // The version-2 Mining macro only advanced past Accept for its own offer.
  if (
    !(typeof state.acceptedByRun === "string" && state.acceptedByRun) &&
    !(
      legacy?.version === 2 &&
      legacy.objective?.missionState === 2 &&
      miningIdentity(legacy.objective) === miningIdentity(objective)
    )
  )
    return null;
  return readAcceptedMission({
    agentID: objective.agentID,
    missionID: objective.content.contentID,
    key: miningIdentity(objective),
  });
}
/** Preserve full completed records while consuming legacy custody exactly once. */
export function rolloverMiningState(
  previous: any,
  legacy: any,
  characterID: number,
  setupKey: string,
): any {
  if (!positive(characterID) || !setupKey) throw Error("Mining state identity is invalid.");
  const fresh = (history: unknown[], legacyState: unknown) => ({
    version: 1,
    characterID,
    setupKey,
    shipID: null,
    agentID: null,
    mission: null,
    pending: null,
    completed: false,
    completedCount: 0,
    legacy: legacyState,
    history,
  });
  if (previous === null || previous === undefined) {
    if (legacy != null && legacy.characterID !== characterID)
      throw Error("Legacy Mining custody belongs to another pilot.");
    return fresh([], legacy ?? null);
  }
  if (
    typeof previous !== "object" ||
    previous.version !== 1 ||
    previous.characterID !== characterID
  )
    throw Error("Mining custody belongs to another pilot or is malformed.");
  if (
    typeof previous.completed !== "boolean" ||
    !Object.hasOwn(previous, "pending") ||
    !(
      previous.pending === null ||
      (previous.pending &&
        typeof previous.pending === "object" &&
        !Array.isArray(previous.pending) &&
        typeof previous.pending.kind === "string" &&
        previous.pending.kind)
    )
  )
    throw Error("Mining action custody is unknown; reconciliation is required.");
  if (previous.history !== undefined && !Array.isArray(previous.history))
    throw Error("Mining completion history needs reconciliation.");
  if (previous.completed !== true) return { ...previous, setupKey };
  if (previous.pending !== null || previous.legacy?.pending || previous.legacy?.cycle)
    throw Error(
      "The completed Mining record retains an unresolved action; reconciliation is required.",
    );
  const receipt = previous.completionReceipt,
    mission = previous.mission;
  if (
    previous.completedCount !== 1 ||
    !mission ||
    mission.characterID !== characterID ||
    !positive(previous.agentID) ||
    mission.agentID !== previous.agentID ||
    !positive(mission.content?.contentID) ||
    !positive(mission.content?.dungeonID) ||
    !positive(mission.systemID) ||
    !mission.position ||
    ![mission.position.x, mission.position.y, mission.position.z].every(Number.isFinite) ||
    !receipt ||
    receipt.agentID !== previous.agentID ||
    receipt.native?.completed !== true ||
    !Number.isFinite(receipt.at) ||
    receipt.at <= 0 ||
    !Array.isArray(receipt.journal?.active) ||
    !Array.isArray(receipt.journal?.offered) ||
    receipt.journal.active.some(
      (r: any) =>
        !positive(r?.agentID) ||
        !positive(r?.missionID) ||
        r.missionState !== 2 ||
        typeof r.missionKey !== "string" ||
        r.agentID === previous.agentID,
    ) ||
    receipt.journal.offered.some(
      (r: any) =>
        !positive(r?.agentID) ||
        !positive(r?.missionID) ||
        r.missionState !== 1 ||
        typeof r.missionKey !== "string" ||
        r.agentID === previous.agentID,
    )
  )
    throw Error("The completed Mining receipt is unknown; reconciliation is required.");
  let key: string;
  try {
    key = miningIdentity(mission);
  } catch {
    throw Error("The completed Mining identity is unreadable.");
  }
  if (receipt.mission !== key) throw Error("The completed Mining receipt names another mission.");
  const { history: oldHistory, ...completed } = previous;
  return fresh([...(oldHistory ?? []), structuredClone(completed)], null);
}
