<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { AgencySeasonReward } from "../bridge/agencySeason.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { isSkillPointRedeem } from "../bridge/redeem.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { store, flow, reward, onclose }: {
    store: ClientStore; flow: AppFlow; reward: AgencySeasonReward; onclose: () => void;
  } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const art = (file: string) => clientTexture("res:/UI/Texture/classes/LoginCampaign/" + file + ".png");
  const itemHint = "UI/LoginRewards/ItemToRedeemHint";
  const skillHint = "UI/Seasons/ChallengeRewardSkillPointClaim";
  const hintKey = $derived(isSkillPointRedeem(reward.typeID) ? skillHint : itemHint);
  const name = $derived(resolvedName($names.resolved, "type", reward.typeID, "Seasonal reward"));
  let panel: HTMLDivElement;
  let closing = $state(false);
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;

  function close() {
    if (closing) return;
    closing = true;
    fadeTimer = setTimeout(onclose, 250);
  }

  function keydown(event: KeyboardEvent) {
    if (event.key !== "Escape" && event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  onMount(() => {
    flow.requestWords([itemHint, skillHint]);
    const previous = document.activeElement;
    panel.focus();
    const timer = setTimeout(close, 4000);
    return () => {
      clearTimeout(timer);
      clearTimeout(fadeTimer);
      if (previous instanceof HTMLElement && previous.isConnected && document.activeElement === document.body) previous.focus();
    };
  });
</script>

<svelte:window onmouseup={close} />

<div class="fanfare" class:closing bind:this={panel} role="dialog" aria-modal="true" aria-label={name}
  tabindex="-1" onkeydown={keydown}>
  <div class="reward-item" class:omega={reward.omegaOnly}>
    <img class="frame" src={art(reward.omegaOnly ? "omegaMilestone_frame" : "alphaMilestone_frame")} alt="" />
    <img class="frame" src={art("centerHexagon")} alt="" />
    <img class="frame" src={art("centerCircle")} alt="" />
    <div class="icon"><TypeIcon typeID={reward.typeID} name={name} size="lg" /></div>
    {#if reward.quantity > 1}<span class="quantity">{reward.quantity.toLocaleString()}</span>{/if}
    <span class="item-name">{name}</span>
  </div>
  <p>{plainText($words.templates[hintKey] ?? "") || (hintKey === skillHint
    ? "Automatically applied to character."
    : "Items moved to the Redeem Items window.")}</p>
</div>

<style>
  .fanfare { position: absolute; inset: 0; display: grid; place-items: center; overflow: hidden; z-index: 6; isolation: isolate;
    background: radial-gradient(ellipse at center, rgb(34 69 87 / 92%), rgb(13 13 13 / 88%) 65%); color: rgb(255 255 255 / 85%); opacity: 1; transition: opacity 250ms ease; }
  .fanfare:focus { outline: 0; }
  .fanfare.closing { opacity: 0; }
  .reward-item { width: 160px; height: 200px; box-sizing: border-box; position: relative; margin-top: -20px;
    border: 1px solid rgb(77 77 77); background: rgb(13 13 13 / 65%); text-align: center; }
  .reward-item.omega { border-color: rgb(125 89 31); }
  .frame, .icon { position: absolute; top: calc(50% - 15px); left: 50%; transform: translate(-50%, -50%); }
  .frame { width: 148px; height: 148px; }
  .icon :global(.type-icon) { width: 76px; height: 76px; }
  .quantity { position: absolute; right: 1px; bottom: 52px; padding: 3px 10px; min-width: 40px; background: rgb(0 0 0 / 95%); font-size: 14px; }
  .item-name { position: absolute; display: grid; place-items: center; bottom: 0; left: 7px; right: 7px; height: 50px; font-weight: 700; }
  p { position: absolute; top: calc(50% + 118px); margin: 0 10px; text-align: center; font-size: 12px; }
</style>
