<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { nextLocalID } from "../app/localID.ts";
  import { colonyTemplateLink, readColonyTemplate, writeColonyTemplate, type ColonyTemplate } from "../bridge/colonyTemplate.ts";
  import { commodityName, type PiRecipeBook } from "../bridge/piRecipes.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import type { Colony } from "../store/types.ts";

  let { colony, recipes, flow, store, busy, source, onLoad }: {
    colony: Colony; recipes: PiRecipeBook; flow: AppFlow; store: ClientStore; busy: boolean;
    source: string; onLoad: (text: string) => void;
  } = $props();
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const planetName = (id: number) => resolvedName($names.resolved, "type", id, `Planet type ${id}`);
  const productName = (id: number) => commodityName(recipes, id) ?? resolvedName($names.resolved, "type", id, `Type ${id}`);
  const storageKey = "evejs.play.planetaryTemplates";
  type SavedTemplate = { readonly id: string; readonly template: ColonyTemplate };
  let library = $state.raw<readonly SavedTemplate[]>([]);
  let textFilter = $state("");
  let planetFilter = $state(0);
  let levelFilter = $state(-1);
  let extractionFilter = $state(0);
  let productionFilter = $state(0);
  let minDiameter = $state(false);
  let renaming = $state<string | null>(null);
  let deleting = $state<string | null>(null);
  let editName = $state("");
  let error = $state("");
  let status = $state("");
  let exporting = $state(false);
  let preparing = $state(false);
  let exportName = $state("");
  let prepared = $state.raw<ColonyTemplate | null>(null);
  const productIDs = (template: ColonyTemplate) => template.pins.flatMap(pin => pin.product === null ? [] : [pin.product]);
  const types = $derived([...new Set(library.map(row => row.template.planetTypeID))].sort((a, b) => planetName(a).localeCompare(planetName(b))));
  const products = $derived([...new Set(library.flatMap(row => productIDs(row.template)))].sort((a, b) => productName(a).localeCompare(productName(b))));
  const visible = $derived(library.filter(({ template }) =>
    template.comment.toLowerCase().includes(textFilter.trim().toLowerCase()) &&
    (planetFilter === 0 || template.planetTypeID === planetFilter) &&
    (levelFilter === -1 || template.level === levelFilter) &&
    (extractionFilter === 0 || productIDs(template).includes(extractionFilter)) &&
    (productionFilter === 0 || productIDs(template).includes(productionFilter)) &&
    (!minDiameter || !colony.radius || template.diameter >= colony.radius * 2 / 1000)));

  function readLibrary(): readonly SavedTemplate[] {
    const records: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (!Array.isArray(records)) throw new Error("The saved template library could not be read.");
    return records.flatMap(record => {
      if (typeof record?.id !== "string" || typeof record?.text !== "string") return [];
      try { return [{ id: record.id, template: readColonyTemplate(record.text) }]; }
      catch { return []; }
    }).sort((a, b) => a.template.comment.localeCompare(b.template.comment, undefined, { sensitivity: "base" }));
  }

  function refreshLibrary(): void {
    try { library = readLibrary(); }
    catch { error = "The saved template library could not be read."; }
  }

  onMount(() => {
    refreshLibrary();
    const sync = (event: StorageEvent) => {
      if (event.key === null || event.key === storageKey) refreshLibrary();
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  });

  $effect(() => {
    if (types.length || products.length) {
      flow.requestNames([...types, ...products].map(id => ({ kind: "type" as const, id })));
    }
    if (!types.includes(planetFilter)) planetFilter = 0;
    if (!products.includes(extractionFilter)) extractionFilter = 0;
    if (!products.includes(productionFilter)) productionFilter = 0;
  });

  function changeLibrary(edit: (rows: readonly SavedTemplate[]) => readonly SavedTemplate[]): void {
    const updated = edit(readLibrary());
    localStorage.setItem(storageKey, JSON.stringify(updated.map(({ id, template }) => ({ id, text: writeColonyTemplate(template) }))));
    refreshLibrary();
  }

  function message(cause: unknown): void {
    error = cause instanceof Error ? cause.message : String(cause);
    status = "";
  }

  function save(template: ColonyTemplate): void {
    try {
      changeLibrary(rows => [...rows, { id: nextLocalID(), template }]);
      error = "";
      status = "Template saved.";
    } catch (cause) { message(cause); }
  }

  async function saveImport(): Promise<void> {
    let text = source;
    if (!text.trim()) {
      try { text = await navigator.clipboard.readText(); }
      catch { message("Paste the template into the text field before saving it."); return; }
    }
    try { save(readColonyTemplate(text)); }
    catch (cause) { message(cause); }
  }

  function rename(id: string): void {
    try {
      changeLibrary(rows => rows.map(row => row.id === id
        ? { ...row, template: { ...row.template, comment: editName.replace(/<[^>]*>/g, "").trim() } } : row));
      renaming = null;
      error = "";
      status = "Template renamed.";
    } catch (cause) { message(cause); }
  }

  function remove(id: string): void {
    try {
      changeLibrary(rows => rows.filter(row => row.id !== id));
      deleting = null;
      error = "";
      status = "Template deleted.";
    } catch (cause) { message(cause); }
  }

  async function copy(template: ColonyTemplate, asLink = false): Promise<void> {
    try {
      await navigator.clipboard.writeText(asLink ? colonyTemplateLink(template) : writeColonyTemplate(template));
      error = "";
      status = asLink ? "Template link copied." : "Template copied.";
    } catch { message("The browser could not write to the clipboard."); }
  }

  function download(template: ColonyTemplate): void {
    const name = template.comment.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 100) || "planetary-template";
    const url = URL.createObjectURL(new Blob([writeColonyTemplate(template)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    error = "";
    status = "Template downloaded.";
  }

  async function prepareExport(): Promise<void> {
    preparing = true;
    prepared = null;
    error = "";
    status = "";
    try {
      prepared = await flow.readColonyTemplateForExport(colony.planetID, exportName);
    } catch (cause) { message(cause); }
    finally { preparing = false; }
  }
</script>

<div class="template-library">
  <div class="actions">
    <button type="button" disabled={busy || preparing} onclick={() => void saveImport()}>{source.trim() ? "Save template text" : "Save from Clipboard"}</button>
    <button type="button" disabled={busy || preparing} onclick={() => {
      exporting = !exporting;
      exportName = colony.planetName ?? "Colony";
      prepared = null;
      error = "";
      status = "";
    }}>{exporting ? "Close export" : "Export colony"}</button>
  </div>
  {#if exporting}
    <form class="export" onsubmit={(event) => { event.preventDefault(); void prepareExport(); }}>
      <label>Template name <input bind:value={exportName} maxlength="200" disabled={busy || preparing} oninput={() => { prepared = null; }} /></label>
      <button type="submit" disabled={busy || preparing}>Prepare export</button>
      {#if prepared}
        {@const exported = prepared}
        <div class="actions">
          <button type="button" disabled={busy} onclick={() => save(exported)}>Save to library</button>
          <button type="button" disabled={busy} onclick={() => void copy(exported)}>Copy exported JSON</button>
          <button type="button" disabled={busy} onclick={() => download(exported)}>Download JSON</button>
        </div>
      {/if}
    </form>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if status}<p role="status">{status}</p>{/if}
  <details open>
    <summary>Saved templates ({visible.length}{#if visible.length !== library.length} of {library.length}{/if})</summary>
    {#if library.length}
      <div class="filters">
        <input type="search" maxlength="64" bind:value={textFilter} aria-label="Filter saved templates" placeholder="Filter by name" />
        <details>
          <summary>Template filters</summary>
          <div class="filters">
            <label>Planet type <select bind:value={planetFilter}><option value={0}>Any</option>
              {#each types as id (id)}<option value={id}>{planetName(id)}</option>{/each}
            </select></label>
            <label>Command centre <select bind:value={levelFilter}><option value={-1}>Any level</option>
              {#each [0, 1, 2, 3, 4, 5] as level}<option value={level}>Level {level + 1}</option>{/each}
            </select></label>
            <label>Extraction <select bind:value={extractionFilter}><option value={0}>Any</option>
              {#each products.filter(id => recipes.commodities.get(id)?.tier === 0) as id (id)}<option value={id}>{productName(id)}</option>{/each}
            </select></label>
            <label>Production <select bind:value={productionFilter}><option value={0}>Any</option>
              {#each products.filter(id => (recipes.commodities.get(id)?.tier ?? 0) > 0) as id (id)}<option value={id}>{productName(id)}</option>{/each}
            </select></label>
            {#if colony.radius}<label><input type="checkbox" bind:checked={minDiameter} /> Hide templates from smaller planets</label>{/if}
          </div>
        </details>
      </div>
    {/if}
    {#if !visible.length}
      <p>{library.length ? "No templates match the filters." : "No saved templates."}</p>
    {:else}
      <ul>
        {#each visible as row (row.id)}
          {@const title = row.template.comment || "Unnamed template"}
          <li data-saved-template={row.id}>
            <strong>{title}</strong>
            <small>{planetName(row.template.planetTypeID)} · {row.template.diameter.toLocaleString()} km · level {row.template.level + 1}</small>
            {#if productIDs(row.template).length}
              <small>{[...new Set(productIDs(row.template))].map(productName).join(", ")}</small>
            {/if}
            {#if renaming === row.id}
              <form class="actions" onsubmit={(event) => { event.preventDefault(); rename(row.id); }}>
                <input bind:value={editName} maxlength="200" aria-label="New template name" />
                <button type="submit">Save name</button>
                <button type="button" onclick={() => { renaming = null; }}>Cancel</button>
              </form>
            {:else if deleting === row.id}
              <div class="actions">
                <span>Delete {title}?</span>
                <button type="button" onclick={() => remove(row.id)}>Confirm delete</button>
                <button type="button" onclick={() => { deleting = null; }}>Cancel</button>
              </div>
            {:else}
              <div class="actions">
                <button type="button" disabled={busy} onclick={() => onLoad(writeColonyTemplate(row.template))}>Load</button>
                <button type="button" onclick={() => void copy(row.template)}>Copy JSON</button>
                <button type="button" onclick={() => void copy(row.template, true)}>Copy link</button>
                <button type="button" onclick={() => download(row.template)}>Download</button>
                <button type="button" onclick={() => { deleting = null; renaming = row.id; editName = row.template.comment; }}>Rename</button>
                <button type="button" onclick={() => { renaming = null; deleting = row.id; }}>Delete</button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </details>
</div>

<style>
  .template-library, .export, li { display: grid; gap: .35rem; }
  .actions, .filters { display: flex; align-items: center; flex-wrap: wrap; gap: .35rem; }
  .template-library > details, .export { padding: .45rem; border: 1px solid #324a5d; background: #0c1723; }
  details > :not(summary) { margin-block-start: .35rem; }
  summary { cursor: pointer; }
  form > button { justify-self: start; }
  ul { display: grid; gap: .35rem; list-style: none; margin: .4rem 0 0; padding: 0; max-height: 14rem; overflow: auto; }
  li { border: 1px solid #324a5d; padding: .45rem; overflow-wrap: anywhere; }
  small { color: #aec0cc; }
  input:not([type="checkbox"]), select { color: inherit; background: #101923; border: 1px solid #3b5064; padding: .2rem .3rem; }
  p { margin: 0; }
  .error { color: #ffca83; }
</style>
