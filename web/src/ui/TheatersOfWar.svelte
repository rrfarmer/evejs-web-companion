<script lang="ts">
  import type { StarMapData, WarzonePositions } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { filetimeToUnixMs } from "../bridge/activity.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { afterMilitiaEnlistment, EMPIRE_MILITIAS, MILITIA_FACTIONS, militiaEnlistmentWarning, militiaFactionID, militiaIsPirate, militiaOrganizationActions, PIRATE_MILITIAS, type MilitiaEligibility, type MilitiaFactionID, type MilitiaInsurgency, type MilitiaOffice, type MilitiaOrganizationAction, type MilitiaSystem, type TheatersPage } from "../bridge/militiaEnlistment.ts";
  import { clientTexture } from "../play/window.ts";
  import { securityStatusColor, shownSecurity } from "../bridge/systemSecurity.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { serveTheatersOfWarRequest, theatersOfWarRequests } from "./theatersOfWarRequests.ts";
  import { trackMilitiaJob, trackedJobsChanged, trackedMilitiaJob, untrackMilitiaJob } from "./jobTracking.ts";
  import WarzoneDashboard from "./WarzoneDashboard.svelte";
  import WarzoneMap from "./WarzoneMap.svelte";
  import VanguardActivity from "./VanguardActivity.svelte";

  let { store, flow, onShowConvoys }: { store: ClientStore; flow: AppFlow; onShowConvoys?: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const enlistmentChanged = flow.militiaEnlistmentChanged;
  // svelte-ignore state_referenced_locally
  const warzoneChanged = flow.theatersWarzoneChanged;
  const TOW = "UI/TheatersOfWar/", FW = "UI/FactionWarfare/", E = `${FW}Enlistment/`;
  const recentAllianceDenial = "DeniedRecentlyInAlliance";
  const art = (asset: string) => clientTexture(`res:/UI/Texture/Classes/Enlistment/${asset}.png`);
  const panels = [
    { id: "overview", label: "OverviewPanel", fallback: "Overview", icon: "house" },
    { id: "warfare", label: "FactionalWarfarePanel", fallback: "Factional Warfare", icon: "factional_warfare" },
    { id: "insurgencies", label: "InsurgenciesPanel", fallback: "Insurgencies", icon: "pirate_insurgencies" },
    { id: "enlistment", label: "EnlistPanel", fallback: "Enlistment", icon: "flag" },
  ] as const;
  const zones = [
    { id: 2, label: "FwCaldariGallenteWarzone", fallback: "Caldari–Gallente Warzone", factions: [500001, 500004] },
    { id: 1, label: "FwAmarrMinmatarWarzone", fallback: "Amarr–Minmatar Warzone", factions: [500003, 500002] },
  ] as const;
  const factionByRace: Readonly<Record<number, MilitiaFactionID>> = { 1: 500001, 2: 500002, 4: 500003, 8: 500004 };
  const warnings = {
    enlisted: "You are already enlisted with another militia.",
    location: "Dock at a station that offers enlistment with this faction.",
    disallowed: "Your corporation does not allow direct enlistment with this faction.",
    standing: "Your standing with this faction is too low to enlist.",
    cooldown: "Your militia enlistment cooldown is still active.",
    pending: "Your organization has a pending enlistment application.",
  } as const;
  const orgLabels: Record<MilitiaOrganizationAction, readonly [string, string, string, string]> = {
    joinCorporation: ["EnlistCorporation", "Enlist Corporation", "JoinConfirmationHeader", "JoinConfirmationQuestionCorp"],
    joinAlliance: ["EnlistAlliance", "Enlist Alliance", "JoinConfirmationHeader", "JoinConfirmationQuestionAlliance"],
    retireCorporation: ["RetireCorporation", "Retire Corporation", "ConfirmRetireHeader", "ConfirmRetire"],
    retireAlliance: ["RetireAlliance", "Retire Alliance", "ConfirmRetireHeader", "ConfirmRetire"],
    withdrawCorporation: ["WithdrawApplication", "Withdraw Application", "ConfirmCancelApplicationHeader", "ConfirmCancelApplicationAlliance"],
    withdrawAlliance: ["WithdrawApplication", "Withdraw Application", "ConfirmCancelApplicationHeader", "ConfirmCancelApplicationAlliance"],
    cancelRetireCorporation: ["CancelRetirement", "Cancel Retirement", "ConfirmCancelRetirementHeader", "ConfirmCancelRetirement"],
    cancelRetireAlliance: ["CancelRetirement", "Cancel Retirement", "ConfirmCancelRetirementHeader", "ConfirmCancelRetirement"],
  };
  type Side = "empire" | "pirates";
  let page = $state<TheatersPage>("overview");
  let side = $state<Side | null>(null);
  let selected = $state<MilitiaFactionID | null>(null);
  let viewingFaction = $state<MilitiaFactionID>(500001);
  let automaticFaction = $state(false);
  const theater = $derived(zones.find(entry => entry.factions.some(id => id === viewingFaction)) ?? zones[0]);
  let eligibility = $state<MilitiaEligibility | null>(null);
  let occupations = $state<ReadonlyMap<number, readonly MilitiaSystem[]> | null>(null);
  let warzonePositions = $state<Readonly<Record<number, WarzonePositions>> | null>(null);
  let starMap = $state<StarMapData | null>(null);
  const mapSystems = $derived(new Map(starMap?.systems.map((row) => [row[0], row])));
  let insurgencies = $state<MilitiaInsurgency[] | null>(null);
  let office = $state<MilitiaOffice | null>(null);
  let readError = $state("");
  let panelError = $state("");
  let actionError = $state("");
  let writing = $state(false);
  let revision = $state(0);
  let question = $state<{ id: MilitiaFactionID; characterID: number; retire: boolean; direct: boolean;
    organization?: { action: MilitiaOrganizationAction; corporationID: number; allianceID: number | null } } | null>(null);
  const orgQuestion = $derived(question?.organization ? orgLabels[question.organization.action] : null);
  let faction = $derived(selected === null ? null : MILITIA_FACTIONS[selected]);
  let enlisted = $derived(militiaFactionID($station.online?.warFactionID) ?? eligibility?.factionID ?? null);
  let sameFaction = $derived(selected !== null && eligibility?.factionID === selected);
  let canRetire = $derived(sameFaction && (eligibility?.directFactionID === selected || eligibility?.corporationID === faction?.corporationID));
  let warning = $derived(eligibility && selected !== null && !sameFaction ? militiaEnlistmentWarning(eligibility, selected) : null);
  const orgActions = $derived(eligibility && selected !== null ? militiaOrganizationActions(eligibility, selected) : []);
  const tracked = $derived.by(() => { void $trackedJobsChanged; return trackedMilitiaJob($station.online?.characterID ?? null); });

  function say(label: string, fallback: string, values: Record<string, string> = {}): string {
    const template = $words.templates[label];
    return template ? plainText(formatTemplate(template, values)) || fallback : fallback;
  }
  function factionName(id: MilitiaFactionID) {
    return resolvedName($names.resolved, "owner", id, MILITIA_FACTIONS[id].name);
  }
  function choosePage(next: TheatersPage, zoneID?: number) {
    if (next === "enlistment" && page !== next) {
      selected = enlisted;
      side = enlisted ? (militiaIsPirate(enlisted) ? "pirates" : "empire") : null;
    }
    if (next === "warfare" && (page !== next || zoneID !== undefined)) {
      const active = enlisted === 500010 ? 500001 : enlisted === 500011 ? 500003 : enlisted;
      const stationFaction = eligibility?.stationFactions[0];
      const preferred = active ?? (stationFaction && !militiaIsPirate(stationFaction) ? stationFaction : null) ?? factionByRace[$station.online?.raceID ?? 0] ?? 500001;
      const target = zoneID === undefined ? null : zones.find(zone => zone.id === zoneID);
      viewingFaction = target && !target.factions.some(id => id === preferred) ? target.factions[0] : preferred;
      automaticFaction = zoneID === undefined && active === null;
    }
    question = null;
    actionError = "";
    page = next;
  }
  function chooseSide(next: Side) { side = next; selected = null; actionError = ""; }

  function mostRecentChange(systems: readonly MilitiaSystem[]): MilitiaSystem | null {
    let latest: MilitiaSystem | null = null;
    for (const system of systems) {
      if (system.dateTaken !== null && (latest?.dateTaken == null || system.dateTaken > latest.dateTaken)) latest = system;
    }
    return latest;
  }

  $effect(() => {
    flow.requestWords([...panels.map(({label}) => TOW + label), ...zones.map(({label}) => TOW + label),
      TOW + "FactionalWarfareSectionHeader", TOW + "FwOccupancyChanges", TOW + "PersonalProgress", TOW + "PersonalUnenlisted", TOW + "PersonalEnlistedWith",
      TOW + "InsurgencyGuristas", TOW + "InsurgencyAngelCartel", TOW + "InsurgencyPirateFob",
      FW + "EnlistMe", FW + "Retire", FW + "JoinConfirmationHeader", FW + "JoinConfirmationQuestionPlayer", FW + "JoinConfirmationQuestionDirectEnlistment",
      FW + "ConfirmRetireHeader", FW + "ConfirmRetire", "UI/Common/Buttons/Yes", "UI/Common/Buttons/No",
      ...["ChooseYourSide", "FrontpageEmpires", "FrontpagePirates", "FactionalWarfareHeader", "PiratesHeader", "ClickOnEmpireFaction", "ClickOnPirateFaction", "InitiateEnlistment"].map((label) => E + label),
      "UI/Agency/FactionWarfare/nearestMilitiaOffice",
      E + "WarningPendingSameFactionLong", E + "WarningPendingAnotherFactionLong",
      FW + "Manager/" + recentAllianceDenial,
      ...Object.values(orgLabels).flatMap(([button, , header, body]) => [button, header, body].map((label) => FW + label)),
    ]);
    flow.requestNames(Object.keys(MILITIA_FACTIONS).map((id) => ({ kind: "owner", id: Number(id) })));
  });
  $effect(() => {
    const request = $theatersOfWarRequests;
    if (request) { choosePage(request.page); serveTheatersOfWarRequest(request); }
  });
  $effect(() => {
    const online = $station.online;
    const visiblePage = page;
    const version = revision;
    void $enlistmentChanged;
    if (!online || (visiblePage !== "overview" && visiblePage !== "enlistment")) return;
    let current = true;
    eligibility = null;
    readError = "";
    void flow.readMilitiaEnlistment().then((data) => {
      if (!current || version !== revision) return;
      eligibility = data;
      const affiliation = data.factionID ?? data.corpFactionID;
      if (visiblePage === "enlistment" && affiliation && side === null) {
        side = militiaIsPirate(affiliation) ? "pirates" : "empire";
        selected = affiliation;
      }
    }, (error: unknown) => {
      if (current) readError = error instanceof Error ? error.message : String(error);
    });
    return () => { current = false; };
  });
  $effect(() => {
    const pilot = $station.online;
    if (page !== "warfare" || !automaticFaction || !pilot) return;
    const occupying = [...(occupations?.values() ?? [])].flat().find(system => system.systemID === pilot.solarSystemID)?.occupierID;
    let current = true;
    void flow.theatersStationFaction().then((stationFaction) => {
      if (!current) return;
      const faction = stationFaction ?? occupying;
      viewingFaction = faction && !militiaIsPirate(faction) ? faction : factionByRace[pilot.raceID ?? 0] ?? 500001;
    }).catch(() => {});
    return () => { current = false; };
  });
  $effect(() => {
    if (page !== "overview" && page !== "warfare") return;
    let current = true;
    void Promise.all([flow.loadWarzonePositions(), flow.loadStarMap()]).then(([positions, map]) => {
      if (!current) return;
      warzonePositions = positions;
      starMap = map;
    }).catch((error: unknown) => { if (current) panelError = error instanceof Error ? error.message : String(error); });
    return () => { current = false; };
  });
  $effect(() => {
    if (page === "enlistment") return;
    void $warzoneChanged;
    void $station.online?.characterID;
    let current = true;
    panelError = "";
    const report = (error: unknown) => { if (current) panelError = error instanceof Error ? error.message : String(error); };
    if (page === "overview" || page === "warfare") {
      void flow.theatersWarzones().then((answer) => { if (current) occupations = answer; }, report);
    }
    if (page === "overview" || page === "warfare" || page === "insurgencies") {
      void flow.theatersInsurgencies().then((answer) => { if (current) insurgencies = answer; }, report);
    }
    return () => { current = false; };
  });
  $effect(() => {
    const id = selected;
    const system = $station.online?.solarSystemID;
    office = null;
    if (warning !== "location" || id === null || !system) return;
    let current = true;
    void flow.nearestMilitiaOffice(id).then((read) => { if (current) office = read; }).catch(() => {});
    return () => { current = false; };
  });

  function ask(retire: boolean) {
    if (!eligibility || selected === null) return;
    question = { id: selected, characterID: eligibility.characterID, retire, direct: eligibility.allowedFactions !== null };
  }
  function askOrganization(action: MilitiaOrganizationAction) {
    if (!eligibility?.organization || selected === null) return;
    question = { id: selected, characterID: eligibility.characterID, retire: false, direct: false,
      organization: { action, corporationID: eligibility.corporationID, allianceID: eligibility.organization.allianceID } };
  }
  function initiate() {
    if (!eligibility || selected === null || warning !== "location" || selected === tracked) return;
    actionError = "";
    try { trackMilitiaJob(eligibility.characterID, selected); }
    catch (error) { actionError = error instanceof Error ? error.message : String(error); }
  }
  async function confirm() {
    const asked = question;
    if (!asked || writing) return;
    writing = true;
    question = null;
    actionError = "";
    const previous = eligibility?.factionID ?? null;
    try {
      if (asked.organization) {
        const { action, corporationID, allianceID } = asked.organization;
        await flow.changeMilitiaOrganization({ characterID: asked.characterID, corporationID, allianceID }, asked.id, action);
        return;
      }
      const next = await flow.changeMilitiaEnlistment(asked.characterID, asked.id, asked.retire);
      if (store.station.get().online?.characterID !== asked.characterID) return;
      if (asked.retire ? next.factionID === asked.id : next.factionID !== asked.id) throw new Error("The server did not confirm the change in militia affiliation.");
      untrackMilitiaJob(asked.characterID);
      const destination = afterMilitiaEnlistment(previous, next.factionID);
      if (destination && page === "enlistment") choosePage(destination);
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    } finally {
      revision += 1;
      writing = false;
    }
  }
</script>

<div class="theaters">
  <nav aria-label="Theaters of War">
    {#each panels as item (item.id)}
      {#if item.id === "warfare"}<h3>{say(TOW + "FactionalWarfareSectionHeader", "Factional Warfare")}</h3>{/if}
      <button type="button" class:active={page === item.id} aria-current={page === item.id ? "page" : undefined} onclick={() => choosePage(item.id)}>
        <img alt="" src={clientTexture(`res:/UI/Texture/eveicon/system_icons/${item.icon}_16px.png`)} />{say(TOW + item.label, item.fallback)}
      </button>
    {/each}
  </nav>
  <section class="theaters-content" aria-label={panels.find((item) => item.id === page)?.fallback}>
    {#if panelError && page !== "enlistment"}<p role="alert">{panelError}</p>{/if}
    {#if page === "overview"}
      <h2>{say(TOW + "FwOccupancyChanges", "Occupancy Changes")}</h2>
      <div class="zone-grid">
        {#each zones as theater (theater.id)}
          {@const systems = occupations?.get(theater.id) ?? []}
          {@const latest = mostRecentChange(systems)}
          {@const system = latest && mapSystems.get(latest.systemID)}
          {@const name = latest ? resolvedName($names.resolved, "system", latest.systemID, system?.[7] ?? String(latest.systemID)) : ""}
          {@const security = system?.[8] ?? null}
          {@const date = filetimeToUnixMs(latest?.dateTaken ?? null)}
          {@const layout = warzonePositions?.[theater.id]}
          <button type="button" class="occupancy-card" onclick={() => choosePage("warfare", theater.id)}>
            <span class="occupancy-title">{say(TOW + theater.label, theater.fallback)}</span>
            {#if layout && starMap}<WarzoneMap positions={layout} jumps={starMap.jumps} occupations={systems} focusID={latest?.systemID ?? null} focusName={name} />{/if}
            {#if occupations}
              <span class="occupancy-footer">
                {#if latest}
                  <span>{name}{#if security !== null}{" "}<span style:color={securityStatusColor(security)}>{shownSecurity(security).toFixed(1)}</span>{/if}</span>
                  {#if date !== null}<span>{new Date(date).toISOString().slice(0, 10).replaceAll("-", ".")}</span>{/if}
                {:else}
                  <span>[ NO SYSTEM WITH OCCUPANCY-CHANGE DATE FOUND ]</span>
                {/if}
              </span>
            {/if}
          </button>
        {/each}
      </div>
      {#if insurgencies?.length}
        <div class="zone-grid">
          {#each insurgencies as campaign (campaign.campaignID)}
            <button type="button" class="zone-card pirate" onclick={() => choosePage("insurgencies")}>
              <img alt="" src={art(`logos/${MILITIA_FACTIONS[campaign.factionID].logo}`)} />{factionName(campaign.factionID)}
            </button>
          {/each}
        </div>
      {/if}
      <div class="overview-bottom">
        <section class="personal">
          <h2>{say(TOW + "PersonalProgress", "Personal Progress")}</h2>
          <button type="button" onclick={() => choosePage("enlistment")}>
            {enlisted ? say(TOW + "PersonalEnlistedWith", `Enlisted with ${factionName(enlisted)}`, { factionName: factionName(enlisted) }) : say(TOW + "PersonalUnenlisted", "Unenlisted")}
          </button>
        </section>
        <VanguardActivity {store} {flow} theaters onShowMap={onShowConvoys} />
      </div>
    {:else if page === "warfare"}
      {@const layout = warzonePositions?.[theater.id]}
      <h2>{say(TOW + theater.label, theater.fallback)}</h2>
      {#if occupations && layout && starMap}
        <WarzoneDashboard {flow} {store} zone={theater.id} faction={viewingFaction} positions={layout} {starMap}
          occupations={occupations.get(theater.id) ?? []} campaigns={insurgencies ?? []} enlistedFaction={enlisted}
          openEnlistment={() => choosePage("enlistment")} chooseFaction={(id) => { automaticFaction = false; viewingFaction = id; }} />
      {:else if !panelError}
        {#if starMap && warzonePositions === null}<p>Warzone map data is unavailable.</p>{:else}<p>Loading warzones…</p>{/if}
      {/if}
    {:else if page === "insurgencies"}
      {#if insurgencies === null}{#if !panelError}<p>Loading insurgencies…</p>{/if}
      {:else if insurgencies.length === 0}<p>No active insurgencies are reported.</p>
      {:else}
        <div class="zone-grid">
          {#each insurgencies as campaign (campaign.campaignID)}
            <article class="zone-card pirate">
              <img alt="" src={art(`logos/${MILITIA_FACTIONS[campaign.factionID].logo}`)} />
              <h2>{factionName(campaign.factionID)}</h2>
              {#if campaign.fobSystemID}
                <span>{say(TOW + "InsurgencyPirateFob", "Pirate FOB")} · {resolvedName($names.resolved, "system", campaign.fobSystemID, String(campaign.fobSystemID))}</span>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    {:else}
      {#if side === null}
        <div class="side-picker">
          <h2>{say(E + "ChooseYourSide", "Choose Your Side")}</h2>
          <div class="zone-grid">
            <button type="button" class="side-card" style:--banner={`url(${art("banner/bannerEmpire")})`} onclick={() => chooseSide("empire")}>
              <img alt="" src={art("logos/flagEmpires")} />{say(E + "FrontpageEmpires", "Empires")}
            </button>
            <button type="button" class="side-card" style:--banner={`url(${art("banner/bannerPirates")})`} onclick={() => chooseSide("pirates")}>
              <img alt="" src={art("logos/flagPirates")} />{say(E + "FrontpagePirates", "Pirates")}
            </button>
          </div>
        </div>
      {:else}
        <button type="button" class="back" onclick={() => {side = null; selected = null;}}>‹ {say(E + "ChooseYourSide", "Choose Your Side")}</button>
        <h2>{side === "empire" ? say(E + "FactionalWarfareHeader", "Factional Warfare") : say(E + "PiratesHeader", "Pirates")}</h2>
        <div class="faction-picker">
          {#each (side === "empire" ? EMPIRE_MILITIAS : PIRATE_MILITIAS) as id (id)}
            <button type="button" class:active={selected === id} aria-pressed={selected === id} onclick={() => { selected = id; actionError = ""; }}>
              <img alt="" src={art(`logos/${MILITIA_FACTIONS[id].logo}`)} /><span>{factionName(id)}</span>
            </button>
          {/each}
        </div>
        {#if selected !== null && faction}
          <article class="enlist" style:--banner={`url(${art(`banner/${faction.banner}_banner`)})`}>
            <h2>{factionName(selected)}</h2>
            {#if readError}<p role="alert">{readError}</p>
            {:else if !eligibility}<p>Checking enlistment requirements…</p>
            {:else if sameFaction}
              {#if canRetire}<button type="button" disabled={writing} onclick={() => ask(true)}>{say(FW + "Retire", "Retire")}</button>
              {:else}<p>{say(TOW + "PersonalEnlistedWith", `Enlisted with ${factionName(selected)}`, { factionName: factionName(selected) })}</p>{/if}
            {:else if warning}
              <p role="status">{warning === "pending" ? say(E + (eligibility.corpFactionID === selected ? "WarningPendingSameFactionLong" : "WarningPendingAnotherFactionLong"), warnings.pending) : warnings[warning]}</p>
              {#if warning === "location"}
                <button type="button" disabled={selected === tracked || writing} onclick={initiate}>
                  {say(E + "InitiateEnlistment", "Initiate Enlistment")}
                </button>
                {#if selected === tracked}<p role="status">Tracking in Opportunities.</p>{/if}
                {#if office}<p>{say("UI/Agency/FactionWarfare/nearestMilitiaOffice", "Nearest militia office")}<br />
                  {resolvedName($names.resolved, "station", office.stationID, String(office.stationID))}{office.jumps === null ? "" : ` · ${office.jumps} jumps`}</p>{/if}
              {/if}
            {:else}
              <button type="button" class="accent" disabled={writing} onclick={() => ask(false)}>{say(FW + "EnlistMe", "Enlist Me")}</button>
            {/if}
            {#each orgActions as action (action)}
              <button class="organization-action" type="button" disabled={writing} onclick={() => askOrganization(action)}>{say(FW + orgLabels[action][0], orgLabels[action][1])}</button>
            {/each}
            {#if actionError}<p role="alert">
              {actionError === recentAllianceDenial ? say(FW + "Manager/" + recentAllianceDenial, "Wait 24 hours after your corporation leaves an alliance to join factional warfare.") : actionError}
            </p>{/if}
          </article>
        {:else}<p>{side === "empire" ? say(E + "ClickOnEmpireFaction", "Select an empire") : say(E + "ClickOnPirateFaction", "Select a pirate faction")}</p>{/if}
      {/if}
    {/if}
  </section>
  {#if question}
    <div class="question-backdrop">
      <div class="question" role="alertdialog" aria-modal="true" aria-labelledby="militia-question-title">
        <h2 id="militia-question-title">{orgQuestion ? say(FW + orgQuestion[2], orgQuestion[1]) : question.retire ? say(FW + "ConfirmRetireHeader", "Retire from militia") : say(FW + "JoinConfirmationHeader", "Confirm Enlistment")}</h2>
        <p>{orgQuestion ? say(FW + orgQuestion[3], `${orgQuestion[1]} for ${factionName(question.id)}?`, { factionName: factionName(question.id) }) : question.retire
          ? say(FW + "ConfirmRetire", `Retire from ${factionName(question.id)}?`, { factionName: factionName(question.id) })
          : question.direct ? say(FW + "JoinConfirmationQuestionDirectEnlistment", `Enlist directly with ${factionName(question.id)}?`, { factionName: factionName(question.id) })
          : say(FW + "JoinConfirmationQuestionPlayer", `Join the militia for ${factionName(question.id)}?`, { factionName: factionName(question.id) })}</p>
        <footer><button type="button" class="accent" onclick={confirm}>{say("UI/Common/Buttons/Yes", "Yes")}</button><button type="button" onclick={() => question = null}>{say("UI/Common/Buttons/No", "No")}</button></footer>
      </div>
    </div>
  {/if}
</div>

<style>
  .theaters { height: 100%; min-height: 0; display: grid; grid-template-columns: clamp(136px, 19%, 232px) minmax(0, 1fr); color: #dddfe2; background: #141619; position: relative; font-size: 13px; }
  nav { display: flex; flex-direction: column; gap: 2px; padding: 10px 0; background: #101215; border-right: 1px solid #ffffff19; }
  nav h3 { margin: 18px 12px 4px; font-size: 11px; font-weight: 500; color: #afb3b9; }
  button { padding: 8px 12px; color: inherit; background: #ffffff12; border: 1px solid #ffffff24; font: inherit; cursor: pointer; }
  button:hover, button.active { background: #ffffff22; border-color: #ffffff45; }
  button:disabled { opacity: .5; cursor: default; }
  nav button { border: 0; border-left: 2px solid transparent; text-align: start; display: flex; gap: 8px; align-items: center; background: transparent; }
  nav button.active { border-color: #91b9c4; }
  nav img { width: 16px; height: 16px; object-fit: contain; }
  .theaters-content { overflow: auto; min-height: 0; padding: 16px; container-type: inline-size; }
  h2 { font: inherit; font-size: 17px; margin: 0 0 12px; }
  .zone-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 10px; }
  .zone-card { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px; min-height: 112px; background: linear-gradient(#2c383d, #191e22); text-align: center; }
  .occupancy-card { padding: 0; min-width: 0; display: flex; flex-direction: column; text-align: start; }
  .occupancy-title, .occupancy-footer { padding: 8px; }
  .occupancy-title { font-size: 14px; }
  .occupancy-footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 8px; color: #bdc7cb; font-size: 11px; }
  .zone-card img { width: 42px; height: 42px; object-fit: contain; }
  .zone-card.pirate { background: linear-gradient(#362920, #201c1b); }
  .overview-bottom { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 4fr); gap: 10px; }
  @container (max-width: 470px) { .overview-bottom { grid-template-columns: minmax(0, 1fr); } }
  .personal { padding: 12px; background: #ffffff09; }
  .side-picker { max-width: 900px; margin: 5vh auto 0; text-align: center; }
  .side-card { min-height: clamp(160px, 43vh, 460px); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; font-size: 19px; background: linear-gradient(#0002, #000a), var(--banner) center / cover, #242b31; }
  .side-card:hover { background: linear-gradient(#ffffff13, #0008), var(--banner) center / cover, #333940; }
  .side-card img { width: min(72px, 55%); }
  .faction-picker { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .faction-picker button { min-height: 80px; display: flex; flex-direction: column; gap: 6px; align-items: center; flex: 1 1 94px; justify-content: center; }
  .faction-picker img { width: 38px; height: 38px; object-fit: contain; }
  .back { margin-bottom: 12px; }
  .enlist { min-height: 210px; padding: 26px 16px; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; background: linear-gradient(#080a0da0, #080a0dec), var(--banner) center / cover, #20282b; }
  p { margin: 4px 0 10px; line-height: 1.45; }
  .accent { border-color: #8bb4bd; background: #48778240; }
  .organization-action { margin-top: 6px; }
  .question-backdrop { position: absolute; z-index: 2; inset: 0; display: grid; place-items: center; background: #0009; padding: 12px; }
  .question { width: min(420px, 100%); padding: 18px; background: #1e2328; border: 1px solid #ffffff4d; box-shadow: 0 8px 24px #000a; }
  .question footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 15px; }
</style>
