import { FLEET_JOB_CREATOR } from "./fleetCommand.ts";
import { FLEET_ROLE, rankLabel } from "./fleetMemberMenu.ts";
import { readKeyVal, unwrapLong } from "./wire.ts";

type MemberEvent = "Joined" | "Left" | "ChangedRole" | "IsBoss" | "IsNotBoss";

export interface FleetMemberHistoryEntry {
  readonly characterID: number;
  readonly event: MemberEvent;
  readonly rank?: string;
  readonly atMs: number;
}

export function memberHistoryLabel(event: MemberEvent): string {
  return `UI/Fleet/FleetBroadcast/MemberHistory${event}`;
}

function memberNumber(value: unknown): number | null {
  const raw = unwrapLong(value);
  const number = Number(raw);
  return raw !== null && Number.isSafeInteger(number) ? number : null;
}

function historyRank(role: number | null, job = 0): string {
  if (role === null || role < FLEET_ROLE.leader || role > FLEET_ROLE.member) return "UI/Fleet/Ranks/NonMember";
  const rank = rankLabel(role);
  return (job & FLEET_JOB_CREATOR) !== 0 ? rank + "Boss" : rank;
}

export function decodeFleetMemberHistory(method: string, args: readonly unknown[], me: number, atMs: number): FleetMemberHistoryEntry[] {
  const characterID = memberNumber(method === "OnFleetJoin" ? readKeyVal(args[0], "charID") : args[0]);
  if (characterID === null || characterID <= 0) return [];
  if (method === "OnFleetJoin" && characterID !== me) {
    const rank = historyRank(memberNumber(readKeyVal(args[0], "role")), memberNumber(readKeyVal(args[0], "job")) ?? 0);
    return [{ characterID, event: "Joined", rank, atMs }];
  }
  if (method === "OnFleetLeave" && characterID !== me) return [{ characterID, event: "Left", atMs }];
  if (method !== "OnFleetMemberChanged") return [];
  const oldRole = memberNumber(args[4]), newRole = memberNumber(args[9]);
  const oldJob = memberNumber(args[5]), newJob = memberNumber(args[10]);
  const entries: FleetMemberHistoryEntry[] = [];
  // Native inserts the role first and then the job at the head of the same list.
  if (oldRole !== newRole) entries.unshift({ characterID, event: "ChangedRole", rank: historyRank(newRole), atMs });
  if (oldJob !== null && newJob !== null && oldJob !== newJob) {
    entries.unshift({ characterID, event: (newJob & FLEET_JOB_CREATOR) !== 0 ? "IsBoss" : "IsNotBoss", atMs });
  }
  return entries;
}
