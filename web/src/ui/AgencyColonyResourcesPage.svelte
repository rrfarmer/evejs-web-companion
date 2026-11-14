<script lang="ts">
  // agencyNew/ui/contentPages/contentPageColonyResourcesAgency (part 1): the null-sec systems of no faction
  // (ContentProviderColonyResourcesAgency: within the distance, by jumps, to COLONY_RESOURCE_AGENCY_PIECES_MAX 120), each
  // card (ColonyResourcesAgencySystemContentCard: the system and its security, the jumps, and the bottom 20 high: the
  // system's power and workforce, each its richness icon (resourceRichness GetSystem...RichnessTexturePath, 18, platinum
  // grey, its hint the richness label) and amount; then the superionic ice and magmatic gas icons where the system's
  // planets give them); and the chosen system's planets (the star's power, each planet's power, workforce or reagent per
  // hour with its planet richness icon) and its primary button.
  // Not here (later parts): the filters beyond the location (per system / per planet, power, workforce, reagents,
  // sovereignty, skyhook theft vulnerability, region), the sovereign alliance, the skyhooks, the planets' types.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { DISTANCE } from "../bridge/agencyAgents.ts";
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

  type Data = NonNullable<Awaited<ReturnType<AppFlow["agencyColonyResources"]>>>;
  type Sys = Data["systems"][number];
  const word = (label: string, args: TemplateArguments = {}) => plainText(formatTemplate($words.templates[label] ?? "", args, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  let data = $state<Data | null | undefined>(undefined);
  let chosen = $state<number | null>(null);
  let asked = 0;
  $effect(() => {
    const f = filters, n = ++asked;
    data = undefined;
    void flow.agencyColonyResources(f).then((d) => { if (n !== asked) return; data = d; chosen = d?.systems[0]?.solarSystemID ?? null; });
  });
  const system = $derived(data?.systems.find((s) => s.solarSystemID === chosen) ?? null);

  // orbitalSkyhook/resourceRichness: GetRichness(amount, avg, prosperous) - none at nought or less, else modest, average,
  // abundant; the system's and the planet's thresholds.
  const T = { system: { power: [921, 1381], workforce: [11840, 22060], ice: [36, 41], gas: [835, 1436] }, planet: { power: [271, 481], workforce: [2831, 5671], ice: [36, 40], gas: [763, 946] } } as const;
  const richness = (amount: number, [avg, prosperous]: readonly [number, number]) => (amount <= 0 ? 0 : amount < avg ? 1 : amount < prosperous ? 2 : 3);
  const ICONS = { power: ["power_richenss_modest", "power_richness_average", "power_richness_prosperous"], workforce: ["workforce_richness_modest", "workforce_richness_average", "workforce_richness_prosperous"],
    ice: ["superionic_ice_richness_modest", "superionic_ice_richness_average", "superionic_ice_richness_prosperous"], gas: ["magmatic_gas_richness_modest", "magmatic_gas_richness_average", "magmatic_gas_richness_prosperous"] } as const;
  const LABELS = { power: ["UI/OrbitalSkyhook/ResourcesPowerLow", "UI/OrbitalSkyhook/ResourcesPowerMid", "UI/OrbitalSkyhook/ResourcesPowerHigh"],
    workforce: ["UI/OrbitalSkyhook/ResourcesWorkforceLow", "UI/OrbitalSkyhook/ResourcesWorkforceMid", "UI/OrbitalSkyhook/ResourcesWorkforceHigh"],
    ice: ["UI/OrbitalSkyhook/ResourcesIoniciceLow", "UI/OrbitalSkyhook/ResourcesIoniciceMid", "UI/OrbitalSkyhook/ResourcesIoniciceHigh"],
    gas: ["UI/OrbitalSkyhook/ResourcesMagmaticgasLow", "UI/OrbitalSkyhook/ResourcesMagmaticgasMid", "UI/OrbitalSkyhook/ResourcesMagmaticgasHigh"] } as const;
  type Kind = keyof typeof ICONS;
  function icon(kind: Kind, amount: number, scale: "system" | "planet"): { src: string | null; hint: string } | null {
    const r = richness(amount, T[scale][kind]);
    if (!r) return null;
    const res = data?.icons[ICONS[kind][r - 1]!];
    return { src: res ? clientTexture(res) : null, hint: word(LABELS[kind][r - 1]!) };
  }
  $effect(() => {
    flow.requestWords(["UI/Agency/ShowingXResults", "UI/Inflight/Scanner/FilteredResults", "UI/Agency/Location", "UI/Common/NumJumps", "UI/Generic/CurrentSystem", "UI/Generic/NoGateToGateRoute",
      "UI/Common/Location", "UI/Common/WithinJumps", "UI/Agency/ContentOfAnyDistance", "UI/Calendar/CalendarWindow/Filters", "UI/Commands/ResetAll", "UI/Agency/resetAllPageFilters",
      "UI/Agency/PlanetaryProduction/planetsInSystem", "UI/Neocom/UndockBtn", "UI/Inflight/SetDestination", "UI/Inflight/DestinationSet", ...Object.values(LABELS).flat()]);
  });
  const hereStation = $derived($station.online?.stationID ?? null);
  const hereSystem = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const secText = (id: number) => { const s = $names.systemSecurity?.[id]; return typeof s === "number" ? shownSecurity(s).toFixed(1) : ""; };
  const systemText = (s: Sys) => word("UI/Agency/Location", { location: s.solarSystemID, secStatus: secText(s.solarSystemID) });
  const jumpsText = (s: Sys) => (s.solarSystemID === hereSystem ? word("UI/Generic/CurrentSystem") : s.jumps !== null ? word("UI/Common/NumJumps", { numJumps: s.jumps }) : word("UI/Generic/NoGateToGateRoute"));
  const ROMAN: [number, string][] = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  const roman = (n: number) => { let out = "", left = n; for (const [v, r] of ROMAN) while (left >= v) { out += r; left -= v; } return out; };
  const amount = (n: number) => Math.round(n).toLocaleString("en-US");
  type Action = "undock" | "setDestination" | "destinationSet" | null;
  const LABEL: Record<Exclude<Action, null>, string> = { undock: "UI/Neocom/UndockBtn", setDestination: "UI/Inflight/SetDestination", destinationSet: "UI/Inflight/DestinationSet" };
  function actionOf(s: Sys): Action {
    if (s.solarSystemID === hereSystem) return hereStation !== null ? "undock" : null;
    return $waypoints[$waypoints.length - 1] === s.solarSystemID ? "destinationSet" : "setDestination";
  }
  let busy = $state(false);
  async function act(s: Sys): Promise<void> {
    const action = actionOf(s);
    if (busy || action === null || action === "destinationSet") return;
    busy = true;
    try { if (action === "undock") await flow.undock(); else flow.setDestination(s.solarSystemID); } finally { busy = false; }
  }
  const DISTANCES = [DISTANCE.currentSystem, DISTANCE.two, DISTANCE.five, DISTANCE.ten, DISTANCE.any];
  const distanceLabel = (v: number) => (v === DISTANCE.currentSystem ? word("UI/Generic/CurrentSystem") : v === DISTANCE.any ? word("UI/Agency/ContentOfAnyDistance") : word("UI/Common/WithinJumps", { numJumps: v }));
</script>

{#snippet res(kind: Kind, value: number, scale: "system" | "planet", showAmount: boolean)}
  {@const i = icon(kind, value, scale)}
  {#if i}<span class="acr-res" title={i.hint}>{#if i.src}<img alt="" src={i.src} />{/if}{#if showAmount}{amount(value)}{/if}</span>{/if}
{/snippet}

<div class="acr">
  <aside class="acr-left">
    <section class="acr-section">
      <h3>{word("UI/Calendar/CalendarWindow/Filters")}</h3>
      <label><span>{word("UI/Common/Location")}</span>
        <select value={filters.distance} onchange={(e) => (filters = { ...filters, distance: Number(e.currentTarget.value) })}>{#each DISTANCES as v (v)}<option value={v}>{distanceLabel(v)}</option>{/each}</select></label>
      <div class="acr-reset"><button type="button" title={word("UI/Agency/resetAllPageFilters")} onclick={() => (filters = DEFAULT_SITE_FILTERS)}>{word("UI/Commands/ResetAll")}</button></div>
    </section>
  </aside>
  <section class="acr-section acr-scroll">
    <h3>{data?.systems.length ? word("UI/Agency/ShowingXResults", { numResults: data.systems.length }) : data === undefined ? "…" : word("UI/Inflight/Scanner/FilteredResults")}</h3>
    <div class="acr-cards">
      {#each data?.systems ?? [] as s (s.solarSystemID)}
        <button type="button" class="acr-card" class:on={chosen === s.solarSystemID} onclick={() => (chosen = s.solarSystemID)}>
          <b>{systemText(s)}</b><span>{jumpsText(s)}</span>
          <span class="acr-bottom">
            <span class="acr-cell">{@render res("power", s.power, "system", true)}</span>
            <span class="acr-cell">{#if s.workforce}{@render res("workforce", s.workforce, "system", true)}{/if}</span>
            {#if s.hasSuperionicIce}{@render res("ice", s.superionicIce, "system", false)}{/if}
            {#if s.hasMagmaticGas}{@render res("gas", s.magmaticGas, "system", false)}{/if}
          </span>
        </button>
      {/each}
    </div>
  </section>
  <section class="acr-section acr-details">
    <h3>{word("UI/Agency/PlanetaryProduction/planetsInSystem")}</h3>
    {#if system}{@const action = actionOf(system)}
      <div class="acr-system">{systemText(system)}</div>
      <div class="acr-list">
        {#if system.starPower}<div class="acr-planet"><span>{resolvedName($names.resolved, "system", system.solarSystemID, "")}</span>{@render res("power", system.starPower, "planet", true)}</div>{/if}
        {#each system.planets as p (p.planetID)}
          <div class="acr-planet"><span>{resolvedName($names.resolved, "system", system.solarSystemID, "")} {roman(p.celestialIndex)}</span>
            {#if p.reagentTypeID === 81144}{@render res("ice", p.reagentPerHour, "planet", true)}{:else if p.reagentTypeID === 81143}{@render res("gas", p.reagentPerHour, "planet", true)}
            {:else if p.power}{@render res("power", p.power, "planet", true)}{:else if p.workforce}{@render res("workforce", p.workforce, "planet", true)}{/if}</div>
        {/each}
      </div>
      {#if action}<div class="acr-buttons"><button type="button" disabled={busy || action === "destinationSet"} onclick={() => void act(system)}>{word(LABEL[action])}</button></div>{/if}
    {/if}
  </section>
</div>

<style>
  .acr { display: flex; gap: 10px; justify-content: center; height: 100%; min-height: 0; }
  .acr-left { width: 300px; flex: none; display: flex; flex-direction: column; gap: 16px; }
  .acr-section { background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); padding: 8px 10px; }
  .acr-section h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
  .acr-section label { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; font-size: 12px; }
  .acr-section label span { opacity: 0.7; }
  .acr-reset { display: flex; justify-content: flex-end; }
  .acr-scroll { width: 331px; flex: none; display: flex; flex-direction: column; min-height: 0; }
  .acr-cards { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding-right: 4px; }
  .acr-card { all: unset; box-sizing: border-box; cursor: pointer; width: 300px; flex: none; display: flex; flex-direction: column; gap: 3px; padding: 8px 8px 8px 16px; font-size: 12px;
    background: rgb(255 255 255 / 0.04); border: 1px solid rgb(255 255 255 / 0.1); }
  .acr-card b { font-weight: 400; font-size: 13px; }
  .acr-card:hover { background: rgb(255 255 255 / 0.08); }
  .acr-card.on { border-color: rgb(255 255 255 / 0.6); background: rgb(255 255 255 / 0.1); }
  .acr-bottom { display: flex; align-items: center; height: 20px; margin-top: 6px; padding: 0 6px 0 4px; background: rgb(0 0 0 / 0.3); }
  .acr-cell { width: 60px; flex: none; }
  .acr-res { display: inline-flex; align-items: center; gap: 2px; margin-right: 6px; }
  .acr-res img { width: 18px; height: 18px; filter: grayscale(1) brightness(1.4); }
  .acr-details { width: 400px; flex: none; display: flex; flex-direction: column; min-height: 0; }
  .acr-system { height: 22px; margin-bottom: 10px; font-size: 14px; }
  .acr-list { height: 200px; overflow: auto; background: rgb(0 0 0 / 0.3); }
  .acr-planet { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; font-size: 12px; }
  .acr-buttons { display: flex; justify-content: flex-end; padding-top: 10px; }
</style>
