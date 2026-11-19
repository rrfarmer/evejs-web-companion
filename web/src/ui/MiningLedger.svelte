<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import {
    filterMiningLedger, ledgerDateRange, ledgerFilterOf, miningLedgerDaily, miningLedgerTotals,
    type LedgerMetric, type MiningLedgerEntry, type MiningLedgerFacts,
  } from "../bridge/miningLedger.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const names = $derived(store.names);
  let response = $state.raw<Awaited<ReturnType<AppFlow["loadMiningLedger"]>> | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let copyStatus = $state("");
  let from = $state<string | null>(null);
  let to = $state<string | null>(null);
  let resources = $state.raw<ReadonlySet<string>>(new Set());
  let typeMetric = $state<LedgerMetric>("quantity");
  let dayMetric = $state<LedgerMetric>("quantity");
  let page = $state(0);
  let sortColumn = $state(0);
  let descending = $state(true);
  let request = 0;

  const emptyFacts: ReadonlyMap<number, MiningLedgerFacts> = new Map();
  const range = $derived(ledgerDateRange(response?.nowMs ?? Date.now()));
  const selectedFrom = $derived(from ?? range.from);
  const selectedTo = $derived(to ?? range.to);
  const facts = $derived(response?.facts ?? emptyFacts);
  const rows = $derived(response?.rows ?? []);
  const filtered = $derived(filterMiningLedger(rows, facts, selectedFrom, selectedTo, resources));
  const timeline = $derived(miningLedgerDaily(rows, facts, range.first, range.to, "quantity"));
  const dailyTypes = $derived(new Set(miningLedgerTotals(filtered, facts, dayMetric).flatMap(row => row.typeID === null ? [] : [row.typeID])));
  const daily = $derived(miningLedgerDaily(filtered, facts, selectedFrom, selectedTo, dayMetric, dailyTypes));
  const totals = $derived(miningLedgerTotals(filtered, facts, typeMetric));
  const timelineMax = $derived(Math.max(1, ...timeline.map(day => day.quantity)));
  const dailyMax = $derived(Math.max(1, ...daily.map(day => day.quantity)));
  const totalsMax = $derived(Math.max(1, ...totals.map(row => row.quantity)));
  const typeName = (id: number) => resolvedName($names.resolved, "type", id, `Type ${id}`);
  const systemName = (id: number) => resolvedName($names.resolved, "system", id, `System ${id}`);
  const resourceOptions = $derived.by(() => {
    const items = new Map<string, string>();
    for (const row of rows) {
      const key = ledgerFilterOf(row.typeID, facts.get(row.typeID));
      const id = Number(key.split(":")[1]);
      const label = key.startsWith("group:") ? resolvedName($names.resolved, "group", id, `Group ${id}`) : typeName(id);
      items.set(key, label);
    }
    return [...items].sort((a, b) => a[1].localeCompare(b[1]));
  });

  const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });
  const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const labels = ["Date (UTC)", "Resource", "Mined", "Residue", "Volume", "Residue volume", "Est. value", "Est. residue value", "System"];
  const metrics = [
    { key: "quantity", label: "Units" }, { key: "volume", label: "Volume" }, { key: "value", label: "Est. value" },
  ] as const;
  const pageSize = 100;
  const suffix = (metric: LedgerMetric) => metric === "quantity" ? " units" : metric === "volume" ? " m³" : " ISK";
  const swatch = (id: number) => `hsl(${(id * 137.508) % 360} 47% 63%)`;

  function rowValues(row: MiningLedgerEntry) {
    const info = facts.get(row.typeID);
    const volume = info?.volume ?? null;
    const price = info?.price ?? null;
    return [row.atMs, typeName(row.typeID), row.quantity, row.wasted,
      volume === null ? null : volume * row.quantity, volume === null ? null : volume * row.wasted,
      price === null ? null : price * row.quantity, price === null ? null : price * row.wasted, systemName(row.systemID)];
  }

  const ordered = $derived(filtered.map(row => ({ row, values: rowValues(row) })).sort((a, b) => {
    const left = a.values[sortColumn];
    const right = b.values[sortColumn];
    if (left == null || right == null) return Number(left == null) - Number(right == null);
    const result = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
    return descending ? -result : result;
  }));
  const pageCount = $derived(Math.ceil(ordered.length / pageSize));
  const currentPage = $derived(Math.min(page, Math.max(0, pageCount - 1)));
  const shownRows = $derived(ordered.slice(currentPage * pageSize, (currentPage + 1) * pageSize));

  async function read(owner: AppFlow) {
    const version = ++request;
    loading = true;
    error = null;
    try {
      const latest = await owner.loadMiningLedger();
      if (version === request) response = latest;
    } catch (cause) {
      if (version === request) error = cause instanceof Error ? cause.message : "The Mining Ledger could not be read.";
    } finally {
      if (version === request) loading = false;
    }
  }

  $effect(() => {
    const owner = flow;
    response = null;
    copyStatus = "";
    resources = new Set();
    from = to = null;
    page = 0;
    void read(owner);
    return () => { request++; };
  });

  function setDate(which: "from" | "to", value: string) {
    if (!value || value < range.first || value > range.to) return;
    if (which === "from") {
      from = value;
      if (value > selectedTo) to = value;
    } else {
      to = value;
      if (value < selectedFrom) from = value;
    }
    page = 0;
  }

  function selectResource(key: string) {
    const next = new Set(resources);
    if (!next.delete(key)) next.add(key);
    resources = next;
    page = 0;
  }

  function sortBy(column: number) {
    descending = sortColumn === column ? !descending : column !== 1 && column !== 8;
    sortColumn = column;
    page = 0;
  }

  function cell(value: string | number | null | undefined, column: number): string {
    if (value == null) return "—";
    if (typeof value === "string") return value;
    if (column === 0) return date.format(value);
    if (column === 4 || column === 5) return `${numbers.format(value)} m³`;
    if (column === 6 || column === 7) return value === 0 ? "—" : `${numbers.format(Math.round(value))} ISK`;
    return numbers.format(value);
  }

  async function copy() {
    const copiedValue = (value: string | number | null, index: number) => {
      if (value === null || ((index === 5 || index === 6) && value === 0)) return "";
      if (typeof value !== "number") return value;
      if (index === 5 || index === 6) return Math.trunc(value);
      return index === 3 || index === 4 ? Number(value.toPrecision(15)) : value;
    };
    const header = [...labels, "Resource type ID", "Solar system ID"];
    const lines = ordered.map(({ row, values }) => [
      date.format(row.atMs), ...values.slice(1).map(copiedValue),
      row.typeID, row.systemID,
    ]);
    const text = [header, ...lines].map(line => line.join("\t")).join("\r\n");
    try {
      await navigator.clipboard.writeText(text);
      copyStatus = "Copied";
    } catch {
      copyStatus = "Clipboard unavailable";
    }
  }
