<script lang="ts">
  // The client's Calendar (shared/eveCalendar.py CalendarWnd: caption UI/Calendar/CalendarWindow/Caption, at least
  // 580 x 400). Its left side 150 wide: New Event at the top; Upcoming Events (the pilot's next events) and Latest
  // Updates; the Filters checkboxes at the bottom (Personal, Corporation, Alliance, CCP, Automated, Declined Events,
  // Show Timestamp). At the right the month (Calendar): the back / forward arrows, the month and year
  // (MonthsWithYear), Today at the right; the day names' header row (UI/Moonmining/<Day>Short, Monday first:
  // calendar.Calendar()) and NUM_DAYROWS 6 rows of days, the days out of the month dimmed, today marked, each day's
  // events listed in it. The month uses calendarProxy.GetEventList for the month in view; the sidebar reads the
  // current and next months with the pilot's responses.
  import { onMount, tick } from "svelte";
  import { plainText, formatTemplate } from "../bridge/clientWords.ts";
  import type { CalendarEvent } from "../bridge/calendar.ts";
  import { isNpcCorporation } from "../bridge/standingsReads.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { calendarDate, calendarGrid, calendarMonthOffset, stepCalendarDate, type CalendarDate } from "./calendarSelection.ts";
  import { CALENDAR_AGENDA_LABELS, CALENDAR_FILTERS, CALENDAR_GROUPS, CALENDAR_RESPONSES, CALENDAR_RESPONSE_PATH,
    calendarAgendaRows, calendarResponses, calendarRows, calendarView, type CalendarRow } from "./calendarView.ts";
  import CalendarAgendaList from "./CalendarAgendaList.svelte";
  import CalendarCellEvents from "./CalendarCellEvents.svelte";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const monthHeading = $props.id();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const model = calendarView(flow);
  const { filters, agenda } = model;
  // svelte-ignore state_referenced_locally
  const calendarUpdated = flow.calendarUpdated;
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const WORDS = {
    newEvent: "UI/Calendar/CalendarWindow/NewEvent", filters: "UI/Calendar/CalendarWindow/Filters", today: "UI/Calendar/CalendarWindow/Today",
    personal: "UI/Calendar/CalendarWindow/GroupPersonal", corp: "UI/Calendar/CalendarWindow/GroupCorp", alliance: "UI/Calendar/CalendarWindow/GroupAlliance",
    ccp: "UI/Calendar/CalendarWindow/GroupCcp", automated: "UI/Calendar/CalendarWindow/GroupAutomated", declined: "UI/Calendar/CalendarWindow/DeclinedEvents",
    timestamp: "UI/Calendar/CalendarWindow/ShowTimestamp",
    previous: "UI/Calendar/Hints/Previous", next: "UI/Calendar/Hints/Next",
    viewDay: "/Carbon/UI/Calendar/ViewDay",
  } as const;
  // appConst.calendarViewRangeInMonths.
  const VIEW_RANGE = 12;
  const word = (label: string, own: string, args: Readonly<Record<string, string | number>> = {}): string => {
    const t = $words.templates[label];
    return typeof t === "string" && t !== "" ? plainText(formatTemplate(t, args, { nameOf: () => "" })) : own;
  };
  onMount(() => {
    flow.requestWords([...Object.values(WORDS), ...Object.values(CALENDAR_AGENDA_LABELS).map(([key]) => key),
      ...Object.values(CALENDAR_GROUPS).map(tag => `UI/Calendar/CalendarWindow/${tag.label}`),
      ...CALENDAR_RESPONSES.map(([key]) => CALENDAR_RESPONSE_PATH + key),
      ...MONTHS.map((m) => `/Carbon/UI/Common/MonthsWithYear/${m}`), ...DAYS.map((d) => `UI/Moonmining/${d}Short`)]);
    return model.registerDayJump(day => selectDay(day, true));
  });

  const today = calendarDate(new Date());
  let view = $state({ y: today.y, m: today.m });
  let selected = $state(today.d);
  let gridElement: HTMLElement | undefined = $state();
  const monthOffset = $derived(calendarMonthOffset(view, today));
  const visibleFilters = $derived(CALENDAR_FILTERS.filter(filter => {
    if (filter === "corp") {
      const id = $station.online?.corporationID ?? null;
      return id !== null && id > 0 && !isNpcCorporation(id);
    }
    if (filter === "alliance") return ($station.online?.allianceID ?? 0) > 0;
    return true;
  }));

  let monthEvents = $state<readonly CalendarEvent[]>([]);
  let monthStatus = $state<"loading" | "ready" | "error">("loading");
  $effect(() => {
    $calendarUpdated;
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

  const responses = $derived(calendarResponses($agenda));
  const eventsByDay = $derived.by(() => {
    const map = new Map<number, CalendarRow[]>();
    for (const row of calendarRows(monthEvents, $filters, responses)) {
      if (row.day.y !== view.y || row.day.m !== view.m) continue;
      const list = map.get(row.day.d);
      if (list) list.push(row);
      else map.set(row.day.d, [row]);
    }
    return map;
  });
  const agendaRows = $derived(calendarAgendaRows($agenda, $filters));
  const grid = $derived(calendarGrid(view.y, view.m));
  const weeks = $derived(Array.from({ length: 6 }, (_, i) => grid.slice(i * 7, (i + 1) * 7)));
  const dateLabel = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeZone: "UTC" });

  function selectDay(day: CalendarDate, focus = false): void {
    if (Math.abs(calendarMonthOffset(day, today)) > VIEW_RANGE) return;
    if (day.y !== view.y || day.m !== view.m) view = { y: day.y, m: day.m };
    selected = day.d;
    if (focus) void tick().then(() => gridElement?.querySelector<HTMLElement>('[tabindex="0"]')?.focus());
  }

  function browse(step: -1 | 1): void {
    selectDay(stepCalendarDate({ ...view, d: selected }, step, "month"));
  }

  function navigateDays(event: KeyboardEvent): void {
    const { key } = event;
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    if (key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      model.openDay({ ...view, d: selected }, event.shiftKey);
      return;
    }
    const vertical = key === "ArrowUp" || key === "ArrowDown";
    if (!vertical && key !== "ArrowLeft" && key !== "ArrowRight") return;
    const step = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
    event.preventDefault();
    event.stopPropagation();
    selectDay(stepCalendarDate({ ...view, d: selected }, step, vertical ? "week" : "day"), true);
  }
