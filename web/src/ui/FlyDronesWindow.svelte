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
  import { hideLabelShortcutTooltip, showIconValuesTooltip } from "../play/labelShortcutTooltip.ts";
  import { canMyShipOrderDrone } from "../space/overview.ts";
  import { miningDroneIDs, orderableDroneIDs, salvageDroneIDs } from "./droneFlight.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import { isSessionLost } from "../app/flow.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import TypeIcon from "./TypeIcon.svelte";
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
  flow.requestWords([...Object.values(HEADER_WORDS), "/Carbon/UI/Controls/Common/NoItem"]);
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
  const keyHint = (label: string, cmd: string) => { const k = shortcutOf(cmd); return k ? `${label} (${k})` : label; };
  // target.GetActiveTargetID: the drones' orders go to the active target
  const activeTarget = activeTargetID;
  const settingsNow = droneSettings;
  // DronesWindow's load: the pilot's drone settings told to the server (godma.ChangeDroneSettings)
  // The radial menu on a bay entry (DroneEntry ExpandRadialMenu -> TryExpandActionMenu, inventoryRadialMenuFunctions'
  // droneMapping): Launch Drone at the top (1), the rework ring (3, nothing offered in space), the market ring (6: View
  // Market Details, Buy This Type), Show Info (7); held 150 ms without moving 12 px, as in space
  const radial = new RadialMenu();
  let rootEl: HTMLElement | undefined = $state();
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
    radial.open(x, y, row.label, options, 0);
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
  onMount(() => {
    document.body.appendChild(radial.root);
    radial.root.style.zIndex = "100000";
    // a bay entry its inventory radial; an in-space entry (a negative id here) the drone's own space radial
    const off = rootEl ? holdToOpen(rootEl, (_x, _y, e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-bay-item], [data-space-item]");
      return !el ? null : el.dataset.bayItem ? Number(el.dataset.bayItem) : -Number(el.dataset.spaceItem);
    }, (id, x, y) => {
      if (id > 0) openBayRadial(id, x, y);
      else { tipOff(); dispatchEvent(new CustomEvent("evejs:open-space-radial", { detail: { itemID: -id, x, y } })); }
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
  let tip = $state<{ typeID: number; name: string; state: string | null; color: string | null; targetID: number | null; x: number; y: number } | null>(null);
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
    tipTimer = setTimeout(() => {
      const r = el.getBoundingClientRect();
      const t = targetID ? snapshot?.entities.find((x) => x.itemID === targetID) ?? null : null;
      if (t?.typeID) flow.requestNames([{ kind: "type", id: t.typeID }]);
      if (t?.characterID) flow.requestNames([{ kind: "owner", id: t.characterID }]);
      tip = { typeID, name: typeName(typeID, ""), state, color, targetID, x: r.right + 12, y: r.top + r.height / 2 };
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
    }, 400);
  }
  function tipOff(): void { if (tipTimer) clearTimeout(tipTimer); tipTimer = null; tip = null; }
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
  $effect(() => {
    const missing = bayRows.map((r) => r.itemID).filter((id) => !asked.has(id));
    if (!missing.length) return;
    for (const id of missing) asked.add(id);
    void flow.bayDroneDamage(missing).then((got) => { if (got.size) bayDamage = new Map([...bayDamage, ...got]); }).catch(() => {});
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
  let openGroups = $state(new Set<string>());
  const toggleGroup = (key: string) => { const s = new Set(openGroups); if (s.has(key)) s.delete(key); else s.add(key); openGroups = s; };
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
    if (d.section === "space" && section === "bay") { void run(() => flow.recallDrones(d.ids)); return; }
    if (d.section === "bay" && section === "space") { void run(() => flow.launchDrones(d.ids)); return; }
    if (group && !moveToGroup(droneGroupOf(d.typeID), group, d.ids)) flow.sayDialog("CannotMixDrones", null, "You cannot mix drones of different types in the same group.");
  }
  const dragOver = (key: string) => (e: DragEvent) => { if (dragging) { e.preventDefault(); dropOn = key; } };
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
  const deleteMenu = (): MenuEntry[] => {
    const names = Object.keys($droneGroups.groups);
    return names.length ? [{ label: say(GROUP_WORDS.del), sub: names.map((name) => ({ label: name, act: async () => deleteGroup(name) })) }] : [];
  };
  /** A group header's menu: Expand / Collapse, the group's drones' menu, Mark / Unmark as Favorite. */
  function groupMenu(key: string, group: DroneGroup, ids: number[], inSpace: boolean): MenuEntry[] {
    const favorite = favoriteID === group.id;
    return [
      { label: say(openGroups.has(key) ? GROUP_WORDS.collapse : GROUP_WORDS.expand), act: async () => toggleGroup(key) },
      ...(inSpace ? spaceEntries(ids.filter((id) => allDroneIDs.includes(id)), false) : [{ label: say(MENU_WORDS.launch), act: () => flow.launchDrones(ids) }]),
      { label: say(favorite ? GROUP_WORDS.unfav : GROUP_WORDS.fav), act: async () => setFavoriteGroupID(shipTypeID, favorite ? null : group.id) },
    ];
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
  function layersOf(e: SpaceEntity | null): readonly [number, number, number] | null {
    const x = e as (SpaceEntity & { shieldRatio?: number | null; armorRatio?: number | null; hullRatio?: number | null }) | null;
    return x && x.shieldRatio != null && x.armorRatio != null && x.hullRatio != null ? [x.shieldRatio, x.armorRatio, x.hullRatio] : null;
  }
  const spaceList = $derived(split(spaceRows, () => 1));
  // dronesUtil.GetDronesInLocalSpace: michelle's drone states only (owned, or controlled by the ship); a drone nobody
  // controls has no state row and is not in the window (reconnected from the ship's menu, scooped from space)
  const localDrones = $derived(($drones.inSpace ?? []).filter((d) => d.orphaned !== true));
  const outCount = $derived(localDrones.length);
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
  type MenuEntry = { label: string; disabled?: string | null; act?: () => Promise<void>; sub?: MenuEntry[]; sep?: boolean };
  const SEP: MenuEntry = { label: "", sep: true };
  // The window's menus in the client's ContextMenu (CreateMenuView: MenuUnderlay, 22 px entries), as the space menu's
  const ctxMenu = new ContextMenu();
  onDestroy(() => ctxMenu.close());
  const toCtx = (entries: readonly MenuEntry[]): (ContextEntry | null)[] => entries.map((m) => (m.sep ? null : {
    label: m.label, disabled: m.disabled ?? null,
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
  function bayItemsMenu(items: { itemID: number; typeID: number }[], withMove: boolean): MenuEntry[] {
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
      [{ label: say(MENU_WORDS.market), act: async () => showMarketDetails(typeID) },
        ...(multi ? [{ label: count(say(MENU_WORDS.buyAll)), act: async () => flow.openMultiBuy(new Map(types.map((t) => [t, 1]))) }]
          : [{ label: say(MENU_WORDS.assets), act: async () => findInPersonalAssets(typeName(typeID, "")) }])],
      withMove ? [moveMenu(ids, typeID)] : [],
      [{ label: count(say(MENU_WORDS.compare)), act: async () => typeCompareTarget.ask(items.map((i) => ({ typeID: i.typeID, itemID: i.itemID }))) }],
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
  function spaceEntries(ids: readonly number[], recoverable: boolean): MenuEntry[] {
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
      // OfferDroneAssist / OfferDroneGuard: one's own controlled drones, the pilot in a fleet - each GetFleetMemberMenu
      controlled.length && $fleetState.availability === "ready"
        ? [{ label: n(say(MENU_WORDS.assist), controlled.length), sub: fleetMemberMenu("assist", controlled) },
          { label: n(say(MENU_WORDS.guard), controlled.length), sub: fleetMemberMenu("guard", controlled) }]
        : [],
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
    gaugeTipShow(el);
    gaugeTipTimer = setInterval(() => { if (el.isConnected && el.matches(":hover")) gaugeTipShow(el); else gaugeTipOff(); }, 500);
  }
  function gaugeTipOff(): void {
    if (gaugeTipTimer) { clearInterval(gaugeTipTimer); gaugeTipTimer = null; }
    hideLabelShortcutTooltip();
  }
  onDestroy(gaugeTipOff);
</script>


{#snippet picture(typeID: number | null, label: string)}
  <span class="picture"><TypeIcon {typeID} name={label} size="sm" /></span>
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
  <div class="row grouphead" class:drop={dropOn === key} role="button" tabindex="-1" onclick={() => toggleGroup(key)} onkeydown={() => {}}
    ondragover={dragOver(key)} ondragleave={() => (dropOn = null)} ondrop={(e) => drop(inSpace ? "space" : "bay", group.label, e)}
    oncontextmenu={(e) => openMenu(e, groupMenu(key, group, ids, inSpace))}>
    <span class="expander" class:open={openGroups.has(key)}></span>
    {#if favoriteID === group.id}<span class="star" style:background-image={`url(${ICON.star})`}></span>{/if}
    <span class="name">{groupWithCount(group.label, count)}</span>
    <span class="row-buttons">
      {#if inSpace}
        <button type="button" class="command" title={say(MENU_WORDS.engage)} disabled={busy || !own.length} onclick={(e) => { e.stopPropagation(); void run(() => primaryAction(own)); }}>
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
        <button type="button" class="command" title={favoriteID === group.id ? keyHint(say(MENU_WORDS.launch), "CmdLaunchFavoriteDrones") : say(MENU_WORDS.launch)} disabled={busy}
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
      <div class="ww-buttons"><button type="button" onclick={stopAndRecall}>{headerWord("UI/Drones/StopAndRecall", "Stop and Recall")}</button></div>
    </div>
  {/if}
  <div class="group bay" class:closed={!bayOpen} class:drop={dropOn === "bay"} role="list" ondragover={dragOver("bay")} ondragleave={() => (dropOn = null)} ondrop={(e) => drop("bay", null, e)}>
    <div class="sec" data-drone-head="bay" role="button" tabindex="-1" onclick={() => { if (headHeld) { headHeld = false; return; } bayOpen = !bayOpen; }} onkeydown={() => {}}
      oncontextmenu={(e) => openMenuIfAny(e, [...deleteMenu(), ...bayItemsMenu(bayRows.flatMap((r) => r.itemIDs.map((itemID) => ({ itemID, typeID: r.typeID }))), false)])}>
      <span class="caret" style:mask-image={`url("${bayOpen ? CARET.open : CARET.closed}")`} style:-webkit-mask-image={`url("${bayOpen ? CARET.open : CARET.closed}")`}></span><span class="lbl">{headerWord(HEADER_WORDS.bay, "Drones in Bay")} ({bayCount})</span>
      <span class="commands">
        <button type="button" class="command" title={keyHint(say(MENU_WORDS.launch), "CmdLaunchFavoriteDrones")} disabled={busy || !bayRows.length}
          onclick={(e) => { e.stopPropagation(); void run(() => flow.launchDrones(dronesToLaunch(shipTypeID, bayRows.flatMap((r) => r.itemIDs), ($drones.inSpace ?? []).map((d) => d.itemID)))); }}>
          <span class="glyph" style:background-image={`url(${ICON.launch})`}></span>
        </button>
      </span>
    </div>
    {#if bayOpen}
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
    {/if}
  </div>

  <div class="group" class:drop={dropOn === "space"} role="list" ondragover={dragOver("space")} ondragleave={() => (dropOn = null)} ondrop={(e) => drop("space", null, e)}>
    <div class="sec" data-drone-head="space" role="button" tabindex="-1" onclick={() => { if (headHeld) { headHeld = false; return; } spaceOpen = !spaceOpen; }} onkeydown={() => {}}
      oncontextmenu={(e) => openMenuIfAny(e, [...deleteMenu(), ...(allDroneIDs.length ? spaceEntries(allDroneIDs, false) : [])])}>
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
        <button type="button" class="command" title={keyHint(say(MENU_WORDS.engage), "CmdDronesEngage")} disabled={busy}
          onclick={(e) => { e.stopPropagation(); if (allDroneIDs.length) void run(() => primaryAction(allDroneIDs)); }}>
          <span class="glyph" style:background-image={`url(${ICON.engage})`}></span>
        </button>
        <button type="button" class="command" title={keyHint(say(MENU_WORDS.orbit), "CmdDronesReturnAndOrbit")} disabled={busy}
          onclick={(e) => { e.stopPropagation(); if (allDroneIDs.length) void run(() => flow.returnDronesAndOrbit(allDroneIDs)); }}>
          <span class="glyph" style:background-image={`url(${ICON.orbit})`}></span>
        </button>
        <span class="sep" aria-hidden="true"></span>
        <button type="button" class="command" title={keyHint(say(MENU_WORDS.bay), "CmdDronesReturnToBay")} disabled={busy}
          onclick={(e) => { e.stopPropagation(); if (allDroneIDs.length) void run(() => flow.recallDrones(allDroneIDs)); }}>
          <span class="glyph" style:background-image={`url(${ICON.recall})`}></span>
        </button>
      </span>
    </div>
    {#if spaceOpen}
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
  <div class="drone-tip" style:left={`${tip.x}px`} style:top={`${tip.y}px`}>
    <div class="tip-frame"></div>
    <div class="tip-grid">
      <span class="tip-icon"><TypeIcon typeID={tip.typeID} name={tip.name} size="sm" /></span>
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
  .warp-warning { position: relative; margin-bottom: 2px; padding: 8px 8px 8px 52px; min-height: 48px; background: rgba(243, 144, 88, 0.15);
    color: #f39058; animation: ww-in 0.3s ease-out; }
  .ww-whiteout { position: absolute; inset: 0; background: rgba(255, 255, 255, 0.5); opacity: 0; animation: ww-flash 0.3s 0.1s ease-in-out; pointer-events: none; }
  .ww-icon { position: absolute; left: 10px; top: 8px; width: 32px; height: 32px; animation: ww-pulse 0.7s ease-in-out infinite alternate; }
  .ww-text { margin: 0 0 8px; font: 14px var(--font); }
  .ww-buttons button { font: 13px var(--font); }
  @keyframes ww-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes ww-flash { 0% { opacity: 0; } 50% { opacity: 1; } 100% { opacity: 0; } }
  @keyframes ww-pulse { from { opacity: 0.5; } to { opacity: 1; } }
  .drone-tip { position: fixed; transform: translateY(-50%); z-index: 100000; pointer-events: none; padding: 8px; font: 14px var(--font); color: rgba(255, 255, 255, 0.75); white-space: nowrap; }
  .tip-frame { position: absolute; inset: 0; opacity: 0.75; border-style: solid; border-width: 0; border-image-source: url(/client-res/ui/texture/classes/framewithpointer/background_04.png); border-image-slice: 19 fill; border-image-width: 19px; border-image-outset: 15px; }
  .tip-grid { position: relative; display: grid; grid-template-columns: 30px auto; align-items: center; }
  .tip-icon { width: 30px; min-height: 30px; display: grid; place-items: center; }
  .tip-icon img { width: 24px; height: 24px; }
  .tip-text { padding: 8px 4px; line-height: 18px; }
  .tip-text b { color: rgba(255, 255, 255, 0.95); }
  .tip-icon.tip-header { min-height: 24px; }
  .tip-text.tip-header { padding: 4px 4px 0; align-self: end; }
  .tip-values { display: flex; padding: 4px 0; margin-left: -4px; }
  .tip-value { display: inline-flex; align-items: center; flex: 1 1 0; min-width: 65px; }
  /* the eve-cs mirror's drone window: 11 px upper-case section labels in grey with white counts on a 2 % white strip,
     29 px rows of a 24 px type icon, the name at 13 px and its count at 11 px, 16 px command icons */
  /* DronesWindow: the bay's part (topScroll) takes the room, the space part (bottomCont) at the foot while the bay is open */
  /* DroneEntry text TextBody 14, the group headers EveLabelMedium 14 (read through gridcheck) */
  .fly-drones { position: relative; font-size: 14px; color: #fff; user-select: none; display: flex; flex-direction: column; min-height: 100%; }
  .group.bay { flex: 1 1 auto; min-height: 0; overflow: auto; }
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
  .group.drop, .row.grouphead.drop { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35); }
  .group { margin: 0; padding: 0; border: 0; background: none; }
  .picture { width: 24px; height: 24px; flex: none; display: grid; }
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
  .row.grouphead { min-height: 24px; gap: 4px; cursor: default; }
  .row.grouphead .name { color: #fff; }
  .expander { width: 0; height: 0; border-left: 4px solid rgba(255, 255, 255, 0.6); border-top: 4px solid transparent; border-bottom: 4px solid transparent; margin: 0 4px; transition: transform .1s; }
  .expander.open { transform: rotate(90deg); }
  .star { width: 16px; height: 16px; background: center / 16px 16px no-repeat; flex: none; }
  /* ButtonSeperatorLine between Return and Orbit and Return to Drone Bay */
  .sep { width: 1px; height: 14px; margin: 0 3px; align-self: center; background: rgba(255, 255, 255, 0.15); }
  .row .row-sep { flex: none; height: auto; align-self: stretch; margin: 4px; background: rgba(255, 255, 255, 0.1); }
  .state-word { margin-left: 4px; }
</style>
