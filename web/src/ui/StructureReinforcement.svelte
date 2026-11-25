<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { filetimeToUnixMs } from "../bridge/activity.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { DEFAULT_REINFORCEMENT_HOUR, isFlexStructure } from "../bridge/structureBrowserFilters.ts";
  import type { StructureBrowserEntry } from "../bridge/structures.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow, rows, onDone, onClose }: {
    store: ClientStore; flow: AppFlow; rows: readonly StructureBrowserEntry[];
    onDone: () => void; onClose: () => void;
  } = $props();
  const words = $derived(store.words);
  const labels = {
    title: ["UI/StructureBrowser/SetReinforcementTime", "Set Reinforcement Time"],
    delay: ["UI/StructureBrowser/ReinforcementTimeChangeDelay", "Changes take 30 days to take effect."],
    hour: ["UI/Structures/Deployment/SetPrimeHour", "Reinforcement Hour"],
    flexHour: ["UI/Structures/Deployment/SetPrimeHourFLEX", "Reinforcement Hour"],
  } as const;
  const word = (label: keyof typeof labels) => plainText($words.templates[labels[label][0]] ?? labels[label][1]);
  const flex = $derived(rows.every(row => isFlexStructure(row.typeID)));
  const hours = Array.from({ length: 24 }, (_, index) => index);
  const time = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
  let hour = $state(DEFAULT_REINFORCEMENT_HOUR);
  let saving = $state(false);
  let error = $state("");
  let active = false;

  onMount(() => {
    active = true;
    flow.requestWords(Object.values(labels).map(([key]) => key));
    const counts = new Map<number, number>();
    for (const row of rows) {
      const current = row.owned?.reinforceHour;
      if (current != null) counts.set(current, (counts.get(current) ?? 0) + 1);
    }
    hour = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? DEFAULT_REINFORCEMENT_HOUR;
    return () => { active = false; };
  });

  async function apply(): Promise<void> {
    if (saving) return;
    saving = true;
    error = "";
    try {
      await flow.setStructureReinforcementHour(rows.map(row => row.structureID), hour);
      if (active) onDone();
    } catch (cause) {
      if (active) error = panelErrorWords(cause);
    } finally {
      if (active) saving = false;
    }
  }
</script>

<form class="structure-reinforcement" aria-label={word("title")} onsubmit={(event) => { event.preventDefault(); void apply(); }}>
  <h3>{word("title")}</h3>
  <p>{rows.length === 1 ? rows[0].itemName : `${rows.length} selected structures`}</p>
  <p>{word("delay")}</p>
  <label>{word(flex ? "flexHour" : "hour")}
    <select bind:value={hour} disabled={saving}>
      {#each hours as option (option)}<option value={option}>{time(option)}</option>{/each}
    </select>
  </label>
  {#each rows as row (row.structureID)}
    {#if row.owned?.nextReinforceHour != null}
      {@const effective = filetimeToUnixMs(row.owned.nextReinforceApply)}
      <p>{rows.length === 1 ? "" : row.itemName + " · "}Pending {time(row.owned.nextReinforceHour)}
        {#if effective !== null} · Takes effect {date.format(effective)} UTC{/if}
      </p>
    {/if}
  {/each}
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  <div class="controls">
    <button type="submit" disabled={saving}>Apply</button>
    <button type="button" disabled={saving} onclick={onClose}>Cancel</button>
  </div>
</form>

<style>
  form { display: grid; gap: 6px; padding: 8px; border: 1px solid var(--line, #444); }
  h3, p { margin: 0; }
  .controls { display: flex; gap: 6px; }
</style>
