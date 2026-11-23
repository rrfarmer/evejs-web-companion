<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { farmerAccounts, farmerSignInMessage, savedWorkspacePilots } from "../app/context.ts";
  import { workspacePreference } from "../app/sessionToken.ts";
  import * as api from "../app/api.ts";
  import * as combat from "../adapters/combat.ts";
  import { combatMissionRewardSummary, type CombatRow, type CombatReview, type CombatDefinition } from "../app/combatOperations.ts";
  import { createControlPlanePoll } from "../app/controlPlanePoll.ts";
  import OperationPilotPicker from "./OperationPilotPicker.svelte";
  import CenterHeading from "./CenterHeading.svelte";
  import CenterStatus from "./CenterStatus.svelte";

  type CombatMode = CombatDefinition["mode"];
  const modeLabels: Record<CombatMode, string> = {
    BELT_PATROL: "Patrol asteroid belts",
    GATE_PATROL: "Patrol stargates",
    SECURITY_MISSION: "Security missions",
    COMBAT_ANOMALY: "Combat anomalies",
    DED_COMPLEX: "DED complexes",
  };
  let authenticated = $state(false), error = $state("");
  const preference = workspacePreference("uoc:restored:combat-workspace:v1");
  let access = $state.raw<api.ApiOptions | null>(null);
  const options = () => {
    if (!access) throw Error(farmerSignInMessage);
    return access;
  };
  let busy = $state(false), name = $state("Patrol"), mode = $state<CombatMode>("BELT_PATROL");
  let editingDefinition = $state<CombatDefinition | null>(null), preserveLegacyStop = $state(false);
  let missionOwner = $state(0), agentID = $state(0), resumeOperationID = $state("");
  let securityAgents = $state<readonly api.FoundAgent[]>([]);
  let securityCorporation = $state(0);
  let securityLevel = $state(1), securityLevelRule = $state<"EXACT"|"UP_TO">("EXACT");
  let stopRule = $state<"TIME"|"COUNT">("COUNT"), missionCount = $state(1), maxAgentJumps = $state<number | undefined>(undefined);
  let rewardPolicy = $state<"KEEP"|"SHARE">("KEEP");
  let securityParking = $state<"NEAREST"|"SELECTED">("NEAREST");
  let manualSecuritySystem = $state(false);
  const security = $derived(mode==="SECURITY_MISSION");
  const showSystem = $derived(!security || manualSecuritySystem);
  const showDock = $derived(!security || securityParking==="SELECTED");
  const securityCorporations = $derived([...new Map(securityAgents.filter(a => a.corporationID && a.corporationName)
    .map(a => [a.corporationID!, { id: a.corporationID!, name: a.corporationName! }])).values()]
    .sort((a,b) => a.name.localeCompare(b.name)));
  let siteID = $state(0), maxSites = $state(1), discoveryWaitMinutes = $state(2);
  let maxDifficulty = $state(1);
  let dungeonID = $state(0), dedChoices = $state<readonly api.PveDedChoice[]>([]);
  let systemID = $state(0), homeStationID = $state(0), durationMinutes = $state(10);
  let runtimePolicy = $state<import("../app/combatOperations.ts").HostedRunPolicy | null>(null);
  const durations = $derived(runtimePolicy ? [...new Set([5, 10, 15, 20, 30, 45, 60,
    ...(editingDefinition ? [editingDefinition.durationMinutes] : []),
    ...runtimePolicy.durationChoices, runtimePolicy.maxRuntimeMinutes])]
    .filter(value => Number.isSafeInteger(value) && value > 0 && value <= runtimePolicy!.maxRuntimeMinutes)
    .sort((left, right) => left - right) : []);
  const durationLabel = (minutes: number) => minutes < 60 ? `${minutes} minutes` : `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  const rewardNumber = new Intl.NumberFormat("en-US",{maximumFractionDigits:2});
  let systemName = $state(""), stationName = $state("");
  let homeKind = $state<"station"|"structure">("station");
  let accessPilots = $state<Awaited<ReturnType<typeof api.listDockableAccessPilots>>>([]);
  let accessPilotID = $state(0), structureLookupWarning = $state("");
  let systemMatches = $state<Array<{id:number;name:string}>>([]);
  let stationMatches = $state<api.MapLocation[]>([]);
  let systemQuerySerial = 0, stationQuerySerial = 0;
  let picked = $state<api.VerifiedOperationPilot | null>(null), fittingID = $state(0);
  let pickerOpen = $state(false), fits = $state<{id:number;name:string}[]>([]);
  let display = $state<Record<number, { pilot: string; fit: string }>>({});
  const loadedAccounts = new Set<string>();
  let mounted = true;
  let rows = $state<CombatRow[]>([]), review = $state<CombatReview | null>(null), approved = $state(false);
  let required = $state(true);
  let members = $state<CombatDefinition["members"]>([]);

  const eligibleLeaders = $derived(members.filter(m => m.required));
  const ownerID = $derived(members.length===1 ? eligibleLeaders[0]?.characterID??0 : missionOwner);
  const missing = $derived([
    ...(name.trim() ? [] : ["Enter an operation name"]),
    ...(members.length ? [] : ["Add at least one pilot"]),
    ...(eligibleLeaders.length ? [] : ["Include a required combat pilot"]),
    ...(showSystem && !(systemID>0) ? ["Select the operation system"] : []),
    ...(showDock && !(homeStationID>0) ? ["Select the return dock"] : []),
    ...(!runtimePolicy || (!security || stopRule==="TIME") && !durations.includes(durationMinutes) ? ["Select a hosted runtime limit"] : []),
    ...(security && !ownerID ? ["Select the mission owner"] : []),
    ...(security && stopRule==="COUNT" && !(Number.isSafeInteger(missionCount)&&missionCount>=1) ? ["Enter the number of missions"] : []),
    ...(mode === "DED_COMPLEX" ? ["DED execution is disabled by operator decision"] : []),
  ]);
  const poll = createControlPlanePoll({ read: () => combat.listCombatOperations(options()),
    received: r => {
      rows = r.operations; runtimePolicy = r.hostedRunPolicy; authenticated = true; void loadFleetNames(rows);
      if (review && rows.some(row=>row.definition.operationID===review?.definition.operationID && row.run && row.run.phase!=="STOPPED")) {
        review = null; approved = false;
      }
    },
    failed: (e, lost) => { error = friendlyError(e); if (lost) { authenticated = false; access = null; } },
  });
  onMount(() => { void act(() => connect()); });
  onDestroy(() => { mounted = false; poll.stop(); });

  async function loadFleetNames(operations: CombatRow[]) {
    const accounts = new Map<string, string>();
    for (const operation of operations) for (const member of operation.definition.members)
      accounts.set(member.accountName.toLowerCase(), member.accountName);
    for (const pilot of savedWorkspacePilots()) {
      if (!accounts.has(pilot.accountName.toLowerCase()) || display[pilot.characterID]?.pilot) continue;
      display = { ...display, [pilot.characterID]: { pilot: pilot.characterName, fit: display[pilot.characterID]?.fit ?? "" } };
    }
    const authorized = new Set(farmerAccounts().map(name => name.toLowerCase()));
    for (const [key, name] of accounts) {
      if (!authorized.has(key) || loadedAccounts.has(key)) continue;
      loadedAccounts.add(key);
      try {
        const pilots = await api.listVerifiedOperationPilots(name);
        if (!mounted) return;
        for (const pilot of pilots)
          display = { ...display, [pilot.characterID]: { pilot: pilot.characterName, fit: display[pilot.characterID]?.fit ?? "" } };
      } catch { /* An unavailable roster leaves the configured account name visible. */ }
    }
  }

  function friendlyError(cause: unknown): string {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message === "AUTH_REQUIRED") return "Choose a WC Account to open Combat Operations.";
    if (/non-JSON response|Unexpected token.*</i.test(message)) {
      return "The server returned a web page instead of pilot data. Check that this tab is connected to the same current WC backend you started, then reload. No operation was changed. Technical details: " + message;
    }
    return message;
  }
  async function act(fn: () => Promise<void>) {
    if (busy) return;
    busy = true; error = "";
    try { await fn(); } catch (e) { error = friendlyError(e); } finally { busy = false; }
  }
  async function connect() {
    const signed = await api.openDefaultFarmerAccount(preference.read());
    if (!signed || !mounted) return;
    access = signed.options; preference.remember(signed.account);
    accessPilotID = 0; accessPilots = [];
    authenticated = true; await poll.reconnect();
  }
  function canAddPilot(pilot: api.VerifiedOperationPilot) {
    return pilot.availability === "AVAILABLE" && !members.some(m => m.characterID === pilot.characterID ||
      m.accountName.toLowerCase() === pilot.accountName.toLowerCase());
  }
  async function choosePilot(pilot: api.VerifiedOperationPilot) {
    if (!canAddPilot(pilot)) return;
    picked = pilot; fits = []; fittingID = 0;
    try {
      const p = await api.getMiningPreparationOptions(pilot.accountName, pilot.characterID);
      fits = p.definitions.contracts.map(c => ({ id: c.definition.fittingID, name: c.name }));
    } catch { /* A pilot can be added even if its fitting library is unavailable. */ }
  }
  function addMember() {
    const chosen = picked, fit = fits.find(row => row.id === fittingID);
    if (!chosen || !canAddPilot(chosen) || members.length >= 8) return;
    const { accountName, characterID, characterName } = chosen;
    members = [...members, { accountName, characterID, role: "AUTO", required, preparation: fit ? { fittingID } : {} }];
    display = { ...display, [characterID]: { pilot: characterName, fit: fit?.name || "" } };
    const station=chosen.currentStation;
    if (!security && station && !systemID && !systemName.trim() && station.solarSystemName) {
      systemID=station.solarSystemID; systemName=station.solarSystemName;
    }
    if (!security && station && systemID===station.solarSystemID && !homeStationID && !stationName.trim()) {
      homeStationID=station.stationID;stationName=station.stationName;homeKind="station";
    }
    picked = null; fits = []; fittingID = 0; pickerOpen = false;
  }
  async function modeChanged() {
    review = null; missionOwner = 0;
    if (mode === "SECURITY_MISSION") await readSecurityAgents();
    if (mode === "DED_COMPLEX") { dedChoices = await api.readPveOptions(options()); dungeonID = dedChoices[0]?.dungeonID ?? 0; }
  }
  async function lookupSystem(value: string) {
    const serial = ++systemQuerySerial;
    systemName = value; systemID = 0; systemMatches = [];
    if (!security) { ++stationQuerySerial; homeStationID = 0; stationName = ""; stationMatches = []; }
    if (value.trim().length < 2) return;
    try {
      const data = await api.findMapLocations(value.trim(), "system", options());
      if (serial !== systemQuerySerial) return;
      systemMatches = data.matches.filter(m => m.kind === "system").map(m => ({id:m.id,name:m.name}));
    } catch (cause) { if (serial === systemQuerySerial) error = friendlyError(cause); }
  }
  async function lookupStation(value: string) {
    const serial = ++stationQuerySerial;
    const system = systemID, q = value.trim();
    stationName = value; homeStationID = 0; stationMatches = []; structureLookupWarning = "";
    if (!security && !system || q.length < 2) return;
    const stationLookup = api.findMapLocations(q, "station", options()).then(r=>r.matches);
    const structureLookup = (async()=>{
      if (!accessPilotID) {
        const pilots = await api.listDockableAccessPilots(options());
        if (serial !== stationQuerySerial) return [];
        accessPilots = pilots;
        accessPilotID = pilots[0]?.characterID ?? 0;
      }
      if (!accessPilotID) throw new Error("Use an account with a verified pilot to search accessible Upwell structures.");
      return api.findAccessibleStructures(q, options(), accessPilotID);
    })();
    try {
      const [stations,structures] = await Promise.allSettled([stationLookup,structureLookup]);
      if (serial !== stationQuerySerial) return;
      stationMatches = [
        ...(stations.status==="fulfilled"?stations.value:[]),
        ...(structures.status==="fulfilled"?structures.value:[]),
      ].filter(m=>m.kind!=="system"&&(security||m.solarSystemID===system));
      if (stations.status==="rejected") error=friendlyError(stations.reason);
      if (structures.status==="rejected") structureLookupWarning=friendlyError(structures.reason);
    } catch (cause) { if (serial === stationQuerySerial) error = friendlyError(cause); }
  }
  async function readSecurityAgents() {
    if(securityAgents.length)return;
    const pages=await Promise.all([1,2].map(level=>api.findAgents({kind:"encounter",level,limit:5000},options())));
    if(security)securityAgents=pages.flatMap(page=>page.agents).filter(agent=>agent.stationID!==null);
  }
  function chooseSystem(s: {id:number;name:string}) {
    ++systemQuerySerial; systemID=s.id; systemName=s.name; systemMatches=[];
  }
  function chooseStation(s: api.MapLocation) {
    if (s.kind==="system" || !security && s.solarSystemID!==systemID) return;
    ++stationQuerySerial; homeStationID=s.id; stationName=s.name; homeKind=s.kind; stationMatches=[];
  }
  function loadEditor(definition: CombatDefinition | null) {
    editingDefinition=definition;
    const objective=definition?.objective;
    name=definition?.name??"Patrol";mode=definition?.mode??"BELT_PATROL";
    members=definition?.members.map(m=>({...m,preparation:{...m.preparation}}))??[];
    durationMinutes=definition?.durationMinutes??10;
    systemID=definition?.systemID??0;systemName=definition?.systemName??"";
    homeStationID=definition?.homeStationID??0;stationName=definition?.homeStationName??"";
    homeKind=definition?.homeKind??"station";
    manualSecuritySystem=!!definition?.systemID;
    securityParking=definition?.homeStationID?"SELECTED":"NEAREST";
    missionOwner=objective?.ownerCharacterID??0;agentID=objective?.agentID??0;
    resumeOperationID=objective?.resume?.sourceOperationID??"";
    securityCorporation=objective?.corporationID??0;securityLevel=objective?.level??1;securityLevelRule=objective?.levelRule??"EXACT";
    stopRule=objective?.stopRule==="TIME"?"TIME":"COUNT";missionCount=objective?.missionCount??1;
    rewardPolicy=objective?.rewardPolicy??"KEEP";
    preserveLegacyStop=definition?.mode==="SECURITY_MISSION"&&(objective?.stopRule??"ONE_MISSION")==="ONE_MISSION";
    maxAgentJumps=objective?.maxJumps??undefined;
    siteID=objective?.siteID??0;maxSites=objective?.maxSites??1;discoveryWaitMinutes=objective?.discoveryWaitMinutes??2;
    maxDifficulty=objective?.maxDifficulty??1;dungeonID=objective?.dungeonID??0;
    ++systemQuerySerial;++stationQuerySerial;systemMatches=[];stationMatches=[];structureLookupWarning="";
    accessPilotID=0;accessPilots=[];
    picked=null;pickerOpen=false;fits=[];fittingID=0;required=true;review=null;approved=false;
  }
  async function editOperation(definition: CombatDefinition) {
    loadEditor(definition);
    if(security)await readSecurityAgents();
    if(mode==="DED_COMPLEX"&&!dedChoices.length)dedChoices=await api.readPveOptions(options());
  }
  async function save() {
    if (missing.length) throw new Error("Finish the highlighted setup steps before saving.");
    const original=editingDefinition;
    const sameStructure=original?.homeKind==="structure"&&homeKind==="structure"&&original.homeStationID===homeStationID;
    if(showDock&&homeKind==="structure"&&!sameStructure&&!accessPilotID){
      accessPilots=await api.listDockableAccessPilots(options());
      accessPilotID=accessPilots[0]?.characterID??0;
    }
    const parkingMode=original?.parking?.mode==="RETURN_HOME_DOCK"&&securityParking==="SELECTED"&&
      original.systemID===systemID&&original.homeStationID===homeStationID&&original.homeKind===(homeKind==="structure"?"structure":undefined)
      ? "RETURN_HOME_DOCK" : securityParking;
    const previousOwner=original?.objective?.ownerCharacterID;
    const siteOwner=eligibleLeaders.find(m=>m.characterID===previousOwner)?.characterID??eligibleLeaders[0].characterID;
    const d: CombatDefinition = { name: name.trim(), mode, systemID:showSystem?systemID:null, homeStationID:showDock?homeStationID:null, durationMinutes, members,
      ...(original?{operationID:original.operationID,revision:original.revision,observationSeconds:original.observationSeconds,preparation:original.preparation}:{}),
      ...(showDock&&homeKind==="structure"?{homeKind,...(!sameStructure?{parkingAccessPilotID:accessPilotID}:{})}:{}),
      ...(security ? {parking:{mode:parkingMode},objective: {ownerCharacterID:ownerID,agentID:agentID||null,
        level:securityLevel,levelRule:securityLevelRule,stopRule:preserveLegacyStop?"ONE_MISSION":stopRule,maxJumps:maxAgentJumps??null,rewardPolicy,
        ...(stopRule==="COUNT"?{missionCount}:{}),...(securityCorporation ? {corporationID:securityCorporation} : {}), loot: "NONE" as const,
        ...(resumeOperationID.trim() ? {resumeFromOperationID: resumeOperationID.trim()} : {}) }} :
        mode === "COMBAT_ANOMALY" || mode === "DED_COMPLEX" ? {objective: {ownerCharacterID:siteOwner,
          agentID: null, siteID: siteID || null, maxSites, discoveryWaitMinutes, loot: "NONE" as const,
          ...(mode === "DED_COMPLEX" ? {dungeonID} : {maxDifficulty}) }} : {}) };
    await combat.saveCombatOperation(d, options());
    if(original)loadEditor(null);
    await poll.refresh();
  }
  async function inspect(row: CombatRow) {
    try { review = await combat.reviewCombatOperation(row.definition.operationID!, options()); approved = false; }
    finally { await poll.refresh(); }
  }
  async function launch() {
    if (!review?.canStart || !approved) return;
    const r = review;
    if(r.fleetMoves?.length && !window.confirm(r.fleetMoves.map(m => {
      const member=r.definition.members.find(p=>p.characterID===m.characterID);
      return `Move ${display[m.characterID]?.pilot || member?.accountName || 'selected pilot'} from its current fleet into this operation?`;
    }).join("\n")))return;
    review = null; approved = false;
    try { await combat.startCombatOperation(r.definition.operationID!, r.reviewHash, {fleetMovesApproved:!!r.fleetMoves?.length}); }
    finally { await poll.refresh(); }
  }
  async function remove(row:CombatRow) {
    if (!window.confirm(`Remove “${row.definition.name}” from Combat Operations?`)) return;
    await combat.deleteCombatOperation(row.definition.operationID!, row.definition.revision!, options());
    await poll.refresh();
  }
</script>

<svelte:head><title>Combat Operations Center · EveJS</title></svelte:head>
<main class="uoc-center">
  <CenterHeading title="Combat Operations Center">
    {#snippet actions()}{#if authenticated && rows.length}<a href="#saved-operations">Saved operations ({rows.length})</a>{/if}{/snippet}
  </CenterHeading>
  {#if !authenticated}
    <section class="card login">
      <p>{farmerSignInMessage}</p>
      <button type="button" disabled={busy} onclick={() => void act(connect)}>Refresh access</button>
    </section>
  {:else}
    {#snippet operationEditor()}
    <section class="card">
      <div class="step-head"><span class="step">1</span><div><h2>What will the fleet do?</h2><p>Choose one operation type. All actions are reviewed before launch.</p></div></div>
      <div class="fields"><label>Operation name<input bind:value={name} placeholder="e.g. Evening patrol"/></label>
        <label>Task<select bind:value={mode} onchange={() => void act(modeChanged)}>{#each Object.entries(modeLabels) as [value,label]}<option {value} disabled={value==="DED_COMPLEX"}>{label}{value==="DED_COMPLEX"?" (disabled)":""}</option>{/each}</select></label>
        {#if security}<label>Stop rule<select bind:value={stopRule} onchange={()=>{preserveLegacyStop=false;}}><option value="COUNT">After completed missions</option><option value="TIME">After elapsed time</option></select></label>{/if}
        {#if security}<label>Fleet mission rewards<select bind:value={rewardPolicy}><option value="KEEP">Keep for the mission owner</option><option value="SHARE">Share with eligible fleet members</option></select></label>{/if}
        {#if security && stopRule==="COUNT"}<label>Completed missions<input type="number" min="1" step="1" bind:value={missionCount} oninput={()=>{preserveLegacyStop=false;}}/></label>
        {:else}<label>Maximum runtime<select bind:value={durationMinutes} disabled={!durations.length}>{#each durations as minutes}{#if !security || minutes<=4320}<option value={minutes}>{durationLabel(minutes)}</option>{/if}{/each}</select></label>{/if}</div>
    </section>
    <section class="card">
      <div class="step-head"><span class="step">2</span><div><h2>Who is going?</h2><p>Add up to eight pilots. Choose one pilot per account.</p></div></div>
      {#if members.length}
        <div class="roster">{#each members as m (m.characterID)}
          <div class="roster-row"><div><strong>{display[m.characterID]?.pilot || m.accountName}</strong><small>{m.accountName} · {display[m.characterID]?.fit || "Fitting checked at review"}</small></div>
            <button type="button" disabled={busy} onclick={() => { members=members.filter(x=>x.characterID!==m.characterID); if(missionOwner===m.characterID) missionOwner=0; }}>Remove</button></div>
        {/each}</div>
      {:else}<p class="empty">No pilots yet. Use “Add a pilot” below.</p>{/if}
      {#if members.length < 8}
        <button type="button" class="primary" onclick={() => { pickerOpen = !pickerOpen; if (!pickerOpen) picked = null; }}>
          {pickerOpen ? "Close pilot picker" : "+ Add a pilot"}
        </button>
        {#if pickerOpen}
          <div class="add-pilot">
            <OperationPilotPicker onChoose={p => void act(() => choosePilot(p))} canChoose={canAddPilot} disabled={busy}
              selectedID={picked?.characterID} />
            {#if picked}
              <p>Prepare {picked.characterName} for this fleet.</p>
              <div class="fields">
                <label>Saved fitting (optional)<select bind:value={fittingID}><option value={0}>Find a matching fitting during preparation</option>{#each fits as f}<option value={f.id}>{f.name}</option>{/each}</select></label>
              </div>
              <label class="inline"><input type="checkbox" bind:checked={required}/> Required for fleet readiness</label>
              {#if !busy && !fits.length}<p class="hint">No saved fitting was found. You can add this pilot, then review readiness before launch.</p>{/if}
              <button type="button" class="primary" disabled={busy} onclick={addMember}>Add {picked.characterName} to fleet</button>
            {/if}
          </div>
        {/if}
      {/if}
    </section>
    <section class="card">
      <div class="step-head"><span class="step">3</span><div><h2>Where should they go and return?</h2><p>Search by name. Numeric IDs are available only under advanced details.</p></div></div>
      <div class="fields">
        {#if security}<label>Mission location<select bind:value={manualSecuritySystem}><option value={false}>Find an eligible agent automatically</option><option value={true}>Choose a system</option></select></label>{/if}
        {#if showSystem}
        <div><label>Operation system<input value={systemName} oninput={e => void lookupSystem(e.currentTarget.value)} placeholder="Search a solar system" autocomplete="off"/></label>
          {#if systemMatches.length}<div class="suggestions">{#each systemMatches as s}<button type="button" onclick={() => chooseSystem(s)}>{s.name}</button>{/each}</div>{/if}
          {#if systemID}<small>Selected: {systemName}</small>{/if}</div>
        {/if}
        {#if security}<label>Parking<select bind:value={securityParking}><option value="NEAREST">Dock at nearest accessible station</option><option value="SELECTED">Return to selected station or Upwell</option></select></label>{/if}
        {#if showDock}
        <div><label>Return dock<input value={stationName} oninput={e => void lookupStation(e.currentTarget.value)} placeholder="Search NPC stations or accessible Upwell structures" autocomplete="off" disabled={!security&&!systemID}/></label>
          {#if accessPilots.length>1}<label>Check Upwell access as<select bind:value={accessPilotID} onchange={()=>void lookupStation(stationName)}>
            {#each accessPilots as p}<option value={p.characterID}>{p.characterName}</option>{/each}
          </select></label>{/if}
          {#if structureLookupWarning}<small class="warning">{structureLookupWarning}</small>{/if}
          {#if stationMatches.length}<div class="suggestions">{#each stationMatches as s}<button type="button" onclick={() => chooseStation(s)}>{s.name} · {s.kind==="structure"?"Upwell structure":"NPC station"}</button>{/each}</div>{/if}
          {#if homeStationID}<small>Selected: {stationName} · {homeKind==="structure"?"Upwell structure":"NPC station"}</small>{/if}</div>
        {/if}
      </div>
      {#if security}
        <div class="fields">
          {#if members.length>1}<label>Mission owner<select bind:value={missionOwner}><option value={0}>Choose a fleet pilot</option>{#each eligibleLeaders as m}<option value={m.characterID}>{display[m.characterID]?.pilot ?? m.accountName}</option>{/each}</select></label>{/if}
          <label>Level rule<select bind:value={securityLevelRule}><option value="EXACT">Exactly this level</option><option value="UP_TO">Up to this level</option></select></label>
          <label>Mission level<select bind:value={securityLevel}><option value={1}>Level 1</option><option value={2}>Level 2</option></select></label>
          <label>NPC corporation<select bind:value={securityCorporation} onchange={() => { agentID = 0; }}>
            <option value={0}>Any eligible corporation</option>
            {#each securityCorporations as corporation (corporation.id)}<option value={corporation.id}>{corporation.name}</option>{/each}
          </select></label>
          <label>Maximum jumps to agent (optional)<input type="number" min="0" max="100" bind:value={maxAgentJumps}/></label>
        </div>
        <details><summary>Advanced agent override and resume</summary>
          <label>Exact agent ID (optional)<input type="number" min="0" bind:value={agentID}/></label>
          <label>Resume operation ID<input bind:value={resumeOperationID}/></label>
          {#if resumeOperationID.trim() && !agentID}<p>Select the exact agent of the stopped mission to resume.</p>{/if}
        </details>
        <p class="hint">Supports selected combat-only offers. Level 2 supports The Seven’s Brothel on this server.</p>
      {:else if mode==='COMBAT_ANOMALY'||mode==='DED_COMPLEX'}
        <div class="fields"><label>Maximum sites<input type="number" min="1" max="20" bind:value={maxSites}/></label></div>
        <details><summary>Advanced site timing</summary><label>Site discovery wait (minutes)<input type="number" min="1" max="10" bind:value={discoveryWaitMinutes}/></label></details>
        {#if mode==='DED_COMPLEX'}
          <p class="warning" role="alert">DED execution is disabled by operator decision.</p>
          <label>DED complex<select bind:value={dungeonID}>{#each dedChoices as c}<option value={c.dungeonID}>{c.name} · {c.rating}/10</option>{/each}</select></label>
        {:else}
          <label>Maximum anomaly difficulty<select bind:value={maxDifficulty}>
            <option value={1}>1 · Hideaway / Drone Cluster and similar</option>
            <option value={2}>2 · Includes Refuge / Drone Assembly</option>
            <option value={3}>3 · Includes Rally Point / Drone Surveillance</option>
            <option value={4}>4 · Includes Hub / Drone Squad</option>
            <option value={5}>5 · Includes Haven, Sanctum and Drone Horde</option>
          </select></label>
          <p class="hint">After undocking, the fleet checks the local scanner and reserves a matching site. Sites above the selected difficulty and sites without a known rating are skipped.</p>
          <p class="hint">Angel Hideaway and Drone Cluster examples contain frigate waves. Forsaken Sanctum and Drone Patrol can include battleships alongside smaller ships. Check your fleet’s tank and ability to hit small targets.</p>
        {/if}
        <details><summary>Optional exact scanner site</summary><label>Site ID<input type="number" min="0" bind:value={siteID}/></label></details>
      {/if}
      <details class="advanced"><summary>Advanced IDs · only if you know the exact location</summary>
        <div class="fields">{#if showSystem}<label>System ID<input type="number" min="1" value={systemID||''} oninput={e => {systemID=Number(e.currentTarget.value)||0;systemName='';}}/></label>{/if}
          {#if showDock}<label>Return NPC station ID<input type="number" min="1" value={homeKind==="station"?homeStationID||'':''} oninput={e=>{++stationQuerySerial;homeKind="station";homeStationID=Number(e.currentTarget.value)||0;stationName='';stationMatches=[];}}/></label>{/if}</div>
        <p class="hint">Use exact IDs only after verifying the location. The operation still checks actual readiness and navigation.</p>
      </details>
    </section>
    <section class="card">
      <div class="step-head"><span class="step">4</span><div><h2>Check and save</h2><p>No ship is launched until you review and explicitly start the saved operation.</p></div></div>
      {#if missing.length}<div class="warning"><strong>Before you can save:</strong><ul>{#each missing as m}<li>{m}</li>{/each}</ul></div>
      {:else}<p class="success">Ready to save the operation. Starting it requires a separate review.</p>{/if}
      <div class="buttons"><button type="button" class="primary" disabled={busy||missing.length>0} onclick={()=>void act(save)}>{editingDefinition?"Save changes":"Save operation"}</button>
        {#if editingDefinition}<button type="button" disabled={busy} onclick={()=>loadEditor(null)}>Cancel</button>{/if}</div>
    </section>
    {/snippet}
    {#if !editingDefinition}{@render operationEditor()}{/if}
    <h2 id="saved-operations">Saved operations</h2>
    {#if !rows.length}<p>No combat operations saved in this workspace.</p>{/if}
    {#each rows as row (row.definition.operationID)}
      {@const recovery = row.run?.recoveryReceipt}
      {@const reward = row.definition.mode==="SECURITY_MISSION"?combatMissionRewardSummary(row.run):null}
      {@const retainedKey = row.run?.objective?.identity?.acceptedKey ?? row.run?.securityResume?.identity.acceptedKey}
      {@const resumeMission = row.definition.mode==="SECURITY_MISSION" && row.run?.phase==="STOPPED" &&
        !!retainedKey && row.run.objective?.stage!=="COMPLETED" &&
        !(row.run.objective?.completed ?? row.run.securityResume?.completed)?.some(m=>m.identity?.acceptedKey===retainedKey)}
      <section class="card operation"><div class="center-actions"><h2>{row.definition.name}</h2>
        <CenterStatus state={row.run?.phase ?? "Not started"} /></div><p>{modeLabels[row.definition.mode]}</p>
        {#if row.run?.objective}{@const o=row.run.objective}
          {#if row.definition.mode==="SECURITY_MISSION"}
            <p>{o.agentName??"Security agent"} · {o.completed?.length??(o.stage==="COMPLETED"?1:0)}{#if row.definition.objective?.stopRule==="COUNT"} / {row.definition.objective.missionCount}{/if} confirmed completed</p>
            <details><summary>Advanced mission status</summary><p>{o.stage} · room {o.identity?.roomID??'pending'} · instance {o.identity?.instanceID??'pending'}</p></details>
          {:else}<p>Objective: {o.stage} · room {o.identity?.roomID??'pending'} · instance {o.identity?.instanceID??'pending'}</p>{/if}
          {#if o.identity?.name}<p>{o.identity.name} · Authored difficulty {o.identity.difficulty}{#if o.identity.npcHulls?.length} · Planned NPC hulls: {o.identity.npcHulls.join(', ')}{/if}</p>{/if}
          {#if o.reward && row.definition.mode!=="SECURITY_MISSION"}<p>Verified reward: {o.reward.iskDelta} ISK · {o.reward.lpDelta} LP</p>{/if}{/if}
        {#if row.run?.waypoint}<p>Current waypoint: {row.run.waypoint.name} · native location {row.run.waypoint.itemID}.</p>{/if}
        {#if row.run?.primaryID}<p>Native shared target: {row.run.primaryID}.</p>{/if}
        {#if row.run && row.definition.mode==="SECURITY_MISSION"}
          <p><strong>{row.run.phase==="STOPPED"?"Last run mission rewards":"Mission rewards this run"}</strong>
            {#if reward} · {reward.isk===null?"unknown":rewardNumber.format(reward.isk)} ISK to pilot · {reward.lp===null?"unknown":rewardNumber.format(reward.lp)} observed pilot LP change
              {#if reward.taxISK===null} · Corporation tax unknown{:else if reward.taxISK>0} · {rewardNumber.format(reward.taxISK)} ISK corporation tax{/if}
              {#if reward.corporationLp!==null} · {rewardNumber.format(reward.corporationLp)} observed corporation LP change{/if}
            {:else} · No verified payout yet{/if}</p>
        {/if}
        {#if row.securityRunHistory?.length}
          <details><summary>Security run history ({row.securityRunHistory.length})</summary>
            <ul>{#each [...row.securityRunHistory].reverse() as prior (prior.runID)}
              <li>{prior.stoppedAt ? new Date(prior.stoppedAt).toLocaleString() : "Previous run"} · {prior.completed?.length??0} confirmed completed{#if prior.reason} · {prior.reason}{/if}</li>
            {/each}</ul>
          </details>
        {/if}
        {#if row.operationHistory?.length}<details><summary>Operation history ({row.operationHistory.length})</summary><ul>{#each row.operationHistory as prior}<li>{modeLabels[row.definition.mode]}{#if prior.completedCount!==null} · {prior.completedCount} native-confirmed sites{/if}{#if prior.reason} · {prior.reason}{/if}</li>{/each}</ul></details>{/if}
        {#if row.run?.phase==="FORMING"}<p role="status">Verifying the fleet’s hosted sessions and ships. Prepared pilots are still waiting for the fleet check.</p>{/if}
        {#if row.run?.reason}<p class="warning" role="status">{row.run.reason}</p>{/if}
        {#if row.run?.stopReason}<p>{row.run.stopReason}</p>{/if}
        {#if row.run?.holdReason}<p class="warning" role="alert">{row.run.holdReason}</p>{/if}
        {#if row.run?.objective?.waitingReason}<p role="status">{row.run.objective.waitingReason}</p>{/if}
        <details open={row.run?.phase==="PREPARATION_BLOCKED"||row.run?.phase==="PARKING"}><summary>Fleet status · {row.definition.members.length} pilots</summary><ul>
          {#each row.definition.members as m}{@const live = row.run?.members.find(n=>n.characterID===m.characterID)}<li>{display[m.characterID]?.pilot || m.accountName}{#if row.run?.anchor?.characterID === m.characterID} · Fleet Anchor{/if}{#if live?.fittingName} · {live.fittingName}{/if} · {m.required!==false?'Required':'Optional'} · {live?.state??'Not acquired'}{#if live?.parkingDestination} · {live.parkingDestination.name}{/if}{#if live?.reason} · {live.reason}{/if}{#if live?.observationError && row.run?.phase!=="STOPPED"} · Native observation temporarily unavailable{/if}</li>{/each}
        </ul></details>
        {#each row.run?.failures??[] as f}<p class="warning" role="alert">{f.code}: {f.reason??'Reconciliation required'}</p>{/each}
        {#if recovery}
          <p>{recovery.reason ?? (recovery.verified ? "Release and custody verified." : "Pilot custody remains held.")}</p>
          {#each recovery.members as m}<p>{display[m.characterID]?.pilot ?? row.definition.members.find(p=>p.characterID===m.characterID)?.accountName} · {m.reason}</p>{/each}
        {/if}
        {#if resumeMission}<p>The accepted mission stays with its owner. Review to continue it.</p>{/if}
        {#if editingDefinition?.operationID===row.definition.operationID && editingDefinition}
          <h3>Edit operation</h3>
          {@render operationEditor()}
        {:else}
        <div class="buttons"><button disabled={busy||!!row.run&&!["STOPPED","RECOVERY_REQUIRED","PARKING_FAILED"].includes(row.run.phase)} onclick={()=>void act(()=>inspect(row))}>{row.run?.securityContinue?"Review continuation":resumeMission?"Review resume":"Review start"}</button>
          <button disabled={busy||!row.run||row.run.phase==='STOPPED'} onclick={()=>void act(async()=>{await combat.stopCombatOperation(row.definition.operationID!,options());await poll.refresh();})}>Stop & return pilots</button>
          <button disabled={busy||!!editingDefinition||!!row.run&&(row.run.phase!=="STOPPED"||row.run.recoveryRequired)} onclick={()=>void act(()=>editOperation(row.definition))}>Edit</button>
          {#if !row.run || row.run.phase==="STOPPED" && !row.run.recoveryRequired && row.run.members.length && row.run.members.every(m=>m.state==="RELEASED") &&
              !row.run.objective?.commands?.some(c=>["DISPATCHED","UNKNOWN_HELD"].includes(c.status)) &&
              !resumeMission}
            <button disabled={busy} onclick={()=>void act(()=>remove(row))}>Delete operation</button>
          {/if}
        </div>
        {/if}
      </section>
    {/each}
    {#if review}<section class="card"><h2>Review: {review.definition.name}</h2>
      <p>Autonomous combat for up to {durationLabel(review.definition.durationMinutes)}.</p>
      {#if review.resume}<p>Continue the previously accepted mission with the same owner. Completed missions from the previous run count toward this operation.</p>{/if}
      {#if review.continuation}<p>The previous mission is confirmed. Continue with {review.continuation.remaining} remaining.</p>{/if}
      {#if review.definition.mode==="SECURITY_MISSION"}
        <p>Fleet mission rewards: {review.definition.objective?.rewardPolicy==="SHARE"?"Share with eligible fleet members":"Keep for the mission owner"}.</p>
        <p>{review.definition.objective?.levelRule==="UP_TO"?"Up to":"Exactly"} level {review.definition.objective?.level??1}
          · {review.definition.objective?.stopRule==="COUNT" ? `Stop after ${review.definition.objective.missionCount} completed missions` : review.definition.objective?.stopRule==="TIME" ? "Stop after elapsed time" : "Stop after one completed mission"}.</p>
        <p>{review.definition.systemID?"Use the selected mission system.":"Find a reachable agent automatically."}
          {review.definition.parking?.mode==="NEAREST"?"Dock at the nearest accessible station when the operation ends.":""}</p>
      {/if}
      {#if review.definition.homeStationName}<p>Return dock: {review.definition.homeStationName}.</p>{/if}
      {#if review.definition.objective?.maxDifficulty}<p>Consider known combat anomalies up to difficulty {review.definition.objective.maxDifficulty}.</p>{/if}
      {#if review.staging}<p>Fleet staging: {review.staging.name}.</p>{/if}
      {#if review.canStart}<p>The fleet stays docked while COC verifies its ships, fittings and hosted control.</p>
      {:else}<p class="warning" role="alert">Resolve the required pilot blockers, then review again.</p>{/if}
      {#if review.timePolicy}<details><summary>Advanced runtime</summary><p>Requested work: {durationLabel(review.timePolicy.requestedMinutes)} · Hosted limit: {durationLabel(review.timePolicy.grantMinutes)} · Wind-down starts by {durationLabel(review.timePolicy.workBoundaryMinutes)} · Cleanup reserve: {review.timePolicy.cleanupReserveMinutes} minutes.</p></details>{/if}
      {#each review.blockers ?? [] as blocker}<p class="warning" role="alert">{blocker}</p>{/each}
      {#each review.preparation.members as m}<p>{display[m.characterID]?.pilot || review.definition.members.find(member => member.characterID === m.characterID)?.accountName || 'Pilot'} · {m.fittingName??'Fitting not verified'} — {m.state}. {m.reason??''}</p>{/each}
      {#if review.canStart}
        <label class="inline"><input type="checkbox" bind:checked={approved}/> I approve this fleet, combat risk and duration.</label>
        <button class="primary" disabled={busy||!approved} onclick={()=>void act(launch)}>{review.resume?"Resume mission":review.continuation?"Continue operation":"Prepare and start"}</button>
      {/if}
    </section>{/if}
  {/if}
  {#if error}<p class="center-message" role="alert">{error}</p>{/if}
</main>
<style>
  .card{margin:1rem 0;padding:1rem;background:var(--center-panel);border:1px solid var(--center-border);border-radius:.7rem}
  .card h2{font-size:1.1rem;margin:.1rem 0}.step-head{display:flex;gap:.8rem;align-items:flex-start;margin-bottom:1rem}.step-head p,.hint{margin:.3rem 0;color:#9bb1bf;font-size:.88rem}
  .step{display:grid;place-items:center;background:#06516a;color:#d7f8ff;border-radius:50%;min-width:2rem;height:2rem;font-weight:700}
  .fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:.85rem;margin:.7rem 0 1rem}
  label{display:flex;flex-direction:column;gap:.35rem;font-size:.94rem}
  input,select{width:100%;min-width:0}
  .inline{flex-direction:row;align-items:center}.inline input{width:auto}
  .roster{display:grid;gap:.55rem}.roster-row{display:flex;justify-content:space-between;gap:1rem;align-items:center;padding:.65rem .8rem;background:#0b171d;border:1px solid #2d4654;border-radius:5px}.roster-row small{display:block;color:#9cb4c2}
  details{margin:.75rem 0;padding:.5rem .75rem;border:1px solid #2d4755;border-radius:5px}summary{cursor:pointer;color:#83d4ec;font-weight:650}details[open]>summary{margin-bottom:.85rem}
  .empty{color:#a6b8c2;padding:.65rem;background:#0b171d}.warning{background:#32241b;border:1px solid #986c40;color:#ffd5a6;border-radius:5px;padding:.8rem}.warning ul{margin:.5rem 0 0}.success{color:#9fe5c1}.suggestions{display:grid;gap:.25rem;max-height:13rem;overflow:auto}.suggestions button{text-align:left}
  .buttons{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1rem}.operation{border-color:#427e93}
  @media(max-width:600px){.roster-row{align-items:flex-start;flex-direction:column}}
</style>
