<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { AccessGroup, AccessGroupMember } from "../bridge/bookmarks.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { startAccessGroupDrag } from "./accessGroupDrag.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const station = $derived(store.station);
  const names = $derived(store.names);
  const words = $derived(store.words);
  const characterID = $derived($station.online?.characterID ?? null);
  const corporationID = $derived($station.online?.corporationID ?? null);
  let groups = $state.raw<readonly AccessGroup[] | null>(null);
  let selectedID = $state<number | null>(null);
  let editor = $state<{ groupID: number | null; name: string; description: string } | null>(null);
  let busy = $state(false);
  let query = $state("");
  let error = $state("");
  let editorError = $state("");
  let members = $state.raw<readonly AccessGroupMember[] | null>(null);
  let memberError = $state("");
  let readGeneration = 0;
  const WORD = "UI/Structures/AccessGroups/";
  const roleWords = ["Member", "Manager", "Admin", "Blocked"];
  const roleOrder = [2, 1, 0, 3];
  const word = (key: string, fallback = key) => plainText($words.templates[WORD + key] ?? fallback);
  const visible = $derived((groups ?? []).filter(group => group.name.toLowerCase().includes(query.trim().toLowerCase())));
  const selected = $derived(visible.find(group => group.groupID === selectedID) ?? visible[0] ?? null);
  const memberGroupID = $derived(selected?.groupID ?? null);
  const selectedCanEdit = $derived(selected?.membershipType === 2 && selected.creatorID !== corporationID);
  const memberRows = $derived((members ?? []).map(member => ({
    ...member,
    name: member.memberID === 0 ? word("PublicUser", "Everyone") : resolvedName($names.resolved, "owner", member.memberID),
    ownerOrder: ownerOrder(member.memberID),
  })).sort((a, b) => roleOrder.indexOf(a.membershipType) - roleOrder.indexOf(b.membershipType) ||
    a.ownerOrder - b.ownerOrder || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.memberID - b.memberID));

  function ownerOrder(id: number) {
    if (id === 0) return 0;
    const typeID = Number(resolvedName($names.resolved, "ownerType", id, "0"));
    if (typeID === 16159) return 1;
    if (typeID === 2) return 2;
    return 3;
  }

  $effect(() => {
    flow.requestWords([...roleWords, "PublicUser"].map(key => WORD + key));
  });

  $effect(() => {
    const pilot = characterID;
    const groupID = memberGroupID;
    members = null;
    memberError = "";
    if (pilot === null || groupID === null) return;
    let current = true;
    void flow.readAccessGroupMembers(groupID).then(result => {
      if (!current) return;
      members = result;
      flow.requestNames(result.flatMap(({ memberID }) => memberID > 0
        ? [{ kind: "owner", id: memberID }, { kind: "ownerType", id: memberID }] : []));
    }).catch(cause => { if (current) memberError = panelErrorWords(cause); });
    return () => { current = false; };
  });

  async function refresh() {
    const generation = ++readGeneration;
    try {
      const result = await flow.readAccessGroups();
      if (generation === readGeneration) {
        groups = [...result].sort((left, right) => left.name.localeCompare(right.name));
        error = "";
      }
    } catch (cause) {
      if (generation === readGeneration) error = panelErrorWords(cause);
    }
  }

  $effect(() => {
    const pilot = characterID;
    groups = null;
    selectedID = null;
    editor = null;
    busy = false;
    error = "";
    if (pilot !== null) void refresh();
    return () => { ++readGeneration; };
  });

  function startEditor(group: AccessGroup | null) {
    editorError = "";
    editor = { groupID: group?.groupID ?? null, name: group?.name ?? "", description: group?.description ?? "" };
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!editor || busy) return;
    const { groupID, name, description } = editor;
    if (!name.trim()) {
      editorError = "Enter a name for the access list.";
      return;
    }
    const pilot = characterID;
    busy = true;
    editorError = "";
    try {
      if (groupID === null) {
        const createdID = await flow.createAccessGroup(name.trim(), description.trim());
        if (pilot !== characterID) return;
        selectedID = createdID;
        query = "";
      } else {
        await flow.editAccessGroup(groupID, name.trim(), description.trim());
      }
      if (pilot === characterID) editor = null;
    } catch (cause) {
      if (pilot === characterID) editorError = panelErrorWords(cause);
    } finally {
      if (pilot === characterID) {
        await refresh();
        if (pilot === characterID) busy = false;
      }
    }
  }

  async function remove(group: AccessGroup) {
    if (busy) return;
    const pilot = characterID;
    busy = true;
    error = "";
    try {
      if (await flow.deleteAccessGroup(group) && pilot === characterID) {
        selectedID = null;
        await refresh();
      }
    } catch (cause) {
      if (pilot === characterID) error = panelErrorWords(cause);
    } finally {
      if (pilot === characterID) busy = false;
    }
  }
