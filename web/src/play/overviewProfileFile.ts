// The overview's settings as the 3698585 client writes and reads them in Documents/EVE/Overview/<name>.yaml
// (export.ExportOverviewWindow.Export / ImportOverviewWindow): a YAML mapping whose dicts are written as lists of
// [key, value] pairs, keys sorted (overviewPresetUtil.GetDeterministicListFromDict; GetDictFromList reads them back):
//   flagOrder, flagStates, backgroundOrder, backgroundStates  the Appearance lists (order, and the flags on)
//   stateColorsNameList  [["flag_13", "red"], ...] (stateSvc.GetStateColors' names), stateBlinks [["flag_13", true]]
//   columnOrder, overviewColumns  the columns' order and the ones shown
//   shipLabelOrder, shipLabels  the Ships panel's parts (each [type, pairs of bold, color, fontsize, italic, post, pre,
//     state, type, underline])
//   tabSetup  [[tabID, pairs of bracket, color, name, overview]]
//   presets  [[name, pairs of alwaysShownStates, filteredStates, groups]] (the pilot's own filters only:
//     EXPORT_EVERYTHING off leaves the client's defaults out)
//   userSettings  [[configName, value]] where the pilot changed one
// A sample the client wrote is D:/codex-eve-companion-industry/ref/gc-overview-export-sample.yaml.
import { parse, stringify } from "yaml";

export type Pairs = [string, unknown][];
/** GetDeterministicListFromDict: the dict as [key, value] pairs, keys sorted. */
export function toPairs(o: Record<string, unknown>): Pairs {
  return Object.keys(o).sort().map((k) => [k, o[k]]);
}
/** GetDictFromList: [key, value] pairs back to a dict (anything else as it is). */
export function fromPairs(v: unknown): Record<string, unknown> {
  if (!Array.isArray(v)) return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const e of v) if (Array.isArray(e) && e.length === 2) out[String(e[0])] = e[1];
  return out;
}

export interface ProfileTab { name: string; overview: string; bracket: string | null; color: number[] | null }
export interface ProfilePreset { groups: number[]; filteredStates: number[]; alwaysShownStates: number[] }
export interface ProfileLabel { type: string | null; state: boolean; pre: string; post: string; bold?: boolean; italic?: boolean; underline?: boolean; color?: number[] | null; fontsize?: number | null }
export interface OverviewProfile {
  flagOrder?: number[]; flagStates?: number[]; backgroundOrder?: number[]; backgroundStates?: number[];
  stateColors?: Record<string, string>; stateBlinks?: Record<string, boolean>;
  columnOrder?: string[]; overviewColumns?: string[];
  shipLabels?: ProfileLabel[];
  tabs?: ProfileTab[];
  presets?: Record<string, ProfilePreset>;
}

const nums = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? v.map((x) => (x === null ? "null" : String(x))) : undefined);

/** ExportOverviewWindow.Export's file. */
export function writeProfile(p: OverviewProfile): string {
  const data: Record<string, unknown> = {};
  if (p.backgroundOrder) data.backgroundOrder = p.backgroundOrder;
  if (p.backgroundStates) data.backgroundStates = p.backgroundStates;
  if (p.columnOrder) data.columnOrder = p.columnOrder;
  if (p.flagOrder) data.flagOrder = p.flagOrder;
  if (p.flagStates) data.flagStates = p.flagStates;
  if (p.overviewColumns) data.overviewColumns = p.overviewColumns;
  if (p.presets && Object.keys(p.presets).length) {
    data.presets = Object.keys(p.presets).sort().map((name) => [name, toPairs({ ...p.presets![name]! })]);
  }
  if (p.shipLabels) {
    data.shipLabelOrder = p.shipLabels.map((l) => l.type);
    data.shipLabels = [...p.shipLabels].sort((a, b) => String(a.type ?? "").localeCompare(String(b.type ?? "")))
      .map((l) => [l.type, toPairs(Object.fromEntries(Object.entries({ ...l, state: l.state ? 1 : 0 }).filter(([, v]) => v !== undefined)))]);
  }
  if (p.stateBlinks) data.stateBlinks = toPairs(p.stateBlinks);
  if (p.stateColors) data.stateColorsNameList = toPairs(p.stateColors);
  if (p.tabs) data.tabSetup = p.tabs.map((t, i) => [i, toPairs({ bracket: t.bracket, color: t.color, name: t.name, overview: t.overview })]);
  data.userSettings = [];
  return stringify(data, { indent: 2 });
}

/** ImportOverviewWindow: the file read back; null where it is no overview file (FileNotValid). */
export function readProfile(text: string): OverviewProfile | null {
  let raw: unknown;
  try { raw = parse(text); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  const p: OverviewProfile = {
    flagOrder: nums(d.flagOrder), flagStates: nums(d.flagStates), backgroundOrder: nums(d.backgroundOrder), backgroundStates: nums(d.backgroundStates),
    columnOrder: strs(d.columnOrder), overviewColumns: strs(d.overviewColumns),
  };
  if (d.stateColorsNameList) p.stateColors = Object.fromEntries(Object.entries(fromPairs(d.stateColorsNameList)).map(([k, v]) => [k, String(v)]));
  if (d.stateBlinks) p.stateBlinks = Object.fromEntries(Object.entries(fromPairs(d.stateBlinks)).map(([k, v]) => [k, Boolean(v)]));
  if (Array.isArray(d.shipLabels)) {
    const byType = new Map<string, ProfileLabel>();
    for (const e of d.shipLabels) {
      if (!Array.isArray(e)) continue;
      const v = fromPairs(e[1]);
      byType.set(String(e[0]), { type: (v.type ?? e[0] ?? null) as string | null, state: Boolean(v.state), pre: String(v.pre ?? ""), post: String(v.post ?? ""),
        bold: v.bold === undefined ? undefined : Boolean(v.bold), italic: v.italic === undefined ? undefined : Boolean(v.italic),
        underline: v.underline === undefined ? undefined : Boolean(v.underline), color: (v.color as number[] | null) ?? undefined, fontsize: (v.fontsize as number | null) ?? undefined });
    }
    const order = Array.isArray(d.shipLabelOrder) ? d.shipLabelOrder.map((t) => String(t)) : [...byType.keys()];
    p.shipLabels = order.map((t) => byType.get(t)).filter((l): l is ProfileLabel => !!l);
  }
  if (Array.isArray(d.tabSetup)) {
    p.tabs = d.tabSetup.filter(Array.isArray).sort((a, b) => Number(a[0]) - Number(b[0])).map((e) => {
      const v = fromPairs(e[1]);
      return { name: String(v.name ?? ""), overview: String(v.overview ?? ""), bracket: v.bracket == null ? null : String(v.bracket), color: Array.isArray(v.color) ? v.color.map(Number) : null };
    }).filter((t) => t.name && t.overview);
  }
  if (Array.isArray(d.presets)) {
    p.presets = {};
    for (const e of d.presets) {
      if (!Array.isArray(e)) continue;
      const v = fromPairs(e[1]);
      p.presets[String(e[0])] = { groups: nums(v.groups) ?? [], filteredStates: nums(v.filteredStates) ?? [], alwaysShownStates: nums(v.alwaysShownStates) ?? [] };
    }
  }
  return p;
}
