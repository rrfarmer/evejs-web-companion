<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import type { Session } from "../app/sessions.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { filetimeToUnixMs } from "../bridge/activity.ts";
  import CalendarContextMenu from "./CalendarContextMenu.svelte";
  import CalendarEventEditor from "./CalendarEventEditor.svelte";
  import CalendarListWindow from "./CalendarListWindow.svelte";
  import CalendarEventWindow from "./CalendarEventWindow.svelte";
  import DesktopWindow from "./DesktopWindow.svelte";
  import { CALENDAR_AGENDA_LABELS, CALENDAR_CREATE_CAPTION, CALENDAR_EDIT_CAPTION, CALENDAR_EVENT_CAPTION, CALENDAR_WINDOW_SIZES, calendarView } from "./calendarView.ts";
  import type { InfoWindowHost } from "./infoWindowHost.ts";
  import { portal } from "./portal.ts";

  let { session, inFront, host }: { session: Session; inFront: boolean; host: InfoWindowHost | null } = $props();
  // svelte-ignore state_referenced_locally
  const model = calendarView(session.flow);
  // svelte-ignore state_referenced_locally
  const words = session.store.words;
  const { windows, raised, menu } = model;
  onMount(() => session.flow.calendarEventChanged.subscribe(model.applyEventNotice));
  const eventCaption = $derived(plainText($words.templates[CALENDAR_EVENT_CAPTION] ?? "") || "Event");
  function titleOf(win: (typeof $windows)[number]): string {
    if (win.kind === "event") return win.editing ? plainText($words.templates[CALENDAR_EDIT_CAPTION] ?? "") || "Edit Event" : eventCaption;
    if (win.kind === "create") return plainText($words.templates[CALENDAR_CREATE_CAPTION] ?? "") || "New Event";
    if (win.kind === "day") return win.id;
    const [key, fallback] = CALENDAR_AGENDA_LABELS[win.agendaKind];
    return plainText($words.templates[key] ?? "") || fallback;
  }
  let layer: HTMLElement | undefined = $state();
  const visible = $derived(inFront && host !== null);
  $effect(() => { if (!visible) model.closeMenu(); });
  const front = $derived($windows.filter(win => !win.minimized).reduce<(typeof $windows)[number] | null>(
    (prev, win) => !prev || win.z > prev.z ? win : prev, null));

  function fit(): void {
    if (!host || host.mobile) return;
    const { clientWidth: width, clientHeight: height } = host.element;
    if (!width || !height) return;
    for (const win of windows.get()) {
      const w = Math.min(win.w, width), h = Math.min(win.h, height);
      const x = Math.min(Math.max(0, win.x), width - w), y = Math.min(Math.max(0, win.y), height - h);
      if (w !== win.w || h !== win.h || x !== win.x || y !== win.y) model.update(win.id, { w, h, x, y });
    }
  }
  $effect(() => {
    if (!visible || !host || host.mobile) return;
    const observer = new ResizeObserver(fit);
    observer.observe(host.element);
    untrack(fit);
    return () => observer.disconnect();
  });
  $effect(() => {
    if ($windows.some(win => win.kind === "event" || win.kind === "create")) {
      session.flow.requestWords([CALENDAR_EVENT_CAPTION, CALENDAR_CREATE_CAPTION, CALENDAR_EDIT_CAPTION]);
    }
  });
  let served: { readonly id: string } | null = null;
  $effect(() => {
    const request = $raised;
    if (!visible || !request || served === request) return;
    served = request;
    untrack(() => {
      host?.reveal();
      model.focus(request.id, (host?.topZ() ?? 0) + 1);
      fit();
    });
    void tick().then(() => {
      if (served !== request) return;
      const win = layer?.querySelector(`[data-calendar-window="${request.id}"]`);
      win?.querySelector<HTMLElement>("input[name=calendar-title], footer button:last-child")?.focus();
    });
  });
</script>

{#if visible && $menu}
  <CalendarContextMenu flow={session.flow} store={session.store} menu={$menu} />
{/if}

{#if visible && $windows.length > 0}
<div class="calendar-window-layer" use:portal={host!.element} bind:this={layer}>
  {#each $windows as win (win.id)}
    {@const min = CALENDAR_WINDOW_SIZES[win.kind]}
    {@const title = titleOf(win)}
    <DesktopWindow win={host?.mobile ? { ...win, x: 4, y: 4, w: Math.max(0, host.element.clientWidth - 8), h: min.h, minimized: win.minimized || front?.id !== win.id } : win}
      {title} focused={front?.id === win.id && win.z >= (host?.topZ() ?? 0)} resizable={!host?.mobile}
      onFocus={() => model.focus(win.id, (host?.topZ() ?? 0) + 1)} onClose={() => model.close(win.id)}
      onToggleMinimize={() => model.toggleMinimize(win.id)} onMove={(x, y) => model.update(win.id, { x, y })}
      onResize={(w, h) => { model.update(win.id, { w: Math.max(min.w, w), h: Math.max(min.h, h) }); fit(); }}>
      {#if win.kind === "event"}
        {#if win.editing}
          <CalendarEventEditor flow={session.flow} store={session.store} id={win.id} existing={win.event}
            startsAt={filetimeToUnixMs(win.event.eventDateTime) ?? session.flow.calendarNow()} close={() => model.close(win.id)} />
        {:else}
          <CalendarEventWindow flow={session.flow} store={session.store} event={win.event} close={() => model.close(win.id)} />
        {/if}
      {:else if win.kind === "create"}<CalendarEventEditor flow={session.flow} store={session.store} id={win.id} startsAt={win.startsAt} close={() => model.close(win.id)} />
      {:else}<CalendarListWindow flow={session.flow} store={session.store} subject={win} {title} close={() => model.close(win.id)} />{/if}
    </DesktopWindow>
  {/each}
  {#if host?.mobile}
    <nav aria-label="Open Calendar windows">
      {#each $windows as win (win.id)}<button type="button" aria-pressed={front?.id === win.id} onclick={() => model.reveal(win.id)}>{win.kind === "event" ? win.event.eventTitle : titleOf(win)}</button>{/each}
    </nav>
  {/if}
</div>
{/if}

<style>
  .calendar-window-layer { position: absolute; inset: 0; pointer-events: none; }
  .calendar-window-layer :global(.win), nav { pointer-events: auto; }
  nav { position: absolute; z-index: 1; bottom: 0; display: flex; flex-wrap: wrap; }
</style>
