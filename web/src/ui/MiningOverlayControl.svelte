<script lang="ts">
  import { notePanelClosed, panelDelay } from "../play/labelShortcutTooltip.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { INTEGRATED_MINING_SCANNER, MINING_SCANNER_UPGRADE, miningScanInWarp } from "../bridge/miningScanResults.ts";
  import type { FlightMiningSurvey } from "../play/miningSurveyWave.ts";
  import { hudSettingNow } from "../store/hudSettings.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { ContextMenu } from "../play/contextMenu.ts";
  import { onDestroy } from "svelte";
  import { placePointerPanel } from "../play/labelShortcutTooltip.ts";
  import { playUiEvent } from "../play/uiAudio.ts";
  let { store, survey, openResults, openLedger, disable, requestWords }: {
    store: ClientStore;
    survey: FlightMiningSurvey;
    openResults: () => void;
    openLedger: () => void;
    disable: () => void;
    requestWords?: (labels: readonly string[]) => void;
  } = $props();
  // the client's words (MiningScannerButton.GetMenu and LoadTooltipPanel)
  const WORDS = ["Tooltips/Hud/MiningScan", "Tooltips/Hud/MiningScan_description", "UI/Mining/OreValue", "UI/Mining/LowValue", "UI/Mining/HighValue", "UI/Mining/OpenScanResultsWindow",
    "UI/Mining/OpenMiningLedger", "UI/Mining/DisableMiningOverlay", "UI/Mining/MiningScannerUpgradeRequired"];
  $effect(() => { requestWords?.(WORDS); });
  const words = $derived(store.words);
  const say = (label: string, own: string): string => {
    const t = $words.templates[label];
    return typeof t === "string" && t !== "" ? plainText(t) : own;
  };
  /** UI/Mining/MiningScannerUpgradeRequired with its module_name (typeSurveyScannerI 444's link): the text without its markup. */
  const upgradeNote = $derived.by(() => {
    const t = $words.templates["UI/Mining/MiningScannerUpgradeRequired"];
    return typeof t === "string" && t !== "" ? plainText(t.replace(/\{module_name\}/g, "Mining Survey Chipset")) : null;
  });
  /** The tooltip (UtilityButton's command tooltip, then the ore value scale): where it stands, null while hidden. */
  let tip = $state<{ anchor: DOMRect } | null>(null);
  // MiningScannerButton has no tooltipPointer: the panel's own default_pointerDirection, POINT_BOTTOM_2 (above the
  // button, centred), with pointerPanel.UpdatePanelPosition's fallbacks; placed again as its lines settle
  let tipEl = $state<HTMLDivElement | null>(null);
  $effect(() => {
    const el = tipEl, anchor = tip?.anchor;
    if (!el || !anchor) return;
    const place = () => placePointerPanel(el, anchor, "BOTTOM_2");
    place();
    const seen = new ResizeObserver(place);
    seen.observe(el);
    return () => seen.disconnect();
  });
  let tipTimer: ReturnType<typeof setTimeout> | null = null;
  function tipOn(e: MouseEvent): void {
    // UtilityButton.OnMouseEnter: SOUND_BUTTON_HOVER
    if (!(e.currentTarget as HTMLButtonElement).disabled) void playUiEvent("ui_button_soft1_play");
    const el = e.currentTarget as HTMLElement;
    if (tipTimer) clearTimeout(tipTimer);
    // no GetTooltipDelay: the generic delay, the renew time while a panel shows or just closed
    tipTimer = setTimeout(() => { const r = el.getBoundingClientRect(); tip = { anchor: r }; }, panelDelay(tip !== null));
  }
  function tipOff(): void { if (tipTimer) clearTimeout(tipTimer); tipTimer = null; if (tip !== null) notePanelClosed(); tip = null; }
  const flight = $derived(store.flight);
  const fitting = $derived(store.fitting);
  const space = $derived(store.space);
  const mining = $derived(store.mining);
  const busy = $derived(survey.busy);
  /**
   * MiningScannerButton's scanPulse: OnScanEffectStarted FadeTo(0 -> PULSE_PEAK 0.2, PULSE_PERIOD_SEC 1.6, ANIM_REPEAT,
   * ANIM_WAVE) - each half a smoothstep; OnScanEffectCompleted FadeOut(PULSE_FADE_OUT_SEC 0.6) from wherever the wave is, on
   * FadeOut's default ANIM_SMOOTH (the page had dropped it to 0 at once).
   */
  function scanPulse(node: HTMLElement, on: boolean) {
    let wave: Animation | null = null;
    const set = (next: boolean) => {
      if (next) {
        if (wave) return;
        wave = node.animate([{ opacity: 0, easing: "cubic-bezier(0.3333, 0, 0.6667, 1)" }, { opacity: 0.2, easing: "cubic-bezier(0.3333, 0, 0.6667, 1)" }, { opacity: 0 }], { duration: 1600, iterations: Infinity });
      } else if (wave) {
        const from = Number(getComputedStyle(node).opacity);
        wave.cancel();
        wave = null;
        node.animate([{ opacity: from }, { opacity: 0 }], { duration: 600, easing: "cubic-bezier(0.3333, 0, 0.6667, 1)" });
      }
    };
    set(on);
    return { update: set, destroy: () => wave?.cancel() };
  }
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
  // _GLYPH_BY_TIER: MiningScan.TIER_2 (1) mining_overlay_toggle_local, TIER_3 (2) fleet_shared, any other the default
  // (mining.MiningScan: TIER_1 0, TIER_2 1, TIER_3 2; the tier is int(attributeMiningScannerUpgrade))
  const glyph = $derived(`/client-res/ui/texture/eveicon/control_icons/mining_overlay_toggle_${Math.trunc(tier) === 2 ? "fleet_shared" : Math.trunc(tier) === 1 ? "local" : "default"}_16px.png`);

  function run() {
    // UtilityButton.OnClick: SOUND_BUTTON_CLICK
    void playUiEvent("ui_button_soft4_play");
    menu = false;
    void survey.scan().catch(() => {});
  }

  /**
   * MiningScannerButton.GetMenu as a MenuData: Open Scan Results Window (eveicon.open_window), Open Mining Ledger
   * (eveicon.mining) and, with the overlay on, a separator and Disable (eveicon.close) - the client's context menu.
   */
  const optionsMenu = new ContextMenu();
  onDestroy(() => optionsMenu.close());
  function showOptions(event: MouseEvent) {
    event.preventDefault();
    const icon = (n: string) => `res:/UI/Texture/eveicon/system_icons/${n}_16px.png`;
    optionsMenu.open(event.clientX, event.clientY, [
      { label: say("UI/Mining/OpenScanResultsWindow", "Open Scan Results Window"), icon: icon("open_window"), run: openResults },
      { label: say("UI/Mining/OpenMiningLedger", "Open Mining Ledger"), icon: icon("mining"), run: openLedger },
      ...(active || $busy ? [null, { label: say("UI/Mining/DisableMiningOverlay", "Disable Mining Survey Overlay"), icon: icon("close"), run: disable }] : []),
    ]);
  }
