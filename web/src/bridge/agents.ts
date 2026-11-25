// Agent conversation / briefing / journal decoders (goal R4, "how to add a
// page"). The retail agent flow runs on the BFF (which holds the bound agent
// handle) and returns the raw retail-shaped marshaled results here; this module
// decodes them into plain rows for the store.
//
// Decoder rule (docs/bridge-wire-contract.md): mission rows carry long-encoded
// IDs and ISK/LP amounts. Numerics are decoded with unwrapLong — never the
// `typeof === "number" ? … : 0` pattern, which silently zeroes a {type:"long"}
// value. ISK amounts and FILETIMEs (which can exceed 2^53) are kept as decimal
// strings, not lossy Number.

import { unwrapLong, unwrapReal, type DictEntry, type JsonValue } from "./wire.ts";
import type {
  AgentAction,
  AgentConversation,
  AgentLastActionInfo,
  CourierBriefing,
  JournalMission,
  JournalResearch,
  JournalState,
  MissionSpot,
} from "../store/types.ts";

// Retail agent dialogue button constants (the client's appConst
// agentDialogueButton*, 1 to 19), the second value in each availableActions
// tuple. Exported so the UI can identify the Accept / Decline / Complete
// buttons without magic numbers.
export const AGENT_BUTTON = Object.freeze({
  VIEW_MISSION: 1,
  REQUEST_MISSION: 2,
  ACCEPT: 3,
  ACCEPT_CHOICE: 4,
  ACCEPT_REMOTELY: 5,
  COMPLETE: 6,
  COMPLETE_REMOTELY: 7,
  CONTINUE: 8,
  DECLINE: 9,
  DEFER: 10,
  QUIT: 11,
  START_RESEARCH: 12,
  CANCEL_RESEARCH: 13,
  BUY_DATACORES: 14,
  LOCATE_CHARACTER: 15,
  LOCATE_ACCEPT: 16,
  LOCATE_REJECT: 17,
  YES: 18,
  NO: 19,
});

const BUTTON_LABELS: Readonly<Record<number, string>> = Object.freeze({
  [AGENT_BUTTON.VIEW_MISSION]: "View Mission",
  [AGENT_BUTTON.REQUEST_MISSION]: "Request Mission",
  [AGENT_BUTTON.ACCEPT]: "Accept",
  [AGENT_BUTTON.ACCEPT_CHOICE]: "Accept",
  [AGENT_BUTTON.ACCEPT_REMOTELY]: "Accept Remotely",
  [AGENT_BUTTON.COMPLETE]: "Complete Mission",
  [AGENT_BUTTON.COMPLETE_REMOTELY]: "Complete Remotely",
  [AGENT_BUTTON.CONTINUE]: "Continue",
  [AGENT_BUTTON.DECLINE]: "Decline",
  [AGENT_BUTTON.DEFER]: "Defer",
  [AGENT_BUTTON.QUIT]: "Quit",
  [AGENT_BUTTON.START_RESEARCH]: "Start Research",
  [AGENT_BUTTON.CANCEL_RESEARCH]: "Cancel Research",
  [AGENT_BUTTON.BUY_DATACORES]: "Buy Datacores",
  [AGENT_BUTTON.LOCATE_CHARACTER]: "Locate Character",
  [AGENT_BUTTON.LOCATE_ACCEPT]: "Accept",
  [AGENT_BUTTON.LOCATE_REJECT]: "Reject",
  [AGENT_BUTTON.YES]: "Yes",
  [AGENT_BUTTON.NO]: "No",
});

export function agentButtonLabel(buttonType: number): string {
  return BUTTON_LABELS[buttonType] ?? `Action ${buttonType}`;
}


// --- marshaled-value helpers ----------------------------------------------

/**
 * Items of a {type:"tuple"} or {type:"list"} wrapper, or of a bare array; []
 * otherwise. The web gateway wraps a tuple; the game port gives it as an array.
 */
function seqItems(value: JsonValue | undefined): readonly JsonValue[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    const candidate = value as { type?: unknown; items?: unknown };
    if (
      (candidate.type === "tuple" || candidate.type === "list") &&
      Array.isArray(candidate.items)
    ) {
      return candidate.items as readonly JsonValue[];
    }
  }
  return [];
}

