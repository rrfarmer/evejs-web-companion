<script lang="ts">
  import { getContext } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { miningScanInWarp, miningScanRows, MINING_SCANNER_UPGRADE, type MiningScanTypeFacts } from "../bridge/miningScanResults.ts";
  import type { SpaceView } from "../play/spaceView.ts";
  import { fmtDist } from "../space/overview.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import TypeIcon from "./TypeIcon.svelte";
  import { showInfo } from "./showInfo.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const flightView = getContext<(() => SpaceView | null) | undefined>("flightSpaceView");
  const mining = $derived(store.mining);
  const space = $derived(store.space);
  const names = $derived(store.names);
  const fitting = $derived(store.fitting);
  const targeting = $derived(store.targeting);
  const snapshot = $derived($space.snapshot);
  const upgrade = $derived($fitting.shipAttributes?.[MINING_SCANNER_UPGRADE] ?? 0);
  const inWarp = $derived(miningScanInWarp(snapshot));
  const upgradeTypeID = 444;
  const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const typeName = (id: number) => resolvedName($names.resolved, "type", id, `Type ${id}`);

  let busy = $state(false);
  let facts = $state<ReadonlyMap<number, MiningScanTypeFacts>>(new Map());
  let sortGroups = $state<"name" | "value" | "type">("name");
  let collapsed = $state<ReadonlySet<number>>(new Set());
  const rows = $derived(miningScanRows($mining.survey, snapshot, facts));
  const groups = $derived.by(() => {
    const byType = new Map<number, typeof rows>();
    for (const row of rows) {
      const group = byType.get(row.typeID);
      if (group) group.push(row);
      else byType.set(row.typeID, [row]);
    }
    return Array.from(byType, ([typeID, rows]) => ({
      typeID, name: typeName(typeID), rows,
      groupID: rows[0]?.groupID ?? Infinity,
      pricePerM3: rows.find(row => row.pricePerM3 !== null)?.pricePerM3 ?? null,
    })).sort((a, b) => {
      if (sortGroups === "type") return a.groupID - b.groupID || a.typeID - b.typeID;
      if (sortGroups === "value") return (b.pricePerM3 ?? -Infinity) - (a.pricePerM3 ?? -Infinity) || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });
  });

  $effect(() => {
    const ids = [...new Set($mining.survey.flatMap(row => row.yieldTypeID === null ? [] : [row.yieldTypeID]))];
    flow.requestNames([upgradeTypeID, ...ids].map(id => ({ kind: "type", id })));
    let current = true;
    void flow.miningScanFacts(ids).then(result => { if (current) facts = result; }).catch(() => {});
    return () => { current = false; };
  });

  async function scan() {
    busy = true;
    try { await flow.runSurveyScan(); }
    catch { /* The flow handles session loss and presents scanner errors. */ }
    finally { busy = false; }
  }

  function toggleGroup(typeID: number) {
    const next = new Set(collapsed);
    if (next.has(typeID)) next.delete(typeID);
    else next.add(typeID);
    collapsed = next;
  }
</script>

