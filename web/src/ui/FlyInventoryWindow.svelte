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
  import { clientTexture } from "./skillGroupIcons.ts";
  import { shipHoldTarget } from "./shipHold.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import { SHIP_HOLDS, CARGO_HOLD } from "../bridge/shipHolds.ts";
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

  const MENU = { market: "UI/Inventory/ItemActions/ViewTypesMarketDetails", buy: "UI/Inventory/ItemActions/BuyThisType", compare: "UI/Compare/CompareButton",
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
  const WORDS = [...Object.values(MENU), ...HEADERS, ...SORT_OPTIONS.flatMap((o) => [o[0], o[1]]), ...VIEW_MODES.map((v) => v[1]), "UI/Inventory/ViewModeWithCurrent", "UI/Inventory/NumItems2", "UI/Inventory/NumItemsAndSelected2", "UI/Inventory/EstIskPrice2", "UI/Inventory/StackAll", "UI/Inventory/LootAll", "UI/Common/SortBy", "UI/Inventory/ViewMode",
    "UI/Inventory/Filters/MyFilters", "UI/Common/NothingFound", ...SHIP_HOLDS.map((h) => h.label), CARGO_HOLD.label];
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
  const droneBayCapacity = $derived(($fitting.shipAttributes?.[283] as number | undefined) ?? null);
  const bays = $derived.by((): Bay[] => {
    const out: Bay[] = [];
    if (containerMode) {
      const c = $inventoryState.container;
      if (c) out.push({ key: "container", label: "", items: c.rows.map((i) => ({ itemID: i.itemID, typeID: i.typeID, quantity: i.quantity < 0 ? 1 : i.quantity, singleton: i.singleton, categoryID: i.categoryID })),
        capacity: c.capacity?.capacity ?? null, used: c.capacity?.used ?? null });
      return out;
    }
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
    return out;
  });
  let volumes = $state<Record<string, number>>({});
  $effect(() => {
    const ids = [...new Set(($drones.bay ?? []).map((d) => d.typeID))].filter((t) => volumes[String(t)] === undefined);
    if (ids.length) void flow.typeVolumes(ids).then((v) => { volumes = { ...volumes, ...v }; }).catch(() => {});
  });
  $effect(() => {
    const refs: NameRef[] = [];
    if (ship?.typeID) refs.push({ kind: "type", id: ship.typeID });
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
  const bay = $derived(bays.find((b) => b.key === current) ?? bays.find((b) => b.key === "cargo") ?? null);
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
  const isk = $derived(shown.reduce((n, i) => n + (prices?.get(i.typeID) ?? 0) * i.quantity, 0));

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
  const placeOf = (key: string) => (key === "cargo" ? { kind: "cargo" as const } : key === "container" ? { kind: "container" as const, itemID: store.inventory.get().container?.itemID ?? 0 } : { kind: "shipBay" as const, bay: key });
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
    const entries: (ContextEntry | null)[] = [];
    if (one) {
      entries.push({ label: word(MENU.market, "View Market Details"), run: () => showMarketDetails(one.typeID) });
      entries.push({ label: word(MENU.buy, "Buy This Type"), run: () => buyMarketType(one.typeID) });
      // OfferCompressInSpace: a compressible type directly in the active ship in space (DirectlyCompressInSpace)
      if (compressible.has(one.typeID)) entries.push({ label: word(MENU.compress, "Compress"), run: () => void compressInSpace(items) });
      if (one.categoryID !== null && [6, 7, 18].includes(one.categoryID)) entries.push({ label: word(MENU.compare, "Compare"), run: () => typeCompareTarget.ask(items.map((i) => ({ typeID: i.typeID, itemID: i.itemID }))) });
    }
    entries.push(fromBay === "drone"
      ? { label: word(MENU.launch, ids.length > 1 ? "Launch Drones" : "Launch Drone", { numDrones: ids.length }), run: () => void act(() => flow.launchDrones(ids)) }
      : { label: word(MENU.jettison, "Jettison"), run: () => void act(() => flow.jettisonItems(ids)) });
    if (one) {
      entries.push({ label: word(MENU.info, "Show Info"), info: true, run: () => showInfo({ kind: "type", typeID: one.typeID, itemID: one.itemID }) });
      entries.push({ label: word(MENU.contracts, "Find in Contracts"), run: () => findInContracts(one.typeID) });
      entries.push({ label: word(MENU.assets, "Find Personal Assets"), run: () => findInPersonalAssets(typeName(one.typeID)) });
      entries.push({ label: word(MENU.quickbar, "Add to Market Quickbar"), run: () => { changeQuickbar((q) => addType(q, one.typeID)); } });
    }
    menu.open(e.clientX, e.clientY, entries);
  }
  /** _get_view_mode_menu: each mode with its icon. */
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
        <div class="node" class:sel={current === "cargo"} class:drop={dropKey === "cargo"} role="treeitem" aria-selected={current === "cargo"} tabindex="-1"
          onclick={() => (current = "cargo")} onkeydown={() => {}}
          ondragover={dragOver("cargo")} ondragleave={() => (dropKey = null)} ondrop={(e) => void dropOn("cargo", e)}>
          <button type="button" class="exp" class:open={treeOpen} aria-label="Expand" onclick={(e) => { e.stopPropagation(); treeOpen = !treeOpen; }}></button>
          <span class="ticon"><TypeIcon typeID={ship.typeID} name={shipLabel} size="sm" /></span>
          <span class="tlabel">{shipLabel}</span>
        </div>
        {#if treeOpen}
          {#each bays.filter((b) => b.key !== "cargo") as b (b.key)}
            <div class="node sub" class:sel={current === b.key} class:drop={dropKey === b.key} role="treeitem" aria-selected={current === b.key} tabindex="-1"
              onclick={() => (current = b.key)} onkeydown={() => {}}
              ondragover={dragOver(b.key)} ondragleave={() => (dropKey = null)} ondrop={(e) => void dropOn(b.key, e)}>
              <span class="ticon"><img src={clientTexture(BAY_ICON[b.key] ?? "res:/UI/Texture/WindowIcons/cargo.png")} alt=""></span>
              <span class="tlabel">{b.label}</span>
            </div>
          {/each}
        {/if}
      {/if}
    </div>
    <div class="filters"><span class="caret">▴</span> {word("UI/Inventory/Filters/MyFilters", "My filters")}<span class="plus">+</span></div>
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
        <span class="gtext">{bay ? `${fmt1(bay.used ?? 0)}/${bay.capacity === null ? "?" : fmt1(bay.capacity)} m³` : ""}</span>
      </div>
      <input class="search" placeholder="Search" value={$filterSig} oninput={(e) => filterSig.set((e.target as HTMLInputElement).value)} />
    </div>
    {/if}
    <div class="items" role="list" onclick={() => (selected = [])} onkeydown={() => {}}
      ondragover={containerMode ? dragOver("container") : undefined} ondrop={containerMode ? (e) => void dropOn("container", e) : undefined}>
      {#if bay && bay.items === null}
        <p class="none">…</p>
      {:else if !shown.length}
        <p class="none">{word("UI/Common/NothingFound", "Nothing Found")}</p>
      {:else if viewMode !== "icons"}
        <!-- the scroll of listentry.InvItem rows under GetInvItemDefaultHeaders: details with the 32 px icon and the
             label 46 in, list without the icon -->
        <table class="rows" class:details={viewMode === "details"}>
          <thead><tr>{#each HEADERS as h, k}<th class:sorted={column === k} onclick={() => sortByColumn(k)}>{word(h, HEADER_OWN[k]!)}{#if column === k}<span class="dir">{reversed ? "▼" : "▲"}</span>{/if}</th>{/each}</tr></thead>
          <tbody>
            {#each shown as i (i.itemID)}
              {@const fa = facts[i.typeID]}
              <tr class:selected={selected.includes(i.itemID)} draggable="true" onclick={(e) => clickItem(i.itemID, e)} ondragstart={(e) => dragStart(i.itemID, e)} oncontextmenu={(e) => itemMenu(i.itemID, e)}>
                <td class="nm">{#if viewMode === "details"}<span class="ricon"><TypeIcon typeID={i.typeID} name={typeName(i.typeID)} size="md" /></span>{/if}{typeName(i.typeID)}</td>
                <td class="num">{i.quantity.toLocaleString("en-US")}</td>
                <td>{groupName(i.typeID)}</td>
                <td>{categoryName(i.typeID)}</td>
                <td></td>
                <td></td>
                <td class="num">{fa?.volume != null ? `${(fa.volume * i.quantity).toLocaleString("en-US", { maximumFractionDigits: 2 })} m³` : ""}</td>
                <td class="num">{fa?.meta ?? ""}</td>
                <td class="num">{fa?.tech ?? ""}</td>
                <td class="num">{prices?.get(i.typeID) ? `${Math.round((prices.get(i.typeID) ?? 0) * i.quantity).toLocaleString("en-US")} ISK` : ""}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        {#each shown as i (i.itemID)}
          <div class="item" class:selected={selected.includes(i.itemID)} title={typeName(i.typeID)} role="listitem" draggable="true"
            onclick={(e) => clickItem(i.itemID, e)} onkeydown={() => {}} ondragstart={(e) => dragStart(i.itemID, e)} oncontextmenu={(e) => itemMenu(i.itemID, e)}>
            <span class="icon"><TypeIcon typeID={i.typeID} name={typeName(i.typeID)} size="lg" />
              {#if !i.singleton}<span class="qty">{i.quantity.toLocaleString("en-US")}</span>{/if}</span>
            <span class="iname">{typeName(i.typeID)}</span>
          </div>
        {/each}
      {/if}
    </div>
    {#if containerMode && lootable}
      <!-- BaseCelestialContainer.GetSpecialActions: Loot All for a lootable can or wreck (ShipCargo().AddItems of its items) -->
      <div class="special"><button type="button" onclick={() => { const id = $inventoryState.container?.itemID; if (id) void act(async () => { await flow.lootContainer(id); }); }}>{word("UI/Inventory/LootAll", "Loot All")}</button></div>
    {/if}
    <div class="foot">
      <span class="count">{selected.length
        ? word("UI/Inventory/NumItemsAndSelected2", `${shown.length} Items (${selected.length} selected)`, { numItems: shown.length, numSelected: selected.length, numFilteredTxt: filtered > 0 ? `(${filtered} filtered)` : "" })
        : word("UI/Inventory/NumItems2", `${shown.length} Items`, { numItems: shown.length, numFilteredTxt: filtered > 0 ? `(${filtered} filtered)` : "" })}</span>
      {#if moveError}<span class="err">{moveError}</span>{/if}
      <span class="price">{word("UI/Inventory/EstIskPrice2", `${Math.round(isk).toLocaleString("en-US")} ISK Est. price`, { iskString: `${Math.round(isk).toLocaleString("en-US")} ISK` })}</span>
    </div>
  </div>
</div>

<style>
  .special { display: flex; justify-content: flex-end; padding: 4px 0; }
  .special button { height: 24px; padding: 0 14px; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.25); color: inherit; font: inherit; cursor: pointer; }
  /* measured in the client through gridcheck: the tree, filters and footer TextBody / EveLabelMedium 14, the search 14,
     the capacity EveLabelSmall 12, Nothing Found EveCaptionLarge 24 */
  .inv { display: flex; height: 100%; min-height: 0; font-size: 14px; color: rgba(255, 255, 255, 0.85); user-select: none; }
  .tree { width: 160px; flex: none; display: flex; flex-direction: column; background: rgba(255, 255, 255, 0.03); margin: 0 8px 0 0; }
  .nodes { flex: 1; overflow: auto; padding: 4px 0; }
  .node { display: flex; align-items: center; gap: 4px; height: 24px; padding: 0 6px; cursor: default; }
  .node:hover { background: rgba(255, 255, 255, 0.06); }
  .node.sel { background: rgba(88, 167, 191, 0.25); color: #fff; }
  .node.sub { padding-left: 28px; }
  .exp { width: 12px; height: 12px; padding: 0; border: 0; background: transparent; position: relative; cursor: pointer; }
  .exp::before { content: ""; position: absolute; left: 3px; top: 2px; border-left: 5px solid rgba(255, 255, 255, 0.7); border-top: 4px solid transparent; border-bottom: 4px solid transparent; transition: transform .1s; }
  .exp.open::before { transform: rotate(90deg); }
  .ticon { width: 16px; height: 16px; flex: none; display: grid; overflow: hidden; }
  .ticon :global(.type-icon) { width: 16px; height: 16px; }
  .ticon img { width: 16px; height: 16px; }
  .tlabel { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .filters { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; color: rgba(255, 255, 255, 0.8); }
  .filters .plus { margin-left: auto; font-size: 18px; }
  .caret { font-size: 10px; }
  .right { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .top { display: flex; align-items: center; gap: 0; height: 24px; margin-bottom: 16px; }
  .tool { padding: 0; border: 0; background-color: transparent; cursor: pointer; width: 24px; height: 24px; flex: none; background: center / 16px 16px no-repeat; opacity: 0.8; }
  .tool:hover { opacity: 1; }
  .gauge { position: relative; flex: 1; min-width: 0; height: 24px; margin: 0 8px; background: rgba(0, 0, 0, 0.3); }
  .gfill { position: absolute; left: 0; top: 0; bottom: 0; background: rgba(88, 167, 191, 0.35); }
  .gtext { position: absolute; left: 8px; top: 0; line-height: 24px; font-size: 12px; color: rgba(255, 255, 255, 0.8); white-space: nowrap; }
  .search { width: 128px; flex: none; height: 24px; box-sizing: border-box; border: 0; background: rgba(0, 0, 0, 0.3); color: #fff; padding: 0 6px; font-size: 14px; }
  .items { flex: 1; overflow: auto; display: flex; flex-wrap: wrap; align-content: flex-start; gap: 8px; }
  .none { width: 100%; margin: 0; text-align: center; font-size: 24px; color: rgba(255, 255, 255, 0.6); letter-spacing: 0.5px; }
  .item { width: 64px; height: 103px; display: flex; flex-direction: column; align-items: center; }
  .icon { position: relative; width: 64px; height: 64px; display: grid; background: rgba(255, 255, 255, 0.05); }
  .icon :global(.type-icon) { width: 64px; height: 64px; }
  .qty { position: absolute; right: 2px; bottom: 2px; padding: 1px 4px 0; background: rgba(0, 0, 0, 0.75); font-size: 12px; line-height: 14px; }
  /* InvItem (gridcheck): 64 x 103, its quantity EveLabelSmall 12, its name a centred Label 14, 70 wide */
  .iname { margin-top: 2px; width: 70px; text-align: center; font-size: 14px; line-height: 18px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .foot { display: flex; align-items: center; gap: 8px; height: 24px; color: rgba(255, 255, 255, 0.55); }
  .count { font-weight: 700; }
  .rows { width: 100%; border-collapse: collapse; font-size: 12px; align-self: flex-start; }
  .rows th { position: sticky; top: 0; text-align: left; font-weight: 400; color: rgba(255, 255, 255, 0.6); padding: 2px 6px; white-space: nowrap; background: rgba(0, 0, 0, 0.4); }
  .rows td { padding: 0 6px; height: 20px; white-space: nowrap; border-bottom: 1px solid rgba(255, 255, 255, 0.04); }
  .rows.details td { height: 36px; }
  .rows tr:hover td { background: rgba(255, 255, 255, 0.05); }
  .rows tr.selected td { background: rgba(255, 255, 255, 0.12); }
  .rows .num { text-align: right; }
  .rows th { cursor: pointer; }
  .rows th.sorted { color: #fff; }
  .rows th .dir { margin-left: 4px; font-size: 8px; }
  .rows .nm { display: flex; align-items: center; gap: 9px; }
  .ricon { width: 32px; height: 32px; display: grid; margin-left: 5px; }
  .ricon :global(.type-icon) { width: 32px; height: 32px; }
  .err { color: #d08a6a; }
  /* the selection frame, and a bay a drag may drop on */
  .item.selected .icon { box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.5); background: rgba(255, 255, 255, 0.08); }
  .node.drop { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.4); }
</style>
