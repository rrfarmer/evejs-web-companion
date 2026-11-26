<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ShipSkinrCurrency } from "../bridge/shipSkinrMarket.ts";
  import type { ShipSkinrSequenceComponent } from "../bridge/shipSkinrSequencing.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  type Listing = { id: string; currency: ShipSkinrCurrency; amount: number; quantity: number; expires: number; branded?: boolean };
  let { store, flow, listing, name, tier = 0, component, onClose, onPurchased }: {
    store: ClientStore; flow: AppFlow; listing: Listing; name: string; tier?: number;
    component?: ShipSkinrSequenceComponent & { bundle: number; uses: number };
    onClose: () => void; onPurchased: (quantity: number, name: string, activated: boolean) => void;
  } = $props();
  const prefix = "UI/Personalization/ShipSkins/SKINR/";
  const labels = {
    title: [prefix + "Studio/BuySkin", "Buy SKIN"],
    element: [prefix + "Studio/BuyElement", "Buy Element"],
    activate: [prefix + "Store/ActivateNow", "Activate Now"],
    activateHint: [prefix + "Store/ActivateNowHint", "Add the licenses to Collection immediately."],
    buy: [prefix + "Store/Buy", "Buy"],
    funds: [prefix + "Studio/ListingErrors/InsufficientFunds", "Insufficient funds"],
    quantity: ["UI/Common/Quantity", "Quantity"],
    price: ["UI/Market/Marketbase/Price", "Price"],
    cancel: ["UI/Common/Buttons/Cancel", "Cancel"],
  } as const;
  const words = $derived(store.words);
  const station = $derived(store.station);
  const pilot = $derived($station.online?.characterID);
  const docked = $derived(!!($station.online?.stationID || $station.online?.structureID));
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  let dialog = $state<HTMLDialogElement>();
  let count = $state<number | undefined>(1);
  let activate = $state(true);
  let unlimitedOwned = $state(false);
  let quote = $state.raw<Awaited<ReturnType<AppFlow["loadShipSkinrPurchaseTerms"]>> | null>(null);
  let funds = $state.raw<Awaited<ReturnType<AppFlow["loadShipSkinrPurchaseFunds"]>> | null>(null);
  let now = $state(Date.now());
  let attempt = $state(0);
  let busy = $state(false);
  let loading = $state(true);
  let receipt = $state("");
  let error = $state("");
  let active = false;
  const expired = $derived(Number.isFinite(listing.expires) && listing.expires <= now);
  const unlimited = $derived(!!component && component.uses < 0);
  const duplicate = $derived(unlimited && activate && unlimitedOwned);
  const quantityLimit = $derived(unlimited && activate ? 1 : listing.quantity);
  const validCount = $derived(Number.isSafeInteger(count) && (count ?? 0) >= 1 && (count ?? 0) <= quantityLimit);
  const cost = $derived(Math.round(listing.amount * 100) * (count ?? 0) / 100);
  const fee = $derived((quote?.evermarks ?? 0) * (count ?? 0));
  const short = $derived(funds && validCount ? [
    ...(funds.balance < cost ? [listing.currency] : []),
    ...(funds.evermarks < fee ? ["EverMarks"] : []),
  ] : []);
  const ready = $derived(!!pilot && (!!component || !!quote) && !!funds && validCount && !short.length && !expired &&
    !duplicate && (!component || (activate ? !unlimited || component.bundle === 1 : docked)) &&
    Number.isSafeInteger(Math.round(listing.amount * 100) * (count ?? 0)) && Number.isSafeInteger(fee));
  const amount = (value: number) => `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${listing.currency}`;

  onMount(() => {
    active = true;
    dialog?.showModal();
    flow.requestWords(Object.values(labels).map(([path]) => path));
    const timer = window.setInterval(() => { now = Date.now(); }, 1000);
    return () => { active = false; clearInterval(timer); };
  });

  $effect(() => {
    const buyer = pilot;
    const currency = listing.currency;
    const level = tier;
    const branded = listing.branded ?? false;
    const element = component;
    void attempt;
    quote = null;
    funds = null;
    unlimitedOwned = false;
    loading = !!buyer;
    if (!buyer) return;
    let current = true;
    const termsRequest = element ? Promise.resolve(null) : flow.loadShipSkinrPurchaseTerms(level, branded);
    void termsRequest.then(async terms => {
      if (!current) return;
      const [balance, rights] = await Promise.all([
        flow.loadShipSkinrPurchaseFunds(currency, terms?.issuer),
        element && element.uses < 0 ? flow.loadShipSkinrComponentLicense(element) : null,
      ]);
      if (!current) return;
      quote = terms;
      funds = balance;
      unlimitedOwned = rights?.infinite ?? false;
    }).catch(cause => { if (current) error = panelErrorWords(cause); }).finally(() => {
      if (current) loading = false;
    });
    return () => { current = false; };
  });

  function reloadQuote() {
    error = "";
    attempt++;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const buyer = pilot;
    const quantity = count;
    const terms = quote;
    const element = component;
    const activateElement = activate;
    if (!buyer || !quantity || busy || (!receipt && (!ready || (!element && !terms)))) return;
    busy = true;
    error = "";
    const current = () => active && buyer === pilot;
    try {
      if (!receipt) {
        const id = element ? await flow.buyShipSkinrComponentOffer(listing.id, quantity, activateElement)
          : await flow.buyShipSkinrListing(listing.id, quantity, terms!.version);
        if (!current()) return;
        receipt = id;
      }
      const status = await flow.waitForShipSkinrListing(receipt);
      if (!current()) return;
      if (status === "completed") {
        if (listing.currency === "ISK") void flow.loadWallet({ fresh: true }).catch(() => {});
        if (element && !activateElement) void flow.loadInventory().catch(() => {});
        onPurchased(quantity, name, activateElement);
      } else if (status === "failed") {
        receipt = "";
        attempt++;
        error = "The purchase could not be completed.";
      } else {
        error = "The purchase is still pending.";
      }
    } catch (cause) {
      if (current()) error = panelErrorWords(cause);
    } finally {
      if (current()) busy = false;
    }
  }

  function cancel(event: Event) {
    event.preventDefault();
    if (!busy) onClose();
  }
