<script lang="ts">
  // A mission's page as the client's job board shows it (jobboard features/agent_missions/page.AgentMissionPage over
  // bridge/missionPage.ts): the title and state, Start Conversation and Close, the time left, the important-mission
  // warning, the agent's and corporation's cards, the briefing, the objectives, collateral, granted items, the rewards
  // and the bonus (its timer), the reduced-rewards banner, the extra information. Shows store.agents.missionPage
  // (flow.openMissionDetails); in the Agents & Missions window (the journal's Read Details) and in the job board window
  // (an agent mission's card), where it has the board's Back.
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { MissionMessage } from "../bridge/missionObjectives.ts";
  import { questionMarkup, questionText, wordsNameRefs, type ClientWording } from "../bridge/questions.ts";
  import { sessionPlace } from "../bridge/sessionPlace.ts";
  import { objectiveSystemIDs } from "../bridge/locationWrapper.ts";
  import { PAGE_WORD_LABELS, missionPage, pageAgentToLocate, pageMessageIDs, pageNameRefs, pageSystemIDs, type MissionPage, type MissionPageInput, type PagePanel, type PageRewards, type PageSteps, type StepState } from "../bridge/missionPage.ts";
  import { filetimeOf } from "../bridge/journalWords.ts";
  import { showInfo } from "./showInfo.ts";

  let { store, flow, onBack }: { store: ClientStore; flow: AppFlow; onBack?: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const agents = store.agents;
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
  const place = $derived(sessionPlace($flight.status, $station.online));
  let busy = $state(false);
  let error = $state("");
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      error = isSessionLost(cause) ? "The live session ended (idle timeout or another client took over)." : panelErrorWords(cause);
    } finally {
      busy = false;
    }
  }
  const saysName = (kind: NameRef["kind"], id: number): string => resolvedName($names.resolved, kind, id, `${kind} ${id}`);
  const agentName = (agentID: number | null): string => resolvedName($names.resolved, "agent", agentID, "—");
  const hasWords = (key: string): boolean => typeof $words.templates[key] === "string";
  // The client's words name an agent as a character ({[character]agentID.name}); this page keeps agents' names under
  // their own kind.
  const isAgentID = (id: number): boolean => id >= 3_000_000 && id < 4_000_000;
  const nameWithAgents = (kind: NameRef["kind"], id: number): string => (kind === "owner" && isAgentID(id) ? agentName(id) : saysName(kind, id));
  // A place's name has its system's security rating before it (bridge/locationWrapper.ts).
  const securityOf = (solarSystemID: number): number | null => $names.systemSecurity[solarSystemID] ?? null;
  // And, where it is not low security, the outlaw's warning, by the pilot's own security status.
  const ownSecurityStatus = (): number | null => {
    const kept = $station.ownSecurityStatus;
    if (kept === null) flow.requestOwnSecurityStatus();
    return kept;
  };
  function close(): void { flow.closeMissionDetails(); onBack?.(); }

  // The mission's page, which the journal's "Read Details" opens: the client's job board's page of it
  // (bridge/missionPage.ts), in the client's words.
  const pageInput = $derived.by<MissionPageInput | null>(() => {
    const held = $agents.missionPage;
    return held === null ? null : {
      missionState: held.missionState,
      important: held.important,
      expirationTime: typeof held.expirationTime === "string" && /^-?\d+$/.test(held.expirationTime) ? BigInt(held.expirationTime) : null,
      missionTitleID: held.missionTitleID,
      missionTitle: held.missionTitle,
      objectives: held.objectives,
      record: held.record,
      acceptTime: typeof held.acceptTime === "string" && /^\d+$/.test(held.acceptTime) ? BigInt(held.acceptTime) : null,
      agent: $agents.agentRecords[held.agentID] ?? null,
      agentSolarSystemID: $agents.agentSolarSystems[held.agentID] ?? null,
      standings: $standings.char === null ? null : new Map($standings.char.map((row) => [row.fromID, row.standing])),
      skillLevel: $skills.skills === null ? null : ((levels) => (typeID: number) => levels.get(typeID) ?? 0)(new Map($skills.skills.map((skill) => [skill.typeID, skill.level]))),
    };
  });
  // Everything said about a mission is filled with the mission's keywords and then its agent's own IDs
  // (AgentMissionJob._message_arguments).
  function pageClient(agentID: number, contentID: number | null): ClientWording {
    const row = $agents.agents.find((agent) => agent.agentID === agentID) ?? null;
    return {
      templates: $words.templates,
      playerID: $station.online?.characterID ?? null,
      extra: {
        ...(((contentID === null ? null : $agents.missionKeywords[`${agentID}:${contentID}`]) ?? {}) as NonNullable<ClientWording["extra"]>),
        agentID,
        agentCorpID: row?.corporationID ?? undefined,
        agentStationID: row?.stationID ?? undefined,
        agentLocation: row?.stationID ?? undefined,
      },
    };
  }
  const byNumber = (messageID: number): { label: null; parameters: null; text: null; messageID: number } => ({ label: null, parameters: null, text: null, messageID });
  // The time left runs down while the page is on show. The clock hangs on whether a page is open and on
  // nothing else: anything else the agents' store is told would start its wait again, and it would never strike.
  let pageClock = $state(Date.now());
  const pageOpen = $derived($agents.missionPage !== null);
  $effect(() => {
    if (!pageOpen) {
      return;
    }
    pageClock = Date.now();
    // Each second, as the bonus's countdown counts seconds (TimerCont looks twice a second).
    const ticking = setInterval(() => { pageClock = Date.now(); }, 1_000);
    return () => clearInterval(ticking);
  });
  const pageShown = $derived.by<{ readonly agentID: number; readonly page: MissionPage } | null>(() => {
    const held = $agents.missionPage;
    if (held === null || pageInput === null) {
      return null;
    }
    const client = pageClient(held.agentID, held.contentID);
    const page = missionPage(pageInput, {
      templates: $words.templates,
      nameOf: nameWithAgents,
      locationID: place.locationID,
      stationID: place.stationID,
      solarSystemID: place.solarSystemID,
      now: filetimeOf(pageClock),
      // The mission's name is its message with nothing filled in.
      messageText: (messageID) => (hasWords(`#${messageID}`) ? questionText(byNumber(messageID), nameWithAgents, { templates: $words.templates }) : null),
      sayOfMission: (messageID) => questionMarkup(byNumber(messageID), nameWithAgents, client),
      say: (message) => message.text ?? questionMarkup({ label: message.label, parameters: message.parameters, text: null, messageID: message.messageID ?? undefined }, nameWithAgents, pageClient(held.agentID, message.contentID ?? held.contentID)),
      securityOf,
      ownSecurityStatus,
      // From where the pilot is now, by the autopilot's route.
      jumpsTo: (solarSystemID) => (place.solarSystemID === null ? undefined : $names.autopilotJumps[`${place.solarSystemID}:${solarSystemID}`]),
    });
    return { agentID: held.agentID, page };
  });
  $effect(() => {
    const held = $agents.missionPage;
    if (held === null || pageInput === null) {
      return;
    }
    const dungeons = (held.objectives?.dungeons ?? []).map((dungeon) => dungeon.briefingMessage).filter((message): message is MissionMessage => message !== null);
    const divisionNameID = pageInput.agent?.divisionNameID ?? null;
    const numbered = [...pageMessageIDs(held.record), ...(held.missionTitleID !== null && held.missionTitleID > 0 ? [held.missionTitleID] : []), ...(divisionNameID === null ? [] : [divisionNameID])];
    flow.requestWords([
      ...PAGE_WORD_LABELS,
      ...numbered.map((id) => `#${id}`),
      ...dungeons.map((message) => message.label ?? (message.messageID === null ? null : `#${message.messageID}`)).filter((key): key is string => key !== null),
    ]);
    for (const message of dungeons) {
      if (message.contentID !== null) {
        flow.requestMissionKeywords(held.agentID, message.contentID);
      }
    }
    // The names in the steps and the rewards, and those the mission's own text is filled with.
    const said = pageMessageIDs(held.record).map(byNumber);
    const refs = [{ kind: "agent" as const, id: held.agentID }, ...pageNameRefs(pageInput), ...wordsNameRefs(said, pageClient(held.agentID, held.contentID))]
      .map((ref) => (ref.kind === "owner" && isAgentID(ref.id) ? { kind: "agent" as const, id: ref.id } : ref));
    flow.requestNames(refs);
    // The banner about reduced rewards turns on where the agent is, which the client asks the server.
    const agentToLocate = pageAgentToLocate(pageInput);
    if (agentToLocate !== null) {
      flow.requestAgentSolarSystem(agentToLocate);
    }
    flow.requestSystemSecurity(pageSystemIDs(pageInput));
  });
  // How far each place is, from where the pilot is now. This hangs on the counts held as well as on the page:
  // when the autopilot's settings change the counts are forgotten, and nothing else would ask for them again
  // (seen live on 2026-10-09: the distances went blank and stayed so).
  const jumpsHeld = $derived($names.autopilotJumps);
  $effect(() => {
    void jumpsHeld;
    const held = $agents.missionPage;
    if (held !== null && held.objectives !== null && place.solarSystemID !== null) {
      flow.requestAutopilotJumps(place.solarSystemID, objectiveSystemIDs(held.objectives));
    }
  });
  const STEP_MARKS: Readonly<Record<StepState, readonly [string, string]>> = { done: ["✓", "done"], open: ["○", "not yet"], failed: ["✕", "failed"] };
