// The calendar reads, decoded to plain event/response records (goal R59,
// PLUMBING ONLY — no UI).
//
// GET /api/bridge/calendar returns four raw retail-shaped results across two
// services (calendarMgr + the TOP-LEVEL calendarProxy). Captured live from Farmer
// (character 140000005) on 2026-07-22:
//
//   • responsesForCharacter = calendarMgr.GetResponsesForCharacter()
//       -> {type:"list", items:[util.KeyVal{eventID, status}, ...]}. EMPTY live
//          (Farmer has responded to nothing) — a REAL empty state.
//   • eventList = calendarProxy.GetEventList(month, year)
//       -> [ {type:"list", items:[<event-row KeyVal>, ...]}, null, null ]: a
//          3-TUPLE whose FIRST element is the month's events. Live for 2026-07
//          carried one real event ("Make a wish", eventID 980000000006, ownerID 1).
//   • responsesToEvent = calendarMgr.GetResponsesToEvent(eventID[, ownerID])
//       -> {type:"list", items:[util.KeyVal{characterID, status}, ...]}. Empty
//          live for that event (no one responded).
//   • eventDetails = calendarProxy.GetEventDetails(eventID, ownerID)
//       -> util.KeyVal{eventText, creatorID}. Live: {eventText:"The clock reads
//          11:11 — make a wish.", creatorID:1}. ⚠ With no eventID (the default 0)
//          the handler REFUSES ("no such event") — the route reports that as this
//          read's error code, not a failure, and eventDetails is null.
//
// One event row (from GetEventList), live-captured:
//   util.KeyVal{eventID, ownerID, eventDateTime(long), eventDuration, eventTitle,
//     importance, dateModified(long), isDeleted, flag, autoEventType}.
//
// ⚠ eventDateTime / dateModified are FILETIME longs (bigint). R7d: ownerID /
// creatorID / characterID / eventID stay as plain numeric fields for a future UI
// to resolve — never forced into a label, never dropped.

import { filetimeToUnixMs, unixMsToFiletime } from "./activity.ts";
import {
  isKeyValValue,
  isListValue,
  readKeyVal,
  readPlainJsonField,
  unwrapLong,
  type JsonValue,
} from "./wire.ts";

export const CALENDAR_TITLE_LIMIT = 40;
export const CALENDAR_DESCRIPTION_LIMIT = 500;
export const CALENDAR_INVITEE_LIMIT = 50;
export const CALENDAR_MONTH_RANGE = 12;
export const CALENDAR_CREATE_METHODS = {
  personal: "CreatePersonalEvent", corporation: "CreateCorporationEvent", alliance: "CreateAllianceEvent",
} as const;
export const CALENDAR_EDIT_METHODS = {
  personal: "EditPersonalEvent", corporation: "EditCorporationEvent", alliance: "EditAllianceEvent",
} as const;
export type CalendarEventScope = keyof typeof CALENDAR_CREATE_METHODS;
export interface CalendarEventDraft {
  readonly scope: CalendarEventScope;
  readonly startsAt: number;
  readonly duration: number | null;
  readonly title: string;
  readonly description: string;
  readonly important: boolean;
  readonly inviteeIDs: readonly number[];
}

const calendarTimeArg = (at: bigint): JsonValue => ({ type: "long", value: at.toString() });
export const calendarInviteeArg = (ids: readonly number[]): JsonValue => ({ type: "list", items: [...ids] });

function calendarEventFields(draft: CalendarEventDraft, at: bigint): JsonValue[] {
  return [
    calendarTimeArg(at), draft.duration,
    { type: "wstring", value: draft.title }, draft.description ? { type: "wstring", value: draft.description } : "",
    draft.important ? 1 : 0,
  ];
}

export function calendarCreateArgs(draft: CalendarEventDraft): JsonValue[] {
  const args = calendarEventFields(draft, unixMsToFiletime(draft.startsAt));
  if (draft.scope === "personal") args.push(calendarInviteeArg(draft.inviteeIDs));
  return args;
}

/** Preserve fractional seconds on an edit that keeps the original displayed minute. */
export function calendarEditedTime(oldTime: bigint, startsAt: number): bigint {
  const oldMs = filetimeToUnixMs(oldTime);
  return oldMs !== null && Math.floor(oldMs / 60_000) * 60_000 === startsAt ? oldTime : unixMsToFiletime(startsAt);
}

export function calendarEditArgs(eventID: number, oldTime: bigint, nextTime: bigint, draft: CalendarEventDraft): JsonValue[] {
  return [eventID, calendarTimeArg(oldTime), ...calendarEventFields(draft, nextTime)];
}

