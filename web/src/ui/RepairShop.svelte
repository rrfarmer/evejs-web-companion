<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow, AssetRepairShop } from "../app/flow.ts";
  import type { RepairQuotePart } from "../bridge/repairQuotes.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { iskWords } from "../bridge/questions.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import DesktopWindow from "./DesktopWindow.svelte";
  import TypeIcon from "./TypeIcon.svelte";

  let { store, flow, shop }: { store: ClientStore; flow: AppFlow; shop: AssetRepairShop } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const LABELS = {
    title: "UI/Station/Repair/RepairShopHeader",
    pick: "UI/Commands/PickNewItem",
    repair: "UI/Commands/RepairItem",
    all: "UI/Commands/RepairAll",
    type: "UI/Common/Type",
    damage: "UI/Common/Damage",
    cost: "UI/Common/Cost",
    average: "UI/Station/Repair/AverageDamage",
    total: "UI/Station/Repair/RepairCost",
    lineCost: "UI/Station/Repair/RepairCostNumberOnly",
    current: "UI/Station/Repair/CurrentDamage",
    empty: "UI/Station/Repair/NothingToRepair",
    facilities: "UI/Station/Repair/RepairFacilities",
  } as const;
  const nameOf = (kind: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, kind, id);
  const typeName = (typeID: number | null) => typeID === null ? "Unknown item" : nameOf("type", typeID);
  function word(label: string, fallback: string, args: Record<string, string | number> = {}): string {
    const template = $words.templates[label];
    return typeof template === "string" ? plainText(formatTemplate(template, args, { nameOf })) || fallback : fallback;
  }
  const isk = (amount: number) => iskWords(amount, 2, $words.templates, nameOf) ?? `${amount.toFixed(2)} ISK`;

  let picked = $state<ReadonlySet<number>>(new Set());
  let win = $state({ x: 0, y: 0, w: 400, h: 300, z: 1, minimized: false });
  onMount(() => {
    flow.requestWords(Object.values(LABELS));
    win.w = Math.min(400, window.innerWidth);
    win.h = Math.min(300, window.innerHeight);
    win.x = Math.floor((window.innerWidth - win.w) / 2);
    win.y = Math.floor((window.innerHeight - win.h) / 2);
  });
  const selectionKey = $derived(shop.n);
  $effect(() => {
    void selectionKey;
    picked = new Set();
  });
  const rows = $derived((shop.list.kind === "quote" ? [...shop.list.parts] : [...shop.list.items])
    .sort((a, b) => typeName(a.typeID).localeCompare(typeName(b.typeID)) || a.itemID - b.itemID));
  const parts = $derived(shop.list.kind === "quote" ? shop.list.parts : []);
  const selected = $derived(rows.filter(row => picked.has(row.itemID)));
  const selectedParts = $derived(parts.filter(part => picked.has(part.itemID)));
  const total = $derived(parts.some(part => part.cost === null) ? null : parts.reduce((sum, part) => sum + (part.cost ?? 0), 0));
  const percent = (part: RepairQuotePart) => part.damage === null ? 0 : Math.ceil(part.damage) / (part.maxHealth || 1) * 100;
  const average = $derived(parts.reduce((sum, part) => sum + percent(part), 0) / (parts.length || 1));

  function damageText(part: RepairQuotePart): string {
    if (part.damage === null || part.maxHealth === null) return "—";
    const dmg = Math.ceil(part.damage);
    const current = Math.max(0, Math.floor(part.maxHealth - dmg));
    return word(LABELS.current, `${current} / ${part.maxHealth} (${percent(part).toFixed(1)}%)`,
      { curHealth: current, maxHealth: part.maxHealth, percentHealth: percent(part) });
  }
  function select(id: number, event: MouseEvent): void {
    if (!event.ctrlKey && !event.metaKey) {
      picked = new Set([id]);
      return;
    }
    const next = new Set(picked);
    if (!next.delete(id)) next.add(id);
    picked = next;
  }
  function quote(ids: readonly number[]): void {
    const targets = rows.filter(row => ids.includes(row.itemID) && row.typeID !== null)
      .map(row => ({ itemID: row.itemID, typeID: row.typeID!, stationID: shop.stationID }));
    if (targets.length > 0) void flow.openAssetRepair(targets).catch(() => {});
  }
</script>

