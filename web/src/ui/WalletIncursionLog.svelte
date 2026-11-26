<script lang="ts">
  import { untrack } from "svelte";
  import { bridgeAsk } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { unixMsToFiletime } from "../bridge/activity.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { decodeIncursionLp, INCURSION_LP as event, type IncursionLpRow } from "../bridge/incursionLp.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";

  let { flow, store, active }: { flow: AppFlow; store: ClientStore; active: boolean } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const journal = "UI/Incursion/Journal/";
  const labels = {
    date: ["UI/Common/Date", "Date"],
    type: [journal + "Type", "Type"],
    encounter: [journal + "EncounterName", "Encounter"],
    stored: [journal + "StoredLP", "LPs in Pool"],
    paid: [journal + "PaidLP", "LPs Paid Out"],
    description: [journal + "Description", "Description"],
    incursion: [journal + "Incursion", "Incursion"],
    types: [journal + "Types", "Types"],
    allIncursions: [journal + "AllIncursionsFilter", "All Incursions"],
    allTypes: [journal + "AllTypesFilter", "All Types"],
    expired: [journal + "CompletedAndNotPaidOut", "Incursion expired"],
    completed: [journal + "CompletedAndPaidOut", "Incursion completed"],
    load: ["UI/Generic/Load", "Load"],
    prompt: [journal + "LoadData", "Click Load to view your loyalty point log."],
    empty: [journal + "NoRecordFound", "No records found"],
  } as const;
  const headings = ["date", "type", "encounter", "stored", "paid", "description"] as const;
  const descriptions: Readonly<Record<number, string>> = {
    [event.stored]: "LoyaltyPointPilotRewardCount",
    [event.paid]: "LoyaltyPointPoolPaidOut",
    [event.lost]: "LoyaltyPointPoolLost",
    [event.direct]: "LPPaidDirectly",
  };
  const reasons: Readonly<Record<number, string>> = {
    1: "DisqualifiedTrialAccount", 2: "DisqualifiedInvalidShipGroup2", 3: "DisqualifiedCloaked",
    4: "DisqualifiedNoFleet", 5: "DisqualifiedNotBestFleet", 6: "DisqualifiedNotInTopFive",
    7: "DisqualifiedNotEnoughParticipants", 8: "DisqualifiedExpired", 11: "DisqualifiedNotInTopN",
    12: "DisqualifiedLowContribution",
  };
  const fallback: Readonly<Record<string, string>> = {
    LoyaltyPointPoolPaidOut: "LP pool paid out", LoyaltyPointPoolLost: "LP pool lost",
    LPPaidDirectly: "LP paid directly", DisqualifiedCloaked: "Disqualified: Cloaking technology not allowed",
  };
  $effect(() => {
    if (active) flow.requestWords(Object.values(labels).map(([path]) => path));
  });
  function word(key: keyof typeof labels) {
    const [path, own] = labels[key];
    return plainText($words.templates[path] ?? "") || own;
  }
  const namespace = (row: IncursionLpRow) => row.reward === 26 ? "UI/Invasion/Journal/" : journal;
  const descriptionKey = (row: IncursionLpRow) =>
    row.event === event.disqualified ? reasons[row.reason] : descriptions[row.event];
  function describe(row: IncursionLpRow) {
    const key = descriptionKey(row);
    if (!key) return "";
    const template = $words.templates[namespace(row) + key];
    const groupName = row.reason === 2 ? resolvedName($names.resolved, "typeGroup", row.detail, "") : "";
    return template
      ? plainText(formatTemplate(template, { rewardedPlayers: row.players, groupName, n: row.detail }, { nameOf: () => "" }))
      : key === "LoyaltyPointPilotRewardCount" ? `LPs stored in pool. Number of pilots rewarded: ${row.players}`
      : fallback[key] ?? (row.event === event.disqualified ? "Disqualified" : "");
  }
  function typeName(row: IncursionLpRow) {
    if (row.event === event.paid || row.event === event.lost) {
      const paid = row.event === event.paid;
      return plainText($words.templates[namespace(row) + (paid ? "CompletedAndPaidOut" : "CompletedAndNotPaidOut")] ?? "")
        || word(paid ? "completed" : "expired");
    }
    return plainText($words.templates[row.message] ?? "");
  }
  const dateText = (date: Date) => date.toISOString().slice(0, 10).replaceAll("-", ".");
  const rowDate = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ").replaceAll("-", ".");
  let date = $state(dateText(new Date()));
  let tale = $state(0);
  let type = $state("");
  let loading = $state(false);
  let loadFailed = $state(false);
  let rows = $state.raw<IncursionLpRow[] | null>(null);
  let tales = $state.raw<ReadonlyMap<number, string>>(new Map());
  let filtered = $state.raw<IncursionLpRow[]>([]);
  const types = $derived([...new Set(rows?.map(row => row.message).filter(Boolean))]);
  let sort = $state<typeof headings[number]>("date");
  let descending = $state(true);
  const ordered = $derived([...filtered].sort((a, b) => {
    let comparison: number;
    switch (sort) {
      case "date": comparison = a.date === b.date ? 0 : a.date > b.date ? 1 : -1; break;
      case "stored": comparison = a.stored - b.stored; break;
      case "paid": comparison = a.paid - b.paid; break;
      case "encounter": comparison = a.encounter.localeCompare(b.encounter); break;
      case "type": comparison = typeName(a).localeCompare(typeName(b)); break;
      case "description": comparison = describe(a).localeCompare(describe(b)); break;
    }
    return descending ? -comparison : comparison;
  }));

  function applyFilters(data: IncursionLpRow[]) {
    const canonical = date.trim().replace(/[/-]/g, ".");
    let selected = /^\d{4}\.\d{2}\.\d{2}$/.test(canonical) ? new Date(canonical.replaceAll(".", "-") + "T00:00:00Z") : null;
    if (!selected || Number.isNaN(selected.getTime()) || dateText(selected) !== canonical) {
      date = dateText(new Date());
      selected = new Date(date.replaceAll(".", "-") + "T00:00:00Z");
    }
    const cutoff = unixMsToFiletime(selected.getTime() + 86_400_000);
    filtered = data.filter(row => row.date <= cutoff && (!tale || row.tale === tale) &&
      (!type || (type === "-1" ? row.event === event.lost : type === "-2" ? row.event === event.paid : row.message === type)));
  }

  function selectColumn(key: typeof headings[number]) {
    descending = key === sort ? !descending : key === "date";
    sort = key;
  }

  $effect(() => {
    if (active) {
      // Reapply cached filters when the tab is selected, as the native wallet does.
      // Filter edits themselves take effect when Load is pressed.
      untrack(() => { if (rows && !loading) applyFilters(rows); });
    }
  });

  async function load() {
    if (loading) return;
    loading = true;
    loadFailed = false;
    try {
      const data = decodeIncursionLp(await bridgeAsk(flow.requestOptions())("rewardMgr", "GetRewardLPLogs", []));
      flow.requestWords([...new Set(data.flatMap(row => [
        row.message, namespace(row) + "CompletedAndPaidOut", namespace(row) + "CompletedAndNotPaidOut",
        descriptionKey(row) ? namespace(row) + descriptionKey(row) : "",
      ]).filter(Boolean))]);
      flow.requestNames(data.filter(row => row.event === event.disqualified && row.reason === 2 && row.detail > 0)
        .map(row => ({ kind: "typeGroup", id: row.detail })));
      const choices = new Map<number, string>();
      if (data.some(row => row.tale && row.system)) {
        const map = await flow.loadStarMap().catch(() => null);
        const systems = new Map(map?.systems.map(system => [system[0], system[6]]));
        const constellations = new Map(map?.constellations?.map(place => [place[0], place[4]]));
        for (const row of data) {
          const name = constellations.get(systems.get(row.system) ?? 0);
          if (row.tale && name) choices.set(row.tale, name);
        }
      }
      rows = data;
      tales = choices;
      if (tale && !choices.has(tale)) tale = 0;
      if (type && type !== "-1" && type !== "-2" && !data.some(row => row.message === type)) type = "";
      applyFilters(data);
    } catch {
      loadFailed = true;
    } finally {
      loading = false;
    }
  }
