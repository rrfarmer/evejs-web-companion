import type { FleetBroadcast, FleetBroadcastName } from "../bridge/fleetBroadcasts.ts";
import { BROADCAST_SETTING_FLAGS, type BroadcastColor, type BroadcastSettingRow } from "../bridge/fleetBroadcastSettingsLink.ts";
import { createSignal, type WritableSignal } from "../store/signals.ts";

export const BROADCAST_FILTER_ROWS = [
  "ShowOwnBroadcasts", "HealArmor", "HealCapacitor", "NeedBackup", "Target", "HealShield",
  "WarpTo", "TravelTo", "Event", "JumpTo", "AlignTo", "HealTarget", "InPosition",
  "EnemySpotted", "HoldPosition", "JumpBeacon", "Location",
] as const satisfies readonly (FleetBroadcastName | "ShowOwnBroadcasts" | "Event")[];
export type BroadcastFilterRow = typeof BROADCAST_FILTER_ROWS[number];

export const BROADCAST_PALETTE = [
  ["Gold", [1, .7, 0]], ["Orange", [1, .35, 0]], ["Red", [.75, 0, 0]], ["Green", [.1, .6, .1]],
  ["Teal", [0, .63, .57]], ["Light blue", [.2, .5, 1]], ["Blue", [0, .15, .6]], ["Black", [0, 0, 0]], ["Gray", [.7, .7, .7]],
] as const;

export interface FleetBroadcastPreferences {
  readonly listen: Partial<Record<BroadcastFilterRow, boolean>>;
  readonly colors: Partial<Record<BroadcastFilterRow, number | BroadcastColor>>;
}
const byAccount = new Map<number | null, WritableSignal<FleetBroadcastPreferences>>();
const key = (account: number | null) => `evejs.user.${account ?? "local"}.fleetBroadcastFilters`;

export function fleetBroadcastPreferences(account: number | null): WritableSignal<FleetBroadcastPreferences> {
  const cached = byAccount.get(account);
  if (cached) return cached;
  const listen: FleetBroadcastPreferences["listen"] = {}, colors: FleetBroadcastPreferences["colors"] = {};
  try {
    const saved = JSON.parse(localStorage.getItem(key(account)) ?? "{}") as Partial<FleetBroadcastPreferences> | null;
    for (const row of BROADCAST_FILTER_ROWS) {
      const enabled = saved?.listen?.[row], color = saved?.colors?.[row];
      if (typeof enabled === "boolean") listen[row] = enabled;
      if (row === "ShowOwnBroadcasts") continue;
      if (typeof color === "number" && Number.isInteger(color) && BROADCAST_PALETTE[color]) colors[row] = color;
      if (Array.isArray(color) && color.length === 3 && color.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 1)) colors[row] = color;
    }
  } catch { /* The defaults are available without browser storage. */ }
  const signal = createSignal<FleetBroadcastPreferences>({ listen, colors });
  byAccount.set(account, signal);
  return signal;
}

export function saveFleetBroadcastPreferences(account: number | null, preferences: FleetBroadcastPreferences): void {
  fleetBroadcastPreferences(account).set(preferences);
  try { localStorage.setItem(key(account), JSON.stringify(preferences)); } catch { /* Keep it in memory. */ }
}

export function listensToBroadcastRow(preferences: FleetBroadcastPreferences, name: BroadcastFilterRow): boolean {
  return preferences.listen[name] ?? (name !== "ShowOwnBroadcasts");
}

export function wantsFleetBroadcast(preferences: FleetBroadcastPreferences, broadcast: FleetBroadcast, me: number | null): boolean {
  return (me !== null && broadcast.senderCharID === me && listensToBroadcastRow(preferences, "ShowOwnBroadcasts")) ||
    listensToBroadcastRow(preferences, broadcast.name);
}

export function fleetBroadcastColor(preferences: FleetBroadcastPreferences, name: BroadcastFilterRow): string | undefined {
  const color = broadcastColorValue(preferences.colors[name]);
  return color && `rgb(${broadcastColorCss(color)} / 25%)`;
}

export function broadcastColorValue(color: number | BroadcastColor | undefined): BroadcastColor | undefined {
  return typeof color === "number" ? BROADCAST_PALETTE[color]?.[1] : color;
}

export function broadcastColorCss(color: BroadcastColor): string {
  return color.map(channel => Math.round(channel * 255)).join(" ");
}

export function sharedBroadcastRows(preferences: FleetBroadcastPreferences): BroadcastSettingRow[] {
  return BROADCAST_FILTER_ROWS.map(name => [
    BROADCAST_SETTING_FLAGS[name], preferences.listen[name] ?? true, broadcastColorValue(preferences.colors[name]) ?? null,
  ]);
}

export function broadcastPreferencesOf(rows: readonly BroadcastSettingRow[]): FleetBroadcastPreferences {
  const byFlag = new Map(rows.map(row => [row[0], row] as const));
  const listen: FleetBroadcastPreferences["listen"] = {}, colors: FleetBroadcastPreferences["colors"] = {};
  for (const name of BROADCAST_FILTER_ROWS) {
    const row = byFlag.get(BROADCAST_SETTING_FLAGS[name]);
    listen[name] = row?.[1] ?? true;
    const color = row?.[2];
    if (color) {
      const index = BROADCAST_PALETTE.findIndex(([, rgb]) => rgb.every((channel, position) => channel === color[position]));
      colors[name] = index === -1 ? color : index;
    }
  }
  return { listen, colors };
}

export function broadcastShareName(character: number): string {
  try { return localStorage.getItem(`evejs.character.${character}.sharedBroadcastDragCont_name`) ?? ""; }
  catch { return ""; }
}

export function saveBroadcastShareName(character: number, label: string): void {
  try { localStorage.setItem(`evejs.character.${character}.sharedBroadcastDragCont_name`, label.trim().slice(0, 60)); }
  catch { /* The name is available in the current window. */ }
}
