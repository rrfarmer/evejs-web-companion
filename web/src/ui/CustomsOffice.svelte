<script lang="ts">
  import { onMount } from "svelte";
  import { errorWords, type AppFlow } from "../app/flow.ts";
  import {
    CUSTOMS_ACCESS_DENIED, customsCommodity, quoteCustomsTransfer, type CustomsOfficeRead, type CustomsTransfer,
  } from "../bridge/customsWrites.ts";
  import { pinDesignator } from "../bridge/planetRouting.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { planetID, pinID, store, flow, close, openCargo }: {
    planetID: number; pinID: number | null; store: ClientStore; flow: AppFlow;
    close: () => void; openCargo: (officeID: number) => Promise<void>;
  } = $props();

  const names = store.names;
  let office = $state.raw<CustomsOfficeRead | null>(null);
  let padID = $state<number | null>(null);
  let imports = $state.raw<CustomsTransfer["imports"]>({});
  let exports = $state.raw<CustomsTransfer["exports"]>({});
  let busy = $state(true);
  let failure = $state("");
  let receipt = $state("");
  const pad = $derived(office?.pads.find(candidate => candidate.pinID === padID));
  const transfer = $derived(pad ? { pinID: pad.pinID, imports, exports } : null);
  const staged = $derived(Object.keys(imports).length > 0 || Object.keys(exports).length > 0);
  const review = $derived.by(() => {
    if (!office || !transfer || !staged) return null;
    try {
      return { quote: quoteCustomsTransfer(office, transfer), error: "" };
    } catch (cause) {
      return { quote: null, error: errorWords(cause) };
    }
  });
  const eligible = (typeID: number) => {
    const type = office?.facts[typeID];
    return !!type && customsCommodity(type);
  };
  const fmt = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const isk = (value: number) => value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function selectPad(id: number | null): void {
    padID = id;
    imports = {};
    exports = {};
  }

  async function read(): Promise<void> {
    const latest = await flow.readCustomsOffice(planetID);
    office = latest;
    selectPad(latest.pads.find(candidate => candidate.pinID === (padID ?? pinID))?.pinID ?? latest.pads[0]?.pinID ?? null);
    flow.requestNames(latest.rows.map(row => ({ kind: "type", id: row.typeID })));
  }

  async function refresh(): Promise<void> {
    busy = true;
    failure = "";
    try {
      await read();
    } catch (cause) {
      office = null;
      failure = errorWords(cause);
    } finally {
      busy = false;
    }
  }

  onMount(() => { void refresh(); });

  function amount(direction: "import" | "export", id: number, value: number): void {
    const quantities = { ...(direction === "import" ? imports : exports) };
    if (value === 0 || Number.isNaN(value)) delete quantities[id];
    else quantities[id] = value;
    if (direction === "import") imports = quantities;
    else exports = quantities;
    receipt = "";
  }

  async function submit(): Promise<void> {
    if (busy || !office || !transfer || !review?.quote) return;
    busy = true;
    failure = "";
    receipt = "";
    try {
      await flow.submitCustomsTransfer(planetID, office, transfer);
      receipt = "Transfer complete.";
    } catch (cause) {
      failure = errorWords(cause);
    }
    try {
      await read();
    } catch (cause) {
      office = null;
      failure = [failure, errorWords(cause)].filter(Boolean).join(" ");
    } finally {
      busy = false;
    }
  }

  async function cargo(): Promise<void> {
    if (!office || busy) return;
    busy = true;
    failure = "";
    try {
      await openCargo(office.officeID);
      close();
    } catch (cause) {
      failure = errorWords(cause);
    } finally {
      busy = false;
    }
  }
</script>

