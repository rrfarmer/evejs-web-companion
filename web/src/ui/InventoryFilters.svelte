<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { getCategories, getCategoryGroups, getTypeMeta, importMultibuy, resolveNames } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import {
    addInventoryFilterTypes, DEFAULT_INVENTORY_FILTERS, FILTER_FIELD as F, FILTER_OP as O,
    INVENTORY_FILTERS_SETTING, parseInventoryFilterLink, readInventoryFilters, writeInventoryFilters,
    type InventoryCondition, type InventoryFilter,
  } from "../bridge/inventoryFilters.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { carriesOurPayload, decodeDrag, DRAG_MIME } from "./dragDrop.ts";
  import { droppedFittingDrag, isFittingDrag } from "./fittingDrag.ts";
  import { startLinkDrag } from "./linkFollowers.ts";

  let { store, flow, onFilters, selectedTypes }: {
    store: ClientStore;
    flow: AppFlow;
    onFilters: (filters: readonly InventoryFilter[]) => void;
    selectedTypes: (itemID: number) => readonly number[];
  } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const links = flow.inventoryFilterLinks;
  const PREFIX = "UI/Inventory/Filters/";
  const controls = {
    my: ["UI/Inventory/MyFilters", "My Filters"], create: ["UI/Inventory/CreateFilter", "Create Filter"],
    editor: [PREFIX + "ItemFilterCaption", "Item Filter"], match: [PREFIX + "Match", "Match"],
    name: [PREFIX + "FilterName", "Filter Name"], all: [PREFIX + "All", "All"], any: [PREFIX + "Any", "Any"],
    importItems: [PREFIX + "ImportFilterItems", "Import Items"], failedLines: ["UI/SkillQueue/CouldNotReadLines", "Could not read these lines:"],
    share: [PREFIX + "ShareFilter", "Share Filter"], shared: [PREFIX + "SharedItemFilter", "Shared Item Filter"],
  } as const;
  const fields = [
    [F.assembled, "ConditionAssembled", "Assembled"], [F.category, "", "Category"], [F.group, "ConditionGroup", "Group"],
    [F.name, "ConditionName", "Name"], [F.size, "ConditionStackSize", "Stack Size"],
    [F.price, "ConditionUnitPrice", "Unit Price"], [F.volume, "ConditionVolume", "Volume"],
    [F.slot, "ConditionSlotType", "Slot Type"], [F.metaGroup, "ConditionMetaGroup", "Meta Group"],
    [F.metaLevel, "ConditionMetaLevel", "Meta Level"], [F.power, "ConditionPowerUsage", "Powergrid Use"],
    [F.cpu, "ConditionCpuUsage", "CPU Use"],
    [F.blueprintCopy, "ConditionBlueprintCopy", "Blueprint Copy"], [F.clone, "ConditionCloneState", "Clone State"],
  ] as const;
  const operators: Readonly<Record<number, readonly [string, string]>> = {
    [O.is]: ["CritIs", "Is"], [O.isnt]: ["CritIsNot", "Is Not"],
    [O.less]: ["CritLessThan", "Less Than"], [O.equal]: ["CritEqualTo", "Equal To"], [O.greater]: ["CritGreaterThan", "Greater Than"],
    [O.starts]: ["CritStartsWith", "Starts With"], [O.notStarts]: ["CritNotStartsWith", "Does Not Start With"],
    [O.contains]: ["CritContains", "Contains"], [O.notContains]: ["CritNotContains", "Does Not Contain"],
  };
  const slotOptions = [
    [11, "SlotLowPower", "Low"], [13, "SlotMedPower", "Medium"],
    [12, "SlotHighPower", "High"], [2663, "SlotRig", "Rig"],
  ] as const;
  const metaOptions = [[1, "Tech I"], [2, "Tech II"], [3, "Storyline"], [4, "Faction"], [5, "Officer"], [6, "Deadspace"], [14, "Tech III"]] as const;
  const idFields = new Set<number>([F.category, F.group, F.slot, F.metaGroup]);
  const integerFields = new Set<number>([F.size, F.metaLevel]);
  const booleanFields = new Set<number>([F.assembled, F.blueprintCopy]);

  type Option = { readonly id: number; readonly nameID: number; readonly published: boolean };
  let categories = $state<readonly Option[]>([]);
  let groups = $state<ReadonlyMap<number, readonly Option[]>>(new Map());
  let metaNames = $state<ReadonlyMap<number, number | null>>(new Map());
  let groupCategories = $state<readonly (number | null)[]>([]);
  let expanded = $state(false);
  let loaded = $state(false);
  let busy = $state(false);
  let error = $state("");
  let saved = $state<readonly InventoryFilter[] | null>(null);
  let checked = $state<readonly string[]>([]);
  type FilterDraft = { original: string | null; name: string; match: 1 | 2; conditions: readonly InventoryCondition[] };
  let draft = $state<FilterDraft | null>(null);
  let importOpen = $state(false);
  let importText = $state("");
  let importFailures = $state<readonly string[]>([]);
  let shared = $state<{ url: string; name: string } | null>(null);
  let openShared = $state(false);
  let sharedInput = $state("");
  let confirm = $state<{ kind: "replace" | "remove"; name: string } | null>(null);
  let active = false;

  const label = ([key, fallback]: readonly [string, string]) => plainText($words.templates[key] ?? "") || fallback;
  const fieldLabel = (field: typeof fields[number]) => label([field[1] ? PREFIX + field[1] : "", field[2]]);
  const fieldOptions = $derived([...fields].sort((a, b) => fieldLabel(a).localeCompare(fieldLabel(b))));
  const defaults = $derived<readonly InventoryFilter[]>(DEFAULT_INVENTORY_FILTERS.map(([key, own, match, conditions]) => [label([key, own]), match, conditions]));
  const filters = $derived([...(saved ?? defaults)].sort((a, b) => a[0].localeCompare(b[0])));
  const normalized = (name: string) => name.toLowerCase();
  const readyConditions = $derived(draft?.conditions.filter(([field, , value]) =>
    !idFields.has(field) || typeof value === "number" && value > 0) ?? []);
  const preview = $derived<InventoryFilter | null>(expanded && draft && readyConditions.length ? [draft.name, draft.match, readyConditions] : null);
  const unsupported = (filter: InventoryFilter) => filter[2].some(([field]) => !fields.some(([id]) => field === id));

  $effect(() => {
    const enabled = filters.filter(([name]) => checked.includes(name));
    onFilters((preview ? [...enabled, preview] : enabled).filter(filter => !unsupported(filter)));
  });

  $effect(() => {
    if (loaded && !busy && $links) untrack(() => {
      const filter = flow.takeInventoryFilterLink();
      if (filter) { expanded = true; edit(filter, null); }
    });
  });

  async function read() {
    error = "";
    try {
      const text = await flow.readCharacterSetting(INVENTORY_FILTERS_SETTING);
      if (active) { saved = text === null ? null : readInventoryFilters(text); loaded = true; }
    } catch {
      if (active) error = "Inventory filters could not be loaded.";
    }
  }

  onMount(() => {
    active = true;
    flow.requestWords([
      ...Object.values(controls).map(([key]) => key), ...fields.flatMap(([, key]) => key ? [PREFIX + key] : []),
      ...Object.values(operators).map(([key]) => PREFIX + key), PREFIX + "CritIsTrue", PREFIX + "CritIsFalse",
      ...slotOptions.map(([, key]) => PREFIX + key),
      ...DEFAULT_INVENTORY_FILTERS.map(([key]) => key),
    ]);
    void read();
    return () => { active = false; };
  });

  function edit(filter?: InventoryFilter, original = filter?.[0] ?? null) {
    confirm = null;
    error = "";
    importOpen = false;
    importText = "";
    importFailures = [];
    shared = null;
    draft = filter ? { original, name: filter[0], match: filter[1], conditions: filter[2] }
      : { original: null, name: "", match: 1, conditions: [] };
    groupCategories = (filter?.[2] ?? []).map(() => null);
    if (filter) flow.requestNames(filter[2].flatMap(([field, , id]) =>
      typeof id === "number" && (field === F.category || field === F.group) ? [{ kind: field === F.category ? "category" : "group", id }] : []));
    if (filter?.[2].some(([field]) => field === F.metaGroup)) void readMetaGroups();
    if (!categories.length) void getCategories(flow.requestOptions()).then(rows => {
      categories = rows.filter(row => row.published).map(row => ({ ...row, id: row.categoryID }));
      flow.requestWords(categories.map(row => `#${row.nameID}`));
    }).catch(() => { error = "Item categories could not be loaded."; });
  }

  async function readMetaGroups() {
    if (metaNames.size) return;
    try {
      const result = await getTypeMeta([], flow.requestOptions());
      if (!active) return;
      metaNames = result.metaGroupNameIDs;
      flow.requestWords([...metaNames.values()].flatMap(id => id === null ? [] : [`#${id}`]));
    } catch { /* The standard meta-group names are available below. */ }
  }

  async function selectGroupCategory(index: number, categoryID: number, operator: number) {
    groupCategories = draft?.conditions.map((_, i) => i === index ? categoryID || null : groupCategories[i] ?? null) ?? [];
    change(index, [F.group, operator, 0]);
    if (categoryID <= 0) return;
    if (groups.has(categoryID)) return;
    try {
      const rows = (await getCategoryGroups(categoryID, flow.requestOptions())).filter(row => row.published)
        .map(row => ({ ...row, id: row.groupID }));
      groups = new Map(groups).set(categoryID, rows);
      flow.requestWords(rows.map(row => `#${row.nameID}`));
    } catch { error = "Item groups could not be loaded."; }
  }

  function change(index: number, condition: InventoryCondition | null) {
    if (!draft) return;
    if (condition === null) groupCategories = groupCategories.filter((_, i) => i !== index);
    draft.conditions = condition === null ? draft.conditions.filter((_, i) => i !== index)
      : [...draft.conditions.slice(0, index), condition, ...draft.conditions.slice(index + 1)];
  }

  function add(field: number) {
    if (!draft || !fields.some(([id]) => id === field)) return;
    if (field === F.metaGroup) void readMetaGroups();
    const boolean = booleanFields.has(field);
    change(draft.conditions.length, [field, field === F.name ? O.starts : idFields.has(field) || field === F.clone ? O.is : boolean ? O.isnt : O.greater,
      field === F.name ? "" : boolean ? true : 0]);
  }

  function options(field: number): readonly number[] {
    if (field === F.name) return [O.starts, O.notStarts, O.is, O.isnt, O.contains, O.notContains];
    if (idFields.has(field) || booleanFields.has(field) || field === F.clone) return [O.is, O.isnt];
    return [O.less, O.equal, O.greater];
  }

  async function appendTypes(held: FilterDraft, ids: readonly number[]) {
    const ordered = [...new Set(ids)];
    const unresolved = ordered.filter(id => !resolvedName($names.resolved, "type", id, ""));
    const fetched: Record<string, string | null> = {};
    const request = flow.requestOptions();
    for (let start = 0; start < unresolved.length && active && draft === held; start += 100) {
      const result = await resolveNames(unresolved.slice(start, start + 100).map(id => ({ kind: "type", id })), request);
      Object.assign(fetched, result.names);
    }
    if (active && draft === held) {
      held.conditions = addInventoryFilterTypes(held.conditions, ordered.map(id => resolvedName($names.resolved, "type", id, "") || fetched[`type:${id}`] || ""));
    }
  }

  async function drop(event: DragEvent) {
    const held = draft;
    if (!held) return;
    const dropped = droppedFittingDrag(event);
    const item = decodeDrag(event.dataTransfer?.getData(DRAG_MIME));
    if (!item && !dropped) return;
    event.preventDefault();
    try {
      const fitting = dropped?.kind === "source" ? await flow.draggedFittingOf(dropped.source) : dropped?.fitting;
      if (dropped && !fitting) throw new Error("Unknown fitting");
      const ids = fitting ? [fitting.shipTypeID, ...fitting.fitData.map(([id]) => id)]
        : item?.kind === "inventoryItem" ? [...selectedTypes(item.itemID), item.typeID] : item ? [item.typeID] : [];
      await appendTypes(held, ids);
    } catch { if (active && draft === held) error = "The dropped item names could not be read."; }
  }

  async function importItems() {
    const held = draft;
    if (!held || busy || !importText.trim()) return;
    busy = true;
    importFailures = [];
    error = "";
    try {
      const read = await importMultibuy(importText, flow.requestOptions());
      await appendTypes(held, read.found.map(([typeID]) => typeID));
      if (!active || draft !== held) return;
      importFailures = read.failedLines;
      importText = "";
      importOpen = false;
    } catch { if (active && draft === held) error = "The item list could not be imported."; }
    finally { if (active) busy = false; }
  }

  const complete = (conditions: readonly InventoryCondition[]) => conditions.length > 0 &&
    conditions.every(([field, , value]) => !idFields.has(field) || typeof value === "number" && value > 0);

  async function share() {
    if (!draft?.name.trim() || !complete(draft.conditions) || busy) return;
    const filter: InventoryFilter = [draft.name.trim(), draft.match, draft.conditions];
    busy = true;
    error = "";
    try {
      const url = await flow.shareInventoryFilter(filter);
      if (active) shared = { url, name: filter[0] };
    } catch { if (active) error = "The item filter could not be shared."; }
    finally { if (active) busy = false; }
  }

  async function openSharedFilter() {
    if (busy || !parseInventoryFilterLink(sharedInput)) return;
    busy = true;
    error = "";
    try {
      const filter = await flow.readSharedInventoryFilter(sharedInput);
      if (!active) return;
      edit(filter, null);
      openShared = false;
      sharedInput = "";
    } catch { if (active) error = "The shared item filter could not be loaded."; }
    finally { if (active) busy = false; }
  }

  async function persist(remove: string | null = null, replace = false) {
    if (!loaded || busy || (!remove && (!draft?.name.trim() || !complete(draft.conditions)))) return;
    const next: InventoryFilter | null = remove || !draft ? null : [draft.name.trim(), draft.match, draft.conditions];
    const original = remove ?? draft?.original ?? null;
    error = "";
    busy = true;
    try {
      const text = await flow.readCharacterSetting(INVENTORY_FILTERS_SETTING);
      if (!active) return;
      const current = text === null ? defaults : readInventoryFilters(text);
      const matches = (candidate: string, name: string | null) => name !== null && normalized(candidate) === normalized(name);
      const replaced = next && current.some(([name]) => matches(name, next[0]) && !matches(name, original));
      if (replaced && !replace) { confirm = { kind: "replace", name: next[0] }; return; }
      const remaining = current.filter(([name]) => !matches(name, original) && !matches(name, next?.[0] ?? null));
      const updated = next ? [...remaining, next] : remaining;
      await flow.saveCharacterSetting(INVENTORY_FILTERS_SETTING, writeInventoryFilters(updated));
      if (!active) return;
      if (original !== null && checked.includes(original)) checked = next ? [...checked.filter(name => name !== original), next[0]] : checked.filter(name => name !== original);
      saved = updated;
      if (draft && next) draft.original = next[0];
      confirm = null;
    } catch { if (active) error = "Inventory filters could not be saved."; }
    finally { if (active) busy = false; }
  }

  function optionName(option: Option) { return label([`#${option.nameID}`, ""]); }
  const categoryOptions = $derived(categories.filter(optionName).toSorted((a, b) => optionName(a).localeCompare(optionName(b))));
  const groupOptions = (category: number | null) => (category === null ? [] : groups.get(category) ?? []).filter(optionName)
    .toSorted((a, b) => optionName(a).localeCompare(optionName(b)));
