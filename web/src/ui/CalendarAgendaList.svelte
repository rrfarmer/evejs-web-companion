<script lang="ts">
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { CALENDAR_GROUPS, CALENDAR_RESPONSES, CALENDAR_RESPONSE_PATH, calendarDateTime, type AgendaState, type CalendarRow } from "./calendarView.ts";

  let { words, title, rows, status, openEvent, openMore }: {
    words: ClientStore["words"]; title: string; rows: readonly CalendarRow[]; status: AgendaState["status"];
    openEvent: (row: CalendarRow) => void; openMore: (shift: boolean) => void;
  } = $props();
  const id = $props.id();
  const texture = "/client-res/ui/texture/";
  const word = (key: string, fallback: string): string => plainText($words.templates[key] ?? "") || fallback;
  let area: HTMLElement | undefined = $state();
  let list: HTMLElement | undefined = $state();
  let clipped = $state(false);

  $effect(() => {
    const viewport = area, content = list;
    if (!viewport || !content) return;
    const measure = () => { clipped = content.scrollHeight - viewport.clientHeight >= 10; };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    measure();
    return () => observer.disconnect();
  });
</script>

<section class="agenda-list" aria-labelledby={id}>
  <b id={id}>{title}</b>
  <div class="agenda-area" bind:this={area}>
    <div class="agenda-viewport">
      <div bind:this={list}>
        {#each rows.slice(0, 25) as row (row.event.eventID)}
          {@const [response, fallback, icon] = CALENDAR_RESPONSES[row.response] ?? CALENDAR_RESPONSES[3]}
          {@const tag = CALENDAR_GROUPS[row.event.flag as keyof typeof CALENDAR_GROUPS]}
          <button type="button" class="agenda-event" onclick={event => { if (event.detail === 0) openEvent(row); }} ondblclick={() => openEvent(row)}>
            <img class="response-icon" src={`${texture}icons/38_16_${icon}.png`} width="16" height="16"
              alt={word(CALENDAR_RESPONSE_PATH + response, fallback)} title={word(CALENDAR_RESPONSE_PATH + response, fallback)} />
            <span class="event-title" title={row.event.eventTitle}>{#if row.event.importance > 0}<strong>!</strong>{/if}{row.event.eventTitle}</span>
            {#if tag && "icon" in tag}
              {@const category = word(`UI/Calendar/CalendarWindow/${tag.label}`, tag.fallback)}
              <img class="tag-icon" src={texture + tag.icon} style:background-color={tag.color} alt={category} title={category} />
            {/if}
            <small>{calendarDateTime(row.at)}</small>
          </button>
        {/each}
        {#if status === "error"}<p role="status">Calendar events could not be read.</p>{/if}
      </div>
    </div>
    {#if clipped}
      <button type="button" class="agenda-more" aria-label={`View all ${title}`} title={title} onclick={event => openMore(event.shiftKey)}>
        <img src={`${texture}icons/38_16_229.png`} alt="" />
      </button>
    {/if}
  </div>
</section>

<style>
  .agenda-list { flex: 1; display: flex; flex-direction: column; min-height: 60px; }
  b { height: 18px; flex: 0 0 18px; font-size: 12px; }
  .agenda-area { flex: 1; min-height: 0; display: flex; flex-direction: column; border: 1px solid #ffffff14; }
  .agenda-viewport { flex: 1; min-height: 0; overflow: hidden; }
  .agenda-area button.agenda-event { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: 0 4px;
    width: 100%; padding: 1px 2px; border: 0; border-radius: 0; background: #fff1; text-align: left; font-size: 11px; }
  .agenda-event + .agenda-event { margin-top: 1px; }
  .event-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .event-title strong { color: #e26758; padding-right: 2px; }
  .tag-icon { grid-column: 3; width: 8px; height: 8px; padding: 2px; }
  small { grid-column: 2 / 4; color: #ffffffb3; font-size: 10px; }
  p { margin: 4px; font-size: 11px; }
  .agenda-area button.agenda-more { flex: 0 0 10px; padding: 0; height: 10px; overflow: hidden; border: 0; background: #fff1; }
  .agenda-more img { width: 16px; height: 16px; vertical-align: top; margin-top: -3px; }
</style>
