<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { READABLE_ISK_LABELS, readableIsk } from "../bridge/giveMoney.ts";
  import { hyperNetCoreType, hyperNetCountBounds, hyperNetCreationQuote, hyperNetMinimumPrice, hyperNetTaxRate, type HyperNetNodeCount } from "../bridge/hyperNet.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { sessionPlace } from "../bridge/sessionPlace.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import type { InventoryItemRow } from "../store/types.ts";
  import { ASSET_ITEM_DRAG_MIME, decodeAssetItemDrag, decodeDrag, DRAG_MIME } from "./dragDrop.ts";
  import { showMarketDetails } from "./marketDetails.ts";

  let { store, flow, onCreated, onShowStoreProduct }: {
    store: ClientStore;
    flow: AppFlow;
    onCreated: (id: number) => void;
    onShowStoreProduct?: (typeID: number) => void;
  } = $props();
  const station = $derived(store.station);
  const flight = $derived(store.flight);
  const inventory = $derived(store.inventory);
  const names = $derived(store.names);
  const words = $derived(store.words);
  const pilot = $derived($station.online?.characterID);
  const stationID = $derived(sessionPlace($flight.status, $station.online).stationID);
  const hangar = $derived($inventory.hangar.rows.filter(row => row.flagID === 4 &&
    (row.locationID === undefined || row.locationID === stationID) && (row.ownerID === undefined || row.ownerID === pilot)));
  const prizes = $derived(hangar.filter(row => row.typeID !== hyperNetCoreType && row.itemID !== $flight.status?.shipID &&
    row.quantity === 1 && (!row.singleton || row.blueprintCopy)));
  const cores = $derived(hangar.filter(row => row.typeID === hyperNetCoreType).sort((a, b) => b.quantity - a.quantity));

  const labels = {
    item: ["UI/HyperNet/FilterItemLabel", "Item"],
    count: ["UI/HyperNet/TicketCountLabel", "HyperNode count"],
    price: ["UI/HyperNet/TicketPrice", "HyperNode price"],
    total: ["UI/HyperNet/TotalPrice", "Total price"],
    tax: ["UI/HyperNet/SalesTax", "Sales tax"],
    earnings: ["UI/HyperNet/Earnings", "Earnings"],
    private: ["UI/HyperNet/PrivateRaffle", "Private offer"],
    create: ["UI/HyperNet/CreateButton", "Create offer"],
    historic: ["UI/HyperNet/HistoricalStatistics", "Historical offers"],
    active: ["UI/HyperNet/ActiveStatistics", "Active offers"],
    max: ["UI/HyperNet/MaximumPrice", "Maximum price"],
    min: ["UI/HyperNet/MinimumPrice", "Minimum price"],
    average: ["UI/HyperNet/AveragePrice", "Average price"],
    market: ["UI/HyperNet/OpenMarket", "Open Market"],
    store: ["UI/HyperNet/OpenNES", "Open New Eden Store"],
  } as const;
  const word = (key: keyof typeof labels) => plainText(formatTemplate($words.templates[labels[key][0]] ?? labels[key][1],
    { percentage: new Intl.NumberFormat(undefined, { style: "percent" }).format(hyperNetTaxRate) }, { nameOf: () => null }));
  const iskFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const isk = (amount: number) => `${iskFormat.format(amount)} ISK`;
  const itemName = (item: InventoryItemRow) => resolvedName($names.resolved, "type", item.typeID, String(item.typeID));

  let itemID = $state(0);
  let tokenID = $state(0);
  let total = $state<number | undefined>(hyperNetMinimumPrice);
  let count = $state<HyperNetNodeCount>(8);
  let privateOffer = $state(false);
  let submitting = $state(false);
  let loading = $state(true);
  let loadError = $state("");
  let error = $state("");
  let pricing = $state.raw<Awaited<ReturnType<AppFlow["loadHyperNetPricing"]>>>();
  const prize = $derived(prizes.find(row => row.itemID === itemID));
  const typeID = $derived(prize?.typeID);
  let stats = $state.raw<{ typeID: number; value: Awaited<ReturnType<AppFlow["loadHyperNetTypeStatistics"]>> }>();
  let statsError = $state("");
  const priceStats = $derived(stats && stats.typeID === typeID ? stats.value : undefined);
  const statPrice = (value: number) => value === 0 ? "–" : readableIsk(value, path => {
    const template = $words.templates[path];
    return template ? plainText(template) : null;
  }) ?? isk(value);
  const token = $derived(cores.find(row => row.itemID === tokenID) ?? cores[0]);
  const estimate = $derived(prize && pricing?.estimates?.get(prize.typeID));
  const quote = $derived(total !== undefined && Number.isFinite(total) && pricing
    ? hyperNetCreationQuote(total, count, pricing.plexPrice) : undefined);
  const ready = $derived(!loading && !loadError && stationID !== null && prize && token && quote && token.quantity >= quote.cores);
  let generation = 0;

  $effect(() => {
    flow.requestWords([...Object.values(labels).map(([path]) => path), ...READABLE_ISK_LABELS]);
  });
  $effect(() => {
    stats = undefined;
    statsError = "";
    if (!pilot || !typeID) return;
    let current = true;
    const selected = typeID;
    void flow.loadHyperNetTypeStatistics(selected).then(value => {
      if (current) stats = { typeID: selected, value };
    }, cause => {
      if (current) statsError = panelErrorWords(cause);
    });
    return () => { current = false; };
  });
  $effect(() => {
    flow.requestNames(prizes.map(row => ({ kind: "type", id: row.typeID })));
  });
  $effect(() => {
    if (!pilot || stationID === null) return;
    const current = ++generation;
    itemID = 0;
    tokenID = 0;
    error = "";
    loadError = "";
    loading = true;
    submitting = false;
    Promise.all([flow.loadInventory(), flow.loadHyperNetPricing()]).then(([, result]) => {
      if (generation === current) pricing = result;
    }).catch(cause => {
      if (generation === current) loadError = panelErrorWords(cause);
    }).finally(() => {
      if (generation === current) loading = false;
    });
    return () => { generation++; };
  });

  function selectPrize(id: number) {
    itemID = id;
    const item = prizes.find(row => row.itemID === id);
    const market = item && pricing?.estimates?.get(item.typeID);
    total = market && pricing ? hyperNetCreationQuote(market * 1.4, count, pricing.plexPrice).total : hyperNetMinimumPrice;
    error = "";
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    if (loading || submitting) return;
    const drag = decodeDrag(event.dataTransfer?.getData(DRAG_MIME));
    const assets = decodeAssetItemDrag(event.dataTransfer?.getData(ASSET_ITEM_DRAG_MIME));
    const id = drag?.kind === "inventoryItem" && drag.from.kind === "hangar" ? drag.itemID : assets[0]?.itemID;
    if (id === undefined) return;
    if (cores.some(row => row.itemID === id)) tokenID = id;
    else if (prizes.some(row => row.itemID === id)) selectPrize(id);
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (submitting || !ready || stationID === null || !prize || !token || !quote) return;
    const current = generation;
    submitting = true;
    error = "";
    try {
      const id = await flow.createHyperNetOffer({
        stationID, itemID: prize.itemID, typeID: prize.typeID, tokenID: token.itemID, count, nodePrice: quote.nodePrice, privateOffer,
      });
      if (generation === current) {
        selectPrize(0);
        tokenID = 0;
        count = 8;
        privateOffer = false;
        onCreated(id);
        void flow.loadInventory().catch(() => undefined);
      }
    } catch (cause) {
      if (generation === current) error = panelErrorWords(cause);
    } finally {
      if (generation === current) submitting = false;
    }
  }