/** Entries of a {type:"dict"} or util.KeyVal wrapper; [] otherwise. */
function dictEntries(value: JsonValue | undefined): readonly DictEntry[] {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const candidate = value as { type?: unknown; name?: unknown; entries?: unknown; args?: unknown };
    if (candidate.type === "dict" && Array.isArray(candidate.entries)) {
      return candidate.entries as readonly DictEntry[];
    }
    if (candidate.type === "object" && candidate.name === "util.KeyVal") {
      return dictEntries(candidate.args as JsonValue);
    }
  }
  return [];
}

/** Read one key from a dict/KeyVal wrapper; undefined when absent. */
function readDict(value: JsonValue | undefined, key: string): JsonValue | undefined {
  const entry = dictEntries(value).find((pair) => Array.isArray(pair) && pair[0] === key);
  return entry ? entry[1] : undefined;
}

/** Decode an integer-ish numeric (plain or long); null when absent/malformed. */
function toNumber(value: JsonValue | undefined): number | null {
  const long = unwrapLong(value);
  return long === null ? null : Number(long);
}

/** Decode a possibly-fractional numeric (e.g. cargo volume); null when absent. */
function toFloat(value: JsonValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const long = unwrapLong(value);
  return long === null ? null : Number(long);
}

/** Keep an ISK amount / FILETIME as a bigint-safe decimal string; null if absent. */
function toDecimalString(value: JsonValue | undefined): string | null {
  const long = unwrapLong(value);
  return long === null ? null : long.toString();
}

function toBoolOrNull(value: JsonValue | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

// --- conversation ----------------------------------------------------------

/**
 * Decode a DoAction result:
 *   tuple( tuple(agentSays, availableActions), lastActionInfo )
 * where agentSays is tuple(message, contentID) — message being a string key, a
 * numeric briefing id, or a tuple(messageKey, substitutionDict) — and each
 * availableAction is tuple(actionID token, buttonType).
 */
export function decodeConversation(result: JsonValue): AgentConversation {
  const outer = seqItems(result);
  const inner = seqItems(outer[0]);
  const saysItems = seqItems(inner[0]);
  const firstSays = saysItems[0];
  let agentSays = "";
  let agentSaysWords: AgentConversation["agentSaysWords"] = null;
  if (typeof firstSays === "string") {
    agentSays = firstSays;
    agentSaysWords = { label: null, parameters: null, text: firstSays };
  } else if (typeof firstSays === "number") {
    // A message's number: agents.py ProcessMessage hands these to localization.GetByMessageID.
    agentSays = String(firstSays);
    if (Number.isSafeInteger(firstSays) && firstSays > 0) {
      agentSaysWords = { label: null, parameters: null, text: null, messageID: firstSays };
    }
  } else {
    // (label, {parameters}): agents.py ProcessMessage hands these to localization.GetByLabel.
    const nested = seqItems(firstSays);
    agentSays = typeof nested[0] === "string" ? nested[0] : "";
    if (typeof nested[0] === "string") {
      agentSaysWords = { label: nested[0], parameters: nested[1] ?? null, text: null };
    }
  }
  const actions: AgentAction[] = seqItems(inner[1]).map((entry) => {
    const items = seqItems(entry);
    const actionID = toNumber(items[0]) ?? 0;
    const buttonType = toNumber(items[1]) ?? 0;
    return { actionID, buttonType, label: agentButtonLabel(buttonType) };
  });
  const lastActionInfo = outer[1];
  return {
    agentSays,
    agentSaysWords,
    contentID: toNumber(saysItems[1]),
    actions,
    // An action whose data is a dict is one of the agent's special interactions, not a button
    // (agentDialogueWindow.GetBriefingHTML: type(actionData) == dict).
    specialInteractions: seqItems(inner[1]).some((entry) => dictEntries(seqItems(entry)[1]).length > 0),
    lastActionInfo: {
      missionCompleted: toBoolOrNull(readDict(lastActionInfo, "missionCompleted")),
      missionDeclined: toBoolOrNull(readDict(lastActionInfo, "missionDeclined")),
      missionQuit: toBoolOrNull(readDict(lastActionInfo, "missionQuit")),
      missionCantReplay: toNumber(readDict(lastActionInfo, "missionCantReplay")),
      loyaltyPoints: toNumber(readDict(lastActionInfo, "loyaltyPoints")),
    },
  };
}

/**
 * Whether the conversation is offering a mission that has not been taken: one of the accept buttons is
 * among what the agent offers.
 */
export function offerOpen(conversation: AgentConversation | null): boolean {
  return (conversation?.actions ?? []).some(
    (action) =>
      action.buttonType === AGENT_BUTTON.ACCEPT ||
      action.buttonType === AGENT_BUTTON.ACCEPT_CHOICE ||
      action.buttonType === AGENT_BUTTON.ACCEPT_REMOTELY,
  );
}

/**
 * appConst.agentMission*: what the server says happened between a pilot and an agent, the first
 * argument of OnAgentMissionChange(action, agentID). These are the ones the window acts on.
 */
export const AGENT_MISSION = Object.freeze({
  MODIFIED: "modified",
  OFFER_REMOVED: "offer_removed",
  RESET: "reset",
  TALK_TO_COMPLETED: "talk_to_completed",
} as const);

/** OnAgentMissionChange as the server pushes it. An agent of none means every agent. */
export interface MissionChange {
  readonly action: string;
  readonly agentID: number | null;
}

/**
 * What the retail client's agents service knows of one agent (agents.GetAgentByID): its row of the server's
 * agents table, with the faction of its corporation added from the client's own data, and here the number
 * of the message its division's name is (npcs/divisions.py).
 */
export interface AgentRecord {
  readonly agentID: number;
  readonly agentTypeID: number | null;
  readonly divisionID: number | null;
  readonly level: number | null;
  readonly stationID: number | null;
  readonly corporationID: number | null;
  readonly factionID: number | null;
  readonly divisionNameID: number | null;
  /** The solar system of the agent's station, as the client's row has it (agents.py 96 to 105); null for none. */
  readonly solarSystemID?: number | null;
}

/** A record as the BFF answers it (GET /api/bridge/agents/<id>/record), or null for anything that is not one. */
export function decodeAgentRecord(value: unknown): AgentRecord | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const whole = (given: unknown): number | null => (typeof given === "number" && Number.isSafeInteger(given) && given > 0 ? given : null);
  const agentID = whole(row.agentID);
  if (agentID === null) {
    return null;
  }
  return {
    agentID,
    agentTypeID: whole(row.agentTypeID),
    divisionID: whole(row.divisionID),
    level: whole(row.level),
    stationID: whole(row.stationID),
    corporationID: whole(row.corporationID),
    factionID: whole(row.factionID),
    divisionNameID: whole(row.divisionNameID),
    solarSystemID: whole(row.solarSystemID),
  };
}

