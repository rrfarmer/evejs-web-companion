// The Overview, in the client's look: what is on grid nearest first, one row each with its bracket and the client's
// default columns (overviewConst.DEFAULT_COLUMNS: icon, distance, name, type, velocity; distance and velocity right
// aligned). Its tabs show the groups of the client's Jotunn profile (extract.mjs --overview). A click
// selects as a bracket click does. Double-click invokes the selected entity's activation.

import { PlayWindow, clientTexture } from "./window.ts";
import type { Entity } from "./spaceView.ts";
import { fmtDist } from "../space/overview.ts";
import { playUiEvent } from "./uiAudio.ts";
import { iconAndBackgroundFlags, overviewRowWanted, setStateAppearance, type BracketOverride, type OverviewRelationships, type PresetMask, type StateFlagLook } from "./overviewFilters.ts";

const rgba = (c: readonly number[], alpha = c[3] ?? 1) => `rgba(${Math.round(c[0]! * 255)},${Math.round(c[1]! * 255)},${Math.round(c[2]! * 255)},${alpha})`;
/**
 * FlagIconWithState: a 10 px square at the icon's bottom right (SpaceObjectIcon.SetIconFlag left -1, top -2), the flag
 * colour at 0.75, the 8 px FlagIcon/8/<iconIndex + 1> glyph in the flag's icon colour; a blinking one fades 0..1 over 0.5 s.
 */
export function flagMarkup(f: StateFlagLook | null): string {
  if (!f) return "";
  const glyph = clientTexture(`res:/UI/Texture/classes/FlagIcon/8/${f.iconIndex + 1}.png`);
  return `<span class="state-flag${f.flagBlink ? " blink" : ""}" style="background:${rgba(f.flagColor, 0.75)}" title="${esc(f.text)}"><span style="background:${rgba(f.iconColor)};-webkit-mask:url(${glyph}) center/8px no-repeat;mask:url(${glyph}) center/8px no-repeat"></span></span>`;
}
import { ContextMenu, type ContextEntry } from "./contextMenu.ts";
import { readProfile, writeProfile, type OverviewProfile } from "./overviewProfileFile.ts";
import { overviewMisc, setOverviewMisc, applyOverviewMisc } from "./overviewMisc.ts";
import { SHIP_LABEL_PRESETS, saveShipLabelSettings, shipLabelMarkup, shipLabelSettings, type ShipLabelPart } from "./shipLabels.ts";

/** overviewSettingsConst: MAX_TAB_NUM, MAX_TAB_NAME_LENGTH. */
const MAX_TAB_NUM = 20;
const MAX_TAB_NAME_LENGTH = 15;
/** A tab's settings (presetSvc's settingsByTabID): its name, overview preset and bracket preset (null: Show All Brackets). */
/** A tab's settings (presetSvc's tab settings); window: the overview window it is in (SETTING_WINDOW_INSTANCE_ID; none = the first). */
export interface TabSettings { name: string; preset: string; bracket: string | null; columns?: ColumnID[]; order?: ColumnID[]; color?: number[] | null; window?: number }
/** OverviewColorPickerCont.GetColors: 24 hues at saturation 0.75 and brightness 1 (Color.SetHSB), 8 to a row. */
const TAB_COLORS: readonly number[][] = Array.from({ length: 24 }, (_, i) => {
  const h = (i / 24) * 6, s = 0.75, v = 1, c = v * s, x = c * (1 - Math.abs((h % 2) - 1)), m = v - c;
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m].map((n) => Math.round(n * 1000) / 1000);
});
const rgbCss = (c: readonly number[]) => `rgb(${c.slice(0, 3).map((n) => Math.round(n * 255)).join(",")})`;
/** stateSvc.GetStateColors' values in the order the 3698585 client's dict gives them (read live through gridcheck). */
const STATE_COLOR_NAMES = ["darkTurquoise", "indigo", "darkBlue", "turquoise", "yellow", "blue", "purple", "green", "orange", "black", "white", "red"] as const;
const STATE_COLORS: readonly number[][] = [[0, 0.34, 0.33, 1], [0.3, 0, 0.5, 1], [0, 0.15, 0.6, 1], [0, 0.63, 0.57, 1], [1, 0.7, 0, 1], [0.2, 0.5, 1, 1],
  [0.6, 0.15, 0.9, 1], [0.1, 0.6, 0.1, 1], [1, 0.35, 0, 1], [0, 0, 0, 1], [0.7, 0.7, 0.7, 1], [0.75, 0, 0, 1]];
/**
 * A ColorPanel in its tooltip beside the picker: "Select Color", the colours (16 px, 4 apart, the chosen one framed),
 * the clear button where it has one. Picking (or clearing) calls back and closes it; a click elsewhere closes it.
 */
function openColorPanel(anchor: HTMLElement, word: (label: string, own: string) => string, colors: readonly (readonly number[])[], columns: number, current: readonly number[] | null, clear: boolean,
  picked: (color: readonly number[] | null) => void): void {
  const r = anchor.getBoundingClientRect();
  document.querySelector(".ov-color-panel")?.remove();
  const panel = document.createElement("div");
  panel.className = "ov-color-panel";
  panel.innerHTML = `<div class="ov-color-title">${esc(word("UI/Mail/Select Color", "Select Color"))}</div><div class="ov-color-grid" style="grid-template-columns:repeat(${columns},16px)">${colors.map((c, k) =>
    `<span data-color="${k}" class="${current && current.every((v, j) => Math.abs(v - (c[j] ?? 1)) < 0.01) ? "sel" : ""}" style="background:${rgbCss(c)}"></span>`).join("")}${clear
    ? `<img data-clear src="${clientTexture("res:/UI/Texture/eveicon/system_icons/close_16px.png")}" title="${esc(word("UI/SystemMenu/ResetSettings/Clear", "Clear"))}" alt="">` : ""}</div>`;
  Object.assign(panel.style, { left: `${Math.round(r.right + 4)}px`, top: `${Math.round(r.top - 8)}px` });
  document.body.append(panel);
  const done = () => { panel.remove(); removeEventListener("mousedown", close, true); };
  const close = (e: MouseEvent) => { if (!panel.contains(e.target as Node)) done(); };
  addEventListener("mousedown", close, true);
  panel.addEventListener("click", (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-color], [data-clear]");
    if (!cell) return;
    done();
    picked(cell.hasAttribute("data-clear") ? null : colors[Number(cell.dataset.color)]!);
  });
}
/** The pilot's tabs once changed (added, renamed, filtered, deleted): the whole list, kept per pilot in this browser. */
const TABS_KEY = "evejs-play-overview-tabSettings";
/** categories.CATEGORY_ICONS (eveicon star, warp_to, target, user_plus, mining at 16). */
const CATEGORY_ICONS: Readonly<Record<number, string>> = {
  1: "res:/UI/Texture/eveicon/system_icons/star_16px.png", 2: "res:/UI/Texture/eveicon/control_icons/warp_to_16px.png",
  3: "res:/UI/Texture/eveicon/control_icons/target_16px.png", 4: "res:/UI/Texture/eveicon/system_icons/user_plus_16px.png",
  5: "res:/UI/Texture/eveicon/system_icons/mining_16px.png",
};
const CHECKMARK = "res:/UI/Texture/eveicon/system_icons/checkmark_16px.png";
const SETTINGS_ICON = "res:/UI/Texture/eveicon/system_icons/settings_16px.png";

