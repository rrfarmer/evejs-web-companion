// The target bar: the retail client's locked targets, ported from its own Python and drawn with its own textures
// (served by the BFF at /client-res). Sizes are the client's pixels at its default UI scale of 1.0.
//
// What comes from where (eve/client/script/):
//   parklife/targetMgr.py   where the bar goes and how targets are laid out: the anchor ("origin") taken from the
//                           Selected Item window (GetOriginPosition: its left - 15 and top when it sits right of the
//                           middle), rows of 110 px targets (MAX_TARGET_WIDTH) running away from the anchor
//                           (PrepareRowsOrColumns, alignHorizontally = 1: rows TOTOP, targets TORIGHT for an anchor
//                           right of the middle), a new target appended to the end of the first row it fits in
//                           (FindRow, DoesTargetFit), so it lands furthest from the anchor; a row as tall as its
//                           tallest target (at least MIN_TARGET_HEIHT 170) plus TARGET_PADDING 10 (AdjustRowSize).
//   ui/inflight/bracketsAndTargets/targetInBar.py
//                           TargetInBar: the 100 px barAndImageCont with the 94 px icon container, the 50 px type
//                           icon modulated by shipMask.png, the health bars, outerCircle.png (white 0.5 active, 0.25
//                           not), the container's opacity (1.0 active, 0.8 not), the hover underlay; the labels
//                           (EveLabelSmall, centred, the name broken at the last space that fits, the ship type for
//                           a player's ship, the distance as FmtDist gives it); a click selects and makes it active.
//                           TargetHealthBars: per layer a left and a right half modulated by gaugeColor.png, turned
//                           as SetDamage turns them, a change run linearly over max(0.1, 0.4 * |change|) s;
//                           targetBackground(NoShield).png under them; damage read every 750-1000 ms.
//   ui/inflight/bracketsAndTargets/activeTargetIndicator.py
//                           ActiveTargetIndicator: spinCorners.png turning once in 3.5 s and pulsing 0.2-0.5 over 3 s,
//                           selectedTargetedItem.png at 0.15. TargetedIndicator's targeting parts (the in-space
//                           bracket's, not the bar's: a target being locked is not in the bar): spinCorners.png
//                           shrinking from 120 to 0 px every 0.33 s, timerLeft/Right.png counting the lock down, the
//                           seconds left, then "Target Locked" blinking (inSpaceBracket.CountDown).
//
// Rotation sign, as in shipHud.ts: the client's sprite and secondary-texture rotations turn counter-clockwise on
// screen, CSS and canvas clockwise. In carbonui the first child is drawn on top; the DOM order here is reversed.

const res = (path: string): string => `/client-res/${path.replace(/^res:\//i, "").toLowerCase()}`;
const T = "res:/UI/Texture/classes/Target/";
const TEX = {
  underlay: res(`${T}targetUnderlay.png`),
  outerCircle: res(`${T}outerCircle.png`),
  shipMask: res(`${T}shipMask.png`),
  gaugeColor: res(`${T}gaugeColor.png`),
  background: res(`${T}targetBackground.png`),
  backgroundNoShield: res(`${T}targetBackgroundNoShield.png`),
  bars: [
    [res(`${T}shieldLeft.png`), res(`${T}shieldRight.png`)],
    [res(`${T}armorLeft.png`), res(`${T}armorRight.png`)],
    [res(`${T}hullLeft.png`), res(`${T}hullRight.png`)],
  ] as const,
  spinCorners: res(`${T}spinCorners.png`),
  selectedTargeted: res(`${T}selectedTargetedItem.png`),
  timerLeft: res(`${T}timerLeft.png`),
  timerRight: res(`${T}timerRight.png`),
};
/** The BFF's type icon cache (src/server.js, /icon-cache/types/<size>/<variation>/<typeID>.png). */
const typeIcon = (typeID: number): string => `/icon-cache/types/64/icon/${typeID}.png`;

