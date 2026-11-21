// The client's context menu (carbonui/control/contextMenu: ContextMenu, MenuEntryView), as a right-click opens it on
// something in space, a bracket or an overview row. Measured on the 3698585 client through gridcheck: an 8 px
// MenuUnderlay (the blurred scene tinted (0.024, 0.039, 0.047), framed by 1_16_193 at white 0.1); entries 22 px high,
// their 16 px icon at 4, their TextBody at 28 (14 px, white 0.75), a submenu's arrow (1_16_14) at the right; dividers
// 13 px with a white 0.1 line; Show Info's icon an info glyph on a FOCUS_BLUE disc. In the page's top layer.

import { clientTexture } from "../ui/skillGroupIcons.ts";

export interface ContextEntry {
  readonly label: string;
  /** A res: path, or null for none. */
  readonly icon?: string | null;
  /** Show Info's own icon (classes/Menu/Icons/info.png on circleBG in FOCUS_BLUE). */
  readonly info?: boolean;
  readonly run?: () => void;
  readonly sub?: readonly (ContextEntry | null)[];
  /** Why it cannot run, shown greyed with this hint (menuEntries.reasonsWhyNotAvailable). */
  readonly disabled?: string | null;
  /** A radio entry (MenuEntryDataRadioButton): true for the chosen one, false for the others. */
  readonly checked?: boolean;
  /** With `checked`, a checkbox (MenuEntryDataCheckbox) rather than a radio entry. */
  readonly checkbox?: boolean;
  /** The entry's hint, shown on hover. */
  readonly hint?: string | null;
  /** A caption (MenuData.AddCaption): a heading among the entries, not to be clicked. */
  readonly caption?: boolean;
}

const ROW = 22;
// the menu's art loaded with the page, so a first menu has its icons
for (const p of ["res:/UI/Texture/Icons/1_16_14.png", "res:/UI/Texture/classes/Menu/Icons/info.png", ...["approach", "orbit", "keep_at_distance", "warp_to", "align_to", "dock", "jump_to", "target", "enter_planet_view"].map((n) => `res:/UI/Texture/eveicon/control_icons/${n}_16px.png`), "res:/UI/Texture/eveicon/system_icons/set_destination_16px.png"]) {
  if (typeof Image !== "undefined") new Image().src = clientTexture(p);
}
const tex = (path: string) => clientTexture(path);

export class ContextMenu {
  private readonly panels: HTMLDivElement[] = [];
  private readonly onDown = (e: MouseEvent) => {
    if (!this.panels.some((p) => p.contains(e.target as Node))) this.close();
  };
  private readonly onKey = (e: KeyboardEvent) => { if (e.key === "Escape") this.close(); };

  get isOpen(): boolean { return this.panels.length > 0; }

  /** What the open menu says, entry by entry ("---" a divider), for checks. */
  get text(): string[] {
    return this.panels[0] ? [...this.panels[0].querySelectorAll<HTMLElement>("[data-entry], [data-divider]")].map((el) => (el.dataset.divider !== undefined ? "---" : el.dataset.entry ?? "")) : [];
  }

  open(x: number, y: number, entries: readonly (ContextEntry | null)[]): void {
    this.close();
    const panel = this.panel(entries, 0);
    this.place(panel, x, y);
    document.addEventListener("mousedown", this.onDown, true);
    document.addEventListener("keydown", this.onKey, true);
  }

  close(): void {
    for (const p of this.panels.splice(0)) p.remove();
    document.removeEventListener("mousedown", this.onDown, true);
    document.removeEventListener("keydown", this.onKey, true);
  }

  private closeFrom(depth: number): void {
    for (const p of this.panels.splice(depth)) p.remove();
  }

  /** MenuUtil's placing: at the cursor, kept on screen (flipped left or up where it would run off). */
  private place(panel: HTMLDivElement, x: number, y: number, flipFrom?: number): void {
    const w = panel.offsetWidth, h = panel.offsetHeight;
    let left = x, top = y;
    if (left + w > innerWidth) left = flipFrom !== undefined ? flipFrom - w : innerWidth - w;
    if (top + h > innerHeight) top = Math.max(0, innerHeight - h);
    panel.style.left = `${Math.max(0, Math.round(left))}px`;
    panel.style.top = `${Math.max(0, Math.round(top))}px`;
  }

