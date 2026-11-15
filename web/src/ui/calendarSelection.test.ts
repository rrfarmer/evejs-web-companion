import assert from "node:assert/strict";
import test from "node:test";
import { calendarGrid, calendarMonthOffset, stepCalendarDate } from "./calendarSelection.ts";

test("the six-week November grid starts Monday and includes both neighboring months", () => {
  const days = calendarGrid(2026, 10);
  assert.equal(days.length, 42);
  assert.deepEqual(days[0], { y: 2026, m: 9, d: 26 });
  assert.deepEqual(days[6], { y: 2026, m: 10, d: 1 });
  assert.deepEqual(days[41], { y: 2026, m: 11, d: 6 });
});

test("horizontal movement enters the neighboring month at its nearest day", () => {
  assert.deepEqual(stepCalendarDate({ y: 2026, m: 10, d: 1 }, -1, "day"), { y: 2026, m: 9, d: 31 });
  assert.deepEqual(stepCalendarDate({ y: 2026, m: 11, d: 31 }, 1, "day"), { y: 2027, m: 0, d: 1 });
});

test("vertical movement preserves the weekday while skipping adjacent-month cells", () => {
  assert.deepEqual(stepCalendarDate({ y: 2026, m: 10, d: 1 }, -1, "week"), { y: 2026, m: 9, d: 25 });
  assert.deepEqual(stepCalendarDate({ y: 2026, m: 10, d: 30 }, 1, "week"), { y: 2026, m: 11, d: 7 });
});

test("month buttons retain the selected column at the new month's entering edge", () => {
  const selected = { y: 2026, m: 10, d: 15 };
  const december = stepCalendarDate(selected, 1, "month");
  assert.deepEqual(december, { y: 2026, m: 11, d: 6 });
  assert.equal(calendarMonthOffset(december, selected), 1);
  assert.deepEqual(stepCalendarDate(selected, -1, "month"), { y: 2026, m: 9, d: 31 });
});
