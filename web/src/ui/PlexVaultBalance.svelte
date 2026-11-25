<script lang="ts">
  import { onMount } from "svelte";
  import { publicGatewayRequest } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { flow }: { flow: AppFlow } = $props();
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

  onMount(() => { void refresh(); });
</script>

<div class="plex-vault">
  <img src={plexIcon} alt="" />
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
  button { margin-left: auto; }
  [role="alert"] { color: #fc9c95; }
</style>
