<script lang="ts">
  // The search results window searchUtil.GetResultsInNewWindow opens (searchWndName 'addressBookSearch'), from the route
  // info panel's search box (infoPanelRoute.SearchForLocation: solar systems, constellations, regions, stations and
  // structures with inlined data): its own search line on top (the text asked for, searched again on Return or the
  // button), then the results (LocationSearchResults.svelte). Asked again while open, it searches the new text.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { onDestroy } from "svelte";
  import { plainText } from "../bridge/clientWords.ts";
  import LocationSearchResults from "./LocationSearchResults.svelte";
  import { createLocationSearch, locationSearchRequests, serveLocationSearchRequest } from "./locationSearchRequests.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const M = "UI/Map/MapPallet/";
  $effect(() => { flow.requestWords([M + "lblSearchForLocation", M + "btnSearchForLocation"]); });
  const word = (label: string, own: string) => { const t = $words.templates[label]; return typeof t === "string" ? plainText(t) : own; };
  let text = $state("");
  const search = createLocationSearch((query) => flow.searchLocations(query));
  const searchState = search.state;
  const pilot = $derived($station.online?.characterID ?? null);
  $effect(() => {
    void pilot;
    text = "";
    search.reset();
  });
  onDestroy(search.reset);
  $effect(() => {
    const r = $locationSearchRequests;
    if (!r) return;
    serveLocationSearchRequest(r.n);
    text = r.text;
    void search.run(r.text);
  });
</script>

<div class="ls">
  <div class="ls-top">
    <input type="search" maxlength="64" placeholder={word(M + "lblSearchForLocation", "Search for location")} bind:value={text}
      onkeydown={(e) => { if (e.key === "Enter") void search.run(text); }} />
    <button type="button" disabled={!text.trim()} onclick={() => void search.run(text)}>{word(M + "btnSearchForLocation", "Search")}</button>
  </div>
  {#if $searchState.busy}<p class="note" role="status">…</p>{/if}
  {#if $searchState.error}<p class="error" role="alert">{$searchState.error}</p>{/if}
  {#if $searchState.result}<LocationSearchResults {store} {flow} found={$searchState.result.found} searchedFor={$searchState.result.query} />{/if}
</div>

<style>
  .ls { padding: 8px; overflow: auto; height: 100%; box-sizing: border-box; }
  .ls-top { display: flex; gap: 4px; }
  .ls-top input { width: 220px; }
</style>
