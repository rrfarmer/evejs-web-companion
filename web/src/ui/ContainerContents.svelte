<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow, AssetContainerContents } from "../app/flow.ts";
  import { formatTemplate, locationKind, plainText } from "../bridge/clientWords.ts";
  import { containerFlagLabel } from "../bridge/containerContents.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import type { InventoryItemRow } from "../store/types.ts";
  import DesktopWindow from "./DesktopWindow.svelte";
  import TypeIcon from "./TypeIcon.svelte";
  import { showInfo } from "./showInfo.ts";

  let { store, flow, view }: { store: ClientStore; flow: AppFlow; view: AssetContainerContents } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const LABELS = {
    container: "UI/Menusvc/ItemsInContainerHint", ship: "UI/Menusvc/ItemsInShipHint",
    containerHint: "UI/Menusvc/ItemsInContainerHint2", shipHint: "UI/Menusvc/ItemsInShipHint2",
    filter: "UI/Inventory/Filter", empty: "UI/Common/NothingFound",
    name: "UI/Inventory/InvItemNameShort", group: "UI/Inventory/ItemGroup",
    location: "UI/Common/Location", quantity: "UI/Common/Quantity",
  } as const;
  const nameOf = (kind: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, kind, id);
  function word(label: string, fallback: string, values: Record<string, string> = {}): string {
    const template = $words.templates[label];
    return typeof template === "string" ? plainText(formatTemplate(template, values, { nameOf })) || fallback : fallback;
  }
  function flagName(flagID: number | null): string {
    const label = containerFlagLabel(flagID);
    return label ? word(...label) : "";
  }

  let filter = $state("");
  let sort = $state<{ key: "name" | "group" | "location" | "quantity"; descending: boolean }>({ key: "name", descending: false });
  let win = $state({ x: 0, y: 0, w: 500, h: 400, z: 1, minimized: false });
  onMount(() => {
    flow.requestWords(Object.values(LABELS));
    win.w = Math.min(500, window.innerWidth);
    win.h = Math.min(400, window.innerHeight);
    win.x = Math.floor((window.innerWidth - win.w) / 2);
    win.y = Math.floor((window.innerHeight - win.h) / 2);
  });
  $effect(() => {
    const labels = [...new Set((view.rows ?? []).flatMap(row => {
      const label = containerFlagLabel(row.flagID);
      return label ? [label[0]] : [];
    }))];
    if (labels.length > 0) flow.requestWords(labels);
  });
  $effect(() => {
    if (view.rows !== null && !view.isShip && sort.key === "location") sort = { key: "name", descending: false };
  });
  const visible = $derived((view.rows ?? []).map(row => ({
    row,
    name: nameOf("type", row.typeID),
    group: row.groupID === null ? "—" : nameOf("group", row.groupID),
    location: flagName(row.flagID),
  })).filter(entry => entry.name.toLowerCase().includes(filter.trim().toLowerCase())).sort((a, b) => {
    const compare = sort.key === "quantity" ? a.row.quantity - b.row.quantity : a[sort.key].localeCompare(b[sort.key]);
    return (sort.descending ? -compare : compare) || a.row.itemID - b.row.itemID;
  }));
  const container = $derived(nameOf("type", view.typeID));
  const title = $derived(view.isShip ? word(LABELS.ship, "Items in Ship") : word(LABELS.container, "Items in Container"));
  function changeSort(key: typeof sort.key): void {
    sort = { key, descending: sort.key === key && !sort.descending };
  }
  function info(row: InventoryItemRow): void {
    showInfo({ kind: "type", typeID: row.typeID, itemID: row.itemID });
  }
</script>

<div class="container-contents-layer">
  <DesktopWindow {win} {title} focused={true} onFocus={() => {}}
    onClose={() => flow.closeAssetContainerContents(view.n)} onMove={(x, y) => { win.x = x; win.y = y; }}
    onResize={(w, h) => { win.w = Math.max(Math.min(500, window.innerWidth), w); win.h = Math.max(256, h); }}>
    <section class="container-contents" data-window="container-contents" data-container-id={view.itemID} data-location-id={view.stationID}
      aria-busy={view.rows === null && view.error === null}>
      <div class="contents-heading" title={nameOf(locationKind(view.stationID), view.stationID)}>
        {word(view.isShip ? LABELS.shipHint : LABELS.containerHint, `Items in ${container}`, { containerName: container })}
      </div>
      <input type="search" maxlength="64" bind:value={filter} aria-label={word(LABELS.filter, "Filter")} placeholder={word(LABELS.filter, "Filter")} />
      {#if view.error}
        <p role="status">{view.error}</p>
      {:else if view.rows === null}
        <p role="status">Loading…</p>
      {:else}
        <div class="contents-scroll">
          <table>
            <thead>
              <tr>
                <th aria-sort={sort.key === "name" ? sort.descending ? "descending" : "ascending" : "none"}><button type="button" onclick={() => changeSort("name")}>{word(LABELS.name, "Name")}</button></th>
                <th aria-sort={sort.key === "group" ? sort.descending ? "descending" : "ascending" : "none"}><button type="button" onclick={() => changeSort("group")}>{word(LABELS.group, "Group")}</button></th>
                {#if view.isShip}<th aria-sort={sort.key === "location" ? sort.descending ? "descending" : "ascending" : "none"}><button type="button" onclick={() => changeSort("location")}>{word(LABELS.location, "Location")}</button></th>{/if}
                <th aria-sort={sort.key === "quantity" ? sort.descending ? "descending" : "ascending" : "none"}><button type="button" onclick={() => changeSort("quantity")}>{word(LABELS.quantity, "Quantity")}</button></th>
              </tr>
            </thead>
            <tbody>
              {#each visible as { row, name, group, location } (row.itemID)}
                <tr data-item-id={row.itemID}>
                  <td><button class="contents-item" type="button" onclick={() => info(row)} title={name}>
                    <TypeIcon typeID={row.typeID} {name} size="sm" /><span>{name}</span>
                  </button></td>
                  <td>{group}</td>
                  {#if view.isShip}<td>{location}</td>{/if}
                  <td>{row.quantity.toLocaleString()}</td>
                </tr>
              {:else}
                <tr><td class="contents-empty" colspan={view.isShip ? 4 : 3}>{word(LABELS.empty, "Nothing Found")}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  </DesktopWindow>
</div>

<style>
  .container-contents-layer { position: fixed; inset: 0; z-index: 44; pointer-events: none; }
  .container-contents-layer :global(.win) { pointer-events: auto; }
  .container-contents { display: flex; flex-direction: column; gap: .45rem; height: 100%; box-sizing: border-box; padding: .55rem; font-size: .8rem; }
  .contents-heading { text-align: center; }
  input { align-self: flex-end; width: 120px; margin: 0; }
  .contents-scroll { overflow: auto; }
  table { width: 100%; border-collapse: collapse; text-align: left; font-size: inherit; }
  th { position: sticky; top: 0; background: var(--win-bg, #171a1c); }
  th, td { padding: .16rem .33rem; border-bottom: 1px solid #ffffff12; }
  th:last-child, td:not(.contents-empty):last-child { text-align: right; }
  th button, .contents-item { background: transparent; border: 0; color: inherit; padding: 0; text-align: inherit; font: inherit; }
  .contents-item { display: flex; align-items: center; gap: .35rem; min-height: 30px; }
  .contents-item:hover { text-decoration: underline; }
  .contents-empty { text-align: center; opacity: .8; padding: .8rem 0; }
</style>
