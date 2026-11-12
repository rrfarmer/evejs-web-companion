// The in-flight ship HUD: the retail client's round "ship UI" at the bottom centre of the screen, ported
// from the client's own Python (eve/client/script/ui/inflight/shipHud/) and drawn with the client's own
// textures, served by the BFF at /client-res. Sizes are the client's pixels at its default UI scale of 1.0.
//
// What comes from where (file names under shipHud/):
//   shipUI.py          the 1200x200 hudContainer at the bottom centre; the 185x200 centerParent and what it
//                      holds, in the client's stacking order; the stop/full-speed buttons (StopButton,
//                      MaxSpeedButton, ConstructOverlayContainer); the slots container's place
//                      (SLOTS_CONTAINER_LEFT/TOP/WIDTH/HEIGHT, slotsContLeft); the bgCircle.
//   hudShape.py        mainUnderlay.png tinted COLORTYPE_UIBASE, under an additive mainDOT.png (TR2_SFX_DOT).
//   hpGauges.py        gauge1/2/3.png at 148 px, TR2_SFX_MODULATE with gaugeFill.png turned by pi*(1 - value),
//                      shadow (0, 1); a change is morphed over 0.5 s; read every 500 ms (ShipUI.UpdateGauges).
//   capacitorContainer.py  min(18, int(maxCap / 50)) columns of 4 capacitorCell_2.png cells, the cell colours
//                      and glow colour, the blinking capacitorCellGlow.png on the last full cell; read every
//                      500 ms, rounded to hundredths.
//   speedGauge.py      the clipped 124x42 speedometer: speedoUnderlay, the speedoOverlay_v2 fill and needle
//                      turned by 45 + 90 * speedPortion degrees, the EveLabelSmall readout.
//   heatGauges.py      the three heat needles and their underlays (a stub: heat stays 0 unless given).
//   slotsContainer.py, shipSlot.py, overloadBtn.py  the 3 x 8 slot grid (InitSlots, InitDrawSlots), empty slots
//                      as the client draws them with showEmptySlots on, and the rack overload buttons.
//
// Rotation sign: a carbonui Transform's rotation and a sprite's secondary-texture rotation both turn
// counter-clockwise on screen (speedGauge.GetCurrMouseSpeedPortion puts speed 0 at lower left; DamageRing's
// segment offsets only fit that way). CSS and canvas turn clockwise, hence the minus signs below.
// Stacking: in carbonui a container's first child is drawn on top, so the DOM order here is the reverse of the
// client's construction order.

const res = (path: string): string => `/client-res/${path.replace(/^res:\//i, "").toLowerCase()}`;

const SHIP_UI = "res:/UI/Texture/classes/ShipUI/";
const TEX = {
  mainUnderlay: res(`${SHIP_UI}mainUnderlay.png`),
  mainDot: res(`${SHIP_UI}mainDOT.png`),
  bgCircle: res(`${SHIP_UI}mainBGCircle.png`),
  gauge: [1, 2, 3].map((n) => res(`${SHIP_UI}gauge${n}.png`)),
  gaugeFill: res(`${SHIP_UI}gaugeFill.png`),
  capCell: res(`${SHIP_UI}capacitorCell_2.png`),
  capGlow: res(`${SHIP_UI}capacitorCellGlow.png`),
  speedoUnderlay: res(`${SHIP_UI}speedoUnderlay.png`),
  speedoOverlay: res(`${SHIP_UI}speedoOverlay_v2.png`),
  needle: res(`${SHIP_UI}heatGaugeNeedle.png`),
  heatDivider: res(`${SHIP_UI}heatDivider.png`),
  heat: (rack: "low" | "med" | "hi", i: number) => res(`${SHIP_UI}${rack}Heat_${i}.png`),
  plus: res(`${SHIP_UI}plus.png`),
  minus: res(`${SHIP_UI}minus.png`),
  slotMain: res(`${SHIP_UI}slotMainCombined.png`),
  slotOverload: (state: "On" | "Off" | "Disabled") => res(`${SHIP_UI}slotOverload${state}.png`),
  overloadBtn: (key: string, on = false) => res(`${SHIP_UI}overloadBtn${key}${on ? "On" : "Off"}.png`),
  slotDamage: (i: number) => res(`${SHIP_UI}slotDamage_${i}.png`),
  // CheckButtonVisibility: 'ui_8_64_11', 'ui_8_64_10', 'ui_8_64_9' for empty high, medium, low slots
  emptySlotIcon: [11, 10, 9].map((n) => res(`res:/UI/Texture/Icons/8_64_${n}.png`)),
  slotGlow: res(`${SHIP_UI}slotGlow.png`),
};

/** A fitted module for the rack (setModules): its slot (family and index), what it is, and its state. */
export interface HudModule {
  family: "high" | "mid" | "low";
  index: number;
  itemID: number;
  typeID: number;
  name?: string;
  online: boolean;
  active: boolean;
  /** The type's icon (64 px). */
  icon: string;
  /** How far through its cycle a running module is, 0..1; null when not cycling or not known. */
  cycle?: number | null;
  /** The type has an effect of the overload category (null: not known yet). */
  overloadable?: boolean | null;
  /** Its overload effect is on (the snapshot's overloadedModuleIDs). */
  overloaded?: boolean;
  /** Its damage over its hp, 0..1 - its bank's worst (GetModuleGroupDamage); 0 or left out: none. */
  damage?: number;
}

/** What the rack's overload buttons do (godma ToggleOverload / Overload, OverloadRack / StopOverloadRack). */
export interface HudOverload {
  module(m: HudModule, on: boolean): void;
  rack(activationID: number, on: boolean): void;
}