// targetMgr.py
const MAX_TARGET_WIDTH = 110;
const MIN_TARGET_HEIGHT = 170;
const TARGET_PADDING = 10;
const TARGET_HEIGHT = 150; // OnTargetAdded: height=150 (the target sizes itself to its content: ContainerAutoSize)
// targetInBar.py
const ICON_SIZE = 94;
const MASK_SIZE = 50;
const BAR_HEIGHT = 100;
const ASSIGNED_HEIGHT = 32;
const LINE_HEIGHT = 12; // EveLabelSmall: 10 px
const HEALTH_READ_MS = [750, 1000] as const;

const FONT = `"EVE Sans Neue Expanded", "EveSansNeue-Expanded", "Eve Sans Neue", "Barlow Semi Condensed", "Segoe UI", sans-serif`;

// ── formatting ──────────────────────────────────────────────────────────────────────────────────────────

const AU = 149_597_870_700;
const grouped = (n: number, decimals?: number): string =>
  n.toLocaleString("en-US", decimals === undefined ? { maximumFractionDigits: 0 } : { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/** carbon/common/script/util/format.py FmtDist: metres under 10 km, km under 10^10 m, else AU to two places. */
export function fmtDist(dist: number, maxDecimals = 2): string {
  dist = Math.max(0, dist);
  if (dist < 10000) {
    if (dist === 0 || dist >= 1) return `${grouped(Math.round(dist))} m`;
    return `${grouped(dist, maxDecimals)} m`;
  }
  if (dist < 10_000_000_000) return `${grouped(Math.round(dist / 1000))} km`;
  return `${grouped(Math.round((dist / AU) * 10 ** maxDecimals) / 10 ** maxDecimals, maxDecimals)} AU`;
}

// ── textures ────────────────────────────────────────────────────────────────────────────────────────────

const images = new Map<string, Promise<HTMLImageElement>>();
function loadImage(url: string): Promise<HTMLImageElement> {
  let p = images.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`texture ${url}`));
      img.src = url;
    });
    images.set(url, p);
  }
  return p;
}
const DPR = (): number => Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
const pixelCache = new Map<string, ImageData>();
function texturePixels(url: string, img: CanvasImageSource, w: number, h: number): ImageData {
  const key = `${url}@${w}x${h}`;
  let d = pixelCache.get(key);
  if (!d) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, w, h);
    d = ctx.getImageData(0, 0, w, h);
    pixelCache.set(key, d);
  }
  return d;
}

/**
 * A sprite drawn TR2_SFX_MODULATE: its texture times a secondary texture turned by `rotation` (the client's sign)
 * about the centre, times its colour's alpha.
 */
function modulate(ctx: CanvasRenderingContext2D, url: string, primary: HTMLImageElement, secondary: HTMLImageElement, rotation: number): void {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "copy";
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-rotation);
  ctx.drawImage(secondary, -w / 2, -h / 2, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const out = ctx.getImageData(0, 0, w, h);
  const o = out.data, t = texturePixels(url, primary, w, h).data;
  for (let i = 0; i < o.length; i += 4) {
    o[i] = (o[i]! * t[i]!) / 255; o[i + 1] = (o[i + 1]! * t[i + 1]!) / 255; o[i + 2] = (o[i + 2]! * t[i + 2]!) / 255;
    o[i + 3] = (o[i + 3]! * t[i + 3]!) / 255;
  }
  ctx.putImageData(out, 0, 0);
}

function place(e: HTMLElement, left: number, top: number, w?: number, h?: number): void {
  e.style.position = "absolute";
  e.style.left = `${left}px`;
  e.style.top = `${top}px`;
  if (w !== undefined) e.style.width = `${w}px`;
  if (h !== undefined) e.style.height = `${h}px`;
}
function div(parent: HTMLElement, left: number, top: number, w: number, h: number, cls?: string): HTMLDivElement {
  const d = document.createElement("div");
  place(d, left, top, w, h);
  if (cls) d.className = cls;
  parent.appendChild(d);
  return d;
}
function sprite(parent: HTMLElement, url: string, left: number, top: number, w: number, h: number, opacity = 1, cls?: string): HTMLImageElement {
  const img = document.createElement("img");
  img.src = url; img.alt = ""; img.draggable = false;
  place(img, left, top, w, h);
  if (opacity !== 1) img.style.opacity = String(opacity);
  if (cls) img.className = cls;
  parent.appendChild(img);
  return img;
}
function canvas(parent: HTMLElement, left: number, top: number, w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  const dpr = DPR();
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  place(c, left, top, w, h);
  parent.appendChild(c);
  return c.getContext("2d")!;
}
const mid = (parent: number, size: number): number => Math.floor((parent - size) / 2);

