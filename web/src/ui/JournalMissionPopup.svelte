<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { JournalMissionDetails } from "../bridge/journalMission.ts";
  import { objectiveSystemIDs } from "../bridge/locationWrapper.ts";
  import { PANE_WORD_LABELS, objectivePane, paneMessageIDs, paneNameRefs } from "../bridge/missionObjectivePane.ts";
  import type { MissionMessage } from "../bridge/missionObjectives.ts";
  import { questionText, wordsLabels, wordsNameRefs, type ClientWording } from "../bridge/questions.ts";
  import { sessionPlace } from "../bridge/sessionPlace.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName, type NameKind } from "../store/names.ts";
  import type { QuestionWords } from "../store/types.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow, agentID, openSerial, onClose }: {
    store: ClientStore; flow: AppFlow; agentID: number; openSerial: number; onClose: () => void;
  } = $props();
  const agents = $derived(store.agents), names = $derived(store.names), words = $derived(store.words);
  const station = $derived(store.station), flight = $derived(store.flight);
  const notices = $derived(flow.journalMissionChanged);
  const place = $derived(sessionPlace($flight.status, $station.online));
  const stationID = $derived(place.stationID);
  const labels = {
    briefing: "UI/Agents/StandardMission/MissionBriefing",
    offerExpiry: "UI/Agents/Dialogue/ThisOfferExpiresAt",
    missionExpiry: "UI/Agents/Dialogue/ThisMissionExpiresAt",
  } as const;
  const closeActions = new Set(["reset", "declined", "completed", "quit", "failed", "offered", "offer_removed"]);
  const marks = { done: "✓", open: "○", failed: "✕" };
  let detail = $state.raw<JournalMissionDetails | null>(null);
  let failure = $state("");
  let revision = $state(0);

  $effect(() => {
    const source = notices;
    let previous = source.get();
    return source.subscribe(change => {
      if (change === previous) return;
      previous = change;
      if (!change || change.agentID !== agentID) return;
      if (closeActions.has(change.action)) onClose();
      else revision++;
    });
  });
  $effect(() => {
    const id = agentID, read = flow;
    void openSerial;
    void revision;
    void stationID;
    let current = true;
    failure = "";
    void read.loadJournalMission(id).then(value => {
      if (!current) return;
      if (value === null) onClose();
      else detail = value;
    }).catch(error => {
      if (current) failure = error instanceof Error ? error.message : String(error);
    });
    return () => { current = false; };
  });

  function nameOf(kind: NameKind, id: number): string {
    const actual = kind === "owner" && id >= 3_000_000 && id < 4_000_000 ? "agent" : kind;
    return resolvedName($names.resolved, actual, id, "");
  }
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? fallback);
  const client = $derived.by<ClientWording>(() => {
    const record = $agents.agentRecords[agentID];
    return {
      templates: $words.templates,
      playerID: $station.online?.characterID ?? null,
      extra: {
        ...($agents.missionKeywords[`${agentID}:${detail?.contentID}`] ?? {}) as ClientWording["extra"],
        agentID, agentCorpID: record?.corporationID ?? undefined,
        agentStationID: record?.stationID ?? undefined, agentLocation: record?.stationID ?? undefined,
      },
    };
  });
  function byNumber(messageID: number): QuestionWords {
    return { label: null, parameters: null, text: null, messageID };
  }
  function speak(value: string | number | null): string {
    return typeof value === "string" ? plainText(value)
      : value === null || typeof $words.templates[`#${value}`] !== "string" ? "" : questionText(byNumber(value), nameOf, client);
  }
  function messageWords(message: MissionMessage): QuestionWords {
    return { label: message.label, text: message.text, parameters: message.parameters, messageID: message.messageID ?? undefined };
  }
  function say(message: MissionMessage): string | null {
    if (message.text !== null) return plainText(message.text);
    const phrase = messageWords(message);
    if (!wordsLabels([phrase]).some(key => typeof $words.templates[key] === "string")) return null;
    const keywords = $agents.missionKeywords[`${agentID}:${message.contentID}`] ?? {};
    return questionText(phrase, nameOf, { ...client, extra: { ...client.extra, ...keywords } });
  }
  const title = $derived(speak(detail?.name ?? null));
  const briefing = $derived(speak(detail?.briefing ?? null));
  const expiry = $derived.by(() => {
    if (!detail?.expiration) return "";
    const path = detail.state === 0 || detail.state === 1 ? labels.offerExpiry : labels.missionExpiry;
    return plainText(formatTemplate($words.templates[path] ?? "", { expireTime: detail.expiration }, { nameOf }));
  });
  const blocks = $derived(detail ? objectivePane(detail.objectives, {
    templates: $words.templates, nameOf, locationID: place.locationID,
    messageText: id => speak(id) || null, say,
    securityOf: id => $names.systemSecurity[id] ?? null,
    ownSecurityStatus: () => $station.ownSecurityStatus,
  }) : []);
  $effect(() => {
    flow.requestWords([...Object.values(labels), ...PANE_WORD_LABELS]);
    flow.requestAgentRecord(agentID);
  });
  $effect(() => {
    if (!detail) return;
    const messages = [detail.name, detail.briefing, ...paneMessageIDs(detail.objectives)].filter((value): value is number => typeof value === "number" && value > 0);
    const dungeonMessages = detail.objectives.dungeons.flatMap(dungeon => dungeon.briefingMessage ? [dungeon.briefingMessage] : []);
    const phrases = [...messages.map(byNumber), ...dungeonMessages.map(messageWords)];
    flow.requestWords(wordsLabels(phrases));
    for (const { contentID } of dungeonMessages) if (contentID !== null) flow.requestMissionKeywords(agentID, contentID);
    const references = wordsNameRefs(phrases, client);
    flow.requestNames([...paneNameRefs(detail.objectives), ...references]);
    flow.requestSystemSecurity(objectiveSystemIDs(detail.objectives));
  });
