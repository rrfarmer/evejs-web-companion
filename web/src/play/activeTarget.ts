// target.GetActiveTargetID: the space view's active lock (the target bar's selected one), for the windows and the
// shortcuts that act on it - the drones' Engage, Mine and Salvage among them (droneFunctions.py).

import { createSignal } from "../store/signals.ts";

/** The active target's item ID, or null where nothing locked is active. */
export const activeTargetID = createSignal<number | null>(null);

/** The active target's name as the space view writes it (GetWarpDestinationName), or null. */
export const activeTargetName = createSignal<string | null>(null);
