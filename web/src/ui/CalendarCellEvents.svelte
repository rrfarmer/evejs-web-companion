<script lang="ts">
  import { calendarTime, type CalendarRow } from "./calendarView.ts";

  let { rows, timestamp, more, open }: { rows: readonly CalendarRow[]; timestamp: boolean; more: string; open: (shift: boolean) => void } = $props();
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
        <span class="ev" title={row.event.eventTitle}>{timestamp ? `${calendarTime(row.at)} ` : ""}{row.event.eventTitle}</span>
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
  .ev { display: block; height: 14px; line-height: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #ffffffd9; }
  .event-area button.calendar-more { flex: 0 0 10px; padding: 0; height: 10px; overflow: hidden; border: 0; background: #fff1; }
  .calendar-more img { width: 16px; height: 16px; vertical-align: top; margin-top: -3px; }
</style>
