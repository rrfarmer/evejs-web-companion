<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import ShipSkinrCollection from "./ShipSkinrCollection.svelte";
  import ShipSkinrStudio from "./ShipSkinrStudio.svelte";

  type Page = "studio" | "collection";
  type Guard = () => Promise<boolean>;
  let { store, flow, registerBeforeClose }: { store: ClientStore; flow: AppFlow;
    registerBeforeClose?: (guard: Guard) => () => void } = $props();
  let page = $state<Page>("studio");
  let guard: Guard | undefined;
  let changingPage = false;
  const words = $derived(store.words);
  const prefix = "UI/Personalization/ShipSkins/SKINR/";
  const tabs = [
    { page: "studio", path: prefix + "Studio/Title", fallback: "Studio" },
    { page: "collection", path: prefix + "Collection/Title", fallback: "Collection" },
  ] as const;
  $effect(() => { flow.requestWords(tabs.map(tab => tab.path)); });
  $effect(() => registerBeforeClose?.(() => guard?.() ?? Promise.resolve(true)));

  function registerGuard(next: Guard) {
    guard = next;
    return () => { if (guard === next) guard = undefined; };
  }

  async function choose(next: Page) {
    if (page === next || changingPage) return;
    changingPage = true;
    try {
      if (!guard || await guard()) page = next;
    } finally {
      changingPage = false;
    }
  }
</script>

<nav aria-label="Ship SKINR" class="skinr-pages">
  {#each tabs as tab (tab.page)}
    <button type="button" aria-pressed={page === tab.page} onclick={() => void choose(tab.page)}>
      {plainText($words.templates[tab.path] ?? tab.fallback)}
    </button>
  {/each}
</nav>
{#if page === "studio"}
  <ShipSkinrStudio {store} {flow} registerBeforeClose={registerGuard} />
{:else}
  <ShipSkinrCollection {store} {flow} />
{/if}

<style>
  .skinr-pages { display: flex; gap: 6px; padding: 10px 18px 0; }
  .skinr-pages button[aria-pressed="true"] { border-color: #94b8c2; }
</style>
