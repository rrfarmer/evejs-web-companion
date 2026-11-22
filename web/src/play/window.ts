// A window in the client's look: a dark, slightly see-through panel with a thin edge, a header with the window's
// icon and caption and the client's own system icons (minimize, close) on the right, dragged by its header and
// resized from its corner, where it was left kept per window in this browser.

const ICON = (path: string) => `/client-res/${path.replace(/^res:\//i, "").toLowerCase()}`;
export const SYSTEM_ICON = {
  close: ICON("res:/UI/Texture/eveicon/system_icons/close_16px.png"),
  minimize: ICON("res:/UI/Texture/eveicon/system_icons/minimize_16px.png"),
  caret: ICON("res:/UI/Texture/eveicon/system_icons/caret_down_16px.png"),
  more: ICON("res:/UI/Texture/eveicon/system_icons/more_vertical_16px.png"),
};
export const clientTexture = ICON;

import type { ContextEntry } from "./contextMenu.ts";

/** The window actions' words (WindowAction labels), for the More menus. */
export const WINDOW_ACTION_WORDS: readonly string[] = ["/Carbon/UI/Controls/Window/Lock", "/Carbon/UI/Controls/Window/Unlock", "/Carbon/UI/Controls/Window/EnableLightBackground",
  "/Carbon/UI/Controls/Window/DisableLightBackground", "/Carbon/UI/Controls/Window/Collapse", "/Carbon/UI/Controls/Window/Expand"];

export interface WindowOptions {
  id: string;
  caption: string;
  icon?: string;
  left: number; top: number; width: number; height: number;
  minWidth?: number; minHeight?: number;
  closable?: boolean;
  /** The window's ⋮ (MenuButtonIcon, GetMenuMoreOptions): given the button, opens the window's menu. */
  menu?: (button: HTMLElement) => void;
  /**
   * "default": the client's DefaultWindowHeader chrome (48 high, a 32 px icon, the 18 px caption, 24 px controls), as a
   * full-size window draws it; "small": the client's SmallWindowHeader (32 high, the 12 px caption, 24 px controls), as
   * the in-space panels draw it; omitted, the older small header.
   */
  chrome?: "default" | "small";
}

function kept(id: string): Partial<WindowOptions> {
  try { return JSON.parse(localStorage.getItem(`evejs-play-window:${id}`) ?? "{}") as Partial<WindowOptions>; } catch { return {}; }
}

// one active window: a press anywhere outside the active PlayWindow (another window, the scene) ends its active state
if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", (e) => {
    const active = document.querySelector(".pw.pw-active");
    if (active && !active.contains(e.target as Node)) active.classList.remove("pw-active");
  }, { capture: true });
}

export class PlayWindow {
  readonly root = document.createElement("section");
  readonly body = document.createElement("div");
  private readonly head = document.createElement("header");
  private minimized = false;
  /** LockWindowAction: no moving or resizing while locked. */
  private locked = false;
  /** LightBackgroundWindowAction, off: the light-background window drawn as the others. */
  private lightOff = false;
  private minWidthNow: number;

  constructor(private readonly options: WindowOptions, onClose?: () => void) {
    const at = { ...options, ...kept(options.id) };
    this.minWidthNow = options.minWidth ?? 180;
    this.root.className = options.chrome ? `pw pw-${options.chrome}` : "pw";
    try { const f = JSON.parse(localStorage.getItem(`evejs-play-window-flags:${options.id}`) ?? "{}") as { locked?: boolean; lightOff?: boolean }; this.locked = !!f.locked; this.lightOff = !!f.lightOff; } catch { /* none kept */ }
    this.root.classList.toggle("pw-locked", this.locked);
    this.root.classList.toggle("pw-nolight", this.lightOff);
    Object.assign(this.root.style, { left: `${at.left}px`, top: `${at.top}px`, width: `${at.width}px`, height: `${at.height}px` });
    this.head.className = "pw-head";
    this.head.innerHTML = `${options.icon ? `<img class="pw-icon" src="${options.icon}" alt="">` : ""}<span class="pw-caption"></span>
      <span class="pw-buttons">${options.menu ? `<img class="pw-btn pw-more" src="${SYSTEM_ICON.more}" alt="More" title="">` : ""}<img class="pw-btn pw-min" src="${SYSTEM_ICON.minimize}" alt="Minimize" title="Minimize">${options.closable === false ? "" : `<img class="pw-btn pw-close" src="${SYSTEM_ICON.close}" alt="Close" title="Close">`}</span>`;
    (this.head.querySelector(".pw-caption") as HTMLElement).textContent = options.caption;
    this.body.className = "pw-body";
    const grip = document.createElement("div");
    grip.className = "pw-grip";
    this.root.append(this.head, this.body, grip);
    // Window.active (the last window pressed): SmallWindowHeader.caption_color - HIGHLIGHT while active, NORMAL otherwise
    // (the light background on)
    const activate = () => this.activate();
    this.root.addEventListener("pointerdown", activate, { capture: true });
    // (a window that opens is the active one)
    queueMicrotask(() => { if (this.root.isConnected && this.root.style.display !== "none") activate(); });
    this.head.querySelector(".pw-min")!.addEventListener("click", () => this.toggleMinimized());
    const more = this.head.querySelector<HTMLElement>(".pw-more");
    if (more && options.menu) {
      more.addEventListener("pointerdown", (e) => e.stopPropagation());
      more.addEventListener("click", (e) => { e.stopPropagation(); options.menu!(more); });
    }
    this.head.querySelector(".pw-close")?.addEventListener("click", () => { this.root.remove(); onClose?.(); });
    this.drag(this.head, (dx, dy, start) => {
      this.root.style.left = `${Math.max(0, start.left + dx)}px`;
      this.root.style.top = `${Math.max(0, start.top + dy)}px`;
    });
    this.drag(grip, (dx, dy, start) => {
      this.root.style.width = `${Math.max(this.minWidthNow, start.width + dx)}px`;
      this.root.style.height = `${Math.max(options.minHeight ?? 80, start.height + dy)}px`;
    });
  }

