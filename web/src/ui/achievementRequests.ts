import { writable } from "svelte/store";

/** Open the window from Decorations or from the achievements info panel. */
export const achievementRequest = writable<
  { kind: "window" } | { kind: "rewards" } | { kind: "achievement" | "category"; id: string } | null
>(null);
