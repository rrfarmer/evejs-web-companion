// A mission's objectives, as the agent's window reads them.
//
// The right-hand pane of the retail client's agent window is built from one answer, agentMgr
// GetMissionObjectiveInfo, by agentDialogueUtil.GetMissionObjectiveHTML (282 to 407). This reads that
// answer whole, for a mission of any kind:
//
//   objectives   (kind, data) pairs: "transport" (a courier's pickup, dropoff and cargo), "fetch" (bring
//                something to a place), "agent" (go and speak with another agent)
//   dungeons     the places to fight or mine in, each with its own words, state and location
//   and around them the mission's name and state, what the agent hands over, what is paid and what is
//   paid for being quick, the collateral, and the systems on the way.
//
// Nothing here is worded: missionObjectivePane.ts lays it out in the client's order with the client's
// labels. Both transports are read: a tuple is wrapped by the web gateway and a bare array from the
// game port.

import { readDictEntry, unwrapLong, unwrapReal, type JsonValue } from "./wire.ts";

/** A place as the server describes one (agentDialogueUtil.LocationWrapper reads these). */
export interface MissionLocation {
  readonly locationID: number | null;
  readonly solarsystemID: number | null;
  readonly typeID: number | null;
  readonly locationType: string | null;
  readonly bookmark?: { readonly coordinates: readonly number[]; readonly agentID: number; readonly referringAgentID: number | null };
  /** A ship in space to go to, by its type (the client words the place by it). */
  readonly shipTypeID: number | null;
}

export interface MissionCargo {
  readonly typeID: number | null;
  readonly quantity: number | null;
  readonly volume: number | null;
  readonly hasCargo: boolean;
}

export type MissionObjective =
  | { readonly kind: "agent"; readonly agentID: number | null; readonly location: MissionLocation | null }
  | {
      readonly kind: "transport";
      readonly pickupOwnerID: number | null;
      readonly pickup: MissionLocation | null;
      readonly dropoffOwnerID: number | null;
      readonly dropoff: MissionLocation | null;
      readonly cargo: MissionCargo | null;
    }
  | { readonly kind: "fetch"; readonly dropoffOwnerID: number | null; readonly dropoff: MissionLocation | null; readonly cargo: MissionCargo | null };

/** What the agent says of a dungeon: a message's number, a label with its arguments, or plain text. */
export interface MissionMessage {
  readonly messageID: number | null;
  readonly label: string | null;
  readonly parameters: JsonValue | null;
  readonly text: string | null;
  /** The mission the message is about, for the keywords the client fills it with; null where it names none. */
  readonly contentID: number | null;
}

export interface MissionDungeon {
  readonly dungeonID: number | null;
  readonly optional: boolean;
  /** Present once the dungeon is over: 1 completed, 0 failed. Null while it is not. */
  readonly completionStatus: 0 | 1 | null;
  /** The objective's own mark: 1 done, 0 failed, null not yet. */
  readonly objectiveCompleted: 0 | 1 | null;
  readonly briefingMessage: MissionMessage | null;
  readonly ownerID: number | null;
  readonly location: MissionLocation | null;
  /** 0 ordinary restrictions on ships, 1 special ones; null when the server names none. */
  readonly shipRestrictions: 0 | 1 | null;
}

/** Something handed over, paid or held: a type and how many. ISK is the type appConst.typeCredits. */
export interface MissionItem {
  readonly typeID: number | null;
  /** A decimal string: an ISK amount can be more than a number holds. */
  readonly quantity: string;
  readonly specificItem: boolean;
  readonly blueprint: boolean;
}

export interface MissionBonus extends MissionItem {
  /** The game's time left to earn it; nought or less when the time has passed. */
  readonly timeRemaining: bigint;
  readonly timeBonusIntervalMin: number | null;
}

export interface MissionObjectives {
  readonly importantStandings: boolean;
  readonly missionTitleID: number | null;
  /** The name as text, where the server sends text and not a message's number. */
  readonly missionTitle: string | null;
  /** 0 not finished, 1 finished, 2 finished by a game master's hand. */
  readonly completionStatus: number;
  readonly missionState: number | null;
  readonly contentID: number | null;
  readonly objectives: readonly MissionObjective[];
  readonly dungeons: readonly MissionDungeon[];
  /** The solar systems the mission goes through, in order. */
  readonly locations: readonly number[];
  readonly agentGift: readonly MissionItem[];
  readonly normalRewards: readonly MissionItem[];
  readonly loyaltyPoints: number;
  readonly researchPoints: number;
  readonly bonusRewards: readonly MissionBonus[];
  readonly collateral: readonly MissionItem[];
  /** A further heading and text of the mission's own, as two messages. */
  readonly missionExtra: { readonly headerID: number | null; readonly bodyID: number | null } | null;
}

