// The Overview, in the client's look: what is on grid nearest first, one row each with its bracket and the client's
// default columns (overviewConst.DEFAULT_COLUMNS: icon, distance, name, type, velocity; distance and velocity right
// aligned). Its tabs show the groups of the client's Jotunn profile (extract.mjs --overview). A click
// selects as a bracket click does. Double-click invokes the selected entity's activation.

import { PlayWindow, clientTexture } from "./window.ts";
import type { Entity } from "./spaceView.ts";
import { distanceWords } from "./spaceView.ts";
import { playUiEvent } from "./uiAudio.ts";
import { overviewRowWanted, type OverviewRelationships, type PresetMask } from "./overviewFilters.ts";

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
export interface PresetChoice { readonly id: string; readonly name: string; readonly label: string; readonly groups: ReadonlySet<number> }
let presetsRead: Promise<OverviewPresets | null> | null = null;
function overviewPresets() {
  presetsRead ??= fetch("/client-assets/overviewPresets.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return presetsRead;
}
const TAB_KEY = "evejs-play-overview-tab";
const SORT_KEY = "evejs-play-overview-sort";
const SORT_ENABLED_KEY = "evejs-play-overview-headerSortingEnabled";
type SortColumn = "distance" | "name" | "type" | "size" | "velocity" | "angular";
interface OverviewSort { column: SortColumn; down: boolean }
const DEFAULT_SORT: OverviewSort = { column: "distance", down: false };
const SORT_ENABLED = "UI/Tactical/HeaderSortingEnabledCb";
const SORT_HINT = "UI/Tactical/HeaderSortingEnabledCbHint";
const SORT_DISABLED = "UI/Tactical/HeaderSortingDisabled";
const HACKED_HINT = "Tooltips/Overview/ScatterContainerHacked";
export const OVERVIEW_WORDS = [SORT_ENABLED, SORT_HINT, SORT_DISABLED, HACKED_HINT];
const DISABLED_TEXT = "Header sorting is disabled";

function readSort(key: string, fallback: OverviewSort = DEFAULT_SORT): OverviewSort {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (["distance", "name", "type", "size", "velocity", "angular"].includes(saved?.column) && typeof saved.down === "boolean") return saved;
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
  word?(label: string): string | null;
  notice?(text: string): void;
}

export class Overview {
  readonly window: PlayWindow;
  private readonly table = document.createElement("table");
  private readonly tbody = document.createElement("tbody");
  private types: Record<string, [string | null, number | null]> = {};
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
  private lockFlash?: Animation;

  constructor(private readonly hooks: OverviewHooks) {
    this.window = new PlayWindow({ id: "overview", caption: "Overview", icon: clientTexture("res:/UI/Texture/WindowIcons/overview.png"), left: innerWidth - 470, top: 260, width: 450, height: 380, closable: false });
    this.window.body.classList.add("ov");
    this.window.body.innerHTML = `<div class="ov-tabs"><span class="ov-tab active">General</span></div>`;
    this.tabsEl = this.window.body.querySelector(".ov-tabs")!;
    // (in the title row, the window's icon and caption giving way to them)
    this.window.headSlot(this.tabsEl);
    this.tabsEl.addEventListener("click", (e) => {
      const i = Number((e.target as HTMLElement).closest<HTMLElement>(".ov-tab")?.dataset.tab);
      if (Number.isInteger(i)) this.choose(i);
    });
    this.table.className = "ov-table";
    this.table.innerHTML = `<thead><tr><th class="ov-icon"></th><th class="ov-dist" data-sort="distance"><button type="button">Distance</button></th><th data-sort="name"><button type="button">Name</button></th><th data-sort="type"><button type="button">Type</button></th><th class="ov-dist" data-sort="size"><button type="button">Size</button></th><th class="ov-dist" data-sort="velocity"><button type="button">Velocity</button></th><th class="ov-dist" data-sort="angular"><button type="button">Angular</button></th></tr></thead>`;
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
      this.lastDraw = 0;
    });
    void overviewPresets().then((p) => {
      if (!p) return;
      const masks = new Map(Object.entries(p.presets).map(([id, preset]) => [id, presetMask(preset, id)]));
      this.tabs = p.tabs.map((t) => ({
        name: t.name,
        presetID: t.preset,
        overview: masks.get(t.preset) ?? null,
        bracket: t.bracket ? masks.get(t.bracket) ?? null : null,
      }));
      // overviewUtil.GetDefaultFiltersSorted: by category (CATEGORY_ORDER), each sorted by its display name with category
      const order = p.categoryOrder ?? [0, 1, 2, 3, 4, 5];
      this.presetChoices = Object.entries(p.presets)
        .flatMap(([id, preset]) => preset ? [{ id, name: preset.name, label: preset.categoryName ? `${preset.categoryName}: ${preset.name}` : preset.name,
          groups: masks.get(id)!.groups, category: preset.categoryID ?? 0 }] : [])
        .sort((a, b) => (order.indexOf(a.category) - order.indexOf(b.category)) || a.label.localeCompare(b.label))
        .map(({ id, name, label, groups }) => ({ id, name, label, groups }));
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
    for (const button of head.querySelectorAll("th[data-sort] button")) {
      button.setAttribute("aria-label", button.textContent ?? "");
    }
    head.querySelector('th[data-sort="velocity"]')!.appendChild(this.lockIcon);
    this.markSort();

    const menu = document.createElement("div");
    menu.className = "ov-header-menu";
    menu.setAttribute("popover", "auto");
    menu.setAttribute("role", "menu");
    const option = document.createElement("button");
    option.type = "button";
    option.setAttribute("role", "menuitemcheckbox");
    option.autofocus = true;
    menu.appendChild(option);
    this.window.body.appendChild(menu);
    menu.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      menu.hidePopover();
    });
    option.addEventListener("click", () => {
      this.sortEnabled = !this.sortEnabled;
      try { localStorage.setItem(this.sortEnabledKey, String(this.sortEnabled)); } catch { /* kept for this visit */ }
      this.markSort();
      menu.hidePopover();
    });

    const showMenu = (button: HTMLButtonElement | null, x: number, y: number) => {
      const label = this.hooks.word?.(SORT_ENABLED) ?? "Header sorting enabled";
      option.textContent = label;
      option.setAttribute("aria-label", label);
      option.title = this.hooks.word?.(SORT_HINT) ?? "Click a column header to sort the overview by that column.";
      option.setAttribute("aria-checked", String(this.sortEnabled));
      if (!menu.matches(":popover-open")) menu.showPopover({ source: button ?? head });
      const { width, height } = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(0, Math.min(x, innerWidth - width))}px`;
      menu.style.top = `${Math.max(0, Math.min(y, innerHeight - height))}px`;
    };
    head.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const cell = (e.target as HTMLElement).closest("th");
      showMenu(cell?.querySelector("button") ?? null, e.clientX, e.clientY);
    });
    head.addEventListener("keydown", (e) => {
      if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
      e.preventDefault();
      e.stopPropagation();
      const button = (e.target as HTMLElement).closest("button");
      const rect = (button ?? head).getBoundingClientRect();
      showMenu(button, rect.left, rect.bottom);
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
    this.tabsEl.innerHTML = this.tabs.map((t, n) => `<span class="ov-tab${n === i ? " active" : ""}" data-tab="${n}">${esc(t.name)}</span>`).join("");
    this.sort = this.tabSorts.get(i) ?? readSort(this.tabSortKey(), initial ? this.sort : DEFAULT_SORT);
    this.keepSort();
    this.markSort();
    try { localStorage.setItem(this.tabKey, String(i)); } catch { /* not kept */ }
    this.lastDraw = 0;
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

  /** Redrawn a few times a second: the client's overview is not repainted every frame either. */
  update(entities: readonly Entity[], distanceTo: (e: Entity) => number, relations?: OverviewRelationships, ego?: Entity | null): void {
    const now = performance.now();
    if (now - this.lastDraw < 400) return;
    this.lastDraw = now;
    const mask = this.activePreset();
    const speed = (e: Entity) => Math.hypot(e.velocity.x, e.velocity.y, e.velocity.z);
    const typeName = (e: Entity) => (e.typeID ? this.types[String(e.typeID)]?.[0] ?? "" : "");
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
    const key = this.sort.column;
    const rows = entities.filter((e) => overviewRowWanted(e, this.groupOf(e), mask, relations)).map((e) => ({ e, d: distanceTo(e) })).sort((a, b) => {
      const by = key === "distance" ? a.d - b.d
        : key === "velocity" ? speed(a.e) - speed(b.e)
        : key === "size" ? (a.e.radius ?? 0) - (b.e.radius ?? 0)
        : key === "angular" ? (angular(a.e, a.d) ?? -1) - (angular(b.e, b.d) ?? -1)
        : key === "type" ? typeName(a.e).localeCompare(typeName(b.e))
        : rowName(a.e).localeCompare(rowName(b.e));
      // ties go nearest first, as the client's do
      return (this.sort.down ? -by : by) || a.d - b.d;
    });
    const html: string[] = [];
    for (const { e, d } of rows) {
      const typeName = e.typeID ? this.types[String(e.typeID)]?.[0] ?? "" : "";
      const hackingHint = (e.hackingSecurityState ?? 0) > 1
        ? ` title="${esc(this.hooks.word?.(HACKED_HINT) ?? "Has already been hacked")}"` : "";
      html.push(`<tr data-id="${e.itemID}" class="${e.itemID === this.selected ? "sel" : ""}${e.isNpc ? " npc" : ""}"><td class="ov-icon"${hackingHint}>${this.hooks.glyph(e)}</td><td class="ov-dist">${distanceWords(d)}</td><td>${esc(rowName(e))}</td><td>${esc(typeName)}</td><td class="ov-dist">${distanceWords(2 * (e.radius ?? 0))}</td><td class="ov-dist">${isStatic(e) ? "-" : Math.trunc(speed(e)).toLocaleString()}</td><td class="ov-dist">${(() => { const w = angular(e, d); return w === null ? "-" : w.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); })()}</td></tr>`);
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
