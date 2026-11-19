<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { canManageMoonPull, MAX_MOON_PULL_SECONDS, MIN_MOON_PULL_SECONDS, MOON_PLAN_STEP_MS, moonPullDuration, moonPullStage,
    type MoonRefinery, type MoonResource, type MoonSchedule } from "../bridge/moonMining.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";

  let { flow, store, refinery }: { flow: AppFlow; store: ClientStore; refinery: MoonRefinery } = $props();
  const names = $derived(store.names);
  const station = $derived(store.station);
  const fracturing = $derived(flow.moonFracturing);
  const canStop = $derived(canManageMoonPull(refinery.ownerID, $station.online?.corporationID ?? null, $station.online?.corpRole ?? null));
  let resources = $state.raw<readonly MoonResource[] | null>(null);
  let schedule = $state.raw<MoonSchedule | null>(null);
  let resourceError = $state("");
  let scheduleError = $state("");
  let actionError = $state("");
  let clockOffsetMs = 0;
  let now = $state(Date.now());
  let plannedDate = $state("");
  let calendar = $state(true);
  let pending = $state(false);
  let mounted = false;
  let reading = false;
  let readAgain = false;

  const pull = $derived(schedule?.pull ?? null);
  const fracture = $derived($fracturing?.structureID === refinery.id && $fracturing.extractionID === pull?.id ? $fracturing : null);
  const stage = $derived(moonPullStage(pull, now, fracture !== null));
  const progress = $derived(pull ? Math.max(0, Math.min(1, (now - pull.startedAtMs) / (pull.readyAtMs - pull.startedAtMs))) : 0);
  const announce = $derived(({ idle: "Drill idle", pulling: "Extraction in progress", ready: "Ready to fracture", fracturing: "Fracturing" })[stage]);
  const selectedDate = $derived(Date.parse(`${plannedDate}Z`));
  const canStart = $derived(moonPullDuration(selectedDate, now) !== null && !!resources?.length && !scheduleError);

  const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const forInput = (ms: number) => new Date(ms).toISOString().slice(0, 16);
  const firstPlan = (ms: number) => Math.ceil((ms + MIN_MOON_PULL_SECONDS * 1000) / MOON_PLAN_STEP_MS) * MOON_PLAN_STEP_MS;
  const lastPlan = (ms: number) => Math.floor((ms + MAX_MOON_PULL_SECONDS * 1000) / MOON_PLAN_STEP_MS) * MOON_PLAN_STEP_MS;

  function remaining(endMs: number): string {
    const seconds = Math.max(0, Math.ceil((endMs - now) / 1000));
    const day = Math.floor(seconds / 86400);
    const time = [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60]
      .map(value => String(value).padStart(2, "0")).join(":");
    return day > 0 ? `${day}d ${time}` : time;
  }

  async function readResources(): Promise<void> {
    resourceError = "";
    try {
      const result = await flow.loadMoonResources(refinery.id);
      if (mounted) resources = result;
    } catch (error) {
      if (mounted) resourceError = (error as Error).message;
    }
  }

  async function refresh(): Promise<void> {
    if (reading) { readAgain = true; return; }
    reading = true;
    try {
      const result = await flow.loadMoonSchedule(refinery.id);
      if (!mounted) return;
      clockOffsetMs = result.nowMs - Date.now();
      now = result.nowMs;
      if (result.pull === null && (!plannedDate || (schedule?.pull && moonPullDuration(Date.parse(`${plannedDate}Z`), now) === null))) {
        plannedDate = forInput(firstPlan(now + 60_000));
      }
      schedule = result;
      scheduleError = "";
    } catch (error) {
      if (mounted) scheduleError = (error as Error).message;
    } finally {
      reading = false;
      if (mounted && readAgain) { readAgain = false; void refresh(); }
    }
  }

  async function run(action: () => Promise<void>): Promise<void> {
    pending = true;
    actionError = "";
    try {
      await action();
      if (mounted) await refresh();
    } catch (error) {
      if (mounted) actionError = (error as Error).message;
    } finally {
      if (mounted) pending = false;
    }
  }

  onMount(() => {
    mounted = true;
    void readResources();
    // The store subscription supplies the initial read. Periodic reads also catch updates missed during reconnects.
    const stop = flow.moonExtractionChanged.subscribe(() => { void refresh(); });
    const clock = setInterval(() => { now = Date.now() + clockOffsetMs; }, 1000);
    const poll = setInterval(() => { void refresh(); }, 5000);
    return () => { mounted = false; stop(); clearInterval(clock); clearInterval(poll); };
  });
</script>

