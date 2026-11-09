// The radial menu, as the client builds it (ui/shared/radialMenu: radialMenu.py, radialMenuLayer.py,
// radialMenuActions.py, spaceRadialMenuFunctions.py), in our own code with the client's own textures
// (res:/UI/Texture/classes/RadialMenu, the action icons of spaceRadialMenuFunctions.iconDict):
// - 220 px across, eight slices of 45 degrees, the first at the top and the rest clockwise (FindOptionsDegree), each
//   a 100x70 slice at the top of a 100x220 holder turned to its degree, its 32 px icon kept upright;
// - opened by holding the mouse on an object for 150 ms without moving it 12 px (RADIAL_MENU_EXPAND_DELAY_DEFAULT,
//   _TryExpandActionMenu); here also by the right button;
// - the slice under the pointer is the one its angle falls in; letting go there does it, letting go in the middle
//   leaves the menu open for a click;
// - a range action (orbit, keep at range, warp to) takes its default when let go inside 110 px (actionDistance) and
//   a range from its list by how far out the pointer is, 110 to 300 px (RadialMenuRangeAction.MoveMouse);
// - the "more" slice opens a second ring, its options placed either side of it in turn (alternate).

import { clientTexture } from "./window.ts";

export interface RadialOption {
  label: string;
  icon: string;
  run?: (range?: number) => void;
  disabled?: boolean;
  /** A range action's list (metres) and the range it takes when let go near the middle. */
  ranges?: readonly number[];
  defaultRange?: number;
  /** Opens a second ring of these. */
  more?: readonly (RadialOption | null)[];
}

const TEX = (name: string) => clientTexture(`res:/UI/Texture/classes/RadialMenu/${name}`);
export const RADIAL_ICON = (path: string) => clientTexture(path);

const SIZE = 220, ACTION_DISTANCE = 110, MAX_RANGE_DISTANCE = 300, STEP = 45;

/** spaceRadialMenuFunctions.GetRanges: from min to max, in steps that widen with the distance. */
export function radialRanges(min: number, max: number): number[] {
  const out: number[] = [];
  for (let v = min; v <= max; ) {
    out.push(v);
    v += v < 500 ? 150 : v < 5000 ? 250 : v < 8000 ? 500 : v < 30000 ? 1000 : 5000;
  }
  return out;
}
/** movementFunctions.GetWarpToRanges with minWarpEndDistance 0 and maxWarpEndDistance 100 km. */
export const WARP_RANGES = [0, 10_000, 20_000, 30_000, 50_000, 70_000, 100_000] as const;

/** RadialMenuRangeAction.MoveMouse: the range at `length` px from the middle; the default inside actionDistance. */
export function rangeAt(option: RadialOption, length: number): number | undefined {
  const list = option.ranges;
  if (!list?.length) return undefined;
  if (length < ACTION_DISTANCE) return option.defaultRange ?? list[0];
  const each = (MAX_RANGE_DISTANCE - ACTION_DISTANCE) / list.length;
  const into = length - ACTION_DISTANCE;
  for (let i = 0; i < list.length; i++) {
    if (into > i * each) continue;
    if (i === 0) return list[0];
    const share = (into - each * (i - 1)) / each;
    return share * (list[i]! - list[i - 1]!) + list[i - 1]!;
  }
  return list[list.length - 1];
}

/** FindOptionsDegree: the degree of the n-th option, straight round or either side of a start in turn. */
function optionDegree(n: number, start = 0, alternate = false): number {
  if (n === 0) return start;
  if (!alternate) return n * STEP;
  const right = n % 2 === 1;
  const steps = Math.floor(n / 2) + (right ? 1 : 0);
  return (((start + (right ? steps * STEP : -steps * STEP)) % 360) + 360) % 360;
}

function metres(m: number): string {
  return m >= 10_000 ? `${Math.round(m / 1000).toLocaleString()} km` : `${Math.round(m).toLocaleString()} m`;
}

export class RadialMenu {
  readonly root = document.createElement("div");
  private readonly label = document.createElement("div");
  private slots: { option: RadialOption | null; degree: number; el: HTMLDivElement }[] = [];
  private hovered: number | null = null;
  private cx = 0;
  private cy = 0;
  private range: number | undefined;
  private onClose: (() => void) | null = null;
  /** The second ring is up. */
  private second = false;

