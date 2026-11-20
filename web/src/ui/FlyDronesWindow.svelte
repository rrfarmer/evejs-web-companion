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
  import { droneSettings, droneSettingsFor, setDroneSetting } from "./droneSettings.ts";
  import { shortcutOf } from "../play/shortcutKeys.ts";
  import { onMount } from "svelte";
  import { canMyShipOrderDrone } from "../space/overview.ts";
  import { miningDroneIDs, orderableDroneIDs, salvageDroneIDs } from "./droneFlight.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import { isSessionLost } from "../app/flow.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import TypeIcon from "./TypeIcon.svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { SpaceEntity } from "../store/types.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // droneGroupHeader.UpdateLabelText: "%s (%s)" of UI/Inflight/Drone/DronesInBay, "%s (%s/%s)" of DronesInSpace, in an
  // EveLabelMedium of TextColor.HIGHLIGHT
  const HEADER_WORDS = { bay: "UI/Inflight/Drone/DronesInBay", space: "UI/Inflight/Drone/DronesInSpace" } as const;
  flow.requestWords(Object.values(HEADER_WORDS));
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
  const ICON = {
    launch: clientTexture("res:/ui/texture/eveicon/control_icons/launch_drones_16px.png"),
    engage: clientTexture("res:/ui/texture/eveicon/control_icons/engage_target_16px.png"),
    recall: clientTexture("res:/ui/texture/eveicon/control_icons/recall_drones_16px.png"),
    orbit: clientTexture("res:/ui/texture/eveicon/control_icons/return_and_orbit_16px.png"),
    settings: clientTexture("res:/ui/texture/eveicon/system_icons/settings_16px.png"),
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
  const ship = $derived(snapshot?.ship ?? null);
  const autoTargetID = $derived($activeTarget ?? 0);
  const typeName = (typeID: number | null, fallback: string) => resolvedName($names.resolved, "type", typeID, fallback);

  /** The bay by type: every stack of a type in one row, its quantity summed (the client's window groups so). */
  const bayRows = $derived.by(() => {
    const byType = new Map<number, { typeID: number; label: string; quantity: number; itemIDs: number[] }>();
    for (const stack of $drones.bay ?? []) {
      const row = byType.get(stack.typeID) ?? { typeID: stack.typeID, label: typeName(stack.typeID, "Unknown drone"), quantity: 0, itemIDs: [] };
      // (a quantity of -1 is a singleton: one assembled drone, as invItem quantity says it)
      row.quantity += stack.quantity < 0 ? 1 : stack.quantity;
      row.itemIDs.push(stack.itemID);
      byType.set(stack.typeID, row);
    }
    return [...byType.values()];
  });
  const bayCount = $derived(bayRows.reduce((n, r) => n + r.quantity, 0));

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
      };
    });
  });
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
    for (const stack of $drones.bay ?? []) refs.push({ kind: "type", id: stack.typeID });
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
  type MenuEntry = { label: string; disabled?: string | null; act: () => Promise<void> };
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

