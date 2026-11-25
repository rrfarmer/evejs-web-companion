<script lang="ts">
  import { onDestroy } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { JournalResearch } from "../store/types.ts";
  import { resolvedName } from "../store/names.ts";
  import { ContextMenu } from "../play/contextMenu.ts";
  import { showInfo } from "./showInfo.ts";

  let { store, flow, showAgents }: { store: ClientStore; flow: AppFlow; showAgents?: () => void } = $props();
  const agents = $derived(store.agents);
  const flight = $derived(store.flight);
  const names = $derived(store.names);
  const words = $derived(store.words);
  const projects = $derived($agents.journal?.research ?? []);
  const place = $derived($flight.status?.stationID ?? $flight.status?.solarSystemID ?? null);
  const headers = [
    ["UI/Agents/Agent", "Agent"],
    ["UI/Agents/Research/ResearchFieldShort", "Field"],
    ["UI/Agents/Research/CurrentResearchPointsTitle", "Current RP"],
    ["UI/Agents/Research/ResearchPointsRateTitle", "RP/day"],
    ["UI/Agents/AgentLevel", "Level"],
    ["UI/Common/Location", "Location"],
  ] as const;
  const emptyLabel = "UI/Agents/Research/NoResearchBeingPerformed";
  const infoLabel = "UI/Commands/ShowInfo";
  const talkLabel = "UI/Chat/StartConversationAgent";
  const pointFormat = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const word = (label: string, fallback: string) => $words.templates[label] || fallback;
  let selected = $state<number | null>(null);
  let loading = $state(true);
  let failed = $state(false);
  let sortColumn = $state(0);
  let descending = $state(false);
  const menu = new ContextMenu();
  onDestroy(() => menu.close());

  $effect(() => {
    flow.requestWords([...headers.map(([label]) => label), emptyLabel, infoLabel, talkLabel]);
  });
  $effect(() => {
    void place;
    let current = true;
    loading = true;
    failed = false;
    void flow.loadJournal().catch(() => {
      if (current) failed = true;
    }).finally(() => {
      if (current) loading = false;
    });
    return () => { current = false; };
  });
  $effect(() => {
    flow.requestNames(projects.flatMap(project => [
      { kind: "owner", id: project.agentID },
      { kind: "type", id: project.fieldTypeID },
      { kind: "station", id: project.stationID },
    ]));
  });

  function cells(row: JournalResearch) {
    return [
      resolvedName($names.resolved, "owner", row.agentID),
      resolvedName($names.resolved, "type", row.fieldTypeID),
      row.currentPoints,
      row.pointsPerDay,
      row.level,
      resolvedName($names.resolved, "station", row.stationID),
    ] as const;
  }

  const ordered = $derived(projects.map(row => ({ row, values: cells(row) })).sort((a, b) => {
    const left = a.values[sortColumn];
    const right = b.values[sortColumn];
    const order = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
    return descending ? -order : order;
  }));
  function sortBy(index: number) {
    descending = index === sortColumn && !descending;
    sortColumn = index;
  }

  function openAgentMenu(event: MouseEvent | KeyboardEvent, agentID: number) {
    event.preventDefault();
    selected = agentID;
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const mouse = event instanceof MouseEvent;
    menu.open(mouse ? event.clientX : bounds.left, mouse ? event.clientY : bounds.bottom, [
      { label: word(infoLabel, "Show Info"), path: infoLabel, info: true, run: () => showInfo({ kind: "character", characterID: agentID }) },
      { label: word(talkLabel, "Start Conversation"), path: talkLabel, run: () => {
        void flow.openConversation(agentID).then(() => showAgents?.(), () => showAgents?.());
      } },
    ]);
  }
</script>

<section class="ind-research" aria-label="Research">
  <div class="ind-scroll" aria-busy={loading}>
    <table>
      <thead><tr>
        {#each headers as [label, fallback], index (label)}
          <th scope="col" class:r={index >= 2 && index <= 4}
            aria-sort={index === sortColumn ? (descending ? "descending" : "ascending") : "none"}>
            <button type="button" onclick={() => sortBy(index)}>{word(label, fallback)}</button>
          </th>
        {/each}
      </tr></thead>
      <tbody>
        {#each ordered as { row, values } (row.agentID)}
          <!-- The research row exposes selection and its menu to both pointer and keyboard. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
          <tr class:ind-sel={selected === row.agentID} tabindex="0"
            onclick={() => (selected = row.agentID)}
            oncontextmenu={(event) => openAgentMenu(event, row.agentID)}
            onkeydown={(event) => {
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) openAgentMenu(event, row.agentID);
              else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                selected = row.agentID;
              } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && selected === row.agentID) {
                event.preventDefault();
                void navigator.clipboard.writeText([values[0], values[1], pointFormat.format(values[2]), pointFormat.format(values[3]), values[4], values[5]].join("\t")).catch(() => {});
              }
            }}>
            <td>{values[0]}</td><td>{values[1]}</td>
            <td class="r">{pointFormat.format(values[2])}</td><td class="r">{pointFormat.format(values[3])}</td>
            <td class="r">{values[4]}</td><td>{values[5]}</td>
          </tr>
        {:else}
          <tr><td class="ind-none" colspan={headers.length}>
            {loading ? "Loading…" : failed ? "Research data is unavailable." : word(emptyLabel, "You aren't performing any research")}
          </td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<style>
  th button {
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  tr[tabindex] { cursor: pointer; }
</style>
