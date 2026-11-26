<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import {
    PROFILE_SETTING_CATEGORIES, profileSettingSignature, type ProfileSettingDefinition, type ProfileSettingRow,
  } from "../bridge/structureProfileSettings.ts";
  import type { StructureProfile } from "../bridge/structures.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { droppedAccessGroup, hasAccessGroupDrag } from "./accessGroupDrag.ts";

  let { flow, store, profile, onManageAccessGroups, dirty = $bindable(false), saving = $bindable(false) }: {
    flow: AppFlow; store: ClientStore; profile: StructureProfile; onManageAccessGroups?: () => void;
    dirty?: boolean; saving?: boolean;
  } = $props();
  const words = $derived(store.words);
  const labels = {
    add: ["UI/StructureSettingWnd/AddGroupToSetting", "Add Access List"],
    manage: ["UI/StructureSettingWnd/ManageAccessGroups", "Manage Access Lists"],
    none: ["UI/StructureSettingWnd/NoGroups", "No Access Lists"],
    remove: ["UI/StructureSettingWnd/RemoveGroup", "Remove Access List"],
    save: ["UI/Common/Buttons/Save", "Save"],
  } as const;
  function word([key, fallback]: readonly [string, string]): string {
    return plainText($words.templates[key] ?? fallback);
  }
  const definitions = new Map<number, ProfileSettingDefinition>(PROFILE_SETTING_CATEGORIES
    .flatMap(category => category.settings).map(setting => [setting.id, setting]));
  let categoryID = $state<number>(1004);
  const category = $derived(PROFILE_SETTING_CATEGORIES.find(item => item.id === categoryID) ?? PROFILE_SETTING_CATEGORIES[0]);
  let baseline = $state.raw<readonly ProfileSettingRow[] | null>(null);
  let draft = $state.raw<readonly ProfileSettingRow[]>([]);
  let available = $state.raw<ReadonlyMap<number, string>>(new Map());
  let names = $state.raw<ReadonlyMap<number, string>>(new Map());
  let error = $state("");
  let active = false;

  $effect(() => {
    dirty = baseline !== null && profileSettingSignature(baseline) !== profileSettingSignature(draft);
  });

  onMount(() => {
    active = true;
    flow.requestWords([...Object.values(labels).map(([key]) => key), ...PROFILE_SETTING_CATEGORIES.map(item => `UI/StructureSettings/${item.label}`),
      ...[...definitions.values()].map(item => item.label)]);
    void flow.loadStructureProfileSettings(profile.id).then(({ rows, groups }) => {
      if (!active) return;
      baseline = draft = rows;
      available = names = new Map(groups.map(group => [group.groupID, group.name]));
      for (const id of new Set(rows.map(row => row.groupID))) {
        if (id <= 0 || names.has(id)) continue;
        void flow.readAccessGroup(id).then(group => {
          if (active && group) names = new Map(names).set(id, group.name);
        }).catch(() => {});
      }
    }).catch(cause => { if (active) error = panelErrorWords(cause); });
    return () => { active = false; };
  });

  const groupName = (id: number) => names.get(id) ?? (id === 0 ? "Public" : `Access List ${id}`);

  function add(settingID: number, groupID: number): void {
    if (baseline === null || saving || draft.some(row => row.settingID === settingID && row.groupID === groupID)) return;
    draft = [...draft, { settingID, groupID, value: 0 }];
  }

  async function addDropped(event: DragEvent, settingID: number): Promise<void> {
    const groupID = droppedAccessGroup(event);
    if (groupID === null || saving) return;
    event.preventDefault();
    if (names.has(groupID)) {
      add(settingID, groupID);
      return;
    }
    try {
      const group = await flow.readAccessGroup(groupID);
      if (!active) return;
      if (!group) throw new Error("This access list is unavailable.");
      names = new Map(names).set(groupID, group.name);
      add(settingID, groupID);
    } catch (cause) {
      if (active) error = panelErrorWords(cause);
    }
  }

  function setValue(row: ProfileSettingRow, value: string): void {
    draft = draft.map(item => item === row ? { ...item, value: value === "" ? "" : Number(value) } : item);
  }

  const invalid = $derived(draft.some(row => {
    const setting = definitions.get(row.settingID);
    if (setting?.max === undefined || baseline?.some(old => old === row)) return false;
    const { value } = row;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > setting.max) return true;
    const steps = value / (setting.step ?? 1);
    return Math.abs(steps - Math.round(steps)) > 1e-7;
  }));

  async function save(): Promise<void> {
    if (baseline === null || !dirty || invalid || saving) return;
    saving = true;
    error = "";
    try {
      const saved = await flow.saveStructureProfileSettings(profile.id, baseline, draft);
      if (active) baseline = draft = saved;
    } catch (cause) {
      if (active) error = panelErrorWords(cause);
    } finally {
      if (active) saving = false;
    }
  }
