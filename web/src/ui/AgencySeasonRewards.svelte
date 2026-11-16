<script lang="ts">
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { seasonRewardClaimable, type AgencySeasonReward } from "../bridge/agencySeason.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { showInfo } from "./showInfo.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { store, rewards, points, target, vanguard, busy, onclaim }: {
    store: ClientStore; rewards: readonly AgencySeasonReward[]; points: number; target: number | null;
    vanguard: boolean; busy: boolean; onclaim: (index: number) => void;
  } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const prefix = "res:/UI/Texture/classes/Seasons/Agency/ContentCard/";
  const pointsIcon = clientTexture("res:/UI/Texture/classes/Seasons/eventIcon_64x64.png");
  const art = (name: string) => clientTexture(prefix + name + ".png");
  const nameOf = (typeID: number) => resolvedName($names.resolved, "type", typeID, "");
  const word = (key: string, fallback: string, args: Record<string, number> = {}) =>
    plainText(formatTemplate($words.templates[key] ?? "", args, { nameOf: (_, id) => nameOf(id) })) || fallback;
  const omega = $derived($station.cloneGrade !== 0);
  const limit = $derived(Math.max(1, target ?? 0, ...rewards.map(reward => reward.points)));
  const minimumGap = $derived(rewards.reduce((gap, reward, index) => {
    const previous = rewards[index - 1]?.points ?? 0, difference = reward.points - previous;
    return difference > 0 ? Math.min(gap, difference) : gap;
  }, limit));
  // Fit the relative native positions in a scroll area when many milestones share a short stretch.
  const trackWidth = $derived(Math.min(4200, Math.ceil(limit * 50 / minimumGap) + 50));

  function openReward(reward: AgencySeasonReward) {
    if (seasonRewardClaimable(reward, points, omega)) onclaim(reward.index);
    else showInfo({ kind: "type", typeID: reward.typeID });
  }
</script>

