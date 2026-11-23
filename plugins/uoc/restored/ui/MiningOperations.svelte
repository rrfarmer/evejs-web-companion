<!-- WC74 web/src/ui/MiningOperations.svelte @ 213da333; imports adapted for UOC plugin. -->
<script lang="ts">
  import { onMount, onDestroy, tick, untrack } from "svelte";
  import { createControlPlanePoll } from "../mining/controlPlanePoll.ts";
  import type {StopFreightMode} from "../../miningFleet/operation.ts";
  import { hostedDurationLabel } from "../mining/hostedRunPolicy.ts";
  import OperationPilotPicker from "./OperationPilotPicker.svelte";
  import MiningOperationOverview from "./MiningOperationOverview.svelte";
  import CenterStatus from "./CenterStatus.svelte";
  import MiningOperationRun from "./MiningOperationRun.svelte";
  import MiningOreFreight from './MiningOreFreight.svelte';
  import MiningPreparation from "./MiningPreparation.svelte";
  import { recoverMiningOperation } from "../adapters/miningRecovery.ts";
  import { miningPreparationDraft, miningPreparationConfig, type MiningPreparationOptions } from "../mining/miningPreparation.ts";
  import { memberCorporationID, miningUnloadPolicy, resolveFleetCorporation, sharedPlayerCorporation } from "../mining/miningSetup.ts";
  import {
    createRestoredMiningHost,
    requestMiningStop,
    deleteMiningOperation,
    extendMiningOperation,
    listMiningResources,
    type MiningResourceChoice,
    findMapLocations,
    findAccessibleStructures,
    getMiningOperationLaunchPlan,
    getMiningPreparationOptions,
    inspectMiningOffice,
    listVerifiedOperationPilots,
    type VerifiedOperationPilot,
    loadMiningOperations,
    markMiningBeltSafe,
    resetDepletedMiningBelt,
    resolveDestination,
    resolveAccessibleStructure,
    saveMiningOperation,
    relocateMiningOperation,
    type OperationPilotChoice,
    type MiningOperationDefinition,
    type MiningOperationMemberDefinition,
    type MiningOperationsPayload,
    type MiningOperationLaunchPlan,
    type ReviewedFleet,
  } from "../adapters/mining.ts";
  import { loadHangarPrefs } from "../../../../web/src/plugin-api/index.ts";
  import { loadKnownCharacters } from "../../../../web/src/plugin-api/index.ts";
  import type { ApiOptions } from "../app/context.ts";
  let { accountName, access, onAuthExpired = () => {}, onBusyChange = () => {} }: {
    accountName: string; access: ApiOptions; onAuthExpired?: () => void; onBusyChange?: (busy: boolean) => void;
  } = $props();
  // Each mounted workspace keeps the same owner while an action is in flight.
  const options = untrack(() => access);
  const opts = () => options;
  let disconnected = $state(false);
  let catalog = $state<readonly MiningResourceChoice[]>([]);
  let resourceMode = $state<"ANY_ELIGIBLE" | "PREFER_LIST">("ANY_ELIGIBLE");
  let resourceIDs = $state<number[]>([]);
  let resourceQuery = $state("");
  let extensionResults = $state<Record<string, string>>({});
  let stopResults = $state<Record<string, string>>({});
  let stopDetails = $state<Record<string, string[]>>({});
  let payload = $state<MiningOperationsPayload | null>(null);
  let selectedOperationID = $state<string | null>(null);
  const savedOperations = $derived(payload?.operations ?? []);
  const canStart = (state: string) => state === "DRAFT" || state === "STOPPED";
  const selectedOperation = $derived(savedOperations.find(row => row.definition.operationID === selectedOperationID) ??
    savedOperations.find(row => !canStart(row.runtime.state)) ?? savedOperations[0]);
  const stateLabels: Record<string, string> = { DRAFT: "Draft", ACTIVE: "Active", WAITING_FOR_HOST: "Waiting for Bot Host",
    ASSEMBLING: "Assembling", STOPPING: "Stopping", PARKING: "Returning home", PARKING_FAILED: "Needs attention",
    STOPPED: "Stopped", UNKNOWN: "Needs attention" };
  const stateLabel = (state: string) => stateLabels[state] ?? state.replaceAll("_", " ");
  const runPolicy = $derived(payload?.capabilities.hostedRunPolicy ?? null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let pollError = $state<string | null>(null);
  let busy = $state<string | null>(null);
  $effect(() => onBusyChange(busy !== null));
  let launching = $state<string | null>(null), cancelStartup = $state(false);
  let choosingStop = $state<string | null>(null);
  const stopLabel = (mode:StopFreightMode) => mode==="RETURN_HOME" ? "Return home now" : "Collect remaining freight, then return";
  let startupAbort: AbortController | null = null;
  let editing = $state(false);
  const editorID = $props.id();
  const editorTabs = [
    { id: "basic", label: "Basics" },
    { id: "fleet", label: "Fleet" },
    { id: "logistics", label: "Logistics" },
    { id: "advanced", label: "Advanced" },
  ] as const;
  type EditorTab = (typeof editorTabs)[number]["id"];
  let editorTab = $state<EditorTab>("basic");
  let editor: HTMLFormElement | undefined = $state();
  let editorContent: HTMLDivElement | undefined = $state();
  let expandedFitting = $state<number | null>(null);
  let fleetDetails: HTMLDetailsElement | undefined = $state();
  async function revealEditor(): Promise<void> {
    await tick();
    editor?.scrollIntoView({ block: "start", behavior: "smooth" });
    editor?.querySelector<HTMLInputElement>('input[name="operationName"]')?.focus({ preventScroll: true });
  }
  function showEditorTab(tab: EditorTab): void {
    if (editorTab === tab) return;
    editorTab = tab;
    if (editorContent) editorContent.scrollTop = 0;
  }
  function editorTabKey(event: KeyboardEvent, index: number): void {
    const last = editorTabs.length - 1;
    const next = event.key === "ArrowRight" ? (index + 1) % editorTabs.length :
      event.key === "ArrowLeft" ? (index + last) % editorTabs.length :
      event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (next === null) return;
    event.preventDefault();
    const tab = editorTabs[next]!.id;
    showEditorTab(tab);
    editor?.querySelector<HTMLButtonElement>(`[role="tab"][aria-controls="${editorID}-${tab}"]`)?.focus();
  }
  async function submitEditor(): Promise<void> {
    if (!editor || busy || disconnected) return;
    // A required or out-of-range field can be on another tab or inside a disclosure.
    const invalid = editor.querySelector<HTMLInputElement | HTMLSelectElement>("input:invalid, select:invalid");
    if (invalid) {
      const tab = editorTabs.find(tab => tab.id === invalid.closest<HTMLElement>("[data-editor-tab]")?.dataset.editorTab);
      if (tab) showEditorTab(tab.id);
      for (let details = invalid.closest("details"); details; details = details.parentElement?.closest("details") ?? null) {
        details.open = true;
      }
      await tick();
      invalid.reportValidity();
      return;
    }
    await save();
  }
  let runtimeMinutes = $state(12 * 60);
  const nativeReviews = new Map<string, ReviewedFleet>();
  let readiness = $state<Record<string, { key: string; message: string | null; plan?: MiningOperationLaunchPlan }>>({});
  let preparation = $state(miningPreparationDraft());
  let definitionOptions = $state<Record<string, MiningPreparationOptions>>({});
  let definitionErrors = $state<Record<string, string>>({});
  let definitionBusy = $state<Record<string, boolean>>({});
  let editorGeneration = 0;
  let mounted = true;
  const definitionRequests = new Map<string, number>();
  onDestroy(() => { mounted = false; editorGeneration++; });

  type DraftMember = MiningOperationMemberDefinition;
  let operationID = $state<string | undefined>(undefined);
  let operationRevision = $state<number | undefined>(undefined);
  let editingDefinition = $state.raw<MiningOperationDefinition | null>(null);
  let name = $state("");
  let anchorSystemID = $state(0);
  let anchorSystemName = $state("");
  let anchorError = $state<string | null>(null);
  let systemMatches = $state<readonly { id: number; name: string }[]>([]);
  let systemLookupSerial = 0;
  let reach = $state<"CURRENT_SYSTEM" | "CURRENT_AND_ADJACENT">("CURRENT_SYSTEM");
  let oreAnomalyFamily = $state<"ORE" | "MOON">("ORE");
  let targetFamily = $state<"BELT" | "ORE_ANOMALY" | "ICE" | "GAS">("BELT");
  let unloadStationID = $state(0);
  let unloadStationName = $state("");
  let unloadStationSystemName = $state("");
  let unloadStructure = $state<{ kind: "structure"; id: number; name: string; solarSystemID: number; solarSystemName: string | null } | null>(null);
  let unloadDivision = $state<number | null>(null);
  let unloadCorporationID = $state(0);
  let stationMatches = $state<readonly { id: number; name: string; systemName: string; kind: "station" | "structure"; solarSystemID?: number }[]>([]);
  let destinationError = $state<string | null>(null);
  let stationLookupSerial = 0;
  type Parking = NonNullable<MiningOperationDefinition["policies"]>["parking"];
  let stopMode = $state<Parking["mode"]>("STAY_IN_PLACE");
  let useDeliveryForParking = $state(true);
  let travelAssist = $state(true);
  let parkingStation = $state<Parking["destination"]>(null);
  let parkingQuery = $state("");
  let parkingDivision = $state<number | null>(null);
  let parkingCorporationID = $state(0);
  let parkingError = $state<string | null>(null);
  let parkingWarning = $state<string | null>(null);
  let parkingMatches = $state<NonNullable<Parking["destination"]>[]>([]);
  let parkingLookupSerial = 0;
  const parkingName = (destination: NonNullable<Parking["destination"]>) => "kind" in destination && destination.kind === "structure" ? destination.name : (destination as { stationName: string }).stationName;
  const parkingID = (destination: NonNullable<Parking["destination"]>) => "kind" in destination && destination.kind === "structure" ? destination.id : (destination as { stationID: number }).stationID;
  const parkingSystemName = (destination: NonNullable<Parking["destination"]>) => "kind" in destination && destination.kind === "structure" ? destination.solarSystemName : (destination as { systemName: string }).systemName;
  const stopLabels: Record<Parking["mode"], string> = { STAY_IN_PLACE: "Stay in place", RETURN_HOME_DOCK: "Return home and dock", RETURN_HOME_UNLOAD_DOCK: "Return home, unload and dock" };
  let members = $state<DraftMember[]>([]);
  const fleetRoles = [
    { role: "MINER", label: "Miner" },
    { role: "HAULER", label: "Hauler" },
    { role: "DEFENDER", label: "Defender" },
    { role: "COMMAND", label: "Command / Support" },
  ] as const;
  const assignableRoles = fleetRoles.filter(choice => choice.role !== "COMMAND");
  const fleetGroups = $derived(fleetRoles.map(group => ({ ...group, pilots: members.filter(member => member.role === group.role) })));
  const unloadPolicy = $derived(miningUnloadPolicy(members));
  const defaultSupport: Omit<NonNullable<MiningOperationDefinition["support"]>, "version" | "characterID"> = {
    fleetPolicy: "EXISTING_ONLY", maintainBursts: true, useIndustrialCore: false,
    coreRequirement: "continueWithoutCore", enableCompression: false, selfMining: false, tractor: false,
    collection: "TRACTOR_ONLY", compressCollectedOre: false, supportLoss: "PAUSE",
  };
  const support = $derived(editingDefinition?.support ?? defaultSupport);
  const commands = $derived(members.filter(member => member.role === "COMMAND"));
  let seedSquadID = $state("");
  let roster = $state<VerifiedOperationPilot[]>([]);
  let pickerOpen = $state(false), seeding = $state(false);
  // Each applicable pilot must have a verified member corporation. A fitting provider
  // or another fleet member cannot lend its corporate identity to this pilot.
  const fittingMembers = $derived(members.filter(member=>!!member.preparation?.fittingID));
  const supplyCorporationID = $derived(sharedPlayerCorporation(fittingMembers.map(memberCorp)));
  const deliveryActors = $derived(members.filter(member=>(unloadPolicy==="SELF_UNLOAD"?member.role==="MINER":member.role==="HAULER")||member.role==="COMMAND"&&(unloadPolicy==="SELF_UNLOAD"?support.selfMining:support.collection==="TRACTOR_AND_COLLECT")));
  const deliveryCorporation = $derived(sharedPlayerCorporation(deliveryActors.map(memberCorp)));
  const parkingActors = $derived(members.filter(member=>member.role!=="DEFENDER"));
  const parkingCorporation = $derived(sharedPlayerCorporation(parkingActors.map(memberCorp)));
  const plannedDivisions = Array.from({length:7}, (_, i) => ({division:i+1,name:null}));
  type OfficeRead = {key:string;divisions:Awaited<ReturnType<typeof inspectMiningOffice>>|null;message:string};
  let offices = $state<Partial<Record<"delivery" | "parking",OfficeRead>>>({});
  const deliveryDockID = $derived(unloadStructure?.id ?? unloadStationID);
  const deliveryDock = $derived<Parking["destination"]>(destinationError ? null : unloadStructure ??
    (unloadStationID > 0 ? { stationID: unloadStationID, stationName: unloadStationName, systemName: unloadStationSystemName } : null));
  const parkingDock = $derived(stopMode === "STAY_IN_PLACE" ? null : useDeliveryForParking ? deliveryDock : parkingStation);
  const parkingDockID = $derived(parkingDock ? parkingID(parkingDock) : 0);
  const freightDivision = $derived(stopMode === "RETURN_HOME_UNLOAD_DOCK" ? useDeliveryForParking ? unloadDivision : parkingDivision : null);
  const freightCorporationID = $derived(freightDivision === null ? 0 : useDeliveryForParking ? unloadCorporationID : parkingCorporationID);
  const officeKey = (id:number, corp:number|null, actors:readonly DraftMember[]) =>
    JSON.stringify([editorGeneration,id,corp,actors.map(({accountName,characterID})=>[accountName,characterID])]);
  const deliveryKey = $derived(officeKey(deliveryDockID,deliveryCorporation,deliveryActors));
  const parkingKey = $derived(officeKey(parkingDockID,parkingCorporation,parkingActors));
  const deliveryOffice = $derived(offices.delivery?.key === deliveryKey ? offices.delivery : undefined);
  const parkingOffice = $derived(offices.parking?.key === parkingKey ? offices.parking : undefined);

  async function checkOffice(which:"delivery" | "parking"):Promise<void>{
    const delivery=which==="delivery", location=delivery?deliveryDockID:parkingDockID;
    const corporation=delivery?deliveryCorporation:parkingCorporation, actors=delivery?deliveryActors:parkingActors;
    if(!location||!corporation||!actors.length||busy)return;
    const key=delivery?deliveryKey:parkingKey;
    busy="office";
    offices[which]={key,divisions:null,message:"Checking the selected office and pilot division permissions…"};
    try{
      const divisions=await inspectMiningOffice(actors,location,corporation);
      offices[which]={key,divisions,message:divisions.length?"Verified corporate divisions at the selected dock.":"The selected dock has no office or common authorized division for these pilots."};
    }catch(cause){offices[which]={key,divisions:null,message:words(cause)};}
    finally{busy=null;}
  }

  const prefs = $derived(loadHangarPrefs());
  const selectedClasses = $derived(editingDefinition?.area.targetClasses[0] === targetFamily ? editingDefinition.area.targetClasses : [targetFamily]);
  const anchorValid = $derived(anchorSystemID > 0 && (anchorSystemName.length > 0 && anchorError === null ||
    editingDefinition?.area.anchorSystemID === anchorSystemID && editingDefinition.area.anchorSystemName === null));
  const standardAvailable = $derived(targetFamily !== "GAS");
  const resourceMatches = $derived(catalog.filter(row => row.family === (targetFamily === "ICE" ? "ice" : "ore") &&
    !resourceIDs.includes(row.typeID) && row.name.toLocaleLowerCase().includes(resourceQuery.toLocaleLowerCase())).slice(0, 15));

  function modeOf(member: DraftMember): "STANDARD" | "CUSTOM" { return member.routineMode ?? (member.automationID ? "CUSTOM" : "STANDARD"); }
  function profileName(member: DraftMember, family: string = targetFamily, policy: string = unloadPolicy): string {
    if (member.role === "COMMAND") return "Mining Command / Support · v1";
    if (modeOf(member) === "CUSTOM") return "Legacy custom assignment — choose Standard before saving";
    const label = family === "BELT" ? "Belt" : family === "ORE_ANOMALY" ? "Ore Anomaly" : family === "ICE" ? "Ice" : null;
    if (member.role === "DEFENDER") return label ? "Standard Defender · v1" : "No Standard Defender profile for this class";
    if (policy === "SELF_UNLOAD") return label && member.role === "MINER" ? `${label} Miner / Self Unload · v1` : "No Standard Self-Unload profile for this role";
    return label === null ? "Not yet executable" : member.role === "MINER" ? `${label} Miner / Hauler Service · v${family === "BELT" ? 2 : 1}` : `${label} Hauler · v1`;
  }

  function words(cause: unknown): string {
    return cause instanceof Error ? cause.message : "The Mining Operations request failed.";
  }

  function definitionKey(member: DraftMember, provider: number): string { return JSON.stringify([member.accountName, member.characterID, provider || member.characterID]); }
  function providerFor(member: DraftMember): number { return member.preparation?.providerCharacterID ?? 0; }
  function optionsFor(member: DraftMember): MiningPreparationOptions | undefined { return definitionOptions[definitionKey(member, providerFor(member))]; }
  function memberCorp(member: DraftMember): number | null {
    const option = memberCorporationID(member.characterID, providerFor(member), optionsFor(member));
    const rosterMember = roster.find(pilot => pilot.characterID === member.characterID &&
      pilot.accountName.toLowerCase() === member.accountName.toLowerCase());
    return option ?? rosterMember?.corporationID ?? null;
  }
  function corporationLabel(id: number): string {
    const member = members.find(row => memberCorp(row) === id);
    return (member && optionsFor(member)?.pilot.corporationName) ||
      roster.find(pilot => pilot.characterID === member?.characterID)?.corporationName || "Corporation name unavailable";
  }
  function providerChoices(member: DraftMember): OperationPilotChoice[] {
    const pilots = roster.filter(row => row.accountName === member.accountName);
    return pilots.some(row => row.characterID === member.characterID) ? pilots : [...pilots, member];
  }
  async function readDefinitions(member: DraftMember, provider: number): Promise<void> {
    const key = definitionKey(member, provider), generation = editorGeneration;
    const request = (definitionRequests.get(key) ?? 0) + 1; definitionRequests.set(key, request);
    definitionBusy[key] = true; delete definitionErrors[key];
    try {
      const result = await getMiningPreparationOptions(member.accountName, member.characterID, provider || null, opts());
      if (!mounted || generation !== editorGeneration || definitionRequests.get(key) !== request) return;
      definitionOptions[key] = result;
    } catch (cause) {
      if (mounted && generation === editorGeneration && definitionRequests.get(key) === request) { delete definitionOptions[key]; definitionErrors[key] = words(cause); }
    } finally { if (mounted && generation === editorGeneration && definitionRequests.get(key) === request) definitionBusy[key] = false; }
  }
  function refreshDefinitions(): void {
    for (const member of members) void readDefinitions(member, providerFor(member));
  }
  function setMemberProvider(member: DraftMember, provider: number): void {
    patchMember(member.characterID, { preparation: { ...(provider ? { providerCharacterID: provider } : {}) } });
    void readDefinitions(member, provider);
  }
  async function reviewReadiness(definition: MiningOperationDefinition & { operationID: string }, inspect = false): Promise<void> {
    if (inspect && (disconnected || busy)) return;
    const key = JSON.stringify(definition), id = definition.operationID;
    nativeReviews.delete(id);
    if (inspect) busy = id;
    const previous = readiness[id]?.key === key ? readiness[id]?.plan : undefined;
    readiness[id] = { key, message: "Checking start readiness…", plan: previous };
    try {
      const reviewed = inspect ? await createRestoredMiningHost(opts(), async (moves, roster) => window.confirm(moves.map(m => `Move ${roster.find(r => r.characterID===m.characterID)?.characterName ?? 'Selected pilot'} from its current fleet into this operation?`).join('\n'))).prepare(id, crypto.randomUUID()) : null;
      const plan = reviewed?.launchPlan ?? await getMiningOperationLaunchPlan(id, opts());
      if (mounted && readiness[id]?.key === key && payload?.operations.some(row => row.definition.operationID === id && JSON.stringify(row.definition) === key && ["DRAFT", "STOPPED"].includes(row.runtime.state)))
        { readiness[id] = { key, message: plan.warnings.join(" ") || null, plan }; if (reviewed) nativeReviews.set(id, reviewed); }
    } catch (cause) { if (mounted && readiness[id]?.key === key) readiness[id] = { key, message: words(cause), plan: previous }; }
    finally { if (inspect) busy = null; }
  }

  function received(next: MiningOperationsPayload): void {
      payload = next;
      const policy = next.capabilities.hostedRunPolicy;
      if (policy && !policy.durationChoices.includes(runtimeMinutes)) runtimeMinutes = policy.defaultRuntimeMinutes;
      loading = false;
      disconnected = false;
      pollError = null;
      for (const row of payload.operations) {
        if (!["DRAFT", "STOPPED"].includes(row.runtime.state)) continue;
        if (!row.runtime.operationRunID && stopResults[row.definition.operationID]) {
          stopResults[row.definition.operationID] = "Run ended. Ready for a fresh Start.";
          delete stopDetails[row.definition.operationID];
        }
        const key = JSON.stringify(row.definition);
        if (readiness[row.definition.operationID]?.key === key) continue;
        void reviewReadiness(row.definition);
      }
  }
  const poll = createControlPlanePoll({ read: () => loadMiningOperations(opts()), received,
    failed: (cause, authLost) => {
      loading = false; disconnected = authLost;
      pollError = authLost ? "WC Account access expired." : words(cause);
      if (authLost) onAuthExpired();
    },
  });
  const refresh = () => poll.refresh();

  onMount(() => {
    void refresh();
    return () => poll.stop();
  });

  $effect(() => {
    void listMiningResources(opts()).then(rows => { catalog = rows; }).catch(() => {});
  });


  async function searchSystem(value: string): Promise<void> {
    const serial = ++systemLookupSerial;
    anchorSystemName = value;
    anchorSystemID = 0;
    anchorError = "Select a known solar system.";
    systemMatches = [];
    if (value.trim().length < 2) return;
    try {
      const result = await findMapLocations(value.trim(), "system", opts());
      if (serial !== systemLookupSerial) return;
      systemMatches = result.matches.filter((row) => row.kind === "system").map((row) => ({ id: row.id, name: row.name }));
      const exact = systemMatches.find((row) => row.name.toLocaleLowerCase() === value.trim().toLocaleLowerCase());
      if (exact) chooseSystem(exact);
      else anchorError = systemMatches.length ? "Choose a matching solar system." : "No known solar system matches that name.";
    } catch (cause) { if (serial === systemLookupSerial) anchorError = words(cause); }
  }

  function chooseSystem(system: { id: number; name: string }): void {
    ++systemLookupSerial;
    anchorSystemID = system.id;
    anchorSystemName = system.name;
    anchorError = null;
    systemMatches = [];
  }

  async function resolveSystemID(value: string): Promise<void> {
    const serial = ++systemLookupSerial;
    anchorSystemID = Number(value) || 0;
    anchorSystemName = "";
    systemMatches = [];
    anchorError = "Enter a known solar system ID.";
    if (!Number.isSafeInteger(anchorSystemID) || anchorSystemID <= 0) return;
    try {
      const result = await resolveDestination(anchorSystemID, opts());
      if (serial !== systemLookupSerial) return;
      if (result.kind === "system" && result.solarSystemID === anchorSystemID && result.systemName) {
        anchorSystemName = result.systemName;
        anchorError = null;
      } else anchorError = "That ID is not a known solar system.";
    } catch (cause) { if (serial === systemLookupSerial) anchorError = words(cause); }
  }

  function rememberRoster(pilots: VerifiedOperationPilot[]): void {
    if (pilots.length) roster = [...roster.filter(row => row.accountName !== pilots[0].accountName), ...pilots];
  }
  async function fleetDockAccess(id:number, actors:readonly DraftMember[]) {
    if (!actors.length) throw new Error("Add a pilot assigned to this destination first.");
    const checked=await Promise.all(actors.map(async actor=>{
      try {return await resolveAccessibleStructure(id,opts(),actor.characterID,actor.accountName);}
      catch {throw new Error(`${actor.characterName}: docking access could not be verified for this structure.`);}
    }));
    return checked[0]!;
  }

  async function searchStation(value: string): Promise<void> {
    const serial = ++stationLookupSerial;
    unloadStationName = value;
    unloadStationID = 0;
    unloadStructure = null;
    unloadStationSystemName = "";
    destinationError = "Choose a known unload destination.";
    stationMatches = [];
    if (value.trim().length < 2) return;
    try {
      const result = await findMapLocations(value.trim(), "station", opts());
      let structures: Awaited<ReturnType<typeof findAccessibleStructures>> = [];
      const actor=deliveryActors[0];
      if (actor) {
        try { structures = await findAccessibleStructures(value.trim(), opts(), actor.characterID,actor.accountName); }
        catch { destinationError = "Structure search is unavailable; NPC stations remain available."; }
      }
      if (serial !== stationLookupSerial) return;
      stationMatches = [
        ...result.matches.filter((row) => row.kind === "station")
          .map((row) => ({ id: row.id, name: row.name, systemName: row.solarSystemName ?? "", kind: "station" as const })),
        ...structures.map((row) => ({ id: row.id, name: row.name, systemName: row.solarSystemName ?? "", kind: "structure" as const,
          solarSystemID: row.solarSystemID ?? 0 })),
      ];
      const exact = stationMatches.find((row) => row.name.toLocaleLowerCase() === value.trim().toLocaleLowerCase());
      if (exact) await chooseStation(exact);
      else destinationError = stationMatches.length ? "Choose a matching destination." : "No known destination matches that name.";
    } catch (cause) { if (serial === stationLookupSerial) destinationError = words(cause); }
  }

  async function chooseStation(station: { id: number; name: string; systemName: string; kind: "station" | "structure"; solarSystemID?: number }): Promise<void> {
    const serial = ++stationLookupSerial;
    if (station.kind === "structure") {
      unloadStationID = 0;
      unloadStructure = null;
      if (!deliveryActors.length || !station.solarSystemID) {
        destinationError = "Add the assigned hauler or self-unloading miner to check this structure.";
        return;
      }
      try {
        const structure = await fleetDockAccess(station.id,deliveryActors);
        if (serial !== stationLookupSerial) return;
        // This selects a dockable identity, not productive readiness. Services
        // cannot be quoted for a free pilot through the stock gateway. Every
        // acquired native owner verifies them before the all-member Main barrier.
        unloadStructure = structure;
      } catch (cause) { if (serial === stationLookupSerial) destinationError = words(cause); return; }
    } else {
      unloadStationID = station.id;
      unloadStructure = null;
    }
    unloadStationName = station.name;
    unloadStationSystemName = station.systemName;
    destinationError = null;
    stationMatches = [];
  }

  async function chooseParking(station: NonNullable<Parking["destination"]>): Promise<void> {
    const serial=++parkingLookupSerial;
    if ("kind" in station && station.kind==="structure") {
      try {station=await fleetDockAccess(station.id,members);}
      catch(cause) {if(serial===parkingLookupSerial)parkingError=words(cause);return;}
      if(serial!==parkingLookupSerial)return;
    }
    parkingStation = station;
    parkingQuery = parkingName(station);
    parkingMatches = [];
    parkingError = null;
    parkingWarning = null;
  }

  async function searchParking(value: string): Promise<void> {
    const serial = ++parkingLookupSerial;
    parkingQuery = value;
    parkingStation = null;
    parkingMatches = [];
    parkingError = "Select a known dockable destination.";
    parkingWarning = null;
    if (value.trim().length < 2) return;
    try {
      if (/^\d+$/.test(value.trim())) {
        const resolved = await resolveDestination(Number(value), opts());
        if (serial !== parkingLookupSerial) return;
        if (resolved.kind === "station" && resolved.stationID === Number(value) && resolved.stationName && resolved.systemName) {
          await chooseParking({ stationID: Number(value), stationName: resolved.stationName, systemName: resolved.systemName });
        } else if (resolved.kind === "structure") {
          const structure = await fleetDockAccess(Number(value),members);
          if (serial !== parkingLookupSerial) return;
          await chooseParking(structure);
        }
        return;
      }
      const found = await findMapLocations(value.trim(), "station", opts());
      let structures: Awaited<ReturnType<typeof findAccessibleStructures>> = [];
      const actor=members[0];
      if (actor) {
        try { structures = await findAccessibleStructures(value.trim(), opts(), actor.characterID,actor.accountName); }
        catch { parkingWarning = "Accessible structure search is unavailable; NPC stations remain available."; }
      } else parkingWarning = "Add a fleet pilot to search accessible structures; NPC stations remain available.";
      if (serial !== parkingLookupSerial) return;
      parkingMatches = [
        ...found.matches.filter(row => row.kind === "station").map(row => ({ stationID: row.id, stationName: row.name, systemName: row.solarSystemName ?? "" })),
        ...structures.map(row => ({ kind: "structure" as const, id: row.id, name: row.name,
          solarSystemID: row.solarSystemID ?? 0, solarSystemName: row.solarSystemName })),
      ];
      const exact = parkingMatches.find(row => parkingName(row).toLowerCase() === value.trim().toLowerCase());
      if (exact) await chooseParking(exact);
    } catch (cause) { if (serial === parkingLookupSerial) parkingError = words(cause); }
  }

  function linkParking(linked: boolean): void {
    useDeliveryForParking = linked;
    if (!linked && !parkingStation && deliveryDock) {
      parkingDivision = unloadDivision;
      parkingCorporationID = unloadCorporationID;
      void chooseParking(deliveryDock);
    }
  }

  function resetEditorView(): void {
    editorTab = "basic";
    expandedFitting = null;
    pickerOpen = false;
    error = null;
    systemMatches = [];
    stationMatches = [];
    parkingMatches = [];
    parkingWarning = null;
    ++systemLookupSerial;
    ++stationLookupSerial;
    ++parkingLookupSerial;
  }

  function newOperation(): void {
    resetEditorView();
    editorGeneration++; preparation = miningPreparationDraft(); definitionOptions = {}; definitionErrors = {}; definitionBusy = {};
    editingDefinition = null;
    operationID = undefined;
    operationRevision = undefined;
    name = "";
    anchorSystemID = 0;
    anchorSystemName = "";
    anchorError = "Select a known solar system.";
    reach = "CURRENT_SYSTEM";
    targetFamily = "BELT"; oreAnomalyFamily = "ORE";
    travelAssist = true;
    resourceMode = "ANY_ELIGIBLE"; resourceIDs = []; resourceQuery = "";
    offices = {};
    unloadStationID = 0;
    unloadStructure = null;
    unloadStationName = "";
    unloadStationSystemName = "";
    unloadDivision = null;
    unloadCorporationID = 0;
    destinationError = null;
    members = [];
    stopMode = "STAY_IN_PLACE";
    useDeliveryForParking = true;
    parkingStation = null;
    parkingQuery = "";
    parkingDivision = null;
    parkingCorporationID = 0;
    parkingError = null;
    seedSquadID = "";
    editing = true;
    void revealEditor();
  }

  function editOperation(definition: MiningOperationDefinition): void {
    resetEditorView();
    editorGeneration++; preparation = miningPreparationDraft(definition.preparation); definitionOptions = {}; definitionErrors = {}; definitionBusy = {};
    editingDefinition = definition;
    operationID = definition.operationID;
    operationRevision = (definition as MiningOperationDefinition & {revision?:number}).revision;
    name = definition.name;
    anchorSystemID = definition.area.anchorSystemID;
    anchorSystemName = definition.area.anchorSystemName ?? "";
    anchorError = null;
    reach = definition.area.reach;
    targetFamily = definition.area.targetClasses[0] ?? "BELT"; oreAnomalyFamily = definition.area.anomalyFamily ?? "ORE";
    travelAssist = definition.policies?.travelAssist?.mode === "AUTO";
    resourceMode = definition.policies?.resourcePolicy?.mode ?? "ANY_ELIGIBLE";
    resourceIDs = [...definition.policies?.resourcePolicy?.typeIDs ?? []]; resourceQuery = "";
    offices = {};
    const delivery = definition.unloadDestination;
    const station = delivery && "stationID" in delivery ? delivery : null;
    unloadStructure = delivery && "kind" in delivery && delivery.kind === "structure"
      ? { kind: delivery.kind, id: delivery.id, name: delivery.name, solarSystemID: delivery.solarSystemID, solarSystemName: delivery.solarSystemName }
      : null;
    unloadStationID = station?.stationID ?? 0;
    unloadStationName = unloadStructure?.name ?? station?.stationName ?? "";
    unloadStationSystemName = unloadStructure?.solarSystemName ?? station?.systemName ?? "";
    unloadDivision = definition.unloadDestination?.corporationDivision ?? null;
    unloadCorporationID = definition.unloadDestination?.corporationID ?? 0;
    destinationError = null;
    members = definition.members.map(member => ({ ...member, routineMode: modeOf(member) }));
    stopMode = definition.policies?.parking.mode ?? "STAY_IN_PLACE";
    parkingStation = definition.policies?.parking.destination ?? null;
    parkingQuery = parkingStation ? parkingName(parkingStation) : "";
    parkingDivision = definition.policies?.parking.corporationDivision ?? null;
    parkingCorporationID = definition.policies?.parking.corporationID ?? 0;
    useDeliveryForParking = stopMode === "STAY_IN_PLACE" || !!(parkingStation && deliveryDock &&
      parkingID(parkingStation) === parkingID(deliveryDock) &&
      (stopMode === "RETURN_HOME_DOCK" || parkingDivision === unloadDivision && parkingCorporationID === unloadCorporationID));
    parkingError = null;
    editing = true;
    void revealEditor();
    refreshDefinitions();
  }

  function canAddPilot(pilot: VerifiedOperationPilot): boolean {
    return pilot.availability === "AVAILABLE" && !members.some(member => member.characterID === pilot.characterID ||
      member.accountName.toLowerCase() === pilot.accountName.toLowerCase());
  }

  function addPilot(pilot: VerifiedOperationPilot): void {
    if (!canAddPilot(pilot)) return;
    members = [...members, {
      characterID: pilot.characterID,
      characterName: pilot.characterName,
      accountName: pilot.accountName,
      role: "MINER",
      routineMode: "STANDARD",
      automationID: "",
    }];
    refreshDefinitions();
  }

  function removePilot(characterID: number): void {
    members = members.filter((member) => member.characterID !== characterID);
    refreshDefinitions();
  }

  function patchMember(characterID: number, patch: Partial<DraftMember>): void {
    if (patch.role === "COMMAND" || patch.role === "DEFENDER") patch = { ...patch, routineMode: "STANDARD", automationID: "" };
    members = members.map((member) => member.characterID === characterID ? { ...member, ...patch } : member);
  }

  async function seedGroup(): Promise<void> {
    if (seeding) return;
    const ids = new Set(prefs.members[seedSquadID] ?? []), generation = editorGeneration;
    const hints = [...new Set(loadKnownCharacters().filter(row => ids.has(row.characterID)).map(row => row.accountName))];
    const skipped: number[] = [];
    seeding = true;
    error = null;
    try {
      const results = await Promise.allSettled(hints.map(name => listVerifiedOperationPilots(name)));
      if (generation !== editorGeneration) return;
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        rememberRoster(result.value);
        for (const pilot of result.value) if (ids.has(pilot.characterID)) addPilot(pilot);
      }
      for (const id of ids) if (!members.some(member => member.characterID === id)) skipped.push(id);
      if (skipped.length) error = `${skipped.length} group member(s) could not be added. Check current availability and account ownership in the pilot picker.`;
    } finally { seeding = false; }
  }

  async function save(): Promise<void> {
    if (disconnected) return;
    if (!anchorValid) { showEditorTab("basic"); error = anchorError ?? "Choose a known solar system."; return; }
    if (commands.length > 1) { showEditorTab("fleet"); error = "Choose exactly one Command / Support pilot."; return; }
    let parkingDestination = parkingDock;
    if (stopMode !== "STAY_IN_PLACE" && (!parkingDestination || !useDeliveryForParking && parkingError)) {
      showEditorTab("logistics");
      error = useDeliveryForParking ? "Choose a delivery destination to use for parking." : parkingError || "Choose a parking destination.";
      return;
    }
    busy = "save";
    error = null;
    try {
      const savedDelivery = editingDefinition?.unloadDestination;
      const keepDelivery = savedDelivery && !destinationError && savedDelivery.corporationDivision === unloadDivision &&
        (savedDelivery.corporationID ?? 0) === unloadCorporationID &&
        ("stationID" in savedDelivery ? !unloadStructure && savedDelivery.stationID === unloadStationID : savedDelivery.id === unloadStructure?.id);
      const savedParking = editingDefinition?.policies?.parking;
      const keepParking = savedParking && savedParking.mode === stopMode &&
        (savedParking.destination ? parkingID(savedParking.destination) : 0) === parkingDockID &&
        savedParking.corporationDivision === freightDivision && (savedParking.corporationID ?? 0) === freightCorporationID;
      if (!keepDelivery && unloadDivision !== null && (!deliveryDockID || destinationError ||
          deliveryOffice?.divisions && !deliveryOffice.divisions.some(row=>row.division===unloadDivision)))
        throw Error("Choose an available corporation division at the selected delivery dock.");
      if (!keepParking && freightDivision !== null &&
          parkingOffice?.divisions && !parkingOffice.divisions.some(row=>row.division===freightDivision))
        throw Error("Choose an available corporation division at the selected parking dock.");
      const deliveryCorp = !keepDelivery && unloadDivision !== null
        ? resolveFleetCorporation(unloadCorporationID, deliveryCorporation) : null;
      const parkingCorp = keepParking || freightDivision === null ? null : resolveFleetCorporation(
        useDeliveryForParking ? deliveryCorp ?? savedDelivery?.corporationID ?? 0 : freightCorporationID, parkingCorporation);
      // Linked Upwell delivery may only have been checked for Haulers. Parking still checks the whole fleet.
      if (!keepParking && useDeliveryForParking && parkingDestination?.kind === "structure" &&
          (!savedParking?.destination || parkingID(savedParking.destination) !== parkingDestination.id))
        parkingDestination = await fleetDockAccess(parkingDestination.id, members);
      if (preparation.sourceKind === "corp" && !preparation.corporationID && supplyCorporationID)
        preparation.corporationID = supplyCorporationID;
      const preparationConfig = {
        ...miningPreparationConfig(preparation),
        suppliesRequired: editingDefinition?.preparation?.suppliesRequired ?? false,
      };
      const knownOperations = new Set(savedOperations.map(row => row.definition.operationID));
      const saved = await saveMiningOperation({
        ...(operationID ? { operationID, revision: operationRevision } : {}),
        name,
        area: {
          anchorSystemID,
          anchorSystemName: anchorSystemName.trim() || null,
          reach,
          targetClasses: selectedClasses,
          ...(selectedClasses.includes("ORE_ANOMALY") ? { anomalyFamily: oreAnomalyFamily } : {}),
        },
        targetPolicy: "ANY_ELIGIBLE",
        policies: { ...editingDefinition?.policies, version: 1, resourcePolicy: { mode: resourceMode, source: "MANUAL", typeIDs: resourceMode === "PREFER_LIST" ? resourceIDs : [] }, travelAssist: { mode: travelAssist ? "AUTO" : "DISABLED" }, parking: keepParking ? savedParking : { mode: stopMode, destination: parkingDestination, corporationDivision: freightDivision, corporationID: parkingCorp } },
        unloadPolicy,
        unloadDestination: keepDelivery ? savedDelivery : destinationError === null && unloadStructure
          ? { ...unloadStructure, corporationDivision: unloadDivision, corporationID: deliveryCorp }
          : unloadStationID > 0 && destinationError === null
            ? { stationID: unloadStationID, stationName: unloadStationName, systemName: unloadStationSystemName, corporationDivision: unloadDivision, corporationID: deliveryCorp }
            : null,
        members,
        preparation: preparationConfig,
        oreLogistics: editingDefinition?.oreLogistics ?? { version: 1, remoteCompression: false, compressedJettisonFraction: .5 },
        ...(commands.length === 1 ? { support: { ...support, version: 1, characterID: commands[0]!.characterID } } : {}),
      }, opts());
      poll.invalidate();
      payload = saved;
      selectedOperationID = operationID ?? saved.operations.find(row => !knownOperations.has(row.definition.operationID))?.definition.operationID ?? null;
      editing = false;
      await refresh();
    } catch (cause) {
      error = words(cause);
    } finally {
      busy = null;
    }
  }

  async function start(definition: MiningOperationDefinition & { operationID: string }): Promise<void> {
    if (disconnected || !runPolicy) return;
    delete extensionResults[definition.operationID];
    delete stopResults[definition.operationID];
    launching = definition.operationID;
    const cancellation = new AbortController();
    startupAbort = cancellation;
    cancelStartup = false;
    busy = definition.operationID;
    error = null;
    try {
      const host = createRestoredMiningHost(opts(), async (moves, roster) => {
        const names = moves.map(move => roster.find(member => member.characterID === move.characterID)?.characterName ?? "Selected pilot");
        throw Error(names.join(", ") + " must leave a previous fleet. Use Review member readiness to approve these moves.");
      });
      const latest = (await loadMiningOperations(opts())).operations.find(row => row.definition.operationID === definition.operationID);
      if (!latest || latest.runtime.state !== "DRAFT") throw Error("The previous run is still with Farmer. Wait for it to finish before starting.");
      const cached = nativeReviews.get(definition.operationID);
      const reviewed = cached && JSON.stringify(cached.definition) === JSON.stringify(definition) ? cached : await host.prepare(definition.operationID, crypto.randomUUID(), true);
      readiness[definition.operationID] = {key:JSON.stringify(definition),message:reviewed.launchPlan.warnings.join(" "),plan:reviewed.launchPlan};
      if (!mounted || cancelStartup) return;
      nativeReviews.delete(definition.operationID);
      await host.start(reviewed, runtimeMinutes, cancellation.signal, runPolicy.maxRuntimeMinutes);
      await refresh();
    } catch (cause) {
      error = words(cause);
      nativeReviews.delete(definition.operationID);
      await refresh();
    } finally {
      startupAbort = null;
      launching = null;
      busy = null;
    }
  }

  async function stop(operationID: string, mode?: StopFreightMode, closeOfflineStop = false): Promise<void> {
    if (disconnected) return;
    const runtime=payload?.operations.find(row=>row.definition.operationID===operationID)?.runtime;
    if (launching === operationID) {
      cancelStartup = true;
      startupAbort?.abort();
      if (runtime?.state !== "ASSEMBLING" && runtime?.state !== "ACTIVE") return;
      mode = "RETURN_HOME";
    }
    if(!mode||!runtime?.operationRunID)return;
    choosingStop=null;
    busy = operationID;
    error = null;
    const requested: string[] = [];
    const members = payload?.operations.find(row => row.definition.operationID === operationID)?.runtime.members ?? [];
    let recovering = false;
    delete stopDetails[operationID];
    stopResults[operationID] = "Checking current owners for Stop…";
    try {
      if (closeOfflineStop) {
        payload = await loadMiningOperations(opts(), { operationID, operationRunID: runtime.operationRunID });
        delete stopResults[operationID];
        return;
      }
      const selected=await requestMiningStop(operationID,runtime.operationRunID,mode,opts());
      stopResults[operationID]=stopLabel(selected.mode)+". Waiting for native Parking and release.";
      if(selected.live)return;
      if(selected.finishAtHome){
        recovering = true;
        const details: string[] = [];
        stopDetails[operationID] = details;
        stopResults[operationID] = "Checking the docked fleet and finishing outstanding unloads.";
        await recoverMiningOperation(operationID,opts(),message=>{
          const named = message.replace(/^Pilot (\d+):/, (label, id) => {
            const pilot = members.find(member => member.characterID === Number(id));
            return pilot ? pilot.characterName + ":" : label;
          });
          stopDetails[operationID] = [...(stopDetails[operationID]??[]), named];
        },runtime.operationRunID);
        return;
      }
      await createRestoredMiningHost(opts(), async () => false).stop(operationID, characterID => {
        requested.push(members.find(member => member.characterID === characterID)?.characterName ?? `Pilot ${characterID}`);
        stopResults[operationID] = `Stop requested for ${requested.join(", ")}. Waiting for native Parking and release.`;
      },runtime.operationRunID);
      if (!requested.length) stopResults[operationID] = "No active member needed a Stop request. See the current member status below.";
    } catch (cause) {
      if (recovering) {
        stopResults[operationID] = "Unloading still needs attention. See Retry Stop details.";
        if (!stopDetails[operationID]?.length) stopDetails[operationID] = [words(cause)];
      } else {
        stopResults[operationID] = (requested.length ? stopResults[operationID] + " " : "") + words(cause);
      }
    } finally {
      await refresh();
      busy = null;
    }
  }
  async function relocate(operationID:string):Promise<void> {
    const runtime=payload?.operations.find(r=>r.definition.operationID===operationID)?.runtime;
    if(disconnected||!runtime?.currentTarget||!runtime.operationRunID)return;
    busy=operationID;error=null;
    try{payload=await relocateMiningOperation(operationID,runtime,opts());}
    catch(cause){error=words(cause);await refresh();}finally{busy=null;}
  }

  async function extend(operationID: string, minutes: number): Promise<void> {
    if (disconnected || !runPolicy || !window.confirm(`Add ${hostedDurationLabel(minutes)} to current member expiries? Total approved runtime is capped at ${hostedDurationLabel(runPolicy.maxRuntimeMinutes)}; stopped members are not resumed.`)) return;
    busy = operationID; extensionResults[operationID] = "Extending active member grants…";
    try {
      const result = await extendMiningOperation(operationID, minutes, opts()); payload = result.payload;
      const members = result.payload.operations.find(row => row.definition.operationID === operationID)?.definition.members ?? [];
      extensionResults[operationID] = (result.extension.ok ? "Extension results: " : "Extension incomplete: ") + (result.extension.message ?? result.extension.results?.map(row => `${members.find(member => member.characterID === row.characterID)?.characterName ?? `Pilot ${row.characterID}`}: ${row.ok ? "extended" : `${row.error}: ${row.message}`}`).join(" · ") ?? "Extension unavailable.");
    } catch (cause) { extensionResults[operationID] = words(cause); } finally { busy = null; }
  }

  async function updateTargetBoard(targetKey: string, action: typeof markMiningBeltSafe): Promise<void> {
    if (disconnected || busy !== null) return;
    busy = targetKey;
    error = null;
    try {
      const next = await action(targetKey, opts());
      poll.invalidate();
      if (payload) payload = { ...payload, targetBoard: next.targetBoard };
      await refresh();
    } catch (cause) {
      error = words(cause);
    } finally {
      busy = null;
    }
  }

  async function remove(operationID: string): Promise<void> {
    if (disconnected || busy !== null) return;
    if (!window.confirm("Delete this Mining Operation?")) return;
    busy = operationID;
    error = null;
    try {
      const row = payload?.operations.find(item => item.definition.operationID === operationID);
      const revision = (row?.definition as (MiningOperationDefinition & {revision?:number}) | undefined)?.revision;
      if (!revision) throw new Error("The saved operation revision is unavailable; refresh before deleting.");
      const remaining = await deleteMiningOperation(operationID, revision, opts());
      poll.invalidate();
      delete readiness[operationID];
      nativeReviews.delete(operationID);
      delete extensionResults[operationID];
      delete stopResults[operationID];
      if (editingDefinition?.operationID === operationID) {
        editing = false;
        editingDefinition = null;
        editorGeneration++;
      }
      payload = remaining;
      await refresh();
    } catch (cause) {
      error = words(cause);
    } finally {
      busy = null;
    }
  }
