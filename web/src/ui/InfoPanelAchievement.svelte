<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { AchievementCatalogue, AchievementProgress, UnclaimedAchievementReward } from "../bridge/achievements.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { uuidFromBytes } from "../bridge/skillPlans.ts";
  import { clientTexture } from "../play/window.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { achievementRequest } from "./achievementRequests.ts";
  import { achievementMilestone, achievementTrackingFor } from "./achievementTracking.ts";

  let { store, flow, compact, onToggle }: { store: ClientStore; flow: AppFlow; compact: boolean; onToggle: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const tracking = $derived(achievementTrackingFor($station.online?.characterID ?? null));
  const tracked = $derived(tracking.state);
  const ids = $derived($tracked.ids);
  const hasTracked = $derived(ids.length > 0);
  const W = "UI/Achievements/Window/";
  const icon = clientTexture("res:/UI/Texture/WindowIcons/achievements.png");
  const label = (id: string, fallback = "") => plainText($words.templates[id] ?? "") || fallback;
  const number = (value: number) => value.toLocaleString("en-US");

  let catalogue = $state.raw<AchievementCatalogue | null>(null);
  let progress = $state.raw<ReadonlyMap<string, AchievementProgress | null>>(new Map());
  let rewards = $state.raw<readonly UnclaimedAchievementReward[]>([]);
  let noticeCount = $state(0);
  let menu = $state<string | null>(null);
  const definitions = $derived(new Map(catalogue?.achievements.map(row => [row.id, row])));
  const categories = $derived(new Map(catalogue?.categories.map(row => [row.id, row])));
  const rows = $derived(ids.flatMap(id => definitions.get(id) ?? []));

  $effect(() => {
    if (!hasTracked || catalogue) return;
    let current = true;
    void flow.achievementCatalogue().then(data => { if (current) catalogue = data; }).catch(() => {});
    return () => { current = false; };
  });
  $effect(() => {
    const keys = rows.flatMap(row => [row.name, row.description, categories.get(row.category)?.name ?? 0]).filter(Boolean);
    if (keys.length) flow.requestWords([`${W}Title`, `${W}Rewards/ClaimRewards`, "UI/Achievements/Progress", "UI/Achievements/ViewCategory", "UI/Achievements/ViewDetails", "UI/Common/Untrack", ...keys.map(id => `#${id}`)]);
  });
  onMount(() => flow.gatewayNotices.subscribe(notice => {
    if (!notice?.typeName.startsWith("eve_public.achievement.")) return;
    const payload = notice.payload as { achievement?: { uuid?: string } } | null;
    const id = uuidFromBytes(payload?.achievement?.uuid ?? "");
    if (id && tracked.get().ids.includes(id)) noticeCount = notice.n;
  }));
  $effect(() => {
    const requestedIDs = ids;
    const pilotTracking = tracking;
    // An achievement notice invalidates the live progress and unclaimed lists.
    void noticeCount;
    progress = new Map();
    rewards = [];
    if (!requestedIDs.length) return;
    let current = true;
    for (const id of requestedIDs) {
      void flow.achievementProgress(id).then(row => {
        if (current && tracking === pilotTracking) progress = new Map(progress).set(id, row);
      }).catch(() => {
        if (current && tracking === pilotTracking) progress = new Map(progress).set(id, null);
      });
    }
    void flow.achievementRewards().then(unclaimed => {
      if (current && tracking === pilotTracking) rewards = unclaimed;
    }).catch(() => {});
    return () => { current = false; };
  });
</script>

{#if rows.length}
  <section aria-label={label(`${W}Title`, "Achievements")} class="panel">
    <header class="panel-top">
      <button type="button" class="panel-icon arrow" class:expanded={!compact} aria-label={compact ? "Expand Achievements" : "Collapse Achievements"} aria-expanded={!compact} onclick={onToggle}>
        <img alt="" src={clientTexture("res:/UI/Texture/classes/Neocom/arrowDown.png")} />
      </button>
      <button type="button" class="panel-icon" aria-label="Open Achievements" onclick={() => achievementRequest.set({ kind: "window" })}>
        <img alt="" src={icon} />
      </button>
      <span>{label(`${W}Title`, "Achievements")}</span>
    </header>
    {#if !compact}
      <div class="rows">
        {#each rows as row (row.id)}
          {@const data = progress.get(row.id)}
          {@const target = achievementMilestone(row, data ?? undefined)?.target ?? 0}
          {@const count = Math.min(data?.current ?? 0, target)}
          {@const expanded = $tracked.expanded === row.id}
          {@const name = label(`#${row.name}`, row.icon)}
          <article class:completed={data?.completed}>
            <header class="row-top">
              <button type="button" class="category" aria-label={label("UI/Achievements/ViewCategory", "View Category")} onclick={() => achievementRequest.set({ kind: "category", id: row.category })}>
                <img alt="" src={icon} />
              </button>
              <button type="button" class="row-title" aria-expanded={expanded} onclick={() => { menu = null; tracking.toggleExpanded(row.id); }}>
                <span>{name}</span>
                {#if data && !expanded}<span>{number(count)}/{number(target)}</span>{/if}
              </button>
              <button type="button" class="menu-button" aria-label={`${name} options`} aria-expanded={menu === row.id} onclick={() => menu = menu === row.id ? null : row.id}>⋯</button>
            </header>
            {#if menu === row.id}
              <div class="menu">
                <button type="button" onclick={() => { menu = null; achievementRequest.set({ kind: "achievement", id: row.id }); }}>{label("UI/Achievements/ViewDetails", "View Details")}</button>
                <button type="button" onclick={() => { menu = null; tracking.untrack(row.id); }}>{label("UI/Common/Untrack", "Untrack")}</button>
              </div>
            {/if}
            {#if expanded}
              <div class="details">
                <p>{plainText(formatTemplate($words.templates[`#${row.description}`] ?? "", { amount: target }, { nameOf: () => "" }))}</p>
                {#if row.milestones.length > 1}
                  <ol aria-label="Milestones">
                    {#each row.milestones as milestone (milestone.id)}
                      <li class:reached={Boolean(data && (data.completed || data.current >= milestone.target))}>{number(milestone.target)}</li>
                    {/each}
                  </ol>
                {/if}
                {#if data}
                  <div class="progress-label"><span>{label("UI/Achievements/Progress", "Progress")}</span><span>{number(count)}/{number(target)}</span></div>
                  <progress aria-label={`${name} progress`} max={target || 1} value={count}></progress>
                {:else if data === null}<span role="status">Progress unavailable</span>
                {:else}<span role="status">Loading progress…</span>{/if}
                {#if data?.completed && rewards.some(reward => reward.kind === "achievement" && reward.source === row.id && reward.rewards.length)}
                  <button type="button" class="claim" onclick={() => achievementRequest.set({ kind: "rewards" })}>{label(`${W}Rewards/ClaimRewards`, "Claim Rewards")}</button>
                {/if}
              </div>
            {/if}
          </article>
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  .panel { pointer-events: auto; }
  .panel-top { display: flex; align-items: center; height: 28px; font-size: 14px; color: #ffffffd9; }
  button { color: inherit; cursor: pointer; }
  .panel-icon { background: transparent; border: 0; width: 28px; height: 28px; display: grid; place-items: center; opacity: .8; }
  .panel-icon:hover { opacity: 1; }
  .panel-icon img { width: 18px; height: 18px; }
  .panel-icon.arrow img { width: 7px; height: 7px; transform: rotate(-90deg); }
  .panel-icon.arrow.expanded img { transform: none; }
  .rows { display: grid; gap: 8px; padding: 4px 0 8px 56px; }
  article { position: relative; background: #0006; }
  article.completed { box-shadow: inset 2px 0 #68be91; }
  .row-top { display: flex; align-items: center; min-height: 36px; }
  .row-top button { border: 0; background: transparent; padding: 4px; }
  .row-top button:hover, .row-top button:focus-visible { background: #ffffff23; }
  .category { flex: none; margin-left: 4px; }
  .category img { display: block; width: 16px; height: 16px; }
  .row-title { flex: 1; min-width: 0; display: flex; justify-content: space-between; align-items: center; gap: 6px; text-align: left; }
  .row-title span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu-button { opacity: .65; }
  .menu { position: absolute; right: 0; z-index: 1; display: grid; background: #151e26; border: 1px solid #697c8b; }
  .menu button, .claim { background: transparent; border: 0; padding: 5px 8px; text-align: left; }
  .menu button:hover, .claim:hover { background: #ffffff23; }
  .details { padding: 4px 8px 10px; background: #0004; }
  .details p { margin: 2px 0 8px; }
  ol { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; margin: 0 0 8px; padding: 0; color: #cbd5dc; }
  .reached { color: #7bdcb3; }
  .progress-label { display: flex; justify-content: space-between; }
  progress { display: block; height: 5px; width: 100%; margin-top: 4px; accent-color: #a4d4e5; }
  .claim { display: block; width: 100%; margin-top: 10px; border: 1px solid #68be91; color: #96e5bb; text-align: center; }
</style>
