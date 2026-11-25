<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { ORBITAL_TAX_KEYS, type OrbitalTaxKey, type SkyhookEntry, type SkyhookSettings } from "../bridge/skyhooks.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { droppedAccessGroup, hasAccessGroupDrag } from "./accessGroupDrag.ts";

  let { store, flow, target, name, onClose }: {
    store: ClientStore; flow: AppFlow; target: SkyhookEntry; name: string; onClose: () => void;
  } = $props();
  const words = $derived(store.words);
  const labels = {
    title: ["UI/OrbitalSkyhook/ConfigWnd/SkyhookConfig", "Orbital Skyhook Configuration"],
    settings: ["UI/OrbitalSkyhook/ConfigWnd/SkyhookSettings", "Orbital Skyhook Settings"],
    hour: ["UI/PI/OrbitalConfigurationWindow/ReinforcementExit", "Reinforcement Exit"],
    access: ["UI/OrbitalSkyhook/ConfigWnd/TakeAccess", "Take Access"],
    accessHint: ["UI/OrbitalSkyhook/ConfigWnd/TakeAccessComboHint", "Drop an access list here."],
    none: ["UI/AclBookmarks/NoAccessList", "-"],
    customs: ["UI/OrbitalSkyhook/ConfigWnd/CustomsOfficeSettings", "Customs Office Settings"],
    corporation: ["UI/PI/OrbitalConfigurationWindow/CorporationTax", "Corporation Tax"],
    alliance: ["UI/PI/OrbitalConfigurationWindow/AllianceTax", "Alliance Tax"],
    standings: ["UI/PI/OrbitalConfigurationWindow/Standing", "Standings"],
    denied: ["UI/PI/Common/CustomsOfficeAccessDenied", "Access Denied"],
    submit: ["UI/Common/Submit", "Submit"],
    cancel: ["UI/Common/Cancel", "Cancel"],
  } as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const levels = [
    [-10, "Terrible", "standingHorrible"], [-5, "Bad", "standingBad"], [0, "Neutral", "standingNeutral"],
    [5, "Good", "standingGood"], [10, "Excellent", "standingHigh"],
  ] as const;
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  let config = $state.raw<Awaited<ReturnType<AppFlow["loadSkyhookConfiguration"]>> | null>(null);
  let draft = $state<{ -readonly [Key in keyof SkyhookSettings]: SkyhookSettings[Key] } | null>(null);
  let taxes = $state<Partial<Record<OrbitalTaxKey, number>>>({});
  let saving = $state(false);
  let error = $state("");
  let active = false;
  let dropRequest = 0;

  function time(hour: number): string {
    return String((hour + 24) % 24).padStart(2, "0") + ":00";
  }

  $effect(() => {
    active = true;
    flow.requestWords(Object.values(labels).map(([path]) => path));
    void flow.loadSkyhookConfiguration(target).then(result => {
      if (!active) return;
      config = result;
      draft = { ...result.settings };
      for (const key of ORBITAL_TAX_KEYS) taxes[key] = Number((result.settings.taxRates[key] * 100).toFixed(8));
    }).catch(cause => { if (active) error = panelErrorWords(cause); });
    return () => { active = false; };
  });

  async function submit(): Promise<void> {
    if (!draft || saving) return;
    dropRequest++;
    saving = true;
    error = "";
    try {
      const taxRates = Object.fromEntries(ORBITAL_TAX_KEYS.map(key => [key, (taxes[key] ?? NaN) / 100])) as SkyhookSettings["taxRates"];
      await flow.saveSkyhookConfiguration(target, { ...draft, taxRates });
      if (active) onClose();
    } catch (cause) {
      if (active) error = panelErrorWords(cause);
    } finally {
      if (active) saving = false;
    }
  }

  async function dropAccessGroup(event: DragEvent): Promise<void> {
    const id = droppedAccessGroup(event);
    if (id === null || !config || !draft || saving) return;
    event.preventDefault();
    const request = ++dropRequest;
    error = "";
    if (config.groups.some(group => group.id === id)) {
      draft.acl = id;
      return;
    }
    try {
      const option = await flow.loadSkyhookAccessGroup(id);
      if (!active || dropRequest !== request || !config || !draft) return;
      if (!option) {
        error = "This access list is unavailable.";
        return;
      }
      config = { ...config, groups: [...config.groups, option] };
      draft.acl = option.id;
    } catch (cause) {
      if (active && dropRequest === request) error = panelErrorWords(cause);
    }
  }
</script>

{#snippet taxInput(key: OrbitalTaxKey, label: string, denied = false)}
  <label>{label}
    {#if denied}<input value={word("denied")} disabled />
    {:else}<input type="number" aria-label={label} min="0" max="100" step="any" required bind:value={taxes[key]} /> %{/if}
  </label>
{/snippet}

<form class="skyhook-configuration" aria-label={word("title")} onsubmit={(event) => { event.preventDefault(); void submit(); }}>
  <header><h3>{word("title")}</h3><div>{name}</div></header>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if config && draft}
    <fieldset disabled={saving}>
      <legend>{word("settings")}</legend>
      <label>{word("hour")}
        <select bind:value={draft.hour}>
          {#each hours as hour (hour)}
            <option value={hour}>{time(hour - config.varianceHours)} - {time(hour + config.varianceHours)}</option>
          {/each}
        </select>
      </label>
      <label>{word("access")}
        <select bind:value={draft.acl} title={word("accessHint")} onchange={() => { dropRequest++; error = ""; }}
          ondragover={(event) => { if (!saving && hasAccessGroupDrag(event)) event.preventDefault(); }}
          ondrop={(event) => void dropAccessGroup(event)}>
          <option value={null}>{word("none")}</option>
          {#each config.groups as group (group.id)}<option value={group.id}>{group.name}</option>{/each}
          {#if draft.acl !== null && !config.groups.some(group => group.id === draft?.acl)}
            <option value={draft.acl}>{draft.acl}</option>
          {/if}
        </select>
      </label>
    </fieldset>
    <fieldset disabled={saving}>
      <legend>{word("customs")}</legend>
      {@render taxInput("corporation", word("corporation"))}
      <label><input type="checkbox" bind:checked={draft.allowAlliance} /> {word("alliance")}</label>
      {@render taxInput("alliance", word("alliance") + " %", !draft.allowAlliance)}
      <label><input type="checkbox" bind:checked={draft.allowStandings} /> {word("standings")}</label>
      {#if draft.allowStandings}
        <label>Minimum Standing
          <select bind:value={draft.standing}>{#each levels as [level, name] (level)}<option value={level}>{name}</option>{/each}</select>
        </label>
        {#each levels as [level, name, key] (level)}
          {@render taxInput(key, name, level < draft.standing)}
        {/each}
      {/if}
    </fieldset>
  {:else if !error}<p role="status">Reading orbital settings…</p>{/if}
  <div class="controls">
    <button type="submit" disabled={!draft || saving}>{word("submit")}</button>
    <button type="button" disabled={saving} onclick={onClose}>{word("cancel")}</button>
  </div>
</form>

<style>
  form { display: grid; gap: 8px; padding: 8px; border: 1px solid var(--line, #444); }
  h3, p { margin: 0; }
  fieldset { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
  label { display: flex; align-items: center; gap: 4px; }
  input:not([type="checkbox"]) { width: 88px; }
  .controls { display: flex; gap: 6px; }
</style>
