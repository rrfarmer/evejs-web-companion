// searchUtil.GetResultsInNewWindow asked for from elsewhere (the route info panel's search box): PlayApp opens the
// search results window, and the window searches for what was asked.

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";
import type { AppFlow, LocationFound, LocationSearchOptions } from "../app/flow.ts";
import { panelErrorWords } from "../bridge/refusals.ts";

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

interface LocationSearchState {
  readonly busy: boolean;
  readonly error: string;
  readonly result: { readonly found: ReadonlyMap<number, readonly LocationFound[]>; readonly query: string } | null;
}
const emptySearch: LocationSearchState = { busy: false, error: "", result: null };

/** Only the latest submitted search owns the busy state and the displayed results. */
export function createLocationSearch(search: AppFlow["searchLocations"]) {
  const state = createSignal(emptySearch);
  let latest = 0;

  async function run(query: string, options?: LocationSearchOptions): Promise<void> {
    const current = ++latest;
    state.update((previous) => ({ ...previous, busy: Boolean(query.trim()), error: "" }));
    if (!query.trim()) return;
    try {
      const found = await search(query, options);
      if (current === latest) {
        state.update((previous) => ({
          busy: false,
          error: "",
          result: found === null ? previous.result : { found, query: query.replace(/\*/g, "").trim() },
        }));
      }
    } catch (cause) {
      if (current === latest) {
        state.update((previous) => ({ ...previous, busy: false, error: panelErrorWords(cause) }));
      }
    }
  }

  function reset(): void {
    ++latest;
    state.set(emptySearch);
  }

  return { state: readonlySignal(state), run, reset };
}
