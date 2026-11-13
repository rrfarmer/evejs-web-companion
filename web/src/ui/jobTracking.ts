// jobboard job_provider tracking for the freelance jobs: the tracked jobs are a character setting
// (settings.char.ui 'tracked_opportunities_<PROVIDER_ID>', {jobID: the time it was tracked}), kept here per character
// in the browser. FreelanceProjectJob.is_trackable: active and committed. toggle_tracked_job_by_player adds or removes
// one; _on_participation_state_changed adds it on commit and removes it otherwise; _on_state_changed removes one no
// longer trackable. The tracked jobs are the job board's info panel's (InfoPanelJobBoard: MissionTracker.svelte).

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";

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
