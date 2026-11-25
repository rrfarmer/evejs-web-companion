<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { formatInterval, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { hasMoonStationManagerRole } from "../bridge/moonMining.ts";
  import type { BookmarkPlace } from "../bridge/locationsList.ts";
  import { SKYHOOK_TYPE_ID, skyhookFilters, skyhookVulnerable, type SkyhookFilters, type SkyhookRow } from "../bridge/skyhooks.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { avoidanceItems } from "../nav/autopilotSettings.ts";
  import { celestialRouteEntries, isWaypointPlace } from "../nav/waypoints.ts";
  import { ContextMenu, type ContextEntry } from "../play/contextMenu.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";
  import { startItemLinksDrag } from "./linkFollowers.ts";
  import BookmarkWindow from "./BookmarkWindow.svelte";
  import SkyhookConfiguration from "./SkyhookConfiguration.svelte";

  let { store, flow, systemID, onShowSystem, search = $bindable("") }: {
    store: ClientStore; flow: AppFlow; systemID: number; onShowSystem?: (systemID: number) => void; search?: string;
  } = $props();
  const station = $derived(store.station);
  const characterID = $derived($station.online?.characterID ?? null);
  const words = $derived(store.words);
  const names = $derived(store.names);
  const waypoints = $derived(flow.waypoints);
  const menu = new ContextMenu();
  const canConfigure = $derived(hasMoonStationManagerRole($station.online?.corpRole ?? null));
  let configuration = $state.raw<SkyhookRow | null>(null);
  let bookmark = $state.raw<BookmarkPlace | null>(null);
  let listing = $state.raw<Awaited<ReturnType<AppFlow["loadMySkyhooks"]>> | null>(null);
  let error = $state("");
  let filters = $state(skyhookFilters(() => null));
  let regions = $state.raw<Awaited<ReturnType<AppFlow["loadSkyhookRegions"]>>>([]);
  let regionsError = $state("");
  let sort = $state(0);
  let descending = $state(false);
  let now = $state(Date.now());
  let selected = $state<readonly number[]>([]);
  let selectionAnchor: number | null = null;

  const labels = {
    jumps: ["UI/Common/Jumps", "Jumps"], security: ["UI/Common/Security", "Security"],
    system: ["UI/Common/SolarSystem", "Solar System"], name: ["UI/Common/Name", "Name"],
    state: ["UI/StructureBrowser/SkyhookState", "State"], harvest: ["UI/StructureBrowser/SkyhookHarvest", "Harvest"],
    theft: ["UI/StructureBrowser/SkyhookTheftVulnerability", "Theft Vulnerability"],
    vulnerable: ["UI/Structures/States/Vulnerable", "Vulnerable"], reinforced: ["UI/Structures/States/Reinforced", "Reinforced"],
    secure: ["UI/OrbitalSkyhook/TheftStates/Secure", "Secure"],
    raidable: ["UI/OrbitalSkyhook/TheftStates/Vulnerable", "Raidable"],
    power: ["UI/Sovereignty/Power", "Power"], workforce: ["UI/Sovereignty/Workforce", "Workforce"],
    na: ["UI/StructureBrowser/NotApplicable", "N/A"],
    unknown: ["UI/OrbitalSkyhook/SkyhookWnd/NoDataAvailable", "No Data Available"],
    empty: ["UI/Structures/Browser/NoStructuresFound", "No structures found"],
    filtered: ["UI/Structures/Browser/NoStructuresFoundWithFilters", "No structures found with these filters"],
    configure: ["UI/DustLink/ConfigureOrbital", "Configure"],
    anyDistance: ["UI/Agency/ContentOfAnyDistance", "Any Distance"],
    currentSystem: ["UI/Generic/CurrentSystem", "Current System"],
    withinJumps: ["UI/Common/WithinJumps", "Within {numJumps} jumps"],
    region: ["UI/Common/LocationTypes/Region", "Region"],
    currentRegion: ["UI/Generic/CurrentRegion", "Current Region"],
    location: ["UI/Common/Location", "Location"],
    info: ["UI/Commands/ShowInfo", "Show Info"],
    destination: ["UI/Inflight/SetDestination", "Set Destination"],
    addWaypoint: ["UI/Inflight/AddWaypoint", "Add Waypoint"],
    removeWaypoint: ["UI/Inflight/RemoveWaypoint", "Remove Waypoint"],
    saveLocation: ["UI/Inflight/BookmarkLocation", "Save Location…"],
    bookmarkLabel: ["UI/PeopleAndPlaces/NewBookmarkLocationLabel", "{loc} ({group})"],
    map: ["UI/Commands/ShowLocationOnMap", "Show on Map"],
    mapBrowser: ["UI/Inflight/ShowInMapBrowser", "Show {locationType} in Map Browser"],
    avoid: ["UI/Inflight/AvoidLocation", "Avoid {locationType} {theLocation}"],
    stopAvoiding: ["UI/Inflight/StopAvoidingLocation", "Stop Avoiding {locationType} {theLocation}"],
  } as const;
  const columns = ["jumps", "security", "system", "name", "state", "harvest", "theft"] as const;
  const label = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const locationName = (id: number) => resolvedName($names.resolved, "evelocation", id, String(id));
  const typeName = (id: number) => resolvedName($names.resolved, "type", id, id === 81080 ? "Orbital Skyhook" : String(id));
  const skyhookName = (row: SkyhookRow) => `${typeName(row.typeID)} - ${locationName(row.planetID)}`;
  const stateText = (row: SkyhookRow) => row.state ? label(skyhookVulnerable(row.state) ? "vulnerable" : "reinforced") : "";
  const selectedRegion = $derived(regions.some(region => region.id === filters.region) ? filters.region : null);
  const regionNames = $derived(new Map(regions.map(region => [region.id, region.name])));
  const withinJumps = (numJumps: number) => plainText(formatTemplate(
    $words.templates[labels.withinJumps[0]] ?? labels.withinJumps[1], { numJumps }, { nameOf: () => "" }));

  function setFilter<Key extends keyof SkyhookFilters>(key: Key, value: SkyhookFilters[Key]): void {
    filters[key] = value;
    flow.saveSkyhookFilter(key, value);
  }

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
    const activeRegion = selectedRegion ?? listing?.currentRegionID ?? null;
    const values = (row: SkyhookRow) => [row.jumps ?? Infinity, row.security ?? -Infinity, locationName(row.systemID),
      skyhookName(row), stateText(row), harvestText(row),
      row.theft ? (row.theft.vulnerable ? 0 : 1) + (row.theft.vulnerable ? row.theft.end : row.theft.start) / 1e15 : 3];
    return (listing?.rows ?? []).filter(row => {
      const { location, state, theftvulnerability } = filters;
      if (location === 1 && row.systemID !== systemID) return false;
      if (location === -1 && (activeRegion === null || row.regionID !== activeRegion)) return false;
      if (location !== null && location > 1 && (row.jumps ?? Infinity) > location) return false;
      if (state && skyhookVulnerable(row.state) !== (state === "vulnerable")) return false;
      if (theftvulnerability && (row.theft?.vulnerable === true) !== (theftvulnerability === "vulnerable")) return false;
      return !needle || [skyhookName(row), locationName(row.systemID), regionNames.get(row.regionID ?? 0) ?? "",
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

  function selectRow(id: number, event: MouseEvent): void {
    const control = event.ctrlKey || event.metaKey;
    const ids = visible.map(row => row.id);
    const from = selectionAnchor === null ? -1 : ids.indexOf(selectionAnchor);
    const to = ids.indexOf(id);
    if (event.shiftKey && from >= 0 && to >= 0 && from !== to) {
      const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
      selected = control ? [...new Set([...selected, ...range])] : range;
      if (!control) return;
    } else if (!event.shiftKey && control) {
      selected = selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id];
    } else if (!control) {
      selected = [id];
    }
    selectionAnchor = id;
  }

  function dragRows(row: SkyhookRow, event: DragEvent): void {
    if (!selected.includes(row.id)) selectRow(row.id, event);
    startItemLinksDrag(event, visible.filter(item => selected.includes(item.id)).map(item => ({
      url: `showinfo:${item.typeID}//${item.id}`,
      text: skyhookName(item),
    })));
  }

  function action(key: keyof typeof labels, run: () => void): ContextEntry {
    return { path: labels[key][0], label: label(key), run };
  }

  function locationMenu(id: number): (ContextEntry | null)[] {
    const entries: (ContextEntry | null)[] = [];
    const route = celestialRouteEntries(id, isWaypointPlace(id), systemID, $waypoints);
    if (route.setDestination) entries.push(action("destination", () => flow.setDestination(id)));
    if (route.addWaypoint) entries.push(action("addWaypoint", () => flow.addWaypoint(id)));
    if (route.removeWaypoint) entries.push(action("removeWaypoint", () => flow.clearWaypoints(id)));
    if (entries.length) entries.push(null);
    entries.push(action("saveLocation", () => {
      bookmark = {
        itemID: id, askIfKnown: true, typeName: () => label("system"),
        name: () => plainText(formatTemplate($words.templates[labels.bookmarkLabel[0]] ?? labels.bookmarkLabel[1],
          { loc: id, group: label("system") }, { nameOf: () => locationName(id) })),
      };
    }));
    entries.push(null);
    if (onShowSystem) {
      const show = onShowSystem;
      entries.push(action("map", () => show(id)), { ...action("mapBrowser", () => show(id)), label: locationActionLabel("mapBrowser", id) });
    }
    const avoiding = avoidanceItems(flow.autopilotSettings()).includes(id);
    const key = avoiding ? "stopAvoiding" : "avoid";
    entries.push({ ...action(key, () => avoiding ? flow.stopAvoidingLocation(id) : flow.avoidLocation(id)), label: locationActionLabel(key, id) });
    entries.push({ ...action("info", () => showInfo({ kind: "mapLocation", typeID: 5, itemID: id })), info: true });
    return entries;
  }

  function locationActionLabel(key: "mapBrowser" | "avoid" | "stopAvoiding", id: number): string {
    const [path, fallback] = labels[key];
    return plainText(formatTemplate($words.templates[path] ?? fallback,
      { locationType: label("system"), theLocation: id }, { nameOf: () => locationName(id) }));
  }

  function rowMenu(row: SkyhookRow, x: number, y: number): void {
    const entries: (ContextEntry | null)[] = [
      action("saveLocation", () => {
        bookmark = { itemID: row.id, askIfKnown: true, requiresSpace: true,
          name: () => skyhookName(row), typeName: () => typeName(row.typeID) };
      }),
      { ...action("info", () => showInfo({ kind: "type", itemID: row.id, typeID: row.typeID })), info: true },
    ];
    if (canConfigure && row.typeID === SKYHOOK_TYPE_ID) {
      entries.push(action("configure", () => { configuration = row; }));
    }
    if (row.systemID !== systemID) {
      entries.push(null, { path: labels.location[0], label: label("location"), sub: locationMenu(row.systemID) });
    }
    menu.open(x, y, entries);
  }

  $effect(() => {
    flow.requestWords(Object.values(labels).map(([path]) => path));
    const clock = setInterval(() => { now = Date.now(); }, 60000);
    return () => { clearInterval(clock); menu.close(); };
  });

  $effect(() => {
    void characterID;
    filters = flow.readSkyhookFilters();
    regions = [];
    regionsError = "";
    let current = true;
    void flow.loadSkyhookRegions().then(result => {
      if (current) regions = result;
    }).catch(cause => {
      if (current) regionsError = cause instanceof Error ? cause.message : String(cause);
    });
    return () => { current = false; };
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

  $effect(() => {
    if (!canConfigure || !listing?.rows.some(row => row.id === configuration?.id)) configuration = null;
  });

  $effect(() => {
    const ids = new Set(visible.map(row => row.id));
    if (selected.some(id => !ids.has(id))) selected = selected.filter(id => ids.has(id));
    if (selectionAnchor !== null && !ids.has(selectionAnchor)) selectionAnchor = null;
  });
</script>

{#if bookmark}
  {#key bookmark.itemID}<BookmarkWindow {store} {flow} place={bookmark} onDone={() => bookmark = null} />{/key}
{/if}
{#if canConfigure && configuration}
  {#key configuration.id}
    <SkyhookConfiguration {flow} {store} target={configuration} name={skyhookName(configuration)} onClose={() => configuration = null} />
  {/key}
{/if}
<div class="skyhook-filters">
  <label>Search <input type="search" maxlength={64} bind:value={search} /></label>
  <label>Range <select value={String(filters.location ?? "")} onchange={(event) => setFilter("location",
      event.currentTarget.value === "" ? null : Number(event.currentTarget.value) as SkyhookFilters["location"])}>
    <option value="">{label("anyDistance")}</option><option value="1">{label("currentSystem")}</option>
    {#each [2, 5, 10] as jumps}<option value={String(jumps)}>{withinJumps(jumps)}</option>{/each}
    <option value="-1">{label("region")}</option>
  </select></label>
  {#if filters.location === -1}
    <label>{label("region")} <select value={String(selectedRegion ?? "")} onchange={(event) =>
        setFilter("region", event.currentTarget.value === "" ? null : Number(event.currentTarget.value))}>
      <option value="">{label("currentRegion")}</option>
      {#each regions as region (region.id)}<option value={String(region.id)}>{region.name}</option>{/each}
    </select></label>
    {#if regionsError}<p role="alert">{regionsError}</p>{/if}
  {/if}
  <label>{label("state")} <select value={filters.state ?? ""} onchange={(event) =>
      setFilter("state", event.currentTarget.value as Exclude<SkyhookFilters["state"], null> || null)}>
    <option value="">{label("state")}</option><option value="reinforced">{label("reinforced")}</option>
    <option value="vulnerable">{label("vulnerable")}</option>
  </select></label>
  <label>{label("theft")} <select value={filters.theftvulnerability ?? ""} onchange={(event) =>
      setFilter("theftvulnerability", event.currentTarget.value as Exclude<SkyhookFilters["theftvulnerability"], null> || null)}>
    <option value="">{label("theft")}</option><option value="secure">{label("secure")}</option>
    <option value="vulnerable">{label("raidable")}</option>
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
      <tr data-skyhook-id={row.id} aria-selected={selected.includes(row.id)} draggable="true"
        onclick={(event) => selectRow(row.id, event)} ondragstart={(event) => dragRows(row, event)}
        oncontextmenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        rowMenu(row, event.clientX, event.clientY);
      }}>
        <td>{row.jumps ?? "–"}</td><td>{row.security === null ? "–" : shownSecurity(row.security).toFixed(1)}</td>
        <td>{locationName(row.systemID)}</td>
        <td><button type="button" draggable="true"
          onkeydown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            event.stopPropagation();
            const bounds = event.currentTarget.getBoundingClientRect();
            rowMenu(row, bounds.left, bounds.bottom);
          }}
          onclick={(event) => {
            if (!event.ctrlKey && !event.metaKey && !event.shiftKey) showInfo({ kind: "type", itemID: row.id, typeID: row.typeID });
          }}>{skyhookName(row)}</button></td>
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
  tr[aria-selected="true"] td { background: #344950; }
  th button, td button { border: 0; background: transparent; color: inherit; padding: 0; text-align: inherit; cursor: pointer; }
</style>
