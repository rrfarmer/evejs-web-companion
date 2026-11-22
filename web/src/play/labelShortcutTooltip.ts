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
