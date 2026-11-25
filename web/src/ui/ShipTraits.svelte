<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import type { ShipTraitBonus, ShipTraits } from "../bridge/hullBrowser.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import LabelText from "./LabelText.svelte";
  import { LINK_WORDS, linkFollowerOf } from "./linkFollowers.ts";

  let { store, flow, traits, unitNameIDs }: {
    store: ClientStore;
    flow: AppFlow;
    traits: ShipTraits;
    unitNameIDs: ReadonlyMap<number, number | null>;
  } = $props();
  const names = $derived(store.names);
  const words = $derived(store.words);
  const SKILL_BONUS = "UI/ShipTree/SkillNameCaption";
  const ROLE_BONUS = "UI/ShipTree/RoleBonus";
  const MISC_BONUS = "UI/ShipTree/MiscBonus";
  const NUMBERED = "UI/InfoWindow/TraitWithNumber";
  const UNNUMBERED = "UI/InfoWindow/TraitWithoutNumber";
  $effect(() => flow.requestWords([SKILL_BONUS, ROLE_BONUS, MISC_BONUS, NUMBERED, UNNUMBERED, ...Object.keys(LINK_WORDS)]));

  function markup(label: string, fallback: string, args: TemplateArguments = {}): string {
    return formatTemplate($words.templates[label] || fallback, args, {
      nameOf: (kind, id) => resolvedName($names.resolved, kind, id, ""),
    });
  }
  const word = (label: string, fallback: string, args?: TemplateArguments) => plainText(markup(label, fallback, args));
  const message = (id: number | null | undefined) => id ? ($words.templates[`#${id}`] ?? "") : "";
  const followerOf = (url: string, text: string) =>
    linkFollowerOf(url, flow, null, label => word(label, LINK_WORDS[label]), text, link => { void flow.followInventoryFilterLink(link); });

  function bonusLine(bonus: ShipTraitBonus): string {
    const bonusText = message(bonus.nameID);
    if (bonus.bonus === null) return markup(UNNUMBERED, "{bonusText}", { color: "dce6ec", bonusText });
    const amount = Math.sign(bonus.bonus) * Math.round(Math.abs(bonus.bonus) * 10) / 10;
    const value = Number.isInteger(amount) ? { type: "long", value: String(amount) } as const : amount;
    const unit = bonus.unitID === null ? "" : plainText(message(unitNameIDs.get(bonus.unitID)));
    return markup(NUMBERED, "{value}{unit} {bonusText}", { color: "dce6ec", value, unit, bonusText });
  }
</script>

{#snippet bonuses(caption: string, entries: readonly ShipTraitBonus[])}
  {#if entries.length}
    <section class="ship-trait">
      <h3>{caption}</h3>
      {#each [...entries].sort((a, b) => a.importance - b.importance) as bonus, index (index)}
        {@const [amount, description] = bonusLine(bonus).split("<t>", 2)}
        {#if description === undefined}
          <div class="bonus-text"><LabelText markup={amount ?? ""} {followerOf} /></div>
        {:else}
          <div class="bonus">
            <div class="bonus-amount"><LabelText markup={amount?.replace(/<\/?right>/g, "") ?? ""} /></div>
            <div class="bonus-text"><LabelText markup={description} {followerOf} /></div>
          </div>
        {/if}
      {/each}
    </section>
  {/if}
{/snippet}

<div class="ship-traits">
  {#each [...traits.skills].sort((a, b) => a.skillTypeID - b.skillTypeID) as skill (skill.skillTypeID)}
    {@const skillName = resolvedName($names.resolved, "type", skill.skillTypeID, "")}
    {@render bonuses(word(SKILL_BONUS, "{skillName} bonuses", { skillName }), skill.bonuses)}
  {/each}
  {@render bonuses(word(ROLE_BONUS, "Role Bonus"), traits.role)}
  {@render bonuses(word(MISC_BONUS, "Other Bonuses"), traits.misc)}
</div>

<style>
  .ship-trait { padding: 5px 0; }
  .ship-trait h3 { margin: 0 0 4px; font-size: 13px; color: #e2efff; }
  .bonus { display: grid; grid-template-columns: minmax(40px, max-content) minmax(0, 1fr); gap: 4px; margin: 3px 0; }
  .bonus-amount { text-align: right; }
</style>
