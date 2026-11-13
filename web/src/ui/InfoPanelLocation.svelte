<script lang="ts">
  // infoPanels/infoPanelLocationInfo.InfoPanelLocationInfo (PANEL_LOCATION_INFO; always available; label
  // UI/Neocom/SystemInfo). Its top row: in the left gutter (LEFTPAD 56) the ExpandButton and the header button -
  // ListSurroundingsBtn, LocationInfo.png (16), hint ListItemsInSystem -; the header (UpdateMainLocationInfo): the
  // system's name (a location link, hint CurrentLocationType), its security status (eveformat
  // solar_system_security_status, hint UI/Map/StarMap/SecurityStatus) with its range's icon
  // (security.client.const get_range_icon_by_security_status: SAFE 1.0 concord_logo, HIGH 0.45-0.94999 high_sec, LOW
  // 0.0001-0.44999 low_sec, NULL -1.0-0.0 null_sec, a wormhole's wormholes, Pochven's triglavian_logo), then the
  // constellation's and the region's traces (GetSolarSystem...TraceDisplayString: " < " and the location link; none in
  // a wormhole region). In normal mode the body (indented by LEFTPAD): UpdateNearestOrStationLocationInfo - docked, the
  // station or structure (a showinfo link, alt CurrentStation); in space, the nearest of the ballpark's asteroid
  // belts, moons, planets and stargates by surface distance (GetNearestBall, checked every 1313 ms; alt Nearest) -,
  // then UpdateSOVLocationInfo: a faction's system its faction (a showinfo link), a wormhole Unclaimable.
  // Not here: the surroundings menu (ListSurroundingsBtn), the claimable systems' sovereignty (sov holders, the
  // defence multiplier), factional warfare's victory points, the dynamic bounty output, the emanation lock, the
  // interference and security tooltips, TiDi, the abyssal and void names.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { StarMapData } from "../app/api.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { securityStatusColor, shownSecurity } from "../bridge/systemSecurity.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "../play/window.ts";
  import { showInfo } from "./showInfo.ts";
  let { store, flow, compact, onToggle }: { store: ClientStore; flow: AppFlow; compact: boolean; onToggle: () => void } = $props();
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
  const LABELS = ["UI/Neocom/SystemInfo", "UI/Neocom/ListItemsInSystem", "UI/Map/StarMap/SecurityStatus", "UI/Neocom/Nearest", "UI/Generic/CurrentStation", "UI/Neocom/Unclaimable"];
  const word = (label: string, own: string) => plainText($words.templates[label] ?? "") || own;
  let map = $state<StarMapData | null>(null);
  onMount(() => {
    flow.requestWords(LABELS);
    void flow.loadStarMap().then((m) => { map = m; }, () => {});
  });
  const systemID = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const system = $derived(map && systemID ? map.systems.find((s) => s[0] === systemID) ?? null : null);
  const constellation = $derived(map && system ? map.constellations?.find((c) => c[0] === system[6]) ?? null : null);
  const region = $derived(map && system ? map.regions?.find((r) => r[0] === system[5]) ?? null : null);
  const security = $derived(system && typeof system[8] === "number" ? system[8] : null);
  const isWormhole = $derived(systemID !== null && systemID >= 31_000_000 && systemID < 32_000_000);
  const isPochven = $derived(system !== null && system[5] === 10000070);
  // get_range_icon_by_security_status
  const rangeIcon = $derived.by(() => {
    if (isPochven) return "eveicon/faction_logos/triglavian_logo_16px.png";
    if (isWormhole) return "eveicon/category_icons/wormholes_16px.png";
    if (security === null) return null;
    if (security >= 1.0 && security <= 1.0) return "eveicon/faction_logos/concord_logo_16px.png";
    if (security >= 0.45 && security <= 0.94999) return "eveicon/category_icons/high_sec_16px.png";
    if (security >= 0.0001 && security <= 0.44999) return "eveicon/category_icons/low_sec_16px.png";
    if (security >= -1.0 && security <= 0.0) return "eveicon/category_icons/null_sec_16px.png";
    return null;
  });
  const factionID = $derived(system && system[4] ? system[4] : null);
  $effect(() => { if (factionID) flow.requestNames([{ kind: "faction", id: factionID }]); });
  // UpdateNearestOrStationLocationInfo
  const docked = $derived($flight.status?.docked === true);
  const dockedAt = $derived(docked ? ($flight.status?.stationID ?? $flight.status?.structureID ?? null) : null);
  const NEARBY = new Set([9, 8, 7, 10]); // groupAsteroidBelt, groupMoon, groupPlanet, groupStargate
  let nearest = $state<{ itemID: number; typeID: number | null; name: string } | null>(null);
  function checkNearest(): void {
    const snap = space.get().snapshot;
    const entities = snap?.entities ?? [];
    const self = entities.find((e) => e.isSelf) ?? null;
    if (!snap || !self) { nearest = null; return; }
    let best: { d: number; e: (typeof entities)[number] } | null = null;
    for (const e of entities) {
      if (e.groupID === null || !NEARBY.has(e.groupID)) continue;
      const d = Math.hypot(e.position.x - self.position.x, e.position.y - self.position.y, e.position.z - self.position.z) - (e.radius ?? 0) - (self.radius ?? 0);
      if (!best || d < best.d) best = { d, e };
    }
    if (!best) { nearest = null; return; }
    if (nearest?.itemID === best.e.itemID) return;
    if (!best.e.name) flow.requestNames([{ kind: "evelocation", id: best.e.itemID }]);
    nearest = { itemID: best.e.itemID, typeID: best.e.typeID, name: best.e.name ?? "" };
  }
  onMount(() => { checkNearest(); const t = setInterval(checkNearest, 1313); return () => clearInterval(t); });
