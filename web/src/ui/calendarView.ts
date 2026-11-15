import type { AppFlow } from "../app/flow.ts";
import { filetimeToUnixMs } from "../bridge/activity.ts";
import type { CalendarEvent } from "../bridge/calendar.ts";
import { createSignal, readonlySignal } from "../store/signals.ts";
import type { WinState } from "./desktop.ts";
import { calendarDate, type CalendarDate } from "./calendarSelection.ts";

// appConst.calendarTag* and eventResponse*.
const CALENDAR_TAGS = { personal: 1, corp: 2, alliance: 4, ccp: 8, automated: 16 } as const;
const TAG_KEYS = Object.keys(CALENDAR_TAGS) as (keyof typeof CALENDAR_TAGS)[];
export const CALENDAR_FILTERS = [...TAG_KEYS, "declined", "timestamp"] as const;
type Filter = (typeof CALENDAR_FILTERS)[number];
type Filters = Readonly<Record<Filter, boolean>>;
const DEFAULT_FILTERS: Filters = { personal: true, corp: true, alliance: true, ccp: true, automated: true, declined: true, timestamp: true };

const two = (value: number): string => String(value).padStart(2, "0");
export const calendarTime = (ms: number): string => {
  const time = new Date(ms);
  return `${two(time.getUTCHours())}:${two(time.getUTCMinutes())}`;
};

/** FormatDateTime with a date and no time in 24.02. */
export function calendarCaption(day: CalendarDate): string {
  return `${day.y}.${two(day.m + 1)}.${two(day.d)}`;
}

/** The month grid and the calendar's single-day window use the same event filters. */
export function calendarRows(events: readonly CalendarEvent[], filters: Filters, responses: ReadonlyMap<number, number>) {
  const tags = TAG_KEYS.reduce((mask, key) => filters[key] ? mask | CALENDAR_TAGS[key] : mask, 0);
  return events.flatMap(event => {
    const response = responses.get(event.eventID) ?? 3;
    if (event.isDeleted || !(tags & event.flag) || response === 1 || (response === 2 && !filters.declined)) return [];
    const at = filetimeToUnixMs(event.eventDateTime);
    if (at === null) return [];
    return [{ event, at, day: calendarDate(new Date(at)), response }];
  }).sort((a, b) => a.at - b.at || a.event.eventTitle.localeCompare(b.event.eventTitle));
}

export type CalendarRow = ReturnType<typeof calendarRows>[number];
export const CALENDAR_DAY_SIZE = { w: 315, h: 300 };
type DayWindow = Omit<WinState, "id"> & { readonly id: string; readonly day: CalendarDate };

function createCalendarView() {
  const filters = createSignal(DEFAULT_FILTERS);
  const days = createSignal<readonly DayWindow[]>([]);
  const raised = createSignal<{ readonly id: string } | null>(null);
  const topZ = () => Math.max(0, ...days.get().filter(win => !win.minimized).map(win => win.z));
  const update = (id: string, patch: Partial<Omit<DayWindow, "id" | "day">>) => {
    days.update(wins => wins.map(win => win.id === id ? { ...win, ...patch } : win));
  };

  return {
    filters: readonlySignal(filters),
    days: readonlySignal(days),
    raised: readonlySignal(raised),
    topZ,
    setFilter(key: Filter, checked: boolean) { filters.update(current => ({ ...current, [key]: checked })); },
    openDay(day: CalendarDate, keepOtherDays: boolean) {
      const id = calendarCaption(day);
      if (days.get().some(win => win.id === id)) {
        update(id, { minimized: false, z: topZ() + 1 });
      } else {
        const others = keepOtherDays ? days.get() : [];
        const inset = (others.length % 8) * 28;
        days.set([...others, { id, day, x: 80 + inset, y: 64 + inset, ...CALENDAR_DAY_SIZE, z: topZ() + 1, minimized: false }]);
      }
      raised.set({ id });
    },
    focusDay(id: string, z: number) { update(id, { z: Math.max(z, topZ() + 1), minimized: false }); },
    minimizeDay(id: string) {
      const day = days.get().find(win => win.id === id);
      if (!day) return;
      if (day.minimized) {
        update(id, { minimized: false, z: topZ() + 1 });
        raised.set({ id });
      } else {
        update(id, { minimized: true });
      }
    },
    updateDay: update,
    closeDay(id: string) { days.update(wins => wins.filter(win => win.id !== id)); },
  };
}

// Auxiliary windows and the calendar use the same transient UI state for each pilot flow.
const views = new WeakMap<AppFlow, ReturnType<typeof createCalendarView>>();
export function calendarView(flow: AppFlow) {
  let view = views.get(flow);
  if (!view) {
    view = createCalendarView();
    views.set(flow, view);
  }
  return view;
}
