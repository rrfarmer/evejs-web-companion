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
import { playUiEvent } from "./uiAudio.ts";
import { radialDelay, radialDomButton } from "./radialSettings.ts";

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
/** RMO_SizeInfo: buttonHeight 70, buttonPaddingTop 12, buttonPaddingBottom 6. */
const BUTTON_HEIGHT = 70, BUTTON_PADDING_TOP = 12, BUTTON_PADDING_BOTTOM = 6;

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

/**
 * RadialMenuRangeAction.MoveMouse's percOfAllRange: how far along its list the range is, 0 to 1 - null inside
 * actionDistance (the default range, no circle), 0 on the first step, 1 past the last.
 */
export function rangeShareAt(option: RadialOption, length: number): number | null {
  const list = option.ranges;
  if (!list?.length || length < ACTION_DISTANCE - BUTTON_PADDING_TOP) return null;
  const each = (MAX_RANGE_DISTANCE - ACTION_DISTANCE) / list.length;
  const into = length - ACTION_DISTANCE;
  for (let i = 0; i < list.length; i++) {
    if (into > i * each) continue;
    if (i === 0) return 0;
    return list.length > 1 ? (i - 1 + (into - each * (i - 1)) / each) / (list.length - 1) : 1;
  }
  return 1;
}

/** RadialMenuRangeAction.MoveMouse: the range at `length` px from the middle; the default inside actionDistance. */
export function rangeAt(option: RadialOption, length: number): number | undefined {
  const list = option.ranges;
  if (!list?.length) return undefined;
  if (length < ACTION_DISTANCE - BUTTON_PADDING_TOP) return option.defaultRange ?? list[0];
  const each = (MAX_RANGE_DISTANCE - ACTION_DISTANCE) / list.length;
  const into = length - ACTION_DISTANCE;
  for (let i = 0; i < list.length; i++) {
    if (into > i * each) continue;
    if (i === 0) return list[0];
    // RadialMenuSpace.default_usePreciseRanges False: the step's own range (previousStepDistance), not one between
    return list[i - 1]!;
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
  /**
   * AddOptionText: the hovered option's name (EveLabelLarge, bold, CENTER top -10) and its range (EveLabelLarge, top 6)
   * in the middle, over labelShadow - a ThreePartContainer (textShadowLeft / Center / Right, sides 24, black 0.5) the
   * text's width plus the sides, the name's height + 4 at top -10, or both lines' + 4 centred with a range
   */
  private readonly optionBox = document.createElement("div");
  private readonly optionName = document.createElement("div");
  private readonly optionRange = document.createElement("div");
  private slots: { option: RadialOption | null; degree: number; el: HTMLDivElement }[] = [];
  /** firstLayerCont's slices: kept under the second layer (at 0.3) while it is expanded. */
  private firstSlots: { option: RadialOption | null; degree: number; el: HTMLDivElement }[] = [];
  private hovered: number | null = null;
  private cx = 0;
  private cy = 0;
  private range: number | undefined;
  /**
   * RangeCircle (rangeSize 128, centred, over the slices): rangeShadow (1, 1, 1, 0.4) and the ring masks rangeMaskL / R
   * through the half-filled gaugeFill turned by the range's share - the ring lit clockwise from the hovered option's
   * direction (rotation -degree) over percOfAllRange of the turn, in COLORTYPE_UIHILIGHTGLOW (read live: 0.8, 0.9534,
   * 1.0) at 0.5; hidden inside actionDistance
   */
  private readonly rangeCanvas = document.createElement("canvas");
  private readonly rangeImages = ["rangeShadow.png", "rangeMaskL.png", "rangeMaskR.png"].map((n) => { const i = new Image(); i.src = TEX(n); return i; });
  private drawRange(share: number | null, degree: number): void {
    const c = this.rangeCanvas;
    c.style.display = share === null ? "none" : "";
    if (share === null) return;
    const dpr = Math.max(1, Math.min(2, devicePixelRatio || 1));
    if (c.width !== 128 * dpr) { c.width = c.height = 128 * dpr; }
    const x = c.getContext("2d")!;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, 128, 128);
    const [shadow, maskL, maskR] = this.rangeImages as [HTMLImageElement, HTMLImageElement, HTMLImageElement];
    if (shadow.complete) { x.globalAlpha = 0.4; x.drawImage(shadow, 0, 0, 128, 128); }
    if (share <= 0 || !maskL.complete || !maskR.complete) return;
    x.save();
    x.globalAlpha = 0.5;
    const from = ((degree - 90) * Math.PI) / 180;
    x.beginPath();
    x.moveTo(64, 64);
    x.arc(64, 64, 64, from, from + Math.PI * 2 * Math.min(1, share));
    x.closePath();
    x.clip();
    // the masks are a half ring each in the frame of the circle turned to the option
    x.translate(64, 64);
    x.rotate((degree * Math.PI) / 180);
    x.translate(-64, -64);
    x.drawImage(maskL, 0, 0, 128, 128);
    x.drawImage(maskR, 0, 0, 128, 128);
    x.globalCompositeOperation = "source-atop";
    x.globalAlpha = 1;
    x.fillStyle = "rgb(204, 243, 255)";
    x.fillRect(0, 0, 128, 128);
    x.restore();
  }
  private onClose: (() => void) | null = null;
  /** The second ring is up. */
  private second = false;

  constructor() {
    this.root.className = "radial";
    this.root.style.display = "none";
    this.label.className = "radial-label";
    this.root.innerHTML = `<div class="radial-shadow" style="--tex:url(${TEX("menuShadow2.png")})"></div>`;
    this.root.appendChild(this.label);
    this.optionBox.className = "radial-option-shadow";
    this.optionName.className = "radial-option-name";
    this.optionRange.className = "radial-option-range";
    this.root.append(this.optionBox, this.optionName, this.optionRange);
    this.rangeCanvas.className = "radial-range";
    this.rangeCanvas.style.display = "none";
    this.root.appendChild(this.rangeCanvas);
    // _OnGlobalMove: a move within 25 ms (250,000 x 100 ns) of the last one taken is dropped, nothing made of it later
    addEventListener("pointermove", (e) => {
      const now = performance.now();
      if (now - this.lastMoveAt < 25) return;
      this.lastMoveAt = now;
      this.move(e.clientX, e.clientY);
    });
    addEventListener("pointerup", (e) => { if (this.isOpen && e.button === (this.button === RADIAL_BY_RIGHT ? 2 : this.button)) this.release(e.clientX, e.clientY); });
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
    this.rangeHeld = this.lastLength = this.lastY = null;
    this.drawRange(null, 0);
    this.lay(options.slice(0, 8), 0, false);
    // RadialMenuSpace.LoadMyActions(animate) -> AnimateMenuFromCenter(duration 0.1): each slice from half its size and
    // half opacity, the shadow from half size and half opacity (to 1.3, shown as 1), ANIM_SMOOTH
    for (const s of this.slots) s.el.animate([{ transform: `rotate(${s.degree}deg) scale(0.5)`, opacity: 0.5 }, { transform: `rotate(${s.degree}deg) scale(1)`, opacity: 1 }], { duration: 100, easing: "cubic-bezier(0.3333, 0, 0.6667, 1)" });
    this.root.querySelector<HTMLElement>(".radial-shadow")?.animate([{ transform: "scale(0.5)", opacity: 0.5 }, { transform: "scale(1)", opacity: 1 }], { duration: 100, easing: "cubic-bezier(0.3333, 0, 0.6667, 1)" });
    this.say(title);
    this.sayOption(null, null);
    // RadialMenu.ApplyAttributes: ui_radial_open_play
    void playUiEvent("ui_radial_open_play");
  }

  close(): void {
    if (!this.isOpen) return;
    if (this.closeTimer !== null) { clearTimeout(this.closeTimer); this.closeTimer = null; }
    this.closing = false;
    this.root.style.pointerEvents = "";
    for (const a of this.root.querySelector<HTMLElement>(".radial-shadow")?.getAnimations() ?? []) a.cancel();
    for (const a of this.rangeCanvas.getAnimations()) a.cancel();
    // RadialMenu._OnClose: ui_radial_close
    void playUiEvent("ui_radial_close");
    this.root.style.display = "none";
    for (const s of new Set([...this.slots, ...this.firstSlots])) s.el.remove();
    this.slots = [];
    this.firstSlots = [];
    this.hovered = null;
    const done = this.onClose;
    this.onClose = null;
    done?.();
  }

  private lay(options: readonly (RadialOption | null)[], start: number, alternate: boolean): void {
    // UpdateSecondLevel: firstLayerCont.SetOpacity(0.3) and the second layer laid over it; a first layer replaces both
    if (alternate) { for (const s of this.slots) if (!this.firstSlots.includes(s)) s.el.remove(); for (const s of this.firstSlots) { s.el.style.opacity = "0.3"; s.el.classList.remove("hover"); } }
    else { for (const s of new Set([...this.slots, ...this.firstSlots])) s.el.remove(); this.firstSlots = []; }
    this.slots = [];
    const count = alternate ? options.length : 8;
    for (let i = 0; i < count; i++) {
      const option = options[i] ?? null;
      const degree = optionDegree(i, start, alternate);
      const el = document.createElement("div");
      el.className = `radial-slot${option ? "" : " empty"}${option?.disabled ? " disabled" : ""}`;
      el.style.transform = `rotate(${degree}deg)`;
      el.innerHTML = `<div class="radial-slice" style="--tex:url(${TEX(option ? "slice_45.png" : "emptySlice_45.png")}); --sel:url(${TEX("selected_45.png")})"></div>
        <div class="radial-hilite" style="--tex:url(${TEX("mouseOver_45.png")})"></div>
        ${option?.ranges ? `<div class="radial-arrow" style="--tex:url(${TEX("rangeArrow.png")})"></div>` : ""}
        ${option ? `<img class="radial-icon" alt="" src="${option.more ? option.icon || TEX("plus.png") : option.icon}" style="transform: rotate(${-degree}deg)">` : ""}`;
      this.root.appendChild(el);
      this.slots.push({ option, degree, el });
      // RadialMenuLayer.AnimateButtonsIn: each second-level slice turned out from the opening slice's degree to its own
      // over 0.25 s (the far way round taken as negative), ANIM_SMOOTH
      if (alternate) {
        const to = degree > 180 + start ? degree - 360 : degree;
        el.animate([{ transform: `rotate(${start}deg)` }, { transform: `rotate(${to}deg)` }], { duration: 250, easing: "cubic-bezier(0.3333, 0, 0.6667, 1)" });
      }
    }
    if (!alternate) this.firstSlots = this.slots;
  }

  /** The displayLabel: the object's name at the top (AddDisplayLabel). */
  private say(text: string): void { this.label.textContent = text; }

  /** SetOptionText / SetOptionRangeText / ClearOptionText and AdjustTextShadow. */
  private sayOption(name: string | null, range: string | null): void {
    this.optionName.textContent = name ?? "";
    this.optionRange.textContent = range ?? "";
    this.optionName.hidden = this.optionBox.hidden = !name;
    this.optionRange.hidden = !name || !range;
    if (!name) return;
    const width = Math.max(this.optionName.offsetWidth, range ? this.optionRange.offsetWidth : 0);
    const height = range ? 21 + 21 + 4 : 21 + 4;
    Object.assign(this.optionBox.style, { width: `${width + 48}px`, height: `${height}px`, top: `${SIZE / 2 + (range ? 0 : -10) - height / 2}px` });
  }

  /** The slice the pointer's angle falls in (FindMyButton), and how far out it is. */
  private aim(x: number, y: number): { index: number | null; length: number } {
    const dx = x - this.cx, dy = y - this.cy;
    const length = Math.hypot(dx, dy);
    // _OnGlobalMove: nearer the middle than actionDistance - buttonHeight + buttonPaddingBottom (46) is ResetFromCenter
    if (length < ACTION_DISTANCE - BUTTON_HEIGHT + BUTTON_PADDING_BOTTOM) return { index: null, length };
    let degree = (Math.atan2(dx, -dy) * 180) / Math.PI;
    if (degree < 0) degree += 360;
    let best: number | null = null, bestGap = Infinity;
    this.slots.forEach((s, i) => {
      const gap = Math.abs(((degree - s.degree + 540) % 360) - 180);
      if (gap <= STEP / 2 && gap < bestGap) { best = i; bestGap = gap; }
    });
    return { index: best, length };
  }

  /** RadialMenu.selectedBtn while it is a range option, and its RadialMenuRangeAction.lastLength. */
  private rangeHeld: number | null = null;
  private lastLength: number | null = null;
  private lastY: number | null = null;
  private lastMoveAt = -Infinity;

  private move(x: number, y: number): void {
    if (!this.isOpen || this.closing) return;
    const dyMove = this.lastY === null ? 0 : y - this.lastY;
    this.lastY = y;
    let { index, length } = this.aim(x, y);
    // ResetFromCenter (nearer the middle than 46): the second layer hidden, the first back at full opacity
    if (this.second && index === null && length < ACTION_DISTANCE - BUTTON_HEIGHT + BUTTON_PADDING_BOTTOM) {
      for (const s of this.slots) if (!this.firstSlots.includes(s)) s.el.remove();
      for (const s of this.firstSlots) s.el.style.opacity = "";
      this.slots = this.firstSlots;
      this.second = false;
      this.hovered = null;
      this.rangeHeld = null;
    }
    // _OnGlobalMove: a range option selected stays the one while the pointer is past its minRangeDistance (110), whatever
    // the angle
    if (this.rangeHeld !== null && this.slots[this.rangeHeld]?.option?.ranges && Math.hypot(x - this.cx, y - this.cy) > ACTION_DISTANCE) index = this.rangeHeld;
    const held = index === null ? null : this.slots[index]!;
    if (held?.option?.ranges && !held.option.disabled) {
      // RadialMenuRangeAction.FindLengthToUse (past the default's reach): off the option's slice the length follows the
      // pointer's vertical move - more by going down for an option in the lower half (90 < degree < 270), else up
      if (length >= ACTION_DISTANCE - BUTTON_PADDING_TOP) {
        const into0 = length - ACTION_DISTANCE;
        if (this.lastLength === null) this.lastLength = into0;
        let into = into0;
        const deg = (Math.atan2(x - this.cx, -(y - this.cy)) * 180) / Math.PI;
        const gap = Math.abs((((deg + 360) % 360) - held.degree + 540) % 360 - 180);
        if (gap >= STEP / 2) into = this.lastLength + (held.degree > 90 && held.degree < 270 ? dyMove : -dyMove);
        into = Math.max(0, into);
        this.lastLength = into;
        length = into + ACTION_DISTANCE;
      }
      this.rangeHeld = index;
    } else { this.rangeHeld = null; this.lastLength = null; }
    if (index !== this.hovered) {
      if (this.hovered !== null) this.slots[this.hovered]?.el.classList.remove("hover");
      this.hovered = index;
      // RadialMenuActionBase.ShowButtonHilite (every slice, disabled and empty too, as it lights): ui_radial_mouseover_play
      if (index !== null) { this.slots[index]?.el.classList.add("hover"); void playUiEvent("ui_radial_mouseover_play"); }
    }
    const option = index === null ? null : this.slots[index]?.option ?? null;
    this.range = option && !option.disabled ? rangeAt(option, length) : undefined;
    // RadialMenu.MoveMouseRangeAction -> SetRangeCircle(buttonCont.degree, percOfAllRange)
    this.drawRange(option && !option.disabled ? rangeShareAt(option, length) : null, index === null ? 0 : this.slots[index]!.degree);
    this.sayOption(option ? option.label : null, option && this.range !== undefined ? metres(this.range) : null);
    // The second ring opens as the pointer comes onto "more" (the client loads it on mouse-over).
    if (option?.more && !option.disabled && !this.second) {
      this.second = true;
      // GetObjectsSecondaryActions: the second level starts with SecondLevelRadialMenuAction(hasExtraOptions False) - a
      // disabled plus.png slice over the opening one
      this.lay([{ label: "", icon: TEX("plus.png"), disabled: true }, ...option.more], this.slots[index!]!.degree, true);
      // MoveMouseSecondLevel: the second level loaded - ui_radial_expand_play
      void playUiEvent("ui_radial_expand_play");
      this.hovered = null;
    }
  }

  /** RunClosingAnimation_thread running (isClosing): moves and releases ignored until it closes. */
  private closing = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  private release(x: number, y: number, click = false): void {
    if (this.closing) return;
    // OnMouseUp acts on the selected button and its range as the last move left them
    this.move(x, y);
    const index = this.hovered;
    // Let go in the middle soon after opening: the menu stays for a click.
    if (index === null) { if (!click && performance.now() - this.openedAt < 150) return; if (click) this.close(); return; }
    const option = this.slots[index]?.option ?? null;
    if (!option || option.disabled || option.more || !option.run) { if (click) this.close(); return; }
    const range = option.ranges ? this.range : undefined;
    // RadialMenu.ClickButton: ui_radial_select_play, then the menu closes
    void playUiEvent("ui_radial_select_play");
    option.run(range === undefined ? undefined : Math.round(range));
    // RunClosingAnimation_thread (0.5 s): the other slices AnimateFromCenter(grow False) to half size and nothing over
    // 0.25 s; the taken one's SelectButtonSlice - its selection slice shown, moved out 10 (top 0 -> -10 by the half,
    // then held), its opacity blinking (0.5: as it was, 0.6: 1.5, 0.7: 0.5, 0.8: 1.5, 1: 0) - then Close
    this.closing = true;
    this.root.style.pointerEvents = "none";
    this.slots.forEach((s, i) => {
      if (i === index) {
        s.el.classList.add("selected");
        s.el.animate([{ transform: `rotate(${s.degree}deg) translateY(0)`, offset: 0 }, { transform: `rotate(${s.degree}deg) translateY(-10px)`, offset: 0.5 }, { transform: `rotate(${s.degree}deg) translateY(-10px)`, offset: 1 }], { duration: 500, fill: "forwards" });
        s.el.animate([{ opacity: 1, offset: 0 }, { opacity: 1, offset: 0.5 }, { opacity: 1, offset: 0.6 }, { opacity: 0.5, offset: 0.7 }, { opacity: 1, offset: 0.8 }, { opacity: 0, offset: 1 }], { duration: 500, fill: "forwards" });
      } else s.el.animate([{ transform: `rotate(${s.degree}deg) scale(1)`, opacity: 1 }, { transform: `rotate(${s.degree}deg) scale(0.5)`, opacity: 0 }], { duration: 250, easing: "cubic-bezier(0.3333, 0, 0.6667, 1)", fill: "forwards" });
    });
    if (this.second) for (const s of this.firstSlots) s.el.animate([{ transform: `rotate(${s.degree}deg) scale(1)`, opacity: 0.3 }, { transform: `rotate(${s.degree}deg) scale(0.5)`, opacity: 0 }], { duration: 250, easing: "cubic-bezier(0.3333, 0, 0.6667, 1)", fill: "forwards" });
    this.root.querySelector<HTMLElement>(".radial-shadow")?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, easing: "cubic-bezier(0.3333, 0, 0.6667, 1)", fill: "forwards" });
    // rangeCont.AnimateFromCenter(grow False, opacityRatio 0): the range circle (CleanUp leaves it shown) from its opacity
    // to nothing over the same 0.25 s
    this.rangeCanvas.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, easing: "cubic-bezier(0.3333, 0, 0.6667, 1)", fill: "forwards" });
    this.closeTimer = setTimeout(() => this.close(), 500);
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
/* SelectButtonSlice -> ShowSelectionSlice: the slice's own texture swapped for selected_45 (opacity 0.9) */
.radial-slot.selected .radial-slice { -webkit-mask-image: var(--sel); mask-image: var(--sel); background: rgba(170, 210, 240, 0.9); }
.radial-slot.hover:not(.disabled):not(.empty) .radial-hilite { background: rgba(170, 210, 240, 0.55); }
.radial-arrow { left: 41px !important; top: 1px !important; width: 18px !important; height: 12px !important; background: rgba(255,255,255,0.9); }
.radial-slot.disabled .radial-arrow { background: rgba(255,255,255,0.35); }
.radial-icon { position: absolute; left: 34px; top: 22px; width: 32px; height: 32px; }
.radial-slot.disabled .radial-icon { opacity: 0.4; }
.radial-range { position: absolute; left: ${(SIZE - 128) / 2}px; top: ${(SIZE - 128) / 2}px; width: 128px; height: 128px; z-index: 2; pointer-events: none; }
/* AddDisplayLabel: EveLabelLarge (16, 21 high) CENTERTOP at -18 over a ThreePartContainer (textShadow*, sides 24, black 0.5) its
   width plus the sides, its height + 2 */
