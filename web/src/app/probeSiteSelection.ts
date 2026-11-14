// scanSvc.selectedSites: the probe scan results the pilot has selected, shared by the scanner's list (scanResults.py
// SetSelectedSites from its selected rows, OnSiteSelectionChanged selecting them) and the solar system map (its result
// markers' click, SelectSite; mapViewProbeHandlerStandalone.UpdateSelectedObjects drawing the selected ones).
import { writable, get } from "svelte/store";

export const selectedSites = writable<ReadonlySet<string>>(new Set());

/** SetSelectedSites: these, and no others. */
export function setSelectedSites(siteIDs: Iterable<string>): void {
  selectedSites.set(new Set(siteIDs));
}

/** SelectSite: with Shift or Ctrl the site added or taken out, else it alone. */
export function selectSite(siteID: string, multiSelect: boolean): void {
  const next = new Set(multiSelect ? get(selectedSites) : []);
  if (!next.has(siteID)) next.add(siteID);
  else if (multiSelect) next.delete(siteID);
  selectedSites.set(next);
}

/** IsSiteSelected. */
export function isSiteSelected(siteID: string): boolean {
  return get(selectedSites).has(siteID);
}
