<script lang="ts" generics="Settings extends object">
  import { onMount, tick } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { flow, store, pilot, scope, values, snapshot, isDefault, restore, readActive, sameFilters, choose,
    selectedFilter = $bindable("") }: {
    flow: AppFlow;
    store: ClientStore;
    pilot: number | undefined;
    scope: "browse" | "history";
    values: Settings;
    snapshot?: Settings;
    isDefault: boolean;
    restore: (stored: unknown) => Settings;
    readActive: (owner: number) => Settings;
    sameFilters: (a: Settings, b: Settings) => boolean;
    choose: (values: Settings) => void;
    selectedFilter?: string;
  } = $props();
  const words = $derived(store.words);
  const savedKey = (owner: number) => `evejs.hypernet.${scope}-saved.${owner}`;
  const labels = {
    savedFilters: ["UI/HyperNet/SavedFilters", "Saved filters"],
    saveFilter: ["UI/HyperNet/SaveFilterHint", "Save current filter settings"],
    deleteFilter: ["UI/HyperNet/DeleteSavedFilter", "Delete"],
    noFilter: ["UI/HyperNet/NoFilterSelected", "(no filter selected)"],
    noSavedFilters: ["UI/HyperNet/NoSavedFiltersHint", "No saved filters"],
    filterNameCaption: ["UI/HyperNet/FilterNamePromptCaption", "Filter name"],
    filterName: ["UI/HyperNet/FilterNamePromptHint", "Type a name for the filter"],
    save: ["UI/Generic/Save", "Save"],
    cancel: ["UI/Generic/Cancel", "Cancel"],
    yes: ["UI/Generic/Yes", "Yes"],
    no: ["UI/Generic/No", "No"],
  } as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  type SavedFilter = { readonly name: string; readonly values: Settings };
  type PendingFilter = { kind: "delete"; name: string } | { kind: "replace"; name: string; values: Settings };
  const savedLimit = 20;
  let savedFilters = $state.raw<readonly SavedFilter[]>([]);
  let savedMenuOpen = $state(false);
  const sortedSavedFilters = $derived([...savedFilters].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let editingName = $state(false);
  let draftName = $state("");
  let nameInput: HTMLInputElement | undefined = $state();
  let pending = $state<PendingFilter | null>(null);
  let saveError = $state("");

  function loadSavedFilters(owner: number): readonly SavedFilter[] {
    try {
      const entries: unknown = JSON.parse(localStorage.getItem(savedKey(owner)) ?? "[]");
      if (!Array.isArray(entries)) return [];
      const filters = new Map<string, Settings>();
      for (const entry of entries) {
        if (typeof entry?.name === "string" && entry.name.trim() && entry.name.length <= 100 &&
            entry.values && typeof entry.values === "object" && !Array.isArray(entry.values)) {
          filters.set(entry.name, restore(entry.values));
          if (filters.size === savedLimit) break;
        }
      }
      return [...filters].map(([name, values]) => ({ name, values }));
    } catch {
      return [];
    }
  }

  function persistSaved(next: readonly SavedFilter[]) {
    if (!pilot) return;
    savedFilters = next;
    try { localStorage.setItem(savedKey(pilot), JSON.stringify(next)); } catch { /* keep the filters for this window */ }
  }

  async function startSaving() {
    if (savedFilters.length >= savedLimit) {
      saveError = "You can save up to 20 filters.";
      return;
    }
    saveError = "";
    pending = null;
    savedMenuOpen = false;
    draftName = "";
    editingName = true;
    await tick();
    nameInput?.focus();
  }

  function saveNamed(name: string, saved: Settings) {
    persistSaved([...savedFilters.filter(entry => entry.name !== name), { name, values: saved }]);
    if (snapshot && selectedFilter !== name && !sameFilters(values, saved)) choose(saved);
    selectedFilter = snapshot || sameFilters(values, saved) ? name : "";
  }

  function submitName(event: SubmitEvent) {
    event.preventDefault();
    const name = draftName.trim();
    if (!name || isDefault) return;
    editingName = false;
    const saved = snapshot ?? values;
    if (savedFilters.some(entry => entry.name === name)) pending = { kind: "replace", name, values: saved };
    else saveNamed(name, saved);
  }

  function confirmSavedChange() {
    const change = pending;
    pending = null;
    if (!change) return;
    if (change.kind === "replace") {
      saveNamed(change.name, change.values);
    } else {
      persistSaved(savedFilters.filter(entry => entry.name !== change.name));
      if (selectedFilter === change.name) selectedFilter = "";
      if (!savedFilters.length) savedMenuOpen = false;
      saveError = "";
    }
  }


  onMount(() => flow.requestWords(Object.values(labels).map(([path]) => path)));
  $effect(() => {
    const owner = pilot;
    const saved = owner ? loadSavedFilters(owner) : [];
    const current = owner ? readActive(owner) : null;
    savedFilters = saved;
    selectedFilter = current ? saved.find(entry => sameFilters(entry.values, current))?.name ?? "" : "";
    savedMenuOpen = false;
    editingName = false;
    pending = null;
    saveError = "";
  });
</script>

<fieldset class="saved-filters">
  <legend>{word("savedFilters")}</legend>
  <button type="button" data-saved-selection aria-expanded={savedMenuOpen} disabled={!savedFilters.length}
    title={savedFilters.length ? undefined : word("noSavedFilters")}
    onclick={() => { savedMenuOpen = !savedMenuOpen; }}>{selectedFilter || word("noFilter")}</button>
  <button type="button" data-save-filter disabled={!pilot || isDefault} onclick={startSaving}>{word("saveFilter")}</button>
  {#if savedMenuOpen}
    <ul class="saved-options">
      {#each sortedSavedFilters as entry (entry.name)}
        <li>
          <button type="button" data-apply-saved={entry.name} aria-pressed={selectedFilter === entry.name}
            onclick={() => {
              savedMenuOpen = false;
              choose(entry.values);
              selectedFilter = entry.name;
            }}>{entry.name}</button>
          <button type="button" data-delete-saved={entry.name} aria-label={`${word("deleteFilter")} ${entry.name}`}
            onclick={() => { editingName = false; pending = { kind: "delete", name: entry.name }; }}>{word("deleteFilter")}</button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if editingName}
    <form aria-label={word("filterNameCaption")} onsubmit={submitName}>
      <label>{word("filterName")} <input bind:this={nameInput} bind:value={draftName} maxlength={100} required /></label>
      <button type="submit" disabled={!draftName.trim() || isDefault}>{word("save")}</button>
      <button type="button" onclick={() => { editingName = false; }}>{word("cancel")}</button>
    </form>
  {/if}
  {#if pending}
    <div class="saved-confirm">
      <p>{pending.kind === "replace" ? `Replace the saved filter “${pending.name}”?` : `Delete the saved filter “${pending.name}”?`}</p>
      <button type="button" onclick={confirmSavedChange}>{word("yes")}</button>
      <button type="button" onclick={() => { pending = null; }}>{word("no")}</button>
    </div>
  {/if}
  {#if saveError}<p role="status">{saveError}</p>{/if}
</fieldset>

<style>
  .saved-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 6px 0; }
  .saved-options, .saved-filters form, .saved-confirm { width: 100%; }
  .saved-options { display: grid; gap: 8px; padding: 0; margin: 0; list-style: none; }
  .saved-options li, .saved-filters form, .saved-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .saved-options li { justify-content: space-between; padding: 8px; background: #ffffff08; }
  label { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  p { margin: 0; }
</style>
