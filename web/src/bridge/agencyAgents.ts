// The Agency window's agent pages (agencyNew/contentProviders: ContentProviderAgents and its Security, Distribution,
// Mining, Research, Locator and Heraldry kinds), as the client picks their agents.
//
// THE AGENTS are the agents service's table (agentMgr.GetAgents, kept), each with its station's solar system and its
// corporation's faction from the static data (the client's cfg). An agent at no station has no system, and the
// distance rule (CheckDistanceCriteria) never takes it.
//
// ContentProviderAgents._ConstructContentPieces: the agents of the systems within the distance (an agent's jumps the
// autopilot's, GetNumberOfJumps), each kept where
//   its division is a standard one (AGENT_STANDARDDIVISIONIDS: Security, Mining, Distribution, R&D, Heraldry), the
//     kind's own where the kind has one, and its agent type the kind's (basic, research, heraldry);
//   Heraldry is available, for a Heraldry agent;
//   the faction, corporation, level, security and "show only available" filters let it through - the last, unless
//     ticked (FILTERTYPE_AGENTIGNORESTANDINGSREQUIREMENT), keeps the agents the pilot's standings let it use
//     (standingSvc.CanUseAgent), as does the level filter's Highest Available;
// then put in buckets by (division, high security - the system's shown security 0.5 or more), the buckets in order of
// (not high security, the division's place), each bucket's agents by (level, -jumps, the three derived standings
// highest first) highest first; and taken in turn from the buckets (GetRoundRobinMix) to MAX_CONTENT_PIECES_MAX, 30.
//
// Not here: the region and constellation distance (DISTANCE_REGION), the avoided systems (the range includes them; the
// autopilot here avoids none unless set), new agents (OnNPCStandingChange), the agents' active missions.

import { effectiveStandingWithAgent, applyStandingBonus, standingBonusSkill } from "./effectiveStanding.ts";
import { canUseAgentAtLevel } from "./epicArcs.ts";
import { shownSecurity } from "./systemSecurity.ts";

/** appConst divisions and agent types the providers go by. */
export const DIVISION = Object.freeze({ distribution: 22, mining: 23, security: 24, heraldry: 37, rd: 18 });
export const AGENT_TYPE = Object.freeze({ basic: 2, research: 4, heraldry: 13 });
/** agencyConst.AGENT_STANDARDDIVISIONIDS. */
export const STANDARD_DIVISIONS: readonly number[] = [DIVISION.security, DIVISION.mining, DIVISION.distribution, DIVISION.rd, DIVISION.heraldry];
/** agencyConst.MAX_CONTENT_PIECES_MAX. */
export const MAX_AGENT_PIECES = 30;
/** agencyConst distances and filter values. */
export const DISTANCE = Object.freeze({ currentSystem: 1, two: 2, five: 5, ten: 10, any: 1000 });
export const ANY = -1;
export const HIGHEST_AVAILABLE = -2;
export const SECURITY_FILTER = Object.freeze({ high: 1, low: 2, nul: 3 });

/** Each agent content group's provider: its division and agent type (null for any standard / any). */
// ContentProviderHeraldryAgents: every Heraldry agent (GetAgentsByType, not the systems in range), Any Distance taking
// each (its own CheckDistanceCriteria, without the wormhole rule).
export const AGENT_PROVIDERS: Readonly<Record<number, { readonly division: number | null; readonly agentType: number | null; readonly locator?: boolean; readonly everywhere?: boolean }>> = {
  23: { division: DIVISION.security, agentType: AGENT_TYPE.basic },
  25: { division: DIVISION.distribution, agentType: AGENT_TYPE.basic },
  24: { division: DIVISION.mining, agentType: AGENT_TYPE.basic },
  26: { division: DIVISION.rd, agentType: AGENT_TYPE.research },
  27: { division: null, agentType: null, locator: true },
  71: { division: DIVISION.heraldry, agentType: AGENT_TYPE.heraldry, everywhere: true },
};

