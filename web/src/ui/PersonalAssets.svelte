<script lang="ts">
  // Personal Assets page (goal R37): where this character's stuff is, and a
  // course set to any of it.
  //
  // A place and an item are shown by their names, resolved through the shared name cache.
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
  // Asset rows carry copy drags and selection-aware commands. Docked inventory actions use the live hangar rows.
  // GetMenuLocationMenu uses the station's CelestialMenu for Set Destination, Add Waypoint and Remove Waypoint.
  import { getContext, onMount, type Snippet } from "svelte";
  import {
    formatAssetVolume,
    formatUnits,
    totalVolume,
  } from "../bridge/personalAssets.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { AssetStationContents, AssetStationRow } from "../store/types.ts";
  import { resolvedName } from "../store/names.ts";
  import TypeIcon from "./TypeIcon.svelte";
  import AssetSafetyList from "./AssetSafetyList.svelte";
  import LabelText from "./LabelText.svelte";
  import { invItemColumns, invItemGridColumns, INV_ITEM_DEFAULT_HIDDEN, INV_ITEM_COLUMN_WORDS, type InvItem } from "./invItemColumns.ts";
  import type { AssetTypeFacts } from "../app/flow.ts";
  import { linkFollowerOf, LINK_WORDS, startLinkDrag } from "./linkFollowers.ts";
  import { formatTemplate, locationKind, plainText } from "../bridge/clientWords.ts";
  import { shownSecurity, securityStatusRgb } from "../bridge/systemSecurity.ts";
  import { assetsSearchTarget, findInPersonalAssets } from "./assetsSearch.ts";
  import { assetSearchTextForType, type AssetSearchItem, type AssetSearchLocation } from "../bridge/assetSearch.ts";
  import { ASSET_ITEM_DRAG_MIME, type AssetItemDrag } from "./dragDrop.ts";
  import { portal } from "./portal.ts";
  import { showInfo } from "./showInfo.ts";
  import { showMarketDetails } from "./marketDetails.ts";
  import { typeCompareTarget, type ComparisonSubject } from "./typeCompare.ts";
  import { isComparable, type ComparisonTypeData } from "../bridge/typeComparison.ts";
  import type { TypeMetaFacts } from "../app/api.ts";
  import { openFittingWindow } from "./fittingWindowTarget.ts";
  import { openShipHold } from "./shipHold.ts";
  import { isOpenableContainer, offersAssembleContainer } from "../bridge/inventoryShip.ts";
  import { isShipRow } from "./inventoryModel.ts";
  import { changeQuickbar, marketQuickbar } from "./marketQuickbar.ts";
  import { addType } from "../bridge/marketQuickbar.ts";

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

  function assetLocationName(id: number): string {
    return resolvedName($names.resolved, locationKind(id), id, "an unnamed place");
  }

  function dragAssetLocation(event: DragEvent, id: number, typeID: number | null): void {
    if (typeID === null || event.target !== event.currentTarget) return;
    startLinkDrag(event, `showinfo:${typeID}//${id}`, assetLocationName(id));
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
  const assetLocationTypes = $derived(new Map($assets.stations.map((row) => [row.stationID, row.typeID])));

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
    collapseAll: "UI/Common/Buttons/CollapseAll",
    label: "UI/Inventory/AssetsWindow/LocationDataLabel", noRoute: "UI/Inventory/AssetsWindow/LocationDataLabelNoRoute",
    noJump: "UI/Inventory/AssetsWindow/LocationDataLabelNoJump",
    quantity: "UI/Common/Quantity", volume: "UI/Inventory/ItemVolume", noAssets: "UI/Inventory/AssetsWindow/NoAssetsAtStation",
    nothing: "UI/Common/NothingFound",
    allItems: "UI/Inventory/AssetsWindow/AllItems", region: "UI/Common/LocationTypes/Region", constellation: "UI/Common/LocationTypes/Constellation",
    system: "UI/Common/LocationTypes/SolarSystem", current: "UI/Common/Current", noInRegion: "UI/Inventory/AssetsWindow/NoAssetsInRegion",
    noInConstellation: "UI/Inventory/AssetsWindow/NoAssetsInConstellation", noInSystem: "UI/Inventory/AssetsWindow/NoAssetsInSolarSystem",
    pin: "UI/Inventory/AssetsWindow/PinPersonalAssets", unpin: "UI/Inventory/AssetsWindow/UnpinPersonalAssets",
    hide: "UI/Inventory/AssetsWindow/HidePersonalAssets", unhide: "UI/Inventory/AssetsWindow/UnhidePersonalAssets",
    pinned: "UI/Inventory/AssetsWindow/PersonalAssetLocationPinned", unpinned: "UI/Inventory/AssetsWindow/PersonalAssetLocationUnpinned",
    hidden: "UI/Inventory/AssetsWindow/PersonalAssetLocationHidden", unhidden: "UI/Inventory/AssetsWindow/PersonalAssetLocationUnhidden",
    pinnedHint: "UI/Inventory/AssetsWindow/PinnedLocation",
  } as const;
  // ConstructFilterCont's filter type (FILTER_TYPE_OPTIONS; assets_window_filter_type) and its value (GetFilterValueComboOptions:
  // Current, then each region / constellation / system the assets lie in by name; assetsKeyID_<key>), the places from the
  // star map; and the locations' importance (assets_window_importance: pinned 1 first with the pin, hidden -1 under the
  // Hidden group) - each kept in this browser as the client keeps them in settings.char.ui.
  type FilterType = "allitems" | "regitems" | "conitems" | "sysitems";
  const FILTER_TYPES: readonly [FilterType, string, string][] = [["allitems", ASSET_WORDS.allItems, "All Items"], ["regitems", ASSET_WORDS.region, "Region"],
    ["conitems", ASSET_WORDS.constellation, "Constellation"], ["sysitems", ASSET_WORDS.system, "Solar System"]];
  const keptJSON = <T,>(key: string, fallback: T): T => { try { const v = localStorage.getItem(`evejs.play.${key}`); return v === null ? fallback : JSON.parse(v) as T; } catch { return fallback; } };
  const keepJSON = (key: string, value: unknown) => { try { localStorage.setItem(`evejs.play.${key}`, JSON.stringify(value)); } catch { /* not kept */ } };
  let filterType = $state<FilterType>((() => { const k = keptJSON<string>("assets_window_filter_type", "allitems"); return FILTER_TYPES.some(([id]) => id === k) ? k as FilterType : "allitems"; })());
  // svelte-ignore state_referenced_locally
  let filterKeyID = $state<number>(keptJSON<number>(`assetsKeyID_${filterType}`, 0) || 0);
  const noExpandedLocations: ReadonlySet<number> = new Set();
  let expandedByFilter = $state.raw<Partial<Record<FilterType, ReadonlySet<number>>>>({});
  const expandedLocations = $derived(expandedByFilter[filterType] ?? noExpandedLocations);
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const assetPilot = $derived($station.online?.characterID ?? null);
  // svelte-ignore state_referenced_locally
  const inventory = store.inventory;
  const dockedAt = $derived($flight.status
    ? ($flight.status.docked ? $flight.status.structureID ?? $flight.status.stationID : null)
    : $station.online?.structureID ?? $station.online?.stationID ?? null);
  let panel: HTMLElement;
  let selectedItems = $state.raw<ReadonlySet<number>>(new Set());
  let selectionAnchor: number | null = null;
  function clearItemSelection(): void {
    selectedItems = new Set();
    selectionAnchor = null;
    itemMenu = null;
  }
  $effect(() => {
    void assetPilot;
    expandedByFilter = {};
    hiddenOpen = false;
    menuFor = null;
    headerMenuFor = null;
  });
  $effect(() => {
    void [assetPilot, tab, filterType, filterKeyID];
    clearItemSelection();
  });

  function visibleAssetRows(): HTMLButtonElement[] {
    return Array.from(panel.querySelectorAll<HTMLButtonElement>("button[data-asset-item]"))
      .filter(row => !row.closest("details:not([open])"));
  }

  // Scroll.SelectNode uses the visible scroll order, including rows in other open groups.
  function selectAssetItem(event: MouseEvent | DragEvent, itemID: number, rows = visibleAssetRows()): void {
    const extend = event.ctrlKey || event.metaKey;
    if (event.shiftKey && selectionAnchor !== null && selectionAnchor !== itemID) {
      const ids = rows.map(row => Number(row.dataset.assetItem));
      const first = ids.indexOf(selectionAnchor);
      const last = ids.indexOf(itemID);
      if (first >= 0 && last >= 0) {
        const range = ids.slice(Math.min(first, last), Math.max(first, last) + 1);
        selectedItems = new Set(extend ? [...selectedItems, ...range] : range);
        return;
      }
    }
    const next = new Set(extend ? selectedItems : []);
    if (extend && !event.shiftKey && next.has(itemID)) next.delete(itemID);
    else next.add(itemID);
    selectedItems = next;
    selectionAnchor = itemID;
  }

  function dragAssetItem(event: DragEvent, itemID: number): void {
    if (!event.dataTransfer) return;
    const rows = visibleAssetRows();
    if (!selectedItems.has(itemID)) selectAssetItem(event, itemID, rows);
    const payload: AssetItemDrag[] = [];
    for (const row of rows) {
      const id = Number(row.dataset.assetItem);
      if (!selectedItems.has(id)) continue;
      const typeID = Number(row.dataset.assetType);
      payload.push({ itemID: id, typeID, name: itemName(typeID), shipOwnerID: row.dataset.assetOwnedShip ? assetPilot : null });
    }
    event.dataTransfer.setData(ASSET_ITEM_DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "copy";
  }

  const ITEM_WORDS = {
    info: ["UI/Commands/ShowInfo", "Show Info"],
    market: ["UI/Inventory/ItemActions/ViewTypesMarketDetails", "View Market Details"],
    compare: ["UI/Compare/CompareButton", "Compare"],
    find: ["UI/Inventory/ItemActions/FindPersonalAssets", "Find in Personal Assets"],
    exact: ["UI/Inventory/AssetSearch/KeywordTypeExact", "typeExact"],
    quickbar: ["UI/Inventory/ItemActions/AddTypeToMarketQuickbar", "Add to Market Quickbar"],
    board: ["UI/Inflight/BoardShip", "Board Ship"],
    cargo: ["UI/Commands/OpenCargoHold", "Open Cargo Hold"],
    rename: ["UI/Commands/ChangeName", "Change Name"],
    assembleShip: ["UI/Inventory/ItemActions/AssembleShip", "Assemble Ship"],
    openContainer: ["UI/Inventory/ItemActions/OpenContainer", "Open Container"],
    assembleContainer: ["UI/Inventory/ItemActions/AssembleContainer", "Assemble Container"],
  } as const;
  type ItemCommand = keyof typeof ITEM_WORDS;
  function itemWord(key: ItemCommand): string {
    const [label, fallback] = ITEM_WORDS[key];
    return word(label, fallback);
  }
  interface MenuAsset extends ComparisonSubject {
    readonly itemID: number;
    readonly stationID: number;
  }
  interface AssetItemMenu {
    readonly rows: readonly MenuAsset[];
    readonly x: number;
    readonly y: number;
    readonly types?: ReadonlyMap<number, TypeMetaFacts | null> | null;
    readonly comparison?: ReadonlyMap<number, ComparisonTypeData | null>;
  }
  let itemMenu = $state.raw<AssetItemMenu | null>(null);
  let itemMenuElement: HTMLElement | undefined = $state();

  function menuAsset(element: HTMLButtonElement): MenuAsset {
    return { itemID: Number(element.dataset.assetItem), typeID: Number(element.dataset.assetType), stationID: Number(element.dataset.assetStation) };
  }

  function localAsset(row: MenuAsset) {
    if (assetPilot === null || dockedAt !== row.stationID ||
        ($inventory.structureID ?? $inventory.stationID) !== dockedAt) return null;
    return $inventory.hangar.rows.find(entry => entry.itemID === row.itemID && entry.typeID === row.typeID &&
      entry.flagID === 4 && (entry.locationID === undefined || entry.locationID === dockedAt) &&
      (entry.ownerID === undefined || entry.ownerID === assetPilot)) ?? null;
  }

  function openItemMenu(event: MouseEvent, itemID: number): void {
    event.preventDefault();
    menuFor = null;
    headerMenuFor = null;
    const rows = visibleAssetRows();
    if (!selectedItems.has(itemID)) selectAssetItem(event, itemID, rows);
    const chosen = rows.filter(row => selectedItems.has(Number(row.dataset.assetItem))).map(menuAsset);
    if (chosen.length === 0) return;
    const anchor = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const menu: AssetItemMenu = { rows: chosen, x: event.clientX || anchor.left, y: event.clientY || anchor.bottom };
    itemMenu = menu;
    const types = [...new Set(chosen.map(row => row.typeID))];
    void Promise.all([
      flow.typeFacts(types).catch(() => null),
      flow.comparisonTypes(types).catch(() => null),
    ]).then(([facts, comparison]) => {
      if (itemMenu === menu) itemMenu = { ...menu, types: facts, comparison: comparison?.types };
    });
    if (chosen.length === 1 && chosen[0]!.stationID === dockedAt && !localAsset(chosen[0]!)) {
      void flow.loadInventory().catch(() => {});
    }
  }

  // Re-read the authoritative hangar before handing a local item to an inventory action.
  function useLocalAsset(row: MenuAsset, command?: ItemCommand): void {
    const pilot = assetPilot;
    if (pilot === null || row.stationID !== dockedAt || busy) return;
    void run(async () => {
      await flow.loadInventory();
      if (pilot !== assetPilot) return;
      const item = localAsset(row);
      if (!item) return;
      if (isShipRow(item)) {
        const active = $inventory.activeShipID === item.itemID;
        if (command === "cargo" && item.singleton && item.groupID !== 29) openShipHold("cargo", item.itemID);
        else if (command === "rename" && item.singleton) await flow.renameShip(item.itemID);
        else if (command === "assembleShip" && !item.singleton) await flow.assembleShip(item.itemID, false);
        else if (command === "board" || command === undefined) {
          if (!item.singleton) await flow.assembleShip(item.itemID, true);
          else if (!active) await flow.boardShip(item.itemID);
          else if (command === undefined) openFittingWindow();
        }
      } else if (isOpenableContainer(item) && (command === undefined || command === "openContainer")) {
        await flow.showInventoryContainer(item.itemID);
      } else if (offersAssembleContainer(item, true, true) && (command === undefined || command === "assembleContainer")) {
        await flow.assembleContainer(item.itemID, { kind: "hangar" });
      }
    });
  }

  function itemCommands(menu: AssetItemMenu): { readonly key: ItemCommand; readonly run: () => void }[] {
    const actions: { key: ItemCommand; run: () => void }[] = [];
    const marketed = menu.rows.find(row => (menu.types?.get(row.typeID)?.marketGroupID ?? null) !== null);
    if (marketed) actions.push({ key: "market", run: () => showMarketDetails(marketed.typeID) });
    if (menu.rows.some(row => isComparable(menu.comparison?.get(row.typeID) ?? null))) {
      actions.push({ key: "compare", run: () => typeCompareTarget.ask(menu.rows) });
    }
    if (menu.rows.length !== 1) return actions;
    const row = menu.rows[0]!;
    actions.push({ key: "info", run: () => showInfo({ kind: "type", typeID: row.typeID, itemID: row.itemID }) });
    if (menu.types?.get(row.typeID)?.published) {
      actions.push({ key: "find", run: () => findInPersonalAssets(assetSearchTextForType(itemWord("exact"), itemName(row.typeID))) });
    }
    if (marketed && menu.types?.get(row.typeID)?.groupID !== 29) {
      actions.push({ key: "quickbar", run: () => { changeQuickbar(current => addType(current, row.typeID, 0, "")); } });
    }
    const local = localAsset(row);
    if (!local) return actions;
    const addLocal = (key: ItemCommand) => actions.push({ key, run: () => useLocalAsset(row, key) });
    if (isShipRow(local)) {
      if (local.singleton) {
        if (local.groupID !== 29) addLocal("cargo");
        if ($inventory.activeShipID !== row.itemID) addLocal("board");
        addLocal("rename");
      } else {
        addLocal("assembleShip");
        addLocal("board");
      }
    } else if (isOpenableContainer(local)) addLocal("openContainer");
    else if (offersAssembleContainer(local, true, true)) addLocal("assembleContainer");
    return actions;
  }
  const itemActions = $derived(itemMenu ? itemCommands(itemMenu) : []);

  function dismissItemMenu(event: PointerEvent): void {
    if (itemMenu && !itemMenuElement?.contains(event.target as Node)) itemMenu = null;
  }

  function loadLocation(stationID: number): void {
    const pilot = store.station.get().online?.characterID;
    void flow.loadAssetStation(stationID).catch((cause) => {
      if (store.station.get().online?.characterID !== pilot && !isSessionLost(cause)) return;
      error = isSessionLost(cause) ? "Your session ended. Pick your character again."
        : cause instanceof Error ? cause.message : String(cause);
    });
  }

  function toggleLocation(stationID: number): void {
    const locations = new Set(expandedLocations);
    if (locations.has(stationID)) {
      locations.delete(stationID);
      if (headerMenuFor?.stationID === stationID) headerMenuFor = null;
    } else {
      locations.add(stationID);
      loadLocation(stationID);
    }
    expandedByFilter = { ...expandedByFilter, [filterType]: locations };
  }

  function collapseLocations(): void {
    expandedByFilter = { ...expandedByFilter, [filterType]: noExpandedLocations };
    hiddenOpen = false;
    menuFor = null;
    headerMenuFor = null;
  }

  function chooseFilterType(type: FilterType): void { filterType = type; keepJSON("assets_window_filter_type", type); filterKeyID = keptJSON<number>(`assetsKeyID_${type}`, 0) || 0; }
  function chooseFilterKey(id: number): void { filterKeyID = id; keepJSON(`assetsKeyID_${filterType}`, id); }
  let importance = $state<Record<string, number>>(keptJSON<Record<string, number>>("assets_window_importance", {}));
  /** _SetLocationImportance, and its message (Pin / Unpin / Hide / Unhide). */
  function setImportance(locationID: number, value: 0 | 1 | -1, said: string): void {
    menuFor = null;
    const next = { ...importance };
    if (value === 0) delete next[String(locationID)]; else next[String(locationID)] = value;
    importance = next;
    keepJSON("assets_window_importance", next);
    const t = plainText(text(said));
    if (t) flow.sayDialog("CustomNotify", { type: "dict", entries: [["notify", t]] }, t);
  }
  let hiddenOpen = $state(false);
  /** The star map's places for the filter: each system's constellation and region, and their names. */
  let mapPlaces = $state.raw<{ systems: Map<number, { region: number; constellation: number }>; names: Map<number, string> } | null>(null);
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
    const label = jumps === null ? ASSET_WORDS.noRoute : filterType === "sysitems" ? ASSET_WORDS.noJump : ASSET_WORDS.label;
    return text(label, args) || assetLocationName(row.stationID);
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
  let headerMenuFor = $state<{ stationID: number; label: string } | null>(null);
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
  const invItem = (item: { itemID: number; typeID: number; units: number; singleton: boolean; categoryID: number }) =>
    ({ itemID: item.itemID, typeID: item.typeID, stacksize: item.units, singleton: item.singleton ? 1 : 0, categoryID: item.categoryID });
  function locationItems(contents: AssetStationContents): (InvItem & { categoryID: number })[] {
    const list = contents.items.map(invItem);
    const col = COLUMNS.find((c) => c.label === sortColumn);
    if (!col) return list;
    list.sort((a, b) => { const x = col.sort(a), y = col.sort(b); return x < y ? -1 : x > y ? 1 : 0; });
    return sortReversed ? list.reverse() : list;
  }
  $effect(() => {
    if (!retail) return;
    const types = [...new Set([...expandedLocations].flatMap((stationID) => $assets.contents[stationID]?.items.map((item) => item.typeID) ?? []))];
    if (types.length === 0) return;
    flow.requestWords([...INV_ITEM_COLUMN_WORDS]);
    flow.requestNames(types.flatMap((id) => [{ kind: "type" as const, id }, { kind: "typeGroup" as const, id }, { kind: "typeCategory" as const, id }]));
    const missing = types.filter((id) => !typeFacts.has(id));
    if (missing.length > 0) void flow.assetTypeFacts(missing).then((read) => { typeFacts = new Map([...typeFacts, ...read]); }).catch(() => {});
  });
  /** The place a station's system is in for the filter type: the region, the constellation or the system. */
  function placeOf(solarSystemID: number, type: FilterType): number | null {
    if (type === "sysitems") return solarSystemID;
    const sys = mapPlaces?.systems.get(solarSystemID);
    return sys ? (type === "regitems" ? sys.region : sys.constellation) : null;
  }
  /** GetFilterValueComboOptions: Current, then the places the assets lie in by name. */
  const filterOptions = $derived.by(() => {
    if (filterType === "allitems") return [] as { id: number; name: string }[];
    const ids = [...new Set($assets.stations.map((row) => placeOf(row.solarSystemID, filterType)).filter((id): id is number => id !== null))];
    const name = (id: number) => (filterType === "sysitems" ? systemName(id) : mapPlaces?.names.get(id) ?? String(id));
    return ids.map((id) => ({ id, name: name(id) })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  });
  /** assets.GetAll(key, keyID): the stations in the chosen place, the session's own for Current (keyID 0). */
  const filteredStations = $derived.by(() => {
    if (filterType === "allitems") return $assets.stations;
    const want = filterKeyID || (hereSystem === null ? null : placeOf(hereSystem, filterType));
    return $assets.stations.filter((row) => want !== null && placeOf(row.solarSystemID, filterType) === want);
  });
  $effect(() => {
    if (!retail || safetyTab || tab !== "allitems" || !$assets.loaded || $assets.error) return;
    for (const row of filteredStations) {
      if (expandedLocations.has(row.stationID) && !$assets.contents[row.stationID]) loadLocation(row.stationID);
    }
  });
  const noContentWord = $derived(filterType === "regitems" ? ASSET_WORDS.noInRegion : filterType === "conitems" ? ASSET_WORDS.noInConstellation
    : filterType === "sysitems" ? ASSET_WORDS.noInSystem : ASSET_WORDS.noAssets);
  const sortedStations = $derived.by(() => {
    const rows = filteredStations.map((row) => ({ row, name: assetLocationName(row.stationID), jumps: jumpsTo(row) ?? Number.MAX_SAFE_INTEGER, pinned: importance[String(row.stationID)] === 1 ? 1 : 0 }));
    const cmp = (a: number | string, b: number | string) => (a < b ? -1 : a > b ? 1 : 0);
    // GetLocationData's sortVal: (name, items, jumps), (jumps, name, items) or (-items, name, jumps)
    // sortVal's first: -isPinned
    return rows.sort((a, b) => cmp(b.pinned, a.pinned) || (assetsSortKey === 1 ? cmp(a.jumps, b.jumps) || cmp(a.name, b.name) || cmp(a.row.itemCount, b.row.itemCount)
      : assetsSortKey === 2 ? cmp(b.row.itemCount, a.row.itemCount) || cmp(a.name, b.name) || cmp(a.jumps, b.jumps)
      : cmp(a.name, b.name) || cmp(a.row.itemCount, b.row.itemCount) || cmp(a.jumps, b.jumps)));
  });
  const shownStations = $derived(sortedStations.filter((s) => importance[String(s.row.stationID)] !== -1));
  const hiddenStations = $derived(sortedStations.filter((s) => importance[String(s.row.stationID)] === -1));
  $effect(() => {
    if (!retail) return;
    flow.requestWords([...Object.values(ASSET_WORDS), ...Object.keys(LINK_WORDS)]);
    const systems = [...new Set($assets.stations.map((row) => row.solarSystemID).filter((id) => id > 0))];
    if (systems.length > 0) flow.requestSystemSecurity(systems);
  });
  onMount(() => {
    if (!retail) return;
    void flow.loadStarMap().then((map) => {
      const systems = new Map(map.systems.map((s) => [s[0], { region: s[5], constellation: s[6] }] as const));
      const names = new Map<number, string>([...(map.regions ?? []).map((r) => [r[0], r[4]] as const), ...(map.constellations ?? []).map((c) => [c[0], c[4]] as const)]);
      mapPlaces = { systems, names };
    }).catch(() => {});
  });
  // The Search tab (LoadSearch, Search_thread, _LoadSearch, GetSubContent): its text, and the stations of what matched.
  let searchText = $state("");
  let searching = $state(false);
  let searchResults = $state.raw<{ readonly locations: readonly AssetSearchLocation[]; readonly stopped: boolean } | null>(null);
  function search(): void {
    void run(async () => {
      clearItemSelection();
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
    flow.requestWords(Object.values(ITEM_WORDS).map(([label]) => label));
    void run(() => flow.loadPersonalAssets());
  });
</script>

<svelte:window onpointerdown={dismissItemMenu} onkeydown={event => { if (event.key === "Escape") itemMenu = null; }} />

{#if itemMenu && itemActions.length}
  <div class="asset-item-menu" role="menu" use:portal bind:this={itemMenuElement}
    style:left={`clamp(4px, ${itemMenu.x}px, calc(100vw - 14rem - 4px))`}
    style:top={`clamp(4px, ${itemMenu.y}px, calc(100vh - ${itemActions.length * 28 + 12}px))`}>
    {#each itemActions as action (action.key)}
      <button type="button" role="menuitem" onclick={() => { itemMenu = null; action.run(); }}>{itemWord(action.key)}</button>
    {/each}
  </div>
{/if}

{#snippet assetItemRow(item: { itemID: number; typeID: number; categoryID: number }, stationID: number, singleton: boolean, searchRow: boolean, children: Snippet)}
  <button type="button" class="asset-item-row" class:asset-search-item={searchRow} class:as-item={!searchRow}
    style:grid-template-columns={searchRow ? undefined : itemGrid}
    data-asset-item={item.itemID} data-asset-type={item.typeID} data-asset-station={stationID}
    data-asset-owned-ship={singleton && item.categoryID === 6 ? "true" : undefined}
    aria-pressed={selectedItems.has(item.itemID)} draggable="true"
    onclick={(event) => selectAssetItem(event, item.itemID)} ondragstart={(event) => dragAssetItem(event, item.itemID)}
    oncontextmenu={(event) => openItemMenu(event, item.itemID)}
    ondblclick={() => useLocalAsset({ itemID: item.itemID, typeID: item.typeID, stationID })}>
    {@render children()}
  </button>
{/snippet}

{#snippet searchItemRow(item: AssetSearchItem, stationID: number)}
  {#snippet cells()}
    <span class="asset-place"><TypeIcon typeID={item.typeID} name={itemName(item.typeID)} size="sm" />{itemName(item.typeID)}</span>
    <span class="num">{formatUnits(searchUnits(item))}</span>
  {/snippet}
  {@render assetItemRow(item, stationID, item.quantity < 0, true, cells)}
{/snippet}

{#snippet locationBody(row: AssetStationRow)}
        {#if menuFor === row.stationID}
          <div class="as-menu" role="menu">
            {#if destinationOffered(row.stationID)}<button type="button" role="menuitem" onclick={() => route(row, "destination")}>{word(ROUTE_WORDS.setDestination, "Set Destination")}</button>{/if}
            {#if $waypoints.includes(row.stationID)}
              <button type="button" role="menuitem" onclick={() => route(row, "remove")}>{word(ROUTE_WORDS.removeWaypoint, "Remove Waypoint")}</button>
            {:else}
              <button type="button" role="menuitem" onclick={() => route(row, "add")}>{word(ROUTE_WORDS.addWaypoint, "Add Waypoint")}</button>
            {/if}
            <!-- _GetImportanceMenu -->
            {#if importance[String(row.stationID)] === 1}
              <button type="button" role="menuitem" onclick={() => setImportance(row.stationID, 0, ASSET_WORDS.unpinned)}>{plainText(text(ASSET_WORDS.unpin)) || "Unpin"}</button>
            {:else if importance[String(row.stationID)] === -1}
              <button type="button" role="menuitem" onclick={() => setImportance(row.stationID, 0, ASSET_WORDS.unhidden)}>{plainText(text(ASSET_WORDS.unhide)) || "Unhide"}</button>
            {:else}
              <button type="button" role="menuitem" onclick={() => setImportance(row.stationID, 1, ASSET_WORDS.pinned)}>{plainText(text(ASSET_WORDS.pin)) || "Pin"}</button>
              <button type="button" role="menuitem" onclick={() => setImportance(row.stationID, -1, ASSET_WORDS.hidden)}>{plainText(text(ASSET_WORDS.hide)) || "Hide"}</button>
            {/if}
          </div>
        {/if}
        {#if expandedLocations.has(row.stationID)}
          {@const contents = $assets.contents[row.stationID]}
          {#if !contents}
            <p class="as-item as-note">…</p>
          {:else if contents.error}
            <p class="as-item as-note">What's stored here could not be read just now.</p>
          {:else if contents.hasNoItems}
            <p class="as-item as-note">{plainText(text(ASSET_WORDS.nothing)) || "Nothing found"}</p>
          {:else}
            <div class="as-item as-head" style:grid-template-columns={itemGrid}>
              {#each shownColumns as col (col.label)}
                <button type="button" class="as-col" class:num={col.right} onclick={() => sortOn(col.label)}
                  oncontextmenu={(e) => { e.preventDefault(); headerMenuFor = headerMenuFor?.stationID === row.stationID && headerMenuFor?.label === col.label ? null : { stationID: row.stationID, label: col.label }; }}>{plainText(text(col.label))}{sortColumn === col.label ? (sortReversed ? " ▴" : " ▾") : ""}</button>
              {/each}
            </div>
            {#if headerMenuFor?.stationID === row.stationID}
              {@const label = headerMenuFor.label}
              <div class="as-menu" role="menu">
                {#if shownColumns.length > 1}<button type="button" role="menuitem" onclick={() => hideColumn(label)}>{plainText(text("/Carbon/UI/Common/Hide", { label: plainText(text(label)) }))}</button>{/if}
                {#each COLUMNS.filter((c) => !shownColumns.includes(c)) as c (c.label)}
                  <button type="button" role="menuitem" onclick={() => showColumn(c.label)}>{plainText(text("/Carbon/UI/Common/Show", { label: plainText(text(c.label)) }))}</button>
                {/each}
              </div>
            {/if}
            {#each locationItems(contents) as item (item.itemID)}
              {#snippet cells()}
                {#each shownColumns as col (col.label)}
                  {#if col.label === "UI/Common/Name"}
                    <span class="asset-place"><TypeIcon typeID={item.typeID} name={itemName(item.typeID)} size="sm" />{itemName(item.typeID)}</span>
                  {:else}
                    <span class:num={col.right}>{col.text(item)}</span>
                  {/if}
                {/each}
              {/snippet}
              {@render assetItemRow(item, row.stationID, item.singleton === 1, false, cells)}
            {/each}
          {/if}
        {/if}
{/snippet}

<section bind:this={panel} class="panel" class:as-retail={retail} class:as-safety={retail && safetyTab}>
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
            {@const typeID = assetLocationTypes.get(location.stationID) ?? null}
            <details class="asset-search-place">
              <summary draggable={typeID !== null} ondragstart={(event) => dragAssetLocation(event, location.stationID, typeID)}>
                {assetLocationName(location.stationID)} <small class="note">{stackText(location.itemCount)}</small>
              </summary>
              {#each location.containers as held (held.container.itemID)}
                <details class="asset-search-container">
                  <summary>
                    <span class="asset-place"><TypeIcon typeID={held.container.typeID} name={itemName(held.container.typeID)} size="sm" />{itemName(held.container.typeID)}</span>
                    <small class="note">{stackText(held.items.length)}</small>
                  </summary>
                  {#each held.items as item (item.itemID)}
                    {@render searchItemRow(item, location.stationID)}
                  {/each}
                </details>
              {/each}
              {#each location.items as item (item.itemID)}
                {@render searchItemRow(item, location.stationID)}
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
      <label class="as-filter-type">&nbsp;
        <select value={filterType} onchange={(e) => chooseFilterType((e.currentTarget as HTMLSelectElement).value as FilterType)}>
          {#each FILTER_TYPES as [id, label, own] (id)}<option value={id}>{plainText(text(label)) || own}</option>{/each}
        </select>
      </label>
      {#if filterType !== "allitems"}
        <label class="as-filter-type">&nbsp;
          <select value={filterKeyID} onchange={(e) => chooseFilterKey(Number((e.currentTarget as HTMLSelectElement).value))}>
            <option value={0}>{plainText(text(ASSET_WORDS.current)) || "Current"}</option>
            {#each filterOptions as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
          </select>
        </label>
      {/if}
      <span class="as-filter-gap"></span>
      <label>{plainText(text(ASSET_WORDS.sortBy)) || "Sort By"}
        <select value={assetsSortKey} onchange={(e) => setAssetsSort(Number((e.currentTarget as HTMLSelectElement).value))}>
          <option value={0}>{plainText(text(ASSET_WORDS.name)) || "Name"}</option>
          <option value={1}>{plainText(text(ASSET_WORDS.jumps)) || "Number of Jumps"}</option>
          <option value={2}>{plainText(text(ASSET_WORDS.items)) || "Number of Items"}</option>
        </select>
      </label>
      <button type="button" class="as-collapse" title={word(ASSET_WORDS.collapseAll, "Collapse All")} onclick={collapseLocations}
        aria-label={word(ASSET_WORDS.collapseAll, "Collapse All")} disabled={expandedLocations.size === 0 && !hiddenOpen}>
        <img src="/client-res/ui/texture/classes/scroll/collapse.png" width="12" height="12" alt="" />
      </button>
    </div>
    <div class="as-scroll">
      {#snippet locationGroup(row: AssetStationRow, sub: boolean)}
        <button type="button" class="as-group" class:as-sub={sub} data-station-id={row.stationID} aria-expanded={expandedLocations.has(row.stationID)} onclick={() => toggleLocation(row.stationID)}
          draggable={row.typeID !== null} ondragstart={(event) => dragAssetLocation(event, row.stationID, row.typeID)}
          oncontextmenu={(e) => { e.preventDefault(); menuFor = menuFor === row.stationID ? null : row.stationID; }}>
          <span class="as-arrow">{expandedLocations.has(row.stationID) ? "▾" : "▸"}</span><LabelText markup={locationLabel(row)} {followerOf} />
          {#if importance[String(row.stationID)] === 1}<img class="as-pin" alt="" title={plainText(text(ASSET_WORDS.pinnedHint))} src="/client-res/ui/texture/eveicon/system_icons/pinned_16px.png" />{/if}
        </button>
        {@render locationBody(row)}
      {/snippet}
      {#each shownStations as { row } (row.stationID)}
        {@render locationGroup(row, false)}
      {:else}
        {#if hiddenStations.length === 0}<p class="as-note">{plainText(text(noContentWord))}</p>{/if}
      {/each}
      {#if hiddenStations.length > 0}
        <!-- GetHiddenEntry: a locked ListGroup 'Hidden' (the client's own word, not localised), the hidden icon, its count -->
        <button type="button" class="as-group" aria-expanded={hiddenOpen} onclick={() => (hiddenOpen = !hiddenOpen)}>
          <span class="as-arrow">{hiddenOpen ? "▾" : "▸"}</span><img class="as-hidden-icon" alt="" src="/client-res/ui/texture/eveicon/system_icons/hidden_16px.png" />Hidden <span class="as-count">[{hiddenStations.length}]</span>
        </button>
        {#if hiddenOpen}
          {#each hiddenStations as { row } (row.stationID)}{@render locationGroup(row, true)}{/each}
        {/if}
      {/if}
    </div>
  {:else}
    <p class="note">
      Your things are spread across
 {stationCount === 1
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
                  <TypeIcon typeID={row.typeID} name={assetLocationName(row.stationID)} />
                  {assetLocationName(row.stationID)}
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
          <h2>At {assetLocationName($assets.expandedStationID)}</h2>
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
  .asset-item-row { width: 100%; box-sizing: border-box; border: 0; padding: 0; color: inherit; background: transparent; font: inherit; text-align: left; cursor: grab; }
  .asset-item-row:hover { background: rgba(255, 255, 255, 0.06); }
  .asset-item-row[aria-pressed="true"] { background: rgba(105, 179, 220, 0.22); }
  .asset-search-item { display: flex; justify-content: space-between; gap: 1rem; padding: 0.15rem 0 0.15rem 1rem; }
  .asset-item-menu { position: fixed; z-index: 10000; display: flex; flex-direction: column; width: 14rem; padding: 4px;
    box-sizing: border-box; max-height: calc(100vh - 8px); overflow-y: auto; background: #0c0e10; border: 1px solid #444; }
  .asset-item-menu button { text-align: left; min-height: 28px; background: transparent; color: inherit; border: 0; padding: 4px 8px; cursor: pointer; }
  .asset-item-menu button:hover, .asset-item-menu button:focus-visible { background: rgba(255, 255, 255, 0.12); }
</style>
