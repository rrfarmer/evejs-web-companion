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
  /** crimewatchSvc's flagged pilots in the system (GetClientStates, OnSystemCriminalFlagUpdates): criminals and suspects. */
  readonly criminals?: ReadonlySet<number>;
  readonly suspects?: ReadonlySet<number>;
  /** The pilots this one has a limited engagement with (crimewatchSvc.HasLimitedEngagmentWith). */
  readonly engagedWith?: ReadonlySet<number>;
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
  readonly securityStatus?: number | null;
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

/**
 * stateSvc's flags as the 3698585 client has them by default (GetActiveStateOrder('flag') / ('background') read from the
 * running client): each flag's iconIndex (FlagIcon/8/<iconIndex + 1>.png), its flag colour, its background colour,
 * whether the flag / the background blinks, and its icon's colour (flagProperties.iconColor).
 */
export interface StateFlagLook { readonly flag: number; readonly text: string; readonly iconIndex: number; readonly flagColor: readonly number[];
  readonly backgroundColor: readonly number[]; readonly flagBlink: boolean; readonly backgroundBlink: boolean; readonly iconColor: readonly number[] }
const W = [1, 1, 1, 1];
const look = (flag: number, text: string, iconIndex: number, flagColor: number[], backgroundColor: number[], flagBlink = false, backgroundBlink = false, iconColor = W): StateFlagLook =>
  ({ flag, text, iconIndex, flagColor, backgroundColor, flagBlink, backgroundBlink, iconColor });
export const STATE_FLAG_LOOKS: ReadonlyMap<number, StateFlagLook> = new Map([
  look(13, "Pilot is at war with your corporation/alliance", 1, [0.75, 0, 0, 1], [0.75, 0, 0, 1], true),
  look(44, "Pilot is at war with your militia", 1, [1, 0.35, 0, 1], [0.75, 0, 0, 1], true),
  look(11, "Pilot is in your fleet", 0, [0.6, 0.15, 0.9, 1], [0.6, 0.15, 0.9, 1]),
  look(12, "Pilot is in your Capsuleer corporation", 1, [0.1, 0.6, 0.1, 1], [0, 0.15, 0.6, 1]),
  look(14, "Pilot is in your alliance", 1, [0, 0.15, 0.6, 1], [0, 0.15, 0.6, 1]),
  look(15, "Pilot has Excellent Standing.", 2, [0, 0.15, 0.6, 1], [0, 0.15, 0.6, 1]),
  look(16, "Pilot has Good Standing.", 2, [0.2, 0.5, 1, 1], [0, 0.15, 0.6, 1]),
  look(45, "Pilot is in your militia or allied to your militia", 1, [0.3, 0, 0.5, 1], [0.2, 0.5, 1, 1]),
  look(9, "Pilot has a security status below -5", 5, [0.75, 0, 0, 1], [1, 0.35, 0, 1], true),
  look(19, "Pilot has Terrible Standing.", 3, [0.75, 0, 0, 1], [0.75, 0, 0, 1]),
  look(18, "Pilot has Bad Standing.", 3, [1, 0.35, 0, 1], [0.75, 0, 0, 1]),
  look(49, "Pilot is an ally in one or more of your wars", 1, [0, 0.15, 0.6, 1], [0.2, 0.5, 1, 1]),
  look(10, "Pilot has a security status below 0", 5, [1, 0.7, 0, 1], [0.7, 0.7, 0.7, 1]),
  look(17, "Pilot has Neutral Standing.", 4, [0.7, 0.7, 0.7, 1], [0.7, 0.7, 0.7, 1]),
  look(48, "Pilot has No Standing.", 4, [0.7, 0.7, 0.7, 1], [0.7, 0.7, 0.7, 1]),
  look(21, "Pilot (agent) is interactable", 6, [0.2, 0.5, 1, 1], [0.7, 0.7, 0.7, 1]),
  // crimewatch's: a black flag with the icon in its colour (StateProperty iconColor), the background orange
  look(52, "Pilot has a limited engagement with you", 5, [0, 0, 0, 1], [1, 0.35, 0, 1], true, false, [0, 0.63, 0.57, 1]),
  look(51, "Pilot is a criminal", 5, [0, 0, 0, 1], [1, 0.35, 0, 1], true, false, [0.867, 0, 0, 1]),
  look(50, "Pilot is a suspect", 5, [0, 0, 0, 1], [1, 0.35, 0, 1], false, false, [0.984, 0.702, 0.22, 1]),
].map((l) => [l.flag, l]));
/**
 * The active orders (the client's defaults, as read): the first flag whose Check holds is the thing's. Criminal (51),
 * Suspect (50), Limited Engagement (52), Has Kill Right (53) and Is Wanted (20) are in the client's orders too; the
 * page does not read crimewatch or bounties, so they are left out here.
 */
