<script lang="ts">
  import { onMount, tick } from "svelte";
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
    location: ["UI/HyperNet/FilterLocationLabel", "Solar system"],
    metaGroup: ["UI/HyperNet/FilterMetaGroupLabel", "Meta group"],
    all: ["UI/Common/All", "All"],
    blueprint: ["UI/HyperNet/FilterBlueprintLabel", "Blueprint type"],
    blueprintAll: ["UI/Generic/All", "All"],
    blueprintOriginal: ["UI/Generic/Original", "Original"],
    blueprintCopy: ["UI/Generic/Copy", "Copy"],
    savedFilters: ["UI/HyperNet/SavedFilters", "Saved filters"],
    saveFilter: ["UI/HyperNet/SaveFilterHint", "Save current filter settings"],
    deleteFilter: ["UI/HyperNet/DeleteSavedFilter", "Delete"],
    noFilter: ["UI/HyperNet/NoFilterSelected", "(no filter selected)"],
    noSavedFilters: ["UI/HyperNet/NoSavedFiltersHint", "No saved filters"],
    filterNameCaption: ["UI/HyperNet/FilterNamePromptCaption", "Filter name"],
    filterName: ["UI/HyperNet/FilterNamePromptHint", "Type a name for the filter"],
    save: ["UI/Generic/Save", "Save"],
    cancel: ["UI/Generic/Cancel", "Cancel"],
    yes: ["UI/Generic/Yes", "Yes"],
    no: ["UI/Generic/No", "No"],
  } as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const ticketCount = (offer: HyperNetOffer) => plainText(formatTemplate(word("tickets"),
    { remaining_ticket_count: offer.remaining, ticket_count: offer.tickets }, { nameOf: () => "" }));
  const pageSize = 12;
  const priceBounds = [1_000_000, 10_000_000, 100_000_000] as const;
  const countBounds = [8, 16, 48, 512] as const;
  const defaults = { minPrice: 0, maxPrice: 0, minCount: 8, maxCount: 512 };
  type Ranges = typeof defaults;
  type Option = { readonly id: number; readonly name: string };
  type Filters = Ranges & { item?: HyperNetItem; system?: Option; metaGroup?: number; blueprintType?: 1 | 2 };
  type SavedFilter = { readonly name: string; readonly values: Filters };
  type PendingFilter = { kind: "delete"; name: string } | { kind: "replace"; name: string; values: Filters };
  const savedLimit = 20;
  let savedFilters = $state.raw<readonly SavedFilter[]>([]);
  let selectedFilter = $state("");
  let savedMenuOpen = $state(false);
  const sortedSavedFilters = $derived([...savedFilters].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let editingName = $state(false);
  let draftName = $state("");
  let nameInput: HTMLInputElement | undefined = $state();
  let pending = $state<PendingFilter | null>(null);
  let saveError = $state("");
  let filter = $state.raw<{ owner: number; values: Filters } | null>(null);
  const values = $derived(filter?.values ?? defaults);
  const ranges = $derived({ minPrice: values.minPrice, maxPrice: values.maxPrice, minCount: values.minCount, maxCount: values.maxCount });
  const selectedItem = $derived(values.item);
  const isBlueprint = $derived((selectedItem?.key === "category_id" ? selectedItem.id : selectedItem?.categoryID) === 9);
  const isDefault = $derived(!selectedItem && !values.system && !values.metaGroup && !values.blueprintType &&
    ranges.minPrice === 0 && ranges.maxPrice === 0 && ranges.minCount === 8 && ranges.maxCount === 512);
  const storageKey = (owner: number) => `evejs.hypernet.ranges.${owner}`;
  const savedKey = (owner: number) => `evejs.hypernet.browse-saved.${owner}`;

  function restoreFilters(saved: Partial<Filters> | null): Filters {
    if (!saved) return defaults;
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

  function loadSavedFilters(owner: number): readonly SavedFilter[] {
    try {
      const entries: unknown = JSON.parse(localStorage.getItem(savedKey(owner)) ?? "[]");
      if (!Array.isArray(entries)) return [];
      const filters = new Map<string, Filters>();
      for (const entry of entries) {
        if (typeof entry?.name === "string" && entry.name.trim() && entry.name.length <= 100 &&
            entry.values && typeof entry.values === "object" && !Array.isArray(entry.values)) {
          filters.set(entry.name, restoreFilters(entry.values));
          if (filters.size === savedLimit) break;
        }
      }
      return [...filters].map(([name, values]) => ({ name, values }));
    } catch {
      return [];
    }
  }

  function persistSaved(next: readonly SavedFilter[]) {
    if (!pilot) return;
    savedFilters = next;
    try { localStorage.setItem(savedKey(pilot), JSON.stringify(next)); } catch { /* keep the filters for this window */ }
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

  async function startSaving() {
    if (savedFilters.length >= savedLimit) {
      saveError = "You can save up to 20 filters.";
      return;
    }
    saveError = "";
    pending = null;
    savedMenuOpen = false;
    draftName = "";
    editingName = true;
    await tick();
    nameInput?.focus();
  }

  function saveNamed(name: string, snapshot: Filters) {
    persistSaved([...savedFilters.filter(entry => entry.name !== name), { name, values: snapshot }]);
    selectedFilter = sameFilters(values, snapshot) ? name : "";
  }

  function submitName(event: SubmitEvent) {
    event.preventDefault();
    const name = draftName.trim();
    if (!name || isDefault) return;
    editingName = false;
    if (savedFilters.some(entry => entry.name === name)) pending = { kind: "replace", name, values };
    else saveNamed(name, values);
  }

  function confirmSavedChange() {
    const change = pending;
    pending = null;
    if (!change) return;
    if (change.kind === "replace") {
      saveNamed(change.name, change.values);
    } else {
      persistSaved(savedFilters.filter(entry => entry.name !== change.name));
      if (selectedFilter === change.name) selectedFilter = "";
      if (!savedFilters.length) savedMenuOpen = false;
      saveError = "";
    }
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
    const saved = owner ? loadSavedFilters(owner) : [];
    filter = owner ? { owner, values: restored } : null;
    savedFilters = saved;
    selectedFilter = saved.find(entry => sameFilters(entry.values, restored))?.name ?? "";
    savedMenuOpen = false;
    editingName = false;
    pending = null;
    saveError = "";
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
      <fieldset class="saved-filters">
        <legend>{word("savedFilters")}</legend>
        <button type="button" data-saved-selection aria-expanded={savedMenuOpen} disabled={!savedFilters.length}
          title={savedFilters.length ? undefined : word("noSavedFilters")}
          onclick={() => { savedMenuOpen = !savedMenuOpen; }}>{selectedFilter || word("noFilter")}</button>
        <button type="button" data-save-filter disabled={!pilot || isDefault} onclick={startSaving}>{word("saveFilter")}</button>
        {#if savedMenuOpen}
          <ul class="saved-options">
            {#each sortedSavedFilters as entry (entry.name)}
              <li>
                <button type="button" data-apply-saved={entry.name} aria-pressed={selectedFilter === entry.name}
                  onclick={() => {
                    search = "";
                    systemSearch = "";
                    savedMenuOpen = false;
                    applyFilters(entry.values, entry.name);
                  }}>{entry.name}</button>
                <button type="button" data-delete-saved={entry.name} aria-label={`${word("deleteFilter")} ${entry.name}`}
                  onclick={() => { editingName = false; pending = { kind: "delete", name: entry.name }; }}>{word("deleteFilter")}</button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if editingName}
          <form aria-label={word("filterNameCaption")} onsubmit={submitName}>
            <label>{word("filterName")} <input bind:this={nameInput} bind:value={draftName} maxlength={100} required /></label>
            <button type="submit" disabled={!draftName.trim() || isDefault}>{word("save")}</button>
            <button type="button" onclick={() => { editingName = false; }}>{word("cancel")}</button>
          </form>
        {/if}
        {#if pending}
          <div class="saved-confirm">
            <p>{pending.kind === "replace" ? `Replace the saved filter “${pending.name}”?` : `Delete the saved filter “${pending.name}”?`}</p>
            <button type="button" onclick={confirmSavedChange}>{word("yes")}</button>
            <button type="button" onclick={() => { pending = null; }}>{word("no")}</button>
          </div>
        {/if}
        {#if saveError}<p role="status">{saveError}</p>{/if}
      </fieldset>
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
  .meta-group { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
  .saved-filters { align-items: center; }
  .saved-options, .saved-filters form, .saved-confirm { width: 100%; }
  .saved-options { grid-template-columns: 1fr; }
  .saved-options li, .saved-filters form, .saved-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .saved-options li { justify-content: space-between; }
  small { color: #b8c3cc; margin-inline-start: 4px; }
  ul { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 245px), 1fr)); gap: 8px; padding: 0; margin: 0; list-style: none; }
  li { display: grid; gap: 8px; padding: 8px; background: #ffffff08; }
  .item { display: flex; align-items: center; gap: 8px; text-align: start; }
  img { width: 32px; height: 32px; object-fit: contain; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 4px; }
  dl, dd, p { margin: 0; }
  time { color: #b8c3cc; }
</style>
