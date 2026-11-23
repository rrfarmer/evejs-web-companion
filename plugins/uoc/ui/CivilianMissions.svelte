<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { checkPluginRun, createPilotReach, createPluginRunGrant, loadKnownAccounts, loadKnownCharacters, skipWhileBusy, startPluginRun, pluginPostJson, type JsonValue, type PluginRunPolicy, type ServerBot, type Session, type FindAgentsResult, type GlobalWindowProps } from "../../../web/src/plugin-api/index.ts";
  import { filterCivilianAgents, loadCivilianAgents, type CivilianMissionType } from "../civilianAgents.ts";
  import { parseAccountRoster } from "./accountRoster.ts";
  import { createTrainingAccountPass } from "../training/accountPass.ts";
  import {prepareHeldPilot} from "../heldPilot.ts";

  let { sessions = [] }: GlobalWindowProps = $props();
  let type = $state<CivilianMissionType>("mining");
  let level = $state(1);
  let levelRule = $state<"exact" | "max">("max");
  let corporationID = $state<number | null>(null);
  let query = $state("");
  let directory = $state.raw<FindAgentsResult | null>(null);
  let busy = $state(false);
  let error = $state("");
  let pending: AbortController | null = null;
  type Pilot = {session: Session | null; characterID: number; name: string; accountName:string};
  let pilots = $state<Pilot[]>([]);
  let accountRoster = $state<Pilot[]>([]);
  let civilianAccount = $state("");
  let pilotID = $state(0);
  let agentMode = $state<"manual" | "auto">("auto");
  let manualAgentID = $state<number | null>(null);
  let manualStationID = $state<number | null>(null);
  let maxJumps = $state(10);
  let stopMode = $state<"count"|"time">("count");
  let missionCount = $state(1);
  let durationMinutes = $state(60);
  let parkingMode = $state<"nearest"|"selected">("nearest");
  let parkingKind = $state<"station"|"structure">("station");
  let parkingDestinationID = $state<number|null>(null);
  let parkingSystemID = $state<number|null>(null);
  let runBusy = $state(false);
  let runError = $state("");
  let rosterError = $state("");
  let bots = $state<ServerBot[]>([]);
  const recovery = $derived(bots.filter((bot) => !bot.endedAt &&
    (bot.phase === "Stop blocked" || bot.phase === "Parking failed" || bot.phase === "Session release blocked" ||
      bot.phase === "Unresolved write custody")));
  const current = $derived(bots.filter((bot) => !bot.endedAt && !recovery.includes(bot)));
  const history = $derived(bots.filter((bot) => bot.endedAt));
  const reach = createPilotReach({
    pass: createTrainingAccountPass(),
    held: () => sessions,
    known: () => [...accountRoster.map(p=>({characterID:p.characterID,characterName:p.name,accountName:p.accountName})), ...pilots.map(p=>({characterID:p.characterID,characterName:p.name,accountName:p.accountName})), ...loadKnownCharacters()],
    accounts: () => [...new Set([...accountRoster.map(p=>p.accountName), ...loadKnownAccounts(), ...sessions.map(s=>s.store.get().session.username).filter((name):name is string=>!!name)])],
  });
  let reviewed = $state<{ setup: JsonValue; policy: PluginRunPolicy; name: string; fingerprint: string; accountName: string; characterID: number } | null>(null);
  const selectedPilot = $derived(pilots.find((pilot) => pilot.characterID === pilotID) ?? null);
  const runKind = $derived(type === "mining" ? "civilian-mining" : "civilian-distribution");
  // Preserve Mining's exact canonical setup and add the delivery limit and station only for Distribution.
  const parking = $derived(parkingMode==="nearest" ? {mode:"nearest" as const} : {mode:"selected" as const,kind:parkingKind,destinationID:parkingDestinationID,systemID:parkingSystemID});
  const limit = $derived(stopMode==="time" ? {missionCount:100,durationMinutes} : {missionCount});
  const setup = $derived(type === "mining"
    ? (agentMode === "manual"
      ? { agent: { mode: "manual", agentID: manualAgentID }, ...limit, parking }
      : { agent: { mode: "auto", levelRule, level, corporationID, maxJumps }, ...limit, parking })
    : (agentMode === "manual"
      ? { agent: { mode: "manual", agentID: manualAgentID, stationID: manualStationID }, maxJumps, ...limit, parking }
      : { agent: { mode: "auto", levelRule, level, corporationID, maxJumps }, maxJumps, ...limit, parking }));
  const fingerprint = $derived(JSON.stringify([runKind, setup]));
  const reviewValid = $derived(reviewed !== null && reviewed.fingerprint === fingerprint && reviewed.accountName === selectedPilot?.accountName && reviewed.characterID === selectedPilot?.characterID);

  // A live Cockpit session is optional; the other choices come only from a current account roster.
  $effect(() => {
    const roster=accountRoster;
    const refresh = () => {
      const live:Pilot[] = sessions.flatMap((session) => {
        const state = session.store.get(), online = state.station.online, accountName=state.session.username;
        return session.flow.sessionToken() && state.session.phase === "logged-in" && online && accountName && state.character.selectedCharacterID === online.characterID
          ? [{ session, characterID: online.characterID, name: online.characterName, accountName }] : [];
      });
      pilots=[...live,...roster.filter(p=>!live.some(l=>l.characterID===p.characterID))];
    };
    refresh();
    const unsubs = sessions.flatMap((session) => [session.store.session.subscribe(refresh), session.store.character.subscribe(refresh), session.store.station.subscribe(refresh)]);
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
  });
  function owner() {
    const pilot = selectedPilot;
    if (!pilot) throw new Error("Select a pilot from an authenticated account.");
    if(pilot.session){const state = pilot.session.store.get();
      if (!pilot.session.flow.sessionToken() || state.session.phase !== "logged-in" || state.character.selectedCharacterID !== pilot.characterID || state.station.online?.characterID !== pilot.characterID)
        throw new Error("The pilot session changed. Select the pilot and review again.");
    }
    return pilot;
  }
  async function loadPilots(){
    const name=civilianAccount.trim();if(!name||runBusy)return;runBusy=true;runError="";reviewed=null;pilotID=0;
    accountRoster=accountRoster.filter(p=>p.accountName.toLowerCase()!==name.toLowerCase());
    try{const options=await reach.accountOptions(name);if(!options.token)throw new Error("Account authentication is unavailable.");
      const response=await(options.fetch??globalThis.fetch)(`${options.baseUrl??""}/api/pilot-training/characters`,{headers:{authorization:`Bearer ${options.token}`},credentials:"omit"});
      const data=await response.json();if(!response.ok||civilianAccount.trim()!==name)throw new Error("The account roster is unavailable or changed.");
      const rows:Pilot[]=parseAccountRoster(data,name).map(p=>({...p,session:null}));accountRoster=[...accountRoster,...rows];
    }catch(cause){runError=cause instanceof Error?cause.message:"Could not load pilots.";}finally{runBusy=false;}
  }

  async function refreshRuns() {
    try {
      const read = await reach.readServerBots();
      rosterError = read.allFailed ? "Could not read hosted mission runs." :
        read.missing.length ? `Could not read runs for ${read.missing.join(", ")}.` : "";
      if (!read.allFailed) bots = read.bots.filter((bot) => bot.kind === "plugin" && bot.plugin?.pluginID === "uoc" && ["civilian-mining", "civilian-distribution"].includes(bot.plugin.run));
    } catch (cause) {
      rosterError = cause instanceof Error ? cause.message : "Could not read hosted mission runs.";
    }
  }

  async function reviewRun() {
    if (runBusy) return;
    reviewed = null;
    runError = "";
    try {
      const pilot = owner();
      if (agentMode === "manual" && (!Number.isInteger(manualAgentID) || (manualAgentID ?? 0) <= 0 ||
          (type === "distribution" && (!Number.isInteger(manualStationID) || (manualStationID ?? 0) <= 0)))) throw new Error("Select an agent with a known station from the directory.");
      if ((agentMode === "auto" || type === "distribution") && (!Number.isInteger(maxJumps) || maxJumps < 1 || maxJumps > 30)) throw new Error("Maximum jumps must be a whole number from 1 to 30.");
      if (stopMode === "count" && (!Number.isInteger(missionCount) || missionCount < 1 || missionCount > 100)) throw new Error("Mission count must be 1 to 100.");
      if (stopMode === "time" && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 4320)) throw new Error("Run time must be 1 to 4320 minutes.");
      if (parkingMode === "selected" && (!Number.isSafeInteger(parkingDestinationID) || (parkingDestinationID ?? 0) <= 0 || !Number.isSafeInteger(parkingSystemID) || (parkingSystemID ?? 0) <= 0)) throw new Error("Enter the destination and solar system IDs.");
      const original = fingerprint;
      runBusy = true;
      const result = await checkPluginRun("uoc", runKind, setup as JsonValue, await reach.ownerOptions(pilot.characterID));
      if (original !== fingerprint || owner().characterID !== pilot.characterID || owner().accountName !== pilot.accountName) throw new Error("Setup or pilot changed. Review again.");
      reviewed = { ...result, fingerprint: original, accountName: pilot.accountName, characterID: pilot.characterID };
    } catch (cause) {
      runError = cause instanceof Error ? cause.message : "Could not review the run.";
    } finally { runBusy = false; }
  }

  async function startRun() {
    if (runBusy || !reviewValid || !reviewed) return;
    runBusy = true;
    runError = "";
    try {
      const pilot = owner();
      const approved = reviewed;
      if(pilot.session)await prepareHeldPilot(pilot.session,pilot.characterID);
      if(!reviewValid||reviewed!==approved||owner().characterID!==pilot.characterID)throw new Error("Setup or pilot changed before Start. Review again.");
      const options=await reach.ownerOptions(pilot.characterID);
      if(!reviewValid||reviewed!==approved||owner().characterID!==pilot.characterID)throw new Error("Setup or pilot changed before Start. Review again.");
      await startPluginRun(pilot.characterID, "uoc", runKind, approved.setup, createPluginRunGrant(approved.policy), options);
      reviewed = null;
      await refreshRuns();
    } catch (cause) { runError = cause instanceof Error ? cause.message : "Could not start the run."; }
    finally { runBusy = false; }
  }

  async function stopRun(bot: ServerBot) {
    if (runBusy) return;
    runBusy = true;
    runError = "";
    try {
      await pluginPostJson("uoc", `/runs/${encodeURIComponent(bot.botID)}/stop`, {}, await reach.ownerOptions(bot.characterID));
      await refreshRuns();
    } catch (cause) { runError = cause instanceof Error ? cause.message : "Could not stop the run."; }
    finally { runBusy = false; }
  }

  function readout(bot: ServerBot) {
    const value = bot.plugin?.readout;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, JsonValue> : {};
  }

  onMount(() => {
    const refresh = skipWhileBusy(refreshRuns);
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { clearInterval(timer); void reach.release(); };
  });

  const displayLimit = 60;
  const corporations = $derived([...new Map(
    directory?.agents.flatMap((agent) => agent.corporationID && agent.corporationName
      ? [[agent.corporationID, agent.corporationName] as const] : []) ?? [],
  )].sort((a, b) => a[1].localeCompare(b[1])));
  const agents = $derived(filterCivilianAgents(directory?.agents ?? [], { level, levelRule, corporationID, query }));

  onDestroy(() => pending?.abort());

  function changeType() {
    directory = null;
    corporationID = null;
    error = "";
    manualAgentID = null;
    manualStationID = null;
  }

  async function load() {
    if (busy) return;
    const request = new AbortController();
    pending = request;
    busy = true;
    error = "";
    try {
      const options=selectedPilot?await reach.ownerOptions(selectedPilot.characterID):await reach.libraryOptions();
      const result = await loadCivilianAgents(type, {
        ...options,
        priority: "user",
        signal: request.signal,
      });
      if (!request.signal.aborted) directory = result;
    } catch (cause) {
      if (!request.signal.aborted) {
        directory = null;
        error = cause instanceof Error ? cause.message : "The agent directory could not be loaded.";
      }
    } finally {
      busy = false;
      pending = null;
    }
  }
