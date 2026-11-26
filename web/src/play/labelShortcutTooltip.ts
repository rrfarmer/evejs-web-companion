// A tooltip panel as the client's TooltipGeneric draws one with AddLabelShortcut (tooltips.py: the label EveLabelMedium in
// bold beside its shortcut's ShortcutHint) and, below, any further lines (AddLabelMedium over both columns) - in the
// FrameWithPointer background_04 frame at 0.75, 16 px in, as the HUD's command tooltips (newShipHud.ts).
import { clientTexture } from "./window.ts";
import { genericTooltipDelay } from "./radialSettings.ts";
/** _GetSleepTime: the generic delay, or its renew time (a fifth) where a panel shows or one just closed. */
const sleepTime = (renew: boolean) => { const init = genericTooltipDelay(); return renew ? Math.max(1, Math.trunc(init / 5)) : init; };

let tip: HTMLDivElement | null = null;

/** A pointer flag (uiconst.POINT_*): x 0..4 (left, 1, middle, 3, right), y 0..4 (top, 1, middle, 3, bottom). */
type PointFlag = readonly [number, number];
const POINT = {
  TOP_1: [1, 0], TOP_2: [2, 0], TOP_3: [3, 0], BOTTOM_1: [1, 4], BOTTOM_2: [2, 4], BOTTOM_3: [3, 4],
  LEFT_1: [0, 1], LEFT_2: [0, 2], LEFT_3: [0, 3], RIGHT_1: [4, 1], RIGHT_2: [4, 2], RIGHT_3: [4, 3],
  TOPLEFT: [0, 0], TOPRIGHT: [4, 0], BOTTOMLEFT: [0, 4], BOTTOMRIGHT: [4, 4],
} as const satisfies Record<string, PointFlag>;
const LEFTGROUP = [POINT.LEFT_2, POINT.LEFT_1, POINT.LEFT_3];
const RIGHTGROUP = [POINT.RIGHT_2, POINT.RIGHT_1, POINT.RIGHT_3];
const TOPGROUP = [POINT.TOP_2, POINT.TOP_1, POINT.TOP_3];
const BOTTOMGROUP = [POINT.BOTTOM_2, POINT.BOTTOM_1, POINT.BOTTOM_3];
const CORNERGROUP = [POINT.TOPLEFT, POINT.TOPRIGHT, POINT.BOTTOMLEFT, POINT.BOTTOMRIGHT];
/** pointerPanel.POINT_CORRECTION: the flags tried, in turn, where the first is cut by the desktop's edge. */
function correctionFor(flag: PointFlag): readonly PointFlag[] {
  const [x, y] = flag;
  if (x === 0 && y >= 1 && y <= 3) return [...LEFTGROUP, ...RIGHTGROUP, ...BOTTOMGROUP, ...TOPGROUP];
  if (x === 4 && y >= 1 && y <= 3) return [...RIGHTGROUP, ...LEFTGROUP, ...BOTTOMGROUP, ...TOPGROUP];
  if (y === 4 && x === 2) return [POINT.LEFT_2, ...BOTTOMGROUP, ...LEFTGROUP, ...TOPGROUP, ...RIGHTGROUP];
  if (y === 4 && (x === 1 || x === 3)) return [...BOTTOMGROUP, ...LEFTGROUP, ...TOPGROUP, ...RIGHTGROUP];
  if (y === 0 && x >= 1 && x <= 3) return [...TOPGROUP, ...LEFTGROUP, ...BOTTOMGROUP, ...RIGHTGROUP];
  return [];
}
/**
 * PointerPanel.pointerSize: the panel 9 px from its anchor (measured on the live client: a TooltipPanel at a 40 px anchor
 * by UpdatePanelPosition - POINT_BOTTOM_2 9 above it, POINT_LEFT_2 9 to its right; its pointer sprite 16 out, centred).
 */
const POINTER_GAP = 9;
/**
 * pointerPanel.AlignPointPanelToInterest: the panel beside its anchor by the flag - above (y 4), below (y 0) or centred
 * on the pointer (FrameWithPointer.UpdatePointerPosition: 12 in from an end, or the middle), and the same across.
 */
function alignToFlag(a: DOMRect, w: number, h: number, [fx, fy]: PointFlag): { left: number; top: number } {
  const along = (i: number, size: number) => (i === 1 ? 12 : i === 2 ? size / 2 : size - 12);
  const top = fy === 4 ? a.top - h - POINTER_GAP : fy === 0 ? a.bottom + POINTER_GAP : a.top + a.height / 2 - along(fy, h);
  const left = fx === 4 ? a.left - w - POINTER_GAP : fx === 0 ? a.right + POINTER_GAP : a.left + a.width / 2 - along(fx, w);
  return { left, top };
}
/**
 * pointerPanel.UpdatePanelPosition: the flag asked for; where the desktop's edge cuts it, POINT_CORRECTION's flags and
 * then the corners in turn, the first not cut kept - else the one cut least (its deeper cut, then its other).
 */
function placeTip(panel: HTMLElement, anchor: HTMLElement, flag: PointFlag): void {
  placeBeside(panel, anchor.getBoundingClientRect(), flag);
}
/** A pointer panel the page draws itself (a Svelte tooltip) placed beside its anchor's rect by a flag name. */
export function placePointerPanel(panel: HTMLElement, anchor: DOMRect, flag: keyof typeof POINT): void {
  // (a fixed panel inside a transformed window is placed in that window's box: measured at 0,0 and taken off)
  panel.style.left = "0px";
  panel.style.top = "0px";
  const origin = panel.getBoundingClientRect();
  placeBeside(panel, anchor, POINT[flag]);
  panel.style.left = `${Math.round(parseFloat(panel.style.left) - origin.left)}px`;
  panel.style.top = `${Math.round(parseFloat(panel.style.top) - origin.top)}px`;
}
function placeBeside(panel: HTMLElement, a: DOMRect, flag: PointFlag): void {
  const w = panel.offsetWidth, h = panel.offsetHeight;
  const cut = (p: { left: number; top: number }): [number, number] => {
    const x = p.left < 0 ? -p.left : p.left + w > innerWidth ? p.left + w - innerWidth : 0;
    const y = p.top < 0 ? -p.top : p.top + h > innerHeight ? p.top + h - innerHeight : 0;
    return x > y ? [x, y] : [y, x];
  };
  let best = alignToFlag(a, w, h, flag);
  let bestCut = cut(best);
  let bestFlag = flag;
  for (const next of [...correctionFor(flag), ...CORNERGROUP]) {
    if (bestCut[0] === 0 && bestCut[1] === 0) break;
    const p = alignToFlag(a, w, h, next);
    const c = cut(p);
    if (c[0] < bestCut[0] || (c[0] === bestCut[0] && c[1] < bestCut[1])) { best = p; bestCut = c; bestFlag = next; }
  }
  panel.style.left = `${Math.round(best.left)}px`;
  panel.style.top = `${Math.round(best.top)}px`;
  drawPointer(panel, bestFlag);
}

