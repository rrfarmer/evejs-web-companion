<script lang="ts">
  import { onMount } from "svelte";
  import { bridgeAsk } from "../app/api.ts";
  import { isSessionLost, type AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { decodeCharacterSkinLicenses, loadCharacterSkinCatalog, type CharacterSkin } from "../bridge/firstPartySkins.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { CHARACTER_SHEET_POINTERS } from "../play/uiPointer.ts";
  import ShipInfoPreview from "./ShipInfoPreview.svelte";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { showInfo } from "./showInfo.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const names = $derived(store.names);
  const words = $derived(store.words);
  const labelRoot = "UI/CharacterSheet/CharacterSheetWindow/";
  const options = [
    { id: "all", key: labelRoot + "Skins/ShowAllSkins", text: "Show all SKINs" },
    { id: "active", key: labelRoot + "Skins/ShowActiveSkins", text: "Only show my SKINs" },
    { id: "inactive", key: labelRoot + "Skins/ShowInactiveSkins", text: "Only show SKINs I don't have" },
  ] as const;
  const labels = { counter: "UI/Skins/YouHaveNumShipSkins", group: labelRoot + "SkinsGroupWithCount",
    active: labelRoot + "Skins/Active", permanent: "UI/Skins/SkinDurationPermanent",
    empty: "UI/SkillQueue/NoResultsForFilters", filter: "UI/Inventory/Filter" };
  type Mode = typeof options[number]["id"];
  function key() { return `evejs.user.${store.session.get().accountID}.characterSheetSkins`; }
  let mode = $state<Mode>("all");
  let filter = $state("");
  let rows = $state.raw<readonly CharacterSkin[]>([]);
  let licenses = $state.raw<Map<number, bigint | null>>(new Map());
  let loading = $state(true);
  let error = $state("");
  let expanded = $state<number | null>(null);
  let preview = $state<{ typeID: number; skin: CharacterSkin } | null>(null);
  let readSequence = 0;

  const word = (label: string, fallback: string, args: TemplateArguments = {}) =>
    plainText(formatTemplate($words.templates[label] || fallback, args, { nameOf: () => "" }));
  const skinName = (skin: CharacterSkin) => plainText($words.templates[`#${skin.nameID}`] || `SKIN ${skin.nameID}`);
  const hullName = (typeID: number) => resolvedName($names.resolved, "type", typeID, `Ship ${typeID}`);
  const compareNames = (a: string, b: string) => a < b ? -1 : Number(a > b);
  const owned = $derived(rows.reduce((count, skin) => count + (licenses.has(skin.skinID) ? skin.types.length : 0), 0));
  const groups = $derived.by(() => {
    const query = filter.trim().toLowerCase();
    const materials = new Map<string, { id: number; name: string; materialID: number; hulls: Map<number, CharacterSkin> }>();
    const prefer = (candidate: CharacterSkin, incumbent: CharacterSkin) => {
      if (!licenses.has(candidate.skinID)) return false;
      if (!licenses.has(incumbent.skinID)) return true;
      const nextExpiry = licenses.get(candidate.skinID), oldExpiry = licenses.get(incumbent.skinID);
      return oldExpiry != null && (nextExpiry == null || nextExpiry > oldExpiry);
    };
    for (const skin of rows) {
      const licensed = licenses.has(skin.skinID);
      if (mode !== "all" && licensed !== (mode === "active")) continue;
      const name = skinName(skin);
      const hulls = skin.types.filter(typeID => typeID !== 33328 &&
        (!query || name.toLowerCase().includes(query) || hullName(typeID).toLowerCase().includes(query)));
      if (!hulls.length) continue;
      let group = materials.get(name);
      if (!group) {
        group = { name, id: skin.nameID, materialID: skin.materialID, hulls: new Map() };
        materials.set(name, group);
      }
      for (const typeID of hulls) {
        const current = group.hulls.get(typeID);
        if (!current || prefer(skin, current)) group.hulls.set(typeID, skin);
      }
    }
    return [...materials.values()].sort((a, b) => compareNames(a.name, b.name));
  });

  async function load() {
    const request = ++readSequence;
    error = "";
    try {
      const [catalog, answer] = await Promise.all([loadCharacterSkinCatalog(),
        bridgeAsk(flow.requestOptions())("shipCosmeticsMgr", "GetLicencedSkins", [])]);
      if (request !== readSequence) return;
      licenses = decodeCharacterSkinLicenses(answer);
      rows = catalog;
      flow.requestWords([...new Set(catalog.map(skin => `#${skin.nameID}`))]);
      flow.requestNames([...new Set(catalog.flatMap(skin => skin.types))].map(id => ({ kind: "type", id })));
    } catch (cause) {
      if (request === readSequence && !isSessionLost(cause)) error = panelErrorWords(cause);
    } finally {
      if (request === readSequence) loading = false;
    }
  }

  function changeMode(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    const picked = options.find(option => option.id === value);
    if (!picked) return;
    mode = picked.id;
    localStorage.setItem(key(), mode);
  }

  onMount(() => {
    const saved = localStorage.getItem(key());
    mode = options.find(option => option.id === saved)?.id ?? "all";
    flow.requestWords([...Object.values(labels), ...options.map(option => option.key)]);
    void load();
    const relevant = () => store.live.get().notifications.findLast(note =>
      note.method === "OnSkinLicenseActivated" || note.method === "OnSkinLicenseRemoved");
    let previous = relevant();
    const stop = store.live.subscribe(() => {
      const latest = relevant();
      if (latest && latest !== previous) void load();
      previous = latest;
    });
    return () => { stop(); readSequence++; };
  });
</script>

<section class="collection" aria-label="SKINs" data-character-skins>
  <div class="controls">
    <label>Show SKINs <select value={mode} onchange={changeMode}>
      {#each options as option (option.id)}<option value={option.id}>{word(option.key, option.text)}</option>{/each}
    </select></label>
    {#if !loading && !error}<span data-skin-counter={owned}>{word(labels.counter, `You have {[numeric]numSkins} ship SKIN${owned === 1 ? "" : "s"}`, { numSkins: owned })}</span>{/if}
    <input type="search" aria-label={word(labels.filter, "Filter")} placeholder={word(labels.filter, "Filter")} bind:value={filter} />
  </div>
  {#if loading}
    <p role="status">Loading SKINs…</p>
  {:else if error}
    <p role="alert">{error}</p>
    <button type="button" onclick={() => { loading = true; void load(); }}>Retry</button>
  {:else if !groups.length}
    <p>{word(labels.empty, "No results for filters")}</p>
  {:else}
    {#each groups as group (group.id)}
      {@const groupOwned = [...group.hulls.values()].filter(skin => licenses.has(skin.skinID)).length}
      <div data-skin-group={group.id}>
        <button type="button" class="group" aria-expanded={expanded === group.id} onclick={() => (expanded = expanded === group.id ? null : group.id)}>
          <img src={clientTexture(`res:/UI/Texture/classes/skins/icons/${group.materialID}.png`)} alt="" loading="lazy" />
          {word(labels.group, "{groupName} [{[numeric]skinsOwned}/{[numeric]skinsTotal}]", { groupName: group.name, skinsOwned: groupOwned, skinsTotal: group.hulls.size })}
        </button>
        {#if expanded === group.id}
          <ul>
            {#each [...group.hulls].sort((a, b) => compareNames(hullName(a[0]), hullName(b[0]))) as [typeID, skin] (typeID)}
              {@const ownedSkin = licenses.has(skin.skinID)}
              {@const expiry = licenses.get(skin.skinID)}
              <li class:unlicensed={!ownedSkin} data-skin-hull={typeID} data-license-active={ownedSkin}>
                <button type="button" onclick={() => showInfo({ kind: "type", typeID })}>{hullName(typeID)}</button>
                {#if ownedSkin}
                  <span>{word(labels.active, "Active")} · {expiry ? formatTemplate("{[datetime]expiry}", { expiry: String(expiry) }, { nameOf: () => "" }) : word(labels.permanent, "Permanent")}</span>
                {/if}
                {#if skin.materialSetID}
                  <button type="button" aria-label={`Preview ${group.name} ${hullName(typeID)}`} onclick={() => (preview = { typeID, skin })}>Preview</button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/each}
  {/if}
  {#if preview}
    <div class="preview" data-character-skin-preview={preview.skin.materialSetID}>
      <div class="controls"><strong>{skinName(preview.skin)} · {hullName(preview.typeID)}</strong>
        <button type="button" onclick={() => (preview = null)}>Close preview</button></div>
      {#key preview}<ShipInfoPreview typeID={preview.typeID} factionID={null} skinMaterialSetID={preview.skin.materialSetID} active expanded />{/key}
    </div>
  {/if}
</section>

<style>
  .collection { padding: 12px 14px; }
  .controls, li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .controls { justify-content: space-between; margin-bottom: 12px; }
  .group { display: flex; gap: 6px; align-items: center; width: 100%; text-align: left; margin: 2px 0; }
  .group img { width: 20px; height: 20px; object-fit: contain; }
  ul { display: grid; gap: 4px; padding: 4px 0 8px 18px; margin: 0; }
  li span { margin-inline-start: auto; }
  li.unlicensed > button:first-child { opacity: .6; }
  .preview { position: sticky; bottom: 0; padding: 8px; background: var(--panel, #182128); }
</style>
