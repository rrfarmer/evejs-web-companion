<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { failureCode } from "../bridge/ask.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { READABLE_ISK_LABELS, readableIsk } from "../bridge/giveMoney.ts";
  import { hyperNetCoreType, hyperNetCountBounds, hyperNetCreationQuote, hyperNetMaximumPrice, hyperNetMinimumPrice, hyperNetPrizeRefusal, hyperNetTaxRate, type HyperNetNodeCount, type HyperNetPrizeRules } from "../bridge/hyperNet.ts";
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
  const candidates = $derived(hangar.filter(row => row.quantity > 0 && row.typeID !== hyperNetCoreType && row.itemID !== $flight.status?.shipID));
  let prizeRules = $state.raw<HyperNetPrizeRules>();
  let dynamic = $state.raw<ReadonlySet<number>>(new Set());
  let loadingDynamic = $state(false);
  const dynamicCandidates = $derived(prizeRules ? [...new Set(candidates.filter(row => row.singleton && row.quantity === 1 &&
    !prizeRules?.restricted.has(row.typeID) && !prizeRules?.singleton.has(row.typeID)).map(row => row.typeID))]
    .sort((a, b) => a - b).join(",") : "");
  const prizes = $derived(prizeRules ? candidates.filter(row => !hyperNetPrizeRefusal(row, prizeRules!, dynamic)) : []);
  const cores = $derived(hangar.filter(row => row.typeID === hyperNetCoreType).sort((a, b) => b.quantity - a.quantity));

  const labels = {
    item: ["UI/HyperNet/FilterItemLabel", "Item"],
    blueprintOriginal: ["UI/Generic/Original", "Original"],
    blueprintCopy: ["UI/Generic/Copy", "Copy"],
    stackHint: ["UI/HyperNet/CreateQuantityStackHint", "One item from the stack of {stack_size} will be listed."],
    count: ["UI/HyperNet/TicketCountLabel", "HyperNode count"],
    price: ["UI/HyperNet/TicketPrice", "HyperNode price"],
    total: ["UI/HyperNet/TotalPrice", "Total price"],
    tax: ["UI/HyperNet/SalesTax", "Sales tax"],
    earnings: ["UI/HyperNet/Earnings", "Earnings"],
    private: ["UI/HyperNet/PrivateRaffle", "Private offer"],
    create: ["UI/HyperNet/CreateButton", "Create offer"],
    clear: ["UI/HyperNet/ClearButton", "Clear"],
    confirm: ["UI/HyperNet/ConfirmPurchaseButtonLabel", "Confirm"],
    creating: ["UI/HyperNet/Creating", "Creating…"],
    success: ["UI/HyperNet/CreateSuccessTitle", "Offer created"],
    successMessage: ["UI/HyperNet/CreateSuccessMessage", "Your offer is available on the HyperNet Relay."],
    createAnother: ["UI/HyperNet/CreateAnother", "Create another"],
    viewOffer: ["UI/HyperNet/ViewRaffle", "View offer"],
    failed: ["UI/HyperNet/CreateFailedTitle", "Offer creation failed"],
    dismiss: ["UI/HyperNet/ConfirmCreationFailed", "OK"],
    historic: ["UI/HyperNet/HistoricalStatistics", "Historical offers"],
    active: ["UI/HyperNet/ActiveStatistics", "Active offers"],
    max: ["UI/HyperNet/MaximumPrice", "Maximum price"],
    min: ["UI/HyperNet/MinimumPrice", "Minimum price"],
    average: ["UI/HyperNet/AveragePrice", "Average price"],
    market: ["UI/HyperNet/OpenMarket", "Open Market"],
    store: ["UI/HyperNet/OpenNES", "Open New Eden Store"],
  } as const;
  const refusalLabels: Readonly<Record<string, string>> = {
    TokenPaymentError: "TokenPaymentError", ItemEscrowError: "ItemEscrowError", TypeMismatchError: "TypeMismatchError",
    TicketCountError: "TicketCountError", TicketPriceError: "TicketPriceError",
    ItemTypeError: "ItemTypeError", ItemLocationError: "ItemLocationError", ItemInventoryError: "ItemLocationError",
    ItemSingletonError: "ItemSingletonError", ItemOwnerError: "ItemOwnerError", ItemTriglavianSystemError: "ItemSystemFactionError",
    TokenTypeError: "TokenTypeError", TokenLocationError: "TokenLocationError", TokenInventoryError: "TokenLocationError",
    TokenOwnerError: "TokenOwnerError", TokenAmountError: "TokenAmountError", UnknownError: "UnknownError",
  };
  const word = (key: keyof typeof labels, args: Record<string, string> = {}) =>
    plainText(formatTemplate($words.templates[labels[key][0]] ?? labels[key][1],
      { percentage: new Intl.NumberFormat(undefined, { style: "percent" }).format(hyperNetTaxRate), ...args }, { nameOf: () => null }));
  const iskFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const isk = (amount: number) => `${iskFormat.format(amount)} ISK`;
  const itemName = (item: InventoryItemRow) => resolvedName($names.resolved, "type", item.typeID, String(item.typeID));
  const prizeName = (item: InventoryItemRow) => item.categoryID === 9
    ? `${itemName(item)} (${word(item.blueprintCopy ? "blueprintCopy" : "blueprintOriginal")})` : itemName(item);
  const prizeOption = (item: InventoryItemRow) => item.quantity > 1
    ? `${prizeName(item)} (×${item.quantity.toLocaleString()})` : prizeName(item);

  let itemID = $state(0);
  let tokenID = $state(0);
  let total = $state<number | undefined>(hyperNetMinimumPrice);
  let count = $state<HyperNetNodeCount>(8);
  let privateOffer = $state(false);
  let submitting = $state(false);
  let loading = $state(true);
  let loadError = $state("");
  let dropError = $state("");
  let result = $state<{ id: number; item: string } | { error: string }>();
  let armedFor = $state("");
  let confirmationReady = $state(false);
  let readyTimer: number | undefined;
  let expiryTimer: number | undefined;
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
  const estimate = $derived(prize && !prize.blueprintCopy && pricing?.estimates?.get(prize.typeID));
  const quote = $derived(total !== undefined && Number.isFinite(total) && pricing
    ? hyperNetCreationQuote(total, count, pricing.plexPrice) : undefined);
  const ready = $derived(!loading && !loadError && stationID !== null && prize && token && quote && token.quantity >= quote.cores);
  const terms = $derived(ready && quote && token ? [pilot, stationID, itemID, token.itemID, count, quote.nodePrice, privateOffer].join("/") : "");
  let generation = 0;

  $effect(() => {
    flow.requestWords([...Object.values(labels).map(([path]) => path), ...READABLE_ISK_LABELS,
      ...new Set(Object.values(refusalLabels).map(key => `UI/HyperNet/${key}`))]);
  });
  $effect(() => {
    if (armedFor && armedFor !== terms) cancelConfirmation();
  });
  $effect(() => () => cancelConfirmation());
  $effect(() => {
    const types = dynamicCandidates;
    dynamic = new Set();
    loadingDynamic = !!types;
    if (!types) return;
    let current = true;
    void flow.loadHyperNetDynamicTypes(types.split(",").map(Number)).then(value => {
      if (current) dynamic = value;
    }).catch(() => {
      if (current) dropError = "Modified item eligibility could not be read.";
    }).finally(() => {
      if (current) loadingDynamic = false;
    });
    return () => { current = false; };
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
    result = undefined;
    loadError = "";
    dropError = "";
    loading = true;
    submitting = false;
    Promise.all([flow.loadInventory(), flow.loadHyperNetPricing(), flow.loadHyperNetPrizeRules()]).then(([, result, rules]) => {
      if (generation === current) {
        pricing = result;
        prizeRules = rules;
      }
    }).catch(cause => {
      if (generation === current) loadError = panelErrorWords(cause);
    }).finally(() => {
      if (generation === current) loading = false;
    });
    return () => { generation++; };
  });

  function selectPrize(id: number) {
    itemID = id;
    dropError = "";
    const item = prizes.find(row => row.itemID === id);
    const market = item && !item.blueprintCopy && pricing?.estimates?.get(item.typeID);
    total = market && pricing ? hyperNetCreationQuote(market * 1.4, count, pricing.plexPrice).total : hyperNetMinimumPrice;
  }

  function cancelConfirmation() {
    window.clearTimeout(readyTimer);
    window.clearTimeout(expiryTimer);
    armedFor = "";
    confirmationReady = false;
  }

  function clearPrize() {
    result = undefined;
    cancelConfirmation();
    selectPrize(0);
  }

  function describeFailure(cause: unknown): string {
    if (failureCode(cause) !== "CALL_REFUSED" || !(cause instanceof Error)) return panelErrorWords(cause);
    return creationRefusal(cause.message);
  }

  function creationRefusal(key: string): string {
    const label = Object.hasOwn(refusalLabels, key) ? refusalLabels[key] : "UnknownError";
    const template = $words.templates[`UI/HyperNet/${label}`];
    return template ? plainText(formatTemplate(template, {
      min_price: isk(hyperNetMinimumPrice), max_price: isk(hyperNetMaximumPrice), factionID: 500026,
    }, { nameOf: (_kind, id) => id === 500026 ? "Triglavian Collective" : null })) : "HyperNet could not create this offer.";
  }

  function viewOffer(id: number) {
    clearPrize();
    onCreated(id);
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    if (loading || loadingDynamic || submitting || !prizeRules) return;
    const drag = decodeDrag(event.dataTransfer?.getData(DRAG_MIME));
    const assets = decodeAssetItemDrag(event.dataTransfer?.getData(ASSET_ITEM_DRAG_MIME));
    const id = drag?.kind === "inventoryItem" && drag.from.kind === "hangar" ? drag.itemID : assets[0]?.itemID;
    if (id === undefined) return;
    if (cores.some(row => row.itemID === id)) {
      tokenID = id;
      dropError = "";
      return;
    }
    const item = candidates.find(row => row.itemID === id);
    if (!item) {
      dropError = "Choose an item from your personal hangar at this station.";
      return;
    }
    const reason = hyperNetPrizeRefusal(item, prizeRules, dynamic);
    if (reason) dropError = creationRefusal(reason);
    else selectPrize(id);
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (submitting || result || !terms || !pilot || stationID === null || !prize || !token || !quote) return;
    const learnedKey = `evejs-hypernet-confirm:${pilot}`;
    if (armedFor !== terms) {
      cancelConfirmation();
      armedFor = terms;
      let learned = false;
      try { learned = localStorage.getItem(learnedKey) === "1"; } catch {}
      readyTimer = window.setTimeout(() => { confirmationReady = true; }, 400);
      expiryTimer = window.setTimeout(cancelConfirmation, learned ? 2900 : 9900);
      return;
    }
    if (!confirmationReady) return;
    cancelConfirmation();
    const current = generation;
    const item = prizeName(prize);
    submitting = true;
    try { localStorage.setItem(learnedKey, "1"); } catch {}
    try {
      const id = await flow.createHyperNetOffer({
        stationID, itemID: prize.itemID, typeID: prize.typeID, tokenID: token.itemID, count, nodePrice: quote.nodePrice, privateOffer,
      });
      if (generation === current) {
        result = { id, item };
        void flow.loadInventory().catch(() => undefined);
      }
    } catch (cause) {
      if (generation === current) result = { error: describeFailure(cause) };
    } finally {
      if (generation === current) submitting = false;
    }
  }
