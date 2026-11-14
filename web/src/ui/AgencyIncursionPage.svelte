<script lang="ts">
  // agencyNew/ui/contentPages/contentPageIncursion.ContentPageIncursion (a SingleColumnContentPage, no filters): the left
  // column a Section (300, UI/Agency/ConstellationInfo): the aggressor's icon (64) beside the state's hint
  // (HINT_BY_INCURSION_STATE), Constellation-wide Penalties (TaleSystemEffectCont: the effects' icons), Pirate Influence
  // (SystemInfluenceBar, 10 high) and Current Accumulated Payout (UI/LPStore/AmountLP of the LP pool); under it the
  // Information section (ConstellationInfluence, AccumulatedPayout). The scroll section: the constellation's systems in
  // incursions (IncursionSystemContentCard: the system, its location, the bottom 40 high with the scene type's icon (32)
  // and name; the mothership icon on the Headquarters); and IncursionSystemInfoContainer (Sites in system: the scene
  // type's icon, name and hint; the sites, from the ballpark's slim items of the pilot's own system only -
  // SitePresenceUnknownHint where none; the system's primary button).
  // Not here (later parts): the sites' list in the pilot's own system (the ballpark's incursion sites), the aggressor's
  // logo, the tooltips.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { HINT_BY_INCURSION_STATE, INCURSION_STATES, SCENETYPE_DATA, SCENE_HEADQUARTERS, decayedInfluence } from "../bridge/incursion.ts";

  let { store, flow, constellationID }: { store: ClientStore; flow: AppFlow; constellationID: number } = $props();
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
  let data = $state<Awaited<ReturnType<AppFlow["agencyIncursion"]>> | undefined>(undefined);
  let chosen = $state<number | null>(null);
  $effect(() => { const c = constellationID; void flow.agencyIncursion(c).then((d) => { data = d; chosen = d?.systems[0]?.solarSystemID ?? null; }); });
  const system = $derived(data?.systems.find((s) => s.solarSystemID === chosen) ?? null);
  const H = "UI/Incursion/HUD/";
  $effect(() => {
    flow.requestWords(["UI/Agency/ConstellationInfo", `${H}ConstellationWidePenalties`, `${H}PirateInfluence`, `${H}CurrentAccumulatedPayout`, "UI/LPStore/AmountLP",
      "UI/Common/Information", "UI/Agency/ConstellationInfluence", "UI/Agency/AccumulatedPayout", "UI/Agency/ShowingXResults", "UI/Inflight/Scanner/FilteredResults",
      "UI/Agency/ContentInCurrentSystem", "UI/Agency/LocationAndNumJumps", "UI/Agency/Location", "UI/Common/NumJumps", "UI/Agency/SitesInSystem", `${H}SitePresenceUnknownHint`,
      `${H}InfluenceBarHint`, `${H}IncursionFinalEncounterReportHint`, `${H}NoIncursionFinalEncounterHint`, "UI/Neocom/UndockBtn", "UI/Inflight/SetDestination", "UI/Inflight/DestinationSet",
      ...Object.values(HINT_BY_INCURSION_STATE), ...Object.values(SCENETYPE_DATA).flatMap((d) => [d.hint, d.subTitle]), ...(data?.incursion.report.effects ?? []).map((e) => e.hint)]);
  });
  let nowMs = $state(Date.now());
  $effect(() => { const t = setInterval(() => { nowMs = Date.now(); }, 60000); return () => clearInterval(t); });
  const influence = $derived(data ? decayedInfluence(data.incursion.report.influence, nowMs) : 0);
  const stateColour = $derived(INCURSION_STATES.find((s) => s.state === data?.incursion.report.state)?.colour ?? "#ffffff");

  const hereStation = $derived($station.online?.stationID ?? null);
  const hereSystem = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  type Sys = NonNullable<typeof data>["systems"][number];
  const secText = (s: Sys) => (s.security === null ? "" : shownSecurity(s.security).toFixed(1));
  function locationText(s: Sys): string {
    if (s.solarSystemID === hereSystem) return `${word("UI/Agency/ContentInCurrentSystem")} ${secText(s)}`;
    return s.jumps !== null ? word("UI/Agency/LocationAndNumJumps", { location: s.solarSystemID, secStatus: secText(s), jumps: word("UI/Common/NumJumps", { numJumps: s.jumps }) })
      : word("UI/Agency/Location", { location: s.solarSystemID, secStatus: secText(s) });
  }
  type Action = "undock" | "setDestination" | "destinationSet" | null;
  const LABEL: Record<Exclude<Action, null>, string> = { undock: "UI/Neocom/UndockBtn", setDestination: "UI/Inflight/SetDestination", destinationSet: "UI/Inflight/DestinationSet" };
  function actionOf(s: Sys): Action {
    if (s.solarSystemID === hereSystem) return hereStation !== null ? "undock" : null;
    const last = $waypoints[$waypoints.length - 1];
    return last === s.solarSystemID ? "destinationSet" : "setDestination";
  }
  let busy = $state(false);
  async function act(s: Sys): Promise<void> {
    const action = actionOf(s);
    if (busy || action === null || action === "destinationSet") return;
    busy = true;
    try { if (action === "undock") await flow.undock(); else flow.setDestination(s.solarSystemID); } finally { busy = false; }
  }