export function calendarCreatedID(result: JsonValue): number {
  const id = Number(unwrapLong(result));
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("The server did not return the new Calendar event ID.");
  return id;
}

/** One calendar event row (GetEventList). */
export interface CalendarEvent {
  readonly eventID: number;
  /** The event owner (character/corp/alliance/NPC entity), kept as data (R7d). */
  readonly ownerID: number;
  /** Event start FILETIME as a bigint; null when absent. */
  readonly eventDateTime: bigint | null;
  /** Duration in minutes; null when the event carries none. */
  readonly eventDuration: number | null;
  readonly eventTitle: string;
  readonly importance: number;
  /** Last-modified FILETIME as a bigint; null when absent. */
  readonly dateModified: bigint | null;
  readonly isDeleted: boolean;
  readonly flag: number;
  /** The auto-event category, or null for a normal user event. */
  readonly autoEventType: number | null;
}

type CalendarEventChange = Pick<CalendarEvent, "eventID" | "ownerID" | "eventDateTime" | "eventDuration" | "eventTitle" | "importance" | "autoEventType" | "dateModified">;
export type CalendarEventNotice = { kind: "edited"; event: CalendarEventChange } | { kind: "removed"; eventID: number };

export function calendarEventNotice(method: string | null, args: readonly unknown[], now: number): CalendarEventNotice | null {
  if (method !== "OnEditCalendarEvent" && method !== "OnRemoveCalendarEvent") return null;
  const eventID = Number(unwrapLong(args[0]));
  if (!Number.isSafeInteger(eventID) || eventID <= 0) return null;
  if (method === "OnRemoveCalendarEvent") return { kind: "removed", eventID };
  const ownerID = Number(unwrapLong(args[1]));
  const eventDateTime = unwrapLong(args[3]);
  if (!Number.isSafeInteger(ownerID) || ownerID <= 0 || eventDateTime === null) return null;
  return { kind: "edited", event: {
    eventID, ownerID, eventDateTime, eventDuration: args[4] == null ? null : Number(unwrapLong(args[4])),
    eventTitle: calendarText(args[5]), importance: Number(unwrapLong(args[6])),
    autoEventType: args[7] == null ? null : Number(unwrapLong(args[7])), dateModified: unixMsToFiletime(Math.trunc(now)),
  } };
}

/** This character's own response to one event (GetResponsesForCharacter). */
export interface CharacterResponse {
  readonly eventID: number;
  readonly status: number;
}

/** One participant's response to a given event (GetResponsesToEvent). */
export interface EventResponse {
  /** The responding character, kept as data for later resolution (R7d). */
  readonly characterID: number;
  readonly status: number;
}

/** One event's body text + creator (GetEventDetails). */
export interface EventDetails {
  readonly eventText: string;
  /** The event creator entity id, kept as data (R7d). */
  readonly creatorID: number;
}

export interface CalendarAgenda {
  readonly events: readonly CalendarEvent[];
  readonly responses: readonly CharacterResponse[];
  readonly nowMs: number;
}

/** CalendarNewEventWnd.AddAcceptDeclineBtns passes one of these response constants. */
export type CalendarReply = 4 | 5 | 2;

/** An integer tolerant of a {type:"long"} wrapper and a numeric string; 0 otherwise. */
function toNumber(value: JsonValue | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  const long = unwrapLong(value);
  if (long !== null) {
    return Number(long);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return 0;
}

/** An integer that stays null when the field is genuinely absent/null. */
function toNullableNumber(value: JsonValue | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return toNumber(value);
}

/** The `items` of a {type:"list"} wrapper; [] for anything else. */
function listItems(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : isListValue(value) ? value.items : [];
}

function calendarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "type" in value && value.type === "wstring"
      && "value" in value && typeof value.value === "string") return value.value;
  return "";
}

/**
 * Decode calendarProxy.GetEventList. The result is a 3-tuple [list, null, null];
 * the events are the first element's `items`. A non-array result, or a first
 * element that is not a list, yields [] — a real "no events this month" answer.
 * Rows without a positive eventID are dropped.
 */