  constructor() {
    this.root.className = "radial";
    this.root.style.display = "none";
    this.label.className = "radial-label";
    this.root.innerHTML = `<div class="radial-shadow" style="--tex:url(${TEX("menuShadow2.png")})"></div>`;
    this.root.appendChild(this.label);
    addEventListener("pointermove", (e) => this.move(e.clientX, e.clientY));
    addEventListener("pointerup", (e) => { if (this.isOpen && e.button === this.button) this.release(e.clientX, e.clientY); });
    addEventListener("pointerdown", (e) => { if (this.isOpen && !this.root.contains(e.target as Node)) this.close(); }, true);
    addEventListener("keydown", (e) => { if (e.key === "Escape" && this.isOpen) this.close(); });
    this.root.addEventListener("contextmenu", (e) => e.preventDefault());
    this.root.addEventListener("click", (e) => { e.stopPropagation(); this.release(e.clientX, e.clientY, true); });
  }

  get isOpen(): boolean { return this.root.style.display !== "none"; }
  private button = 0;
  private openedAt = 0;

  /** Open at (x, y) with up to eight options (null for an empty slice), titled `title`; `button` is the one held. */
  open(x: number, y: number, title: string, options: readonly (RadialOption | null)[], button = 0, onClose?: () => void): void {
    this.cx = Math.max(SIZE / 2, Math.min(innerWidth - SIZE / 2, x));
    this.cy = Math.max(SIZE / 2 + 30, Math.min(innerHeight - SIZE / 2, y));
    this.button = button;
    this.openedAt = performance.now();
    this.onClose = onClose ?? null;
    this.root.style.left = `${this.cx - SIZE / 2}px`;
    this.root.style.top = `${this.cy - SIZE / 2}px`;
    this.root.style.display = "";
    this.root.dataset.title = title;
    this.second = false;
    this.lay(options.slice(0, 8), 0, false);
    this.say(title);
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.style.display = "none";
    for (const s of this.slots) s.el.remove();
    this.slots = [];
    this.hovered = null;
    const done = this.onClose;
    this.onClose = null;
    done?.();
  }

  private lay(options: readonly (RadialOption | null)[], start: number, alternate: boolean): void {
    for (const s of this.slots) s.el.remove();
    this.slots = [];
    const count = alternate ? options.length : 8;
    for (let i = 0; i < count; i++) {
      const option = options[i] ?? null;
      const degree = optionDegree(i, start, alternate);
      const el = document.createElement("div");
      el.className = `radial-slot${option ? "" : " empty"}${option?.disabled ? " disabled" : ""}`;
      el.style.transform = `rotate(${degree}deg)`;
      el.innerHTML = `<div class="radial-slice" style="--tex:url(${TEX(option ? "slice_45.png" : "emptySlice_45.png")})"></div>
        <div class="radial-hilite" style="--tex:url(${TEX("mouseOver_45.png")})"></div>
        ${option?.ranges ? `<div class="radial-arrow" style="--tex:url(${TEX("rangeArrow.png")})"></div>` : ""}
        ${option ? `<img class="radial-icon" alt="" src="${option.more ? TEX("plus.png") : option.icon}" style="transform: rotate(${-degree}deg)">` : ""}`;
      this.root.appendChild(el);
      this.slots.push({ option, degree, el });
    }
  }

  private say(text: string): void { this.label.textContent = text; }

  /** The slice the pointer's angle falls in (FindMyButton), and how far out it is. */
  private aim(x: number, y: number): { index: number | null; length: number } {
    const dx = x - this.cx, dy = y - this.cy;
    const length = Math.hypot(dx, dy);
    if (length < 30) return { index: null, length };
    let degree = (Math.atan2(dx, -dy) * 180) / Math.PI;
    if (degree < 0) degree += 360;
    let best: number | null = null, bestGap = Infinity;
    this.slots.forEach((s, i) => {
      const gap = Math.abs(((degree - s.degree + 540) % 360) - 180);
      if (gap <= STEP / 2 && gap < bestGap) { best = i; bestGap = gap; }
    });
    return { index: best, length };
  }

  private move(x: number, y: number): void {
    if (!this.isOpen) return;
    const { index, length } = this.aim(x, y);
    if (index !== this.hovered) {
      if (this.hovered !== null) this.slots[this.hovered]?.el.classList.remove("hover");
      this.hovered = index;
      if (index !== null) this.slots[index]?.el.classList.add("hover");
    }
    const option = index === null ? null : this.slots[index]?.option ?? null;
    this.range = option && !option.disabled ? rangeAt(option, length) : undefined;
    this.say(option ? (this.range !== undefined ? `${option.label} ${metres(this.range)}` : option.label) : this.root.dataset.title ?? "");
    // The second ring opens as the pointer comes onto "more" (the client loads it on mouse-over).
    if (option?.more && !option.disabled && !this.second) {
      this.second = true;
      this.lay(option.more, this.slots[index!]!.degree, true);
      this.hovered = null;
    }
  }

