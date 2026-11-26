<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { readPlexStatistics, PLEX_HISTORY_LIMIT, type PlexCategoryTotals } from "../bridge/plexHistory.ts";
  import { decodePlexWalletNotice, PLEX_WALLET_NOTICE } from "../bridge/plexWalletNotice.ts";
  import { fmtAmtShort } from "../bridge/pyNumbers.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const words = $derived(store.words);
  const groupName = $props.id();
  const labels = {
    income: ["UI/Wallet/WalletWindow/Income", "Income"],
    expenses: ["UI/Wallet/WalletWindow/Expenses", "Expenses"],
    plex: ["UI/Common/PLEX", "PLEX"],
    empty: ["UI/Wallet/WalletWindow/HintNoTransactionsFound", "No transactions found"],
    window: ["UI/PlexVault/MaxTransactionsShown", "Shows the last 2,000 transactions"],
  } as const;
  const colors: Readonly<Record<number, string>> = {
    1021274: "#0b3c5d", 1021275: "#328cc1", 1021276: "#66b9bf", 1021277: "#a8e0e0",
    1021278: "#98ff98", 1021780: "#2e8b57", 1021281: "#7d1fe0", 1021282: "#b57edc", 1022601: "#708090",
  };
  const radius = 95;
  const circumference = 2 * Math.PI * radius;
  const format = (cents: bigint) => fmtAmtShort(Number(cents / 100n));
  let entries = $state.raw<readonly PlexCategoryTotals[] | null>(null);
  let mode = $state<"income" | "expenses">("income");
  let error = $state("");
  let online = false;
  let revision = 0;

  const totalIncome = $derived(entries?.reduce((sum, row) => sum + row.income, 0n) ?? 0n);
  const totalExpenses = $derived(entries?.reduce((sum, row) => sum + row.expenses, 0n) ?? 0n);
  const total = $derived(mode === "income" ? totalIncome : totalExpenses);
  const sign = $derived(mode === "income" ? "+" : "-");
  const legend = $derived.by(() => {
    if (!entries || total === 0n) return [];
    return entries.flatMap(row => {
      const value = row[mode];
      if (value === 0n) return [];
      const category = plainText($words.templates[`#${row.categoryID}`] ?? "").trim() || "Uncategorized";
      const color = colors[row.categoryID] ?? `hsl(${(row.categoryID * 137) % 360} 48% 64%)`;
      const ratio = Number(value) / Number(total);
      return [{ id: row.categoryID, value, label: `${(ratio * 100).toFixed(1)}% ${category}`, ratio, color }];
    }).sort((a, b) => Number(b.value - a.value));
  });
  const segments = $derived.by(() => {
    const minimum = 0.02;
    const scale = legend.reduce((sum, row) => sum + Math.max(minimum, row.ratio), 0);
    let start = 0;
    return [...legend].sort((a, b) => Number(a.value - b.value)).map(row => {
      const ratio = Math.max(minimum, row.ratio) / scale;
      const segment = { ...row, start, span: Math.max(0, ratio - 0.005) };
      start += ratio;
      return segment;
    });
  });
  const footer = $derived(word("window", { amount: PLEX_HISTORY_LIMIT.toLocaleString("en-US") }));

  function word(key: keyof typeof labels, args: Record<string, string | number> = {}) {
    const [path, fallback] = labels[key];
    const template = $words.templates[path];
    return template ? plainText(formatTemplate(template, args, { nameOf: () => "" })) : fallback;
  }

  function hint(row: (typeof legend)[number]): string {
    return `${row.label}\n${sign}${(row.value / 100n).toLocaleString("en-US")} ${word("plex")}`;
  }

  async function refresh() {
    const request = ++revision;
    error = "";
    try {
      const rows = await readPlexStatistics(flow.requestOptions());
      if (!online || request !== revision) return;
      entries = rows;
      flow.requestWords(rows.map(row => `#${row.categoryID}`));
    } catch (cause) {
      if (online && request === revision) error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  onMount(() => {
    online = true;
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
</script>

<section class="plex-analytics" aria-label="PLEX overview">
  {#if error}
    <p role="alert">{error}</p>
    <button type="button" onclick={() => void refresh()}>Refresh</button>
  {:else if entries === null}
    <p role="status">Loading PLEX overview…</p>
  {:else}
    <div class="analytics-body">
      <svg class="donut" viewBox="-115 -115 230 230" role="img" aria-label={`${word(mode)} ${sign}${format(total)} ${word("plex")}`}>
        {#each segments as segment (segment.id)}
          <circle r={radius} fill="none" stroke={segment.color} stroke-width="15" data-category={segment.id}
            stroke-dasharray={`${segment.span * circumference} ${circumference}`} stroke-dashoffset={-segment.start * circumference}
            transform="rotate(-90)">
            <title>{hint(segment)}</title>
          </circle>
        {:else}
          <circle r={radius} fill="none" stroke="currentColor" stroke-opacity="0.1" stroke-width="15"><title>{word("empty")}</title></circle>
        {/each}
        <text class="total" text-anchor="middle" y="-2">{sign}{format(total)}</text>
        <text class="currency" text-anchor="middle" y="18">{word("plex")}</text>
      </svg>
      <div class="analytics-controls">
        <label>
          <input type="radio" name={groupName} value="income" bind:group={mode} />
          <span>{word("income")}<br /><strong data-plex-total="income">+{format(totalIncome)} {word("plex")}</strong></span>
        </label>
        <label>
          <input type="radio" name={groupName} value="expenses" bind:group={mode} />
          <span>{word("expenses")}<br /><strong data-plex-total="expenses">-{format(totalExpenses)} {word("plex")}</strong></span>
        </label>
        <ul>
          {#each legend as row (row.id)}
            <li data-category={row.id} title={hint(row)}><span class="swatch" style:background={row.color}></span>{row.label}</li>
          {:else}
            {#if entries.length === 0}<li class="empty">{word("empty")}</li>{/if}
          {/each}
        </ul>
      </div>
    </div>
    <p class="retention">{footer}</p>
  {/if}
</section>

<style>
  .plex-analytics { flex: 1 1 24rem; min-width: 0; }
  .analytics-body { display: flex; flex-wrap: wrap; align-items: center; column-gap: 1rem; }
  .donut { width: min(100%, 14rem); height: auto; color: var(--color-text); }
  .total { font-size: 22px; fill: var(--color-text-bright); }
  .currency { font-size: 13px; fill: var(--color-muted); }
  .analytics-controls { display: flex; flex-direction: column; gap: 0.5rem; min-width: 9rem; }
  label, li { display: flex; align-items: flex-start; gap: 0.4rem; }
  ul { list-style: none; padding: 0; margin: 4px 0 0; }
  li { padding: 2px 0; align-items: center; }
  .swatch { width: 10px; height: 10px; flex: none; }
  .retention { color: var(--color-muted); margin: 0.45rem 0 0; }
</style>