/** appConst: ISK as a type, and a mission that failed. */
export const TYPE_CREDITS = 29;
export const AGENT_MISSION_STATE_FAILED = 3;

type Value = JsonValue | undefined;

/** The items of a tuple or a list, wrapped or bare; [] for anything else. */
function items(value: Value): readonly JsonValue[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    const wrapped = value as { type?: unknown; items?: unknown };
    if ((wrapped.type === "tuple" || wrapped.type === "list") && Array.isArray(wrapped.items)) {
      return wrapped.items as readonly JsonValue[];
    }
  }
  return [];
}

const isDict = (value: Value): boolean => typeof value === "object" && value !== null && !Array.isArray(value) && (value as { type?: unknown }).type === "dict";
const read = (value: Value, key: string): Value => readDictEntry(value, key);
const has = (value: Value, key: string): boolean => read(value, key) !== undefined;

/** A whole number, or null. */
function integer(value: Value): number | null {
  const long = unwrapLong(value);
  return long === null ? null : Number(long);
}

/** Any number, whole or not, or null. */
function real(value: Value): number | null {
  const number = unwrapReal(value);
  return number === null ? integer(value) : number;
}

/** A mark the server sends as 1, 0, true, false or None. */
function mark(value: Value): 0 | 1 | null {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  return null;
}

function location(value: Value): MissionLocation | null {
  if (!isDict(value)) {
    return null;
  }
  const locationType = read(value, "locationType");
  const coordinates = items(read(value, "coords")).map(real);
  const agentID = integer(read(value, "agentID"));
  const bookmark = agentID !== null && coordinates.length === 3 &&
    coordinates.every((coordinate): coordinate is number => coordinate !== null && Number.isFinite(coordinate))
    ? { coordinates, agentID, referringAgentID: integer(read(value, "referringAgentID")) }
    : null;
  return {
    locationID: integer(read(value, "locationID")),
    solarsystemID: integer(read(value, "solarsystemID")),
    typeID: integer(read(value, "typeID")),
    locationType: typeof locationType === "string" ? locationType : null,
    shipTypeID: integer(read(value, "shipTypeID")),
    ...(bookmark ? { bookmark } : {}),
  };
}

function cargo(value: Value): MissionCargo | null {
  if (!isDict(value)) {
    return null;
  }
  const hasCargo = read(value, "hasCargo");
  return {
    typeID: integer(read(value, "typeID")),
    quantity: integer(read(value, "quantity")),
    volume: real(read(value, "volume")),
    hasCargo: hasCargo === true || hasCargo === 1,
  };
}

function objective(entry: JsonValue): MissionObjective | null {
  const [kind, data] = items(entry);
  const parts = items(data);
  if (kind === "agent") {
    return { kind, agentID: integer(parts[0]), location: location(parts[1]) };
  }
  if (kind === "transport") {
    return { kind, pickupOwnerID: integer(parts[0]), pickup: location(parts[1]), dropoffOwnerID: integer(parts[2]), dropoff: location(parts[3]), cargo: cargo(parts[4]) };
  }
  if (kind === "fetch") {
    return { kind, dropoffOwnerID: integer(parts[0]), dropoff: location(parts[1]), cargo: cargo(parts[2]) };
  }
  // A kind the client's window does not draw either.
  return null;
}

/**
 * A message as agents.py ProcessMessage (640 to 672) takes one: plain text, or a pair of what to say and
 * the mission it is about, where what to say is text, a message's number, or (label, arguments).
 */
function message(value: Value): MissionMessage | null {
  if (typeof value === "string") {
    return { messageID: null, label: null, parameters: null, text: value, contentID: null };
  }
  const pair = items(value);
  if (pair.length !== 2) {
    return null;
  }
  const [what, content] = pair;
  const contentID = integer(content);
  if (typeof what === "string") {
    return { messageID: null, label: null, parameters: null, text: what, contentID };
  }
  const labelled = items(what);
  if (labelled.length === 2 && typeof labelled[0] === "string") {
    return { messageID: null, label: labelled[0], parameters: labelled[1] ?? null, text: null, contentID };
  }
  const number = integer(what);
  return number !== null && number > 0 ? { messageID: number, label: null, parameters: null, text: null, contentID } : null;
}

