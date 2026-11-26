<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { getShipTreeCatalogue } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { SHIP_SKINR_LINE_NAME_MAX, SHIP_SKINR_NAME_MAX, validShipSkinrName,
    type ShipSkinrDesign, type ShipSkinrEntry } from "../bridge/shipSkinr.ts";
  import { coatingFits, shipSkinrCoatingID, shipSkinrCoatingSlot, shipSkinrCoatingMaterials, shipSkinrLayoutSlots, shipSkinrSlotID,
    type ShipSkinrCoating, type ShipSkinrCoatingCatalogue } from "../bridge/shipSkinrCoatings.ts";
  import { SKINR_HULL_RULES } from "../bridge/shipSkinrHullRules.ts";
  import { shipTreeFaction, type ShipTreeCatalogue, type ShipTreeHull } from "../bridge/shipTree.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import ShipInfoPreview from "./ShipInfoPreview.svelte";
  import { typeIconUrl } from "./typeIcons.ts";

  let { store, flow, atSaveLimit, saveLimit, saved, onBack, onSaved, registerBeforeClose }: {
    store: ClientStore; flow: AppFlow; atSaveLimit: boolean; saveLimit: string;
    saved: { entry: ShipSkinrEntry; design: ShipSkinrDesign } | null;
    onBack: () => void; onSaved: (entry: ShipSkinrEntry) => void;
    registerBeforeClose?: (guard: () => Promise<boolean>) => () => void;
  } = $props();
  const original = untrack(() => saved);
  const initialSlots = shipSkinrLayoutSlots(original?.design.layout);
  const { flight, station, names, words } = $derived(store);
  const prefix = "UI/Personalization/ShipSkins/SKINR/Studio/";
  const labels = {
    hull: [prefix + "HullSelection", "Hull Selection"],
    blank: [prefix + "NoComponentsSelected", "No Design Element selected"],
    save: [prefix + "Save", "Save"],
    saveDesign: [prefix + "SaveDesign", "Save Design"],
    saveAs: [prefix + "SaveAs", "Save As"],
    saveAsNew: [prefix + "SaveAsNew", "Save as new design"],
    name: [prefix + "SKINName", "SKIN Name"],
    line: [prefix + "SKINLineNameOptional", "SKIN Line Name (optional)"],
    cancel: ["UI/Common/Buttons/Cancel", "Cancel"],
    remove: ["UI/Common/Buttons/Remove", "Remove"],
    back: ["UI/Common/Buttons/Back", "Back"],
    search: ["UI/Common/Search", "Search"],
    empty: ["UI/Wallet/WalletWindow/SearchNoResults", "No results"],
  } as const;
  const factions = SKINR_HULL_RULES.factions.flatMap(id => shipTreeFaction(id) ?? []);
  const excluded = new Set(SKINR_HULL_RULES.excluded);
  const subgroupIDs = new Set(Object.values(SKINR_HULL_RULES.subgroups).flat());
  const classOrder = new Map(SKINR_HULL_RULES.classOrder.map((id, index) => [id, index]));
  let catalogue = $state.raw<ShipTreeCatalogue | null>(null);
  let coatings = $state.raw<ShipSkinrCoatingCatalogue | null>(null);
  let layoutSlots = $state.raw(initialSlots);
  let selectedSlot = $state<number | null>(null);
  let coatingSearch = $state("");
  let naming = $state<"save" | "copy" | null>(null);
  let name = $state("");
  let line = $state("");
  let saving = $state(false);
  let saveError = $state("");
  let destroyed = false;
  let leaveDecision: Promise<boolean> | null = null;
  let failure = $state("");
  let attempt = $state(0);
  let faction = $state<number | null>(null);
  let query = $state("");
  let chosen = $state<number | null>(original?.design.shipTypeID ?? null);
  let pickerOverride = $state<boolean | null>(null);
  const requestedPilot = $derived($station.online?.characterID ?? null);
  const hulls = $derived(catalogue?.ships.filter(row => !row.academy) ?? []);
  const active = $derived(hulls.find(row => row.typeID === $flight.status?.shipTypeID && !excluded.has(row.typeID)));
  const defaultHull = $derived(active?.typeID ?? SKINR_HULL_RULES.fallbackByRace[$station.online?.raceID ?? 0] ?? null);
  const selectedTypeID = $derived(chosen ?? defaultHull);
  const selected = $derived(hulls.find(row => row.typeID === selectedTypeID));
  const configurationFor = (typeID: number) => coatings?.configurations.find(config => config.allHulls || config.hulls.includes(typeID));
  const configuration = $derived(selectedTypeID ? configurationFor(selectedTypeID) : null);
  const coatingSlots = $derived(coatings?.slots.filter(slot => configuration?.slots.includes(slot.id)) ?? []);
  const slot = $derived(coatingSlots.find(row => row.id === selectedSlot));
  const coatingIndex = $derived(new Map(coatings?.components.map(coating => [coating.id, coating])));
  const fitted = $derived.by(() => {
    const result = new Map<number, ShipSkinrCoating>();
    for (const [id, row] of layoutSlots) {
      const coating = coatingIndex.get(shipSkinrCoatingID(row) ?? 0);
      if (coating) result.set(id, coating);
    }
    return result;
  });
  const materialNames = $derived(shipSkinrCoatingMaterials(coatings?.areas[selected?.factionID ?? 0] ?? coatings?.areas[500003] ?? [], fitted));
  const dirty = $derived(original ? selectedTypeID !== original.design.shipTypeID || layoutSlots.size !== initialSlots.size ||
    [...layoutSlots].some(([id, row]) => row !== initialSlots.get(id)) : layoutSlots.size > 0);
  const canSave = $derived(layoutSlots.size > 0 && (!!original || !atSaveLimit));
  const validName = $derived(validShipSkinrName(name, line));
  const pickerOpen = $derived(pickerOverride ?? !active);
  const search = $derived(query.trim().toLocaleLowerCase());
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const message = (id: number) => plainText($words.templates[`#${id}`] ?? "");
  const coatingChoices = $derived(slot ? coatings?.components.filter(coating => coatingFits(slot, coating) &&
    message(coating.nameID).toLocaleLowerCase().includes(coatingSearch.trim().toLocaleLowerCase())) ?? [] : []);
  const className = (id: number) => {
    const messageID = catalogue?.classes[id]?.nameID;
    return messageID ? plainText($words.templates[`#${messageID}`] ?? "") : "";
  };
  const hullName = (row: ShipTreeHull) => {
    const label = row.nameID ? $words.templates[`#${row.nameID}`] : null;
    return label ? plainText(label) : resolvedName($names.resolved, "type", row.typeID, String(row.typeID));
  };
  const filtered = $derived(hulls.filter(row => search ? hullName(row).toLocaleLowerCase().includes(search) :
    faction === null || row.factionID === faction));
  const hullsByGroup = $derived.by(() => {
    const groups = new Map<number, ShipTreeHull[]>();
    for (const hull of filtered) {
      const group = groups.get(hull.shipGroupID) ?? [];
      group.push(hull);
      groups.set(hull.shipGroupID, group);
    }
    return groups;
  });
  const groups = $derived([...new Set([...hullsByGroup.keys(), ...Object.keys(SKINR_HULL_RULES.subgroups).map(Number)])]
    .filter(id => !subgroupIDs.has(id))
    .sort((a, b) => (classOrder.get(a) ?? Infinity) - (classOrder.get(b) ?? Infinity) || className(a).localeCompare(className(b))));

  onDestroy(() => { destroyed = true; });
  $effect(() => registerBeforeClose?.(canLeave));

  function canLeave(): Promise<boolean> {
    if (saving) return Promise.resolve(false);
    if (!dirty) return Promise.resolve(true);
    leaveDecision ??= flow.askClientDialogWith("SKINRUnsavedDesign", {}, "Discard the unsaved design?")
      .finally(() => { leaveDecision = null; });
    return leaveDecision;
  }

  async function back() {
    if (await canLeave() && !destroyed) onBack();
  }

  function chooseHull(typeID: number) {
    if (typeID === selectedTypeID || saving || naming) return;
    const next = configurationFor(typeID);
    layoutSlots = new Map([...layoutSlots].filter(([slotID]) => next?.slots.includes(slotID)));
    if (selectedSlot && !next?.slots.includes(selectedSlot)) selectedSlot = null;
    chosen = typeID;
  }

  function fit(coating: ShipSkinrCoating | null) {
    if (!slot || naming) return;
    const next = new Map(layoutSlots);
    const initial = initialSlots.get(slot.id);
    if (coating && shipSkinrCoatingID(next.get(slot.id)) === coating.id) return;
    if (coating) next.set(slot.id, initial && shipSkinrCoatingID(initial) === coating.id ? initial : shipSkinrCoatingSlot(slot.id, coating.id));
    else next.delete(slot.id);
    layoutSlots = next;
  }

  function openName(mode: "save" | "copy") {
    name = original?.design.name ?? "";
    line = original?.design.lineName ?? "";
    saveError = "";
    naming = mode;
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const id = naming === "save" ? original?.entry.id : undefined;
    if (!selectedTypeID || !configuration || !canSave || (!id && atSaveLimit) || saving || !validName || !naming) return;
    saving = true;
    saveError = "";
    try {
      const layout = {
        ...original?.design.layout,
        ship_type: { sequential: selectedTypeID },
        pattern_blend_mode: original?.design.layout.pattern_blend_mode ?? 1,
        slots: [...layoutSlots.values()],
      };
      const editor = original?.entry.editorConfigurations.filter(row => configuration.slots.includes(shipSkinrSlotID(row))) ??
        configuration.slots.filter(id => id === 5 || id === 7).map(id => ({
        id: { sequential: id }, config: { offset_u_ratio: 0, offset_v_ratio: 0, yaw: 0, pitch: 0, roll: 0, scaling: 0 },
      }));
      const entry = await flow.saveShipSkinrDraft(layout, editor, name, line, id);
      if (!destroyed) onSaved(entry);
    } catch (cause) {
      if (!destroyed) saveError = panelErrorWords(cause);
    } finally {
      if (!destroyed) saving = false;
    }
  }

  $effect(() => {
    void attempt;
    failure = "";
    if (!requestedPilot) return;
    let current = true;
    flow.requestWords(Object.values(labels).map(([path]) => path));
    flow.requestNames(factions.map(({ id }) => ({ kind: "faction", id })));
    void Promise.all([getShipTreeCatalogue(flow.requestOptions()), import("../bridge/shipSkinrCoatingsData.ts")]).then(([data, skinr]) => {
      if (!current) return;
      if (!data) {
        failure = "Hull catalogue unavailable.";
        return;
      }
      const messageIDs = new Set([
        ...data.ships.map(row => row.nameID),
        ...Object.values(data.classes).map(row => row.nameID),
      ]);
      flow.requestWords([...messageIDs].flatMap(id => id ? [`#${id}`] : []));
      flow.requestNames(data.ships.filter(row => !row.nameID).map(row => ({ kind: "type", id: row.typeID })));
      catalogue = data;
      coatings = skinr.SHIP_SKINR_COATINGS;
      flow.requestWords([...coatings.slots, ...coatings.components].map(row => `#${row.nameID}`));
    }).catch(cause => { if (current) failure = panelErrorWords(cause); });
    return () => { current = false; };
  });
