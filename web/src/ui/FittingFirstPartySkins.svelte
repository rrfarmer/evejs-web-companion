<script lang="ts">
  import { untrack } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { loadFirstPartySkinCatalog, type FirstPartySkin } from "../bridge/firstPartySkins.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import ShipInfoPreview from "./ShipInfoPreview.svelte";

  let { store, flow, shipID, shipTypeID }: { store: ClientStore; flow: AppFlow; shipID: number; shipTypeID: number } = $props();
  const words = $derived(store.words);
  const station = $derived(store.station);
  const pilot = $derived($station.online?.characterID);
  const applied = $derived(flow.shipSkinrApplied);
  const currentSkinID = $derived($applied?.shipID === shipID && $applied.characterID === pilot
    ? $applied.firstPartySkinID : null);
  let rows = $state.raw<readonly FirstPartySkin[]>([]);
  let licenses = $state.raw<ReadonlySet<number>>(new Set<number>());
  let selection = $state<number | null>(null);
  let loading = $state(true);
  let writing = $state(false);
  let loadError = $state("");
  let actionError = $state("");
  let revision = $state(0);
  const skinName = (skin: FirstPartySkin) => plainText($words.templates[`#${skin.nameID}`] ?? `SKIN ${skin.skinID}`);
  const shown = $derived.by(() => {
    const byMaterial = new Map<number, FirstPartySkin>();
    for (const row of rows) {
      if (licenses.has(row.skinID) || (row.visible && !byMaterial.has(row.materialID))) byMaterial.set(row.materialID, row);
    }
    return [...byMaterial.values()].sort((a, b) => skinName(a).localeCompare(skinName(b)));
  });
  const selected = $derived(shown.find(row => row.skinID === (selection ?? currentSkinID)) ?? null);
  const selectedApplied = $derived(selected !== null && selected.skinID === currentSkinID);

  $effect(() => {
    if (!pilot) return;
    void revision;
    const hull = shipTypeID;
    const ship = shipID;
    let current = true;
    loading = true;
    loadError = "";
    const read = untrack(() => Promise.all([loadFirstPartySkinCatalog(hull),
      flow.loadFirstPartySkinLicenses(hull), flow.loadShipSkinrApplied(ship)]));
    void read.then(([catalog, owned]) => {
      if (!current) return;
      rows = catalog;
      licenses = owned;
      flow.requestWords([...new Set(catalog.map(row => `#${row.nameID}`))]);
    }, error => {
      if (current) loadError = panelErrorWords(error);
    }).finally(() => { if (current) loading = false; });
    return () => { current = false; };
  });

  async function apply(skinID: number | null) {
    if (writing) return;
    writing = true;
    actionError = "";
    try {
      await flow.applyFirstPartySkin(shipID, skinID);
    } catch (error) {
      actionError = panelErrorWords(error);
    } finally {
      writing = false;
    }
  }
</script>

<section class="first-party" aria-label="Standard SKINs">
  <h3>Standard SKINs</h3>
  {#if loading}
    <p role="status">Loading SKINs…</p>
  {:else if loadError}
    <p role="alert">{loadError}</p>
    <button type="button" onclick={() => revision++}>Retry</button>
  {:else if !shown.length}
    <p>No standard SKINs for this hull.</p>
  {:else}
    <div class="browser">
      <div class="rows">
        {#each [true, false] as licensed (licensed)}
          {@const group = shown.filter(row => licenses.has(row.skinID) === licensed)}
          <details open={licensed}>
            <summary>{licensed ? "Licensed SKINs" : "Unlicensed SKINs"} ({group.length})</summary>
            {#each group as row (row.materialID)}
              <button type="button" data-first-party-skin={row.skinID} aria-pressed={selected?.skinID === row.skinID}
                onclick={() => { selection = row.skinID; actionError = ""; }}>
                {skinName(row)}{row.skinID === currentSkinID ? " · Applied" : ""}
              </button>
            {/each}
          </details>
        {/each}
      </div>
      {#if selected}
        {#if selected.materialSetID}
          <div class="preview" data-first-party-preview={selected.materialSetID}>
            <ShipInfoPreview typeID={shipTypeID} factionID={null} skinMaterialSetID={selected.materialSetID} active expanded />
          </div>
        {/if}
        <div class="actions">
          <strong>{skinName(selected)}</strong>
          {#if selectedApplied}
            <button type="button" disabled={writing} onclick={() => void apply(null)}>Remove from Ship</button>
          {:else if licenses.has(selected.skinID)}
            <button type="button" disabled={writing} onclick={() => void apply(selected!.skinID)}>Apply</button>
          {:else}
            <span>License required to apply</span>
          {/if}
        </div>
      {/if}
    </div>
    {#if actionError}<p role="alert">{actionError}</p>{/if}
  {/if}
</section>

<style>
  .first-party { display: grid; gap: 8px; padding: 12px 18px; }
  h3, p { margin: 0; }
  .browser { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(min(210px, 100%), 1fr)); }
  .rows { max-height: 15rem; overflow: auto; }
  .rows button { width: 100%; text-align: left; }
  summary { cursor: pointer; padding: 6px; }
  .preview { height: clamp(9rem, 23vh, 15rem); background: #000; }
  .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; grid-column: 1 / -1; }
</style>