</script>

<section class="operations">
  <header>
    <h2>Mining Operations</h2>
    <div class="launch-settings">
      {#if savedOperations.length}
        <label>Saved operation
          <select value={selectedOperation?.definition.operationID ?? ""} disabled={editing} onchange={event => { selectedOperationID = event.currentTarget.value; }}>
            {#each savedOperations as operation (operation.definition.operationID)}
              <option value={operation.definition.operationID}>{operation.definition.name} · {stateLabel(operation.runtime.state)}</option>
            {/each}
          </select>
        </label>
      {/if}
      <button type="button" class="primary" disabled={editing || busy !== null} onclick={newOperation}>New operation</button>
    </div>
  </header>

  {#if error && !editing}<p class="center-message" role="alert">{error}</p>{/if}
  {#if pollError}<p class="center-message" role="alert">{pollError}</p>{/if}
  {#if loading}<p class="muted">Loading Mining Command Center…</p>{/if}

  {#if editing}
    {@const editorStatus = operationID ? savedOperations.find(row => row.definition.operationID === operationID)?.runtime.state ?? "DRAFT" : "DRAFT"}
    <form class="editor center-panel" bind:this={editor} novalidate aria-labelledby={editorID + "-heading"}
      onsubmit={event => { event.preventDefault(); void submitEditor(); }}>
      <div class="editor-heading">
        <div>
          <h3 id={editorID + "-heading"}>{name.trim() || (operationID ? "Edit operation" : "New operation")}</h3>
          <p>{anchorSystemName || (anchorSystemID ? "System " + anchorSystemID : "Choose a system")}</p>
        </div>
        <div class="editor-summary">
          <CenterStatus state={editorStatus} label={stateLabel(editorStatus)} />
          <span>{fleetGroups.filter(group => group.role !== "COMMAND" || group.pilots.length).map(group => group.pilots.length + " " + group.label).join(" · ")}</span>
        </div>
      </div>

      <div class="center-tabs editor-tabs" role="tablist" aria-label="Operation editor">
        {#each editorTabs as tab, index (tab.id)}
          <button type="button" role="tab" id={editorID + "-tab-" + tab.id} aria-controls={editorID + "-" + tab.id}
            aria-selected={editorTab === tab.id} tabindex={editorTab === tab.id ? 0 : -1}
            onclick={() => showEditorTab(tab.id)} onkeydown={event => editorTabKey(event, index)}>{tab.label}</button>
        {/each}
      </div>

      <div class="editor-content" bind:this={editorContent} inert={busy === "save"}>
        <div class="editor-pane" role="tabpanel" id={editorID + "-basic"} aria-labelledby={editorID + "-tab-basic"}
          data-editor-tab="basic" hidden={editorTab !== "basic"}>
          <div class="editor-fields">
            <label>Name <input name="operationName" required bind:value={name} autocomplete="off" /></label>
            <div class="system-field">
              <label>Anchor system <input required={!anchorValid} value={anchorSystemName}
                oninput={event => void searchSystem(event.currentTarget.value)} placeholder="Search solar systems" autocomplete="off" /></label>
              {#if systemMatches.length > 0}<div class="system-matches" role="listbox" aria-label="Matching solar systems">
                {#each systemMatches as system (system.id)}<button type="button" role="option" aria-selected="false" onclick={() => chooseSystem(system)}>{system.name}</button>{/each}
              </div>{/if}
              {#if anchorError}<p class="error" role="status">{anchorError}</p>{/if}
            </div>
            <label>System reach
              <select bind:value={reach}>
                <option value="CURRENT_SYSTEM">Current system</option>
                <option value="CURRENT_AND_ADJACENT">Current and adjacent</option>
              </select>
              {#if reach === "CURRENT_AND_ADJACENT"}<small>Dynamic discovery in adjacent systems is deferred.</small>{/if}
            </label>
            <details class="system-options"><summary>Advanced system selection</summary>
              <label>Anchor system ID <input type="number" min="1" value={anchorSystemID || ""} oninput={event => void resolveSystemID(event.currentTarget.value)} /></label>
            </details>
          </div>
          <fieldset class="editor-group">
            <legend>Target family</legend>
            <div class="editor-choices">
              <label class="editor-check"><input type="radio" bind:group={targetFamily} value="BELT" /> Asteroid Belt</label>
              <label class="editor-check"><input type="radio" bind:group={targetFamily} value="ORE_ANOMALY" /> Ore Anomaly</label>
              <label class="editor-check"><input type="radio" bind:group={targetFamily} value="ICE" /> Ice</label>
              <span class="muted">Gas unavailable</span>
            </div>
            {#if targetFamily === "ORE_ANOMALY"}
              <label>Ore anomaly family <select bind:value={oreAnomalyFamily}><option value="ORE">Ordinary ore anomalies</option><option value="MOON">Moon ore anomalies</option></select></label>
            {:else if targetFamily === "ICE"}<p class="note">Requires online Ice Harvesters.</p>{/if}
          </fieldset>
          <fieldset class="editor-group">
            <legend>Resources</legend>
            <label>Resource preference <select bind:value={resourceMode}><option value="ANY_ELIGIBLE">Any eligible</option><option value="PREFER_LIST">Prefer ordered list</option></select></label>
            {#if resourceMode === "PREFER_LIST"}
              {#if catalog.length === 0}<p class="notice">Resource catalog unavailable. Any eligible remains available.</p>{/if}
              <label>Resource catalog <input type="search" bind:value={resourceQuery} placeholder="Search resource types" /></label>
              <div class="system-matches">
                {#each resourceMatches as resource (resource.typeID)}
                  <button type="button" disabled={resourceIDs.length >= 20} onclick={() => { resourceIDs = [...resourceIDs, resource.typeID]; resourceQuery = ""; }}>{resource.name}</button>
                {/each}
              </div>
              {#if resourceIDs.length}<ol class="resource-order">
                {#each resourceIDs as id, index (id)}
                  {@const resourceName = catalog.find(row => row.typeID === id)?.name ?? "Type " + id}
                  <li><span>{resourceName}</span>
                    <button type="button" aria-label={"Move " + resourceName + " earlier"} disabled={index === 0} onclick={() => { const next = [...resourceIDs]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; resourceIDs = next; }}>↑</button>
                    <button type="button" class="quiet" aria-label={"Remove " + resourceName} onclick={() => { resourceIDs = resourceIDs.filter(value => value !== id); }}>Remove</button>
                  </li>
                {/each}
              </ol>{/if}
              <p class="note">Standard miners prefer listed resources observed at the target, then fall back within the same family.</p>
            {/if}
          </fieldset>
        </div>

        <div class="editor-pane" role="tabpanel" id={editorID + "-fleet"} aria-labelledby={editorID + "-tab-fleet"}
          data-editor-tab="fleet" hidden={editorTab !== "fleet"}>
          <div class="editor-tools">
            <button type="button" onclick={() => pickerOpen = !pickerOpen}>{pickerOpen ? "Close pilot picker" : "Add a pilot"}</button>
            {#if prefs.squads.length > 0}
              <select bind:value={seedSquadID} aria-label="Pilot Group">
                <option value="">Seed from Pilot Group…</option>
                {#each prefs.squads as squad (squad.id)}<option value={squad.id}>{squad.name}</option>{/each}
              </select>
              <button type="button" disabled={!seedSquadID || seeding} onclick={() => void seedGroup()}>Add group members</button>
            {/if}
            {#if members.length}<button type="button" class="quiet" onclick={refreshDefinitions} disabled={disconnected}>Refresh fitting libraries</button>{/if}
          </div>
          {#if pickerOpen}
            <OperationPilotPicker onChoose={addPilot} onLoaded={rememberRoster} canChoose={canAddPilot} disabled={disconnected} />
          {/if}
          {#if !members.length}<p class="note">Add at least one Miner to the fleet.</p>{/if}
          {#each fleetGroups as group (group.role)}
            {#if group.pilots.length}
              <div class="fleet-group">
                <h4>{group.label} <span>{group.pilots.length}</span></h4>
                <div class="fleet-columns" aria-hidden="true"><span>Pilot</span><span>Role</span><span>Routine</span><span>Fitting</span><span>Remove</span></div>
                {#each group.pilots as member (member.characterID)}
                  {@const key = definitionKey(member, providerFor(member))}
                  {@const fitName = member.preparation?.fittingID ? optionsFor(member)?.definitions.contracts.find(fit => fit.definition.fittingID === member.preparation?.fittingID)?.name ?? "Saved pilot fitting" : "Current equipment"}
                  {@const fittingOpen = expandedFitting === member.characterID}
                  <div class="fleet-entry">
                    <div class="fleet-row">
                      <strong class="fleet-pilot">{member.characterName}</strong>
                      <select class="fleet-role" aria-label={"Role for " + member.characterName} value={member.role}
                        onchange={event => patchMember(member.characterID, { role: event.currentTarget.value as DraftMember["role"], automationID: "" })}>
                        {#if member.role === "COMMAND"}<option value="COMMAND" disabled>Command / Support (saved)</option>{/if}
                        {#each assignableRoles as choice (choice.role)}<option value={choice.role}>{choice.label}</option>{/each}
                      </select>
                      <div class="fleet-routine">
                        {#if modeOf(member) === "CUSTOM"}
                          <button type="button" title={profileName(member)} onclick={() => patchMember(member.characterID, { routineMode: "STANDARD", automationID: "" })}>Use Standard</button>
                        {:else if standardAvailable}
                          <span title={profileName(member)}>{profileName(member)}</span>
                        {:else}<span class="error">No Standard profile</span>{/if}
                      </div>
                      <button type="button" class="fleet-fitting quiet" title={fitName} aria-expanded={fittingOpen}
                        aria-label={"Fitting for " + member.characterName + " · " + fitName}
                        onclick={() => expandedFitting = fittingOpen ? null : member.characterID}>{fitName}</button>
                      <button type="button" class="fleet-remove quiet" aria-label={"Remove " + member.characterName} onclick={() => removePilot(member.characterID)}>Remove</button>
                    </div>
                    {#if fittingOpen}
                      <div class="fit-details" role="group" aria-label={"Fitting options for " + member.characterName}>
                        <div class="editor-fields">
                          <label>Fitting library owner <select value={member.preparation?.providerCharacterID ?? 0} onchange={event => setMemberProvider(member, Number(event.currentTarget.value))}>
                            <option value={0}>This pilot's corporation library</option>
                            {#each providerChoices(member) as pilot}<option value={pilot.characterID}>{pilot.characterName}</option>{/each}
                          </select></label>
                          <label>Pilot fitting <select value={member.preparation?.fittingID ?? 0} disabled={definitionBusy[key]} onchange={event => patchMember(member.characterID, { preparation: { ...member.preparation, fittingID: Number(event.currentTarget.value) || undefined } })}>
                            <option value={0}>Use current equipment (as is)</option>
                            <optgroup label="Use selected corporate fitting">
                              {#each optionsFor(member)?.definitions.contracts ?? [] as fit}<option value={fit.definition.fittingID}>{fit.name}</option>{/each}
                              {#if member.preparation?.fittingID && !optionsFor(member)?.definitions.contracts.some(fit => fit.definition.fittingID === member.preparation?.fittingID)}<option value={member.preparation.fittingID} disabled>Configured fitting — refresh its library</option>{/if}
                            </optgroup>
                          </select></label>
                        </div>
                        <p class="note">{member.role === "DEFENDER" ? "Use a combat or remote-repair fit. Urgent repairs take priority." : "Fitting differences are shown as warnings."}</p>
                        {#if definitionErrors[key]}<p class="error">{definitionErrors[key]}</p>{/if}
                        {#if optionsFor(member)?.definitions.status && optionsFor(member)?.definitions.status !== "READY"}<p class="notice">Fitting library unavailable. Current equipment is still available.</p>{/if}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          {/each}
        </div>

        <div class="editor-pane editor-destinations" role="tabpanel" id={editorID + "-logistics"} aria-labelledby={editorID + "-tab-logistics"}
          data-editor-tab="logistics" hidden={editorTab !== "logistics"}>
          <fieldset class="editor-group destination">
            <legend>Delivery</legend>
            <p class="logistics-mode">{unloadPolicy === "SELF_UNLOAD" ? "Miner self-unload" : "Hauler service"}{#if !deliveryActors.length}<small>Add a delivery pilot to find accessible structures.</small>{/if}</p>
            <label>Delivery destination <input value={unloadStationName} oninput={event => void searchStation(event.currentTarget.value)}
              placeholder="Search station or accessible structure" autocomplete="off" /></label>
            {#if stationMatches.length > 0}<div class="system-matches" role="listbox" aria-label="Matching delivery destinations">
              {#each stationMatches as station (station.id)}<button type="button" role="option" aria-selected="false" onclick={() => void chooseStation(station)}>{station.name} · {station.systemName} · {station.kind === "structure" ? "Upwell structure" : "NPC station"}</button>{/each}
            </div>{/if}
            {#if deliveryDock}<small>{unloadStructure ? "Upwell structure" : "NPC station"}{unloadStationSystemName ? " · " + unloadStationSystemName : ""}</small>{/if}
            {#if destinationError}<p class="error" role="status">{destinationError}</p>{/if}
            <label>Delivery hangar <select bind:value={unloadDivision}>
              <option value={null}>Personal hangar</option>
              {#each deliveryCorporation && deliveryDockID ? (deliveryOffice?.divisions ?? plannedDivisions) : [] as row}
                <option value={row.division}>Corporation division {row.division}{row.name ? " · " + row.name : ""}</option>
              {/each}
              {#if unloadDivision !== null && (!deliveryCorporation || !deliveryDockID || deliveryOffice?.divisions && !deliveryOffice.divisions.some(row => row.division === unloadDivision))}
                <option value={unloadDivision} disabled>Corporation division {unloadDivision} · unavailable</option>
              {/if}
            </select></label>
            {#if deliveryCorporation && deliveryDockID}
              <button type="button" class="quiet" disabled={busy !== null || disconnected} onclick={() => void checkOffice("delivery")}>Check delivery office access</button>
              {#if deliveryOffice}<p class="note" role="status">{deliveryOffice.message}</p>{/if}
            {:else if !deliveryCorporation}<p class="note">Corporate delivery requires a shared verified corporation.</p>{/if}
            {#if unloadDivision !== null}
              <p class="note">{deliveryCorporation ? corporationLabel(deliveryCorporation) : "Waiting for verified delivery corporation"}</p>
              {#if deliveryCorporation && unloadCorporationID && unloadCorporationID !== deliveryCorporation}
                <p class="notice">The saved delivery corporation differs from these pilots.</p>
                <button type="button" onclick={() => unloadCorporationID = deliveryCorporation}>Use verified delivery corporation</button>
              {/if}
            {/if}
          </fieldset>
          <fieldset class="editor-group destination">
            <legend>On Stop</legend>
            <label>Stop policy <select bind:value={stopMode}>{#each Object.entries(stopLabels) as [mode, label]}<option value={mode}>{label}</option>{/each}</select></label>
            {#if stopMode !== "STAY_IN_PLACE"}
              <label class="editor-check"><input type="checkbox" checked={useDeliveryForParking} onchange={event => linkParking(event.currentTarget.checked)} /> Use delivery destination for parking</label>
              {#if useDeliveryForParking}
                {#if stopMode === "RETURN_HOME_UNLOAD_DOCK"}<p class="note">Uses the delivery hangar for the final unload.</p>{/if}
              {:else}
                <label>Parking destination <input required value={parkingQuery} oninput={event => void searchParking(event.currentTarget.value)}
                  placeholder="Search station or accessible structure" autocomplete="off" /></label>
                {#if parkingMatches.length > 0}<div class="system-matches" role="listbox" aria-label="Matching parking stations">
                  {#each parkingMatches as station (parkingID(station))}<button type="button" role="option" aria-selected="false" onclick={() => void chooseParking(station)}>{parkingName(station)} · {parkingSystemName(station)} · {station.kind === "structure" ? "Upwell structure" : "NPC station"}</button>{/each}
                </div>{/if}
                {#if parkingStation}<small>{parkingStation.kind === "structure" ? "Upwell structure" : "NPC station"}{parkingSystemName(parkingStation) ? " · " + parkingSystemName(parkingStation) : ""}</small>{/if}
                {#if parkingError}<p class="error" role="status">{parkingError}</p>{/if}
                {#if parkingWarning}<p class="note" role="status">{parkingWarning}</p>{/if}
                {#if stopMode === "RETURN_HOME_UNLOAD_DOCK"}
                  <label>Parking hangar <select bind:value={parkingDivision}>
                    <option value={null}>Personal hangar</option>
                    {#each parkingCorporation && parkingDockID ? (parkingOffice?.divisions ?? plannedDivisions) : [] as row}
                      <option value={row.division}>Corporation division {row.division}{row.name ? " · " + row.name : ""}</option>
                    {/each}
                    {#if parkingDivision !== null && (!parkingCorporation || !parkingDockID || parkingOffice?.divisions && !parkingOffice.divisions.some(row => row.division === parkingDivision))}
                      <option value={parkingDivision} disabled>Corporation division {parkingDivision} · unavailable</option>
                    {/if}
                  </select></label>
                {/if}
              {/if}
              {#if stopMode === "RETURN_HOME_UNLOAD_DOCK"}
                {#if parkingCorporation && parkingDockID}
                  <button type="button" class="quiet" disabled={busy !== null || disconnected} onclick={() => void checkOffice("parking")}>Check parking office access</button>
                  {#if parkingOffice}<p class="note" role="status">{parkingOffice.message}</p>{/if}
                {/if}
                {#if freightDivision !== null && !useDeliveryForParking}
                  <p class="note">{parkingCorporation ? corporationLabel(parkingCorporation) : "Waiting for verified parking corporation"}</p>
                {/if}
                {#if freightDivision !== null && parkingCorporation && freightCorporationID && freightCorporationID !== parkingCorporation}
                  <p class="notice">{useDeliveryForParking ? "Delivery and parking pilots must share the selected corporation." : "The saved parking corporation differs from these pilots."}</p>
                  {#if !useDeliveryForParking}<button type="button" onclick={() => parkingCorporationID = parkingCorporation}>Use verified parking corporation</button>{/if}
                {/if}
                <p class="note">Freight pilots unload eligible ore. Defenders dock.</p>
              {/if}
            {:else}<p class="note">Recall drones and release control at the current location.</p>{/if}
          </fieldset>
        </div>

        <div class="editor-pane" role="tabpanel" id={editorID + "-advanced"} aria-labelledby={editorID + "-tab-advanced"}
          data-editor-tab="advanced" hidden={editorTab !== "advanced"}>
          <details class="editor-group">
            <summary>Travel assist</summary>
            <label class="editor-check"><input type="checkbox" bind:checked={travelAssist} /> Use fitted AB/MWD on resource and container approaches</label>
          </details>
          {#if members.length}
            <details class="editor-group">
              <summary>Optional supply preparation</summary>
              <label class="editor-check"><input type="checkbox" bind:checked={preparation.replenishSupplies} /> Top up supplies for pilots with a selected fitting</label>
              <p class="note">The saved fitting sets the target quantities.</p>
              <fieldset class="supply-fields" aria-label="Supply settings" disabled={!preparation.replenishSupplies}>
                <label>Physical supply source
                  <select value={preparation.sourceKind === "corp" ? preparation.division : 0} onchange={event => {
                    const division = Number(event.currentTarget.value);
                    preparation.sourceKind = division ? "corp" : "hangar";
                    if (division) preparation.division = division;
                  }}>
                    <option value={0}>Each member's local personal hangar</option>
                    {#each plannedDivisions as row}<option value={row.division}>Corporation Division {row.division}</option>{/each}
                  </select>
                </label>
                {#if preparation.sourceKind === "corp"}
                  <p class="note">Office and division access are checked at each pilot's preparation station.</p>
                  {#if !supplyCorporationID && !preparation.corporationID}
                    <p class="note">The common corporation is verified during readiness checks for pilots with a selected fitting.</p>
                  {/if}
                  {#if supplyCorporationID && preparation.corporationID && preparation.corporationID !== supplyCorporationID}
                    <p class="notice">The saved supply corporation differs from these pilots.</p>
                    <button type="button" onclick={() => preparation.corporationID = supplyCorporationID}>Use verified supply corporation</button>
                  {/if}
                {/if}
              </fieldset>
            </details>
          {/if}
        </div>
      </div>
      <footer class="editor-footer">
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        <div class="actions">
          <button type="button" class="quiet" disabled={busy === "save"} onclick={() => { editing = false; editorGeneration++; error = null; }}>Cancel</button>
          <button type="submit" class="primary" disabled={busy !== null || disconnected}>Save operation</button>
        </div>
      </footer>
    </form>
  {/if}

  {#if payload && payload.operations.length === 0 && !editing}<p class="empty">No Mining Operations yet.</p>{/if}
  {#if selectedOperation && (!editing || !canStart(selectedOperation.runtime.state))}
    {@const row = selectedOperation}
    {@const dockedPending = row.runtime.members.filter(member => member.dockedForUnload)}
    {@const retryClosesOffline = row.runtime.canCloseOfflineStop && !row.runtime.stopUnload?.characterIDs.length}
    {#key row.definition.operationID}
    <article class="operation-card center-panel">
      <div class="title-row"><div><h3>{row.definition.name}</h3><CenterStatus state={row.runtime.state} label={dockedPending.length ? "Unloading incomplete" : stateLabel(row.runtime.state)} /></div><div class="actions">
        <button type="button" disabled={editing || busy !== null} onclick={() => editOperation(row.definition)}>Edit</button>
        {#if canStart(row.runtime.state)}
          <label>Run limit
            <select bind:value={runtimeMinutes} aria-label="Operation run limit" disabled={!runPolicy || busy !== null}>
              {#each runPolicy?.durationChoices ?? [] as minutes}<option value={minutes}>{hostedDurationLabel(minutes)}</option>{/each}
            </select>
          </label>
          {#if !disconnected}
            <button type="button" class="primary" disabled={busy !== null || !runPolicy} onclick={() => void start(row.definition)}>Start</button>
          {/if}
          {#if launching === row.definition.operationID}
            <button type="button" class="danger" disabled={disconnected || cancelStartup} onclick={() => void stop(row.definition.operationID)}>{cancelStartup ? "Stopping startup…" : "Stop startup"}</button>
          {/if}
        {:else}
          {#if launching === row.definition.operationID}
            <button type="button" class="danger" disabled={disconnected || cancelStartup} onclick={() => void stop(row.definition.operationID)}>{cancelStartup ? "Stopping startup…" : "Stop startup"}</button>
          {:else if row.runtime.stopFreight}
            <button type="button" class="danger" disabled={disconnected || busy !== null} onclick={() => void stop(row.definition.operationID,row.runtime.stopFreight ?? undefined,retryClosesOffline)}>Retry Stop</button>
            {#if row.runtime.canCloseOfflineStop && !retryClosesOffline}
              <button type="button" disabled={disconnected || busy !== null} onclick={() => void stop(row.definition.operationID,row.runtime.stopFreight ?? undefined,true)}>Close with pending work</button>
            {/if}
          {:else if choosingStop === row.definition.operationID}
            <button type="button" class="danger" disabled={disconnected || busy !== null} onclick={() => void stop(row.definition.operationID,"RETURN_HOME")}>Return home now</button>
            <button type="button" class="danger" disabled={disconnected || busy !== null} onclick={() => void stop(row.definition.operationID,"COLLECT_FREIGHT")}>Collect remaining freight, then return</button>
          {:else}
            <button type="button" class="danger" disabled={disconnected || busy !== null || !row.runtime.operationRunID} onclick={() => choosingStop = row.definition.operationID}>Stop operation</button>
          {/if}
        {/if}
      </div></div>
      {#if dockedPending.length}
        <p class="notice" role="status">{dockedPending.length} {dockedPending.length === 1 ? "pilot" : "pilots"} docked at home · Unloading incomplete</p>
      {:else}
        {#if row.runtime.stopFreight && row.runtime.state !== "STOPPED"}<p class="notice">Stop requested · {stopLabel(row.runtime.stopFreight)}</p>{/if}
        {#if row.runtime.statusReason}<p class="notice"><strong>Status:</strong> {row.runtime.statusReason}</p>{/if}
      {/if}
      {#if row.runtime.canCloseOfflineStop}
        <p class="notice">All started fleet pilots are offline. {retryClosesOffline ? "Retry Stop" : "Close with pending work"} closes this run and keeps its unconfirmed records.</p>
      {/if}
      {#if row.runtime.unverifiedStop}
        {@const saved = row.runtime.unverifiedStop}
        <p class="notice"><strong>Previous run closed with pending verification.</strong>
          {saved.unconfirmedDeliveries} delivery {saved.unconfirmedDeliveries === 1 ? "record" : "records"} and {saved.unverifiedPilots.length}
          pilot {saved.unverifiedPilots.length === 1 ? "settlement" : "settlements"} need review.</p>
      {/if}
      {#if extensionResults[row.definition.operationID]}<p class="notice" role="status">{extensionResults[row.definition.operationID]}</p>{/if}
      {#if stopResults[row.definition.operationID]}<p class="notice" role="status">{stopResults[row.definition.operationID]}</p>{/if}
      {#if stopDetails[row.definition.operationID]?.length}
        <details class="operation-details"><summary>Retry Stop details</summary><ul>
          {#each stopDetails[row.definition.operationID] as detail}<li>{detail}</li>{/each}
        </ul></details>
      {/if}
      <MiningOperationOverview runtime={row.runtime} stale={disconnected || pollError !== null} />
      {#if row.runtime.stopFreight && row.runtime.stopFailures.length > 0}<div class="error"><p>Parking or release is pending for these pilots.</p>{#each row.runtime.stopFailures as failure}<p>{row.runtime.members.find(member => member.characterID === failure.characterID)?.characterName ?? "Pilot"}: {failure.message}</p>{/each}</div>{/if}
      {#if canStart(row.runtime.state)}
        <div class="readiness">
          <p class={readiness[row.definition.operationID]?.message ? "notice" : "muted"}><strong>Start readiness:</strong> {readiness[row.definition.operationID]?.message ?? "Pilots verify equipment and supplies during startup."}</p>
          <button type="button" disabled={busy !== null || disconnected} onclick={() => {
            if (fleetDetails) fleetDetails.open = true;
            void reviewReadiness(row.definition, true);
          }}>Review member readiness</button>
        </div>
      {/if}
      <details class="operation-details" bind:this={fleetDetails}><summary>Fleet and readiness · {row.runtime.members.length} pilots</summary>
        <div class="table-wrap"><table>
          <thead><tr><th>Pilot</th><th>Role</th><th>Assignment</th><th>Bot state</th><th>Phase</th></tr></thead>
          <tbody>{#each row.runtime.members as member (member.characterID)}<tr><td>{member.characterName}</td><td>{member.role}</td><td>{modeOf(member) === "STANDARD" && row.definition.area.targetClasses.length !== 1 ? "Standard unavailable" : profileName(member, row.definition.area.targetClasses[0], row.definition.unloadPolicy)}</td><td>{member.dockedForUnload ? "Docked at home" : member.parkingState ?? member.runtimeState}</td><td>{member.phase ?? member.reason ?? "—"}{#if typeof member.pendingUnloadUnits === "number"}<br/><small>Last observed cargo · {member.pendingUnloadUnits.toLocaleString()} units</small>{/if}{#if member.reason && member.reason !== member.phase && member.phase}<br/><small>{member.reason}</small>{/if}{#if member.parkingSince && member.hosted}<br/><small>Since {new Date(member.parkingSince).toLocaleTimeString()}</small>{/if}</td></tr>{/each}</tbody>
        </table></div>
        {#if canStart(row.runtime.state)}
          <MiningPreparation preparation={readiness[row.definition.operationID]?.plan?.preparation} members={row.definition.members} planning stale={disconnected || pollError !== null} />
        {:else}
          <MiningPreparation preparation={row.runtime.preparation ? { ...row.runtime.preparation, members: row.runtime.preparation.members ?? row.runtime.members.flatMap(member => member.preparation ? [member.preparation] : []) } : undefined} members={row.definition.members} stale={disconnected || pollError !== null} />
        {/if}
      </details>
      <details class="operation-details"><summary>Settings, transport and run history</summary>
      {#if row.runtime.state === "DRAFT" && row.runtime.lastRun}
        {@const completed = row.runtime.lastRun}
        <p><strong>Last run</strong> · {completed.deliveredUnits.toLocaleString()} units delivered
          {#if completed.deliveredVolumeM3 !== null} · {completed.deliveredVolumeM3.toLocaleString(undefined, {maximumFractionDigits: 2})} m³{/if}
          {#if completed.trips !== null} · {completed.trips} delivery trips{/if}
        </p>
      {/if}
      <MiningOperationRun runtime={row.runtime} policy={runPolicy} parking={(row.definition.policies?.parking.mode ?? "STAY_IN_PLACE") !== "STAY_IN_PLACE"} stale={disconnected || pollError !== null} busy={busy !== null} onExtend={minutes => void extend(row.definition.operationID, minutes)} />
      {#if row.definition.support?.useIndustrialCore}
        {@const commandPreparation = row.runtime.preparation?.members?.find(member => member.role === "COMMAND") ??
          row.runtime.members.find(member => member.role === "COMMAND")?.preparation}
        {@const fuel = commandPreparation?.targets.find(target => target.typeID === 16272)}
        <p><strong>Heavy Water:</strong>
          {fuel ? `${fuel.current ?? "Unknown"} units at preparation · target ${fuel.target} · ${fuel.state}` : "Preparation quantity and fitting target not yet observed"}.
          {commandPreparation?.sourceLabel ? `Prepared from: ${commandPreparation.sourceLabel}.` : "Supply source not yet verified."}
        </p>
      {/if}
      <p><strong>Area:</strong> {row.definition.area.anchorSystemName ?? "Unknown system"} · {row.definition.area.reach === "CURRENT_SYSTEM" ? "current system" : "adjacent mode (anchor-only execution in v0.1)"}</p>
      <p><strong>Target class / unload:</strong> {row.definition.area.targetClasses.join(", ")} · {row.definition.unloadPolicy === "HAULER_SERVICE" ? "Hauler service" : "Self unload"}</p>
      <p><strong>Standard resources:</strong> {row.definition.policies?.resourcePolicy?.mode === "PREFER_LIST" ? row.definition.policies.resourcePolicy.typeIDs.map(id => catalog.find(resource => resource.typeID === id)?.name ?? `Type ${id}`).join(" → ") + " → any eligible" : "Any eligible"}</p>
      <p><strong>On Stop:</strong> {stopLabels[row.definition.policies?.parking.mode ?? "STAY_IN_PLACE"]}{row.definition.policies?.parking.destination ? ` · ${"kind" in row.definition.policies.parking.destination ? row.definition.policies.parking.destination.name : row.definition.policies.parking.destination.stationName}` : ""}</p>
      <p><strong>Delivery:</strong> {row.definition.unloadDestination ? `${"kind" in row.definition.unloadDestination ? row.definition.unloadDestination.name : row.definition.unloadDestination.stationName} · ${row.definition.unloadDestination.corporationDivision === null ? "Personal hangar" : `Corporation Division ${row.definition.unloadDestination.corporationDivision}`}` : row.definition.members.some((member) => modeOf(member) === "STANDARD") ? "Not configured — Standard Start blocked" : "Configured in custom routine"}</p>
      <MiningOreFreight config={row.definition.oreLogistics} runtime={row.runtime} stale={disconnected||pollError!==null} />
      {#each row.runtime.logisticsTail as tail (tail.target.targetKey)}
        <p class="notice"><strong>Logistics tail:</strong> {tail.target.targetName} is still DRAINING; {tail.pendingHaulers.length} hauler(s) remain while the main body may relocate.</p>
      {/each}
      {#if row.runtime.history.length > 0}<details><summary>Target history</summary><ul>{#each row.runtime.history as item}<li>{item.at} · {item.kind} · {item.target?.targetName ?? (item.evidence ? JSON.stringify(item.evidence) : "—")}{#if item.kind === "TARGET_SELECTION" && item.evidence}<details><summary>Locality decision</summary><pre>{JSON.stringify(item.evidence, null, 2)}</pre></details>{/if}</li>{/each}</ul></details>{/if}
      <div class="actions secondary">
        {#if row.definition.unloadPolicy === "HAULER_SERVICE" && row.runtime.state === "ACTIVE" && row.runtime.currentTarget?.state === "ACTIVE"}
          <button type="button" disabled={busy !== null || disconnected} onclick={() => void relocate(row.definition.operationID)}>Settle and select next target</button>
        {/if}
        <button type="button" class="danger" disabled={busy !== null || disconnected} onclick={() => void remove(row.definition.operationID)}>Delete operation</button>
      </div>
      </details>
    </article>
    {/key}
  {/if}

  <details class="board center-panel">
    <summary>Global target board · {payload?.targetBoard.length ?? 0} targets</summary>
    {#if (payload?.targetBoard.length ?? 0) === 0}<p class="empty">No targets observed yet.</p>{/if}
    {#if (payload?.targetBoard.length ?? 0) > 0}
      <table>
        <thead><tr><th>Target</th><th>Type</th><th>System</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>
          {#each payload?.targetBoard ?? [] as target (target.targetKey)}
            <tr>
              <td>{target.targetName}</td><td>{target.targetType}</td><td>{target.systemName ?? target.systemID}</td><td>{target.state}</td>
              <td>
                {#if target.state === "DANGEROUS"}
                  <button type="button" disabled={disconnected || busy !== null} onclick={() => updateTargetBoard(target.targetKey, markMiningBeltSafe)}>Mark safe</button>
                {:else if target.targetType === "BELT" && target.state === "DEPLETED"}
                  <button type="button" disabled={disconnected || busy !== null} onclick={() => updateTargetBoard(target.targetKey, resetDepletedMiningBelt)}>Reset depleted</button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </details>
</section>

<style>
  .operations { padding: 0; min-width: 0; background: transparent; border: 0; }
  .operations::before { content: none; }
  header, .title-row, .actions, .launch-settings, .readiness { display: flex; flex-wrap: wrap; gap: .55rem; align-items: center; }
  header, .title-row, .readiness { justify-content: space-between; }
  .readiness { margin: .8rem 0; }
  .readiness p, .title-row h3 { margin: 0 0 .3rem; }
  h2, h3, h4, p { margin: .25rem 0 .65rem; }
  .muted, .note { color: #93a9b5; }
  .editor, .operation-card, .board { margin: .8rem 0; }
  label { display: flex; gap: .45rem; align-items: center; margin: .4rem 0; }
  label > input:not([type="checkbox"]):not([type="radio"]), label > select { flex: 1; }
  table { width: 100%; border-collapse: collapse; margin-top: .55rem; }
  th, td { border-bottom: 1px solid #263943; text-align: left; padding: .45rem; vertical-align: top; }
  th { color: #8fb4c7; font-weight: 600; }
  .operation-details { border-top: 1px solid #2a3e4b; padding-block: .7rem; }
  .operation-details summary, .board summary { cursor: pointer; font-weight: 650; }
  .table-wrap { overflow-x: auto; }
  .secondary { margin-top: .8rem; }
  .notice { display: block; border-left: 3px solid #d4a84d; padding-left: .55rem; overflow-wrap: anywhere; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  .error { color: #ff9e9e; }
  .empty { color: #8195a0; font-style: italic; }
  @media (max-width: 700px) { header, .title-row { align-items: flex-start; flex-direction: column; } table { font-size: .85rem; } }

  .editor.center-panel {
    --editor-inset: clamp(.7rem, 2.5%, 1.15rem);
    --fleet-columns: minmax(0, 1fr) minmax(6.5rem, .85fr) minmax(0, 1.3fr) minmax(0, 1.1fr) 4.7rem;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr) auto;
    max-inline-size: 68rem;
    max-block-size: min(43rem, calc(100dvh - 1rem));
    margin-inline: auto;
    padding: 0;
    scroll-margin-block-start: .5rem;
    overflow: hidden;
    container: operation-editor / inline-size;
  }
  .editor-heading, .editor-footer, .editor-tools, .editor-choices, .editor-summary {
    display: flex; align-items: center; flex-wrap: wrap; gap: .45rem .75rem;
  }
  .editor-heading, .editor-footer { justify-content: space-between; padding: .7rem var(--editor-inset); }
  .editor-heading h3 { margin: 0; font-size: 1.2rem; overflow-wrap: anywhere; }
  .editor-heading p, .editor-footer p { margin: 0; }
  .editor-heading p, .editor-summary, .editor small { color: var(--center-muted, #afc1cf); font-size: .85rem; }
  .editor .editor-tabs { margin: 0; padding-inline: var(--editor-inset); }
  .editor-tabs [aria-selected="true"] { color: #bbf5ee; background: #142935; border-bottom-color: #88dcd8; }
  .editor-content { min-block-size: 0; overflow: auto; scrollbar-gutter: stable; }
  .editor-pane { display: grid; gap: .7rem; padding: .8rem var(--editor-inset); }
  .editor-pane[hidden] { display: none; }
  .editor-footer { border-top: 1px solid var(--center-border, #2a3e4b); }
  .editor-footer .actions { margin-inline-start: auto; }
  .editor-footer p { flex: 1 1 18rem; overflow-wrap: anywhere; }
  .editor-fields, .editor-destinations {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: .65rem .85rem;
  }
  .editor label { display: grid; gap: .28rem; min-width: 0; margin: 0; color: #c9d7e0; font-size: .88rem; }
  .editor label > :is(select, input:not([type="radio"], [type="checkbox"])) { min-width: 0; width: 100%; }
  .editor .editor-check { display: flex; align-items: center; gap: .45rem; min-block-size: 1.85rem; }
  .editor-check input { flex: none; inline-size: 1rem; block-size: 1rem; margin: 0; accent-color: var(--center-accent, #9ae4de); }
  .editor .note, .editor .muted { color: var(--center-muted, #afc1cf); }
  .editor :is(.note, .notice, .error, .logistics-mode) { margin: .3rem 0; font-size: .85rem; }
  .logistics-mode { color: var(--center-accent, #9ae4de); }
  .logistics-mode small { display: block; margin-top: .2rem; }
  .editor-group, .system-options, .fleet-group {
    min-width: 0; margin: 0; padding: .55rem .7rem; border: 1px solid var(--center-border, #2a3e4b); border-radius: .5rem; background: #0d1820;
  }
  fieldset.editor-group > :is(label, .editor-choices, .system-matches) + :is(label, .editor-choices, .system-matches) { margin-top: .5rem; }
  .editor-group > :is(.editor-check, .quiet) { margin-block: .4rem; }
  .editor details[open] > summary { margin-bottom: .45rem; }
  .system-options { align-self: end; }
  .system-matches { display: flex; flex-wrap: wrap; gap: .3rem; margin-top: .35rem; }
  .system-matches button { max-inline-size: 100%; overflow-wrap: anywhere; }
  .resource-order { display: grid; gap: .3rem; padding-inline-start: 1.5rem; }
  .resource-order li > span { margin-inline-end: .4rem; }
  .resource-order button + button { margin-inline-start: .25rem; }
  .editor-tools select { max-width: 100%; }
  .fleet-group h4 { margin: 0 0 .3rem; font-size: .96rem; }
  .fleet-group h4 span { color: var(--center-accent, #9ae4de); margin-inline-start: .25rem; }
  .fleet-row, .fleet-columns { display: grid; grid-template-columns: var(--fleet-columns); align-items: center; gap: .45rem; min-width: 0; }
  .fleet-columns { padding: .2rem 0; color: var(--center-muted, #afc1cf); font-size: .8rem; }
  .fleet-entry { padding-block: .28rem; border-top: 1px solid var(--center-border, #2a3e4b); }
  .fleet-row :is(select, button) { min-width: 0; min-height: 2rem; padding: .25rem .45rem; font-size: .85rem; }
  .fleet-row :is(.fleet-pilot, .fleet-routine, .fleet-fitting) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fleet-row .fleet-fitting { text-align: left; }
  .fleet-row .fleet-fitting[aria-expanded="true"] { border-color: #79cdd5; }
  .fleet-routine { font-size: .84rem; color: var(--center-muted, #afc1cf); }
  .fit-details { margin-block-start: .45rem; padding: .55rem .65rem; border: 1px solid var(--center-border, #2a3e4b); border-radius: .4rem; }
  .supply-fields { margin: .4rem 0 0; border: 0; padding: 0; }
  .supply-fields button { margin-block-start: .5rem; }
  @container operation-editor (max-width: 42rem) {
    .editor-destinations { grid-template-columns: 1fr; }
    .fleet-columns { display: none; }
    .fleet-row {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
      grid-template-areas: "pilot pilot remove" "role routine routine" "fitting fitting fitting";
    }
    .fleet-pilot { grid-area: pilot; }
    .fleet-role { grid-area: role; }
    .fleet-routine { grid-area: routine; }
    .fleet-fitting { grid-area: fitting; }
    .fleet-remove { grid-area: remove; }
  }
  @container operation-editor (max-width: 28rem) {
    .editor-fields { grid-template-columns: 1fr; }
    .editor-tabs { gap: .15rem; }
    .editor-tabs button { flex: 1 1 auto; justify-content: center; padding-inline: .45rem; }
  }
</style>
