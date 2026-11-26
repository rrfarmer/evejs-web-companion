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
  const tutorialLabels = "UI/ProjectDiscovery/Covid/Tutorial/";
  const introLabels = "UI/ProjectDiscovery/Covid/Intro/";
  const resultLabels = "UI/ProjectDiscovery/Covid/Results/";
  const rewardLabels = "UI/ProjectDiscovery/Covid/Rewards/";
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? "") || fallback;
  const percent = (value: number) => value.toLocaleString(undefined, { style: "percent", maximumFractionDigits: 1 });
  const sampleImage = clientTexture("res:/UI/Texture/classes/ProjectDiscovery/covid/intro/project_discovery.png");
  const practiceImage = clientTexture("res:/UI/Texture/classes/ProjectDiscovery/covid/tutorial/onegate.png");
  const practiceTargets = [[.77, .31], [.59, .50], [.48, .72], [.33, .70], [.26, .47], [.13, .36], [.19, .18], [.43, .10], [.72, .13]] as const;
  const lessons = [
    { title: "One Gate", code: null },
    { title: "Two Gates", code: "ed134308-e080-49bc-be56-169a5f839c96" },
    { title: "Heart Shape", code: "be362d8b-4ff4-448b-877f-23b8c2cb4fe0" },
    { title: "Valley", code: "eb4c6403-e878-43cf-a009-9c8c566ae90f" },
    { title: "Tails and Valleys", code: "21cbef0c-684e-4a4c-b1fe-be6e24d894c2" },
    { title: "Tail", code: "ff9f9a21-954b-4c1c-9a54-16b21cf17670" },
  ] as const;
  const service = "ProjectDiscovery";
  type Progress = { rank: number; experience: number; analysisKredits: number; finishedTutorial: boolean; tutorialLevel: number };
  type Point = readonly [number, number];
  type Sample = { id: string; width: number; height: number; points: Point[]; lesson: number | null; review?: boolean };
  let progress = $state<Progress | null>(null);
  let briefing = $state(false);
  let loading = $state(false);
  let error = $state("");
  let sample = $state.raw<Sample | null>(null);
  let score = $state<number | null>(null);
  let taskScores = $state<{ high: number; average: number } | null>(null);
  let pilotAccuracy = $state<number | null>(null);
  let rewardView = $state(false);
  let xpBand = $state<{ rank: number; lower: number; upper: number } | null>(null);
  let completion = $state<{ xp: number; kredits: number } | null>(null);
  let regularReward = $state<{ xp: number; isk: number; kredits: number; bonus: boolean; rank: number | null; crates: number; tier: number | null } | null>(null);
  let restarting = $state(false);
  let retrainingOffer = $state(false);
  let polygons = $state.raw<Point[][]>([]);
  let outline = $state.raw<Point[]>([]);
  let solution = $state.raw<Point[][]>([]);
  let showSolution = $state(false);
  let plot = $state<HTMLCanvasElement>();
  let overlay = $state<HTMLCanvasElement>();
  let startedAt = 0;
  const practice = $derived(sample?.lesson === 0);
  const practiceIndex = $derived(outline.length === practiceTargets.length ? 0 : outline.length);
  const practiceTarget = $derived(practice && !polygons.length ? practiceTargets[practiceIndex] : undefined);
  const rankProgress = $derived(progress && xpBand && xpBand.rank === progress.rank
    ? { xp: Math.min(xpBand.upper - xpBand.lower, Math.max(0, progress.experience - xpBand.lower)), cap: xpBand.upper - xpBand.lower }
    : null);

  function pilotProgress(value: JsonValue): Progress {
    const rank = unwrapReal(readKeyVal(value, "rank"));
    const experience = unwrapReal(readKeyVal(value, "experience"));
    const analysisKredits = unwrapReal(readKeyVal(value, "analysisKredits"));
    const finishedTutorial = unwrapBool(readKeyVal(value, "finishedTutorial"));
    const tutorialLevel = unwrapReal(readKeyVal(value, "tutorialLevel"));
    if (rank === null || experience === null || analysisKredits === null || finishedTutorial === null ||
        tutorialLevel === null || !Number.isInteger(tutorialLevel) || tutorialLevel < 0) {
      throw new Error("Project Discovery returned an invalid pilot record.");
    }
    return { rank, experience, analysisKredits, finishedTutorial, tutorialLevel };
  }

  const readProgress = async () => pilotProgress(await bridgeAsk(flow.requestOptions())(service, "get_player_state", []));

  function accuracyOf(value: unknown) {
    const number = unwrapReal(value);
    return number !== null && number >= 0 && number <= 1 ? number : null;
  }

  $effect(() => {
    const rank = progress?.rank;
    if (!Number.isSafeInteger(rank) || rank === undefined || rank < 1) return;
    const ask = bridgeAsk(flow.requestOptions());
    let active = true;
    void Promise.all([rank, rank + 1].map(level => ask(service, "get_total_needed_xp", [level]))).then(values => {
      const [lower, upper] = values.map(unwrapReal);
      if (active && lower !== null && upper !== null && upper > lower) xpBand = { rank, lower, upper };
    }).catch(() => {});
    return () => { active = false; };
  });

  async function load() {
    if (loading) return;
    loading = true;
    error = "";
    try {
      progress = await readProgress();
      if (progress.finishedTutorial) {
        try {
          const key = `evejs.user.${store.session.get().accountID ?? "local"}.projectDiscoveryRetrainingOffered`;
          retrainingOffer = localStorage.getItem(key) !== "yes";
          if (retrainingOffer) localStorage.setItem(key, "yes");
        } catch {
          retrainingOffer = false;
        }
      }
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

  function showSample(next: Sample) {
    sample = next;
    outline = [];
    polygons = [];
    score = null;
    taskScores = null;
    rewardView = false;
    solution = [];
    showSolution = false;
    completion = null;
    regularReward = null;
    startedAt = performance.now();
  }

  async function loadSample(advance = false, reviewStart = false) {
    if (loading || !progress) return;
    loading = true;
    error = "";
    try {
      const options = flow.requestOptions();
      let reviewLesson = reviewStart ? 2 : sample?.review ? sample.lesson : null;
      if (reviewLesson !== null && advance) {
        reviewLesson++;
        if (reviewLesson === lessons.length) reviewLesson = null;
      } else if (advance && sample?.lesson != null) {
        const prior = await readProgress();
        progress = prior;
        const last = sample.lesson === lessons.length - 1;
        if (!prior.finishedTutorial && (last || prior.tutorialLevel === sample.lesson)) {
          const method = last ? "skip_tutorial" : "increase_tutorial_level";
          progress = pilotProgress(await bridgeDo(options)(service, method, []));
        }
        if (last && progress.finishedTutorial) {
          completion = { xp: progress.experience - prior.experience, kredits: progress.analysisKredits - prior.analysisKredits };
          return;
        }
      }
      const lesson = reviewLesson ?? (progress.finishedTutorial ? null : Math.min(progress.tutorialLevel, lessons.length - 1));
      if (lesson === 0) {
        showSample({ id: "one-gate", width: 768, height: 768, points: [], lesson });
        return;
      }
      const tutorial = lesson === null ? null : { original_code: lessons[lesson].code, is_tutorial_task: true };
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
      showSample({ id, width: dimensions[0], height: dimensions[1], points, lesson, review: reviewLesson !== null });
      retrainingOffer = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The sample could not be loaded.";
    } finally {
      loading = false;
    }
  }

  async function restartTraining() {
    if (loading) return;
    loading = true;
    error = "";
    try {
      progress = pilotProgress(await bridgeDo(flow.requestOptions())(service, "reset_tutorial", []));
      sample = null;
      briefing = false;
      retrainingOffer = false;
      restarting = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Training could not be restarted.";
    } finally {
      loading = false;
    }
  }

  async function skipTraining() {
    if (loading) return;
    loading = true;
    error = "";
    try {
      progress = pilotProgress(await bridgeDo(flow.requestOptions())(service, "skip_tutorial", []));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Training could not be skipped.";
    } finally {
      loading = false;
    }
    if (!error) await loadSample();
  }

  function finishOutline() {
    if (outline.length < 3 || polygons.length >= 8) return;
    polygons = [...polygons, outline];
    outline = [];
  }

  function placePracticePoint() {
    if (!practiceTarget || loading || score !== null) return;
    if (outline.length === practiceTargets.length) finishOutline();
    else outline = [...outline, [practiceTarget[0], 1 - practiceTarget[1]]];
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
    if (practice) {
      score = 1;
      return;
    }
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
      const previousRank = progress?.rank;
      progress = pilotProgress(player);
      score = resultScore;
      const updatedAccuracy = accuracyOf(readDictEntry(readDictEntry(result, "player"), "score"));
      if (updatedAccuracy !== null) pilotAccuracy = updatedAccuracy;
      if (sample.lesson === null) {
        const crates = readDictEntry(result, "loot_crates");
        regularReward = {
          xp: unwrapReal(readDictEntry(result, "XP_Reward")) ?? 0,
          isk: unwrapReal(readDictEntry(result, "ISK_Reward")) ?? 0,
          kredits: unwrapReal(readDictEntry(result, "AK_Reward")) ?? 0,
          bonus: unwrapBool(readDictEntry(result, "gotBonusXP")) === true,
          rank: previousRank !== undefined && progress.rank > previousRank ? progress.rank : null,
          crates: isListValue(crates) ? crates.items.length : 0,
          tier: unwrapReal(readDictEntry(result, "tier_reward")),
        };
      }
      const returnedTask = readDictEntry(result, "task");
      const votes = readDictEntry(returnedTask, "votes");
      taskScores = { high: Math.max(resultScore, accuracyOf(readDictEntry(votes, "highScore")) ?? 0),
        average: accuracyOf(readDictEntry(votes, "avgScore")) ?? 0 };
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
    if (!plot || !sample || sample.lesson === 0) return;
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
    flow.requestWords([welcomeLabel, beginLabel, "UI/ProjectDiscovery/HelpTutorialTooltip",
      ...["Accuracy", "HighScore", "ParScore", "AverageScore"].map(label => resultLabels + label),
      ...["Experience", "RankProgress", "Reward"].map(label => rewardLabels + label),
      ...["RestartCaption", "RestartText", "ButtonRestartOk", "ButtonRestartCancel"].map(label => tutorialLabels + label),
      ...["RetrainingText", "RetrainingButtonContinue", "RetrainingButtonSkip", "TransitionButtonSkip"].map(label => introLabels + label)]);
    void load();
    let active = true;
    void bridgeAsk(flow.requestOptions())(service, "get_player_statistics", [], { get_history: true }).then(stats => {
      if (active && pilotAccuracy === null) pilotAccuracy = accuracyOf(readDictEntry(readDictEntry(stats, "project"), "score"));
    }).catch(() => {});
    return () => { active = false; };
  });
</script>

{#snippet gauge(label: string, fraction: number)}
  <label class="gauge">
    <span>{label} <strong>{percent(fraction)}</strong></span>
    <meter min="0" max="1" value={fraction}></meter>
  </label>
{/snippet}

<section class="discovery" aria-label="Project Discovery">
  {#if progress}
    <dl class="progress" aria-label="Project Discovery progress">
      <div><dt>Rank</dt><dd>{progress.rank.toLocaleString()}</dd></div>
      <div><dt>Experience</dt><dd>{progress.experience.toLocaleString()}</dd></div>
      <div><dt>Analysis Kredits</dt><dd>{progress.analysisKredits.toLocaleString()}</dd></div>
      {#if pilotAccuracy !== null}<div><dt>Pilot accuracy</dt><dd>{percent(pilotAccuracy)}</dd></div>{/if}
    </dl>
    {#if restarting}
      <article role="alertdialog" aria-labelledby="discovery-restart-title">
        <h2 id="discovery-restart-title">{word(tutorialLabels + "RestartCaption", "Restart tutorial")}</h2>
        <p>{word(tutorialLabels + "RestartText", "Start Project Discovery training again?")}</p>
        <div class="actions">
          <button type="button" disabled={loading} onclick={restartTraining}>{word(tutorialLabels + "ButtonRestartOk", "Restart")}</button>
          <button type="button" disabled={loading} onclick={() => { restarting = false; error = ""; }}>{word(tutorialLabels + "ButtonRestartCancel", "Cancel")}</button>
        </div>
        {#if error}<p role="alert">{error}</p>{/if}
      </article>
    {:else if retrainingOffer}
      <article>
        <h2>Project Discovery refresher</h2>
        <p>{word(introLabels + "RetrainingText", "Review the more advanced training samples or return to classification.")}</p>
        <div class="actions">
          <button type="button" disabled={loading} onclick={() => void loadSample(false, true)}>{word(introLabels + "RetrainingButtonContinue", "Retrain")}</button>
          <button type="button" disabled={loading} onclick={() => void loadSample()}>{word(introLabels + "RetrainingButtonSkip", "Skip retraining")}</button>
        </div>
        {#if error}<p role="alert">{error}</p>{/if}
      </article>
    {:else if sample}
      <div class="sample">
        <div class="chart" hidden={rewardView} style:aspect-ratio={`${sample.width} / ${sample.height}`}>
          {#if practice}
            <img class="practice-image" src={practiceImage} alt="One Gate practice scatter plot" />
          {:else}
            <canvas bind:this={plot} width={sample.width} height={sample.height} aria-label="Cell population scatter plot"></canvas>
          {/if}
          <canvas bind:this={overlay} width={sample.width} height={sample.height} aria-hidden="true"></canvas>
          {#if practiceTarget && score === null}
            <button class="practice-target" type="button" aria-label={practiceIndex === 0 && outline.length ? "Close practice outline" : `Place point ${practiceIndex + 1}`}
              style:left={`${practiceTarget[0] * 100}%`} style:top={`${practiceTarget[1] * 100}%`} onclick={placePracticePoint}></button>
          {:else if !practice}
            <button class="chart-input" type="button" aria-label="Place polygon point on the population chart" disabled={loading || score !== null || polygons.length >= 8} onclick={addVertex}></button>
          {/if}
        </div>
        <section class="sample-controls" class:reward-view={rewardView}>
          <h2>{rewardView ? word(rewardLabels + "Reward", "Reward") : sample.lesson === null ? "Classify sample" : lessons[sample.lesson].title}</h2>
          {#if completion}
            <p role="status">Training complete</p>
            {#if completion.xp || completion.kredits}
              <p>{completion.xp.toLocaleString()} XP · {completion.kredits.toLocaleString()} Analysis Kredits</p>
            {/if}
            <button type="button" disabled={loading} onclick={() => void loadSample()}>Open sample</button>
          {:else if rewardView}
            <p>Rank {progress.rank.toLocaleString()}</p>
            {#if rankProgress}
              <label class="gauge rank-progress">
                <span>{word(rewardLabels + "RankProgress", "Rank progress")} <strong>{rankProgress.xp.toLocaleString()} / {rankProgress.cap.toLocaleString()} XP</strong></span>
                <meter min="0" max={rankProgress.cap} value={rankProgress.xp}></meter>
              </label>
            {/if}
            {#if regularReward?.rank}<p>New rank reached · {regularReward.rank.toLocaleString()}</p>{/if}
            {#if regularReward?.crates}
              <p>{regularReward.crates.toLocaleString()} {regularReward.crates === 1 ? "reward crate" : "reward crates"} in Redeem Items</p>
            {/if}
            {#if regularReward?.tier}<p>Tier reward · Rank {regularReward.tier.toLocaleString()}</p>{/if}
            <button type="button" disabled={loading} onclick={() => void loadSample()}>Next sample</button>
          {:else if score === null}
            <p>{practice ? "Select each highlighted point. Return to the first point to close the outline." : "Click around each group of cells. Click the first point again or select Close outline to finish each group."}</p>
            <p role="status">{polygons.length} {polygons.length === 1 ? "group" : "groups"} outlined</p>
            <div class="actions">
              {#if !practice}<button type="button" disabled={loading || outline.length < 3} onclick={finishOutline}>Close outline</button>{/if}
              <button type="button" disabled={loading || (!outline.length && !polygons.length)} onclick={undo}>Undo</button>
              <button type="button" disabled={loading || (!outline.length && !polygons.length)} onclick={() => { outline = []; polygons = []; }}>Clear</button>
            </div>
            <button type="button" disabled={loading || outline.length > 0 || !polygons.length} onclick={submit}>Submit</button>
          {:else}
            <p role="status">{practice ? "Practice outline complete" : `Classification score ${percent(score)}`}</p>
            {#if taskScores}
              <div class="result-gauges">
                {@render gauge(word(resultLabels + "Accuracy", "Accuracy"), score)}
                {@render gauge(word(resultLabels + "HighScore", "High score"), taskScores.high)}
                {@render gauge(word(resultLabels + "ParScore", "Par score"), 0.5)}
                {@render gauge(word(resultLabels + "AverageScore", "Average score"), taskScores.average)}
              </div>
            {/if}
            {#if solution.length}
              <label><input type="checkbox" bind:checked={showSolution} /> Show reference outlines</label>
            {/if}
            {#if regularReward && (regularReward.xp || regularReward.isk || regularReward.kredits)}
              <p>{regularReward.xp.toLocaleString()} XP · {regularReward.isk.toLocaleString()} ISK · {regularReward.kredits.toLocaleString()} Analysis Kredits</p>
            {/if}
            {#if regularReward?.bonus}<p>Bonus XP × 2</p>{/if}
            {#if sample.lesson === null}
              <button type="button" disabled={loading} onclick={() => { rewardView = true; }}>Continue</button>
            {:else}
              {@const advance = score > 0.5}
              <button type="button" disabled={loading} onclick={() => void loadSample(advance)}>
                {advance ? sample.lesson === lessons.length - 1 ? sample.review ? "Finish retraining" : "Finish training" : "Next lesson" : "Try again"}
              </button>
            {/if}
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
            <button type="button" disabled={loading} onclick={() => void loadSample()}>{progress.finishedTutorial ? "Open sample" : progress.tutorialLevel > 0 ? "Resume training" : "Start training"}</button>
            {#if !progress.finishedTutorial}
              <button type="button" disabled={loading} onclick={skipTraining}>{word(introLabels + "TransitionButtonSkip", "Skip training")}</button>
            {/if}
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
    {#if !restarting}
      <button class="discovery-help" type="button" aria-label="Project Discovery Help" title={word("UI/ProjectDiscovery/HelpTutorialTooltip", "Restart tutorial")}
        disabled={loading || (sample !== null && score !== null)} onclick={() => { restarting = true; error = ""; }}>?</button>
    {/if}
  {:else if loading}
    <p role="status">Loading Project Discovery…</p>
  {:else if error}
    <div role="alert"><p>{error}</p><button type="button" onclick={load}>Retry</button></div>
  {/if}
</section>

<style>
  .discovery { box-sizing: border-box; display: grid; align-content: start; min-height: 100%; padding: 24px; }
  .discovery-help { justify-self: start; margin-top: 16px; }
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
  .practice-image { position: absolute; inset: 0; width: 100%; height: 100%; }
  .practice-target { position: absolute; width: 30px; height: 30px; padding: 0; transform: translate(-50%, -50%); border: 2px solid #5adeff; background: rgb(77 181 228 / 0.22); }
  .chart-input { padding: 0; border: 0; background: transparent; cursor: crosshair; }
  .chart-input:hover:not(:disabled) { background: transparent; }
  .chart-input:disabled { cursor: default; }
  .sample-controls { display: grid; justify-items: start; gap: 12px; width: min(100%, 280px); }
  .reward-view { width: min(100%, 460px); }
  .result-gauges, .gauge { display: grid; gap: 5px; width: 100%; }
  .gauge span { display: flex; justify-content: space-between; gap: 12px; }
  .gauge meter { width: 100%; height: 10px; accent-color: #75b4bf; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
