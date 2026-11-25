import type { MissionRewardReadout } from "../shared/rewards/index.ts";
/** The existing completion record identifies the exact Complete invocation. */
export interface DistributionCompletionReceipt {
  readonly kind: "missionCompletion";
  readonly runID: string;
  readonly invocationID: number;
  readonly stepPath: string;
  readonly agentID: number;
  readonly actionID: number;
  readonly missionKey: string;
  readonly completed: true;
}
/** The host binds the exact mission and validates completion before reporting it. */
export function createDistributionProgress() {
  let expected: { runID: string; agentID: number; missionKey: string } | null = null;
  const completedKeys = new Set<string>();
  let completed: DistributionCompletionReceipt | null = null,
    count = 0,
    reward: MissionRewardReadout | null = null;
  return {
    bindAccepted(runID: string, agentID: number, missionKey: string) {
      if (!runID || !Number.isSafeInteger(agentID) || agentID <= 0 || !missionKey)
        throw new Error("Invalid Distribution mission identity.");
      if (completedKeys.has(missionKey))
        throw new Error("Completed Distribution mission cannot be rebound.");
      if (completed) {
        expected = null;
        completed = null;
      }
      if (
        expected &&
        (expected.runID !== runID ||
          expected.agentID !== agentID ||
          expected.missionKey !== missionKey)
      )
        throw new Error("Distribution mission identity changed; reconcile before continuing.");
      expected = { runID, agentID, missionKey };
    },
    confirm(
      receipt: DistributionCompletionReceipt,
      rewardReadout: MissionRewardReadout | null = null,
    ) {
      if (completed) throw new Error("Distribution completion was already recorded.");
      if (
        !expected ||
        !receipt ||
        receipt.kind !== "missionCompletion" ||
        receipt.completed !== true ||
        receipt.runID !== expected.runID ||
        receipt.stepPath !== "complete" ||
        !Number.isSafeInteger(receipt.invocationID) ||
        receipt.invocationID <= 0 ||
        !Number.isSafeInteger(receipt.actionID) ||
        receipt.actionID <= 0 ||
        receipt.agentID !== expected.agentID ||
        receipt.missionKey !== expected.missionKey
      )
        throw new Error("Distribution completion evidence does not match this mission invocation.");
      completed = { ...receipt };
      completedKeys.add(receipt.missionKey);
      count++;
      reward = rewardReadout;
    },
    snapshot() {
      return {
        completedCount: count,
        missionKey: expected?.missionKey ?? null,
        receipt: completed ? { ...completed } : null,
        reward,
      };
    },
  };
}