</script>

<section class="incursion-lp-log" hidden={!active} aria-busy={loading}>
  <form class="controls" onsubmit={(event) => { event.preventDefault(); void load(); }}>
    <label>{word("date")} <input type="text" maxlength="16" bind:value={date} disabled={loading} /></label>
    <label>{word("incursion")} <select bind:value={tale} disabled={loading}>
      <option value={0}>{word("allIncursions")}</option>
      {#each tales as [id, name] (id)}<option value={id}>{name}</option>{/each}
    </select></label>
    <label>{word("types")} <select bind:value={type} disabled={loading}>
      <option value="">{word("allTypes")}</option>
      {#if rows}
        <option value="-1">{word("expired")}</option>
        <option value="-2">{word("completed")}</option>
        {#each types as key (key)}
          {@const label = plainText($words.templates[key] ?? "")}
          {#if label}<option value={key}>{label}</option>{/if}
        {/each}
      {/if}
    </select></label>
    <button type="submit" disabled={loading}>{word("load")}</button>
  </form>
  {#if loading}
    <p role="status">Loading loyalty point log…</p>
  {:else if loadFailed}
    <p role="alert">The loyalty point log could not be loaded. Try again.</p>
  {:else if rows === null}
    <p role="status">{word("prompt")}</p>
  {:else if !ordered.length}
    <p role="status">{word("empty")}</p>
  {:else}
    <div class="table">
      <table class="guests">
        <thead><tr>
          {#each headings as key (key)}
            <th scope="col" aria-sort={sort === key ? (descending ? "descending" : "ascending") : undefined}>
              <button type="button" onclick={() => selectColumn(key)}>{word(key)}</button>
            </th>
          {/each}
        </tr></thead>
        <tbody>
          {#each ordered as row}
            <tr>
              <td>{rowDate(row.dateMs)}</td>
              <td>{typeName(row)}</td>
              <td>{row.encounter}</td>
              <td class="number" class:stored={row.stored !== 0}>{row.stored}</td>
              <td class="number" class:paid={row.event !== event.lost && row.paid !== 0}
                class:lost={row.event === event.lost && row.paid !== 0}>{row.event === event.lost ? 0 : row.paid}</td>
              <td>{describe(row)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .incursion-lp-log { padding-block: 10px; }
  .controls { flex-wrap: wrap; align-items: end; gap: 8px; }
  label { display: grid; gap: 4px; }
  input { width: 12ch; }
  .table { overflow: auto; }
  th button { padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; }
  td:first-child, .number { white-space: nowrap; }
  .number { text-align: right; font-variant-numeric: tabular-nums; }
  .stored { color: #efcf56; }
  .paid { color: #78d997; }
  .lost { color: #f07878; }
</style>
