// The Overview, in the client's look: what is on grid nearest first, one row each with its bracket and the client's
// default columns (overviewConst.DEFAULT_COLUMNS: icon, distance, name, type, velocity; distance and velocity right
// aligned). Its tabs show the groups of the client's Jotunn profile (extract.mjs --overview). A click
// selects as a bracket click does. Double-click invokes the selected entity's activation.

import { PlayWindow, clientTexture } from "./window.ts";
import type { Entity } from "./spaceView.ts";
import { fmtDist } from "../space/overview.ts";
import { playUiEvent } from "./uiAudio.ts";
import { iconAndBackgroundFlags, overviewRowWanted, type BracketOverride, type OverviewRelationships, type PresetMask, type StateFlagLook } from "./overviewFilters.ts";

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

/** overviewSettingsConst: MAX_TAB_NUM, MAX_TAB_NAME_LENGTH. */
const MAX_TAB_NUM = 20;
const MAX_TAB_NAME_LENGTH = 15;
/** A tab's settings (presetSvc's settingsByTabID): its name, overview preset and bracket preset (null: Show All Brackets). */
interface TabSettings { name: string; preset: string; bracket: string | null; columns?: ColumnID[]; order?: ColumnID[] }
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
let presetsRead: Promise<OverviewPresets | null> | null = null;
function overviewPresets() {
  presetsRead ??= fetch("/client-assets/overviewPresets.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return presetsRead;
}
const TAB_KEY = "evejs-play-overview-tab";
const SORT_KEY = "evejs-play-overview-sort";
const SORT_ENABLED_KEY = "evejs-play-overview-headerSortingEnabled";
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
  "UI/Overview/ChangeOrder", "UI/Overview/TabColumnsCaption", "UI/Overview/OverviewSettings", "UI/Overview/Tabs", "UI/Overview/TabName", "UI/Overview/HintToggleDisplayStateAndOrder", "UI/Overview/ResetColumns", "UI/Generic/Columns"];
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
const groupOverrideKey = (presetID: string) => `evejs.ui.overview.preset.${presetID}`;
function groupOverrides(presetID: string): { add: number[]; remove: number[] } {
  try {
    const v = JSON.parse(localStorage.getItem(groupOverrideKey(presetID)) ?? "null") as { add?: number[]; remove?: number[] } | null;
    return { add: v?.add ?? [], remove: v?.remove ?? [] };
  } catch {
    return { add: [], remove: [] };
  }
}

function presetMask(data: OverviewPresetData | undefined, presetID?: string): OverviewTab["overview"] {
  if (!data) return null;
  const groups = new Set(data.groups);
  if (presetID) {
    const o = groupOverrides(presetID);
    for (const g of o.add) groups.add(g);
    for (const g of o.remove) groups.delete(g);
  }
  return {
    name: data.name,
    groups,
    filteredStates: data.filteredStates ?? [],
    alwaysShownStates: data.alwaysShownStates ?? [],
  };
}

