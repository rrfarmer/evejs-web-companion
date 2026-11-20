<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { autoMoonStatus, FUEL_BLOCK_GROUP_ID, METENOX_BLOCKS_PER_HOUR, METENOX_CYCLE_SECONDS, METENOX_GAS_PER_CYCLE,
    METENOX_GAS_TYPE_ID, METENOX_TYPE_ID, type AutoMoonDetails, type AutoMoonMiner } from "../bridge/autoMoonMining.ts";
  import type { MoonOrePricing } from "../bridge/moonMining.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";
  import { typeIconUrl } from "./typeIcons.ts";

  let { store, flow, miner }: { store: ClientStore; flow: AppFlow; miner: AutoMoonMiner } = $props();
  const names = $derived(store.names);
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const qty = (value: number | null) => value === null ? "—" : number.format(value);
  const isk = (value: number | null) => value === null ? "—" : `${qty(Math.round(value))} ISK`;
  const volume = (value: number | null) => value === null ? "—" : `${qty(value)} m³`;
  const typeName = (typeID: number) => resolvedName($names.resolved, "type", typeID, `Type ${typeID}`);

  let details = $state.raw<AutoMoonDetails | null>(null);
  let cycle = $state.raw<ReadonlyMap<number, number> | null>(null);
  let pricing = $state.raw<ReadonlyMap<number, MoonOrePricing>>(new Map());
  let fuelBlocks = $state<number | null>(null);
  let error = $state("");
  let now = $state(Date.now());
  let clockOffset = 0;
  let mounted = false;
  let nextRead: ReturnType<typeof setTimeout> | undefined;
  let knownProducts = "";
  let knownFuel = "";

  const status = $derived(details && autoMoonStatus(details));
  const gas = $derived(details?.fuel.get(METENOX_GAS_TYPE_ID) ?? 0);
  const secondsToHarvest = $derived(details?.nextHarvestAtMs == null ? null : Math.max(0, Math.ceil((details.nextHarvestAtMs - now) / 1000)));
  const rows = $derived([...new Set([...(cycle?.keys() ?? []), ...(details?.materials.keys() ?? [])])].map(id => {
    const quote = pricing.get(id), perCycle = cycle?.get(id) ?? 0, inBay = details?.materials.get(id) ?? 0;
    return { id, name: typeName(id), perCycle, inBay,
      cycleValue: quote ? quote.unitPrice * perCycle : perCycle === 0 ? 0 : null,
      bayValue: quote ? quote.unitPrice * inBay : inBay === 0 ? 0 : null,
      cycleVolume: quote ? quote.unitVolume * perCycle : perCycle === 0 ? 0 : null,
      bayVolume: quote ? quote.unitVolume * inBay : inBay === 0 ? 0 : null };
  }).sort((a, b) => a.name.localeCompare(b.name)));

  const sum = (values: readonly (number | null)[]) => values.reduce<number | null>((total, value) =>
    total === null || value === null ? null : total + value, 0);
  function elapsed(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    return `${hours ? `${hours}h ` : ""}${minutes}m ${seconds % 60}s`;
  }
  function endurance(amount: number | null, consumption: number): string {
    if (amount === null) return "—";
    const hours = Math.floor(amount / consumption);
    return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h`;
  }

  async function refresh(): Promise<void> {
    clearTimeout(nextRead);
    error = "";
    try {
      const [read, output] = await Promise.all([flow.loadAutoMoonDetails(miner), cycle ?? flow.loadAutoMoonCycle(miner)]);
      if (!mounted) return;
      clockOffset = read.nowMs - Date.now();
      now = read.nowMs;
      details = read;
      cycle = output;
      const products = [...new Set([...output.keys(), ...read.materials.keys()])].sort((a, b) => a - b);
      const fuelIDs = [...read.fuel.keys()].filter(id => id !== METENOX_GAS_TYPE_ID);
      if (products.join(",") !== knownProducts) {
        const quotes = await flow.loadMoonOrePricing(products).catch(() => null);
        if (!mounted) return;
        if (quotes) { knownProducts = products.join(","); pricing = quotes; }
      }
      const fuelKey = fuelIDs.map(id => `${id}:${read.fuel.get(id)}`).join(",");
      if (fuelBlocks === null || fuelKey !== knownFuel) {
        const facts = fuelIDs.length ? await flow.typeFacts(fuelIDs).catch(() => null) : new Map();
        if (!mounted) return;
        fuelBlocks = facts ? fuelIDs.reduce((total, id) => total + (facts.get(id)?.groupID === FUEL_BLOCK_GROUP_ID ? read.fuel.get(id)! : 0), 0) : null;
        knownFuel = fuelKey;
      }
      const until = read.nextHarvestAtMs === null ? 15_000 : read.nextHarvestAtMs - now + 500;
      nextRead = setTimeout(() => void refresh(), Math.min(15_000, Math.max(2_000, until)));
    } catch (cause) {
      if (!mounted) return;
      details = null;
      error = (cause as Error).message;
    }
  }

  onMount(() => {
    mounted = true;
    void refresh();
    const clock = setInterval(() => { now = Date.now() + clockOffset; }, 500);
    return () => { mounted = false; clearTimeout(nextRead); clearInterval(clock); };
  });
</script>

<section class="auto-moon-miner" aria-label="Moon drill details">
  {#if error}
    <p role="alert">{error}</p>
    <button type="button" onclick={refresh}>Retry</button>
  {:else if !details || !cycle}
    <p role="status">Reading moon drill details…</p>
  {:else}
    <header>
      <img class="moon-icon" src={typeIconUrl(14)} alt="" />
      <div>
        <button class="show-info title" type="button" onclick={() => showInfo({ kind: "spaceObject", typeID: METENOX_TYPE_ID, itemID: miner.id })}>{miner.name}</button>
        <button class="show-info" type="button" onclick={() => showInfo({ kind: "corporation", corporationID: miner.ownerID })}>
          {resolvedName($names.resolved, "owner", miner.ownerID, String(miner.ownerID))}
        </button>
        <p>{resolvedName($names.resolved, "evelocation", details.moonID, `Moon ${details.moonID}`)}</p>
      </div>
      <dl>
        <dt>Drill Status</dt><dd class:operational={status === "Operational"} class="status">{status}</dd>
        <dt>Next Output In</dt><dd>{secondsToHarvest === null ? "—" : elapsed(secondsToHarvest)}</dd>
        <dt>Remaining Capacity</dt><dd>{volume(details.remainingCapacity)}</dd>
      </dl>
    </header>
    <h3>Fuel State</h3>
    <table aria-label="Fuel State">
      <thead><tr><th scope="col">Fuel Type</th><th scope="col">Quantity</th><th scope="col">Expiration</th><th scope="col">Consumption Rate</th></tr></thead>
      <tbody>
        <tr><th scope="row">Fuel Blocks</th><td>{qty(fuelBlocks)}</td><td>{endurance(fuelBlocks, METENOX_BLOCKS_PER_HOUR)}</td><td>{METENOX_BLOCKS_PER_HOUR}/hour</td></tr>
        <tr><th scope="row">{gas > 0 ? typeName(METENOX_GAS_TYPE_ID) : "Magmatic Gas"}</th><td>{qty(gas)}</td>
          <td>{endurance(gas, METENOX_GAS_PER_CYCLE * 3600 / METENOX_CYCLE_SECONDS)}</td><td>{METENOX_GAS_PER_CYCLE}/hour</td></tr>
      </tbody>
    </table>
    <h3>Output</h3>
    <table aria-label="Moon products">
      <thead><tr><th scope="col">Moon Product</th><th scope="col">Units per Cycle</th><th scope="col">Est. Price per Cycle</th><th scope="col">Units</th><th scope="col">Est. Price</th></tr></thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr>
            <th scope="row"><button class="show-info product" type="button" onclick={() => showInfo({ kind: "type", typeID: row.id })}><img alt="" src={typeIconUrl(row.id)} />{row.name}</button></th>
            <td>{qty(row.perCycle)}</td><td>{isk(row.cycleValue)}</td><td>{qty(row.inBay)}</td><td>{isk(row.bayValue)}</td>
          </tr>
        {:else}
          <tr><td colspan="5">No moon products reported.</td></tr>
        {/each}
      </tbody>
      <tfoot><tr><th scope="row">Total</th>
        <td>{qty(sum(rows.map(row => row.perCycle)))}<small>{volume(sum(rows.map(row => row.cycleVolume)))}</small></td>
        <td>{isk(sum(rows.map(row => row.cycleValue)))}</td>
        <td>{qty(sum(rows.map(row => row.inBay)))}<small>{volume(sum(rows.map(row => row.bayVolume)))}</small></td>
        <td>{isk(sum(rows.map(row => row.bayValue)))}</td>
      </tr></tfoot>
    </table>
  {/if}
</section>

<style>
  .auto-moon-miner { display: grid; gap: 8px; padding: 15px; color: #e0ebed; font-size: 13px; }
  header { display: grid; grid-template-columns: auto minmax(120px, 1fr) auto; gap: 14px; align-items: center; padding: 10px; background: #1d2a30; }
  .moon-icon { width: 60px; height: 60px; }
  h3, dl, p, dd { margin: 0; }
  h3 { margin-top: 7px; color: #b8d0d7; font-size: 13px; }
  dl { display: grid; grid-template-columns: auto auto; gap: 5px 10px; }
  dt { color: #b3c5cd; }
  dd { text-align: right; font-variant-numeric: tabular-nums; }
  .status { color: #ffc09f; }
  .operational { color: #b3e481; }
  .show-info { display: block; background: transparent; padding: 0; border: 0; color: #b8dbe4; text-align: left; font: inherit; }
  .show-info:hover { text-decoration: underline; }
  .title { font-weight: 650; font-size: 17px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 6px 7px; border-bottom: 1px solid #35464e; white-space: nowrap; }
  th { text-align: left; font-weight: 500; }
  td, th:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; }
  thead, tfoot { background: #28373f; }
  .product { display: inline-flex; align-items: center; gap: 6px; white-space: normal; }
  .product img { width: 22px; height: 22px; flex: none; }
  small { display: block; color: #b1c7cf; }
  @media (max-width: 590px) { header { grid-template-columns: auto 1fr; } dl { grid-column: 1 / -1; } th, td { white-space: normal; } }
</style>
