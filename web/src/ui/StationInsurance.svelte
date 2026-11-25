<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { INSURANCE_PACKAGES, insuranceTerms, type InsurancePackage, type StationInsuranceShip } from "../bridge/stationInsurance.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { store, flow, placeID }: { store: ClientStore; flow: AppFlow; placeID: number } = $props();
  const names = $derived(store.names);
  let ships = $state<readonly StationInsuranceShip[]>([]);
  let selected = $state<number | null>(null);
  let tier = $state<InsurancePackage>("Basic");
  let action = $state<"buy" | "cancel" | null>(null);
  let confirmed = $state(false);
  let busy = $state(false);
  let error = $state("");
  let status = $state("");
  const chosen = $derived(ships.find(ship => ship.itemID === selected));
  const terms = $derived(chosen ? insuranceTerms(chosen.insuredValue, tier) : null);
  const name = (typeID: number) => resolvedName($names.resolved, "type", typeID, "Ship");
  const isk = (amount: number) => amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ISK";
  const date = (time: number | null) => time === null ? "—" : new Date(time).toLocaleDateString();
  const packageOf = (fraction: number) => INSURANCE_PACKAGES[Math.round(fraction * 10) - 5] ?? `${Math.round(fraction * 100)}% payout`;

  async function run(task: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    error = "";
    status = "";
    try { await task(); }
    catch (cause) { error = panelErrorWords(cause); }
    finally { busy = false; }
  }

  function pick(shipID: number | null): void {
    selected = shipID;
    action = null;
    confirmed = false;
  }

  async function refresh(): Promise<void> {
    ships = await flow.loadStationInsurance(placeID);
    if (selected !== null && !ships.some(ship => ship.itemID === selected)) pick(null);
  }

  onMount(() => { void run(refresh); });

  function finish(): void {
    const ship = chosen, quote = terms, what = action;
    if (!ship || !confirmed || !what || busy) return;
    // Clear approval before sending a write so a failed refresh cannot submit it again.
    confirmed = false;
    action = null;
    void run(async () => {
      if (what === "buy") {
        if (!quote) return;
        await flow.buyStationInsurance(placeID, ship.itemID, tier, quote.premium, ship.contract?.id ?? null);
      } else {
        if (!ship.contract) return;
        await flow.cancelStationInsurance(placeID, ship.itemID, ship.contract.id);
      }
      await refresh();
      const updated = ships.find(row => row.itemID === ship.itemID);
      if (!updated || (what === "buy" ? updated.contract?.fraction !== quote?.fraction : updated.contract !== null)) {
        throw new Error("The updated insurance contract could not be verified.");
      }
      status = what === "buy" ? tier + " insurance purchased." : "Insurance canceled.";
    });
  }
</script>

<div class="insurance" data-window="insurance" aria-busy={busy}>
  <table class="hulls">
    <thead><tr><th>Ship</th><th>Coverage</th><th>Starts</th><th>Expires</th></tr></thead>
    <tbody>
      {#each ships as ship (ship.itemID)}
        <tr>
          <td>
            <button type="button" class="hull" aria-pressed={selected === ship.itemID} disabled={busy} onclick={() => pick(ship.itemID)}>
              <TypeIcon typeID={ship.typeID} name={name(ship.typeID)} size="sm" />
              {name(ship.typeID)}
            </button>
          </td>
          <td>{ship.contract ? packageOf(ship.contract.fraction) : "Uninsured"}</td>
          <td>{ship.contract ? date(ship.contract.startsAt) : "—"}</td>
          <td>{ship.contract ? date(ship.contract.expiresAt) : "—"}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if !ships.length && !busy && !error}<p>No insurable ships in your personal hangar.</p>{/if}
  {#if error || status}<p role="status">{error || status}</p>{/if}
  {#if chosen && action === "buy" && !confirmed}
    <fieldset disabled={busy}>
      <legend>Insurance Terms · {name(chosen.typeID)}</legend>
      <div class="terms-heading"><span>Package</span><span>Cost</span><span>Estimated payout</span></div>
      {#each INSURANCE_PACKAGES as option (option)}
        {@const details = insuranceTerms(chosen.insuredValue, option)!}
        <label class="terms">
          <span><input type="radio" name="insurance-package" value={option} bind:group={tier} /> {option}</span>
          <span>{isk(details.premium)}</span>
          <span>{isk(details.payout)}</span>
        </label>
      {/each}
    </fieldset>
  {/if}
  {#if chosen && confirmed}
    <p>{action === "cancel"
      ? `Cancel coverage on ${name(chosen.typeID)}? The premium is not refunded.`
      : `${chosen.contract ? "Replace existing coverage with" : "Buy"} ${tier} insurance for ${name(chosen.typeID)} for ${isk(terms!.premium)}?`}</p>
  {/if}
  <div class="actions">
    {#if confirmed}
      <button type="button" disabled={busy} onclick={finish}>Confirm</button>
      <button type="button" onclick={() => (confirmed = false)}>Back</button>
    {:else if action === "buy"}
      <button type="button" disabled={busy || !terms} onclick={() => (confirmed = true)}>Review Purchase</button>
      <button type="button" onclick={() => (action = null)}>Cancel</button>
    {:else}
      <button type="button" disabled={busy || !chosen} onclick={() => (action = "buy")}>Insure</button>
      {#if chosen?.contract}
        <button type="button" disabled={busy} onclick={() => { action = "cancel"; confirmed = true; }}>Cancel Insurance</button>
      {/if}
      <button type="button" disabled={busy} onclick={() => void run(refresh)}>Refresh</button>
    {/if}
  </div>
</div>

<style>
  .insurance { font-size: 13px; }
  .hulls { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 4px; border-bottom: 1px solid rgb(255 255 255 / .12); }
  .hull { display: flex; align-items: center; gap: 6px; text-align: left; }
  .hull[aria-pressed="true"] { outline: 1px solid var(--theme-focus, #58a7bf); }
  fieldset { margin: 12px 0 0; border: 1px solid rgb(255 255 255 / .2); }
  .terms, .terms-heading { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; padding: 4px 0; font-size: 12px; }
  .terms-heading { font-weight: 600; }
  .actions { display: flex; flex-wrap: wrap; justify-content: end; gap: 6px; margin-top: 12px; }
</style>
