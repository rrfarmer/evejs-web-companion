<script lang="ts">
  import { onDestroy } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { isNpcCorporation } from "../bridge/ownerInfo.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ShipSkinrOwnedSkin } from "../bridge/shipSkinrCollection.ts";
  import type { ShipSkinrCurrency, ShipSkinrListingTarget } from "../bridge/shipSkinrMarket.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { formatIsk } from "./isk.ts";

  let { store, flow, skin, onClose, onListed }: { store: ClientStore; flow: AppFlow; skin: ShipSkinrOwnedSkin;
    onClose: () => void; onListed: () => void } = $props();
  const station = $derived(store.station);
  const wallet = $derived(store.wallet);
  const words = $derived(store.words);
  const owner = $derived($station.online);
  const prefix = "UI/Personalization/ShipSkins/SKINR/";
  const labels = {
    title: [prefix + "SellSkin", "Sell SKIN"], duration: [prefix + "Collection/SellListingDuration", "Listing Duration"],
    availability: [prefix + "ListingAvailability", "Listing Availability"],
    public: [prefix + "Collection/SellAvailability/Public", "Public"],
    corporation: [prefix + "Collection/SellAvailability/MyCorporation", "My Corporation"],
    alliance: [prefix + "Collection/SellAvailability/MyAlliance", "My Alliance"],
    specific: [prefix + "Collection/SellAvailability/Specific", "Specific Target"],
    target: [prefix + "Collection/SellTargetSearchHeader", "Search for a pilot, corporation or alliance"],
    copies: ["UI/Industry/Copies", "Copies"], price: ["UI/Market/Marketbase/Price", "Price"],
    service: [prefix + "ServiceFee", "Paragon Hub Vendor Fee"], cost: [prefix + "ListingCost", "Paragon Hub Listing Fee"],
    profit: [prefix + "TotalProfit", "Total Profit"],
    sell: [prefix + "Collection/Sell", "Sell"], cancel: ["UI/Common/Buttons/Cancel", "Cancel"],
  } as const;
  const durationLabels: Readonly<Record<number, readonly [string, string]>> = {
    86400: ["UI/Common/DateWords/Day", "Day"], 259200: ["UI/Market/MarketQuote/ThreeDays", "3 Days"],
    604800: ["UI/Common/DateWords/Week", "Week"], 1209600: ["UI/Market/MarketQuote/TwoWeeks", "2 Weeks"],
    2592000: ["UI/Common/DateWords/Month", "Month"], 7776000: ["UI/Market/MarketQuote/ThreeMonths", "3 Months"],
  };
  const label = (path: string, fallback: string) => plainText($words.templates[path] ?? fallback);
  const word = (key: keyof typeof labels) => label(...labels[key]);
  const durationWord = (seconds: number) => label(...(durationLabels[seconds] ?? ["", `${seconds / 86400} days`]));
  const ownerKinds = { 2: "character", 3: "corporation", 4: "alliance" } as const;
  type Candidate = { name: string; target: ShipSkinrListingTarget };
  let availability = $state<"public" | "corporation" | "alliance" | "specific">("specific");
  let currency = $state<ShipSkinrCurrency>("PLEX");
  let quantity = $state<number | undefined>(1);
  let amount = $state<number | undefined>(10);
  let seconds = $state(0);
  let query = $state("");
  let candidates = $state.raw<readonly Candidate[]>([]);
  let selected = $state.raw<Candidate | null>(null);
  let quote = $state.raw<Awaited<ReturnType<AppFlow["quoteShipSkinrListing"]>> | null>(null);
  let limits = $state.raw<{ current: number; max: number } | null>(null);
  let quoteFor = $state.raw<ShipSkinrListingTarget | null>(null);
  let busy = $state(false);
  let error = $state("");
  let quoteError = $state("");
  let receipt = $state<string | null>(null);
  let attempt = $state(0);
  let destroyed = false;
  let searchRevision = 0;
  const target = $derived.by((): ShipSkinrListingTarget | null => {
    if (availability === "public") return { kind: "public" };
    if (availability === "corporation" && owner?.corporationID) return { kind: "corporation", id: owner.corporationID };
    if (availability === "alliance" && owner?.allianceID) return { kind: "alliance", id: owner.allianceID };
    return availability === "specific" ? selected?.target ?? null : null;
  });
  const broker = $derived(quoteFor === target ? quote?.durations.find(row => row.seconds === seconds)?.fee : undefined);
  const walletBalance = $derived($wallet.cashBalance === null ? null : Number($wallet.cashBalance));
  const full = $derived(limits !== null && limits.current >= limits.max);
  const enoughFunds = $derived(broker !== undefined && walletBalance !== null && walletBalance >= broker);
  const gross = $derived((quantity ?? 0) * (amount ?? 0));
  const profit = $derived(quote && broker !== undefined ? currency === "PLEX" ? Math.floor(gross * (1 - quote.taxPercent / 100))
    : gross * (1 - quote.taxPercent / 100) - broker : null);
  const ready = $derived(!busy && !receipt && !!target && limits !== null && !full && enoughFunds &&
    Number.isSafeInteger(gross) && Number.isInteger(amount) && (amount ?? 0) >= 1 &&
    Number.isInteger(quantity) && (quantity ?? 0) >= 1 && (quantity ?? 0) <= skin.unactivated);

  onDestroy(() => { destroyed = true; searchRevision++; });
  $effect(() => {
    flow.requestWords([...Object.values(labels), ...Object.values(durationLabels)].map(([path]) => path));
    void flow.loadWallet({ fresh: true }).catch(() => {});
  });
  $effect(() => {
    void attempt;
    let current = true;
    void Promise.all([flow.loadShipSkinrOwnedListings(), flow.loadShipSkinrListingLimit()]).then(([rows, max]) => {
      if (current) limits = { current: rows.length, max };
    }, cause => { if (current) error = panelErrorWords(cause); });
    return () => { current = false; };
  });
  $effect(() => {
    void attempt;
    const quoted = target;
    let current = true;
    quoteFor = null;
    quoteError = "";
    void flow.quoteShipSkinrListing(skin.hex, quoted ?? { kind: "public" }).then(next => {
      if (!current) return;
      quote = next;
      quoteFor = quoted;
      if (!next.durations.some(row => row.seconds === seconds)) seconds = next.durations.at(-1)?.seconds ?? 0;
    }, cause => { if (current) quoteError = panelErrorWords(cause); });
    return () => { current = false; };
  });

  async function search() {
    const name = query.trim();
    if (!name || busy) return;
    const request = ++searchRevision;
    try {
      const matches = await flow.searchOwners(name, [2, 3, 4], 0);
      if (request !== searchRevision) return;
      candidates = [...matches].flatMap(([type, rows]) => {
        const kind = ownerKinds[type as keyof typeof ownerKinds];
        return kind ? rows.map(row => ({ name: row.name, target: { kind, id: row.id } })) : [];
      });
    } catch (cause) {
      if (request === searchRevision) error = panelErrorWords(cause);
    }
  }

  async function settle(id: string) {
    const result = await flow.waitForShipSkinrListing(id);
    if (destroyed) return;
    if (result === "completed") {
      void flow.loadWallet({ fresh: true }).catch(() => {});
      onListed();
    } else if (result === "failed") {
      receipt = null;
      error = "The listing could not be completed.";
      attempt++;
    } else {
      error = "The listing is still pending.";
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if ((!receipt && !ready) || busy || !target || !amount || !quantity) return;
    const input = { hex: skin.hex, quantity, amount, currency, seconds, target };
    busy = true;
    error = "";
    try {
      receipt ??= await flow.createShipSkinrListing(input);
      if (!destroyed) await settle(receipt);
    } catch (cause) {
      if (!destroyed) error = panelErrorWords(cause);
    } finally {
      busy = false;
    }
  }
</script>

<form class="skinr-sell" role="dialog" aria-label={word("title")} onsubmit={submit}>
  <h3>{word("title")} · {skin.design?.name}</h3>
  {#if limits}<p data-listing-limit>{limits.current}/{limits.max}</p>{/if}
  <div class="fields">
    <label>{word("copies")} <input type="number" min="1" max={skin.unactivated} bind:value={quantity} disabled={busy || !!receipt} required /></label>
    <label>{word("price")} <input type="number" min="1" step="1" bind:value={amount} disabled={busy || !!receipt} required /></label>
    <label>Currency <select bind:value={currency} disabled={busy || !!receipt}><option>ISK</option><option>PLEX</option></select></label>
    <label>{word("duration")} <select bind:value={seconds} disabled={!quote || busy || !!receipt}>
      {#each quote?.durations ?? [] as row (row.seconds)}<option value={row.seconds}>{durationWord(row.seconds)}</option>{/each}
    </select></label>
  </div>
  <label>{word("availability")} <select bind:value={availability} disabled={busy || !!receipt}>
    <option value="public">{word("public")}</option>
    {#if owner?.corporationID && !isNpcCorporation(owner.corporationID)}<option value="corporation">{word("corporation")}</option>{/if}
    {#if owner?.allianceID}<option value="alliance">{word("alliance")}</option>{/if}
    <option value="specific">{word("specific")}</option>
  </select></label>
  {#if availability === "specific"}
    <label>{word("target")} <input type="search" bind:value={query} disabled={busy || !!receipt}
      oninput={() => { selected = null; candidates = []; searchRevision++; }} /></label>
    <button type="button" disabled={!query.trim() || busy || !!receipt} onclick={() => void search()}>Search</button>
    {#each candidates as row}
      <button type="button" disabled={busy || !!receipt} aria-pressed={selected === row} onclick={() => { selected = row; candidates = []; }}>
        {row.name} · {row.target.kind}
      </button>
    {/each}
    {#if selected}<p data-listing-target>{selected.name}</p>{/if}
  {/if}
  {#if quote && target && broker !== undefined}
    <dl>
      <div><dt>{word("service")}</dt><dd data-listing-tax>{quote.taxPercent.toLocaleString()}%</dd></div>
      <div><dt>{word("cost")}</dt><dd data-listing-fee>{formatIsk(String(-broker))}</dd></div>
      {#if target.kind !== "public"}<div><dt>Buyer fee per SKIN</dt><dd>{quote.buyerFee.toLocaleString()} EverMarks</dd></div>{/if}
      <div><dt>{word("profit")}</dt><dd data-listing-profit>{profit === null ? "" : currency === "PLEX" ? `${profit.toLocaleString()} PLEX` : formatIsk(profit.toFixed(2))}</dd></div>
    </dl>
    {#if walletBalance !== null && !enoughFunds}<p>Insufficient ISK for the listing cost.</p>{/if}
  {/if}
  {#if full}<p>All listing slots are in use.</p>{/if}
  {#if quoteError}<p role="alert">{quoteError}</p><button type="button" onclick={() => attempt++}>Retry quote</button>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  <div class="actions">
    <button type="submit" disabled={busy || (!receipt && !ready)}>{receipt ? "Check listing" : word("sell")}</button>
    <button type="button" disabled={busy} onclick={onClose}>{word("cancel")}</button>
  </div>
</form>

<style>
  .skinr-sell { display: grid; gap: 10px; background: #ffffff08; padding: 14px; }
  h3, p, dl, dd { margin: 0; }
  label { display: grid; gap: 4px; }
  .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(135px, 100%), 1fr)); gap: 8px; }
  dl div, .actions { display: flex; justify-content: space-between; gap: 8px; }
  .actions { justify-content: flex-end; }
</style>
