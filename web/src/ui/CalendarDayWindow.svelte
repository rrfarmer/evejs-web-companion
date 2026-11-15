<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { CalendarEvent } from "../bridge/calendar.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { CALENDAR_RESPONSES, CALENDAR_RESPONSE_PATH, calendarCaption, calendarRows, calendarTime, calendarView } from "./calendarView.ts";
  import type { CalendarDate } from "./calendarSelection.ts";

  let { flow, store, day, close }: { flow: AppFlow; store: ClientStore; day: CalendarDate; close: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const activity = store.activity;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const model = calendarView(flow);
  const { filters } = model;
  const LABEL = {
    time: "UI/Calendar/SingleDayWindow/Time", title: "UI/Calendar/SingleDayWindow/Title",
    empty: "UI/Calendar/SingleDayWindow/NoPlannedEvents", close: "UI/Generic/Close",
  } as const;
  const FLAG = {
    2: ["GroupCorp", "classes/flagicon/8/1.png", "rgba(26, 153, 26, .75)"],
    4: ["GroupAlliance", "classes/flagicon/8/1.png", "rgba(0, 38, 153, .75)"],
    8: ["GroupCcp", "classes/flagicon/8/2.png", "#b3b3b3bf"],
    16: ["GroupAutomated", "icons/automatedentry_icon_alpha.png", "rgba(26, 153, 26, .75)"],
  } as const;
  const texture = "/client-res/ui/texture/";
  const word = (key: string, fallback: string): string => plainText($words.templates[key] ?? "") || fallback;
  $effect(() => {
    flow.requestWords([...Object.values(LABEL),
      ...CALENDAR_RESPONSES.map(([key]) => CALENDAR_RESPONSE_PATH + key),
      ...Object.values(FLAG).map(([key]) => `UI/Calendar/CalendarWindow/${key}`)]);
  });

  type Month = { state: "loading" | "error" } | { state: "ready"; events: readonly CalendarEvent[] };
  let month: Month = $state({ state: "loading" });
  const yearNumber = $derived(day.y);
  const monthNumber = $derived(day.m + 1);
  $effect(() => {
    let active = true;
    month = { state: "loading" };
    void flow.loadCalendarMonth(monthNumber, yearNumber).then(events => {
      if (active) month = { state: "ready", events };
    }, () => {
      if (active) month = { state: "error" };
    });
    return () => { active = false; };
  });
  const responses = $derived(new Map($activity.calendarResponses.value?.map(row => [row.eventID, row.status])));
  const rows = $derived(month.state === "ready" ? calendarRows(month.events, $filters, responses)
    .filter(row => row.day.y === day.y && row.day.m === day.m && row.day.d === day.d) : []);
</script>

<div class="calendar-single-day" data-calendar-window={calendarCaption(day)}>
  <h2>{calendarCaption(day)}</h2>
  <div class="calendar-day-scroll">
    <table>
      <thead><tr><th scope="col">{word(LABEL.time, "Time")}</th><th scope="col">{word(LABEL.title, "Title")}</th></tr></thead>
      <tbody>
        {#each rows as row (row.event.eventID)}
          {@const [response, fallback, icon] = CALENDAR_RESPONSES[row.response] ?? CALENDAR_RESPONSES[3]}
          {@const flag = FLAG[row.event.flag as keyof typeof FLAG]}
          <!-- The same row opens from the keyboard through the title button. -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <tr ondblclick={() => model.openEvent(row.event)}>
            <td class="when"><img src={`${texture}icons/38_16_${icon}.png`} width="16" height="16"
              alt={word(CALENDAR_RESPONSE_PATH + response, fallback)} title={word(CALENDAR_RESPONSE_PATH + response, fallback)} />{calendarTime(row.at)}</td>
            <td class="event-name" title={row.event.eventTitle}>
              <button type="button" class="event-title" onclick={event => { if (event.detail === 0) model.openEvent(row.event); }}>
                {#if row.event.importance > 0}<strong class="important">!</strong>{/if}{row.event.eventTitle}
              </button>
              {#if flag}
                {@const type = word(`UI/Calendar/CalendarWindow/${flag[0]}`, flag[0])}
                <img class="calendar-tag" style:background-color={flag[2]} src={texture + flag[1]} alt={type} title={type} />
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if rows.length === 0}
      <p class="calendar-day-status" role="status">{month.state === "loading" ? "Loading…" : month.state === "error" ? "Calendar events could not be read." : word(LABEL.empty, "No planned events")}</p>
    {/if}
  </div>
  <footer><button type="button" onclick={close}>{word(LABEL.close, "Close")}</button></footer>
</div>

<style>
  .calendar-single-day { display: flex; flex-direction: column; height: 100%; padding: 0 6px 6px; box-sizing: border-box; }
  h2 { font-size: 20px; font-weight: 400; margin: 0; padding: 12px 2px; height: 52px; box-sizing: border-box; }
  .calendar-day-scroll { flex: 1; min-height: 0; overflow: auto; border: 1px solid #fff2; }
  table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 12px; }
  th { position: sticky; top: 0; z-index: 1; text-align: left; background: var(--win-bg-focused, #1b2227); }
  th:first-child { width: 74px; }
  th, td { padding: 3px 5px; border-bottom: 1px solid #ffffff12; }
  td { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .when img { vertical-align: middle; margin-right: 5px; }
  .event-name { position: relative; padding-right: 22px; }
  .event-name button.event-title { display: block; width: 100%; padding: 0; border: 0; border-radius: 0; background: transparent;
    font: inherit; color: inherit; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .important { color: #e26758; }
  .calendar-tag { position: absolute; top: 50%; right: 4px; transform: translateY(-50%); width: 8px; height: 8px; padding: 2px; }
  .calendar-day-status { text-align: center; font-size: 12px; opacity: .7; }
  footer { display: flex; justify-content: center; padding-top: 6px; }
</style>