export interface AgencyAgentSource {
  readonly agentID: number; readonly agentTypeID: number | null; readonly divisionID: number | null; readonly level: number | null;
  readonly stationID: number | null; readonly corporationID: number | null; readonly isLocatorAgent?: boolean;
}
export interface AgencyAgentFilters {
  readonly distance: number; readonly level: number; readonly security: number; readonly factionID: number; readonly corporationID: number;
  readonly ignoreStandings: boolean;
}
export const DEFAULT_AGENT_FILTERS: AgencyAgentFilters = Object.freeze({ distance: DISTANCE.any, level: ANY, security: ANY, factionID: ANY, corporationID: ANY, ignoreStandings: false });

export interface AgencyAgent {
  readonly agentID: number; readonly agentTypeID: number | null; readonly divisionID: number | null; readonly level: number;
  readonly stationID: number | null; readonly corporationID: number | null; readonly factionID: number | null;
  readonly solarSystemID: number; readonly jumps: number | null; readonly security: number | null; readonly canUse: boolean; readonly isLocatorAgent: boolean;
}

export interface AgencyAgentWorld {
  /** The pilot's solar system. */
  readonly here: number | null;
  /** A station's solar system and owner (cfg.stations). */
  readonly stationPlace: (stationID: number) => { readonly solarSystemID: number; readonly ownerID: number | null } | null;
  /** A corporation's faction (cfg). */
  readonly factionOf: (corporationID: number) => number | null;
  /** The autopilot's jumps from here; undefined for a system it cannot reach. */
  readonly jumpsTo: (solarSystemID: number) => number | undefined;
  readonly securityOf: (solarSystemID: number) => number | null;
  /** The pilot's standings towards it, by owner, and its skills' levels. */
  readonly standings: ReadonlyMap<number, number>;
  readonly skillLevel: (typeID: number) => number;
  readonly heraldryAvailable: boolean;
}

/** appConst.factions less factionsWithoutAgents (a set: each once). */
export const AGENT_FACTIONS: readonly number[] = [500003, 500007, 500011, 500001, 500004, 500010, 500013, 500008, 500002, 500018, 500014, 500019, 500020,
  500016, 500012, 500009, 500015, 500029, 500028];

/** standingSvc.GetStandingWithSkillBonus(ownerID, session.charid): the pilot's standing from an NPC owner, raised by the
 * skill GetStandingSkillBonus picks for the owner's faction (a faction its own). */
export function standingWithSkillBonus(ownerID: number, ownerFactionID: number | null, standings: ReadonlyMap<number, number>, skillLevel: (typeID: number) => number): number {
  const standing = standings.get(ownerID) ?? 0;
  const skill = standingBonusSkill(ownerFactionID, standing);
  return applyStandingBonus(skill === null ? 0 : skillLevel(skill) * 0.4, standing);
}

/** agentUtil.GetAgentStandingThreshold: the standing a level asks for. */
export function agentStandingThreshold(level: number): number | null {
  return level === 1 ? -10 : level === 2 ? 1 : level === 3 ? 3 : level === 4 ? 5 : level === 5 ? 7 : null;
}

/** Python 2's str() of a float that round(x, 2) made: always with its point ("1.0", "-0.5"). */
export function pythonRoundedText(value: number): string {
  const r = Math.round(value * 100) / 100;
  const text = String(r === 0 ? 0 : r);
  return text.includes(".") ? text : `${text}.0`;
}

/** Python's comparison of two lists of numbers. */
function compareLists(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return a.length - b.length;
}

