<script lang="ts">
  import { errorWords, type AppFlow } from "../app/flow.ts";
  import type { ProgramYield } from "../bridge/extractorRestart.ts";
  import { EXTRACTOR_HEAD_LIMIT, extractorOutput, installedExtractorYield, radiusForSlider, sliderForRadius } from "../bridge/extractorSurvey.ts";
  import { formatDuration } from "../bridge/planets.ts";
  import type { Colony, ColonyPin, ExtractorHead } from "../store/types.ts";
  import PlanetSurvey from "./PlanetSurvey.svelte";

  let { colony, unit, characterID, flow, heads, radius, dragging, editable, toggleHead, changeRadius, showChart, setRange, onClose }: {
    colony: Colony; unit: ColonyPin; characterID: number | null; flow: AppFlow;
    heads: readonly ExtractorHead[]; radius: number; dragging: boolean; editable: boolean;
    toggleHead: (id: number) => void; changeRadius: (radius: number) => void;
    showChart: (chart: Uint8Array<ArrayBuffer> | null) => Promise<void>;
    setRange: (low: number, high: number) => void; onClose: () => void;
  } = $props();

  const slots = Array.from({ length: EXTRACTOR_HEAD_LIMIT }, (_, id) => id);
  let resourceID = $state<number | null>(null);
  let estimate = $state.raw<ProgramYield | null>(null);
  let pending = $state(false);
  let failure = $state("");
  let retry = $state(0);
  const initialResourceID = $derived(unit.program?.resourceTypeID || null);
  const preview = $derived(editable ? estimate : installedExtractorYield(unit.program));
  const output = $derived(preview && unit.extractor?.decayFactor != null && unit.extractor.noiseFactor != null
    ? extractorOutput(preview, unit.extractor.decayFactor, unit.extractor.noiseFactor) : []);
  const total = $derived(output.reduce((sum, cycle) => sum + cycle, 0));
  const max = $derived(Math.max(1, ...output));
  const activeSlots = $derived(new Set(heads.map(([id]) => id)));

  $effect(() => {
    const planetID = colony.planetID, pinID = unit.pinID, resource = resourceID, draft = heads, drillRadius = radius;
    retry;
    estimate = null;
    pending = false;
    failure = "";
    if (!editable || dragging || resource === null || !draft.length) return;
    pending = true;
    let current = true;
    const timeout = setTimeout(() => {
      void flow.readExtractorYield(planetID, pinID, resource, draft, drillRadius).then(result => {
        if (current) estimate = result;
      }).catch(cause => {
        if (current) failure = errorWords(cause);
      }).finally(() => {
        if (current) pending = false;
      });
    }, 180);
    return () => { current = false; clearTimeout(timeout); };
  });
</script>

<section class="extractor-survey" aria-label="Extractor survey">
  <header>
    <div><h2>Extractor Survey</h2><p>{unit.typeName}</p></div>
    <button type="button" aria-label="Close extractor survey" onclick={onClose}>×</button>
  </header>
  {#if unit.active}<p class="survey-state">Program running</p>{/if}
  <PlanetSurvey {colony} {characterID} {flow} {showChart} {setRange} {initialResourceID} compact locked={unit.active === true}
    onResourceReady={(resource) => { resourceID = resource; }} />
  <fieldset>
    <legend>Extraction heads <span>{heads.length} / {EXTRACTOR_HEAD_LIMIT}</span></legend>
    <div class="head-slots">
      {#each slots as id (id)}
        <button type="button" aria-label={`Head slot ${id + 1}`} aria-pressed={activeSlots.has(id)}
          disabled={!editable} title={activeSlots.has(id) ? "Remove extraction head" : "Place extraction head"}
          onclick={() => toggleHead(id)}>{id + 1}</button>
      {/each}
    </div>
    {#if editable}<p>{heads.length ? "Drag a head on the planet to move it." : "Select a slot to place an extraction head."}</p>
    {:else if unit.active !== true}<p>Head placement is unavailable for this unit.</p>{/if}
    <label>Extraction area
      <input type="range" min="0" max="1" step="0.005" value={sliderForRadius(radius)} disabled={!editable}
        oninput={(event) => changeRadius(radiusForSlider(event.currentTarget.valueAsNumber))} />
    </label>
  </fieldset>
  {#if pending}<p role="status">Calculating yield…</p>{/if}
  {#if failure}
    <p role="alert">{failure}</p>
    <button type="button" onclick={() => { retry += 1; }}>Retry yield estimate</button>
  {/if}
  {#if preview}
    <div class="survey-output" aria-label="Extraction forecast">
      <dl>
        <div><dt>Duration</dt><dd>{formatDuration(preview.cycleTicks * preview.cycles / 10000)}</dd></div>
        <div><dt>Cycle time</dt><dd>{formatDuration(preview.cycleTicks / 10000)}</dd></div>
        <div><dt>Cycles</dt><dd>{preview.cycles}</dd></div>
        {#if output.length}
          <div><dt>Average per hour</dt><dd>{Math.round(total * 36_000_000_000 / (preview.cycleTicks * preview.cycles)).toLocaleString()}</dd></div>
          <div><dt>Total output</dt><dd>{total.toLocaleString()}</dd></div>
        {:else}
          <div><dt>Base yield</dt><dd>{preview.quantity.toLocaleString()}</dd></div>
        {/if}
      </dl>
      {#if output.length}
        <div class="yield-chart" aria-label="Predicted output by cycle">
          {#each output as quantity, index (index)}
            <span style:height={`${quantity / max * 100}%`} title={`Cycle ${index + 1} · ${quantity.toLocaleString()}`}></span>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .extractor-survey { display: grid; gap: .65rem; border: 1px solid #69858c; background: #0d1821f8; padding: .7rem; }
  header, .survey-output dl div { display: flex; align-items: flex-start; justify-content: space-between; gap: .5rem; }
  h2, p, dl, dd { margin: 0; }
  h2 { font-size: 1.03rem; }
  p, dt { color: #aebfc9; }
  fieldset { display: grid; gap: .4rem; min-width: 0; border: 1px solid #46606a; margin: 0; padding: .45rem; }
  legend span { color: #aebfc9; margin-inline-start: .4rem; }
  .head-slots { display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: .18rem; }
  button { font: inherit; color: inherit; background: #1a2b35; border: 1px solid #536874; cursor: pointer; }
  button:disabled { cursor: default; }
  button:hover:enabled { border-color: #9de9df; }
  button[aria-pressed=true] { color: #131919; background: #f0d088; border-color: #f0d088; }
  label { display: grid; gap: .2rem; }
  label input { width: 100%; accent-color: #9de9df; }
  .survey-state { color: #9de9df; }
  .survey-output dl { display: grid; gap: .2rem; }
  dd { font-variant-numeric: tabular-nums; }
  .yield-chart { display: flex; align-items: flex-end; gap: 1px; height: 3.3rem; border-bottom: 1px solid #608189; margin-top: .45rem; }
  .yield-chart span { flex: 1; min-width: 0; background: #8bc7bd; }
  [role=alert] { color: #ffca83; }
</style>
