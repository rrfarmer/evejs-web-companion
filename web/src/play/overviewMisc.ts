// The Overview Settings Misc panel's switches (MiscPanel), the client's defaults (overviewPresetSvc
// configNamesAndDefaults: all on), kept in this browser: Show Targeting Crosshair (the locked reticle's lines) and
// Display In-Range Brackets with its per-category boxes (showCategoryInTargetRange_<categoryID>: ships 6, NPCs 11,
// drones 18).

export interface OverviewMiscSettings {
  targetCrosshair: boolean;
  /** Display Active Module Links (SETTING_MODULE_HAIRLINES): the hairline from a hovered module to its target. */
  moduleLinks: boolean;
  inRange: boolean;
  inRangeShips: boolean;
  inRangeNPCs: boolean;
  inRangeDrones: boolean;
}
const DEFAULTS: OverviewMiscSettings = { targetCrosshair: true, moduleLinks: true, inRange: true, inRangeShips: true, inRangeNPCs: true, inRangeDrones: true };
const KEY = "evejs.ui.overview.misc";

export function overviewMisc(): OverviewMiscSettings {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<OverviewMiscSettings>) }; } catch { return { ...DEFAULTS }; }
}

export function setOverviewMisc(change: Partial<OverviewMiscSettings>): OverviewMiscSettings {
  const next = { ...overviewMisc(), ...change };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* the settings last the page */ }
  applyOverviewMisc(next);
  return next;
}

/** The switches that are drawn by CSS (the crosshair's lines), applied to the page. */
export function applyOverviewMisc(s: OverviewMiscSettings = overviewMisc()): void {
  if (typeof document !== "undefined") document.body.classList.toggle("no-target-crosshair", !s.targetCrosshair);
}

/** bracketMgr.ShowInTargetRange: whether a thing of this category shows its in-range marker at all. */
export function inRangeShown(categoryID: number | null, s: OverviewMiscSettings = overviewMisc()): boolean {
  if (!s.inRange) return false;
  if (categoryID === 6) return s.inRangeShips;
  if (categoryID === 11) return s.inRangeNPCs;
  if (categoryID === 18) return s.inRangeDrones;
  return categoryID === 87;
}
