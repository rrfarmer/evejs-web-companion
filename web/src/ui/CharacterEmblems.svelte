<script lang="ts">
  import { onMount } from "svelte";
  import { isSessionLost, type AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { loadShipEmblemCatalog, SHIP_EMBLEM_TYPES, SHIP_ENTITLEMENT_GATEWAY, type ReleasedShipEmblem, type ShipEmblemKind } from "../bridge/shipEmblems.ts";
  import { ContextMenu } from "../play/contextMenu.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";
  import { showMarketDetails } from "./marketDetails.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const names = $derived(store.names);
  const words = $derived(store.words);
  const prefix = "UI/CharacterSheet/CharacterSheetWindow/ShipEmblems/";
  const options = [
    { value: "all", label: prefix + "ShowAllEmblems", fallback: "Show all emblems" },
    { value: "owned", label: prefix + "ShowOwnedEmblems", fallback: "Only show my emblems" },
    { value: "unowned", label: prefix + "ShowNotOwnedEmblems", fallback: "Only show the emblems I don't have" },
  ] as const;
  const categories = [
    { kind: "corporation", label: "UI/ShipCosmetics/CorporationEmblems", fallback: "Corporation Emblems", icon: "corp_logo_24px.png" },
    { kind: "alliance", label: "UI/ShipCosmetics/AllianceEmblems", fallback: "Alliance Emblems", icon: "alliance_logo_24px.png" },
  ] as const;
  const labels = {
    counter: prefix + "YouHaveNumShipEmblems", group: prefix + "EmblemsGroupWithCount", acquired: prefix + "ShipEmblemAcquired",
    failed: prefix + "FetchLicensesFailedErrorMessage", failedDetail: prefix + "FetchLicensesFailedErrorSubtext",
    retry: prefix + "FetchingFailedButton", filter: "UI/Inventory/Filter", empty: "UI/SkillQueue/NoResultsForFilters",
    info: "UI/Commands/ShowInfo", market: "UI/Inventory/ItemActions/ViewTypesMarketDetails",
  };
  type Mode = typeof options[number]["value"];
  let mode = $state<Mode>("all");
  let query = $state("");
  let rows = $state.raw<readonly ReleasedShipEmblem[]>([]);
  let ownership = $state.raw<ReadonlyMap<number, ReadonlySet<ShipEmblemKind>>>(new Map());
  let open = $state<Record<ShipEmblemKind, boolean>>({ corporation: false, alliance: false });
  let loading = $state(true);
  let failed = $state(false);
  let revision = 0;
  const menu = new ContextMenu();
  const preference = () => `evejs.user.${store.session.get().accountID}.characterSheetEmblems`;

  const word = (label: string, fallback: string, args: TemplateArguments = {}) =>
    plainText(formatTemplate($words.templates[label] || fallback, args, { nameOf: () => "" }));
  const nameOf = (id: number) => resolvedName($names.resolved, "type", id, "Unknown ship");
  const hasEmblem = (id: number, kind: ShipEmblemKind) => ownership.get(id)?.has(kind) === true;
  const ownedCount = $derived([...ownership.values()].reduce((count, kinds) => count + kinds.size, 0));
  const groups = $derived.by(() => {
    const filter = query.trim().toLowerCase();
    return categories.map(category => {
      const hulls = rows.flatMap(([id, kind, , licenseTypeID]) => {
        if (kind !== SHIP_EMBLEM_TYPES[category.kind]) return [];
        const owned = hasEmblem(id, category.kind);
        if (mode !== "all" && owned !== (mode === "owned")) return [];
        const label = nameOf(id);
        const searchName = resolvedName($names.resolved, "type", licenseTypeID, label);
        return searchName.toLowerCase().includes(filter) ? [{ id, label, owned }] : [];
      }).sort((a, b) => a.label < b.label ? -1 : Number(a.label > b.label));
      return { ...category, hulls };
    }).filter(group => group.hulls.length);
  });

  async function load() {
    const request = ++revision;
    try {
      const [catalog, owned] = await Promise.all([loadShipEmblemCatalog(), flow.loadOwnedShipEmblems()]);
      if (request !== revision) return;
      rows = catalog;
      ownership = owned;
      failed = false;
      const types = new Set<number>();
      for (const [shipTypeID, , , licenseTypeID] of catalog) {
        types.add(shipTypeID);
        if (licenseTypeID) types.add(licenseTypeID);
      }
      flow.requestNames([...types].map(id => ({ kind: "type", id })));
    } catch (cause) {
      if (request === revision && !isSessionLost(cause)) failed = true;
    } finally {
      if (request === revision) loading = false;
    }
  }

  function chooseMode(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    const wanted = options.find(option => option.value === value);
    if (!wanted) return;
    mode = wanted.value;
    localStorage.setItem(preference(), mode);
  }

  function openMenu(typeID: number, x: number, y: number) {
    menu.open(x, y, [
      { label: word(labels.info, "Show Info"), run: () => showInfo({ kind: "type", typeID }) },
      { label: word(labels.market, "View Market Details"), run: () => showMarketDetails(typeID) },
    ]);
  }

  onMount(() => {
    const saved = localStorage.getItem(preference());
    mode = options.find(option => option.value === saved)?.value ?? "all";
    flow.requestWords([...Object.values(labels), ...options.map(row => row.label), ...categories.map(row => row.label)]);
    void load();
    const notices = flow.gatewayNotices;
    let previous = notices.get();
    const stop = notices.subscribe(notice => {
      if (notice === previous) return;
      previous = notice;
      const family = SHIP_ENTITLEMENT_GATEWAY + "ship.";
      if (notice?.typeName.startsWith(family) && /^(corp|alliance)logo\.(Granted|Revoked)Notice$/.test(notice.typeName.slice(family.length))) {
        void load();
      }
    });
    return () => { stop(); revision++; menu.close(); };
  });
</script>

<section class="collection" aria-label="Emblems" data-character-emblems>
  <div class="controls">
    <label>Show emblems <select value={mode} onchange={chooseMode}>
      {#each options as option (option.value)}<option value={option.value}>{word(option.label, option.fallback)}</option>{/each}
    </select></label>
    {#if !loading && !failed}<span data-emblem-counter={ownedCount}>
      {word(labels.counter, `You have {[numeric]numEmblems} ship emblem${ownedCount === 1 ? "" : "s"}`, { numEmblems: ownedCount })}
    </span>{/if}
    <input type="search" aria-label={word(labels.filter, "Filter")} placeholder={word(labels.filter, "Filter")} bind:value={query} />
  </div>
  {#if loading}<p role="status">Loading emblems…</p>
  {:else if failed}
    <div role="alert"><strong>{word(labels.failed, "Could not fetch emblem licenses")}</strong>
      <p>{word(labels.failedDetail, "Your emblem licenses are temporarily unavailable.")}</p></div>
    <button type="button" onclick={() => { loading = true; void load(); }}>{word(labels.retry, "Retry")}</button>
  {:else if !groups.length}<p>{word(labels.empty, "No results for filters")}</p>
  {:else}
    {#each groups as group (group.kind)}
      {@const groupName = word(group.label, group.fallback)}
      <div data-emblem-group={group.kind}>
        <button type="button" class="group" aria-expanded={open[group.kind]} onclick={() => (open[group.kind] = !open[group.kind])}>
          <img src={clientTexture(`res:/UI/Texture/classes/Fitting/Cosmetics/${group.icon}`)} alt="" />
          {word(labels.group, "{groupName} [{emblemsOwned}/{emblemsTotal}]", { groupName,
            emblemsOwned: group.hulls.filter(row => row.owned).length, emblemsTotal: group.hulls.length })}
        </button>
        {#if open[group.kind]}
          <ul>
            {#each group.hulls as hull (hull.id)}
              <li data-emblem-hull={hull.id} data-emblem-owned={hull.owned}>
                <button type="button" class:unowned={!hull.owned} onclick={() => showInfo({ kind: "type", typeID: hull.id })}
                  oncontextmenu={event => { event.preventDefault(); openMenu(hull.id, event.clientX, event.clientY); }}
                  onkeydown={event => {
                    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                    event.preventDefault();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    openMenu(hull.id, bounds.left, bounds.bottom);
                  }}><TypeIcon typeID={hull.id} name={hull.label} />{hull.label}</button>
                {#if hull.owned}<span>{word(labels.acquired, "Acquired")}</span>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/each}
  {/if}
</section>

<style>
  .collection { padding: 12px 14px; }
  .controls, li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .controls { justify-content: space-between; margin-bottom: 12px; }
  .group, li button { display: flex; align-items: center; gap: 6px; text-align: left; }
  .group { width: 100%; margin: 2px 0; }
  .group img { width: 24px; height: 24px; }
  ul { display: grid; gap: 4px; padding: 4px 0 8px 18px; margin: 0; }
  li .unowned { opacity: .55; }
  li span { margin-inline-start: auto; }
</style>
