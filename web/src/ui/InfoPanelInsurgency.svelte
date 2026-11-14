<script lang="ts">
  // infoPanels/infoPanelInsurgency.InfoPanelInsurgency (PANEL_INSURGENCY 25, after the job board's in PANELTYPES;
  // eveicon pirate_insurgencies). IsAvailable: insurgencyDashboardSvc.IsSystemAffectedByInsurgency - a visible
  // campaign covers the pilot's system (flow.insurgencyLocal).
  // - The header: UI/PirateInsurgencies/dashboardCaption; in compact mode (an active campaign) the corruption's and
  //   suppression's small gauges (20) beside it.
  // - Forecasting (CAMPAIGN_STATE_FORECASTING): UI/PirateInsurgencies/nextInsurgencyIn and the time to the state's
  //   expiry (FormatTimeIntervalShort, hours to seconds, each second), its hint forecastingTooltip.
  // - Active: the corruption (left) and suppression (right), 90 wide each: the stage gauge (64: a segment a stage,
  //   SEPERATOR_SIZE 0.02 between; the progress in the stroke colour - corruption #9EFF00, or the pirate faction's for
  //   its own militia; suppression white; the stage the progress is in drawn thicker; the background GUNMETAL_GREY), the
  //   stage's icon inside (corr_N / supp_N); UI/PirateInsurgencies/stageLabel {stage} in bold, then corruption /
  //   suppression. On hover the percentage ({:.1%}) over a circle; the hint the stages' system effects
  //   (SystemEffects/CorruptionStage{i}Effect, SuppressionStage{i}Effect, stage 3's Effect1 and Effect2) up to the stage.
  // Not here: a pirate militia's own corruption colour, the Vanguard's share in the gauges and hints, the warehouse raid scoreboard (towGameSvc), the title's
  // dashboard link, the notices' live updates.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, InsurgencyLocal, InsurgencyProgress } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "../play/window.ts";
  let { store, flow, compact, onToggle }: { store: ClientStore; flow: AppFlow; compact: boolean; onToggle: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const P = "UI/PirateInsurgencies/";
  const systemID = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  let ins = $state<InsurgencyLocal | null>(null);
  $effect(() => {
    const asked = systemID;
    if (asked === null) { ins = null; return; }
    void flow.insurgencyLocal().then((read) => { if (asked === systemID) ins = read; }, () => { ins = null; });
  });
  const effectLabels = (kind: "Corruption" | "Suppression", stage: number) => Array.from({ length: Math.max(0, stage) }, (_, i) => i + 1)
    .flatMap((i) => (kind === "Suppression" && i === 3 ? [`${P}SystemEffects/SuppressionStage3Effect1`, `${P}SystemEffects/SuppressionStage3Effect2`] : [`${P}SystemEffects/${kind}Stage${i}Effect`]));
  $effect(() => {
    flow.requestWords([P + "dashboardCaption", P + "nextInsurgencyIn", P + "forecastingTooltip", P + "stageLabel", P + "corruption", P + "suppression",
      ...effectLabels("Corruption", ins?.corruption?.stage ?? 0), ...effectLabels("Suppression", ins?.suppression?.stage ?? 0)]);
  });
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (k, id) => resolvedName($names.resolved, k, id, "") }));
  let now = $state(Date.now());
  $effect(() => { if (ins?.fsmState !== 2) return; const t = setInterval(() => { now = Date.now(); }, 1000); return () => clearInterval(t); });
  const countdown = $derived.by(() => {
    if (!ins?.stateExpiryMs) return "";
    const s = Math.max(0, Math.floor((ins.stateExpiryMs - now) / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return `${h}h ${m}m ${s % 60}s`;
  });
  // AbstractIncursionStageGauge.LoadGaugeData: per stage, the progress within it less the separator, then the separator;
  // a conic gradient of the segments over the stages' background.
  function gradient(stages: readonly number[], progress: number, color: string): string {
    const stops: string[] = [];
    let prev = 0;
    for (const t of stages) {
      const fill = Math.max(0, Math.min(progress, t) - prev - 0.02);
      const a = prev * 100, b = (prev + fill) * 100, c = (t - 0.02) * 100, d = t * 100;
      stops.push(`${color} ${a}% ${b}%`, `#4a4f55 ${b}% ${c}%`, `transparent ${c}% ${d}%`);
      prev = t;
    }
    return `conic-gradient(${stops.join(", ")})`;
  }
  const proportion = (p: InsurgencyProgress | null) => (p && p.denominator ? p.numerator / p.denominator : 0);
  // GetFactionColorFromPerspectiveOfMilitia: the generic corruption stroke (#9EFF00), or the pirate faction's for its own
  // militia (session.warfactionid, which the page does not keep: the generic colour, as for a pilot in no militia).
  const corruptionColor = "#9EFF00";
  const sides = $derived(ins && ins.fsmState !== 2 ? [
    { kind: "Corruption" as const, label: P + "corruption", stages: ins.corruptionStages ?? [], progress: ins.corruption, color: corruptionColor, icon: "corr" },
    { kind: "Suppression" as const, label: P + "suppression", stages: ins.suppressionStages ?? [], progress: ins.suppression, color: "#ffffff", icon: "supp" },
  ] : []);
  const percent = (p: InsurgencyProgress | null) => `${(proportion(p) * 100).toFixed(1)}%`;
</script>

{#if ins}
  <section class="ip-panel">
    <div class="ip-top">
      <div class="ip-gutter">
        <button type="button" class="ip-expand" class:expanded={!compact} aria-label={compact ? "Expand" : "Collapse"} onclick={onToggle}>
          <img alt="" src={clientTexture("res:/UI/Texture/classes/Neocom/arrowDown.png")} /></button>
        <span class="ip-icon"><img alt="" src={clientTexture("res:/UI/Texture/eveicon/system_icons/pirate_insurgencies_16px.png")} /></span>
      </div>
      <span class="in-title">{word(P + "dashboardCaption")}</span>
      {#if compact}{#each sides as side (side.kind)}<span class="in-gauge small" style:background={gradient(side.stages, proportion(side.progress), side.color)}><span></span></span>{/each}{/if}
    </div>
    {#if !compact}
      <div class="ip-main">
        {#if ins.fsmState === 2}
          <div class="in-forecast" title={word(P + "forecastingTooltip")}><small>{word(P + "nextInsurgencyIn")}</small><b>{countdown}</b></div>
        {:else}
          <div class="in-sides">
            {#each sides as side (side.kind)}
              <div class="in-side" title={effectLabels(side.kind, side.progress?.stage ?? 0).map((l) => word(l)).filter(Boolean).join("\n")}>
                <span class="in-gauge" style:background={gradient(side.stages, proportion(side.progress), side.color)}><span>
                  <img alt="" src={clientTexture(`res:/UI/Texture/classes/pirateinsurgencies/widgets/${side.icon}_${side.progress?.stage ?? 0}.png`)} />
                  <em>{percent(side.progress)}</em></span></span>
                <b>{word(P + "stageLabel", { stage: side.progress?.stage ?? 0 })}</b>
                <span>{word(side.label)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .ip-panel { pointer-events: auto; margin-bottom: 6px; }
  .ip-top { display: flex; align-items: center; min-height: 28px; gap: 8px; }
  .ip-gutter { display: flex; width: 56px; flex: none; }
  .ip-expand, .ip-icon { all: unset; cursor: pointer; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; opacity: 0.8; }
  .ip-expand img { width: 7px; height: 7px; transform: rotate(-90deg); }
  .ip-expand.expanded img { transform: none; }
  .ip-icon img { width: 16px; height: 16px; }
  .in-title { font-size: 14px; letter-spacing: 0.04em; color: rgb(255 255 255 / 0.85); }
  .ip-main { padding-left: 56px; }
  .in-forecast { display: flex; flex-direction: column; padding-top: 5px; }
  .in-forecast b { font-size: 18px; }
  .in-sides { display: flex; padding-top: 10px; width: 180px; }
  .in-side { width: 90px; display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 12px; }
  .in-gauge { position: relative; width: 64px; height: 64px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
  .in-gauge > span { width: 58px; height: 58px; border-radius: 50%; background: rgb(10 12 14); display: flex; align-items: center; justify-content: center; }
  .in-gauge img { width: 32px; height: 32px; }
  .in-gauge em { display: none; position: absolute; font-style: normal; }
  .in-side:hover .in-gauge img { display: none; }
  .in-side:hover .in-gauge em { display: block; }
  .in-gauge.small { width: 20px; height: 20px; }
  .in-gauge.small > span { width: 16px; height: 16px; }
</style>
