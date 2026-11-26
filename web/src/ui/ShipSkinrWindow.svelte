<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import ShipSkinrCollection from "./ShipSkinrCollection.svelte";
  import ShipSkinrElementStore from "./ShipSkinrElementStore.svelte";
  import ShipSkinrStore from "./ShipSkinrStore.svelte";
  import ShipSkinrStudio from "./ShipSkinrStudio.svelte";

  type Page = "studio" | "collection" | "store";
  type Guard = () => Promise<boolean>;
  let { store, flow, registerBeforeClose }: { store: ClientStore; flow: AppFlow;
    registerBeforeClose?: (guard: Guard) => () => void } = $props();
  let page = $state<Page>("studio");
  let storePage = $state<"skins" | "elements">("skins");
  let linked = $state.raw<ReturnType<AppFlow["takeShipSkinrListingLink"]>>(null);
  let linkedDesign = $state.raw<ReturnType<AppFlow["takeShipSkinrDesignLink"]>>(null);
  let guard: Guard | undefined;
  let changingPage = false;
  const words = $derived(store.words);
  const prefix = "UI/Personalization/ShipSkins/SKINR/";
  const tabs = [
    { page: "studio", path: prefix + "Studio/Title", fallback: "Studio" },
    { page: "collection", path: prefix + "Collection/Title", fallback: "Collection" },
    { page: "store", path: prefix + "Store/Title", fallback: "Paragon Hub" },
  ] as const;
  const storeTabs = [
    { page: "skins", path: prefix + "Studio/SKINs", fallback: "SKINs" },
    { page: "elements", path: prefix + "Studio/DesignElements", fallback: "Design Elements" },
  ] as const;
  $effect(() => { flow.requestWords([...tabs, ...storeTabs].map(tab => tab.path)); });
  $effect(() => registerBeforeClose?.(() => guard?.() ?? Promise.resolve(true)));
  $effect(() => flow.shipSkinrListingLink.subscribe(request => {
    if (!request) return;
    const listing = flow.takeShipSkinrListingLink();
    if (!listing) return;
    void choose("store").then(accepted => {
      if (accepted) {
        storePage = "skins";
        linked = listing;
      }
    }).catch(() => {});
  }));
  $effect(() => flow.shipSkinrDesignLink.subscribe(request => {
    if (!request) return;
    const design = flow.takeShipSkinrDesignLink();
    if (!design) return;
    void choose("studio", true).then(accepted => { if (accepted) linkedDesign = design; }).catch(() => {});
  }));

  function registerGuard(next: Guard) {
    guard = next;
    return () => { if (guard === next) guard = undefined; };
  }

  async function choose(next: Page, replace = false) {
    if (changingPage) return false;
    if (page === next && !replace) return true;
    changingPage = true;
    try {
      if (guard && !await guard()) return false;
      page = next;
      linked = null;
      linkedDesign = null;
      return true;
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
  {#key linkedDesign}
    <ShipSkinrStudio {store} {flow} {linkedDesign} registerBeforeClose={registerGuard} />
  {/key}
{:else if page === "collection"}
  <ShipSkinrCollection {store} {flow} />
{:else}
  <nav aria-label="Paragon Hub catalogues" class="skinr-pages">
    {#each storeTabs as tab (tab.page)}
      <button type="button" aria-pressed={storePage === tab.page} onclick={() => {
        storePage = tab.page;
        if (tab.page === "elements") linked = null;
      }}>
        {plainText($words.templates[tab.path] ?? tab.fallback)}
      </button>
    {/each}
  </nav>
  {#if storePage === "skins"}
    {#key linked}
      <ShipSkinrStore {store} {flow} {linked} />
    {/key}
  {:else}
    <ShipSkinrElementStore {store} {flow} />
  {/if}
{/if}

<style>
  .skinr-pages { display: flex; gap: 6px; padding: 10px 18px 0; }
  .skinr-pages button[aria-pressed="true"] { border-color: #94b8c2; }
</style>
