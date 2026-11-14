<script lang="ts">
  // jobboard features/daily_goals: the daily goals' feature page's top (DailyGoalsFeaturePage._construct_header and
  // _construct_reward_track, RewardTrackFeaturePage).
  // - The header: UI/DailyGoals/MonthlyTrack, its hint UI/DailyGoals/RewardTrackInfo, and at the right the alpha
  //   milestones' earliest expiry (MonthlyTrackExpiresIn; UI/Generic/Expired).
  // - BonusGoalContainer: the bonus goal of the day (get_bonus_job_of_the_day: the CATEGORY_DAILY_BONUS goal), its SP
  //   reward's amount, DailyBonusGauge (current/target, SUCCESS_GREEN once completed, AIR_TURQUOISE before; a checkmark
  //   once completed and claimed; its hint the help text), and Claim All (UI/Opportunities/ClaimAll) while any daily
  //   goal's reward is claimable.
  // - The Omega and Alpha icons, then four milestones a column: the omega one above, the alpha one below
  //   (get_omega / get_alpha_milestones_of_the_month: the CATEGORY_MONTHLY_BONUS goals by their omega flag, by target),
  //   the fourth final. Milestone._find_milestone_state: CLAIMED (completed and nothing to claim), OMEGA_LOCKED (an omega
  //   milestone while the pilot is an alpha clone), DEFAULT (not completed), COMPLETED (claimable); its status text
  //   STATE_TO_STATUS_TEXT (UI/DailyGoals/notEarned, claimable). The reward's icon (find_skill_icon_from_amount for SP,
  //   eveicon isk) and amount.
  // - FeaturePageProgressBar between the rows: twelve points (two arrows and a marker, four times), the track's
  //   progress the final alpha milestone's: a point before it COMPLETED, the one at it ACTIVE while the bonus goal is
  //   at 1, the rest INACTIVE.
  // Not here: the Upgrade button (the omega shop), the animations and sounds, an item reward's redeem location.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, DailyGoal } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  let { store, flow, goals, busy, onClaimAll }: { store: ClientStore; flow: AppFlow; goals: readonly DailyGoal[]; busy: boolean; onClaimAll: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const D = "UI/DailyGoals/";
  const bonus = $derived(goals.find((g) => g.category === "CATEGORY_DAILY_BONUS") ?? null);
  const monthly = $derived(goals.filter((g) => g.category === "CATEGORY_MONTHLY_BONUS"));
  const alpha = $derived(monthly.filter((g) => !g.omega).sort((a, b) => a.target - b.target));
  const omegaJobs = $derived(monthly.filter((g) => g.omega).sort((a, b) => a.target - b.target));
  $effect(() => {
    flow.requestWords([D + "MonthlyTrack", D + "RewardTrackInfo", D + "MonthlyTrackExpiresIn", D + "notEarned", D + "claimable", "UI/Generic/Expired", "UI/Opportunities/ClaimAll", "UI/Common/ISK",
      ...[...monthly, ...(bonus ? [bonus] : [])].flatMap((g) => [g.nameID, g.helpTextID]).filter((x): x is number => x !== null).map((x) => `#${x}`)]);
  });
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (k, id) => resolvedName($names.resolved, k, id, "") }));
  // An alpha clone's grade only; a pilot whose grade is not told goes as an omega's (clone_grade_svc).
  const isOmega = $derived($station.cloneGrade !== 0);
  const done = (g: DailyGoal) => (g.target > 0 && g.current >= g.target) || g.paidCompletion;
  type State = "claimed" | "locked" | "default" | "completed";
  const stateOf = (g: DailyGoal, omegaRow: boolean): State => (done(g) && !g.claimable ? "claimed" : omegaRow && !isOmega ? "locked" : !done(g) ? "default" : "completed");
  const STATUS: Partial<Record<State, string>> = { default: D + "notEarned", completed: D + "claimable" };
  const rewardIcon = (r: DailyGoal["rewards"][number] | undefined) => {
    if (!r) return "";
    if (r.kind === "sp") { const k = [10000, 25000, 50000, 100000, 150000].find((x) => r.amount <= x); return clientTexture(`res:/UI/Texture/Icons/SkillPoints/${k ? `${k / 1000}k` : "250k"}.png`); }
    return clientTexture(`res:/UI/Texture/eveicon/category_icons/${r.kind === "isk" ? "isk" : "evermark"}_32px.png`);
  };
  const progress = $derived(alpha.at(-1)?.current ?? 0);
  const points = $derived(Array.from({ length: 12 }, (_, i) => (progress > i ? "completed" : progress === i && bonus?.current === 1 ? "active" : "inactive")));
  const expiresMs = $derived(alpha.filter((g) => g.activeUntilMs !== null && g.activeUntilMs > Date.now()).reduce<number | null>((m, g) => (m === null || g.activeUntilMs! < m ? g.activeUntilMs! : m), null));
  const anyClaimable = $derived(goals.some((g) => g.claimable && !(g.omega && !isOmega)));
  const bonusSp = $derived.by(() => { const r = bonus?.rewards[0]; return r?.kind === "sp" ? r.amount : null; });
  const bonusRatio = $derived(bonus && bonus.target ? Math.min(1, bonus.current / bonus.target) : 0);
</script>

