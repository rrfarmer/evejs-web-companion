<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { StationLpOffer, StationLpStore } from "../bridge/stationLpStore.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import TypeIcon from "./TypeIcon.svelte";
  import ConcordLpExchange from "./ConcordLpExchange.svelte";
  import { plainText } from "../bridge/clientWords.ts";
  import { CONCORD_LP_ISSUER } from "../bridge/concordLp.ts";

  let { store, flow, stationID, issuerID }: {
    store: ClientStore;
    flow: AppFlow;
    stationID: number;
    issuerID: number;
  } = $props();
  const names = $derived(store.names);
  const words = $derived(store.words);
  const EXCHANGE_LABEL = "UI/LPStore/ConcordExchange";
  const name = (id: number) => resolvedName($names.resolved, "type", id, "Unknown item");
  const isk = (value: number) => value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ISK";
  let data = $state.raw<StationLpStore | null>(null);
  let picked = $state<number | null>(null);
  let query = $state("");
  let affordableOnly = $state(false);
  let quantity = $state<number | undefined>(1);
  let review = $state<{ offer: StationLpOffer; count: number } | null>(null);
  let busy = $state(false);
  let error = $state("");
  let status = $state("");
  let exchange = $state(false);
  let rate = $state(0);
  const lp = $derived(BigInt(data?.lp ?? "0"));
  const selected = $derived(data?.offers.find(offer => offer.id === picked));
  const matches = $derived((data?.offers ?? []).filter(offer =>
    name(offer.reward.typeID).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) &&
    (!affordableOnly || canAffordCurrency(offer, 1))));

  function canAffordCurrency(offer: StationLpOffer, count: number): boolean {
    return offer.ak === 0 && BigInt(offer.lp) * BigInt(count) <= lp &&
      (offer.isk === 0 || (data?.isk != null && offer.isk * count <= data.isk));
  }

  const count = $derived(quantity ?? 0);
  const valid = $derived(!!selected && Number.isSafeInteger(count) && count >= 1 && count <= 100 && canAffordCurrency(selected, count));

  async function run(task: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    error = "";
    status = "";
    try { await task(); }
    catch (cause) { error = panelErrorWords(cause); }
    finally { busy = false; }
  }

  function refresh(): Promise<void> {
    return run(async () => {
      review = null;
      data = await flow.loadStationLpStore(stationID, issuerID);
      rate = data.concordLp > 0 ? (await flow.concordLpExchangeRates()).get(issuerID) ?? 0 : 0;
    });
  }

  function pick(id: number): void {
    picked = id;
    quantity = 1;
    review = null;
    status = "";
  }

  function buy(): void {
    const terms = review;
    if (!terms || busy) return;
    review = null;
    void run(async () => {
      await flow.buyStationLpOffer(stationID, issuerID, terms.offer, terms.count);
      status = "Offer accepted. Check your item hangar.";
      data = null;
      data = await flow.loadStationLpStore(stationID, issuerID);
    });
  }

  onMount(() => {
    flow.requestWords([EXCHANGE_LABEL]);
    void refresh();
    const changed = flow.walletLpChanged;
    let previous = changed.get();
    return changed.subscribe(value => {
      if (value === previous) return;
      previous = value;
      if (value && !exchange && (value.issuerID === issuerID || value.issuerID === CONCORD_LP_ISSUER)) void refresh();
    });
  });
</script>

