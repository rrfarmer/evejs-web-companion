<script lang="ts">
  import { commodityName, type PiRecipeBook, type PiSchematic } from "../bridge/piRecipes.ts";
  import { processorSchematics, schematicBuffer, schematicObsoletesRoute } from "../bridge/planetSchematics.ts";
  import { formatDuration } from "../bridge/planets.ts";
  import type { Colony, ColonyPin } from "../store/types.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { pin, colony, recipes, disabled, install, close }: {
    pin: ColonyPin; colony: Colony; recipes: PiRecipeBook; disabled: boolean;
    install: (recipe: PiSchematic) => void; close: () => void;
  } = $props();

  let chosen = $state<number | null>(null);
  const choices = $derived(processorSchematics(pin, recipes));
  const recipe = $derived(choices.find(item => item.schematicID === (chosen ?? pin.schematicID)));
  const obsolete = $derived(recipe ? colony.routes.filter(route => schematicObsoletesRoute(pin.pinID, recipe, route)) : []);
  const buffer = $derived(recipe ? schematicBuffer(pin, recipe) : null);
  const product = (item: PiSchematic["output"]) => item.typeName ?? commodityName(recipes, item.typeID) ?? "Commodity";

  function begin(item: PiSchematic): void {
    if (!disabled) install(item);
  }
</script>

<section class="processor-schematics" aria-label="Processor Schematics">
  <header>
    <strong>Schematics</strong>
    <button type="button" aria-label="Close schematics panel" onclick={close}>×</button>
  </header>
  {#if !recipes.readable}
    <p role="status">Schematic data is unavailable.</p>
  {:else if !choices.length}
    <p role="status">No schematics for this processor.</p>
  {:else}
    <div class="choices" aria-label="Compatible schematics">
      {#each choices as item (item.schematicID)}
        {@const tier = recipes.commodities.get(item.output.typeID)?.tier}
        <button type="button" class="schematic-choice" aria-pressed={recipe?.schematicID === item.schematicID}
          data-schematic-id={item.schematicID} disabled={disabled}
          onclick={() => { chosen = item.schematicID; }} ondblclick={() => begin(item)}>
          <TypeIcon typeID={item.output.typeID} name={product(item.output)} />
          <span>{product(item.output)}{#if tier != null} <small>P{tier}</small>{/if}</span>
        </button>
      {/each}
    </div>
    {#if recipe}
      <dl>
        {#if recipe.cycleTimeSeconds}
          <div><dt>Cycle time</dt><dd>{formatDuration(recipe.cycleTimeSeconds * 1000)}</dd></div>
        {/if}
        <div><dt>Output per cycle</dt><dd>{recipe.output.quantity.toLocaleString()} {product(recipe.output)}</dd></div>
        {#if recipe.cycleTimeSeconds}
          <div><dt>Output per hour</dt><dd>{(recipe.output.quantity * 3600 / recipe.cycleTimeSeconds).toLocaleString(undefined, { maximumFractionDigits: 1 })} {product(recipe.output)}</dd></div>
        {/if}
        {#each recipe.inputs as input (input.typeID)}
          <div><dt>{product(input)}</dt><dd>{input.quantity.toLocaleString()} per cycle</dd></div>
        {/each}
      </dl>
      {#if obsolete.length}
        <p>Removes {obsolete.length} incompatible {obsolete.length === 1 ? "route" : "routes"}.</p>
      {/if}
      {#each buffer?.discarded ?? [] as item (item.typeID)}
        <p>Discards {item.quantity.toLocaleString()} {item.typeName ?? "units"} from the input buffer.</p>
      {/each}
      {#if pin.active}<p>Stops the current production cycle.</p>{/if}
    {/if}
    <button type="button" disabled={disabled || !recipe} onclick={() => { if (recipe) begin(recipe); }}>Install Schematic</button>
  {/if}
</section>

<style>
  .processor-schematics { display: grid; gap: 8px; padding: 9px; border: 1px solid #819fad44; }
  header { display: flex; align-items: center; justify-content: space-between; }
  .choices { display: grid; max-height: min(208px, 31vh); overflow: auto; border: 1px solid #819fad44; }
  button { border: 1px solid #536673; background: #283643; color: inherit; font: inherit; padding: 5px 8px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .schematic-choice { display: flex; text-align: start; align-items: center; gap: 7px; background: transparent; border: 0; }
  .schematic-choice[aria-pressed="true"], .schematic-choice:hover { background: #334b58; }
  .schematic-choice small { color: #a1b7c4; }
  dl, p, dd { margin: 0; }
  dl { display: grid; gap: 4px; }
  dl div { display: flex; gap: 8px; justify-content: space-between; }
</style>
