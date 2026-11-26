<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { decodePlexWalletNotice, PLEX_WALLET_NOTICE } from "../bridge/plexWalletNotice.ts";
  import { plexHistoryCsv, plexHistoryReader, readPlexHistoryIDs, PLEX_HISTORY_LIMIT, PLEX_HISTORY_PAGE_SIZE,
    type PlexTransaction } from "../bridge/plexHistory.ts";

  let { flow, store }: { flow: AppFlow; store: ClientStore } = $props();
  const words = $derived(store.words);
  const labels = {
    date: ["UI/Common/Date", "Date"],
    type: ["UI/Wallet/WalletWindow/ColHeaderType", "Type"],
    amount: ["UI/Wallet/WalletWindow/ColHeaderAmount", "Amount"],
    balance: ["UI/Wallet/WalletWindow/ColHeaderBalance", "Balance"],
    summary: ["UI/Wallet/WalletWindow/ColHeaderSummary", "Summary"],
    sort: ["UI/Common/SortBy", "Sort By"],
    ascending: ["UI/PlexVault/Logs/SortAscending", "Oldest first"],
    descending: ["UI/PlexVault/Logs/SortDescending", "Newest first"],
    export: ["UI/PlexVault/Logs/ExportAll", "Export all"],
    exportFailed: ["UI/PlexVault/Logs/PlexLogsExportFailed", "Could not export PLEX transactions."],
    empty: ["UI/Wallet/WalletWindow/HintNoTransactionsFound", "No transactions found"],
    previous: ["UI/Common/Previous", "Previous"],
    next: ["UI/Common/ViewMore", "View More"],
    range: ["UI/Wallet/WalletWindow/ShowingTransactions", ""],
    limit: ["UI/PlexVault/MaxTransactionsShown", ""],
  } as const;
  function word(key: keyof typeof labels, args: Record<string, string | number> = {}, fallback?: string) {
    const [path, own] = labels[key];
    const template = $words.templates[path];
    return template ? plainText(formatTemplate(template, args, { nameOf: () => "" })) : fallback ?? own;
  }
  const headers = $derived((["date", "type", "amount", "balance", "summary"] as const).map(key => word(key)));
  let reader = $state.raw<ReturnType<typeof plexHistoryReader> | null>(null);
  let online = false;
  let listRevision = 0;
  let ids = $state.raw<readonly string[] | null>(null);
  let page = $state(0);
  let order = $state<"ascending" | "descending">("descending");
  let rows = $state.raw<readonly (PlexTransaction | null)[]>([]);
  let listLoading = $state(true);
  let pageLoading = $state(false);
  let exporting = $state(false);
  let exportNotice = $state("");
  let listError = $state("");
  let pageError = $state("");
  const count = $derived(ids?.length ?? 0);
  const pages = $derived(Math.ceil(count / PLEX_HISTORY_PAGE_SIZE));
  const start = $derived(page * PLEX_HISTORY_PAGE_SIZE);
  const limitText = $derived(word("limit", { amount: PLEX_HISTORY_LIMIT.toLocaleString("en-US") }, "Shows the last 2,000 transactions"));
  const rangeText = $derived(word("range", { numFirst: start + 1, numLast: Math.min(count, start + PLEX_HISTORY_PAGE_SIZE), numTotal: count },
    `Showing transactions ${start + 1}–${Math.min(count, start + PLEX_HISTORY_PAGE_SIZE)} of ${count}`));

  async function refresh() {
    const revision = ++listRevision;
    listLoading = true;
    listError = "";
    try {
      const latest = await readPlexHistoryIDs(flow.requestOptions());
      if (!online || revision !== listRevision) return;
      page = Math.min(page, Math.max(0, Math.ceil(latest.length / PLEX_HISTORY_PAGE_SIZE) - 1));
      ids = latest;
    } catch (error) {
      if (online && revision === listRevision) listError = error instanceof Error ? error.message : String(error);
    } finally {
      if (online && revision === listRevision) listLoading = false;
    }
  }

  onMount(() => {
    online = true;
    reader = plexHistoryReader(flow.requestOptions());
    flow.requestWords(Object.values(labels).map(([path]) => path));
    void refresh();
    const notices = flow.gatewayNotices;
    let previous = notices.get();
    const stopNotices = notices.subscribe(notice => {
      if (previous === notice) return;
      previous = notice;
      if (notice?.typeName === PLEX_WALLET_NOTICE && decodePlexWalletNotice(notice.payload)) void refresh();
    });
    const changes = flow.plexVaultChanged;
    let lastChange = changes.get();
    const stopChanges = changes.subscribe(change => {
      if (change === lastChange) return;
      lastChange = change;
      void refresh();
    });
    return () => { online = false; stopNotices(); stopChanges(); };
  });

  $effect(() => {
    if (!reader || !ids) return;
    const sequence = order === "ascending" ? [...ids].reverse() : ids;
    const pageIDs = sequence.slice(start, start + PLEX_HISTORY_PAGE_SIZE);
    let current = true;
    pageLoading = true;
    pageError = "";
    rows = [];
    void reader(pageIDs, () => current).then(result => {
      if (current) rows = result;
    }).catch(error => {
      if (current) pageError = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      if (current) pageLoading = false;
    });
    return () => { current = false; };
  });

  async function exportAll() {
    if (!reader || !ids?.length || exporting) return;
    const wanted = ids;
    const columnNames = headers;
    exporting = true;
    exportNotice = "";
    try {
      const result = await reader(wanted, () => online);
      if (!online) return;
      const complete = result.filter(row => row !== null);
      if (complete.length !== wanted.length) throw new Error("Incomplete PLEX history");
      await navigator.clipboard.writeText(plexHistoryCsv(columnNames, complete));
      if (online) exportNotice = "PLEX transactions copied.";
    } catch {
      if (online) exportNotice = word("exportFailed");
    } finally {
      if (online) exporting = false;
    }
  }

  function time(date: Date): string {
    return date.toISOString().slice(0, 16).replace("T", " ").replaceAll("-", ".");
  }

  const units = (cents: bigint) => (cents / 100n).toLocaleString("en-US");