/**
 * FrameWithPointer.UpdatePointerPosition: the 24 px pointer sprite of the flag's side (pointer_up/down/left/right_02 of
 * GeneralFrameWithPointerSkin) at the panel's edge toward its anchor, at the pointer's place along it (12 in from an end,
 * or the middle) - 16 px outside the edge (measured on the live client); none for a corner flag.
 */
function drawPointer(panel: HTMLElement, [fx, fy]: PointFlag): void {
  let img = panel.querySelector<HTMLImageElement>(":scope > img.pp-pointer");
  const corner = (fx === 0 || fx === 4) && (fy === 0 || fy === 4);
  if (corner) { img?.remove(); return; }
  if (!img) {
    img = document.createElement("img");
    img.className = "pp-pointer";
    img.alt = "";
    Object.assign(img.style, { position: "absolute", width: "24px", height: "24px", opacity: "0.75", pointerEvents: "none" });
    panel.append(img);
  }
  const along = (i: number) => (i === 1 ? "0px" : i === 2 ? "calc(50% - 12px)" : "calc(100% - 24px)");
  const side = fy === 4 ? "down" : fy === 0 ? "up" : fx === 0 ? "left" : "right";
  img.src = clientTexture(`res:/UI/Texture/classes/FrameWithPointer/pointer_${side}_02.png`);
  Object.assign(img.style, {
    left: side === "left" ? "-16px" : side === "right" ? "auto" : along(fx),
    right: side === "right" ? "-16px" : "auto",
    top: side === "up" ? "-16px" : side === "down" ? "auto" : along(fy),
    bottom: side === "down" ? "-16px" : "auto",
  });
}

/**
 * lines: a command's detailed description by default (AddCommandTooltip: AddLabelMedium wrapWidth 200, TextColor.SECONDARY);
 * plain: AddLabelMedium as it is (no wrap, the normal colour) - a Selected Item button's disabled hint.
 */
export interface TooltipValue {
  readonly label: string;
  readonly value: string;
}

export function showLabelShortcutTooltip(anchor: HTMLElement, label: string, shortcut: string, lines: readonly (string | { text: string; color: string } | TooltipValue)[] = [], pointer: "top" | "left" = "top", plain: boolean | "wrap" = false): void {
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "label-shortcut-tooltip";
    Object.assign(tip.style, { position: "fixed", pointerEvents: "none", zIndex: "100000", padding: "16px", font: "14px 'EVE Sans Neue','Segoe UI',sans-serif", color: "rgba(255,255,255,0.75)", whiteSpace: "nowrap" });
  }
  if (!tip.isConnected) document.body.append(tip);
  delete tip.dataset.generic;
  tip.style.padding = "16px";
  // as wide as its content wherever it is placed (fixed, left only: near the right edge the page would shrink it)
  tip.style.width = "max-content";
  tip.replaceChildren();
  const frame = document.createElement("div");
  Object.assign(frame.style, { position: "absolute", inset: "0", opacity: "0.75", borderStyle: "solid", borderWidth: "0", borderImageSource: `url(${clientTexture("res:/UI/Texture/classes/FrameWithPointer/background_04.png")})`, borderImageSlice: "19 fill", borderImageWidth: "19px", borderImageOutset: "15px" } as Partial<CSSStyleDeclaration>);
  const grid = document.createElement("div");
  grid.className = "lst-grid";
  // LoadGeneric2/3ColumnTemplate: LoadStandardSpacingOld - margin 16, no cell padding, cell spacing (8, 8); EveLabelMedium lines
  // 18 high (measured on the live client: the Neocom Inventory panel, 188 x 112)
  Object.assign(grid.style, { position: "relative", display: "grid", gridTemplateColumns: "auto auto", columnGap: "8px", rowGap: "8px", alignItems: "center", lineHeight: "18px" });
  const head = document.createElement("div");
  head.textContent = label;
  // AddLabelShortcut: a bold EveLabelMedium in the normal colour (0.75 on the live client, gridcheck g231 / g239)
  Object.assign(head.style, { fontWeight: "bold", color: "rgba(255,255,255,0.75)" });
  const hint = document.createElement("div");
  if (shortcut) {
    hint.textContent = shortcut;
    // ShortcutHint: the bold label centred on a fill (1, 1, 1, 0.1), its width the label's + 8 rounded up past the next 16
    // (AdjustSize: width - width % 16 + 16; "Alt-C" 34 -> 48), its height the label's
    Object.assign(hint.style, { justifySelf: "end", padding: "0", height: "18px", lineHeight: "18px", textAlign: "center", background: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.5)", fontWeight: "bold", whiteSpace: "nowrap" });
  }
  grid.append(head, hint);
  const wrapped: HTMLElement[] = [];
  for (const entry of lines) {
    if (typeof entry === "object" && "value" in entry) {
      const name = document.createElement("div");
      name.textContent = entry.label;
      Object.assign(name.style, { fontWeight: "bold", paddingRight: "8px" });
      const value = document.createElement("div");
      value.textContent = entry.value;
      Object.assign(value.style, { textAlign: "right", color: "rgba(255,255,255,0.5)" });
      grid.append(name, value);
      continue;
    }
    const d = document.createElement("div");
    // a line given with its own colour (an EveLabelMedium coloured by its caller, as ButtonSkills' alert line)
    const line = typeof entry === "string" ? entry : entry.text;
    d.textContent = line;
    if (plain !== true) wrapped.push(d);
    // plain: AddLabelMedium as it is; "wrap": AddLabelMedium(wrapWidth=200) in the normal colour (dronesUtil.LoadShortcutTooltip);
    // otherwise AddCommandTooltip's detailed description, wrapWidth 200 in the secondary colour
    Object.assign(d.style, plain === true ? { gridColumn: "1 / 3", whiteSpace: "nowrap" } : { gridColumn: "1 / 3", whiteSpace: "normal", maxWidth: "200px", color: plain === "wrap" ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.5)" });
    // a line's own colour last, over the description's
    if (typeof entry !== "string") d.style.color = entry.color;
    grid.append(d);
  }
  // a closing one stopped first: its fold scales the panel, and the widths below are measured on the page
  closing = null;
  for (const a of tip.getAnimations()) a.cancel();
  tip.append(frame, grid);
  tip.style.display = "";
  // AddLabelMedium(wrapWidth=200) sets autoFitToText: the box as wide as its longest wrapped line (the live client, g240:
  // The Agency 204, Opportunities 231, Inventory 188 wide)
  for (const d of wrapped) {
    const range = document.createRange();
    range.selectNodeContents(d);
    const widest = Math.max(0, ...[...range.getClientRects()].map((q) => q.width));
    if (widest > 0) d.style.width = `${Math.ceil(widest)}px`;
  }
  if (shortcut) {
    const r = document.createRange();
    r.selectNodeContents(hint);
    // the label's whole width to the nearest pixel: 18 of the 20 client hint boxes read (g231-g243), against 16 rounding up
    const w = Math.round(r.getBoundingClientRect().width) + 8;
    hint.style.width = `${w - (w % 16) + 16}px`;
  }
  // PointerPanel.ShowPanel: from nothing to full over 0.05 s (ANIM_SMOOTH)
  tip.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 50, easing: "cubic-bezier(0.3333, 0, 0.6667, 1)" });
  // POINT_TOP_2: the panel below its anchor; POINT_LEFT_2: to its right
  placeTip(tip, anchor, pointer === "top" ? POINT.TOP_2 : POINT.LEFT_2);
}

