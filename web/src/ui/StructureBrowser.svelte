<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { hasMoonStationManagerRole } from "../bridge/moonMining.ts";
  import { isNpcCorporation } from "../bridge/ownerInfo.ts";
  import { isStation } from "../bridge/placeChanges.ts";
  import { sessionPlace } from "../bridge/sessionPlace.ts";
  import type { StructureBrowserEntry } from "../bridge/structures.ts";
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
  let rows = $state.raw<readonly StructureBrowserEntry[]>([]);
  let loading = $state(true);
  let error = $state("");

  const labels = {
    all: ["UI/Structures/Browser/AllStructures", "All Structures"],
    corporation: ["UI/Structures/Browser/MyStructures", "My Corp Structures"],
    withProfile: ["UI/StructureBrowser/StructuresWithProfile", "Structures"],
    extractions: ["UI/Moonmining/UpcomingExtractionsTab", "Upcoming Extractions"],
    empty: ["UI/Structures/Browser/NoStructuresFound", "No structures found"],
  } as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const placeName = (row: StructureBrowserEntry) => row.itemName || resolvedName($names.resolved,
    isStation(row.structureID) ? "station" : "structure", row.structureID, String(row.structureID));
  const ordered = $derived([...rows].sort((left, right) => placeName(left).localeCompare(placeName(right))));

  $effect(() => {
    flow.requestWords(Object.values(labels).map(([key]) => key));
  });

  $effect(() => {
    const here = systemID;
    const owned = activeTab === "corporation";
    void $station.online?.characterID;
    if (owned) void corporationID;
    rows = [];
    loading = false;
    error = "";
    if (here === null || scheduleOpen) return;
    let current = true;
    loading = true;
    void flow.loadStructureBrowser(here, owned).then(result => {
      if (current) rows = result;
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
  {/if}
  {#if scheduleOpen}
    <CorporationMoonSchedule {store} {flow} />
  {:else if loading}
    <p role="status">Loading structures…</p>
  {:else if error}
    <p role="alert" class="error">{error}</p>
  {:else if ordered.length === 0}
    <p role="status">{word("empty")}</p>
  {:else}
    <table aria-label={word(activeTab)}>
      <thead><tr><th scope="col">System</th><th scope="col">Owner</th><th scope="col">Name</th><th scope="col">Type</th></tr></thead>
      <tbody>
        {#each ordered as row (row.structureID)}
          <tr data-structure-id={row.structureID}>
            <td>{resolvedName($names.resolved, "evelocation", row.solarSystemID, String(row.solarSystemID))}</td>
            <td>{resolvedName($names.resolved, "corporation", row.ownerID, String(row.ownerID))}</td>
            <td>{placeName(row)}</td>
            <td><button type="button" onclick={() => showInfo({ kind: "type", typeID: row.typeID })}>
              {resolvedName($names.resolved, "type", row.typeID, String(row.typeID))}
            </button></td>
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
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 4px 6px; border-bottom: 1px solid var(--line, #444); }
  td button { padding: 2px 5px; }
</style>
