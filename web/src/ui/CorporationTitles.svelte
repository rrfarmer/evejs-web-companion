<script lang="ts">
  // corporation/corp_ui_member_titles.py CorpTitles (Administration > Members > Titles, a director's): the View combo
  // (Roles, Grantable Roles, Title Summary) and the Type combo (GetRoleGroupings(1)'s groups); in the role views a row
  // per title - its name in an edit (100 characters; read-only under the content compliance control) and a checkbox per
  // role sub-column, named by the sub-column - under the headers CorpMemberName and the group's column names; Save
  // Changes sends the changed titles (UpdateTitles); leaving it with changes asks CrpTitlesSaveChanges. Title Summary:
  // the title combo, "Members With Title" (GetMembers' loaded rows whose titleMask has the title) and "Roles In Title"
  // (per GetRoleGroupings() group: "<role>[ - <column>] (Role, Grantable Role)").
  import { onDestroy, onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, CorporationTitlesView } from "../app/flow.ts";
  import type { CorporationTitle, RoleGrouping } from "../bridge/corporationRoles.ts";
  import { MEMBER_ROLE_FIELDS } from "../bridge/corporationMemberDetails.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import LabelText from "./LabelText.svelte";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const M = "UI/Corporations/CorporationWindow/Members/";
  const LABELS = ["UI/Corporations/Common/Roles", "UI/Corporations/Common/GrantableRoles", "UI/Corporations/Common/TitleSummary", "UI/Common/View", "UI/Common/Type",
    "UI/Corporations/EditMemberDialog/CorpMemberTitleCaption", M + "CorpMemberName", M + "AccessDeniedDirectorRoleRequired", M + "TitleHasRoleHint", M + "TitleDoesNotHaveRoleHint",
    M + "MembersWithTitle", M + "RolesInTitle", "UI/Corporations/Common/Role", "UI/Corporations/EditMemberDialog/GrantableRole", "UI/Common/Buttons/SaveChanges",
    "UI/Common/Buttons/CollapseAll", "UI/Common/Formatting/ListGenericDelimiter", ...Object.keys(LINK_WORDS)];
  const text = (label: string, args: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", args as never, { nameOf: (k, id) => resolvedName($names.resolved, k, id, "") }));
  const message = (id: number) => plainText($words.templates[`#${id}`] ?? "");
  const followerOf = (url: string, t: string) => linkFollowerOf(url, flow, null, (label) => plainText($words.templates[label] ?? LINK_WORDS[label] ?? ""), t);

  type Rec = CorporationTitle;
  let view = $state<CorporationTitlesView | null>(null), error = $state("");
  // VIEW_ROLES 0, VIEW_GRANTABLE_ROLES 1, VIEW_TITLES 2; viewRoleGroupingID starts at 1.
  let viewType = $state(0), groupingID = $state(1);
  // GetTitlesListData's rows: roles and grantableRoles without the Director role, the rest as read; the "old" copies.
  let recs = $state<Rec[]>([]), olds = $state<Rec[]>([]);
  let summaryTitleID = $state<number | null>(null), members = $state<readonly number[] | null>(null);
  // The ListGroups ('titleSummary', 'members' / 'roles'), state 'locked' (no rename or delete), open as the registry keeps them.
  // svelte-ignore state_referenced_locally
  let membersOpen = $state(flow.listGroupOpen("titleSummary", "members")), rolesOpen = $state(flow.listGroupOpen("titleSummary", "roles"));
  const setOpen = (group: "members" | "roles", open: boolean) => { flow.listGroupOpen("titleSummary", group, open); if (group === "members") membersOpen = open; else rolesOpen = open; };
  let sortBy = $state<number | null>(null), reverse = $state(false);
  let saving = $state(false);

  const stripped = (t: CorporationTitle): Rec => ({ ...t, roles: t.roles & ~1n, grantableRoles: t.grantableRoles & ~1n });
  async function load(): Promise<void> {
    try {
      const v = await flow.corporationTitlesView();
      view = v;
      recs = v.titles.map(stripped); olds = v.titles.map(stripped);
      if (summaryTitleID === null || !v.titles.some((t) => t.titleID === summaryTitleID)) summaryTitleID = v.titles[0]?.titleID ?? null;
      if (viewType === 2) void loadMembers();
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  async function loadMembers(): Promise<void> {
    if (summaryTitleID === null) { members = []; return; }
    try { members = await flow.membersWithTitle(summaryTitleID); } catch (e) { error = e instanceof Error ? e.message : String(e); members = []; }
  }
  const changedRecs = () => recs.filter((r, i) => { const o = olds[i]!; return r.titleName !== o.titleName || MEMBER_ROLE_FIELDS.some((f) => r[f] !== o[f]); });
  async function save(): Promise<void> {
    const changed = changedRecs();
    if (!changed.length || saving) return;
    saving = true;
    try { await flow.saveCorporationTitles(changed); await load(); } catch (e) { error = e instanceof Error ? e.message : String(e); } finally { saving = false; }
  }
  onMount(() => {
    flow.requestWords(LABELS);
    void load();
  });
  onDestroy(() => {
    // OnTabDeselect: unsaved changes ask CrpTitlesSaveChanges; Yes saves them.
    const changed = changedRecs();
    if (!changed.length) return;
    void flow.askClientDialog("CrpTitlesSaveChanges", "Do you want to save the changes you made to the titles?").then((yes) => { if (yes) return flow.saveCorporationTitles(changed); }).catch(() => {});
  });

  const grouping = $derived<RoleGrouping | null>(view?.forTitles.find((g) => g.roleGroupID === groupingID) ?? null);
  const field = (g: RoleGrouping) => (viewType === 1 ? g.appliesToGrantable : g.appliesTo);
  function toggle(index: number, roleID: bigint, on: boolean): void {
    const g = grouping;
    if (!g) return;
    const f = field(g), rec = recs[index]!;
    recs[index] = { ...rec, [f]: on ? rec[f] | roleID : rec[f] & ~roleID };
  }
  // GetHeaderValues: CorpMemberName, then each column's name with its spaces made line breaks; a column named as its
  // role carries "<name><br><description>" for a hint.
  const headerHint = (column: RoleGrouping["columns"][number]) => { const sub = column.subColumns[0]; return sub && sub.role.shortDescription === column.name ? `${column.name}\n${sub.role.description}` : ""; };
  // UpdateLabelText's hint: the title's name, then a line per sub-column.
  function rowHint(rec: Rec, g: RoleGrouping): string {
    const lines = [rec.titleName];
    for (const column of g.columns) for (const sub of column.subColumns) {
      const corpRole = sub.name ? `${sub.name} - ${column.name}` : column.name;
      lines.push(text(M + ((rec[field(g)] & sub.role.roleID) === sub.role.roleID ? "TitleHasRoleHint" : "TitleDoesNotHaveRoleHint"), { corpRole }));
    }
    return lines.join("\n");
  }
  // The scroll's sort: column 0 by name, the others by their "X" / " " masks.
  const sortKey = (rec: Rec, g: RoleGrouping, column: number) => column === 0 ? rec.titleName.toLowerCase() : g.columns[column - 1]!.subColumns.map((s) => ((rec[field(g)] & s.role.roleID) === s.role.roleID ? "X" : " ")).join("");
  const order = $derived.by(() => {
    const indexes = recs.map((_, i) => i), g = grouping;
    if (sortBy === null || !g) return indexes;
    const by = sortBy;
    const sorted = indexes.slice().sort((a, b) => { const x = sortKey(recs[a]!, g, by), y = sortKey(recs[b]!, g, by); return x < y ? -1 : x > y ? 1 : 0; });
    return reverse ? sorted.reverse() : sorted;
  });
  function sortOn(column: number): void { if (sortBy === column) reverse = !reverse; else { sortBy = column; reverse = false; } }

  // GetAllRolesForTitle: per GetRoleGroupings() group, the title's roles and grantable roles in it.
  const summaryRoles = $derived.by(() => {
    const title = view?.titles.find((t) => t.titleID === summaryTitleID);
    if (!view || !title) return [];
    const roleWord = text("UI/Corporations/Common/Role"), grantWord = text("UI/Corporations/EditMemberDialog/GrantableRole").trim();
    const delimiter = plainText($words.templates["UI/Common/Formatting/ListGenericDelimiter"] ?? ", ");
    return view.groupings.flatMap((g) => {
      const rows: string[] = [];
      for (const column of g.columns) for (const sub of column.subColumns) {
        const id = sub.role.roleID, inRoles = (title[g.appliesTo] & id) === id, inGrant = (title[g.appliesToGrantable] & id) === id;
        if (!inRoles && !inGrant) continue;
        const extra = [inRoles ? roleWord : null, inGrant ? grantWord : null].filter((x): x is string => x !== null).join(delimiter);
        const name = sub.role.shortDescription === column.name ? sub.role.shortDescription : `${sub.role.shortDescription} - ${column.name}`;
        rows.push(`${name} <color=grey>(${extra})</color>`);
      }
      return rows.length ? [{ name: message(g.roleGroupNameID), rows }] : [];
    });
  });
  function setView(value: number): void {
    viewType = value;
    if (value === 2) void loadMembers();
  }
</script>

<div class="ct">
  {#if error}<p class="error">{error}</p>{/if}
  {#if view}
    <div class="ct-options">
      {#if viewType === 2}<button class="ct-collapse" title={text("UI/Common/Buttons/CollapseAll")} onclick={() => { setOpen("members", false); setOpen("roles", false); }}>−</button>{/if}
      <label class="ct-combo"><span>{text("UI/Common/View")}</span>
        <select value={viewType} onchange={(e) => setView(Number(e.currentTarget.value))}>
          <option value={0}>{text("UI/Corporations/Common/Roles")}</option>
          <option value={1}>{text("UI/Corporations/Common/GrantableRoles")}</option>
          <option value={2}>{text("UI/Corporations/Common/TitleSummary")}</option>
        </select></label>
      {#if viewType === 2}
        <label class="ct-combo"><span>{text("UI/Corporations/EditMemberDialog/CorpMemberTitleCaption")}</span>
          <select value={summaryTitleID} onchange={(e) => { summaryTitleID = Number(e.currentTarget.value); void loadMembers(); }}>
            {#each view.titles as t (t.titleID)}<option value={t.titleID}>{t.titleName}</option>{/each}
          </select></label>
      {:else}
        <label class="ct-combo"><span>{text("UI/Common/Type")}</span>
          <select value={groupingID} onchange={(e) => { groupingID = Number(e.currentTarget.value); }}>
            {#each view.forTitles as g (g.roleGroupID)}<option value={g.roleGroupID}>{message(g.roleGroupNameID)}</option>{/each}
          </select></label>
      {/if}
    </div>
    {#if !view.director}
      <p class="ct-hint">{text(M + "AccessDeniedDirectorRoleRequired")}</p>
    {:else if viewType === 2}
      <div class="ct-summary">
        <button class="ct-group" onclick={() => setOpen("members", !membersOpen)}>{text(M + "MembersWithTitle")}</button>
        {#if membersOpen && members}
          {#each members as id (id)}<div class="ct-member"><LabelText markup={`<url=showinfo:1377//${id}>${resolvedName($names.resolved, "owner", id, String(id))}</url>`} {followerOf} /></div>{/each}
        {/if}
        <button class="ct-group" onclick={() => setOpen("roles", !rolesOpen)}>{text(M + "RolesInTitle")}</button>
        {#if rolesOpen}
          {#each summaryRoles as group, gi (gi)}
            <div class="ct-sub"><b>{group.name}</b></div>
            {#each group.rows as row, ri (ri)}<div class="ct-role"><LabelText markup={row} {followerOf} /></div>{/each}
          {/each}
        {/if}
      </div>
    {:else if grouping}
      {@const g = grouping}
      <div class="ct-scroll">
        <div class="ct-row ct-head" style:grid-template-columns={`minmax(140px, 1.6fr) repeat(${g.columns.length}, minmax(64px, 1fr))`}>
          <button onclick={() => sortOn(0)}>{text(M + "CorpMemberName")}</button>
          {#each g.columns as column, ci (ci)}
            <button title={headerHint(column)} onclick={() => sortOn(ci + 1)}>{#each column.name.split(" ") as part, pi (pi)}{#if pi}<br />{/if}{part}{/each}</button>
          {/each}
        </div>
        {#each order as index (recs[index]!.titleID)}
          {@const rec = recs[index]!}
          <div class="ct-row" title={rowHint(rec, g)} style:grid-template-columns={`minmax(140px, 1.6fr) repeat(${g.columns.length}, minmax(64px, 1fr))`}>
            <input class="ct-name" maxlength="100" value={rec.titleName} readonly={view.nameReadOnly} disabled={view.nameReadOnly}
              oninput={(e) => { recs[index] = { ...rec, titleName: e.currentTarget.value.replace(/<\/?(font|fontsize|br)\b[^>]*>/gi, "") }; }} />
            {#each g.columns as column, ci (ci)}
              <span class="ct-cell">
                {#each column.subColumns as sub, si (si)}
                  <label class="ct-check"><input type="checkbox" checked={(rec[field(g)] & sub.role.roleID) === sub.role.roleID}
                    onchange={(e) => toggle(index, sub.role.roleID, e.currentTarget.checked)} />{sub.name}</label>
                {/each}
              </span>
            {/each}
          </div>
        {/each}
      </div>
      <div class="ct-buttons"><button disabled={saving} onclick={() => void save()}>{text("UI/Common/Buttons/SaveChanges")}</button></div>
    {/if}
  {/if}
</div>

<style>
  .ct { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 4px; gap: 4px; }
  .ct-options { display: flex; align-items: flex-end; gap: 6px; min-height: 36px; }
  .ct-combo { display: flex; flex-direction: column; font-size: 10px; opacity: 0.9; width: 146px; }
  .ct-combo select { width: 146px; }
  .ct-collapse { width: 16px; height: 16px; padding: 0; line-height: 12px; }
  .ct-scroll { flex: 1; min-height: 0; overflow: auto; }
  .ct-row { display: grid; align-items: center; min-height: 36px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); padding: 0 4px; gap: 4px; }
  .ct-head { min-height: 28px; font-size: 10px; opacity: 0.8; position: sticky; top: 0; background: rgba(10, 12, 14, 0.95); z-index: 1; }
  .ct-head button { all: unset; cursor: pointer; line-height: 1.15; }
  .ct-name { width: calc(100% - 4px); }
  .ct-cell { display: flex; }
  .ct-check { flex: 1; display: flex; align-items: center; gap: 2px; font-size: 10px; white-space: nowrap; overflow: hidden; }
  .ct-buttons { display: flex; justify-content: center; padding: 4px; }
  .ct-summary { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
  .ct-group { all: unset; cursor: pointer; font-weight: bold; padding: 4px; background: rgba(255, 255, 255, 0.06); margin-top: 2px; }
  .ct-sub { padding: 3px 4px 3px 16px; }
  .ct-role { padding: 1px 4px 1px 28px; }
  .ct-member { padding: 1px 4px 1px 16px; }
  .ct-hint { opacity: 0.8; padding: 4px; }
</style>
