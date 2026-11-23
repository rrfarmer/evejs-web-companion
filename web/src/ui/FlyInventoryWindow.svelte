<script lang="ts" module>
  // one drag for every inventory window: a stack dragged out of a container drops on the ship's tree, and back
  let dragging: { from: string; ids: number[]; stacks: { typeID: number; quantity: number }[] } | null = null;
</script>

<script lang="ts">
  import { iskAndRound, roundIsk } from "../bridge/miningScanResults.ts";
  import { fittedColumnWidth, scrollListHomeEnd } from "./scrollColumnFit.ts";
  import { hideLabelShortcutTooltip, showItemTooltip, tooltipDue } from "../play/labelShortcutTooltip.ts";
  import { shortcutOf } from "../play/shortcutKeys.ts";
  /** uix ESTIMATED_PRICE column: FmtISK(stacksize * GetAveragePrice) - whole where the sum is whole, else two places
   *  (read through gridcheck: 2,468 ISK; 2,468.50 ISK). */
  /** uix GetItemData volume: ValueAndUnit of FmtAmt(volume, two places where it has a fraction, else none) and the unit's
   *  display name, "m3" (read through gridcheck: 603.70 m3, 12.34 m3, 50 m3, 12,345.60 m3). */
  const volCell = (v: number): string => `${v.toLocaleString("en-US", Math.abs(v - Math.trunc(v)) > 1e-6 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 })} m3`;
  /** uix._get_item_size: the chargeSize by its sizeclass unit (read through gridcheck: 1 Small, 2 Medium, 3 Large, 4 X-Large). */
  const sizeCell = (c: TypeColumnFacts | undefined): string => (c?.chargeSize ? (["", "Small", "Medium", "Large", "X-Large"][c.chargeSize] ?? String(c.chargeSize)) : "");
  /** uix._get_item_slot: an implant's or booster's slot number, else GetPowerSlotSizeSymbol (UI/Inventory/SlotRigs, SlotHigh, SlotMedium, SlotLow). */
  const slotCell = (c: TypeColumnFacts | undefined): string => {
    if (!c) return "";
    if (c.implantness !== null) return String(c.implantness);
    if (c.boosterness !== null) return String(c.boosterness);
    const SLOT: Record<string, readonly [string, string]> = { rig: ["UI/Inventory/SlotRigs", "Rigs"], high: ["UI/Inventory/SlotHigh", "High"], mid: ["UI/Inventory/SlotMedium", "Medium"], low: ["UI/Inventory/SlotLow", "Low"] };
    const w = c.slot ? SLOT[c.slot] : undefined;
    return w ? word(w[0], w[1]) : "";
  };
  const fmtIskCell = (v: number): string => `${v.toLocaleString("en-US", Number.isInteger(v) ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ISK`;
  // The active ship's inventory window in space, laid out as the 3698585 client's ActiveShipCargo (invWindow.Inventory,
  // 600 x 450): the tree at the left (TREE_DEFAULT_WIDTH 160) with the ship as "<name> (<type>)" - its cargo - and its
  // other bays under it, My filters at its foot; at the right the top row (Stack All, the view mode and sort buttons, the
  // capacity gauge, the quick filter), the items (InvItem in icons view: a 64 px icon, its quantity at the bottom right
  // on black, the name under it in two lines at most; "Nothing Found" where none), and the foot's "<n> Items" and
  // "<isk> ISK Est. price" (UpdateNumberOfItems, UpdateIskPriceLabel).
  import { invAlwaysSeparate, invCompact, invFilter, invKeepFilter, invSidebar, invViewMode } from "./inventoryWindowSettings.ts";
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
  import { DEFAULT_INVENTORY_FILTERS, FILTER_FIELD, INVENTORY_FILTERS_SETTING, matchInventoryFilter, readInventoryFilters, roundInventoryFilterPrice, writeInventoryFilters, type InventoryFilter, type InventoryFilterFacts } from "../bridge/inventoryFilters.ts";
  import { loadInventoryFilterFacts, TYPE_FILTER_FIELDS } from "../app/inventoryFilterFacts.ts";
  import { getTypeMeta } from "../app/api.ts";
  // SE_BaseClassCore.OnMouseEnter: PlaySound(sound_hover = uiconst.SOUND_ENTRY_HOVER, ui_button_soft2_play) as an entry lights; an
  // InvItem not while the left button is down
  const hoverSound = (e: MouseEvent) => { if (!(e.buttons & 1)) void playUiEvent("ui_button_soft2_play"); };
  // TreeViewEntry.OnExpanded / OnCollapsed: SOUND_EXPAND / SOUND_COLLAPSE as the ship's children show or hide
  const toggleTree = () => { treeOpen = !treeOpen; void playUiEvent(treeOpen ? "ui_expand_play" : "ui_collapse_play"); };
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, TypeColumnFacts } from "../app/flow.ts";
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
  // bayMode: a ship bay in an inventory window of its own (TreeDataInv.OpenNewWindow on a bay: the window captioned with
  // the bay's name, its tree collapsed), the bay's key
  let { store, flow, containerMode = false, bayMode = null }: { store: ClientStore; flow: AppFlow; containerMode?: boolean; bayMode?: string | null } = $props();
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
    compressNone: "UI/Compression/FailureToCompressAny", moveToDroneBay: "UI/Drones/MoveToDroneBay", loadCharges: "UI/Inventory/ItemActions/LoadCharges" } as const;
  // godma hasShipMaintenanceBay (attribute 907) of the ship types on the grid, read once each
  const maintenanceBayTypes = new Map<number, boolean>();
  $effect(() => {
    const unknown = [...new Set(($space.snapshot?.entities ?? []).filter((x) => x.categoryID === 6 && x.typeID != null && !maintenanceBayTypes.has(x.typeID)).map((x) => x.typeID!))];
    if (unknown.length === 0) return;
    for (const t of unknown) maintenanceBayTypes.set(t, false);
    void flow.typeAttributes(unknown, [907]).then((a) => { for (const t of unknown) maintenanceBayTypes.set(t, (a[t]?.[907] ?? 0) > 0); });
  });
  function maintenanceNearby(): boolean {
    const snap = $space.snapshot;
    const own = snap?.entities.find((x) => x.isSelf);
    if (!snap || !own) return false;
    return snap.entities.some((x) => (x.groupID === 363 || (x.categoryID === 6 && x.typeID != null && maintenanceBayTypes.get(x.typeID) === true))
      && surfaceDistanceMeters(own.position, own.radius, x.position, x.radius) < 5000);
  }
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
  const WORDS = [...Object.values(MENU), ...HEADERS, ...SORT_OPTIONS.flatMap((o) => [o[0], o[1]]), ...VIEW_MODES.map((v) => v[1]), "UI/Inventory/ViewModeWithCurrent", "UI/Inventory/ShortcutBrackets", "UI/Inventory/SlotRigs", "UI/Inventory/SlotHigh", "UI/Inventory/SlotMedium", "UI/Inventory/SlotLow", "UI/Inventory/QuantityAndName", "UI/Inventory/ItemStackEstimatedPrice", "UI/Inventory/ItemEstimatedPrice", "UI/Inventory/ItemStackVolume", "UI/Util/VolumeWithUnit", "UI/Inventory/NumItems2", "UI/Inventory/NumItemsAndSelected2", "UI/Inventory/NumFiltered", "UI/Inventory/EstIskPrice2", "UI/Inventory/StackAll", "UI/Inventory/LootAll", "UI/Common/SelectAll", "UI/Inventory/NothingFoundFiltered", "UI/Common/NothingFound", "UI/Fitting/FittingWindow/SimulateShipFitting", "UI/Inventory/InvertSelection", "UI/Common/SortBy", "UI/Inventory/ViewMode",
    "UI/Inventory/Filters/MyFilters", "UI/Inventory/CreateFilter", "UI/Commands/Remove", "UI/Inventory/Filters/Edit", ...DEFAULT_INVENTORY_FILTERS.map(([key]) => key), "UI/Common/NothingFound", "UI/Inventory/OpenInNewWindow", "UI/Common/Buttons/Close", "/Carbon/UI/Common/Hide", "/Carbon/UI/Common/Show", ...SHIP_HOLDS.map((h) => h.label), CARGO_HOLD.label];
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
  /** TreeDataInv.GetHint: UI/Inventory/ShortcutBrackets of the node's command's shortcut, nothing where it has none. */
  const shortcutHint = (cmd: string): string => { const k = shortcutOf(cmd); return k ? word("UI/Inventory/ShortcutBrackets", `[${k}]`, { shortcut: k }) : ""; };
  /** FmtISKAndRound(v, showFractionsAlways): rounded as RoundISK, with two places always or only where it has a fraction. */
  const iskRound = (v: number, always: boolean): string => {
    const r = Math.round(roundIsk(v) * 100) / 100; // (12,677,700 rounds to 12700000.000000002)
    return `${always ? r.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Math.round(r).toLocaleString("en-US")} ISK`;
  };
  /** eveformat.volume: two places where a tenth has a fraction, one where the whole has, else none; no grouping. */
  const volText = (v: number): string => {
    const places = Math.abs((10 * v) % 1) > 1e-9 ? 2 : Math.abs(v % 1) > 1e-9 ? 1 : 0;
    const n = v.toLocaleString("en-US", { useGrouping: false, minimumFractionDigits: places, maximumFractionDigits: places });
    return word("UI/Util/VolumeWithUnit", `${n} m³`, { volume: n });
  };
  /**
   * InvItem.LoadTooltipPanel -> InventoryItemTooltip (tooltip/item.py): the name, "<quantity> x <name>" for a stack
   * (UI/Inventory/QuantityAndName); the estimated price (ItemStackEstimatedPrice "Est. <sum> (<unit> per unit)" -
   * the unit with places under 100 ISK - or ItemEstimatedPrice); the volume (volume_from_item include_per_unit:
   * ItemStackVolume "<sum> (<unit> per unit)"). Read through gridcheck: "1,234 x Tritanium", "Est. 2,470 ISK (2.00 ISK
   * per unit)", "12.34 m³ (0.01 m³ per unit)".
   */
  function itemTip(i: { typeID: number; quantity: number }, e: MouseEvent): void {
    const anchor = e.currentTarget as HTMLElement;
    const name = typeName(i.typeID);
    const q = i.quantity;
    const head = q > 1 ? word("UI/Inventory/QuantityAndName", `${q.toLocaleString("en-US")} x ${name}`, { quantity: q, name }) : name;
    const lines: string[] = [];
    const price = prices?.get(i.typeID) ?? null;
    if (price !== null && price !== undefined) {
      const sum = iskRound(price * q, false);
      lines.push(q > 1
        ? word("UI/Inventory/ItemStackEstimatedPrice", `Est. ${sum} (${iskRound(price, price < 100)} per unit)`, { estPrice: sum, estPricePerUnit: iskRound(price, price < 100) })
        : word("UI/Inventory/ItemEstimatedPrice", `Est. ${sum}`, { estPrice: sum }));
    }
    const unit = volumes[String(i.typeID)];
    if (unit === undefined) void flow.typeVolumes([i.typeID]).then((v) => { volumes = { ...volumes, ...v }; }).catch(() => {});
    else lines.push(q > 1 ? word("UI/Inventory/ItemStackVolume", `${volText(unit * q)} (${volText(unit)} per unit)`, { itemVolume: volText(unit * q), typeVolume: volText(unit) }) : volText(unit));
    tooltipDue(anchor, () => showItemTooltip(anchor, head, lines));
  }
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
  let current = $state(containerMode ? "container" : bayMode ?? "cargo");
  // invWindow.history (HistoryBuffer(HISTORY_LENGTH 50)): each container shown is appended - what lay ahead of the place
  // dropped, the same one twice not - and OnBack / OnForward (CmdBack / CmdForward, Mouse 4 / Mouse 5, to the active
  // window) show the one before / after, branchHistory off; one no longer in the tree is stepped over (GoForward again)
  let invRoot: HTMLElement | undefined = $state();
  const history: string[] = [];
  let historyAt = -1;
  let stepping = false;
  $effect(() => {
    const now = current;
    if (stepping) { stepping = false; return; }
    if (historyAt >= 0) history.splice(historyAt + 1);
    if (history[history.length - 1] !== now) history.push(now);
    if (history.length > 50) history.shift();
    historyAt = history.length - 1;
  });
  $effect(() => {
    const step = (by: number) => () => {
      if (!invRoot?.closest(".win.focused")) return;
      const to = historyAt + by;
      if (to < 0 || to >= history.length) return;
      historyAt = to;
      stepping = history[to] !== current;
      current = history[to]!;
    };
    const back = step(-1), forward = step(1);
    addEventListener("evejs:cmd-back", back);
    addEventListener("evejs:cmd-forward", forward);
    return () => { removeEventListener("evejs:cmd-back", back); removeEventListener("evejs:cmd-forward", forward); };
  });
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
  /**
   * TreeDataInv.GetMenu on the ship's own entries (read through gridcheck on the client's): the cargo hold's controller
   * (ShipCargo.GetMenu) gives the active ship's space menu in space (GetMenuFromItemIDTypeID); a bay's (BaseShipBay,
   * BaseInvContainer.GetMenu) the ship's item menu (InvItemMenu) - Show Info, the market and assets entries, Compare.
   * (TreeDataInv's Open in new window after it is not here: the page has one inventory window for the ship's holds.)
   */
  function cargoNodeMenu(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (!ship || !$space.snapshot?.ship) return;
    // TreeDataInv.GetMenu's Open in new window: for the ship's cargo, Inventory.OpenOrShow(('ShipCargo', shipID),
    // usePrimary=False) shows the Active ship window (read through gridcheck), this window: the cargo shown in it
    dispatchEvent(new CustomEvent("evejs:open-space-menu", { detail: { itemID: ship.itemID, x: e.clientX, y: e.clientY, tail: [],
      beforeLogoff: [{ label: word("UI/Inventory/OpenInNewWindow", "Open in new window (SHIFT+Click)"), run: () => { current = "cargo"; } }] } }));
  }
  function bayNodeMenu(e: MouseEvent, key: string, label: string): void {
    e.preventDefault();
    e.stopPropagation();
    if (!ship || ship.typeID === null) return;
    const typeID = ship.typeID, itemID = ship.itemID;
    menu.open(e.clientX, e.clientY, [
      // OfferSimulateShipFitting (the pilot's own ship): UI/Fitting/FittingWindow/SimulateShipFitting, GhostFitShip
      { label: word("UI/Fitting/FittingWindow/SimulateShipFitting", "Simulate Fit"), run: () => void flow.simulateShip().then(() => { dispatchEvent(new CustomEvent("evejs:open-fitting")); }).catch(() => {}) },
      null,
      { label: word(MENU.info, "Show Info"), info: true, run: () => showInfo({ kind: "type", typeID, itemID: itemID ?? undefined }) },
      null,
      { label: word(MENU.market, "View Market Details"), run: () => showMarketDetails(typeID) },
      { label: word(MENU.buy, "Buy This Type"), run: () => buyMarketType(typeID) },
      { label: word(MENU.contracts, "Find in Contracts"), run: () => findInContracts(typeID) },
      { label: word(MENU.assets, "Find Personal Assets"), run: () => findInPersonalAssets(typeName(typeID)) },
      { label: word(MENU.quickbar, "Add to Market Quickbar"), run: () => { changeQuickbar((q) => addType(q, typeID)); } },
      null,
      { label: word(MENU.compare, "Compare"), run: () => typeCompareTarget.ask([{ typeID, itemID }]) },
      // TreeDataInv.GetMenu: Open in new window (SHIFT+Click) after the controller's entries, in Compare's group (no
      // line between: read through gridcheck on the live client's Drone Bay / Fuel Bay / Mining Hold entries)
      { label: word("UI/Inventory/OpenInNewWindow", "Open in new window (SHIFT+Click)"), run: () => openBayInNewWindow(key, label) },
    ]);
  }
  /** TreeDataInv.OpenNewWindow on a ship bay: an inventory window of its own, captioned with the bay's name (PlayApp's). */
  // invWindow.OnTreeViewClick / OnTreeViewMouseEnter / OnTreeViewMouseExit: an entry of an object in space (the ship, a
  // container) selected in space on a click, its mouse-over state on while the mouse is over the entry
  function spaceSelect(itemID: number | null): void { if (itemID === null) return; dispatchEvent(new CustomEvent("evejs:select-space-item", { detail: { itemID } })); }
  function spaceHover(itemID: number | null, on: boolean): void { if (itemID === null) return; dispatchEvent(new CustomEvent("evejs:hover-space-item", { detail: { itemID, on } })); }

  function openBayInNewWindow(key: string, label: string): void {
    if (current === key) current = "cargo";
    dispatchEvent(new CustomEvent("evejs:open-bay-window", { detail: { key, title: label } }));
  }
  /** TreeDataInv.OpenNewWindow: the container in an inventory window of its own (the cargo shown here again). */
  function openTempInNewWindow(id: number): void {
    if (current === `temp:${id}`) current = "cargo";
    treeShownContainer.set(null);
    void flow.showInventoryContainer(id).catch(() => {});
  }
  // RemoveTreeEntry: the shown temporary location gone (its ball left the park), the tree back to the default
  $effect(() => {
    if (current.startsWith("temp:") && !$tempInvLocations.includes(Number(current.slice(5)))) untrack(() => { current = "cargo"; });
  });
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
    const list = (bay?.items ?? []).filter((i) => (!filter.trim() || typeName(i.typeID).toLowerCase().includes(filter.trim().toLowerCase())) && passesFilters(i));
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
  let facts = $state<Record<number, { volume: number | null; meta: number | null; tech: number | null; loaded?: boolean; col?: TypeColumnFacts }>>({});
  $effect(() => {
    if (viewMode === "icons") return;
    const missing = [...new Set((bay?.items ?? []).map((i) => i.typeID))].filter((t) => !facts[t]);
    if (!missing.length) return;
    for (const t of missing) facts[t] = { volume: null, meta: null, tech: null };
    void Promise.all([flow.typeVolumes(missing).catch(() => ({} as Record<string, number>)), flow.typeFacts(missing).catch(() => null),
      flow.typeColumnFacts(missing).catch(() => ({} as Readonly<Record<number, TypeColumnFacts>>))]).then(([v, m, c]) => {
      const next = { ...facts };
      for (const t of missing) next[t] = { volume: v[String(t)] ?? null, meta: m?.get(t)?.metaLevel ?? null, tech: m?.get(t)?.techLevel ?? null, loaded: !!m?.has(t), col: c[t] };
      facts = next;
    });
  });
  const filtered = $derived((bay?.items?.length ?? 0) - shown.length);

  // typeHelpers.GetAveragePrice: the cfg's average prices
  let prices = $state<ReadonlyMap<number, number | null> | null>(null);
  onMount(() => { void flow.cfgAveragePrices().then((p) => (prices = p)).catch(() => {}); });
  // InvFilters (invFilters.py): the pilot's item filters (itemFilter.GetFilters: the character's setting, the client's
  // GetDefaultFilters where none is kept, by name), each a FilterEntry checkbox; the checked ones narrow the items one
  // after another (Container.FilterItems: FilterSvc.FilterItems for each active filter)
  let savedFilters = $state<readonly InventoryFilter[] | null>(null);
  onMount(() => { void flow.readCharacterSetting(INVENTORY_FILTERS_SETTING).then((t) => { savedFilters = t === null ? null : readInventoryFilters(t); }).catch(() => {}); });
  const itemFilters = $derived([...(savedFilters ?? DEFAULT_INVENTORY_FILTERS.map(([key, own, match, conditions]) => [word(key, own), match, conditions] as InventoryFilter))]
    .sort((a, b) => a[0].toLowerCase().localeCompare(b[0].toLowerCase())));
  let checkedFilters = $state<readonly string[]>([]);
  // ExpandFilters / CollapseFilters, kept per window (invFiltersExpanded_<windowID>), collapsed where nothing is kept
  // svelte-ignore state_referenced_locally
  const FILTERS_OPEN_KEY = `evejs.ui.invFiltersExpanded.${bayMode ?? (containerMode ? "container" : "ActiveShipCargo")}`;
  let filtersOpen = $state((() => { try { return localStorage.getItem(FILTERS_OPEN_KEY) === "1"; } catch { return false; } })());
  // DragResizeCont (invFilters: TOBOTTOM, dragArea 8 above it): expanded, the area's height kept per window
  // (invFiltersHeight_<windowID>, 150 where none is kept), between minSize 100 and maxSize half the tree's height; the
  // drag area moves its top edge
  // svelte-ignore state_referenced_locally
  const FILTERS_HEIGHT_KEY = FILTERS_OPEN_KEY.replace("invFiltersExpanded", "invFiltersHeight");
  let filtersHeight = $state((() => { try { const v = Number(localStorage.getItem(FILTERS_HEIGHT_KEY)); return v > 0 ? v : 150; } catch { return 150; } })());
  let treeEl: HTMLElement | undefined = $state();
  const clampFilters = (h: number) => Math.max(100, Math.min(Math.max(100, (treeEl?.clientHeight ?? 400) * 0.5), h));
  function startFiltersDrag(e: PointerEvent): void {
    if (!filtersOpen) return;
    e.preventDefault();
    e.stopPropagation();
    const y0 = e.clientY, h0 = clampFilters(filtersHeight);
    const move = (ev: PointerEvent) => { filtersHeight = clampFilters(h0 + (y0 - ev.clientY)); };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      try { localStorage.setItem(FILTERS_HEIGHT_KEY, String(Math.round(filtersHeight))); } catch { /* this visit */ }
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }
  function toggleFiltersOpen(): void { filtersOpen = !filtersOpen; try { localStorage.setItem(FILTERS_OPEN_KEY, filtersOpen ? "1" : "0"); } catch { /* this visit */ } }
  function setFilterChecked(name: string, on: boolean): void { checkedFilters = on ? [...checkedFilters.filter((n) => n !== name), name] : checkedFilters.filter((n) => n !== name); }
  // FilterSvc.SetTempFilter: the open FilterCreationWindow's filter, applied to the items too (ApplyTempFilter) until it closes;
  // OnInvFiltersChanged: the filters read again after a save
  let tempFilter = $state<InventoryFilter | null>(null);
  const activeFilters = $derived([...itemFilters.filter((f) => checkedFilters.includes(f[0])), ...(tempFilter ? [tempFilter] : [])]);
  // FilterEntry.GetMenu: Edit (the filter in FilterCreationWindow, not here yet) and Remove (FilterSvc.RemoveFilter: the
  // RemoveFilterPrompt question, then every filter but it kept - PersistFilters)
  function filterMenu(e: MouseEvent, name: string): void {
    e.preventDefault();
    e.stopPropagation();
    const f = itemFilters.find((x) => x[0] === name) ?? null;
    menu.open(e.clientX, e.clientY, [
      { label: word("UI/Inventory/Filters/Edit", "Edit"), run: () => { dispatchEvent(new CustomEvent("evejs:open-filter-window", { detail: { filter: f } })); } },
      { label: word("UI/Commands/Remove", "Remove"), run: () => void removeFilter(name) },
    ]);
  }
  $effect(() => {
    const temp = (e: Event) => { tempFilter = (e as CustomEvent<{ filter: InventoryFilter | null }>).detail?.filter ?? null; };
    const changed = () => { void flow.readCharacterSetting(INVENTORY_FILTERS_SETTING).then((t) => { savedFilters = t === null ? null : readInventoryFilters(t); }).catch(() => {}); };
    addEventListener("evejs:inventory-temp-filter", temp);
    addEventListener("evejs:inventory-filters-changed", changed);
    return () => { removeEventListener("evejs:inventory-temp-filter", temp); removeEventListener("evejs:inventory-filters-changed", changed); };
  });
  async function removeFilter(name: string): Promise<void> {
    if (!(await flow.askClientDialogWith("RemoveFilterPrompt", {}, "Are you sure you want to remove this filter?"))) return;
    const next = itemFilters.filter((f) => f[0].toLowerCase() !== name.toLowerCase());
    await flow.saveCharacterSetting(INVENTORY_FILTERS_SETTING, writeInventoryFilters(next));
    savedFilters = next;
    checkedFilters = checkedFilters.filter((n) => n !== name);
  }
  // what the active filters ask of the items' types: the group and category (the type's record) and FilterSvc.GetValue's
  // dogma and meta facts (TYPE_FILTER_FIELDS); the price is the average price the window shows
  let filterMeta = $state<ReadonlyMap<number, { groupID: number | null; categoryID: number | null }>>(new Map());
  let filterTypeFacts = $state<ReadonlyMap<number, InventoryFilterFacts>>(new Map());
  $effect(() => {
    if (!activeFilters.length) return;
    const ids = [...new Set((bay?.items ?? []).map((i) => i.typeID))].filter((t) => !untrack(() => filterMeta).has(t));
    if (!ids.length) return;
    void getTypeMeta(ids, flow.requestOptions()).then((m) => {
      const next = new Map(filterMeta);
      for (const t of ids) { const x = m.types.get(t); next.set(t, { groupID: x?.groupID ?? null, categoryID: x?.categoryID ?? null }); }
      filterMeta = next;
    }).catch(() => {});
  });
  const typeFilterFields = $derived([...new Set(activeFilters.flatMap(([, , c]) => c.map(([f]) => f)))].filter((f) => TYPE_FILTER_FIELDS.has(f)).sort((a, b) => a - b).join(","));
  $effect(() => {
    const fields = typeFilterFields;
    const ids = [...new Set((bay?.items ?? []).map((i) => i.typeID))];
    if (!fields || !ids.length) return;
    let live = true;
    void loadInventoryFilterFacts(ids, new Set(fields.split(",").map(Number)), flow.requestOptions()).then((f) => { if (live) filterTypeFacts = f; }).catch(() => {});
    return () => { live = false; };
  });
  function passesFilters(i: { itemID: number; typeID: number; quantity: number; singleton: boolean; categoryID: number | null }): boolean {
    if (!activeFilters.length) return true;
    const meta = filterMeta.get(i.typeID);
    const row = { itemID: i.itemID, typeID: i.typeID, quantity: i.quantity, singleton: i.singleton,
      categoryID: i.categoryID ?? meta?.categoryID ?? null, groupID: meta?.groupID ?? null } as unknown as Parameters<typeof matchInventoryFilter>[0];
    const price = prices?.get(i.typeID);
    const facts: InventoryFilterFacts = { ...filterTypeFacts.get(i.typeID), [FILTER_FIELD.price]: price == null ? null : roundInventoryFilterPrice(price) };
    const name = typeName(i.typeID);
    return activeFilters.every((f) => matchInventoryFilter(row, name, f, facts) !== false);
  }
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
  // UI/Inventory/ContainerQuantityAndCapacity formats by the value's Python type (read through gridcheck): an int with no
  // decimals, a float with one - an empty container's used volume is the int 0 (no items summed), so it reads 0/625.0 m3
  const fill = $derived(bay && bay.capacity ? Math.min(1, (bay.used ?? 0) / bay.capacity) : 0);
  const shipLabel = $derived(ship ? `${ship.name ?? typeName(ship.typeID)} (${typeName(ship.typeID)})` : "");

  /** The items selected (the scroll's selection: a click alone, Ctrl toggling, Shift the run from the last clicked). */
  let selected = $state<number[]>([]);
  let lastClicked: number | null = null;
  $effect(() => { void current; selected = []; lastClicked = null; });
  // invCont.SelectAll (commandSvc.OnCtrlA to the focused container: scroll.SelectAll - every item shown) and Home / End
  // (Scroll.OnHome / OnEnd) on the items once one is clicked
  function clickItem(id: number, e: MouseEvent): void {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).closest<HTMLElement>(".items")?.focus({ preventScroll: true });
    const order = shown.map((i) => i.itemID);
    if (e.ctrlKey && !e.shiftKey) selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    else if (e.shiftKey && lastClicked !== null && order.includes(lastClicked)) {
      const [a, b] = [order.indexOf(lastClicked), order.indexOf(id)].sort((x, y) => x - y);
      selected = e.ctrlKey ? [...new Set([...selected, ...order.slice(a!, b! + 1)])] : order.slice(a!, b! + 1);
    } else selected = [id];
    if (!e.shiftKey) lastClicked = id;
  }
  /**
   * Scroll.OnUp / OnDown (BrowseNodes, ActivateIdx) in the details and list views, whose scroll nodes are the items:
   * nothing selected - the last / first; else past the selection (its last going down, its first going up; with Shift
   * the end away from the last clicked, the range from there), past either end nothing; brought into view. Not in the
   * icon view, where the scroll's nodes are rows of icons (container.py RefreshView, Row with internalNodes).
   */
  function browseItems(up: boolean, shift: boolean, list: HTMLElement): void {
    if (viewMode === "icons") return;
    const order = shown.map((i) => i.itemID);
    if (!order.length) return;
    const sel = order.map((id, i) => (selected.includes(id) ? i : -1)).filter((i) => i >= 0);
    const lastAt = lastClicked === null ? -1 : order.indexOf(lastClicked);
    let idx: number;
    if (!sel.length) idx = up ? order.length - 1 : 0;
    else if (shift && lastAt >= 0) idx = (sel[0]! < lastAt ? sel[0]! : sel[sel.length - 1]!) + (up ? -1 : 1);
    else idx = (sel.length > 1 ? sel[up ? 0 : sel.length - 1]! : sel[0]!) + (up ? -1 : 1);
    if (idx < 0 || idx >= order.length) return;
    if (shift && sel.length && lastAt >= 0) selected = order.slice(Math.min(lastAt, idx), Math.max(lastAt, idx) + 1);
    else { selected = [order[idx]!]; lastClicked = order[idx]!; }
    const id = order[idx]!;
    void id; requestAnimationFrame(() => list.querySelectorAll<HTMLElement>("[draggable='true']")[idx]?.scrollIntoView({ block: "nearest" }));
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
    hideLabelShortcutTooltip();
    const picked = selected.includes(id) ? [...selected] : [id];
    dragging = { from: current, ids: picked, stacks: shown.filter((i) => picked.includes(i.itemID)).map((i) => ({ typeID: i.typeID, quantity: i.quantity })) };
    const types = [...new Set(dragging.stacks.map((x) => x.typeID))].filter((t) => volumes[String(t)] === undefined);
    if (types.length) void flow.typeVolumes(types).then((v) => { volumes = { ...volumes, ...v }; }).catch(() => {});
    e.dataTransfer?.setData("text/plain", dragging.ids.join(","));
    // the items for a drop on space (navigation.OnDropData deploys the deployable ones)
    const ids = dragging.ids;
    e.dataTransfer?.setData(INV_ITEMS_DRAG_TYPE, JSON.stringify(shown.filter((i) => ids.includes(i.itemID)).map((i) => ({ itemID: i.itemID, typeID: i.typeID }))));
    e.dataTransfer?.setData(INV_FROM_DRAG_TYPE, JSON.stringify(placeOf(current)));
  }
  const dragOver = (key: string) => (e: DragEvent) => { if (dragging && dragging.from !== key) { e.preventDefault(); dropKey = key; } };
  /**
   * The shown container takes a drop as the client's invCont does (OnDropData), and while items from elsewhere are over
   * it, invWindow.OnInvContDragEnter puts their volume on the gauge (InvContCapacityGauge.SetAdditionalVolume: a fill
   * after the used share in THEME_FOCUS 0.6, WARNING_ORANGE where they would not fit, and the label's quantity with
   * them); OnInvContDragExit takes it off.
   */
  let addStacks = $state<{ typeID: number; quantity: number }[] | null>(null);
  const areaKey = $derived(containerMode ? "container" : current);
  function areaDragOver(e: DragEvent): void {
    if (!dragging || dragging.from === areaKey) return;
    e.preventDefault();
    if (addStacks !== dragging.stacks) {
      addStacks = dragging.stacks;
      const types = [...new Set(addStacks.map((x) => x.typeID))].filter((t) => volumes[String(t)] === undefined);
      if (types.length) void flow.typeVolumes(types).then((v) => { volumes = { ...volumes, ...v }; }).catch(() => {});
    }
  }
  function areaDragLeave(e: DragEvent): void {
    if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) addStacks = null;
  }
  const additionalVolume = $derived((addStacks ?? []).reduce((n, x) => n + (volumes[String(x.typeID)] ?? 0) * x.quantity, 0));
  /**
   * InvContCapacityGauge's fills move by uicore.animations.MorphScalar on their width, over 0.5 x |change| ^ 0.3 seconds
   * (RefreshCapacity, SetAdditionalVolume, SetSecondaryVolume); the dragged fill (TOLEFT_PROP after the gauge in the same
   * parent) starts where the gauge ends, moving with it.
   */
  function morphFill(node: HTMLElement, at: { width: number; left?: number }) {
    let width = at.width, left = at.left ?? 0;
    node.style.width = `${width * 100}%`;
    if (at.left !== undefined) node.style.left = `${left * 100}%`;
    return {
      update(next: { width: number; left?: number }) {
        const dw = 0.5 * Math.abs(next.width - width) ** 0.3, dl = 0.5 * Math.abs((next.left ?? 0) - left) ** 0.3;
        // (ANIM_SMOOTH: a Hermite curve with zero tangents, smoothstep - cubic-bezier(1/3, 0, 2/3, 1) exactly)
        node.style.transition = `width ${dw}s cubic-bezier(0.3333, 0, 0.6667, 1), left ${dl}s cubic-bezier(0.3333, 0, 0.6667, 1)`;
        node.style.width = `${next.width * 100}%`;
        if (next.left !== undefined) node.style.left = `${next.left * 100}%`;
        width = next.width;
        left = next.left ?? 0;
      },
    };
  }
  const addFill = $derived(bay && bay.capacity ? Math.min(additionalVolume / bay.capacity, 1 - fill) : 0);
  const addOver = $derived(!!(bay && bay.capacity && additionalVolume + (bay.used ?? 0) > bay.capacity));
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
    // OfferLoadCharges: in a ship in space, a charge (category 8) in the cargo hold (or an ammo hold, not on the page);
    // a single item (menusvc's per-item entry) - LoadChargeToAllModules
    if (!multi && fromBay === "cargo" && first.categoryID === 8 && $space.snapshot?.ship) {
      entries.push({ label: word(MENU.loadCharges, "Load Charges"), run: () => void act(() => flow.loadChargeToAllModules(first.itemID)) }, 14);
    }
    // OfferMoveToDroneBay: a drone not in the drone bay, the pilot in a ship in space, and a ship maintenance array or a
    // ship with hasShipMaintenanceBay within maxConfigureDistance (5,000 m of its surface), the pilot's own among the
    // ballpark's slim items (an Orca's pilot moves their own drones) - CHANGESGROUP; FitDrone
    if (fromBay !== "drone" && items.every((i) => i.categoryID === 18) && maintenanceNearby()) {
      entries.push({ label: word(MENU.moveToDroneBay, "Move to Drone Bay"), run: () => void act(() => flow.transferItems(ids, placeOf(fromBay), placeOf("drone"), null)) }, 11);
    }
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
    // InvItem.GetMenu: the items' menu, a line, then the container's (GetContainerMenu)
    menu.open(e.clientX, e.clientY, [...sorted, null, ...containerMenu()]);
  }
  /**
   * container.GetContainerMenu: Select All, Invert Selection; in the icon view (ShouldShowSortBy: not a scroll view mode) a
   * line and Sort By with the sort options; not view-only and offered (should_offer_stack_all), a line and Stack All.
   */
  function containerMenu(): (ContextEntry | null)[] {
    const ids = shown.map((i) => i.itemID);
    const out: (ContextEntry | null)[] = [
      { label: word("UI/Common/SelectAll", "Select All"), run: () => { selected = ids; } },
      { label: word("UI/Inventory/InvertSelection", "Invert Selection"), run: () => { selected = ids.filter((id) => !selected.includes(id)); } },
    ];
    if (viewMode === "icons") {
      const sub: (ContextEntry | null)[] = [];
      SORT_OPTIONS.forEach(([asc, desc, criteria, ownAsc, ownDesc], i) => {
        if (i > 0) sub.push(null);
        for (const [dir, label, own] of [[0, asc, ownAsc], [1, desc, ownDesc]] as const) {
          sub.push({ label: word(label, own), icon: sortBy === criteria && sortDir === dir ? "res:/UI/Texture/eveicon/system_icons/checkmark_16px.png" : null, run: () => { sortBy = criteria; sortDir = dir; } });
        }
      });
      out.push(null, { label: word("UI/Common/SortBy", "Sort By"), icon: "res:/UI/Texture/eveicon/system_icons/bars_sort_ascending_16px.png", sub });
    }
    if (bay && !(current === "container" || current.startsWith("temp:"))) out.push(null, { label: word("UI/Inventory/StackAll", "Stack All"), icon: "res:/UI/Texture/eveicon/system_icons/stack_16px.png", run: stackAll });
    return out;
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
  function resetWidth(k: number, e: MouseEvent): void { const th = (e.currentTarget as HTMLElement).closest("th"); if (th) keepWidths({ ...colWidths, [k]: fittedColumnWidth(th) }); }
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
  /** InvContCapacityGauge.capacityText: the used volume (with what is being dragged in) over the capacity. */
  const capacityText = $derived(bay ? `${secondaryVolume ? `(${fmt1(secondaryVolume)}) ` : ""}${(bay.used ?? 0) === 0 && additionalVolume === 0 ? "0" : fmt1((bay.used ?? 0) + additionalVolume)}/${bay.capacity === null ? "?" : fmt1(bay.capacity)} m³` : "");
</script>

<div class="inv" class:container={containerMode} class:compact={$compactSig} bind:this={invRoot}>
  {#if !containerMode && !bayMode && $sidebarSig}
  <div class="tree" bind:this={treeEl}>
    <div class="nodes">
      {#if ship}
        <!-- invWindow.OnTreeViewDblClick: an entry with a container opens in a window of its own with Always open in separate
             window on (always_open_secondary_inventory_setting), else its children are shown or hidden -->
        <!-- TreeDataShip.GetHint: the type name, with TreeDataInv's "[<shortcut>]" (ShortcutBrackets) of OpenCargoHoldOfActiveShip where it has one -->
        <div title={typeName(ship.typeID) + shortcutHint("OpenCargoHoldOfActiveShip")} onmouseenter={() => { void playUiEvent("ui_button_soft2_play"); spaceHover(ship.itemID, true); }} onmouseleave={() => spaceHover(ship.itemID, false)} class="node" class:sel={current === "cargo"} class:drop={dropKey === "cargo"} role="treeitem" aria-selected={current === "cargo"} tabindex="-1"
          onclick={(e) => { void playUiEvent("msg_ListEntryClick_play"); spaceSelect(ship.itemID); if (e.shiftKey) openBayInNewWindow("cargo", word("UI/Neocom/ActiveShipCargoBtn", "Active ship")); else current = "cargo"; }} onkeydown={() => {}} oncontextmenu={(e) => cargoNodeMenu(e)}
          ondblclick={() => { if (invAlwaysSeparate.get()) current = "cargo"; else toggleTree(); }}
          ondragover={dragOver("cargo")} ondragleave={() => (dropKey = null)} ondrop={(e) => void dropOn("cargo", e)}>
          <!-- (TreeViewEntry.OnToggleBtnClick: the toggle's own sounds, not a button's) -->
          <button type="button" class="exp" data-own-sound class:open={treeOpen} aria-label="Expand" onclick={(e) => { e.stopPropagation(); toggleTree(); }}></button>
          <span class="ticon"><TypeIcon typeID={ship.typeID} name={shipLabel} size="sm" /></span>
          <span class="tlabel">{shipLabel}</span>
        </div>
        {#if treeOpen}
          {#each bays.filter((b) => b.key !== "cargo" && !b.key.startsWith("temp:")) as b (b.key)}
            <div title={b.key === "drone" ? shortcutHint("OpenDroneBayOfActiveShip").trim() || undefined : undefined} onmouseenter={() => void playUiEvent("ui_button_soft2_play")} class="node sub" class:sel={current === b.key} class:drop={dropKey === b.key} role="treeitem" aria-selected={current === b.key} tabindex="-1"
              onclick={(e) => { void playUiEvent("msg_ListEntryClick_play"); if (e.shiftKey) openBayInNewWindow(b.key, b.label); else current = b.key; }}
              ondblclick={() => { if (invAlwaysSeparate.get()) openBayInNewWindow(b.key, b.label); }} onkeydown={() => {}} oncontextmenu={(e) => (b.key === "fleet" || b.key === "shipMaintenance" ? cargoNodeMenu(e) : bayNodeMenu(e, b.key, b.label))}
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
        <div onmouseenter={() => { void playUiEvent("ui_button_soft2_play"); spaceHover(t.id, true); }} onmouseleave={() => spaceHover(t.id, false)} class="node temp" class:far={!t.inRange} class:sel={current === `temp:${t.id}`} role="treeitem" aria-selected={current === `temp:${t.id}`} tabindex="-1"
          class:drop={dropKey === `temp:${t.id}`} onclick={(e) => { void playUiEvent("msg_ListEntryClick_play"); spaceSelect(t.id); if (e.shiftKey && t.inRange) openTempInNewWindow(t.id); else openTemp(t.id); }}
          ondblclick={() => { if (invAlwaysSeparate.get() && t.inRange) openTempInNewWindow(t.id); }} onkeydown={() => {}} oncontextmenu={(e) => tempMenu(t, e)}
          ondragover={$inventoryState.container?.itemID === t.id ? dragOver(`temp:${t.id}`) : undefined} ondragleave={() => (dropKey = null)}
          ondrop={$inventoryState.container?.itemID === t.id ? (e) => void dropOn(`temp:${t.id}`, e) : undefined}>
          <!-- (a plain Sprite in the client, its OnClick Remove: no button sounds) -->
          <button type="button" class="tremove" data-own-sound title={word("UI/Common/Buttons/Close", "Close")} aria-label={word("UI/Common/Buttons/Close", "Close")}
            style:background-image={`url(${clientTexture("res:/UI/Texture/icons/73_16_210.png")})`} onclick={(e) => { e.stopPropagation(); removeTemp(t.id); }}></button>
          <span class="ticon"><img src={t.icon} alt=""></span>
          <span class="tlabel">{t.name}{#if t.dist}{" "}<span class="tdist">{t.dist}</span>{/if}</span>
        </div>
      {/each}
    </div>
    <!-- InvFilters' header (a double-click expands or collapses it), FilterEntry rows under it while expanded -->
    <div class="fbox" class:open={filtersOpen} style:height={filtersOpen ? `${clampFilters(filtersHeight)}px` : undefined}>
    <div class="fdrag" class:live={filtersOpen} role="presentation" onpointerdown={startFiltersDrag}></div>
    <div class="filters" role="presentation" ondblclick={toggleFiltersOpen}><span class="caret" class:open={filtersOpen} role="button" tabindex="-1" onclick={toggleFiltersOpen} onkeydown={() => {}}></span><span class="flabel">{word("UI/Inventory/Filters/MyFilters", "My filters")}</span><span class="fon" class:lit={activeFilters.length > 0} role="button" tabindex="-1" onclick={() => (checkedFilters = [])} onkeydown={() => {}}></span><span class="plus" role="button" tabindex="-1" onkeydown={() => {}} onclick={() => dispatchEvent(new CustomEvent("evejs:open-filter-window", { detail: { filter: null } }))} title={word("UI/Inventory/CreateFilter", "Create Filter")} style:background-image={`url("${clientTexture("res:/ui/texture/eveicon/system_icons/add_16px.png")}")`}></span></div>
    {#if filtersOpen}
      <div class="flist">
        {#each itemFilters as f (f[0])}
          <label class="fentry" oncontextmenu={(e) => filterMenu(e, f[0])} onmouseenter={() => void playUiEvent("ui_button_soft2_play")} ondblclick={(e) => { e.preventDefault(); checkedFilters = [f[0]]; }}>
            <input type="checkbox" checked={checkedFilters.includes(f[0])} onchange={(e) => setFilterChecked(f[0], e.currentTarget.checked)} /><span>{f[0]}</span>
          </label>
        {/each}
      </div>
    {/if}
    </div>
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
      <!-- InvContCapacityGauge.GetHint: its capacity text -->
      <div class="gauge" title={capacityText || undefined}>
        <span class="gfill" use:morphFill={{ width: fill }}></span>
        <span class="gfill add" class:over={addOver} use:morphFill={{ width: addFill, left: fill }}></span>
        <span class="gfill sec" use:morphFill={{ width: secondaryFill }}></span>
        <span class="gtext">{capacityText}</span>
      </div>
      <input class="search" placeholder="Search" value={$filterSig} oninput={(e) => filterSig.set((e.target as HTMLInputElement).value)} />
    </div>
    {/if}
    <div class="items" role="list" tabindex="-1" onclick={(e) => { selected = []; (e.currentTarget as HTMLElement).focus({ preventScroll: true }); }} onkeydown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); e.stopPropagation(); selected = shown.map((i) => i.itemID); } else if (!e.ctrlKey && !e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { if (viewMode !== "icons") { e.preventDefault(); e.stopPropagation(); browseItems(e.key === "ArrowUp", e.shiftKey, e.currentTarget as HTMLElement); } } else if (!e.ctrlKey && !e.altKey && (e.key === "Home" || e.key === "End")) { e.preventDefault(); e.stopPropagation(); scrollListHomeEnd(e.currentTarget.firstElementChild as HTMLElement ?? e.currentTarget, e.key === "End"); } }} oncontextmenu={(e) => { e.preventDefault(); menu.open(e.clientX, e.clientY, containerMenu()); }}
      ondragover={areaDragOver} ondragleave={areaDragLeave}
      ondrop={(e) => { addStacks = null; if (dragging && dragging.from !== areaKey) void dropOn(areaKey, e); }}>
      {#if bay && bay.items === null}
        <p class="none">…</p>
      {:else if !shown.length}
        <!-- UpdateHint: with items filtered out UI/Inventory/NothingFoundFiltered, else UI/Common/NothingFound -->
        <p class="none">{filtered > 0 ? word("UI/Inventory/NothingFoundFiltered", `Nothing Found (${filtered} filtered)`, { numFilters: filtered }) : word("UI/Common/NothingFound", "Nothing Found")}</p>
      {:else if viewMode !== "icons"}
        <!-- the scroll of listentry.InvItem rows under GetInvItemDefaultHeaders: details with the 32 px icon and the
             label 46 in, list without the icon -->
        <table class="rows" class:details={viewMode === "details"}>
          <thead><tr>{#each HEADERS as h, k}<th class:sorted={column === k} class:hid={hiddenCols.includes(k)} style:width={colWidths[k] ? `${colWidths[k]}px` : null} style:min-width={colWidths[k] ? `${colWidths[k]}px` : null} style:max-width={colWidths[k] ? `${colWidths[k]}px` : null} onclick={() => sortByColumn(k)} oncontextmenu={(e) => headerMenu(k, e)}>{word(h, HEADER_OWN[k]!)}{#if column === k}<span class="dir" class:down={reversed}></span>{/if}<span class="scaler" role="separator" aria-orientation="vertical" onpointerdown={(e) => startScale(k, e)} onclick={(e) => e.stopPropagation()} ondblclick={(e) => { e.stopPropagation(); resetWidth(k, e); }}></span></th>{/each}</tr></thead>
          <tbody>
            {#each shown as i (i.itemID)}
              {@const fa = facts[i.typeID]}
              <tr class:selected={selected.includes(i.itemID)} draggable="true" onmouseenter={(e) => { hoverSound(e); itemTip(i, e); }} onmouseleave={hideLabelShortcutTooltip} onclick={(e) => clickItem(i.itemID, e)} ondragstart={(e) => dragStart(i.itemID, e)} oncontextmenu={(e) => itemMenu(i.itemID, e)}>
                <td class="nm" class:hid={hiddenCols.includes(0)}>{#if viewMode === "details"}<span class="ricon"><TypeIcon typeID={i.typeID} name={typeName(i.typeID)} size="md" /></span>{/if}{typeName(i.typeID)}</td>
                <!-- uix columns (read through gridcheck): QUANTITY GetItemQty - none for a singleton; META_LEVEL FmtAmt where the
                     type has one (0 blank); TECH_LEVEL FmtAmt, and where evetypes has none the client prints None -->
                <td class="num" class:hid={hiddenCols.includes(1)}>{i.singleton ? "" : i.quantity.toLocaleString("en-US")}</td>
                <td class:hid={hiddenCols.includes(2)}>{groupName(i.typeID)}</td>
                <td class:hid={hiddenCols.includes(3)}>{categoryName(i.typeID)}</td>
                <td class:hid={hiddenCols.includes(4)}>{sizeCell(fa?.col)}</td>
                <td class:hid={hiddenCols.includes(5)}>{slotCell(fa?.col)}</td>
                <td class="num" class:hid={hiddenCols.includes(6)}>{fa?.volume != null ? volCell(fa.volume * i.quantity) : ""}</td>
                <td class="num" class:hid={hiddenCols.includes(7)}>{fa?.meta ? fa.meta.toLocaleString("en-US") : ""}</td>
                <td class="num" class:hid={hiddenCols.includes(8)}>{fa?.loaded ? (fa.tech ? fa.tech.toLocaleString("en-US") : "None") : ""}</td>
                <td class="num" class:hid={hiddenCols.includes(9)}>{prices?.get(i.typeID) ? fmtIskCell((prices.get(i.typeID) ?? 0) * i.quantity) : ""}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        {#each shown as i (i.itemID)}
          <div class="item" class:selected={selected.includes(i.itemID)} onmouseenter={(e) => { hoverSound(e); itemTip(i, e); }} onmouseleave={hideLabelShortcutTooltip} role="listitem" draggable="true"
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
      <!-- UpdateIskPriceLabel: FmtISKAndRound(total, False) - three figures (2,468 -> 2,470 ISK, read through gridcheck) -->
      <span class="price">{word("UI/Inventory/EstIskPrice2", `${iskAndRound(isk)} Est. price`, { iskString: iskAndRound(isk) })}</span>
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
  /* every entry's icon at 0.75 (read through gridcheck on the client's ShipHangar, ShipDroneBay and the rest) */
  .ticon :global(img) { opacity: 0.75; }
  .node.temp.far .ticon img { opacity: 0.3; }
  .node.temp.far, .node.temp.far.sel { color: rgba(255, 255, 255, 0.3); }
  .exp { flex: none; width: 24px; height: 24px; min-height: 0; padding: 0; border: 0; background: transparent; position: relative; cursor: pointer; }
  .exp::before { content: ""; position: absolute; left: 12px; top: 8px; width: 7px; height: 7px; background: #8a8a8a;
    mask: url(/client-res/ui/texture/classes/neocom/arrowdown.png) center / 7px 7px no-repeat; -webkit-mask: url(/client-res/ui/texture/classes/neocom/arrowdown.png) center / 7px 7px no-repeat;
    transform: rotate(-90deg); transition: transform .15s; }
  .exp.open::before { transform: none; }
  /* UpdateToggleBtnSpriteColor: the arrow WHITE on the selected entry, LED_GREY (#8A8A8A) on the others */
  .node.sel .exp::before { background: #fff; }
  .ticon { width: 22px; height: 22px; flex: none; display: grid; overflow: hidden; margin-right: 4px; }
  .ticon :global(.type-icon) { width: 22px; height: 22px; }
  .ticon :global(.type-icon img) { width: 22px; height: 22px; }
  .ticon img { width: 22px; height: 22px; }
  .tlabel { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* InvFilters: a drag area 8 high (its line at 3) over the filterHeaderCont, 24 high, padRight 8: expandFiltersBtn 24 wide
     with the 7 px Neocom arrowDown, the Label 14, createFilterBtn 24 x 24 with eveicon.add 16 at the right */
  .fbox { flex: none; display: flex; flex-direction: column; min-height: 0; }
  /* the drag area: 8 high, its line at 3; it resizes only while the filters are expanded */
  .fdrag { flex: none; height: 8px; position: relative; }
  .fdrag::before { content: ""; position: absolute; left: 0; right: 0; top: 3px; height: 1px; background: rgba(255, 255, 255, 0.1); }
  .fdrag.live { cursor: ns-resize; }
  .fdrag.live:hover::before { background: rgba(255, 255, 255, 0.25); }
  .filters { position: relative; flex: none; display: flex; align-items: center; height: 24px; padding: 0 8px 0 0; color: rgba(255, 255, 255, 0.75); }
  .filters .flabel { flex: 1; font-size: 14px; }
  .filters .plus:hover { opacity: 1; }
  .filters .plus { flex: none; width: 24px; height: 24px; background: center / 16px 16px no-repeat; opacity: 0.75; cursor: pointer; }
  .filters .caret { flex: none; width: 24px; height: 24px; position: relative; cursor: pointer; }
  /* filtersEnabledBtn: 24 wide, the radio button's back at 0.4 and its colour SUCCESS_GREEN faded in while a filter is on;
     a click turns every filter off */
  .filters .fon { flex: none; width: 24px; height: 24px; position: relative; cursor: pointer; }
  .filters .fon::before { content: ""; position: absolute; left: 7px; top: 7px; width: 10px; height: 10px; border-radius: 50%; background: rgba(255, 255, 255, 0.16); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.2); transition: background .3s; }
  .filters .fon.lit::before { background: rgba(141, 193, 105, 0.9); }
  /* FilterEntry: 22 high, the checkbox at 5 with its label, ListEntryUnderlay under the mouse */
  .flist { flex: 1; min-height: 0; overflow-y: auto; }
  .fentry { display: flex; align-items: center; gap: 6px; height: 22px; padding-left: 5px; color: rgba(255, 255, 255, 0.75); font-size: 14px; white-space: nowrap; cursor: pointer; }
  .fentry:hover { background: color-mix(in srgb, var(--theme-focus-dark, #305665) 20%, transparent); }
  .fentry input { width: 14px; height: 14px; margin: 0; accent-color: rgb(88, 167, 191); flex: none; }
  .fentry span { overflow: hidden; text-overflow: ellipsis; }
  .filters .caret::before { content: ""; position: absolute; left: 9px; top: 9px; width: 7px; height: 7px; background: rgba(255, 255, 255, 0.5);
    mask: url(/client-res/ui/texture/classes/neocom/arrowdown.png) center / 7px 7px no-repeat; -webkit-mask: url(/client-res/ui/texture/classes/neocom/arrowdown.png) center / 7px 7px no-repeat; transform: rotate(180deg); }
  .filters .caret.open::before { transform: none; }
  .right { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .top { display: flex; align-items: center; gap: 0; height: 24px; margin-bottom: 16px; }
  /* ButtonIcon: its icon TextColor.NORMAL (0.75), HIGHLIGHT (0.9) hovered (read through gridcheck on Stack All, View mode, Sort By) */
  .tool { padding: 0; border: 0; background-color: transparent; cursor: pointer; width: 24px; height: 24px; flex: none; background: center / 16px 16px no-repeat; opacity: 0.75; }
  .tool:hover { opacity: 0.9; }
  /* the top row's dividerParent (gridcheck, 600 wide window): InvContCapacityGauge 170 wide at 262, the dragArea 8 (its
     DividerLine at 3), the quick filter the rest (142, to the content's right) */
  .gauge { position: relative; flex: none; width: 170px; min-width: 0; height: 24px; margin: 0 0 0 8px; background: rgba(0, 0, 0, 0.4); }
  .gauge::after { content: ""; position: absolute; right: -4px; top: 0; width: 1px; height: 24px; background: rgba(255, 255, 255, 0.1); }
  /* its fills (gridcheck): the bg black 0.4, the gauge THEME_FOCUSDARK at 0.6 (Photon 48, 86, 101), the label EveLabelSmall
     white 0.75 at 8, 1 below the middle */
  .gfill { position: absolute; left: 0; top: 0; bottom: 0; background: color-mix(in srgb, var(--theme-focus-dark, #305665) 60%, transparent); }
  /* capacityGaugeSec, over the gauge: the selected items' share in THEME_FOCUS 0.6 */
  .gfill.sec { background: color-mix(in srgb, var(--theme-focus, #58a7bf) 60%, transparent); }
  /* capacityGaugeAdd, after the gauge: what is dragged over it, THEME_FOCUS 0.6 or eveColor.WARNING_ORANGE (#F39058) */
  .gfill.add { background: color-mix(in srgb, var(--theme-focus, #58a7bf) 60%, transparent); }
  .gfill.add.over { background: rgb(243, 144, 88); }
  .gtext { position: absolute; left: 8px; top: 1px; line-height: 24px; font-size: 12px; color: rgba(255, 255, 255, 0.75); white-space: nowrap; }
  .search { width: auto; flex: 1; min-width: 0; margin-left: 8px; height: 24px; box-sizing: border-box; border: 0; background: rgba(0, 0, 0, 0.3); color: #fff; padding: 0 6px; font-size: 14px; }
  /* the ShipCargo scroll's entries and the footer's labels from 16 past the tree column (186) */
  /* the icon view: InvItem 64 wide, GetEntryColMargin 16 between columns, rows of GetEntryHeight (103) touching */
  .items { padding-left: 4px; flex: 1; overflow: auto; display: flex; flex-wrap: wrap; align-content: flex-start; gap: 0 16px; }
  /* Scroll.ShowHint: EveCaptionLarge (24) centred, padding 16 all round, TextColor.SECONDARY (0.5), faded in over 0.3 s */
  /* ScrollContainer.ShowNoContentHint: an EveCaptionLarge (24, line spacing -0.12: a 30 px line, TextColor.HIGHLIGHT) at opacity 0.3,
     padding 16, centred (measured on the live client, gridcheck: the label box at 202,102 364 x 30 in a 600 x 450 inventory window) */
  .none { width: 100%; box-sizing: border-box; margin: 0; padding: 12px 16px 16px; text-align: center; font-size: 24px; line-height: 30px; color: rgba(255, 255, 255, 0.3); letter-spacing: 0.5px; animation: none-in 0.3s; }
  @keyframes none-in { from { opacity: 0; } to { opacity: 1; } }
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
  /* InvItem: _get_icon_frame_padding 4 hovered or selected - the icon (still 64) clipped 4 px in, not scaled */
  .item .icon :global(.type-icon) { transition: clip-path .1s; }
  /* ItemSelectionFrame: FRAME_BORDER2_CORNER0 in UIHILIGHT, glow 0.5, only on a selected item (hovered: the underlay alone) */
  .item.selected .icon { box-shadow: inset 0 0 0 2px var(--theme-focus, #58a7bf), 0 0 6px color-mix(in srgb, var(--theme-focus, #58a7bf) 50%, transparent); }
  .item:hover .icon { background: color-mix(in srgb, var(--theme-focus-dark, #305665) 20%, transparent); }
  .item.selected .icon { background: color-mix(in srgb, var(--theme-focus-dark, #305665) 40%, transparent); }
  .item:hover .icon :global(.type-icon), .item.selected .icon :global(.type-icon) { clip-path: inset(4px); }
  /* TreeViewEntry.OnDragEnter: the hover underlay, as the mouse over it (hoverBG.hovered) */
  .node.drop:not(.sel)::before { opacity: 0.2; }
</style>
