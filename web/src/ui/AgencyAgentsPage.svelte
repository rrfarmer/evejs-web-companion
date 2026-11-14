<script lang="ts">
  // agencyNew/ui/contentPages/contentPageAgents.ContentPageAgents (a DoubleColumnContentPage) for the agent groups:
  // the left column (FILTER_CONTAINER_WIDTH 300) its filters (AgentsFiltersCont: the agent level, the location, the
  // security status, the "only show available agents" box, Reset All) over the Information section (the standings
  // system); the scroll section (660 wide) its "Showing X results" header, the agents' content cards (AgentContentCard
  // 300 x 86, two in a row, 16 apart and 12 between rows: the portrait, the agent's name, its location - in this
  // station, in this system and its security, or its system, security and jumps - its corporation, its level) and the
  // primary action button of the chosen card (AgentContentPiece._GetButtonState: Start Conversation where it is in
  // this station or the pilot cannot use it, Undock / Dock in this system, else Set Destination or Destination Set).
  // The first card is chosen as the page opens; double clicking a card starts the conversation.
  // The faction and corporation filters (with the pilot's standings), and the standing threshold badge where the
  // pilot cannot use the agent (its hint the standing the level asks for).
  // The Heraldry agents (group 71): ContentPageHeraldryAgents, a SingleColumnContentPage - no filters
  // (GetFilterContainerClass None), the cards one to a row in a scroll section scrollSectionWidth 400 wide, and beside it
  // (padLeft 10, 400 wide) a Section headed UI/Agency/MissionDetails - the HeraldryTitle caption, the HeraldryDescription
  // text and the chosen card's interaction button (StatefulButton), faded in over 0.3 s as a card is chosen.
  // Not here (later parts): the region distance, the activity and locator badges, the security's colour, the Omega overlay, the cards' enter animation, the filters kept with the
  // character's settings (here for the window's life).
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { portraitUrl, portraitDefaultPath } from "./ownerImages.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { ANY, DEFAULT_AGENT_FILTERS, DISTANCE, HIGHEST_AVAILABLE, SECURITY_FILTER, agentStandingThreshold, pythonRoundedText, type AgencyAgent, type AgencyAgentFilters } from "../bridge/agencyAgents.ts";

  let { store, flow, groupID, filters = $bindable(DEFAULT_AGENT_FILTERS) }: { store: ClientStore; flow: AppFlow; groupID: number; filters?: AgencyAgentFilters } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const imageServer = flow.imageServer;
  // svelte-ignore state_referenced_locally
  const waypoints = flow.waypoints;

  const word = (label: string, args: TemplateArguments = {}) => plainText(formatTemplate($words.templates[label] ?? "", args, { nameOf: (kind, id) => resolvedName($names.resolved, kind === "owner" && id >= 3_000_000 && id < 4_000_000 ? "agent" : kind, id, "") }));
  $effect(() => {
    flow.requestWords(["UI/Agency/ShowingXResults", "UI/Inflight/Scanner/FilteredResults", "UI/Agency/ContentInCurrentStation", "UI/Agency/ContentInCurrentSystem",
      "UI/Agency/LocationAndNumJumps", "UI/Agency/Location", "UI/Common/NumJumps", "UI/AgentFinder/AgentLevel", "UI/Agency/HighestAvailable", "UI/Agency/AnyLevel", "UI/Agency/LevelX",
      "UI/Common/Location", "UI/Generic/CurrentSystem", "UI/Common/WithinJumps", "UI/Agency/ContentOfAnyDistance", "Tooltips/CharacterSheet/SecurityStatus", "UI/Agency/AnySecurity",
      "UI/Common/HighSec", "UI/Common/LowSec", "UI/Common/NullSec", "UI/Agency/OnlyShowAvailableAgents", "UI/Calendar/CalendarWindow/Filters", "UI/Commands/ResetAll",
      "UI/Agency/resetAllPageFilters", "UI/Common/Information", "UI/Agency/StandingsSystem", "UI/Commands/StartConversation", "UI/Neocom/UndockBtn", "UI/Inflight/DockInStation",
      "UI/Inflight/SetDestination", "UI/Inflight/DestinationSet", "UI/AgentFinder/AgentLevel", "UI/Common/Faction", "UI/Agency/AnyFaction", "UI/Common/Corp",
      "UI/Agency/AnyCorp", "UI/Agents/UnavailableInsufficientStandings", "UI/Agency/FactionWarfare/MissionRewards", "UI/Agency/MissionDetails",
      "UI/Agency/Blurbs/HeraldryTitle", "UI/Agency/Blurbs/HeraldryDescription"]);
  });
  // AgentsFiltersCont.GetFactions / GetCorpComboOptions: "name <gray>round(standing, 2)</gray>", sorted by that label,
  // after the Any choice; the corporation combo shown once a faction is chosen, its choice reset to Any where the
  // faction has no such corporation.
  let owners = $state<Awaited<ReturnType<AppFlow["agencyAgentOwners"]>>>(null);
  $effect(() => { void flow.agencyAgentOwners().then((o) => { owners = o; }); });
  const ownerOptions = (list: readonly { id: number; standing: number }[] | undefined) =>
    (list ?? []).map((o) => ({ id: o.id, name: resolvedName($names.resolved, "owner", o.id, ""), standing: pythonRoundedText(o.standing) }))
      .sort((a, b) => (`${a.name} ${a.standing}` < `${b.name} ${b.standing}` ? -1 : `${a.name} ${a.standing}` > `${b.name} ${b.standing}` ? 1 : 0));
  // FactionalWarfareAgentsFiltersCont: the factions appConst.factionsEmpires (sorted by their labels), no corporation
  // combo, levels to GetMaxLevel 5 (1 to 4); its page's Information FactionWarfare/MissionRewards alone.
  const fw = $derived(groupID === 47);
  const heraldry = $derived(groupID === 71);
  const EMPIRES = [500003, 500001, 500004, 500002];
  const factionOptions = $derived(ownerOptions((owners?.factions ?? []).filter((f) => !fw || EMPIRES.includes(f.id))));
  const corpOptions = $derived(filters.factionID === ANY ? [] : ownerOptions(owners?.corporations[filters.factionID]));
  $effect(() => {
    if (filters.corporationID !== ANY && owners && !corpOptions.some((o) => o.id === filters.corporationID)) filters = { ...filters, corporationID: ANY };
  });

  let agents = $state<readonly AgencyAgent[] | null | undefined>(undefined);
  let chosen = $state<number | null>(null);
  let asked = 0;
  $effect(() => {
    const f = filters, g = groupID, n = ++asked;
    agents = undefined;
    void flow.agencyAgents(g, f).then((list) => { if (n !== asked) return; agents = list; chosen = list?.[0]?.agentID ?? null; });
  });
  const chosenAgent = $derived(agents?.find((a) => a.agentID === chosen) ?? null);

  const hereStation = $derived($station.online?.stationID ?? null);
  const hereSystem = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const secText = (a: AgencyAgent) => (a.security === null ? "" : shownSecurity(a.security).toFixed(1));
  /** GetSolarSystemAndSecurityAndNumJumpsText. */
  function locationText(a: AgencyAgent): string {
    if (a.stationID !== null && a.stationID === hereStation) return word("UI/Agency/ContentInCurrentStation");
    if (a.solarSystemID === hereSystem) return `${word("UI/Agency/ContentInCurrentSystem")} ${secText(a)}`;
    return a.jumps !== null
      ? word("UI/Agency/LocationAndNumJumps", { location: a.solarSystemID, secStatus: secText(a), jumps: word("UI/Common/NumJumps", { numJumps: a.jumps }) })
      : word("UI/Agency/Location", { location: a.solarSystemID, secStatus: secText(a) });
  }
  type Action = "talk" | "undock" | "dock" | "setDestination" | "destinationSet";
  const LABEL: Record<Action, string> = { talk: "UI/Commands/StartConversation", undock: "UI/Neocom/UndockBtn", dock: "UI/Inflight/DockInStation", setDestination: "UI/Inflight/SetDestination", destinationSet: "UI/Inflight/DestinationSet" };
  /** AgentContentPiece._GetButtonState and BaseContentPiece's. */
  function actionOf(a: AgencyAgent): Action {
    if ((a.stationID !== null && a.stationID === hereStation) || !a.canUse) return "talk";
    if (a.solarSystemID === hereSystem) return hereStation !== null ? "undock" : "dock";
    const last = $waypoints[$waypoints.length - 1];
    return last !== undefined && (last === a.stationID || last === a.solarSystemID) ? "destinationSet" : "setDestination";
  }
  let busy = $state(false);
  async function act(a: AgencyAgent): Promise<void> {
    const action = actionOf(a);
    if (busy || action === "destinationSet") return;
    busy = true;
    try {
      if (action === "talk") await flow.openConversation(a.agentID);
      else if (action === "undock") await flow.undock();
      else if (action === "dock" && a.stationID !== null) await flow.dockAt(a.stationID);
      else if (action === "setDestination") flow.setDestination(a.stationID ?? a.solarSystemID);
    } finally { busy = false; }
  }
  const set = (patch: Partial<AgencyAgentFilters>) => { filters = { ...filters, ...patch }; };
  const LEVELS = $derived(fw ? [HIGHEST_AVAILABLE, ANY, 1, 2, 3, 4] : [HIGHEST_AVAILABLE, ANY, 1, 2, 3, 4, 5]);
  const DISTANCES = [DISTANCE.currentSystem, DISTANCE.two, DISTANCE.five, DISTANCE.ten, DISTANCE.any];
  const levelLabel = (v: number) => (v === HIGHEST_AVAILABLE ? word("UI/Agency/HighestAvailable") : v === ANY ? word("UI/Agency/AnyLevel") : word("UI/Agency/LevelX", { level: v }));
  const distanceLabel = (v: number) => (v === DISTANCE.currentSystem ? word("UI/Generic/CurrentSystem") : v === DISTANCE.any ? word("UI/Agency/ContentOfAnyDistance") : word("UI/Common/WithinJumps", { numJumps: v }));
  const SECURITIES = [ANY, SECURITY_FILTER.high, SECURITY_FILTER.low, SECURITY_FILTER.nul];
  const securityLabel = (v: number) => word(v === ANY ? "UI/Agency/AnySecurity" : v === SECURITY_FILTER.high ? "UI/Common/HighSec" : v === SECURITY_FILTER.low ? "UI/Common/LowSec" : "UI/Common/NullSec");