/** What ButtonSkillsTooltipPanel shows of the skill in training. */
export interface SkillTrainingTip {
  readonly header: string;
  /** GetDescriptionAndLevelInRoman(nextLevel): "Drones V". */
  readonly name: string;
  /** GetTimeLeftToTrainText, asked again each half second (UpdateThread). */
  readonly timeLeft: () => string;
  readonly description: string;
  /** The SkillBar's five boxes' fills. */
  readonly boxes: readonly string[];
  /** The tracked skill plan (AddSkillPlan), where one is tracked. */
  readonly plan?: { readonly header: string; readonly progress: number; readonly inTraining: number; readonly completed: boolean; readonly time: () => string;
    /** The plan's milestones, in its order: each one's kind and GetProgressRatio / GetInTrainingRatio / IsCompleted. */
    readonly milestones?: readonly { readonly subType: "ship" | "module" | "skill" | "other"; readonly progress: number; readonly inTraining: number; readonly completed: boolean }[] } | null;
}

/**
 * SkillPlanProgressIndicator (GAUGE_SIZE 160, highlightNotInTraining) as the Skills tooltip shows it: the
 * SkillPlanProgressGauge - a 300 degree arc (START_ANGLE -pi/2 + pi/6, GAUGE_ANGLE 2pi - pi/3: the gap at the top),
 * line 0.22 of the radius inside it; trained WHITE, in training CRYO_BLUE, the rest WARNING_ORANGE (MIN_GAUGE_RATIO
 * 0.03 in training, 0.01 trained, at most 0.999); gaugeStartEnd sprites 30 at 0.94 of the radius on the arc's ends
 * (the start WHITE once any is trained, the end WHITE when all is, CRYO_BLUE when the training covers the rest); the
 * total time left centred in the top wedge, small (the radius 80 is under 100: the wedge's background hidden).
 */
