<script lang="ts">
  import { onMount } from "svelte";
  import { checkMiningMissionRecovery, continueCivilianMission, listCivilianHosted, stopServerBot, type MiningMissionRecovery, type ServerBot } from "../app/api.ts";
  import { skipWhileBusy } from "../app/skipWhileBusy.ts";
  import { civilianMissionName, currentCivilianWorker } from "../app/civilianSession.ts";
  import { ownerOptions } from "../app/context.ts";
  import type { CivilianProfile } from "../../civilian/profile.ts";
  import CenterStatus from "./CenterStatus.svelte";

  let { profiles, accounts, watchedAccounts, refreshKey, parentBusy, onStart, onEdit, onRemove, onConfigure }: {
    profiles: readonly CivilianProfile[];
    accounts: readonly string[];
    watchedAccounts: readonly string[];
    refreshKey: number;
    parentBusy: boolean;
    onStart: (profile: CivilianProfile) => void;
    onEdit: (profile: CivilianProfile) => void;
    onRemove: (profile: CivilianProfile) => void;
    onConfigure: (bot: ServerBot, account: string) => void;
  } = $props();

  type Worker = {bot: ServerBot; account: string};
  type Snapshot = {fresh: boolean; data?: Awaited<ReturnType<typeof listCivilianHosted>>};
  let snapshots = $state.raw<Record<string, Snapshot>>({});
  let checks = $state<Record<string, MiningMissionRecovery>>({});
  let error = $state(""), refreshError = $state("");
  let busy = $state(false), loaded = $state(false);
  let serial = 0;
  const snapshot = (account: string) => snapshots[account.toLowerCase()];
  const workers = $derived(accounts.flatMap(account => (snapshot(account)?.data?.bots ?? []).map(bot => ({bot, account}))));
  const distinctPilots = $derived([...new Set(workers.map(row => row.bot.characterID))]);
  const unsaved = $derived(distinctPilots.filter(id => !profiles.some(profile => profile.pilot.characterID === id))
    .flatMap(id => {
      const worker = currentCivilianWorker(workers.filter(row => row.bot.characterID === id));
      return worker ? [worker] : [];
    }));
  const orphanChecks = $derived(accounts.flatMap(account => (snapshot(account)?.data?.recovery ?? []).map(row => ({row, account}))));
  const scopeNotice = $derived(accounts.map(account => snapshot(account)?.data?.recoveryUnavailable).find(Boolean));

  function profileWorkers(profile: CivilianProfile) {
    return workers.filter(worker => worker.bot.characterID === profile.pilot.characterID &&
      worker.account.toLowerCase() === profile.pilot.accountName.toLowerCase());
  }

  async function refresh(scope: readonly string[] = accounts) {
    const check = ++serial;
    const results = await Promise.allSettled(scope.map(async account =>
      listCivilianHosted({...await ownerOptions(account), priority: "poll"})));
    if (check !== serial) return;
    const next = {...snapshots};
    results.forEach((result, i) => {
      const key = scope[i]!.toLowerCase();
      next[key] = result.status === "fulfilled" ? {fresh:true,data:result.value} : {fresh:false,data:next[key]?.data};
    });
    snapshots = next;
    loaded = true;
    refreshError = results.some(result => result.status === "rejected") ? "Some mission pilots could not be refreshed." : "";
  }

  async function action(work: () => Promise<unknown>) {
    if (busy || parentBusy) return;
    busy = true; error = "";
    try { await work(); await refresh(); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }

  function recover(row: MiningMissionRecovery, account: string) {
    return action(async () => { checks[row.pin] = await checkMiningMissionRecovery(row, false, await ownerOptions(account)); });
  }

  onMount(() => {
    const poll = skipWhileBusy(async () => {
      if (!loaded) return;
      const relevant = [...new Set([...watchedAccounts, ...workers.filter(row => row.bot.civilianView !== "HISTORY").map(row => row.account)])];
      if (relevant.length) await refresh(relevant);
    });
    const timer = setInterval(() => void poll(), 3000);
    return () => { clearInterval(timer); ++serial; };
  });

  $effect(() => {
    const scope = accounts;
    void refreshKey;
    void refresh(scope);
  });
</script>

{#snippet status(worker: Worker)}
  {@const label = worker.bot.civilianStatus ?? worker.bot.status}
  <CenterStatus state={label === "Continuing" ? "Running" : label === "Stopped · Mission accepted" ? "Stopped" : label} {label} />
{/snippet}

{#snippet progress(worker: Worker, history = false)}
  {@const bot = worker.bot}
  {@const display = bot.civilianPresentation}
  {@const missionName = civilianMissionName(bot, history) ?? (bot.missionID ? `Mission #${bot.missionID}` : null)}
  <p>{display?.phase ?? bot.phase ?? bot.status}</p>
  <p class="muted">{missionName ?? "Mission pending"}
    {#if bot.missionProgress?.agentName} · {bot.missionProgress.agentName}
      {#if display?.agentSystemName} ({display.agentSystemName}){/if}
    {/if}
    {#if bot.missionProgress?.completedCount != null} · {bot.missionProgress.completedCount} completed{/if}
  </p>
  {#if display?.currentLocation && !history}
    <p class="muted">Last seen · {display.currentLocation.name}
      {#if display.currentLocation.systemName && !display.currentLocation.name.includes(display.currentLocation.systemName)}
        ({display.currentLocation.systemName})
      {/if}
    </p>
  {/if}
  {#if display?.showDestination && display.destination && !history}
    <p class="muted">Mission destination · {display.destination.name}</p>
  {/if}
  {#if bot.civilianStatus === "Needs attention" && bot.why}<p class="muted">{bot.why}</p>{/if}
  <details class="run-details">
    <summary>Run details</summary>
    <p>{bot.scriptName} · {worker.account}</p>
    {#if display?.runtime}<p>{display.runtime} maximum</p>{/if}
    {#if bot.missionProgress?.corporationName}<p>{bot.missionProgress.corporationName}</p>{/if}
    {#if display?.reason && bot.civilianStatus !== "Needs attention"}<p>{display.reason}</p>{/if}
    {#if bot.civilianSafetyReason && bot.civilianSafetyReason !== bot.why}<p>{bot.civilianSafetyReason}</p>{/if}
    {#if bot.parkingDestination}<p>Parking destination · {bot.parkingDestination.name ?? `Station ${bot.parkingDestination.id}`}</p>{/if}
    {#if bot.parkingProgress}<p>{bot.parkingProgress}</p>{/if}
    {#if bot.parking}<p>Parking · {bot.parking.phase} · {bot.parking.reason}</p>{/if}
    {#if display?.showRelease}<p>Session release · {bot.ownerRelease === "VERIFIED" ? "Verified" : "Unconfirmed"}</p>{/if}
    {#if bot.missionRecovery}<p>{bot.missionRecovery}</p>{/if}
    {#if !history && bot.civilianView === "RECOVERY" && bot.civilianCheckpointID}
      {@const checked = checks[bot.civilianCheckpointID]}
      {#if checked?.reason}<p>{checked.reason}</p>{/if}
      {#if checked?.journalStatus}<p>Journal · {checked.journalStatus} · Active {checked.activeMissions ?? "Unknown"} · Offered {checked.offeredMissions ?? "Unknown"}</p>{/if}
      <button type="button" disabled={busy || parentBusy} onclick={() => void recover({pin:bot.civilianCheckpointID!,characterID:bot.characterID,idle:false},worker.account)}>Check recovery</button>
    {/if}
    {#if bot.lastMissionReward}
      {@const reward = bot.lastMissionReward}
      <p>Last mission reward · Personal ISK {reward.confirmedIsk ?? "Unverified"}{#if reward.withheldIsk && reward.withheldIsk !== "0.00"} · Tax withheld {reward.withheldIsk}{/if}</p>
      {#if reward.observedLpChange !== null || reward.observedCorporationLpChange !== null}
        <p>Observed LP change · Personal {reward.observedLpChange ?? "Unavailable"} · Corporation {reward.observedCorporationLpChange ?? "Unavailable"}</p>
      {/if}
      {#if reward.observedCashChange !== null && reward.observedCashChange !== reward.confirmedIsk}<p>Observed wallet change {reward.observedCashChange} ISK.</p>{/if}
    {/if}
  </details>
{/snippet}

{#snippet missionActions(worker: Worker)}
  {#if worker.bot.canContinue}
    <button type="button" class="primary" disabled={busy || parentBusy || !snapshot(worker.account)?.fresh}
      onclick={() => void action(async () => continueCivilianMission(worker.bot, await ownerOptions(worker.account)))}>Continue</button>
  {/if}
  {#if !worker.bot.endedAt}
    <button type="button" class="danger" disabled={busy || parentBusy || !worker.bot.civilianOwned}
      onclick={() => void action(async () => stopServerBot(worker.bot.botID, await ownerOptions(worker.account)))}>Stop</button>
  {/if}
{/snippet}

{#snippet missionHistory(past: readonly Worker[])}
  {#if past.length}
    <details><summary>History ({past.length})</summary>
      {#each past as row (row.bot.botID)}{@render progress(row, true)}{/each}
    </details>
  {/if}
{/snippet}

<section class="workers" aria-label="Civilian mission pilots">
  {#if error || refreshError}<p class="center-message" role="alert">{error || refreshError}</p>{/if}
  {#each profiles as profile (profile.pilot.characterID)}
    {@const rows = profileWorkers(profile)}
    {@const worker = currentCivilianWorker(rows)}
    {@const past = rows.filter(row => row.bot.endedAt && row !== worker)}
    {@const account = snapshot(profile.pilot.accountName)}
    {@const ready = account?.fresh && account.data?.accountIdle}
    {@const idleLabel = ready ? "Ready" : account?.fresh ? "Account in use" : "Availability unknown"}
    {@const corporation = profile.agent?.corporationName ?? profile.corporationName ?? (profile.corporationID ? `Corporation #${profile.corporationID}` : "Any corporation")}
    <article class="center-panel profile">
      <header class="row"><strong>{profile.pilot.characterName}</strong>
        {#if worker}{@render status(worker)}{:else}<CenterStatus state={ready ? "Ready" : "Unknown"} label={idleLabel} />{/if}
      </header>
      <p>{profile.mode === "mining" ? "Mining Missions" : "Delivery / Courier"} · {profile.automatic ? "Automatic agent" : profile.agent?.name}
        · {corporation} · {profile.automatic && profile.fallback ? "Up to level" : "Level"} {profile.agent?.level ?? profile.level}</p>
      <p class="muted">{profile.policy === "TIME" ? `Stop after ${profile.runtime} min` : `Stop after ${profile.limit} completed`}
        {#if profile.policy === "COUNT"} · Max {profile.runtime} min{/if}
        {#if profile.automatic} · Agent within {profile.searchJumps} jumps{/if}
        {#if profile.mode === "distribution"} · Delivery within {profile.maxJumps} jumps{/if}
        · {profile.parking.mode === "SELECTED" ? profile.parking.destination.name : "Nearest accessible station"}</p>
      {#if worker}{@render progress(worker)}{/if}
      <div class="row">
        {#if worker}{@render missionActions(worker)}{/if}
        {#if (!worker || worker.bot.endedAt) && !worker?.bot.hasAcceptedMission}
          <button type="button" class="primary" disabled={parentBusy || busy || !ready} onclick={() => onStart(profile)}>Start</button>
        {/if}
        <button type="button" disabled={parentBusy || busy} onclick={() => onEdit(profile)}>Edit</button>
        <button type="button" disabled={parentBusy || busy} onclick={() => onRemove(profile)}>Remove</button>
      </div>
      {@render missionHistory(past)}
    </article>
  {/each}
  {#if !profiles.length && !unsaved.length && loaded}<p>Add a pilot to save its mission settings.</p>{/if}
  {#if !loaded}<p role="status">Checking mission pilots…</p>{/if}
  {#if unsaved.length}
    <h3>Existing mission pilots</h3>
    {#each unsaved as worker (worker.bot.characterID)}
      {@const past = workers.filter(row => row.bot.characterID === worker.bot.characterID && row.bot.endedAt && row !== worker)}
      <article class="center-panel profile">
        <header class="row"><strong>{worker.bot.characterName ?? worker.account}</strong>{@render status(worker)}</header>
        {@render progress(worker, worker.bot.civilianView === "HISTORY")}
        <p class="muted">No saved mission settings. Save a profile to start missions with your chosen settings.</p>
        <div class="row">
          {@render missionActions(worker)}
          <button type="button" disabled={parentBusy || busy} onclick={() => onConfigure(worker.bot, worker.account)}>Set up profile</button>
        </div>
        {@render missionHistory(past)}
      </article>
    {/each}
  {/if}
  {#if orphanChecks.length}
    <details><summary>Other mission records ({orphanChecks.length})</summary>
      {#each orphanChecks as {row, account} (row.pin)}
        <p>{account} · {checks[row.pin]?.reason ?? row.reason ?? "Mission state needs review."}</p>
        <button type="button" disabled={busy || parentBusy} onclick={() => void recover(row, account)}>Check recovery</button>
      {/each}
    </details>
  {/if}
  {#if scopeNotice}<details><summary>Storage details</summary><p>{scopeNotice}</p></details>{/if}
</section>

<style>
  .workers { margin: .75rem 0; padding: 0; border: 0; background: transparent; }
  .workers::before { content: none; }
  .profile { display:grid; gap:.3rem; margin:.7rem 0; }
  .row { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; }
  .run-details { margin:.2rem 0 .35rem; }
  .muted { color:var(--text-muted, #a7bec9); }
  p { margin:.2rem 0; }
</style>
