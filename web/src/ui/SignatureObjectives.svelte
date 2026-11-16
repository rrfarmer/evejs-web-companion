<script lang="ts">
  import type { AppFlow, SignatureDungeonJob } from "../app/flow.ts";
  import { ObjectiveChain, type AbyssObjectiveRow } from "../bridge/abyssObjectives.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow, job }: { store: ClientStore; flow: AppFlow; job: SignatureDungeonJob } = $props();
  // svelte-ignore state_referenced_locally
  const { space, station, names, words } = store;
  const location = "UI/Generic/CurrentLocation";
  let chain = $state.raw<ObjectiveChain | null>(null);
  let rows = $state.raw<readonly AbyssObjectiveRow[]>([]);
  const chainID = $derived(job.data?.objectiveChainID ?? null);
  const pilotID = $derived($station.online?.characterID ?? null);

  $effect(() => {
    chain = null;
    rows = [];
    if (!chainID || !pilotID) return;
    let current = true;
    void flow.readObjectiveChain(chainID).then((data) => {
      if (!current || !data) return;
      const objectives = new ObjectiveChain(data, {}, pilotID);
      objectives.start([]);
      chain = objectives;
    });
    flow.startSpacePolling();
    return () => { current = false; flow.stopSpacePolling(); };
  });

  $effect(() => {
    const snapshot = $space.snapshot;
    if (!chain || snapshot?.solarSystemID !== job.solarSystemID) return;
    chain.observe(snapshot.entities);
    rows = chain.view().filter((objective) => objective.rows.length > 0);
  });

  $effect(() => {
    const labels = new Set([location]);
    const typeIDs = new Set<number>();
    for (const objective of rows) {
      if (objective.titleLabel) labels.add(objective.titleLabel);
      for (const row of objective.rows) {
        if (row.titleLabel) labels.add(row.titleLabel);
        if (row.typeID !== null) typeIDs.add(row.typeID);
      }
    }
    flow.requestWords([...labels]);
    flow.requestNames([...typeIDs].map((id) => ({ kind: "type", id })));
  });

  const nameOf = (kind: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, kind, id, "");
  const word = (label: string) => plainText(formatTemplate($words.templates[label] ?? "", {}, { nameOf }));
</script>

{#each rows as objective (objective.key)}
  <div class="signature-objective">
    {#if objective.titleLabel}<strong>{word(objective.titleLabel)}</strong>{/if}
    {#each objective.rows as row (row.key)}
      {@const name = row.titleLabel ? word(row.titleLabel) : row.typeID !== null ? nameOf("type", row.typeID) : ""}
      {#if row.itemID !== null}
        <span class="target" class:completed={row.completed}>
          {#if row.completed}<img alt="" src={clientTexture("res:/UI/Texture/eveicon/system_icons/checkmark_16px.png")} />{/if}
          {name}
        </span>
      {:else if name}
        <span>{name} {row.value}</span>
      {/if}
    {/each}
  </div>
{:else}
  <p>{word(location)}</p>
{/each}

<style>
  .signature-objective { display: grid; gap: 4px; padding: 6px 8px; background: rgb(0 0 0 / 0.25); font-size: 12px; }
  .target { display: flex; gap: 4px; align-items: center; }
  .target img { width: 16px; height: 16px; }
  .completed { color: #9fd689; }
  p { margin: 3px 0 5px; opacity: 0.8; font-size: 12px; }
</style>
