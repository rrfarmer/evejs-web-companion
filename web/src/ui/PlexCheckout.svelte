<script lang="ts">
  import { onMount } from "svelte";
  import { bridgeAsk, getGlobalConfig } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { isListValue, readDictEntry, readKeyVal } from "../bridge/wire.ts";

  let { flow, onShowStore }: { flow: AppFlow; onShowStore?: () => void } = $props();
  type Offer = { id: number; name: string; quantity: number; price: number; currency: string };
  let offers = $state<Offer[] | null>(null);
  let loading = $state(true);
  let error = $state("");
  let mounted = false;

  async function load() {
    loading = true;
    error = "";
    try {
      const options = flow.requestOptions();
      const read = bridgeAsk(options);
      const funnel = "fake_china_funnel_enabled";
      const [config, enabled] = await Promise.all([
        getGlobalConfig([funnel], options).catch(() => null),
        read("FastCheckoutService", "IsFastCheckoutEnabledForUser", []),
      ]);
      if (!mounted) return;
      if (enabled === false || enabled === 0 || String(config?.values[funnel]) === "1") {
        offers = [];
        onShowStore?.();
        return;
      }
      const raw = readDictEntry(await read("FastCheckoutService", "GetOffersForUser", []), "plex");
      if (!isListValue(raw)) throw new Error("The PLEX offer list is unavailable.");
      offers = raw.items.flatMap(row => {
        const id = Number(readKeyVal(row, "id"));
        const quantity = Number(readKeyVal(row, "quantity"));
        const price = Number(readKeyVal(row, "price"));
        const currency = readKeyVal(row, "currency");
        const name = readKeyVal(row, "name");
        if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0 ||
            !Number.isFinite(price) || price < 0 || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return [];
        return [{ id, quantity, price, currency, name: typeof name === "string" ? plainText(name).trim() : "" }];
      }).sort((left, right) => left.quantity - right.quantity || left.id - right.id);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The PLEX offer list is unavailable.";
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    mounted = true;
    void load();
    return () => { mounted = false; };
  });
</script>

<div class="plex-checkout">
  {#if loading}<p role="status">Loading PLEX offers…</p>{/if}
  {#if error}
    <p role="alert">{error}</p>
    <button type="button" onclick={() => void load()}>Retry</button>
  {/if}
  {#if !loading && !error && offers?.length === 0}<p role="status">This server has no PLEX checkout offers.</p>{/if}
  {#if offers?.length}
    <ul aria-label="PLEX offers">
      {#each offers as offer (offer.id)}
        <li data-offer-id={offer.id} data-quantity={offer.quantity}>
          <h2>{offer.name || `${offer.quantity.toLocaleString()} PLEX`}</h2>
          <span>{offer.price.toLocaleString(undefined, { style: "currency", currency: offer.currency })}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .plex-checkout { padding: 14px; }
  ul { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); gap: 8px; }
  li { border: 1px solid var(--line, #39444b); padding: 12px; }
  h2 { font-size: 1rem; margin: 0 0 8px; }
  [role="alert"] { color: #fc9c95; }
</style>
