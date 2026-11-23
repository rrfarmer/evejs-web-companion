export interface AcceptedMission {
 readonly agentID: number;
 readonly missionID: number;
 readonly key: string;
}

export interface MissionContinuation extends AcceptedMission {
 readonly botID: string;
}

/** The native journal confirms this exact task was already turned in. */
export class CivilianMissionCompleted extends Error {}

function positive(value: unknown): value is number {
 return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function readAcceptedMission(value: unknown): AcceptedMission | null {
 if (!value || typeof value !== "object") return null;
 const {agentID, missionID, key} = value as Record<string, unknown>;
 return positive(agentID) && positive(missionID) && typeof key === "string" && key.length > 0 && key.length <= 1024
  ? {agentID, missionID, key} : null;
}

export function readContinuation(value: unknown): MissionContinuation | null {
 const mission = readAcceptedMission(value);
 const botID = (value as {botID?: unknown} | null)?.botID;
 return mission && typeof botID === "string" && botID.length > 0 && botID.length <= 256 ? {...mission, botID} : null;
}

export function sameAcceptedMission(expected: AcceptedMission, actual: AcceptedMission | null): boolean {
 return actual?.agentID === expected.agentID && actual.missionID === expected.missionID && actual.key === expected.key;
}
