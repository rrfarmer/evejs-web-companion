// The directional scanner, as the client's (parklife/directionalScanSvc.py DirectionalScan; inflight/scannerFiles):
// scanMgr.ConeScan(scanAngle, scanRange, *direction), the direction the camera looks (GetScanDirection: the space
// camera's look-at direction negated), the angle in radians and the range in metres; the server answers with a row
// for each thing it saw ({id, typeID, groupID}), nearest first. Opened with Alt+D, scanned with V or its button
// (eveCommands: OpenDirectionalScanner, CmdRefreshDirectionalScan).

import { playUiEvent } from "./uiAudio.ts";
import { PlayWindow, clientTexture } from "./window.ts";
import { bracketIcon } from "./brackets.ts";

const AU = 149_597_870_700;
/** The angles the client's scanner offers, in degrees. */
const ANGLES = [5, 15, 30, 60, 90, 180, 360] as const;
// directionalScanUtil: MIN_RANGE_KM 10; the most GetMaxRangeM - the ship's maxDirectionalScanRange (5796, in metres;
// a ship's 2147483647000, the range a retail 360 degree scan sends), _MAX_RANGE_AU 14.3 where it cannot be read;
// GetScanAngle's default pi / 2 (90 degrees).
const MAX_RANGE_AU = 14.3;
const MIN_RANGE_M = 10_000;
const DEFAULT_ANGLE_INDEX = ANGLES.indexOf(90);

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
  /** The active overview preset (GetActiveOverviewPresetName): its name and groups; null until the presets are read. */
  activePreset?(): { readonly name: string; readonly groups: ReadonlySet<number> } | null;
  /** MapBtnClicked: the solar system map opened. */
  openMap?(): void;
  /** The ship's maxDirectionalScanRange in metres (GetMaxRangeM); null where it is not read. */
  maxRangeMetres?(): number | null;
  /** The presets the filter box offers (GetPresetOptions' defaults, by category); empty until read. */
  presets?(): readonly { readonly id: string; readonly name: string; readonly label: string; readonly groups: ReadonlySet<number> }[];
  /** The install's words for a label, filled; null where they are not had (the window keeps its own). */
  word?(label: string, args?: Readonly<Record<string, string | number>>): string | null;
}

/** The labels the window asks the install for (directionalScannerPalette.py, directionalScanResultEntry.py). */
export const DSCAN_WORDS: readonly string[] = ["UI/Inflight/Scanner/DirectionalScanner", "UI/Inflight/Scanner/ScanResults",
  "UI/Inflight/Scanner/Range", "UI/Inflight/Scanner/UnitAU", "UI/Inflight/Scanner/UnitKm", "UI/Inflight/Scanner/Angle",
  "UI/Inflight/Scanner/AngleDegrees", "UI/Inflight/Scanner/Scan", "UI/Common/Name", "UI/Common/Type", "UI/Common/Distance",
  "UI/Inflight/Scanner/AlignWithCamera", "UI/Inflight/Scanner/ShowScanCone", "UI/Map/MapPallet/btnSolarsystemMap",
  "UI/Inflight/Scanner/Filtered", "UI/Inflight/Scanner/DirectionalNoResult", "UI/Inflight/Scanner/UseActiveOverviewSettings"];
/**
 * The scanner's settings the client keeps for the user (settings.user.ui): dir_scanrange (km; SetScanRange),
 * scan_angleSlider (radians; SetScanAngle), scanner_rangeEditMode (RANGEMODE_AU 1, RANGEMODE_KM 2). Here in the
 * browser's storage, for the page's user.
 */
