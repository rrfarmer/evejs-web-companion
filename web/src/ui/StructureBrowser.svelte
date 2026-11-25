<script lang="ts">
  import { onDestroy } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { filetimeToUnixMs } from "../bridge/activity.ts";
  import { formatInterval, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { BookmarkPlace } from "../bridge/locationsList.ts";
  import { hasMoonStationManagerRole } from "../bridge/moonMining.ts";
  import { isNpcCorporation } from "../bridge/ownerInfo.ts";
  import { isStation } from "../bridge/placeChanges.ts";
  import { hasSecurityOffice } from "../bridge/securityOffice.ts";
  import { sessionPlace } from "../bridge/sessionPlace.ts";
  import {
    ABANDONED, LOW_POWER, OWNED_STRUCTURE_SERVICE_FILTERS, OWNED_STRUCTURE_STATES,
    STATION_TYPE_FILTER, STRUCTURE_SERVICE_DETAILS, STRUCTURE_TYPE_GROUPS, isFlexStructure, structureDecommissionAction,
  } from "../bridge/structureBrowserFilters.ts";
  import type { StructureBrowserDirectory, StructureBrowserEntry } from "../bridge/structures.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { structureHasCapability } from "../nav/dockableLocation.ts";
  import { isDeprecatedStationType } from "../nav/waypoints.ts";
  import { ContextMenu, type ContextEntry } from "../play/contextMenu.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import CorporationMoonSchedule from "./CorporationMoonSchedule.svelte";
  import BookmarkWindow from "./BookmarkWindow.svelte";
  import HomeStationPanel from "./HomeStationPanel.svelte";
  import StructureDescription from "./StructureDescription.svelte";
  import StructureReinforcement from "./StructureReinforcement.svelte";
  import { startLinkDrag } from "./linkFollowers.ts";
  import { showInfo } from "./showInfo.ts";

  let { flow, store, schedulableRefineryID = null, onOpenRefinerySchedule }: {
    flow: AppFlow; store: ClientStore; schedulableRefineryID?: number | null;
    onOpenRefinerySchedule?: (structureID: number) => Promise<void>;
  } = $props();
  const station = $derived(store.station);
  const flight = $derived(store.flight);
  const names = $derived(store.names);
  const words = $derived(store.words);
  const waypoints = $derived(flow.waypoints);
  const systemID = $derived(sessionPlace($flight.status, $station.online).solarSystemID);
  const corporationID = $derived($station.online?.corporationID ?? null);
  const canManage = $derived(corporationID !== null && !isNpcCorporation(corporationID) &&
    hasMoonStationManagerRole($station.online?.corpRole ?? null));
  let tab = $state<"all" | "corporation">("all");
  let corporationPanel = $state<"structures" | "extractions">("structures");
  const activeTab = $derived(canManage ? tab : "all");
  const scheduleOpen = $derived(activeTab === "corporation" && corporationPanel === "extractions");
  let directory = $state.raw<StructureBrowserDirectory | null>(null);
  const rows = $derived(directory?.entries ?? []);
  let loading = $state(true);
  let error = $state("");
  let range = $state<"system" | "constellation" | "region">("system");
  let owner = $state<"any" | "npc" | "corporation">("any");
  let query = $state("");
  let types = $state<number[]>([]);
  let services = $state<number[]>([]);
  let ownedTypes = $state<number[]>([]);
  let ownedServices = $state<number[]>([]);
  let ownedSearch = $state("");
  let onlyLowPower = $state(false);
  let profile = $state<number | null>(null);
  let now = $state(Date.now());
  const selectedTypes = $derived(activeTab === "corporation" ? ownedTypes : types);
  let bookmark = $state<BookmarkPlace | null>(null);
  let homeStationID = $state<number | null>(null);
  let descriptionRow = $state.raw<StructureBrowserEntry | null>(null);
  let reinforcementRows = $state.raw<readonly StructureBrowserEntry[] | null>(null);
  let selectedStructureIDs = $state<number[]>([]);
  let actionError = $state("");
  let decommissionBusy = $state(false);
  let profileBusy = $state(false);
  let directoryRevision = $state(0);
  const rowMenu = new ContextMenu();
  onDestroy(() => rowMenu.close());

  const labels = {
    all: ["UI/Structures/Browser/AllStructures", "All Structures"],
    corporation: ["UI/Structures/Browser/MyStructures", "My Corp Structures"],
    withProfile: ["UI/StructureBrowser/StructuresWithProfile", "Structures"],
    extractions: ["UI/Moonmining/UpcomingExtractionsTab", "Upcoming Extractions"],
    empty: ["UI/Structures/Browser/NoStructuresFound", "No structures found"],
    filtered: ["UI/Structures/Browser/NoStructuresFoundWithFilters", "No structures found with these filters"],
    stations: ["UI/StructureBrowser/StationsAndOutposts", "Stations and Outposts"],
    navigation: ["UI/StructureBrowser/NavigationStructures", "FLEX Structures"],
    profile: ["UI/Structures/Browser/HeaderProfileName", "Profile"],
    state: ["UI/Structures/Browser/HeaderState", "State"],
    fuel: ["UI/Structures/Browser/HeaderFuel", "Fuel Expires"],
    reinforcement: ["UI/Structures/Browser/HeaderReinforcementTime", "Reinforcement Hour"],
    lowPower: ["UI/Structures/UpkeepModeLowPower", "Low Power"],
    abandoned: ["UI/Structures/UpkeepModeAbandoned", "Abandoned"],
    unanchoring: ["UI/Structures/Browser/StructureUnanchoring", "Unanchoring"],
  } as const;
  const menuWords = {
    dock: ["UI/Inflight/DockInStation", "Dock"],
    destination: ["UI/Inflight/SetDestination", "Set Destination"],
    add: ["UI/Inflight/AddWaypoint", "Add Waypoint"],
    remove: ["UI/Inflight/RemoveWaypoint", "Remove Waypoint"],
    home: ["UI/Menusvc/SetHomeStation", "Set Home Station"],
    bookmark: ["UI/Inflight/BookmarkLocation", "Save Location…"],
    info: ["UI/Commands/ShowInfo", "Show Info"],
    description: ["UI/StructureBrowser/SetStructureDescription", "Set Structure Bio"],
    decommission: ["UI/StructureBrowser/Decommission", "Decommission"],
    cancelDecommission: ["UI/StructureBrowser/CancelDecommission", "Cancel Decommission"],
    setReinforcement: ["UI/StructureBrowser/SetReinforcementTime", "Set Reinforcement Time"],
    setDockableReinforcement: ["UI/StructureBrowser/SetReinforcementTimeDockable", "Set Reinforcement Time (Dockable)"],
    setFlexReinforcement: ["UI/StructureBrowser/SetReinforcementTimeNonDockable", "Set Reinforcement Time (FLEX)"],
    setProfile: ["UI/StructureBrowser/SetProfile", "Set Profile"],
    setProfiles: ["UI/StructureBrowser/SetProfileMany", "Set Profile ({numSelected})"],
    scheduleExtraction: ["UI/Moonmining/OpenSchedulingWnd", "Open Extraction Scheduling Window"],
  } as const;
  const serviceLabels = [
    [-1, "UI/Station/CharacterRecustomization", "Character Recustomization"],
    [6, "UI/Medical/Medical", "Clone Bay"],
    [8, "UI/Station/Repairshop", "Repairshop"],
    [4, "UI/Station/ReprocessingPlant", "Reprocessing Plant"],
    [5, "UI/Station/Market", "Market"],
    [2, "UI/Station/Fitting", "Fitting"],
    [20, "UI/Industry/Industry", "Industry"],
    [12, "UI/Station/MilitiaOffice", "Militia Office"],
    [9, "UI/Station/Insurance", "Insurance"],
    [11, "UI/Station/LPStore", "LP Store"],
    [13, "UI/Station/SecurityOffice", "Security Office"],
    [14, "UI/Moonmining/MoonDrillService", "Moon Drilling"],
    [15, "UI/Structures/ServiceJumpBridge", "Jump Bridge"],
    [16, "UI/Structures/ServiceJumpBeacon", "Cyno Beacon"],
    [17, "UI/Structures/ServiceCynoJammer", "Cyno Jammer"],
    [18, "UI/Moonmining/AutoMoonDrillService", "Automatic Moon Drilling"],
  ] as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const placeName = (row: StructureBrowserEntry) => row.itemName || resolvedName($names.resolved,
    isStation(row.structureID) ? "station" : "structure", row.structureID, String(row.structureID));
  const ownerName = (row: StructureBrowserEntry) => resolvedName($names.resolved, "corporation", row.ownerID, String(row.ownerID));
  const locationName = (id: number) => resolvedName($names.resolved, "evelocation", id, String(id));
  const typeName = (id: number) => resolvedName($names.resolved, "type", id, String(id));

  function inspect(row: StructureBrowserEntry): void {
    showInfo({ kind: "type", typeID: row.typeID, itemID: row.structureID });
  }

  function action(key: keyof typeof menuWords, run: () => void): ContextEntry {
    const [path, fallback] = menuWords[key];
    return { path, label: plainText($words.templates[path] ?? fallback), run };
  }

  function openRowMenu(row: StructureBrowserEntry, x: number, y: number): void {
    const id = row.structureID;
    const stationRow = isStation(id);
    const deprecated = isDeprecatedStationType(row.typeID);
    const entries: (ContextEntry | null)[] = [];
    const ownedRow = activeTab === "corporation" && row.owned;
    const selected = ownedRow && selectedStructureIDs.includes(id)
      ? ordered.filter(item => selectedStructureIDs.includes(item.structureID))
      : [row];
    if (ownedRow && selected.length > 1) {
      addReinforcementOptions(entries, selected);
      addProfileOptions(entries, selected);
      rowMenu.open(x, y, entries);
      return;
    }
    const decommission = activeTab === "corporation" && row.owned
      ? structureDecommissionAction(row.owned, $station.online?.corpRole ?? null) : null;
    if (decommission !== null && !decommissionBusy) {
      entries.push(action(decommission === "start" ? "decommission" : "cancelDecommission",
        () => void changeDecommission(id, decommission)));
    }
    if (activeTab === "corporation" && row.owned && directory?.canEditDescriptions) {
      entries.push(action("description", () => {
        bookmark = null;
        homeStationID = null;
        descriptionRow = row;
      }), null);
    }
    if (ownedRow && id === schedulableRefineryID && onOpenRefinerySchedule) {
      entries.push(action("scheduleExtraction", () => void onOpenRefinerySchedule?.(id)));
    }
    if (ownedRow) addReinforcementOptions(entries, selected);
    if ($flight.status?.inSpace && row.solarSystemID === systemID &&
      !deprecated && (stationRow || structureHasCapability(row.serviceIDs, "dock"))) {
      entries.push(action("dock", () => {
        actionError = "";
        void flow.dockAt(id).catch(cause => { actionError = cause instanceof Error ? cause.message : String(cause); });
      }));
    }
    if ($waypoints.at(-1) !== id) entries.push(action("destination", () => flow.setDestination(id)));
    entries.push($waypoints.includes(id)
      ? action("remove", () => flow.clearWaypoints(id))
      : action("add", () => flow.addWaypoint(id)));
    if ($flight.status?.docked && !deprecated && !row.isTriglavian) entries.push(action("home", () => {
      bookmark = null;
      homeStationID = id;
    }));
    if (stationRow && !deprecated) entries.push(null, action("bookmark", () => {
      homeStationID = null;
      bookmark = { itemID: id, askIfKnown: true, name: () => placeName(row), typeName: () => typeName(row.typeID) };
    }));
    entries.push({ ...action("info", () => inspect(row)), info: true });
    if (ownedRow) addProfileOptions(entries, selected);
    rowMenu.open(x, y, entries);
  }

  function addProfileOptions(entries: (ContextEntry | null)[], rows: readonly StructureBrowserEntry[]): void {
    if (profileBusy || !directory?.profileNames.size) return;
    const ids = rows.map(row => row.structureID);
    const [path, fallback] = menuWords[ids.length > 1 ? "setProfiles" : "setProfile"];
    const label = plainText(formatTemplate($words.templates[path] ?? fallback, { numSelected: ids.length }, { nameOf: () => "" }));
    const choices = [...directory.profileNames].sort((left, right) => left[1].toLowerCase().localeCompare(right[1].toLowerCase()));
    entries.push({ path, label, sub: choices.map(([id, name]) => ({
      label: name,
      run: () => void assignProfile(ids, id),
    })) });
  }

  async function assignProfile(ids: readonly number[], profileID: number): Promise<void> {
    if (profileBusy) return;
    profileBusy = true;
    actionError = "";
    try {
      await flow.assignStructureProfile(ids, profileID);
      directoryRevision++;
    } catch (cause) {
      actionError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      profileBusy = false;
    }
  }

  function addReinforcementOptions(entries: (ContextEntry | null)[], rows: readonly StructureBrowserEntry[]): void {
    const dockable = rows.filter(row => !isFlexStructure(row.typeID));
    const flex = rows.filter(row => isFlexStructure(row.typeID));
    const open = (selection: readonly StructureBrowserEntry[]) => {
      bookmark = null;
      homeStationID = null;
      descriptionRow = null;
      reinforcementRows = selection;
    };
    if (dockable.length) entries.push(action(flex.length ? "setDockableReinforcement" : "setReinforcement", () => open(dockable)));
    if (flex.length) entries.push(action("setFlexReinforcement", () => open(flex)));
  }

  async function changeDecommission(id: number, change: "start" | "cancel"): Promise<void> {
    if (decommissionBusy) return;
    decommissionBusy = true;
    actionError = "";
    try {
      if (await flow.changeStructureDecommission(id, change)) directoryRevision++;
    } catch (cause) {
      actionError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      decommissionBusy = false;
    }
  }
  const typeGroups = $derived(STRUCTURE_TYPE_GROUPS.map(group => ({
    ...group,
    label: group.id < 0 ? word("navigation") : resolvedName($names.resolved, "group", group.id, group.label),
    typeIDs: group.types.flatMap<number>(type => type.ids),
  })).sort((a, b) => a.label.localeCompare(b.label)));
  const typeFilterID = (row: StructureBrowserEntry) => isStation(row.structureID) ? STATION_TYPE_FILTER : row.typeID;
  const serviceChoices = $derived(serviceLabels.map(([id, key, fallback]) =>
    ({ id, label: plainText($words.templates[key] ?? fallback) })).sort((a, b) => a.label.localeCompare(b.label)));
  const publicServiceChoices = $derived(serviceChoices.filter(service => service.id !== 17));
  const ownedServiceChoices = $derived(serviceChoices.filter(service => OWNED_STRUCTURE_SERVICE_FILTERS.has(service.id)));
  const profileChoices = $derived.by(() => {
    const choices = new Map(directory?.profileNames);
    for (const row of rows) {
      const id = row.owned?.profileID;
      if (id != null && !choices.has(id)) choices.set(id, `Profile ${id}`);
    }
    return choices;
  });
  const displayedProfile = $derived(profile !== null && profileChoices.has(profile) ? profile : null);
  const showOzone = $derived(activeTab === "corporation" && ownedServices.includes(15));
  const detailColumns = $derived.by(() => {
    const columns = new Map<string, { id: number; label: string }>();
    if (activeTab !== "all") return [];
    for (const id of services) {
      const detail = STRUCTURE_SERVICE_DETAILS.get(id);
      if (detail && !columns.has(detail.path)) {
        columns.set(detail.path, { id, label: plainText($words.templates[detail.path] ?? detail.label) });
      }
    }
    return [...columns.values()];
  });
  const percentage = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isk = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

  function detailValue(row: StructureBrowserEntry, id: number): string {
    const value = row.serviceValues.get(id);
    if (value == null) return "-";
    const format = STRUCTURE_SERVICE_DETAILS.get(id)?.format;
    if (format === "access") return "True";
    if (format === "percentage") return `${percentage.format(value)} %`;
    if (format === "isk") return `${isk.format(value)} ISK`;
    return String(value);
  }

  function selectTypes(ids: readonly number[], selected: boolean) {
    const next = selected ? [...new Set([...selectedTypes, ...ids])] : selectedTypes.filter(id => !ids.includes(id));
    if (activeTab === "corporation") ownedTypes = next;
    else types = next;
  }

  function stateName(row: StructureBrowserEntry): string {
    return OWNED_STRUCTURE_STATES[row.owned?.state ?? 0] ?? "—";
  }

  function fuelText(row: StructureBrowserEntry): string {
    const expires = filetimeToUnixMs(row.owned?.fuelExpires ?? null);
    return expires === null || expires <= 0 ? "—" : formatInterval(Math.max(0, expires - now) * 10_000);
  }

  function unanchorTime(row: StructureBrowserEntry): string {
    const end = filetimeToUnixMs(row.owned?.unanchoring ?? null);
    return end === null ? "" : formatInterval(Math.max(0, end - now) * 10_000);
  }

  function reinforcementHour(hour: number | null | undefined): string {
    return hour == null ? "—" : `${String(hour).padStart(2, "0")}:00`;
  }
  const currentRegion = $derived(directory?.currentRegionID ?? null);
  const currentConstellation = $derived(directory?.currentConstellationID ?? null);
  const systemOnly = $derived(currentRegion !== null && currentRegion >= 11000000 && currentRegion <= 11999999);
  const effectiveRange = $derived(systemOnly ? "system" : range);
  const needle = $derived((activeTab === "corporation" ? ownedSearch : query).trim().toLowerCase());
  const scopedRows = $derived(activeTab === "corporation" ? rows : rows.filter(row => {
    if (effectiveRange === "system") return row.solarSystemID === systemID;
    if (effectiveRange === "constellation") return row.solarSystemID === systemID ||
      (currentConstellation !== null && row.constellationID === currentConstellation);
    return true;
  }));
  const ordered = $derived(scopedRows.filter(row => {
    if (activeTab === "corporation") {
      if (displayedProfile !== null && row.owned?.profileID !== displayedProfile) return false;
      if (onlyLowPower && row.owned?.upkeepState !== LOW_POWER) return false;
      if (ownedServices.length && !ownedServices.some(id => hasService(row, id))) return false;
    } else {
      if (owner === "npc" && !isNpcCorporation(row.ownerID)) return false;
      if (owner === "corporation" && row.ownerID !== corporationID) return false;
      if (services.length && !services.some(id => id === -1 || hasService(row, id))) return false;
    }
    if (selectedTypes.length && !selectedTypes.includes(typeFilterID(row))) return false;
    return !needle || [placeName(row), ownerName(row), locationName(row.solarSystemID), typeName(row.typeID),
      row.regionID === null ? "" : locationName(row.regionID)].join(" ").toLowerCase().includes(needle);
  }).sort((left, right) => (left.jumps ?? Infinity) - (right.jumps ?? Infinity) ||
    placeName(left).localeCompare(placeName(right))));

  function hasService(row: StructureBrowserEntry, serviceID: number): boolean {
    if (serviceID === 20) return structureHasCapability(row.serviceIDs, "industry");
    if (serviceID === 13 && !hasSecurityOffice(row.ownerID, row.security)) return false;
    return row.serviceIDs.includes(serviceID);
  }

  $effect(() => {
    if (activeTab !== "corporation" || scheduleOpen) return;
    now = Date.now();
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });

  $effect(() => {
    flow.requestWords([...Object.values(labels).map(([key]) => key), ...Object.values(menuWords).map(([key]) => key),
      ...serviceLabels.map(([, key]) => key),
      ...new Set([...STRUCTURE_SERVICE_DETAILS.values()].map(detail => detail.path))]);
    flow.requestNames(STRUCTURE_TYPE_GROUPS.flatMap(group => [
      ...(group.id > 0 ? [{ kind: "group" as const, id: group.id }] : []),
      ...group.types.map(type => ({ kind: "type" as const, id: type.id })),
    ]));
  });

  $effect(() => {
    const here = systemID;
    const owned = activeTab === "corporation";
    void directoryRevision;
    void $station.online?.characterID;
    if (owned) void corporationID;
    directory = null;
    loading = false;
    error = "";
    if (here === null || scheduleOpen) return;
    let current = true;
    loading = true;
    void flow.loadStructureBrowser(here, owned).then(result => {
      if (current) directory = result;
    }).catch(cause => {
      if (current) error = cause instanceof Error ? cause.message : String(cause);
    }).finally(() => {
      if (current) loading = false;
    });
    return () => { current = false; };
  });
</script>

{#snippet typeFilters()}
  <details>
    <summary>Structure Types</summary>
    {#if activeTab === "all"}
      <label><input type="checkbox" checked={selectedTypes.includes(STATION_TYPE_FILTER)}
        onchange={(event) => selectTypes([STATION_TYPE_FILTER], event.currentTarget.checked)} /> {word("stations")}</label>
    {/if}
    {#each typeGroups as group (group.id)}
      <details class="type-group">
        <summary>{group.label}</summary>
        <label><input type="checkbox" checked={group.typeIDs.every(id => selectedTypes.includes(id))}
          indeterminate={group.typeIDs.some(id => selectedTypes.includes(id)) && !group.typeIDs.every(id => selectedTypes.includes(id))}
          onchange={(event) => selectTypes(group.typeIDs, event.currentTarget.checked)} /> All {group.label}</label>
        {#each group.types as type (type.id)}
          <label><input type="checkbox" checked={type.ids.every(id => selectedTypes.includes(id))}
            onchange={(event) => selectTypes(type.ids, event.currentTarget.checked)} />
            {resolvedName($names.resolved, "type", type.id, type.label)}</label>
        {/each}
      </details>
    {/each}
  </details>
{/snippet}

<section class="structure-browser" aria-label={word(activeTab)}>
  {#if reinforcementRows && canManage && activeTab === "corporation" && !scheduleOpen}
    {#key reinforcementRows}
      <StructureReinforcement {store} {flow} rows={reinforcementRows} onClose={() => reinforcementRows = null}
        onDone={() => { reinforcementRows = null; directoryRevision++; }} />
    {/key}
  {/if}
  {#if descriptionRow && canManage && activeTab === "corporation" && !scheduleOpen}
    {#key descriptionRow.structureID}
      <StructureDescription {flow} structureID={descriptionRow.structureID} structureName={placeName(descriptionRow)}
        title={plainText($words.templates[menuWords.description[0]] ?? menuWords.description[1])}
        onClose={() => descriptionRow = null} />
    {/key}
  {/if}
  {#if bookmark}<BookmarkWindow {store} {flow} place={bookmark} onDone={() => bookmark = null} />{/if}
  {#if homeStationID !== null}
    {#key homeStationID}<HomeStationPanel {store} {flow} targetStationID={homeStationID} onClose={() => homeStationID = null} />{/key}
  {/if}
  {#if actionError}<p role="alert" class="error">{actionError}</p>{/if}
  {#if canManage}
    <nav aria-label="Structure Browser">
      <button type="button" aria-pressed={activeTab === "all"} onclick={() => tab = "all"}>{word("all")}</button>
      <button type="button" aria-pressed={activeTab === "corporation"} onclick={() => tab = "corporation"}>{word("corporation")}</button>
    </nav>
  {/if}
  {#if activeTab === "corporation"}
    <nav aria-label={word("corporation")}>
      <button type="button" aria-pressed={!scheduleOpen} onclick={() => corporationPanel = "structures"}>{word("withProfile")}</button>
      <button type="button" aria-pressed={scheduleOpen} onclick={() => corporationPanel = "extractions"}>{word("extractions")}</button>
    </nav>
    {#if !scheduleOpen}
      <div class="directory-filters">
        <label>{word("profile")}
          <select value={displayedProfile ?? ""} onchange={(event) => profile = event.currentTarget.value ? Number(event.currentTarget.value) : null}>
            <option value="">All Profiles</option>
            {#each [...profileChoices] as [id, name] (id)}<option value={id}>{name}</option>{/each}
          </select>
        </label>
        <label><input type="checkbox" bind:checked={onlyLowPower} /> {word("lowPower")}</label>
        <label>Search <input type="search" bind:value={ownedSearch} /></label>
        {@render typeFilters()}
        <details>
          <summary>Services</summary>
          {#each ownedServiceChoices as choice (choice.id)}
            <label><input type="checkbox" bind:group={ownedServices} value={choice.id} /> {choice.label}</label>
          {/each}
        </details>
      </div>
    {/if}
  {:else}
    <div class="directory-filters">
      <label>Range
        <select value={effectiveRange} onchange={(event) => range = event.currentTarget.value as typeof range}>
          {#if !systemOnly}<option value="region">Region</option><option value="constellation">Constellation</option>{/if}
          <option value="system">Solar System</option>
        </select>
      </label>
      <label>Owner
        <select bind:value={owner}>
          <option value="any">All Facilities</option>
          <option value="npc">Public Facilities</option>
          <option value="corporation">Corporation Owned Facilities</option>
        </select>
      </label>
      <label>Search <input type="search" bind:value={query} /></label>
      {@render typeFilters()}
      <details>
        <summary>Services</summary>
        {#each publicServiceChoices as choice (choice.id)}
          <label><input type="checkbox" bind:group={services} value={choice.id} /> {choice.label}</label>
        {/each}
      </details>
    </div>
  {/if}
  {#if scheduleOpen}
    <CorporationMoonSchedule {store} {flow} />
  {:else if loading}
    <p role="status">Loading structures…</p>
  {:else if error}
    <p role="alert" class="error">{error}</p>
  {:else if ordered.length === 0}
    <p role="status">{word(scopedRows.length ? "filtered" : "empty")}</p>
  {:else}
    <table aria-label={word(activeTab)}>
      <thead><tr>
        {#if activeTab === "corporation"}
          {#if displayedProfile === null}<th scope="col">{word("profile")}</th>{/if}
          <th scope="col">{word("state")}</th>
        {/if}
        <th scope="col">Jumps</th><th scope="col">Security</th>
        {#if activeTab === "all"}<th scope="col">Owner</th>{/if}
        <th scope="col">Name</th><th scope="col">Services</th>
        {#if activeTab === "corporation"}<th scope="col">{word("fuel")}</th><th scope="col">{word("reinforcement")}</th>{/if}
        {#if showOzone}<th scope="col">Liquid Ozone</th>{/if}
        {#each detailColumns as detail (detail.id)}<th scope="col">{detail.label}</th>{/each}
      </tr></thead>
      <tbody>
        {#each ordered as row (row.structureID)}
          <tr data-structure-id={row.structureID} oncontextmenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openRowMenu(row, event.clientX, event.clientY);
          }}>
            {#if activeTab === "corporation"}
              {#if displayedProfile === null}<td>{profileChoices.get(row.owned?.profileID ?? 0) ?? "—"}</td>{/if}
              <td>{stateName(row)}
                {#if row.owned?.upkeepState === LOW_POWER}<small class="upkeep">{word("lowPower")}</small>
                {:else if row.owned?.upkeepState === ABANDONED}<small class="upkeep">{word("abandoned")}</small>{/if}
                {#if row.owned?.unanchoring != null}
                  <small class="upkeep">{word("unanchoring")} {unanchorTime(row)}</small>
                {/if}
              </td>
            {/if}
            <td>{row.jumps ?? "—"}</td>
            <td>{row.security === null ? "—" : shownSecurity(row.security).toFixed(1)}</td>
            {#if activeTab === "all"}<td>{ownerName(row)}</td>{/if}
            <td>
              {#if activeTab === "corporation"}
                <input type="checkbox" aria-label={`Select ${placeName(row)}`} bind:group={selectedStructureIDs} value={row.structureID} />
              {/if}
              <button type="button" title={typeName(row.typeID)} draggable="true"
              ondragstart={(event) => startLinkDrag(event, `showinfo:${row.typeID}//${row.structureID}`, placeName(row))}
              onkeydown={(event) => {
                if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                openRowMenu(row, bounds.left, bounds.bottom);
              }}
              onclick={() => inspect(row)}>{placeName(row)}</button></td>
            <td>{serviceChoices.filter(service => hasService(row, service.id)).map(service => service.label).join(", ") || "—"}</td>
            {#if activeTab === "corporation"}
              <td>{fuelText(row)}</td>
              <td>{reinforcementHour(row.owned?.reinforceHour)}
                {#if row.owned?.nextReinforceHour != null}
                  <small>Pending {reinforcementHour(row.owned.nextReinforceHour)}</small>
                {/if}
              </td>
            {/if}
            {#if showOzone}<td>{row.owned?.liquidOzoneQty ? row.owned.liquidOzoneQty.toLocaleString() : "—"}</td>{/if}
            {#each detailColumns as detail (detail.id)}<td>{detailValue(row, detail.id)}</td>{/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<style>
  .structure-browser { display: grid; gap: 8px; padding: 10px; align-content: start; }
  nav { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--line, #444); padding-bottom: 4px; }
  nav [aria-pressed="true"] { box-shadow: inset 0 -2px currentColor; }
  .directory-filters { display: flex; flex-wrap: wrap; align-items: start; gap: 8px; }
  .directory-filters > label { display: flex; align-items: center; gap: 4px; }
  details { padding: 2px 6px; border: 1px solid var(--line, #444); }
  details label { display: block; }
  .type-group { border: 0; margin-left: 8px; }
  summary { cursor: pointer; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 4px 6px; border-bottom: 1px solid var(--line, #444); }
  td button { padding: 2px 5px; }
  td small { display: block; }
  .upkeep { color: #f0c36a; }
</style>
