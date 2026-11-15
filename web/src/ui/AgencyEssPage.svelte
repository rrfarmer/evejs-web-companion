<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { StarMapData } from "../app/api.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { DISTANCE } from "../bridge/agencyAgents.ts";
  import { DEFAULT_ESS_FILTERS, ESS_REGION, type AgencyEssFilters, type AgencyEssSystem, type EssDetails, type EssSettings } from "../bridge/agencyEss.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { MIN_WARP_DISTANCE } from "../bridge/probeResults.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { resolvedName } from "../store/names.ts";

  let { flow, store, filters = $bindable(DEFAULT_ESS_FILTERS) }: {
    flow: AppFlow; store: ClientStore; filters?: AgencyEssFilters;
  } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const waypoints = flow.waypoints;
  // svelte-ignore state_referenced_locally
  const warpDistance = flow.warpDistance;
  const A = "UI/Agency/ESS/";
  const T = "UI/Agency/Tooltips/Exploration/ESS/";
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  const distances = [DISTANCE.currentSystem, DISTANCE.two, DISTANCE.five, DISTANCE.ten, DISTANCE.any, ESS_REGION];
  const explanation = [
    ["ESSGameplay", "ESSGameplayTooltip"], ["ESSMainBank", "ESSMainBankTooltip"],
    ["ESSReserveBank", "ESSReserveBankTooltip"], ["DynamicBounties", "DynamicBounties"],
  ] as const;
  const timings = ["Long", "Medium", "Short"];
  const timingColors = ["#5ce03f", "#ff8a00", "#f81622"];
  const payouts = ["Inactive", "Increasing", "Peak", "Decreasing"];
  const payoutSegments = [
    { label: "RisingPayoutRate", color: "#f81622" },
    { label: "PeakPayoutRate", color: "#5ce03f" },
    { label: "PayoutRateDecreasing", color: "#ff8a00" },
  ];
  const labels = [
    "UI/Calendar/CalendarWindow/Filters", "UI/Common/Location", "UI/Generic/CurrentSystem",
    "UI/Common/WithinJumps", "UI/Agency/ContentOfAnyDistance", "UI/Agency/SpecificRegion",
    "UI/Common/LocationTypes/Region", "UI/Common/LocationTypes/Constellation", "UI/Agency/CurrentRegion",
    "UI/Agency/AnyConstellation", "UI/Commands/ResetAll", "UI/Common/Min", "UI/Common/Max",
    "UI/Agency/Location", "UI/Generic/NoGateToGateRoute", "UI/Common/NumJumps", "UI/Agency/ShowingXResults",
    "UI/Inflight/Scanner/FilteredResults", "UI/Agency/currentlyUnavailable", "UI/Common/Unknown",
    "UI/Wallet/WalletWindow/ISK", "UI/Inflight/SetDestination", "UI/Inflight/DestinationSet",
    "UI/Inflight/WarpToBookmark", "UI/Inflight/Warping", "UI/Neocom/UndockBtn", "UI/Agency/DisabledHintAlreadyThere",
    ...["BankFilters", "DataDelayNotice", "ESSSystemInfo", "DynamicBounties", "BountiesOutput",
      "MainBank", "ReserveBank", "MinMainBankAmount", "MinReserveBankAmount", "ReserveBankUnlocked",
      "BankAmount", "TimeToAutoPayment", "ActiveLinks", "TimeChosen", "PayoutRate", ...timings, ...payouts,
      ...explanation.map(([label]) => label)].map((key) => A + key),
    ...["MainBankAmount", "ReserveBankAmount", "TimeToAutoPayment", "ActiveLinks", "TimeChosen",
      "PayoutRate", "BountiesOutputTooltip", ...explanation.map(([, hint]) => hint),
      ...payoutSegments.map((segment) => segment.label)].map((key) => T + key),
  ];
  const word = (label: string, args: TemplateArguments = {}) => plainText(formatTemplate($words.templates[label] ?? "", args, {
    nameOf: (kind, id) => resolvedName($names.resolved, kind, id, ""),
  }));
  const here = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const docked = $derived($flight.status?.docked ?? !!$station.online?.stationID);
  const inWarp = $derived(($space.snapshot?.ship?.mode ?? $flight.status?.shipMode) === "WARP");
  let map = $state<StarMapData | null>(null);
  const hereRegion = $derived(map?.systems.find(([id]) => id === here)?.[5] ?? null);
  const regions = $derived((map?.regions ?? []).filter(([id]) => id < 11000000).slice().sort((a, b) => a[4].localeCompare(b[4])));
  const constellations = $derived((map?.constellations ?? []).filter((row) => row[5] === filters.regionID)
    .sort((a, b) => a[4].localeCompare(b[4])));
  let settings = $state<EssSettings | null>(null);
  let rows = $state<readonly AgencyEssSystem[] | null | undefined>(undefined);
  let selectedID = $state<number | null>(null);
  const selected = $derived(rows?.find((row) => row.solarSystemID === selectedID) ?? rows?.[0] ?? null);
  const destinationSet = $derived($waypoints.at(-1) === selected?.solarSystemID);
  let details = $state<EssDetails | null>(null);
  let beacon = $state<number | null>(null);
  const beaconTooClose = $derived.by(() => {
    const snapshot = $space.snapshot;
    if (!snapshot?.ship || snapshot.solarSystemID !== here || beacon === null) return false;
    const entrance = snapshot.entities.find((entity) => entity.itemID === beacon && entity.geometryAvailable !== false);
    if (!entrance) return false;
    const from = snapshot.ship.position, to = entrance.position;
    return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) <= MIN_WARP_DISTANCE;
  });
  let busy = $state(false);
  let error = $state<string | null>(null);
  const early = $derived(Math.max(0, Math.min(1, settings?.earlyPayout ?? 0)));
  const late = $derived((1 - early) * Math.max(0, Math.min(1, settings?.latePayout ?? 0)));
  const widths = $derived([early, 1 - early - late, late]);

  $effect(() => {
    flow.requestWords(labels);
    let current = true;
    void flow.loadStarMap().then((value) => { if (current) map = value; }, () => {});
    void flow.agencyEssSettings().then((value) => { if (current) settings = value; }, () => {});
    return () => { current = false; };
  });
  $effect(() => {
    void here;
    const options = filters;
    let current = true;
    void flow.agencyEssSystems(options).then(
      (value) => { if (current) rows = value; },
      () => { if (current) rows = null; },
    );
    return () => { current = false; };
  });
  $effect(() => {
    const id = selected?.solarSystemID;
    details = null;
    error = null;
    if (id === undefined) return;
    let current = true;
    void flow.agencyEssDetails(id).then((value) => { if (current) details = value; }, () => {});
    return () => { current = false; };
  });
  $effect(() => {
    const local = here !== null && selected?.solarSystemID === here && !docked;
    beacon = null;
    if (!local) return;
    let current = true;
    void flow.agencyEssBeacon().then((value) => { if (current) beacon = value; }, () => {});
    return () => { current = false; };
  });

  const set = (patch: Partial<AgencyEssFilters>) => { filters = { ...filters, ...patch }; };
  function changeDistance(distance: number): void {
    set(distance === ESS_REGION ? { distance, regionID: hereRegion, constellationID: null } : { distance });
  }
  function changeAmount(key: "mainMinimum" | "reserveMinimum", input: HTMLInputElement): void {
    if (Number.isSafeInteger(input.valueAsNumber) && input.valueAsNumber >= 0) set({ [key]: input.valueAsNumber });
  }
  function changeOutput(key: "minOutput" | "maxOutput", input: HTMLInputElement): void {
    const value = input.valueAsNumber;
    if (!settings || !Number.isSafeInteger(value) || value < settings.outputFloor || value > settings.outputCeiling) return;
    set(key === "minOutput" ? { minOutput: value, maxOutput: Math.max(value, filters.maxOutput) } : { maxOutput: value });
  }
  function distanceLabel(value: number): string {
    if (value === DISTANCE.currentSystem) return word("UI/Generic/CurrentSystem");
    if (value === DISTANCE.any) return word("UI/Agency/ContentOfAnyDistance");
    if (value === ESS_REGION) return word("UI/Agency/SpecificRegion");
    return word("UI/Common/WithinJumps", { numJumps: value });
  }
  function location(system: AgencyEssSystem): string {
    const security = system.location?.security;
    return word("UI/Agency/Location", { location: system.solarSystemID, secStatus: security == null ? "" : shownSecurity(security).toFixed(1) })
      || resolvedName($names.resolved, "system", system.solarSystemID, "");
  }
  function jumps(system: AgencyEssSystem): string {
    if (system.solarSystemID === here) return word("UI/Generic/CurrentSystem");
    return system.jumps === null ? word("UI/Generic/NoGateToGateRoute") : word("UI/Common/NumJumps", { numJumps: system.jumps });
  }
  const isk = (value: number, short = false) => (short ? compact : number).format(value) + " " + word("UI/Wallet/WalletWindow/ISK");
  const output = (value: number) => number.format(Math.round(value * 10_000) / 100) + "%";
  const secondsToTicks = (seconds: number) => seconds * 10_000_000;
  function explanationText(hint: string): string {
    if (!settings || hint === "DynamicBounties") return word(T + hint);
    if (hint === "ESSGameplayTooltip" && settings.bountiesCut !== null) {
      return word(T + hint, { essBountiesCut: Math.trunc(settings.bountiesCut * 100) });
    }
    if (hint === "ESSReserveBankTooltip" && settings.reserveMax !== null) {
      return word(T + hint, { reserveBankMaxPayout: settings.reserveMax, timeAccessFactor: Math.trunc(settings.reserveAccess) });
    }
    if (hint === "ESSMainBankTooltip" && settings.mainPayRatio !== null && settings.autopaySeconds !== null && settings.bufferSeconds !== null) {
      const pay = settings.mainPayRatio * 100;
      return word(T + hint, { autoPayInterval: secondsToTicks(settings.autopaySeconds), bufferTime: secondsToTicks(settings.bufferSeconds),
        payPercentile: pay, inversePayPercentile: 100 - pay });
    }
    return "";
  }
  function chosenTime(pulses: number): string {
    const hours = Math.floor(pulses / 60), minutes = pulses % 60;
    return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
  }
  async function travel(): Promise<void> {
    if (!selected || busy) return;
    const systemID = selected.solarSystemID;
    busy = true;
    error = null;
    try {
      if (systemID !== here) await flow.setDestination(systemID);
      else if (docked) await flow.undock();
      else if (beacon !== null) await flow.warpTo(beacon, $warpDistance || 0);
    } catch (cause) {
      if (selected?.solarSystemID === systemID) error = panelErrorWords(cause);
    } finally {
      busy = false;
    }
  }
