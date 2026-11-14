// infoPanelCareerProgram.OpenCareerPortal (the info panel's header button and Claim Rewards) asked from elsewhere:
// PlayApp opens the Career Portal window (CareerPortalDockablePanel).

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";

const request = createSignal<number>(0);
export const careerPortalRequests: ReadableSignal<number> = readonlySignal(request);

/** OpenCareerPortal: the window opened, or brought up where it is open. */
export function openCareerPortal(): void {
  request.set(request.get() + 1);
}