interface OverviewPresetData {
  name: string;
  groups: number[];
  categoryID?: number;
  categoryName?: string | null;
  filteredStates?: number[];
  alwaysShownStates?: number[];
}
interface OverviewPresets {
  tabs: { name: string; preset: string; bracket?: string | null }[];
  presets: Record<string, OverviewPresetData | undefined>;
  categoryOrder?: number[];
}
interface OverviewTab {
  name: string;
  overview: (PresetMask & { name: string }) | null;
  bracket: PresetMask | null;
}
/** A default preset as a chooser lists it (GetPresetDisplayName with its category: "Category: Name"). */
export interface PresetChoice { readonly id: string; readonly name: string; readonly label: string; readonly groups: ReadonlySet<number>; readonly category?: number; readonly categoryName?: string | null }
/** TabPresetPanel.GetListOfCategories: the categories and their groups (a special group several group IDs), as the client lists them. */
interface FilterCategory { category: string; groups: { name: string; groupIDs: number[] }[] }
let filterGroupsRead: Promise<FilterCategory[] | null> | null = null;
function overviewFilterGroups() {
  filterGroupsRead ??= fetch("/client-assets/overviewFilterGroups.json").then((r) => (r.ok ? r.json() : null)).then((j) => (j?.categories ?? null) as FilterCategory[] | null).catch(() => null);
  return filterGroupsRead;
}
/** StatesPanel's states (stateSvc.GetStateProps but flagForcedOn), read from the client into overviewStates.json. */
interface StateProps { flag: number; text: string; hint: string | null; iconIndex: number; iconColor: number[]; flagColor: number[] }
let statesRead: Promise<StateProps[] | null> | null = null;
function overviewStates() {
  statesRead ??= fetch("/client-assets/overviewStates.json").then((r) => (r.ok ? r.json() : null)).then((j) => (j?.states ?? null) as StateProps[] | null).catch(() => null);
  return statesRead;
}
/** AppearancePanel's lists as the client has them by default (overviewStateOrders.json, tools/client-extract/overviewStateOrders.py). */
interface StateOrderEntry { flag: number; on: boolean; color: number[]; blink: boolean }
interface StateOrders { flag: StateOrderEntry[]; background: StateOrderEntry[]; filterGroups: number[] }
let ordersRead: Promise<StateOrders | null> | null = null;
function overviewStateOrders() {
  ordersRead ??= fetch("/client-assets/overviewStateOrders.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return ordersRead;
}
/** The pilot's Appearance settings (the client's settings.user.overview), kept in this browser. */
interface AppearanceSettings { smallTags: boolean; smallFont: boolean; applyStructures: boolean; applyOther: boolean;
  flag?: { flag: number; on: boolean }[]; background?: { flag: number; on: boolean }[];
  /** stateSvc's SETTING_STATE_COLORS / SETTING_STATE_BLINKS: "where:flag" to the colour / blink set */
  colors?: Record<string, number[]>; blinks?: Record<string, boolean> }
const APPEARANCE_KEY = "evejs.ui.overview.appearance";
function readAppearance(): AppearanceSettings {
  const base: AppearanceSettings = { smallTags: false, smallFont: false, applyStructures: true, applyOther: false };
  try { return { ...base, ...(JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? "{}") as Partial<AppearanceSettings>) }; } catch { return base; }
}
let presetsRead: Promise<OverviewPresets | null> | null = null;
function overviewPresets() {
  presetsRead ??= fetch("/client-assets/overviewPresets.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return presetsRead;
}
const TAB_KEY = "evejs-play-overview-tab";
const SORT_KEY = "evejs-play-overview-sort";
const SORT_ENABLED_KEY = "evejs-play-overview-headerSortingEnabled";
/** SETTING_RESTORE_DATA: the profile stored before Reset All ({data, name, timestamp}); SETTING_HISTORY_KEYS: the shared profiles loaded. */
const RESTORE_KEY = "evejs-play-overviewProfile-restore";
/** settings.user.ui overviewProfileName: the name the pilot gave the overview (DraggableShareContainer's LabelEditable). */
const PROFILE_NAME_KEY = "evejs-play-overviewProfileName";
const HISTORY_KEY = "evejs-play-overviewProfile-history";
const isOverviewSettingKey = (k: string) => k.startsWith("evejs.ui.overview.") || k.startsWith(TABS_KEY) || k.startsWith(SORT_KEY) || k.startsWith(TAB_KEY) || k.startsWith(SORT_ENABLED_KEY);
/** FmtDate: 2026.11.20 22:16 */
const fmtDate = (ms: number) => { const d = new Date(ms), p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
type SortColumn = "distance" | "name" | "type" | "size" | "velocity" | "angular" | "radial" | "transversal" | "tag" | "corporation" | "alliance" | "faction" | "militia";
const SORT_COLUMNS: readonly SortColumn[] = ["distance", "name", "type", "size", "velocity", "angular", "radial", "transversal", "tag", "corporation", "alliance", "faction", "militia"];

/** An affiliation column's words for a thing (overviewWindow.py 937 to 975); null where it has none or the page none yet. */
export interface OverviewAffiliation { tag: string | null; corporation: string | null; alliance: string | null; faction: string | null; militia: string | null }
type ColumnID = "ICON" | "DISTANCE" | "NAME" | "TYPE" | "TAG" | "CORPORATION" | "ALLIANCE" | "FACTION" | "MILITIA" | "SIZE" | "VELOCITY" | "RADIALVELOCITY" | "TRANSVERSALVELOCITY" | "ANGULARVELOCITY";
interface ColumnDef { id: ColumnID; label: string; own: string; unit?: string; hint?: string; width: number; right?: boolean; sort?: SortColumn }
/**
 * overviewConst.NAME_BY_COLUMN in its order (ALL_COLUMNS, the order GetColumns shows them in), with COLUMN_UNITS added to
 * a header (GetColumnLabel addFormatUnit), COLUMN_DESCRIPTIONS as hints, FIXEDCOLUMNS / COLUMN_DEFAULTSIZE /
 * COLUMNMINDEFAULTSIZE as widths and RIGHTALIGNEDCOLUMNS right aligned.
 */
const COLUMNS: readonly ColumnDef[] = [
  { id: "ICON", label: "UI/Generic/Icon", own: "Icon", width: 22 },
  { id: "DISTANCE", label: "UI/Common/Distance", own: "Distance", width: 80, right: true, sort: "distance" },
  { id: "NAME", label: "UI/Common/Name", own: "Name", width: 112, sort: "name" },
  { id: "TYPE", label: "UI/Common/Type", own: "Type", width: 112, sort: "type" },
  { id: "TAG", label: "UI/Common/Tag", own: "Tag", hint: "UI/Overview/TagDescription", width: 80, sort: "tag" },
  { id: "CORPORATION", label: "UI/Common/Corporation", own: "Corporation", width: 80, sort: "corporation" },
  { id: "ALLIANCE", label: "UI/Common/Alliance", own: "Alliance", width: 80, sort: "alliance" },
  { id: "FACTION", label: "UI/Common/Faction", own: "Faction", width: 80, sort: "faction" },
  { id: "MILITIA", label: "UI/Common/Militia", own: "Militia", hint: "UI/Overview/MilitiaDescription", width: 80, sort: "militia" },
  { id: "SIZE", label: "UI/Inventory/ItemSize", own: "Size", hint: "UI/Overview/SizeDescription", width: 80, right: true, sort: "size" },
  { id: "VELOCITY", label: "UI/Overview/Velocity", own: "Velocity", unit: "UI/Overview/MetersPerSecondUnitShort", hint: "UI/Overview/VelocityDescription", width: 58, right: true, sort: "velocity" },
  { id: "RADIALVELOCITY", label: "UI/Overview/RadialVelocity", own: "Radial Velocity", unit: "UI/Overview/MetersPerSecondUnitShort", hint: "UI/Overview/RadialVelocityDescription", width: 80, right: true, sort: "radial" },
  { id: "TRANSVERSALVELOCITY", label: "UI/Overview/TraversalVelocity", own: "Transversal Velocity", unit: "UI/Overview/MetersPerSecondUnitShort", hint: "UI/Overview/TraversalVelocityDescription", width: 80, right: true, sort: "transversal" },
  { id: "ANGULARVELOCITY", label: "UI/Generic/AngularVelocity", own: "Angular Velocity", unit: "UI/Overview/DegreesPerSecondUnitShort", hint: "UI/Overview/AngularVelocityDescription", width: 58, right: true, sort: "angular" },
];
/** The tabs' own columns in the client's Jotunn profile (overviewColumns), what a tab shows until the pilot changes it. */
const DEFAULT_VISIBLE: readonly ColumnID[] = ["ICON", "DISTANCE", "NAME", "TYPE", "SIZE", "VELOCITY", "ANGULARVELOCITY"];
const AFFILIATION_COLUMNS: ReadonlySet<ColumnID> = new Set(["TAG", "CORPORATION", "ALLIANCE", "FACTION", "MILITIA"]);
export const OVERVIEW_COLUMN_WORDS = COLUMNS.flatMap((c) => [c.label, ...(c.unit ? [c.unit] : []), ...(c.hint ? [c.hint] : [])]);
interface OverviewSort { column: SortColumn; down: boolean }
const DEFAULT_SORT: OverviewSort = { column: "distance", down: false };
const SORT_ENABLED = "UI/Tactical/HeaderSortingEnabledCb";
const SORT_HINT = "UI/Tactical/HeaderSortingEnabledCbHint";
const SORT_DISABLED = "UI/Tactical/HeaderSortingDisabled";
const HACKED_HINT = "Tooltips/Overview/ScatterContainerHacked";
export const OVERVIEW_WORDS = [SORT_ENABLED, SORT_HINT, SORT_DISABLED, HACKED_HINT, "UI/Tactical/OverviewCaption", ...OVERVIEW_COLUMN_WORDS,
  "UI/Overview/AddTab", "UI/Commands/OpenOverviewSettings", "UI/Overview/BracketVisibility", "UI/Overview/UseSelectedTabBracketPreset",
  "UI/Overview/ShowAll", "UI/Overview/HideAll", "UI/Overview/AddTabInstructions", "UI/Overview/TypeInLabel", "UI/Overview/Filter",
  "UI/Overview/ChooseOverviewPreset", "UI/Overview/BracketFilter", "UI/Overview/ChooseBracketPreset", "UI/Overview/ShowAllBrackets",
  "UI/Common/Buttons/OK", "UI/Common/Buttons/Cancel", "UI/Common/PleaseTypeSomething", "UI/Overview/DefaultFilters",
  "UI/Overview/EditCurrentFilter", "UI/Commands/ChangeName", "UI/Overview/DeleteTab", "/Carbon/UI/Controls/ScrollEntries/TypeInNewName",
  "UI/Overview/ChangeOrder", "UI/Overview/TabColumnsCaption", "UI/Overview/OverviewSettings", "UI/Overview/Tabs", "UI/Overview/TabName", "UI/Overview/Filters", "UI/Overview/FilterToEdit", "UI/Overview/TypesShown", "UI/Common/SelectAll", "UI/Common/DeselectAll", "UI/Common/Search", "UI/Common/Buttons/Revert", "UI/Overview/ToggleBlink", "UI/Overview/MoveTabTo", "UI/Overview/NewWindow", "UI/Overview/ImportOverviewSettings", "UI/Overview/ExportOverviewSettings", "UI/Common/Files/FileNotValid", "UI/Commands/ExportOverviewSettings", "UI/Shared/CheckAllOn", "UI/Overview/GeneralOverviewSettings", "UI/Overview/OverviewProfile", "UI/Overview/OverviewProfileHint", "UI/Overview/TabPresetName", "UI/Overview/OtherTabPresets", "UI/Common/Files/FileName", "UI/Commands/Export", "UI/Commands/Import", "UI/Overview/SharableOverviewIconExportHint", "UI/Overview/OverviewExportDone", "UI/Common/NameInvalid", "UI/Overview/MoveBroadcastersToTop", "UI/Overview/ShareOverview", "UI/Overview/SharableOverviewIconHint", "UI/Overview/ProfileHistory", "UI/Overview/HistoryText", "UI/Overview/AutomaticallyStoredOverviewHeader", "UI/Overview/RestoreProfile", "UI/Overview/StoredOverviewBasedOn", "UI/Overview/DefaultOverviewName", "UI/Overview/ProfileLinkWithTimestamp", "UI/Mail/Select Color", "UI/SystemMenu/ResetSettings/Clear", "UI/Common/Buttons/Save", "UI/Common/Buttons/SaveAs", "UI/Common/Delete", "UI/Overview/FilterName", "UI/Overview/CustomFilters", "UI/Generic/Misc", "UI/Overview/BracketAndTargetsHeader", "UI/SystemMenu/GeneralSettings/Inflight/ShowTargettingCrosshair", "UI/Overview/DisplayRangeBrackets", "UI/Overview/DisplayModuleLinks", "UI/Overview/DisplayDamageIndications", "UI/Overview/Ships", "UI/Overview/NPCs", "UI/Overview/Drones", "UI/Overview/ResetOverview", "UI/Common/ItemTypes/Ships", "UI/Common/ShipType", "UI/Shared/AllianceTicker", "UI/Common/CorpTicker", "UI/Common/ShipName", "UI/Common/PilotName", "UI/Overview/Linebreak", "UI/Overview/OnlyShownWhenAvailable", "UI/Overview/AdditionalTextForCorpTicker", "UI/Overview/HideTickerIfInAlliance", "UI/Overview/AddLinebreak", "UI/Common/Preview", "UI/Overview/ShipLabelFormatPilotCC", "UI/Overview/ShipLabelFormatPilotCCAA", "UI/Overview/ShipLabelFormatCCPilotAA", "UI/Generic/Appearance", "UI/Overview/UseSmallColortags", "UI/Overview/UseSmallFont", "UI/Overview/ApplyToShipsAndDronesByDefault", "UI/Overview/ApplyToStructures", "UI/Overview/ApplyToOtherObjects", "UI/Overview/Colortag", "UI/Overview/Background", "UI/Overview/HintToggleDisplayState", "UI/Commands/ResetAll", "UI/Overview/Exceptions", "UI/Overview/FilterStateAlwaysShowLong", "UI/Overview/FilterStateFilterOutLong", "UI/Overview/FilterStateNotFilterOutLong", "UI/Overview/HintToggleDisplayStateAndOrder", "UI/Overview/ResetColumns", "UI/Generic/Columns"];
const DISABLED_TEXT = "Header sorting is disabled";

/**
 * OverviewScrollEntry._GetColumnValueDistance: metres to 10 km, kilometres to 10,000,000 km, then AU to one place
 * (FormatNumeric with grouping).
 */
export function overviewDistance(m: number): string {
  const d = Math.max(0, m);
  if (d < 10_000) return `${Math.round(d).toLocaleString("en-US")} m`;
  if (d < 10_000_000_000) return `${Math.round(d / 1000).toLocaleString("en-US")} km`;
  return `${(Math.round((d / 149_597_870_700) * 10) / 10).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} AU`;
}


function readSort(key: string, fallback: OverviewSort = DEFAULT_SORT): OverviewSort {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (SORT_COLUMNS.includes(saved?.column) && typeof saved.down === "boolean") return saved;
  } catch { /* use the default */ }
  return fallback;
}

/**
 * overviewPresetSvc.AddGroupToOverview / RemoveGroupFromOverview: the pilot's changes to a preset's groups, kept per
 * preset in this browser (the client keeps its edited copy of the preset in its settings).
 */
const CUSTOM_PRESETS_KEY = "evejs.ui.overview.customPresets";
const CUSTOM_PREFIX = "custom:";
/** overviewPresetSvc.GetDefaultPreset (General: General, as read from the client). */
const DEFAULT_PRESET = "DefaultPreset_639452";
const groupOverrideKey = (presetID: string) => `evejs.ui.overview.preset.${presetID}`;
/** The pilot's changes to a preset: groups added and removed, and its exception states where changed (whole lists). */
interface PresetOverrides { add: number[]; remove: number[]; filtered?: number[]; alwaysShown?: number[] }
function groupOverrides(presetID: string): PresetOverrides {
  try {
    const v = JSON.parse(localStorage.getItem(groupOverrideKey(presetID)) ?? "null") as Partial<PresetOverrides> | null;
    return { add: v?.add ?? [], remove: v?.remove ?? [], ...(v?.filtered ? { filtered: v.filtered } : {}), ...(v?.alwaysShown ? { alwaysShown: v.alwaysShown } : {}) };
  } catch {
    return { add: [], remove: [] };
  }
}
const hasOverrides = (o: PresetOverrides) => o.add.length > 0 || o.remove.length > 0 || o.filtered !== undefined || o.alwaysShown !== undefined;

function presetMask(data: OverviewPresetData | undefined, presetID?: string): OverviewTab["overview"] {
  if (!data) return null;
  const groups = new Set(data.groups);
  const o = presetID ? groupOverrides(presetID) : null;
  if (o) {
    for (const g of o.add) groups.add(g);
    for (const g of o.remove) groups.delete(g);
  }
  return {
    name: data.name,
    groups,
    filteredStates: o?.filtered ?? data.filteredStates ?? [],
    alwaysShownStates: o?.alwaysShown ?? data.alwaysShownStates ?? [],
  };
}

let names: Promise<{ types: Record<string, [string | null, number | null]>; groups: Record<string, [string | null, number | null]> } | null> | null = null;
export function typeNames() {
  names ??= fetch("/client-assets/typeNames.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return names;
}

export interface OverviewHooks {
  /** The overview window this is (overviewWindowUtil's windowInstanceID): 0 the first, others made by Move Tab To. */
  instanceID?: number;
  /** presetSvc.MoveTab(tabID, windowInstanceID): the tab moved to that window, or to a new one where null. */
  moveTab?(from: Overview, tab: number, to: number | null): void;
  /** The Tabs panel changed the tabs of every window: the others read theirs again. */
  tabsEdited?(from: Overview): void;
  /** The other overview windows, by id, for Move Tab To. */
  otherWindows?(from: Overview): readonly Overview[];
  select(itemID: number): void;
  activate(itemID: number): void;
  glyph(e: Entity): string;
  /** The row's Name (uix.GetSlimItemName); the slim's name, else the type's, where it is not given. */
  name?(e: Entity): string;
  pilotID?: number;
  word?(label: string, args?: Readonly<Record<string, string | number>>): string | null;
  notice?(text: string): void;
  /** A client message by its dialog name (prompt_player_fsd_dialog, OK only). */
  say?(dialog: string, fallback: string): void;
  /** A client yes / no question by its dialog name; true on Yes. */
  ask?(dialog: string, fallback: string): Promise<boolean>;
  /** stateSvc's mouseOver: the thing a row is under the pointer (null when none), shared with its bracket in space. */
  hover?(itemID: number | null): void;
  /** The affiliation columns' words for the rows listed, the columns shown asked for where the page has them not yet. */
  affiliation?(rows: readonly Entity[], columns: ReadonlySet<string>): ((e: Entity) => OverviewAffiliation) | null;
  /** bracketSettings' override (UseSelectedTabBracketPreset / ShowAll / HideAll), as the ⋮ menu's Bracket Visibility sets it. */
  bracketOverride?(): BracketOverride;
  setBracketOverride?(value: BracketOverride): void;
}

export class Overview {
  readonly window: PlayWindow;
  readonly instanceID: number;
  private readonly table = document.createElement("table");
  private readonly tbody = document.createElement("tbody");
  private types: Record<string, [string | null, number | null]> = {};
  private groupNames: Record<string, [string | null, number | null]> = {};
  private lastDraw = 0;
  private drawnRows = "";
  private selected: number | null = null;
  private tabs: OverviewTab[] = [];
  private presetChoices: PresetChoice[] = [];
  private tab = 0;
  private readonly tabsEl: HTMLDivElement;
  private readonly tabKey: string;
  private readonly sortKey: string;
  private readonly sortEnabledKey: string;
  private readonly tabSorts = new Map<number, OverviewSort>();
  private sort: OverviewSort;
  private sortEnabled = true;
  private readonly lockIcon = document.createElement("img");
  private readonly menu = new ContextMenu();
  private masks = new Map<string, OverviewTab["overview"]>();
  private addTabWindow: PlayWindow | null = null;
  private tabSettings: TabSettings[] = [];
  private lockFlash?: Animation;

  constructor(private readonly hooks: OverviewHooks) {
    this.instanceID = hooks.instanceID ?? 0;
    this.window = new PlayWindow({ id: this.instanceID ? `overview-${this.instanceID}` : "overview", caption: "Overview", left: innerWidth - 586 - this.instanceID * 40, top: 260 + this.instanceID * 40, width: 566, height: 380, closable: false,
      menu: (button) => { const r = button.getBoundingClientRect(); this.menu.open(r.left, r.bottom, this.moreOptions()); } });
    this.window.body.classList.add("ov");
    // the client's default (not compact) layout: the caption "Overview (preset)" in the header, the tabs in a row under
    // it (OverviewTabGroup, 32 high, the chosen one marked by a SelectionIndicatorLine), a DividerLine, then the scroll
    this.window.body.innerHTML = `<div class="ov-tabs"><span class="ov-tab active">General</span></div>`;
    this.tabsEl = this.window.body.querySelector(".ov-tabs")!;
    this.tabsEl.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".ov-add-tab")) { this.openAddTab(); return; }
      const i = Number((e.target as HTMLElement).closest<HTMLElement>(".ov-tab")?.dataset.tab);
      if (Number.isInteger(i)) this.choose(i);
    });
    // a right-click on a tab: its menu (OverviewTab.GetMenu)
    this.tabsEl.addEventListener("contextmenu", (e) => {
      const i = Number((e.target as HTMLElement).closest<HTMLElement>(".ov-tab")?.dataset.tab);
      if (!Number.isInteger(i) || !this.tabSettings[i]) return;
      e.preventDefault();
      this.menu.open(e.clientX, e.clientY, this.tabMenu(i));
    });
    this.table.className = "ov-table";
    this.table.innerHTML = `<colgroup></colgroup><thead></thead>`;
    const pilotSuffix = (hooks.pilotID === undefined ? "" : `:${hooks.pilotID}`) + (this.instanceID ? `:w${this.instanceID}` : "");
    this.tabKey = TAB_KEY + pilotSuffix;
    this.sortKey = SORT_KEY + pilotSuffix;
    this.sortEnabledKey = SORT_ENABLED_KEY + pilotSuffix;
    this.sort = readSort(this.sortKey, readSort(SORT_KEY));
    try { this.sortEnabled = localStorage.getItem(this.sortEnabledKey) !== "false"; } catch { /* enabled by default */ }
    this.setupHeaders();
    this.table.appendChild(this.tbody);
    const scroller = document.createElement("div");
    scroller.className = "ov-scroll";
    scroller.appendChild(this.table);
    this.window.body.appendChild(scroller);
    // OverviewScrollEntry.OnMouseEnter / OnMouseExit: stateSvc.SetState(itemID, mouseOver, 1 / 0)
    this.tbody.addEventListener("mouseover", (e) => {
      const id = Number((e.target as HTMLElement).closest("tr")?.dataset.id);
      if (id && id !== this.hovered) this.hooks.hover?.(id);
    });
    this.tbody.addEventListener("mouseleave", () => this.hooks.hover?.(null));
    this.tbody.addEventListener("click", (e) => {
      const id = Number((e.target as HTMLElement).closest("tr")?.dataset.id);
      if (id) this.hooks.select(id);
    });
    this.tbody.addEventListener("dblclick", (e) => {
      const id = Number((e.target as HTMLElement).closest("tr")?.dataset.id);
      if (id) this.hooks.activate(id);
    });
    void overviewStateOrders().then((o) => { this.stateOrders = o; this.applyAppearance(false); });
    applyOverviewMisc();
    // the settings window's lists, read ahead so they are there when it opens
    void overviewStates().then((st) => { this.states = st; });
    void overviewFilterGroups().then((g) => { this.filterGroups = g; });
    void typeNames().then((n) => {
      if (!n) return;
      this.types = n.types;
      this.groupNames = n.groups;
      this.lastDraw = 0;
    });
    void overviewPresets().then((p) => {
      if (!p) return;
      const masks = new Map(Object.entries(p.presets).map(([id, preset]) => [id, presetMask(preset, id)]));
      this.masks = masks;
      this.presetData = { ...p.presets };
      this.profileTabs = p.tabs.map((t) => ({ name: t.name, preset: t.preset, bracket: t.bracket ?? null }));
      this.tabSettings = this.storedTabs() ?? this.profileTabs.map((t) => ({ ...t }));
      this.tabs = this.tabSettings.map((t) => this.tabOf(t));
      // overviewUtil.GetDefaultFiltersSorted: by category (CATEGORY_ORDER), each sorted by its display name with category
      const order = p.categoryOrder ?? [0, 1, 2, 3, 4, 5];
      this.presetChoices = Object.entries(p.presets)
        .flatMap(([id, preset]) => preset ? [{ id, name: preset.name, label: preset.categoryName ? `${preset.categoryName}: ${preset.name}` : preset.name,
          groups: masks.get(id)!.groups, category: preset.categoryID ?? 0, categoryName: preset.categoryName ?? null }] : [])
        .sort((a, b) => (order.indexOf(a.category) - order.indexOf(b.category)) || a.label.localeCompare(b.label));
      this.addCustomPresets();
      let saved = 0;
      try { saved = Number(localStorage.getItem(this.tabKey) ?? localStorage.getItem(TAB_KEY)); } catch { /* no storage: the first tab */ }
      this.choose(Number.isInteger(saved) && this.tabs[saved] ? saved : 0, true);
    });
  }

  private setupHeaders(): void {
    const head = this.table.tHead!;
    this.lockIcon.className = "ov-sort-lock";
    this.lockIcon.src = clientTexture("res:/UI/Texture/eveicon/system_icons/locked_16px.png");
    this.lockIcon.alt = "";
    this.drawHead();
    head.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.menu.open(e.clientX, e.clientY, this.headerMenu());
    });
    head.addEventListener("keydown", (e) => {
      if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = ((e.target as HTMLElement).closest("button") ?? head).getBoundingClientRect();
      this.menu.open(rect.left, rect.bottom, this.headerMenu());
    });
    head.addEventListener("click", (e) => {
      const column = (e.target as HTMLElement).closest<HTMLElement>("th[data-sort]")?.dataset.sort as SortColumn | undefined;
      if (!column) return;
      if (!this.sortEnabled) {
        this.hooks.notice?.(this.hooks.word?.(SORT_DISABLED) ?? DISABLED_TEXT);
        void playUiEvent("msg_uiwarning03_play");
        this.lockFlash?.cancel();
        this.lockFlash = this.lockIcon.animate([{ opacity: 0.75 }, { opacity: 1 }, { opacity: 0.75 }], { duration: 500 });
        return;
      }
      // SortHeaders.SetCurrentActive carries the direction to a new column.
      this.sort = { column, down: this.sort.column === column ? !this.sort.down : this.sort.down };
      this.keepSort();
      this.markSort();
      this.lastDraw = 0;
    });
    head.addEventListener("pointerover", () => { this.lockIcon.title = this.hooks.word?.(SORT_DISABLED) ?? DISABLED_TEXT; });
  }

  /** overviewColumns.GetColumnOrder, with ColumnsPanel.LoadColumns' missing columns after: every column in the tab's order. */
  private columnOrder(tab = this.tab): readonly ColumnDef[] {
    const order = this.tabSettings[tab]?.order ?? [];
    const byID = new Map(COLUMNS.map((c) => [c.id, c]));
    return [...order.flatMap((id) => byID.get(id) ?? []), ...COLUMNS.filter((c) => !order.includes(c.id))];
  }

  /** overviewColumns.GetColumns: the tab's visible columns (presetSvc.GetTabVisibleColumnIDs) in the tab's order. */
  private visibleColumns(tab = this.tab): readonly ColumnDef[] {
    const shown = new Set<ColumnID>(this.tabSettings[tab]?.columns ?? DEFAULT_VISIBLE);
    return this.columnOrder(tab).filter((c) => shown.has(c.id));
  }

  /**
   * ColumnConfigurationWindow (400 x 440, "UI/Overview/TabColumnsCaption"): ColumnsPanel's hint, Reset Columns
   * (ResetTabVisibleColumnIDs and ResetTabColumnOrder), and each column in the tab's order with its checkbox; a column
   * dragged onto another goes before it (MoveColumn), onto the list's end last.
   */
  openColumnOrder(tab = this.tab): void {
    const word = (label: string, own: string, args?: Readonly<Record<string, string | number>>) => this.hooks.word?.(label, args) ?? own;
    document.querySelector(".ov-columns-window")?.closest(".pw")?.remove();
    const tabName = this.tabSettings[tab]?.name ?? "";
    const win = new PlayWindow({ id: "overview-columns", caption: word("UI/Overview/TabColumnsCaption", `Columns: ${tabName}`, { tabName }),
      left: Math.round(innerWidth / 2 - 200), top: Math.round(innerHeight / 2 - 220), width: 400, height: 440, minWidth: 400, minHeight: 440 });
    win.body.classList.add("ov-columns-window");
    const draw = () => {
      const shown = new Set(this.visibleColumns(tab).map((c) => c.id));
      win.body.innerHTML = `<p class="ov-columns-hint"></p><div class="ov-columns-list">${this.columnOrder(tab).map((c) =>
        `<label class="ov-columns-row" draggable="true" data-col="${c.id}"><input type="checkbox"${shown.has(c.id) ? " checked" : ""}><span>${esc(word(c.label, c.own))}</span></label>`).join("")}<div class="ov-columns-end" data-col=""></div></div>
        <div class="ov-add-buttons"><button type="button" class="ov-columns-reset"></button></div>`;
      win.body.querySelector(".ov-columns-hint")!.textContent = word("UI/Overview/HintToggleDisplayStateAndOrder", "Toggle the columns shown, and drag them into the order you want.");
      win.body.querySelector(".ov-columns-reset")!.textContent = word("UI/Overview/ResetColumns", "Reset Columns");
    };
    const save = () => {
      try { this.saveTabs(); } catch { /* the change lasts the page */ }
      if (tab === this.tab) this.drawHead();
      draw();
    };
    win.body.addEventListener("change", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".ov-columns-row");
      const t = this.tabSettings[tab];
      if (!row || !t) return;
      const id = row.dataset.col as ColumnID;
      const now = new Set<ColumnID>(t.columns ?? DEFAULT_VISIBLE);
      if ((e.target as HTMLInputElement).checked) now.add(id); else now.delete(id);
      t.columns = COLUMNS.filter((c) => now.has(c.id)).map((c) => c.id);
      save();
    });
    let dragged: ColumnID | null = null;
    win.body.addEventListener("dragstart", (e) => { dragged = ((e.target as HTMLElement).closest<HTMLElement>(".ov-columns-row")?.dataset.col as ColumnID) ?? null; });
    win.body.addEventListener("dragover", (e) => { if (dragged) e.preventDefault(); });
    win.body.addEventListener("drop", (e) => {
      e.preventDefault();
      const t = this.tabSettings[tab];
      const onto = (e.target as HTMLElement).closest<HTMLElement>("[data-col]");
      if (!t || !dragged || !onto) return;
      const order = this.columnOrder(tab).map((c) => c.id).filter((id) => id !== dragged);
      const at = onto.dataset.col ? order.indexOf(onto.dataset.col as ColumnID) : order.length;
      order.splice(at < 0 ? order.length : at, 0, dragged);
      t.order = order;
      dragged = null;
      save();
    });
    win.body.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest(".ov-columns-reset")) return;
      const t = this.tabSettings[tab];
      if (!t) return;
      delete t.columns;
      delete t.order;
      save();
    });
    draw();
    (this.window.root.parentElement ?? document.body).append(win.root);
  }

  /** The header and the columns' widths, for the tab's columns. */
  private drawHead(): void {
    const word = (label: string, own: string) => this.hooks.word?.(label) ?? own;
    const cols = this.visibleColumns();
    this.table.querySelector("colgroup")!.innerHTML = cols.map((c) => `<col style="width:${c.width}px">`).join("");
    this.table.style.width = `${cols.reduce((n, c) => n + c.width, 0)}px`;
    this.table.tHead!.innerHTML = `<tr>${cols.map((c) => {
      if (c.id === "ICON") return `<th class="ov-icon"></th>`;
      const text = word(c.label, c.own) + (c.unit ? ` (${word(c.unit, c.unit.endsWith("DegreesPerSecondUnitShort") ? "deg/s" : "m/s")})` : "");
      return `<th${c.right ? ` class="ov-dist"` : ""} data-sort="${c.sort}"><button type="button" aria-label="${esc(text)}">${esc(text)}</button></th>`;
    }).join("")}</tr>`;
    const lockAt = this.table.tHead!.querySelector('th[data-sort="velocity"]') ?? this.table.tHead!.querySelector("th:last-child");
    lockAt?.appendChild(this.lockIcon);
    this.markSort();
    this.drawnRows = "";
    this.lastDraw = 0;
  }

  /**
   * SortHeaders' menu (OverviewWindow.GetMenuForsortHeaders): GetColumnVisibilitySubMenu's checkbox for each column of
   * NAME_BY_COLUMN with its description, then GetHeaderSortingOptions' Header sorting enabled.
   */
  private headerMenu(): (ContextEntry | null)[] {
    const word = (label: string, own: string) => this.hooks.word?.(label) ?? own;
    const shown = new Set(this.visibleColumns().map((c) => c.id));
    const out: (ContextEntry | null)[] = COLUMNS.map((c) => ({
      label: word(c.label, c.own), checkbox: true, checked: shown.has(c.id), hint: c.hint ? word(c.hint, "") || null : null,
      run: () => this.setColumnShown(c.id, !shown.has(c.id)),
    }));
    out.push(null, { label: word("UI/Overview/ChangeOrder", "Change Order..."), run: () => this.openColumnOrder() });
    out.push(null, {
      label: word(SORT_ENABLED, "Header sorting enabled"), checkbox: true, checked: this.sortEnabled, hint: word(SORT_HINT, "") || null,
      run: () => {
        this.sortEnabled = !this.sortEnabled;
        try { localStorage.setItem(this.sortEnabledKey, String(this.sortEnabled)); } catch { /* kept for this visit */ }
        this.markSort();
      },
    });
    return out;
  }

  /**
   * OverviewSettingsWnd (UI/Overview/OverviewSettings, 520 x 600): its tab group, of which Tabs and Filters are here so
   * far. TabsPanel: for each of MAX_TAB_NUM slots the Tab Name (MAX_TAB_NAME_LENGTH), Filter and Bracket Filter combos -
   * Show All Brackets first - and a delete button; naming an empty slot adds the tab, UpdateOverviewTab on each change.
   * TabPresetPanel: the filter to edit, its Types Shown - GetListOfCategories' categories (the client's own, read through
   * gridcheck into overviewFilterGroups.json), each "shown / all" in the accent colour when all, white when some, grey
   * when none, opened to its groups' checkboxes; Select All, Deselect All, the search; Revert while it has changes.
   */
  openSettings(panel: "tabs" | "filters" | "appearance" | "ships" | "misc" | "history" = "tabs", presetID?: string): void {
    const word = (label: string, own: string) => this.hooks.word?.(label) ?? own;
    document.querySelector(".ov-settings")?.closest(".pw")?.remove();
    const win = new PlayWindow({ id: "overview-settings", caption: word("UI/Overview/OverviewSettings", "Overview Settings"),
      left: Math.round(innerWidth / 2 - 285), top: Math.round(innerHeight / 2 - 300), width: 570, height: 600, minWidth: 570, minHeight: 500 });
    win.body.classList.add("ov-settings");
    let current = panel;
    let editing = presetID ?? this.tabSettings[this.tab]?.preset ?? this.presetChoices[0]?.id ?? "";
    let search = "";
    let sub: "types" | "states" = "types";
    let appearanceSub: "flag" | "background" = "flag";
    const open = new Set<string>();
    const options = (selected: string | null, showAll: boolean) =>
      (showAll ? `<option value=""${selected === null ? " selected" : ""}>${esc(word("UI/Overview/ShowAllBrackets", "Show All Brackets"))}</option>` : "") +
      this.presetChoices.map((p) => `<option value="${esc(p.id)}"${p.id === selected ? " selected" : ""}>${esc(p.label)}</option>`).join("");
    const tabsPanel = () => {
      // an empty slot shows overviewPresetSvc.GetDefaultPreset (DefaultPreset_639452, "General: General", read from the client)
      const first = this.presetChoices.find((p) => p.id === "DefaultPreset_639452")?.id ?? this.presetChoices[0]?.id ?? null;
      const all = this.allTabs();
      const rows = Array.from({ length: MAX_TAB_NUM }, (_, i) => {
        const t = all[i];
        const c = t?.color ?? null;
        return `<div class="ov-set-row" data-slot="${i}"><span class="ov-set-color"${t ? "" : " data-empty"}><span style="${c ? `background:${rgbCss(c)}` : ""}"></span><img src="${clientTexture("res:/ui/texture/icons/38_16_229.png")}" alt=""></span><input class="ov-set-name" maxlength="${MAX_TAB_NAME_LENGTH}" value="${esc(t?.name ?? "")}" autocomplete="off">
          <select class="ov-set-filter" title="${esc(word("UI/Overview/ChooseOverviewPreset", ""))}">${options(t?.preset ?? first, false)}</select>
          <select class="ov-set-bracket" title="${esc(word("UI/Overview/ChooseBracketPreset", ""))}">${options(t ? t.bracket : null, true)}</select>
          ${t ? `<img class="ov-set-delete" src="${clientTexture("res:/UI/Texture/eveicon/system_icons/close_16px.png")}" alt="" title="${esc(word("UI/Overview/DeleteTab", "Delete Tab"))}">` : `<span></span>`}</div>`;
      }).join("");
      return `<div class="ov-set-panel"><div class="ov-set-row ov-set-head"><span></span><span>${esc(word("UI/Overview/TabName", "Tab Name"))}</span><span>${esc(word("UI/Overview/Filter", "Filter"))}</span><span>${esc(word("UI/Overview/BracketFilter", "Bracket Filter"))}</span><span></span></div>${rows}</div>`;
    };
    const filtersPanel = () => {
      const shown = this.masks.get(editing)?.groups ?? new Set<number>();
      const q = search.trim().toLowerCase();
      const cats = (this.filterGroups ?? []).map((c) => ({ ...c, groups: q ? c.groups.filter((g) => g.name.toLowerCase().includes(q)) : c.groups }))
        .filter((c) => c.groups.length);
      const tree = cats.map((c) => {
        const on = c.groups.filter((g) => g.groupIDs.some((id) => shown.has(id))).length;
        const tone = on >= c.groups.length ? "all" : on > 0 ? "some" : "none";
        const expanded = open.has(c.category) || !!q;
        const groups = expanded ? c.groups.map((g) => `<label class="ov-filt-group"><input type="checkbox" data-groups="${g.groupIDs.join(",")}"${g.groupIDs.some((id) => shown.has(id)) ? " checked" : ""}><span>${esc(g.name)}</span></label>`).join("") : "";
        return `<div class="ov-filt-cat ${tone}${expanded ? " open" : ""}" data-cat="${esc(c.category)}"><span class="ov-filt-caret"></span>${esc(c.category)} ${on} / ${c.groups.length}</div>${groups}`;
      }).join("");
      const changed = groupOverrides(editing);
      const mask = this.masks.get(editing);
      const statesList = (this.states ?? []).slice().sort((a, b) => a.text.localeCompare(b.text));
      const radio = (flag: number, value: string, on: boolean) => `<input type="radio" name="ov-state-${flag}" value="${value}" data-flag="${flag}"${on ? " checked" : ""}>`;
      const states = statesList.map((st) => {
        const always = mask?.alwaysShownStates.includes(st.flag) ?? false, filtered = mask?.filteredStates.includes(st.flag) ?? false;
        return `<div class="ov-state-row" title="${esc(st.hint ?? "")}">${flagMarkup({ flag: st.flag, text: st.text, iconIndex: st.iconIndex, flagColor: st.flagColor, backgroundColor: st.flagColor, flagBlink: false, backgroundBlink: false, iconColor: st.iconColor })}<span>${esc(st.text)}</span>
          ${radio(st.flag, "alwaysShow", always)}${radio(st.flag, "filterOut", filtered && !always)}${radio(st.flag, "unfiltered", !always && !filtered)}</div>`;
      }).join("");
      const eye = (tex: string, color: string, hint: string, own: string) => `<span class="ov-state-eye" title="${esc(word(hint, own))}" style="background:${color};-webkit-mask:url(${clientTexture(tex)}) center/16px no-repeat;mask:url(${clientTexture(tex)}) center/16px no-repeat"></span>`;
      const statesPane = `<div class="ov-state-head">${eye("res:/ui/texture/icons/generic/visible_default_16.png", "rgba(26,255,26,0.75)", "UI/Overview/FilterStateAlwaysShowLong", "Always show")}${eye("res:/ui/texture/icons/generic/visible_dontshow_16.png", "rgba(255,13,13,0.75)", "UI/Overview/FilterStateFilterOutLong", "Filter out")}${eye("res:/ui/texture/icons/generic/visible_matchstate_16.png", "rgba(51,102,153,0.75)", "UI/Overview/FilterStateNotFilterOutLong", "Do not filter out")}</div><div class="ov-filt-tree ov-state-list">${states}</div>`;
      return `<div class="ov-set-panel ov-filt">
        <div class="ov-filt-title">${esc(word("UI/Overview/FilterToEdit", "Select filter to edit"))}</div>
        <div class="ov-filt-top"><select class="ov-filt-preset">${options(editing, false)}</select>${editing.startsWith(CUSTOM_PREFIX) ? `<button type="button" class="ov-filt-delete">${esc(word("UI/Common/Delete", "Delete"))}</button>` : ""}</div>
        <div class="ov-set-tabs ov-filt-sub"><span class="ov-set-tab${sub === "types" ? " active" : ""}" data-sub="types">${esc(word("UI/Overview/TypesShown", "Types Shown"))}</span><span class="ov-set-tab${sub === "states" ? " active" : ""}" data-sub="states">${esc(word("UI/Overview/Exceptions", "Exceptions"))}</span></div>
        ${sub === "types" ? `<div class="ov-filt-bar"><button type="button" class="ov-filt-all">${esc(word("UI/Common/SelectAll", "Select All"))}</button><button type="button" class="ov-filt-none">${esc(word("UI/Common/DeselectAll", "Deselect All"))}</button>
          <input class="ov-filt-search" placeholder="${esc(word("UI/Common/Search", "Search"))}" value="${esc(search)}" autocomplete="off"></div>
        <div class="ov-filt-tree">${tree}</div>` : statesPane}
        <div class="ov-add-buttons"><button type="button" class="ov-filt-revert"${hasOverrides(changed) ? "" : " disabled"}>${esc(word("UI/Common/Buttons/Revert", "Revert"))}</button>
          <button type="button" class="ov-filt-save"${editing.startsWith(CUSTOM_PREFIX) && hasOverrides(changed) ? "" : " disabled"}>${esc(word("UI/Common/Buttons/Save", "Save"))}</button>
          <button type="button" class="ov-filt-saveas">${esc(word("UI/Common/Buttons/SaveAs", "Save As"))}</button></div></div>`;
    };
    // AppearancePanel: the two checkboxes, the note and the two apply-to checkboxes, the Colortag / Background lists (each
    // state's checkbox, its text and, while on, its flag; dragged to reorder) and Reset All
    // HistoryPanel: HistoryText, the shared profiles loaded (newest first, 15), and under a line the stored profile with Restore Profile
    const historyPanel = () => {
      let history: { overviewName: string; timestamp: number }[] = [];
      try { history = Object.values(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "{}") as Record<string, { overviewName: string; timestamp: number }>); } catch { /* none */ }
      const lines = history.sort((a, b) => b.timestamp - a.timestamp).slice(0, 15)
        .map((h) => `<div>${esc(this.hooks.word?.("UI/Overview/ProfileLinkWithTimestamp", { profileLink: h.overviewName, timestamp: fmtDate(h.timestamp) }) ?? `${h.overviewName} - ${fmtDate(h.timestamp)}`)}</div>`).join("");
      const r = this.restoreData();
      const based = r ? this.hooks.word?.("UI/Overview/StoredOverviewBasedOn", { overviewName: r.name, timestamp: fmtDate(r.timestamp) }) ?? `Based on ${r.name} (${fmtDate(r.timestamp)})` : "";
      return `<div class="ov-set-panel ov-history"><div class="ov-history-text">${esc(word("UI/Overview/HistoryText", "Overview profiles you have loaded from links"))}</div><div class="ov-history-list">${lines}</div>${r
        ? `<div class="ov-history-restore"><div class="ov-history-labels"><div>${esc(word("UI/Overview/AutomaticallyStoredOverviewHeader", "Automatically stored overview"))}</div><div class="ov-history-based">${esc(based)}</div></div><button type="button" class="ov-history-restore-btn">${esc(word("UI/Overview/RestoreProfile", "Restore Profile"))}</button></div>` : ""}</div>`;
    };
    const appearancePanel = () => {
      const a = this.appearance;
      const check = (key: keyof AppearanceSettings, label: string, own: string) => `<label class="ov-app-check"><input type="checkbox" data-app="${key}"${a[key] ? " checked" : ""}><span>${esc(word(label, own))}</span></label>`;
      if (!this.states || !this.stateOrders) void Promise.all([overviewStates(), overviewStateOrders()]).then(([st, o]) => { this.states = st; this.stateOrders = o; if (st && o && current === "appearance") draw(); });
      const props = new Map((this.states ?? []).map((st) => [st.flag, st]));
      const colors = new Map((this.stateOrders?.[appearanceSub] ?? []).map((e) => [e.flag, e.color]));
      const rows = this.appearanceList(appearanceSub).map((e) => {
        const st = props.get(e.flag);
        if (!st) return "";
        const color = this.appearance.colors?.[`${appearanceSub}:${e.flag}`] ?? colors.get(e.flag) ?? st.flagColor;
        // FlagEntry: the Colortag list its FlagIconWithState, the Background list a 9 x 9 Fill of the colour; either blinking as set
        const blink = this.appearance.blinks?.[`${appearanceSub}:${e.flag}`] ?? this.stateOrders?.[appearanceSub].find((x) => x.flag === e.flag)?.blink ?? false;
        const preview = appearanceSub === "flag"
          ? flagMarkup({ flag: e.flag, text: st.text, iconIndex: st.iconIndex, flagColor: color, backgroundColor: color, flagBlink: blink, backgroundBlink: false, iconColor: st.iconColor })
          : `<span class="ov-app-bg${blink ? " blink" : ""}" style="background:rgba(${color.map((c, i) => (i < 3 ? Math.round(c * 255) : c)).join(",")})"></span>`;
        return `<div class="ov-app-row" draggable="true" data-flag="${e.flag}" title="${esc(word("UI/Overview/HintToggleDisplayState", ""))}"><input type="checkbox" data-flag="${e.flag}"${e.on ? " checked" : ""}><span>${esc(st.text)}</span><span class="ov-app-color">${preview}<img src="${clientTexture("res:/ui/texture/icons/38_16_229.png")}" alt=""></span></div>`;
      }).join("");
      return `<div class="ov-set-panel ov-app">${check("smallTags", "UI/Overview/UseSmallColortags", "Use small colortags")}${check("smallFont", "UI/Overview/UseSmallFont", "Use small font")}
        <p class="ov-app-note">${esc(word("UI/Overview/ApplyToShipsAndDronesByDefault", "The Colortag and Background settings apply to ships and drones by default"))}</p>
        ${check("applyStructures", "UI/Overview/ApplyToStructures", "Also apply to structures")}${check("applyOther", "UI/Overview/ApplyToOtherObjects", "Also apply to other objects in space")}
        <div class="ov-set-tabs ov-filt-sub"><span class="ov-set-tab${appearanceSub === "flag" ? " active" : ""}" data-appsub="flag">${esc(word("UI/Overview/Colortag", "Colortag"))}</span><span class="ov-set-tab${appearanceSub === "background" ? " active" : ""}" data-appsub="background">${esc(word("UI/Overview/Background", "Background"))}</span></div>
        <div class="ov-filt-tree ov-app-list">${rows}</div>
        <div class="ov-add-buttons"><button type="button" class="ov-app-reset">${esc(word("UI/Commands/ResetAll", "Reset All"))}</button></div></div>`;
    };
    // ShipsPanel: the formats menu, Hide corp ticker if pilot is in Alliance, each ship label part (ShipEntry: on, pre,
    // its name, post, bold / italic / underline, size 8 to 14, colour; ShipEntryLinebreak: Linebreak and remove), dragged
    // to reorder, Add Linebreak, and the preview
    const LABEL_NAMES: Record<string, [string, string]> = { "ship type": ["UI/Common/ShipType", "Ship Type"], alliance: ["UI/Shared/AllianceTicker", "Alliance short name"],
      corporation: ["UI/Common/CorpTicker", "Corp Ticker"], "ship name": ["UI/Common/ShipName", "Ship Name"], "pilot name": ["UI/Common/PilotName", "Pilot Name"] };
    const shipsPanel = () => {
      const st = shipLabelSettings();
      const hex = (c: number[] | null | undefined) => "#" + (c ?? [1, 1, 1]).slice(0, 3).map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
      const rows = st.labels.map((l, i) => {
        if (l.type === "linebreak") return `<div class="ov-ship-row ov-ship-br" draggable="true" data-i="${i}"><span class="ov-ship-grip">≡</span><span>${esc(word("UI/Overview/Linebreak", "Linebreak"))}</span><img class="ov-ship-remove" src="${clientTexture("res:/UI/Texture/eveicon/system_icons/close_16px.png")}" alt=""></div>`;
        const name = l.type ? LABEL_NAMES[l.type] : null;
        const hint = l.type === "corporation" || l.type === "alliance" ? word("UI/Overview/OnlyShownWhenAvailable", "") : l.type === null ? word("UI/Overview/AdditionalTextForCorpTicker", "") : "";
        const size = l.fontsize ?? 12;
        return `<div class="ov-ship-row" draggable="true" data-i="${i}"><input type="checkbox" data-f="state"${l.state ? " checked" : ""}>
          <input class="ov-ship-text" data-f="pre" value="${esc(l.pre ?? "")}"><span class="ov-ship-name" title="${esc(hint)}">${name ? esc(word(name[0], name[1])) : ""}</span><input class="ov-ship-text" data-f="post" value="${esc(l.post ?? "")}">
          <label><input type="checkbox" data-f="bold"${l.bold ? " checked" : ""}><b>B</b></label><label><input type="checkbox" data-f="italic"${l.italic ? " checked" : ""}><i>/</i></label><label><input type="checkbox" data-f="underline"${l.underline ? " checked" : ""}><u>U</u></label>
          <select data-f="fontsize">${[8, 9, 10, 11, 12, 14].map((n) => `<option${n === size ? " selected" : ""}>${n}</option>`).join("")}</select>
          <input type="color" data-f="color" value="${hex(l.color)}"${l.color ? "" : " class=\"unset\""}></div>`;
      }).join("");
      const preview = shipLabelMarkup({ typeName: "Ibis", shipName: "Ibis", displayName: "Pilot", corporationID: 98000001, allianceID: 99000001, corpTicker: "CORP_TICKER", allianceTicker: "ALLIANCE_TICKER" }, st);
      return `<div class="ov-set-panel ov-ships"><button type="button" class="ov-ship-menu" title="">≡</button>
        <label class="ov-app-check"><input type="checkbox" data-hide${st.hideCorpTicker ? " checked" : ""}><span>${esc(word("UI/Overview/HideTickerIfInAlliance", "Hide corp ticker if pilot is in Alliance"))}</span></label>
        <div class="ov-ship-list">${rows}</div>
        <div class="ov-add-buttons"><button type="button" class="ov-ship-addbr">${esc(word("UI/Overview/AddLinebreak", "Add Linebreak"))}</button></div>
        <div class="ov-ship-preview-title">${esc(word("UI/Common/Preview", "Preview"))}:</div><div class="ov-ship-preview">${preview}</div></div>`;
    };
    // MiscPanel, the switches with something behind them so far: Show Targeting Crosshair, Display In-Range Brackets with
    // its Ships / NPCs / Drones, and Reset All Settings (ResetAllOverviewSettings first)
    const miscPanel = () => {
      const m = overviewMisc();
      const box = (key: keyof typeof m, label: string, own: string, sub = false) => `<label class="ov-app-check${sub ? " sub" : ""}"><input type="checkbox" data-misc="${key}"${m[key] ? " checked" : ""}><span>${esc(word(label, own))}</span></label>`;
      // MiscPanel: Move entries with broadcasts to top, then Brackets and Targets
      return `<div class="ov-set-panel ov-misc">${box("broadcastsToTop", "UI/Overview/MoveBroadcastersToTop", "Move entries with broadcasts to top")}<div class="ov-misc-head">${esc(word("UI/Overview/BracketAndTargetsHeader", "Brackets and Targets"))}</div>
        ${box("targetCrosshair", "UI/SystemMenu/GeneralSettings/Inflight/ShowTargettingCrosshair", "Show Targeting Crosshair")}
        ${box("damageIndications", "UI/Overview/DisplayDamageIndications", "Display Damage Indications")}
        ${box("moduleLinks", "UI/Overview/DisplayModuleLinks", "Display Active Module Links")}
        ${box("inRange", "UI/Overview/DisplayRangeBrackets", "Display In-Range Brackets")}
        ${box("inRangeShips", "UI/Overview/Ships", "Ships", true)}${box("inRangeNPCs", "UI/Overview/NPCs", "NPCs", true)}${box("inRangeDrones", "UI/Overview/Drones", "Drones", true)}
        <div class="ov-add-buttons"><button type="button" class="ov-misc-import">${esc(word("UI/Overview/ImportOverviewSettings", "Import Settings"))}</button><button type="button" class="ov-misc-export">${esc(word("UI/Overview/ExportOverviewSettings", "Export Settings"))}</button><button type="button" class="ov-misc-reset">${esc(word("UI/Overview/ResetOverview", "Reset All Settings"))}</button></div></div>`;
    };
    const editLabels = (fn: (labels: ShipLabelPart[]) => void) => { const st = shipLabelSettings(); fn(st.labels); saveShipLabelSettings(st); draw(); };
    const draw = () => {
      const tabs: [typeof current, string][] = [["tabs", word("UI/Overview/Tabs", "Tabs")], ["filters", word("UI/Overview/Filters", "Filters")], ["appearance", word("UI/Generic/Appearance", "Appearance")], ["ships", word("UI/Common/ItemTypes/Ships", "Ships")], ["misc", word("UI/Generic/Misc", "Misc")], ["history", word("UI/Overview/ProfileHistory", "History")]];
      const scroll = win.body.querySelector(".ov-filt-tree")?.scrollTop ?? 0;
      // AddDraggableCont: the overview's name (overviewProfileName, else DefaultOverviewName), editable, and the Share handle
      const profileName = this.profileName();
      const top = `<div class="ov-set-top"><span class="ov-profile-name" title="${esc(profileName)}">${esc(profileName)}</span><span class="ov-share" draggable="true" title="${esc(word("UI/Overview/SharableOverviewIconHint", "Drag into chat to share the overview"))}"><img src="${clientTexture("res:/UI/Texture/classes/Overview/shareableOverview_small.png")}" alt="">${esc(word("UI/Overview/ShareOverview", "Share"))}</span></div>`;
      win.body.innerHTML = top + `<div class="ov-set-tabs">${tabs.map(([k, t]) => `<span class="ov-set-tab${k === current ? " active" : ""}" data-panel="${k}">${esc(t)}</span>`).join("")}</div>${current === "tabs" ? tabsPanel() : current === "filters" ? filtersPanel() : current === "appearance" ? appearancePanel() : current === "ships" ? shipsPanel() : current === "history" ? historyPanel() : miscPanel()}`;
      const tree = win.body.querySelector(".ov-filt-tree");
      if (tree) tree.scrollTop = scroll;
    };
    // UpdateOverviewTab: each named slot updated, or added after the others
    const update = () => {
      const next: TabSettings[] = [];
      const all = this.allTabs();
      for (const row of win.body.querySelectorAll<HTMLElement>(".ov-set-row[data-slot]")) {
        const i = Number(row.dataset.slot);
        const name = row.querySelector<HTMLInputElement>(".ov-set-name")!.value.trim();
        // a new one goes to the first window (GetDefaultWindowInstanceID)
        const old = all[i];
        if (!name) { if (old) next.push(old); continue; }
        next.push({ ...(old ?? {}), name, preset: row.querySelector<HTMLSelectElement>(".ov-set-filter")!.value,
          bracket: row.querySelector<HTMLSelectElement>(".ov-set-bracket")!.value || null });
      }
      this.setAllTabs(next);
      draw();
    };
    win.body.addEventListener("change", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest(".ov-set-row")) { update(); return; }
      if (t.matches(".ov-filt-preset")) { editing = (t as HTMLSelectElement).value; draw(); return; }
      if (t.matches("[data-misc]")) { setOverviewMisc({ [t.dataset.misc!]: (t as HTMLInputElement).checked }); draw(); return; }
      if (t.matches("[data-hide]")) { const st = shipLabelSettings(); st.hideCorpTicker = (t as HTMLInputElement).checked; saveShipLabelSettings(st); draw(); return; }
      const shipRow = t.closest<HTMLElement>(".ov-ship-row");
      if (shipRow && t.dataset.f) {
        const i = Number(shipRow.dataset.i), f = t.dataset.f;
        editLabels((labels) => {
          const l = labels[i]!;
          if (f === "state" || f === "bold" || f === "italic" || f === "underline") l[f] = (t as HTMLInputElement).checked;
          else if (f === "pre" || f === "post") l[f] = (t as HTMLInputElement).value;
          else if (f === "fontsize") l.fontsize = Number((t as HTMLSelectElement).value);
          else if (f === "color") { const v = (t as HTMLInputElement).value; l.color = [1, 3, 5].map((k) => Math.round((parseInt(v.slice(k, k + 2), 16) / 255) * 1000) / 1000); }
        });
        return;
      }
      if (t.matches("[data-app]")) { (this.appearance as unknown as Record<string, boolean>)[t.dataset.app!] = (t as HTMLInputElement).checked; this.applyAppearance(); draw(); return; }
      if (t.matches(".ov-app-row input")) {
        const list = this.appearanceList(appearanceSub).map((e) => (e.flag === Number(t.dataset.flag) ? { ...e, on: (t as HTMLInputElement).checked } : e));
        this.appearance = { ...this.appearance, [appearanceSub]: list };
        this.applyAppearance();
        draw();
        return;
      }
      if (t.matches(".ov-state-row input")) { this.setPresetState(editing, Number(t.dataset.flag), (t as HTMLInputElement).value as "alwaysShow" | "filterOut" | "unfiltered"); draw(); return; }
      const box = t.closest<HTMLInputElement>(".ov-filt-group input");
      if (box) { this.setPresetGroups(editing, box.dataset.groups!.split(",").map(Number), box.checked); draw(); }
    });
    win.body.addEventListener("input", (e) => {
      const t = e.target as HTMLInputElement;
      if (!t.matches(".ov-filt-search")) return;
      search = t.value;
      draw();
      const again = win.body.querySelector<HTMLInputElement>(".ov-filt-search")!;
      again.focus();
      again.setSelectionRange(search.length, search.length);
    });
    win.body.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.target as HTMLElement).matches(".ov-set-name")) update(); });
    // FlagEntry.GetMenu: Toggle Blink (stateSvc.SetStateBlink(where, flag, not current))
    win.body.addEventListener("contextmenu", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".ov-app-row");
      if (!row) return;
      e.preventDefault();
      const flag = Number(row.dataset.flag), where = appearanceSub, key = `${where}:${flag}`;
      const current = this.appearance.blinks?.[key] ?? this.stateOrders?.[where].find((x) => x.flag === flag)?.blink ?? false;
      this.menu.open(e.clientX, e.clientY, [{ label: word("UI/Overview/ToggleBlink", "Toggle Blink"), run: () => {
        this.appearance = { ...this.appearance, blinks: { ...this.appearance.blinks, [key]: !current } };
        this.applyAppearance();
        draw();
      } }]);
    });
    // AppearancePanel.Move: a state dragged onto another goes before it (ShipsPanel.MoveShipLabel the same for the labels)
    let draggedFlag: number | null = null;
    let draggedLabel: number | null = null;
    win.body.addEventListener("dragstart", (e) => {
      draggedFlag = Number((e.target as HTMLElement).closest<HTMLElement>(".ov-app-row")?.dataset.flag) || null;
      const shipRow = (e.target as HTMLElement).closest<HTMLElement>(".ov-ship-row");
      draggedLabel = shipRow ? Number(shipRow.dataset.i) : null;
    });
    win.body.addEventListener("dragover", (e) => { if (draggedFlag !== null || draggedLabel !== null) e.preventDefault(); });
    win.body.addEventListener("drop", (e) => {
      const ontoLabel = (e.target as HTMLElement).closest<HTMLElement>(".ov-ship-row");
      if (draggedLabel !== null && ontoLabel) {
        e.preventDefault();
        const from = draggedLabel, to = Number(ontoLabel.dataset.i);
        draggedLabel = null;
        if (from !== to) editLabels((labels) => { const [m] = labels.splice(from, 1); labels.splice(to > from ? to - 1 : to, 0, m!); });
        return;
      }
      const onto = (e.target as HTMLElement).closest<HTMLElement>(".ov-app-row");
      if (draggedFlag === null || !onto) return;
      e.preventDefault();
      const list = this.appearanceList(appearanceSub);
      const moved = list.find((x) => x.flag === draggedFlag)!;
      const rest = list.filter((x) => x.flag !== draggedFlag);
      rest.splice(rest.findIndex((x) => x.flag === Number(onto.dataset.flag)), 0, moved);
      this.appearance = { ...this.appearance, [appearanceSub]: rest };
      draggedFlag = null;
      this.applyAppearance();
      draw();
    });
    win.body.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const tab = t.closest<HTMLElement>("[data-panel]");
      if (tab) { current = tab.dataset.panel as typeof current; draw(); return; }
      // MiscPanel.ResetAllOverviewSettings: ResetAllOverviewSettings (YESNO), then every overview setting back to the profile's
      if (t.closest(".ov-misc-reset")) {
        void (this.hooks.ask?.("ResetAllOverviewSettings", "Are you sure you want to reset all overview settings?") ?? Promise.resolve(true))
          .then((yes) => { if (yes) { this.storeCurrentProfile(); this.resetAllSettings(); draw(); } });
        return;
      }
      // ShipsPanel.GetShipLabelMenu: the three formats (SetDefaultShipLabel)
      if (t.closest(".ov-ship-menu")) {
        const r = t.getBoundingClientRect();
        const apply = (k: "default" | "ally" | "corpally") => () => { saveShipLabelSettings({ labels: SHIP_LABEL_PRESETS[k].map((l) => ({ ...l })), hideCorpTicker: false }); draw(); };
        this.menu.open(r.left, r.bottom, [
          { label: word("UI/Overview/ShipLabelFormatPilotCC", "Pilot [CORP]"), run: apply("default") },
          { label: word("UI/Overview/ShipLabelFormatPilotCCAA", "Pilot [CORP,ALLIANCE]"), run: apply("ally") },
          { label: word("UI/Overview/ShipLabelFormatCCPilotAA", "[CORP] Pilot <ALLIANCE>"), run: apply("corpally") },
        ]);
        return;
      }
      if (t.closest(".ov-ship-addbr")) { editLabels((labels) => labels.push({ type: "linebreak", state: true, pre: "", post: "" })); return; }
      const rm = t.closest(".ov-ship-remove");
      if (rm) { const i = Number(rm.closest<HTMLElement>(".ov-ship-row")!.dataset.i); editLabels((labels) => labels.splice(i, 1)); return; }
      const appSub = t.closest<HTMLElement>("[data-appsub]");
      if (appSub) { appearanceSub = appSub.dataset.appsub as typeof appearanceSub; draw(); return; }
      // AppearancePanel.ResetStateSettings: the lists' orders and switches back to the client's defaults
      if (t.closest(".ov-app-reset")) { const { flag: _f, background: _b, colors: _c, blinks: _k, ...rest } = this.appearance; this.appearance = rest; this.applyAppearance(); draw(); return; }
      const subTab = t.closest<HTMLElement>("[data-sub]");
      if (subTab) { sub = subTab.dataset.sub as typeof sub; draw(); return; }
      const cat = t.closest<HTMLElement>(".ov-filt-cat");
      if (cat) { const c = cat.dataset.cat!; if (open.has(c)) open.delete(c); else open.add(c); draw(); return; }
      const all = (this.filterGroups ?? []).flatMap((c) => c.groups.flatMap((g) => g.groupIDs));
      // TabPresetPanel.OnSaveButton / OnSaveAsButton / OnDeleteButton
      if (t.closest(".ov-filt-save")) { this.savePreset(editing, editing.slice(CUSTOM_PREFIX.length)); draw(); return; }
      if (t.closest(".ov-filt-saveas")) { this.savePresetAs(editing, (id) => { editing = id; draw(); }); return; }
      if (t.closest(".ov-filt-delete")) { this.deletePreset(editing); editing = this.tabSettings[this.tab]?.preset ?? DEFAULT_PRESET; draw(); return; }
      if (t.closest(".ov-filt-all")) { this.setPresetGroups(editing, all, true); draw(); return; }
      if (t.closest(".ov-filt-none")) { this.setPresetGroups(editing, all, false); draw(); return; }
      if (t.closest(".ov-history-restore-btn")) { this.restoreProfile(); draw(); return; }
      if (t.closest(".ov-misc-export")) { this.exportFile(); return; }
      if (t.closest(".ov-misc-import")) {
        const pick = document.createElement("input");
        pick.type = "file";
        pick.accept = ".yaml,.yml,text/yaml";
        pick.addEventListener("change", () => { const f = pick.files?.[0]; if (f) void f.text().then((text) => this.importChosenFile(text, f.name)); });
        pick.click();
        return;
      }
      const nameEl = t.closest<HTMLElement>(".ov-profile-name");
      if (nameEl && !nameEl.querySelector("input")) {
        const input = document.createElement("input");
        input.className = "ov-profile-edit";
        input.value = this.profileName();
        nameEl.replaceChildren(input);
        input.focus();
        input.select();
        const done = (keep: boolean) => {
          if (keep) { try { const v = input.value.trim(); if (v) localStorage.setItem(PROFILE_NAME_KEY, v); else localStorage.removeItem(PROFILE_NAME_KEY); } catch { /* lasts the page */ } }
          draw();
        };
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(true); else if (e.key === "Escape") done(false); });
        input.addEventListener("blur", () => done(true), { once: true });
        return;
      }
      // TabPresetPanel.OnRevertButton: RevertOverviewPresetChanges (YESNO) first
      if (t.closest(".ov-filt-revert")) {
        void (this.hooks.ask?.("RevertOverviewPresetChanges", "Are you sure you want to revert the changes to this filter?") ?? Promise.resolve(true))
          .then((yes) => { if (yes) { this.revertPreset(editing); draw(); } });
        return;
      }
      // DropdownColorPicker: the ColorPanel (Select Color, the colours, the clear button) under the swatch; the tab's colour set
      const swatch = t.closest<HTMLElement>(".ov-set-color");
      if (swatch && !swatch.hasAttribute("data-empty")) {
        const i = Number(swatch.closest<HTMLElement>(".ov-set-row")!.dataset.slot);
        const tabsAll = this.allTabs();
        openColorPanel(swatch, word, TAB_COLORS, 8, tabsAll[i]?.color ?? null, true, (color) => {
          tabsAll[i] = { ...tabsAll[i]!, color: color ? [...color] : null };
          this.setAllTabs(tabsAll);
          draw();
        });
        return;
      }
      // FlagEntry's colour picker: the state colours (ColorPanel, no clear); stateSvc.SetStateColor(where, flag, color)
      const stateSwatch = t.closest<HTMLElement>(".ov-app-color");
      if (stateSwatch) {
        const flag = Number(stateSwatch.closest<HTMLElement>(".ov-app-row")!.dataset.flag);
        const where = appearanceSub;
        openColorPanel(stateSwatch, word, STATE_COLORS, 5, this.stateColor(where, flag), false, (color) => {
          this.appearance = { ...this.appearance, colors: { ...this.appearance.colors, [`${where}:${flag}`]: [...color!] } };
          this.applyAppearance();
          draw();
        });
        return;
      }
      const del = t.closest(".ov-set-delete");
      const tabsAll = this.allTabs();
      if (!del || tabsAll.length <= 1) return;
      const i = Number(del.closest<HTMLElement>(".ov-set-row")!.dataset.slot);
      // the first window keeps a tab
      if ((tabsAll[i]?.window ?? 0) === 0 && tabsAll.filter((x) => (x.window ?? 0) === 0).length <= 1) return;
      tabsAll.splice(i, 1);
      this.setAllTabs(tabsAll);
      draw();
    });
    void overviewFilterGroups().then((g) => { this.filterGroups = g; if (current === "filters") draw(); });
    void overviewStates().then((st) => { this.states = st; if (current !== "tabs") draw(); });
    draw();
    (this.window.root.parentElement ?? document.body).append(win.root);
  }

  private filterGroups: FilterCategory[] | null = null;

  /**
   * overviewPresetSvc's custom presets (allPresets beyond the defaults), kept in this browser: each by its name, as
   * "custom:<name>", listed before the defaults (GetCustomFiltersSorted) without a category.
   */
  private customPresets(): Record<string, { groups: number[]; filteredStates: number[]; alwaysShownStates: number[] }> {
    try { return JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) ?? "{}") as Record<string, { groups: number[]; filteredStates: number[]; alwaysShownStates: number[] }>; } catch { return {}; }
  }
  private addCustomPresets(): void {
    const custom = this.customPresets();
    this.presetChoices = this.presetChoices.filter((p) => !p.id.startsWith(CUSTOM_PREFIX));
    for (const id of [...this.masks.keys()]) if (id.startsWith(CUSTOM_PREFIX)) this.masks.delete(id);
    const choices: PresetChoice[] = [];
    for (const name of Object.keys(custom).sort((a, b) => a.localeCompare(b))) {
      const id = CUSTOM_PREFIX + name;
      const data = { name, groups: custom[name]!.groups, filteredStates: custom[name]!.filteredStates, alwaysShownStates: custom[name]!.alwaysShownStates };
      if (this.presetData) this.presetData[id] = data;
      const mask = presetMask(data, id)!;
      this.masks.set(id, mask);
      choices.push({ id, name, label: name, groups: mask.groups, category: -1, categoryName: null });
    }
    this.presetChoices = [...choices, ...this.presetChoices];
  }

  /** overviewPresetSvc.SavePreset(presetName, newPresetName): the preset as it is now kept under the name, then loaded on the tab. */
  private savePreset(fromID: string, name: string): string {
    const mask = this.masks.get(fromID);
    const custom = this.customPresets();
    custom[name] = { groups: [...(mask?.groups ?? [])], filteredStates: [...(mask?.filteredStates ?? [])], alwaysShownStates: [...(mask?.alwaysShownStates ?? [])] };
    try { localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(custom)); } catch { /* the preset lasts the page */ }
    const id = CUSTOM_PREFIX + name;
    try { localStorage.removeItem(groupOverrideKey(id)); } catch { /* nothing kept */ }
    this.addCustomPresets();
    // unsavedPresets.pop(presetName): the preset saved from loses its unsaved changes too
    if (fromID !== id) this.revertPreset(fromID);
    // LoadPreset(newPresetName): the tab shows it
    const t = this.tabSettings[this.tab];
    if (t) { this.tabSettings[this.tab] = { ...t, preset: id }; this.tabsChanged(this.tab); }
    return id;
  }

  /** overviewPresetSvc.DeletePreset: gone, and a tab that showed it shows the default preset. */
  private deletePreset(id: string): void {
    const custom = this.customPresets();
    delete custom[id.slice(CUSTOM_PREFIX.length)];
    try { localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(custom)); localStorage.removeItem(groupOverrideKey(id)); } catch { /* nothing kept */ }
    if (this.presetData) delete this.presetData[id];
    this.addCustomPresets();
    this.tabSettings = this.tabSettings.map((t) => ({ ...t, preset: t.preset === id ? DEFAULT_PRESET : t.preset, bracket: t.bracket === id ? null : t.bracket }));
    this.tabsChanged(this.tab);
  }

  /** PresetSvc.SavePresetAs's NamePopup (UI/Common/Buttons/SaveAs, UI/Overview/FilterName, up to 80, the preset's name to start). */
  private savePresetAs(fromID: string, done: (id: string) => void): void {
    const word = (label: string, own: string) => this.hooks.word?.(label) ?? own;
    const start = this.presetChoices.find((p) => p.id === fromID)?.label ?? "";
    const win = new PlayWindow({ id: "overview-save-as", caption: word("UI/Common/Buttons/SaveAs", "Save As"), left: Math.round(innerWidth / 2 - 160), top: Math.round(innerHeight / 2 - 80), width: 320, height: 160, minWidth: 320, minHeight: 160 });
    win.body.classList.add("ov-add");
    win.body.innerHTML = `<label class="ov-add-label"><span></span><input maxlength="80" autocomplete="off"></label>
      <div class="ov-add-buttons"><button type="button" class="ov-add-ok"></button><button type="button" class="ov-add-cancel"></button></div>`;
    win.body.querySelector(".ov-add-label span")!.textContent = word("UI/Overview/FilterName", "Filter Name");
    const input = win.body.querySelector("input")!;
    input.value = start;
    win.body.querySelector(".ov-add-ok")!.textContent = word("UI/Common/Buttons/OK", "OK");
    win.body.querySelector(".ov-add-cancel")!.textContent = word("UI/Common/Buttons/Cancel", "Cancel");
    const ok = async () => {
      const name = input.value.trim();
      if (!name) { this.hooks.notice?.(word("UI/Common/PleaseTypeSomething", "Please type something")); return; }
      // IsDefaultPresetName: a default preset's name or display name is refused (InvalidPresetName)
      const lower = name.toLowerCase();
      if (this.presetChoices.some((p) => !p.id.startsWith(CUSTOM_PREFIX) && (p.name.toLowerCase() === lower || p.label.toLowerCase() === lower || p.id.toLowerCase() === lower))) {
        this.hooks.say?.("InvalidPresetName", "That name is used by a default filter.");
        return;
      }
      // a name already kept asks AlreadyHaveLabel (YESNO) first
      if (this.customPresets()[name] && !(await (this.hooks.ask?.("AlreadyHaveLabel", "You already have a filter by that name. Replace it?") ?? Promise.resolve(true)))) return;
      win.root.remove();
      done(this.savePreset(fromID, name));
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") void ok(); if (e.key === "Escape") win.root.remove(); });
    win.body.querySelector(".ov-add-ok")!.addEventListener("click", () => void ok());
    win.body.querySelector(".ov-add-cancel")!.addEventListener("click", () => win.root.remove());
    (this.window.root.parentElement ?? document.body).append(win.root);
    input.select();
  }

  private profileTabs: TabSettings[] = [];

  /** overviewPresetSvc.GetOverviewName: the name the pilot gave it (overviewProfileName), else "<pilot>'s Overview". */
  private profileName(): string {
    let kept: string | null = null;
    try { kept = localStorage.getItem(PROFILE_NAME_KEY); } catch { /* none kept */ }
    return kept?.trim() || (this.hooks.word?.("UI/Overview/DefaultOverviewName", { charID: this.hooks.pilotID ?? 0 }) ?? "Overview");
  }
  /** StoreCurrentProfileDataInSettings: the overview's settings as they are, its name (GetOverviewName) and the time. */
  private storeCurrentProfile(): void {
    try {
      const data: Record<string, string> = {};
      for (const k of Object.keys(localStorage)) if (isOverviewSettingKey(k)) data[k] = localStorage.getItem(k)!;
      const name = this.profileName();
      localStorage.setItem(RESTORE_KEY, JSON.stringify({ data, name, timestamp: Date.now() }));
    } catch { /* nothing kept */ }
  }
  private restoreData(): { data: Record<string, string>; name: string; timestamp: number } | null {
    try { const v = JSON.parse(localStorage.getItem(RESTORE_KEY) ?? "null"); return v && typeof v.data === "object" ? v : null; } catch { return null; }
  }
  /** The overview as the client's export writes it (ExportOverviewWindow.Export: general settings, profile, own presets). */
  overviewProfile(selected?: ReadonlySet<string>): OverviewProfile {
    const all = this.overviewProfileAll();
    if (!selected) return all;
    // Export: generalSettings is the Appearance, columns and ship labels; overviewProfile the tabs; the presets one by one
    const general = selected.has("generalSettings"), profile = selected.has("overviewProfile");
    return {
      ...(general ? { flagOrder: all.flagOrder, flagStates: all.flagStates, backgroundOrder: all.backgroundOrder, backgroundStates: all.backgroundStates,
        stateColors: all.stateColors, stateBlinks: all.stateBlinks, columnOrder: all.columnOrder, overviewColumns: all.overviewColumns, shipLabels: all.shipLabels } : {}),
      ...(profile ? { tabs: all.tabs } : {}),
      presets: Object.fromEntries(Object.entries(all.presets ?? {}).filter(([name]) => selected.has(name))),
    };
  }
  /** The display name of a preset ID (a custom one's own name, a default's PresetChoice label). */
  private presetLabel(id: string): string {
    return id.startsWith(CUSTOM_PREFIX) ? id.slice(CUSTOM_PREFIX.length) : this.presetChoices.find((p) => p.id === id)?.label ?? id;
  }
  /**
   * ExportOverviewWindow / ImportOverviewWindow: the overview's name and Share handle (export), Check All, the list
   * (General Overview Settings, Overview Profile, each tab's preset as "Tab Preset: X", then Other Tab Presets), and
   * the foot (the file's name and Export, or Import), the action given the parts ticked.
   */
  private openTransferWindow(kind: "export" | "import", parts: { key: string; label: string; hint?: string; group?: boolean }[], fileName: string,
    act: (selected: Set<string>, fileName: string) => void): void {
    const word = (label: string, own: string, args?: Record<string, string | number>) => this.hooks.word?.(label, args) ?? own;
    document.querySelector(`.pw[data-xfer="${kind}"]`)?.remove();
    const win = new PlayWindow({ id: `overview-${kind}`, caption: kind === "export" ? word("UI/Commands/ExportOverviewSettings", "Export Overview Settings") : word("UI/Overview/ImportOverviewSettings", "Import Overview Settings"),
      left: Math.round(innerWidth / 2 - 200), top: Math.round(innerHeight / 2 - 220), width: 400, height: 440 });
    win.root.dataset.xfer = kind;
    (this.window.root.parentElement ?? document.body).append(win.root);
    const selected = new Set(parts.filter((p) => !p.group).map((p) => p.key));
    const draw = () => {
      const allOn = parts.filter((p) => !p.group).every((p) => selected.has(p.key));
      const top = kind === "export" ? `<div class="ov-set-top"><span class="ov-profile-name">${esc(this.profileName())}</span><span class="ov-share" draggable="true" title="${esc(word("UI/Overview/SharableOverviewIconExportHint", "Drag into chat to share these settings"))}"><img src="${clientTexture("res:/UI/Texture/classes/Overview/shareableOverview_small.png")}" alt="">${esc(word("UI/Overview/ShareOverview", "Share"))}</span></div>` : `<div class="ov-xfer-file">${esc(fileName)}</div>`;
      win.body.innerHTML = `<div class="ov-xfer">${top}
        <label class="ov-app-check"><input type="checkbox" data-xfer-all${allOn ? " checked" : ""}><span>${esc(word("UI/Shared/CheckAllOn", "Check All"))}</span></label>
        <div class="ov-xfer-list">${parts.map((p) => p.group ? `<div class="ov-xfer-group">${esc(p.label)}</div>`
          : `<label class="ov-app-check${p.key.startsWith("preset:") ? " sub" : ""}" title="${esc(p.hint ?? "")}"><input type="checkbox" data-xfer="${esc(p.key)}"${selected.has(p.key) ? " checked" : ""}><span>${esc(p.label)}</span></label>`).join("")}</div>
        <div class="ov-xfer-foot">${kind === "export" ? `<span>${esc(word("UI/Common/Files/FileName", "File Name"))}</span><input class="ov-xfer-name" value="${esc(fileName)}">` : ""}
          <button type="button" class="ov-xfer-go"${selected.size ? "" : " disabled"}>${esc(kind === "export" ? word("UI/Commands/Export", "Export") : word("UI/Commands/Import", "Import"))}</button></div></div>`;
    };
    win.body.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement;
      const name = (win.body.querySelector(".ov-xfer-name") as HTMLInputElement | null)?.value ?? fileName;
      if (t.matches("[data-xfer-all]")) { for (const p of parts) if (!p.group) { if (t.checked) selected.add(p.key); else selected.delete(p.key); } }
      else if (t.dataset.xfer) { if (t.checked) selected.add(t.dataset.xfer); else selected.delete(t.dataset.xfer); }
      fileName = name;
      draw();
    });
    win.body.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest(".ov-xfer-go")) return;
      const name = (win.body.querySelector(".ov-xfer-name") as HTMLInputElement | null)?.value.trim() ?? fileName;
      if (kind === "export" && !name) { this.hooks.notice?.(word("UI/Common/NameInvalid", "Name is invalid.")); return; }
      act(new Set([...selected].map((k) => k.replace(/^preset:/, ""))), name);
      win.root.remove();
    });
    draw();
  }
  /** The parts a profile holds, as the windows list them. */
  private transferParts(p: OverviewProfile, inUse: readonly string[]): { key: string; label: string; hint?: string; group?: boolean }[] {
    const word = (label: string, own: string, args?: Record<string, string | number>) => this.hooks.word?.(label, args) ?? own;
    const out: { key: string; label: string; hint?: string; group?: boolean }[] = [
      { key: "generalSettings", label: word("UI/Overview/GeneralOverviewSettings", "General Overview Settings") },
      { key: "overviewProfile", label: word("UI/Overview/OverviewProfile", "Overview Profile"), hint: word("UI/Overview/OverviewProfileHint", "") },
    ];
    const own = Object.keys(p.presets ?? {}).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const tabPreset = (key: string) => { const name = this.presetChoices.some((c) => c.id === key) ? this.presetLabel(key) : key; return word("UI/Overview/TabPresetName", `Tab Preset: ${name}`, { presetName: name }); };
    for (const name of own.filter((n) => inUse.includes(n))) out.push({ key: `preset:${name}`, label: tabPreset(name) });
    const rest = own.filter((n) => !inUse.includes(n));
    if (rest.length) {
      out.push({ key: "group:rest", label: word("UI/Overview/OtherTabPresets", "Other Tab Presets"), group: true });
      for (const name of rest) out.push({ key: `preset:${name}`, label: tabPreset(name) });
    }
    return out;
  }
  private overviewProfileAll(): OverviewProfile {
    const ids = (where: "flag" | "background") => this.appearanceList(where);
    const colorName = (c: readonly number[]) => STATE_COLORS.findIndex((x) => x.every((v, i) => Math.abs(v - (c[i] ?? 1)) < 0.01));
    const stateColors: Record<string, string> = {};
    for (const [k, c] of Object.entries(this.appearance.colors ?? {})) { const i = colorName(c); if (i >= 0) stateColors[k.replace(":", "_")] = STATE_COLOR_NAMES[i]!; }
    const stateBlinks: Record<string, boolean> = {};
    for (const [k, b] of Object.entries(this.appearance.blinks ?? {})) stateBlinks[k.replace(":", "_")] = b;
    const nameOf = (id: string | null) => (id && id.startsWith(CUSTOM_PREFIX) ? id.slice(CUSTOM_PREFIX.length) : id);
    const labels = shipLabelSettings().labels;
    return {
      flagOrder: ids("flag").map((e) => e.flag), flagStates: ids("flag").filter((e) => e.on).map((e) => e.flag),
      backgroundOrder: ids("background").map((e) => e.flag), backgroundStates: ids("background").filter((e) => e.on).map((e) => e.flag),
      stateColors, stateBlinks,
      columnOrder: this.columnOrder(0).map((c) => c.id), overviewColumns: this.visibleColumns(0).map((c) => c.id).sort(),
      shipLabels: labels.map((l) => ({ ...l, type: l.type })),
      tabs: this.tabSettings.map((t) => ({ name: t.name, overview: nameOf(t.preset)!, bracket: nameOf(t.bracket), color: t.color ?? null })),
      presets: this.customPresets(),
    };
  }
  /** ExportOverviewWindow: the file saved (the browser's download, as <overview name>.yaml). */
  private exportFile(): void {
    const all = this.overviewProfileAll();
    const inUse = (all.tabs ?? []).flatMap((t) => [t.overview, t.bracket ?? ""]);
    this.openTransferWindow("export", this.transferParts(all, inUse), this.profileName(), (selected, name) => {
      const blob = new Blob([writeProfile(this.overviewProfile(selected))], { type: "text/yaml" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${name.replace(/[\\/:*?"<>|]+/g, "_")}.yaml`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      // OverviewExportDone
      this.hooks.notice?.(this.hooks.word?.("UI/Overview/OverviewExportDone", { filename: a.download }) ?? `Overview settings exported to ${a.download}`);
    });
  }
  /** ImportOverviewWindow.OnFileSelected: the file's parts listed to tick, then Import. */
  private importChosenFile(text: string, fileName: string): void {
    const p = readProfile(text);
    if (!p) { this.hooks.notice?.(this.hooks.word?.("UI/Common/Files/FileNotValid") ?? "This file is not valid."); return; }
    const inUse = (p.tabs ?? []).flatMap((t) => [t.overview, t.bracket ?? ""]);
    this.openTransferWindow("import", this.transferParts(p, inUse), fileName, (selected) => { this.importFile(text, selected); });
  }
  /**
   * ImportOverviewWindow.Import: a file the client (or the page) wrote loaded - the pilot's own filters added (a
   * name the overview has is a custom filter of that name), the tabs, the Appearance lists, colours and blinks and the
   * ship labels taken where the file has them; false where it is no overview file.
   */
  importFile(text: string, selected?: ReadonlySet<string>): boolean {
    const read = readProfile(text);
    if (!read) { this.hooks.notice?.(this.hooks.word?.("UI/Common/Files/FileNotValid") ?? "This file is not valid."); return false; }
    // only the parts ticked (ImportOverviewWindow's presetsSelected), all where none are given
    const p: OverviewProfile = !selected ? read : {
      ...(selected.has("generalSettings") ? { ...read, tabs: undefined, presets: undefined } : {}),
      ...(selected.has("overviewProfile") ? { tabs: read.tabs } : {}),
      presets: Object.fromEntries(Object.entries(read.presets ?? {}).filter(([name]) => selected.has(name))),
    };
    try {
      if (p.presets && Object.keys(p.presets).length) localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify({ ...this.customPresets(), ...p.presets }));
      const custom = { ...this.customPresets() };
      const idOf = (name: string | null) => (name === null ? null : custom[name] ? CUSTOM_PREFIX + name : name);
      if (p.tabs && p.tabs.length) localStorage.setItem(this.tabsKey, JSON.stringify(p.tabs.map((t) => ({ name: t.name, preset: idOf(t.overview)!, bracket: idOf(t.bracket), ...(t.color ? { color: t.color } : {}) }))));
      const appearance: AppearanceSettings = { ...this.appearance };
      if (p.flagOrder) appearance.flag = p.flagOrder.map((flag) => ({ flag, on: (p.flagStates ?? []).includes(flag) }));
      if (p.backgroundOrder) appearance.background = p.backgroundOrder.map((flag) => ({ flag, on: (p.backgroundStates ?? []).includes(flag) }));
      if (p.stateColors) {
        appearance.colors = Object.fromEntries(Object.entries(p.stateColors).flatMap(([k, n]) => {
          const i = STATE_COLOR_NAMES.indexOf(n as (typeof STATE_COLOR_NAMES)[number]);
          return i < 0 ? [] : [[k.replace("_", ":"), [...STATE_COLORS[i]!]]];
        }));
      }
      if (p.stateBlinks) appearance.blinks = Object.fromEntries(Object.entries(p.stateBlinks).map(([k, b]) => [k.replace("_", ":"), b]));
      localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
      if (p.shipLabels && p.shipLabels.length) {
        saveShipLabelSettings({ labels: p.shipLabels.map((l) => ({ ...l, type: (l.type === "null" ? null : l.type) as ShipLabelPart["type"], color: l.color ?? undefined, fontsize: l.fontsize ?? undefined })) as ShipLabelPart[], hideCorpTicker: shipLabelSettings().hideCorpTicker });
      }
    } catch { return false; }
    this.reloadSettings();
    return true;
  }

  /** RestoreAutoSavedOverviewProfile: the stored settings loaded (LoadOverviewProfileFromDict), the stored copy dropped. */
  private restoreProfile(): void {
    const r = this.restoreData();
    if (!r) return;
    try {
      for (const k of Object.keys(localStorage)) if (isOverviewSettingKey(k)) localStorage.removeItem(k);
      for (const [k, v] of Object.entries(r.data)) localStorage.setItem(k, v);
      localStorage.removeItem(RESTORE_KEY);
    } catch { /* nothing kept */ }
    this.reloadSettings();
  }
  /** The overview's settings read again from what is kept (LoadOverviewProfileFromDict's reload). */
  private reloadSettings(): void {
    for (const [id, data] of Object.entries(this.presetData ?? {})) {
      const mask = this.masks.get(id);
      const fresh = presetMask(data, id);
      if (!mask || !fresh) continue;
      const groups = mask.groups as Set<number>;
      groups.clear();
      for (const g of fresh.groups) groups.add(g);
      Object.assign(mask, { filteredStates: fresh.filteredStates, alwaysShownStates: fresh.alwaysShownStates });
    }
    this.addCustomPresets();
    this.appearance = readAppearance();
    this.applyAppearance(false);
    applyOverviewMisc();
    this.tabSorts.clear();
    this.sort = readSort(this.sortKey, readSort(SORT_KEY));
    try { this.sortEnabled = localStorage.getItem(this.sortEnabledKey) !== "false"; } catch { /* enabled by default */ }
    this.tabSettings = this.storedTabs() ?? this.profileTabs.map((t) => ({ ...t }));
    this.tabs = this.tabSettings.map((t) => this.tabOf(t));
    let saved = 0;
    try { saved = Number(localStorage.getItem(this.tabKey) ?? localStorage.getItem(TAB_KEY)); } catch { /* the first tab */ }
    this.tab = -1;
    this.choose(Number.isInteger(saved) && this.tabs[saved] ? saved : 0, true);
  }

  /** overviewPresetSvc.ResetOverviewSettingsToDefault: tabs, filters' changes, columns, sorts, appearance, ship labels, misc. */
  private resetAllSettings(): void {
    try {
      for (const k of Object.keys(localStorage)) {
        if (isOverviewSettingKey(k)) localStorage.removeItem(k);
      }
    } catch { /* nothing kept */ }
    for (const id of this.masks.keys()) this.revertPreset(id);
    this.appearance = readAppearance();
    this.applyAppearance(false);
    saveShipLabelSettings(null);
    applyOverviewMisc();
    this.tabSorts.clear();
    this.sort = DEFAULT_SORT;
    this.sortEnabled = true;
    this.tabSettings = this.profileTabs.map((t) => ({ ...t }));
    this.tabs = this.tabSettings.map((t) => this.tabOf(t));
    this.tab = -1;
    this.choose(0, true);
    try { localStorage.removeItem(this.tabsKey); } catch { /* nothing kept */ }
  }
  private appearance: AppearanceSettings = readAppearance();
  private stateOrders: StateOrders | null = null;

  /** stateSvc.GetStateColor(flag, where): the one set, else the default. */
  private stateColor(where: "flag" | "background", flag: number): readonly number[] | null {
    return this.appearance.colors?.[`${where}:${flag}`] ?? this.stateOrders?.[where].find((x) => x.flag === flag)?.color ?? null;
  }
  /** The two lists as the pilot has them: their own order and switches, the client's defaults otherwise. */
  private appearanceList(where: "flag" | "background"): { flag: number; on: boolean }[] {
    return this.appearance[where] ?? (this.stateOrders?.[where] ?? []).map((e) => ({ flag: e.flag, on: e.on }));
  }

  /** The settings applied: the flag rules' orders and apply-to switches, the small font and colortags, kept. */
  private applyAppearance(save = true): void {
    if (save) { try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(this.appearance)); } catch { /* the settings last the page */ } }
    if (this.stateOrders) {
      setStateAppearance({ flag: this.appearanceList("flag").filter((e) => e.on).map((e) => e.flag), background: this.appearanceList("background").filter((e) => e.on).map((e) => e.flag),
        applyStructures: this.appearance.applyStructures, applyOther: this.appearance.applyOther, otherGroups: this.stateOrders.filterGroups,
        colors: this.appearance.colors, blinks: this.appearance.blinks });
    }
    document.body.classList.toggle("ov-small-tags", this.appearance.smallTags);
    this.window.body.classList.toggle("ov-small-font", this.appearance.smallFont);
    this.drawnRows = "";
    this.lastDraw = 0;
  }
  private states: StateProps[] | null = null;

  /** StatesPanel.OnFilteredStatesChange: the state always shown, filtered out, or neither, on the preset (whole lists kept). */
  private setPresetState(presetID: string, flag: number, choice: "alwaysShow" | "filterOut" | "unfiltered"): void {
    const mask = this.masks.get(presetID) as { filteredStates: number[]; alwaysShownStates: number[] } | null | undefined;
    if (!mask) return;
    const filtered = mask.filteredStates.filter((f) => f !== flag), always = mask.alwaysShownStates.filter((f) => f !== flag);
    if (choice === "filterOut") filtered.push(flag);
    if (choice === "alwaysShow") always.push(flag);
    mask.filteredStates = filtered;
    mask.alwaysShownStates = always;
    const o = groupOverrides(presetID);
    try { localStorage.setItem(groupOverrideKey(presetID), JSON.stringify({ ...o, filtered, alwaysShown: always })); } catch { /* the change lasts the page */ }
    this.lastDraw = 0;
  }
  private presetData: OverviewPresets["presets"] | null = null;

  /** overviewPresetSvc.ChangeSettings(PRESET_SETTINGS_GROUPS, groups, isSelect) on a preset, kept as this browser's changes to it. */
  private setPresetGroups(presetID: string, groupIDs: readonly number[], shown: boolean): void {
    const mask = this.masks.get(presetID);
    if (!mask) return;
    const groups = mask.groups as Set<number>;
    const o = groupOverrides(presetID);
    const add = new Set(o.add), remove = new Set(o.remove);
    for (const g of groupIDs) {
      if (shown) { groups.add(g); add.add(g); remove.delete(g); } else { groups.delete(g); remove.add(g); add.delete(g); }
    }
    try { localStorage.setItem(groupOverrideKey(presetID), JSON.stringify({ ...o, add: [...add], remove: [...remove] })); } catch { /* the change lasts the page */ }
    this.lastDraw = 0;
  }

  /** TabPresetPanel.OnRevertButton: the preset as the profile has it, this browser's changes dropped. */
  private revertPreset(presetID: string): void {
    const mask = this.masks.get(presetID);
    const data = this.presetData?.[presetID];
    if (!mask || !data) return;
    try { localStorage.removeItem(groupOverrideKey(presetID)); } catch { /* nothing kept */ }
    const groups = mask.groups as Set<number>;
    groups.clear();
    for (const g of data.groups) groups.add(g);
    const m = mask as { filteredStates: readonly number[]; alwaysShownStates: readonly number[] };
    m.filteredStates = data.filteredStates ?? [];
    m.alwaysShownStates = data.alwaysShownStates ?? [];
    this.lastDraw = 0;
  }

  /** GetColumnVisibilitySubMenu(tabID): each column's checkbox for that tab, then Change Order. */
  private columnsSubMenu(tab: number): (ContextEntry | null)[] {
    const word = (label: string, own: string) => this.hooks.word?.(label) ?? own;
    const shown = new Set(this.visibleColumns(tab).map((c) => c.id));
    return [...COLUMNS.map((c): ContextEntry => ({ label: word(c.label, c.own), checkbox: true, checked: shown.has(c.id),
      hint: c.hint ? word(c.hint, "") || null : null, run: () => this.setColumnShown(c.id, !shown.has(c.id), tab) })),
      null, { label: word("UI/Overview/ChangeOrder", "Change Order..."), run: () => this.openColumnOrder(tab) }];
  }

  /** ColumnSetting's change (_OnColumnCheckbox): the column shown or not on a tab, kept with the tab. */
  private setColumnShown(id: ColumnID, shown: boolean, tab = this.tab): void {
    const t = this.tabSettings[tab];
    if (!t) return;
    const now = new Set<ColumnID>(t.columns ?? DEFAULT_VISIBLE);
    if (shown) now.add(id); else now.delete(id);
    t.columns = COLUMNS.filter((c) => now.has(c.id)).map((c) => c.id);
    try { this.saveTabs(); } catch { /* the change lasts the page */ }
    if (tab === this.tab) this.drawHead();
  }

  /** The sorted column's head marked, with the way it runs. */
  private markSort(): void {
    this.lockIcon.hidden = this.sortEnabled;
    const disabled = this.hooks.word?.(SORT_DISABLED) ?? DISABLED_TEXT;
    this.lockIcon.title = disabled;
    for (const th of this.table.querySelectorAll<HTMLElement>("th[data-sort]")) {
      const sorted = th.dataset.sort === this.sort.column;
      const button = th.querySelector("button")!;
      th.classList.toggle("sorted", sorted);
      th.classList.toggle("down", sorted && this.sort.down);
      if (sorted) th.setAttribute("aria-sort", this.sort.down ? "descending" : "ascending");
      else th.removeAttribute("aria-sort");
      if (this.sortEnabled) {
        button.removeAttribute("aria-disabled");
        button.removeAttribute("aria-description");
      } else {
        button.setAttribute("aria-disabled", "true");
        button.setAttribute("aria-description", disabled);
      }
    }
  }

  /** A tab chosen: its name lit, the rows its preset shows, kept for the next visit. */
  private choose(i: number, initial = false): void {
    if ((!initial && this.tab === i) || !this.tabs[i]) return;
    this.tab = i;
    this.drawTabs();
    this.drawHead();
    // OverviewWindow.UpdateWindowCaption: UI/Tactical/OverviewCaption with the preset's display name ("General: General")
    const presetID = (this.tabs[i] as OverviewTab & { presetID?: string }).presetID;
    const preset = this.presetChoices.find((p) => p.id === presetID)?.label ?? this.tabs[i]!.overview?.name ?? "";
    this.window.caption = this.hooks.word?.("UI/Tactical/OverviewCaption", { preset }) ?? `Overview (${preset})`;
    this.sort = this.tabSorts.get(i) ?? readSort(this.tabSortKey(), initial ? this.sort : DEFAULT_SORT);
    this.keepSort();
    this.markSort();
    try { localStorage.setItem(this.tabKey, String(i)); } catch { /* not kept */ }
    this.lastDraw = 0;
  }

  /** OverviewTabGroup: the tabs, the chosen one lit, and the TrailingContainer's add_16px while there is room (MAX_TAB_NUM). */
  private drawTabs(): void {
    const add = this.tabs.length < MAX_TAB_NUM
      ? `<img class="ov-add-tab" src="${clientTexture("res:/UI/Texture/eveicon/system_icons/add_16px.png")}" alt="" title="${esc(this.hooks.word?.("UI/Overview/AddTab") ?? "Add Tab")}">` : "";
    // _ConstructTabs: a tab with a colour shows its name in it
    this.tabsEl.innerHTML = this.tabs.map((t, n) => { const c = this.tabSettings[n]?.color; return `<span class="ov-tab${n === this.tab ? " active" : ""}" data-tab="${n}"${c ? ` style="color:${rgbCss(c)}"` : ""}>${esc(t.name)}</span>`; }).join("") + add;
  }

  private get tabsKey(): string { return TABS_KEY + (this.hooks.pilotID === undefined ? "" : `:${this.hooks.pilotID}`); }

  /** Every tab kept, of every overview window. */
  private allStoredTabs(): TabSettings[] {
    try {
      const v = JSON.parse(localStorage.getItem(this.tabsKey) ?? "null") as TabSettings[] | null;
      return Array.isArray(v) ? v.filter((t) => typeof t?.name === "string" && typeof t.preset === "string") : [];
    } catch { return []; }
  }
  /** The overview windows other than the first that have tabs kept (OverviewWindow instances to open again). */
  storedWindowIDs(): number[] {
    return [...new Set(this.allStoredTabs().map((t) => t.window ?? 0).filter((w) => w > 0))].sort((a, b) => a - b);
  }
  /** Every window's tabs (GetSettingsByTabID), this window's as they are now. */
  private allTabs(): TabSettings[] {
    const stored = this.allStoredTabs();
    const mine = this.tabSettings.map((t) => (this.instanceID ? { ...t, window: this.instanceID } : (({ window: _w, ...rest }) => rest)(t)));
    const others = stored.filter((t) => (t.window ?? 0) !== this.instanceID);
    return this.instanceID ? [...others, ...mine] : [...mine, ...others];
  }
  /** The Tabs panel's change to every window's tabs: kept, this window's read again, the others told. */
  private setAllTabs(all: TabSettings[]): void {
    try { localStorage.setItem(this.tabsKey, JSON.stringify(all)); } catch { /* lasts the page */ }
    this.reloadTabs();
    this.hooks.tabsEdited?.(this);
  }
  /** This window's tabs read again from what is kept (another window's settings changed them). */
  reloadTabs(): void {
    const prev = this.tab;
    this.tabSettings = this.storedTabs() ?? this.profileTabs.map((t) => ({ ...t }));
    this.tabs = this.tabSettings.map((t) => this.tabOf(t));
    this.tab = -1;
    if (this.tabs.length) this.choose(Math.max(0, Math.min(prev, this.tabs.length - 1)), true);
  }
  /** This window's tabs kept, the other windows' left as they are (presetSvc.UpdateSettingsByTabID). */
  private saveTabs(): void {
    const others = this.allStoredTabs().filter((t) => (t.window ?? 0) !== this.instanceID);
    const mine = this.tabSettings.map((t) => { const { window: _w, ...rest } = t; return this.instanceID ? { ...rest, window: this.instanceID } : rest; });
    localStorage.setItem(this.tabsKey, JSON.stringify(this.instanceID ? [...others, ...mine] : [...mine, ...others]));
  }

  private storedTabs(): TabSettings[] | null {
    try {
      const tabs = this.allStoredTabs().filter((t) => (t.window ?? 0) === this.instanceID);
      if (!tabs.length && this.instanceID) return [];
      return tabs.length ? tabs.map((t) => ({ name: t.name, preset: t.preset, bracket: typeof t.bracket === "string" ? t.bracket : null,
        ...(Array.isArray(t.columns) ? { columns: t.columns.filter((c) => COLUMNS.some((d) => d.id === c)) } : {}),
        ...(Array.isArray(t.order) ? { order: t.order.filter((c) => COLUMNS.some((d) => d.id === c)) } : {}),
        ...(Array.isArray(t.color) ? { color: t.color } : {}) })) : null;
    } catch {
      return null;
    }
  }

  private tabOf(t: TabSettings): OverviewTab {
    return { name: t.name, presetID: t.preset, overview: this.masks.get(t.preset) ?? null, bracket: t.bracket ? this.masks.get(t.bracket) ?? null : null } as OverviewTab;
  }

  /** The tab list changed (presetSvc.UpdateSettingsByTabID): kept, the tabs drawn again, the chosen one shown. */
  private tabsChanged(chosen: number): void {
    try { this.saveTabs(); } catch { /* the change lasts the page */ }
    this.tabs = this.tabSettings.map((t) => this.tabOf(t));
    this.tab = -1;
    this.choose(Math.max(0, Math.min(chosen, this.tabs.length - 1)), true);
  }

  /**
   * OverviewTab.GetMenu: Filter ▸ and Bracket Filter ▸ (the default filters under their caption, each category a
   * submenu with its icon, the tab's own checked; Edit Current Filter), Change Name, Delete Tab while there is another.
   */
  private tabMenu(i: number): (ContextEntry | null)[] {
    const word = (label: string, own: string) => this.hooks.word?.(label) ?? own;
    const t = this.tabSettings[i]!;
    const filters = (active: string | null, apply: (id: string) => void): (ContextEntry | null)[] => {
      const byCategory = new Map<number, PresetChoice[]>();
      for (const p of this.presetChoices) byCategory.set(p.category ?? 0, [...(byCategory.get(p.category ?? 0) ?? []), p]);
      const entry = (p: PresetChoice): ContextEntry => ({ label: p.name, icon: p.id === active ? CHECKMARK : null, run: () => apply(p.id) });
      // _AddCustomFilterEntries: the pilot's own first, under their caption
      const custom = byCategory.get(-1) ?? [];
      const out: (ContextEntry | null)[] = custom.length ? [{ label: word("UI/Overview/CustomFilters", "Custom Filters"), caption: true }, ...custom.map(entry)] : [];
      out.push({ label: word("UI/Overview/DefaultFilters", "Default Filters"), caption: true });
      for (const p of byCategory.get(0) ?? []) out.push(entry(p));
      for (const [category, presets] of byCategory) {
        if (category === 0 || category === -1) continue;
        out.push({ label: presets[0]?.categoryName ?? String(category), icon: CATEGORY_ICONS[category] ?? null, sub: presets.map(entry) });
      }
      out.push(null, { label: word("UI/Overview/EditCurrentFilter", "Edit Current Filter"), icon: SETTINGS_ICON, run: () => this.openSettings("filters", active ?? undefined) });
      return out;
    };
    const set = (change: Partial<TabSettings>) => { this.tabSettings[i] = { ...t, ...change }; this.tabsChanged(this.tab); };
    const bracketFilters = filters(t.bracket, (id) => set({ bracket: id }));
    bracketFilters.unshift({ label: word("UI/Overview/ShowAllBrackets", "Show All Brackets"), icon: t.bracket === null ? CHECKMARK : null, run: () => set({ bracket: null }) });
    const out: (ContextEntry | null)[] = [
      { label: word("UI/Overview/Filter", "Filter"), sub: filters(t.preset, (id) => set({ preset: id })) },
      { label: word("UI/Overview/BracketFilter", "Bracket Filter"), sub: bracketFilters },
      null,
      { label: word("UI/Commands/ChangeName", "Change Name"), run: () => this.renameTab(i) },
      { label: word("UI/Generic/Columns", "Columns"), sub: this.columnsSubMenu(i) },
    ];
    if (this.tabSettings.length > 1) {
      out.push({ label: word("UI/Overview/DeleteTab", "Delete Tab"), run: () => {
        this.tabSettings.splice(i, 1);
        this.tabsChanged(this.tab > i ? this.tab - 1 : this.tab === i ? Math.max(0, i - 1) : this.tab);
      } });
    }
    // GetMoveTabSubMenu: New Window, then the other overview windows by their tabs' names (GetWindowName); the first
    // window keeps a tab
    if (this.hooks.moveTab && (this.instanceID !== 0 || this.tabSettings.length > 1)) {
      const others = this.hooks.otherWindows?.(this) ?? [];
      out.push({ label: word("UI/Overview/MoveTabTo", "Move Tab To"), sub: [
        { label: word("UI/Overview/NewWindow", "New Window"), run: () => this.hooks.moveTab?.(this, i, null) },
        ...(others.length ? [null] : []),
        ...others.map((w) => ({ label: w.windowName(), run: () => this.hooks.moveTab?.(this, i, w.instanceID) })),
      ] });
    }
    return out;
  }

  /** OverviewTab.ChangeTabName: NamePopup (UI/Commands/ChangeName, TypeInNewName, maxLength 30). */
  private renameTab(i: number): void {
    const word = (label: string, own: string) => this.hooks.word?.(label) ?? own;
    const win = new PlayWindow({ id: "overview-rename-tab", caption: word("UI/Commands/ChangeName", "Change Name"), left: Math.round(innerWidth / 2 - 160), top: Math.round(innerHeight / 2 - 80), width: 320, height: 160, minWidth: 320, minHeight: 160 });
    win.body.classList.add("ov-add");
    win.body.innerHTML = `<label class="ov-add-label"><span></span><input maxlength="30" autocomplete="off"></label>
      <div class="ov-add-buttons"><button type="button" class="ov-add-ok"></button><button type="button" class="ov-add-cancel"></button></div>`;
    win.body.querySelector("span")!.textContent = word("/Carbon/UI/Controls/ScrollEntries/TypeInNewName", "Type in new name");
    const input = win.body.querySelector("input")!;
    input.value = this.tabSettings[i]!.name;
    win.body.querySelector(".ov-add-ok")!.textContent = word("UI/Common/Buttons/OK", "OK");
    win.body.querySelector(".ov-add-cancel")!.textContent = word("UI/Common/Buttons/Cancel", "Cancel");
    const ok = () => {
      const name = input.value.trim();
      if (!name) { this.hooks.notice?.(word("UI/Common/PleaseTypeSomething", "Please type something")); return; }
      win.root.remove();
      this.tabSettings[i] = { ...this.tabSettings[i]!, name };
      this.tabsChanged(this.tab);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); if (e.key === "Escape") win.root.remove(); });
    win.body.querySelector(".ov-add-ok")!.addEventListener("click", ok);
    win.body.querySelector(".ov-add-cancel")!.addEventListener("click", () => win.root.remove());
    (this.window.root.parentElement ?? document.body).append(win.root);
    input.select();
  }

  /** OverviewWindow.GetMenuMoreOptions as a pilot sees it: Add Tab, Open Overview Settings, Bracket Visibility ▸. */
  private moreOptions(): (ContextEntry | null)[] {
    const word = (label: string, own: string) => this.hooks.word?.(label) ?? own;
    const current = this.hooks.bracketOverride?.() ?? "default";
    const radio = (label: string, own: string, value: BracketOverride): ContextEntry =>
      ({ label: word(label, own), checked: current === value, run: () => this.hooks.setBracketOverride?.(value) });
    return [
      { label: word("UI/Overview/AddTab", "Add Tab"), icon: "res:/UI/Texture/eveicon/system_icons/add_16px.png", run: () => this.openAddTab() },
      { label: word("UI/Commands/OpenOverviewSettings", "Open Overview Settings"), icon: "res:/UI/Texture/eveicon/system_icons/settings_16px.png", run: () => this.openSettings() },
      { label: word("UI/Overview/BracketVisibility", "Bracket Visibility"), sub: [
        radio("UI/Overview/UseSelectedTabBracketPreset", "Use Selected Tab's Bracket Preset", "default"),
        radio("UI/Overview/ShowAll", "Show All", "all"),
        radio("UI/Overview/HideAll", "Hide All", "none"),
      ] },
    ];
  }

  /**
   * AddTabPopup: the name (TypeInLabel, MAX_TAB_NAME_LENGTH, CheckName's PleaseTypeSomething), the overview Filter
   * (GetDefaultFiltersSorted's first by default) and the Bracket Filter (Show All Brackets by default), OK and Cancel;
   * presetSvc.AddTab appends it (TooManyTabs past MAX_TAB_NUM) and it is chosen.
   */
  openAddTab(): void {
    void playUiEvent("ui_button_soft4_play");
    if (this.addTabWindow) { this.addTabWindow.root.remove(); this.addTabWindow = null; }
    const word = (label: string, own: string) => this.hooks.word?.(label) ?? own;
    const win = new PlayWindow({ id: "overview-add-tab", caption: word("UI/Overview/AddTab", "Add Tab"), left: Math.round(innerWidth / 2 - 180), top: Math.round(innerHeight / 2 - 175), width: 360, height: 350, minWidth: 360, minHeight: 350 },
      () => { this.addTabWindow = null; });
    this.addTabWindow = win;
    const options = this.presetChoices.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join("");
    win.body.classList.add("ov-add");
    win.body.innerHTML = `<p class="ov-add-body"></p>
      <label class="ov-add-label"><span></span><input maxlength="${MAX_TAB_NAME_LENGTH}" autocomplete="off"><small class="ov-add-count"></small></label>
      <div class="ov-add-title"></div><select class="ov-add-filter">${options}</select>
      <div class="ov-add-title"></div><select class="ov-add-bracket"><option value=""></option>${options}</select>
      <div class="ov-add-buttons"><button type="button" class="ov-add-ok"></button><button type="button" class="ov-add-cancel"></button></div>`;
    const q = <T extends Element>(s: string) => win.body.querySelector<T>(s)!;
    q<HTMLElement>(".ov-add-body").textContent = word("UI/Overview/AddTabInstructions", "Type in the name of the new tab and choose its filters.");
    q<HTMLElement>(".ov-add-label span").textContent = word("UI/Overview/TypeInLabel", "Type in label");
    const titles = win.body.querySelectorAll<HTMLElement>(".ov-add-title");
    titles[0]!.textContent = word("UI/Overview/Filter", "Filter");
    titles[0]!.title = word("UI/Overview/ChooseOverviewPreset", "");
    titles[1]!.textContent = word("UI/Overview/BracketFilter", "Bracket Filter");
    titles[1]!.title = word("UI/Overview/ChooseBracketPreset", "");
    q<HTMLOptionElement>(".ov-add-bracket option").textContent = word("UI/Overview/ShowAllBrackets", "Show All Brackets");
    q<HTMLButtonElement>(".ov-add-ok").textContent = word("UI/Common/Buttons/OK", "OK");
    q<HTMLButtonElement>(".ov-add-cancel").textContent = word("UI/Common/Buttons/Cancel", "Cancel");
    const input = q<HTMLInputElement>("input");
    const count = q<HTMLElement>(".ov-add-count");
    const counted = () => { count.textContent = `${input.value.length}/${MAX_TAB_NAME_LENGTH}`; };
    counted();
    input.addEventListener("input", counted);
    const confirm = () => {
      const name = input.value.trim();
      if (!name) { this.hooks.notice?.(word("UI/Common/PleaseTypeSomething", "Please type something")); return; }
      if (this.tabs.length >= MAX_TAB_NUM) { this.hooks.notice?.(`You cannot have more than ${MAX_TAB_NUM} tabs`); return; }
      this.tabSettings.push({ name, preset: q<HTMLSelectElement>(".ov-add-filter").value, bracket: q<HTMLSelectElement>(".ov-add-bracket").value || null });
      win.root.remove();
      this.addTabWindow = null;
      this.tabsChanged(this.tabSettings.length - 1);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") confirm(); if (e.key === "Escape") { win.root.remove(); this.addTabWindow = null; } });
    q<HTMLButtonElement>(".ov-add-ok").addEventListener("click", confirm);
    q<HTMLButtonElement>(".ov-add-cancel").addEventListener("click", () => { win.root.remove(); this.addTabWindow = null; });
    (this.window.root.parentElement ?? document.body).append(win.root);
    input.focus();
  }

  private tabSortKey(): string { return `${this.sortKey}:tab:${this.tab}`; }

  private keepSort(): void {
    if (this.tabs.length) this.tabSorts.set(this.tab, this.sort);
    try { localStorage.setItem(this.tabs.length ? this.tabSortKey() : this.sortKey, JSON.stringify(this.sort)); }
    catch { /* kept for this visit */ }
  }

  /** The default presets in the order the client's choosers list them; empty until read. */
  presetList(): readonly PresetChoice[] { return this.presetChoices; }

  /** overviewPresetSvc.GetActiveOverviewPresetName: the chosen tab's preset - its display name and groups; null until read. */
  activePreset(): OverviewTab["overview"] { return this.tabs[this.tab]?.overview ?? null; }
  /** GetWindowName: the first three tabs' names joined by " - ", " ..." after a third. */
  windowName(): string {
    const names = this.tabSettings.map((t) => t.name);
    return names.length > 3 ? `${names.slice(0, 3).join(" - ")} ...` : names.join(" - ");
  }
  get tabCount(): number { return this.tabSettings.length; }
  /** MoveTab's leaving half: the tab taken out of this window, kept. */
  takeTab(i: number): TabSettings | null {
    const t = this.tabSettings[i];
    if (!t) return null;
    this.tabSettings.splice(i, 1);
    if (this.tabSettings.length) this.tabsChanged(this.tab > i ? this.tab - 1 : this.tab === i ? Math.max(0, i - 1) : this.tab);
    else { try { this.saveTabs(); } catch { /* lasts the page */ } }
    return t;
  }
  /** MoveTab's arriving half: the tab added to this window and chosen. */
  receiveTab(t: TabSettings): void {
    this.tabSettings.push({ ...t });
    this.tabsChanged(this.tabSettings.length - 1);
  }

  activeBracketPreset(): PresetMask | null { return this.tabs[this.tab]?.bracket ?? null; }

  /** The active tab's preset shows the group (the menu's Add .../Remove ... from Overview). */
  groupShown(groupID: number): boolean { return this.activePreset()?.groups.has(groupID) ?? false; }

  /** AddGroupToOverview / RemoveGroupFromOverview on the active tab's preset, kept for it. */
  setGroupShown(groupID: number, shown: boolean): void {
    const tab = this.tabs[this.tab] as (OverviewTab & { presetID?: string }) | undefined;
    const mask = tab?.overview;
    if (!tab || !mask || !tab.presetID) return;
    const groups = mask.groups as Set<number>;
    if (shown) groups.add(groupID); else groups.delete(groupID);
    const o = groupOverrides(tab.presetID);
    const add = new Set(o.add), remove = new Set(o.remove);
    if (shown) { add.add(groupID); remove.delete(groupID); } else { remove.add(groupID); add.delete(groupID); }
    try { localStorage.setItem(groupOverrideKey(tab.presetID), JSON.stringify({ ...o, add: [...add], remove: [...remove] })); } catch { /* the change lasts the page */ }
    this.lastDraw = 0;
  }

  groupOf(e: Entity): number | null { return e.groupID ?? (e.typeID === null ? null : this.types[String(e.typeID)]?.[1] ?? null); }

  setSelected(itemID: number | null): void { this.selected = itemID; this.lastDraw = 0; }

  private hovered: number | null = null;
  /** OverviewScrollEntry.OnStateChange(mouseOver): the row of the thing under the pointer, here or in space, lit (Hilite). */
  setHovered(itemID: number | null): void {
    if (this.hovered === itemID) return;
    this.hovered = itemID;
    for (const tr of this.tbody.querySelectorAll<HTMLElement>("tr.hover")) tr.classList.remove("hover");
    if (itemID !== null) this.tbody.querySelector(`tr[data-id="${itemID}"]`)?.classList.add("hover");
  }

  /** Redrawn a few times a second: the client's overview is not repainted every frame either. */
  update(entities: readonly Entity[], distanceTo: (e: Entity) => number, relations?: OverviewRelationships, ego?: Entity | null): void {
    const now = performance.now();
    if (now - this.lastDraw < 400) return;
    this.lastDraw = now;
    const mask = this.activePreset();
    const speed = (e: Entity) => Math.hypot(e.velocity.x, e.velocity.y, e.velocity.z);
    const typeName = (e: Entity) => (e.typeID ? this.types[String(e.typeID)]?.[0] ?? "" : "");
    // OverviewWindow.get_type_column_text: ice, gas clouds and phased asteroids by their group, other rocks by their
    // category ("Asteroid"), everything else by its type
    const typeColumn = (e: Entity): string => {
      const group = this.groupOf(e);
      if (group === 465 || group === 711 || group === 4918) return this.groupNames[String(group)]?.[0] ?? typeName(e);
      const category = e.categoryID ?? (group === null ? null : this.groupNames[String(group)]?.[1] ?? null);
      return category === 25 ? "Asteroid" : typeName(e);
    };
    const rowName = (e: Entity) => this.hooks.name?.(e) ?? e.name ?? typeName(e);
    // overviewNodeUtil.UpdateVelocityData: the ball's speed; its angular velocity, the transversal of the two balls'
    // relative velocity over max(1, the surface distance), in degrees a second. A static ball (a station, a gate, a
    // celestial) has neither, and shows "-".
    const isStatic = (e: Entity) => ["station", "stargate", "planet", "moon", "sun", "belt"].includes(e.kind) || [6, 7, 8, 9, 10].includes(e.groupID ?? -1) || e.categoryID === 3;
    const angular = (e: Entity, d: number): number | null => {
      if (!ego || isStatic(e)) return null;
      const rel = [e.velocity.x - ego.velocity.x, e.velocity.y - ego.velocity.y, e.velocity.z - ego.velocity.z];
      const dir = [e.position.x - ego.position.x, e.position.y - ego.position.y, e.position.z - ego.position.z];
      const len = Math.hypot(dir[0]!, dir[1]!, dir[2]!) || 1;
      const radial = (rel[0]! * dir[0]! + rel[1]! * dir[1]! + rel[2]! * dir[2]!) / len;
      const trans = Math.sqrt(Math.max(0, rel[0]! ** 2 + rel[1]! ** 2 + rel[2]! ** 2 - radial * radial));
      return trans / Math.max(1, d) * 180 / Math.PI;
    };
    // overviewNodeUtil.UpdateVelocityData's radial (the relative velocity along the line, away positive) and transversal
    const radialTransversal = (e: Entity): [number, number] | null => {
      if (!ego || isStatic(e)) return null;
      const rel = [e.velocity.x - ego.velocity.x, e.velocity.y - ego.velocity.y, e.velocity.z - ego.velocity.z];
      const dir = [e.position.x - ego.position.x, e.position.y - ego.position.y, e.position.z - ego.position.z];
      const len = Math.hypot(dir[0]!, dir[1]!, dir[2]!) || 1;
      const radial = (rel[0]! * dir[0]! + rel[1]! * dir[1]! + rel[2]! * dir[2]!) / len;
      return [radial, Math.sqrt(Math.max(0, rel[0]! ** 2 + rel[1]! ** 2 + rel[2]! ** 2 - radial * radial))];
    };
    const cols = this.visibleColumns();
    const wantAffiliation = new Set(cols.filter((c) => AFFILIATION_COLUMNS.has(c.id)).map((c) => c.id as string));
    const listed = entities.filter((e) => overviewRowWanted(e, this.groupOf(e), mask, relations));
    const affiliationOf = wantAffiliation.size ? this.hooks.affiliation?.(listed, wantAffiliation) ?? null : null;
    const words = (e: Entity, k: keyof OverviewAffiliation): string => affiliationOf?.(e)[k] ?? "";
    const key = this.sort.column;
    const rows = listed.map((e) => ({ e, d: distanceTo(e) })).sort((a, b) => {
      const by = key === "distance" ? a.d - b.d
        : key === "velocity" ? speed(a.e) - speed(b.e)
        : key === "size" ? (a.e.radius ?? 0) - (b.e.radius ?? 0)
        : key === "angular" ? (angular(a.e, a.d) ?? -1) - (angular(b.e, b.d) ?? -1)
        : key === "type" ? typeColumn(a.e).localeCompare(typeColumn(b.e))
        : key === "radial" ? (radialTransversal(a.e)?.[0] ?? -Infinity) - (radialTransversal(b.e)?.[0] ?? -Infinity)
        : key === "transversal" ? (radialTransversal(a.e)?.[1] ?? -1) - (radialTransversal(b.e)?.[1] ?? -1)
        : key === "tag" || key === "corporation" || key === "alliance" || key === "faction" || key === "militia" ? words(a.e, key).toLowerCase().localeCompare(words(b.e, key).toLowerCase())
        : rowName(a.e).localeCompare(rowName(b.e));
      // ties go nearest first, as the client's do
      return (this.sort.down ? -by : by) || a.d - b.d;
    });
    const html: string[] = [];
    for (const { e, d } of rows) {
      const typeName = typeColumn(e);
      const hackingHint = (e.hackingSecurityState ?? 0) > 1
        ? ` title="${esc(this.hooks.word?.(HACKED_HINT) ?? "Has already been hacked")}"` : "";
      // OverviewScrollEntry.UpdateFlagAndBackground: the icon's flag and the row's background (alpha x 0.5, structures 0.125)
      const flags = iconAndBackgroundFlags(e, this.groupOf(e), relations);
      const bg = flags.background ? ` style="--flag-bg:${rgba(flags.background.backgroundColor, (flags.background.backgroundColor[3] ?? 1) * (e.categoryID === 65 || e.categoryID === 40 ? 0.125 : 0.5))}"` : "";
      const cell = (c: ColumnDef): string => {
        switch (c.id) {
          case "ICON": return `<td class="ov-icon"${hackingHint}><span class="ov-icon-wrap">${this.hooks.glyph(e)}${flagMarkup(flags.icon)}</span></td>`;
          case "DISTANCE": return `<td class="ov-dist">${overviewDistance(d)}</td>`;
          case "NAME": return `<td>${esc(rowName(e))}</td>`;
          case "TYPE": return `<td>${esc(typeName)}</td>`;
          case "SIZE": return `<td class="ov-dist">${fmtDist(2 * (e.radius ?? 0))}</td>`;
          case "VELOCITY": return `<td class="ov-dist">${isStatic(e) ? "-" : Math.trunc(speed(e)).toLocaleString("en-US")}</td>`;
          case "RADIALVELOCITY": case "TRANSVERSALVELOCITY": {
            const rt = radialTransversal(e);
            return `<td class="ov-dist">${rt === null ? "-" : (Math.trunc(rt[c.id === "RADIALVELOCITY" ? 0 : 1]) || 0).toLocaleString("en-US")}</td>`;
          }
          case "ANGULARVELOCITY": { const w = angular(e, d); return `<td class="ov-dist">${w === null ? "-" : w.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`; }
          default: return `<td>${esc(words(e, c.id.toLowerCase() as keyof OverviewAffiliation))}</td>`;
        }
      };
      html.push(`<tr data-id="${e.itemID}" class="${e.itemID === this.selected ? "sel" : ""}${e.itemID === this.hovered ? " hover" : ""}${flags.background ? ` flagged${flags.background.backgroundBlink ? " flag-blink" : ""}` : ""}"${bg}>${cols.map(cell).join("")}</tr>`);
    }
    const markup = html.join("");
    if (markup !== this.drawnRows) {
      this.tbody.innerHTML = markup;
      this.drawnRows = markup;
    }
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
