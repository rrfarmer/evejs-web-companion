<!-- WC74 web/src/ui/MiningOperationRun.svelte @ 213da333; imports adapted for UOC plugin. -->
<script lang="ts">
  import type { MiningOperationRuntime } from "../adapters/mining.ts";
  import {
    miningOperationRunView,
    operationTime,
    operationRemaining,
    operationMemberRecovery,
  } from "../mining/miningOperationRunView.ts";
  import { hostedDurationLabel, type HostedRunPolicy } from "../mining/hostedRunPolicy.ts";
  let {
    runtime,
    policy,
    parking = false,
    stale = false,
    busy = false,
    onExtend,
  }: {
    runtime: MiningOperationRuntime;
    policy: HostedRunPolicy | null;
    parking?: boolean;
    stale?: boolean;
    busy?: boolean;
    onExtend: (minutes: number) => void;
  } = $props();
  const view = $derived(miningOperationRunView(runtime, policy, parking));
  const blockedExtensionChoices = $derived(
    runtime.extensionSupported === false
      ? miningOperationRunView({ ...runtime, extensionSupported: true }, policy, parking).choices
      : [],
  );
  const supportFresh = $derived(
    !!runtime.supportStatus &&
      Number.isFinite(Date.parse(runtime.observedAt ?? "")) &&
      runtime.supportStatus.observedAtMs <= Date.parse(runtime.observedAt ?? "") &&
      Date.parse(runtime.observedAt ?? "") - runtime.supportStatus.observedAtMs <= 60000,
  );
  const supportHistorical = $derived(
    stale ||
      runtime.state === "WAITING_FOR_HOST" ||
      !!runtime.recoveryRequired ||
      (!!runtime.supportStatus && !supportFresh) ||
      ["DRAFT", "STOPPING", "PARKING", "PARKING_FAILED", "STOPPED"].includes(runtime.state),
  );
  const supportLabel = $derived(
    stale ||
      runtime.state === "WAITING_FOR_HOST" ||
      runtime.recoveryRequired ||
      (!!runtime.supportStatus && !supportFresh)
      ? "CURRENT STATE UNKNOWN"
      : runtime.state === "DRAFT"
        ? "NOT STARTED"
        : runtime.state === "STOPPED"
          ? "RUN ENDED"
          : "SETTLING",
  );
</script>

