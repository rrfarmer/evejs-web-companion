<script lang="ts">
  import { resolveDestination } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName, type NameKind } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";

  let { store, flow, corporationID }: { store: ClientStore; flow: AppFlow; corporationID: number } = $props();
  const names = $derived(store.names);
  const words = $derived(store.words);
  const name = (kind: NameKind, id: number) => resolvedName($names.resolved, kind, id, "");
  const routeWords = "UI/InfoWindow/LocationAndRoute";
  const noRouteWords = "UI/InfoWindow/LocationNoRoute";
  const destination = "UI/Commands/SetDestination";
  type Rows = Awaited<ReturnType<AppFlow["npcCorporationStations"]>>;
  let rows = $state.raw<Rows | null>(null);
  let error = $state("");
  let stationError = $state("");
  $effect(() => {
    const owner = corporationID;
    flow.requestWords([routeWords, noRouteWords, destination]);
    let current = true;
    rows = null;
    error = "";
    void flow.npcCorporationStations(owner).then(result => { if (current) rows = result; })
      .catch(cause => { if (current) error = panelErrorWords(cause); });
    return () => { current = false; };
  });
  const groups = $derived.by(() => {
    const grouped = new Map<number, { path: string; jumps: number | null; stations: { id: number; name: string }[] }>();
    for (const row of rows ?? []) {
      let group = grouped.get(row.systemID);
      if (!group) {
        const path = (["system", "systemConstellation", "systemRegion"] as const)
          .map(kind => name(kind, row.systemID)).filter(Boolean).join(" / ");
        group = { path, jumps: row.jumps, stations: [] };
        grouped.set(row.systemID, group);
      }
      group.stations.push({ id: row.stationID, name: name("station", row.stationID) });
    }
    return [...grouped.values()].sort((a, b) =>
      (a.jumps ?? Infinity) - (b.jumps ?? Infinity) || a.path.localeCompare(b.path))
      .map(group => ({ ...group, stations: group.stations.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id) }));
  });
  function heading(path: string, jumps: number | null) {
    const label = $words.templates[jumps === null ? noRouteWords : routeWords];
    return label ? plainText(formatTemplate(label, { locationName: path, numJump: jumps }, { nameOf: () => "" }))
      : jumps === null ? path : `${path} (${jumps} jumps)`;
  }
  async function inspect(id: number) {
    stationError = "";
    try {
      const place = await resolveDestination(id, flow.requestOptions());
      if (place.stationTypeID === null) throw new Error("The station's type could not be read.");
      showInfo({ kind: "spaceObject", itemID: id, typeID: place.stationTypeID });
    } catch (cause) { stationError = panelErrorWords(cause); }
  }
</script>

<section class="npc-corporation-stations" aria-label="Stations">
  {#if error}
    <p role="alert">{error}</p>
  {:else if rows === null}
    <p role="status">Reading stations…</p>
  {:else if rows.length === 0}
    <p role="status">No stations.</p>
  {:else}
    {#each groups as group}
      <h3>{heading(group.path || "Solar system", group.jumps)}</h3>
      <ul>
        {#each group.stations as station (station.id)}
          <li data-npc-station={station.id}>
            <button type="button" class="evelink" onclick={() => void inspect(station.id)}>{station.name || "Station"}</button>
            <button type="button" class="minor" onclick={() => flow.setDestination(station.id)}>{plainText($words.templates[destination] ?? "") || "Set Destination"}</button>
          </li>
        {/each}
      </ul>
    {/each}
  {/if}
  {#if stationError}<p role="alert">{stationError}</p>{/if}
</section>

<style>
  h3 { margin-block: 12px 4px; }
  ul { margin: 0; padding: 0 0 0 12px; list-style: none; }
  li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-block: 2px; }
  .evelink { padding: 0; border: 0; background: transparent; color: var(--theme-focus, #91bfd7); text-align: left; }
</style>
