<script lang="ts">
  // infoPanels/infoPanelRoute.InfoPanelRoute (PANEL_ROUTE, after the location's; label UI/InfoWindow/TabNames/Route,
  // Route.png). The header in normal mode "Route <fontsize=12>NumberOfJumps {num}" (UpdateHeaderText; no destination,
  // no sub-header); in compact mode the first system of the route as CurrentDestination's trace, else NoDestination.
  // The body in normal mode (UpdateRoute), the route being the star map's autopilot route (the waypoints' paths, a
  // station after its system), else the waypoints:
  //   - none: NoDestination;
  //   - NextWaypointPanel: the first entry's GetSolarSystemTrace ("<name> <security> < constellation < region",
  //     hint NextSystemInRoute) on (0, 0, 0, 0.3), its pointer down;
  //   - the markers (AutopilotDestinationIcon, 8 square, 2 apart, wrapping at the panel's width): the route's entries
  //     less a system just before a station and a system right after its own station; each in its system's colour
  //     (GetModifiedSystemColor), stationMarker / waypointMarker / normalMarker; a click its Show Info;
  //   - DestinationWaypointPanel (more than one entry): the last entry's trace (hint CurrentDestination), its pointer up
  //     under the last marker.
  // _GetNumJumps: the route's distinct systems (a station as its system), less one where the first is the pilot's.
  // The header button: AutopilotSettings' menu (RouteSettingsMenu.svelte).
  // Not here: the header menu's search; the markers' menus, drag and hover; the lawless and Triglavian markers; the animations. A structure waypoint's own system is
  // not put before it (the route window reads no system for a structure).
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, RouteWindowWaypoints } from "../app/flow.ts";
  import type { StarMapData } from "../app/api.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { securityStatusColor, shownSecurity } from "../bridge/systemSecurity.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "../play/window.ts";
  import { showInfo } from "./showInfo.ts";
  import RouteSettingsMenu from "./RouteSettingsMenu.svelte";
  let { store, flow, compact, onToggle, openRouteWindow }: { store: ClientStore; flow: AppFlow; compact: boolean; onToggle: () => void; openRouteWindow?: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const waypointsSignal = flow.waypoints;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const R = "UI/Neocom/Autopilot/";
  const LABELS = ["UI/InfoWindow/TabNames/Route", "UI/Market/MarketQuote/NumberOfJumps", "UI/Inflight/NoDestination", R + "CurrentDestination", R + "NextSystemInRoute", "UI/Map/MapPallet/ManageRoute"];
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (k, id) => resolvedName($names.resolved, k, id, "") }));
  let map = $state<StarMapData | null>(null), plan = $state<RouteWindowWaypoints | null>(null), menu = $state(false);
  onMount(() => { flow.requestWords(LABELS); void flow.loadStarMap().then((m) => { map = m; }, () => {}); });
  const systemID = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  // OnDestinationSet: the waypoints changed, the pilot's system, or the autopilot's settings (the star map plots the
  // route again on OnAutopilotUpdated).
  // svelte-ignore state_referenced_locally
  const routeSettings = flow.routeSettings;
  $effect(() => { void $waypointsSignal; void systemID; void $routeSettings; void flow.routeWindowWaypoints().then((p) => { plan = p; }, () => { plan = null; }); });
  const isSystem = (id: number) => id >= 30_000_000 && id <= 39_999_999;
  const isStation = (id: number) => id >= 60_000_000 && id < 64_000_000;
  // The autopilot route: each waypoint's way there, then (a station) its system, then it.
  const route = $derived.by((): readonly number[] => {
    if (!plan) return $waypointsSignal;
    const out: number[] = [];
    for (const w of plan.waypoints) {
      out.push(...w.between);
      if (!isSystem(w.id) && isStation(w.id) && w.within[0] !== undefined && out.at(-1) !== w.within[0] && w.within[0] !== plan.currentSystemID) out.push(w.within[0]);
      out.push(w.id);
    }
    return out;
  });
  const systemOf = (id: number): number | null => (isSystem(id) ? id : plan?.waypoints.find((w) => w.id === id)?.within[0] ?? null);
  // UpdateRoute's routeIDs.
  const routeIDs = $derived.by(() => {
    const out: number[] = [];
    let lastStationSystemID: number | null = null;
    route.forEach((id, i) => {
      const isLast = i === route.length - 1;
      if (isSystem(id) && !isLast && !isSystem(route[i + 1]!)) return;
      if (isSystem(id) && lastStationSystemID === id) return;
      lastStationSystemID = isStation(id) ? systemOf(id) : null;
      out.push(id);
    });
    return out;
  });
  // _GetNumJumps
  const numJumps = $derived.by(() => {
    const ids: number[] = [];
    let last: number | null = null;
    for (const raw of route) {
      const id = isStation(raw) ? systemOf(raw) ?? raw : raw;
      if (id !== last && isSystem(id)) ids.push(id);
      last = id;
    }
    return ids.length && ids[0] === systemID ? ids.length - 1 : ids.length;
  });
  const sys = (id: number | null) => (map && id ? map.systems.find((s) => s[0] === id) ?? null : null);
  const securityOf = (id: number | null) => { const s = sys(id); return s && typeof s[8] === "number" ? s[8] : null; };
  // GetSolarSystemTrace's parts for an entry's system.
  function trace(id: number) {
    const systemIDOf = systemOf(id);
    const s = sys(systemIDOf);
    const c = s ? map?.constellations?.find((x) => x[0] === s[6]) ?? null : null;
    const r = s ? map?.regions?.find((x) => x[0] === s[5]) ?? null : null;
    return { systemID: systemIDOf, name: s?.[7] ?? (systemIDOf ? resolvedName($names.resolved, "system", systemIDOf, "") : ""), security: securityOf(systemIDOf), constellation: c, region: r };
  }
  const markerOf = (id: number, waypoints: readonly number[]) => (isSystem(id) ? (waypoints.includes(id) ? "waypointMarker" : "normalMarker") : "stationMarker");