const STYLE_ID = "target-bar-style";
const CSS = `
.target-bar { position: absolute; inset: 0; pointer-events: none; user-select: none; -webkit-user-select: none; }
.target-bar img, .target-bar canvas { display: block; }
.target-bar .tb-target { position: absolute; width: ${MAX_TARGET_WIDTH}px; }
.target-bar .tb-bar { pointer-events: auto; }
.target-bar .tb-hilite { display: none; }
.target-bar .tb-bar:hover .tb-hilite { display: block; }
.target-bar .tb-icon { -webkit-mask: url("${TEX.shipMask}") center / 100% 100% no-repeat; mask: url("${TEX.shipMask}") center / 100% 100% no-repeat; }
.target-bar .tb-label { position: absolute; left: 0; width: ${MAX_TARGET_WIDTH}px; height: ${LINE_HEIGHT}px; line-height: ${LINE_HEIGHT}px;
  font-size: 10px; font-family: ${FONT}; color: rgba(255,255,255,0.75); text-align: center; white-space: nowrap; overflow: hidden;
  text-shadow: 1px 1px 0 rgba(0,0,0,0.6); }
.target-bar .tb-label.fade { text-align: left; -webkit-mask-image: linear-gradient(to right, #000 ${MAX_TARGET_WIDTH - 10}px, transparent ${MAX_TARGET_WIDTH}px);
  mask-image: linear-gradient(to right, #000 ${MAX_TARGET_WIDTH - 10}px, transparent ${MAX_TARGET_WIDTH}px); }
@keyframes tb-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes tb-pulse { 0%, 100% { opacity: 0.2; } 50% { opacity: 0.5; } }
.target-bar .tb-spin { animation: tb-spin 3.5s linear infinite, tb-pulse 3s ease-in-out infinite; }
.tb-menu { position: fixed; z-index: 1000; min-width: 140px; padding: 3px 0; background: rgba(12,14,16,0.95); border: 1px solid rgba(255,255,255,0.18);
  font: 12px/1.35 ${FONT}; color: rgba(255,255,255,0.85); }
.tb-menu div { padding: 3px 12px; cursor: default; }
.tb-menu div:hover { background: rgba(255,255,255,0.12); }
/* TargetedIndicator's targeting parts, for the in-space bracket */
@keyframes tb-lock-shrink { from { width: 120px; height: 120px; opacity: 0.1; } to { width: 0; height: 0; opacity: 1; } }
.tb-locking { position: absolute; left: calc(50% - ${ICON_SIZE / 2}px); top: calc(50% - ${ICON_SIZE / 2}px); width: ${ICON_SIZE}px; height: ${ICON_SIZE}px; pointer-events: none; }
.tb-locking img, .tb-locking canvas { display: block; }
.tb-locking .tb-arrows { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%) rotate(-45deg);
  animation: tb-lock-shrink 0.33s linear infinite; }
.tb-locking .tb-lock-text { position: absolute; left: -20px; top: 64px; width: ${ICON_SIZE + 40}px; text-align: center; white-space: nowrap;
  font-size: 10px; line-height: ${LINE_HEIGHT}px; font-family: ${FONT}; color: rgba(255,255,255,0.75); text-shadow: 1px 1px 0 rgba(0,0,0,0.6); }
@keyframes tb-blink { 0%, 49% { opacity: 0; } 50%, 100% { opacity: 1; } }
.tb-locking.locked .tb-lock-text { animation: tb-blink 0.1s linear infinite; }
.tb-locking.locked .tb-timer { animation: tb-blink 0.1s linear infinite; }
`;
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d")!;
  measureCtx.font = `10px ${FONT}`;
  return measureCtx.measureText(text).width;
}

// ── one target ──────────────────────────────────────────────────────────────────────────────────────────

