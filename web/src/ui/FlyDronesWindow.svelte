<script lang="ts">
  // The play page's Drones window, in the client's layout: two groups - Drones in Bay (n)
  // and Drones in Space (out/max) - each a header with its command icons (the client's eveicon/control_icons), and a row per
  // drone type: its icon, "Name x n". A bay row launches on a double-click or its icon; the in-space header engages
  // what is locked and recalls; a right-click on a row or header offers every order (engage, mine, salvage, return to
  // bay, reconnect, scoop). The orders, the ownership gates and the server's own refusal lines are DronesPanel's
  // (the workspace and mobile keep that panel); this is the same flow with the client's look.
  import { DRONE_NOT_UNDER_YOUR_CONTROL, NO_DRONE_UNDER_YOUR_CONTROL, panelErrorWords } from "../bridge/refusals.ts";
  import { droneActivityColor, droneActivityLabel } from "../bridge/drones.ts";
  import { activeTargetID, activeTargetName } from "../play/activeTarget.ts";
  import { playUiEvent } from "../play/uiAudio.ts";
  import { droneSettings, droneSettingsFor, droneWarpWarning, droneWarpWarningFor, setDroneSetting } from "./droneSettings.ts";
  import { shortcutOf } from "../play/shortcutKeys.ts";
  import { onMount } from "svelte";
  import { canMyShipOrderDrone } from "../space/overview.ts";
  import { miningDroneIDs, orderableDroneIDs, salvageDroneIDs } from "./droneFlight.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import { isSessionLost } from "../app/flow.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import TypeIcon from "./TypeIcon.svelte";
  import NamePopup from "./NamePopup.svelte";
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

  /** The client's control icons (res:/ui/texture/eveicon/control_icons). */
  /** dronesConst.DRONE_STATES_TEXTURES: each state's sprite (tinted COLOR_BY_STATE, TextColor.NORMAL where none). */
  const STATE_SPRITE: Record<string, string> = {
    idle: "res:/ui/texture/eveicon/system_icons/hourglass_16px.png", fighting: "res:/ui/texture/eveicon/control_icons/engage_target_16px.png",
    mining: "res:/ui/texture/eveicon/system_icons/mining_16px.png", approaching: "res:/ui/texture/eveicon/control_icons/approach_16px.png",
    returning: "res:/ui/texture/eveicon/control_icons/recall_drones_16px.png", chasing: "res:/ui/texture/eveicon/system_icons/visibility_16px.png",
    fleeing: "res:/ui/texture/eveicon/system_icons/flag_16px.png", repairing: "res:/UI/Texture/classes/Drones/repairing_16px.png",
    salvaging: "res:/ui/texture/eveicon/control_icons/salvage_16px.png",
  };
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
    scoop: ["UI/Drones/ScoopDroneToBay", "Scoop to Drone Bay"], launch: ["UI/Drones/LaunchDrones", "Launch Drones"],
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
  flow.requestWords([...Object.values(GROUP_WORDS).map((w) => w[0]), "UI/Inflight/Drone/DroneGroupWithCount"]);
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
  let settingsOpen = $state(false);
  // DronesWindow's load: the pilot's drone settings told to the server (godma.ChangeDroneSettings)
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

  const snapshot = $derived($space.snapshot);

  /**
   * DronesWindow.UpdateWarpWarning (WarpWarning): while the ship lines up for a warp (michelle.IsPreparingWarp: the
   * ball in warp mode, its effectStamp below 0) with drones out (AreDronesOut), the orange warning with its message
   * and Stop and Recall (stop_and_recall_drones: CmdStopShip, then every drone in local space to the bay); the
   * setting off, never.
   */
  const warpWarningOn = droneWarpWarning;
  const character = store.character;
  $effect(() => { const id = $character.selectedCharacterID; if (id !== null) droneWarpWarningFor(id); });
  flow.requestWords(["UI/Drones/WarpWarningMessage", "UI/Drones/StopAndRecall"]);
  const warpWarningShown = $derived($warpWarningOn && snapshot?.ship?.warp?.preparing === true && ($drones.inSpace ?? []).length > 0);
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
    return ($drones.inSpace ?? []).map((drone) => {
      const orderable = canMyShipOrderDrone(byID.get(drone.itemID) ?? null, ship?.itemID ?? null);
      const lost = drone.controlled === false || orderable === false;
      return {
        key: String(drone.itemID), typeID: drone.typeID, label: typeName(drone.typeID, "Drone"),
        activity: droneActivityLabel(drone.activity), color: droneActivityColor(drone.activity), itemIDs: [drone.itemID],
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
  const outCount = $derived(($drones.inSpace ?? []).length);
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
  const groupUnavailable = $derived(outCount > 0 && allDroneIDs.length === 0 ? NO_DRONE_UNDER_YOUR_CONTROL : null);
  const targetUnavailable = $derived(groupUnavailable ?? (outCount === 0 ? "No drones in space" : null));

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
  type MenuEntry = { label: string; disabled?: string | null; act?: () => Promise<void>; sub?: MenuEntry[] };
  let menu = $state<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  function openMenu(event: MouseEvent, entries: MenuEntry[]): void {
    event.preventDefault();
    const host = (event.currentTarget as HTMLElement).closest(".fly-drones")!.getBoundingClientRect();
    menu = { x: event.clientX - host.left, y: event.clientY - host.top, entries };
  }
  /**
   * menusvc.DroneMenu: by the drones' kind Engage Target (combat), Mine (mining) or Salvage (salvage), then Return and
   * Orbit, Return to Drone Bay and Scoop to Drone Bay; a lost drone's Reconnect (menusvc.ReconnectToDrones).
   */
  function spaceEntries(ids: readonly number[], recoverable: boolean): MenuEntry[] {
    const salvage = ids.filter((id) => salvageIDs.includes(id));
    const mining = ids.filter((id) => miningIDs.includes(id));
    const combat = ids.filter((id) => !salvage.includes(id) && !mining.includes(id));
    const none = ids.length ? null : outCount === 0 ? "No drones in space" : NO_DRONE_UNDER_YOUR_CONTROL;
    return [
      ...(combat.length ? [{ label: say(MENU_WORDS.engage), act: () => primaryAction(combat) }] : []),
      ...(mining.length ? [{ label: say(MENU_WORDS.mine), act: () => primaryAction(mining) }] : []),
      ...(salvage.length ? [{ label: say(MENU_WORDS.salvage), act: () => flow.salvageDrones(salvage, autoTargetID > 0 ? autoTargetID : null) }] : []),
      { label: say(MENU_WORDS.orbit), disabled: none, act: () => flow.returnDronesAndOrbit(ids) },
      { label: say(MENU_WORDS.bay), disabled: none, act: () => flow.recallDrones(ids) },
      { label: say(MENU_WORDS.scoop), act: () => flow.scoopDrones(ids) },
      ...(recoverable ? [{ label: "Reconnect", act: () => flow.reconnectDrones(ids) }] : []),
    ];
  }
</script>

<svelte:window onclick={() => { menu = null; settingsOpen = false; }} />

{#snippet picture(typeID: number | null, label: string)}
  <span class="picture"><TypeIcon {typeID} name={label} size="sm" /></span>
{/snippet}

<!-- DroneEntry.ConstructGauges: structure, armor, shield, 32 x 4 each, 2 apart, 8 from the right; HealthGauge the
     silver-grey health (added) over cherry red with a white 2 px needle where it ends; unknown, full at 0.05 -->
{#snippet gauges(damage: readonly [number, number, number] | null)}
  <span class="gauges" class:unknown={damage === null}
    title={damage ? [damage[0], damage[1], damage[2]].map((v) => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`).join("  ") : undefined}>
    {#each damage ? [damage[2], damage[1], damage[0]] : [1, 1, 1] as v}
      {@const p = Math.max(0, Math.min(1, Math.round(v * 1000) / 1000))}
      <span class="gauge"><span class="health" style:width={`${Math.floor(32 * p)}px`}></span>{#if p > 0 && p < 1}<span class="needle" style:left={`${Math.floor(32 * p)}px`}></span>{/if}</span>
    {/each}
  </span>
{/snippet}

{#snippet bayEntry(row: (typeof bayRows)[number], sub: boolean)}
  <div class="row" class:sub class:selected={selected.bay.includes(row.itemID)} role="listitem" draggable="true"
    onmouseenter={(e) => tipFor(row.typeID, null, null, null, e)} onmouseleave={tipOff}
    onclick={(e) => clickEntry("bay", row.itemID, e)} ondragstart={(e) => dragStart("bay", row.itemID, row.typeID, e)}
    ondblclick={() => run(() => flow.launchDrones(row.itemIDs))}
    oncontextmenu={(e) => { const ids = pickedFor("bay", row.itemID, row.typeID, true); openMenu(e, [moveMenu(ids, row.typeID), { label: say(MENU_WORDS.launch), act: () => flow.launchDrones(ids) }]); }}>
    <!-- dronesWindow: a stack's label UI/Inflight/DroneBayEntryWithStacksize, "Mining Drone I (2)" (3698585, through
         gridcheck); one drone its name alone -->
    <span class="name">{row.quantity > 1 ? `${row.label} (${row.quantity})` : row.label}</span>
    <span class="row-buttons">
      <button type="button" class="command" title="Launch drones" disabled={busy} onclick={() => run(() => flow.launchDrones(row.itemIDs))}>
        <span class="glyph" style:background-image={`url(${ICON.launch})`}></span>
      </button>
    </span>
    {@render gauges(bayDamage.get(row.itemID) ?? null)}
  </div>
{/snippet}

{#snippet spaceEntry(row: (typeof spaceRows)[number], sub: boolean)}
  <div class="row inspace" class:sub class:lost={row.unavailable !== null} class:selected={selected.space.includes(row.itemIDs[0]!)} role="listitem" title={row.unavailable ?? undefined} draggable="true"
    onmouseenter={(e) => { if (row.typeID !== null) tipFor(row.typeID, row.unavailable ?? row.activity, row.color, row.targetID, e); }} onmouseleave={tipOff}
    onclick={(e) => clickEntry("space", row.itemIDs[0]!, e)} ondragstart={(e) => dragStart("space", row.itemIDs[0]!, row.typeID, e)}
    oncontextmenu={(e) => {
      // GroupMenu takes the selected of the clicked one's drone group, the drone menu every selected one
      const same = pickedFor("space", row.itemIDs[0]!, row.typeID, true), all = pickedFor("space", row.itemIDs[0]!, row.typeID, false);
      openMenu(e, [moveMenu(same, row.typeID), ...spaceEntries(row.unavailable ? (row.recoverable ? all : []) : all.filter((id) => allDroneIDs.includes(id)), row.recoverable)]);
    }}>
    {#if row.sprite}<span class="state-sprite" title={row.activity} style:background-color={row.color ?? "rgba(255,255,255,0.75)"}
      style:mask-image={`url(${clientTexture(row.sprite)})`} style:-webkit-mask-image={`url(${clientTexture(row.sprite)})`}></span>{:else}<span class="state-sprite"></span>{/if}
    {@render picture(row.typeID, row.label)}
    <span class="name">{row.label} <span class="state-word" style:color={row.color}>{row.unavailable ?? row.activity}</span></span>
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

{#snippet menuList(entries: MenuEntry[], nested: boolean)}
  <ul class="menu" class:sub={nested} role="menu">
    {#each entries as entry}
      <li role="menuitem" class:has-sub={!!entry.sub}>
        {#if entry.sub}
          <button type="button" class="opener" onclick={(e) => e.stopPropagation()}>{entry.label}<span class="arrow">▸</span></button>
          {@render menuList(entry.sub, true)}
        {:else}
          <button type="button" disabled={busy || !!entry.disabled} title={entry.disabled ?? ""}
            onclick={() => { const act = entry.act; menu = null; if (act) void run(act); }}>{entry.label}{#if entry.disabled}<span class="why">{" - "}{entry.disabled}</span>{/if}</button>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

{#if naming}
  <NamePopup caption={say(GROUP_WORDS.caption)} label={say(GROUP_WORDS.field)} refusal={say(GROUP_WORDS.empty)} okWord={say(GROUP_WORDS.ok)} cancelWord={say(GROUP_WORDS.cancel)}
    onok={(name) => { const req = naming; naming = null; if (req) createSubGroup(req.droneGroupID, req.ids, name.trim()); }} oncancel={() => (naming = null)} />
{/if}

<div class="fly-drones">
  {#if warpWarningShown}
    <div class="warp-warning" role="alert">
      <span class="ww-whiteout"></span>
      <img class="ww-icon" src="/client-res/ui/texture/classes/agency/iconexclamation.png" alt="" />
      <p class="ww-text">{headerWord("UI/Drones/WarpWarningMessage", "You are about to warp off leaving your drones behind.")}</p>
      <div class="ww-buttons"><button type="button" onclick={stopAndRecall}>{headerWord("UI/Drones/StopAndRecall", "Stop and Recall")}</button></div>
    </div>
  {/if}
  <div class="group bay" class:closed={!bayOpen} class:drop={dropOn === "bay"} role="list" ondragover={dragOver("bay")} ondragleave={() => (dropOn = null)} ondrop={(e) => drop("bay", null, e)}>
    <div class="sec" role="button" tabindex="-1" onclick={() => (bayOpen = !bayOpen)} onkeydown={() => {}}
      oncontextmenu={(e) => openMenu(e, [...deleteMenu(), { label: say(MENU_WORDS.launch), disabled: bayRows.length ? null : "Nothing in the drone bay", act: () => flow.launchDrones(bayRows.flatMap((r) => r.itemIDs)) }])}>
      <span class="lbl"><span class="expander" class:open={bayOpen}></span>{headerWord(HEADER_WORDS.bay, "Drones in Bay")} ({bayCount})</span>
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
    <div class="sec" role="button" tabindex="-1" onclick={() => (spaceOpen = !spaceOpen)} onkeydown={() => {}}
      oncontextmenu={(e) => openMenu(e, [...deleteMenu(), ...spaceEntries(allDroneIDs, false)])}>
      <span class="lbl"><span class="expander" class:open={spaceOpen}></span>{headerWord(HEADER_WORDS.space, "Drones in Space")} ({maxActive === null ? outCount : `${outCount}/${maxActive}`})</span>
      <span class="commands">
        <span class="settings-host">
          <button type="button" class="command" title="Settings" aria-expanded={settingsOpen}
            onclick={(e) => { e.stopPropagation(); settingsOpen = !settingsOpen; }}>
            <span class="glyph" style:background-image={`url(${ICON.settings})`}></span>
          </button>
          {#if settingsOpen}
            <!-- DroneGroupHeaderInSpace.GetSettingsMenu: the two settings' checkboxes -->
            <ul class="menu settings" role="menu">
              {#each [["aggressive", MENU_WORDS.autoAttack, MENU_WORDS.autoAttackHint], ["focusFire", MENU_WORDS.focusFire, MENU_WORDS.focusFireHint]] as const as [name, label, hint]}
                <li role="menuitemcheckbox" aria-checked={$settingsNow[name]}>
                  <button type="button" title={say(hint)} onclick={(e) => { e.stopPropagation(); toggleSetting(name); }}>
                    <span class="check">{$settingsNow[name] ? "✓" : ""}</span>{say(label)}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </span>
        <button type="button" class="command" title={targetUnavailable ?? keyHint(say(MENU_WORDS.engage), "CmdDronesEngage")} disabled={busy || targetUnavailable !== null}
          onclick={(e) => { e.stopPropagation(); void run(() => primaryAction(allDroneIDs)); }}>
          <span class="glyph" style:background-image={`url(${ICON.engage})`}></span>
        </button>
        <button type="button" class="command" title={groupUnavailable ?? keyHint(say(MENU_WORDS.orbit), "CmdDronesReturnAndOrbit")} disabled={busy || groupUnavailable !== null || outCount === 0}
          onclick={(e) => { e.stopPropagation(); void run(() => flow.returnDronesAndOrbit(allDroneIDs)); }}>
          <span class="glyph" style:background-image={`url(${ICON.orbit})`}></span>
        </button>
        <span class="sep" aria-hidden="true"></span>
        <button type="button" class="command" title={groupUnavailable ?? keyHint(say(MENU_WORDS.bay), "CmdDronesReturnToBay")} disabled={busy || groupUnavailable !== null || outCount === 0}
          onclick={(e) => { e.stopPropagation(); void run(() => flow.recallDrones(allDroneIDs)); }}>
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

  {#if menu}
    <div class="menu-host" style:left={`${menu.x}px`} style:top={`${menu.y}px`}>{@render menuList(menu.entries, false)}</div>
  {/if}
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
  .fly-drones { position: relative; font-size: 13px; color: #fff; user-select: none; display: flex; flex-direction: column; min-height: 100%; }
  .group.bay { flex: 1 1 auto; min-height: 0; overflow: auto; }
  .group.bay.closed { flex: none; }
  /* BaseDroneGroupHeader: a bar with the expander and the label; its buttons hidden until the mouse is over it */
  .sec { display: flex; align-items: center; justify-content: space-between; height: 24px; margin: 4px 0 2px; padding: 0 4px 0 6px; background: rgba(255, 255, 255, 0.06); cursor: default; }
  .sec .commands { opacity: 0; visibility: hidden; transition: opacity .1s, visibility .1s; }
  .sec:hover .commands, .sec .commands:has(.menu) { opacity: 1; visibility: visible; }
  .lbl .expander { display: inline-block; width: 0; height: 0; margin-right: 6px; border-top: 5px solid rgba(255, 255, 255, 0.8); border-left: 4px solid transparent; border-right: 4px solid transparent; vertical-align: middle; transform: rotate(-90deg); transition: transform .1s; }
  .lbl .expander.open { transform: none; }
  .none { margin: 0; padding: 4px 6px; color: rgba(255, 255, 255, 0.5); }
  .lbl { font-size: 13px; color: rgba(255, 255, 255, 0.9); }
  .commands, .row-buttons { display: flex; gap: 2px; }
  /* DroneEntry.buttonCont: hidden, faded in (0.1 s) while the mouse is over the entry; left of the gauges */
  .row .row-buttons { opacity: 0; visibility: hidden; transition: opacity .1s, visibility .1s; margin-right: 4px; }
  .row:hover .row-buttons { opacity: 1; visibility: visible; }
  .command { width: 24px; height: 22px; padding: 0; border: 0; background: transparent; display: grid; place-items: center; cursor: pointer; opacity: 0.85; }
  .command:hover:not(:disabled) { opacity: 1; background: rgba(255, 255, 255, 0.08); }
  .command:disabled { opacity: 0.3; cursor: default; }
  .glyph { width: 16px; height: 16px; background: center / 16px 16px no-repeat; }
  /* DroneEntry: 24 high, the label 4 in (8 more a sublevel); an in-space one in the icons view 40 high with its 32 px icon */
  .row { display: flex; align-items: center; gap: 8px; padding: 0 4px; min-height: 24px; box-sizing: border-box; }
  .row.inspace { min-height: 40px; gap: 4px; }
  .state-sprite { width: 16px; height: 16px; flex: none; mask-size: 16px 16px; -webkit-mask-size: 16px 16px; mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat; }
  .row.inspace .picture { width: 32px; height: 32px; }
  .row.inspace .picture :global(.type-icon) { width: 32px; height: 32px; }
  .row:hover { background: rgba(255, 255, 255, 0.05); }
  .row.lost { opacity: 0.55; }
  /* a selected entry (the scroll's selection fill) and a part or group a drag may drop on */
  .row.selected { background: rgba(255, 255, 255, 0.12); }
  .group.drop, .row.grouphead.drop { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35); }
  .group { margin: 0; padding: 0; border: 0; background: none; }
  .picture { width: 24px; height: 24px; flex: none; display: grid; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gauges { display: flex; gap: 2px; flex: none; margin-right: 8px; }
  .gauges.unknown { opacity: 0.05; }
  .gauge { position: relative; width: 32px; height: 4px; background: rgb(153, 31, 36); overflow: hidden; }
  .gauge .health { position: absolute; left: 0; top: 0; bottom: 0; background: rgb(196, 196, 196); }
  .gauge .needle { position: absolute; top: 0; bottom: 0; width: 2px; background: #fff; }
  .count { font-size: 11px; color: rgb(176, 176, 169); }
  .activity { font-size: 11px; color: rgb(176, 176, 169); white-space: nowrap; }
  .state { margin: 0; padding: 4px 12px 6px; font-size: 11px; color: rgb(108, 110, 107); }
  .said { margin: 0; padding: 3px 12px; font-size: 11px; color: #d08a6a; }
  .menu-host { position: absolute; z-index: 10; }
  .menu { margin: 0; padding: 2px 0; list-style: none; min-width: 150px; background: rgba(20, 21, 20, 0.97); border: 1px solid rgba(255, 255, 255, 0.12); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6); }
  .menu button { display: block; width: 100%; padding: 4px 12px; border: 0; background: transparent; color: #ddd; text-align: left; font-size: 12px; cursor: pointer; }
  .menu button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); color: #fff; }
  .menu button:disabled { color: #777; cursor: default; }
  .why { color: #8a8a84; font-size: 11px; }
  .settings-host { position: relative; display: inline-flex; }
  .menu.settings { position: absolute; z-index: 10; right: 0; left: auto; top: 24px; min-width: 160px; }
  /* a submenu beside its entry while the mouse is over it */
  .menu li.has-sub { position: relative; }
  .menu.sub { display: none; position: absolute; left: 100%; top: -3px; }
  .menu li.has-sub:hover > .menu.sub { display: block; }
  .menu .opener { display: flex; justify-content: space-between; gap: 12px; }
  .arrow { color: #aaa; }
  /* sublevel 1: 8 further in (GetLabelLeft 4 + 8 * sublevel) */
  .row.sub { padding-left: 12px; }
  .row.grouphead { min-height: 24px; gap: 4px; cursor: default; }
  .row.grouphead .name { color: #fff; }
  .expander { width: 0; height: 0; border-left: 4px solid rgba(255, 255, 255, 0.6); border-top: 4px solid transparent; border-bottom: 4px solid transparent; margin: 0 4px; transition: transform .1s; }
  .expander.open { transform: rotate(90deg); }
  .star { width: 16px; height: 16px; background: center / 16px 16px no-repeat; flex: none; }
  .menu.settings .check { display: inline-block; width: 16px; }
  /* ButtonSeperatorLine between Return and Orbit and Return to Drone Bay */
  .sep { width: 1px; height: 14px; margin: 0 3px; align-self: center; background: rgba(255, 255, 255, 0.15); }
  .state-word { margin-left: 4px; }
</style>