<div class="repair-shop-layer">
  <DesktopWindow {win} title={word(LABELS.title, "Repair Shop")} focused={true} onFocus={() => {}}
    onClose={() => flow.closeAssetRepair(shop.n)} onMove={(x, y) => { win.x = x; win.y = y; }}
    minWidth={350} minHeight={270} onResizeRect={(rect) => { win = { ...win, ...rect }; }}>
    <div class="repair-shop" data-window="repairshop" data-view={shop.list.kind} aria-busy={shop.busy}>
      {#if shop.list.kind === "quote"}
        <div class="repair-summary">
          <span>{word(LABELS.average, `Average damage ${average.toFixed(1)}%`, { damage: average })}</span>
          <span>{total === null ? "Repair cost unavailable" : word(LABELS.total, `Repair cost ${isk(total)}`, { isk: Math.ceil(total) })}</span>
        </div>
      {/if}
      {#if shop.error}<div class="repair-status" role="status">{shop.error}</div>{/if}
      <div class="repair-rows" class:quotes={shop.list.kind === "quote"} role="group" aria-label={word(LABELS.title, "Repair Shop")}>
        <div class="repair-head">
          <span>{word(LABELS.type, "Type")}</span>
          {#if shop.list.kind === "quote"}<span>{word(LABELS.damage, "Damage")}</span><span>{word(LABELS.cost, "Cost")}</span>{/if}
        </div>
        {#each rows as row (row.itemID)}
          {@const name = typeName(row.typeID)}
          <button type="button" class="repair-row" data-item-id={row.itemID} aria-pressed={picked.has(row.itemID)} disabled={shop.busy}
            onclick={(event) => select(row.itemID, event)} ondblclick={() => quote(selected.map(item => item.itemID))}>
            <span class="repair-type">{#if row.typeID !== null}<TypeIcon typeID={row.typeID} {name} size="sm" />{/if}<span title={name}>{name}</span></span>
            {#if "damage" in row}
              <span>{damageText(row)}</span>
              <span>{row.cost === null ? "—" : word(LABELS.lineCost, isk(Math.ceil(row.cost)), { isk: Math.ceil(row.cost) })}</span>
            {/if}
          </button>
        {:else}
          {#if !shop.error}<p class="repair-status">{shop.busy ? "Loading…" : word(LABELS.empty, "There is nothing to repair.",
            { repairShop: word(LABELS.facilities, "Repair Facilities") })}</p>{/if}
        {/each}
      </div>
      <div class="repair-actions">
        {#if shop.list.kind === "pick"}
          <button type="button" disabled={shop.busy || selected.length === 0} onclick={() => quote(selected.map(row => row.itemID))}>
            {word(LABELS.repair, "Repair Item")}
          </button>
        {:else}
          <button type="button" disabled={shop.busy} onclick={() => void flow.openAssetRepair().catch(() => {})}>
            {word(LABELS.pick, "Pick New Item")}
          </button>
          {#if selectedParts.length > 0}
            <button type="button" disabled={shop.busy || selectedParts.some(part => part.cost === null)}
              onclick={() => void flow.repairAssetParts(shop.n, selectedParts.map(part => part.itemID)).catch(() => {})}>
              {word(LABELS.repair, "Repair Item")}
            </button>
          {/if}
          {#if parts.length > 0}
            <button type="button" disabled={shop.busy || total === null}
              onclick={() => void flow.repairAssetParts(shop.n, parts.map(part => part.itemID)).catch(() => {})}>
              {word(LABELS.all, "Repair All")}
            </button>
          {/if}
        {/if}
      </div>
    </div>
  </DesktopWindow>
</div>

<style>
  .repair-shop-layer { position: fixed; inset: 0; z-index: 44; pointer-events: none; }
  .repair-shop-layer :global(.win) { pointer-events: auto; }
  .repair-shop { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; padding: .55rem; gap: .45rem; font-size: .8rem; }
  .repair-summary { display: grid; gap: .15rem; font-size: .9rem; }
  .repair-rows { flex: 1; min-height: 0; overflow: auto; border-block: 1px solid var(--line, #ffffff20); }
  .repair-head, .repair-row { display: grid; grid-template-columns: minmax(0, 1fr); width: 100%; box-sizing: border-box; align-items: center; gap: .35rem; text-align: left; padding: .25rem .35rem; }
  .quotes :is(.repair-head, .repair-row) { grid-template-columns: minmax(0, 1fr) minmax(5rem, .8fr) minmax(4rem, .6fr); }
  .repair-head { position: sticky; top: 0; z-index: 1; background: var(--win-bg, #171a1c); font-weight: 600; }
  .repair-row { min-height: 35px; border: 0; border-radius: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
  .repair-row:hover, .repair-row[aria-pressed=true] { background: #ffffff1a; }
  .repair-type { display: flex; align-items: center; gap: .35rem; min-width: 0; }
  .repair-type > span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .repair-actions { display: flex; justify-content: center; gap: .35rem; padding-top: .2rem; }
  .repair-actions button { padding: .2rem .55rem; }
  .repair-status { opacity: .8; margin: .3rem; }
</style>
