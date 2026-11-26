<script lang="ts">
  // The wallet's Market Transactions tab (marketTransactionsPanel.py; bridge/marketTransactions.ts): each of the pilot's
  // trades by its date, quantity, type, unit price, total (red bought, green sold), client and place; the date in the
  // corporation's blue for one made for it. Its filters (buy, sell or both; at least so many; a total of at least so
  // much; one type), its headers that sort, a hundred to a page. Its menu (OnTransactionMenu, 237 to 254): the type's
  // Show Info; Location, the place's route entries; Client, the other party's Show Info.
  //
  // Read as the tab is chosen (OnTabSelect), from what the market service keeps.
  //
  // Not done: the type's other menu entries and the double click's market details (ShowMarketDetails); a type dropped
  // on the type filter.
  import { onMount } from "svelte";
  import { formatTemplate, plainText, templateNameRefs } from "../bridge/clientWords.ts";
  import {
    TRANSACTIONS_PER_PAGE, sortedTransactions, transactionTypes, transactionVisible, type MarketTransaction, type TransactionColumn,
  } from "../bridge/marketTransactions.ts";
  import { resolvedName, type NameKind, type NameRef } from "../store/names.ts";
  import PlaceRouteMenu from "./PlaceRouteMenu.svelte";
  import { showInfo } from "./showInfo.ts";
  import { formatWalletCents } from "./isk.ts";
  import { walletShowsCents } from "./walletSettings.ts";
  import type { JsonValue } from "../bridge/wire.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const read = flow.marketTransactions;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const showCents = $derived(walletShowsCents($station.online?.characterID));

  const W = "UI/Wallet/WalletWindow";
  const WORDS = {
    date: "UI/Common/Date",
    quantity: `${W}/ColHeaderQuantity`,
    type: `${W}/ColHeaderType`,
    price: `${W}/ColHeaderPrice`,
    total: `${W}/ColHeaderCredit`,
    client: `${W}/ColHeaderClient`,
    where: `${W}/ColHeaderWhere`,
    fmtDate: `${W}/FmtWalletDate`,
    characterName: `${W}/CharacterName`,
    stationName: `${W}/StationName`,
    showing: `${W}/ShowingTransactions`,
    none: `${W}/HintNoTransactionsFound`,
    corp: `${W}/HintCorpTransaction`,
    location: `${W}/MenuLocation`,
    buyAndSell: `${W}/BuyAndSell`,
    buy: `${W}/ComboBuy`,
    sell: `${W}/ComboSell`,
    minQty: `${W}/MinQty`,
    minValue: `${W}/MinValue`,
    anyItem: `${W}/AnyItem`,
    isk: "UI/Common/ISK",
    showInfo: "UI/Commands/ShowInfo",
    previous: "UI/Common/Previous",
    more: "UI/Common/ViewMore",
  } as const;
  $effect(() => {
    flow.requestWords(Object.values(WORDS));
  });
  const nameOf = (kind: NameKind, id: number): string => resolvedName($names.resolved, kind, id, "");
  const word = (label: string, own: string): string => {
    const template = $words.templates[label];
    return typeof template === "string" && template !== "" ? plainText(template) : own;
  };
  /** A label filled as the client fills it, or the page's own words where the install's are not to hand. */
  const filled = (label: string, args: Record<string, JsonValue>, own: string): string => {
    const template = $words.templates[label];
    return typeof template === "string" && template !== "" ? plainText(formatTemplate(template, args, { nameOf })) : own;
  };

  // Each trade's type, client and place by name, as the labels ask for them.
  $effect(() => {
    const refs: NameRef[] = [];
    const characterTemplate = $words.templates[WORDS.characterName];
    const stationTemplate = $words.templates[WORDS.stationName];
    for (const row of $read.transactions) {
      refs.push({ kind: "type", id: row.typeID });
      if (typeof characterTemplate === "string") refs.push(...templateNameRefs(characterTemplate, { charID: row.clientID }));
      if (typeof stationTemplate === "string") refs.push(...templateNameRefs(stationTemplate, { station: row.stationID }));
    }
    if (refs.length > 0) flow.requestNames(refs);
  });

  const isk = (amount: number): string => showCents ? formatWalletCents(amount, word(WORDS.isk, "ISK"))
    : `${Math.round(amount).toLocaleString("en-US")} ${word(WORDS.isk, "ISK")}`;
  const typeName = (typeID: number): string => resolvedName($names.resolved, "type", typeID, "");
  const dateText = (row: MarketTransaction): string =>
    row.transactionDate === null ? "" : filled(WORDS.fmtDate, { dt: String(row.transactionDate) }, "");
  const clientText = (row: MarketTransaction): string => filled(WORDS.characterName, { charID: row.clientID }, "");
  const whereText = (row: MarketTransaction): string => filled(WORDS.stationName, { station: row.stationID }, "");

  // The filters (IsTransactionVisible).
  let side = $state<"both" | "buy" | "sell">("both");
  let typeChoice = $state(0);
  let minQuantityText = $state("");
  let minValueText = $state("");
  const wholeOf = (text: string): number | null => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);
  const types = $derived(transactionTypes($read.transactions, typeName));

  // The sort (BaseTransactionsList.Sort): the newest first until a header is chosen.
  let sortBy = $state<TransactionColumn>("date");
  let reverse = $state(true);
  function sortOn(column: TransactionColumn): void {
    if (sortBy === column) reverse = !reverse;
    else {
      sortBy = column;
      reverse = false;
    }
    page = 0;
  }

  const shown = $derived.by(() => {
    const filters = { buy: side === "both" ? null : side === "buy", typeID: typeChoice || null, minQuantity: wholeOf(minQuantityText), minValue: wholeOf(minValueText) };
    const visible = $read.transactions.filter((row) => transactionVisible(row, filters));
    return sortedTransactions(visible, sortBy, reverse, (row, column) => (column === "type" ? typeName(row.typeID) : column === "client" ? clientText(row) : whereText(row)));
  });

  // The pages (UpdateTransactionsByPage: back to the first at each change of the filters).
  let page = $state(0);
  $effect(() => {
    void side; void typeChoice; void minQuantityText; void minValueText;
    page = 0;
  });
  const pageCount = $derived(Math.ceil(shown.length / TRANSACTIONS_PER_PAGE));
  const onPage = $derived(shown.slice(page * TRANSACTIONS_PER_PAGE, (page + 1) * TRANSACTIONS_PER_PAGE));

  let menuFor = $state<bigint | null>(null);

  const HEADERS: readonly { readonly column: TransactionColumn; readonly label: string; readonly own: string; readonly num?: boolean }[] = [
    { column: "date", label: WORDS.date, own: "Date" },
    { column: "quantity", label: WORDS.quantity, own: "Quantity", num: true },
    { column: "type", label: WORDS.type, own: "Type" },
    { column: "price", label: WORDS.price, own: "Unit Price", num: true },
    { column: "total", label: WORDS.total, own: "Total", num: true },
    { column: "client", label: WORDS.client, own: "Client" },
    { column: "where", label: WORDS.where, own: "Where" },
  ];

  onMount(() => {
    void flow.loadMarketTransactions().catch(() => undefined);
  });
