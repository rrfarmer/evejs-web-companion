<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { StationOfficeQuote } from "../store/types.ts";
  import { formatIsk } from "./isk.ts";

  let { store, flow, disabled = false }: { store: ClientStore; flow: AppFlow; disabled?: boolean } = $props();
  const station = $derived(store.station);
  const inventory = $derived(store.inventory);
  const words = $derived(store.words);
  const labels = {
    rent: "UI/Station/Lobby/RentOffice",
    unrent: "UI/Station/Hangar/UnrentOffice",
    cancel: "UI/Common/Buttons/Cancel",
  };
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? "") || fallback;
  onMount(() => flow.requestWords(Object.values(labels)));

  const offices = $derived($station.offices);
  const place = $derived($station.online?.structureID ?? $station.online?.stationID ?? null);
  const scope = $derived(`${$station.online?.characterID}:${$station.online?.corporationID}:${place}`);
  const canRent = $derived(place !== null && offices?.available && offices.canRent && !offices.ownOffice);
  const canUnrent = $derived(place !== null && offices?.available && offices.canGiveUp && offices.ownOffice);
  let rent = $state<{ scope: string; quote: StationOfficeQuote } | null>(null);
  let unrent = $state<{ scope: string; hasItems: boolean } | null>(null);
  let error = $state<{ scope: string; text: string } | null>(null);
  let busy = $state(false);
  const rentReview = $derived(canRent && rent?.scope === scope ? rent.quote : null);
  const unrentReview = $derived(canUnrent && unrent?.scope === scope ? unrent : null);

  $effect(() => {
    if (rent && !rentReview) rent = null;
    if (unrent && !unrentReview) unrent = null;
  });

  async function run(action: (currentScope: string) => Promise<void>): Promise<void> {
    if (busy || disabled) return;
    const currentScope = scope;
    busy = true;
    error = null;
    try {
      await action(currentScope);
    } catch (cause) {
      if (scope === currentScope) error = { scope, text: panelErrorWords(cause) };
    } finally {
      busy = false;
    }
  }

  async function quoteRent(currentScope: string): Promise<void> {
    const quote = await flow.quoteStationOffice();
    if (scope === currentScope && canRent) rent = { scope, quote };
  }

  async function payRent(): Promise<void> {
    const quote = rentReview;
    if (!quote) return;
    await flow.rentStationOffice(quote);
    rent = null;
    await flow.loadStationOffices();
  }

  async function readOfficeContents(): Promise<boolean> {
    await flow.loadCorpHangar();
    const corp = inventory.get().corp;
    if (!corp.available || !corp.loaded || !corp.divisions.length || corp.divisions.some(division => division.error)) {
      throw new Error("The office contents could not be checked.");
    }
    return corp.divisions.some(division => division.rows.length > 0);
  }

  async function reviewUnrent(currentScope: string): Promise<void> {
    const hasItems = await readOfficeContents();
    if (scope === currentScope && canUnrent) unrent = { scope, hasItems };
  }

  async function giveUp(currentScope: string): Promise<void> {
    const pending = unrentReview;
    if (!pending) return;
    const hasItems = await readOfficeContents();
    if (scope !== currentScope || !canUnrent) return;
    if (hasItems !== pending.hasItems) {
      unrent = { scope, hasItems };
      error = { scope, text: "The office contents changed. Review the updated confirmation." };
      return;
    }
    await flow.giveUpStationOffice();
    unrent = null;
    await flow.loadStationOffices();
    await flow.loadCorpHangar();
  }
</script>

{#if canRent || canUnrent || (offices?.available && offices.impounded)}
  <div class="office-actions" aria-busy={busy}>
    {#if error?.scope === scope}<p role="status">{error.text}</p>{/if}
    {#if !offices?.ownOffice && offices?.impounded}<p>Your corporation has items impounded here.</p>{/if}
    {#if rentReview}
      <p>Rent this office for {rentReview.days} days? The corporation pays {formatIsk(rentReview.cost.toFixed(2))}.</p>
      <div>
        <button type="button" disabled={busy || disabled} onclick={() => run(payRent)}>Rent it and pay</button>
        <button type="button" disabled={busy || disabled} onclick={() => (rent = null)}>{word(labels.cancel, "Cancel")}</button>
      </div>
    {:else if unrentReview}
      <p>{unrentReview.hasItems ? "Giving up this office will impound the items in its hangars." : "Give up your corporation’s office here?"}</p>
      <div>
        <button type="button" disabled={busy || disabled} onclick={() => run(giveUp)}>Give it up</button>
        <button type="button" disabled={busy || disabled} onclick={() => (unrent = null)}>{word(labels.cancel, "Cancel")}</button>
      </div>
    {:else if canRent}
      <button type="button" disabled={busy || disabled} onclick={() => run(quoteRent)}>{word(labels.rent, "Rent Office")}</button>
    {:else if canUnrent}
      <button type="button" disabled={busy || disabled} onclick={() => run(reviewUnrent)}>{word(labels.unrent, "Unrent Office")}</button>
    {/if}
  </div>
{/if}

<style>
  .office-actions { display: grid; gap: 6px; padding: 6px 4px; font: 12px/1.35 var(--font); }
  .office-actions div { display: flex; flex-wrap: wrap; gap: 6px; }
  .office-actions p { margin: 0; }
  button { color: inherit; font: inherit; cursor: pointer; padding: 4px 8px; text-align: left;
    background: rgba(255, 255, 255, 0.07); border: 1px solid rgba(255, 255, 255, 0.20); }
  button:disabled { opacity: .5; cursor: default; }
</style>
