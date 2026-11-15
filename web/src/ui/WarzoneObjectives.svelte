<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { clientTexture } from "../play/window.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { flow, word }: { flow: AppFlow; word: (label: string, fallback: string) => string } = $props();
  const base = "UI/FactionWarfare/frontlinesDashboard/objectives/";
  const objectives = [
    { title: "propagandaBroadcastStructure", body: "propagandaBroadcastStructureDesc", fallback: "Propaganda Broadcast Structure", typeID: 73225 },
    { title: "listeningOutput", body: "listeningOutpostDesc", fallback: "Listening Outpost", typeID: 73270 },
    { title: "supplyDepot", body: "supplyDepotDesc", fallback: "Supply Depot" },
    { title: "supplyCache", body: "supplyCacheDesc", fallback: "Supply Cache" },
    { title: "rendezvouzPoint", body: "rendezvouzPointDesc", fallback: "Rendezvous Point" },
    { title: "operationCenters", body: "operationCentersDesc", fallback: "Operation Centers" },
    { title: "battlefieldComplexes", body: "battlefieldComplexesDesc", fallback: "Battlefield Complexes" },
  ] as const;
  $effect(() => flow.requestWords([base + "objectives", base + "advantageObjectivesDescription", ...objectives.flatMap(row => [base + row.title, base + row.body])]));
</script>

<section class="objectives">
  <h3 title={word(base + "advantageObjectivesDescription", "")}>{word(base + "objectives", "Objectives")}</h3>
  {#each objectives as objective (objective.title)}
    {@const name = word(base + objective.title, objective.fallback)}
    <article>
      {#if "typeID" in objective}<TypeIcon typeID={objective.typeID} {name} size="lg" />
      {:else}<img alt="" src={clientTexture("res:/UI/Texture/Shared/Brackets/beacon.png")} />{/if}
      <div><h4>{name}</h4><p>{word(base + objective.body, "")}</p></div>
    </article>
  {/each}
</section>

<style>
  .objectives { padding: 22px clamp(16px, 4vw, 55px); }
  article { display: flex; align-items: flex-start; gap: 13px; margin-bottom: 24px; }
  img { width: 16px; height: 16px; margin-top: 3px; }
  h3 { font-size: 18px; font-weight: 500; margin: 0 0 24px; }
  h4 { font-size: 15px; font-weight: 500; margin: 0 0 5px; }
  p { white-space: pre-line; line-height: 1.4; color: #b7bdc1; margin: 0; }
</style>
