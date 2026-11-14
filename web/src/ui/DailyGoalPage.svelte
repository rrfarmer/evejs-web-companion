<script lang="ts">
  // jobboard features/daily_goals/page (DailyGoalPage): Back, the header (UI/DailyGoals/DetailPageHeader, the career's
  // flair) and the title (the goal's name message); the time remaining (not once completed or expired); Progress (the
  // gauge, current, "/ target", the percentage) beside the rewards (DetailsPageRewardsTitle: ISK, LP and the claim
  // button where claimable); Operational Intel (DetailsPageOperationalIntelTitle: the help text); the description
  // (DetailsPageDescriptionTitle). Not here: the contribution method's attribute card (its icon and title from the
  // client's method definitions), the aura panel, the completion convenience (PayForCompletion).
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, DailyGoal } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  let { store, flow, goal: g, onBack, onClaim }: { store: ClientStore; flow: AppFlow; goal: DailyGoal; onBack: () => void; onClaim: () => Promise<void> } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const D = "UI/DailyGoals/";
  $effect(() => {
    flow.requestWords([D + "DetailPageHeader", D + "DetailsPageRewardsTitle", D + "DetailsPageOperationalIntelTitle", D + "DetailsPageDescriptionTitle", "UI/Corporations/Goals/Progress",
      "UI/Commands/Back", "UI/Generic/Claim", "UI/Common/ISK", ...[g.nameID, g.descriptionID, g.helpTextID].filter((x): x is number => x !== null).map((x) => `#${x}`)]);
  });
  const word = (label: string) => plainText(formatTemplate($words.templates[label] ?? "", {} as never, { nameOf: (k, id) => resolvedName($names.resolved, k, id, "") }));
  const FLAIR: Record<number, string> = { 4: "explorer", 5: "industrialist", 6: "enforcer", 7: "sof" };
  const flair = $derived(clientTexture(`res:/UI/Texture/Shared/CareerPaths/${(g.careerPath !== null && FLAIR[g.careerPath]) || "unclassified"}_flair.png`));
  const ratio = $derived(g.target ? Math.min(1, g.current / g.target) : 0);
  const completed = $derived(g.target > 0 && g.current >= g.target);
  const expired = $derived(g.activeUntilMs !== null && g.activeUntilMs <= Date.now());
  const left = $derived.by(() => {
    if (g.activeUntilMs === null) return "";
    const m = Math.max(0, Math.floor((g.activeUntilMs - Date.now()) / 60_000));
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  });
  let claiming = $state(false);
</script>

<div class="dp">
  <div class="dp-back"><button class="dp-ghost" onclick={onBack}>{word("UI/Commands/Back") || "Back"}</button></div>
  <header class="dp-head"><img class="dp-flair" src={flair} alt="" /><span class="dp-caption">{word(D + "DetailPageHeader")}</span>
    <h2>{g.nameID ? word(`#${g.nameID}`) : ""}</h2></header>
  {#if !completed && !expired && left}<p class="dp-dim">⏱ {left}</p>{/if}
  <div class="dp-cards">
    <section><h3>{word("UI/Corporations/Goals/Progress")}</h3>
      <div class="dp-progress"><span class="dp-gauge" class:done={completed} style:--outer={`${ratio * 360}deg`}><span></span></span>
        <div><b>{g.current.toLocaleString("en-US")}</b><small>/ {g.target.toLocaleString("en-US")}</small><small>{Math.floor(ratio * 100)}%</small></div></div>
    </section>
    <section><h3>{word(D + "DetailsPageRewardsTitle")}</h3>
      {#each g.rewards as r, i (i)}<div>{r.kind === "isk" ? `${r.amount.toLocaleString("en-US")} ${word("UI/Common/ISK") || "ISK"}` : `${r.amount.toLocaleString("en-US")} LP${r.corporationID ? ` · ${resolvedName($names.resolved, "owner", r.corporationID, "")}` : ""}`}</div>{/each}
      {#if g.claimable}<button class="dp-claim" disabled={claiming} onclick={async () => { claiming = true; try { await onClaim(); } finally { claiming = false; } }}>{claiming ? "…" : word("UI/Generic/Claim") || "Claim"}</button>{/if}
    </section>
  </div>
  {#if g.helpTextID}<section><h3>{word(D + "DetailsPageOperationalIntelTitle")}</h3><p>{word(`#${g.helpTextID}`)}</p></section>{/if}
  {#if g.descriptionID}<section><h3>{word(D + "DetailsPageDescriptionTitle")}</h3><p>{word(`#${g.descriptionID}`)}</p></section>{/if}
</div>

<style>
  .dp { display: flex; flex-direction: column; gap: 8px; }
  .dp-ghost { background: none; border: 1px solid rgba(255, 255, 255, 0.2); }
  .dp-head { position: relative; overflow: hidden; padding: 16px; background: rgba(0, 0, 0, 0.5); }
  .dp-flair { position: absolute; right: -160px; top: -160px; width: 360px; height: 360px; opacity: 0.25; pointer-events: none; }
  .dp-caption { position: relative; opacity: 0.8; }
  .dp-head h2 { position: relative; margin: 24px 0 0; font-size: 20px; }
  .dp-dim { opacity: 0.65; }
  .dp-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
  .dp h3 { margin: 12px 0 8px; font-size: 14px; }
  .dp-progress { display: flex; gap: 16px; align-items: center; }
  .dp-progress div { display: flex; flex-direction: column; }
  .dp-gauge { width: 80px; height: 80px; border-radius: 50%; background: conic-gradient(#4fd1c5 var(--outer), rgba(255, 255, 255, 0.1) 0); display: flex; align-items: center; justify-content: center; }
  .dp-gauge.done { background: conic-gradient(#5fb85f var(--outer), rgba(255, 255, 255, 0.1) 0); }
  .dp-gauge span { width: 70px; height: 70px; border-radius: 50%; background: #111; }
  .dp-claim { margin-top: 8px; }
</style>