</script>

{#snippet hullButton(hull: ShipTreeHull)}
  {@const icon = typeIconUrl(hull.typeID)}
  <button type="button" class="hull" data-hull={hull.typeID} aria-pressed={selected?.typeID === hull.typeID}
    disabled={excluded.has(hull.typeID) || !!naming} onclick={() => chooseHull(hull.typeID)}>
    {#if icon}<img src={icon} alt="" width="24" height="24" loading="lazy" />{/if}
    {hullName(hull)}
  </button>
{/snippet}

{#snippet groupBranch(id: number)}
  {@const rows = hullsByGroup.get(id) ?? []}
  {@const children = (SKINR_HULL_RULES.subgroups[id] ?? []).filter(child => hullsByGroup.has(child))}
  {#if rows.length || children.length}
    <details>
      <summary>{className(id) || "Ships"}</summary>
      {#each rows as hull (hull.typeID)}{@render hullButton(hull)}{/each}
      {#each children as child (child)}{@render groupBranch(child)}{/each}
    </details>
  {/if}
{/snippet}

<div class="skinr-designer">
  <div class="designer-toolbar">
    <button type="button" disabled={saving} onclick={() => void back()}>{word("back")}</button>
    {#if catalogue}
      <button type="button" aria-expanded={pickerOpen} onclick={() => pickerOverride = !pickerOpen}>{word("hull")}</button>
      <button type="button" disabled={!canSave || !!naming} aria-describedby={!canSave ? "skinr-blank" : undefined}
        onclick={() => openName("save")}>{word("save")}</button>
      {#if original}
        <button type="button" disabled={!canSave || atSaveLimit || !!naming} aria-describedby={atSaveLimit ? "skinr-blank" : undefined}
          onclick={() => openName("copy")}>{word("saveAs")}</button>
      {/if}
      {#if atSaveLimit || !layoutSlots.size}<span id="skinr-blank">{!layoutSlots.size ? word("blank") : saveLimit}</span>{/if}
    {/if}
  </div>
  {#if naming}
    <form class="skinr-name" aria-labelledby="skinr-name-title" onsubmit={save}>
      <h3 id="skinr-name-title">{word(naming === "copy" ? "saveAsNew" : "saveDesign")}</h3>
      <label>{word("name")} <input bind:value={name} required disabled={saving} /></label>
      <label>{word("line")} <input bind:value={line} disabled={saving} /></label>
      {#if [...name].length > SHIP_SKINR_NAME_MAX || [...line].length > SHIP_SKINR_LINE_NAME_MAX}
        <p role="alert">Use up to {SHIP_SKINR_NAME_MAX} characters for the name and {SHIP_SKINR_LINE_NAME_MAX} for the line name.</p>
      {/if}
      {#if saveError}<p role="alert">{saveError}</p>{/if}
      <div class="designer-toolbar">
        <button type="submit" disabled={saving || !validName || (!original || naming === "copy") && atSaveLimit}>{word("save")}</button>
        <button type="button" disabled={saving} onclick={() => naming = null}>{word("cancel")}</button>
      </div>
    </form>
  {/if}
  {#if failure}
    <p role="alert">{failure}</p>
    <button type="button" onclick={() => attempt++}>Retry</button>
  {:else if !catalogue}
    <p role="status">Loading hulls…</p>
  {:else}
    <div class="hull-layout" class:with-picker={pickerOpen}>
      {#if pickerOpen}
        <section class="hull-picker" aria-label={word("hull")}>
          <h3>{word("hull")}</h3>
          <input type="search" aria-label={word("search")} placeholder={word("search")} bind:value={query} />
          {#if !search}
            <label>Faction
              <select bind:value={faction}>
                <option value={null}>All factions</option>
                {#each factions as owner (owner.id)}
                  <option value={owner.id}>{resolvedName($names.resolved, "faction", owner.id, owner.name)}</option>
                {/each}
              </select>
            </label>
          {/if}
          <div class="hull-results">
            {#if !filtered.length}
              <p>{word("empty")}</p>
            {:else if search}
              {#each filtered as hull (hull.typeID)}{@render hullButton(hull)}{/each}
            {:else}
              {#each groups as id (id)}{@render groupBranch(id)}{/each}
            {/if}
          </div>
        </section>
      {/if}
      {#if selectedTypeID}
        {@const selectedName = selected ? hullName(selected) : resolvedName($names.resolved, "type", selectedTypeID, String(selectedTypeID))}
        <section class="hull-preview" data-preview-hull={selectedTypeID} aria-label={selectedName}>
          <h3>{selectedName}</h3>
          <div class="preview-scene">
            <ShipInfoPreview typeID={selectedTypeID} factionID={selected?.factionID ?? null} coatings={materialNames} active expanded={false} />
          </div>
          <div class="coating-slots" aria-label="Coating slots">
            {#each coatingSlots as row (row.id)}
              {@const componentID = shipSkinrCoatingID(layoutSlots.get(row.id))}
              {@const coating = fitted.get(row.id)}
              <button type="button" data-slot={row.id} aria-pressed={selectedSlot === row.id} disabled={!!naming}
                onclick={() => { selectedSlot = selectedSlot === row.id ? null : row.id; coatingSearch = ""; }}>
                {message(row.nameID)}
                {#if componentID}<small>{coating ? message(coating.nameID) : `Coating #${componentID}`}</small>{/if}
              </button>
            {/each}
          </div>
          {#if slot && !naming}
            <section class="coating-picker" aria-label={message(slot.nameID)}>
              <header>
                <h3>{message(slot.nameID)}</h3>
                {#if layoutSlots.has(slot.id)}<button type="button" onclick={() => fit(null)}>{word("remove")}</button>{/if}
              </header>
              <input type="search" aria-label={word("search")} placeholder={word("search")} bind:value={coatingSearch} />
              <div class="coating-results">
                {#each coatingChoices as coating (coating.id)}
                  <button type="button" data-coating={coating.id} aria-pressed={fitted.get(slot.id)?.id === coating.id} onclick={() => fit(coating)}>
                    <span class="swatch" style:background-color={coating.swatch}></span>
                    {message(coating.nameID)}
                  </button>
                {:else}
                  <p>{word("empty")}</p>
                {/each}
              </div>
            </section>
          {/if}
        </section>
      {/if}
    </div>
  {/if}
</div>

<style>
  h3, p { margin: 0; }
  .skinr-designer, .hull-layout { display: grid; gap: 12px; }
  .skinr-designer { container-type: inline-size; }
  .designer-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .designer-toolbar span { color: #b8c3cc; }
  .skinr-name, .coating-picker { display: grid; gap: 10px; padding: 12px; background: #ffffff08; }
  .skinr-name label { display: grid; gap: 4px; max-width: 400px; }
  .hull-layout.with-picker { grid-template-columns: minmax(190px, 1fr) minmax(230px, 2fr); }
  .hull-picker, .hull-preview { display: grid; align-content: start; gap: 10px; min-width: 0; padding: 12px; background: #ffffff08; }
  .hull-picker input { width: 100%; }
  .hull-picker label { display: grid; gap: 4px; }
  .hull-results { max-height: 400px; overflow: auto; }
  details { padding-inline-start: 8px; }
  summary { padding-block: 5px; cursor: pointer; }
  .hull { display: flex; align-items: center; gap: 8px; margin-block: 3px; width: 100%; text-align: left; }
  .hull[aria-pressed="true"] { border-color: #94b8c2; }
  .preview-scene { height: 400px; }
  .coating-slots { display: flex; flex-wrap: wrap; gap: 6px; }
  .coating-slots button { display: grid; gap: 3px; text-align: left; padding: 6px 8px; }
  .coating-slots small { color: #b8c3cc; }
  .coating-picker header { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .coating-results { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); gap: 5px; max-height: 220px; overflow: auto; }
  .coating-results button { display: flex; text-align: left; align-items: center; gap: 6px; }
  .coating-slots [aria-pressed="true"], .coating-results [aria-pressed="true"] { border-color: #94b8c2; }
  .swatch { flex: none; width: 15px; height: 15px; border: 1px solid #ffffff48; }
  @container (max-width: 520px) {
    .hull-layout.with-picker { grid-template-columns: 1fr; }
    .hull-results { max-height: 220px; }
    .preview-scene { height: 250px; }
  }
</style>
