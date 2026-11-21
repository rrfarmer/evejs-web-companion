// The ship bracket's label (bracketMgr.GetDisplayNameWithShipLabels), as the Overview Settings Ships panel sets it:
// each part of stateSvc.GetShipLabels in order - ship type, alliance, corporation, ship name, the free text (type
// null), line breaks, pilot name - each on or off with its pre / post text, bold, italic, underline, font size and
// colour. The defaults are the 3698585 client's (GetShipLabels read through gridcheck); the pilot's own are kept in
// this browser. Used for every bracket of a thing with a corporation that is not an orbital (the client's rule), so a
// drone's too: "<b>Mining Drone I</b><br>[Mining Drone I] -", as the client itself builds it.

import { isNpcCorporation } from "../bridge/ownerInfo.ts";

export type ShipLabelType = "ship type" | "alliance" | "corporation" | "ship name" | "pilot name" | "linebreak" | null;
export interface ShipLabelPart {
  type: ShipLabelType;
  state: boolean;
  pre: string;
  post: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontsize?: number | null;
  /** r, g, b in 0..1, or none for the label's own colour. */
  color?: number[] | null;
}

export const DEFAULT_SHIP_LABELS: readonly ShipLabelPart[] = [
  { type: "ship type", state: true, pre: "", post: "", bold: true, color: [1, 1, 1], fontsize: 12 },
  { type: "alliance", state: true, pre: " [", post: "]", color: [1, 0.914, 0], fontsize: 12 },
  { type: "corporation", state: true, pre: " [", post: "]", fontsize: 11 },
  { type: "ship name", state: false, pre: " ", post: "", italic: true },
  { type: null, state: true, pre: "", post: "" },
  { type: "linebreak", state: true, pre: "", post: "" },
  { type: "pilot name", state: true, pre: "[", post: "] -", fontsize: 11 },
];

/**
 * The Ships panel menu's formats (stateSvc.SetDefaultShipLabel: default, ally, corpally), read from the client; each with
 * Hide corp ticker if pilot is in Alliance off (GetDefaultSettingValueFromName).
 */
export const SHIP_LABEL_PRESETS: Readonly<Record<"default" | "ally" | "corpally", readonly ShipLabelPart[]>> = {"default":[{"type":"ship type","state":true,"pre":"","post":" "},{"type":"alliance","state":true,"pre":"<","post":">"},{"type":"corporation","state":true,"pre":"[","post":"]"},{"type":"pilot name","state":true,"pre":" ","post":" "},{"type":"ship name","state":false,"pre":"'","post":"'"},{"type":null,"state":false,"pre":"[","post":""}],"ally":[{"type":"pilot name","state":true,"pre":"","post":""},{"type":"corporation","state":true,"pre":" [","post":""},{"type":"alliance","state":true,"pre":",","post":""},{"type":null,"state":true,"pre":"]","post":""},{"type":"ship name","state":false,"pre":"'","post":"'"},{"type":"ship type","state":false,"pre":"(","post":")"}],"corpally":[{"type":"corporation","state":true,"pre":" [","post":"]"},{"type":"pilot name","state":true,"pre":"","post":""},{"type":"alliance","state":true,"pre":"<","post":">"},{"type":"ship name","state":false,"pre":"'","post":"'"},{"type":"ship type","state":false,"pre":"(","post":")"},{"type":null,"state":false,"pre":"[","post":"]"}]} as Readonly<Record<"default" | "ally" | "corpally", readonly ShipLabelPart[]>>;

const KEY = "evejs.ui.overview.shipLabels";
export interface ShipLabelSettings { labels: ShipLabelPart[]; hideCorpTicker: boolean }
export function shipLabelSettings(): ShipLabelSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ShipLabelSettings> | null;
    return { labels: Array.isArray(v?.labels) ? v!.labels : DEFAULT_SHIP_LABELS.map((l) => ({ ...l })), hideCorpTicker: v?.hideCorpTicker ?? false };
  } catch {
    return { labels: DEFAULT_SHIP_LABELS.map((l) => ({ ...l })), hideCorpTicker: false };
  }
}
export function saveShipLabelSettings(s: ShipLabelSettings | null): void {
  try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* the settings last the page */ }
  listeners.forEach((fn) => fn());
}
const listeners = new Set<() => void>();
export function onShipLabelsChanged(fn: () => void): void { listeners.add(fn); }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface ShipLabelThing {
  readonly typeName: string;
  readonly shipName: string | null;
  readonly displayName: string;
  readonly corporationID: number | null;
  readonly allianceID: number | null;
  readonly corpTicker: string | null;
  readonly allianceTicker: string | null;
}

/** GetDisplayNameWithShipLabels as HTML: the parts tagged (bold, underline, italic, then pre and post, colour, size). */
export function shipLabelMarkup(thing: ShipLabelThing, settings: ShipLabelSettings = shipLabelSettings()): string {
  const out: string[] = [];
  const npcCorp = thing.corporationID === null || isNpcCorporation(thing.corporationID);
  for (const label of settings.labels) {
    if (label.type !== "linebreak" && !label.state) continue;
    let text: string | null = null;
    if (label.type === null) {
      if (!npcCorp) out.push(esc(label.pre));
      continue;
    }
    if (label.type === "linebreak") {
      if (out.length && out[out.length - 1] !== "<br>") out.push("<br>");
      continue;
    }
    if (label.type === "corporation") text = !npcCorp && !(settings.hideCorpTicker && thing.allianceID) ? thing.corpTicker : null;
    else if (label.type === "alliance") text = thing.allianceID ? thing.allianceTicker : null;
    else if (label.type === "pilot name") text = thing.displayName;
    else if (label.type === "ship type") text = thing.typeName;
    else if (label.type === "ship name") text = thing.shipName;
    if (!text) continue;
    let part = esc(text);
    if (label.bold) part = `<b>${part}</b>`;
    if (label.underline) part = `<u>${part}</u>`;
    if (label.italic) part = `<i>${part}</i>`;
    part = `${esc(label.pre ?? "")}${part}${esc(label.post ?? "")}`;
    if (label.color) part = `<span style="color:rgb(${label.color.slice(0, 3).map((c) => Math.round(c * 255)).join(",")})">${part}</span>`;
    if (label.fontsize) part = `<span style="font-size:${label.fontsize}px">${part}</span>`;
    out.push(part);
  }
  return out.join("");
}
