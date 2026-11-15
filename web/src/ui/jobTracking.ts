// jobboard job_provider tracking: the tracked jobs are a character setting
// (settings.char.ui 'tracked_opportunities_<PROVIDER_ID>', {jobID: the time it was tracked}), kept here per character
// in the browser. FreelanceProjectJob tracks active, committed jobs. FactionalWarfareEnlistmentProvider tracks one
// faction per pilot. The Opportunities info panel and board read the same settings.

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";
import { militiaFactionID, type MilitiaFactionID } from "../bridge/militiaEnlistment.ts";
import { WAR_DUNGEON_PROVIDERS, warDungeonJobID, type WarDungeonIdentity, type WarDungeonKind } from "../bridge/dungeonJobs.ts";

const PROVIDER_ID = "freelance_projects";
const key = (characterID: number) => `evejs.play.${characterID}.tracked_opportunities_${PROVIDER_ID}`;
const changes = createSignal(0);
/** Bumped at each change of any character's tracked jobs. */
export const trackedJobsChanged: ReadableSignal<number> = readonlySignal(changes);

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

const warKey = (characterID: number, kind: WarDungeonKind) => `evejs.play.${characterID}.tracked_opportunities_${kind}`;
function readWarJobs(characterID: number, kind: WarDungeonKind): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(warKey(characterID, kind)) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, time]) => {
      const instanceID = Number(id.slice(kind.length + 1));
      return Number.isSafeInteger(instanceID) && instanceID > 0 && id === warDungeonJobID({ kind, instanceID }) &&
        typeof time === "number" && Number.isFinite(time);
    })) as Record<string, number>;
  } catch { return {}; }
}

export function trackedWarDungeonJobs(characterID: number | null): readonly (WarDungeonIdentity & { readonly since: number })[] {
  if (!characterID) return [];
  return (Object.keys(WAR_DUNGEON_PROVIDERS) as WarDungeonKind[]).flatMap((kind) =>
    Object.entries(readWarJobs(characterID, kind)).map(([key, since]) => ({
      kind, instanceID: Number(key.slice(kind.length + 1)), since,
    }))).sort((a, b) => a.since - b.since);
}

export function setWarDungeonTracked(characterID: number | null, job: WarDungeonIdentity, tracked: boolean): void {
  if (!characterID || !Number.isSafeInteger(job.instanceID) || job.instanceID <= 0) return;
  const jobs = readWarJobs(characterID, job.kind);
  const id = warDungeonJobID(job);
  if (Object.hasOwn(jobs, id) === tracked) return;
  if (tracked) jobs[id] = Date.now();
  else delete jobs[id];
  try { localStorage.setItem(warKey(characterID, job.kind), JSON.stringify(jobs)); } catch { return; }
  changes.set(changes.get() + 1);
}
