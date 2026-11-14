// The job board's dungeons (jobboard/client/features/dungeons): the sites a tracker of the client's dungeon tracking
// lists (evedungeons/client/anomalyTracker.py), and which of them the board shows (provider.AnomaliesProvider).
//
// - CombatAnomalyTracker: dungeonInstanceCacheMgr.GetCombatAnomalyInstances(), by solar system a list of KeyVals
//   (dungeonID, instanceID, siteID, archetypeID, factionID, difficulty, entryObjectTypeID, dungeonNameID, position) -
//   as recorded on Tranquility; a count where only the number is told (_unpack: so many unknown sites).
// - AnomaliesProvider._get_relevant_solar_systems: the pilot's system, and the systems with sites within the autopilot's
//   jumps (GetSystemsWithinAutopilotJumpRange, 0 to JUMPS_WHERE_DUNGEONS_CAN_BE_VISIBLE + 1), the walk out stopping
//   once JUMPS_WHERE_DUNGEONS_ARE_ALWAYS_VISIBLE is reached with MAXIMUM_SOLAR_SYSTEMS_WHERE_DUNGEONS_CAN_BE_VISIBLE
//   (20) systems found, and the autopilot route's systems with sites where INCLUDE_SYSTEMS_IN_ROUTE. Combat, ore
//   anomalies and ice belts: 1 and 1, no route; Homefront operations: the defaults, 2 and 5 and the route.
// - CosmicSignaturesProvider: hidden, nothing in Browse; the signature site the pilot is in (an entry of
//   typeDeadspaceSignature), in Active only (CosmicSignatureJob.is_available_in_browse False).
//
// Not as the client: the pilot's own system's sites come from this same answer, where the client takes them from the
// sensor suite's anomalies once its scan has updated them (with their scan result IDs).

import type { JsonValue } from "./wire.ts";

export interface DungeonSite { readonly solarSystemID: number; readonly dungeonID: number; readonly instanceID: number }

type Entry = readonly [JsonValue, JsonValue];
function entries(value: JsonValue | undefined): readonly Entry[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as { type?: unknown; name?: unknown; entries?: unknown; args?: unknown };
    if (v.type === "dict" && Array.isArray(v.entries)) return v.entries as Entry[];
    if (v.type === "object" && v.name === "util.KeyVal") return entries(v.args as JsonValue);
  }
  return [];
}
function items(value: JsonValue | undefined): readonly JsonValue[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)) return (value as { items: JsonValue[] }).items;
  return [];
}
function whole(value: JsonValue | undefined): number | null {
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) return whole((value as { value: JsonValue }).value);
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** A tracker's answer: the known sites by system (a system told only as a count has none known). */
export function decodeDungeonSites(value: JsonValue | undefined): ReadonlyMap<number, readonly DungeonSite[]> {
  const out = new Map<number, DungeonSite[]>();
  for (const [system, list] of entries(value)) {
    const solarSystemID = whole(system);
    if (solarSystemID === null) continue;
    const sites: DungeonSite[] = [];
    for (const row of items(list)) {
      const field = (k: string) => entries(row).find((e) => e[0] === k)?.[1];
      const dungeonID = whole(field("dungeonID")), instanceID = whole(field("instanceID")) ?? whole(field("siteID"));
      if (dungeonID !== null && instanceID !== null) sites.push({ solarSystemID, dungeonID, instanceID });
    }
    out.set(solarSystemID, sites);
  }
  return out;
}

/**
 * _get_relevant_solar_systems: the systems whose sites the board shows, nearest first, then those on the autopilot's
 * route (_get_solar_systems_on_route: the route's systems with sites, where the provider includes them).
 */
export function relevantDungeonSystems(sites: ReadonlyMap<number, unknown>, here: number | null, jumps: ReadonlyMap<number, number> | null,
  always: number, canBeVisible: number, maximum = 20, route: readonly number[] = []): number[] {
  const found: number[] = [];
  if (jumps) {
    const byJumps = new Map<number, number[]>();
    for (const [system, n] of jumps) if (n >= 1 && n <= canBeVisible + 1) byJumps.set(n, [...(byJumps.get(n) ?? []), system]);
    for (const n of [...byJumps.keys()].sort((a, b) => a - b)) {
      for (const system of byJumps.get(n)!.sort((a, b) => a - b)) if (sites.has(system)) found.push(system);
      if (n >= always && found.length >= maximum) break;
    }
  }
  for (const system of route) if (sites.has(system) && !found.includes(system)) found.push(system);
  return here !== null && !found.includes(here) ? [here, ...found] : found;
}