</script>

<section class="ip-panel">
  <div class="ip-top">
    <div class="ip-gutter">
      <button type="button" class="ip-expand" class:expanded={!compact} aria-label={compact ? "Expand" : "Collapse"} onclick={onToggle}>
        <img alt="" src={clientTexture("res:/UI/Texture/classes/Neocom/arrowDown.png")} /></button>
      <span class="ip-icon" title={word("UI/Neocom/ListItemsInSystem", "List items in system")}><img alt="" src={clientTexture("res:/UI/Texture/Classes/InfoPanels/LocationInfo.png")} /></span>
    </div>
    <div class="loc-header">
      {#if systemID && isWormhole && !system}
        <span class="loc-system">{resolvedName($names.resolved, "system", systemID, String(systemID))}</span>
      {:else if systemID}
        <button type="button" class="evelink loc-system" onclick={() => showInfo({ kind: "mapLocation", typeID: 5, itemID: systemID })}>{system?.[7] ?? resolvedName($names.resolved, "system", systemID, "")}</button>
        {#if security !== null}<span class="loc-sec" title={word("UI/Map/StarMap/SecurityStatus", "Security Status")} style:color={securityStatusColor(security)}>{shownSecurity(security).toFixed(1)}</span>{/if}
        {#if rangeIcon}<img class="loc-range" alt="" src={clientTexture(`res:/UI/Texture/${rangeIcon}`)} />{/if}
        {#if constellation && !isWormhole}<span class="loc-trace">&lt; <button type="button" class="evelink" onclick={() => showInfo({ kind: "mapLocation", typeID: 4, itemID: constellation[0] })}>{constellation[4]}</button></span>{/if}
        {#if region && !isWormhole}<span class="loc-trace">&lt; <button type="button" class="evelink" onclick={() => showInfo({ kind: "mapLocation", typeID: 3, itemID: region[0] })}>{region[4]}</button></span>{/if}
      {/if}
    </div>
  </div>
  {#if !compact}
    <div class="ip-main loc-body">
      {#if docked && dockedAt}
        <button type="button" class="evelink" title={word("UI/Generic/CurrentStation", "Current Station")} onclick={() => showInfo({ kind: "spaceObject", itemID: dockedAt, typeID: null })}>{$station.station?.stationName ?? resolvedName($names.resolved, "evelocation", dockedAt, "")}</button>
      {:else if nearest}
        <button type="button" class="evelink" title={word("UI/Neocom/Nearest", "Nearest")} onclick={() => showInfo({ kind: "spaceObject", itemID: nearest!.itemID, typeID: nearest!.typeID })}>{nearest.name || resolvedName($names.resolved, "evelocation", nearest.itemID, "")}</button>
      {/if}
      {#if factionID}
        <div class="loc-sov"><button type="button" class="evelink" onclick={() => showInfo({ kind: "faction", factionID: factionID! })}>{resolvedName($names.resolved, "faction", factionID, "")}</button></div>
      {:else if isWormhole}
        <div class="loc-sov">{word("UI/Neocom/Unclaimable", "Unclaimable")}</div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .ip-panel { pointer-events: auto; margin-bottom: 6px; }
  .ip-top { display: flex; align-items: flex-start; min-height: 28px; }
  .ip-gutter { display: flex; width: 56px; flex: none; }
  .ip-expand, .ip-icon { all: unset; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; opacity: 0.8; }
  .ip-expand { cursor: pointer; }
  .ip-expand:hover { opacity: 1; }
  .ip-expand img { width: 7px; height: 7px; transform: rotate(-90deg); }
  .ip-expand.expanded img { transform: none; }
  .ip-icon img { width: 16px; height: 16px; }
  .loc-header { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 4px; padding-top: 3px; min-width: 0; }
  .loc-system { font-size: 17px; color: rgb(255 255 255 / 0.95); }
  .loc-sec { font-size: 17px; padding-left: 2px; }
  .loc-range { width: 16px; height: 16px; align-self: center; }
  .loc-trace { font-size: 12px; opacity: 0.85; }
  .ip-main { padding-left: 56px; }
  .loc-body { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
  .loc-sov { padding-top: 2px; }
  .evelink { all: unset; cursor: pointer; }
  .evelink:hover { text-decoration: underline; }
</style>