</script>

{#if stationID === null}
  <p class="create-status">Dock at an NPC station to select the item and HyperCores for your offer.</p>
{:else}
  <form class="create-offer" onsubmit={submit}>
    {#if loading || loadError}<p role="status">{loading ? "Loading hangar and prices…" : loadError}</p>{/if}
    <fieldset disabled={loading || submitting || !!loadError} ondrop={drop} ondragover={event => {
      if (event.dataTransfer?.types.some(type => type === DRAG_MIME || type === ASSET_ITEM_DRAG_MIME)) event.preventDefault();
    }}>
      <label>{word("item")}
        <select data-hypernet-create-item value={itemID} onchange={event => selectPrize(Number(event.currentTarget.value))}>
          <option value={0}>{prizes.length ? "Select an item" : "No eligible items in this hangar"}</option>
          {#each prizes as item (item.itemID)}
            <option value={item.itemID}>{itemName(item)}</option>
          {/each}
        </select>
      </label>
      <label>HyperCores
        <select data-hypernet-create-token value={token?.itemID ?? 0} onchange={event => tokenID = Number(event.currentTarget.value)}>
          {#if !cores.length}<option value={0}>No HyperCores in this hangar</option>{/if}
          {#each cores as stack (stack.itemID)}
            <option value={stack.itemID}>{stack.quantity.toLocaleString()} HyperCores</option>
          {/each}
        </select>
      </label>
      <div class="core-sources">
        <button type="button" data-hypernet-core-market onclick={() => showMarketDetails(hyperNetCoreType)}>{word("market")}</button>
        {#if onShowStoreProduct}
          <button type="button" data-hypernet-core-store onclick={() => onShowStoreProduct?.(hyperNetCoreType)}>{word("store")}</button>
        {/if}
      </div>
      <label>{word("count")}
        <select data-hypernet-create-count bind:value={count}>
          {#each hyperNetCountBounds as value}<option {value}>{value}</option>{/each}
        </select>
      </label>
      <label>{word("total")}
        <input data-hypernet-create-total type="number" inputmode="numeric" step="any" bind:value={total}
          onblur={() => { if (quote) total = quote.total; }} />
      </label>
      <label class="offer-private"><input data-hypernet-create-private type="checkbox" bind:checked={privateOffer} />{word("private")}</label>
      {#if quote}
        <dl>
          <dt>{word("price")}</dt><dd>{isk(quote.nodePrice)}</dd>
          <dt>{word("total")}</dt><dd data-hypernet-create-quote>{isk(quote.total)}</dd>
          <dt>{word("tax")}</dt><dd>{isk(quote.tax)}</dd>
          <dt>{word("earnings")}</dt><dd>{isk(quote.proceeds)}</dd>
          <dt>HyperCores required</dt><dd data-hypernet-create-core-cost={quote.cores}>{quote.cores.toLocaleString()}</dd>
        </dl>
        {#if prize && (!token || token.quantity < quote.cores)}<p role="status">The selected stack has too few HyperCores.</p>{/if}
        {#if estimate && estimate > quote.proceeds}<p role="status">Estimated market value {isk(estimate)} exceeds the offer earnings.</p>{/if}
      {/if}
      {#if typeID}
        <div class="price-stats" data-hypernet-type-statistics={typeID} aria-busy={!priceStats && !statsError}>
          {#if statsError}<p role="status">{statsError}</p>{/if}
          {#if !priceStats && !statsError}<p role="status">Loading offer statistics…</p>{/if}
          {#each ["historic", "active"] as scope}
            {@const summary = scope === "historic" ? priceStats?.historic : priceStats?.active}
            <section data-hypernet-stat-scope={scope} data-count={summary?.count}>
              <h3>{word(scope as "historic" | "active")}{summary?.count ? ` (${summary.count.toLocaleString()})` : ""}</h3>
              <dl>
                {#each ["max", "min", "average"] as measure}
                  {@const name = measure as "max" | "min" | "average"}
                  {@const value = summary?.[name]}
                  <dt>{word(name)}</dt>
                  <dd data-hypernet-stat={name} data-isk={value} title={value ? isk(value) : undefined}>{statPrice(value ?? 0)}</dd>
                {/each}
              </dl>
            </section>
          {/each}
        </div>
      {/if}
      {#if error}<p role="alert">{error}</p>{/if}
      <button data-hypernet-create-submit type="submit" disabled={!ready || submitting}>{submitting ? "Creating…" : word("create")}</button>
    </fieldset>
  </form>
{/if}

<style>
  .create-offer, .create-status { padding: 12px; }
  fieldset { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px; max-width: 580px; border: 0; margin: 0; padding: 0; min-width: 0; }
  label { display: grid; gap: 4px; min-width: 0; }
  select, input[type="number"] { width: 100%; min-width: 0; box-sizing: border-box; color: inherit; background: #10181d; border: 1px solid #42515b; padding: 5px; }
  .offer-private { display: flex; gap: 6px; align-items: center; }
  .core-sources { grid-column: 1 / -1; display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 6px; }
  dl { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr auto; gap: 6px; margin: 0; padding: 10px; background: #10181d; }
  .price-stats { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; }
  .price-stats h3 { font-size: .9rem; margin: 0 0 4px; }
  .price-stats[aria-busy="true"] section { opacity: .6; }
  dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
  p { grid-column: 1 / -1; margin: 0; }
  button { justify-self: start; }
</style>
