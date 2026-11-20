<script lang="ts">
  import { MOON_PLAN_BLOCK_MS, MOON_PLAN_HOUR_MS, MOON_PLAN_SPAN_MS, MOON_PLAN_STEP_MS, MOON_PLAN_ZOOM_MS,
    moonPlanFuelBlock, moonPlanMinimum, type MoonPlanRange } from "../bridge/moonMining.ts";

  let { range, selectedAtMs, now, fuelAtMs, disabled, select }: {
    range: MoonPlanRange;
    selectedAtMs: number;
    now: number;
    fuelAtMs: number | null;
    disabled: boolean;
    select: (atMs: number, stepMs?: number) => number;
  } = $props();

  const dayMs = 24 * MOON_PLAN_HOUR_MS;
  const tickLabel = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", timeZone: "UTC" });
  const clockLabel = (atMs: number) => new Date(atMs).toISOString().slice(0, 16);
  const percent = (offset: number, span: number) => 100 * Math.min(1, Math.max(0, offset / span));
  const picked = $derived(clockLabel(selectedAtMs));
  const readyWords = $derived(picked.replace("T", " ") + " UTC");
  const fuelWords = $derived(fuelAtMs === null ? "" : clockLabel(fuelAtMs).replace("T", " ") + " UTC");
  const minAtMs = $derived(moonPlanMinimum(now));
  const fuelBlock = $derived(moonPlanFuelBlock(fuelAtMs, range));
  const coarsePosition = $derived(percent(selectedAtMs - range.startAtMs, MOON_PLAN_SPAN_MS));
  const unselectableStart = $derived(percent(minAtMs - range.startAtMs, MOON_PLAN_SPAN_MS));
  const unselectableEnd = $derived(percent(range.maxAtMs - range.startAtMs, MOON_PLAN_SPAN_MS));
  const weekTicks = $derived.by(() => {
    const firstDay = Math.ceil(range.startAtMs / dayMs) * dayMs;
    const daysToMonday = (8 - new Date(firstDay).getUTCDay()) % 7;
    return Array.from({ length: 8 }, (_, i) => firstDay + (daysToMonday + i * 7) * dayMs);
  });

  // Freeze the zoom window under the pointer while dragging, then center it on the chosen time.
  let draggingFrom = $state<number | null>(null);
  const zoomStart = $derived((draggingFrom ?? selectedAtMs) - MOON_PLAN_ZOOM_MS / 2);
  const zoomPosition = $derived(percent(selectedAtMs - zoomStart, MOON_PLAN_ZOOM_MS));
  const zoomDays = $derived(Array.from({ length: 4 }, (_, i) => Math.ceil(zoomStart / dayMs) * dayMs + i * dayMs));
  const transit = $derived.by(() => {
    const minutes = Math.max(0, Math.floor((selectedAtMs - now) / 60_000));
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${pad(Math.floor(minutes / 1440))}d ${pad(Math.floor(minutes / 60) % 24)}h ${pad(minutes % 60)}m`;
  });

  function editDate(input: HTMLInputElement, part: "day" | "time"): void {
    const date = part === "day" ? input.value : picked.slice(0, 10);
    const time = part === "time" ? input.value : picked.slice(11);
    const value = Date.parse(`${date}T${time}Z`);
    const formatted = clockLabel(Number.isFinite(value) ? select(value) : selectedAtMs);
    input.value = part === "day" ? formatted.slice(0, 10) : formatted.slice(11);
  }

  function seek(input: HTMLInputElement, start: number, step: number): void {
    const selected = select(start + Number(input.value) * step, step);
    input.value = String(Math.round((selected - start) / step));
  }

  function stepOnWheel(node: HTMLInputElement, stepMs: number) {
    const wheel = (event: WheelEvent) => {
      if (disabled || node !== document.activeElement || event.deltaY === 0) return;
      event.preventDefault();
      select(selectedAtMs + Math.sign(event.deltaY) * stepMs, stepMs);
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return { destroy: () => node.removeEventListener("wheel", wheel) };
  }
</script>

<svelte:window onpointerup={() => draggingFrom = null} onpointercancel={() => draggingFrom = null} />

<div class="planning-timeline">
  <div class="picker">
    <span class="caption">Chunk ready (UTC)</span>
    <label>
      <input aria-label="Chunk ready date (UTC)" type="date" value={picked.slice(0, 10)}
        min={clockLabel(minAtMs).slice(0, 10)} max={clockLabel(range.maxAtMs).slice(0, 10)}
        onchange={event => editDate(event.currentTarget, "day")} {disabled} />
    </label>
    <label>
      <input aria-label="Chunk ready time (UTC)" type="time" value={picked.slice(11)}
        onchange={event => editDate(event.currentTarget, "time")} {disabled} />
    </label>
    <div class="steps">
      <button type="button" aria-label="Earlier by 30 minutes" {disabled} onclick={() => select(selectedAtMs - MOON_PLAN_STEP_MS)}>−</button>
      <button type="button" aria-label="Later by 30 minutes" {disabled} onclick={() => select(selectedAtMs + MOON_PLAN_STEP_MS)}>+</button>
    </div>
  </div>
  <div class="coarse track">
    <div class="unselectable" style:width={`${unselectableStart}%`}></div>
    <div class="unselectable" style:left={`${unselectableEnd}%`} style:right="0"></div>
    {#each weekTicks as tick (tick)}
      <span class="week" style:left={`${percent(tick - range.startAtMs, MOON_PLAN_SPAN_MS)}%`}></span>
    {/each}
    {#if fuelBlock !== null}
      <span class="fuel-marker" style:left={`${percent(fuelBlock - range.startAtMs, MOON_PLAN_SPAN_MS)}%`} aria-hidden="true"></span>
    {/if}
    <span class="selection" style:left={`${coarsePosition}%`} style:width={`${100 * MOON_PLAN_ZOOM_MS / MOON_PLAN_SPAN_MS}%`}></span>
    <input type="range" aria-label="Extraction schedule" aria-valuetext={readyWords} min="0"
      max={MOON_PLAN_SPAN_MS / MOON_PLAN_HOUR_MS} value={Math.round((selectedAtMs - range.startAtMs) / MOON_PLAN_HOUR_MS)}
      oninput={event => seek(event.currentTarget, range.startAtMs, MOON_PLAN_HOUR_MS)} use:stepOnWheel={MOON_PLAN_HOUR_MS} {disabled} />
  </div>
  <div class="zoom track">
    {#each zoomDays as day (day)}
      <span class="day" class:nearEnd={day - zoomStart > MOON_PLAN_ZOOM_MS * .9}
        style:left={`${percent(day - zoomStart, MOON_PLAN_ZOOM_MS)}%`}><small>{tickLabel.format(day)}</small></span>
    {/each}
    <span class="selection" style:left={`${zoomPosition}%`}></span>
    <input type="range" aria-label="Fine adjustment in 30-minute steps" aria-valuetext={readyWords} min="0"
      max={MOON_PLAN_ZOOM_MS / MOON_PLAN_STEP_MS} value={Math.round((selectedAtMs - zoomStart) / MOON_PLAN_STEP_MS)}
      onpointerdown={() => draggingFrom = selectedAtMs} onblur={() => draggingFrom = null}
      oninput={event => seek(event.currentTarget, zoomStart, MOON_PLAN_STEP_MS)} use:stepOnWheel={MOON_PLAN_STEP_MS} {disabled} />
  </div>
  <div class="facts">
    <span class="traversal">Traversal period <output>{transit}</output></span>
    {#if fuelAtMs !== null}<span class="fuel-label" class:short={selectedAtMs > fuelAtMs}>Fuel expires <time datetime={new Date(fuelAtMs).toISOString()}>{fuelWords}</time></span>{/if}
  </div>
</div>

<style>
  .planning-timeline { display: grid; gap: 10px; }
  .picker, .facts { display: flex; align-items: center; gap: 6px 8px; flex-wrap: wrap; }
  .caption, .facts { color: #adc0c7; }
  .picker input, .steps button { color-scheme: dark; background: #11191d; color: #e3ecee; border: 1px solid #51636a; padding: 4px 6px; font: inherit; }
  .steps { display: flex; gap: 3px; }
  .steps button { width: 26px; }
  .track { position: relative; height: 23px; border: 1px solid #51636a; background: #293840; }
  .zoom { margin-top: 16px; height: 19px; background: repeating-linear-gradient(90deg, #27373e 0 1.04%, #304049 1.04% 2.08%); }
  .track span, .unselectable { position: absolute; inset-block: 0; pointer-events: none; }
  .unselectable { background: #11191dcc; left: 0; }
  .track .week, .track .fuel-marker { width: 1px; background: #68808a; }
  .track .fuel-marker { z-index: 1; width: 2px; border-left: 2px solid #ffac76; }
  .track .selection { width: 2px; transform: translateX(-50%); border: 1px solid #8ac7cf; background: #8ac7cf30; }
  .zoom .day { border-left: 1px solid #68808a; color: #b6cad0; inset-block-start: -15px; }
  .day small { position: absolute; left: 3px; font-size: 10px; white-space: nowrap; }
  .day.nearEnd small { left: auto; right: 3px; }
  .track input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: ew-resize; }
  .track:focus-within { outline: 1px solid #a1dbe2; outline-offset: 2px; }
  .facts { justify-content: space-between; font-size: 12px; }
  output, time { color: #e3ecee; font-variant-numeric: tabular-nums; }
  .fuel-label.short, .fuel-label.short time { color: #ffb987; }
</style>
