<script lang="ts">
  import { onDestroy } from "svelte";
  import type { AppFlow, MoneyTransferRecipient } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow, selected, close }: {
    store: ClientStore; flow: AppFlow; selected: (row: MoneyTransferRecipient) => void; close: () => void;
  } = $props();
  const words = $derived(store.words);
  const prefix = "UI/Wallet/WalletWindow/";
  const labels = {
    caption: [prefix + "SelectCorpOrChar", "Select Corporation or Character"],
    query: ["UI/Shared/TypeSearchString", "Search text"],
    search: [prefix + "WalletSearch", "Search"],
    empty: [prefix + "SearchNoResults", "No results"],
    ok: ["UI/Common/Buttons/OK", "OK"],
    cancel: ["UI/Common/Buttons/Cancel", "Cancel"],
  } as const;
  $effect(() => { flow.requestWords(Object.values(labels).map(([path]) => path)); });
  function word(key: keyof typeof labels): string {
    const [path, fallback] = labels[key];
    return plainText($words.templates[path] ?? "") || fallback;
  }

  let text = $state("");
  let searched = $state("");
  let rows = $state.raw<readonly MoneyTransferRecipient[]>([]);
  let chosen = $state<MoneyTransferRecipient | null>(null);
  let busy = $state(false);
  let error = $state("");
  let generation = 0;
  onDestroy(() => { generation++; });
  async function search(event: SubmitEvent) {
    event.preventDefault();
    const query = text.trim();
    if (!query) return;
    const request = ++generation;
    searched = query;
    busy = true;
    error = "";
    chosen = null;
    rows = [];
    try {
      const result = await flow.searchCorporationTransferRecipients(query);
      if (request === generation) rows = result;
    } catch (cause) {
      if (request === generation) error = panelErrorWords(cause);
    } finally {
      if (request === generation) busy = false;
    }
  }
</script>

<section class="wallet-transfer-recipient" aria-label={word("caption")}>
  <h3>{word("caption")}</h3>
  <form class="controls" onsubmit={search}>
    <label>{word("query")} <input maxlength="32" bind:value={text} /></label>
    <button type="submit" disabled={busy || !text.trim()}>{word("search")}</button>
  </form>
  {#if error}
    <p role="alert">{error}</p>
  {:else if busy}
    <p role="status">Searching…</p>
  {:else if searched && rows.length === 0}
    <p>{word("empty")}</p>
  {:else if rows.length > 0}
    <div class="results" role="group" aria-label={word("caption")}>
      {#each rows as row (row.id)}
        <button type="button" aria-pressed={chosen?.id === row.id} class:active={chosen?.id === row.id}
          onclick={() => (chosen = row)} ondblclick={() => selected(row)}>{row.name}</button>
      {/each}
    </div>
  {/if}
  <div class="controls">
    <button type="button" disabled={!chosen || text.trim() !== searched} onclick={() => { if (chosen) selected(chosen); }}>{word("ok")}</button>
    <button type="button" onclick={close}>{word("cancel")}</button>
  </div>
</section>

<style>
  .wallet-transfer-recipient { display: grid; gap: 0.5rem; padding: 0.75rem 0; }
  h3, p { margin: 0; }
  .results { display: flex; flex-wrap: wrap; gap: 0.375rem; }
</style>
