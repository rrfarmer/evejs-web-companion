<script lang="ts">
  import CenterStatus from "./CenterStatus.svelte";
  import TrainingEstimate from "./TrainingEstimate.svelte";
  import {
    acquireFactorySkills,
    applyTrainingQueue,
    clearTrainingQueue,
    reviewSkillAcquisition,
    readTrainingSkillSheet,
    readTrainingProgress,
    reviewIndependentSkill,
    checkPendingFunding,
    type ApiOptions,
  } from "../adapters/training.ts";
  import type { FundingPolicy, TrainingSheet } from "../training/types.ts";
  import type { TrainingWallet } from "../training/settings.ts";
  let {
    characterID,
    options,
    fundingPolicy,
    trainingWallet,
    latestSheet,
    queueChanged,
  }: {
    characterID: number;
    options: ApiOptions;
    latestSheet: TrainingSheet | null;
    fundingPolicy: FundingPolicy;
    trainingWallet: TrainingWallet | null;
    queueChanged: (sheet: TrainingSheet) => void;
  } = $props();
  let result = $state<Awaited<ReturnType<typeof readTrainingSkillSheet>> | null>(null);
  let reviewed = $state<Awaited<ReturnType<typeof reviewIndependentSkill>> | null>(null);
  let purchase = $state<Awaited<ReturnType<typeof reviewSkillAcquisition>> | null>(null);
  let query = $state(""),
    typeID = $state(0),
    level = $state(1),
    busy = $state(false),
    error = $state(""),
    notice = $state("");
  let fundingCheck = $state<Awaited<ReturnType<typeof checkPendingFunding>> | null>(null);
  const names = $derived(new Map(result?.catalog.map((skill) => [skill.typeID, skill.name])));
  const sheet = $derived(latestSheet ?? result?.sheet);
  const trained = $derived(new Map(sheet?.skills.map((skill) => [skill.typeID, skill.level])));
  const matches = $derived(
    (result?.catalog ?? [])
      .filter((skill) => skill.name.toLowerCase().includes(query.trim().toLowerCase()))
      .slice(0, 25),
  );
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = "";
    notice = "";
    try {
      await action();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
  async function load() {
    const previous = latestSheet;
    const fresh =
      result && !result.catalogUnavailable
        ? { ...result, sheet: await readTrainingProgress(characterID, options) }
        : await readTrainingSkillSheet(characterID, options);
    result = fresh;
    if (previous === latestSheet) queueChanged(fresh.sheet);
  }
  async function refreshProgress() {
    const previous = latestSheet;
    const fresh = await readTrainingProgress(characterID, options);
    if (previous === latestSheet) queueChanged(fresh);
  }
  async function inspect() {
    reviewed = null;
    purchase = null;
    reviewed = await reviewIndependentSkill(characterID, typeID, level, options);
  }
  async function apply() {
    const id = reviewed?.reviewID;
    if (!id || !reviewed?.canApply) return;
    reviewed = null;
    const outcome = await applyTrainingQueue(id, options);
    notice = outcome.message;
    if (outcome.sheet) queueChanged(outcome.sheet);
    else await refreshProgress();
  }
  async function stopQueue() {
    if (
      !sheet?.queue.entries.length ||
      !window.confirm(
        "Stop training and clear this pilot’s entire skill queue? Earned skill points and injected books are kept.",
      )
    )
      return;
    const cleared = await clearTrainingQueue(sheet, options);
    reviewed = null;
    purchase = null;
    queueChanged(cleared);
    notice = "Training stopped. The native queue is empty.";
  }
  async function reviewPurchase() {
    purchase = null;
    purchase = await reviewSkillAcquisition(
      { characterID, typeID, level, independent: true, policy: fundingPolicy, trainingWallet },
      options,
    );
  }
  async function confirmPurchase() {
    const id = purchase?.reviewID;
    if (!id || !purchase?.canAcquire) return;
    purchase = null;
    reviewed = null;
    const outcome = await acquireFactorySkills(id, null, options);
    notice = outcome.message;
    if (outcome.sheet) queueChanged(outcome.sheet);
    else
      try {
        await refreshProgress();
      } catch {
        error =
          "Current skills could not be reloaded. Check the wallet and skills before trying again.";
      }
  }
  async function verifyFunding(confirmedAbsent?: string) {
    fundingCheck = null;
    fundingCheck = await checkPendingFunding(characterID, options, confirmedAbsent);
  }
</script>

<section aria-label="Pilot skills and training queue">
  <h3>Skills and training queue</h3>
  {#if sheet}
    <p>{sheet.skills.length} skills · {sheet.queue.entries.length} queued
      <CenterStatus state={sheet.queue.active ? "ACTIVE" : "STOPPED"} label={sheet.queue.active ? "Training active" : "No active training"} /></p>
    {#if sheet.queue.entries.length}
      {#if options.token}<button type="button" class="danger" disabled={busy} onclick={() => void run(stopQueue)}>Stop / Clear queue</button>{/if}
      <details><summary>Current queue</summary><ol>
        {#each sheet.queue.entries as entry}<li>{names.get(entry.typeID) ?? `Skill #${entry.typeID}`} · Level {entry.toLevel}</li>{/each}
      </ol></details>
    {/if}
    {#if result?.catalogUnavailable}<p>Skill catalogue names and independent queue editing are unavailable in this inspection.</p>{/if}
    <div class="choices">
      <label>Search skills <input type="search" bind:value={query} disabled={busy} oninput={() => { typeID = 0; reviewed = null; purchase = null; }} /></label>
      <label>Skill <select bind:value={typeID} disabled={busy} onchange={() => { reviewed = null; purchase = null; }}>
        <option value={0}>Choose a skill</option>
        {#each matches as skill (skill.typeID)}<option value={skill.typeID}>{skill.name} · {trained.has(skill.typeID) ? `Level ${trained.get(skill.typeID)}` : "Skillbook required"}</option>{/each}
      </select></label>
      <label>Target level <select bind:value={level} disabled={busy} onchange={() => { reviewed = null; purchase = null; }}>
        {#each [1,2,3,4,5] as target}<option value={target}>{target}</option>{/each}
      </select></label>
    </div>
    {#if !reviewed}
      <button type="button" disabled={busy || !typeID} onclick={() => void run(inspect)}>Review queue addition</button>
    {:else}
      {#if reviewed.blockers.length}
        <ul>{#each reviewed.blockers as blocker}<li>{blocker.message}</li>{/each}</ul>
        {#if reviewed.blockers.every(blocker => blocker.code === "SKILLBOOK_REQUIRED") && !purchase}
          <button type="button" disabled={busy} onclick={() => void run(reviewPurchase)}>Review skillbook cost</button>
        {/if}
      {:else if reviewed.canApply}
        <p>Keep {reviewed.existing.length} current entries and append:</p>
        <ol>{#each reviewed.additions as entry}<li>{entry.name} · Level {entry.toLevel}</li>{/each}</ol>
        <button type="button" class="primary" disabled={busy} onclick={() => void run(apply)}>Confirm queue addition</button>
      {:else}<p>This level is already trained or queued.</p>{/if}
      {#if purchase}
        <h4>Skillbook purchase</h4>
        <ul>{#each purchase.skills as skill}<li>{skill.name} · {skill.price} ISK</li>{/each}</ul>
        <TrainingEstimate estimate={{ totalISK: purchase.total, fundingEstimate: purchase.fundingEstimate }} />
        {#if purchase.canAcquire}
          <button type="button" disabled={busy} onclick={() => void run(confirmPurchase)}>Confirm purchase</button>
        {:else if !purchase.skills.length}<p>The trainee already knows these skills.</p>{/if}
      {/if}
      <button type="button" disabled={busy} onclick={() => { reviewed = null; purchase = null; }}>Back to skills</button>
    {/if}
  {:else if busy}<p>Reading skills…</p>{/if}
  {#if !busy && error}<p role="alert">{error}</p>{/if}
  <details>
    <summary>Corporate funding</summary>
    <button type="button" disabled={busy} onclick={() => void run(() => verifyFunding())}>Check pending funding</button>
    {#if fundingCheck}
      <p role="status">{fundingCheck.message}</p>
      {#if fundingCheck.reference}
        {@const ref = fundingCheck.reference}
        <p>Check the original request has finished and both wallet histories cover the attempt. Include archived entries if needed.</p>
        <button type="button" disabled={busy} onclick={() => {
          if (window.confirm(`I verified that the original request has finished and neither wallet recorded ${ref}. Release this attempt?`))
            void run(() => verifyFunding(ref));
        }}>Confirm absent and release</button>
      {/if}
    {/if}
  </details>
  <button type="button" disabled={busy} onclick={() => void run(load)}>{sheet ? "Refresh skills" : "Read skills and queue"}</button>
  {#if notice}<p role="status">{notice}</p>{/if}
</section>
<style>
  section {
    margin-block: 1rem;
    border-block: 1px solid #405062;
    padding-block: 0.75rem;
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-block: 0.75rem;
  }
  label {
    display: grid;
    gap: 0.35rem;
  }
  input,
  select {
    padding: 0.4rem;
    color: inherit;
    background: #16202e;
    border: 1px solid #455569;
  }
  [role="alert"] {
    color: #ffc099;
  }
</style>
