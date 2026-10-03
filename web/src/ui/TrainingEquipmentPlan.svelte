<script lang="ts">
  import type { TrainingEquipmentReview } from "../training/types.ts";
  import type { ApplyOutcome } from "../provisioning/centerClient.ts";
  let { review, outcome, message, busy, onApply, onRecover }: { review: TrainingEquipmentReview | null;
    outcome: ApplyOutcome | null; message: string; busy: boolean; onApply: () => void; onRecover: (id: string) => void } = $props();
</script>
<section aria-label="Equipment provisioning plan">
  <h3>Manual Provision Equipment</h3>
  <p class="note">Review does not select a pilot. Apply acquires only a free non-CEO pilot, revalidates, uses the shared Provision Ship engine and releases control. Skills, funding, corporation onboarding and Home are separate actions.</p>
  {#if message}<p role="status">{message}</p>{/if}
  {#if review}
    {@const detail = review.detail}
    {@const accepted = review.applyReview}
    {@const plan = accepted.plan}
    <p>Target: <strong>{detail.pilot.name}</strong> · Current hull: {detail.pilot.hullName || "Unknown"} · Fitting: <strong>{detail.selected?.name}</strong> · Definition corporation: {detail.definitions.corporationID}</p>
    <p>Physical source: {detail.candidateSource.kind === "corp" ? `Corporation ${detail.candidateSource.corporationID}, division ${detail.candidateSource.division}` : "Personal local hangar"}. Contents location: {detail.candidateSource.contentsLocationID}. Query: {detail.candidateSource.query}. Take: {detail.candidateSource.take} / revalidated on Apply.</p>
    <p>Plan: {plan?.mode || "Unavailable"} · New hulls: {plan?.hullQuantity ?? "UNKNOWN"} · Target hull: {plan?.targetHullName || "Unknown"}</p>
    {#if plan?.mode === "ALREADY_SATISFIED"}<p>Already exact: no new hull, modules or supply loading.</p>{/if}
    <ul>{#each detail.requirements as requirement}<li>{requirement.name} × {requirement.quantity} · {requirement.kind} · slot / bay {requirement.flagID}</li>{/each}</ul>
    <p>Supplies: {detail.status.supplies}. LOW supplies do not invalidate structural readiness.</p>
    <ul>{#each detail.status.targets as target}<li>{target.name}: {target.current ?? "UNKNOWN"} / {target.target} · {target.state}</li>{/each}</ul>
    <details><summary>Observed source stock</summary><ul>{#each detail.candidateSource.rows as row}<li>{row.name} × {row.quantity}</li>{/each}</ul></details>
    {#if accepted.reasons.length}<p role="status">Apply unavailable: {accepted.reasons.join(" · ")}</p>{:else}<p>Ready for Apply: free-only acquisition and fresh revalidation are still required.</p>{/if}
    <button type="button" disabled={busy || !accepted.canApply} onclick={onApply}>Provision Equipment</button>
  {/if}
  {#if outcome}<p role="status">{outcome.state} · {outcome.reason || ""} · Equipment {outcome.finalReview?.status.equipment || "UNKNOWN"} · Supplies {outcome.finalReview?.status.supplies || "UNKNOWN"} · Control release: {outcome.release.state}</p>
    {#if outcome.state === "BLOCKED"}<button class="minor" disabled={busy} onclick={() => onRecover(outcome.operationID)}>Reconcile control release</button>{/if}
  {/if}
</section>
<style>section { padding: 1rem; margin: 1rem 0; border: 1px solid #455569; border-radius: 6px; }</style>
