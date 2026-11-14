<script lang="ts">
  // agencyNew/ui/contentPages/contentPageEpicArcs.ContentPageEpicArcs (a SingleColumnContentPage with no left column):
  // the scroll section's "Showing X results" and the arcs' cards (EpicArcContentCard: the faction's epic icon, 50, with
  // the progress gauge while started; the arc's name, the faction's name, the active agent's location and the state -
  // Unavailable in COLOR_UNAVAILABLE_HILIGHT, Available in COLOR_AVAILABLE_HILIGHT, EpicArcComplete with its time; the
  // standing badge where the arc cannot be started); and the chosen arc's EpicArcInfoContainer (450, 10 apart, "Epic
  // Arc"): the name (EveCaptionMedium), the flavor line at half opacity, NumMissionsCompleted, the chapters
  // (EpicArcChapters: the titles in order, the current one marked), and the primary button (as an agent's: Start
  // Conversation in the agent's station or where the arc cannot be started, else Undock / Dock / Set Destination).
  // Not here (later parts): the chapters' missions and texts, the scroll to the current chapter, the card animation.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, AgencyEpicArc } from "../app/flow.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { ARC_AVAILABLE, ARC_COMPLETE, ARC_STARTED, ARC_UNAVAILABLE, EPIC_ARC_LOOKS } from "../bridge/epicArcs.ts";

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
  const waypoints = flow.waypoints;

  const word = (label: string, args: TemplateArguments = {}) => plainText(formatTemplate($words.templates[label] ?? "", args, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  let arcs = $state<readonly AgencyEpicArc[] | null | undefined>(undefined);
  let chosen = $state<number | null>(null);
  $effect(() => { void flow.agencyEpicArcs().then((list) => { arcs = list; chosen = list?.[0]?.arc.epicArcID ?? null; }); });
  const chosenArc = $derived(arcs?.find((a) => a.arc.epicArcID === chosen) ?? null);
  $effect(() => {
    flow.requestWords(["UI/Agency/ShowingXResults", "UI/Inflight/Scanner/FilteredResults", "UI/Agency/ContentInCurrentStation", "UI/Agency/ContentInCurrentSystem",
      "UI/Agency/LocationAndNumJumps", "UI/Agency/Location", "UI/Common/NumJumps", "UI/Menusvc/MenuHints/Unavailable", "UI/Agency/EpicArcAvailable", "UI/Agency/EpicArcComplete",
      "UI/Agents/MissionTypes/EpicArc", "UI/Agency/NumMissionsCompleted", "UI/Commands/StartConversation", "UI/Neocom/UndockBtn", "UI/Inflight/DockInStation",
      "UI/Inflight/SetDestination", "UI/Inflight/DestinationSet",
      ...(arcs ?? []).flatMap((a) => [EPIC_ARC_LOOKS[a.arc.epicArcID]?.tagLine ?? null, ...[a.arc.nameID, ...a.arc.chapterIDs].map((x) => (x ? `#${x}` : null))]).filter((x): x is string => !!x)]);
  });

  /** epicArcAgentContentPiece.GetIconTexturePath, by the arc's faction. */
  const ICONS: Record<number, string> = { 500002: "MinmatarEpic", 500004: "GallenteEpic", 500001: "CaldariEpic", 500003: "AmarrEpic", 500016: "SOEEpic", 500010: "GuiristasEpic",
    500011: "AngelsEpic", 500014: "OREEpic", 500028: "AIREpic" };
  const icon = (factionID: number | null) => clientTexture(`res:/UI/Texture/Classes/Agency/Icons/ContentTypes/${factionID === null ? "AngelsEpic" : ICONS[factionID] ?? "AngelsEpic"}.png`);
  const hereStation = $derived($station.online?.stationID ?? null);
  const hereSystem = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const secText = (id: number) => { const s = $names.systemSecurity?.[id]; return typeof s === "number" ? shownSecurity(s).toFixed(1) : ""; };
  function locationText(a: AgencyEpicArc): string {
    if (a.solarSystemID === null) return "";
    if (a.stationID !== null && a.stationID === hereStation) return word("UI/Agency/ContentInCurrentStation");
    if (a.solarSystemID === hereSystem) return `${word("UI/Agency/ContentInCurrentSystem")} ${secText(a.solarSystemID)}`;
    return a.jumps !== null
      ? word("UI/Agency/LocationAndNumJumps", { location: a.solarSystemID, secStatus: secText(a.solarSystemID), jumps: word("UI/Common/NumJumps", { numJumps: a.jumps }) })
      : word("UI/Agency/Location", { location: a.solarSystemID, secStatus: secText(a.solarSystemID) });
  }
  /** GetEpicArcStateText. */
  function stateText(a: AgencyEpicArc): { text: string; colour: string | null } | null {
    if (a.arc.state === ARC_UNAVAILABLE) return { text: word("UI/Menusvc/MenuHints/Unavailable"), colour: "#ff454b" };
    if (a.arc.state === ARC_AVAILABLE) return { text: word("UI/Agency/EpicArcAvailable"), colour: "#8dc169" };
    if (a.arc.state === ARC_COMPLETE) return { text: word("UI/Agency/EpicArcComplete", { completeTime: { type: "long", value: String(BigInt(a.arc.completeTimeMs ?? 0) * 10000n + 116_444_736_000_000_000n) } }), colour: null };
    return null;
  }
  type Action = "talk" | "undock" | "dock" | "setDestination" | "destinationSet";
  const LABEL: Record<Action, string> = { talk: "UI/Commands/StartConversation", undock: "UI/Neocom/UndockBtn", dock: "UI/Inflight/DockInStation", setDestination: "UI/Inflight/SetDestination", destinationSet: "UI/Inflight/DestinationSet" };
  function actionOf(a: AgencyEpicArc): Action | null {
    if (a.arc.activeAgentID === null || a.solarSystemID === null) return null;
    if ((a.stationID !== null && a.stationID === hereStation) || a.arc.state === ARC_UNAVAILABLE) return "talk";
    if (a.solarSystemID === hereSystem) return hereStation !== null ? "undock" : "dock";
    const last = $waypoints[$waypoints.length - 1];
    return last !== undefined && (last === a.stationID || last === a.solarSystemID) ? "destinationSet" : "setDestination";
  }
  let busy = $state(false);
  async function act(a: AgencyEpicArc): Promise<void> {
    const action = actionOf(a);
    if (busy || action === null || action === "destinationSet") return;
    busy = true;
    try {
      if (action === "talk") await flow.openConversation(a.arc.activeAgentID!);
      else if (action === "undock") await flow.undock();
      else if (action === "dock" && a.stationID !== null) await flow.dockAt(a.stationID);
      else if (action === "setDestination") flow.setDestination(a.stationID ?? a.solarSystemID!);
    } finally { busy = false; }
  }
</script>

<div class="aea">
  <section class="aea-section aea-scroll">
    <h3>{arcs?.length ? word("UI/Agency/ShowingXResults", { numResults: arcs.length }) : arcs === undefined ? "…" : word("UI/Inflight/Scanner/FilteredResults")}</h3>
    <div class="aea-cards">
      {#each arcs ?? [] as a (a.arc.epicArcID)}
        {@const st = stateText(a)}
        <button type="button" class="aea-card" class:on={chosen === a.arc.epicArcID} onclick={() => (chosen = a.arc.epicArcID)}>
          <span class="aea-icon"><img alt="" src={icon(a.arc.factionID)} />
            {#if a.arc.state === ARC_STARTED}<i class="aea-gauge"><i style:width={`${(a.arc.missionsCompleted / Math.max(1, a.arc.missions)) * 100}%`}></i></i>{/if}</span>
          <span class="aea-text">
            <b>{a.arc.nameID ? word(`#${a.arc.nameID}`) : ""}</b>
            <span>{a.arc.factionID ? resolvedName($names.resolved, "owner", a.arc.factionID, "") : ""}</span>
            <small>{locationText(a)}{#if st}<br /><span style:color={st.colour}>{st.text}</span>{/if}</small>
          </span>
          {#if a.arc.state === ARC_UNAVAILABLE}<span class="aea-threshold"><img alt="" src={clientTexture("res:/UI/Texture/Shared/checkboxHalfChecked.png")} /></span>{/if}
        </button>
      {/each}
    </div>
  </section>
  {#if chosenArc}{@const a = chosenArc}{@const action = actionOf(a)}
    <section class="aea-section aea-details">
      <h3>{word("UI/Agents/MissionTypes/EpicArc")}</h3>
      <h2>{a.arc.nameID ? word(`#${a.arc.nameID}`) : ""}</h2>
      {#if EPIC_ARC_LOOKS[a.arc.epicArcID]}<p class="aea-flavor">{word(EPIC_ARC_LOOKS[a.arc.epicArcID]!.tagLine)}</p>{/if}
      <p class="aea-count">{word("UI/Agency/NumMissionsCompleted", { numCompleted: a.arc.missionsCompleted, numMissions: a.arc.missions })}</p>
      <ol class="aea-chapters">
        {#each a.arc.chapterIDs as id (id)}<li class:current={a.arc.state === ARC_STARTED && id === a.arc.currentChapterID}>{word(`#${id}`)}</li>{/each}
      </ol>
      {#if action}<div class="aea-buttons"><button type="button" disabled={busy || action === "destinationSet"} onclick={() => void act(a)}>{word(LABEL[action])}</button></div>{/if}
    </section>
  {/if}
</div>

<style>
  .aea { display: flex; gap: 10px; justify-content: center; height: 100%; min-height: 0; }
  .aea-section { background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); padding: 8px 10px; }
  .aea-section h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
  .aea-scroll { width: 331px; flex: none; display: flex; flex-direction: column; min-height: 0; }
  .aea-cards { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding-right: 4px; }
  .aea-card { all: unset; box-sizing: border-box; cursor: pointer; position: relative; width: 300px; min-height: 86px; flex: none; display: flex; gap: 8px; padding: 5px;
    background: rgb(255 255 255 / 0.04); border: 1px solid rgb(255 255 255 / 0.1); }
  .aea-card:hover { background: rgb(255 255 255 / 0.08); }
  .aea-card.on { border-color: rgb(255 255 255 / 0.6); background: rgb(255 255 255 / 0.1); }
  .aea-icon { position: relative; width: 76px; height: 76px; flex: none; display: flex; align-items: center; justify-content: center; }
  .aea-icon img { width: 50px; height: 50px; }
  .aea-gauge { position: absolute; left: 0; right: 0; bottom: 0; height: 7px; background: rgb(255 255 255 / 0.15); }
  .aea-gauge i { display: block; height: 100%; background: #fff; opacity: 0.8; }
  .aea-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; padding-right: 24px; font-size: 12px; }
  .aea-text b { font-size: 14px; }
  .aea-text small { margin-top: auto; opacity: 0.8; }
  .aea-threshold { position: absolute; right: 5px; bottom: 5px; width: 22px; height: 24px; display: flex; align-items: center; justify-content: center; background: rgb(153 31 36 / 0.5); }
  .aea-threshold img { width: 16px; height: 16px; }
  .aea-details { width: 450px; flex: none; display: flex; flex-direction: column; min-height: 0; }
  .aea-details h2 { margin: 0; font-size: 18px; font-weight: 400; }
  .aea-flavor { margin: 4px 0 0; font-size: 13px; opacity: 0.5; }
  .aea-count { margin: 4px 0 0; font-size: 13px; font-weight: 600; }
  .aea-chapters { flex: 1; min-height: 0; overflow: auto; margin: 4px 0 0; padding-left: 20px; font-size: 13px; }
  .aea-chapters li { padding: 3px 0; opacity: 0.75; }
  .aea-chapters li.current { opacity: 1; font-weight: 600; }
  .aea-buttons { display: flex; justify-content: flex-end; padding-top: 10px; }
</style>
