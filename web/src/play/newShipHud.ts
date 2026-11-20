// The 24.02 new ship HUD ("new HUD preview", hud/client in build 3698585): the medallion - health ring, capacitor core,
// speedometer, heat bars and overload cluster - with the module tray to its right, in the client's 1182x200 band.
// Ported from the client's own Python (hud/client/hudLayer.py, medallion/*.py, moduleTray/*.py, common/hudConst.py)
// and drawn with its own res:/UI/HUD art served by the BFF at /client-res. Pixels are the client's at UI scale 1.
//
// Coordinates: "medallion space" has its origin on the medallion centre, x right and y down; "math" angles are degrees
// counter-clockwise from +x on screen (the ring code's own convention: a point is (r cos a, -r sin a)).
// Draw order: the canvas paints bottom to top in the client's order (carbonui draws its first child on top).

import type { HudModule, HudOverload, ShipHudState } from "./shipHud.ts";

const res = (path: string): string => `/client-res/${path.replace(/^res:\//i, "").toLowerCase()}`;
const HUD = (name: string) => res(`res:/UI/HUD/${name}.png`);

// hudConst.py
const SHIP_UI_WIDTH = 1182;
const SHIP_UI_HEIGHT = 200;
const HUD_BAND_LIFT = 20;
const HUD_BAND_DEFAULT_LEFT = 300;
const MEDALLION_CENTRE: readonly [number, number] = [175, 100];
const SLOT_SIZE = 52;
const SLOT_ICON_SIZE = 46;
const SLOT_COL_PITCH = 60;
const SLOT_ROW_PITCH = 52;
const SLOT_ROW_STAGGER = 30;
const TRAY_LEFT = 285; // hudLayer: mount 230 + MODULE_TRAY_LEFT 55, a ship without stances
const TRAY_TOP = 22; // (200 - 3 * 52) // 2

// eveColor.py
type RGBA = readonly [number, number, number, number];
const WHITE: RGBA = [1, 1, 1, 1];
const SMOKE_BLUE: RGBA = [0.188, 0.337, 0.396, 1];
const FOCUS_BLUE: RGBA = [0.345, 0.655, 0.749, 1];
const CHERRY_RED: RGBA = [0.6, 0.122, 0.141, 1];
const DANGER_RED: RGBA = [1, 0.271, 0.294, 1];
const LED_GREY: RGBA = [0.541, 0.541, 0.541, 1];
const css = (c: RGBA, a = c[3]): string => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
const withAlpha = (c: RGBA, a: number): RGBA => [c[0], c[1], c[2], a];
const scale = (c: RGBA, k: number): RGBA => [c[0] * k, c[1] * k, c[2] * k, c[3]];

// healthRing.py / ringLayout.py
const R_TRACK_IN = 49;
const R_TRACK_OUT = 81;
const R_DIAL_IN = 73;
const ARC_START = 45;
const ARC_END = 315;
const GAP_DEG = 2.85;
const BEVEL_SLOPE = 1.55;
const BEVEL_INNER = 3.4;
const BEVEL_EDGE = 8.6;
const DIAL_MID = 77; // ScaleDpi(76.5)
const DIAL_WIDTH = 7;
const R_ICON = 65;
const MIN_SPAN = 2 * Math.asin((24 + 2 * 5) / 2 / R_ICON) * 180 / Math.PI; // 30.3227
const LOST_DIAL: RGBA = [0.49, 0.161, 0.173, 1];
const ALERT_FLASH: RGBA = [1, 0.25, 0.25, 1];

// speedometer.py
const DEG_ZERO = 210;
const DEG_FULL = 150;
const BAND_DRAW_MIN = 154.374;
const BAND_DRAW_MAX = 205.626;
const SPEED_R_IN = 97;
const SPEED_R_OUT = 113;
const PICK_R_IN = 90;
const PICK_R_OUT = 122;
const TICK_SPAN = 50.3194;

// capacitorCore.py
const VARIANT_SPOKES = [4, 6, 8, 12, 24] as const;
const PIECE_CUTS = [0.482, 0.589, 0.696, 0.803, 0.91, 1.0] as const;
const CAP_RADIUS = 28;
const CAP_BLINK_MS = 375;

// heatGauges.py: each bar's centre (medallion space, after the +8 tail shift) and its clockwise rotation
const HEAT_BARS = [
  { rack: "Hi" as const, x: 88.43, y: -20.05, rot: 30 },
  { rack: "Med" as const, x: 100.02, y: 0.28, rot: 90 },
  { rack: "Lo" as const, x: 88.22, y: 19.56, rot: 150 },
];
const OVERLOAD_CENTRE: readonly [number, number] = [77, 0];
const RACK_BUTTONS = [
  { rack: "Hi" as const, family: "high" as const, x: 94, y: -29, glyph: "rack_glyph_high" },
  { rack: "Med" as const, family: "mid" as const, x: 110, y: 0, glyph: "rack_glyph_mid" },
  { rack: "Lo" as const, family: "low" as const, x: 94, y: 29, glyph: "rack_glyph_low" },
];

const rad = (deg: number): number => deg * Math.PI / 180;

// ── textures ─────────────────────────────────────────────────────────────────────────────────────────────