{#if runtime.members.some(member=>member.role==='COMMAND')}
  <section aria-label="Command capabilities">
    {#if supportHistorical}
      <strong>Command / Support · {supportLabel}</strong>
      <p>Historical support observation. Current module settlement and release follow the operation's Parking and member states.</p>
      {#if runtime.supportStatus}
        <details><summary>Previous capability observation · {operationTime(new Date(runtime.supportStatus.observedAtMs).toISOString())}</summary>
          <p>{runtime.supportStatus.reason ?? runtime.supportStatus.state}</p>
          <ul>{#each runtime.supportStatus.capabilities ?? [] as capability}<li><strong>{capability.capability}: {capability.state.replaceAll('_',' ')}</strong> {capability.reason}</li>{/each}</ul>
        </details>
      {/if}
    {:else}
    <strong>Command / Support · {runtime.supportStatus?.state ?? 'PENDING'}</strong>
    <p>{runtime.supportStatus?.reason ?? (runtime.supportStatus?.state==='READY'?'Fitted support was confirmed in the last physical observation.':'Current physical capability readback is pending.')}</p>
    {#if runtime.supportStatus}<p class="muted">Last support observation: {operationTime(new Date(runtime.supportStatus.observedAtMs).toISOString())}. {#if ['STOPPING','PARKING','PARKING_FAILED','STOPPED'].includes(runtime.state)}Module settlement and release follow the operation's Parking state.{/if}</p>{/if}
    {#if runtime.supportStatus?.capabilities?.length}
      <ul>{#each runtime.supportStatus.capabilities as capability}<li><strong>{capability.capability}: {capability.state.replaceAll('_',' ')}</strong>{#if capability.capability!=='Mobility'} · {capability.modules} fitted.{/if} {capability.reason}</li>{/each}</ul>
    {:else}<p>Bursts, Core, compression and tractor capabilities are verified on the selected ship after acquisition.</p>{/if}
    {/if}
  </section>
{/if}

{#if runtime.startedAt || view.hosted.length || runtime.recoveryRequired || runtime.members.some(member => member.lastHostReason)}
  <section aria-label="Hosted operation timing">
    <p><strong>Started:</strong> {operationTime(runtime.startedAt)}{#if runtime.shiftEndsAt} · <strong>Shift ends:</strong> {operationTime(runtime.shiftEndsAt)}{/if} · <strong>Hosted until:</strong> {operationTime(view.expiresAt)} · <strong>Grant time left:</strong> {operationRemaining(view.remainingMs)} · <strong>Hosted:</strong> {view.hosted.length} / {runtime.members.length}</p>
    <p class="muted">{stale ? "Last known server state — disconnected/stale" : "Server state"} as of {operationTime(runtime.observedAt)}. Earliest currently hosted required-member expiry, including haulers. Times shown in your local timezone.</p>
    {#if !view.hosted.length}<p>No active hosted member grants.</p>{/if}
    {#if view.grantMismatch}<p class="notice"><strong>Grant mismatch:</strong> Earliest {operationTime(view.expiresAt)} · Latest {operationTime(view.latestExpiresAt)}. Details below.</p>{/if}
    {#each view.warnings as warning}<p class="notice">{warning}</p>{/each}
    {#if view.maximumReached}<p class="notice">Maximum hosted runtime reached: {hostedDurationLabel(policy!.maxRuntimeMinutes)}.</p>
    {:else if view.canExtend && view.hosted.length && !view.choices.length}<p>No offered extension fits a currently running, unexpired member grant under the server policy.</p>{/if}
    {#if view.choices.length}
      <div class="extend"><strong>Extend:</strong>{#each view.choices as choice}<button type="button" disabled={busy || stale} onclick={() => onExtend(choice.minutes)}>+{hostedDurationLabel(choice.minutes)} ({choice.count}/{runtime.members.length})</button>{/each}</div>
      <p class="muted">Counts show eligible members. Failed/unavailable or capped members are not extended; results are reported individually.</p>
    {/if}
    {#if blockedExtensionChoices.length}
      <div class="extend"><strong>Extend:</strong>{#each blockedExtensionChoices as choice}<button type="button" disabled title="The public WC host cannot extend an existing plugin credential.">+{hostedDurationLabel(choice.minutes)} ({choice.count}/{runtime.members.length})</button>{/each}</div>
      <p class="muted">Unavailable under the current public host contract. The existing expiry remains in force.</p>
    {/if}
    <details open={runtime.recoveryRequired}><summary>Member grants</summary><ul>
      {#each runtime.members as member}<li><strong>{member.characterName} · {member.role}</strong>: {operationMemberRecovery(member, !!runtime.recoveryRequired, runtime.observedAt)}
        {#if member.hosted}<br />Started {operationTime(member.hostStartedAt)} · Expires {operationTime(member.expiresAt)}{#if member.hostResumedAt} · Recovered {operationTime(member.hostResumedAt)}{/if}{/if}
        {#if member.lastHostReason}<br />{member.lastHostReason}{/if}
      </li>{/each}
    </ul></details>
  </section>
{/if}

<style>
  p {
    margin: 0.35rem 0;
  }
  .muted {
    color: #93a9b5;
    font-size: 0.9em;
  }
  .notice {
    display: block;
    border-left: 3px solid #d4a84d;
    padding: 0.3rem 0.6rem;
    margin: 0.5rem 0;
    overflow-wrap: anywhere;
  }
  .extend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
    margin-top: 0.5rem;
  }
  button {
    border: 1px solid #395362;
    border-radius: 4px;
    background: #101b22;
    color: inherit;
    padding: 0.35rem 0.55rem;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  li {
    margin: 0.3rem 0;
  }
</style>