export interface TargetBarEntry {
  itemID: number;
  typeID: number | null;
  name: string | null;
  /** The ship type's name, shown for a player's ship (SetTargetLabel). */
  typeName?: string | null;
  /** Surface distance in metres. */
  distance: number;
  shieldRatio: number | null;
  armorRatio: number | null;
  hullRatio: number | null;
  /** Being locked: not in the bar yet; its in-space indicator is lockingIndicator(itemID). */
  locking: boolean;
  active: boolean;
  /** How long the lock takes (bracket.GetScanSpeed), for the countdown; without it only the arrows show. */
  lockTimeMs?: number | null;
  /** When locking began (performance.now() time). */
  lockStartedAt?: number | null;
}

interface Half { ctx: CanvasRenderingContext2D; url: string; img: HTMLImageElement | null; drawn: number }
interface Layer { box: HTMLDivElement; left: Half; right: Half; shown: number | null; from: number; to: number; start: number; duration: number }

class TargetInBar {
  readonly root: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly iconContainer: HTMLDivElement;
  private readonly circle: HTMLImageElement;
  private readonly indicator: HTMLDivElement;
  private readonly background: HTMLImageElement;
  private readonly icon: HTMLImageElement;
  private readonly layers: Layer[] = [];
  private readonly labels: HTMLDivElement[] = [];
  private readonly labelBox: HTMLDivElement;
  private name: string | null = null;
  private typeName: string | null = null;
  private typeID: number | null = null;
  private active: boolean | null = null;
  private lastDistance: number | null = null;
  private nextRead = 0;
  height = TARGET_HEIGHT;

