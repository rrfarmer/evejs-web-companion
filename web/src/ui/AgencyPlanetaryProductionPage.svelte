<script lang="ts">
  // agencyNew/ui/contentPages/contentPagePlanetaryProduction (a SingleColumnContentPage): the left column its filters
  // (PlanetaryProductionSystemFiltersCont: the location, the security status, the planet types - planetConst
  // PLANET_TYPES less Shattered and Scorched, each its PLANETTYPE_NAMES label and a checkbox, all ticked by default
  // (DEFAULT_PLANET_TYPES_FILTER) - Select All / Deselect All, Reset All); the scroll section's "Showing X results" and the
  // systems' cards (PlanetaryProductionSystemContentCard: the system and its security, the jumps, numPlanetsInSystem -
  // every planet of the system); the info container (PlanetaryProductionSystemInfoContainer, Planets in system, 200
  // high: each planet's name and type) and the system's primary button.
  // Not here (later parts): the scan range and colony icons (planetSvc.IsSystemWithinScanRange, the colonies), the
  // planet's resources, the wormhole planets, the planet entries' own buttons.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { DISTANCE, ANY, SECURITY_FILTER } from "../bridge/agencyAgents.ts";
  import { DEFAULT_SITE_FILTERS, type AgencySiteFilters } from "../bridge/agencySites.ts";

  let { store, flow, filters = $bindable(DEFAULT_SITE_FILTERS) }: { store: ClientStore; flow: AppFlow; filters?: AgencySiteFilters } = $props();
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

  /** planetConst.PLANET_TYPES (less Shattered 30889 and Scorched 73911) and PLANETTYPE_NAMES. */
  const PLANET_TYPES: readonly { readonly typeID: number; readonly label: string }[] = [
    { typeID: 11, label: "UI/PI/PlanetType/Temperate" }, { typeID: 2063, label: "UI/PI/PlanetType/Plasma" }, { typeID: 13, label: "UI/PI/PlanetType/Gas" },
    { typeID: 12, label: "UI/PI/PlanetType/Ice" }, { typeID: 2014, label: "UI/PI/PlanetType/Oceanic" }, { typeID: 2015, label: "UI/PI/PlanetType/Lava" },
    { typeID: 2016, label: "UI/PI/PlanetType/Barren" }, { typeID: 2017, label: "UI/PI/PlanetType/Storm" },
  ];
  const TYPE_LABEL: Record<number, string> = { ...Object.fromEntries(PLANET_TYPES.map((t) => [t.typeID, t.label])), 30889: "UI/PI/PlanetType/Shattered", 73911: "UI/PI/PlanetType/Scorched" };
  let planetTypes = $state<number[]>(PLANET_TYPES.map((t) => t.typeID));

  const word = (label: string, args: TemplateArguments = {}) => plainText(formatTemplate($words.templates[label] ?? "", args, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  type Sys = NonNullable<Awaited<ReturnType<AppFlow["agencyPlanetaryProduction"]>>>[number];
  let systems = $state<readonly Sys[] | null | undefined>(undefined);
  let chosen = $state<number | null>(null);
  let asked = 0;
  $effect(() => {
    const f = filters, types = [...planetTypes], n = ++asked;
    systems = undefined;
    void flow.agencyPlanetaryProduction(f, types).then((list) => { if (n !== asked) return; systems = list; chosen = list?.[0]?.solarSystemID ?? null; });
  });
  const system = $derived(systems?.find((s) => s.solarSystemID === chosen) ?? null);
  $effect(() => {
    flow.requestWords(["UI/Agency/ShowingXResults", "UI/Inflight/Scanner/FilteredResults", "UI/Agency/Location", "UI/Common/NumJumps", "UI/Generic/CurrentSystem",
      "UI/Generic/NoGateToGateRoute", "UI/Common/Location", "UI/Common/WithinJumps", "UI/Agency/ContentOfAnyDistance", "Tooltips/CharacterSheet/SecurityStatus", "UI/Agency/AnySecurity",
      "UI/Common/HighSec", "UI/Common/LowSec", "UI/Common/NullSec", "UI/Calendar/CalendarWindow/Filters", "UI/Commands/ResetAll", "UI/Agency/resetAllPageFilters",
      "UI/Agency/PlanetaryProduction/planetTypes", "UI/Common/SelectAll", "UI/Common/DeselectAll", "UI/Agency/PlanetaryProduction/numPlanetsInSystem",
      "UI/Agency/PlanetaryProduction/planetsInSystem", "UI/Neocom/UndockBtn", "UI/Inflight/SetDestination", "UI/Inflight/DestinationSet", ...Object.values(TYPE_LABEL)]);
  });

  const hereStation = $derived($station.online?.stationID ?? null);
  const hereSystem = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const systemText = (s: Sys) => word("UI/Agency/Location", { location: s.solarSystemID, secStatus: s.security === null ? "" : shownSecurity(s.security).toFixed(1) });
  const jumpsText = (s: Sys) => (s.solarSystemID === hereSystem ? word("UI/Generic/CurrentSystem") : s.jumps !== null ? word("UI/Common/NumJumps", { numJumps: s.jumps }) : word("UI/Generic/NoGateToGateRoute"));
  const ROMAN: [number, string][] = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  const roman = (n: number) => { let out = "", left = n; for (const [v, r] of ROMAN) while (left >= v) { out += r; left -= v; } return out; };
  /** The planet's location name: its system's and its celestial index in Roman numerals. */
  const planetName = (s: Sys, index: number) => `${resolvedName($names.resolved, "system", s.solarSystemID, "")} ${roman(index)}`;
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
  const set = (patch: Partial<AgencySiteFilters>) => { filters = { ...filters, ...patch }; };
  const toggle = (typeID: number, on: boolean) => { planetTypes = on ? [...planetTypes.filter((t) => t !== typeID), typeID] : planetTypes.filter((t) => t !== typeID); };
  const DISTANCES = [DISTANCE.currentSystem, DISTANCE.two, DISTANCE.five, DISTANCE.ten, DISTANCE.any];
  const distanceLabel = (v: number) => (v === DISTANCE.currentSystem ? word("UI/Generic/CurrentSystem") : v === DISTANCE.any ? word("UI/Agency/ContentOfAnyDistance") : word("UI/Common/WithinJumps", { numJumps: v }));
  const SECURITIES = [ANY, SECURITY_FILTER.high, SECURITY_FILTER.low, SECURITY_FILTER.nul];
  const securityLabel = (v: number) => word(v === ANY ? "UI/Agency/AnySecurity" : v === SECURITY_FILTER.high ? "UI/Common/HighSec" : v === SECURITY_FILTER.low ? "UI/Common/LowSec" : "UI/Common/NullSec");
</script>

<div class="app">
  <aside class="app-left">
    <section class="app-section">
      <h3>{word("UI/Calendar/CalendarWindow/Filters")}</h3>
      <label><span>{word("UI/Common/Location")}</span>
        <select value={filters.distance} onchange={(e) => set({ distance: Number(e.currentTarget.value) })}>{#each DISTANCES as v (v)}<option value={v}>{distanceLabel(v)}</option>{/each}</select></label>
      <label><span>{word("Tooltips/CharacterSheet/SecurityStatus")}</span>
        <select value={filters.security} onchange={(e) => set({ security: Number(e.currentTarget.value) })}>{#each SECURITIES as v (v)}<option value={v}>{securityLabel(v)}</option>{/each}</select></label>
      <h4>{word("UI/Agency/PlanetaryProduction/planetTypes")}</h4>
      {#each PLANET_TYPES as t (t.typeID)}
        <label class="app-check"><span>{word(t.label)}</span><input type="checkbox" checked={planetTypes.includes(t.typeID)} onchange={(e) => toggle(t.typeID, e.currentTarget.checked)} /></label>
      {/each}
      <div class="app-multi"><button type="button" onclick={() => (planetTypes = PLANET_TYPES.map((t) => t.typeID))}>{word("UI/Common/SelectAll")}</button>
        <button type="button" onclick={() => (planetTypes = [])}>{word("UI/Common/DeselectAll")}</button></div>
      <div class="app-reset"><button type="button" title={word("UI/Agency/resetAllPageFilters")} onclick={() => { filters = DEFAULT_SITE_FILTERS; planetTypes = PLANET_TYPES.map((t) => t.typeID); }}>{word("UI/Commands/ResetAll")}</button></div>
    </section>
  </aside>
  <section class="app-section app-scroll">
    <h3>{systems?.length ? word("UI/Agency/ShowingXResults", { numResults: systems.length }) : systems === undefined ? "…" : word("UI/Inflight/Scanner/FilteredResults")}</h3>
    <div class="app-cards">
      {#each systems ?? [] as s (s.solarSystemID)}
        <button type="button" class="app-card" class:on={chosen === s.solarSystemID} onclick={() => (chosen = s.solarSystemID)}>
          <b>{systemText(s)}</b><span>{jumpsText(s)}</span><small>{word("UI/Agency/PlanetaryProduction/numPlanetsInSystem", { numPlanets: s.planets.length })}</small>
        </button>
      {/each}
    </div>
  </section>
  <section class="app-section app-details">
    <h3>{word("UI/Agency/PlanetaryProduction/planetsInSystem")}</h3>
    {#if system}{@const action = actionOf(system)}
      <div class="app-system">{systemText(system)}</div>
      <div class="app-list">
        {#each system.planets as p (p.planetID)}
          <div class="app-planet" class:dim={!planetTypes.includes(p.typeID)}><span>{planetName(system, p.celestialIndex)}</span><small>{TYPE_LABEL[p.typeID] ? word(TYPE_LABEL[p.typeID]!) : ""}</small></div>
        {/each}
      </div>
      {#if action}<div class="app-buttons"><button type="button" disabled={busy || action === "destinationSet"} onclick={() => void act(system)}>{word(LABEL[action])}</button></div>{/if}
    {/if}
  </section>
</div>

<style>
  .app { display: flex; gap: 10px; justify-content: center; height: 100%; min-height: 0; }
  .app-left { width: 300px; flex: none; display: flex; flex-direction: column; gap: 16px; overflow: auto; }
  .app-section { background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); padding: 8px 10px; }
  .app-section h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
  .app-section h4 { margin: 8px 0 4px; font-size: 12px; font-weight: 400; opacity: 0.8; }
  .app-section label { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; font-size: 12px; }
  .app-section label span { opacity: 0.7; }
  .app-check { flex-direction: row !important; justify-content: space-between; align-items: center; height: 16px; margin-bottom: 4px !important; }
  .app-multi { display: flex; gap: 10px; padding-top: 6px; }
  .app-reset { display: flex; justify-content: flex-end; padding-top: 8px; }
  .app-scroll { width: 331px; flex: none; display: flex; flex-direction: column; min-height: 0; }
  .app-cards { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding-right: 4px; }
  .app-card { all: unset; box-sizing: border-box; cursor: pointer; width: 300px; height: 86px; flex: none; display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; font-size: 12px;
    background: rgb(255 255 255 / 0.04); border: 1px solid rgb(255 255 255 / 0.1); }
  .app-card b { font-size: 14px; }
  .app-card small { margin-top: auto; opacity: 0.7; }
  .app-card:hover { background: rgb(255 255 255 / 0.08); }
  .app-card.on { border-color: rgb(255 255 255 / 0.6); background: rgb(255 255 255 / 0.1); }
  .app-details { width: 400px; flex: none; display: flex; flex-direction: column; min-height: 0; }
  .app-system { height: 22px; margin-bottom: 10px; font-size: 14px; }
  .app-list { height: 200px; overflow: auto; background: rgb(0 0 0 / 0.3); }
  .app-planet { display: flex; justify-content: space-between; padding: 4px 8px; font-size: 12px; }
  .app-planet small { opacity: 0.7; }
  .app-planet.dim { opacity: 0.4; }
  .app-buttons { display: flex; justify-content: flex-end; padding-top: 10px; }
</style>
