<script lang="ts">
  // FilterCreationWindow (eve/client/script/ui/shared/inventory/filterSvc.py 330): the item filter editor, 450 x 250,
  // caption UI/Inventory/Filters/ItemFilterCaption. Its CriteriaEntry rows (22 high, 5 apart): the remove button
  // (Icons/Minus.png, 16 wide, enabled once the row is used), the condition combo (30%, the conditions by name, the empty
  // one first) and the condition's own controls (CriteriaValue*); choosing a condition on the last row adds an empty row
  // under it. Under them Match (All / Any) and Filter Name (180 wide, MAX_ITEMFILTER_NAME 100), then Save and Close.
  // While it is open its filter applies to the inventories as the temporary filter (FilterSvc.SetTempFilter), let go on
  // closing. Save: CannotSaveBlankFilter without a condition, SaveFilterNoName without a name, SaveFilterPrompt over a
  // filter of that name (not when editing it), the filters kept (PersistFilters), FilterSaved.
  // ImportTypeList (the paste button at the bottom right) and OnDropData (items dropped on the rows) add a Name Is row for
  // each type not already there (_AddTypeIDs), before the empty last row. (Not here: the share button.)
  import { onDestroy, onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { getCategories, getCategoryGroups, getGroupCategories, getTypeMeta, importMultibuy, resolveNames } from "../app/api.ts";
  import { ASSET_ITEM_DRAG_MIME, decodeAssetItemDrag, decodeDrag, DRAG_MIME } from "./dragDrop.ts";
  import { formatTemplate } from "../bridge/clientWords.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import {
    DEFAULT_INVENTORY_FILTERS, FILTER_FIELD as F, FILTER_OP as O, INVENTORY_FILTERS_SETTING, readInventoryFilters, writeInventoryFilters,
    type FilterComparison, type InventoryCondition, type InventoryFilter,
  } from "../bridge/inventoryFilters.ts";

  let { store, flow, filter = null, onClose }: { store: ClientStore; flow: AppFlow; filter?: InventoryFilter | null; onClose: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const P = "UI/Inventory/Filters/";
  const MAX_NAME = 100;
  const word = (label: string, own: string) => plainText($words.templates[label] ?? "") || own;

  // GetFilterTypeComboOptions: the empty choice, then the conditions sorted by their words (Group stands for category and group)
  const CONDITIONS = [
    [F.assembled, "ConditionAssembled", "Assembled"], [F.category, "ConditionGroup", "Group"], [F.slot, "ConditionSlotType", "Slot Type"],
    [F.size, "ConditionStackSize", "Stack Size"], [F.volume, "ConditionVolume", "Volume"], [F.price, "ConditionUnitPrice", "Unit Price"],
    [F.name, "ConditionName", "Name"], [F.metaGroup, "ConditionMetaGroup", "Meta Group"], [F.metaLevel, "ConditionMetaLevel", "Meta Level"],
    [F.power, "ConditionPowerUsage", "Powergrid Usage"], [F.cpu, "ConditionCpuUsage", "CPU Usage"],
    [F.blueprintCopy, "ConditionBlueprintCopy", "Blueprint Copy"], [F.clone, "ConditionCloneState", "Clone State"],
  ] as const;
  const conditionOptions = $derived([...CONDITIONS].map(([id, key, own]) => [id, word(P + key, own)] as const).sort((a, b) => a[1].localeCompare(b[1])));
  const CRIT = {
    [O.is]: ["CritIs", "Is"], [O.isnt]: ["CritIsNot", "Is Not"], [O.less]: ["CritLessThan", "Less Than"], [O.equal]: ["CritEqualTo", "Equal To"],
    [O.greater]: ["CritGreaterThan", "Greater Than"], [O.starts]: ["CritStartsWith", "Starts With"], [O.notStarts]: ["CritNotStartsWith", "Does Not Start With"],
    [O.contains]: ["CritContains", "Contains"], [O.notContains]: ["CritNotContains", "Does Not Contain"],
  } as Readonly<Record<number, readonly [string, string]>>;
  const crit = (op: number) => word(P + CRIT[op]![0], CRIT[op]![1]);
  /** Each condition's criteria, default criterion and default value (CriteriaValueBool / Int / Float / String / Category / Slot / MetaGroup / CloneState). */
  function kind(field: number): { ops: readonly number[]; op: number; value: FilterComparison } {
    if (field === F.assembled || field === F.blueprintCopy) return { ops: [O.is, O.isnt], op: O.isnt, value: true };
    if (field === F.name) return { ops: [O.starts, O.notStarts, O.is, O.isnt, O.contains, O.notContains], op: O.starts, value: "" };
    if (field === F.category || field === F.group || field === F.slot || field === F.metaGroup || field === F.clone) return { ops: [O.is, O.isnt], op: O.is, value: 0 };
    return { ops: [O.less, O.equal, O.greater], op: O.greater, value: 0 };
  }
  const SLOTS = [[11, "SlotLowPower", "Low Power"], [13, "SlotMedPower", "Medium Power"], [12, "SlotHighPower", "High Power"], [2663, "SlotRig", "Rig"]] as const;
  const META = [[1, "Tech I"], [2, "Tech II"], [3, "Storyline"], [4, "Faction"], [5, "Officer"], [6, "Deadspace"], [14, "Tech III"]] as const;

  type Row = { field: number; op: number; value: FilterComparison; category: number };
  // svelte-ignore state_referenced_locally
  let original = $state<string | null>(filter?.[0] ?? null);
  // svelte-ignore state_referenced_locally
  let filterName = $state(filter?.[0] ?? "");
  // svelte-ignore state_referenced_locally
  let match = $state<1 | 2>(filter?.[1] ?? 1);
  // svelte-ignore state_referenced_locally
  let rows = $state<Row[]>([...(filter?.[2] ?? []).map(([field, op, value]): Row => ({ field: field === F.group ? F.category : field, op,
    value: field === F.group || field === F.category ? 0 : value, category: field === F.category ? Number(value) : 0 })), { field: 0, op: 0, value: 0, category: 0 }]);
  let groupOf = $state<Record<number, number>>({});
  // svelte-ignore state_referenced_locally
  for (const [i, [field, , value]] of (filter?.[2] ?? []).entries()) if (field === F.group) groupOf[i] = Number(value);

  let categories = $state<readonly { id: number; nameID: number }[]>([]);
  let groups = $state<ReadonlyMap<number, readonly { id: number; nameID: number }[]>>(new Map());
  let metaNameIDs = $state<ReadonlyMap<number, number | null>>(new Map());
  const optionName = (nameID: number) => plainText($words.templates[`#${nameID}`] ?? "");
  const categoryOptions = $derived(categories.map((c) => [c.id, optionName(c.nameID)] as const).filter(([, n]) => n).sort((a, b) => a[1].localeCompare(b[1])));
  const groupOptions = (category: number) => (groups.get(category) ?? []).map((g) => [g.id, optionName(g.nameID)] as const).filter(([, n]) => n).sort((a, b) => a[1].localeCompare(b[1]));
  const metaOptions = $derived(META.map(([id, own]) => [id, (metaNameIDs.get(id) ? optionName(metaNameIDs.get(id)!) : "") || own] as const).sort((a, b) => a[1].localeCompare(b[1])));

  async function loadGroups(category: number): Promise<void> {
    if (!category || groups.has(category)) return;
    const read = (await getCategoryGroups(category, flow.requestOptions()).catch(() => [])).filter((g) => g.published).map((g) => ({ id: g.groupID, nameID: g.nameID }));
    groups = new Map(groups).set(category, read);
    flow.requestWords(read.map((g) => `#${g.nameID}`));
  }

  onMount(() => {
    flow.requestNames([{ kind: "type" as const, id: 1230 }, { kind: "type" as const, id: 34 }]);
    flow.requestWords([P + "ImportFilterItems", P + "ImportFilterItemsHint", "UI/SkillQueue/CouldNotReadLines", P + "ItemFilterCaption", P + "Match", P + "FilterName", P + "All", P + "Any", "UI/Common/Buttons/Save", "UI/Common/Buttons/Close", "UI/Common/All",
      ...CONDITIONS.map(([, key]) => P + key), ...Object.values(CRIT).map(([key]) => P + key), P + "CritIsTrue", P + "CritIsFalse",
      ...SLOTS.map(([, key]) => P + key), ...DEFAULT_INVENTORY_FILTERS.map(([key]) => key)]);
    void getCategories(flow.requestOptions()).then((rows) => {
      categories = rows.filter((r) => r.published).map((r) => ({ id: r.categoryID, nameID: r.nameID }));
      flow.requestWords(categories.map((c) => `#${c.nameID}`));
    }).catch(() => {});
    void getTypeMeta([], flow.requestOptions()).then((m) => {
      metaNameIDs = m.metaGroupNameIDs;
      flow.requestWords([...m.metaGroupNameIDs.values()].flatMap((id) => (id === null ? [] : [`#${id}`])));
    }).catch(() => {});
    const groupIDs = Object.values(groupOf);
    if (groupIDs.length) flow.requestNames(groupIDs.map((id) => ({ kind: "group" as const, id })));
    // CriteriaValueCategory with a group: its category chosen (evetypes.GetCategoryIDByGroup) and that category's groups listed
    if (groupIDs.length) void getGroupCategories(groupIDs, flow.requestOptions()).then((read) => {
      for (const [i, g] of Object.entries(groupOf)) {
        const category = read.groups[g] ?? null;
        const row = rows[Number(i)];
        if (category && row) { row.category = category; void loadGroups(category); }
      }
    }).catch(() => {});
  });

  /** CriteriaEntry.OnFilterTypeCombo: the condition's controls at their defaults; on the last row, a new empty row under it. */
  function setField(i: number, field: number): void {
    const k = kind(field);
    rows[i] = { field, op: k.op, value: k.value, category: 0 };
    delete groupOf[i];
    if (field > 0 && i === rows.length - 1) rows.push({ field: 0, op: 0, value: 0, category: 0 });
    applyTemp();
  }
  function removeRow(i: number): void {
    if (i === rows.length - 1) return;
    rows.splice(i, 1);
    const next: Record<number, number> = {};
    for (const [k, v] of Object.entries(groupOf)) { const n = Number(k); if (n < i) next[n] = v; else if (n > i) next[n - 1] = v; }
    groupOf = next;
    applyTemp();
  }

  /** GetFilter: each used row's [field, criterion, value] (a group chosen: [ITEM_GROUP, ..., groupID]), with the name and Match. */
  function currentFilter(): InventoryFilter | null {
    const conditions: InventoryCondition[] = [];
    rows.forEach((row, i) => {
      if (!row.field) return;
      if (row.field === F.category) {
        if (groupOf[i]) conditions.push([F.group, row.op, groupOf[i]!]);
        else if (row.category) conditions.push([F.category, row.op, row.category]);
        return;
      }
      if ((row.field === F.slot || row.field === F.metaGroup) && !row.value) return;
      conditions.push([row.field, row.op, row.value]);
    });
    return conditions.length ? [filterName, match, conditions] : null;
  }
  /** _AddTypeIDs: each type's name a [ITEM_NAME, CRIT_IS, name] row unless one is there already, then ApplyFilter. */
  async function addTypes(typeIDs: readonly number[]): Promise<void> {
    const ids = [...new Set(typeIDs)];
    const missing = ids.filter((id) => !resolvedName($names.resolved, "type", id, ""));
    const fetched: Record<string, string | null> = {};
    for (let i = 0; i < missing.length; i += 100) Object.assign(fetched, (await resolveNames(missing.slice(i, i + 100).map((id) => ({ kind: "type" as const, id })), flow.requestOptions()).catch(() => ({ names: {} }))).names);
    for (const id of ids) {
      const name = resolvedName($names.resolved, "type", id, "") || fetched[`type:${id}`] || "";
      if (!name || rows.some((row) => row.field === F.name && row.op === O.is && row.value === name)) continue;
      rows.splice(rows.length - 1, 0, { field: F.name, op: O.is, value: name, category: 0 });
    }
    applyTemp();
  }
  /** ImportTypeList: the clipboard read as a multibuy list, its types added; the lines it could not read in CustomInfo. */
  async function importClipboard(): Promise<void> {
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch { return; }
    if (!text.trim()) return;
    const read = await importMultibuy(text, flow.requestOptions()).catch(() => null);
    if (!read) return;
    await addTypes(read.found.map(([typeID]) => typeID));
    if (read.failedLines.length) flow.sayDialog("CustomInfo", { type: "dict", entries: [["info", `${word("UI/SkillQueue/CouldNotReadLines", "Could not read these lines:")}<br>${read.failedLines.join("<br>")}`]] }, read.failedLines.join("\n"));
  }
  function dropped(e: DragEvent): void {
    const item = decodeDrag(e.dataTransfer?.getData(DRAG_MIME));
    const assets = decodeAssetItemDrag(e.dataTransfer?.getData(ASSET_ITEM_DRAG_MIME));
    const ids = item && "typeID" in item && typeof item.typeID === "number" ? [item.typeID] : assets.map((a) => a.typeID);
    if (!ids.length) return;
    e.preventDefault();
    void addTypes(ids);
  }
  // the paste button's hint: ImportFilterItems, then ImportFilterItemsHint (Veldspar and Tritanium the examples)
  const importHint = $derived.by(() => {
    const hint = $words.templates[P + "ImportFilterItemsHint"];
    const nameOf = (_kind: string, id: unknown) => resolvedName($names.resolved, "type", Number(id), "") || null;
    const tail = typeof hint === "string" && hint ? plainText(formatTemplate(hint, { type1: 1230, type2: 34 }, { nameOf } as never)) : "";
    return `${word(P + "ImportFilterItems", "Import Items")}+${tail ? `\n\n${tail}` : ""}`;
  });
  function applyTemp(): void { dispatchEvent(new CustomEvent("evejs:inventory-temp-filter", { detail: { filter: currentFilter() } })); }
  onDestroy(() => { dispatchEvent(new CustomEvent("evejs:inventory-temp-filter", { detail: { filter: null } })); });

  let busy = $state(false);
  async function save(): Promise<void> {
    const f = currentFilter();
    if (!f) { flow.sayDialog("CannotSaveBlankFilter", null, "You cannot save a blank filter."); return; }
    const name = f[0].trim().slice(0, MAX_NAME);
    if (!name) { flow.sayDialog("SaveFilterNoName", null, "You must give the filter a name."); return; }
    if (busy) return;
    busy = true;
    try {
      const text = await flow.readCharacterSetting(INVENTORY_FILTERS_SETTING);
      const current = text === null ? DEFAULT_INVENTORY_FILTERS.map(([key, own, m, c]) => [word(key, own), m, c] as InventoryFilter) : readInventoryFilters(text);
      const same = (a: string, b: string | null) => b !== null && a.toLowerCase() === b.toLowerCase();
      if (!original && current.some(([n]) => same(n, name)) && !(await flow.askClientDialog("SaveFilterPrompt", "A filter with that name already exists. Do you want to replace it?"))) return;
      const kept = current.filter(([n]) => !same(n, original) && !same(n, name));
      await flow.saveCharacterSetting(INVENTORY_FILTERS_SETTING, writeInventoryFilters([...kept, [name, f[1], f[2]]]));
      original = name;
      filterName = name;
      dispatchEvent(new CustomEvent("evejs:inventory-filters-changed"));
      flow.sayDialog("FilterSaved", null, "The filter has been saved.");
    } catch { /* the save failed; the window stays as it was */ }
    finally { busy = false; }
  }
</script>

<div class="fcw">
  <div class="rows" role="presentation" ondragover={(e) => e.preventDefault()} ondrop={dropped}>
    {#each rows as row, i (i)}
      <div class="crit">
        <button type="button" class="minus" disabled={i === rows.length - 1} aria-label="Remove" style:--minus={`url("${clientTexture("res:/UI/Texture/Icons/Minus.png")}")`} onclick={() => removeRow(i)}></button>
        <select class="ctype" value={row.field} onchange={(e) => setField(i, Number(e.currentTarget.value))}>
          <option value={0}></option>
          {#each conditionOptions as [id, text] (id)}<option value={id}>{text}</option>{/each}
        </select>
        {#if row.field}
          <div class="detail">
            {#if row.field === F.assembled || row.field === F.blueprintCopy}
              <select class="half" value={row.op} onchange={(e) => { row.op = Number(e.currentTarget.value); applyTemp(); }}>
                <option value={O.is}>{word(P + "CritIsTrue", "Is True")}</option><option value={O.isnt}>{word(P + "CritIsFalse", "Is False")}</option>
              </select>
            {:else}
              <select class={row.field === F.category ? "fifth" : "half"} value={row.op} onchange={(e) => { row.op = Number(e.currentTarget.value); applyTemp(); }}>
                {#each kind(row.field).ops as op (op)}<option value={op}>{crit(op)}</option>{/each}
              </select>
              {#if row.field === F.category}
                <select class="twofifths" value={row.category} onchange={(e) => { row.category = Number(e.currentTarget.value); delete groupOf[i]; void loadGroups(row.category); applyTemp(); }}>
                  <option value={0}></option>
                  {#each categoryOptions as [id, text] (id)}<option value={id}>{text}</option>{/each}
                </select>
                <select class="twofifths" value={groupOf[i] ?? 0} onchange={(e) => { const g = Number(e.currentTarget.value); if (g) groupOf[i] = g; else delete groupOf[i]; applyTemp(); }}>
                  <option value={0}>{word("UI/Common/All", "All")}</option>
                  {#if groupOf[i] && !groupOptions(row.category).some(([id]) => id === groupOf[i])}<option value={groupOf[i]}>{resolvedName($names.resolved, "group", groupOf[i]!, String(groupOf[i]))}</option>{/if}
                  {#each groupOptions(row.category) as [id, text] (id)}<option value={id}>{text}</option>{/each}
                </select>
              {:else if row.field === F.slot}
                <select class="half" value={row.value} onchange={(e) => { row.value = Number(e.currentTarget.value); applyTemp(); }}>
                  <option value={0}></option>
                  {#each SLOTS as [id, key, own] (id)}<option value={id}>{word(P + key, own)}</option>{/each}
                </select>
              {:else if row.field === F.metaGroup}
                <select class="half" value={row.value} onchange={(e) => { row.value = Number(e.currentTarget.value); applyTemp(); }}>
                  <option value={0}></option>
                  {#each metaOptions as [id, text] (id)}<option value={id}>{text}</option>{/each}
                </select>
              {:else if row.field === F.clone}
                <select class="half" value={row.value} onchange={(e) => { row.value = Number(e.currentTarget.value); applyTemp(); }}>
                  <option value={0}>Alpha</option><option value={1}>Omega</option>
                </select>
              {:else if row.field === F.name}
                <input class="half" type="text" value={String(row.value)} onchange={(e) => { row.value = e.currentTarget.value; applyTemp(); }} />
              {:else}
                <input class="half" type="number" min="0" step={row.field === F.size || row.field === F.metaLevel ? 1 : "any"} value={String(row.value)}
                  onchange={(e) => { const v = Number(e.currentTarget.value); row.value = Number.isFinite(v) ? (row.field === F.size || row.field === F.metaLevel ? Math.trunc(v) : v) : 0; applyTemp(); }} />
              {/if}
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
  <div class="bottom">
    <div class="opts">
      <span class="small">{word(P + "Match", "Match")}</span>
      <span class="small pad">{word(P + "FilterName", "Filter Name")}</span>
      <div class="radios">
        <label><input type="radio" name="fcw-match" checked={match === 1} onchange={() => { match = 1; applyTemp(); }} />{word(P + "All", "All")}</label>
        <label><input type="radio" name="fcw-match" checked={match === 2} onchange={() => { match = 2; applyTemp(); }} />{word(P + "Any", "Any")}</label>
      </div>
      <input class="name pad" type="text" maxlength={MAX_NAME} bind:value={filterName} />
    </div>
    <div class="buttons">
      <button type="button" class="btn primary" disabled={busy} onclick={() => void save()}>{word("UI/Common/Buttons/Save", "Save")}</button>
      <button type="button" class="btn" onclick={onClose}>{word("UI/Common/Buttons/Close", "Close")}</button>
    </div>
    <button type="button" class="paste" title={importHint} aria-label={word(P + "ImportFilterItems", "Import Items")}
      style:--paste={`url("${clientTexture("res:/UI/Texture/Shared/pasteFrom.png")}")`} onclick={() => void importClipboard()}></button>
  </div>
</div>

<style>
  .fcw { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 8px; box-sizing: border-box; font-size: 12px; color: rgba(255, 255, 255, 0.75); }
  .rows { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 16px; }
  .crit { display: flex; align-items: stretch; height: 22px; margin-bottom: 5px; }
  .minus { flex: none; width: 16px; padding: 0; border: 0; background: var(--minus) center / 9px 9px no-repeat; opacity: 0.75; cursor: pointer; }
  .minus:disabled { opacity: 0.25; cursor: default; }
  .ctype { flex: 0 0 30%; margin-left: 4px; }
  .detail { flex: 1; display: flex; min-width: 0; }
  .detail > * { margin-left: 4px; min-width: 0; }
  .half { flex: 1 1 50%; }
  .fifth { flex: 1 1 20%; }
  .twofifths { flex: 1 1 40%; }
  select, input[type=text], input[type=number] { box-sizing: border-box; height: 22px; background: rgba(0, 0, 0, 0.3); color: rgba(255, 255, 255, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.2); font: inherit; padding: 0 4px; }
  .bottom { flex: none; position: relative; }
  /* importMenu: 32 x 32 at the bottom right, its icon 28 */
  .paste { position: absolute; right: 0; bottom: 0; width: 32px; height: 32px; padding: 0; border: 0; background: var(--paste) center / 28px 28px no-repeat; opacity: 0.75; cursor: pointer; }
  .paste:hover { opacity: 1; }
  .opts { display: grid; grid-template-columns: auto auto; justify-content: center; align-items: center; row-gap: 2px; }
  .small { font-size: 10px; color: rgba(255, 255, 255, 0.5); }
  .pad { margin-left: 32px; }
  .radios { display: flex; gap: 16px; }
  .radios label { display: flex; align-items: center; gap: 4px; white-space: nowrap; cursor: pointer; }
  .radios input { margin: 0; accent-color: rgb(88, 167, 191); }
  .name { width: 180px; }
  .buttons { display: flex; justify-content: center; gap: 8px; margin-top: 16px; }
  .btn { height: 28px; padding: 0 16px; background: rgba(255, 255, 255, 0.08); color: rgba(255, 255, 255, 0.9); border: 1px solid rgba(255, 255, 255, 0.2); font: inherit; cursor: pointer; }
  .btn.primary { background: rgba(88, 167, 191, 0.35); border-color: rgba(88, 167, 191, 0.7); }
  .btn:disabled { opacity: 0.5; cursor: default; }
</style>