</script>

<div class="aip">
  <aside class="aip-left">
    <section class="aip-section">
      <h3>{word("UI/Agency/ConstellationInfo")}</h3>
      {#if data}
        {@const r = data.incursion.report}
        <div class="aip-owner"><b>{r.aggressorFactionID ? resolvedName($names.resolved, "owner", r.aggressorFactionID, "") : ""}</b>
          <p>{word(HINT_BY_INCURSION_STATE[r.state] ?? "", { color: stateColour })}</p></div>
        <h4>{word(`${H}ConstellationWidePenalties`)}</h4>
        <div class="aip-effects">{#each r.effects as e (e.name)}<img alt="" title={word(e.hint)} style:opacity={e.isScalable && influence >= 1 ? 0.25 : 0.75} src={clientTexture(e.texturePath)} />{/each}</div>
        <h4>{word(`${H}PirateInfluence`)}</h4>
        <div class="aip-bar" title={word(`${H}InfluenceBarHint`, { influence: Math.round((1 - influence) * 100) })}>
          <span class="aip-blue" style:width={`${influence * 100}%`}></span><span class="aip-knob"></span><span class="aip-red"></span></div>
        <h4>{word(`${H}CurrentAccumulatedPayout`)}</h4>
        <p class="aip-lp">{word("UI/LPStore/AmountLP", { lpAmount: (data.lpPool ?? 0).toLocaleString("en-US") })}</p>
      {/if}
    </section>
    <section class="aip-section"><h3>{word("UI/Common/Information")}</h3>
      <p class="aip-info">ⓘ {word("UI/Agency/ConstellationInfluence")}</p><p class="aip-info">ⓘ {word("UI/Agency/AccumulatedPayout")}</p></section>
  </aside>
  <section class="aip-section aip-scroll">
    <h3>{data?.systems.length ? word("UI/Agency/ShowingXResults", { numResults: data.systems.length }) : data === undefined ? "…" : word("UI/Inflight/Scanner/FilteredResults")}</h3>
    <div class="aip-cards">
      {#each data?.systems ?? [] as s (s.solarSystemID)}
        {@const scene = s.sceneType !== null ? SCENETYPE_DATA[s.sceneType] : undefined}
        <button type="button" class="aip-card" class:on={chosen === s.solarSystemID} onclick={() => (chosen = s.solarSystemID)}>
          <b>{resolvedName($names.resolved, "system", s.solarSystemID, "")}</b>
          <span>{locationText(s)}</span>
          <span class="aip-scene">{#if scene?.severityIcon}<img alt="" src={clientTexture(scene.severityIcon)} />{/if}{scene ? word(scene.subTitle) : ""}</span>
          {#if s.sceneType === SCENE_HEADQUARTERS && data}
            <img class="aip-mothership" class:lit={data.incursion.report.hasFinalEncounter} alt=""
              title={word(`${H}${data.incursion.report.hasFinalEncounter ? "IncursionFinalEncounterReportHint" : "NoIncursionFinalEncounterHint"}`)}
              src={clientTexture("res:/UI/Texture/classes/Incursions/iconMothership.png")} />
          {/if}
        </button>
      {/each}
    </div>
  </section>
  <section class="aip-section aip-details">
    <h3>{word("UI/Agency/SitesInSystem")}</h3>
    {#if system}
      {@const scene = system.sceneType !== null ? SCENETYPE_DATA[system.sceneType] : undefined}
      {@const action = actionOf(system)}
      <div class="aip-scenehead">{#if scene?.severityIcon}<img alt="" src={clientTexture(scene.severityIcon)} />{/if}
        <span><b>{scene ? word(scene.subTitle) : ""}</b>{scene ? word(scene.hint) : ""}</span></div>
      <div class="aip-list"><p>{word(`${H}SitePresenceUnknownHint`)}</p></div>
      {#if action}<div class="aip-buttons"><button type="button" disabled={busy || action === "destinationSet"} onclick={() => void act(system)}>{word(LABEL[action])}</button></div>{/if}
    {/if}
  </section>
</div>

<style>
  .aip { display: flex; gap: 10px; justify-content: center; height: 100%; min-height: 0; }
  .aip-left { width: 300px; flex: none; display: flex; flex-direction: column; gap: 10px; }
  .aip-section { background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); padding: 8px 10px; }
  .aip-section h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
  .aip-section h4 { margin: 16px 0 4px; font-size: 12px; font-weight: 400; opacity: 0.7; }
  .aip-owner b { font-size: 14px; }
  .aip-owner p { margin: 4px 0 0; font-size: 12px; line-height: 1.35; }
  .aip-effects { display: flex; gap: 6px; }
  .aip-effects img { width: 22px; height: 22px; }
  .aip-bar { display: flex; height: 10px; margin-right: 4px; }
  .aip-blue { background: rgb(0 255 255 / 0.25); }
  .aip-knob { width: 1px; background: rgb(128 128 128); }
  .aip-red { flex: 1; background: rgb(255 0 0 / 0.25); }
  .aip-lp { margin: 0; font-size: 18px; }
  .aip-info { margin: 0 0 4px; font-size: 12px; opacity: 0.8; }
  .aip-scroll { width: 331px; flex: none; display: flex; flex-direction: column; min-height: 0; }
  .aip-cards { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding-right: 4px; }
  .aip-card { all: unset; box-sizing: border-box; cursor: pointer; position: relative; width: 300px; flex: none; display: flex; flex-direction: column; gap: 3px; padding: 6px 8px;
    font-size: 12px; background: rgb(255 255 255 / 0.04); border: 1px solid rgb(255 255 255 / 0.1); }
  .aip-card b { font-size: 14px; }
  .aip-card:hover { background: rgb(255 255 255 / 0.08); }
  .aip-card.on { border-color: rgb(255 255 255 / 0.6); background: rgb(255 255 255 / 0.1); }
  .aip-scene { display: flex; align-items: center; gap: 6px; height: 40px; margin-top: 4px; padding-left: 4px; background: rgb(0 0 0 / 0.3); }
  .aip-scene img { width: 32px; height: 32px; }
  .aip-mothership { position: absolute; top: 4px; right: 4px; width: 24px; height: 24px; opacity: 0.3; }
  .aip-mothership.lit { opacity: 1; }
  .aip-details { width: 400px; flex: none; overflow: auto; }
  .aip-scenehead { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; padding-left: 6px; font-size: 12px; }
  .aip-scenehead img { width: 32px; height: 32px; flex: none; }
  .aip-scenehead span { display: flex; flex-direction: column; gap: 2px; }
  .aip-list { height: 150px; overflow: auto; background: rgb(0 0 0 / 0.3); }
  .aip-list p { text-align: center; opacity: 0.6; font-size: 12px; padding: 0 12px; }
  .aip-buttons { display: flex; justify-content: flex-end; padding-top: 10px; }
</style>
