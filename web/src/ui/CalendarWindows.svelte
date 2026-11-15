<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { Session } from "../app/sessions.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import CalendarEventMenu from "./CalendarEventMenu.svelte";
  import CalendarListWindow from "./CalendarListWindow.svelte";
  import CalendarEventWindow from "./CalendarEventWindow.svelte";
  import DesktopWindow from "./DesktopWindow.svelte";
  import { CALENDAR_AGENDA_LABELS, CALENDAR_EVENT_CAPTION, CALENDAR_WINDOW_SIZES, calendarView } from "./calendarView.ts";
  import type { InfoWindowHost } from "./infoWindowHost.ts";
  import { portal } from "./portal.ts";

  let { session, inFront, host }: { session: Session; inFront: boolean; host: InfoWindowHost | null } = $props();
  // svelte-ignore state_referenced_locally
  const model = calendarView(session.flow);
  // svelte-ignore state_referenced_locally
  const words = session.store.words;
  const { windows, raised, eventMenu } = model;
  const eventCaption = $derived(plainText($words.templates[CALENDAR_EVENT_CAPTION] ?? "") || "Event");
  function titleOf(win: (typeof $windows)[number]): string {
    if (win.kind === "event") return eventCaption;
    if (win.kind === "day") return win.id;
    const [key, fallback] = CALENDAR_AGENDA_LABELS[win.agendaKind];
    return plainText($words.templates[key] ?? "") || fallback;
  }
  let layer: HTMLElement | undefined = $state();
  const visible = $derived(inFront && host !== null);
  $effect(() => { if (!visible) model.closeEventMenu(); });
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
  $effect(() => { if ($windows.some(win => win.kind === "event")) session.flow.requestWords([CALENDAR_EVENT_CAPTION]); });
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
      if (served === request) layer?.querySelector<HTMLElement>(`[data-calendar-window="${request.id}"] footer button:last-child`)?.focus();
    });
  });
</script>

{#if visible && $eventMenu}
  <CalendarEventMenu flow={session.flow} store={session.store} menu={$eventMenu} />
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
      {#if win.kind === "event"}<CalendarEventWindow flow={session.flow} store={session.store} event={win.event} close={() => model.close(win.id)} />
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
