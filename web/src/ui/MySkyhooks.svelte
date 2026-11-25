<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { formatInterval, plainText } from "../bridge/clientWords.ts";
  import { skyhookVulnerable, type SkyhookRow } from "../bridge/skyhooks.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { ContextMenu } from "../play/contextMenu.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";

  let { store, flow, systemID }: { store: ClientStore; flow: AppFlow; systemID: number } = $props();
  const station = $derived(store.station);
  const words = $derived(store.words);
  const names = $derived(store.names);
  const waypoints = $derived(flow.waypoints);
  const menu = new ContextMenu();
  let listing = $state.raw<Awaited<ReturnType<AppFlow["loadMySkyhooks"]>> | null>(null);
  let error = $state("");
  let search = $state("");
  let distance = $state("");
  let region = $state("");
  let state = $state("");
  let theft = $state("");
  let sort = $state(0);
  let descending = $state(false);
  let now = $state(Date.now());

  const labels = {
    jumps: ["UI/Common/Jumps", "Jumps"], security: ["UI/Common/Security", "Security"],
    system: ["UI/Common/SolarSystem", "Solar System"], name: ["UI/Common/Name", "Name"],
    state: ["UI/StructureBrowser/SkyhookState", "State"], harvest: ["UI/StructureBrowser/SkyhookHarvest", "Harvest"],
    theft: ["UI/StructureBrowser/SkyhookTheftVulnerability", "Theft Vulnerability"],
    vulnerable: ["UI/Structures/States/Vulnerable", "Vulnerable"], reinforced: ["UI/Structures/States/Reinforced", "Reinforced"],
    secure: ["UI/OrbitalSkyhook/TheftStates/Secure", "Secure"],
    power: ["UI/Sovereignty/Power", "Power"], workforce: ["UI/Sovereignty/Workforce", "Workforce"],
    na: ["UI/StructureBrowser/NotApplicable", "N/A"],
    unknown: ["UI/OrbitalSkyhook/SkyhookWnd/NoDataAvailable", "No Data Available"],
    empty: ["UI/Structures/Browser/NoStructuresFound", "No structures found"],
    filtered: ["UI/Structures/Browser/NoStructuresFoundWithFilters", "No structures found with these filters"],
  } as const;
  const columns = ["jumps", "security", "system", "name", "state", "harvest", "theft"] as const;
  const label = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const locationName = (id: number) => resolvedName($names.resolved, "evelocation", id, String(id));
  const typeName = (id: number) => resolvedName($names.resolved, "type", id, id === 81080 ? "Orbital Skyhook" : String(id));
  const skyhookName = (row: SkyhookRow) => `${typeName(row.typeID)} - ${locationName(row.planetID)}`;
  const stateText = (row: SkyhookRow) => row.state ? label(skyhookVulnerable(row.state) ? "vulnerable" : "reinforced") : "";
  const regions = $derived([...new Set((listing?.rows ?? []).flatMap(row => row.regionID === null ? [] : [row.regionID]))]
    .sort((left, right) => locationName(left).localeCompare(locationName(right))));

  function harvestText(row: SkyhookRow): string {
    const harvest = row.harvest;
    if (!harvest) return "–";
    if ("typeID" in harvest) return `${typeName(harvest.typeID)} (${harvest.perMinute.toLocaleString(undefined, { maximumFractionDigits: 2 })}/min)`;
    const difference = harvest.difference === undefined ? "" : ` (${harvest.difference}%)`;
    return `${label(harvest.kind)} (${harvest.amount.toLocaleString()}${difference})`;
  }

  function theftText(row: SkyhookRow): string {
    if (row.harvest && "kind" in row.harvest) return label("na");
    if (!row.theft || row.theft.end <= now) return label("unknown");
    const until = row.theft.vulnerable ? row.theft.end : row.theft.start;
    return `${label(row.theft.vulnerable ? "vulnerable" : "secure")} (${formatInterval(Math.max(0, until - now) * 10_000)})`;
  }

  const visible = $derived.by(() => {
    const needle = search.trim().toLocaleLowerCase();
    const activeRegion = region ? Number(region) : listing?.currentRegionID;
    const values = (row: SkyhookRow) => [row.jumps ?? Infinity, row.security ?? -Infinity, locationName(row.systemID),
      skyhookName(row), stateText(row), harvestText(row),
      row.theft ? (row.theft.vulnerable ? 0 : 1) + (row.theft.vulnerable ? row.theft.end : row.theft.start) / 1e15 : 3];
    return (listing?.rows ?? []).filter(row => {
      if (distance === "system" && row.systemID !== systemID) return false;
      if (distance === "region" && row.regionID !== activeRegion) return false;
      if (distance !== "" && Number(distance) > 0 && (row.jumps ?? Infinity) > Number(distance)) return false;
      if (state && skyhookVulnerable(row.state) !== (state === "vulnerable")) return false;
      if (theft && (row.theft?.vulnerable === true) !== (theft === "vulnerable")) return false;
      return !needle || [skyhookName(row), locationName(row.systemID), row.regionID ? locationName(row.regionID) : "",
        stateText(row), harvestText(row)].join(" ").toLocaleLowerCase().includes(needle);
    }).sort((left, right) => {
      const a = values(left)[sort], b = values(right)[sort];
      const order = typeof a === "number" && typeof b === "number" ? a === b ? 0 : a < b ? -1 : 1 : String(a).localeCompare(String(b));
      return (descending ? -order : order) || skyhookName(left).localeCompare(skyhookName(right)) || left.id - right.id;
    });
  });

  function sortBy(index: number): void {
    descending = sort === index && !descending;
    sort = index;
  }

  function rowMenu(event: MouseEvent, row: SkyhookRow): void {
    event.preventDefault();
    menu.open(event.clientX, event.clientY, [
      { label: "Show Info", info: true, run: () => showInfo({ kind: "type", itemID: row.id, typeID: row.typeID }) },
      { label: "Location", sub: [
        { label: "Set Destination", run: () => flow.setDestination(row.systemID) },
        $waypoints.includes(row.systemID)
          ? { label: "Remove Waypoint", run: () => flow.clearWaypoints(row.systemID) }
          : { label: "Add Waypoint", run: () => flow.addWaypoint(row.systemID) },
      ] },
    ]);
  }

  $effect(() => {
    flow.requestWords(Object.values(labels).map(([path]) => path));
    const clock = setInterval(() => { now = Date.now(); }, 60000);
    return () => { clearInterval(clock); menu.close(); };
  });

  $effect(() => {
    const here = systemID;
    void $station.online?.characterID;
    void $station.online?.corporationID;
    listing = null;
    error = "";
    let current = true;
    void flow.loadMySkyhooks(here).then(rows => {
      if (current) listing = rows;
    }).catch(cause => {
      if (current) error = cause instanceof Error ? cause.message : String(cause);
    });
    return () => { current = false; };
  });