</script>

<section class="plex-history" aria-label="PLEX transactions" aria-busy={listLoading || pageLoading}>
  {#if listError}
    <p role="alert">{listError}</p>
    <button type="button" onclick={() => void refresh()}>Refresh</button>
  {:else if listLoading && ids === null}
    <p role="status">Loading PLEX transactions…</p>
  {:else if count === 0}
    <p role="status">{word("empty")}</p>
  {:else}
    <div class="controls">
      <label>{word("sort")}
        <select bind:value={order}>
          <option value="ascending">{word("ascending")}</option>
          <option value="descending">{word("descending")}</option>
        </select>
      </label>
      <span>{limitText}</span>
      <button type="button" title={word("export")} disabled={exporting} onclick={() => void exportAll()}>Export all</button>
    </div>
    <div class="table">
      <table class="guests">
        <thead><tr>{#each headers as header}<th scope="col">{header}</th>{/each}</tr></thead>
        <tbody>
          {#if pageError}
            <tr><td colspan="5"><span role="alert">{pageError}</span> <button type="button" onclick={() => void refresh()}>Refresh</button></td></tr>
          {:else if pageLoading}
            <tr><td colspan="5" role="status">Loading PLEX transactions…</td></tr>
          {/if}
          {#each rows as row}
            <tr>
              {#if row}
                <td>{time(row.date)}</td>
                <td>{row.category}</td>
                <td class:credit={row.amount >= 0n} class:debit={row.amount < 0n}>{units(row.amount)}</td>
                <td>{units(row.balance)}</td>
                <td>{row.summary}</td>
              {:else}
                <td colspan="5">Transaction unavailable</td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if pages > 1}
      <div class="controls">
        <button type="button" disabled={page === 0} onclick={() => page--}>{word("previous")}</button>
        <span>{rangeText}</span>
        <button type="button" disabled={page + 1 >= pages} onclick={() => page++}>{word("next")}</button>
      </div>
    {/if}
  {/if}
  {#if exportNotice}<p role="status">{exportNotice}</p>{/if}
</section>

<style>
  .plex-history { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; }
  .controls { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: 8px; }
  .table { overflow-x: auto; }
  table { width: 100%; }
  td:first-child { white-space: nowrap; }
  .credit { color: #9acc84; }
  .debit { color: #fc9c95; }
</style>