</script>

{#snippet pageSteps(group: PageSteps)}
  {#if group.steps.length > 0}
    {#if group.briefing}
      <p class="mission-block-text mission-steps-briefing" style="white-space: pre-line">{group.briefing}</p>
    {/if}
    <ul class="mission-rows mission-steps">
      {#each group.steps as step}
        <li class="mission-step {step.kind}">
          <span class="mission-mark {step.state}" title={STEP_MARKS[step.state][1]}>{STEP_MARKS[step.state][0]}</span>
          {#if step.title}<span class="mission-row-label">{step.title}</span>{/if}
          {#if step.where}<span class="mission-step-where">{step.where}</span>{/if}
          {#if step.place && step.place.length > 0}
            <!-- LocationWrapper: the rating in its colour, the name a link to the place's information, the warning in red. -->
            <span class="mission-row-text mission-place">
              {#each step.place as run}
                {#if run.link}
                  {@const link = run.link}
                  <button type="button" class="linkish" onclick={() => showInfo({ kind: "spaceObject", itemID: link.itemID, typeID: link.typeID })}>{run.text}</button>
                {:else if run.color}
                  <span style:color={run.color}>{run.text}</span>
                {:else}
                  {run.text}
                {/if}
              {/each}
            </span>
          {:else}
            <span class="mission-row-text">{step.text}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

{#snippet pagePanel(kind: string, panel: PagePanel | null)}
  {#if panel}
    <div class="mission-page-panel {kind}">
      {#if panel.title}<h3 class="mission-block-title">{panel.title}</h3>{/if}
      {#if panel.text}<p class="note">{panel.text}</p>{/if}
      <p class="mission-page-panel-items">{panel.items}</p>
    </div>
  {/if}
{/snippet}

{#snippet pageRewards(kind: string, group: PageRewards | null)}
  {#if group}
    <div class="mission-page-rewards {kind}">
      {#if group.title}
        <h3 class="mission-block-title">
          {group.title}
          {#if group.timer}
            <!-- TimerCont: a gauge of the bonus's time left and the time, the bonus's line as its hint. -->
            <span class="mission-bonus-timer" class:expired={group.timer.expired} title={group.hint ?? undefined}>
              <span class="mission-bonus-gauge" style="--left: {group.timer.left}" aria-hidden="true"></span>
              {group.timer.text}
            </span>
          {/if}
        </h3>
      {/if}
      {#if group.hint && !group.timer}<p class="mission-block-text">{group.hint}</p>{/if}
      <ul class="mission-rows">
        {#each group.rewards as reward}
          <li><span class="mission-row-text">{reward}</span></li>
        {/each}
      </ul>
    </div>
  {/if}
{/snippet}

{#if pageShown}
  {@const page = pageShown.page}
  {@const pageAgentID = pageShown.agentID}
  <section class="mission-page">
    <h2 class="mission-page-title">
      {page.title ?? "Mission"}
      {#if page.state?.text}<span class="mission-page-state {page.state.kind}">{page.state.text}</span>{/if}
    </h2>
    <p class="controls">
      <button type="button" class="mission-page-talk" disabled={busy} onclick={() => run(() => flow.openConversation(pageAgentID))}>
        {page.talk ?? "Start conversation"}
      </button>
      <button type="button" class="link mission-page-close" onclick={close}>{onBack ? "Back" : "Close"}</button>
    </p>
    {#if $words.available === false}
      <p class="note mission-page-wordless">The mission's details are worded with the retail client's own text, which this server has no client to read from.</p>
    {/if}
    {#if page.expires}
      <p class="note mission-page-expires">{page.expires}</p>
    {/if}
    {#if page.important}
      <p class="note mission-warning">{page.important}</p>
    {/if}
    {#if page.agent}
      <div class="mission-page-cards">
        <div class="mission-page-card agent">
          {#if page.agent.level}<span class="mission-page-card-line">{page.agent.level}</span>{/if}
          <strong class="mission-page-card-name">{page.agent.name}</strong>
          {#if page.agent.division}<span class="mission-page-card-line minor">{page.agent.division}</span>{/if}
        </div>
        {#if page.corporation}
          <div class="mission-page-card corporation">
            {#if page.corporation.standing}<span class="mission-page-card-line standing" class:low={page.corporation.standingLow}>{page.corporation.standing}</span>{/if}
            <strong class="mission-page-card-name">{page.corporation.name}</strong>
            {#if page.corporation.faction}<span class="mission-page-card-line minor">{page.corporation.faction}</span>{/if}
          </div>
        {/if}
      </div>
    {/if}
    {#if page.briefing}
      {#if page.briefing.title}<h3 class="mission-block-title">{page.briefing.title}</h3>{/if}
      <p class="mission-block-text mission-page-briefing" style="white-space: pre-line">{page.briefing.text}</p>
    {/if}
    {#if page.objectives}
      {#if page.objectives.title}<h3 class="mission-block-title">{page.objectives.title}</h3>{/if}
      {@render pageSteps(page.objectives.general)}
      {@render pageSteps(page.objectives.extra)}
    {/if}
    {@render pagePanel("collateral", page.collateral)}
    {@render pagePanel("granted", page.granted)}
    {@render pageRewards("rewards", page.rewards)}
    {@render pageRewards("bonus", page.bonusRewards)}
    {#if page.reducedRewards}
      <p class="note mission-page-banner" role="note">{page.reducedRewards}</p>
    {/if}
    {#if page.extra}
      {#if page.extra.title}<h3 class="mission-block-title">{page.extra.title}</h3>{/if}
      <p class="mission-block-text mission-page-extra" style="white-space: pre-line">{page.extra.text}</p>
    {/if}
  </section>
{/if}
{#if error}<p class="error">{error}</p>{/if}