const images = new Map<string, HTMLImageElement>();
function image(url: string): HTMLImageElement | null {
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.src = url;
    images.set(url, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

// ── health ring geometry (ringLayout.py) ──────────────────────────────────────────────────────────────────

/** ringLayout.Allocate: spans proportional to the pools' max HP, none under the icon floor. */
export function allocateSpans(values: readonly number[], budget: number, floor: number): number[] {
  const n = values.length;
  const pinned = new Array<boolean>(n).fill(false);
  for (;;) {
    const freeBudget = budget - floor * pinned.filter(Boolean).length;
    const freeTotal = values.reduce((s, v, i) => s + (pinned[i] ? 0 : Math.max(0, v)), 0);
    const spans = values.map((v, i) => pinned[i] ? floor : freeTotal > 0 ? freeBudget * Math.max(0, v) / freeTotal : freeBudget / Math.max(1, n - pinned.filter(Boolean).length));
    const under = spans.findIndex((s, i) => !pinned[i] && s < floor);
    if (under < 0) return spans;
    pinned[under] = true;
  }
}

interface Segment { a0: number; a1: number; share: number; chamfers: Chamfer[] }
interface Chamfer { p1: [number, number]; p2: [number, number]; w0: number; w1: number }

const polar = (r: number, deg: number): [number, number] => [r * Math.cos(rad(deg)), r * Math.sin(rad(deg))];

/** The segment's two inner chamfers (ringLayout.py 82 to 160): a straight cut from (r_bev, end) to (49, end +- dth). */
function chamfersOf(a0: number, a1: number): Chamfer[] {
  const size0 = a0 <= ARC_START + 1e-6 ? BEVEL_EDGE : BEVEL_INNER;
  const size1 = a1 >= ARC_END - 1e-6 ? BEVEL_EDGE : BEVEL_INNER;
  let d0 = size0 / R_TRACK_IN * 180 / Math.PI;
  let d1 = size1 / R_TRACK_IN * 180 / Math.PI;
  let rb0 = R_TRACK_IN + BEVEL_SLOPE * size0;
  let rb1 = R_TRACK_IN + BEVEL_SLOPE * size1;
  const span = a1 - a0;
  if (d0 + d1 > 0.9 * span) {
    const k = 0.9 * span / (d0 + d1);
    d0 *= k; d1 *= k;
    rb0 = R_TRACK_IN + BEVEL_SLOPE * rad(d0) * R_TRACK_IN;
    rb1 = R_TRACK_IN + BEVEL_SLOPE * rad(d1) * R_TRACK_IN;
  }
  return [
    { p1: polar(rb0, a0), p2: polar(R_TRACK_IN, a0 + d0), w0: a0, w1: a0 + d0 },
    { p1: polar(rb1, a1), p2: polar(R_TRACK_IN, a1 - d1), w0: a1 - d1, w1: a1 },
  ];
}

/** InnerRadiusAt: where the ray at `deg` leaves the chamfered inner edge (49, or out on a chamfer line). */
function innerRadiusAt(seg: Segment, deg: number): number {
  let r = R_TRACK_IN;
  const u: [number, number] = [Math.cos(rad(deg)), Math.sin(rad(deg))];
  for (const c of seg.chamfers) {
    if (deg < c.w0 - 1e-9 || deg > c.w1 + 1e-9) continue;
    const d: [number, number] = [c.p2[0] - c.p1[0], c.p2[1] - c.p1[1]];
    const den = u[0] * d[1] - u[1] * d[0];
    if (Math.abs(den) < 1e-9) continue;
    const hit = (c.p1[0] * d[1] - c.p1[1] * d[0]) / den;
    if (hit > r) r = hit;
  }
  return r;
}

export function layoutRing(maxHP: readonly number[]): Segment[] {
  const n = maxHP.length;
  const spans = allocateSpans(maxHP, ARC_END - ARC_START - GAP_DEG * (n - 1), MIN_SPAN);
  const total = maxHP.reduce((s, v) => s + Math.max(0, v), 0);
  const out: Segment[] = [];
  let cursor = ARC_START;
  for (let i = 0; i < n; i++) {
    const a0 = cursor;
    const a1 = i === n - 1 ? ARC_END : a0 + spans[i]!;
    out.push({ a0, a1, share: total > 0 ? maxHP[i]! / total : 1 / n, chamfers: chamfersOf(a0, a1) });
    cursor = a1 + GAP_DEG;
  }
  return out;
}

// ── the HUD ──────────────────────────────────────────────────────────────────────────────────────────────

interface Pool { target: number | null; shown: number | null; ghost: number | null; holdUntil: number }

interface Slot {
  el: HTMLDivElement;
  icon: HTMLImageElement;
  qty: HTMLDivElement;
  badge: HTMLDivElement;
  shortcut: HTMLDivElement;
  x: number;
  y: number;
  module: HudModule | null;
  hover: boolean;
  /** The wedge's eased angle, half-span and colour, as activationIndicator morphs them. */
  wedge: { angle: number; half: number; lit: number };
  cycles: number;
  flashAt: number;
}

/** A ship hold the cargo indicator can track (the bays' keys: cargo, ore, drone ...). */
export interface HudHold {
  readonly key: string;
  readonly label: string;
  readonly used: number | null;
  readonly capacity: number | null;
}

/** cargo_indicator.py's glyph per hold kind (eveicon, 16 px): inventory, mining, drones, else the ship's areas. */
const holdGlyph = (key: string): string => res(`res:/UI/Texture/eveicon/${
  key === "cargo" ? "system_icons/inventory" : /ore|mining|asteroid|ice|gas/.test(key) ? "system_icons/mining" : /drone|fighter/.test(key) ? "category_icons/drones" : "category_icons/ship_areas"}_16px.png`);

/** Extra readings the new HUD shows beyond the classic's state: each pool's max HP, for the ring's segment spans. */
export interface NewShipHudState extends ShipHudState {
  shieldMax?: number | null;
  armorMax?: number | null;
  hullMax?: number | null;
  /** The ship's wanted speed fraction (activeShipController.GetDesiredSpeedPortion), when it is known. */
  desiredRatio?: number | null;
}

export class NewShipHud {
  readonly root = document.createElement("div");
  onStop: () => void = () => {};
  onFullSpeed: () => void = () => {};
  /** activeShipController.SetSpeed: the speedometer clicked at a ratio of the ship's max speed. */
  onSetSpeed: (ratio: number) => void = () => {};
  /** CargoIndicator.OnClick: Inventory opened on the tracked hold (OpenOrShow((holdID, shipID), toggle=True)). */
  onOpenHold: (key: string) => void = () => {};
  /** A client command run from a HUD button (the scanner pill's, CmdToggleAutopilot): the page runs it as its shortcut would. */
  onCommand: (cmd: string) => void = () => {};
  private autopilotOn = false;
  private readonly autopilotRing = document.createElement("div");
  private readonly scannerGroup = document.createElement("div");

  // cargo_indicator.py: the tracked hold's fill ring around a 32 px button at band (25, 64)
  private holds: readonly HudHold[] = [];
  private trackedHold = "cargo";
  private holdShipType: number | null = null;
  private cargoHover = false;
  private readonly cargoGlyph = document.createElement("img");
  private readonly holdPicker = document.createElement("div");

  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly speedLabel = document.createElement("div");
  private readonly tray = document.createElement("div");
  private readonly slots: Slot[] = [];
  private state: NewShipHudState | null = null;
  private readonly pools: Pool[] = [0, 1, 2].map(() => ({ target: null, shown: null, ghost: null, holdUntil: 0 }));
  private segments: Segment[] = layoutRing([1, 1, 1]);
  private segmentsKey = "";
  private speedShown: number | null = null;
  private speedHover = false;
  private hoverDeg: number | null = null;
  private desiredFromPreset = true;
  private heatShown: Record<"Hi" | "Med" | "Lo", number> = { Hi: 0, Med: 0, Lo: 0 };
  private overloadMode = false;
  private overloadHover = false;
  private rackHover: "Hi" | "Med" | "Lo" | null = null;
  private overload: HudOverload | null = null;
  private modules: readonly HudModule[] = [];
  private onModule: ((m: HudModule) => void) | null = null;
  private damageFlash: { level: number; until: number; period: number } | null = null;
  private capFlashUntil = 0;
  private frame = 0;
  private lastFrame = performance.now();
  private disposed = false;
  private readonly started = performance.now();

  constructor() {
    const root = this.root;
    root.className = "new-hud-root";
    Object.assign(root.style, {
      position: "absolute", bottom: `${HUD_BAND_LIFT}px`, left: `calc(50% - ${SHIP_UI_WIDTH / 2}px + ${HUD_BAND_DEFAULT_LEFT}px)`,
      width: `${SHIP_UI_WIDTH}px`, height: `${SHIP_UI_HEIGHT}px`, pointerEvents: "none", userSelect: "none",
    });
    const [cx, cy] = MEDALLION_CENTRE;
    // medallion.py: the plate (frosted scene through medallion_plate.png's alpha) over the capacitor backing.
    root.append(
      this.frosted(cx - 46, cy - 46, 92, 92, HUD("capacitor_backing"), 0.85),
      this.frosted(cx - 88, cy - 100, 200, 200, HUD("medallion_plate"), 0.7),
    );
    for (let i = 0; i < 5; i++) image(HUD(`capacitor_0${i}`));
    for (const n of ["rack_gauge_bar", "overload_hex_outline", "overload_hex_fill", "overload_hex_fill_inset", "rack_glyph_high", "rack_glyph_mid", "rack_glyph_low"]) image(HUD(n));

    const dpr = Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1));
    this.canvas.width = SHIP_UI_WIDTH * dpr;
    this.canvas.height = SHIP_UI_HEIGHT * dpr;
    Object.assign(this.canvas.style, { position: "absolute", left: "0", top: "0", width: `${SHIP_UI_WIDTH}px`, height: `${SHIP_UI_HEIGHT}px`, pointerEvents: "none" });
    this.ctx = this.canvas.getContext("2d")!;
    this.ctx.scale(dpr, dpr);

    // The tray's slots sit under the canvas's rings: their discs and icons are DOM, the rings are painted over them.
    Object.assign(this.tray.style, { position: "absolute", left: `${TRAY_LEFT}px`, top: `${TRAY_TOP}px`, width: "502px", height: `${3 * SLOT_ROW_PITCH}px` });
    root.append(this.tray, this.canvas);
    this.buildSlots();
    this.buildMedallionInputs();
    this.buildCargoIndicator();
    this.buildButtons();

    // speedometer.py _ConstructReadout: the 75x16 pill at medallion (-135..-60, 68..84), its text right-aligned 4 px in.
    const pill = document.createElement("div");
    Object.assign(pill.style, {
      position: "absolute", left: `${cx - 135}px`, top: `${cy + 68}px`, width: "75px", height: "16px", borderRadius: "8px",
      background: css(SMOKE_BLUE, 0.2), pointerEvents: "auto",
    });
    Object.assign(this.speedLabel.style, {
      position: "absolute", right: "4px", top: "0", lineHeight: "16px", font: "bold 11px 'EVE Sans Neue', 'Segoe UI', sans-serif",
      color: "rgba(255,255,255,0.5)", textShadow: "1px 1px 0 rgba(0,0,0,0.6)", whiteSpace: "nowrap",
    });
    pill.append(this.speedLabel);
    pill.addEventListener("mouseenter", () => { pill.style.background = css(FOCUS_BLUE, 0.5); this.speedLabel.style.color = "#fff"; });
    pill.addEventListener("mouseleave", () => { pill.style.background = css(SMOKE_BLUE, 0.2); this.speedLabel.style.color = "rgba(255,255,255,0.5)"; });
    pill.title = "Current Speed";
    root.append(pill);

    const tick = () => {
      if (this.disposed) return;
      this.draw();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  /** ThemedSceneSprite: the scene behind, blurred, through the PNG's alpha, tinted by the theme (SMOKE_BLUE at 0.35 saturation). */
  private frosted(x: number, y: number, w: number, h: number, mask: string, brightness: number): HTMLDivElement {
    const d = document.createElement("div");
    const tint = brightness >= 0.85 ? "rgba(177,206,217,0.10)" : "rgba(146,169,179,0.10)";
    Object.assign(d.style, {
      position: "absolute", left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`,
      background: tint, backdropFilter: `blur(3px) brightness(${(brightness * 0.9).toFixed(2)})`,
      maskImage: `url("${mask}")`, maskSize: `${w}px ${h}px`, maskRepeat: "no-repeat",
      webkitMaskImage: `url("${mask}")`, webkitMaskSize: `${w}px ${h}px`, webkitMaskRepeat: "no-repeat",
    } as Partial<CSSStyleDeclaration>);
    return d;
  }

  // ── inputs ─────────────────────────────────────────────────────────────────────────────────────────────

  private buildMedallionInputs(): void {
    const [cx, cy] = MEDALLION_CENTRE;
    // The speedometer widget, 75x160 at medallion (-135, -76): every action wants the cursor 90..122 px out.
    const speed = document.createElement("div");
    Object.assign(speed.style, { position: "absolute", left: `${cx - 135}px`, top: `${cy - 76}px`, width: "75px", height: "144px", pointerEvents: "auto", cursor: "pointer" });
    const angleAt = (ev: MouseEvent): { deg: number; r: number } => {
      const box = this.root.getBoundingClientRect();
      const x = ev.clientX - box.left - cx;
      const y = ev.clientY - box.top - cy;
      return { deg: ((Math.atan2(-y, x) * 180 / Math.PI) + 360) % 360, r: Math.hypot(x, y) };
    };
    speed.addEventListener("mouseenter", () => { this.speedHover = true; });
    speed.addEventListener("mouseleave", () => { this.speedHover = false; this.hoverDeg = null; });
    speed.addEventListener("mousemove", (ev) => {
      const { deg, r } = angleAt(ev);
      this.hoverDeg = r >= PICK_R_IN && r <= PICK_R_OUT ? degOf(ratioOf(deg)) : null;
    });
    speed.addEventListener("click", (ev) => {
      if (this.state?.warping) return;
      const { deg, r } = angleAt(ev);
      if (r < PICK_R_IN || r > PICK_R_OUT) return;
      this.desiredFromPreset = false;
      this.onSetSpeed(ratioOf(deg));
    });
    this.root.append(speed);
    // The command buttons on the band's ends: full speed at (-88, -56), stop at (-88, +56).
    for (const [dy, title, glyph, act] of [
      [-56, "Set Full Speed", "M5 4l4 4-4 4M9 4l4 4-4 4", () => { this.desiredFromPreset = true; this.onFullSpeed(); }],
      [56, "Stop The Ship", "M6 4l4 4-4 4M12 3v10", () => { this.desiredFromPreset = true; this.onStop(); }],
    ] as const) {
      const b = document.createElement("button");
      b.type = "button";
      b.title = title;
      b.className = "new-hud-cmd";
      Object.assign(b.style, { position: "absolute", left: `${cx - 88 - 12}px`, top: `${cy + dy - 12}px`, width: "24px", height: "24px", pointerEvents: "auto" });
      b.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16"><path d="${glyph}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      b.addEventListener("mouseenter", () => { this.speedHover = true; });
      b.addEventListener("mouseleave", () => { this.speedHover = false; });
      b.addEventListener("click", act);
      this.root.append(b);
    }
    // overloadButton.py: the 32 px hex at (+77, 0) toggles overload mode; the rack buttons open around it.
    const hex = (x: number, y: number) => {
      const h = document.createElement("div");
      Object.assign(h.style, { position: "absolute", left: `${cx + x - 16}px`, top: `${cy + y - 16}px`, width: "32px", height: "32px", pointerEvents: "auto", cursor: "pointer", clipPath: "polygon(25% 3%, 75% 3%, 100% 50%, 75% 97%, 25% 97%, 0 50%)" });
      this.root.append(h);
      return h;
    };
    const ob = hex(OVERLOAD_CENTRE[0], OVERLOAD_CENTRE[1]);
    ob.title = "Heat Status";
    ob.addEventListener("mouseenter", () => { this.overloadHover = true; });
    ob.addEventListener("mouseleave", () => { this.overloadHover = false; });
    ob.addEventListener("click", () => { this.overloadMode = !this.overloadMode; this.syncRackButtons(); });
    for (const b of RACK_BUTTONS) {
      const h = hex(b.x, b.y);
      h.dataset.rack = b.rack;
      h.style.display = "none";
      h.addEventListener("mouseenter", () => { this.rackHover = b.rack; });
      h.addEventListener("mouseleave", () => { if (this.rackHover === b.rack) this.rackHover = null; });
      h.addEventListener("click", () => { this.toggleRackOverload(b.rack); });
    }
  }

  private buildCargoIndicator(): void {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "new-hud-cargo";
    Object.assign(b.style, {
      position: "absolute", left: `${25 - 16}px`, top: `${64 - 16}px`, width: "32px", height: "32px", padding: "0", border: "0",
      borderRadius: "50%", background: "transparent", pointerEvents: "auto", cursor: "pointer", display: "grid", placeItems: "center",
    });
    Object.assign(this.cargoGlyph.style, { width: "16px", height: "16px", mixBlendMode: "plus-lighter" });
    this.cargoGlyph.alt = "";
    this.cargoGlyph.src = holdGlyph("cargo");
    b.append(this.cargoGlyph);
    b.addEventListener("mouseenter", () => { this.cargoHover = true; });
    b.addEventListener("mouseleave", () => { this.cargoHover = false; });
    b.addEventListener("mousedown", () => { b.style.transform = "translateY(2px)"; });
    b.addEventListener("mouseup", () => { b.style.transform = ""; });
    b.addEventListener("click", () => { this.holdPicker.style.display = "none"; this.onOpenHold(this.trackedHold); });
    // Right-click: the hold picker (two holds or more), the current hold last and centred on the button, the rest above.
    b.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (this.holds.length < 2) return;
      const order = [...this.holds.filter((h) => h.key !== this.trackedHold)].sort((x, y) => (x.key === "cargo" ? -1 : y.key === "cargo" ? 1 : 0));
      const current = this.holds.find((h) => h.key === this.trackedHold);
      const items = current ? [...order, current] : order;
      this.holdPicker.replaceChildren(...items.map((h) => {
        const i = document.createElement("button");
        i.type = "button";
        i.title = h.label;
        Object.assign(i.style, { width: "16px", height: "16px", margin: "4px", padding: "0", border: "0", background: "transparent", cursor: "pointer", display: "block" });
        const g = document.createElement("img");
        g.src = holdGlyph(h.key);
        g.alt = "";
        Object.assign(g.style, { width: "16px", height: "16px" });
        i.append(g);
        i.addEventListener("click", () => { this.setTrackedHold(h.key); this.holdPicker.style.display = "none"; });
        return i;
      }));
      const height = (items.length - 1) * 24 + 16 + 8;
      Object.assign(this.holdPicker.style, { display: "", left: `${25 - 12}px`, top: `${64 + 12 - height}px`, height: `${height}px` });
    });
    Object.assign(this.holdPicker.style, {
      position: "absolute", width: "24px", borderRadius: "12px", background: "rgba(0,0,0,0.8)", display: "none", pointerEvents: "auto",
    });
    this.holdPicker.addEventListener("mouseleave", () => { this.holdPicker.style.display = "none"; });
    this.root.append(b, this.holdPicker);
  }

  /**
   * The buttons around the medallion and right of the tray: the autopilot (commandButton, medallion (-69, -78)), the
   * HUD settings gear ((+70, -78)), the overload hex's overheating glyph, the camera button (utility column (25, 158)),
   * and the scanner group (hudLayer: the safety badge at its top, the scanner pill centred).
   */
  private buildButtons(): void {
    const [cx, cy] = MEDALLION_CENTRE;
    const icon = (path: string, size = 16) => {
      const i = document.createElement("img");
      i.src = res(path);
      i.alt = "";
      Object.assign(i.style, { width: `${size}px`, height: `${size}px`, display: "block", pointerEvents: "none" });
      return i;
    };
    // the autopilot: a 20 px dark disc, a 1 px ring at r 11 (white 0.1, FOCUS_BLUE engaged or hovered), the glyph
    const ap = document.createElement("button");
    ap.type = "button";
    ap.title = "Activate Autopilot";
    Object.assign(ap.style, { position: "absolute", left: `${cx - 69 - 12}px`, top: `${cy - 78 - 12}px`, width: "24px", height: "24px", padding: "0", border: "0", background: "transparent", pointerEvents: "auto", cursor: "pointer", display: "grid", placeItems: "center" });
    Object.assign(this.autopilotRing.style, { position: "absolute", inset: "1px", borderRadius: "50%", background: "rgba(0,0,0,0.55)", boxShadow: "0 0 0 2px rgba(255,255,255,0.1) inset" });
    const apGlyph = icon("res:/UI/Texture/Icons/44_32_12.png");
    Object.assign(apGlyph.style, { position: "relative", opacity: "0.5", mixBlendMode: "plus-lighter" });
    ap.append(this.autopilotRing, apGlyph);
    ap.addEventListener("mouseenter", () => { apGlyph.style.opacity = "0.9"; this.autopilotRing.style.boxShadow = `0 0 0 2px ${css(FOCUS_BLUE)} inset`; });
    ap.addEventListener("mouseleave", () => { apGlyph.style.opacity = this.autopilotOn ? "0.9" : "0.5"; this.syncAutopilot(); });
    ap.addEventListener("click", () => this.onCommand("CmdToggleAutopilot"));
    // the HUD settings gear: opacity 0.5, 0.9 hovered
    const gear = document.createElement("button");
    gear.type = "button";
    gear.title = "HUD settings";
    Object.assign(gear.style, { position: "absolute", left: `${cx + 70 - 8}px`, top: `${cy - 78 - 8}px`, width: "16px", height: "16px", padding: "0", border: "0", background: "transparent", opacity: "0.5", pointerEvents: "auto", cursor: "pointer" });
    gear.append(icon("res:/UI/Texture/eveicon/system_icons/settings_16px.png"));
    gear.addEventListener("mouseenter", () => { gear.style.opacity = "0.9"; });
    gear.addEventListener("mouseleave", () => { gear.style.opacity = "0.5"; });
    // the settings menu (hudLayer 360 to 385), here only the preview switch: off goes back to the classic ship UI
    const menu = document.createElement("div");
    Object.assign(menu.style, { position: "absolute", left: `${cx + 70}px`, top: `${cy - 78 - 40}px`, display: "none", background: "rgba(10,14,16,0.95)", border: "1px solid rgba(255,255,255,0.15)", padding: "4px 0", pointerEvents: "auto", font: "12px 'EVE Sans Neue','Segoe UI',sans-serif", color: "#ddd", whiteSpace: "nowrap" });
    const entry = document.createElement("button");
    entry.type = "button";
    entry.textContent = "✓ New Ship HUD (preview)";
    Object.assign(entry.style, { display: "block", padding: "4px 12px", border: "0", background: "transparent", color: "inherit", font: "inherit", cursor: "pointer" });
    entry.addEventListener("click", () => { menu.style.display = "none"; this.onCommand("ToggleNewHud"); });
    menu.append(entry);
    menu.addEventListener("mouseleave", () => { menu.style.display = "none"; });
    gear.addEventListener("click", () => { menu.style.display = menu.style.display === "none" ? "" : "none"; });
    this.root.append(menu);
    // overloadButton: the overheating glyph in the hex (white 0.75 idle)
    const heat = icon("res:/UI/Texture/eveicon/category_icons/overheating_16px.png");
    Object.assign(heat.style, { position: "absolute", left: `${cx + OVERLOAD_CENTRE[0] - 8}px`, top: `${cy + OVERLOAD_CENTRE[1] - 8}px`, opacity: "0.75" });
    // the camera flyout's header: the orbit camera's glyph (idle 0.8)
    const cam = document.createElement("button");
    cam.type = "button";
    cam.title = "Orbit Camera";
    Object.assign(cam.style, {
      position: "absolute", left: `${25 - 16}px`, top: `${158 - 16}px`, width: "32px", height: "32px", padding: "0", borderRadius: "50%",
      border: "0", background: "radial-gradient(circle, rgba(0,0,0,0.1) 0 14px, transparent 14.5px), radial-gradient(circle, rgba(0,0,0,0.4) 0 15px, transparent 15.5px)",
      boxShadow: "0 0 0 2px rgba(255,255,255,0.2)", pointerEvents: "auto", display: "grid", placeItems: "center",
    });
    const camGlyph = icon("res:/UI/Texture/eveicon/category_icons/orbit_camera_16px.png");
    camGlyph.style.opacity = "0.8";
    cam.append(camGlyph);
    // the scanner group: 70x200, right of the tray; the safety badge (32x16 at (19, 12)) and the 24x105 pill
    Object.assign(this.scannerGroup.style, { position: "absolute", top: "0", width: "70px", height: "200px", pointerEvents: "none" });
    const badge = document.createElement("div");
    badge.title = "Safety: Green";
    Object.assign(badge.style, { position: "absolute", left: "27px", top: "12px", width: "16px", height: "16px", pointerEvents: "auto" });
    const tint = document.createElement("div");
    Object.assign(tint.style, { position: "absolute", inset: "0", background: "#8DC169", maskImage: `url("${res("res:/UI/HUD/safety_shield_backing.png")}")`, maskSize: "16px 16px", webkitMaskImage: `url("${res("res:/UI/HUD/safety_shield_backing.png")}")`, webkitMaskSize: "16px 16px" } as Partial<CSSStyleDeclaration>);
    const glyph = icon("res:/UI/HUD/safety_glyph_full.png");
    Object.assign(glyph.style, { position: "absolute", left: "0", top: "0" });
    badge.append(tint, glyph);
    const pill = document.createElement("div");
    Object.assign(pill.style, {
      position: "absolute", left: "23px", top: "47.5px", width: "24px", height: "105px", borderRadius: "12px",
      background: "rgba(0,0,0,0.6)", boxShadow: "0 0 0 1px rgba(255,255,255,0.4)", pointerEvents: "auto",
    });
    for (const [top, cmd, id, title] of [
      [0, "CmdToggleSolarSystemMap", "solar_system", "Solar System Map"],
      [33, "OpenMoonScan", "moon_scan", "Moon Analysis"],
      [57, "ToggleProbeScanner", "probe_scan", "Probe Scanner"],
      [81, "OpenDirectionalScanner", "d_scan", "Directional Scanner"],
    ] as const) {
      const b = document.createElement("button");
      b.type = "button";
      b.title = title;
      Object.assign(b.style, { position: "absolute", left: "0", top: `${top}px`, width: "24px", height: "24px", padding: "0", border: "0", background: "transparent", cursor: "pointer", display: "grid", placeItems: "center" });
      const g = icon(`res:/UI/Texture/eveicon/category_icons/${id}_16px.png`);
      g.style.opacity = "0.5";
      b.append(g);
      b.addEventListener("mouseenter", () => { g.style.opacity = "1"; g.style.width = g.style.height = "20px"; });
      b.addEventListener("mouseleave", () => { g.style.opacity = "0.5"; g.style.width = g.style.height = "16px"; });
      b.addEventListener("click", () => this.onCommand(cmd));
      pill.append(b);
    }
    const sep = document.createElement("div");
    Object.assign(sep.style, { position: "absolute", left: "6px", top: "28px", width: "12px", height: "1px", background: "rgba(255,255,255,0.1)" });
    pill.append(sep);
    this.scannerGroup.append(badge, pill);
    this.root.append(ap, gear, heat, cam, this.scannerGroup);
    this.placeScannerGroup();
  }

  /** hudLayer: the scanner group at band x mount.left (230) + max(70, 55 + the tray's width). */
  private placeScannerGroup(): void {
    const shown = this.slots.filter((s) => s.module);
    const trayWidth = shown.length ? Math.max(...shown.map((s) => s.x)) + SLOT_SIZE : 0;
    this.scannerGroup.style.left = `${230 + Math.max(70, 55 + trayWidth)}px`;
  }

  /** autoPilot's state (OnAutoPilotOn / Off): the button's ring and glyph lit while engaged. */
  setAutopilot(on: boolean): void {
    if (on === this.autopilotOn) return;
    this.autopilotOn = on;
    this.syncAutopilot();
  }

  private syncAutopilot(): void {
    this.autopilotRing.style.boxShadow = `0 0 0 2px ${this.autopilotOn ? css(FOCUS_BLUE) : "rgba(255,255,255,0.1)"} inset`;
    (this.autopilotRing.parentElement as HTMLElement | null)?.setAttribute("title", this.autopilotOn ? "Deactivate Autopilot" : "Activate Autopilot");
  }

  /** holdTrackerSettings: the tracked hold, kept per ship type, the cargo hold where none is kept. */
  private setTrackedHold(key: string): void {
    this.trackedHold = key;
    this.cargoGlyph.src = holdGlyph(key);
    try { if (this.holdShipType !== null) globalThis.localStorage?.setItem(`evejs.ui.trackedHold.${this.holdShipType}`, key); } catch { /* storage refused */ }
  }

  /** The ship's holds as read, and its type, for the cargo indicator. */
  setHolds(holds: readonly HudHold[], shipTypeID: number | null): void {
    this.holds = holds;
    if (shipTypeID !== this.holdShipType) {
      this.holdShipType = shipTypeID;
      let kept: string | null = null;
      try { kept = shipTypeID === null ? null : globalThis.localStorage?.getItem(`evejs.ui.trackedHold.${shipTypeID}`) ?? null; } catch { kept = null; }
      this.trackedHold = kept ?? "cargo";
      this.cargoGlyph.src = holdGlyph(this.trackedHold);
    }
    if (holds.length > 0 && !holds.some((h) => h.key === this.trackedHold)) {
      this.trackedHold = holds.some((h) => h.key === "cargo") ? "cargo" : holds[0]!.key;
      this.cargoGlyph.src = holdGlyph(this.trackedHold);
    }
    const h = holds.find((x) => x.key === this.trackedHold);
    const pct = h && h.capacity ? Math.round(100 * (h.used ?? 0) / h.capacity) : null;
    (this.cargoGlyph.parentElement as HTMLElement | null)?.setAttribute("title", h ? `${h.label}${pct === null ? "" : ` ${pct}%`}` : "Cargo");
  }

  /** cargo_indicator: track r 22.5 w 8 black 0.2 (0.6 hovered), the fill r 22.5 w 3 from 12 o'clock counter-clockwise. */
  private drawCargo(c: CanvasRenderingContext2D): void {
    const cx = 25, cy = 64;
    c.beginPath();
    c.arc(cx, cy, 15, 0, Math.PI * 2);
    c.fillStyle = this.cargoHover ? "rgba(0,0,0,0.8)" : "rgba(0,0,0,0.4)";
    c.fill();
    c.beginPath();
    c.arc(cx, cy, 22.5, 0, Math.PI * 2);
    c.lineWidth = 8;
    c.strokeStyle = this.cargoHover ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.2)";
    c.stroke();
    const h = this.holds.find((x) => x.key === this.trackedHold);
    const ratio = h && h.capacity ? Math.max(0, Math.min(1, (h.used ?? 0) / h.capacity)) : 0;
    if (ratio <= 0) return;
    const colour = ratio >= 0.999 ? "#9F583A" : this.cargoHover ? "#58A7BF" : "#305665";
    c.save();
    c.globalCompositeOperation = "lighter";
    c.beginPath();
    c.arc(cx, cy, 22.5, 1.5 * Math.PI - 2 * Math.PI * ratio, 1.5 * Math.PI);
    c.lineWidth = 3;
    c.strokeStyle = colour;
    c.shadowColor = colour;
    c.shadowBlur = 2;
    c.stroke();
    c.restore();
  }

  private syncRackButtons(): void {
    for (const el of this.root.querySelectorAll<HTMLDivElement>("[data-rack]")) el.style.display = this.overloadMode ? "" : "none";
  }

  private buildSlots(): void {
    for (let position = 0; position < 24; position++) {
      const row = Math.floor(position / 8);
      const col = position % 8;
      const x = col * SLOT_COL_PITCH + (row === 1 ? SLOT_ROW_STAGGER : 0);
      const y = row * SLOT_ROW_PITCH;
      const el = document.createElement("div");
      el.className = "new-hud-slot";
      Object.assign(el.style, { position: "absolute", left: `${x}px`, top: `${y}px`, width: `${SLOT_SIZE}px`, height: `${SLOT_SIZE}px`, display: "none", pointerEvents: "auto" });
      // _base_disc: the 52 px frosted disc (fallback black 0.92), the 40 px backing over it.
      const disc = document.createElement("div");
      Object.assign(disc.style, { position: "absolute", inset: "0", borderRadius: "50%", background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px) brightness(0.63)" } as Partial<CSSStyleDeclaration>);
      const icon = document.createElement("img");
      icon.alt = "";
      icon.draggable = false;
      Object.assign(icon.style, { position: "absolute", left: `${(SLOT_SIZE - SLOT_ICON_SIZE) / 2}px`, top: `${(SLOT_SIZE - SLOT_ICON_SIZE) / 2}px`, width: `${SLOT_ICON_SIZE}px`, height: `${SLOT_ICON_SIZE}px`, clipPath: "circle(20px at 50% 50%)" });
      const qty = document.createElement("div");
      Object.assign(qty.style, { position: "absolute", left: "0", right: "0", top: `${26 + 13 - 7}px`, height: "14px", textAlign: "center", font: "bold 11px 'EVE Sans Neue','Segoe UI',sans-serif", color: "rgba(255,255,255,0.75)", display: "none" });
      const badge = document.createElement("div");
      Object.assign(badge.style, { position: "absolute", left: "-1px", top: "32px", width: "14px", height: "14px", borderRadius: "3px", background: css(LED_GREY), color: "#fff", font: "11px 'EVE Sans Neue','Segoe UI',sans-serif", textAlign: "center", lineHeight: "14px", display: "none" });
      const shortcut = document.createElement("div");
      Object.assign(shortcut.style, { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", font: "bold 11px 'EVE Sans Neue','Segoe UI',sans-serif", color: "rgba(255,255,255,0.3)" });
      el.append(disc, icon, qty, badge, shortcut);
      const slot: Slot = { el, icon, qty, badge, shortcut, x, y, module: null, hover: false, wedge: { angle: 180, half: 7.5, lit: 0 }, cycles: -1, flashAt: 0 };
      el.addEventListener("mouseenter", () => { slot.hover = true; });
      el.addEventListener("mouseleave", () => { slot.hover = false; });
      el.addEventListener("click", () => { if (slot.module && this.onModule) this.onModule(slot.module); });
      this.slots.push(slot);
      this.tray.append(el);
    }
  }

  // ── the classic HUD's API ──────────────────────────────────────────────────────────────────────────────

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.root.remove();
  }

  /** shipAlertController: segments 0..level flash red, each over its level's period (shield 2 s, armor 1 s, hull 0.6 s). */
  flashDamage(level: number, duration: number): void {
    this.damageFlash = { level, until: performance.now() + duration, period: [2000, 1000, 600][Math.max(0, Math.min(2, level))]! };
  }

  /** capacitorCore: the low-capacitor alert waves the core's opacity 1 -> 0.5 -> 1 every 2 s. */
  flashCapacitor(duration: number): void {
    this.capFlashUntil = performance.now() + duration;
  }

  cancelAlerts(): void {
    this.damageFlash = null;
    this.capFlashUntil = 0;
  }

  update(s: NewShipHudState): void {
    this.state = s;
    const now = performance.now();
    const maxes = [s.shieldMax, s.armorMax, s.hullMax].map((v) => (typeof v === "number" && v > 0 ? v : 1));
    const key = maxes.map((v) => v.toFixed(2)).join("/");
    if (key !== this.segmentsKey) {
      const next = layoutRing(maxes);
      // healthRing: re-laid out only when a span moves more than 0.25 degrees
      if (this.segmentsKey === "" || next.some((g, i) => Math.abs((g.a1 - g.a0) - (this.segments[i]!.a1 - this.segments[i]!.a0)) > 0.25)) this.segments = next;
      this.segmentsKey = key;
    }
    [s.shieldRatio, s.armorRatio, s.hullRatio].forEach((ratio, i) => {
      const pool = this.pools[i]!;
      const value = ratio === null ? null : Math.max(0, Math.min(1, ratio));
      if (value !== null && pool.target !== null && value < pool.target - 1e-6) {
        // A damage ghost: the old value held for a second, then chasing the shown one down.
        if (pool.ghost === null) pool.ghost = pool.shown;
        pool.holdUntil = now + 1000;
      }
      if (pool.shown === null) pool.shown = value;
      pool.target = value;
    });
    const label = s.warping ? "(Warping)" : `${s.speed < 100 ? (Math.round(s.speed * 10) / 10).toFixed(1) : Math.trunc(s.speed)} m/s`;
    if (this.speedLabel.textContent !== label) this.speedLabel.textContent = label;
    if (s.heatHi !== undefined) this.heatShown.Hi = s.heatHi;
    if (s.heatMed !== undefined) this.heatShown.Med = s.heatMed;
    if (s.heatLow !== undefined) this.heatShown.Lo = s.heatLow;
  }

  toggleRackOverload(rack: "Hi" | "Med" | "Lo"): boolean {
    const family = RACK_BUTTONS.find((b) => b.rack === rack)!.family;
    const inRack = this.modules.filter((m) => m.family === family).sort((a, b) => a.index - b.index);
    const first = inRack.find((m) => m.overloadable) ?? null;
    if (!first || !this.overload) return false;
    const on = !(inRack.filter((m) => m.overloadable).every((m) => m.overloaded));
    this.overload.rack(inRack[0]!.itemID, on);
    return true;
  }

  setModules(modules: readonly HudModule[], onModule: (m: HudModule) => void, overload?: HudOverload): void {
    this.modules = modules;
    this.onModule = onModule;
    this.overload = overload ?? null;
    const flagOf = (m: HudModule) => ({ high: 0, mid: 1, low: 2 }[m.family] * 8 + m.index);
    const byPosition = new Map<number, HudModule>();
    for (const m of modules) byPosition.set(flagOf(m), m);
    this.slots.forEach((slot, position) => {
      const m = byPosition.get(position) ?? null;
      slot.module = m;
      // moduleTray: empty slots hidden by default (shipHudNew_hideEmptySlots 1); no compaction, a gap is left.
      slot.el.style.display = m ? "" : "none";
      if (!m) return;
      if (slot.icon.dataset.src !== m.icon) { slot.icon.src = m.icon; slot.icon.dataset.src = m.icon; }
      slot.icon.style.opacity = m.online ? "1" : "0.4";
      slot.el.title = m.name ?? "";
      slot.shortcut.textContent = "";
    });
    this.placeScannerGroup();
  }

  // ── drawing ────────────────────────────────────────────────────────────────────────────────────────────

  private draw(): void {
    const now = performance.now();
    const dt = Math.min(250, now - this.lastFrame);
    this.lastFrame = now;
    const alpha = 1 - Math.pow(1 - 0.26, dt / 33);
    for (const pool of this.pools) {
      if (pool.target === null) continue;
      if (pool.shown === null) pool.shown = pool.target;
      const gap = pool.target - pool.shown;
      pool.shown = Math.abs(gap) <= 0.0005 ? pool.target : pool.shown + gap * alpha;
      if (pool.ghost !== null) {
        if (pool.ghost - pool.shown <= 0.0005) pool.ghost = null;
        else if (now >= pool.holdUntil) pool.ghost -= (pool.ghost - pool.shown) * alpha;
      }
    }
    const s = this.state;
    if (s) {
      const ratio = s.maxSpeed && s.maxSpeed > 0 ? Math.max(0, Math.min(1, s.speed / s.maxSpeed)) : 0;
      if (this.speedShown === null) this.speedShown = ratio;
      const g = ratio - this.speedShown;
      if (Math.abs(g) >= 0.0004) this.speedShown += g * (1 - Math.pow(0.75, dt / 33));
    }
    const c = this.ctx;
    c.clearRect(0, 0, SHIP_UI_WIDTH, SHIP_UI_HEIGHT);
    c.save();
    c.translate(MEDALLION_CENTRE[0], MEDALLION_CENTRE[1]);
    this.drawHeat(c);
    this.drawSpeedometer(c, now);
    this.drawCapacitor(c, now);
    this.drawOverload(c);
    this.drawRing(c, now);
    c.restore();
    this.drawCargo(c);
    c.save();
    c.translate(TRAY_LEFT, TRAY_TOP);
    for (const slot of this.slots) if (slot.module) this.drawSlot(c, slot, now, dt);
    c.restore();
  }

  /** A VectorArc over math degrees [d0, d1] (healthRing.py 77 to 80: start = -d1, end = -d0 on screen). */
  private arc(c: CanvasRenderingContext2D, r: number, d0: number, d1: number, width: number, colour: string, glow = 0): void {
    if (d1 <= d0) return;
    c.beginPath();
    c.arc(0, 0, r, -rad(d1), -rad(d0));
    c.lineWidth = width;
    c.strokeStyle = colour;
    c.shadowColor = glow > 0 ? colour : "transparent";
    c.shadowBlur = glow > 0 ? 6 * glow : 0;
    c.stroke();
    c.shadowBlur = 0;
  }

  private radial(c: CanvasRenderingContext2D, deg: number, r0: number, r1: number, width: number, colour: string, glow = 0): void {
    const a = rad(deg);
    c.beginPath();
    c.moveTo(r0 * Math.cos(a), -r0 * Math.sin(a));
    c.lineTo(r1 * Math.cos(a), -r1 * Math.sin(a));
    c.lineWidth = width;
    c.strokeStyle = colour;
    c.shadowColor = glow > 0 ? colour : "transparent";
    c.shadowBlur = glow > 0 ? 6 * glow : 0;
    c.stroke();
    c.shadowBlur = 0;
  }

  /** _BevelledTint: the segment's chamfered annular sector between two angles. */
  private band(c: CanvasRenderingContext2D, seg: Segment, s: number, e: number, colour: string): void {
    if (e - s <= 1e-6) return;
    const steps = 32;
    c.beginPath();
    for (let i = 0; i <= steps; i++) {
      const d = s + (e - s) * i / steps;
      const x = R_TRACK_OUT * Math.cos(rad(d)), y = -R_TRACK_OUT * Math.sin(rad(d));
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    for (let i = steps; i >= 0; i--) {
      const d = s + (e - s) * i / steps;
      const r = innerRadiusAt(seg, d);
      c.lineTo(r * Math.cos(rad(d)), -r * Math.sin(rad(d)));
    }
    c.closePath();
    c.fillStyle = colour;
    c.fill();
  }

  private drawRing(c: CanvasRenderingContext2D, now: number): void {
    const flash = this.damageFlash && now < this.damageFlash.until ? this.damageFlash : null;
    this.segments.forEach((seg, i) => {
      const pool = this.pools[i]!;
      const portion = pool.shown ?? 1;
      const span = seg.a1 - seg.a0;
      const split = seg.a1 - span * portion;
      const ghost = pool.ghost ?? portion;
      const gLo = seg.a1 - span * Math.max(ghost, portion);
      const gHi = seg.a1 - span * Math.min(ghost, portion);
      this.band(c, seg, seg.a0, split, css(DANGER_RED, 0.2));
      this.band(c, seg, split, seg.a1, css(WHITE, 0.2));
      if (pool.ghost !== null) this.band(c, seg, gLo, gHi, css(DANGER_RED, 0.4));
      this.arc(c, DIAL_MID, seg.a0, split, DIAL_WIDTH, css(LOST_DIAL));
      this.arc(c, DIAL_MID, split, seg.a1, DIAL_WIDTH, css(WHITE), 0.4);
      if (pool.ghost !== null) this.arc(c, DIAL_MID, gLo, gHi, DIAL_WIDTH, css(DANGER_RED), 0.4);
      // _PlaceNotches: tenths on a pool with at least 30 % of the HP, else quarters, measured from a1.
      const marks = seg.share >= 0.3 ? [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] : [0.25, 0.5, 0.75];
      for (const mark of marks) {
        if (portion < mark) continue;
        const d = seg.a1 - span * mark;
        const half = Math.abs(mark - 0.5) < 1e-6;
        const r1 = half ? R_DIAL_IN - 20 : R_DIAL_IN - 10;
        const a = rad(d);
        const grad = c.createLinearGradient(R_DIAL_IN * Math.cos(a), -R_DIAL_IN * Math.sin(a), r1 * Math.cos(a), -r1 * Math.sin(a));
        grad.addColorStop(0, "rgba(255,255,255,1)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        c.beginPath();
        c.moveTo(R_DIAL_IN * Math.cos(a), -R_DIAL_IN * Math.sin(a));
        c.lineTo(r1 * Math.cos(a), -r1 * Math.sin(a));
        c.lineWidth = 1;
        c.strokeStyle = grad;
        c.stroke();
        if (half) this.radial(c, d, 80, 85, 1, css(WHITE), 0.5);
      }
      if (flash && i <= flash.level) {
        const phase = ((now - (flash.until - 1e9)) % flash.period) / flash.period;
        const wave = phase < 0.5 ? smooth(phase * 2) : smooth(2 - phase * 2);
        this.band(c, seg, seg.a0, seg.a1, css(ALERT_FLASH, 0.25 * wave));
      }
    });
  }

  private drawCapacitor(c: CanvasRenderingContext2D, now: number): void {
    const s = this.state;
    const maxCap = s?.capacitorMax ?? null;
    const columns = maxCap === null ? 24 : Math.max(1, Math.min(24, Math.trunc(maxCap / 50)));
    let variant = 0;
    for (let i = 1; i < VARIANT_SPOKES.length; i++) if (Math.abs(VARIANT_SPOKES[i]! - columns) < Math.abs(VARIANT_SPOKES[variant]! - columns)) variant = i;
    const spokes = VARIANT_SPOKES[variant]!;
    const track = image(HUD(`capacitor_0${variant}`));
    const under = image(HUD("capacitor_04"));
    c.save();
    if (now < this.capFlashUntil) {
      const phase = ((now - this.started) % 2000) / 2000;
      c.globalAlpha = phase < 0.5 ? 1 - 0.5 * smooth(phase * 2) : 0.5 + 0.5 * smooth(phase * 2 - 1);
    }
    const ga = c.globalAlpha;
    if (under) { c.globalAlpha = ga * 0.05; c.drawImage(under, -CAP_RADIUS, -CAP_RADIUS, 56, 56); }
    if (track) { c.globalAlpha = ga * 0.15; c.drawImage(track, -CAP_RADIUS, -CAP_RADIUS, 56, 56); }
    c.globalAlpha = ga;
    // _ApplySweep: rounded to hundredths, six pieces a column, the leading piece blinking.
    const portion = s?.capacitorRatio === null || s?.capacitorRatio === undefined ? 0 : Math.round(Math.max(0, Math.min(1, s.capacitorRatio)) * 100) / 100;
    const total = spokes * 6;
    let lit = Math.trunc(portion * total);
    const blinkOff = Math.floor((now - this.started) / CAP_BLINK_MS) % 2 === 1;
    if (blinkOff && lit > 0 && lit < total) lit -= 1;
    const full = Math.trunc(lit / 6);
    const pieces = lit % 6;
    const pitch = 360 / spokes;
    // _BaseAngle: the top column's left edge (math degrees): 135, 120, 112.5, 105, 97.5 for 4 to 24 columns
    const base = 90 + pitch / 2;
    if (track) {
      if (full > 0) this.capWedge(c, track, base, pitch * full, 1);
      if (pieces > 0) this.capWedge(c, track, base + pitch * full, pitch, PIECE_CUTS[pieces - 1]!);
    }
    c.restore();
  }

  /** TexturedDisc.SetWedge: the texture through a CCW sector from `start`, out to radius 28 x `reach`, under the lit gradient. */
  private capWedge(c: CanvasRenderingContext2D, tex: HTMLImageElement, start: number, sweep: number, reach: number): void {
    const R = CAP_RADIUS * reach;
    c.save();
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, R, -rad(start), -rad(start + sweep), true);
    c.closePath();
    c.clip();
    const off = capScratch();
    const o = off.getContext("2d")!;
    o.globalCompositeOperation = "source-over";
    o.clearRect(0, 0, 56, 56);
    o.drawImage(tex, 0, 0, 56, 56);
    o.globalCompositeOperation = "source-in";
    const g = o.createRadialGradient(28, 28, 0, 28, 28, CAP_RADIUS);
    g.addColorStop(0, "rgb(255,255,255)");
    g.addColorStop(0.2627, "rgb(255,255,255)");
    g.addColorStop(0.7288, "rgb(245,199,77)");
    g.addColorStop(1, "rgb(230,128,51)");
    o.fillStyle = g;
    o.fillRect(0, 0, 56, 56);
    c.shadowColor = "rgba(245,199,77,0.7)";
    c.shadowBlur = 5;
    c.drawImage(off, -CAP_RADIUS, -CAP_RADIUS, 56, 56);
    c.restore();
  }

  private drawSpeedometer(c: CanvasRenderingContext2D, now: number): void {
    const s = this.state;
    const hover = this.speedHover && !s?.warping;
    // _BandStrip: the 97..113 band over the drawn span, additive; SMOKE_BLUE 0.72 hovered.
    c.save();
    c.globalCompositeOperation = "lighter";
    c.beginPath();
    c.arc(0, 0, SPEED_R_OUT, -rad(BAND_DRAW_MAX), -rad(BAND_DRAW_MIN));
    c.arc(0, 0, SPEED_R_IN, -rad(BAND_DRAW_MIN), -rad(BAND_DRAW_MAX), true);
    c.closePath();
    c.fillStyle = hover ? css(SMOKE_BLUE, 0.72) : css(WHITE, 0.22);
    c.fill();
    c.restore();
    const shown = this.speedShown ?? 0;
    if (shown > 0) {
      const w = hover ? 16 : 8;
      this.arc(c, 105, degOf(shown), DEG_ZERO, w, css(FOCUS_BLUE, 0.8), 0.4);
      const d = degOf(shown);
      if (d >= BAND_DRAW_MIN && d <= BAND_DRAW_MAX) this.radial(c, d, 105 - w / 2, 105 + w / 2, 2, css(FOCUS_BLUE), 0.8);
    }
    if (hover) {
      const max = s?.maxSpeed ?? 0;
      const count = max <= 50 ? 8 : Math.max(8, Math.min(24, Math.round(8 + 16 * Math.log(max / 50) / Math.log(40))));
      const first = 180 - TICK_SPAN / 2;
      for (let i = 0; i < count; i++) this.radial(c, first + TICK_SPAN * i / (count - 1), 101, 109, 1, css(WHITE, 0.6));
      if (this.hoverDeg !== null && this.hoverDeg >= BAND_DRAW_MIN && this.hoverDeg <= BAND_DRAW_MAX) this.radial(c, this.hoverDeg, SPEED_R_IN, SPEED_R_OUT, 2, css(WHITE), 0.6);
    }
    // The desired speed: its marker and the snapped needle, unless it came from a preset or the ship is at it.
    const desired = s?.desiredRatio ?? null;
    const actual = s && s.maxSpeed ? s.speed / s.maxSpeed : null;
    if (desired !== null && !this.desiredFromPreset && (actual === null || Math.abs(actual - desired) > 0.01)) {
      const d = degOf(desired);
      if (d >= BAND_DRAW_MIN && d <= BAND_DRAW_MAX) {
        this.radial(c, d, SPEED_R_IN, SPEED_R_OUT, 2, css(WHITE, 0.5));
        const rIn = 108, rOut = 116, half = 4 / rIn * 180 / Math.PI;
        c.beginPath();
        c.moveTo(rIn * Math.cos(rad(d)), -rIn * Math.sin(rad(d)));
        c.lineTo(rOut * Math.cos(rad(d + half)), -rOut * Math.sin(rad(d + half)));
        c.lineTo(rOut * Math.cos(rad(d - half)), -rOut * Math.sin(rad(d - half)));
        c.closePath();
        c.fillStyle = "#fff";
        c.fill();
      }
    }
    void now;
  }

  private drawHeat(c: CanvasRenderingContext2D): void {
    if (this.overloadMode) return; // the bars fade out while overload mode is on
    const bar = image(HUD("rack_gauge_bar"));
    if (!bar) return;
    for (const b of HEAT_BARS) {
      const p = Math.max(0, Math.min(1, this.heatShown[b.rack]));
      c.save();
      c.translate(b.x, b.y);
      c.rotate(rad(b.rot));
      c.globalAlpha = 0.35;
      c.drawImage(bar, -12, -3, 24, 6);
      const w = Math.round(24 * p);
      if (w > 0) {
        c.globalAlpha = 1;
        const tint = p >= 0.75 ? "rgb(255,48,56)" : p >= 0.5 ? "rgb(255,190,60)" : "rgba(255,255,255,0.9)";
        const off = capScratch();
        const o = off.getContext("2d")!;
        o.globalCompositeOperation = "source-over";
        o.clearRect(0, 0, 56, 56);
        o.drawImage(bar, 48 - 2 * w, 0, 2 * w, 12, 0, 0, w, 6);
        o.globalCompositeOperation = "source-in";
        o.fillStyle = tint;
        o.fillRect(0, 0, w, 6);
        c.drawImage(off, 0, 0, w, 6, 12 - w, -3, w, 6);
      }
      c.restore();
    }
  }

  private drawOverload(c: CanvasRenderingContext2D): void {
    const outline = image(HUD("overload_hex_outline"));
    const inset = image(HUD("overload_hex_fill_inset"));
    const fill = image(HUD("overload_hex_fill"));
    const [ox, oy] = OVERLOAD_CENTRE;
    const tinted = (img: HTMLImageElement | null, x: number, y: number, colour: string) => {
      if (!img) return;
      const off = capScratch();
      const o = off.getContext("2d")!;
      o.globalCompositeOperation = "source-over";
      o.clearRect(0, 0, 56, 56);
      o.drawImage(img, 0, 0, 32, 32);
      o.globalCompositeOperation = "source-in";
      o.fillStyle = colour;
      o.fillRect(0, 0, 32, 32);
      c.drawImage(off, 0, 0, 32, 32, x - 16, y - 16, 32, 32);
    };
    const active = this.overloadMode;
    const hover = this.overloadHover;
    if (active) tinted(fill, ox, oy, css(CHERRY_RED));
    else tinted(inset, ox, oy, hover ? css(CHERRY_RED, 0.2) : css(WHITE, 0.2));
    tinted(outline, ox, oy, active || hover ? css(DANGER_RED) : css(WHITE, 0.25));
    if (!active) return;
    for (const b of RACK_BUTTONS) {
      const overloaded = this.modules.filter((m) => m.family === b.family && m.overloadable).some((m) => m.overloaded);
      const hovered = this.rackHover === b.rack;
      tinted(fill, b.x, b.y, "rgba(0,0,0,0.8)");
      tinted(fill, b.x, b.y, css(WHITE, hovered ? 0.8 : 0.5));
      const glyph = image(HUD(b.glyph));
      if (glyph) {
        const off = capScratch();
        const o = off.getContext("2d")!;
        o.globalCompositeOperation = "source-over";
        o.clearRect(0, 0, 56, 56);
        o.drawImage(glyph, 0, 0, 16, 16);
        o.globalCompositeOperation = "source-in";
        o.fillStyle = hovered || overloaded ? css(DANGER_RED) : css(WHITE, 0.75);
        o.fillRect(0, 0, 16, 16);
        c.drawImage(off, 0, 0, 16, 16, b.x - 8, b.y - 8, 16, 16);
      }
    }
  }

  /** activationIndicator: the frame ring, the state wedge (9 o'clock idle, 12 o'clock active) and the cycle arc. */
  private drawSlot(c: CanvasRenderingContext2D, slot: Slot, now: number, dt: number): void {
    const m = slot.module!;
    const cx = slot.x + 26, cy = slot.y + 26;
    const on = m.active || !!m.waitingForTarget;
    const overloadable = !!m.overloadable;
    const heated = on && !!m.overloaded;
    const preheated = !on && !!m.overloaded;
    const targetAngle = on ? -90 : 180; // screen degrees (y down): -pi/2 is 12 o'clock, pi is 9 o'clock
    let half = heated || preheated ? 37.5 : 7.5;
    if (this.overloadMode && overloadable) half *= 1.5;
    const w = slot.wedge;
    const k = Math.min(1, dt / 180);
    let da = ((targetAngle - w.angle + 540) % 360) - 180;
    w.angle += da * (1 - Math.pow(1 - k, on ? 4 : 3));
    if (Math.abs(da) < 0.05) w.angle = targetAngle;
    w.half += (half - w.half) * k;
    w.lit += ((slot.hover || on ? 1 : 0) - w.lit) * Math.min(1, dt / 80);
    // _TargetLayout: the backing disc's alpha, the track's, the wedge's colour and glow
    const backing = 0.2 + (on ? 0.1 : 0) + (slot.hover ? 0.1 : 0);
    let trackA = 0.07 + (on ? 0.1 : 0) + (this.overloadMode && overloadable ? 0.2 : 0);
    let wedge: RGBA = heated ? DANGER_RED : preheated ? (slot.hover ? DANGER_RED : CHERRY_RED) : (on || slot.hover ? FOCUS_BLUE : scale(FOCUS_BLUE, 0.5));
    if (this.overloadMode && overloadable) wedge = heated || preheated || slot.hover ? DANGER_RED : CHERRY_RED;
    let glow = on ? 0.6 : w.lit > 0.5 ? 0.6 : 0.3;
    let wedgeAlpha = 1;
    let backingA = backing;
    if (m.waitingForTarget) {
      const pulse = 0.5 - 0.5 * Math.cos(2 * Math.PI * ((now % 600) / 600));
      wedgeAlpha = 1 - 0.7 * pulse;
      glow *= wedgeAlpha;
      backingA *= 1 - 0.25 * pulse;
    }
    // FlashTrack on each new cycle: the track to white 0.6 and the wedge to white, 600 ms.
    const cycling = m.active && typeof m.cycle === "number";
    const flashT = (now - slot.flashAt) / 600;
    let trackColour: RGBA = this.overloadMode && overloadable ? withAlpha(DANGER_RED, trackA) : withAlpha(WHITE, trackA);
    if (flashT >= 0 && flashT < 1) {
      const env = flashT < 0.1 ? flashT / 0.1 : Math.pow(1 - (flashT - 0.1) / 0.9, 2);
      trackColour = withAlpha(WHITE, trackA + (0.6 - trackA) * env);
      wedge = mix(wedge, WHITE, env);
    }
    // the 40 px backing disc
    c.beginPath();
    c.arc(cx, cy, 20, 0, Math.PI * 2);
    c.fillStyle = css(WHITE, backingA * 0.35);
    c.fill();
    // _track_arc: the frame ring, r 23 w 2
    c.beginPath();
    c.arc(cx, cy, 23, 0, Math.PI * 2);
    c.lineWidth = 2;
    c.strokeStyle = css(trackColour);
    c.stroke();
    // _cycle_arc: from 12 o'clock + gap clockwise, the cycle's share of the rest
    if (cycling) {
      const p = Math.max(0, Math.min(1, m.cycle as number));
      const gap = w.half + 5.06;
      const start = rad(-90 + gap);
      const end = start + (2 * Math.PI - 2 * rad(gap)) * p;
      c.beginPath();
      c.arc(cx, cy, 23, start, end);
      c.lineWidth = 2;
      c.strokeStyle = "rgba(255,255,255,0.8)";
      c.stroke();
      const prev = (slot as Slot & { lastP?: number }).lastP;
      if (prev !== undefined && p + 0.5 < prev) slot.flashAt = now;
      (slot as Slot & { lastP?: number }).lastP = p;
    }
    // _shadow_arc and _wedge_arc: the state dial, additive with its glow
    c.beginPath();
    c.arc(cx, cy, 23, rad(w.angle - w.half - 5.06), rad(w.angle + w.half + 5.06));
    c.lineWidth = 2.5;
    c.strokeStyle = "rgba(0,0,0,0.13)";
    c.stroke();
    c.save();
    c.globalCompositeOperation = "lighter";
    c.beginPath();
    c.arc(cx, cy, 23, rad(w.angle - w.half), rad(w.angle + w.half));
    c.lineWidth = 3;
    c.strokeStyle = css(wedge, wedgeAlpha);
    c.shadowColor = css(wedge, wedgeAlpha);
    c.shadowBlur = 6 * glow;
    c.stroke();
    c.restore();
    // damageGauge: a 38x2 bar at the slot's foot, shown between 0.5 % and burnt out
    const dmg = m.damage ?? 0;
    if (dmg > 0.005 && dmg < 1) {
      c.fillStyle = "#000";
      c.fillRect(slot.x + 6, slot.y + 46, 40, 4);
      c.fillStyle = "rgba(176,176,176,0.3)";
      c.fillRect(slot.x + 7, slot.y + 47, 38, 2);
      c.fillStyle = css(DANGER_RED);
      c.fillRect(slot.x + 7, slot.y + 47, Math.max(1, Math.round(38 * dmg)), 2);
    }
  }
}

const smooth = (t: number): number => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
const mix = (a: RGBA, b: RGBA, t: number): RGBA => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
/** speedometer: deg(ratio) = 210 - 60 ratio, and its inverse clamped to 0..1. */
export const degOf = (ratio: number): number => DEG_ZERO + (DEG_FULL - DEG_ZERO) * ratio;
export const ratioOf = (deg: number): number => Math.max(0, Math.min(1, (deg - DEG_ZERO) / (DEG_FULL - DEG_ZERO)));

let scratch: HTMLCanvasElement | null = null;
function capScratch(): HTMLCanvasElement {
  if (!scratch) {
    scratch = document.createElement("canvas");
    scratch.width = 56;
    scratch.height = 56;
  }
  return scratch;
}