</script>

<section class="mining-ledger" aria-label="Personal Mining Ledger">
  <div class="ledger-toolbar">
    <label>From <input aria-label="From date" type="date" value={selectedFrom} min={range.first} max={range.to}
      onchange={event => setDate("from", event.currentTarget.value)} /></label>
    <label>To <input aria-label="To date" type="date" value={selectedTo} min={range.first} max={range.to}
      onchange={event => setDate("to", event.currentTarget.value)} /></label>
    <details class="ledger-resources">
      <summary>{resources.size ? `${resources.size} selected` : "All resources"}</summary>
      <div class="ledger-resource-options">
        {#if !resourceOptions.length}<span>No resources recorded</span>{/if}
        {#each resourceOptions as [key, label] (key)}
          <label><input type="checkbox" checked={resources.has(key)} onchange={() => selectResource(key)} /> {label}</label>
        {/each}
        {#if resources.size}
          <button type="button" onclick={() => { resources = new Set(); page = 0; }}>Clear filter</button>
        {/if}
      </div>
    </details>
    <button type="button" class="ledger-refresh" disabled={loading}
      title="Recent extraction can take several minutes to appear."
      onclick={() => void read(flow)}>Refresh</button>
  </div>

  {#if error}<p role="alert" class="ledger-message">{error}</p>{/if}
  {#if response}
    <div class="ledger-overview" aria-label="90-day mining activity">
      {#each timeline as day (day.date)}
        <button type="button" class:chosen={day.date >= selectedFrom && day.date <= selectedTo}
          style:--fill={`${day.quantity / timelineMax * 100}%`}
          title={`${day.date} · ${numbers.format(day.quantity)} units`} aria-label={`Show ${day.date}`}
          onclick={() => { from = to = day.date; page = 0; }}><span></span></button>
      {/each}
    </div>
    <div class="ledger-graphs">
      <section>
        <header><h3>By resource</h3><select aria-label="Resource chart unit" bind:value={typeMetric}>
          {#each metrics as metric}<option value={metric.key}>{metric.label}</option>{/each}
        </select></header>
        <div class="resource-bars">
          {#each totals as total (total.typeID)}
            <div class="resource-meter"><span>{total.typeID === null ? "Other" : typeName(total.typeID)}</span>
              <span class="resource-bar" style:--fill={`${total.quantity / totalsMax * 100}%`}
                style:--bar-color={total.typeID === null ? "#a8b6b8" : swatch(total.typeID)}></span>
              <span>{numbers.format(total.quantity)}{suffix(typeMetric)}</span></div>
          {:else}
            <p class="ledger-message">No mining activity in this selection.</p>
          {/each}
        </div>
      </section>
      <section>
        <header><h3>By day</h3><select aria-label="Daily chart unit" bind:value={dayMetric}>
          {#each metrics as metric}<option value={metric.key}>{metric.label}</option>{/each}
        </select></header>
        <div class="day-bars" role="img" aria-label={`Daily ${metrics.find(metric => metric.key === dayMetric)?.label.toLowerCase() ?? ""}`}>
          {#each daily as day (day.date)}
            <span class="day-bar" title={`${day.date} · ${numbers.format(day.quantity)}${suffix(dayMetric)}`}>
              {#each day.parts as [id, quantity] (id)}
                <span class="day-resource" data-type-id={id} style:height={`${quantity / dailyMax * 100}%`}
                  style:background={swatch(id)} title={`${typeName(id)} · ${numbers.format(quantity)}${suffix(dayMetric)}`}></span>
              {/each}
            </span>
          {/each}
        </div>
        <div class="ledger-axis"><span>{selectedFrom}</span><span>{selectedTo}</span></div>
      </section>
    </div>
  {/if}

  <div class="ledger-log-header">
    <h3>Extraction log</h3>
    <span class="ledger-entry-count">{ordered.length.toLocaleString()} entries</span>
    <button type="button" disabled={!ordered.length} onclick={() => void copy()}>Copy visible range</button>
    {#if copyStatus}<span role="status">{copyStatus}</span>{/if}
  </div>
  {#if loading && !response}
    <p role="status" class="ledger-message">Reading extraction logs…</p>
  {:else if response && !shownRows.length}
    <p class="ledger-message">No extraction logs in this selection.</p>
  {:else if shownRows.length}
    <div class="ledger-table">
      <table>
        <thead><tr>
          {#each labels as label, i}
            <th scope="col" aria-sort={i === sortColumn ? (descending ? "descending" : "ascending") : "none"}>
              <button type="button" onclick={() => sortBy(i)}>{label}{#if i === sortColumn}<span aria-hidden="true"> {descending ? "▾" : "▴"}</span>{/if}</button>
            </th>
          {/each}
        </tr></thead>
        <tbody>
          {#each shownRows as result (result.row)}
            <tr data-type-id={result.row.typeID} data-system-id={result.row.systemID}
              data-quantity={result.row.quantity} data-at-ms={result.row.atMs}>
              {#each result.values as value, column}<td class:numeric={column > 1 && column < 8}>{cell(value, column)}</td>{/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if pageCount > 1}
      <div class="ledger-pages">
        <button type="button" disabled={currentPage === 0} onclick={() => { page = currentPage - 1; }}>Previous</button>
        <span>{currentPage + 1} of {pageCount}</span>
        <button type="button" disabled={currentPage + 1 === pageCount} onclick={() => { page = currentPage + 1; }}>Next</button>
      </div>
    {/if}
  {/if}
</section>

<style>
  .mining-ledger { padding: 12px; display: grid; gap: 10px; min-width: 0; color: #dce8eb; font-size: 12px; }
  h3 { margin: 0; font-size: 13px; color: #eef6f8; font-weight: 650; }
  button, select, input { font: inherit; }
  button, select, input[type=date], summary {
    background: #17232b; color: inherit; border: 1px solid #53656a; border-radius: 3px; padding: 4px 7px;
  }
  button:disabled { opacity: .5; }
  button:not(:disabled), summary { cursor: pointer; }
  button:hover:not(:disabled), summary:hover { background: #24363f; }
  input[type=date] { color-scheme: dark; }
  .ledger-toolbar, .ledger-log-header, .ledger-pages, header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .ledger-toolbar label { display: flex; align-items: center; gap: 5px; }
  .ledger-refresh { margin-left: auto; }
  .ledger-resources { position: relative; }
  .ledger-resource-options { position: absolute; top: calc(100% + 4px); z-index: 3; min-width: 170px; max-height: 200px;
    overflow: auto; background: #111e26; border: 1px solid #53656a; padding: 6px; display: grid; gap: 5px; }
  .ledger-overview, .day-bars { display: flex; gap: 2px; min-width: 0; align-items: stretch; }
  .ledger-overview { background: #111b22; height: 24px; padding: 3px; }
  .ledger-overview button { flex: 1; min-width: 2px; padding: 0; border: 0; background: #263840; position: relative; }
  .ledger-overview button.chosen { background: #3a514e; }
  .ledger-overview button span { position: absolute; bottom: 0; left: 0; right: 0; height: var(--fill); background: #7dccb6; }
  .ledger-graphs { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(230px, 100%), 1fr)); gap: 8px; }
  .ledger-graphs section { min-width: 0; padding: 8px; background: #15222b; }
  header { justify-content: space-between; margin-bottom: 8px; }
  .resource-bars { max-height: 125px; overflow-y: auto; }
  .resource-meter { display: grid; grid-template-columns: minmax(75px, 35%) 1fr auto; align-items: center; gap: 7px; padding: 3px 0; }
  .resource-bar { height: 7px; display: block; background: linear-gradient(to right, var(--bar-color) var(--fill), #283a40 var(--fill)); }
  .day-bars { height: 94px; border-bottom: 1px solid #50646b; }
  .day-bar { flex: 1; display: flex; flex-direction: column-reverse; background: #3549523b; }
  .day-resource { display: block; flex: none; }
  .ledger-axis { display: flex; justify-content: space-between; color: #aec2c8; font-size: 10px; margin-top: 4px; }
  .ledger-entry-count { color: #a9bdc4; margin-right: auto; }
  .ledger-message { color: #b8c8ce; margin: 0; padding: 6px 0; }
  .ledger-table { max-height: 290px; overflow: auto; border: 1px solid #354951; }
  table { border-collapse: collapse; width: 100%; white-space: nowrap; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #37485088; }
  th { position: sticky; top: 0; background: #253740; }
  th button { border: 0; background: transparent; text-align: left; padding: 0; }
  td.numeric { text-align: right; font-variant-numeric: tabular-nums; }
  tbody tr:nth-child(even) { background: #26384055; }
  .ledger-pages { justify-content: flex-end; }
</style>