</script>

<section class="profile-settings" aria-label="Profile Settings">
  <header>
    <strong>{profile.name}</strong>
    {#if onManageAccessGroups}<button type="button" onclick={onManageAccessGroups}>{word(labels.manage)}</button>{/if}
  </header>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if baseline === null}
    {#if !error}<p role="status">Loading profile settings…</p>{/if}
  {:else}
    <nav aria-label="Structure Services">
      {#each PROFILE_SETTING_CATEGORIES as item (item.id)}
        <button type="button" data-category={item.id} aria-pressed={category.id === item.id}
          onclick={() => categoryID = item.id}>{word([`UI/StructureSettings/${item.label}`, item.fallback])}</button>
      {/each}
    </nav>
    <form onsubmit={event => { event.preventDefault(); void save(); }}>
      {#each category.settings as setting (setting.id)}
        {@const rows = draft.filter(row => row.settingID === setting.id).sort((a, b) => groupName(a.groupID).localeCompare(groupName(b.groupID)))}
        {@const choices = [...available].filter(([id]) => !rows.some(row => row.groupID === id))
          .sort((a, b) => a[1].localeCompare(b[1]))}
        <fieldset data-setting={setting.id} disabled={saving}
          ondragover={event => { if (!saving && hasAccessGroupDrag(event)) event.preventDefault(); }}
          ondrop={event => void addDropped(event, setting.id)}>
          <legend>{word([setting.label, setting.fallback])}</legend>
          {#if !rows.length}<p>{word(labels.none)}</p>{/if}
          {#each rows as row (row.groupID)}
            <div class="setting-group" data-group={row.groupID}>
              <span>{groupName(row.groupID)}</span>
              {#if setting.max !== undefined}
                <label>
                  <input type="number" required min="0" max={setting.max} step={setting.step} value={row.value === "" ? "" : Number(row.value)}
                    aria-label={`${word([setting.label, setting.fallback])} · ${groupName(row.groupID)}`}
                    oninput={event => setValue(row, event.currentTarget.value)} />
                  {setting.unit}
                </label>
              {/if}
              <button type="button" title={word(labels.remove)} aria-label={`${word(labels.remove)} · ${groupName(row.groupID)}`}
                onclick={() => draft = draft.filter(item => item !== row)}>×</button>
            </div>
          {/each}
          <select aria-label={`${word(labels.add)} · ${word([setting.label, setting.fallback])}`} disabled={!choices.length}
            onchange={event => {
              if (event.currentTarget.value !== "") add(setting.id, Number(event.currentTarget.value));
              event.currentTarget.value = "";
            }}>
            <option value="">{word(labels.add)}</option>
            {#each choices as [id, name] (id)}<option value={id}>{name}</option>{/each}
          </select>
        </fieldset>
      {/each}
      <button type="submit" disabled={!dirty || invalid || saving}>{word(labels.save)}</button>
    </form>
  {/if}
</section>

<style>
  .profile-settings, form, fieldset { display: grid; gap: 8px; min-width: 0; }
  header, nav, .setting-group { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  header { justify-content: space-between; }
  fieldset { margin: 0; border: 1px solid var(--line, #444); }
  legend { padding: 0 4px; }
  p { margin: 0; }
  .setting-group span { flex: 1; }
  input { inline-size: 8em; }
  select, button[type="submit"] { justify-self: start; max-width: 100%; }
  button[aria-pressed="true"] { color: var(--cyan, #9ce5f7); }
</style>
