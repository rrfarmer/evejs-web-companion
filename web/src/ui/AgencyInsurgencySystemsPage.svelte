<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { ANY, DISTANCE } from "../bridge/agencyAgents.ts";
  import { DEFAULT_AGENCY_INSURGENCY_FILTERS, type AgencyInsurgencyFilters, type AgencyInsurgencySystem } from "../bridge/agencySites.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { MILITIA_FACTIONS, PIRATE_MILITIAS, type MilitiaFactionID } from "../bridge/militiaEnlistment.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { factionIcon } from "./skillPlanIcons.ts";
  import AgencySystemSiteList from "./AgencySystemSiteList.svelte";

  let { flow, store, filters = $bindable(DEFAULT_AGENCY_INSURGENCY_FILTERS) }: {
    flow: AppFlow; store: ClientStore; filters?: AgencyInsurgencyFilters;
  } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const anomaliesChanged = flow.agencyAnomaliesChanged;
  // svelte-ignore state_referenced_locally
  const warzoneChanged = flow.theatersWarzoneChanged;
  const A = "UI/Agency/PirateIncursions/";
  const P = "UI/PirateInsurgencies/";
  const tracks = [
    { key: "corruption", title: "CorruptionStage", badge: "CorruptionStageX" },
    { key: "suppression", title: "SuppressionStage", badge: "SuppressionStageX" },
  ] as const;
  const stages = [0, 1, 2, 3, 4, 5];
  const distances = [DISTANCE.currentSystem, DISTANCE.two, DISTANCE.five, DISTANCE.ten, DISTANCE.any];
  const labels = [
    "UI/Calendar/CalendarWindow/Filters", "UI/Common/Location", "UI/Common/Faction", "UI/Agency/AnyFaction",
    "UI/Generic/CurrentSystem", "UI/Common/WithinJumps", "UI/Agency/ContentOfAnyDistance", "UI/Commands/ResetAll",
    "UI/Agency/Location", "UI/Generic/NoGateToGateRoute", "UI/Common/NumJumps", "UI/Agency/ShowingXResults",
    "UI/Inflight/Scanner/FilteredResults", "UI/Agency/currentlyUnavailable", A + "StageX", A + "AnyStage",
    A + "NoActiveInsurgency", P + "FOB", P + "FOBSystem", P + "FactionInsurgencySystem",
    ...tracks.flatMap((track) => [A + track.title, A + track.badge]),
  ];
  const word = (label: string, args: TemplateArguments = {}) => plainText(formatTemplate($words.templates[label] ?? "", args, {
    nameOf: (kind, id) => resolvedName($names.resolved, kind, id, ""),
  }));
  const factionName = (id: MilitiaFactionID) => resolvedName($names.resolved, "owner", id, MILITIA_FACTIONS[id].name);
  const factions = $derived([...PIRATE_MILITIAS].sort((a, b) => factionName(a).localeCompare(factionName(b))));
  const pirateIcon = (id: MilitiaFactionID) => clientTexture("res:/UI/Texture/Classes/Enlistment/logos/" + MILITIA_FACTIONS[id].logo + ".png");
  const fobFlag = clientTexture("res:/UI/Texture/classes/agency/pirateIncursions/fobFlag.png");
  const here = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const inSpace = $derived($flight.status?.inSpace === true);
  let answer = $state<Awaited<ReturnType<AppFlow["agencyInsurgencySystems"]>> | null | undefined>(undefined);
  let selectedID = $state<number | null>(null);
  const selected = $derived(answer?.systems.find((row) => row.solarSystemID === selectedID) ?? answer?.systems[0] ?? null);

  $effect(() => {
    flow.requestWords(labels);
    flow.requestNames(PIRATE_MILITIAS.map((id) => ({ kind: "owner" as const, id })));
  });
  $effect(() => { if (here !== null && inSpace) void flow.agencyRegisterLocalSignalTracker().catch(() => {}); });
  $effect(() => {
    void here;
    void $anomaliesChanged;
    void $warzoneChanged;
    const options = filters;
    let current = true;
    void flow.agencyInsurgencySystems(options).then(
      (result) => { if (current) answer = result; },
      () => { if (current) answer = null; },
    );
    return () => { current = false; };
  });
  const set = (patch: Partial<AgencyInsurgencyFilters>) => { filters = { ...filters, ...patch }; };
  function location(system: AgencyInsurgencySystem): string {
    const security = system.security === null ? "" : shownSecurity(system.security).toFixed(1);
    return word("UI/Agency/Location", { location: system.solarSystemID, secStatus: security })
      || resolvedName($names.resolved, "system", system.solarSystemID, "");
  }
  function distanceLabel(value: number): string {
    if (value === DISTANCE.currentSystem) return word("UI/Generic/CurrentSystem");
    return value === DISTANCE.any ? word("UI/Agency/ContentOfAnyDistance") : word("UI/Common/WithinJumps", { numJumps: value });
  }
  function jumps(system: AgencyInsurgencySystem): string {
    if (system.solarSystemID === here) return word("UI/Generic/CurrentSystem");
    return system.jumps === null ? word("UI/Generic/NoGateToGateRoute") : word("UI/Common/NumJumps", { numJumps: system.jumps });
  }
</script>

