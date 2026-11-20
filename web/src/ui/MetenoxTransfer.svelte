<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { InventoryItemRow } from "../store/types.ts";
  import { resolvedName } from "../store/names.ts";
  import { typeIconUrl } from "./typeIcons.ts";

  let { store, flow, structureID, shipID, onClose }: {
    store: ClientStore; flow: AppFlow; structureID: number; shipID: number; onClose: () => void;
  } = $props();
  const names = $derived(store.names);
  let rows = $state.raw<readonly InventoryItemRow[]>([]);
  let selected = $state<number[]>([]);
  let busy = $state(true);
  let error = $state("");
  let notice = $state("");

  async function read(): Promise<void> {
    rows = await flow.loadMetenoxDeposit(shipID);
    selected = selected.filter(id => rows.some(row => row.itemID === id));
  }

  $effect(() => {
    flow.requestNames([{ kind: "evelocation", id: structureID }]);
    void read().catch(cause => { error = (cause as Error).message; }).finally(() => { busy = false; });
  });

  async function transfer(): Promise<void> {
    if (busy || selected.length === 0) return;
    busy = true;
    error = "";
    notice = "";
    try {
      const requested = selected.length;
      const moved = await flow.depositMetenoxFuel(structureID, shipID, selected);
      selected = selected.filter(id => !moved.includes(id));
      notice = moved.length ? `${moved.length} of ${requested} selected stacks transferred to the Fuel Bay.` : "The structure accepted none of the selected stacks.";
      await read();
    } catch (cause) {
      error = (cause as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<section class="fuel-transfer" aria-label="Hangar Transfer">
  <p>Transfer to {resolvedName($names.resolved, "evelocation", structureID, "Metenox Fuel Bay")}</p>
  {#if busy && rows.length === 0}
    <p role="status">Reading ship inventory…</p>
  {:else if rows.length === 0}
    <p>No fuel blocks or Magmatic Gas in the ship.</p>
  {:else}
    <ul aria-label="Eligible fuel stacks">
      {#each rows as row (row.itemID)}
        <li><label>
          <input type="checkbox" value={row.itemID} bind:group={selected} disabled={busy} />
          <img src={typeIconUrl(row.typeID)} alt="" />
          <span>{resolvedName($names.resolved, "type", row.typeID, `Type ${row.typeID}`)}</span>
          <span>{row.quantity.toLocaleString()}</span>
        </label></li>
      {/each}
    </ul>
  {/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  <footer>
    <button type="button" onclick={onClose}>Close</button>
    <button type="button" disabled={busy || selected.length === 0} onclick={transfer}>Transfer</button>
  </footer>
</section>

<style>
  section { padding: 14px; }
  ul { padding: 0; list-style: none; }
  li { border-bottom: 1px solid #465158; }
  label { display: grid; grid-template-columns: auto 24px 1fr auto; gap: 8px; align-items: center; padding: 5px 0; }
  img { width: 24px; height: 24px; }
  footer { display: flex; justify-content: space-between; margin-top: 14px; }
</style>