/** Reads a pushed OnAgentMissionChange(action, agentID). Null for any other notification. */
export function decodeMissionChange(method: string | null, args: readonly unknown[]): MissionChange | null {
  const action = args[0];
  if (method !== "OnAgentMissionChange" || typeof action !== "string") {
    return null;
  }
  const agentID = toNumber(args[1] as JsonValue | undefined);
  return { action, agentID: agentID !== null && agentID > 0 ? agentID : null };
}

/**
 * What the window open on an agent does when the server says a mission changed.
 *
 * agents.py OnAgentMissionChange (688): the offer was taken away, the mission was reset, or the talk it
 * asked for is done, and the window on that agent closes. agentDialogueWindow.OnAgentMissionChange
 * (86): the mission was modified, and the window talks to its agent again. Anything else, and anything
 * about another agent, leaves the window as it is.
 */
export function windowOnMissionChange(change: MissionChange, openAgentID: number | null): "close" | "again" | "stay" {
  if (openAgentID === null || change.agentID !== openAgentID) {
    return "stay";
  }
  if (
    change.action === AGENT_MISSION.OFFER_REMOVED ||
    change.action === AGENT_MISSION.RESET ||
    change.action === AGENT_MISSION.TALK_TO_COMPLETED
  ) {
    return "close";
  }
  return change.action === AGENT_MISSION.MODIFIED ? "again" : "stay";
}

/** appConst.agentTypeResearchAgent. */
export const AGENT_TYPE_RESEARCH = 4;
/** appConst.agentTypeCareerAgent. */
export const AGENT_TYPE_CAREER = 12;

/**
 * agentDialogueWindow._GetConversation: what the client's window does by itself as it opens. If the
 * first thing the agent offers is to request a mission or to view one, the window presses that at once
 * and shows what comes of it, unless the agent has other business as well: a locator agent (it offers
 * to locate a character) or a research agent, with more than that one thing on offer.
 *
 * Returns the action to press, or null. The client always knows what kind of agent it is talking to;
 * where that is not known here, the action is pressed only when it is the only one.
 */
