<!-- WC74 CivilianMissions.svelte @ 213da333; Start delegates to existing plugin executors. -->
<script lang="ts">
  import { onMount } from "svelte";
  import {
    authenticatedJson,
    farmerAccounts,
    farmerSignInMessage,
    ownerOptions,
    workspaceAccounts as knownAccounts,
  } from "../app/context.ts";
  import { civilianSession, civilianScope } from "../app/civilianSession.ts";
  import { whilePageVisible } from "../app/pageVisibility.ts";
  import {
    findAgents,
    openPageAccount,
    readCivilianParking,
    findMapLocations,
    findAccessibleStructures,
    type FoundAgent,
    type MapLocation,
    type OperationPilotChoice,
    type ServerBot,
    type ApiOptions,
  } from "../app/api.ts";
  import type { CivilianParkingPolicy } from "../nav/civilianParking.ts";
  import type { DockableKind } from "../nav/dockableLocation.ts";
  import {
    listCivilianProfiles,
    removeCivilianProfile,
    saveCivilianProfile,
    startCivilianRun,
  } from "../adapters/civilian.ts";
  import type { CivilianProfile } from "../../civilian/profile.ts";
  import OperationPilotPicker from "./OperationPilotPicker.svelte";
  import CivilianWorkers from "./CivilianWorkers.svelte";

  type Mode = "mining" | "distribution";
  type StopPolicy = "TIME" | "COUNT";
  type Workspace = NonNullable<Awaited<ReturnType<typeof openPageAccount>>>;
  let { operatorAccount }: { operatorAccount?: string } = $props();
  let mode = $state<Mode>("mining");
  let workspace = $state.raw<Workspace | null>(null);
  let restoring = $state(true),
    authGeneration = 0;
  let workspaceAccounts = $state<string[]>([]),
    workerAccounts = $state<string[]>([]);
  let profiles = $state.raw<CivilianProfile[]>([]),
    profilesLoaded = $state(false);
  let editorOpen = $state(false),
    editing = $state<number | null>(null),
    refreshKey = $state(0);
  let picked = $state<OperationPilotChoice | null>(null);
  let previousAgent = $state<CivilianProfile["agent"]>(null);
  let previousCorporation = $state<string | null>(null);
  let pickerOpen = $state(false),
    agents = $state<readonly FoundAgent[]>([]),
    agentsLoaded = $state(false);
  let agentID = $state(0),
    search = $state(""),
    corporation = $state(0),
    area = $state(0),
    areaSearch = $state("");
  let agentChoice = $state<"automatic" | "manual">("automatic");
  let level = $state(1),
    levelPolicy = $state<"exact" | "max">("exact");
  let maxJumps = $state(10),
    agentJumps = $state(10),
    missionLimit = $state(1),
    runtime = $state(120);
  let stopPolicy = $state<StopPolicy>("TIME");
  let parkingMode = $state<"SELECTED" | "NEAREST">("NEAREST");
  let parkingQuery = $state(""),
    parkingWarning = $state("");
  let parkingMatches = $state<readonly (MapLocation & { kind: DockableKind })[]>([]);
  let parkingSelection = $state<(MapLocation & { kind: DockableKind }) | null>(null);
  let maxRuntimeMinutes = $state<number | null>(null);
  let busy = $state(false),
    error = $state(""),
    notice = $state("");
  const watchedAccounts = $derived(
    workspace ? [workspace.account, ...profiles.map((profile) => profile.pilot.accountName)] : [],
  );
  const accounts = $derived([
    ...new Set([...watchedAccounts, ...workspaceAccounts, ...workerAccounts]),
  ]);
  const durationChoices = $derived(
    [30, 60, 120, 240, 720, 1440, 2880, 4320].filter(
      (value) => maxRuntimeMinutes !== null && value <= maxRuntimeMinutes,
    ),
  );
  const durationValid = $derived(
    maxRuntimeMinutes !== null && runtime >= 1 && runtime <= maxRuntimeMinutes,
  );
  const countValid = $derived(
    Number.isSafeInteger(missionLimit) && missionLimit >= 1 && missionLimit <= 500,
  );
  const jumpsValid = $derived(
    Number.isInteger(maxJumps) &&
      maxJumps >= 1 &&
      maxJumps <= 30 &&
      Number.isInteger(agentJumps) &&
      agentJumps >= 1 &&
      agentJumps <= 30,
  );
  const corporations = $derived(
    [
      ...new Map(
        agents
          .filter((a) => a.corporationID && a.corporationName)
          .map((a) => [a.corporationID!, a.corporationName!]),
      ).entries(),
    ].sort((a, b) => a[1].localeCompare(b[1])),
  );
  const areas = $derived(
    [
      ...new Map(
        agents
          .filter((a) => a.solarSystemID && a.solarSystemName)
          .map((a) => [a.solarSystemID!, a.solarSystemName!]),
      ).entries(),
    ].sort((a, b) => a[1].localeCompare(b[1])),
  );
  const areaMatches = $derived(
    areaSearch.trim().length >= 2 && !area
      ? areas
          .filter(([, name]) => name.toLowerCase().includes(areaSearch.trim().toLowerCase()))
          .slice(0, 15)
      : [],
  );
  const filtered = $derived(
    agents.filter(
      (a) =>
        a.level !== null &&
        (levelPolicy === "exact" ? a.level === level : a.level <= level) &&
        (!corporation || a.corporationID === corporation) &&
        (!area || a.solarSystemID === area) &&
        `${a.name} ${a.stationName ?? ""} ${a.solarSystemName ?? ""}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    ),
  );
  const chosen = $derived(
    filtered.find((agent) => agent.agentID === agentID) ??
      (previousAgent?.agentID === agentID ? previousAgent : null),
  );
  const automatic = $derived(agentChoice === "automatic");
  const canSave = $derived(
    !!picked &&
      !!maxRuntimeMinutes &&
      (parkingMode === "NEAREST" || !!parkingSelection) &&
      (stopPolicy === "COUNT" ? countValid : durationValid) &&
      (mode !== "distribution" || jumpsValid) &&
      (!automatic || (Number.isInteger(agentJumps) && agentJumps >= 1 && agentJumps <= 30)) &&
      (automatic || !!chosen),
  );

  let visible: AbortSignal | undefined;
  onMount(() =>
    whilePageVisible((signal) => {
      visible = signal;
      if (!workspace) void restore(++authGeneration);
      return () => {
        ++authGeneration;
      };
    }),
  );

  function connect(selected: Workspace, persistedWorkers: readonly string[]) {
    const scope = civilianScope(selected.account, civilianSession.load());
    workspace = selected;
    workspaceAccounts = farmerAccounts();
    const retained = new Set(
      [...scope.workers, ...persistedWorkers].map((name) => name.toLowerCase()),
    );
    workerAccounts = knownAccounts().filter((name) => retained.has(name.toLowerCase()));
    civilianSession.save({ control: scope.control, workers: workerAccounts });
  }

  async function restore(generation: number) {
    const signal = visible;
    try {
      const selected = await openPageAccount(
        operatorAccount,
        civilianSession.load()?.control,
        signal,
      );
      if (!selected || generation !== authGeneration) return;
      const options = { ...selected.options, signal };
      const [saved, policy] = await Promise.allSettled([
        listCivilianProfiles(options),
        readPolicy(options),
      ]);
      if (generation !== authGeneration) return;
      if (saved.status === "rejected") throw saved.reason;
      profiles = saved.value.profiles;
      profilesLoaded = true;
      connect(selected, saved.value.workerAccounts);
      if (policy.status === "rejected") throw policy.reason;
    } catch (cause) {
      if (generation === authGeneration)
        error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (generation === authGeneration) restoring = false;
    }
  }

  async function act(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function readPolicy(options: ApiOptions) {
    const result = await authenticatedJson("/api/bots", options);
    const maximum = result.hostedRunPolicy?.maxRuntimeMinutes;
    if (!Number.isSafeInteger(maximum) || !maximum || maximum < 1) {
      maxRuntimeMinutes = null;
      throw new Error("The server's operation time limit could not be verified.");
    }
    maxRuntimeMinutes = Math.min(maximum, 72 * 60);
    runtime = Math.min(runtime, maxRuntimeMinutes);
  }

  async function readAgents() {
    if (!workspace) return;
    agentsLoaded = false;
    agents = [];
    const answer = await findAgents(
      { kind: mode === "mining" ? "mining" : "courier", limit: 5000 },
      workspace.options,
    );
    agents = answer.agents.filter((agent) => agent.stationID !== null && agent.level !== null);
    agentsLoaded = true;
    if (answer.capped) notice = "The agent list is capped. Refine the available choices.";
  }

  function resetAgent() {
    agentID = 0;
    notice = "";
  }

  async function changeMode() {
    resetAgent();
    search = "";
    corporation = 0;
    area = 0;
    areaSearch = "";
    level = 1;
    levelPolicy = "exact";
    previousAgent = null;
    previousCorporation = null;
    agentChoice = "automatic";
    await readAgents();
  }

  async function searchParking() {
    const q = parkingQuery.trim(),
      pilot = picked;
    if (!pilot || !workspace || q.length < 2) return;
    const { options } = workspace;
    parkingWarning = "";
    const [stations, structures] = await Promise.all([
      findMapLocations(q, "station", options),
      findAccessibleStructures(
        q,
        options,
        pilot.characterID,
        pilot.accountName,
        "operations-center",
      ).catch(() => {
        parkingWarning = "Upwell search could not be verified for this pilot.";
        return [];
      }),
    ]);
    parkingMatches = [...stations.matches, ...structures].filter(
      (match): match is MapLocation & { kind: DockableKind } =>
        match.kind === "station" || match.kind === "structure",
    );
    if (!parkingMatches.length && !parkingWarning)
      parkingWarning = "No matching docking destinations.";
  }

  function openEditor(profile?: CivilianProfile) {
    editing = profile?.pilot.characterID ?? null;
    mode = profile?.mode ?? "mining";
    picked = profile?.pilot ?? null;
    pickerOpen = !profile;
    previousAgent = profile?.agent ?? null;
    previousCorporation = profile?.corporationName ?? null;
    agentID = previousAgent?.agentID ?? 0;
    agentChoice = profile?.automatic === false ? "manual" : "automatic";
    corporation = profile?.corporationID ?? 0;
    level = profile?.level ?? 1;
    levelPolicy = profile?.fallback ? "max" : "exact";
    maxJumps = profile?.maxJumps ?? 10;
    agentJumps = profile?.searchJumps ?? 10;
    runtime = profile?.runtime ?? Math.min(120, maxRuntimeMinutes ?? 120);
    missionLimit = profile?.limit || 1;
    stopPolicy = profile?.policy ?? "TIME";
    parkingMode = profile?.parking.mode ?? "NEAREST";
    parkingSelection = profile?.parking.mode === "SELECTED" ? profile.parking.destination : null;
    parkingQuery = parkingSelection?.name ?? "";
    parkingMatches = [];
    parkingWarning = "";
    search = "";
    areaSearch = "";
    area = 0;
    agents = [];
    agentsLoaded = false;
    error = "";
    notice = "";
    editorOpen = true;
  }

  async function saveProfile() {
    if (!picked || !canSave || !maxRuntimeMinutes || !workspace) return;
    const parking: CivilianParkingPolicy =
      parkingMode === "SELECTED" && parkingSelection
        ? await readCivilianParking(
            picked.accountName,
            picked.characterID,
            parkingSelection,
            workspace.options,
          )
        : { mode: "NEAREST" };
    const profile: CivilianProfile = {
      pilot: picked,
      agent: automatic ? null : chosen,
      mode,
      runtime: stopPolicy === "COUNT" ? maxRuntimeMinutes : runtime,
      maxJumps,
      searchJumps: agentJumps,
      limit: stopPolicy === "TIME" ? 0 : missionLimit,
      policy: stopPolicy,
      automatic,
      corporationID: corporation || null,
      corporationName:
        corporations.find(([id]) => id === corporation)?.[1] ??
        (corporation ? previousCorporation : null),
      level,
      fallback: levelPolicy === "max",
      parking,
    };
    profiles = await saveCivilianProfile(profile, workspace.options);
    editorOpen = false;
    notice = "Pilot profile saved.";
  }

  async function start(profile: CivilianProfile) {
    const options = await ownerOptions(profile.pilot.accountName);
    await startCivilianRun(profile, options);
    watchWorker(profile.pilot.accountName);
    ++refreshKey;
    notice = "Mission pilot started on the server.";
  }

  async function remove(profile: CivilianProfile) {
    if (!workspace) return;
    watchWorker(profile.pilot.accountName);
    profiles = await removeCivilianProfile(profile.pilot.characterID, workspace.options);
    if (editing === profile.pilot.characterID) editorOpen = false;
    notice = "Pilot profile removed.";
  }

  function watchWorker(account: string) {
    if (!workspace || workspace.account === account || workerAccounts.includes(account)) return;
    workerAccounts = [...workerAccounts, account];
    civilianSession.save({ control: workspace.account, workers: $state.snapshot(workerAccounts) });
  }

  function selectPilot(pilot: OperationPilotChoice) {
    const profile = profiles.find((row) => row.pilot.characterID === pilot.characterID);
    if (profile) {
      openEditor(profile);
      return;
    }
    watchWorker(pilot.accountName);
    picked = pilot;
    pickerOpen = false;
    parkingSelection = null;
    parkingMatches = [];
    parkingWarning = "";
  }

  function configureWorker(bot: ServerBot, account: string) {
    openEditor();
    mode = bot.plugin?.run === "civilian-distribution" ? "distribution" : "mining";
    selectPilot({
      characterID: bot.characterID,
      characterName: bot.characterName ?? account,
      accountName: account,
    });
  }

  function durationLabel(minutes: number) {
    return minutes < 60
      ? `${minutes} minutes`
      : `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  }
</script>

<section class="civilian center-panel">
  <div class="page-actions">
    <h2>Civilian Missions</h2>
    {#if workspace && profilesLoaded}
      <button type="button" class="primary" disabled={busy || editorOpen} onclick={() => openEditor()}>Add pilot</button>
    {/if}
  </div>
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if error}<p class="center-message" role="alert">{error}</p>{/if}
  {#if restoring}
    <p role="status">Checking account access…</p>
  {/if}
  {#if !workspace && !restoring}
    <p>{farmerSignInMessage}</p>
    <button type="button" onclick={() => { restoring = true; void restore(++authGeneration); }}>Refresh access</button>
  {/if}
  {#if workspace}
    <CivilianWorkers {profiles} {accounts} {watchedAccounts} {refreshKey} parentBusy={busy}
      onStart={profile => void act(() => start(profile))} onEdit={openEditor}
      onRemove={profile => void act(() => remove(profile))} onConfigure={configureWorker} />
  {/if}
  {#if workspace && editorOpen}
    <section class="profile-editor center-panel" aria-label="Mission profile editor">
    <h3>{editing ? `Edit ${picked?.characterName ?? "pilot"}` : "Add pilot"}</h3>
    <label>Mission type <select bind:value={mode} disabled={busy} onchange={() => void act(changeMode)}>
      <option value="mining">Mining Missions</option><option value="distribution">Delivery / Courier</option>
    </select></label>
    {#if editing === null}
      <button disabled={busy} onclick={() => pickerOpen = !pickerOpen}>{picked ? "Change pilot" : "Choose a pilot"}</button>
      {#if picked}<p>Selected pilot: <strong>{picked.characterName}</strong></p>{/if}
    {/if}
    {#if pickerOpen && editing === null}
      <OperationPilotPicker selectedID={picked?.characterID} disabled={busy}
        canChoose={() => true} onChoose={selectPilot} />
    {/if}

    <button disabled={busy} onclick={() => void act(readAgents)}>{agentsLoaded ? "Refresh agents" : "Find agents"}</button>
    <fieldset disabled={busy}>
      <legend>Agent and mission limits</legend>
      <div class="agent-filters">
        <label>Agent selection <select bind:value={agentChoice} onchange={resetAgent}>
          <option value="automatic">Automatically select an eligible agent</option>
          <option value="manual">Select a specific agent</option>
        </select></label>
        <label>NPC corporation <select bind:value={corporation} onchange={resetAgent}>
          <option value={0}>Any corporation</option>{#each corporations as [id, name]}<option value={id}>{name}</option>{/each}
          {#if corporation && !corporations.some(([id]) => id === corporation)}
            <option value={corporation}>{previousCorporation ?? `Corporation #${corporation}`}</option>
          {/if}
        </select></label>
        {#if !automatic}
          <div>
            <label>Agent system <input value={areaSearch} placeholder="Search a system or leave blank for any"
              oninput={event => { areaSearch = event.currentTarget.value; area = 0; resetAgent(); }} /></label>
            {#if area}<small>Selected: {areaSearch}</small>{/if}
            {#if areaMatches.length}
              <div class="system-matches">
                {#each areaMatches as [id, name]}<button type="button" onclick={() => { area = id; areaSearch = name; resetAgent(); }}>{name}</button>{/each}
              </div>
            {/if}
          </div>
          <label>Agent search <input bind:value={search} oninput={resetAgent} placeholder="Agent, station or system" /></label>
        {/if}
        <label>Level rule <select bind:value={levelPolicy} onchange={resetAgent}>
          <option value="exact">Exactly this level</option><option value="max">Up to this level</option>
        </select></label>
        <label>{levelPolicy === "max" ? "Maximum mission level" : "Mission level"} <select bind:value={level} onchange={resetAgent}>
          {#each [1, 2, 3, 4] as value}<option value={value}>Level {value}</option>{/each}
        </select></label>
        <label>Stop rule <select bind:value={stopPolicy}>
          <option value="TIME">After time</option><option value="COUNT">After completed missions</option>
        </select></label>
        {#if stopPolicy === "TIME"}
          <label>Time limit <select bind:value={runtime} disabled={!maxRuntimeMinutes}>
            {#each durationChoices as minutes}<option value={minutes}>{durationLabel(minutes)}</option>{/each}
            {#if maxRuntimeMinutes && !durationChoices.includes(runtime)}<option value={runtime}>{durationLabel(runtime)}</option>{/if}
          </select></label>
        {:else}
          <label>Completed missions <input type="number" min="1" max="500" step="1" bind:value={missionLimit} /></label>
        {/if}
        {#if mode === "distribution"}
          <label>Maximum delivery jumps <input type="number" min="1" max="30" step="1" bind:value={maxJumps} /></label>
        {/if}
        {#if automatic}
          <label>Maximum jumps to agent <input type="number" min="1" max="30" step="1" bind:value={agentJumps} /></label>
        {/if}
      </div>
      {#if mode === "mining"}
        <p class="scope">Supported ore and ice missions at levels 1–4 repeat after confirmed completion. Unavailable gas and special offers remain for review.</p>
      {:else}
        <p class="scope">The delivery jump limit filters each offer. The bot keeps an unsuitable offer for review. At the hard runtime limit it stops taking work and parks.</p>
      {/if}
      {#if maxRuntimeMinutes === null}<p class="scope">The server's operation time limit is unavailable.</p>
      {:else if stopPolicy === "COUNT"}<p class="scope">The server also applies its {durationLabel(maxRuntimeMinutes)} maximum runtime.</p>{/if}
      {#if !automatic}
        <label>Agent <select bind:value={agentID} disabled={!filtered.length && !chosen}>
          <option value={0}>Select an agent</option>
          {#if chosen && !filtered.some(agent => agent.agentID === chosen?.agentID)}
            <option value={chosen.agentID}>{chosen.name}</option>
          {/if}
          {#each filtered as agent (agent.agentID)}
            <option value={agent.agentID}>{agent.name} · {agent.stationName ?? agent.solarSystemName} · level {agent.level}</option>
          {/each}
        </select></label>
        {#if agentsLoaded && !filtered.length}<p>No agents match these filters.</p>{/if}
      {/if}
    </fieldset>
    <fieldset disabled={busy}>
      <legend>Parking</legend>
      <label>After Stop or the mission limit <select bind:value={parkingMode}>
        <option value="SELECTED">Return to selected station</option>
        <option value="NEAREST">Dock at nearest accessible station</option>
      </select></label>
      {#if parkingMode === "SELECTED"}
        <label>Destination <input bind:value={parkingQuery} placeholder="NPC station, local Upwell, or exact system name"
          oninput={() => { parkingSelection = null; parkingMatches = []; parkingWarning = ""; }} /></label>
        <button disabled={!picked || parkingQuery.trim().length < 2} onclick={() => void act(searchParking)}>Find destinations</button>
        {#if parkingWarning}<p role="status">{parkingWarning}</p>{/if}
        {#if parkingMatches.length && !parkingSelection}
          <div class="system-matches">
            {#each parkingMatches as match (match.id)}
              <button type="button" onclick={() => { parkingSelection = match; }}>
                {match.name} · {match.solarSystemName} · {match.kind === "structure" ? "Upwell" : "NPC station"}
              </button>
            {/each}
          </div>
        {/if}
        {#if parkingSelection}<p>Selected destination: <strong>{parkingSelection.name}</strong> · {parkingSelection.solarSystemName}</p>{/if}
      {:else}
        <p class="scope">The server chooses the destination from the pilot's location when the run ends.</p>
      {/if}
    </fieldset>
    <div class="page-actions">
      <button type="button" class="primary" disabled={busy || !canSave} onclick={() => void act(saveProfile)}>Save</button>
      <button type="button" disabled={busy} onclick={() => { editorOpen = false; error = ""; }}>Cancel</button>
    </div>
    </section>
  {/if}
</section>

<style>
  .civilian h2 {
    margin-top: 0;
  }
  .page-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .profile-editor {
    margin-top: 1rem;
  }
  p {
    line-height: 1.6;
  }
  label {
    display: block;
    margin: 0.75rem 0;
  }
  select,
  button,
  input {
    max-width: 100%;
  }
  select,
  input:not([type="radio"], [type="checkbox"]) {
    width: 100%;
  }
  button {
    margin: 0.25rem 0.35rem 0.25rem 0;
  }
  .agent-filters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1rem;
  }
  .scope {
    color: #a7bec9;
    font-size: 0.9rem;
    max-width: 85ch;
  }
  .system-matches {
    display: grid;
    max-height: 12rem;
    overflow: auto;
  }
  .system-matches button {
    margin: 0;
    text-align: left;
  }
</style>
