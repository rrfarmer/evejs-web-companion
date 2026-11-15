<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { FittingFileEntry } from "../bridge/fittingFileImport.ts";

  let { flow, title, onClose, onImported }: {
    flow: AppFlow;
    title: string;
    onClose: () => void;
    onImported: (count: number) => void;
  } = $props();

  let rows = $state<readonly FittingFileEntry[]>([]);
  let chosen = $state<number[]>([]);
  let owners = $state<Awaited<ReturnType<AppFlow["fittingFileOwners"]>>>([]);
  let ownerID = $state<number>(0);
  let busy = $state(false);
  let message = $state("");
  let active = false;
  const labels = { character: "Personal", corporation: "Corporation", alliance: "Alliance" };
  const importable = (row: FittingFileEntry) => Boolean(row.shipTypeID && row.name.trim() && row.fitData.length);
  const ready = $derived(rows.filter((row, index) => chosen.includes(index) && importable(row)));

  onMount(() => {
    active = true;
    void flow.fittingFileOwners().then(result => {
      if (!active) return;
      owners = result;
      ownerID = result[0]?.id ?? 0;
    }).catch(() => { if (active) message = "The fitting library could not be loaded."; });
    return () => { active = false; };
  });

  async function load(file: File | undefined) {
    rows = [];
    chosen = [];
    message = "";
    if (!file) return;
    busy = true;
    try {
      const content = await flow.previewFittingFile(await file.text());
      if (!active) return;
      rows = content;
      chosen = content.flatMap((row, index) => importable(row) ? [index] : []);
    } catch (error) {
      if (active) message = error instanceof Error ? error.message : "The fitting file could not be read.";
    } finally { if (active) busy = false; }
  }

  async function save() {
    if (!ownerID || !ready.length || busy) return;
    message = "";
    busy = true;
    try {
      const count = await flow.saveFittingFile(ownerID, ready);
      if (active) onImported(count);
    } catch (error) {
      if (active) message = error instanceof Error ? error.message : "The fittings could not be saved.";
    } finally { if (active) busy = false; }
  }
</script>

<section class="fit-file" aria-label={title} aria-busy={busy}>
  <h3>{title}</h3>
  <label>Fitting file <input type="file" accept=".xml,text/xml,application/xml" disabled={busy}
    onchange={event => void load(event.currentTarget.files?.[0])} /></label>
  {#if message}<p role="status">{message}</p>{/if}
  {#if rows.length}
    <div class="fit-file-actions">
      <button type="button" disabled={busy} onclick={() => { chosen = rows.flatMap((row, index) => importable(row) ? [index] : []); }}>Select All</button>
      <button type="button" disabled={busy} onclick={() => { chosen = []; }}>Deselect All</button>
      <span>{ready.length} selected</span>
    </div>
    <ul>
      {#each rows as row, index}
        <li>
          <label><input type="checkbox" value={index} bind:group={chosen} disabled={busy || !importable(row)} />
            {row.name || "Unnamed fitting"} · {row.hull || "Unknown ship"}</label>
          {#if row.unknownTypes.length}<div>Unknown types · {row.unknownTypes.join(", ")}</div>{/if}
          {#if row.invalidSlots.length}<div>Invalid slots · {row.invalidSlots.join(", ")}</div>{/if}
          {#if row.obsoleteModules.length}<div>Obsolete modules · {row.obsoleteModules.join(", ")}</div>{/if}
          {#if row.shipTypeID && !row.fitData.length}<div>No usable hardware</div>{/if}
        </li>
      {/each}
    </ul>
  {/if}
  <div class="fit-file-actions">
    {#if owners.length > 1}
      <label>Save for <select bind:value={ownerID} disabled={busy}>
        {#each owners as owner (owner.id)}<option value={owner.id}>{labels[owner.kind]}</option>{/each}
      </select></label>
    {/if}
    <button type="button" disabled={busy || !ownerID || !ready.length} onclick={() => void save()}>Import</button>
    <button type="button" disabled={busy} onclick={onClose}>Cancel</button>
  </div>
</section>

<style>
  .fit-file { border: 1px solid var(--line, #444); padding: 8px; margin-block: 6px; }
  h3 { margin: 0 0 6px; }
  input[type=file] { max-width: 100%; }
  .fit-file-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
  ul { max-height: 13rem; overflow: auto; margin: 6px 0; padding: 0; list-style: none; }
  li { padding-block: 3px; }
  li div { margin-left: 1.2em; opacity: 0.8; }
</style>
