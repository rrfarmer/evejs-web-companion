// Read-only Activity Center decoding.
//
// The two aggregate BFF routes used here intentionally settle their retail
// reads independently. A failed arm is returned as `null` plus an entry in
// `errors`, while a successful arm may be an honestly empty list. Keep those
// states distinct here, before the lower-level decoders (which quite correctly
// turn an invalid standalone value into []) get a chance to collapse them.

import {
  decodeEventList,
  decodeResponsesForCharacter,
} from "./calendar.ts";
import { decodeNotifications } from "./notifications.ts";
import { isKeyValValue, isListValue, readKeyVal, type JsonValue } from "./wire.ts";
import type {
  ActivityCalendarEventRow,
  ActivityCalendarResponseRow,
  ActivityNotificationRow,
  ActivityRead,
  LiveNotification,
} from "../store/types.ts";

const FILETIME_UNIX_EPOCH = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function armFailed(envelope: Readonly<Record<string, unknown>>, arm: string): boolean {
  const errors = record(envelope.errors);
  return errors !== null && errors[arm] !== null && errors[arm] !== undefined;
}

function unavailable<T>(): ActivityRead<T> {
  return { status: "unavailable", value: null, error: null };
}

function ready<T>(value: T): ActivityRead<T> {
  return { status: "ready", value, error: null };
}

/** Build a failed read from already player-facing words supplied by the flow. */
export function activityReadError<T>(message: string): ActivityRead<T> {
  return { status: "error", value: null, error: message };
}

function failed<T>(subject: string): ActivityRead<T> {
  return activityReadError(`${subject} could not be read just now.`);
}

/** Convert an exact retail FILETIME to Unix milliseconds without rounding it first. */
export function filetimeToUnixMs(value: bigint | null): number | null {
  if (value === null || value <= FILETIME_UNIX_EPOCH) {
    return null;
  }
  const milliseconds = (value - FILETIME_UNIX_EPOCH) / FILETIME_TICKS_PER_MS;
  const result = Number(milliseconds);
  return Number.isSafeInteger(result) ? result : null;
}

export function unixMsToFiletime(value: number): bigint {
  return BigInt(value) * FILETIME_TICKS_PER_MS + FILETIME_UNIX_EPOCH;
}

/**
 * Human category for a notification type. This deliberately does not fall
 * back to the numeric typeID: unknown retail additions remain useful and do
 * not leak implementation IDs into the player UI.
 */
export function notificationTitle(typeID: number): string {
  const exact: Readonly<Record<number, string>> = {
    9: "Corporation bill due",
    10: "Corporation bill changed",
    12: "Corporation bill overdue",
    13: "Corporation bill paid",
    34: "Insurance update",
    35: "Insurance payment",
    36: "Insurance contract expired",
    54: "Insurance payout",
    55: "Insurance contract update",
    252: "Skill training update",
    253: "Skill queue update",
    1000: "Skill training finished",
    1002: "Skill queue empty",
    1003: "New mail",
    1004: "New mail",
    2001: "Contact notification",
    2002: "Contact list changed",
  };
  const known = exact[typeID];
  if (known !== undefined) {
    return known;
  }
  if (typeID >= 16 && typeID <= 33) {
    return "Corporation update";
  }
  if (typeID >= 112 && typeID <= 120) {
    return "Bounty or kill-right update";
  }
  if (
    (typeID >= 181 && typeID <= 211) ||
    typeID === 249 ||
    typeID === 254 ||
    typeID === 6040 ||
    typeID === 6041
  ) {
    return "Structure update";
  }
  return "New notification";
}

export interface ActivityNotificationReads {
  readonly notifications: ActivityRead<readonly ActivityNotificationRow[]>;
  readonly unprocessedCount: ActivityRead<number>;
}

/**
 * The client's notification service's two reads (notificationSvc.py 93 and 107), each answered or failed, without
 * confusing empty and failed: `all` GetAllNotifications(fromID=0)'s list, `unprocessed` GetUnprocessed()'s, and
 * in `errors` the code of either that failed.
 */
export function decodeActivityNotifications(envelope: unknown): ActivityNotificationReads {
  const outer = record(envelope);
  if (outer === null) {
    return {
      notifications: unavailable(),
      unprocessedCount: unavailable(),
    };
  }

  let notifications: ActivityRead<readonly ActivityNotificationRow[]>;
  if (armFailed(outer, "all")) {
    notifications = failed("Recent notifications");
  } else if (!Array.isArray(outer.all)) {
    notifications = unavailable();
  } else {
    const rows = decodeNotifications(outer.all as JsonValue)
      .map<ActivityNotificationRow>((item) => ({
        notificationID: item.notificationID,
        senderID: item.senderID,
        processed: item.processed,
        created: item.created,
        title: notificationTitle(item.typeID),
        typeID: item.typeID,
        receiverID: item.receiverID,
        data: item.data,
      }))
      .sort((left, right) => {
        if (left.created === right.created) {
          return right.notificationID - left.notificationID;
        }
        if (left.created === null) return 1;
        if (right.created === null) return -1;
        return left.created > right.created ? -1 : 1;
      })
      .slice(0, 20);
    notifications = ready(rows);
  }

  let unprocessedCount: ActivityRead<number>;
  if (armFailed(outer, "unprocessed")) {
    unprocessedCount = failed("Unread notification count");
  } else if (!Array.isArray(outer.unprocessed)) {
    unprocessedCount = unavailable();
  } else {
    unprocessedCount = ready(decodeNotifications(outer.unprocessed as JsonValue).length);
  }

  return { notifications, unprocessedCount };
}

