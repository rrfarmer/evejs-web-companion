<script lang="ts">
  // Agents & Missions page (goal R4; extended for the R6 courier capstone): the
  // docked station's agents (with a courier/level/text filter + capped render so
  // the page stays responsive with ~1,700 agents), an agent conversation,
  // accepting a courier in person, the mission briefing (with load-package-into-
  // ship + set-autopilot-to-dropoff controls), Complete, and the post-completion
  // wallet / LP / standings readout. A pure reader of the store; all bind /
  // DoAction / GetMission* / Step-12 logic lives on the BFF (which holds the
  // bound agent handle) and in app/flow.ts. The browser addresses agents and
  // missions by their game IDs only.
  import { onMount } from "svelte";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { AgentAction, AgentRow, JournalMission } from "../store/types.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  // R36 — the mission bot sits with the agents it works for.
  import MissionBot from "./MissionBot.svelte";
  import MissionJobPage from "./MissionJobPage.svelte";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { AGENT_MISSION_STATE, offerOpen } from "../bridge/agents.ts";
  import { MISSION_TIME_WORD_LABELS, missionTimeShown, missionTimeText } from "../bridge/missionTime.ts";
  import { INTERVAL_WORD_LABELS, SHORT_INTERVAL_WORD_LABELS } from "../bridge/timeInterval.ts";
  import { PANE_WORD_LABELS, objectivePane, paneMessageIDs, paneNameRefs, type PaneBlock, type PaneMark } from "../bridge/missionObjectivePane.ts";
  import type { MissionMessage } from "../bridge/missionObjectives.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { formatWholeIsk } from "./isk.ts";
  import { pyStandingText } from "./standingsList.ts";
  import { questionText, wordsLabels, wordsNameRefs, type ClientWording } from "../bridge/questions.ts";
  import { sessionPlace } from "../bridge/sessionPlace.ts";
  import { objectiveSystemIDs } from "../bridge/locationWrapper.ts";
  import { AGENT_HEADER_WORD_LABELS, agentHeader, agentLocationNameRef } from "../bridge/agentHeader.ts";
  import { filetimeOf, journalRowAsks, journalRowText, journalRowWords } from "../bridge/journalWords.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const agents = store.agents;
  // svelte-ignore state_referenced_locally
  const rewards = store.rewards;
  // svelte-ignore state_referenced_locally
  const names = store.names;

  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const standings = store.standings;
  // svelte-ignore state_referenced_locally
  const skills = store.skills;
  // Where the pilot's session is now: the marks beside a mission's objectives go by it (bridge/sessionPlace.ts).
  const place = $derived(sessionPlace($flight.status, $station.online));

  let busy = $state(false);
  let error = $state("");

  // What the agent says, in the retail client's own words when the BFF has a
  // client to read. The client adds the agent's own IDs to every agent message
  // (agents.py GetAgentArgs) and the player to every message at all.
  const saysClient = $derived.by<ClientWording>(() => {
    const agentID = $agents.activeAgentID;
    const row = $agents.agents.find((agent) => agent.agentID === agentID) ?? null;
    const contentID = $agents.conversation?.contentID ?? null;
    return {
      templates: $words.templates,
      playerID: $station.online?.characterID ?? null,
      // The mission's keywords first, then the agent's own IDs over them, as the client orders them.
      extra: {
        ...((agentID !== null && contentID !== null ? $agents.missionKeywords[`${agentID}:${contentID}`] : null) ?? {}),
        agentID: agentID ?? undefined,
        agentCorpID: row?.corporationID ?? undefined,
        agentStationID: row?.stationID ?? undefined,
        agentLocation: row?.stationID ?? undefined,
      },
    };
  });
  const saysName = (kind: NameRef["kind"], id: number): string => resolvedName($names.resolved, kind, id, `${kind} ${id}`);
  /** A balance of loyalty points (a bigint-safe decimal string) with its thousands grouped; anything else as it came. */
  const groupedPoints = (points: string): string => (/^-?\d+$/.test(points) ? BigInt(points).toLocaleString("en-US") : points);
  // What the agent says, its markup read as the client's dialogue window reads it: a line break as one, the rest of its
  // tags (bold and the like) as plain words. A text the server sent as it is came through with its tags showing
  // ("<b>Tidings of Conflict (1 of 2)</b><br><br>Your courier assignment…").
  const saysText = $derived(plainText(
    $agents.conversation?.agentSaysWords
      ? questionText($agents.conversation.agentSaysWords, saysName, saysClient)
      : $agents.conversation?.agentSays ?? "",
  ));
  $effect(() => {
    const agentID = $agents.activeAgentID;
    const contentID = $agents.conversation?.contentID ?? null;
    if (agentID !== null && contentID !== null) {
      flow.requestMissionKeywords(agentID, contentID);
    }
    const said = [$agents.conversation?.agentSaysWords ?? null];
    const labels = wordsLabels(said);
    if (labels.length > 0) {
      flow.requestWords(labels);
    }
    const refs = wordsNameRefs(said, saysClient);
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  // The mission's time, under what the agent says (agentDialogueWindow.GetMissionTimeText): what declining
  // would cost and for how long, or when the mission expires. In the client's words or not at all.
  const missionTime = $derived(missionTimeShown($agents.conversation) ? missionTimeText($agents.missionTimes, $words.templates) : null);
  $effect(() => {
    if ($agents.conversation) {
      flow.requestWords([...MISSION_TIME_WORD_LABELS, ...INTERVAL_WORD_LABELS]);
    }
  });

  // Agent-roster filter (the live-test found the raw ~1,678-agent render — Jita
  // 4-4 alone has 882 courier agents — strains the browser). Default to
  // courier-only since that is the milestone; the render is capped and the count
  // is shown so the operator can refine rather than scroll a 1,700-row list.
  const RENDER_CAP = 60;
  let courierOnly = $state(true);
  let levelFilter = $state("all");
  let searchText = $state("");

  const filteredAgents = $derived.by<AgentRow[]>(() => {
    const query = searchText.trim().toLowerCase();
    const level = levelFilter === "all" ? null : Number(levelFilter);
    return $agents.agents.filter((agent) => {
      if (courierOnly && (agent.missionKind ?? "").toLowerCase() !== "courier") {
        return false;
      }
      if (level !== null && agent.level !== level) {
        return false;
      }
      if (query) {
        const haystack = [
          String(agent.agentID),
          agent.missionKind ?? "",
          agent.missionTypeLabel ?? "",
          `l${agent.level ?? ""}`,
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) {
          return false;
        }
      }
      return true;
    });
  });
  const cappedAgents = $derived(filteredAgents.slice(0, RENDER_CAP));

  // R7c — resolve names for everything the page shows by ID: the rendered agents
  // + the open conversation + journal agents (→ agent names), the briefing's
  // cargo type / pickup / destination (→ type + station + system names), and the
  // reward LP corps + standings (→ corp / owner names). Batched + cached by the
  // flow; fire-and-forget so IDs render immediately and swap to names as they land.
  $effect(() => {
    const refs: NameRef[] = [];
    for (const agent of cappedAgents) {
      refs.push({ kind: "agent", id: agent.agentID });
    }
    if ($agents.activeAgentID) {
      refs.push({ kind: "agent", id: $agents.activeAgentID });
    }
    const journal = $agents.journal;
    if (journal) {
      for (const mission of [...journal.active, ...journal.offered]) {
        if (mission.agentID) {
          refs.push({ kind: "agent", id: mission.agentID });
        }
      }
    }
    const briefing = $agents.briefing;
    if (briefing) {
      if (briefing.cargoTypeID) {
        refs.push({ kind: "type", id: briefing.cargoTypeID });
      }
      for (const stationID of [briefing.pickupLocationID, briefing.destinationLocationID]) {
        if (stationID) {
          refs.push({ kind: "station", id: stationID });
        }
      }
      for (const systemID of [briefing.pickupSystemID, briefing.destinationSystemID]) {
        if (systemID) {
          refs.push({ kind: "system", id: systemID });
        }
      }
    }
    for (const lp of $rewards.lpBalances) {
      refs.push({ kind: "corporation", id: lp.issuerCorpID });
    }
    for (const standing of $rewards.standings) {
      refs.push({ kind: "owner", id: standing.fromID });
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      if (isSessionLost(cause)) {
        error = "The live session ended (idle timeout or another client took over).";
      } else {
        error =
          panelErrorWords(cause);
      }
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void run(async () => {
      await flow.loadAgents();
      await flow.loadJournal();
    });
  });

  // Agent name (R7c/R7d) from the name cache — never the raw agent ID (it stays
  // in the onclick / key args); "—" until it resolves.
  function agentName(agentID: number | null): string {
    return resolvedName($names.resolved, "agent", agentID, "—");
  }

  function agentLabel(agent: AgentRow): string {
    const kind = agent.missionKind ? ` · ${agent.missionKind}` : "";
    const name = resolvedName($names.resolved, "agent", agent.agentID, "Agent");
    return `${name} (L${agent.level ?? "?"}${kind})`;
  }

  function stationText(id: number | null): string {
    return resolvedName($names.resolved, "station", id, "—");
  }

  function systemText(id: number | null): string {
    return resolvedName($names.resolved, "system", id, "—");
  }

  // A journal line as the retail client's journal words it: state, agent, the mission's name, its type, when
  // it expires (bridge/journalWords.ts). The name and the type are the client's own text when the BFF has a
  // client to read; without one the name is left out (it is only a message's number) and the type is the last
  // part of its label. The time is this browser's clock, read when the line is drawn.
  const journalClient = $derived<ClientWording>({ templates: $words.templates, playerID: $station.online?.characterID ?? null });
  const hasWords = (key: string): boolean => typeof $words.templates[key] === "string";
  function missionLabel(mission: JournalMission): string {
    const row = journalRowWords(mission, filetimeOf(Date.now()));
    const text = journalRowText(row, (words) => questionText(words, saysName, journalClient), hasWords);
    return [text.state, agentName(mission.agentID), text.name, text.type || "Mission", text.expiration].filter((part) => part !== "").join(" · ");
  }
  $effect(() => {
    const journal = $agents.journal;
    if (!journal) {
      return;
    }
    const now = filetimeOf(Date.now());
    const asks = [...journal.active, ...journal.offered].flatMap((mission) => journalRowAsks(journalRowWords(mission, now)));
    const labels = wordsLabels(asks);
    if (labels.length > 0) {
      // A line's time left is a short written interval, which has labels of its own.
      flow.requestWords([...labels, ...SHORT_INTERVAL_WORD_LABELS]);
    }
  });

  // The mission's title, which the client's agent window shows above what the agent says whenever there is a
  // mission between the two (agentDialogueWindow.py _GetMissionTitleHTML): the title's message, filled like
  // everything else the agent says about the mission. The client takes its number from the briefing it reads
  // for the layout, and so does this when a briefing is held; otherwise it comes with the mission's line in
  // the journal (an agent has one mission with a pilot at a time). Shown only when the page has the
  // client's text for it.
  const talkTitleID = $derived.by<number | null>(() => {
    const agentID = $agents.activeAgentID;
    const briefed = $agents.briefing?.missionTitleID ?? null;
    if (agentID !== null && briefed !== null && briefed > 0) {
      return briefed;
    }
    const journal = $agents.journal;
    if (agentID === null || !journal) {
      return null;
    }
    const row = [...journal.active, ...journal.offered].find((mission) => mission.agentID === agentID);
    return row?.missionTitleID ?? null;
  });
  const titleText = (titleID: number | null, client: ClientWording): string =>
    titleID !== null && titleID > 0 && hasWords(`#${titleID}`)
      ? questionText({ label: null, parameters: null, text: null, messageID: titleID }, saysName, client)
      : "";
  const talkTitle = $derived(titleText(talkTitleID, saysClient));
  const briefingTitle = $derived(titleText($agents.briefing?.missionTitleID ?? null, saysClient));
  $effect(() => {
    const ids = [talkTitleID, $agents.briefing?.missionTitleID ?? null].filter((id): id is number => id !== null && id > 0);
    if (ids.length > 0) {
      flow.requestWords(ids.map((id) => `#${id}`));
    }
  });

  // The client's words name an agent as a character ({[character]agentID.name}); this page keeps agents'
  // names under their own kind, and has them for every agent it shows.
  const isAgentID = (id: number): boolean => id >= 3_000_000 && id < 4_000_000;
  const nameWithAgents = (kind: NameRef["kind"], id: number): string => (kind === "owner" && isAgentID(id) ? agentName(id) : saysName(kind, id));

  // The window's right-hand pane: the mission's objectives, in the client's order and words
  // (bridge/missionObjectivePane.ts). Drawn only when the client's words for it are to hand; without
  // them a courier keeps this page's own table below.
  const pane = $derived.by<PaneBlock[]>(() => {
    const objectives = $agents.objectives;
    const agentID = $agents.activeAgentID;
    if (objectives === null || agentID === null) {
      return [];
    }
    return objectivePane(objectives, {
      templates: $words.templates,
      nameOf: nameWithAgents,
      // session.locationid: the station (or structure) the pilot is in, or the solar system it is flying in.
      locationID: place.locationID,
      // The mission's name is its message with nothing filled in, as the pane's own GetByMessageID has it.
      messageText: (messageID) => (hasWords(`#${messageID}`) ? questionText({ label: null, parameters: null, text: null, messageID }, saysName, { templates: $words.templates }) : null),
      say: (message) => sayOfMission(agentID, message),
      securityOf,
      ownSecurityStatus,
    });
  });
  // A place's name has its system's security rating before it (bridge/locationWrapper.ts).
  const securityOf = (solarSystemID: number): number | null => $names.systemSecurity[solarSystemID] ?? null;
  // And, where it is not low security, the outlaw's warning, by the pilot's own security status: asked of crimewatch
  // the first time a place wants it, as the client's LocationWrapper asks its crimewatch service, and kept.
  const ownSecurityStatus = (): number | null => {
    const kept = $station.ownSecurityStatus;
    if (kept === null) flow.requestOwnSecurityStatus();
    return kept;
  };

  // The agent's header at the top of its window (bridge/agentHeader.ts): its name, its division, where it is (the
  // layout's GetAgentLocationWrap), the pilot's effective standing with it, and the loyalty points the last action
  // says. Asked for: the agent as the client's agents service knows it, the header's words and the division's
  // name, the place's name and its system's security.
  const header = $derived.by(() => {
    const agentID = $agents.activeAgentID;
    const conversation = $agents.conversation;
    if (agentID === null || conversation === null) return null;
    return agentHeader({
      agentID,
      record: $agents.agentRecords[agentID] ?? null,
      location: $agents.agentLocation,
      loyaltyPoints: conversation.lastActionInfo.loyaltyPoints,
      standings: $standings.char === null ? null : new Map($standings.char.map((row) => [row.fromID, row.standing])),
      skillLevel: $skills.skills === null ? null : ((levels) => (typeID: number) => levels.get(typeID) ?? 0)(new Map($skills.skills.map((skill) => [skill.typeID, skill.level]))),
    }, {
      templates: $words.templates,
      nameOf: nameWithAgents,
      messageText: (messageID) => (hasWords(`#${messageID}`) ? questionText({ label: null, parameters: null, text: null, messageID }, saysName, { templates: $words.templates }) : null),
      securityOf,
      ownSecurityStatus,
    });
  });
  $effect(() => {
    const agentID = $agents.activeAgentID;
    if (agentID === null || $agents.conversation === null) return;
    flow.requestAgentRecord(agentID);
    const divisionNameID = $agents.agentRecords[agentID]?.divisionNameID ?? null;
    flow.requestWords([...AGENT_HEADER_WORD_LABELS, ...(divisionNameID === null ? [] : [`#${divisionNameID}`])]);
    const location = $agents.agentLocation;
    if (location !== null) {
      flow.requestNames([agentLocationNameRef(location)]);
      if (location.solarSystemID !== null) flow.requestSystemSecurity([location.solarSystemID]);
    }
  });
  // The effective standing wants the pilot's standings and skills, which the client has had since it logged in:
  // read here if they have not been, once for each agent whose window opens (this effect reads only which agent;
  // a read that fails is not asked again on every change of the agents' store).
  let headerReadsFor: number | null = null;
  $effect(() => {
    const agentID = $agents.activeAgentID;
    if (agentID === null || agentID === headerReadsFor) return;
    headerReadsFor = agentID;
    if (!store.standings.get().loaded) void flow.loadStandings().catch(() => {});
    if (store.skills.get().skills === null) void flow.loadSkills().catch(() => {});
  });
  // What an agent says of a dungeon, filled as everything it says of that mission is: the mission's
  // keywords, then the agent's own IDs (agents.py ProcessMessage).
  function sayOfMission(agentID: number, message: MissionMessage): string | null {
    if (message.text !== null) {
      return message.text;
    }
    const key = message.label ?? (message.messageID === null ? null : `#${message.messageID}`);
    if (key === null || !hasWords(key)) {
      return null;
    }
    const keywords = message.contentID === null ? null : $agents.missionKeywords[`${agentID}:${message.contentID}`];
    return questionText({ label: message.label, parameters: message.parameters, text: null, messageID: message.messageID ?? undefined }, saysName, { ...saysClient, extra: { ...((keywords ?? {}) as NonNullable<ClientWording["extra"]>), ...saysClient.extra } });
  }
  $effect(() => {
    const objectives = $agents.objectives;
    const agentID = $agents.activeAgentID;
    if (objectives === null || agentID === null) {
      return;
    }
    const messages = objectives.dungeons.map((dungeon) => dungeon.briefingMessage).filter((message): message is MissionMessage => message !== null);
    flow.requestWords([
      ...PANE_WORD_LABELS,
      ...paneMessageIDs(objectives).map((id) => `#${id}`),
      ...messages.map((message) => message.label ?? (message.messageID === null ? null : `#${message.messageID}`)).filter((key): key is string => key !== null),
    ]);
    for (const message of messages) {
      if (message.contentID !== null) {
        flow.requestMissionKeywords(agentID, message.contentID);
      }
    }
    const refs = paneNameRefs(objectives).map((ref) => (ref.kind === "owner" && isAgentID(ref.id) ? { kind: "agent" as const, id: ref.id } : ref));
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
    flow.requestSystemSecurity(objectiveSystemIDs(objectives));
  });
  const MARKS: Readonly<Record<PaneMark, readonly [string, string]>> = { done: ["✓", "done"], open: ["○", "not yet"], failed: ["✕", "failed"] };


  // A mission's line in the client's journal has "Read Details" first in its menu, and a double click
  // does the same (missionentry.py 64 and 78). Here it is a button on the line.
  const READ_DETAILS = "UI/Agents/Commands/ReadDetails";
  const readDetailsWords = $derived.by<string>(() => {
    const template = $words.templates[READ_DETAILS];
    return typeof template === "string" ? plainText(template) : "Read details";
  });

  // A mission's line in the client's journal has "Start Conversation with <agent>" in its menu
  // (missionentry.py 64, agents.OpenDialogueWindow), wherever the agent is. Here it is a button on the line.
  const START_CONVERSATION = "UI/Agents/Commands/StartConversationWith";
  // An offer's line has "Remove Offer" too (missionentry.py 65).
  const REMOVE_OFFER = "UI/Agents/Commands/RemoveOffer";
  const removeOfferWords = $derived.by<string>(() => {
    const template = $words.templates[REMOVE_OFFER];
    return typeof template === "string" ? plainText(template) : "Remove offer";
  });
  const startConversationWords = (agentID: number): string => {
    const template = $words.templates[START_CONVERSATION];
    return typeof template === "string"
      ? plainText(formatTemplate(template, { agentID }, { nameOf: nameWithAgents }))
      : `Start conversation with ${agentName(agentID)}`;
  };
  $effect(() => {
    const journal = $agents.journal;
    if (journal && journal.active.length + journal.offered.length > 0) {
      flow.requestWords([READ_DETAILS, START_CONVERSATION, REMOVE_OFFER]);
    }
  });
</script>

{#snippet journalLine(mission: JournalMission)}
  <li>
    <span class="journal-line">{missionLabel(mission)}</span>
    {#if mission.agentID}
      {@const agentID = mission.agentID}
      <button type="button" class="link journal-details" disabled={busy} onclick={() => run(() => flow.openMissionDetails(agentID))}>
        {readDetailsWords}
      </button>
      <button type="button" class="link journal-talk" disabled={busy} onclick={() => run(() => flow.openConversation(agentID))}>
        {startConversationWords(agentID)}
      </button>
      {#if mission.missionState === AGENT_MISSION_STATE.OFFERED}
        <button type="button" class="link journal-remove" disabled={busy} onclick={() => run(() => flow.removeOffer(agentID))}>
          {removeOfferWords}
        </button>
      {/if}
    {/if}
  </li>
{/snippet}

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Agents &amp; Missions</h2>
    <p class="controls">
      <button type="button" class="primary" disabled={busy} onclick={() => run(async () => { await flow.loadAgents(); await flow.loadJournal(); })}>
        Refresh
      </button>
    </p>
  </header>
  <!-- (A refusal the client's own dialog said is not said again here: ClientDialogs.svelte.) -->
  {#if $agents.actionError && !$agents.actionErrorSaid}
    <p class="error">Last agent action failed: {$agents.actionError}</p>
  {/if}
  {#if error}
    <p class="error">{error}</p>
  {/if}
</section>

<section>
  <h2>Station agents</h2>
  <div class="agent-filter">
    <label>
      <input type="checkbox" bind:checked={courierOnly} />
      Courier only
    </label>
    <label>
      Level
      <select bind:value={levelFilter}>
        <option value="all">All</option>
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="3">3</option>
        <option value="4">4</option>
        <option value="5">5</option>
      </select>
    </label>
    <label>
      Search
      <input type="search" placeholder="mission type or level" bind:value={searchText} />
    </label>
  </div>
  {#if $agents.agents.length === 0}
    <p class="empty">{!$agents.loaded ? "Loading agents…" : $agents.stationID === null ? "Not docked at a station." : "No agents at this station."}</p>
  {:else}
    <p class="note">
      Showing {cappedAgents.length} of {filteredAgents.length} matching
      ({$agents.agents.length} at this station).
      {#if filteredAgents.length > cappedAgents.length}
        Refine the filter to narrow the list.
      {/if}
    </p>
    {#if cappedAgents.length === 0}
      <p class="empty">No agents match the filter.</p>
    {:else}
      <ul class="agent-list">
        {#each cappedAgents as agent (agent.agentID)}
          <li>
            <button
              type="button"
              class:active={agent.agentID === $agents.activeAgentID}
              disabled={busy}
              onclick={() => run(() => flow.openConversation(agent.agentID))}
            >
              {agentLabel(agent)}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

{#if $agents.conversation}
  <section>
    <h2>Conversation · {agentName($agents.activeAgentID)}</h2>
    {#if header}
      <!-- GetAgentLocationHeader, which the client's window begins what the agent says with (no portrait, no link). -->
      <div class="mission-page-card agent-header">
        <strong class="mission-page-card-name">{header.name}</strong>
        {#if header.division}<span class="mission-page-card-line minor">{header.division}</span>{/if}
        {#if header.location}<span class="mission-page-card-line">{header.location}</span>{/if}
        {#if header.standing}<span class="mission-page-card-line standing" class:low={header.standingLow}>{header.standing}</span>{/if}
        {#if header.loyaltyPoints}<span class="mission-page-card-line">{header.loyaltyPoints}</span>{/if}
      </div>
    {/if}
    {#if talkTitle}
      <h3 class="mission-title">{talkTitle}</h3>
    {/if}
    <p class="agent-says" style="white-space: pre-line">{saysText}</p>
    {#if missionTime}
      <p class="note mission-time">{missionTime}</p>
    {/if}
    <p class="controls">
      {#each $agents.conversation.actions as action (action.actionID)}
        <button
          type="button"
          disabled={busy}
          onclick={() => run(() => flow.chooseAction($agents.activeAgentID as number, action as AgentAction))}
        >
          {action.label}
        </button>
      {/each}
      {#if $agents.conversation.actions.length === 0}
        <span class="note">No actions available.</span>
      {/if}
    </p>
    {#if $agents.conversation.lastActionInfo.missionCompleted}
      <p class="note">Mission completed — reward applied.</p>
    {/if}
    {#if $agents.conversation.lastActionInfo.missionDeclined}
      <p class="note">Mission declined.</p>
    {/if}
  </section>
{/if}

{#if pane.length > 0}
  <section class="mission-objectives">
    {#each pane as block}
      {#if block.kind === "warning"}
        <p class="note mission-warning">{block.text}</p>
      {:else if block.kind === "heading"}
        {#if block.cheated}
          <p class="note mission-cheated">Marked complete by a game master.</p>
        {/if}
        <h2 class="mission-objectives-title {block.state}">{block.title}</h2>
      {:else if block.kind === "overview"}
        <p class="note">{block.text}</p>
      {:else}
        <h3 class="mission-block-title">{block.title}</h3>
        {#if block.text}
          <p class="mission-block-text" style="white-space: pre-line">
            {#if block.outcome}<s>{block.text}</s> <span class="mission-outcome">{block.outcome}</span>{:else}{block.text}{/if}
          </p>
        {/if}
        {#if block.rows.length > 0}
          <ul class="mission-rows">
            {#each block.rows as row}
              <li>
                {#if row.mark}<span class="mission-mark {row.mark}" title={MARKS[row.mark][1]}>{MARKS[row.mark][0]}</span>{/if}
                {#if row.label}<span class="mission-row-label">{row.label}</span>{/if}
                <span class="mission-row-text">{row.text}</span>
              </li>
            {/each}
          </ul>
        {/if}
        {#if block.objective?.kind === "transport"}
          {@const transport = block.objective}
          {#if offerOpen($agents.conversation)}
            <!-- The client's window shows an offer's objectives before it is taken. The package is handed over on accepting. -->
            <p class="note mission-offered">This is the offer. Accept it in the conversation to be given the package.</p>
          {:else}
            <p class="controls">
              <button
                type="button"
                disabled={busy || transport.cargo?.typeID == null}
                onclick={() => run(() => flow.loadPackageIntoShip(transport.cargo!.typeID as number, transport.cargo!.quantity ?? 1))}
              >
                Load package into ship
              </button>
              <button
                type="button"
                disabled={busy || transport.dropoff?.locationID == null}
                onclick={() => run(() => flow.setAutopilotToDropoff(transport.dropoff!.locationID as number))}
              >
                Set autopilot to dropoff
              </button>
            </p>
          {/if}
        {/if}
      {/if}
    {/each}
  </section>
{:else if $agents.briefing}
  <section>
    <h2>Courier briefing{briefingTitle ? ` · ${briefingTitle}` : ""}</h2>
    <table class="guests">
      <tbody>
        <tr><th>Cargo type</th><td>{resolvedName($names.resolved, "type", $agents.briefing.cargoTypeID, "—")}</td></tr>
        <tr><th>Quantity</th><td class="num">{$agents.briefing.cargoQuantity ?? "—"}</td></tr>
        <tr><th>Volume (m³)</th><td class="num">{$agents.briefing.cargoVolume ?? "—"}</td></tr>
        <tr><th>Pickup</th><td>{stationText($agents.briefing.pickupLocationID)} · {systemText($agents.briefing.pickupSystemID)}</td></tr>
        <tr><th>Destination</th><td>{stationText($agents.briefing.destinationLocationID)} · {systemText($agents.briefing.destinationSystemID)}</td></tr>
        <tr><th>Reward (ISK)</th><td class="num">{$agents.briefing.rewardISK ?? "—"}</td></tr>
        <tr><th>Time bonus (ISK)</th><td class="num">{$agents.briefing.bonusISK ?? "—"}</td></tr>
        <tr><th>Loyalty points</th><td class="num">{$agents.briefing.loyaltyPoints ?? "—"}</td></tr>
      </tbody>
    </table>
    {#if offerOpen($agents.conversation)}
      <!-- The client's window shows an offer's objectives before it is taken. The package is handed over on accepting. -->
      <p class="note mission-offered">This is the offer. Accept it in the conversation to be given the package.</p>
    {:else}
    <p class="controls">
      <button
        type="button"
        disabled={busy || $agents.briefing.cargoTypeID === null}
        onclick={() =>
          run(() =>
            flow.loadPackageIntoShip(
              $agents.briefing!.cargoTypeID as number,
              ($agents.briefing!.cargoQuantity ?? 1) as number,
            ),
          )}
      >
        Load package into ship
      </button>
      <button
        type="button"
        disabled={busy || $agents.briefing.destinationLocationID === null}
        onclick={() => run(() => flow.setAutopilotToDropoff($agents.briefing!.destinationLocationID as number))}
      >
        Set autopilot to dropoff
      </button>
    </p>
    <p class="note">
      Load the package into the active ship, autopilot to the dropoff station,
      dock, then Complete Mission in the agent conversation.
    </p>
    {/if}
  </section>
{/if}

<MissionJobPage {store} {flow} />

{#if $rewards.loaded}
  <section>
    <h2>Reward &amp; wallet</h2>
    {#if $rewards.error}
      <p class="error">Some reward details could not be loaded: {$rewards.error}</p>
    {/if}
    <table class="guests">
      <tbody>
        <!-- The balance as the Wallet window writes it, a standing as the client's standings write one, and loyalty
             points grouped: they came out as the server's raw numbers ("1939913011.6", "1.5538180000000001"). -->
        <tr><th>Wallet balance (ISK)</th><td class="num">{formatWholeIsk($rewards.cashBalance, "truncate")}</td></tr>
      </tbody>
    </table>
    <h3 class="note">Loyalty points ({$rewards.lpBalances.length})</h3>
    {#if $rewards.lpBalances.length === 0}
      <p class="empty">No loyalty-point balances.</p>
    {:else}
      <ul class="journal">
        {#each $rewards.lpBalances as lp (lp.issuerCorpID)}
          <li>{resolvedName($names.resolved, "corporation", lp.issuerCorpID, "—")} · {groupedPoints(lp.loyaltyPoints)} LP</li>
        {/each}
      </ul>
    {/if}
    <h3 class="note">Standings ({$rewards.standings.length})</h3>
    {#if $rewards.standings.length === 0}
      <p class="empty">No standings.</p>
    {:else}
      <ul class="journal">
        {#each $rewards.standings as standing (standing.fromID)}
          <li>toward {resolvedName($names.resolved, "owner", standing.fromID, "—")} · {pyStandingText(standing.standing)}</li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<section>
  <h2>Mission journal</h2>
  {#if !$agents.journal}
    <p class="note">Loading journal…</p>
  {:else}
    <h3 class="note">Active ({$agents.journal.active.length})</h3>
    {#if $agents.journal.active.length === 0}
      <p class="empty">No active missions.</p>
    {:else}
      <ul class="journal">
        {#each $agents.journal.active as mission (mission.missionID)}
          {@render journalLine(mission)}
        {/each}
      </ul>
    {/if}
    <h3 class="note">Offered ({$agents.journal.offered.length})</h3>
    {#if $agents.journal.offered.length === 0}
      <p class="empty">No offered missions.</p>
    {:else}
      <ul class="journal">
        {#each $agents.journal.offered as mission (mission.missionID)}
          {@render journalLine(mission)}
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<MissionBot {store} {flow} />
