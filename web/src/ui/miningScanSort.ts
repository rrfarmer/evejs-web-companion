// The Mining Survey Results window's group order: the char setting miningScanSortGroupsBy (mining_scan_results_window
// SortGroupsBy: ALPHABETICALLY, the default, VALUE, TYPE), kept per character in this browser.
import { writable } from "svelte/store";

export type MiningScanSort = "name" | "value" | "type";
const key = (characterID: number | null) => `evejs.miningScanSortGroupsBy.${characterID ?? 0}`;

export const miningScanSort = writable<MiningScanSort>("name");
let keptFor: number | null | undefined;

/** The kept order of this character, read once per character. */
export function loadMiningScanSort(characterID: number | null): void {
  if (keptFor === characterID) return;
  keptFor = characterID;
  try { const v = localStorage.getItem(key(characterID)); miningScanSort.set(v === "value" || v === "type" ? v : "name"); } catch { miningScanSort.set("name"); }
}

export function setMiningScanSort(characterID: number | null, value: MiningScanSort): void {
  miningScanSort.set(value);
  try { localStorage.setItem(key(characterID), value); } catch { /* this page only */ }
}
