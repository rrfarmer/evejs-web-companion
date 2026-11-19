<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import {
    filterMiningLedger, ledgerDateRange, ledgerFilterOf, miningLedgerDaily, type MiningLedgerFacts, type MiningLedgerObserver,
  } from "../bridge/miningLedger.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { ledgerRowMenuPosition, type LedgerRowMenu } from "./ledgerRowMenu.ts";
  import MiningLedgerRowMenu from "./MiningLedgerRowMenu.svelte";

  let { store, flow, openMail, openWatchlist }: {
    store: ClientStore; flow: AppFlow; openMail?: () => void; openWatchlist?: () => void;
  } = $props();
  const names = $derived(store.names);
  let response = $state.raw<Awaited<ReturnType<AppFlow["loadCorporationMiningLedger"]>> | null>(null);
  let observers = $state.raw<readonly MiningLedgerObserver[]>([]);
  let selectedID = $state<number | null>(null);
  let pending = $state<"observers" | "entries" | null>("observers");
  let error = $state<string | null>(null);
  let copyStatus = $state("");
  let from = $state<string | null>(null);
  let to = $state<string | null>(null);
  let resources = $state.raw<ReadonlySet<string>>(new Set());
  let companies = $state.raw<ReadonlySet<number>>(new Set());
  let query = $state("");
  let sortColumn = $state(0);
  let descending = $state(true);
  let page = $state(0);
  let request = 0;
  let rowMenu = $state.raw<LedgerRowMenu | null>(null);

  const emptyFacts: ReadonlyMap<number, MiningLedgerFacts> = new Map();
  const range = $derived(ledgerDateRange(response?.nowMs ?? Date.now()));
  const selectedFrom = $derived(from ?? range.from);
  const selectedTo = $derived(to ?? range.to);
  const selectedObserver = $derived(observers.find(observer => observer.itemID === selectedID));
  const rows = $derived(response?.rows ?? []);
  const facts = $derived(response?.facts ?? emptyFacts);
  const timeline = $derived(miningLedgerDaily(rows, facts, range.first, range.to, "quantity"));
  const timelineMax = $derived(Math.max(1, ...timeline.map(day => day.quantity)));
  const typeName = (id: number) => resolvedName($names.resolved, "type", id, `Type ${id}`);
  const companyName = (id: number) => resolvedName($names.resolved, "corporation", id, `Corporation ${id}`);
  const pilotName = (id: number) => resolvedName($names.resolved, "character", id, `Pilot ${id}`);
  const systemName = (id: number) => resolvedName($names.resolved, "system", id, `System ${id}`);

  const resourceOptions = $derived.by(() => {
    const options = new Map<string, string>();
    for (const row of rows) {
      const key = ledgerFilterOf(row.typeID, facts.get(row.typeID));
      const id = Number(key.split(":")[1]);
      options.set(key, key.startsWith("group:") ? resolvedName($names.resolved, "group", id, `Group ${id}`) : typeName(id));
    }
    return [...options].sort((a, b) => a[1].localeCompare(b[1]));
  });
  const companyOptions = $derived([...new Set(rows.map(row => row.corporationID))]
    .map(id => [id, companyName(id)] as const).sort((a, b) => a[1].localeCompare(b[1])));

  const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });
  const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const columns = ["Date (UTC)", "Corporation", "Pilot", "Resource", "Mined", "Volume", "Est. value"];
  const pageSize = 100;
  const ordered = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase();
    return filterMiningLedger(rows, facts, selectedFrom, selectedTo, resources)
      .filter(row => !companies.size || companies.has(row.corporationID))
      .map(row => {
        const info = facts.get(row.typeID);
        const price = info?.price || info?.basePrice || null;
        const values = [row.atMs, companyName(row.corporationID), pilotName(row.characterID), typeName(row.typeID),
          row.quantity, info?.volume == null ? null : info.volume * row.quantity, price === null ? null : price * row.quantity] as const;
        return { row, values };
      })
      .filter(({ values }) => !needle || [values[1], values[3], values[2]].join(" ").toLocaleLowerCase().includes(needle))
      .sort((a, b) => {
        const left = a.values[sortColumn];
        const right = b.values[sortColumn];
        if (left == null || right == null) return Number(left == null) - Number(right == null);
        const order = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
        return descending ? -order : order;
      });
  });
  const pageCount = $derived(Math.ceil(ordered.length / pageSize));
  const currentPage = $derived(Math.min(page, Math.max(0, pageCount - 1)));
  const visible = $derived(ordered.slice(currentPage * pageSize, (currentPage + 1) * pageSize));
  const displayedMenu = $derived(visible.some(item => item.row === rowMenu?.row) ? rowMenu : null);

  function showRowMenu(event: MouseEvent | KeyboardEvent, row: (typeof rows)[number], anchor: HTMLElement) {
    rowMenu = { kind: "corporation", row, ...ledgerRowMenuPosition(event, anchor) };
  }

  function resetFilters() {
    resources = new Set();
    companies = new Set();
    query = "";
    page = 0;
  }

  async function refresh(owner: AppFlow, preferred: number | null) {
    const version = ++request;
    pending = "observers";
    error = null;
    copyStatus = "";
    try {
      const received = await owner.loadCorporationMiningObservers();
      if (version !== request) return;
      observers = received;
      const id = received.find(observer => observer.itemID === preferred)?.itemID ?? received[0]?.itemID ?? null;
      if (id !== selectedID) { response = null; resetFilters(); }
      selectedID = id;
      if (id !== null) await read(owner, id);
    } catch (cause) {
      if (version === request) error = cause instanceof Error ? cause.message : "Mining observers could not be read.";
    } finally {
      if (version === request) pending = null;
    }
  }

  async function read(owner: AppFlow, id: number) {
    const version = ++request;
    pending = "entries";
    error = null;
    try {
      const received = await owner.loadCorporationMiningLedger(id);
      if (version === request) response = received;
    } catch (cause) {
      if (version === request) error = cause instanceof Error ? cause.message : "This observer's extraction log could not be read.";
    } finally {
      if (version === request) pending = null;
    }
  }

  function select(id: number) {
    rowMenu = null;
    selectedID = id;
    response = null;
    copyStatus = "";
    resetFilters();
    void read(flow, id);
  }

  $effect(() => {
    const owner = flow;
    observers = [];
    response = null;
    selectedID = null;
    rowMenu = null;
    from = to = null;
    resetFilters();
    void refresh(owner, null);
    return () => { request++; };
  });

  function dateChanged(which: "from" | "to", value: string) {
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

  function toggle<T>(selection: ReadonlySet<T>, item: T): Set<T> {
    const changed = new Set(selection);
    if (!changed.delete(item)) changed.add(item);
    page = 0;
    return changed;
  }

  function sortBy(column: number) {
    descending = sortColumn === column ? !descending : column === 0 || column > 3;
    sortColumn = column;
    page = 0;
  }

  function displayCell(value: string | number | null, column: number): string {
    if (value === null) return "—";
    if (typeof value === "string") return value;
    if (column === 0) return date.format(value);
    if (column === 5) return `${numbers.format(value)} m³`;
    if (column === 6) return value ? `${numbers.format(Math.round(value))} ISK` : "—";
    return numbers.format(value);
  }

  async function copy() {
    const version = request;
    const lines = ordered.map(({ row, values: [at, corp, pilot, resource, quantity, volume, price] }) => [
      date.format(at), corp, pilot, resource, quantity, volume === null ? "" : Number(volume.toPrecision(15)),
      price ? Math.trunc(price) : "", row.typeID, row.systemID,
    ]);
    try {
      await navigator.clipboard.writeText([[...columns, "Resource type ID", "Solar system ID"], ...lines]
        .map(line => line.join("\t")).join("\r\n"));
      if (version === request) copyStatus = "Copied";
    } catch {
      if (version === request) copyStatus = "Clipboard unavailable";
    }
  }
</script>

<section class="corporation-mining-ledger" aria-label="Corporation Mining Ledger">
  <div class="observer-controls">
    <label>Observer
      <select aria-label="Mining observer" value={selectedID ?? ""} disabled={!observers.length || pending === "observers"}
        onchange={event => select(Number(event.currentTarget.value))}>
        {#if !observers.length}<option value="">No observers</option>{/if}
        {#each observers as observer (observer.itemID)}
          <option value={observer.itemID}>{observer.name || `Observer ${observer.itemID}`}</option>
        {/each}
      </select>
    </label>
    {#if selectedObserver}<span>{systemName(selectedObserver.systemID)}</span>{/if}
    <button type="button" class="observer-refresh" disabled={pending !== null}
      title="Recent extraction can take time to appear." onclick={() => void refresh(flow, selectedID)}>Refresh</button>
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if pending && !response}<p role="status">{pending === "observers" ? "Reading observers…" : "Reading extraction logs…"}</p>
  {:else if !error && !observers.length}<p>No mining observers have recorded activity for this corporation.</p>
  {/if}
  {#if response}
    <div class="observer-filters">
      <label>From <input aria-label="From date" type="date" value={selectedFrom} min={range.first} max={range.to}
        onchange={event => dateChanged("from", event.currentTarget.value)} /></label>
      <label>To <input aria-label="To date" type="date" value={selectedTo} min={range.first} max={range.to}
        onchange={event => dateChanged("to", event.currentTarget.value)} /></label>
      <details>
        <summary>{resources.size ? `${resources.size} resources selected` : "All resources"}</summary>
        <div class="options">
          {#each resourceOptions as [key, name] (key)}
            <label><input type="checkbox" checked={resources.has(key)} onchange={() => resources = toggle(resources, key)} /> {name}</label>
          {:else}<span>No resources recorded</span>{/each}
          {#if resources.size}<button type="button" onclick={() => { resources = new Set(); page = 0; }}>Clear resource filter</button>{/if}
        </div>
      </details>
      <details>
        <summary>{companies.size ? `${companies.size} corporations selected` : "All corporations"}</summary>
        <div class="options">
          {#each companyOptions as [id, name] (id)}
            <label><input type="checkbox" checked={companies.has(id)} onchange={() => companies = toggle(companies, id)} /> {name}</label>
          {:else}<span>No corporations recorded</span>{/each}
          {#if companies.size}<button type="button" onclick={() => { companies = new Set(); page = 0; }}>Clear corporation filter</button>{/if}
        </div>
      </details>
      <input class="search" type="search" aria-label="Filter by pilot, corporation, or resource" placeholder="Search extraction log"
        maxlength="64" bind:value={query} oninput={() => page = 0} />
    </div>
    <div class="observer-timeline" aria-label="90-day observer activity">
      {#each timeline as day (day.date)}
        <button type="button" class:chosen={day.date >= selectedFrom && day.date <= selectedTo}
          style:--fill={`${day.quantity / timelineMax * 100}%`}
          title={`${day.date} · ${numbers.format(day.quantity)} units`} aria-label={`Show ${day.date}`}
          onclick={() => { from = to = day.date; page = 0; }}><span></span></button>
      {/each}
    </div>
    <div class="observer-log">
      <h3>Extraction log</h3><span>{ordered.length.toLocaleString()} entries</span>
      <button type="button" disabled={!ordered.length} onclick={() => void copy()}>Copy visible range</button>
      {#if copyStatus}<span role="status">{copyStatus}</span>{/if}
    </div>
    {#if !visible.length}
      <p>No extraction logs in this selection.</p>
    {:else}
      <div class="observer-table">
        <table>
          <thead><tr>
            {#each columns as title, column}
              <th scope="col" aria-sort={column === sortColumn ? (descending ? "descending" : "ascending") : "none"}>
                <button type="button" onclick={() => sortBy(column)}>{title}{#if column === sortColumn}<span aria-hidden="true"> {descending ? "▾" : "▴"}</span>{/if}</button>
              </th>
            {/each}
          </tr></thead>
          <tbody>
            {#each visible as { row, values } (row)}
              <tr data-character-id={row.characterID} data-corporation-id={row.corporationID} data-type-id={row.typeID}
                data-system-id={row.systemID} data-quantity={row.quantity} data-at-ms={row.atMs}
                oncontextmenu={event => {
                  const anchor = event.currentTarget.querySelector<HTMLButtonElement>(".ledger-row-actions");
                  if (anchor) showRowMenu(event, row, anchor);
                }}>
                {#each values as value, column}
                  <td class:numeric={column > 3}>
                    {#if column === 0}
                      <button type="button" class="ledger-row-actions"
                        aria-label={`Extraction actions for ${pilotName(row.characterID)} and ${typeName(row.typeID)}`}
                        aria-expanded={displayedMenu?.row === row}
                        onclick={event => showRowMenu(event, row, event.currentTarget)}
                        onkeydown={event => {
                          if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey)
                            showRowMenu(event, row, event.currentTarget);
                        }}></button>
                    {/if}
                    {displayCell(value, column)}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
    {#if pageCount > 1}
      <div class="observer-pages">
        <button type="button" disabled={currentPage === 0} onclick={() => { page = currentPage - 1; }}>Previous</button>
        <span>{currentPage + 1} of {pageCount}</span>
        <button type="button" disabled={currentPage + 1 === pageCount} onclick={() => { page = currentPage + 1; }}>Next</button>
      </div>
    {/if}
  {/if}
</section>
<MiningLedgerRowMenu {store} {flow} {openMail} {openWatchlist} menu={displayedMenu} onClose={() => { rowMenu = null; }} />

<style>
  .corporation-mining-ledger { display: grid; gap: 12px; padding: 12px; color: #dce8eb; font-size: 12px; min-width: 0; }
  .observer-controls, .observer-filters, .observer-log, .observer-pages { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .observer-controls label, .observer-filters label { display: inline-flex; align-items: center; gap: 5px; }
  .observer-refresh, .search, .observer-log button { margin-left: auto; }
  .observer-controls select { max-width: min(360px, 65vw); }
  button, select, input, summary { font: inherit; }
  button, select, input:not([type=checkbox]), summary {
    padding: 4px 7px; background: #17232b; color: inherit; border: 1px solid #53656a; border-radius: 3px;
  }
  button:disabled { opacity: .5; }
  .ledger-row-actions { margin-right: 5px; padding: 0 4px; }
  .ledger-row-actions::after { content: "⋯"; }
  details { position: relative; }
  .options {
    position: absolute; z-index: 2; top: calc(100% + 4px); min-width: 145px; width: max-content; max-width: 260px;
    max-height: 210px; overflow: auto; background: #17232b; border: 1px solid #53656a; padding: 8px;
    display: grid; gap: 6px;
  }
  .observer-timeline { display: flex; gap: 2px; height: 27px; padding: 2px; background: #0d151a; border: 1px solid #37494f; }
  .observer-timeline button { display: flex; flex: 1 1 0; align-items: flex-end; min-width: 0; padding: 0; border: none; background: #1e2b31; }
  .observer-timeline button.chosen { background: #34484d; }
  .observer-timeline button span { width: 100%; height: var(--fill); background: #90cabb; }
  h3 { margin: 0; font-size: 13px; color: #eef6f8; }
  p { margin: 4px 0 0; color: #c1cdd2; }
  [role=alert] { color: #ffc0b6; }
  .observer-table { max-height: 350px; overflow: auto; border: 1px solid #3d4c54; }
  table { width: 100%; border-collapse: collapse; white-space: nowrap; text-align: left; }
  th { position: sticky; top: 0; background: #28353b; }
  th, td { padding: 5px 6px; }
  th button { background: transparent; border: 0; padding: 2px; }
  td { border-top: 1px solid #344048; }
  tbody tr:nth-child(even) { background: #182329; }
  td.numeric { text-align: right; font-variant-numeric: tabular-nums; }
  .observer-pages { justify-content: center; }
</style>