{#if bonus && alpha.length >= 4 && omegaJobs.length >= 4}
  <section class="rt">
    <header class="rt-head"><h3 title={word(D + "RewardTrackInfo")}>{word(D + "MonthlyTrack")} <span class="rt-info">ⓘ</span></h3>
      <span class="rt-dim">{expiresMs === null ? word("UI/Generic/Expired") : word(D + "MonthlyTrackExpiresIn", { remaining: { type: "long", value: String(BigInt(Math.max(0, expiresMs - Date.now())) * 10000n) } })}</span></header>
    <div class="rt-track">
      <div class="rt-bonus">
        {#if bonusSp !== null}<div class="rt-bonus-reward"><img alt="" src={clientTexture("res:/UI/Texture/classes/Opportunities/DailyGoals/bonus_reward_sp.png")} /><span>{bonusSp.toLocaleString("en-US")}</span></div>{/if}
        <span class="rt-gauge" class:done={done(bonus)} style:--outer={`${bonusRatio * 360}deg`} title={bonus.helpTextID ? word(`#${bonus.helpTextID}`) : ""}><span>
          {#if done(bonus) && !bonus.claimable}<b class="rt-check">✔</b>{:else}<b class:done={done(bonus)}>{bonus.current}/{bonus.target}</b>{/if}</span></span>
        {#if anyClaimable}<button disabled={busy} onclick={onClaimAll}>{word("UI/Opportunities/ClaimAll") || "Claim All"}</button>{/if}
      </div>
      <div class="rt-grades">
        {#if isOmega}<img alt="Omega" src={clientTexture("res:/UI/Texture/classes/CloneGrade/Omega_32.png")} />{:else}<span></span>{/if}
        <img alt="Alpha" src={clientTexture("res:/UI/Texture/classes/CloneGrade/Alpha_32.png")} />
      </div>
      <div class="rt-rows">
        {#each [true, false] as omegaRow (omegaRow)}
          <div class="rt-row">
            {#each (omegaRow ? omegaJobs : alpha).slice(0, 4) as g, i (g.goalID)}
              {@const st = stateOf(g, omegaRow)}
              <div class="rt-ms {st}" class:final={i === 3} title={[g.nameID ? word(`#${g.nameID}`) : "", g.helpTextID ? word(`#${g.helpTextID}`) : "", STATUS[st] ? word(STATUS[st]!) : ""].filter(Boolean).join("\n")}>
                {#if st === "locked"}<span class="rt-lock">🔒</span>{/if}
                <img alt="" src={rewardIcon(g.rewards[0])} /><small>{g.rewards[0] ? g.rewards[0].amount.toLocaleString("en-US") : ""}</small>
              </div>
            {/each}
          </div>
          {#if omegaRow}<div class="rt-bar">{#each points as p, i (i)}<span class="{p}" class:marker={i % 3 === 2}></span>{/each}</div>{/if}
        {/each}
      </div>
    </div>
  </section>
{/if}

<style>
  .rt { margin-bottom: 12px; }
  .rt-head { display: flex; align-items: baseline; gap: 8px; }
  .rt-head h3 { margin: 0; font-size: 16px; }
  .rt-info { font-size: 12px; opacity: 0.6; cursor: help; }
  .rt-dim { margin-left: auto; opacity: 0.65; font-size: 12px; }
  .rt-track { display: flex; align-items: center; gap: 12px; padding: 12px 0; }
  .rt-bonus { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 140px; }
  .rt-bonus-reward { display: flex; align-items: center; gap: 4px; }
  .rt-bonus-reward img { width: 32px; height: 32px; }
  .rt-gauge { width: 64px; height: 64px; border-radius: 50%; background: conic-gradient(#4fd1c5 var(--outer), rgba(0, 0, 0, 0.15) 0); display: flex; align-items: center; justify-content: center; }
  .rt-gauge.done { background: conic-gradient(#5fb85f var(--outer), rgba(0, 0, 0, 0.15) 0); }
  .rt-gauge > span { width: 60px; height: 60px; border-radius: 50%; background: #111; display: flex; align-items: center; justify-content: center; }
  .rt-gauge b.done, .rt-check { color: #5fb85f; }
  .rt-grades { display: flex; flex-direction: column; justify-content: space-between; height: 220px; }
  .rt-grades img, .rt-grades span { width: 32px; height: 32px; }
  .rt-rows { display: flex; flex-direction: column; gap: 6px; }
  .rt-row { display: flex; gap: 12px; padding-left: 24px; }
  .rt-ms { position: relative; width: 83px; height: 95px; clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%); background: rgba(255, 255, 255, 0.12); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; }
  .rt-ms img { width: 32px; height: 32px; opacity: 0.5; }
  .rt-ms small { opacity: 0.6; }
  .rt-ms.completed { background: rgba(95, 184, 95, 0.35); }
  .rt-ms.completed img, .rt-ms.completed small { opacity: 1; }
  .rt-ms.claimed { background: rgba(95, 184, 95, 0.15); }
  .rt-ms.locked { background: rgba(232, 188, 76, 0.2); }
  .rt-ms.final { background-color: rgba(255, 255, 255, 0.2); }
  .rt-lock { position: absolute; top: 8px; color: #e8bc4c; font-size: 12px; }
  .rt-bar { display: flex; align-items: center; gap: 2px; padding-left: 24px; height: 12px; }
  .rt-bar span { width: 26px; height: 6px; background: rgba(255, 255, 255, 0.2); clip-path: polygon(0 0, 80% 0, 100% 50%, 80% 100%, 0 100%, 20% 50%); }
  .rt-bar span.marker { width: 14px; height: 12px; margin-right: 12px; clip-path: none; transform: rotate(45deg) scale(0.7); }
  .rt-bar span.completed { background: #5fb85f; }
  .rt-bar span.active { background: rgba(79, 209, 197, 0.9); }
</style>