const SETTING = (name: string) => `evejs.play.${name}`;
function readSetting(name: string): number | null {
  try { const v = localStorage.getItem(SETTING(name)); return v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v); } catch { return null; }
}
function writeSetting(name: string, value: number): void {
  try { localStorage.setItem(SETTING(name), String(value)); } catch { /* kept for the page's life only */ }
}
/** settings.char.ui directionalScannerShowCone (IsDscanConeShown, default True): the cone in the solar system map. */
const SHOW_CONE_KEY = "evejs.play.directionalScannerShowCone";
/** settings.user.ui scanner_presetInUse: the scanner's own preset, none for the active overview's. */
const PRESET_KEY = "evejs.play.scanner_presetInUse";
/** inventorycommon groupCloud: hidden from the scan's rows but for a GM / world mod (UpdateScroll). */
const GROUP_CLOUD = 227;

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
  private readonly filterBox: HTMLSpanElement;
  private readonly word: (label: string, own: string, args?: Readonly<Record<string, string | number>>) => string;
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
        <div class="dscan-half"><div class="dscan-top"><span>${w("UI/Inflight/Scanner/Range", "Range")}</span><input class="dscan-range" type="number" min="${MIN_RANGE_M / AU}" step="0.1" value="${MAX_RANGE_AU}"><button type="button" class="dscan-unit"></button></div>
          <input class="dscan-range-slider" type="range" min="${MIN_RANGE_M / AU}" max="${MAX_RANGE_AU}" step="any" value="${MAX_RANGE_AU}"></div>
        <div class="dscan-half"><div class="dscan-top"><span class="dscan-angle-label"></span></div>
          <input class="dscan-angle" type="range" min="0" max="${ANGLES.length - 1}" step="1" value="${DEFAULT_ANGLE_INDEX}"></div>
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
      // UpdateRangeInput: AU to one decimal place, km whole
      this.range.value = this.inKm ? String(Math.round(au * AU / 1000)) : au.toFixed(1);
      this.range.step = this.inKm ? "1" : "0.1";
    };
    this.showUnit = showUnit;
    // The kept settings, where there are any: the angle the nearest increment, the range in km, the edit mode.
    const keptAngle = readSetting("scan_angleSlider");
    if (keptAngle !== null) {
      const degrees = (keptAngle * 180) / Math.PI;
      const nearest = ANGLES.reduce((best, a, i) => (Math.abs(a - degrees) < Math.abs(ANGLES[best]! - degrees) ? i : best), 0);
      this.angle.value = String(nearest);
    }
    const keptRangeKm = readSetting("dir_scanrange");
    if (keptRangeKm !== null && keptRangeKm > 0) {
      const au = (keptRangeKm * 1000) / AU;
      this.rangeSlider.max = String(Math.max(MAX_RANGE_AU, au));
      this.rangeSlider.value = String(au);
    }
    this.inKm = readSetting("scanner_rangeEditMode") === 2;
    const keepRange = () => writeSetting("dir_scanrange", Math.round((Number(this.rangeSlider.value) * AU) / 1000));
    showAngle();
    showUnit();
    this.angle.addEventListener("input", () => {
      showAngle();
      writeSetting("scan_angleSlider", ((ANGLES[Number(this.angle.value)] ?? 90) * Math.PI) / 180);
    });
    this.rangeSlider.addEventListener("input", showUnit);
    this.rangeSlider.addEventListener("change", keepRange);
    this.range.addEventListener("change", () => {
      const n = Number(this.range.value) || 0;
      const au = this.inKm ? n * 1000 / AU : n;
      // SetScanRange: min(GetMaxRangeKM(), max(MIN_RANGE_KM, the value))
      this.rangeSlider.value = String(Math.min(this.maxRangeAU(), Math.max(MIN_RANGE_M / AU, au)));
      showUnit();
      keepRange();
    });
    this.unit.addEventListener("click", () => {
      this.inKm = !this.inKm;
      writeSetting("scanner_rangeEditMode", this.inKm ? 2 : 1);
      showUnit();
    });
    this.window.body.querySelector(".dscan-go")!.addEventListener("click", () => void this.scan());
    this.filterBox = this.window.body.querySelector(".dscan-filter")!;
    this.word = w;
    // MapBtnClicked: the solar system map; OnShowConeBtn: SetScanConeDisplayState(not IsDscanConeShown()), the button
    // selected while it shows (UpdateShowConeButton). Align with camera waits on the map's own camera mode.
    const heads = this.window.body.querySelectorAll<HTMLButtonElement>(".dscan-ic");
    const mapBtn = heads[2];
    if (mapBtn && hooks.openMap) { mapBtn.disabled = false; mapBtn.addEventListener("click", () => hooks.openMap?.()); }
    const coneBtn = heads[1];
    if (coneBtn) {
      coneBtn.disabled = false;
      coneBtn.classList.toggle("on", this.coneShown());
      coneBtn.addEventListener("click", () => {
        try { localStorage.setItem(SHOW_CONE_KEY, this.coneShown() ? "0" : "1"); } catch { /* not kept */ }
        coneBtn.classList.toggle("on", this.coneShown());
      });
    }
    // LoadFilterTooltipPanel: the box's tooltip, a list (210 wide, at most 200 high) - UseActiveOverviewSettings, then
    // the presets - each a checkbox of one group, the chosen one checked, the first ten with a shortcut hint
    // ((i + 1) % 10); a choice (OnFilterChange) kept as scanner_presetInUse and the rows filtered again, or a scan made
    // where there are none.
    this.filterBox.addEventListener("mouseenter", () => this.showFilters());
    this.filterBox.addEventListener("click", () => this.showFilters());
    this.window.root.addEventListener("mouseleave", () => this.hideFilters());
    this.window.root.style.display = "none";
  }

  private showUnit: () => void = () => {};
  /** IsDscanConeShown: kept, true by default. */
  coneShown(): boolean { try { return localStorage.getItem(SHOW_CONE_KEY) !== "0"; } catch { return true; } }
  /** The scan's angle (degrees) and range (metres) as the window has them now (GetScanAngle, GetScanRangeInMeters). */
  coneState(): { angleDeg: number; rangeMetres: number; shown: boolean } {
    const angleDeg = ANGLES[Number(this.angle.value)] ?? 90;
    const au = Math.min(this.maxRangeAU(), Math.max(MIN_RANGE_M / AU, Number(this.rangeSlider.value) || this.maxRangeAU()));
    return { angleDeg, rangeMetres: au * AU, shown: this.coneShown() };
  }
  /** GetMaxRangeAU: the ship's maxDirectionalScanRange, else _MAX_RANGE_AU. */
  private maxRangeAU(): number {
    const metres = this.hooks.maxRangeMetres?.() ?? null;
    return metres !== null && metres > 0 ? metres / AU : MAX_RANGE_AU;
  }
  /** UpdateMaxValue: the slider's top at the ship's range, the range kept within it; a range at the old top follows it. */
  private updateMaxValue(): void {
    const max = this.maxRangeAU();
    const atTop = Number(this.rangeSlider.value) >= Number(this.rangeSlider.max) - 1e-9;
    this.rangeSlider.max = String(max);
    if (atTop || Number(this.rangeSlider.value) > max) this.rangeSlider.value = String(max);
    this.showUnit();
  }
  private filterList: HTMLDivElement | null = null;
  private chosenPreset(): string | null { try { return localStorage.getItem(PRESET_KEY); } catch { return null; } }
  private showFilters(): void {
    this.hideFilters();
    const chosen = this.chosenPreset();
    const options = [{ id: null as string | null, label: this.word("UI/Inflight/Scanner/UseActiveOverviewSettings", "Use Active Overview Settings") },
      ...(this.hooks.presets?.() ?? []).map((p) => ({ id: p.id as string | null, label: p.label }))];
    const list = document.createElement("div");
    list.className = "dscan-filters";
    options.forEach((o, i) => {
      const row = document.createElement("label");
      row.className = "dscan-filter-row";
      row.innerHTML = `<input type="radio" name="dscan-filter"><span class="dscan-filter-key"></span><span></span>`;
      const radio = row.querySelector("input")!;
      radio.checked = o.id === chosen;
      (row.children[1] as HTMLElement).textContent = i < 10 ? String((i + 1) % 10) : "";
      (row.children[2] as HTMLElement).textContent = o.label;
      radio.addEventListener("change", () => {
        try { if (o.id === null) localStorage.removeItem(PRESET_KEY); else localStorage.setItem(PRESET_KEY, o.id); } catch { /* kept for the page's life only */ }
        if (this.rows.length) this.draw(); else void this.scan();
        this.showFilters();
      });
      list.appendChild(row);
    });
    this.filterBox.after(list);
    this.filterList = list;
  }
  private hideFilters(): void { this.filterList?.remove(); this.filterList = null; }

  get isOpen(): boolean { return !this.detached && this.window.root.style.display !== "none"; }
  toggle(): void { if (this.isOpen) this.window.root.style.display = "none"; else this.open(); }
  open(): void {
    if (this.detached) { this.host.appendChild(this.window.root); this.detached = false; }
    this.window.root.style.display = "";
    this.updateMaxValue();
  }

  async scan(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const angle = ((ANGLES[Number(this.angle.value)] ?? 360) * Math.PI) / 180;
    this.updateMaxValue();
    // GetScanRangeInMeters: the range in whole metres (the client keeps km, the wire metres)
    const chosenAU = Number(this.rangeSlider.value) || this.maxRangeAU();
    const range = chosenAU >= this.maxRangeAU() - 1e-9
      ? Math.round(this.hooks.maxRangeMetres?.() ?? MAX_RANGE_AU * AU)
      : Math.round(Math.max(MIN_RANGE_M / AU, chosenAU) * AU);
    this.status.textContent = "Scanning…";
    try {
      this.rows = dscanRows(await this.hooks.scan(angle, range, this.hooks.direction()));
      this.draw();
      // directionalScanSvc.PlayResultSound: results, or none
      void playUiEvent(this.rows.length ? "msg_newscan_directional_scan_results_play" : "msg_newscan_directional_scan_noresults_play");
      // The client says nothing under its list on a scan: the line is for the scan under way and a failure only.
      this.status.textContent = "";
    } catch (e) {
      this.status.textContent = (e as Error).message;
    } finally {
      this.busy = false;
    }
  }

  private draw(): void {
    // UpdateScroll: the scanner's preset (scanner_presetInUse, else the active overview preset) - a row shows where its
    // group is one of the preset's valid groups, the rest counted; a cloud not at all (no GM role here); the filter box
    // "Filtered: N (preset)"; an empty list says UI/Inflight/Scanner/DirectionalNoResult.
    this.tbody.innerHTML = "";
    const chosen = this.chosenPreset();
    const own = chosen === null ? undefined : this.hooks.presets?.().find((p) => p.id === chosen);
    const preset = own ?? this.hooks.activePreset?.() ?? null;
    let filtered = 0;
    const shown = this.rows.filter((r) => {
      if (preset && !preset.groups.has(r.groupID)) { filtered += 1; return false; }
      return r.groupID !== GROUP_CLOUD;
    });
    this.filterBox.textContent = preset
      ? `${this.word("UI/Inflight/Scanner/Filtered", `Filtered: ${filtered}`, { noFiltered: filtered })} (${preset.name})`
      : "-";
    if (!shown.length) {
      const tr = document.createElement("tr");
      tr.className = "dscan-none";
      tr.innerHTML = `<td colspan="4"></td>`;
      tr.firstElementChild!.textContent = this.word("UI/Inflight/Scanner/DirectionalNoResult", "No results");
      this.tbody.appendChild(tr);
    }
    for (const r of shown) {
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
