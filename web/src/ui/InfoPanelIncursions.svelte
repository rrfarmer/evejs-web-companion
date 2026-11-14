<script lang="ts">
  // infoPanels/infoPanelIncursions.InfoPanelIncursions (PANEL_INCURSIONS, after the route's in PANELTYPES;
  // taleDefaultIcon.png). IsAvailable: incursionSvc.IsIncursionActive - an incursion's tale is held (flow.incursion).
  // - The header: UI/Incursion/HUD/IncursionProfileTitle, after it the subtitle (SCENETYPE_DATA[severity].subTitle);
  //   in compact mode a SystemInfluenceBar in the header's place.
  // - SystemInfluenceBar (12 high): the influence's share (CalculateDecayedInfluence) in cyan (0, 1, 1, 0.25), the rest
  //   in red (1, 0, 0, 0.25), a knob between; its hint UI/Incursion/HUD/InfluenceBarHint {influence: round((1 -
  //   influence) * 100)}.
  // - Under it (33 high): the severity icon (32, its hint SCENETYPE_DATA's), the system effects (TaleSystemEffect, 22
  //   square, 6 apart; at 0.25 opacity where scalable and the influence is full, else 0.75; each its hint's words), and
  //   at the right the final encounter's mothership icon (COLOR_ENABLED where it has spawned, else COLOR_DISABLED; its
  //   hint IncursionFinalEncounterReportHint / NoIncursionFinalEncounterHint).
  // The influence is read again every minute (INCURSION_UPDATE_RATE 60000). Not here: the bar's moving arrows, the
  // title's link to the journal's incursion tab, the incursion chat, sounds and the system environment.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { SCENETYPE_DATA, decayedInfluence } from "../bridge/incursion.ts";
  import { clientTexture } from "../play/window.ts";
  let { store, flow, compact, onToggle }: { store: ClientStore; flow: AppFlow; compact: boolean; onToggle: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const incursion = flow.incursion;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const H = "UI/Incursion/HUD/";
  const systemID = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  $effect(() => { flow.requestTaleData(systemID); });
  const data = $derived($incursion);
  const scene = $derived(data ? SCENETYPE_DATA[data.severity] ?? null : null);
  $effect(() => {
    flow.requestWords([H + "IncursionProfileTitle", H + "InfluenceBarHint", H + "IncursionFinalEncounterReportHint", H + "NoIncursionFinalEncounterHint",
      ...(scene ? [scene.subTitle, scene.hint] : []), ...(data?.effects ?? []).map((e) => e.hint).filter(Boolean)]);
  });
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (k, id) => resolvedName($names.resolved, k, id, "") }));
  let now = $state(Date.now());
  $effect(() => { const t = setInterval(() => { now = Date.now(); }, 60_000); return () => clearInterval(t); });
  const influence = $derived(data ? decayedInfluence(data.influence, now) : 0);
  const barHint = $derived(word(H + "InfluenceBarHint", { influence: Math.round((1 - influence) * 100) }));
</script>

{#snippet bar()}
  <div class="ic-bar" title={barHint}><span class="ic-blue" style:width={`${influence * 100}%`}></span><span class="ic-knob"></span><span class="ic-red"></span></div>
{/snippet}

{#if data}
  <section class="ip-panel">
    <div class="ip-top">
      <div class="ip-gutter">
        <button type="button" class="ip-expand" class:expanded={!compact} aria-label={compact ? "Expand" : "Collapse"} onclick={onToggle}>
          <img alt="" src={clientTexture("res:/UI/Texture/classes/Neocom/arrowDown.png")} /></button>
        <span class="ip-icon"><img alt="" src={clientTexture("res:/UI/Texture/Classes/InfoPanels/taleDefaultIcon.png")} /></span>
      </div>
      {#if compact}<div class="ic-head-bar">{@render bar()}</div>
      {:else}<span class="ic-title">{word(H + "IncursionProfileTitle")}</span>{#if scene}<span class="ic-sub">{word(scene.subTitle)}</span>{/if}{/if}
    </div>
    {#if !compact}
      <div class="ip-main">
        {@render bar()}
        <div class="ic-bottom">
          {#if scene?.severityIcon}<img class="ic-severity" alt="" title={word(scene.hint)} src={clientTexture(scene.severityIcon)} />{/if}
          <div class="ic-effects">
            {#each data.effects as e (e.name)}<img alt="" title={word(e.hint)} style:opacity={e.isScalable && influence >= 1 ? 0.25 : 0.75} src={clientTexture(e.texturePath)} />{/each}
          </div>
          <img class="ic-final" alt="" style:opacity={data.hasFinalEncounter ? 0.75 : 0.25}
            title={word(H + (data.hasFinalEncounter ? "IncursionFinalEncounterReportHint" : "NoIncursionFinalEncounterHint"))} src={clientTexture("res:/UI/Texture/classes/Incursions/iconMothership.png")} />
        </div>
      </div>
    {/if}
  </section>
{/if}

<style>
  .ip-panel { pointer-events: auto; margin-bottom: 6px; }
  .ip-top { display: flex; align-items: center; min-height: 28px; gap: 4px; }
  .ip-gutter { display: flex; width: 56px; flex: none; }
  .ip-expand, .ip-icon { all: unset; cursor: pointer; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; opacity: 0.8; }
  .ip-expand img { width: 7px; height: 7px; transform: rotate(-90deg); }
  .ip-expand.expanded img { transform: none; }
  .ip-icon img { width: 18px; height: 18px; }
  .ic-title { font-size: 14px; letter-spacing: 0.04em; color: rgb(255 255 255 / 0.85); }
  .ic-sub { font-size: 13px; color: rgb(255 255 255 / 0.7); margin-top: 3px; }
  .ic-head-bar { flex: 1; padding: 6px 24px 6px 0; }
  .ip-main { padding-left: 56px; }
  .ic-bar { display: flex; height: 12px; margin: 4px 0; }
  .ic-blue { background: rgb(0 255 255 / 0.25); }
  .ic-knob { width: 1px; background: rgb(128 128 128); }
  .ic-red { flex: 1; background: rgb(255 0 0 / 0.25); }
  .ic-bottom { position: relative; display: flex; align-items: center; height: 33px; gap: 8px; }
  .ic-severity { width: 32px; height: 32px; }
  .ic-effects { display: flex; gap: 6px; }
  .ic-effects img { width: 22px; height: 22px; }
  .ic-final { margin-left: auto; width: 32px; height: 32px; }
</style>
