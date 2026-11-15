import assert from "node:assert/strict";
import test from "node:test";
import type { AppFlow } from "../app/flow.ts";
import type { CalendarEvent } from "../bridge/calendar.ts";
import { calendarRows, calendarView } from "./calendarView.ts";

test("calendar day windows reopen by date, stack with Shift, and replace other days by default", () => {
  const flow = {} as AppFlow;
  const view = calendarView(flow);
  const first = { y: 2026, m: 10, d: 11 }, other = { y: 2026, m: 10, d: 12 }, next = { y: 2026, m: 11, d: 1 };
  view.openDay(first, false);
  view.openDay(other, true);
  view.minimizeDay("2026.11.11");
  view.openDay(first, false);
  assert.deepEqual(view.days.get().map(win => [win.id, win.minimized]), [["2026.11.11", false], ["2026.11.12", false]]);
  assert.equal(view.raised.get()?.id, "2026.11.11");
  assert.equal(calendarView(flow), view);
  assert.equal(calendarView({} as AppFlow).days.get().length, 0);
  view.openDay(next, false);
  assert.deepEqual(view.days.get().map(win => win.id), ["2026.12.01"]);
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