<div class="rewards" class:vanguard>
  <div class="earned">
    <img src={pointsIcon} alt="" />
    <strong>{points.toLocaleString()}</strong>
    <span>{vanguard
      ? word("UI/Agency/Seasons/VanguardNemesis/PersonalPointsEarned", "Personal Points Earned")
      : word("UI/Agency/Seasons/PointsEarned", "Points Earned")}</span>
  </div>
  <div class="scroll">
    <div class="track" style:min-width={`${trackWidth}px`}>
      <div class="rail">
        <progress aria-label="Seasonal progress" max={limit} value={points}></progress>
        {#each rewards as reward (reward.index)}
          {@const achieved = points >= reward.points}
          {@const ready = seasonRewardClaimable(reward, points, omega)}
          {@const name = nameOf(reward.typeID)}
          {@const description = word("UI/Seasons/RewardDescription", `${reward.quantity.toLocaleString()} × ${name || "Reward"}`, { quantity: reward.quantity, typeID: reward.typeID })}
          {@const state = reward.claimed ? "Claimed" : ready ? word("UI/Seasons/ClickToClaim", "Click to claim") : !achieved
            ? word("UI/Seasons/PointsToUnlock", `${reward.points.toLocaleString()} points to unlock`, { points: reward.points })
            : word("UI/Seasons/OmegaOnlyReward", "Omega only")}
          {@const clone = reward.omegaOnly ? "omega" : "alpha"}
          <div class="goal" class:achieved class:ready class:claimed={reward.claimed} class:omega-only={reward.omegaOnly}
            style:left={`${Math.min(0.9999, reward.points / limit) * 100}%`}>
            <button type="button" data-own-sound aria-label={ready ? `Claim ${name || description}` : `${name || description}, ${state}`}
              title={`${description}\n${state}`} disabled={busy} onclick={() => openReward(reward)}
              style:--reward-frame={`url('${art(ready ? clone + "_ClaimRewardContainer" : clone + "RewardContainer")}')`}
              style:--reward-backdrop={`url('${art(ready ? "rewardClaimContainerBG" : "rewardContainerBG")}')`}>
              <TypeIcon typeID={reward.typeID} name={name || "Reward"} size="md" />
              {#if reward.quantity > 1}<small>{reward.quantity.toLocaleString()}</small>{/if}
              {#if reward.claimed}<img class="claimed-check" alt="" src={art("checkmark_claimReward")} />{/if}
              {#if reward.omegaOnly && !omega}<img class="omega-mark" alt="" src={art("omegaIcon")} />{/if}
              {#if ready}<img class="claim-arrow" alt="" src={art("rewardClaimButton")} />{/if}
            </button>
            <span>{reward.points.toLocaleString()}</span>
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .rewards { min-height: 114px; display: flex; background: rgb(0 0 0 / 50%); }
  .earned { flex: 0 0 170px; padding: 16px 8px 12px 12px; display: grid; grid-template-columns: 48px 1fr;
    justify-items: start; align-items: center; align-content: center; }
  .earned img { width: 48px; }
  .earned strong { font-size: 24px; }
  .earned span { grid-column: 1 / -1; color: rgb(255 255 255 / 55%); margin-left: 8px; }
  .vanguard { display: block; }
  .vanguard .earned { height: 84px; box-sizing: border-box; padding-top: 4px; grid-template-rows: auto 48px; }
  .vanguard .earned span { grid-row: 1; margin-left: 0; font-size: 16px; font-weight: 700; }
  .vanguard .earned strong { font-size: 29px; }
  .scroll { flex: 1; min-width: 0; overflow-x: auto; }
  .track { height: 114px; padding: 12px 25px 0; box-sizing: border-box; }
  .rail { position: relative; height: 100%; }
  progress { display: block; position: absolute; left: 0; right: 0; bottom: 25px; width: 100%; height: 12px; appearance: none; border: 0; }
  progress::-webkit-progress-bar { background: #6e6e6e; }
  progress::-webkit-progress-value { background: #42a12d; }
  progress::-moz-progress-bar { background: #42a12d; }
  .goal { position: absolute; bottom: 0; width: 40px; height: 92px; transform: translateX(-50%); text-align: center; }
  .goal::before { content: ""; position: absolute; width: 2px; height: 12px; bottom: 25px; background: #070908; left: calc(50% - 1px); }
  .goal span { position: absolute; bottom: 4px; left: 0; right: 0; color: #9b9b9b; font-size: 11px; }
  .goal.achieved span { color: #61ad50; }
  .goal.achieved.omega-only span { color: #fcc207; }
  .goal button { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); width: 36px; height: 40px;
    display: grid; place-items: center; padding: 0 0 4px; border: 0; background: transparent; isolation: isolate; color: #fff; cursor: pointer; }
  .goal button::before, .goal button::after { content: ""; position: absolute; inset: 0; pointer-events: none; }
  .goal button::before { z-index: -2; background: #000; mask: var(--reward-backdrop) center / 100% 100% no-repeat; }
  .goal button::after { z-index: -1; background: var(--reward-frame) center / 100% 100% no-repeat; opacity: 0.6; }
  .goal.omega-only button::after { opacity: 1; }
  .goal.ready button { top: -20px; width: 50px; height: 68px; align-items: start; padding-top: 2px; }
  .goal button:hover, .goal button:focus-visible { outline: 1px solid #9bd0e4; }
  .goal button:disabled { cursor: default; }
  .goal button :global(.type-icon) { width: 28px; height: 28px; }
  .goal.ready button :global(.type-icon) { width: 40px; height: 40px; }
  .goal.claimed button :global(.type-icon) { opacity: 0.5; }
  .claimed-check, .omega-mark, .claim-arrow { position: absolute; left: 50%; transform: translateX(-50%); }
  .claimed-check { width: 36px; }
  .omega-mark { width: 18px; }
  .claim-arrow { width: 48px; height: 20px; padding: 4px 18px; bottom: 5px; object-fit: contain; background: #36732e; box-sizing: border-box; }
  small { position: absolute; right: 0; bottom: 3px; padding: 0 2px; font-size: 9px; background: rgb(0 0 0 / 75%); }
  .ready small { bottom: 27px; }
  @media (max-width: 680px) { .earned { flex-basis: 105px; } }
</style>
