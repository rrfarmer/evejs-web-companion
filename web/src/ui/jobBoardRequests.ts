// The job board window asked for from elsewhere: jobboard's open_freelance_project (a job's page in the window) and
// the job board service's open_browse_page (its browse page). PlayApp opens the window; the window takes the request.

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";

export interface JobBoardRequest { readonly n: number; readonly projectID: string | null; readonly corporationID: number | null }
const request = createSignal<JobBoardRequest | null>(null);
let serial = 0;
export const jobBoardRequests: ReadableSignal<JobBoardRequest | null> = readonlySignal(request);

/** A freelance job's page in the job board window (open_freelance_project); null for the browse page. */
export function openJobBoard(projectID: string | null = null, corporationID: number | null = null): void {
  request.set({ n: ++serial, projectID, corporationID });
}

/** The window has taken the request. */
export function serveJobBoardRequest(n: number): void {
  if (request.get()?.n === n) request.set(null);
}
