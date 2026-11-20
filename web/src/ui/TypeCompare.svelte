<script lang="ts">
  // The client's Compare Tool (comparisonWindow.py ComparisonWindow, its default vertical view: comparisonGrid.py and
  // comparisonGridRow.py, attributeFields.py): the types compared side by side, a column each headed by the type
  // (TypeHeader: its icon and name, Show Info on a click, a remove button), and under them the attributes any of them
  // shows, in the client's groups for their category, each row the attribute's name and each type's value in the
  // client's colour for best and worst (bridge/typeComparison.ts). A group's header folds its rows away
  // (GroupHeaderRow.OnClick); a required skill's row shows the skill and its level and whether the pilot has it
  // (SkillAttributeField). At the foot: Reset All (ButtonGroup), and the filter (AttributeFilterCont: Show All, Only
  // show if different values, the attributes one by one) with "Filter Active" while it hides any.
  //
  // Types come from the Compare menu and selected Personal Assets rows. An asset column keeps the item ID from
  // its drag node. TypeComparer._check_clear_existing clears columns when the new category differs.
  //
  // Still open: the window's left browser of hulls and hardware, the horizontal view,
  // Copy to Clipboard, a type header's menu, an attribute row's GM menu and the skills its tooltip lists, the attributes'
  // icons, an alpha pilot's clone-grade row; a rare skill book's hint (the page says a book is missing alike).
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { resolvedName } from "../store/names.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { shortWrittenInterval, SHORT_INTERVAL_WORD_LABELS } from "../bridge/timeInterval.ts";
  import { GROUP_NAME_LABELS, SKILL_LEVEL_BY_REQUIRED_SKILL } from "../bridge/dogmaAttributeGroups.ts";
  import {
    ATTRIBUTE_REQUIRED_THERMODYNAMICS,
    ATTRIBUTE_VALUE_LABELS,
    TYPE_THERMODYNAMICS,
    attributeColor,
    attributeValueMarkup,
    attributeValueText,
    attributesByGroup,
    attributesToCompare,
    commonAttributes,
    commonCategory,
    comparableType,
    isComparable,
    requiredLevel,
    standings,
    type AttributeWords,
    type ComparableAttribute,
    type ComparisonTypeData,
    type DogmaAttributeRecord,
  } from "../bridge/typeComparison.ts";
  import LabelText from "./LabelText.svelte";
  import TypeIcon from "./TypeIcon.svelte";
  import { showInfo } from "./showInfo.ts";
  import { ASSET_ITEM_DRAG_MIME, decodeAssetItemDrag } from "./dragDrop.ts";
  import {
    comparisonKey,
    hiddenAttributes,
    onlyShowDifferent,
    placeComparedSubjects,
    setOnlyShowDifferent,
    toggleHiddenAttribute,
    toggleShowAll,
    typeCompareTarget,
    type ComparisonSubject,
  } from "./typeCompare.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const skills = store.skills;
  const requests = typeCompareTarget.requests;

  const WORDS = {
    hint: "UI/Compare/CompareToolHint",
    noAttributes: "UI/Compare/NoAttributesSelected",
    filterAttributes: "UI/Compare/FilterAttributes",
    showAll: "UI/Overview/ShowAll",
    onlyDifferent: "UI/Compare/OnlyShowDifferent",
    filterActive: "UI/Compare/FilterActive",
    resetAll: "UI/Commands/ResetAll",
    cannotCompare: "UI/Compare/CannotCompareThisItem",
    bookMissing: "UI/SkillQueue/SkillBookMissing",
    trained: "UI/InfoWindow/SkillTrainedToRequiredLevel",
    notTrained: "UI/InfoWindow/SkillNotTrainedToRequiredLevel",
    level: "UI/InfoWindow/TechLevelX",
  } as const;

  // The page's own words where the install's are not to hand.
  const OWN: Readonly<Record<string, string>> = {
    [WORDS.hint]: "Drop items here or choose Compare from a type's menu.",
    [WORDS.noAttributes]: "No attributes are shown.",
    [WORDS.filterAttributes]: "Filter",
    [WORDS.showAll]: "Show all",
    [WORDS.onlyDifferent]: "Only those that differ",
    [WORDS.filterActive]: "Filtered",
    [WORDS.resetAll]: "Clear",
    "UI/InfoWindow/ValueAndUnit": "{value} {unit}",
    "UI/Generic/NotAvailableShort": "-",
  };

  onMount(() => {
    flow.requestWords([
      ...Object.values(WORDS),
      ...Object.values(GROUP_NAME_LABELS),
      ...ATTRIBUTE_VALUE_LABELS,
      ...SHORT_INTERVAL_WORD_LABELS,
    ]);
    // A required skill's row says whether the pilot has it (SkillStateIcon): the pilot's skills, where not read yet.
    if (store.skills.get().skills === null) void flow.loadSkills().catch(() => {});
  });

  function word(label: string, args: Readonly<Record<string, string>> = {}): string {
    const template = $words.templates[label];
    const text = typeof template === "string" ? template : OWN[label];
    if (text === undefined) return "";
    return plainText(formatTemplate(text, args, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  }

  function message(messageID: number | null): string {
    const template = messageID === null ? undefined : $words.templates[`#${messageID}`];
    return typeof template === "string" ? plainText(template) : "";
  }

  // What the tool has read: the types and the attributes' records (static), and the cfg's prices.
  let read = $state.raw<{
    readonly types: ReadonlyMap<number, ComparisonTypeData | null>;
    readonly attributes: ReadonlyMap<number, DogmaAttributeRecord | null>;
    readonly unitNameIDs: ReadonlyMap<number, number | null>;
  } | null>(null);
  let prices = $state.raw<ReadonlyMap<number, number | null> | null>(null);
  /** TypeComparer.comparable_types: the types compared, in their order. */
  let compared = $state.raw<readonly ComparisonSubject[]>([]);
  let notice = $state("");
  let pendingReads = $state(0);
  let revision = 0;
  let readWork = Promise.resolve();
  let insertion = $state<string | null>(null);
  /** The groups folded away (GroupHeaderRow.is_expanded false); all open again whenever the rows are made anew. */
  let folded = $state<ReadonlySet<string>>(new Set());
  let filterOpen = $state(false);

  /**
   * add_types: each type asked for that is not compared already and that the tool compares (else said so), after
   * the types compared are cleared where the first added is of another category.
   */
  function addTypes(asked: readonly ComparisonSubject[], before: string | null = null): void {
    if (asked.length === 0) return;
    const requestedRevision = revision;
    pendingReads++;
    readWork = readWork.then(async () => {
      if (requestedRevision !== revision) return;
      notice = "";
      const ids = [...new Set(asked.map(subject => subject.typeID))];
      const [types, cfgPrices] = await Promise.all([flow.comparisonTypes(ids), flow.cfgAveragePrices()]);
      if (requestedRevision !== revision) return;
      if (types === null) {
        notice = "The client's data for these types could not be read.";
        return;
      }
      read = types;
      prices = cfgPrices;
      flow.requestNames(ids.map((typeID) => ({ kind: "type" as const, id: typeID })));
      const accepted = asked.filter(({ typeID }) => {
        if (isComparable(types.types.get(typeID) ?? null)) return true;
        notice = word(WORDS.cannotCompare, { typeID: String(typeID) }) || "That cannot be compared.";
        return false;
      });
      const next = placeComparedSubjects(compared, accepted, before, typeID => types.types.get(typeID)?.categoryID ?? null);
      if (next !== compared) {
        compared = next;
        folded = new Set();
      }
    }).catch(() => {
      if (requestedRevision === revision) notice = "The client's data for these types could not be read.";
    }).finally(() => { pendingReads--; });
  }

  function overComparison(event: DragEvent, before: string | null = null): void {
    if (!event.dataTransfer?.types.includes(ASSET_ITEM_DRAG_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    insertion = before;
  }

  function dropOnComparison(event: DragEvent, before: string | null = null): void {
    if (!event.dataTransfer?.types.includes(ASSET_ITEM_DRAG_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    insertion = null;
    const rows = decodeAssetItemDrag(event.dataTransfer.getData(ASSET_ITEM_DRAG_MIME));
    addTypes(before === null ? rows.slice(0, 20) : rows, before);
  }

  function leaveComparison(event: DragEvent): void {
    if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) insertion = null;
  }

  $effect(() => {
    void $requests;
    const asked = typeCompareTarget.take();
    addTypes(asked.map(typeID => ({ typeID, itemID: null })));
  });

  /** RemoveEntry: the one type taken out. */
  function remove(key: string): void {
    compared = compared.filter(subject => comparisonKey(subject) !== key);
    folded = new Set();
  }

  /** RemoveAllEntries (Reset All): TypeComparer.clear. */
  function resetAll(): void {
    revision++;
    compared = [];
    folded = new Set();
    notice = "";
  }

  const comparables = $derived.by(() => {
    if (read === null) return [];
    const held = read;
    return compared.flatMap((subject) => {
      const type = held.types.get(subject.typeID);
      return type ? [{
        ...comparableType(subject.typeID, type, held.attributes, prices),
        itemID: subject.itemID,
        key: comparisonKey(subject),
      }] : [];
    });
  });
  const marks = $derived(standings(comparables));
  const category = $derived(commonCategory(comparables));
  const shown = $derived(attributesToCompare(comparables, $onlyShowDifferent, $hiddenAttributes));
  const groups = $derived(attributesByGroup(shown, category));
  const filterGroups = $derived(attributesByGroup(commonAttributes(comparables).keys(), category));
  const common = $derived(commonAttributes(comparables));
  const filterActive = $derived($hiddenAttributes.size > 0 || $onlyShowDifferent);
  /** is_compact: five types or more. */
  const compact = $derived(comparables.length >= 5);

  // The rows are made anew when what they show changes (ReconstructCompareEntries): every group open again.
  $effect(() => {
    void $onlyShowDifferent;
    void $hiddenAttributes;
    folded = new Set();
  });

  const attributeWords: AttributeWords = {
    label: (path, args) => word(path, args ?? {}),
    message: (messageID) => message(messageID),
    unitName: (unitID) => message(read?.unitNameIDs.get(unitID) ?? null),
    typeName: (typeID) => resolvedName($names.resolved, "type", typeID, ""),
    groupName: (groupID) => resolvedName($names.resolved, "typeGroup", groupID, ""),
    attribute: (attributeID) => read?.attributes.get(attributeID) ?? null,
    shortInterval: (ticks) => shortWrittenInterval(ticks, $words.templates, "year", "millisecond"),
  };

  function typeName(typeID: number): string {
    return resolvedName($names.resolved, "type", typeID, "—");
  }

  /** The row's attribute name (the first type's that has it: _get_first_attribute). */
  function rowName(attributeID: number): string {
    const attribute = common.get(attributeID);
    return attribute ? message(attribute.record.displayNameID) : "";
  }

  function rowHint(attributeID: number): string | undefined {
    const attribute = common.get(attributeID);
    return (attribute && message(attribute.record.tooltipDescriptionID)) || undefined;
  }

  function valueMarkup(attribute: ComparableAttribute): string {
    const type = read?.types.get(attribute.typeID);
    if (!type || read === null) return "";
    const text = attributeValueText(attribute, type, read.attributes, attributeWords);
    return attributeValueMarkup(text, attributeColor(attribute, marks.get(attribute)));
  }

  /** A required skill's row (SkillAttributeField): the skill and the level the type needs, or null for another row. */
  function skillOf(attribute: ComparableAttribute): { readonly skillTypeID: number; readonly level: number | null } | null {
    const type = read?.types.get(attribute.typeID);
    if (!type || attribute.value === null) return null;
    const levelAttributeID = SKILL_LEVEL_BY_REQUIRED_SKILL.get(attribute.attributeID);
    if (levelAttributeID !== undefined) return { skillTypeID: Math.trunc(attribute.value), level: requiredLevel(type, levelAttributeID) };
    if (attribute.attributeID === ATTRIBUTE_REQUIRED_THERMODYNAMICS) return { skillTypeID: TYPE_THERMODYNAMICS, level: Math.trunc(attribute.value) };
    return null;
  }

  /** SkillStateIcon.GetHint: the book not injected, trained to the level, or not; nothing while the skills are not read. */
  function skillState(skillTypeID: number, level: number | null): "missing" | "trained" | "untrained" | null {
    const held = $skills.skills;
    if (held === null || level === null) return null;
    const skill = held.find((row) => row.typeID === skillTypeID);
    if (!skill) return "missing";
    return skill.level >= level ? "trained" : "untrained";
  }

  function skillHint(state: "missing" | "trained" | "untrained" | null): string | undefined {
    if (state === null) return undefined;
    return word(state === "missing" ? WORDS.bookMissing : state === "trained" ? WORDS.trained : WORDS.notTrained) || undefined;
  }

  /** A value of a type (unitTypeID) is a link to it (type_link): Show Info on a click. */
  const isTypeLink = (attribute: ComparableAttribute): boolean => attribute.record.unitID === 116 && attribute.value !== null;

  function toggleGroup(group: string): void {
    const next = new Set(folded);
    if (next.has(group)) next.delete(group);
    else next.add(group);
    folded = next;
  }

  const showingAll = $derived($hiddenAttributes.size === 0 && !$onlyShowDifferent);
</script>

<section class="type-compare" class:compact aria-label="Compare Tool">
  {#if notice}
    <p class="note">{notice}</p>
  {/if}
  <div class="grid-wrap" role="group" ondragover={(event) => overComparison(event)}
    ondragleave={leaveComparison} ondrop={(event) => dropOnComparison(event)}>
    {#if comparables.length === 0}
      <p class="hint">{pendingReads > 0 ? "Reading…" : word(WORDS.hint)}</p>
    {:else if shown.length === 0}
      <p class="hint">{word(WORDS.noAttributes)}</p>
    {:else}
      <table class="compare-grid">
        <thead>
          <tr>
            <th></th>
            {#each comparables as type (type.key)}
              <th class="type-head" class:insert-before={insertion === type.key} data-item-id={type.itemID}
                ondragover={(event) => overComparison(event, type.key)} ondragleave={leaveComparison}
                ondrop={(event) => dropOnComparison(event, type.key)}>
                <div class="type-head-inner">
                  <button type="button" class="remove" aria-label="Remove {typeName(type.typeID)}" onclick={() => remove(type.key)}>×</button>
                  <button type="button" class="type-button" onclick={() => showInfo({ kind: "type", typeID: type.typeID, itemID: type.itemID ?? undefined })}>
                    <TypeIcon typeID={type.typeID} name={typeName(type.typeID)} size={compact ? "md" : "lg"} />
                    <span class="type-name">{typeName(type.typeID)}</span>
                  </button>
                </div>
              </th>
            {/each}
          </tr>
        </thead>
        {#each groups as [group, attributeIDs] (group)}
          <tbody>
            <tr class="group-row">
              <th colspan={comparables.length + 1}>
                <button type="button" class="group-button" aria-expanded={!folded.has(group)} onclick={() => toggleGroup(group)}>
                  <span class="caret">{folded.has(group) ? "▸" : "▾"}</span>
                  {word(GROUP_NAME_LABELS[group])}
                  {#if folded.has(group)}<span class="count">{attributeIDs.length}</span>{/if}
                </button>
              </th>
            </tr>
            {#if !folded.has(group)}
              {#each attributeIDs as attributeID, row (`${attributeID}:${row}`)}
                <tr class="attribute-row" class:shaded={row % 2 === 1}>
                  <th scope="row" class="attribute-name" title={rowHint(attributeID)}>{rowName(attributeID)}</th>
                  {#each comparables as type (type.key)}
                    {@const attribute = type.attributes.get(attributeID)}
                    {@const skill = attribute ? skillOf(attribute) : null}
                    <td class="value">
                      {#if !attribute}
                        <span class="none">-</span>
                      {:else if skill}
                        {@const state = skillState(skill.skillTypeID, skill.level)}
                        <button type="button" class="skill" title={skillHint(state)} onclick={() => showInfo({ kind: "type", typeID: skill.skillTypeID })}>
                          <span class="skill-state" data-state={state ?? "unknown"} aria-hidden="true">{state === "trained" ? "✓" : state === "untrained" ? "!" : state === "missing" ? "✕" : "·"}</span>
                          {typeName(skill.skillTypeID)}
                          {#if skill.level !== null}<span class="skill-level">{word(WORDS.level, { numLevel: String(skill.level) }) || `Level ${skill.level}`}</span>{/if}
                        </button>
                      {:else if isTypeLink(attribute)}
                        <button type="button" class="type-link" onclick={() => showInfo({ kind: "type", typeID: Math.trunc(attribute.value ?? 0) })}>
                          <span class="markup"><LabelText markup={valueMarkup(attribute)} /></span>
                        </button>
                      {:else}
                        <span class="markup"><LabelText markup={valueMarkup(attribute)} /></span>
                      {/if}
                    </td>
                  {/each}
                </tr>
              {/each}
            {/if}
          </tbody>
        {/each}
      </table>
    {/if}
  </div>
  <footer class="compare-foot">
    <button type="button" onclick={resetAll} disabled={comparables.length === 0}>{word(WORDS.resetAll)}</button>
    <span class="spacer"></span>
    {#if filterActive}<span class="filter-active">{word(WORDS.filterActive)}</span>{/if}
    <div class="filter">
      <button type="button" aria-expanded={filterOpen} onclick={() => (filterOpen = !filterOpen)}>{word(WORDS.filterAttributes)}</button>
      {#if filterOpen}
        <div class="filter-menu" role="menu">
          <p class="filter-caption">{word(WORDS.filterAttributes)}</p>
          <label><input type="checkbox" checked={showingAll} onchange={() => toggleShowAll([...common.keys()])} /> {word(WORDS.showAll)}</label>
          <label><input type="checkbox" checked={$onlyShowDifferent} onchange={(event) => setOnlyShowDifferent((event.currentTarget as HTMLInputElement).checked)} /> {word(WORDS.onlyDifferent)}</label>
          {#each filterGroups as [group, attributeIDs] (group)}
            <p class="filter-group">{word(GROUP_NAME_LABELS[group])}</p>
            {#each attributeIDs as attributeID, n (`${attributeID}:${n}`)}
              <label><input type="checkbox" checked={!$hiddenAttributes.has(attributeID)} onchange={() => toggleHiddenAttribute(attributeID)} /> {rowName(attributeID)}</label>
            {/each}
          {/each}
        </div>
      {/if}
    </div>
  </footer>
</section>

<style>
  .type-compare { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .grid-wrap { flex: 1 1 auto; overflow: auto; padding: 0 1rem; }
  .hint { opacity: 0.7; padding: 2rem 0; text-align: center; }
  .compare-grid { border-collapse: separate; border-spacing: 0; }
  .compare-grid thead th { position: sticky; top: 0; z-index: 1; background: var(--color-panel, #10161c); }
  .compare-grid th, .compare-grid td { padding: 0.35rem 0.5rem; }
  .type-head { vertical-align: top; text-align: right; }
  .type-head.insert-before::after { content: ""; position: absolute; top: 0; right: 0.5rem; height: 1px; width: 2rem; background: linear-gradient(to right, transparent, white); }
  .type-head-inner { display: flex; align-items: flex-start; justify-content: flex-end; gap: 0.25rem; }
  .type-button { display: flex; flex-direction: column; align-items: flex-end; gap: 0.25rem; background: none; border: 0; color: inherit; cursor: pointer; padding: 0; }
  .type-name { max-width: 120px; text-align: right; font-weight: 400; overflow-wrap: anywhere; }
  .compact .type-name { max-width: 90px; }
  .remove { visibility: hidden; background: none; border: 0; color: inherit; cursor: pointer; }
  .type-head:hover .remove, .remove:focus-visible { visibility: visible; }
  .group-row th { text-align: left; padding-top: 1rem; }
  .group-button { background: none; border: 0; color: rgba(255, 255, 255, 0.5); cursor: pointer; font-size: 1rem; padding: 0; }
  .group-button:hover { color: rgba(255, 255, 255, 0.9); }
  .caret { display: inline-block; width: 1.25rem; }
  .count { margin-left: 0.25rem; color: rgba(255, 255, 255, 0.5); }
  .attribute-row.shaded { background: rgba(255, 255, 255, 0.04); }
  .attribute-name { text-align: left; font-weight: 400; max-width: 160px; }
  .value { text-align: right; max-width: 120px; }
  .compact .value { max-width: 90px; }
  .markup { display: inline-block; text-align: left; }
  .none { color: rgba(255, 255, 255, 0.3); }
  .type-link, .skill { background: none; border: 0; color: inherit; cursor: pointer; padding: 0; text-align: right; }
  .skill-state { display: inline-block; width: 1rem; text-align: center; }
  .skill-state[data-state="trained"] { color: #b2f84d; }
  .skill-state[data-state="untrained"] { color: #f39058; }
  .skill-state[data-state="missing"] { color: #e05050; }
  .skill-level { margin-left: 0.25rem; opacity: 0.7; }
  .compare-foot { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 1rem; border-top: 1px solid rgba(255, 255, 255, 0.1); }
  .spacer { flex: 1 1 auto; }
  .filter-active { color: var(--color-accent-bright, #a9d3f0); }
  .filter { position: relative; }
  .filter-menu { position: absolute; right: 0; bottom: 100%; max-height: 600px; overflow: auto; min-width: 16rem; background: var(--color-panel, #10161c); border: 1px solid rgba(255, 255, 255, 0.15); padding: 0.5rem; z-index: 5; }
  .filter-menu label { display: block; padding: 0.15rem 0; white-space: nowrap; }
  .filter-caption { font-weight: 700; margin: 0 0 0.25rem; }
  .filter-group { margin: 0.5rem 0 0.15rem; opacity: 0.7; }
</style>
