// A panel of the Character Sheet asked for (characterSheetWindow._OpenPanel: the window opened, or brought up where it
// is open, and the panel loaded): OpenStandings' Standings, which the Neocom's Standings asks for. The sheet takes the
// request and lets it go.
import { writable } from "svelte/store";

/** The sheet's panels the page has, by its names for them. */
export type SheetPanel = "home" | "memberships" | "implants" | "jumpClones" | "bio" | "decorations" | "expert" | "employment" | "skills" | "standings";

/** The panel last asked for, until the sheet has taken it. */
export const sheetPanelRequest = writable<SheetPanel | null>(null);

/** Ask for a panel of the sheet (the window itself is opened by whoever asks). */
export function requestSheetPanel(panel: SheetPanel): void {
  sheetPanelRequest.set(panel);
}
