<script lang="ts">
  import { loadTypeList } from "../app/api.ts";
  import type { Session } from "../app/sessions.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { resolvedName, type NameKind } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { session, listID, nameID }: { session: Session; listID: number; nameID: number | null } = $props();
  const words = $derived(session.store.words), names = $derived(session.store.names);
  const infoLabel = "UI/Agents/Dialogue/DungeonDisallowedFittedTypesRestrictionsInfo";
  const searchLabel = "UI/Common/Search", emptyLabel = "UI/Common/NothingFound", showLabel = "UI/Commands/ShowInfo";
  const word = (key: string, fallback = "") => plainText($words.templates[key] ?? fallback);
  const nameOf = (kind: NameKind, id: number) => resolvedName($names.resolved, kind, id, "");
  let search = $state("");
  let rows = $state.raw<readonly { typeID: number; groupID: number }[] | null>(null);
  let failed = $state(false);

  $effect(() => {
    const flow = session.flow;
    const id = listID;
    let current = true;
    flow.requestWords([infoLabel, searchLabel, emptyLabel, showLabel, ...(nameID === null ? [] : [`#${nameID}`])]);
    void loadTypeList(id, flow.requestOptions()).then(async types => {
      if (!types) throw new Error("Type list unavailable");
      const facts = types.length ? await flow.typeFacts(types) : new Map();
      if (!facts) throw new Error("Type details unavailable");
      if (!current) return;
      const published = types.flatMap(typeID => {
        const type = facts.get(typeID);
        return type?.published && type.groupID !== null ? [{ typeID, groupID: type.groupID }] : [];
      });
      rows = published;
      flow.requestNames([...published.map(({ typeID: id }) => ({ kind: "type" as const, id })),
        ...[...new Set(published.map(row => row.groupID))].map(id => ({ kind: "group" as const, id }))]);
    }).catch(() => { if (current) failed = true; });
    return () => { current = false; };
  });

  const ordered = $derived((rows ?? []).map(({ typeID, groupID }) => ({ typeID, groupID, name: nameOf("type", typeID) }))
    .sort((a, b) => a.name.localeCompare(b.name)));
  const matches = $derived(ordered.filter(row => row.name.toLowerCase().includes(search.toLowerCase())));
  const groups = $derived.by(() => {
    const grouped = new Map<number, typeof ordered>();
    for (const row of ordered) {
      const group = grouped.get(row.groupID) ?? [];
      group.push(row);
      grouped.set(row.groupID, group);
    }
    return [...grouped].map(([id, items]) => ({ id, items, name: nameOf("group", id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
</script>

<section class="fitted-module-list">
  {#if nameID !== null}<h3>{word(`#${nameID}`)}</h3>{/if}
  <p>{word(infoLabel)}</p>
  <div class="search">
    <input type="search" bind:value={search} maxlength="50" aria-label={word(searchLabel, "Search")} placeholder={word(searchLabel, "Search")} />
  </div>
  {#if failed}<p role="alert">Module list unavailable.</p>
  {:else if rows === null}<p role="status">Loading modules…</p>
  {:else if !matches.length}<p>{word(emptyLabel, "Nothing found")}</p>
  {:else if search}
    <ul>{#each matches as row (row.typeID)}{@render moduleRow(row)}{/each}</ul>
  {:else}
    {#each groups as group (group.id)}
      <details open={groups.length === 1}>
        <summary>{group.name}<span>{group.items.length}</span></summary>
        <ul>{#each group.items as row (row.typeID)}{@render moduleRow(row)}{/each}</ul>
      </details>
    {/each}
  {/if}
</section>

{#snippet moduleRow(row: { typeID: number; name: string })}
  <li data-fitted-type={row.typeID}>
    <TypeIcon typeID={row.typeID} name={row.name} size="sm" />
    <span>{row.name}</span>
    <button type="button" class="evelink showInfo" title={word(showLabel, "Show Info")}
      aria-label={`${word(showLabel, "Show Info")} — ${row.name}`}
      onclick={() => showInfo({ kind: "type", typeID: row.typeID })}>ⓘ</button>
  </li>
{/snippet}

<style>
  section { padding: 0.85rem 1rem; }
  h3, p { margin: 0 0 0.5rem; }
  .search { margin: 0.8rem 0; }
  input { width: 100%; }
  details, li { border-bottom: 1px solid rgb(255 255 255 / 12%); }
  summary { padding: 0.35rem; cursor: pointer; }
  summary > span { float: right; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { display: flex; gap: 0.45rem; align-items: center; padding: 0.3rem; }
  li > button { margin-left: auto; }
</style>
