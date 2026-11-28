<script lang="ts">
  import type { TrainingGoalOutcome } from "../adapters/training.ts";
  type Estimate = Pick<
    TrainingGoalOutcome,
    "totalISK" | "fundingEstimate" | "additionalSP" | "additionalTrainingMs" | "trainingTimeReason"
  >;
  let { estimate, showSP = false }: { estimate: Estimate; showSP?: boolean } = $props();
  function duration(ms: number) {
    const minutes = Math.ceil(ms / 60000);
    const days = Math.floor(minutes / 1440),
      hours = Math.floor((minutes % 1440) / 60);
    return [days && `${days} d`, hours && `${hours} h`, `${minutes % 60} min`]
      .filter(Boolean)
      .join(" ");
  }
</script>

{#if estimate.totalISK != null}<p>Estimated skillbook cost {estimate.totalISK} ISK.</p>{/if}
{#if estimate.fundingEstimate}
  {@const funds = estimate.fundingEstimate}
  <p>Expected funding · personal {funds.personalISK === null ? "unavailable" : `${funds.personalISK} ISK`} · corporation {funds.corporateISK === null ? "unavailable" : `${funds.corporateISK} ISK`}{funds.shortfallISK ? ` · unfunded ${funds.shortfallISK} ISK` : ""}.</p>
  {#if funds.reason}<p>{funds.reason}</p>{/if}
{/if}
{#if showSP && estimate.additionalSP != null}<p>Additional skill points: {estimate.additionalSP.toLocaleString()} SP.</p>{/if}
{#if estimate.additionalTrainingMs != null}
  <p>Additional training time: {duration(estimate.additionalTrainingMs)} at current attributes. Existing queued levels are excluded.</p>
{:else if estimate.trainingTimeReason}
  <p>Additional training time unavailable. {estimate.trainingTimeReason}</p>
{/if}
