<script lang="ts">
  // The route info panel's header menu (infoPanels/infoPanelRoute.InfoPanelRoute.GetSettingsMenu), in its order:
  // AutopilotActive (disabled docked; autoPilot SetOn / SetOff), [ShowRoutePathInSpace - no route drawn in space here],
  // the route types cbPreferShorter / cbPreferSafer / cbPreferRisky (SetAutopilotRouteType), the security penalty slider
  // 1-100 ("lblSecurityPenelity %i", set on release), a space, IncludeJumpGates, cbAdvoidPodkill,
  // cbAvoidTriglavianTales, cbAvoidEdencomSystems, cbAdvoidSystemsOnList (each warning as it is turned on - flow's
  // clickAvoidingTick), cbDisableAtEachWaypoint, a divider, ClearAllAutopilotWaypoints (with any waypoint),
  // OptimizeRoute (with more than one), ManageRoute. The same settings as the workspace's route panel (Travel.svelte).
  // AddSearchBox at its top: a 220-wide line (maxLength 64, hint lblSearchForLocation) and btnSearchForLocation; Return
  // or the button opens the search results window (SearchForLocation - GetResultsInNewWindow, LocationSearchWindow) and
  // closes the menu. Not here: ShowRoutePathInSpace.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { clickDisableAutopilotAtEachWaypoint, disableAutopilotAtEachWaypoint } from "../app/autopilotStopAtEachWaypoint.ts";
  import {
    AVOIDANCE_TICKS, OFFERED_ROUTE_TYPES, PENALTY_RANGE, ROUTE_SETTING_WORD_LABELS, avoidanceTickOn, avoidingSystems, includingJumpGates,
    penaltyOf, penaltyWords, routeSettingWords, routeTypeOf,
  } from "../nav/autopilotSettings.ts";
  import { onMount } from "svelte";
  import { searchLocationsInWindow } from "./locationSearchRequests.ts";
  let { store, flow, openRouteWindow, onClose }: { store: ClientStore; flow: AppFlow; openRouteWindow?: () => void; onClose: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const kept = flow.routeSettings;
  // svelte-ignore state_referenced_locally
  const autopilotOn = flow.autopilotOn;
  // svelte-ignore state_referenced_locally
  const waypoints = flow.waypoints;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const stopEach = disableAutopilotAtEachWaypoint;
  const M = "UI/Map/MapPallet/";
  const LABELS = [M + "lblSearchForLocation", M + "btnSearchForLocation", ...ROUTE_SETTING_WORD_LABELS, M + "AutopilotActive", M + "cbDisableAtEachWaypoint", "UI/Neocom/ClearAllAutopilotWaypoints", M + "OptimizeRoute", M + "ManageRoute"];
  onMount(() => flow.requestWords(LABELS));
  const text = (label: string): string | null => { const t = $words.templates[label]; return typeof t === "string" ? plainText(t) : null; };
  const word = (label: string, own: string) => text(label) ?? own;
  const settings = $derived($kept);
  const docked = $derived($flight.status?.docked === true);
  // svelte-ignore state_referenced_locally
  let penalty = $state(penaltyOf(flow.autopilotSettings()));
  $effect(() => { penalty = penaltyOf($kept); });
  let searchText = $state("");
</script>

<div class="rs-menu" role="menu" tabindex="-1">
  <div class="rs-search">
    <input type="search" maxlength="64" placeholder={word(M + "lblSearchForLocation", "Search for location")} bind:value={searchText}
      onkeydown={(e) => { if (e.key === "Enter" && searchText.trim()) { searchLocationsInWindow(searchText); onClose(); } }} />
    <button type="button" disabled={!searchText.trim()} onclick={() => { searchLocationsInWindow(searchText); onClose(); }}>{word(M + "btnSearchForLocation", "Search")}</button>
  </div>
  <hr />
  <label class:disabled={docked}><input type="checkbox" checked={$autopilotOn} disabled={docked}
    onchange={(e) => { if (e.currentTarget.checked) void flow.activateAutopilot(); else flow.deactivateAutopilot(); }} /> {word(M + "AutopilotActive", "Autopilot Active")}</label>
  {#each OFFERED_ROUTE_TYPES as routeType (routeType)}
    <label><input type="radio" name="ip-route-type" checked={routeTypeOf(settings) === routeType} onchange={() => flow.setAutopilotRouteType(routeType)} />
      {routeSettingWords(routeType as "shortest" | "safe" | "unsafe", text)}</label>
  {/each}
  <div class="rs-slider">
    <input type="range" min={PENALTY_RANGE.least} max={PENALTY_RANGE.most} step="1" value={penalty}
      oninput={(e) => { penalty = Number(e.currentTarget.value); }}
      onchange={(e) => { penalty = penaltyOf(flow.setAutopilotPenalty(Number(e.currentTarget.value))); }} />
    <span>{penaltyWords(routeSettingWords("penalty", text), penalty)}</span>
  </div>
  <div class="rs-space"></div>
  <label><input type="checkbox" checked={includingJumpGates(settings)} onchange={(e) => { e.currentTarget.checked = includingJumpGates(flow.clickIncludeJumpGates()); }} />
    {routeSettingWords("includeJumpGates", text)}</label>
  {#each AVOIDANCE_TICKS as tick (tick)}
    <label><input type="checkbox" checked={avoidanceTickOn(settings, tick)} onchange={(e) => { e.currentTarget.checked = avoidanceTickOn(flow.clickAutopilotAvoidanceTick(tick), tick); }} />
      {routeSettingWords(tick, text)}</label>
  {/each}
  <label><input type="checkbox" checked={avoidingSystems(settings)} onchange={(e) => { e.currentTarget.checked = avoidingSystems(flow.clickAutopilotAvoidSystems()); }} />
    {routeSettingWords("avoidSystems", text)}</label>
  <label><input type="checkbox" checked={$stopEach} onchange={(e) => { clickDisableAutopilotAtEachWaypoint(); e.currentTarget.checked = disableAutopilotAtEachWaypoint.get(); }} />
    {word(M + "cbDisableAtEachWaypoint", "Disable autopilot at each waypoint")}</label>
  <hr />
  {#if $waypoints.length > 0}<button type="button" onclick={() => { flow.clearWaypoints(); onClose(); }}>{word("UI/Neocom/ClearAllAutopilotWaypoints", "Clear All Waypoints")}</button>{/if}
  {#if $waypoints.length > 1}<button type="button" onclick={() => { void flow.optimizeRoute(); onClose(); }}>{word(M + "OptimizeRoute", "Optimize Route")}</button>{/if}
  <button type="button" onclick={() => { onClose(); openRouteWindow?.(); }}>{word(M + "ManageRoute", "Manage Route")}</button>
</div>

<style>
  .rs-menu { position: absolute; left: 28px; top: 28px; z-index: 6; display: flex; flex-direction: column; min-width: 240px; padding: 4px 0; background: rgb(20 22 26 / 0.97); border: 1px solid rgb(255 255 255 / 0.15); font-size: 12px; }
  .rs-menu label, .rs-menu button { all: unset; cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 3px 10px; }
  .rs-menu label.disabled { opacity: 0.5; cursor: default; }
  .rs-menu label:hover, .rs-menu button:hover { background: rgb(255 255 255 / 0.08); }
  .rs-search { display: flex; gap: 4px; padding: 6px; }
  .rs-search input { width: 220px; }
  .rs-search button { all: revert; }
  .rs-slider { display: flex; align-items: center; gap: 6px; padding: 3px 10px 3px 27px; }
  .rs-slider input { width: 100px; }
  .rs-space { height: 6px; }
  .rs-menu hr { border: none; border-top: 1px solid rgb(255 255 255 / 0.1); margin: 4px 0; width: 100%; }
</style>
