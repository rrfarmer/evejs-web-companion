import { readable } from "svelte/store";
import type { AppFlow } from "../app/flow.ts";
import { filetimeToUnixMs } from "../bridge/activity.ts";
import type { CalendarAgenda, CalendarEvent, CalendarReply } from "../bridge/calendar.ts";
import { createSignal, readonlySignal } from "../store/signals.ts";
import type { WinState } from "./desktop.ts";
import { calendarDate, calendarDayStart, newCalendarEventStart, type CalendarDate } from "./calendarSelection.ts";

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
export const CALENDAR_CREATE_CAPTION = "UI/Calendar/EventWindow/CaptionNew";
export const CALENDAR_REPLY_CHOICES = [
  [4, "/Carbon/UI/Calendar/Accept", "Accept"],
  [5, "/Carbon/UI/Calendar/MaybeReply", "Tentative"],
  [2, "/Carbon/UI/Calendar/Decline", "Decline"],
] as const;
export const CALENDAR_AGENDA_LABELS = {
  upcoming: ["UI/Calendar/CalendarWindow/UpcomingEvents", "Upcoming Events"],
  updates: ["UI/Calendar/CalendarWindow/LatestUpdates", "Latest Updates"],
} as const;
export type CalendarAgendaKind = keyof typeof CALENDAR_AGENDA_LABELS;
export const CALENDAR_GROUPS = {
  1: { label: "GroupPersonal", fallback: "Personal" },
  2: { label: "GroupCorp", fallback: "Corporation", icon: "classes/flagicon/8/1.png", color: "rgba(26, 153, 26, .75)" },
  4: { label: "GroupAlliance", fallback: "Alliance", icon: "classes/flagicon/8/1.png", color: "rgba(0, 38, 153, .75)" },
  8: { label: "GroupCcp", fallback: "CCP", icon: "classes/flagicon/8/2.png", color: "#b3b3b3bf" },
  16: { label: "GroupAutomated", fallback: "Automated", icon: "icons/automatedentry_icon_alpha.png", color: "rgba(26, 153, 26, .75)" },
} as const;

const two = (value: number): string => String(value).padStart(2, "0");
export const calendarTime = (ms: number): string => {
  const time = new Date(ms);
  return `${two(time.getUTCHours())}:${two(time.getUTCMinutes())}`;
};

/** FormatDateTime with a date and no time in 24.02. */
export function calendarCaption(day: CalendarDate): string {
  return `${day.y}.${two(day.m + 1)}.${two(day.d)}`;
}

export function calendarDateTime(ms: number): string {
  return `${calendarCaption(calendarDate(new Date(ms)))} ${calendarTime(ms)}`;
}

function rowsForTags(events: readonly CalendarEvent[], filters: Filters, responses: ReadonlyMap<number, number>) {
  const tags = TAG_KEYS.reduce((mask, key) => filters[key] ? mask | CALENDAR_TAGS[key] : mask, 0);
  return events.flatMap(event => {
    if (!(tags & event.flag)) return [];
    const at = filetimeToUnixMs(event.eventDateTime);
    if (at === null) return [];
    return [{ event, at, day: calendarDate(new Date(at)), response: responses.get(event.eventID) ?? 3,
      modified: filetimeToUnixMs(event.dateModified) }];
  });
}

/** The month grid and the calendar's single-day window use the same event filters. */
export function calendarRows(events: readonly CalendarEvent[], filters: Filters, responses: ReadonlyMap<number, number>) {
  return rowsForTags(events, filters, responses)
    .filter(row => !row.event.isDeleted && row.response !== 1 && (row.response !== 2 || filters.declined))
    .sort((a, b) => a.at - b.at || a.event.eventTitle.localeCompare(b.event.eventTitle));
}