function planGauge(plan: NonNullable<SkillTrainingTip["plan"]>): { el: HTMLElement; tick: () => void } {
  const NS = "http://www.w3.org/2000/svg";
  const size = 160, cx = 80, outer = 80, lw = 0.22 * outer, r = outer - lw / 2;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", String(size)); svg.setAttribute("height", String(size)); svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  const at = (t: number, rad = r) => { const a = (30 + 300 * t) * Math.PI / 180; return [cx + rad * Math.sin(a), cx - rad * Math.cos(a)] as const; };
  const arc = (a: number, b: number, color: string) => {
    if (b - a <= 0.0005) return;
    const [x0, y0] = at(a), [x1, y1] = at(b);
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", `M ${x0} ${y0} A ${r} ${r} 0 ${300 * (b - a) > 180 ? 1 : 0} 1 ${x1} ${y1}`);
    p.setAttribute("fill", "none"); p.setAttribute("stroke", color); p.setAttribute("stroke-width", String(lw));
    svg.append(p);
  };
  const WHITE = "rgb(255, 255, 255)", CRYO = "rgb(88, 167, 191)", MISSING = "rgb(243, 144, 88)";
  let trained = plan.progress ? Math.min(Math.max(plan.progress, 0.01), 0.999) : 0;
  let training = plan.inTraining ? Math.min(Math.max(plan.inTraining, 0.03), 0.999) : 0;
  if (plan.completed) { trained = 1; training = 0; }
  const remaining = plan.completed ? 0 : Math.max(0, 1 - trained - training);
  arc(0, trained, WHITE);
  arc(trained, trained + training, CRYO);
  arc(1 - remaining, 1, MISSING);
  const cap = (t: number, color: string) => {
    const [x, y] = at(t, outer * 0.94);
    const img = document.createElementNS(NS, "rect");
    img.setAttribute("x", String(x - 15)); img.setAttribute("y", String(y - 15)); img.setAttribute("width", "30"); img.setAttribute("height", "30");
    img.setAttribute("fill", color);
    img.setAttribute("style", `mask: url("${clientTexture("res:/UI/Texture/classes/SkillPlan/milestones/gaugeStartEnd.png")}") center / 30px 30px no-repeat; -webkit-mask: url("${clientTexture("res:/UI/Texture/classes/SkillPlan/milestones/gaugeStartEnd.png")}") center / 30px 30px no-repeat;`);
    svg.append(img);
  };
  cap(0, plan.progress > 0 ? WHITE : MISSING);
  cap(1, plan.progress >= 1 || plan.completed ? WHITE : plan.progress + plan.inTraining >= 1 ? CRYO : MISSING);
  const box = document.createElement("div");
  Object.assign(box.style, { position: "relative", width: `${size}px`, height: `${size}px`, margin: "0 auto" });
  const time = document.createElement("div");
  time.textContent = plan.time();
  // the top wedge (TOPLEFT_PROP 0.5, 0.035, 0.09 x 125/33 wide, 0.09 high), the label centred in it in TextColor.HIGHLIGHT
  Object.assign(time.style, { position: "absolute", left: "0", right: "0", top: `${0.035 * size}px`, height: `${0.09 * size}px`, lineHeight: `${0.09 * size}px`, textAlign: "center", fontSize: "10px", color: "rgba(255,255,255,0.9)" });
  box.append(svg);
  milestoneIndicators(svg, plan.milestones ?? [], { WHITE, CRYO, MISSING });
  // UpdateTopWedge: a completed plan's completedUnderscore (a StretchSpriteHorizontal in the wedge, TOBOTTOM 24 high,
  // top -18, padded -1 either side; LEAFY_GREEN) - shown at this radius too, being the wedge's child, not its
  // background's. Measured in the live client (g316): 56 x 24 at 52, 13 of the 160 gauge; the texture 125 x 24, its
  // ends 6 each kept and the middle stretched.
  if (plan.completed) {
    const url = clientTexture("res:/UI/Texture/classes/SkillPlan/milestones/completedUnderscore.png");
    const under = document.createElement("div");
    Object.assign(under.style, { position: "absolute", left: "52px", top: "13px", width: "56px", height: "24px", display: "flex" });
    const s = 44 / 113;
    for (const [w, size, pos] of [[6, "125px 24px", "0 0"], [44, `${125 * s}px 24px`, `${-6 * s}px 0`], [6, "125px 24px", "-119px 0"]] as const) {
      const part = document.createElement("div");
      const mask = `url("${url}") ${pos} / ${size} no-repeat`;
      part.setAttribute("style", `width:${w}px;height:24px;flex:none;background:rgb(141,193,105);mask:${mask};-webkit-mask:${mask};`);
      under.append(part);
    }
    box.append(under);
  }
  box.append(time);
  return { el: box, tick: () => { time.textContent = plan.time(); } };
}
/**
 * SkillPlanProgressIndicator.UpdateMilestonePositions with its MilestoneProgressIndicators (isEditable False): n of them
 * (at most MAX_NUM_MILESTONES 5), each of radius 0.45 R (1 - 0.085 n), at 0.35 R (1 + 0.21 n / 5) from the centre at
 * START_ANGLE_BY_NUM_MILESTONES[n - 1] - 2 pi i / n (one alone at the centre); R the gauge's 80. Each: a
 * MilestoneProgressGauge - a full circle from the top, clockwise, of MilestoneSegments (DonutSegment, thinGaugeBG.png
 * 43 across, lineWidth 0.75 r: the texture from 0.25 r out to r) trained WHITE, in training CRYO_BLUE, the rest the
 * missing colour, with the same minimum ratios; its kind's icon (MILESTONE_ICON_BY_SUBTYPE) 0.8 r square in the middle;
 * lockButtonCheckmark 20 x 20 at 0.8 r below the centre when it is completed. The ring's look measured in the live
 * client (g319, radius 100 at 0.5 / 0.2: the glow from 0.52 r, the line 0.76 - 0.81 r, out to r).
 */
