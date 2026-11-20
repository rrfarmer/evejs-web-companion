<script lang="ts">
  import { onMount } from "svelte";
  import { errorWords, type AppFlow } from "../app/flow.ts";
  import { chartPlanetSurvey, planetResourceQuality, PLANET_SURVEY_RAMP } from "../bridge/planetSurvey.ts";
  import { playUiEvent } from "../play/uiAudio.ts";
  import type { Colony } from "../store/types.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { colony, characterID, flow, showChart, setRange, onClose }: {
    colony: Colony; characterID: number | null; flow: AppFlow;
    showChart: (chart: Uint8Array<ArrayBuffer> | null) => Promise<void>;
    setRange: (low: number, high: number) => void; onClose: () => void;
  } = $props();

  const minSpan = 26 / 239; // ResourceLegend's minimum ramp width over its usable width.
  type Range = readonly [number, number];
  let range = $state<Range>([0, .5]);
  let selectedID = $state<number | null>(null);
  let status = $state<"ready" | "loading" | "error">("ready");
  let error = $state("");
  let generation = 0;
  const fallbackKey = $derived(characterID === null ? null : `evejs.char.${characterID}.planet_resource_display_range`);
  const planetKey = $derived(fallbackKey ? `${fallbackKey}_${colony.planetID}` : null);
  const resources = $derived((colony.resources ?? []).slice().sort((a, b) => (a.typeName ?? "").localeCompare(b.typeName ?? "")));

  function storedRange(key: string | null): Range | null {
    if (!key) return null;
    const pair: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!Array.isArray(pair)) return null;
    const [low, high] = pair;
    return typeof low === "number" && typeof high === "number" && low >= 0 && high <= 1 && high - low >= minSpan - 1e-9
      ? [low, high] : null;
  }

  onMount(() => {
    try { range = storedRange(planetKey) ?? storedRange(fallbackKey) ?? [0, .5]; }
    catch { range = [0, .5]; }
    setRange(...range);
    return () => {
      ++generation;
      void showChart(null);
    };
  });

  function adjust(index: 0 | 1, value: number): void {
    range = index === 0 ? [Math.min(value, range[1] - minSpan), range[1]] : [range[0], Math.max(value, range[0] + minSpan)];
    setRange(...range);
    if (!planetKey || !fallbackKey) return;
    try {
      localStorage.setItem(fallbackKey, JSON.stringify(range));
      localStorage.setItem(planetKey, JSON.stringify(range));
    } catch { /* The active chart still uses the range for this visit. */ }
  }

  async function select(resourceTypeID: number | null): Promise<void> {
    if (resourceTypeID === selectedID && status !== "error") return;
    const current = ++generation;
    selectedID = resourceTypeID;
    error = "";
    status = resourceTypeID === null ? "ready" : "loading";
    void playUiEvent("msg_pi_scanning_switch_play");
    await showChart(null);
    if (resourceTypeID === null) return;
    try {
      const field = await flow.readPlanetSurvey(colony.planetID, resourceTypeID);
      if (current !== generation) return;
      await showChart(chartPlanetSurvey(field));
      if (current === generation) status = "ready";
    } catch (cause) {
      if (current !== generation) return;
      error = errorWords(cause);
      status = "error";
    }
  }
</script>

<section class="planet-survey" aria-label="Resource scan">
  <header><h2>Scan</h2><button type="button" aria-label="Close resource scan" onclick={onClose}>×</button></header>
  <div class="planet-legend" aria-hidden="true">
    <img src={PLANET_SURVEY_RAMP} alt="" style:left={`${range[0] * 100}%`} style:width={`${(range[1] - range[0]) * 100}%`} />
  </div>
  <div class="planet-range">
    <label>Minimum <output>{Math.round(range[0] * 100)}%</output>
      <input type="range" aria-label="Minimum resource visibility" min="0" max="1" step={1 / 239} value={range[0]}
        oninput={(event) => adjust(0, event.currentTarget.valueAsNumber)} />
    </label>
    <label>Maximum <output>{Math.round(range[1] * 100)}%</output>
      <input type="range" aria-label="Maximum resource visibility" min="0" max="1" step={1 / 239} value={range[1]}
        oninput={(event) => adjust(1, event.currentTarget.valueAsNumber)} />
    </label>
  </div>
  <ul class="planet-resources">
    <li><button type="button" aria-pressed={selectedID === null} onclick={() => void select(null)}>No resource selected</button></li>
    {#each resources as resource (resource.typeID)}
      {@const density = resource.quality === null ? null : planetResourceQuality(resource.quality)}
      <li>
        <button type="button" aria-pressed={selectedID === resource.typeID} onclick={() => void select(resource.typeID)}>
          <TypeIcon typeID={resource.typeID} name={resource.typeName ?? "Resource"} />
          <span>{resource.typeName ?? "Resource"}</span>
          {#if density !== null}
            <meter min="0" max="1" value={density} aria-label="Resource density" title={`Resource density ${Math.floor(density * 100)}%`}></meter>
          {/if}
        </button>
      </li>
    {/each}
  </ul>
  {#if status === "loading"}<p role="status">Loading resource scan…</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if colony.resources == null}<p>Resource information is unavailable.</p>
  {:else if resources.length === 0}<p>No resources were reported on this planet.</p>{/if}
</section>

<style>
  .planet-survey { display: grid; gap: .55rem; border: 1px solid #819fad65; background: #0a131bef; padding: .65rem; }
  header, .planet-range { display: flex; align-items: center; justify-content: space-between; gap: .6rem; }
  h2, p { margin: 0; font-size: 1rem; }
  .planet-legend { position: relative; height: .55rem; background: #223541; border: 1px solid #819fad65; }
  .planet-legend img { position: absolute; top: 0; height: 100%; display: block; }
  label { display: grid; flex: 1; grid-template-columns: 1fr auto; min-width: 0; gap: .1rem; color: #bfccd3; }
  label input { grid-column: span 2; width: 100%; }
  output { justify-self: end; }
  ul { display: grid; gap: .2rem; list-style: none; margin: 0; padding: 0; }
  button { color: inherit; font: inherit; text-align: start; border: 1px solid transparent; background: #182630; cursor: pointer; }
  li button { width: 100%; display: flex; align-items: center; gap: .45rem; padding: .22rem .4rem; }
  button[aria-pressed=true], button:hover { border-color: #72afb9; background: #243c4c; }
  meter { width: 3.5rem; margin-inline-start: auto; }
  [role=alert] { color: #ffca83; }
</style>
