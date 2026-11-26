<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { PLEX_TYPE_ID, readPlexVaultBalance } from "../bridge/plexVault.ts";
  import { decodePlexWalletNotice, PLEX_WALLET_NOTICE } from "../bridge/plexWalletNotice.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { ContextMenu } from "../play/contextMenu.ts";
  import { showMarketDetails } from "./marketDetails.ts";
  import { showInfo } from "./showInfo.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { flow, store }: { flow: AppFlow; store: ClientStore } = $props();
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
  const plexIcon = clientTexture("res:/UI/Texture/Plex/plex_128_gradient_yellow.png");
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
    flow.requestWords([marketLabel, infoLabel, sellLabel, cannotSellLabel]);
    void refresh();
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
    return () => { stopNotices(); stopChanges(); };
  });

  function showPlexMenu(x: number, y: number) {
    itemMenu.open(x, y, [
      { label: word(infoLabel, "Show Info"), path: infoLabel, run: () => showInfo({ kind: "type", typeID: plexTypeID }) },
      { label: word(marketLabel, "View Market Details"), path: marketLabel, run: () => showMarketDetails(plexTypeID) },
    ]);
  }
</script>

<div class="plex-vault">
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
  <span title={balance !== null && balance < 100n ? word(cannotSellLabel, "PLEX Vault is empty") : null}>
    <button type="button" disabled={!docked || loading || (balance ?? 0n) < 100n}
      onclick={() => void flow.openVaultPlexSale().catch(cause => { error = String(cause?.message ?? cause); })}>{word(sellLabel, "Sell PLEX for ISK")}</button>
  </span>
</div>

<style>
  .plex-vault { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 14px; }
  img { width: 56px; height: 56px; }
  h2, p { margin: 0; }
  .plex-balance { margin-top: 4px; font-size: 1.2rem; }
  .plex-item { padding: 0; }
  [role="alert"] { color: #fc9c95; }
</style>