<section class="mining-scan-results" aria-label="Mining Scan Results">
  <div class="scan-toolbar">
    <label>Sort ore groups <select bind:value={sortGroups}>
      <option value="name">Name</option><option value="value">Value per m³</option><option value="type">Type</option>
    </select></label>
    <button class="scan-button" type="button" onclick={scan} disabled={busy || inWarp || !snapshot?.inSpace}>{busy ? "Scanning…" : "Scan"}</button>
  </div>
  {#if inWarp}<p class="status">Mining scans are unavailable while warping.</p>{/if}
  {#if $mining.surveyError}<p role="alert" class="status">{$mining.surveyError}</p>{/if}
  <div class="scan-table">
    <table>
      <thead><tr><th scope="col">Ore</th><th scope="col">Quantity</th><th scope="col">Volume</th><th scope="col">Value</th><th scope="col">Distance</th></tr></thead>
      {#each groups as group (group.typeID)}
        <tbody data-ore-type={group.typeID}>
          <tr class="ore-group"><th colspan="5" scope="rowgroup">
            <button type="button" aria-expanded={!collapsed.has(group.typeID)} onclick={() => toggleGroup(group.typeID)}>
              <span aria-hidden="true">{collapsed.has(group.typeID) ? "▸" : "▾"}</span>
              <TypeIcon typeID={group.typeID} name={group.name} size="sm" />
              <span>{group.name} ({group.rows.length})</span>
              {#if group.pricePerM3 !== null}<span class="price">{format.format(group.pricePerM3)} ISK/m³</span>{/if}
            </button>
          </th></tr>
          {#if !collapsed.has(group.typeID)}
            {#each group.rows as row (row.itemID)}
              {@const locked = $targeting.lockedTargetIDs?.includes(row.itemID) ?? false}
              <tr data-rock-id={row.itemID}>
                <td>
                  {#if flightView}
                    <button type="button" class="rock" onclick={() => flightView()?.selectObjectiveTarget(row.itemID)} aria-label={`Select ${group.name}${locked ? ", locked target" : ""}`}>
                      {group.name}{#if locked}<span class="locked" title="Locked target"> ◉</span>{/if}
                    </button>
                  {:else}{group.name}{/if}
                </td>
                <td>{row.quantity === null ? "—" : row.quantity.toLocaleString()}</td>
                <td>{row.volume === null ? "—" : `${format.format(row.volume)} m³`}</td>
                <td>{row.value === null ? "—" : `${format.format(row.value)} ISK`}</td>
                <td>{fmtDist(row.distance)}</td>
              </tr>
            {/each}
          {/if}
        </tbody>
      {/each}
    </table>
    {#if groups.length === 0}<p class="status">{$mining.surveyAtMs === null ? "Run a scan to find nearby ore." : "No scan results found."}</p>{/if}
  </div>
  {#if upgrade <= 0}
    <p class="upgrade">Fit <button type="button" onclick={() => showInfo({ kind: "type", typeID: upgradeTypeID })}>{typeName(upgradeTypeID)}</button> to reveal ore quantities.</p>
  {/if}
</section>

<style>
  section { display: flex; flex-direction: column; min-height: 0; height: 100%; padding: 0.65rem; gap: 0.55rem; color: #e0e9ed; }
  .scan-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 0.65rem; }
  label { display: flex; align-items: center; gap: 0.45rem; font-size: 0.8rem; }
  select, .scan-button { color: inherit; background: #24353d; border: 1px solid #47616b; padding: 0.3rem 0.55rem; }
  .scan-button { min-width: 5rem; }
  button { cursor: pointer; }
  button:disabled { opacity: 0.55; cursor: default; }
  .scan-table { overflow: auto; flex: 1; min-height: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  td, th { padding: 0.28rem 0.42rem; text-align: right; border-bottom: 1px solid #34444a; white-space: nowrap; tab-size: 4; }
  th:first-child, td:first-child { text-align: left; }
  thead th { color: #bdd1d9; position: sticky; top: 0; background: #263239; }
  tbody th { padding: 0; background: #21363f; }
  tbody button, .upgrade button { background: transparent; border: 0; color: inherit; }
  tbody th button { display: flex; align-items: center; gap: 0.4rem; width: 100%; padding: 0.26rem 0.42rem; text-align: left; }
  tbody button:hover, .upgrade button:hover { color: #8ad0e3; }
  .price { margin-left: auto; color: #bdd1d9; font-weight: normal; }
  .rock { padding: 0 0 0 0.7rem; }
  .locked { color: #8ad0e3; }
  .status, .upgrade { margin: 0; color: #c0d3d9; font-size: 0.8rem; }
  .status { padding: 0.45rem 0; }
  .upgrade { padding: 0.55rem 0.4rem; background: #292a21; border-left: 2px solid #b89b58; }
  .upgrade button { padding: 0; text-decoration: underline; }
</style>
