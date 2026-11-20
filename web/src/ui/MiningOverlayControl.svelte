<script lang="ts">
  import type { ClientStore } from "../store/clientStore.ts";
  import { INTEGRATED_MINING_SCANNER, MINING_SCANNER_UPGRADE, miningScanInWarp } from "../bridge/miningScanResults.ts";
  import type { FlightMiningSurvey } from "../play/miningSurveyWave.ts";
  import { hudSettingNow } from "../store/hudSettings.ts";

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
  // The new HUD (hud/client/utility_buttons/mining_scanner_button.py): a 32 px utility button in the utility column at
  // band (25, 122), its glyph by the scanner upgrade tier; the classic HUD keeps its labelled control.
  const newHud = hudSettingNow("shipHudNew_preview");
  const tier = $derived(($fitting.shipAttributes?.[MINING_SCANNER_UPGRADE] ?? 0));
  const glyph = $derived(`/client-res/ui/texture/eveicon/control_icons/mining_overlay_toggle_${tier >= 3 ? "fleet_shared" : tier >= 2 ? "local" : "default"}_16px.png`);

  function run() {
    menu = false;
    void survey.scan().catch(() => {});
  }

  function showOptions(event: MouseEvent) {
    event.preventDefault();
    menu = !menu;
  }
</script>

{#if supported && newHud}
  <div class="new-hud-mining" class:busy={$busy} role="group" aria-label="Mining overlay controls">
    <button type="button" class="util" onclick={run} oncontextmenu={showOptions}
      title={detailed ? "Detailed mining scan" : "Basic mining scan"} disabled={miningScanInWarp($space.snapshot)}>
      <span class="pulse"></span><img src={glyph} alt="" width="16" height="16" />
    </button>
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
{:else if supported}
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
  /* UtilityButtonBase: ring r 15 w 2 (white 0.2, FOCUS_BLUE on hover), disc r 14 (black 0.1, SMOKE_BLUE on hover),
     a 30 px underlay black 0.4; the glyph 0.5 at rest, 1 on hover; a press dips it 2 px. */
  .new-hud-mining { position: absolute; left: calc(50% - 591px + 300px + 25px - 16px); bottom: 82px; z-index: 4; }
  .new-hud-mining .util {
    position: relative; width: 32px; height: 32px; padding: 0; border-radius: 50%; display: grid; place-items: center;
    background: radial-gradient(circle, rgba(0,0,0,0.1) 0 14px, transparent 14.5px), radial-gradient(circle, rgba(0,0,0,0.4) 0 15px, transparent 15.5px);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.2), 0 0 0 1px rgba(255,255,255,0.2);
  }
  .new-hud-mining .util:hover:not(:disabled) { background: radial-gradient(circle, #305665 0 14px, transparent 14.5px); box-shadow: 0 0 0 2px #58a7bf; }
  .new-hud-mining .util:active:not(:disabled) { transform: translateY(2px); }
  .new-hud-mining .util img { opacity: .5; mix-blend-mode: plus-lighter; }
  .new-hud-mining .util:hover img { opacity: 1; }
  .new-hud-mining .pulse { position: absolute; inset: 0; border-radius: 50%; background: url("/client-res/ui/texture/classes/shipui/utilbtnglow.png") center / 32px 32px; opacity: 0; mix-blend-mode: plus-lighter; }
  .new-hud-mining.busy .pulse { animation: mining-pulse 1.6s ease-in-out infinite; }
  @keyframes mining-pulse { 0%, 100% { opacity: 0; } 50% { opacity: .2; } }
  .new-hud-mining .flight-mining-actions { bottom: calc(100% + 4px); left: 0; }
</style>
