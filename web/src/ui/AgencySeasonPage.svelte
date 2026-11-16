<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { seasonPageKind, type AgencySeason, type AgencySeasonReward, type decodeAgencySeasonProgress } from "../bridge/agencySeason.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { shortWrittenInterval, SHORT_INTERVAL_WORD_LABELS } from "../bridge/timeInterval.ts";
  import { resolvedName } from "../store/names.ts";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";
  import LabelText from "./LabelText.svelte";
  import TypeIcon from "./TypeIcon.svelte";
  import AgencySeasonRewards from "./AgencySeasonRewards.svelte";
  import AgencyVanguardActivity from "./AgencyVanguardActivity.svelte";
  import { clientTexture } from "./skillGroupIcons.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { playUiEvent } from "../play/uiAudio.ts";

  let { store, flow, season, onfanfare, onShowConvoys }: {
    store: ClientStore; flow: AppFlow; season: AgencySeason; onfanfare: (reward: AgencySeasonReward) => void;
    onShowConvoys?: () => void;
  } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const changed = flow.agencySeasonProgressChanged;
  const pointsIcon = clientTexture("res:/UI/Texture/classes/Seasons/eventIcon_64x64.png");
  const nameOf = (kind: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, kind, id, "");
  const markup = (key: string | number | null) => $words.templates[typeof key === "number" ? `#${key}` : key ?? ""] ?? "";
  const label = (key: string | number | null, fallback = "", args: Record<string, number> = {}) =>
    plainText(formatTemplate(markup(key), args, { nameOf })) || fallback;
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, key => label(key, LINK_WORDS[key]), text);
  const variant = $derived(seasonPageKind(season.templateID));
  let progress = $state<ReturnType<typeof decodeAgencySeasonProgress>>(null), unread = $state(true);
  let busy = $state(false), failure = $state("");
  let now = $state(Date.now());

  $effect(() => flow.requestWords([
    "UI/Agency/Seasons/VanguardNemesis/PersonalPointsEarned", "UI/Agency/Seasons/PointsEarned", "UI/Agency/Seasons/ChallengesSectionHeader",
    "UI/Agency/Seasons/PointRewardTooltip", "UI/Agency/Seasons/IskRewardToolTip",
    "UI/Seasons/PointsToUnlock", "UI/Seasons/RewardDescription", "UI/Seasons/ClickToClaim", "UI/Seasons/ClaimReward", "UI/Seasons/OmegaOnlyReward",
    ...SHORT_INTERVAL_WORD_LABELS, ...Object.keys(LINK_WORDS),
  ]));
  $effect(() => {
    const id = season.seasonID;
    void $changed;
    let current = true;
    void flow.agencySeasonProgress().then(row => {
      if (current) progress = row?.seasonID === id ? row : null;
    }, () => { if (current) progress = null; }).finally(() => { if (current) unread = false; });
    return () => { current = false; };
  });
  $effect(() => {
    if (!progress?.challenges.some(challenge => challenge.expiresMs !== null && !challenge.claimable)) return;
    now = Date.now();
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });

  async function claim(kind: "goal" | "challenge", id: number) {
    const seasonID = season.seasonID;
    if (busy || seasonID === null) return;
    busy = true;
    failure = "";
    try {
      const latest = await flow.claimAgencySeasonReward(seasonID, kind, id);
      if (season.seasonID === seasonID) {
        progress = latest;
        if (kind === "challenge") void playUiEvent("general_reward_play");
        else {
          const reward = latest.rewards.find(goal => goal.index === id && goal.claimed);
          if (reward) onfanfare(reward);
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : "The reward could not be claimed.";
    } finally { busy = false; }
  }
</script>

<section class="season" aria-label={label(season.titleID, "Season")}>
  {#if progress || variant === "vanguard"}
    <div class:vanguard={variant === "vanguard"} class="tracks">
      {#if progress}
        <AgencySeasonRewards {store} points={progress.points} target={progress.target} rewards={progress.rewards}
          vanguard={variant === "vanguard"} {busy} onclaim={(index) => claim("goal", index)} />
      {/if}
      {#if variant === "vanguard"}<AgencyVanguardActivity {store} {flow} onShowMap={onShowConvoys} />{/if}
    </div>
  {/if}
  {#if failure}<p role="alert">{failure}</p>{/if}
  <div class="season-body">
    <section class="challenges">
      {#if progress}
      <h2>{label("UI/Agency/Seasons/ChallengesSectionHeader", "Challenges", { count: progress.challenges.length })}</h2>
      {#each progress.challenges as task (task.id)}
        <article>
          <div class="task">
            <h3>{label(task.name)}</h3>
            <LabelText markup={markup(task.detail)} {followerOf} />
            {#if task.expiresMs !== null && !task.claimable}
              <small>{shortWrittenInterval(BigInt(Math.max(0, task.expiresMs - now)) * 10000n, $words.templates) ?? ""}</small>
            {/if}
            {#if task.claimable}
              <button class="claim" type="button" disabled={busy} onclick={() => claim("challenge", task.id)}>{label("UI/Seasons/ClaimReward", "Claim Reward")}</button>
            {/if}
            {#if task.target > 0}<div class="task-progress">
              <progress aria-label="Challenge progress" max={task.target} value={task.current}></progress>
              <small>{task.current.toLocaleString()} / {task.target.toLocaleString()}</small>
            </div>{/if}
          </div>
          <div class="payouts">
            {#if task.typeID && task.quantity > 0}
              <div title={nameOf("type", task.typeID)}><div class="tile"><TypeIcon typeID={task.typeID} name={nameOf("type", task.typeID)} size="md" /></div>
                <small>×{task.quantity.toLocaleString()}</small></div>
            {/if}
            {#if task.isk > 0}
              <div title={label("UI/Agency/Seasons/IskRewardToolTip", `${task.isk.toLocaleString()} ISK`, { amount: task.isk })}>
                <div class="tile"><img alt="ISK" src={clientTexture("res:/ui/Texture/WindowIcons/wallet.png")} /></div><small>{task.isk.toLocaleString()}</small></div>
            {/if}
            {#if task.points > 0}
              <div title={label("UI/Agency/Seasons/PointRewardTooltip", `${task.points} points`, { points: task.points })}>
                <div class="tile"><img alt="Points" src={pointsIcon} /></div><small>{task.points.toLocaleString()}</small></div>
            {/if}
          </div>
        </article>
      {/each}
      {:else}<p role="status">{unread ? "Loading seasonal progress…" : "Seasonal progress unavailable."}</p>{/if}
    </section>
    <aside class="season-info">
      {#if season.banner}<img class="banner" alt="" src={clientTexture(season.banner)} />{/if}
      <h2>{label(season.titleID)}</h2>
      {#if season.endMs}<time datetime={new Date(season.endMs).toISOString()}>Ends {new Date(season.endMs).toLocaleString("en-GB", { timeZone: "UTC" })} EVE</time>{/if}
      <LabelText markup={markup(season.newsID)} {followerOf} />
    </aside>
  </div>
</section>

<style>
  .tracks.vanguard { display: grid; grid-template-columns: minmax(0, 1fr) minmax(245px, 35%); gap: clamp(12px, 4vw, 64px); min-height: 198px; padding-right: 12px; }
  .season-body { display: grid; grid-template-columns: minmax(0,1fr) minmax(235px,35%); gap: 12px; padding: 10px 12px 4px; }
  .challenges, .season-info { background: rgb(0 0 0 / 30%); border: 1px solid rgb(255 255 255 / 12%); min-width: 0; }
  h2 { margin: 0; padding: 8px; font-size: 16px; }
  .challenges { max-height: 378px; overflow: auto; }
  .challenges h2 { position: sticky; top: 0; z-index: 1; background: #161f26; }
  article { display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 8px; margin: 0 8px 4px; background: rgb(255 255 255 / 5%); }
  .task { flex: 1 1 230px; min-width: 0; }
  .task h3 { font-size: 13px; margin: 0 0 4px; }
  .claim { margin: 6px 0 0; padding: 3px 12px; color: #fff; border: 1px solid #70aa63; background: #285426; cursor: pointer; }
  .claim:hover:not(:disabled) { background: #36742e; }
  .task-progress { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .task-progress small { white-space: nowrap; }
  progress { height: 5px; flex: 1; min-width: 0; accent-color: #42a12d; }
  .payouts { display: flex; gap: 6px; text-align: center; }
  .tile { width: 48px; height: 48px; display: grid; place-items: center; margin: auto; background: rgb(0 0 0 / 50%); border: 1px solid rgb(255 255 255 / 25%); }
  .tile img { width: 100%; }
  .payouts small { display: block; padding-top: 2px; }
  .season-info { padding: 8px; }
  .season-info h2 { padding: 6px 0 2px; }
  .banner { display: block; width: 100%; max-height: 200px; object-fit: cover; }
  time { display: block; margin-bottom: 6px; color: rgb(255 255 255 / 70%); }
  [role="alert"], [role="status"] { padding: 6px 10px; }
  @media (max-width: 750px) { .season-body, .tracks.vanguard { grid-template-columns: minmax(0, 1fr); } }
</style>
