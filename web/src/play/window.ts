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

export interface WindowOptions {
  id: string;
  caption: string;
  icon?: string;
  left: number; top: number; width: number; height: number;
  minWidth?: number; minHeight?: number;
  closable?: boolean;
}

function kept(id: string): Partial<WindowOptions> {
  try { return JSON.parse(localStorage.getItem(`evejs-play-window:${id}`) ?? "{}") as Partial<WindowOptions>; } catch { return {}; }
}

export class PlayWindow {
  readonly root = document.createElement("section");
  readonly body = document.createElement("div");
  private readonly head = document.createElement("header");
  private minimized = false;

  constructor(private readonly options: WindowOptions, onClose?: () => void) {
    const at = { ...options, ...kept(options.id) };
    this.root.className = "pw";
    Object.assign(this.root.style, { left: `${at.left}px`, top: `${at.top}px`, width: `${at.width}px`, height: `${at.height}px` });
    this.head.className = "pw-head";
    this.head.innerHTML = `${options.icon ? `<img class="pw-icon" src="${options.icon}" alt="">` : ""}<span class="pw-caption"></span>
      <span class="pw-buttons"><img class="pw-btn pw-min" src="${SYSTEM_ICON.minimize}" alt="Minimize" title="Minimize">${options.closable === false ? "" : `<img class="pw-btn pw-close" src="${SYSTEM_ICON.close}" alt="Close" title="Close">`}</span>`;
    (this.head.querySelector(".pw-caption") as HTMLElement).textContent = options.caption;
    this.body.className = "pw-body";
    const grip = document.createElement("div");
    grip.className = "pw-grip";
    this.root.append(this.head, this.body, grip);
    this.head.querySelector(".pw-min")!.addEventListener("click", () => this.toggleMinimized());
    this.head.querySelector(".pw-close")?.addEventListener("click", () => { this.root.remove(); onClose?.(); });
    this.drag(this.head, (dx, dy, start) => {
      this.root.style.left = `${Math.max(0, start.left + dx)}px`;
      this.root.style.top = `${Math.max(0, start.top + dy)}px`;
    });
    this.drag(grip, (dx, dy, start) => {
      this.root.style.width = `${Math.max(options.minWidth ?? 180, start.width + dx)}px`;
      this.root.style.height = `${Math.max(options.minHeight ?? 80, start.height + dy)}px`;
    });
  }

  set caption(text: string) { (this.head.querySelector(".pw-caption") as HTMLElement).textContent = text; }

  private toggleMinimized(): void {
    this.minimized = !this.minimized;
    this.root.classList.toggle("minimized", this.minimized);
  }

  private drag(handle: HTMLElement, move: (dx: number, dy: number, start: { left: number; top: number; width: number; height: number }) => void): void {
    handle.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).classList.contains("pw-btn")) return;
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
