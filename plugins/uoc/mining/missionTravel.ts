import type { JournalState, MissionSpot } from "../shared/types.ts";
import { acceptedMissionKey } from "../shared/helpers.ts";

/** The no-argument Builder block may not choose between competing missions. */
export function missionTravelContext(journal: JournalState | null | undefined): {
  readonly key: string; readonly agentID: number; readonly spots: readonly MissionSpot[];
} | null {
  if (journal?.active.length !== 1) return null;
  const row = journal.active[0]!;
  if (row.missionState !== 2 || !Number.isSafeInteger(row.agentID) || row.agentID! <= 0) return null;
  const key = acceptedMissionKey(journal, row.agentID!);
  if (!key) return null;
  return { key, agentID: row.agentID!, spots: (row.bookmarks ?? []).filter(spot =>
    spot.agentID === row.agentID && spot.locationType.trim() !== "" && Number.isSafeInteger(spot.locationNumber)) };
}

export function missionSpotCurrent(journal: JournalState | null | undefined, action: {
  readonly missionKey?: string; readonly agentID: number; readonly locationType: string; readonly locationNumber: number;
}): boolean {
  const context = missionTravelContext(journal);
  return !!context && context.key === action.missionKey && context.agentID === action.agentID &&
    context.spots.some(spot => spot.locationType === action.locationType && spot.locationNumber === action.locationNumber);
}
