<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { AccessGroup } from "../bridge/bookmarks.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { startAccessGroupDrag } from "./accessGroupDrag.ts";
  import { accessGroupLabel, accessGroupName, isNpcCorporation } from "./accessGroupNames.ts";
  import { showInfo, subjectOfShowInfoLink } from "./showInfo.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { flow, store, groupID }: { flow: AppFlow; store: ClientStore; groupID: number } = $props();
  let group = $state.raw<AccessGroup | null>(null);
  let error = $state("");
  const words = $derived(store.words);
  const names = $derived(store.names);
  const PREFIX = "UI/Structures/AccessGroups/";
  const displayName = $derived(group ? accessGroupName(group,
    id => resolvedName($names.resolved, "owner", id, group?.name),
    path => plainText($words.templates[path] ?? path)) : "");
  const ownerParts = $derived(plainText(formatTemplate($words.templates[PREFIX + "GroupOwner"] ?? "Access List Admin: {ownerName}",
    { ownerName: "OWNER_NAME" }, { nameOf: () => "" })).split("OWNER_NAME"));

  onMount(() => {
    const id = groupID;
    let live = true;
    flow.requestWords([PREFIX + "GroupOwner", PREFIX + "NoGroupDescription"]);
    void flow.readAccessGroup(id).then(value => {
      if (!live) return;
      if (!value) {
        error = "This access list is unavailable.";
        return;
      }
      group = value;
      const label = accessGroupLabel(value);
      if (label) flow.requestWords([label]);
      flow.requestNames([
        ...(isNpcCorporation(value.creatorID) ? [{ kind: "owner" as const, id: value.creatorID }] : []),
        ...(value.admins ?? []).flatMap(id => [{ kind: "owner" as const, id }, { kind: "ownerType" as const, id }]),
      ]);
    }).catch(cause => { if (live) error = panelErrorWords(cause); });
    return () => { live = false; };
  });
</script>

<section data-access-group-info={groupID} aria-label="Access List information">
  {#if error}<p role="alert">{error}</p>
  {:else if !group}<p role="status">Reading access list…</p>
  {:else}
    <header>
      <img src={clientTexture("res:/ui/Texture/WindowIcons/accessGroups.png")} alt="" draggable="true" role="presentation"
        ondragstart={(event) => { if (group) startAccessGroupDrag(event, group.groupID, group.name); }} />
      <h3>{displayName}</h3>
    </header>
    {#if group.description}<p class="description">{group.description}</p>
    {:else}<p><em>{plainText($words.templates[PREFIX + "NoGroupDescription"] ?? "This access list has no description")}</em></p>{/if}
    {#each group.admins ?? [] as ownerID (ownerID)}
      {@const name = resolvedName($names.resolved, "owner", ownerID)}
      {@const typeID = Number(resolvedName($names.resolved, "ownerType", ownerID, "1373"))}
      {@const subject = subjectOfShowInfoLink(`showinfo:${typeID}//${ownerID}`)}
      <p>{ownerParts[0]}{#if subject}<button type="button" class="owner-link" onclick={() => showInfo(subject)}>{name}</button>{:else}{name}{/if}{ownerParts[1] ?? ""}</p>
    {/each}
  {/if}
</section>

<style>
  section { display: grid; gap: 8px; padding: 10px; align-content: start; }
  header { display: flex; gap: 10px; align-items: center; }
  header img { width: 40px; height: 40px; cursor: grab; }
  h3, p { margin: 0; overflow-wrap: anywhere; }
  .description { white-space: pre-wrap; }
  .owner-link { padding: 0; border: 0; background: none; color: #9bc9df; cursor: pointer; text-decoration: underline; }
</style>
