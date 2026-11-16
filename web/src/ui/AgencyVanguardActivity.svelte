<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow, onShowMap }: { store: ClientStore; flow: AppFlow; onShowMap?: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const title = "UI/Agency/Seasons/VanguardNemesis/VanguardPoints";
  const info = "UI/Agency/Seasons/VanguardNemesis/InfoHint";
  const active = "UI/Agency/Seasons/VanguardNemesis/ActiveConvoys";
  const repeatable = "UI/Common/Repeatable";
  const showMap = "UI/Commands/ShowLocationOnMap";
  const noData = "UI/Common/NoDataAvailable";
  const pointsIcon = clientTexture("res:/UI/Texture/classes/Seasons/eventIcon_64x64.png");
  const logo = clientTexture("res:/UI/Texture/classes/Seasons/VanguardNemesis/vanguard_icon_28px.png");
  const word = (label: string, fallback: string, args: Record<string, number> = {}) =>
    plainText(formatTemplate($words.templates[label] ?? "", args, { nameOf: () => "" })) || fallback;

  let activity = $state<Awaited<ReturnType<AppFlow["agencyVanguardActivity"]>>>(null);
  let loading = $state(true);
  const value = $derived(Math.min(100, activity?.percent ?? 0));

  onMount(() => {
    flow.requestWords([title, info, active, repeatable, showMap, noData]);
    let mounted = true;
    let request = 0;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      clearTimeout(timer);
      const serial = ++request;
      try {
        const next = await flow.agencyVanguardActivity();
        if (mounted && serial === request && next) activity = next;
      } catch {
        // Keep the last available progress through a transient read failure.
      } finally {
        if (mounted && serial === request) {
          loading = false;
          timer = setTimeout(refresh, 30_000);
        }
      }
    };
    let completed = flow.agencyVanguardCompleted.get();
    const stop = flow.agencyVanguardCompleted.subscribe(n => {
      if (n === completed) return;
      completed = n;
      void refresh();
    });
    void refresh();
    return () => { mounted = false; stop(); clearTimeout(timer); };
  });
</script>

<section class="activity" aria-label={word(title, "Vanguard Activity")}>
  <header>
    <h2>{word(title, "Vanguard Activity")}</h2>
    <span class="info" role="img" aria-label={word(info, "Community activity reveals SARO Black Sites.")}
      title={word(info, "Community activity reveals SARO Black Sites.")}>ⓘ</span>
  </header>
  {#if activity}
    <div class="points">
      <img src={pointsIcon} alt="" />
      <strong>{activity.percent}%</strong>
      <span>{word(repeatable, "Repeatable")}</span>
    </div>
    <div class="body">
      <div class="gauge" role="meter" aria-label={word(title, "Vanguard Activity")} aria-valuemin="0"
        aria-valuemax="100" aria-valuenow={value} style:--progress={value + "%"}>
        <img src={logo} alt="" />
      </div>
      <div class="sites">
        <strong>{word(active, `SARO Black Sites: ${activity.convoyCount}`, { amount: activity.convoyCount })}</strong>
        {#if onShowMap}<button type="button" onclick={onShowMap}>{word(showMap, "Show on Map")}</button>{/if}
      </div>
    </div>
  {:else}
    <p role="status">{loading ? "Loading Vanguard activity…" : word(noData, "No data available")}</p>
  {/if}
</section>

<style>
  .activity { padding: 4px 8px 8px; min-width: 0; }
  header, .points, .body { display: flex; align-items: center; }
  header { gap: 8px; }
  h2 { margin: 0; font-size: 16px; }
  .info, .points span { color: rgb(255 255 255 / 65%); }
  .points { gap: 8px; }
  .points img { width: 48px; height: 48px; }
  .points strong { font-size: 29px; }
  .body { gap: 24px; margin-top: 16px; }
  .gauge { display: grid; place-items: center; width: 77px; height: 77px; flex: none; position: relative; }
  .gauge::before { content: ""; position: absolute; inset: 0; border-radius: 50%;
    background: conic-gradient(#46d9f8 var(--progress), #4b5053 0);
    mask-image: radial-gradient(transparent 60%, black 62%); }
  .gauge img { width: 28px; height: 28px; }
  .sites { display: grid; justify-items: start; gap: 8px; }
  button { padding: 4px 8px; border: 1px solid rgb(255 255 255 / 25%); background: rgb(255 255 255 / 7%); color: inherit; cursor: pointer; }
  button:hover { background: rgb(255 255 255 / 15%); }
</style>
