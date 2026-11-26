<script lang="ts">
  import { onDestroy } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { ShipSkinrDesign, ShipSkinrEntry, ShipSkinrStudio } from "../bridge/shipSkinr.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { typeIconUrl } from "./typeIcons.ts";
  import ShipSkinrNewDesign from "./ShipSkinrNewDesign.svelte";

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
    create: [prefix + "CreateNewDesign", "Create New Design"],
    edit: [prefix + "EditDesign", "Edit Design"],
    delete: [prefix + "DeleteDesign", "Delete Design"],
    name: [prefix + "SKINName", "SKIN Name"],
    line: [prefix + "SKINLineNameOptional", "SKIN Line Name (Optional)"],
    save: ["UI/Common/Buttons/Save", "Save"],
    saveAs: [prefix + "SaveAs", "Save As"],
    saveAsNew: [prefix + "SaveAsNew", "Save as New"],
    cancel: ["UI/Common/Buttons/Cancel", "Cancel"],
  } as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const limitPath = prefix + "DesignErrors/SaveLimitReached";
  let studio = $state.raw<ShipSkinrStudio | null>(null);
  let designs = $state.raw<ReadonlyMap<string, ShipSkinrDesign | null>>(new Map());
  let error = $state("");
  let attempt = $state(0);
  let selected = $state<string | null>(null);
  let creating = $state(false);
  let editor = $state.raw<{ entry: ShipSkinrEntry; design: ShipSkinrDesign } | null>(null);
  let name = $state("");
  let lineName = $state("");
  let beforeCopy = $state.raw<{ name: string; lineName: string } | null>(null);
  let saving = $state(false);
  let saveError = $state("");
  let deleting = $state.raw<ShipSkinrEntry | null>(null);
  let deleteError = $state("");
  let destroyed = false;
  const atSaveLimit = $derived(studio !== null && studio.designs.length >= studio.capacity);
  const saveLimit = $derived(studio ? plainText(formatTemplate(
    $words.templates[limitPath] ?? "All saved design slots are in use.",
    { current: studio.designs.length, limit: studio.capacity },
    { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") },
  )) : "");
  const validName = $derived(name.trim() !== "" && [...name].length <= 20 && [...lineName].length <= 50 &&
    !/[\p{Cc}\p{Cs}]/u.test(name + lineName));
  const selectedEntry = $derived([...(studio?.designs ?? []), ...(studio?.jobs ?? [])].find(row => row.id === selected));
  const selectedDesign = $derived(selectedEntry ? designs.get(selectedEntry.skin) : null);
  const shipName = (design: ShipSkinrDesign) => resolvedName($names.resolved, "type", design.shipTypeID, String(design.shipTypeID));
  const title = (entry: ShipSkinrEntry) => {
    const design = designs.get(entry.skin);
    return design ? design.name || shipName(design) : design === null ? "Design unavailable" : "Loading design…";
  };

  onDestroy(() => { destroyed = true; });

  function edit(entry: ShipSkinrEntry, design: ShipSkinrDesign) {
    editor = { entry, design };
    name = design.name;
    lineName = design.lineName;
    saveError = "";
  }

  function startCopy() {
    if (atSaveLimit || saving) return;
    beforeCopy = { name, lineName };
    saveError = "";
  }

  function cancelEdit() {
    if (beforeCopy) {
      ({ name, lineName } = beforeCopy);
      beforeCopy = null;
      saveError = "";
    } else {
      editor = null;
    }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!editor || !studio || saving || !validName) return;
    const target = editor;
    const asNew = beforeCopy !== null;
    if (asNew && atSaveLimit) return;
    const edited = { ...target.design, name, lineName };
    saving = true;
    saveError = "";
    try {
      const updated = await flow.saveShipSkinrDesign(target.entry, target.design, edited.name, edited.lineName, asNew);
      if (destroyed || editor !== target || !studio) return;
      designs = new Map(designs).set(updated.skin, edited);
      studio = { ...studio, designs: asNew ? [...studio.designs, updated] : studio.designs.map(row => row.id === updated.id ? updated : row) };
      selected = updated.id;
      beforeCopy = null;
      editor = null;
    } catch (cause) {
      if (!destroyed && editor === target) saveError = panelErrorWords(cause);
    } finally {
      if (!destroyed && (editor === target || !editor)) saving = false;
    }
  }

  async function remove(entry: ShipSkinrEntry) {
    const loaded = studio;
    if (!loaded?.designs.includes(entry) || editor || deleting) return;
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
    selected = null;
    creating = false;
    editor = null;
    beforeCopy = null;
    saving = false;
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
  <h2 id="ship-skinr-studio">{word(creating ? "create" : "studio")}</h2>
  {#if creating}
    <ShipSkinrNewDesign {store} {flow} onBack={() => creating = false} />
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
          <button class="skinr-entry" type="button" data-entry="job" aria-pressed={selected === row.id} disabled={!!editor || !!deleting}
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
          <button class="skinr-entry" type="button" data-entry="draft" aria-pressed={selected === row.id} disabled={!!editor || !!deleting}
            onclick={() => selected = selected === row.id ? null : row.id}><strong>{title(row)}</strong></button>
        {/each}
      </section>
    </div>
    {#if editor}
      <form class="skinr-editor" aria-labelledby="skinr-editor-heading" onsubmit={save}>
        <h3 id="skinr-editor-heading">{word(beforeCopy ? "saveAsNew" : "edit")}</h3>
        <label>{word("name")} <input bind:value={name} required disabled={saving} /></label>
        <label>{word("line")} <input bind:value={lineName} disabled={saving} /></label>
        {#if [...name].length > 20 || [...lineName].length > 50}
          <p role="alert">Use up to 20 characters for the name and 50 for the line name.</p>
        {/if}
        {#if saveError}<p role="alert">{saveError}</p>{/if}
        <footer>
          <button type="submit" disabled={saving || !validName || (!!beforeCopy && atSaveLimit)}>{word("save")}</button>
          {#if !beforeCopy}
            <button type="button" disabled={saving || atSaveLimit} onclick={startCopy}>{word("saveAs")}</button>
          {/if}
          <button type="button" disabled={saving} onclick={cancelEdit}>{word("cancel")}</button>
        </footer>
        {#if atSaveLimit}<p>{saveLimit}</p>{/if}
      </form>
    {:else if selectedEntry && selectedDesign}
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
          <button type="button" disabled={!!deleting} onclick={() => creating = true}>{word("create")}</button>
          {#if studio.designs.includes(selectedEntry)}
            <button type="button" disabled={!!deleting} onclick={() => edit(entry, design)}>{word("edit")}</button>
            <button type="button" class="danger" disabled={!!deleting} onclick={() => void remove(entry)}>{word("delete")}</button>
          {/if}
        </div>
      </section>
    {:else if !selectedEntry}
      <div class="skinr-actions">
        <button type="button" onclick={() => creating = true}>{word("create")}</button>
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
  .skinr-editor { display: grid; gap: 12px; padding: 14px; background: #ffffff08; }
  .skinr-editor label { display: grid; gap: 4px; max-width: 400px; }
  .skinr-editor footer { display: flex; gap: 8px; }
</style>