  constructor(readonly itemID: number, private readonly owner: TargetBar) {
    this.root = document.createElement("div");
    this.root.className = "tb-target";
    this.root.dataset.itemId = String(itemID);
    // barAndImageCont: TOTOP, 100 px
    this.bar = div(this.root, 0, 0, MAX_TARGET_WIDTH, BAR_HEIGHT, "tb-bar");
    // iconPar: 94 px, CENTERTOP
    this.iconContainer = div(this.bar, mid(MAX_TARGET_WIDTH, ICON_SIZE), 0, ICON_SIZE, ICON_SIZE, "tb-icons");
    const ic = this.iconContainer;
    // bottom first: hilite, active indicator, circle, health bars, icon
    sprite(ic, TEX.underlay, -3, -3, 100, 100, 0.05, "tb-hilite");
    this.indicator = div(ic, mid(ICON_SIZE, 120), mid(ICON_SIZE, 120), 120, 120, "tb-active");
    sprite(this.indicator, TEX.selectedTargeted, mid(120, 80), mid(120, 80), 80, 80, 0.15);
    sprite(this.indicator, TEX.spinCorners, 0, 0, 120, 120, 0.2, "tb-spin");
    this.circle = sprite(ic, TEX.outerCircle, mid(ICON_SIZE, ICON_SIZE + 2), mid(ICON_SIZE, ICON_SIZE + 2), ICON_SIZE + 2, ICON_SIZE + 2, 0.5);
    const health = div(ic, 0, 0, ICON_SIZE, ICON_SIZE, "tb-health");
    this.background = sprite(health, TEX.background, 0, 0, ICON_SIZE, ICON_SIZE);
    // hull, armour, shield: the client adds shield first, so it is on top; within a layer the right half is on top
    for (const i of [2, 1, 0]) {
      const box = div(health, 0, 0, ICON_SIZE, ICON_SIZE);
      const half = (url: string): Half => {
        const h: Half = { ctx: canvas(box, 0, 0, ICON_SIZE, ICON_SIZE), url, img: null, drawn: NaN };
        void loadImage(url).then((img) => { h.img = img; h.drawn = NaN; this.drawHealth(); }).catch(() => {});
        return h;
      };
      const left = half(TEX.bars[i]![0]);
      const right = half(TEX.bars[i]![1]);
      this.layers[i] = { box, left, right, shown: null, from: 1, to: 1, start: 0, duration: 0 };
    }
    this.icon = sprite(ic, "", mid(ICON_SIZE, MASK_SIZE), mid(ICON_SIZE, MASK_SIZE), MASK_SIZE, MASK_SIZE, 1, "tb-icon");
    this.icon.style.visibility = "hidden";
    this.icon.onload = () => { this.icon.style.visibility = ""; };
    this.icon.onerror = () => { this.icon.style.visibility = "hidden"; };
    // labelContainer: TOTOP under the bar, then the 32 px assignedPar (module and drone icons; not drawn yet)
    this.labelBox = div(this.root, 0, BAR_HEIGHT, MAX_TARGET_WIDTH, 0, "tb-labels");
    for (let i = 0; i < 4; i++) {
      const l = div(this.labelBox, 0, 0, MAX_TARGET_WIDTH, LINE_HEIGHT, "tb-label");
      this.labels.push(l);
    }
    this.bar.addEventListener("click", (e) => { e.stopPropagation(); this.owner.onSelect(this.itemID); });
    this.bar.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); this.owner.openMenu(this.itemID, e.clientX, e.clientY); });
  }

  /** Returns true when the target's height changed (the row is then laid out again). */
  update(e: TargetBarEntry, now: number): boolean {
    if (e.typeID !== this.typeID) {
      this.typeID = e.typeID;
      this.icon.style.visibility = "hidden";
      if (e.typeID) this.icon.src = typeIcon(e.typeID);
    }
    if (e.active !== this.active) {
      this.active = e.active;
      // ActiveTarget
      this.iconContainer.style.opacity = e.active ? "1" : "0.8";
      this.circle.style.opacity = e.active ? "0.5" : "0.25";
      this.indicator.style.display = e.active ? "" : "none";
    }
    let resized = false;
    const name = e.name ?? "";
    const typeName = e.typeName ?? null;
    if (name !== this.name || typeName !== this.typeName) {
      this.name = name; this.typeName = typeName;
      resized = this.setLabels();
    }
    // UpdateData and UpdateDamage run on 750-1000 ms timers
    if (now >= this.nextRead) {
      this.nextRead = now + HEALTH_READ_MS[0] + Math.random() * (HEALTH_READ_MS[1] - HEALTH_READ_MS[0]);
      const meters = Math.trunc(e.distance);
      if (meters !== this.lastDistance) {
        this.lastDistance = meters;
        this.labels[3]!.textContent = fmtDist(e.distance);
      }
      this.setDamage([e.shieldRatio, e.armorRatio, e.hullRatio], now);
    }
    this.stepHealth(now);
    return resized;
  }

  /** SetNameLabels: the name on one line, broken at the last space that fits, the rest on a second; then the ship type. */
  private setLabels(): boolean {
    const [label, label2, shipLabel] = this.labels as [HTMLDivElement, HTMLDivElement, HTMLDivElement, HTMLDivElement];
    const full = this.name ?? "";
    let first = full, rest = "";
    if (textWidth(full) > MAX_TARGET_WIDTH) {
      // GetIndexUnderPos(width): the characters that fit
      let fit = 0;
      while (fit < full.length && textWidth(full.slice(0, fit + 1)) <= MAX_TARGET_WIDTH) fit++;
      // strippedLabel.rfind(' ', 0, index): a space before the index
      const lastBreak = fit > 0 ? full.lastIndexOf(" ", fit - 1) : -1;
      if (lastBreak !== -1) { first = full.slice(0, lastBreak); rest = full.slice(lastBreak).trim(); }
      else { first = full; rest = full.slice(-1).trim(); /* no space: the client's [lastBreak:] with -1 is the last character */ }
    }
    label.textContent = first;
    label2.textContent = rest;
    label2.classList.toggle("fade", textWidth(rest) > MAX_TARGET_WIDTH - 10);
    label2.style.display = rest ? "" : "none";
    shipLabel.textContent = this.typeName ?? "";
    shipLabel.classList.toggle("fade", textWidth(this.typeName ?? "") > MAX_TARGET_WIDTH - 10);
    shipLabel.style.display = this.typeName ? "" : "none";
    let top = 0;
    for (const l of this.labels) {
      if (l.style.display === "none") continue;
      l.style.top = `${top}px`;
      top += LINE_HEIGHT;
    }
    this.labelBox.style.height = `${top}px`;
    const height = BAR_HEIGHT + top + ASSIGNED_HEIGHT;
    const changed = height !== this.height;
    this.height = height;
    return changed;
  }

  // ── health (TargetHealthBars.SetDamage) ──

  private setDamage(state: (number | null)[], now: number): void {
    let visible = 0;
    state.forEach((v, i) => {
      const layer = this.layers[i]!;
      if (v === null || !Number.isFinite(v)) { layer.box.style.display = "none"; layer.shown = null; return; }
      const health = Math.max(0, v);
      layer.box.style.display = "";
      visible++;
      if (layer.shown === null || !layer.to) {
        // no last state: set at once
        layer.shown = layer.from = layer.to = health; layer.duration = 0;
      } else if (health !== layer.to) {
        layer.from = layer.shown;
        layer.duration = Math.max(0.1, 0.4 * Math.abs(health - layer.to)) * 1000;
        layer.to = health; layer.start = now;
      }
    });
    this.background.style.display = visible === 0 ? "none" : "";
    const bg = visible === 2 ? TEX.backgroundNoShield : TEX.background;
    if (this.background.getAttribute("src") !== bg) this.background.src = bg;
    this.drawHealth();
  }

  private stepHealth(now: number): void {
    let moved = false;
    for (const l of this.layers) {
      if (l.shown === null || l.shown === l.to) continue;
      const t = l.duration > 0 ? Math.min(1, (now - l.start) / l.duration) : 1;
      l.shown = t >= 1 ? l.to : l.from + (l.to - l.from) * t; // ANIM_LINEAR
      moved = true;
    }
    if (moved) this.drawHealth();
  }

  /**
   * The halves' secondary rotations for a health h (SetDamage): at or under half, the right half is all damage
   * (rotation 0) and the left turns from 0 by (0.5 - h) / 0.5 * 0.75 pi; over half, the left is whole (its base
   * - 0.02) and the right turns from -0.75 pi by (1 - h) / 0.5 * 0.75 pi.
   */
  private drawHealth(): void {
    for (const l of this.layers) {
      if (l.shown === null) continue;
      const h = l.shown;
      const left = h <= 0.5 ? ((0.5 - h) / 0.5) * 0.75 * Math.PI : -0.02;
      const right = h <= 0.5 ? 0 : -0.75 * Math.PI + ((1 - h) / 0.5) * 0.75 * Math.PI;
      this.drawHalf(l.left, left);
      this.drawHalf(l.right, right);
    }
  }

  /** Draws the bars again (the gauge colour texture has come). */
  redraw(): void {
    for (const l of this.layers) { l.left.drawn = NaN; l.right.drawn = NaN; }
    this.drawHealth();
  }

  private drawHalf(half: Half, rotation: number): void {
    const gauge = this.owner.gaugeColor;
    if (!half.img || !gauge || half.drawn === rotation) return;
    modulate(half.ctx, half.url, half.img, gauge, rotation);
    half.drawn = rotation;
  }
}

