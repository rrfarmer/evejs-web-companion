<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { ANY, DISTANCE } from "../bridge/agencyAgents.ts";
  import { DEFAULT_AGENCY_FW_FILTERS, agencyFactionWarfareBenefits, agencyFactionWarfareUpgrade, type AgencyFactionWarfareFilters, type AgencyFactionWarfareSystem } from "../bridge/agencySites.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { EMPIRE_MILITIAS, MILITIA_FACTIONS, WARZONE_FACTION_COLORS } from "../bridge/militiaEnlistment.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { GROUP_CONTROL_BUNKER } from "../bridge/spaceActivate.ts";
  import { resolvedName } from "../store/names.ts";
  import { factionIcon } from "./skillPlanIcons.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import AgencySystemSiteList from "./AgencySystemSiteList.svelte";

  let { flow, store, filters = $bindable(DEFAULT_AGENCY_FW_FILTERS) }: {
    flow: AppFlow; store: ClientStore; filters?: AgencyFactionWarfareFilters;
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
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const warzoneChanged = flow.theatersWarzoneChanged;
  // svelte-ignore state_referenced_locally
  const anomaliesChanged = flow.agencyAnomaliesChanged;

  const F = "UI/FactionWarfare/";
  const A = "UI/Agency/FactionWarfare/";
  const T = "UI/Agency/Tooltips/Encounters/FactionWarfare/";
  const distances = [DISTANCE.currentSystem, DISTANCE.two, DISTANCE.five, DISTANCE.ten, DISTANCE.any];
  const adjacencies = {
    FL: [F + "frontlines/frontline", F + "frontlines/FrontlineSystem"],
    SL: [F + "frontlines/secondline", F + "frontlines/SecondlineSystem"],
    BL: [F + "frontlines/backline", F + "frontlines/BacklineSystem"],
  } as const;
  const information = [
    { label: "systemUpgrades", body: ["SystemUpgradesDescription2", "SystemUpgradeBonuses", "AvailableUpgrades"] },
    { label: "complexTypes", body: ["Systems/ComplexTypes"] },
    { label: "systemRewards", body: ["Systems/RewardPerComplexType", "Systems/BiggerComplexBiggerReward", "Systems/DefendersGetLessLP"] },
  ];
  const complexes = ["Novice", "Small", "Medium", "Large", "SmallADV", "MediumADV", "LargeADV"];
  const benefits = {
    industry: { texture: "stationCopySlots.png", hint: "UpgradeHintStationSlots" },
    market: { texture: "marketReduction.png", hint: "UpgradeHintMarketReduction" },
  };
  const infoIcon = clientTexture("res:/UI/Texture/Shared/DarkStyle/buttonIconQuestion.png");
  const tooltipID = $props.id();
  let openInformation = $state<string | null>(null);
  let dismissedInformation = $state<string | null>(null);
  const labels = [
    "UI/Calendar/CalendarWindow/Filters", "UI/Common/Information", "UI/Common/Location", "UI/Generic/CurrentSystem",
    "UI/Common/WithinJumps", "UI/Agency/ContentOfAnyDistance", "UI/Generic/NoGateToGateRoute", "UI/Common/NumJumps",
    "UI/Common/Faction", "UI/Agency/AnyFaction", "UI/Agency/Adjacency", "UI/Agency/AnyAdjacency", "UI/Commands/ResetAll",
    "UI/Agency/ShowingXResults", "UI/Agency/Location", "UI/Common/NothingFound", "UI/Agency/currentlyUnavailable",
    "UI/LPStore/AmountLP", F + "StatusStable", F + "StatusContested", F + "StatusVulnerable",
    ...[...information.map((info) => info.label), "systemUpgradeLevel", "systemStatusLabel", "systemOccupierLabel"].map((key) => A + key),
    ...information.flatMap((info) => info.body.map((key) => T + key)),
    ...["Type", "AllowedShips", ...complexes.flatMap((key) => [key + "Complex", key + "ComplexRestrictions"])].map((key) => T + "Systems/" + key),
    ...["LevelUnlockHint", ...Object.values(benefits).map((benefit) => benefit.hint)].map((key) => F + "IHub/" + key),
    F + "StatusVulnerableHint", F + "StatusContestedHint",
    ...Object.values(adjacencies).flat(),
  ];
  const word = (label: string, args: TemplateArguments = {}) => plainText(formatTemplate($words.templates[label] ?? "", args, {
    nameOf: (kind, id) => resolvedName($names.resolved, kind, id, ""),
  }));
  const factionName = (id: typeof EMPIRE_MILITIAS[number]) => resolvedName($names.resolved, "owner", id, MILITIA_FACTIONS[id].name);
  const factions = $derived([...EMPIRE_MILITIAS].sort((a, b) => factionName(a).localeCompare(factionName(b))));
  const here = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const inSpace = $derived($flight.status?.inSpace === true);
  let systems = $state<readonly AgencyFactionWarfareSystem[] | null | undefined>(undefined);
  let selectedID = $state<number | null>(null);
  let lp = $state<number | null>(null);
  let hubID = $state<number | null>(null);
  const selected = $derived(systems?.find((system) => system.solarSystemID === selectedID) ?? systems?.[0] ?? null);
  const upgrade = $derived(lp === null ? null : agencyFactionWarfareUpgrade(lp));
  const local = $derived(inSpace && here !== null && selected?.solarSystemID === here && $space.snapshot?.solarSystemID === here);
  const visibleHubs = $derived(local ? ($space.snapshot?.entities ?? []).filter((entity) => entity.groupID === GROUP_CONTROL_BUNKER) : []);
  const visibleHubIDs = $derived(visibleHubs.map((entity) => entity.itemID).join(","));
  const hub = $derived(visibleHubs.find((entity) => entity.itemID === hubID) ?? null);

  $effect(() => {
    flow.requestWords(labels);
    flow.requestNames(EMPIRE_MILITIAS.map((id) => ({ kind: "owner" as const, id })));
  });
  $effect(() => {
    if (here !== null && inSpace) void flow.agencyRegisterLocalSignalTracker().catch(() => {});
  });
  $effect(() => {
    void here;
    void $warzoneChanged;
    void $anomaliesChanged;
    const options = filters;
    let current = true;
    void flow.agencyFactionWarfareSystems(options).then(
      (answer) => { if (current) systems = answer; },
      () => { if (current) systems = null; },
    );
    return () => { current = false; };
  });
  $effect(() => {
    const systemID = selected?.solarSystemID;
    void $warzoneChanged;
    lp = null;
    if (systemID === undefined) return;
    let current = true;
    void flow.agencyFactionWarfareSystemLP(systemID).then((answer) => { if (current) lp = answer; }, () => {});
    return () => { current = false; };
  });
  $effect(() => {
    void visibleHubIDs;
    void here;
    hubID = null;
    if (!local) return;
    let current = true;
    void flow.agencyFactionWarfareHub().then((answer) => { if (current) hubID = answer; }, () => {});
    return () => { current = false; };
  });

  const set = (patch: Partial<AgencyFactionWarfareFilters>) => { filters = { ...filters, ...patch }; };
  function location(system: AgencyFactionWarfareSystem): string {
    const security = system.security === null ? "" : shownSecurity(system.security).toFixed(1);
    return word("UI/Agency/Location", { location: system.solarSystemID, secStatus: security })
      || resolvedName($names.resolved, "system", system.solarSystemID, "");
  }
  function distanceLabel(value: number): string {
    if (value === DISTANCE.currentSystem) return word("UI/Generic/CurrentSystem");
    return value === DISTANCE.any ? word("UI/Agency/ContentOfAnyDistance") : word("UI/Common/WithinJumps", { numJumps: value });
  }
  function jumps(system: AgencyFactionWarfareSystem): string {
    if (system.solarSystemID === here) return word("UI/Generic/CurrentSystem");
    return system.jumps === null ? word("UI/Generic/NoGateToGateRoute") : word("UI/Common/NumJumps", { numJumps: system.jumps });
  }
  function adjacency(system: AgencyFactionWarfareSystem, long = false): string {
    const pair = adjacencies[system.occupation.adjacency as keyof typeof adjacencies];
    return pair ? word(pair[long ? 1 : 0]) : "";
  }
  const contested = (system: AgencyFactionWarfareSystem) => system.victory
    ? Math.min(system.victory.score / system.victory.threshold, 1) : 0;
  function status(system: AgencyFactionWarfareSystem): string {
    if (system.victory === null) return "";
    const fraction = contested(system);
    if (fraction >= 1) return word(F + "StatusVulnerable");
    return fraction > 0 ? word(F + "StatusContested", { num: fraction * 100 }) : word(F + "StatusStable");
  }
  function statusHint(system: AgencyFactionWarfareSystem): string {
    const fraction = contested(system);
    if (fraction >= 1) return word(F + "StatusVulnerableHint");
    return fraction > 0 ? word(F + "StatusContestedHint", { percentage: fraction * 100 }) : "";
  }
  function statusColor(system: AgencyFactionWarfareSystem): string {
    const fraction = contested(system);
    return fraction >= 1 ? "#ff454b" : fraction > 0 ? "#f39058" : "#8dc169";
  }
  function lpText(value: number): string {
    return word("UI/LPStore/AmountLP", { lpAmount: new Intl.NumberFormat("en-US").format(value) });
  }
</script>

<div class="agency-fw">
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
      <label>{word("UI/Agency/Adjacency")}
        <select value={filters.adjacency} onchange={(event) => set({ adjacency: event.currentTarget.value })}>
          <option value="">{word("UI/Agency/AnyAdjacency")}</option>
          {#each Object.entries(adjacencies) as [key, labels] (key)}<option value={key}>{word(labels[0])}</option>{/each}
        </select>
      </label>
      <div class="reset"><button type="button" onclick={() => (filters = DEFAULT_AGENCY_FW_FILTERS)}>{word("UI/Commands/ResetAll")}</button></div>
    </section>
    <section class="panel">
      <h3>{word("UI/Common/Information")}</h3>
      {#each information as info (info.label)}
        {@const id = tooltipID + "-" + info.label}
        <div class="information">
          <button type="button" aria-describedby={id} aria-expanded={openInformation === info.label}
            onclick={() => { dismissedInformation = null; openInformation = info.label; }}
            onfocus={() => (dismissedInformation = null)}
            onpointerenter={() => (dismissedInformation = null)}
            onblur={() => { if (openInformation === info.label) openInformation = null; }}
            onkeydown={(event) => { if (event.key === "Escape") { openInformation = null; dismissedInformation = info.label; } }}>
            <img src={infoIcon} alt="" />{word(A + info.label)}
          </button>
          <div role="tooltip" {id} class:open={openInformation === info.label} class:dismissed={dismissedInformation === info.label}>
            {#each info.body as line (line)}<p>{word(T + line)}</p>{/each}
            {#if info.label === "complexTypes"}
              <table>
                <thead><tr><th>{word(T + "Systems/Type")}</th><th>{word(T + "Systems/AllowedShips")}</th></tr></thead>
                <tbody>{#each complexes as key (key)}
                  <tr><td>{word(T + "Systems/" + key + "Complex")}</td><td>{word(T + "Systems/" + key + "ComplexRestrictions")}</td></tr>
                {/each}</tbody>
              </table>
            {/if}
          </div>
        </div>
      {/each}
    </section>
  </aside>

  <section class="panel results">
    <h3>{systems === undefined ? "…" : systems === null ? word("UI/Agency/currentlyUnavailable") : word("UI/Agency/ShowingXResults", { numResults: systems.length })}</h3>
    <div class="cards">
      {#each systems ?? [] as system (system.solarSystemID)}
        {@const icon = factionIcon(system.occupation.occupierID)}
        {@const fraction = contested(system)}
        <button type="button" class="card" aria-pressed={selected?.solarSystemID === system.solarSystemID}
          onclick={() => (selectedID = system.solarSystemID)}>
          {#if icon}<img src={icon} alt="" title={factionName(system.occupation.occupierID)} />{/if}
          <strong>{location(system)}</strong>
          <span>{jumps(system)}</span>
          <small>{adjacency(system)}</small>
          {#if status(system)}<small class="capture">
            {#if fraction > 0}<span class="gauge" aria-hidden="true"
              style:background={'conic-gradient(' + (WARZONE_FACTION_COLORS[system.occupation.attackerID ?? 0] ?? "#888") + " " + fraction * 100 + '%, ' + (WARZONE_FACTION_COLORS[system.occupation.occupierID] ?? "#888") + " 0)"}></span>{/if}
            {status(system)}
          </small>{/if}
        </button>
      {:else}
        {#if systems !== undefined && systems !== null}<p>{word("UI/Common/NothingFound")}</p>{/if}
      {/each}
    </div>
  </section>

  <section class="panel details">
    {#if selected}
      {@const icon = factionIcon(selected.occupation.occupierID)}
      <h3>{location(selected)}</h3>
      <div class="occupier">
        {#if icon}<img alt="" src={icon} />{/if}
        <div>
          <p>{adjacency(selected, true)}</p>
          <p>{word(A + "systemOccupierLabel", { factionID: selected.occupation.occupierID, typeID: 30 }) || factionName(selected.occupation.occupierID)}</p>
          {#if status(selected)}<p title={statusHint(selected)} style:color={statusColor(selected)}>{word(A + "systemStatusLabel", { systemStatusText: status(selected), color: statusColor(selected) }) || status(selected)}</p>{/if}
          {#if upgrade}<p>{word(A + "systemUpgradeLevel", { level: upgrade.level })}</p>{/if}
        </div>
      </div>
      {#if upgrade && lp !== null}
        <div class="lp"><span>{lpText(lp)}</span><span>{lpText(upgrade.next)}</span></div>
        <progress value={upgrade.progress} max="1" aria-label={word(A + "systemUpgradeLevel", { level: upgrade.level })}
          title={upgrade.capped ? "" : word(F + "IHub/LevelUnlockHint", { num: lp - upgrade.previous, numTotal: upgrade.next - upgrade.previous })}></progress>
        <div class="benefits">
          {#each [upgrade.level, upgrade.level + 1] as level, index (level)}
            <div class:preview={index === 1}>
              {#each agencyFactionWarfareBenefits(level) as benefit (benefit.kind)}
                <span title={word(F + "IHub/" + benefits[benefit.kind].hint, { num: benefit.value })}>
                  <img alt="" src={clientTexture("res:/ui/texture/classes/FWInfrastructureHub/" + benefits[benefit.kind].texture)} />
                  {benefit.value}%
                </span>
              {/each}
            </div>
          {/each}
        </div>
      {/if}
      <AgencySystemSiteList {flow} {store} system={selected} label={A + "sitesInSystem"} {word} provider="factional_warfare" {hub} />
    {/if}
  </section>
</div>

<style>
  .agency-fw { display: grid; grid-template-columns: minmax(165px, 300px) minmax(180px, 331px) minmax(220px, 400px); gap: 10px; justify-content: center; height: 100%; min-height: 0; }
  aside { display: flex; flex-direction: column; gap: 16px; position: relative; min-height: 0; }
  .panel { position: static; padding: 8px 10px; border: 1px solid rgb(255 255 255 / 0.08); background: rgb(0 0 0 / 0.3); }
  h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
  p { margin: 0 0 4px; font-size: 12px; }
  label { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; font-size: 12px; }
  select { min-width: 0; }
  .reset { display: flex; justify-content: flex-end; }
  .information button { display: flex; align-items: center; gap: 8px; border: 0; background: none; font: inherit; font-size: 12px; padding: 5px 0; cursor: help; }
  .information button img { width: 16px; height: 16px; }
  [role="tooltip"] { visibility: hidden; position: absolute; z-index: 5; left: calc(100% + 6px); top: 8px; width: clamp(300px, 33vw, 400px); max-height: calc(100% - 16px); overflow-y: auto; padding: 9px; border: 1px solid #53636f; background: #14191f; color: #ebeff2; font-size: 12px; white-space: pre-line; }
  aside:not(:has([role="tooltip"].open)) .information:hover [role="tooltip"]:not(.dismissed),
  button:focus-visible + [role="tooltip"]:not(.dismissed), [role="tooltip"].open { visibility: visible; }
  [role="tooltip"] p + p { margin-top: 8px; }
  [role="tooltip"] table { width: 100%; border-collapse: collapse; }
  [role="tooltip"] th, [role="tooltip"] td { text-align: left; vertical-align: top; padding: 3px 4px; }
  [role="tooltip"] td { border-top: 1px solid rgb(255 255 255 / 0.08); }
  .results { display: flex; flex-direction: column; min-height: 0; }
  .cards { display: flex; flex-direction: column; gap: 12px; overflow: auto; }
  .card { position: relative; flex: none; display: flex; flex-direction: column; gap: 3px; min-height: 86px; padding: 8px 42px 8px 10px; text-align: left; cursor: pointer; }
  .card[aria-pressed="true"] { border-color: rgb(255 255 255 / 0.6); background: rgb(255 255 255 / 0.1); }
  .card strong { font-size: 14px; }
  .card img { position: absolute; top: 5px; right: 5px; width: 32px; height: 32px; }
  .capture { display: flex; align-items: center; gap: 4px; }
  .gauge { width: 16px; height: 16px; border-radius: 50%; box-shadow: inset 0 0 0 2px rgb(0 0 0 / 0.4); }
  .details { overflow: auto; }
  .occupier { display: flex; align-items: center; gap: 10px; min-height: 64px; }
  .occupier img { width: 64px; height: 64px; flex: none; }
  .lp { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px; font-size: 12px; }
  progress { width: 100%; height: 8px; accent-color: var(--eve-accent, #80a4c3); }
  .benefits { display: flex; justify-content: space-between; margin-top: 10px; min-height: 42px; font-size: 11px; }
  .benefits > div { display: flex; gap: 10px; align-items: start; }
  .benefits .preview { opacity: 0.5; }
  .benefits span { display: grid; justify-items: center; min-width: 26px; }
  .benefits img { width: 26px; height: 26px; opacity: 0.75; }
</style>
