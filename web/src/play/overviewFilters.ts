import type { CorpWar } from "../bridge/corpWars.ts";
import { isNpcOwner } from "../bridge/mail.ts";
import { militiaFactionID } from "../bridge/militiaEnlistment.ts";
import { isNpcCorporation } from "../bridge/ownerInfo.ts";
import type { ContactStandings } from "../bridge/standingsReads.ts";

export interface PresetMask {
  readonly groups: ReadonlySet<number>;
  readonly filteredStates: readonly number[];
  readonly alwaysShownStates: readonly number[];
}

export interface OverviewRelationships {
  readonly corporationID: number | null;
  readonly allianceID: number | null;
  readonly warFactionID: number | null;
  readonly fleetMembers: ReadonlySet<number>;
  readonly contacts: ContactStandings | null;
  readonly wars: readonly CorpWar[];
  readonly now: bigint;
}

interface OverviewItem {
  readonly isSelf: boolean;
  readonly typeID: number | null;
  readonly groupID: number | null;
  readonly categoryID: number | null;
  readonly name: string | null;
  readonly ownerID?: number | null;
  readonly characterID?: number | null;
  readonly corporationID?: number | null;
  readonly allianceID?: number | null;
  readonly warFactionID?: number | null;
}

// parklife/state.py StateSvc.InitFilter and inventorycommon.const.stateFilteredCategories.
const DRONES_AND_FIGHTERS = new Set([18, 87]);
const FILTER_CATEGORIES = new Set([6, 11, ...DRONES_AND_FIGHTERS]);
const FILTER_GROUPS = new Set([10, 12, 186, 340, 366, 411, 502, 517, 711, 1991]);
const STATE_FILTERED_CATEGORIES = new Set([1, 6, 18, 22, 23, 40, 46, 65, 87]);
const IGNORE_OVERVIEW_TYPES = new Set([41235, 45008, 46030, 46031, 46032, 54314, 54315, 54316, 54572, 54573]);
const UNLIT_EFFECT_BEACON = 41235;
const HARVESTABLE_CLOUD = 711;
const AGENT_IN_SPACE = 517;
const STRUCTURE = 65;
const SPECIAL_GROUPS = new Set([8, 319]);
const DEADSPACE_OVERSEER_STRUCTURE = 494;
const FILTER_LCS_NAMES = new Set(["wall_x", "wall_z", " wall", " barricade", " fence", " barrier", " junction", " elevator", " lookout", " neon sign"]);

const FLAG = {
  sameFleet: 11, samePlayerCorp: 12, sameAlliance: 14, standingHigh: 15, standingGood: 16,
  agentInteractable: 21, sameMilitia: 45, alliesAtWar: 49,
} as const;

/** war_cso.GetRelationship checks a currently hostile war before shared allies. */
function alliesAtWar(other: number, relations: OverviewRelationships): boolean {
  const own = relations.allianceID ?? relations.corporationID;
  if (own === null || other === relations.corporationID || other === relations.allianceID) return false;
  let allied = false;
  for (const war of relations.wars) {
    const opposing = war.declaredByID === own ? other : war.declaredByID === other ? own : null;
    const { now } = relations;
    if (opposing !== null && (war.timeStarted ?? 0n) < now && (war.timeFinished === null || now < war.timeFinished)) {
      if (opposing === war.againstID || war.allies.some(ally =>
        ally.allyID === opposing && ally.timeStarted !== null && ally.timeStarted < now &&
        ally.timeFinished !== null && now < ally.timeFinished,
      )) return false;
    }
    const defenderSide = (id: number) => id === war.againstID || war.allyIDs.includes(id);
    if (defenderSide(own) && defenderSide(other)) allied = true;
  }
  return allied;
}