</script>

<section class="panel calendar-wnd">
  <div class="cal-left">
    <button type="button" class="cal-new" disabled title="Not on the play page yet">{word(WORDS.newEvent, "New Event")}</button>
    <div class="cal-lists">
      <CalendarAgendaList {words} title={word(...CALENDAR_AGENDA_LABELS.upcoming)} rows={agendaRows.upcoming} status={$agenda.status}
        openMore={keep => model.openAgenda("upcoming", keep)} openEvent={row => model.openEvent(row.event)}
        openMenu={(event, row) => model.showEventMenu(event, row, true)} />
      <CalendarAgendaList {words} title={word(...CALENDAR_AGENDA_LABELS.updates)} rows={agendaRows.updates} status={$agenda.status}
        openMore={keep => model.openAgenda("updates", keep)} openEvent={row => model.openEvent(row.event)}
        openMenu={(event, row) => model.showEventMenu(event, row, true)} />
    </div>
    <div class="cal-filters">
      <b>{word(WORDS.filters, "Filters")}</b>
      {#each visibleFilters as f (f)}
        <label><input type="checkbox" checked={$filters[f]} onchange={event => model.setFilter(f, event.currentTarget.checked)} /> {word(WORDS[f], f)}</label>
      {/each}
    </div>
  </div>
  <div class="cal-month">
    <div class="cal-head">
      <button type="button" class="cal-arrow" onclick={() => browse(-1)} disabled={monthOffset <= -VIEW_RANGE}
        aria-label={word(WORDS.previous, "Previous")} title={word(WORDS.previous, "Previous")}><img src="/client-res/ui/texture/eveicon/system_icons/navigate_back_16px.png" alt="" /></button>
      <button type="button" class="cal-arrow" onclick={() => browse(1)} disabled={monthOffset >= VIEW_RANGE}
        aria-label={word(WORDS.next, "Next")} title={word(WORDS.next, "Next")}><img src="/client-res/ui/texture/eveicon/system_icons/navigate_forward_16px.png" alt="" /></button>
      <span class="cal-title" id={monthHeading}>{word(`/Carbon/UI/Common/MonthsWithYear/${MONTHS[view.m]}`, `${MONTHS[view.m]} ${view.y}`, { year: view.y })}</span>
      <button type="button" class="cal-today" onclick={() => selectDay(today)}>{word(WORDS.today, "Today")}</button>
    </div>
    {#if monthStatus !== "ready"}
      <div class="cal-month-status" role="status">{monthStatus === "error" ? "Calendar events could not be read." : "Loading…"}</div>
    {/if}
    <div class="cal-grid" role="grid" aria-labelledby={monthHeading} bind:this={gridElement}>
      <div class="cal-week" role="row">
        {#each DAYS as d (d)}<div class="cal-dayname" role="columnheader">{word(`UI/Moonmining/${d}Short`, d.slice(0, 3))}</div>{/each}
      </div>
      {#each weeks as week}
        <div class="cal-week" role="row">
          {#each week as day (`${day.y}-${day.m}-${day.d}`)}
            {@const out = day.m !== view.m}
            {@const isToday = !out && day.y === today.y && day.m === today.m && day.d === today.d}
            {@const isSelected = !out && day.d === selected}
            {@const dayRows = out ? [] : eventsByDay.get(day.d) ?? []}
            <div class="cal-day" role="gridcell" class:out class:today={isToday} class:selected={isSelected}
              aria-label={dateLabel.format(Date.UTC(day.y, day.m, day.d))} aria-selected={isSelected}
              aria-current={isToday ? "date" : undefined} tabindex={out ? undefined : isSelected ? 0 : -1}
              onmousedown={event => { if (out) event.preventDefault(); }}
              onclick={() => { if (!out) selectDay(day, true); }}
              ondblclick={event => { if (out) selectDay(day, true); else model.openDay(day, event.shiftKey); }} onkeydown={navigateDays}>
              <span class="num">{day.d}</span>
              {#if dayRows.length}
                <CalendarCellEvents rows={dayRows} timestamp={$filters.timestamp} more={word(WORDS.viewDay, "View Day")}
                  open={shift => model.openDay(day, shift)} openEvent={row => model.openEvent(row.event)}
                  openMenu={(event, row) => model.showEventMenu(event, row, false)} />
              {/if}
            </div>
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
  .cal-filters b { font-size: 12px; height: 18px; }
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
  .cal-week { display: contents; }
  .cal-dayname { display: flex; align-items: flex-end; justify-content: center; font-size: 11px; opacity: 0.7; }
  .cal-day { border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(255, 255, 255, 0.03); padding: 2px; overflow: hidden;
    display: flex; flex-direction: column; font-size: 10px; min-height: 0; }
  .cal-day.out { opacity: 0.4; }
  .cal-day.today { border-color: rgba(255, 255, 255, 0.6); background: rgba(255, 255, 255, 0.08); }
  .cal-day.selected { box-shadow: inset 0 0 0 1px var(--theme-focus, #58a7bf); }
  .cal-day:focus-visible { outline: 1px solid var(--theme-focus-bright, #8fd0e6); outline-offset: -2px; }
  .cal-day .num { align-self: flex-end; font-size: 11px; }
</style>
