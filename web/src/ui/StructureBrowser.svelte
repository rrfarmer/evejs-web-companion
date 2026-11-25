<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { hasMoonStationManagerRole } from "../bridge/moonMining.ts";
  import { isNpcCorporation } from "../bridge/ownerInfo.ts";
  import { isStation } from "../bridge/placeChanges.ts";
  import { hasSecurityOffice } from "../bridge/securityOffice.ts";
  import { sessionPlace } from "../bridge/sessionPlace.ts";
  import type { StructureBrowserDirectory, StructureBrowserEntry } from "../bridge/structures.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { structureHasCapability } from "../nav/dockableLocation.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import CorporationMoonSchedule from "./CorporationMoonSchedule.svelte";
  import { showInfo } from "./showInfo.ts";

  let { flow, store }: { flow: AppFlow; store: ClientStore } = $props();
  const station = $derived(store.station);
  const flight = $derived(store.flight);
  const names = $derived(store.names);
  const words = $derived(store.words);
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

  const labels = {
    all: ["UI/Structures/Browser/AllStructures", "All Structures"],
    corporation: ["UI/Structures/Browser/MyStructures", "My Corp Structures"],
    withProfile: ["UI/StructureBrowser/StructuresWithProfile", "Structures"],
    extractions: ["UI/Moonmining/UpcomingExtractionsTab", "Upcoming Extractions"],
    empty: ["UI/Structures/Browser/NoStructuresFound", "No structures found"],
    filtered: ["UI/Structures/Browser/NoStructuresFoundWithFilters", "No structures found with these filters"],
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
    [18, "UI/Moonmining/AutoMoonDrillService", "Automatic Moon Drilling"],
  ] as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const placeName = (row: StructureBrowserEntry) => row.itemName || resolvedName($names.resolved,
    isStation(row.structureID) ? "station" : "structure", row.structureID, String(row.structureID));
  const ownerName = (row: StructureBrowserEntry) => resolvedName($names.resolved, "corporation", row.ownerID, String(row.ownerID));
  const locationName = (id: number) => resolvedName($names.resolved, "evelocation", id, String(id));
  const typeName = (id: number) => resolvedName($names.resolved, "type", id, String(id));
  const typeFilterID = (row: StructureBrowserEntry) => isStation(row.structureID) ? -3 : row.typeID;
  const typeChoices = $derived([...new Set(rows.map(typeFilterID))].map(id =>
    ({ id, label: id === -3 ? "Stations and Outposts" : typeName(id) })).sort((a, b) => a.label.localeCompare(b.label)));
  const serviceChoices = $derived(serviceLabels.map(([id, key, fallback]) =>
    ({ id, label: plainText($words.templates[key] ?? fallback) })).sort((a, b) => a.label.localeCompare(b.label)));
  const currentRegion = $derived(directory?.currentRegionID ?? null);
  const currentConstellation = $derived(directory?.currentConstellationID ?? null);
  const systemOnly = $derived(currentRegion !== null && currentRegion >= 11000000 && currentRegion <= 11999999);
  const effectiveRange = $derived(systemOnly ? "system" : range);
  const needle = $derived(query.trim().toLowerCase());
  const scopedRows = $derived(activeTab === "corporation" ? rows : rows.filter(row => {
    if (effectiveRange === "system") return row.solarSystemID === systemID;
    if (effectiveRange === "constellation") return row.solarSystemID === systemID ||
      (currentConstellation !== null && row.constellationID === currentConstellation);
    return true;
  }));
  const ordered = $derived(scopedRows.filter(row => {
    if (activeTab === "corporation") return true;
    if (owner === "npc" && !isNpcCorporation(row.ownerID)) return false;
    if (owner === "corporation" && row.ownerID !== corporationID) return false;
    if (types.length && !types.includes(typeFilterID(row))) return false;
    if (services.length && !services.some(id => id === -1 || hasService(row, id))) return false;
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
    flow.requestWords([...Object.values(labels).map(([key]) => key), ...serviceLabels.map(([, key]) => key)]);
  });

  $effect(() => {
    const here = systemID;
    const owned = activeTab === "corporation";
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

<section class="structure-browser" aria-label={word(activeTab)}>
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
      <details>
        <summary>Structure Types</summary>
        {#each typeChoices as choice (choice.id)}
          <label><input type="checkbox" bind:group={types} value={choice.id} /> {choice.label}</label>
        {/each}
      </details>
      <details>
        <summary>Services</summary>
        {#each serviceChoices as choice (choice.id)}
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
      <thead><tr><th scope="col">Jumps</th><th scope="col">Security</th><th scope="col">Owner</th><th scope="col">Name</th><th scope="col">Services</th></tr></thead>
      <tbody>
        {#each ordered as row (row.structureID)}
          <tr data-structure-id={row.structureID}>
            <td>{row.jumps ?? "—"}</td>
            <td>{row.security === null ? "—" : shownSecurity(row.security).toFixed(1)}</td>
            <td>{ownerName(row)}</td>
            <td><button type="button" title={typeName(row.typeID)}
              onclick={() => showInfo({ kind: "type", typeID: row.typeID, itemID: row.structureID })}>{placeName(row)}</button></td>
            <td>{serviceChoices.filter(service => hasService(row, service.id)).map(service => service.label).join(", ") || "—"}</td>
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
  summary { cursor: pointer; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 4px 6px; border-bottom: 1px solid var(--line, #444); }
  td button { padding: 2px 5px; }
</style>