</script>

<section class="panel" aria-label="Civilian Missions agent directory">
  <header class="panel-head">
    <h2>Civilian Missions</h2>
  </header>
  <p>Agent access and mission availability are checked for the selected pilot.</p>
  <div class="filters">
    <label>Mission type
      <select bind:value={type} onchange={changeType} disabled={busy || runBusy}>
        <option value="mining">Mining</option>
        <option value="distribution">Distribution</option>
      </select>
    </label>
  </div>
  <section aria-label="Hosted civilian missions">
    <h3>Hosted civilian {type}</h3>
    <p>Runs on the server after this window closes. Choose a mission count or run time; the host parks after the limit or a stop.</p>
    <div class="filters">
      <label>Civilian account <input bind:value={civilianAccount} disabled={runBusy} placeholder="Account name" /></label>
      <button type="button" onclick={loadPilots} disabled={runBusy || !civilianAccount.trim()}>Load pilots</button>
      <label>Pilot
        <select bind:value={pilotID} disabled={runBusy}>
          <option value={0}>Select a pilot</option>
          {#each pilots as pilot (pilot.characterID)}<option value={pilot.characterID}>{pilot.name} · {pilot.accountName} ({pilot.characterID})</option>{/each}
        </select>
      </label>
      <label>Agent selection
        <select bind:value={agentMode} disabled={runBusy}>
          <option value="auto">Automatic eligible agent</option>
          <option value="manual">Selected directory agent</option>
        </select>
      </label>
      {#if agentMode === "auto"}
        <label>Agent level rule <select bind:value={levelRule}><option value="exact">Exactly this level</option><option value="max">Up to this level</option></select></label>
        <label>Agent level <select bind:value={level}>{#each [1, 2, 3, 4] as value}<option value={value}>{value}</option>{/each}</select></label>
        <label>Agent NPC corporation <select bind:value={corporationID}><option value={null}>Any corporation</option>{#each corporations as [id, name] (id)}<option value={id}>{name}</option>{/each}</select></label>
      {:else}
        <p>{manualAgentID ? `Selected agent ID: ${manualAgentID}` : `Find ${type} agents below and select one.`}</p>
      {/if}
      {#if agentMode === "auto" || type === "distribution"}<label>Maximum jumps <input type="number" min="1" max="30" step="1" bind:value={maxJumps} /></label>{/if}
      <label>Stop after <select bind:value={stopMode}><option value="count">Mission count</option><option value="time">Run time</option></select></label>
      {#if stopMode === "count"}<label>Missions <input type="number" min="1" max="100" step="1" bind:value={missionCount} /></label>{:else}<label>Minutes <input type="number" min="1" max="4320" step="1" bind:value={durationMinutes} /></label>{/if}
      <label>Parking <select bind:value={parkingMode}><option value="nearest">Nearest accessible dock at stop</option><option value="selected">Selected destination</option></select></label>
      {#if parkingMode === "selected"}
        <label>Destination type <select bind:value={parkingKind}><option value="station">NPC station</option><option value="structure">Accessible structure</option></select></label>
        <label>Destination ID <input type="number" min="1" step="1" bind:value={parkingDestinationID} /></label>
        <label>Solar system ID <input type="number" min="1" step="1" bind:value={parkingSystemID} /></label>
      {/if}
    </div>
    {#if agentMode === "auto" && !directory}<p>Load the agent directory below to choose a corporation.</p>{/if}
    <button type="button" onclick={reviewRun} disabled={runBusy || !selectedPilot}>Review run</button>
    {#if runError}<p role="alert">{runError}</p>{/if}
    {#if reviewed && reviewValid}
      <div aria-label="Run review">
        <h4>Review {reviewed.name}</h4>
        <p>Pilot: {selectedPilot?.name}. {stopMode === "count" ? `Mission count: ${missionCount}.` : `Run time: ${durationMinutes} minutes.`} Starting hands control to the server.</p>
        <p>Server policy risks: {reviewed.policy.riskClasses.join(", ") || "none listed"}. Restart safe: {reviewed.policy.restartSafe ? "yes" : "no"}.</p>
        <pre>{JSON.stringify(reviewed.setup, null, 2)}</pre>
        <button type="button" onclick={startRun} disabled={runBusy}>Approve and start</button>
      </div>
    {/if}
    <h4>Current mission pilots</h4>
    <button type="button" onclick={refreshRuns} disabled={runBusy}>Refresh runs</button>
    {#if rosterError}<p role="alert">{rosterError}</p>{/if}
    {#if current.length === 0 && !rosterError}<p>No current hosted civilian mission runs.</p>{/if}
    {#each current as bot (bot.botID)}{@render hostedRun(bot)}{/each}
    {#if recovery.length}
      <h4>Recovery</h4>
      {#each recovery as bot (bot.botID)}{@render hostedRun(bot)}{/each}
    {/if}
    {#if history.length}
      <details>
        <summary>History ({history.length})</summary>
        {#each history as bot (bot.botID)}{@render hostedRun(bot)}{/each}
      </details>
    {/if}
  </section>

  <div class="filters">
    <button type="button" onclick={load} disabled={busy}>
      {busy ? "Loading agents…" : directory ? "Refresh agents" : "Find agents"}
    </button>
  </div>

  {#if error}<p role="alert">{error}</p>{/if}

  {#if directory}
    <div class="filters">
      <label>Level rule
        <select bind:value={levelRule}>
          <option value="exact">Exactly this level</option>
          <option value="max">Up to this level</option>
        </select>
      </label>
      <label>Level
        <select bind:value={level}>
          {#each [1, 2, 3, 4] as value}
            <option value={value}>{value}</option>
          {/each}
        </select>
      </label>
      <label>NPC corporation
        <select bind:value={corporationID}>
          <option value={null}>Any corporation</option>
          {#each corporations as [id, name] (id)}
            <option value={id}>{name}</option>
          {/each}
        </select>
      </label>
      <label>Agent or location <input bind:value={query} type="search" /></label>
    </div>

    {#if directory.capped}
      <p>The server returned only {directory.agents.length} of {directory.total} agents. Matches below cover the returned entries.</p>
    {/if}
    {#if agents.length}
      <p aria-live="polite">Showing {Math.min(displayLimit, agents.length)} of {agents.length} matches.</p>
      <ul>
        {#each agents.slice(0, displayLimit) as agent (agent.agentID)}
          <li>
            <strong>{agent.name}</strong> · Level {agent.level}
            {#if agent.corporationName} · {agent.corporationName}{/if}
            <button type="button" onclick={() => { manualAgentID = agent.agentID; manualStationID = agent.stationID; agentMode = "manual"; }}>Select agent</button>
            <span>{agent.stationName ?? "Station name unavailable"}{#if agent.solarSystemName} · {agent.solarSystemName}{/if}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p aria-live="polite">No directory entries match these filters.</p>
    {/if}
  {/if}
</section>


{#snippet hostedRun(bot: ServerBot)}
  {@const report = readout(bot)}
  {@const reward = report.reward as Record<string, JsonValue> | null | undefined}
  <div class="run" aria-label="Hosted run" data-bot-id={bot.botID}>
    <p>{bot.characterName ?? "Pilot"} · {bot.phase ?? bot.status}</p>
    {#if typeof report.completedCount === "number"}<p>Confirmed missions: {report.completedCount}</p>{/if}
    {#if bot.why}<p>{bot.why}</p>{/if}
    {#if typeof report.note === "string"}<p>{report.note}</p>{:else if bot.note}<p>{bot.note}</p>{/if}
    {#if bot.parking?.destinationName}<p>Parking destination: {bot.parking.destinationName}</p>{/if}
    {#if bot.parking?.reason}<p>{bot.parking.reason}</p>{/if}
    {#if typeof reward?.confirmedIsk === "string"}<p>Mission payout: {reward.confirmedIsk} ISK</p>{/if}
    {#if typeof reward?.observedLpChange === "string"}<p>Observed LP change: {reward.observedLpChange}</p>{/if}
    {#if bot.plugin?.readout != null}
      <details><summary>Advanced</summary><pre>{JSON.stringify(bot.plugin.readout, null, 2)}</pre></details>
    {/if}
    {#if !bot.endedAt}<button type="button" onclick={() => stopRun(bot)} disabled={runBusy}>Stop run</button>{/if}
  </div>
{/snippet}

<style>
  .filters { display: flex; flex-wrap: wrap; align-items: end; gap: 0.75rem; margin-block: 0.75rem; }
  label { display: grid; gap: 0.25rem; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { padding: 0.5rem 0; }
  li span { display: block; }
</style>