</script>

<div class="market-transactions">
  <p class="controls">
    <select bind:value={side} aria-label={word(WORDS.buyAndSell, "Buy and Sell")}>
      <option value="both">{word(WORDS.buyAndSell, "Buy and Sell")}</option>
      <option value="buy">{word(WORDS.buy, "Buy")}</option>
      <option value="sell">{word(WORDS.sell, "Sell")}</option>
    </select>
    <label>{word(WORDS.minQty, "Min Qty")} <input type="text" inputmode="numeric" size="8" bind:value={minQuantityText} /></label>
    <label>{word(WORDS.minValue, "Min Value")} <input type="text" inputmode="numeric" size="10" bind:value={minValueText} /></label>
    <select bind:value={typeChoice} aria-label={word(WORDS.type, "Type")}>
      <option value={0}>{word(WORDS.anyItem, "Any Item")}</option>
      {#each types as choice (choice.typeID)}
        <option value={choice.typeID}>{choice.name}</option>
      {/each}
    </select>
  </p>

  {#if $read.error}
    <p class="error">Your market transactions could not be read just now.</p>
  {:else if !$read.loaded}
    <p class="empty">Reading…</p>
  {:else if onPage.length === 0}
    <p class="empty">{word(WORDS.none, "No transactions found")}</p>
  {:else}
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead>
          <tr>
            {#each HEADERS as header (header.column)}
              <th class={header.num ? "num" : ""} aria-sort={sortBy === header.column ? (reverse ? "descending" : "ascending") : "none"}>
                <button type="button" class="trade-sort" onclick={() => sortOn(header.column)}>
                  {word(header.label, header.own)}{sortBy === header.column ? (reverse ? " ▼" : " ▲") : ""}
                </button>
              </th>
            {/each}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each onPage as row (row.transactionID)}
            <tr title={row.isForCorp ? word(WORDS.corp, "Made for the corporation") : undefined}>
              <td data-label={word(WORDS.date, "Date")} class={row.isForCorp ? "for-corp" : ""}>{dateText(row)}</td>
              <td class="num" data-label={word(WORDS.quantity, "Quantity")}>{row.quantity.toLocaleString("en-US")}</td>
              <td data-label={word(WORDS.type, "Type")}>{typeName(row.typeID)}</td>
              <td class="num unit-price" data-label={word(WORDS.price, "Unit Price")}>{isk(row.price)}</td>
              <td class="num {row.isBuyTransaction ? 'bought' : 'sold'}" data-label={word(WORDS.total, "Total")}>{isk(row.totalPrice)}</td>
              <td data-label={word(WORDS.client, "Client")}>{clientText(row)}</td>
              <td data-label={word(WORDS.where, "Where")}>{whereText(row)}</td>
              <td data-label="">
                <button type="button" class="minor" aria-label="The trade's menu" aria-expanded={menuFor === row.transactionID}
                  onclick={() => (menuFor = menuFor === row.transactionID ? null : row.transactionID)}>⋯</button>
                {#if menuFor === row.transactionID}
                  <span class="trade-menu">
                    <button type="button" class="minor" onclick={() => { menuFor = null; showInfo({ kind: "type", typeID: row.typeID }); }}>{word(WORDS.showInfo, "About it")}</button>
                    {#if row.stationID > 0}
                      <PlaceRouteMenu {store} {flow} placeID={row.stationID} heading={{ label: WORDS.location, own: "Where" }} />
                    {/if}
                    {#if row.clientID > 0}
                      <button type="button" class="minor" onclick={() => { menuFor = null; showInfo({ kind: "character", characterID: row.clientID }); }}>{word(WORDS.client, "Client")}</button>
                    {/if}
                  </span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if pageCount > 1}
      <!-- The browse buttons (UpdateBrowseButtonState, UpdateNumEntriesLabel), shown where there is more than a page. -->
      <p class="controls">
        <button type="button" class="minor" disabled={page === 0} onclick={() => (page = Math.max(0, page - 1))}>{word(WORDS.previous, "Back")}</button>
        <button type="button" class="minor" disabled={page >= pageCount - 1} onclick={() => (page = Math.min(pageCount - 1, page + 1))}>{word(WORDS.more, "More")}</button>
        <span>{filled(WORDS.showing, { numFirst: page * TRANSACTIONS_PER_PAGE + 1, numLast: Math.min(shown.length, (page + 1) * TRANSACTIONS_PER_PAGE), numTotal: shown.length }, `${page * TRANSACTIONS_PER_PAGE + 1} to ${Math.min(shown.length, (page + 1) * TRANSACTIONS_PER_PAGE)} of ${shown.length}`)}</span>
      </p>
    {/if}
  {/if}
</div>

<style>
  /* The client's colours (marketTransactionsPanel.py 222 to 236), as the page's own tokens that read in both themes:
     the corporation's blue, the price highlighted, a total bought in danger's and one sold in success's. */
  .market-transactions .for-corp { color: var(--color-accent); }
  .market-transactions .unit-price { color: var(--color-text-bright); }
  .market-transactions .bought { color: var(--color-danger); }
  .market-transactions .sold { color: var(--color-good); }
  .market-transactions .trade-menu { display: inline-flex; flex-wrap: wrap; gap: 0.25rem; margin-left: 0.25rem; }
  .market-transactions label { display: inline-flex; gap: 0.25rem; align-items: center; }
  .market-transactions .trade-sort { background: none; border: none; padding: 0; font: inherit; color: inherit; cursor: pointer; }
</style>
