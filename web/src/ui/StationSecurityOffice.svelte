<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { SECURITY_PROCESSING_FEE, SECURITY_TAGS, securityTagSteps } from "../bridge/securityOffice.ts";

  let { store, flow, stationID }: { store: ClientStore; flow: AppFlow; stationID: number } = $props();
  const station = $derived(store.station);
  const inventory = $derived(store.inventory);
  const names = $derived(store.names);
  const wallet = $derived(store.wallet);
  let fees = $state<ReadonlyMap<number, number | null> | null>(null);
  let selected = $state(0);

  onMount(() => {
    flow.requestOwnSecurityStatus();
    flow.requestNames(SECURITY_TAGS.map(tag => ({ kind: "type", id: tag.typeID })));
    void flow.loadInventory().catch(() => {});
    void flow.loadWallet().catch(() => {});
    void Promise.all(SECURITY_TAGS.map(async ({ typeID }) => {
      const facts = await flow.typeDogmaFacts(typeID).catch(() => null);
      return [typeID, facts?.attributes.find(([id]) => id === SECURITY_PROCESSING_FEE)?.[1] ?? null] as const;
    })).then(rows => { fees = new Map(rows); });
  });

  const current = $derived($station.ownSecurityStatus);
  const steps = $derived(current === null ? [] : securityTagSteps(current));
  const count = $derived(Math.min(selected, steps.length));
  const target = $derived(steps[count - 1]?.status ?? current);
  const rows = $derived(SECURITY_TAGS.map(tag => {
    const owned = $inventory.stationID !== stationID ? null : $inventory.hangar.rows
      .filter(item => item.typeID === tag.typeID && item.ownerID === $station.online?.characterID &&
        item.locationID === stationID && item.flagID === 4)
      .reduce((sum, item) => sum + item.quantity, 0);
    const required = steps.slice(0, count).filter(step => step.typeID === tag.typeID).length;
    return { ...tag, owned, required, fee: fees?.get(tag.typeID) ?? null };
  }));
  const quote = $derived(rows.some(row => row.required > 0 && row.fee === null) ? null :
    rows.reduce((sum, row) => sum + row.required * (row.fee ?? 0), 0));
  const balance = $derived($wallet.cashBalance === null ? null : Number($wallet.cashBalance));
  const statusText = (value: number | null) => value === null ? "—" : value.toFixed(2);
  const isk = (value: number | null) => value === null ? "—" : value.toLocaleString() + " ISK";
</script>

<div class="security-office" data-window="securityOffice">
  <div class="status">
    <span>Current security <strong>{statusText(current)}</strong></span>
    <span>Target security <strong>{statusText(target)}</strong></span>
  </div>
  <label class="target">
    <span>Security increase</span>
    <input type="range" min="0" max={steps.length} step="1" value={count}
      aria-valuetext={statusText(target)} disabled={steps.length === 0}
      oninput={event => { selected = event.currentTarget.valueAsNumber; }} />
  </label>
  <table>
    <thead><tr><th scope="col">Security tag</th><th scope="col">In hangar</th><th scope="col">Required</th></tr></thead>
    <tbody>
      {#each rows as row (row.typeID)}
        <tr class:short={row.owned !== null && row.required > row.owned}>
          <th scope="row">{resolvedName($names.resolved, "type", row.typeID, row.name)}</th>
          <td>{row.owned ?? "—"}</td><td>{row.required}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  <div class="fee" class:short={quote !== null && balance !== null && quote > balance}>
    Processing fee <strong>{isk(quote)}</strong>
  </div>
  <p class="availability">
    {#if current === null}Reading security status…
    {:else if steps.length === 0}Your security status is already at or above 0.00.
    {:else}Tag exchange is unavailable on this server.
    {/if}
  </p>
</div>

<style>
  .security-office { display: grid; gap: 9px; padding: 12px; color: #e2e5e3; font-size: 13px; }
  .status, .fee { display: flex; justify-content: space-between; gap: 12px; }
  strong { margin-left: 6px; font-variant-numeric: tabular-nums; }
  .target { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 12px; }
  .target input { width: 100%; accent-color: #7bbdb8; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 4px 6px; text-align: right; font-weight: normal; }
  th:first-child { text-align: left; }
  thead { color: #aab3af; border-bottom: 1px solid #464d4a; }
  tbody tr:nth-child(odd) { background: #ffffff08; }
  .short { color: #ff9690; }
  .availability { color: #b0b9b5; margin: 0; }
</style>
