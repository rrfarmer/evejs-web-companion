import type { Vector3 } from "three";
import { clientTexture } from "./window.ts";
import { markerStacks, markerTooltipRows, type ProjectedMarker } from "./mapMarkerStacks.ts";

export interface MapMarker extends ProjectedMarker {
  at: Vector3;
  el: HTMLDivElement;
  partial?: boolean;
  displayName?(): string;
  label(): string;
  select?(event: MouseEvent): void;
  contextMenu?(event: MouseEvent): void;
}

type MapMarkerSource = Omit<MapMarker, "x" | "y" | "cameraDistance" | "name" | "highlighted">;

const STACK_TEXTURE = clientTexture("res:/UI/Texture/classes/MapView/tagBackgroundStackIndicator.png");

/** The map's marker layer and the shared MarkerTooltipBase panel. */
export class MapMarkerOverlay {
  readonly layer = document.createElement("div");
  private readonly tooltip = document.createElement("div");
  private hovered: MapMarker | null = null;
  private owner: MapMarker | null = null;
  private rows: { marker: MapMarker; label: HTMLSpanElement; el: HTMLElement }[] = [];
  private visible: readonly MapMarker[] = [];
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshAt = 0;

  constructor(private readonly host: HTMLElement) {
    this.layer.className = "ssm-markers";
    this.tooltip.className = "ssm-marker-tooltip";
    this.tooltip.setAttribute("role", "group");
    this.tooltip.setAttribute("aria-label", "Overlapping markers");
    this.tooltip.hidden = true;
    this.tooltip.addEventListener("mouseenter", () => clearTimeout(this.hoverTimer));
    this.tooltip.addEventListener("mouseleave", () => this.dismissSoon());
    host.append(this.layer, this.tooltip);
  }

  add(source: MapMarkerSource): MapMarker {
    const marker: MapMarker = { ...source, x: 0, y: 0, cameraDistance: 0, name: "", highlighted: false };
    const { el } = marker;
    el.addEventListener("mouseenter", () => {
      if (this.owner && this.owner !== marker) this.hideTooltip();
      this.hovered = marker;
      el.classList.add("hover");
      const label = el.querySelector<HTMLElement>(".ssm-label");
      if (label) label.textContent = marker.label();
      clearTimeout(this.hoverTimer);
      this.hoverTimer = setTimeout(() => {
        if (this.hovered !== marker || el.classList.contains("ssm-overlapped")) return;
        this.owner = marker;
        this.updateTooltip();
      }, 250);
    });
    el.addEventListener("mouseleave", () => {
      el.classList.remove("hover");
      if (this.hovered === marker) this.hovered = null;
      this.dismissSoon();
    });
    if (marker.select) el.addEventListener("click", marker.select);
    if (marker.contextMenu) el.addEventListener("contextmenu", marker.contextMenu);
    this.layer.append(el);
    this.refreshAt = 0;
    return marker;
  }

  remove(marker: MapMarker): void {
    if (this.hovered === marker || this.owner === marker) this.clearTooltip();
    marker.el.remove();
    this.refreshAt = 0;
  }

  update(markers: readonly MapMarker[], now: number): void {
    this.visible = markers;
    if (now < this.refreshAt) return;
    this.refreshAt = now + 500;
    for (const marker of markers) marker.name = marker.displayName?.().toLowerCase() ?? "";
    const { covered, stacks } = markerStacks(markers);
    // UpdateMarkers moves the nearest markers to the front independently of stack order.
    [...markers].sort((a, b) => b.cameraDistance - a.cameraDistance).forEach((marker, index) => {
      marker.el.style.zIndex = String(index);
      marker.el.classList.toggle("ssm-overlapped", marker.kind !== "result" && covered.has(marker));
      this.setIndicators(marker.el, Math.min(5, stacks.get(marker)?.length ?? 0));
    });
    if (this.owner) this.updateTooltip();
  }

