<script lang="ts">
  import type { StarMapData, WarzonePositions } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { MILITIA_FACTIONS, WARZONE_FACTION_COLORS, type MilitiaFactionID, type MilitiaInsurgency, type MilitiaSystem, type MilitiaVictoryPoints, type MilitiaWarzoneMarkers } from "../bridge/militiaEnlistment.ts";
  import { securityStatusColor, shownSecurity } from "../bridge/systemSecurity.ts";
  import { clientTexture } from "../play/window.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import WarzoneMap from "./WarzoneMap.svelte";

  let { flow, store, zone, faction, positions, starMap, occupations, campaigns, chooseFaction }: {
    flow: AppFlow; store: ClientStore; zone: number; faction: MilitiaFactionID; positions: WarzonePositions; starMap: StarMapData;
    occupations: readonly MilitiaSystem[]; campaigns: readonly MilitiaInsurgency[]; chooseFaction: (id: MilitiaFactionID) => void;
  } = $props();
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const warzoneChanged = flow.theatersWarzoneChanged;

  const FW = "UI/FactionWarfare/", DASHBOARD = `${FW}frontlinesDashboard/`;
  const factions = [500001, 500004, 500003, 500002] as const;
  const centers: Readonly<Record<number, number>> = { 1: 30002959, 2: 30003840 };
  const markerTextures = {
    location: "hereYou.png", pads: "shipcaster/landingpad_32.png", launcher: "shipcaster/shipcaster_icon_40.png",
    battlefield: "battlefieldSmall.png", fob: "fob_32.png",
  } as const;
  const icon = (name: string, group = "category_icons") => clientTexture(`res:/UI/Texture/eveicon/${group}/${name}_16px.png`);
  const legend = {
    names: [DASHBOARD + "systemNames", "Solar System Names", icon("solar_system")],
    status: [DASHBOARD + "warzoneIconsLegendText", "Warzone Icons", icon("theaters_of_war")],
    location: ["UI/Map/StarMap/lblYouAreHere", "You Are Here", icon("user", "system_icons")],
    pads: [DASHBOARD + "landingPadLegendText", "Landing Pad", icon("landing_pad")],
    launcher: [DASHBOARD + "shipcasterLegendText", "Shipcaster", icon("interstellar_shipcaster")],
    battlefield: [DASHBOARD + "battlefieldLegendText", "Battlefield", icon("battlefield")],
    fob: [DASHBOARD + "pirateFOBLegendText", "Pirate FOB", icon("forward_operating_base_fob")],
  } as const;
  const adjacency: Readonly<Record<string, readonly [string, string]>> = {
    FL: ["frontline", "Frontline"], SL: ["secondline", "Command Operations"], BL: ["backline", "Rearguard"],
  };
  type LegendEntry = keyof typeof legend;
  type MapSettings = { zoomedOut: boolean; hideLegend: boolean; hidden: readonly LegendEntry[] };
  const defaults: MapSettings = { zoomedOut: false, hideLegend: false, hidden: [] };

  const characterID = $derived($station.online?.characterID ?? null);
  const settingsKey = $derived(characterID === null ? null : `evejs.fwWarzoneMap.${characterID}`);
  let settings = $state<MapSettings>(defaults);
  let mapLegendOpen = $state(true);
  let selectedID = $state<number | null>(null);
  let detailsCollapsed = $state(false);
  let markerData = $state<MilitiaWarzoneMarkers | null>(null);
  let victory = $state<ReadonlyMap<number, MilitiaVictoryPoints>>(new Map());
  let details = $state<Awaited<ReturnType<AppFlow["theatersSystemDetails"]>> | null>(null);
  let mapError = $state("");
  const atlas = $derived(new Map(starMap.systems.map((row) => [row[0], row])));
  const selected = $derived(selectedID === null ? null : atlas.get(selectedID));
  const selectedStatus = $derived(occupations.find((system) => system.systemID === selectedID));
  const points = $derived(selectedID === null ? null : victory.get(selectedID) ?? null);
  const hq = $derived(selectedID === null ? null : factions.find((id) => markerData?.headquarters.get(id) === selectedID) ?? null);

  function word(label: string, fallback: string, values: TemplateArguments = {}): string {
    const template = $words.templates[label];
    return template ? plainText(formatTemplate(template, values, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, String(id)) })) || fallback : fallback;
  }
  function systemName(id: number) { return resolvedName($names.resolved, "system", id, atlas.get(id)?.[7] ?? String(id)); }
  function factionName(id: MilitiaFactionID) { return resolvedName($names.resolved, "owner", id, MILITIA_FACTIONS[id].name); }

  function changeSettings(next: Partial<MapSettings>) {
    settings = { ...settings, ...next };
    if (settingsKey) {
      try { localStorage.setItem(settingsKey, JSON.stringify(settings)); } catch { /* use the setting for this window */ }
    }
  }

  function toggleMarker(key: LegendEntry) {
    const hidden = settings.hidden.includes(key) ? settings.hidden.filter(entry => entry !== key) : [...settings.hidden, key];
    changeSettings({ hidden });
  }

  const markers = $derived.by(() => {
    const result = new Map<number, { label: string; icon: string }[]>();
    const put = (key: keyof typeof markerTextures, systemID: number | null | undefined, label?: string) => {
      if (!systemID || !positions.systems[systemID]?.isVisible || settings.hidden.includes(key)) return;
      const [id, fallback] = legend[key];
      const image = clientTexture(`res:/UI/Texture/classes/frontlines/${markerTextures[key]}`);
      const entries = result.get(systemID) ?? [];
      if (!entries.some(entry => entry.icon === image)) entries.push({ label: label ?? word(id, fallback), icon: image });
      result.set(systemID, entries);
    };
    put("location", $station.online?.solarSystemID);
    if (markerData?.launchers.has(faction)) put("launcher", markerData.headquarters.get(faction));
    for (const pad of markerData?.pads ?? []) if (pad.factionID === faction) put("pads", pad.systemID);
    for (const [id, messageID] of markerData?.battlefields ?? []) {
      const name = $words.templates[`#${messageID}`];
      put("battlefield", id, name ? word(FW + "frontlines/BattlefieldWithName", `Battlefield - ${name}`, { battlefieldName: name }) : undefined);
    }
    for (const campaign of campaigns) {
      if (campaign.warzoneID === zone) put("fob", campaign.originSystemID,
        word("UI/PirateInsurgencies/FOBSystem", `${factionName(campaign.factionID)} FOB system`, { factionName: factionName(campaign.factionID) }));
    }
    return result;
  });

  $effect(() => {
    const key = settingsKey;
    settings = defaults;
    if (!key) return;
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? "null");
      if (stored) settings = {
        zoomedOut: stored.zoomedOut === true, hideLegend: stored.hideLegend === true,
        hidden: Array.isArray(stored.hidden) ? stored.hidden.filter((name: string) => Object.hasOwn(legend, name)) : [],
      };
    } catch { /* use the native defaults */ }
  });
  $effect(() => {
    flow.requestWords([ ...Object.values(legend).map(([id]) => id), ...Object.values(adjacency).map(([id]) => FW + "frontlines/" + id),
      ...["showMapLegendSettingName", "selectedSystemSectionHeader", "systemState", "systemStateInstructionLabel", "FactionHQSystem", "jumps", "systemNotPartOfWarzone", "thisSystemIsAdjacencyLabel", "advantageTitleLabel"].map(id => DASHBOARD + id),
      ...["StatusStable", "StatusContested", "StatusVulnerable", "advantagebreakdownTooltip", "frontlines/BattlefieldWithName"].map(id => FW + id),
      "UI/PirateInsurgencies/FOBSystem", ...[...(markerData?.battlefields.values() ?? [])].filter(id => id > 0).map(id => `#${id}`),
    ]);
  });
  $effect(() => {
    if (characterID === null) return;
    let current = true;
    void flow.theatersWarzoneMarkers().then(data => { if (current) markerData = data; }, error => { if (current) mapError = (error as Error).message; });
    return () => { current = false; };
  });
  $effect(() => {
    void $warzoneChanged;
    if (characterID === null) return;
    let current = true;
    void flow.theatersVictoryPoints().then(data => { if (current) victory = data; }, error => { if (current) mapError = (error as Error).message; });
    return () => { current = false; };
  });
  $effect(() => {
    const systemID = selectedID, occupied = selectedStatus !== undefined;
    void $station.online?.solarSystemID;
    details = null;
    if (systemID === null || characterID === null) return;
    let current = true;
    void flow.theatersSystemDetails(systemID, occupied).then(data => { if (current) details = data; });
    return () => { current = false; };
  });

  function selectFaction(id: MilitiaFactionID) {
    if (id !== faction) selectedID = null;
    chooseFaction(id);
  }

  function selectSystem(id: number) {
    detailsCollapsed = selectedID === id && !detailsCollapsed;
    selectedID = id;
  }

  function captureStatus(state: MilitiaVictoryPoints) {
    if (state.score >= state.threshold) return word(FW + "StatusVulnerable", "Vulnerable");
    if (state.score === 0) return word(FW + "StatusStable", "Stable");
    const num = state.score / state.threshold * 100;
    return word(FW + "StatusContested", `${num.toFixed(1)}% Contested`, { num });
  }
