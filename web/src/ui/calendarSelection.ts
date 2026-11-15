export interface CalendarDate {
  readonly y: number;
  /** Zero-based UTC month, as used by Date.UTC. */
  readonly m: number;
  readonly d: number;
}

export function calendarDate(date: Date): CalendarDate {
  return { y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate() };
}

export function calendarMonthOffset(date: Pick<CalendarDate, "y" | "m">, origin: CalendarDate): number {
  return (date.y - origin.y) * 12 + date.m - origin.m;
}

function firstColumn(year: number, month: number): number {
  return (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
}

export function calendarGrid(year: number, month: number): readonly CalendarDate[] {
  const first = 1 - firstColumn(year, month);
  return Array.from({ length: 42 }, (_, i) => calendarDate(new Date(Date.UTC(year, month, first + i))));
}

// Calendar.CrawlForValidDay starts at the same column on the entering edge of
// the next grid, then skips shaded cells horizontally or vertically.
export function stepCalendarDate(date: CalendarDate, direction: -1 | 1, unit: "day" | "week" | "month"): CalendarDate {
  const { y, m, d } = date;
  const stride = unit === "week" ? 7 : 1;
  const moved = calendarDate(new Date(Date.UTC(y, m, d + direction * stride)));
  if (unit !== "month" && moved.m === m) return moved;

  const columnDelta = unit === "day" ? direction : 0;
  const column = (firstColumn(y, m) + d - 1 + columnDelta + 7) % 7;
  const next = calendarDate(new Date(Date.UTC(y, m + direction, 1)));
  const last = new Date(Date.UTC(next.y, next.m + 1, 0)).getUTCDate();
  let day = (direction === 1 ? 1 : 36) + column - firstColumn(next.y, next.m);
  while (day < 1 || day > last) day += direction * stride;
  return { ...next, d: day };
}
