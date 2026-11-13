<script lang="ts">
  // corporation/corp_ui_member_newroles.py CorpRolesNew (Administration > Members > Role Management, a personnel
  // manager's or one with grantable roles) and corp_ui_member_roleentry: the toggle buttons Permissions / Station
  // Service / Accounting (role groupings 1-3: a column per role, one tri-state box each - none, role, grantable role),
  // Access (per division 0-7 a 3 x 3 box grid: HQ / Base / Other rows of hangar query, hangar take and container take)
  // and Titles (a box per title); every row a member's link and a base combo. Two hundred members a view, Prev / Next
  // past that; a search of the members by name (three characters or more). Save Changes sends the changed rows to
  // UpdateMembers (the others', then mine); a change of view or leaving with changes asks CrpMembersSaveChanges.
  import { onDestroy, onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, RoleManagementRow, RoleManagementView } from "../app/flow.ts";
  import type { RoleGrouping, RoleMasks } from "../bridge/corporationRoles.ts";
  import { canEditCorporationRole } from "../bridge/corporationRoles.ts";
  import { MEMBER_ROLE_FIELDS, type CorporationMember } from "../bridge/corporationMemberDetails.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import LabelText from "./LabelText.svelte";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const R = "UI/Corporations/RoleManagement/", M = "UI/Corporations/CorporationWindow/Members/";
  const LABELS = [R + "Permissions", R + "StationService", R + "Accounting", R + "Access", "UI/Corporations/Common/Titles", M + "CorpMemberName", M + "CorpMemberBase",
    R + "Type", R + "HQ", R + "Base", R + "Other", R + "MemberCanView", R + "MemberCanTake", R + "MemberCanTakeCont", R + "None", R + "Role", R + "GrantableRole",
    "UI/Common/Buttons/SaveChanges", "UI/Common/Prev", "UI/Common/Next", "UI/EVEMail/MailingLists/SearchByName", ...Object.keys(LINK_WORDS)];
  const text = (label: string) => plainText(formatTemplate($words.templates[label] ?? "", {} as never, { nameOf: (k, id) => resolvedName($names.resolved, k, id, "") }));
  const followerOf = (url: string, t: string) => linkFollowerOf(url, flow, null, (label) => plainText($words.templates[label] ?? LINK_WORDS[label] ?? ""), t);
  const PERMISSIONS = 1, ACCESS = 4, GROUPS = 5, MEMBERS_PER_PAGE = 200;
  // uiconst NOT_CHECKED 0, HALF_CHECKED 1 (a role), FULL_CHECKED 2 (a grantable role).
  type Check = 0 | 1 | 2;
  interface Rec { masks: RoleMasks; old: RoleMasks; baseID: number | null; oldBaseID: number | null; titleMask: number; oldTitleMask: number; isCEO: boolean; isDirector: boolean }
  interface Box { roleID: bigint; group: RoleGrouping; value: Check; disabled: boolean; director?: boolean }

  let view = $state<RoleManagementView | null>(null), error = $state("");
  const savedState = () => { try { const v = Number(localStorage.getItem("evejs.play.selectedRoleGroupState")); return v >= 1 && v <= 5 ? v : PERMISSIONS; } catch { return PERMISSIONS; } };
  let selected = $state(savedState());
  let members = $state<readonly CorporationMember[]>([]), totalCount = $state(0), viewFrom = $state(0);
  let recs = $state<Record<number, Rec>>({});
  // A row's boxes: role views keyed by column index, Access by "division:box", Titles by titleID.
  let boxes = $state<Record<number, Record<string, Box>>>({});
  let search = $state(""), results = $state<readonly { id: number; name: string }[]>([]), searched = $state<number | null>(null);
  let sortBy = $state<string | null>(null), reverse = $state(false), saving = $state(false);

  const LOCATION_FIELDS = { roles: "grantableRoles", rolesAtHQ: "grantableRolesAtHQ", rolesAtBase: "grantableRolesAtBase", rolesAtOther: "grantableRolesAtOther" } as const;
  // BaseRoleEntry.GetMembersListData: a CEO's or director's roles are every grouping's mask (roles replaced, the rest
  // added to), their grantable roles too, a director's grantable roles without Director.
  function recOf(member: CorporationMember, v: RoleManagementView): Rec {
    const masks = { ...member.masks };
    const isCEO = member.characterID === v.ceoID, isDirector = (member.masks.roles & 1n) === 1n;
    if (isCEO || isDirector) {
      masks.roles = 0n;
      for (const g of v.groupings) { masks[g.appliesTo] |= BigInt(g.roleMask); masks[g.appliesToGrantable] |= BigInt(g.roleMask); }
      if (isDirector) masks.grantableRoles &= ~1n;
    }
    return { masks, old: { ...masks }, baseID: member.baseID, oldBaseID: member.baseID, titleMask: member.titleMask, oldTitleMask: member.titleMask, isCEO, isDirector };
  }
  const checkState = (roles: bigint, grantable: bigint, roleID: bigint): Check =>
    (roles & roleID) === 1n ? 1 : (grantable & roleID) === roleID ? 2 : (roles & roleID) === roleID ? 1 : 0;
  function canEdit(rec: Rec, roleID: bigint, value: Check, appliesTo: RoleGrouping["appliesTo"], v: RoleManagementView): boolean {
    return canEditCorporationRole(roleID, value === 2, rec.isCEO, rec.isDirector, v.iAmCEO, v.iAmDirector, appliesTo, v.myBaseID, rec.baseID, v.grants);
  }
  function boxesFor(member: CorporationMember, rec: Rec, v: RoleManagementView): Record<string, Box> {
    const out: Record<string, Box> = {};
    const directorOrCEO = member.characterID === v.ceoID || (member.masks.roles & 1n) === 1n;
    if (selected === ACCESS) {
      // RoleBoxes.GetCheckedRoles: groupings 4-9; a hangar grouping's boxes at CB_OFFSET + the sub-column's place.
      const offset: Record<number, number> = { 4: 0, 5: 2, 6: 3, 7: 5, 8: 6, 9: 8 };
      v.divisionNames.forEach((divisionName, division) => {
        for (const g of v.groupings) {
          if (g.roleGroupID < 4 || g.roleGroupID > 9) continue;
          let roles = member.masks[g.appliesTo], grantable = member.masks[g.appliesToGrantable];
          if (directorOrCEO) { roles |= BigInt(g.roleMask); grantable |= BigInt(g.roleMask); }
          for (const column of g.columns) {
            if (column.name !== divisionName) continue;
            column.subColumns.forEach((sub, n) => {
              const place = offset[g.roleGroupID]! + ([4, 6, 8].includes(g.roleGroupID) ? n : 0);
              const id = sub.role.roleID, value: Check = (grantable & id) === id ? 2 : (roles & id) === id ? 1 : 0;
              out[`${division}:${place}`] = { roleID: id, group: g, value, disabled: !canEditCorporationRole(id, value === 2, member.characterID === v.ceoID, (member.masks.roles & 1n) === 1n, v.iAmCEO, v.iAmDirector, g.appliesTo, v.myBaseID, member.baseID, v.grants) };
            });
          }
        }
      });
    } else if (selected === GROUPS) {
      for (const t of v.titles) out[String(t.titleID)] = { roleID: BigInt(t.titleID), group: v.groupings[0]!, value: (member.titleMask & t.titleID) === t.titleID ? 1 : 0, disabled: false };
    } else {
      // RoleEntry.SetCheckboxAttributes: the member row's masks (all of the grouping's for a CEO or director); the box
      // takes its last sub-column's role.
      const g = grouping();
      if (!g) return out;
      g.columns.forEach((column, ci) => {
        let roles = member.masks[g.appliesTo], grantable = member.masks[g.appliesToGrantable];
        if (directorOrCEO) { roles |= BigInt(g.roleMask); grantable |= BigInt(g.roleMask); }
        let box: Box | null = null;
        for (const sub of column.subColumns) box = { roleID: sub.role.roleID, group: g, value: checkState(roles, grantable, sub.role.roleID), disabled: false, director: sub.role.roleID === 1n };
        if (box) { box.disabled = !canEdit(rec, box.roleID, box.value, g.appliesTo, v); out[String(ci)] = box; }
      });
    }
    return out;
  }
  const grouping = () => view?.groupings.find((g) => g.roleGroupID === selected) ?? null;
  function build(): void {
    const v = view;
    if (!v) return;
    // The rows shown are the collection's own, which OnCorporationMemberChanged writes into.
    members = members.map((member) => flow.loadedCorporationMember(member.characterID) ?? member);
    const nextRecs: Record<number, Rec> = {}, nextBoxes: Record<number, Record<string, Box>> = {};
    for (const member of members) { const rec = recOf(member, v); nextRecs[member.characterID] = rec; nextBoxes[member.characterID] = boxesFor(member, rec, v); }
    recs = nextRecs; boxes = nextBoxes;
  }
  async function loadMembers(): Promise<void> {
    if (searched !== null) { const m = await flow.roleManagementMember(searched); members = m ? [m] : []; }
    else { const page = await flow.roleManagementMembers(viewFrom, MEMBERS_PER_PAGE); members = page.members; totalCount = page.totalCount; }
  }
  const dirtyRows = (): RoleManagementRow[] => members.flatMap((member) => {
    const rec = recs[member.characterID];
    if (!rec) return [];
    const changed = MEMBER_ROLE_FIELDS.some((f) => rec.masks[f] !== rec.old[f]) || rec.baseID !== rec.oldBaseID || rec.titleMask !== rec.oldTitleMask;
    return changed ? [{ characterID: member.characterID, masks: rec.masks, baseID: rec.baseID, titleMask: rec.titleMask, oldTitleMask: rec.oldTitleMask }] : [];
  });
  async function save(): Promise<void> {
    const rows = dirtyRows();
    if (!rows.length || saving) return;
    saving = true;
    try {
      await flow.saveRoleManagement(rows);
      // UpdateOldRolesForNode
      for (const row of rows) { const rec = recs[row.characterID]!; recs[row.characterID] = { ...rec, old: { ...rec.masks }, oldBaseID: rec.baseID, oldTitleMask: rec.titleMask }; }
    } catch (e) { error = e instanceof Error ? e.message : String(e); } finally { saving = false; }
  }
  // ChangeState: with changes, CrpMembersSaveChanges - Yes saves, No clears them; then the view is drawn again.
  async function changeState(state: number, reload = false): Promise<void> {
    if (dirtyRows().length) {
      const yes = await flow.askClientDialog("CrpMembersSaveChanges", "Do you want to save the changes you made to the members' roles?");
      if (yes) await save();
    }
    selected = state;
    try { localStorage.setItem("evejs.play.selectedRoleGroupState", String(state)); } catch { /* not kept */ }
    try { if (reload) await loadMembers(); build(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  onMount(() => {
    flow.requestWords(LABELS);
    void (async () => {
      try { view = await flow.roleManagementView(); totalCount = view.totalCount; await loadMembers(); build(); }
      catch (e) { error = e instanceof Error ? e.message : String(e); }
    })();
  });
  onDestroy(() => {
    const rows = dirtyRows();
    if (rows.length) void flow.askClientDialog("CrpMembersSaveChanges", "Do you want to save the changes you made to the members' roles?").then((yes) => { if (yes) return flow.saveRoleManagement(rows); }).catch(() => {});
  });

  // BaseRoleEntry.OnCbClick: full - role and grantable; half - role only; none - neither. The Director box: on, every
  // grouping's mask as role and grantable (grantable Director off) and the other boxes full and disabled; off, every
  // mask cleared and the others none and enabled.
  function click(characterID: number, key: string): void {
    const v = view, rec = recs[characterID], row = boxes[characterID], box = row?.[key];
    if (!v || !rec || !row || !box || box.disabled) return;
    if (selected === GROUPS) {
      const value: Check = box.value ? 0 : 1, id = Number(box.roleID);
      recs[characterID] = { ...rec, titleMask: value ? rec.titleMask | id : rec.titleMask & ~id };
      boxes[characterID] = { ...row, [key]: { ...box, value } };
      return;
    }
    let value: Check = box.director ? (box.value ? 0 : 1) : (((box.value + 1) % 3) as Check);
    const masks = { ...rec.masks }, g = box.group, id = box.roleID;
    if (value === 2) { masks[g.appliesTo] |= id; masks[g.appliesToGrantable] |= id; }
    else if (value === 1) { masks[g.appliesToGrantable] &= ~id; masks[g.appliesTo] |= id; }
    else { masks[g.appliesToGrantable] &= ~id; masks[g.appliesTo] &= ~id; }
    let isDirector = rec.isDirector, next = { ...row, [key]: { ...box, value } };
    if (id === 1n) {
      if (value) {
        isDirector = (masks.roles & 1n) !== 0n; masks.grantableRoles &= ~1n;
        for (const group of v.groupings) { masks[group.appliesTo] |= BigInt(group.roleMask); masks[group.appliesToGrantable] |= BigInt(group.roleMask); }
      } else for (const f of MEMBER_ROLE_FIELDS) masks[f] = 0n;
      for (const [k, b] of Object.entries(next)) if (b.roleID !== 1n) next[k] = { ...b, value: value ? 2 : 0, disabled: !!value };
      value = value ? 1 : 0;
    }
    recs[characterID] = { ...rec, masks, isDirector };
    boxes[characterID] = next;
  }
  function setBase(characterID: number, raw: string): void { const rec = recs[characterID]; if (rec) recs[characterID] = { ...rec, baseID: raw === "" ? null : Number(raw) }; }

  async function onSearch(value: string): Promise<void> {
    search = value;
    if (value === "") { results = []; searched = null; await changeState(selected, true); return; }
    try { results = await flow.searchCorporationMembers(value); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  async function pick(id: number): Promise<void> { results = []; searched = id; await changeState(selected, true); }
  async function browse(increment: number): Promise<void> { viewFrom = Math.max(0, viewFrom + increment * MEMBERS_PER_PAGE); searched = null; await changeState(selected, true); }
  const viewPage = $derived(Math.floor(viewFrom / MEMBERS_PER_PAGE) + 1), viewPagesTotal = $derived(Math.floor(totalCount / MEMBERS_PER_PAGE) + 1);

  // The headers: Name, Base, then the grouping's columns (a column named as its role hinted with its description), the
  // Access view's Type and division names, or the titles by ID.
  const headers = $derived.by(() => {
    const v = view;
    if (!v) return [] as { id: string; label: string; hint: string }[];
    const base = [{ id: "name", label: text(M + "CorpMemberName"), hint: "" }, { id: "base", label: text(M + "CorpMemberBase"), hint: "" }];
    if (selected === ACCESS) return [...base, { id: "type", label: text(R + "Type"), hint: "" }, ...v.divisionNames.map((name, i) => ({ id: `d${i}`, label: name, hint: "" }))];
    if (selected === GROUPS) return [...base, ...v.titles.map((t) => ({ id: `t${t.titleID}`, label: t.titleName, hint: "" }))];
    const g = v.groupings.find((x) => x.roleGroupID === selected);
    return [...base, ...(g?.columns ?? []).map((column, ci) => { const sub = column.subColumns.find((s) => s.role.shortDescription === column.name); return { id: `c${ci}`, label: column.name, hint: sub ? `${column.name}\n${sub.role.description}` : "" }; })];
  });
  const nameOf = (id: number) => resolvedName($names.resolved, "owner", id, String(id));
  function sortValue(member: CorporationMember, id: string): string | number {
    if (id === "name") return nameOf(member.characterID).toLowerCase();
    if (id === "base") return member.baseID ? resolvedName($names.resolved, "station", member.baseID, "") : "";
    const row = boxes[member.characterID] ?? {};
    if (id.startsWith("c")) return row[id.slice(1)]?.value ?? 0;
    if (id.startsWith("t")) return row[id.slice(1)]?.value ?? 0;
    if (id.startsWith("d")) return Object.entries(row).filter(([k]) => k.startsWith(`${id.slice(1)}:`)).reduce((sum, [, b]) => sum + b.value, 0);
    return 0;
  }
  const ordered = $derived.by(() => {
    const by = sortBy ?? "name";
    const list = members.slice().sort((a, b) => { const x = sortValue(a, by), y = sortValue(b, by); return x < y ? -1 : x > y ? 1 : 0; });
    return reverse ? list.reverse() : list;
  });
  function sortOn(id: string): void { if ((sortBy ?? "name") === id) reverse = !reverse; else { sortBy = id; reverse = false; } }
  const columns = $derived(selected === ACCESS ? `100px 100px 50px repeat(8, 80px)` : `100px 100px repeat(${Math.max(0, headers.length - 2)}, 45px)`);
  const legend = $derived(`${text(R + "None")} / ${text(R + "Role")} / ${text(R + "GrantableRole")}`);
</script>

<div class="rm">
  {#if error}<p class="error">{error}</p>{/if}
  {#if view}
    <div class="rm-top">
      <input class="rm-search" maxlength="100" placeholder={text("UI/EVEMail/MailingLists/SearchByName")} value={search} oninput={(e) => void onSearch(e.currentTarget.value)} />
      {#if results.length}
        <div class="rm-results">{#each results as r (r.id)}<button onclick={() => void pick(r.id)}>{r.name}</button>{/each}</div>
      {/if}
      <div class="rm-toggles">
        {#each [[1, R + "Permissions"], [2, R + "StationService"], [3, R + "Accounting"], [4, R + "Access"], [5, "UI/Corporations/Common/Titles"]] as [state, label] (state)}
          <button class:active={selected === state} onclick={() => void changeState(Number(state))}>{text(String(label))}</button>
        {/each}
      </div>
    </div>
    <div class="rm-scroll">
      <div class="rm-row rm-head" style:grid-template-columns={columns}>
        {#each headers as h (h.id)}<button class="rm-vhead" class:left={h.id === "name" || h.id === "base" || h.id === "type"} title={h.hint || h.label} onclick={() => sortOn(h.id)}><span>{h.label}</span></button>{/each}
      </div>
      {#if selected === ACCESS}
        <!-- RoleHeaderEntry: the query, take and container icons over each division. -->
        <div class="rm-row rm-icons" style:grid-template-columns={columns}>
          <span></span><span></span><span></span>
          {#each view.divisionNames as _, i (i)}<span class="rm-icon-set"><span title={text(R + "MemberCanView")}>Q</span><span title={text(R + "MemberCanTake")}>T</span><span title={text(R + "MemberCanTakeCont")}>C</span></span>{/each}
        </div>
      {/if}
      {#each ordered as member (member.characterID)}
        {@const rec = recs[member.characterID]}
        {@const row = boxes[member.characterID] ?? {}}
        <div class="rm-row" class:rm-access={selected === ACCESS} style:grid-template-columns={columns}>
          <span class="rm-name" title={nameOf(member.characterID)}><LabelText markup={`<url=showinfo:1377//${member.characterID}>${nameOf(member.characterID)}</url>`} {followerOf} /></span>
          <select class="rm-base" value={rec?.baseID ?? ""} onchange={(e) => setBase(member.characterID, e.currentTarget.value)}>
            {#each view.bases as b (b.stationID ?? 0)}<option value={b.stationID ?? ""}>{b.name}</option>{/each}
          </select>
          {#if selected === ACCESS}
            <span class="rm-types"><span>{text(R + "HQ")}</span><span>{text(R + "Base")}</span><span>{text(R + "Other")}</span></span>
            {#each view.divisionNames as _, d (d)}
              <span class="rm-grid">
                {#each [0, 1, 2, 3, 4, 5, 6, 7, 8] as place (place)}
                  {@const box = row[`${d}:${place}`]}
                  <button class="rm-cb v{box?.value ?? 0}" title={legend} disabled={!box || box.disabled} onclick={() => click(member.characterID, `${d}:${place}`)} aria-label={legend}></button>
                {/each}
              </span>
            {/each}
          {:else if selected === GROUPS}
            {#each view.titles as t (t.titleID)}
              {@const box = row[String(t.titleID)]}
              <span class="rm-cell"><input type="checkbox" checked={!!box?.value} onchange={() => click(member.characterID, String(t.titleID))} /></span>
            {/each}
          {:else}
            {#each headers.slice(2) as h, ci (h.id)}
              {@const box = row[String(ci)]}
              <span class="rm-cell">
                {#if box?.director}
                  <input type="checkbox" checked={!!box.value} disabled={box.disabled} onchange={() => click(member.characterID, String(ci))} />
                {:else}
                  <button class="rm-cb v{box?.value ?? 0}" title={legend} disabled={!box || box.disabled} onclick={() => click(member.characterID, String(ci))} aria-label={legend}></button>
                {/if}
              </span>
            {/each}
          {/if}
        </div>
      {/each}
    </div>
    {#if totalCount >= MEMBERS_PER_PAGE}
      <div class="rm-browse">
        <button disabled={viewPage === 1} onclick={() => void browse(-1)}>{text("UI/Common/Prev")}</button>
        <span>{viewPage}/{viewPagesTotal}</span>
        <button disabled={viewPage >= viewPagesTotal} onclick={() => void browse(1)}>{text("UI/Common/Next")}</button>
      </div>
    {/if}
    <div class="rm-buttons"><button disabled={saving} onclick={() => void save()}>{text("UI/Common/Buttons/SaveChanges")}</button></div>
  {/if}
</div>

<style>
  .rm { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 4px; gap: 4px; position: relative; }
  .rm-top { display: flex; flex-direction: column; gap: 4px; min-height: 70px; justify-content: flex-end; position: relative; }
  .rm-search { position: absolute; top: 0; right: 0; width: 120px; }
  .rm-results { position: absolute; top: 22px; right: 0; z-index: 3; display: flex; flex-direction: column; background: rgba(10, 12, 14, 0.97); border: 1px solid rgba(255, 255, 255, 0.15); min-width: 120px; }
  .rm-results button { all: unset; cursor: pointer; padding: 2px 6px; }
  .rm-results button:hover { background: rgba(255, 255, 255, 0.08); }
  .rm-toggles { display: flex; gap: 2px; }
  .rm-toggles button { flex: 0 0 auto; padding: 2px 10px; }
  .rm-toggles button.active { background: rgba(255, 255, 255, 0.18); }
  .rm-scroll { flex: 1; min-height: 0; overflow: auto; }
  .rm-row { display: grid; align-items: center; min-height: 32px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  .rm-row.rm-access { min-height: 68px; }
  .rm-head { height: 60px; align-items: end; position: sticky; top: 0; background: rgba(10, 12, 14, 0.95); z-index: 1; }
  .rm-vhead { all: unset; cursor: pointer; height: 60px; display: flex; align-items: flex-end; justify-content: center; border-right: 1px solid rgba(255, 255, 255, 0.08); overflow: hidden; }
  .rm-vhead span { writing-mode: vertical-rl; transform: rotate(180deg); font-size: 10px; white-space: nowrap; padding: 2px 0; }
  .rm-vhead.left { justify-content: flex-start; padding-left: 4px; }
  .rm-vhead.left span { writing-mode: horizontal-tb; transform: none; }
  .rm-icons { min-height: 18px; font-size: 10px; opacity: 0.6; }
  .rm-icon-set { display: flex; justify-content: center; gap: 12px; }
  .rm-name { padding-left: 6px; overflow: hidden; white-space: nowrap; }
  .rm-base { width: 92px; margin-left: 4px; }
  .rm-types { display: flex; flex-direction: column; gap: 6px; font-size: 10px; padding-left: 4px; }
  .rm-cell { display: flex; justify-content: center; }
  .rm-grid { display: grid; grid-template-columns: repeat(3, 16px); gap: 4px; justify-content: center; }
  .rm-cb { width: 16px; height: 16px; padding: 0; border: 1px solid rgba(255, 255, 255, 0.4); background: transparent; }
  .rm-cb.v1 { background: linear-gradient(135deg, rgba(200, 200, 200, 0.85) 50%, transparent 50%); }
  .rm-cb.v2 { background: rgba(230, 230, 230, 0.9); }
  .rm-cb:disabled { opacity: 0.3; }
  .rm-browse { display: flex; justify-content: space-between; align-items: center; }
  .rm-buttons { display: flex; justify-content: center; padding: 4px; }
</style>