  private release(x: number, y: number, click = false): void {
    const { index, length } = this.aim(x, y);
    // Let go in the middle soon after opening: the menu stays for a click.
    if (index === null) { if (!click && performance.now() - this.openedAt < 150) return; if (click) this.close(); return; }
    const option = this.slots[index]?.option ?? null;
    if (!option || option.disabled || option.more || !option.run) { if (click) this.close(); return; }
    const range = option.ranges ? rangeAt(option, length) : undefined;
    this.close();
    option.run(range === undefined ? undefined : Math.round(range));
  }
}

/** The menu's look: the client's textures masked over its colours. */
export const RADIAL_CSS = `
.radial { position: fixed; width: ${SIZE}px; height: ${SIZE}px; z-index: 60; pointer-events: auto; user-select: none; }
.radial-shadow { position: absolute; left: -18px; top: -18px; width: 256px; height: 256px; background: rgba(0,0,0,0.75);
  -webkit-mask: var(--tex) center / 100% 100% no-repeat; mask: var(--tex) center / 100% 100% no-repeat; pointer-events: none; }
.radial-slot { position: absolute; left: ${(SIZE - 100) / 2}px; top: 0; width: 100px; height: ${SIZE}px; transform-origin: 50% 50%; pointer-events: none; }
.radial-slot > div { position: absolute; left: 0; top: 0; width: 100px; height: 70px;
  -webkit-mask: var(--tex) center / 100% 100% no-repeat; mask: var(--tex) center / 100% 100% no-repeat; }
.radial-slice { background: rgba(28, 33, 38, 0.82); }
.radial-slot.empty .radial-slice { background: rgba(160, 170, 180, 0.35); }
.radial-hilite { background: rgba(170, 210, 240, 0.0); transition: background 0.12s; }
.radial-slot.hover:not(.disabled):not(.empty) .radial-hilite { background: rgba(170, 210, 240, 0.55); }
.radial-arrow { left: 41px !important; top: 1px !important; width: 18px !important; height: 12px !important; background: rgba(255,255,255,0.9); }
.radial-slot.disabled .radial-arrow { background: rgba(255,255,255,0.35); }
.radial-icon { position: absolute; left: 34px; top: 22px; width: 32px; height: 32px; }
.radial-slot.disabled .radial-icon { opacity: 0.4; }
.radial-label { position: absolute; left: 50%; bottom: calc(100% + 6px); transform: translateX(-50%); white-space: nowrap;
  padding: 4px 14px; font: 600 12px/1.2 "Segoe UI", system-ui, sans-serif; color: #e8edf2; letter-spacing: 0.02em;
  background: radial-gradient(ellipse at center, rgba(0,0,0,0.75) 40%, rgba(0,0,0,0) 75%); text-shadow: 0 1px 2px #000; pointer-events: none; }
`;

/**
 * The radial menu's opening on `target` (radialMenuSvc.TryExpandActionMenu): the left button held 150 ms without the
 * pointer moving 12 px, or the right button. `idOf` says which object the pointer is on (null for none).
 */
export function holdToOpen(target: HTMLElement, idOf: (x: number, y: number, e: Event) => number | null, open: (id: number, x: number, y: number, button: number) => void): () => void {
  let held: { id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
  const cancel = () => { if (held) clearTimeout(held.timer); held = null; };
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    cancel();
    const id = idOf(e.clientX, e.clientY, e);
    if (id === null) return;
    const x = e.clientX, y = e.clientY;
    held = { id, x, y, timer: setTimeout(() => { const h = held; held = null; if (h) open(h.id, h.x, h.y, 0); }, 150) };
  };
  const move = (e: PointerEvent) => { if (held && Math.hypot(e.clientX - held.x, e.clientY - held.y) > 12) cancel(); };
  const menu = (e: MouseEvent) => {
    const id = idOf(e.clientX, e.clientY, e);
    if (id === null) return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
    open(id, e.clientX, e.clientY, 2);
  };
  target.addEventListener("pointerdown", down);
  addEventListener("pointermove", move);
  addEventListener("pointerup", cancel);
  target.addEventListener("contextmenu", menu);
  return () => {
    cancel();
    target.removeEventListener("pointerdown", down);
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", cancel);
    target.removeEventListener("contextmenu", menu);
  };
}
