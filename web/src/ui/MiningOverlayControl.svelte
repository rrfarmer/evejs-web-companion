<script lang="ts">
  import type { ClientStore } from "../store/clientStore.ts";
  import { INTEGRATED_MINING_SCANNER, MINING_SCANNER_UPGRADE, miningScanInWarp } from "../bridge/miningScanResults.ts";
  import type { FlightMiningSurvey } from "../play/miningSurveyWave.ts";

  let { store, survey, openResults, openLedger, disable }: {
    store: ClientStore;
    survey: FlightMiningSurvey;
    openResults: () => void;
    openLedger: () => void;
    disable: () => void;
  } = $props();
  const flight = $derived(store.flight);
  const fitting = $derived(store.fitting);
  const space = $derived(store.space);
  const mining = $derived(store.mining);
  const busy = $derived(survey.busy);
  const shipID = $derived($space.snapshot?.shipID ?? $flight.status?.shipID);
  const supported = $derived(shipID != null && shipID === $fitting.activeShipID &&
    ($fitting.shipAttributes?.[INTEGRATED_MINING_SCANNER] ?? 0) > 0);
  const detailed = $derived(($fitting.shipAttributes?.[MINING_SCANNER_UPGRADE] ?? 0) > 0);
  const active = $derived($mining.surveyAtMs !== null);
  let menu = $state(false);

  function run() {
    menu = false;
    void survey.scan().catch(() => {});
  }

  function showOptions(event: MouseEvent) {
    event.preventDefault();
    menu = !menu;
  }
</script>

{#if supported}
  <div class="flight-mining-control" class:active aria-label="Mining overlay controls" role="group">
    <button type="button" class="mining-overlay-scan" onclick={run} oncontextmenu={showOptions}
      title={detailed ? "Detailed mining scan" : "Basic mining scan"} disabled={$busy || miningScanInWarp($space.snapshot)}>
      {$busy ? "Scanning…" : "Mining Scan"}
    </button>
    <button type="button" aria-label="Mining scan options" aria-expanded={menu}
      onclick={() => { menu = !menu; }}
      oncontextmenu={showOptions}>⋯</button>
    {#if menu}
      <div class="flight-mining-actions">
        <button type="button" onclick={() => { menu = false; openResults(); }}>Open Scan Results</button>
        <button type="button" onclick={() => { menu = false; openLedger(); }}>Open Mining Ledger</button>
        {#if active || $busy}
          <button type="button" onclick={() => { menu = false; disable(); }}>Disable Mining Overlay</button>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .flight-mining-control {
    position: absolute; left: max(56px, calc(50% - 137px)); bottom: 157px; z-index: 4;
    display: flex; background: #141d24ee; border: 1px solid #54636a; border-radius: 4px;
  }
  .flight-mining-control.active { border-color: #81c6ac; }
  button {
    border: 0; padding: 5px 8px; background: transparent; color: #e6f1f2;
    font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer;
  }
  button:disabled { opacity: .56; cursor: default; }
  button:hover:not(:disabled) { background: #ffffff17; }
  .flight-mining-actions {
    position: absolute; bottom: calc(100% + 4px); left: 0; display: grid;
    border: 1px solid #58666e; background: #111920f5; padding: 2px;
  }
  .flight-mining-actions button { text-align: left; }
</style>