<div class="lp-store" data-window="lpstore" aria-busy={busy}>
  <header class="store-head">
    <strong>{resolvedName($names.resolved, "corporation", issuerID, "Station store")}</strong>
    <span>{data ? lp.toLocaleString() + " LP" : "Reading balance…"}</span>
    {#if data?.isk != null}<span>{isk(data.isk)}</span>{/if}
    {#if data && data.concordLp * rate > 1}
      <button type="button" class="station-concord-exchange" disabled={busy} onclick={() => (exchange = true)}>
        {plainText($words.templates[EXCHANGE_LABEL] ?? "") || "CONCORD Exchange"}
      </button>
    {/if}
    <button type="button" disabled={busy} onclick={refresh}>Refresh</button>
  </header>
  <div class="store-filters">
    <input type="search" aria-label="Filter offers" placeholder="Filter offers" bind:value={query} />
    <label><input type="checkbox" bind:checked={affordableOnly} /> Affordable in LP and ISK</label>
  </div>
  <div class="offer-list">
    <table>
      <thead><tr><th>Reward</th><th>LP</th><th>ISK</th></tr></thead>
      <tbody>
        {#each matches as offer (offer.id)}
          <tr data-offer-id={offer.id}>
            <td><button type="button" disabled={busy} aria-pressed={picked === offer.id} onclick={() => pick(offer.id)}>
              {offer.reward.quantity.toLocaleString()} × {name(offer.reward.typeID)}
            </button></td>
            <td>{offer.lp.toLocaleString()}</td><td>{isk(offer.isk)}</td>
          </tr>
        {:else}
          {#if data}<tr><td colspan="3">No offers match.</td></tr>{/if}
        {/each}
      </tbody>
    </table>
  </div>
  {#if error || status}<p role="status">{status}{status && error ? " " : ""}{error}</p>{/if}
  {#if review}
    <div class="offer-summary">
      <strong>Accept {review.count.toLocaleString()} × {name(review.offer.reward.typeID)} offer?</strong>
      <span>{(review.offer.lp * review.count).toLocaleString()} LP · {isk(review.offer.isk * review.count)}</span>
      {#each review.offer.requires as item, i (i)}
        <span>Give {(item.quantity * review.count).toLocaleString()} × {name(item.typeID)}</span>
      {/each}
      <div><button type="button" onclick={buy}>Confirm</button> <button type="button" onclick={() => (review = null)}>Cancel</button></div>
    </div>
  {:else if selected}
    <div class="offer-summary">
      <strong><TypeIcon typeID={selected.reward.typeID} name={name(selected.reward.typeID)} size="sm" /> {selected.reward.quantity.toLocaleString()} × {name(selected.reward.typeID)}</strong>
      {#each selected.otherRewards as item, i (i)}<span>Also includes {item.quantity.toLocaleString()} × {name(item.typeID)}</span>{/each}
      {#each selected.requires as item, i (i)}<span>Requires {item.quantity.toLocaleString()} × {name(item.typeID)}</span>{/each}
      {#if selected.ak > 0}<span>Requires {selected.ak.toLocaleString()} Analysis Kredits.</span>{/if}
      {#if selected.standing !== null}<span>Standing requirement applies.</span>{/if}
      <div>
        <label>Offers <input type="number" min="1" max="100" step="1" bind:value={quantity} disabled={busy} /></label>
        <button type="button" disabled={busy || !valid} onclick={() => (review = { offer: selected!, count })}>Review Offer</button>
      </div>
    </div>
  {/if}
</div>
{#if exchange && data && rate > 0}
  <ConcordLpExchange {store} {flow} {stationID} {issuerID} {rate} source={data.concordLp} target={Number(data.lp)}
    close={() => (exchange = false)} exchanged={() => void refresh()} />
{/if}

<style>
  .lp-store { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 6px; font-size: 13px; }
  .store-head, .store-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .store-head strong { margin-right: auto; }
  .offer-list { flex: 1; min-height: 60px; overflow: auto; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 3px 6px; border-bottom: 1px solid rgb(255 255 255 / .12); }
  th { position: sticky; top: 0; background: var(--win-bg, #161b20); }
  td button { width: 100%; text-align: left; min-height: 0; padding: 4px; }
  td button[aria-pressed="true"] { outline: 1px solid var(--theme-focus, #58a7bf); }
  .offer-summary { display: grid; gap: 4px; padding: 6px; background: rgb(255 255 255 / .06); }
  .offer-summary strong { display: flex; align-items: center; gap: 6px; }
  .offer-summary input { width: 4.8em; }
  p { margin: 0; }
</style>