function stateMatches(flag: number, item: OverviewItem, group: number, category: number, relations?: OverviewRelationships): boolean {
  if (flag === FLAG.agentInteractable) return group === AGENT_IN_SPACE;
  if (!relations) return false;
  switch (flag) {
    case FLAG.sameFleet: {
      const character = category === STRUCTURE ? null : item.characterID;
      const pilot = character ?? (DRONES_AND_FIGHTERS.has(category) ? item.ownerID : null);
      return pilot != null && relations.fleetMembers.has(pilot);
    }
    case FLAG.samePlayerCorp:
      return relations.corporationID !== null && !isNpcCorporation(relations.corporationID) &&
        relations.corporationID === item.corporationID && STATE_FILTERED_CATEGORIES.has(category);
    case FLAG.sameAlliance:
      return relations.allianceID !== null && relations.allianceID === item.allianceID && STATE_FILTERED_CATEGORIES.has(category);
    case FLAG.standingHigh:
    case FLAG.standingGood: {
      if (!relations.contacts || item.ownerID == null || item.ownerID === 1 || isNpcOwner(item.ownerID) ||
        !STATE_FILTERED_CATEGORIES.has(category)) return false;
      for (const id of [item.ownerID, item.corporationID, item.allianceID]) {
        if (id == null) continue;
        for (const standings of [relations.contacts.personal, relations.contacts.corporate, relations.contacts.alliance]) {
          const standing = standings.get(id) ?? 0;
          if (flag === FLAG.standingHigh ? standing > 5 : standing > 0 && standing <= 5) return true;
        }
      }
      return false;
    }
    case FLAG.sameMilitia:
      return item.corporationID != null && (item.characterID != null || DRONES_AND_FIGHTERS.has(category) || category === STRUCTURE) &&
        item.warFactionID === relations.warFactionID && militiaFactionID(item.warFactionID) !== null;
    case FLAG.alliesAtWar: {
      const owner = item.allianceID ?? item.corporationID;
      return owner != null && alliesAtWar(owner, relations);
    }
    default:
      return false;
  }
}

function matchesMask(item: OverviewItem, groupID: number | null, mask: PresetMask | null, relations?: OverviewRelationships,
  alwaysShownStates: readonly number[] = mask?.alwaysShownStates ?? []): boolean {
  if (!mask) return true;
  const group = groupID ?? 0;
  if (groupID !== null && !mask.groups.has(group)) return false;
  const category = item.categoryID ?? 0;
  if (!mask.filteredStates.length || (!FILTER_CATEGORIES.has(category) && !FILTER_GROUPS.has(group))) return true;
  const matches = (state: number) => stateMatches(state, item, group, category, relations);
  return alwaysShownStates.some(matches) || !mask.filteredStates.some(matches);
}

/** SlimItemDisplayChecker.ShouldDisplayItem. A state exception still requires an allowed group. */
export function overviewRowWanted(item: OverviewItem, group: number | null, mask: PresetMask | null, relations?: OverviewRelationships): boolean {
  return !item.isSelf && !IGNORE_OVERVIEW_TYPES.has(item.typeID ?? 0) && matchesMask(item, group, mask, relations);
}

export type BracketOverride = "default" | "none" | "all";

/** bracketMgr.IsWanted followed by tactical.WantIt for ordinary overview brackets. */
export function gridBracketWanted(item: OverviewItem, groupID: number | null, mask: PresetMask | null,
  overviewMask: PresetMask | null, options: {
    override: BracketOverride; showSpecials: boolean; selectedOrTargeted: boolean; hasBracketData: boolean;
  }, relations?: OverviewRelationships): boolean {
  if (item.isSelf || !options.hasBracketData) return false;
  if (groupID === DEADSPACE_OVERSEER_STRUCTURE && FILTER_LCS_NAMES.has(item.name?.toLowerCase() ?? "")) return false;
  if (groupID === HARVESTABLE_CLOUD) return options.selectedOrTargeted;
  if (groupID !== null && SPECIAL_GROUPS.has(groupID)) return options.showSpecials || options.selectedOrTargeted;
  if (options.selectedOrTargeted || options.override === "all") return true;
  if (options.override === "none" || item.typeID === UNLIT_EFFECT_BEACON) return false;
  return matchesMask(item, groupID, mask, relations, overviewMask?.alwaysShownStates ?? []);
}