</script>

{#if stationID === null}
  <p class="create-status">Dock at an NPC station to select the item and HyperCores for your offer.</p>
{:else if submitting}
  <div class="create-result" data-hypernet-create-result="pending" role="status">{word("creating")}</div>
{:else if result && "id" in result}
  {@const id = result.id}
  <div class="create-result" data-hypernet-create-result="success">
    <div role="status">
      <h3>{word("success")}</h3>
      <p>{word("successMessage")}</p>
      <p>{result.item}</p>
    </div>
    <div class="result-actions">
      <button type="button" data-hypernet-create-another onclick={clearPrize}>{word("createAnother")}</button>
      <button type="button" data-hypernet-create-view={id} onclick={() => viewOffer(id)}>{word("viewOffer")}</button>
    </div>
  </div>
{:else if result}
  <div class="create-result" data-hypernet-create-result="failure">
    <div role="alert"><h3>{word("failed")}</h3><p>{result.error}</p></div>
    <div class="result-actions">
      <button type="button" data-hypernet-create-dismiss onclick={() => { result = undefined; }}>{word("dismiss")}</button>
    </div>
  </div>
{:else}
  <form class="create-offer" onsubmit={submit}>
    {#if loading || loadError}<p role="status">{loading ? "Loading hangar and prices…" : loadError}</p>{/if}
    <fieldset disabled={loading || loadingDynamic || submitting || !!loadError} ondrop={drop} ondragover={event => {
      if (event.dataTransfer?.types.some(type => type === DRAG_MIME || type === ASSET_ITEM_DRAG_MIME)) event.preventDefault();
    }}>
      <label>{word("item")}
        <select data-hypernet-create-item value={itemID} onchange={event => selectPrize(Number(event.currentTarget.value))}>
          <option value={0}>{prizes.length ? "Select an item" : "No eligible items in this hangar"}</option>
          {#each prizes as item (item.itemID)}
            <option value={item.itemID}>{prizeOption(item)}</option>
          {/each}
        </select>
      </label>
      {#if prize && prize.quantity > 1}
        <p data-hypernet-prize-stack={prize.quantity}>{word("stackHint", { stack_size: prize.quantity.toLocaleString() })}</p>
      {/if}
      {#if dropError}<p role="status" data-hypernet-drop-error>{dropError}</p>{/if}
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
      <div class="result-actions">
        <button type="button" disabled={!itemID} onclick={clearPrize}>{word("clear")}</button>
        <button data-hypernet-create-submit type="submit" disabled={!ready}
          aria-pressed={!!armedFor} aria-disabled={!!armedFor && !confirmationReady}
          class:confirm={!!armedFor}>{word(armedFor ? "confirm" : "create")}</button>
      </div>
    </fieldset>
  </form>
{/if}

<style>
  .create-offer, .create-status { padding: 12px; }
  .create-result { max-width: 480px; margin: 24px auto; padding: 16px; background: #10181d; border: 1px solid #42515b; }
  .create-result h3 { margin: 0 0 8px; }
  .create-result p { margin: 4px 0; }
  .create-result[data-hypernet-create-result="success"] { border-color: #4a836f; }
  .create-result[data-hypernet-create-result="failure"] { border-color: #a77d48; }
  .result-actions { grid-column: 1 / -1; display: flex; justify-content: space-between; gap: 6px; margin-top: 8px; }
  button.confirm { background: #315968; border-color: #6b9ba9; }
  button.confirm[aria-disabled="true"] { opacity: .65; }
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