function milestoneIndicators(svg: SVGSVGElement, list: NonNullable<NonNullable<SkillTrainingTip["plan"]>["milestones"]>, c: { WHITE: string; CRYO: string; MISSING: string }): void {
  const NS = "http://www.w3.org/2000/svg";
  const n = Math.min(list.length, 5);
  if (n === 0) return;
  const R = 80, cx = 80;
  const START = [0, 0, -Math.PI / 2, Math.PI / 4, Math.PI / 10];
  const r = R * 0.45 * (1 - 0.085 * n);
  const at = 0.35 * R * (1 + 0.21 * n / 5);
  // thinGaugeBG.png's alpha across its 43 rows (read from the texture), the inside edge first
  const PROFILE = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 51, 51, 51, 52, 53, 57, 63, 68, 76, 83, 96, 112, 133, 255, 255, 255, 255, 99, 75, 54, 38, 29, 21, 13, 7, 4, 1];
  const defs = document.createElementNS(NS, "defs");
  svg.append(defs);
  const ICONS = { ship: "milestoneShip", skill: "milestoneSkill", module: "milestoneModule", other: "milestoneOther" } as const;
  list.slice(0, n).forEach((m, i) => {
    const angle = (START[n - 1] ?? 0) - 2 * Math.PI * i / n;
    const x = n === 1 ? cx : cx + at * Math.cos(angle), y = n === 1 ? cx : cx + at * Math.sin(angle);
    const gid = `ms-band-${Math.random().toString(36).slice(2)}`;
    const grad = document.createElementNS(NS, "radialGradient");
    grad.setAttribute("id", gid); grad.setAttribute("gradientUnits", "userSpaceOnUse");
    grad.setAttribute("cx", String(x)); grad.setAttribute("cy", String(y)); grad.setAttribute("r", String(r));
    PROFILE.forEach((a, row) => {
      const stop = document.createElementNS(NS, "stop");
      stop.setAttribute("offset", String(0.25 + 0.75 * (row + 0.5) / 43));
      stop.setAttribute("stop-color", "#fff"); stop.setAttribute("stop-opacity", String(a / 255));
      grad.append(stop);
    });
    const mask = document.createElementNS(NS, "mask");
    mask.setAttribute("id", `${gid}-m`);
    const disc = document.createElementNS(NS, "circle");
    disc.setAttribute("cx", String(x)); disc.setAttribute("cy", String(y)); disc.setAttribute("r", String(r)); disc.setAttribute("fill", `url(#${gid})`);
    mask.append(disc);
    defs.append(grad, mask);
    const g = document.createElementNS(NS, "g");
    g.setAttribute("mask", `url(#${gid}-m)`);
    const wedge = (a: number, b: number, color: string) => {
      if (b - a <= 0.0005) return;
      const p = document.createElementNS(NS, "path");
      if (b - a >= 0.9995) {
        p.setAttribute("d", `M ${x - r} ${y} A ${r} ${r} 0 1 1 ${x + r} ${y} A ${r} ${r} 0 1 1 ${x - r} ${y} Z`);
      } else {
        const pt = (t: number) => [x + r * Math.sin(2 * Math.PI * t), y - r * Math.cos(2 * Math.PI * t)] as const;
        const [x0, y0] = pt(a), [x1, y1] = pt(b);
        p.setAttribute("d", `M ${x} ${y} L ${x0} ${y0} A ${r} ${r} 0 ${b - a > 0.5 ? 1 : 0} 1 ${x1} ${y1} Z`);
      }
      p.setAttribute("fill", color);
      g.append(p);
    };
    // MilestoneProgressGauge.UpdateProgress
    const trained = m.progress ? Math.min(Math.max(m.progress, 0.01), 0.999) : 0;
    const training = m.inTraining ? Math.min(Math.max(m.inTraining, 0.03), 0.999) : 0;
    const remaining = m.completed ? 0 : Math.max(0, 1 - trained - training);
    wedge(0, m.completed ? 1 : trained, c.WHITE);
    if (!m.completed) wedge(trained, trained + training, c.CRYO);
    wedge(1 - remaining, 1, c.MISSING);
    svg.append(g);
    const icon = document.createElementNS(NS, "image");
    const w = r * 0.8;
    icon.setAttribute("href", clientTexture(`res:/UI/Texture/Classes/SkillPlan/milestones/${ICONS[m.subType]}.png`));
    icon.setAttribute("x", String(x - w / 2)); icon.setAttribute("y", String(y - w / 2)); icon.setAttribute("width", String(w)); icon.setAttribute("height", String(w));
    svg.append(icon);
    if (m.completed) {
      const check = document.createElementNS(NS, "image");
      check.setAttribute("href", clientTexture("res:/UI/Texture/classes/SkillPlan/lockButtonCheckmark.png"));
      check.setAttribute("x", String(x - 10)); check.setAttribute("y", String(y + r * 0.8 - 10)); check.setAttribute("width", "20"); check.setAttribute("height", "20");
      svg.append(check);
    }
  });
}
let skillTipTimer: ReturnType<typeof setInterval> | null = null;
/**
 * ButtonSkillsTooltipPanel with a skill in training (buttonSkillsTooltipPanel.py, 3698585; measured on the live client
 * g308 / g309, Drones IV -> V: 292 x 164): AddLabelShortcut; AddMediumHeader UI/Neocom/SkillInTraining (a 260 x 36
 * cell, the label 11 in and 9 down, 0.75); the skillBarCont row - the SkillBar 60 x 12 (3 down; boxes 10 x 10 every
 * 12), the time left at the right (0.75), the name and level between, 10 in from the bar (TextColor.HIGHLIGHT 0.9);
 * the description AddLabelMedium wrapWidth 260 (0.75). The tracked skill plan's gauge above them is not on the page.
 */
export function showSkillTrainingTooltip(anchor: HTMLElement, label: string, shortcut: string, t: SkillTrainingTip): void {
  showLabelShortcutTooltip(anchor, label, shortcut, [], "left", true);
  if (!tip) return;
  const grid = tip.querySelector<HTMLElement>(":scope > .lst-grid");
  if (!grid) return;
  const header = document.createElement("div");
  header.textContent = t.header;
  Object.assign(header.style, { gridColumn: "1 / 3", height: "36px", boxSizing: "border-box", padding: "9px 11px 0", lineHeight: "18px", color: "rgba(255,255,255,0.75)" });
  const row = document.createElement("div");
  Object.assign(row.style, { gridColumn: "1 / 3", display: "flex", alignItems: "flex-start", width: "260px", height: "18px" });
  const bar = document.createElement("div");
  Object.assign(bar.style, { display: "flex", flex: "none", width: "60px", height: "12px", marginTop: "3px" });
  for (const fill of t.boxes) {
    const cell = document.createElement("span");
    Object.assign(cell.style, { width: "12px", height: "12px", boxSizing: "border-box", padding: "1px", display: "block" });
    const b = document.createElement("span");
    Object.assign(b.style, { display: "block", width: "10px", height: "10px", background: fill });
    cell.append(b);
    bar.append(cell);
  }
  const name = document.createElement("span");
  name.textContent = t.name;
  Object.assign(name.style, { flex: "1", padding: "0 4px 0 10px", color: "rgba(255,255,255,0.9)", overflow: "hidden" });
  const time = document.createElement("span");
  time.textContent = t.timeLeft();
  Object.assign(time.style, { flex: "none", color: "rgba(255,255,255,0.75)" });
  row.append(bar, name, time);
  const desc = document.createElement("div");
  desc.textContent = t.description;
  Object.assign(desc.style, { gridColumn: "1 / 3", whiteSpace: "normal", width: "260px", color: "rgba(255,255,255,0.75)" });
  let planTick: (() => void) | null = null;
  if (t.plan) {
    // AddSkillPlan: AddMediumHeader UI/Neocom/TrackedSkillPlanProgress and the gauge in a cell over both columns
    const ph = document.createElement("div");
    ph.textContent = t.plan.header;
    Object.assign(ph.style, { gridColumn: "1 / 3", height: "36px", boxSizing: "border-box", padding: "9px 11px 0", lineHeight: "18px", color: "rgba(255,255,255,0.75)" });
    const g = planGauge(t.plan);
    g.el.style.gridColumn = "1 / 3";
    planTick = g.tick;
    grid.append(ph, g.el);
  }
  grid.append(header, row);
  if (t.description) grid.append(desc);
  placeTip(tip, anchor, POINT.LEFT_2);
  if (skillTipTimer) clearInterval(skillTipTimer);
  skillTipTimer = setInterval(() => {
    if (!time.isConnected) { if (skillTipTimer) clearInterval(skillTipTimer); skillTipTimer = null; return; }
    time.textContent = t.timeLeft();
    planTick?.();
  }, 500);
}

