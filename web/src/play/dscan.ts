// The directional scanner, as the client's (parklife/directionalScanSvc.py DirectionalScan; inflight/scannerFiles):
// scanMgr.ConeScan(scanAngle, scanRange, *direction), the direction the camera looks (GetScanDirection: the space
// camera's look-at direction negated), the angle in radians and the range in metres; the server answers with a row
// for each thing it saw ({id, typeID, groupID}), nearest first. Opened with Alt+D, scanned with V or its button
// (eveCommands: OpenDirectionalScanner, CmdRefreshDirectionalScan).

import { PlayWindow, clientTexture } from "./window.ts";
import { bracketIcon } from "./brackets.ts";

const AU = 149_597_870_700;
/** The angles the client's scanner offers, in degrees. */
const ANGLES = [5, 15, 30, 60, 90, 180, 360] as const;
const MAX_RANGE_AU = 14.3;

export interface DScanRow { id: number; typeID: number; groupID: number }

/** The scan's rows from what the bridge hands back: a list of KeyVals, each however the wire decoded it. */
export function dscanRows(result: unknown): DScanRow[] {
  const list = Array.isArray(result) ? result : (result as { items?: unknown[] } | null)?.items ?? [];
  const field = (row: unknown, name: string): number => {
    if (!row || typeof row !== "object") return 0;
    const r = row as Record<string, unknown>;
    if (name in r) return Number(unwrap(r[name])) || 0;
    for (const holder of [r.args, r.fields, r.entries, r.dict, r.value]) {
      if (Array.isArray(holder)) {
        const hit = holder.find((e) => Array.isArray(e) && e[0] === name) as unknown[] | undefined;
        if (hit) return Number(unwrap(hit[1])) || 0;
      } else if (holder && typeof holder === "object") {
        const n = field(holder, name);
        if (n) return n;
      }
    }
    return 0;
  };
  return list.map((row) => ({ id: field(row, "id"), typeID: field(row, "typeID"), groupID: field(row, "groupID") })).filter((r) => r.typeID > 0);
}
const unwrap = (v: unknown): unknown => (v && typeof v === "object" && "value" in (v as object) ? (v as { value: unknown }).value : v);

export interface DScanHooks {
  scan(angleRadians: number, rangeMetres: number, direction: [number, number, number]): Promise<unknown>;
  /** The way the camera looks, in EVE's own space. */
  direction(): [number, number, number];
  /** A name and a distance for a thing the park holds; nulls for one it does not. */
  known(id: number): { name: string | null; distance: number | null };
  typeName(typeID: number): string | null;
  groupName(groupID: number): string | null;
  /** The install's words for a label, filled; null where they are not had (the window keeps its own). */
  word?(label: string, args?: Readonly<Record<string, string | number>>): string | null;
}

/** The labels the window asks the install for (directionalScannerPalette.py, directionalScanResultEntry.py). */
export const DSCAN_WORDS: readonly string[] = ["UI/Inflight/Scanner/DirectionalScanner", "UI/Inflight/Scanner/ScanResults",
  "UI/Inflight/Scanner/Range", "UI/Inflight/Scanner/UnitAU", "UI/Inflight/Scanner/UnitKm", "UI/Inflight/Scanner/Angle",
  "UI/Inflight/Scanner/AngleDegrees", "UI/Inflight/Scanner/Scan", "UI/Common/Name", "UI/Common/Type", "UI/Common/Distance",
  "UI/Inflight/Scanner/AlignWithCamera", "UI/Inflight/Scanner/ShowScanCone", "UI/Map/MapPallet/btnSolarsystemMap"];

function distanceWords(m: number | null): string {
  if (m === null) return "-";
  if (m >= 0.1 * AU) return `${(m / AU).toFixed(1)} AU`;
  if (m >= 10_000) return `${Math.round(m / 1000).toLocaleString()} km`;
  return `${Math.round(m).toLocaleString()} m`;
}

