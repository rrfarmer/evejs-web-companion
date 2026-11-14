<script lang="ts">
  // agencyNew/ui/contentPages/contentPageCareerAgents.ContentPageCareerAgents (a SingleColumnContentPage): the scroll
  // section (CONTENTCARD_WIDTH + 31) its "Showing X results" header and the career agents' cards
  // (CareerAgentContentCard: the portrait, the division's name, the agent's name over its location, its corporation,
  // its career's 32 px icon at the right); and the Career Details section (400 wide, 10 apart): the chosen agent's
  // division name (EveCaptionMedium), its description, Recommended Skill Plan and RecommendedSkillPlanMsg with its
  // plan's name where the agent's race and division have one, and the primary action button (as the agent pages').
  // The first card chosen as the page opens; double clicking a card starts the conversation.
  // Not here (later parts): the plan's link opening the plan itself, the completed career agents
  // (GetCompletedCareerAgentIDs), the cards' enter animation.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { portraitUrl, portraitDefaultPath } from "./ownerImages.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { careerIcon } from "./skillPlanIcons.ts";
  import type { AgencyCareerAgent } from "../bridge/agencyAgents.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
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
  let agents = $state<readonly AgencyCareerAgent[] | null | undefined>(undefined);
  let chosen = $state<number | null>(null);
  $effect(() => { void flow.agencyCareerAgents().then((list) => { agents = list; chosen = list?.[0]?.agentID ?? null; }); });
  const chosenAgent = $derived(agents?.find((a) => a.agentID === chosen) ?? null);
  $effect(() => {
    flow.requestWords(["UI/Agency/ShowingXResults", "UI/Inflight/Scanner/FilteredResults", "UI/Agency/ContentInCurrentStation", "UI/Agency/ContentInCurrentSystem",
      "UI/Agency/LocationAndNumJumps", "UI/Agency/Location", "UI/Common/NumJumps", "UI/Agency/CareerDetails", "UI/SkillPlan/RecommendedSkillPlanTitle", "UI/SkillPlan/RecommendedSkillPlanMsg",
      "UI/Commands/StartConversation", "UI/Neocom/UndockBtn", "UI/Inflight/DockInStation", "UI/Inflight/SetDestination", "UI/Inflight/DestinationSet",
      ...(agents ?? []).flatMap((a) => [a.divisionNameID, a.divisionDescriptionID, a.planNameID]).filter((x): x is number => !!x).map((x) => `#${x}`)]);
  });

  const hereStation = $derived($station.online?.stationID ?? null);
  const hereSystem = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const secText = (id: number) => { const s = $names.systemSecurity?.[id]; return typeof s === "number" ? shownSecurity(s).toFixed(1) : ""; };
  /** GetSolarSystemAndSecurityAndNumJumpsText. */
  function locationText(a: AgencyCareerAgent): string {
    if (a.stationID !== null && a.stationID === hereStation) return word("UI/Agency/ContentInCurrentStation");
    if (a.solarSystemID === hereSystem) return `${word("UI/Agency/ContentInCurrentSystem")} ${secText(a.solarSystemID)}`;
    return a.jumps !== null
      ? word("UI/Agency/LocationAndNumJumps", { location: a.solarSystemID, secStatus: secText(a.solarSystemID), jumps: word("UI/Common/NumJumps", { numJumps: a.jumps }) })
      : word("UI/Agency/Location", { location: a.solarSystemID, secStatus: secText(a.solarSystemID) });
  }
  type Action = "talk" | "undock" | "dock" | "setDestination" | "destinationSet";
  const LABEL: Record<Action, string> = { talk: "UI/Commands/StartConversation", undock: "UI/Neocom/UndockBtn", dock: "UI/Inflight/DockInStation", setDestination: "UI/Inflight/SetDestination", destinationSet: "UI/Inflight/DestinationSet" };
  /** AgentContentPiece._GetButtonState (a career agent's level 1: always usable for its standings). */
  function actionOf(a: AgencyCareerAgent): Action {
    if (a.stationID !== null && a.stationID === hereStation) return "talk";
    if (a.solarSystemID === hereSystem) return hereStation !== null ? "undock" : "dock";
    const last = $waypoints[$waypoints.length - 1];
    return last !== undefined && (last === a.stationID || last === a.solarSystemID) ? "destinationSet" : "setDestination";
  }
  let busy = $state(false);
  async function act(a: AgencyCareerAgent): Promise<void> {
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
</script>

<div class="acp">
  <section class="acp-section acp-scroll">
    <h3>{agents?.length ? word("UI/Agency/ShowingXResults", { numResults: agents.length }) : agents === undefined ? "…" : word("UI/Inflight/Scanner/FilteredResults")}</h3>
    <div class="acp-cards">
      {#each agents ?? [] as a (a.agentID)}
        <button type="button" class="acp-card" class:on={chosen === a.agentID} onclick={() => (chosen = a.agentID)} ondblclick={() => void flow.openConversation(a.agentID)}>
          <img class="acp-portrait" alt="" src={portraitUrl($imageServer, a.agentID, 76) ?? clientTexture(portraitDefaultPath(76))} />
          <span class="acp-text">
            <b>{a.divisionNameID ? word(`#${a.divisionNameID}`) : ""}</b>
            <span>{resolvedName($names.resolved, "agent", a.agentID, "")}</span>
            <span>{locationText(a)}</span>
            <small>{a.corporationID ? resolvedName($names.resolved, "owner", a.corporationID, "") : ""}</small>
          </span>
          {#if a.careerPathID && careerIcon(a.careerPathID, 32)}<img class="acp-career" alt="" src={careerIcon(a.careerPathID, 32)} />{/if}
        </button>
      {/each}
    </div>
  </section>
  <section class="acp-section acp-details">
    <h3>{word("UI/Agency/CareerDetails")}</h3>
    {#if chosenAgent}{@const a = chosenAgent}{@const action = actionOf(a)}
      <h2>{a.divisionNameID ? word(`#${a.divisionNameID}`) : ""}</h2>
      <p>{a.divisionDescriptionID ? word(`#${a.divisionDescriptionID}`) : ""}</p>
      {#if a.planNameID}
        <h2 class="acp-plan">{word("UI/SkillPlan/RecommendedSkillPlanTitle")}</h2>
        <p>{word("UI/SkillPlan/RecommendedSkillPlanMsg", { skillPlanLink: word(`#${a.planNameID}`) })}</p>
      {/if}
      <div class="acp-buttons"><button type="button" disabled={busy || action === "destinationSet"} onclick={() => void act(a)}>{word(LABEL[action])}</button></div>
    {/if}
  </section>
</div>

<style>
  .acp { display: flex; gap: 10px; justify-content: center; height: 100%; min-height: 0; }
  .acp-section { background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); padding: 8px 10px; }
  .acp-section h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
  .acp-scroll { width: 331px; flex: none; display: flex; flex-direction: column; min-height: 0; }
  .acp-cards { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding-right: 4px; }
  .acp-card { all: unset; box-sizing: border-box; cursor: pointer; position: relative; width: 300px; height: 86px; flex: none; display: flex; gap: 8px; padding: 5px; background: rgb(255 255 255 / 0.04); border: 1px solid rgb(255 255 255 / 0.1); }
  .acp-card:hover { background: rgb(255 255 255 / 0.08); }
  .acp-card.on { border-color: rgb(255 255 255 / 0.6); background: rgb(255 255 255 / 0.1); }
  .acp-portrait { width: 76px; height: 76px; flex: none; clip-path: polygon(0 0, 100% 0, 100% 100%, 12px 100%, 0 calc(100% - 12px)); }
  .acp-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; font-size: 12px; }
  .acp-text b { font-size: 14px; }
  .acp-text b, .acp-text span, .acp-text small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .acp-text small { margin-top: auto; opacity: 0.7; }
  .acp-career { width: 32px; height: 32px; flex: none; opacity: 0.7; margin: 0 -2px 0 0; }
  .acp-details { width: 400px; flex: none; overflow: auto; }
  .acp-details h2 { margin: 0; font-size: 18px; font-weight: 400; }
  .acp-details .acp-plan { margin-top: 20px; }
  .acp-details p { margin: 10px 0 0; font-size: 13px; line-height: 1.4; }
  .acp-buttons { display: flex; justify-content: flex-end; padding: 10px 0; }
</style>
