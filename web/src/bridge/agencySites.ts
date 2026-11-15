// The Agency window's site pages (agencyNew/contentProviders: BaseContentProviderDungeons, its cosmic-anomaly kinds,
// ContentProviderSites for the combat anomalies), as the client picks the systems they show.
//
// THE SITES are the tracker's (evedungeons anomalyTracker CombatAnomalyTracker): the known sites by system
// (dungeonInstanceCacheMgr.GetCombatAnomalyInstances, each a KeyVal) over the systems' counts
// (GetCombatAnomaliesCount, a system's count an unknown site each), the known taking a system's place
// (BaseContentProviderCosmicAnomaliesWithUnknown: result = unknown; result.update(known)), the pilot's system with
// no sites where the known have none for it; then the systems with any.
//
// BaseContentProviderDungeons: outside known space only the pilot's system; else each system the security and distance
// filters let through, in buckets by its shown security above SECURITY_THRESHOLDS (0.9, 0.7, 0.4, 0.2, 0.0: the first
// it is above, else the last), the buckets in order with the pilot's system's first, each by jumps; taken in turn
// (GetRoundRobinMix) to 30, then sorted by jumps.
//
// Not here: the region distance, the scanned local sites (the sensor suite's), the trackers of the ore and ice kinds.

import type { JsonValue } from "./wire.ts";
import { shownSecurity } from "./systemSecurity.ts";
import { DISTANCE, ANY, SECURITY_FILTER, MAX_AGENT_PIECES } from "./agencyAgents.ts";
import type { InsurgencyCampaign, MilitiaFactionID, MilitiaSystem, MilitiaVictoryPoints } from "./militiaEnlistment.ts";

export interface AgencySite {
  readonly instanceID: number; readonly dungeonID: number | null; readonly archetypeID: number | null; readonly factionID: number | null;
  readonly difficulty: number | null; readonly dungeonNameID: number | null;
  /** A signature of the pilot's own system, as the sensor suite has it (SignatureSiteData): its name the targetID, its
   * signal strength the probe results' certainty for it (nought before any). */
  readonly targetID?: string | null; readonly signalStrength?: number;
  /** An escalation's expiry (the row's expiryTime, a FILETIME as a decimal string). */
  readonly expiryTime?: string | null;
  /** An asteroid belt (the Agency's Asteroid Belts): its celestial and orbit index, for its name (LocationAsteroidBeltFormatter). */
  readonly celestialIndex?: number; readonly orbitIndex?: number;
}
/** A system's sites: a known site, or null for one the count tells of (UNKNOWN_DUNGEON). */
export interface AgencySiteSystem {
  readonly solarSystemID: number; readonly sites: readonly (AgencySite | null)[]; readonly jumps: number | null; readonly security: number | null;
  /** The ore or ice kinds: the system's resource types (GetResourceTypeIDsInSystem / GetIceTypeIDsInSystem), and each
   * known site's (its dungeon's), by instance. */
  readonly resourceTypeIDs?: readonly number[]; readonly siteResourceTypeIDs?: Readonly<Record<number, readonly number[]>>;
  /** The Homefront kind: each known site's dungeon's description, gameplay description and archetype title messages. */
  readonly siteTexts?: Readonly<Record<number, { readonly descriptionID: number | null; readonly gameplayDescriptionID: number | null; readonly archetypeTitleID: number | null }>>;
}
/** The trackers (evedungeons anomalyTracker): CombatAnomalyTracker, OreAnomalyTracker, IceBeltTracker, by their calls. */
export const SITE_TRACKERS = Object.freeze({
  combat: { sites: "GetCombatAnomalyInstances", counts: "GetCombatAnomaliesCount" },
  ore: { sites: "GetOreAnomalyInstances", counts: "GetOreAnomaliesCount" },
  ice: { sites: "GetIceBeltInstances", counts: "GetIceBeltsCount" },
  // HomefrontOperationTracker: a BaseCosmicAnomalyTracker, no counts (ContentProviderHomefrontSites is not WithUnknown).
  homefront: { sites: "GetHomefrontSiteInstances", counts: null },
} as const);
export type SiteTrackerKind = keyof typeof SITE_TRACKERS;
/** get_consolidated_ore_types / the ice types' order by value (as the dungeons route consolidates them). */
export const RESOURCE_ORDER: Readonly<Record<"ore" | "ice", readonly number[]>> = {
  ore: [1230, 1228, 1224, 18, 1227, 20, 1226, 1231, 21, 1229, 1232, 1225, 19, 1223, 22, 11396],
  ice: [16269, 16266, 16267, 16268, 17975, 17976, 17977, 17978, 16264, 16265, 16263, 16262],
};
export interface AgencySiteFilters {
  readonly distance: number; readonly security: number;
  /** The Asteroid Belts' ore type (AsteroidBeltFiltersCont, FILTERTYPE_ORETYPE): ANY, or a type of ORE_TYPES_BY_VALUE. */
  readonly oreType?: number;
}
export const DEFAULT_SITE_FILTERS: AgencySiteFilters = Object.freeze({ distance: DISTANCE.any, security: ANY });
export interface AgencyFactionWarfareFilters {
  readonly distance: number;
  readonly faction: number;
  readonly adjacency: string;
}
export const DEFAULT_AGENCY_FW_FILTERS: AgencyFactionWarfareFilters = Object.freeze({ distance: DISTANCE.any, faction: ANY, adjacency: "" });
export interface AgencyFactionWarfareSystem extends AgencySiteSystem {
  readonly sites: readonly AgencySite[];
  readonly occupation: MilitiaSystem & { readonly occupierID: MilitiaFactionID };
  readonly victory: MilitiaVictoryPoints | null;
}

