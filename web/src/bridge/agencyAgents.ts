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

/** careerAgentContentPiece.sortOrder: Military, Industry, Exploration, Advanced Military, Business. */
export const CAREER_DIVISION_ORDER: readonly number[] = [28, 27, 26, 29, 25];
/** evemissions CAREER_PATH_BY_DIVISION: the career path of a career division (careerpathconst). */
export const CAREER_PATH_BY_DIVISION: Readonly<Record<number, number>> = { 25: 5, 26: 4, 27: 5, 28: 6, 29: 7 };
/** appConst.raceByFaction for the four empires. */
const RACE_BY_FACTION: Readonly<Record<number, number>> = { 500001: 1, 500002: 2, 500003: 4, 500004: 8 };
/** careerAgentContentPiece.skillPlansByRaceAndDivision: the certified plan (its UUID's int) by race and division. */
const CAREER_PLANS: Readonly<Record<string, number>> = {
  "4:25": 47, "4:26": 42, "4:27": 46, "4:28": 34, "4:29": 38, "1:25": 47, "1:26": 43, "1:27": 46, "1:28": 35, "1:29": 39,
  "8:25": 47, "8:26": 44, "8:27": 46, "8:28": 36, "8:29": 40, "2:25": 47, "2:26": 45, "2:27": 46, "2:28": 37, "2:29": 41,
};

export interface AgencyCareerAgent {
  readonly agentID: number; readonly divisionID: number | null; readonly level: number; readonly stationID: number | null;
  readonly corporationID: number | null; readonly factionID: number | null; readonly solarSystemID: number; readonly jumps: number | null;
  /** The division's name and description messages (GetCareerAgentPathName / GetCareerAgentDescription). */
  readonly divisionNameID: number | null; readonly divisionDescriptionID: number | null;
  /** CAREER_PATH_BY_DIVISION's career path (its 32 px icon, careerConst.CAREERS_32_SIZES). */
  readonly careerPathID: number | null;
  /** SkillPlanLink's plan: its id and its name message. */
  readonly planID: number | null; readonly planNameID: number | null;
}

/**
 * agents.GetMySuggestedCareerAgents: the school's career agents (in agentID order), by solar system; the system the
 * fewest jumps away (GetJumpCountFromCurrent; the first such where several are as near); its agents, then sorted by
 * the division's place in CAREER_DIVISION_ORDER (ContentProviderCareerAgents._GetSortKey, a stable sort). Distance Any
 * (ApplyDefaultFilters) keeps each.
 */
export function suggestedCareerAgents(
  table: readonly AgencyAgentSource[], schoolAgentIDs: readonly number[], world: Pick<AgencyAgentWorld, "here" | "stationPlace" | "factionOf" | "jumpsTo">,
  divisions: Readonly<Record<string, { readonly nameID: number | null; readonly descriptionID: number | null }>>, plans: Readonly<Record<string, number | null>>,
): AgencyCareerAgent[] {
  const wanted = new Set(schoolAgentIDs);
  const agents = table.filter((row) => wanted.has(row.agentID)).sort((a, b) => a.agentID - b.agentID).flatMap((row) => {
    const place = row.stationID !== null ? world.stationPlace(row.stationID) : null;
    if (!place) return [];
    const corporationID = row.corporationID ?? place.ownerID;
    const factionID = corporationID !== null ? world.factionOf(corporationID) : null;
    const system = place.solarSystemID;
    const jumps = system === world.here ? 0 : world.jumpsTo(system) ?? null;
    const race = factionID !== null ? RACE_BY_FACTION[factionID] : undefined;
    const planID = race !== undefined && row.divisionID !== null ? CAREER_PLANS[`${race}:${row.divisionID}`] ?? null : null;
    return [{ agentID: row.agentID, divisionID: row.divisionID, level: row.level ?? 0, stationID: row.stationID, corporationID, factionID, solarSystemID: system, jumps,
      divisionNameID: divisions[String(row.divisionID)]?.nameID ?? null, divisionDescriptionID: divisions[String(row.divisionID)]?.descriptionID ?? null,
      careerPathID: row.divisionID !== null ? CAREER_PATH_BY_DIVISION[row.divisionID] ?? null : null, planID, planNameID: planID !== null ? plans[String(planID)] ?? null : null }];
  });
  // (An unreachable system the pathfinder counts as a very long way.)
  const far = (a: AgencyCareerAgent) => a.jumps ?? Number.MAX_SAFE_INTEGER;
  const nearest = agents.reduce<AgencyCareerAgent | null>((best, a) => (best === null || far(a) < far(best) ? a : best), null);
  const place = (a: AgencyCareerAgent) => { const i = CAREER_DIVISION_ORDER.indexOf(a.divisionID ?? -1); return i < 0 ? CAREER_DIVISION_ORDER.length : i; };
  return nearest === null ? [] : agents.filter((a) => a.solarSystemID === nearest.solarSystemID).sort((a, b) => place(a) - place(b));
}

/** A storyline agent of the journal's, with its mission's state and expiry (a FILETIME as a decimal string). */
export interface AgencyStorylineAgent {
  readonly agentID: number; readonly agentTypeID: number | null; readonly divisionID: number | null; readonly level: number;
  readonly stationID: number | null; readonly corporationID: number | null; readonly factionID: number | null;
  readonly solarSystemID: number; readonly jumps: number | null; readonly missionState: number | null; readonly expirationTime: string | null;
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
