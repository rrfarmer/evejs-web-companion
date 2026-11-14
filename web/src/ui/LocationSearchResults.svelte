<script lang="ts">
  // A location search's results as the client's search window lists them (searchUtil.GetResultsInNewWindow, 65 to 84):
  // the header (SearchResults), the count (WindowHeaderNumResults / WindowHeaderOverMax at search_const.max_result_count
  // 500, NoResultsReturned), then by kind in RESULT_ORDER (30 to 42) under its label. A system's and a station's entry
  // its system's rating and its jumps from here (SolarSystem._GetText, 35 to 45); a system, station or structure the
  // route entries (CelestialChecker OfferSetDestination - not the system the pilot is in nor the route's last
  // waypoint - and OfferAddWaypoint / RemoveWaypoint); an avoidable place Avoid / Do Not Avoid. Shared by the
  // workspace's route panel (Travel.svelte) and the play view's search results window (LocationSearchWindow.svelte).
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, LocationFound } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { securityStatusColor, shownSecurity } from "../bridge/systemSecurity.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import { avoidanceItems, isAvoidablePlace } from "../nav/autopilotSettings.ts";
  import { AVOID_WORDS, avoidEntryWords } from "./avoidLocation.ts";
  let { store, flow, found, searchedFor }: { store: ClientStore; flow: AppFlow; found: ReadonlyMap<number, readonly LocationFound[]>; searchedFor: string } = $props();
  const SEARCH_RESULT_WORDS = {
    header: "UI/Common/SearchResults",
    numResults: "UI/Search/UniversalSearch/WindowHeaderNumResults",
    overMax: "UI/Search/UniversalSearch/WindowHeaderOverMax",
    noResults: "UI/Search/UniversalSearch/NoResultsReturned",
    entryJumps: "UI/Fleet/FleetRegistry/NumberOfJumps",
    setDestination: "UI/Inflight/SetDestination",
    removeWaypoint: "UI/Inflight/RemoveWaypoint",
    addWaypoint: "UI/Inflight/AddWaypoint",
  } as const;
  /** The kinds in the order the client lists them (searchUtil.py RESULT_ORDER, 30 to 42), with its label for each. */
  const RESULT_ORDER: readonly { readonly resultType: number; readonly label: string; readonly own: string }[] = [
    { resultType: 8, label: "UI/Search/UniversalSearch/Regions", own: "Regions" },
    { resultType: 7, label: "UI/Search/UniversalSearch/SolarSystems", own: "Solar systems" },
    { resultType: 9, label: "UI/Common/LocationTypes/Stations", own: "Stations" },
    { resultType: 13, label: "UI/Common/LocationTypes/Structures", own: "Structures" },
    { resultType: 6, label: "UI/Search/UniversalSearch/Constellations", own: "Constellations" },
  ];
  /** search_const.max_result_count: at that many, the client says there are more. */
  const MAX_RESULT_COUNT = 500;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const waypoints = flow.waypoints;
  // svelte-ignore state_referenced_locally
  const routeSettingsKept = flow.routeSettings;
  $effect(() => { flow.requestWords([...Object.values(SEARCH_RESULT_WORDS), ...RESULT_ORDER.map((k) => k.label), ...Object.values(AVOID_WORDS)]); });
  const nameOf = (kind: NameRef["kind"], id: number): string => resolvedName($names.resolved, kind, id, "—");
  const word = (label: string, own: string): string => { const t = $words.templates[label]; return typeof t === "string" ? plainText(t) : own; };
  function countWord(label: string, args: Record<string, string | number>, own: string): string {
    const template = $words.templates[label];
    return typeof template === "string" ? plainText(formatTemplate(template, args, { nameOf: () => "" })) : own;
  }
  const total = $derived([...found.values()].reduce((sum, places) => sum + places.length, 0));
  /** Where the pilot is: the system the entries' jumps are counted from (session.solarsystemid2). */
  const from = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  $effect(() => {
    const systems = [...new Set([...found.values()].flat().map((place) => place.solarSystemID).filter((id): id is number => id !== null))];
    if (systems.length === 0) return;
    flow.requestSystemSecurity(systems);
    if (from !== null) flow.requestAutopilotJumps(from, systems);
  });
  function entryRating(place: LocationFound): { readonly text: string; readonly color: string } | null {
    if (place.solarSystemID === null) return null;
    const security = $names.systemSecurity[place.solarSystemID];
    return typeof security === "number" ? { text: shownSecurity(security).toFixed(1), color: securityStatusColor(security) } : null;
  }
  function entryJumps(place: LocationFound): string {
    if (place.solarSystemID === null || from === null) return "—";
    const jumps = $names.autopilotJumps[`${from}:${place.solarSystemID}`];
    return typeof jumps === "number" ? countWord(SEARCH_RESULT_WORDS.entryJumps, { numJumps: jumps }, `${jumps} jumps`) : "—";
  }
  function destinationOffered(place: LocationFound): boolean {
    if (place.resultType === 7 && place.id === from) return false;
    return $waypoints.at(-1) !== place.id;
  }
  const canBeWaypoint = (place: LocationFound): boolean => place.resultType === 7 || place.resultType === 9 || place.resultType === 13;
