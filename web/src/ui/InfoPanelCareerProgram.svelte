<script lang="ts">
  // infoPanels/infoPanelCareerProgram.InfoPanelCareerProgram (PANEL_CAREER_PROGRAM 23, before the job board's in
  // PANELTYPES; careerProgram.png). IsAvailable: the controller tracks a goal (flow.trackedCareerGoals).
  // - The header: UI/CareerPortal/CareerPortalWnd; its button opens the Career Portal (not here yet).
  // - A TrackedGoal for each tracked goal the goals' data has: SectionHeader (0.35 black: the goal's name, one line,
  //   its hint the name; the Aura icon at the right, its hint the goal's aura text); under it on 0.25 black
  //   UI/CareerPortal/GoalProgressCompleted {progressValue, targetValue}, a click folding the rest away; the description;
  //   where a reward is unclaimed the success line at the left and UI/CareerPortal/ClaimRewards (which opens the portal).
  // OnRewardClaimed: a tracked goal with nothing left to claim is untracked. Not here: the Career Portal window (its
  // goals, tracking and claiming), the Aura panel's tooltip, the notices' live progress.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, CareerGoal } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "../play/window.ts";
  let { store, flow, compact, onToggle }: { store: ClientStore; flow: AppFlow; compact: boolean; onToggle: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const tracked = flow.trackedCareerGoals;
  const C = "UI/CareerPortal/";
  let goals = $state<readonly CareerGoal[] | null>(null);
  $effect(() => {
    if (!$tracked.length) return;
    void flow.careerGoals().then((g) => { goals = g; }, () => { goals = null; });
  });
  const shown = $derived($tracked.map((id) => goals?.find((g) => g.goalID === id) ?? null).filter((g): g is CareerGoal => g !== null));
  $effect(() => {
    flow.requestWords([C + "CareerPortalWnd", C + "GoalProgressCompleted", C + "ClaimRewards",
      ...shown.flatMap((g) => [g.nameID, g.descriptionID, Number(g.annotations.auraTextID) || null]).filter((x): x is number => !!x).map((x) => `#${x}`)]);
  });
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (k, id) => resolvedName($names.resolved, k, id, "") }));
  let folded = $state<Record<string, boolean>>({});
</script>

{#if $tracked.length && shown.length}
  <section class="ip-panel">
    <div class="ip-top">
      <div class="ip-gutter">
        <button type="button" class="ip-expand" class:expanded={!compact} aria-label={compact ? "Expand" : "Collapse"} onclick={onToggle}>
          <img alt="" src={clientTexture("res:/UI/Texture/classes/Neocom/arrowDown.png")} /></button>
        <span class="ip-icon"><img alt="" src={clientTexture("res:/ui/Texture/Classes/InfoPanels/careerProgram.png")} /></span>
      </div>
      <span class="cp-title">{word(C + "CareerPortalWnd")}</span>
    </div>
    {#if !compact}
      <div class="ip-main">
        {#each shown as g (g.goalID)}
          <div class="cp-goal">
            <div class="cp-head" title={g.nameID ? word(`#${g.nameID}`) : ""}>
              <span class="cp-name">{g.nameID ? word(`#${g.nameID}`) : ""}</span>
              <img alt="" title={Number(g.annotations.auraTextID) ? word(`#${g.annotations.auraTextID}`) : ""} src={clientTexture("res:/UI/Texture/classes/careerPortal/aura/aura_icon_16x16.png")} />
            </div>
            <div class="cp-body">
              <button type="button" class="cp-progress" class:done={g.unclaimedRewards} onclick={() => { folded = { ...folded, [g.goalID]: !folded[g.goalID] }; }}>
                {word(C + "GoalProgressCompleted", { progressValue: g.progress, targetValue: g.target })}</button>
              {#if !folded[g.goalID]}
                <p>{g.descriptionID ? word(`#${g.descriptionID}`) : ""}</p>
                {#if g.unclaimedRewards}<button type="button" class="cp-claim">{word(C + "ClaimRewards")}</button>{/if}
              {/if}
            </div>
          </div>
        {/each}
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
  .cp-title { font-size: 14px; letter-spacing: 0.04em; color: rgb(255 255 255 / 0.85); }
  .ip-main { padding-left: 56px; }
  .cp-goal { margin-bottom: 8px; }
  .cp-head { display: flex; align-items: center; gap: 4px; padding: 8px; background: rgb(0 0 0 / 0.35); }
  .cp-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; color: #fff; }
  .cp-head img { width: 16px; height: 16px; }
  .cp-body { margin-top: 4px; padding: 8px; background: rgb(0 0 0 / 0.25); }
  .cp-progress { all: unset; cursor: pointer; display: block; font-size: 14px; padding-left: 8px; margin-left: -8px; border-left: 2px solid transparent; }
  .cp-progress.done { border-left-color: rgb(95 184 95 / 0.75); }
  .cp-body p { margin: 4px; font-size: 12px; color: rgb(255 255 255 / 0.8); }
  .cp-claim { width: 100%; }
</style>
