<script lang="ts">
  // The play page's Drones window, in the client's layout: two groups - Drones in Bay (n)
  // and Drones in Space (out/max) - each a header with its command icons (the client's eveicon/control_icons), and a row per
  // drone type: its icon, "Name x n". A bay row launches on a double-click or its icon; the in-space header engages
  // what is locked and recalls; a right-click on a row or header offers every order (engage, mine, salvage, return to
  // bay, reconnect, scoop). The orders, the ownership gates and the server's own refusal lines are DronesPanel's
  // (the workspace and mobile keep that panel); this is the same flow with the client's look.
  import { DRONE_NOT_UNDER_YOUR_CONTROL, panelErrorWords } from "../bridge/refusals.ts";
  import { droneActivityColor, droneActivityLabel, droneActivityWords, DRONE_STATE_LABELS } from "../bridge/drones.ts";
  import { activeTargetID, activeTargetName } from "../play/activeTarget.ts";
  import { playUiEvent } from "../play/uiAudio.ts";
  // SE_BaseClassCore.OnMouseEnter: PlaySound(sound_hover = uiconst.SOUND_ENTRY_HOVER, ui_button_soft2_play) as an entry lights; an
  // InvItem not while the left button is down
  const hoverSound = (e: MouseEvent) => { if (!(e.buttons & 1)) void playUiEvent("ui_button_soft2_play"); };
  import { droneSettings, droneSettingsFor, droneViewIcons, droneViewModeFor, droneWindowCompact, droneWarpWarning, droneWarpWarningFor, setDroneSetting } from "./droneSettings.ts";
  import { shortcutOf } from "../play/shortcutKeys.ts";
  import { getContext, onDestroy, onMount } from "svelte";
  import type { SpaceView } from "../play/spaceView.ts";
  import { hideLabelShortcutTooltip, placePointerPanel, showDronesInSpaceTooltip, showIconValuesTooltip, showLabelShortcutTooltip, tooltipDue, panelDelay, notePanelClosed } from "../play/labelShortcutTooltip.ts";
  import { canMyShipOrderDrone } from "../space/overview.ts";
  import { miningDroneIDs, orderableDroneIDs, salvageDroneIDs } from "./droneFlight.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import { isSessionLost } from "../app/flow.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import TypeIcon from "./TypeIcon.svelte";
  import { techLevelIcon } from "../play/techLevelIcon.ts";
  import { showInfo } from "./showInfo.ts";
  import { showMarketDetails, buyMarketType } from "./marketDetails.ts";
  import { RadialMenu, RADIAL_ICON, holdToOpen, type RadialOption } from "../play/radialMenu.ts";
  import { findInPersonalAssets } from "./assetsSearch.ts";
  import { typeCompareTarget } from "./typeCompare.ts";
  import NamePopup from "./NamePopup.svelte";
  import { ContextMenu, type ContextEntry } from "../play/contextMenu.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { createSubGroup, deleteGroup, droneGroups, dronesToLaunch, groupOf, moveToGroup, removeFromGroup, setFavoriteGroupID, DRONE_DRAG_TYPE, type DroneGroup } from "./droneGroups.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { SpaceEntity } from "../store/types.ts";
  import { DRONE_TOOLTIP_ATTRIBUTES, MODULE_TOOLTIP_LABELS, droneTooltipRows, type ModuleTooltipRow } from "../play/moduleTooltip.ts";
  import { fmtDist } from "../space/overview.ts";
  import { scrollListHomeEnd } from "./scrollColumnFit.ts";
  import { noticeBoard } from "./notices.ts";

  let { store, flow, onSelect, onLock, spaceSelected = null }: {
    store: ClientStore; flow: AppFlow;
    /** What is selected in space now (stateSvc selected), whose drone entry shows selected (DroneEntry.OnStateChange). */
    spaceSelected?: number | null;
    /** stateSvc.SetState(itemID, selected): a drone in space picked in the view (the Selected Item window). */
    onSelect?: (itemID: number) => void;
    /** target.TryLockTarget: Ctrl-click on a drone in space. */
    onLock?: (itemID: number) => void;
  } = $props();
  // droneGroupHeader.UpdateLabelText: "%s (%s)" of UI/Inflight/Drone/DronesInBay, "%s (%s/%s)" of DronesInSpace, in an
  // EveLabelMedium of TextColor.HIGHLIGHT
  const HEADER_WORDS = { bay: "UI/Inflight/Drone/DronesInBay", space: "UI/Inflight/Drone/DronesInSpace" } as const;
  flow.requestWords([...Object.values(HEADER_WORDS), "/Carbon/UI/Controls/Common/NoItem", "UI/Common/EntriesCopied"]);
  const headerWords = store.words;
  const headerWord = (label: string, own: string) => { const t = $headerWords.templates[label]; return typeof t === "string" && t !== "" ? t : own; };

  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const drones = store.drones;
  // svelte-ignore state_referenced_locally
  const targeting = store.targeting;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const fleetState = store.fleet;

  /** The client's control icons (res:/ui/texture/eveicon/control_icons). */
  /** dronesConst.DRONE_STATES_TEXTURES: each state's sprite (tinted COLOR_BY_STATE, TextColor.NORMAL where none). */
  const STATE_SPRITE: Record<string, string> = {
    idle: "res:/ui/texture/eveicon/system_icons/hourglass_16px.png", fighting: "res:/ui/texture/eveicon/control_icons/engage_target_16px.png",
    mining: "res:/ui/texture/eveicon/system_icons/mining_16px.png", approaching: "res:/ui/texture/eveicon/control_icons/approach_16px.png",
    returning: "res:/ui/texture/eveicon/control_icons/recall_drones_16px.png", chasing: "res:/ui/texture/eveicon/system_icons/visibility_16px.png",
    fleeing: "res:/ui/texture/eveicon/system_icons/flag_16px.png", repairing: "res:/UI/Texture/classes/Drones/repairing_16px.png",
    salvaging: "res:/ui/texture/eveicon/control_icons/salvage_16px.png",
  };
  /** BaseDroneGroupHeader.UpdateIcon: eveicon.caret_down when expanded, caret_right when not. */
  const CARET = { open: clientTexture("res:/ui/texture/eveicon/system_icons/caret_down_16px.png"), closed: clientTexture("res:/ui/texture/eveicon/system_icons/caret_right_16px.png") };
  const ICON = {
    // ListGroup.ShowOpenState: the expander's icon, 38_16_229 open, 38_16_228 closed
    expanderOpen: clientTexture("res:/UI/Texture/Icons/38_16_229.png"),
    expanderClosed: clientTexture("res:/UI/Texture/Icons/38_16_228.png"),
    launch: clientTexture("res:/ui/texture/eveicon/control_icons/launch_drones_16px.png"),
    engage: clientTexture("res:/ui/texture/eveicon/control_icons/engage_target_16px.png"),
    recall: clientTexture("res:/ui/texture/eveicon/control_icons/recall_drones_16px.png"),
    orbit: clientTexture("res:/ui/texture/eveicon/control_icons/return_and_orbit_16px.png"),
    settings: clientTexture("res:/ui/texture/eveicon/system_icons/settings_16px.png"),
    star: clientTexture("res:/ui/texture/eveicon/system_icons/star_16px.png"),
  };
  // the client's words for the window (3698585, through gridcheck)
  const MENU_WORDS = {
    engage: ["UI/Drones/EngageTarget", "Engage Target"], mine: ["UI/Drones/MineWithDrone", "Mine"], salvage: ["UI/Drones/Salvage", "Salvage"],
    orbit: ["UI/Drones/ReturnDroneAndOrbit", "Return and Orbit"], bay: ["UI/Drones/ReturnDroneToBay", "Return to Drone Bay"],
    scoop: ["UI/Drones/ScoopDroneToBay", "Scoop to Drone Bay"], abandon: ["UI/Drones/AbandonDrone", "Abandon Drone"],
    assist: ["UI/Drones/DroneAssist", "Assist"], guard: ["UI/Drones/DroneGuard", "Guard"], watch: ["UI/Fleet/WatchList", "Watch List"],
    noValid: ["UI/Fleet/NoValidOptions", "No Valid Options"], launch: ["UI/Drones/LaunchDrones", "Launch Drones"], launchOne: ["UI/Drones/LaunchDrone", "Launch Drone"],
    info: ["UI/Commands/ShowInfo", "Show Info"], buy: ["UI/Inventory/ItemActions/BuyThisType", "Buy This Type"], buyAll: ["UI/Market/MarketQuote/BuyAll", "Buy All"], market: ["UI/Inventory/ItemActions/ViewTypesMarketDetails", "View Market Details"],
    assets: ["UI/Inventory/ItemActions/FindPersonalAssets", "Find in Personal Assets"], compare: ["UI/Compare/CompareButton", "Compare"],
    autoAttack: ["UI/Drones/AutoAttack", "Auto Attack"], focusFire: ["UI/Drones/AttackModeFocusFire", "Focus Fire"],
    autoAttackHint: ["UI/Drones/AutoAttackHint", "Should drones automatically attack if aggression is shown to you or them"],
    focusFireHint: ["UI/Drones/AttackModeFocusFireHint", "Should drones focus their efforts on a single enemy (only applicable with Auto Attack enabled)"],
  } as const;
  flow.requestWords(Object.values(MENU_WORDS).map((w) => w[0]));
  // the groups' words (dronesWindow.GroupMenu, GetSubFolderMenu, droneGroupHeader's Delete Group, ListGroup's menu)
  const GROUP_WORDS = {
    move: ["UI/Commands/MoveDrone", "Move Drone"], newGroup: ["UI/Commands/NewGroup", "New Group"], out: ["UI/Commands/OutOfThisGroup", "Out of this group"],
    del: ["UI/Commands/DeleteGroup", "Delete Group"], fav: ["UI/Drones/MarkAsFavorite", "Mark as Favorite"], unfav: ["UI/Drones/UnmarkAsFavorite", "Unmark as Favorite"],
    expand: ["UI/Common/Expand", "Expand"], collapse: ["UI/Common/Collapse", "Collapse"], caption: ["UI/Generic/TypeGroupName", "Type Group Name"],
    field: ["UI/Generic/TypeNameForGroup", "Type in name for the group"], empty: ["UI/Common/PleaseTypeSomething", "Please type something"],
    ok: ["UI/Common/Buttons/OK", "OK"], cancel: ["UI/Common/Buttons/Cancel", "Cancel"],
  } as const;
  flow.requestWords([...Object.values(GROUP_WORDS).map((w) => w[0]), "UI/Inflight/Drone/DroneGroupWithCount", ...Object.values(DRONE_STATE_LABELS)]);
  /** UI/Inflight/Drone/DroneGroupWithCount: "<group> (<count>)". */
  const groupWithCount = (groupLabel: string, count: number) => {
    const t = $headerWords.templates["UI/Inflight/Drone/DroneGroupWithCount"];
    return typeof t === "string" && t !== "" ? plainText(formatTemplate(t, { groupLabel, count }, { nameOf: () => "" })).trim() : `${groupLabel} (${count})`;
  };
  const say = (w: readonly [string, string]) => headerWord(w[0], w[1]);
  // DroneGroupHeaderInSpace's buttons: dronesUtil.LoadShortcutTooltip - the command's name and shortcut (AddLabelShortcut)
  const CMD_WORDS: Record<string, readonly [string, string]> = {
    CmdDronesEngage: ["UI/Commands/CmdDronesEngage", "All Drones: Engage"],
    CmdDronesReturnAndOrbit: ["UI/Commands/CmdDronesReturnAndOrbit", "All Drones: Return and Orbit"],
    CmdDronesReturnToBay: ["UI/Commands/CmdDronesReturnToBay", "All Drones: Return to Drone Bay"],
  };
  flow.requestWords([...Object.values(CMD_WORDS).map((w) => w[0]), "UI/Drones/HintOnFavoriteIcon"]);
  /** A label-and-shortcut tooltip on a button (TooltipPanel.AddLabelShortcut), pointed from above. */
  function shortcutTip(node: HTMLElement, tip: () => { label: string; cmd: string; lines?: readonly string[] } | null) {
    const enter = () => tooltipDue(node, () => { const t = tip(); if (t) showLabelShortcutTooltip(node, t.label, t.cmd ? shortcutOf(t.cmd) : "", t.lines ?? [], "top", "wrap"); });
    node.addEventListener("mouseenter", enter);
    node.addEventListener("mouseleave", hideLabelShortcutTooltip);
    return { destroy() { node.removeEventListener("mouseenter", enter); node.removeEventListener("mouseleave", hideLabelShortcutTooltip); hideLabelShortcutTooltip(); } };
  }
  // target.GetActiveTargetID: the drones' orders go to the active target
  const activeTarget = activeTargetID;
  const settingsNow = droneSettings;
  // DronesWindow's load: the pilot's drone settings told to the server (godma.ChangeDroneSettings)
  // The radial menu on a bay entry (DroneEntry ExpandRadialMenu -> TryExpandActionMenu, inventoryRadialMenuFunctions'
  // droneMapping): Launch Drone at the top (1), the rework ring (3, nothing offered in space), the market ring (6: View
  // Market Details, Buy This Type), Show Info (7); held 150 ms without moving 12 px, as in space
  const radial = new RadialMenu();
  let rootEl: HTMLElement | undefined = $state();
  /** DronesWindow.UpdateBottomScrollHeight: the space scroll at most the window's height less 128 (86 compact). */
  let spaceMax = $state<number | null>(null);
  $effect(() => {
    const win = rootEl?.closest<HTMLElement>(".win");
    if (!win) return;
    const compact = $windowCompact;
    const measure = () => { spaceMax = Math.max(win.offsetHeight - (compact ? 86 : 128), 0); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(win);
    return () => ro.disconnect();
  });
  /** The entry a hold last went down on (RadialMenu.clickedObject). */
  let heldEntry: HTMLElement | null = null;
  function openBayRadial(itemID: number, x: number, y: number): void {
    const row = bayRows.find((r) => r.itemID === itemID);
    if (!row) return;
    const ids = pickedFor("bay", row.itemID, row.typeID, true);
    const icon = (path: string) => RADIAL_ICON(path);
    const options: (RadialOption | null)[] = [
      { label: plainText(formatTemplate(say(MENU_WORDS.launchOne), { numDrones: 1 }, { nameOf: () => "" })), icon: icon("res:/UI/Texture/Icons/44_32_2.png"), run: () => void run(() => flow.launchDrones(ids)) },
      null, null, null, null,
      { label: "Market", icon: icon("res:/UI/Texture/classes/RadialMenuActions/market.png"), more: [
        { label: say(MENU_WORDS.market), icon: icon("res:/UI/Texture/classes/RadialMenuActions/viewMarketDetails.png"), run: () => showMarketDetails(row.typeID) },
        { label: say(MENU_WORDS.buy), icon: icon("res:/UI/Texture/classes/RadialMenuActions/buyThisType.png"), run: () => buyMarketType(row.typeID) },
      ] },
      { label: say(MENU_WORDS.info), icon: icon("res:/UI/Texture/Icons/44_32_24.png"), run: () => showInfo({ kind: "type", typeID: row.typeID, itemID: row.itemID }) },
      null,
    ];
    tipOff();
    // DroneEntry (a Generic): ShowRadialMenuIndicator's Fill (1, 1, 1, 0.25) behind the entry while its radial is open
    const marked = heldEntry;
    marked?.classList.add("radial-marked-entry");
    radial.open(x, y, row.label, options, 0, () => marked?.classList.remove("radial-marked-entry"));
  }
  /**
   * A section header's radial (dronesUtil.ExpandRadialMenuForInBayGroup / InSpaceGroup: TryExpandActionMenu with no item
   * and manyItemsData): the type's own layout, each slot live only where the merged menu offers its entry. In the bay
   * (the first drone's type, droneMapping): Launch Drone, the market ring's View Market Details (Buy This Type is Buy All
   * on several, so not offered), Show Info on one drone only. In space (the first drone not mining / salvage /
   * unanchoring, else the first): its order at the top, the general slots greyed (no one object to orbit or lock), the
   * more ring's Return and Orbit and Return to Drone Bay live, the rest greyed.
   */
  /** A hold that opened a header's radial: the click its release makes does not fold the section. */
  let headHeld = false;
  function openHeaderRadial(where: "bay" | "space", x: number, y: number): void {
    const icon = (path: string) => RADIAL_ICON(path);
    const g = (n: number) => icon(`res:/UI/Texture/Icons/44_32_${n}.png`);
    if (where === "bay") {
      const items = bayRows.flatMap((r) => r.itemIDs.map((itemID) => ({ itemID, typeID: r.typeID })));
      if (!items.length) return;
      const ids = items.map((i) => i.itemID), first = items[0]!;
      const one = ids.length === 1;
      radial.open(x, y, `${headerWord(HEADER_WORDS.bay, "Drones in Bay")} (${bayCount})`, [
        { label: plainText(formatTemplate(say(MENU_WORDS.launchOne), { numDrones: 1 }, { nameOf: () => "" })), icon: g(2), run: () => void run(() => flow.launchDrones(ids)) },
        null, null, null, null,
        { label: "Market", icon: icon("res:/UI/Texture/classes/RadialMenuActions/market.png"), more: [
          { label: say(MENU_WORDS.market), icon: icon("res:/UI/Texture/classes/RadialMenuActions/viewMarketDetails.png"), run: () => showMarketDetails(first.typeID) },
          { label: say(MENU_WORDS.buy), icon: icon("res:/UI/Texture/classes/RadialMenuActions/buyThisType.png"), disabled: !one, run: () => buyMarketType(first.typeID) },
        ] },
        { label: say(MENU_WORDS.info), icon: g(24), disabled: !one, run: () => showInfo({ kind: "type", typeID: first.typeID, itemID: first.itemID }) },
        null,
      ], 0);
      return;
    }
    const ids = allDroneIDs;
    if (!ids.length) return;
    const out = ($drones.inSpace ?? []).filter((d) => ids.includes(d.itemID));
    const low = (id: number) => miningIDs.includes(id) || salvageIDs.includes(id);
    const lead = out.find((d) => !low(d.itemID)) ?? out[0];
    const leadID = lead?.itemID ?? ids[0]!;
    const primary = miningIDs.includes(leadID) ? { label: say(MENU_WORDS.mine), icon: g(5) } : salvageIDs.includes(leadID) ? { label: say(MENU_WORDS.salvage), icon: g(4) } : { label: say(MENU_WORDS.engage), icon: g(11) };
    radial.open(x, y, `${headerWord(HEADER_WORDS.space, "Drones in Space")} (${maxActive === null ? outCount : `${outCount}/${maxActive}`})`, [
      { ...primary, run: () => void run(() => primaryAction(ids)) },
      { label: "Orbit", icon: g(21), disabled: true },
      { label: "More", icon: "", more: [
        { label: "Look At", icon: g(20), disabled: true },
        { label: "Set Interest", icon: icon("res:/UI/Texture/classes/RadialMenuActions/setInterest.png"), disabled: true },
        { label: say(MENU_WORDS.orbit), icon: g(3), run: () => void run(() => flow.returnDronesAndOrbit(ids)) },
        { label: "Scoop to Cargo Hold", icon: icon("res:/UI/Texture/Icons/scoopcargo.png"), disabled: true },
        { label: say(MENU_WORDS.bay), icon: g(1), run: () => void run(() => flow.recallDrones(ids)) },
        null,
        { label: say(MENU_WORDS.scoop), icon: icon("res:/UI/Texture/classes/RadialMenuActions/scoopDrone.png"), disabled: true },
      ] },
      { label: "Keep at Range", icon: g(22), disabled: true },
      { label: "Lock Target", icon: g(17), disabled: true },
      { label: "Approach", icon: g(23), disabled: true },
      { label: say(MENU_WORDS.info), icon: g(24), disabled: true },
      { label: "Warp To Within", icon: g(18), disabled: true },
    ], 0);
  }
  onMount(() => {
    const offHead = rootEl ? holdToOpen(rootEl, (_x, _y, e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-drone-head]");
      return !el || (e.target as HTMLElement).closest("button") ? null : el.dataset.droneHead === "bay" ? 1 : 2;
    }, (id, x, y) => { tipOff(); headHeld = true; openHeaderRadial(id === 1 ? "bay" : "space", x, y); }, false) : () => {};
    return () => offHead();
  });
  // navigation.OnDragEnter (bay drones over space): droneSignals.on_in_space_entry_drag_enter -> the space header's
  // ShowDragHighlight until the drag leaves (OnGlobalDragExit); navigation.OnDropData -> on_drones_dropped_in_space -> Blink
  onMount(() => {
    const enter = () => { if (dragging?.section === "bay") dropOn = "space"; };
    const dropped = () => { dropOn = null; blinkHead("space"); };
    // the drag over wherever it ended (UI_DRAGEXIT): HideDragHighlight
    const ended = () => { dragging = null; dropOn = null; };
    addEventListener("dragend", ended);
    addEventListener("evejs:drones-space-drag-enter", enter);
    addEventListener("evejs:drones-dropped-in-space", dropped);
    return () => { removeEventListener("evejs:drones-space-drag-enter", enter); removeEventListener("evejs:drones-dropped-in-space", dropped); removeEventListener("dragend", ended); };
  });
  onMount(() => {
    document.body.appendChild(radial.root);
    radial.root.style.zIndex = "100000";
    // a bay entry its inventory radial; an in-space entry (a negative id here) the drone's own space radial
    const off = rootEl ? holdToOpen(rootEl, (_x, _y, e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-bay-item], [data-space-item]");
      heldEntry = el;
      return !el ? null : el.dataset.bayItem ? Number(el.dataset.bayItem) : -Number(el.dataset.spaceItem);
    }, (id, x, y) => {
      if (id > 0) openBayRadial(id, x, y);
      else { tipOff(); dispatchEvent(new CustomEvent("evejs:open-space-radial", { detail: { itemID: -id, x, y, entry: heldEntry } })); }
    }, false) : () => {};
    return () => { off(); radial.close(); radial.root.remove(); };
  });
  onMount(() => {
    const characterID = store.character.get().selectedCharacterID;
    if (characterID !== null) void flow.changeDroneSettings(droneSettingsFor(characterID)).catch(() => {});
  });
  function toggleSetting(name: "aggressive" | "focusFire"): void {
    const characterID = store.character.get().selectedCharacterID;
    if (characterID === null) return;
    const now = setDroneSetting(characterID, name, !droneSettingsFor(characterID)[name]);
    void run(() => flow.changeDroneSettings(now));
  }
  function openSettingsMenu(x: number, y: number): void {
    const now = droneSettingsFor(store.character.get().selectedCharacterID ?? 0);
    void playUiEvent("ui_expand_play");
    ctxMenu.open(x + 10, y, ([["aggressive", MENU_WORDS.autoAttack, MENU_WORDS.autoAttackHint], ["focusFire", MENU_WORDS.focusFire, MENU_WORDS.focusFireHint]] as const)
      .map(([name, label, hint]) => ({ label: say(label), hint: say(hint), checkbox: true, checked: now[name], run: () => toggleSetting(name) })));
  }

  const snapshot = $derived($space.snapshot);

  /**
   * DronesWindow.UpdateWarpWarning (WarpWarning): while the ship lines up for a warp (michelle.IsPreparingWarp: the
   * ball in warp mode, its effectStamp below 0) with drones out (AreDronesOut), the orange warning with its message
   * and Stop and Recall (stop_and_recall_drones: CmdStopShip, then every drone in local space to the bay); the
   * setting off, never.
   */
  const warpWarningOn = droneWarpWarning;
  const character = store.character;
  $effect(() => { const id = $character.selectedCharacterID; if (id !== null) { droneWarpWarningFor(id); droneViewModeFor(id); } });
  // the view mode (IsIconsViewMode): a drone in space with its icon (Icons) or without (List)
  const viewIcons = droneViewIcons;
  const windowCompact = droneWindowCompact;
  flow.requestWords(["UI/Drones/WarpWarningMessage", "UI/Drones/StopAndRecall"]);
  // dronesUtil.GetDronesInLocalSpace: michelle's drone states only (owned, or controlled by the ship); a drone nobody
  // controls has no state row and is not in the window (reconnected from the ship's menu, scooped from space)
  const localDrones = $derived(($drones.inSpace ?? []).filter((d) => d.orphaned !== true));
  const warpWarningShown = $derived($warpWarningOn && snapshot?.ship?.warp?.preparing === true && localDrones.length > 0);
  // WarpWarning.FadeIn: the audio service sounds ui_warning_abandoning_drones each time the warning comes up
  let warpWarningWas = false;
  $effect(() => {
    const now = warpWarningShown;
    if (now && !warpWarningWas) void playUiEvent("ui_warning_abandoning_drones");
    warpWarningWas = now;
  });
  function stopAndRecall(): void {
    const ids = ($drones.inSpace ?? []).map((d) => d.itemID);
    void run(async () => { await flow.stopShip(); if (ids.length) await flow.recallDrones(ids); });
  }

  /**
   * DroneTooltip (droneTooltip.py, a ModuleButtonTooltip on DroneEntry): the type's icon and name in bold, under it
   * GetDroneStateDescription - the state word in its colour and, mining or fighting, what on (the pilot's name for a
   * ship, else the thing's name) - then for a mining drone AddMiningDroneInfo (its miningAmount and duration with the
   * pilot's skills applied, flow.droneAttribute) and AddDroneBandwidthUsed (the attribute's icon, its name and value).
   */
  let tip = $state<{ typeID: number; name: string; state: string | null; color: string | null; targetID: number | null; anchor: DOMRect } | null>(null);
  // DroneEntry.GetTooltipPointer is POINT_RIGHT_2 (read through gridcheck): the panel to the row's left, falling back
  // by pointerPanel.UpdatePanelPosition where the desktop's edge cuts it
  let tipEl = $state<HTMLDivElement | null>(null);
  $effect(() => {
    const el = tipEl, anchor = tip?.anchor;
    if (!el || !anchor) return;
    // (placed again as its lines come in: the panel is centred on its pointer)
    const place = () => placePointerPanel(el, anchor, "RIGHT_2");
    place();
    const seen = new ResizeObserver(place);
    seen.observe(el);
    return () => seen.disconnect();
  });
  let tipTimer: ReturnType<typeof setTimeout> | null = null;
  const bandwidth = new Map<number, number | null>();
  const groupOfType = new Map<number, number | null>();
  const tipWord = (label: string, args: Readonly<Record<string, unknown>>): string | null => {
    const t = $headerWords.templates[label];
    return typeof t === "string" && t !== "" ? plainText(formatTemplate(t, args as never, { nameOf: () => null } as never)) : null;
  };
  flow.requestWords([...MODULE_TOOLTIP_LABELS, "UI/Generic/Unknown"]);
  let bandwidthVersion = $state(0);
  function tipFor(typeID: number, state: string | null, color: string | null, targetID: number | null, e: MouseEvent): void {
    if (tipTimer) clearTimeout(tipTimer);
    const el = e.currentTarget as HTMLElement;
    // DroneEntry's DroneTooltipWrapper has no GetTooltipDelay: the generic delay, the renew time while one shows or just closed
    const wait = panelDelay(tip !== null);
    tipTimer = setTimeout(() => {
      const r = el.getBoundingClientRect();
      const t = targetID ? snapshot?.entities.find((x) => x.itemID === targetID) ?? null : null;
      if (t?.typeID) flow.requestNames([{ kind: "type", id: t.typeID }]);
      if (t?.characterID) flow.requestNames([{ kind: "owner", id: t.characterID }]);
      tip = { typeID, name: typeName(typeID, ""), state, color, targetID, anchor: r };
      // the mining row's attributes may wait on a reckoning of the ship: read again shortly
      if (flow.droneTooltipFigures(typeID) === null) setTimeout(() => bandwidthVersion++, 1500);
      if (!bandwidth.has(typeID)) {
        bandwidth.set(typeID, null);
        void flow.typeDogmaFacts(typeID).then((f) => { bandwidth.set(typeID, f?.attributes.find((a) => a[0] === 1272)?.[1] ?? null); groupOfType.set(typeID, f?.groupID ?? null); bandwidthVersion++; }).catch(() => {});
      }
      if (!attributeLooks.size) {
        void flow.attributeDisplay(DRONE_TOOLTIP_ATTRIBUTES).then((m) => {
          const looks = new Map<number, { icon: string | null; nameID: number | null }>();
          for (const id of DRONE_TOOLTIP_ATTRIBUTES) {
            const d = m?.get(id);
            looks.set(id, { icon: d?.iconFile ? `/client-res/${d.iconFile.replace(/^res:\//i, "").toLowerCase()}` : null, nameID: d?.displayNameID ?? null });
          }
          flow.requestWords([...looks.values()].flatMap((l) => (l.nameID ? [`#${l.nameID}`] : [])));
          attributeLooks = looks;
        }).catch(() => {});
      }
    }, wait);
  }
  function tipOff(): void { if (tipTimer) clearTimeout(tipTimer); tipTimer = null; if (tip !== null) notePanelClosed(); tip = null; }
  /** GetDroneStateDescription's target: the pilot's name for a ship, else the thing's (GetSlimItemName), Unknown where neither. */
  const tipTarget = $derived.by(() => {
    if (!tip?.targetID) return null;
    const t = snapshot?.entities.find((x) => x.itemID === tip!.targetID) ?? null;
    if (!t) return headerWord("UI/Generic/Unknown", "Unknown");
    return (t.characterID ? resolvedName($names.resolved, "owner", t.characterID, "") : "") || t.name || typeName(t.typeID, "") || headerWord("UI/Generic/Unknown", "Unknown");
  });
  /** The tooltip's attributes' icons and names (dogma_data.get_attribute_icon_id, get_attribute_display_name). */
  let attributeLooks = $state<ReadonlyMap<number, { icon: string | null; nameID: number | null }>>(new Map());
  const attributeName = (id: number): string | null => {
    const nameID = attributeLooks.get(id)?.nameID;
    const t = nameID ? $headerWords.templates[`#${nameID}`] : null;
    return typeof t === "string" && t !== "" ? plainText(t) : null;
  };
  /** The rows under the type row (droneTooltipRows): range, damage, the group's own, tracking. */
  const tipRows = $derived.by((): readonly ModuleTooltipRow[] => {
    void bandwidthVersion;
    if (!tip) return [];
    const figures = flow.droneTooltipFigures(tip.typeID);
    if (!figures) return [];
    return droneTooltipRows({
      groupID: groupOfType.get(tip.typeID) ?? null,
      attr: (id) => figures.attr(id),
      rangeAttributeID: figures.rangeAttributeID,
      dps: figures.dps,
      attributeIcon: (id) => attributeLooks.get(id)?.icon ?? null,
      attributeName,
    }, tipWord, (m) => fmtDist(m));
  });
  /** AddDroneBandwidthUsed: the attribute's display name and its value in its unit. */
  const bandwidthText = $derived.by(() => {
    void bandwidthVersion;
    const v = tip ? bandwidth.get(tip.typeID) : null;
    if (v == null) return null;
    return `${attributeName(1272) ?? "Bandwidth Needed"} ${Number.isInteger(v) ? v : v.toFixed(1)} Mbit/sec`;
  });
  const ship = $derived(snapshot?.ship ?? null);
  const autoTargetID = $derived($activeTarget ?? 0);
  const typeName = (typeID: number | null, fallback: string) => resolvedName($names.resolved, "type", typeID, fallback);

  /**
   * The bay, a row a stack (dronesWindow.GetMainGroupEntriesInBay: GetBayDroneEntry per inventory item, sorted by
   * label); a stack's label "Mining Drone I (2)" (DroneBayEntryWithStacksize), one drone its name.
   */
  const bayRows = $derived.by(() => ($drones.bay ?? []).map((stack) => ({
    typeID: stack.typeID, itemID: stack.itemID, label: typeName(stack.typeID, "Unknown drone"),
    // (a quantity of -1 is a singleton: one assembled drone, as invItem quantity says it)
    quantity: stack.quantity < 0 ? 1 : stack.quantity, itemIDs: [stack.itemID],
  })).sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase())));
  /** The bay drones' damage (InBayDroneDamageTracker), asked once for each drone not yet known. */
  let bayDamage = $state(new Map<number, readonly [number, number, number]>());
  const asked = new Set<number>();
  // (one not answered - an ask made as the session starts can fail - asked again 5 s on; the client's tracker has it
  // from dogma at hand)
  let askAgain = $state(0);
  $effect(() => {
    void askAgain;
    const missing = bayRows.map((r) => r.itemID).filter((id) => !asked.has(id));
    if (!missing.length) return;
    for (const id of missing) asked.add(id);
    const retry = (ids: readonly number[]) => {
      if (!ids.length) return;
      setTimeout(() => { for (const id of ids) asked.delete(id); askAgain += 1; }, 5000);
    };
    void flow.bayDroneDamage(missing)
      .then((got) => { if (got.size) bayDamage = new Map([...bayDamage, ...got]); retry(missing.filter((id) => !got.has(id))); })
      .catch(() => retry(missing));
  });
  const bayCount = $derived(bayRows.reduce((n, r) => n + r.quantity, 0));
  /** A drone's inventory group (the groups' droneGroupID), by its group's name. */
  const droneGroupOf = (typeID: number | null) => resolvedName($names.resolved, "typeGroup", typeID, "");
  /**
   * GetMainGroupEntriesInBay / InSpace and AppendSubGroups: the drones in no group as entries (sorted by label), then a
   * header per group that has drones here (sorted by label), its drones under it at sublevel 1.
   */
  function split<R extends { itemIDs: number[]; label: string }>(rows: readonly R[], count: (r: R) => number) {
    const groups = $droneGroups.groups;
    const loose: R[] = [];
    const byGroup = new Map<string, { group: DroneGroup; rows: R[] }>();
    for (const r of rows) {
      const g = groupOf(groups, r.itemIDs[0]!);
      if (!g) { loose.push(r); continue; }
      const e = byGroup.get(g.label) ?? { group: g, rows: [] };
      e.rows.push(r);
      byGroup.set(g.label, e);
    }
    const heads = [...byGroup.values()].map((e) => ({ ...e, ids: e.rows.flatMap((r) => r.itemIDs), count: e.rows.reduce((n, r) => n + count(r), 0) }))
      .sort((a, b) => a.group.label.toLowerCase().localeCompare(b.group.label.toLowerCase()));
    return { loose, heads };
  }
  const bayList = $derived(split(bayRows, (r) => r.quantity));
  const shipTypeID = $derived(ship?.typeID ?? null);
  const favoriteID = $derived($droneGroups.favorites[`evejs.ui.drones_favoriteGroupID_${shipTypeID ?? "None"}`] ?? null);
  /** Groups shown open (ListGroup's open state; closed by default). */
  // ListGroup open state (uicore.registry.GetListGroupOpenState / SetListGroupOpenState): each drone group's, by its
  // drone state and group (the node id (state, groupID)), kept, closed where none is kept
  const OPEN_GROUPS_KEY = "evejs.ui.listgroups.dronegroups";
  let openGroups = $state(new Set<string>((() => { try { const v = JSON.parse(globalThis.localStorage?.getItem(OPEN_GROUPS_KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } })()));
  const toggleGroup = (key: string) => {
    // SE_ListGroupCore.Toggle: SOUND_EXPAND opening, SOUND_COLLAPSE closing
    const s = new Set(openGroups); if (s.has(key)) s.delete(key); else s.add(key); openGroups = s;
    void playUiEvent(s.has(key) ? "ui_expand_play" : "ui_collapse_play");
    try { globalThis.localStorage?.setItem(OPEN_GROUPS_KEY, JSON.stringify([...s])); } catch { /* this visit */ }
  };
  /**
   * The two lists' selections (topScroll and bottomScroll, multiSelect): a click selects the entry alone, Ctrl a toggle,
   * Shift the run from the last one clicked, Ctrl+Shift that run added (scroll.SelectNode); entries in the order shown.
   */
  type Section = "bay" | "space";
  let selected = $state<Record<Section, number[]>>({ bay: [], space: [] });
  const lastClicked: Record<Section, number | null> = { bay: null, space: null };
  const shownOrder = (section: Section): number[] => {
    const list = section === "bay" ? bayList : spaceList;
    return [...list.loose.flatMap((r) => r.itemIDs), ...list.heads.flatMap((h) => (openGroups.has(`${section}:${h.group.id}`) ? h.ids : []))];
  };
  function clickEntry(section: Section, id: number, e: MouseEvent): void {
    (e.currentTarget as HTMLElement).closest<HTMLElement>(".group")?.focus({ preventScroll: true });
    const order = shownOrder(section);
    const now = selected[section];
    const last = lastClicked[section];
    const span = () => { const [a, b] = [order.indexOf(last!), order.indexOf(id)].sort((x, y) => x - y); return order.slice(a!, b! + 1); };
    let next: number[];
    if (e.ctrlKey && !e.shiftKey) next = now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
    else if (e.shiftKey && last !== null && last !== id && order.includes(last)) next = e.ctrlKey ? [...new Set([...now, ...span()])] : span();
    else next = [id];
    selected = { ...selected, [section]: next };
    if (!e.shiftKey) lastClicked[section] = id;
    // DroneEntry.OnClick: no modifier, the drone selected in space; Ctrl, TryLockTarget on it
    if (section === "space" && !e.shiftKey) { if (e.ctrlKey) onLock?.(id); else onSelect?.(id); }
  }
  /**
   * The keys of the focused list (commandSvc to the focused scroll): Ctrl+A SelectAll - every entry shown, not the
   * groups (ListGroups are not selectable); the arrows Scroll.OnUp / OnDown (BrowseNodes over the list's nodes - the
   * groups and the open groups' entries - nothing selected the last / first, else past the selection, Shift growing the
   * range from the last clicked; landing on a group leaves nothing selected); ActivateIdx is SelectNode only, no click, so
   * nothing selected in space; Home / End ScrollToProportion.
   */
  function listKey(section: Section, e: KeyboardEvent): void {
    const list = e.currentTarget as HTMLElement;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); e.stopPropagation(); selected = { ...selected, [section]: shownOrder(section) }; return; }
    // Scroll.Copy (Ctrl+C): a DroneEntry is a Generic, its GetCopyData its label - in the bay the type's name, a stack
    // DroneBayEntryWithStacksize ("Mining Drone I (2)"), in space the type's name; a group (a ListGroup) its label,
    // DroneGroupWithCount - the selected entries (groups are not selectable), every node where none is (the groups and the
    // open groups' entries, in order), one a line, then UI/Common/EntriesCopied
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      e.preventDefault(); e.stopPropagation();
      const attr = section === "bay" ? "bayItem" : "spaceItem";
      const nodes = [...list.querySelectorAll<HTMLElement>(`.row.grouphead, .row[data-${section}-item]`)];
      const chosen = nodes.filter((el) => el.dataset[attr] !== undefined && selected[section].includes(Number(el.dataset[attr])));
      const pick = chosen.length ? chosen : nodes;
      const labelOf = (el: HTMLElement) => {
        if (el.dataset[attr] === undefined) return el.querySelector(".name")?.textContent?.trim() || null;
        const id = Number(el.dataset[attr]);
        if (section === "space") return spaceRows.find((x) => x.itemIDs[0] === id)?.label ?? null;
        const row = bayRows.find((x) => x.itemID === id);
        return row ? (row.quantity > 1 ? `${row.label} (${row.quantity})` : row.label) : null;
      };
      const lines = pick.map(labelOf).filter((x): x is string => !!x);
      if (!lines.length) return;
      void navigator.clipboard.writeText(lines.join("\n")).then(() => {
        const t = $headerWords?.templates["UI/Common/EntriesCopied"];
        noticeBoard.post({ kind: "info", title: typeof t === "string" && t ? plainText(formatTemplate(t, { numEntries: lines.length }, { nameOf: () => "" })) : `Copied ${lines.length} entries to clipboard` });
      }).catch(() => {});
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Home" || e.key === "End") { e.preventDefault(); e.stopPropagation(); scrollListHomeEnd(list, e.key === "End"); return; }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault(); e.stopPropagation();
    const attr = section === "bay" ? "bayItem" : "spaceItem";
    const nodes = [...list.querySelectorAll<HTMLElement>(`.row.grouphead, .row[data-${section}-item]`)];
    const idOf = (el: HTMLElement | undefined) => (el?.dataset[attr] !== undefined ? Number(el.dataset[attr]) : null);
    if (!nodes.length) return;
    const up = e.key === "ArrowUp";
    const now = selected[section];
    const sel = nodes.map((el, i) => (now.includes(idOf(el) ?? NaN) ? i : -1)).filter((i) => i >= 0);
    const lastAt = lastClicked[section] === null ? -1 : nodes.findIndex((el) => idOf(el) === lastClicked[section]);
    let idx: number;
    if (!sel.length) idx = up ? nodes.length - 1 : 0;
    else if (e.shiftKey && lastAt >= 0) idx = (sel[0]! < lastAt ? sel[0]! : sel[sel.length - 1]!) + (up ? -1 : 1);
    else idx = (sel.length > 1 ? sel[up ? 0 : sel.length - 1]! : sel[0]!) + (up ? -1 : 1);
    if (idx < 0 || idx >= nodes.length) return;
    const id = idOf(nodes[idx]);
    if (e.shiftKey && sel.length && lastAt >= 0) {
      selected = { ...selected, [section]: nodes.slice(Math.min(lastAt, idx), Math.max(lastAt, idx) + 1).map(idOf).filter((x): x is number => x !== null) };
    } else {
      selected = { ...selected, [section]: id === null ? [] : [id] };
      lastClicked[section] = id;
    }
    nodes[idx]!.scrollIntoView({ block: "nearest" });
  }
  /**
   * DroneEntry.GetSelected: the entries selected that are of the clicked one's drone group (where the clicked one is
   * among them; else the clicked one alone, selected now as the scroll does on the right-click).
   */
  function pickedFor(section: Section, id: number, typeID: number | null, sameGroup: boolean): number[] {
    if (!selected[section].includes(id)) { selected = { ...selected, [section]: [id] }; return [id]; }
    if (!sameGroup) return [...selected[section]];
    const kind = droneGroupOf(typeID);
    const typeOf = (x: number) => section === "bay" ? bayRows.find((r) => r.itemID === x)?.typeID ?? null : spaceRows.find((r) => r.itemIDs[0] === x)?.typeID ?? null;
    return selected[section].filter((x) => droneGroupOf(typeOf(x)) === kind);
  }
  // DroneEntry.OnStateChange(selected): the entry of the object deselected in space deselects, the newly selected one's selects
  let lastSpaceSelected: number | null = null;
  $effect(() => {
    const now = spaceSelected;
    if (now === lastSpaceSelected) return;
    const prev = lastSpaceSelected;
    lastSpaceSelected = now;
    const ids = selected.space.filter((x) => x !== prev);
    const shown = ($drones.inSpace ?? []).some((d) => d.itemID === now);
    selected = { ...selected, space: now !== null && shown && !ids.includes(now) ? [...ids, now] : ids };
  });
  /** DronesDragData: the drones dragged (the selection where the dragged entry is in it), where from, and their type. */
  let dragging: { section: Section; ids: number[]; typeID: number | null } | null = null;
  function dragStart(section: Section, id: number, typeID: number | null, e: DragEvent): void {
    dragging = { section, ids: selected[section].includes(id) ? [...selected[section]] : [id], typeID };
    e.dataTransfer?.setData("text/plain", dragging.ids.join(","));
    e.dataTransfer?.setData(DRONE_DRAG_TYPE, JSON.stringify({ section, ids: dragging.ids }));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }
  /**
   * The drops: in-space drones onto the bay's part go home (dronesWindow / DroneGroupHeaderInBay.OnDropData:
   * ReturnToDroneBay), bay drones onto the space part launch (DroneGroupHeaderInSpace: LaunchDrones), and drones onto a
   * group of their own part join it (DroneSubGroup._MoveToGroup).
   */
  let dropOn = $state<string | null>(null);
  function drop(section: Section, group: string | null, e: DragEvent): void {
    e.preventDefault();
    e.stopPropagation();
    dropOn = null;
    const d = dragging;
    dragging = null;
    if (!d) return;
    // DroneInBayEntry.OnDropData returns them home without on_drones_dropped_to_bay; the part, its header and its
    // sub-groups send it (Blink)
    if (d.section === "space" && section === "bay") { void run(() => flow.recallDrones(d.ids)); if (!(e.target as HTMLElement | null)?.closest?.("[data-bay-item]")) blinkHead("bay"); return; }
    if (d.section === "bay" && section === "space") { void run(() => flow.launchDrones(d.ids)); blinkHead("space"); return; }
    if (group && !moveToGroup(droneGroupOf(d.typeID), group, d.ids)) flow.sayDialog("CannotMixDrones", null, "You cannot mix drones of different types in the same group.");
  }
  /**
   * BaseDroneGroupHeader.Blink (droneSignals.on_drones_dropped_to_bay / on_drones_dropped_in_space): the header's
   * blinkUnderlay, a white Fill with glow, opacity 0.25 -> 0 (and its glow 1 -> 0) over 0.6 s, ANIM_SMOOTH
   */
  function blinkHead(which: "bay" | "space"): void {
    rootEl?.querySelector<HTMLElement>(`[data-drone-head="${which}"]`)?.animate(
      [{ boxShadow: "inset 0 0 0 999px rgba(255, 255, 255, 0.25)" }, { boxShadow: "inset 0 0 0 999px rgba(255, 255, 255, 0)" }],
      { duration: 600, easing: "cubic-bezier(0.3333, 0, 0.6667, 1)" });
  }
  // a part's header lights only for the other part's drones (on_in_bay_entry_drag_enter / on_in_space_entry_drag_enter
  // come from HasInSpaceDroneIDs / HasInBayDroneIDs)
  const dragOver = (key: string) => (e: DragEvent) => {
    if (!dragging) return;
    e.preventDefault();
    dropOn = (key === "bay" || key === "space") && dragging.section === key ? null : key;
  };
  // DroneSubGroupInBay / InSpace.OnDragEnter: drones of the other part over a group light that part's header
  // (on_in_bay_entry_drag_enter / on_in_space_entry_drag_enter -> ShowDragHighlight), its own part's the group
  // ... and its own part's drones not all in the group already its icon (ShowIconGlow - the favourite's star, the only
  // icon a sub-group shows)
  const groupDragOver = (key: string, inSpace: boolean, ids: number[]) => (e: DragEvent) => {
    if (!dragging) return;
    e.preventDefault();
    // the group's own OnDragEnter, not its part's as well
    e.stopPropagation();
    dropOn = (dragging.section === "space") !== inSpace ? (inSpace ? "space" : "bay") : dragging.ids.some((id) => !ids.includes(id)) ? key : null;
  };
  /** New Group's name popup: for which drones (CreateSubGroup asks NamePopup first). */
  let naming = $state<{ droneGroupID: string; ids: number[] } | null>(null);
  /**
   * dronesWindow.GroupMenu: Move Drone - New Group, Out of this group where it is in one, then every group by name
   * (MoveToGroup; CannotMixDrones where the group holds drones of another drone group).
   */
  function moveMenu(ids: number[], typeID: number | null): MenuEntry {
    const droneGroupID = droneGroupOf(typeID);
    const groups = $droneGroups.groups;
    const inGroup = ids.filter((id) => groupOf(groups, id));
    const names = Object.keys(groups).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return { label: say(GROUP_WORDS.move), sub: [
      { label: say(GROUP_WORDS.newGroup), act: async () => { naming = { droneGroupID, ids }; } },
      ...(inGroup.length ? [{ label: say(GROUP_WORDS.out), act: async () => removeFromGroup(inGroup) }] : []),
      ...names.map((name) => ({ label: name, act: async () => {
        if (!moveToGroup(droneGroupID, name, ids)) flow.sayDialog("CannotMixDrones", null, "You cannot mix drones of different types in the same group.");
      } })),
    ] };
  }
  /** GetDeleteGroupMenuEntry: Delete Group with every group, where there are groups. */
  /**
   * DroneGroupHeaderInBay / InSpace.GetMenu: [None], Delete Group, then the bay's drones' InvItemMenu without its market
   * entries (or the space's DroneMenu) - shown sorted, Delete Group (RAGEQUITGROUP) after the rest, Abandon Drone too.
   */
  const headerMenu = (entries: MenuEntry[]): MenuEntry[] => { const del = deleteMenu(); return del.length ? (entries.length ? [...entries, SEP, ...del] : del) : entries; };
  const deleteMenu = (): MenuEntry[] => {
    const names = Object.keys($droneGroups.groups);
    return names.length ? [{ label: say(GROUP_WORDS.del), sub: names.map((name) => ({ label: name, act: async () => deleteGroup(name) })) }] : [];
  };
  /**
   * A group header's menu (ListGroup.GetMenu, its node locked and BlockOpenWindow): Expand / Collapse, then
   * dronesWindow.GetSubFolderMenu - a line, the drones' menu (in space DroneMenu, in the bay InvItemMenu without its
   * market entries), Mark / Unmark as Favorite - shown sorted (bay: Launch Drone | Show Info | Expand | Find in Personal
   * Assets | Compare, Mark Group as Favorite for Launching).
   */
  function groupMenu(key: string, group: DroneGroup, ids: number[], inSpace: boolean): MenuEntry[] {
    const favorite = favoriteID === group.id;
    const bayItems = inSpace ? [] : ids.flatMap((itemID) => { const row = bayRows.find((r) => r.itemIDs.includes(itemID)); return row ? [{ itemID, typeID: row.typeID }] : []; });
    // menuDataFactory sorts them by menuHierarchy (Expand and the favourite entry have no group)
    const folder = {
      expand: { label: say(openGroups.has(key) ? GROUP_WORDS.collapse : GROUP_WORDS.expand), act: async () => toggleGroup(key) },
      favorite: { label: say(favorite ? GROUP_WORDS.unfav : GROUP_WORDS.fav), act: async () => setFavoriteGroupID(shipTypeID, favorite ? null : group.id) },
    };
    return inSpace ? spaceEntries(ids.filter((id) => allDroneIDs.includes(id)), false, folder) : bayItemsMenu(bayItems, false, true, folder);
  }

  /**
   * Drones in space, one entry each (dronesWindow's in-space entries, a drone a row): "<name> <state>" with the state
   * in its colour (droneEntry.UpdateState, dronesConst.DRONE_STATES and COLOR_BY_STATE), the ones ours to fly told apart.
   */
  const spaceRows = $derived.by(() => {
    const byID = new Map<number, SpaceEntity>();
    for (const entity of snapshot?.entities ?? []) byID.set(entity.itemID, entity);
    return localDrones.map((drone) => {
      const orderable = canMyShipOrderDrone(byID.get(drone.itemID) ?? null, ship?.itemID ?? null);
      const lost = drone.controlled === false || orderable === false;
      return {
        key: String(drone.itemID), typeID: drone.typeID, label: typeName(drone.typeID, "Drone"),
        activity: droneActivityWords(drone.activity, $headerWords?.templates), color: droneActivityColor(drone.activity), itemIDs: [drone.itemID],
        unavailable: lost ? DRONE_NOT_UNDER_YOUR_CONTROL : null, recoverable: drone.controlled === false,
        damage: layersOf(byID.get(drone.itemID) ?? null),
        sprite: drone.activity ? STATE_SPRITE[drone.activity] ?? null : null,
        targetID: drone.activity === "mining" || drone.activity === "fighting" || drone.activity === "repairing" ? drone.targetID ?? null : null,
      };
    });
  });
  // DroneTooltip reads the drones' attributes off the dogma location the client already holds: the page's reckoning of
  // the ship is asked for as the window first lists a drone type, so a first hover finds its figures (not 1.5 s later)
  $effect(() => {
    const types = new Set([...bayRows.map((r) => r.typeID), ...spaceRows.flatMap((r) => (r.typeID === null ? [] : [r.typeID]))]);
    let missing = false;
    for (const t of types) if (flow.droneTooltipFigures(t) === null) missing = true;
    for (const t of types) if (!bandwidth.has(t)) { bandwidth.set(t, null); void flow.typeDogmaFacts(t).then((f) => { bandwidth.set(t, f?.attributes.find((x) => x[0] === 1272)?.[1] ?? null); groupOfType.set(t, f?.groupID ?? null); bandwidthVersion++; }).catch(() => {}); }
    if (missing) { const again = setTimeout(() => bandwidthVersion++, 1500); return () => clearTimeout(again); }
  });
  function layersOf(e: SpaceEntity | null): readonly [number, number, number] | null {
    const x = e as (SpaceEntity & { shieldRatio?: number | null; armorRatio?: number | null; hullRatio?: number | null }) | null;
    return x && x.shieldRatio != null && x.armorRatio != null && x.hullRatio != null ? [x.shieldRatio, x.armorRatio, x.hullRatio] : null;
  }
  const spaceList = $derived(split(spaceRows, () => 1));
  const outCount = $derived(localDrones.length);
  // DroneGroupHeaderInSpace.ConstructTooltipPanel (DroneGroupHeaderInSpaceTooltipPanel): the drones in space out of the
  // most the Drones skill allows, the skill's row and bar, the bandwidth used of the ship's
  flow.requestWords(["UI/Inflight/Drone/MaxDronesInSpace", "UI/Inflight/Drone/BandwidthUsed"]);
  const SKILL_BOX_COLOR: Record<string, string> = { trained: "rgba(204,204,204,1)", training: "rgba(204,204,204,0.6)", queued: "#3ea8d9",
    untrained: "rgba(255,255,255,0.3)", "trained-omega": "rgba(252,194,7,0.8)", none: "transparent", small: "rgba(255,255,255,0.3)", "small-omega": "rgba(252,194,7,0.6)" };
  let spaceHeadTipAt: HTMLElement | null = null;
  async function showSpaceHeadTip(anchor: HTMLElement): Promise<void> {
    spaceHeadTipAt = anchor;
    const types = [...new Set(localDrones.flatMap((d) => (d.typeID === null ? [] : [d.typeID])))];
    const [states] = await Promise.all([flow.skillCatalogueStates([3436]).catch(() => null),
      ...types.filter((t) => !bandwidth.has(t)).map((t) => flow.typeDogmaFacts(t).then((f) => { bandwidth.set(t, f?.attributes.find((a) => a[0] === 1272)?.[1] ?? null); }).catch(() => {}))]);
    if (spaceHeadTipAt !== anchor) return;
    const used = localDrones.reduce((sum, d) => sum + (d.typeID === null ? 0 : bandwidth.get(d.typeID) ?? 0), 0);
    const total = $drones.limits.droneBandwidth ?? 0;
    showDronesInSpaceTooltip(anchor, {
      maxLine: plainText(formatTemplate(headerWord("UI/Inflight/Drone/MaxDronesInSpace", "{numDrones} out of maximum {numMax} drones in space as allowed by the Drones skill"), { numDrones: outCount, numMax: maxActive ?? 0 }, { nameOf: () => "" })),
      skillName: typeName(3436, "Drones"),
      skillBoxes: (states?.get(3436)?.boxes ?? []).map((b) => ({ color: SKILL_BOX_COLOR[b.box] ?? "transparent", outline: b.partial || b.box === "training" })),
      bandwidthIcon: clientTexture("res:/ui/texture/icons/56_64_5.png"),
      bandwidthLabel: headerWord("UI/Inflight/Drone/BandwidthUsed", "Bandwidth used"),
      // (int(used), attributeFormat.GetFormatAndValue of the total: 50 Mbit/sec)
      bandwidthValue: `${Math.trunc(used)}/${Number(total.toFixed(2))} Mbit/sec`,
    });
  }
  const maxActive = $derived($drones.limits.maxActiveDrones);

  const allDroneIDs = $derived(orderableDroneIDs($drones.inSpace, snapshot?.entities ?? null, ship?.itemID ?? null));
  const salvageIDs = $derived(salvageDroneIDs(allDroneIDs, $drones.inSpace, (typeID) => resolvedName($names.resolved, "typeGroup", typeID, "")));
  const miningIDs = $derived(miningDroneIDs(allDroneIDs, $drones.inSpace, (typeID) => resolvedName($names.resolved, "typeGroup", typeID, "")));
  /**
   * droneFunctions.PerformPrimaryAction (the drones window's Engage, F): the drones split by group - salvage drones
   * Salvage, mining drones MineRepeatedly, the rest EngageTarget - each order given to its own drones.
   */
  async function primaryAction(ids: readonly number[]): Promise<void> {
    const salvage = ids.filter((id) => salvageIDs.includes(id));
    const mining = ids.filter((id) => miningIDs.includes(id));
    const combat = ids.filter((id) => !salvage.includes(id) && !mining.includes(id));
    // EngageTarget and MineRepeatedly: UserError DroneCommandRequiresActiveTarget without an active target
    const needTarget = () => flow.sayDialog("DroneCommandRequiresActiveTarget", null, "You need an active target to do that.");
    if (combat.length) {
      if (autoTargetID <= 0) return needTarget();
      await flow.engageDrones(combat, autoTargetID);
      const name = activeTargetName.get() ?? "";
      const t = $headerWords.templates["UI/Inflight/DronesEngaging"];
      const text = typeof t === "string" ? t.replace(/\{name\}/g, name) : `Drones engaging ${name}`;
      flow.sayDialog("CustomNotify", { type: "dict", entries: [["notify", text]] }, text);
    }
    if (salvage.length) await flow.salvageDrones(salvage, autoTargetID > 0 ? autoTargetID : null);
    if (mining.length) {
      if (autoTargetID <= 0) return needTarget();
      await flow.mineWithDrones(mining, autoTargetID);
    }
  }
  // DroneGroupHeaderInSpace's Engage, Return and Orbit and Return to Drone Bay stay enabled with a shortcut tooltip
  // (read through gridcheck: enabled, no hint, LoadShortcutTooltip); with no drone in space they ask nothing.

  $effect(() => {
    const refs: NameRef[] = [];
    for (const stack of $drones.bay ?? []) { refs.push({ kind: "type", id: stack.typeID }); refs.push({ kind: "typeGroup", id: stack.typeID }); }
    for (const drone of $drones.inSpace ?? []) {
      if (drone.typeID !== null) { refs.push({ kind: "type", id: drone.typeID }); refs.push({ kind: "typeGroup", id: drone.typeID }); }
    }
    if (refs.length > 0) flow.requestNames(refs);
  });
  $effect(() => { if (!$drones.loaded) void flow.loadDrones().catch(() => {}); });

  let bayOpen = $state(true);
  let spaceOpen = $state(true);
  // DronesWindow.OnInBayHeaderExpandedChanged / OnInSpaceHeaderExpanedChanged: one of the two always open - the one
  // collapsed while the other is too opens the other
  let busy = $state(false);
  let error = $state("");
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    error = "";
    try { await action(); } catch (cause) {
      error = isSessionLost(cause) ? "The live session ended (idle timeout or another client took over)." : panelErrorWords(cause);
    } finally { busy = false; }
  }

  /** The right-click menu: where, and its entries (a reason in place of an entry that cannot run). */
  type MenuEntry = { label: string; path?: string; disabled?: string | null; act?: () => Promise<void>; sub?: MenuEntry[]; sep?: boolean };
  const SEP: MenuEntry = { label: "", sep: true };
  // The window's menus in the client's ContextMenu (CreateMenuView: MenuUnderlay, 22 px entries), as the space menu's
  const ctxMenu = new ContextMenu();
  onDestroy(() => ctxMenu.close());
  const toCtx = (entries: readonly MenuEntry[]): (ContextEntry | null)[] => entries.map((m) => (m.sep ? null : {
    label: m.label, disabled: m.disabled ?? null, ...(m.path ? { path: m.path } : {}),
    ...(m.act ? { run: () => { const act = m.act!; void run(act); } } : {}),
    ...(m.sub ? { sub: toCtx(m.sub) } : {}),
  }));
  /**
   * DroneInBayEntry.GetMenu (read through gridcheck on a bay Hobgoblin): the window's GroupMenu (Move Drone) and InvItemMenu
   * over the selection without Buy This Type, Add to Market Quickbar and Find in Contracts, ordered by menuHierarchy with
   * a line between groups: Launch Drone | Show Info | View Market Details, Find in Personal Assets | Move Drone | Compare.
   * On more than one drone (isMultiSelection, MergeMenus) no Show Info or Find in Personal Assets, and " (<n>)" after
   * Launch Drone and Compare.
   */
  function bayRowMenu(ids: number[], typeID: number): MenuEntry[] {
    return bayItemsMenu(ids.map((itemID) => ({ itemID, typeID })), true);
  }
  /**
   * The filtered InvItemMenu over bay drones, with the window's Move Drone where an entry's (GroupMenu): on several the
   * merged entries - Launch Drone (n), View Market Details and Buy All (n) (the filter takes Buy This Type, not Buy All),
   * Compare (n). DroneGroupHeaderInBay.GetMenu is it over the whole bay, no Move Drone; nothing on an empty bay.
   */
  function bayItemsMenu(items: { itemID: number; typeID: number }[], withMove: boolean, noMarket = false, folder?: { expand: MenuEntry; favorite: MenuEntry }): MenuEntry[] {
    if (!items.length) return [];
    const ids = items.map((i) => i.itemID);
    const typeID = items[0]!.typeID;
    const types = [...new Set(items.map((i) => i.typeID))];
    const multi = ids.length > 1;
    const count = (label: string) => (multi ? `${label} (${ids.length})` : label);
    const groups: MenuEntry[][] = [
      // UI/Drones/LaunchDrone is a plural template: the client's entry says it with numDrones 1, its count after it
      [{ label: count(plainText(formatTemplate(say(MENU_WORDS.launchOne), { numDrones: 1 }, { nameOf: () => "" }))), act: () => flow.launchDrones(ids) }],
      multi ? [] : [{ label: say(MENU_WORDS.info), act: async () => showInfo({ kind: "type", typeID, itemID: ids[0] }) }],
      // a group's Expand / Collapse has no menu group: after Show Info (menuHierarchy's None after SHOWINFOGROUP), its line kept
      folder ? [folder.expand] : [],
      // (a drone group's menu filters out ViewTypesMarketDetails and BuyThisType: dronesWindow.GetSubFolderMenu)
      [...(noMarket ? [] : [{ label: say(MENU_WORDS.market), path: MENU_WORDS.market[0], act: async () => showMarketDetails(typeID) }]),
        ...(multi ? (noMarket ? [] : [{ label: count(say(MENU_WORDS.buyAll)), act: async () => flow.openMultiBuy(new Map(types.map((t) => [t, 1]))) }])
          : [{ label: say(MENU_WORDS.assets), act: async () => findInPersonalAssets(typeName(typeID, "")) }])],
      withMove ? [moveMenu(ids, typeID)] : [],
      [{ label: count(say(MENU_WORDS.compare)), act: async () => typeCompareTarget.ask(items.map((i) => ({ typeID: i.typeID, itemID: i.itemID }))) }, ...(folder ? [folder.favorite] : [])],
    ];
    return groups.filter((g) => g.length).flatMap((g, n) => (n ? [SEP, ...g] : g));
  }
  /**
   * menusvc.GetFleetMemberMenu: the fleet's members in the ballpark save the pilot, by name; the watch list's first under
   * Watch List and a line; past 20, by letters; none, No Valid Options (as the space menu lays it out).
   */
  function fleetMemberMenu(kind: "assist" | "guard", ids: readonly number[]): MenuEntry[] {
    const fleet = $fleetState;
    const snapshot = $space.snapshot;
    const self = snapshot?.entities.find((x) => x.isSelf) as (SpaceEntity & { characterID?: number | null }) | undefined;
    const here = new Set((snapshot?.entities ?? []).map((x) => (x as SpaceEntity & { characterID?: number | null }).characterID).filter((x): x is number => typeof x === "number"));
    const memberIDs = (fleet.fleet?.initState.value.members ?? []).map((m) => Number(m.charID)).filter((id) => id !== self?.characterID && here.has(id));
    const missing = memberIDs.filter((id) => resolvedName($names.resolved, "owner", id, "") === "");
    if (missing.length) flow.requestNames(missing.map((id) => ({ kind: "owner" as const, id })));
    const all = memberIDs.map((id) => ({ charID: id, name: resolvedName($names.resolved, "owner", id, String(id)), watched: (fleet.watchlist ?? []).includes(id) }))
      .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
    if (!all.length) return [{ label: say(MENU_WORDS.noValid) }];
    const entries = (list: typeof all): MenuEntry[] => list.map((m) => ({ label: m.name, act: () => flow.droneFleetOrder(kind, m.charID, ids) }));
    const watched = all.filter((m) => m.watched);
    const head: MenuEntry[] = watched.length ? [{ label: say(MENU_WORDS.watch), sub: entries(watched) }, SEP] : [];
    const chunks: (typeof all)[] = [];
    for (let i = 0; i < all.length; i += 20) chunks.push(all.slice(i, i + 20));
    if (chunks.length === 1) return [...head, ...entries(chunks[0]!)];
    return [...head, ...chunks.map((c) => ({ label: `${c[0]!.name[0]} ... ${c[c.length - 1]!.name[0]}`, sub: entries(c) }))];
  }
  /** A header's menu: none where it has no entries (CreateMenuView of an empty MenuList). */
  function openMenuIfAny(event: MouseEvent, entries: MenuEntry[]): void {
    event.preventDefault();
    if (entries.length) openMenu(event, entries);
  }
  function openMenu(event: MouseEvent, entries: MenuEntry[]): void {
    event.preventDefault();
    // ShowMenu: at the pointer (uilib.x + 10, uilib.y), ui_expand_play
    void playUiEvent("ui_expand_play");
    ctxMenu.open(event.clientX + 10, event.clientY, toCtx(entries));
  }
  /**
   * menusvc.DroneMenu: by the drones' kind Engage Target (combat), Mine (mining) or Salvage (salvage), then Return and
   * Orbit, Return to Drone Bay and Scoop to Drone Bay; a lost drone's Reconnect (menusvc.ReconnectToDrones).
   */
  function spaceEntries(ids: readonly number[], recoverable: boolean, folder?: { expand: MenuEntry; favorite: MenuEntry }): MenuEntry[] {
    const salvage = ids.filter((id) => salvageIDs.includes(id));
    const mining = ids.filter((id) => miningIDs.includes(id));
    const combat = ids.filter((id) => !salvage.includes(id) && !mining.includes(id));
    // MergeMenus of _DroneMenu per drone (read through gridcheck on the client's three: Mine, Engage Target (2) | Return and
    // Orbit (3), Return to Drone Bay (3) | Assist, Guard | Abandon Drone (3)): each entry once with " (<n>)" where n of the
    // drones offer it, by menuHierarchy - the orders (ACTIONSGROUP), Return and Orbit / Return to Drone Bay / Scoop
    // (CHANGESGROUP), Assist / Guard (in a fleet; the window has no fleet member submenu, not offered here), Abandon Drone
    // (DESTRUCTIVEGROUP) - a line between groups. Scoop to Drone Bay only for a drone with no drone state (IsScoopableDrone:
    // one no longer under control), never for one's own controlled drones.
    const n = (label: string, k: number) => (k > 1 ? `${label} (${k})` : label);
    const controlled = recoverable ? [] : ids;
    const groups: MenuEntry[][] = [
      [...(combat.length && !recoverable ? [{ label: n(say(MENU_WORDS.engage), combat.length), act: () => primaryAction(combat) }] : []),
        ...(mining.length && !recoverable ? [{ label: n(say(MENU_WORDS.mine), mining.length), act: () => primaryAction(mining) }] : []),
        ...(salvage.length && !recoverable ? [{ label: n(say(MENU_WORDS.salvage), salvage.length), act: () => flow.salvageDrones(salvage, autoTargetID > 0 ? autoTargetID : null) }] : [])],
      [...(controlled.length ? [{ label: n(say(MENU_WORDS.orbit), controlled.length), act: () => flow.returnDronesAndOrbit(controlled) },
        { label: n(say(MENU_WORDS.bay), controlled.length), act: () => flow.recallDrones(controlled) }] : []),
        ...(recoverable ? [{ label: n(say(MENU_WORDS.scoop), ids.length), act: () => flow.scoopDrones(ids) }] : [])],
      // a group's Expand / Collapse (no menu group) after the changes, its line kept (read through gridcheck on the
      // client's group: Mine | Return and Orbit, Return to Drone Bay | Expand | Assist, Guard, Mark Group as Favorite for
      // Launching | Abandon Drone)
      folder ? [folder.expand] : [],
      // OfferDroneAssist / OfferDroneGuard: one's own controlled drones, the pilot in a fleet - each GetFleetMemberMenu
      [...(controlled.length && $fleetState.availability === "ready"
        ? [{ label: n(say(MENU_WORDS.assist), controlled.length), sub: fleetMemberMenu("assist", controlled) },
          { label: n(say(MENU_WORDS.guard), controlled.length), sub: fleetMemberMenu("guard", controlled) }]
        : []), ...(folder ? [folder.favorite] : [])],
      [...(controlled.length ? [{ label: n(say(MENU_WORDS.abandon), controlled.length), act: async () => { await flow.abandonDrones(controlled); } }] : []),
        ...(recoverable ? [{ label: "Reconnect", act: () => flow.reconnectDrones(ids) }] : [])],
    ];
    return groups.filter((g) => g.length).flatMap((g, k) => (k ? [SEP, ...g] : g));
  }
  /**
   * DroneEntry.LoadDamageGaugeTooltipPanel: the Michelle tuple's three layers (shield, armor, structure) reversed, each
   * int(round(x 100)) clamped 0 - 100 as UI/Common/Formatting/Percentage under its damageIconInfo stats icon (structureHP,
   * armorHP, shieldHP); reloaded every 500 ms while the mouse stays (AutoTimer(500)); nothing while the damage is not read.
   */
  // DroneEntry.OnMouseEnter / OnMouseExit: stateSvc.SetState(itemID, state.mouseOver, 1 / 0) - the drone's bracket and
  // overview row hovered while the mouse is on its entry
  const flightView = getContext<(() => SpaceView | null) | undefined>("flightSpaceView");
  // DroneEntry.OnStateChange(mouseOver): the entry's ShowHilite / HideHilite as the drone is hovered anywhere
  let spaceHovered = $state<number | null>(null);
  const onSpaceHover = (event: Event) => { spaceHovered = (event as CustomEvent<{ itemID: number | null }>).detail.itemID; };
  onMount(() => { addEventListener("evejs:space-hover", onSpaceHover); return () => removeEventListener("evejs:space-hover", onSpaceHover); });
  let gaugeTipTimer: ReturnType<typeof setInterval> | null = null;
  const GAUGE_ICONS = ["structureHP", "armorHP", "shieldHP"].map((n) => clientTexture(`res:/UI/Texture/classes/Fitting/StatsIcons/${n}.png`));
  function gaugeTipShow(el: HTMLElement): void {
    const raw = el.dataset.damage;
    if (!raw) { hideLabelShortcutTooltip(); return; }
    const layers = raw.split(",").map(Number).slice(0, 3).reverse();
    showIconValuesTooltip(el, layers.map((v, i) => ({ icon: GAUGE_ICONS[i]!, text: `${Math.min(100, Math.max(0, Math.round(v * 100)))}%` })));
  }
  function gaugeTipOn(el: HTMLElement): void {
    gaugeTipOff();
    tooltipDue(el, () => gaugeTipShow(el));
    gaugeTipTimer = setInterval(() => { if (el.isConnected && el.matches(":hover")) gaugeTipShow(el); else gaugeTipOff(); }, 500);
  }
  function gaugeTipOff(): void {
    if (gaugeTipTimer) { clearInterval(gaugeTipTimer); gaugeTipTimer = null; }
    hideLabelShortcutTooltip();
  }
  onDestroy(gaugeTipOff);
  // ItemIcon.SetTypeID: its techIcon (GetTechLevelIconPathAndHint) 16 x 16 at the icon's top left; the meta groups read
  // once a type (a plain map, a revision counter - nothing written while rendering)
  const droneMeta = new Map<number, number | null>();
  let droneMetaRev = $state(0);
  function droneTech(typeID: number | null): { path: string; hint: string } | null {
    void droneMetaRev;
    if (typeID === null) return null;
    if (!droneMeta.has(typeID)) { droneMeta.set(typeID, null); void flow.typeFacts([typeID]).then((m) => { droneMeta.set(typeID, m?.get(typeID)?.metaGroupID ?? null); droneMetaRev += 1; }).catch(() => {}); }
    return techLevelIcon(droneMeta.get(typeID));
  }
