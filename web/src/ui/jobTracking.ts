// jobboard job_provider tracking: the tracked jobs are a character setting
// (settings.char.ui 'tracked_opportunities_<PROVIDER_ID>', {jobID: the time it was tracked}), kept here per character
// in the browser. FreelanceProjectJob tracks active, committed jobs. FactionalWarfareEnlistmentProvider tracks one
// faction per pilot. The Opportunities info panel and board read the same settings.

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";
import { militiaFactionID, type MilitiaFactionID } from "../bridge/militiaEnlistment.ts";
import { WAR_DUNGEON_PROVIDERS, dungeonJobID, type TrackedDungeonIdentity, type TrackedDungeonKind, type WarDungeonKind } from "../bridge/dungeonJobs.ts";
import { AGENT_MISSION_STATE } from "../bridge/agents.ts";
import { filetimeOf } from "../bridge/journalWords.ts";
import type { JournalMission } from "../store/types.ts";

const PROVIDER_ID = "freelance_projects";
const key = (characterID: number, provider = PROVIDER_ID) => `evejs.play.${characterID}.tracked_opportunities_${provider}`;
const changes = createSignal(0);
/** Bumped at each change of any character's tracked jobs. */
export const trackedJobsChanged: ReadableSignal<number> = readonlySignal(changes);

/** Accepted missions start out tracked, and each live offer can be tracked explicitly. */
export function agentMissionTrackable(mission: JournalMission): boolean {
  if (mission.agentID === null || (mission.missionState !== AGENT_MISSION_STATE.OFFERED &&
    mission.missionState !== AGENT_MISSION_STATE.ACCEPTED)) return false;
  const expiry = mission.expirationTime;
  return !expiry || expiry === "0" || (/^\d+$/.test(expiry) && BigInt(expiry) >= filetimeOf(Date.now()));
}

type MissionTrackingOverrides = Record<number, { readonly mission: string; readonly tracked: boolean }>;
const missionKey = (mission: JournalMission) => JSON.stringify([mission.missionID, mission.missionState, mission.expirationTime]);

function missionTrackingOverrides(characterID: number): MissionTrackingOverrides {
  try {
    const raw = JSON.parse(localStorage.getItem(key(characterID, "agent_missions")) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

export function isAgentMissionTracked(characterID: number | null, mission: JournalMission): boolean {
  if (characterID === null || mission.agentID === null || !agentMissionTrackable(mission)) return false;
  const override = missionTrackingOverrides(characterID)[mission.agentID];
  return override?.mission === missionKey(mission) && typeof override.tracked === "boolean"
    ? override.tracked : mission.missionState === AGENT_MISSION_STATE.ACCEPTED;
}

export function toggleTrackedAgentMission(characterID: number | null, mission: JournalMission): void {
  if (characterID === null || mission.agentID === null || !agentMissionTrackable(mission)) return;
  const next = missionTrackingOverrides(characterID);
  next[mission.agentID] = { mission: missionKey(mission), tracked: !isAgentMissionTracked(characterID, mission) };
  try { localStorage.setItem(key(characterID, "agent_missions"), JSON.stringify(next)); } catch { return; }
  changes.set(changes.get() + 1);
}

/** The character's tracked freelance jobs: job ID -> the time it was tracked (ms). */
export function trackedFreelanceJobs(characterID: number | null): Readonly<Record<string, number>> {
  if (!characterID) return {};
  try {
    const raw = JSON.parse(localStorage.getItem(key(characterID)) ?? "{}") as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, number> : {};
  } catch { return {}; }
}

function write(characterID: number, jobs: Record<string, number>): void {
  try { localStorage.setItem(key(characterID), JSON.stringify(jobs)); } catch { /* the setting is not kept */ }
  changes.set(changes.get() + 1);
}

export function isFreelanceJobTracked(characterID: number | null, jobID: string): boolean {
  return Object.hasOwn(trackedFreelanceJobs(characterID), jobID);
}

/** add_tracked_job: the job tracked now. */
export function trackFreelanceJob(characterID: number | null, jobID: string): void {
  if (!characterID || isFreelanceJobTracked(characterID, jobID)) return;
  write(characterID, { ...trackedFreelanceJobs(characterID), [jobID]: Date.now() });
}

/** remove_tracked_job. */
export function untrackFreelanceJob(characterID: number | null, jobID: string): void {
  if (!characterID || !isFreelanceJobTracked(characterID, jobID)) return;
  const jobs = { ...trackedFreelanceJobs(characterID) };
  delete jobs[jobID];
  write(characterID, jobs);
}

/** toggle_tracked_job_by_player. */
export function toggleTrackedFreelanceJob(characterID: number | null, jobID: string): void {
  if (isFreelanceJobTracked(characterID, jobID)) untrackFreelanceJob(characterID, jobID);
  else trackFreelanceJob(characterID, jobID);
}

const militiaKey = (characterID: number) => `evejs.play.${characterID}.tracked_opportunities_factional_warfare_enlistment`;

export function readTrackedMilitiaJob(characterID: number | null): { readonly factionID: MilitiaFactionID; readonly since: number } | null {
  if (!characterID) return null;
  try {
    const jobs = JSON.parse(localStorage.getItem(militiaKey(characterID)) ?? "{}");
    const [key, since] = Object.entries(jobs)[0] ?? [];
    const factionID = militiaFactionID(Number(key));
    return factionID !== null && typeof since === "number" ? { factionID, since } : null;
  } catch { return null; }
}

export function trackedMilitiaJob(characterID: number | null): MilitiaFactionID | null {
  return readTrackedMilitiaJob(characterID)?.factionID ?? null;
}

// FactionalWarfareEnlistmentProvider tracks a single faction for a character.
export function trackMilitiaJob(characterID: number, factionID: MilitiaFactionID): void {
  if (trackedMilitiaJob(characterID) === factionID) return;
  localStorage.setItem(militiaKey(characterID), JSON.stringify({ [factionID]: Date.now() }));
  changes.set(changes.get() + 1);
}

export function untrackMilitiaJob(characterID: number | null, factionID?: MilitiaFactionID): void {
  const tracked = trackedMilitiaJob(characterID);
  if (!characterID || tracked === null || factionID !== undefined && factionID !== tracked) return;
  try { localStorage.removeItem(militiaKey(characterID)); } catch { return; }
  changes.set(changes.get() + 1);
}

const dungeonKey = (characterID: number, kind: TrackedDungeonKind) => `evejs.play.${characterID}.tracked_opportunities_${kind}`;
function readDungeonJobs(characterID: number, kind: TrackedDungeonKind): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(dungeonKey(characterID, kind)) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, time]) => {
      const instanceID = Number(id.slice(kind.length + 1));
      return Number.isSafeInteger(instanceID) && instanceID > 0 && id === dungeonJobID({ kind, instanceID }) &&
        typeof time === "number" && Number.isFinite(time);
    })) as Record<string, number>;
  } catch { return {}; }
}

