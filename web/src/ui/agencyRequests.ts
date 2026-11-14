// agencyUtil / AgencyWndNew.OpenAndShowContentGroup(contentGroupID) asked from elsewhere (the Career Portal's agency
// links, localsvc AgencyOpenAndShow links): PlayApp opens the Agency window, and the window shows that content group.

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";

export interface AgencyRequest { readonly n: number; readonly contentGroupID: number }
const request = createSignal<AgencyRequest | null>(null);
let serial = 0;
export const agencyRequests: ReadableSignal<AgencyRequest | null> = readonlySignal(request);

/** OpenAndShowContentGroup: the Agency window, on the content group. */
export function openAgencyGroup(contentGroupID: number): void {
  request.set({ n: ++serial, contentGroupID });
}

/** The Agency window has taken the request. */
export function serveAgencyRequest(n: number): void {
  if (request.get()?.n === n) request.set(null);
}
