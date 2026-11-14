// The new Agency window's content groups (agencyNew/contentGroups: contentGroupConst - contentGroupNameByID,
// contentGroupDescriptionByID, cardBackgroundByContentGroup, contentGroupsEnabledInWormholes, agencyTabSortOrder - and
// each group class's childrenGroups and IsTabGroup, from HomeContentGroup down). Made from the client's constants by
// reading them; the groups' own pages (their content providers) are the Agency window's.

export interface AgencyGroup { readonly id: number; readonly name: string | null; readonly description: string | null; readonly card: string | null; readonly children: readonly number[]; readonly tab: boolean }

export const AGENCY_GROUPS: Readonly<Record<number, AgencyGroup>> = {
  1: { id: 1, name: "UI/Agency/ContentGroups/ContentGroupHome", description: null, card: null, children: [11, 12, 13, 88, 14, 67, 69, 62], tab: false },
  11: { id: 11, name: "UI/Agency/ContentGroups/ContentGroupMissions", description: "UI/Agency/ContentGroups/Descriptions/Missions", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_AgentsMissions.png", children: [71, 22, 21, 33, 51, 28], tab: true },
  71: { id: 71, name: "UI/Agency/ContentGroups/ContentGroupMissionAgentsHeraldry", description: "UI/Agency/ContentGroups/Descriptions/MissionAgentsHeraldry", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_AgentsHeraldry.png", children: [], tab: false },
  22: { id: 22, name: "UI/Agency/ContentGroups/ContentGroupMissionAgents", description: "UI/Agency/ContentGroups/Descriptions/MissionAgents", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_MissionAgents.png", children: [23, 25, 24, 26, 27], tab: false },
  23: { id: 23, name: "UI/Agency/ContentGroups/ContentGroupMissionAgentsSecurity", description: "UI/Agency/ContentGroups/Descriptions/MissionAgentsSecurity", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_AgentsSecurity.png", children: [], tab: false },
  25: { id: 25, name: "UI/Agency/ContentGroups/ContentGroupMissionAgentsDistribution", description: "UI/Agency/ContentGroups/Descriptions/MissionAgentsDistribution", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_AgentsDistribution.png", children: [], tab: false },
  24: { id: 24, name: "UI/Agency/ContentGroups/ContentGroupMissionAgentsMining", description: "UI/Agency/ContentGroups/Descriptions/MissionAgentsMining", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_AgentsMining.png", children: [], tab: false },
  26: { id: 26, name: "UI/Agency/ContentGroups/ContentGroupMissionAgentsResearch", description: "UI/Agency/ContentGroups/Descriptions/MissionAgentsResearch", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_AgentsR&D.png", children: [], tab: false },
  27: { id: 27, name: "UI/Agency/ContentGroups/ContentGroupMissionAgentsLocator", description: "UI/Agency/ContentGroups/Descriptions/MissionAgentsLocator", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_AgentsLocator.png", children: [], tab: false },
  21: { id: 21, name: "UI/Agency/ContentGroups/ContentGroupCareerAgents", description: "UI/Agency/ContentGroups/Descriptions/CareerAgents", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_CareerAgents.png", children: [], tab: false },
  33: { id: 33, name: "UI/Agency/ContentGroups/ContentGroupEpicArcs", description: "UI/Agency/ContentGroups/Descriptions/EpicArcs", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_EpicArcs.png", children: [], tab: false },
  51: { id: 51, name: "UI/Agency/ContentGroups/ContentGroupStorylineAgents", description: "UI/Agency/ContentGroups/Descriptions/StorylineAgents", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_StorylineMissions.png", children: [], tab: false },
  28: { id: 28, name: "UI/Agency/ContentGroups/ContentGroupAgentFinder", description: "UI/Agency/ContentGroups/Descriptions/AgentFinder", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_AgentFinder.png", children: [], tab: false },
  12: { id: 12, name: "UI/Agency/ContentGroups/ContentGroupEncounters", description: "UI/Agency/ContentGroups/Descriptions/Encounters", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_Encounters.png", children: [34, 78, 72, 73, 37], tab: true },
  34: { id: 34, name: null, description: "UI/Agency/ContentGroups/Descriptions/Seasons", card: null, children: [], tab: false },
  78: { id: 78, name: "UI/Agency/ContentGroups/ContentGroupHomefrontSites", description: "UI/Agency/ContentGroups/Descriptions/HomefrontSites", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_HomefrontSites.png", children: [], tab: false },
  72: { id: 72, name: "UI/Agency/ContentGroups/ContentGroupIncursions", description: "UI/Agency/ContentGroups/Descriptions/Incursions", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_Incursions.png", children: [], tab: false },
  73: { id: 73, name: "UI/Agency/ContentGroups/ContentGroupPirateStrongholds", description: "UI/Agency/ContentGroups/Descriptions/PirateStrongholds", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_PirateStrongholds.png", children: [], tab: false },
  37: { id: 37, name: "UI/Agency/ContentGroups/ContentGroupAbyssalDeadspace", description: "UI/Agency/ContentGroups/Descriptions/AbyssalDeadspace", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_AbyssalDeadspace.png", children: [44], tab: false },
  44: { id: 44, name: "UI/Agency/ContentGroups/ContentGroupAbyssalFilaments", description: "UI/Agency/ContentGroups/Descriptions/AbyssalFilaments", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_AbyssalWeather.png", children: [], tab: false },
  13: { id: 13, name: "UI/Agency/ContentGroups/ContentGroupExploration", description: "UI/Agency/ContentGroups/Descriptions/Exploration", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_Exploration.png", children: [38, 39, 45, 52, 63, 65, 83], tab: true },
  38: { id: 38, name: "UI/Agency/ContentGroups/ContentGroupCombatAnomalies", description: "UI/Agency/ContentGroups/Descriptions/CombatAnomalies", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_CombatSites.png", children: [], tab: false },
  39: { id: 39, name: "UI/Agency/ContentGroups/ContentGroupSignatures", description: "UI/Agency/ContentGroups/Descriptions/Signatures", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_CosmicSignatures.png", children: [], tab: false },
  45: { id: 45, name: "UI/Agency/ContentGroups/ContentGroupEscalations", description: "UI/Agency/ContentGroups/Descriptions/Escalations", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_Escalations.png", children: [], tab: false },
  52: { id: 52, name: "UI/Agency/ContentGroups/ContentGroupProjectDiscovery", description: "UI/Agency/ContentGroups/Descriptions/ProjectDiscovery", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_ProjectDiscovery.png", children: [], tab: false },
  63: { id: 63, name: "UI/Agency/ContentGroups/ContentGroupTriglavianSpace", description: "UI/Agency/ContentGroups/Descriptions/TriglavianSpace", card: "res:/UI/Texture/Classes/Agency/navigationCards/TriglavianSpace.png", children: [64], tab: false },
  64: { id: 64, name: "UI/Agency/ContentGroups/ContentGroupTriglavianFilaments", description: null, card: "res:/UI/Texture/Classes/Agency/navigationCards/TriglavianFilaments.png", children: [], tab: false },
  65: { id: 65, name: "UI/Agency/ContentGroups/ContentGroupESS", description: "UI/Agency/ContentGroups/Descriptions/ESS", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_EncounterSurveillanceSystem.png", children: [], tab: false },
  83: { id: 83, name: "UI/Agency/ContentGroups/ContentGroupZarzakh", description: "UI/Agency/ContentGroups/Descriptions/Zarzakh", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_Zarzakh.png", children: [], tab: false },
  88: { id: 88, name: "UI/Agency/ContentGroups/TheatersOfWar", description: null, card: null, children: [89, 35, 81], tab: true },
  89: { id: 89, name: "UI/Agency/ContentGroups/Campaigns", description: "UI/Agency/ContentGroups/Descriptions/Campaigns", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_campaigns.png", children: [], tab: false },
  35: { id: 35, name: "UI/Agency/ContentGroups/ContentGroupFactionalWarfare", description: "UI/Agency/ContentGroups/Descriptions/FactionalWarfare", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_FactionalWarfare.png", children: [82, 46, 47], tab: false },
  82: { id: 82, name: "UI/Agency/ContentGroups/ContentGroupPirateIncursionsGuide", description: "UI/Agency/ContentGroups/Descriptions/PirateIncursionsGuide", card: "res:/UI/Texture/Classes/Agency/navigationCards/PirateInsurgencyGuide.png", children: [], tab: false },
  46: { id: 46, name: "UI/Agency/ContentGroups/ContentGroupFactionalWarfareSystems", description: "UI/Agency/ContentGroups/Descriptions/FactionalWarfareSystems", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_FWSystems.png", children: [], tab: false },
  47: { id: 47, name: "UI/Agency/ContentGroups/ContentGroupFactionalWarfareAgents", description: "UI/Agency/ContentGroups/Descriptions/FactionalWarfareAgents", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_FWAgents.png", children: [], tab: false },
  81: { id: 81, name: "UI/Agency/ContentGroups/contentGroupPirateIncursionsHome", description: "UI/Agency/ContentGroups/Descriptions/PirateIncursionsHome", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_PirateInsurgencies.png", children: [82, 79], tab: false },
  79: { id: 79, name: "UI/Agency/ContentGroups/ContentGroupPirateIncursions", description: "UI/Agency/ContentGroups/Descriptions/PirateIncursions", card: "res:/UI/Texture/Classes/Agency/navigationCards/PirateInsurgencySystems.png", children: [], tab: false },
  14: { id: 14, name: "UI/Agency/ContentGroups/ContentGroupResourceHarvesting", description: "UI/Agency/ContentGroups/Descriptions/ResourceHarvesting", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_ResourceHarvesting.png", children: [40, 48, 41, 42, 87], tab: true },
  40: { id: 40, name: "UI/Agency/ContentGroups/ContentGroupAsteroidBelts", description: "UI/Agency/ContentGroups/Descriptions/AsteroidBelts", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_AsteroidBelts.png", children: [], tab: false },
  48: { id: 48, name: "UI/Agency/ContentGroups/ContentGroupOreAnomalies", description: "UI/Agency/ContentGroups/Descriptions/OreAnomalies", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_OreSites.png", children: [], tab: false },
  41: { id: 41, name: "UI/Agency/ContentGroups/ContentGroupIceBelts", description: "UI/Agency/ContentGroups/Descriptions/IceBelts", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_IceBelts.png", children: [], tab: false },
  42: { id: 42, name: "UI/Agency/ContentGroups/ContentGroupPlanetaryProduction", description: "UI/Agency/ContentGroups/Descriptions/PlanetaryProduction", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_PlanetaryProduction.png", children: [42, 84, 85], tab: true },
  84: { id: 84, name: "UI/Agency/ContentGroups/ContentGroupColonyResourcesAgency", description: "UI/Agency/ContentGroups/Descriptions/ColonyResourcesAgency", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_ColonyResourcesAgency.png", children: [], tab: false },
  85: { id: 85, name: "UI/Agency/ContentGroups/ContentGroupMercDens", description: "UI/Agency/ContentGroups/Descriptions/MercDens", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_MercDen.png", children: [], tab: false },
  87: { id: 87, name: "UI/Agency/ContentGroups/PhasedFields", description: "UI/Agency/ContentGroups/Descriptions/PhasedFields", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_phasedFields.png", children: [], tab: false },
  67: { id: 67, name: "UI/Agency/ContentGroups/ContentGroupFleetUp", description: "UI/Agency/ContentGroups/Descriptions/FleetUp", card: "res:/UI/Texture/Classes/Agency/navigationCards/EveEvolvedSmall.png", children: [68], tab: true },
  68: { id: 68, name: "UI/Agency/ContentGroups/ContentGroupFleetUpRegistration", description: null, card: null, children: [], tab: false },
  69: { id: 69, name: "UI/Agency/ContentGroups/ContentGroupHelp", description: "UI/Agency/ContentGroups/Descriptions/Help", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_HelpVideos.png", children: [], tab: true },
  62: { id: 62, name: "UI/Agency/ContentGroups/ContentGroupCorp", description: "UI/Agency/ContentGroups/Descriptions/Corp", card: "res:/UI/Texture/Classes/Agency/navigationCards/card_CorpSmall.png", children: [], tab: false },
};

/** contentGroupConst.agencyTabSortOrder. */
export const AGENCY_TAB_ORDER: readonly number[] = [11, 12, 88, 13, 14, 62, 67, 69];
/** contentGroupConst.contentGroupsEnabledInWormholes. */
export const AGENCY_WORMHOLE_GROUPS: readonly number[] = [45, 37, 44, 38, 39, 52, 48, 42, 12, 13, 14, 41, 63, 64, 69, 62, 67, 68, 4, 34, 71, 11, 79, 86, 87, 88, 89];
/** careerConst.AGENCY_SECTION_NAMES_TO_IDS: a career goal's agencyScreen to its content group. */
export const AGENCY_SCREEN_GROUPS: Readonly<Record<string, number>> = {
  ABYSSAL_DEADSPACE: 37, ASTEROID_BELTS: 40, CAREER_AGENTS: 21, COMBAT_ANOMOLIES: 38, CORP_RECRUITMENT: 62, COSMIC_SIGNATURES: 39,
  DISTRIBUTION_AGENTS: 25, EPIC_ARCS: 33, FACTION_WARFARE_AGENTS: 47, FACTION_WARFARE_INFO: 35, FACTION_WARFARE_LEARN: 35,
  FACTION_WARFARE_SYSTEMS: 46, FLEET_FINDER: 67, HOMEPAGE: 1, MINING_AGENTS: 24, SECURITY_AGENTS: 23, HERALDRY_AGENTS: 71,
};

/** The group's ancestors from the home group down to it (GetAncestorList with the group). */
export function agencyPath(id: number): number[] {
  const parentOf = (child: number): number | null => { for (const g of Object.values(AGENCY_GROUPS)) if (g.children.includes(child)) return g.id; return null; };
  const path = [id];
  for (let p = parentOf(id); p !== null && path.length < 12; p = parentOf(p)) path.unshift(p);
  return path;
}
