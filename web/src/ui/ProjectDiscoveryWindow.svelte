<script lang="ts">
  import { onMount } from "svelte";
  import { bridgeAsk, bridgeDo } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { isListValue, readDictEntry, readKeyVal, unwrapBool, unwrapReal, type JsonValue } from "../bridge/wire.ts";
  import { clientTexture } from "../play/window.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const welcomeLabel = "UI/ProjectDiscovery/Covid/Intro/Welcome";
  const beginLabel = "UI/ProjectDiscovery/Covid/Intro/ButtonBegin";
  const sampleImage = clientTexture("res:/UI/Texture/classes/ProjectDiscovery/covid/intro/project_discovery.png");
  const firstTutorial = "ed134308-e080-49bc-be56-169a5f839c96";
  const service = "ProjectDiscovery";
  type Progress = { rank: number; experience: number; analysisKredits: number; finishedTutorial: boolean };
  type Point = readonly [number, number];
  type Sample = { id: string; width: number; height: number; points: Point[] };
  let progress = $state<Progress | null>(null);
  let briefing = $state(false);
  let loading = $state(false);
  let error = $state("");
  let sample = $state.raw<Sample | null>(null);
  let score = $state<number | null>(null);
  let polygons = $state.raw<Point[][]>([]);
  let outline = $state.raw<Point[]>([]);
  let solution = $state.raw<Point[][]>([]);
  let showSolution = $state(false);
  let plot = $state<HTMLCanvasElement>();
  let overlay = $state<HTMLCanvasElement>();
  let startedAt = 0;

  function pilotProgress(value: JsonValue): Progress {
    const rank = unwrapReal(readKeyVal(value, "rank"));
    const experience = unwrapReal(readKeyVal(value, "experience"));
    const analysisKredits = unwrapReal(readKeyVal(value, "analysisKredits"));
    const finishedTutorial = unwrapBool(readKeyVal(value, "finishedTutorial"));
    if (rank === null || experience === null || analysisKredits === null || finishedTutorial === null) {
      throw new Error("Project Discovery returned an invalid pilot record.");
    }
    return { rank, experience, analysisKredits, finishedTutorial };
  }

  async function load() {
    if (loading) return;
    loading = true;
    error = "";
    try {
      progress = pilotProgress(await bridgeAsk(flow.requestOptions())(service, "get_player_state", []));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Project Discovery could not be reached.";
    } finally {
      loading = false;
    }
  }

  function pair(value: unknown): Point | null {
    const items = isListValue(value) ? value.items : Array.isArray(value) ? value : [];
    if (items.length !== 2) return null;
    const x = unwrapReal(items[0]), y = unwrapReal(items[1]);
    return x === null || y === null ? null : [x, y];
  }

  async function loadSample() {
    if (loading || !progress) return;
    loading = true;
    error = "";
    try {
      const options = flow.requestOptions();
      const tutorial = progress.finishedTutorial ? null : { original_code: firstTutorial, is_tutorial_task: true };
      const task = await bridgeDo(options)(service, "get_new_task", [], tutorial);
      const id = readDictEntry(task, "id");
      const url = readDictEntry(readDictEntry(task, "assets"), "url");
      if (typeof id !== "string" || typeof url !== "string") throw new Error("The sample could not be read.");
      const data = await bridgeAsk(options)(service, "get_data_from_url", [url]);
      const dimensions = pair(readDictEntry(data, "dimensions"));
      const positions = readDictEntry(data, "points");
      if (!dimensions || dimensions.some(n => !Number.isInteger(n) || n < 1 || n > 4096) || !isListValue(positions)) {
        throw new Error("The sample chart could not be read.");
      }
      const points = positions.items.map(pair).filter((point): point is Point =>
        point !== null && point.every(n => n >= 0 && n <= 1));
      if (!points.length || points.length !== positions.items.length) throw new Error("The sample contains invalid points.");
      sample = { id, width: dimensions[0], height: dimensions[1], points };
      outline = [];
      polygons = [];
      score = null;
      solution = [];
      showSolution = false;
      startedAt = performance.now();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The sample could not be loaded.";
    } finally {
      loading = false;
    }
  }

  function finishOutline() {
    if (outline.length < 3 || polygons.length >= 8) return;
    polygons = [...polygons, outline];
    outline = [];
  }

  function addVertex(event: MouseEvent) {
    if (loading || score !== null || polygons.length >= 8 || !overlay) return;
    const rect = overlay.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (event.clientX - rect.left) / rect.width;
    const y = 1 - (event.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    const first = outline[0];
    if (first && Math.hypot((x - first[0]) * rect.width, (y - first[1]) * rect.height) < 9) {
      finishOutline();
      return;
    }
    outline = [...outline, [x, y]];
    if (outline.length === 10) finishOutline();
  }

  function undo() {
    if (outline.length) outline = outline.slice(0, -1);
    else polygons = polygons.slice(0, -1);
  }

  async function submit() {
    if (loading || !sample || score !== null || outline.length || !polygons.length) return;
    loading = true;
    error = "";
    const list = (items: readonly JsonValue[]): JsonValue => ({ type: "list", items });
    const dict = (entries: readonly (readonly [string, JsonValue])[]): JsonValue => ({ type: "dict", entries });
    try {
      const gates = polygons.map(vertices => dict([["vertices", list(vertices.map(point => list(point)))]]));
      const answer = dict([
        ["taskID", sample.id],
        ["skip", false],
        ["polygons", list(gates)],
      ]);
      const duration = dict([["t", Math.round(performance.now() - startedAt)], ["tPolygons", list([])]]);
      const result = await bridgeDo(flow.requestOptions())(service, "post_classification", [answer, duration]);
      const resultScore = unwrapReal(readDictEntry(result, "score"));
      const player = readDictEntry(result, "playerState");
      if (resultScore === null || resultScore < 0 || resultScore > 1 || player === undefined) {
        throw new Error("The classification result could not be read.");
      }
      progress = pilotProgress(player);
      score = resultScore;
      const returnedTask = readDictEntry(result, "task");
      const clusters = readDictEntry(readDictEntry(returnedTask, "solution"), "clusters");
      solution = isListValue(clusters) ? clusters.items.flatMap(cluster => {
        const gates = readDictEntry(cluster, "polygons");
        return isListValue(gates) ? gates.items.flatMap(gate => {
          const vertices = readDictEntry(gate, "vertices");
          if (!isListValue(vertices)) return [];
          const points = vertices.items.map(pair);
          return points.length >= 3 && points.every((point): point is Point =>
            point !== null && point.every(n => n >= 0 && n <= 1)) ? [points] : [];
        }) : [];
      }) : [];
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The classification could not be submitted.";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (!plot || !sample) return;
    const context = plot.getContext("2d");
    if (!context) return;
    const { width, height, points } = sample;
    context.fillStyle = "#060d19";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "rgba(75, 197, 255, 0.36)";
    for (const [x, y] of points) context.fillRect(x * (width - 1), (1 - y) * (height - 1), 2, 2);
  });

  $effect(() => {
    if (!overlay || !sample) return;
    const context = overlay.getContext("2d");
    if (!context) return;
    const { width, height } = sample;
    context.clearRect(0, 0, width, height);
    context.strokeStyle = "#5adeff";
    context.lineWidth = 3;
    context.fillStyle = "rgba(82, 211, 255, 0.18)";
    for (const vertices of polygons) {
      context.beginPath();
      for (const [x, y] of vertices) context.lineTo(x * width, (1 - y) * height);
      context.closePath();
      context.fill();
      context.stroke();
    }
    if (outline.length) {
      context.beginPath();
      for (const [x, y] of outline) context.lineTo(x * width, (1 - y) * height);
      context.stroke();
      context.beginPath();
      context.arc(outline[0][0] * width, (1 - outline[0][1]) * height, 6, 0, 2 * Math.PI);
      context.stroke();
    }
    if (showSolution) {
      context.strokeStyle = "#ffd976";
      context.setLineDash([7, 4]);
      for (const vertices of solution) {
        context.beginPath();
        for (const [x, y] of vertices) context.lineTo(x * width, (1 - y) * height);
        context.closePath();
        context.stroke();
      }
      context.setLineDash([]);
    }
  });

  onMount(() => {
    flow.requestWords([welcomeLabel, beginLabel]);
    void load();
  });
</script>

<section class="discovery" aria-label="Project Discovery">
  {#if progress}
    <dl class="progress" aria-label="Project Discovery progress">
      <div><dt>Rank</dt><dd>{progress.rank.toLocaleString()}</dd></div>
      <div><dt>Experience</dt><dd>{progress.experience.toLocaleString()}</dd></div>
      <div><dt>Analysis Kredits</dt><dd>{progress.analysisKredits.toLocaleString()}</dd></div>
    </dl>
    {#if sample}
      <div class="sample">
        <div class="chart" style:aspect-ratio={`${sample.width} / ${sample.height}`}>
          <canvas bind:this={plot} width={sample.width} height={sample.height} aria-label="Cell population scatter plot"></canvas>
          <canvas bind:this={overlay} width={sample.width} height={sample.height} aria-hidden="true"></canvas>
          <button class="chart-input" type="button" aria-label="Place polygon point on the population chart" disabled={loading || score !== null || polygons.length >= 8} onclick={addVertex}></button>
        </div>
        <section class="sample-controls">
          <h2>{progress.finishedTutorial ? "Classify sample" : "Training sample"}</h2>
          <p>Click around each group of cells. Click the first point again or select Close outline to finish each group.</p>
          {#if score === null}
            <p role="status">{polygons.length} {polygons.length === 1 ? "group" : "groups"} outlined</p>
            <div class="actions">
              <button type="button" disabled={loading || outline.length < 3} onclick={finishOutline}>Close outline</button>
              <button type="button" disabled={loading || (!outline.length && !polygons.length)} onclick={undo}>Undo</button>
              <button type="button" disabled={loading || (!outline.length && !polygons.length)} onclick={() => { outline = []; polygons = []; }}>Clear</button>
            </div>
            <button type="button" disabled={loading || outline.length > 0 || !polygons.length} onclick={submit}>Submit</button>
          {:else}
            <p role="status">Classification score {score.toLocaleString(undefined, { style: "percent", maximumFractionDigits: 1 })}</p>
            {#if solution.length}
              <label><input type="checkbox" bind:checked={showSolution} /> Show reference outlines</label>
            {/if}
            <button type="button" disabled={loading} onclick={loadSample}>{progress.finishedTutorial ? "Next sample" : "Try again"}</button>
          {/if}
          <button type="button" disabled={loading} onclick={() => { sample = null; error = ""; }}>Back</button>
          {#if loading}<p role="status">Contacting Project Discovery…</p>{/if}
          {#if error}<p role="alert">{error}</p>{/if}
        </section>
      </div>
    {:else}
      <article>
        {#if briefing}
          <h2>Cell population analysis</h2>
          <p>Each dot represents a cell. Look for groups of dots that cluster together. Draw a closed outline around each distinct population.</p>
          <p>EveJS uses local training samples and tracks your results on this pilot.</p>
          <div class="actions">
            <button type="button" disabled={loading} onclick={loadSample}>{progress.finishedTutorial ? "Open sample" : "Start training sample"}</button>
            <button type="button" disabled={loading} onclick={() => { briefing = false; error = ""; }}>Back</button>
          </div>
          {#if loading}<p role="status">Loading sample…</p>{/if}
          {#if error}<p role="alert">{error}</p>{/if}
        {:else}
          <h2>{plainText($words.templates[welcomeLabel] ?? "") || "Welcome to Project Discovery"}</h2>
          <img src={sampleImage} alt="" width="474" height="237" />
          <button type="button" onclick={() => { briefing = true; }}>
            {progress.finishedTutorial ? "Review briefing" : plainText($words.templates[beginLabel] ?? "") || "Begin"}
          </button>
        {/if}
      </article>
    {/if}
  {:else if loading}
    <p role="status">Loading Project Discovery…</p>
  {:else if error}
    <div role="alert"><p>{error}</p><button type="button" onclick={load}>Retry</button></div>
  {/if}
</section>

<style>
  .discovery { box-sizing: border-box; display: grid; align-content: start; min-height: 100%; padding: 24px; }
  .progress { display: flex; justify-content: center; flex-wrap: wrap; gap: 12px; margin: 0; }
  .progress div { min-width: 100px; padding: 8px 14px; border: 1px solid var(--line, #39444b); }
  dt { opacity: 0.75; }
  dd { margin: 3px 0 0; font-size: 18px; font-variant-numeric: tabular-nums; }
  article { display: grid; justify-items: center; gap: 16px; width: min(100%, 560px); margin: clamp(24px, 7vh, 80px) auto 0; text-align: center; }
  h2, p { margin: 0; }
  img { display: block; max-width: 100%; height: auto; }
  [role="alert"] p { margin-bottom: 12px; }
  .sample { display: flex; flex-wrap: wrap; justify-content: center; align-items: flex-start; gap: 24px; margin-top: 24px; }
  .chart { position: relative; width: min(100%, 530px); background: #060d19; border: 1px solid var(--line, #39444b); }
  .chart canvas, .chart-input { position: absolute; inset: 0; width: 100%; height: 100%; }
  .chart-input { padding: 0; border: 0; background: transparent; cursor: crosshair; }
  .chart-input:hover:not(:disabled) { background: transparent; }
  .chart-input:disabled { cursor: default; }
  .sample-controls { display: grid; justify-items: start; gap: 12px; width: min(100%, 280px); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
