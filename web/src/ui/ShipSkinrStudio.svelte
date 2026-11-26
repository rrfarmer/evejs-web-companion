<script lang="ts">
  import { onDestroy } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { ShipSkinrDesign, ShipSkinrEntry, ShipSkinrStudio } from "../bridge/shipSkinr.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { typeIconUrl } from "./typeIcons.ts";
  import ShipSkinrDesigner from "./ShipSkinrDesigner.svelte";

  let { store, flow, registerBeforeClose }: {
    store: ClientStore; flow: AppFlow; registerBeforeClose?: (guard: () => Promise<boolean>) => () => void;
  } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const station = $derived(store.station);
  const pilot = $derived($station.online?.characterID ?? null);
  const prefix = "UI/Personalization/ShipSkins/SKINR/Studio/";
  const labels = {
    studio: [prefix + "Title", "Studio"],
    sequencing: [prefix + "SequencingInProgress", "Sequencing In Progress"],
    saved: [prefix + "SavedDesigns", "Saved Designs"],
    create: [prefix + "CreateNewDesign", "Create New Design"],
    edit: [prefix + "EditDesign", "Edit Design"],
    delete: [prefix + "DeleteDesign", "Delete Design"],
  } as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const limitPath = prefix + "DesignErrors/SaveLimitReached";
  let studio = $state.raw<ShipSkinrStudio | null>(null);
  let designs = $state.raw<ReadonlyMap<string, ShipSkinrDesign | null>>(new Map());
  let error = $state("");
  let attempt = $state(0);
  let selected = $state<string | null>(null);
  let selectionAfterReload: string | null = null;
  let designer = $state.raw<{ entry: ShipSkinrEntry; design: ShipSkinrDesign } | "new" | null>(null);
  let deleting = $state.raw<ShipSkinrEntry | null>(null);
  let deleteError = $state("");
  let destroyed = false;
  const atSaveLimit = $derived(studio !== null && studio.designs.length >= studio.capacity);
  const saveLimit = $derived(studio ? plainText(formatTemplate(
    $words.templates[limitPath] ?? "All saved design slots are in use.",
    { current: studio.designs.length, limit: studio.capacity },
    { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") },
  )) : "");
  const selectedEntry = $derived([...(studio?.designs ?? []), ...(studio?.jobs ?? [])].find(row => row.id === selected));
  const selectedDesign = $derived(selectedEntry ? designs.get(selectedEntry.skin) : null);
  const shipName = (design: ShipSkinrDesign) => resolvedName($names.resolved, "type", design.shipTypeID, String(design.shipTypeID));
  const title = (entry: ShipSkinrEntry) => {
    const design = designs.get(entry.skin);
    return design ? design.name || shipName(design) : design === null ? "Design unavailable" : "Loading design…";
  };

  onDestroy(() => { destroyed = true; });

  function designSaved(entry: ShipSkinrEntry) {
    selectionAfterReload = entry.id;
    attempt++;
  }

  async function remove(entry: ShipSkinrEntry) {
    const loaded = studio;
    if (!loaded?.designs.includes(entry) || designer || deleting) return;
    const current = () => !destroyed && studio === loaded && deleting === entry;
    deleting = entry;
    deleteError = "";
    try {
      const confirmed = await flow.askClientDialogWith("DeleteDesign", {}, "Delete this saved design?");
      if (!confirmed || !current()) return;
      await flow.deleteShipSkinrDesign(entry.id);
      if (!current()) return;
      studio = { ...loaded, designs: loaded.designs.filter(row => row.id !== entry.id) };
      selected = null;
    } catch (cause) {
      if (current()) deleteError = panelErrorWords(cause);
    } finally {
      if (!destroyed && deleting === entry) deleting = null;
    }
  }

  $effect(() => { flow.requestWords([...Object.values(labels).map(([path]) => path), limitPath]); });
  $effect(() => {
    void attempt;
    studio = null;
    designs = new Map();
    selected = selectionAfterReload;
    selectionAfterReload = null;
    designer = null;
    deleting = null;
    deleteError = "";
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
  <h2 id="ship-skinr-studio">{word(designer === "new" ? "create" : designer ? "edit" : "studio")}</h2>
  {#if designer}
    <ShipSkinrDesigner {store} {flow} {atSaveLimit} {saveLimit} {registerBeforeClose}
      saved={designer === "new" ? null : designer} onBack={() => designer = null} onSaved={designSaved} />
  {:else if error}
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
          <button class="skinr-entry" type="button" data-entry="job" aria-pressed={selected === row.id} disabled={!!deleting}
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
          <button class="skinr-entry" type="button" data-entry="draft" aria-pressed={selected === row.id} disabled={!!deleting}
            onclick={() => selected = selected === row.id ? null : row.id}><strong>{title(row)}</strong></button>
        {/each}
      </section>
    </div>
    {#if selectedEntry && selectedDesign}
      {@const icon = typeIconUrl(selectedDesign.shipTypeID)}
      {@const entry = selectedEntry}
      {@const design = selectedDesign}
      <section class="skinr-details" aria-label={title(selectedEntry)}>
        {#if icon}<img src={icon} alt="" width="64" height="64" />{/if}
        <div>
          <h3>{title(selectedEntry)}</h3>
          {#if selectedDesign.lineName}<p>{selectedDesign.lineName}</p>{/if}
          <p>{selectedDesign.tier ? `${shipName(selectedDesign)} · Tier ${selectedDesign.tier}` : shipName(selectedDesign)}</p>
        </div>
        <div class="skinr-actions">
          <button type="button" disabled={!!deleting} onclick={() => designer = "new"}>{word("create")}</button>
          {#if studio.designs.includes(selectedEntry)}
            <button type="button" disabled={!!deleting} onclick={() => designer = { entry, design }}>{word("edit")}</button>
            <button type="button" class="danger" disabled={!!deleting} onclick={() => void remove(entry)}>{word("delete")}</button>
          {/if}
        </div>
      </section>
    {:else if !selectedEntry}
      <div class="skinr-actions">
        <button type="button" onclick={() => designer = "new"}>{word("create")}</button>
      </div>
    {/if}
    {#if deleteError}<p role="alert">{deleteError}</p>{/if}
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
  .skinr-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-inline-start: auto; }
</style>