const FLAG_ORDER = [13, 44, 52, 11, 12, 14, 15, 16, 45, 9, 51, 50, 19, 18, 49, 10, 17, 48, 21];
const BACKGROUND_ORDER = [13, 44, 52, 11, 12, 14, 15, 16, 45, 49, 19, 18, 9, 51, 50, 10, 21, 17, 48];
/**
 * The Appearance settings the flags are drawn by (AppearancePanel): the active Colortag and Background orders, and
 * which things carry flags at all (stateSvc.CheckIfUpdateItem: ships, NPCs, drones and fighters, stations and
 * stargates; structures with Also apply to structures, on by default; the filter groups with Also apply to other
 * objects in space, off by default).
 */
let activeFlagOrder: readonly number[] = FLAG_ORDER;
let activeBackgroundOrder: readonly number[] = BACKGROUND_ORDER;
let applyToStructures = true;
let applyToOtherObjects = false;
let otherObjectGroups: ReadonlySet<number> = new Set([10, 12, 186, 340, 366, 411, 502, 517, 711, 1991]);
/** stateSvc.SetStateColor / SetStateBlink: the colours and blinks set per (where, flag), "flag:13" / "background:13". */
let stateColors: Readonly<Record<string, readonly number[]>> = {};
let stateBlinks: Readonly<Record<string, boolean>> = {};
export function setStateAppearance(a: { flag: readonly number[]; background: readonly number[]; applyStructures: boolean; applyOther: boolean; otherGroups?: readonly number[];
  colors?: Readonly<Record<string, readonly number[]>>; blinks?: Readonly<Record<string, boolean>> }): void {
  stateColors = a.colors ?? {};
  stateBlinks = a.blinks ?? {};
  activeFlagOrder = a.flag;
  activeBackgroundOrder = a.background;
  applyToStructures = a.applyStructures;
  applyToOtherObjects = a.applyOther;
  if (a.otherGroups) otherObjectGroups = new Set(a.otherGroups);
}
function isUpdateItem(category: number, group: number): boolean {
  if ([6, 11, 18, 87, 3].includes(category)) return true;
  if (applyToStructures && [23, 40, 65].includes(category)) return true;
  return group === 10 || (applyToOtherObjects && otherObjectGroups.has(group));
}
/** factionWarfare's combat enemies (IsMyCombatEnemyFaction): Caldari and Gallente, Amarr and Minmatar, Guristas and Angels. */
const FW_ENEMIES: Readonly<Record<number, number>> = { 500001: 500004, 500004: 500001, 500003: 500002, 500002: 500003, 500010: 500011, 500011: 500010 };
const OUTLAW_SECURITY_STATUS = -5;
/** idCheckers.IsCharacter as EveJS numbers them: a player character (90,000,000 and above, below the corporation and alliance ranges) or one of EveJS's own (140,000,000 and above). */
const isCharacter = (id: number | null | undefined): boolean => typeof id === "number" && ((id >= 90_000_000 && id < 98_000_000) || id >= 100_000_000);

/** war_cso.GetRelationship's warRelationshipAtWarCanFight: a war under way between the two, either side, or an ally's. */
function atWarCanFight(other: number, relations: OverviewRelationships): boolean {
  const own = relations.allianceID ?? relations.corporationID;
  if (own === null || other === own) return false;
  const { now } = relations;
  for (const war of relations.wars) {
    const opposing = war.declaredByID === own ? other : war.declaredByID === other ? own : null;
    if (opposing === null || !((war.timeStarted ?? 0n) < now && (war.timeFinished === null || now < war.timeFinished))) continue;
    if (opposing === war.againstID || war.allies.some((ally) => ally.allyID === opposing && ally.timeStarted !== null && ally.timeStarted < now &&
      ally.timeFinished !== null && now < ally.timeFinished)) return true;
  }
  return false;
}

