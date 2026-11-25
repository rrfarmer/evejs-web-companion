// The directional scanner, as the client's (parklife/directionalScanSvc.py DirectionalScan; inflight/scannerFiles):
// scanMgr.ConeScan(scanAngle, scanRange, *direction), the direction the camera looks (GetScanDirection: the space
// camera's look-at direction negated), the angle in radians and the range in metres; the server answers with a row
// for each thing it saw ({id, typeID, groupID}). Opened with Alt+D, scanned with V or its button
// (eveCommands: OpenDirectionalScanner, CmdRefreshDirectionalScan).

import { fittedColumnWidth, scrollListHomeEnd } from "../ui/scrollColumnFit.ts";
import { ContextMenu } from "./contextMenu.ts";
import { playUiEvent } from "./uiAudio.ts";
import { PlayWindow, WINDOW_ACTION_WORDS, clientTexture } from "./window.ts";
import { bracketIcon } from "./brackets.ts";
import { noticeBoard } from "../ui/notices.ts";

const AU = 149_597_870_700;
/** The angles the client's scanner offers, in degrees. */
const ANGLES = [5, 15, 30, 60, 90, 180, 360] as const;
// directionalScanUtil: MIN_RANGE_KM 10; the most GetMaxRangeM - the ship's maxDirectionalScanRange (5796, in metres;
// a ship's 2147483647000, the range a retail 360 degree scan sends), _MAX_RANGE_AU 14.3 where it cannot be read;
// GetScanAngle's default pi / 2 (90 degrees).
const MAX_RANGE_AU = 14.3;
const MIN_RANGE_M = 10_000;
const DEFAULT_ANGLE_INDEX = ANGLES.indexOf(90);
const SCAN_COOLDOWN_MS = 1500;

export interface DScanRow { id: number; typeID: number; groupID: number }
export interface DScanResult {
  rows: readonly DScanRow[];
  direction: readonly [number, number, number];
  rangeMetres: number;
}

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
  scanStarted?(): void;
  /** OnDirectionalScanComplete: the unfiltered answer and the direction the server scanned. */
  scanned?(result: DScanResult): void;
  hoverResult?(typeID: number | null): void;
  /** DirectionalScanResultEntry.OnClick's ExecuteCombatCommand(itemID, UI_CLICK): a loaded combat command run on it. */
  combatClick?(itemID: number): void;
  /** Its OnDblClick: the result's info window (ShowInfo(typeID, itemID)). */
  showInfo?(itemID: number, typeID: number): void;
  /** Its GetMenu: CelestialMenu(itemID, typeID) - the object's menu, at x, y. */
  menu?(itemID: number, typeID: number, x: number, y: number): void;
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
export const DSCAN_WORDS: readonly string[] = [...WINDOW_ACTION_WORDS, "UI/Inflight/Scanner/DirectionalScanner", "/Carbon/UI/Controls/Window/EnableCompactMode", "/Carbon/UI/Controls/Window/DisableCompactMode", "UI/Inflight/Scanner/ScanResults",
  "UI/Inflight/Scanner/Range", "UI/Inflight/Scanner/UnitAU", "UI/Inflight/Scanner/UnitKm", "UI/Inflight/Scanner/Angle",
  "UI/Inflight/Scanner/AngleDegrees", "UI/Inflight/Scanner/Scan", "UI/Common/Group", "UI/Common/Name", "UI/Common/Type", "UI/Common/Distance",
  "UI/Inflight/Scanner/AlignWithCamera", "UI/Inflight/Scanner/ShowScanCone", "UI/Map/MapPallet/btnSolarsystemMap",
  "UI/Inflight/Scanner/Filtered", "UI/Inflight/Scanner/DirectionalNoResult", "UI/Common/EntriesCopied", "UI/Inflight/Scanner/UseActiveOverviewSettings"];
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
/** settings.char.ui directionalScannerMode: SCANMODE_TARGET 1 (the default), SCANMODE_CAMERA 2 (align with camera). */
const SCAN_MODE_KEY = "evejs.play.directionalScannerMode";
/** settings.user.ui scanner_presetInUse: the scanner's own preset, none for the active overview's. */
const PRESET_KEY = "evejs.play.scanner_presetInUse";
/** The native scroll's user setting for scanner_dirscroll. The blank icon column sorts by group name. */
const SORT_KEY = "evejs.play.scanner_dirscroll";
const SORT_COLUMNS = ["group", "name", "type", "distance"] as const;
type SortColumn = typeof SORT_COLUMNS[number];
interface DScanSort { column: SortColumn; reversed: boolean }

