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
  import CorporationKillReports from "./CorporationKillReports.svelte";
  import CorporationBulletins from "./CorporationBulletins.svelte";
  import CorporationCreate from "./CorporationCreate.svelte";
  import CorporationFinder from "./CorporationFinder.svelte";
  import CorporationAdverts from "./CorporationAdverts.svelte";
  import CorporationApplicationsToCorp from "./CorporationApplicationsToCorp.svelte";
  import CorporationWarInfo from "./CorporationWarInfo.svelte";
  import CorporationWars from "./CorporationWars.svelte";
  import CorporationWarHistory from "./CorporationWarHistory.svelte";
  import CorporationMutualWarInvites from "./CorporationMutualWarInvites.svelte";
  import AllianceHome from "./AllianceHome.svelte";
  import AllianceMembers from "./AllianceMembers.svelte";
  import { getContext, onDestroy } from "svelte";
  import OwnerPicture from "./OwnerPicture.svelte";
  import CorpLogo from "./CorpLogo.svelte";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { portraitUrl } from "./ownerImages.ts";
  import { resolvedName } from "../store/names.ts";
  import type { CorporationAdministration } from "../bridge/corporationMemberQuery.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";

  let { store, flow, openMail, openWatchlist }: { store: ClientStore; flow: AppFlow; openMail?: () => void; openWatchlist?: () => void } = $props();

  let panel = $state<"contacts" | "npc" | "members" | "decorations" | "allianceContacts" | "applications" | "find" | "home" | "kills" | "recruitSearch" | "wars" | "warInfo" | "bulletins" | "allianceGeneral" | "recruitAds" | "recruitApplications" | "warHistory" | "mutualWarInvites" | "allianceBulletins" | "allianceMembers">("contacts");
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
    "UI/Corporations/CorporationWindow/Recruitment/CorporationAds": "Advertisements",
    "UI/Corporations/CorpApplications/ApplicationsToCorp": "Applications",
    "UI/Corporations/Wars/WarHistory": "War History",
    "UI/Corporations/Wars/MutualWarInvitesTab": "Mutual War Invites",
    "UI/Corporations/CorporationWindow/Alliances/Bulletins": "Bulletins",
    "UI/Corporations/CorporationWindow/Alliances/Members": "Members",
    "UI/Corporations/BaseCorporationUI/Wars": "Wars",
    "UI/Corporations/BaseCorporationUI/OngoingWarsTab": "Wars",
    "UI/Corporations/Wars/WarInfoTab": "War Info",
    "UI/Corporations/BaseCorporationUI/MyAlliance": "My Alliance",
  };
  /**
   * CorpUIHome (corp_ui_home.py): its ButtonGroup at the bottom - Create New Corporation (not the CEO), Quit Corporation
   * (a player corporation's member); the banner 136 high - the corporation's logo 72 (an NPC one at the left edge, a
   * player one 32 in), its name and info icon; a player corporation's CEO at the right (CEO_CONT_WIDTH 300: the portrait
   * 62 in a ring, CEO over the name) over the CorpColorBanner; then the Details group: CEO (CEO and Founder where the
   * same), Founder, Headquarters, Ticker, Shares, Members (a player corporation), ISK Tax Rate, LP Tax Rate, URL.
   * Read only: no button acts here yet (each is a write).
   */
  type CorpHome = Awaited<ReturnType<AppFlow["ownCorporationDetails"]>>;
  let corpHome = $state<CorpHome>(null);
  // CreateCorpForm (corp_ui_home.py 318-343): the CreateCorp window - here over the corporation window
  let creatingCorp = $state(false);
  let corpHomeError = $state("");
  const names = store.names;
  const ownerLogos = flow.ownerLogos;
  // eveIcon.CorpIcon: a player corporation's logo, its three layers from the client's logo library
  const corpLogos = flow.corpLogos;
  const corpLogoLibrary = flow.corpLogoLibrary;
  const imageServer = flow.imageServer;
  $effect(() => {
    if (!retail || panel !== "home") return;
    void $station.online?.corporationID;
    flow.loadOwnerLogos();
    flow.loadImageServer();
    void flow.ownCorporationDetails().then((home) => {
      corpHome = home;
      if (home) flow.requestCorpLogos([home.corporationID]);
      if (home) flow.requestNames([
        ...(home.ceoID ? [{ kind: "character" as const, id: home.ceoID }] : []), ...(home.creatorID ? [{ kind: "character" as const, id: home.creatorID }] : []),
        ...(home.stationID ? [{ kind: "station" as const, id: home.stationID }] : []), { kind: "corporation" as const, id: home.corporationID },
      ]);
    }, (cause) => { corpHomeError = cause instanceof Error ? cause.message : String(cause); });
  });
  const HOME_WORDS = ["UI/Corporations/Common/CEO", "UI/Corporations/CorpUIHome/CeoAndFounder", "UI/Corporations/Common/Founder",
    "UI/Corporations/CorpUIHome/Headquarters", "UI/Corporations/CorpUIHome/TickerName", "UI/Corporations/CorpUIHome/Shares",
    "UI/Corporations/CorpUIHome/MemberCount", "UI/Corporations/CorpUIHome/ISKTaxRate", "UI/Corporations/CorpUIHome/LPTaxRate",
    "UI/Corporations/CorpUIHome/URL", "UI/Common/Details", "UI/Corporations/CorpUIHome/CreateNewCorp", "UI/Corporations/CorpUIHome/QuitCorp"];
  $effect(() => { if (retail) flow.requestWords(HOME_WORDS); });
  const homeWord = (label: string, own: string): string => { const t = $words.templates[label]; return typeof t === "string" ? t : own; };
  const NOT_BUILT = new Set<string>();
  type NavEntry = { readonly id: typeof panel; readonly label: string; readonly open?: () => void };
  const corpNav = $derived.by((): readonly { readonly header: string; readonly entries: readonly NavEntry[] }[] => {
    if (corpTab === "alliance") {
      return [
        // construct_alliance_general: My Alliance; with an alliance its Bulletins and Members
        { header: "UI/Generic/General", entries: [{ id: "allianceGeneral", label: "UI/Corporations/BaseCorporationUI/MyAlliance" },
          ...(allianceID !== null ? [{ id: "allianceBulletins" as const, label: "UI/Corporations/CorporationWindow/Alliances/Bulletins" },
            { id: "allianceMembers" as const, label: "UI/Corporations/CorporationWindow/Alliances/Members" }] : [])] },
        ...(playerCorporation && allianceID !== null
          ? [{ header: "UI/Corporations/CorporationWindow/Alliances/Relationships", entries: [{ id: "allianceContacts" as const, label: "UI/Corporations/CorporationWindow/Alliances/AllianceContacts" }] }]
          : []),
      ];
    }
    if (corpTab === "admin") {
      return [
        ...(administration.findMembers ? [{ header: "UI/Corporations/BaseCorporationUI/Members", entries: [{ id: "find" as const, label: "UI/Corporations/BaseCorporationUI/FindMemberInRole" }] }] : []),
        // construct_admin_recruitment_panels: Corporation Advertisements, for whoever sees the tab
        { header: "UI/Corporations/BaseCorporationUI/Recruitment", entries: [{ id: "recruitAds" as const, label: "UI/Corporations/CorporationWindow/Recruitment/CorporationAds" }, { id: "recruitApplications" as const, label: "UI/Corporations/CorpApplications/ApplicationsToCorp" }] },
        // construct_admin_wars_panels: a director's - Mutual War Invites
        ...(administration.director ? [{ header: "UI/Corporations/BaseCorporationUI/Wars", entries: [{ id: "mutualWarInvites" as const, label: "UI/Corporations/Wars/MutualWarInvitesTab" }] }] : []),
      ];
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
        // construct_corporation_wars_panels: War History, not for an NPC corporation
        ...(playerCorporation ? [{ id: "warHistory" as const, label: "UI/Corporations/Wars/WarHistory" }] : []),
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
    {#if creatingCorp}<CorporationCreate {store} {flow} onClose={() => (creatingCorp = false)} />{/if}
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
      {#if panel === "kills"}<CorporationKillReports {store} {flow} />{/if}
      {#if panel === "recruitSearch"}<CorporationFinder {store} {flow} />{/if}
      {#if panel === "wars"}<CorporationWars {store} {flow} />{/if}
      {#if panel === "warHistory"}<CorporationWarHistory {store} {flow} />{/if}
      {#if panel === "mutualWarInvites"}<CorporationMutualWarInvites {store} {flow} />{/if}
      {#if panel === "allianceGeneral"}<AllianceHome {store} {flow} />{/if}
      {#if panel === "allianceBulletins"}<CorporationBulletins {store} {flow} director={administration.director} alliance />{/if}
      {#if panel === "allianceMembers"}<AllianceMembers {store} {flow} />{/if}
      {#if panel === "warInfo"}<CorporationWarInfo {store} {flow} />{/if}
      {#if panel === "recruitAds"}<CorporationAdverts {store} {flow} />{/if}
      {#if panel === "recruitApplications"}<CorporationApplicationsToCorp {store} {flow} />{/if}
      {#if panel === "bulletins"}<CorporationBulletins {store} {flow} director={administration.director} />{/if}
      {#if retail && panel === "home"}
        <div class="corp-home">
          {#if corpHomeError}<p class="error">{corpHomeError}</p>{/if}
          {#if corpHome}
            {@const npc = !playerCorporation}
            {@const corpName = corpHome.name || resolvedName($names.resolved, "corporation", corpHome.corporationID, "")}
            {@const logo = $ownerLogos?.corporations[String(corpHome.corporationID)]}
            {@const playerLogo = npc ? null : ($corpLogos[String(corpHome.corporationID)] ?? null)}
            <div class="corp-home-banner" class:npc>
              {#if playerLogo !== null && $corpLogoLibrary !== null && playerLogo.shapes.some((shape) => shape !== null)}
                <span class="logo player-logo"><CorpLogo library={$corpLogoLibrary} logo={playerLogo} name={corpName} /></span>
              {:else}
                <span class="logo"><OwnerPicture name={corpName} urls={logo ? [clientTexture(logo)] : []} size={72} /></span>
              {/if}
              <span class="name">{corpName}</span>
              {#if !npc && corpHome.ceoID}
                {@const portrait = portraitUrl($imageServer, corpHome.ceoID, 64)}
                <div class="ceo">
                  <span class="ceo-text"><small>{homeWord("UI/Corporations/Common/CEO", "CEO")}</small><b>{resolvedName($names.resolved, "character", corpHome.ceoID, "")}</b></span>
                  <span class="ceo-pic"><OwnerPicture name={resolvedName($names.resolved, "character", corpHome.ceoID, "")} urls={portrait ? [portrait] : []} size={62} /></span>
                </div>
              {/if}
            </div>
            <div class="corp-home-details">
              <div class="group">{homeWord("UI/Common/Details", "Details")}</div>
              {#if !npc && corpHome.ceoID}
                <div class="row"><span>{homeWord(corpHome.ceoID === corpHome.creatorID ? "UI/Corporations/CorpUIHome/CeoAndFounder" : "UI/Corporations/Common/CEO", "CEO")}</span><span>{resolvedName($names.resolved, "character", corpHome.ceoID, "")}</span></div>
              {/if}
              {#if !npc && corpHome.creatorID && corpHome.creatorID !== corpHome.ceoID}
                <div class="row"><span>{homeWord("UI/Corporations/Common/Founder", "Founder")}</span><span>{resolvedName($names.resolved, "character", corpHome.creatorID, "")}</span></div>
              {/if}
              {#if corpHome.stationID}<div class="row"><span>{homeWord("UI/Corporations/CorpUIHome/Headquarters", "Headquarters")}</span><span>{resolvedName($names.resolved, "station", corpHome.stationID, "")}</span></div>{/if}
              <div class="row"><span>{homeWord("UI/Corporations/CorpUIHome/TickerName", "Ticker Name")}</span><span>[{corpHome.ticker}]</span></div>
              <div class="row"><span>{homeWord("UI/Corporations/CorpUIHome/Shares", "Shares")}</span><span>{corpHome.shares.toLocaleString("en-US")}</span></div>
              {#if !npc}<div class="row"><span>{homeWord("UI/Corporations/CorpUIHome/MemberCount", "Member Count")}</span><span>{corpHome.memberCount.toLocaleString("en-US")}</span></div>{/if}
              <div class="row"><span>{homeWord("UI/Corporations/CorpUIHome/ISKTaxRate", "ISK Tax Rate")}</span><span>{(corpHome.taxRate * 100).toFixed(1)}%</span></div>
              <div class="row"><span>{homeWord("UI/Corporations/CorpUIHome/LPTaxRate", "LP Tax Rate")}</span><span>{(corpHome.loyaltyPointTaxRate * 100).toFixed(1)}%</span></div>
              {#if corpHome.url}<div class="row"><span>{homeWord("UI/Corporations/CorpUIHome/URL", "URL")}</span><span>{corpHome.url}</span></div>{/if}
            </div>
            <div class="corp-home-buttons">
              {#if corpHome.ceoID !== $station.online?.characterID}<button type="button" onclick={() => (creatingCorp = true)}>{homeWord("UI/Corporations/CorpUIHome/CreateNewCorp", "Create New Corporation")}</button>{/if}
              {#if !npc}<button type="button" disabled title="Not on the play page yet">{homeWord("UI/Corporations/CorpUIHome/QuitCorp", "Quit Corporation")}</button>{/if}
            </div>
          {/if}
        </div>
      {/if}
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
    position: relative;
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