/** ContentProviderAgents' content pieces for the group, as the client picks them. */
export function agencyAgents(groupID: number, table: readonly AgencyAgentSource[], world: AgencyAgentWorld, filters: AgencyAgentFilters): AgencyAgent[] {
  const provider = AGENT_PROVIDERS[groupID];
  if (!provider) return [];
  const raised = (agent: { agentID: number; corporationID: number | null; factionID: number | null }) =>
    [agent.factionID, agent.corporationID, agent.agentID].map((fromID) => {
      if (fromID === null) return 0;
      const standing = world.standings.get(fromID) ?? 0;
      const skill = standingBonusSkill(agent.factionID, standing);
      return applyStandingBonus(skill === null ? 0 : world.skillLevel(skill) * 0.4, standing);
    }).sort((x, y) => y - x);
  const buckets = new Map<string, { division: number; high: boolean; agents: { agent: AgencyAgent; key: readonly number[] }[] }>();
  for (const row of table) {
    const place = row.stationID !== null ? world.stationPlace(row.stationID) : null;
    if (!place) continue;
    const corporationID = row.corporationID ?? place.ownerID;
    const factionID = corporationID !== null ? world.factionOf(corporationID) : null;
    const system = place.solarSystemID;
    const jumps = system === world.here ? 0 : world.jumpsTo(system);
    const security = world.securityOf(system);
    const level = row.level ?? 0;
    const canUse = canUseAgentAtLevel(level, row.agentTypeID, effectiveStandingWithAgent({ agentID: row.agentID, corporationID, factionID }, world.standings, world.skillLevel));
    // CheckInactiveAgentGenericCriteria: the division enabled, valid, the agent type, the distance.
    if (row.divisionID === DIVISION.heraldry && !world.heraldryAvailable) continue;
    if (provider.locator ? !row.isLocatorAgent : row.divisionID !== provider.division) continue;
    if (row.divisionID === null || !STANDARD_DIVISIONS.includes(row.divisionID)) { if (!provider.locator) continue; }
    if (provider.agentType !== null && row.agentTypeID !== provider.agentType) continue;
    if (world.here === null) continue;
    if (filters.distance === DISTANCE.currentSystem ? system !== world.here
      : filters.distance === DISTANCE.any && provider.everywhere ? false : jumps === undefined || (filters.distance !== DISTANCE.any && jumps > filters.distance)) continue;
    // CheckAgentsUserSelectedFilterCriteria.
    if (filters.factionID !== ANY && (factionID !== filters.factionID || (filters.corporationID !== ANY && corporationID !== filters.corporationID))) continue;
    if (filters.level === HIGHEST_AVAILABLE ? !canUse : filters.level !== ANY && level !== filters.level) continue;
    if (!filters.ignoreStandings && !canUse) continue;
    const shown = security === null ? 0 : shownSecurity(security);
    if (filters.security === SECURITY_FILTER.high ? shown < 0.45 : filters.security === SECURITY_FILTER.nul ? shown > 0 : filters.security === SECURITY_FILTER.low ? !(shown > 0 && shown < 0.45) : false) continue;
    const high = shown >= 0.5;
    const division = row.divisionID ?? 0;
    const bucketKey = `${division}:${high}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) buckets.set(bucketKey, bucket = { division, high, agents: [] });
    const agent: AgencyAgent = { agentID: row.agentID, agentTypeID: row.agentTypeID, divisionID: row.divisionID, level, stationID: row.stationID, corporationID, factionID,
      solarSystemID: system, jumps: jumps ?? null, security, canUse, isLocatorAgent: row.isLocatorAgent === true };
    bucket.agents.push({ agent, key: [level, -(jumps ?? 1000), ...raised({ agentID: row.agentID, corporationID, factionID })] });
  }
  // _GetBucketSortKey: (-isHighSec, the division's place), lowest first; each bucket highest sort key first.
  const placeOf = (d: number) => (STANDARD_DIVISIONS.includes(d) ? STANDARD_DIVISIONS.indexOf(d) : d);
  const ordered = [...buckets.values()].sort((a, b) => compareLists([-Number(a.high), placeOf(a.division)], [-Number(b.high), placeOf(b.division)]))
    .map((b) => b.agents.sort((x, y) => compareLists(y.key, x.key)).map((x) => x.agent));
  // GetRoundRobinMix: one from each bucket in turn, a spent bucket dropped, to the cap.
  const mix: AgencyAgent[] = [];
  const at = ordered.map(() => 0);
  while (mix.length < MAX_AGENT_PIECES && ordered.some((list, i) => at[i]! < list.length)) {
    for (let i = 0; i < ordered.length && mix.length < MAX_AGENT_PIECES; i += 1) if (at[i]! < ordered[i]!.length) mix.push(ordered[i]![at[i]!++]!);
  }
  return mix;
}
