// A tooltip panel as the client's TooltipGeneric draws one with AddLabelShortcut (tooltips.py: the label EveLabelMedium in
// bold beside its shortcut's ShortcutHint) and, below, any further lines (AddLabelMedium over both columns) - in the
// FrameWithPointer background_04 frame at 0.75, 16 px in, as the HUD's command tooltips (newShipHud.ts).
import { clientTexture } from "./window.ts";

let tip: HTMLDivElement | null = null;

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
  const a = anchor.getBoundingClientRect();
  if (pointer === "top") {
    // POINT_TOP_*: the panel below its anchor
    tip.style.left = `${Math.round(Math.max(4, a.left + a.width / 2 - tip.offsetWidth / 2))}px`;
    tip.style.top = `${Math.round(a.bottom + 12)}px`;
  } else {
    tip.style.left = `${Math.round(a.right + 12)}px`;
    tip.style.top = `${Math.round(a.top + a.height / 2 - tip.offsetHeight / 2)}px`;
  }
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
  const a = anchor.getBoundingClientRect();
  tip.style.left = `${Math.round(Math.max(4, a.left + a.width / 2 - tip.offsetWidth / 2))}px`;
  tip.style.top = `${Math.round(Math.max(4, a.top - 12 - tip.offsetHeight))}px`;
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
  const a = anchor.getBoundingClientRect();
  tip.style.left = `${Math.round(Math.max(4, a.left + a.width / 2 - tip.offsetWidth / 2))}px`;
  tip.style.top = `${Math.round(Math.max(4, a.top - 12 - tip.offsetHeight))}px`;
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
  Object.assign(grid.style, { gridTemplateColumns: "auto auto", columnGap: "0", rowGap: "0" });
  const max = document.createElement("div");
  max.textContent = rows.maxLine;
  Object.assign(max.style, { gridColumn: "1 / 3", whiteSpace: "normal", maxWidth: "250px" });
  const name = document.createElement("div");
  name.textContent = rows.skillName;
  Object.assign(name.style, { padding: "3px 0 3px 10px" });
  const bar = document.createElement("div");
  Object.assign(bar.style, { display: "inline-flex", gap: "2px", padding: "8px 8px 8px 24px", justifySelf: "end" });
  for (const box of rows.skillBoxes) {
    const b = document.createElement("span");
    Object.assign(b.style, { width: "8px", height: "8px", boxSizing: "border-box", background: box.color, outline: box.outline ? "1px solid rgba(204,204,204,1)" : "" });
    bar.append(b);
  }
  const spacer = document.createElement("div");
  Object.assign(spacer.style, { gridColumn: "1 / 3", height: "8px" });
  const bw = document.createElement("div");
  // AddIconLabel: the 32 px icon (cell padding -3, 0, 7, 0), the label bold (cell padding 0, 0, 7, 0)
  Object.assign(bw.style, { gridColumn: "1 / 3", display: "flex", alignItems: "center", gap: "7px", fontWeight: "bold" });
  const icon = document.createElement("img");
  icon.src = rows.bandwidthIcon;
  icon.alt = "";
  Object.assign(icon.style, { width: "32px", height: "32px", marginLeft: "-3px" });
  const label = document.createElement("span");
  label.textContent = rows.bandwidthLabel;
  label.style.color = "#8A8A8A";
  const value = document.createElement("span");
  value.append(label, document.createTextNode(` ${rows.bandwidthValue}`));
  bw.append(icon, value);
  grid.append(max, name, bar, spacer, bw);
  const a = anchor.getBoundingClientRect();
  tip.style.left = `${Math.round(Math.max(4, a.left - 12 - tip.offsetWidth))}px`;
  tip.style.top = `${Math.round(a.top + a.height / 2 - tip.offsetHeight / 2)}px`;
}