</script>

{#if supported && newHud}
  <div class="new-hud-mining" class:busy={$busy} role="group" aria-label="Mining overlay controls">
    <button type="button" class="util" onclick={run} oncontextmenu={(e) => { tipOff(); showOptions(e); }}
      onmouseenter={tipOn} onmouseleave={tipOff} disabled={miningScanInWarp($space.snapshot)}>
      <span class="pulse" use:scanPulse={$busy}></span><img src={glyph} alt="" width="16" height="16" />
    </button>
    {#if tip}
      <!-- MiningScannerButton.LoadTooltipPanel: the command's tooltip (CmdMiningScan, Tooltips/Hud/MiningScan, no
           shortcut by default), "Ore Value" over a 200 x 8 gradient (ULTRAMARINE_BLUE, AIR_TURQUOISE, SAND_YELLOW) with
           Low and High under it; below MiningScan.TIER_2 (the attribute under 1), the upgrade note in the secondary colour, 200 wide -->
      <div class="mining-tip" bind:this={tipEl}>
        <div class="mt-frame"></div>
        <div class="mt-body">
          <b>{say("Tooltips/Hud/MiningScan", "Mining Surveyor")}</b>
          <span class="mt-desc">{say("Tooltips/Hud/MiningScan_description", "Survey nearby minable asteroids")}</span>
          <span class="mt-label">{say("UI/Mining/OreValue", "Ore Value")}</span>
          <span class="mt-bar"></span>
          <span class="mt-ends"><span>{say("UI/Mining/LowValue", "Low")}</span><span>{say("UI/Mining/HighValue", "High")}</span></span>
          {#if tier < 1 && upgradeNote}<span class="mt-note">{upgradeNote}</span>{/if}
        </div>
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
      onclick={showOptions}
      oncontextmenu={showOptions}>⋯</button>
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
  .flight-mining-actions .sep { height: 1px; margin: 2px 4px; background: #ffffff22; }
  .mining-tip { position: fixed; z-index: 100000; pointer-events: none; padding: 16px; font: 14px var(--font); color: rgba(255, 255, 255, 0.75); }
  .mt-frame { position: absolute; inset: 0; opacity: 0.75; border-style: solid; border-width: 0; border-image-source: url(/client-res/ui/texture/classes/framewithpointer/background_04.png); border-image-slice: 19 fill; border-image-width: 19px; border-image-outset: 15px; }
  /* LoadGeneric2ColumnTemplate: cells 8 apart, EveLabelMedium / TextBody lines 18 high (the live client, gridcheck g232:
     title 16, description 42, Ore Value 94 after its padTop 8, gradient 120, Low / High 136) */
  .mt-body { position: relative; display: grid; gap: 8px; width: 200px; line-height: 18px; }
  .mt-body b { color: rgba(255, 255, 255, 0.75); white-space: nowrap; }
  .mt-label { padding-top: 8px; }
  .mt-desc { color: rgba(255, 255, 255, 0.5); }
  .mt-bar { height: 8px; background: linear-gradient(to right, #2e4ebe, #70f0e3, #ffb845); }
  .mt-ends { display: flex; justify-content: space-between; }
  .mt-note { padding-top: 8px; color: rgba(255, 255, 255, 0.5); }
  /* UtilityButtonBase: ring r 15 w 2 (white 0.2, FOCUS_BLUE on hover), disc r 14 (black 0.1, SMOKE_BLUE on hover),
     a 30 px underlay black 0.4; the glyph 0.5 at rest, 1 on hover; a press dips it 2 px. */
  .new-hud-mining { position: absolute; left: calc(50% - 591px + 300px + 25px - 16px); bottom: 82px; z-index: 4; }
  .new-hud-mining .util {
    position: relative; width: 32px; height: 32px; padding: 0; border-radius: 50%; display: grid; place-items: center;
    background: radial-gradient(circle, rgba(0,0,0,0.1) 0 14px, transparent 14.5px), radial-gradient(circle, rgba(0,0,0,0.4) 0 15px, transparent 15.5px);
    box-shadow: inset 0 0 0 2px rgba(255,255,255,0.2);
  }
  /* UtilityButtonBase.SetVisualState: the disc (r 14) black 0.1, SMOKE_BLUE hovered or pressed; the ring (r 15, 2 wide) white
     0.2, FOCUS_BLUE active; the press ring (r 16, 4 wide, FOCUS_BLUE) while pressed; the underlay (30 px, black 0.4) always;
     a press dips PRESS_DIP_PX 2 */
  .new-hud-mining .util:hover:not(:disabled) { background: radial-gradient(circle, #305665 0 14px, transparent 14.5px), radial-gradient(circle, rgba(0,0,0,0.4) 0 15px, transparent 15.5px); box-shadow: inset 0 0 0 2px #58a7bf; }
  .new-hud-mining .util:active:not(:disabled) { transform: translateY(2px); background: radial-gradient(circle, #305665 0 14px, transparent 14.5px), radial-gradient(circle, rgba(0,0,0,0.4) 0 15px, transparent 15.5px); box-shadow: inset 0 0 0 2px #58a7bf, 0 0 0 2px #58a7bf; }
  .new-hud-mining .util:active:not(:disabled) img { opacity: 1; }
  .new-hud-mining .util img { opacity: .5; mix-blend-mode: plus-lighter; }
  .new-hud-mining .util:hover img { opacity: 1; }
  .new-hud-mining .pulse { position: absolute; inset: 0; border-radius: 50%; background: url("/client-res/ui/texture/classes/shipui/utilbtnglow.png") center / 32px 32px; opacity: 0; mix-blend-mode: plus-lighter; }
  .new-hud-mining .flight-mining-actions { bottom: calc(100% + 4px); left: 0; }
</style>
