// careerPortal/util.OpenSkillPlanWindow(careerID) asked from elsewhere (the Career Portal's Aura panel): PlayApp opens the
// skills window, and its skill plans panel shows the certified plans of that career path
// (SkillPlanDockablePanel.ShowCertifiedPlans).

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";

export interface SkillPlanCareerRequest { readonly n: number; readonly careerPathID: number }
const request = createSignal<SkillPlanCareerRequest | null>(null);
let serial = 0;
export const skillPlanCareerRequests: ReadableSignal<SkillPlanCareerRequest | null> = readonlySignal(request);

/** OpenSkillPlanWindow: the skills window, its certified plans of the career path. */
export function showCertifiedPlans(careerPathID: number): void {
  request.set({ n: ++serial, careerPathID });
}

/** The plans panel has taken the request. */
export function serveSkillPlanCareerRequest(n: number): void {
  if (request.get()?.n === n) request.set(null);
}