</script>

{#snippet traceLine(id: number, hint: string)}
  {@const t = trace(id)}
  <div class="rt-trace">
    {#if t.systemID}<button type="button" class="evelink rt-system" title={hint} onclick={() => showInfo({ kind: "mapLocation", typeID: 5, itemID: t.systemID! })}>{t.name}</button>{/if}
    {#if t.security !== null}<span style:color={securityStatusColor(t.security)}>{shownSecurity(t.security).toFixed(1)}</span>{/if}
    {#if t.constellation}<span class="rt-small">&lt; <button type="button" class="evelink" onclick={() => showInfo({ kind: "mapLocation", typeID: 4, itemID: t.constellation![0] })}>{t.constellation[4]}</button></span>{/if}
    {#if t.region}<span class="rt-small">&lt; <button type="button" class="evelink" onclick={() => showInfo({ kind: "mapLocation", typeID: 3, itemID: t.region![0] })}>{t.region[4]}</button></span>{/if}
  </div>
{/snippet}

<section class="ip-panel">
  <div class="ip-top">
    <div class="ip-gutter">
      <button type="button" class="ip-expand" class:expanded={!compact} aria-label={compact ? "Expand" : "Collapse"} onclick={onToggle}>
        <img alt="" src={clientTexture("res:/UI/Texture/classes/Neocom/arrowDown.png")} /></button>
      <button type="button" class="ip-icon" onclick={() => { menu = !menu; }}><img alt="" src={clientTexture("res:/UI/Texture/Classes/InfoPanels/Route.png")} /></button>
      {#if menu}
        <div class="rt-menu-wrap" role="presentation" onmouseleave={() => { menu = false; }}><RouteSettingsMenu {store} {flow} {openRouteWindow} onClose={() => { menu = false; }} /></div>
      {/if}
    </div>
    {#if !compact}
      <div class="rt-header"><span class="rt-title">{word("UI/InfoWindow/TabNames/Route") || "Route"}</span>
        {#if $waypointsSignal.length}<span class="rt-small">{word("UI/Market/MarketQuote/NumberOfJumps", { num: numJumps })}</span>{/if}</div>
    {:else if route.length}
      <div class="rt-header rt-compact"><span class="rt-small">{word(R + "CurrentDestination")}</span>{@render traceLine(route[0]!, word(R + "CurrentDestination"))}</div>
    {:else}
      <div class="rt-header rt-compact">{word("UI/Inflight/NoDestination") || "No Destination"}</div>
    {/if}
  </div>
  {#if !compact}
    <div class="ip-main">
      {#if !route.length}
        <div class="rt-none">{word("UI/Inflight/NoDestination") || "No Destination"}</div>
      {:else}
        <div class="rt-box">{@render traceLine(route[0]!, word(R + "NextSystemInRoute"))}</div>
        <img class="rt-pointer" alt="" src={clientTexture("res:/UI/Texture/classes/LocationInfo/pointerDown.png")} />
        <div class="rt-markers">
          {#each routeIDs as id, i (`${i}:${id}`)}
            {@const sec = securityOf(systemOf(id))}
            <button type="button" class="rt-marker" title={trace(id).name} style:--marker={sec === null ? "#5a6168" : securityStatusColor(sec)}
              style:mask-image={`url(${clientTexture(`res:/UI/Texture/classes/LocationInfo/${markerOf(id, $waypointsSignal)}.png`)})`}
              onclick={() => (isSystem(id) ? showInfo({ kind: "mapLocation", typeID: 5, itemID: id }) : showInfo({ kind: "spaceObject", itemID: id, typeID: null }))}></button>
          {/each}
        </div>
        {#if routeIDs.length > 1}
          <img class="rt-pointer up" alt="" style:margin-left={`${((routeIDs.length - 1) % 25) * 10}px`} src={clientTexture("res:/UI/Texture/classes/LocationInfo/pointerUp.png")} />
          <div class="rt-box">{@render traceLine(routeIDs.at(-1)!, word(R + "CurrentDestination"))}</div>
        {/if}
      {/if}
    </div>
  {/if}
</section>

<style>
  .ip-panel { pointer-events: auto; margin-bottom: 6px; }
  .ip-top { display: flex; align-items: center; min-height: 28px; }
  .ip-gutter { position: relative; display: flex; width: 56px; flex: none; }
  .ip-expand, .ip-icon { all: unset; cursor: pointer; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; opacity: 0.8; }
  .ip-expand:hover, .ip-icon:hover { opacity: 1; }
  .ip-expand img { width: 7px; height: 7px; transform: rotate(-90deg); }
  .ip-expand.expanded img { transform: none; }
  .ip-icon img { width: 16px; height: 16px; }
  .rt-menu-wrap { display: contents; }
  .rt-header { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
  .rt-title { font-size: 17px; color: rgb(255 255 255 / 0.95); }
  .rt-compact { flex-wrap: wrap; font-size: 13px; }
  .rt-small { font-size: 12px; opacity: 0.85; }
  .ip-main { padding-left: 56px; }
  .rt-none { font-size: 12px; }
  .rt-box { background: rgb(0 0 0 / 0.3); padding: 8px; text-align: center; }
  .rt-trace { display: flex; flex-wrap: wrap; justify-content: center; align-items: baseline; gap: 4px; font-size: 12px; }
  .rt-system { font-weight: bold; }
  .rt-pointer { display: block; width: 10px; height: 10px; opacity: 0.3; }
  .rt-pointer.up { margin-top: 2px; }
  .rt-markers { display: flex; flex-wrap: wrap; gap: 2px; padding: 2px 0; }
  .rt-marker { all: unset; cursor: pointer; width: 8px; height: 8px; background: var(--marker); mask-size: contain; -webkit-mask-size: contain; }
  .evelink { all: unset; cursor: pointer; }
  .evelink:hover { text-decoration: underline; }
</style>