/**
 * A panel of icons and values, as DroneEntry.LoadDamageGaugeTooltipPanel builds one: an iconCont of 16 px sprites and
 * a textCont of EveLabelMedium values, each centred in a 40 px column, side by side; above its anchor.
 */
export function showIconValuesTooltip(anchor: HTMLElement, cells: readonly { icon: string; text: string }[]): void {
  showLabelShortcutTooltip(anchor, "", "", [], "top");
  if (!tip) return;
  const grid = tip.querySelector<HTMLElement>(":scope > .lst-grid");
  if (!grid) return;
  grid.replaceChildren();
  // LoadStandardSpacing (cell padding 8, 0) and the two containers parented to the panel, which takes each as a cell of
  // its row: the icons and the values side by side, each 40 px a column (the live client, gridcheck g246: three layers,
  // 304 x 48, sprites at 36 / 76 / 116, 18; the EveLabelMedium values centred at 160 / 200 / 240, 16)
  Object.assign(grid.style, { gridTemplateColumns: "auto auto", columnGap: "0", rowGap: "0", alignItems: "start" });
  const icons = document.createElement("div");
  const values = document.createElement("div");
  for (const part of [icons, values]) Object.assign(part.style, { display: "flex", padding: "0 8px", height: "16px" });
  for (const cell of cells) {
    const box = document.createElement("div");
    Object.assign(box.style, { width: "40px", height: "16px", display: "flex", justifyContent: "center" });
    const img = document.createElement("img");
    img.src = cell.icon;
    img.alt = "";
    Object.assign(img.style, { width: "16px", height: "16px", position: "relative", top: "2px" });
    box.append(img);
    icons.append(box);
    const d = document.createElement("div");
    d.textContent = cell.text;
    Object.assign(d.style, { width: "40px", textAlign: "center", lineHeight: "18px", whiteSpace: "nowrap" });
    values.append(d);
  }
  grid.append(icons, values);
  placeTip(tip, anchor, POINT.BOTTOM_2);
}

/**
 * TooltipGeneric.SetTooltipString: a UI object's hint (its markup) in an EveLabelMedium 200 px wide at most and fitted
 * to its text, 16 px in from the FrameWithPointer frame; default_pointerDirection POINT_BOTTOM_2, the panel above its
 * owner, centred.
 */
/**
 * tooltipHandler._UpdateTooltip for a plain hint: shown after the generic delay (TOOLTIP_DELAY_GENERIC 250 ms), or its
 * renew time (a fifth: 50 ms) while a hint shows or within SLEEPTIME_COOLDOWN (500 ms) of one closing; a new
 * TooltipGeneric fades in over 0.2 s (ANIM_SMOOTH), one already shown takes the new string at once; closing fades it
 * out over FADEOUT_FAST (0.1 s).
 */
let hintTimer: ReturnType<typeof setTimeout> | null = null;
let hintShown = false;
let hintClosedAt = -Infinity;
/** anchor: the owner, or how to find it when the delay is up (a list redrawn meanwhile has a new one). */
export function scheduleGenericHint(anchor: HTMLElement | (() => HTMLElement | null), html: string): void {
  if (hintTimer !== null) clearTimeout(hintTimer);
  const wait = sleepTime(hintShown || performance.now() - hintClosedAt < 500);
  hintTimer = setTimeout(() => {
    hintTimer = null;
    const owner = typeof anchor === "function" ? anchor() : anchor;
    if (!owner?.isConnected) return;
    // a panel of the owner's own (a label-and-shortcut tooltip ...) open in the shared panel: the hint gives way
    if (tip?.isConnected && tip.style.display !== "none" && tip.dataset.generic !== "1") return;
    const fresh = !hintShown;
    showGenericHint(owner, html);
    hintShown = true;
    if (fresh && tip) {
      for (const a of tip.getAnimations()) a.cancel();
      tip.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "cubic-bezier(0.3333, 0, 0.6667, 1)" });
    }
  }, wait);
}
export function cancelGenericHint(): void {
  if (hintTimer !== null) { clearTimeout(hintTimer); hintTimer = null; }
  if (!hintShown) return;
  hintShown = false;
  hintClosedAt = performance.now();
  const t = tip;
  if (!t || t.dataset.generic !== "1") return;
  for (const a of t.getAnimations()) a.cancel();
  const fade = t.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, fill: "forwards" });
  fade.onfinish = () => { if (!hintShown && t.dataset.generic === "1") t.style.display = "none"; fade.cancel(); };
}
/**
 * Every UI object's hint as the client shows one (tooltipHandler -> TooltipGeneric, with its timing): an element's title
 * is taken off it as the pointer comes on (kept in data-client-hint, so the browser's own tooltip never shows) and shown
 * by scheduleGenericHint, as text; leaving the element closes it. Returns the uninstall.
 */
