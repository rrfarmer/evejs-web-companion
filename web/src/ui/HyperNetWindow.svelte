<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { isHyperNetItem, type HyperNetConstraints, type HyperNetItem, type HyperNetOffer } from "../bridge/hyperNet.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { formatDuration } from "../bridge/skills.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";
  import { typeIconUrl } from "./typeIcons.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const station = $derived(store.station);
  const pilot = $derived($station.online?.characterID);
  const labels = {
    refresh: ["UI/HyperNet/Refresh", "Refresh"],
    empty: ["UI/HyperNet/NoRafflesFoundError", "No HyperNet offers found"],
    price: ["UI/HyperNet/TicketPrice", "HyperNode price"],
    tickets: ["UI/HyperNet/RemainingTickets", "{remaining_ticket_count}/{ticket_count} HyperNodes"],
    count: ["UI/HyperNet/TicketCountLabel", "HyperNode count"],
    filters: ["UI/Calendar/CalendarWindow/Filters", "Filters"],
    reset: ["UI/HyperNet/Reset", "Reset"],
    minimum: ["UI/Common/Minimum", "Minimum"],
    maximum: ["UI/Common/Maximum", "Maximum"],
    any: ["UI/Common/Any", "Any"],
    item: ["UI/HyperNet/FilterItemLabel", "Item"],
    type_id: ["UI/Common/Type", "Type"],
    group_id: ["UI/Common/Group", "Group"],
    category_id: ["UI/Common/Category", "Category"],
    clear: ["UI/Common/Clear", "Clear"],
  } as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const ticketCount = (offer: HyperNetOffer) => plainText(formatTemplate(word("tickets"),
    { remaining_ticket_count: offer.remaining, ticket_count: offer.tickets }, { nameOf: () => "" }));
  const pageSize = 12;
  const priceBounds = [1_000_000, 10_000_000, 100_000_000] as const;
  const countBounds = [8, 16, 48, 512] as const;
  const defaults = { minPrice: 0, maxPrice: 0, minCount: 8, maxCount: 512 };
  type Ranges = typeof defaults;
  type Filters = Ranges & { item?: HyperNetItem };
  let filter = $state.raw<{ owner: number; values: Filters } | null>(null);
  const values = $derived(filter?.values ?? defaults);
  const ranges = $derived({ minPrice: values.minPrice, maxPrice: values.maxPrice, minCount: values.minCount, maxCount: values.maxCount });
  const selectedItem = $derived(values.item);
  const storageKey = (owner: number) => `evejs.hypernet.ranges.${owner}`;

  function loadFilters(owner: number): Filters {
    try {
      const saved: Partial<Filters> | null = JSON.parse(localStorage.getItem(storageKey(owner)) ?? "null");
      if (!saved) return defaults;
      const price = (bound: number | undefined) => priceBounds.some(value => value === bound) ? bound! : 0;
      const count = (bound: number | undefined, fallback: number) =>
        countBounds.some(value => value === bound) ? bound! : fallback;
      const restored = { minPrice: price(saved.minPrice), maxPrice: price(saved.maxPrice),
        minCount: count(saved.minCount, 8), maxCount: count(saved.maxCount, 512) };
      const ranges = (restored.maxPrice && restored.minPrice > restored.maxPrice) || restored.minCount > restored.maxCount
        ? defaults : restored;
      return isHyperNetItem(saved.item) ? { ...ranges, item: saved.item } : ranges;
    } catch {
      return defaults;
    }
  }

  function applyFilters(next: Filters) {
    const owner = pilot;
    if (!owner) return;
    filter = { owner, values: next };
    try { localStorage.setItem(storageKey(owner), JSON.stringify(next)); } catch { /* keep the current selection */ }
  }

  function applyRanges(next: Ranges) {
    applyFilters({ ...next, item: selectedItem });
  }

  let search = $state("");
  let searching = $state(false);
  let suggestions = $state.raw<readonly HyperNetItem[]>([]);
  let searchError = $state("");

  function applyItem(item?: HyperNetItem) {
    search = "";
    applyFilters({ ...ranges, item });
  }

  $effect(() => {
    const owner = pilot;
    filter = owner ? { owner, values: loadFilters(owner) } : null;
    search = "";
  });

  $effect(() => {
    const text = search.trim();
    suggestions = [];
    searchError = "";
    searching = text.length >= 2;
    if (text.length < 2) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void flow.searchHyperNetItems(text).then(items => {
        if (current) suggestions = items;
      }, cause => {
        if (current) searchError = panelErrorWords(cause);
      }).finally(() => {
        if (current) searching = false;
      });
    }, 200);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  });

  let offers = $state.raw<readonly HyperNetOffer[]>([]);
  let page = $state(0);
  let loading = $state(false);
  let error = $state("");
  let refresh = $state(0);
  let now = $state(Date.now());
  const pageOffers = $derived(offers.slice(page * pageSize, (page + 1) * pageSize)
    .sort((left, right) => left.price === right.price ? 0 : left.price > right.price ? -1 : 1));
  const active = $derived(pageOffers.filter(offer => offer.expires > now));

  function refreshBrowse() {
    const remaining = offers.filter(offer => offer.expires > Date.now());
    if ((page + 2) * pageSize <= remaining.length) {
      offers = remaining;
      page++;
    } else {
      refresh++;
    }
  }

  onMount(() => {
    flow.requestWords(Object.values(labels).map(([path]) => path));
    const timer = window.setInterval(() => { now = Date.now(); }, 1000);
    return () => window.clearInterval(timer);
  });

  $effect(() => {
    const owner = pilot;
    const selection = filter;
    void refresh;
    offers = [];
    page = 0;
    error = "";
    loading = !!owner;
    if (!owner || selection?.owner !== owner) return;
    const { minPrice, maxPrice, minCount, maxCount, item } = selection.values;
    const constraints: HyperNetConstraints = {
      ...(minPrice ? { min_ticket_price: minPrice } : {}),
      ...(maxPrice ? { max_ticket_price: maxPrice } : {}),
      ...(minCount !== defaults.minCount ? { min_ticket_count: minCount } : {}),
      ...(maxCount !== defaults.maxCount ? { max_ticket_count: maxCount } : {}),
    };
    let current = true;
    void flow.loadHyperNetOffers(constraints, item).then(result => {
      if (!current) return;
      const shuffled = [...result];
      for (let index = shuffled.length - 1; index > 0; index--) {
        const swap = Math.floor(Math.random() * (index + 1));
        [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
      }
      offers = shuffled;
      flow.requestNames([...new Set(result.map(offer => offer.typeID))].map(id => ({ kind: "type", id })));
    }, cause => {
      if (current) error = panelErrorWords(cause);
    }).finally(() => {
      if (current) loading = false;
    });
    return () => { current = false; };
  });
</script>

<section class="hypernet">
  <header>
    <details class="range-filters">
      <summary>{word("filters")}</summary>
      <fieldset class="item-filter">
        <legend>{word("item")}</legend>
        {#if selectedItem}
          <span data-selected-item>{selectedItem.name} <small>{word(selectedItem.key)}</small></span>
          <button type="button" onclick={() => applyItem()}>{word("clear")}</button>
        {/if}
        <input type="search" aria-label={word("item")} bind:value={search} autocomplete="off"
          onkeydown={event => {
            if (event.key === "Enter" && suggestions.length === 1) applyItem(suggestions[0]);
          }} />
        {#if searchError}
          <p role="alert">{searchError}</p>
        {:else if searching}
          <p role="status">Searching…</p>
        {:else if search.trim().length >= 2}
          {#if suggestions.length}
            <div class="item-suggestions">
              {#each suggestions as item (`${item.key}:${item.id}`)}
                <button type="button" data-item-filter={`${item.key}:${item.id}`} onclick={() => applyItem(item)}>
                  {item.name} <small>{word(item.key)}</small>
                </button>
              {/each}
            </div>
          {:else}
            <p role="status">No matching items</p>
          {/if}
        {/if}
      </fieldset>
      <fieldset>
        <legend>{word("price")}</legend>
        <label>{word("minimum")}
          <select data-range="minPrice" value={ranges.minPrice}
            onchange={event => applyRanges({ ...ranges, minPrice: Number(event.currentTarget.value) })}>
            <option value={0}>{word("any")}</option>
            {#each priceBounds as price}
              <option value={price} disabled={ranges.maxPrice > 0 && price > ranges.maxPrice}>{price.toLocaleString()} ISK</option>
            {/each}
          </select>
        </label>
        <label>{word("maximum")}
          <select data-range="maxPrice" value={ranges.maxPrice}
            onchange={event => applyRanges({ ...ranges, maxPrice: Number(event.currentTarget.value) })}>
            <option value={0}>{word("any")}</option>
            {#each priceBounds as price}
              <option value={price} disabled={price < ranges.minPrice}>{price.toLocaleString()} ISK</option>
            {/each}
          </select>
        </label>
      </fieldset>
      <fieldset>
        <legend>{word("count")}</legend>
        <label>{word("minimum")}
          <select data-range="minCount" value={ranges.minCount}
            onchange={event => applyRanges({ ...ranges, minCount: Number(event.currentTarget.value) })}>
            {#each countBounds as count}
              <option value={count} disabled={count > ranges.maxCount}>{count}</option>
            {/each}
          </select>
        </label>
        <label>{word("maximum")}
          <select data-range="maxCount" value={ranges.maxCount}
            onchange={event => applyRanges({ ...ranges, maxCount: Number(event.currentTarget.value) })}>
            {#each countBounds as count}
              <option value={count} disabled={count < ranges.minCount}>{count}</option>
            {/each}
          </select>
        </label>
      </fieldset>
      <button type="button" onclick={() => { search = ""; applyFilters(defaults); }}
        disabled={!selectedItem && ranges.minPrice === 0 && ranges.maxPrice === 0 && ranges.minCount === 8 && ranges.maxCount === 512}>
        {word("reset")}
      </button>
    </details>
    <button type="button" onclick={refreshBrowse} disabled={loading || !pilot}>{word("refresh")}</button>
  </header>
  {#if loading}
    <p role="status">Loading HyperNet offers…</p>
  {:else if error}
    <p role="alert">{error}</p>
  {:else if !active.length}
    <p role="status">{word("empty")}</p>
  {:else}
    <ul>
      {#each active as offer (offer.id)}
        <li data-offer-id={offer.id}>
          <button class="item" type="button" onclick={() => showInfo({ kind: "type", typeID: offer.typeID })}>
            <img src={typeIconUrl(offer.typeID)} alt="" />
            {resolvedName($names.resolved, "type", offer.typeID, String(offer.typeID))}
          </button>
          <dl>
            <dt>{word("price")}</dt><dd data-ticket-price>{offer.price.toLocaleString()} ISK</dd>
          </dl>
          <p data-ticket-count>{ticketCount(offer)}</p>
          <time datetime={new Date(offer.expires).toISOString()}>{formatDuration(offer.expires - now)}</time>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .hypernet { display: grid; gap: 12px; padding: 14px; }
  header { display: flex; justify-content: space-between; align-items: start; gap: 8px; }
  summary { cursor: pointer; }
  fieldset { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0; }
  fieldset label { display: flex; align-items: center; gap: 6px; }
  .item-filter { align-items: center; }
  .item-filter input { width: min(230px, 100%); }
  .item-suggestions { width: 100%; max-height: 12em; overflow: auto; display: grid; gap: 3px; }
  .item-suggestions button { text-align: start; }
  small { color: #b8c3cc; margin-inline-start: 4px; }
  ul { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 245px), 1fr)); gap: 8px; padding: 0; margin: 0; list-style: none; }
  li { display: grid; gap: 8px; padding: 8px; background: #ffffff08; }
  .item { display: flex; align-items: center; gap: 8px; text-align: start; }
  img { width: 32px; height: 32px; object-fit: contain; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 4px; }
  dl, dd, p { margin: 0; }
  time { color: #b8c3cc; }
</style>