export interface AgencyInsurgencyFilters {
  readonly distance: number;
  readonly faction: number;
  readonly corruption: number;
  readonly suppression: number;
}
export const DEFAULT_AGENCY_INSURGENCY_FILTERS: AgencyInsurgencyFilters = Object.freeze({
  distance: DISTANCE.any, faction: ANY, corruption: ANY, suppression: ANY,
});
export interface InsurgencyStages {
  readonly corruption: number | null;
  readonly suppression: number | null;
}
export interface AgencyInsurgencySystem extends AgencySiteSystem {
  readonly stages: InsurgencyStages;
  readonly pirateFactionID: MilitiaFactionID | null;
  readonly occupierID: MilitiaFactionID | null;
  readonly isFobSystem: boolean;
}

/** A faction filter tests whether the system has such a site and leaves its other site rows in place. */
export function insurgencySiteCandidates(known: JsonValue, filters: AgencyInsurgencyFilters, here: number | null,
  jumpsTo: (systemID: number) => number | undefined): Map<number, (AgencySite | null)[]> {
  return new Map([...trackerSites(known, undefined, null)].filter(([id, sites]) =>
    (here === null || here < 31000000 || id === here) &&
    distanceMatches(id, here, id === here ? 0 : jumpsTo(id), filters.distance) &&
    sites.some((site) => site !== null && (filters.faction === ANY || site.factionID === filters.faction))));
}

export function agencyInsurgencySystems(candidates: ReadonlyMap<number, readonly (AgencySite | null)[]>,
  campaigns: readonly InsurgencyCampaign[], occupiers: ReadonlyMap<number, MilitiaFactionID | null>,
  progress: ReadonlyMap<number, InsurgencyStages>, here: number | null, jumpsTo: (id: number) => number | undefined,
  securityOf: (id: number) => number | null, filters: AgencyInsurgencyFilters): AgencyInsurgencySystem[] {
  const stageMatches = (stage: number | null | undefined, selected: number) => stage == null || selected < 0 || stage === selected;
  const matching = new Map([...candidates].filter(([id]) => {
    const stages = progress.get(id);
    return stageMatches(stages?.corruption, filters.corruption) && stageMatches(stages?.suppression, filters.suppression);
  }));
  return agencySiteSystems(matching, here, here === null || here < 31000000, jumpsTo, securityOf,
    { distance: filters.distance, security: ANY }).map((system) => {
    const campaign = campaigns.find((campaign) => campaign.coveredSystemIDs.includes(system.solarSystemID));
    return {
      ...system, stages: progress.get(system.solarSystemID) ?? { corruption: null, suppression: null },
      pirateFactionID: campaign?.factionID ?? null, occupierID: occupiers.get(system.solarSystemID) ?? null,
      isFobSystem: campaigns.some((campaign) => campaign.originSystemID === system.solarSystemID),
    };
  });
}