function dungeon(value: JsonValue): MissionDungeon | null {
  if (!isDict(value)) {
    return null;
  }
  const optional = read(value, "optional");
  return {
    dungeonID: integer(read(value, "dungeonID")),
    optional: optional === true || optional === 1,
    completionStatus: has(value, "completionStatus") ? mark(read(value, "completionStatus")) : null,
    objectiveCompleted: mark(read(value, "objectiveCompleted")),
    briefingMessage: has(value, "briefingMessage") ? message(read(value, "briefingMessage")) : null,
    ownerID: integer(read(value, "ownerID")),
    location: location(read(value, "location")),
    shipRestrictions: has(value, "shipRestrictions") ? mark(read(value, "shipRestrictions")) : null,
  };
}

/** (typeID, quantity, extra); kept only for a quantity above nought, as the client keeps them. */
function item(typeID: Value, quantity: Value, extra: Value): MissionItem | null {
  const amount = unwrapLong(quantity) ?? (real(quantity) === null ? null : BigInt(Math.trunc(real(quantity) as number)));
  if (amount === null || amount <= 0n) {
    return null;
  }
  return {
    typeID: integer(typeID),
    quantity: amount.toString(),
    specificItem: Boolean(integer(read(extra, "specificItemID"))),
    blueprint: isDict(read(extra, "blueprintInfo")),
  };
}

const itemsOf = (value: Value): MissionItem[] =>
  items(value).map((entry) => { const [typeID, quantity, extra] = items(entry); return item(typeID, quantity, extra); }).filter((each): each is MissionItem => each !== null);

function bonuses(value: Value): MissionBonus[] {
  const out: MissionBonus[] = [];
  for (const entry of items(value)) {
    const [timeRemaining, typeID, quantity, extra, interval] = items(entry);
    const paid = item(typeID, quantity, extra);
    if (paid !== null) {
      out.push({ ...paid, timeRemaining: unwrapLong(timeRemaining) ?? 0n, timeBonusIntervalMin: integer(interval) });
    }
  }
  return out;
}

/** Reads GetMissionObjectiveInfo's answer. Null when there is none: no mission with this agent. */
export function decodeObjectives(result: Value): MissionObjectives | null {
  if (!isDict(result)) {
    return null;
  }
  const title = read(result, "missionTitleID");
  const contentID = integer(read(result, "contentID"));
  const extra = items(read(result, "missionExtra"));
  const importantStandings = read(result, "importantStandings");
  return {
    importantStandings: importantStandings === true || (integer(importantStandings) ?? 0) !== 0,
    missionTitleID: typeof title === "string" ? null : integer(title),
    missionTitle: typeof title === "string" ? title : null,
    completionStatus: integer(read(result, "completionStatus")) ?? 0,
    missionState: integer(read(result, "missionState")),
    contentID,
    objectives: items(read(result, "objectives")).map(objective).filter((each): each is MissionObjective => each !== null),
    dungeons: items(read(result, "dungeons")).map(dungeon).filter((each): each is MissionDungeon => each !== null),
    locations: items(read(result, "locations")).map((each) => integer(each)).filter((each): each is number => each !== null && each > 0),
    agentGift: itemsOf(read(result, "agentGift")),
    normalRewards: itemsOf(read(result, "normalRewards")),
    loyaltyPoints: integer(read(result, "loyaltyPoints")) ?? 0,
    researchPoints: real(read(result, "researchPoints")) ?? 0,
    bonusRewards: bonuses(read(result, "bonusRewards")),
    collateral: itemsOf(read(result, "collateral")),
    missionExtra: extra.length === 2 ? { headerID: integer(extra[0]), bodyID: integer(extra[1]) } : null,
  };
}

/** The pane's heading, by the mission's state (GetMissionObjectiveHTML, 291 to 302). */
export function objectivesHeading(objectives: MissionObjectives): "failed" | "complete" | "open" {
  if (objectives.missionState === AGENT_MISSION_STATE_FAILED) {
    return "failed";
  }
  return objectives.completionStatus > 0 ? "complete" : "open";
}