// ── the in-space targeting indicator ────────────────────────────────────────────────────────────────────

/**
 * TargetedIndicator's targeting parts (activeTargetIndicator.py, inSpaceBracket.CountDown): 94 px, centred on the
 * bracket. Its root is to be put inside the bracket's element, centred on it.
 */
export class LockingIndicator {
  readonly root = document.createElement("div");
  private readonly text: HTMLDivElement;
  private readonly timers: { ctx: CanvasRenderingContext2D; url: string; img: HTMLImageElement | null; drawn: number }[] = [];
  private lockTimeMs: number | null = null;
  private startedAt = 0;
  private done = false;

  constructor() {
    ensureStyle();
    this.root.className = "tb-locking";
    // outerCircle at 0.1 (TargetedIndicator.circle)
    sprite(this.root, TEX.outerCircle, mid(ICON_SIZE, 96), mid(ICON_SIZE, 96), 96, 96, 0.1);
    for (const url of [TEX.timerLeft, TEX.timerRight]) {
      const ctx = canvas(this.root, mid(ICON_SIZE, 76), mid(ICON_SIZE, 76), 76, 76);
      ctx.canvas.classList.add("tb-timer");
      ctx.canvas.style.opacity = "0.4";
      ctx.canvas.style.display = "none";
      const t = { ctx, url, img: null as HTMLImageElement | null, drawn: NaN };
      void loadImage(url).then((img) => { t.img = img; }).catch(() => {});
      this.timers.push(t);
    }
    // targetingArrows: spinCorners at rotation pi/4, shrinking 120 -> 0 px every 0.33 s (ShowTargetingIndicators)
    const arrows = document.createElement("img");
    arrows.src = TEX.spinCorners; arrows.alt = ""; arrows.className = "tb-arrows";
    this.root.appendChild(arrows);
    // lockingText: EveLabelSmall, CENTERTOP, top 64
    this.text = document.createElement("div");
    this.text.className = "tb-lock-text";
    this.root.appendChild(this.text);
  }

