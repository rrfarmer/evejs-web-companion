<script lang="ts">
  import { sessionPlace } from "../bridge/sessionPlace.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { hasMoonStationManagerRole, type CorporationMoonExtraction, type CorporationMoonSchedule } from "../bridge/moonMining.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const station = $derived(store.station);
  const flight = $derived(store.flight);
  const names = $derived(store.names);
  const systemID = $derived(sessionPlace($flight.status, $station.online).solarSystemID);
  const corporationID = $derived($station.online?.corporationID ?? null);
  const canRead = $derived(corporationID !== null && hasMoonStationManagerRole($station.online?.corpRole ?? null));
  const characterID = $derived($station.online?.characterID ?? null);
  let schedule = $state.raw<CorporationMoonSchedule | null>(null);
  let profile = $state(0);
  let nowMs = $state(Date.now());
  let loading = $state(false);
  let error = $state("");
  let refreshNow = () => {};
  const dateFormat = new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC", weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });

  const columns = [
    { id: "name", label: "Refinery" }, { id: "security", label: "Security" }, { id: "jumps", label: "Jumps" },
    { id: "readyAtMs", label: "Chunk ready (UTC)" }, { id: "remaining", label: "Time until" },
  ] as const;
  type SortColumn = typeof columns[number]["id"];
  let sortBy = $state<SortColumn>("readyAtMs");
  let ascending = $state(true);
  function sortRows(left: CorporationMoonExtraction, right: CorporationMoonExtraction): number {
    if (sortBy === "name") return left.name.localeCompare(right.name);
    if (sortBy === "security" || sortBy === "jumps") {
      const a = left[sortBy], b = right[sortBy];
      // Missing map data sorts last in either direction.
      if (a === null || b === null) return ((a === null ? 1 : 0) - (b === null ? 1 : 0)) * (ascending ? 1 : -1);
      return a - b;
    }
    return left.readyAtMs - right.readyAtMs;
  }
  const rows = $derived((schedule?.extractions ?? []).filter(row => profile === 0 || row.profileID === profile)
    .sort((a, b) => sortRows(a, b) * (ascending ? 1 : -1) || a.readyAtMs - b.readyAtMs || a.id - b.id));

  function setSort(column: SortColumn): void {
    if (sortBy === column) ascending = !ascending;
    else { sortBy = column; ascending = true; }
  }

  function timeUntil(row: CorporationMoonExtraction): string {
    if (nowMs >= row.automaticAtMs) return "Auto fracture due";
    if (nowMs >= row.readyAtMs) return "Ready";
    const remainingMinutes = Math.ceil((row.readyAtMs - nowMs) / 60_000);
    const days = Math.floor(remainingMinutes / 1440);
    const hours = Math.floor(remainingMinutes / 60) % 24;
    const minutes = remainingMinutes % 60;
    return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
  }

  $effect(() => {
    const activeFlow = flow;
    void characterID;
    void corporationID;
    void systemID;
    schedule = null;
    profile = 0;
    error = "";
    loading = false;
    if (!canRead) return;
    let live = true, queued = false, reading = false, offset = 0;
    const current = () => { if (!live) throw new Error("The corporation schedule has changed."); };
    async function refresh(): Promise<void> {
      if (reading) { queued = true; return; }
      reading = true;
      loading = true;
      try {
        const result = await activeFlow.loadCorporationMoonSchedule(current);
        if (!live) return;
        schedule = result;
        offset = result.nowMs - Date.now();
        nowMs = result.nowMs;
        if (profile && !result.profiles.some(item => item.id === profile)) profile = 0;
        error = "";
      } catch (cause) {
        if (live) error = (cause as Error).message;
      } finally {
        reading = false;
        if (live) {
          loading = false;
          if (queued) { queued = false; void refresh(); }
        }
      }
    }
    refreshNow = () => { void refresh(); };
    const unsubscribe = activeFlow.moonExtractionChanged.subscribe(refreshNow);
    const poll = setInterval(refreshNow, 10_000);
    const clock = setInterval(() => { nowMs = Date.now() + offset; }, 1000);
    return () => { live = false; unsubscribe(); clearInterval(poll); clearInterval(clock); };
  });
</script>

<section class="extractions" aria-label="Upcoming extractions">
  <div class="toolbar">
    <h2>Upcoming Extractions</h2>
    {#if canRead}
      <label>Structure profile
        <select bind:value={profile} disabled={!schedule}>
          <option value={0}>All Profiles</option>
          {#each schedule?.profiles ?? [] as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
        </select>
      </label>
      <button type="button" disabled={loading} onclick={() => refreshNow()}>Refresh</button>
    {/if}
  </div>

  {#if !canRead}
    <p>Upcoming extractions require the Station Manager role.</p>
  {:else}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if !schedule && !error}
      <p role="status">Reading the corporation schedule…</p>
    {:else if schedule && rows.length === 0}
      <p role="status">{profile === 0 ? "No upcoming extractions." : "No upcoming extractions for this profile."}</p>
    {:else if rows.length}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              {#each columns as column (column.id)}
                <th scope="col" aria-sort={sortBy === column.id ? (ascending ? "ascending" : "descending") : "none"}>
                  <button type="button" onclick={() => setSort(column.id)}>{column.label}</button>
                </th>
              {/each}
              <th scope="col">Travel</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.id)}
              <tr>
                <td>
                  <button class="refinery" type="button" title="Show refinery type info" onclick={() => showInfo({ kind: "type", typeID: row.typeID })}>{row.name}</button>
                  <small>{resolvedName($names.resolved, "system", row.solarSystemID, `System ${row.solarSystemID}`)}</small>
                </td>
                <td>{row.security === null ? "—" : shownSecurity(row.security).toFixed(1)}</td>
                <td>{row.jumps ?? "—"}</td>
                <td><time datetime={new Date(row.readyAtMs).toISOString()}>{dateFormat.format(row.readyAtMs)}</time></td>
                <td>{timeUntil(row)}</td>
                <td><button class="travel" type="button" onclick={() => flow.setDestination(row.structureID)}>Set Destination</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</section>

<style>
  .extractions { padding: 14px; color: var(--color-text, #e3ecee); font-size: 13px; }
  .toolbar { display: flex; align-items: end; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
  h2 { font-size: 17px; margin: 0 auto 0 0; }
  label { display: flex; align-items: center; gap: 6px; }
  select, button { padding: 5px 8px; color: inherit; background: #15262b; border: 1px solid #486169; }
  select { max-width: 14rem; color-scheme: dark; }
  button:disabled { opacity: .6; }
  button:not(:disabled):hover { border-color: #94d1db; }
  .table-scroll { overflow: auto; }
  table { width: 100%; min-width: 595px; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 8px; text-align: start; border-bottom: 1px solid #415256; }
  th { color: #b8d2d7; border-top: 1px solid #415256; }
  th button, .refinery { padding: 0; background: none; border: 0; text-align: start; }
  th button:hover, .refinery:hover { text-decoration: underline; }
  th[aria-sort="ascending"] button::after { content: " ↑"; }
  th[aria-sort="descending"] button::after { content: " ↓"; }
  tbody tr:hover { background: #20333980; }
  .refinery { color: #a2d7dd; }
  small { display: block; color: #aec1c8; margin-top: 3px; }
  time, .travel { white-space: nowrap; }
  p { color: #c0d4db; }
  p.error { color: #ffc0aa; }
</style>
