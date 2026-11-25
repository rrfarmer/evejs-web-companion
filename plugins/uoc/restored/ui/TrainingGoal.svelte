<script lang="ts">
  import ShipMastery from "./ShipMastery.svelte";
  import TrainingEstimate from "./TrainingEstimate.svelte";
  import { FITTING_TIERS, type PlanDepth } from "../training/planner.ts";
  import {
    readTrainingHullGoals,
    readTrainingFittingGoals,
    runTrainingGoal,
    type ApiOptions,
  } from "../adapters/training.ts";

  import type { FundingPolicy, TrainingSheet } from "../training/types.ts";
  import type { TrainingWallet } from "../training/settings.ts";
  import { currentTrainingRequirements } from "../../training/queue.ts";
  let {
    characterID,
    options,
    fundingPolicy,
    trainingWallet,
    worldID = null,
    latestSheet,
    queueChanged,
  }: {
    characterID: number;
    options: ApiOptions;
    fundingPolicy: FundingPolicy;
    worldID?: string | null;
    latestSheet: TrainingSheet | null;
    queueChanged: (sheet: TrainingSheet) => void;
    trainingWallet: TrainingWallet | null;
  } = $props();
  let query = $state(""),
    selected = $state(0),
    busy = $state(false);
  let goals = $state<{ typeID: number; name: string }[]>([]);
  let kind = $state<"FITTING" | "HULL">("FITTING");
  let planDepth = $state<PlanDepth>("FAST");
  let excludedOptionalTypeIDs = $state<number[]>([]);
  let library = $state<Awaited<ReturnType<typeof readTrainingFittingGoals>> | null>(null);
  let group = $state(0),
    hull = $state(0),
    fitting = $state(0);
  const fits = $derived(
    (library?.choices ?? []).filter(
      (f) => (!group || f.groupID === group) && (!hull || f.shipTypeID === hull),
    ),
  );
  const selectedFit = $derived(fits.find((f) => f.fittingID === fitting));
  const groups = $derived(
    [
      ...new Map(
        (library?.choices ?? []).filter((f) => f.groupID).map((f) => [f.groupID!, f.groupName]),
      ),
    ].sort((a, b) => a[1].localeCompare(b[1])),
  );
  const hulls = $derived(
    [
      ...new Map(
        (library?.choices ?? [])
          .filter((f) => !group || f.groupID === group)
          .map((f) => [f.shipTypeID, f.hullName]),
      ),
    ].sort((a, b) => a[1].localeCompare(b[1])),
  );
  let result = $state<Awaited<ReturnType<typeof runTrainingGoal>>["outcome"] | null>(null);
  let sheetAtReview = $state<TrainingSheet | null>(null);
  const updatedSheet = $derived(
    result?.phase === "PREVIEW" && latestSheet === sheetAtReview ? null : latestSheet,
  );
  const displayedQueue = $derived(result?.queue ? (updatedSheet?.queue ?? result.queue) : null);
  const displayedRequirements = $derived(
    currentTrainingRequirements(result?.requirements ?? [], updatedSheet),
  );
  const remainingTrainingMs = $derived(
    displayedQueue?.active && displayedQueue.endTimeMs
      ? Math.max(0, displayedQueue.endTimeMs - Date.now())
      : displayedQueue?.active && !updatedSheet
        ? result?.remainingTrainingMs
        : null,
  );
  let message = $state("");
  const status = $derived(
    result
      ? ({
          PREVIEW: "Training plan",
          BLOCKED: "Training needs attention",
          QUEUE_VERIFIED: "Training queue verified",
          ALREADY_TRAINED_OR_QUEUED: "Requirements already trained or queued",
          BOOKS_DEFERRED: "Skillbook purchase deferred",
        }[result.phase] ?? "Training status unavailable")
      : null,
  );
  function resetReview() {
    result = null;
    excludedOptionalTypeIDs = [];
    message = "";
  }
  function toggleSkill(typeID: number, checked: boolean) {
    excludedOptionalTypeIDs = checked
      ? excludedOptionalTypeIDs.filter((id) => id !== typeID)
      : [...excludedOptionalTypeIDs, typeID];
    void execute("PREVIEW");
  }
  async function search() {
    if (busy || query.trim().length < 2) return;
    busy = true;
    message = "";
    goals = [];
    selected = 0;
    result = null;
    try {
      goals = (await readTrainingHullGoals(query.trim(), options)).goals;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }
  async function execute(mode: "PREVIEW" | "START") {
    const choice = kind === "FITTING" ? selectedFit : null,
      goalTypeID = choice?.shipTypeID ?? (kind === "HULL" ? selected : 0);
    if (busy || !goalTypeID) return;
    busy = true;
    message = "";
    try {
      result = (
        await runTrainingGoal(
          {
            characterID,
            goalTypeID,
            mode,
            ...(choice ? { planDepth, excludedOptionalTypeIDs, reviewKey: result?.reviewKey } : {}),
            ...(choice && library
              ? {
                  goalFitting: {
                    corporationID: library.corporationID,
                    fittingID: choice.fittingID,
                    fingerprint: choice.fingerprint,
                  },
                }
              : {}),
            fundingPolicy,
            trainingWallet,
            worldID,
          },
          options,
        )
      ).outcome;
      if (mode === "PREVIEW") sheetAtReview = latestSheet;
      if (result.sheet) queueChanged(result.sheet);
    } catch (error) {
      if (mode === "PREVIEW") result = null;
      message = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }
  async function loadLibrary() {
    busy = true;
    resetReview();
    fitting = 0;
    group = 0;
    hull = 0;
    try {
      library = await readTrainingFittingGoals(characterID, options);
    } catch (error) {
      library = null;
      message = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }
</script>

<section aria-label="Training goal">
  <h3>Training goal</h3>
  <div class="choices">
    <label>Train for<select bind:value={kind} disabled={busy} onchange={resetReview}>
      <option value="FITTING">Saved corporate fitting</option><option value="HULL">Hull only</option>
    </select></label>
    {#if kind==="FITTING"}
      <button type="button" disabled={busy} onclick={()=>void loadLibrary()}>{library?"Refresh fitting library":"Open corporation fitting library"}</button>
      {#if library}
        <label>Fitting library<select disabled><option>{library.corporationName??"Trainee’s corporation"}</option></select></label>
        <label>Ship group<select bind:value={group} disabled={busy} onchange={()=>{hull=0;fitting=0;resetReview();}}>
          <option value={0}>All groups</option>{#each groups as [id,name]}<option value={id}>{name}</option>{/each}
        </select></label>
        <label>Ship type<select bind:value={hull} disabled={busy} onchange={()=>{fitting=0;resetReview();}}>
          <option value={0}>All ship types</option>{#each hulls as [id,name]}<option value={id}>{name}</option>{/each}
        </select></label>
        <label>Saved fitting<select bind:value={fitting} disabled={busy} onchange={resetReview}>
          <option value={0}>Choose a fitting</option>{#each fits as fit}<option value={fit.fittingID}>{fit.name} · {fit.hullName}{fit.issue ? " · metadata or requirements unavailable" : ""}</option>{/each}
        </select></label>
        {#if selectedFit?.issue}<p role="status">{selectedFit.name}: {selectedFit.issue}</p>{/if}
      {/if}
    {:else}
    <label>Find a ship <input type="search" bind:value={query} disabled={busy}
      oninput={() => { selected = 0; result = null; }} /></label>
    <button type="button" disabled={busy || query.trim().length < 2} onclick={() => void search()}>Search</button>
    {#if goals.length}
      <label>Ship <select bind:value={selected} disabled={busy} onchange={() => result = null}>
        <option value={0}>Choose a ship</option>
        {#each goals as goal}<option value={goal.typeID}>{goal.name}</option>{/each}
      </select></label>
    {/if}
    {/if}
    {#if kind==='FITTING'}<label>Fitting plan depth<select bind:value={planDepth} disabled={busy} onchange={resetReview}>
      {#each FITTING_TIERS as tier}<option value={tier}>{tier}</option>{/each}
    </select></label><p>FAST covers mandatory fitting skills. BALANCED adds early support, VETERAN develops professional skills, and ELITE adds advanced goals for the chosen fitting.</p>{/if}
    <button type="button" disabled={busy || (kind==="FITTING"?!selectedFit:!selected)} onclick={() => void execute("PREVIEW")}>Show skills and cost</button>
    <button type="button" class="primary" disabled={busy || result?.phase!=='PREVIEW' || !!result.blockers?.length || (kind==="FITTING"?!selectedFit:!selected)} onclick={() => void execute("START")}>
      Start training
    </button>
  </div>
  {#if kind === "FITTING" && library?.unavailableFittingIDs.length}
    <p role="status">
      WC could not verify the saved fitting data needed for training ({library.unavailableFittingIDs.map(id => `#${id}`).join(", ")}).
    </p>
  {/if}
  {#if result}
    <p><strong>{status}</strong></p>
    {#if result.phase === "PREVIEW" && result.recommendations?.length}
      <fieldset disabled={busy}>
        <legend>Optional fitting recommendations</legend>
        <p>Clearing a recommendation keeps the fitting's mandatory levels and any prerequisites still needed by another selected goal.</p>
        {#each result.recommendations as skill (skill.typeID)}
          <label class="recommendation">
            <input type="checkbox" checked={skill.enabled} onchange={event => toggleSkill(skill.typeID,event.currentTarget.checked)} />
            <span><strong>{skill.name} · Level {skill.level}</strong>
              {#if skill.mandatoryLevel} · fitting requires level {skill.mandatoryLevel}{/if}
              {#if skill.bookNeeded} · {skill.bookCostISK === null ? "Direct book price unavailable" : `Skillbook ${skill.bookCostISK.toLocaleString()} ISK`}{/if}
              <small>{skill.reason}</small>
            </span>
          </label>
        {/each}
      </fieldset>
    {/if}
    {#if displayedRequirements.length}
      <ul>{#each displayedRequirements as item}
        <li>{item.name} · Level {item.level} · trained {item.currentLevel}
          {#if item.mandatoryLevel} · mandatory through level {item.mandatoryLevel}
          {:else if item.mandatoryLevel===0} · selected support or prerequisite{/if}
          {#if item.reviewState === "ALREADY_QUEUED"} · already queued
          {:else if item.reviewState === "TRAINING"} · training
          {:else if item.reviewState === "TRAINED"} · learned
          {:else if item.bookMissing} · skillbook needed{item.bookCostISK === undefined ? "" : ` (${item.bookCostISK} ISK)`}
          {:else if item.reviewState === "BLOCKED"} · waiting for prerequisite skillbooks{/if}
          {#if item.queuedLevel && item.queuedLevel < item.level && item.queuedLevel > item.currentLevel} · queued through level {item.queuedLevel}{/if}
        </li>
      {/each}</ul>
    {:else if result.requirementsUnavailable}<p>Detailed prerequisites are unavailable in this inspection.</p>{:else}<p>No missing requirements reported.</p>{/if}
    {#if result.phase==='PREVIEW'}<TrainingEstimate estimate={result} showSP={kind==='FITTING'} />
    {:else if result.totalISK != null}<p>{result.estimatedCost ? "Estimated skillbook cost" : "Skillbook cost"} {result.totalISK} ISK.</p>{/if}
    {#if result.fundedISK && Number(result.fundedISK) > 0}<p>Verified corporate funding: {result.fundedISK} ISK.</p>{/if}
    {#if displayedQueue}
      <p>Current native queue · {displayedQueue.entries.length} queued ·
        {displayedQueue.active ? "Training active" : displayedQueue.entries.length ? "Queue paused" : "Queue empty"}
        {#if remainingTrainingMs != null} · {Math.ceil(remainingTrainingMs / 60000)} min remaining in queue{/if}</p>
    {/if}
    {#if result.blockers?.length}<ul>{#each result.blockers as blocker}<li>{blocker}</li>{/each}</ul>{/if}
  {/if}
  {#if message}<p role="status">{message}</p>{/if}
</section>
{#if (kind==='FITTING'?selectedFit?.shipTypeID:selected)}
 {#key kind==='FITTING'?selectedFit?.shipTypeID:selected}
  <ShipMastery {characterID} {options} {fundingPolicy} {trainingWallet} {latestSheet} {queueChanged} shipTypeID={kind==='FITTING'?selectedFit!.shipTypeID:selected}/>
 {/key}
{/if}
<style>
  section {
    margin-block: 1rem;
    border-block: 1px solid #405062;
    padding-block: 0.75rem;
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.75rem;
  }
  label {
    display: grid;
    gap: 0.35rem;
  }
  .recommendation {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    margin: 0.45rem 0;
  }
  .recommendation small {
    display: block;
  }
  input,
  select {
    padding: 0.4rem;
    color: inherit;
    background: #16202e;
    border: 1px solid #455569;
  }
</style>