</script>

<section class="access-lists" aria-label="Access Lists">
  <div class="actions">
    <label>Search <input type="search" bind:value={query} /></label>
    <button type="button" onclick={() => startEditor(null)} disabled={characterID === null || busy || editor !== null}>Create a New Access List</button>
  </div>
  {#if editor}
    {@const group = groups?.find(group => group.groupID === editor?.groupID)}
    <form onsubmit={save}>
      <h3>{editor.groupID === null ? "Create a New Access List" : `Edit Access List (${group?.name ?? ""})`}</h3>
      <label>Name <input maxlength="30" bind:value={editor.name} disabled={busy} /></label>
      <label>Description <textarea maxlength="200" rows="4" bind:value={editor.description} disabled={busy}></textarea></label>
      {#if editorError}<p role="alert">{editorError}</p>{/if}
      <div class="actions">
        <button type="submit" disabled={busy}>{editor.groupID === null ? "Create" : "Save"}</button>
        <button type="button" disabled={busy} onclick={() => { editor = null; }}>Cancel</button>
      </div>
    </form>
  {/if}
  {#if error}<p role="alert">{error}</p>
  {/if}
  <div class="list-layout">
    <div>
      {#if groups === null}
        {#if !error}<p role="status">Reading access lists…</p>{/if}
      {:else if !visible.length}<p role="status">{groups.length ? "No matching access lists." : "No access lists."}</p>
      {:else}
        <ul>
          {#each visible as group (group.groupID)}
            <li draggable="true" data-access-group-id={group.groupID}
              ondragstart={(event) => startAccessGroupDrag(event, group.groupID, group.name)}>
              <button type="button" aria-pressed={group.groupID === memberGroupID}
                onclick={() => { selectedID = group.groupID; }} disabled={busy || editor !== null}>{group.name}</button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    {#if selected && !editor}
      <div class="details">
        <h3>{selected.name}</h3>
        {#if selected.description}<p class="description">{selected.description}</p>{/if}
        {#if selectedCanEdit}
          <div class="actions">
            <button type="button" onclick={() => startEditor(selected)} disabled={busy}>Edit Access List</button>
            <button type="button" onclick={() => selected && remove(selected)} disabled={busy}>Delete Access List</button>
          </div>
        {/if}
        <table aria-label="Access list members">
          <thead><tr><th scope="col">Name</th><th scope="col">Access</th></tr></thead>
          <tbody>
            {#each memberRows as member (member.memberID)}
              <tr data-access-member-id={member.memberID}><td>{member.name}</td><td>{word(roleWords[member.membershipType])}</td></tr>
            {/each}
          </tbody>
        </table>
        {#if memberError}<p role="alert">{memberError}</p>
        {:else if members === null}<p role="status">Reading members…</p>
        {:else if !members.length}<p role="status">No members.</p>
        {/if}
      </div>
    {/if}
  </div>
</section>

<style>
  section { display: grid; gap: 8px; padding: 10px; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .list-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 12px; align-items: start; }
  .details { display: grid; gap: 8px; min-width: 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #324046; }
  th:last-child { width: 1%; }
  form { display: grid; gap: 8px; padding: 8px; border: 1px solid #43525c; }
  form label { display: grid; gap: 4px; }
  h3, p { margin: 0; }
  .description { white-space: pre-wrap; overflow-wrap: anywhere; }
  input, textarea, button { background: #11191d; color: inherit; padding: 4px; border: 1px solid #43525c; }
  textarea { resize: vertical; }
  button { cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { border-bottom: 1px solid #324046; cursor: grab; }
  li button { display: block; width: 100%; padding: 6px 8px; border: 1px solid transparent; text-align: left; cursor: grab; }
  li button:hover, li button[aria-pressed="true"] { background: #26343b; }
</style>