  set caption(text: string) { (this.head.querySelector(".pw-caption") as HTMLElement).textContent = text; }

  /**
   * An element in the title row in place of the icon and caption (the Overview's tabs, as the client and the eve-cs
   * mirror draw them in the window's header); a press on it does not drag the window.
   */
  headSlot(el: HTMLElement): void {
    el.classList.add("pw-nodrag");
    this.head.classList.add("pw-head-slotted");
    this.head.insertBefore(el, this.head.querySelector(".pw-buttons"));
  }

  /** The slotted element put back where it was (before `before` in `into`), the caption shown again. */
  headUnslot(el: HTMLElement, into: HTMLElement, before: Node | null): void {
    this.head.classList.remove("pw-head-slotted");
    into.insertBefore(el, before);
  }

  /** SetMinSize's width, changed at run time (a window narrower than it widened to it). */
  setMinWidth(width: number): void {
    this.minWidthNow = width;
    if (this.root.getBoundingClientRect().width < width) this.root.style.width = `${width}px`;
  }

  /**
   * The window's actions as its More menu lists them first (Window.GetMenuMoreOptions over its WindowActions, read through
   * gridcheck): Lock window size and position, the window's compact mode where it has one, Disable / Enable Light
   * Background on a light-background window (IsLightBackgroundConfigurable), Collapse / Expand; a line after them.
   * (Enable always above fullscreen views has no fullscreen view to rise above on this page, so it is not offered.)
   */
  windowActions(word: (label: string, own: string) => string, compact: ContextEntry | null = null): (ContextEntry | null)[] {
    const I = (n: string) => `res:/UI/Texture/eveicon/system_icons/${n}_16px.png`;
    const out: (ContextEntry | null)[] = [
      { label: this.locked ? word("/Carbon/UI/Controls/Window/Unlock", "Unlock window size and position") : word("/Carbon/UI/Controls/Window/Lock", "Lock window size and position"),
        icon: I(this.locked ? "locked" : "unlocked"), run: () => this.setFlags({ locked: !this.locked }) },
    ];
    if (compact) out.push(compact);
    if (this.options.chrome === "small") out.push({ label: this.lightOff ? word("/Carbon/UI/Controls/Window/EnableLightBackground", "Enable Light Background") : word("/Carbon/UI/Controls/Window/DisableLightBackground", "Disable Light Background"),
      icon: I(this.lightOff ? "light_background_off" : "light_background_on"), run: () => this.setFlags({ lightOff: !this.lightOff }) });
    out.push({ label: this.minimized ? word("/Carbon/UI/Controls/Window/Expand", "Expand") : word("/Carbon/UI/Controls/Window/Collapse", "Collapse"),
      icon: I(this.minimized ? "expand" : "collapse"), run: () => this.toggleMinimized() }, null);
    return out;
  }

  private setFlags(change: { locked?: boolean; lightOff?: boolean }): void {
    if (change.locked !== undefined) this.locked = change.locked;
    if (change.lightOff !== undefined) this.lightOff = change.lightOff;
    this.root.classList.toggle("pw-locked", this.locked);
    this.root.classList.toggle("pw-nolight", this.lightOff);
    try { localStorage.setItem(`evejs-play-window-flags:${this.options.id}`, JSON.stringify({ locked: this.locked, lightOff: this.lightOff })); } catch { /* this visit only */ }
  }

  /** MinimizeWindowAction (UI/Control/EveWindow/Minimize): the window folded to its header, or opened again. */
  minimize(): void { this.toggleMinimized(); }
  /** Window.active (uicore.registry.SetFocus): this the active window, the others not. */
  activate(): void {
    if (this.root.classList.contains("pw-active")) return;
    for (const w of document.querySelectorAll(".pw.pw-active")) w.classList.remove("pw-active");
    this.root.classList.add("pw-active");
  }

  private toggleMinimized(): void {
    this.minimized = !this.minimized;
    this.root.classList.toggle("minimized", this.minimized);
  }

  private drag(handle: HTMLElement, move: (dx: number, dy: number, start: { left: number; top: number; width: number; height: number }) => void): void {
    handle.addEventListener("pointerdown", (e) => {
      if (this.locked || (e.target as HTMLElement).classList.contains("pw-btn") || (e.target as HTMLElement).closest(".pw-nodrag")) return;
      e.preventDefault();
      const r = this.root.getBoundingClientRect();
      const start = { left: r.left, top: r.top, width: r.width, height: r.height };
      const x0 = e.clientX, y0 = e.clientY;
      const onMove = (ev: PointerEvent) => move(ev.clientX - x0, ev.clientY - y0, start);
      const onUp = () => {
        removeEventListener("pointermove", onMove);
        removeEventListener("pointerup", onUp);
        const r2 = this.root.getBoundingClientRect();
        try { localStorage.setItem(`evejs-play-window:${this.options.id}`, JSON.stringify({ left: r2.left, top: r2.top, width: r2.width, height: r2.height })); } catch { /* kept for this visit only */ }
      };
      addEventListener("pointermove", onMove);
      addEventListener("pointerup", onUp);
    });
  }
}
