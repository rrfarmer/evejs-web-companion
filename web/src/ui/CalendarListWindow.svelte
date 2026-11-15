<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { CalendarEvent } from "../bridge/calendar.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { CALENDAR_AGENDA_LABELS, CALENDAR_GROUPS, CALENDAR_RESPONSES, CALENDAR_RESPONSE_PATH, calendarAgendaRows, calendarCaption,
    calendarDateTime, calendarResponses, calendarRows, calendarTime, calendarView, isCalendarMenuKey, type CalendarListSubject } from "./calendarView.ts";

  let { flow, store, subject, title, close }: { flow: AppFlow; store: ClientStore; subject: CalendarListSubject; title: string; close: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const model = calendarView(flow);
  const { filters, agenda } = model;
  // svelte-ignore state_referenced_locally
  const calendarUpdated = flow.calendarUpdated;
  const LABEL = {
    time: "UI/Calendar/SingleDayWindow/Time", title: "UI/Calendar/SingleDayWindow/Title",
    empty: "UI/Calendar/SingleDayWindow/NoPlannedEvents", close: "UI/Generic/Close",
  } as const;
  const texture = "/client-res/ui/texture/";
  const word = (key: string, fallback: string): string => plainText($words.templates[key] ?? "") || fallback;
  $effect(() => {
    flow.requestWords([...Object.values(LABEL),
      ...CALENDAR_RESPONSES.map(([key]) => CALENDAR_RESPONSE_PATH + key),
      CALENDAR_AGENDA_LABELS.updates[0],
      ...Object.values(CALENDAR_GROUPS).map(tag => `UI/Calendar/CalendarWindow/${tag.label}`)]);
  });

  type Month = { state: "loading" | "error" } | { state: "ready"; events: readonly CalendarEvent[] };
  let month: Month = $state({ state: "loading" });
  const day = $derived(subject.kind === "day" ? subject.day : null);
  const yearNumber = $derived(day?.y);
  const monthNumber = $derived(day?.m);
  const latest = $derived(subject.kind === "agenda" && subject.agendaKind === "updates");
  $effect(() => {
    if (monthNumber === undefined || yearNumber === undefined) return;
    $calendarUpdated;
    let active = true;
    month = { state: "loading" };
    void flow.loadCalendarMonth(monthNumber + 1, yearNumber).then(events => {
      if (active) month = { state: "ready", events };
    }, () => {
      if (active) month = { state: "error" };
    });
    return () => { active = false; };
  });
  const responses = $derived(calendarResponses($agenda));
  const status = $derived(subject.kind === "agenda" ? $agenda.status : month.state);
  const id = $derived(subject.kind === "agenda" ? subject.agendaKind : calendarCaption(subject.day));
  const rows = $derived(subject.kind === "agenda" ? calendarAgendaRows($agenda, $filters)[subject.agendaKind]
    : month.state === "ready" && day ? calendarRows(month.events, $filters, responses)
      .filter(row => row.day.y === day?.y && row.day.m === day?.m && row.day.d === day?.d) : []);
</script>

<div class="calendar-event-list" class:agenda={subject.kind === "agenda"} class:latest data-calendar-window={id}>
  <h2>{title}</h2>
  <div class="calendar-day-scroll">
    <table>
      <thead><tr><th scope="col">{word(LABEL.time, "Time")}</th><th scope="col">{word(LABEL.title, "Title")}</th>
        {#if latest}<th scope="col">{word(...CALENDAR_AGENDA_LABELS.updates)}</th>{/if}</tr></thead>
      <tbody>
        {#each rows as row (row.event.eventID)}
          {@const [response, fallback, icon] = CALENDAR_RESPONSES[row.response] ?? CALENDAR_RESPONSES[3]}
          {@const flag = CALENDAR_GROUPS[row.event.flag as keyof typeof CALENDAR_GROUPS]}
          <!-- The same row opens from the keyboard through the title button. -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <tr ondblclick={() => model.openEvent(row.event)} oncontextmenu={event => model.showEventMenu(event, row, true)}>
            <td class="when"><img src={`${texture}icons/38_16_${icon}.png`} width="16" height="16"
              alt={word(CALENDAR_RESPONSE_PATH + response, fallback)} title={word(CALENDAR_RESPONSE_PATH + response, fallback)} />{day ? calendarTime(row.at) : calendarDateTime(row.at)}</td>
            <td class="event-name" title={row.event.eventTitle}>
              <button type="button" class="event-title" aria-haspopup="menu" onclick={event => { if (event.detail === 0) model.openEvent(row.event); }}
                onkeydown={event => { if (isCalendarMenuKey(event)) model.showEventMenu(event, row, true); }}>
                {#if row.event.importance > 0}<strong class="important">!</strong>{/if}{row.event.eventTitle}
              </button>
              {#if flag && "icon" in flag}
                {@const type = word(`UI/Calendar/CalendarWindow/${flag.label}`, flag.fallback)}
                <img class="calendar-tag" style:background-color={flag.color} src={texture + flag.icon} alt={type} title={type} />
              {/if}
            </td>
            {#if latest}
              {@const modified = row.modified === null ? "—" : calendarDateTime(row.modified)}
              <td title={modified}>{modified}</td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
    {#if rows.length === 0}
      <p class="calendar-day-status" role="status">{status === "loading" ? "Loading…" : status === "error" ? "Calendar events could not be read." : word(LABEL.empty, "No planned events")}</p>
    {/if}
  </div>
  <footer><button type="button" onclick={close}>{word(LABEL.close, "Close")}</button></footer>
</div>

<style>
  .calendar-event-list { display: flex; flex-direction: column; height: 100%; padding: 0 6px 6px; box-sizing: border-box; }
  h2 { font-size: 20px; font-weight: 400; margin: 0; padding: 12px 2px; flex: 0 0 52px; box-sizing: border-box; }
  .calendar-day-scroll { flex: 1; min-height: 0; overflow: auto; border: 1px solid #fff2; }
  table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 12px; }
  th { position: sticky; top: 0; z-index: 1; text-align: left; background: var(--win-bg-focused, #1b2227); }
  th:first-child { width: 74px; }
  .agenda table { font-size: 11px; }
  .agenda th:first-child { width: 111px; }
  .latest th:last-child { width: 91px; }
  th, td { padding: 3px 5px; border-bottom: 1px solid #ffffff12; }
  td { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .when img { display: inline-block; vertical-align: middle; margin-right: 4px; }
  .event-name { position: relative; padding-right: 22px; }
  .event-name button.event-title { display: block; width: 100%; padding: 0; border: 0; border-radius: 0; background: transparent;
    font: inherit; color: inherit; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .important { color: #e26758; }
  .calendar-tag { position: absolute; top: 50%; right: 4px; transform: translateY(-50%); width: 8px; height: 8px; padding: 2px; }
  .calendar-day-status { text-align: center; font-size: 12px; opacity: .7; }
  footer { display: flex; flex: none; position: relative; z-index: 2; justify-content: center; padding-top: 6px; }
</style>