</script>

<h3>{word(SEARCH_RESULT_WORDS.header, "Search results")}</h3>
{#if total === 0}
  <p class="empty">{countWord(SEARCH_RESULT_WORDS.noResults, { searchStr: searchedFor }, `Nothing was found for “${searchedFor}”.`)}</p>
{:else}
  <p class="note">{total >= MAX_RESULT_COUNT
    ? countWord(SEARCH_RESULT_WORDS.overMax, { maxNumber: MAX_RESULT_COUNT, searchStr: searchedFor }, `More than ${MAX_RESULT_COUNT} found for “${searchedFor}”.`)
    : countWord(SEARCH_RESULT_WORDS.numResults, { numResults: total, searchStr: searchedFor }, `${total} found for “${searchedFor}”.`)}</p>
  {#each RESULT_ORDER as kind (kind.resultType)}
    {@const places = found.get(kind.resultType) ?? []}
    {#if places.length > 0}
      <h4>{word(kind.label, kind.own)}</h4>
      <ul class="search-found">
        {#each places as place (place.id)}
          {@const rating = kind.resultType === 7 || kind.resultType === 9 ? entryRating(place) : null}
          <li>
            {#if kind.resultType === 7 || kind.resultType === 9}
              {#if rating !== null}<span style:color={rating.color}>{rating.text}</span>{/if}
              {place.name} ({entryJumps(place)})
            {:else}
              {place.name}
            {/if}
            {#if canBeWaypoint(place)}
              {#if destinationOffered(place)}
                <button type="button" class="minor" onclick={() => flow.setDestination(place.id)}>{word(SEARCH_RESULT_WORDS.setDestination, "Head there")}</button>
              {/if}
              {#if $waypoints.includes(place.id)}
                <button type="button" class="minor" onclick={() => flow.clearWaypoints(place.id)}>{word(SEARCH_RESULT_WORDS.removeWaypoint, "Take off the route")}</button>
              {:else}
                <button type="button" class="minor" onclick={() => flow.addWaypoint(place.id)}>{word(SEARCH_RESULT_WORDS.addWaypoint, "Put on the route")}</button>
              {/if}
            {/if}
            {#if isAvoidablePlace(place.id)}
              {@const avoided = avoidanceItems($routeSettingsKept).includes(place.id)}
              <button type="button" class="minor" onclick={() => (avoided ? flow.stopAvoidingLocation(place.id) : flow.avoidLocation(place.id))}>{avoidEntryWords(avoided, place.id, $words.templates, nameOf)}</button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/each}
{/if}