  /** Called each frame while locking. */
  update(lockTimeMs: number | null, startedAt: number | null, now: number): void {
    if (lockTimeMs !== this.lockTimeMs || (startedAt ?? 0) !== this.startedAt) {
      this.lockTimeMs = lockTimeMs; this.startedAt = startedAt ?? now; this.done = false;
      this.root.classList.remove("locked");
      for (const t of this.timers) t.ctx.canvas.style.display = lockTimeMs ? "" : "none";
      if (!lockTimeMs) this.text.textContent = "";
    }
    if (!this.lockTimeMs || this.done) return;
    const dt = now - this.startedAt;
    if (dt > this.lockTimeMs) {
      this.done = true;
      this.text.textContent = "Target Locked"; // UI/Inflight/Brackets/TargetLocked
      this.drawTimers(0, 0);
      this.root.classList.add("locked"); // BlinkArrowsAndText
      return;
    }
    this.text.textContent = ((this.lockTimeMs - dt) / 1000).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const ratio = (this.lockTimeMs - dt) / this.lockTimeMs;
    if (ratio > 0.5) this.drawTimers(Math.PI, Math.PI + ratio * 2 * Math.PI);
    else this.drawTimers(ratio * 2 * Math.PI, 0);
  }

  private drawTimers(left: number, right: number): void {
    [left, right].forEach((rot, i) => {
      const t = this.timers[i]!;
      // a timer half modulated by itself, turned: the arc left to run
      const r = Math.round(rot * 1000) / 1000;
      if (!t.img || t.drawn === r) return;
      modulate(t.ctx, t.url, t.img, t.img, rot);
      t.drawn = r;
    });
  }
}

// ── the bar ─────────────────────────────────────────────────────────────────────────────────────────────

export interface TargetBarAnchor { left: number; top: number; width: number }

export class TargetBar {
  readonly root = document.createElement("div");
  onSelect: (itemID: number) => void = () => {};
  onUnlock: (itemID: number) => void = () => {};
  gaugeColor: HTMLImageElement | null = null;

  private readonly targets = new Map<number, TargetInBar>();
  /** Rows of itemIDs, in the order the client's rowDict holds them. */
  private rows: number[][] = [];
  private readonly locking = new Map<number, LockingIndicator>();
  private anchor: TargetBarAnchor | null = null;
  private layoutKey = "";
  private menu: HTMLDivElement | null = null;
  private readonly onPointerDown = (e: PointerEvent): void => { if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu(); };

  constructor() {
    ensureStyle();
    this.root.className = "target-bar";
    void loadImage(TEX.gaugeColor).then((img) => { this.gaugeColor = img; for (const t of this.targets.values()) t.redraw(); }).catch(() => {});
    addEventListener("pointerdown", this.onPointerDown, true);
  }

  /** Where the Selected Item window is: the client places the target bar's origin from it. Null: no window. */
  setAnchor(anchor: TargetBarAnchor | null): void {
    this.anchor = anchor;
  }

  /** The in-space indicator of a target being locked, to be put in its bracket; null when it is not locking. */
  lockingIndicator(itemID: number): HTMLElement | null {
    return this.locking.get(itemID)?.root ?? null;
  }

