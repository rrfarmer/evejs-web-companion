<script lang="ts">
  // The client's Corporation window (neocom/corporation/corporationWindow.py): its tabs (Corporation, Alliances and,
  // for an admin role or grantable roles, Administration) and under Corporation its navigation tree (ConstructNavigationTree: Wars, Voting,
  // Standings, Members and the rest, each its panels). The page has Member List and the Decorations catalogue under Members and the Standings node's
  // Contacts form (TAB_CORPCONTACTS) and NPC Standings panel (toID the corporation, corpMode). Alliances holds
  // Relationships / Alliance Contacts for a member, as ConstructNavigationTreeAlliances (373-399) places it.
  //
  // Not here yet: the window's other tabs and nodes (the corporation's home, other member panels, wars, voting and
  // the rest).
  import Standings from "./Standings.svelte";
  import Contacts from "./Contacts.svelte";
  import CorporationMembers from "./CorporationMembers.svelte";
  import CorporationDecorations from "./CorporationDecorations.svelte";
  import CorporationApplications from "./CorporationApplications.svelte";
  import CorporationFindMembers from "./CorporationFindMembers.svelte";
  import { getContext, onDestroy } from "svelte";
  import type { CorporationAdministration } from "../bridge/corporationMemberQuery.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";

  let { store, flow, openMail, openWatchlist }: { store: ClientStore; flow: AppFlow; openMail?: () => void; openWatchlist?: () => void } = $props();

  let panel = $state<"contacts" | "npc" | "members" | "decorations" | "allianceContacts" | "applications" | "find" | "home" | "kills" | "recruitSearch" | "wars" | "warInfo" | "bulletins" | "allianceGeneral">("contacts");
  /**
   * On the play page the window as CorporationWindow lays it out (800 x 832, min 700 x 832): the header's tabs -
   * Corporation, Alliances, Administration (with an admin role or grantable roles) - and the SideNavigation 240 wide:
   * per tab its groups as headers and their panels as entries (construct_corporation_panels: General - Projects, My
   * Corporation, Kill Reports, Bulletins; Recruitment - Find New Corporation, My Applications; Members; Standings;
   * Voting; Wars - Wars, War Info, War History; the alliance's General and Relationships; Administration's Members).
   * The panels the page does not have say so.
   */
  const retail = getContext("retailChrome") === true;
  // svelte-ignore state_referenced_locally
  if (retail) panel = "home";
  let corpTab = $state<"corp" | "alliance" | "admin">("corp");
  let applicationsOpened = $state(false);
  // svelte-ignore state_referenced_locally
  const applicationsRequested = flow.corporationApplicationsRequested;
  $effect(() => { if ($applicationsRequested > 0) { applicationsOpened = true; panel = "applications"; flow.serveCorporationApplicationsRequest($applicationsRequested); } });
  let membersOpened = $state(false);
  let decorationsOpened = $state(false);
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const playerCorporation = $derived(($station.online?.corporationID ?? 0) >= 98_000_000);
  $effect(() => { if (!playerCorporation && (panel === "contacts" || panel === "npc" || panel === "members" || panel === "decorations" || panel === "allianceContacts")) { applicationsOpened = true; panel = "applications"; } });
  let administration = $state<CorporationAdministration>({ visible: false, findMembers: false, director: false });
  let administrationError = $state("");
  let administrationRead = 0;
  const administrationAuthority = $derived(`${$station.online?.characterID}:${$station.online?.corporationID}:${$station.online?.corpRole}`);
  const administrationCorporationID = $derived($station.online?.corporationID ?? null);
  $effect(() => {
    void administrationAuthority; const request = ++administrationRead;
    administration = { visible: false, findMembers: false, director: false };
    administrationError = "";
    if (administrationCorporationID === null) return;
    const current = () => { if (request !== administrationRead) throw new Error("This corporation window has closed or changed."); };
    void flow.corporationAdministration(current).then(value => { if (request === administrationRead) administration = value; }, cause => { if (request === administrationRead) administrationError = cause instanceof Error ? cause.message : String(cause); });
  });
  $effect(() => { if (panel === "find" && !administration.findMembers) panel = playerCorporation ? "contacts" : "applications"; });
  onDestroy(() => { administrationRead++; });
  const allianceID = $derived($station.online?.allianceID ?? null);
  $effect(() => { if (panel === "allianceContacts" && allianceID === null) panel = "contacts"; });
  // svelte-ignore state_referenced_locally
  const words = store.words;
  /** The window's names, with the page's own words where the install's are not had (corpPanelConst NAME_BY_PANEL_ID). */
  const WORDS: Readonly<Record<string, string>> = {
    "UI/Corporations/BaseCorporationUI/Corporation": "Corporation",
    "UI/Corporations/BaseCorporationUI/Alliances": "Alliances",
    "UI/Corporations/CorporationWindow/Alliances/Relationships": "Relationships",
    "UI/Corporations/CorporationWindow/Alliances/AllianceContacts": "Alliance Contacts",
    "UI/InfoWindow/TabNames/Standings": "Standing",
    "UI/Corporations/BaseCorporationUI/Members": "Members",
    "UI/Corporations/BaseCorporationUI/Recruitment": "Recruitment",
    "UI/Corporations/CorpApplications/MyApplications": "My Applications",
    "UI/Corporations/BaseCorporationUI/MemberList": "Member List",
    "UI/Corporations/BaseCorporationUI/Decorations": "Decorations",
    "UI/Corporations/CorporationWindow/Administration": "Administration",
    "UI/Corporations/BaseCorporationUI/FindMemberInRole": "Find Member in Role",
    "UI/Corporations/CorporationWindow/Standings/CorpContacts": "Contacts",
    "UI/Corporations/CorporationWindow/Standings/NPCStandings": "NPCs' standing",
    "UI/Corporations/CorporationWindow/Alliances/Alliances": "Alliances",
    "UI/Generic/General": "General",
    "UI/Fleet/FleetRegistry/MyCorporation": "My Corporation",
    "UI/Corporations/Wars/Killmails/KillReports": "Kill Reports",
    "UI/Corporations/CorpUIHome/Bulletins": "Bulletins",
    "UI/Corporations/BaseCorporationUI/FindNewCorporation": "Find New Corporation",
    "UI/Corporations/BaseCorporationUI/Wars": "Wars",
    "UI/Corporations/BaseCorporationUI/OngoingWarsTab": "Wars",
    "UI/Corporations/Wars/WarInfoTab": "War Info",
    "UI/Corporations/BaseCorporationUI/MyAlliance": "My Alliance",
  };
  const NOT_BUILT = new Set(["home", "kills", "recruitSearch", "wars", "warInfo", "bulletins", "allianceGeneral"]);
  type NavEntry = { readonly id: typeof panel; readonly label: string; readonly open?: () => void };
  const corpNav = $derived.by((): readonly { readonly header: string; readonly entries: readonly NavEntry[] }[] => {
    if (corpTab === "alliance") {
      return [
        { header: "UI/Generic/General", entries: [{ id: "allianceGeneral", label: "UI/Corporations/BaseCorporationUI/MyAlliance" }] },
        ...(playerCorporation && allianceID !== null
          ? [{ header: "UI/Corporations/CorporationWindow/Alliances/Relationships", entries: [{ id: "allianceContacts" as const, label: "UI/Corporations/CorporationWindow/Alliances/AllianceContacts" }] }]
          : []),
      ];
    }
    if (corpTab === "admin") {
      return administration.findMembers
        ? [{ header: "UI/Corporations/BaseCorporationUI/Members", entries: [{ id: "find", label: "UI/Corporations/BaseCorporationUI/FindMemberInRole" }] }]
        : [];
    }
    return [
      { header: "UI/Generic/General", entries: [
        { id: "home", label: "UI/Fleet/FleetRegistry/MyCorporation" }, { id: "kills", label: "UI/Corporations/Wars/Killmails/KillReports" },
        ...(playerCorporation ? [{ id: "bulletins" as const, label: "UI/Corporations/CorpUIHome/Bulletins" }] : []),
      ] },
      { header: "UI/Corporations/BaseCorporationUI/Recruitment", entries: [
        { id: "recruitSearch", label: "UI/Corporations/BaseCorporationUI/FindNewCorporation" },
        { id: "applications", label: "UI/Corporations/CorpApplications/MyApplications", open: () => { applicationsOpened = true; } },
      ] },
      ...(playerCorporation ? [
        { header: "UI/Corporations/BaseCorporationUI/Members", entries: [
          { id: "members" as const, label: "UI/Corporations/BaseCorporationUI/MemberList", open: () => { membersOpened = true; } },
          { id: "decorations" as const, label: "UI/Corporations/BaseCorporationUI/Decorations", open: () => { decorationsOpened = true; } },
        ] },
        { header: "UI/InfoWindow/TabNames/Standings", entries: [
          { id: "contacts" as const, label: "UI/Corporations/CorporationWindow/Standings/CorpContacts" },
          { id: "npc" as const, label: "UI/Corporations/CorporationWindow/Standings/NPCStandings" },
        ] },
      ] : []),
      { header: "UI/Corporations/BaseCorporationUI/Wars", entries: [
        { id: "wars", label: "UI/Corporations/BaseCorporationUI/OngoingWarsTab" }, { id: "warInfo", label: "UI/Corporations/Wars/WarInfoTab" },
      ] },
    ];
  });
  function pickTab(tab: "corp" | "alliance" | "admin"): void {
    corpTab = tab;
    const first = corpNav[0]?.entries[0];
    if (first) { first.open?.(); panel = first.id; }
  }
  const word = (label: string): string => {
    const template = $words.templates[label];
    return typeof template === "string" ? template : WORDS[label] ?? "";
  };
  $effect(() => {
    flow.requestWords(Object.keys(WORDS));
  });
