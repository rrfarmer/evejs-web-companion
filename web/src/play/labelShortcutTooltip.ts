// A tooltip panel as the client's TooltipGeneric draws one with AddLabelShortcut (tooltips.py: the label EveLabelMedium in
// bold beside its shortcut's ShortcutHint) and, below, any further lines (AddLabelMedium over both columns) - in the
// FrameWithPointer background_04 frame at 0.75, 16 px in, as the HUD's command tooltips (newShipHud.ts).
import { clientTexture } from "./window.ts";

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
/** The page's gap between the anchor and its panel (the client's pointerSize, with the frame's outset). */
const POINTER_GAP = 12;
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
 * or the middle) - 16 px outside the edge as the page's other framed tooltips draw it; none for a corner flag.
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

export function showLabelShortcutTooltip(anchor: HTMLElement, label: string, shortcut: string, lines: readonly string[] = [], pointer: "top" | "left" = "top"): void {
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "label-shortcut-tooltip";
    Object.assign(tip.style, { position: "fixed", pointerEvents: "none", zIndex: "100000", padding: "16px", font: "14px 'EVE Sans Neue','Segoe UI',sans-serif", color: "rgba(255,255,255,0.75)", whiteSpace: "nowrap" });
  }
  if (!tip.isConnected) document.body.append(tip);
  tip.replaceChildren();
  const frame = document.createElement("div");
  Object.assign(frame.style, { position: "absolute", inset: "0", opacity: "0.75", borderStyle: "solid", borderWidth: "0", borderImageSource: `url(${clientTexture("res:/UI/Texture/classes/FrameWithPointer/background_04.png")})`, borderImageSlice: "19 fill", borderImageWidth: "19px", borderImageOutset: "15px" } as Partial<CSSStyleDeclaration>);
  const grid = document.createElement("div");
  Object.assign(grid.style, { position: "relative", display: "grid", gridTemplateColumns: "auto auto", columnGap: "16px", rowGap: "4px", alignItems: "center" });
  const head = document.createElement("div");
  head.textContent = label;
  Object.assign(head.style, { fontWeight: "bold", color: "rgba(255,255,255,0.95)" });
  const hint = document.createElement("div");
  if (shortcut) {
    hint.textContent = shortcut;
    Object.assign(hint.style, { justifySelf: "end", padding: "0 13px", height: "18px", lineHeight: "18px", background: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.5)", fontWeight: "bold" });
  }
  grid.append(head, hint);
  for (const line of lines) {
    const d = document.createElement("div");
    d.textContent = line;
    Object.assign(d.style, { gridColumn: "1 / 3", whiteSpace: "normal", maxWidth: "260px" });
    grid.append(d);
  }
  tip.append(frame, grid);
  tip.style.display = "";
  // POINT_TOP_2: the panel below its anchor; POINT_LEFT_2: to its right
  placeTip(tip, anchor, pointer === "top" ? POINT.TOP_2 : POINT.LEFT_2);
}

/**
 * A panel of icons over values, as DroneEntry.LoadDamageGaugeTooltipPanel builds one: an iconCont row of 16 px sprites
 * and a textCont row of EveLabelMedium values, each centred in a 40 px column; above its anchor.
 */
export function showIconValuesTooltip(anchor: HTMLElement, cells: readonly { icon: string; text: string }[]): void {
  showLabelShortcutTooltip(anchor, "", "", [], "top");
  if (!tip) return;
  const grid = tip.lastElementChild as HTMLElement | null;
  if (!grid) return;
  grid.replaceChildren();
  Object.assign(grid.style, { gridTemplateColumns: `repeat(${cells.length}, 40px)`, columnGap: "0", rowGap: "2px", justifyItems: "center" });
  for (const cell of cells) {
    const img = document.createElement("img");
    img.src = cell.icon;
    img.alt = "";
    Object.assign(img.style, { width: "16px", height: "16px", marginTop: "4px" });
    grid.append(img);
  }
  for (const cell of cells) {
    const d = document.createElement("div");
    d.textContent = cell.text;
    Object.assign(d.style, { fontSize: "12px", lineHeight: "16px" });
    grid.append(d);
  }
  placeTip(tip, anchor, POINT.BOTTOM_2);
}

export function hideLabelShortcutTooltip(): void {
  if (tip) tip.style.display = "none";
}

/**
 * TooltipGeneric's LoadGeneric2ColumnTemplate as InventoryItemTooltip fills it (tooltip/item.py): its first line in
 * EveLabelMediumBold, the rest AddLabelMedium at opacity 0.5, over both columns; pointed from below (InvItem
 * GetTooltipPointer POINT_BOTTOM_2: the panel above its anchor).
 */
export function showItemTooltip(anchor: HTMLElement, head: string, dimLines: readonly string[]): void {
  showLabelShortcutTooltip(anchor, head, "", [], "top");
  if (!tip) return;
  const grid = tip.lastElementChild as HTMLElement | null;
  for (const line of dimLines) {
    const d = document.createElement("div");
    d.textContent = line;
    Object.assign(d.style, { gridColumn: "1 / 3", color: "rgba(255,255,255,0.5)" });
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
  const grid = tip.lastElementChild as HTMLElement | null;
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
