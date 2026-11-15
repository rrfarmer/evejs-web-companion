<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { MILITIA_FACTIONS, WARZONE_FACTION_COLORS, type MilitiaFactionID } from "../bridge/militiaEnlistment.ts";
  import { clientTexture } from "../play/window.ts";
  import WarzoneStatisticsTable from "./WarzoneStatisticsTable.svelte";
  import { showInfo } from "./showInfo.ts";

  let { flow, faction, rank, standing, pilot, word }: {
    flow: AppFlow; faction: MilitiaFactionID; rank: number | null; standing: number; pilot: string;
    word: (label: string, fallback: string) => string;
  } = $props();
  const FW = "UI/FactionWarfare/";
  const rankNumbers = Array.from({ length: 10 }, (_, i) => i);
  const prefix = $derived(MILITIA_FACTIONS[faction].banner);
  const name = (n: number) => word(`${FW}Ranks/Rank${prefix}${n}`, `${n}`);
  const description = (n: number) => word(`${FW}Ranks/RankDescription${prefix}${n}`, "");
  const image = (n: number) => clientTexture(`res:/UI/Texture/Medals/Ranks/${faction}_${n}.png`);
  const background = $derived(clientTexture(`res:/UI/Texture/classes/frontlines/progression/${MILITIA_FACTIONS[faction].logo}_color_bg.png`));
  $effect(() => flow.requestWords(rankNumbers.flatMap(n => [`${FW}Ranks/Rank${prefix}${n}`, `${FW}Ranks/RankDescription${prefix}${n}`])));

  function viewRank(n: number) {
    showInfo({ kind: "rank", factionID: faction, rank: n, name: name(n), description: description(n) });
  }
</script>

<section class="progression" style:--faction={WARZONE_FACTION_COLORS[faction]}>
  {#if rank !== null}
    <div class="current-rank" style:background-image={`url("${background}")`}>
      <img alt="" src={image(rank)} />
      <div><h3>{name(rank)}</h3><p>{description(rank)}</p></div>
    </div>
    <div class="ranks" aria-label="Militia ranks">
      {#each rankNumbers as n (n)}
        {@const filled = Math.max(0, Math.min(1, standing - (n - 1)))}
        <button type="button" title={name(n)} aria-label={name(n)} aria-current={rank === n ? "true" : undefined} onclick={() => viewRank(n)}>
          <span class="standing" style:background={`conic-gradient(var(--faction) ${filled}turn, #485157 0turn)`}></span>
          <img alt="" src={image(n)} />
        </button>
      {/each}
    </div>
  {/if}
  <WarzoneStatisticsTable {flow} scope="personal" {pilot} {word} />
</section>

<style>
  .progression { padding: 14px 18px; }
  .current-rank { display: flex; align-items: center; gap: 15px; margin: 0 -18px 12px; min-height: 130px; padding: 9px 12px; background-position: center; background-size: cover; }
  .current-rank img { width: 110px; }
  h3 { margin: 0; font-size: 19px; }
  p { line-height: 1.4; }
  .ranks { display: grid; grid-template-columns: repeat(10, minmax(28px, 1fr)); margin-bottom: 17px; overflow-x: auto; }
  button { display: grid; justify-items: center; gap: 4px; min-width: 0; padding: 3px 0; background: transparent; border: 1px solid transparent; cursor: pointer; }
  button[aria-current], button:hover { border-color: var(--faction); }
  button img { width: min(100%, 42px); }
  .standing { display: block; border-radius: 50%; width: 12px; height: 12px; border: 2px solid #0b0f14; }
</style>
