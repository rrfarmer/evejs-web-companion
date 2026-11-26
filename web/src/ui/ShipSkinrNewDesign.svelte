<script lang="ts">
  import { getShipTreeCatalogue } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { SKINR_HULL_RULES } from "../bridge/shipSkinrHullRules.ts";
  import { shipTreeFaction, type ShipTreeCatalogue, type ShipTreeHull } from "../bridge/shipTree.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import ShipInfoPreview from "./ShipInfoPreview.svelte";
  import { typeIconUrl } from "./typeIcons.ts";

  let { store, flow, onBack }: { store: ClientStore; flow: AppFlow; onBack: () => void } = $props();
  const { flight, station, names, words } = $derived(store);
  const prefix = "UI/Personalization/ShipSkins/SKINR/Studio/";
  const labels = {
    hull: [prefix + "HullSelection", "Hull Selection"],
    blank: [prefix + "NoComponentsSelected", "No Design Element selected"],
    save: [prefix + "Save", "Save"],
    back: ["UI/Common/Buttons/Back", "Back"],
    search: ["UI/Common/Search", "Search"],
    empty: ["UI/Wallet/WalletWindow/SearchNoResults", "No results"],
  } as const;
  const factions = SKINR_HULL_RULES.factions.flatMap(id => shipTreeFaction(id) ?? []);
  const excluded = new Set(SKINR_HULL_RULES.excluded);
  const subgroupIDs = new Set(Object.values(SKINR_HULL_RULES.subgroups).flat());
  const classOrder = new Map(SKINR_HULL_RULES.classOrder.map((id, index) => [id, index]));
  let catalogue = $state.raw<ShipTreeCatalogue | null>(null);
  let failure = $state("");
  let attempt = $state(0);
  let faction = $state<number | null>(null);
  let query = $state("");
  let chosen = $state<number | null>(null);
  let pickerOverride = $state<boolean | null>(null);
  const requestedPilot = $derived($station.online?.characterID ?? null);
  const hulls = $derived(catalogue?.ships.filter(row => !row.academy) ?? []);
  const active = $derived(hulls.find(row => row.typeID === $flight.status?.shipTypeID && !excluded.has(row.typeID)));
  const defaultHull = $derived(active?.typeID ?? SKINR_HULL_RULES.fallbackByRace[$station.online?.raceID ?? 0] ?? null);
  const selected = $derived(hulls.find(row => row.typeID === (chosen ?? defaultHull)));
  const pickerOpen = $derived(pickerOverride ?? !active);
  const search = $derived(query.trim().toLocaleLowerCase());
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
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

  $effect(() => {
    void attempt;
    failure = "";
    if (!requestedPilot) return;
    let current = true;
    flow.requestWords(Object.values(labels).map(([path]) => path));
    flow.requestNames(factions.map(({ id }) => ({ kind: "faction", id })));
    void getShipTreeCatalogue(flow.requestOptions()).then(data => {
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
    }).catch(cause => { if (current) failure = panelErrorWords(cause); });
    return () => { current = false; };
  });
</script>

{#snippet hullButton(hull: ShipTreeHull)}
  {@const icon = typeIconUrl(hull.typeID)}
  <button type="button" class="hull" data-hull={hull.typeID} aria-pressed={selected?.typeID === hull.typeID}
    disabled={excluded.has(hull.typeID)} onclick={() => chosen = hull.typeID}>
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
    <button type="button" onclick={onBack}>{word("back")}</button>
    {#if catalogue}
      <button type="button" aria-expanded={pickerOpen} onclick={() => pickerOverride = !pickerOpen}>{word("hull")}</button>
      <button type="button" disabled aria-describedby="skinr-blank">{word("save")}</button>
      <span id="skinr-blank">{word("blank")}</span>
    {/if}
  </div>
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
      {#if selected}
        <section class="hull-preview" data-preview-hull={selected.typeID} aria-label={hullName(selected)}>
          <h3>{hullName(selected)}</h3>
          <div class="preview-scene">
            <ShipInfoPreview typeID={selected.typeID} factionID={selected.factionID} active expanded={false} />
          </div>
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
  @container (max-width: 520px) {
    .hull-layout.with-picker { grid-template-columns: 1fr; }
    .hull-results { max-height: 220px; }
    .preview-scene { height: 250px; }
  }
</style>
