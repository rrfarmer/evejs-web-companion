<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import * as api from "../app/api.ts";
  import { onDestroy, onMount } from "svelte";
  import { deriveDocked } from "./tabs.ts";
  import { resolvedName } from "../store/names.ts";
  import { createCockpitProvisioningLifecycle, type CockpitProvisioningLease } from "../provisioning/cockpitLifecycle.ts";
  import type { ProvisioningOptions, ProvisioningReview, ProvisioningInput, ReplenishmentResult, ShipReview, ShipResult } from "../bridge/provisioning.ts";
  let { flow, store }: { flow: AppFlow; store: ClientStore } = $props();
  // Workspace is keyed by the held session. Capture its stable bindings before
  // release removes App's active pilot and retires the parent prop getters.
  // svelte-ignore state_referenced_locally
  const cockpitStore = store;
  // svelte-ignore state_referenced_locally
  const cockpitFlow = flow;
  const flight = cockpitStore.flight;
  const station = cockpitStore.station;
  const names = cockpitStore.names;
  let options = $state<ProvisioningOptions | null>(null);
  let provider = $state(0), fittingID = $state(0), source = $state<"hangar" | "corp" | "container">("hangar"), division = $state(1), containerID = $state<number | null>(null);
  let review = $state<ProvisioningReview | null>(null), outcome = $state<ReplenishmentResult | null>(null);
  let shipReview = $state<ShipReview | null>(null), shipOutcome = $state<ShipResult | null>(null), shipSelection = $state("");
  let continuationID = $state<string | null>(null);
  let shipOutcomePilot = $state<number | null>(null), shipOutcomeLocation = $state<number | null>(null);
  let busy = $state(false), error = $state("");
  let acceptedSelection = $state("");
  let expired = $state(false);
  let shipExpired = $state(false);
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let shipExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  const isDocked = $derived(deriveDocked($flight.status, $station.online));
  const transitioning = $derived($flight.status?.transition != null && !$flight.status.transition.sessionStable);
  const ready = $derived($station.online !== null && isDocked && $flight.status?.shipID != null && !transitioning);
  const shipName = $derived($flight.status?.shipTypeID ? resolvedName($names.resolved, "type", $flight.status.shipTypeID) : "Ship unavailable");
  const selection = $derived(JSON.stringify([provider, fittingID, source, division, containerID]));
  const validReview = $derived(review !== null && selection === acceptedSelection && !expired);
  const validShipReview = $derived(shipReview !== null && selection === shipSelection && !shipExpired);
  const safeShipPlan = $derived(shipReview !== null && shipReview.canApply && shipReview.plan.unsupported.length === 0 &&
    shipReview.plan.shortages.length === 0 && shipReview.plan.destructiveActions.length === 0 &&
    ["ALREADY_SATISFIED", "NEW_HULL", "CONTINUE"].includes(shipReview.plan.mode));
  const outcomeApplies = $derived(shipOutcomePilot === $station.online?.characterID && shipOutcomeLocation === $flight.status?.stationID &&
    shipOutcome?.manifest.targetHullID === $flight.status?.shipID);
  const status = $derived((outcomeApplies ? shipOutcome?.result : null) ?? outcome?.result ?? review?.status ?? null);
  const pending = $derived([...new Map([...(options?.pending ?? []), ...(review?.pending ?? [])].map(row => [row.operationID, row] as const)).values()]);
  const lifecycle = createCockpitProvisioningLifecycle(() => {
    const status = cockpitStore.flight.get().status, online = cockpitStore.station.get().online;
    return { characterID: online?.characterID ?? null, corporationID: online?.corporationID ?? null,
      shipID: status?.shipID ?? null, stationID: status?.stationID ?? online?.stationID ?? null,
      structureID: status?.structureID ?? online?.structureID ?? null, docked: deriveDocked(status, online),
      transitioning: status?.transition != null && !status.transition.sessionStable,
      transitionEpoch: status?.transition?.epoch ?? null, options: cockpitFlow.requestOptions() };
  });
  function clearReviews() {
    review = null; outcome = null; shipReview = null; shipOutcome = null; continuationID = null;
    acceptedSelection = ""; shipSelection = ""; expired = false; shipExpired = false;
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    if (shipExpiryTimer !== null) clearTimeout(shipExpiryTimer);
  }
  function changedContext() {
    if (!lifecycle.observe()) return;
    clearReviews(); options = null; provider = 0; fittingID = 0; source = "hangar"; division = 1; containerID = null; error = "";
  }
  // Synchronous subscriptions retire even a context that changes away and back
  // before an awaited request settles. Workspace itself is keyed by held pilot.
  const unsubscribe = [cockpitStore.station.subscribe(changedContext), cockpitStore.flight.subscribe(changedContext), cockpitStore.session.subscribe(changedContext)];
  onDestroy(() => { lifecycle.dispose(); unsubscribe.forEach(stop => stop()); clearReviews(); });
  onMount(() => { if (ready) void run(loadProvider); });
  async function run(action: (lease: CockpitProvisioningLease) => Promise<void>) {
    if (busy) return;
    if (!ready) { error = "Dock the current held pilot and wait for its ship session to be ready."; return; }
    const lease = lifecycle.capture();
    busy = true; error = "";
    try { await action(lease); } catch (caught) { if (lease.isHeld()) error = caught instanceof Error ? caught.message : String(caught); }
    finally { busy = false; }
  }
  async function loadProvider(lease: CockpitProvisioningLease) {
    clearReviews();
    const definitionProvider = provider || null; options = null; fittingID = 0;
    const result = await api.provisioningOptions(definitionProvider, lease.options);
    lease.assertCurrent();
    options = result;
    provider = options.providerCharacterID; fittingID = 0;
  }
  function input(): ProvisioningInput {
    if (!options?.definitionCorporationID || !fittingID) throw new Error("Choose a saved corporation fitting.");
    return { providerCharacterID: provider, corporationID: options.definitionCorporationID, fittingID,
      source: source === "corp" ? { kind: "corp", corporationID: options.corporationID, division } :
        source === "container" ? { kind: "container", itemID: containerID || 0 } : { kind: "hangar" } };
  }
  async function planShip(lease: CockpitProvisioningLease, operationID: string | null = null) {
    shipReview = null; shipOutcome = null;
    const selected = selection, result = await api.reviewShipProvisioning(input(), operationID, lease.options);
    lease.assertCurrent();
    if (selected !== selection) throw new Error("Selection changed; Review again.");
    shipReview = result; shipSelection = selected; continuationID = operationID; shipOutcome = null; shipExpired = false;
    if (shipExpiryTimer !== null) clearTimeout(shipExpiryTimer);
    shipExpiryTimer = setTimeout(() => { shipExpired = true; }, Math.max(0, result.expiresAt - Date.now()));
  }
  async function applyShip(lease: CockpitProvisioningLease) {
    lease.assertCurrent();
    if (!shipReview || !validShipReview || !safeShipPlan) throw new Error("Review a supported, non-destructive ship plan first.");
    shipOutcomePilot = $station.online?.characterID ?? null; shipOutcomeLocation = $flight.status?.stationID ?? null;
    let result: ShipResult | null = null;
    const accepted = shipReview; shipReview = null; review = null;
    try {
      result = await api.provisionShip(accepted.reviewID, accepted.reviewHash, lease.options);
      lease.assertHeld(); shipOutcome = result;
    }
    finally {
      lease.assertHeld();
      shipReview = null;
      await cockpitFlow.loadFlightStatus();
      lease.assertHeld();
      await cockpitFlow.loadInventory();
      lease.assertHeld();
      // Boarding may change our ship. Start a fresh view lease for the result,
      // while retaining the original held-pilot guard across each refresh.
      const refreshed = lifecycle.capture();
      const resultOptions = await api.provisioningOptions(null, refreshed.options);
      lease.assertHeld(); refreshed.assertCurrent(); options = resultOptions;
      provider = resultOptions.providerCharacterID; fittingID = 0;
      if (result && result.manifest.targetHullID === $flight.status?.shipID) shipOutcome = result;
    }
  }
  async function continueShip(lease: CockpitProvisioningLease, row: ProvisioningOptions["pending"][number]) {
    if (!row.input) throw new Error("Reload custody sources.");
    const result = await api.reconcileProvisioning(row.operationID, lease.options);
    lease.assertCurrent();
    if (result.state !== "READY") throw new Error("Custody remains blocked: its world outcome is unproven.");
    const resultOptions = await api.provisioningOptions(row.input.providerCharacterID, lease.options);
    lease.assertCurrent(); options = resultOptions;
    provider = row.input.providerCharacterID; fittingID = row.input.fittingID; source = row.input.source.kind;
    if (row.input.source.kind === "corp") division = row.input.source.division;
    if (row.input.source.kind === "container") containerID = row.input.source.itemID;
    await planShip(lease, row.operationID);
  }
  async function reviewNow(lease: CockpitProvisioningLease) {
    if (!options?.definitionCorporationID || !fittingID) throw new Error("Choose a saved corporation fitting.");
    const physical: ProvisioningInput["source"] = source === "corp" ? { kind: "corp", corporationID: options.corporationID, division } :
      source === "container" ? { kind: "container", itemID: containerID || 0 } : { kind: "hangar" };
    review = null; outcome = null;
    const selected = selection;
    const result = await api.reviewProvisioning({ providerCharacterID: provider, corporationID: options.definitionCorporationID,
      fittingID, source: physical }, lease.options);
    lease.assertCurrent();
    if (selected !== selection) throw new Error("Selection changed; Review again.");
    review = result; acceptedSelection = selected; outcome = null; expired = false;
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => { expired = true; }, Math.max(0, result.expiresAt - Date.now()));
  }
  async function replenish(lease: CockpitProvisioningLease) {
    lease.assertCurrent();
    if (!review || !validReview || !review.canApply) throw new Error("Review the current selection first.");
    const accepted = review; review = null; shipReview = null;
    const result = await api.replenishProvisioning(accepted.reviewID, accepted.reviewHash, lease.options);
    lease.assertCurrent();
    outcome = result;
    await cockpitFlow.loadInventory();
    lease.assertCurrent();
    try { await reviewNow(lease); }
    finally { if (lease.isCurrent()) outcome = result; }
  }
  async function reconcile(lease: CockpitProvisioningLease, operationID: string) {
    const result = await api.reconcileProvisioning(operationID, lease.options);
    lease.assertCurrent();
    outcome = result;
    await cockpitFlow.loadInventory();
    lease.assertCurrent();
    if (result.state === "RECONCILED" && options) options = { ...options, pending: options.pending.filter(row => row.operationID !== operationID) };
    try { if (fittingID) await reviewNow(lease); }
    finally { if (lease.isCurrent()) outcome = result; }
  }
  function equipmentPlace(flag: number): string {
    if (flag >= 11 && flag <= 18) return `Low slot ${flag - 10}`;
    if (flag >= 19 && flag <= 26) return `Mid slot ${flag - 18}`;
    if (flag >= 27 && flag <= 34) return `High slot ${flag - 26}`;
    if (flag === 87) return "Drone bay";
    if (flag === 5) return "Cargo hold";
    return "Unsupported slot or bay";
  }
