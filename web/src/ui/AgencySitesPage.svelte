<script lang="ts">
  // agencyNew/ui/contentPages/contentPageCombatAnomalies.ContentPageCombatAnomalies (a SingleColumnContentPage): the
  // left column its filters (BaseFiltersCont: the location and the security status, Reset All) over the Information
  // section (UI/Agency/CombatSiteTypes); the scroll section (CONTENTCARD_WIDTH + 31) "Showing X results" and the systems'
  // cards (AnomalySystemContentCard: the system and its security, the jumps, NumberOfAnomaliesInSystem); and the info
  // container (CombatAnomalyInfoContainer, 400, "Sites in system"): the system's line, its sites' list (150 high: each
  // site's name, UnknownCombatAnomaly for one only counted), the first chosen; the chosen site's Difficulty
  // (UI/Agency/ContentDifficulty: LevelX, or Unknown) and Roaming Enemies (its faction, or Unknown), and the system's
  // primary button (Set Destination / Destination Set elsewhere, Undock in a station of the system).
  // The ore anomalies and ice belts (ContentPageOreAnomalies / ContentPageIceBelts, ContentPageResourceHarvesting): the
  // card's bottom NumberOfBeltsInSystem and the system's resource types' 20 px icons (eight, then a plus); the info
  // container ResourceHarvestingInfoContainer (Belts in system, 100 high, UnknownOreAnomaly / UnknownIceBelt), the chosen
  // belt's types (Ore types in belt: a two-column grid, each its icon and name; Unknown for none) and the enemies; the
  // Information section ProbeScanning, or IceAvailability and IceReprocessing.
  // The cosmic signatures (ContentPageSignatures, SignatureInfoContainer): NumberOfSignaturesInSystem, Signatures in
  // system (each the signature's targetID, its icon in GetResultColor of its signal strength; UnknownCosmicSignature for
  // one only counted) and the SignaturesNote warning in WARNING_ORANGE; Information ProbeScanning and SignatureTypes.
  // The escalations (ContentPageEscalations, no filters; EscalationInfoContainer 450 wide): NumberOfEscalationsInSystem,
  // the EscalationDescription warning (the system's name) over Escalations in system (100 high), Expires in (the time
  // left, short), Difficulty and the hostiles.
  // Not here (later parts): the region distance, the system's other actions in it (warp to a scanned site), the enemy's
  // logo and the region's pirate faction for a belt (GetPirateFactionsOfRegion), the job's Track button, the tooltips,
  // the extra types' tooltip, the signature pages.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { DISTANCE, ANY, SECURITY_FILTER } from "../bridge/agencyAgents.ts";
  import { DEFAULT_SITE_FILTERS, type AgencySiteFilters, type AgencySiteSystem, type SiteTrackerKind } from "../bridge/agencySites.ts";
  import { resultColor } from "../bridge/probeResults.ts";
  import { typeIconUrl } from "./typeIcons.ts";

  let { store, flow, kind = "combat", filters = $bindable(DEFAULT_SITE_FILTERS) }: { store: ClientStore; flow: AppFlow; kind?: SiteTrackerKind | "signature" | "escalation"; filters?: AgencySiteFilters } = $props();
  const escalations = $derived(kind === "escalation");
  const belts = $derived(kind === "ore" || kind === "ice");
  const signatures = $derived(kind === "signature");
  const UNKNOWN = { combat: "UI/Agency/UnknownCombatAnomaly", ore: "UI/Agency/UnknownOreAnomaly", ice: "UI/Agency/UnknownIceBelt", signature: "UI/Agency/UnknownCosmicSignature", escalation: "UI/Common/Unknown" } as const;
  const INFO = { combat: ["UI/Agency/CombatSiteTypes"], ore: ["UI/Agency/ProbeScanning"], ice: ["UI/Agency/IceAvailability", "UI/Agency/IceReprocessing"],
    signature: ["UI/Agency/ProbeScanning", "UI/Agency/SignatureTypes"], escalation: [] } as const;
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
  let systems = $state<readonly AgencySiteSystem[] | null | undefined>(undefined);
  let chosen = $state<number | null>(null), site = $state(0);
  let asked = 0;
  $effect(() => {
    const f = filters, k = kind, n = ++asked;
    systems = undefined;
    void (k === "signature" ? flow.agencySignatures(f) : k === "escalation" ? flow.agencyEscalations() : flow.agencyTrackerSites(k, f)).then((list) => { if (n !== asked) return; systems = list; chosen = list?.[0]?.solarSystemID ?? null; site = 0; });
  });
  const chosenSystem = $derived(systems?.find((s) => s.solarSystemID === chosen) ?? null);
  const chosenSite = $derived(chosenSystem?.sites[site]);
  $effect(() => {
    flow.requestWords(["UI/Agency/ShowingXResults", "UI/Inflight/Scanner/FilteredResults", "UI/Agency/Location", "UI/Common/NumJumps", "UI/Generic/CurrentSystem",
      "UI/Generic/NoGateToGateRoute", "UI/Agency/NumberOfAnomaliesInSystem", "UI/Agency/SitesInSystem", "UI/Agency/UnknownCombatAnomaly", "UI/Agency/ContentDifficulty",
      "UI/Agency/LevelX", "UI/Common/Unknown", "UI/Agency/RoamingEnemies", "UI/Common/NothingFound", "UI/Common/Location", "UI/Generic/CurrentSystem", "UI/Common/WithinJumps",
      "UI/Agency/ContentOfAnyDistance", "Tooltips/CharacterSheet/SecurityStatus", "UI/Agency/AnySecurity", "UI/Common/HighSec", "UI/Common/LowSec", "UI/Common/NullSec",
      "UI/Calendar/CalendarWindow/Filters", "UI/Commands/ResetAll", "UI/Agency/resetAllPageFilters", "UI/Common/Information", "UI/Agency/CombatSiteTypes",
      "UI/Neocom/UndockBtn", "UI/Inflight/SetDestination", "UI/Inflight/DestinationSet", "UI/Agency/NumberOfBeltsInSystem", "UI/Agency/BeltsInSystem",
      "UI/Agency/OreTypesInBelt", "UI/Agency/NumberOfSignaturesInSystem", "UI/Agency/SignaturesInSystem", "UI/Agency/SignaturesNote", "UI/Agency/NumberOfEscalationsInSystem", "UI/Agency/EscalationsInSystem",
      "UI/Agency/EscalationDescription", "UI/Market/Marketbase/ExpiresIn", UNKNOWN[kind], ...INFO[kind],
      ...(chosenSystem?.sites ?? []).map((s) => s?.dungeonNameID).filter((x): x is number => !!x).map((x) => `#${x}`)]);
  });

  const hereStation = $derived($station.online?.stationID ?? null);
  const hereSystem = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const secText = (s: AgencySiteSystem) => (s.security === null ? "" : shownSecurity(s.security).toFixed(1));
  /** GetSystemAndSecurityText. */
  const systemText = (s: AgencySiteSystem) => word("UI/Agency/Location", { location: s.solarSystemID, secStatus: secText(s) });
  /** GetNumJumpsText. */
  const jumpsText = (s: AgencySiteSystem) => (s.solarSystemID === hereSystem ? word("UI/Generic/CurrentSystem")
    : s.jumps !== null ? word("UI/Common/NumJumps", { numJumps: s.jumps }) : word("UI/Generic/NoGateToGateRoute"));
  type Action = "undock" | "setDestination" | "destinationSet" | null;
  const LABEL: Record<Exclude<Action, null>, string> = { undock: "UI/Neocom/UndockBtn", setDestination: "UI/Inflight/SetDestination", destinationSet: "UI/Inflight/DestinationSet" };
  function actionOf(s: AgencySiteSystem): Action {
    if (s.solarSystemID === hereSystem) return hereStation !== null ? "undock" : null;
    const last = $waypoints[$waypoints.length - 1];
    return last === s.solarSystemID ? "destinationSet" : "setDestination";
  }
  let busy = $state(false);
  async function act(s: AgencySiteSystem): Promise<void> {
    const action = actionOf(s);
    if (busy || action === null || action === "destinationSet") return;
    busy = true;
    try { if (action === "undock") await flow.undock(); else flow.setDestination(s.solarSystemID); } finally { busy = false; }
  }
  // FormatTimeIntervalShortWritten of the time left (ticking each second, as UpdateExpiryTimeThread each 100 ms).
  let nowMs = $state(Date.now());
  $effect(() => { if (!escalations) return; const t = setInterval(() => { nowMs = Date.now(); }, 1000); return () => clearInterval(t); });
  function shortLeft(expiry: string): string {
    const left = Math.max(0, Math.floor((Number(BigInt(expiry) - 116_444_736_000_000_000n) / 10_000 - nowMs) / 1000));
    const d = Math.floor(left / 86400), h = Math.floor((left % 86400) / 3600), m = Math.floor((left % 3600) / 60), sec = left % 60;
    return [d ? `${d}d` : "", h ? `${h}h` : "", m ? `${m}m` : "", `${sec}s`].filter(Boolean).join(" ");
  }
  const set = (patch: Partial<AgencySiteFilters>) => { filters = { ...filters, ...patch }; };
  const DISTANCES = [DISTANCE.currentSystem, DISTANCE.two, DISTANCE.five, DISTANCE.ten, DISTANCE.any];
  const distanceLabel = (v: number) => (v === DISTANCE.currentSystem ? word("UI/Generic/CurrentSystem") : v === DISTANCE.any ? word("UI/Agency/ContentOfAnyDistance") : word("UI/Common/WithinJumps", { numJumps: v }));
  const SECURITIES = [ANY, SECURITY_FILTER.high, SECURITY_FILTER.low, SECURITY_FILTER.nul];
  const securityLabel = (v: number) => word(v === ANY ? "UI/Agency/AnySecurity" : v === SECURITY_FILTER.high ? "UI/Common/HighSec" : v === SECURITY_FILTER.low ? "UI/Common/LowSec" : "UI/Common/NullSec");
