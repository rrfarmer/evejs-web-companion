<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { MAX_STRUCTURE_DESCRIPTION_LENGTH } from "../bridge/structures.ts";

  let { flow, structureID, structureName, title, onClose }: {
    flow: AppFlow; structureID: number; structureName: string; title: string; onClose: () => void;
  } = $props();
  let initial = $state<string | null>(null);
  let draft = $state("");
  let saving = $state(false);
  let error = $state("");
  let active = false;

  onMount(() => {
    active = true;
    void flow.loadStructureDescription(structureID).then(description => {
      if (active) draft = initial = plainText(description);
    }).catch(cause => { if (active) error = panelErrorWords(cause); });
    return () => { active = false; };
  });

  async function save(): Promise<void> {
    if (initial === null || saving) return;
    if (draft === initial) {
      onClose();
      return;
    }
    saving = true;
    error = "";
    try {
      await flow.saveStructureDescription(structureID, draft);
      if (active) onClose();
    } catch (cause) {
      if (active) error = panelErrorWords(cause);
    } finally {
      if (active) saving = false;
    }
  }
</script>

<form class="structure-description" aria-label={title} onsubmit={(event) => { event.preventDefault(); void save(); }}>
  <h3>{title}</h3>
  <strong>{structureName}</strong>
  {#if initial !== null}
    <label>Description
      <textarea rows="5" maxlength={MAX_STRUCTURE_DESCRIPTION_LENGTH} bind:value={draft} disabled={saving}></textarea>
    </label>
  {:else if !error}
    <p role="status">Loading description…</p>
  {/if}
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  <div class="controls">
    <button type="submit" disabled={initial === null || saving}>OK</button>
    <button type="button" disabled={saving} onclick={onClose}>Cancel</button>
  </div>
</form>

<style>
  .structure-description { display: grid; gap: 6px; padding: 8px; border: 1px solid var(--line, #444); }
  h3, p { margin: 0; }
  label { display: grid; gap: 4px; }
  textarea { resize: vertical; }
  .controls { display: flex; gap: 6px; }
</style>
