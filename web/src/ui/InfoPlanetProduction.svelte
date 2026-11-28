<script lang="ts">
  import { onDestroy } from "svelte";
  import { getPlanetResources } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { assetSearchTextForType } from "../bridge/assetSearch.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { ContextMenu, type ContextEntry } from "../play/contextMenu.ts";
  import { fadePanelIn, notePanelClosed, panelDelay, placePointerPanel } from "../play/labelShortcutTooltip.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { findInPersonalAssets } from "./assetsSearch.ts";
  import { findInContracts } from "./contractsSearch.ts";
  import { startLinkDrag } from "./linkFollowers.ts";
  import { showMarketDetails } from "./marketDetails.ts";
  import { portal } from "./portal.ts";
  import { showInfo } from "./showInfo.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { store, flow, typeID }: { store: ClientStore; flow: AppFlow; typeID: number } = $props();
  const names = $derived(store.names);
  const words = $derived(store.words);
  const menu = new ContextMenu();
  const tooltipID = $props.id();
  onDestroy(() => { menu.close(); dismissTooltip(); });
  const labels = {
    resources: ["UI/PI/Common/ExtractableResources", "Extractable Resources"],
    tier: ["UI/PI/Common/TierRawResource", "Raw Resource"],
    productTier: ["UI/PI/Common/TierX", "Tier {tier}"],
    requiredFor: ["UI/InfoWindow/TabNames/RequiredFor", "Required For"],
    resource: ["UI/PI/Common/ProductNameAndTier", "{name} ({tier})"],
    info: ["UI/Commands/ShowInfo", "Show Info"],
    market: ["UI/Inventory/ItemActions/ViewTypesMarketDetails", "View Market Details"],
    contracts: ["UI/Inventory/ItemActions/FindInContracts", "Find in Contracts"],
    assets: ["UI/Inventory/ItemActions/FindPersonalAssets", "Find in Personal Assets"],
    exact: ["UI/Inventory/AssetSearch/KeywordTypeExact", "typeexact"],
  } as const;
  let ids = $state.raw<readonly number[] | null>(null);
  let requiredFor = $state.raw<Readonly<Record<number, readonly number[]>>>({});
  let done = $state(false);
  let facts = $state.raw<Awaited<ReturnType<AppFlow["typeFacts"]>>>(null);
  let tooltip = $state.raw<{ anchor: HTMLElement; id: number } | null>(null);
  let tooltipTimer: ReturnType<typeof setTimeout> | null = null;
  const tierByGroup: Readonly<Record<number, string>> = { 1042: "1", 1034: "2", 1040: "3", 1041: "4" };
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
    requiredFor = {};
    facts = null;
    done = false;
    flow.requestWords(Object.values(labels).map(([path]) => path));
    void getPlanetResources(planetType, flow.requestOptions()).then(result => {
      if (!current) return;
      ids = result?.typeIDs ?? null;
      if (!result?.typeIDs.length) return;
      requiredFor = result.requiredFor;
      const allTypes = [...new Set([...result.typeIDs, ...Object.values(result.requiredFor).flat()])];
      flow.requestNames(allTypes.map(id => ({ kind: "type", id })));
      void flow.typeFacts(allTypes).then(rows => { if (current) facts = rows; }).catch(() => {});
    }).catch(() => {}).finally(() => { if (current) done = true; });
    return () => { current = false; menu.close(); dismissTooltip(); };
  });
  const nameOf = (id: number) => resolvedName($names.resolved, "type", id, "");
  const resources = $derived((ids ?? []).map(id => ({ id, name: nameOf(id) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id));

  function productLabel(id: number, raw = false): string {
    const name = nameOf(id);
    const tier = raw ? word("tier") : word("productTier", { tier: tierByGroup[facts?.get(id)?.groupID ?? 0] ?? "1" });
    return name ? word("resource", { name, tier }) : "…";
  }
  function dismissTooltip(): void {
    if (tooltipTimer !== null) { clearTimeout(tooltipTimer); tooltipTimer = null; }
    if (tooltip) { tooltip = null; notePanelClosed(); }
  }
  function queueTooltip(anchor: HTMLElement, id: number): void {
    const wait = panelDelay(tooltip !== null);
    dismissTooltip();
    tooltipTimer = setTimeout(() => {
      tooltipTimer = null;
      if (anchor.isConnected) tooltip = { anchor, id };
    }, wait);
  }
  function placeTooltip(panel: HTMLElement, anchor: HTMLElement) {
    placePointerPanel(panel, anchor.getBoundingClientRect(), "BOTTOM_2");
    fadePanelIn(panel);
    window.addEventListener("scroll", dismissTooltip, true);
    window.addEventListener("resize", dismissTooltip);
    return { destroy: () => {
      window.removeEventListener("scroll", dismissTooltip, true);
      window.removeEventListener("resize", dismissTooltip);
    } };
  }

  function resourceMenu(x: number, y: number, resource: { id: number; name: string }): void {
    dismissTooltip();
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
        <button type="button" data-resource-type={resource.id} draggable="true"
          aria-describedby={tooltip?.id === resource.id ? tooltipID : undefined}
          onpointerenter={event => { if (event.pointerType !== "touch") queueTooltip(event.currentTarget, resource.id); }}
          onpointerleave={dismissTooltip}
          onfocus={event => { if (event.currentTarget.matches(":focus-visible")) queueTooltip(event.currentTarget, resource.id); }}
          onblur={dismissTooltip}
          onclick={() => { dismissTooltip(); showInfo({ kind: "type", typeID: resource.id }); }}
          ondragstart={event => { dismissTooltip(); startLinkDrag(event, `showinfo:${resource.id}`, resource.name); }}
          oncontextmenu={event => { event.preventDefault(); resourceMenu(event.clientX, event.clientY, resource); }}
          onkeydown={event => {
            if (event.key === "Escape" && (tooltip || tooltipTimer !== null)) {
              event.stopPropagation();
              dismissTooltip();
              return;
            }
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            resourceMenu(rect.left, rect.bottom, resource);
          }}>
          <TypeIcon typeID={resource.id} name={resource.name} size="sm" />
          <span>{productLabel(resource.id, true)}</span>
          <span class="info" aria-hidden="true">ⓘ</span>
        </button>
      </li>
    {/each}
  </ul>
{/if}

{#if tooltip}
  <div id={tooltipID} role="tooltip" class="resource-tooltip" use:portal use:placeTooltip={tooltip.anchor}>
    <strong data-resource-tooltip-title>{productLabel(tooltip.id, true)}</strong>
    {#if requiredFor[tooltip.id]?.length}
      <div class="required" data-required-for>{word("requiredFor")}</div>
      {#each requiredFor[tooltip.id] as output}
        <div class="product" data-output-type={output}>
          <TypeIcon typeID={output} name={nameOf(output)} size="sm" />
          <span>{productLabel(output)}</span>
        </div>
      {/each}
    {/if}
  </div>
{/if}

<style>
  ul { list-style: none; padding: 0; margin: 0; }
  button { display: flex; align-items: center; width: 100%; min-height: 27px; padding: 0 4px; gap: 8px;
    text-align: left; background: transparent; border: 0; }
  button:hover, button:focus-visible { background: #ffffff15; }
  .info { margin-inline-start: auto; }
  .resource-tooltip { position: fixed; pointer-events: none; z-index: 100000; width: max-content;
    max-width: min(26rem, 85vw); padding: 11px 14px; border: 1px solid #53636f;
    background: #14191f; color: #ebeff2; font-size: 13px; }
  .resource-tooltip strong { font-size: 15px; }
  .required { margin-top: 10px; margin-bottom: 2px; }
  .product { display: flex; align-items: center; gap: 8px; padding-bottom: 2px; }
  .product :global(.type-icon) { width: 28px; height: 28px; flex: 0 0 28px; }
</style>