export interface ActivityCalendarReads {
  readonly calendarEvents: ActivityRead<readonly ActivityCalendarEventRow[]>;
  readonly calendarResponses: ActivityRead<readonly ActivityCalendarResponseRow[]>;
}

/**
 * The events of the months asked, as the client's calendar service gathers them (eveCalendarsvc.py 235 to 243,
 * 548 to 566): of each month's answer, a tuple of rowsets, the rows of every one that is not None; of all the
 * months, one by its event, the later month's where two have it (FetchNextEvents' update). Made into the one list
 * the event list's decoder reads.
 */
export function calendarEventsOfMonths(answers: readonly JsonValue[]): JsonValue {
  const byEvent = new Map<string, JsonValue>();
  for (const answer of answers) {
    const rowsets = Array.isArray(answer) ? answer : isListValue(answer) ? answer.items : [];
    for (const rowset of rowsets) {
      const rows = Array.isArray(rowset) ? rowset : isListValue(rowset) ? rowset.items : [];
      for (const row of rows) {
        if (!isKeyValValue(row)) continue;
        byEvent.set(JSON.stringify(readKeyVal(row, "eventID") ?? null), row);
      }
    }
  }
  return [{ type: "list", items: [...byEvent.values()] }];
}

/**
 * The calendar's two reads the Activity Center makes, each answered or failed: `eventList` the months' events
 * (calendarEventsOfMonths), `responsesForCharacter` GetResponsesForCharacter()'s list, and in `errors` the
 * code of either that failed.
 */
export function decodeActivityCalendar(
  envelope: unknown,
  nowMs = Date.now(),
): ActivityCalendarReads {
  const outer = record(envelope);
  if (outer === null) {
    return {
      calendarEvents: unavailable(),
      calendarResponses: unavailable(),
    };
  }

  let calendarEvents: ActivityRead<readonly ActivityCalendarEventRow[]>;
  if (armFailed(outer, "eventList")) {
    calendarEvents = failed("Upcoming calendar events");
  } else if (!Array.isArray(outer.eventList) || !isListValue(outer.eventList[0])) {
    calendarEvents = unavailable();
  } else {
    const events = decodeEventList(outer.eventList as JsonValue)
      .filter((event) => {
        if (event.isDeleted) return false;
        const startsAt = filetimeToUnixMs(event.eventDateTime);
        if (startsAt === null) return true;
        const durationMs = Math.max(0, event.eventDuration ?? 0) * 60_000;
        return startsAt + durationMs >= nowMs;
      })
      .map<ActivityCalendarEventRow>((event) => ({
        eventID: event.eventID,
        ownerID: event.ownerID,
        eventDateTime: event.eventDateTime,
        eventDuration: event.eventDuration,
        title: event.eventTitle.trim() || "Calendar event",
        importance: event.importance,
      }))
      .sort((left, right) => {
        const leftTime = filetimeToUnixMs(left.eventDateTime);
        const rightTime = filetimeToUnixMs(right.eventDateTime);
        if (leftTime === rightTime) return left.eventID - right.eventID;
        if (leftTime === null) return 1;
        if (rightTime === null) return -1;
        return leftTime - rightTime;
      })
      .slice(0, 12);
    calendarEvents = ready(events);
  }

  let calendarResponses: ActivityRead<readonly ActivityCalendarResponseRow[]>;
  if (armFailed(outer, "responsesForCharacter")) {
    calendarResponses = failed("Calendar responses");
  } else if (!isListValue(outer.responsesForCharacter)) {
    calendarResponses = unavailable();
  } else {
    calendarResponses = ready(
      decodeResponsesForCharacter(outer.responsesForCharacter as JsonValue).map((response) => ({
        eventID: response.eventID,
        status: response.status,
      })),
    );
  }

  return { calendarEvents, calendarResponses };
}

/** Retail calendar response status in words the player can act on. */
export function calendarResponseText(status: number | null | undefined): string {
  switch (status) {
    case 0:
      return "Not invited";
    case 1:
      return "Removed";
    case 2:
      return "Declined";
    case 3:
      return "Awaiting response";
    case 4:
      return "Going";
    case 5:
      return "Maybe";
    default:
      return "No response recorded";
  }
}

/**
 * Collapse internal live notification metadata into a safe, useful activity
 * label. Neither the service/method names nor the opaque args are rendered.
 */
export function liveActivityTitle(notification: LiveNotification): string {
  const source = `${notification.kind} ${notification.service ?? ""} ${notification.method ?? ""}`
    .toLowerCase();
  if (source.includes("mail")) return "Mail updated";
  if (source.includes("skill") || source.includes("training")) return "Skill training updated";
  if (source.includes("calendar")) return "Calendar updated";
  if (source.includes("wallet") || source.includes("transaction") || source.includes("balance")) {
    return "Wallet updated";
  }
  if (source.includes("item") || source.includes("inventory")) return "Your items changed";
  if (source.includes("godma") || source.includes("effect") || source.includes("module")) {
    return "Ship module activity";
  }
  if (source.includes("damage") || source.includes("combat") || source.includes("target")) {
    return "Combat update";
  }
  if (source.includes("fleet")) return "Fleet updated";
  if (source.includes("chat") || source.includes("message")) return "Chat activity";
  if (
    source.includes("destiny") ||
    source.includes("warp") ||
    source.includes("jump") ||
    source.includes("dock") ||
    source.includes("ballpark")
  ) {
    return "Flight update";
  }
  if (source.includes("notification")) return "New notification";
  return "Session activity";
}