</script>

<div class="skyhook-filters">
  <label>Search <input type="search" bind:value={search} /></label>
  <label>Range <select bind:value={distance}>
    <option value="">Any Distance</option><option value="system">Current System</option>
    <option value="2">Within 2 Jumps</option><option value="5">Within 5 Jumps</option><option value="10">Within 10 Jumps</option>
    <option value="region">Region</option>
  </select></label>
  {#if distance === "region"}
    <label>Region <select bind:value={region}>
      <option value="">Current Region</option>
      {#each regions as id (id)}<option value={String(id)}>{locationName(id)}</option>{/each}
    </select></label>
  {/if}
  <label>{label("state")} <select bind:value={state}>
    <option value="">{label("state")}</option><option value="reinforced">{label("reinforced")}</option>
    <option value="vulnerable">{label("vulnerable")}</option>
  </select></label>
  <label>{label("theft")} <select bind:value={theft}>
    <option value="">{label("theft")}</option><option value="secure">{label("secure")}</option>
    <option value="vulnerable">{label("vulnerable")}</option>
  </select></label>
</div>
{#if error}<p role="alert">{error}</p>{:else if !listing}<p role="status">Reading skyhooks…</p>{/if}
<div class="skyhook-directory">
  <table>
    <thead><tr>{#each columns as column, index (column)}
      <th scope="col" aria-sort={index === sort ? descending ? "descending" : "ascending" : "none"}>
        <button type="button" onclick={() => sortBy(index)}>{label(column)}</button>
      </th>
    {/each}</tr></thead>
    <tbody>{#each visible as row (row.id)}
      <tr data-skyhook-id={row.id} oncontextmenu={(event) => rowMenu(event, row)}>
        <td>{row.jumps ?? "–"}</td><td>{row.security === null ? "–" : shownSecurity(row.security).toFixed(1)}</td>
        <td>{locationName(row.systemID)}</td>
        <td><button type="button" onclick={() => showInfo({ kind: "type", itemID: row.id, typeID: row.typeID })}>{skyhookName(row)}</button></td>
        <td>{stateText(row)}</td><td>{harvestText(row)}</td><td>{theftText(row)}</td>
      </tr>
    {/each}</tbody>
  </table>
  {#if listing && !visible.length}<p role="status">{label(listing.rows.length ? "filtered" : "empty")}</p>{/if}
</div>

<style>
  .skyhook-filters { display: flex; flex-wrap: wrap; gap: 8px; }
  .skyhook-filters label { display: flex; align-items: center; gap: 4px; }
  .skyhook-filters input, .skyhook-filters select { color: inherit; background: #11191d; border: 1px solid #43525c; padding: 4px; }
  .skyhook-directory { overflow: auto; min-height: 0; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 4px 7px; border-bottom: 1px solid #324046; }
  th { background: #1b2529; position: sticky; top: 0; }
  tr:hover td { background: #26343b; }
  th button, td button { border: 0; background: transparent; color: inherit; padding: 0; text-align: inherit; cursor: pointer; }
</style>