</script>

<div class="ess-page">
  <aside class="panel">
    <h3>{word("UI/Calendar/CalendarWindow/Filters")}</h3>
    <label class="select">{word("UI/Common/Location")}
      <select value={filters.distance} onchange={(e) => changeDistance(Number(e.currentTarget.value))}>
        {#each distances as value (value)}<option {value}>{distanceLabel(value)}</option>{/each}
      </select>
    </label>
    {#if filters.distance === ESS_REGION}
      <label class="select">{word("UI/Common/LocationTypes/Region")}
        <select value={filters.regionID ?? ""} onchange={(e) => set({ regionID: Number(e.currentTarget.value), constellationID: null })}>
          {#if filters.regionID === null}<option value="" disabled>{word("UI/Common/Unknown")}</option>{/if}
          {#each regions as [id, , , , name] (id)}
            <option value={id}>{id === hereRegion ? word("UI/Agency/CurrentRegion", { regionName: name }) : name}</option>
          {/each}
        </select>
      </label>
      <label class="select">{word("UI/Common/LocationTypes/Constellation")}
        <select value={filters.constellationID ?? ""} onchange={(e) => set({ constellationID: Number(e.currentTarget.value) || null })}>
          <option value="">{word("UI/Agency/AnyConstellation")}</option>
          {#each constellations as [id, , , , name] (id)}<option value={id}>{name}</option>{/each}
        </select>
      </label>
    {/if}
    <h4>{word(A + "BankFilters")}</h4>
    <label class="checkbox">{word(A + "BountiesOutput")}
      <input type="checkbox" checked={filters.outputEnabled} disabled={!settings} onchange={(e) => set({ outputEnabled: e.currentTarget.checked })} />
    </label>
    <div class="number-pair">
      <label>{word("UI/Common/Min")} <input type="number" value={filters.minOutput} min={settings?.outputFloor} max={settings?.outputCeiling} disabled={!settings}
        oninput={(e) => changeOutput("minOutput", e.currentTarget)} onblur={(e) => (e.currentTarget.value = String(filters.minOutput))} />%</label>
      <label>{word("UI/Common/Max")} <input type="number" value={filters.maxOutput} min={settings?.outputFloor} max={settings?.outputCeiling} disabled={!settings}
        oninput={(e) => changeOutput("maxOutput", e.currentTarget)} onblur={(e) => (e.currentTarget.value = String(filters.maxOutput))} />%</label>
    </div>
    <div class="bank-filter">
      <label class="checkbox">{word(A + "MinMainBankAmount")}
        <input type="checkbox" checked={filters.mainEnabled} onchange={(e) => set({ mainEnabled: e.currentTarget.checked })} />
      </label>
      <input type="number" min="0" value={filters.mainMinimum} aria-label={word(A + "MinMainBankAmount")}
        oninput={(e) => changeAmount("mainMinimum", e.currentTarget)} onblur={(e) => (e.currentTarget.value = String(filters.mainMinimum))} />
    </div>
    <label class="checkbox">{word(A + "ReserveBankUnlocked")}
      <input type="checkbox" checked={filters.unlocked} onchange={(e) => set({ unlocked: e.currentTarget.checked })} />
    </label>
    <div class="bank-filter">
      <label class="checkbox">{word(A + "MinReserveBankAmount")}
        <input type="checkbox" checked={filters.reserveEnabled} onchange={(e) => set({ reserveEnabled: e.currentTarget.checked })} />
      </label>
      <input type="number" min="0" value={filters.reserveMinimum} aria-label={word(A + "MinReserveBankAmount")}
        oninput={(e) => changeAmount("reserveMinimum", e.currentTarget)} onblur={(e) => (e.currentTarget.value = String(filters.reserveMinimum))} />
    </div>
    <p class="data-delay">{word(A + "DataDelayNotice")}</p>
    <div class="reset"><button type="button" onclick={() => (filters = DEFAULT_ESS_FILTERS)}>{word("UI/Commands/ResetAll")}</button></div>
    <ul class="help">
      {#each explanation as [label, hint] (label)}
        <li><abbr title={explanationText(hint)}>{word(A + label)}</abbr></li>
      {/each}
    </ul>
  </aside>

  <section class="panel results" aria-busy={rows === undefined}>
    {#if rows !== undefined}
      <h3>{rows === null ? word("UI/Agency/currentlyUnavailable") : rows.length
        ? word("UI/Agency/ShowingXResults", { numResults: rows.length }) : word("UI/Inflight/Scanner/FilteredResults")}</h3>
    {/if}
    <div class="cards">
      {#each rows ?? [] as system (system.solarSystemID)}
        <button type="button" class="card" aria-pressed={system.solarSystemID === selected?.solarSystemID} onclick={() => (selectedID = system.solarSystemID)}>
          <strong>{location(system)}</strong><span class="output">{output(system.output)}</span>
          <span>{jumps(system)}</span>
          <span>{word(A + "MainBank")} <b>{isk(system.main, true)}</b></span>
          <span>{word(A + "ReserveBank")} <b>{isk(system.reserve, true)}</b>
            {#if system.unlocked}<span class="unlocked" title={word(A + "ReserveBankUnlocked")}> ◉</span>{/if}
          </span>
        </button>
      {/each}
    </div>
  </section>

  <section class="panel details">
    {#if selected}
      <h3>{word(A + "ESSSystemInfo")}</h3>
      <strong>{location(selected)}</strong> <span>{jumps(selected)}</span>
      <h4>{word(A + "DynamicBounties")}</h4>
      <dl><dt title={settings?.outputIntervalSeconds != null ? word(T + "BountiesOutputTooltip", { bountiesOutputTimeInterval: secondsToTicks(settings.outputIntervalSeconds) }) : ""}>{word(A + "BountiesOutput")}</dt><dd>{output(selected.output)}</dd></dl>
      <h4>{word(A + "MainBank")}</h4>
      <dl>
        <dt title={word(T + "MainBankAmount")}>{word(A + "BankAmount")}</dt><dd>{isk(selected.main)}</dd>
        <dt title={word(T + "TimeToAutoPayment")}>{word(A + "TimeToAutoPayment")}</dt>
        <dd>{#if details}<span class="timing" style:--fill={(details.autopayment + 1) * 25 + "%"} style:--color={timingColors[details.autopayment]}>{word(A + timings[details.autopayment])}</span>{:else}–{/if}</dd>
      </dl>
      <h4>{word(A + "ReserveBank")}</h4>
      <dl>
        <dt title={word(T + "ReserveBankAmount")}>{word(A + "BankAmount")}</dt><dd>{isk(selected.reserve)}</dd>
        <dt title={word(T + "ActiveLinks")}>{word(A + "ActiveLinks")}</dt><dd>{details?.links ?? "–"}</dd>
        <dt title={details && settings ? word(T + "TimeChosen", { timeChosen: details.chosenSeconds / 60, timeFactor: settings.reserveAccess }) : ""}>{word(A + "TimeChosen")}</dt>
        <dd>{details?.payout && details.pulses ? chosenTime(details.pulses) : "–"}</dd>
      </dl>
      {#if details && settings}
        <p title={word(T + "PayoutRate")}>{word(A + "PayoutRate", { payoutRate: word(A + payouts[details.payout]), color: details.payout ? payoutSegments[details.payout - 1]?.color ?? "" : "#808080" })}</p>
        <div class="payout" aria-hidden="true">
          {#each payoutSegments as segment, i (segment.label)}
            <span title={word(T + segment.label)} style:width={widths[i] * 100 + "%"} style:background={segment.color} class:active={details.payout === i + 1}></span>
          {/each}
        </div>
      {/if}
      <button class="primary" type="button" title={beaconTooClose ? word("UI/Agency/DisabledHintAlreadyThere") : ""}
        disabled={busy || (selected.solarSystemID !== here ? destinationSet : !docked && (inWarp || beacon === null || beaconTooClose))}
        onclick={() => void travel()}>
        {selected.solarSystemID !== here ? word(destinationSet ? "UI/Inflight/DestinationSet" : "UI/Inflight/SetDestination")
          : docked ? word("UI/Neocom/UndockBtn") : word(inWarp ? "UI/Inflight/Warping" : "UI/Inflight/WarpToBookmark")}
      </button>
      {#if error}<p role="status">{error}</p>{/if}
    {/if}
  </section>
</div>

<style>
  .ess-page { display: grid; grid-template-columns: minmax(175px, 280px) minmax(190px, 340px) minmax(235px, 400px); gap: 10px; justify-content: center; height: 100%; min-height: 0; }
  .panel { min-width: 0; padding: 10px; border: 1px solid rgb(255 255 255 / 0.08); background: rgb(0 0 0 / 0.3); font-size: 12px; }
  aside, .details { overflow: auto; }
  h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
  h4 { margin: 12px 0 5px; font-size: 13px; border-bottom: 1px solid rgb(255 255 255 / 0.14); padding-bottom: 4px; }
  .select { display: grid; gap: 2px; margin-bottom: 8px; }
  select, input { min-width: 0; }
  input[type=number] { width: 100%; box-sizing: border-box; }
  .checkbox { display: flex; justify-content: space-between; align-items: center; margin: 6px 0; }
  .bank-filter { display: grid; grid-template-columns: 1fr 88px; gap: 6px; align-items: center; margin: 5px 0; }
  .number-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .number-pair label { display: flex; align-items: center; gap: 3px; }
  .data-delay { opacity: 0.7; white-space: normal; }
  .reset { display: flex; justify-content: flex-end; }
  .help { margin: 12px 0 0; padding: 8px 0 0; border-top: 1px solid rgb(255 255 255 / 0.14); display: grid; grid-template-columns: 1fr 1fr; list-style: none; gap: 6px; white-space: normal; }
  .results, .cards { display: flex; flex-direction: column; min-height: 0; }
  .cards { overflow: auto; gap: 8px; }
  .card { display: grid; grid-template-columns: 1fr auto; text-align: left; padding: 8px; gap: 4px 8px; }
  .card[aria-pressed=true] { border-color: rgb(255 255 255 / 0.6); background: rgb(255 255 255 / 0.1); }
  .card strong, .output { font-size: 14px; }
  .card > :nth-child(3) { grid-column: span 2; opacity: 0.75; }
  .card b { display: block; font-weight: 500; }
  .unlocked { color: #5ce03f; }
  .details > span { opacity: 0.75; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin: 0; align-items: center; }
  dd { margin: 0; text-align: right; }
  .timing { display: inline-block; width: 96px; padding: 3px 6px; text-align: center; border: 1px solid rgb(255 255 255 / 0.25); background: linear-gradient(90deg, color-mix(in srgb, var(--color) 40%, transparent) 0 var(--fill), transparent var(--fill)); }
  .payout { display: flex; width: 100%; height: 18px; }
  .payout span { opacity: 0.2; }
  .payout .active { opacity: 0.8; }
  .primary { width: 100%; margin-top: 12px; min-height: 27px; }
</style>
