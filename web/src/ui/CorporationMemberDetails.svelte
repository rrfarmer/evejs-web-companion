<script lang="ts">
  // EditMemberDialog: all panels share one unsaved member state.
  import { onMount, untrack } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { CorporationMemberDetails, MemberDetailsTabID } from "../bridge/corporationMemberDetails.ts";
  import { memberTitleOf } from "../bridge/corporationMemberDetails.ts";
  import { canEditCorporationRole, changeCorporationRole, memberRolesSummary, type CorporationRole, type RoleMasks, type CorporationTitle, type CorporationRoleSummaryGroup, type CorporationRoleSummaryRow } from "../bridge/corporationRoles.ts";
  import { DATE_LABELS, LIST_DELIMITER, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import OwnerPicture from "./OwnerPicture.svelte";
  import { portraitDefaultPath, portraitUrl } from "./ownerImages.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow, onClose }: { store: ClientStore; flow: AppFlow; onClose?: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const target = flow.memberDetailsShown;
  // svelte-ignore state_referenced_locally
  const imageServer = flow.imageServer;
  const characterID = $derived($target?.characterID ?? null);
  const LABELS = {
    caption: "UI/Corporations/EditMemberDialog/EditMemberCaption", general: "UI/Generic/General",
    title: "UI/Corporations/EditMemberDialog/CorpMemberTitleCaption", base: "UI/Corporations/EditMemberDialog/CorpMemberBaseCaption",
    joined: "UI/Corporations/EditMemberDialog/CorpMemberJoined", name: "UI/Corporations/EditMemberDialog/Name",
    gender: "UI/Common/Gender/Gender", male: "UI/Common/Gender/Male", female: "UI/Common/Gender/Female", race: "UI/Common/Race",
    born: "UI/Corporations/EditMemberDialog/DateOfBirth", security: "UI/Corporations/EditMemberDialog/SecurityStatus",
    noBase: "UI/Corporations/EditMemberDialog/NoBase", baseName: "UI/Corporations/EditMemberDialog/CorpMemberBase",
    ok: "UI/Common/Buttons/OK", cancel: "UI/Common/Buttons/Cancel", apply: "UI/Corporations/EditMemberDialog/Apply",
    shares: "UI/Corporations/EditMemberDialog/GiveShares",
    roles: "UI/Corporations/Common/Roles", grantable: "UI/Corporations/Common/GrantableRoles",
    view: "UI/Common/View", group: "UI/Corporations/Common/GroupType", yes: "UI/Common/Yes", no: "UI/Common/No",
    titles: "UI/Corporations/Common/Titles",
    summary: "UI/Corporations/EditMemberDialog/RolesSummary", role: "UI/Corporations/Common/Role",
    grantableRole: "UI/Corporations/EditMemberDialog/GrantableRole", byTitle: "UI/Corporations/EditMemberDialog/RoleByTitle",
    roleCount: "UI/Corporations/EditMemberDialog/RoleAndNumber", nothing: "UI/Common/NothingFound", delimiter: LIST_DELIMITER,
  };
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? fallback);
  const fill = (label: string, args: Record<string, string | number | { type: "long"; value: string }>, fallback = "") => plainText(formatTemplate($words.templates[label] ?? fallback, args, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  const date = (value: bigint) => fill(DATE_LABELS.ls!, { datetime: { type: "long", value: value.toString() } });
  let held = $state<CorporationMemberDetails | null>(null);
  let title = $state("");
  let base = $state("");
  let masks = $state<RoleMasks | null>(null);
  const initialRequest = target.get();
  let active = $state<MemberDetailsTabID>(untrack(() => flow.memberDetailsPanel(initialRequest?.tabID)));
  let servedRequest = initialRequest?.n;
  let titleMask = $state(0);
  let titles = $state<readonly CorporationTitle[] | null>(null);
  let titlesLoading = $state(false);
  let titleSerial = 0;
  let summary = $state<readonly CorporationRoleSummaryGroup[] | null>(null);
  let summaryLoading = $state(false);
  let summarySerial = 0;
  let summaryOpen = $state<Record<number, boolean>>({});
  let grantable = $state("0");
  let groupID = $state("1");
  let rolesLoading = $state(false);
  let roleSerial = 0;
  const group = $derived(held?.roleGroups.find(group => group.groupID === Number(groupID)));
  const roleField = $derived(group ? grantable === "1" ? group.appliesToGrantable : group.appliesTo : "roles");
  const targetIsDirector = $derived(masks !== null && (masks.roles & 1n) !== 0n);
  const canEditTitles = $derived(Boolean(held?.viewerIsDirector && !held.targetIsCEO && !targetIsDirector));
  let busy = $state(false);
  let error = $state("");
  let serial = 0;
  let disposed = false;
  function keep(value: CorporationMemberDetails): void { held = value; title = value.member.title; base = value.member.baseID?.toString() ?? ""; masks = { ...value.member.masks }; titleMask = value.member.titleMask; }
  function selectPanel(panel: MemberDetailsTabID): void {
    // Load runs the previous tab's DDX before switching, without submitting it.
    if (active === "general" && held?.canEditTitle) title = memberTitleOf(title);
    active = panel;
    flow.memberDetailsPanel(panel);
    if (panel === "roles") void refreshRoleBase();
    if (panel === "titles") void refreshTitles();
    if (panel === "roles_summary") void refreshSummary();
  }
  $effect(() => {
    const request = $target;
    if (!request || request.n === servedRequest) return;
    servedRequest = request.n;
    const tabID = request.tabID;
    if (tabID) untrack(() => { if (active !== tabID) selectPanel(tabID); });
  });
  async function refreshSummary(): Promise<void> {
    if (!held || !masks) return;
    const request = ++summarySerial, targetRequest = serial;
    summaryLoading = true;
    try {
      const authority = await flow.corporationMemberSummary(held);
      if (!disposed && request === summarySerial && targetRequest === serial && held && masks) {
        summary = memberRolesSummary(held.roleGroups, masks, held.member.titleMask, held.targetIsCEO, authority.titles, authority.showTitleNames);
        summaryOpen = Object.fromEntries(summary.map(group => [group.groupID, flow.corporationSummaryGroupOpen(group.groupID)]));
      }
    } catch (cause) { if (!disposed && request === summarySerial && targetRequest === serial) error = cause instanceof Error ? cause.message : String(cause); }
    finally { if (!disposed && request === summarySerial) summaryLoading = false; }
  }
  function summaryRoleName(name: string): string {
    // GetSubContentRoleSummary shortens the division name before the label's line break.
    if (name.length > 25 && name.includes("-<br>")) {
      const [division, type] = name.split("-<br>");
      name = `${division!.slice(0, 25)}... -<br>${type}`;
    }
    return plainText(name);
  }
  function summaryParts(row: CorporationRoleSummaryRow): readonly { label: string; titles?: string }[] {
    return [...(row.role ? [{ label: word(LABELS.role, "Role") }] : []), ...(row.grantable ? [{ label: word(LABELS.grantableRole, "Grantable role").trim() }] : []),
      ...(row.byTitle ? [{ label: word(LABELS.byTitle, "Role by title"), titles: row.titles.map(plainText).join(word(LABELS.delimiter, ", ")) }] : [])];
  }
  async function refreshTitles(): Promise<void> {
    const request = ++titleSerial, targetRequest = serial;
    titlesLoading = true;
    try {
      const rows = await flow.corporationMemberTitles(held?.assertCurrent);
      if (!disposed && request === titleSerial && targetRequest === serial) titles = rows;
    } catch (cause) { if (!disposed && request === titleSerial && targetRequest === serial) error = cause instanceof Error ? cause.message : String(cause); }
    finally { if (!disposed && request === titleSerial) titlesLoading = false; }
  }
  function hasTitle(id: number): boolean { return Boolean(held?.targetIsCEO || targetIsDirector || (titleMask & id) === id); }
  async function refreshRoleBase(): Promise<void> {
    if (!held) return;
    const request = ++roleSerial, targetRequest = serial;
    rolesLoading = true;
    try {
      const myBaseID = await flow.corporationMemberRoleBase(held.assertCurrent);
      if (!disposed && request === roleSerial && targetRequest === serial && held) held = { ...held, myBaseID };
    } catch (cause) { if (!disposed && request === roleSerial && targetRequest === serial) error = cause instanceof Error ? cause.message : String(cause); }
    finally { if (!disposed && request === roleSerial) rolesLoading = false; }
  }
  function editable(role: CorporationRole): boolean {
    return Boolean(held && group && canEditCorporationRole(role.roleID, grantable === "1", held.targetIsCEO, targetIsDirector, held.viewerIsCEO, held.viewerIsDirector, group.appliesTo, held.myBaseID, base ? Number(base) : null, held.grants));
  }
  function hasRole(role: CorporationRole): boolean {
    return Boolean(held && masks && (held.targetIsCEO || (targetIsDirector && !(grantable === "1" && role.roleID === 1n)) || (masks[roleField] & role.roleID) === role.roleID));
  }
  function changeRole(role: CorporationRole, checked: boolean): void {
    if (masks && editable(role)) masks = changeCorporationRole(masks, roleField, role.roleID, checked);
    if (roleField === "roles" && role.roleID === 1n) void refreshRoleBase();
  }
  async function load(id: number): Promise<void> {
    const request = ++serial;
    held = null; error = ""; busy = true;
    try {
      const value = await flow.corporationMemberDetails(id, () => {
        if (disposed || request !== serial) throw Object.assign(new Error("This member window has been replaced."), { code: "SESSION_REQUEST_RETIRED" });
      });
      if (!disposed && request === serial) {
        keep(value);
        if (active === "titles") await refreshTitles();
        else if (active === "roles") await refreshRoleBase();
        else if (active === "roles_summary") await refreshSummary();
      }
    }
    catch (cause) { if (!disposed && request === serial) {
      if ((cause as { code?: string })?.code === "CORPORATION_MEMBER_GONE") onClose?.();
      else error = cause instanceof Error ? cause.message : String(cause);
    } }
    finally { if (!disposed && request === serial) busy = false; }
  }
  async function apply(close: boolean): Promise<void> {
    if (!held || !masks || busy) return;
    const request = serial;
    busy = true; error = "";
    try {
      const before = held;
      const value = await flow.saveCorporationMember(before, title, base ? Number(base) : null, masks, titleMask);
      if (!disposed && request === serial) {
        keep(value);
        if (value !== before && active === "roles") await refreshRoleBase();
        else if (value !== before && active === "titles") await refreshTitles();
        else if (value !== before && active === "roles_summary") await refreshSummary();
        if (!disposed && request === serial && close) onClose?.();
      }
    } catch (cause) { if (!disposed && request === serial) error = cause instanceof Error ? cause.message : String(cause); }
    finally { if (!disposed && request === serial) busy = false; }
  }
  async function giveShares(): Promise<void> {
    if (!held || busy) return;
    const request = serial, id = held.member.characterID;
    busy = true; error = "";
    try { await flow.giveCorporationShares(id, held.assertCurrent); }
    catch (cause) { if (!disposed && request === serial) error = cause instanceof Error ? cause.message : String(cause); }
    finally { if (!disposed && request === serial) busy = false; }
  }
  const portrait = $derived(characterID === null ? null : portraitUrl($imageServer, characterID, 128));
  onMount(() => {
    flow.requestWords([...Object.values(LABELS), DATE_LABELS.ls!]);
    flow.loadImageServer();
    return () => { disposed = true; serial++; };
  });
  $effect(() => { const id = characterID; if (id !== null) untrack(() => { void load(id); }); });
</script>

<section class="panel member-details">
  <header class="panel-head"><h2 class="panel-title">{word(LABELS.caption, "Member Details")}</h2></header>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if held}
    <div class="identity">
      <OwnerPicture name={held.name} urls={portrait ? [portrait, clientTexture(portraitDefaultPath(128))] : [clientTexture(portraitDefaultPath(128))]} size={64} />
      <div><h3>{held.name}</h3>{#if held.member.title}<p>{held.member.title}</p>{/if}</div>
    </div>
    <div class="member-tabs" role="tablist" aria-label="Member details panels">
      <button type="button" role="tab" aria-selected={active === "general"} onclick={() => selectPanel("general")}>{word(LABELS.general, "General")}</button>
      <button type="button" role="tab" aria-selected={active === "roles"} onclick={() => selectPanel("roles")}>{word(LABELS.roles, "Roles")}</button>
      <button type="button" role="tab" aria-selected={active === "titles"} onclick={() => selectPanel("titles")}>{word(LABELS.titles, "Titles")}</button>
      <button type="button" role="tab" aria-selected={active === "roles_summary"} onclick={() => selectPanel("roles_summary")}>{word(LABELS.summary, "Roles summary")}</button>
    </div>
    <div class="member-body">
    {#if active === "general"}
    {#if held.canEditTitle}
      <label>{word(LABELS.title, "Title")}<input aria-label={word(LABELS.title, "Title")} maxlength="100" bind:value={title} disabled={busy} /></label>
    {:else if !held.canEditBase}<p>{word(LABELS.title, "Title")}: {held.member.title}</p>{/if}
    {#if held.canEditBase}
      <label>{word(LABELS.base, "Base")}<select aria-label={word(LABELS.base, "Base")} bind:value={base} disabled={busy}>
        <option value="">{word(LABELS.noBase, "No base")}</option>
        {#each held.bases as office (office.stationID)}<option value={String(office.stationID)}>{fill(LABELS.baseName, { station: office.stationID }, office.name)}</option>{/each}
      </select></label>
    {/if}
    <dl>
      {#if !held.canEditBase}<dt>{word(LABELS.base, "Base")}</dt><dd>{held.member.baseID ? fill(LABELS.baseName, { station: held.member.baseID }) : ""}</dd>{/if}
      <dt>{word(LABELS.joined, "Joined")}</dt><dd>{date(held.member.startDateTime)}</dd>
      <dt>{word(LABELS.name, "Name")}</dt><dd>{held.name}</dd>
      <dt>{word(LABELS.gender, "Gender")}</dt><dd>{word(held.gender ? LABELS.male : LABELS.female, held.gender ? "Male" : "Female")}</dd>
      <dt>{word(LABELS.race, "Race")}</dt><dd>{word(`#${held.raceNameID}`, "")}</dd>
      <dt>{word(LABELS.born, "Date of birth")}</dt><dd>{date(held.createDateTime)}</dd>
      <dt>{word(LABELS.security, "Security status")}</dt><dd>{held.security.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</dd>
    </dl>
    {:else if active === "roles"}
      <div class="role-views">
        <label>{word(LABELS.view, "View")}<select aria-label={word(LABELS.view, "View")} bind:value={grantable} onchange={() => void refreshRoleBase()}>
          <option value="0">{word(LABELS.roles, "Roles")}</option><option value="1">{word(LABELS.grantable, "Grantable roles")}</option>
        </select></label>
        <label>{word(LABELS.group, "Group type")}<select aria-label={word(LABELS.group, "Group type")} bind:value={groupID} onchange={() => void refreshRoleBase()}>
          {#each held.roleGroups as roleGroup (roleGroup.groupID)}<option value={String(roleGroup.groupID)}>{word(`#${roleGroup.roleGroupNameID}`, "")}</option>{/each}
        </select></label>
      </div>
      {#if rolesLoading}<p>Reading roles…</p>{:else if group}
        <ul class="role-list">
          {#each group.roles as role (role.roleID)}
            <li>
              <div class="role-name">
                {#if editable(role)}
                  <label><input type="checkbox" aria-label={word(`#${role.nameID}`, "")} checked={hasRole(role)} disabled={busy} onchange={event => changeRole(role, event.currentTarget.checked)} />{word(`#${role.nameID}`, "")}</label>
                {:else}
                  <span role="img" aria-label={`${word(`#${role.nameID}`, "")}: ${word(hasRole(role) ? LABELS.yes : LABELS.no, hasRole(role) ? "Yes" : "No")}`}>{hasRole(role) ? "✓" : "—"}</span><span>{word(`#${role.nameID}`, "")}</span>
                {/if}
              </div>
              <p>{word(`#${role.descriptionID}`, "")}</p>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if active === "titles"}
      {#if titlesLoading}<p>Reading titles…</p>{:else if titles}
        <ul class="role-list">
          {#each titles as assigned (assigned.titleID)}
            <li class="role-name">
              {#if canEditTitles}
                <label><input type="checkbox" aria-label={plainText(assigned.titleName)} checked={hasTitle(assigned.titleID)} disabled={busy} onchange={event => { titleMask = event.currentTarget.checked ? titleMask | assigned.titleID : titleMask & ~assigned.titleID; }} />{plainText(assigned.titleName)}</label>
              {:else}
                <span role="img" aria-label={`${plainText(assigned.titleName)}: ${word(hasTitle(assigned.titleID) ? LABELS.yes : LABELS.no, hasTitle(assigned.titleID) ? "Yes" : "No")}`}>{hasTitle(assigned.titleID) ? "✓" : "—"}</span><span>{plainText(assigned.titleName)}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {:else}
      {#if summaryLoading}<p>Reading roles summary…</p>{:else if summary}
        {#each summary as section (section.groupID)}
          <details class="summary-group" open={summaryOpen[section.groupID] ?? false} ontoggle={event => { summaryOpen[section.groupID] = flow.corporationSummaryGroupOpen(section.groupID, event.currentTarget.open); }}>
            <summary>{fill(LABELS.roleCount, { role: word(`#${section.nameID}`, ""), numRoles: section.rows.length })}</summary>
            <dl class="summary-rows">
              {#each section.rows as row}
                <dt>{summaryRoleName(row.name)}</dt><dd>{#each summaryParts(row) as part, i}{i ? word(LABELS.delimiter, ", ") : ""}{part.label}{#if part.titles}{" ("}<span class="title-sources">{part.titles}</span>){/if}{/each}</dd>
              {/each}
            </dl>
          </details>
        {:else}<p>{word(LABELS.nothing, "Nothing found")}</p>{/each}
      {/if}
    {/if}
    </div>
    <div class="controls">
      <button type="button" disabled={busy} onclick={() => void giveShares()}>{word(LABELS.shares, "Give Shares")}</button>
      <button type="button" disabled={busy} onclick={() => void apply(true)}>{word(LABELS.ok, "OK")}</button>
      <button type="button" onclick={() => onClose?.()}>{word(LABELS.cancel, "Cancel")}</button>
      <button type="button" disabled={busy} onclick={() => void apply(false)}>{word(LABELS.apply, "Apply")}</button>
    </div>
  {:else if !error}<p>{busy ? "Reading member…" : "Choose a corporation member."}</p>{/if}
</section>

<style>
  .member-details { display: flex; flex-direction: column; gap: 6px; height: 100%; min-height: 0; }
  .identity { display: flex; align-items: center; gap: 1rem; }
  .identity h3, .identity p { margin: 0; }
  label { display: block; margin: 0.5rem 0; }
  label input, label select { display: block; width: 100%; }
  dl { display: grid; grid-template-columns: minmax(7rem, auto) minmax(0, 1fr); gap: 0.5rem; }
  dt { color: var(--color-muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .member-tabs { display: flex; flex-wrap: wrap; gap: 0.25rem; border-bottom: 1px solid var(--color-border); }
  .member-tabs [aria-selected="true"] { border-color: var(--color-accent); }
  .member-body { flex: 1; min-height: 0; overflow: auto; }
  .controls { display: flex; flex: none; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }
  .role-views { display: flex; flex-wrap: wrap; gap: 1rem; }
  .role-views label { flex: 1; min-width: 10rem; }
  .role-list { list-style: none; padding: 0; }
  .role-list li { padding: 0.5rem 0; border-bottom: 1px solid var(--color-border); }
  .role-name, .role-name label { display: flex; align-items: center; gap: 0.5rem; }
  .role-name label { margin: 0; }
  .role-name input { display: inline; width: auto; }
  .role-list p { margin: 0.25rem 0 0 1.5rem; color: var(--color-muted); }
  .summary-group { margin: 0.75rem 0; }
  .summary-group summary { cursor: pointer; padding: 0.5rem; border-bottom: 1px solid var(--color-border); }
  .summary-rows { grid-template-columns: minmax(0, 10rem) minmax(0, 1fr); }
  .summary-rows dt { white-space: pre-line; }
  .title-sources { color: var(--color-muted); }
  @media (max-width: 480px) { .summary-rows { grid-template-columns: minmax(0, 1fr); } }
</style>