export function openingAction(conversation: AgentConversation, agentTypeID: number | null): AgentAction | null {
  const first = conversation.actions[0];
  if (!first || (first.buttonType !== AGENT_BUTTON.REQUEST_MISSION && first.buttonType !== AGENT_BUTTON.VIEW_MISSION)) {
    return null;
  }
  if (conversation.actions.length === 1) {
    return first;
  }
  const locator = conversation.actions.some((action) => action.buttonType === AGENT_BUTTON.LOCATE_CHARACTER);
  return !locator && agentTypeID !== null && agentTypeID !== AGENT_TYPE_RESEARCH ? first : null;
}

/**
 * agentDialogueWindow.GetObjectiveHTML: whether the mission's objectives are shown beside what the agent
 * says. They are read for every layout, and shown unless the last action completed the mission, declined
 * it, quit it, or was answered with "not yet".
 */
export function objectivesShown(info: AgentLastActionInfo): boolean {
  return !(info.missionCompleted || info.missionDeclined || info.missionQuit || info.missionCantReplay);
}

/** The Accept button in a conversation, if the agent is offering one. */
export function findAcceptAction(
  conversation: AgentConversation | null,
): AgentAction | null {
  if (!conversation) {
    return null;
  }
  return (
    conversation.actions.find((action) => action.buttonType === AGENT_BUTTON.ACCEPT) ?? null
  );
}

// --- briefing --------------------------------------------------------------

/**
 * Decode the courier briefing from GetMissionObjectiveInfo (the authoritative
 * transport objective: pickup, dropoff, cargo, rewards, LP) plus
 * GetMissionBriefingInfo (title, accept/expiration FILETIMEs, and a Mission
 * Keywords summary used as a fallback). Returns null when neither read carried a
 * transport objective (no accepted courier).
 */
export function decodeBriefing(
  briefingResult: JsonValue,
  objectiveResult: JsonValue,
): CourierBriefing | null {
  const objectives = seqItems(readDict(objectiveResult, "objectives"));
  const transport = objectives
    .map((entry) => seqItems(entry))
    .find((items) => items[0] === "transport" || items[0] === "fetch");
  const transportInner = transport ? seqItems(transport[1]) : [];
  // [issuerID, pickupDict, issuerID, dropoffDict, cargoDict]
  const pickup = transportInner[1];
  const dropoff = transportInner[3];
  const cargo = transportInner[4];
  const keywords = readDict(briefingResult, "Mission Keywords");

  const iskAmounts = seqItems(readDict(objectiveResult, "normalRewards"))
    .map((entry) => seqItems(entry))
    .filter((items) => toNumber(items[0]) === 29)
    .map((items) => items[1]);
  const bonusAmounts = seqItems(readDict(objectiveResult, "bonusRewards"))
    .map((entry) => seqItems(entry))
    .filter((items) => toNumber(items[0]) === 29)
    .map((items) => items[1]);

  const hasObjective = transport !== undefined;
  const hasKeywords = dictEntries(keywords).length > 0;
  if (!hasObjective && !hasKeywords) {
    return null;
  }

  return {
    missionTitleID:
      toNumber(readDict(objectiveResult, "missionTitleID")) ??
      toNumber(readDict(briefingResult, "Mission Title ID")),
    cargoTypeID:
      toNumber(readDict(cargo, "typeID")) ??
      toNumber(readDict(keywords, "objectiveTypeID")),
    cargoQuantity:
      toNumber(readDict(cargo, "quantity")) ??
      toNumber(readDict(keywords, "objectiveQuantity")),
    cargoVolume: toFloat(readDict(cargo, "volume")),
    pickupLocationID:
      toNumber(readDict(pickup, "locationID")) ??
      toNumber(readDict(keywords, "objectiveLocationID")),
    pickupSystemID:
      toNumber(readDict(pickup, "solarsystemID")) ??
      toNumber(readDict(keywords, "objectiveLocationSystemID")),
    destinationLocationID:
      toNumber(readDict(dropoff, "locationID")) ??
      toNumber(readDict(keywords, "objectiveDestinationID")),
    destinationSystemID:
      toNumber(readDict(dropoff, "solarsystemID")) ??
      toNumber(readDict(keywords, "objectiveDestinationSystemID")),
    rewardISK:
      toDecimalString(iskAmounts[0]) ?? toDecimalString(readDict(keywords, "rewardQuantity")),
    bonusISK: toDecimalString(bonusAmounts[0] ?? iskAmounts[1]),
    loyaltyPoints: toNumber(readDict(objectiveResult, "loyaltyPoints")),
    expirationTime: toDecimalString(readDict(briefingResult, "Expiration Time")),
    acceptTimestamp: toDecimalString(readDict(briefingResult, "AcceptTimestamp")),
  };
}

