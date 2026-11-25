<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { AccessGroupAuditRow } from "../bridge/accessGroupAudit.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo, subjectOfShowInfoLink } from "./showInfo.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { flow, store, groupID, enabled, revision }: {
    flow: AppFlow; store: ClientStore; groupID: number; enabled: boolean; revision: number;
  } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  let rows = $state.raw<readonly AccessGroupAuditRow[] | null>(null);
  let error = $state("");
  const PREFIX = "UI/Structures/LoggedChanges/";
  const roles = ["Member", "Manager", "Admin", "Blocked"];
  const icons = ["madeMember", "madeManager", "madeAdmin", "memberBlocked"];
  const ROLE_TEMPLATE = "UI/Structures/AccessGroups/";
  const TEXT_ACTIONS: Readonly<Record<number, readonly [string, string, string]>> = {
    1: ["GroupCreated", "{actorName} created the access list.", "groupCreated"],
    5: ["GroupNameChanged", "{actorName} changed the name.", "nameDescChanged"],
    6: ["GroupDescriptionChanged", "{actorName} changed the description.", "nameDescChanged"],
    7: ["GroupDeleted", "{actorName} deleted the access list.", ""],
  };

  function action(row: AccessGroupAuditRow): readonly [string, string, string] {
    const known = TEXT_ACTIONS[row.actionID];
    if (known) return known;
    const before = row.oldMembershipType === null ? "" : roles[row.oldMembershipType] ?? "";
    const after = row.newMembershipType === null ? "" : roles[row.newMembershipType] ?? "";
    if (!before && after) {
      return [row.newMembershipType === 3 ? "AddBlockedMember" : "Add" + after,
        "{actorName} added {changedName} as " + after + ".", icons[row.newMembershipType!] ?? ""];
    }
    if (before && !after) return ["Remove" + before + "FromGroup", "{actorName} removed {changedName}.", "memberRemoved"];
    if (before && after) {
      return [(before === "Manager" && after === "Blocked" ? "Cange" : "Change") + "To" + after + "From" + before,
        "{actorName} changed {changedName} from " + before + " to " + after + ".", icons[row.newMembershipType!] ?? ""];
    }
    return ["", "{actorName} changed the access list.", ""];
  }

  function showOwner(id: number) {
    const type = Number(resolvedName($names.resolved, "ownerType", id, "1373"));
    const subject = subjectOfShowInfoLink(`showinfo:${type}//${id}`);
    if (subject) showInfo(subject);
  }

  $effect(() => {
    const id = groupID;
    revision;
    rows = enabled ? null : [];
    error = "";
    if (!enabled) return;
    let live = true;
    void flow.readAccessGroupAudit(id).then(result => {
      if (!live) return;
      rows = result;
      flow.requestWords([...new Set(result.map(row => PREFIX + action(row)[0]))].concat(ROLE_TEMPLATE + "PublicUser"));
      const ids = new Set(result.flatMap(row => [row.characterID, row.ownerID ?? 0]).filter(id => id > 0));
      flow.requestNames([...ids].flatMap(owner => [{ kind: "owner", id: owner }, { kind: "ownerType", id: owner }]));
    }).catch(cause => { if (live) error = panelErrorWords(cause); });
    return () => { live = false; };
  });
</script>

<section aria-label="Audit Log" class="access-list-audit">
  {#if error}<p role="alert">{error}</p>
  {:else if rows === null}<p role="status">Reading audit log…</p>
  {:else if rows.length === 0}<p role="status">No audit entries.</p>
  {:else}
    <ol>
      {#each rows as row}
        {@const [label, fallback, icon] = action(row)}
        {@const template = $words.templates[PREFIX + label] ?? fallback}
        {@const pieces = plainText(formatTemplate(template, { actorName: "ACL_ACTOR", changedName: "ACL_OWNER" },
          { nameOf: () => "" })).split(/(ACL_ACTOR|ACL_OWNER)/)}
        <li data-audit-action={row.actionID} data-audit-owner={row.ownerID ?? undefined}>
          {#if icon}<img alt="" src={clientTexture(`res:/UI/Texture/classes/AccessGroups/${icon}.png`)} />{/if}
          {#if row.dateMs !== null}<time datetime={new Date(row.dateMs).toISOString()}>{new Date(row.dateMs).toLocaleString()}</time>{/if}
          <p>
            {#each pieces as piece}
              {#if piece === "ACL_ACTOR"}<button type="button" onclick={() => showOwner(row.characterID)}>{resolvedName($names.resolved, "owner", row.characterID)}</button>
              {:else if piece === "ACL_OWNER" && row.ownerID === 0}'{plainText($words.templates[ROLE_TEMPLATE + "PublicUser"] ?? "Everyone")}'
              {:else if piece === "ACL_OWNER" && row.ownerID !== null}
                {@const id = row.ownerID}
                <button type="button" onclick={() => showOwner(id)}>{resolvedName($names.resolved, "owner", id)}</button>
              {:else}{piece}{/if}
            {/each}
          </p>
          {#if row.oldText !== null || row.newText !== null}
            <details><summary>Old and new text</summary>
              <p>{row.oldText ?? ""}</p><p>{row.newText ?? ""}</p>
              {#if row.oldText !== null}
                <button type="button" onclick={() => void navigator.clipboard.writeText(row.oldText ?? "").catch(cause => { error = panelErrorWords(cause); })}>
                  {row.actionID === 5 ? "Copy Old Name" : "Copy Old Description"}
                </button>
              {/if}
            </details>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  ol { list-style: none; padding: 0; margin: 0; }
  li { border-bottom: 1px solid #324046; padding: 6px 4px; }
  img { width: 20px; height: 20px; vertical-align: middle; margin-right: 5px; }
  p { margin: 2px 0; overflow-wrap: anywhere; }
  button { border: 0; background: none; color: #9bc9df; padding: 0; text-decoration: underline; cursor: pointer; }
  time { opacity: .75; }
</style>
