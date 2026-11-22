<script lang="ts" module>
  // one drag for every inventory window: a stack dragged out of a container drops on the ship's tree, and back
  let dragging: { from: string; ids: number[] } | null = null;
</script>

<script lang="ts">
  // The active ship's inventory window in space, laid out as the 3698585 client's ActiveShipCargo (invWindow.Inventory,
  // 600 x 450): the tree at the left (TREE_DEFAULT_WIDTH 160) with the ship as "<name> (<type>)" - its cargo - and its
  // other bays under it, My filters at its foot; at the right the top row (Stack All, the view mode and sort buttons, the
  // capacity gauge, the quick filter), the items (InvItem in icons view: a 64 px icon, its quantity at the bottom right
  // on black, the name under it in two lines at most; "Nothing Found" where none), and the foot's "<n> Items" and
  // "<isk> ISK Est. price" (UpdateNumberOfItems, UpdateIskPriceLabel).
  import { invCompact, invFilter, invKeepFilter, invSidebar, invViewMode } from "./inventoryWindowSettings.ts";
  import { onMount, untrack } from "svelte";
  import TypeIcon from "./TypeIcon.svelte";
  import { fmtAmtShort } from "../bridge/pyNumbers.ts";
  import { COMPARE_CATEGORIES } from "../bridge/dogmaAttributeGroups.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { shipHoldTarget } from "./shipHold.ts";
  import { get as getStore } from "svelte/store";
  import { tempInvLocations, treeShownContainer, removeTempInvLocation } from "./invTemp.ts";
  import { fmtDist, surfaceDistanceMeters } from "../space/overview.ts";
  import { bracketIcon } from "../play/brackets.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import { SHIP_HOLDS, CARGO_HOLD } from "../bridge/shipHolds.ts";
  // TreeViewEntry.OnMouseEnter: PlaySound(uiconst.SOUND_ENTRY_HOVER), ui_button_soft2_play
  import { playUiEvent } from "../play/uiAudio.ts";
  // SE_BaseClassCore.OnMouseEnter: PlaySound(sound_hover = uiconst.SOUND_ENTRY_HOVER, ui_button_soft2_play) as an entry lights; an
  // InvItem not while the left button is down
  const hoverSound = (e: MouseEvent) => { if (!(e.buttons & 1)) void playUiEvent("ui_button_soft2_play"); };
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { ContextMenu, type ContextEntry } from "../play/contextMenu.ts";
  import { showInfo } from "./showInfo.ts";
  import { showMarketDetails, buyMarketType } from "./marketDetails.ts";
  import { findInContracts } from "./contractsSearch.ts";
  import { findInPersonalAssets } from "./assetsSearch.ts";
  import { typeCompareTarget } from "./typeCompare.ts";
  import { changeQuickbar } from "./marketQuickbar.ts";
  import { addType } from "../bridge/marketQuickbar.ts";
  import { compressItemsInSpace } from "./compressInSpace.ts";
  import { INV_FROM_DRAG_TYPE, INV_ITEMS_DRAG_TYPE } from "./droneGroups.ts";

  /**
   * containerMode: the secondary inventory window a thing in space opens (Inventory.OpenOrShow on its invID: a can, a
   * wreck, a deployable's cargo bay) - the opened container alone (store.inventory.container), no tree; items drag
   * between it and the active ship's window (the drag is shared by both windows).
   */
  let { store, flow, containerMode = false }: { store: ClientStore; flow: AppFlow; containerMode?: boolean } = $props();
  // svelte-ignore state_referenced_locally
  const inventoryState = store.inventory;
  // svelte-ignore state_referenced_locally
  const mining = store.mining;
  // svelte-ignore state_referenced_locally
  const drones = store.drones;
  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const fitting = store.fitting;

  const MENU = { market: "UI/Inventory/ItemActions/ViewTypesMarketDetails", buy: "UI/Inventory/ItemActions/BuyThisType", buyAll: "UI/Market/MarketQuote/BuyAll", compare: "UI/Compare/CompareButton",
    jettison: "UI/Inventory/ItemActions/Jettison", launch: "UI/Drones/LaunchDrone", info: "UI/Commands/ShowInfo", contracts: "UI/Inventory/ItemActions/FindInContracts",
    assets: "UI/Inventory/ItemActions/FindPersonalAssets", quickbar: "UI/Inventory/ItemActions/AddTypeToMarketQuickbar", compress: "UI/Commands/Compress",
    compressNone: "UI/Compression/FailureToCompressAny" } as const;
  /** itemcompression.is_compressible_type: the client's compressibleTypes (compressibleTypes.json, tools/client-extract/compressibleTypes.py). */
  let compressible = $state<ReadonlySet<number>>(new Set());
  onMount(() => {
    void fetch("/client-assets/compressibleTypes.json").then((r) => (r.ok ? r.json() : null))
      .then((j: { pairs?: [number, number][] } | null) => { if (j?.pairs) compressible = new Set(j.pairs.map((p) => p[0])); }).catch(() => {});
  });
  /** uix.GetInvItemDefaultHeaders, the details and list views' columns. */
  const HEADERS = ["UI/Common/Name", "UI/Common/Quantity", "UI/Inventory/ItemGroup", "UI/Inventory/ItemCategory", "UI/Inventory/ItemSize", "UI/Inventory/ItemSlot",
    "UI/Inventory/ItemVolume", "UI/Inventory/ItemMetaLevel", "UI/Inventory/ItemTechLevel", "UI/Contracts/ContractsWindow/EstPrice"] as const;
  const HEADER_OWN = ["Name", "Quantity", "Group", "Category", "Size", "Slot", "Volume", "Meta Level", "Tech Level", "Est. Price"];
  /** invWindow.SORT_OPTIONS: each criterion's ascending and descending words. */
  const SORT_OPTIONS = [["UI/Common/Name", "UI/Inventory/NameReversed", "name", "Name", "Name (reversed)"], ["UI/Inventory/ItemQuantity", "UI/Inventory/QuantityReversed", "qty", "Quantity", "Quantity (reversed)"],
    ["UI/Common/Type", "UI/Inventory/TypeReversed", "type", "Type", "Type (reversed)"], ["UI/Inventory/EstPrice", "UI/Inventory/EstPriceReversed", "estPrice", "Est. Price", "Est. Price (reversed)"]] as const;
  /** invCont.GetViewModeName / GetViewModeIcon. */
  const VIEW_MODES = [["icons", "UI/Inventory/Icons", "Icons", "grid_view"], ["details", "UI/Inventory/Details", "Details", "details_view"], ["list", "UI/Inventory/List", "List", "list_view"]] as const;
  const WORDS = [...Object.values(MENU), ...HEADERS, ...SORT_OPTIONS.flatMap((o) => [o[0], o[1]]), ...VIEW_MODES.map((v) => v[1]), "UI/Inventory/ViewModeWithCurrent", "UI/Inventory/NumItems2", "UI/Inventory/NumItemsAndSelected2", "UI/Inventory/NumFiltered", "UI/Inventory/EstIskPrice2", "UI/Inventory/StackAll", "UI/Inventory/LootAll", "UI/Common/SortBy", "UI/Inventory/ViewMode",
    "UI/Inventory/Filters/MyFilters", "UI/Common/NothingFound", "UI/Inventory/OpenInNewWindow", "UI/Common/Buttons/Close", "/Carbon/UI/Common/Hide", "/Carbon/UI/Common/Show", ...SHIP_HOLDS.map((h) => h.label), CARGO_HOLD.label];
  flow.requestWords(WORDS);
  const word = (label: string, own: string, args: Record<string, string | number> = {}) => {
    const t = $words.templates[label];
    return typeof t === "string" && t !== "" ? plainText(formatTemplate(t, args, { nameOf: () => "" })).trim() : own;
  };

  /** ShipBay controllers' icons (invControllers iconName), by the bays' keys. */
  const BAY_ICON: Record<string, string> = {
    drone: "res:/UI/Texture/WindowIcons/dronebay.png", fighter: "res:/UI/Texture/WindowIcons/dronebay.png", fuel: "res:/UI/Texture/WindowIcons/fuelbay.png",
    ore: "res:/UI/Texture/WindowIcons/orehold.png", asteroid: "res:/UI/Texture/WindowIcons/orehold.png", ice: "res:/UI/Texture/WindowIcons/icehold.png",
    gas: "res:/UI/Texture/WindowIcons/gashold.png",
  };

  onMount(() => {
    void flow.loadMiningHolds().catch(() => {});
    if (!$drones.loaded) void flow.loadDrones().catch(() => {});
  });

  const ship = $derived($space.snapshot?.ship ?? null);
  const typeName = (typeID: number | null) => resolvedName($names.resolved, "type", typeID, "");
  /** The ship's bays the hull has: its cargo (the ship node itself), then the others, the drone bay where it has one. */
  interface Bay { key: string; label: string; items: { itemID: number; typeID: number; quantity: number; singleton: boolean; categoryID: number | null }[] | null; capacity: number | null; used: number | null }
  // treeData.TreeDataShip.GetChildren: the ship's bays in this order (the drone bay first, then the holds as its checks run)
  const TREE_ORDER = ["drone", "fighter", "shipMaintenance", "fleet", "fuel", "ore", "asteroid", "ice", "gas", "mineral", "salvage", "ship", "smallShip",
    "mediumShip", "largeShip", "industrialShip", "ammo", "commandCenter", "planetary", "quafe", "corpse", "booster", "subsystem", "mobileDepot", "colony", "expedition"];
  const JETTISONABLE_FLAGS: ReadonlySet<number> = new Set([5, 134, 136, 143, 149, 182, 135, 181, 185, 188]);
  const treeRank = (key: string) => { const i = TREE_ORDER.indexOf(key); return key === "cargo" ? -1 : i < 0 ? TREE_ORDER.length : i; };
  const droneBayCapacity = $derived(($fitting.shipAttributes?.[283] as number | undefined) ?? null);
  const bays = $derived.by((): Bay[] => {
    const out: Bay[] = [];
    if (containerMode) {
      const c = $inventoryState.container;
      if (c) out.push({ key: "container", label: "", items: c.rows.map((i) => ({ itemID: i.itemID, typeID: i.typeID, quantity: i.quantity < 0 ? 1 : i.quantity, singleton: i.singleton, categoryID: i.categoryID })),
        capacity: c.capacity?.capacity ?? null, used: c.capacity?.used ?? null });
      return out;
    }
    // a temporary location selected in the tree: the opened container's items (store.inventory.container)
    const tc = $inventoryState.container;
    if (current.startsWith("temp:") && tc && `temp:${tc.itemID}` === current)
      out.push({ key: current, label: "", items: tc.rows.map((i) => ({ itemID: i.itemID, typeID: i.typeID, quantity: i.quantity < 0 ? 1 : i.quantity, singleton: i.singleton, categoryID: i.categoryID })),
        capacity: tc.capacity?.capacity ?? null, used: tc.capacity?.used ?? null });
    for (const h of $mining.holds) {
      if (!h.present) continue;
      const def = h.key === "cargo" ? CARGO_HOLD : SHIP_HOLDS.find((d) => d.bayKey === h.key);
      out.push({ key: h.key, label: def ? word(def.label, h.label) : h.label,
        items: h.items?.map((i) => ({ itemID: i.itemID, typeID: i.typeID, quantity: i.quantity < 0 ? 1 : i.quantity, singleton: i.quantity < 0, categoryID: i.categoryID })) ?? null,
        capacity: h.capacity?.capacity ?? null, used: h.capacity?.used ?? null });
    }
    if ((droneBayCapacity ?? 0) > 0 || ($drones.bay?.length ?? 0) > 0) {
      const items = ($drones.bay ?? []).map((d) => ({ itemID: d.itemID, typeID: d.typeID, quantity: d.quantity < 0 ? 1 : d.quantity, singleton: d.quantity < 0, categoryID: 18 }));
      const used = items.reduce((n, i) => n + (volumes[String(i.typeID)] ?? 0) * i.quantity, 0);
      out.push({ key: "drone", label: word("UI/Ship/DroneBay", "Drone Bay"), items, capacity: droneBayCapacity, used });
    }
    return out.sort((a, b) => treeRank(a.key) - treeRank(b.key));
  });
  let volumes = $state<Record<string, number>>({});
  $effect(() => {
    const ids = [...new Set(($drones.bay ?? []).map((d) => d.typeID))].filter((t) => volumes[String(t)] === undefined);
    if (ids.length) void flow.typeVolumes(ids).then((v) => { volumes = { ...volumes, ...v }; }).catch(() => {});
  });
  $effect(() => {
    const refs: NameRef[] = [];
    if (ship?.typeID) refs.push({ kind: "type", id: ship.typeID });
    for (const t of temps) if (t.typeID) refs.push({ kind: "type", id: t.typeID });
    for (const b of bays) for (const i of b.items ?? []) { refs.push({ kind: "type", id: i.typeID }); refs.push({ kind: "typeGroup", id: i.typeID }); refs.push({ kind: "typeCategory", id: i.typeID }); }
    if (refs.length) flow.requestNames(refs);
  });

  /** The bay shown (the tree's selected node): the one a hold button asked for, else the cargo. */
  // svelte-ignore state_referenced_locally
  let current = $state(containerMode ? "container" : "cargo");
  function takeRequest(): void {
    const asked = shipHoldTarget.take();
    if (asked) current = asked.key;
  }
  const requests = shipHoldTarget.requests;
  $effect(() => { void $requests; untrack(takeRequest); });
  const bay = $derived(bays.find((b) => b.key === current) ?? (current.startsWith("temp:") ? { key: current, label: "", items: null, capacity: null, used: null } : null) ?? bays.find((b) => b.key === "cargo") ?? null);
  /** The temporary locations still on the grid, as the tree shows them: TreeDataInv.GetLabelWithDistance (the name and,
   *  in 0.4 white, FmtDist of its surface distance to 1 decimal) and the controller's icon - ItemFloatingCargo's
   *  containerCargo_20x20, a wreck's bracket. */
  const temps = $derived(containerMode ? [] : $tempInvLocations.flatMap((id) => {
    const e = $space.snapshot?.entities.find((x) => x.itemID === id);
    if (!e) return [];
    const own = $space.snapshot?.entities.find((x) => x.isSelf);
    const icon = e.kind === "container" ? clientTexture("res:/UI/Texture/Shared/Brackets/containerCargo_20x20.png")
      : bracketIcon({ typeID: e.typeID ?? null, groupID: e.groupID ?? null, categoryID: e.categoryID ?? null }) ?? clientTexture("res:/UI/Texture/WindowIcons/cargo.png");
    const surface = own ? surfaceDistanceMeters(own.position, own.radius, e.position, e.radius) : null;
    // BaseCelestialContainer.IsInRange: within maxCargoContainerTransferDistance (2,500 m) of its surface
    return [{ id, typeID: e.typeID ?? 0, name: e.name || typeName(e.typeID ?? 0) || "", dist: surface === null ? "" : fmtDist(surface, 1), icon, inRange: surface === null || surface <= 2500 }];
  }));
  function openTemp(id: number): void {
    current = `temp:${id}`;
    treeShownContainer.set(id);
    void flow.showInventoryContainer(id).catch(() => {});
  }
  /** TreeViewEntry.GetMenu on a temporary location: the container's own menu (CelestialMenu, as the scene builds it), then
   *  TreeDataInv's Open in new window while in range, then a line and Close (read through gridcheck on a can in
   *  ActiveShipCargo). */
  function tempMenu(t: { id: number; inRange: boolean }, e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const tail: ({ label: string; run: () => void } | null)[] = [];
    if (t.inRange) tail.push({ label: word("UI/Inventory/OpenInNewWindow", "Open in new window (SHIFT+Click)"), run: () => openTempInNewWindow(t.id) });
    tail.push(null, { label: word("UI/Common/Buttons/Close", "Close"), run: () => removeTemp(t.id) });
    dispatchEvent(new CustomEvent("evejs:open-space-menu", { detail: { itemID: t.id, x: e.clientX, y: e.clientY, tail } }));
  }
  /** TreeDataInv.OpenNewWindow: the container in an inventory window of its own (the cargo shown here again). */
  function openTempInNewWindow(id: number): void {
    if (current === `temp:${id}`) current = "cargo";
    treeShownContainer.set(null);
    void flow.showInventoryContainer(id).catch(() => {});
  }
  function removeTemp(id: number): void {
    removeTempInvLocation(id);
    if (current === `temp:${id}`) current = "cargo";
  }
  // leaving a temporary location lets its read go (the tree no longer shows it)
  $effect(() => {
    if (current.startsWith("temp:")) return;
    untrack(() => {
      const shown = getStore(treeShownContainer);
      if (shown === null) return;
      treeShownContainer.set(null);
      if (getStore(inventoryState).container?.itemID === shown) void flow.openContainer(null).catch(() => {});
    });
  });
  // a temporary location gone from the tree (removed, or off the grid) while shown: back to the cargo
  $effect(() => { if (current.startsWith("temp:") && !temps.some((t) => `temp:${t.id}` === current)) untrack(() => { current = "cargo"; }); });
  let treeOpen = $state(true);

  // the quick filter, the sidebar and compact mode shared with the window's header (InventoryWindowActions)
  const filterSig = invFilter;
  const sidebarSig = invSidebar;
  const compactSig = invCompact;
  const viewModeSig = invViewMode;
  const filter = $derived($filterSig);
  // Container.SetInvCont: another container shown clears the quick filter unless keep_inv_quick_filter_setting
  let shownBay: string | null = null;
  $effect(() => {
    const now = current;
    untrack(() => { if (shownBay !== null && now !== shownBay && !invKeepFilter.get()) filterSig.set(""); shownBay = now; });
  });
  const KEPT = "evejs.ui.inventory.activeShipCargo";
  const kept = (() => { try { return JSON.parse(localStorage.getItem(KEPT) ?? "{}") as { viewMode?: string; sortBy?: string; sortDir?: number; column?: number | null; reversed?: boolean }; } catch { return {}; } })();
  /** The scroll's own sort (scroll.ChangeSortBy: the column clicked again turns about, another starts ascending; scrollsortby_). */
  let column = $state<number | null>(typeof kept.column === "number" ? kept.column : null);
  let reversed = $state<boolean>(kept.reversed === true);
  function sortByColumn(k: number): void {
    reversed = column === k ? !reversed : false;
    column = k;
  }
  /** containerViewMode_<name> and the icons' sort (sortIconsBy, sortIconsDir), kept as the client keeps them. */
  let viewMode = $state<"icons" | "details" | "list">((["icons", "details", "list"].includes(kept.viewMode ?? "") ? kept.viewMode : "icons") as "icons" | "details" | "list");
  let sortBy = $state<string>(kept.sortBy ?? "name");
  let sortDir = $state<number>(kept.sortDir ?? 0);
  const vm = $derived(VIEW_MODES.find((v) => v[0] === viewMode)!);
  // the compact menu's View Mode radios: the window's mode told to them, and theirs taken
  $effect(() => { viewModeSig.set(viewMode); });
  $effect(() => { const picked = $viewModeSig; if (picked && picked !== untrack(() => viewMode)) viewMode = picked; });
  $effect(() => { try { localStorage.setItem(KEPT, JSON.stringify({ viewMode, sortBy, sortDir, column, reversed })); } catch { /* lasts the page */ } });
  const groupName = (typeID: number) => resolvedName($names.resolved, "typeGroup", typeID, "");
  const categoryName = (typeID: number) => resolvedName($names.resolved, "typeCategory", typeID, "");
  const shown = $derived.by(() => {
    const list = (bay?.items ?? []).filter((i) => !filter.trim() || typeName(i.typeID).toLowerCase().includes(filter.trim().toLowerCase()));
    const key = (i: (typeof list)[number]): string | number => sortBy === "qty" ? i.quantity : sortBy === "type" ? `${groupName(i.typeID)}\u0000${typeName(i.typeID)}`
      : sortBy === "estPrice" ? (prices?.get(i.typeID) ?? 0) * i.quantity : typeName(i.typeID).toLowerCase();
    const cmp = (x: string | number, y: string | number) => typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    if (viewMode !== "icons" && column !== null) {
      // the columns' own values, in GetInvItemDefaultHeaders' order
      const col = (i: (typeof list)[number]): string | number => {
        const fa = facts[i.typeID];
        switch (column) {
          case 1: return i.quantity;
          case 2: return groupName(i.typeID).toLowerCase();
          case 3: return categoryName(i.typeID).toLowerCase();
          case 6: return (fa?.volume ?? 0) * i.quantity;
          case 7: return fa?.meta ?? -1;
          case 8: return fa?.tech ?? -1;
          case 9: return (prices?.get(i.typeID) ?? 0) * i.quantity;
          default: return typeName(i.typeID).toLowerCase();
        }
      };
      const byColumn = [...list].sort((a, b) => cmp(col(a), col(b)) || cmp(typeName(a.typeID), typeName(b.typeID)));
      return reversed ? byColumn.reverse() : byColumn;
    }
    const sorted = [...list].sort((a, b) => cmp(key(a), key(b)));
    return sortDir ? sorted.reverse() : sorted;
  });
  // the details columns' facts: volume (evetypes) and meta and tech levels (typeFacts)
  let facts = $state<Record<number, { volume: number | null; meta: number | null; tech: number | null }>>({});
  $effect(() => {
    if (viewMode === "icons") return;
    const missing = [...new Set((bay?.items ?? []).map((i) => i.typeID))].filter((t) => !facts[t]);
    if (!missing.length) return;
    for (const t of missing) facts[t] = { volume: null, meta: null, tech: null };
    void Promise.all([flow.typeVolumes(missing).catch(() => ({} as Record<string, number>)), flow.typeFacts(missing).catch(() => null)]).then(([v, m]) => {
      const next = { ...facts };
      for (const t of missing) next[t] = { volume: v[String(t)] ?? null, meta: m?.get(t)?.metaLevel ?? null, tech: m?.get(t)?.techLevel ?? null };
      facts = next;
    });
  });
  const filtered = $derived((bay?.items?.length ?? 0) - shown.length);

  // typeHelpers.GetAveragePrice: the cfg's average prices
  let prices = $state<ReadonlyMap<number, number | null> | null>(null);
  onMount(() => { void flow.cfgAveragePrices().then((p) => (prices = p)).catch(() => {}); });
  // invWindow._UpdateSelectedItems: with a selection, the price label the selected items' (UpdateIskPriceLabel(items)) and the
  // gauge's secondary fill and "(<volume>) " their volume (SetSecondaryVolume); else every item's price
  const selectedItems = $derived((bay?.items ?? []).filter((i) => selected.includes(i.itemID)));
  const isk = $derived((selectedItems.length ? selectedItems : shown).reduce((n, i) => n + (prices?.get(i.typeID) ?? 0) * i.quantity, 0));
  $effect(() => {
    const ids = [...new Set(selectedItems.map((i) => i.typeID))].filter((t) => volumes[String(t)] === undefined);
    if (ids.length) void flow.typeVolumes(ids).then((v) => { volumes = { ...volumes, ...v }; }).catch(() => {});
  });
  const secondaryVolume = $derived(selectedItems.reduce((n, i) => n + (volumes[String(i.typeID)] ?? 0) * i.quantity, 0));
  const secondaryFill = $derived(bay && bay.capacity ? Math.min(1, secondaryVolume / bay.capacity) : 0);

  /** InvContCapacityGauge: "<used>/<capacity> m³" over its fill. */
  const fmt1 = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fill = $derived(bay && bay.capacity ? Math.min(1, (bay.used ?? 0) / bay.capacity) : 0);
  const shipLabel = $derived(ship ? `${ship.name ?? typeName(ship.typeID)} (${typeName(ship.typeID)})` : "");

  /** The items selected (the scroll's selection: a click alone, Ctrl toggling, Shift the run from the last clicked). */
  let selected = $state<number[]>([]);
  let lastClicked: number | null = null;
  $effect(() => { void current; selected = []; lastClicked = null; });
  function clickItem(id: number, e: MouseEvent): void {
    e.stopPropagation();
    const order = shown.map((i) => i.itemID);
    if (e.ctrlKey && !e.shiftKey) selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    else if (e.shiftKey && lastClicked !== null && order.includes(lastClicked)) {
      const [a, b] = [order.indexOf(lastClicked), order.indexOf(id)].sort((x, y) => x - y);
      selected = e.ctrlKey ? [...new Set([...selected, ...order.slice(a!, b! + 1)])] : order.slice(a!, b! + 1);
    } else selected = [id];
    if (!e.shiftKey) lastClicked = id;
  }
  /** A bay's place for the moves (invCtrl: the cargo, or the ship bay by its flag). */
  /** IsLootable: a can or a wreck in space (a deployable's cargo bay has no Loot All). */
  const lootable = $derived.by(() => { const id = $inventoryState.container?.itemID; const e = id ? $space.snapshot?.entities.find((x) => x.itemID === id) : null; return e?.kind === "wreck" || e?.kind === "container"; });
  const placeOf = (key: string) => (key === "cargo" ? { kind: "cargo" as const } : key === "container" || key.startsWith("temp:") ? { kind: "container" as const, itemID: store.inventory.get().container?.itemID ?? 0 } : { kind: "shipBay" as const, bay: key });
  /**
   * The drag (InvItem.GetDragData: the selected items where the dragged one is among them) and its drop on a bay in the
   * tree (TreeViewEntryInventory.OnDropData: the items moved into that bay's inventory, invCtrl.AddItems).
   */
  // (the drag is the module's: see the module script)
  let dropKey = $state<string | null>(null);
  let moveError = $state("");
  function dragStart(id: number, e: DragEvent): void {
    dragging = { from: current, ids: selected.includes(id) ? [...selected] : [id] };
    e.dataTransfer?.setData("text/plain", dragging.ids.join(","));
    // the items for a drop on space (navigation.OnDropData deploys the deployable ones)
    const ids = dragging.ids;
    e.dataTransfer?.setData(INV_ITEMS_DRAG_TYPE, JSON.stringify(shown.filter((i) => ids.includes(i.itemID)).map((i) => ({ itemID: i.itemID, typeID: i.typeID }))));
    e.dataTransfer?.setData(INV_FROM_DRAG_TYPE, JSON.stringify(placeOf(current)));
  }
  const dragOver = (key: string) => (e: DragEvent) => { if (dragging && dragging.from !== key) { e.preventDefault(); dropKey = key; } };
  /**
   * menusvc.InvItemMenu for the items selected, in space, as the 3698585 client builds it (read through gridcheck for
   * ore in the mining hold and a drone in the bay): View Market Details, Buy This Type, Compare (modules, drones,
   * ships), Launch Drone from the drone bay or else Jettison, Show Info, Find in Contracts, Find Personal Assets, Add
   * to Market Quickbar. With several types the type's own entries fall away (MergeMenus keeps what all share).
   */
  const menu = new ContextMenu();
  $effect(() => () => menu.close());
  function itemMenu(id: number, e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (!selected.includes(id)) { selected = [id]; lastClicked = id; }
    const items = shown.filter((i) => selected.includes(i.itemID));
    const ids = items.map((i) => i.itemID);
    const types = [...new Set(items.map((i) => i.typeID))];
    const one = types.length === 1 ? items[0]! : null;
    const fromBay = current;
    // each entry's menuUtil group's place in menuHierarchy (ACTIONSGROUP 1, SHOWINFOGROUP 2, TRADEGROUP 10, none 14,
    // DESTRUCTIVEGROUP 17): _SortMenuEntries orders by it, stable, and a line goes between groups
    const ranked: [number, ContextEntry][] = [];
    const entries = { push: (e: ContextEntry, rank: number) => ranked.push([rank, e]) };
    // menusvc._InvItemMenu per item, MergeMenus over a selection (read through gridcheck on two bay drones): with more than one
    // item (isMultiSelection) no Show Info, Find in Contracts / Personal Assets or Quickbar, Buy All for Buy This Type
    // (BuyMultipleTypes: one of each type), and the merged list entries' MenuEntryData.GetText " (<quantity>)" - the
    // items' count for Buy All and Compare, their stack sizes summed (_GetEntryQuantity) for Launch Drone and Jettison
    const multi = items.length > 1;
    const first = items[0]!;
    const count = (label: string, n: number) => (multi ? `${label} (${n})` : label);
    const units = items.reduce((n, i) => n + i.quantity, 0);
    entries.push({ label: word(MENU.market, "View Market Details"), run: () => showMarketDetails(first.typeID) }, 10);
    entries.push(multi
      ? { label: count(word(MENU.buyAll, "Buy All"), items.length), run: () => void flow.openMultiBuy(new Map(types.map((t) => [t, 1]))) }
      : { label: word(MENU.buy, "Buy This Type"), run: () => buyMarketType(first.typeID) }, 10);
    // OfferCompressInSpace: a compressible type directly in the active ship in space (DirectlyCompressInSpace)
    // (items in a can or a wreck are not in the ship: no Compress, and no Jettison - IsJettisonable's jettisonableFlags,
    // read through gridcheck on Tritanium in a jetcan: Show Info | market | Compare)
    const inShip = !(fromBay === "container" || fromBay.startsWith("temp:"));
    // itemCheckers.IsJettisonable: a hold among inventorycommon.const.jettisonableFlags (cargo, the mining, mineral,
    // ammo, planetary, asteroid, gas, ice, colony resources and expedition holds - not fuel, fleet, maintenance or the
    // ship holds), and no ship
    const bayFlag = fromBay === "cargo" ? CARGO_HOLD.flag : SHIP_HOLDS.find((h) => h.bayKey === fromBay)?.flag ?? null;
    const jettisonable = bayFlag !== null && JETTISONABLE_FLAGS.has(bayFlag) && items.every((i) => i.categoryID !== 6);
    if (inShip && one && compressible.has(one.typeID)) entries.push({ label: word(MENU.compress, "Compress"), run: () => void compressInSpace(items) }, 14);
    // OfferCompareButton: IsComparible (inventorycommon.const.compareCategories) with dogma attributes to show
    if (items.every((i) => i.categoryID !== null && COMPARE_CATEGORIES.includes(i.categoryID))) entries.push({ label: count(word(MENU.compare, "Compare"), items.length), run: () => typeCompareTarget.ask(items.map((i) => ({ typeID: i.typeID, itemID: i.itemID }))) }, 14);
    if (fromBay === "drone" || jettisonable) entries.push(fromBay === "drone"
      ? { label: count(word(MENU.launch, "Launch Drone", { numDrones: 1 }), units), run: () => void act(() => flow.launchDrones(ids)) }
      : { label: count(word(MENU.jettison, "Jettison"), units), run: () => void (async () => {
        // invItemFunctions.Jettison: ConfirmJettison (yes / no, a yes kept by its suppress box) before the ship's Jettison
        if (await flow.askClientDialog("ConfirmJettison", "Are you sure you want to jettison these items?", true)) await act(() => flow.jettisonItems(ids));
      })() }, fromBay === "drone" ? 1 : 17);
    if (!multi) {
      entries.push({ label: word(MENU.info, "Show Info"), info: true, run: () => showInfo({ kind: "type", typeID: first.typeID, itemID: first.itemID }) }, 2);
      entries.push({ label: word(MENU.contracts, "Find in Contracts"), run: () => findInContracts(first.typeID) }, 10);
      entries.push({ label: word(MENU.assets, "Find Personal Assets"), run: () => findInPersonalAssets(typeName(first.typeID)) }, 10);
      entries.push({ label: word(MENU.quickbar, "Add to Market Quickbar"), run: () => { changeQuickbar((q) => addType(q, first.typeID)); } }, 10);
    }
    const sorted: (ContextEntry | null)[] = [];
    ranked.map((r, n) => [r, n] as const).sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1]).forEach(([[rank, entry]], n, all) => {
      if (n > 0 && all[n - 1]![0][0] !== rank) sorted.push(null);
      sorted.push(entry);
    });
    menu.open(e.clientX, e.clientY, sorted);
  }
  /** _get_view_mode_menu: each mode with its icon. */
  /** The scroll's hidden columns (filteredColumns, by default uix.GetInvItemDefaultHiddenHeaders: Category, Meta Level, Tech
   * Level), kept; its header's menu (allowFilterColumns, no smartSort): Hide <label> while more than one shows, a line, then
   * Show <label> for each hidden one. */
  const HIDDEN_KEY = "evejs.ui.inventory.hiddenColumns";
  let hiddenCols = $state<number[]>((() => { try { const v = JSON.parse(globalThis.localStorage?.getItem(HIDDEN_KEY) ?? "null"); return Array.isArray(v) ? v.filter((n) => typeof n === "number") : [3, 7, 8]; } catch { return [3, 7, 8]; } })());
  function setHiddenCols(next: number[]): void {
    hiddenCols = next;
    try { globalThis.localStorage?.setItem(HIDDEN_KEY, JSON.stringify(next)); } catch { /* lasts the page */ }
  }
  /** The scroll's column widths (columnWidths): each header's ScaleHandle (8 wide at its right, the 1 px line at 3) dragged
   * to a width no narrower than MINCOLUMNWIDTH 24, kept; a double-click on it fits the column to its content again
   * (ResetColumnWidth). The inventory scroll has no smartSort, so no column reordering (ChangeColumnOrder). */
  const WIDTHS_KEY = "evejs.ui.inventory.columnWidths";
  let colWidths = $state<Record<number, number>>((() => { try { const v = JSON.parse(globalThis.localStorage?.getItem(WIDTHS_KEY) ?? "null"); return v && typeof v === "object" ? v : {}; } catch { return {}; } })());
  function keepWidths(next: Record<number, number>): void {
    colWidths = next;
    try { globalThis.localStorage?.setItem(WIDTHS_KEY, JSON.stringify(next)); } catch { /* lasts the page */ }
  }
  function startScale(k: number, e: PointerEvent): void {
    e.preventDefault(); e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
    const x0 = e.clientX, w0 = th.getBoundingClientRect().width;
    const move = (m: PointerEvent) => { colWidths = { ...colWidths, [k]: Math.max(24, Math.round(w0 + m.clientX - x0)) }; };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); keepWidths({ ...colWidths }); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  }
  function resetWidth(k: number): void { const next = { ...colWidths }; delete next[k]; keepWidths(next); }
  function headerMenu(k: number, e: MouseEvent): void {
    e.preventDefault();
    const entries: (ContextEntry | null)[] = [];
    const label = (n: number) => word(HEADERS[n]!, HEADER_OWN[n]!);
    if (HEADERS.length - hiddenCols.length > 1) entries.push({ label: word("/Carbon/UI/Common/Hide", `Hide ${label(k)}`, { label: label(k) }), run: () => setHiddenCols([...hiddenCols, k]) });
    const show = HEADERS.map((_, n) => n).filter((n) => hiddenCols.includes(n));
    if (show.length) entries.push(null);
    for (const n of show) entries.push({ label: word("/Carbon/UI/Common/Show", `Show ${label(n)}`, { label: label(n) }), run: () => setHiddenCols(hiddenCols.filter((x) => x !== n)) });
    menu.open(e.clientX, e.clientY, entries);
  }
  function viewModeMenu(e: MouseEvent): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu.open(r.left, r.bottom, VIEW_MODES.map(([id, label, own, icon]) => ({ label: word(label, own), icon: `res:/ui/texture/eveicon/system_icons/${icon}_16px.png`, run: () => { viewMode = id; } })));
  }
  /** _get_sort_menu: each criterion ascending and descending, a line between, the one in use ticked. */
  function sortMenu(e: MouseEvent): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const entries: (ContextEntry | null)[] = [];
    SORT_OPTIONS.forEach(([asc, desc, criteria, ownAsc, ownDesc], i) => {
      if (i > 0) entries.push(null);
      for (const [dir, label, own] of [[0, asc, ownAsc], [1, desc, ownDesc]] as const) {
        entries.push({ label: word(label, own), icon: sortBy === criteria && sortDir === dir ? "res:/UI/Texture/eveicon/system_icons/checkmark_16px.png" : null, run: () => { sortBy = criteria; sortDir = dir; } });
      }
    });
    menu.open(r.left, r.bottom, entries);
  }
  /** _stack_all: invCont.StackAll of the bay shown. */
  function stackAll(): void {
    if (!bay) return;
    void act(() => flow.stackContainer(bay.key === "cargo" ? "cargo" : { kind: "shipBay", bay: bay.key }));
  }
  /** CompressInSpaceController.CompressItems (ui/compressInSpace.ts). */
  const compressInSpace = (items: readonly { itemID: number }[]) => compressItemsInSpace(store, flow, items, (l, own) => word(l, own));
  /** What a move changes read again: the ship's holds, the drone bay, and an opened container (either window shows it). */
  async function refreshPlaces(): Promise<void> {
    const open = store.inventory.get().container;
    await Promise.all([flow.loadMiningHolds().catch(() => {}), flow.loadDrones().catch(() => {}),
      open ? flow.openContainer(open.itemID).catch(() => {}) : Promise.resolve()]);
  }
  async function act(run: () => Promise<void>): Promise<void> {
    moveError = "";
    try { await run(); } catch (cause) { moveError = cause instanceof Error ? cause.message : String(cause); }
    selected = [];
    await refreshPlaces();
  }
  async function dropOn(key: string, e: DragEvent): Promise<void> {
    e.preventDefault();
    dropKey = null;
    const d = dragging;
    dragging = null;
    if (!d || d.from === key) return;
    moveError = "";
    try {
      // the moves judge by the inventory's own rows (the cargo's and the open ship's bays), read first
      await flow.loadInventory();
      if (ship) await flow.openShipBays(ship.itemID);
      // invControllers._AddItem: a single stack dropped with Shift asks how many (PromptUserForQuantity)
      const one = d.ids.length === 1 ? bays.find((b) => b.key === d.from)?.items?.find((i) => i.itemID === d.ids[0]) ?? null : null;
      let quantity: number | null = null;
      if (e.shiftKey && one && one.quantity > 1) {
        quantity = await flow.askMoveQuantity(one.itemID, placeOf(d.from), placeOf(key));
        if (quantity === null) return;
      }
      await flow.transferItems(d.ids, placeOf(d.from), placeOf(key), quantity);
      const inv = store.inventory.get();
      if (inv.actionError && !inv.actionErrorSaid) moveError = inv.actionError;
    } catch (cause) {
      moveError = cause instanceof Error ? cause.message : String(cause);
    }
    selected = [];
    await refreshPlaces();
  }
