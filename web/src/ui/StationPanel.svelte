<script lang="ts">
  // THE STATION PANEL — the right-hand dock panel while DOCKED.
  //
  // Everything a docked pilot reaches for, as table rows rather than tiles: the
  // bays of the ship they have open, the hulls in the ship hangar, the item
  // hangar, the corporation's divisions, any container they opened, and the
  // station's own services and guests. One location at a time, chosen from a
  // tab row (or a dropdown when the panel is narrow).
  //
  // ⚠ DOCKED ONLY, AND THAT IS LOAD-BEARING.
  //
  // The right-hand dock panel shows this while docked and the compact Overview
  // while in space. `InventoryShip.svelte` — the panel this one replaces in the
  // dock — is STILL mounted in space, as the Neocom's floating "Inventory &
  // Ship" window and as a mobile panel, so the two coexist on purpose. This
  // file is only ever mounted from a branch already guarded by `isDocked`
  // (DockPanel's docked arm, MobileWorkspace's docked home), which is what
  // keeps a change made here from reaching a pilot in space. See
  // `dockPanelStates.test.ts`, which fails if it ever does.
  //
  // The RULES it obeys — where a stack may go, what a bay is called, how full
  // it is in words, how much of a stack fits — are not in this file. They are
  // in `inventoryModel.ts`, shared with InventoryShip, because two panels that
  // disagreed about any of them would move the same stack two different ways.
  //
  // ⚠ ABSENT IS NOT EMPTY IS NOT UNKNOWN. A hull with no ore hold, a hull whose
  // ore hold could not be read, and an ore hold that is genuinely empty are
  // three different states and are drawn three different ways — plus a fourth,
  // a bay nobody could even check, which is named out loud rather than silently
  // treated as absent. This is the invariant the panel exists to keep.
  //
  // ⚠ AND VOLUME IS USUALLY UNKNOWN. Ship-bay contents carry no per-unit m³ at
  // all (the read does not send it), so the m³ columns are empty in the bays
  // view. That is normal. Unknown renders as "—" / "not known", never 0.
  import { onMount } from "svelte";
  import TypeIcon from "./TypeIcon.svelte";
  import {
    canMergeStacks,
    divisionLabel,
    isBoardableShip,
    isOpenableContainer,
  } from "../bridge/inventoryShip.ts";
  import {
    DRAG_MIME,
    carriesOurPayload,
    decodeDrag,
    dropOnPlaceVerdict,
    encodeDrag,
    type DragPayload,
  } from "./dragDrop.ts";
  import {
    amount,
    amountText,
    bayIsActionable,
    bayPlace,
    capacityText,
    fillPercent,
    hangarThings,
    matchesFilter,
    mergeOrder,
    moveDestinations,
    moveQuantityFor,
    nextSort,
    orderedPresentBays,
    parseMoveQuantity,
    placeKey,
    placeName,
    roomFreeText,
    roomUsedText,
    rowsIn,
    samePlace,
    shipRows,
    shortLabel,
    sortInventoryRows,
    stateText,
    sumVolume,
    totalVolume,
    uncheckedShipBays,
    volumeCell,
    volumeText,
    type MoveDestination,
    type SortKey,
    type SortOrder,
  } from "./inventoryModel.ts";
  import {
    repairQuoteTotal,
    repairTargets,
    type RepairQuotePart,
    type RepairQuoteRow,
  } from "../bridge/repairQuotes.ts";
  import { isSessionLost } from "../app/flow.ts";
  import { GROUP_CORVETTE } from "../bridge/shipWrites.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { resolvedName, nameKey, type NameKind, type NameRef } from "../store/names.ts";
  import { formatIsk } from "./isk.ts";
  import { structureHasCapability } from "../nav/dockableLocation.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type {
    CapacityInfo,
    InventoryItemRow,
    InventoryPlace,
    ShipBay,
    StationOfficeQuote,
  } from "../store/types.ts";

  let {
    store,
    flow,
    ping = 0,
    isDocked = true,
    onCollapse = null,
    expanded = false,
    onToggleExpand = null,
  }: {
    store: ClientStore;
    flow: AppFlow;
    /**
     * Bumped when the Neocom's "Inventory & Ship" is picked while docked — snap
     * to the ship's bays so the pick visibly responds even when the panel was
     * already on screen. 0 = never picked; never fires on mount.
     */
    ping?: number;
    /**
     * Whether the pilot is DOCKED.
     *
     * ⚠ THIS PANEL IS THE IN-SPACE "Inventory & Ship" WINDOW TOO NOW, and that
     * is what this flag is for. It replaced `InventoryShip.svelte`, which drew
     * the Ship Hangar, Item Hangar and Corporate Hangar tabs while flying —
     * three places a pilot in space cannot reach at all. They were not empty:
     * they showed whatever the last docked read had left in the store, which is
     * worse than empty, because a stale list of hulls in a station reads as
     * something you could act on.
     *
     * In space the panel offers the ship's own bays and any container opened on
     * the grid, and nothing else. `moveDestinations` is told the same thing, so
     * the "Move to…" menu cannot offer a hangar either.
     *
     * ⚠ THE DEFAULT IS `true`. Every mount that existed before this prop was a
     * docked one (the dock frame, the mobile home), so the default has to leave
     * them alone; only the in-space caller writes it down.
     */
    isDocked?: boolean;
    /**
     * Fold the panel to the dock's thin strip. The panel carries its own header
     * (it replaces the dock frame's), so the frame's collapse control lives
     * here. Null when there is nothing to collapse into — the mobile home.
     */
    onCollapse?: (() => void) | null;
    /** The panel currently has the whole work area. */
    expanded?: boolean;
    /**
     * Ask the shell to give the panel the whole work area, or hand it back.
     * ⚠ The panel only EMITS this; the shell owns whether it may happen, and
     * gates it on being docked. Null where there is nothing to expand into.
     */
    onToggleExpand?: (() => void) | null;
  } = $props();

  // Stable store identity for this component's life; the slices are
  // Svelte-store-contract signals.
  // svelte-ignore state_referenced_locally
  const inventory = store.inventory;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const fitting = store.fitting;
  // svelte-ignore state_referenced_locally
  const space = store.space;

  // ⚠ NOT `class:active`. The app's component layer styles a bare
  // `button.active` as a FILLED ACCENT control, and that selector outranks a
  // plain `.stn-tab` — the first build came out with a solid blue tab instead
  // of an underlined one. The panel's state classes avoid every bare name the
  // stylesheet already claims.

  // --- what is on screen ----------------------------------------------------

  type View = "ship" | "ships" | "hangar" | "corp" | "container" | "services";

  let view = $state<View>("ship");
  let query = $state("");
  let sort = $state<SortOrder>({ key: "name", dir: 1 });
  // ⚠ NUMBER, NOT TEXT. The Qty box is `<input type="number">` and Svelte binds
  // one back as a number (null while it is empty), so typing this as a string
  // was wrong about its own state and crashed the move that read it.
  let moveQty = $state<number | null>(null);
  let busy = $state(false);
  let error = $state("");
  /** Which bays the player has folded away, by bay key. */
  let collapsedBays = $state<Record<string, boolean>>({});

  // A selection only ever means something inside ONE place; ticking somewhere
  // else starts over. The ticked IDS live in the store; WHERE they were ticked
  // is this panel's own business.
  let selectionPlace = $state<InventoryPlace | null>(null);

  /**
   * The move or trash waiting to be confirmed, and nothing else. Every move is
   * confirmed — a stack sent to the wrong hold is a trip back, and a trashed
   * stack is gone for good.
   */
  type Pending =
    | { readonly kind: "move"; readonly place: InventoryPlace; readonly label: string }
    | { readonly kind: "trash" };
  let pending = $state<Pending | null>(null);

  /** The row whose "▾" menu is open, and where to draw it. */
  let menu = $state<{
    row: InventoryItemRow;
    place: InventoryPlace;
    targets: readonly MoveDestination[];
    x: number;
    y: number;
  } | null>(null);
  let panelEl = $state<HTMLElement | null>(null);

  /** Escape closes whichever popover is open, before anything else reads it. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    if (menu === null && !targetMenuOpen) return;
    menu = null;
    targetMenuOpen = false;
    event.stopPropagation();
  }
  /** The narrow tier's "Move to… ▾": one control instead of a row of them. */
  let targetMenuOpen = $state(false);

  const selection = $derived($inventory.selection);
  // corvetteButton.py: the lobby's button is out of use aboard a corvette, which it tells by the hull's group.
  const aboardCorvette = $derived($flight.status?.shipGroupID === GROUP_CORVETTE);
  /**
   * station.CreateNewbieShip (608 to 611): the pilot is asked before a hull that is no capsule is left for a
   * corvette. The words are the page's own.
   */
  const sureOfTheCorvette = (): boolean => window.confirm("Board a new corvette? You will leave the ship you are in.");
  const openShip = $derived($inventory.openShip);
  const container = $derived($inventory.container);

  $effect(() => {
    if (ping > 0) {
      view = "ship";
    }
  });

  // The container closed under us (or was never open): fall back rather than
  // sit on a location that no longer exists.
  $effect(() => {
    if (view === "container" && !$inventory.container) {
      view = "hangar";
    }
  });

  // --- names ----------------------------------------------------------------

  function nameOf(row: InventoryItemRow): string {
    return resolvedName($names.resolved, "type", row.typeID);
  }

  function nameOnly(id: number | null, kind: NameKind): string {
    return resolvedName($names.resolved, kind, id, "—");
  }

  /** The corporations with an office here, by name, as the retail lobby lists them. */
  const officeRows = $derived(
    ($station.offices?.corporationIDs ?? [])
      .map((corporationID) => ({ corporationID, name: nameOnly(corporationID, "corporation") }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.corporationID - right.corporationID),
  );

  function typeName(typeID: number | null): string {
    if (typeID === null || typeID <= 0) {
      return "your ship";
    }
    return $names.resolved[nameKey("type", typeID)] ?? "your ship";
  }

  // R7c — every typeID on screen resolves to a NAME, batched and cached by the
  // flow. Fire-and-forget so rows render at once and gain their names.
  $effect(() => {
    const refs: NameRef[] = [];
    const ship = $inventory.openShip;
    const everyRow = [
      ...$inventory.hangar.rows,
      ...$inventory.cargo.rows,
      ...($inventory.container ? $inventory.container.rows : []),
      ...$inventory.corp.divisions.flatMap((division) => division.rows),
      ...(ship ? ship.bays.flatMap((bay) => bay.items ?? []) : []),
    ];
    for (const row of everyRow) {
      refs.push({ kind: "type", id: row.typeID });
      if (row.categoryID) {
        refs.push({ kind: "category", id: row.categoryID });
      }
    }
    if ($inventory.container) {
      refs.push({ kind: "type", id: $inventory.container.typeID });
    }
    if (ship && ship.typeID > 0) {
      refs.push({ kind: "type", id: ship.typeID });
    }
    const bits = $station.bits;
    if (bits) {
      if (bits.ownerID) refs.push({ kind: "owner", id: bits.ownerID });
      if (bits.stationTypeID) refs.push({ kind: "type", id: bits.stationTypeID });
    }
    for (const guest of $station.guests) {
      refs.push({ kind: "character", id: guest.characterID });
      if (guest.corporationID) refs.push({ kind: "corporation", id: guest.corporationID });
      if (guest.allianceID) refs.push({ kind: "alliance", id: guest.allianceID });
    }
    for (const corporationID of $station.offices?.corporationIDs ?? []) {
      refs.push({ kind: "corporation", id: corporationID });
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  // --- doing things ---------------------------------------------------------

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      error = isSessionLost(cause)
        ? "The live session ended (idle timeout or another client took over)."
        : panelErrorWords(cause);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void run(async () => {
      await flow.loadInventory();
      await flow.loadCorpHangar();
      // Open the ACTIVE hull's bays up front, so the panel lands on what the
      // player is flying instead of asking them to pick a ship first.
      const activeID = store.inventory.get().activeShipID;
      if (activeID !== null) {
        await flow.openShipBays(activeID).catch(() => {});
      }
    });
  });

  /** Re-read everything this panel shows, including the station's own row. */
  function refreshAll(): void {
    void run(async () => {
      await flow.loadInventory();
      await flow.loadCorpHangar();
      const open = store.inventory.get().openShip;
      if (open) {
        await flow.openShipBays(open.itemID);
      }
      await flow.refreshStationPanel();
    });
  }

  // --- selection ------------------------------------------------------------

  function clearPending(): void {
    pending = null;
    menu = null;
    targetMenuOpen = false;
  }

  function toggle(row: InventoryItemRow, place: InventoryPlace): void {
    clearPending();
    if (!samePlace(selectionPlace, place)) {
      // Ticking in a new place starts over — a tick made in the hangar must
      // never be applied to a corporation division.
      flow.clearSelection();
      selectionPlace = place;
    }
    flow.toggleSelection(row.itemID);
  }

  function isPicked(row: InventoryItemRow, place: InventoryPlace): boolean {
    return samePlace(selectionPlace, place) && selection.includes(row.itemID);
  }

  /** Tick every row shown in this group, or untick the lot. */
  function toggleGroup(group: Group, allPicked: boolean): void {
    clearPending();
    flow.clearSelection();
    if (allPicked) {
      selectionPlace = null;
      return;
    }
    selectionPlace = group.place;
    for (const row of group.shown) {
      flow.toggleSelection(row.itemID);
    }
  }

  function clearSelection(): void {
    clearPending();
    flow.clearSelection();
    selectionPlace = null;
  }

  /** The ticked rows, resolved back to rows in the place they were ticked in. */
  const selectedRows = $derived.by<readonly InventoryItemRow[]>(() => {
    const place = selectionPlace;
    if (!place) {
      return [];
    }
    return rowsIn($inventory, place).filter((row) => selection.includes(row.itemID));
  });

  /**
   * ⚠ COUNTED FROM THE ROWS, NOT FROM THE TICKED IDS. The two disagree the
   * moment a mutation succeeds: the ids the server has just moved are still in
   * the store's selection, but they are no longer rows in the place they were
   * ticked in. Counting ids put "1 selected · 0 m³" in the bar after a completed
   * move — a selection the bar could not act on and a volume of nothing.
   */
  const selectedCount = $derived(selectedRows.length);
  const selectedVolume = $derived(sumVolume(selectedRows));
  const mergeable = $derived(
    selectedRows.length === 2 && canMergeStacks(selectedRows[0]!, selectedRows[1]!),
  );
  /** The quantity box is only meaningful for ONE loose stack of more than one. */
  const showQty = $derived(
    selectedRows.length === 1 && !selectedRows[0]!.singleton && selectedRows[0]!.quantity > 1,
  );

  // --- where things can go --------------------------------------------------

  function containerName(): string {
    const open = $inventory.container;
    if (!open) {
      return "Container";
    }
    return resolvedName($names.resolved, "type", open.typeID) || "Container";
  }

  /**
   * Where the contents of ONE place can be sent.
   *
   * ⚠ Per PLACE, not per location. The bays view is several places at once, and
   * a row in the ore hold must not be offered a move to the ore hold — so each
   * group asks for its own list, and the quick-move button on a row reads
   * correctly before anything is ticked.
   */
  function targetsFrom(place: InventoryPlace | null): readonly MoveDestination[] {
    return moveDestinations($inventory, place, containerName(), isDocked);
  }

  /** The place the current location IS, for the action bar before a tick. */
  function viewPlace(): InventoryPlace | null {
    if (view === "hangar") return { kind: "hangar" };
    if (view === "corp") return { kind: "corp", division: $inventory.corp.selectedDivision };
    if (view === "container" && container) return { kind: "container", itemID: container.itemID };
    return null;
  }

  /** What the action bar offers: the place the selection was made in wins. */
  const targets = $derived(targetsFrom(selectionPlace ?? viewPlace()));

  function destinationCapacity(place: InventoryPlace): CapacityInfo | null {
    if (place.kind === "cargo") {
      return $inventory.cargo.capacity;
    }
    if (place.kind === "shipBay") {
      const bay = $inventory.openShip?.bays.find((entry) => entry.key === place.bay);
      return bay?.capacity ?? null;
    }
    if (place.kind === "container") {
      return $inventory.container?.capacity ?? null;
    }
    // The station hangar and the corporation divisions have no real limit.
    return null;
  }

  /** Ask for a move of the current selection. Nothing moves until it is confirmed. */
  function askMove(destination: MoveDestination): void {
    if (selectedCount === 0) {
      return;
    }
    menu = null;
    targetMenuOpen = false;
    pending = { kind: "move", place: destination.place, label: destination.label };
  }

  /** A row's own move button: it becomes the selection, then asks. */
  function askMoveOne(row: InventoryItemRow, place: InventoryPlace, destination: MoveDestination): void {
    flow.clearSelection();
    selectionPlace = place;
    flow.toggleSelection(row.itemID);
    menu = null;
    pending = { kind: "move", place: destination.place, label: destination.label };
  }

  function askTrash(): void {
    if (selectedCount === 0) {
      return;
    }
    menu = null;
    pending = { kind: "trash" };
  }

  async function confirmPending(): Promise<void> {
    const asked = pending;
    if (!asked) {
      return;
    }
    if (asked.kind === "trash") {
      const place = selectionPlace;
      if (!place || selection.length === 0) {
        return;
      }
      await run(async () => {
        await flow.trashItems([...selection], place);
        finishAction();
      });
      return;
    }
    const from = selectionPlace;
    if (!from || selection.length === 0) {
      return;
    }
    // HOW MUCH to send is the model's decision: a typed quantity wins, and
    // otherwise a single stack into a ship hold is clamped to what fits,
    // because the server refuses an overflowing move outright rather than
    // partially filling it.
    const verdict = moveQuantityFor({
      inventory: $inventory,
      destination: asked.place,
      selection,
      selectedRows,
      typedQuantity: moveQty,
    });
    if (verdict.kind === "refused") {
      error = verdict.message;
      pending = null;
      return;
    }
    await run(async () => {
      await flow.transferItems([...selection], from, asked.place, verdict.quantity);
      finishAction();
    });
  }

  /**
   * What every successful mutation leaves behind: nothing. The ticked ids are
   * dropped too — they name rows that are no longer where they were ticked, and
   * leaving them in the store makes the action bar offer to act on them again.
   */
  function finishAction(): void {
    flow.clearSelection();
    selectionPlace = null;
    // The amount goes with the selection it was typed for: leaving it behind
    // silently splits the NEXT stack somebody ticks.
    moveQty = null;
    pending = null;
    targetMenuOpen = false;
    menu = null;
  }

  async function mergeSelection(): Promise<void> {
    const place = selectionPlace;
    const order = mergeOrder(selectedRows);
    if (!place || !order) {
      return;
    }
    await run(async () => {
      await flow.mergeStacks(order.source.itemID, order.destination.itemID, place);
      finishAction();
    });
  }

  // --- the row menu ---------------------------------------------------------
  //
  // ⚠ ABSOLUTE, NOT FIXED, AND OUTSIDE THE SCROLLER. `.stn-panel` carries
  // `container-type: inline-size` for the width tiers, and a size container is
  // a containing block for its `position: fixed` descendants — so a menu
  // positioned against the VIEWPORT would land against the panel instead and
  // appear in the wrong place. It is positioned against the panel deliberately,
  // which is also what keeps it attached while the dock column is dragged. It
  // is rendered at the panel's root rather than inside the scrolling list, so
  // opening it can never make the list taller.
  function openMenu(
    event: MouseEvent,
    row: InventoryItemRow,
    place: InventoryPlace,
    where: readonly MoveDestination[],
  ): void {
    event.stopPropagation();
    const button = event.currentTarget as HTMLElement;
    const panel = panelEl;
    if (!panel) {
      return;
    }
    const anchor = button.getBoundingClientRect();
    const frame = panel.getBoundingClientRect();
    const height = 34 + where.length * 30;
    const width = 190;
    // Below the button, flipped above when there is no room, and clamped so the
    // menu is never drawn off the side of a narrow panel.
    const below = anchor.bottom - frame.top + 4;
    const above = anchor.top - frame.top - height - 4;
    menu = {
      row,
      place,
      targets: where,
      x: Math.max(4, Math.min(anchor.right - frame.left - width, frame.width - width - 4)),
      y: below + height > frame.height ? Math.max(4, above) : below,
    };
  }

  // --- dragging (R78) -------------------------------------------------------
  //
  // An accelerator, not a replacement: tick-then-move is untouched. A drag
  // reuses the SELECTION rather than carrying its own item list, so a dropped
  // stack goes through exactly the same confirm and the same fit clamp.
  let dropPlaceKey = $state<string | null>(null);

  function startDrag(event: DragEvent, row: InventoryItemRow, place: InventoryPlace): void {
    if (!isPicked(row, place)) {
      flow.clearSelection();
      selectionPlace = place;
      flow.toggleSelection(row.itemID);
      clearPending();
    }
    const payload: DragPayload = {
      kind: "inventoryItem",
      itemID: row.itemID,
      typeID: row.typeID,
      from: place,
    };
    event.dataTransfer?.setData(DRAG_MIME, encodeDrag(payload));
    event.dataTransfer?.setData("text/plain", nameOf(row));
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
  }

  function overPlace(event: DragEvent, place: InventoryPlace): void {
    if (!carriesOurPayload(event.dataTransfer?.types as string[] | undefined)) {
      return;
    }
    // preventDefault is what MAKES an element a drop target; without it the
    // browser refuses the drop and shows the "no entry" cursor.
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    dropPlaceKey = placeKey(place);
  }

  function dropOnPlace(event: DragEvent, place: InventoryPlace, label: string): void {
    dropPlaceKey = null;
    event.preventDefault();
    const payload = decodeDrag(event.dataTransfer?.getData(DRAG_MIME) ?? null);
    const verdict = dropOnPlaceVerdict(payload, place);
    if (verdict !== null) {
      // Refused, and SAID — through the panel's own message line, so a rejected
      // drop reads the same way a rejected click does.
      error = verdict;
      return;
    }
    // ⚠ A drag carries the SELECTION, not its own item list, so a drop that
    // arrives with nothing ticked has nothing to move. Without this it asked
    // "Move 0 stacks · 0 m³ to Ore hold?" and its Confirm did nothing at all.
    if (selectedCount === 0) {
      return;
    }
    pending = { kind: "move", place, label };
  }

  // --- the groups a location is made of -------------------------------------

  interface Group {
    readonly key: string;
    readonly title: string;
    readonly place: InventoryPlace;
    /** null means the contents could not be READ. `[]` means we looked. */
    readonly rows: readonly InventoryItemRow[] | null;
    /** The rows after the filter and the sort — what is actually drawn. */
    readonly shown: readonly InventoryItemRow[];
    readonly capacity: CapacityInfo | null;
    /** A real limit to fill toward, or a place that only reports room used. */
    readonly hasLimit: boolean;
    readonly collapsible: boolean;
    readonly collapsed: boolean;
    readonly readOnly: boolean;
    readonly error: string | null;
    readonly emptyText: string;
    /** Where this place's contents may be sent. Excludes the place itself. */
    readonly targets: readonly MoveDestination[];
    /**
     * The place `stackContainer` can re-stack, or null. The bridge knows only
     * "hangar" and "cargo", so those are the only two groups that offer it.
     */
    readonly stackKey: "hangar" | "cargo" | null;
  }

  function stackCount(g: Group): string {
    if (g.rows === null) {
      return "";
    }
    return g.rows.length === 1 ? "1 stack" : `${g.rows.length} stacks`;
  }

  function present(rows: readonly InventoryItemRow[]): readonly InventoryItemRow[] {
    return sortInventoryRows(
      rows.filter((row) => matchesFilter(nameOf(row), query)),
      sort,
      nameOf,
    );
  }

  function makeGroup(over: Partial<Group> & Pick<Group, "key" | "title" | "place" | "rows">): Group {
    const rows = over.rows;
    return {
      shown: rows === null ? [] : present(rows),
      capacity: null,
      hasLimit: false,
      collapsible: false,
      collapsed: false,
      readOnly: false,
      error: null,
      // ⚠ FOUND LIVE: THIS NAMED THE HANGAR TO A PILOT IN SPACE, who has none.
      // The sentence was written for the docked panel, where "the hangar" is
      // one tab away; out on a belt it points at a place the player cannot
      // reach and the server will not move anything into.
      emptyText: isDocked
        ? "Empty — move things here from the hangar."
        : "Empty — move things here from your other bays, or from a container on the grid.",
      targets: targetsFrom(over.place),
      stackKey: null,
      ...over,
    } as Group;
  }

  const bayGroups = $derived.by<readonly Group[]>(() => {
    const ship = openShip;
    if (!ship) {
      return [];
    }
    return orderedPresentBays(ship).map((bay: ShipBay) =>
      makeGroup({
        key: bay.key,
        title: bay.label,
        place: bayPlace(bay),
        rows: bay.items,
        capacity: bay.capacity,
        hasLimit: true,
        collapsible: true,
        collapsed: collapsedBays[bay.key] === true,
        readOnly: !bayIsActionable(ship.itemID, bay, $inventory.activeShipID),
        error: bay.error,
        stackKey:
          bay.key === "cargo" && bayIsActionable(ship.itemID, bay, $inventory.activeShipID)
            ? "cargo"
            : null,
      }),
    );
  });

  const selectedDivision = $derived(
    $inventory.corp.divisions.find(
      (entry) => entry.division === $inventory.corp.selectedDivision,
    ) ?? null,
  );

  const hangarGroup = $derived(
    makeGroup({
      key: "hangar",
      title: "Item hangar",
      place: { kind: "hangar" },
      rows: $inventory.hangar.error ? null : hangarThings($inventory),
      capacity: $inventory.hangar.capacity,
      error: $inventory.hangar.error,
      stackKey: "hangar",
      emptyText: $inventory.loaded ? "Nothing here but your ships." : "Looking through your hangar…",
    }),
  );

  const corpGroup = $derived.by<Group | null>(() => {
    const division = selectedDivision;
    if (!division) {
      return null;
    }
    return makeGroup({
      key: `corp:${division.division}`,
      title: divisionLabel(division.division, division.name),
      place: { kind: "corp", division: division.division },
      rows: division.error ? null : division.rows,
      error: division.error,
      emptyText:
        "Nothing here. This division is either empty or your corporation roles do not let you see it — the server decides, and it does not say which.",
    });
  });

  const containerGroup = $derived.by<Group | null>(() => {
    const open = container;
    if (!open) {
      return null;
    }
    return makeGroup({
      key: `container:${open.itemID}`,
      title: containerName(),
      place: { kind: "container", itemID: open.itemID },
      rows: open.error ? null : open.rows,
      capacity: open.capacity,
      hasLimit: true,
      error: open.error,
      emptyText: "This container is empty.",
    });
  });

  const uncheckedBays = $derived(uncheckedShipBays(openShip));
  const ships = $derived(shipRows($inventory));

  // --- the locations --------------------------------------------------------

  interface Location {
    readonly id: View;
    readonly label: string;
    readonly badge: string;
  }

  function bayItemCount(): number {
    return bayGroups.reduce((total, group) => total + (group.rows?.length ?? 0), 0);
  }

  /**
   * The places this panel can show, for the state the pilot is actually in.
   *
   * ⚠ IN SPACE THAT IS THE SHIP'S OWN BAYS, AND A CONTAINER ON THE GRID. The
   * ship hangar, the item hangar, the corp hangar and the station's services
   * are all things you reach from INSIDE a station; a flying pilot cannot open
   * any of them, and the server refuses every move into them.
   *
   * They are not drawn empty, they are not drawn disabled — they are ABSENT.
   * A tab wearing "you cannot use this right now" is a tab a pilot still has to
   * read past on every single visit, and there is nothing behind these four but
   * whatever the last docked read happened to leave in the store.
   */
  const locations = $derived.by<readonly Location[]>(() => {
    const list: Location[] = [
      {
        id: "ship",
        label: openShip ? `${typeName(hullTypeID)} bays` : "Ship bays",
        badge: openShip ? `${bayItemCount()}` : "",
      },
    ];
    if (isDocked) {
      list.push({ id: "ships", label: "Ship hangar", badge: `${ships.length}` });
      list.push({ id: "hangar", label: "Item hangar", badge: `${hangarThings($inventory).length}` });
      // The badge counts what is in the division on screen, the way every other
      // location's does; WHICH division is named by the chips inside the view,
      // where there is room for it.
      list.push({
        id: "corp",
        label: "Corp hangar",
        badge: selectedDivision ? `${selectedDivision.rows.length}` : "",
      });
    }
    if (container) {
      list.push({ id: "container", label: containerName(), badge: `${container.rows.length}` });
    }
    if (isDocked) {
      list.push({ id: "services", label: "Station services", badge: "" });
    }
    return list;
  });

  /**
   * A view the current state no longer offers falls back to the ship's bays.
   *
   * Undocking with the Item hangar open would otherwise leave the panel sitting
   * on a location that is not in its own tab strip, showing a list of things in
   * a station the pilot has just left.
   */
  $effect(() => {
    if (!locations.some((location) => location.id === view)) {
      view = "ship";
    }
  });

  const isInventoryView = $derived(
    view === "ship" || view === "hangar" || view === "corp" || view === "container",
  );

  function goTo(next: View): void {
    view = next;
    clearSelection();
    query = "";
  }

  function sortBy(key: SortKey): void {
    sort = nextSort(sort, key);
  }

  function sortArrow(key: SortKey): string {
    return sort.key === key ? (sort.dir === 1 ? "▲" : "▼") : "";
  }

  // --- the header hint ------------------------------------------------------

  const stationHint = $derived.by<string>(() => {
    const here = $station.station;
    if (!here) {
      return $station.online?.structureID ? ($flight.structureName ?? "Player structure") : "";
    }
    return here.solarSystemName ? `${here.stationName} · ${here.solarSystemName}` : here.stationName;
  });

  // --- what the panel has to say --------------------------------------------

  interface Note {
    readonly text: string;
    readonly bad: boolean;
  }

  const notes = $derived.by<readonly Note[]>(() => {
    const list: Note[] = [];
    const outcome = $inventory.lastOutcome;
    if (outcome) {
      list.push({ text: outcome.message, bad: !outcome.applied });
    }
    if ($inventory.actionError) {
      list.push({ text: `Last action failed: ${$inventory.actionError}`, bad: true });
    }
    if (error) {
      list.push({ text: error, bad: true });
    }
    if ($station.readError) {
      list.push({ text: `Some station details could not be loaded: ${$station.readError}`, bad: true });
    }
    return list;
  });

  // --- the repair shop ------------------------------------------------------
  //
  // Unlike the two ship swaps beside it a repair COSTS ISK, so it is two
  // presses: "Repair ship" only asks the shop for a quote, and the charge waits
  // for a second press that names the price. The shop decides what is damaged —
  // this panel never judges a hitpoint total.
  let repairQuote = $state<readonly RepairQuoteRow[] | null>(null);
  let repairNote = $state("");

  // The lobby's two office buttons (dockedUI/offices.py, _load_buttons): to
  // rent, for a pilot who may rent whose corporation has no office here; to
  // give up, for a director whose corporation has one. Each is two presses, as
  // the retail lobby asks before it acts: the price is shown before the rent
  // is paid, and an office is given up only on a second press.
  const canRentHere = $derived(Boolean($station.offices?.canRent && !$station.offices.ownOffice));
  const canGiveUpHere = $derived(Boolean($station.offices?.canGiveUp && $station.offices.ownOffice));
  let officeQuote = $state<StationOfficeQuote | null>(null);
  let givingUpOffice = $state(false);
  // A price shown, or a question asked, is for the office as it was: once the
  // button it belongs to is gone, so is it.
  $effect(() => {
    if (!canRentHere) officeQuote = null;
    if (!canGiveUpHere) givingUpOffice = false;
  });
  /** Whether the corporation's hangar here, as the page has it, holds anything. */
  const officeHoldsItems = $derived(
    $inventory.corp.loaded && $inventory.corp.available && $inventory.corp.divisions.some((division) => division.rows.length > 0),
  );

  async function askOfficeQuote(): Promise<void> {
    officeQuote = await flow.quoteStationOffice();
  }

  async function payOfficeRent(): Promise<void> {
    if (officeQuote === null) return;
    await flow.rentStationOffice(officeQuote);
    officeQuote = null;
  }

  async function giveUpOffice(): Promise<void> {
    await flow.giveUpStationOffice();
    givingUpOffice = false;
  }
  let quotedShipID = $state<number | null>(null);

  // A quote names ITEM IDS on one hull. Board another ship and those ids are no
  // longer what is in front of the player, so the standing quote is dropped
  // rather than left there to be paid for.
  $effect(() => {
    if (repairQuote !== null && $inventory.activeShipID !== quotedShipID) {
      repairQuote = null;
      repairNote = "";
    }
  });

  const repairTotal = $derived(repairQuote === null ? null : repairQuoteTotal(repairQuote));

  // One row per damaged PART. A hull's quote carries its modules and bay drones
  // under the hull's key, so a row per key read "Retriever" when only a drone
  // in its bay was chewed.
  const repairParts = $derived((repairQuote ?? []).flatMap((quote) => quote.parts));

  function quotedTypeID(itemID: number): number | null {
    for (const slot of $fitting.slots) {
      if (slot.module !== null && slot.module.itemID === itemID) {
        return slot.module.typeID;
      }
    }
    const row =
      $inventory.hangar.rows.find((r) => r.itemID === itemID) ??
      $inventory.cargo.rows.find((r) => r.itemID === itemID);
    return row ? row.typeID : null;
  }

  /**
   * The open hull's TYPE, from whichever source actually has it.
   *
   * ⚠ `openShip.typeID` IS 0 IN SPACE, AND THAT IS NOT A BUG IN THIS PANEL.
   * The flow reads it off the row the player clicked the hull FROM — a row in
   * the ship hangar or the cargo hold — and in space there is no ship hangar to
   * click one in, so it falls back to 0 and the tab reads "your ship bays".
   *
   * The snapshot has it: the same hull, from the ship the pilot is flying. It
   * is only used when the open ship IS that ship, so this can never name one
   * hull with another's type.
   */
  const hullTypeID = $derived.by<number>(() => {
    const open = openShip;
    if (!open) {
      return 0;
    }
    if (open.typeID > 0) {
      return open.typeID;
    }
    const ship = $space.snapshot?.ship ?? null;
    return ship && ship.itemID === open.itemID ? ship.typeID : 0;
  });

  /**
   * The OPEN HULL's own type name, for the tab that says whose bays these are.
   *
   * ⚠ FOUND LIVE IN SPACE: the tab read "your ship bays" rather than
   * "Procurer bays". Docked, the ship hangar's rows carry that typeID and the
   * row sweep asks for it as a side effect; in space there is no ship hangar,
   * so nothing was asking and the fallback stood in permanently. A panel that
   * needs a name asks for it — the same lesson the module rack learned.
   */
  $effect(() => {
    if (hullTypeID > 0 && $names.resolved[nameKey("type", hullTypeID)] === undefined) {
      flow.requestNames([{ kind: "type", id: hullTypeID }]);
    }
  });

  // R7d — a quoted item renders as its type NAME; its item id is never shown.
  $effect(() => {
    const refs: NameRef[] = [];
    for (const part of repairParts) {
      const typeID = part.typeID ?? quotedTypeID(part.itemID);
      if (typeID !== null) {
        refs.push({ kind: "type", id: typeID });
      }
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  function quotedName(part: RepairQuotePart): string {
    const typeID = part.typeID ?? quotedTypeID(part.itemID);
    return typeID === null ? "Something on your ship" : nameOnly(typeID, "type");
  }

  /** "73%" health left, as the client's repair window shows it; "" when unknown. */
  function quotedHealth(part: RepairQuotePart): string {
    if (part.damage === null || part.maxHealth === null || !(part.maxHealth > 0)) {
      return "";
    }
    const left = Math.max(0, part.maxHealth - Math.ceil(part.damage)) / part.maxHealth;
    return `${Math.floor(left * 100)}%`;
  }

  async function askRepairQuote(): Promise<void> {
    const rows = await flow.quoteShipRepair();
    quotedShipID = store.inventory.get().activeShipID;
    repairQuote = rows;
    repairNote =
      rows === null
        ? "There is no ship to repair — board one first."
        : rows.length === 0
          ? "The repair shop finds nothing damaged."
          : "";
  }

  async function payRepairQuote(rows: readonly RepairQuoteRow[]): Promise<void> {
    await flow.repairShip(repairTargets(rows));
    await askRepairQuote();
  }

  /** Hand a hull to the bays view. One piece of state, not two views fighting. */
  function openInBays(row: InventoryItemRow): void {
    view = "ship";
    void run(() => flow.openShipBays(row.itemID));
  }

  /**
   * How full this hull's CARGO HOLD is — one reading, because that is the one
   * that fits a column and the one a player checks before loading.
   *
   * ⚠ Only the hull whose bays have actually been READ can answer: the slice
   * holds the bays of ONE ship at a time (`openShip`), and reading every hull's
   * bays would be a bound-object call per hull on every refresh. Every other
   * row is a dash — never a number this panel worked out for itself.
   */
  function cargoSummary(shipItemID: number): string {
    const ship = openShip;
    if (!ship || ship.itemID !== shipItemID || !ship.loaded) {
      return "—";
    }
    const cargo = orderedPresentBays(ship).find((bay) => bay.key === "cargo");
    return cargo ? capacityText(cargo.capacity) : "—";
  }
</script>

<!-- ONE ROW, used by every bay, the item hangar, a corporation division and an
     open container. Every location shows the same thing in the same order, so a
     player learns one row and not five. -->
{#snippet itemRow(group: Group, row: InventoryItemRow)}
  {@const picked = isPicked(row, group.place)}
  {@const openable = isOpenableContainer(row)}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <li
    class="stn-row"
    class:picked
    class:readonly={group.readOnly}
    draggable={group.readOnly ? "false" : "true"}
    ondragstart={(event) => startDrag(event, row, group.place)}
    onclick={(event) => {
      if ((event.target as HTMLElement).closest("button, input, label")) return;
      if (!group.readOnly) toggle(row, group.place);
    }}
  >
    <span class="stn-cell-pick">
      {#if !group.readOnly}
        <input
          type="checkbox"
          aria-label="Select {nameOf(row)}"
          checked={picked}
          disabled={busy}
          onchange={() => toggle(row, group.place)}
        />
      {/if}
    </span>
    <span class="stn-cell-icon">
      <TypeIcon typeID={row.typeID} name={nameOf(row)} size="sm" />
    </span>
    <span class="stn-cell-name">
      <span class="stn-name" title={nameOf(row)}>{nameOf(row)}</span>
      <!-- Only shown at the narrow tier, where there is no room for the m³ and
           state columns; it is the same two readings, on one line. -->
      <span class="stn-meta">
        {#if totalVolume(row) !== null}{volumeCell(totalVolume(row))} m³ · {/if}{stateText(row)}
      </span>
    </span>
    <!-- The number, always. An assembled thing is called one in the State
         column beside it (and in the narrow tier's meta line), so captioning
         this cell "assembled" too said it twice and left the quantity nowhere. -->
    <span class="stn-cell-qty">{amount(row.quantity)}</span>
    <span class="stn-cell-unit">{volumeCell(row.volume ?? null)}</span>
    <span class="stn-cell-vol">{volumeCell(totalVolume(row))}</span>
    <span class="stn-cell-state">{stateText(row)}</span>
    <span class="stn-cell-move">
      {#if group.readOnly}
        <span class="stn-muted">read-only</span>
      {:else if openable}
        <button
          type="button"
          class="stn-btn stn-btn-quick"
          disabled={busy}
          onclick={() => run(() => flow.openContainer(row.itemID))}
        >
          Open
        </button>
      {:else if group.targets.length > 0}
        <button
          type="button"
          class="stn-btn stn-btn-quick"
          disabled={busy}
          onclick={() => askMoveOne(row, group.place, group.targets[0]!)}
          title="Move {nameOf(row)} to {group.targets[0]!.label}"
        >
          <span class="stn-quick-long">to {group.targets[0]!.label}</span><span
            class="stn-quick-short">to {shortLabel(group.targets[0]!.label)}</span>
        </button>
      {/if}
      {#if !group.readOnly && group.targets.length > 0}
        <button
          type="button"
          class="stn-btn stn-btn-more"
          aria-label="Where else to send {nameOf(row)}"
          disabled={busy}
          onclick={(event) => openMenu(event, row, group.place, group.targets)}
        >
          ▾
        </button>
      {/if}
    </span>
  </li>
{/snippet}

<!-- ONE GROUP: a header that says how full the place is, a column header, and
     the rows. In the bays view the header folds the bay away. -->
{#snippet group(g: Group)}
  {@const allPicked = g.shown.length > 0 && g.shown.every((row) => isPicked(row, g.place))}
  <section class="stn-group">
    <div class="stn-group-head">
      {#if g.collapsible}
        <button
          type="button"
          class="stn-group-toggle"
          aria-expanded={!g.collapsed}
          onclick={() => (collapsedBays = { ...collapsedBays, [g.key]: !g.collapsed })}
        >
          <span class="stn-chevron" aria-hidden="true">{g.collapsed ? "▶" : "▼"}</span>
          <span class="stn-group-title">{g.title}</span>
        </button>
      {:else}
        <span class="stn-group-title">{g.title}</span>
      {/if}
      <span class="stn-group-count">{stackCount(g)}</span>
      <!-- The bar is a summary; the numbers beside it are the real reading, so
           the bar is never the only way to tell how full a place is. -->
      <span class="stn-bar" class:nolimit={!g.hasLimit || !g.capacity}>
        <span
          class="stn-bar-fill"
          class:full={fillPercent(g.capacity) > 90}
          style="width: {g.hasLimit ? fillPercent(g.capacity) : 0}%"
        ></span>
      </span>
      <span class="stn-group-cap" class:unknown={!g.capacity}>
        {g.hasLimit ? capacityText(g.capacity) : roomUsedText(g.capacity)}
      </span>
      {#if g.stackKey && g.rows && g.rows.length > 1}
        <button
          type="button"
          class="stn-btn stn-stack"
          disabled={busy}
          onclick={() => run(() => flow.stackContainer(g.stackKey!))}
        >
          Stack all
        </button>
      {/if}
    </div>

    {#if !g.collapsed}
      <div class="stn-colhead">
        <span class="stn-cell-pick">
          {#if !g.readOnly && g.shown.length > 0}
            <input
              type="checkbox"
              aria-label="Select everything shown in {g.title}"
              checked={allPicked}
              disabled={busy}
              onchange={() => toggleGroup(g, allPicked)}
            />
          {/if}
        </span>
        <span class="stn-cell-icon"></span>
        <button type="button" class="stn-sort stn-cell-name" class:on={sort.key === "name"} onclick={() => sortBy("name")}>
          Name {sortArrow("name")}
        </button>
        <button type="button" class="stn-sort stn-cell-qty" class:on={sort.key === "qty"} onclick={() => sortBy("qty")}>
          Qty {sortArrow("qty")}
        </button>
        <span class="stn-cell-unit">m³ / unit</span>
        <button type="button" class="stn-sort stn-cell-vol" class:on={sort.key === "vol"} onclick={() => sortBy("vol")}>
          Total m³ {sortArrow("vol")}
        </button>
        <span class="stn-cell-state">State</span>
        <span class="stn-cell-move">Move</span>
      </div>

      <!-- The list is the drop target for its own place: drag a row from one
           hangar onto another's list to move it. A read-only place (a bay on a
           hull you are not flying) takes no drops. -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <ul
        class="stn-rows"
        class:drop-target={dropPlaceKey === placeKey(g.place)}
        ondragover={(event) => !g.readOnly && overPlace(event, g.place)}
        ondragleave={() => (dropPlaceKey = null)}
        ondrop={(event) => !g.readOnly && dropOnPlace(event, g.place, g.title)}
      >
        {#if g.error}
          <!-- ⚠ The read FAILED. This is not an empty place, and must never be
               drawn as one. -->
          <li class="stn-empty bad">What is in here could not be read: {g.error}</li>
        {:else if g.rows === null}
          <li class="stn-empty bad">What is in here could not be read.</li>
        {:else if g.rows.length === 0}
          <li class="stn-empty">{g.emptyText}</li>
        {:else if g.shown.length === 0}
          <li class="stn-empty">No matches.</li>
        {:else}
          {#each g.shown as row (row.itemID)}
            {@render itemRow(g, row)}
          {/each}
        {/if}
      </ul>
    {/if}
  </section>
{/snippet}

{#snippet repairControls()}
  <p class="stn-controls">
    <button type="button" class="stn-btn stn-btn-wide" disabled={busy} onclick={() => run(askRepairQuote)}>
      Repair ship
    </button>
  </p>
  {#if repairQuote !== null && repairQuote.length > 0}
    <div class="table-wrap overflow-x-auto">
      <table class="reflow">
        <thead><tr><th>Damaged</th><th>Health</th><th>Cost</th></tr></thead>
        <tbody>
          {#each repairParts as part, index (`${part.itemID}:${index}`)}
            <tr>
              <td data-label="Damaged">{quotedName(part)}</td>
              <td data-label="Health">{quotedHealth(part) || "—"}</td>
              <td data-label="Cost">{part.cost === null ? "—" : formatIsk(part.cost.toFixed(2))}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="stn-note">
      {#if repairTotal === null}
        The repair service did not quote a price; repairing still charges your wallet.
      {:else}
        The repair service will charge {formatIsk(repairTotal.toFixed(2))}.
      {/if}
    </p>
    <p class="stn-controls">
      <button type="button" class="stn-btn stn-btn-go" disabled={busy}
        onclick={() => run(() => payRepairQuote(repairQuote ?? []))}>
        Repair {repairParts.length === 1 ? "it" : `all ${repairParts.length}`} and pay
      </button>
      <button type="button" class="stn-btn" disabled={busy} onclick={() => { repairQuote = null; repairNote = ""; }}>
        Cancel
      </button>
    </p>
  {:else if repairNote}
    <p class="stn-note">{repairNote}</p>
  {/if}
{/snippet}

{#snippet sessionControls()}
  <h3 class="stn-section">Session</h3>
  <p class="stn-controls">
    <button type="button" class="stn-btn stn-btn-ghost" disabled={busy} onclick={() => run(() => flow.releaseSession())}>
      Go offline
    </button>
    <button type="button" class="stn-btn stn-btn-danger" disabled={busy} onclick={() => run(() => flow.logout())}>
      Log out
    </button>
  </p>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="stn-panel" bind:this={panelEl} onkeydown={onKeydown}>
  <!-- ============================================================= header -->
  <div class="stn-head">
    <!--
      ⚠ "STATION" IS ONLY TRUE HALF THE TIME NOW. The panel is the "Inventory &
      Ship" window in space as well, where a header naming a station the pilot
      undocked from is exactly the kind of stale label this rewrite exists to
      remove. In space it says what it is actually showing.
    -->
    <span class="stn-head-title">{isDocked ? $station.online?.structureID ? "Structure" : "Station" : "Ship"}</span>
    <span class="stn-head-hint">{stationHint}</span>
    <button
      type="button"
      class="stn-icon-btn"
      title="Refresh"
      aria-label="Refresh"
      disabled={busy}
      onclick={refreshAll}
    >
      <span aria-hidden="true">↻</span><span class="stn-icon-word">Refresh</span>
    </button>
    {#if onToggleExpand}
      <button
        type="button"
        class="stn-icon-btn"
        title={expanded ? "Give the work area back" : "Take the whole work area"}
        aria-label={expanded ? "Give the work area back" : "Take the whole work area"}
        aria-pressed={expanded}
        onclick={onToggleExpand}
      >
        <span aria-hidden="true">{expanded ? "⤡" : "⤢"}</span>
      </button>
    {/if}
    {#if onCollapse}
      <button type="button" class="stn-icon-btn" title="Collapse" aria-label="Collapse" onclick={onCollapse}>
        <span aria-hidden="true">›</span>
      </button>
    {/if}
  </div>

  <!-- =========================================================== locations -->
  <div class="stn-locations">
    <div class="stn-tabs" role="tablist" aria-label="Locations">
      {#each locations as location (location.id)}
        <button
          type="button"
          role="tab"
          id="stn-tab-{location.id}"
          class="stn-tab"
          class:on={view === location.id}
          aria-selected={view === location.id}
          aria-controls="stn-view-{location.id}"
          onclick={() => goTo(location.id)}
        >
          {location.label}
          {#if location.badge}<span class="stn-badge">{location.badge}</span>{/if}
        </button>
      {/each}
    </div>
    <!-- The same locations for a panel too narrow for a tab row. Only one of
         the two is ever displayed, so neither is announced twice. -->
    <select
      class="stn-picker"
      aria-label="Location"
      value={view}
      onchange={(event) => goTo((event.currentTarget as HTMLSelectElement).value as View)}
    >
      {#each locations as location (location.id)}
        <option value={location.id}>{location.label}{location.badge ? ` (${location.badge})` : ""}</option>
      {/each}
    </select>
    <label class="stn-filter">
      <span class="stn-filter-glyph" aria-hidden="true">⌕</span>
      <input type="search" placeholder="Filter…" aria-label="Filter this location by name" bind:value={query} />
    </label>
  </div>

  <!-- =============================================================== notes -->
  {#if notes.length > 0}
    <div class="stn-notes">
      {#each notes as note, index (index)}
        <p class="stn-note" class:bad={note.bad}>{note.text}</p>
      {/each}
    </div>
  {/if}

  <!-- ============================================================= content -->
  <div class="stn-content" onscroll={() => (menu = null)}>
    <!-- ------------------------------------------------------- ship bays -->
    <section class="stn-view" id="stn-view-ship" role="tabpanel" aria-labelledby="stn-tab-ship" hidden={view !== "ship"}>
      {#if !openShip}
        <p class="stn-note">
          {$inventory.activeShipID ? "Opening your ship…" : "Pick a hull in the ship hangar to see its bays."}
        </p>
      {:else if openShip.error}
        <!-- The read failed outright, so NOTHING is known about this hull's
             bays. That is emphatically not "this ship has no bays". -->
        <p class="stn-note bad">
          This ship's bays could not be read, so we cannot say what it has: {openShip.error}
        </p>
      {:else if !openShip.loaded}
        <p class="stn-note">Looking inside this ship…</p>
      {:else if bayGroups.length === 0}
        <p class="stn-note">
          {uncheckedBays.length > 0
            ? "None of this ship's bays could be read, so we cannot say what it has."
            : "This ship has no bays that can hold anything."}
        </p>
      {:else}
        {#each bayGroups as bay (bay.key)}
          {@render group(bay)}
        {/each}
        {#if openShip.itemID !== $inventory.activeShipID}
          <p class="stn-note">Board this ship to move things in and out of it.</p>
        {/if}
      {/if}
      {#if uncheckedBays.length > 0 && !openShip?.error}
        <!-- ⚠ Named out loud, so a bay we failed to check is never mistaken for
             a bay the hull does not have. -->
        <p class="stn-note">
          These bays could not be checked, so we cannot say whether this ship has them:
          {uncheckedBays.map((bay) => bay.label).join(", ")}.
        </p>
      {/if}
    </section>

    <!-- ----------------------------------------------------- ship hangar -->
    <!--
      ⚠ THE STATION-ONLY VIEWS ARE NOT RENDERED IN SPACE AT ALL.

      Every location renders and the inactive ones carry `hidden`, so a
      selection survives a tab switch — that is the panel's design and it is
      tested. But `hidden` is the wrong tool for a place the pilot cannot reach:
      it would leave the ship hangar, the item hangar and the corp hangar
      building their groups out of whatever the last docked read left in the
      store, one poll at a time, for a hull that is out on a belt.

      Absent means absent. The tab strip drops them (see `locations`) and so
      does the DOM.
    -->
    {#if isDocked}
    <section class="stn-view" id="stn-view-ships" role="tabpanel" aria-labelledby="stn-tab-ships" hidden={view !== "ships"}>
      <div class="stn-group-head">
        <span class="stn-group-title">Your ships</span>
        <span class="stn-group-count">
          {$inventory.loaded ? `${ships.length} here` : "looking…"}
        </span>
      </div>
      {#if $inventory.hangar.error}
        <p class="stn-note bad">Your ships could not be listed: {$inventory.hangar.error}</p>
      {:else if ships.length === 0}
        <p class="stn-note">{$inventory.loaded ? "You have no ships here." : "Looking for your ships…"}</p>
      {:else}
        <div class="stn-colhead stn-ship-colhead">
          <span></span>
          <span>Ship</span>
          <span class="stn-cell-bays">Cargo hold</span>
          <span class="stn-cell-status">Status</span>
          <span class="stn-cell-move">Actions</span>
        </div>
        <ul class="stn-rows">
          {#each ships as ship (ship.itemID)}
            {@const flying = ship.itemID === $inventory.activeShipID}
            <li class="stn-row stn-ship-row" class:flying class:picked={openShip?.itemID === ship.itemID}>
              <span class="stn-cell-render">
                <TypeIcon typeID={ship.typeID} name={nameOf(ship)} size="md" />
              </span>
              <span class="stn-cell-name">
                <span class="stn-name stn-ship-name">{nameOf(ship)}</span>
                <span class="stn-meta">{flying ? "You are flying this" : "Docked here"}</span>
              </span>
              <span class="stn-cell-bays">{cargoSummary(ship.itemID)}</span>
              <span class="stn-cell-status" class:accent={flying}>
                {flying ? "You are flying this" : "Docked here"}
              </span>
              <span class="stn-cell-move">
                <button type="button" class="stn-btn" disabled={busy} onclick={() => openInBays(ship)}>
                  Open
                </button>
                {#if isBoardableShip(ship, $inventory.activeShipID)}
                  <button
                    type="button"
                    class="stn-btn stn-btn-quick"
                    disabled={busy}
                    onclick={() => run(() => flow.boardShip(ship.itemID))}
                  >
                    Board
                  </button>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- ----------------------------------------------------- item hangar -->
    <section class="stn-view" id="stn-view-hangar" role="tabpanel" aria-labelledby="stn-tab-hangar" hidden={view !== "hangar"}>
      {@render group(hangarGroup)}
    </section>

    <!-- ------------------------------------------------ corporation hangar -->
    <section class="stn-view" id="stn-view-corp" role="tabpanel" aria-labelledby="stn-tab-corp" hidden={view !== "corp"}>
      {#if !$inventory.corp.loaded}
        <p class="stn-note">Loading the corporation hangar…</p>
      {:else if !$inventory.corp.available}
        <p class="stn-note">
          {#if $inventory.corp.reason === "NO_CORP_OFFICE"}
            Your corporation has no office at this station.
          {:else}
            The corporation hangar could not be read: {$inventory.corp.reason ?? "unknown reason"}
          {/if}
        </p>
      {:else}
        <div class="stn-divisions">
          {#each $inventory.corp.divisions as division (division.division)}
            <button
              type="button"
              class="stn-chip"
              class:on={division.division === $inventory.corp.selectedDivision}
              disabled={busy}
              onclick={() => {
                clearSelection();
                flow.selectCorpDivision(division.division);
              }}
            >
              {divisionLabel(division.division, division.name)}
              <span class="stn-badge">{division.rows.length || ""}</span>
            </button>
          {/each}
        </div>
        {#if corpGroup}
          {@render group(corpGroup)}
        {/if}
      {/if}
    </section>

    <!-- -------------------------------------------------- open container -->
    {/if}

    <!-- A container is opened ON THE GRID as well as in a station, so it is the
         one non-ship location a flying pilot can reach. -->
    <section class="stn-view" id="stn-view-container" role="tabpanel" aria-labelledby="stn-tab-container" hidden={view !== "container"}>
      {#if containerGroup}
        <p class="stn-controls">
          <button
            type="button"
            class="stn-btn"
            disabled={busy}
            onclick={() => {
              void run(() => flow.openContainer(null));
              view = "hangar";
            }}
          >
            ← Back to the item hangar
          </button>
        </p>
        {@render group(containerGroup)}
      {/if}
    </section>

    <!-- -------------------------------------------------- station services -->
    {#if isDocked && !$station.online?.structureID}
    <section class="stn-view stn-services" id="stn-view-services" role="tabpanel" aria-labelledby="stn-tab-services" hidden={view !== "services"}>
      <div class="stn-services-col">
        <h3 class="stn-section">Station</h3>
        <dl class="stn-facts">
          <dt>Owner</dt>
          <dd>{nameOnly($station.bits?.ownerID ?? null, "owner")}</dd>
          <dt>Type</dt>
          <dd>{nameOnly($station.bits?.stationTypeID ?? null, "type")}</dd>
          <dt>Security</dt>
          <dd>{$station.station?.security?.toFixed(2) ?? "—"}</dd>
        </dl>

        <h3 class="stn-section">Ship</h3>
        <p class="stn-controls">
          <!-- The repair shop. This press only ASKS for the quote; the wallet is
               charged by the priced press that appears with the answer. -->
          <button type="button" class="stn-btn stn-btn-wide" disabled={busy || aboardCorvette} title={aboardCorvette ? "You are already aboard a corvette." : undefined} onclick={() => run(() => flow.boardCorvette(sureOfTheCorvette))}>
            Board corvette
          </button>
          <button type="button" class="stn-btn stn-btn-wide" disabled={busy} onclick={() => run(() => flow.leaveShip())}>
            Leave ship → capsule
          </button>
        </p>
        {@render repairControls()}
        {@render sessionControls()}
      </div>

      <div class="stn-services-col">
        <div class="stn-group-head">
          <span class="stn-group-title">Guests</span>
          <span class="stn-group-count">{$station.guests.length} in station</span>
          <span class="stn-group-gap"></span>
          <button
            type="button"
            class="stn-icon-btn"
            title="Refresh the guest list"
            aria-label="Refresh the guest list"
            disabled={busy}
            onclick={() => run(() => flow.refreshStationPanel())}
          >
            <span aria-hidden="true">↻</span>
          </button>
        </div>
        {#if $station.guests.length === 0}
          <p class="stn-note">No guests reported yet.</p>
        {:else}
          <div class="table-wrap overflow-x-auto">
            <table class="guests reflow">
              <thead>
                <tr><th>Character</th><th>Corporation</th><th>Alliance</th></tr>
              </thead>
              <tbody>
                {#each $station.guests as guest (guest.characterID)}
                  <tr class={guest.characterID === $station.online?.characterID ? "self" : ""}>
                    <td data-label="Character">
                      {guest.characterID === $station.online?.characterID
                        ? `${$station.online?.characterName} (you)`
                        : nameOnly(guest.characterID, "character")}
                    </td>
                    <td data-label="Corporation">{nameOnly(guest.corporationID, "corporation")}</td>
                    <td data-label="Alliance">{nameOnly(guest.allianceID, "alliance")}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}

        <div class="stn-group-head stn-offices-head">
          <span class="stn-group-title">Offices</span>
          {#if $station.offices?.available}
            <span class="stn-group-count">
              {$station.offices.corporationIDs.length} rented{$station.offices.freeOffices === null ? "" : ` · ${$station.offices.freeOffices} free`}
            </span>
          {/if}
          <span class="stn-group-gap"></span>
          <button
            type="button"
            class="stn-icon-btn"
            title="List the offices in this station"
            aria-label="List the offices in this station"
            disabled={busy}
            onclick={() => run(() => flow.loadStationOffices())}
          >
            <span aria-hidden="true">↻</span>
          </button>
        </div>
        {#if $station.offices === null}
          <p class="stn-note">Not listed yet. Press ↻ to list this station's offices.</p>
        {:else if !$station.offices.available}
          <p class="stn-note">This pilot's connection does not carry a station's offices.</p>
        {:else if officeRows.length === 0}
          <p class="stn-note">No corporation has an office here.</p>
        {:else}
          <ul class="stn-offices">
            {#each officeRows as office (office.corporationID)}
              <li>{office.name}</li>
            {/each}
          </ul>
        {/if}
        {#if $station.offices?.available}
          {#if $station.offices.ownOffice}
            <p class="stn-note">Your corporation has an office here.</p>
          {:else if $station.offices.impounded}
            <p class="stn-note">Your corporation has items impounded here.</p>
          {/if}
          {#if canRentHere && officeQuote === null}
            <p class="stn-controls">
              <button type="button" class="stn-btn stn-btn-wide" disabled={busy} onclick={() => run(askOfficeQuote)}>
                Rent an office
              </button>
            </p>
          {:else if canRentHere && officeQuote !== null}
            <p class="stn-note">
              An office here costs {formatIsk(officeQuote.cost.toFixed(2))} for {officeQuote.days} days, paid from your corporation's wallet.
            </p>
            <p class="stn-controls">
              <button type="button" class="stn-btn stn-btn-go" disabled={busy} onclick={() => run(payOfficeRent)}>
                Rent it and pay
              </button>
              <button type="button" class="stn-btn" disabled={busy} onclick={() => { officeQuote = null; }}>
                Cancel
              </button>
            </p>
          {:else if canGiveUpHere && !givingUpOffice}
            <p class="stn-controls">
              <button type="button" class="stn-btn stn-btn-wide" disabled={busy} onclick={() => { givingUpOffice = true; }}>
                Give up the office
              </button>
            </p>
          {:else if canGiveUpHere}
            <p class="stn-note">
              {#if officeHoldsItems}
                The office's hangars are not empty. Give it up, and what is in them is impounded here.
              {:else}
                Give up your corporation's office in this station?
              {/if}
            </p>
            <p class="stn-controls">
              <button type="button" class="stn-btn stn-btn-go" disabled={busy} onclick={() => run(giveUpOffice)}>
                Give it up
              </button>
              <button type="button" class="stn-btn" disabled={busy} onclick={() => { givingUpOffice = false; }}>
                Cancel
              </button>
            </p>
          {/if}
        {/if}
      </div>
    </section>
    {:else if isDocked}
    <section class="stn-view stn-services" id="stn-view-services" role="tabpanel" aria-labelledby="stn-tab-services" hidden={view !== "services"}>
      <div class="stn-services-col">
        <h3 class="stn-section">Structure services</h3>
        {#if $station.structureServiceIDs === null}
          <p class="stn-note">{$station.readError ?? "Checking current structure services…"}</p>
        {:else}
          <p class="stn-note">Personal hangar: {structureHasCapability($station.structureServiceIDs, "personalInventory") ? "available" : "unavailable"}</p>
          <p class="stn-note">Corporation office: {structureHasCapability($station.structureServiceIDs, "corporationHangar") ? "available; office and division rights still required" : "unavailable"}</p>
          <p class="stn-note">Manual fitting: {structureHasCapability($station.structureServiceIDs, "fitting") ? "available" : "unavailable"}</p>
          <p class="stn-note">Reprocessing: {structureHasCapability($station.structureServiceIDs, "reprocessing") ? "online; action support is separate" : "unavailable"}</p>
          <p class="stn-note">Market: {structureHasCapability($station.structureServiceIDs, "market") ? "online; action support is separate" : "unavailable"}</p>
          <p class="stn-note">Industry: {structureHasCapability($station.structureServiceIDs, "industry") ? "online; facility authority is separate" : "unavailable"}</p>
          <p class="stn-note">Repair: {structureHasCapability($station.structureServiceIDs, "repair") ? "available" : "unavailable"}</p>
        {/if}
        {#if structureHasCapability($station.structureServiceIDs, "repair")}
          {@render repairControls()}
        {/if}
        {@render sessionControls()}
      </div>
    </section>
    {/if}
  </div>

  <!-- ========================================================== action bar -->
  {#if isInventoryView}
    <div class="stn-actions" class:armed={selectedCount > 0}>
      {#if pending}
        <!-- ⚠ Every move is confirmed. A stack in the wrong hold is a trip back;
             a trashed stack is gone for good. -->
        <span class="stn-ask">
          {#if pending.kind === "trash"}
            Trash <b>{selectedCount}</b> {selectedCount === 1 ? "stack" : "stacks"} ·
            <b>{volumeText(selectedVolume)}</b>? This cannot be undone.
          {:else}
            Move <b>{selectedCount}</b> {selectedCount === 1 ? "stack" : "stacks"} ·
            <b>{volumeText(selectedVolume)}</b> to <b class="stn-accent">{pending.label}</b>?
            <span class="stn-muted">{roomFreeText(destinationCapacity(pending.place))}</span>
          {/if}
        </span>
        <span class="stn-actions-gap"></span>
        <button
          type="button"
          class="stn-btn {pending.kind === 'trash' ? 'stn-btn-danger-go' : 'stn-btn-go'}"
          disabled={busy}
          onclick={() => void confirmPending()}
        >
          {pending.kind === "trash" ? "Trash items" : "Confirm move"}
        </button>
        <button type="button" class="stn-btn stn-btn-ghost" disabled={busy} onclick={clearPending}>
          Cancel
        </button>
      {:else}
        <span class="stn-sel-mark"></span>
        <span class="stn-sel-count">{selectedCount} selected</span>
        <span class="stn-sel-vol">{selectedCount > 0 ? volumeText(selectedVolume) : ""}</span>
        {#if showQty}
          <label class="stn-qty">
            Qty
            <input type="number" min="1" placeholder="all" bind:value={moveQty} disabled={busy} />
          </label>
        {/if}
        <span class="stn-actions-gap"></span>
        <!-- Both controls are always here and the tier displays one. A row of
             ten destination buttons is right on a wide panel and swamps a
             narrow one, where it wrapped to four lines and took half the
             height the list needed. -->
        <span class="stn-targets">
          <span class="stn-targets-label">Move to</span>
          {#each targets as target (target.label)}
            <button
              type="button"
              class="stn-btn"
              disabled={busy || selectedCount === 0}
              onclick={() => askMove(target)}
            >
              {target.label}
            </button>
          {/each}
        </span>
        <button
          type="button"
          class="stn-btn stn-target-toggle"
          disabled={busy || selectedCount === 0}
          aria-expanded={targetMenuOpen}
          onclick={() => (targetMenuOpen = !targetMenuOpen)}
        >
          Move to… ▾
        </button>
        {#if mergeable}
          <button type="button" class="stn-btn" disabled={busy} onclick={() => void mergeSelection()}>
            Merge the two stacks
          </button>
        {/if}
        <button
          type="button"
          class="stn-btn stn-btn-danger"
          disabled={busy || selectedCount === 0}
          onclick={askTrash}
        >
          Trash…
        </button>
        {#if selectedCount > 0}
          <button type="button" class="stn-btn stn-btn-ghost" disabled={busy} onclick={clearSelection}>
            Clear
          </button>
        {/if}
      {/if}
    </div>
  {/if}

  {#if targetMenuOpen && selectedCount > 0}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="stn-menu-shade" onclick={() => (targetMenuOpen = false)}></div>
    <div class="stn-menu stn-target-menu">
      <p class="stn-menu-head">Move {selectedCount} · {volumeText(selectedVolume)}</p>
      {#each targets as target (target.label)}
        <button type="button" class="stn-menu-item" disabled={busy} onclick={() => askMove(target)}>
          {target.label}
        </button>
      {/each}
    </div>
  {/if}

  <!-- The row menu. Rendered at the panel's root, never inside the scrolling
       list, so opening it cannot make the list taller. See openMenu for why it
       is absolute rather than fixed. -->
  {#if menu}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="stn-menu-shade" onclick={() => (menu = null)}></div>
    <div class="stn-menu" style="left: {menu.x}px; top: {menu.y}px">
      <p class="stn-menu-head">{nameOf(menu.row)}</p>
      {#each menu.targets as target (target.label)}
        <button
          type="button"
          class="stn-menu-item"
          disabled={busy}
          onclick={() => askMoveOne(menu!.row, menu!.place, target)}
        >
          Move to {target.label}
        </button>
      {/each}
    </div>
  {/if}
</div>