export type CalendarRow = ReturnType<typeof calendarRows>[number];
export function calendarReplyChoices(event: CalendarEvent, characterID: number | null, response: number, now: number, fromMenu = false) {
  const start = filetimeToUnixMs(event.eventDateTime);
  if (!characterID || event.ownerID === characterID || event.isDeleted || response === 1 || start === null || start < now) return [];
  const { personal, corp, alliance, automated } = CALENDAR_TAGS;
  const tags: readonly number[] = fromMenu ? [personal, corp, alliance, automated] : [personal, corp, alliance];
  return tags.includes(event.flag) ? CALENDAR_REPLY_CHOICES.filter(([status]) => status !== response) : [];
}

export function isCalendarMenuKey(event: KeyboardEvent): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

export type AgendaState = { readonly status: "loading" | "error" } | { readonly status: "ready"; readonly data: CalendarAgenda };

export function calendarResponses(state: AgendaState): ReadonlyMap<number, number> {
  return new Map(state.status === "ready" ? state.data.responses.map(row => [row.eventID, row.status]) : []);
}

/** eveCalendarsvc.GetMyNextEvents and GetMyChangedEvents use different response and deletion rules. */
export function calendarAgendaRows(state: AgendaState, filters: Filters): Readonly<Record<CalendarAgendaKind, readonly CalendarRow[]>> {
  if (state.status !== "ready") return { upcoming: [], updates: [] };
  const { events, nowMs } = state.data;
  const future = rowsForTags(events, filters, calendarResponses(state)).filter(row => row.at >= nowMs);
  return {
    upcoming: future.filter(row => !row.event.isDeleted && row.response !== 2).sort((a, b) => a.at - b.at),
    updates: future.filter(row => row.response === 3 || (row.event.isDeleted && row.response !== 2))
      .map(row => row.event.isDeleted ? { ...row, response: 1 } : row)
      .sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0)),
  };
}

const eventWindowSize = { w: 530, h: 370 };
export const CALENDAR_WINDOW_SIZES = { day: { w: 315, h: 300 }, agenda: { w: 315, h: 300 }, event: eventWindowSize, create: eventWindowSize } as const;
export type CalendarListSubject = { readonly kind: "day"; readonly day: CalendarDate } | { readonly kind: "agenda"; readonly agendaKind: CalendarAgendaKind };
type CalendarSubject = CalendarListSubject | { readonly kind: "event"; readonly event: CalendarEvent } |
  { readonly kind: "create"; readonly startsAt: number };
type CalendarWindow = Omit<WinState, "id"> & { readonly id: string } & CalendarSubject;
type CalendarMenuSubject = { readonly kind: "event"; readonly row: CalendarRow; readonly allowJump: boolean } |
  { readonly kind: "day"; readonly day: CalendarDate };
export type CalendarMenu = { readonly x: number; readonly y: number; readonly anchor: HTMLElement } & CalendarMenuSubject;