// --- journal ---------------------------------------------------------------

/**
 * A mission's marked spot, as the client's menu takes one to be the agent's to warp to: it has an agent, and a
 * location's number (movementFunctions.py 414). One with no type to ask the agent by is none either.
 */
function decodeMissionSpot(value: JsonValue): MissionSpot | null {
  const agentID = toNumber(readDict(value, "agentID"));
  const locationType = readDict(value, "locationType");
  const locationNumber = toNumber(readDict(value, "locationNumber"));
  if (!agentID || typeof locationType !== "string" || locationType === "" || locationNumber === null) {
    return null;
  }
  const isAgentBase = readDict(value, "isAgentBase");
  const hint = readDict(value, "hint");
  const created = unwrapLong(readDict(value, "created"));
  const coordinate = (key: string): number | null => {
    const raw = readDict(value, key);
    return raw === null || raw === undefined ? null : (unwrapReal(raw) ?? toFloat(raw));
  };
  const deadspace = readDict(value, "deadspace");
  return {
    agentID,
    locationType,
    locationNumber,
    solarSystemID: toNumber(readDict(value, "solarsystemID")),
    isAgentBase: isAgentBase === true || isAgentBase === 1,
    itemID: toNumber(readDict(value, "itemID")),
    typeID: toNumber(readDict(value, "typeID")),
    locationID: toNumber(readDict(value, "locationID")),
    hint: typeof hint === "string" ? hint : hint !== null && typeof hint === "object" && !Array.isArray(hint) && typeof (hint as { value?: unknown }).value === "string" ? (hint as { value: string }).value : "",
    created: created !== null && created > 0n ? created : null,
    x: coordinate("x"),
    y: coordinate("y"),
    z: coordinate("z"),
    deadspace: deadspace === true || deadspace === 1,
    referringAgentID: toNumber(readDict(value, "referringAgentID")),
  };
}

function decodeJournalRow(row: JsonValue): JournalMission {
  // As the client unpacks it (journal.py 686): [missionState, importantMission,
  //  missionTypeLabel, missionNameID, agentID, expirationTime, bookmarks,
  //  remoteOfferable, remoteCompletable, contentID]. The name is a message's
  //  number, or text.
  const items = seqItems(row);
  return {
    missionState: toNumber(items[0]),
    importantMission: items[1] === true || items[1] === 1,
    missionTypeLabel: typeof items[2] === "string" ? items[2] : null,
    missionTitleID: typeof items[3] === "string" ? null : toNumber(items[3]),
    missionTitle: typeof items[3] === "string" ? items[3] : null,
    agentID: toNumber(items[4]),
    expirationTime: toDecimalString(items[5]),
    missionID: toNumber(items[9]),
    remoteCompletable: items[8] === true || items[8] === 1,
    bookmarks: seqItems(items[6]).map(decodeMissionSpot).filter((spot): spot is MissionSpot => spot !== null),
  };
}

// Retail mission-state values (agentMissionRuntime.js), the journal row's
// missionState (item[0]): 1=Offered, 2=Accepted, 4=Completed, 7=CantReplay.
export const AGENT_MISSION_STATE = Object.freeze({
  OFFERED: 1,
  ACCEPTED: 2,
  COMPLETED: 4,
  CANT_REPLAY: 7,
});

/**
 * Decode GetMyJournalDetails: tuple(missions, research). The mission state
 * distinguishes active missions from offers within the first bucket.
 */
export function decodeJournal(result: JsonValue): JournalState {
  const buckets = seqItems(result);
  const rows = seqItems(buckets[0]).map(decodeJournalRow);
  const research: JournalResearch[] = [];
  for (const entry of seqItems(buckets[1])) {
    const fields = seqItems(entry);
    const agentID = toNumber(fields[0]);
    const fieldTypeID = toNumber(fields[1]);
    const pointsPerDay = unwrapReal(fields[2]);
    const currentPoints = unwrapReal(fields[3]);
    const level = toNumber(fields[4]);
    const stationID = toNumber(fields[6]);
    if (agentID && fieldTypeID && pointsPerDay !== null && currentPoints !== null && level !== null && stationID) {
      research.push({ agentID, fieldTypeID, pointsPerDay, currentPoints, level, stationID });
    }
  }
  return {
    active: rows.filter((row) => row.missionState !== AGENT_MISSION_STATE.OFFERED),
    offered: rows.filter((row) => row.missionState === AGENT_MISSION_STATE.OFFERED),
    ...(research.length ? { research } : {}),
  };
}
