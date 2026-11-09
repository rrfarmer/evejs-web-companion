// The Overview, in the client's look: what is on grid nearest first, one row each with its bracket, distance, name
// and type. A click selects (as a click on the thing's bracket does), a double click approaches, as the client's
// overview does by default.

import { PlayWindow, clientTexture } from "./window.ts";
import type { Entity } from "./spaceView.ts";
import { distanceWords } from "./spaceView.ts";

let names: Promise<{ types: Record<string, [string | null, number | null]>; groups: Record<string, [string | null, number | null]> } | null> | null = null;
function typeNames() {
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

  constructor(private readonly hooks: OverviewHooks) {
    this.window = new PlayWindow({ id: "overview", caption: "Overview", icon: clientTexture("res:/UI/Texture/WindowIcons/overview.png"), left: innerWidth - 470, top: 260, width: 450, height: 380, closable: false });
    this.window.body.classList.add("ov");
    this.window.body.innerHTML = `<div class="ov-tabs"><span class="ov-tab active">General</span></div>`;
    this.table.className = "ov-table";
    this.table.innerHTML = `<thead><tr><th class="ov-icon"></th><th class="ov-dist">Distance</th><th>Name</th><th>Type</th></tr></thead>`;
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
    void typeNames().then((n) => { if (n) this.types = n.types; });
  }

  setSelected(itemID: number | null): void { this.selected = itemID; this.lastDraw = 0; }

  /** Redrawn a few times a second: the client's overview is not repainted every frame either. */
  update(entities: readonly Entity[], distanceTo: (e: Entity) => number): void {
    const now = performance.now();
    if (now - this.lastDraw < 400) return;
    this.lastDraw = now;
    const rows = entities.filter((e) => !e.isSelf).map((e) => ({ e, d: distanceTo(e) })).sort((a, b) => a.d - b.d);
    const html: string[] = [];
    for (const { e, d } of rows) {
      const typeName = e.typeID ? this.types[String(e.typeID)]?.[0] ?? "" : "";
      html.push(`<tr data-id="${e.itemID}" class="${e.itemID === this.selected ? "sel" : ""}${e.isNpc ? " npc" : ""}"><td class="ov-icon">${this.hooks.glyph(e)}</td><td class="ov-dist">${distanceWords(d)}</td><td>${esc(e.name ?? typeName)}</td><td>${esc(typeName)}</td></tr>`);
    }
    this.tbody.innerHTML = html.join("");
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
