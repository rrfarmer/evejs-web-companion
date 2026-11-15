<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { Session } from "../app/sessions.ts";
  import CalendarDayWindow from "./CalendarDayWindow.svelte";
  import DesktopWindow from "./DesktopWindow.svelte";
  import { CALENDAR_DAY_SIZE, calendarView } from "./calendarView.ts";
  import type { InfoWindowHost } from "./infoWindowHost.ts";
  import { portal } from "./portal.ts";

  let { session, inFront, host }: { session: Session; inFront: boolean; host: InfoWindowHost | null } = $props();
  // svelte-ignore state_referenced_locally
  const model = calendarView(session.flow);
  const { days, raised } = model;
  let layer: HTMLElement | undefined = $state();
  const visible = $derived(inFront && host !== null);
  const frontDay = $derived($days.filter(day => !day.minimized).reduce<(typeof $days)[number] | null>(
    (front, day) => !front || day.z > front.z ? day : front, null));

  function fit(): void {
    if (!host || host.mobile) return;
    const { clientWidth: width, clientHeight: height } = host.element;
    if (!width || !height) return;
    for (const win of days.get()) {
      const w = Math.min(win.w, width), h = Math.min(win.h, height);
      const x = Math.min(Math.max(0, win.x), width - w), y = Math.min(Math.max(0, win.y), height - h);
      if (w !== win.w || h !== win.h || x !== win.x || y !== win.y) model.updateDay(win.id, { w, h, x, y });
    }
  }
  $effect(() => {
    if (!visible || !host || host.mobile) return;
    const observer = new ResizeObserver(fit);
    observer.observe(host.element);
    untrack(fit);
    return () => observer.disconnect();
  });
  let served: { readonly id: string } | null = null;
  $effect(() => {
    const request = $raised;
    if (!visible || !request || served === request) return;
    served = request;
    untrack(() => {
      host?.reveal();
      model.focusDay(request.id, (host?.topZ() ?? 0) + 1);
      fit();
    });
    void tick().then(() => {
      if (served === request) layer?.querySelector<HTMLElement>(`[data-calendar-day="${request.id}"] footer button`)?.focus();
    });
  });
</script>

{#if visible && $days.length > 0}
<div class="calendar-day-layer" use:portal={host!.element} bind:this={layer}>
  {#each $days as win (win.id)}
    <DesktopWindow win={host?.mobile ? { ...win, x: 4, y: 4, w: Math.max(0, host.element.clientWidth - 8), h: CALENDAR_DAY_SIZE.h, minimized: win.minimized || frontDay?.id !== win.id } : win}
      title={win.id} focused={frontDay?.id === win.id && win.z >= (host?.topZ() ?? 0)} resizable={!host?.mobile}
      onFocus={() => model.focusDay(win.id, (host?.topZ() ?? 0) + 1)} onClose={() => model.closeDay(win.id)}
      onToggleMinimize={() => model.minimizeDay(win.id)} onMove={(x, y) => model.updateDay(win.id, { x, y })}
      onResize={(w, h) => { model.updateDay(win.id, { w: Math.max(CALENDAR_DAY_SIZE.w, w), h: Math.max(CALENDAR_DAY_SIZE.h, h) }); fit(); }}>
      <CalendarDayWindow flow={session.flow} store={session.store} day={win.day} close={() => model.closeDay(win.id)} />
    </DesktopWindow>
  {/each}
  {#if host?.mobile && $days.length > 0}
    <nav aria-label="Open calendar days">
      {#each $days as win (win.id)}<button type="button" aria-pressed={frontDay?.id === win.id} onclick={() => model.openDay(win.day, true)}>{win.id}</button>{/each}
    </nav>
  {/if}
</div>
{/if}

<style>
  .calendar-day-layer { position: absolute; inset: 0; pointer-events: none; }
  .calendar-day-layer :global(.win), nav { pointer-events: auto; }
  nav { position: absolute; z-index: 1; bottom: 0; display: flex; flex-wrap: wrap; }
</style>