  private panel(entries: readonly (ContextEntry | null)[], depth: number): HTMLDivElement {
    const panel = document.createElement("div");
    panel.className = "eve-context-menu";
    Object.assign(panel.style, {
      position: "fixed", zIndex: "100001", padding: "8px", minWidth: "160px", boxSizing: "border-box",
      background: "rgba(6,10,12,0.92)", backdropFilter: "blur(8px)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1)",
      font: "14px 'EVE Sans Neue','Segoe UI',sans-serif", color: "rgba(255,255,255,0.75)", userSelect: "none", whiteSpace: "nowrap",
    } as Partial<CSSStyleDeclaration>);
    // dividers collapse: none leading, trailing or doubled (MenuList)
    const tidy: (ContextEntry | null)[] = [];
    for (const e of entries) {
      if (e === null && (tidy.length === 0 || tidy[tidy.length - 1] === null)) continue;
      tidy.push(e);
    }
    while (tidy.length && tidy[tidy.length - 1] === null) tidy.pop();
    for (const entry of tidy) {
      if (entry === null) {
        const d = document.createElement("div");
        d.dataset.divider = "";
        Object.assign(d.style, { height: "13px", position: "relative" });
        const line = document.createElement("div");
        Object.assign(line.style, { position: "absolute", left: "0", right: "0", top: "6px", height: "1px", background: "rgba(255,255,255,0.1)" });
        d.append(line);
        panel.append(d);
        continue;
      }
      panel.append(this.row(entry, depth));
    }
    document.body.append(panel);
    this.panels[depth] = panel;
    return panel;
  }

  private row(entry: ContextEntry, depth: number): HTMLDivElement {
    const row = document.createElement("div");
    if (entry.caption) {
      row.dataset.caption = entry.label;
      row.textContent = entry.label;
      Object.assign(row.style, { height: `${ROW}px`, lineHeight: `${ROW}px`, padding: "0 8px", fontSize: "12px", color: "rgba(255,255,255,0.5)", cursor: "default" });
      row.addEventListener("mouseenter", () => this.closeFrom(depth + 1));
      return row;
    }
    row.dataset.entry = entry.label;
    const disabled = !!entry.disabled;
    Object.assign(row.style, { position: "relative", height: `${ROW}px`, lineHeight: `${ROW}px`, padding: "0 28px", cursor: disabled ? "default" : "pointer", opacity: disabled ? "0.4" : "1" });
    if (disabled) row.title = entry.disabled!;
    else if (entry.hint) row.title = entry.hint;
    if (entry.info) {
      const disc = document.createElement("span");
      Object.assign(disc.style, { position: "absolute", left: "4px", top: "3px", width: "16px", height: "16px", borderRadius: "50%", background: "rgba(88,167,191,0.75)" });
      const i = document.createElement("img");
      i.src = tex("res:/UI/Texture/classes/Menu/Icons/info.png");
      Object.assign(i.style, { position: "absolute", left: "0", top: "0", width: "16px", height: "16px" });
      disc.append(i);
      row.append(disc);
    } else if (entry.checked !== undefined) {
      const dot = document.createElement("span");
      Object.assign(dot.style, entry.checkbox
        ? { position: "absolute", left: "5px", top: "5px", width: "12px", height: "12px", boxSizing: "border-box", border: "1px solid rgba(255,255,255,0.6)",
          background: entry.checked ? `center / 12px no-repeat url(${tex("res:/UI/Texture/eveicon/system_icons/checkmark_16px.png")})` : "transparent" }
        : { position: "absolute", left: "7px", top: "7px", width: "8px", height: "8px", borderRadius: "50%", boxSizing: "border-box",
          border: "1px solid rgba(255,255,255,0.75)", background: entry.checked ? "rgba(255,255,255,0.9)" : "transparent" });
      if (entry.checkbox) row.setAttribute("aria-checked", String(!!entry.checked));
      row.append(dot);
    } else if (entry.icon) {
      const i = document.createElement("img");
      i.src = tex(entry.icon);
      Object.assign(i.style, { position: "absolute", left: "4px", top: "3px", width: "16px", height: "16px", opacity: "0.75" });
      row.append(i);
    }
    const label = document.createElement("span");
    label.textContent = entry.label;
    row.append(label);
    if (entry.sub) {
      const arrow = document.createElement("img");
      arrow.src = tex("res:/UI/Texture/Icons/1_16_14.png");
      Object.assign(arrow.style, { position: "absolute", right: "0", top: "3px", width: "16px", height: "16px", opacity: "0.75" });
      row.append(arrow);
    }
    row.addEventListener("mouseenter", () => {
      if (!disabled) row.style.background = "rgba(255,255,255,0.08)";
      this.closeFrom(depth + 1);
      if (entry.sub && !disabled) {
        const r = row.getBoundingClientRect();
        const sub = this.panel(entry.sub, depth + 1);
        this.place(sub, r.right + 8, r.top - 8, r.left - 8);
      }
    });
    row.addEventListener("mouseleave", () => { row.style.background = ""; });
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (disabled || !entry.run) return;
      this.close();
      entry.run();
    });
    return row;
  }
}