function readSort(): DScanSort {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_KEY) ?? "null");
    if (SORT_COLUMNS.includes(saved?.column) && typeof saved.reversed === "boolean") return saved;
  } catch { /* use the default */ }
  return { column: "group", reversed: false };
}

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
  private readonly menu = new ContextMenu();
  /**
   * DirectionalScanner in compact mode (Prepare_Header_: DirectionalScannerCompactHeader, 32 high, no caption; the
   * palette's header row in the header's extra_content - its buttons at the left, the filter box at the right, no
   * ScanResults label), kept.
   */
  private compact = false;
  setCompact(on: boolean): void {
    this.compact = on;
    try { localStorage.setItem("evejs.ui.dscanCompact", on ? "1" : "0"); } catch { /* lasts the page */ }
    const head = this.window.body.querySelector<HTMLElement>(".dscan-head") ?? this.window.root.querySelector<HTMLElement>(".pw-head .dscan-head");
    if (!head) return;
    if (on) this.window.headSlot(head); else if (head.parentElement !== this.window.body) this.window.headUnslot(head, this.window.body, this.window.body.firstChild);
    this.window.root.classList.toggle("dscan-compact", on);
  }
  private readonly angle: HTMLInputElement;
  private readonly range: HTMLInputElement;
  private readonly rangeSlider: HTMLInputElement;
  private readonly unit: HTMLButtonElement;
  private inKm = false;
  private sort = readSort();
  private readonly sortHeaders: NodeListOf<HTMLTableCellElement>;
  /** The scroll's selected entries by itemID (Scroll.SelectNode: a click one, Ctrl toggles, Shift from the last clicked). */
  private selectedIDs = new Set<number>();
  private anchorID: number | null = null;
  /**
   * Scroll.OnUp / OnDown (BrowseNodes): with nothing selected the last / first entry; else the one past the selection
   * (the last selected going down, the first going up), Shift growing the range from where it began; ActivateIdx selects it
   * (SelectNode - no click, so no combat command) and brings it into view.
   */
  private browse(up: boolean, shift: boolean, order: readonly number[]): void {
    if (!order.length) return;
    const sel = order.map((id, i) => (this.selectedIDs.has(id) ? i : -1)).filter((i) => i >= 0);
    let idx: number;
    if (!sel.length) idx = up ? order.length - 1 : 0;
    else if (shift && this.anchorID !== null && order.includes(this.anchorID)) {
      const last = order.indexOf(this.anchorID);
      idx = (sel[0]! < last ? sel[0]! : sel[sel.length - 1]!) + (up ? -1 : 1);
    } else idx = (sel.length > 1 ? sel[up ? 0 : sel.length - 1]! : sel[0]!) + (up ? -1 : 1);
    if (idx < 0 || idx >= order.length) return;
    const id = order[idx]!;
    this.selectEntry(id, order, { shiftKey: shift && sel.length > 0, ctrlKey: false } as MouseEvent);
    const tr = this.tbody.querySelector<HTMLTableRowElement>(`tr[data-id="${id}"]`);
    tr?.focus({ preventScroll: true });
    tr?.scrollIntoView({ block: "nearest" });
  }
  /** Each entry as GetCopyData gives it (typeID, name, type, the distance as shown), in the scroll's order. */
  private copyRows: { id: number; text: string }[] = [];
  /**
   * Scroll.Copy (Ctrl+C on the scroll): the selected entries' GetCopyData - every entry where none is selected - one a
   * line, <t> as a tab, tags stripped; then UI/Common/EntriesCopied with their count.
   */
  private async copy(): Promise<void> {
    const chosen = this.copyRows.filter((row) => this.selectedIDs.has(row.id));
    const rows = chosen.length ? chosen : this.copyRows;
    if (!rows.length) return;
    try {
      await navigator.clipboard.writeText(rows.map((row) => row.text).join("\n"));
      noticeBoard.post({ kind: "info", title: this.word("UI/Common/EntriesCopied", `${rows.length} entries copied`, { numEntries: rows.length }) });
    } catch { /* the clipboard refused */ }
  }
  private selectEntry(id: number, order: readonly number[], ev: MouseEvent): void {
    const from = this.anchorID === null ? -1 : order.indexOf(this.anchorID);
    if (ev.shiftKey && from >= 0) {
      const to = order.indexOf(id);
      const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
      this.selectedIDs = new Set(ev.ctrlKey ? [...this.selectedIDs, ...range] : range);
    } else if (ev.ctrlKey) {
      if (this.selectedIDs.has(id)) this.selectedIDs.delete(id); else this.selectedIDs.add(id);
      this.anchorID = id;
    } else {
      this.selectedIDs = new Set([id]);
      this.anchorID = id;
    }
    for (const tr of this.tbody.querySelectorAll<HTMLTableRowElement>("tr[data-id]")) tr.classList.toggle("sel", this.selectedIDs.has(Number(tr.dataset.id)));
  }
  private readonly tbody: HTMLTableSectionElement;
  private readonly status: HTMLDivElement;
  private readonly filterBox: HTMLSpanElement;
  private readonly alignButton: HTMLButtonElement;
  private readonly word: (label: string, own: string, args?: Readonly<Record<string, string | number>>) => string;
  private busy = false;
  private nextScanAt = 0;
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
    this.window = new PlayWindow({ id: "dscan", caption: w("UI/Inflight/Scanner/DirectionalScanner", "Directional Scanner"), chrome: "small", left: Math.max(16, Math.round(innerWidth / 2 - 200)), top: 40, width: 400, height: 350, minWidth: 300, minHeight: 124, closable: true,
      // the window's menu: CompactModeWindowAction (Enable / Disable compact mode)
      menu: (button) => { const r = button.getBoundingClientRect(); this.menu.open(r.left, r.bottom, this.window.windowActions(w, {
        label: this.compact ? w("/Carbon/UI/Controls/Window/DisableCompactMode", "Disable compact mode") : w("/Carbon/UI/Controls/Window/EnableCompactMode", "Enable compact mode"),
        icon: this.compact ? "res:/UI/Texture/eveicon/system_icons/uncompact_16px.png" : "res:/UI/Texture/eveicon/system_icons/compact_16px.png",
        run: () => this.setCompact(!this.compact) }, this.compact)); } }, () => { this.detached = true; });
    this.window.body.classList.add("dscan");
    queueMicrotask(() => { try { if (localStorage.getItem("evejs.ui.dscanCompact") === "1") this.setCompact(true); } catch { /* not compact */ } });
    const icon = (path: string, title: string) => `<button type="button" class="dscan-ic" title="${title}" disabled><img alt="" src="/client-res/${path}"></button>`;
    this.window.body.innerHTML = `
      <div class="dscan-head"><span class="dscan-caption">${w("UI/Inflight/Scanner/ScanResults", "Scan Results")}</span><span class="dscan-filter">-</span>
        ${icon("ui/texture/classes/mapview/alignwithcamera.png", w("UI/Inflight/Scanner/AlignWithCamera", "Align with camera"))}
        ${icon("ui/texture/classes/mapview/dscanicon.png", w("UI/Inflight/Scanner/ShowScanCone", "Show scan cone"))}
        ${icon("ui/texture/shared/brackets/solarsystem.png", w("UI/Map/MapPallet/btnSolarsystemMap", "Solar system map"))}</div>
      <div class="ov-scroll dscan-scroll"><table class="ov-table"><thead><tr>
        <th scope="col" class="ov-icon" data-sort="group"><button type="button"></button></th>
        <th scope="col" data-sort="name"><button type="button">${w("UI/Common/Name", "Name")}</button></th>
        <th scope="col" data-sort="type"><button type="button">${w("UI/Common/Type", "Type")}</button></th>
        <th scope="col" class="ov-dist" data-sort="distance"><button type="button">${w("UI/Common/Distance", "Distance")}</button></th>
      </tr></thead><tbody></tbody></table></div>
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
    this.sortHeaders = this.window.body.querySelectorAll("th[data-sort]");
    const groupButton = this.window.body.querySelector('th[data-sort="group"] button')!;
    groupButton.setAttribute("aria-label", w("UI/Common/Group", "Group"));
    for (const th of this.sortHeaders) {
      const column = th.dataset.sort as SortColumn;
      th.querySelector("button")!.addEventListener("click", () => {
        this.sort = { column, reversed: column === this.sort.column && !this.sort.reversed };
        try { localStorage.setItem(SORT_KEY, JSON.stringify(this.sort)); } catch { /* kept for the page's life only */ }
        this.drawSortHeaders();
        this.draw();
      });
    }
    this.drawSortHeaders();
    this.columnScaling();
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
    this.angle.addEventListener("change", () => void this.scan());
    this.rangeSlider.addEventListener("input", showUnit);
    this.rangeSlider.addEventListener("change", () => {
      keepRange();
      void this.scan();
    });
    this.range.addEventListener("change", () => {
      const n = Number(this.range.value) || 0;
      const au = this.inKm ? n * 1000 / AU : n;
      // SetScanRange: min(GetMaxRangeKM(), max(MIN_RANGE_KM, the value))
      this.rangeSlider.value = String(Math.min(this.maxRangeAU(), Math.max(MIN_RANGE_M / AU, au)));
      showUnit();
      keepRange();
    });
    this.range.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      this.range.dispatchEvent(new Event("change"));
      void this.scan();
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
    // selected while it shows (UpdateShowConeButton).
    const heads = this.window.body.querySelectorAll<HTMLButtonElement>(".dscan-ic");
    const mapBtn = heads[2];
    if (mapBtn && hooks.openMap) { mapBtn.disabled = false; mapBtn.addEventListener("click", () => hooks.openMap?.()); }
    // OnAlignWithCameraBtn: ToggleScanMode, the button selected in SCANMODE_CAMERA (UpdateAlignWithCameraBtn)
    this.alignButton = heads[0]!;
    this.alignButton.disabled = false;
    this.showCameraMode();
    this.alignButton.addEventListener("click", () => this.setCameraMode(!this.cameraMode()));
    const coneBtn = heads[1];
    if (coneBtn) {
      coneBtn.disabled = false;
      coneBtn.classList.toggle("on", this.coneShown());
      coneBtn.setAttribute("aria-pressed", String(this.coneShown()));
      coneBtn.addEventListener("click", () => {
        try { localStorage.setItem(SHOW_CONE_KEY, this.coneShown() ? "0" : "1"); } catch { /* not kept */ }
        coneBtn.classList.toggle("on", this.coneShown());
        coneBtn.setAttribute("aria-pressed", String(this.coneShown()));
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
  /** GetActiveScanMode() == SCANMODE_CAMERA. */
  cameraMode(): boolean { try { return localStorage.getItem(SCAN_MODE_KEY) === "2"; } catch { return false; } }
  setCameraMode(enabled: boolean): void {
    try { localStorage.setItem(SCAN_MODE_KEY, enabled ? "2" : "1"); } catch { /* not kept */ }
    this.showCameraMode();
  }
  private showCameraMode(): void {
    const enabled = this.cameraMode();
    this.alignButton.classList.toggle("on", enabled);
    this.alignButton.setAttribute("aria-pressed", String(enabled));
  }
  /** IsDscanConeShown: kept, true by default. */
  coneShown(): boolean { try { return localStorage.getItem(SHOW_CONE_KEY) !== "0"; } catch { return true; } }
  /** The scan's angle (degrees) and range (metres) as the window has them now (GetScanAngle, GetScanRangeInMeters). */
  coneState(): { angleDeg: number; rangeMetres: number; shown: boolean; cameraMode: boolean } {
    const angleDeg = ANGLES[Number(this.angle.value)] ?? 90;
    return { angleDeg, rangeMetres: this.rangeMetres(), shown: this.coneShown(), cameraMode: this.cameraMode() };
  }
  /** GetMaxRangeAU: the ship's maxDirectionalScanRange, else _MAX_RANGE_AU. */
  private maxRangeAU(): number {
    const metres = this.hooks.maxRangeMetres?.() ?? null;
    return metres !== null && metres > 0 ? metres / AU : MAX_RANGE_AU;
  }

  private rangeMetres(): number {
    const max = this.maxRangeAU();
    const chosen = Number(this.rangeSlider.value) || max;
    return Math.round(Math.min(max, Math.max(MIN_RANGE_M / AU, chosen)) * AU);
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
        this.hideFilters();
      });
      list.appendChild(row);
    });
    this.filterBox.after(list);
    this.filterList = list;
  }
  private hideFilters(): void { this.filterList?.remove(); this.filterList = null; }

  /**
   * The scroll's id (scanner_dirscroll) makes its columns scalable (Scroll: scalable = sr.id and not fixed; the icon column
   * fixed at 20): each header's ScaleHandle (8 wide at its right, the 1 px line at 3) dragged to a width no narrower than
   * MINCOLUMNWIDTH 24, kept in columnWidths for the scroll's id; a double-click on it fits the column to its widest - the
   * header's text or a row's - with the tab margin either side (ResetColumnWidth).
   */
  private columnScaling(): void {
    const KEY = "evejs.ui.columnWidths.scanner_dirscroll";
    const read = (): Record<string, number> => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown; return v && typeof v === "object" ? v as Record<string, number> : {}; } catch { return {}; } };
    const keep = (v: Record<string, number>) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* this visit only */ } };
    const setWidth = (th: HTMLElement, w: number) => { th.style.width = th.style.minWidth = th.style.maxWidth = `${w}px`; };
    const kept = read();
    for (const th of this.sortHeaders) {
      const column = th.dataset.sort as string;
      if (column === "group") continue;
      if (typeof kept[column] === "number") setWidth(th, kept[column]!);
      const grip = document.createElement("span");
      grip.className = "dscan-scaler";
      grip.setAttribute("role", "separator");
      th.append(grip);
      grip.addEventListener("click", (e) => e.stopPropagation());
      grip.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const x0 = e.clientX, w0 = th.getBoundingClientRect().width;
        if (w0 <= 0) return; // (a folded window: nothing to scale)
        const move = (m: PointerEvent) => setWidth(th, Math.max(24, Math.round(w0 + m.clientX - x0)));
        const up = () => {
          removeEventListener("pointermove", move);
          removeEventListener("pointerup", up);
          keep({ ...read(), [column]: Math.round(th.getBoundingClientRect().width) });
        };
        addEventListener("pointermove", move);
        addEventListener("pointerup", up);
      });
      grip.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const w = fittedColumnWidth(th as HTMLTableCellElement);
        setWidth(th, w);
        keep({ ...read(), [column]: w });
      });
    }
  }

  private drawSortHeaders(): void {
    for (const th of this.sortHeaders) {
      const sorted = th.dataset.sort === this.sort.column;
      th.classList.toggle("sorted", sorted);
      th.classList.toggle("down", sorted && this.sort.reversed);
      if (sorted) th.setAttribute("aria-sort", this.sort.reversed ? "descending" : "ascending");
      else th.removeAttribute("aria-sort");
    }
  }

  get isOpen(): boolean { return !this.detached && this.window.root.style.display !== "none"; }
  toggle(): void { if (this.isOpen) this.window.root.style.display = "none"; else this.open(); }
  open(): void {
    if (this.detached) { this.host.appendChild(this.window.root); this.detached = false; }
    this.window.root.style.display = "";
    this.updateMaxValue();
  }

  get scanning(): boolean { return this.busy || performance.now() < this.nextScanAt; }

  async scan(direction?: [number, number, number]): Promise<void> {
    if (this.scanning) return;
    this.busy = true;
    const angle = ((ANGLES[Number(this.angle.value)] ?? 360) * Math.PI) / 180;
    this.updateMaxValue();
    const range = this.rangeMetres();
    const aim = direction ?? this.hooks.direction();
    this.status.textContent = "Scanning…";
    try {
      this.hooks.scanStarted?.();
      this.rows = dscanRows(await this.hooks.scan(angle, range, aim));
      this.draw();
      this.hooks.scanned?.({ rows: this.rows, direction: aim, rangeMetres: range });
      // directionalScanSvc.PlayResultSound: results, or none
      void playUiEvent(this.rows.length ? "msg_newscan_directional_scan_results_play" : "msg_newscan_directional_scan_noresults_play");
      // The client says nothing under its list on a scan: the line is for the scan under way and a failure only.
      this.status.textContent = "";
    } catch (e) {
      this.status.textContent = (e as Error).message;
    } finally {
      this.busy = false;
      this.nextScanAt = performance.now() + SCAN_COOLDOWN_MS;
    }
  }

  private draw(): void {
    // UpdateScroll: the scanner's preset (scanner_presetInUse, else the active overview preset) - a row shows where its
    // group is one of the preset's valid groups, the rest counted; a cloud not at all (no GM role here); the filter box
    // "Filtered: N (preset)"; an empty list says UI/Inflight/Scanner/DirectionalNoResult.
    if (this.tbody.querySelector("tr:hover")) this.hooks.hoverResult?.(null);
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
    const entries = shown.map((row) => {
      const known = this.hooks.known(row.id);
      const type = this.hooks.typeName(row.typeID) ?? `Type ${row.typeID}`;
      return {
        row,
        group: this.hooks.groupName(row.groupID) ?? "",
        name: known.name ?? type,
        type,
        distance: known.distance,
      };
    });
    // GetScrollEntry assigns zero to off-grid distances while displaying a dash. Scroll sorts the
    // underlying values case-sensitively, then reverses the sorted rows for descending order.
    const column = this.sort.column;
    entries.sort((a, b) => {
      if (column === "distance") return (a.distance ?? 0) - (b.distance ?? 0);
      return a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0;
    });
    if (this.sort.reversed) entries.reverse();
    const order = entries.map((e) => e.row.id);
    this.copyRows = entries.map((e) => ({ id: e.row.id, text: [String(e.row.typeID), e.name, e.type, distanceWords(e.distance)].join("\t") }));
    for (const id of [...this.selectedIDs]) if (!order.includes(id)) this.selectedIDs.delete(id);
    for (const { row, name, type, distance } of entries) {
      const tr = document.createElement("tr");
      // DirectionalScanResultEntry: a click selects it and runs a loaded combat command on it, a double-click selects
      // it and shows its info, a right-click its CelestialMenu (its own GetMenu, not the base's: no selection first)
      tr.dataset.id = String(row.id);
      tr.tabIndex = -1;
      if (this.selectedIDs.has(row.id)) tr.classList.add("sel");
      tr.addEventListener("click", (ev) => { this.selectEntry(row.id, order, ev); tr.focus({ preventScroll: true }); this.hooks.combatClick?.(row.id); });
      tr.addEventListener("keydown", (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "c") { ev.preventDefault(); ev.stopPropagation(); void this.copy(); return; }
        // commandSvc.OnCtrlA: the focused scroll's SelectAll - every entry selected
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "a") {
          ev.preventDefault(); ev.stopPropagation();
          this.selectedIDs = new Set(order);
          for (const x of this.tbody.querySelectorAll<HTMLTableRowElement>("tr[data-id]")) x.classList.add("sel");
          return;
        }
        if (ev.key === "Home" || ev.key === "End") { ev.preventDefault(); ev.stopPropagation(); scrollListHomeEnd(tr, ev.key === "End"); return; }
        if (ev.key === "ArrowUp" || ev.key === "ArrowDown") { ev.preventDefault(); ev.stopPropagation(); this.browse(ev.key === "ArrowUp", ev.shiftKey, order); }
      });
      tr.addEventListener("dblclick", () => { this.selectedIDs = new Set([row.id]); this.anchorID = row.id; for (const x of this.tbody.querySelectorAll<HTMLTableRowElement>("tr[data-id]")) x.classList.toggle("sel", x === tr); this.hooks.showInfo?.(row.id, row.typeID); });
      tr.addEventListener("contextmenu", (ev) => { ev.preventDefault(); ev.stopPropagation(); this.hooks.menu?.(row.id, row.typeID, ev.clientX, ev.clientY); });
      // DirectionalScanResultEntry (an SE_BaseClassCore): OnMouseEnter plays SOUND_ENTRY_HOVER
      tr.addEventListener("mouseenter", () => { void playUiEvent("ui_button_soft2_play"); this.hooks.hoverResult?.(row.typeID); });
      tr.addEventListener("mouseleave", () => this.hooks.hoverResult?.(null));
      const iconCell = document.createElement("td");
      iconCell.className = "ov-icon";
      const path = bracketIcon({ typeID: row.typeID, groupID: row.groupID, categoryID: null });
      if (path) { const img = document.createElement("img"); img.src = path; img.alt = ""; img.className = "dscan-bracket"; iconCell.appendChild(img); }
      tr.appendChild(iconCell);
      for (const text of [name, type, distanceWords(distance)]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      }
      (tr.lastChild as HTMLElement).className = "ov-dist";
      this.tbody.appendChild(tr);
    }
  }
}