</script>

<section class="panel ready-fit" aria-label="Ready Fit for current pilot" aria-busy={busy}>
  <header class="ready-fit-context">
    <div><strong>{$station.online?.characterName ?? "No pilot held"}</strong><span>Current pilot</span></div>
    <div><strong>{shipName}</strong><span>Current ship · {isDocked ? "Docked" : "In space"}</span></div>
  </header>
  <p class="note">Review equipment and supplies for this pilot. Replenish Consumables fills current-ship deficits; Provision Ship creates one new local hull only when its equipment does not already match.</p>
  <p class="note">NEW_HULL_ONLY: an exact equipment match acquires no hull and loads no duplicate equipment or supplies. Replenish Consumables is a separate action.</p>
  <p class="note"><a href="/ship-provisioning" target="_blank" rel="noopener">Open separate Provisioning Center</a></p>
  {#if !ready}<p class="note">Dock this pilot and wait for the current ship session to be ready before reviewing local sources.</p>{/if}
  <button type="button" disabled={busy || !ready} onclick={() => void run(loadProvider)}>{busy ? "Working…" : "Refresh sources"}</button>
  {#if options}
    {#if options.definitionStatus !== "READY"}<p class="note error">Corporation fittings are unavailable. Choose another definition source or refresh after its authority is restored.</p>{/if}
    <div class="controls">
      <label>Fitting definition provider
        <select bind:value={provider} disabled={busy} onchange={() => void run(loadProvider)}>
          {#each options.providers as pilot}<option value={pilot.characterID}>{pilot.name} — corporation library</option>{/each}
        </select>
      </label>
      <p class="note source-note">The provider supplies a saved corporation fitting definition. Physical items and all actions belong to the current pilot shown above.</p>
      <label>Saved fitting
        <select bind:value={fittingID} disabled={busy}>
          <option value={0}>Choose fitting</option>
          {#each options.fittings as fit}<option value={fit.fittingID} disabled={fit.invalid}>{fit.name}{fit.invalid ? " — invalid" : ""}</option>{/each}
        </select>
      </label>
      <label>Physical item source
        <select bind:value={source} disabled={busy}><option value="hangar">Personal hangar</option><option value="corp">Current pilot's corporation hangar</option><option value="container">Personal local container</option></select>
      </label>
      {#if source === "corp"}<label>Exact division<select bind:value={division} disabled={busy}>{#each [1,2,3,4,5,6,7] as n}<option value={n}>Division {n}</option>{/each}</select></label>{/if}
      {#if source === "container"}<label>Local container<select bind:value={containerID} disabled={busy}><option value={null}>Choose container</option>{#each options.containers as container}<option value={container.itemID}>{container.name} — {container.location}</option>{/each}</select></label>{/if}
    </div>
    <div class="ready-fit-actions">
      <button type="button" disabled={busy || !ready || !fittingID || options.definitionStatus !== "READY"} onclick={() => void run(reviewNow)}>Review</button>
      <button type="button" disabled={busy || !ready || !validReview || !review?.canApply} onclick={() => void run(replenish)}>Replenish Consumables</button>
    </div>
    <p class="note">Review shows current equipment and supply deficits. Replenish Consumables confirms that review and moves only missing consumables.</p>
    <div class="ready-fit-actions">
      <button type="button" disabled={busy || !ready || !fittingID || options.definitionStatus !== "READY"} onclick={() => void run(planShip)}>Review Provision Ship plan</button>
      <button type="button" disabled={busy || !ready || !validShipReview || !safeShipPlan} onclick={() => void run(applyShip)}>{continuationID ? "Continue reviewed provision" : "Provision Ship"}</button>
    </div>
    <p class="note">Provision Ship confirms the displayed plan. Unsupported or destructive plans are refused.</p>
  {/if}
  {#if shipReview}
    <h3>Ship plan: {shipReview.contract.name}</h3>
    <p>Target hull: <strong>{shipReview.plan.targetHullName}</strong></p>
    <p>{shipReview.plan.mode === "ALREADY_SATISFIED" ? "Current ship exactly matches. No new hull or duplicate loading will be dispatched." : `Acquire exactly ${shipReview.plan.hullQuantity} hull; assemble, prove identity, board and verify.`}</p>
    <p>Current equipment: {shipReview.status.equipment} · Current supplies: {shipReview.status.supplies}</p>
    <h4>Required equipment</h4>
    <ul>{#each shipReview.plan.requirements as item}<li>{item.name} × {item.quantity} — {equipmentPlace(item.flag)}</li>{/each}</ul>
    <h4>Consumable targets</h4>
    <ul>{#each shipReview.plan.supplies as item}<li>{item.name}: target {item.target}, {item.mode === "TOTAL_ABOARD" ? "total aboard" : "carried spares"}</li>{/each}</ul>
    <p>Destructive actions: {shipReview.plan.destructiveActions.length ? "Refused" : "none"}. Optional saved cargo rows excluded from required equipment: {shipReview.plan.optionalSavedCargo.length}.</p>
    {#each shipReview.plan.destructiveActions as reason}<p class="note error">Refused destructive action: {reason}</p>{/each}
    {#each [...shipReview.plan.unsupported, ...shipReview.plan.shortages] as reason}<p class="note error">{reason}</p>{/each}
    {#if !shipReview.canApply}<p class="note error">This plan cannot be confirmed. Resolve its source, equipment or custody restrictions and Review again.</p>{/if}
    <details><summary>Source and plan details</summary>
      <p>Physical source: {shipReview.source.pin.descriptor.kind}, owner {shipReview.source.pin.ownerID}, contents location {shipReview.source.pin.locationID ?? "UNKNOWN"}, division/flag {shipReview.source.pin.flag}.</p>
      {#if shipReview.source.pin.descriptor.kind === "corp"}<p>Exact corporation {shipReview.source.pin.descriptor.corporationID}, division {shipReview.source.pin.descriptor.division}, office {shipReview.source.pin.office}.</p>{/if}
      <ol>{#each shipReview.plan.steps as step}<li>{step}</li>{/each}</ol>
    </details>
    {#if !validShipReview}<p class="note">Plan expired or selection changed. Review again before provisioning.</p>{/if}
  {/if}
  {#each options?.pending.filter(row => row.kind === "SHIP_PROVISION") ?? [] as row}
    <button type="button" disabled={busy || !ready} onclick={() => void run(lease => continueShip(lease, row))}>Reconcile ship custody and review continuation — {row.state}</button>
  {/each}
  {#if review}
    <p><strong>Fit: {review.matches.state === "MATCH" ? review.matches.alternatives[0]?.name : review.matches.state === "AMBIGUOUS" ? "Multiple exact equipment matches" : review.matches.state === "UNKNOWN" ? "Unknown" : "Modified / no exact equipment match"}</strong></p>
    {#if review.matches.state === "AMBIGUOUS"}<p>{review.matches.alternatives.map(f => f.name).join(" · ")}</p>{/if}
    <p>Reviewed target: {review.contract.name}. Source Take: {review.source.access.take === true ? "permitted" : review.source.access.take === false ? "denied" : "UNKNOWN"}.</p>
    {#if !validReview}<p class="note">Selection or ship changed, or Review expired. Review again before replenishment.</p>{/if}
  {/if}
  {#each pending.filter(row => options?.pending.find(p => p.operationID === row.operationID)?.kind !== "SHIP_PROVISION") as row}<button type="button" disabled={busy || !ready} onclick={() => void run(lease => reconcile(lease, row.operationID))}>Reconcile pending replenishment — read only</button>{/each}
  {#if status}
    <p>Equipment: <strong>{status.equipment}</strong> · Supplies: <strong>{status.supplies}</strong></p>
    <table><thead><tr><th>Supply</th><th>Aboard / target</th><th>Deficit</th><th>Source at Review</th><th>Status</th></tr></thead><tbody>
      {#each status.targets as target}<tr><td>{target.name}<small> {target.mode === "TOTAL_ABOARD" ? "total aboard" : "carried spares"}</small></td><td>{target.current ?? "Unknown"} / {target.target}</td><td>{target.deficit ?? "Unknown"}</td><td>{review?.source.available.find(row => row.typeID === target.typeID)?.quantity ?? "Unknown"}</td><td>{target.state}</td></tr>{/each}
    </tbody></table>
  {/if}
  {#if outcome}<p class="note">Replenishment: {outcome.state}{outcome.state === "BLOCKED" ? ". Outcome is unproven; reconcile before another mutation." : ""}</p>{/if}
  {#if shipOutcome}
    <p class="note">Provision Ship: <strong>{shipOutcome.state}</strong>{shipOutcome.reason ? ` · ${shipOutcome.reason}` : ""}{shipOutcome.result?.alreadySatisfied ? " · Already satisfied; no new hull acquired." : ""}</p>
    <details><summary>Provisioning result details</summary><p>Hull identity: {shipOutcome.manifest.targetHullID ?? "unproven"}</p></details>
  {/if}
  {#if outcome?.state === "BLOCKED" && !review?.pending.some(p => p.operationID === outcome?.operationID)}<button type="button" disabled={busy || !ready} onclick={() => void run(lease => reconcile(lease, outcome!.operationID))}>Reconcile replenishment — read only</button>{/if}
  {#if error}<p class="note error" role="alert">{error}</p>{/if}
</section>

<style>
  .ready-fit { min-width: 0; }
  .ready-fit-context { display: flex; flex-wrap: wrap; gap: 1rem; padding-bottom: .75rem; border-bottom: 1px solid var(--border, #34404e); }
  .ready-fit-context div { display: grid; gap: .25rem; min-width: 0; }
  .ready-fit-context strong { overflow-wrap: anywhere; }
  .ready-fit-context span { font-size: .85em; opacity: .7; }
  .controls { display: grid; gap: .75rem; margin: .75rem 0; }
  .controls label { display: grid; gap: .25rem; min-width: 0; }
  .controls select { width: 100%; min-width: 0; }
  .source-note { margin: 0; }
  .ready-fit-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .75rem; }
  table { width: 100%; table-layout: fixed; }
  th, td, li { overflow-wrap: anywhere; }
  details { margin: .75rem 0; }
</style>
