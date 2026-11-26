<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { store, flow, rank, milestone, crates, onRedeem }: {
    store: ClientStore;
    flow: AppFlow;
    rank: number;
    milestone: number | null;
    crates: readonly number[];
    onRedeem: () => void;
  } = $props();

  // 3698585 COVID tiers. Use the grant service's female/male order for the rank-125 coat.
  const tiers: readonly (readonly [number, number, number?])[] = [
    [5, 54714, 54830], [10, 54949, 54948], [25, 54944, 54943],
    [50, 45486], [75, 55295], [100, 40458, 40462], [125, 40460, 40464],
    [150, 45487], [175, 55296], [200, 55627, 55636], [250, 54965, 54966],
    [350, 54927, 54926], [500, 45528], [650, 55294],
  ];
  const upcomingLabel = "UI/ProjectDiscovery/Covid/Rewards/UpcomingRewards";
  const redeemLabel = "UI/RedeemWindow/RedeemItem";
  const names = $derived(store.names);
  const words = $derived(store.words);
  const characters = $derived(store.character);
  const station = $derived(store.station);
  const gender = $derived($characters.characters.find(character => character.characterID === $station.online?.characterID)?.gender);
  const crateType = $derived(rank < 25 ? 55358 : 55359);
  const crateTypes = $derived(crates.length ? [...new Set(crates)] : [crateType]);
  const previews = $derived(tiers.map(([level, female, male]) => ({
    level, typeID: male === undefined || gender === 0 ? female : gender === 1 ? male : null,
  })));
  const currentMilestone = $derived(milestone === null
    ? previews.filter(reward => reward.level <= rank).at(-1)
    : previews.find(reward => reward.level === milestone));
  let track = $state<HTMLDivElement>();

  const typeName = (id: number) => resolvedName($names.resolved, "type", id, "Reward item");
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? "") || fallback;

  $effect(() => {
    flow.requestNames([...crateTypes, ...previews.flatMap(row => row.typeID === null ? [] : [row.typeID])]
      .map(id => ({ kind: "type", id })));
    flow.requestWords([upcomingLabel, redeemLabel]);
  });

  $effect(() => {
    const next = previews.find(row => row.level > rank) ?? previews.at(-1);
    const button = next && track?.querySelector<HTMLElement>(`[data-reward-rank="${next.level}"]`);
    if (track && button) track.scrollLeft = button.offsetLeft;
  });
</script>

{#snippet item(typeID: number)}
  <button class="featured-item" type="button" data-reward-type={typeID}
    onclick={() => showInfo({ kind: "type", typeID })}>
    <TypeIcon {typeID} name={typeName(typeID)} size="lg" />
    <span>{typeName(typeID)}</span>
  </button>
{/snippet}

<div class="reward-catalog">
  <div class="reward-items">
    {#each crateTypes as typeID (typeID)}
      {@render item(typeID)}
    {/each}
    {#if currentMilestone?.typeID != null}
      {@render item(currentMilestone.typeID)}
    {/if}
    {#if crates.length || currentMilestone}
      <button class="redeem-link" type="button" onclick={onRedeem}>{word(redeemLabel, "Redeem Items")}</button>
    {/if}
  </div>

  <h3>{word(upcomingLabel, "Upcoming rewards")}</h3>
  <div class="reward-track" bind:this={track}>
    {#each previews as reward (reward.level)}
      {@const unlocked = reward.level <= rank}
      <button class="reward-preview" class:unlocked type="button" data-reward-rank={reward.level}
        data-reward-type={reward.typeID} disabled={reward.typeID === null}
        onclick={() => { if (reward.typeID !== null) showInfo({ kind: "type", typeID: reward.typeID }); }}>
        {#if reward.typeID !== null}
          <TypeIcon typeID={reward.typeID} name={typeName(reward.typeID)} size="lg" />
          <span>{typeName(reward.typeID)}</span>
        {/if}
        <strong>Rank {reward.level.toLocaleString()}</strong>
        {#if unlocked}<small>✓ Unlocked</small>{/if}
      </button>
    {/each}
  </div>
</div>

<style>
  .reward-catalog { display: grid; gap: 10px; min-width: 0; width: 100%; }
  .reward-items { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .featured-item { display: flex; align-items: center; gap: 8px; text-align: left; }
  .redeem-link { align-self: center; }
  h3 { margin: 4px 0 0; font-size: 1rem; }
  .reward-track { position: relative; display: flex; align-items: stretch; gap: 8px; overflow-x: auto; padding-bottom: 8px; }
  .reward-preview { display: grid; align-content: start; justify-items: center; gap: 6px; flex: 0 0 128px; padding: 10px 8px; white-space: normal; }
  .reward-preview.unlocked { border-color: #519eb2; }
  small { color: #83d0dd; }
</style>