<section class="customs-window" aria-label="Planetary Customs Office" aria-busy={busy}>
  <header>
    <h2>{office?.planetName ? `${office.planetName} Customs Office` : "Planetary Customs Office"}</h2>
    <button type="button" disabled={busy} aria-label="Close customs office" onclick={close}>×</button>
  </header>
  {#if office}
    <div class="controls">
      <label>Launchpad
        <select value={padID ?? ""} disabled={busy || !office.pads.length}
          onchange={event => selectPad(Number(event.currentTarget.value))}>
          {#if !office.pads.length}<option value="">No installed launchpads</option>{/if}
          {#each office.pads as launchpad (launchpad.pinID)}
            <option value={launchpad.pinID}>{launchpad.typeName} · {pinDesignator(launchpad.pinID)}</option>
          {/each}
        </select>
      </label>
      {#if office.taxRate !== null}<span>Tax rate {fmt(office.taxRate * 100)}%</span>{/if}
    </div>
    <div class="holds">
      <section aria-label="Customs office inventory">
        <h3>Customs Office</h3>
        {#if office.capacity}
          <p>{fmt(office.capacity.used)} / {fmt(office.capacity.capacity)} m³</p>
        {/if}
        {#each office.rows as row (row.itemID)}
          {@const name = resolvedName($names.resolved, "type", row.typeID, "Commodity")}
          {@render quantity(name, row.typeID, row.itemID, row.quantity, "import")}
        {:else}
          <p>Customs storage is empty.</p>
        {/each}
      </section>
      <section aria-label="Launchpad inventory">
        <h3>Launchpad</h3>
        {#if pad?.capacityM3 != null && pad.usedM3 != null}
          <p>{fmt(pad.usedM3)} / {fmt(pad.capacityM3)} m³</p>
        {/if}
        {#each pad?.contents ?? [] as row (row.typeID)}
          {@render quantity(row.typeName || "Commodity", row.typeID, row.typeID, row.quantity, "export")}
        {:else}
          <p>{pad ? "Launchpad storage is empty." : "Build a launchpad to transfer goods to or from the planet."}</p>
        {/each}
      </section>
    </div>
    {#if office.taxRate === null}<p role="alert">{CUSTOMS_ACCESS_DENIED}</p>{/if}
    {#if review?.error}<p class="failure" role="alert">{review.error}</p>{/if}
    <footer>
      <button type="button" disabled={busy} onclick={() => void cargo()}>Open Cargo Inventory</button>
      <button type="button" disabled={busy} onclick={() => void refresh()}>Refresh</button>
      {#if review?.quote}
        <span class="tax" aria-live="polite">Transfer tax <strong>{isk(review.quote.importTax + review.quote.exportTax)} ISK</strong></span>
      {/if}
      <button type="button" disabled={busy || !review?.quote} onclick={() => void submit()}>Transfer</button>
    </footer>
  {:else if busy}
    <p role="status">Reading customs office…</p>
  {:else}
    <button type="button" onclick={() => void refresh()}>Retry</button>
  {/if}
  {#if receipt}<p role="status">{receipt}</p>{/if}
  {#if failure}<p class="failure" role="alert">{failure}</p>{/if}
</section>

{#snippet quantity(name: string, typeID: number, id: number, stock: number, direction: "import" | "export")}
  <div class="commodity" data-type-id={typeID}>
    <TypeIcon {typeID} {name} />
    <span>{name}<small>{fmt(stock)} available</small></span>
    <label>{direction === "import" ? "Import" : "Export"}
      <input type="number" min="0" max={stock} step="1" value={(direction === "import" ? imports : exports)[id] ?? 0}
        aria-label={`${direction === "import" ? "Import" : "Export"} ${name}`}
        disabled={busy || !pad || office?.taxRate === null || !eligible(typeID)}
        oninput={event => amount(direction, id, event.currentTarget.valueAsNumber)} />
    </label>
  </div>
{/snippet}

<style>
  .customs-window { position: fixed; z-index: 30; top: min(18vh, 140px); left: 50%; transform: translateX(-50%);
    width: min(650px, calc(100vw - 104px)); max-height: 75vh; overflow: auto; padding: 12px;
    background: #111c24; color: #e1eef3; border: 1px solid #49616d; box-shadow: 0 10px 32px #000a; font: 13px system-ui; }
  header, .controls, footer { display: flex; align-items: center; gap: 8px; }
  header, .controls { justify-content: space-between; margin-bottom: 12px; }
  h2 { font-size: 15px; margin: 0; }
  h3 { font-size: 13px; margin: 0; }
  p { margin: 6px 0; color: #abc0cb; }
  .holds { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 8px; }
  .holds section { min-width: 0; min-height: 75px; max-height: 38vh; overflow: auto;
    border: 1px solid #344753; padding: 8px; background: #0b141b; }
  .commodity { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; gap: 6px; align-items: center;
    padding: 5px 0; border-top: 1px solid #30434e; }
  small { display: block; color: #abc0cb; }
  button, input, select { font: inherit; color: inherit; background: #1c2a34; border: 1px solid #49616d; padding: 4px 6px; }
  input { width: 60px; }
  button:enabled { cursor: pointer; }
  button:disabled, input:disabled { opacity: .5; }
  footer { justify-content: flex-end; flex-wrap: wrap; margin-top: 10px; }
  .tax { margin-left: auto; }
  .failure { color: #ffc797; }
</style>