.radial-label, .radial-option-shadow { --shadow-mask: url(${TEX("textShadowLeft.png")}) left / 24px 100% no-repeat, url(${TEX("textShadowCenter.png")}) center / calc(100% - 48px) 100% no-repeat, url(${TEX("textShadowRight.png")}) right / 24px 100% no-repeat; }
.radial-label { position: absolute; left: 50%; top: -18px; transform: translateX(-50%); white-space: nowrap; padding: 0 24px; height: 23px; box-sizing: border-box;
  font: 16px/21px "EVE Sans Neue", "Segoe UI", system-ui, sans-serif; color: #fff; pointer-events: none; isolation: isolate; }
.radial-label::before { content: ""; position: absolute; inset: 0; z-index: -1; background: rgba(0,0,0,0.5); -webkit-mask: var(--shadow-mask); mask: var(--shadow-mask); }
.radial-option-shadow { position: absolute; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.5); -webkit-mask: var(--shadow-mask); mask: var(--shadow-mask); pointer-events: none; z-index: 3; }
.radial-option-name, .radial-option-range { position: absolute; left: 50%; transform: translateX(-50%); white-space: nowrap; font: 16px/21px "EVE Sans Neue", "Segoe UI", system-ui, sans-serif; color: #fff; pointer-events: none; z-index: 4; }
.radial-option-name { top: ${SIZE / 2 - 10 - 10.5}px; font-weight: 700; }
.radial-option-range { top: ${SIZE / 2 + 6 - 10.5}px; }
.radial-option-shadow[hidden], .radial-option-name[hidden], .radial-option-range[hidden] { display: none; }
`;

/**
 * The radial menu's opening on `target` (radialMenuSvc.TryExpandActionMenu): the left button held 150 ms without the
 * pointer moving 12 px, or the right button. `idOf` says which object the pointer is on (null for none).
 */
/** The button a right-button radial is opened with (2 is the context menu's). */
export const RADIAL_BY_RIGHT = -2;
export function holdToOpen(target: HTMLElement, idOf: (x: number, y: number, e: Event) => number | null, open: (id: number, x: number, y: number, button: number) => void, rightClick = true,
  noDelay: () => boolean = () => false): () => void {
  let held: { id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** A right-button radial opened by the hold: the context menu its release brings is not opened. */
  let radialByRight = false;
  const cancel = () => { if (held) clearTimeout(held.timer); held = null; };
  const down = (e: PointerEvent) => {
    // radialMenuSvc.TryExpandActionMenu: the button of Open Radial Menu With (actionmenuBtn), not with Alt or Ctrl
    // held, after Radial Menu Delay (actionMenuExpandTime; none at 0)
    radialByRight = false;
    const button = radialDomButton();
    if (e.button !== button || e.altKey || e.ctrlKey) return;
    cancel();
    const id = idOf(e.clientX, e.clientY, e);
    if (id === null) return;
    const x = e.clientX, y = e.clientY;
    const fire = (i: number) => { radialByRight = button === 2; open(i, x, y, button === 2 ? RADIAL_BY_RIGHT : button); };
    // CmdOpenRadialMenu loaded (radialMenuSvc: noDelay): opened at the press
    const delay = radialDelay();
    if (noDelay() || delay === 0) { e.preventDefault(); fire(id); return; }
    held = { id, x, y, timer: setTimeout(() => { const h = held; held = null; if (h) fire(h.id); }, delay) };
  };
  const move = (e: PointerEvent) => { if (held && Math.hypot(e.clientX - held.x, e.clientY - held.y) > 12) cancel(); };
  const menu = (e: MouseEvent) => {
    const id = idOf(e.clientX, e.clientY, e);
    if (id === null) return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
    if (radialByRight) { radialByRight = false; return; }
    open(id, e.clientX, e.clientY, 2);
  };
  target.addEventListener("pointerdown", down);
  addEventListener("pointermove", move);
  addEventListener("pointerup", cancel);
  if (rightClick) target.addEventListener("contextmenu", menu);
  return () => {
    cancel();
    target.removeEventListener("pointerdown", down);
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", cancel);
    target.removeEventListener("contextmenu", menu);
  };
}