<section class="moon-schedule" aria-label="Moon mining at {refinery.name}">
  <header>
    <h2>{refinery.name}</h2>
    {#if schedule}<span class="stage" class:ready={stage === "ready"} role="status">{announce}</span>{/if}
  </header>

  {#if scheduleError}<p class="error" role="alert">{scheduleError}</p>{/if}
  {#if actionError}<p class="error" role="alert">{actionError}</p>{/if}
  {#if !schedule && !scheduleError}<p>Reading the moon schedule…</p>{/if}

  {#if pull}
    <div class="schedule-card">
      {#if stage === "pulling"}
        <div class="countdown"><span>Ready in</span><strong>{remaining(pull.readyAtMs)}</strong></div>
        <progress max="1" value={progress} aria-label="Moon pull progress"></progress>
      {:else if fracture}
        <div class="countdown"><span>Laser cycle</span><strong>{now < fracture.endsAtMs ? remaining(fracture.endsAtMs) : "Finishing…"}</strong></div>
      {/if}
      <dl>
        <dt>Drill started</dt><dd>{utc(pull.startedAtMs)}</dd>
        <dt>Chunk ready</dt><dd>{utc(pull.readyAtMs)}</dd>
        <dt>Automatic fracture</dt><dd>{utc(pull.automaticAtMs)}</dd>
        {#if schedule?.calendarEventID}<dt>Calendar</dt><dd>Event requested</dd>{/if}
      </dl>
      {#if stage === "ready"}
        <button class="primary" disabled={pending || !!scheduleError} onclick={() => run(() => flow.controlMoonPull(refinery.id, pull.id, "fracture"))}>Fire Laser</button>
      {:else if stage === "pulling"}
        <button disabled={pending || !canStop || !!scheduleError} onclick={() => run(() => flow.controlMoonPull(refinery.id, pull.id, "cancel"))}>Stop Drill</button>
        {#if !canStop}<p>Stopping the drill requires the Station Manager role in the owning corporation.</p>{/if}
      {/if}
    </div>
  {:else if schedule}
    <form class="schedule-card" onsubmit={event => { event.preventDefault(); if (canStart && !pending) void run(() => flow.startMoonPull(refinery.id, selectedDate, calendar)); }}>
      <label class="time">Chunk ready time (UTC)
        <input type="datetime-local" required bind:value={plannedDate} min={forInput(firstPlan(now))}
          max={forInput(lastPlan(now))} step={MOON_PLAN_STEP_MS / 1000} disabled={pending} />
      </label>
      {#if moonPullDuration(selectedDate, now) === null}<p>Choose a ready time from six days and one minute through 56 days from now.</p>{/if}
      <label class="calendar"><input type="checkbox" bind:checked={calendar} disabled={pending} /> Add to Calendar</label>
      <button class="primary" disabled={pending || !canStart}>Start Extraction</button>
    </form>
  {/if}

  <div class="composition">
    <h3>Moon composition</h3>
    {#if resourceError}
      <p class="error" role="alert">{resourceError}</p>
      <button onclick={readResources}>Retry composition</button>
    {:else if !resources}
      <p>Reading moon resources…</p>
    {:else if !resources.length}
      <p>No moon resources were reported for this refinery.</p>
    {:else}
      <ul>
        {#each resources as resource (resource.typeID)}
          <li>
            <span>{resolvedName($names.resolved, "type", resource.typeID, `Type ${resource.typeID}`)}</span>
            <span>{(resource.fraction * 100).toFixed(2)}%</span>
            <meter min="0" max="1" value={resource.fraction} aria-label={resolvedName($names.resolved, "type", resource.typeID, `Type ${resource.typeID}`)}></meter>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

<style>
  .moon-schedule { display: flex; flex-direction: column; gap: 14px; padding: 15px; font-size: 13px; color: #e3ecee; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px 14px; flex-wrap: wrap; }
  h2, h3, p, ul, dl, dd { margin: 0; }
  h2 { font-size: 17px; font-weight: 570; } h3 { font-size: 13px; font-weight: 630; }
  .stage { color: #9dc9d2; } .stage.ready { color: #f3ca79; }
  .schedule-card { display: grid; gap: 12px; padding: 13px; border: 1px solid #34464e; background: #1b262c; }
  .countdown, li { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  strong, dd, li span:last-of-type { font-variant-numeric: tabular-nums; }
  strong { font-size: 17px; }
  progress, meter { width: 100%; accent-color: #75b4bf; }
  dl { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 10px; }
  dt, p { color: #adc0c7; } dd { text-align: right; }
  .time { display: grid; gap: 7px; }
  .calendar { display: flex; align-items: center; gap: 6px; }
  input { color-scheme: dark; accent-color: #75b4bf; }
  input[type="datetime-local"] { width: min(100%, 230px); background: #11191d; color: inherit; border: 1px solid #51636a; padding: 5px 7px; }
  button { justify-self: start; background: #25333a; border: 1px solid #526872; color: inherit; padding: 6px 12px; }
  button.primary { background: #28434a; border-color: #72a8b2; }
  button:disabled { opacity: .55; } button:not(:disabled):hover { filter: brightness(1.2); }
  .composition { display: grid; gap: 8px; } ul { list-style: none; padding: 0; display: grid; gap: 6px; }
  li { display: grid; grid-template-columns: 1fr auto; column-gap: 12px; row-gap: 3px; }
  meter { grid-column: 1 / -1; height: 6px; }
  .error { color: #ffc0aa; }
</style>