</script>

<div class="aap">
  {#if !heraldry}
  <aside class="aap-left">
    <section class="aap-section">
      <h3>{word("UI/Calendar/CalendarWindow/Filters")}</h3>
      <label><span>{word("UI/AgentFinder/AgentLevel")}</span>
        <select value={filters.level} onchange={(e) => set({ level: Number(e.currentTarget.value) })}>{#each LEVELS as v (v)}<option value={v}>{levelLabel(v)}</option>{/each}</select></label>
      <label><span>{word("UI/Common/Location")}</span>
        <select value={filters.distance} onchange={(e) => set({ distance: Number(e.currentTarget.value) })}>{#each DISTANCES as v (v)}<option value={v}>{distanceLabel(v)}</option>{/each}</select></label>
      <label><span>{word("Tooltips/CharacterSheet/SecurityStatus")}</span>
        <select value={filters.security} onchange={(e) => set({ security: Number(e.currentTarget.value) })}>{#each SECURITIES as v (v)}<option value={v}>{securityLabel(v)}</option>{/each}</select></label>
      <label><span>{word("UI/Common/Faction")}</span>
        <select value={filters.factionID} onchange={(e) => set({ factionID: Number(e.currentTarget.value) })}><option value={ANY}>{word("UI/Agency/AnyFaction")}</option>
          {#each factionOptions as o (o.id)}<option value={o.id}>{o.name} {o.standing}</option>{/each}</select></label>
      {#if filters.factionID !== ANY && !fw}
        <label><span>{word("UI/Common/Corp")}</span>
          <select value={filters.corporationID} onchange={(e) => set({ corporationID: Number(e.currentTarget.value) })}><option value={ANY}>{word("UI/Agency/AnyCorp")}</option>
            {#each corpOptions as o (o.id)}<option value={o.id}>{o.name} {o.standing}</option>{/each}</select></label>
      {/if}
      <label class="aap-check"><span>{word("UI/Agency/OnlyShowAvailableAgents")}</span>
        <input type="checkbox" checked={filters.ignoreStandings} onchange={(e) => set({ ignoreStandings: e.currentTarget.checked })} /></label>
      <div class="aap-reset"><button type="button" title={word("UI/Agency/resetAllPageFilters")} onclick={() => (filters = DEFAULT_AGENT_FILTERS)}>{word("UI/Commands/ResetAll")}</button></div>
    </section>
    <section class="aap-section">
      <h3>{word("UI/Common/Information")}</h3>
      <p class="aap-info">ⓘ {word(fw ? "UI/Agency/FactionWarfare/MissionRewards" : "UI/Agency/StandingsSystem")}</p>
    </section>
  </aside>
  {/if}
  <section class="aap-scroll aap-section" class:single={heraldry}>
    <h3>{agents?.length ? word("UI/Agency/ShowingXResults", { numResults: agents.length }) : agents === undefined ? "…" : word("UI/Inflight/Scanner/FilteredResults")}</h3>
    <div class="aap-cards">
      {#each agents ?? [] as a (a.agentID)}
        <button type="button" class="aap-card" class:on={chosen === a.agentID} onclick={() => (chosen = a.agentID)} ondblclick={() => void flow.openConversation(a.agentID)}>
          <img class="aap-portrait" alt="" src={portraitUrl($imageServer, a.agentID, 76) ?? clientTexture(portraitDefaultPath(76))} />
          <span class="aap-text">
            <b>{resolvedName($names.resolved, "agent", a.agentID, "")}</b>
            <span class="aap-loc">{locationText(a)}</span>
            <small>{a.corporationID ? resolvedName($names.resolved, "owner", a.corporationID, "") : ""}</small>
          </span>
          {#if !a.canUse}
            <!-- StandingThresholdCont: where the agent is unavailable (IsAgentAvailable), its hint GetAgentUnavailableReason. -->
            <span class="aap-threshold" title={word("UI/Agents/UnavailableInsufficientStandings", { agent: a.agentID, requiredStanding: agentStandingThreshold(a.level) ?? 0, minStanding: -2.0 })}>
              <img alt="" src={clientTexture("res:/UI/Texture/Shared/checkboxHalfChecked.png")} /></span>
          {/if}
          <span class="aap-level" title={word("UI/AgentFinder/AgentLevel")} style:background-image={`url("${clientTexture("res:/UI/Texture/classes/agency/agentLevelFrame.png")}")`}>{a.level}</span>
        </button>
      {/each}
    </div>
    {#if !heraldry}
    <div class="aap-buttons">
      {#if chosenAgent}{@const action = actionOf(chosenAgent)}
        <button type="button" disabled={busy || action === "destinationSet"} onclick={() => void act(chosenAgent)}>{word(LABEL[action])}</button>
      {/if}
    </div>
    {/if}
  </section>
  {#if heraldry}
    <section class="aap-section aap-details" class:shown={!!chosenAgent}>
      <h3>{word("UI/Agency/MissionDetails")}</h3>
      <h2>{word("UI/Agency/Blurbs/HeraldryTitle")}</h2>
      <p>{word("UI/Agency/Blurbs/HeraldryDescription")}</p>
      <div class="aap-buttons">
        {#if chosenAgent}{@const action = actionOf(chosenAgent)}
          <button type="button" disabled={busy || action === "destinationSet"} onclick={() => void act(chosenAgent)}>{word(LABEL[action])}</button>
        {/if}
      </div>
    </section>
  {/if}
</div>

<style>
  .aap { display: flex; gap: 16px; justify-content: center; height: 100%; min-height: 0; }
  .aap-left { width: 300px; flex: none; display: flex; flex-direction: column; gap: 16px; }
  .aap-section { background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); padding: 8px 10px; }
  .aap-section h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
  .aap-section label { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; font-size: 12px; }
  .aap-section label span { opacity: 0.7; }
  .aap-check { flex-direction: row !important; justify-content: space-between; align-items: center; }
  .aap-reset { display: flex; justify-content: flex-end; }
  .aap-info { margin: 0; font-size: 12px; opacity: 0.8; }
  .aap-scroll { width: 660px; flex: none; display: flex; flex-direction: column; min-height: 0; }
  .aap-cards { flex: 1; min-height: 0; overflow: auto; display: flex; flex-wrap: wrap; gap: 12px 16px; align-content: flex-start; }
  .aap-card { all: unset; box-sizing: border-box; cursor: pointer; position: relative; width: 300px; height: 86px; display: flex; gap: 8px; padding: 5px; background: rgb(255 255 255 / 0.04); border: 1px solid rgb(255 255 255 / 0.1); }
  .aap-card:hover { background: rgb(255 255 255 / 0.08); }
  .aap-card.on { border-color: rgb(255 255 255 / 0.6); background: rgb(255 255 255 / 0.1); }
  .aap-portrait { width: 76px; height: 76px; flex: none; clip-path: polygon(0 0, 100% 0, 100% 100%, 12px 100%, 0 calc(100% - 12px)); }
  .aap-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; padding-right: 24px; font-size: 12px; }
  .aap-text b { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .aap-loc { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .aap-text small { margin-top: auto; opacity: 0.7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .aap-level { position: absolute; top: 1px; right: 5px; width: 22px; height: 32px; text-align: center; font-size: 15px; line-height: 26px;
    background-position: center; background-size: contain; background-repeat: no-repeat; }
  .aap-threshold { position: absolute; right: 5px; bottom: 5px; width: 22px; height: 24px; display: flex; align-items: center; justify-content: center; background: rgb(153 31 36 / 0.5); }
  .aap-threshold img { width: 16px; height: 16px; filter: brightness(0) saturate(100%) invert(30%) sepia(90%) saturate(3000%) hue-rotate(345deg); }
  .aap-buttons { display: flex; justify-content: flex-end; height: 30px; padding-top: 10px; }
  .aap-scroll.single { width: 400px; }
  .aap-scroll.single .aap-cards { flex-direction: column; flex-wrap: nowrap; }
  .aap-details { width: 400px; flex: none; align-self: flex-start; opacity: 0; transition: opacity 0.3s; }
  .aap-details.shown { opacity: 1; }
  .aap-details h2 { margin: 0; font-size: 18px; font-weight: 600; }
  .aap-details p { margin: 10px 0 0; font-size: 12px; line-height: 1.4; white-space: pre-line; }
</style>