export class DScanWindow {
  readonly window: PlayWindow;
  private readonly angle: HTMLInputElement;
  private readonly range: HTMLInputElement;
  private readonly rangeSlider: HTMLInputElement;
  private readonly unit: HTMLButtonElement;
  private inKm = false;
  private readonly tbody: HTMLTableSectionElement;
  private readonly status: HTMLDivElement;
  private busy = false;
  rows: DScanRow[] = [];

  /** Whether the window's close button has taken it off the page (it is put back on opening). */
  private detached = false;

  constructor(private readonly hooks: DScanHooks, private readonly host: HTMLElement) {
    // DirectionalScanner (directionalScannerWindow.py: 400 x 350, caption UI/Inflight/Scanner/DirectionalScanner) and
    // its palette (directionalScannerPalette.py): the header row - ScanResults at the left, the filter box and the
    // align-with-camera, show-cone and map buttons at the right; the scroll - the icon 16 (fixed 20), Name 160, Type 130,
    // Distance 100 (directionalScanResultEntry GetColumnsDefaultSize); the bottom container on its segment underlay -
    // the range half (Range, its edit, the AU / km toggle; the slider) and the angle half ("Angle: n°"; the slider over
    // ANGLE_INCREMENTS, even steps), the Scan button at the right.
    const w = (label: string, own: string, args?: Readonly<Record<string, string | number>>) => hooks.word?.(label, args) ?? own;
    this.window = new PlayWindow({ id: "dscan", caption: w("UI/Inflight/Scanner/DirectionalScanner", "Directional Scanner"), icon: clientTexture("res:/UI/Texture/eveicon/product_icons/directional_scanner_64px.png"), left: Math.max(16, Math.round(innerWidth / 2 - 200)), top: 40, width: 400, height: 350, minWidth: 320, closable: true }, () => { this.detached = true; });
    this.window.body.classList.add("dscan");
    const icon = (path: string, title: string) => `<button type="button" class="dscan-ic" title="${title}" disabled><img alt="" src="/client-res/${path}"></button>`;
    this.window.body.innerHTML = `
      <div class="dscan-head"><span class="dscan-caption">${w("UI/Inflight/Scanner/ScanResults", "Scan Results")}</span><span class="dscan-filter">-</span>
        ${icon("ui/texture/classes/mapview/alignwithcamera.png", w("UI/Inflight/Scanner/AlignWithCamera", "Align with camera"))}
        ${icon("ui/texture/classes/mapview/dscanicon.png", w("UI/Inflight/Scanner/ShowScanCone", "Show scan cone"))}
        ${icon("ui/texture/shared/brackets/solarsystem.png", w("UI/Map/MapPallet/btnSolarsystemMap", "Solar system map"))}</div>
      <div class="ov-scroll dscan-scroll"><table class="ov-table"><thead><tr><th class="ov-icon"></th><th>${w("UI/Common/Name", "Name")}</th><th>${w("UI/Common/Type", "Type")}</th><th class="ov-dist">${w("UI/Common/Distance", "Distance")}</th></tr></thead><tbody></tbody></table></div>
      <div class="dscan-status"></div>
      <div class="dscan-bottom">
        <div class="dscan-half"><div class="dscan-top"><span>${w("UI/Inflight/Scanner/Range", "Range")}</span><input class="dscan-range" type="number" min="0.1" step="0.1" value="${MAX_RANGE_AU}"><button type="button" class="dscan-unit"></button></div>
          <input class="dscan-range-slider" type="range" min="0" max="${MAX_RANGE_AU}" step="0.1" value="${MAX_RANGE_AU}"></div>
        <div class="dscan-half"><div class="dscan-top"><span class="dscan-angle-label"></span></div>
          <input class="dscan-angle" type="range" min="0" max="${ANGLES.length - 1}" step="1" value="${ANGLES.length - 1}"></div>
        <button type="button" class="dscan-go">${w("UI/Inflight/Scanner/Scan", "Scan")}</button>
      </div>`;
    this.angle = this.window.body.querySelector(".dscan-angle")!;
    this.range = this.window.body.querySelector(".dscan-range")!;
    this.rangeSlider = this.window.body.querySelector(".dscan-range-slider")!;
    this.unit = this.window.body.querySelector(".dscan-unit")!;
    this.tbody = this.window.body.querySelector("tbody")!;
    this.status = this.window.body.querySelector(".dscan-status")!;
    const angleLabel = this.window.body.querySelector(".dscan-angle-label")!;
    const showAngle = () => {
      const value = ANGLES[Number(this.angle.value)] ?? 360;
      angleLabel.textContent = `${w("UI/Inflight/Scanner/Angle", "Angle")}: ${w("UI/Inflight/Scanner/AngleDegrees", `${value}°`, { value })}`;
    };
    const showUnit = () => {
      this.unit.textContent = this.inKm ? w("UI/Inflight/Scanner/UnitKm", "km") : w("UI/Inflight/Scanner/UnitAU", "AU");
      const au = Number(this.rangeSlider.value);
      this.range.value = this.inKm ? String(Math.round(au * AU / 1000)) : String(au);
      this.range.step = this.inKm ? "1" : "0.1";
    };
    showAngle();
    showUnit();
    this.angle.addEventListener("input", showAngle);
    this.rangeSlider.addEventListener("input", showUnit);
    this.range.addEventListener("change", () => {
      const n = Number(this.range.value) || 0;
      const au = this.inKm ? n * 1000 / AU : n;
      this.rangeSlider.value = String(Math.min(MAX_RANGE_AU, Math.max(0.1, au)));
      showUnit();
    });
    this.unit.addEventListener("click", () => { this.inKm = !this.inKm; showUnit(); });
    this.window.body.querySelector(".dscan-go")!.addEventListener("click", () => void this.scan());
    this.window.root.style.display = "none";
  }

