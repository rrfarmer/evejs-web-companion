<script lang="ts">
  import { errorWords, type AppFlow } from "../app/flow.ts";
  import { canReceiveExpeditedTransfer, expeditedTimeWords, quoteExpeditedTransfer, type TransferCargo } from "../bridge/expeditedTransfer.ts";
  import { pinDesignator, type PlanetRouteFacts } from "../bridge/planetRouting.ts";
  import { serverNow } from "../bridge/planets.ts";
  import type { PiRecipeBook } from "../bridge/piRecipes.ts";
  import type { Colony, ColonyPin } from "../store/types.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { colony, source, path, recipes, flow, clockOffsetMs, submitting, submitError, choose, close, execute }: {
    colony: Colony; source: ColonyPin; path: readonly number[]; recipes: PiRecipeBook; flow: AppFlow;
    clockOffsetMs: number; submitting: boolean; submitError: string;
    choose: (id: number) => void; close: () => void; execute: (cargo: TransferCargo) => void;
  } = $props();

  let cargo = $state.raw<TransferCargo>({});
  let facts = $state.raw<PlanetRouteFacts | null>(null);
  let failure = $state("");
  let revision = $state(0);
  let browserNow = $state(Date.now());
  const pins = $derived(new Map(colony.pins.map(pin => [pin.pinID, pin])));
  const destination = $derived(path.length > 1 ? pins.get(path.at(-1)!) : undefined);
  const stockTypes = $derived(source.contents.map(item => item.typeID).sort((a, b) => a - b).join(","));
  const quote = $derived(destination && facts ? quoteExpeditedTransfer(colony, recipes, facts, path, cargo) : null);
  const remaining = $derived(Math.max(0, (source.lastRunAtMs ?? 0) - serverNow(clockOffsetMs, browserNow)));
  const valid = $derived(!submitting && !remaining && !!quote && !quote.error && Object.keys(cargo).length > 0);

  $effect(() => {
    const timer = setInterval(() => { browserNow = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });

  $effect(() => {
    const types = stockTypes;
    revision;
    facts = null;
    failure = "";
    if (!destination || !types) return;
    let current = true;
    void flow.readPlanetRouteFacts(types.split(",").map(Number)).then(result => {
      if (current) facts = result;
    }).catch(cause => {
      if (current) failure = errorWords(cause);
    });
    return () => { current = false; };
  });

  function setAmount(typeID: number, value: number): void {
    const next = { ...cargo };
    if (value === 0 || Number.isNaN(value)) delete next[typeID];
    else next[typeID] = value;
    cargo = next;
  }

  const name = (pin: ColonyPin) => `${pin.typeName} · ${pinDesignator(pin.pinID)}`;
  const fmt = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 4 });
</script>

<section class="expedited-transfer" aria-label="Expedited Transfer">
  <header><h2>Expedited Transfer</h2><button type="button" disabled={submitting} aria-label="Close expedited transfer" onclick={close}>×</button></header>
  <label>Destination
    <select value={destination?.pinID ?? ""} disabled={submitting}
      onchange={(event) => { if (event.currentTarget.value) choose(Number(event.currentTarget.value)); }}>
      <option value="" disabled>Select an installation</option>
      {#each colony.pins.filter(pin => pin.pinID !== source.pinID && canReceiveExpeditedTransfer(pin)) as pin (pin.pinID)}
        <option value={pin.pinID}>{name(pin)}</option>
      {/each}
    </select>
  </label>
  {#if remaining > 0}<p role="status">Next transfer in {expeditedTimeWords(remaining)}</p>{/if}
  {#if destination}
    <ol aria-label="Transfer path">
      {#each path as pinID (pinID)}
        <li>{pins.get(pinID) ? name(pins.get(pinID)!) : "Installation"}</li>
      {/each}
    </ol>
    {#if destination.capacityM3 !== null && destination.usedM3 !== null}
      <p>{fmt(Math.max(0, destination.capacityM3 - destination.usedM3))} m³ free at destination</p>
    {/if}
    {#if !source.contents.length}<p>No commodities in storage.</p>
    {:else if failure}
      <p role="alert">{failure}</p><button type="button" onclick={() => { revision += 1; }}>Retry link data</button>
    {:else if !quote}<p role="status">Reading link and cargo data…</p>
    {:else}
      <ul aria-label="Transfer quantities">
        {#each source.contents as item (item.typeID)}
          {@const limit = quote.limits.get(item.typeID) ?? 0}
          {@const itemName = item.typeName || "Commodity"}
          <li data-transfer-type={item.typeID}>
            <div class="commodity"><TypeIcon typeID={item.typeID} name={itemName} /><strong>{itemName}</strong></div>
            <div class="quantity">
              <label>{fmt(item.quantity)} stored
                <input aria-label={`${itemName} quantity`} type="number" min="0" max={limit} step="1" value={cargo[item.typeID] ?? 0}
                  disabled={submitting || (limit < 1 && cargo[item.typeID] === undefined)}
                  oninput={(event) => setAmount(item.typeID, event.currentTarget.valueAsNumber)} />
              </label>
              <button type="button" disabled={submitting || limit < 1} aria-label={`Maximum ${itemName}`}
                onclick={() => setAmount(item.typeID, limit)}>Max</button>
            </div>
            <small>{fmt(limit)} can transfer</small>
          </li>
        {/each}
      </ul>
      {#if quote.error}<p role="alert">{quote.error}</p>{/if}
      {#if quote.bandwidth > 0}
        <dl>
          <div><dt>Cargo volume</dt><dd>{fmt(quote.volume)} m³</dd></div>
          <div><dt>Smallest link</dt><dd>{fmt(quote.bandwidth)} m³/h</dd></div>
          <div><dt>Cooldown after transfer</dt><dd>{expeditedTimeWords(quote.cooldownMs)}</dd></div>
        </dl>
      {/if}
    {/if}
    <div class="quantity">
      <button type="button" disabled={submitting || Object.keys(cargo).length === 0} onclick={() => { cargo = {}; }}>Clear quantities</button>
      <button type="button" disabled={!valid} onclick={() => { if (valid) execute(cargo); }}>
        {submitting ? "Transferring…" : "Execute Transfer"}
      </button>
    </div>
  {:else}<p>Choose a linked destination on the planet.</p>{/if}
  {#if submitError}<p role="alert">{submitError}</p>{/if}
</section>

<style>
  .expedited-transfer, label { display: grid; gap: .4rem; }
  header, .commodity, .quantity, dl div { display: flex; align-items: center; gap: .4rem; }
  header, .quantity, dl div { justify-content: space-between; }
  h2, p, dl, dd, ol { margin: 0; }
  h2 { font-size: 1rem; }
  ol { padding-inline-start: 1.4rem; color: #a9d9e3; }
  ul { display: grid; gap: .35rem; list-style: none; margin: 0; padding: 0; }
  ul li { border: 1px solid #46606a; padding: .35rem; display: grid; gap: .2rem; }
  .quantity label { flex: 1; min-width: 0; gap: .1rem; }
  .quantity button { align-self: end; }
  button, select, input { color: inherit; background: #1a2b35; border: 1px solid #536874; padding: .25rem .4rem; font: inherit; min-width: 0; }
  button { cursor: pointer; }
  button:disabled { cursor: default; opacity: .5; }
  [role=alert] { color: #ffca83; }
  small, dt { color: #b5cad4; }
</style>
