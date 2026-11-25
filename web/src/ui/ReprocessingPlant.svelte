<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { refinableHangarStacks } from "../bridge/mining.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { carriesOurPayload, decodeDrag, DRAG_MIME } from "./dragDrop.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { store, flow, inputItems, onInputTaken }: {
    store: ClientStore;
    flow: AppFlow;
    inputItems?: readonly number[] | null;
    onInputTaken?: () => void;
  } = $props();
  const inventory = $derived(store.inventory);
  const mining = $derived(store.mining);
  const names = $derived(store.names);
  const flight = $derived(store.flight);
  const materials = (rows: typeof $inventory.hangar.rows) => {
    const ore = new Set(refinableHangarStacks(rows).map(item => item.itemID));
    return rows.filter(item => item.itemID !== $inventory.activeShipID &&
      item.quantity > 0 && (item.reprocessable || ore.has(item.itemID)));
  };
  const candidates = $derived([
    ...materials($inventory.hangar.rows).map(item => ({ ...item, location: "Item Hangar" })),
    ...materials($inventory.cargo.rows).map(item => ({ ...item, location: "Cargo hold" })),
    ...$mining.holds.filter(hold => hold.key !== "cargo")
      .flatMap(hold => (hold.items ?? []).map(item => ({ ...item, location: hold.label }))),
  ]);
  let selected = $state<number[]>([]);
  let quoteRequested = $state(false);
  let confirming = $state(false);
  let busy = $state(false);
  let inventoryReady = $state(false);
  let error = $state("");
  let result = $state("");
  const selectedHere = $derived(selected.filter(id => candidates.some(item => item.itemID === id)));
  const hasQuote = $derived(quoteRequested && !$mining.quotesError && selectedHere.length > 0 &&
    selectedHere.length === $mining.quotesFor.length && selectedHere.every(id => $mining.quotesFor.includes(id)));
  const quotes = $derived(hasQuote ? $mining.quotes : []);
  const output = $derived.by(() => {
    const quantities = new Map<number, number>();
    for (const row of quotes) {
      for (const item of row.outputs) quantities.set(item.typeID, (quantities.get(item.typeID) ?? 0) + item.quantity);
    }
    return [...quantities].filter(([, quantity]) => quantity > 0);
  });
  const cost = $derived(quotes.length === 0 || quotes.some(row => row.iskCost === null)
    ? null : quotes.reduce((sum, row) => sum + (row.iskCost ?? 0), 0));
  const name = (typeID: number) => resolvedName($names.resolved, "type", typeID, "Unknown item");
  const isk = (amount: number) => amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ISK";

  $effect(() => {
    const types = new Set([...candidates.map(item => item.typeID), ...output.map(([typeID]) => typeID)]);
    if (types.size) flow.requestNames([...types].map(id => ({ kind: "type" as const, id })));
  });

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    error = "";
    try { await action(); }
    catch (cause) { error = panelErrorWords(cause); }
    finally { busy = false; }
  }

  onMount(() => {
    void run(() => flow.loadMiningWindow()).then(() => { inventoryReady = true; });
  });

  $effect(() => {
    if (!inventoryReady || busy || !inputItems?.length) return;
    const ids = inputItems;
    untrack(() => {
      onInputTaken?.();
      appendInputs(ids);
    });
  });

  function select(ids: number[]): void {
    selected = ids;
    quoteRequested = false;
    confirming = false;
    result = "";
  }

  function requestQuote(): void {
    const ids = selectedHere;
    if (ids.length === 0 || !$flight.status?.docked) return;
    confirming = false;
    quoteRequested = false;
    void run(async () => {
      await flow.loadReprocessingQuote(ids);
      quoteRequested = true;
    });
  }

  function overInput(event: DragEvent): void {
    if (!busy && $flight.status?.docked && carriesOurPayload(event.dataTransfer?.types)) event.preventDefault();
  }

  function appendInputs(itemIDs: readonly number[]): void {
    const valid = itemIDs.filter(id => candidates.some(item => item.itemID === id));
    if (valid.length === 0) {
      error = "Choose reprocessable items in your Item Hangar or active ship.";
      return;
    }
    select([...new Set([...selectedHere, ...valid])]);
    requestQuote();
  }

  function addInput(event: DragEvent): void {
    if (busy || !$flight.status?.docked) return;
    const payload = decodeDrag(event.dataTransfer?.getData(DRAG_MIME));
    if (payload?.kind !== "inventoryItem") return;
    event.preventDefault();
    appendInputs(payload.itemIDs ?? [payload.itemID]);
  }

  function reprocess(): void {
    if (!confirming || !hasQuote || cost === null || output.length === 0 || !$flight.status?.docked) return;
    const selection = selectedHere;
    const approved = JSON.stringify(quotes);
    const ids = quotes.filter(row => (row.quantityToProcess ?? 0) > 0).map(row => row.itemID);
    if (!ids.length) return;
    confirming = false;
    void run(async () => {
      await flow.loadReprocessingQuote(selection);
      const refreshed = store.mining.get();
      if (refreshed.quotesError || JSON.stringify(refreshed.quotes) !== approved) {
        error = refreshed.quotesError || "The quote changed. Review the updated yield and cost.";
        return;
      }
      await flow.reprocessItems(ids);
      const state = store.mining.get();
      select([]);
      result = state.actionError || state.silentDecline || (state.lastAction === "Reprocess" ? "Output delivered to your Item Hangar." : "");
    });
  }
