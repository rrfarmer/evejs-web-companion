import { writable } from "svelte/store";

/** Decorations' View Achievement opens the window on that card. */
export const achievementRequest = writable<string | null>(null);
