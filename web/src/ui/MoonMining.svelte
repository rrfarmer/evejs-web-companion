<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { filetimeToUnixMs } from "../bridge/activity.ts";
  import { canManageMoonPull, estimateMoonOutput, moonPlanMinimum, moonPlanRange, moonPullDuration, moonPullStage, snapMoonPlanTime,
    type MoonOrePricing, type MoonPlanRange, type MoonRefinery, type MoonResource, type MoonSchedule } from "../bridge/moonMining.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import MoonPlanningTimeline from "./MoonPlanningTimeline.svelte";

  let { flow, store, refinery }: { flow: AppFlow; store: ClientStore; refinery: MoonRefinery } = $props();
  const names = $derived(store.names);
  const station = $derived(store.station);
  const fracturing = $derived(flow.moonFracturing);
  const calendarUpdated = $derived(flow.calendarUpdated);
  const canStop = $derived(canManageMoonPull(refinery.ownerID, $station.online?.corporationID ?? null, $station.online?.corpRole ?? null));
  let resources = $state.raw<readonly MoonResource[] | null>(null);
  let pricing = $state.raw<ReadonlyMap<number, MoonOrePricing>>(new Map());
  let pricingPending = $state(false);
  let schedule = $state.raw<MoonSchedule | null>(null);
  let resourceError = $state("");
  let scheduleError = $state("");
  let actionError = $state("");
  let clockOffsetMs = 0;
  let now = $state(Date.now());
  let planRange = $state.raw<MoonPlanRange | null>(null);
  let plannedAtMs = $state<number | null>(null);
  let fuelAtMs = $state<number | null>(null);
  let readingFuel = false;
  let readFuelAgain = false;
  let previewMultiplier = $state<number | null>(null);
  let yieldPending = $state(true);
  let calendar = $state(true);
  let calendarPublished = $state(false);
  let pending = $state(false);
  let mounted = false;
  let reading = false;
  let readAgain = false;

  const pull = $derived(schedule?.pull ?? null);
  const calendarEventID = $derived(schedule?.calendarEventID ?? null);
  const readyAtMs = $derived(pull?.readyAtMs ?? null);
  const fracture = $derived($fracturing?.structureID === refinery.id && $fracturing.extractionID === pull?.id ? $fracturing : null);
  const stage = $derived(moonPullStage(pull, now, fracture !== null));
  const progress = $derived(pull ? Math.max(0, Math.min(1, (now - pull.startedAtMs) / (pull.readyAtMs - pull.startedAtMs))) : 0);
  const announce = $derived(({ idle: "Drill idle", pulling: "Extraction in progress", ready: "Ready to fracture", fracturing: "Fracturing" })[stage]);
  const validPlan = $derived(plannedAtMs !== null && moonPullDuration(plannedAtMs, now) !== null);
  const canStart = $derived(validPlan && !!resources?.length && !scheduleError);
  // The native planner samples the clock when the selected date changes.
  const plannedSeconds = $derived(plannedAtMs === null ? null : (plannedAtMs - untrack(() => now)) / 1000);
  const durationSeconds = $derived(pull ? (pull.readyAtMs - pull.startedAtMs) / 1000 : validPlan ? plannedSeconds : null);
  const yieldMultiplier = $derived(pull ? pull.yieldMultiplier : previewMultiplier);
  const output = $derived(resources?.length && durationSeconds !== null && yieldMultiplier !== null
    ? estimateMoonOutput(resources, durationSeconds, yieldMultiplier, pricing) : null);
  const wholeNumber = new Intl.NumberFormat();
  const formatVolume = (m3: number) => `${wholeNumber.format(Math.trunc(m3))} m³`;
  const formatPrice = (isk: number) => `${wholeNumber.format(Math.round(isk))} ISK`;

  $effect(() => {
    void $calendarUpdated;
    const id = calendarEventID, ready = readyAtMs, owner = refinery.ownerID;
    calendarPublished = false;
    if (id === null || ready === null || owner === null) return;
    const month = new Date(ready);
    let current = true;
    void flow.loadCalendarMonth(month.getUTCMonth() + 1, month.getUTCFullYear()).then(events => {
      if (current) calendarPublished = events.some(event => event.eventID === id && event.ownerID === owner
        && !event.isDeleted && event.autoEventType === 2 && filetimeToUnixMs(event.eventDateTime) === ready);
    }, () => {});
    return () => { current = false; };
  });

  const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  function selectPlan(atMs: number, stepMs?: number): number {
    const range = planRange ?? moonPlanRange(now);
    if (range.maxAtMs < moonPlanMinimum(now)) planRange = moonPlanRange(now);
    plannedAtMs = snapMoonPlanTime(atMs, now, planRange ?? range, stepMs);
    return plannedAtMs;
  }

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
      if (mounted) {
        resources = result;
        pricing = new Map();
        if (result.length) void readPricing(result);
      }
    } catch (error) {
      if (mounted) resourceError = (error as Error).message;
    }
  }

  async function readPricing(rows: readonly MoonResource[]): Promise<void> {
    pricingPending = true;
    const result = await flow.loadMoonOrePricing(rows.map(row => row.typeID)).catch(() => new Map<number, MoonOrePricing>());
    if (!mounted || resources !== rows) return;
    pricing = result;
    pricingPending = false;
  }

  async function readYield(): Promise<void> {
    yieldPending = true;
    const multiplier = await flow.loadMoonYieldMultiplier(refinery.id).catch(() => null);
    if (!mounted) return;
    previewMultiplier = multiplier;
    yieldPending = false;
  }

  async function readFuel(): Promise<void> {
    if (readingFuel) { readFuelAgain = true; return; }
    readingFuel = true;
    try {
      const result = await flow.loadMoonFuelExpiry(refinery.id);
      if (mounted) fuelAtMs = result;
    } catch {
      if (mounted) fuelAtMs = null;
    } finally {
      readingFuel = false;
      if (mounted && readFuelAgain) { readFuelAgain = false; void readFuel(); }
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
      if (result.pull === null && (plannedAtMs === null || (schedule?.pull && moonPullDuration(plannedAtMs, now) === null))) {
        planRange = moonPlanRange(now);
        plannedAtMs = moonPlanMinimum(now);
      }
      if (result.pull === null && schedule?.pull) void readYield();
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
    void readYield();
    // The store subscription supplies the initial read. Periodic reads also catch updates missed during reconnects.
    const stop = flow.moonExtractionChanged.subscribe(() => { void refresh(); });
    const stopFuel = flow.moonFuelChanged.subscribe(() => { if (!pull) void readFuel(); });
    const clock = setInterval(() => { now = Date.now() + clockOffsetMs; }, 1000);
    const poll = setInterval(() => { void refresh(); }, 5000);
    const fuelPoll = setInterval(() => { if (!pull) void readFuel(); }, 15_000);
    return () => { mounted = false; stop(); stopFuel(); clearInterval(clock); clearInterval(poll); clearInterval(fuelPoll); };
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
        {#if calendarEventID}<dt>Calendar</dt><dd>{calendarPublished ? "Event scheduled" : "Event requested"}</dd>{/if}
      </dl>
      {#if stage === "ready"}
        <button class="primary" disabled={pending || !!scheduleError} onclick={() => run(() => flow.controlMoonPull(refinery.id, pull.id, "fracture"))}>Fire Laser</button>
      {:else if stage === "pulling"}
        <button disabled={pending || !canStop || !!scheduleError} onclick={() => run(() => flow.controlMoonPull(refinery.id, pull.id, "cancel"))}>Stop Drill</button>
        {#if !canStop}<p>Stopping the drill requires the Station Manager role in the owning corporation.</p>{/if}
      {/if}
    </div>
  {:else if schedule && planRange && plannedAtMs !== null}
    <form class="schedule-card" onsubmit={event => {
      event.preventDefault();
      const ready = plannedAtMs;
      if (ready !== null && canStart && !pending) void run(() => flow.startMoonPull(refinery.id, ready, calendar));
    }}>
      <MoonPlanningTimeline range={planRange} selectedAtMs={plannedAtMs} {now} {fuelAtMs} disabled={pending} select={selectPlan} />
      {#if !validPlan}<p>Choose a ready time from six days and one minute through 56 days from now.</p>{/if}
      <label class="calendar"><input type="checkbox" bind:checked={calendar} disabled={pending} /> Add to Calendar</label>
      <button class="primary" disabled={pending || !canStart}>Start Extraction</button>
    </form>
  {/if}

  <div class="composition">
    <h3>{pull ? "Projected Output" : "Output"}</h3>
    {#if resourceError}
      <p class="error" role="alert">{resourceError}</p>
      <button onclick={readResources}>Retry composition</button>
    {:else if !resources}
      <p>Reading moon resources…</p>
    {:else if !resources.length}
      <p>No moon resources were reported for this refinery.</p>
    {:else}
      {#if durationSeconds !== null && yieldMultiplier === null}
        {#if !pull && yieldPending}
          <p>Reading refinery yield…</p>
        {:else}
          <p>Estimated output is unavailable.</p>
          {#if !pull}<button onclick={readYield}>Retry yield</button>{/if}
        {/if}
      {/if}
      <table aria-label={pull ? "Projected output" : "Estimated output"}>
        <thead><tr><th scope="col">Moon Product</th><th scope="col">{output ? "Est. Volume" : "Composition"}</th><th scope="col">Est. Price</th></tr></thead>
        <tbody>
          {#each resources as resource, index (resource.typeID)}
            {@const name = resolvedName($names.resolved, "type", resource.typeID, `Type ${resource.typeID}`)}
            {@const share = `${(resource.fraction * 100).toFixed(2)}%`}
            {@const price = output?.ores[index]?.price ?? null}
            <tr>
              <th scope="row">{name}</th>
              <td>
                <span>{output ? formatVolume(output.ores[index].volume) : share}</span>
                <meter min="0" max="1" value={resource.fraction} aria-label={`${name} composition`} title={share}></meter>
              </td>
              <td class="price">
                <span>{price === null ? "—" : formatPrice(price)}</span>
                {#if price !== null && output?.totalPrice && output.totalPrice > 0}
                  <meter min="0" max="1" value={price / output.totalPrice} aria-label={`${name} share of estimated price`}></meter>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
        {#if output}
          <tfoot><tr><th scope="row">Total</th><td>{formatVolume(output.totalVolume)}</td><td class="price">{output.totalPrice === null ? "—" : formatPrice(output.totalPrice)}</td></tr></tfoot>
        {/if}
      </table>
      {#if output?.totalPrice === null && !pricingPending}<button onclick={() => readPricing(resources)}>Retry prices</button>{/if}
    {/if}
  </div>
</section>

<style>
  .moon-schedule { display: flex; flex-direction: column; gap: 14px; padding: 15px; font-size: 13px; color: #e3ecee; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px 14px; flex-wrap: wrap; }
  h2, h3, p, dl, dd { margin: 0; }
  h2 { font-size: 17px; font-weight: 570; } h3 { font-size: 13px; font-weight: 630; }
  .stage { color: #9dc9d2; } .stage.ready { color: #f3ca79; }
  .schedule-card { display: grid; gap: 12px; padding: 13px; border: 1px solid #34464e; background: #1b262c; }
  .countdown { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  strong, dd, td { font-variant-numeric: tabular-nums; }
  strong { font-size: 17px; }
  progress, meter { width: 100%; accent-color: #75b4bf; }
  dl { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 10px; }
  dt, p { color: #adc0c7; } dd { text-align: right; }
  .calendar { display: flex; align-items: center; gap: 6px; }
  .calendar input { width: 15px; height: 15px; flex: none; margin: 0; }
  input { color-scheme: dark; accent-color: #75b4bf; }
  button { justify-self: start; background: #25333a; border: 1px solid #526872; color: inherit; padding: 6px 12px; }
  button.primary { background: #28434a; border-color: #72a8b2; }
  button:disabled { opacity: .55; } button:not(:disabled):hover { filter: brightness(1.2); }
  .composition { display: grid; gap: 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 6px 8px; }
  th { text-align: left; font-weight: 500; }
  thead, tfoot { background: #25333a; }
  thead { color: #adc0c7; }
  td, thead th:not(:first-child) { text-align: right; }
  td { vertical-align: top; }
  .price { white-space: nowrap; }
  tbody tr + tr, tfoot { border-top: 1px solid #34464e; }
  meter { display: block; height: 5px; }
  .error { color: #ffc0aa; }
</style>