  get isOpen(): boolean { return !this.detached && this.window.root.style.display !== "none"; }
  toggle(): void { if (this.isOpen) this.window.root.style.display = "none"; else this.open(); }
  open(): void {
    if (this.detached) { this.host.appendChild(this.window.root); this.detached = false; }
    this.window.root.style.display = "";
  }

  async scan(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const angle = ((ANGLES[Number(this.angle.value)] ?? 360) * Math.PI) / 180;
    const range = Math.min(MAX_RANGE_AU, Math.max(0.1, Number(this.rangeSlider.value) || MAX_RANGE_AU)) * AU;
    this.status.textContent = "Scanning…";
    try {
      this.rows = dscanRows(await this.hooks.scan(angle, range, this.hooks.direction()));
      this.draw();
      // The client says nothing under its list on a scan: the line is for the scan under way and a failure only.
      this.status.textContent = "";
    } catch (e) {
      this.status.textContent = (e as Error).message;
    } finally {
      this.busy = false;
    }
  }

  private draw(): void {
    this.tbody.innerHTML = "";
    for (const r of this.rows) {
      const known = this.hooks.known(r.id);
      const tr = document.createElement("tr");
      const type = this.hooks.typeName(r.typeID) ?? `Type ${r.typeID}`;
      const iconCell = document.createElement("td");
      iconCell.className = "ov-icon";
      const path = bracketIcon({ typeID: r.typeID, groupID: r.groupID, categoryID: null });
      if (path) { const img = document.createElement("img"); img.src = path; img.alt = ""; img.className = "dscan-bracket"; iconCell.appendChild(img); }
      tr.appendChild(iconCell);
      for (const text of [known.name ?? type, type, distanceWords(known.distance)]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      }
      (tr.lastChild as HTMLElement).className = "ov-dist";
      this.tbody.appendChild(tr);
    }
  }
}
