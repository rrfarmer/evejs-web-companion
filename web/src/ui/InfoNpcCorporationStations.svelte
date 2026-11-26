<script lang="ts">
  import { loadStationStatic } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { npcStationServices, NPC_STATION_SERVICE_LABELS } from "../bridge/npcStationServices.ts";
  import type { BookmarkPlace } from "../bridge/locationsList.ts";
  import { isDeprecatedStationType } from "../nav/waypoints.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { StationStatic } from "../store/types.ts";
  import { resolvedName, type NameKind } from "../store/names.ts";
  import BookmarkWindow from "./BookmarkWindow.svelte";
  import HomeStationPanel from "./HomeStationPanel.svelte";
  import { showInfo } from "./showInfo.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow, corporationID }: { store: ClientStore; flow: AppFlow; corporationID: number } = $props();
  const names = $derived(store.names);
  const words = $derived(store.words);
  const station = $derived(store.station);
  const flight = $derived(store.flight);
  const waypoints = $derived(flow.waypoints);
  const name = (kind: NameKind, id: number) => resolvedName($names.resolved, kind, id, "");
  const routeWords = "UI/InfoWindow/LocationAndRoute";
  const noRouteWords = "UI/InfoWindow/LocationNoRoute";
  const destination = "UI/Inflight/SetDestination";
  const addWaypoint = "UI/Inflight/AddWaypoint";
  const removeWaypoint = "UI/Inflight/RemoveWaypoint";
  const showInfoLabel = "UI/Commands/ShowInfo";
  const bookmarkLabel = "UI/Inflight/BookmarkLocation";
  const homeLabel = "UI/Menusvc/SetHomeStation";
  const requiredStanding = "UI/Standings/StationServiceStandingsRequired";
  const word = (path: string, own: string) => plainText($words.templates[path] ?? "") || own;
  type Rows = Awaited<ReturnType<AppFlow["npcCorporationStations"]>>;
  let rows = $state.raw<Rows | null>(null);
  let error = $state("");
  let stationError = $state("");
  let menu = $state<number | null>(null);
  let menuDetails = $state.raw<StationStatic | null>(null);
  let bookmark = $state.raw<BookmarkPlace | null>(null);
  let home = $state<number | null>(null);
  const stationReads = new Map<number, Promise<StationStatic>>();
  const docked = $derived($flight.status?.docked ?? !!($station.online?.stationID || $station.online?.structureID));
  const canBookmark = $derived(menuDetails?.stationTypeID != null && !isDeprecatedStationType(menuDetails.stationTypeID));
  const canSetHome = $derived(canBookmark && docked && menuDetails?.systemFactionID !== 500026);
  type ServiceRows = ReturnType<typeof npcStationServices>;
  type Expansion = { status: "loading" } | { status: "ready"; rows: ServiceRows } | { status: "error"; message: string };
  let expanded = $state.raw<ReadonlyMap<number, Expansion>>(new Map());
  $effect(() => {
    const owner = corporationID;
    flow.requestWords([routeWords, noRouteWords, destination, addWaypoint, removeWaypoint, showInfoLabel, bookmarkLabel, homeLabel, requiredStanding,
      ...NPC_STATION_SERVICE_LABELS.map(([label]) => label)]);
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
  function stationDetails(id: number): Promise<StationStatic> {
    let read = stationReads.get(id);
    if (!read) {
      read = loadStationStatic(id, flow.requestOptions()).then(details => {
        if (!details) throw new Error("The station could not be read.");
        return details;
      }).catch(cause => { stationReads.delete(id); throw cause; });
      stationReads.set(id, read);
    }
    return read;
  }
  function closeMenu() {
    menu = null;
    menuDetails = null;
  }
  async function toggleMenu(id: number) {
    if (menu === id) { closeMenu(); return; }
    menu = id;
    menuDetails = null;
    stationError = "";
    try {
      const details = await stationDetails(id);
      if (menu === id) menuDetails = details;
    } catch (cause) {
      if (menu === id) stationError = panelErrorWords(cause);
    }
  }
  async function inspect(id: number) {
    stationError = "";
    try {
      const place = await stationDetails(id);
      if (place.stationTypeID === null) throw new Error("The station's type could not be read.");
      showInfo({ kind: "spaceObject", itemID: id, typeID: place.stationTypeID });
    } catch (cause) { stationError = panelErrorWords(cause); }
  }
  function saveBookmark(details: StationStatic) {
    closeMenu();
    home = null;
    bookmark = {
      itemID: details.stationID,
      typeName: () => details.stationTypeName ?? "Station",
      name: () => details.stationName,
      askIfKnown: true,
    };
  }
  async function toggleServices(id: number) {
    const next = new Map(expanded);
    if (next.delete(id)) { expanded = next; return; }
    const pending: Expansion = { status: "loading" };
    expanded = next.set(id, pending);
    function finish(value: Expansion) {
      if (expanded.get(id) === pending) expanded = new Map(expanded).set(id, value);
    }
    try {
      const here = $station.online?.solarSystemID;
      const [details, restrictions, pilotSecurity] = await Promise.all([
        stationDetails(id),
        flow.stationStandingsRestrictions(),
        $station.station?.security ?? (here ? flow.loadStarMap().then(map => map.systems.find(row => row[0] === here)?.[8] ?? null) : null),
      ]);
      if (!details?.serviceIDs) throw new Error("The station services could not be read.");
      const rows = npcStationServices(details, pilotSecurity, restrictions);
      flow.requestNames(rows.flatMap(row => row.restriction ? [{ kind: "owner", id: row.restriction.owner }] : []));
      finish({ status: "ready", rows });
    } catch (cause) { finish({ status: "error", message: panelErrorWords(cause) }); }
  }
  function restrictionHint(restriction: NonNullable<ServiceRows[number]["restriction"]>) {
    const ownerName = name("owner", restriction.owner);
    const template = $words.templates[requiredStanding];
    return template ? plainText(formatTemplate(template, {
      from_id: restriction.owner, required_standing: restriction.required,
    }, { nameOf: (kind, owner) => name(kind, owner) || ownerName }))
      : `Requires ${restriction.required} standings${ownerName ? " with " + ownerName : ""}`;
  }
</script>

<section class="npc-corporation-stations" aria-label="Stations">
  {#if bookmark}
    <BookmarkWindow {store} {flow} place={bookmark} onDone={() => (bookmark = null)} />
  {/if}
  {#if home !== null}
    {#key home}<HomeStationPanel {store} {flow} targetStationID={home} onClose={() => (home = null)} />{/key}
  {/if}
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
          {@const expansion = expanded.get(station.id)}
          <li data-npc-station={station.id}>
            <div class="station-actions">
              <button type="button" class="station-title" aria-expanded={!!expansion} onclick={() => void toggleServices(station.id)}
                oncontextmenu={(event) => { event.preventDefault(); void toggleMenu(station.id); }}>
                <span aria-hidden="true">{expansion ? "▾" : "▸"}</span> {station.name || "Station"}
              </button>
              <button type="button" class="minor station-menu-toggle" aria-label="Station actions" aria-expanded={menu === station.id}
                onclick={() => void toggleMenu(station.id)}>⋯</button>
            </div>
            {#if menu === station.id}
              <div class="controls station-menu">
                {#if $waypoints.at(-1) !== station.id}
                  <button type="button" class="minor" onclick={() => { closeMenu(); flow.setDestination(station.id); }}>{word(destination, "Set Destination")}</button>
                {/if}
                {#if $waypoints.includes(station.id)}
                  <button type="button" class="minor" onclick={() => { closeMenu(); flow.clearWaypoints(station.id); }}>{word(removeWaypoint, "Remove Waypoint")}</button>
                {:else}
                  <button type="button" class="minor" onclick={() => { closeMenu(); flow.addWaypoint(station.id); }}>{word(addWaypoint, "Add Waypoint")}</button>
                {/if}
                {#if canSetHome}
                  <button type="button" class="minor" onclick={() => { closeMenu(); bookmark = null; home = station.id; }}>{word(homeLabel, "Set Home Station")}</button>
                {/if}
                {#if canBookmark && menuDetails}
                  {@const details = menuDetails}
                  <button type="button" class="minor" onclick={() => saveBookmark(details)}>{word(bookmarkLabel, "Save Location")}</button>
                {/if}
                <button type="button" class="minor" onclick={() => { closeMenu(); void inspect(station.id); }}>{word(showInfoLabel, "Show Info")}</button>
              </div>
            {/if}
            {#if expansion?.status === "loading"}
              <p role="status">Reading station services…</p>
            {:else if expansion?.status === "error"}
              <p role="alert">{expansion.message}</p>
            {:else if expansion?.status === "ready"}
              <ul class="station-services">
                {#each [...expansion.rows].sort((a, b) => word(a.label, a.fallback).localeCompare(word(b.label, b.fallback))) as service (service.label)}
                  <li>
                    <img alt="" src={clientTexture(`res:/ui/texture/windowicons/${service.icon}.png`)} />
                    <span>{word(service.label, service.fallback)}</span>
                    {#if service.restriction}
                      {@const hint = restrictionHint(service.restriction)}
                      <img class="standing" alt={hint} title={hint}
                        src={clientTexture("res:/UI/Texture/Classes/Standings/Actions/derivedAgentInFaction.png")} />
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
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
  li { padding-block: 2px; }
  .station-actions, .station-services li { display: flex; align-items: center; gap: 8px; }
  .station-actions { justify-content: space-between; }
  .station-title { padding: 2px 0; border: 0; background: transparent; text-align: left; }
  .station-menu { padding: 4px 0 4px 14px; }
  .station-services { padding-left: 20px; }
  .station-services img { width: 20px; height: 20px; object-fit: contain; }
  .station-services img.standing { margin-left: auto; }
</style>