</script>

<dialog class="skinr-buy" bind:this={dialog} aria-label={word(component ? "element" : "title")} oncancel={cancel}>
  <form onsubmit={submit}>
    <h3>{word(component ? "element" : "title")}</h3>
    <strong>{name}</strong>
    {#if component}<p>{component.bundle.toLocaleString()} per bundle</p>{/if}
    <label>{word("quantity")}
      <input type="number" min="1" max={quantityLimit} step="1" bind:value={count} disabled={busy || !!receipt} required />
    </label>
    <dl>
      <dt>{word("price")}</dt><dd>{amount(listing.amount)}</dd>
      <dt>Total</dt><dd data-purchase-total>{validCount ? amount(cost) : "—"}</dd>
      {#if quote && quote.evermarks > 0}
        <dt>Buyer fee</dt><dd data-purchase-fee>{validCount ? `${fee.toLocaleString()} EverMarks` : "—"}</dd>
      {/if}
    </dl>
    {#if component}
      <label class="activate" title={word("activateHint")}>
        <input type="checkbox" bind:checked={activate} disabled={busy || !!receipt} /> {word("activate")}
      </label>
      {#if !activate && docked}<p>Items will be delivered to your item hangar here.</p>{/if}
      {#if !activate && !docked}<p role="status">Dock to receive items in your hangar.</p>{/if}
      {#if duplicate}<p role="status">This unlimited license is already in Collection.</p>{/if}
      {#if unlimited && activate && component.bundle !== 1}<p role="status">Receive this bundle in your item hangar to activate an unlimited license.</p>{/if}
    {/if}
    {#if loading}<p>Loading purchase terms…</p>{/if}
    {#if expired && !receipt}<p role="status">This listing has expired.</p>{/if}
    {#if short.length}<p role="status">{word("funds")} ({short.join("/")})</p>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
    <footer>
      <button type="button" disabled={busy} onclick={cancel}>{word("cancel")}</button>
      {#if error && !receipt}<button type="button" disabled={busy || loading} onclick={reloadQuote}>Refresh Quote</button>{/if}
      <button type="submit" disabled={busy || (!receipt && !ready)}>
        {busy ? "Processing…" : receipt ? "Check Purchase" : word("buy")}
      </button>
    </footer>
  </form>
</dialog>

<style>
  .skinr-buy { position: fixed; inset: 0; margin: auto; width: min(23rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem); overflow: auto; padding: 16px; color: var(--color-text);
    background: var(--color-bg, #0b1119); border: 1px solid var(--color-accent); }
  .skinr-buy::backdrop { background: #0009; }
  form { display: grid; gap: 10px; }
  h3, dl, dd, p { margin: 0; }
  label, footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  input[type="number"] { width: 7em; }
  .activate { justify-content: flex-start; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 6px; }
  dd { text-align: end; }
  footer { justify-content: flex-end; flex-wrap: wrap; }
</style>
