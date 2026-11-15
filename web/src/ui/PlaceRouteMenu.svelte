<script lang="ts">
  // A place's celestial menu, as far as it is the route (menusvc.py _CelestialMenu, 2003 to 2008), for a window that
  // lists places, under the heading that window's row menu gives it: the market's orders (entries.py GetMenu, 111 to
  // 123: Location), a contract's stations (contractentry.py 76 to 81: Pick Up Station, Drop Off Station), an industry
  // job's or blueprint's facility (jobEntry.py 197, blueprintEntry.py 183: Facility), a fleet member's system
  // (fleetCompositionWnd.py 163 and 164: Solar System). Its button opens it; it offers what the client's checkers
  // allow (nav/waypoints.ts celestialRouteEntries); each entry closes it.
  //
  // A structure is taken as one the structure directory knows (CanBeWaypoint, by GetWaypointSolarsystemID): the flow
  // asks the directory before it sets one, and refuses it as the client's star map does where it is not known.
  import { plainText } from "../bridge/clientWords.ts";
  import { celestialRouteEntries, isPlayerItemID, isWaypointPlace } from "../nav/waypoints.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";

  /** A row menu's heading for the place: the client's label, and this page's own words where the install's are not to hand. */
  interface PlaceMenuHeading {
    readonly label: string;
    readonly own: string;
  }

  let { store, flow, placeID, heading = { label: "UI/Common/Location", own: "Where" }, travelBroadcast = null }: {
    store: ClientStore;
    flow: AppFlow;
    placeID: number;
    heading?: PlaceMenuHeading;
    /** The broadcast entry itself opens GetMenu_TravelTo. */
    travelBroadcast?: string | null;
  } = $props();
  // svelte-ignore state_referenced_locally
  const waypoints = flow.waypoints;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const station = store.station;

  const WORDS = {
    setDestination: "UI/Inflight/SetDestination",
    addWaypoint: "UI/Inflight/AddWaypoint",
    removeWaypoint: "UI/Inflight/RemoveWaypoint",
  } as const;
  $effect(() => {
    flow.requestWords([...Object.values(WORDS), heading.label]);
  });
  const word = (label: string, own: string): string => {
    const template = $words.templates[label];
    return typeof template === "string" && template !== "" ? plainText(template) : own;
  };

  let open = $state(false);
  const here = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const entries = $derived(travelBroadcast === null
    ? celestialRouteEntries(placeID, isWaypointPlace(placeID) || isPlayerItemID(placeID), here, $waypoints)
    : { setDestination: true, addWaypoint: !$waypoints.includes(placeID), removeWaypoint: $waypoints.includes(placeID) });

  function choose(how: "destination" | "add" | "remove"): void {
    open = false;
    if (how === "destination") flow.setDestination(placeID);
    else if (how === "add") flow.addWaypoint(placeID);
    else flow.clearWaypoints(placeID);
  }
</script>

<span class="place-route">
  <button
    type="button"
    class="minor"
    class:travel-entry={travelBroadcast !== null}
    aria-label={travelBroadcast ?? word(heading.label, heading.own)}
    title={travelBroadcast === null ? word(heading.label, heading.own) : undefined}
    aria-expanded={open}
    onclick={(event) => {
      event.stopPropagation();
      open = !open;
    }}
    oncontextmenu={(event) => {
      if (travelBroadcast === null) return;
      event.preventDefault();
      open = true;
    }}
  >{travelBroadcast ?? "⋯"}</button>
  {#if open}
    <span class="place-route-menu">
      {#if entries.setDestination}
        <button type="button" class="minor" onclick={() => choose("destination")}>{word(WORDS.setDestination, travelBroadcast === null ? "Head there" : "Set Destination")}</button>
      {/if}
      {#if entries.addWaypoint}
        <button type="button" class="minor" onclick={() => choose("add")}>{word(WORDS.addWaypoint, travelBroadcast === null ? "Put on the route" : "Add Waypoint")}</button>
      {:else if entries.removeWaypoint}
        <button type="button" class="minor" onclick={() => choose("remove")}>{word(WORDS.removeWaypoint, travelBroadcast === null ? "Take off the route" : "Remove Waypoint")}</button>
      {/if}
    </span>
  {/if}
</span>

<style>
  .place-route { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; }
  .place-route-menu { display: inline-flex; flex-wrap: wrap; gap: 0.25rem; }
  .travel-entry { padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; }
  .travel-entry:hover { text-decoration: underline; }
</style>