<div class="agency-insurgency">
  <aside>
    <section class="panel">
      <h3>{word("UI/Calendar/CalendarWindow/Filters")}</h3>
      <label>{word("UI/Common/Location")}
        <select value={filters.distance} onchange={(event) => set({ distance: Number(event.currentTarget.value) })}>
          {#each distances as distance (distance)}<option value={distance}>{distanceLabel(distance)}</option>{/each}
        </select>
      </label>
      <label>{word("UI/Common/Faction")}
        <select value={filters.faction} onchange={(event) => set({ faction: Number(event.currentTarget.value) })}>
          <option value={ANY}>{word("UI/Agency/AnyFaction")}</option>
          {#each factions as id (id)}<option value={id}>{factionName(id)}</option>{/each}
        </select>
      </label>
      {#each tracks as track (track.key)}
        <label>{word(A + track.title)}
          <select value={filters[track.key]} onchange={(event) => set({ [track.key]: Number(event.currentTarget.value) })}>
            <option value={ANY}>{word(A + "AnyStage")}</option>
            {#each stages as stage (stage)}<option value={stage}>{word(A + "StageX", { stage })}</option>{/each}
          </select>
        </label>
      {/each}
      <div class="reset"><button type="button" onclick={() => (filters = DEFAULT_AGENCY_INSURGENCY_FILTERS)}>{word("UI/Commands/ResetAll")}</button></div>
    </section>
  </aside>

  <section class="panel results">
    <h3>{answer === undefined ? "…" : answer === null ? word("UI/Agency/currentlyUnavailable")
      : answer.systems.length ? word("UI/Agency/ShowingXResults", { numResults: answer.systems.length }) : word("UI/Inflight/Scanner/FilteredResults")}</h3>
    <div class="cards">
      {#each answer?.systems ?? [] as system (system.solarSystemID)}
        {@const occupierIcon = factionIcon(system.occupierID)}
        <button type="button" class="card" aria-pressed={selected?.solarSystemID === system.solarSystemID}
          onclick={() => (selectedID = system.solarSystemID)}>
          <span class="logos">
            {#if occupierIcon && system.occupierID}<img src={occupierIcon} alt="" title={factionName(system.occupierID)} />{/if}
            {#if system.pirateFactionID}<img src={pirateIcon(system.pirateFactionID)} alt="" title={factionName(system.pirateFactionID)} />{/if}
          </span>
          <strong>{location(system)}</strong>
          <span>{jumps(system)}</span>
          {#each tracks as track (track.key)}
            {@const stage = system.stages[track.key]}
            {#if stage !== null}<small>{word(A + track.badge, { stage })}</small>{/if}
          {/each}
        </button>
      {:else}
        {#if answer && !answer.activeCampaign}<p>{word(A + "NoActiveInsurgency")}</p>{/if}
      {/each}
    </div>
  </section>

  <section class="panel details">
    {#if selected}
      {@const occupierIcon = factionIcon(selected.occupierID)}
      {@const pirate = selected.pirateFactionID}
      <h3>{location(selected)}</h3>
      <div class="summary">
        {#if occupierIcon && selected.occupierID}<img class="owner" alt="" title={factionName(selected.occupierID)} src={occupierIcon} />{/if}
        <div>
          {#if pirate}<p>{word(P + (selected.isFobSystem ? "FOBSystem" : "FactionInsurgencySystem"), { factionName: factionName(pirate) })}</p>{/if}
          {#each tracks as track (track.key)}
            {@const stage = selected.stages[track.key]}
            {#if stage !== null}<p>{word(A + track.badge, { stage })}</p>{/if}
          {/each}
        </div>
        {#if selected.isFobSystem && pirate}
          <span class="fob" style:background-image={'url("' + fobFlag + '")'}>
            <img alt="" title={factionName(pirate)} src={pirateIcon(pirate)} />{word(P + "FOB")}
          </span>
        {/if}
      </div>
      <AgencySystemSiteList {flow} {store} system={selected} label={A + "ActivitiesInSystem"} {word} provider="pirate_insurgencies" />
    {/if}
  </section>
</div>

<style>
  .agency-insurgency { display: grid; grid-template-columns: minmax(165px, 300px) minmax(180px, 331px) minmax(220px, 400px); gap: 10px; justify-content: center; height: 100%; min-height: 0; }
  .panel { padding: 8px 10px; border: 1px solid rgb(255 255 255 / 0.08); background: rgb(0 0 0 / 0.3); }
  h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
  p { margin: 0 0 4px; font-size: 12px; }
  label { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; font-size: 12px; }
  select { min-width: 0; }
  .reset { display: flex; justify-content: flex-end; }
  .results, .cards { display: flex; flex-direction: column; min-height: 0; }
  .cards { gap: 12px; overflow: auto; }
  .card { position: relative; flex: none; display: flex; flex-direction: column; gap: 3px; min-height: 86px; padding: 8px 73px 8px 10px; text-align: left; cursor: pointer; }
  .card[aria-pressed="true"] { border-color: rgb(255 255 255 / 0.6); background: rgb(255 255 255 / 0.1); }
  .card strong { font-size: 14px; }
  .logos { display: flex; position: absolute; top: 5px; right: 5px; }
  .logos img, .fob img { width: 32px; height: 32px; }
  .details { overflow: auto; }
  .summary { display: flex; align-items: center; gap: 10px; min-height: 64px; }
  .owner { width: 64px; height: 64px; flex: none; }
  .fob { display: flex; flex-direction: column; width: 52px; height: 103px; margin-left: auto; flex: none; align-items: center; gap: 5px; padding-top: 16px; background-repeat: no-repeat; }
</style>
