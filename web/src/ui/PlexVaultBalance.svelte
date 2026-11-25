<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { publicGatewayRequest } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { ContextMenu } from "../play/contextMenu.ts";
  import { showMarketDetails } from "./marketDetails.ts";
  import { showInfo } from "./showInfo.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { flow, store }: { flow: AppFlow; store: ClientStore } = $props();
  const words = $derived(store.words);
  const plexTypeID = 44992;
  const marketLabel = "UI/Inventory/ItemActions/ViewTypesMarketDetails";
  const infoLabel = "UI/Commands/ShowInfo";
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? "").trim() || fallback;
  const itemMenu = new ContextMenu();
  onDestroy(() => itemMenu.close());
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
    if (loading) return;
    loading = true;
    error = "";
    try {
      const answer = await publicGatewayRequest("eve_public.plex.vault.api.BalanceRequest", {}, flow.requestOptions());
      const payload = answer.payload;
      if (answer.statusCode !== 200 || !payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("The PLEX balance is unavailable.");
      }
      const currency = payload.balance;
      if (!currency || typeof currency !== "object" || Array.isArray(currency)) throw new Error("The PLEX balance is unavailable.");
      // Protobuf omits the scalar when the balance is zero.
      balance = BigInt(String(currency.total_in_cents ?? "0"));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    flow.requestWords([marketLabel, infoLabel]);
    void refresh();
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
</div>

<style>
  .plex-vault { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 14px; }
  img { width: 56px; height: 56px; }
  h2, p { margin: 0; }
  .plex-balance { margin-top: 4px; font-size: 1.2rem; }
  .plex-item { padding: 0; }
  .plex-vault > button:last-child { margin-left: auto; }
  [role="alert"] { color: #fc9c95; }
</style>
