<script module lang="ts">
  export type PlexVaultStoreActions = {
    omega?: () => void;
    training?: () => void;
    store?: () => void;
    buy?: () => void;
  };
</script>

<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { bridgeAsk } from "../app/api.ts";
  import { decodeStoreOffers, IN_GAME_STORE_ID } from "../bridge/newEdenStore.ts";
  import { PLEX_TYPE_ID, readPlexVaultBalance } from "../bridge/plexVault.ts";
  import { decodePlexWalletNotice, PLEX_WALLET_NOTICE } from "../bridge/plexWalletNotice.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { ContextMenu } from "../play/contextMenu.ts";
  import { showMarketDetails } from "./marketDetails.ts";
  import { showInfo } from "./showInfo.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { flow, store, storeActions }: { flow: AppFlow; store: ClientStore; storeActions?: PlexVaultStoreActions } = $props();
  const words = $derived(store.words);
  const plexTypeID = PLEX_TYPE_ID;
  const sellLabel = "UI/PlexVault/SellPlexForIsk";
  const cannotSellLabel = "UI/PlexVault/SellPlexForIskDisabledTooltipDescription";
  const flight = $derived(store.flight);
  const station = $derived(store.station);
  const docked = $derived($flight.status?.docked ?? Boolean($station.online?.stationID ?? $station.online?.structureID));
  const marketLabel = "UI/Inventory/ItemActions/ViewTypesMarketDetails";
  const infoLabel = "UI/Commands/ShowInfo";
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? "").trim() || fallback;
  const itemMenu = new ContextMenu();
  let balanceRequest = 0;
  onDestroy(() => { balanceRequest++; itemMenu.close(); });
  let balance = $state<bigint | null>(null);
  let loading = $state(false);
  let error = $state("");
  let trainingPrice = $state<number | null>(null);
  const plexIcon = clientTexture("res:/UI/Texture/Plex/plex_128_gradient_yellow.png");
  const cards = $derived([
    { id: "sell", label: sellLabel, fallback: "Sell PLEX for ISK", icon: "res:/UI/Texture/classes/PlexVault/BuyISKforPLEX.png", run: sell },
    { id: "omega", label: "UI/PlexVault/AddOmegaTime", fallback: "Add Omega game time", icon: "res:/UI/Texture/classes/PlexVault/UpgradeOmega.png", run: storeActions?.omega },
    { id: "training", label: "UI/PlexVault/BuyMultipleTraining", fallback: "Buy extra skill queue", icon: "res:/UI/Texture/Icons/multiple_training.png", run: storeActions?.training },
    { id: "store", label: "UI/PlexVault/OpenNewEdenStore", fallback: "Shop in the New Eden Store", icon: "res:/UI/Texture/WindowIcons/NES.png", run: storeActions?.store },
    { id: "buy", label: "UI/PlexVault/BuyPlexForMoney", fallback: "Buy PLEX", icon: "res:/UI/Texture/Plex/plex_128_gradient_yellow.png", run: storeActions?.buy },
  ]);
  const amount = $derived.by(() => {
    if (balance === null) return "";
    const whole = (balance / 100n).toLocaleString("en-US");
    const cents = balance % 100n;
    return cents ? `${whole}.${cents.toString().padStart(2, "0")}` : whole;
  });

  async function refresh() {
    const request = ++balanceRequest;
    loading = true;
    error = "";
    try {
      const latest = await readPlexVaultBalance(flow.requestOptions());
      if (request === balanceRequest) balance = latest;
    } catch (cause) {
      if (request === balanceRequest) error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (request === balanceRequest) loading = false;
    }
  }

  onMount(() => {
    flow.requestWords([marketLabel, infoLabel, cannotSellLabel, ...cards.map(card => card.label)]);
    void refresh();
    let mounted = true;
    if (storeActions?.training) {
      // The card quotes the tradeable training certificate. Its click opens the soulbound certificate offers.
      const marketTrainingToken = 34133;
      void bridgeAsk(flow.requestOptions())("storeManager", "get_offers", [IN_GAME_STORE_ID]).then(answer => {
        const prices = decodeStoreOffers(answer).filter(offer => offer.productTypes.includes(marketTrainingToken))
          .map(offer => offer.plexPrice).filter(price => price !== null);
        if (mounted && prices.length) trainingPrice = Math.min(...prices);
      }).catch(() => {});
    }
    const notices = flow.gatewayNotices;
    let previous = notices.get();
    const stopNotices = notices.subscribe(notice => {
      if (notice === previous) return;
      previous = notice;
      if (notice?.typeName === PLEX_WALLET_NOTICE && decodePlexWalletNotice(notice.payload)) void refresh();
    });
    const changes = flow.plexVaultChanged;
    let lastChange = changes.get();
    const stopChanges = changes.subscribe(change => {
      if (change === lastChange) return;
      lastChange = change;
      void refresh();
    });
    return () => { mounted = false; stopNotices(); stopChanges(); };
  });

  function sell() {
    error = "";
    void flow.openVaultPlexSale().catch(cause => { error = cause instanceof Error ? cause.message : String(cause); });
  }

  function showPlexMenu(x: number, y: number) {
    itemMenu.open(x, y, [
      { label: word(infoLabel, "Show Info"), path: infoLabel, run: () => showInfo({ kind: "type", typeID: plexTypeID }) },
      { label: word(marketLabel, "View Market Details"), path: marketLabel, run: () => showMarketDetails(plexTypeID) },
    ]);
  }
