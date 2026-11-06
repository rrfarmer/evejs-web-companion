// How many pilots each plugin is flying in this tab, for the count on its launcher.
// Read from who holds each ship (flow.flying.holdShip), so a plugin says nothing more
// to get one, and one that is flying nobody shows none.

import { createSignal, readonlySignal } from "../store/signals.ts";

/** A plugin's id from what holds a ship ("plugin:<id>") or a window's id ("plugin:<id>.<name>"). */
export function pluginIDOf(id: string): string | null {
  if (!id.startsWith("plugin:")) return null;
  const rest = id.slice("plugin:".length);
  const dot = rest.indexOf(".");
  return (dot < 0 ? rest : rest.slice(0, dot)) || null;
}

/** Pilots per plugin, from what holds each signed-in pilot's ship. */
export function countPluginPilots(holders: readonly (string | null)[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const holder of holders) {
    const pluginID = holder === null ? null : pluginIDOf(holder);
    if (pluginID !== null) counts.set(pluginID, (counts.get(pluginID) ?? 0) + 1);
  }
  return counts;
}

const counts = createSignal<ReadonlyMap<string, number>>(new Map());

export const pluginPilotCounts = readonlySignal(counts);

export function setPluginPilotCounts(next: ReadonlyMap<string, number>): void {
  counts.set(next);
}
