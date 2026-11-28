<script lang="ts">
  import { onDestroy } from "svelte";
  import { getPlanetResourceTypes } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { assetSearchTextForType } from "../bridge/assetSearch.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { ContextMenu, type ContextEntry } from "../play/contextMenu.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { findInPersonalAssets } from "./assetsSearch.ts";
  import { findInContracts } from "./contractsSearch.ts";
  import { startLinkDrag } from "./linkFollowers.ts";
  import { showMarketDetails } from "./marketDetails.ts";
  import { showInfo } from "./showInfo.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { store, flow, typeID }: { store: ClientStore; flow: AppFlow; typeID: number } = $props();
  const names = $derived(store.names);
  const words = $derived(store.words);
  const menu = new ContextMenu();
  onDestroy(() => menu.close());
  const labels = {
    resources: ["UI/PI/Common/ExtractableResources", "Extractable Resources"],
    tier: ["UI/PI/Common/TierRawResource", "Raw Resource"],
    resource: ["UI/PI/Common/ProductNameAndTier", "{name} ({tier})"],
    info: ["UI/Commands/ShowInfo", "Show Info"],
    market: ["UI/Inventory/ItemActions/ViewTypesMarketDetails", "View Market Details"],
    contracts: ["UI/Inventory/ItemActions/FindInContracts", "Find in Contracts"],
    assets: ["UI/Inventory/ItemActions/FindPersonalAssets", "Find in Personal Assets"],
    exact: ["UI/Inventory/AssetSearch/KeywordTypeExact", "typeexact"],
  } as const;
  let ids = $state.raw<readonly number[] | null>(null);
  let done = $state(false);
  let facts = $state.raw<Awaited<ReturnType<AppFlow["typeFacts"]>>>(null);
  function word(key: keyof typeof labels, args: Record<string, string> = {}): string {
    const [path, fallback] = labels[key];
    return plainText(formatTemplate($words.templates[path] ?? fallback, args, { nameOf: () => "" }));
  }
  function entry(key: keyof typeof labels, run: () => void): ContextEntry {
    return { path: labels[key][0], label: word(key), run };
  }
  $effect(() => {
    const planetType = typeID;
    let current = true;
    ids = null;
    facts = null;
    done = false;
    flow.requestWords(Object.values(labels).map(([path]) => path));
    void getPlanetResourceTypes(planetType, flow.requestOptions()).then(result => {
      if (!current) return;
      ids = result;
      if (!result?.length) return;
      flow.requestNames(result.map(id => ({ kind: "type", id })));
      void flow.typeFacts(result).then(rows => { if (current) facts = rows; }).catch(() => {});
    }).catch(() => {}).finally(() => { if (current) done = true; });
    return () => { current = false; menu.close(); };
  });
  const resources = $derived((ids ?? []).map(id => ({ id, name: resolvedName($names.resolved, "type", id, "") }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id));

  function resourceMenu(x: number, y: number, resource: { id: number; name: string }): void {
    const { id, name } = resource;
    const fact = facts?.get(id);
    const entries = [{ ...entry("info", () => showInfo({ kind: "type", typeID: id })), info: true } as ContextEntry];
    if (fact?.marketGroupID != null) entries.push(entry("market", () => showMarketDetails(id)));
    if (fact?.published) {
      entries.push(entry("contracts", () => findInContracts(id)),
        entry("assets", () => findInPersonalAssets(assetSearchTextForType(word("exact"), name))));
    }
    menu.open(x, y, entries);
  }
</script>

{#if !done}
  <p role="status">Reading…</p>
{:else if ids === null}
  <p role="status">Planetary resource data is unavailable.</p>
{:else if resources.length}
  <h3>{word("resources")}</h3>
  <ul>
    {#each resources as resource (resource.id)}
      <li>
        <button type="button" data-resource-type={resource.id} title={word("info")} draggable="true"
          onclick={() => showInfo({ kind: "type", typeID: resource.id })}
          ondragstart={event => startLinkDrag(event, `showinfo:${resource.id}`, resource.name)}
          oncontextmenu={event => { event.preventDefault(); resourceMenu(event.clientX, event.clientY, resource); }}
          onkeydown={event => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            resourceMenu(rect.left, rect.bottom, resource);
          }}>
          <TypeIcon typeID={resource.id} name={resource.name} size="sm" />
          <span>{resource.name ? word("resource", { name: resource.name, tier: word("tier") }) : "…"}</span>
          <span class="info" aria-hidden="true">ⓘ</span>
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  ul { list-style: none; padding: 0; margin: 0; }
  button { display: flex; align-items: center; width: 100%; min-height: 27px; padding: 0 4px; gap: 8px;
    text-align: left; background: transparent; border: 0; }
  button:hover, button:focus-visible { background: #ffffff15; }
  .info { margin-inline-start: auto; }
</style>