  update(entries: TargetBarEntry[]): void {
    const now = performance.now();
    const seen = new Set<number>();
    let changed = false;
    for (const e of entries) {
      if (e.locking) {
        let ind = this.locking.get(e.itemID);
        if (!ind) { ind = new LockingIndicator(); this.locking.set(e.itemID, ind); }
        ind.update(e.lockTimeMs ?? null, e.lockStartedAt ?? null, now);
        continue;
      }
      seen.add(e.itemID);
      let t = this.targets.get(e.itemID);
      if (!t) {
        t = new TargetInBar(e.itemID, this);
        this.targets.set(e.itemID, t);
        this.root.appendChild(t.root);
        changed = true;
      }
      if (t.update(e, now)) changed = true;
    }
    for (const [id, ind] of this.locking) {
      if (!entries.some((e) => e.locking && e.itemID === id)) { ind.root.remove(); this.locking.delete(id); }
    }
    for (const [id, t] of this.targets) {
      if (!seen.has(id)) { t.root.remove(); this.targets.delete(id); changed = true; }
    }
    this.layout(changed);
  }

  // ── layout (targetMgr.ArrangeTargets) ──

  private layout(force: boolean): void {
    const W = innerWidth, H = innerHeight;
    // GetOriginPosition, with no position of the player's own: from the Selected Item window
    let cX: number, cY: number;
    const a = this.anchor;
    if (a) {
      const left = a.left - 15;
      cY = a.top;
      if (left + a.width < W / 2) cX = left + a.width;
      else if (left >= W / 2) cX = left;
      else { cX = W - 300; cY = 16; }
    } else { cX = W - 300; cY = 16; }
    const toLeft = cX / W > 0.5, toTop = cY / H > 0.5;
    const baseLeft = toLeft ? W - cX : cX;
    const baseTop = toTop ? H - cY : cY;
    const key = `${W}x${H}:${baseLeft},${baseTop},${toLeft},${toTop}`;
    if (!force && key === this.layoutKey) return;
    this.layoutKey = key;

    // rows of targets; a target keeps its row, a new one goes to the first row it fits in (FindRow, DoesTargetFit)
    const parSize = W - baseLeft;
    const fits = (n: number) => n * MAX_TARGET_WIDTH + MAX_TARGET_WIDTH < parSize;
    const maxRows = Math.max(1, Math.floor((H - baseTop) / 200)); // AVG_TARGET_HEIGHT
    this.rows = this.rows.map((r) => r.filter((id) => this.targets.has(id)));
    const placed = new Set(this.rows.flat());
    for (const id of this.targets.keys()) {
      if (placed.has(id)) continue;
      let row = this.rows.findIndex((r) => fits(r.length));
      if (row === -1 && this.rows.length < maxRows) { this.rows.push([]); row = this.rows.length - 1; }
      if (row === -1) continue; // the client logs "did not add the following targets"
      this.rows[row]!.push(id);
    }
    while (this.rows.length && this.rows[this.rows.length - 1]!.length === 0) this.rows.pop();

    // AdjustRowSize: a row as tall as its tallest target (at least 170) plus 10
    let y = baseTop;
    for (const row of this.rows) {
      const rowHeight = Math.max(MIN_TARGET_HEIGHT, ...row.map((id) => this.targets.get(id)!.height)) + TARGET_PADDING;
      row.forEach((id, i) => {
        const t = this.targets.get(id)!;
        const x = toLeft ? W - baseLeft - (i + 1) * MAX_TARGET_WIDTH : baseLeft + i * MAX_TARGET_WIDTH;
        t.root.style.left = `${x}px`;
        t.root.style.top = toTop ? `${H - y - t.height}px` : `${y}px`;
        t.root.style.display = "";
      });
      y += rowHeight;
    }
    for (const [id, t] of this.targets) if (!this.rows.some((r) => r.includes(id))) t.root.style.display = "none";
  }

  // ── the target's menu: the client's is the full CelestialMenu; only Unlock Target here ──

  openMenu(itemID: number, x: number, y: number): void {
    this.closeMenu();
    const m = document.createElement("div");
    m.className = "tb-menu";
    m.style.left = `${x}px`;
    m.style.top = `${y}px`;
    const unlock = document.createElement("div");
    unlock.textContent = "Unlock Target";
    unlock.addEventListener("click", () => { this.closeMenu(); this.onUnlock(itemID); });
    m.appendChild(unlock);
    document.body.appendChild(m);
    this.menu = m;
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  dispose(): void {
    removeEventListener("pointerdown", this.onPointerDown, true);
    this.closeMenu();
    this.root.remove();
  }
}
