<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { TypeMetaFacts } from "../app/api.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { SourcedFitting } from "../bridge/sharedFittings.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import ImportFittings from "./ImportFittings.svelte";
  import TypeIcon from "./TypeIcon.svelte";
  import { showInfo } from "./showInfo.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const fittings = $derived(flow.savedFittings);
  const permissions = $derived(flow.fittingsDeletable);
  const maxShips = $derived(flow.maxShipsToFit);
  const station = $derived(store.station);
  const identity = $derived(store.session);
  const names = $derived(store.names);
  const words = $derived(store.words);
  const prefix = "UI/Fitting/FittingWindow/FittingManagement/";
  const labels = {
    PersonalFittings: "Personal Fittings", CorporationFittings: "Corporation Fittings", AllianceFittings: "Alliance Fittings",
    NoFittingSelected: "No fitting selected", ImportFromFile: "Import from File", ImportFromClipboard: "Import from Clipboard",
    DeleteFitting: "Delete Fitting", OpenMultifit: "Multifit",
  };
  const word = (label: keyof typeof labels) => plainText($words.templates[prefix + label] || labels[label]);
  const typeName = (id: number) => resolvedName($names.resolved, "type", id, "…");
  const docked = $derived($station.online?.stationID != null || $station.online?.structureID != null);

  type Owner = "personal" | "corporation" | "alliance";
  const ownerIDs = $derived({
    personal: $station.online?.characterID,
    corporation: $station.online?.corporationID,
    alliance: $station.online?.allianceID,
  });
  const preferenceKey = $derived(`evejs.user.${$identity.accountID ?? 0}.savedFittingsCombo`);
  let owner = $state<Owner>("personal");
  let query = $state("");
  let opened = $state<Record<string, boolean>>({});
  let searchOpened = $state<Record<string, boolean>>({});
  const searching = $derived(query.length > 0);
  let selectedID = $state<number | null>(null);
  let importing = $state(false);
  let busy = $state(false);
  let error = $state("");
  let info = $state.raw<Awaited<ReturnType<AppFlow["fittingInfo"]>> | null>(null);
  let hullFacts = $state.raw<ReadonlyMap<number, TypeMetaFacts | null> | null>(null);
  const list = $derived(($fittings ?? []).filter(fit => fit.source === owner &&
    (plainText(fit.name).toLowerCase().includes(query.toLowerCase()) || typeName(fit.shipTypeID).toLowerCase().includes(query.toLowerCase())))
    .sort((a, b) => plainText(a.name).localeCompare(plainText(b.name))));
  const selected = $derived(list.find(fit => fit.fittingID === selectedID) ?? null);
  const canDelete = $derived(owner === "personal" || $permissions[owner === "alliance" ? "alliance" : "corporation"]);
  const structureFit = $derived(selected !== null && hullFacts?.get(selected.shipTypeID)?.categoryID === 65);

  const tree = $derived.by(() => {
    const groups = new Map<number, Map<number, SourcedFitting[]>>();
    for (const fit of list) {
      const groupID = hullFacts?.get(fit.shipTypeID)?.groupID ?? 0;
      let hulls = groups.get(groupID);
      if (!hulls) groups.set(groupID, hulls = new Map());
      let rows = hulls.get(fit.shipTypeID);
      if (!rows) hulls.set(fit.shipTypeID, rows = []);
      rows.push(fit);
    }
    return [...groups].map(([id, hulls]) => ({
      id,
      name: id ? resolvedName($names.resolved, "group", id, "…") : "Unknown ship group",
      hulls: [...hulls].map(([typeID, rows]) => ({ typeID, name: typeName(typeID), rows }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    })).sort((a, b) => a.name.localeCompare(b.name));
  });

  $effect(() => {
    let remembered = 0;
    try { remembered = Number(localStorage.getItem(preferenceKey)); } catch { /* Uses Personal. */ }
    owner = remembered && remembered === ownerIDs.corporation ? "corporation"
      : remembered && remembered === ownerIDs.alliance ? "alliance" : "personal";
  });

  function changeOwner(next: Owner) {
    owner = next;
    selectedID = null;
    error = "";
    const id = ownerIDs[next];
    try { if (id) localStorage.setItem(preferenceKey, String(id)); } catch { /* Lasts the window. */ }
  }

  function branchOpen(id: string): boolean {
    return searching ? searchOpened[id] ?? true : opened[id] ?? false;
  }

  function branchChanged(id: string, expanded: boolean) {
    if (expanded === branchOpen(id)) return;
    if (searching) searchOpened[id] = expanded;
    else opened[id] = expanded;
  }

  function collapseAll() {
    opened = {};
    searchOpened = Object.fromEntries(tree.flatMap(group => [
      [`group:${group.id}`, false],
      ...group.hulls.map(hull => [`hull:${hull.typeID}`, false]),
    ]));
  }

  async function run(action: () => Promise<unknown>): Promise<void> {
    busy = true;
    error = "";
    try { await action(); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }

  onMount(() => {
    flow.requestWords([...Object.keys(labels).map(label => prefix + label), "UI/Common/Buttons/CollapseAll"]);
    void run(() => flow.loadSavedFittings());
  });

  $effect(() => {
    const hulls = new Set(($fittings ?? []).map(fit => fit.shipTypeID));
    if (!hulls.size) return;
    let current = true;
    flow.requestNames([...hulls].map(id => ({ kind: "type", id })));
    void flow.typeFacts([...hulls]).then(facts => {
      if (!current || facts === null) return;
      hullFacts = facts;
      const groupIDs = new Set([...facts.values()].flatMap(fact => fact?.groupID ? [fact.groupID] : []));
      flow.requestNames([...groupIDs].map(id => ({ kind: "group", id })));
    }).catch(() => {});
    return () => { current = false; };
  });

  $effect(() => {
    const fit = selected;
    info = null;
    if (!fit) return;
    let current = true;
    flow.requestNames([fit.shipTypeID, ...fit.modules.map(module => module.typeID)].map(id => ({ kind: "type", id })));
    void flow.fittingInfo(fit).then(contents => {
      if (!current) return;
      info = contents;
      for (const group of contents.contents) {
        const label = "label" in group.header ? group.header.label : contents.effectNames[group.header.effectID];
        if (label) flow.requestWords([typeof label === "number" ? `#${label}` : label]);
      }
    }).catch(cause => { if (current) error = String(cause); });
    return () => { current = false; };
  });

  function select(fit: SourcedFitting) {
    selectedID = fit.fittingID;
    error = "";
  }

  function clipboardImport() {
    return run(async () => {
      const text = await navigator.clipboard.readText().catch(() => null);
      await flow.importFittingFromClipboard(text);
    });
  }
</script>

<div class="fitting-management">
  <aside aria-label="Saved fittings">
    <select aria-label="Fitting library" value={owner} onchange={(event) => changeOwner(event.currentTarget.value as Owner)}>
      <option value="personal">{word("PersonalFittings")}</option>
      <option value="corporation">{word("CorporationFittings")}</option>
      {#if $station.online?.allianceID}<option value="alliance">{word("AllianceFittings")}</option>{/if}
    </select>
    <input type="search" aria-label="Search fittings" placeholder="Search fittings" maxlength="40" value={query}
      oninput={(event) => { query = event.currentTarget.value; searchOpened = {}; }} />
    <div class="fit-management-import">
      <button type="button" onclick={() => (importing = true)}>{word("ImportFromFile")}</button>
      <button type="button" disabled={busy} onclick={() => void clipboardImport()}>{word("ImportFromClipboard")}</button>
      <button type="button" disabled={!tree.length} onclick={collapseAll}>{plainText($words.templates["UI/Common/Buttons/CollapseAll"] || "Collapse All")}</button>
    </div>
    {#if $fittings === null && busy}<p role="status">Reading saved fittings…</p>{/if}
    {#each tree as group (group.id)}
      {@const groupKey = `group:${group.id}`}
      <details class="fit-management-group" open={branchOpen(groupKey)} ontoggle={(event) => branchChanged(groupKey, event.currentTarget.open)}>
        <summary>{group.name}</summary>
        {#each group.hulls as hull (hull.typeID)}
          {@const hullKey = `hull:${hull.typeID}`}
          <details class="fit-management-type" open={branchOpen(hullKey)} ontoggle={(event) => branchChanged(hullKey, event.currentTarget.open)}>
            <summary>{hull.name}</summary>
            {#each hull.rows as fit (fit.fittingID)}
              <button type="button" class="fit-management-item" aria-pressed={selected?.fittingID === fit.fittingID} onclick={() => select(fit)}>
                {plainText(fit.name)}
              </button>
            {/each}
          </details>
        {/each}
      </details>
    {:else}
      {#if $fittings !== null}<p>No matching fittings.</p>{/if}
    {/each}
  </aside>
  <section class="fit-management-preview" aria-label="Fitting details">
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if selected}
      {@const fit = selected}
      <h2>{plainText(fit.name)}</h2>
      <button type="button" class="fit-management-hull" onclick={() => showInfo({ kind: "type", typeID: fit.shipTypeID })}>
        <TypeIcon typeID={fit.shipTypeID} name={typeName(fit.shipTypeID)} />{typeName(fit.shipTypeID)}
      </button>
      {#if fit.description}<p>{plainText(fit.description)}</p>{/if}
      {#if info}
        {#each info.contents as group}
          {@const label = "label" in group.header ? group.header.label : info.effectNames[group.header.effectID]}
          {@const key = typeof label === "number" ? `#${label}` : label}
          <h3>{key ? plainText($words.templates[key] || ("label" in group.header ? key.split("/").at(-1) || "Items" : "Modules")) : "Modules"}</h3>
          <ul>{#each group.entries as entry}<li>{entry.qty} × {typeName(entry.typeID)}</li>{/each}</ul>
        {/each}
      {/if}
      <div class="fit-management-actions">
        <button type="button" disabled={busy} onclick={() => void run(() => flow.viewFitting(fit.fittingID))}>View Fitting</button>
        {#if !structureFit}<button type="button" disabled={busy || info === null} onclick={() => void run(() => flow.fitFittingToActiveShip(fit.fittingID))}>Fit to Active Ship</button>{/if}
        <button type="button" disabled={busy} onclick={() => void run(() => flow.buyFit(fit.fittingID))}>Buy All</button>
        {#if docked && $maxShips > 0}<button type="button" disabled={busy} onclick={() => void run(() => flow.openMultiFit(fit.fittingID))}>{word("OpenMultifit")}</button>{/if}
        {#if canDelete}<button type="button" disabled={busy} onclick={() => void run(() => flow.deleteFitting(fit.fittingID))}>{word("DeleteFitting")}</button>{/if}
      </div>
    {:else}
      <p>{word("NoFittingSelected")}</p>
    {/if}
  </section>
  {#if importing}
    <div class="fit-management-file">
      <ImportFittings {flow} title={word("ImportFromFile")} onClose={() => (importing = false)} onImported={() => (importing = false)} />
    </div>
  {/if}
</div>

<style>
  .fitting-management { display: grid; grid-template-columns: minmax(190px, 42%) minmax(0, 1fr); min-height: 100%; }
  aside, .fit-management-preview { padding: 10px; }
  aside { border-right: 1px solid rgba(255, 255, 255, 0.15); }
  aside > :is(select,input) { width: 100%; margin-bottom: 6px; }
  .fit-management-import, .fit-management-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .fit-management-item, .fit-management-hull { display: flex; align-items: center; gap: 8px; text-align: left; }
  .fit-management-item { width: 100%; margin-bottom: 3px; }
  .fit-management-item[aria-pressed="true"] { background: rgba(110, 168, 184, 0.23); }
  .fit-management-file { grid-column: 1 / -1; padding: 0 10px; }
  summary { cursor: pointer; padding-block: 3px; }
  .fit-management-type { margin-left: 12px; }
</style>