</script>

<div class="inv" class:container={containerMode} class:compact={$compactSig}>
  {#if !containerMode && $sidebarSig}
  <div class="tree">
    <div class="nodes">
      {#if ship}
        <div onmouseenter={() => void playUiEvent("ui_button_soft2_play")} class="node" class:sel={current === "cargo"} class:drop={dropKey === "cargo"} role="treeitem" aria-selected={current === "cargo"} tabindex="-1"
          onclick={() => (current = "cargo")} onkeydown={() => {}}
          ondragover={dragOver("cargo")} ondragleave={() => (dropKey = null)} ondrop={(e) => void dropOn("cargo", e)}>
          <button type="button" class="exp" class:open={treeOpen} aria-label="Expand" onclick={(e) => { e.stopPropagation(); treeOpen = !treeOpen; }}></button>
          <span class="ticon"><TypeIcon typeID={ship.typeID} name={shipLabel} size="sm" /></span>
          <span class="tlabel">{shipLabel}</span>
        </div>
        {#if treeOpen}
          {#each bays.filter((b) => b.key !== "cargo" && !b.key.startsWith("temp:")) as b (b.key)}
            <div onmouseenter={() => void playUiEvent("ui_button_soft2_play")} class="node sub" class:sel={current === b.key} class:drop={dropKey === b.key} role="treeitem" aria-selected={current === b.key} tabindex="-1"
              onclick={() => (current = b.key)} onkeydown={() => {}}
              ondragover={dragOver(b.key)} ondragleave={() => (dropKey = null)} ondrop={(e) => void dropOn(b.key, e)}>
              <span class="ticon"><img src={clientTexture(BAY_ICON[b.key] ?? "res:/UI/Texture/WindowIcons/cargo.png")} alt=""></span>
              <span class="tlabel">{b.label}</span>
            </div>
          {/each}
        {/if}
      {/if}
      {#each temps as t (t.id)}
        <!-- TreeViewEntry of a removable TreeDataInv: the 73_16_210 remove sprite at the spacer's end (hint Close), the
             icon 4 after it, the label with its distance -->
        <div onmouseenter={() => void playUiEvent("ui_button_soft2_play")} class="node temp" class:far={!t.inRange} class:sel={current === `temp:${t.id}`} role="treeitem" aria-selected={current === `temp:${t.id}`} tabindex="-1"
          class:drop={dropKey === `temp:${t.id}`} onclick={(e) => (e.shiftKey && t.inRange ? openTempInNewWindow(t.id) : openTemp(t.id))} onkeydown={() => {}} oncontextmenu={(e) => tempMenu(t, e)}
          ondragover={$inventoryState.container?.itemID === t.id ? dragOver(`temp:${t.id}`) : undefined} ondragleave={() => (dropKey = null)}
          ondrop={$inventoryState.container?.itemID === t.id ? (e) => void dropOn(`temp:${t.id}`, e) : undefined}>
          <button type="button" class="tremove" title={word("UI/Common/Buttons/Close", "Close")} aria-label={word("UI/Common/Buttons/Close", "Close")}
            style:background-image={`url(${clientTexture("res:/UI/Texture/icons/73_16_210.png")})`} onclick={(e) => { e.stopPropagation(); removeTemp(t.id); }}></button>
          <span class="ticon"><img src={t.icon} alt=""></span>
          <span class="tlabel">{t.name}{#if t.dist}{" "}<span class="tdist">{t.dist}</span>{/if}</span>
        </div>
      {/each}
    </div>
    <div class="filters"><span class="caret"></span><span class="flabel">{word("UI/Inventory/Filters/MyFilters", "My filters")}</span><span class="plus" style:background-image={`url("${clientTexture("res:/ui/texture/eveicon/system_icons/add_16px.png")}")`}></span></div>
  </div>
  {/if}
  <div class="right">
    <!-- _top_action_container: gone in compact mode (_get_top_action_container_display), the search in the header -->
    {#if !$compactSig}
    <div class="top">
      <button type="button" class="tool" title={word("UI/Inventory/StackAll", "Stack All")} onclick={stackAll} style:background-image={`url(${clientTexture("res:/ui/texture/eveicon/system_icons/stack_16px.png")})`}></button>
      <button type="button" class="tool" title={word("UI/Inventory/ViewModeWithCurrent", `View mode (${vm[2]})`, { current_view_mode: word(vm[1], vm[2]) })} onclick={viewModeMenu}
        style:background-image={`url(${clientTexture(`res:/ui/texture/eveicon/system_icons/${vm[3]}_16px.png`)})`}></button>
      {#if viewMode === "icons"}
        <button type="button" class="tool" title={word("UI/Common/SortBy", "Sort by")} onclick={sortMenu} style:background-image={`url(${clientTexture("res:/ui/texture/eveicon/system_icons/bars_sort_ascending_16px.png")})`}></button>
      {/if}
      <div class="gauge">
        <span class="gfill" style:width={`${fill * 100}%`}></span>
        <span class="gfill sec" style:width={`${secondaryFill * 100}%`}></span>
        <span class="gtext">{bay ? `${secondaryVolume ? `(${fmt1(secondaryVolume)}) ` : ""}${fmt1(bay.used ?? 0)}/${bay.capacity === null ? "?" : fmt1(bay.capacity)} m³` : ""}</span>
      </div>
      <input class="search" placeholder="Search" value={$filterSig} oninput={(e) => filterSig.set((e.target as HTMLInputElement).value)} />
    </div>
    {/if}
    <div class="items" role="list" onclick={() => (selected = [])} onkeydown={() => {}}
      ondragover={containerMode ? dragOver("container") : current.startsWith("temp:") ? dragOver(current) : undefined}
      ondrop={containerMode ? (e) => void dropOn("container", e) : current.startsWith("temp:") ? (e) => void dropOn(current, e) : undefined}>
      {#if bay && bay.items === null}
        <p class="none">…</p>
      {:else if !shown.length}
        <p class="none">{word("UI/Common/NothingFound", "Nothing Found")}</p>
      {:else if viewMode !== "icons"}
        <!-- the scroll of listentry.InvItem rows under GetInvItemDefaultHeaders: details with the 32 px icon and the
             label 46 in, list without the icon -->
        <table class="rows" class:details={viewMode === "details"}>
          <thead><tr>{#each HEADERS as h, k}<th class:sorted={column === k} class:hid={hiddenCols.includes(k)} style:width={colWidths[k] ? `${colWidths[k]}px` : null} style:min-width={colWidths[k] ? `${colWidths[k]}px` : null} style:max-width={colWidths[k] ? `${colWidths[k]}px` : null} onclick={() => sortByColumn(k)} oncontextmenu={(e) => headerMenu(k, e)}>{word(h, HEADER_OWN[k]!)}{#if column === k}<span class="dir" class:down={reversed}></span>{/if}<span class="scaler" role="separator" aria-orientation="vertical" onpointerdown={(e) => startScale(k, e)} onclick={(e) => e.stopPropagation()} ondblclick={(e) => { e.stopPropagation(); resetWidth(k); }}></span></th>{/each}</tr></thead>
          <tbody>
            {#each shown as i (i.itemID)}
              {@const fa = facts[i.typeID]}
              <tr class:selected={selected.includes(i.itemID)} draggable="true" onmouseenter={hoverSound} onclick={(e) => clickItem(i.itemID, e)} ondragstart={(e) => dragStart(i.itemID, e)} oncontextmenu={(e) => itemMenu(i.itemID, e)}>
                <td class="nm" class:hid={hiddenCols.includes(0)}>{#if viewMode === "details"}<span class="ricon"><TypeIcon typeID={i.typeID} name={typeName(i.typeID)} size="md" /></span>{/if}{typeName(i.typeID)}</td>
                <td class="num" class:hid={hiddenCols.includes(1)}>{i.quantity.toLocaleString("en-US")}</td>
                <td class:hid={hiddenCols.includes(2)}>{groupName(i.typeID)}</td>
                <td class:hid={hiddenCols.includes(3)}>{categoryName(i.typeID)}</td>
                <td class:hid={hiddenCols.includes(4)}></td>
                <td class:hid={hiddenCols.includes(5)}></td>
                <td class="num" class:hid={hiddenCols.includes(6)}>{fa?.volume != null ? `${(fa.volume * i.quantity).toLocaleString("en-US", { maximumFractionDigits: 2 })} m³` : ""}</td>
                <td class="num" class:hid={hiddenCols.includes(7)}>{fa?.meta ?? ""}</td>
                <td class="num" class:hid={hiddenCols.includes(8)}>{fa?.tech ?? ""}</td>
                <td class="num" class:hid={hiddenCols.includes(9)}>{prices?.get(i.typeID) ? `${Math.round((prices.get(i.typeID) ?? 0) * i.quantity).toLocaleString("en-US")} ISK` : ""}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        {#each shown as i (i.itemID)}
          <div class="item" class:selected={selected.includes(i.itemID)} onmouseenter={hoverSound} title={typeName(i.typeID)} role="listitem" draggable="true"
            onclick={(e) => clickItem(i.itemID, e)} onkeydown={() => {}} ondragstart={(e) => dragStart(i.itemID, e)} oncontextmenu={(e) => itemMenu(i.itemID, e)}>
            <span class="icon"><TypeIcon typeID={i.typeID} name={typeName(i.typeID)} size="lg" />
              {#if !i.singleton}<span class="qty">{fmtAmtShort(i.quantity)}</span>{/if}</span>
            <span class="iname">{typeName(i.typeID)}</span>
          </div>
        {/each}
      {/if}
    </div>
    <div class="foot">
      <span class="count" class:filtered={filtered > 0}>{selected.length
        ? word("UI/Inventory/NumItemsAndSelected2", `${shown.length} Items (${selected.length} selected)`, { numItems: shown.length, numSelected: selected.length, numFilteredTxt: filtered > 0 ? word("UI/Inventory/NumFiltered", `(${filtered} filtered)`, { numFiltered: filtered }) : "" })
        : word("UI/Inventory/NumItems2", `${shown.length} Items`, { numItems: shown.length, numFilteredTxt: filtered > 0 ? word("UI/Inventory/NumFiltered", `(${filtered} filtered)`, { numFiltered: filtered }) : "" })}</span>
      {#if moveError}<span class="err">{moveError}</span>{/if}
      <span class="price">{word("UI/Inventory/EstIskPrice2", `${Math.round(isk).toLocaleString("en-US")} ISK Est. price`, { iskString: `${Math.round(isk).toLocaleString("en-US")} ISK` })}</span>
      {#if (containerMode || current.startsWith("temp:")) && lootable}
        <!-- BaseCelestialContainer.GetSpecialActions: Loot All for a lootable can or wreck (ShipCargo().AddItems of its items),
             in specialActionsCont at the right of the window's foot, 16 from the labels, a Density.COMPACT Button -->
        <span class="special"><button type="button" class="client-btn compact" onclick={() => { const id = $inventoryState.container?.itemID; if (id) void act(async () => { await flow.lootContainer(id); }); }}>{word("UI/Inventory/LootAll", "Loot All")}</button></span>
      {/if}
    </div>
  </div>
</div>

<style>
  .special { margin-left: auto; padding-left: 16px; display: flex; flex: none; }
  /* measured in the client through gridcheck: the tree, filters and footer TextBody / EveLabelMedium 14, the search 14,
     the capacity EveLabelSmall 12, Nothing Found EveCaptionLarge 24 */
  /* the tree entries TextCustom at TextColor.NORMAL 0.75, the selected one HIGHLIGHT 0.9 (read through gridcheck) */
  .inv { display: flex; height: 100%; min-height: 0; font-size: 14px; color: rgba(255, 255, 255, 0.75); user-select: none; }
  /* the tree column 152 wide (gridcheck: mainCont 18..170), its dragArea's 1 px line at its right, the right side's buttons from 12 past it (182) */
  .tree { width: 152px; flex: none; display: flex; flex-direction: column; background: rgba(255, 255, 255, 0.03); margin: 0 12px 0 0; box-shadow: 1px 0 0 rgba(255, 255, 255, 0.1); }
  /* invWindow's tree (read through gridcheck): a ScrollContainer padLeft -8 with 16 on top; each TreeViewEntry 24 high, its
     spacer (1 + level) * LEFTPUSH 8 + 16 wide with the 16 px toggle at its right (the Neocom arrowDown in it, padded 4 4 5 5,
     LED grey, turned a quarter while collapsed), the icon height - 2 = 22, the TextBody label 4 after it */
  .nodes { flex: 1; overflow: auto; padding: 16px 0 0; margin-left: -8px; }
  .node { position: relative; display: flex; align-items: center; gap: 0; height: 24px; padding: 0; cursor: default; }
  /* TreeViewEntry (read through gridcheck): a ListEntryUnderlay 23 high, THEME_FOCUSDARK at 0.2 hovered and 0.4 selected, and
     for the selected one a SelectionIndicatorLine 1 x 16 at (4, 4) in 0.69 grey */
  .node::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 23px; background: var(--theme-focus-dark, #305665); opacity: 0; pointer-events: none; }
  .node:hover::before { opacity: 0.2; }
  .node.sel::before { opacity: 0.4; }
  .node.sel::after { content: ""; position: absolute; left: 4px; top: 4px; width: 1px; height: 16px; background: rgb(176, 176, 176); pointer-events: none; }
  .node.sel { color: rgba(255, 255, 255, 0.9); }
  .node > * { position: relative; }
  .node.sub { padding-left: 32px; }
  /* a temporary location (read through gridcheck on a can in ActiveShipCargo): a root entry 8 below the one before, the
     remove sprite 16 x 16 at 24, the icon at 44, the label at 70, its distance <color=#66FFFFFF> */
  .node.temp { margin-top: 8px; padding-left: 24px; }
  .tremove { flex: none; width: 16px; height: 16px; min-height: 0; margin-right: 4px; padding: 0; border: 0; background: center / 16px 16px no-repeat; cursor: pointer; }
  .tdist { color: rgba(255, 255, 255, 0.4); }
  /* TreeViewEntry.SetAccessability (invWindow.UpdateCelestialEntryStatus every 500 ms): out of range the icon and the
     label TextColor.DISABLED 0.3 (selected or not) */
  .node.temp .ticon img { opacity: 0.75; }
  .node.temp.far .ticon img { opacity: 0.3; }
  .node.temp.far, .node.temp.far.sel { color: rgba(255, 255, 255, 0.3); }
  .exp { flex: none; width: 24px; height: 24px; min-height: 0; padding: 0; border: 0; background: transparent; position: relative; cursor: pointer; }
  .exp::before { content: ""; position: absolute; left: 12px; top: 8px; width: 7px; height: 7px; background: rgba(255, 255, 255, 0.5);
    mask: url(/client-res/ui/texture/classes/neocom/arrowdown.png) center / 7px 7px no-repeat; -webkit-mask: url(/client-res/ui/texture/classes/neocom/arrowdown.png) center / 7px 7px no-repeat;
    transform: rotate(-90deg); transition: transform .15s; }
  .exp.open::before { transform: none; }
  .ticon { width: 22px; height: 22px; flex: none; display: grid; overflow: hidden; margin-right: 4px; }
  .ticon :global(.type-icon) { width: 22px; height: 22px; }
  .ticon :global(.type-icon img) { width: 22px; height: 22px; }
  .ticon img { width: 22px; height: 22px; }
  .tlabel { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* InvFilters: a drag area 8 high (its line at 3) over the filterHeaderCont, 24 high, padRight 8: expandFiltersBtn 24 wide
     with the 7 px Neocom arrowDown, the Label 14, createFilterBtn 24 x 24 with eveicon.add 16 at the right */
  .filters { position: relative; display: flex; align-items: center; height: 24px; margin-top: 8px; padding: 0 8px 0 0; color: rgba(255, 255, 255, 0.75); }
  .filters::before { content: ""; position: absolute; left: 0; right: 0; top: -5px; height: 1px; background: rgba(255, 255, 255, 0.1); }
  .filters .flabel { flex: 1; font-size: 14px; }
  .filters .plus { flex: none; width: 24px; height: 24px; background: center / 16px 16px no-repeat; opacity: 0.75; cursor: pointer; }
  .filters .caret { flex: none; width: 24px; height: 24px; position: relative; }
  .filters .caret::before { content: ""; position: absolute; left: 9px; top: 9px; width: 7px; height: 7px; background: rgba(255, 255, 255, 0.5);
    mask: url(/client-res/ui/texture/classes/neocom/arrowdown.png) center / 7px 7px no-repeat; -webkit-mask: url(/client-res/ui/texture/classes/neocom/arrowdown.png) center / 7px 7px no-repeat; transform: rotate(-90deg); }
  .right { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .top { display: flex; align-items: center; gap: 0; height: 24px; margin-bottom: 16px; }
  .tool { padding: 0; border: 0; background-color: transparent; cursor: pointer; width: 24px; height: 24px; flex: none; background: center / 16px 16px no-repeat; opacity: 0.8; }
  .tool:hover { opacity: 1; }
  /* the top row's dividerParent (gridcheck, 600 wide window): InvContCapacityGauge 170 wide at 262, the dragArea 8 (its
     DividerLine at 3), the quick filter the rest (142, to the content's right) */
  .gauge { position: relative; flex: none; width: 170px; min-width: 0; height: 24px; margin: 0 0 0 8px; background: rgba(0, 0, 0, 0.4); }
  .gauge::after { content: ""; position: absolute; right: -4px; top: 0; width: 1px; height: 24px; background: rgba(255, 255, 255, 0.1); }
  /* its fills (gridcheck): the bg black 0.4, the gauge THEME_FOCUSDARK at 0.6 (Photon 48, 86, 101), the label EveLabelSmall
     white 0.75 at 8, 1 below the middle */
  .gfill { position: absolute; left: 0; top: 0; bottom: 0; background: color-mix(in srgb, var(--theme-focus-dark, #305665) 60%, transparent); }
  /* capacityGaugeSec, over the gauge: the selected items' share in THEME_FOCUS 0.6 */
  .gfill.sec { background: color-mix(in srgb, var(--theme-focus, #58a7bf) 60%, transparent); }
  .gtext { position: absolute; left: 8px; top: 1px; line-height: 24px; font-size: 12px; color: rgba(255, 255, 255, 0.75); white-space: nowrap; }
  .search { width: auto; flex: 1; min-width: 0; margin-left: 8px; height: 24px; box-sizing: border-box; border: 0; background: rgba(0, 0, 0, 0.3); color: #fff; padding: 0 6px; font-size: 14px; }
  /* the ShipCargo scroll's entries and the footer's labels from 16 past the tree column (186) */
  .items { padding-left: 4px; flex: 1; overflow: auto; display: flex; flex-wrap: wrap; align-content: flex-start; gap: 8px; }
  .none { width: 100%; margin: 0; text-align: center; font-size: 24px; color: rgba(255, 255, 255, 0.6); letter-spacing: 0.5px; }
  .item { width: 64px; height: 103px; display: flex; flex-direction: column; align-items: center; }
  .icon { position: relative; width: 64px; height: 64px; display: grid; background: rgba(255, 255, 255, 0.05); }
  .icon :global(.type-icon) { width: 64px; height: 64px; }
  /* InvItem qtypar: BOTTOMRIGHT at 2, 2, black OPACITY_BG 0.9, its EveLabelSmall padded 4 1 4 0, FmtAmt(qty, "ss") */
  /* InvItemIconContainer's qtypar (read through gridcheck on a Tritanium stack): 2 in from the icon's corner, its 12 px
     EveLabelSmall white 4 in and 1 down (17 high); the itemNameLabel at 0.75 */
  .qty { position: absolute; right: 2px; bottom: 2px; padding: 1px 4px 0; background: rgba(0, 0, 0, 0.9); font-size: 12px; line-height: 16px; color: #fff; }
  /* InvItem (gridcheck): 64 x 103, its quantity EveLabelSmall 12, its name a centred Label 14, 70 wide */
  .iname { margin-top: 2px; width: 70px; text-align: center; font-size: 14px; line-height: 18px; color: rgba(255, 255, 255, 0.75); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  /* numItemsLabel / totalPriceLabel: TextColor.SECONDARY 0.5 */
  .foot { padding-left: 4px; display: flex; align-items: center; gap: 8px; height: 24px; color: rgba(255, 255, 255, 0.5); }
  .count { font-weight: 700; }
  /* UpdateNumberOfItems: with items filtered out, its text SUCCESS_GREEN */
  .count.filtered { color: #8dc169; }
  .rows { width: 100%; border-collapse: collapse; font-size: 12px; align-self: flex-start; }
  /* the scroll's ColumnHeaders (gridcheck, details): 24 high, the EveLabelSmall 12 at 8 */
  .rows th { position: sticky; top: 0; text-align: left; font-weight: 400; color: rgba(255, 255, 255, 0.5); padding: 0 8px; height: 24px; box-sizing: border-box; white-space: nowrap; background: rgba(0, 0, 0, 0.4); }
  /* uix.GetInvItemDefaultHiddenHeaders: Category, Meta Level and Tech Level hidden by default */
  .rows .hid { display: none; }
  .rows th { overflow: hidden; text-overflow: clip; }
  .rows .scaler { position: absolute; top: 0; right: 0; width: 8px; height: 24px; cursor: col-resize; }
  .rows .scaler::after { content: ""; position: absolute; left: 3px; top: 4px; width: 1px; height: 16px; background: rgba(255, 255, 255, 0.15); }
  .rows td { padding: 0 6px; height: 20px; white-space: nowrap; border-bottom: 1px solid rgba(255, 255, 255, 0.04); }
  /* the details' Item entry 42 high, its EveLabelMedium 14, the 32 px icon at 5, 5 and the text 9 after it (46) */
  .rows.details td { height: 42px; font-size: 14px; }
  .rows.details td.nm { padding-left: 0; }
  /* the list's Item entry (gridcheck, VIEWMODE_LIST): 21 high, its EveLabelMedium 14 from 12 */
  .rows:not(.details) td { height: 21px; font-size: 14px; }
  .rows:not(.details) td.nm { padding-left: 12px; }
  /* (the scroll's entries' ListEntryUnderlay: THEME_FOCUSDARK at 0.2 under the mouse, 0.4 selected) */
  .rows tr:hover td { background: color-mix(in srgb, var(--theme-focus-dark, #305665) 20%, transparent); }
  .rows tr.selected td { background: color-mix(in srgb, var(--theme-focus-dark, #305665) 40%, transparent); }
  .rows .num { text-align: right; }
  .rows th { cursor: pointer; }
  /* the scroll's ColumnHeader (read through gridcheck on the cargo's list view): its EveLabelSmall at white 0.5, sorted
     or not; the sorted one's direction_indicator a 16 px caret at 0.75, 4 from its right (before the scaler) */
  .rows th.sorted { color: rgba(255, 255, 255, 0.5); }
  .rows th .dir { position: absolute; right: 4px; top: 4px; width: 16px; height: 16px; opacity: 0.75; background: url(/client-res/ui/texture/eveicon/system_icons/caret_up_16px.png) center / 16px no-repeat; }
  .rows th .dir.down { background-image: url(/client-res/ui/texture/eveicon/system_icons/caret_down_16px.png); }
  .rows .nm { display: flex; align-items: center; gap: 9px; }
  .ricon { width: 32px; height: 32px; display: grid; margin-left: 5px; }
  .ricon :global(.type-icon) { width: 32px; height: 32px; }
  .err { color: #d08a6a; }
  /* the selection frame, and a bay a drag may drop on */
  /* InvItem in the icon view (read in item.py): hovered or selected, the icon padded 4 in (_get_icon_frame_padding), the
     ItemSelectionFrame's 2 px FRAME_BORDER2 in the UI highlight colour with its glow at 0.5, the ListEntryUnderlay in
     THEME_FOCUSDARK at 0.2 hovered, 0.4 selected */
  .item .icon :global(.type-icon) { transition: transform .1s; }
  .item:hover .icon, .item.selected .icon { box-shadow: inset 0 0 0 2px var(--theme-focus, #58a7bf), 0 0 6px color-mix(in srgb, var(--theme-focus, #58a7bf) 50%, transparent); }
  .item:hover .icon { background: color-mix(in srgb, var(--theme-focus-dark, #305665) 20%, transparent); }
  .item.selected .icon { background: color-mix(in srgb, var(--theme-focus-dark, #305665) 40%, transparent); }
  .item:hover .icon :global(.type-icon), .item.selected .icon :global(.type-icon) { transform: scale(0.875); }
  /* TreeViewEntry.OnDragEnter: the hover underlay, as the mouse over it (hoverBG.hovered) */
  .node.drop:not(.sel)::before { opacity: 0.2; }
</style>
