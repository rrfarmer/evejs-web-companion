// The pins as one store, so the character bar's strip and the Pilot Hangar's
// (both GlobalLaunchers.svelte) show the same launchers and a pin made in one is in
// the other at once. Made on first use, after plugins have loaded.

import { writable, type Writable } from "svelte/store";
import { pluginWindowGroups } from "./globalWindow.ts";
import { loadPins, meetPlugins, savePins, type PinState } from "./pluginPins.ts";

let store: Writable<PinState> | null = null;

export function pinStore(): Writable<PinState> {
  if (store === null) {
    const first = meetPlugins(loadPins(), pluginWindowGroups());
    savePins(first);
    store = writable(first);
    store.subscribe(savePins);
  }
  return store;
}