</script>


{#snippet picture(typeID: number | null, label: string)}
  {@const tl = droneTech(typeID)}
  <span class="picture"><TypeIcon {typeID} name={label} size="sm" />{#if tl}<img class="techlvl" alt="" title={tl.hint} src={clientTexture(tl.path)} />{/if}</span>
{/snippet}

<!-- DroneEntry.ConstructGauges: structure, armor, shield, 32 x 4 each, 2 apart, 8 from the right; HealthGauge the
     silver-grey health (added) over cherry red with a white 2 px needle where it ends; unknown, full at 0.05 -->
{#snippet gauges(damage: readonly [number, number, number] | null)}
  <span class="gauges" class:unknown={damage === null} data-damage={damage ? damage.join(",") : ""}
    onmouseenter={(e) => gaugeTipOn(e.currentTarget as HTMLElement)} onmouseleave={gaugeTipOff}>
    {#each damage ? [damage[2], damage[1], damage[0]] : [1, 1, 1] as v}
      {@const p = Math.max(0, Math.min(1, Math.round(v * 1000) / 1000))}
      <span class="gauge" style:--hp={`${Math.floor(32 * p)}px`}><span class="health" style:width={`${Math.floor(32 * p)}px`}></span>{#if p > 0 && p < 1}<span class="needle" style:left={`${Math.floor(32 * p)}px`}></span>{/if}</span>
    {/each}
  </span>
{/snippet}

{#snippet bayEntry(row: (typeof bayRows)[number], sub: boolean)}
  <div class="row" class:sub class:selected={selected.bay.includes(row.itemID)} role="listitem" draggable="true" data-bay-item={row.itemID}
    onmouseenter={(e) => { hoverSound(e); tipFor(row.typeID, null, null, null, e); }} onmouseleave={tipOff}
    onclick={(e) => clickEntry("bay", row.itemID, e)} ondragstart={(e) => dragStart("bay", row.itemID, row.typeID, e)}
    ondblclick={() => run(() => flow.launchDrones(row.itemIDs))}
    oncontextmenu={(e) => { const ids = pickedFor("bay", row.itemID, row.typeID, true); openMenu(e, bayRowMenu(ids, row.typeID)); }}>
    <!-- dronesWindow: a stack's label UI/Inflight/DroneBayEntryWithStacksize, "Mining Drone I (2)" (3698585, through
         gridcheck); one drone its name alone -->
    <span class="name">{row.quantity > 1 ? `${row.label} (${row.quantity})` : row.label}</span>
    <span class="row-buttons">
      <button type="button" class="command" title={plainText(formatTemplate(say(MENU_WORDS.launchOne), { numDrones: 1 }, { nameOf: () => "" }))} disabled={busy} onclick={() => run(() => flow.launchDrones(row.itemIDs))}>
        <span class="glyph" style:background-image={`url(${ICON.launch})`}></span>
      </button>
    </span>
    {@render gauges(bayDamage.get(row.itemID) ?? null)}
  </div>
{/snippet}

{#snippet spaceEntry(row: (typeof spaceRows)[number], sub: boolean)}
  <div class="row inspace" data-space-item={row.itemIDs[0]} class:list={!$viewIcons} class:compact={$windowCompact} class:sub class:lost={row.unavailable !== null} class:selected={selected.space.includes(row.itemIDs[0]!)} class:hilite={spaceHovered !== null && spaceHovered === row.itemIDs[0]} role="listitem" title={row.unavailable ?? undefined} draggable="true"
    onmouseenter={(e) => { hoverSound(e); flightView?.()?.hoverObject(row.itemIDs[0]!); if (row.typeID !== null) tipFor(row.typeID, row.unavailable ?? row.activity, row.color, row.targetID, e); }}
    onmouseleave={() => { flightView?.()?.hoverObject(null); tipOff(); }}
    onclick={(e) => clickEntry("space", row.itemIDs[0]!, e)} ondragstart={(e) => dragStart("space", row.itemIDs[0]!, row.typeID, e)}
    oncontextmenu={(e) => {
      // GroupMenu takes the selected of the clicked one's drone group, the drone menu every selected one
      const same = pickedFor("space", row.itemIDs[0]!, row.typeID, true), all = pickedFor("space", row.itemIDs[0]!, row.typeID, false);
      // one drone in space: its CelestialMenu as the scene draws it, Move Drone in its drone group (read through gridcheck:
      // Engage / Mine, Approach .. Lock Target | Show Info | Add to Overview | Move Drone, Return and Orbit, Return to
      // Drone Bay, Scoop to Cargo Hold | Abandon Drone); several, MergeMenus over them (the space view's mergedDroneEntries)
      const inSpaceNow = all.filter((id) => allDroneIDs.includes(id));
      if (row.unavailable === null && inSpaceNow.length >= 1 && inSpaceNow.length === all.length) {
        e.preventDefault(); e.stopPropagation(); tipOff();
        type Ctx = { label: string; run?: () => void; sub?: Ctx[] };
        const toContext = (m: MenuEntry): Ctx =>
          ({ label: m.label, ...(m.act ? { run: () => void m.act!() } : {}), ...(m.sub ? { sub: m.sub.map(toContext) } : {}) });
        dispatchEvent(new CustomEvent("evejs:open-space-menu", { detail: { itemID: row.itemIDs[0], itemIDs: inSpaceNow, x: e.clientX, y: e.clientY, droneExtra: [toContext(moveMenu(same, row.typeID))] } }));
        return;
      }
      openMenu(e, [moveMenu(same, row.typeID), ...spaceEntries(row.unavailable ? (row.recoverable ? all : []) : all.filter((id) => allDroneIDs.includes(id)), row.recoverable)]);
    }}>
    {#if row.sprite}<span class="state-sprite" title={row.activity} style:background-color={row.color ?? "rgba(255,255,255,0.75)"}
      style:mask-image={`url(${clientTexture(row.sprite)})`} style:-webkit-mask-image={`url(${clientTexture(row.sprite)})`}></span>{:else}<span class="state-sprite"></span>{/if}
    {#if $viewIcons}{@render picture(row.typeID, row.label)}{/if}
    <span class="name">{row.label} <span class="state-word" style:color={row.color}>{row.unavailable ?? row.activity}</span></span>
    {#if row.unavailable === null}
      {@const id = row.itemIDs[0]!}
      <!-- DroneInSpaceEntry.ConstructButtons (TORIGHT, so right to left): Return to Drone Bay, a ButtonSeperatorLine (1 px,
           padded 4, opacity 0.1), Return and Orbit, the primary action (engage_target, its hint GetPrimaryActionName) -->
      <span class="row-buttons">
        <button type="button" class="command" title={say(miningIDs.includes(id) ? MENU_WORDS.mine : salvageIDs.includes(id) ? MENU_WORDS.salvage : MENU_WORDS.engage)} disabled={busy}
          onclick={(e) => { e.stopPropagation(); void run(() => salvageIDs.includes(id) ? flow.salvageDrones([id], autoTargetID > 0 ? autoTargetID : null) : primaryAction([id])); }}>
          <span class="glyph" style:background-image={`url(${ICON.engage})`}></span>
        </button>
        <button type="button" class="command" title={say(MENU_WORDS.orbit)} disabled={busy} onclick={(e) => { e.stopPropagation(); void run(() => flow.returnDronesAndOrbit([id])); }}>
          <span class="glyph" style:background-image={`url(${ICON.orbit})`}></span>
        </button>
        <span class="sep row-sep" aria-hidden="true"></span>
        <button type="button" class="command" title={say(MENU_WORDS.bay)} disabled={busy} onclick={(e) => { e.stopPropagation(); void run(() => flow.recallDrones([id])); }}>
          <span class="glyph" style:background-image={`url(${ICON.recall})`}></span>
        </button>
      </span>
    {/if}
    {@render gauges(row.damage)}
  </div>
{/snippet}

<!-- DroneSubGroupInBay / InSpace: a ListGroup (its expander, the favourite's star, "<group> (<count>)" in the highlight
     colour) whose buttons show while the mouse is over it: in the bay Launch Drones, in space the primary action,
     Return and Orbit, a line, Return to Drone Bay -->
{#snippet groupHead(key: string, group: DroneGroup, count: number, ids: number[], inSpace: boolean)}
  {@const own = ids.filter((id) => allDroneIDs.includes(id))}
  <!-- DroneSubGroup, a ListGroup: SOUND_ENTRY_HOVER on enter (SE_BaseClassCore) -->
  <div class="row grouphead" class:drop={dropOn === key} role="button" tabindex="-1" onclick={() => toggleGroup(key)} onkeydown={() => {}} onmouseenter={hoverSound}
    ondragover={groupDragOver(key, inSpace, ids)} ondragleave={() => (dropOn = null)} ondrop={(e) => drop(inSpace ? "space" : "bay", group.label, e)}
    oncontextmenu={(e) => openMenu(e, groupMenu(key, group, ids, inSpace))}>
    <span class="expander" style:background-image={`url(${openGroups.has(key) ? ICON.expanderOpen : ICON.expanderClosed})`}></span>
    {#if favoriteID === group.id}<span class="star" style:background-image={`url(${ICON.star})`}></span>{/if}
    <span class="name">{groupWithCount(group.label, count)}</span>
    <span class="row-buttons">
      {#if inSpace}
        <!-- DroneSubGroupInSpace.GetPrimaryActionBtnHint: GetPrimaryActionName of the group's first drone -->
        <button type="button" class="command" title={say(miningIDs.includes(ids[0] ?? -1) ? MENU_WORDS.mine : salvageIDs.includes(ids[0] ?? -1) ? MENU_WORDS.salvage : MENU_WORDS.engage)} disabled={busy || !own.length} onclick={(e) => { e.stopPropagation(); void run(() => primaryAction(own)); }}>
          <span class="glyph" style:background-image={`url(${ICON.engage})`}></span>
        </button>
        <button type="button" class="command" title={say(MENU_WORDS.orbit)} disabled={busy || !own.length} onclick={(e) => { e.stopPropagation(); void run(() => flow.returnDronesAndOrbit(own)); }}>
          <span class="glyph" style:background-image={`url(${ICON.orbit})`}></span>
        </button>
        <span class="sep" aria-hidden="true"></span>
        <button type="button" class="command" title={say(MENU_WORDS.bay)} disabled={busy || !own.length} onclick={(e) => { e.stopPropagation(); void run(() => flow.recallDrones(own)); }}>
          <span class="glyph" style:background-image={`url(${ICON.recall})`}></span>
        </button>
      {:else}
        <!-- DroneSubGroupInBay.LoadLaunchButtonTooltipPanel: the favourite group's LoadShortcutTooltip (Launch Drones, its
             shortcut, the command's detailed description), another group's command name alone -->
        <button type="button" class="command" use:shortcutTip={() => (favoriteID === group.id
            ? { label: say(MENU_WORDS.launch), cmd: "CmdLaunchFavoriteDrones", lines: [headerWord("UI/Drones/HintOnFavoriteIcon", "Favorite Group: This group will be launched when using the \"Launch Drones\" shortcut.")] }
            : { label: say(MENU_WORDS.launch), cmd: "" })} disabled={busy}
          onclick={(e) => { e.stopPropagation(); void run(() => flow.launchDrones(ids)); }}>
          <span class="glyph" style:background-image={`url(${ICON.launch})`}></span>
        </button>
      {/if}
    </span>
  </div>
{/snippet}

{#if naming}
  <NamePopup caption={say(GROUP_WORDS.caption)} label={say(GROUP_WORDS.field)} refusal={say(GROUP_WORDS.empty)} okWord={say(GROUP_WORDS.ok)} cancelWord={say(GROUP_WORDS.cancel)}
    onok={(name) => { const req = naming; naming = null; if (req) createSubGroup(req.droneGroupID, req.ids, name.trim()); }} oncancel={() => (naming = null)} />
{/if}

<div class="fly-drones" class:compact={$windowCompact} bind:this={rootEl}>
  {#if warpWarningShown}
    <div class="warp-warning" role="alert">
      <span class="ww-whiteout"></span>
      <img class="ww-icon" src="/client-res/ui/texture/classes/agency/iconexclamation.png" alt="" />
      <p class="ww-text">{headerWord("UI/Drones/WarpWarningMessage", "You are about to warp off leaving your drones behind.")}</p>
      <div class="ww-buttons"><button type="button" class="client-btn" onclick={stopAndRecall}>{headerWord("UI/Drones/StopAndRecall", "Stop and Recall")}</button></div>
    </div>
  {/if}
  <div class="group bay" class:closed={!bayOpen} class:drop={dropOn === "bay"} role="list" tabindex="-1" onkeydown={(e) => listKey("bay", e)} ondragover={dragOver("bay")} ondragleave={() => (dropOn = null)} ondrop={(e) => drop("bay", null, e)}>
    <div class="sec" data-drone-head="bay" role="button" tabindex="-1" onclick={() => { if (headHeld) { headHeld = false; return; } bayOpen = !bayOpen; if (!bayOpen && !spaceOpen) spaceOpen = true; }} onkeydown={() => {}}
      oncontextmenu={(e) => openMenuIfAny(e, headerMenu(bayItemsMenu(bayRows.flatMap((r) => r.itemIDs.map((itemID) => ({ itemID, typeID: r.typeID }))), false, true)))}>
      <span class="caret" style:mask-image={`url("${bayOpen ? CARET.open : CARET.closed}")`} style:-webkit-mask-image={`url("${bayOpen ? CARET.open : CARET.closed}")`}></span><span class="lbl">{headerWord(HEADER_WORDS.bay, "Drones in Bay")} ({bayCount})</span>
      <span class="commands">
        <!-- DroneGroupHeaderInBay's launch button: LoadLaunchDronesTooltipPanel (Launch Drones and its shortcut) with no favourite
             group, else its hint alone -->
        <button type="button" class="command" title={favoriteID !== null ? say(MENU_WORDS.launch) : undefined} use:shortcutTip={() => (favoriteID === null ? { label: say(MENU_WORDS.launch), cmd: "CmdLaunchFavoriteDrones" } : null)} disabled={busy || !bayRows.length}
          onclick={(e) => { e.stopPropagation(); void run(() => flow.launchDrones(dronesToLaunch(shipTypeID, bayRows.flatMap((r) => r.itemIDs), ($drones.inSpace ?? []).map((d) => d.itemID)))); }}>
          <span class="glyph" style:background-image={`url(${ICON.launch})`}></span>
        </button>
      </span>
    </div>
    {#if bayOpen}
      <!-- topScroll (dronesInBayScroll, TOALL): the bay's entries scroll in the room the space part leaves -->
      <div class="list bay-list">
      {#if $drones.bay === null}
        <p class="state">{$drones.loaded ? "Your drone bay could not be read." : "Looking…"}</p>
      {:else}
        {#if !bayRows.length}<p class="none">{headerWord("/Carbon/UI/Controls/Common/NoItem", "No Item")}</p>{/if}
        {#each bayList.loose as row (row.itemID)}{@render bayEntry(row, false)}{/each}
        {#each bayList.heads as head (head.group.label)}
          {@const key = `bay:${head.group.id}`}
          {@render groupHead(key, head.group, head.count, head.ids, false)}
          {#if openGroups.has(key)}{#each head.rows as row (row.itemID)}{@render bayEntry(row, true)}{/each}{/if}
        {/each}
      {/if}
      </div>
    {/if}
  </div>

  <div class="group" class:drop={dropOn === "space"} role="list" tabindex="-1" onkeydown={(e) => listKey("space", e)} ondragover={dragOver("space")} ondragleave={() => (dropOn = null)} ondrop={(e) => drop("space", null, e)}>
    <div class="sec" data-drone-head="space" role="button" tabindex="-1" onclick={() => { if (headHeld) { headHeld = false; return; } spaceOpen = !spaceOpen; if (!spaceOpen && !bayOpen) bayOpen = true; }} onkeydown={() => {}}
      onmouseenter={(e) => { const el = e.currentTarget as HTMLElement; tooltipDue(el, () => void showSpaceHeadTip(el)); }} onmouseleave={() => { spaceHeadTipAt = null; hideLabelShortcutTooltip(); }}
      oncontextmenu={(e) => openMenuIfAny(e, headerMenu(allDroneIDs.length ? spaceEntries(allDroneIDs, false) : []))}>
      <span class="caret" style:mask-image={`url("${spaceOpen ? CARET.open : CARET.closed}")`} style:-webkit-mask-image={`url("${spaceOpen ? CARET.open : CARET.closed}")`}></span><span class="lbl">{headerWord(HEADER_WORDS.space, "Drones in Space")} ({maxActive === null ? outCount : `${outCount}/${maxActive}`})</span>
      <span class="commands">
        <span class="settings-host">
          <!-- DroneGroupHeaderInSpace's settings: a ButtonIcon with no hint (read through gridcheck), its GetSettingsMenu's
               two checkboxes (MenuData.AddCheckbox, each with its hint) at the pointer (ShowMenu: uilib.x + 10, uilib.y) -->
          <button type="button" class="command"
            onclick={(e) => { e.stopPropagation(); openSettingsMenu(e.clientX, e.clientY); }}>
            <span class="glyph" style:background-image={`url(${ICON.settings})`}></span>
          </button>
        </span>
        <button type="button" class="command" use:shortcutTip={() => ({ label: say(CMD_WORDS.CmdDronesEngage!), cmd: "CmdDronesEngage" })} disabled={busy}
          onclick={(e) => { e.stopPropagation(); if (allDroneIDs.length) void run(() => primaryAction(allDroneIDs)); }}>
          <span class="glyph" style:background-image={`url(${ICON.engage})`}></span>
        </button>
        <button type="button" class="command" use:shortcutTip={() => ({ label: say(CMD_WORDS.CmdDronesReturnAndOrbit!), cmd: "CmdDronesReturnAndOrbit" })} disabled={busy}
          onclick={(e) => { e.stopPropagation(); if (allDroneIDs.length) void run(() => flow.returnDronesAndOrbit(allDroneIDs)); }}>
          <span class="glyph" style:background-image={`url(${ICON.orbit})`}></span>
        </button>
        <span class="sep" aria-hidden="true"></span>
        <button type="button" class="command" use:shortcutTip={() => ({ label: say(CMD_WORDS.CmdDronesReturnToBay!), cmd: "CmdDronesReturnToBay" })} disabled={busy}
          onclick={(e) => { e.stopPropagation(); if (allDroneIDs.length) void run(() => flow.recallDrones(allDroneIDs)); }}>
          <span class="glyph" style:background-image={`url(${ICON.recall})`}></span>
        </button>
      </span>
    </div>
    {#if spaceOpen}
      <!-- bottomScroll (dronesInSpaceScroll, padTop 2): as high as its entries, at most the window's height less 128 (86
           compact) - UpdateBottomScrollHeight -->
      <div class="list space-list" style:max-height={spaceMax === null ? undefined : `${spaceMax}px`}>
      {#if $drones.inSpace === null}
        <p class="state">{$drones.loaded ? "Your drones in space could not be read." : "Looking…"}</p>
      {:else}
        {#if !spaceRows.length}<p class="none">{headerWord("/Carbon/UI/Controls/Common/NoItem", "No Item")}</p>{/if}
        {#each spaceList.loose as row (row.key)}{@render spaceEntry(row, false)}{/each}
        {#each spaceList.heads as head (head.group.label)}
          {@const key = `space:${head.group.id}`}
          {@render groupHead(key, head.group, head.count, head.ids, true)}
          {#if openGroups.has(key)}{#each head.rows as row (row.key)}{@render spaceEntry(row, true)}{/each}{/if}
        {/each}
      {/if}
      </div>
    {/if}
  </div>

  {#if error}<p class="said" role="alert">{error}</p>{/if}
  {#if $drones.error}<p class="said">{$drones.error}</p>{/if}
  {#if $drones.actionError && !$drones.actionErrorSaid}<p class="said">{$drones.actionError}</p>{/if}
  {#if $drones.silentDecline}<p class="said">{$drones.silentDecline}</p>{/if}
  {#each $drones.orderReports as report}
    <p class="said">{report.label ?? "One of your drones"}: {report.text}</p>
  {/each}

</div>

{#if tip}
  <!-- TooltipPanel (the hint layer): background_04's frame, the 26 px type icon and the name, the bandwidth row -->
  <div class="drone-tip" bind:this={tipEl}>
    <div class="tip-frame"></div>
    <div class="tip-grid">
      <span class="tip-icon tip-type"><TypeIcon typeID={tip.typeID} name={tip.name} size="sm" /></span>
      <span class="tip-text"><b>{tip.name}</b>{#if tip.state}<br><span style:color={tip.color}>{tip.state}</span>{#if tipTarget}&nbsp;{tipTarget}{/if}{/if}</span>
      {#each tipRows as row, i (i)}
        <span class="tip-icon" class:tip-header={row.header}>{#if row.icon}<img src={row.icon} alt="" />{/if}</span>
        {#if row.values}
          <!-- AddAttributeRow: each value its 24 px icon and its label, about 65 px apart -->
          <span class="tip-values">{#each row.values as v, j (j)}<span class="tip-value">{#if v.icon}<img src={v.icon} alt="" />{/if}{v.text}</span>{/each}</span>
        {:else}
          <span class="tip-text" class:tip-header={row.header}>{#each row.text.split(/\n|<br>/) as line, j (j)}{#if j}<br>{/if}{line}{/each}</span>
        {/if}
      {/each}
      {#if bandwidthText}
        <span class="tip-icon">{#if attributeLooks.get(1272)?.icon}<img src={attributeLooks.get(1272)?.icon} alt="" />{/if}</span>
        <span class="tip-text">{bandwidthText}</span>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* WarpWarning: panel1Corner_Solid in WARNING_ORANGE at 0.15, the corner triangle, a 32 px exclamation pulsing
     0.5..1.5 every 0.7 s, the message in orange 52 px in, Stop and Recall under it; faded in over 0.3 s with a white
     flash */
  .warp-warning { position: relative; margin-bottom: 2px; padding: 8px 8px 8px 52px; min-height: 48px;
    color: #f39058; animation: ww-in 0.3s cubic-bezier(0.3333, 0, 0.6667, 1); }
  /* Frame(bgParent, panel1Corner_Solid, rotation pi, cornerSize 9, WARNING_ORANGE, opacity 0.15): the sliced texture as
     a mask over the orange, turned half round; cornerTriSmall 5 x 5 at the top left, WARNING_ORANGE 0.5 */
  .warp-warning::before { content: ""; position: absolute; inset: 0; background: rgba(243, 144, 88, 0.15); transform: rotate(180deg); pointer-events: none;
    -webkit-mask-box-image: url(/client-res/ui/texture/shared/darkstyle/panel1corner_solid.png) 9 fill / 9px; }
  .warp-warning::after { content: ""; position: absolute; left: 0; top: 0; width: 5px; height: 5px; background: rgba(243, 144, 88, 0.5); pointer-events: none;
    -webkit-mask: url(/client-res/ui/texture/shared/darkstyle/cornertrismall.png) center / 5px 5px no-repeat; mask: url(/client-res/ui/texture/shared/darkstyle/cornertrismall.png) center / 5px 5px no-repeat; }
  .ww-whiteout { position: absolute; inset: 0; background: rgba(255, 255, 255, 0.5); opacity: 0; animation: ww-flash 0.3s 0.1s cubic-bezier(0.3333, 0, 0.6667, 1); pointer-events: none; }
  .ww-icon { position: absolute; left: 10px; top: 8px; width: 32px; height: 32px; animation: ww-pulse 0.7s linear infinite; }
  .ww-text { margin: 0 0 8px; font: 14px var(--font); }
  /* Button(label StopAndRecall, TOPLEFT): the carbonui Button (play.css client-btn) */
  @keyframes ww-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes ww-flash { 0% { opacity: 0; } 50% { opacity: 1; } 100% { opacity: 0; } }
  /* FadeTo(warning_icon, 0.5 -> 1.5, 0.7 s, loops -1, ANIM_WAVE): a smoothstep up to 1.5 at 0.35 s and down again,
     the opacity held at 1 above it (from 0.175 s to 0.525 s); the halves of the smoothstep as their own beziers */
  @keyframes ww-pulse { 0% { opacity: 0.5; animation-timing-function: cubic-bezier(0.3333, 0, 0.6667, 0.5); } 25% { opacity: 1; animation-timing-function: linear; } 75% { opacity: 1; animation-timing-function: cubic-bezier(0.3333, 0.5, 0.6667, 1); } 100% { opacity: 0.5; } }
  /* ModuleButtonTooltip: margin 16 (the live client, gridcheck g238: Mining Drone I 252 x 202, the type icon 26 at 18,20,
     the name at 50,24, then rows 34 apart with their 24 px icons at 19 and labels at 50) */
  .drone-tip { position: fixed; z-index: 100000; pointer-events: none; padding: 16px; font: 14px var(--font); color: rgba(255, 255, 255, 0.75); white-space: nowrap; }
  .tip-frame { position: absolute; inset: 0; opacity: 0.75; border-style: solid; border-width: 0; border-image-source: url(/client-res/ui/texture/classes/framewithpointer/background_04.png); border-image-slice: 19 fill; border-image-width: 19px; border-image-outset: 15px; }
  .tip-grid { position: relative; display: grid; grid-template-columns: 30px auto; align-items: center; }
  .tip-icon { width: 30px; min-height: 30px; display: grid; place-items: center; }
  .tip-icon img { width: 24px; height: 24px; }
  .tip-text { padding: 8px 4px; line-height: 18px; }
  .tip-text b { color: rgba(255, 255, 255, 0.75); }
  /* AddTypeAndIcon: iconSize 26 */
  .tip-type :global(.type-icon) { width: 26px; height: 26px; }
  .tip-icon.tip-header { min-height: 24px; }
  .tip-text.tip-header { padding: 4px 4px 0; align-self: end; }
  .tip-values { display: flex; padding: 4px 0; margin-left: -4px; }
  .tip-value { display: inline-flex; align-items: center; flex: 1 1 0; min-width: 65px; }
  /* the eve-cs mirror's drone window: 11 px upper-case section labels in grey with white counts on a 2 % white strip,
     29 px rows of a 24 px type icon, the name at 13 px and its count at 11 px, 16 px command icons */
  /* DronesWindow: the bay's part (topScroll) takes the room, the space part (bottomCont) at the foot while the bay is open */
  /* DroneEntry text TextBody 14, the group headers EveLabelMedium 14 (read through gridcheck) */
  .fly-drones { position: relative; font-size: 14px; color: #fff; user-select: none; display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .group.bay { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
  .group:not(.bay) { flex: none; }
  /* each part scrolls by itself (the client's two Scrolls), its header fixed above it */
  .list { overflow-y: auto; overflow-x: hidden; min-height: 0; }
  .bay-list { flex: 1 1 auto; }
  .group.bay > .sec { flex: none; }
  .space-list { margin-top: 2px; }
  /* compact (UpdateHeaderPadding, _get_header_fixed_height): the header 40 high with the content extended into it -
     the bay's header in the title row, short of the header's buttons on the right (reserved_space_right); the rest of
     the header still drags the window */
  :global(.win:has(.fly-drones.compact) > .win-bar) { height: 40px; box-sizing: border-box; align-items: flex-start; padding-top: 4px; }
  :global(.win:has(.fly-drones.compact) > .win-body) { margin-top: -36px; pointer-events: none; }
  .fly-drones.compact > * { pointer-events: auto; }
  .fly-drones.compact .group.bay > .sec { margin-right: 96px; margin-top: 4px; }
  .group.bay.closed { flex: none; }
  /* BaseDroneGroupHeader: a bar with the expander and the label; its buttons hidden until the mouse is over it */
  /* 24 high on a white 0.05 underlay; the caret a 16 px sprite at 4, the label (EveLabelMedium, TextColor.HIGHLIGHT) at
     24; the bay's header at the content's top, the in-space one padTop 4 and its scroll padTop 2 */
  .sec { display: flex; align-items: center; height: 24px; margin: 0; padding: 0 0 0 4px; background: rgba(255, 255, 255, 0.05); cursor: default; }
  .group:not(.bay) > .sec { margin: 4px 0 2px; }
  .sec .commands { margin-left: auto; margin-right: 4px; }
  .caret { flex: none; width: 16px; height: 16px; margin-right: 4px; background: #fff; mask-size: 16px 16px; -webkit-mask-size: 16px 16px; mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat; }
  .sec .commands { opacity: 0; visibility: hidden; transition: opacity .1s, visibility .1s; }
  .sec:hover .commands { opacity: 1; visibility: visible; }
  /* NoDroneInBayEntry (read through gridcheck): a 24 px entry, its TextBody 8 in and 3 down on an 18 px line */
  .none { margin: 0; box-sizing: border-box; height: 24px; padding: 3px 8px; line-height: 18px; color: rgba(255, 255, 255, 0.5); }
  .lbl { font-size: 14px; color: rgba(255, 255, 255, 0.9); }
  .commands, .row-buttons { display: flex; gap: 2px; }
  /* DroneEntry.buttonCont: hidden, faded in (0.1 s) while the mouse is over the entry; left of the gauges */
  /* its padRight 4 the only space between it and the gauges (the row's 8 gap less 4; an in-space row's 4 gap as is) */
  .row .row-buttons { opacity: 0; visibility: hidden; transition: opacity .1s, visibility .1s; margin-right: -4px; gap: 0; }
  .row.inspace .row-buttons { margin-right: 0; }
  /* its ButtonIcons buttonSize 20 wide, the row's height */
  .row .row-buttons .command { width: 20px; height: 24px; }
  .row:hover .row-buttons { opacity: 1; visibility: visible; }
  /* ButtonIcon: TextColor.NORMAL 0.75, HIGHLIGHT 0.9 hovered, DISABLED 0.3; no hover background (isHoverBGUsed only under noBgSize) */
  .command { width: 24px; height: 22px; padding: 0; border: 0; background: transparent; display: grid; place-items: center; cursor: pointer; opacity: 0.75; }
  .command:hover:not(:disabled) { opacity: 0.9; }
  .command:disabled { opacity: 0.3; cursor: default; }
  .glyph { width: 16px; height: 16px; background: center / 16px 16px no-repeat; }
  /* DroneEntry: 24 high, the label 4 in (8 more a sublevel); an in-space one in the icons view 40 high with its 32 px icon */
  .row { display: flex; align-items: center; gap: 8px; padding: 0 0 0 4px; min-height: 24px; box-sizing: border-box; }
  .row.inspace { min-height: 40px; gap: 4px; }
  .row.inspace.list { min-height: 24px; }
  /* compact (DroneInSpaceEntry.GetHeight): ICONSIZE + 4 in Icons, ENTRY_HEIGHT_COMPACT 22 in List */
  .row.inspace.compact { min-height: 36px; }
  .row.inspace.list.compact { min-height: 22px; }
  .state-sprite { width: 16px; height: 16px; flex: none; mask-size: 16px 16px; -webkit-mask-size: 16px 16px; mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat; }
  .row.inspace .picture { width: 32px; height: 32px; }
  .row.inspace .picture :global(.type-icon) { width: 32px; height: 32px; }
  /* the entries' ListEntryUnderlay (SE_BaseClassCore's highlight): THEME_FOCUSDARK at 0.2 under the mouse, 0.4 selected */
  .row:hover, .row.hilite { background: color-mix(in srgb, var(--theme-focus-dark, #305665) 20%, transparent); }
  .row.lost { opacity: 0.55; }
  /* a selected entry (the scroll's selection fill) and a part or group a drag may drop on */
  .row.selected { background: color-mix(in srgb, var(--theme-focus-dark, #305665) 40%, transparent); }
  /* BaseDroneGroupHeader.ShowDragHighlight: its underlay (white 0.05, glow) to 0.1 with glow 1 over TIME_ENTRY 0.1;
     HideDragHighlight back to 0.05 over TIME_EXIT 0.3 */
  .group > .sec { transition: background-color 0.3s, box-shadow 0.3s; }
  .group.drop > .sec { background-color: rgba(255, 255, 255, 0.1); box-shadow: 0 0 6px rgba(255, 255, 255, 0.25); transition: background-color 0.1s, box-shadow 0.1s; }
  /* DroneSubGroup.ShowIconGlow: the icon's glowBrightness to 1 over TIME_ENTRY 0.1 (HideIconGlow to 0 over TIME_EXIT 0.3) */
  .row.grouphead .star { transition: filter 0.3s; }
  .row.grouphead.drop .star { filter: brightness(1.8) drop-shadow(0 0 3px rgba(255, 255, 255, 0.8)); transition: filter 0.1s; }
  .group { margin: 0; padding: 0; border: 0; background: none; }
  .picture { position: relative; width: 24px; height: 24px; flex: none; display: grid; }
  .picture .techlvl { position: absolute; left: 0; top: 0; width: 16px; height: 16px; max-width: none; z-index: 1; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* gaugesParent TORIGHT flush with the entry's right (its padright=8 is not carbonui's padRight, so nothing: gridcheck
     measured the gauges ending at the entry's 530) */
  .gauges { display: flex; gap: 2px; flex: none; margin-right: 0; }
  .gauges.unknown { opacity: 0.05; }
  /* HealthGauge (droneEntry.py): droneGaugeBar COLOR_HEALTH (0.69 grey) drawn additively (TR2_SBM_ADD) over what is behind,
     droneGaugeBarDmg COLOR_DAMAGE filling the rest, the two side by side */
  .gauge { position: relative; width: 32px; height: 4px; overflow: hidden; background: linear-gradient(to right, transparent var(--hp, 32px), rgb(153, 31, 36) var(--hp, 32px)); }
  .gauge .health { position: absolute; left: 0; top: 0; bottom: 0; background: rgb(176, 176, 176); mix-blend-mode: plus-lighter; }
  .gauge .needle { position: absolute; top: 0; bottom: 0; width: 2px; background: #fff; }
  /* DroneInSpaceEntry (read through gridcheck on a Hobgoblin): its entryLabel TextBody at white 0.9 */
  /* DroneInBayEntry and DroneInSpaceEntry: TextBody entryLabel at white 0.9 (read through gridcheck) */
  .row .name { color: rgba(255, 255, 255, 0.9); }
  .count { font-size: 11px; color: rgb(176, 176, 169); }
  .activity { font-size: 11px; color: rgb(176, 176, 169); white-space: nowrap; }
  .state { margin: 0; padding: 4px 12px 6px; font-size: 11px; color: rgb(108, 110, 107); }
  .said { margin: 0; padding: 3px 12px; font-size: 11px; color: #d08a6a; }
  .settings-host { position: relative; display: inline-flex; }
  /* sublevel 1: 8 further in (GetLabelLeft 4 + 8 * sublevel) */
  .row.sub { padding-left: 12px; }
  .row.grouphead { min-height: 24px; gap: 0; cursor: default; }
  .row.grouphead .star { margin-left: 2px; }
  .row.grouphead .name { margin-left: 4px; }
  .row.grouphead .name { color: #fff; }
  /* ListGroup: the expander a 16 x 16 GlowSprite 4 px into the row; the favourite's star 2 px after it, the label 4 px after the star
     (measured on the live client, gridcheck: a DroneSubGroupInBay row - expander 22, star 40, label 60 from the window) */
  .expander { width: 16px; height: 16px; flex: none; background: center / 16px 16px no-repeat; }
  .star { width: 16px; height: 16px; background: center / 16px 16px no-repeat; flex: none; }
  /* ButtonSeperatorLine between Return and Orbit and Return to Drone Bay */
  .sep { width: 1px; height: 14px; margin: 0 3px; align-self: center; background: rgba(255, 255, 255, 0.15); }
  .row .row-sep { flex: none; height: auto; align-self: stretch; margin: 4px; background: rgba(255, 255, 255, 0.1); }
  .state-word { margin-left: 4px; }
</style>
