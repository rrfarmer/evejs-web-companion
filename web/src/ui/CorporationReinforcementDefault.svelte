<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { flow, store }: { flow: AppFlow; store: ClientStore } = $props();
  const words = $derived(store.words);
  const labels = {
    title: ["UI/StructureBrowser/DefaultReinforcement", "Default Reinforcement Time"],
    hint: ["UI/StructureBrowser/DefaultReinforcementHint", "Sets the initial reinforcement hour for new structures."],
    hour: ["UI/Structures/Deployment/SetPrimeHour", "Reinforcement Hour"],
    hourHint: ["UI/Structures/Deployment/SetPrimeHourHint", "Select an hour in EVE Time."],
    subtext: ["UI/Structures/Deployment/SetPrimeHourSubtext", ""],
    apply: ["UI/Commands/Apply", "Apply"],
  } as const;
  const word = (label: keyof typeof labels) => plainText($words.templates[labels[label][0]] ?? labels[label][1]);
  const hours = Array.from({ length: 24 }, (_, index) => index);
  let hour = $state<number | null>(null);
  let canEdit = $state(false);
  let saving = $state(false);
  let error = $state("");
  let active = false;

  onMount(() => {
    active = true;
    flow.requestWords([...Object.values(labels).map(([key]) => key), "UI/StructureBrowser/DefaultReinforcementSuccessfullyUpdated"]);
    void flow.loadCorporationReinforcementDefault().then(settings => {
      if (active) { hour = settings.hour; canEdit = settings.canEdit; }
    }).catch(cause => { if (active) error = panelErrorWords(cause); });
    return () => { active = false; };
  });

  async function apply(): Promise<void> {
    if (hour === null || saving || !canEdit) return;
    saving = true;
    error = "";
    try {
      await flow.saveCorporationReinforcementDefault(hour);
    } catch (cause) {
      if (active) error = panelErrorWords(cause);
    } finally {
      if (active) saving = false;
    }
  }
</script>

<form class="corporation-reinforcement" aria-label={word("title")} onsubmit={event => { event.preventDefault(); void apply(); }}>
  <h3 title={word("hint")}>{word("title")}</h3>
  {#if hour !== null}
    <label title={word("hourHint")}>{word("hour")}
      <select bind:value={hour} disabled={!canEdit || saving}>
        {#each hours as choice (choice)}
          <option value={choice}>{String(choice).padStart(2, "0")}:00</option>
        {/each}
      </select>
    </label>
    {#if word("subtext")}<p>{word("subtext")}</p>{/if}
    {#if !canEdit}<p>Only the CEO or a Director can change this setting.</p>{/if}
    <button type="submit" disabled={!canEdit || saving}>{word("apply")}</button>
  {:else if !error}
    <p role="status">Loading reinforcement settings…</p>
  {/if}
  {#if error}<p role="alert" class="error">{error}</p>{/if}
</form>

<style>
  form { display: grid; gap: 8px; align-content: start; }
  h3, p { margin: 0; }
  label { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  button { justify-self: start; }
</style>
