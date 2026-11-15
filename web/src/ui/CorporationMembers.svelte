<script lang="ts">
  // corporation/corp_ui_member_tracking.py: Load, _GetRoleOptions, GetLastLoggedOnText, ShowMemberTracking.
  import { onMount, untrack } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { CorporationTracking, CorporationTrackingMember } from "../bridge/corporationTracking.ts";
  import { DATE_LABELS, formatTemplate, plainText, locationKind } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";
  import { doubleClickOwner } from "./ownerDoubleClick.ts";
  import { focusMail } from "./mailFocus.ts";
  import ContactActionDialog from "./ContactActionDialog.svelte";
  import OwnerFleetMenu from "./OwnerFleetMenu.svelte";
  import OwnerChatMenu from "./OwnerChatMenu.svelte";
  import OwnerDuelMenu from "./OwnerDuelMenu.svelte";
  import OwnerTradeMenu from "./OwnerTradeMenu.svelte";
  import OwnerMemberMenu from "./OwnerMemberMenu.svelte";
  import OwnerExpelMenu from "./OwnerExpelMenu.svelte";
  import OwnerDecorationMenu from "./OwnerDecorationMenu.svelte";
  import OwnerCorporationInviteMenu from "./OwnerCorporationInviteMenu.svelte";
  import OwnerCorporationCashMenu from "./OwnerCorporationCashMenu.svelte";
  import MemberFleetInvites from "./MemberFleetInvites.svelte";
  import type { ContactScope, NamedAddressBook } from "../bridge/contacts.ts";
  import type { ContactAction } from "./contactAction.ts";
  import { isNpcOwner } from "../bridge/mail.ts";

  let { store, flow, openMail, openWatchlist }: { store: ClientStore; flow: AppFlow; openMail?: () => void; openWatchlist?: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const director = $derived((BigInt($station.online?.corpRole ?? "0") & 1n) !== 0n);
  // SessionChecker.IsDiplomat: director or diplomat. CharacterChecker's
  // corporation actions permit self and multi-selection (55-60, 314-321).
  const diplomat = $derived((BigInt($station.online?.corpRole ?? "0") & (1n | 17179869184n)) !== 0n);
  const LABELS = {
    title: "UI/Corporations/BaseCorporationUI/MemberList", role: "UI/Corporations/Common/Role", all: "UI/Common/All",
    onlineOnly: "UI/Corporations/CorporationWindow/Members/Tracking/OnlineOnly",
    name: "UI/Corporations/CorporationWindow/Members/CorpMemberName",
    lastOnline: "UI/Corporations/CorporationWindow/Members/Tracking/LastOnlineColumnHeader",
    memberTitle: "UI/Corporations/Common/Title", base: "UI/Corporations/CorporationWindow/Members/CorpMemberBase",
    joined: "UI/Corporations/CorporationWindow/Members/Tracking/JoinedColumnHeader", ship: "UI/Common/Ship",
    location: "UI/Common/Location", faction: "UI/Corporations/CorporationWindow/Members/FactionEnlistment",
    logon: "UI/Common/Online", logoff: "UI/Common/Offline", none: "UI/Generic/None", unknown: "UI/Generic/Unknown",
    empty: "UI/Common/NoDataAvailable", info: "UI/Commands/ShowInfo", mail: "UI/EVEMail/SendPilotEVEMail",
    addContact: "UI/PeopleAndPlaces/AddContact", editContact: "UI/PeopleAndPlaces/EditContact", removeContact: "UI/PeopleAndPlaces/RemoveContact",
    block: "UI/PeopleAndPlaces/BlockContact", unblock: "UI/PeopleAndPlaces/UnblockContact",
    addCorpContact: "UI/PeopleAndPlaces/AddCorpContact", editCorpContact: "UI/PeopleAndPlaces/EditCorpContact", removeCorpContact: "UI/PeopleAndPlaces/RemoveCorpContact",
    addAllianceContact: "UI/PeopleAndPlaces/AddAllianceContact", editAllianceContact: "UI/PeopleAndPlaces/EditAllianceContact", removeAllianceContact: "UI/PeopleAndPlaces/RemoveAllianceContact",
  };
  const ONLINE = "UI/Corporations/CorpMemberTracking/";
  const lastLabels = ["MoreThanAMonth", "Online", "LessThanAnHour", "Hours", "LastWeek", "LastMonth"];
  const word = (label: string, fallback: string): string => plainText($words.templates[label] ?? fallback);
  function lastOnlineText(hours: number | null): string {
    const key = hours === null || hours >= 720 ? "MoreThanAMonth" : hours < 0 ? "Online" : hours < 1 ? "LessThanAnHour" : hours < 24 ? "Hours" : hours < 168 ? "LastWeek" : "LastMonth";
    const fallback = { MoreThanAMonth: "More than a month", Online: "Online", LessThanAnHour: "Less than an hour", Hours: "{hourCount} hours", LastWeek: "Last week", LastMonth: "Last month" }[key];
    return formatTemplate($words.templates[ONLINE + key] ?? fallback, { hourCount: Math.trunc(hours ?? 0), hours: hours ?? 0 }, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") });
  }
  function date(value: bigint | null, format: "ln" | "ls"): string {
    if (value === null) return word(LABELS.unknown, "Unknown");
    return formatTemplate($words.templates[DATE_LABELS[format]!] ?? "", { datetime: { type: "long", value: value.toString() } }, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") });
  }
  let held = $state<CorporationTracking | null>(null);
  let error = $state("");
  let busy = $state(false);
  let ready = $state(false);
  let roles = $state<readonly { roleID: string; nameID: number; groupID: number }[]>([]);
  let role = $state("");
  let onlineOnly = $state(false);
  let filterText = $state("");
  let filter = $state("");
  let filterTimer: ReturnType<typeof setTimeout> | null = null;
  let serial = 0;
  let disposed = false;
  let chosen = $state<number[]>([]);
  let anchor: number | null = null;
  let menuFor = $state<number | null>(null);
  let contactBook = $state<NamedAddressBook | null>(null);
  let contactError = $state("");
  let corporateContactBook = $state<NamedAddressBook | null>(null);
  let allianceContactBook = $state<NamedAddressBook | null>(null);
  const contactAuthority = $derived(`${$station.online?.characterID}:${$station.online?.corporationID}:${$station.online?.allianceID}:${$station.online?.corpRole}`);
  type ScopedAction = ContactAction & { readonly scope: ContactScope };
  let contactActions = $state<readonly ScopedAction[]>([]);
  let contactMenuSerial = 0;
  let contactBusy = $state(false);
  $effect(() => {
    const authority = contactAuthority;
    untrack(() => {
      void authority;
      contactMenuSerial++;
      menuFor = null;
      contactBook = null;
      corporateContactBook = null;
      allianceContactBook = null;
      contactActions = [];
    });
  });
  const onlineKey = () => `evejs.corpMembersOnline.${store.station.get().online?.characterID}`;
  async function load(): Promise<void> {
    const request = ++serial;
    busy = true;
    error = "";
    try {
      const result = await flow.corporationMemberTracking(filter);
      if (!disposed && request === serial) { held = result; chosen = []; anchor = null; menuFor = null; }
    } catch (cause) {
      // ShowMemberTracking's finally loads its empty scroll even when the search-word check refuses.
      if (!disposed && request === serial) { held = null; chosen = []; anchor = null; menuFor = null; error = cause instanceof Error ? cause.message : String(cause); }
    } finally {
      if (!disposed && request === serial) busy = false;
    }
  }
  function onlineChanged(): void {
    try { localStorage.setItem(onlineKey(), JSON.stringify(onlineOnly)); } catch { /* This view keeps it until closed. */ }
    void load();
  }
  function filterNow(): void {
    // SingleLineEditText.GetValue 39-46 escapes angle brackets before QuickFilter reads the text.
    const value = filterText.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    if (filter === value) return;
    filter = value;
    void load();
  }
  function filterTyped(): void {
    // QuickFilterEdit: take the current text 0.4 seconds after the first key, without restarting the timer.
    if (filterTimer !== null) return;
    filterTimer = setTimeout(() => { filterTimer = null; filterNow(); }, 400);
  }
  const roleOptions = $derived([...new Set(roles.map(role => role.groupID))].flatMap(groupID => roles.filter(each => each.groupID === groupID).map(each => ({ ...each, name: word(`#${each.nameID}`, "") }))
    .sort((a, b) => a.name.toUpperCase() < b.name.toUpperCase() ? -1 : a.name.toUpperCase() > b.name.toUpperCase() ? 1 : 0)));
  let sort = $state("name");
  let descending = $state(false);
  const nameOf = (id: number | null, kind: "owner" | "type" | "location", fallback: string): string => id === null ? fallback : resolvedName($names.resolved, kind === "location" ? locationKind(id) : kind, id, fallback);
  const columns = $derived([
    ["name", LABELS.name, "Name"], ["lastOnline", LABELS.lastOnline, "Last online"], ["title", LABELS.memberTitle, "Title"],
    ["base", LABELS.base, "Base"], ["joined", LABELS.joined, "Joined"],
    ...(director ? [["ship", LABELS.ship, "Ship"], ["location", LABELS.location, "Location"], ["faction", LABELS.faction, "Faction enlistment"],
      ["logon", LABELS.logon, "Online"], ["logoff", LABELS.logoff, "Offline"]] : []),
  ]);
  function cells(member: CorporationTrackingMember): Record<string, string> {
    const factionID = held?.factionID ?? member.factionID;
    return { name: nameOf(member.characterID, "owner", word(LABELS.unknown, "Unknown")), lastOnline: lastOnlineText(member.lastOnline), title: member.title,
      base: member.baseID ? nameOf(member.baseID, "location", "") : "", joined: date(member.startDateTime, "ln"),
      ship: nameOf(member.shipTypeID, "type", word(LABELS.none, "None")), location: nameOf(member.locationID, "location", word(LABELS.unknown, "Unknown")),
      faction: factionID ? nameOf(factionID, "owner", word(LABELS.unknown, "Unknown")) : "-", logon: date(member.logonDateTime, "ls"), logoff: date(member.logoffDateTime, "ls") };
  }
  const rows = $derived((held?.members ?? []).filter(member => {
    const bit = role ? BigInt(role) : 0n;
    return (!bit || (member.roles & bit) !== 0n || (member.grantableRoles & bit) !== 0n || (member.roles & 1n) !== 0n)
      && (!onlineOnly || member.lastOnline !== null && member.lastOnline < 0)
      && nameOf(member.characterID, "owner", "").toLowerCase().includes(filter.toLowerCase());
  }).map(member => ({ member, text: cells(member) })).sort((a, b) => {
    const key = (row: typeof a): string | number | bigint | null => sort === "lastOnline" ? row.member.lastOnline : sort === "joined" ? row.member.startDateTime : sort === "logon" ? row.member.logonDateTime : sort === "logoff" ? row.member.logoffDateTime : (row.text[sort] ?? "").toLowerCase();
    const x = key(a), y = key(b);
    const result = x === y ? 0 : x === null ? -1 : y === null ? 1 : x < y ? -1 : 1;
    return descending ? -result : result;
  }));
  const selected = $derived(rows.filter(row => chosen.includes(row.member.characterID)));
  const personalContactTarget = $derived(selected.length === 1 && selected[0]!.member.characterID !== $station.online?.characterID && !isNpcOwner(selected[0]!.member.characterID) ? selected[0]! : null);
  const targetIsContact = $derived(contactBook?.contacts.some(each => each.contactID === personalContactTarget?.member.characterID) ?? false);
  const targetIsBlocked = $derived(contactBook?.blocked.some(each => each.ownerID === personalContactTarget?.member.characterID) ?? false);
  const corporateTargets = $derived(diplomat ? selected.filter(row => !isNpcOwner(row.member.characterID)) : []);
  const corporateExisting = $derived(new Set(corporateContactBook?.contacts.map(each => each.contactID) ?? []));
  const corporateAddTargets = $derived(corporateTargets.filter(row => !corporateExisting.has(row.member.characterID)));
  const corporateEditTargets = $derived(corporateTargets.filter(row => corporateExisting.has(row.member.characterID)));
  const allianceExisting = $derived(new Set(allianceContactBook?.contacts.map(each => each.contactID) ?? []));
  const allianceAddTargets = $derived(corporateTargets.filter(row => !allianceExisting.has(row.member.characterID)));
  const allianceEditTargets = $derived(corporateTargets.filter(row => allianceExisting.has(row.member.characterID)));
  // User.OnClick -> Scroll.SelectNode 550-600: plain replaces, Ctrl toggles, Shift ranges from the last anchor.
  function select(event: MouseEvent | KeyboardEvent, id: number): void {
    menuFor = null;
    const at = rows.findIndex(row => row.member.characterID === id);
    const control = event.ctrlKey || event.metaKey;
    const ranged = anchor !== null && anchor !== at && anchor < rows.length;
    const range = ranged ? rows.slice(Math.min(anchor!, at), Math.max(anchor!, at) + 1).map(row => row.member.characterID) : [];
    if (event.shiftKey && control) { if (ranged) chosen = [...new Set([...chosen, ...range])]; }
    else if (event.shiftKey && ranged) { chosen = range; return; }
    else if (control) chosen = chosen.includes(id) ? chosen.filter(each => each !== id) : [...chosen, id];
    else chosen = [id];
    anchor = at;
  }
  function openMenu(event: MouseEvent | KeyboardEvent, id: number): void {
    event.preventDefault();
    if (!chosen.includes(id)) select(event, id);
    // A keyboard context-menu key can also dispatch contextmenu on the row.
    // Opening is idempotent, as User.GetMenu is, rather than toggling it shut.
    menuFor = id;
    contactBook = null;
    corporateContactBook = null;
    allianceContactBook = null;
    contactError = "";
    const request = ++contactMenuSerial;
    // CharacterChecker's personal contact actions exclude self and multi-selection.
    if (menuFor !== null && chosen.length === 1 && id !== $station.online?.characterID && !isNpcOwner(id)) {
      void flow.addressBook().then(book => { if (!disposed && request === contactMenuSerial && menuFor === id) contactBook = book; }, cause => {
        if (!disposed && request === contactMenuSerial) contactError = cause instanceof Error ? cause.message : String(cause);
      });
    }
    if (diplomat && chosen.some(ownerID => !isNpcOwner(ownerID))) {
      void flow.addressBook("corpcontact").then(book => { if (!disposed && request === contactMenuSerial && menuFor === id) corporateContactBook = book; }, cause => {
        if (!disposed && request === contactMenuSerial) contactError = cause instanceof Error ? cause.message : String(cause);
      });
      // CharacterChecker 44-53, 301-312: an alliance member, diplomat/director,
      // in its executor corporation; self and mixed selections are eligible.
      if ($station.online?.allianceID) void (async () => {
        if (!await flow.saveForAllianceOffered() || disposed || request !== contactMenuSerial || menuFor !== id) return;
        const book = await flow.addressBook("alliancecontact");
        if (!disposed && request === contactMenuSerial && menuFor === id) allianceContactBook = book;
      })().catch(cause => { if (!disposed && request === contactMenuSerial) contactError = cause instanceof Error ? cause.message : String(cause); });
    }
  }
  function contactManage(kind: ContactAction["kind"]): void {
    const target = personalContactTarget;
    if (!target || !contactBook) return;
    contactActions = [{ kind, ownerID: target.member.characterID, name: target.text.name!, book: contactBook, scope: "contact" }];
    menuFor = null;
  }
  function corporateManage(kind: "add" | "edit" | "remove", scope: ContactScope = "corpcontact"): void {
    const book = scope === "alliancecontact" ? allianceContactBook : corporateContactBook;
    if (!diplomat || !book) return;
    // menusvc 604-609 + compiled menuMerge: separate callbacks for the
    // eligible owners, including mixed selections; no bulk standing editor.
    const targets = scope === "alliancecontact" ? kind === "add" ? allianceAddTargets : allianceEditTargets : kind === "add" ? corporateAddTargets : corporateEditTargets;
    contactActions = targets.map(row => ({ kind: kind === "remove" ? "remove" : "manage", ownerID: row.member.characterID,
      name: row.text.name!, book, scope }));
    menuFor = null;
  }
  function contactDone(action: ScopedAction, book: NamedAddressBook | null): void {
    if (action.scope === "contact" && book) contactBook = book;
    // Each native dialog owns one target's draft. A future menu reads the
    // service's current held book, which includes all independently completed writes.
    if (action.scope === "corpcontact") corporateContactBook = null;
    if (action.scope === "alliancecontact") allianceContactBook = null;
    contactActions = contactActions.filter(each => each !== action);
  }
  async function contactBlock(blocked: boolean): Promise<void> {
    const target = personalContactTarget;
    const id = target?.member.characterID;
    const book = contactBook;
    if (!id || !book) return;
    contactBusy = true;
    contactError = "";
    try {
      if (blocked) await flow.blockOwners([id]);
      else await flow.unblockOwners([id]);
      if (disposed || personalContactTarget?.member.characterID !== id) return;
      contactBook = { ...book, blocked: blocked ? [...book.blocked, { ownerID: id, name: target?.text.name ?? "" }] : book.blocked.filter(each => each.ownerID !== id) };
      menuFor = null;
    } catch (cause) { contactError = cause instanceof Error ? cause.message : String(cause); }
    finally { contactBusy = false; }
  }
  function infoSelected(): void {
    menuFor = null;
    // User._GetMultiMenu -> CharacterMenu -> menuMerge._ExecMulti: ShowInfo runs for each selected row.
    for (const row of selected) showInfo({ kind: "character", characterID: row.member.characterID });
  }
  function mailSelected(): void {
    // CharacterChecker excludes self. Compiled menuMerge drops the multi-row mail entry's unsupported tuple args.
    const row = selected.length === 1 ? selected[0] : null;
    if (!row || row.member.characterID === $station.online?.characterID) return;
    menuFor = null;
    openMail?.();
    focusMail({ kind: "compose", characterID: row.member.characterID, name: row.text.name! });
  }
  onMount(() => {
    flow.requestWords([...Object.values(LABELS), ...lastLabels.map(key => ONLINE + key), DATE_LABELS.ln!, DATE_LABELS.ls!]);
    try { onlineOnly = JSON.parse(localStorage.getItem(onlineKey()) ?? "false") === true; } catch { onlineOnly = false; }
    void flow.corporationMemberRoleOptions().then(result => { if (!disposed) { roles = result; ready = true; } }, cause => { error = cause instanceof Error ? cause.message : String(cause); });
    return () => { disposed = true; serial++; contactMenuSerial++; if (filterTimer !== null) clearTimeout(filterTimer); };
  });
  $effect(() => { const isDirector = director; if (ready) untrack(() => { void isDirector; void load(); }); });
</script>

<section class="member-tracking" aria-label={word(LABELS.title, "Member List")}>
  <header class="panel-head"><h2 class="panel-title">{word(LABELS.title, "Member List")}</h2></header>
  <div class="controls">
    <label>{word(LABELS.role, "Role")} <select aria-label={word(LABELS.role, "Role")} bind:value={role} onchange={() => void load()}>
      <option value="">{word(LABELS.all, "All")}</option>
      {#each roleOptions as option (option.roleID)}<option value={option.roleID}>{option.name}</option>{/each}
    </select></label>
    <label class="online-filter"><input type="checkbox" bind:checked={onlineOnly} onchange={onlineChanged} />{word(LABELS.onlineOnly, "Online only")}</label>
    <input type="search" aria-label="Filter members" placeholder="Filter members" maxlength="37" bind:value={filterText} oninput={filterTyped} onblur={filterNow} onkeydown={(event) => { if (event.key === "Enter") filterNow(); }} />
  </div>
  {#if error}<p role="alert" class="note">{error}</p>{/if}
  {#if contactError}<p role="alert" class="note">{contactError}</p>{/if}
  {#if held === null}{#if !error}<p class="note">{busy || !ready ? "Reading members…" : word(LABELS.empty, "No data available")}</p>{/if}
  {:else if rows.length === 0}<p class="note">{word(LABELS.empty, "No data available")}</p>
  {:else}
    {#if menuFor !== null && selected.length > 0}
      <div class="controls member-menu" aria-label="Member actions">
        <span>{selected.length} selected</span>
        <button type="button" class="minor" onclick={infoSelected}>{word(LABELS.info, "Show Info")}</button>
        {#if selected.length === 1 && selected[0]!.member.characterID !== $station.online?.characterID}
          <button type="button" class="minor" onclick={mailSelected}>{word(LABELS.mail, "Send Pilot EVEMail")}</button>
        {/if}
        {#if personalContactTarget && contactBook}
          {#if targetIsContact}
            <button type="button" class="minor" onclick={() => contactManage("manage")}>{word("UI/PeopleAndPlaces/EditContact", "Edit Contact")}</button>
            <button type="button" class="minor" onclick={() => contactManage("remove")}>{word("UI/PeopleAndPlaces/RemoveContact", "Remove Contact")}</button>
          {:else}
            <button type="button" class="minor" onclick={() => contactManage("manage")}>{word("UI/PeopleAndPlaces/AddContact", "Add Contact")}</button>
          {/if}
          <button type="button" class="minor" disabled={contactBusy} onclick={() => void contactBlock(!targetIsBlocked)}>{word(targetIsBlocked ? "UI/PeopleAndPlaces/UnblockContact" : "UI/PeopleAndPlaces/BlockContact", targetIsBlocked ? "Unblock" : "Block")}</button>
        {/if}
        {#if diplomat && corporateContactBook}
          {#if corporateAddTargets.length > 0}<button type="button" class="minor" onclick={() => corporateManage("add")}>{word(LABELS.addCorpContact, "Add Corporation Contact")}</button>{/if}
          {#if corporateEditTargets.length > 0}
            <button type="button" class="minor" onclick={() => corporateManage("remove")}>{word(LABELS.removeCorpContact, "Remove Corporation Contact")}</button>
            <button type="button" class="minor" onclick={() => corporateManage("edit")}>{word(LABELS.editCorpContact, "Edit Corporation Contact")}</button>
          {/if}
        {/if}
        {#if diplomat && allianceContactBook}
          {#if allianceAddTargets.length > 0}<button type="button" class="minor" onclick={() => corporateManage("add", "alliancecontact")}>{word(LABELS.addAllianceContact, "Add Alliance Contact")}</button>{/if}
          {#if allianceEditTargets.length > 0}
            <button type="button" class="minor" onclick={() => corporateManage("remove", "alliancecontact")}>{word(LABELS.removeAllianceContact, "Remove Alliance Contact")}</button>
            <button type="button" class="minor" onclick={() => corporateManage("edit", "alliancecontact")}>{word(LABELS.editAllianceContact, "Edit Alliance Contact")}</button>
          {/if}
        {/if}
        <MemberFleetInvites {store} {flow} targets={selected.map(row => row.member.characterID)} onDone={() => menuFor = null} />
        {#if selected.length === 1}
          <OwnerDuelMenu {store} {flow} ownerID={selected[0]!.member.characterID} onDone={() => menuFor = null} />
          <OwnerTradeMenu {store} {flow} ownerID={selected[0]!.member.characterID} onDone={() => menuFor = null} />
          <OwnerChatMenu {store} {flow} ownerID={selected[0]!.member.characterID} onDone={() => menuFor = null} />
          <OwnerFleetMenu {store} {flow} ownerID={selected[0]!.member.characterID} {openWatchlist} onDone={() => menuFor = null} />
        {/if}
        {#if selected.length === 1}<OwnerMemberMenu {store} {flow} ownerID={selected[0]!.member.characterID} onDone={() => menuFor = null} />{/if}
        <OwnerExpelMenu {store} {flow} ownerIDs={selected.map(row => row.member.characterID)} onDone={() => menuFor = null} />
        <OwnerDecorationMenu {store} {flow} ownerIDs={selected.map(row => row.member.characterID)} onDone={() => menuFor = null} />
        <OwnerCorporationInviteMenu {store} {flow} ownerIDs={selected.map(row => row.member.characterID)} onDone={() => menuFor = null} />
        <OwnerCorporationCashMenu {store} {flow} ownerIDs={selected.map(row => row.member.characterID)} onDone={() => menuFor = null} />
        <button type="button" class="minor" aria-label="Close member actions" onclick={() => menuFor = null}>×</button>
      </div>
    {/if}
    <div class="table-wrap member-table" aria-busy={busy}>
      <table class="guests reflow">
        <thead><tr>{#each columns as [key, label, fallback]}<th aria-sort={sort === key ? descending ? "descending" : "ascending" : "none"}><button type="button" class="minor" onclick={() => { descending = sort === key ? !descending : false; sort = key!; }}>{word(label!, fallback!)}</button></th>{/each}</tr></thead>
        <tbody>{#each rows as row (row.member.characterID)}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions (native table row; its name button provides keyboard selection) -->
        <!-- svelte-ignore a11y_click_events_have_key_events (keyboard selection and context menu are on the row's name button) -->
        <tr class:selected={chosen.includes(row.member.characterID)} onclick={(event) => { if (!(event.target as Element).closest("button,input")) select(event, row.member.characterID); }} ondblclick={event => { if (!(event.target as Element).closest("button,input,select,a")) void doubleClickOwner(flow, row.member.characterID).catch(cause => { if (cause?.code !== "SESSION_REQUEST_RETIRED") error = cause instanceof Error ? cause.message : String(cause); }); }} oncontextmenu={(event) => openMenu(event, row.member.characterID)}>{#each columns as [key, label, fallback]}<td data-label={word(label!, fallback!)}>
          {#if key === "name"}
            <span class="member-entry">
              <input type="checkbox" aria-label={`Select ${row.text.name}`} checked={chosen.includes(row.member.characterID)} onchange={() => { chosen = chosen.includes(row.member.characterID) ? chosen.filter(id => id !== row.member.characterID) : [...chosen, row.member.characterID]; anchor = rows.indexOf(row); menuFor = null; }} />
              <button type="button" class="minor member-name" aria-pressed={chosen.includes(row.member.characterID)} onclick={(event) => select(event, row.member.characterID)} onkeydown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); chosen = rows.map(row => row.member.characterID); menuFor = null; } else if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") { event.preventDefault(); openMenu(event, row.member.characterID); } }}>{row.text.name}</button>
              <button type="button" class="minor" aria-label={`${word(LABELS.info, "Show Info")}: ${row.text.name}`} onclick={() => showInfo({ kind: "character", characterID: row.member.characterID })}>i</button>
              <button type="button" class="minor" aria-label={`Menu: ${row.text.name}`} aria-expanded={menuFor === row.member.characterID} onclick={(event) => openMenu(event, row.member.characterID)}>⋯</button>
            </span>
          {:else}{row.text[key!] ?? ""}{/if}
        </td>{/each}</tr>{/each}</tbody>
      </table>
    </div>
  {/if}
</section>

{#each contactActions as action (`${action.scope}:${action.ownerID}`)}
  <ContactActionDialog {store} {flow} {action} contactType={action.scope} done={book => contactDone(action, book)} />
{/each}

<style>
  .member-tracking { min-width: 0; }
  .member-table { overflow-x: auto; }
  td:nth-child(4), td:nth-child(7) { min-width: 12rem; }
  td:nth-child(5), td:nth-child(n+8) { white-space: nowrap; }
  .controls > .online-filter { display: flex; flex-direction: row; align-items: center; gap: 0.5rem; }
  .controls > .online-filter input { width: auto; }
  @container (max-width: 640px) {
    td:nth-child(4), td:nth-child(7) { min-width: 0; }
    td:nth-child(5), td:nth-child(n+8) { white-space: normal; }
  }
  .member-name { text-align: left; }
  .member-entry { display: flex; align-items: center; gap: 0.25rem; }
  .member-entry input { width: auto; }
  .member-entry .member-name { flex: 1; }
  .member-menu { padding: 0.5rem 0; }
  tr.selected { outline: 1px solid var(--color-accent); outline-offset: -1px; }
  @container (max-width: 640px) { .member-entry button { width: auto; } }
  th button { white-space: nowrap; }
</style>
