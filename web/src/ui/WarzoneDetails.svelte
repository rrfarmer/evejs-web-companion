<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { TemplateArguments } from "../bridge/clientWords.ts";
  import { WARZONE_FACTION_COLORS, type MilitiaSystem, type MilitiaVictoryPoints } from "../bridge/militiaEnlistment.ts";
  import { showInfo } from "./showInfo.ts";

  let { flow, faction, opponent, occupations, victory, systemName, word, solarSystemID }: {
    flow: AppFlow; faction: number; opponent: number; occupations: readonly MilitiaSystem[];
    victory: ReadonlyMap<number, MilitiaVictoryPoints>; systemName: (id: number) => string;
    word: (label: string, fallback: string, values?: TemplateArguments) => string; solarSystemID: number | null;
  } = $props();
  const FW = "UI/FactionWarfare/", DASHBOARD = `${FW}frontlinesDashboard/`;
  const columns = [
    { id: "system", label: FW + "System", fallback: "System" },
    { id: "contested", label: FW + "frontlines/contested", fallback: "Contested" },
    { id: "jumps", label: FW + "Jumps", fallback: "Jumps" },
    { id: "capture", label: FW + "Capture status", fallback: "Capture Status" },
    { id: "adjacency", label: FW + "adjacency", fallback: "Designation" },
    { id: "advantage", label: DASHBOARD + "advantageTitleLabel", fallback: "Advantage" },
  ] as const;
  const captureLabels = ["Uncontested", "Contested", "Vulnerable"] as const;
  const adjacency: Readonly<Record<string, readonly [string, string]>> = {
    FL: ["frontline", "Frontline"], SL: ["secondline", "Command Operations"], BL: ["backline", "Rearguard"],
  };
  type Column = (typeof columns)[number]["id"];
  let sort = $state<{ column: Column; descending: boolean }>({ column: "system", descending: false });
  let metrics = $state<Awaited<ReturnType<AppFlow["theatersSystemMetrics"]>> | null>(null);
  let requestError = $state(false);
  const metricsFailed = $derived(requestError || (metrics !== null && [...metrics.values()].some(entry => entry.advantage === null)));
  const showAdvantage = $derived(metrics !== null && !metricsFailed);

  $effect(() => {
    flow.requestWords([...columns.map(column => column.label), ...captureLabels.map(label => `UI/Neocom/${label}`),
      ...Object.values(adjacency).map(([id]) => FW + "frontlines/" + id), DASHBOARD + "loadingAdvantageData", DASHBOARD + "errorLoadingAdvantageData"]);
  });
  $effect(() => {
    const ids = occupations.map(({ systemID }) => systemID);
    void solarSystemID;
    let current = true;
    metrics = null;
    requestError = false;
    void flow.theatersSystemMetrics(ids).then(response => { if (current) metrics = response; }, () => { if (current) requestError = true; });
    return () => { current = false; };
  });

  const rows = $derived(occupations.map(({ systemID, occupierID, adjacency: state }) => {
    const points = victory.get(systemID);
    const contested = points ? Math.min(1, points.score / points.threshold) : null;
    const captureLabel = contested === null ? null : captureLabels[contested >= 1 ? 2 : contested > 0 ? 1 : 0];
    const kind = adjacency[state];
    const read = metrics?.get(systemID);
    const score = (id: number) => (read?.advantage?.[id]?.contribution ?? 0) + (read?.advantage?.[id]?.floor ?? 0);
    return {
      systemID, occupierID, system: systemName(systemID), contested, jumps: read?.jumps ?? null,
      capture: captureLabel ? word(`UI/Neocom/${captureLabel}`, captureLabel) : "",
      adjacency: kind ? word(FW + "frontlines/" + kind[0], kind[1]) : "",
      advantage: read?.advantage ? score(faction) - score(opponent) : null,
    };
  }).sort((a, b) => {
    const av = a[sort.column], bv = b[sort.column];
    if (av === null || bv === null) return Number(av === null) - Number(bv === null);
    const order = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Math.abs(Number(av)) - Math.abs(Number(bv));
    return sort.descending ? -order : order;
  }));
</script>

<div class="details">
  {#if metricsFailed}<p role="status">{word(DASHBOARD + "errorLoadingAdvantageData", "Error loading advantage data")}</p>
  {:else if metrics === null && occupations.length}<p role="status">{word(DASHBOARD + "loadingAdvantageData", "Loading advantage data")}</p>{/if}
  {#if rows.length}
    <table>
      <thead><tr>
        {#each columns.filter(column => column.id !== "advantage" || showAdvantage) as { id, label, fallback } (id)}
          <th scope="col" aria-sort={sort.column === id ? (sort.descending ? "descending" : "ascending") : undefined}>
            <button type="button" onclick={() => sort = { column: id, descending: sort.column === id && !sort.descending }}>
              {word(label, fallback)}{#if sort.column === id}<span aria-hidden="true">{sort.descending ? " ▾" : " ▴"}</span>{/if}
            </button>
          </th>
        {/each}
      </tr></thead>
      <tbody>
        {#each rows as row (row.systemID)}
          <tr>
            <td><button type="button" style:color={WARZONE_FACTION_COLORS[row.occupierID ?? 0]} onclick={() => showInfo({ kind: "mapLocation", typeID: 5, itemID: row.systemID })}>{row.system}</button></td>
            <td>{row.contested === null ? "–" : `${(row.contested * 100).toFixed(1)}%`}</td><td>{row.jumps ?? "–"}</td>
            <td>{row.capture || "–"}</td><td>{row.adjacency || "–"}</td>
            {#if showAdvantage}
              {@const value = row.advantage ?? 0}
              <td style:color={value ? WARZONE_FACTION_COLORS[value > 0 ? faction : opponent] : undefined}>{value ? `${(Math.abs(value) * 100).toFixed(1)}%` : "0"}</td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}<p>No systems are reported in this warzone.</p>{/if}
</div>

<style>
  .details { overflow: auto; padding: 12px 14px; }
  table { width: 100%; border-collapse: collapse; white-space: nowrap; }
  th, td { text-align: start; border-bottom: 1px solid #ffffff1b; padding: 7px 8px; }
  th { background: #ffffff09; }
  button { padding: 0; background: none; border: 0; text-align: start; color: inherit; font: inherit; cursor: pointer; }
  button:hover { text-decoration: underline; }
</style>
