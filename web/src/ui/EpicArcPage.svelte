<script lang="ts">
  // jobboard features/epic_arcs/page.EpicArcPage (a JobPage): Back; the header (the feature's tag, the arc's name, the
  // faction as the subtitle); the tag line in italics (FLAVORLINES_BY_EPICARCID); while started, the progress gauge
  // with "completed/total" and UI/Agents/MissionsCompleted; the faction's logo and name; the chapters
  // (EpicArcChapters: the arc's chapter titles in order, the current one marked). The call to action (get_cta_buttons):
  // UI/Chat/StartConversationAgent with the active agent (agents.OpenDialogueWindow: the conversation, in the Agents window), and while started UI/Opportunities/ViewActiveEpicArcMission
  // (the active mission's page, opened by onViewMission). The top button opens the Agency's Epic Arcs group.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, EpicArcsRead } from "../app/flow.ts";
  import { ARC_STARTED, EPIC_ARC_LOOKS, type EpicArcView } from "../bridge/epicArcs.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { openAgencyGroup } from "./agencyRequests.ts";

  const EPIC_ARCS_GROUP = 33; // contentGroupConst.contentGroupEpicArcs
  let { store, flow, arc, featureTag, onBack, onViewMission, onTalk }: { store: ClientStore; flow: AppFlow; arc: EpicArcView; featureTag: EpicArcsRead["featureTag"]; onBack: () => void; onViewMission: (agentID: number) => void; onTalk: (agentID: number) => Promise<void> } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const look = $derived(EPIC_ARC_LOOKS[arc.epicArcID] ?? null);
  $effect(() => {
    flow.requestWords(["UI/Commands/Back", "UI/Agents/MissionsCompleted", "UI/Chat/StartConversationAgent", "UI/Opportunities/ViewActiveEpicArcMission", "UI/Opportunities/OpenAgency", ...(look ? [look.tagLine] : []),
      ...[arc.nameID, featureTag?.title ?? null, ...arc.chapterIDs].filter((x): x is number => x !== null).map((x) => `#${x}`)]);
  });
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (k, id) => resolvedName($names.resolved, k, id, "") }));
  const agencyLabel = $derived(word("UI/Opportunities/OpenAgency") || "Open Agency");
  const ratio = $derived(arc.missions ? arc.missionsCompleted / arc.missions : 0);
</script>

