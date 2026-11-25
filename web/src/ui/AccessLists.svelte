<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { AccessGroup, AccessGroupMember } from "../bridge/bookmarks.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { startAccessGroupDrag } from "./accessGroupDrag.ts";
  import { accessMembershipsFromDrop, accessOwnerLinkType, droppedAccessMembers, hasAccessMemberDrag, startAccessMemberDrag } from "./accessMemberDrag.ts";

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
  let memberQuery = $state("");
  let memberTerm = $state("");
  let searchableGroups = $state.raw<ReadonlyMap<number, readonly AccessGroupMember[]> | null>(null);
  let memberSearchLoading = $state(false);
  let memberSearchError = $state("");
  let memberSearchRevision = $state(0);
  let error = $state("");
  let editorError = $state("");
  let members = $state.raw<readonly AccessGroupMember[] | null>(null);
  let memberError = $state("");
  let memberActionError = $state("");
  let memberRefresh = $state(0);
  let checked = $state.raw<ReadonlySet<number>>(new Set());
  let ownerQuery = $state("");
  let ownerMatches = $state.raw<readonly { id: number; name: string; typeID: number }[] | null>(null);
  let dropRole = $state<number | null>(null);
  let ownerDrop = $state<number | "pane" | null>(null);
  let searchingOwners = $state(false);
  let ownerSearchGeneration = 0;
  let readGeneration = 0;
  const WORD = "UI/Structures/AccessGroups/";
  const ownerTypes: Readonly<Record<number, number>> = { 2: 1373, 3: 2, 4: 16159 };
  const roleWords = ["Member", "Manager", "Admin", "Blocked"];
  const roleOrder = [2, 1, 0, 3];
  const word = (key: string, fallback = key) => plainText($words.templates[WORD + key] ?? fallback);
  const visible = $derived((groups ?? []).filter(group => group.name.toLowerCase().includes(query.trim().toLowerCase())));
  const selected = $derived(visible.find(group => group.groupID === selectedID) ?? visible[0] ?? null);
  const memberSearchActive = $derived(memberTerm.length >= 3);
  const memberMatches = $derived.by(() => {
    if (!memberSearchActive || searchableGroups === null) return null;
    const groupIDs = new Set<number>();
    const memberIDs = new Set<number>();
    for (const [groupID, rows] of searchableGroups) {
      for (const row of rows) {
        const name = row.memberID === 0 ? "Item 0" : resolvedName($names.resolved, "owner", row.memberID, "");
        if (!name.toLowerCase().includes(memberTerm)) continue;
        groupIDs.add(groupID);
        memberIDs.add(row.memberID);
      }
    }
    return { groupIDs, memberIDs };
  });
  const memberGroupID = $derived(selected?.groupID ?? null);
  const selectedCanEdit = $derived(selected?.membershipType === 2 && selected.creatorID !== corporationID);
  const canManageMembers = $derived(selected !== null && canManageGroup(selected));
  const canRemoveSelf = $derived(selected !== null && selected.creatorID !== corporationID &&
    selected.membershipType === 0 && members?.some(member => member.memberID === characterID && member.membershipType === 0));
  const canSelectMembers = $derived(canManageMembers || canRemoveSelf);
  const memberRows = $derived((members ?? []).filter(member => memberMatches === null || memberMatches.memberIDs.has(member.memberID)).map(member => ({
    ...member,
    name: member.memberID === 0 ? word("PublicUser", "Everyone") : resolvedName($names.resolved, "owner", member.memberID),
    typeID: Number(resolvedName($names.resolved, "ownerType", member.memberID, "0")),
    ownerOrder: ownerOrder(member.memberID),
  })).sort((a, b) => roleOrder.indexOf(a.membershipType) - roleOrder.indexOf(b.membershipType) ||
    a.ownerOrder - b.ownerOrder || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.memberID - b.memberID));
  const checkedRows = $derived(memberRows.filter(member => checked.has(member.memberID)));
  const removable = $derived(checkedRows.filter(member =>
    (canRemoveSelf && member.memberID === characterID) || (canManageMembers &&
    (selected?.membershipType === 2 || member.membershipType === 0 || member.membershipType === 3 || member.memberID === characterID))));
  const changeable = $derived(removable.filter(member => canManageMembers && member.ownerOrder === 3 &&
    resolvedName($names.resolved, "ownerType", member.memberID, "0") !== "0" &&
    (selected?.membershipType === 2 || member.membershipType === 0 || member.membershipType === 3)));
  const roleActions = [
    { role: 2, label: "MakeAdmin", fallback: "Make Admin" },
    { role: 1, label: "MakeManager", fallback: "Make Manager" },
    { role: 3, label: "BlockMember", fallback: "Block Member" },
  ];
  const removeRoleActions = [
    { role: 2, label: "RemoveAdminMembershipType", fallback: "Remove Admin" },
    { role: 1, label: "RemoveManagerMembershipType", fallback: "Remove Manager" },
    { role: 3, label: "UnblockMember", fallback: "Unblock Member" },
  ];

  function ownerOrder(id: number) {
    if (id === 0) return 0;
    const typeID = Number(resolvedName($names.resolved, "ownerType", id, "0"));
    if (typeID === 16159) return 1;
    if (typeID === 2) return 2;
    return 3;
  }

  function canManageGroup(group: AccessGroup) {
    return group.creatorID !== corporationID && (group.membershipType === 2 || group.membershipType === 1);
  }

  $effect(() => {
    flow.requestWords([...roleWords, ...roleActions.map(action => action.label),
      ...removeRoleActions.map(action => action.label), "PublicUser", "RemoveMember", "AddPublic",
      "SearchFieldHint", "SearchNoContentHint"].map(key => WORD + key));
  });

  $effect(() => {
    const pilot = characterID;
    const enabled = memberSearchActive;
    const ids = (groups ?? []).map(group => group.groupID);
    memberRefresh;
    memberSearchRevision;
    searchableGroups = null;
    memberSearchError = "";
    memberSearchLoading = false;
    if (pilot === null || !enabled || !ids.length) return;
    let current = true;
    memberSearchLoading = true;
    void flow.readAccessGroupMembersMany(ids).then(async result => {
      if (!current) return;
      const ownerIDs = new Set([...result.values()].flatMap(rows => rows.map(row => row.memberID)));
      await flow.resolveNamesNow([...ownerIDs].filter(id => id > 0).map(id => ({ kind: "owner", id })));
      if (current) searchableGroups = result;
    }).catch(cause => {
      if (current) memberSearchError = panelErrorWords(cause);
    }).finally(() => {
      if (current) memberSearchLoading = false;
    });
    return () => { current = false; };
  });

  function searchMembers(event: SubmitEvent) {
    event.preventDefault();
    memberTerm = memberQuery.toLowerCase();
    checked = new Set();
  }

  function clearMemberSearch() {
    memberQuery = "";
    memberTerm = "";
    checked = new Set();
  }

  $effect(() => {
    const pilot = characterID;
    const groupID = memberGroupID;
    memberRefresh;
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

  $effect(() => {
    selected?.groupID;
    characterID;
    checked = new Set();
    ownerQuery = "";
    ownerMatches = null;
    dropRole = null;
    ownerDrop = null;
    searchingOwners = false;
    memberActionError = "";
    ++ownerSearchGeneration;
  });

  async function findOwners(event: SubmitEvent) {
    event.preventDefault();
    const text = ownerQuery.trim();
    if (!text || searchingOwners || busy) return;
    const groupID = memberGroupID, pilot = characterID;
    const generation = ++ownerSearchGeneration;
    const current = () => generation === ownerSearchGeneration && groupID === memberGroupID && pilot === characterID;
    searchingOwners = true;
    ownerMatches = null;
    memberActionError = "";
    try {
      const matches = await flow.searchOwners(text, [2, 3, 4], 0);
      if (current()) ownerMatches = [...matches].flatMap(([kind, owners]) =>
        owners.map(owner => ({ ...owner, typeID: ownerTypes[kind] ?? 0 }))).sort((a, b) => a.name.localeCompare(b.name));
    } catch (cause) {
      if (current()) memberActionError = panelErrorWords(cause);
    } finally {
      if (current()) searchingOwners = false;
    }
  }

  function toggleMember(id: number, on: boolean) {
    const next = new Set(checked);
    if (on) next.add(id);
    else next.delete(id);
    checked = next;
  }

  type MemberMethod = Parameters<AppFlow["changeAccessGroupMembers"]>[1];

  async function changeMembers(method: MemberMethod | "drop",
      memberIDs: readonly number[], role = 0) {
    const group = selected, pilot = characterID;
    if (!group || pilot === null || busy || !memberIDs.length) return;
    const current = () => memberGroupID === group.groupID && pilot === characterID;
    let ids = memberIDs;
    let changes: { method: MemberMethod; ids: readonly number[] }[];
    let refusedOwners = 0;
    busy = true;
    memberActionError = "";
    try {
      if (ids.includes(pilot)) {
        if (method === "DeleteMembers" &&
            !await flow.askClientDialogWith("AccessGroupRemoveYourselfFromGroup", {}, "Remove yourself from this access list?")) {
          ids = ids.filter(id => id !== pilot);
        }
        if (method === "UpdateMembershipTypes" && group.membershipType === 2 && role !== 2 &&
            !await flow.askClientDialogWith("AccessGroupDemoteAdmin", {}, "Change your own access level?")) {
          ids = ids.filter(id => id !== pilot);
        }
      }
      if (method === "drop") {
        const existing = new Map((members ?? []).map(member => [member.memberID, member.membershipType]));
        await flow.resolveNamesNow(ids.map(id => ({ kind: "ownerType", id })));
        if (!current()) return;
        ids = ids.filter(id => {
          const oldRole = existing.get(id);
          if (oldRole === role) return false;
          const ownerType = accessOwnerLinkType(Number(resolvedName(names.get().resolved, "ownerType", id, "0")));
          const permitted = ownerType !== null &&
            ((role !== 2 && role !== 1) || ownerType === 1373) &&
            (group.membershipType === 2 || id === pilot || (oldRole !== 2 && oldRole !== 1));
          if (!permitted) ++refusedOwners;
          return permitted;
        });
        if (ids.includes(pilot) &&
            !await flow.askClientDialogWith(group.membershipType === 1 ? "AccessGroupDemoteManager" : "AccessGroupDemoteAdmin",
              {}, "Change your own access level?")) {
          ids = ids.filter(id => id !== pilot);
        }
        changes = [
          { method: "UpdateMembershipTypes", ids: ids.filter(id => existing.has(id)) },
          { method: "AddMembers", ids: ids.filter(id => !existing.has(id)) },
        ];
      } else {
        changes = [{ method, ids }];
      }
      if (current() && refusedOwners) memberActionError = "Some owners cannot be assigned to this access role.";
      if (!ids.length || !current()) return;
      for (const change of changes) {
        if (!current()) return;
        if (!change.ids.length) continue;
        try {
          await flow.changeAccessGroupMembers(group.groupID, change.method, change.ids, role);
        } catch (cause) {
          if (current()) memberActionError = panelErrorWords(cause);
        }
      }
      if (current()) checked = new Set();
      if (ids.includes(pilot) && method !== "AddMembers" && current()) await refresh();
    } catch (cause) {
      if (current()) memberActionError = panelErrorWords(cause);
    } finally {
      if (current()) ++memberRefresh;
      if (pilot === characterID) busy = false;
    }
  }

  function acceptRoleDrag(event: DragEvent, role: number) {
    if (!canManageMembers || busy || !members || (selected?.membershipType === 1 && (role === 1 || role === 2)) ||
        !hasAccessMemberDrag(event)) return false;
    event.preventDefault();
    return true;
  }

  function dropOnRole(event: DragEvent, role: number) {
    dropRole = null;
    if (acceptRoleDrag(event, role)) void changeMembers("drop", droppedAccessMembers(event), role);
  }

  function dragMember(event: DragEvent, member: typeof memberRows[number]) {
    const dragged = checked.has(member.memberID) ? checkedRows : [member];
    startAccessMemberDrag(event, dragged.map(row => ({
      id: row.memberID, typeID: row.typeID, name: row.name, membershipType: row.membershipType,
    })));
  }

  function acceptOwnerDrop(event: DragEvent, group: AccessGroup, target: number | "pane") {
    if (busy || editor || !canManageGroup(group) || !hasAccessMemberDrag(event)) return false;
    event.preventDefault();
    if (event.type === "dragover") {
      ownerDrop = target;
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
    return true;
  }

  async function addFromOwnerDrop(event: DragEvent, group: AccessGroup, target: number | "pane") {
    ownerDrop = null;
    const pilot = characterID;
    if (pilot === null || !acceptOwnerDrop(event, group, target)) return;
    const roles = accessMembershipsFromDrop(event, target !== "pane");
    if (!roles.length) return;
    busy = true;
    memberActionError = "";
    try {
      const [existing] = await Promise.all([
        flow.readAccessGroupMembers(group.groupID),
        flow.resolveNamesNow(roles.map(([id]) => ({ kind: "ownerType", id }))),
      ]);
      if (pilot !== characterID) return;
      const memberIDs = new Set(existing.map(member => member.memberID));
      const pending = roles.filter(([id]) => !memberIDs.has(id));
      const permitted = pending.filter(([id, role]) => {
        const type = accessOwnerLinkType(Number(resolvedName(names.get().resolved, "ownerType", id, "0")));
        return type !== null && ((role !== 1 && role !== 2) || (type === 1373 && group.membershipType === 2));
      });
      if (permitted.length < pending.length) memberActionError = "Some owners cannot be assigned to this access role.";
      if (permitted.length) await flow.addAccessGroupMembers(group.groupID, permitted);
    } catch (cause) {
      if (pilot === characterID) memberActionError = panelErrorWords(cause);
    } finally {
      if (pilot === characterID) {
        if (memberGroupID === group.groupID) ++memberRefresh;
        else ++memberSearchRevision;
        busy = false;
      }
    }
  }

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
    memberQuery = "";
    memberTerm = "";
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
    <label>Filter lists <input type="search" bind:value={query} disabled={busy} /></label>
    <button type="button" onclick={() => startEditor(null)} disabled={characterID === null || busy || editor !== null}>Create a New Access List</button>
  </div>
  <form class="member-filter" aria-label="Search access list members" onsubmit={searchMembers}>
    <label>Search members <input type="search" maxlength="100" bind:value={memberQuery} disabled={busy}
      placeholder={word("SearchFieldHint", "Character, corporation or alliance")} oninput={(event) => {
        if (!event.currentTarget.value) clearMemberSearch();
      }} /></label>
    <button type="submit" disabled={busy}>Search</button>
    {#if memberQuery || memberSearchActive}
      <button type="button" disabled={busy} onclick={clearMemberSearch}>Clear</button>
    {/if}
  </form>
  {#if memberSearchLoading}<p role="status">Searching members…</p>{/if}
  {#if memberSearchError}<p role="alert">{memberSearchError}</p>{/if}
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
            <li draggable="true" data-access-group-id={group.groupID} class:drop-active={ownerDrop === group.groupID}
              class:member-miss={memberMatches !== null && !memberMatches.groupIDs.has(group.groupID)}
              ondragstart={(event) => startAccessGroupDrag(event, group.groupID, group.name)}
              ondragover={(event) => acceptOwnerDrop(event, group, group.groupID)}
              ondragleave={() => { if (ownerDrop === group.groupID) ownerDrop = null; }}
              ondrop={(event) => addFromOwnerDrop(event, group, group.groupID)}>
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
        {#if canManageMembers && members !== null}
          <div class="role-targets" role="list" aria-label="Drop owners to set access">
            {#each roleOrder as role (role)}
              {@const disabled = selected.membershipType === 1 && (role === 2 || role === 1)}
              <div role="listitem" class:drop-active={dropRole === role} data-access-drop-role={role} data-disabled={disabled || busy}
                ondragover={(event) => {
                  if (acceptRoleDrag(event, role)) {
                    dropRole = role;
                    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
                  }
                }}
                ondragleave={() => { if (dropRole === role) dropRole = null; }}
                ondrop={(event) => dropOnRole(event, role)}>{word(roleWords[role])}</div>
            {/each}
          </div>
          <div class="member-tools">
            <form class="member-search" onsubmit={findOwners}>
              <label>Find an owner to add <input type="search" bind:value={ownerQuery} disabled={busy || searchingOwners} /></label>
              <button type="submit" disabled={busy || searchingOwners || !ownerQuery.trim()}>Find</button>
            </form>
            <button type="button" disabled={busy || members.some(member => member.memberID === 0)}
              onclick={() => changeMembers("AddMembers", [0])}>{word("AddPublic", "Add Everyone")}</button>
          </div>
          {#if searchingOwners}<p role="status">Finding owners…</p>
          {:else if ownerMatches !== null}
            {#each ownerMatches as owner (owner.id)}
              <div class="owner-match">
                <span role="presentation" draggable="true" ondragstart={(event) => startAccessMemberDrag(event, [owner])}>{owner.name}</span>
                <button type="button" aria-label={`Add ${owner.name}`}
                  disabled={busy || members.some(member => member.memberID === owner.id)}
                  onclick={() => changeMembers("AddMembers", [owner.id])}>Add</button>
              </div>
            {:else}<p role="status">No owners found.</p>{/each}
          {/if}
        {/if}
        {#if memberActionError}<p role="alert">{memberActionError}</p>{/if}
        <div role="group" class="member-pane" class:drop-active={ownerDrop === "pane"} aria-label="Drop owners to add members"
          ondragover={(event) => acceptOwnerDrop(event, selected, "pane")}
          ondragleave={() => { if (ownerDrop === "pane") ownerDrop = null; }}
          ondrop={(event) => addFromOwnerDrop(event, selected, "pane")}>
          <table aria-label="Access list members">
            <thead><tr>{#if canSelectMembers}<th scope="col" aria-label="Select members"></th>{/if}<th scope="col">Name</th><th scope="col">Access</th></tr></thead>
            <tbody>
              {#each memberRows as member (member.memberID)}
                <tr data-access-member-id={member.memberID}>
                  {#if canSelectMembers}
                    <td class="member-select">
                      {#if canManageMembers || member.memberID === characterID}
                        <input type="checkbox" aria-label={`Select ${member.name}`} checked={checked.has(member.memberID)} disabled={busy}
                          onchange={(event) => toggleMember(member.memberID, event.currentTarget.checked)} />
                      {/if}
                    </td>
                  {/if}
                  <td><span role="presentation" draggable={member.memberID > 0 && accessOwnerLinkType(member.typeID) !== null}
                    ondragstart={(event) => dragMember(event, member)}>{member.name}</span></td><td>{word(roleWords[member.membershipType])}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if removable.length}
          <div class="actions">
            {#each roleActions as action (action.role)}
              {@const targets = changeable.filter(member => member.membershipType !== action.role).map(member => member.memberID)}
              {#if targets.length && (selected.membershipType === 2 || action.role === 3)}
                <button type="button" disabled={busy} onclick={() => changeMembers("UpdateMembershipTypes", targets, action.role)}>
                  {word(action.label, action.fallback)}
                </button>
              {/if}
            {/each}
            {#each removeRoleActions as action (action.role)}
              {@const targets = changeable.filter(member => member.membershipType === action.role).map(member => member.memberID)}
              {#if targets.length}
                <button type="button" disabled={busy} onclick={() => changeMembers("UpdateMembershipTypes", targets, 0)}>
                  {word(action.label, action.fallback)}
                </button>
              {/if}
            {/each}
            <button type="button" disabled={busy} onclick={() => changeMembers("DeleteMembers", removable.map(member => member.memberID))}>
              {word("RemoveMember", "Remove Member")}
            </button>
          </div>
        {/if}
        {#if memberError}<p role="alert">{memberError}</p>
        {:else if members === null}<p role="status">Reading members…</p>
        {:else if memberMatches && !memberRows.length}<p role="status">{word("SearchNoContentHint", "No matching members.")}</p>
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
  .member-tools, .member-search, .owner-match { display: flex; flex-wrap: wrap; gap: 6px; align-items: end; }
  .member-search { border: 0; padding: 0; }
  .member-filter { display: flex; flex-wrap: wrap; gap: 6px; align-items: end; border: 0; padding: 0; }
  .owner-match { justify-content: space-between; align-items: center; }
  .member-select { width: 1%; }
  .role-targets { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
  .role-targets > div { border: 1px solid #43525c; text-align: center; padding: 5px 3px; }
  .role-targets > div[data-disabled="true"] { opacity: .45; }
  .role-targets > .drop-active { border-color: #86c1d6; background: #254652; }
  .member-pane { min-height: 44px; }
  .member-pane.drop-active, li.drop-active { outline: 1px solid #86c1d6; background: #254652; }
  li.member-miss button:not(:focus):not(:hover) { opacity: .55; }
  span[draggable="true"] { cursor: grab; }
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
