<script lang="ts">
  // The active ship's inventory window in space, laid out as the 3698585 client's ActiveShipCargo (invWindow.Inventory,
  // 600 x 450): the tree at the left (TREE_DEFAULT_WIDTH 160) with the ship as "<name> (<type>)" - its cargo - and its
  // other bays under it, My filters at its foot; at the right the top row (Stack All, the view mode and sort buttons, the
  // capacity gauge, the quick filter), the items (InvItem in icons view: a 64 px icon, its quantity at the bottom right
  // on black, the name under it in two lines at most; "Nothing Found" where none), and the foot's "<n> Items" and
  // "<isk> ISK Est. price" (UpdateNumberOfItems, UpdateIskPriceLabel).
  import { onMount, untrack } from "svelte";
  import TypeIcon from "./TypeIcon.svelte";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { shipHoldTarget } from "./shipHold.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import { SHIP_HOLDS, CARGO_HOLD } from "../bridge/shipHolds.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const mining = store.mining;
  // svelte-ignore state_referenced_locally
  const drones = store.drones;
  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const fitting = store.fitting;

  const WORDS = ["UI/Inventory/NumItems2", "UI/Inventory/EstIskPrice2", "UI/Inventory/StackAll", "UI/Common/SortBy", "UI/Inventory/ViewMode",
    "UI/Inventory/Filters/MyFilters", "UI/Common/NothingFound", ...SHIP_HOLDS.map((h) => h.label), CARGO_HOLD.label];
  flow.requestWords(WORDS);
  const word = (label: string, own: string, args: Record<string, string | number> = {}) => {
    const t = $words.templates[label];
    return typeof t === "string" && t !== "" ? plainText(formatTemplate(t, args, { nameOf: () => "" })).trim() : own;
  };

  /** ShipBay controllers' icons (invControllers iconName), by the bays' keys. */
  const BAY_ICON: Record<string, string> = {
    drone: "res:/UI/Texture/WindowIcons/dronebay.png", fighter: "res:/UI/Texture/WindowIcons/dronebay.png", fuel: "res:/UI/Texture/WindowIcons/fuelbay.png",
    ore: "res:/UI/Texture/WindowIcons/orehold.png", asteroid: "res:/UI/Texture/WindowIcons/orehold.png", ice: "res:/UI/Texture/WindowIcons/icehold.png",
    gas: "res:/UI/Texture/WindowIcons/gashold.png",
  };

  onMount(() => {
    void flow.loadMiningHolds().catch(() => {});
    if (!$drones.loaded) void flow.loadDrones().catch(() => {});
  });

  const ship = $derived($space.snapshot?.ship ?? null);
  const typeName = (typeID: number | null) => resolvedName($names.resolved, "type", typeID, "");
  /** The ship's bays the hull has: its cargo (the ship node itself), then the others, the drone bay where it has one. */
  interface Bay { key: string; label: string; items: { itemID: number; typeID: number; quantity: number; singleton: boolean }[] | null; capacity: number | null; used: number | null }
  const droneBayCapacity = $derived(($fitting.shipAttributes?.[283] as number | undefined) ?? null);
  const bays = $derived.by((): Bay[] => {
    const out: Bay[] = [];
    for (const h of $mining.holds) {
      if (!h.present) continue;
      const def = h.key === "cargo" ? CARGO_HOLD : SHIP_HOLDS.find((d) => d.bayKey === h.key);
      out.push({ key: h.key, label: def ? word(def.label, h.label) : h.label,
        items: h.items?.map((i) => ({ itemID: i.itemID, typeID: i.typeID, quantity: i.quantity, singleton: false })) ?? null,
        capacity: h.capacity?.capacity ?? null, used: h.capacity?.used ?? null });
    }
    if ((droneBayCapacity ?? 0) > 0 || ($drones.bay?.length ?? 0) > 0) {
      const items = ($drones.bay ?? []).map((d) => ({ itemID: d.itemID, typeID: d.typeID, quantity: d.quantity < 0 ? 1 : d.quantity, singleton: d.quantity < 0 }));
      const used = items.reduce((n, i) => n + (volumes[String(i.typeID)] ?? 0) * i.quantity, 0);
      out.push({ key: "drone", label: word("UI/Ship/DroneBay", "Drone Bay"), items, capacity: droneBayCapacity, used });
    }
    return out;
  });
  let volumes = $state<Record<string, number>>({});
  $effect(() => {
    const ids = [...new Set(($drones.bay ?? []).map((d) => d.typeID))].filter((t) => volumes[String(t)] === undefined);
    if (ids.length) void flow.typeVolumes(ids).then((v) => { volumes = { ...volumes, ...v }; }).catch(() => {});
  });
  $effect(() => {
    const refs: NameRef[] = [];
    if (ship?.typeID) refs.push({ kind: "type", id: ship.typeID });
    for (const b of bays) for (const i of b.items ?? []) refs.push({ kind: "type", id: i.typeID });
    if (refs.length) flow.requestNames(refs);
  });

  /** The bay shown (the tree's selected node): the one a hold button asked for, else the cargo. */
  let current = $state("cargo");
  function takeRequest(): void {
    const asked = shipHoldTarget.take();
    if (asked) current = asked.key;
  }
  const requests = shipHoldTarget.requests;
  $effect(() => { void $requests; untrack(takeRequest); });
  const bay = $derived(bays.find((b) => b.key === current) ?? bays.find((b) => b.key === "cargo") ?? null);
  let treeOpen = $state(true);

  let filter = $state("");
  const shown = $derived((bay?.items ?? []).filter((i) => !filter.trim() || typeName(i.typeID).toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((a, b) => typeName(a.typeID).localeCompare(typeName(b.typeID))));
  const filtered = $derived((bay?.items?.length ?? 0) - shown.length);

  // typeHelpers.GetAveragePrice: the cfg's average prices
  let prices = $state<ReadonlyMap<number, number | null> | null>(null);
  onMount(() => { void flow.cfgAveragePrices().then((p) => (prices = p)).catch(() => {}); });
  const isk = $derived(shown.reduce((n, i) => n + (prices?.get(i.typeID) ?? 0) * i.quantity, 0));

  /** InvContCapacityGauge: "<used>/<capacity> m³" over its fill. */
  const fmt1 = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fill = $derived(bay && bay.capacity ? Math.min(1, (bay.used ?? 0) / bay.capacity) : 0);
  const shipLabel = $derived(ship ? `${ship.name ?? typeName(ship.typeID)} (${typeName(ship.typeID)})` : "");
</script>

<div class="inv">
  <div class="tree">
    <div class="nodes">
      {#if ship}
        <div class="node" class:sel={current === "cargo"} role="treeitem" aria-selected={current === "cargo"} tabindex="-1"
          onclick={() => (current = "cargo")} onkeydown={() => {}}>
          <button type="button" class="exp" class:open={treeOpen} aria-label="Expand" onclick={(e) => { e.stopPropagation(); treeOpen = !treeOpen; }}></button>
          <span class="ticon"><TypeIcon typeID={ship.typeID} name={shipLabel} size="sm" /></span>
          <span class="tlabel">{shipLabel}</span>
        </div>
        {#if treeOpen}
          {#each bays.filter((b) => b.key !== "cargo") as b (b.key)}
            <div class="node sub" class:sel={current === b.key} role="treeitem" aria-selected={current === b.key} tabindex="-1"
              onclick={() => (current = b.key)} onkeydown={() => {}}>
              <span class="ticon"><img src={clientTexture(BAY_ICON[b.key] ?? "res:/UI/Texture/WindowIcons/cargo.png")} alt=""></span>
              <span class="tlabel">{b.label}</span>
            </div>
          {/each}
        {/if}
      {/if}
    </div>
    <div class="filters"><span class="caret">▴</span> {word("UI/Inventory/Filters/MyFilters", "My filters")}<span class="plus">+</span></div>
  </div>
  <div class="right">
    <div class="top">
      <span class="tool" title={word("UI/Inventory/StackAll", "Stack All")} style:background-image={`url(${clientTexture("res:/ui/texture/eveicon/system_icons/stack_16px.png")})`}></span>
      <span class="tool" title={word("UI/Inventory/ViewMode", "View mode")} style:background-image={`url(${clientTexture("res:/ui/texture/eveicon/system_icons/grid_view_16px.png")})`}></span>
      <span class="tool" title={word("UI/Common/SortBy", "Sort by")} style:background-image={`url(${clientTexture("res:/ui/texture/eveicon/system_icons/bars_sort_ascending_16px.png")})`}></span>
      <div class="gauge">
        <span class="gfill" style:width={`${fill * 100}%`}></span>
        <span class="gtext">{bay ? `${fmt1(bay.used ?? 0)}/${bay.capacity === null ? "?" : fmt1(bay.capacity)} m³` : ""}</span>
      </div>
      <input class="search" placeholder="Search" bind:value={filter} />
    </div>
    <div class="items">
      {#if bay && bay.items === null}
        <p class="none">…</p>
      {:else if !shown.length}
        <p class="none">{word("UI/Common/NothingFound", "Nothing Found")}</p>
      {:else}
        {#each shown as i (i.itemID)}
          <div class="item" title={typeName(i.typeID)}>
            <span class="icon"><TypeIcon typeID={i.typeID} name={typeName(i.typeID)} size="lg" />
              {#if !i.singleton}<span class="qty">{i.quantity.toLocaleString("en-US")}</span>{/if}</span>
            <span class="iname">{typeName(i.typeID)}</span>
          </div>
        {/each}
      {/if}
    </div>
    <div class="foot">
      <span class="count">{word("UI/Inventory/NumItems2", `${shown.length} Items`, { numItems: shown.length, numFilteredTxt: filtered > 0 ? `(${filtered} filtered)` : "" })}</span>
      <span class="price">{word("UI/Inventory/EstIskPrice2", `${Math.round(isk).toLocaleString("en-US")} ISK Est. price`, { iskString: `${Math.round(isk).toLocaleString("en-US")} ISK` })}</span>
    </div>
  </div>
</div>

<style>
  .inv { display: flex; height: 100%; min-height: 0; font-size: 13px; color: rgba(255, 255, 255, 0.85); user-select: none; }
  .tree { width: 160px; flex: none; display: flex; flex-direction: column; background: rgba(255, 255, 255, 0.03); margin: 0 8px 0 0; }
  .nodes { flex: 1; overflow: auto; padding: 4px 0; }
  .node { display: flex; align-items: center; gap: 4px; height: 24px; padding: 0 6px; cursor: default; }
  .node:hover { background: rgba(255, 255, 255, 0.06); }
  .node.sel { background: rgba(88, 167, 191, 0.25); color: #fff; }
  .node.sub { padding-left: 28px; }
  .exp { width: 12px; height: 12px; padding: 0; border: 0; background: transparent; position: relative; cursor: pointer; }
  .exp::before { content: ""; position: absolute; left: 3px; top: 2px; border-left: 5px solid rgba(255, 255, 255, 0.7); border-top: 4px solid transparent; border-bottom: 4px solid transparent; transition: transform .1s; }
  .exp.open::before { transform: rotate(90deg); }
  .ticon { width: 16px; height: 16px; flex: none; display: grid; overflow: hidden; }
  .ticon :global(.type-icon) { width: 16px; height: 16px; }
  .ticon img { width: 16px; height: 16px; }
  .tlabel { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .filters { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; color: rgba(255, 255, 255, 0.8); }
  .filters .plus { margin-left: auto; font-size: 18px; }
  .caret { font-size: 10px; }
  .right { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .top { display: flex; align-items: center; gap: 0; height: 24px; margin-bottom: 16px; }
  .tool { width: 24px; height: 24px; flex: none; background: center / 16px 16px no-repeat; opacity: 0.8; }
  .tool:hover { opacity: 1; }
  .gauge { position: relative; flex: 1; min-width: 0; height: 24px; margin: 0 8px; background: rgba(0, 0, 0, 0.3); }
  .gfill { position: absolute; left: 0; top: 0; bottom: 0; background: rgba(88, 167, 191, 0.35); }
  .gtext { position: absolute; left: 8px; top: 0; line-height: 24px; font-size: 12px; color: rgba(255, 255, 255, 0.8); white-space: nowrap; }
  .search { width: 128px; flex: none; height: 24px; box-sizing: border-box; border: 0; background: rgba(0, 0, 0, 0.3); color: #fff; padding: 0 6px; font-size: 12px; }
  .items { flex: 1; overflow: auto; display: flex; flex-wrap: wrap; align-content: flex-start; gap: 8px; }
  .none { width: 100%; margin: 0; text-align: center; font-size: 20px; color: rgba(255, 255, 255, 0.6); letter-spacing: 0.5px; }
  .item { width: 64px; display: flex; flex-direction: column; align-items: center; }
  .icon { position: relative; width: 64px; height: 64px; display: grid; }
  .icon :global(.type-icon) { width: 64px; height: 64px; }
  .qty { position: absolute; right: 2px; bottom: 2px; padding: 1px 4px 0; background: rgba(0, 0, 0, 0.75); font-size: 11px; line-height: 14px; }
  .iname { margin-top: 2px; width: 70px; text-align: center; font-size: 12px; line-height: 14px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .foot { display: flex; align-items: center; gap: 8px; height: 24px; color: rgba(255, 255, 255, 0.55); }
  .count { font-weight: 700; }
</style>
