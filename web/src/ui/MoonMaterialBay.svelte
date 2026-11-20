<script lang="ts">
  import { untrack } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { MoonMaterialBay } from "../bridge/autoMoonMining.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { typeIconUrl } from "./typeIcons.ts";

  let { store, flow, initial }: { store: ClientStore; flow: AppFlow; initial: MoonMaterialBay } = $props();
  const names = $derived(store.names);
  let bay = $state.raw(untrack(() => initial));
  let selectedID = $state<number | null>(null);
  let quantity = $state<number | undefined>(undefined);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");

  const stack = $derived(bay.rows.find(row => row.itemID === selectedID));
  const canMove = $derived(!busy && stack !== undefined && quantity !== undefined && Number.isSafeInteger(quantity) && quantity > 0 && quantity <= stack.quantity);
  const capacity = $derived(bay.capacity?.capacity ?? null);
  const used = $derived(bay.capacity?.used ?? null);
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const typeName = (typeID: number) => resolvedName($names.resolved, "type", typeID, `Type ${typeID}`);

  async function refresh(retrieve: boolean): Promise<void> {
    if (busy || (retrieve && !canMove)) return;
    const transfer = retrieve && stack && quantity !== undefined
      ? { shipID: bay.shipID, itemID: stack.itemID, quantity, stackQuantity: stack.quantity }
      : undefined;
    const label = transfer && stack ? typeName(stack.typeID) : "";
    busy = true;
    error = notice = "";
    selectedID = null;
    quantity = undefined;
    try {
      bay = await flow.loadMoonMaterialBay(bay.structureID, transfer);
      if (transfer) notice = `Moved ${number.format(transfer.quantity)} ${label} to ship cargo.`;
    } catch (cause) {
      error = (cause as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<section aria-label="Moon Material Bay">
  <header>
    {#if capacity !== null && used !== null}
      <span>{number.format(Math.max(0, capacity - used))} m³ free of {number.format(capacity)} m³</span>
      <progress max={capacity} value={used} aria-label="Bay capacity used"></progress>
    {:else}
      <span>Capacity unavailable</span>
    {/if}
  </header>
  {#if bay.rows.length === 0}
    <p>The bay is empty.</p>
  {:else}
    <ul aria-label="Moon material stacks">
      {#each bay.rows as row (row.itemID)}
        <li>
          <label>
            <input type="radio" name="moon-material-stack" checked={selectedID === row.itemID} disabled={busy}
              onchange={() => { selectedID = row.itemID; quantity = row.quantity; }} />
            <img src={typeIconUrl(row.typeID)} alt="" />
            <span>{typeName(row.typeID)}</span>
            <span>{number.format(row.quantity)}</span>
          </label>
        </li>
      {/each}
    </ul>
  {/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  <footer>
    <button type="button" onclick={() => refresh(false)} disabled={busy}>Refresh</button>
    <label>Quantity <input type="number" min="1" max={stack?.quantity} step="1" bind:value={quantity} disabled={busy || !stack} /></label>
    <button type="button" onclick={() => refresh(true)} disabled={!canMove}>Move to Ship Cargo</button>
  </footer>
</section>

<style>
  section { padding: 14px; }
  header { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; }
  progress { flex: 1; min-width: 4rem; accent-color: #61a7b6; }
  ul { padding: 0; list-style: none; }
  li { border-bottom: 1px solid #465158; }
  li label { display: grid; grid-template-columns: auto 24px 1fr auto; gap: 8px; align-items: center; padding: 5px 0; }
  img { width: 24px; height: 24px; }
  input[type="number"] { width: 5rem; }
  footer { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; margin-top: 14px; }
  footer button:first-child { margin-right: auto; }
</style>
