<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { createControlPlanePoll } from "../app/controlPlanePoll.ts";
  import { hostedDurationLabel } from "../bots/hostedRunPolicy.ts";
  import MiningOperationRun from "./MiningOperationRun.svelte";
  import MiningPreparation from "./MiningPreparation.svelte";
  import { miningPreparationDraft, miningPreparationConfig, type MiningPreparationOptions } from "../app/miningPreparation.ts";
  import {
    deleteMiningOperation,
    extendMiningOperation,
    listMiningResources,
    type MiningResourceChoice,
    findMapLocations,
    findAccessibleStructures,
    listDockableAccessPilots,
    getMiningOperationLaunchPlan,
    getMiningPreparationOptions,
    listOperationAccountPilots,
    listOperationRoutines,
    loadMiningOperations,
    resolveDestination,
    resolveAccessibleStructure,
    readAccessibleStructureServices,
    saveMiningOperation,
    startMiningOperation,
    stopMiningOperation,
    type OperationPilotChoice,
    type OperationRoutineSummary,
    type MiningOperationDefinition,
    type MiningOperationMemberDefinition,
    type MiningOperationsPayload,
    type MiningOperationLaunchPlan,
  } from "../app/api.ts";
  import { loadHangarPrefs } from "../app/hangarPrefs.ts";
  import { loadKnownCharacters } from "../app/knownCharacters.ts";
  import { decodeScriptValue } from "../bots/scriptCodec.ts";
  import { analyzeBotRunPolicy, createBotLaunchGrant } from "../bots/runPolicy.ts";
  const opts = () => ({});
  let { reconnectVersion = 0, onAuthExpired = () => {} }: { reconnectVersion?: number; onAuthExpired?: () => void } = $props();
  let disconnected = $state(false);
  let catalog = $state<readonly MiningResourceChoice[]>([]);
  let resourceMode = $state<"ANY_ELIGIBLE" | "PREFER_LIST">("ANY_ELIGIBLE");
  let resourceIDs = $state<number[]>([]);
  let resourceQuery = $state("");
  let extensionResults = $state<Record<string, string>>({});
  let payload = $state<MiningOperationsPayload | null>(null);
  const runPolicy = $derived(payload?.capabilities.hostedRunPolicy ?? null);
  let scripts = $state<OperationRoutineSummary[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let pollError = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let editing = $state(false);
  let editor: HTMLFormElement | undefined = $state();
  async function revealEditor(): Promise<void> {
    await tick();
    editor?.scrollIntoView({ block: "start", behavior: "smooth" });
    editor?.querySelector<HTMLInputElement>('input[name="operationName"]')?.focus({ preventScroll: true });
  }
  let runtimeMinutes = $state(12 * 60);
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
  let name = $state("");
  let anchorSystemID = $state(0);
  let anchorSystemName = $state("");
  let anchorError = $state<string | null>(null);
  let systemMatches = $state<readonly { id: number; name: string }[]>([]);
  let systemLookupSerial = 0;
  let reach = $state<"CURRENT_SYSTEM" | "CURRENT_AND_ADJACENT">("CURRENT_SYSTEM");
  let targetFamily = $state<"BELT" | "ORE_ANOMALY" | "ICE" | "GAS">("BELT");
  let unloadPolicy = $state<"HAULER_SERVICE" | "SELF_UNLOAD">("HAULER_SERVICE");
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
  let travelAssist = $state(true);
  let parkingStation = $state<Parking["destination"]>(null);
  let parkingQuery = $state("");
  let parkingDivision = $state<number | null>(null);
  let parkingCorporationID = $state(0);
  let parkingError = $state<string | null>(null);
  let parkingWarning = $state<string | null>(null);
  let dockableAccessPilots = $state<readonly { characterID: number; characterName: string }[]>([]);
  let dockableAccessPilotID = $state(0);
  let parkingMatches = $state<NonNullable<Parking["destination"]>[]>([]);
  let parkingLookupSerial = 0;
  const parkingName = (destination: NonNullable<Parking["destination"]>) => "kind" in destination && destination.kind === "structure" ? destination.name : (destination as { stationName: string }).stationName;
  const parkingID = (destination: NonNullable<Parking["destination"]>) => "kind" in destination && destination.kind === "structure" ? destination.id : (destination as { stationID: number }).stationID;
  const parkingSystemName = (destination: NonNullable<Parking["destination"]>) => "kind" in destination && destination.kind === "structure" ? destination.solarSystemName : (destination as { systemName: string }).systemName;
  const stopLabels: Record<Parking["mode"], string> = { STAY_IN_PLACE: "Stay in place", RETURN_HOME_DOCK: "Return home and dock", RETURN_HOME_UNLOAD_DOCK: "Return home, unload and dock" };
  let members = $state<DraftMember[]>([]);
  const defaultSupport = () => ({ fleetPolicy: "EXISTING_ONLY", maintainBursts: true, useIndustrialCore: false,
    coreRequirement: "continueWithoutCore", enableCompression: false, selfMining: false, tractor: false,
    collection: "TRACTOR_ONLY", compressCollectedOre: false, supportLoss: "PAUSE" } as Omit<NonNullable<MiningOperationDefinition["support"]>, "version" | "characterID">);
  let support = $state(defaultSupport());
  const commands = $derived(members.filter(member => member.role === "COMMAND"));
  const commonProviders = $derived(roster.filter(pilot => members.length > 0 && members.every(member => member.accountName === pilot.accountName)));
  let seedSquadID = $state("");
  let accountLookup = $state("");
  let roster = $state<OperationPilotChoice[]>(loadKnownCharacters().map(({ accountName, characterID, characterName }) => ({ accountName, characterID, characterName })));

  const prefs = $derived(loadHangarPrefs());
  const selectedClasses = $derived([targetFamily]);
  const anchorValid = $derived(anchorSystemID > 0 && anchorSystemName.length > 0 && anchorError === null);
  const standardAvailable = $derived(targetFamily !== "GAS");
  const resourceMatches = $derived(catalog.filter(row => row.family === (targetFamily === "ICE" ? "ice" : "ore") &&
    !resourceIDs.includes(row.typeID) && row.name.toLocaleLowerCase().includes(resourceQuery.toLocaleLowerCase())).slice(0, 15));

  function modeOf(member: DraftMember): "STANDARD" | "CUSTOM" { return member.routineMode ?? (member.automationID ? "CUSTOM" : "STANDARD"); }
  function profileName(member: DraftMember, family: string = targetFamily, policy: string = unloadPolicy): string {
    if (member.role === "COMMAND") return "Mining Command / Support · v1";
    if (modeOf(member) === "CUSTOM") return scripts.find((script) => script.scriptID === member.automationID)?.name ?? "Custom routine";
    const label = family === "BELT" ? "Belt" : family === "ORE_ANOMALY" ? "Ore Anomaly" : family === "ICE" ? "Ice" : null;
    if (member.role === "DEFENDER") return label ? "Standard Defender · v1" : "No Standard Defender profile for this class";
    if (policy === "SELF_UNLOAD") return label && member.role === "MINER" ? `${label} Miner / Self Unload · v1` : "No Standard Self-Unload profile for this role";
    return label === null ? "Not yet executable" : member.role === "MINER" ? `${label} Miner / Hauler Service · v${family === "BELT" ? 2 : 1}` : `${label} Hauler · v1`;
  }

  function words(cause: unknown): string {
    return cause instanceof Error ? cause.message : "The Mining Operations request failed.";
  }

  function definitionKey(member: DraftMember, provider: number): string { return JSON.stringify([member.accountName, member.characterID, provider || member.characterID]); }
  function providerFor(member: DraftMember): number { return member.preparation?.providerCharacterID ?? preparation.providerCharacterID; }
  function optionsFor(member: DraftMember): MiningPreparationOptions | undefined { return definitionOptions[definitionKey(member, providerFor(member))]; }
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
    const first = members.find(member => member.role !== "DEFENDER");
    if (first && providerFor(first) !== preparation.providerCharacterID) void readDefinitions(first, preparation.providerCharacterID);
  }
  function setCommonProvider(provider: number): void {
    preparation.providerCharacterID = provider; preparation.fittingID = 0; refreshDefinitions();
  }
  function setMemberProvider(member: DraftMember, provider: number): void {
    patchMember(member.characterID, { preparation: { ...(provider ? { providerCharacterID: provider } : {}) } });
    void readDefinitions(member, provider || preparation.providerCharacterID);
  }
  async function reviewReadiness(definition: MiningOperationDefinition & { operationID: string }): Promise<void> {
    const key = JSON.stringify(definition), id = definition.operationID;
    readiness[id] = { key, message: "Checking start readiness…" };
    try {
      const plan = await getMiningOperationLaunchPlan(id, opts());
      if (mounted && readiness[id]?.key === key && payload?.operations.some(row => row.definition.operationID === id && JSON.stringify(row.definition) === key && ["DRAFT", "STOPPED"].includes(row.runtime.state)))
        readiness[id] = { key, message: plan.warnings.join(" ") || null, plan };
    } catch (cause) { if (mounted && readiness[id]?.key === key) readiness[id] = { key, message: words(cause) }; }
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
        const key = JSON.stringify(row.definition);
        if (readiness[row.definition.operationID]?.key === key) continue;
        void reviewReadiness(row.definition);
      }
  }
  const poll = createControlPlanePoll({ read: () => loadMiningOperations(opts()), received,
    failed: (cause, authLost) => {
      loading = false; disconnected = authLost;
      pollError = authLost ? "Control plane disconnected. Last known fleet state retained; sign in above to reconnect. Hosted operations are unaffected." : words(cause);
      if (authLost) onAuthExpired();
    },
  });
  const refresh = () => poll.refresh();

  onMount(() => {
    void refresh();
    void listDockableAccessPilots(opts()).then((pilots) => {
      dockableAccessPilots = pilots;
      if (!pilots.some((pilot) => pilot.characterID === dockableAccessPilotID)) dockableAccessPilotID = pilots[0]?.characterID ?? 0;
    }).catch(() => { dockableAccessPilots = []; dockableAccessPilotID = 0; });
    return () => poll.stop();
  });

  $effect(() => {
    if (reconnectVersion > 0) void poll.reconnect();
    void listMiningResources(opts()).then(rows => { catalog = rows; }).catch(() => {});
  });

  $effect(() => {
    const classes = selectedClasses;
    const policy = unloadPolicy;
    if (classes.length === 0 || disconnected) return;
    void listOperationRoutines(classes, policy, opts()).then((rows) => { scripts = rows; }).catch((cause) => { error = words(cause); });
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

  async function loadAccount(): Promise<void> {
    try {
      const pilots = await listOperationAccountPilots(accountLookup.trim(), opts());
      roster = [...roster.filter((row) => row.accountName !== accountLookup.trim()), ...pilots];
      error = null;
    } catch (cause) { error = words(cause); }
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
      if (dockableAccessPilotID) {
        try { structures = await findAccessibleStructures(value.trim(), opts(), dockableAccessPilotID); }
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
      if (!dockableAccessPilotID || !station.solarSystemID) {
        destinationError = "Choose an account pilot to check this structure.";
        return;
      }
      try {
        const structure = await resolveAccessibleStructure(station.id, opts(), dockableAccessPilotID);
        const services = await readAccessibleStructureServices(station.id, opts(), dockableAccessPilotID);
        if (serial !== stationLookupSerial) return;
        if (!services.includes(3)) throw new Error("Corporation office service is unavailable at this structure.");
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

  function chooseParking(station: NonNullable<Parking["destination"]>): void {
    ++parkingLookupSerial;
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
          chooseParking({ stationID: Number(value), stationName: resolved.stationName, systemName: resolved.systemName });
        } else if (resolved.kind === "structure") {
          const structure = await resolveAccessibleStructure(Number(value), opts(), dockableAccessPilotID || undefined);
          if (serial !== parkingLookupSerial) return;
          chooseParking(structure);
        }
        return;
      }
      const found = await findMapLocations(value.trim(), "station", opts());
      let structures: Awaited<ReturnType<typeof findAccessibleStructures>> = [];
      if (dockableAccessPilotID) {
        try { structures = await findAccessibleStructures(value.trim(), opts(), dockableAccessPilotID); }
        catch { parkingWarning = "Accessible structure search is unavailable; NPC stations remain available."; }
      } else parkingWarning = "Choose an account pilot to search accessible structures; NPC stations remain available.";
      if (serial !== parkingLookupSerial) return;
      parkingMatches = [
        ...found.matches.filter(row => row.kind === "station").map(row => ({ stationID: row.id, stationName: row.name, systemName: row.solarSystemName ?? "" })),
        ...structures.map(row => ({ kind: "structure" as const, id: row.id, name: row.name,
          solarSystemID: row.solarSystemID ?? 0, solarSystemName: row.solarSystemName })),
      ];
      const exact = parkingMatches.find(row => parkingName(row).toLowerCase() === value.trim().toLowerCase());
      if (exact) chooseParking(exact);
    } catch (cause) { if (serial === parkingLookupSerial) parkingError = words(cause); }
  }

  function newOperation(): void {
    editorGeneration++; preparation = miningPreparationDraft(); definitionOptions = {}; definitionErrors = {}; definitionBusy = {};
    operationID = undefined;
    name = "";
    anchorSystemID = 0;
    anchorSystemName = "";
    anchorError = "Select a known solar system.";
    reach = "CURRENT_SYSTEM";
    targetFamily = "BELT";
    travelAssist = true;
    resourceMode = "ANY_ELIGIBLE"; resourceIDs = []; resourceQuery = "";
    unloadPolicy = "HAULER_SERVICE";
    unloadStationID = 0;
    unloadStructure = null;
    unloadStationName = "";
    unloadStationSystemName = "";
    unloadDivision = null;
    unloadCorporationID = 0;
    destinationError = null;
    members = [];
    support = defaultSupport();
    stopMode = "STAY_IN_PLACE";
    parkingStation = null;
    parkingQuery = "";
    parkingDivision = null;
    parkingCorporationID = 0;
    parkingError = null;
    parkingMatches = [];
    ++parkingLookupSerial;
    seedSquadID = "";
    editing = true;
    void revealEditor();
  }

  function editOperation(definition: MiningOperationDefinition): void {
    editorGeneration++; preparation = miningPreparationDraft(definition.preparation); definitionOptions = {}; definitionErrors = {}; definitionBusy = {};
    operationID = definition.operationID;
    name = definition.name;
    anchorSystemID = definition.area.anchorSystemID;
    anchorSystemName = definition.area.anchorSystemName ?? "";
    anchorError = anchorSystemName ? null : "Resolve this solar system before saving.";
    reach = definition.area.reach;
    targetFamily = definition.area.targetClasses[0] ?? "BELT";
    travelAssist = definition.policies?.travelAssist?.mode === "AUTO";
    resourceMode = definition.policies?.resourcePolicy?.mode ?? "ANY_ELIGIBLE";
    resourceIDs = [...definition.policies?.resourcePolicy?.typeIDs ?? []]; resourceQuery = "";
    unloadPolicy = definition.unloadPolicy;
    unloadStructure = definition.unloadDestination?.kind === "structure" ? definition.unloadDestination : null;
    unloadStationID = definition.unloadDestination && !("kind" in definition.unloadDestination) ? definition.unloadDestination.stationID : 0;
    unloadStationName = unloadStructure?.name ?? (definition.unloadDestination && !("kind" in definition.unloadDestination) ? definition.unloadDestination.stationName : "");
    unloadStationSystemName = unloadStructure?.solarSystemName ?? (definition.unloadDestination && !("kind" in definition.unloadDestination) ? definition.unloadDestination.systemName ?? "" : "");
    unloadDivision = definition.unloadDestination?.corporationDivision ?? null;
    unloadCorporationID = definition.unloadDestination?.corporationID ?? 0;
    destinationError = null;
    members = definition.members.map((member) => ({ ...member, routineMode: modeOf(member) }));
    support = definition.support ? { ...definition.support } : defaultSupport();
    stopMode = definition.policies?.parking.mode ?? "STAY_IN_PLACE";
    parkingStation = definition.policies?.parking.destination ?? null;
    parkingQuery = parkingStation ? parkingName(parkingStation) : "";
    parkingDivision = definition.policies?.parking.corporationDivision ?? null;
    parkingCorporationID = definition.policies?.parking.corporationID ?? 0;
    parkingError = null;
    parkingMatches = [];
    ++parkingLookupSerial;
    editing = true;
    void revealEditor();
    refreshDefinitions();
  }

  function addPilot(characterID: number): void {
    if (members.some((member) => member.characterID === characterID)) return;
    const pilot = roster.find((row) => row.characterID === characterID);
    if (!pilot) return;
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

  function seedGroup(): void {
    for (const characterID of prefs.members[seedSquadID] ?? []) addPilot(characterID);
  }

  async function save(): Promise<void> {
    if (disconnected) return;
    if (!anchorValid) { error = anchorError ?? "Choose a known solar system."; return; }
    if (commands.length > 1) { error = "Choose exactly one Command / Support pilot."; return; }
    if (stopMode !== "STAY_IN_PLACE" && (!parkingStation || parkingError)) { error = parkingError || "Choose a parking destination."; return; }
    busy = "save";
    error = null;
    try {
      const preparationConfig = miningPreparationConfig(preparation);
      payload = await saveMiningOperation({
        ...(operationID ? { operationID } : {}),
        name,
        area: {
          anchorSystemID,
          anchorSystemName: anchorSystemName.trim() || null,
          reach,
          targetClasses: selectedClasses,
        },
        targetPolicy: "ANY_ELIGIBLE",
        policies: { version: 1, resourcePolicy: { mode: resourceMode, source: "MANUAL", typeIDs: resourceMode === "PREFER_LIST" ? resourceIDs : [] }, travelAssist: { mode: travelAssist ? "AUTO" : "DISABLED" }, parking: { mode: stopMode, destination: stopMode === "STAY_IN_PLACE" ? null : parkingStation, corporationDivision: parkingDivision, corporationID: parkingDivision === null ? null : parkingCorporationID } },
        unloadPolicy,
        unloadDestination: destinationError === null && unloadStructure
          ? { ...unloadStructure, corporationDivision: unloadDivision, corporationID: unloadDivision === null ? null : unloadCorporationID }
          : unloadStationID > 0 && destinationError === null
            ? { stationID: unloadStationID, stationName: unloadStationName, systemName: unloadStationSystemName, corporationDivision: unloadDivision, corporationID: unloadDivision === null ? null : unloadCorporationID }
            : null,
        members,
        preparation: preparationConfig,
        ...(commands.length === 1 ? { support: { ...support, version: 1, characterID: commands[0]!.characterID } } : {}),
      }, opts());
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
    busy = definition.operationID;
    error = null;
    try {
      const grants: Record<string, ReturnType<typeof createBotLaunchGrant>> = {};
      const plan = await getMiningOperationLaunchPlan(definition.operationID, opts());
      if (!mounted) return;
      readiness[definition.operationID] = { key: JSON.stringify(definition), message: plan.warnings.join(" ") || null, plan };
      await tick();
      if (plan.preparation?.state !== "READY") throw new Error("Member preparation is blocked or unknown. Resolve the listed equipment, supplies or source reasons and review again.");
      for (const member of plan.members) {
        const decoded = decodeScriptValue(member.script.doc);
        if (!decoded.ok) throw new Error(`${member.script.name} is invalid: ${decoded.refusal}`);
        grants[String(member.characterID)] = createBotLaunchGrant(member.script.rev, analyzeBotRunPolicy(decoded.doc), runtimeMinutes);
      }
      const hours = runtimeMinutes / 60;
      const preparationSummary = plan.preparation?.members?.map(member => `${definition.members.find(row => row.characterID === member.characterID)?.characterName ?? "Member"}: equipment ${member.equipment}, supplies ${member.supplies}, ${member.state}${member.reason ? ` — ${member.reason}` : ""}`) ?? [];
      const messages = [...plan.warnings, ...preparationSummary];
      const warning = messages.length ? `\n\n${messages.join("\n")}` : "";
      if (!window.confirm(`Start “${definition.name}” for ${definition.members.length} members, with a ${hours}-hour server-hosted limit?${warning}`)) return;
      payload = await startMiningOperation(definition.operationID, grants, plan.planHash, opts());
    } catch (cause) {
      error = words(cause);
    } finally {
      busy = null;
    }
  }

  async function stop(operationID: string): Promise<void> {
    if (disconnected) return;
    busy = operationID;
    error = null;
    try {
      payload = await stopMiningOperation(operationID, opts());
    } catch (cause) {
      error = words(cause);
      await refresh();
    } finally {
      busy = null;
    }
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

  async function remove(operationID: string): Promise<void> {
    if (disconnected) return;
    if (!window.confirm("Delete this stopped Mining Operation definition?")) return;
    busy = operationID;
    try {
      payload = await deleteMiningOperation(operationID, opts());
    } catch (cause) {
      error = words(cause);
    } finally {
      busy = null;
    }
  }
</script>

<section class="operations">
  <header>
    <div>
      <h2>Mining Operations</h2>
      <p>One operation is one jointly moving industrial fleet with one current target.</p>
    </div>
    <div class="launch-settings">
      <label>Run limit
        <select bind:value={runtimeMinutes} aria-label="Operation run limit" disabled={!runPolicy}>
          {#each runPolicy?.durationChoices ?? [] as minutes}<option value={minutes}>{hostedDurationLabel(minutes)}</option>{/each}
        </select>
      </label>
      <button type="button" onclick={newOperation}>+ New operation</button>
    </div>
  </header>

  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if pollError}<p class="error" role="alert">{pollError}</p>{/if}
  {#if loading}<p class="muted">Loading Mining Command Center…</p>{/if}

  {#if editing}
    <form class="editor" bind:this={editor} onsubmit={(event) => { event.preventDefault(); void save(); }}>
      <h3>{operationID ? `Editing ${name}` : "New operation"}</h3>
      <label>Name <input name="operationName" required bind:value={name} /></label>
      <div class="grid2">
        <label>Anchor system <input required value={anchorSystemName} oninput={(event) => void searchSystem(event.currentTarget.value)} placeholder="Search solar systems" autocomplete="off" /></label>
        <label>Anchor system ID <input required type="number" min="1" value={anchorSystemID || ""} oninput={(event) => void resolveSystemID(event.currentTarget.value)} /></label>
      </div>
      {#if systemMatches.length > 0}<div class="system-matches" role="listbox" aria-label="Matching solar systems">
        {#each systemMatches as system (system.id)}<button type="button" role="option" aria-selected="false" onclick={() => chooseSystem(system)}>{system.name} · {system.id}</button>{/each}
      </div>{/if}
      {#if anchorError}<p class="error" role="status">{anchorError}</p>{/if}
      <label>Reach
        <select bind:value={reach}>
          <option value="CURRENT_SYSTEM">Current system</option>
          <option value="CURRENT_AND_ADJACENT">Current and adjacent — dynamic discovery deferred</option>
        </select>
      </label>
      <fieldset>
        <legend>Target family</legend>
        <label><input type="radio" bind:group={targetFamily} value="BELT" /> Asteroid Belt</label>
        <label><input type="radio" bind:group={targetFamily} value="ORE_ANOMALY" /> Ore Anomaly</label>
        <label><input type="radio" bind:group={targetFamily} value="ICE" /> Ice — online Ice Harvesters required</label>
        <label class="disabled"><input type="checkbox" disabled /> Gas — not supported yet</label>
      </fieldset>
      <fieldset>
        <legend>Unload</legend>
        <label><input type="radio" bind:group={unloadPolicy} value="HAULER_SERVICE" /> Hauler service</label>
        <label><input type="radio" bind:group={unloadPolicy} value="SELF_UNLOAD" /> Self unload</label>
      </fieldset>
        <div class="destination">
          <h4>{unloadPolicy === "SELF_UNLOAD" ? "Miner delivery destination" : "Hauler delivery destination"}</h4>
          <p class="muted">Choose a personal hangar or an exact corporation division. Corporation delivery requires an accessible office; it never falls back to personal hangar.</p>
          <label>Check structure access as pilot <select bind:value={dockableAccessPilotID} onchange={() => { ++stationLookupSerial; ++parkingLookupSerial; stationMatches = []; parkingMatches = []; unloadStructure = null; destinationError = unloadStationID > 0 ? null : "Choose a delivery destination."; }}>
            <option value={0}>NPC station search only</option>
            {#each dockableAccessPilots as pilot}<option value={pilot.characterID}>{pilot.characterName}</option>{/each}
          </select></label>
          <label>Unload destination <input value={unloadStationName} oninput={(event) => void searchStation(event.currentTarget.value)} placeholder="Search station or accessible structure" autocomplete="off" /></label>
          {#if stationMatches.length > 0}<div class="system-matches" role="listbox" aria-label="Matching delivery destinations">
            {#each stationMatches as station (station.id)}<button type="button" role="option" aria-selected="false" onclick={() => void chooseStation(station)}>{station.name} · {station.systemName} · {station.kind === "structure" ? "Upwell Structure" : "NPC Station"}</button>{/each}
          </div>{/if}
          {#if unloadStationID > 0 || unloadStructure}<p class="muted">{unloadStructure ? "Structure" : "Station"} {unloadStructure?.id ?? unloadStationID} · {unloadStationSystemName}</p>{/if}
          {#if destinationError}<p class="error" role="status">{destinationError}</p>{/if}
          <label>Delivery hangar <select bind:value={unloadDivision}><option value={null}>Personal hangar</option>{#each [1, 2, 3, 4, 5, 6, 7] as division}<option value={division}>Corporation division {division}</option>{/each}</select></label>
          {#if unloadDivision !== null}<label>Destination corporation ID <input type="number" min="1" required bind:value={unloadCorporationID} /></label>{/if}
        </div>

      <fieldset>
        <legend>On manual Stop / Fleet Parking</legend>
        <label>Policy <select bind:value={stopMode}>{#each Object.entries(stopLabels) as [mode, label]}<option value={mode}>{label}</option>{/each}</select></label>
        {#if stopMode !== "STAY_IN_PLACE"}
          <label>Parking destination <input required value={parkingQuery} oninput={(event) => void searchParking(event.currentTarget.value)} placeholder="Search station or accessible structure" autocomplete="off" /></label>
          {#if parkingMatches.length > 0}<div class="system-matches" role="listbox" aria-label="Matching parking stations">
            {#each parkingMatches as station (parkingID(station))}<button type="button" role="option" aria-selected="false" onclick={() => chooseParking(station)}>{parkingName(station)} · {parkingSystemName(station)} · {"kind" in station && station.kind === "structure" ? "Upwell Structure" : "NPC Station"}</button>{/each}
          </div>{/if}
          {#if (unloadStationID > 0 || unloadStructure) && !destinationError}<button type="button" onclick={() => chooseParking(unloadStructure ?? { stationID: unloadStationID, stationName: unloadStationName, systemName: unloadStationSystemName })}>Use delivery destination as parking destination</button>{/if}
          {#if parkingStation}<p class="muted">{parkingName(parkingStation)} · {parkingSystemName(parkingStation)} · {"kind" in parkingStation && parkingStation.kind === "structure" ? "Upwell Structure" : "NPC Station"}</p>{/if}
          {#if parkingError}<p class="error" role="status">{parkingError}</p>{/if}
          {#if parkingWarning}<p class="note" role="status">{parkingWarning}</p>{/if}
          {#if stopMode === "RETURN_HOME_UNLOAD_DOCK"}
            <label>Freight destination <select bind:value={parkingDivision}><option value={null}>Personal hangar</option>{#each [1, 2, 3, 4, 5, 6, 7] as division}<option value={division}>Corporation Division {division}</option>{/each}</select></label>
            {#if parkingDivision !== null}<label>Parking corporation ID <input type="number" min="1" required bind:value={parkingCorporationID} /></label>{/if}
            <p class="note">Uses existing ore-delivery freight rules: mining holds, or cargo fallback on ships without mining holds. Not an empty-every-bay action.</p>
            {#if parkingStation && "kind" in parkingStation && parkingStation.kind === "structure" && parkingDivision !== null}<p class="note">Corporation-division parking is strict at structures. An unavailable office or unconfirmed transfer blocks clean parking.</p>{/if}
          {/if}
          <p class="note">Stop early enough to park within the remaining run grant. Timed expiry keeps existing graceful cleanup; it does not schedule a return trip. Cans in space may be left behind. An unavailable member reports failure; healthy members can still park.</p>
        {:else}<p class="note">Existing graceful Stop: recall drones and release control without deliberately moving or docking.</p>{/if}
      </fieldset>
      <fieldset>
        <legend>Resources — Standard miners</legend>
        <select aria-label="Resource preference" bind:value={resourceMode}><option value="ANY_ELIGIBLE">Any eligible</option><option value="PREFER_LIST">Prefer ordered list</option></select>
        {#if resourceMode === "PREFER_LIST"}
          {#if catalog.length === 0}<p class="notice">Resource catalog unavailable. Any eligible remains available; no resource names are guessed.</p>{/if}
          <input aria-label="Search resource catalog" bind:value={resourceQuery} placeholder="Search resource types" />
          <div class="system-matches">{#each resourceMatches as resource}<button type="button" disabled={resourceIDs.length >= 20} onclick={() => { resourceIDs = [...resourceIDs, resource.typeID]; resourceQuery = ""; }}>{resource.name}</button>{/each}</div>
          <ol>{#each resourceIDs as id, index}<li>{catalog.find(row => row.typeID === id)?.name ?? `Type ${id}`}
            <button type="button" disabled={index === 0} onclick={() => { const next = [...resourceIDs]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; resourceIDs = next; }}>↑</button>
            <button type="button" onclick={() => { resourceIDs = resourceIDs.filter(value => value !== id); }}>Remove</button></li>{/each}</ol>
          <p class="muted">Preference applies to observed resources within the assigned target, with same-family fallback. Remote contents are unknown. Custom routines keep their own strict compatibility contract.</p>
        {/if}
      </fieldset>

      {#if prefs.squads.length > 0}
        <div class="seed">
          <select bind:value={seedSquadID} aria-label="Pilot Group">
            <option value="">Seed from Pilot Group…</option>
            {#each prefs.squads as squad (squad.id)}<option value={squad.id}>{squad.name}</option>{/each}
          </select>
          <button type="button" disabled={!seedSquadID} onclick={seedGroup}>Add group members</button>
        </div>
      {/if}

      <h4>Members</h4>
      <label><input type="checkbox" bind:checked={travelAssist} /> Use fitted AB/MWD for useful resource/container approaches</label>
      <p class="muted">Free targets prefer fresh main-body locality; haulers do not influence selection.</p>
      <div class="seed">
        <label>Account <input bind:value={accountLookup} placeholder="Existing EveJS account" /></label>
        <button type="button" disabled={!accountLookup.trim()} onclick={() => void loadAccount()}>Load account pilots</button>
      </div>
      <div class="pilot-picker">
        {#each roster as pilot (pilot.characterID)}
          <label><input type="checkbox" checked={members.some((member) => member.characterID === pilot.characterID)} onchange={(event) => event.currentTarget.checked ? addPilot(pilot.characterID) : removePilot(pilot.characterID)} /> {pilot.characterName} ({pilot.accountName})</label>
        {/each}
      </div>
      {#if members.length === 0}<p class="muted">Select at least one miner.</p>{/if}
      {#if members.length > 0}
        {@const definitionPilot = members.find(member => member.role !== "DEFENDER")}
        {@const commonKey = definitionPilot ? definitionKey(definitionPilot, preparation.providerCharacterID) : ""}
        <fieldset>
          <legend>Equipment and consumables before operation</legend>
          <p class="note">Each new run reviews equipment, then prepares consumable deficits under the final hosted owner. Productive work waits for verification. MCC does not build or refit ships.</p>
          <label>Default fitting definition provider
            <select value={preparation.providerCharacterID} onchange={(event) => setCommonProvider(Number(event.currentTarget.value))}>
              <option value={0}>Each member's own corporation library</option>
              {#each commonProviders as pilot}<option value={pilot.characterID}>{pilot.characterName} · {pilot.accountName}</option>{/each}
              {#if preparation.providerCharacterID && !commonProviders.some(pilot => pilot.characterID === preparation.providerCharacterID)}<option value={preparation.providerCharacterID} disabled>Configured provider — unavailable for these accounts</option>{/if}
            </select>
          </label>
          <label>Default expected fitting
            <select bind:value={preparation.fittingID} disabled={!definitionPilot || definitionBusy[commonKey]}>
              <option value={0}>Unique exact equipment match — ambiguity blocks Start</option>
              {#each definitionOptions[commonKey]?.definitions.contracts ?? [] as fit}<option value={fit.definition.fittingID}>{fit.name}</option>{/each}
              {#if preparation.fittingID && !definitionOptions[commonKey]?.definitions.contracts.some(fit => fit.definition.fittingID === preparation.fittingID)}<option value={preparation.fittingID} disabled>Configured fitting — refresh its library</option>{/if}
            </select>
          </label>
          <p class="muted">Common fitting choices use {definitionPilot?.characterName ?? "the first member"}'s library. Different hulls or libraries use the member overrides below. Definition providers do not supply physical items.</p>
          <button type="button" onclick={refreshDefinitions} disabled={disconnected}>Refresh fitting libraries</button>
          {#if definitionErrors[commonKey]}<p class="error" role="status">{definitionErrors[commonKey]}</p>{/if}
          <label>Physical supply source <select bind:value={preparation.sourceKind}><option value="hangar">Each member's local personal hangar</option><option value="corp">Exact local corporation division</option></select></label>
          {#if preparation.sourceKind === "corp"}
            <label>Supply corporation ID <input type="number" min="1" step="1" required bind:value={preparation.corporationID} /></label>
            <label>Exact supply division <select bind:value={preparation.division}>{#each [1, 2, 3, 4, 5, 6, 7] as division}<option value={division}>Corporation division {division}</option>{/each}</select></label>
            <p class="note">Query and Take authority are checked separately. A denied or unreadable corporation source never falls back to personal inventory.</p>
          {/if}
          <label><input type="checkbox" bind:checked={preparation.suppliesRequired} /> Require consumable targets before productive work (Heavy Water follows Core fuel policy)</label>
          <p class="note">Optional shortages may be DEGRADED; required shortages block the readiness barrier. Command Heavy Water follows the existing Core fuel policy below.</p>
          <details><summary>Additional cargo supply targets</summary>
            <p class="muted">Saved-fitting targets remain in effect. Extra targets are shared across members; transfers fill verified deficits once per run.</p>
            {#each preparation.supplies as supply, i}
              <div class="supply-target">
                <label>Supply type ID <input type="number" min="1" step="1" required bind:value={supply.typeID} /></label>
                {#if supply.typeID === 16272}<span>Heavy Water</span>{/if}
                <label>Target quantity <input type="number" min="1" step="1" required bind:value={supply.target} /></label>
                <label>Quantity policy <select bind:value={supply.mode}><option value="TOTAL_ABOARD">Total aboard in configured bays</option><option value="CARRIED_SPARES">Carried spares in configured bays</option></select></label>
                <small>Counted bays: {supply.eligibleFlags.map(flag => flag === 5 ? "Cargo" : `Bay ${flag}`).join(", ")}</small>
                <label><input type="checkbox" bind:checked={supply.required} /> Required supply</label>
                <button type="button" onclick={() => preparation.supplies.splice(i, 1)}>Remove target</button>
              </div>
            {/each}
            <button type="button" onclick={() => preparation.supplies.push({ typeID: 0, target: 0, mode: "CARRIED_SPARES", eligibleFlags: [5], required: false })}>Add cargo target</button>
            <button type="button" onclick={() => preparation.supplies.push({ typeID: 16272, target: 0, mode: "TOTAL_ABOARD", eligibleFlags: [5], required: false })}>Add Heavy Water cargo target</button>
          </details>
        </fieldset>
        {#if commands.length > 0}
          <fieldset>
            <legend>Command / Support</legend>
            <label>Fleet policy <select bind:value={support.fleetPolicy}><option value="EXISTING_ONLY">Use existing fleet</option><option value="MANAGED">Manage fleet membership</option></select></label>
            <p>Support-bound miners require an observed mining burst envelope. The Command pilot maintains fitted bursts.</p>
            <label><input type="checkbox" bind:checked={support.useIndustrialCore} /> Use Industrial Core</label>
            <label>Core fuel policy <select bind:value={support.coreRequirement}><option value="continueWithoutCore">Continue without Core, show degraded status</option><option value="requireCore">Require active Core</option></select></label>
            <label><input type="checkbox" bind:checked={support.enableCompression} /> Maintain compression service</label>
            <label><input type="checkbox" bind:checked={support.selfMining} /> Support self-mining</label>
            <label><input type="checkbox" bind:checked={support.tractor} /> Tractor operation-owned containers</label>
            <label>Collection <select bind:value={support.collection}><option value="TRACTOR_ONLY">Tractor only</option><option value="TRACTOR_AND_COLLECT">Tractor and collect ore</option></select></label>
            <label><input type="checkbox" bind:checked={support.compressCollectedOre} /> Compress collected ore</label>
            <label>Support loss <select bind:value={support.supportLoss}><option value="PAUSE">Pause productive mining</option><option value="CONTINUE_UNSUPPORTED">Continue ordinary mining</option><option value="STOP">Stop operation through Parking policy</option></select></label>
            <p>Stale or unavailable support first enters a 30-second recovery interval. Parking uses the operation's selected Stop policy.</p>
          </fieldset>
        {/if}
        <table>
          <thead><tr><th>Pilot</th><th>Role</th><th>Routine mode</th><th>Expected fitting override</th><th>Effective profile / routine</th></tr></thead>
          <tbody>
            {#each members as member (member.characterID)}
              {@const key = definitionKey(member, providerFor(member))}
              <tr>
                <td>{member.characterName}</td>
                <td><select value={member.role} onchange={(event) => patchMember(member.characterID, { role: event.currentTarget.value as DraftMember["role"], automationID: "" })}>
                  <option value="MINER">Miner</option>
                  <option value="HAULER">Hauler</option>
                  <option value="COMMAND">Command / Support</option>
                  <option value="DEFENDER">Standard Defender</option>
                </select></td>
                <td>{#if member.role === "COMMAND" || member.role === "DEFENDER"}Standard / Automatic{:else}<select value={modeOf(member)} onchange={(event) => patchMember(member.characterID, { routineMode: event.currentTarget.value as "STANDARD" | "CUSTOM", automationID: "" })}>
                  <option value="STANDARD">Standard / Automatic</option>
                  <option value="CUSTOM">Custom / Advanced</option>
                </select>{/if}</td>
                <td>
                  <label>Definition provider <select value={member.preparation?.providerCharacterID ?? 0} onchange={(event) => setMemberProvider(member, Number(event.currentTarget.value))}>
                    <option value={0}>Use operation default</option>
                    {#each providerChoices(member) as pilot}<option value={pilot.characterID}>{pilot.characterName}</option>{/each}
                  </select></label>
                  <label>Expected fitting <select value={member.preparation?.fittingID ?? 0} disabled={definitionBusy[key]} onchange={(event) => patchMember(member.characterID, { preparation: { ...member.preparation, fittingID: Number(event.currentTarget.value) || undefined } })}>
                    <option value={0}>Use operation default / unique exact match</option>
                    {#each optionsFor(member)?.definitions.contracts ?? [] as fit}<option value={fit.definition.fittingID}>{fit.name}</option>{/each}
                    {#if member.preparation?.fittingID && !optionsFor(member)?.definitions.contracts.some(fit => fit.definition.fittingID === member.preparation?.fittingID)}<option value={member.preparation.fittingID} disabled>Configured fitting — refresh its library</option>{/if}
                  </select></label>
                  {#if definitionErrors[key]}<p class="error">{definitionErrors[key]}</p>{/if}
                  {#if optionsFor(member)?.definitions.status && optionsFor(member)?.definitions.status !== "READY"}<p class="notice">Fitting library unavailable. Equipment readiness remains unknown.</p>{/if}
                </td>
                <td>{#if modeOf(member) === "STANDARD"}
                  {#if standardAvailable}{profileName(member)}{:else}<span class="error">No Standard profile for this class/policy; use Custom / Advanced.</span>{/if}
                {:else}<select required value={member.automationID} onchange={(event) => patchMember(member.characterID, { automationID: event.currentTarget.value })}>
                  <option value="">Choose operation-compatible routine…</option>
                  {#each scripts.filter((script) => script.roles[member.role]?.compatible) as script (script.scriptID)}<option value={script.scriptID}>{script.name}</option>{/each}
                  {#if member.automationID && !scripts.some((script) => script.scriptID === member.automationID && script.roles[member.role]?.compatible)}
                    <option value={member.automationID} disabled>Incompatible routine — choose another</option>
                  {/if}
                </select>{/if}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
      <p class="note">Standard Defender follows the operation target using shared mobile combat. Its exact saved fitting must pass equipment, skills and ammunition readiness; combat utilities are optional.</p>
      <div class="actions"><button type="submit" disabled={busy !== null || !anchorValid}>Save operation</button><button type="button" onclick={() => { editing = false; editorGeneration++; }}>Cancel</button></div>
    </form>
  {/if}

  {#if payload && payload.operations.length === 0 && !editing}<p class="empty">No Mining Operations yet.</p>{/if}
  {#each payload?.operations ?? [] as row (row.definition.operationID)}
    <article class="operation-card">
      <div class="title-row"><div><h3>{row.definition.name}</h3><span class="state">{row.runtime.state}</span></div><div class="actions">
        {#if ["DRAFT", "STOPPED"].includes(row.runtime.state)}
          <button type="button" onclick={() => editOperation(row.definition)}>Edit</button>
          <button type="button" disabled={busy !== null || disconnected || !runPolicy} onclick={() => void start(row.definition)}>Start operation</button>
          <button type="button" class="danger" disabled={busy !== null} onclick={() => void remove(row.definition.operationID)}>Delete</button>
        {:else}
          <button type="button" class="danger" disabled={busy !== null || disconnected} onclick={() => void stop(row.definition.operationID)}>{row.runtime.state === "PARKING_FAILED" ? "Retry parking" : row.runtime.recoveryRequired ? "Stop recovered operation" : "Stop operation"}</button>
        {/if}
      </div></div>
      {#if row.runtime.statusReason}<p class="notice"><strong>Status:</strong> {row.runtime.statusReason}</p>{/if}
      <MiningOperationRun runtime={row.runtime} policy={runPolicy} parking={(row.definition.policies?.parking.mode ?? "STAY_IN_PLACE") !== "STAY_IN_PLACE"} stale={disconnected || pollError !== null} busy={busy !== null} onExtend={minutes => void extend(row.definition.operationID, minutes)} />
      {#if extensionResults[row.definition.operationID]}<p class="notice" role="status">{extensionResults[row.definition.operationID]}</p>{/if}
      <p><strong>Area:</strong> {row.definition.area.anchorSystemName ?? "Unknown system"} · {row.definition.area.reach === "CURRENT_SYSTEM" ? "current system" : "adjacent mode (anchor-only execution in v0.1)"}</p>
      <p><strong>Target class / unload:</strong> {row.definition.area.targetClasses.join(", ")} · {row.definition.unloadPolicy === "HAULER_SERVICE" ? "Hauler service" : "Self unload"}</p>
      <p><strong>Standard resources:</strong> {row.definition.policies?.resourcePolicy?.mode === "PREFER_LIST" ? row.definition.policies.resourcePolicy.typeIDs.map(id => catalog.find(resource => resource.typeID === id)?.name ?? `Type ${id}`).join(" → ") + " → any eligible" : "Any eligible"}</p>
      <p><strong>On Stop:</strong> {stopLabels[row.definition.policies?.parking.mode ?? "STAY_IN_PLACE"]}{row.definition.policies?.parking.destination ? ` · ${"kind" in row.definition.policies.parking.destination ? row.definition.policies.parking.destination.name : row.definition.policies.parking.destination.stationName}` : ""}</p>
      <p><strong>Delivery:</strong> {row.definition.unloadDestination ? `${"kind" in row.definition.unloadDestination ? row.definition.unloadDestination.name : row.definition.unloadDestination.stationName} · ${row.definition.unloadDestination.corporationDivision === null ? "Personal hangar" : `Corporation Division ${row.definition.unloadDestination.corporationDivision}`}` : row.definition.members.some((member) => modeOf(member) === "STANDARD") ? "Not configured — Standard Start blocked" : "Configured in custom routine"}</p>
      {#if ["DRAFT", "STOPPED"].includes(row.runtime.state)}
        <p class={readiness[row.definition.operationID]?.message ? "notice" : "muted"}><strong>Start readiness:</strong> {readiness[row.definition.operationID]?.message ?? "Read-only plan shown below; Start performs a fresh review and revalidation."}</p>
        <button type="button" disabled={busy !== null || disconnected} onclick={() => void reviewReadiness(row.definition)}>Review member readiness</button>
        <MiningPreparation preparation={readiness[row.definition.operationID]?.plan?.preparation} members={row.definition.members} planning stale={disconnected || pollError !== null} />
      {:else}
        <MiningPreparation preparation={row.runtime.preparation ? { ...row.runtime.preparation, members: row.runtime.preparation.members ?? row.runtime.members.flatMap(member => member.preparation ? [member.preparation] : []) } : undefined} members={row.definition.members} stale={disconnected || pollError !== null} />
      {/if}
      <p><strong>Current target:</strong> {row.runtime.currentTarget?.targetName ?? (["STOPPING", "PARKING", "PARKING_FAILED", "STOPPED"].includes(row.runtime.state) ? "Released / no current target" : "Waiting for selection")} {row.runtime.currentTarget ? `· ${row.runtime.currentTarget.state}` : ""}</p>
      <p><strong>Current system:</strong> {row.runtime.currentTarget?.systemName ?? (row.runtime.currentTarget ? String(row.runtime.currentTarget.systemID) : "No current mining target")}</p>
      {#if row.runtime.rendezvous}
        <p class="notice"><strong>Rendezvous:</strong> {row.runtime.rendezvous.ready.length}/{row.runtime.rendezvous.required.length} required miners ready.</p>
      {/if}
      {#each row.runtime.logisticsTail as tail (tail.target.targetKey)}
        <p class="notice"><strong>Logistics tail:</strong> {tail.target.targetName} is still DRAINING; {tail.pendingHaulers.length} hauler(s) remain while the main body may relocate.</p>
      {/each}
      <table>
        <thead><tr><th>Pilot</th><th>Role</th><th>Assignment</th><th>Bot state</th><th>Phase</th></tr></thead>
        <tbody>{#each row.runtime.members as member (member.characterID)}<tr><td>{member.characterName}</td><td>{member.role}</td><td>{modeOf(member) === "STANDARD" && row.definition.area.targetClasses.length !== 1 ? "Standard unavailable" : profileName(member, row.definition.area.targetClasses[0], row.definition.unloadPolicy)}</td><td>{member.runtimeState}</td><td>{member.runtimeState === "FAILED" ? `${member.failureCode ? `${member.failureCode}: ` : ""}${member.reason ?? member.phase ?? "Unavailable"}` : member.phase ?? member.reason ?? "—"}</td></tr>{/each}</tbody>
      </table>
      {#if row.runtime.stopFailures.length > 0}<div class="error"><p>Stop / Parking remains incomplete; this operation is not reported stopped.</p>{#each row.runtime.stopFailures as failure}<p>Pilot {failure.characterID}: {failure.message}</p>{/each}</div>{/if}
      {#if row.runtime.history.length > 0}<details><summary>Target history</summary><ul>{#each row.runtime.history as item}<li>{item.at} · {item.kind} · {item.target?.targetName ?? (item.evidence ? JSON.stringify(item.evidence) : "—")}{#if item.kind === "TARGET_SELECTION" && item.evidence}<details><summary>Locality decision</summary><pre>{JSON.stringify(item.evidence, null, 2)}</pre></details>{/if}</li>{/each}</ul></details>{/if}
    </article>
  {/each}

  <section class="board">
    <h3>Global target board</h3>
    <p class="muted">Shared across every Mining Operation. Claims are atomic and lease-bound.</p>
    <p class="note">Haulers continue to use the existing global container claims. Operation-scoped can ownership is deferred.</p>
    {#if (payload?.targetBoard.length ?? 0) === 0}<p class="empty">No targets observed yet.</p>{/if}
    {#if (payload?.targetBoard.length ?? 0) > 0}<table><thead><tr><th>Target</th><th>Type</th><th>System</th><th>State</th></tr></thead><tbody>{#each payload?.targetBoard ?? [] as target (target.targetKey)}<tr><td>{target.targetName}</td><td>{target.targetType}</td><td>{target.systemName ?? "—"}</td><td>{target.state}</td></tr>{/each}</tbody></table>{/if}
  </section>
</section>

<style>
  .operations { padding: 1rem; color: #dce8ef; min-width: 0; }
  header, .title-row, .actions, .seed, .launch-settings { display: flex; gap: .65rem; align-items: center; justify-content: space-between; }
  h2, h3, h4, p { margin: .25rem 0 .65rem; }
  header p, .muted, .note { color: #93a9b5; }
  button, input, select { min-height: 2.1rem; border: 1px solid #395362; border-radius: 4px; background: #101b22; color: inherit; padding: .35rem .55rem; }
  button { cursor: pointer; } button:disabled { cursor: not-allowed; opacity: .5; }
  .editor, .operation-card, .board { border: 1px solid #304754; background: #0d171d; border-radius: 6px; padding: .85rem; margin: .8rem 0; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
  label { display: flex; gap: .45rem; align-items: center; margin: .4rem 0; }
  label > input:not([type="checkbox"]):not([type="radio"]), label > select { flex: 1; }
  fieldset { border: 1px solid #304754; margin: .7rem 0; }
  .disabled { color: #728691; }
  .pilot-picker { display: flex; flex-wrap: wrap; gap: .4rem 1rem; }
  .system-matches { display: flex; flex-wrap: wrap; gap: .35rem; }
  table { width: 100%; border-collapse: collapse; margin-top: .55rem; }
  th, td { border-bottom: 1px solid #263943; text-align: left; padding: .45rem; vertical-align: top; }
  th { color: #8fb4c7; font-weight: 600; }
  .state { color: #65d7b0; font-size: .8rem; letter-spacing: .06em; }
  .notice { border-left: 3px solid #d4a84d; padding-left: .55rem; }
  .error { color: #ff9e9e; }
  .danger { border-color: #8e4d50; color: #ffb0b0; }
  .empty { color: #8195a0; font-style: italic; }
  .supply-target { border: 1px solid #304754; padding: .5rem; margin: .5rem 0; }
  td select { max-width: 18rem; width: 100%; }
  @media (max-width: 700px) { .grid2 { grid-template-columns: 1fr; } header, .title-row { align-items: flex-start; flex-direction: column; } table { font-size: .85rem; } }
</style>
