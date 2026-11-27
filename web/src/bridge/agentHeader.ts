// The agent's header at the top of its own window, as the retail client writes it.
//
// agentDialogueWindow.GetBriefingHTML (232 to 249) begins what the agent says with GetAgentHeader (274 to 279):
// GetAgentLocationWrap() on the agent's object, asked afresh for every layout, and the loyalty points the last
// action's info carries; agentDialogueUtil.GetAgentLocationHeader (476 to 502) lays them out:
//
//   the agent's portrait, its name and a Show Info link;
//   "Division: <the division's name>" (UI/Agents/Dialogue/Division);
//   where the agent is, written by LocationWrapper (the system's rating, the place's name, a warning);
//   the pilot's effective standing with the agent: its faction's, its corporation's and its own standings towards
//   the pilot, each raised by the skill, the least of them where it is -2.0 or worse, else the greatest
//   (UI/Agents/Dialogue/EffectiveStanding and its Low form, the number in bold);
//   the loyalty points, where the last action's info says some (UI/Agents/Dialogue/LoyaltyPointsTableRow).
//
// GetAgentLocationWrap returns the place's type, its solar system and the place itself.

import { formatTemplate, plainText } from "./clientWords.ts";
import type { AgentRecord } from "./agents.ts";
import { effectiveStandingWithAgent } from "./effectiveStanding.ts";
import { LOCATION_WORD_LABELS, wrapLocationRuns, type PlaceRun } from "./locationWrapper.ts";
import type { NameKind } from "../store/names.ts";
import { readDictEntry, type JsonValue } from "./wire.ts";

export const AGENT_HEADER_LABELS = Object.freeze({
  /** Takes divisionName. */
  division: "UI/Agents/Dialogue/Division",
  /** Each takes effectiveStanding: the second when it is the least of the pilot's standings that counts. */
  effectiveStanding: "UI/Agents/Dialogue/EffectiveStanding",
  effectiveStandingLow: "UI/Agents/Dialogue/EffectiveStandingLow",
  /** Takes loyaltyPoints. */
  loyaltyPoints: "UI/Agents/Dialogue/LoyaltyPointsTableRow",
});
export const AGENT_HEADER_WORD_LABELS: readonly string[] = [...Object.values(AGENT_HEADER_LABELS), ...LOCATION_WORD_LABELS];

/** Where the agent is, as GetAgentLocationWrap answers it. */
export interface AgentLocationWrap {
  readonly locationID: number;
  readonly solarSystemID: number | null;
  readonly typeID: number | null;
}

const idOf = (value: JsonValue | undefined): number | null => {
  const id = typeof value === "number" ? value
    : value !== null && typeof value === "object" && !Array.isArray(value) && (value as { type?: unknown }).type === "long" ? Number((value as { value?: unknown }).value)
    : Number.NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

/** GetAgentLocationWrap's dict; null for an answer that names no place. */
export function decodeAgentLocationWrap(value: JsonValue | undefined): AgentLocationWrap | null {
  const locationID = idOf(readDictEntry(value, "locationID"));
  return locationID === null ? null : { locationID, solarSystemID: idOf(readDictEntry(value, "solarsystemID")), typeID: idOf(readDictEntry(value, "typeID")) };
}

export interface AgentHeader {
  readonly name: string;
  readonly division: string | null;
  /** Where the agent is, wrapped as LocationWrapper wraps it; null while the window has not been told. */
  readonly location: readonly PlaceRun[];
  /** In the client's words; null until the agent's record and the pilot's standings and skills are all to hand. */
  readonly standing: string | null;
  /** Whether the standing is a low one (the client writes the number in bold). */
  readonly standingLow: boolean;
  readonly loyaltyPoints: string | null;
}

export interface AgentHeaderInput {
  readonly agentID: number;
  /** What the client's agents service knows of the agent; null before it has answered. */
  readonly record: AgentRecord | null;
  readonly location: AgentLocationWrap | null;
  /** lastActionInfo's loyaltyPoints. */
  readonly loyaltyPoints: number | null;
  /** The standings the server lists towards the pilot, by owner; null before they have been read. */
  readonly standings: ReadonlyMap<number, number> | null;
  /** The level the pilot has in a skill, nought for one it has not; null before its skills have been read. */
  readonly skillLevel: ((typeID: number) => number) | null;
}

export interface AgentHeaderContext {
  readonly templates: Readonly<Record<string, string | null | undefined>>;
  readonly nameOf: (kind: NameKind, id: number) => string;
  /** A message with nothing filled in (a division's name); null when it cannot be had. */
  readonly messageText: (messageID: number) => string | null;
  readonly securityOf: (solarSystemID: number) => number | null;
  readonly ownSecurityStatus?: () => number | null;
}

function placeKind(id: number): NameKind {
  if (id >= 30_000_000 && id < 40_000_000) return "system";
  if (id >= 60_000_000 && id < 64_000_000) return "station";
  return "structure";
}

/** The place's name the header asks for (cfg.evelocations, by the kind of place it is). */
export function agentLocationNameRef(location: AgentLocationWrap): { readonly kind: NameKind; readonly id: number } {
  return { kind: placeKind(location.locationID), id: location.locationID };
}

/** The text and location runs in GetAgentLocationHeader. */
export function agentHeader(input: AgentHeaderInput, context: AgentHeaderContext): AgentHeader {
  const words = (label: string, args: Record<string, string | number>): string | null => {
    const template = context.templates[label];
    return typeof template === "string" ? plainText(formatTemplate(template, args, { nameOf: context.nameOf })).trim() : null;
  };
  const record = input.record;
  const divisionName = record === null || record.divisionNameID === null ? null : context.messageText(record.divisionNameID);
  const location = input.location;
  const placeName = location === null ? "" : context.nameOf(placeKind(location.locationID), location.locationID);
  const placeLink = location?.typeID == null ? null : { typeID: location.typeID, itemID: location.locationID };
  const effective = record === null || input.standings === null || input.skillLevel === null ? null : effectiveStandingWithAgent(record, input.standings, input.skillLevel);
  return {
    name: context.nameOf("owner", input.agentID),
    division: divisionName === null ? null : words(AGENT_HEADER_LABELS.division, { divisionName }),
    location: location === null ? [] : wrapLocationRuns(placeName, location.solarSystemID, context.templates,
      context.securityOf, context.ownSecurityStatus, placeLink) ?? [{ text: placeName, ...(placeLink ? { link: placeLink } : {}) }],
    standing: effective === null ? null : words(effective.low ? AGENT_HEADER_LABELS.effectiveStandingLow : AGENT_HEADER_LABELS.effectiveStanding, { effectiveStanding: effective.value }),
    standingLow: effective !== null && effective.low,
    // "if loyaltyPoints:": none, or nought, says nothing.
    loyaltyPoints: input.loyaltyPoints ? words(AGENT_HEADER_LABELS.loyaltyPoints, { loyaltyPoints: input.loyaltyPoints }) : null,
  };
}
