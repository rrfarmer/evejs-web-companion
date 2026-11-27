<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { SHORT_INTERVAL_WORD_LABELS } from "../bridge/timeInterval.ts";
  import { filetimeOf, journalRowAsks, journalRowText, journalRowWords } from "../bridge/journalWords.ts";
  import { questionText, wordsLabels } from "../bridge/questions.ts";
  import { ContextMenu, type ContextEntry } from "../play/contextMenu.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName, type NameKind } from "../store/names.ts";
  import type { JournalMission } from "../store/types.ts";

  let { store, flow, openAgents }: { store: ClientStore; flow: AppFlow; openAgents: () => void } = $props();
  const agents = $derived(store.agents), names = $derived(store.names), words = $derived(store.words);
  const station = $derived(store.station);
  const base = "UI/Journal/JournalWindow/Agents/";
  const columns = [[base + "HeaderStatus", "Status"], ["UI/Agents/Agent", "Agent"], [base + "HeaderMission", "Mission"],
    [base + "HeaderType", "Type"], [base + "HeaderExpiration", "Expiration"]] as const;
  const labels = {
    tab: "UI/PeopleAndPlaces/AgentMissions",
    empty: base + "NoMissionsOfferedOrAccepted",
    agent: "UI/Agents/AgentEntryNameAndLevel",
    details: "UI/Agents/Commands/ReadDetails",
    talk: "UI/Agents/Commands/StartConversationWith",
    remove: "UI/Agents/Commands/RemoveOffer",
  };
  const menu = new ContextMenu();
  let failure = $state("");
  const missions = $derived([...($agents.journal?.active ?? []), ...($agents.journal?.offered ?? [])]);
  const nameOf = (kind: NameKind, id: number) => resolvedName($names.resolved, kind === "owner" ? "agent" : kind, id, "");
  const word = (path: string, fallback: string) => $words.templates[path] ?? fallback;
  const agentName = (agentID: number) => nameOf("agent", agentID) || "Agent";

  function agentText(id: number | null): string {
    if (id === null) return "";
    const level = $agents.agentRecords[id]?.level;
    return level == null ? agentName(id) : plainText(formatTemplate(word(labels.agent, `${agentName(id)} (Level ${level})`),
      { ownerID: id, level }, { nameOf }));
  }

  function run(action: () => Promise<void>): void {
    failure = "";
    void action().catch(error => { failure = error instanceof Error ? error.message : String(error); });
  }

  function details(id: number): void {
    openAgents();
    run(() => flow.openMissionDetails(id));
  }

  function rowMenu(event: MouseEvent | KeyboardEvent, row: JournalMission): void {
    if (event instanceof KeyboardEvent && event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    if (row.agentID === null) return;
    event.preventDefault();
    const id = row.agentID;
    const entries: ContextEntry[] = [
      { label: plainText(word(labels.details, "Read Details")), run: () => details(id) },
      { label: plainText(formatTemplate(word(labels.talk, `Start Conversation with ${agentName(id)}`), { agentID: id }, { nameOf })),
        run: () => { openAgents(); run(() => flow.openConversation(id)); } },
    ];
    if (row.missionState === 1) entries.push({ label: plainText(word(labels.remove, "Remove Offer")), run: () => run(() => flow.removeOffer(id)) });
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menu.open(event instanceof MouseEvent ? event.clientX : rect.left, event instanceof MouseEvent ? event.clientY : rect.bottom, entries);
  }

  $effect(() => {
    const at = filetimeOf(Date.now());
    const asks = missions.flatMap(mission => journalRowAsks(journalRowWords(mission, at)));
    flow.requestWords(wordsLabels(asks));
    flow.requestNames(missions.flatMap(mission => mission.agentID === null ? [] : [{ kind: "agent" as const, id: mission.agentID }]));
    for (const mission of missions) if (mission.agentID !== null) flow.requestAgentRecord(mission.agentID);
  });
  onMount(() => {
    flow.requestWords([...columns.map(([path]) => path), ...Object.values(labels), ...SHORT_INTERVAL_WORD_LABELS]);
    run(() => flow.loadJournal());
  });
  onDestroy(() => menu.close());
</script>

<section class="agent-journal" aria-label={plainText(word(labels.tab, "Agent Missions"))}>
  <div class="journal-tab">{plainText(word(labels.tab, "Agent Missions"))}</div>
  {#if failure}
    <p role="alert">{failure} <button type="button" onclick={() => run(() => flow.loadJournal())}>Retry</button></p>
  {/if}
  <table>
    <thead><tr>{#each columns as [path, fallback]}<th>{plainText(word(path, fallback))}</th>{/each}</tr></thead>
    <tbody>
      {#if $agents.journal === null && !failure}
        <tr><td colspan="5"><span role="status">Loading missions…</span></td></tr>
      {:else if $agents.journal && !missions.length}
        <tr><td colspan="5" class="empty">{plainText(word(labels.empty, "No missions currently offered or accepted"))}</td></tr>
      {/if}
      {#each missions as mission}
        {@const row = journalRowWords(mission, filetimeOf(Date.now()))}
        {@const text = journalRowText(row, asking => questionText(asking, nameOf, { templates: $words.templates, playerID: $station.online?.characterID ?? null }),
          key => typeof $words.templates[key] === "string")}
        <tr data-agent-journal-row={mission.agentID} oncontextmenu={event => rowMenu(event, mission)}>
          <td class:expired={row.expired}>{plainText(text.state)}</td>
          <td>{agentText(mission.agentID)}</td>
          <td>
            {#if mission.agentID !== null}
              {@const id = mission.agentID}
              <button class="mission-name" type="button" onkeydown={event => {
                if (event.key === "Enter") details(id);
                else rowMenu(event, mission);
              }} ondblclick={() => details(id)}>{plainText(text.name)}</button>
            {:else}{plainText(text.name)}{/if}
          </td>
          <td>{plainText(text.type)}</td><td>{plainText(text.expiration)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</section>

<style>
  .agent-journal { padding: 0.5rem; }
  .journal-tab { padding: 0.45rem 0.65rem; border-bottom: 2px solid var(--accent, #5c97bb); width: fit-content; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.3rem 0.4rem; border-bottom: 1px solid rgb(255 255 255 / 12%); }
  th { font-weight: 500; white-space: nowrap; }
  .empty { padding: 1rem; text-align: center; }
  .expired { color: #ee897d; }
  .mission-name { background: none; border: 0; color: inherit; text-align: left; padding: 0; }
</style>
