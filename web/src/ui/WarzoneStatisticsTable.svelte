<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { WARZONE_STAT_ROWS, type WarzoneStatistics, type WarzoneStatisticsScope } from "../bridge/warzoneStatistics.ts";
  import { MILITIA_FACTIONS, militiaFactionID } from "../bridge/militiaEnlistment.ts";

  let { flow, scope, word, pilot, copy = false }: {
    flow: AppFlow; scope: WarzoneStatisticsScope; word: (label: string, fallback: string) => string; pilot: string; copy?: boolean;
  } = $props();
  const FW = "UI/FactionWarfare/";
  const fallback = { pilots: "Pilots", killsY: "Kills Yesterday", killsLW: "Kills Last Week", killsTotal: "Kills Total",
    vpY: "Victory Points Yesterday", vpLW: "Victory Points Last Week", vpTotal: "Victory Points Total", systems: "Systems Controlled" };
  let report = $state<WarzoneStatistics | null>(null);
  let error = $state("");
  const amount = new Intl.NumberFormat();
  $effect(() => flow.requestWords([...Object.values(WARZONE_STAT_ROWS).map(id => FW + id), ...["You", "Your", "Top", "All", "CopyTable"].map(id => FW + id)]));
  $effect(() => {
    void pilot;
    let current = true;
    report = null;
    error = "";
    void flow.theatersStatistics(scope).then(result => { if (current) report = result; }, (reason: unknown) => { if (current) error = reason instanceof Error ? reason.message : String(reason); });
    return () => { current = false; };
  });

  function heading(id: string | number) {
    if (typeof id === "string") return word(FW + id, id);
    const faction = militiaFactionID(id);
    return faction === null ? String(id) : MILITIA_FACTIONS[faction].banner;
  }

  async function copyTable() {
    if (!report) return;
    const lines = [["", ...report.headers.map(heading)], ...report.rows.map(row => [word(FW + WARZONE_STAT_ROWS[row.metric], fallback[row.metric]), ...row.values.map(value => amount.format(value))])];
    try { await navigator.clipboard.writeText(lines.map(cells => cells.join("\t")).join("\n")); }
    catch { error = "Could not copy the table."; }
  }
</script>

{#if error}<p role="alert">{error}</p>{/if}
{#if report}
  <div class="table">
    <table>
      <thead><tr><td></td>{#each report.headers as header (header)}<th scope="col">{heading(header)}</th>{/each}</tr></thead>
      <tbody>
        {#each report.rows as { metric, values } (metric)}
          <tr><th scope="row">{word(FW + WARZONE_STAT_ROWS[metric], fallback[metric])}</th>
            {#each values as value, i (i)}<td>{amount.format(value)}</td>{/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if copy}<button type="button" onclick={copyTable}>{word(FW + "CopyTable", "Copy Table")}</button>{/if}
{:else if !error}<p role="status">Loading statistics…</p>{/if}

<style>
  .table { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border-bottom: 1px solid #ffffff1b; padding: 5px 8px; font-weight: 400; text-align: end; }
  th { white-space: nowrap; }
  th[scope="row"] { text-align: start; }
  thead { color: #b7bdc1; }
  button { margin: 8px 0; padding: 5px 8px; font: inherit; color: inherit; background: #141a20; border: 1px solid #ffffff36; cursor: pointer; }
</style>
