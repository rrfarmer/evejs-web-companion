import type { AppFlow } from "../app/flow.ts";
import { filetimeToUnixMs } from "../bridge/activity.ts";
import type { CalendarEvent } from "../bridge/calendar.ts";
import { createSignal, readonlySignal } from "../store/signals.ts";
import type { WinState } from "./desktop.ts";
import { calendarDate, type CalendarDate } from "./calendarSelection.ts";

// appConst.calendarTag* and eventResponse*.
export const CALENDAR_TAGS = { personal: 1, corp: 2, alliance: 4, ccp: 8, automated: 16 } as const;
const TAG_KEYS = Object.keys(CALENDAR_TAGS) as (keyof typeof CALENDAR_TAGS)[];
export const CALENDAR_FILTERS = [...TAG_KEYS, "declined", "timestamp"] as const;
type Filter = (typeof CALENDAR_FILTERS)[number];
type Filters = Readonly<Record<Filter, boolean>>;
const DEFAULT_FILTERS: Filters = { personal: true, corp: true, alliance: true, ccp: true, automated: true, declined: true, timestamp: true };
export const CALENDAR_RESPONSES = [
  ["Uninvited", "Uninvited", 192], ["Canceled", "Canceled", 194], ["Declined", "Declined", 194],
  ["NotResponded", "Not Responded", 177], ["Accepted", "Accepted", 193], ["MaybeReply", "Maybe", 195],
] as const;
export const CALENDAR_RESPONSE_PATH = "UI/Calendar/ResponseTypes/";
export const CALENDAR_EVENT_CAPTION = "UI/Calendar/EventWindow/CaptionRead";

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
export const CALENDAR_WINDOW_SIZES = { day: { w: 315, h: 300 }, event: { w: 530, h: 370 } } as const;
type CalendarSubject = { readonly kind: "day"; readonly day: CalendarDate } | { readonly kind: "event"; readonly event: CalendarEvent };
type CalendarWindow = Omit<WinState, "id"> & { readonly id: string } & CalendarSubject;

function createCalendarView() {
  const filters = createSignal(DEFAULT_FILTERS);
  const windows = createSignal<readonly CalendarWindow[]>([]);
  const raised = createSignal<{ readonly id: string } | null>(null);
  const topZ = () => Math.max(0, ...windows.get().filter(win => !win.minimized).map(win => win.z));
  const update = (id: string, patch: Partial<Omit<WinState, "id">>) => {
    windows.update(wins => wins.map(win => win.id === id ? { ...win, ...patch } : win));
  };
  function open(id: string, subject: CalendarSubject, keepOtherDays: boolean): void {
    const current = windows.get();
    if (current.some(win => win.id === id)) {
      update(id, { minimized: false, z: topZ() + 1 });
    } else {
      const others = keepOtherDays ? current : current.filter(win => win.kind !== "day");
      const inset = (others.length % 8) * 28;
      const size = CALENDAR_WINDOW_SIZES[subject.kind];
      windows.set([...others, { ...subject, id, x: 80 + inset, y: 64 + inset, ...size,
        h: subject.kind === "event" ? 460 : size.h, z: topZ() + 1, minimized: false }]);
    }
    raised.set({ id });
  }
  function reveal(id: string): void {
    update(id, { minimized: false, z: topZ() + 1 });
    raised.set({ id });
  }

  return {
    filters: readonlySignal(filters),
    windows: readonlySignal(windows),
    raised: readonlySignal(raised),
    topZ,
    setFilter(key: Filter, checked: boolean) { filters.update(current => ({ ...current, [key]: checked })); },
    openDay(day: CalendarDate, keepOtherDays: boolean) {
      open(calendarCaption(day), { kind: "day", day }, keepOtherDays);
    },
    openEvent(event: CalendarEvent) { open(`event-${event.eventID}`, { kind: "event", event }, true); },
    focus(id: string, z: number) { update(id, { z: Math.max(z, topZ() + 1), minimized: false }); },
    reveal,
    toggleMinimize(id: string) {
      const win = windows.get().find(win => win.id === id);
      if (!win) return;
      if (win.minimized) {
        reveal(id);
      } else {
        update(id, { minimized: true });
      }
    },
    update,
    close(id: string) { windows.update(wins => wins.filter(win => win.id !== id)); },
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
