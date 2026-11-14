<script lang="ts">
  // The search results window searchUtil.GetResultsInNewWindow opens (searchWndName 'addressBookSearch'), from the route
  // info panel's search box (infoPanelRoute.SearchForLocation: solar systems, constellations, regions, stations and
  // structures with inlined data): its own search line on top (the text asked for, searched again on Return or the
  // button), then the results (LocationSearchResults.svelte). Asked again while open, it searches the new text.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, LocationFound } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import LocationSearchResults from "./LocationSearchResults.svelte";
  import { locationSearchRequests, serveLocationSearchRequest } from "./locationSearchRequests.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const M = "UI/Map/MapPallet/";
  $effect(() => { flow.requestWords([M + "lblSearchForLocation", M + "btnSearchForLocation"]); });
  const word = (label: string, own: string) => { const t = $words.templates[label]; return typeof t === "string" ? plainText(t) : own; };
  let text = $state(""), found = $state.raw<ReadonlyMap<number, readonly LocationFound[]> | null>(null), searchedFor = $state(""), busy = $state(false);
  async function search(): Promise<void> {
    const query = text;
    if (!query.trim()) return;
    busy = true;
    try {
      const result = await flow.searchLocations(query);
      if (result !== null) { found = result; searchedFor = query.replace(/\*/g, "").trim(); }
    } finally { busy = false; }
  }
  $effect(() => {
    const r = $locationSearchRequests;
    if (!r) return;
    serveLocationSearchRequest(r.n);
    text = r.text;
    void search();
  });
</script>

<div class="ls">
  <div class="ls-top">
    <input type="search" maxlength="64" placeholder={word(M + "lblSearchForLocation", "Search for location")} bind:value={text}
      onkeydown={(e) => { if (e.key === "Enter") void search(); }} />
    <button type="button" disabled={busy || !text.trim()} onclick={() => void search()}>{word(M + "btnSearchForLocation", "Search")}</button>
  </div>
  {#if found !== null}<LocationSearchResults {store} {flow} {found} {searchedFor} />{/if}
</div>

<style>
  .ls { padding: 8px; overflow: auto; height: 100%; box-sizing: border-box; }
  .ls-top { display: flex; gap: 4px; }
  .ls-top input { width: 220px; }
</style>
