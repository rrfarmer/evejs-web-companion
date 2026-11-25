<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { AccessGroup } from "../bridge/bookmarks.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { startAccessGroupDrag } from "./accessGroupDrag.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const station = $derived(store.station);
  const characterID = $derived($station.online?.characterID ?? null);
  let groups = $state.raw<readonly AccessGroup[] | null>(null);
  let query = $state("");
  let error = $state("");
  const visible = $derived((groups ?? []).filter(group => group.name.toLowerCase().includes(query.trim().toLowerCase())));

  $effect(() => {
    groups = null;
    error = "";
    if (characterID === null) return;
    let current = true;
    void flow.readAccessGroups().then(result => {
      if (current) groups = [...result].sort((left, right) => left.name.localeCompare(right.name));
    }).catch(cause => { if (current) error = panelErrorWords(cause); });
    return () => { current = false; };
  });
</script>

<section class="access-lists" aria-label="Access Lists">
  <label>Search <input type="search" bind:value={query} /></label>
  {#if error}<p role="alert">{error}</p>
  {:else if groups === null}<p role="status">Reading access lists…</p>
  {:else if !visible.length}<p role="status">{groups.length ? "No matching access lists." : "No access lists."}</p>
  {:else}
    <ul>
      {#each visible as group (group.groupID)}
        <li draggable="true" data-access-group-id={group.groupID}
          ondragstart={(event) => startAccessGroupDrag(event, group.groupID, group.name)}>
          {group.name}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  section { display: grid; gap: 8px; padding: 10px; }
  input { background: #11191d; color: inherit; padding: 4px; border: 1px solid #43525c; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 6px 8px; border-bottom: 1px solid #324046; cursor: grab; }
  li:hover { background: #26343b; }
</style>