let names: Promise<{ types: Record<string, [string | null, number | null]>; groups: Record<string, [string | null, number | null]> } | null> | null = null;
export function typeNames() {
  names ??= fetch("/client-assets/typeNames.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return names;
}

export interface OverviewHooks {
  select(itemID: number): void;
  activate(itemID: number): void;
  glyph(e: Entity): string;
  /** The row's Name (uix.GetSlimItemName); the slim's name, else the type's, where it is not given. */
  name?(e: Entity): string;
  pilotID?: number;
  word?(label: string, args?: Readonly<Record<string, string | number>>): string | null;
  notice?(text: string): void;
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
    this.window = new PlayWindow({ id: "overview", caption: "Overview", left: innerWidth - 586, top: 260, width: 566, height: 380, closable: false,
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
    const pilotSuffix = hooks.pilotID === undefined ? "" : `:${hooks.pilotID}`;
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
      this.tabSettings = this.storedTabs() ?? p.tabs.map((t) => ({ name: t.name, preset: t.preset, bracket: t.bracket ?? null }));
      this.tabs = this.tabSettings.map((t) => this.tabOf(t));
      // overviewUtil.GetDefaultFiltersSorted: by category (CATEGORY_ORDER), each sorted by its display name with category
      const order = p.categoryOrder ?? [0, 1, 2, 3, 4, 5];
      this.presetChoices = Object.entries(p.presets)
        .flatMap(([id, preset]) => preset ? [{ id, name: preset.name, label: preset.categoryName ? `${preset.categoryName}: ${preset.name}` : preset.name,
          groups: masks.get(id)!.groups, category: preset.categoryID ?? 0, categoryName: preset.categoryName ?? null }] : [])
        .sort((a, b) => (order.indexOf(a.category) - order.indexOf(b.category)) || a.label.localeCompare(b.label));
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
      try { localStorage.setItem(this.tabsKey, JSON.stringify(this.tabSettings)); } catch { /* the change lasts the page */ }
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
   * OverviewSettingsWnd (UI/Overview/OverviewSettings, 520 x 600): its tab group, of which the Tabs panel is here so far
   * (TabsPanel: for each of MAX_TAB_NUM slots the Tab Name (MAX_TAB_NAME_LENGTH), Filter and Bracket Filter combos -
   * Show All Brackets first - and a delete button; naming an empty slot adds the tab, UpdateOverviewTab on each change).
   */
  openSettings(): void {
    const word = (label: string, own: string) => this.hooks.word?.(label) ?? own;
    document.querySelector(".ov-settings")?.closest(".pw")?.remove();
    const win = new PlayWindow({ id: "overview-settings", caption: word("UI/Overview/OverviewSettings", "Overview Settings"),
      left: Math.round(innerWidth / 2 - 260), top: Math.round(innerHeight / 2 - 300), width: 520, height: 600, minWidth: 520, minHeight: 500 });
    win.body.classList.add("ov-settings");
    const options = (selected: string | null, showAll: boolean) =>
      (showAll ? `<option value=""${selected === null ? " selected" : ""}>${esc(word("UI/Overview/ShowAllBrackets", "Show All Brackets"))}</option>` : "") +
      this.presetChoices.map((p) => `<option value="${esc(p.id)}"${p.id === selected ? " selected" : ""}>${esc(p.label)}</option>`).join("");
    const draw = () => {
      // an empty slot shows overviewPresetSvc.GetDefaultPreset (DefaultPreset_639452, "General: General", read from the client)
      const first = this.presetChoices.find((p) => p.id === "DefaultPreset_639452")?.id ?? this.presetChoices[0]?.id ?? null;
      const rows = Array.from({ length: MAX_TAB_NUM }, (_, i) => {
        const t = this.tabSettings[i];
        return `<div class="ov-set-row" data-slot="${i}"><input class="ov-set-name" maxlength="${MAX_TAB_NAME_LENGTH}" value="${esc(t?.name ?? "")}" autocomplete="off">
          <select class="ov-set-filter" title="${esc(word("UI/Overview/ChooseOverviewPreset", ""))}">${options(t?.preset ?? first, false)}</select>
          <select class="ov-set-bracket" title="${esc(word("UI/Overview/ChooseBracketPreset", ""))}">${options(t ? t.bracket : null, true)}</select>
          ${t ? `<img class="ov-set-delete" src="${clientTexture("res:/UI/Texture/eveicon/system_icons/close_16px.png")}" alt="" title="${esc(word("UI/Overview/DeleteTab", "Delete Tab"))}">` : `<span></span>`}</div>`;
      }).join("");
      win.body.innerHTML = `<div class="ov-set-tabs"><span class="ov-set-tab active"></span></div>
        <div class="ov-set-panel"><div class="ov-set-row ov-set-head"><span></span><span></span><span></span><span></span></div>${rows}</div>`;
      win.body.querySelector(".ov-set-tab")!.textContent = word("UI/Overview/Tabs", "Tabs");
      const heads = win.body.querySelectorAll<HTMLElement>(".ov-set-head span");
      heads[0]!.textContent = word("UI/Overview/TabName", "Tab Name");
      heads[1]!.textContent = word("UI/Overview/Filter", "Filter");
      heads[2]!.textContent = word("UI/Overview/BracketFilter", "Bracket Filter");
    };
    // UpdateOverviewTab: each named slot updated, or added after the others
    const update = () => {
      const next: TabSettings[] = [];
      for (const row of win.body.querySelectorAll<HTMLElement>(".ov-set-row[data-slot]")) {
        const i = Number(row.dataset.slot);
        const name = row.querySelector<HTMLInputElement>(".ov-set-name")!.value.trim();
        const old = this.tabSettings[i];
        if (!name) { if (old) next.push(old); continue; }
        next.push({ ...(old ?? {}), name, preset: row.querySelector<HTMLSelectElement>(".ov-set-filter")!.value,
          bracket: row.querySelector<HTMLSelectElement>(".ov-set-bracket")!.value || null });
      }
      this.tabSettings = next;
      this.tabsChanged(Math.min(this.tab, next.length - 1));
      draw();
    };
    win.body.addEventListener("change", (e) => { if ((e.target as HTMLElement).closest(".ov-set-row")) update(); });
    win.body.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.target as HTMLElement).matches(".ov-set-name")) update(); });
    win.body.addEventListener("click", (e) => {
      const del = (e.target as HTMLElement).closest(".ov-set-delete");
      if (!del || this.tabSettings.length <= 1) return;
      const i = Number(del.closest<HTMLElement>(".ov-set-row")!.dataset.slot);
      this.tabSettings.splice(i, 1);
      this.tabsChanged(this.tab > i ? this.tab - 1 : Math.min(this.tab, this.tabSettings.length - 1));
      draw();
    });
    draw();
    (this.window.root.parentElement ?? document.body).append(win.root);
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
    try { localStorage.setItem(this.tabsKey, JSON.stringify(this.tabSettings)); } catch { /* the change lasts the page */ }
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
    this.tabsEl.innerHTML = this.tabs.map((t, n) => `<span class="ov-tab${n === this.tab ? " active" : ""}" data-tab="${n}">${esc(t.name)}</span>`).join("") + add;
  }

  private get tabsKey(): string { return TABS_KEY + (this.hooks.pilotID === undefined ? "" : `:${this.hooks.pilotID}`); }

  private storedTabs(): TabSettings[] | null {
    try {
      const v = JSON.parse(localStorage.getItem(this.tabsKey) ?? "null") as TabSettings[] | null;
      const tabs = Array.isArray(v) ? v.filter((t) => typeof t?.name === "string" && typeof t.preset === "string") : [];
      return tabs.length ? tabs.map((t) => ({ name: t.name, preset: t.preset, bracket: typeof t.bracket === "string" ? t.bracket : null,
        ...(Array.isArray(t.columns) ? { columns: t.columns.filter((c) => COLUMNS.some((d) => d.id === c)) } : {}),
        ...(Array.isArray(t.order) ? { order: t.order.filter((c) => COLUMNS.some((d) => d.id === c)) } : {}) })) : null;
    } catch {
      return null;
    }
  }

  private tabOf(t: TabSettings): OverviewTab {
    return { name: t.name, presetID: t.preset, overview: this.masks.get(t.preset) ?? null, bracket: t.bracket ? this.masks.get(t.bracket) ?? null : null } as OverviewTab;
  }

  /** The tab list changed (presetSvc.UpdateSettingsByTabID): kept, the tabs drawn again, the chosen one shown. */
  private tabsChanged(chosen: number): void {
    try { localStorage.setItem(this.tabsKey, JSON.stringify(this.tabSettings)); } catch { /* the change lasts the page */ }
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
      const out: (ContextEntry | null)[] = [{ label: word("UI/Overview/DefaultFilters", "Default Filters"), caption: true }];
      for (const p of byCategory.get(0) ?? []) out.push(entry(p));
      for (const [category, presets] of byCategory) {
        if (category === 0) continue;
        out.push({ label: presets[0]?.categoryName ?? String(category), icon: CATEGORY_ICONS[category] ?? null, sub: presets.map(entry) });
      }
      out.push(null, { label: word("UI/Overview/EditCurrentFilter", "Edit Current Filter"), icon: SETTINGS_ICON, disabled: "Not here yet" });
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
    try { localStorage.setItem(groupOverrideKey(tab.presetID), JSON.stringify({ add: [...add], remove: [...remove] })); } catch { /* the change lasts the page */ }
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