type RGBA = readonly [number, number, number, number];
const hex = (h: string, a = 1): RGBA => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a];
// eve/client/script/ui/eveColor.py
const SILVER_GREY = hex("#B0B0B0");
const SMOKE_BLUE = hex("#305665");
const BLACK = hex("#000000");
// COLORTYPE_UIBASE is the active theme's tint (uiColorSvc._GetBaseColor); the default theme is Photon
// (colorThemes.DEFAULT_COLORTHEMEID), tint '#060a0c'.
const UIBASE = hex("#060a0c");
// capacitorContainer.py
const COLOR_ORANGE: RGBA = [0.9375, 0.3515625, 0.1953125, 1];
const COLOR_DARK_ORANGE: RGBA = [70 / 256, 26 / 256, 13 / 256, 1];
const SHADOW = "rgba(0,0,0,0.5)"; // TexturedBase.default_shadowColor

const SHIP_UI_WIDTH = 1200; // shipHudConst.py
const SHIP_UI_HEIGHT = 200;
const SLOTS_CONTAINER_LEFT = SHIP_UI_WIDTH / 2 + 70; // shipUI.py
const SLOTS_CONTAINER_TOP = -1;
const SLOTS_CONTAINER_WIDTH = 512;
const SLOTS_CONTAINER_HEIGHT = 152;

/** carbonui's CENTER alignment, with Python 2's integer division (it floors). */
const mid = (parent: number, size: number): number => Math.floor((parent - size) / 2);

// Where everything sits in the hudContainer (1200x200), worked out from shipUI.OnOpenView.
const CENTER_PARENT = { left: mid(SHIP_UI_WIDTH, 185), top: SHIP_UI_HEIGHT - 200, w: 185, h: 200 }; // CENTERBOTTOM
const cp = (left: number, top: number) => ({ left: CENTER_PARENT.left + left, top: CENTER_PARENT.top + top });
const SHAPE = cp(mid(185, 160), mid(200, 160)); // HUDShape, bgCircle, heatPicker: 160x160 CENTER
const OVERLAY = cp(mid(185, 256), mid(200, 256)); // overlayContainer 256x256 CENTER
const CAPACITOR = cp(mid(185, 60), mid(200, 60) - 1); // CapacitorContainer 60x60 CENTER, top=-1
const HP = cp(mid(185, 148), mid(200, 74) - 37); // HPGauges (0, -37, 148, 74) CENTER; its 148 px sprites TOPLEFT
const SPEED = cp(mid(185, 124), 200 - 36 - 29); // SpeedGauge 124x36 CENTERBOTTOM, top=29
const SPEED_PICK = { left: SPEED.left + mid(124, 144), top: SPEED.top + 36 - 144 }; // 144x144 CENTERBOTTOM
const SPEED_CLIP = { left: SPEED_PICK.left + mid(144, 124), top: SPEED_PICK.top + 144 - 42 }; // 124x42 CENTERBOTTOM

// heatGauges.py
const HEAT_RACKS = [
  { rack: "low" as const, start: -2, underlay: [36, 42, 27, 38] },
  { rack: "med" as const, start: -62, underlay: [57, 36, 45, 18] },
  { rack: "hi" as const, start: -122, underlay: [95, 42, 27, 38] },
];
function heatTextureIndex(v: number): number {
  return v <= 1 / 8 ? 0 : v <= 3 / 8 ? 1 : v <= 5 / 8 ? 2 : v <= 7 / 8 ? 3 : 4;
}

export interface ShipHudState {
  shieldRatio: number | null;
  armorRatio: number | null;
  hullRatio: number | null;
  capacitorRatio: number | null;
  /** The ship's capacitor capacity in GJ; sets the number of cell columns. Null: not known yet. */
  capacitorMax: number | null;
  /** m/s */
  speed: number;
  /** The ship's ball is in warp mode (activeShipController.IsInWarp: from the warp order on, its align too). */
  warping?: boolean;
  maxSpeed: number | null;
  /** 0..1 rack heat; the heat gauges stay at 0 when left out. */
  heatLow?: number; heatMed?: number; heatHi?: number;
}

export interface ShipHudOptions {
  /** How many high, medium and low slots to draw (each up to 8). The client's default (showEmptySlots off)
   * hides empty slots; with no fitting known yet they are drawn as it draws them with that setting on. */
  slots?: { hi: number; med: number; low: number };
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

function canvasBox(parent: HTMLElement, left: number, top: number, w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  const dpr = DPR();
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  place(c, left, top, w, h);
  parent.appendChild(c);
  return c.getContext("2d")!;
}

/** A texture drawn at w x h device pixels with its pixels mapped by fn (r, g, b, a in 0..255, in place). */
function texturePixels(img: CanvasImageSource, w: number, h: number): ImageData {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** A sprite's colour: TR2_SFX_COPY / MODULATE with a colour multiply the texture by it, alpha included. */
function tinted(img: HTMLImageElement, color: RGBA, w = img.naturalWidth, h = img.naturalHeight): HTMLCanvasElement {
  const d = texturePixels(img, w, h);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    p[i] = p[i]! * color[0]; p[i + 1] = p[i + 1]! * color[1]; p[i + 2] = p[i + 2]! * color[2]; p[i + 3] = p[i + 3]! * color[3];
  }
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d")!.putImageData(d, 0, 0);
  return c;
}

/**
 * Light to be added (TR2_SBM_ADD) in a form CSS's plus-lighter adds: per pixel the light's colour, premultiplied,
 * so alpha = its brightest channel. light(r, g, b, a) returns the light's rgb in 0..1.
 */
function additive(img: HTMLImageElement, w: number, h: number, light: (r: number, g: number, b: number, a: number) => [number, number, number]): HTMLCanvasElement {
  const d = texturePixels(img, w, h);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    const [r, g, b] = light(p[i]! / 255, p[i + 1]! / 255, p[i + 2]! / 255, p[i + 3]! / 255);
    const a = Math.min(1, Math.max(r, g, b));
    p[i] = a > 0 ? (r / a) * 255 : 0; p[i + 1] = a > 0 ? (g / a) * 255 : 0; p[i + 2] = a > 0 ? (b / a) * 255 : 0; p[i + 3] = a * 255;
  }
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d")!.putImageData(d, 0, 0);
  return c;
}