/** addressbook.GetRelationship: the standings set between the pilot's sides and the thing's owner, corporation and alliance. */
function standingsWith(item: OverviewItem, relations: OverviewRelationships): number[] {
  if (!relations.contacts) return [];
  const out: number[] = [];
  for (const id of [item.ownerID, item.corporationID, item.allianceID]) {
    if (id == null) continue;
    for (const standings of [relations.contacts.personal, relations.contacts.corporate, relations.contacts.alliance]) {
      const s = standings.get(id);
      if (s !== undefined) out.push(s);
    }
  }
  return out;
}

/** stateSvc.Check<label> for the flags above. */
function flagHolds(flag: number, item: OverviewItem, group: number, category: number, relations: OverviewRelationships | undefined): boolean {
  const relevant = item.ownerID != null && item.ownerID !== 1 && !isNpcOwner(item.ownerID);
  const filtered = STATE_FILTERED_CATEGORIES.has(category);
  const charID = item.characterID ?? null;
  const security = item.securityStatus ?? 0;
  switch (flag) {
    case 21: return group === AGENT_IN_SPACE;
    case 9: return charID !== null && security <= OUTLAW_SECURITY_STATUS;
    case 10: return charID !== null && -0.1 > security && security >= OUTLAW_SECURITY_STATUS;
    case 11: case 12: case 14: case 45: case 49: case 15: case 16: return stateMatches(flag, item, group, category, relations);
    case 13: { const owner = item.allianceID ?? item.corporationID; return !!relations && owner != null && atWarCanFight(owner, relations); }
    case 44: return !!relations && relations.warFactionID != null && item.warFactionID != null && FW_ENEMIES[relations.warFactionID] === item.warFactionID;
    case 18: case 19: {
      if (!relevant || !filtered || !relations) return false;
      return standingsWith(item, relations).some((s) => (flag === 19 ? s < -5 : s < 0 && s >= -5));
    }
    case 17: {
      if (!relevant || !filtered || !relations) return false;
      const set = standingsWith(item, relations);
      const sameCorp = item.corporationID != null && item.corporationID === relations.corporationID;
      const sameAlliance = relations.allianceID !== null && item.allianceID === relations.allianceID;
      return set.length > 0 && set.every((s) => s === 0) && !sameCorp && !sameAlliance;
    }
    case 48: return (!relations || standingsWith(item, relations).length === 0) && isCharacter(item.ownerID) && filtered;
    // CheckSuspect / CheckCriminal / CheckLimitedEngagement: crimewatchSvc of the ship's pilot
    case 50: return charID !== null && !!relations?.suspects?.has(charID);
    case 51: return charID !== null && !!relations?.criminals?.has(charID);
    case 52: return charID !== null && !!relations?.engagedWith?.has(charID);
    default: return false;
  }
}

/**
 * stateSvc.GetIconAndBackgroundFlags (CheckStates 'flag' and 'background'): the first flag of each active order that
 * holds, null for none; a thing an NPC owns has none (OverviewScrollEntry.UpdateFlagAndBackground; the agent in space
 * excepted).
 */
export function iconAndBackgroundFlags(item: OverviewItem, groupID: number | null, relations?: OverviewRelationships): { icon: StateFlagLook | null; background: StateFlagLook | null } {
  const group = groupID ?? 0;
  const category = item.categoryID ?? 0;
  if (item.isSelf || !isUpdateItem(category, group)) return { icon: null, background: null };
  if (group !== AGENT_IN_SPACE && ((item.ownerID != null && isNpcOwner(item.ownerID)) || (item.characterID != null && isNpcOwner(item.characterID)))) return { icon: null, background: null };
  const first = (order: readonly number[]) => {
    const f = order.find((flag) => flagHolds(flag, item, group, category, relations));
    const look = f === undefined ? null : STATE_FLAG_LOOKS.get(f) ?? null;
    if (!look) return null;
    // GetStateFlagColor / GetStateBackgroundColor and the blinks: the set ones over the defaults
    return { ...look, flagColor: stateColors[`flag:${look.flag}`] ?? look.flagColor, backgroundColor: stateColors[`background:${look.flag}`] ?? look.backgroundColor,
      flagBlink: stateBlinks[`flag:${look.flag}`] ?? look.flagBlink, backgroundBlink: stateBlinks[`background:${look.flag}`] ?? look.backgroundBlink };
  };
  return { icon: first(activeFlagOrder), background: first(activeBackgroundOrder) };
}

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