export function installClientHints(doc: Document = document): () => void {
  let owner: HTMLElement | null = null;
  let ownerText: string | null = null;
  const textOf = (el: HTMLElement): string | null => {
    const t = el.getAttribute("title");
    if (t !== null) { el.removeAttribute("title"); if (t) el.dataset.clientHint = t; else delete el.dataset.clientHint; }
    return el.dataset.clientHint ?? null;
  };
  const over = (ev: Event) => {
    const target = ev.target as HTMLElement | null;
    const el = target?.closest?.<HTMLElement>("[title], [data-client-hint]") ?? null;
    if (el && el.closest(".label-shortcut-tooltip")) return;
    const text = el ? textOf(el) : null;
    if (!el || !text) { if (owner) { owner = null; ownerText = null; cancelGenericHint(); } return; }
    // SetHint while the mouse is on it (a hint that follows a value, or where on its owner it is): the new text shown
    if (el === owner && text === ownerText) return;
    owner = el;
    ownerText = text;
    const esc = text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    scheduleGenericHint(el, esc.split("\n").join("<br>"));
  };
  const out = (ev: MouseEvent) => {
    if (!owner) return;
    const to = ev.relatedTarget as Node | null;
    if (to && owner.contains(to)) return;
    owner = null;
    ownerText = null;
    cancelGenericHint();
  };
  doc.addEventListener("mouseover", over, true);
  doc.addEventListener("mousemove", over, true);
  doc.addEventListener("mouseout", out, true);
  return () => { doc.removeEventListener("mouseover", over, true); doc.removeEventListener("mousemove", over, true); doc.removeEventListener("mouseout", out, true); if (owner) cancelGenericHint(); owner = null; ownerText = null; };
}
export function showGenericHint(anchor: HTMLElement, html: string): void {
  showLabelShortcutTooltip(anchor, "", "", [], "top");
  if (!tip) return;
  const grid = tip.querySelector<HTMLElement>(":scope > .lst-grid");
  if (!grid) return;
  grid.replaceChildren();
  grid.style.gridTemplateColumns = "auto";
  const d = document.createElement("div");
  d.innerHTML = html;
  Object.assign(d.style, { maxWidth: "200px", whiteSpace: "normal" });
  grid.append(d);
  tip.dataset.generic = "1";
  placeTip(tip, anchor, POINT.BOTTOM_2);
}

/**
 * InfoPanelLocationInfo._security_status_tooltip_panel: a two-column LayoutGrid of fixed width 320 - the range's tagline
 * (EveLabelMedium bold, TextColor.HIGHLIGHT; cell padding 16, 16, 16, 0), its description (cell padding 16) and
 * UI/SecurityStatus/ShowOnMap with its link (cell padding 0, 16, 16, 16) - in the panel at cell padding 5;
 * _security_status_tooltip_pointer POINT_TOP_1: the panel under its anchor, the pointer near the panel's left.
 */
export function showSecurityStatusTooltip(anchor: HTMLElement, tagline: string, descriptionHtml: string, mapHtml: string): void {
  showLabelShortcutTooltip(anchor, "", "", [], "top");
  if (!tip) return;
  const grid = tip.querySelector<HTMLElement>(":scope > .lst-grid");
  if (!grid) return;
  grid.replaceChildren();
  Object.assign(grid.style, { gridTemplateColumns: "320px", rowGap: "0", columnGap: "0" });
  tip.style.padding = "5px";
  const cell = (html: string, padding: string, extra: Partial<CSSStyleDeclaration> = {}) => {
    const d = document.createElement("div");
    d.innerHTML = html;
    Object.assign(d.style, { padding, whiteSpace: "normal", ...extra });
    grid.append(d);
  };
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  cell(esc(tagline), "16px 16px 0 16px", { fontWeight: "bold", color: "rgba(255,255,255,1)" });
  cell(descriptionHtml, "16px");
  cell(mapHtml, "0 16px 16px 16px");
  placeTip(tip, anchor, POINT.TOP_1);
}

/**
 * tooltipHandler._GetSleepTime for a tooltip panel: it loads after the generic delay (TOOLTIP_DELAY_GENERIC 250 ms), or
 * the renew time (a fifth, 50 ms) while a panel shows or within SLEEPTIME_COOLDOWN (500 ms) of one closing - so moving
 * along a row of buttons swaps their panels at once. show runs then, while the anchor is still in the page.
 */
let dueTimer: ReturnType<typeof setTimeout> | null = null;
/** The close running (its serial), if any. */
let closing: number | null = null;
let closeSerial = 0;
let panelClosedAt = -Infinity;
export function tooltipDue(anchor: HTMLElement, show: () => void): void {
  if (dueTimer !== null) clearTimeout(dueTimer);
  const open = !!tip && tip.isConnected && tip.style.display !== "none";
  const wait = sleepTime(open || performance.now() - panelClosedAt < 500);
  dueTimer = setTimeout(() => { dueTimer = null; if (anchor.isConnected) show(); }, wait);
}

/** _GetSleepTime for a panel of its own: the renew time while one shows or just closed, else the generic delay. */
export function panelDelay(open: boolean): number { return sleepTime(open || performance.now() - panelClosedAt < 500); }
/** A panel of its own closed (for the next one's renew time). */
export function notePanelClosed(): void { panelClosedAt = performance.now(); }
/** PointerPanel.ShowPanel on a panel of its own: from nothing to full over 0.05 s. */
export function fadePanelIn(el: HTMLElement): void {
  for (const a of el.getAnimations()) a.cancel();
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 50, easing: "cubic-bezier(0.3333, 0, 0.6667, 1)" });
}
/**
 * FadeOutPanelAndClose (FADEOUT_FAST) on a panel of its own: faded out over 0.05 s and scaled to nothing about its
 * pointer over 0.1 s, then done(); with no pointer done() at once.
 */
export function foldPanelAway(el: HTMLElement, done: () => void): void {
  const pointer = el.querySelector<HTMLImageElement>(":scope > img.pp-pointer");
  if (!pointer) { done(); return; }
  for (const a of el.getAnimations()) a.cancel();
  el.style.transformOrigin = `${pointer.offsetLeft + pointer.offsetWidth / 2}px ${pointer.offsetTop + pointer.offsetHeight / 2}px`;
  const ease = "cubic-bezier(0.3333, 0, 0.6667, 1)";
  el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 50, easing: ease, fill: "forwards" });
  const shrink = el.animate([{ transform: "scale(1)" }, { transform: "scale(0)" }], { duration: 100, easing: ease, fill: "forwards" });
  shrink.onfinish = () => { done(); for (const a of el.getAnimations()) a.cancel(); };
}

