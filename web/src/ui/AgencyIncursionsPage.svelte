<script lang="ts">
  // agencyNew/ui/contentPages/contentPageIncursions.ContentPageIncursions (a DoubleColumnContentPage): the left column its
  // filters (BaseFiltersCont: the location and the security status, Reset All) over the Information section
  // (IncursionMechanics, IncursionRewards); the scroll section's "Showing X results" and the incursions' cards
  // (IncursionContentCard 300 x 86, two in a row: the constellation's name, the staging system's location; the state
  // strip - IncursionStateCont, the three states' 17 x 8 bars 3 apart, the active one in its colour, the others
  // INACTIVE_STATE's, its name in its colour at 65 - and the SystemInfluenceBar, 8 high; the mothership icon at the top
  // right, lit where the final encounter has spawned). Its button row is hidden.
  // A card opens the incursion's own page (OnCardSelected: on_content_group_selected(contentGroupIncursion, its
  // constellation)). Not here (later parts): the chat button, the tooltips.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, AgencyIncursion } from "../app/flow.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { DISTANCE, ANY, SECURITY_FILTER } from "../bridge/agencyAgents.ts";
  import { DEFAULT_SITE_FILTERS, type AgencySiteFilters } from "../bridge/agencySites.ts";
  import { INACTIVE_STATE_COLOUR, INCURSION_STATES, decayedInfluence } from "../bridge/incursion.ts";

  let { store, flow, filters = $bindable(DEFAULT_SITE_FILTERS), onOpen }: { store: ClientStore; flow: AppFlow; filters?: AgencySiteFilters; onOpen?: (constellationID: number) => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;

  const word = (label: string, args: TemplateArguments = {}) => plainText(formatTemplate($words.templates[label] ?? "", args, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  let incursions = $state<readonly AgencyIncursion[] | null | undefined>(undefined);
  let chosen = $state<number | null>(null);
  let asked = 0;
  $effect(() => {
    const f = filters, n = ++asked;
    incursions = undefined;
    void flow.agencyIncursions(f).then((list) => { if (n !== asked) return; incursions = list; chosen = list?.[0]?.report.taleID ?? null; });
  });
  $effect(() => {
    flow.requestWords(["UI/Agency/ShowingXResults", "UI/Inflight/Scanner/FilteredResults", "UI/Agency/ContentInCurrentSystem", "UI/Agency/LocationAndNumJumps", "UI/Agency/Location",
      "UI/Common/NumJumps", "UI/Common/Location", "UI/Generic/CurrentSystem", "UI/Common/WithinJumps", "UI/Agency/ContentOfAnyDistance", "Tooltips/CharacterSheet/SecurityStatus",
      "UI/Agency/AnySecurity", "UI/Common/HighSec", "UI/Common/LowSec", "UI/Common/NullSec", "UI/Calendar/CalendarWindow/Filters", "UI/Commands/ResetAll", "UI/Agency/resetAllPageFilters",
      "UI/Common/Information", "UI/Agency/IncursionMechanics", "UI/Agency/Tooltips/Encounters/Incursions/IncursionRewards", "UI/Incursion/HUD/InfluenceBarHint",
      "UI/Incursion/HUD/IncursionFinalEncounterReportHint", "UI/Incursion/HUD/NoIncursionFinalEncounterHint", ...INCURSION_STATES.map((s) => s.name)]);
  });
  // The influence decays as time goes (CalculateDecayedInfluence): read again each minute, as the info panel does.
  let nowMs = $state(Date.now());
  $effect(() => { const t = setInterval(() => { nowMs = Date.now(); }, 60000); return () => clearInterval(t); });

  const hereSystem = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const secText = (i: AgencyIncursion) => (i.security === null ? "" : shownSecurity(i.security).toFixed(1));
  function locationText(i: AgencyIncursion): string {
    const id = i.report.stagingSolarSystemID;
    if (id === hereSystem) return `${word("UI/Agency/ContentInCurrentSystem")} ${secText(i)}`;
    return i.jumps !== null ? word("UI/Agency/LocationAndNumJumps", { location: id, secStatus: secText(i), jumps: word("UI/Common/NumJumps", { numJumps: i.jumps }) })
      : word("UI/Agency/Location", { location: id, secStatus: secText(i) });
  }
  const set = (patch: Partial<AgencySiteFilters>) => { filters = { ...filters, ...patch }; };
  const DISTANCES = [DISTANCE.currentSystem, DISTANCE.two, DISTANCE.five, DISTANCE.ten, DISTANCE.any];
  const distanceLabel = (v: number) => (v === DISTANCE.currentSystem ? word("UI/Generic/CurrentSystem") : v === DISTANCE.any ? word("UI/Agency/ContentOfAnyDistance") : word("UI/Common/WithinJumps", { numJumps: v }));
  const SECURITIES = [ANY, SECURITY_FILTER.high, SECURITY_FILTER.low, SECURITY_FILTER.nul];
  const securityLabel = (v: number) => word(v === ANY ? "UI/Agency/AnySecurity" : v === SECURITY_FILTER.high ? "UI/Common/HighSec" : v === SECURITY_FILTER.low ? "UI/Common/LowSec" : "UI/Common/NullSec");
</script>

<div class="ain">
  <aside class="ain-left">
    <section class="ain-section">
      <h3>{word("UI/Calendar/CalendarWindow/Filters")}</h3>
      <label><span>{word("UI/Common/Location")}</span>
        <select value={filters.distance} onchange={(e) => set({ distance: Number(e.currentTarget.value) })}>{#each DISTANCES as v (v)}<option value={v}>{distanceLabel(v)}</option>{/each}</select></label>
      <label><span>{word("Tooltips/CharacterSheet/SecurityStatus")}</span>
        <select value={filters.security} onchange={(e) => set({ security: Number(e.currentTarget.value) })}>{#each SECURITIES as v (v)}<option value={v}>{securityLabel(v)}</option>{/each}</select></label>
      <div class="ain-reset"><button type="button" title={word("UI/Agency/resetAllPageFilters")} onclick={() => (filters = DEFAULT_SITE_FILTERS)}>{word("UI/Commands/ResetAll")}</button></div>
    </section>
    <section class="ain-section"><h3>{word("UI/Common/Information")}</h3>
      <p class="ain-info">ⓘ {word("UI/Agency/IncursionMechanics")}</p><p class="ain-info">ⓘ {word("UI/Agency/Tooltips/Encounters/Incursions/IncursionRewards")}</p></section>
  </aside>
  <section class="ain-section ain-scroll">
    <h3>{incursions?.length ? word("UI/Agency/ShowingXResults", { numResults: incursions.length }) : incursions === undefined ? "…" : word("UI/Inflight/Scanner/FilteredResults")}</h3>
    <div class="ain-cards">
      {#each incursions ?? [] as i (i.report.taleID)}
        {@const influence = decayedInfluence(i.report.influence, nowMs)}
        {@const active = INCURSION_STATES.find((s) => s.state === i.report.state)}
        <button type="button" class="ain-card" class:on={chosen === i.report.taleID} onclick={() => { chosen = i.report.taleID; if (i.constellationID) onOpen?.(i.constellationID); }}>
          <b>{i.constellationID ? resolvedName($names.resolved, "constellation", i.constellationID, "") : ""}</b>
          <span>{locationText(i)}</span>
          <span class="ain-states">
            {#each INCURSION_STATES as s (s.state)}<i title={word(s.name)} style:background={s.state === i.report.state ? s.colour : INACTIVE_STATE_COLOUR}></i>{/each}
            {#if active}<em style:color={active.colour}>{word(active.name)}</em>{/if}
          </span>
          <span class="ain-bar" title={word("UI/Incursion/HUD/InfluenceBarHint", { influence: Math.round((1 - influence) * 100) })}>
            <span class="ain-blue" style:width={`${influence * 100}%`}></span><span class="ain-knob"></span><span class="ain-red"></span></span>
          <img class="ain-mothership" class:lit={i.report.hasFinalEncounter} alt=""
            title={word(i.report.hasFinalEncounter ? "UI/Incursion/HUD/IncursionFinalEncounterReportHint" : "UI/Incursion/HUD/NoIncursionFinalEncounterHint")}
            src={clientTexture("res:/UI/Texture/classes/Incursions/iconMothership.png")} />
        </button>
      {/each}
    </div>
  </section>
</div>

<style>
  .ain { display: flex; gap: 16px; justify-content: center; height: 100%; min-height: 0; }
  .ain-left { width: 300px; flex: none; display: flex; flex-direction: column; gap: 16px; }
  .ain-section { background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); padding: 8px 10px; }
  .ain-section h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
  .ain-section label { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; font-size: 12px; }
  .ain-section label span { opacity: 0.7; }
  .ain-reset { display: flex; justify-content: flex-end; }
  .ain-info { margin: 0 0 4px; font-size: 12px; opacity: 0.8; }
  .ain-scroll { width: 660px; flex: none; display: flex; flex-direction: column; min-height: 0; }
  .ain-cards { flex: 1; min-height: 0; overflow: auto; display: flex; flex-wrap: wrap; gap: 12px 16px; align-content: flex-start; }
  .ain-card { all: unset; box-sizing: border-box; cursor: pointer; position: relative; width: 300px; height: 86px; display: flex; flex-direction: column; gap: 3px; padding: 6px 8px;
    font-size: 12px; background: rgb(255 255 255 / 0.04); border: 1px solid rgb(255 255 255 / 0.1); }
  .ain-card b { font-size: 14px; padding-right: 28px; }
  .ain-card:hover { background: rgb(255 255 255 / 0.08); }
  .ain-card.on { border-color: rgb(255 255 255 / 0.6); background: rgb(255 255 255 / 0.1); }
  .ain-states { position: relative; display: flex; gap: 3px; height: 8px; margin: auto 0 0 4px; align-items: center; }
  .ain-states i { width: 17px; height: 8px; }
  .ain-states em { position: absolute; left: 65px; font-style: normal; font-size: 13px; }
  .ain-bar { display: flex; height: 8px; margin: 4px 8px 2px 4px; }
  .ain-blue { background: rgb(0 255 255 / 0.25); }
  .ain-knob { width: 1px; background: rgb(128 128 128); }
  .ain-red { flex: 1; background: rgb(255 0 0 / 0.25); }
  .ain-mothership { position: absolute; top: 4px; right: 4px; width: 24px; height: 24px; opacity: 0.3; }
  .ain-mothership.lit { opacity: 1; }
</style>
