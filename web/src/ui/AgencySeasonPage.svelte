<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { seasonPageKind, type AgencySeason, type decodeAgencySeasonProgress } from "../bridge/agencySeason.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow, season }: { store: ClientStore; flow: AppFlow; season: AgencySeason } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const personal = "UI/Agency/Seasons/VanguardNemesis/PersonalPointsEarned";
  const label = (key: string | number | null, fallback = "") => plainText($words.templates[typeof key === "number" ? `#${key}` : key ?? ""] ?? "") || fallback;
  const variant = $derived(seasonPageKind(season.templateID));
  let progress = $state<ReturnType<typeof decodeAgencySeasonProgress>>(null), unread = $state(true);
  $effect(() => {
    void season.templateID;
    let current = true;
    unread = true;
    flow.requestWords([personal]);
    void flow.agencySeasonProgress().then(row => { if (current) progress = row; }, () => { if (current) progress = null; }).finally(() => { if (current) unread = false; });
    return () => { current = false; };
  });
</script>

<section class="season" class:vanguard={variant === "vanguard"} aria-label={label(season.titleID, "Season")}>
  <header style:background-image={season.banner ? `linear-gradient(transparent,#10151a), url('${clientTexture(season.banner)}')` : undefined}>
    <h2>{label(season.titleID)}</h2>
    {#if season.endMs}<time datetime={new Date(season.endMs).toISOString()}>Ends {new Date(season.endMs).toLocaleString("en-GB", { timeZone: "UTC" })} EVE</time>{/if}
    <p>{label(season.newsID)}</p>
  </header>
  {#if progress}
    <div class="season-progress">
      <strong>{variant === "vanguard" ? label(personal, "Personal Points Earned") : "Seasonal points"}</strong>
      <span>{progress.points.toLocaleString()}{#if progress.target} / {progress.target.toLocaleString()}{/if}</span>
      {#if progress.target}<progress aria-label="Seasonal progress" max={progress.target} value={progress.points}></progress>{/if}
    </div>
    <div class="season-cards">
      {#each progress.challenges as task (task.id)}
        <article><h3>{label(task.name)}</h3><p>{label(task.detail)}</p>
          {#if task.target}<progress aria-label="Challenge progress" max={task.target} value={task.current}></progress>{task.current} / {task.target}{/if}
          {#if task.points}<small>{task.points} points</small>{/if}
        </article>
      {/each}
    </div>
  {:else}<p role="status">{unread ? "Loading seasonal progress…" : "Seasonal progress unavailable."}</p>{/if}
</section>

<style>
  header { background-size: cover; background-position: center; padding: 80px 16px 12px; min-height: 145px; }
  h2 { font-size: 24px; margin: 0; }
  h3 { margin: 0; }
  p { margin: 6px 0; }
  .season-progress { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px; padding: 16px; background: #ffffff08; }
  .vanguard .season-progress span { font-size: 32px; }
  progress { width: 100%; accent-color: var(--theme-focus, #58a6dc); grid-column: 1 / -1; }
  .season-cards { padding: 8px 16px; display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 8px; }
  article { padding: 10px; background: #ffffff0c; border: 1px solid #ffffff1c; }
  small { display: block; }
</style>
