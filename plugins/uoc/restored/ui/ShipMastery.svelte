<script lang="ts">
  import {
    reviewShipMastery,
    applyShipMastery,
    type ApiOptions,
    type TrainingGoalOutcome,
  } from "../adapters/training.ts";
  import TrainingEstimate from "./TrainingEstimate.svelte";
  import type { FundingPolicy, TrainingSheet } from "../training/types.ts";
  import type { TrainingWallet } from "../training/settings.ts";
  import { currentTrainingRequirements } from "../../training/queue.ts";
  let {
    characterID,
    shipTypeID,
    options,
    fundingPolicy,
    trainingWallet,
    latestSheet,
    queueChanged,
  }: {
    characterID: number;
    shipTypeID: number;
    options: ApiOptions;
    fundingPolicy: FundingPolicy;
    trainingWallet: TrainingWallet | null;
    latestSheet: TrainingSheet | null;
    queueChanged: (sheet: TrainingSheet) => void;
  } = $props();
  let level = $state(1),
    busy = $state(false),
    used = $state(false),
    message = $state("");
  let review = $state<Awaited<ReturnType<typeof reviewShipMastery>> | null>(null),
    outcome = $state<TrainingGoalOutcome | null>(null);
  let sheetAtReview = $state<TrainingSheet | null>(null);
  const requirements = $derived(
    currentTrainingRequirements(
      review?.outcome.requirements ?? [],
      latestSheet === sheetAtReview ? null : latestSheet,
    ),
  );
  async function inspect() {
    busy = true;
    message = "";
    review = null;
    used = false;
    outcome = null;
    try {
      review = await reviewShipMastery(
        characterID,
        shipTypeID,
        level,
        options,
        fundingPolicy,
        trainingWallet,
      );
      sheetAtReview = latestSheet;
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
  async function apply() {
    if (!review || busy || used) return;
    busy = true;
    used = true;
    message = "";
    try {
      outcome = await applyShipMastery(review, options);
      if (outcome.sheet) queueChanged(outcome.sheet);
      message = "Native training queue verified.";
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>
<section aria-label="Ship Mastery">
 <h3>Ship Mastery I–V</h3>
 <p>The game’s actual certificate requirements for this selected hull. These levels are separate from fitting plan depth.</p>
 <label>Ship Mastery level<select bind:value={level} disabled={busy} onchange={()=>{review=null;outcome=null;used=false;message='';}}>
  {#each ['I','II','III','IV','V'] as name,i}<option value={i+1}>{name}</option>{/each}
 </select></label>
 <button disabled={busy} onclick={()=>void inspect()}>Review Ship Mastery</button>
 {#if review}
  <p>Native Mastery {['I','II','III','IV','V'][review.level-1]} · {review.certificates.length} certificates.</p>
  <details><summary>Required certificates</summary>{#each review.certificates as certificate}<p>{certificate.name} · Certificate {certificate.certificateID}</p>{/each}</details>
  <ul>{#each requirements as skill}<li>{skill.name} · Level {skill.level} · learned {skill.currentLevel}
   {#if skill.reviewState==='TRAINING'} · training{:else if skill.reviewState==='ALREADY_QUEUED'} · queued{:else if skill.reviewState==='TRAINED'} · learned{:else if skill.bookMissing} · skillbook required{:else} · missing levels{/if}
  </li>{/each}</ul>
  <TrainingEstimate estimate={review.outcome} />
  <button disabled={busy||used} onclick={()=>void apply()}>Queue reviewed Ship Mastery</button>
  <details><summary>Definition source</summary><pre>{JSON.stringify({shipTypeID,definitionTypeID:review.definitionTypeID,source:review.source},null,2)}</pre></details>
 {/if}
 {#if outcome?.queue}
  {@const queue = latestSheet?.queue ?? outcome.queue}
  <p>{queue.entries.length} entries · {queue.active?'Training active':queue.entries.length?'Queue paused':'Queue empty'}.</p>
 {/if}
 {#if outcome?.fundedISK}<p>Verified corporate funding: {outcome.fundedISK} ISK.</p>{/if}
 {#if message}<p role="status">{message}</p>{/if}
</section>
<style>
  section {
    margin-block: 1rem;
    border-block: 1px solid #405062;
    padding-block: 0.75rem;
  }
  label {
    display: inline-flex;
    gap: 0.5rem;
    align-items: center;
    margin: 0.5rem;
  }
  select,
  button {
    padding: 0.4rem;
    color: inherit;
    background: #16202e;
    border: 1px solid #455569;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
