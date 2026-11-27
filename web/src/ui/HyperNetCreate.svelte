<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { hyperNetCoreType, hyperNetCountBounds, hyperNetCreationQuote, hyperNetMinimumPrice, hyperNetTaxRate, type HyperNetNodeCount } from "../bridge/hyperNet.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { sessionPlace } from "../bridge/sessionPlace.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import type { InventoryItemRow } from "../store/types.ts";
  import { ASSET_ITEM_DRAG_MIME, decodeAssetItemDrag, decodeDrag, DRAG_MIME } from "./dragDrop.ts";

  let { store, flow, onCreated }: { store: ClientStore; flow: AppFlow; onCreated: (id: number) => void } = $props();
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
  const token = $derived(cores.find(row => row.itemID === tokenID) ?? cores[0]);
  const estimate = $derived(prize && pricing?.estimates?.get(prize.typeID));
  const quote = $derived(total !== undefined && Number.isFinite(total) && pricing
    ? hyperNetCreationQuote(total, count, pricing.plexPrice) : undefined);
  const ready = $derived(!loading && !loadError && stationID !== null && prize && token && quote && token.quantity >= quote.cores);
  let generation = 0;

  $effect(() => {
    flow.requestWords(Object.values(labels).map(([path]) => path));
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
  dl { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr auto; gap: 6px; margin: 0; padding: 10px; background: #10181d; }
  dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
  p { grid-column: 1 / -1; margin: 0; }
  button { justify-self: start; }
</style>
