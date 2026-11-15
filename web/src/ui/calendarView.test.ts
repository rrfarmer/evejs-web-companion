import assert from "node:assert/strict";
import test from "node:test";
import type { AppFlow } from "../app/flow.ts";
import type { CalendarEvent } from "../bridge/calendar.ts";
import { calendarAgendaRows, calendarRows, calendarView } from "./calendarView.ts";

test("calendar day windows reopen by date, stack with Shift, and replace other days by default", () => {
  const flow = {} as AppFlow;
  const view = calendarView(flow);
  const first = { y: 2026, m: 10, d: 11 }, other = { y: 2026, m: 10, d: 12 }, next = { y: 2026, m: 11, d: 1 };
  view.openDay(first, false);
  view.openDay(other, true);
  view.toggleMinimize("2026.11.11");
  view.openDay(first, false);
  assert.deepEqual(view.windows.get().map(win => [win.id, win.minimized]), [["2026.11.11", false], ["2026.11.12", false]]);
  assert.equal(view.raised.get()?.id, "2026.11.11");
  assert.equal(calendarView(flow), view);
  assert.equal(calendarView({} as AppFlow).windows.get().length, 0);
  view.openDay(next, false);
  assert.deepEqual(view.windows.get().map(win => win.id), ["2026.12.01"]);
});

test("event windows reopen by event ID and survive replacement of the open day", () => {
  const view = calendarView({} as AppFlow);
  const event: CalendarEvent = {
    eventID: 17, ownerID: 1, eventDateTime: 134388690600000000n, eventDuration: 10,
    eventTitle: "One", importance: 0, dateModified: null, isDeleted: false, flag: 8, autoEventType: null,
  };
  view.openDay({ y: 2026, m: 10, d: 11 }, false);
  view.openEvent(event);
  view.toggleMinimize("event-17");
  view.openDay({ y: 2026, m: 10, d: 12 }, false);
  view.openEvent(event);
  assert.deepEqual(view.windows.get().map(win => [win.id, win.minimized]), [["event-17", false], ["2026.11.12", false]]);
  assert.equal(view.raised.get()?.id, "event-17");
});

test("month and day rows share category, RSVP and deletion filters", () => {
  const base: CalendarEvent = {
    eventID: 1, ownerID: 1, eventDateTime: 134388690600000000n, eventDuration: 10,
    eventTitle: "One", importance: 0, dateModified: null, isDeleted: false, flag: 8, autoEventType: null,
  };
  const events = [base, { ...base, eventID: 2, eventTitle: "Two" }, { ...base, eventID: 3, flag: 1 },
    { ...base, eventID: 4, isDeleted: true }, { ...base, eventID: 5, flag: 1 }];
  const responses = new Map([[2, 2], [5, 1]]);
  const view = calendarView({} as AppFlow);
  const visible = () => calendarRows(events, view.filters.get(), responses).map(row => [row.event.eventID, row.response]);
  assert.deepEqual(visible(), [[1, 3], [3, 3], [2, 2]]);
  view.setFilter("declined", false);
  assert.deepEqual(visible(), [[1, 3], [3, 3]]);
  view.setFilter("ccp", false);
  assert.deepEqual(visible(), [[3, 3]]);
});

test("Calendar agendas keep distinct future response rules and sort by the native columns", () => {
  const nowMs = Date.UTC(2026, 10, 15, 14);
  const filetime = (ms: number) => BigInt(ms) * 10_000n + 116444736000000000n;
  const event = (id: number, startMs: number, changedMs: number, isDeleted = false, flag = 1): CalendarEvent => ({
    eventID: id, ownerID: 140_000_002, eventDateTime: filetime(startMs), dateModified: filetime(changedMs),
    eventTitle: `Event ${id}`, eventDuration: 60, flag, isDeleted, importance: 0, autoEventType: null,
  });
  const events = [event(1, nowMs + 6000, nowMs - 2), event(2, nowMs + 5000, nowMs - 4),
    event(3, nowMs + 4000, nowMs - 3), event(4, nowMs + 2000, nowMs - 1, true),
    event(5, nowMs + 1000, nowMs, true), event(6, nowMs - 1, nowMs), event(7, nowMs, nowMs - 5, false, 8)];
  const responses = [{ eventID: 2, status: 4 }, { eventID: 3, status: 2 }, { eventID: 4, status: 4 }, { eventID: 5, status: 2 }];
  const view = calendarView({} as AppFlow);
  const read = () => calendarAgendaRows({ status: "ready", data: { events, responses, nowMs } }, view.filters.get());
  assert.deepEqual(read().upcoming.map(row => row.event.eventID), [7, 2, 1]);
  assert.deepEqual(read().updates.map(row => [row.event.eventID, row.response]), [[4, 1], [1, 3], [7, 3]]);
  view.setFilter("personal", false);
  assert.deepEqual(read().updates.map(row => row.event.eventID), [7]);
});

test("an expanded agenda shares the day window's replace and Shift rules", () => {
  const view = calendarView({} as AppFlow);
  view.openDay({ y: 2026, m: 10, d: 11 }, false);
  view.openAgenda("upcoming", true);
  assert.deepEqual(view.windows.get().map(win => win.id), ["2026.11.11", "upcoming"]);
  view.openAgenda("updates", false);
  assert.deepEqual(view.windows.get().map(win => win.id), ["updates"]);
});
