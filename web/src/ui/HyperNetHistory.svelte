<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { hyperNetCountBounds, hyperNetPriceBounds, isHyperNetItem, type HyperNetHistoryOffer, type HyperNetItem, type HyperNetParticipation } from "../bridge/hyperNet.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import OwnerPicture from "./OwnerPicture.svelte";
  import HyperNetFilterSearch from "./HyperNetFilterSearch.svelte";
  import { portraitDefaultPath, portraitUrl } from "./ownerImages.ts";
  import { showInfo } from "./showInfo.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { typeIconUrl } from "./typeIcons.ts";

  let { store, flow, pilot }: { store: ClientStore; flow: AppFlow; pilot: number | undefined } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const imageServer = $derived(flow.imageServer);
  const labels = {
    heading: ["UI/HyperNet/PageTitleHistory", "Your HyperNet Relay participation history"],
    empty: ["UI/Common/NoDataAvailable", "No Data Available"],
    expired: ["UI/HyperNet/CardExpired", "Expired"],
    winner: ["UI/HyperNet/CardWinner", "Winner"],
    created: ["UI/HyperNet/CreatedByPlayerHint", "Created by you"],
    joined: ["UI/HyperNet/FilterJoined", "Joined"],
    price: ["UI/HyperNet/TicketPrice", "HyperNode price"],
    count: ["UI/HyperNet/TicketCountLabel", "HyperNode count"],
    retry: ["UI/HyperNet/Refresh", "Refresh"],
    totalCreated: ["UI/HyperNet/Created", "{amount} Created"],
    completed: ["UI/HyperNet/Completed", "{amount} Completed"],
    active: ["UI/HyperNet/Active", "{amount} Active"],
    totalJoined: ["UI/HyperNet/Joined", "{amount} Joined"],
    won: ["UI/HyperNet/Won", "{amount} Won"],
    sort: ["UI/Common/SortBy", "Sort By"],
    sortDirection: ["UI/HyperNet/SortDirection", "Sort direction"],
    default: ["UI/HyperNet/SortDefault", "Default"],
    item_name: ["UI/HyperNet/SortItemName", "Item name"],
    ticket_count: ["UI/HyperNet/TicketCountLabel", "HyperNode count"],
    ticket_price: ["UI/HyperNet/TicketPrice", "HyperNode price"],
    total_price: ["UI/HyperNet/TotalPrice", "Total price"],
    end_time: ["UI/HyperNet/SortEndTime", "End time"],
    reset: ["UI/HyperNet/Reset", "Reset"],
    filters: ["UI/Calendar/CalendarWindow/Filters", "Filters"],
    show_joined: ["UI/HyperNet/ShowJoined", "Joined"],
    show_created: ["UI/HyperNet/ShowCreated", "Created"],
    show_active: ["UI/HyperNet/ShowActive", "Active"],
    show_finished: ["UI/HyperNet/ShowFinished", "Finished"],
    show_public: ["UI/HyperNet/ShowPublic", "Public"],
    show_private: ["UI/HyperNet/ShowPrivate", "Private"],
    showing: ["UI/HyperNet/ShowingFiltered", "Showing {filtered_count}/{total_count}"],
    minimum: ["UI/Common/Minimum", "Minimum"],
    maximum: ["UI/Common/Maximum", "Maximum"],
    any: ["UI/Common/Any", "Any"],
    item: ["UI/HyperNet/FilterItemLabel", "Item"],
    location: ["UI/HyperNet/FilterLocationLabel", "Solar system"],
    metaGroup: ["UI/HyperNet/FilterMetaGroupLabel", "Meta group"],
    blueprint: ["UI/HyperNet/FilterBlueprintLabel", "Blueprint type"],
    type_id: ["UI/Common/Type", "Type"],
    group_id: ["UI/Common/Group", "Group"],
    category_id: ["UI/Common/Category", "Category"],
    clear: ["UI/Common/Clear", "Clear"],
    all: ["UI/Common/All", "All"],
    blueprintAll: ["UI/Generic/All", "All"],
    blueprintOriginal: ["UI/Generic/Original", "Original"],
    blueprintCopy: ["UI/Generic/Copy", "Copy"],
  } as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const stat = (key: keyof typeof labels, amount: number) =>
    plainText(formatTemplate($words.templates[labels[key][0]] ?? labels[key][1], { amount }, { nameOf: () => "" }));
  let history = $state.raw<readonly HyperNetHistoryOffer[]>([]);
  let participation = $state.raw<HyperNetParticipation | null>(null);
  let participationError = $state("");
  const active = $derived(history.filter(record => record.status < 7));
  const createdActive = $derived(active.filter(record => record.ownerID === pilot).length);
  const joinedActive = $derived(active.filter(record => record.joined).length);
  let loading = $state(true);
  let error = $state("");
  let refresh = $state(0);
  const facetGroups = [
    ["show_joined", "show_created"], ["show_active", "show_finished"], ["show_public", "show_private"],
  ] as const;
  type Option = { readonly id: number; readonly name: string };
  const defaultFilters = {
    show_joined: true, show_created: true, show_active: true, show_finished: true, show_public: true, show_private: true,
    minPrice: 0, maxPrice: 0, minCount: 8, maxCount: 512,
    item: undefined as HyperNetItem | undefined,
    system: undefined as Option | undefined,
    metaGroup: 0,
    blueprintType: 0 as 0 | 1 | 2,
  };
  type Filters = typeof defaultFilters;
  const ranges = [
    { label: "price", min: "minPrice", max: "maxPrice", price: true, bounds: [0, ...hyperNetPriceBounds] },
    { label: "count", min: "minCount", max: "maxCount", price: false, bounds: hyperNetCountBounds },
  ] as const;
  let filters = $state.raw<Filters>(defaultFilters);
  let metaGroups = $state.raw<readonly Option[]>([]);
  let metaError = $state("");
  const isBlueprint = (item: HyperNetItem | undefined) => (item?.key === "category_id" ? item.id : item?.categoryID) === 9;
  const findItems = (text: string) => flow.searchHyperNetItems(text);
  const findSystems = async (text: string): Promise<readonly Option[]> =>
    (await flow.searchDestinations(text, "system")).map(({ id, name }) => ({ id, name }));
  const filtersChanged = $derived(Object.keys(defaultFilters).some(key =>
    filters[key as keyof Filters] !== defaultFilters[key as keyof Filters]));
  const filterStorage = (owner: number) => `evejs.hypernet.history-filters.${owner}`;
  function restoreFilters(owner: number): Filters {
    const restored = { ...defaultFilters };
    try {
      const saved: Partial<Filters> | null = JSON.parse(localStorage.getItem(filterStorage(owner)) ?? "null");
      if (!saved) return restored;
      for (const key of facetGroups.flat()) {
        if (typeof saved[key] === "boolean") restored[key] = saved[key];
      }
      for (const { min, max, bounds } of ranges) {
        const low = saved[min], high = saved[max];
        if (typeof low === "number" && typeof high === "number" &&
            bounds.some(bound => bound === low) && bounds.some(bound => bound === high) && (!high || low <= high)) {
          restored[min] = low;
          restored[max] = high;
        }
      }
      restored.item = isHyperNetItem(saved.item) ? saved.item : undefined;
      const system = saved.system;
      if (system && Number.isSafeInteger(system.id) && system.id > 0 && typeof system.name === "string" && system.name) {
        restored.system = system;
      }
      if (typeof saved.metaGroup === "number" && Number.isSafeInteger(saved.metaGroup) && saved.metaGroup > 0) {
        restored.metaGroup = saved.metaGroup;
      }
      if (saved.blueprintType === 1 || saved.blueprintType === 2) restored.blueprintType = saved.blueprintType;
    } catch { /* use default filters */ }
    return restored;
  }
  function setFilters(next: Filters) {
    filters = next;
    if (pilot) {
      try { localStorage.setItem(filterStorage(pilot), JSON.stringify(next)); } catch { /* keep the window selection */ }
    }
  }
  function matchesFilters(record: HyperNetHistoryOffer, owner: number | undefined, criteria: Filters): boolean {
    if (!(record.ownerID === owner ? criteria.show_created : criteria.show_joined) ||
        !(record.status < 7 ? criteria.show_active : criteria.show_finished) ||
        !(record.private ? criteria.show_private : criteria.show_public)) return false;
    const item = criteria.item;
    if (item) {
      const id = item.key === "type_id" ? record.typeID : item.key === "group_id" ? record.groupID : record.categoryID;
      if (id !== item.id) return false;
      // The native History controller returns the subtype match before checking location, meta group, or ranges.
      if (isBlueprint(item) && criteria.blueprintType) return record.copy === (criteria.blueprintType === 2);
    }
    return (!criteria.system || record.systemID === criteria.system.id) &&
      (!criteria.metaGroup || record.metaGroupID === criteria.metaGroup) &&
      (!criteria.minPrice || record.price >= BigInt(criteria.minPrice)) &&
      (!criteria.maxPrice || record.price <= BigInt(criteria.maxPrice)) &&
      (criteria.minCount === defaultFilters.minCount || record.tickets >= criteria.minCount) &&
      (criteria.maxCount === defaultFilters.maxCount || record.tickets <= criteria.maxCount);
  }
  const sortKeys = ["default", "item_name", "ticket_count", "ticket_price", "total_price", "end_time"] as const;
  type SortKey = typeof sortKeys[number];
  let sorting = $state<{ key: SortKey; descending: boolean }>({ key: "default", descending: false });
  const sortStorage = (owner: number) => `evejs.hypernet.history-sort.${owner}`;
  function isSortKey(value: unknown): value is SortKey {
    return sortKeys.some(key => key === value);
  }
  function setSort(key: SortKey, descending = key !== "default" && key !== "item_name") {
    sorting = { key, descending };
    if (pilot) {
      try { localStorage.setItem(sortStorage(pilot), JSON.stringify({ key, descending })); } catch { /* keep the window selection */ }
    }
  }
  $effect(() => {
    const owner = pilot;
    filters = owner ? restoreFilters(owner) : defaultFilters;
    let saved: { key?: unknown; descending?: unknown } | null = null;
    if (owner) {
      try { saved = JSON.parse(localStorage.getItem(sortStorage(owner)) ?? "null"); } catch { /* use default sorting */ }
    }
    sorting = saved && isSortKey(saved.key) && typeof saved.descending === "boolean"
      ? { key: saved.key, descending: saved.key !== "default" && saved.descending }
      : { key: "default", descending: false };
  });

  const nameOf = (record: HyperNetHistoryOffer) =>
    resolvedName($names.resolved, "type", record.typeID, String(record.typeID));
  const endTime = (record: HyperNetHistoryOffer) => record.ended ?? record.expires;
  function compare<T extends string | bigint>(a: T, b: T): number {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  function compareBy(key: Exclude<SortKey, "default">, a: HyperNetHistoryOffer, b: HyperNetHistoryOffer): number {
    switch (key) {
      case "item_name": return compare(nameOf(a), nameOf(b));
      case "ticket_count": return a.tickets - b.tickets;
      case "ticket_price": return compare(a.price, b.price);
      case "total_price": return compare(a.price * BigInt(a.tickets), b.price * BigInt(b.tickets));
      case "end_time": return endTime(a) - endTime(b);
    }
  }
  const rank = (record: HyperNetHistoryOffer, owner: number | undefined) =>
    record.status === 7 && record.winnerID === owner ? 0 : record.status < 7 ? 1 : 2;
  const rows = $derived(history.filter(row => matchesFilters(row, pilot, filters)).sort((a, b) => {
    if (sorting.key !== "default") {
      return compareBy(sorting.key, a, b) * (sorting.descending ? -1 : 1) || b.runningID - a.runningID;
    }
    const group = rank(a, pilot);
    const order = group - rank(b, pilot);
    return order || (group < 2 ? compare(nameOf(a), nameOf(b)) : endTime(b) - endTime(a)) || b.runningID - a.runningID;
  }));

  onMount(() => {
    flow.requestWords(Object.values(labels).map(([path]) => path));
    let current = true;
    void flow.loadHyperNetMetaGroups().then(groups => {
      if (current) metaGroups = groups;
    }, cause => {
      if (current) metaError = panelErrorWords(cause);
    });
    return () => { current = false; };
  });

  $effect(() => {
    const owner = pilot;
    void refresh;
    history = [];
    participation = null;
    participationError = "";
    error = "";
    loading = !!owner;
    if (!owner) return;
    let current = true;
    void flow.loadHyperNetParticipation().then(stats => {
      if (current) participation = stats;
    }, cause => {
      if (current) participationError = panelErrorWords(cause);
    });
    void flow.loadHyperNetHistory().then(records => {
      if (!current) return;
      history = records;
      flow.requestNames(records.flatMap(row => [
        { kind: "type", id: row.typeID },
        { kind: "station", id: row.locationID },
        { kind: "system", id: row.systemID },
        ...(row.winnerID ? [{ kind: "character" as const, id: row.winnerID }] : []),
      ]));
    }, cause => {
      if (current) error = panelErrorWords(cause);
    }).finally(() => {
      if (current) loading = false;
    });
    return () => { current = false; };
  });
</script>

<section class="hypernet-history" aria-label={word("heading")}>
  <h2>{word("heading")}</h2>
  {#if participation && pilot && !loading && !error}
    <div class="participation">
      <OwnerPicture name={resolvedName($names.resolved, "character", pilot, "")}
        urls={[portraitUrl($imageServer, pilot, 128), clientTexture(portraitDefaultPath(128))].filter((url): url is string => url !== null)}
        size={64} />
      <div>
        <p data-history-stat="created">{stat("totalCreated", participation.created)}</p>
        <p data-history-stat="completed">{stat("completed", participation.completed)}</p>
        <p data-history-stat="created-active">{stat("active", createdActive)}</p>
      </div>
      <div>
        <p data-history-stat="joined">{stat("totalJoined", participation.joined)}</p>
        <p data-history-stat="won">{stat("won", participation.won)}</p>
        <p data-history-stat="joined-active">{stat("active", joinedActive)}</p>
      </div>
    </div>
  {:else if participationError && !error}
    <div class="participation">
      <p role="alert">{participationError}</p>
      <button type="button" onclick={() => { refresh++; }}>{word("retry")}</button>
    </div>
  {/if}
  <div class="sorting">
    <label>{word("sort")}
      <select data-history-sort value={sorting.key} onchange={event => {
        const key = event.currentTarget.value;
        if (isSortKey(key)) setSort(key);
      }}>
        {#each sortKeys as key (key)}
          <option value={key}>{word(key)}</option>
        {/each}
      </select>
    </label>
    <button type="button" data-history-direction disabled={sorting.key === "default"} title={word("sortDirection")}
      aria-label={`${word("sortDirection")}, ${sorting.descending ? "descending" : "ascending"}`}
      onclick={() => setSort(sorting.key, !sorting.descending)}>
      <img alt="" src={clientTexture(`res:/UI/Texture/classes/HyperNet/sort_${sorting.descending ? "descending" : "ascending"}.png`)} />
    </button>
    <button type="button" data-history-reset-sort disabled={sorting.key === "default" && !filtersChanged}
      onclick={() => { setSort("default"); setFilters(defaultFilters); }}>{word("reset")}</button>
  </div>
  <details class="history-filters">
    <summary>{word("filters")}</summary>
    <HyperNetFilterSearch label={word("item")} clear={word("clear")} selected={filters.item}
      load={findItems} choiceKey={item => `${item.key}:${item.id}`} detail={item => word(item.key)}
      choose={item => setFilters({ ...filters, item })} />
    {#if isBlueprint(filters.item)}
      <label class="criteria">{word("blueprint")}
        <select data-history-blueprint value={filters.blueprintType} onchange={event => {
          const subtype = Number(event.currentTarget.value);
          setFilters({ ...filters, blueprintType: subtype === 1 || subtype === 2 ? subtype : 0 });
        }}>
          <option value={0}>{word("blueprintAll")}</option>
          <option value={1}>{word("blueprintOriginal")}</option>
          <option value={2}>{word("blueprintCopy")}</option>
        </select>
      </label>
    {/if}
    <HyperNetFilterSearch label={word("location")} clear={word("clear")} selected={filters.system}
      load={findSystems} choiceKey={system => system.id} choose={system => setFilters({ ...filters, system })} />
    <label class="criteria">{word("metaGroup")}
      <select data-history-meta-group value={filters.metaGroup} disabled={!metaGroups.length}
        onchange={event => setFilters({ ...filters, metaGroup: Number(event.currentTarget.value) })}>
        <option value={0}>{word("all")}</option>
        {#each metaGroups as group (group.id)}
          <option value={group.id}>{group.name}</option>
        {/each}
      </select>
    </label>
    {#if metaError}<p role="alert">{metaError}</p>{/if}
    {#each facetGroups as pair (pair[0])}
      <div class="filter-pair">
        {#each pair as key (key)}
          <label><input type="checkbox" data-history-facet={key} checked={filters[key]}
            onchange={event => setFilters({ ...filters, [key]: event.currentTarget.checked })} /> {word(key)}</label>
        {/each}
      </div>
    {/each}
    {#each ranges as range (range.min)}
      <fieldset>
        <legend>{word(range.label)}</legend>
        <label>{word("minimum")}
          <select data-history-range={range.min} value={filters[range.min]}
            onchange={event => setFilters({ ...filters, [range.min]: Number(event.currentTarget.value) })}>
            {#each range.bounds as bound (bound)}
              <option value={bound} disabled={!!filters[range.max] && bound > filters[range.max]}>
                {bound === 0 ? word("any") : range.price ? `${bound.toLocaleString()} ISK` : bound}
              </option>
            {/each}
          </select>
        </label>
        <label>{word("maximum")}
          <select data-history-range={range.max} value={filters[range.max]}
            onchange={event => setFilters({ ...filters, [range.max]: Number(event.currentTarget.value) })}>
            {#each range.bounds as bound (bound)}
              <option value={bound} disabled={bound !== 0 && bound < filters[range.min]}>
                {bound === 0 ? word("any") : range.price ? `${bound.toLocaleString()} ISK` : bound}
              </option>
            {/each}
          </select>
        </label>
      </fieldset>
    {/each}
  </details>
  {#if !loading && !error && rows.length < history.length}
    <p role="status" data-history-filter-count>
      {plainText(formatTemplate($words.templates[labels.showing[0]] ?? labels.showing[1],
        { filtered_count: rows.length, total_count: history.length }, { nameOf: () => "" }))}
    </p>
  {/if}
  {#if loading}
    <p role="status">Loading HyperNet history…</p>
  {:else if error}
    <p role="alert">{error}</p>
    <button type="button" onclick={() => { refresh++; }}>{word("retry")}</button>
  {:else if !rows.length}
    <p role="status">{word("empty")}</p>
  {:else}
    <ul>
      {#each rows as row (row.id)}
        <li data-history-id={row.id} data-history-status={row.status}>
          <button class="item" type="button" onclick={() => showInfo({ kind: "type", typeID: row.typeID })}>
            <img src={typeIconUrl(row.typeID)} alt="" />
            {resolvedName($names.resolved, "type", row.typeID, String(row.typeID))}
          </button>
          <span>{row.ownerID === pilot ? word("created") : word("joined")}</span>
          <span>{resolvedName($names.resolved, "system", row.systemID, String(row.systemID))}
            · {resolvedName($names.resolved, "station", row.locationID, String(row.locationID))}</span>
          <dl>
            <dt>{word("price")}</dt><dd>{row.price.toLocaleString()} ISK</dd>
            <dt>{word("count")}</dt><dd>{row.status < 7 ? `${row.remaining}/${row.tickets}` : row.tickets}</dd>
          </dl>
          <span>
            {#if row.status < 7}Active
            {:else if row.winnerID}{word("winner")} · {resolvedName($names.resolved, "character", row.winnerID, String(row.winnerID))}
            {:else}{word("expired")}{/if}
          </span>
          <time datetime={new Date(endTime(row)).toISOString()}>
            {new Date(endTime(row)).toLocaleString()}
          </time>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .hypernet-history { display: grid; gap: 10px; }
  .participation { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 24px; padding: 10px; background: #ffffff08; }
  .participation > div { display: grid; gap: 4px; min-width: 90px; }
  .participation p:first-child { font-weight: 600; }
  .sorting, .sorting label { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .sorting button img { width: 16px; height: 16px; }
  .history-filters summary { cursor: pointer; }
  .filter-pair, .history-filters fieldset { display: flex; flex-wrap: wrap; gap: 8px 16px; margin: 6px 0; }
  .filter-pair label { min-width: 120px; }
  .criteria { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
  h2, ul, dl, dd, p { margin: 0; }
  ul { list-style: none; padding: 0; display: grid; gap: 6px; }
  li { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 135px), 1fr)); align-items: center; gap: 8px; padding: 8px; background: #ffffff08; }
  .item { display: flex; align-items: center; gap: 6px; text-align: start; }
  img { width: 32px; height: 32px; object-fit: contain; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 2px 6px; }
  time { color: #b8c3cc; }
</style>