</script>

<div class="plex-vault">
  <div class="plex-vault-balance">
    <button type="button" class="plex-item" aria-label="PLEX actions" aria-haspopup="menu"
      onclick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        showPlexMenu(bounds.left, bounds.bottom);
      }}
      oncontextmenu={(event) => {
        event.preventDefault();
        showPlexMenu(event.clientX, event.clientY);
      }}><img src={plexIcon} alt="" /></button>
    <div>
      <h2>PLEX Vault</h2>
      {#if amount}<p role="status" class="plex-balance">{amount} PLEX</p>
      {:else if loading}<p role="status">Loading PLEX balance…</p>{/if}
      {#if error}<p role="alert">{error}</p>{/if}
    </div>
    <button type="button" disabled={loading} onclick={() => void refresh()}>Refresh balance</button>
  </div>
  <div class="plex-actions" role="group" aria-label="PLEX Vault actions">
    {#each cards as card (card.id)}
      {#if card.run}
        <span title={card.id === "sell" && balance !== null && balance < 100n ? word(cannotSellLabel, "PLEX Vault is empty") : null}>
          <button class="plex-action" class:plex-checkout={card.id === "buy"} type="button" data-vault-action={card.id}
            disabled={card.id === "sell" && (!docked || loading || (balance ?? 0n) < 100n)} onclick={card.run}>
            <img src={clientTexture(card.icon)} alt="" />
            <span>{word(card.label, card.fallback)}</span>
            {#if card.id === "training" && trainingPrice !== null}<small>{trainingPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })} PLEX</small>{/if}
          </button>
        </span>
      {/if}
    {/each}
  </div>
</div>

<style>
  .plex-vault { padding: 14px; }
  .plex-vault-balance { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
  .plex-item img { width: 56px; height: 56px; }
  h2, p { margin: 0; }
  .plex-balance { margin-top: 4px; font-size: 1.2rem; }
  .plex-item { padding: 0; }
  .plex-actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(8rem, 100%), 1fr)); gap: 8px; margin-top: 16px; }
  .plex-action { width: 100%; height: 100%; display: grid; place-content: center; justify-items: center; gap: 6px; min-height: 86px; padding: 8px; text-align: center; }
  .plex-action img { width: 32px; height: 32px; object-fit: contain; }
  .plex-action small { color: #fab400; }
  .plex-checkout { border-color: #fab40088; }
  [role="alert"] { color: #fc9c95; }
</style>
