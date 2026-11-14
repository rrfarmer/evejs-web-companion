<script lang="ts">
  // jobboard features/daily_goals/card (DailyGoalCard): the top title (the AIR logo, UI/DailyGoals/CardTitle), the
  // progress gauge (2 high, its label current / target, green once completed), the title (the goal's name message, two
  // lines), the career's flair and tag icon (a checkmark once completed), at the bottom the rewards (ISK, LP) and, while
  // not completed nor expired, the time remaining; the claim button (UI/Generic/Claim) where a reward is claimable. The
  // left line SUCCESS_GREEN once completed, else AIR_TURQUOISE. Its click opens the goal's page.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, DailyGoal } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  let { store, flow, goal: g, onOpen, onClaim }: { store: ClientStore; flow: AppFlow; goal: DailyGoal; onOpen: () => void; onClaim: () => Promise<void> } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  $effect(() => { flow.requestWords(["UI/DailyGoals/CardTitle", "UI/Generic/Claim", "UI/Common/ISK", ...(g.nameID ? [`#${g.nameID}`] : [])]); });
  const word = (label: string) => plainText(formatTemplate($words.templates[label] ?? "", {} as never, { nameOf: (k, id) => resolvedName($names.resolved, k, id, "") }));
  const FLAIR: Record<number, string> = { 4: "explorer", 5: "industrialist", 6: "enforcer", 7: "sof" };
  const flair = $derived(clientTexture(`res:/UI/Texture/Shared/CareerPaths/${(g.careerPath !== null && FLAIR[g.careerPath]) || "unclassified"}_flair.png`));
  const completed = $derived(g.target > 0 && g.current >= g.target);
  const expired = $derived(g.activeUntilMs !== null && g.activeUntilMs <= Date.now());
  const left = $derived.by(() => {
    if (g.activeUntilMs === null) return "";
    const m = Math.max(0, Math.floor((g.activeUntilMs - Date.now()) / 60_000));
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  });
  const reward = (r: DailyGoal["rewards"][number]) => (r.kind === "isk" ? `${r.amount.toLocaleString("en-US")} ${word("UI/Common/ISK") || "ISK"}` : `${r.amount.toLocaleString("en-US")} LP`);
  let claiming = $state(false);
</script>

<div class="dg-card" class:done={completed} role="button" tabindex="-1" onclick={onOpen} onkeydown={() => {}}>
  <img class="dg-flair" src={flair} alt="" />
  <div class="dg-top"><img class="dg-air" alt="" src={clientTexture("res:/UI/Texture/classes/SkillPlan/airLogo.png")} /><span>{word("UI/DailyGoals/CardTitle")}</span>
    {#if completed}<span class="dg-check">✔</span>{/if}</div>
  <div class="dg-gauge"><span style:width={`${Math.min(1, g.target ? g.current / g.target : 0) * 100}%`}></span></div>
  <div class="dg-gauge-label" class:done={completed}>{g.current.toLocaleString("en-US")} / {g.target.toLocaleString("en-US")}</div>
  <div class="dg-title">{g.nameID ? word(`#${g.nameID}`) : ""}</div>
  <div class="dg-bottom">
    {#each g.rewards as r, i (i)}<span>{reward(r)}</span>{/each}
    <span class="dg-gap"></span>
    {#if g.claimable}<button class="dg-claim" disabled={claiming} onclick={async (e) => { e.stopPropagation(); claiming = true; try { await onClaim(); } finally { claiming = false; } }}>{claiming ? "…" : word("UI/Generic/Claim") || "Claim"}</button>
    {:else if !completed && !expired && left}<span class="dg-dim">⏱ {left}</span>{/if}
  </div>
</div>

<style>
  .dg-card { position: relative; overflow: hidden; cursor: pointer; height: 170px; display: flex; flex-direction: column; padding: 12px; box-sizing: border-box; border-left: 2px solid #4fd1c5; background: rgba(0, 0, 0, 0.6); border-radius: 0 8px 8px 0; }
  .dg-card.done { border-left-color: #5fb85f; }
  .dg-flair { position: absolute; right: -160px; top: -160px; width: 360px; height: 360px; opacity: 0.3; pointer-events: none; }
  .dg-top { position: relative; display: flex; align-items: center; gap: 6px; font-size: 11px; opacity: 0.8; }
  .dg-air { width: 31px; height: 12px; opacity: 0.6; }
  .dg-check { margin-left: auto; color: #5fb85f; font-size: 16px; }
  .dg-gauge { position: relative; height: 2px; margin-top: 10px; background: rgba(255, 255, 255, 0.1); }
  .dg-gauge span { display: block; height: 100%; background: #4fd1c5; }
  .dg-card.done .dg-gauge span { background: #5fb85f; }
  .dg-gauge-label { position: relative; font-size: 11px; opacity: 0.7; padding-top: 2px; }
  .dg-gauge-label.done { color: #5fb85f; opacity: 1; }
  .dg-title { position: relative; flex: 1; font-weight: bold; padding-top: 10px; overflow: hidden; }
  .dg-bottom { position: relative; display: flex; gap: 8px; align-items: center; padding: 2px 8px; border-radius: 8px; background: rgba(255, 255, 255, 0.05); font-size: 12px; }
  .dg-gap { flex: 1; }
  .dg-dim { opacity: 0.65; }
</style>
