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
  import type { AgentAction, AgentBriefingChoice, AgentRow, JournalMission } from "../store/types.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  // R36 — the mission bot sits with the agents it works for.
  import MissionBot from "./MissionBot.svelte";
  import MissionJobPage from "./MissionJobPage.svelte";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { AGENT_CLOSE_LABEL, AGENT_MISSION_STATE, agentButtonWord, agentConversationFooter, offerOpen } from "../bridge/agents.ts";
  import { MISSION_REPLAY_WORD_LABELS, MISSION_TIME_WORD_LABELS, missionReplayText, missionTimeShown, missionTimeText } from "../bridge/missionTime.ts";
  import LabelText from "./LabelText.svelte";
  import TypeIcon from "./TypeIcon.svelte";
  import OwnerPicture from "./OwnerPicture.svelte";
  import { portraitDefaultPath, portraitUrl } from "./ownerImages.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { showInfo, subjectOfShowInfoLink } from "./showInfo.ts";
  import { LINK_WORDS, missionLinkFollower, startLinkDrag } from "./linkFollowers.ts";
  import { journalMessageMarkup, journalMessagePhrases, missionMarkup } from "../bridge/journalMission.ts";
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
  import { agentMissionTrackable, isAgentMissionTracked, toggleTrackedAgentMission, trackedJobsChanged } from "./jobTracking.ts";

  let { store, flow, conversationAgentID = null, onConversationClose }: {
    store: ClientStore; flow: AppFlow; conversationAgentID?: number | null; onConversationClose?: () => void;
  } = $props();

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
  // svelte-ignore state_referenced_locally
  const imageServer = flow.imageServer;
  // svelte-ignore state_referenced_locally
  const logos = flow.ownerLogos;
  // Where the pilot's session is now: the marks beside a mission's objectives go by it (bridge/sessionPlace.ts).
  const place = $derived(sessionPlace($flight.status, $station.online));

  let busy = $state(false);
  let error = $state("");
  const standalone = $derived(conversationAgentID !== null);
  const conversationOwner = $derived(conversationAgentID ?? $agents.activeAgentID);
  const portrait = $derived(conversationOwner === null ? null : portraitUrl($imageServer, conversationOwner, 256));
  const portraitUrls = $derived([...(portrait ? [portrait] : []), clientTexture(portraitDefaultPath(256))]);
  const showInfoLabel = "UI/Commands/ShowInfo";
  const showInfoWords = $derived(plainText($words.templates[showInfoLabel] ?? "Show Info"));
  const headerInfoIcon = clientTexture("res:/ui/texture/icons/38_16_208.png");
  const layout = $derived(conversationAgentID === null ? $agents : $agents.conversationLayouts[conversationAgentID]);
  const conversation = $derived(layout?.conversation ?? null);
  const briefing = $derived(layout?.briefing ?? null);
  const objectives = $derived(layout?.objectives ?? null);
  const missionTimes = $derived(layout?.missionTimes ?? null);
  const agentLocation = $derived(layout?.agentLocation ?? null);
  const conversationError = $derived(conversationAgentID === null ? null : $agents.conversationErrors[conversationAgentID]);
  const footer = $derived(standalone && conversation ? agentConversationFooter(conversation) : null);
  const characterID = $derived($station.online?.characterID ?? null);
  const trackableMission = $derived(standalone && $agents.journal
    ? [...$agents.journal.active, ...$agents.journal.offered].find(mission => mission.agentID === conversationAgentID && agentMissionTrackable(mission))
    : undefined);
  const missionTracked = $derived.by(() => {
    void $trackedJobsChanged;
    return trackableMission !== undefined && isAgentMissionTracked(characterID, trackableMission);
  });
  const trackLabel = $derived(missionTracked ? "UI/Common/Untrack" : "UI/Common/Track");
  $effect(() => {
    if (!footer) return;
    const paths = footer.actions.map(action => agentButtonWord(action.buttonType)).filter(path => path !== null);
    flow.requestWords([...paths, ...(footer.close ? [AGENT_CLOSE_LABEL] : []), "UI/Common/Track", "UI/Common/Untrack"]);
  });

  // What the agent says, in the retail client's own words when the BFF has a
  // client to read. The client adds the agent's own IDs to every agent message
  // (agents.py GetAgentArgs) and the player to every message at all.
  const agentWordArgs = $derived.by<NonNullable<ClientWording["extra"]>>(() => {
    const agentID = conversationOwner;
    const row = agentID === null ? null : $agents.agentRecords[agentID] ?? $agents.agents.find((agent) => agent.agentID === agentID);
    return {
      agentID: agentID ?? undefined,
      agentCorpID: row?.corporationID ?? undefined,
      agentStationID: row?.stationID ?? undefined,
      agentLocation: row?.stationID ?? row?.solarSystemID ?? undefined,
    };
  });
  const saysClient = $derived.by<ClientWording>(() => {
    const agentID = conversationOwner;
    const contentID = conversation?.contentID ?? null;
    return {
      templates: $words.templates,
      playerID: $station.online?.characterID ?? null,
      // The mission's keywords first, then the agent's own IDs over them, as the client orders them.
      extra: {
        ...((agentID !== null && contentID !== null ? $agents.missionKeywords[`${agentID}:${contentID}`] : null) ?? {}),
        ...agentWordArgs,
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
    conversation?.agentSaysWords
      ? questionText(conversation.agentSaysWords, saysName, saysClient)
      : conversation?.agentSays ?? "",
  ));
  $effect(() => {
    const agentID = conversationOwner;
    const contentID = conversation?.contentID ?? null;
    if (agentID !== null && contentID !== null) {
      flow.requestMissionKeywords(agentID, contentID);
    }
    const said = [conversation?.agentSaysWords ?? null];
    const labels = wordsLabels(said);
    if (labels.length > 0) {
      flow.requestWords(labels);
    }
    const refs = wordsNameRefs(said, saysClient);
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  const briefingChoices = $derived(conversation?.lastActionInfo.missionCantReplay ? [] : conversation?.briefingChoices ?? []);
  function choiceWording(choice: AgentBriefingChoice): ClientWording {
    const agentID = conversationOwner;
    const cached = agentID !== null && choice.contentID !== null ? $agents.missionKeywords[`${agentID}:${choice.contentID}`] : null;
    return {
      templates: $words.templates,
      playerID: $station.online?.characterID ?? null,
      extra: { ...choice.keywords, ...cached, ...agentWordArgs },
    };
  }
  $effect(() => {
    const agentID = conversationOwner;
    for (const choice of briefingChoices) {
      if (agentID !== null && choice.contentID !== null && Object.keys(choice.keywords).length === 0) {
        flow.requestMissionKeywords(agentID, choice.contentID);
      }
      const words = [choice.title, choice.briefing];
      const labels = wordsLabels(words);
      if (labels.length > 0) flow.requestWords(labels);
      const refs = wordsNameRefs(words, choiceWording(choice));
      if (refs.length > 0) flow.requestNames(refs);
    }
  });

  // The mission's time, under what the agent says (agentDialogueWindow.GetMissionTimeText): what declining
  // would cost and for how long, or when the mission expires. In the client's words or not at all.
  const missionTime = $derived(missionTimeShown(conversation) ? missionTimeText(missionTimes, $words.templates) : null);
  const replayVariant = $derived(conversation ? (Math.random() < 0.5 ? 0 : 1) : 0);
  const replay = $derived(missionReplayText(conversation?.lastActionInfo.missionCantReplay ?? 0,
    conversationOwner === null ? null : $agents.agentRecords[conversationOwner]?.divisionID ?? null,
    replayVariant, $words.templates));
  $effect(() => {
    if (conversation) {
      flow.requestWords([...MISSION_TIME_WORD_LABELS, ...INTERVAL_WORD_LABELS]);
      if (conversation.lastActionInfo.missionCantReplay) flow.requestWords(MISSION_REPLAY_WORD_LABELS);
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
    if (conversationOwner) {
      refs.push({ kind: "agent", id: conversationOwner });
    }
    const journal = $agents.journal;
    if (journal) {
      for (const mission of [...journal.active, ...journal.offered]) {
        if (mission.agentID) {
          refs.push({ kind: "agent", id: mission.agentID });
        }
      }
    }

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
    if (conversationAgentID !== null) {
      const id = conversationAgentID;
      void run(() => flow.openConversation(id));
      return;
    }
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
    const agentID = conversationOwner;
    const briefed = briefing?.missionTitleID ?? null;
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
  const briefingTitle = $derived(titleText(briefing?.missionTitleID ?? null, saysClient));
  $effect(() => {
    const ids = [talkTitleID, briefing?.missionTitleID ?? null].filter((id): id is number => id !== null && id > 0);
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

    const agentID = conversationOwner;
    if (objectives === null || agentID === null) {
      return [];
    }
    return objectivePane(objectives, {
      templates: $words.templates,
      rich: true,
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
    const agentID = conversationOwner;

    if (agentID === null || conversation === null) return null;
    return agentHeader({
      agentID,
      record: $agents.agentRecords[agentID] ?? null,
      location: agentLocation,
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
    const agentID = conversationOwner;
    if (agentID === null || conversation === null) return;
    flow.requestAgentRecord(agentID);
    const divisionNameID = $agents.agentRecords[agentID]?.divisionNameID ?? null;
    flow.requestWords([...AGENT_HEADER_WORD_LABELS, showInfoLabel, ...(divisionNameID === null ? [] : [`#${divisionNameID}`])]);
    const location = agentLocation;
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
    const agentID = conversationOwner;
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
    const keywords = message.contentID === null ? null : $agents.missionKeywords[`${agentID}:${message.contentID}`];
    return journalMessageMarkup(objectiveWords(message), nameWithAgents, { ...saysClient, extra: { ...keywords, ...agentWordArgs } });
  }
  function objectiveWords(message: MissionMessage) {
    return { label: message.label, parameters: message.parameters, text: message.text, messageID: message.messageID ?? undefined };
  }
  function objectiveFollower(url: string, text: string) {
    return missionLinkFollower(url, flow, label => plainText($words.templates[label] ?? LINK_WORDS[label] ?? ""), text);
  }
  $effect(() => {

    const agentID = conversationOwner;
    if (objectives === null || agentID === null) {
      return;
    }
    const messages = objectives.dungeons.map((dungeon) => dungeon.briefingMessage).filter((message): message is MissionMessage => message !== null);
    flow.requestWords([
      ...PANE_WORD_LABELS,
      ...paneMessageIDs(objectives).map((id) => `#${id}`),
      ...wordsLabels(messages.flatMap(message => journalMessagePhrases(objectiveWords(message)))),
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

{#if !standalone}
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
              class:active={agent.agentID === conversationOwner}
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

{/if}
{#if standalone && error}
  <p role="alert">{error}</p>
{:else if standalone && conversationError}
  <p role="alert">{conversationError}</p>
{/if}
{#if standalone && !conversation}
  {#if busy}<p role="status">Opening conversation…</p>
  {:else if conversationAgentID !== null}
    {@const id = conversationAgentID}
    <button type="button" onclick={() => run(() => flow.openConversation(id))}>Start Conversation</button>
  {/if}
{:else}
<div class:agent-conversation-frame={standalone}>
<div class:standalone-conversation={standalone} class:double-pane={standalone && (pane.length > 0 || !!briefing || !!conversation?.lastActionInfo.missionCompleted)}>
{#if conversation}
  <section>
    {#if !standalone}<h2>Conversation · {agentName(conversationOwner)}</h2>{/if}
    {#if header && conversationOwner !== null}
      {@const agentID = conversationOwner}
      <div class="agent-header">
        <OwnerPicture name={header.name} urls={portraitUrls} size={128} />
        <div class="mission-page-card">
          <div class="agent-header-name">
            <span>{header.name}</span>
            <button type="button" class="agent-header-info" title={showInfoWords} aria-label={showInfoWords}
              onclick={() => showInfo({ kind: "character", characterID: agentID })}>
              <img src={headerInfoIcon} width="16" height="16" alt="" />
            </button>
          </div>
          {#if header.division}<span class="mission-page-card-line minor">{header.division}</span>{/if}
          {#if header.location.length}
            <div class="agent-header-location">
              {#each header.location as part}
                {#if part.link}
                  {@const {typeID, itemID} = part.link}
                  {@const url = `showinfo:${typeID}//${itemID}`}
                  <a href={url} class="evelink showInfo" title={showInfoWords} draggable="true"
                    onclick={event => {
                      event.preventDefault();
                      const subject = subjectOfShowInfoLink(url);
                      showInfo(subject && subject.kind !== "type" ? subject : { kind: "spaceObject", typeID, itemID });
                    }}
                    ondragstart={event => startLinkDrag(event, url, part.text)}>{part.text}</a>
                {:else}
                  <span style:color={part.color}>{part.text}</span>
                {/if}
              {/each}
            </div>
          {/if}
          {#if header.standing}<span class="mission-page-card-line standing agent-header-standing" class:low={header.standingLow}>{header.standing}</span>{/if}
          {#if header.loyaltyPoints}<span class="mission-page-card-line">{header.loyaltyPoints}</span>{/if}
        </div>
      </div>
    {/if}
    {#if talkTitle}
      <h3 class="mission-title">{talkTitle}</h3>
    {/if}
    <p class="agent-says" style="white-space: pre-line">{replay?.message ?? saysText}</p>
    {#if replay?.timer}<div class="agent-replay-time"><LabelText markup={replay.timer} /></div>{/if}
    {#if missionTime}
      <p class="note mission-time">{missionTime}</p>
    {/if}
    {#each briefingChoices as choice (choice.actionID)}
      {@const client = choiceWording(choice)}
      {@const title = plainText(questionText(choice.title, saysName, client))}
      <div class="agent-briefing-choice">
        <button type="button" class="link" disabled={busy} onclick={() => run(() => flow.chooseAction(conversationOwner as number, { actionID: choice.actionID, buttonType: 0, label: title }))}>{title}</button>
        <span aria-hidden="true">&gt;&gt;</span>
        {#if choice.briefing}
          <p>{plainText(questionText(choice.briefing, saysName, client))}</p>
        {/if}
      </div>
    {/each}
    {#if !standalone}<p class="controls">
      {#each conversation.actions.filter(action => action.buttonType > 0) as action (action.actionID)}
        <button
          type="button"
          disabled={busy}
          onclick={() => run(() => flow.chooseAction(conversationOwner as number, action as AgentAction))}
        >
          {action.label}
        </button>
      {/each}
      {#if briefingChoices.length === 0 && !conversation.actions.some(action => action.buttonType > 0)}
        <span class="note">No actions available.</span>
      {/if}
    </p>{/if}
    {#if conversation.lastActionInfo.missionCompleted}
      <p class="note">Mission completed — reward applied.</p>
    {/if}
    {#if conversation.lastActionInfo.missionDeclined}
      <p class="note">Mission declined.</p>
    {/if}
  </section>
{/if}

{#if pane.length > 0}
  <section class="mission-objectives">
    {#each pane as block}
      {#if block.kind === "warning"}
        <div class="note mission-warning"><LabelText markup={missionMarkup(block.text ?? "")} followerOf={objectiveFollower} /></div>
      {:else if block.kind === "heading"}
        {#if block.cheated}
          <p class="note mission-cheated">Marked complete by a game master.</p>
        {/if}
        <h2 class="mission-objectives-title {block.state}">{plainText(block.title)}</h2>
      {:else if block.kind === "overview"}
        <div class="note"><LabelText markup={missionMarkup(block.text ?? "")} followerOf={objectiveFollower} /></div>
      {:else}
        <h3 class="mission-block-title">{plainText(block.title ?? "")}</h3>
        {#if block.text}
          <div class="mission-block-text">
            <div style:text-decoration={block.outcome ? "line-through" : undefined}><LabelText markup={missionMarkup(block.text)} followerOf={objectiveFollower} /></div>
            {#if block.outcome}<span class="mission-outcome">{plainText(block.outcome)}</span>{/if}
          </div>
        {/if}
        {#if block.rows.length > 0}
          <ul class="mission-rows">
            {#each block.rows as row}
              <li>
                {#if row.mark}<span class="mission-mark {row.mark}" title={MARKS[row.mark][1]}>{MARKS[row.mark][0]}</span>{/if}
                {#if row.info}
                  {@const url = `showinfo:${row.info.typeID}${row.info.itemID ? `//${row.info.itemID}` : ""}`}
                  {@const name = row.info.itemID ? nameWithAgents("owner", row.info.itemID) : nameWithAgents("type", row.info.typeID)}
                  {@const follower = objectiveFollower(url, name)}
                  {#if follower}
                    <button type="button" class="mission-objective-info" title={follower.hint}
                      aria-label={`${follower.hint} — ${name}`} draggable="true"
                      onclick={follower.follow} ondragstart={event => startLinkDrag(event, url, name)}>
                      {#if row.info.typeID === 1377 && row.info.itemID}
                        {@const image = portraitUrl($imageServer, row.info.itemID, 32)}
                        <OwnerPicture {name} urls={[...(image ? [image] : []), clientTexture(portraitDefaultPath(32))]} size={32} />
                      {:else if row.info.itemID}
                        {@const logo = row.info.typeID === 30 ? $logos?.factions[row.info.itemID] : $logos?.corporations[row.info.itemID]}
                        <OwnerPicture {name} urls={logo ? [clientTexture(logo)] : []} size={32} />
                      {:else}<TypeIcon typeID={row.info.typeID} {name} size="md" />{/if}
                    </button>
                  {/if}
                {/if}
                <div class="mission-row-text">
                  {#if row.label}<span class="mission-row-label">{plainText(row.label)}</span>{/if}
                  <LabelText markup={missionMarkup(row.text)} followerOf={objectiveFollower} />
                </div>
              </li>
            {/each}
          </ul>
        {/if}
        {#if block.objective?.kind === "transport"}
          {@const transport = block.objective}
          {#if offerOpen(conversation)}
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
{:else if briefing}
  <section>
    <h2>Courier briefing{briefingTitle ? ` · ${briefingTitle}` : ""}</h2>
    <table class="guests">
      <tbody>
        <tr><th>Cargo type</th><td>{resolvedName($names.resolved, "type", briefing.cargoTypeID, "—")}</td></tr>
        <tr><th>Quantity</th><td class="num">{briefing.cargoQuantity ?? "—"}</td></tr>
        <tr><th>Volume (m³)</th><td class="num">{briefing.cargoVolume ?? "—"}</td></tr>
        <tr><th>Pickup</th><td>{stationText(briefing.pickupLocationID)} · {systemText(briefing.pickupSystemID)}</td></tr>
        <tr><th>Destination</th><td>{stationText(briefing.destinationLocationID)} · {systemText(briefing.destinationSystemID)}</td></tr>
        <tr><th>Reward (ISK)</th><td class="num">{briefing.rewardISK ?? "—"}</td></tr>
        <tr><th>Time bonus (ISK)</th><td class="num">{briefing.bonusISK ?? "—"}</td></tr>
        <tr><th>Loyalty points</th><td class="num">{briefing.loyaltyPoints ?? "—"}</td></tr>
      </tbody>
    </table>
    {#if offerOpen(conversation)}
      <!-- The client's window shows an offer's objectives before it is taken. The package is handed over on accepting. -->
      <p class="note mission-offered">This is the offer. Accept it in the conversation to be given the package.</p>
    {:else}
    <p class="controls">
      <button
        type="button"
        disabled={busy || briefing.cargoTypeID === null}
        onclick={() =>
          run(() =>
            flow.loadPackageIntoShip(
              briefing!.cargoTypeID as number,
              (briefing!.cargoQuantity ?? 1) as number,
            ),
          )}
      >
        Load package into ship
      </button>
      <button
        type="button"
        disabled={busy || briefing.destinationLocationID === null}
        onclick={() => run(() => flow.setAutopilotToDropoff(briefing!.destinationLocationID as number))}
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
</div>
{#if footer && conversationOwner !== null}
  {@const id = conversationOwner}
  <footer class="agent-conversation-footer" aria-label={agentName(id)}>
    {#each footer.actions as action (action.actionID)}
      {@const path = agentButtonWord(action.buttonType)}
      <button type="button" disabled={busy} onclick={() => run(() => flow.chooseAction(id, action))}>
        {plainText((path === null ? null : $words.templates[path]) ?? action.label)}
      </button>
    {/each}
    {#if footer.close}<button type="button" onclick={onConversationClose}>{plainText($words.templates[AGENT_CLOSE_LABEL] ?? "Close")}</button>{/if}
    {#if trackableMission && characterID !== null}
      {@const mission = trackableMission}
      <button type="button" aria-pressed={missionTracked} disabled={busy} onclick={() => toggleTrackedAgentMission(characterID, mission)}>
        {plainText($words.templates[trackLabel] ?? (missionTracked ? "Untrack" : "Track"))}
      </button>
    {/if}
  </footer>
{/if}
</div>
{/if}

{#if !standalone}
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
{/if}

<style>
  .agent-header { display: grid; grid-template-columns: 128px minmax(0, 1fr); align-items: start; gap: 12px; }
  .agent-header-name { display: flex; align-items: center; gap: 0.4rem; font-size: 18px; }
  .agent-header-info { display: inline-flex; padding: 0; border: 0; background: transparent; min-height: 0; }
  .agent-header-info img { width: 16px; height: 16px; }
  .agent-header-location, .agent-header-standing { margin-top: 0.65em; }
  .mission-objective-info { padding: 0; border: 0; min-height: 0; background: transparent; align-self: center; }
  .agent-briefing-choice { margin: 0.75em 0; }
  .agent-briefing-choice button {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--color-accent-bright, #a9d3f0);
    text-decoration: underline;
    text-align: left;
  }
  .agent-briefing-choice p { margin: 0.25em 0 0; white-space: pre-line; }
  .agent-conversation-frame { height: 100%; min-height: 0; display: flex; flex-direction: column; }
  .standalone-conversation { display: grid; grid-template-columns: minmax(0, 1fr); flex: 1; min-height: 0; }
  .standalone-conversation.double-pane { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .standalone-conversation > section { min-width: 0; min-height: 0; overflow: auto; padding: 0.8rem 1rem; }
  .standalone-conversation > section + section { border-left: 1px solid rgb(255 255 255 / 14%); }
  .agent-conversation-footer { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.45rem; padding: 0.55rem; border-top: 1px solid rgb(255 255 255 / 14%); }
</style>
