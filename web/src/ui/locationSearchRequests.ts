// searchUtil.GetResultsInNewWindow asked for from elsewhere (the route info panel's search box): PlayApp opens the
// search results window, and the window searches for what was asked.

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";

export interface LocationSearchRequest { readonly n: number; readonly text: string }
const request = createSignal<LocationSearchRequest | null>(null);
let serial = 0;
export const locationSearchRequests: ReadableSignal<LocationSearchRequest | null> = readonlySignal(request);

/** GetResultsInNewWindow(searchText, [solar systems, constellations, regions, stations, structures]). */
export function searchLocationsInWindow(text: string): void {
  request.set({ n: ++serial, text });
}

/** The window has taken the request. */
export function serveLocationSearchRequest(n: number): void {
  if (request.get()?.n === n) request.set(null);
}