</script>

<div class="warzone" class:details-collapsed={detailsCollapsed}>
  <div class="map-panel">
    {#key faction}
      <WarzoneMap {positions} jumps={starMap.jumps} {occupations} focusID={centers[zone] ?? null}
        controls={{ zoomedOut: settings.zoomedOut, viewingFaction: faction, selectedID: detailsCollapsed ? null : selectedID, showNames: !settings.hidden.includes("names"),
          showStatus: !settings.hidden.includes("status"), systemName, markers,
          select: selectSystem, zoom: (out) => changeSettings({ zoomedOut: out }) }} />
    {/key}
    {#if !settings.hideLegend}
      <div class="legend">
        <button type="button" class="legend-title" aria-expanded={mapLegendOpen} onclick={() => mapLegendOpen = !mapLegendOpen}>Legend</button>
        {#if mapLegendOpen}
          {#each Object.entries(legend) as [key, [label, fallback, image]] (key)}
            <label><img alt="" src={image} /><input type="checkbox" checked={!settings.hidden.includes(key as LegendEntry)} onchange={() => toggleMarker(key as LegendEntry)} />{word(label, fallback)}</label>
          {/each}
        {/if}
      </div>
    {/if}
    <div class="map-options">
      <button type="button" aria-label="Zoom in" disabled={!settings.zoomedOut} onclick={() => changeSettings({ zoomedOut: false })}>+</button>
      <button type="button" aria-label="Zoom out" disabled={settings.zoomedOut} onclick={() => changeSettings({ zoomedOut: true })}>−</button>
      <button type="button" aria-label={word(DASHBOARD + "showMapLegendSettingName", "Show Map Legend")} aria-pressed={!settings.hideLegend} onclick={() => changeSettings({ hideLegend: !settings.hideLegend })}>☰</button>
    </div>
    <div class="factions" role="group" aria-label="View as faction">
      {#each factions as id (id)}
        <button type="button" aria-pressed={faction === id} aria-label={factionName(id)} title={factionName(id)} onclick={() => selectFaction(id)}>
          <img alt="" src={clientTexture(`res:/UI/Texture/Classes/SkillPlan/factionButtons/icon${MILITIA_FACTIONS[id].banner}.png`)} />
        </button>
      {/each}
    </div>
  </div>
  <button type="button" class="collapse" aria-expanded={!detailsCollapsed}
    aria-label={word(DASHBOARD + "selectedSystemSectionHeader", "Selected System")}
    onclick={() => detailsCollapsed = !detailsCollapsed}>{detailsCollapsed ? "‹" : "›"}</button>
  {#if !detailsCollapsed}
  <aside class="selected" aria-label={word(DASHBOARD + "selectedSystemSectionHeader", "Selected System")}>
    <h3>{word(DASHBOARD + "selectedSystemSectionHeader", "Selected System")}</h3>
    {#if selectedID !== null}
      {@const security = selected?.[8] ?? null}
      <h4>{systemName(selectedID)}{#if security !== null}{" "}<span style:color={securityStatusColor(security)}>{shownSecurity(security).toFixed(1)}</span>{/if}</h4>
      {#if selectedStatus?.occupierID}
        <p>{factionName(selectedStatus.occupierID)}{#if points}{" · "}{captureStatus(points)}{/if}</p>
        {#if points}<progress aria-label={captureStatus(points)} max={points.threshold} value={Math.min(points.score, points.threshold)} style:accent-color={WARZONE_FACTION_COLORS[selectedStatus.occupierID]}></progress>{/if}
      {:else if hq}
        <p>{word(DASHBOARD + "FactionHQSystem", `${factionName(hq)} HQ System`, { factionID: hq })}</p>
      {/if}
      <p>{word(DASHBOARD + "jumps", `Jumps: ${details?.jumps ?? "-"}`, { numJumps: details?.jumps ?? "-" })}</p>
      {#if selectedStatus?.occupierID}
        {@const state = adjacency[selectedStatus.adjacency]}
        {#if state}
          {@const label = word(FW + "frontlines/" + state[0], state[1])}
          <p>{word(DASHBOARD + "thisSystemIsAdjacencyLabel", `This system is a ${label}.`, { adjacencyState: label })}</p>
        {/if}
        {#if details?.advantage && selectedStatus.attackerID}
          <h4>{word(DASHBOARD + "advantageTitleLabel", "Advantage")}</h4>
          {#each [selectedStatus.attackerID, selectedStatus.occupierID] as id (id)}
            {@const score = details.advantage[id]}
            {@const value = (score?.contribution ?? 0) + (score?.floor ?? 0)}
            {@const percent = `${Math.round(value * 100)}%`}
            <label class="advantage" title={word(FW + "advantagebreakdownTooltip", percent, { objectives: `${Math.round((score?.contribution ?? 0) * 100)}%`, floor: `${Math.round((score?.floor ?? 0) * 100)}%` })}>
              <span>{factionName(id)}</span><span>{percent}</span>
              <progress max="1" value={value} style:accent-color={WARZONE_FACTION_COLORS[id]}></progress>
            </label>
          {/each}
        {/if}
      {:else}
        <p>{word(DASHBOARD + "systemNotPartOfWarzone", "This system is not part of the warzone")}</p>
      {/if}
    {:else}
      <h4>{word(DASHBOARD + "systemState", "System State")}</h4>
      <p>{word(DASHBOARD + "systemStateInstructionLabel", "Click a system for more information")}</p>
    {/if}
    {#if mapError}<p role="alert">{mapError}</p>{/if}
  </aside>
  {/if}
</div>

<style>
  .warzone { display: grid; grid-template-columns: minmax(0, 1fr) 17px clamp(170px, 24%, 280px); min-height: 400px; height: calc(100% - 42px); background: #ffffff1b; }
  .warzone.details-collapsed { grid-template-columns: minmax(0, 1fr) 17px; }
  .map-panel { position: relative; min-width: 0; min-height: 360px; }
  .legend, .map-options, .factions { position: absolute; z-index: 3; }
  .legend { top: 8px; left: 8px; background: #06090de8; border: 1px solid #ffffff29; padding: 5px; }
  .legend label { display: flex; align-items: center; gap: 4px; padding: 4px; cursor: pointer; }
  img { display: block; }
  button { color: inherit; background: #141a20ec; border: 1px solid #ffffff29; font: inherit; cursor: pointer; }
  button:hover, button[aria-pressed="true"] { border-color: #a5cbd4; background: #26424a; }
  button:disabled { opacity: .45; cursor: default; }
  .collapse { padding: 0; }
  .legend-title { width: 100%; padding: 5px 8px; text-align: start; }
  .map-options { display: flex; gap: 2px; top: 8px; right: 8px; }
  .map-options button { width: 30px; height: 28px; }
  .factions { display: flex; gap: 6px; left: 50%; bottom: 10px; transform: translateX(-50%); }
  .factions button { padding: 5px; border-radius: 50%; }
  .factions img { width: 28px; height: 28px; }
  .selected { min-width: 0; overflow: auto; background: #111519; padding: 14px; }
  h3 { margin: 0 0 14px; color: #b7c6cb; font-size: 12px; }
  h4 { margin: 12px 0 8px; font-size: 17px; font-weight: 500; }
  p { margin: 8px 0; }
  progress { display: block; width: 100%; height: 8px; }
  .advantage { display: grid; grid-template-columns: 1fr auto; gap: 3px; margin-bottom: 8px; }
  .advantage progress { grid-column: 1 / -1; }
</style>
