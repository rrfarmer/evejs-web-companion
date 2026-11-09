// The Overview, in the client's look: what is on grid nearest first, one row each with its bracket and the client's
// default columns (overviewConst.DEFAULT_COLUMNS: icon, distance, name, type, velocity; distance and velocity right
// aligned). Its tabs are the client's first ones (characterdata/defaultOverviews.py DEFAULT_TAB_NAMES: General, Mining,
// WarpTo), each showing the groups of its default preset (staticData/defaultOverviews, extract.mjs --overview). A click
// selects (as a click on the thing's bracket does), a double click approaches, as the client's overview does by default.

import { PlayWindow, clientTexture } from "./window.ts";
import type { Entity } from "./spaceView.ts";
import { distanceWords } from "./spaceView.ts";

interface OverviewPresets { tabs: { name: string; preset: string }[]; presets: Record<string, { name: string; groups: number[] }> }
let presetsRead: Promise<OverviewPresets | null> | null = null;
function overviewPresets() {
  presetsRead ??= fetch("/client-assets/overviewPresets.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return presetsRead;
}
const TAB_KEY = "evejs-play-overview-tab";

let names: Promise<{ types: Record<string, [string | null, number | null]>; groups: Record<string, [string | null, number | null]> } | null> | null = null;
export function typeNames() {
  names ??= fetch("/client-assets/typeNames.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return names;
}

export interface OverviewHooks {
  select(itemID: number): void;
  approach(itemID: number): void;
  glyph(e: Entity): string;
}

export class Overview {
  readonly window: PlayWindow;
  private readonly table = document.createElement("table");
  private readonly tbody = document.createElement("tbody");
  private types: Record<string, [string | null, number | null]> = {};
  private lastDraw = 0;
  private selected: number | null = null;
  private groupsOfType: Record<string, number | null> = {};
  private tabs: { name: string; groups: Set<number> }[] = [];
  private tab = 0;
  private readonly tabsEl: HTMLDivElement;

  constructor(private readonly hooks: OverviewHooks) {
    this.window = new PlayWindow({ id: "overview", caption: "Overview", icon: clientTexture("res:/UI/Texture/WindowIcons/overview.png"), left: innerWidth - 470, top: 260, width: 450, height: 380, closable: false });
    this.window.body.classList.add("ov");
    this.window.body.innerHTML = `<div class="ov-tabs"><span class="ov-tab active">General</span></div>`;
    this.tabsEl = this.window.body.querySelector(".ov-tabs")!;
    this.tabsEl.addEventListener("click", (e) => {
      const i = Number((e.target as HTMLElement).closest<HTMLElement>(".ov-tab")?.dataset.tab);
      if (Number.isInteger(i)) this.choose(i);
    });
    this.table.className = "ov-table";
    this.table.innerHTML = `<thead><tr><th class="ov-icon"></th><th class="ov-dist">Distance</th><th>Name</th><th>Type</th><th class="ov-dist">Velocity</th></tr></thead>`;
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
      if (id) this.hooks.approach(id);
    });
    void typeNames().then((n) => {
      if (!n) return;
      this.types = n.types;
      for (const [id, [, group]] of Object.entries(n.types)) this.groupsOfType[id] = group;
    });
    void overviewPresets().then((p) => {
      if (!p) return;
      this.tabs = p.tabs.map((t) => ({ name: t.name, groups: new Set(p.presets[t.preset]?.groups ?? []) }));
      let saved = 0;
      try { saved = Number(localStorage.getItem(TAB_KEY)) || 0; } catch { /* no storage: the first tab */ }
      this.choose(saved < this.tabs.length ? saved : 0);
    });
  }

  /** A tab chosen: its name lit, the rows its preset shows, kept for the next visit. */
  private choose(i: number): void {
    this.tab = i;
    this.tabsEl.innerHTML = this.tabs.map((t, n) => `<span class="ov-tab${n === i ? " active" : ""}" data-tab="${n}">${esc(t.name)}</span>`).join("");
    try { localStorage.setItem(TAB_KEY, String(i)); } catch { /* not kept */ }
    this.lastDraw = 0;
  }

  setSelected(itemID: number | null): void { this.selected = itemID; this.lastDraw = 0; }

  /** Redrawn a few times a second: the client's overview is not repainted every frame either. */
  update(entities: readonly Entity[], distanceTo: (e: Entity) => number): void {
    const now = performance.now();
    if (now - this.lastDraw < 400) return;
    this.lastDraw = now;
    // the chosen tab's preset: a thing shows when its type's group is one of the preset's (all, until they are read)
    const groups = this.tabs[this.tab]?.groups ?? null;
    const shown = (e: Entity) => {
      if (!groups || !e.typeID) return true;
      const group = this.groupsOfType[String(e.typeID)];
      return group == null || groups.has(group);
    };
    const rows = entities.filter((e) => !e.isSelf && shown(e)).map((e) => ({ e, d: distanceTo(e) })).sort((a, b) => a.d - b.d);
    const html: string[] = [];
    for (const { e, d } of rows) {
      const typeName = e.typeID ? this.types[String(e.typeID)]?.[0] ?? "" : "";
      html.push(`<tr data-id="${e.itemID}" class="${e.itemID === this.selected ? "sel" : ""}${e.isNpc ? " npc" : ""}"><td class="ov-icon">${this.hooks.glyph(e)}</td><td class="ov-dist">${distanceWords(d)}</td><td>${esc(e.name ?? typeName)}</td><td>${esc(typeName)}</td><td class="ov-dist">${Math.round(Math.hypot(e.velocity.x, e.velocity.y, e.velocity.z)).toLocaleString()} m/s</td></tr>`);
    }
    this.tbody.innerHTML = html.join("");
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