/** facwarSolarSystemUpgradeThresholds in build 3698585's appConst. */
const FW_LP_THRESHOLDS = [0, 40000, 60000, 90000, 140000, 200000, 300000];
export function agencyFactionWarfareUpgrade(lp: number): { level: number; next: number; progress: number } {
  const level = FW_LP_THRESHOLDS.slice(1, -1).filter((threshold) => threshold <= lp).length;
  const previous = FW_LP_THRESHOLDS[level]!;
  const next = FW_LP_THRESHOLDS[level + 1]!;
  return { level, next, progress: Math.max(0, Math.min((lp - previous) / (next - previous), 1)) };
}
/** agencyConst.SECURITY_THRESHOLDS. */
const SECURITY_THRESHOLDS = [0.9, 0.7, 0.4, 0.2, 0.0];

function entries(value: unknown): readonly [unknown, unknown][] {
  const v = value as { type?: string; entries?: unknown; args?: unknown } | null;
  if (v && v.type === "object") return entries(v.args);
  return v && Array.isArray(v.entries) ? v.entries as [unknown, unknown][] : [];
}
function items(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  const v = value as { items?: unknown } | null;
  return v && Array.isArray(v.items) ? v.items : [];
}
function num(value: unknown): number | null {
  const v = value && typeof value === "object" && "value" in (value as object) ? (value as { value: unknown }).value : value;
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

/** The tracker's sites by system: the counts' unknown sites, each system the known list where there is one. */
export function trackerSites(known: JsonValue | undefined, counts: JsonValue | undefined, here: number | null): Map<number, (AgencySite | null)[]> {
  const out = new Map<number, (AgencySite | null)[]>();
  for (const [system, count] of entries(counts)) {
    const id = num(system), n = num(count);
    if (id !== null && n !== null) out.set(id, Array.from({ length: Math.max(0, n) }, () => null));
  }
  const knownSites = new Map<number, AgencySite[]>();
  for (const [system, list] of entries(known)) {
    const id = num(system);
    if (id === null) continue;
    // _unpack: a count where the list would be is so many unknown sites.
    if (num(list) !== null) { out.set(id, Array.from({ length: Math.max(0, num(list)!) }, () => null)); continue; }
    knownSites.set(id, items(list).map((row) => {
      const field = (k: string) => entries(row).find((e) => e[0] === k)?.[1];
      const targetID = field("targetID");
      return { instanceID: num(field("instanceID")) ?? num(field("siteID")) ?? 0, dungeonID: num(field("dungeonID")), archetypeID: num(field("archetypeID")),
        factionID: num(field("factionID")), difficulty: num(field("difficulty")), dungeonNameID: num(field("dungeonNameID")),
        ...(typeof targetID === "string" && targetID ? { targetID } : {}) };
    }));
  }
  if (here !== null && !knownSites.has(here)) knownSites.set(here, []);
  for (const [id, list] of knownSites) out.set(id, list);
  return out;
}

/**
 * ContentProviderSignatures._GetAllDungeonInstances: the counts (GetSignatureInstances; a list kept as it is, a system
 * of none left out), and the pilot's system its sensor suite's signatures, or left out where there are none.
 */
export function signatureSites(counts: JsonValue | undefined, here: number | null, local: readonly AgencySite[]): Map<number, (AgencySite | null)[]> {
  const out = new Map<number, (AgencySite | null)[]>();
  for (const [system, value] of entries(counts)) {
    const id = num(system), n = num(value);
    if (id === null) continue;
    if (n !== null) { if (n > 0) out.set(id, Array.from({ length: n }, () => null)); continue; }
    const list = items(value);
    if (list.length) out.set(id, list.map(() => null));
  }
  if (here !== null) { if (local.length) out.set(here, [...local]); else out.delete(here); }
  return out;
}

/** BaseContentProviderDungeons._ConstructContentPieces' systems. */
function distanceMatches(id: number, here: number | null, jumps: number | undefined, filter: number): boolean {
  if (filter === DISTANCE.currentSystem) return id === here;
  return filter === DISTANCE.any || (jumps !== undefined && jumps <= filter);
}

export function agencySiteSystems(sites: ReadonlyMap<number, readonly (AgencySite | null)[]>, here: number | null, knownSpace: boolean,
  jumpsTo: (systemID: number) => number | undefined, securityOf: (systemID: number) => number | null, filters: AgencySiteFilters,
  bucketOrder?: (systemID: number) => number): AgencySiteSystem[] {
  const withSites = new Map([...sites].filter(([, list]) => list.length > 0));
  const jumpsOf = (id: number) => (id === here ? 0 : jumpsTo(id));
  const shown = (id: number) => { const s = securityOf(id); return s === null ? 0 : shownSecurity(s); };
  const candidates = !knownSpace ? (here !== null ? [here] : []) : [...withSites.keys()];
  const buckets = new Map<number, number[]>();
  for (const id of candidates) {
    // CheckCriteria: the security filter, then the distance.
    const sec = shown(id);
    if (filters.security === SECURITY_FILTER.high ? sec < 0.45 : filters.security === SECURITY_FILTER.nul ? sec > 0 : filters.security === SECURITY_FILTER.low ? !(sec > 0 && sec < 0.45) : false) continue;
    if (!distanceMatches(id, here, jumpsOf(id), filters.distance)) continue;
    let key = SECURITY_THRESHOLDS.findIndex((t) => sec > t);
    if (key < 0) key = SECURITY_THRESHOLDS.length;
    buckets.set(key, [...(buckets.get(key) ?? []), id]);
  }
  const far = (id: number) => jumpsOf(id) ?? Number.MAX_SAFE_INTEGER;
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const mine = keys.find((k) => here !== null && buckets.get(k)!.includes(here));
  if (mine !== undefined) { keys.splice(keys.indexOf(mine), 1); keys.unshift(mine); }
  const lists = keys.map((k) => buckets.get(k)!.sort((a, b) => (bucketOrder ? bucketOrder(a) - bucketOrder(b) : 0) || far(a) - far(b)));
  const mix: number[] = [];
  const at = lists.map(() => 0);
  while (mix.length < MAX_AGENT_PIECES && lists.some((l, i) => at[i]! < l.length)) {
    for (let i = 0; i < lists.length && mix.length < MAX_AGENT_PIECES; i += 1) if (at[i]! < lists[i]!.length) mix.push(lists[i]![at[i]!++]!);
  }
  return mix.filter((id) => withSites.has(id)).sort((a, b) => far(a) - far(b))
    .map((id) => ({ solarSystemID: id, sites: withSites.get(id)!, jumps: jumpsOf(id) ?? null, security: securityOf(id) }));
}

/** The factional warfare tracker keeps the current occupier's complexes. The provider fills each security
 * bucket by contested fraction, then displays the selected systems in jump order. */
export function agencyFactionWarfareSystems(known: JsonValue, zones: ReadonlyMap<number, readonly MilitiaSystem[]>,
  victory: ReadonlyMap<number, MilitiaVictoryPoints>, here: number | null, jumpsTo: (id: number) => number | undefined,
  securityOf: (id: number) => number | null, filters: AgencyFactionWarfareFilters): AgencyFactionWarfareSystem[] {
  const sites = trackerSites(known, undefined, null);
  const occupations = new Map<number, AgencyFactionWarfareSystem["occupation"]>();
  const matching = new Map<number, readonly AgencySite[]>();
  for (const systems of zones.values()) for (const system of systems) {
    const { systemID, occupierID, adjacency } = system;
    if (occupierID === null || !adjacency || (filters.faction !== ANY && filters.faction !== occupierID) || (filters.adjacency && filters.adjacency !== adjacency)) continue;
    const ownSites = sites.get(systemID)?.filter((site): site is AgencySite => site !== null && site.factionID === occupierID);
    if (!ownSites?.length) continue;
    occupations.set(systemID, { ...system, occupierID });
    matching.set(systemID, ownSites);
  }
  const contested = (id: number) => {
    const points = victory.get(id);
    return points ? -Math.min(points.score / points.threshold, 1) : 0;
  };
  return agencySiteSystems(matching, here, here === null || here < 31000000, jumpsTo, securityOf,
    { distance: filters.distance, security: ANY }, contested).map((row) => ({
    ...row, sites: matching.get(row.solarSystemID)!, occupation: occupations.get(row.solarSystemID)!, victory: victory.get(row.solarSystemID) ?? null,
  }));
}
