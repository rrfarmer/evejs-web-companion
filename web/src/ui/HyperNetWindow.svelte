<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { hyperNetCountBounds as countBounds, hyperNetPriceBounds as priceBounds, isHyperNetItem, type HyperNetConstraints, type HyperNetItem, type HyperNetOffer, type HyperNetOfferDetails } from "../bridge/hyperNet.ts";
  import { hyperNetLinkLabel } from "../bridge/hyperNetOfferLink.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import HyperNetOfferCard from "./HyperNetOfferCard.svelte";
  import HyperNetCreate from "./HyperNetCreate.svelte";
  import HyperNetDetails from "./HyperNetDetails.svelte";
  import HyperNetHistory from "./HyperNetHistory.svelte";
  import { quickBuyWords } from "./HyperNetQuickBuy.svelte";
  import HyperNetSavedFilters from "./HyperNetSavedFilters.svelte";

  let { store, flow, onShowStoreProduct }: { store: ClientStore; flow: AppFlow; onShowStoreProduct?: (typeID: number) => void } = $props();
  const words = $derived(store.words);
  const station = $derived(store.station);
  const pilot = $derived($station.online?.characterID);
  $effect(() => {
    if (pilot !== undefined) flow.loadHyperNetWinnerState();
  });
  const labels = {
    browse: ["UI/HyperNet/TabNameBrowse", "Browse"],
    history: ["UI/HyperNet/TabNameMyRaffles", "History"],
    create: ["UI/HyperNet/TabNameCreate", "Create"],
    back: ["UI/Common/Previous", "Back"],
    forward: ["UI/Common/Next", "Forward"],
    refresh: ["UI/HyperNet/Refresh", "Refresh"],
    empty: ["UI/HyperNet/NoRafflesFoundError", "No HyperNet offers found"],
    price: ["UI/HyperNet/TicketPrice", "HyperNode price"],
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
    location: ["UI/HyperNet/FilterLocationLabel", "Solar system"],
    metaGroup: ["UI/HyperNet/FilterMetaGroupLabel", "Meta group"],
    all: ["UI/Common/All", "All"],
    blueprint: ["UI/HyperNet/FilterBlueprintLabel", "Blueprint type"],
    blueprintAll: ["UI/Generic/All", "All"],
    blueprintOriginal: ["UI/Generic/Original", "Original"],
    blueprintCopy: ["UI/Generic/Copy", "Copy"],
  } as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const pageSize = 12;
  type Location = { readonly view: "browse" | "history" | "create"; readonly offer: number | null };
  let locations = $state.raw<readonly Location[]>([{ view: "browse", offer: null }]);
  let locationIndex = $state(0);
  const view = $derived(locations[locationIndex]!.view);
  const detailsID = $derived(locations[locationIndex]!.offer);
  let navigation = $state<HTMLElement>();
  function navigate(next: Location) {
    if (next.view === view && next.offer === detailsID) return;
    locations = [...locations.slice(0, locationIndex + 1), next];
    locationIndex++;
    navigation?.scrollIntoView({ block: "nearest" });
  }
  function changeView(next: Location["view"]) {
    navigate({ view: next, offer: null });
  }
  function openDetails(id: number) {
    navigate({ view, offer: id });
  }
  $effect(() => flow.hyperNetOfferLink.subscribe(id => {
    if (id !== null && flow.takeHyperNetOfferLink() !== null) openDetails(id);
  }));
  const defaults = { minPrice: 0, maxPrice: 0, minCount: 8, maxCount: 512 };
  type Ranges = typeof defaults;
  type Option = { readonly id: number; readonly name: string };
  type Filters = Ranges & { item?: HyperNetItem; system?: Option; metaGroup?: number; blueprintType?: 1 | 2 };
  let selectedFilter = $state("");
  let filter = $state.raw<{ owner: number; values: Filters } | null>(null);
  const values = $derived(filter?.values ?? defaults);
  const ranges = $derived({ minPrice: values.minPrice, maxPrice: values.maxPrice, minCount: values.minCount, maxCount: values.maxCount });
  const selectedItem = $derived(values.item);
  const isBlueprint = $derived((selectedItem?.key === "category_id" ? selectedItem.id : selectedItem?.categoryID) === 9);
  const isDefault = $derived(!selectedItem && !values.system && !values.metaGroup && !values.blueprintType &&
    ranges.minPrice === 0 && ranges.maxPrice === 0 && ranges.minCount === 8 && ranges.maxCount === 512);
  const storageKey = (owner: number) => `evejs.hypernet.ranges.${owner}`;

  function restoreFilters(stored: unknown): Filters {
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return defaults;
    const saved = stored as Partial<Filters>;
    const price = (bound: number | undefined) => priceBounds.some(value => value === bound) ? bound! : 0;
    const count = (bound: number | undefined, fallback: number) =>
      countBounds.some(value => value === bound) ? bound! : fallback;
    const restored = { minPrice: price(saved.minPrice), maxPrice: price(saved.maxPrice),
      minCount: count(saved.minCount, 8), maxCount: count(saved.maxCount, 512) };
    const ranges = (restored.maxPrice && restored.minPrice > restored.maxPrice) || restored.minCount > restored.maxCount
      ? defaults : restored;
    const system = saved.system;
    return {
      ...ranges,
      item: isHyperNetItem(saved.item) ? saved.item : undefined,
      system: system && Number.isSafeInteger(system.id) && system.id > 0 &&
        typeof system.name === "string" && system.name.length > 0 ? system : undefined,
      metaGroup: typeof saved.metaGroup === "number" && Number.isSafeInteger(saved.metaGroup) &&
        saved.metaGroup > 0 ? saved.metaGroup : undefined,
      blueprintType: saved.blueprintType === 1 || saved.blueprintType === 2 ? saved.blueprintType : undefined,
    };
  }

  function loadFilters(owner: number): Filters {
    try {
      return restoreFilters(JSON.parse(localStorage.getItem(storageKey(owner)) ?? "null"));
    } catch {
      return defaults;
    }
  }

  function sameFilters(a: Filters, b: Filters): boolean {
    return a.minPrice === b.minPrice && a.maxPrice === b.maxPrice && a.minCount === b.minCount && a.maxCount === b.maxCount &&
      a.item?.key === b.item?.key && a.item?.id === b.item?.id && a.system?.id === b.system?.id &&
      a.metaGroup === b.metaGroup && a.blueprintType === b.blueprintType;
  }

  function applyFilters(next: Filters, name = "") {
    const owner = pilot;
    if (!owner) return;
    filter = { owner, values: next };
    selectedFilter = name;
    try { localStorage.setItem(storageKey(owner), JSON.stringify(next)); } catch { /* keep the current selection */ }
  }

  function browseSimilar(item?: HyperNetItem) {
    search = "";
    systemSearch = "";
    applyFilters(item ? { ...defaults, item } : defaults);
    changeView("browse");
  }

  function applyRanges(next: Ranges) {
    applyFilters({ ...values, ...next });
  }

  let search = $state("");
  let searching = $state(false);
  let suggestions = $state.raw<readonly HyperNetItem[]>([]);
  let searchError = $state("");
  let systemSearch = $state("");
  let systemOptions = $state.raw<readonly Option[]>([]);
  let systemStatus = $state("");
  let metaGroups = $state.raw<readonly Option[]>([]);
  let metaError = $state("");

  function applyItem(item?: HyperNetItem) {
    search = "";
    applyFilters({ ...values, item });
  }

  function applySystem(system?: Option) {
    systemSearch = "";
    applyFilters({ ...values, system });
  }

  $effect(() => {
    const owner = pilot;
    const restored = owner ? loadFilters(owner) : defaults;
    filter = owner ? { owner, values: restored } : null;
    search = "";
    systemSearch = "";
  });

  $effect(() => {
    const item = selectedItem;
    const owner = pilot;
    if (!owner || !item || item.key === "category_id" || item.categoryID !== undefined) return;
    let current = true;
    void flow.hyperNetItemCategory(item).then(categoryID => {
      if (current && pilot === owner && selectedItem === item && categoryID !== null)
        applyFilters({ ...values, item: { ...item, categoryID } }, selectedFilter);
    }).catch(() => { /* keep the stored item filter */ });
    return () => { current = false; };
  });

  $effect(() => {
    const text = systemSearch.trim();
    systemOptions = [];
    systemStatus = text.length < 2 ? "" : "Searching…";
    if (text.length < 2) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void flow.searchDestinations(text, "system").then(matches => {
        if (!current) return;
        systemOptions = matches.map(({ id, name }) => ({ id, name }));
        systemStatus = matches.length ? "" : "No matching solar systems";
      }, cause => {
        if (current) systemStatus = panelErrorWords(cause);
      });
    }, 200);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
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
  let ownedTickets = $state.raw<ReadonlyMap<number, number>>(new Map());
  let ownedPilot: number | undefined;
  let ownedRevision = 0;
  let page = $state(0);
  let loading = $state(false);
  let error = $state("");
  let refresh = $state(0);
  let now = $state(Date.now());
  const pageOffers = $derived(offers.slice(page * pageSize, (page + 1) * pageSize)
    .sort((left, right) => left.price === right.price ? 0 : left.price > right.price ? -1 : 1));
  const active = $derived(pageOffers.filter(offer => offer.expires > now));

  $effect(() => {
    const owner = pilot;
    if (owner !== ownedPilot) {
      ownedPilot = owner;
      ownedTickets = new Map();
    }
    if (!owner) return;
    const revision = ownedRevision;
    let current = true;
    void flow.loadHyperNetActiveTickets().then(counts => {
      if (current && revision === ownedRevision) ownedTickets = counts;
    }).catch(() => {});
    return () => { current = false; };
  });

  function updateBrowseOffer(row: HyperNetOfferDetails, count: number) {
    ++ownedRevision;
    ownedTickets = new Map(ownedTickets).set(row.id, count);
    offers = offers.map(offer => offer.id === row.id && row.remaining <= offer.remaining ? row : offer);
  }

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
    flow.requestWords([...Object.values(labels).map(([path]) => path), ...quickBuyWords, hyperNetLinkLabel]);
    let current = true;
    void flow.loadHyperNetMetaGroups().then(groups => {
      if (current) metaGroups = groups;
    }, cause => {
      if (current) metaError = panelErrorWords(cause);
    });
    const timer = window.setInterval(() => { now = Date.now(); }, 1000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
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
    const { minPrice, maxPrice, minCount, maxCount, item, system, metaGroup, blueprintType } = selection.values;
    const constraints: HyperNetConstraints = {
      ...(minPrice ? { min_ticket_price: minPrice } : {}),
      ...(maxPrice ? { max_ticket_price: maxPrice } : {}),
      ...(minCount !== defaults.minCount ? { min_ticket_count: minCount } : {}),
      ...(maxCount !== defaults.maxCount ? { max_ticket_count: maxCount } : {}),
    };
    let current = true;
    void flow.loadHyperNetOffers(constraints, item, {
      ...(system ? { solar_system_id: system.id } : {}),
      ...(metaGroup ? { meta_group_id: metaGroup } : {}),
      ...(isBlueprint && blueprintType ? { blueprint_type: blueprintType } : {}),
    }).then(result => {
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
  <nav aria-label="HyperNet Relay" bind:this={navigation}>
    <button type="button" aria-pressed={detailsID === null && view === "browse"} onclick={() => changeView("browse")}>{word("browse")}</button>
    <button type="button" aria-pressed={detailsID === null && view === "history"} onclick={() => changeView("history")}>{word("history")}</button>
    <button type="button" aria-pressed={detailsID === null && view === "create"} onclick={() => changeView("create")}>{word("create")}</button>
    {#if locationIndex > 0}
      <button type="button" data-hypernet-back onclick={() => { locationIndex--; }}>{word("back")}</button>
    {/if}
    {#if locationIndex < locations.length - 1}
      <button type="button" data-hypernet-forward onclick={() => { locationIndex++; }}>{word("forward")}</button>
    {/if}
  </nav>
  {#if detailsID !== null}
    {#key detailsID}
      <HyperNetDetails {store} {flow} {pilot} id={detailsID} {now} {ownedTickets} {openDetails} {browseSimilar}
        onPurchase={updateBrowseOffer} />
    {/key}
  {/if}
  <div class="catalogue" hidden={detailsID !== null}>
  {#if view === "history"}
    <HyperNetHistory {store} {flow} {pilot} {now} visible={detailsID === null} {openDetails} onPurchase={updateBrowseOffer} />
  {:else if view === "create"}
    <HyperNetCreate {store} {flow} onCreated={openDetails} {onShowStoreProduct} />
  {:else}
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
      {#if isBlueprint}
        <label class="meta-group">{word("blueprint")}
          <select data-blueprint-type value={values.blueprintType ?? 0} onchange={event => {
            const subtype = Number(event.currentTarget.value);
            applyFilters({ ...values, blueprintType: subtype === 1 || subtype === 2 ? subtype : undefined });
          }}>
            <option value={0}>{word("blueprintAll")}</option>
            <option value={1}>{word("blueprintOriginal")}</option>
            <option value={2}>{word("blueprintCopy")}</option>
          </select>
        </label>
      {/if}
      <fieldset class="item-filter">
        <legend>{word("location")}</legend>
        {#if values.system}
          <span data-selected-system>{values.system.name}</span>
          <button type="button" onclick={() => applySystem()}>{word("clear")}</button>
        {/if}
        <input type="search" aria-label={word("location")} bind:value={systemSearch} autocomplete="off"
          onkeydown={event => {
            if (event.key === "Enter" && systemOptions.length === 1) applySystem(systemOptions[0]);
          }} />
        {#if systemStatus}<p role="status">{systemStatus}</p>{/if}
        {#if systemOptions.length}
          <div class="item-suggestions">
            {#each systemOptions as system (system.id)}
              <button type="button" data-system-filter={system.id} onclick={() => applySystem(system)}>{system.name}</button>
            {/each}
          </div>
        {/if}
      </fieldset>
      <label class="meta-group">{word("metaGroup")}
        <select data-meta-group value={values.metaGroup ?? 0} disabled={!metaGroups.length}
          onchange={event => applyFilters({ ...values, metaGroup: Number(event.currentTarget.value) || undefined })}>
          <option value={0}>{word("all")}</option>
          {#each metaGroups as group (group.id)}
            <option value={group.id}>{group.name}</option>
          {/each}
        </select>
      </label>
      {#if metaError}<p role="alert">{metaError}</p>{/if}
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
      <button type="button" onclick={() => { search = ""; systemSearch = ""; applyFilters(defaults); }}
        disabled={isDefault}>
        {word("reset")}
      </button>
      <HyperNetSavedFilters {flow} {store} {pilot} scope="browse" {values} {isDefault}
        restore={restoreFilters} readActive={loadFilters} {sameFilters} bind:selectedFilter
        choose={preset => { search = ""; systemSearch = ""; applyFilters(preset); }} />
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
        <HyperNetOfferCard {store} {flow} {pilot} {offer} {now} owned={ownedTickets.get(offer.id) ?? 0}
          enabled={detailsID === null} {openDetails} onPurchase={updateBrowseOffer} />
      {/each}
    </ul>
  {/if}
  {/if}
  </div>
</section>

<style>
  .hypernet { display: grid; gap: 12px; padding: 14px; }
  .catalogue:not([hidden]) { display: grid; gap: 12px; }
  nav { display: flex; gap: 6px; }
  nav button[aria-pressed="true"] { border-color: currentColor; }
  header { display: flex; justify-content: space-between; align-items: start; gap: 8px; }
  summary { cursor: pointer; }
  fieldset { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0; }
  fieldset label { display: flex; align-items: center; gap: 6px; }
  .item-filter { align-items: center; }
  .item-filter input { width: min(230px, 100%); }
  .item-suggestions { width: 100%; max-height: 12em; overflow: auto; display: grid; gap: 3px; }
  .item-suggestions button { text-align: start; }
  .meta-group { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
  small { color: #b8c3cc; margin-inline-start: 4px; }
  ul { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 245px), 1fr)); gap: 8px; padding: 0; margin: 0; list-style: none; }
  p { margin: 0; }
</style>
