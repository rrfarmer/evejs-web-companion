<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { InventoryItemRow } from "../store/types.ts";
  import { type AutoMoonMiner, METENOX_DRILL_TYPE_ID } from "../bridge/autoMoonMining.ts";
  import { resolvedName } from "../store/names.ts";
  import { typeIconUrl } from "./typeIcons.ts";

  let { store, flow, miner, previousShipID, onLeave }: {
    store: ClientStore; flow: AppFlow; miner: AutoMoonMiner; previousShipID: number | null; onLeave: () => Promise<void>;
  } = $props();
  const names = $derived(store.names);
  let fuel = $state.raw<readonly InventoryItemRow[] | null>(null);
  let online = $state<boolean | null>(null);
  let busy = $state(false);
  let error = $state("");

  async function load(): Promise<void> {
    const [bay] = await Promise.all([flow.loadControlledMetenox(miner.id), flow.loadFitting()]);
    fuel = bay.fuel;
    const fitting = store.fitting.get();
    const module = fitting.activeShipID === miner.id ? fitting.slots.find(slot => slot.module?.itemID === bay.moduleID)?.module : null;
    if (module) online = module.online;
    else online = await flow.loadAutoMoonDetails(miner).then(details => details.nextHarvestAtMs !== null).catch(() => null);
  }

  async function work(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    error = "";
    busy = true;
    try { await action(); }
    catch (cause) { error = (cause as Error).message; }
    finally { busy = false; }
  }

  onMount(() => {
    flow.requestNames([{ kind: "type", id: METENOX_DRILL_TYPE_ID }]);
    void work(load);
  });
</script>

<section class="metenox-fuel-bay" aria-label="Metenox Fuel Bay">
  <p>{miner.name}</p>
  {#if fuel}
    <table aria-label="Fuel Bay contents">
      <thead><tr><th scope="col">Item</th><th scope="col">Quantity</th></tr></thead>
      <tbody>
        {#each fuel as row (row.itemID)}
          <tr><th scope="row"><span class="fuel-item"><img src={typeIconUrl(row.typeID)} alt="" />
            {resolvedName($names.resolved, "type", row.typeID, `Type ${row.typeID}`)}</span></th><td>{row.quantity.toLocaleString()}</td></tr>
        {:else}
          <tr><td colspan="2">The Fuel Bay is empty.</td></tr>
        {/each}
      </tbody>
    </table>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  <div class="drill">
    <span>{resolvedName($names.resolved, "type", METENOX_DRILL_TYPE_ID, "Standup Metenox Moon Drill")}</span>
    <span role="status">{online === null ? "—" : online ? "Online" : "Offline"}</span>
    <button type="button" disabled={busy || !fuel || online === true} onclick={() => work(async () => { await flow.startMetenoxDrill(miner.id); await load(); })}>Bring Online</button>
  </div>
  <footer>
    <button type="button" disabled={busy} onclick={() => work(load)}>Refresh</button>
    <button type="button" disabled={busy} onclick={() => work(onLeave)}>{previousShipID === null ? "Eject" : "Board Previous Ship"}</button>
  </footer>
</section>

<style>
  section { padding: 14px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border-bottom: 1px solid #465158; padding: 6px; }
  th { text-align: left; }
  td, th:last-child { text-align: right; }
  td[colspan] { text-align: left; }
  .fuel-item { display: flex; align-items: center; gap: 8px; }
  img { width: 24px; height: 24px; flex: none; }
  .drill, footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
</style>