export function decodeEventList(
  result: JsonValue | null | undefined,
): readonly CalendarEvent[] {
  const tuple = Array.isArray(result) ? result : [];
  const events: CalendarEvent[] = [];
  for (const row of listItems(tuple[0] as JsonValue | undefined)) {
    if (!isKeyValValue(row)) {
      continue;
    }
    const eventID = toNumber(readKeyVal(row, "eventID"));
    if (eventID <= 0) {
      continue;
    }
    events.push({
      eventID,
      ownerID: toNumber(readKeyVal(row, "ownerID")),
      eventDateTime: unwrapLong(readKeyVal(row, "eventDateTime")),
      eventDuration: toNullableNumber(readKeyVal(row, "eventDuration")),
      eventTitle: calendarText(readKeyVal(row, "eventTitle")),
      importance: toNumber(readKeyVal(row, "importance")),
      dateModified: unwrapLong(readKeyVal(row, "dateModified")),
      isDeleted: readKeyVal(row, "isDeleted") === true,
      flag: toNumber(readKeyVal(row, "flag")),
      autoEventType: toNullableNumber(readKeyVal(row, "autoEventType")),
    });
  }
  return events;
}

/**
 * Decode calendarMgr.GetResponsesForCharacter — a {type:"list"} of KeyVal
 * {eventID, status}. Empty is a real "no responses" answer. Rows without a
 * positive eventID are dropped.
 */
export function decodeResponsesForCharacter(
  result: JsonValue | null | undefined,
): readonly CharacterResponse[] {
  const responses: CharacterResponse[] = [];
  for (const row of listItems(result ?? undefined)) {
    if (!isKeyValValue(row)) {
      continue;
    }
    const eventID = toNumber(readKeyVal(row, "eventID"));
    if (eventID <= 0) {
      continue;
    }
    responses.push({ eventID, status: toNumber(readKeyVal(row, "status")) });
  }
  return responses;
}

/**
 * Decode calendarMgr.GetResponsesToEvent — a {type:"list"} of KeyVal
 * {characterID, status}. Empty is a real "no one responded" answer. Rows without
 * a positive characterID are dropped.
 */
export function decodeResponsesToEvent(
  result: JsonValue | null | undefined,
): readonly EventResponse[] {
  const responses: EventResponse[] = [];
  for (const row of listItems(result ?? undefined)) {
    if (!isKeyValValue(row)) {
      continue;
    }
    const characterID = toNumber(readKeyVal(row, "characterID"));
    if (characterID <= 0) {
      continue;
    }
    responses.push({ characterID, status: toNumber(readKeyVal(row, "status")) });
  }
  return responses;
}

/**
 * Decode calendarProxy.GetEventDetails — a util.KeyVal{eventText, creatorID}.
 * null when the value is not a KeyVal (the handler refuses an unknown eventID, so
 * a null here is the legitimate "no such event / not requested" case).
 */
export function decodeEventDetails(
  result: JsonValue | null | undefined,
): EventDetails | null {
  if (!isKeyValValue(result)) {
    return null;
  }
  return {
    eventText: calendarText(readKeyVal(result, "eventText")),
    creatorID: toNumber(readKeyVal(result, "creatorID")),
  };
}

// --- R87 write acks ---------------------------------------------------------
//
// The Phase-3 calendarMgr WRITES. FAST-MODE educated-guess decoders reading the
// small JSON ack the confirm-gated BFF route emits. The three Create*Event
// writes answer the new eventID; Edit / Delete / Respond / UpdateParticipants
// answer null (the panel re-reads the calendar to prove the mutation). Corp /
// alliance create + participant updates are role/scope gated server-side — a
// normal member's 403 is surfaced by the fetch layer, not this decoder. These
// are EDUCATED GUESSES from the client + server code, not captured bytes.

/** The uniform ack every confirm-gated calendar write returns. */
export interface CalendarWriteAck {
  readonly ok: boolean;
  readonly applied: boolean;
}

function ackTruthy(value: JsonValue | undefined): boolean {
  return value === true;
}

/** Decode a plain calendar write ack (Edit / Delete / Respond / UpdateParticipants). */
export function decodeCalendarWriteAck(response: JsonValue): CalendarWriteAck {
  return {
    ok: ackTruthy(readPlainJsonField(response, "ok")),
    applied: ackTruthy(readPlainJsonField(response, "applied")),
  };
}

/** A Create*Event ack: `applied` plus the new eventID (null when declined). */
export interface CalendarEventCreatedAck extends CalendarWriteAck {
  readonly eventID: number | null;
}

export function decodeCalendarEventCreatedAck(response: JsonValue): CalendarEventCreatedAck {
  const eventID = toNumber(readPlainJsonField(response, "eventID"));
  return {
    ok: ackTruthy(readPlainJsonField(response, "ok")),
    applied: ackTruthy(readPlainJsonField(response, "applied")),
    eventID: eventID > 0 ? eventID : null,
  };
}
