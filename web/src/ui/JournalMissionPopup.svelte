<script lang="ts">
  import { onDestroy } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { journalMessageMarkup, journalMessagePhrases, type JournalMissionDetails } from "../bridge/journalMission.ts";
  import { objectiveSystemIDs } from "../bridge/locationWrapper.ts";
  import { PANE_WORD_LABELS, objectivePane, paneMessageIDs, paneNameRefs } from "../bridge/missionObjectivePane.ts";
  import type { MissionMessage } from "../bridge/missionObjectives.ts";
  import { questionMarkup, wordsLabels, wordsNameRefs, type ClientWording } from "../bridge/questions.ts";
  import { sessionPlace } from "../bridge/sessionPlace.ts";
  import { dungeonBookmarkSystem, linkScheme, parseShowInfoUrl } from "../bridge/showInfoLink.ts";
  import { ContextMenu } from "../play/contextMenu.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName, type NameKind } from "../store/names.ts";
  import type { QuestionWords } from "../store/types.ts";
  import LabelText from "./LabelText.svelte";
  import TypeIcon from "./TypeIcon.svelte";
  import { LINK_WORDS, linkFollowerOf, startLinkDrag, type LinkFollower } from "./linkFollowers.ts";
  import { solarSystemMenu, solarSystemMenuWords } from "./solarSystemMenu.ts";
  import { portraitDefaultPath, portraitUrl } from "./ownerImages.ts";
  import { showInfo } from "./showInfo.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow, agentID, openSerial, onClose, onShowSystem }: {
    store: ClientStore; flow: AppFlow; agentID: number; openSerial: number; onClose: () => void;
    onShowSystem: (id: number) => void;
  } = $props();
  const agents = $derived(store.agents), names = $derived(store.names), words = $derived(store.words);
  const station = $derived(store.station), flight = $derived(store.flight);
  const notices = $derived(flow.journalMissionChanged);
  const logos = $derived(flow.ownerLogos), images = $derived(flow.imageServer);
  const place = $derived(sessionPlace($flight.status, $station.online));
  const docked = $derived(place.locationID !== null && place.locationID !== place.solarSystemID);
  const stationID = $derived(place.stationID);
  const bookmarkMenu = new ContextMenu();
  onDestroy(() => bookmarkMenu.close());
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
  const linkWord = (label: string) => word(label, LINK_WORDS[label] ?? "");
  function ownerImage(typeID: number, itemID: number): string | null {
    if (typeID === 1377) return portraitUrl($images, itemID, 32) ?? clientTexture(portraitDefaultPath(32));
    const path = typeID === 30 ? $logos?.factions[itemID] : $logos?.corporations[itemID];
    return path ? clientTexture(path) : null;
  }
  function followerOf(url: string, text: string): LinkFollower | null {
    const destination = linkScheme(url) === "showinfo" ? parseShowInfoUrl(url) : null;
    if (destination?.itemID != null && destination.itemID >= 60_000_000 && destination.itemID < 64_000_000) {
      const { typeID, itemID } = destination;
      return { kind: "showInfo", hint: linkWord("UI/Commands/ShowInfo"),
        follow: () => showInfo({ kind: "spaceObject", typeID, itemID }) };
    }
    const follower = linkFollowerOf(url, flow, null, linkWord, text);
    const system = docked ? dungeonBookmarkSystem(url) : null;
    if (system === null || follower === null) return follower;
    return { ...follower, contextMenu: event => {
      event.preventDefault();
      const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const pointer = event instanceof MouseEvent && (event.clientX !== 0 || event.clientY !== 0);
      bookmarkMenu.open(pointer ? event.clientX : bounds.left, pointer ? event.clientY : bounds.bottom,
        solarSystemMenu(store, flow, system, () => text, null, onShowSystem));
    } };
  }

  // The mission article uses HTML RGB colors. LabelText reads ARGB.
  function missionMarkup(text: string): string {
    return text.replace(/(<font\b[^<>]*?\bcolor\s*=\s*["']?)#([\da-f]{6})(?=["'\s>])/gi,
      (_, attr: string, color: string) => `${attr}0xff${color}`);
  }
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
    return typeof value === "string" ? value : value === null ? "" : questionMarkup(byNumber(value), nameOf, client) ?? "";
  }
  function messageWords(message: MissionMessage): QuestionWords {
    return { label: message.label, text: message.text, parameters: message.parameters, messageID: message.messageID ?? undefined };
  }
  function say(message: MissionMessage): string | null {
    if (message.text !== null) return message.text;
    const keywords = $agents.missionKeywords[`${agentID}:${message.contentID}`] ?? {};
    return journalMessageMarkup(messageWords(message), nameOf, { ...client, extra: { ...client.extra, ...keywords } });
  }
  const title = $derived(plainText(speak(detail?.name ?? null)));
  const briefing = $derived(speak(detail?.briefing ?? null));
  const expiry = $derived.by(() => {
    if (!detail?.expiration) return "";
    const path = detail.state === 0 || detail.state === 1 ? labels.offerExpiry : labels.missionExpiry;
    return plainText(formatTemplate($words.templates[path] ?? "", { expireTime: detail.expiration }, { nameOf }));
  });
  const blocks = $derived(detail ? objectivePane(detail.objectives, {
    templates: $words.templates, rich: true, nameOf, locationID: place.locationID,
    messageText: id => speak(id) || null, say,
    securityOf: id => $names.systemSecurity[id] ?? null,
    ownSecurityStatus: () => $station.ownSecurityStatus,
  }) : []);
  $effect(() => {
    flow.requestWords([...Object.values(labels), ...PANE_WORD_LABELS, ...Object.keys(LINK_WORDS), ...solarSystemMenuWords]);
    flow.requestAgentRecord(agentID);
    flow.loadOwnerLogos();
  });
  $effect(() => {
    if (!detail) return;
    const messages = [detail.name, detail.briefing, ...paneMessageIDs(detail.objectives)].filter((value): value is number => typeof value === "number" && value > 0);
    const dungeonMessages = detail.objectives.dungeons.flatMap(dungeon => dungeon.briefingMessage ? [dungeon.briefingMessage] : []);
    const phrases = [...messages.map(byNumber), ...dungeonMessages.flatMap(message => journalMessagePhrases(messageWords(message)))];
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
    <div class="briefing"><LabelText markup={missionMarkup(briefing)} {followerOf} /></div>
    {#if expiry}<p class="expiration">{expiry}</p>{/if}
    {#each blocks as block}
      {#if block.title}<h3 class={block.state ?? ""}>{plainText(block.title)}</h3>{/if}
      {#if block.text}
        <div class="objective-text" class:warning={block.kind === "warning"}>
          <div class:ended={!!block.outcome}><LabelText markup={missionMarkup(block.text)} {followerOf} /></div>
          {#if block.outcome}<LabelText markup={missionMarkup(block.outcome)} {followerOf} />{/if}
        </div>
      {/if}
      {#if block.rows.length}
        <ul>
          {#each block.rows as row}
            <li>
              {#if row.mark}<span aria-label={row.mark}>{marks[row.mark]}</span>{/if}
              {#if row.info}
                {@const url = `showinfo:${row.info.typeID}${row.info.itemID ? `//${row.info.itemID}` : ""}`}
                {@const name = row.info.itemID ? nameOf("owner", row.info.itemID) : nameOf("type", row.info.typeID)}
                {@const follower = followerOf(url, name)}
                {@const image = row.info.itemID ? ownerImage(row.info.typeID, row.info.itemID) : null}
                {#if follower}
                  <button class="objective-info" type="button" title={follower.hint}
                    aria-label={name ? `${follower.hint} — ${name}` : follower.hint} draggable="true"
                    onclick={follower.follow} ondragstart={event => startLinkDrag(event, url, name)}>
                    {#if image}<img src={image} width="32" height="32" alt="" />
                    {:else if row.info.itemID}<span aria-hidden="true">ⓘ</span>
                    {:else}<TypeIcon typeID={row.info.typeID} {name} size="md" />{/if}
                  </button>
                {/if}
              {/if}
              <div>
                {#if row.label}<strong>{plainText(row.label)}</strong>{/if}
                <LabelText markup={missionMarkup(row.text)} {followerOf} />
              </div>
            </li>
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
  p, .briefing, .objective-text { margin: 0.25rem 0 0.65rem; }
  .mission-art { display: block; max-width: 100%; margin: 0.65rem auto; }
  .expiration { opacity: 0.8; }
  .warning, .failed { color: #ee897d; }
  .complete { color: #83c478; }
  ul { margin: 0.35rem 0 0.75rem; padding: 0; list-style: none; }
  li { display: flex; gap: 0.35rem; align-items: center; margin: 0.25rem 0; }
  .ended { text-decoration: line-through; }
  .objective-info { padding: 0; border: 0; background: none; color: inherit; }
</style>
