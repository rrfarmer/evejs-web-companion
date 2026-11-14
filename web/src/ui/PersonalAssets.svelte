<script lang="ts">
  // Personal Assets page (goal R37): where this character's stuff is, and a
  // course set to any of it.
  //
  // A pure reader of the store's assets slice. Nothing here shows a stationID,
  // a systemID, a typeID or an itemID (R7d) — a place is its NAME and a thing
  // is its NAME, resolved through the shared name cache. Raw ids appear only in
  // `{#each}` keys and in onclick arguments, which is where the R7d note in
  // store/names.ts says they belong.
  //
  // ⚠ THE STATION LIST IS THE SERVER'S OWN AGGREGATION. charMgr.ListStations
  // resolves every item up its container chain and groups by dockable location;
  // this panel renders that answer and never rebuilds it by walking containers.
  //
  // ⚠ THREE OUTCOMES, THREE DIFFERENT SENTENCES. "Still loading", "that read
  // failed" and "you genuinely own nothing anywhere" are distinct facts, and
  // the last one is claimed ONLY from a successful empty read (`ownsNothing`).
  // Conflating them is the defect this codebase keeps producing.
  //
  // READS ONLY, plus a station's route entries, as the client's assets window gives them (its location's menu,
  // assetsWindow.py GetMenuLocationMenu 851 to 862: the station's CelestialMenu): Set Destination, and Add Waypoint
  // or Remove Waypoint (menusvc.py 2002 to 2007), the flow's waypoints (nav/waypoints.ts).
  import { getContext, onMount } from "svelte";
  import {
    formatAssetVolume,
    formatUnits,
    totalVolume,
  } from "../bridge/personalAssets.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { AssetStationRow } from "../store/types.ts";
  import { resolvedName } from "../store/names.ts";
  import TypeIcon from "./TypeIcon.svelte";
  import AssetSafetyList from "./AssetSafetyList.svelte";
  import LabelText from "./LabelText.svelte";
  import { invItemColumns, invItemGridColumns, INV_ITEM_DEFAULT_HIDDEN, INV_ITEM_COLUMN_WORDS, type InvItem } from "./invItemColumns.ts";
  import type { AssetTypeFacts } from "../app/flow.ts";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { shownSecurity, securityStatusRgb } from "../bridge/systemSecurity.ts";
  import { assetsSearchTarget } from "./assetsSearch.ts";
  import type { AssetSearchItem, AssetSearchLocation } from "../bridge/assetSearch.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const assets = store.assets;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const travel = store.travel;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const waypoints = flow.waypoints;

  /** The client's words for the route entries, and the page's own where the install's are not to hand. */
  const ROUTE_WORDS = {
    setDestination: "UI/Inflight/SetDestination",
    addWaypoint: "UI/Inflight/AddWaypoint",
    removeWaypoint: "UI/Inflight/RemoveWaypoint",
  } as const;

  function word(label: string, own: string): string {
    const template = $words.templates[label];
    return typeof template === "string" ? template : own;
  }

  /** The station whose menu is open, or none. */
  let menuFor = $state<number | null>(null);

  /**
   * CelestialChecker.OfferSetDestination (celestialCheckers.py 1354 to 1362): a station can be a waypoint (it has a
   * system), and is offered unless it is the route's last waypoint already.
   */
  function destinationOffered(stationID: number): boolean {
    return $waypoints.at(-1) !== stationID;
  }

  let busy = $state(false);
  let error = $state("");

  /** Always a NAME, never an id — and never an id-shaped fallback either. */
  function stationName(stationID: number): string {
    return resolvedName($names.resolved, "station", stationID, "an unnamed place");
  }

  function systemName(systemID: number): string {
    return resolvedName($names.resolved, "system", systemID, "an unnamed system");
  }

  function itemName(typeID: number): string {
    return resolvedName($names.resolved, "type", typeID, "an unnamed item");
  }

  /** How many stacks this station holds, in words rather than a bare number. */
  function stackText(count: number): string {
    return count === 1 ? "1 item" : `${count.toLocaleString()} items`;
  }

  const stationCount = $derived($assets.stations.length);

  // assetsWindow.GetLocationData (599 to 606): each place's route from where the pilot is, the autopilot's way with the
  // pilot's settings (GetAutopilotJumpCount), and "No gate-to-gate route" where there is none.
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  const hereSystem = $derived($flight.status?.solarSystemID ?? null);
  const NO_ROUTE = "UI/Generic/NoGateToGateRoute";
  function routeText(row: AssetStationRow): string {
    if (hereSystem === null) return "";
    if (row.solarSystemID === hereSystem) return "0";
    const count = $names.autopilotJumps[`${hereSystem}:${row.solarSystemID}`];
    if (count === undefined) return "";
    return count === null ? word(NO_ROUTE, "No route") : String(count);
  }
  // Asked again when the autopilot's settings change, which lets the counts go.
  $effect(() => {
    void $names.autopilotJumps;
    if (hereSystem === null) return;
    const systems = [...new Set($assets.stations.map((row) => row.solarSystemID).filter((id) => id > 0 && id !== hereSystem))];
    if (systems.length > 0) flow.requestAutopilotJumps(hereSystem, systems);
  });

  const openStation = $derived(
    $assets.expandedStationID === null
      ? null
      : ($assets.contents[$assets.expandedStationID] ?? null),
  );

  const openStationVolume = $derived(
    openStation === null ? null : totalVolume(openStation.items),
  );

  async function run(action: () => Promise<void>): Promise<void> {
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      error = isSessionLost(cause)
        ? "Your session ended. Pick your character again."
        : cause instanceof Error
          ? cause.message
          : String(cause);
    } finally {
      busy = false;
    }
  }

  function toggle(row: AssetStationRow): void {
    const next = $assets.expandedStationID === row.stationID ? null : row.stationID;
    void run(() => flow.openAssetStation(next));
  }

  /** The menu's route entries (menusvc.py 2002 to 2007): starmap.SetWaypoint(id, True), SetWaypoint(id), ClearWaypoints(id). */
  function route(row: AssetStationRow, how: "destination" | "add" | "remove"): void {
    menuFor = null;
    if (how === "destination") void run(() => flow.setDestinationToAssetStation(row.stationID));
    else if (how === "add") flow.addWaypoint(row.stationID);
    else flow.clearWaypoints(row.stationID);
  }

  // The window's tabs (assetsWindow._ReconstructTabs, 186 to 201): its list of where the pilot's things are, and Search.
  // (Asset Safety, the third, is not the page's.)
  /**
   * On the play page the window as AssetsWindow lays it out (assetsWindow.py: 550 x 450; _ReconstructTabs - the header's
   * tabs Personal Assets (its caption), Search, Asset Safety (UI/Inventory/AssetSafety/AssetSafety)). Asset Safety is
   * not built.
   */
  const retail = getContext("retailChrome") === true;
  let safetyTab = $state(false);
  $effect(() => { if (retail) flow.requestWords(["UI/Inventory/AssetSafety/AssetSafety"]); });
  const TAB_WORDS = {
    allitems: "Tooltips/Neocom/PersonalAssets",
    search: "UI/Common/Buttons/Search",
    searchText: "UI/Common/SearchText",
    searching: "UI/Common/Searching",
    nothingFound: "UI/Common/NothingFound",
  } as const;
  let tab = $state<"allitems" | "search">("allitems");
  // assetsWindow.py's All Items list on the play page (LoadAssets / PopulateScroll / GetLocationData): the Sort By combo
  // (SORT_BY_OPTIONS - Name, Number of Jumps, Number of Items; settings.char.ui assetsSortKey), then a locked
  // LocationGroup per location labelled LocationDataLabel ("<sec> <location> - <n> Jumps - <n> items"; NoRoute where
  // the autopilot has none), sorted by the key (name, jumps or the count first, then the others), each opening to the
  // location's items (InvAssetItem rows under GetInvItemDefaultHeaders - here Name, Quantity and Volume); its menu the
  // location's (GetMenuLocationMenu: the route entries).
  const ASSET_WORDS = {
    sortBy: "UI/Common/SortBy", name: "UI/Common/Name", jumps: "UI/Common/NumberOfJumps", items: "UI/Common/NumberOfItems",
    label: "UI/Inventory/AssetsWindow/LocationDataLabel", noRoute: "UI/Inventory/AssetsWindow/LocationDataLabelNoRoute",
    quantity: "UI/Common/Quantity", volume: "UI/Inventory/ItemVolume", noAssets: "UI/Inventory/AssetsWindow/NoAssetsAtStation",
    nothing: "UI/Common/NothingFound",
  } as const;
  const SORT_KEY = "evejs.play.assetsSortKey";
  let assetsSortKey = $state((() => { try { const k = Number(localStorage.getItem(SORT_KEY)); return k === 1 || k === 2 ? k : 0; } catch { return 0; } })());
  function setAssetsSort(key: number): void { assetsSortKey = key; try { localStorage.setItem(SORT_KEY, String(key)); } catch { /* not kept */ } }
  const nameOfRef = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const text = (label: string, args: Record<string, unknown> = {}) => formatTemplate($words.templates[label] ?? "", args as never, { nameOf: nameOfRef });
  const followerOf = (url: string, t: string) => linkFollowerOf(url, flow, null, (label) => plainText($words.templates[label] ?? LINK_WORDS[label] ?? ""), t);
  /** solar_system_security_status: the rounded level in its colour. */
  function secStatus(systemID: number): string {
    const level = $names.systemSecurity[systemID];
    if (level === undefined || level === null) return "";
    const shown = shownSecurity(level), [r, g, b] = securityStatusRgb(level);
    const hex = [r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
    return `<color=0xff${hex}>${shown.toFixed(1)}</color>`;
  }
  function jumpsTo(row: AssetStationRow): number | null | undefined {
    if (hereSystem === null) return undefined;
    if (row.solarSystemID === hereSystem) return 0;
    return $names.autopilotJumps[`${hereSystem}:${row.solarSystemID}`];
  }
  function locationLabel(row: AssetStationRow): string {
    const jumps = jumpsTo(row);
    const args = { location: row.stationID, itemCount: row.itemCount, jumps: jumps ?? 0, secStatus: secStatus(row.solarSystemID) };
    return text(jumps === null ? ASSET_WORDS.noRoute : ASSET_WORDS.label, args);
  }
  // The open location's items as InvAssetItem rows (GetSubContent, uix.GetItemData): the inventory's columns
  // (invItemColumns.ts, as the corporation's assets), hidden and sorted as the scroll keeps them (settings.user.ui
  // filteredColumns / filteredColumnsByDefault / scrollsortby, scroll 'assets'); a header's right button its
  // Hide / Show menu (Scroll.GetHeaderMenu).
  let typeFacts = $state<ReadonlyMap<number, AssetTypeFacts>>(new Map());
  const COLUMNS = invItemColumns({ text: (label, args) => text(label, args ?? {}), nameOf: nameOfRef, facts: () => typeFacts, templates: () => $words.templates });
  const readKept = (key: string, fallback: string[]) => { try { const v = JSON.parse(localStorage.getItem(`evejs.play.${key}`) ?? "null"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fallback; } catch { return fallback; } };
  let hiddenColumns = $state<string[]>(readKept("filteredColumns_assets", []));
  let hiddenByDefault = $state<string[]>(readKept("filteredColumnsByDefault_assets", [...INV_ITEM_DEFAULT_HIDDEN]));
  const shownColumns = $derived(COLUMNS.filter((c) => !hiddenColumns.includes(c.label) && !hiddenByDefault.includes(c.label)));
  const itemGrid = $derived(invItemGridColumns(shownColumns));
  let headerMenuFor = $state<string | null>(null);
  const keepList = (key: string, list: string[]) => { try { localStorage.setItem(`evejs.play.${key}`, JSON.stringify(list)); } catch { /* not kept */ } };
  function hideColumn(label: string): void { headerMenuFor = null; if (!hiddenColumns.includes(label)) hiddenColumns = [...hiddenColumns, label]; keepList("filteredColumns_assets", hiddenColumns); }
  function showColumn(label: string): void {
    headerMenuFor = null;
    hiddenColumns = hiddenColumns.filter((l) => l !== label); hiddenByDefault = hiddenByDefault.filter((l) => l !== label);
    keepList("filteredColumns_assets", hiddenColumns); keepList("filteredColumnsByDefault_assets", hiddenByDefault);
  }
  const keptSort = (() => { try { return JSON.parse(localStorage.getItem("evejs.play.scrollsortby_assets") ?? "null") as [string, boolean] | null; } catch { return null; } })();
  let sortColumn = $state<string | null>(keptSort?.[0] ?? "UI/Common/Name"), sortReversed = $state(keptSort?.[1] ?? false);
  function sortOn(label: string): void {
    sortReversed = sortColumn === label ? !sortReversed : false; sortColumn = label;
    try { localStorage.setItem("evejs.play.scrollsortby_assets", JSON.stringify([sortColumn, sortReversed])); } catch { /* not kept */ }
  }
  /** The store's row as the columns read an item: its stack the units (1 for an assembled thing, whose quantity is -1), singleton 1. */
  const invItem = (item: { itemID: number; typeID: number; units: number; singleton: boolean }): InvItem =>
    ({ itemID: item.itemID, typeID: item.typeID, stacksize: item.units, singleton: item.singleton ? 1 : 0 });
  const openItems = $derived.by(() => {
    if (openStation === null || openStation.error || openStation.hasNoItems) return [] as InvItem[];
    const list = openStation.items.map(invItem);
    const col = COLUMNS.find((c) => c.label === sortColumn);
    if (!col) return list;
    const out = list.slice().sort((a, b) => { const x = col.sort(a), y = col.sort(b); return x < y ? -1 : x > y ? 1 : 0; });
    return sortReversed ? out.reverse() : out;
  });
  $effect(() => {
    if (!retail || openStation === null || openStation.error) return;
    const types = [...new Set(openStation.items.map((item) => item.typeID))];
    if (types.length === 0) return;
    flow.requestWords([...INV_ITEM_COLUMN_WORDS]);
    flow.requestNames(types.flatMap((id) => [{ kind: "type" as const, id }, { kind: "typeGroup" as const, id }, { kind: "typeCategory" as const, id }]));
    const missing = types.filter((id) => !typeFacts.has(id));
    if (missing.length > 0) void flow.assetTypeFacts(missing).then((read) => { typeFacts = new Map([...typeFacts, ...read]); }).catch(() => {});
  });
  const sortedStations = $derived.by(() => {
    const rows = $assets.stations.map((row) => ({ row, name: stationName(row.stationID), jumps: jumpsTo(row) ?? Number.MAX_SAFE_INTEGER }));
    const cmp = (a: number | string, b: number | string) => (a < b ? -1 : a > b ? 1 : 0);
    // GetLocationData's sortVal: (name, items, jumps), (jumps, name, items) or (-items, name, jumps)
    return rows.sort((a, b) => assetsSortKey === 1 ? cmp(a.jumps, b.jumps) || cmp(a.name, b.name) || cmp(a.row.itemCount, b.row.itemCount)
      : assetsSortKey === 2 ? cmp(b.row.itemCount, a.row.itemCount) || cmp(a.name, b.name) || cmp(a.jumps, b.jumps)
      : cmp(a.name, b.name) || cmp(a.row.itemCount, b.row.itemCount) || cmp(a.jumps, b.jumps));
  });
  $effect(() => {
    if (!retail) return;
    flow.requestWords([...Object.values(ASSET_WORDS), ...Object.keys(LINK_WORDS)]);
    const systems = [...new Set($assets.stations.map((row) => row.solarSystemID).filter((id) => id > 0))];
    if (systems.length > 0) flow.requestSystemSecurity(systems);
  });
  // The Search tab (LoadSearch, Search_thread, _LoadSearch, GetSubContent): its text, and the stations of what matched.
  let searchText = $state("");
  let searching = $state(false);
  let searchResults = $state.raw<{ readonly locations: readonly AssetSearchLocation[]; readonly stopped: boolean } | null>(null);
  function search(): void {
    void run(async () => {
      searching = true;
      try {
        searchResults = await flow.searchPersonalAssets(searchText);
      } finally {
        searching = false;
      }
    });
  }
  /** A thing's count as the search lists it: one for a thing assembled (its quantity -1). */
  const searchUnits = (item: AssetSearchItem): number => (item.quantity < 0 ? 1 : item.quantity);
  // A search asked for from outside (assetsSearch.ts, FindInPersonalAssets): the Search tab, with its text, searched.
  // svelte-ignore state_referenced_locally
  const assetsSearchRequests = assetsSearchTarget.requests;
  $effect(() => {
    void $assetsSearchRequests;
    const wanted = assetsSearchTarget.take();
    if (wanted === null) return;
    tab = "search";
    searchText = wanted;
    search();
  });

  onMount(() => {
    flow.requestWords([...Object.values(ROUTE_WORDS), NO_ROUTE, ...Object.values(TAB_WORDS)]);
    void run(() => flow.loadPersonalAssets());
  });
</script>

<section class="panel" class:as-retail={retail} class:as-safety={retail && safetyTab}>
  <header class="panel-head">
    <h2 class="panel-title">Personal Assets</h2>
    <p class="controls">
      <button
        type="button"
        class="primary"
        disabled={busy}
        onclick={() => void run(() => flow.loadPersonalAssets())}
      >
        Refresh
      </button>
    </p>
  </header>

  <div class="controls asset-tabs" role="tablist">
    <button type="button" role="tab" aria-selected={tab === "allitems" && !safetyTab} class:minor={tab !== "allitems" || safetyTab} onclick={() => { tab = "allitems"; safetyTab = false; }}>{word(TAB_WORDS.allitems, "Personal Assets")}</button>
    <button type="button" role="tab" aria-selected={tab === "search" && !safetyTab} class:minor={tab !== "search" || safetyTab} onclick={() => { tab = "search"; safetyTab = false; }}>{word(TAB_WORDS.search, "Search")}</button>
    {#if retail}<button type="button" role="tab" aria-selected={safetyTab} class:minor={!safetyTab} onclick={() => (safetyTab = true)}>{word("UI/Inventory/AssetSafety/AssetSafety", "Asset Safety")}</button>{/if}
  </div>
  <!-- assetsWindow.LoadAssetSafety: AssetSafetyCont with SafetyControllerCharacter (AssetSafetyList.svelte) -->
  {#if retail && safetyTab}<div class="as-safety-note"><AssetSafetyList {store} {flow} load={() => flow.characterSafetyWraps()} /></div>{/if}

  {#if error}
    <p class="error">{error}</p>
  {/if}

  <!-- A course that was set from this page (or anywhere else) reports itself
       here, because startRoute reports plan failures through travel state
       rather than by throwing — without this, an unreachable destination would
       look like a button that did nothing. -->
  {#if $travel.destinationName}
    <p class="note">
      Course set for {$travel.destinationName}{$travel.totalJumps > 0
        ? ` — ${$travel.remainingJumps} of ${$travel.totalJumps} jumps to go`
        : ""}.
    </p>
  {/if}
  {#if $travel.failureReason}
    <p class="error">{$travel.failureReason}</p>
  {/if}

  {#if tab === "search"}
    <form class="controls" onsubmit={(event) => { event.preventDefault(); search(); }}>
      <input type="search" maxlength="100" bind:value={searchText} placeholder={word(TAB_WORDS.searchText, "Search Text")} aria-label={word(TAB_WORDS.searchText, "Search Text")} />
      <button type="submit" disabled={busy}>{word(TAB_WORDS.search, "Search")}</button>
    </form>
    {#if searching}
      <p class="note">{word(TAB_WORDS.searching, "Searching")}</p>
    {:else if searchResults !== null}
      {#if searchResults.stopped}
        <!-- The client's search thread raising out (assetSearchUtil._GetSolarSystemID with a row of no station): its
             scroll is left with the Searching hint, and no results come. -->
        <p class="note">{word(TAB_WORDS.searching, "Searching")}</p>
        <p class="note">The search stopped: a place was asked of a thing lying in no station (in a ship, say), as the game's own search stops there.</p>
      {:else if searchResults.locations.length === 0}
        <p class="note">{word(TAB_WORDS.nothingFound, "Nothing found")}</p>
      {:else}
        <!-- _LoadSearch: a group for each station, its name and how many things matched there; within it, a group for
             each container (GetContainerGroupEntries) and the things lying at the station (GetSubContent). -->
        <div class="asset-search">
          {#each searchResults.locations as location (location.stationID)}
            <details class="asset-search-place">
              <summary>{stationName(location.stationID)} <small class="note">{stackText(location.itemCount)}</small></summary>
              {#each location.containers as held (held.container.itemID)}
                <details class="asset-search-container">
                  <summary>
                    <span class="asset-place"><TypeIcon typeID={held.container.typeID} name={itemName(held.container.typeID)} size="sm" />{itemName(held.container.typeID)}</span>
                    <small class="note">{stackText(held.items.length)}</small>
                  </summary>
                  {#each held.items as item (item.itemID)}
                    <p class="asset-search-item"><span class="asset-place"><TypeIcon typeID={item.typeID} name={itemName(item.typeID)} size="sm" />{itemName(item.typeID)}</span> <span class="num">{formatUnits(searchUnits(item))}</span></p>
                  {/each}
                </details>
              {/each}
              {#each location.items as item (item.itemID)}
                <p class="asset-search-item"><span class="asset-place"><TypeIcon typeID={item.typeID} name={itemName(item.typeID)} size="sm" />{itemName(item.typeID)}</span> <span class="num">{formatUnits(searchUnits(item))}</span></p>
              {/each}
            </details>
          {/each}
        </div>
      {/if}
    {/if}
  {:else if !$assets.loaded}
    <p class="note">Looking for your things…</p>
  {:else if $assets.error}
    <!-- A FAILED read. Worded deliberately unlike the empty case below: "you
         own nothing" is a claim only a SUCCESSFUL read may make. -->
    <p class="error">
      Your assets could not be read just now, so there may be things you cannot
      see here. Try again in a moment.
    </p>
  {:else if $assets.ownsNothing}
    <!-- ⚠ A FACT FROM A SUCCESSFUL EMPTY READ, not an inference from absence. -->
    <p class="note">
      You have nothing stored anywhere right now. Anything you leave in a
      station hangar will show up here.
    </p>
  {:else if retail}
    <div class="as-filter">
      <label>{plainText(text(ASSET_WORDS.sortBy)) || "Sort By"}
        <select value={assetsSortKey} onchange={(e) => setAssetsSort(Number((e.currentTarget as HTMLSelectElement).value))}>
          <option value={0}>{plainText(text(ASSET_WORDS.name)) || "Name"}</option>
          <option value={1}>{plainText(text(ASSET_WORDS.jumps)) || "Number of Jumps"}</option>
          <option value={2}>{plainText(text(ASSET_WORDS.items)) || "Number of Items"}</option>
        </select>
      </label>
    </div>
    <div class="as-scroll">
      {#each sortedStations as { row } (row.stationID)}
        <button type="button" class="as-group" aria-expanded={$assets.expandedStationID === row.stationID} onclick={() => toggle(row)}
          oncontextmenu={(e) => { e.preventDefault(); menuFor = menuFor === row.stationID ? null : row.stationID; }}>
          <span class="as-arrow">{$assets.expandedStationID === row.stationID ? "▾" : "▸"}</span><LabelText markup={locationLabel(row)} {followerOf} />
        </button>
        {#if menuFor === row.stationID}
          <div class="as-menu" role="menu">
            {#if destinationOffered(row.stationID)}<button type="button" role="menuitem" onclick={() => route(row, "destination")}>{word(ROUTE_WORDS.setDestination, "Set Destination")}</button>{/if}
            {#if $waypoints.includes(row.stationID)}
              <button type="button" role="menuitem" onclick={() => route(row, "remove")}>{word(ROUTE_WORDS.removeWaypoint, "Remove Waypoint")}</button>
            {:else}
              <button type="button" role="menuitem" onclick={() => route(row, "add")}>{word(ROUTE_WORDS.addWaypoint, "Add Waypoint")}</button>
            {/if}
          </div>
        {/if}
        {#if $assets.expandedStationID === row.stationID}
          {#if openStation === null}
            <p class="as-item as-note">…</p>
          {:else if openStation.error}
            <p class="as-item as-note">What's stored here could not be read just now.</p>
          {:else if openStation.hasNoItems}
            <p class="as-item as-note">{plainText(text(ASSET_WORDS.nothing)) || "Nothing found"}</p>
          {:else}
            <div class="as-item as-head" style:grid-template-columns={itemGrid}>
              {#each shownColumns as col (col.label)}
                <button type="button" class="as-col" class:num={col.right} onclick={() => sortOn(col.label)}
                  oncontextmenu={(e) => { e.preventDefault(); headerMenuFor = headerMenuFor === col.label ? null : col.label; }}>{plainText(text(col.label))}{sortColumn === col.label ? (sortReversed ? " ▴" : " ▾") : ""}</button>
              {/each}
            </div>
            {#if headerMenuFor}
              <div class="as-menu" role="menu">
                {#if shownColumns.length > 1}<button type="button" role="menuitem" onclick={() => hideColumn(headerMenuFor!)}>{plainText(text("/Carbon/UI/Common/Hide", { label: plainText(text(headerMenuFor)) }))}</button>{/if}
                {#each COLUMNS.filter((c) => !shownColumns.includes(c)) as c (c.label)}
                  <button type="button" role="menuitem" onclick={() => showColumn(c.label)}>{plainText(text("/Carbon/UI/Common/Show", { label: plainText(text(c.label)) }))}</button>
                {/each}
              </div>
            {/if}
            {#each openItems as item (item.itemID)}
              <div class="as-item" style:grid-template-columns={itemGrid}>
                {#each shownColumns as col (col.label)}
                  {#if col.label === "UI/Common/Name"}
                    <span class="asset-place"><TypeIcon typeID={item.typeID} name={itemName(item.typeID)} size="sm" />{itemName(item.typeID)}</span>
                  {:else}
                    <span class:num={col.right}>{col.text(item)}</span>
                  {/if}
                {/each}
              </div>
            {/each}
          {/if}
        {/if}
      {:else}
        <p class="as-note">{plainText(text(ASSET_WORDS.noAssets))}</p>
      {/each}
    </div>
  {:else}
    <p class="note">
      Your things are spread across {stationCount === 1
        ? "one place"
        : `${stationCount} places`}.
    </p>

    <!-- R8: a wide record table scrolls inside its OWN box and reflows to
         labelled cards below 640px, so the page body never scrolls sideways. -->
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead>
          <tr>
            <th>Place</th>
            <th>System</th>
            <th class="num">Jumps</th>
            <th class="num">Holding</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each $assets.stations as row (row.stationID)}
            <tr>
              <td data-label="Place">
                <span class="asset-place">
                  <TypeIcon typeID={row.typeID} name={stationName(row.stationID)} />
                  {stationName(row.stationID)}
                </span>
              </td>
              <td data-label="System">{systemName(row.solarSystemID)}</td>
              <td class="num" data-label="Jumps">{routeText(row)}</td>
              <td class="num" data-label="Holding">{stackText(row.itemCount)}</td>
              <td data-label="">
                <div class="row-actions">
                  <button type="button" disabled={busy} onclick={() => toggle(row)}>
                    {$assets.expandedStationID === row.stationID
                      ? "Hide what's here"
                      : "See what's here"}
                  </button>
                  <button type="button" aria-expanded={menuFor === row.stationID} aria-label="The place's menu"
                    onclick={() => (menuFor = menuFor === row.stationID ? null : row.stationID)}>⋯</button>
                </div>
                {#if menuFor === row.stationID}
                  <!-- The station's menu (assetsWindow.py GetMenuLocationMenu; menusvc.py 2002 to 2007). -->
                  <p class="controls">
                    {#if destinationOffered(row.stationID)}
                      <button type="button" class="minor" disabled={busy} onclick={() => route(row, "destination")}>{word(ROUTE_WORDS.setDestination, "Head there")}</button>
                    {/if}
                    {#if $waypoints.includes(row.stationID)}
                      <button type="button" class="minor" onclick={() => route(row, "remove")}>{word(ROUTE_WORDS.removeWaypoint, "Take off the route")}</button>
                    {:else}
                      <button type="button" class="minor" onclick={() => route(row, "add")}>{word(ROUTE_WORDS.addWaypoint, "Put on the route")}</button>
                    {/if}
                  </p>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    {#if $assets.expandedStationID !== null}
      <section class="panel">
        <header class="panel-head">
          <h2>At {stationName($assets.expandedStationID)}</h2>
        </header>

        {#if openStation === null}
          <p class="note">Looking inside…</p>
        {:else if openStation.error}
          <p class="error">
            What's stored here could not be read just now. Try again in a
            moment.
          </p>
        {:else if openStation.hasNoItems}
          <p class="note">Nothing is stored here any more.</p>
        {:else}
          {#if openStationVolume !== null}
            <p class="note">
              {formatAssetVolume(openStationVolume)} in total.
            </p>
          {/if}
          <div class="table-wrap overflow-x-auto">
            <table class="guests reflow">
              <thead>
                <tr>
                  <th>Item</th>
                  <th class="num">How many</th>
                  <th class="num">Each</th>
                  <th class="num">Together</th>
                </tr>
              </thead>
              <tbody>
                {#each openStation.items as item (item.itemID)}
                  <tr>
                    <td data-label="Item">
                      <span class="asset-place">
                        <TypeIcon typeID={item.typeID} name={itemName(item.typeID)} />
                        {itemName(item.typeID)}
                      </span>
                    </td>
                    <!-- ⚠ `units`, not the row's raw quantity: an assembled
                         item reports -1 there. -->
                    <td class="num" data-label="How many">{formatUnits(item.units)}</td>
                    <td class="num" data-label="Each">{formatAssetVolume(item.volume)}</td>
                    <td class="num" data-label="Together">
                      {formatAssetVolume(item.volume === null ? null : item.volume * item.units)}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>
    {/if}
  {/if}
</section>

<style>
  /* Icon and name read as one thing, and wrap together rather than letting the
     name run away from its picture on a narrow screen (R8). */
  .asset-place {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .asset-search-place > summary, .asset-search-container > summary { cursor: pointer; }
  .asset-search-container { margin-left: 1rem; }
  .asset-search-container > summary .asset-place { display: inline-flex; }
  .asset-search-item { display: flex; justify-content: space-between; gap: 1rem; margin: 0.15rem 0 0.15rem 1rem; }
</style>