function createCalendarView(flow: AppFlow) {
  const filters = createSignal(DEFAULT_FILTERS);
  const agenda = readable<AgendaState>({ status: "loading" }, set => {
    let serial = 0;
    const stop = flow.calendarUpdated.subscribe(() => {
      const current = ++serial;
      set({ status: "loading" });
      // The transport invalidates its kept Calendar answers before delivering the notice.
      void Promise.resolve().then(() => current === serial ? flow.loadCalendarAgenda() : undefined)
        .then(data => { if (data && current === serial) set({ status: "ready", data }); },
          () => { if (current === serial) set({ status: "error" }); });
    });
    return () => { ++serial; stop(); };
  });
  const windows = createSignal<readonly CalendarWindow[]>([]);
  const raised = createSignal<{ readonly id: string } | null>(null);
  const replying = createSignal<ReadonlySet<number>>(new Set());
  const menu = createSignal<CalendarMenu | null>(null);
  let selectDay: ((day: CalendarDate) => void) | null = null;
  const topZ = () => Math.max(0, ...windows.get().filter(win => !win.minimized).map(win => win.z));
  const update = (id: string, patch: Partial<Omit<WinState, "id">>) => {
    windows.update(wins => wins.map(win => win.id === id ? { ...win, ...patch } : win));
  };
  function open(id: string, subject: CalendarSubject, keepOtherLists: boolean): void {
    const current = windows.get();
    if (current.some(win => win.id === id)) {
      update(id, { minimized: false, z: topZ() + 1 });
    } else {
      const others = keepOtherLists ? current : current.filter(win => win.kind === "event" || win.kind === "create");
      const inset = (others.length % 8) * 28;
      const size = CALENDAR_WINDOW_SIZES[subject.kind];
      windows.set([...others, { ...subject, id, x: 80 + inset, y: 64 + inset, ...size,
        h: subject.kind === "event" || subject.kind === "create" ? 460 : size.h, z: topZ() + 1, minimized: false }]);
    }
    raised.set({ id });
  }
  function reveal(id: string): void {
    update(id, { minimized: false, z: topZ() + 1 });
    raised.set({ id });
  }
  function showMenu(input: MouseEvent | KeyboardEvent, subject: CalendarMenuSubject): void {
    if (!(input.currentTarget instanceof HTMLElement)) return;
    input.preventDefault();
    input.stopPropagation();
    const anchor = subject.kind === "event" ? input.currentTarget.querySelector("button") ?? input.currentTarget : input.currentTarget;
    const rect = anchor.getBoundingClientRect();
    const mouse = input instanceof MouseEvent && input.button === 2;
    menu.set({ ...subject, x: mouse ? input.clientX : rect.left, y: mouse ? input.clientY : rect.bottom, anchor });
  }

  return {
    filters: readonlySignal(filters),
    agenda,
    windows: readonlySignal(windows),
    raised: readonlySignal(raised),
    replying: readonlySignal(replying),
    menu: readonlySignal(menu),
    topZ,
    setFilter(key: Filter, checked: boolean) { filters.update(current => ({ ...current, [key]: checked })); },
    openDay(day: CalendarDate, keepOtherDays: boolean) {
      open(calendarCaption(day), { kind: "day", day }, keepOtherDays);
    },
    openAgenda(agendaKind: CalendarAgendaKind, keepOtherLists: boolean) {
      open(agendaKind, { kind: "agenda", agendaKind }, keepOtherLists);
    },
    openEvent(event: CalendarEvent) { open(`event-${event.eventID}`, { kind: "event", event }, true); },
    newEvent(day: CalendarDate) {
      const now = flow.calendarNow();
      const today = calendarDate(new Date(now));
      if (calendarDayStart(day) < calendarDayStart(today)) {
        flow.reportCalendarPastDay();
        day = today;
      }
      open(`create-${calendarCaption(day)}`, { kind: "create", startsAt: newCalendarEventStart(day, now) }, true);
    },
    showEventMenu(input: MouseEvent | KeyboardEvent, row: CalendarRow, allowJump: boolean) {
      showMenu(input, { kind: "event", row, allowJump });
    },
    showDayMenu(input: MouseEvent | KeyboardEvent, day: CalendarDate) { showMenu(input, { kind: "day", day }); },
    closeMenu() { menu.set(null); },
    registerDayJump(select: (day: CalendarDate) => void) {
      selectDay = select;
      return () => { if (selectDay === select) selectDay = null; };
    },
    jumpToDay(day: CalendarDate) { selectDay?.(day); },
    async reply(event: CalendarEvent, status: CalendarReply) {
      const { eventID, ownerID } = event;
      if (replying.get().has(eventID)) return;
      replying.update(ids => new Set([...ids, eventID]));
      try {
        await flow.respondToCalendarEvent(eventID, ownerID, status);
        windows.update(wins => wins.filter(win => win.id !== `event-${eventID}`));
      } finally {
        replying.update(ids => new Set([...ids].filter(id => id !== eventID)));
      }
    },
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
    view = createCalendarView(flow);
    views.set(flow, view);
  }
  return view;
}
