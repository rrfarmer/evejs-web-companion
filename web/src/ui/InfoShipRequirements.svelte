<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { loadTypeListsHolding } from "../app/api.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { romanLevel } from "../bridge/skills.ts";
  import type { RequiredSkills } from "../bridge/missingSkills.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";

  let { store, flow, typeID, showEmpty = false }: { store: ClientStore; flow: AppFlow; typeID: number; showEmpty?: boolean } = $props();
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const REQUIREMENTS = "UI/InfoWindow/TabNames/Requirements";
  const NO_ACADEMY_SKILLS = "UI/AcademyShips/NoSkillsRequired";
  let read = $state<{ required: RequiredSkills; academy: boolean } | null>(null);
  $effect(() => {
    const id = typeID;
    let current = true;
    read = null;
    void (async () => {
      const facts = await flow.skillPlanTypeFacts([id]);
      if (facts?.categoryID.get(id) !== 6 || !current) return;
      const skills = (facts.required[id] ?? []).length;
      const lists = skills === 0 ? await loadTypeListsHolding([id], [992], flow.requestOptions()) : {};
      if (!current) return;
      flow.requestWords([REQUIREMENTS, NO_ACADEMY_SKILLS]);
      const skillIDs = [...new Set(Object.values(facts.required).flatMap(branch => branch.map(([skillID]) => skillID)))];
      flow.requestNames(skillIDs.map(skillID => ({ kind: "type", id: skillID })));
      read = { required: facts.required, academy: lists[id]?.includes(992) === true };
    })().catch(() => {});
    return () => { current = false; };
  });
</script>

{#snippet rows(required: RequiredSkills, parent: number, seen: ReadonlySet<number>)}
  <ul class="requirements">
    {#each required[parent] ?? [] as [skillID, level] (skillID)}
      {#if !seen.has(skillID)}
        <li>
          <button type="button" class="evelink showInfo" onclick={() => showInfo({ kind: "type", typeID: skillID })}>
            {resolvedName($names.resolved, "type", skillID, "Skill")} {romanLevel(level)}
          </button>
          {#if required[skillID]?.length}
            {@render rows(required, skillID, new Set([...seen, skillID]))}
          {/if}
        </li>
      {/if}
    {/each}
  </ul>
{/snippet}

{#if read?.academy || (read?.required[typeID]?.length ?? 0) > 0}
  <h3>{plainText($words.templates[REQUIREMENTS] ?? "") || "Requirements"}</h3>
  {#if read?.academy}
    <p class="note">{plainText($words.templates[NO_ACADEMY_SKILLS] ?? "") || "No skills required."}</p>
  {:else if read}
    {@render rows(read.required, typeID, new Set([typeID]))}
  {/if}
{:else if showEmpty}
  <p class="note">Nothing further is loaded about this item. Fit one to your ship to see its effective attributes.</p>
{/if}

<style>
  .requirements { list-style: none; padding-left: 12px; }
  .requirements li { padding: 3px 0 0; }
</style>
