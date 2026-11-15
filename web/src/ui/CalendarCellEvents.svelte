<script lang="ts">
  import { calendarTime, type CalendarRow } from "./calendarView.ts";

  let { rows, timestamp, more, open, openEvent }: {
    rows: readonly CalendarRow[]; timestamp: boolean; more: string;
    open: (shift: boolean) => void; openEvent: (row: CalendarRow) => void;
  } = $props();
  let area: HTMLElement | undefined = $state();
  let list: HTMLElement | undefined = $state();
  let clipped = $state(false);
  $effect(() => {
    const parent = area, entries = list;
    if (!parent || !entries) return;
    const measure = () => { clipped = entries.scrollHeight > parent.clientHeight; };
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    observer.observe(entries);
    measure();
    return () => observer.disconnect();
  });
</script>

<div class="event-area" bind:this={area}>
  <div class="event-viewport">
    <div bind:this={list}>
      {#each rows as row (row.event.eventID)}
        <button type="button" class="calendar-event-row" title={row.event.eventTitle}
          onclick={event => { event.stopPropagation(); if (event.detail === 0) openEvent(row); }}
          ondblclick={event => { event.stopPropagation(); openEvent(row); }}>
          {#if row.event.importance > 0}<strong>!</strong>{/if}{timestamp ? `${calendarTime(row.at)} ` : ""}{row.event.eventTitle}
        </button>
      {/each}
    </div>
  </div>
  {#if clipped}
    <button type="button" class="calendar-more" aria-label={more} title={more}
      onclick={event => { event.stopPropagation(); open(event.shiftKey); }} ondblclick={event => event.stopPropagation()}>
      <img src="/client-res/ui/texture/icons/38_16_229.png" alt="" />
    </button>
  {/if}
</div>

<style>
  .event-area { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .event-viewport { flex: 1; min-height: 0; overflow: hidden; }
  .event-area button.calendar-event-row { display: block; width: 100%; height: 14px; padding: 0; border: 0;
    font: inherit; line-height: 14px; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #ffffffd9; background: #ffffff0d; }
  .calendar-event-row strong { color: #e26758; padding-right: 2px; }
  .event-area button.calendar-more { flex: 0 0 10px; padding: 0; height: 10px; overflow: hidden; border: 0; background: #fff1; }
  .calendar-more img { width: 16px; height: 16px; vertical-align: top; margin-top: -3px; }
</style>