</script>

<div class="asi">
  {#if !escalations}
  <aside class="asi-left">
    <section class="asi-section">
      <h3>{word("UI/Calendar/CalendarWindow/Filters")}</h3>
      <label><span>{word("UI/Common/Location")}</span>
        <select value={filters.distance} onchange={(e) => set({ distance: Number(e.currentTarget.value) })}>{#each DISTANCES as v (v)}<option value={v}>{distanceLabel(v)}</option>{/each}</select></label>
      <label><span>{word("Tooltips/CharacterSheet/SecurityStatus")}</span>
        <select value={filters.security} onchange={(e) => set({ security: Number(e.currentTarget.value) })}>{#each SECURITIES as v (v)}<option value={v}>{securityLabel(v)}</option>{/each}</select></label>
      <div class="asi-reset"><button type="button" title={word("UI/Agency/resetAllPageFilters")} onclick={() => (filters = DEFAULT_SITE_FILTERS)}>{word("UI/Commands/ResetAll")}</button></div>
    </section>
    <section class="asi-section"><h3>{word("UI/Common/Information")}</h3>{#each INFO[kind] as label (label)}<p class="asi-info">ⓘ {word(label)}</p>{/each}</section>
  </aside>
  {/if}
  <section class="asi-section asi-scroll">
    <h3>{systems?.length ? word("UI/Agency/ShowingXResults", { numResults: systems.length }) : systems === undefined ? "…" : word("UI/Inflight/Scanner/FilteredResults")}</h3>
    <div class="asi-cards">
      {#each systems ?? [] as s (s.solarSystemID)}
        <button type="button" class="asi-card" class:on={chosen === s.solarSystemID} onclick={() => { chosen = s.solarSystemID; site = 0; }}>
          <b>{systemText(s)}</b><span>{jumpsText(s)}</span>
          {#if belts && s.resourceTypeIDs?.length}
            <span class="asi-types">{#each s.resourceTypeIDs.slice(0, 8) as t (t)}<img alt="" title={resolvedName($names.resolved, "type", t, "")} src={typeIconUrl(t)} />{/each}{#if s.resourceTypeIDs.length > 8}<i title={s.resourceTypeIDs.slice(8).map((t) => resolvedName($names.resolved, "type", t, "")).join(", ")}>+</i>{/if}</span>
          {/if}
          <small>{word(escalations ? "UI/Agency/NumberOfEscalationsInSystem" : signatures ? "UI/Agency/NumberOfSignaturesInSystem" : belts ? "UI/Agency/NumberOfBeltsInSystem" : "UI/Agency/NumberOfAnomaliesInSystem", { amount: s.sites.length })}</small>
        </button>
      {/each}
    </div>
  </section>
  <section class="asi-section asi-details" class:wide={escalations}>
    <h3>{word(escalations ? "UI/Agency/EscalationsInSystem" : signatures ? "UI/Agency/SignaturesInSystem" : belts ? "UI/Agency/BeltsInSystem" : "UI/Agency/SitesInSystem")}</h3>
    {#if chosenSystem}{@const s = chosenSystem}{@const action = actionOf(s)}
      {#if escalations}<p class="asi-warning top">⚠ {word("UI/Agency/EscalationDescription", { systemName: resolvedName($names.resolved, "system", s.solarSystemID, "") })}</p>{/if}
      <div class="asi-system">{systemText(s)}</div>
      <div class="asi-list" class:short={belts || escalations}>
        {#each s.sites as entry, i (i)}
          <button type="button" class="asi-entry" class:on={site === i} onclick={() => (site = i)}>{#if signatures && entry}<i class="asi-dot" style:background={resultColor(entry.signalStrength ?? 0)}></i>{entry.targetID ?? ""}{:else}{entry ? (entry.dungeonNameID ? word(`#${entry.dungeonNameID}`) : "") : word(UNKNOWN[kind])}{/if}</button>
        {:else}<p class="asi-none">{word("UI/Common/NothingFound")}</p>{/each}
      </div>
      {#if signatures}
        <p class="asi-warning">⚠ {word("UI/Agency/SignaturesNote")}</p>
      {:else if chosenSite !== undefined && belts}
        {@const types = chosenSite ? s.siteResourceTypeIDs?.[chosenSite.instanceID] ?? [] : []}
        <h4>{word("UI/Agency/OreTypesInBelt")}</h4>
        <div class="asi-grid">{#each types as t (t)}<span><img alt="" src={typeIconUrl(t)} />{resolvedName($names.resolved, "type", t, "")}</span>{:else}<span>{word("UI/Common/Unknown")}</span>{/each}</div>
        <h4>{word("UI/Agency/RoamingEnemies")}</h4>
        <p>{chosenSite?.factionID ? resolvedName($names.resolved, "owner", chosenSite.factionID, "") : word("UI/Common/Unknown")}</p>
      {:else if chosenSite !== undefined}
        {#if escalations && chosenSite?.expiryTime}
          <h4>{word("UI/Market/Marketbase/ExpiresIn")}</h4>
          <p>{shortLeft(chosenSite.expiryTime)}</p>
        {/if}
        <h4>{word("UI/Agency/ContentDifficulty")}</h4>
        <p>{chosenSite && chosenSite.difficulty !== null ? word("UI/Agency/LevelX", { level: chosenSite.difficulty }) : word("UI/Common/Unknown")}</p>
        <h4>{word("UI/Agency/RoamingEnemies")}</h4>
        <p>{chosenSite?.factionID ? resolvedName($names.resolved, "owner", chosenSite.factionID, "") : word("UI/Common/Unknown")}</p>
      {/if}
      {#if action}<div class="asi-buttons"><button type="button" disabled={busy || action === "destinationSet"} onclick={() => void act(s)}>{word(LABEL[action])}</button></div>{/if}
    {/if}
  </section>
</div>

<style>
  .asi { display: flex; gap: 10px; justify-content: center; height: 100%; min-height: 0; }
  .asi-left { width: 300px; flex: none; display: flex; flex-direction: column; gap: 16px; }
  .asi-section { background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); padding: 8px 10px; }
  .asi-section h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
  .asi-section label { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; font-size: 12px; }
  .asi-section label span { opacity: 0.7; }
  .asi-reset { display: flex; justify-content: flex-end; }
  .asi-info { margin: 0; font-size: 12px; opacity: 0.8; }
  .asi-scroll { width: 331px; flex: none; display: flex; flex-direction: column; min-height: 0; }
  .asi-cards { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding-right: 4px; }
  .asi-card { all: unset; box-sizing: border-box; cursor: pointer; width: 300px; height: 86px; flex: none; display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; font-size: 12px;
    background: rgb(255 255 255 / 0.04); border: 1px solid rgb(255 255 255 / 0.1); }
  .asi-card b { font-size: 14px; }
  .asi-card small { margin-top: auto; opacity: 0.7; }
  .asi-card:hover { background: rgb(255 255 255 / 0.08); }
  .asi-card.on { border-color: rgb(255 255 255 / 0.6); background: rgb(255 255 255 / 0.1); }
  .asi-details { width: 400px; flex: none; overflow: auto; }
  .asi-system { height: 22px; margin-bottom: 10px; font-size: 14px; }
  .asi-list { height: 150px; overflow: auto; background: rgb(0 0 0 / 0.3); }
  .asi-entry { all: unset; box-sizing: border-box; cursor: pointer; display: block; width: 100%; padding: 4px 8px; font-size: 12px; }
  .asi-entry:hover { background: rgb(255 255 255 / 0.06); }
  .asi-entry.on { background: rgb(255 255 255 / 0.14); }
  .asi-list.short { height: 100px; }
  .asi-details.wide { width: 450px; }
  .asi-warning.top { margin: 0 0 10px !important; }
  .asi-dot { display: inline-block; width: 8px; height: 8px; margin-right: 6px; transform: rotate(45deg); }
  .asi-warning { margin-top: 10px !important; padding: 6px 8px; color: #f39058; border: 1px solid rgb(243 144 88 / 0.5); font-size: 12px !important; }
  .asi-types { display: flex; gap: 0; height: 20px; margin: -2px 0 0 2px; }
  .asi-types img { width: 20px; height: 20px; }
  .asi-types i { width: 20px; text-align: center; font-style: normal; opacity: 0.7; }
  .asi-grid { display: grid; grid-template-columns: repeat(2, max-content); gap: 10px 60px; padding: 5px 0; font-size: 12px; }
  .asi-grid span { display: flex; align-items: center; gap: 6px; }
  .asi-grid img { width: 32px; height: 32px; }
  .asi-none { text-align: center; opacity: 0.6; font-size: 12px; }
  .asi-details h4 { margin: 12px 0 2px; font-size: 12px; font-weight: 400; opacity: 0.7; }
  .asi-details p { margin: 0; font-size: 13px; }
  .asi-buttons { display: flex; justify-content: flex-end; padding-top: 10px; }
</style>