<div class="fly-drones">
  <div class="group">
    <div class="sec" role="button" tabindex="-1" onclick={() => (bayOpen = !bayOpen)} onkeydown={() => {}}
      oncontextmenu={(e) => openMenu(e, [{ label: "Launch drones", disabled: bayRows.length ? null : "Nothing in the drone bay", act: () => flow.launchDrones(bayRows.flatMap((r) => r.itemIDs)) }])}>
      <span class="lbl">{headerWord(HEADER_WORDS.bay, "Drones in Bay")} ({bayCount})</span>
      <span class="commands">
        <button type="button" class="command" title={keyHint(say(MENU_WORDS.launch), "CmdLaunchFavoriteDrones")} disabled={busy || !bayRows.length}
          onclick={(e) => { e.stopPropagation(); void run(() => flow.launchDrones(bayRows.flatMap((r) => r.itemIDs))); }}>
          <span class="glyph" style:background-image={`url(${ICON.launch})`}></span>
        </button>
      </span>
    </div>
    {#if bayOpen}
      {#if $drones.bay === null}
        <p class="state">{$drones.loaded ? "Your drone bay could not be read." : "Looking…"}</p>
      {:else}
        {#each bayRows as row (row.typeID)}
          <div class="row" role="listitem" title="Double-click to launch; right-click for more"
            ondblclick={() => run(() => flow.launchDrones(row.itemIDs))}
            oncontextmenu={(e) => openMenu(e, [{ label: "Launch drones", act: () => flow.launchDrones(row.itemIDs) }])}>
            {@render picture(row.typeID, row.label)}
            <!-- dronesWindow: a stack's label UI/Inflight/DroneBayEntryWithStacksize, "Mining Drone I (2)" (3698585, through
                 gridcheck); one drone its name alone -->
            <span class="name">{row.quantity > 1 ? `${row.label} (${row.quantity})` : row.label}</span>
            <span class="row-buttons">
              <button type="button" class="command" title="Launch drones" disabled={busy} onclick={() => run(() => flow.launchDrones(row.itemIDs))}>
                <span class="glyph" style:background-image={`url(${ICON.launch})`}></span>
              </button>
            </span>
          </div>
        {/each}
      {/if}
    {/if}
  </div>

  <div class="group">
    <div class="sec" role="button" tabindex="-1" onclick={() => (spaceOpen = !spaceOpen)} onkeydown={() => {}}
      oncontextmenu={(e) => openMenu(e, spaceEntries(allDroneIDs, false))}>
      <span class="lbl">{headerWord(HEADER_WORDS.space, "Drones in Space")} ({maxActive === null ? outCount : `${outCount}/${maxActive}`})</span>
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
        {#each spaceRows as row (row.key)}
          <div class="row" class:lost={row.unavailable !== null} role="listitem" title={row.unavailable ?? "Right-click for orders"}
            oncontextmenu={(e) => openMenu(e, spaceEntries(row.unavailable ? (row.recoverable ? row.itemIDs : []) : row.itemIDs.filter((id) => allDroneIDs.includes(id)), row.recoverable))}>
            {@render picture(row.typeID, row.label)}
            <span class="name">{row.label} <span class="state-word" style:color={row.color}>{row.unavailable ?? row.activity}</span></span>
          </div>
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
    <ul class="menu" style:left={`${menu.x}px`} style:top={`${menu.y}px`} role="menu">
      {#each menu.entries as entry}
        <li role="menuitem">
          <button type="button" disabled={busy || !!entry.disabled} title={entry.disabled ?? ""}
            onclick={() => { const act = entry.act; menu = null; void run(act); }}>{entry.label}{#if entry.disabled}<span class="why">{" - "}{entry.disabled}</span>{/if}</button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  /* the eve-cs mirror's drone window: 11 px upper-case section labels in grey with white counts on a 2 % white strip,
     29 px rows of a 24 px type icon, the name at 13 px and its count at 11 px, 16 px command icons */
  .fly-drones { position: relative; font-size: 13px; color: #fff; user-select: none; }
  .sec { display: flex; align-items: center; justify-content: space-between; padding: 8px 8px 5px 12px; background: rgba(255, 255, 255, 0.02); cursor: default; }
  .lbl { font-size: 14px; color: rgba(255, 255, 255, 0.9); }
  .commands, .row-buttons { display: flex; gap: 2px; }
  .command { width: 24px; height: 22px; padding: 0; border: 0; background: transparent; display: grid; place-items: center; cursor: pointer; opacity: 0.85; }
  .command:hover:not(:disabled) { opacity: 1; background: rgba(255, 255, 255, 0.08); }
  .command:disabled { opacity: 0.3; cursor: default; }
  .glyph { width: 16px; height: 16px; background: center / 16px 16px no-repeat; }
  .row { display: flex; align-items: center; gap: 8px; padding: 2px 8px 2px 12px; min-height: 29px; box-sizing: border-box; }
  .row:hover { background: rgba(255, 255, 255, 0.05); }
  .row.lost { opacity: 0.55; }
  .group { margin: 0; padding: 0; border: 0; background: none; }
  .picture { width: 24px; height: 24px; flex: none; display: grid; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .count { font-size: 11px; color: rgb(176, 176, 169); }
  .activity { font-size: 11px; color: rgb(176, 176, 169); white-space: nowrap; }
  .state { margin: 0; padding: 4px 12px 6px; font-size: 11px; color: rgb(108, 110, 107); }
  .said { margin: 0; padding: 3px 12px; font-size: 11px; color: #d08a6a; }
  .menu { position: absolute; z-index: 10; margin: 0; padding: 2px 0; list-style: none; min-width: 150px; background: rgba(20, 21, 20, 0.97); border: 1px solid rgba(255, 255, 255, 0.12); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6); }
  .menu button { display: block; width: 100%; padding: 4px 12px; border: 0; background: transparent; color: #ddd; text-align: left; font-size: 12px; cursor: pointer; }
  .menu button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); color: #fff; }
  .menu button:disabled { color: #777; cursor: default; }
  .why { color: #8a8a84; font-size: 11px; }
  .settings-host { position: relative; display: inline-flex; }
  .menu.settings { right: 0; left: auto; top: 24px; min-width: 160px; }
  .menu.settings .check { display: inline-block; width: 16px; }
  /* ButtonSeperatorLine between Return and Orbit and Return to Drone Bay */
  .sep { width: 1px; height: 14px; margin: 0 3px; align-self: center; background: rgba(255, 255, 255, 0.15); }
  .state-word { margin-left: 4px; }
</style>