</script>

<article class="mission-journal-details" data-journal-agent={agentID}>
  {#if failure}
    <p role="alert">{failure} <button type="button" onclick={() => revision++}>Retry</button></p>
  {:else if !detail}
    <p role="status">Loading mission details…</p>
  {:else}
    <h2>{title}</h2>
    <hr />
    {#if detail.image}<img class="mission-art" src={clientTexture(detail.image)} alt="" />{/if}
    <h3>{word(labels.briefing, "Mission Briefing")}</h3>
    <p class="briefing">{briefing}</p>
    {#if expiry}<p class="expiration">{expiry}</p>{/if}
    {#each blocks as block}
      {#if block.title}<h3 class={block.state ?? ""}>{block.title}</h3>{/if}
      {#if block.text}<p class:warning={block.kind === "warning"}>{block.text} {block.outcome ?? ""}</p>{/if}
      {#if block.rows.length}
        <ul>
          {#each block.rows as row}
            <li>{#if row.mark}<span aria-label={row.mark}>{marks[row.mark]}</span>{/if}
              {#if row.label}<strong>{row.label}</strong>{/if} {row.text}</li>
          {/each}
        </ul>
      {/if}
    {/each}
  {/if}
</article>

<style>
  article { padding: 0.85rem 1rem; }
  h2 { margin: 0; font-size: 1.1rem; }
  h3 { margin: 0.85rem 0 0.2rem; font-size: 0.95rem; }
  p { margin: 0.25rem 0 0.65rem; white-space: pre-line; }
  .mission-art { display: block; max-width: 100%; margin: 0.65rem auto; }
  .expiration { opacity: 0.8; }
  .warning, .failed { color: #ee897d; }
  .complete { color: #83c478; }
  ul { margin: 0.35rem 0 0.75rem; padding: 0; list-style: none; }
  li { margin: 0.25rem 0; }
  li > span { margin-right: 0.35rem; }
</style>
