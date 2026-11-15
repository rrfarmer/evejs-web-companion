<script lang="ts">
  import type { MarketGroupNode, MarketTypeMatch } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { FITTING_CHARGE_DRAG_MIME } from "./dragDrop.ts";
  import { showInfo } from "./showInfo.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { flow, busy, onFit, word }: {
    flow: AppFlow;
    busy: boolean;
    onFit: (typeID: number) => void;
    word: (label: string) => string;
  } = $props();
  const AMMUNITION_GROUP = 11;
  const CHARGE_CATEGORY = 8;
  type Branch = { groups: readonly MarketGroupNode[]; types: readonly MarketTypeMatch[] };
  let branches = $state<Record<number, Branch>>({});
  const pending = new Set<number>();
  let query = $state("");
  let results = $state.raw<readonly MarketTypeMatch[]>([]);
  let loadedSearch = $state<string | null>(null);
  let error = $state("");
  const search = $derived(query.trim());

  function startChargeDrag(event: DragEvent, type: MarketTypeMatch) {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData(FITTING_CHARGE_DRAG_MIME, String(type.typeID));
    event.dataTransfer.setData("text/plain", type.name);
    event.dataTransfer.effectAllowed = "copy";
  }

  async function openBranch(groupID: number, hasTypes: boolean) {
    if (branches[groupID] || pending.has(groupID)) return;
    pending.add(groupID);
    try {
      const [groups, items] = await Promise.all([
        flow.loadMarketGroups(groupID),
        hasTypes ? flow.loadMarketGroupTypes(groupID) : null,
      ]);
      branches[groupID] = { groups, types: items?.types ?? [] };
    } catch {
      error = "Could not load charges.";
    } finally { pending.delete(groupID); }
  }

  $effect(() => { void openBranch(AMMUNITION_GROUP, false); });
  $effect(() => {
    const text = search;
    if (text.length < 2) return;
    let current = true;
    const timer = setTimeout(() => {
      void flow.findMarketTypes(text, CHARGE_CATEGORY).then(rows => {
        if (current) { error = ""; results = rows; loadedSearch = text; }
      }).catch(() => { if (current) error = "Could not search for charges."; });
    }, 180);
    return () => { clearTimeout(timer); current = false; };
  });
</script>

{#snippet charges(types: readonly MarketTypeMatch[])}
  <ul>
    {#each types as type (type.typeID)}
      <li>
        <button type="button" class="charge" disabled={busy} title={type.name} draggable="true" ondragstart={event => startChargeDrag(event, type)}
          aria-label={`Load ${type.name}`} onclick={() => onFit(type.typeID)}>
          <TypeIcon typeID={type.typeID} name={type.name} size="sm" />{type.name}
        </button>
        <button type="button" class="charge-info" aria-label={`Show Info ${type.name}`} onclick={() => showInfo({ kind: "type", typeID: type.typeID })}>ⓘ</button>
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet browse(groupID: number)}
  {@const branch = branches[groupID]}
  {#if branch}
    {#each branch.groups as group (group.marketGroupID)}
      <details ontoggle={event => { if (event.currentTarget.open) void openBranch(group.marketGroupID, group.hasTypes); }}>
        <summary>{group.name}</summary>
        {@render browse(group.marketGroupID)}
      </details>
    {/each}
    {#if branch.types.length}{@render charges(branch.types)}{/if}
  {:else if !error}<p role="status">Loading charges…</p>{/if}
{/snippet}

<div class="charge-browser">
  <input type="search" aria-label="Search charges" placeholder="Search charges" bind:value={query} />
  {#if error}<p role="alert">{error}</p>{/if}
  {#if search.length < 2}
    {@render browse(AMMUNITION_GROUP)}
  {:else if loadedSearch === search}
    {#if results.length}{@render charges(results)}{:else}<p>{word("UI/Fitting/FittingWindow/NoChargesFound") || "No charges found."}</p>{/if}
  {:else if !error}<p role="status">Searching…</p>{/if}
</div>

<style>
  .charge-browser { padding: 6px 0; }
  input { width: 100%; margin-bottom: 6px; }
  details { padding: 3px 0 0 8px; }
  summary { cursor: pointer; }
  ul { list-style: none; margin: 0; padding: 2px 8px; }
  li { display: flex; align-items: center; }
  button { border: 0; background: transparent; color: inherit; cursor: pointer; }
  button:hover, button:focus-visible { background: #ffffff24; }
  .charge { flex: 1; min-height: 27px; display: flex; align-items: center; gap: 8px; text-align: left; }
  .charge:disabled { opacity: .55; cursor: default; }
</style>
