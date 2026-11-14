<script lang="ts">
  // Travel panel (goal R5b): the browser autopilot decide-loop's controls +
  // live readout. Start a route to a destination (station or system ID), then
  // Pause / Resume / Abort. The loop runs in the browser (app/flow.ts owns the
  // controller); this component is a pure reader of the store's travel slice.
  // No map / rendered scene — just current/next system, target, travel state,
  // remaining jumps, elapsed time, and an actionable failure reason.
  //
  // Closing the tab is closing the client: this JS dies and the loop stops
  // issuing (no "stop" is sent) — the ship completes its last server-side
  // command and sits. We deliberately register NO unload handler that would
  // send anything.
  import { onDestroy, onMount } from "svelte";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import { deriveDocked } from "./tabs.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { securityStatusColor, shownSecurity } from "../bridge/systemSecurity.ts";
  import type { LocationFound, WaypointsRoute } from "../app/flow.ts";
  import { waypointNameKind } from "../nav/waypoints.ts";
  import { clickDisableAutopilotAtEachWaypoint, disableAutopilotAtEachWaypoint } from "../app/autopilotStopAtEachWaypoint.ts";
  import {
    AVOIDANCE_TICKS, OFFERED_ROUTE_TYPES, PENALTY_RANGE, ROUTE_SETTING_WORD_LABELS, avoidanceTickOn, avoidingSystems, includingJumpGates,
    penaltyOf, penaltyWords, routeSettingWords, routeTypeOf,
  } from "../nav/autopilotSettings.ts";
  import { AVOID_WORDS } from "./avoidLocation.ts";
  import LocationSearchResults from "./LocationSearchResults.svelte";

  let { store, flow, showRouteWindow }: { store: ClientStore; flow: AppFlow; showRouteWindow?: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const waypoints = flow.waypoints;
  // svelte-ignore state_referenced_locally
  const routeSettingsKept = flow.routeSettings;
  // svelte-ignore state_referenced_locally
  const autopilotOn = flow.autopilotOn;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  /** The route panel's words (infoPanelRoute.py 53 to 123; menusvc.py _MapMenu). */
  const ROUTE_WORDS = {
    route: "UI/InfoWindow/TabNames/Route",
    currentDestination: "UI/Neocom/Autopilot/CurrentDestination",
    noDestination: "UI/Inflight/NoDestination",
    clearAll: "UI/Neocom/ClearAllAutopilotWaypoints",
    autopilotActive: "UI/Map/MapPallet/AutopilotActive",
    removeWaypoint: "UI/Inflight/RemoveWaypoint",
    setDestination: "UI/Inflight/SetDestination",
    disableAtEachWaypoint: "UI/Map/MapPallet/cbDisableAtEachWaypoint",
    jumps: "UI/Market/MarketQuote/NumberOfJumps",
    markerJumps: "UI/Common/numberOfJumps",
    addWaypoint: "UI/Inflight/AddWaypoint",
    optimize: "UI/Map/MapPallet/OptimizeRoute",
    manageRoute: "UI/Map/MapPallet/ManageRoute",
  } as const;
  /** The route panel's search's words (infoPanelRoute.py 128 to 129; searchUtil.py 43 to 54, 68 to 79). */
  const SEARCH_WORDS = {
    hint: "UI/Map/MapPallet/lblSearchForLocation",
    button: "UI/Map/MapPallet/btnSearchForLocation",
    header: "UI/Common/SearchResults",
    numResults: "UI/Search/UniversalSearch/WindowHeaderNumResults",
    overMax: "UI/Search/UniversalSearch/WindowHeaderOverMax",
    noResults: "UI/Search/UniversalSearch/NoResultsReturned",
    entryJumps: "UI/Fleet/FleetRegistry/NumberOfJumps",
  } as const;

  // svelte-ignore state_referenced_locally
  const travel = store.travel;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const station = store.station;

  // The route as the client's route panel shows it (infoPanelRoute.py UpdateRoute, 251 to 366): read again when the
  // waypoints change, the pilot is in another system, or the autopilot's settings change (OnAutopilotUpdated:
  // starMapSvc.py 2645) (flow.routeOfWaypoints, nav/routeMarkers.ts).
  let routeShown = $state.raw<WaypointsRoute | null>(null);
  const routeSystem = $derived($flight.status?.solarSystemID ?? null);
  $effect(() => {
    const kept = $waypoints;
    void routeSystem;
    void $routeSettingsKept;
    if (kept.length === 0) {
      routeShown = null;
      return;
    }
    let live = true;
    void flow.routeOfWaypoints().then((route) => {
      if (live) routeShown = route;
    }, () => {
      if (live) routeShown = null;
    });
    return () => {
      live = false;
    };
  });
  $effect(() => {
    const refs: NameRef[] = [];
    for (const marker of routeShown?.markers ?? []) {
      refs.push({ kind: "system", id: marker.solarSystemID }, { kind: "systemConstellation", id: marker.solarSystemID }, { kind: "systemRegion", id: marker.solarSystemID });
    }
    if (refs.length > 0) flow.requestNames(refs);
  });
  /** A label of the client's filled with a count, as plain text; the page's own words where it is not to hand. */
  function countWord(label: string, args: Record<string, string | number>, own: string): string {
    const template = $words.templates[label];
    return typeof template === "string" ? plainText(formatTemplate(template, args, { nameOf: () => "" })) : own;
  }
  /**
   * A marker's tooltip (AutopilotDestinationIcon.LoadTooltipPanel): the system and its rating, then its constellation
   * and region (infoPanelSvc.GetSolarSystemTrace); the station's name where it is one; and the jumps to it.
   */
  function markerTip(marker: WaypointsRoute["markers"][number]): string {
    const system = resolvedName($names.resolved, "system", marker.solarSystemID, "—");
    const rating = marker.security === null ? "" : ` ${shownSecurity(marker.security).toFixed(1)}`;
    const trace = `${system}${rating} < ${resolvedName($names.resolved, "systemConstellation", marker.solarSystemID, "—")} < ${resolvedName($names.resolved, "systemRegion", marker.solarSystemID, "—")}`;
    const lines = [trace];
    if (marker.kind === "station") lines.push(placeName(marker.destinationID));
    if (marker.numJumps > 0) lines.push(countWord(ROUTE_WORDS.markerJumps, { numJumps: marker.numJumps }, `${marker.numJumps} jumps`));
    return lines.join("\n");
  }

  // The autopilot's settings, which the client's route panel has in its menu: the kind of route, the
  // security penalty, and whether the systems on the list are avoided (nav/autopilotSettings.ts). They are
  // the pilot's own, so they are read again when the pilot at the helm changes; and followed as they change,
  // here or in the route window.
  const routeSettings = $derived($routeSettingsKept);
  // svelte-ignore state_referenced_locally
  let penaltyShown = $state(penaltyOf(flow.autopilotSettings()));
  const pilotID = $derived($station.online?.characterID ?? null);
  // Each effect must not read what it sets: read back, each setting would start it again, and the panel stops
  // ("effect_update_depth_exceeded", seen live on 2026-10-09).
  $effect(() => {
    void pilotID;
    flow.autopilotSettings();
  });
  $effect(() => {
    penaltyShown = penaltyOf($routeSettingsKept);
  });
  $effect(() => {
    flow.requestWords([...ROUTE_SETTING_WORD_LABELS, ...Object.values(ROUTE_WORDS), ...Object.values(SEARCH_WORDS), ...Object.values(AVOID_WORDS)]);
    // (The kinds an avoidable place is said to be, by its map item's group.)
    flow.requestNames([5, 4, 3].map((id) => ({ kind: "typeGroup", id }) as NameRef));
  });
  /** A name from the cache for a client text's tag. */
  const nameOf = (kind: NameRef["kind"], id: number): string => resolvedName($names.resolved, kind, id, "—");
  /** A route word from the install, the page's own where there is none to read. */
  const routeWord = (label: string, own: string): string => settingText(label) ?? own;
  /** The route panel's Autopilot active is offered to a pilot in space (infoPanelRoute.py 93: not docked). */
  const docked = $derived(deriveDocked($flight.status, $station.online));
  /** A waypoint's name: a structure's, a station's or a system's (nav/waypoints.ts takes no other). */
  const placeName = (id: number): string =>
    resolvedName($names.resolved, waypointNameKind(id), id, "—");
  $effect(() => {
    const refs: NameRef[] = $waypoints.map((id) => ({ kind: waypointNameKind(id), id }) as NameRef);
    if (refs.length > 0) flow.requestNames(refs);
  });
  const settingText = (label: string): string | null => {
    const template = $words.templates[label];
    return typeof template === "string" ? plainText(template) : null;
  };

  // R7a — set a destination anywhere by NAME (primary), with the raw-ID input
  // kept as a fallback. The search box hits the static /api/map/find route; a
  // chosen result is set as the destination, as the client's Set Destination
  // sets it (nav/waypoints.ts); the autopilot flies it once it is switched on.
  let searchQuery = $state("");
  let searchFound = $state.raw<ReadonlyMap<number, readonly LocationFound[]> | null>(null);
  let searchedFor = $state("");

  let destinationInput = $state("");
  let busy = $state(false);
  let error = $state("");
  let now = $state(Date.now());

  // R7c — the travel readout already resolves most names (from the route graph /
  // startRoute), but a bare ID can still leak through as a fallback. Request the
  // current/next/destination IDs (and any search-result system that lacks a name)
  // so those fallbacks attempt a name first.
  $effect(() => {
    const refs: NameRef[] = [];
    const t = $travel;
    for (const systemID of [t.currentSystemID, t.nextSystemID, t.destinationSystemID]) {
      if (systemID) {
        refs.push({ kind: "system", id: systemID });
      }
    }
    if (t.destinationStationID) {
      refs.push({ kind: "station", id: t.destinationStationID });
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    const running = $travel.status === "running";
    if (running && timer === null) {
      timer = setInterval(() => {
        now = Date.now();
      }, 1000);
    } else if (!running && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  });
  onDestroy(() => {
    if (timer) {
      clearInterval(timer);
    }
  });

  // R30 slice B — claim the space feed while the Travel tab is open.
  //
  // This is the tab the operator's complaint was actually about: you fly out,
  // come here to set a destination, and go back. Before the claim, that round
  // trip STOPPED the snapshot — distances, gauges and locks all froze while the
  // ship kept moving, then jumped when you returned. The autopilot's own reads
  // papered over it only while a route was actually running.
  onMount(() => {
    flow.startSpacePolling();
    return () => flow.stopSpacePolling();
  });

  const elapsed = $derived.by(() => {
    const started = $travel.startedAt;
    if (started === null) {
      return "—";
    }
    const totalSeconds = Math.max(0, Math.floor((now - started) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  });

  function parseID(value: string): number {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
  }

  // Search the static map by name; results go into local state (a transient
  // search, not a store slice). A too-short query clears the list.
  async function search(): Promise<void> {
    const query = searchQuery;
    await run(async () => {
      const found = await flow.searchLocations(query);
      if (found !== null) {
        searchFound = found;
        searchedFor = query.replace(/\*/g, "").trim();
      }
    });
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      if (isSessionLost(cause)) {
        error = "The live session ended (idle timeout or another client took over).";
      } else {
        error = panelErrorWords(cause);
      }
    } finally {
      busy = false;
    }
  }

  function systemText(id: number | null, name: string | null): string {
    if (id === null) {
      return "—";
    }
    // The graph name if the loop supplied one, else the name cache (R7c); the
    // raw system ID is never rendered.
    return name ?? resolvedName($names.resolved, "system", id, "—");
  }

  const destinationText = $derived.by(() => {
    const t = $travel;
    if (t.destinationName) {
      return t.destinationName;
    }
    // R7c/R7d — no destinationName recorded: resolve to a name, never a bare ID.
    if (t.destinationStationID) {
      return resolvedName($names.resolved, "station", t.destinationStationID, "—");
    }
    return t.destinationSystemID
      ? resolvedName($names.resolved, "system", t.destinationSystemID, "—")
      : "—";
  });
</script>

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Travel (autopilot)</h2>
  </header>
  <!-- ⚠ THE FIRST SENTENCE IS GONE, THE SECOND IS NOT. "Set a destination and
       the autopilot flies you there" is this window telling you what a window
       called Travel is for — read once, looked past forever after. What stays
       is the half a player cannot see and would not guess. -->
  <p class="note">
    Closing this tab stops the autopilot — the ship finishes its last move and
    waits.
  </p>
</section>

<!-- The route (infoPanelRoute.py): the destination and the waypoints on the way, each taken off by Remove Waypoint,
     Clear All Waypoints, and Autopilot active, offered in space: the autopilot flies to the first waypoint and is
     switched off there, or flies on where Disable Autopilot at Each Waypoint is unticked (nav/waypoints.ts,
     app/autopilotStopAtEachWaypoint.ts). -->
<section class="route-panel">
  <h2>{routeWord(ROUTE_WORDS.route, "Route")}{#if routeShown !== null}{" "}<small>{countWord(ROUTE_WORDS.jumps, { num: routeShown.jumps }, `${routeShown.jumps} jumps`)}</small>{/if}</h2>
  {#if $waypoints.length === 0}
    <p class="empty">{routeWord(ROUTE_WORDS.noDestination, "Nowhere set")}</p>
  {:else}
    <p>{routeWord(ROUTE_WORDS.currentDestination, "Heading for")}: <strong>{placeName($waypoints[$waypoints.length - 1] ?? 0)}</strong></p>
    {#if routeShown !== null && routeShown.markers.length > 0}
      <!-- A marker for each place on the way (UpdateRoute 284 to 344): its system's security's colour, a waypoint's
           and a station's each their own shape. -->
      <div class="route-markers">
        {#each routeShown.markers as marker, i (i)}
          <span class="route-marker {marker.kind}" title={markerTip(marker)}
            style:background-color={marker.security === null ? "grey" : securityStatusColor(marker.security)}></span>
        {/each}
      </div>
    {/if}
    <ol class="route">
      {#each $waypoints as id (id)}
        <li>
          {placeName(id)}
          <button type="button" class="minor" onclick={() => flow.clearWaypoints(id)}>{routeWord(ROUTE_WORDS.removeWaypoint, "Take off")}</button>
        </li>
      {/each}
    </ol>
    <p class="controls">
      <button type="button" class="minor" onclick={() => flow.clearWaypoints()}>{routeWord(ROUTE_WORDS.clearAll, "Clear the route")}</button>
      {#if $waypoints.length > 1}
        <button type="button" class="minor" disabled={busy} onclick={() => void run(() => flow.optimizeRoute())}>{routeWord(ROUTE_WORDS.optimize, "Best order")}</button>
      {/if}
    </p>
  {/if}
  {#if showRouteWindow}
    <!-- Manage Route (infoPanelRoute.py 123): the route window, offered whatever the route. -->
    <p class="controls">
      <button type="button" class="minor" onclick={() => showRouteWindow?.()}>{routeWord(ROUTE_WORDS.manageRoute, "Waypoints and avoidance")}</button>
    </p>
  {/if}
  <p class="controls">
    <label>
      <input
        type="checkbox"
        checked={$autopilotOn}
        disabled={docked}
        onchange={(event) => {
          if (event.currentTarget.checked) void flow.activateAutopilot();
          else flow.deactivateAutopilot();
        }}
      />
      {routeWord(ROUTE_WORDS.autopilotActive, "Autopilot on")}
    </label>
  </p>
</section>

<!-- The run's own controls while a route runs; the search, the route settings and the destination by number whatever
     it does, as the client's route panel has its search box and settings (infoPanelRoute.py GetSettingsMenu, 90 to
     123; AddSearchBox, 126 to 132). -->
{#if $travel.status === "running" || $travel.status === "paused"}
  <section>
    <h2>Route to {destinationText}</h2>
    <p class="controls">
      {#if $travel.status === "running"}
        <button type="button" disabled={busy} onclick={() => run(async () => flow.pauseRoute())}>Pause</button>
      {:else if $travel.status === "paused"}
        <button type="button" disabled={busy} onclick={() => run(async () => flow.resumeRoute())}>Resume</button>
      {/if}
      <button type="button" disabled={busy} onclick={() => run(async () => flow.abortRoute())}>Abort</button>
    </p>
  </section>
{/if}

  <section>
    <h2>Set destination</h2>
    <p class="note">
      Search for a solar system, constellation, region, station or structure by
      name, as the client's route panel searches, and put a place on the route;
      the autopilot flies there once it is on. The route is planned from where
      you are when it starts.
    </p>
    <p class="controls">
      <label>
        Search
        <input
          type="search"
          bind:value={searchQuery}
          placeholder={routeWord(SEARCH_WORDS.hint, "e.g. Jita")}
          onkeydown={(event) => {
            if (event.key === "Enter") {
              void search();
            }
          }}
        />
      </label>
      <button type="button" disabled={busy || searchQuery.trim().length < 1} onclick={() => void search()}>
        {routeWord(SEARCH_WORDS.button, "Search")}
      </button>
    </p>
    {#if searchFound !== null}
      <LocationSearchResults {store} {flow} found={searchFound} {searchedFor} />
    {/if}
    {#if $travel.failureReason}
      <p class="error">{$travel.failureReason}</p>
    {/if}
    {#if error}
      <p class="error">{error}</p>
    {/if}
  </section>

  <section class="route-settings">
    <h2>Route settings</h2>
    <p class="controls">
      {#each OFFERED_ROUTE_TYPES as routeType (routeType)}
        <label class="route-type">
          <input
            type="radio"
            name="pfRouteType"
            value={routeType}
            checked={routeTypeOf(routeSettings) === routeType}
            onchange={() => { flow.setAutopilotRouteType(routeType); }}
          />
          {routeSettingWords(routeType as "shortest" | "safe" | "unsafe", settingText)}
        </label>
      {/each}
    </p>
    <p class="controls">
      <label class="route-penalty">
        <input
          type="range"
          min={PENALTY_RANGE.least}
          max={PENALTY_RANGE.most}
          step="1"
          value={penaltyShown}
          oninput={(event) => { penaltyShown = Number(event.currentTarget.value); }}
          onchange={(event) => { penaltyShown = penaltyOf(flow.setAutopilotPenalty(Number(event.currentTarget.value))); }}
        />
        {penaltyWords(routeSettingWords("penalty", settingText), penaltyShown)}
      </label>
      <!-- Whether the route may go through the Ansiblex jump gates the pilot may use (nav/jumpGates.ts); clicked, the jump
           gates are read again and the route optimized. -->
      <label class="route-jump-gates">
        <input
          type="checkbox"
          checked={includingJumpGates(routeSettings)}
          onchange={(event) => {
            event.currentTarget.checked = includingJumpGates(flow.clickIncludeJumpGates());
          }}
        />
        {routeSettingWords("includeJumpGates", settingText)}
      </label>
      <!-- The ticks that add the server's lists, in the route panel's order (pod kills, the Triglavians' and EDENCOM's
           systems), each before the list's own tick. -->
      {#each AVOIDANCE_TICKS as tick (tick)}
        <label class="route-avoid-list">
          <input
            type="checkbox"
            checked={avoidanceTickOn(routeSettings, tick)}
            onchange={(event) => {
              event.currentTarget.checked = avoidanceTickOn(flow.clickAutopilotAvoidanceTick(tick), tick);
            }}
          />
          {routeSettingWords(tick, settingText)}
        </label>
      {/each}
      <label class="route-avoid">
        <input
          type="checkbox"
          checked={avoidingSystems(routeSettings)}
          onchange={(event) => {
            const kept = flow.clickAutopilotAvoidSystems();
            // The client's first click on a tick never touched leaves it on: the box is put back to what is kept.
            event.currentTarget.checked = avoidingSystems(kept);
          }}
        />
        {routeSettingWords("avoidSystems", settingText)}
      </label>
      <label class="route-stop-each">
        <input
          type="checkbox"
          checked={$disableAutopilotAtEachWaypoint}
          onchange={(event) => {
            clickDisableAutopilotAtEachWaypoint();
            event.currentTarget.checked = disableAutopilotAtEachWaypoint.get();
          }}
        />
        {routeWord(ROUTE_WORDS.disableAtEachWaypoint, "Turn the autopilot off at each waypoint")}
      </label>
    </p>
  </section>

  <section>
    <h2>Destination by ID</h2>
    <p class="note">Advanced: enter a station or solar system ID directly.</p>
    <p class="controls">
      <label>
        Destination
        <input
          type="number"
          min="1"
          bind:value={destinationInput}
          placeholder="station or system ID"
        />
      </label>
      <button
        type="button"
        disabled={busy || parseID(destinationInput) === 0}
        onclick={() => { error = ""; flow.setDestination(parseID(destinationInput)); }}
      >
        {routeWord(ROUTE_WORDS.setDestination, "Head there")}
      </button>
    </p>
  </section>

{#if $travel.status !== "idle"}
  <section>
    <h2>Status</h2>
    <table class="guests">
      <tbody>
        <tr><th>State</th><td>{$travel.status}{$travel.phase ? ` · ${$travel.phase}` : ""}</td></tr>
        <tr><th>Action</th><td>{$travel.action ?? "—"}</td></tr>
        <tr><th>Current system</th><td>{systemText($travel.currentSystemID, $travel.currentSystemName)}</td></tr>
        <tr><th>Next system</th><td>{systemText($travel.nextSystemID, $travel.nextSystemName)}</td></tr>
        <tr><th>Destination</th><td>{destinationText}</td></tr>
        <tr><th>Remaining jumps</th><td class="num">{$travel.remainingJumps} / {$travel.totalJumps}</td></tr>
        <tr><th>Elapsed</th><td>{elapsed}</td></tr>
        <tr>
          <th>Failure</th>
          <td>{#if $travel.failureReason}<span class="error">{$travel.failureReason}</span>{:else}—{/if}</td>
        </tr>
      </tbody>
    </table>
    {#if error}
      <p class="error">{error}</p>
    {/if}
  </section>

  {#if $travel.route.length > 0}
    <section>
      <h2>Planned route ({$travel.totalJumps} jumps)</h2>
      <ol class="route">
        {#each $travel.route as hop (hop.fromSystemID + "-" + hop.toSystemID)}
          <li>
            {hop.fromSystemName ?? resolvedName($names.resolved, "system", hop.fromSystemID, "—")}
            → {hop.toSystemName ?? resolvedName($names.resolved, "system", hop.toSystemID, "—")}
          </li>
        {/each}
      </ol>
    </section>
  {/if}
{/if}

<style>
  /* The route's markers (infoPanelRoute.py: ROUTE_MARKERSIZE 8, ROUTE_MARKERGAP 2), each drawn in its system's
     colour; a waypoint's and a station's marker each a shape of its own, where the client has a picture of each. */
  .route-markers { display: flex; flex-wrap: wrap; gap: 2px; margin: 0.25rem 0; }
  .route-marker { display: inline-block; width: 8px; height: 8px; }
  .route-marker.waypoint { transform: rotate(45deg) scale(0.85); }
  .route-marker.station { border-radius: 50%; }
</style>