</script>

<div class="plant" data-window="reprocessing">
  <div class="plant-panes">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="plant-pane" ondragover={overInput} ondrop={addInput}>
      <h3>Input Materials</h3>
      {#each candidates as item (item.itemID)}
        {@const batch = quotes.find(row => row.itemID === item.itemID)}
        <label class="material">
          <input type="checkbox" checked={selectedHere.includes(item.itemID)} disabled={busy}
            onchange={() => select(selectedHere.includes(item.itemID) ? selectedHere.filter(id => id !== item.itemID) : [...selectedHere, item.itemID])} />
          <TypeIcon typeID={item.typeID} name={name(item.typeID)} size="sm" />
          <span>{name(item.typeID)} <small>{item.location}</small>
            {#if batch?.leftOvers}<small>{batch.leftOvers.toLocaleString()} left over</small>{/if}
          </span>
          <span>{item.quantity.toLocaleString()}</span>
        </label>
      {:else}
        <p>{busy ? "Reading inventory…" : "No reprocessable items in your Item Hangar or active ship."}</p>
      {/each}
    </div>
    <div class="plant-pane">
      <h3>Predicted Output</h3>
      {#each output as [typeID, quantity] (typeID)}
        <div class="material output">
          <TypeIcon {typeID} name={name(typeID)} size="sm" />
          <span>{name(typeID)}</span>
          <span>{quantity.toLocaleString()}</span>
        </div>
      {:else}
        <p>{hasQuote ? "The refinery quoted no output." : "Select materials to see their yield."}</p>
      {/each}
      {#if hasQuote && cost !== null}<p>Cost {isk(cost)}</p>{/if}
    </div>
  </div>
  {#if error || (quoteRequested && $mining.quotesError) || result}
    <p role="status">{error || (quoteRequested && $mining.quotesError) || result}</p>
  {/if}
  <div class="plant-actions">
    {#if confirming && hasQuote && cost !== null}
      <span>Reprocess the quoted materials for {isk(cost)}?</span>
      <button type="button" disabled={busy} onclick={reprocess}>Confirm</button>
      <button type="button" onclick={() => (confirming = false)}>Cancel</button>
    {:else}
      <button type="button" disabled={busy || !selectedHere.length} onclick={requestQuote}>Get Quote</button>
      <button type="button" disabled={busy || cost === null || !output.length} onclick={() => (confirming = true)}>Reprocess</button>
    {/if}
  </div>
</div>

<style>
  .plant { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; gap: 8px; }
  .plant-panes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); flex: 1; min-height: 0; gap: 8px; }
  .plant-pane { min-width: 0; overflow: auto; border: 1px solid rgb(255 255 255 / .14); }
  h3 { font: inherit; font-weight: 600; margin: 0; padding: 6px 8px; background: rgb(255 255 255 / .08); }
  p { margin: 5px 8px; }
  .material { box-sizing: border-box; display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; align-items: center; gap: 6px; padding: 4px; }
  .material.output { grid-template-columns: auto minmax(0, 1fr) auto; }
  small { display: block; opacity: .7; }
  .plant-actions { display: flex; justify-content: end; align-items: center; gap: 6px; flex-wrap: wrap; }
</style>
