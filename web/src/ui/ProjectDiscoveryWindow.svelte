<script lang="ts">
  import { onMount } from "svelte";
  import { bridgeAsk } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { readKeyVal } from "../bridge/wire.ts";
  import { clientTexture } from "../play/window.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const welcomeLabel = "UI/ProjectDiscovery/Covid/Intro/Welcome";
  const beginLabel = "UI/ProjectDiscovery/Covid/Intro/ButtonBegin";
  const sampleImage = clientTexture("res:/UI/Texture/classes/ProjectDiscovery/covid/intro/project_discovery.png");
  type Progress = { rank: number; experience: number; analysisKredits: number; finishedTutorial: boolean };
  let progress = $state<Progress | null>(null);
  let briefing = $state(false);
  let loading = $state(false);
  let error = $state("");

  async function load() {
    if (loading) return;
    loading = true;
    error = "";
    try {
      const state = await bridgeAsk(flow.requestOptions())("ProjectDiscovery", "get_player_state");
      const rank = readKeyVal(state, "rank");
      const experience = readKeyVal(state, "experience");
      const analysisKredits = readKeyVal(state, "analysisKredits");
      const finishedTutorial = readKeyVal(state, "finishedTutorial");
      if (typeof rank !== "number" || typeof experience !== "number" ||
          typeof analysisKredits !== "number" || typeof finishedTutorial !== "boolean") {
        throw new Error("Project Discovery returned an invalid pilot record.");
      }
      progress = { rank, experience, analysisKredits, finishedTutorial };
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Project Discovery could not be reached.";
    } finally {
      loading = false;
    }
  }

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
    <article>
      {#if briefing}
        <h2>Cell population analysis</h2>
        <p>Each dot represents a cell. Look for groups of dots that cluster together. Draw a closed outline around each distinct population.</p>
        <p>EveJS uses local training samples and tracks your results on this pilot.</p>
        <button type="button" onclick={() => { briefing = false; }}>Back</button>
      {:else}
        <h2>{plainText($words.templates[welcomeLabel] ?? "") || "Welcome to Project Discovery"}</h2>
        <img src={sampleImage} alt="" width="474" height="237" />
        <button type="button" onclick={() => { briefing = true; }}>
          {progress.finishedTutorial ? "Review briefing" : plainText($words.templates[beginLabel] ?? "") || "Begin"}
        </button>
      {/if}
    </article>
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
</style>
