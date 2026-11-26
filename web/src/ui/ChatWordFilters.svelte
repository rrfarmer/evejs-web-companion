<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { flow, store, close }: { flow: AppFlow; store: ClientStore; close: () => void } = $props();
  const words = $derived(store.words);
  const paths = {
    title: "UI/Chat/ChannelWindow/ChatWordFilters",
    banned: "UI/Chat/ChannelWindow/BannedWordText",
    highlight: "UI/Chat/ChannelWindow/HighlightWordText",
    always: "UI/Chat/ChannelWindow/AlwaysBlink",
    separator: "UI/Chat/ChannelWindow/WordSeparatorText",
    save: "UI/Common/Buttons/Save",
    cancel: "UI/Common/Buttons/Cancel",
  } as const;
  const label = (key: keyof typeof paths, fallback: string) => plainText($words.templates[paths[key]] ?? "") || fallback;
  let dialog: HTMLDialogElement;
  let banned = $state("");
  let highlight = $state("");
  let alwaysBlink = $state(false);
  let loaded = $state(false);
  let saving = $state(false);
  let error = $state("");

  onMount(() => {
    let mounted = true;
    dialog.showModal();
    flow.requestWords(Object.values(paths));
    void flow.conversations.loadActivity().then(filters => {
      if (!mounted) return;
      banned = filters.bannedWords.join(", ");
      highlight = filters.highlightWords.join(", ");
      alwaysBlink = filters.blinkOnHighlightWords;
      loaded = true;
    }).catch(() => { if (mounted) error = "The chat word filters could not be read."; });
    return () => { mounted = false; };
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!loaded || saving) return;
    const splitWords = (value: string) => value.split(",").map(word => word.trim()).filter(Boolean);
    saving = true;
    error = "";
    try {
      await flow.conversations.saveWordFilters({
        bannedWords: splitWords(banned), highlightWords: splitWords(highlight), blinkOnHighlightWords: alwaysBlink,
      });
      close();
    } catch {
      error = "The chat word filters could not be saved.";
    } finally {
      saving = false;
    }
  }
</script>

<dialog bind:this={dialog} class="chat-word-filters" aria-label={label("title", "Chat Word Filters")}
  oncancel={(event) => { event.preventDefault(); if (!saving) close(); }}>
  <h2>{label("title", "Chat Word Filters")}</h2>
  {#if error}<p role="alert">{error}</p>{/if}
  <form onsubmit={save}>
    <label>{label("banned", "Banned words")}
      <textarea bind:value={banned} disabled={!loaded || saving} placeholder={label("separator", "Separate words with commas")}></textarea>
    </label>
    <label>{label("highlight", "Highlight words")}
      <textarea bind:value={highlight} disabled={!loaded || saving} placeholder={label("separator", "Separate words with commas")}></textarea>
    </label>
    <label class="always"><input type="checkbox" bind:checked={alwaysBlink} disabled={!loaded || saving} />
      {label("always", "Always Blink")}
    </label>
    <div class="actions">
      <button type="submit" disabled={!loaded || saving}>{label("save", "Save")}</button>
      <button type="button" disabled={saving} onclick={close}>{label("cancel", "Cancel")}</button>
    </div>
  </form>
</dialog>

<style>
  dialog { width: min(380px, calc(100vw - 2rem)); color: var(--color-text); background: var(--color-panel); border: 1px solid var(--color-line); }
  form, label:not(.always) { display: grid; gap: 0.5rem; }
  textarea { min-height: 6rem; resize: vertical; }
  .actions { display: flex; justify-content: end; gap: 0.5rem; }
</style>
