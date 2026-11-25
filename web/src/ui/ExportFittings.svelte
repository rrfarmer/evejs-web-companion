<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { FittingSource } from "../bridge/sharedFittings.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { writeFittingFile } from "../bridge/fittingFileImport.ts";
  import { resolvedName } from "../store/names.ts";

  type Owner = Exclude<FittingSource, "community">;
  let { store, flow, initialOwner = "personal", onClose }: {
    store: ClientStore; flow: AppFlow; initialOwner?: Owner; onClose: () => void;
  } = $props();
  const library = $derived(flow.savedFittings);
  const words = $derived(store.words);
  const station = $derived(store.station);
  const labels = {
    title: ["UI/Fitting/ExportFittings", "Export Fittings"],
    personal: ["UI/Fitting/FittingWindow/FittingManagement/PersonalFittings", "Personal Fittings"],
    corporation: ["UI/Fitting/FittingWindow/FittingManagement/CorporationFittings", "Corporation Fittings"],
    alliance: ["UI/Fitting/FittingWindow/FittingManagement/AllianceFittings", "Alliance Fittings"],
    name: ["UI/Common/Files/FileName", "File Name"],
    export: ["UI/Commands/Export", "Export"],
  } as const;
  const word = (label: keyof typeof labels) => plainText($words.templates[labels[label][0]] || labels[label][1]);
  let choice = $state<Owner>("personal");
  const owner = $derived(choice === "alliance" && !$station.online?.allianceID ? "personal" : choice);
  let excluded = $state<readonly number[]>([]);
  let filename = $state("");
  let busy = $state(false);
  let error = $state("");
  let active = false;
  const shown = $derived(($library ?? []).filter(fit => fit.source === owner)
    .sort((a, b) => plainText(a.name).localeCompare(plainText(b.name))));
  const selected = $derived(shown.filter(fit => !excluded.includes(fit.fittingID)));

  onMount(() => {
    active = true;
    choice = initialOwner;
    flow.requestWords(Object.values(labels).map(([label]) => label));
    if ($library === null) void flow.loadSavedFittings().catch(cause => { if (active) error = String(cause); });
    return () => { active = false; };
  });

  async function download() {
    if (busy || !selected.length) return;
    const base = filename.trim().replace(/\.xml$/i, "");
    if (!base || /[?*:;~\\/"|<>]/.test(base) || base === "." || base === "..") {
      error = "Enter a valid file name.";
      return;
    }
    const fittings = selected;
    busy = true;
    error = "";
    try {
      const types = new Set(fittings.flatMap(fit => [fit.shipTypeID, ...fit.modules.map(module => module.typeID)]));
      await flow.flying.resolveNamesNow([...types].map(id => ({ kind: "type", id })));
      if (!active) return;
      const names = store.names.get().resolved;
      const xml = writeFittingFile(fittings, id => {
        const name = resolvedName(names, "type", id, "");
        if (!name) throw new Error(`Type ${id} has no name and could not be exported.`);
        return name;
      });
      const url = URL.createObjectURL(new Blob([xml], { type: "application/xml;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${base}.xml`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      onClose();
    } catch (cause) {
      if (active) error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (active) busy = false;
    }
  }
</script>

<section class="fit-export-file" aria-label={word("title")} aria-busy={busy}>
  <h3>{word("title")}</h3>
  <select aria-label="Export fitting library" value={owner} disabled={busy}
    onchange={(event) => { choice = event.currentTarget.value as Owner; excluded = []; }}>
    <option value="personal">{word("personal")}</option>
    <option value="corporation">{word("corporation")}</option>
    {#if $station.online?.allianceID}<option value="alliance">{word("alliance")}</option>{/if}
  </select>
  {#if shown.length}
    <label class="export-check-all"><input type="checkbox" checked={selected.length === shown.length} disabled={busy}
      onchange={(event) => (excluded = event.currentTarget.checked ? [] : shown.map(fit => fit.fittingID))} /> Select All</label>
    <ul>{#each shown as fit (fit.fittingID)}
      <li><label>
        <input type="checkbox" checked={!excluded.includes(fit.fittingID)} disabled={busy}
          onchange={(event) => (excluded = event.currentTarget.checked
            ? excluded.filter(id => id !== fit.fittingID) : [...excluded, fit.fittingID])} />
        {plainText(fit.name)}
      </label></li>
    {/each}</ul>
  {:else if $library !== null}
    <p>No fittings in this library.</p>
  {/if}
  <form onsubmit={(event) => { event.preventDefault(); void download(); }}>
    <label>{word("name")} <input bind:value={filename} maxlength="32" disabled={busy} /></label>
    <button type="submit" class="fit-export-download" disabled={busy || !filename.trim() || !selected.length}>{word("export")}</button>
    <button type="button" onclick={onClose}>Cancel</button>
  </form>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .fit-export-file { border: 1px solid var(--line, #444); padding: 8px; margin-block: 6px; }
  h3 { margin: 0 0 8px; }
  .export-check-all { display: block; margin-top: 8px; }
  ul { max-height: 10rem; overflow: auto; list-style: none; padding: 0; }
  form { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
</style>