</script>

<section class="panel" class:corp-retail={retail}>
  {#if retail}
    <nav class="corp-tabs">
      <button type="button" class:active={corpTab === "corp"} onclick={() => pickTab("corp")}>{word("UI/Corporations/BaseCorporationUI/Corporation")}</button>
      <button type="button" class:active={corpTab === "alliance"} onclick={() => pickTab("alliance")}>{word("UI/Corporations/CorporationWindow/Alliances/Alliances")}</button>
      {#if administration.visible}<button type="button" class:active={corpTab === "admin"} onclick={() => pickTab("admin")}>{word("UI/Corporations/CorporationWindow/Administration")}</button>{/if}
    </nav>
  {:else}
  <header class="panel-head">
    <h2 class="panel-title">{word("UI/Corporations/BaseCorporationUI/Corporation")}</h2>
  </header>
  {/if}
  <div class="corp-window">
    {#if retail}
    <nav class="corp-side">
      {#each corpNav as group (group.header)}
        <span class="corp-side-header">{word(group.header)}</span>
        {#each group.entries as entry (entry.id)}
          <button type="button" class="corp-side-entry" class:active={panel === entry.id} onclick={() => { entry.open?.(); panel = entry.id; }}>{word(entry.label)}</button>
        {/each}
      {/each}
    </nav>
    {:else}
    <!-- The Standings node has the corporation Contacts form and NPC Standings panel. -->
    <nav class="corp-tree" aria-label={word("UI/Corporations/BaseCorporationUI/Corporation")}>
      <span class="corp-tree-group">{word("UI/Corporations/BaseCorporationUI/Recruitment")}</span>
      <button type="button" class="corp-tree-node" class:active={panel === "applications"} aria-current={panel === "applications" ? "page" : undefined} onclick={() => { applicationsOpened = true; panel = "applications"; }}>{word("UI/Corporations/CorpApplications/MyApplications")}</button>
      {#if playerCorporation}
      <span class="corp-tree-group">{word("UI/Corporations/BaseCorporationUI/Members")}</span>
      <button type="button" class="corp-tree-node" class:active={panel === "members"} aria-current={panel === "members" ? "page" : undefined} onclick={() => { membersOpened = true; panel = "members"; }}>{word("UI/Corporations/BaseCorporationUI/MemberList")}</button>
      <button type="button" class="corp-tree-node" class:active={panel === "decorations"} aria-current={panel === "decorations" ? "page" : undefined} onclick={() => { decorationsOpened = true; panel = "decorations"; }}>{word("UI/Corporations/BaseCorporationUI/Decorations")}</button>
      <span class="corp-tree-group">{word("UI/InfoWindow/TabNames/Standings")}</span>
      <button type="button" class="corp-tree-node" class:active={panel === "contacts"} aria-current={panel === "contacts" ? "page" : undefined} onclick={() => (panel = "contacts")}>{word("UI/Corporations/CorporationWindow/Standings/CorpContacts")}</button>
      <button type="button" class="corp-tree-node" class:active={panel === "npc"} aria-current={panel === "npc" ? "page" : undefined} onclick={() => (panel = "npc")}>{word("UI/Corporations/CorporationWindow/Standings/NPCStandings")}</button>
      {#if $station.online?.allianceID}
        <span class="corp-tree-group">{word("UI/Corporations/BaseCorporationUI/Alliances")}</span>
        <span class="corp-tree-group">{word("UI/Corporations/CorporationWindow/Alliances/Relationships")}</span>
        <button type="button" class="corp-tree-node" class:active={panel === "allianceContacts"} aria-current={panel === "allianceContacts" ? "page" : undefined} onclick={() => (panel = "allianceContacts")}>{word("UI/Corporations/CorporationWindow/Alliances/AllianceContacts")}</button>
      {/if}
      {/if}
      {#if administration.findMembers}
        <span class="corp-tree-group">{word("UI/Corporations/CorporationWindow/Administration")}</span>
        <span class="corp-tree-group">{word("UI/Corporations/BaseCorporationUI/Members")}</span>
        <button type="button" class="corp-tree-node" class:active={panel === "find"} aria-current={panel === "find" ? "page" : undefined} onclick={() => panel = "find"}>{word("UI/Corporations/BaseCorporationUI/FindMemberInRole")}</button>
      {/if}
    </nav>
    {/if}
    <div class="corp-panel">
      {#if administrationError}<p class="error">{administrationError}</p>{/if}
      {#if NOT_BUILT.has(panel)}<p class="note corp-unbuilt">This panel is not on the play page yet.</p>{/if}
      {#key $station.online?.characterID}
        {#if applicationsOpened}<div hidden={panel !== "applications"}><CorporationApplications {store} {flow} /></div>{/if}
      {/key}
      {#key $station.online?.corporationID}
      {#if playerCorporation}
      {#if membersOpened}<div hidden={panel !== "members"}><CorporationMembers {store} {flow} {openMail} {openWatchlist} /></div>{/if}
      {#if decorationsOpened}<div hidden={panel !== "decorations"}><CorporationDecorations {store} {flow} active={panel === "decorations"} /></div>{/if}
      {#if panel === "contacts"}
        <Contacts {store} {flow} contactType="corpcontact" {openWatchlist} />
      {:else if panel === "npc"}
        <Standings {store} {flow} scopes={["corp"]} />
      {:else if panel === "allianceContacts" && $station.online?.allianceID}
        {#key $station.online.allianceID}<Contacts {store} {flow} contactType="alliancecontact" {openWatchlist} />{/key}
      {/if}
      {/if}
      {#if administration.findMembers}<div hidden={panel !== "find"}><CorporationFindMembers {store} {flow} active={panel === "find"} {openMail} {openWatchlist} /></div>{/if}
      {/key}
    </div>
  </div>
</section>

<style>
  .corp-window {
    display: grid;
    grid-template-columns: minmax(9rem, 12rem) minmax(0, 1fr);
    gap: 0.75rem;
  }
  @media (max-width: 720px) {
    .corp-window {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .corp-tree {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .corp-tree-group {
    color: var(--color-muted);
    font-size: 0.9em;
  }
  .corp-tree-node {
    text-align: left;
    border: 0;
    background: transparent;
    padding: 0.2rem 0.5rem;
    font: inherit;
    color: inherit;
  }
  .corp-tree-node.active {
    background: var(--color-panel-2);
    border-left: 2px solid var(--color-accent);
  }
  .corp-panel {
    min-width: 0;
  }
</style>