export function hideLabelShortcutTooltip(): void {
  if (dueTimer !== null) { clearTimeout(dueTimer); dueTimer = null; }
  if (!tip || tip.style.display === "none" || closing !== null) return;
  panelClosedAt = performance.now();
  // FadeOutPanelAndClose (FADEOUT_FAST 0.1 s): faded out over half the time while scaled to nothing about the pointer's
  // tip over all of it, then closed; a panel with no pointer closes at once
  const t = tip;
  const pointer = t.querySelector<HTMLImageElement>(":scope > img.pp-pointer");
  if (!pointer) { t.style.display = "none"; return; }
  for (const a of t.getAnimations()) a.cancel();
  const token = closing = ++closeSerial;
  t.style.transformOrigin = `${pointer.offsetLeft + pointer.offsetWidth / 2}px ${pointer.offsetTop + pointer.offsetHeight / 2}px`;
  const ease = "cubic-bezier(0.3333, 0, 0.6667, 1)";
  t.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 50, easing: ease, fill: "forwards" });
  const shrink = t.animate([{ transform: "scale(1)" }, { transform: "scale(0)" }], { duration: 100, easing: ease, fill: "forwards" });
  shrink.onfinish = () => { if (closing !== token) return; closing = null; t.style.display = "none"; for (const a of t.getAnimations()) a.cancel(); };
}

/**
 * TooltipGeneric's LoadGeneric2ColumnTemplate as InventoryItemTooltip fills it (tooltip/item.py): its first line in
 * EveLabelMediumBold, the rest AddLabelMedium at opacity 0.5, over both columns; pointed from below (InvItem
 * GetTooltipPointer POINT_BOTTOM_2: the panel above its anchor).
 */
export function showItemTooltip(anchor: HTMLElement, head: string, dimLines: readonly string[]): void {
  showLabelShortcutTooltip(anchor, head, "", [], "top");
  if (!tip) return;
  const grid = tip.querySelector<HTMLElement>(":scope > .lst-grid");
  // InventoryItemTooltip: one column, no shortcut cell (the live client, g239: Mining Drone I 128 x 76)
  if (grid) { grid.style.gridTemplateColumns = "auto"; grid.children[1]?.remove(); }
  for (const line of dimLines) {
    const d = document.createElement("div");
    d.textContent = line;
    Object.assign(d.style, { color: "rgba(255,255,255,0.5)" });
    grid?.append(d);
  }
  placeTip(tip, anchor, POINT.BOTTOM_2);
}

/**
 * DroneGroupHeaderInSpaceTooltipPanel (droneGroupHeader.py, 3698585): MaxDronesInSpace over both columns (wrapWidth 250),
 * the Drones skill's SkillEntry (showLevel off: the skill's name, then its SkillBar), an 8 px spacer, and AddIconLabel of
 * the drone bandwidth attribute's icon with "<LED_GREY>Bandwidth used</color> used/total"; pointed from the right
 * (POINT_RIGHT_2: the panel to its anchor's left), 16 px margin.
 */
export function showDronesInSpaceTooltip(anchor: HTMLElement, rows: {
  readonly maxLine: string;
  readonly skillName: string;
  readonly skillBoxes: readonly { readonly color: string; readonly outline: boolean }[];
  readonly bandwidthIcon: string;
  readonly bandwidthLabel: string;
  readonly bandwidthValue: string;
}): void {
  showLabelShortcutTooltip(anchor, "", "", [], "top");
  if (!tip) return;
  const grid = tip.querySelector<HTMLElement>(":scope > .lst-grid");
  if (!grid) return;
  grid.replaceChildren();
  // a two-column LayoutGrid (measured on the live client's panel, 299 x 142: the line at 16,16 246 wide; Drones at 26,60;
  // the SkillBar 60 x 12 at 215,63, its boxes 10 x 10 every 12; the icon 32 at 13,94; the label at 66,101)
  Object.assign(grid.style, { gridTemplateColumns: "auto auto", columnGap: "0", rowGap: "0", alignItems: "center" });
  const max = document.createElement("div");
  max.textContent = rows.maxLine;
  Object.assign(max.style, { gridColumn: "1 / 3", whiteSpace: "normal", width: "246px", lineHeight: "18px" });
  // SkillEntry: its label 10 in (textPadding 0, 3, 0, 3), its SkillBar's cell padded 24, 8, 8, 8 around the bar's
  // container, itself padded 0, 3, 0, 3 (the row 34 high)
  const name = document.createElement("div");
  name.textContent = rows.skillName;
  Object.assign(name.style, { padding: "3px 0 3px 10px", lineHeight: "18px" });
  const bar = document.createElement("div");
  Object.assign(bar.style, { display: "flex", gap: "2px", padding: "1px", margin: "11px 8px 11px 24px", justifySelf: "end", boxSizing: "border-box", width: "60px", height: "12px" });
  for (const box of rows.skillBoxes) {
    const b = document.createElement("span");
    Object.assign(b.style, { width: "10px", height: "10px", boxSizing: "border-box", background: box.color, outline: box.outline ? "1px solid rgba(204,204,204,1)" : "" });
    bar.append(b);
  }
  const spacer = document.createElement("div");
  Object.assign(spacer.style, { gridColumn: "1 / 3", height: "8px" });
  // AddIconLabel: the 32 px icon in the first column (cell padding -3, 0, 7, 0), the label bold in the second (0, 0, 7, 0)
  const icon = document.createElement("img");
  icon.src = rows.bandwidthIcon;
  icon.alt = "";
  Object.assign(icon.style, { width: "32px", height: "32px", marginLeft: "-3px", marginRight: "7px" });
  const label = document.createElement("span");
  label.textContent = rows.bandwidthLabel;
  label.style.color = "#8A8A8A";
  const bw = document.createElement("div");
  Object.assign(bw.style, { fontWeight: "bold", paddingRight: "7px", lineHeight: "18px" });
  bw.append(label, document.createTextNode(" " + rows.bandwidthValue));
  grid.append(max, name, bar, spacer, icon, bw);
  placeTip(tip, anchor, POINT.RIGHT_2);
}
