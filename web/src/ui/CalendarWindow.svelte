<script lang="ts">
  // The client's Calendar (shared/eveCalendar.py CalendarWnd: caption UI/Calendar/CalendarWindow/Caption, at least
  // 580 x 400). Its left side 150 wide: New Event at the top; Upcoming Events (the pilot's next events) and Latest
  // Updates; the Filters checkboxes at the bottom (Personal, Corporation, Alliance, CCP, Automated, Declined Events,
  // Show Timestamp). At the right the month (Calendar): the back / forward arrows, the month and year
  // (MonthsWithYear), Today at the right; the day names' header row (UI/Moonmining/<Day>Short, Monday first:
  // calendar.Calendar()) and NUM_DAYROWS 6 rows of days, the days out of the month dimmed, today marked, each day's
  // events listed in it. The month uses calendarProxy.GetEventList for the month in view; the upcoming list uses
  // the Activity Center's agenda.
  import { onMount } from "svelte";
  import { plainText, formatTemplate } from "../bridge/clientWords.ts";
  import { filetimeToUnixMs } from "../bridge/activity.ts";
  import type { CalendarEvent } from "../bridge/calendar.ts";
  import { isNpcCorporation } from "../bridge/standingsReads.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const activity = store.activity;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const WORDS = {
    newEvent: "UI/Calendar/CalendarWindow/NewEvent", upcoming: "UI/Calendar/CalendarWindow/UpcomingEvents",
    updates: "UI/Calendar/CalendarWindow/LatestUpdates", filters: "UI/Calendar/CalendarWindow/Filters", today: "UI/Calendar/CalendarWindow/Today",
    personal: "UI/Calendar/CalendarWindow/GroupPersonal", corp: "UI/Calendar/CalendarWindow/GroupCorp", alliance: "UI/Calendar/CalendarWindow/GroupAlliance",
    ccp: "UI/Calendar/CalendarWindow/GroupCcp", automated: "UI/Calendar/CalendarWindow/GroupAutomated", declined: "UI/Calendar/CalendarWindow/DeclinedEvents",
    timestamp: "UI/Calendar/CalendarWindow/ShowTimestamp",
    previous: "UI/Calendar/Hints/Previous", next: "UI/Calendar/Hints/Next",
  } as const;
  const FILTERS = ["personal", "corp", "alliance", "ccp", "automated", "declined", "timestamp"] as const;
  // appConst.calendarViewRangeInMonths, calendarTag* and eventResponse*.
  const VIEW_RANGE = 12;
  const TAGS = { personal: 1, corp: 2, alliance: 4, ccp: 8, automated: 16 } as const;
  const TAG_KEYS = Object.keys(TAGS) as (keyof typeof TAGS)[];
  const RESPONSE_DELETED = 1, RESPONSE_DECLINED = 2;
  const word = (label: string, own: string, args: Readonly<Record<string, string | number>> = {}): string => {
    const t = $words.templates[label];
    return typeof t === "string" && t !== "" ? plainText(formatTemplate(t, args, { nameOf: () => "" })) : own;
  };
  onMount(() => {
    flow.requestWords([...Object.values(WORDS), ...MONTHS.map((m) => `/Carbon/UI/Common/MonthsWithYear/${m}`), ...DAYS.map((d) => `UI/Moonmining/${d}Short`)]);
    if ($activity.calendarEvents.status !== "ready" || $activity.calendarResponses.status !== "ready") {
      void flow.loadActivity().catch(() => {});
    }
  });

  const now = new Date();
  const today = { y: now.getUTCFullYear(), m: now.getUTCMonth(), d: now.getUTCDate() };
  let view = $state({ y: today.y, m: today.m });
  const monthOffset = $derived((view.y - today.y) * 12 + view.m - today.m);
  let filters = $state<Record<(typeof FILTERS)[number], boolean>>({ personal: true, corp: true, alliance: true, ccp: true, automated: true, declined: true, timestamp: true });
  const visibleFilters = $derived(FILTERS.filter(filter => {
    if (filter === "corp") {
      const id = $station.online?.corporationID ?? null;
      return id !== null && id > 0 && !isNpcCorporation(id);
    }
    if (filter === "alliance") return ($station.online?.allianceID ?? 0) > 0;
    return true;
  }));
  const tagMask = $derived(TAG_KEYS.reduce((mask, key) => filters[key] ? mask | TAGS[key] : mask, 0));

  let monthEvents = $state<readonly CalendarEvent[]>([]);
  let monthStatus = $state<"loading" | "ready" | "error">("loading");
  $effect(() => {
    const { y, m } = view;
    let current = true;
    monthEvents = [];
    monthStatus = "loading";
    void flow.loadCalendarMonth(m + 1, y).then(rows => {
      if (!current) return;
      monthEvents = rows;
      monthStatus = "ready";
    }, () => {
      if (current) monthStatus = "error";
    });
    return () => { current = false; };
  });

  const events = $derived($activity.calendarEvents.status === "ready" ? $activity.calendarEvents.value : []);
  const responses = $derived(new Map($activity.calendarResponses.value?.map(row => [row.eventID, row.status])));
  const eventsByDay = $derived.by(() => {
    const map = new Map<number, { id: number; title: string; at: number }[]>();
    for (const e of monthEvents) {
      const response = responses.get(e.eventID);
      if (e.isDeleted || !(tagMask & e.flag) || response === RESPONSE_DELETED || (response === RESPONSE_DECLINED && !filters.declined)) continue;
      const ms = filetimeToUnixMs(e.eventDateTime);
      if (ms === null) continue;
      const d = new Date(ms);
      if (d.getUTCFullYear() !== view.y || d.getUTCMonth() !== view.m) continue;
      const day = d.getUTCDate();
      const row = { id: e.eventID, title: e.eventTitle, at: ms };
      const list = map.get(day);
      if (list) list.push(row);
      else map.set(day, [row]);
    }
    for (const list of map.values()) list.sort((a, b) => a.at - b.at || a.title.localeCompare(b.title));
    return map;
  });
  const upcoming = $derived(events.map((e) => ({ title: e.title, at: filetimeToUnixMs(e.eventDateTime) })).filter((e): e is { title: string; at: number } => e.at !== null && e.at >= Date.now())
    .sort((a, b) => a.at - b.at).slice(0, 20));
  /** calendar.Calendar().monthdayscalendar, Monday first, filled out to six rows with the months either side. */
  const grid = $derived.by(() => {
    const first = new Date(Date.UTC(view.y, view.m, 1));
    const lead = (first.getUTCDay() + 6) % 7;
    const days: { y: number; m: number; d: number; out: boolean }[] = [];
    for (let i = 0; i < 42; i++) {
      const date = new Date(Date.UTC(view.y, view.m, 1 - lead + i));
      days.push({ y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate(), out: date.getUTCMonth() !== view.m });
    }
    return days;
  });
  function browse(step: number): void {
    if (Math.abs(monthOffset + step) > VIEW_RANGE) return;
    const date = new Date(Date.UTC(view.y, view.m + step, 1));
    view = { y: date.getUTCFullYear(), m: date.getUTCMonth() };
  }
  const time = (ms: number): string => { const d = new Date(ms); return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
  const dateText = (ms: number): string => { const d = new Date(ms); return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")}`; };
</script>

<section class="panel calendar-wnd">
  <div class="cal-left">
    <button type="button" class="cal-new" disabled title="Not on the play page yet">{word(WORDS.newEvent, "New Event")}</button>
    <div class="cal-lists">
      <b>{word(WORDS.upcoming, "Upcoming Events")}</b>
      <div class="cal-list">
        {#each upcoming as e, i (i)}<div class="cal-entry"><small>{dateText(e.at)} {time(e.at)}</small><span>{e.title}</span></div>{/each}
      </div>
      <b>{word(WORDS.updates, "Latest Updates")}</b>
      <div class="cal-list short"></div>
    </div>
    <div class="cal-filters">
      <b>{word(WORDS.filters, "Filters")}</b>
      {#each visibleFilters as f (f)}
        <label><input type="checkbox" bind:checked={filters[f]} /> {word(WORDS[f], f)}</label>
      {/each}
    </div>
  </div>
  <div class="cal-month">
    <div class="cal-head">
      <button type="button" class="cal-arrow" onclick={() => browse(-1)} disabled={monthOffset <= -VIEW_RANGE}
        aria-label={word(WORDS.previous, "Previous")} title={word(WORDS.previous, "Previous")}><img src="/client-res/ui/texture/eveicon/system_icons/navigate_back_16px.png" alt="" /></button>
      <button type="button" class="cal-arrow" onclick={() => browse(1)} disabled={monthOffset >= VIEW_RANGE}
        aria-label={word(WORDS.next, "Next")} title={word(WORDS.next, "Next")}><img src="/client-res/ui/texture/eveicon/system_icons/navigate_forward_16px.png" alt="" /></button>
      <span class="cal-title">{word(`/Carbon/UI/Common/MonthsWithYear/${MONTHS[view.m]}`, `${MONTHS[view.m]} ${view.y}`, { year: view.y })}</span>
      <button type="button" class="cal-today" onclick={() => (view = { y: today.y, m: today.m })}>{word(WORDS.today, "Today")}</button>
    </div>
    {#if monthStatus !== "ready"}
      <div class="cal-month-status" role="status">{monthStatus === "error" ? "Calendar events could not be read." : "Loading…"}</div>
    {/if}
    <div class="cal-grid">
      {#each DAYS as d (d)}<div class="cal-dayname">{word(`UI/Moonmining/${d}Short`, d.slice(0, 3))}</div>{/each}
      {#each grid as day (`${day.y}-${day.m}-${day.d}`)}
        <div class="cal-day" class:out={day.out} class:today={!day.out && day.y === today.y && day.m === today.m && day.d === today.d}>
          <span class="num">{day.d}</span>
          {#each (day.out ? [] : eventsByDay.get(day.d) ?? []) as e (e.id)}
            <span class="ev" title={e.title}>{filters.timestamp ? `${time(e.at)} ` : ""}{e.title}</span>
          {/each}
        </div>
      {/each}
    </div>
  </div>
</section>

<style>
  .calendar-wnd { display: flex; gap: 6px; height: 100%; min-height: 360px; }
  .cal-left { flex: 0 0 150px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .cal-new { margin-top: 7px; font-size: 12px; padding: 2px 6px; }
  .cal-lists { flex: 1; display: flex; flex-direction: column; gap: 4px; min-height: 0; }
  .cal-lists b, .cal-filters b { font-size: 12px; height: 18px; }
  .cal-list { flex: 1; min-height: 60px; overflow: auto; border: 1px solid rgba(255, 255, 255, 0.08); font-size: 11px; }
  .cal-list.short { flex: 0 0 60px; }
  .cal-entry { display: flex; flex-direction: column; padding: 2px 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  .cal-entry small { opacity: 0.6; }
  .cal-filters { display: flex; flex-direction: column; font-size: 12px; gap: 0; padding-top: 3px; }
  .cal-filters label { display: flex; align-items: center; gap: 4px; height: 17px; white-space: nowrap; overflow: hidden; }
  .cal-filters input { width: 12px; height: 12px; margin: 0; }
  .cal-month { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .cal-head { position: relative; display: flex; align-items: center; gap: 4px; height: 32px; }
  .cal-arrow { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; }
  .cal-arrow img { width: 16px; height: 16px; }
  .cal-arrow:disabled { opacity: 0.3; }
  .cal-title { position: absolute; left: 50%; transform: translateX(-50%); font-size: 16px; pointer-events: none; }
  .cal-month-status { font-size: 11px; color: var(--color-text-muted, #aab0b4); }
  .cal-today { margin-left: auto; font-size: 12px; height: 20px; padding: 0 8px; }
  .cal-grid { flex: 1; display: grid; grid-template-columns: repeat(7, 1fr); grid-template-rows: 24px repeat(6, 1fr); gap: 2px; min-height: 0; }
  .cal-dayname { display: flex; align-items: flex-end; justify-content: center; font-size: 11px; opacity: 0.7; }
  .cal-day { border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(255, 255, 255, 0.03); padding: 2px; overflow: hidden;
    display: flex; flex-direction: column; font-size: 10px; min-height: 0; }
  .cal-day.out { opacity: 0.4; }
  .cal-day.today { border-color: rgba(255, 255, 255, 0.6); background: rgba(255, 255, 255, 0.08); }
  .cal-day .num { align-self: flex-end; font-size: 11px; }
  .cal-day .ev { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: rgba(255, 255, 255, 0.85); }
</style>
