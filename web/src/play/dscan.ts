// The directional scanner, as the client's (parklife/directionalScanSvc.py DirectionalScan; inflight/scannerFiles):
// scanMgr.ConeScan(scanAngle, scanRange, *direction), the direction the camera looks (GetScanDirection: the space
// camera's look-at direction negated), the angle in radians and the range in metres; the server answers with a row
// for each thing it saw ({id, typeID, groupID}), nearest first. Opened with Alt+D, scanned with V or its button
// (eveCommands: OpenDirectionalScanner, CmdRefreshDirectionalScan).

import { PlayWindow, clientTexture } from "./window.ts";

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
}

function distanceWords(m: number | null): string {
  if (m === null) return "-";
  if (m >= 0.1 * AU) return `${(m / AU).toFixed(1)} AU`;
  if (m >= 10_000) return `${Math.round(m / 1000).toLocaleString()} km`;
  return `${Math.round(m).toLocaleString()} m`;
}

export class DScanWindow {
  readonly window: PlayWindow;
  private readonly angle: HTMLSelectElement;
  private readonly range: HTMLInputElement;
  private readonly tbody: HTMLTableSectionElement;
  private readonly status: HTMLDivElement;
  private busy = false;
  rows: DScanRow[] = [];

  /** Whether the window's close button has taken it off the page (it is put back on opening). */
  private detached = false;

  constructor(private readonly hooks: DScanHooks, private readonly host: HTMLElement) {
    this.window = new PlayWindow({ id: "dscan", caption: "Directional Scanner", icon: clientTexture("res:/UI/Texture/eveicon/product_icons/directional_scanner_64px.png"), left: Math.max(16, Math.round(innerWidth / 2 - 190)), top: 40, width: 380, height: 360, closable: true }, () => { this.detached = true; });
    this.window.body.classList.add("dscan");
    this.window.body.innerHTML = `
      <div class="dscan-bar">
        <label>Angle <select class="dscan-angle">${ANGLES.map((a) => `<option value="${a}"${a === 360 ? " selected" : ""}>${a}°</option>`).join("")}</select></label>
        <label>Range <input class="dscan-range" type="number" min="0.1" max="${MAX_RANGE_AU}" step="0.1" value="${MAX_RANGE_AU}"> AU</label>
        <button class="dscan-go">Scan</button>
      </div>
      <div class="dscan-status"></div>
      <div class="ov-scroll"><table class="ov-table"><thead><tr><th>Name</th><th>Type</th><th class="ov-dist">Distance</th></tr></thead><tbody></tbody></table></div>`;
    this.angle = this.window.body.querySelector(".dscan-angle")!;
    this.range = this.window.body.querySelector(".dscan-range")!;
    this.tbody = this.window.body.querySelector("tbody")!;
    this.status = this.window.body.querySelector(".dscan-status")!;
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
    const angle = (Number(this.angle.value) * Math.PI) / 180;
    const range = Math.min(MAX_RANGE_AU, Math.max(0.1, Number(this.range.value) || MAX_RANGE_AU)) * AU;
    this.status.textContent = "Scanning…";
    try {
      this.rows = dscanRows(await this.hooks.scan(angle, range, this.hooks.direction()));
      this.draw();
      this.status.textContent = this.rows.length ? `${this.rows.length} results` : "No results";
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