<div class="ep">
  <div class="ep-top">
    <button class="ep-ghost" onclick={onBack}>{word("UI/Commands/Back") || "Back"}</button>
    <button class="ep-ghost ep-agency" title={agencyLabel} aria-label={agencyLabel} onclick={() => openAgencyGroup(EPIC_ARCS_GROUP)}>
      <img alt="" src={clientTexture("res:/UI/Texture/eveicon/system_icons/open_window_16px.png")} />
    </button>
  </div>
  <header class="ep-head">
    {#if look}<img class="ep-bg" alt="" src={clientTexture(`res:/UI/Texture/classes/Opportunities/${look.background}.png`)} />{/if}
    <div class="ep-gradient"></div>
    <span class="ep-caption">{#if featureTag?.icon}<img alt="" src={clientTexture(featureTag.icon)} />{/if}{featureTag?.title ? word(`#${featureTag.title}`) : ""}</span>
    <h2>{arc.nameID ? word(`#${arc.nameID}`) : ""}</h2>
    {#if arc.factionID}<span class="ep-caption">{resolvedName($names.resolved, "owner", arc.factionID, "")}</span>{/if}
  </header>
  <div class="ep-cta">
    <!-- EpicArcJob.get_cta_buttons: while active the active mission first, then the conversation. -->
    {#if arc.state === ARC_STARTED && arc.activeAgentID}
      <button onclick={() => onViewMission(arc.activeAgentID!)}>
        <img alt="" src={clientTexture("res:/UI/Texture/eveicon/category_icons/agent_mission_16px.png")} />
        {word("UI/Opportunities/ViewActiveEpicArcMission")}
      </button>
    {/if}
    {#if arc.activeAgentID}
      <button onclick={() => void onTalk(arc.activeAgentID!)}>
        <img alt="" src={clientTexture("res:/UI/Texture/eveicon/control_icons/start_conversation_16px.png")} />
        {word("UI/Chat/StartConversationAgent")}
      </button>
    {/if}
  </div>
  {#if look}<p class="ep-tag">{word(look.tagLine)}</p>{/if}
  <div class="ep-row">
    {#if arc.state === ARC_STARTED}
      <div class="ep-progress"><span class="ep-gauge" style:--outer={`${ratio * 360}deg`}><span>{Math.floor(ratio * 100)}%</span></span>
        <div><b>{arc.missionsCompleted.toLocaleString("en-US")}/{arc.missions.toLocaleString("en-US")}</b><small>{word("UI/Agents/MissionsCompleted")}</small></div></div>
    {/if}
    {#if arc.factionID}<div class="ep-faction">{#if look}<img alt="" src={clientTexture(`res:/UI/Texture/eveicon/faction_logos/${look.logo}_64px.png`)} />{/if}<span>{resolvedName($names.resolved, "owner", arc.factionID, "")}</span></div>{/if}
  </div>
  {#if arc.chapterIDs.length}
    <ol class="ep-chapters">
      {#each arc.chapterIDs as id (id)}<li class:current={arc.state === ARC_STARTED && id === arc.currentChapterID}>{word(`#${id}`)}</li>{/each}
    </ol>
  {/if}
</div>

<style>
  .ep { display: flex; flex-direction: column; gap: 8px; }
  .ep-top { display: flex; justify-content: space-between; align-items: center; }
  .ep-agency { display: grid; place-items: center; padding: 2px; }
  .ep-agency img, .ep-cta img { width: 16px; height: 16px; }
  .ep-ghost { background: none; border: 1px solid rgba(255, 255, 255, 0.2); }
  .ep-head { position: relative; overflow: hidden; padding: 16px; min-height: 120px; background: #000; display: flex; flex-direction: column; justify-content: flex-end; gap: 4px; }
  .ep-bg { position: absolute; right: 0; top: 0; height: 100%; width: auto; pointer-events: none; }
  .ep-gradient { position: absolute; inset: 0; width: 60%; background: linear-gradient(to right, rgba(0, 0, 0, 0.9), rgba(0, 0, 0, 0)); }
  .ep-caption { position: relative; opacity: 0.8; display: flex; align-items: center; gap: 4px; }
  .ep-caption img { width: 16px; height: 16px; }
  .ep-head h2 { position: relative; margin: 0; font-size: 20px; }
  .ep-cta { display: flex; gap: 8px; }
  .ep-cta button { display: flex; align-items: center; gap: 6px; }
  .ep-tag { font-style: italic; margin: 12px 0; }
  .ep-row { display: flex; gap: 16px; align-items: center; }
  .ep-progress { flex: 1; display: flex; gap: 8px; align-items: center; }
  .ep-progress div { display: flex; flex-direction: column; }
  .ep-progress small { opacity: 0.65; }
  .ep-gauge { width: 64px; height: 64px; border-radius: 50%; background: conic-gradient(#4fd1c5 var(--outer), rgba(255, 255, 255, 0.1) 0); display: flex; align-items: center; justify-content: center; }
  .ep-gauge > span { width: 58px; height: 58px; border-radius: 50%; background: #111; display: flex; align-items: center; justify-content: center; }
  .ep-faction { flex: 1; display: flex; gap: 8px; align-items: center; }
  .ep-faction img { width: 64px; height: 64px; }
  .ep-chapters { margin: 12px 0; padding-left: 20px; }
  .ep-chapters li { opacity: 0.65; padding: 2px 0; }
  .ep-chapters li.current { opacity: 1; font-weight: bold; color: #e19722; }
</style>
