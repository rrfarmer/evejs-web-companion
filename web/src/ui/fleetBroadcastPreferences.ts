import type { FleetBroadcast, FleetBroadcastName } from "../bridge/fleetBroadcasts.ts";
import { createSignal, type WritableSignal } from "../store/signals.ts";

export const BROADCAST_FILTER_ROWS = [
  "ShowOwnBroadcasts", "HealArmor", "HealCapacitor", "NeedBackup", "Target", "HealShield",
  "WarpTo", "TravelTo", "Event", "JumpTo", "AlignTo", "HealTarget", "InPosition",
  "EnemySpotted", "HoldPosition", "JumpBeacon", "Location",
] as const satisfies readonly (FleetBroadcastName | "ShowOwnBroadcasts" | "Event")[];
export type BroadcastFilterRow = typeof BROADCAST_FILTER_ROWS[number];

export const BROADCAST_PALETTE = [
  ["Gold", "255 179 0"], ["Orange", "255 89 0"], ["Red", "191 0 0"], ["Green", "26 153 26"],
  ["Teal", "0 161 145"], ["Light blue", "51 128 255"], ["Blue", "0 38 153"], ["Black", "0 0 0"], ["Gray", "179 179 179"],
] as const;

export interface FleetBroadcastPreferences {
  readonly listen: Partial<Record<BroadcastFilterRow, boolean>>;
  readonly colors: Partial<Record<BroadcastFilterRow, number>>;
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
      if (row !== "ShowOwnBroadcasts" && typeof color === "number" && Number.isInteger(color) && BROADCAST_PALETTE[color]) colors[row] = color;
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
  const index = preferences.colors[name];
  return index === undefined ? undefined : `rgb(${BROADCAST_PALETTE[index]?.[1]} / 25%)`;
}
