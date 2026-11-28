<script lang="ts">
  import { onDestroy } from "svelte";
  import { getBeltOreTypes } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { assetSearchTextForType } from "../bridge/assetSearch.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { ContextMenu, type ContextEntry } from "../play/contextMenu.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { findInPersonalAssets } from "./assetsSearch.ts";
  import { findInContracts } from "./contractsSearch.ts";
  import { startLinkDrag } from "./linkFollowers.ts";
  import { showMarketDetails } from "./marketDetails.ts";
  import { showInfo } from "./showInfo.ts";
  import { compareType } from "./typeCompare.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { store, flow, itemID }: { store: ClientStore; flow: AppFlow; itemID: number | null } = $props();
  const names = $derived(store.names), words = $derived(store.words);
  const menu = new ContextMenu();
  onDestroy(() => menu.close());
  let types = $state.raw<readonly number[]>([]);
  let selected = $state<number | null>(null);
  let reading = $state(false);
  let unavailable = $state(false);
  let facts = $state.raw<Awaited<ReturnType<AppFlow["typeFacts"]>>>(null);
  const labels = {
    info: ["UI/Commands/ShowInfo", "Show Info"],
    market: ["UI/Inventory/ItemActions/ViewTypesMarketDetails", "View Market Details"],
    contracts: ["UI/Inventory/ItemActions/FindInContracts", "Find in Contracts"],
    assets: ["UI/Inventory/ItemActions/FindPersonalAssets", "Find in Personal Assets"],
    compare: ["UI/Compare/CompareButton", "Compare"],
    exact: ["UI/Inventory/AssetSearch/KeywordTypeExact", "typeExact"],
  } as const;
  const nameOf = (typeID: number) => resolvedName($names.resolved, "type", typeID, "");
  function word(key: keyof typeof labels): string {
    const [path, fallback] = labels[key];
    return plainText($words.templates[path] ?? fallback);
  }
  const info = (typeID: number) => showInfo({ kind: "type", typeID });

  $effect(() => {
    const id = itemID;
    types = [];
    facts = null;
    selected = null;
    unavailable = false;
    reading = id !== null;
    if (id === null) return;
    flow.requestWords(Object.values(labels).map(([path]) => path));
    let active = true;
    void getBeltOreTypes(id, flow.requestOptions()).then(ids => {
      if (!active) return;
      unavailable = ids === null;
      types = ids ?? [];
      if (!ids?.length) return;
      flow.requestNames(ids.map(typeID => ({ kind: "type", id: typeID })));
      void flow.typeFacts(ids).then(read => { if (active) facts = read; }).catch(() => {});
    }).catch(() => { if (active) unavailable = true; }).finally(() => { if (active) reading = false; });
    return () => { active = false; menu.close(); };
  });

  function openMenu(typeID: number, x: number, y: number): void {
    selected = typeID;
    const type = facts?.get(typeID);
    const entry = (key: keyof typeof labels, run: () => void): ContextEntry => ({ path: labels[key][0], label: word(key), run });
    const entries: ContextEntry[] = [{ ...entry("info", () => info(typeID)), info: true }];
    if (type?.marketGroupID) entries.push(entry("market", () => showMarketDetails(typeID)));
    if (type?.published) entries.push(entry("contracts", () => findInContracts(typeID)),
      entry("assets", () => findInPersonalAssets(assetSearchTextForType(word("exact"), nameOf(typeID)))),
      entry("compare", () => compareType(typeID)));
    menu.open(x, y, entries);
  }
</script>

{#if reading}
  <p role="status">Reading…</p>
{:else if unavailable}
  <p role="status">Ore types are unavailable.</p>
{:else}
  <ul aria-label={$words.templates["UI/Agency/OreTypesInBelt"] ?? "Potential Ores"} data-belt-ores>
    {#each types as typeID (typeID)}
      {@const name = nameOf(typeID)}
      <li data-belt-ore-type={typeID} class:selected={selected === typeID}
        oncontextmenu={event => { event.preventDefault(); openMenu(typeID, event.clientX, event.clientY); }}>
        <button class="ore" type="button" aria-pressed={selected === typeID} draggable="true"
          onclick={() => { selected = typeID; }} ondblclick={() => info(typeID)}
          ondragstart={event => { selected = typeID; startLinkDrag(event, `showinfo:${typeID}`, name); }}
          onkeydown={event => {
            if (event.key === "Enter") { event.preventDefault(); info(typeID); return; }
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu(typeID, rect.left, rect.bottom);
          }}>
          <TypeIcon {typeID} {name} />
          <span class="ore-name">{name || "…"}</span>
        </button>
        <button class="info" type="button" aria-label={word("info")} title={word("info")} onclick={() => info(typeID)}>ⓘ</button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  ul { list-style: none; padding: 0 4px; margin: 0; }
  li { display: flex; align-items: center; min-height: 27px; }
  li:hover, li.selected { background: #ffffff15; }
  button { border: 0; background: transparent; }
  .ore { display: flex; flex: 1; align-items: center; gap: 8px; min-width: 0; min-height: 27px; padding: 0 1px; text-align: left; }
  .ore :global(.type-icon) { width: 24px; height: 24px; flex: 0 0 24px; }
  .info { flex: none; }
</style>