  clearTooltip(): void {
    clearTimeout(this.hoverTimer);
    this.hovered?.el.classList.remove("hover");
    this.hovered = null;
    this.hideTooltip();
  }

  private hideTooltip(): void {
    this.clearRowHover();
    this.owner = null;
    this.rows = [];
    this.tooltip.hidden = true;
    this.tooltip.replaceChildren();
  }

  private dismissSoon(): void {
    clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(() => this.hideTooltip(), 180);
  }

  private setIndicators(el: HTMLElement, count: number): void {
    const current = el.querySelector<HTMLElement>(".ssm-stack");
    if (current?.childElementCount === count) return;
    current?.remove();
    if (!count) return;
    const stack = document.createElement("span");
    stack.className = "ssm-stack";
    for (let i = 0; i < count; i++) {
      const icon = document.createElement("img");
      icon.src = STACK_TEXTURE;
      icon.alt = "";
      icon.style.top = `${-9 - i * 3}px`;
      icon.style.opacity = String(1 - i / 5);
      stack.append(icon);
    }
    el.append(stack);
  }

  private updateTooltip(): void {
    const owner = this.owner;
    if (!owner || !this.visible.includes(owner) || owner.el.classList.contains("ssm-overlapped")) {
      this.hideTooltip();
      return;
    }
    const markers = markerTooltipRows(owner, this.visible);
    if (markers.length < 2) { this.hideTooltip(); return; }
    const changed = markers.length !== this.rows.length || markers.some((marker, i) => marker !== this.rows[i]?.marker);
    if (changed) {
      this.clearRowHover();
      this.rows = markers.map((marker) => this.makeRow(marker));
      this.tooltip.replaceChildren(...this.rows.map((row) => row.el));
      this.tooltip.hidden = false;
    }
    for (const { el, label, marker } of this.rows) {
      label.textContent = marker.label();
      el.classList.toggle("dscan-shape", marker.highlighted);
    }
    if (changed) this.tooltip.scrollTop = this.tooltip.scrollHeight;
    const x = owner.x + 7;
    const width = this.tooltip.offsetWidth, height = this.tooltip.offsetHeight;
    const left = x + width <= this.host.clientWidth ? x : owner.x - 7 - width;
    this.tooltip.style.left = `${Math.max(0, left)}px`;
    this.tooltip.style.top = `${Math.max(0, Math.min(this.host.clientHeight - height, owner.y - 7))}px`;
  }

  private clearRowHover(): void {
    for (const { marker } of this.rows) {
      if (marker !== this.hovered) marker.el.classList.remove("hover");
    }
  }

  private makeRow(marker: MapMarker) {
    const el: HTMLElement = document.createElement(marker.select ? "button" : "div");
    if (el instanceof HTMLButtonElement) el.type = "button";
    el.className = "ssm-marker-tooltip-row";
    const icon = document.createElement("span");
    icon.className = "ssm-marker-tooltip-icon";
    const sprite = marker.el.querySelector(".ssm-icon, .ssm-result-icon");
    if (sprite) icon.append(sprite.cloneNode(true));
    const mask = sprite instanceof HTMLImageElement ? `url("${sprite.src}")` : marker.el.style.getPropertyValue("--result-icon");
    if (mask) icon.style.setProperty("--marker-mask", mask);
    for (const prop of ["--result-icon", "--result-colour"]) {
      icon.style.setProperty(prop, marker.el.style.getPropertyValue(prop));
    }
    const label = document.createElement("span");
    el.append(icon, label);
    if (marker.select) el.addEventListener("click", marker.select);
    if (marker.contextMenu) el.addEventListener("contextmenu", marker.contextMenu);
    el.addEventListener("mouseenter", () => marker.el.classList.add("hover"));
    el.addEventListener("mouseleave", () => marker.el.classList.remove("hover"));
    return { marker, label, el };
  }
}
