<script lang="ts">
  import { untrack } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { SHIP_SKINR_GATEWAY } from "../bridge/shipSkinr.ts";
  import { shipSkinrRecord } from "../bridge/shipSkinrCoatings.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import ShipSkinrCollection from "./ShipSkinrCollection.svelte";
  import ShipSkinrElementStore from "./ShipSkinrElementStore.svelte";
  import ShipSkinrStore from "./ShipSkinrStore.svelte";
  import ShipSkinrStudio from "./ShipSkinrStudio.svelte";

  type Page = "studio" | "collection" | "store";
  type Guard = () => Promise<boolean>;
  let { store, flow, registerBeforeClose, paragonHubRequest, onParagonHubRequestTaken }: { store: ClientStore; flow: AppFlow;
    registerBeforeClose?: (guard: Guard) => () => void;
    paragonHubRequest?: { shipTypeID: number } | null;
    onParagonHubRequestTaken?: () => void } = $props();
  let page = $state<Page>("studio");
  let storePage = $state<"skins" | "elements">("skins");
  let linked = $state.raw<ReturnType<AppFlow["takeShipSkinrListingLink"]>>(null);
  let linkedDesign = $state.raw<ReturnType<AppFlow["takeShipSkinrDesignLink"]>>(null);
  let hubLanding = $state.raw<{ shipTypeID: number } | null>(null);
  let sequenceFailure = $state<keyof typeof failureWords | null>(null);
  let guard: Guard | undefined;
  let changingPage = $state(false);
  const words = $derived(store.words);
  const station = $derived(store.station);
  const pilot = $derived($station.online?.characterID);
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
  const errorPrefix = prefix + "Studio/SequencingErrors/";
  const failureWords = {
    internal: [errorPrefix + "InternalError", "The sequencing job could not be started."],
    funds: [errorPrefix + "InsufficientPLEXFunds", "There is not enough PLEX to start sequencing."],
    resources: [errorPrefix + "InsufficientSequenceBinders", "There are not enough sequence binders."],
  } as const;
  const closeLabel = "UI/Common/Buttons/Close";
  $effect(() => {
    flow.requestWords([...tabs.map(tab => tab.path), ...storeTabs.map(tab => tab.path),
      ...Object.values(failureWords).map(([path]) => path), closeLabel]);
  });
  $effect(() => {
    const owner = pilot;
    sequenceFailure = null;
    if (!owner) return;
    const notices = flow.gatewayNotices;
    let previous = notices.get();
    return notices.subscribe(notice => {
      if (notice === previous) return;
      previous = notice;
      if (pilot !== owner || notice?.typeName !== SHIP_SKINR_GATEWAY + "sequencing.job.api.FailedNotice") return;
      const payload = shipSkinrRecord(notice.payload);
      if (!payload) return;
      switch (payload.reason) {
        case 1: case "FAILURE_MISSING_FUNDS": sequenceFailure = "funds"; break;
        case 3: case "FAILURE_MISSING_RESOURCES": sequenceFailure = "resources"; break;
        case undefined: case 0: case "FAILURE_UNSPECIFIED":
        case 4: case "FAILURE_INTERNAL_SERVER_ERROR": sequenceFailure = "internal"; break;
      }
    });
  });
  $effect(() => registerBeforeClose?.(() => guard?.() ?? Promise.resolve(true)));
  $effect(() => {
    const request = paragonHubRequest;
    if (!request || changingPage) return;
    untrack(() => {
      onParagonHubRequestTaken?.();
      void choose("store", false, () => {
        storePage = "skins";
        linked = null;
        hubLanding = request;
      }).catch(() => {});
    });
  });
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

  async function choose(next: Page, replace = false, onAccepted?: () => void) {
    if (changingPage) return false;
    if (page === next && !replace) {
      onAccepted?.();
      return true;
    }
    changingPage = true;
    try {
      if (guard && !await guard()) return false;
      page = next;
      linked = null;
      linkedDesign = null;
      onAccepted?.();
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
{#if sequenceFailure}
  {@const [path, fallback] = failureWords[sequenceFailure]}
  <div class="sequence-failure">
    <p role="alert">{plainText($words.templates[path] ?? fallback)}</p>
    <button type="button" onclick={() => sequenceFailure = null}>{plainText($words.templates[closeLabel] ?? "Close")}</button>
  </div>
{/if}
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
    {#key linked ?? hubLanding}
      <ShipSkinrStore {store} {flow} {linked} requestedHull={hubLanding?.shipTypeID} />
    {/key}
  {:else}
    <ShipSkinrElementStore {store} {flow} />
  {/if}
{/if}

<style>
  .skinr-pages { display: flex; gap: 6px; padding: 10px 18px 0; }
  .skinr-pages button[aria-pressed="true"] { border-color: #94b8c2; }
  .sequence-failure { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 10px 18px 0; padding: 8px; background: #a43b3826; }
  .sequence-failure p { margin: 0; }
</style>
