<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { HyperNetConstraints, HyperNetOffer } from "../bridge/hyperNet.ts";
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
  } as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const ticketCount = (offer: HyperNetOffer) => plainText(formatTemplate(word("tickets"),
    { remaining_ticket_count: offer.remaining, ticket_count: offer.tickets }, { nameOf: () => "" }));
  const pageSize = 12;
  const priceBounds = [1_000_000, 10_000_000, 100_000_000] as const;
  const countBounds = [8, 16, 48, 512] as const;
  const defaults = { minPrice: 0, maxPrice: 0, minCount: 8, maxCount: 512 };
  type Ranges = typeof defaults;
  let filter = $state.raw<{ owner: number; ranges: Ranges } | null>(null);
  const ranges = $derived(filter?.ranges ?? defaults);
  const storageKey = (owner: number) => `evejs.hypernet.ranges.${owner}`;

  function loadRanges(owner: number): Ranges {
    try {
      const saved: Partial<Ranges> | null = JSON.parse(localStorage.getItem(storageKey(owner)) ?? "null");
      if (!saved) return defaults;
      const price = (bound: number | undefined) => priceBounds.some(value => value === bound) ? bound! : 0;
      const count = (bound: number | undefined, fallback: number) =>
        countBounds.some(value => value === bound) ? bound! : fallback;
      const restored = { minPrice: price(saved.minPrice), maxPrice: price(saved.maxPrice),
        minCount: count(saved.minCount, 8), maxCount: count(saved.maxCount, 512) };
      return (restored.maxPrice && restored.minPrice > restored.maxPrice) || restored.minCount > restored.maxCount
        ? defaults : restored;
    } catch {
      return defaults;
    }
  }

  function applyRanges(next: Ranges) {
    const owner = pilot;
    if (!owner) return;
    filter = { owner, ranges: next };
    try { localStorage.setItem(storageKey(owner), JSON.stringify(next)); } catch { /* keep the current selection */ }
  }

  $effect(() => {
    const owner = pilot;
    filter = owner ? { owner, ranges: loadRanges(owner) } : null;
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
    const { minPrice, maxPrice, minCount, maxCount } = selection.ranges;
    const constraints: HyperNetConstraints = {
      ...(minPrice ? { min_ticket_price: minPrice } : {}),
      ...(maxPrice ? { max_ticket_price: maxPrice } : {}),
      ...(minCount !== defaults.minCount ? { min_ticket_count: minCount } : {}),
      ...(maxCount !== defaults.maxCount ? { max_ticket_count: maxCount } : {}),
    };
    let current = true;
    void flow.loadHyperNetOffers(constraints).then(result => {
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
      <button type="button" onclick={() => applyRanges(defaults)}
        disabled={ranges.minPrice === 0 && ranges.maxPrice === 0 && ranges.minCount === 8 && ranges.maxCount === 512}>
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
  ul { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 245px), 1fr)); gap: 8px; padding: 0; margin: 0; list-style: none; }
  li { display: grid; gap: 8px; padding: 8px; background: #ffffff08; }
  .item { display: flex; align-items: center; gap: 8px; text-align: start; }
  img { width: 32px; height: 32px; object-fit: contain; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 4px; }
  dl, dd, p { margin: 0; }
  time { color: #b8c3cc; }
</style>
