<script lang="ts">
  // The play page's Drones window, in the client's layout (as the eve-cs mirror draws it): two groups - IN BAY (n)
  // and IN SPACE (out/max) - each a header with its command icons (the client's eveicon/control_icons), and a row per
  // drone type: its icon, "Name x n". A bay row launches on a double-click or its icon; the in-space header engages
  // what is locked and recalls; a right-click on a row or header offers every order (engage, mine, salvage, return to
  // bay, reconnect, scoop). The orders, the ownership gates and the server's own refusal lines are DronesPanel's
  // (the workspace and mobile keep that panel); this is the same flow with the client's look.
  import { DRONE_NOT_UNDER_YOUR_CONTROL, NO_DRONE_UNDER_YOUR_CONTROL, panelErrorWords } from "../bridge/refusals.ts";
  import { droneActivityLabel } from "../bridge/drones.ts";
  import { canMyShipOrderDrone } from "../space/overview.ts";
  import { orderableDroneIDs, salvageDroneIDs } from "./droneFlight.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import { isSessionLost } from "../app/flow.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import TypeIcon from "./TypeIcon.svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { SpaceEntity } from "../store/types.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

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
    salvage: clientTexture("res:/ui/texture/eveicon/control_icons/salvage_16px.png"),
  };

  const snapshot = $derived($space.snapshot);
  const ship = $derived(snapshot?.ship ?? null);
  const autoTargetID = $derived($targeting.lockedTargetIDs[0] ?? 0);
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

  /** Drones in space by type and what they are doing, the ones ours to fly told apart (DronesPanel's R33 gate). */
  const spaceRows = $derived.by(() => {
    const byID = new Map<number, SpaceEntity>();
    for (const entity of snapshot?.entities ?? []) byID.set(entity.itemID, entity);
    const rows = new Map<string, { key: string; typeID: number | null; label: string; activity: string; itemIDs: number[]; unavailable: string | null; recoverable: boolean }>();
    for (const drone of $drones.inSpace ?? []) {
      const orderable = canMyShipOrderDrone(byID.get(drone.itemID) ?? null, ship?.itemID ?? null);
      const lost = drone.controlled === false || orderable === false;
      const activity = droneActivityLabel(drone.activity);
      const key = `${drone.typeID}:${activity}:${lost}`;
      const row = rows.get(key) ?? {
        key, typeID: drone.typeID, label: typeName(drone.typeID, "Drone"), activity, itemIDs: [],
        unavailable: lost ? DRONE_NOT_UNDER_YOUR_CONTROL : null, recoverable: drone.controlled === false,
      };
      row.itemIDs.push(drone.itemID);
      rows.set(key, row);
    }
    return [...rows.values()];
  });
  const outCount = $derived(($drones.inSpace ?? []).length);
  const maxActive = $derived($drones.limits.maxActiveDrones);

  const allDroneIDs = $derived(orderableDroneIDs($drones.inSpace, snapshot?.entities ?? null, ship?.itemID ?? null));
  const salvageIDs = $derived(salvageDroneIDs(allDroneIDs, $drones.inSpace, (typeID) => resolvedName($names.resolved, "typeGroup", typeID, "")));
  const groupUnavailable = $derived(outCount > 0 && allDroneIDs.length === 0 ? NO_DRONE_UNDER_YOUR_CONTROL : null);
  const targetUnavailable = $derived(groupUnavailable ?? (outCount === 0 ? "No drones in space" : autoTargetID <= 0 ? "Lock something first" : null));

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
  function spaceEntries(ids: readonly number[], recoverable: boolean): MenuEntry[] {
    const salvage = ids.filter((id) => salvageIDs.includes(id));
    return [
      { label: "Engage target", disabled: targetUnavailable, act: () => flow.engageDrones(ids, autoTargetID) },
      { label: "Mine", disabled: targetUnavailable, act: () => flow.mineWithDrones(ids, autoTargetID) },
      ...(salvage.length ? [{ label: "Salvage", act: () => flow.salvageDrones(salvage, autoTargetID > 0 ? autoTargetID : null) }] : []),
      { label: "Return to drone bay", disabled: ids.length ? null : outCount === 0 ? "No drones in space" : NO_DRONE_UNDER_YOUR_CONTROL, act: () => flow.recallDrones(ids) },
      ...(recoverable ? [
        { label: "Reconnect", act: () => flow.reconnectDrones(ids) },
        { label: "Scoop to drone bay", act: () => flow.scoopDrones(ids) },
      ] : []),
    ];
  }
</script>

<svelte:window onclick={() => (menu = null)} />

{#snippet picture(typeID: number | null, label: string)}
  <span class="picture"><TypeIcon {typeID} name={label} size="sm" /></span>
{/snippet}

<div class="fly-drones">
  <div class="group">
    <div class="sec" role="button" tabindex="-1" onclick={() => (bayOpen = !bayOpen)} onkeydown={() => {}}
      oncontextmenu={(e) => openMenu(e, [{ label: "Launch drones", disabled: bayRows.length ? null : "Nothing in the drone bay", act: () => flow.launchDrones(bayRows.flatMap((r) => r.itemIDs)) }])}>
      <span class="lbl" title="Drones in bay">In bay <b>({bayCount})</b></span>
      <span class="commands">
        <button type="button" class="command" title="Launch drones (Shift+F)" disabled={busy || !bayRows.length}
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
            <span class="name">{row.label} <span class="count">× {row.quantity}</span></span>
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
      <span class="lbl" title="Drones in local space">In space <b>({maxActive === null ? outCount : `${outCount}/${maxActive}`})</b></span>
      <span class="commands">
        <button type="button" class="command" title={targetUnavailable ?? "Engage target (F)"} disabled={busy || targetUnavailable !== null}
          onclick={(e) => { e.stopPropagation(); void run(() => flow.engageDrones(allDroneIDs, autoTargetID)); }}>
          <span class="glyph" style:background-image={`url(${ICON.engage})`}></span>
        </button>
        {#if salvageIDs.length > 0}
          <button type="button" class="command" title="Salvage" disabled={busy}
            onclick={(e) => { e.stopPropagation(); void run(() => flow.salvageDrones(salvageIDs, autoTargetID > 0 ? autoTargetID : null)); }}>
            <span class="glyph" style:background-image={`url(${ICON.salvage})`}></span>
          </button>
        {/if}
        <button type="button" class="command" title={groupUnavailable ?? "Return to drone bay (Ctrl+F)"} disabled={busy || groupUnavailable !== null || outCount === 0}
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
            <span class="name">{row.label} <span class="count">× {row.itemIDs.length}</span></span>
            <span class="activity">{row.unavailable ?? row.activity}</span>
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
  .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: rgb(108, 110, 107); }
  .lbl b { font-weight: 400; color: #fff; }
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
</style>
