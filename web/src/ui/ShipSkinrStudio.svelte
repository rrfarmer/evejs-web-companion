<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ShipSkinrDesign, ShipSkinrEntry, ShipSkinrStudio } from "../bridge/shipSkinr.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { typeIconUrl } from "./typeIcons.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const station = $derived(store.station);
  const pilot = $derived($station.online?.characterID ?? null);
  const prefix = "UI/Personalization/ShipSkins/SKINR/Studio/";
  const labels = {
    studio: [prefix + "Title", "Studio"],
    sequencing: [prefix + "SequencingInProgress", "Sequencing In Progress"],
    saved: [prefix + "SavedDesigns", "Saved Designs"],
  } as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  let studio = $state.raw<ShipSkinrStudio | null>(null);
  let designs = $state.raw<ReadonlyMap<string, ShipSkinrDesign | null>>(new Map());
  let error = $state("");
  let attempt = $state(0);
  let selected = $state<string | null>(null);
  const selectedEntry = $derived([...(studio?.designs ?? []), ...(studio?.jobs ?? [])].find(row => row.id === selected));
  const selectedDesign = $derived(selectedEntry ? designs.get(selectedEntry.skin) : null);
  const shipName = (design: ShipSkinrDesign) => resolvedName($names.resolved, "type", design.shipTypeID, String(design.shipTypeID));
  const title = (entry: ShipSkinrEntry) => {
    const design = designs.get(entry.skin);
    return design ? design.name || shipName(design) : design === null ? "Design unavailable" : "Loading design…";
  };

  $effect(() => { flow.requestWords(Object.values(labels).map(([path]) => path)); });
  $effect(() => {
    void attempt;
    studio = null;
    designs = new Map();
    selected = null;
    error = "";
    if (!pilot) return;
    let mounted = true;
    void flow.loadShipSkinrStudio().then(result => {
      if (!mounted) return;
      studio = result;
      const skins = new Set([...result.designs, ...result.jobs].map(row => row.skin));
      return Promise.all([...skins].map(async skin => {
        const design = await flow.loadShipSkinrDesign(skin).catch(() => null);
        return [skin, design] as const;
      })).then(entries => { if (mounted) designs = new Map(entries); });
    }, cause => { if (mounted) error = panelErrorWords(cause); });
    return () => { mounted = false; };
  });
</script>

<section class="ship-skinr" aria-labelledby="ship-skinr-studio">
  <h2 id="ship-skinr-studio">{word("studio")}</h2>
  {#if error}
    <p role="alert">{error}</p>
    <button type="button" onclick={() => attempt++}>Retry</button>
  {:else if !studio}
    <p role="status">Loading Studio…</p>
  {:else}
    <div class="skinr-sections">
      <section aria-label={word("sequencing")}>
        <header><h3>{word("sequencing")}</h3><span>{studio.jobs.length}</span></header>
        {#if !studio.jobs.length}<p>No active sequencing jobs.</p>{/if}
        {#each studio.jobs as row (row.id)}
          <button class="skinr-entry" type="button" data-entry="job" aria-pressed={selected === row.id}
            onclick={() => selected = selected === row.id ? null : row.id}>
            <strong>{title(row)}</strong>
            <span>{row.quantity} SKINs</span>
            {#if row.finishesAt}<time datetime={new Date(row.finishesAt).toISOString()}>{new Date(row.finishesAt).toLocaleString()}</time>{/if}
          </button>
        {/each}
      </section>
      <section aria-label={word("saved")}>
        <header><h3>{word("saved")}</h3><span>{studio.designs.length}/{studio.capacity}</span></header>
        {#if !studio.designs.length}<p>No saved designs.</p>{/if}
        {#each studio.designs as row (row.id)}
          <button class="skinr-entry" type="button" data-entry="draft" aria-pressed={selected === row.id}
            onclick={() => selected = selected === row.id ? null : row.id}><strong>{title(row)}</strong></button>
        {/each}
      </section>
    </div>
    {#if selectedEntry && selectedDesign}
      {@const icon = typeIconUrl(selectedDesign.shipTypeID)}
      <section class="skinr-details" aria-label={title(selectedEntry)}>
        {#if icon}<img src={icon} alt="" width="64" height="64" />{/if}
        <div>
          <h3>{title(selectedEntry)}</h3>
          {#if selectedDesign.lineName}<p>{selectedDesign.lineName}</p>{/if}
          <p>{selectedDesign.tier ? `${shipName(selectedDesign)} · Tier ${selectedDesign.tier}` : shipName(selectedDesign)}</p>
        </div>
      </section>
    {/if}
  {/if}
</section>

<style>
  .ship-skinr { display: grid; gap: 14px; padding: 18px; }
  h2, h3, p { margin: 0; }
  .skinr-sections { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 12px; }
  .skinr-sections section { display: grid; align-content: start; gap: 8px; padding: 14px; background: #ffffff08; }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  p, time, span { color: #b8c3cc; }
  .skinr-entry { display: flex; flex-wrap: wrap; justify-content: space-between; text-align: left; gap: 8px; padding: 8px; }
  .skinr-entry[aria-pressed="true"] { border-color: #94b8c2; }
  .skinr-details { display: flex; align-items: center; gap: 12px; padding: 14px; background: #ffffff08; }
</style>