export function trackedDungeonJobs(characterID: number | null): readonly (TrackedDungeonIdentity & { readonly since: number })[] {
  if (!characterID) return [];
  const kinds: TrackedDungeonKind[] = [...Object.keys(WAR_DUNGEON_PROVIDERS) as WarDungeonKind[], "homefront"];
  return kinds.flatMap((kind) =>
    Object.entries(readDungeonJobs(characterID, kind)).map(([key, since]) => ({
      kind, instanceID: Number(key.slice(kind.length + 1)), since,
    }))).sort((a, b) => a.since - b.since);
}

export function setDungeonTracked(characterID: number | null, job: TrackedDungeonIdentity, tracked: boolean): void {
  if (!characterID || !Number.isSafeInteger(job.instanceID) || job.instanceID <= 0) return;
  const jobs = readDungeonJobs(characterID, job.kind);
  const id = dungeonJobID(job);
  if (Object.hasOwn(jobs, id) === tracked) return;
  if (tracked) jobs[id] = Date.now();
  else delete jobs[id];
  try { localStorage.setItem(dungeonKey(characterID, job.kind), JSON.stringify(jobs)); } catch { return; }
  changes.set(changes.get() + 1);
}

const MERCENARY_PROVIDER = "mercenary_tactical_ops";
const MERCENARY_JOB_PREFIX = `${MERCENARY_PROVIDER}:`;
const operationID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function trackedMercenaryOperations(characterID: number | null): Readonly<Record<string, number>> {
  if (!characterID) return {};
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key(characterID, MERCENARY_PROVIDER)) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    const jobs: Record<string, number> = {};
    for (const [jobID, since] of Object.entries(stored)) {
      if (!jobID.startsWith(MERCENARY_JOB_PREFIX) || typeof since !== "number" || !Number.isFinite(since)) continue;
      const id = jobID.slice(MERCENARY_JOB_PREFIX.length);
      if (operationID.test(id)) jobs[id] = since;
    }
    return jobs;
  } catch { return {}; }
}

export function setMercenaryOperationTracked(characterID: number | null, id: string, tracked: boolean): void {
  if (!characterID || !operationID.test(id)) return;
  const jobs = { ...trackedMercenaryOperations(characterID) };
  if (Object.hasOwn(jobs, id) === tracked) return;
  if (tracked) jobs[id] = Date.now();
  else delete jobs[id];
  const stored = Object.fromEntries(Object.entries(jobs).map(([id, since]) => [MERCENARY_JOB_PREFIX + id, since]));
  try { localStorage.setItem(key(characterID, MERCENARY_PROVIDER), JSON.stringify(stored)); } catch { return; }
  changes.set(changes.get() + 1);
}