</script>

<details class="inventory-filters" bind:open={expanded}>
  <summary>{label(controls.my)}{checked.length ? ` (${checked.length})` : ""}</summary>
  {#if error}<p role="status">{error}</p>{/if}
  {#if !loaded}
    {#if error}<button type="button" onclick={() => void read()}>Retry</button>{:else}<p>Loading filters…</p>{/if}
  {:else}
    <div class="filter-actions">
      <button type="button" disabled={busy} onclick={() => edit()}>{label(controls.create)}</button>
      <button type="button" disabled={busy} aria-expanded={openShared} onclick={() => { openShared = !openShared; }}>Open Filter Link</button>
      {#if checked.length}<button type="button" onclick={() => { checked = []; }}>Clear Active Filters</button>{/if}
    </div>
    {#if openShared}
      <form class="shared-filter" onsubmit={event => { event.preventDefault(); void openSharedFilter(); }}>
        <label>{label(controls.shared)} <input type="text" bind:value={sharedInput} /></label>
        <button type="submit" disabled={busy || !parseInventoryFilterLink(sharedInput)}>Open</button>
      </form>
    {/if}
    <ul class="saved-filters">
      {#each filters as filter (filter[0])}
        <li>
          <label title={unsupported(filter) ? "This filter has a condition that cannot yet be applied." : undefined}><input type="checkbox" disabled={unsupported(filter)} checked={checked.includes(filter[0])} onchange={(event) => {
            checked = event.currentTarget.checked ? [...checked, filter[0]] : checked.filter(name => name !== filter[0]);
          }} /> {filter[0]}</label>
          <button type="button" disabled={busy} aria-label={`Edit ${filter[0]}`} onclick={() => edit(filter)}>Edit</button>
          <button type="button" disabled={busy} aria-label={`Remove ${filter[0]}`} onclick={() => { confirm = { kind: "remove", name: filter[0] }; }}>Remove</button>
        </li>
      {/each}
    </ul>
    {#if draft}
      <section class="filter-editor" aria-label={label(controls.editor)}>
        <h3>{label(controls.editor)}</h3>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="criteria" ondragover={event => {
          if (carriesOurPayload(event.dataTransfer?.types) || isFittingDrag(event)) {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
          }
        }} ondrop={event => void drop(event)}>
          <p class="drop-hint">Drop items here to match their names.</p>
          {#each draft.conditions as [field, operator, value], index}
            {@const definition = fields.find(([id]) => id === field)}
            <div class="condition">
              <button type="button" aria-label={`Remove condition ${index + 1}`} onclick={() => change(index, null)}>−</button>
              {#if definition}
                <span>{fieldLabel(definition)}</span>
                <select aria-label={`Condition ${index + 1} operator`} value={operator} onchange={event => change(index, [field, Number(event.currentTarget.value), value])}>
                  {#each options(field) as op (op)}
                    {@const [key, fallback] = operators[op]!}
                    <option value={op}>{booleanFields.has(field) ? label([PREFIX + (op === O.is ? "CritIsTrue" : "CritIsFalse"), op === O.is ? "Is True" : "Is False"]) : label([PREFIX + key, fallback])}</option>
                  {/each}
                </select>
                {#if field === F.category || field === F.group}
                  {@const groupCategory = groupCategories[index] ?? null}
                  {@const choices = field === F.category ? categoryOptions : groupOptions(groupCategory)}
                  {#if field === F.group}
                    <select aria-label={`Condition ${index + 1} category`} value={groupCategory ?? 0} onchange={event => void selectGroupCategory(index, Number(event.currentTarget.value), operator)}>
                      <option value={0}>Category</option>
                      {#each categoryOptions as option (option.id)}<option value={option.id}>{optionName(option)}</option>{/each}
                    </select>
                  {/if}
                  <select aria-label={`Condition ${index + 1} value`} value={value} onchange={event => change(index, [field, operator, Number(event.currentTarget.value)])}>
                    <option value={0}>{field === F.category ? "Select category" : "Select group"}</option>
                    {#if typeof value === "number" && value > 0 && !choices.some(option => option.id === value)}
                      <option value={value}>{resolvedName($names.resolved, field === F.category ? "category" : "group", value, "Saved value")}</option>
                    {/if}
                    {#each choices as option (option.id)}<option value={option.id}>{optionName(option)}</option>{/each}
                  </select>
                {:else if field === F.slot || field === F.metaGroup}
                  {@const choices = field === F.slot ? slotOptions.map(([id, key, fallback]) => [id, label([PREFIX + key, fallback])] as const)
                    : metaOptions.map(([id, fallback]) => [id, label([`#${metaNames.get(id)}`, fallback])] as const).sort((a, b) => a[1].localeCompare(b[1]))}
                  <select aria-label={`Condition ${index + 1} value`} value={value} onchange={event => change(index, [field, operator, Number(event.currentTarget.value)])}>
                    <option value={0}>{field === F.slot ? "Select slot" : "Select meta group"}</option>
                    {#if typeof value === "number" && value > 0 && !choices.some(([id]) => id === value)}<option value={value}>Saved value</option>{/if}
                    {#each choices as [id, text] (id)}<option value={id}>{text}</option>{/each}
                  </select>
                {:else if field === F.clone}
                  <select aria-label={`Condition ${index + 1} value`} value={value} onchange={event => change(index, [field, operator, Number(event.currentTarget.value)])}>
                    <option value={0}>Alpha</option>
                    <option value={1}>Omega</option>
                  </select>
                {:else if !booleanFields.has(field)}
                  <input aria-label={`Condition ${index + 1} value`} type={field === F.name ? "text" : "number"}
                    min={field === F.name ? undefined : 0} step={integerFields.has(field) ? 1 : "any"} value={String(value)}
                    oninput={event => {
                      const input = event.currentTarget.value;
                      const numeric = Math.max(0, Number(input));
                      change(index, [field, operator, field === F.name ? input : integerFields.has(field) ? Math.trunc(numeric) : numeric]);
                    }} />
                {/if}
              {:else}
                <span>Condition {index + 1} from EVE (preview unavailable)</span>
              {/if}
            </div>
          {/each}
          <label>
            <span class="sr-only">Add condition</span>
            <select value={0} onchange={event => { add(Number(event.currentTarget.value)); event.currentTarget.value = "0"; }}>
              <option value={0}>Add condition</option>
              {#each fieldOptions as definition (definition[0])}<option value={definition[0]}>{fieldLabel(definition)}</option>{/each}
            </select>
          </label>
        </div>
        <footer>
          <fieldset>
            <legend>{label(controls.match)}</legend>
            <label><input type="radio" value={1} bind:group={draft.match} /> {label(controls.all)}</label>
            <label><input type="radio" value={2} bind:group={draft.match} /> {label(controls.any)}</label>
          </fieldset>
          <label>{label(controls.name)} <input type="text" maxlength={100} bind:value={draft.name} /></label>
          <button type="button" disabled={busy} aria-expanded={importOpen} onclick={() => { importOpen = !importOpen; }}>{label(controls.importItems)}</button>
          <button type="button" title={label(controls.share)} disabled={busy || !draft.name.trim() || !complete(draft.conditions)} onclick={() => void share()}>Share Filter</button>
          <button type="button" disabled={busy || !draft.name.trim() || !complete(draft.conditions)} onclick={() => void persist()}>Save</button>
          <button type="button" disabled={busy} onclick={() => { draft = null; if (confirm?.kind === "replace") confirm = null; }}>Close</button>
        </footer>
        {#if shared}
          {@const link = shared}
          <div class="shared-filter">
            <button type="button" class="evelink sharedSetting" draggable="true" title={label(controls.share)} ondragstart={event => {
              startLinkDrag(event, link.url, link.name);
              event.dataTransfer?.setData("text/plain", link.url);
            }}
              onclick={event => { const field = event.currentTarget.nextElementSibling?.querySelector("input"); field?.focus(); field?.select(); }}>{link.name}</button>
            <label>Filter link <input type="text" readonly value={link.url} onfocus={event => event.currentTarget.select()} /></label>
          </div>
        {/if}
        {#if importOpen}
          <div class="import-items">
            <label>Item list <textarea rows="3" bind:value={importText} placeholder="Veldspar&#10;Tritanium" /></label>
            <button type="button" disabled={busy || !importText.trim()} onclick={() => void importItems()}>Import</button>
          </div>
        {/if}
        {#if importFailures.length}
          <div role="status" class="import-failures">
            {label(controls.failedLines)}
            <ul>{#each importFailures as line}<li>{line}</li>{/each}</ul>
          </div>
        {/if}
      </section>
    {/if}
    {#if confirm}
      {@const pending = confirm}
      <p>{pending.kind === "replace" ? "Replace" : "Remove"} {pending.name}?
        <button type="button" disabled={busy} onclick={() => void persist(pending.kind === "remove" ? pending.name : null, true)}>Yes</button>
        <button type="button" disabled={busy} onclick={() => { confirm = null; }}>No</button>
      </p>
    {/if}
  {/if}
</details>

<style>
  .inventory-filters { padding: 4px 10px; }
  summary { cursor: pointer; }
  .filter-actions, .saved-filters, .condition, footer { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
  .saved-filters { list-style: none; padding: 0; margin: 6px 0; }
  .saved-filters li { display: flex; align-items: center; gap: 4px; }
  .filter-editor { padding: 6px 8px; border: 1px solid var(--line, #444); }
  h3 { margin: 0; }
  .criteria { max-height: 130px; overflow: auto; padding: 4px 0 16px; }
  .drop-hint { margin: 0 0 4px; opacity: 0.75; }
  .condition { margin-bottom: 4px; }
  .condition input, .condition select, footer input { max-width: 100%; }
  footer { padding-top: 6px; }
  fieldset { display: flex; gap: 6px; margin: 0; border: 0; padding: 0; }
  footer > label { display: grid; gap: 2px; }
  .import-items { display: flex; align-items: end; gap: 6px; margin-top: 6px; }
  .import-items label { display: grid; flex: 1; gap: 2px; }
  .import-items textarea { border: 1px solid var(--line, #444); background: rgb(0 0 0 / 35%); }
  .shared-filter { display: flex; flex-wrap: wrap; align-items: end; gap: 6px; margin-top: 6px; }
  .shared-filter label { display: grid; flex: 1 1 12rem; }
  .import-failures { margin-top: 6px; overflow: auto; max-height: 6rem; }
</style>
