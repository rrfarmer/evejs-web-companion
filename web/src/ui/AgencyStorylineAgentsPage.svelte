<script lang="ts">
  // agencyNew/ui/contentPages/contentPageStorylineAgents.ContentPageStorylineAgents (a DoubleColumnContentPage with no
  // left column, its scroll section LAYOUT_CONTAINER_WIDTH / 2): the header (iconStorylineMissions_Large, 64, and
  // UI/Agency/StorylineAgentsHeaderText, 240 wide, 10 below), "Showing X results", the storyline agents' cards one under
  // another (StorylineAgentContentCard: the agent card, and 46 below it its mission's expiry - AgentContentPiece
  // .GetExpiryTimeText: the state, coloured, and agentUtil.GetMissionExpirationText(short=True)), and the chosen card's
  // primary button (an agent with a mission is available: Start Conversation in this station, else Undock / Dock /
  // Set Destination).
  // GetMissionStateText and GetMissionStateColor compare the expiry itself (not the time left) with nought, so a
  // mission's state reads Offered / Accepted / Failed in #e19722 / #6f9e39 whatever its time left.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { filetimeOf } from "../bridge/journalWords.ts";
  import { portraitUrl, portraitDefaultPath } from "./ownerImages.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import type { AgencyStorylineAgent } from "../bridge/agencyAgents.ts";

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

  const J = "UI/Journal/JournalWindow/Agents/";
  const word = (label: string, args: TemplateArguments = {}) => plainText(formatTemplate($words.templates[label] ?? "", args, { nameOf: (kind, id) => resolvedName($names.resolved, kind === "owner" && id >= 3_000_000 && id < 4_000_000 ? "agent" : kind, id, "") }));
  let agents = $state<readonly AgencyStorylineAgent[] | null | undefined>(undefined);
  let chosen = $state<number | null>(null);
  $effect(() => { void flow.agencyStorylineAgents().then((list) => { agents = list; chosen = list?.[0]?.agentID ?? null; }); });
  const chosenAgent = $derived(agents?.find((a) => a.agentID === chosen) ?? null);
  $effect(() => {
    flow.requestWords(["UI/Agency/StorylineAgentsHeaderText", "UI/Agency/ShowingXResults", "UI/Inflight/Scanner/FilteredResults", "UI/Agency/ContentInCurrentStation",
      "UI/Agency/ContentInCurrentSystem", "UI/Agency/LocationAndNumJumps", "UI/Agency/Location", "UI/Common/NumJumps", "UI/Agency/ExpiresIn", "UI/AgentFinder/AgentLevel",
      `${J}StateOffered`, `${J}StateAccepted`, `${J}StateFailed`, `${J}OfferDoesNotExpire`, `${J}OfferUndefinedExpiration`, `${J}OfferExpired`,
      `${J}MissionDoesNotExpire`, `${J}MissionUndefinedExpiration`, `${J}MissionExpired`,
      "UI/Commands/StartConversation", "UI/Neocom/UndockBtn", "UI/Inflight/DockInStation", "UI/Inflight/SetDestination", "UI/Inflight/DestinationSet"]);
  });
  // The expiry ticks (UpdateExpiryLabelThread, every 100 ms; here every second).
  let now = $state(filetimeOf(Date.now()));
  $effect(() => { const t = setInterval(() => { now = filetimeOf(Date.now()); }, 1000); return () => clearInterval(t); });
  /** GetMissionStateTextColored and GetMissionExpirationText(short=True). */
  function expiry(a: AgencyStorylineAgent): { state: string; colour: string; text: string } | null {
    const offered = a.missionState === 0 || a.missionState === 1, accepted = a.missionState === 2 || a.missionState === 3;
    if (!offered && !accepted) return null;
    const kind = offered ? "Offer" : "Mission";
    const raw = a.expirationTime !== null && /^-?\d+$/.test(a.expirationTime) ? BigInt(a.expirationTime) : null;
    const left = raw ? raw - now : raw;
    const text = left === 0n ? word(`${J}${kind}DoesNotExpire`) : left === null ? word(`${J}${kind}UndefinedExpiration`)
      : left > 0n ? word("UI/Agency/ExpiresIn", { remaining: { type: "long", value: left.toString() } as never }) : word(`${J}${kind}Expired`);
    const state = word(`${J}${a.missionState === 3 ? "StateFailed" : offered ? "StateOffered" : "StateAccepted"}`);
    return { state, colour: offered ? "#e19722" : "#6f9e39", text };
  }

  const hereStation = $derived($station.online?.stationID ?? null);
  const hereSystem = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const secText = (id: number) => { const s = $names.systemSecurity?.[id]; return typeof s === "number" ? shownSecurity(s).toFixed(1) : ""; };
  function locationText(a: AgencyStorylineAgent): string {
    if (a.stationID !== null && a.stationID === hereStation) return word("UI/Agency/ContentInCurrentStation");
    if (a.solarSystemID === hereSystem) return `${word("UI/Agency/ContentInCurrentSystem")} ${secText(a.solarSystemID)}`;
    return a.jumps !== null
      ? word("UI/Agency/LocationAndNumJumps", { location: a.solarSystemID, secStatus: secText(a.solarSystemID), jumps: word("UI/Common/NumJumps", { numJumps: a.jumps }) })
      : word("UI/Agency/Location", { location: a.solarSystemID, secStatus: secText(a.solarSystemID) });
  }
  type Action = "talk" | "undock" | "dock" | "setDestination" | "destinationSet";
  const LABEL: Record<Action, string> = { talk: "UI/Commands/StartConversation", undock: "UI/Neocom/UndockBtn", dock: "UI/Inflight/DockInStation", setDestination: "UI/Inflight/SetDestination", destinationSet: "UI/Inflight/DestinationSet" };
  function actionOf(a: AgencyStorylineAgent): Action {
    if (a.stationID !== null && a.stationID === hereStation) return "talk";
    if (a.solarSystemID === hereSystem) return hereStation !== null ? "undock" : "dock";
    const last = $waypoints[$waypoints.length - 1];
    return last !== undefined && (last === a.stationID || last === a.solarSystemID) ? "destinationSet" : "setDestination";
  }
  let busy = $state(false);
  async function act(a: AgencyStorylineAgent): Promise<void> {
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

<div class="asp">
  <section class="asp-section">
    <div class="asp-header"><img alt="" src={clientTexture("res:/UI/Texture/Classes/Agency/iconStorylineMissions_Large.png")} /><p>{word("UI/Agency/StorylineAgentsHeaderText")}</p></div>
    <h3>{agents?.length ? word("UI/Agency/ShowingXResults", { numResults: agents.length }) : agents === undefined ? "…" : word("UI/Inflight/Scanner/FilteredResults")}</h3>
    <div class="asp-cards">
      {#each agents ?? [] as a (a.agentID)}
        {@const e = expiry(a)}
        <div class="asp-item">
          <button type="button" class="asp-card" class:on={chosen === a.agentID} onclick={() => (chosen = a.agentID)} ondblclick={() => void flow.openConversation(a.agentID)}>
            <img class="asp-portrait" alt="" src={portraitUrl($imageServer, a.agentID, 76) ?? clientTexture(portraitDefaultPath(76))} />
            <span class="asp-text">
              <b>{resolvedName($names.resolved, "agent", a.agentID, "")}</b>
              <span>{locationText(a)}</span>
              <small>{a.corporationID ? resolvedName($names.resolved, "owner", a.corporationID, "") : ""}</small>
            </span>
            <span class="asp-level" title={word("UI/AgentFinder/AgentLevel")} style:background-image={`url("${clientTexture("res:/UI/Texture/classes/agency/agentLevelFrame.png")}")`}>{a.level}</span>
          </button>
          {#if e}<div class="asp-expiry"><span style:color={e.colour}>{e.state}</span> {e.text}</div>{/if}
        </div>
      {/each}
    </div>
    <div class="asp-buttons">
      {#if chosenAgent}{@const action = actionOf(chosenAgent)}
        <button type="button" disabled={busy || action === "destinationSet"} onclick={() => void act(chosenAgent)}>{word(LABEL[action])}</button>
      {/if}
    </div>
  </section>
</div>

<style>
  .asp { display: flex; justify-content: center; height: 100%; min-height: 0; }
  .asp-section { width: 330px; flex: none; display: flex; flex-direction: column; min-height: 0; background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); padding: 8px 10px; }
  .asp-section h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
  .asp-header { display: flex; gap: 10px; margin-bottom: 10px; }
  .asp-header img { width: 64px; height: 64px; flex: none; }
  .asp-header p { margin: 0; width: 240px; font-size: 12px; line-height: 1.35; }
  .asp-cards { flex: 1; min-height: 0; overflow: auto; }
  .asp-item { position: relative; padding-bottom: 46px; }
  .asp-card { all: unset; box-sizing: border-box; cursor: pointer; position: relative; width: 300px; height: 86px; display: flex; gap: 8px; padding: 5px; background: rgb(255 255 255 / 0.04); border: 1px solid rgb(255 255 255 / 0.1); }
  .asp-card:hover { background: rgb(255 255 255 / 0.08); }
  .asp-card.on { border-color: rgb(255 255 255 / 0.6); background: rgb(255 255 255 / 0.1); }
  .asp-portrait { width: 76px; height: 76px; flex: none; clip-path: polygon(0 0, 100% 0, 100% 100%, 12px 100%, 0 calc(100% - 12px)); }
  .asp-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; padding-right: 24px; font-size: 12px; }
  .asp-text b { font-size: 14px; }
  .asp-text b, .asp-text span, .asp-text small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .asp-text small { margin-top: auto; opacity: 0.7; }
  .asp-level { position: absolute; top: 1px; right: 5px; width: 22px; height: 32px; text-align: center; font-size: 15px; line-height: 26px; background-position: center; background-size: contain; background-repeat: no-repeat; }
  .asp-expiry { position: absolute; left: 0; width: 300px; bottom: 12px; text-align: center; font-size: 15px; }
  .asp-buttons { display: flex; justify-content: flex-end; height: 30px; padding-top: 10px; }
</style>