function place(e: HTMLElement, left: number, top: number, w?: number, h?: number): void {
  e.style.position = "absolute";
  e.style.left = `${left}px`;
  e.style.top = `${top}px`;
  if (w !== undefined) e.style.width = `${w}px`;
  if (h !== undefined) e.style.height = `${h}px`;
}

function div(parent: HTMLElement, left: number, top: number, w: number, h: number, name?: string): HTMLDivElement {
  const d = document.createElement("div");
  place(d, left, top, w, h);
  if (name) d.dataset.name = name;
  parent.appendChild(d);
  return d;
}

function sprite(parent: HTMLElement, url: string, left: number, top: number, w: number, h: number, name?: string): HTMLImageElement {
  const img = document.createElement("img");
  img.src = url;
  img.alt = "";
  img.draggable = false;
  place(img, left, top, w, h);
  if (name) img.dataset.name = name;
  parent.appendChild(img);
  return img;
}

/** A canvas holding a tinted copy of a texture, set into a box once the texture has come. */
function tintedSprite(parent: HTMLElement, url: string, color: RGBA, left: number, top: number, w: number, h: number, name?: string): HTMLDivElement {
  const box = div(parent, left, top, w, h, name);
  void loadImage(url).then((img) => {
    const c = tinted(img, color);
    c.style.width = "100%";
    c.style.height = "100%";
    c.style.display = "block";
    box.appendChild(c);
  }).catch(() => { /* texture missing: leave the box empty */ });
  return box;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
/** uianimations' default curve (ANIM_SMOOTH) is an ease in and out. */
const smooth = (t: number): number => t * t * (3 - 2 * t);

const STYLE_ID = "ship-hud-style";
const CSS = `
.ship-hud-root { position: absolute; left: 50%; bottom: 0; width: ${SHIP_UI_WIDTH}px; height: ${SHIP_UI_HEIGHT}px;
  margin-left: -${SHIP_UI_WIDTH / 2}px; pointer-events: none; user-select: none; -webkit-user-select: none; }
.ship-hud-root img, .ship-hud-root canvas { display: block; }
.ship-hud-root .add { mix-blend-mode: plus-lighter; }
.ship-hud-root .shadow { filter: drop-shadow(0 1px 0 ${SHADOW}); }
.ship-hud-root .btn { pointer-events: auto; }
.ship-hud-root .label { position: absolute; white-space: nowrap; text-align: center; font-size: 10px; line-height: 12px;
  font-family: "EVE Sans Neue Expanded", "EveSansNeue-Expanded", "Eve Sans Neue", "Barlow Semi Condensed", "Segoe UI", sans-serif;
  text-shadow: 1px 1px 0 rgba(0,0,0,0.5); }
@keyframes ship-hud-blink { from { opacity: 1; } to { opacity: 0.15; } }
.ship-hud-root .cap-blink { animation: ship-hud-blink 0.75s ease-in-out infinite alternate; }
.ship-hud-root .slot-glow { position: absolute; background-color: rgb(61, 171, 41); pointer-events: none;
  -webkit-mask: var(--glow) center / 100% 100% no-repeat; mask: var(--glow) center / 100% 100% no-repeat;
  animation: ship-hud-slot-blink 1s ease-in-out infinite alternate; }
@keyframes ship-hud-slot-blink { from { opacity: 0.75; } to { opacity: 0.15; } }
.ship-hud-root .slot-damage-blink { animation: ship-hud-damage-blink var(--t, 2000ms) linear 2; }
@keyframes ship-hud-damage-blink { 0% { opacity: 1; } 50% { opacity: 0; } 100% { opacity: 1; } }
.ship-hud-root .ol-pending-on { animation: ship-hud-ol-on 0.5s ease-in infinite; }
@keyframes ship-hud-ol-on { from { filter: brightness(1.8); } to { filter: brightness(1); } }
.ship-hud-root .ol-pending-off { animation: ship-hud-ol-off 0.5s ease-in infinite; }
@keyframes ship-hud-ol-off { from { opacity: 0.2; } to { opacity: 1; } }
.ship-hud-root .slot-sweep { position: absolute; pointer-events: none; border-radius: 50%;
  background: conic-gradient(rgba(255, 255, 255, 0.22) var(--p, 0deg), transparent 0);
  -webkit-mask: radial-gradient(circle, transparent 58%, #000 60%, #000 70%, transparent 72%);
  mask: radial-gradient(circle, transparent 58%, #000 60%, #000 70%, transparent 72%); }
`;

interface Morph { shown: number; from: number; to: number; start: number; }

// ── the HUD ─────────────────────────────────────────────────────────────────────────────────────────────

export class ShipHud {
  readonly root = document.createElement("div");
  onStop: () => void = () => {};
  onFullSpeed: () => void = () => {};

  private readonly gauges: { ctx: CanvasRenderingContext2D; tex: ImageData | null; morph: Morph | null; drawn: number }[] = [];
  private fill: HTMLImageElement | null = null;
  private lastHpRead = -Infinity;

  private readonly capCtx: CanvasRenderingContext2D;
  private readonly capBlinkHost: HTMLDivElement;
  private capCellTex: HTMLImageElement | null = null;
  private capGlowTex: HTMLImageElement | null = null;
  private capColumns = -1;
  private capProportion: number | null = null;
  private capDirty = true;
  private capRatio: number | null = null;
  private capMax: number | null = null;
  private lastCapRead = -Infinity;

  private readonly needle: HTMLDivElement;
  private readonly speedLabel: HTMLDivElement;
  private speedPortion = -1;
  private speedText = "";

  private readonly heat: { needle: HTMLDivElement; underlay: HTMLImageElement; start: number; rack: "low" | "med" | "hi"; morph: Morph; index: number }[] = [];
  private lastHeatRead = -Infinity;

  private readonly dot: HTMLCanvasElement[] = [];
  private readonly onPointer = (e: PointerEvent): void => this.light(e.clientX, e.clientY);

  constructor(options: ShipHudOptions = {}) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    const root = this.root;
    root.className = "ship-hud-root";
    root.dataset.name = "hudContainer";

    // Bottom of centerParent first: the client adds the bgCircle last, so it is drawn under everything.
    tintedSprite(root, TEX.bgCircle, [0, 0, 0, 0.3], SHAPE.left, SHAPE.top, 160, 160, "bgCircle");

    // SpeedGauge
    const pick = div(root, SPEED_PICK.left, SPEED_PICK.top, 144, 144, "speedCircularPickParent");
    // speedoUnderlay: BLACK at 0.8 through TR2_SFX_COLOROVERLAY (the texture's alpha in the colour), (0, 48) from centre
    tintedSprite(pick, TEX.speedoUnderlay, [BLACK[0], BLACK[1], BLACK[2], 0.8], mid(144, 104), mid(144, 44) + 48, 104, 44, "speedoUnderlay");
    const clip = div(pick, SPEED_CLIP.left - SPEED_PICK.left, SPEED_CLIP.top - SPEED_PICK.top, 124, 42, "speedGaugeParent");
    clip.style.overflow = "hidden";
    // speedNeedle: Transform (-5, -34, 134, 12), turning about its own centre, which is the HUD's centre
    this.needle = div(clip, -5, -34, 134, 12, "speedNeedle");
    this.needle.style.transformOrigin = "67px 6px";
    tintedSprite(this.needle, TEX.speedoOverlay, [SMOKE_BLUE[0], SMOKE_BLUE[1], SMOKE_BLUE[2], 0.8], -8, -84, 153, 89, "speedGaugeSprite");
    tintedSprite(this.needle, TEX.needle, SILVER_GREY, 0, 0, 24, 12, "needle");
    this.speedLabel = document.createElement("div");
    this.speedLabel.className = "label";
    this.speedLabel.dataset.name = "speedLabel";
    this.speedLabel.style.color = "rgba(255,255,255,0.9)"; // TextColor.HIGHLIGHT
    // EveLabelSmall, align CENTER with top=2 in the 124x42 clip
    place(this.speedLabel, 0, mid(42, 12) + 2, 124, 12);
    clip.appendChild(this.speedLabel);

    // HPGauges: shield (gauge1) at the bottom, structure (gauge3) on top
    const hp = div(root, HP.left, HP.top, 148, 74, "healthGauges");
    for (const tex of [TEX.gauge[0]!, TEX.gauge[1]!, TEX.gauge[2]!]) {
      const ctx = canvasBox(hp, 0, 0, 148, 148);
      ctx.canvas.classList.add("shadow");
      const g = { ctx, tex: null as ImageData | null, morph: null as Morph | null, drawn: NaN };
      this.gauges.push(g);
      void loadImage(tex).then((img) => { g.tex = texturePixels(img, ctx.canvas.width, ctx.canvas.height); g.drawn = NaN; this.drawGauges(); }).catch(() => {});
    }
    void loadImage(TEX.gaugeFill).then((img) => { this.fill = img; for (const g of this.gauges) g.drawn = NaN; this.drawGauges(); }).catch(() => {});

    // HeatGauges, CENTERTOP in the 160x160 heatPicker
    // Client order: the three needles (each idx=0, so the last on top), then the divider, then the underlays
    // low, med, hi, each under the one before. Bottom first here.
    const heat = div(root, SHAPE.left, SHAPE.top, 160, 80, "HeatGauges");
    const underlays = [...HEAT_RACKS].reverse().map((h) => {
      const [l, t, w, ht] = h.underlay as [number, number, number, number];
      return sprite(heat, TEX.heat(h.rack, 0), l, t, w, ht, `heat${h.rack}Underlay`);
    }).reverse();
    sprite(heat, TEX.heatDivider, 56, 42, 46, 12, "divider");
    HEAT_RACKS.forEach((h, i) => {
      // the needle's Transform: (-1, 40, 83, 12) CENTER, turning about its centre, which is the HUD's centre
      const t = div(heat, mid(160, 83) - 1, mid(80, 12) + 40, 83, 12, "heatGauge");
      t.style.transformOrigin = "41.5px 6px";
      t.style.transform = `rotate(${-h.start}deg)`;
      sprite(t, TEX.needle, 0, 0, 12, 12, "needle");
      this.heat.push({ needle: t, underlay: underlays[i]!, start: h.start, rack: h.rack, morph: { shown: 0, from: 0, to: 0, start: 0 }, index: 0 });
    });

    // CapacitorContainer: the cells on a canvas (redrawn only when the proportion changes), the blink as a sprite
    const cap = div(root, CAPACITOR.left, CAPACITOR.top, 60, 60, "CapacitorContainer");
    this.capCtx = canvasBox(cap, 0, 0, 60, 60);
    this.capBlinkHost = div(cap, 0, 0, 60, 60, "powerblinkHost");
    void Promise.all([loadImage(TEX.capCell), loadImage(TEX.capGlow)]).then(([cell, glow]) => {
      this.capCellTex = cell; this.capGlowTex = glow; this.capDirty = true; this.drawCapacitor();
    }).catch(() => {});

    // HUDShape: the theme-tinted underlay, the additive DOT light over it
    tintedSprite(root, TEX.mainUnderlay, UIBASE, SHAPE.left, SHAPE.top, 160, 160, "shipuiMainShape");
    const dotBox = div(root, SHAPE.left, SHAPE.top, 160, 160, "mainDot");
    void loadImage(TEX.mainDot).then((img) => {
      const dpr = DPR();
      for (let ch = 0; ch < 3; ch++) {
        const c = additive(img, Math.round(160 * dpr), Math.round(160 * dpr), (...px) => { const v = px[ch]! * px[3]; return [v, v, v]; });
        c.className = "add";
        place(c, 0, 0, 160, 160);
        dotBox.appendChild(c);
        this.dot.push(c);
      }
      this.light(null, null);
    }).catch(() => {});
    addEventListener("pointermove", this.onPointer, { passive: true });

    // overlayContainer (on top): StopButton (minus) and MaxSpeedButton (plus), 12x12
    const stop = sprite(root, TEX.minus, OVERLAY.left + 75, OVERLAY.top + 155, 12, 12, "StopButton");
    stop.className = "btn";
    stop.title = "Stop the ship";
    stop.addEventListener("click", (e) => { e.stopPropagation(); this.onStop(); });
    const max = sprite(root, TEX.plus, OVERLAY.left + 168, OVERLAY.top + 155, 12, 12, "MaxSpeedButton");
    max.className = "btn";
    max.title = "Set full speed";
    max.addEventListener("click", (e) => { e.stopPropagation(); this.onFullSpeed(); });

    this.buildSlots(options.slots ?? { hi: 8, med: 8, low: 8 });
    this.setSpeed(0, null);
  }

  dispose(): void {
    removeEventListener("pointermove", this.onPointer);
    this.root.remove();
  }

  /** Called every frame; work is done only where something changed. */
  update(s: ShipHudState): void {
    const now = performance.now();
    this.setSpeed(s.speed, s.maxSpeed, s.warping === true);

    // ShipUI.UpdateGauges reads HP every 500 ms; each gauge morphs to a new value over 0.5 s.
    if (now - this.lastHpRead >= 500) {
      this.lastHpRead = now;
      [s.shieldRatio, s.armorRatio, s.hullRatio].forEach((v, i) => {
        const g = this.gauges[i]!;
        const to = v === null ? 1 : clamp01(v);
        if (!g.morph) g.morph = { shown: to, from: to, to, start: now };
        else if (to !== g.morph.to) g.morph = { shown: g.morph.shown, from: g.morph.shown, to, start: now };
      });
    }
    let hpMoved = false;
    for (const g of this.gauges) {
      const m = g.morph;
      if (!m || m.shown === m.to) continue;
      const t = Math.min(1, (now - m.start) / 500);
      m.shown = t >= 1 ? m.to : m.from + (m.to - m.from) * smooth(t);
      hpMoved = true;
    }
    if (hpMoved || this.gauges.some((g) => g.morph && g.drawn !== g.morph.shown)) this.drawGauges();

    // CapacitorContainer.UpdateThread: every 500 ms
    if (now - this.lastCapRead >= 500 || s.capacitorMax !== this.capMax) {
      this.lastCapRead = now;
      this.capRatio = s.capacitorRatio;
      if (s.capacitorMax !== this.capMax) { this.capMax = s.capacitorMax; this.capDirty = true; }
      this.drawCapacitor();
    }

    if (now - this.lastHeatRead >= 500) {
      this.lastHeatRead = now;
      [s.heatLow, s.heatMed, s.heatHi].forEach((v, i) => {
        const h = this.heat[i]!;
        const to = clamp01(v ?? 0);
        if (to !== h.morph.to) h.morph = { shown: h.morph.shown, from: h.morph.shown, to, start: now };
        const index = heatTextureIndex(to);
        if (index !== h.index) { h.index = index; h.underlay.src = TEX.heat(h.rack, index); }
      });
    }
    for (const h of this.heat) {
      const m = h.morph;
      if (m.shown === m.to) continue;
      const t = Math.min(1, (now - m.start) / 500);
      m.shown = t >= 1 ? m.to : m.from + (m.to - m.from) * smooth(t);
      h.needle.style.transform = `rotate(${-(h.start - 56 * m.shown)}deg)`;
    }
  }

  // ── speed ──

  private setSpeed(speed: number, maxSpeed: number | null, warping = false): void {
    const portion = maxSpeed && maxSpeed > 0 ? clamp01(speed / maxSpeed) : 0;
    if (Math.abs(portion - this.speedPortion) > 1e-4) {
      this.speedPortion = portion;
      this.needle.style.transform = `rotate(${-(45 + 90 * portion)}deg)`;
    }
    // activeShipController._GetSpeedFormatted: one decimal under 100 m/s, whole metres above
    // speedGauge.UpdateSpeedThread: in warp the label is UI/Inflight/WarpSpeedNotification with
    // UI/Inflight/Scanner/Warping, "(Warping)", not the speed
    const text = warping ? "(Warping)" : !Number.isFinite(speed) ? "" : speed < 100 ? `${(Math.round(speed * 10) / 10).toFixed(1)} m/s` : `${Math.trunc(speed).toLocaleString("en-US")} m/s`;
    if (text !== this.speedText) { this.speedText = text; this.speedLabel.textContent = text; }
  }

  // ── HP gauges ──

  /** gaugeN.png modulated by gaugeFill.png turned by pi * (1 - value): white where whole, red where damaged. */
  private drawGauges(): void {
    if (!this.fill) return;
    for (const g of this.gauges) {
      if (!g.tex || !g.morph || g.drawn === g.morph.shown) continue;
      const { ctx } = g;
      const w = ctx.canvas.width, h = ctx.canvas.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "copy";
      ctx.translate(w / 2, h / 2);
      ctx.rotate(-Math.PI * (1 - g.morph.shown));
      // the fill spans the sprite and turns about its centre; turned, it still covers the inscribed circle,
      // which holds every tick
      ctx.drawImage(this.fill, -w / 2, -h / 2, w, h);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const fill = ctx.getImageData(0, 0, w, h);
      const f = fill.data, t = g.tex.data;
      for (let i = 0; i < f.length; i += 4) {
        f[i] = (f[i]! * t[i]!) / 255; f[i + 1] = (f[i + 1]! * t[i + 1]!) / 255; f[i + 2] = (f[i + 2]! * t[i + 2]!) / 255;
        f[i + 3] = (f[i + 3]! * t[i + 3]!) / 255;
      }
      ctx.putImageData(fill, 0, 0);
      g.drawn = g.morph.shown;
    }
  }

  // ── capacitor ──

  private drawCapacitor(): void {
    const cell = this.capCellTex, glowTex = this.capGlowTex;
    if (!cell || !glowTex) return;
    // InitCapacitor: the column count from the capacity. With no capacity known yet, the client's most.
    const maxCap = this.capMax;
    const numcol = maxCap === null ? 18 : Math.min(18, Math.trunc(maxCap / 50));
    // Update: proportion = max(0, min(1, round(load / maxcap, 2)))
    const proportion = this.capRatio === null ? 0 : clamp01(Math.round(this.capRatio * 100) / 100);
    if (!this.capDirty && numcol === this.capColumns && proportion === this.capProportion) return;
    this.capDirty = false;
    this.capColumns = numcol;
    this.capProportion = proportion;

    const rotstep = 360 / Math.max(1, numcol);
    const colWidth = Math.max(12, Math.min(16, numcol ? Math.trunc(192 / numcol) : 0));
    // The cells, in powerCells order: the client inserts each new cell at the front, so the list runs from the
    // last column's innermost cell to the first column's outermost.
    type Cell = { col: number; ci: number };
    const cells: Cell[] = [];
    for (let i = 0; i < numcol; i++) for (let ci = 0; ci < 4; ci++) cells.unshift({ col: i, ci });
    const total = cells.length;
    const visible = Math.max(0, Math.min(total, Math.trunc(proportion * total)));

    // glowColor = bad * (1 - proportion) + good * proportion
    const glow = (k: number): number => COLOR_DARK_ORANGE[k]! * (1 - proportion) + COLOR_ORANGE[k]! * proportion;
    // A full cell: SetRGBA(0.125, 0.125, 0.125, 1) with that glow over it; an empty one SetRGBA(0.5, 0.5, 0.5, 0.5).
    // The native glow is not available here: it is taken as added light of glowColor over the cell's own shape.
    const full = tinted(cell, [Math.min(1, 0.125 + glow(0)), Math.min(1, 0.125 + glow(1)), Math.min(1, 0.125 + glow(2)), 1]);
    const shadow = tinted(cell, [0, 0, 0, 0.5]);
    const empty = tinted(cell, [0.5, 0.5, 0.5, 0.5]);

    const ctx = this.capCtx;
    const dpr = ctx.canvas.width / 60;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const colLeft = mid(60, colWidth), colTop = mid(60, 56);
    const cx = colLeft + colWidth / 2, cy = colTop + 28;
    const at = (c: Cell, dy: number): void => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, dy * dpr);
      ctx.translate(cx, cy);
      ctx.rotate((c.col * rotstep * Math.PI) / 180); // Transform rotation i * -rotstep: clockwise
      const w = 10 - c.ci * 2;
      ctx.translate(mid(colWidth, w) - colWidth / 2, c.ci * 5 - 28);
    };
    cells.forEach((c, idx) => {
      if (idx >= visible) return;
      at(c, 1); // shadowOffset (0, 1) on full cells
      ctx.drawImage(shadow, 0, 0, 10 - c.ci * 2, 7);
    });
    cells.forEach((c, idx) => {
      at(c, 0);
      ctx.drawImage(idx >= visible ? empty : full, 0, 0, 10 - c.ci * 2, 7);
    });

    // powerblink: capacitorCellGlow.png, COLOR_ORANGE, additive, on the last full cell while the capacitor is part full
    this.capBlinkHost.replaceChildren();
    if (visible !== 0 && visible < total) {
      const active = cells[visible - 1]!;
      const col = div(this.capBlinkHost, colLeft, colTop, colWidth, 56, "powerColumn");
      col.style.transformOrigin = "50% 50%";
      col.style.transform = `rotate(${active.col * rotstep}deg)`;
      const w = 10 - active.ci * 2 + 3;
      const blink = additive(glowTex, glowTex.naturalWidth, glowTex.naturalHeight, (r, g, b) => [r * COLOR_ORANGE[0] * 2, g * COLOR_ORANGE[1] * 2, b * COLOR_ORANGE[2] * 2]);
      blink.className = "add cap-blink";
      place(blink, mid(colWidth, w), active.ci * 5, w, 7);
      col.appendChild(blink);
    }
  }

  // ── HUD shape light ──

  /**
   * TR2_SFX_DOT: mainDOT.png's channels are lit by a dot product (the fitting window's fittingbase_dotproduct
   * glints as the pointer moves). The shader is native and not in the client's res files; the light is taken
   * here as the direction from the HUD's centre to the pointer: red from the right, green from below, blue
   * from the front.
   */
  private light(x: number | null, y: number | null): void {
    if (this.dot.length < 3) return;
    let lx = 0, ly = -0.8, lz = 0.6; // pointer unknown: as if it were above the HUD, at the screen's middle
    if (x !== null && y !== null) {
      const r = this.root.getBoundingClientRect();
      const dx = x - (r.left + SHAPE.left + 80), dy = y - (r.top + SHAPE.top + 80);
      const n = Math.hypot(dx, dy, 300);
      lx = dx / n; ly = dy / n; lz = 300 / n;
    }
    this.dot[0]!.style.opacity = Math.max(0, lx).toFixed(3);
    this.dot[1]!.style.opacity = Math.max(0, ly).toFixed(3);
    this.dot[2]!.style.opacity = Math.max(0, lz).toFixed(3);
  }

  // ── slots ──

  private slotsBox: HTMLElement | null = null;
  private modulesSig = "";
  private glows = new Map<number, HTMLElement>();
  private sweeps = new Map<number, HTMLElement>();

  /**
   * The ship's fitted modules into the rack (slotsContainer.FitSlot): each in its slot, a 48 px ModuleButton at
   * (64 - 48) / 2, the type's icon filling it, and while the module is active the slot glow (InitGlow: slotGlow.png,
   * padding 2, GLOWCOLOR (0.24, 0.67, 0.16, 0.75), blinking at 0.75 over a second). Empty slots are not drawn, as with
   * the client's default. A click is the module's (onModule).
   */
  setModules(modules: readonly HudModule[], onModule: (m: HudModule) => void, overload?: HudOverload): void {
    const sig = modules.map((m) => `${m.family}${m.index}:${m.itemID}:${m.online}`).join("|");
    if (sig !== this.modulesSig) {
      this.modulesSig = sig;
      this.slotsBox?.remove();
      this.glows.clear();
      this.sweeps.clear();
      this.overloadButtons.clear();
      this.rackButtons.clear();
      this.damageStates.clear();
      this.buildSlots({ hi: 0, med: 0, low: 0 }, modules, onModule);
    }
    this.overload = overload ?? null;
    this.checkOverload(modules);
    for (const m of modules) {
      const g = this.glows.get(m.itemID);
      if (g) g.style.display = m.active ? "" : "none";
      // The cycle, as the client's ramps sweep round a running module (ShipModuleButtonRamps): a share of the ring.
      const sw = this.sweeps.get(m.itemID);
      if (sw) {
        const p = m.active && typeof m.cycle === "number" ? Math.max(0, Math.min(1, m.cycle)) : null;
        sw.style.display = p === null ? "none" : "";
        if (p !== null) sw.style.setProperty("--p", `${(p * 360).toFixed(1)}deg`);
      }
    }
  }

  /** The slots' overload buttons and the racks' (by "Hi" / "Med" / "Lo"), with what they stand for now. */
  private readonly overloadButtons = new Map<number, { img: HTMLImageElement; module: HudModule; state: string; pending: { on: boolean; until: number } | null }>();
  /** The slots' damage states (DamageStateCont), with the damage they show. */
  private readonly damageStates = new Map<number, { img: HTMLImageElement; damage: number }>();
  private readonly rackButtons = new Map<string, { img: HTMLImageElement; activationID: number | null; active: boolean }>();
  private overload: HudOverload | null = null;

  /**
   * shipmodulebutton.py CheckOverload: a module with an overload effect has its button 1 px higher (top 5), On where
   * the effect is active, Off where not, Disabled while the module is offline; one with none Disabled (top 6).
   * slotsContainer.py CheckOverloadRackBtnState: each rack's button stands for the rack's first module
   * (activationID), On (StopOverloadingRack) where the rack has overload effects and none is off, else Off.
   */
  private checkOverload(modules: readonly HudModule[]): void {
    const now = performance.now();
    for (const m of modules) {
      this.setDamage(m);
      const b = this.overloadButtons.get(m.itemID);
      if (!b) continue;
      b.module = m;
      // UpdateOverloadState: while an overload asked for is pending, the button blinks - BlinkIn from 1.8 to 1 going
      // on, from 0.2 to 1 going off, 0.5 s, round and round - until the server's state says it is done
      if (b.pending && (!!m.overloaded === b.pending.on || now > b.pending.until)) b.pending = null;
      b.img.classList.toggle("ol-pending-on", b.pending?.on === true);
      b.img.classList.toggle("ol-pending-off", b.pending?.on === false);
      const state = m.overloadable ? (m.online ? (m.overloaded ? "On" : "Off") : "Disabled") : "Disabled";
      const key = `${state}:${m.overloadable ? 5 : 6}`;
      if (key === b.state) continue;
      b.state = key;
      b.img.src = TEX.slotOverload(state as "On" | "Off" | "Disabled");
      b.img.style.top = `${m.overloadable ? 5 : 6}px`;
      b.img.style.pointerEvents = state === "Disabled" ? "none" : "";
      b.img.title = state === "On" ? "Turn off overload" : state === "Off" ? "Turn on overload" : "";
    }
    for (const [key, family] of [["Hi", "high"], ["Med", "mid"], ["Lo", "low"]] as const) {
      const b = this.rackButtons.get(key);
      if (!b) continue;
      const rack = modules.filter((m) => m.family === family).sort((x, y) => x.index - y.index);
      b.activationID = rack[0]?.itemID ?? null;
      const withOverload = rack.filter((m) => m.overloadable);
      const active = withOverload.length > 0 && withOverload.every((m) => m.overloaded);
      if (active === b.active) continue;
      b.active = active;
      b.img.src = TEX.overloadBtn(key, active);
      b.img.title = active ? "Stop Overloading Rack" : "Overload rack";
    }
  }

  /**
   * shipmodulebutton.py SetDamage and ramps.py DamageStateCont: no damage (under 0.0001) hides it; else
   * slotDamage_<max(1, int(damage x 8))>.png over the whole slot, and at each new damage the sprite blinks twice
   * (BlinkSpriteA(ramp, 1.0, 2000 - 1000 x damage, 2): its alpha 1 -> 0 -> 1 each period, ending at 1).
   */
  private setDamage(m: HudModule): void {
    const d = this.damageStates.get(m.itemID);
    if (!d) return;
    const damage = m.damage ?? 0;
    if (damage === d.damage) return;
    d.damage = damage;
    if (!(damage >= 0.0001)) { d.img.style.display = "none"; return; }
    d.img.src = TEX.slotDamage(Math.max(1, Math.trunc(damage * 8)));
    d.img.style.display = "";
    d.img.title = `${(damage * 100).toFixed(1)}% damaged`;
    d.img.classList.remove("slot-damage-blink");
    void d.img.offsetWidth;
    d.img.style.setProperty("--t", `${Math.max(1, 2000 - 1000 * damage)}ms`);
    d.img.classList.add("slot-damage-blink");
  }

  private buildSlots(counts: { hi: number; med: number; low: number }, modules: readonly HudModule[] = [], onModule?: (m: HudModule) => void): void {
    const box = div(this.root, SLOTS_CONTAINER_LEFT - 8, mid(SHIP_UI_HEIGHT, SLOTS_CONTAINER_HEIGHT) + SLOTS_CONTAINER_TOP,
      SLOTS_CONTAINER_WIDTH, SLOTS_CONTAINER_HEIGHT, "slotsContainer");
    this.slotsBox = box;
    const fitted = new Map(modules.map((m) => [`${["high", "mid", "low"].indexOf(m.family)}:${m.index}`, m]));
    // InitSlots: xstep = int(ICONSIZE * 1.6), ystep = int(ICONSIZE * 1.4), grid [[1, 0], [1.5, 1], [1, 2]]
    const ICONSIZE = 32;
    const xstep = Math.trunc(ICONSIZE * 1.6), ystep = Math.trunc(ICONSIZE * 1.4);
    const grid = [[1.0, 0.0], [1.5, 1.0], [1.0, 2.0]] as const;
    const shown = [counts.hi, counts.med, counts.low].map((n) => Math.max(0, Math.min(8, Math.trunc(n))));
    const keys = ["F", "Alt-F", "Ctrl-F"];
    const hints = ["Empty high power slot", "Empty medium power slot", "Empty low power slot"];
    // Later children are drawn on top in the DOM; in the client the overload buttons come after the slots, so under them.
    for (const [i, key] of ["Hi", "Med", "Lo"].entries()) {
      const [x, y] = ([[13, 52], [20, 66], [13, 80]] as const)[i]!;
      const b = sprite(box, TEX.overloadBtn(key), x, y, 20, 20, `overloadBtn${key}`);
      b.className = "btn";
      b.title = "Overload rack";
      const rack = { img: b, activationID: null as number | null, active: false };
      this.rackButtons.set(key, rack);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (rack.activationID !== null) this.overload?.rack(rack.activationID, !rack.active);
      });
    }
    for (let r = 0; r < 3; r++) {
      const [x, y] = grid[r]!;
      for (let i = 0; i < 8; i++) {
        const module = fitted.get(`${r}:${i}`) ?? null;
        if (i >= shown[r]! && !module) continue;
        const slot = div(box, Math.trunc((x + i) * xstep - 40), Math.trunc(ystep * y), 64, 64, `inFlight${["High", "Medium", "Low"][r]}Slot${i + 1}`);
        slot.className = "btn";
        slot.title = hints[r]!;
        sprite(slot, TEX.slotMain, 0, 0, 64, 64, "mainshape");
        const ol = sprite(slot, TEX.slotOverload("Disabled"), 16, 6, 32, 16, "overloadBtn");
        const hint = document.createElement("div");
        hint.className = "label";
        hint.textContent = `${keys[r]}${i + 1}`;
        hint.style.color = "rgba(255,255,255,0.25)";
        hint.style.textShadow = "none"; // shadowOffset (0, 0)
        place(hint, 0, 30, 64);
        slot.appendChild(hint);
        if (module) {
          slot.title = module.name ?? "";
          const button = document.createElement("img");
          button.src = module.icon;
          button.alt = "";
          place(button, 8, 8, 48, 48);
          button.style.opacity = module.online ? "1" : "0.4";
          slot.appendChild(button);
          // slotGlow.png tinted GLOWCOLOR, as a mask over the colour
          const glow = document.createElement("div");
          place(glow, 10, 10, 44, 44);
          glow.className = "slot-glow";
          glow.style.setProperty("--glow", `url("${TEX.slotGlow}")`);
          slot.appendChild(glow);
          glow.style.display = module.active ? "" : "none";
          this.glows.set(module.itemID, glow);
          const sweep = document.createElement("div");
          place(sweep, 8, 8, 48, 48);
          sweep.className = "slot-sweep";
          sweep.style.display = "none";
          slot.appendChild(sweep);
          this.sweeps.set(module.itemID, sweep);
          slot.addEventListener("click", () => onModule?.(module));
          // its overload button (ToggleOverload), above the slot's own click
          const entry = { img: ol, module, state: "", pending: null as { on: boolean; until: number } | null };
          this.overloadButtons.set(module.itemID, entry);
          ol.style.zIndex = "2";
          ol.addEventListener("click", (e) => {
            e.stopPropagation();
            const m = entry.module;
            if (!m.overloadable || !m.online) return;
            entry.pending = { on: !m.overloaded, until: performance.now() + 10_000 };
            this.overload?.module(m, !m.overloaded);
          });
          // its damage state (SetDamage: made at the first damage, under the overload button)
          const damage = sprite(slot, TEX.slotDamage(1), 0, 0, 64, 64, "damageState");
          damage.style.display = "none";
          damage.style.zIndex = "1";
          this.damageStates.set(module.itemID, { img: damage, damage: 0 });
          continue;
        }
        const icon = sprite(slot, TEX.emptySlotIcon[r]!, mid(64, 24), 13, 24, 24, "emptySlotIcon");
        icon.style.opacity = "0.25";
      }
    }
  }
}
