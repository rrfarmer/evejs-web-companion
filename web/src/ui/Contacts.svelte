<script lang="ts">
  // The Contacts window (the client's People & Places, AddressBookWindow: addressBookWindow.py), its Contacts tab
  // (ContactsForm, neocom/addressBook/contactsForm.py): the pilot's own contacts and blocked owners, as the client's
  // address book keeps them (charMgr.GetContactList; app/flow.ts addressBook).
  //
  // On the left the form's groups (GetStaticLabelsGroups, 240 to 265; LoadLeftSide, 144 to 180): All Contacts, the
  // five standings, the Buddy List, Blocked, and the Labels with "No Label" first and the pilot's own by name
  // (GetLabelsSubContent, 195 to 213), each with how many it holds (GetContactsCount, 372 to 405;
  // GetContactsLabelCount, 363 to 370). On the right the group chosen (GetScrolllist, 416 to 497): its contacts by
  // name, fifty to a page (maxContactsPerPage), with the window's quick filter (QuickFilterEdit: the names holding
  // what is typed) and "Online only" (onlinebuddyonly: those on the buddy list the online status service has
  // online). A buddy's entry says it is online or offline where that service keeps it (userentry.py SetOnline,
  // 320 to 332; fetch=False, 176), and a blocked owner's says so (SetBlocked, 334 to 342). The group last viewed is
  // kept for the pilot (contacts_lastselected), else the first is shown.
  //
  // Each entry has the client's menu of a contact (menusvc.py 590 to 602, as characterCheckers.py offers each): Add
  // Contact, Edit Contact and Remove Contact, Block and Unblock. Adding and editing open the Contact Management window
  // (contactManagementWindow.py: the five standings, and for a character the buddy list's box, the notification's
  // and a message), confirmed as AddContact or EditContact; removing asks the client's question first
  // (RemoveOneFromContacts); blocking refuses the pilot itself and NPCs in the client's words (BlockOwner, 645 to 664).
  //
  // The labels (addressbookService.py 990 to 1213): each entry shows the names of its contact's labels under its own
  // (userentry.py SetLabelText, 345 to 351) and its menu offers those it lacks to assign and those it has to remove
  // (GetAssignLabelMenu, GetRemoveLabelMenu), each told as the client tells it. A label of the group's is renamed or
  // deleted from its own menu (contactsForm.py GetLabelMenu, 226 to 233), and the Labels group opens Manage Labels
  // (manageLabels.py on evemail.py ManageLabelsBase): a label made by name, the labels ticked given to or taken off
  // the entries selected. Entries are selected by their boxes (the scroll's multiSelect); the menu of one of several
  // selected is the client's for several (userentry.py _GetMultiMenu, 455 to 547): Edit Contacts, which opens the
  // window that gives them one standing (contactManagementMultiEditWindow.py), Remove Contacts after the client's
  // RemoveManyFromContacts, Unblock where all are blocked, and the labels to add and remove. Adding an owner that is
  // none of the pilot's offers a label (contactManagementWindow.py ConstructLabelsCombo, 98 to 117).
  //
  // The Agents tab (addressBookWindow.py ShowAgents, 187 to 218; GetAgentsSubContent, 243 to 260): the agents the
  // address book keeps apart, under the locked "All Agents" group and the pilot's own folders (the client's registry
  // of list groups, kept for the character: registry.py 431 to 540), each group with how many it holds and its
  // agents by name. Each agent's entry is the client's (userentry.py AgentEntry, 706 to 1001): its name and level, its
  // place with its security and the jumps to it where it is not in the station the pilot is in, the state of its
  // mission in the journal, and what kind of agent it is; its button starts a conversation. Its menu offers Start
  // Conversation and Remove from Addressbook (menusvc.py _CharacterMenu, 584 and 598), and in a folder Remove from it. A folder is
  // made by Create Folder, renamed or deleted from its menu (scrollentries.py 860 to 918), and an agent dragged onto
  // a group goes into it out of the folder it was in (DropInBuddyGroup, 553 to 568).
  //
  // The Search tab (SearchPanel, 322 to 381): what is typed searched on Return by the search service's Query, with
  // the Search Type and Search By of its settings menu, kept for the character (319 to 320); what is found shown by
  // kind in the client's order, each kind a group with how many (searchUtil.py 21 to 360), an agent's entry as in the
  // Agents tab with Add to Addressbook, an owner's with the address book's part of its menu (menusvc.py 570 to 620,
  // 2304 to 2318).
  //
  // The Notifications group (contactsForm.py 258, 462 to 469; addressbookService.py GetNotifications, 970 to 988):
  // the contacts' notifications (notificationMgr.GetByGroupID(9)) formatted as the client's contact formatters
  // format them, newest first, each its body's first two parts; its menu the sender's contact and block, and Delete
  // notification (contactNotificationEntry.py).
  //
  // An agent's menu has the client's Show Info, its place's Set Destination, Add or Remove Waypoint and Save
  // Location... (the bookmark window, BookmarkWindow.svelte), and Dock in Station (menusvc.py 579 to 580, 619 to 624;
  // _MapMenu, 172 to 184).
  //
  // The Agents tab's entries are chosen as its scroll chooses (multiSelect: a click alone, Ctrl to add or take out,
  // Shift for a range), each entry one agent in one group; a double click is a conversation where the pilot is docked
  // in a station, else Show Info (OnDblClick, 966 to 978). The menu of several (_GetMultiMenu, 884 to 939, on the
  // merged CharacterMenu) has Show Info, Remove from Addressbook over all of them (one question, then each one's
  // DeleteContacts), and where none is under "All Agents" their removal from their folders; a drag carries them all.
  //
  // Not here yet: Capture Portrait and the remaining owner actions.
  import { getContext, onMount, untrack } from "svelte";
  import OwnerFleetMenu from "./OwnerFleetMenu.svelte";
  import OwnerChatMenu from "./OwnerChatMenu.svelte";
  import OwnerMemberMenu from "./OwnerMemberMenu.svelte";
  import OwnerQuitMenu from "./OwnerQuitMenu.svelte";
  import OwnerExpelMenu from "./OwnerExpelMenu.svelte";
  import OwnerCEOMenu from "./OwnerCEOMenu.svelte";
  import OwnerDecorationMenu from "./OwnerDecorationMenu.svelte";
  import OwnerCorporationInviteMenu from "./OwnerCorporationInviteMenu.svelte";
  import OwnerCorporationCashMenu from "./OwnerCorporationCashMenu.svelte";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { FLEET_ROLE as MENU_ROLE, memberMenu, rankLabel, type MemberMenuEntry, type MemberMenuPlace, type MemberMenuSquad, type MemberMenuWing } from "../bridge/fleetMemberMenu.ts";
  import { resolvedName } from "../store/names.ts";
  import {
    CONTACT_GROUP,
    CONTACT_STANDING,
    MAX_CONTACTS_PER_PAGE,
    hasContactLabel,
    inStandingGroup,
    labelMaskWithout,
    labelSwatch,
    labelsOf,
    labelsToAssign,
    labelsToRemove,
    type AgentFolders,
    type ContactLabel,
    type NamedAddressBook,
    type ContactScope,
  } from "../bridge/contacts.ts";
  import { isNpcOwner } from "../bridge/mail.ts";
  import { MATCH_BY, MIN_WILDCARD_LENGTH } from "../bridge/searchMatch.ts";
  import { CONTACT_NOTIFICATION_LABELS, formatContactNotification, notificationEntryParts } from "../bridge/contactNotifications.ts";
  import type { Notification } from "../bridge/notifications.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { showInfo } from "./showInfo.ts";
  import { doubleClickOwner } from "./ownerDoubleClick.ts";
  import { showOwnerInfo } from "./ownerInfo.ts";
  import { focusMail } from "./mailFocus.ts";
  import { notify } from "./notices.ts";
  import { isFleetCommander } from "../bridge/fleetCommand.ts";
  import type { BookmarkPlace } from "../bridge/locationsList.ts";
  import BookmarkWindow from "./BookmarkWindow.svelte";
  import type { ContactAction } from "./contactAction.ts";

  let { store, flow, showAgents, openMail, openWatchlist, contactType = "contact", contactAction, onActionDone, assertActionCurrent }: { store: ClientStore; flow: AppFlow; showAgents?: () => void; openMail?: () => void; openWatchlist?: () => void; contactType?: ContactScope; contactAction?: ContactAction; onActionDone?: (book: NamedAddressBook | null) => void; assertActionCurrent?: () => void } = $props();
  const organization = $derived(contactType !== "contact");
  const alliance = $derived(contactType === "alliancecontact");
  // svelte-ignore state_referenced_locally
  const live = store.live;

  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const agentsState = store.agents;
  // svelte-ignore state_referenced_locally
  const addressBookState = store.addressBook;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // addressbook.ShowLabelMenuAndManageBtn and sessionChecker.IsDiplomat; appConst 316, 347.
  const ownerID = $derived(alliance ? $station.online?.allianceID : $station.online?.corporationID);
  const authorityScope = $derived(`${$station.online?.characterID}:${$station.online?.corporationID}:${$station.online?.allianceID}:${$station.online?.corpRole}`);
  let executor = $state<{ scope: string; allowed: boolean } | null>(null);
  const allianceChanged = $derived($live.notifications.slice().reverse().find(notice => notice.method === "OnAllianceChanged" && Number(notice.args[0]) === ownerID));
  $effect(() => {
    const scope = authorityScope;
    const active = alliance;
    const changed = allianceChanged;
    let retired = false;
    if (active) untrack(() => {
      void changed;
      executor = null;
      // ShowLabelMenuAndManageBtn reads the executor even for an ordinary member.
      void flow.saveForAllianceOffered().then(allowed => { if (!retired) executor = { scope, allowed }; }, () => {});
    });
    return () => { retired = true; };
  });
  const canManage = $derived(!organization || (!alliance || executor?.scope === authorityScope && executor.allowed) && /^(0|[1-9][0-9]*)$/.test($station.online?.corpRole ?? "") && (BigInt($station.online?.corpRole ?? "0") & (1n | 17179869184n)) !== 0n);
  // svelte-ignore state_referenced_locally
  const fleetState = store.fleet;
  // svelte-ignore state_referenced_locally
  const flightState = store.flight;
  // svelte-ignore state_referenced_locally
  const waypointsState = flow.waypoints;

  /** The window's words, by their labels (addressBookWindow.py 60, 86; contactsForm.py 136, 144 to 265, 416 to 497). */
  const WORDS = {
    title: "UI/PeopleAndPlaces/WindowTitle",
    contacts: "UI/PeopleAndPlaces/Contacts",
    all: "UI/PeopleAndPlaces/AllContacts",
    excellent: "UI/PeopleAndPlaces/ExcellentStanding",
    good: "UI/PeopleAndPlaces/GoodStanding",
    neutral: "UI/PeopleAndPlaces/NeutralStanding",
    bad: "UI/PeopleAndPlaces/BadStanding",
    terrible: "UI/PeopleAndPlaces/TerribleStanding",
    watchlist: "UI/PeopleAndPlaces/Watchlist",
    blocked: "UI/PeopleAndPlaces/Blocked",
    labels: "UI/PeopleAndPlaces/Labels",
    noLabel: "UI/PeopleAndPlaces/NoLabel",
    onlineOnly: "UI/PeopleAndPlaces/OnlineOnly",
    online: "UI/Common/Online",
    offline: "UI/Common/Offline",
    standingExcellent: "UI/PeopleAndPlaces/StandingExcellent",
    standingGood: "UI/PeopleAndPlaces/StandingGood",
    standingNeutral: "UI/PeopleAndPlaces/StandingNeutral",
    standingBad: "UI/PeopleAndPlaces/StandingBad",
    standingTerrible: "UI/PeopleAndPlaces/StandingTerrible",
    noContacts: "UI/PeopleAndPlaces/NoContacts",
    notifications: "UI/PeopleAndPlaces/Notifications",
    noNotifications: "UI/PeopleAndPlaces/NoNotifications",
    deleteNotification: "UI/PeopleAndPlaces/DeleteNotification",
    noneOnWatchlist: "UI/PeopleAndPlaces/NoneOnWatchlist",
    noneBlocked: "UI/PeopleAndPlaces/NoneBlockedYet",
    noContactsStanding: "UI/PeopleAndPlaces/NoContactsStanding",
    noContactsLabel: "UI/PeopleAndPlaces/NoContactsLabel",
    noOnlineContact: "UI/PeopleAndPlaces/NoOnlineContact",
    nothingFound: "UI/Common/NothingFound",
    name: "UI/Common/Name",
    next: "UI/Common/Next",
    previous: "UI/Common/Previous",
    withLength: "/Carbon/UI/Controls/ScrollEntries/LabelWithLength",
    management: "UI/PeopleAndPlaces/ContactManagement",
    addContact: "UI/PeopleAndPlaces/AddContact",
    showInfo: "UI/Commands/ShowInfo",
    sendMail: "UI/EVEMail/SendPilotEVEMail",
    giveMoney: "UI/Commands/GiveMoney",
    inviteToFleet: "UI/Fleet/InvitePilotToFleet",
    squadMember: "UI/Fleet/Ranks/SquadMember",
    formFleetWith: "UI/Fleet/FormFleetWith",
    editContact: "UI/PeopleAndPlaces/EditContact",
    removeContact: "UI/PeopleAndPlaces/RemoveContact",
    blockContact: "UI/PeopleAndPlaces/BlockContact",
    unblockContact: "UI/PeopleAndPlaces/UnblockContact",
    toWatchlist: "UI/PeopleAndPlaces/AddContactToWatchlist",
    buddyHint: "UI/PeopleAndPlaces/BuddyListHint",
    sendNotification: "UI/PeopleAndPlaces/SendNotificationTo",
    messageTo: "UI/PeopleAndPlaces/MessageTo",
    cannotBlockSelf: "UI/PeopleAndPlaces/CannotBlockSelf",
    cannotBlockAgents: "UI/PeopleAndPlaces/CannotBlockAgents",
    cannotBlockNpcCorps: "UI/PeopleAndPlaces/CannotBlockNPCCorps",
    alreadyBlocked: "UI/PeopleAndPlaces/AlreadyHaveBlocked",
    cancel: "UI/Common/Buttons/Cancel",
    yes: "UI/Common/Buttons/Yes",
    no: "UI/Common/Buttons/No",
    ok: "UI/Common/Buttons/OK",
    assignLabel: "UI/Mail/AssignLabel",
    removeLabel: "UI/Mail/LabelRemove",
    addContactLabel: "UI/PeopleAndPlaces/AddContactLabel",
    removeContactLabel: "UI/PeopleAndPlaces/RemoveContactLabel",
    labelAssigned: "UI/PeopleAndPlaces/LabelsLabelAssigned",
    labelRemoved: "UI/PeopleAndPlaces/LabelRemoved",
    labelsRename: "UI/PeopleAndPlaces/LabelsRename",
    labelsDelete: "UI/PeopleAndPlaces/LabelsDelete",
    manageLabels: "UI/PeopleAndPlaces/ManageLabels",
    labelsLabelName: "UI/PeopleAndPlaces/LabelsLabelName",
    labelsTypeNew: "UI/PeopleAndPlaces/LabelsTypeNewLabelName",
    labelNameTaken: "UI/PeopleAndPlaces/LabelsLabelNameTaken",
    manageLabelsWithType: "UI/Mail/ManageLabelsWithType",
    mailContacts: "UI/Mail/Contacts",
    labelName: "UI/Mail/LabelName",
    create: "UI/Mail/Create",
    labelsTextContacts: "UI/PeopleAndPlaces/LabelsTextContacts",
    labelsSelected: "UI/Mail/LabelsSelected",
    labelRename: "UI/Mail/LabelRename",
    mailDelete: "UI/Mail/Delete",
    labelTooLong: "UI/Mail/LabelTooLong",
    noLabelsSelected: "UI/PeopleAndPlaces/NoLabelsSelected",
    noContactsSelected: "UI/PeopleAndPlaces/NoContactsSelected",
    labelsAssigned: "UI/PeopleAndPlaces/LabelsAssigned",
    labelsRemoved: "UI/PeopleAndPlaces/LabelsRemoved",
    editContacts: "UI/PeopleAndPlaces/EditContacts",
    removeContacts: "UI/PeopleAndPlaces/RemoveContacts",
    unblockContacts: "UI/PeopleAndPlaces/UnblockContacts",
    selectStanding: "UI/PeopleAndPlaces/SelectStanding",
  } as const;
  /** The Agents tab's words, by their labels (addressBookWindow.py 70 to 260; userentry.py AgentEntry; menusvc.py; scrollentries.py). */
  const AGENT_WORDS = {
    agents: "UI/PeopleAndPlaces/Agents",
    allAgents: "UI/PeopleAndPlaces/AllAgents",
    createFolder: "UI/PeopleAndPlaces/CreateFolder",
    typeName: "/Carbon/UI/Common/TypeName",
    typeNameForFolder: "/Carbon/UI/Common/TypeNameForFolder",
    typeInNewName: "/Carbon/UI/Controls/ScrollEntries/TypeInNewName",
    typeInNewFolderName: "/Carbon/UI/Controls/ScrollEntries/TypeInNewFolderName",
    pleaseTypeSomething: "UI/Common/PleaseTypeSomething",
    expand: "UI/Common/Expand",
    collapse: "UI/Common/Collapse",
    changeLabel: "/Carbon/UI/Controls/ScrollEntries/ChangeLabel",
    deleteFolder: "/Carbon/UI/Controls/ScrollEntries/DeleteFolder",
    removeFromGroup: "UI/Common/RemoveFromGroup",
    removeFromFolder: "UI/PeopleAndPlaces/RemoveFromFolder",
    startConversation: "UI/Chat/StartConversationAgent",
    removeFromAddressbook: "UI/PeopleAndPlaces/RemoveFromAddressbook",
    nameAndLevel: "UI/Agents/AgentEntryNameAndLevel",
    tutorial: "UI/AgentFinder/TutorialAgentDivision",
    epicArc: "UI/AgentFinder/EpicArcAgentDivision",
    storyline: "UI/AgentFinder/StorylineAgentDivision",
    event: "UI/AgentFinder/EventAgentDivision",
    career: "UI/AgentFinder/CareerAgentDivision",
    heraldry: "UI/AgentFinder/HeraldryAgent",
    locationAndJumps: "UI/Agency/LocationAndNumJumps",
    location: "UI/Agency/Location",
    numJumps: "UI/Common/NumJumps",
    stateOffered: "UI/Journal/JournalWindow/Agents/StateOffered",
    stateAccepted: "UI/Journal/JournalWindow/Agents/StateAccepted",
    stateFailed: "UI/Journal/JournalWindow/Agents/StateFailed",
    dockInStation: "UI/Inflight/DockInStation",
    setDestination: "UI/Inflight/SetDestination",
    addWaypoint: "UI/Inflight/AddWaypoint",
    removeWaypoint: "UI/Inflight/RemoveWaypoint",
    bookmarkLocation: "UI/Inflight/BookmarkLocation",
    placeLabel: "UI/PeopleAndPlaces/NewBookmarkLocationLabel",
    spot: "UI/PeopleAndPlaces/SpotInSolarSystem",
  } as const;
  /** The client's dialogs the window says things with. */
  const DIALOGS = ["RemoveOneFromContacts", "RemoveManyFromContacts", "DeleteMailLabel", "MailLabelNameExists", "LookupStringMinimum", "NoStandingsSelected", "RemoveAgents", "ConfirmDeleteFolder", "PartialSearchLessThanMinLength", "ConfirmMakeFleetBoss", "FleetNotInFleetInSpace", "FleetCannotDoInStation", "FleetCannotDoInStructure", "FleetNotInFleet", "FleetTooManyFavorites", "FleetConfirmDemoteSelf"] as const;
  /** appConst.mailMaxLabelSize: the longest name a label has (evemail.py ManageLabelsBase, 1543; addressbookService.py 991). */
  const MAX_LABEL_NAME = 40;

  /** The client's word for a label, from the player's install; the page's own where there is none to read. */
  function word(label: string, own: string): string {
    const template = $words.templates[label];
    return typeof template === "string" ? template : own;
  }

  function filledWord(label: string, own: string, args: Record<string, string>): string {
    return plainText(formatTemplate(word(label, own), args, { nameOf: () => "" }));
  }

  /** The groups of the Contacts tab, in the form's order, each with its word (GetStaticLabelsGroups). */
  const GROUPS: readonly (readonly [number, string, string])[] = [
    [CONTACT_GROUP.notifications, WORDS.notifications, "Notifications"],
    [CONTACT_GROUP.all, WORDS.all, "All Contacts"],
    [CONTACT_STANDING.high, WORDS.excellent, "Excellent Standing"],
    [CONTACT_STANDING.good, WORDS.good, "Good Standing"],
    [CONTACT_STANDING.neutral, WORDS.neutral, "Neutral Standing"],
    [CONTACT_STANDING.bad, WORDS.bad, "Bad Standing"],
    [CONTACT_STANDING.horrible, WORDS.terrible, "Terrible Standing"],
    [CONTACT_GROUP.watchlist, WORDS.watchlist, "Buddy List"],
    [CONTACT_GROUP.blocked, WORDS.blocked, "Blocked"],
  ];

  /** GetStandingNameShort (182 to 193): a standing group's word, for the hint of an empty one. */
  const STANDING_SHORT: Readonly<Record<number, readonly [string, string]>> = {
    [CONTACT_STANDING.high]: [WORDS.standingExcellent, "Excellent"],
    [CONTACT_STANDING.good]: [WORDS.standingGood, "Good"],
    [CONTACT_STANDING.neutral]: [WORDS.standingNeutral, "Neutral"],
    [CONTACT_STANDING.bad]: [WORDS.standingBad, "Bad"],
    [CONTACT_STANDING.horrible]: [WORDS.standingTerrible, "Terrible"],
  };

  /** STANDING_DESCRIPTION (contactManagementWindow.py 22 to 26): the five standings' words, the highest first. */
  const LEVELS: readonly (readonly [number, string, string])[] = [
    [CONTACT_STANDING.high, WORDS.excellent, "Excellent Standing"],
    [CONTACT_STANDING.good, WORDS.good, "Good Standing"],
    [CONTACT_STANDING.neutral, WORDS.neutral, "Neutral Standing"],
    [CONTACT_STANDING.bad, WORDS.bad, "Bad Standing"],
    [CONTACT_STANDING.horrible, WORDS.terrible, "Terrible Standing"],
  ];

  /** A label's group, by its bit: "No Label" is -1 (GetLabelsSubContent, 205 to 213). */
  const labelGroup = (labelID: bigint): string => `label:${labelID}`;
  const NO_LABEL = labelGroup(-1n);

  let ownerQuery = $state("");
  let ownerMatches = $state<readonly { id: number; name: string }[]>([]);
  async function findCorporateOwner(): Promise<void> {
    if (!canManage || ownerQuery.trim().length < 3) return;
    await run(async () => {
      const found = await flow.searchOwners(ownerQuery.trim(), [2, 3, 4], flow.ownersSearchBy());
      ownerMatches = [...found.values()].flat().filter(owner => !isNpcOwner(owner.id));
    });
  }
  let book = $state<NamedAddressBook | null>(null);
  let error = $state("");
  let busy = $state(false);
  // svelte-ignore state_referenced_locally
  const lastSelected: unknown = flow.contactsLastSelected(contactType);
  let group = $state<number | string>(typeof lastSelected === "number" || typeof lastSelected === "string" ? lastSelected : CONTACT_GROUP.all);
  let startPos = $state(0);
  // svelte-ignore state_referenced_locally
  const keptOnlineOnly: unknown = flow.onlineBuddyOnly();
  // The contact scope is fixed for this mounted form; each parent mounts its own.
  // svelte-ignore state_referenced_locally
  let onlineOnly = $state(!organization && keptOnlineOnly === true);
  /** What the quick filter holds, and the text it filters by: taken 0.4 s after the typing stops (_SetQuickFilterInput). */
  let filterText = $state("");
  let filtering = $state("");
  let filterTimer: ReturnType<typeof setTimeout> | null = null;
  /** The entry whose menu is open, by its owner. */
  let menuFor = $state<number | null>(null);
  /** The Contact Management window open (ContactManagementWnd), with what it holds. */
  interface Managing {
    readonly contactID: number;
    readonly name: string;
    readonly isContact: boolean;
    readonly isCharacter: boolean;
    level: number;
    inWatchlist: boolean;
    notify: boolean;
    message: string;
    /** The label chosen in the window's labels (by its bit's digits), "" for none; offered only to add an owner. */
    labelKey: string;
    /** What waits on the window: told whether the owner was added (AssignLabelFromWnd's AddToAddressBook, 1104 to 1111). */
    readonly afterAdd: ((added: boolean) => void) | null;
  }
  let managing = $state<Managing | null>(null);
  /** A question of the client's waiting on the pilot (its dialog), and what it says. */
  let question = $state<{ readonly title: string; readonly body: string; readonly answer: (yes: boolean) => void } | null>(null);
  /** What the window last said (CustomInfo). */
  let notes = $state<readonly string[]>([]);
  /** What the client last told in passing (CustomNotify), in the order it told it. */
  let told = $state<readonly string[]>([]);
  /** The entries selected, by their owners (the scroll's multiSelect); let go as the list is drawn again. */
  let selectedIDs = $state<readonly number[]>([]);
  /** The label of the left list whose menu is open, by its bit's digits. */
  let labelMenuFor = $state<string | null>(null);
  /** The rename's popup (NamePopup), the label it renames and what is typed. */
  let renaming = $state<{ readonly labelID: bigint; value: string } | null>(null);
  /** Manage Labels open, the name typed for a new label, and the labels ticked, by their bits' digits. */
  let managingLabels = $state(false);
  let newLabelName = $state("");
  let checkedLabels = $state<readonly string[]>([]);
  /** The window that edits several contacts (ContactManagementMultiEditWnd): whom, their names, the standing chosen. */
  let editingSeveral = $state<{ readonly ids: readonly number[]; readonly names: string; level: number | null } | null>(null);

  /** The contacts' notifications (LoadData, 545: notificationSvc.GetFormattedNotifications(groupContacts)); none where they could not be read. */
  let notificationsHeld = $state<readonly Notification[] | null>(null);
  /** The notification whose menu is open. */
  let notificationMenuFor = $state<number | null>(null);

  let readGeneration = 0;
  let disposed = false;
  async function load(): Promise<void> {
    const generation = ++readGeneration;
    const characterID = store.station.get().online?.characterID;
    const owner = ownerID;
    busy = true;
    error = "";
    try {
      const [read, notifications] = await Promise.all([flow.addressBook(contactType), organization ? Promise.resolve(null) : flow.contactNotifications().catch(() => null)]);
      if (disposed || characterID !== store.station.get().online?.characterID || owner !== ownerID) return;
      notificationsHeld = notifications;
      if (generation !== readGeneration) return;
      book = read;
      applyOrganizationNotices(store.live.get().notifications);
    } catch (cause) {
      if (disposed || generation !== readGeneration) return;
      error = isSessionLost(cause) ? "Your session ended. Pick your character again." : cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (!disposed && generation === readGeneration) busy = false;
    }
  }

  // The held answer already includes old notices. Only apply updates arriving after this form was mounted;
  // updates received during its read are applied once the answer arrives too.
  const seenOrganizationNotices = new WeakSet<object>(live.get().notifications);
  const seenPersonalNotices = new WeakSet<object>(live.get().notifications);
  // addressbookService's own ScatterEvents (contactsForm 611-635). Read the
  // amended held answer, without reloading notifications or disturbing a draft.
  function applyPersonalNotices(notices: typeof $live.notifications): void {
    if (organization || contactAction || disposed) return;
    let changed = false;
    for (const notice of notices) {
      if (seenPersonalNotices.has(notice)) continue;
      seenPersonalNotices.add(notice);
      if ((notice.method === "OnContactChange" || notice.method === "OnEditLabel") && notice.args[1] === "contact"
        || notice.method === "OnMyLabelsChanged" && notice.args[0] === "contact"
        || notice.method === "OnBlockContacts" || notice.method === "OnUnblockContacts") changed = true;
    }
    if (!changed) return;
    const generation = ++readGeneration;
    const characterID = store.station.get().online?.characterID;
    void flow.addressBook().then(read => {
      if (disposed || generation !== readGeneration || characterID !== store.station.get().online?.characterID) return;
      book = read;
      busy = false;
      drawnAgain();
    }).catch(cause => {
      if (disposed || generation !== readGeneration || characterID !== store.station.get().online?.characterID) return;
      busy = false;
      error = isSessionLost(cause) ? "Your session ended. Pick your character again." : cause instanceof Error ? cause.message : String(cause);
    });
  }
  function applyOrganizationNotices(notices: typeof $live.notifications): void {
    if (!organization || book === null) return;
    const values = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : value && typeof value === "object" && "items" in value && Array.isArray(value.items) ? value.items : [];
    for (const notice of notices) {
      if (seenOrganizationNotices.has(notice)) continue;
      seenOrganizationNotices.add(notice);
      if (notice.method !== "OnOrganizationContactsUpdated" || Number(notice.args[0]) !== ownerID) continue;
      const contacts: Map<number, NamedAddressBook["contacts"][number]> = new Map(book.contacts.map(contact => [contact.contactID, contact]));
      for (const update of values(notice.args[1])) {
        const [id, level, mask] = values(update); const contactID = Number(id);
        if (!(contactID > 0)) continue;
        if (level == null && mask == null) { contacts.delete(contactID); continue; }
        const previous = contacts.get(contactID);
        contacts.set(contactID, { contactID, name: previous?.name ?? "Unknown contact", inWatchlist: false,
          relationshipID: previous && mask != null ? previous.relationshipID : Number(level ?? previous?.relationshipID ?? 0),
          labelMask: mask == null ? previous?.labelMask ?? 0n : BigInt(typeof mask === "object" && "value" in mask ? String(mask.value) : String(mask)) });
        flow.requestNames([{kind: "owner", id: contactID}]);
      }
      book = { ...book, contacts: [...contacts.values()] };
      drawnAgain();
    }
  }
  $effect(() => {
    const notices = $live.notifications;
    untrack(() => applyOrganizationNotices(notices));
    untrack(() => applyPersonalNotices(notices));
  });

  /** The labels by name in lower case (GetLabelsSubContent, 197 to 204). */
  const labels = $derived([...(book?.labels ?? [])].sort((left, right) => {
    const a = left.name.toLowerCase();
    const b = right.name.toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  }));
  const labelOf = (groupID: number | string) => labels.find((label) => labelGroup(label.labelID) === groupID);

  /** LoadData's filter (contactsForm.py 548 to 552; quickFilter.py QuickFilter): an owner whose name holds the text. */
  const matches = (name: string): boolean => filtering === "" || name.toLowerCase().includes(filtering.toLowerCase());
  const contacts = $derived((book?.contacts ?? []).map(contact => organization ? { ...contact, name: resolvedName($names.resolved, "owner", contact.contactID, contact.name) } : contact).filter((contact) => matches(contact.name)));
  const blocked = $derived((book?.blocked ?? []).filter((owner) => matches(owner.name)));
  const blockedIDs = $derived(new Set((book?.blocked ?? []).map((owner) => owner.ownerID)));
  const watched = $derived(new Set((book?.contacts ?? []).filter((contact) => contact.inWatchlist).map((contact) => contact.contactID)));

  /** onlineStatus.GetOnlineStatus as the entries read it, from what the service keeps: online, offline, or not known. */
  function onlineOf(contactID: number): boolean | undefined {
    return $addressBookState.online?.[contactID];
  }

  /** GetContactsCount (372 to 405) and GetContactsLabelCount (363 to 370): how many a group holds, of what the filter leaves. */
  function countOf(groupID: number | string): number {
    if (groupID === CONTACT_GROUP.notifications) return notificationsHeld?.length ?? 0;
    if (groupID === CONTACT_GROUP.blocked) return blocked.length;
    if (groupID === CONTACT_GROUP.all) return contacts.length;
    if (groupID === CONTACT_GROUP.watchlist) return contacts.filter((contact) => contact.inWatchlist).length;
    if (typeof groupID === "string") {
      const labelID = groupID === NO_LABEL ? -1n : labelOf(groupID)?.labelID;
      return labelID === undefined ? 0 : contacts.filter((contact) => hasContactLabel(labelID, contact.labelMask)).length;
    }
    return contacts.filter((contact) => inStandingGroup(groupID, contact.relationshipID)).length;
  }

  interface Row {
    readonly id: number;
    readonly name: string;
    readonly standing: number | null;
    /** Its online state where it is a buddy whose state the service keeps (SetOnline), else none. */
    readonly online: boolean | null;
    readonly blocked: boolean;
    /** Its contact's labels' bits, nought for an owner that is no contact (userentry.py SetLabelText, 345 to 351: GetLabelMask). */
    readonly labelMask: bigint;
    /**
     * Its labels, as the entry shows them under its name (GetLabelText, 1189 to 1202): by name, each in its swatch's
     * colour where it has one, joined by commas.
     */
    readonly labelNames: readonly { readonly name: string; readonly color: string | null }[];
  }

  /**
   * GetScrolllist (416 to 497): the group's entries by name (SortListOfTuples on the name in lower case), a page of
   * them, and the hint for none. "Online only" keeps the buddies the service has online (GetContactEntry, 936 to
   * 948). The buddy list holds characters only; the page takes a contact for one where it is no corporation's or
   * alliance's by its id.
   */
  const shown = $derived.by((): { rows: readonly Row[]; total: number; hint: string } => {
    let entries: { readonly id: number; readonly name: string; readonly standing: number | null }[];
    let hint = organization ? alliance ? word("UI/PeopleAndPlaces/NoAllianceContacts", "No alliance contacts yet.") : word("UI/PeopleAndPlaces/NoCorpContacts", "No corporation contacts yet.") : word(WORDS.noContacts, "No contacts yet.");
    if (group === CONTACT_GROUP.notifications) {
      // Its entries are the notifications' (notificationEntries, below), and no contact is among them.
      entries = [];
      hint = word(WORDS.noNotifications, "No notifications.");
    } else if (group === CONTACT_GROUP.blocked) {
      entries = blocked.map((owner) => ({ id: owner.ownerID, name: owner.name, standing: null }));
      hint = word(WORDS.noneBlocked, "No one is blocked.");
    } else if (group === CONTACT_GROUP.watchlist) {
      entries = contacts.filter((contact) => contact.inWatchlist && isCharacterContact(contact.contactID)).map(entryOf);
      hint = word(WORDS.noneOnWatchlist, "No one is on the buddy list yet.");
    } else if (group === CONTACT_GROUP.all) {
      entries = contacts.map(entryOf);
    } else if (typeof group === "string") {
      const label = labelOf(group);
      const labelID = group === NO_LABEL ? -1n : label?.labelID;
      entries = labelID === undefined ? [] : contacts.filter((contact) => hasContactLabel(labelID, contact.labelMask)).map(entryOf);
      hint = filledWord(WORDS.noContactsLabel, "No contacts with the label: {standingText}", { standingText: group === NO_LABEL ? word(WORDS.noLabel, "No Label") : (label?.name ?? "") });
    } else {
      entries = contacts.filter((contact) => inStandingGroup(group as number, contact.relationshipID)).map(entryOf);
      const [label, own] = STANDING_SHORT[group] ?? [WORDS.standingNeutral, "Neutral"];
      hint = filledWord(organization ? alliance ? "UI/PeopleAndPlaces/NoAllianceContactsStanding" : "UI/PeopleAndPlaces/NoCorpContactsStanding" : WORDS.noContactsStanding, "No contacts with standing: {standingText}", { standingText: word(label, own) });
    }
    if (onlineOnly) {
      entries = entries.filter((entry) => watched.has(entry.id) && onlineOf(entry.id) === true);
      hint = word(WORDS.noOnlineContact, "None of your contacts is online.");
    }
    if (filtering !== "") {
      hint = word(WORDS.nothingFound, "Nothing Found");
    }
    const rows = entries.map((entry): Row => {
      const labelMask = maskOf(entry.id);
      return {
        ...entry,
        online: group !== CONTACT_GROUP.blocked && watched.has(entry.id) && isCharacterContact(entry.id) ? (onlineOf(entry.id) ?? null) : null,
        blocked: blockedIDs.has(entry.id),
        labelMask,
        labelNames: labelsOf(labelMask, labels).map((label) => ({ name: label.name, color: labelSwatch(label.color) })),
      };
    });
    const sorted = rows.map((row, place) => ({ row, place })).sort((left, right) => {
      const a = left.row.name.toLowerCase();
      const b = right.row.name.toLowerCase();
      return a < b ? -1 : a > b ? 1 : left.place - right.place;
    }).map(({ row }) => row);
    return { rows: sorted.slice(startPos, startPos + MAX_CONTACTS_PER_PAGE), total: sorted.length, hint };
  });

  function entryOf(contact: { readonly contactID: number; readonly name: string; readonly relationshipID: number }) {
    return { id: contact.contactID, name: contact.name, standing: contact.relationshipID };
  }

  /** GetLabelMaskForContactType (1218 to 1232): a contact's labels' bits, nought for an owner that is none. */
  function maskOf(ownerID: number): bigint {
    return (book?.contacts ?? []).find((contact) => contact.contactID === ownerID)?.labelMask ?? 0n;
  }

  /** The entries selected, in the list's order, of those it shows. */
  const selectedRows = $derived(shown.rows.filter((row) => selectedIDs.includes(row.id)));

  function toggleSelected(ownerID: number): void {
    selectedIDs = selectedIDs.includes(ownerID) ? selectedIDs.filter((id) => id !== ownerID) : [...selectedIDs, ownerID];
  }

  /** CustomNotify: the client's word told in passing. */
  function tell(text: string): void {
    told = [...told, text];
  }

  /** What the client does on a change of the address book (contactsForm.py ReloadData, 593 to 598): the list drawn again, its selection let go, and a page back where the one shown is left empty. */
  function drawnAgain(): void {
    selectedIDs = [];
    if (startPos > 0 && startPos >= shown.total) {
      browse(-1);
    }
  }

  /** The address book's contacts among those named, their labels' bits changed as the client changes its own. */
  function changeMasks(ownerIDs: readonly number[], change: (labelMask: bigint) => bigint): void {
    if (book !== null) {
      book = { ...book, contacts: book.contacts.map((contact) => (ownerIDs.includes(contact.contactID) ? { ...contact, labelMask: change(contact.labelMask) } : contact)) };
    }
  }

  /** The pilot's own character, which the menus offer nothing of (characterCheckers.py IsMe). */
  const myID = $derived($station.online?.characterID ?? null);
  const contactIDs = $derived(new Set((book?.contacts ?? []).map((contact) => contact.contactID)));
  /**
   * The pilot's fleet as the page last read it, which the client's session always knows (sessionChecker.py
   * IsPilotFleetMember, 126 to 127; isPilotInSameFleetAs, 141 to 142, by the fleet service's members): known where
   * the read said the pilot is in one or in none, and nothing of a fleet offered while it is not.
   */
  const fleetKnown = $derived($fleetState.availability === "ready" || $fleetState.availability === "not-in-fleet");
  const fleetMembers = $derived($fleetState.availability === "ready" ? ($fleetState.fleet?.initState.value.members ?? []) : []);
  const fleetMemberIDs = $derived(new Set(fleetMembers.map((member) => Number(member.charID))));
  /** The fleet as MemberMenu reads it (fleetSvc.GetMembers, GetWings, GetOptions().isFreeMove), numbers made numbers. */
  const idOrNull = (value: number | string | null): number | null => (value === null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));
  const menuMembers = $derived(fleetMembers.flatMap((member) => {
    const charID = idOrNull(member.charID);
    return charID === null ? [] : [{ charID, role: member.role, job: member.job, wingID: idOrNull(member.wingID), squadID: idOrNull(member.squadID) }];
  }));
  const menuWings = $derived(($fleetState.availability === "ready" ? ($fleetState.fleet?.initState.value.wings ?? []) : []).flatMap((wing) => {
    const wingID = idOrNull(wing.wingID);
    return wingID === null ? [] : [{ wingID, name: wing.name, squads: wing.squads.flatMap((squad) => {
      const squadID = idOrNull(squad.squadID);
      return squadID === null ? [] : [{ squadID, name: squad.name }];
    }) }];
  }));
  const fleetIsFreeMove = $derived($fleetState.fleet?.initState.value.options.isFreeMove === true);
  /** IsPilotFleetCreator or IsPilotFleetCommander (characterCheckers.py 425 to 427; sessionChecker.py 120 to 121). */
  const commandsFleet = $derived(fleetMembers.some((member) => Number(member.charID) === myID && isFleetCommander(member)));

  /**
   * characterCheckers.py: Add Contact where it is none of the pilot's (62 to 69), Edit and Remove Contact where it is
   * one (254 to 263), Block where it is not blocked (104 to 111), Unblock where it is (373 to 378); none for the pilot
   * itself, and none but Unblock for an NPC.
   */
  function offersOf(ownerID: number): { showInfo: boolean; mail: boolean; add: boolean; edit: boolean; block: boolean; unblock: boolean; money: boolean; inviteToFleet: boolean; formFleetWith: boolean } {
    const mine = ownerID === myID;
    const npc = isNpcOwner(ownerID);
    const isContact = contactIDs.has(ownerID);
    if (organization) {
      const editable = canManage && !npc;
      return { showInfo: true, mail: false, add: editable && !isContact, edit: editable && isContact, block: false, unblock: false, money: false, inviteToFleet: false, formFleetWith: false };
    }
    const isBlocked = blockedIDs.has(ownerID);
    if (!isCharacterContact(ownerID)) {
      // A corporation's, an alliance's or a faction's (menusvc.py GetMenuFromItemIDTypeID, 2304 to 2318): Edit and
      // Remove Contact where it is one, Add Contact where not, an NPC's as well; Block or Unblock where it is no NPC's.
      // Show Info2297 carries the actual owner type, including NPC owners.
      return { showInfo: true, mail: false, add: !isContact, edit: isContact, block: !npc && !isBlocked, unblock: !npc && isBlocked, money: false, inviteToFleet: false, formFleetWith: false };
    }
    return {
      // OfferShowInfo (350 to 353): every character's (an aura agent's aside, which no address book holds).
      showInfo: true,
      // OfferSendPilotEVEMail (343 to 348): none for the pilot itself or an NPC.
      mail: !mine && !npc,
      add: !mine && !npc && !isContact,
      edit: !mine && !npc && isContact,
      block: !mine && !npc && !isBlocked,
      unblock: !mine && isBlocked,
      // OfferGiveMoney (178 to 185): none for the pilot itself or an NPC.
      money: !mine && !npc,
      // OfferInvitePilotToFleet (187 to 196): in a fleet the character is not in, the pilot its creator or a
      // commander. OfferFormFleetWith (171 to 176): in none, the pilot's own character too. Neither for an NPC.
      inviteToFleet: !npc && fleetKnown && $fleetState.availability === "ready" && !fleetMemberIDs.has(ownerID) && commandsFleet,
      formFleetWith: !npc && fleetKnown && $fleetState.availability === "not-in-fleet",
    };
  }

  function ownerSearchResult(resultType: number): boolean {
    return resultType === RESULT_TYPE.character || resultType === RESULT_TYPE.corporation || resultType === RESULT_TYPE.alliance || resultType === RESULT_TYPE.faction;
  }
  /** Show Info from an owner's menu (menusvc.py 579 to 580). */
  function ownerInfo(ownerID: number): void {
    menuFor = null;
    searchMenuFor = null;
    void run(() => showOwnerInfo(flow, ownerID));
  }

  /** Send Pilot EVEMail from an owner's menu (menusvc.py 590 to 591): the mail window, a new message to the pilot. */
  function mailOwner(ownerID: number, name: string): void {
    menuFor = null;
    searchMenuFor = null;
    openMail?.();
    focusMail({ kind: "compose", characterID: ownerID, name });
  }

  /**
   * Invite to Fleet's Squad Member (menusvc.py 631 to 632; evefleet/client/menu.py 64 to 65) and Form Fleet With
   * (637 to 638): fleetSvc.Invite(charID, None, None, None), a fleet formed first where the pilot is in none. A
   * refusal is said as the Fleet window says it.
   */
  function fleetInvite(ownerID: number, form: boolean): void {
    menuFor = null;
    searchMenuFor = null;
    void run(async () => {
      await (form ? flow.formFleetWith(ownerID) : flow.inviteFleetMember(ownerID));
      // (A refusal the client's own dialog said is not said again: ClientDialogs.svelte.)
      const refused = store.fleet.get().actionErrorSaid === true ? null : store.fleet.get().actionError;
      if (refused !== null) throw new Error(refused);
    });
  }

  /** Invite to Fleet (menusvc.FleetInviteMenu): MemberMenu's places for one not in the fleet, isMove False. */
  function inviteMenuOf(ownerID: number): MemberMenuEntry[] {
    if (myID === null) return [];
    return memberMenu({ targetCharID: ownerID, me: myID, members: menuMembers, wings: menuWings, isFreeMove: fleetIsFreeMove, isMove: false });
  }

  /** One of the invite menu's places (DoInviteToFleet: fleetSvc.Invite(charID, wingID, squadID, role)). */
  function fleetInviteTo(ownerID: number, place: MemberMenuPlace): void {
    menuFor = null;
    searchMenuFor = null;
    void run(async () => {
      await flow.inviteFleetMember(ownerID, undefined, undefined, { wingID: place.wingID, squadID: place.squadID, role: place.role });
      // (A refusal the client's own dialog said is not said again: ClientDialogs.svelte.)
      const refused = store.fleet.get().actionErrorSaid === true ? null : store.fleet.get().actionError;
      if (refused !== null) throw new Error(refused);
    });
  }

  // ── The fleet's own menu for a member (menusvc.py FleetMenu; characterCheckers.py FleetMemberChecker) ─────────

  /** The fleet menu's words (menusvc.py FleetMenu; WarpToMenu, 2254 to 2274; ConfirmMenu, 2250). */
  const FLEET_WORDS = {
    wingX: "UI/Fleet/FleetSubmenus/WingX",
    squadX: "UI/Fleet/FleetSubmenus/SquadX",
    squadWithCount: "UI/Fleet/FleetSubmenus/SquadNameWithNumMembers",
    rankLeader: "UI/Fleet/Ranks/FleetCommander",
    rankWing: "UI/Fleet/Ranks/WingCommander",
    rankSquad: "UI/Fleet/Ranks/SquadCommander",
    rankMember: "UI/Fleet/Ranks/SquadMember",
  } as const;
  /** OfferFleetMenu (characterCheckers.py 158 to 165): a character of the pilot's own fleet, no NPC. */
  function fleetMenuOffered(ownerID: number): boolean {
    return isCharacterContact(ownerID) && !isNpcOwner(ownerID) && $fleetState.availability === "ready" && fleetMemberIDs.has(ownerID);
  }

  function fleetDone(): void {
    menuFor = null;
    searchMenuFor = null;
    notes = [];
  }

  /** A rank's word (RANK_LABELS), the page's own where the client's is not to hand. */
  function rankWord(role: number | null): string {
    const label = rankLabel(role);
    const own = role === MENU_ROLE.leader ? "Fleet boss" : role === MENU_ROLE.wingCmdr ? "Wing lead" : role === MENU_ROLE.squadCmdr ? "Squad lead" : "Member";
    return word(label, own);
  }

  /** A wing's name, or the client's WingX by its number. */
  function wingWord(wing: MemberMenuWing): string {
    return wing.name !== "" ? wing.name : filledWord(FLEET_WORDS.wingX, "Wing {wingNumber}", { wingNumber: String(wing.wingNumber) });
  }

  /** A squad's name, or the client's SquadX by its number, with how many are in it (SquadNameWithNumMembers). */
  function squadWord(squad: MemberMenuSquad): string {
    const squadName = squad.name !== "" ? squad.name : filledWord(FLEET_WORDS.squadX, "Squad {squadNumber}", { squadNumber: String(squad.squadNumber) });
    return filledWord(FLEET_WORDS.squadWithCount, "{squadName} [{numMembers}]", { squadName, numMembers: String(squad.numMembers) });
  }

  /** Owner-menu Give Money uses the shared native transfer window. */
  function giveMoneyTo(ownerID: number, _name: string): void {
    menuFor = null; searchMenuFor = null;
    void run(() => flow.openMoneyTransfer(ownerID));
  }

  /** A write of the window's, its refusal said. */
  async function run(action: () => Promise<void>): Promise<void> {
    busy = true;
    error = "";
    try {
      assertActionCurrent?.();
      await action();
      assertActionCurrent?.();
      if (contactAction) onActionDone?.(book);
    } catch (cause) {
      error = isSessionLost(cause) ? "Your session ended. Pick your character again." : cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  /**
   * AddToAddressBook (addressbookService.py 705 to 816): the Contact Management window for the owner, a contact's
   * standing and buddy list as they are, a new one at Neutral (contactManagementWindow.py 36 to 37), the
   * notification off and no message.
   */
  function manage(ownerID: number, name: string, labelID: bigint | null = null, afterAdd: ((added: boolean) => void) | null = null): void {
    menuFor = null;
    notes = [];
    const contact = (book?.contacts ?? []).find((each) => each.contactID === ownerID);
    managing = {
      contactID: ownerID,
      name,
      isContact: contact !== undefined,
      isCharacter: isCharacterContact(ownerID),
      level: contact?.relationshipID ?? CONTACT_STANDING.neutral,
      inWatchlist: contact?.inWatchlist ?? false,
      notify: false,
      message: "",
      // The labels' combo set to the label it was opened with, where it is one of the labels (Combo.SetValue, 103 to 104).
      labelKey: labelID !== null && labels.some((label) => label.labelID === labelID) ? String(labelID) : "",
      afterAdd,
    };
  }

  /**
   * Confirm (contactManagementWindow.py 146 to 160): AddContact or EditContact, and the contact kept as the address
   * book keeps it; then the label chosen given to it, and told, as AssignLabelFromWnd gives and tells it (791 to 792).
   */
  function confirmManagement(): void {
    const held = managing;
    if (held === null) return;
    told = [];
    void run(async () => {
      await flow.addOrEditContact({
        contactID: held.contactID,
        relationshipID: held.level,
        inWatchlist: held.isCharacter ? held.inWatchlist : false,
        sendNotification: held.isCharacter ? held.notify : false,
        message: held.isCharacter ? held.message : "",
        isCharacter: held.isCharacter,
      }, held.isContact, contactType);
      if (book !== null) {
        const before = book.contacts.find((each) => each.contactID === held.contactID);
        const contact = { contactID: held.contactID, name: held.name, relationshipID: held.level, inWatchlist: held.isCharacter && held.inWatchlist, labelMask: before?.labelMask ?? 0n };
        book = { ...book, contacts: [...book.contacts.filter((each) => each.contactID !== held.contactID), contact] };
      }
      managing = null;
      const chosen = held.isContact ? undefined : labels.find((label) => String(label.labelID) === held.labelKey);
      if (chosen !== undefined) {
        await labelGiven([held.contactID], chosen.labelID, chosen.name, true);
      }
      drawnAgain();
      held.afterAdd?.(true);
    });
  }

  /** Cancel: the window closed, nothing sent, and what waited on it told so. */
  function cancelManagement(): void {
    const held = managing;
    managing = null;
    held?.afterAdd?.(false);
    if (contactAction) onActionDone?.(book);
  }

  /**
   * AssignLabelFromWnd (1096 to 1125): AssignLabels with the owners and the bits; the bits given to those that are
   * contacts. A lone owner that is none opens Contact Management to add it with that label chosen, and the label
   * is its, and told, only where it is added. Told where `tellIt` (from a menu, not from Manage Labels).
   */
  async function labelGiven(ownerIDs: readonly number[], bits: bigint, labelName: string, tellIt: boolean): Promise<void> {
    await flow.labelContacts(ownerIDs, bits, true, contactType);
    const first = ownerIDs[0];
    const lone = ownerIDs.length === 1 && first !== undefined && !contactIDs.has(first) ? first : null;
    changeMasks(ownerIDs, (labelMask) => labelMask | bits);
    drawnAgain();
    const sayIt = () => {
      if (tellIt && ownerIDs.length > 0) {
        const name = labelName !== "" ? labelName : (labels.find((label) => label.labelID === bits)?.name ?? "");
        tell(filledWord(WORDS.labelAssigned, "Label {labelName} given to {contacts}", { labelName: name, contacts: String(ownerIDs.length) }));
      }
    };
    if (lone === null) {
      sayIt();
      return;
    }
    const name = shown.rows.find((row) => row.id === lone)?.name ?? (book?.blocked ?? []).find((owner) => owner.ownerID === lone)?.name ?? String(lone);
    manage(lone, name, bits, (added) => {
      if (added) {
        changeMasks([lone], (labelMask) => labelMask | bits);
        sayIt();
      }
    });
  }

  /** A label chosen from an entry's menu, or from the menu of several (AssignLabelFromMenu, 1092 to 1094). */
  function assignLabel(ownerIDs: readonly number[], label: ContactLabel): void {
    menuFor = null;
    notes = [];
    told = [];
    void run(() => labelGiven(ownerIDs, label.labelID, label.name, true));
  }

  /** RemoveLabelFromMenu (1127 to 1131) by RemoveLabelFromWnd (1133 to 1147): RemoveLabels, the bit taken off, and told. */
  function removeLabel(ownerIDs: readonly number[], label: ContactLabel): void {
    menuFor = null;
    notes = [];
    told = [];
    void run(async () => {
      await flow.labelContacts(ownerIDs, label.labelID, false, contactType);
      changeMasks(ownerIDs, (labelMask) => labelMaskWithout(labelMask, label.labelID));
      drawnAgain();
      tell(filledWord(WORDS.labelRemoved, "Label {labelName} taken off {numContacts}", { labelName: label.name, numContacts: String(ownerIDs.length) }));
    });
  }

  /**
   * RemoveFromAddressBook (817 to 869): the client's question, RemoveOneFromContacts for one and
   * RemoveManyFromContacts for several, their names joined by commas; then DeleteContacts, and the contacts let go.
   */
  function removeContacts(owners: readonly { readonly id: number; readonly name: string }[]): void {
    menuFor = null;
    notes = [];
    told = [];
    const dialog = owners.length > 1 ? "RemoveManyFromContacts" : "RemoveOneFromContacts";
    const ownerIDs = owners.map((owner) => owner.id);
    question = {
      title: filledWord(`dialog:${dialog}/title`, "Remove?", {}),
      body: filledWord(`dialog:${dialog}/body`, "Take {names} off your contacts?", { names: owners.map((owner) => owner.name).join(", ") }),
      answer: (yes) => {
        question = null;
        if (!yes) { if (contactAction) onActionDone?.(book); return; }
        void run(async () => {
          await flow.deleteContacts(ownerIDs, contactType);
          if (book !== null) {
            book = { ...book, contacts: book.contacts.filter((each) => !ownerIDs.includes(each.contactID)) };
          }
          drawnAgain();
        });
      },
    };
  }

  /** EditContacts (682 to 703): the window that gives several contacts one standing, none chosen yet. */
  function editSeveral(owners: readonly { readonly id: number; readonly name: string }[]): void {
    menuFor = null;
    notes = [];
    told = [];
    editingSeveral = { ids: owners.map((owner) => owner.id), names: owners.map((owner) => owner.name).join(", "), level: null };
  }

  /**
   * Confirm (contactManagementMultiEditWindow.py 106 to 119): refused with the client's NoStandingsSelected where no
   * standing is chosen; else EditContactsRelationshipID, and the contacts among them given the standing.
   */
  function confirmSeveral(): void {
    const held = editingSeveral;
    if (held === null) return;
    if (held.level === null) {
      notes = [filledWord("dialog:NoStandingsSelected/body", "Choose a standing first.", {})];
      return;
    }
    const level = held.level;
    notes = [];
    void run(async () => {
      await flow.editContactsRelationship(held.ids, level, contactType);
      if (book !== null) {
        book = { ...book, contacts: book.contacts.map((contact) => (held.ids.includes(contact.contactID) ? { ...contact, relationshipID: level } : contact)) };
      }
      editingSeveral = null;
      drawnAgain();
    });
  }

  /** BlockOwner (645 to 664): the pilot itself, an agent and an NPC's corporation refused in the client's words; else BlockOwners. */
  function block(ownerID: number, name: string): void {
    menuFor = null;
    notes = [];
    if (ownerID === myID) {
      notes = [word(WORDS.cannotBlockSelf, "You cannot block yourself.")];
      return;
    }
    if (isNpcOwner(ownerID)) {
      notes = [isCharacterContact(ownerID) ? word(WORDS.cannotBlockAgents, "Agents cannot be blocked.") : word(WORDS.cannotBlockNpcCorps, "NPC corporations cannot be blocked.")];
      return;
    }
    if (blockedIDs.has(ownerID)) {
      notes = [filledWord(WORDS.alreadyBlocked, "{userName} is blocked already.", { userName: name })];
      return;
    }
    void run(async () => {
      await flow.blockOwners([ownerID]);
      if (book !== null) {
        book = { ...book, blocked: [...book.blocked, { ownerID, name }] };
      }
    });
  }

  /** UnblockOwner (666 to 677): UnblockOwners with those of the owners blocked, and they let go of the blocked. */
  function unblock(ownerIDs: readonly number[]): void {
    menuFor = null;
    notes = [];
    told = [];
    const blockedOnes = ownerIDs.filter((ownerID) => blockedIDs.has(ownerID));
    if (blockedOnes.length === 0) return;
    void run(async () => {
      await flow.unblockOwners(blockedOnes);
      if (book !== null) {
        book = { ...book, blocked: book.blocked.filter((each) => !blockedOnes.includes(each.ownerID)) };
      }
      drawnAgain();
    });
  }

  /**
   * The labels' writes from the window (addressbookService.py 990 to 1090): a label renamed by the client's popup,
   * its name refused where another label has it (CheckLabelName, 1059 to 1065) and nothing done where it is empty;
   * deleted after the client's DeleteMailLabel, its bit taken off every contact and the labels asked again.
   */
  function confirmRename(): void {
    const held = renaming;
    if (held === null) return;
    const name = held.value.trim();
    if (labels.some((label) => label.name === name)) {
      notes = [word(WORDS.labelNameTaken, "Another label has that name.")];
      return;
    }
    notes = [];
    renaming = null;
    if (name === "") return;
    void run(async () => {
      await flow.renameContactLabel(held.labelID, name, contactType);
      if (book !== null) {
        book = { ...book, labels: (book.labels ?? []).map((label) => (label.labelID === held.labelID ? { ...label, name } : label)) };
      }
      drawnAgain();
    });
  }

  function deleteLabel(label: ContactLabel, labelName: string): void {
    labelMenuFor = null;
    notes = [];
    told = [];
    question = {
      title: filledWord("dialog:DeleteMailLabel/title", "Delete label?", {}),
      body: filledWord("dialog:DeleteMailLabel/body", "Delete the label {labelName}?", { labelName }),
      answer: (yes) => {
        question = null;
        if (!yes) return;
        void run(async () => {
          const asked = await flow.deleteContactLabel(label.labelID, contactType);
          if (book !== null) {
            book = {
              ...book,
              labels: asked ?? (book.labels ?? []).filter((each) => each.labelID !== label.labelID),
              contacts: book.contacts.map((contact) => ({ ...contact, labelMask: labelMaskWithout(contact.labelMask, label.labelID) })),
            };
          }
          checkedLabels = checkedLabels.filter((key) => key !== String(label.labelID));
          // The group shown gone, the form shows its first (LoadLeftSide, 164 to 179).
          if (group === labelGroup(label.labelID)) {
            choose(CONTACT_GROUP.all);
          }
          drawnAgain();
        });
      },
    };
  }

  /**
   * Manage Labels' Create (evemail.py ManageLabelsBase.CreateLabel, 1563 to 1581): the name trimmed, refused where a
   * label has it in any case (MailLabelNameExists), where it is empty (LookupStringMinimum), or where it is over
   * forty (LabelTooLong); then made, with no colour, and ticked (UpdateLabelsList, 1614 to 1620).
   */
  function createLabel(): void {
    notes = [];
    told = [];
    const name = newLabelName.trim();
    if (labels.some((label) => label.name.toLowerCase() === name.toLowerCase())) {
      tell(filledWord("dialog:MailLabelNameExists/body", "A label has that name already.", {}));
      return;
    }
    if ([...name].length < 1) {
      tell(filledWord("dialog:LookupStringMinimum/body", "Type at least {minimum} character.", { minimum: "1" }));
      return;
    }
    if ([...name].length > MAX_LABEL_NAME) {
      tell(word(WORDS.labelTooLong, "That name is too long."));
      return;
    }
    void run(async () => {
      const labelID = await flow.createContactLabel(name, contactType);
      if (labelID !== null && book !== null) {
        book = { ...book, labels: [...(book.labels ?? []).filter((label) => label.labelID !== labelID), { labelID, name, color: null }] };
        checkedLabels = [...checkedLabels, String(labelID)];
      }
      drawnAgain();
    });
  }

  /**
   * Manage Labels' Assign Label and Remove Label (manageLabels.py ManageLabel, 48 to 94): the labels ticked summed
   * and given to the entries selected, or taken off them; refused where none is ticked (NoLabelsSelected) or none
   * selected (NoContactsSelected), and told before it is sent.
   */
  function manageLabel(give: boolean): void {
    notes = [];
    told = [];
    const ticked = labels.filter((label) => checkedLabels.includes(String(label.labelID)));
    if (ticked.length < 1) {
      tell(word(WORDS.noLabelsSelected, "Tick a label first."));
      return;
    }
    const ownerIDs = selectedRows.map((row) => row.id);
    if (ownerIDs.length === 0) {
      tell(word(WORDS.noContactsSelected, "Select contacts first."));
      return;
    }
    const bits = ticked.reduce((sum, label) => sum + label.labelID, 0n);
    const counts = { numLabels: String(ticked.length), numContacts: String(ownerIDs.length) };
    tell(give
      ? filledWord(WORDS.labelsAssigned, "{numLabels} given to {numContacts}", counts)
      : filledWord(WORDS.labelsRemoved, "{numLabels} taken off {numContacts}", counts));
    void run(async () => {
      if (give) {
        await labelGiven(ownerIDs, bits, "", false);
        return;
      }
      await flow.labelContacts(ownerIDs, bits, false, contactType);
      changeMasks(ownerIDs, (labelMask) => labelMaskWithout(labelMask, bits));
      drawnAgain();
    });
  }

  /**
   * idCheckers.IsCharacter as the page can tell it: no corporation's (1000000 to 1999999, 98000000 to 98999999),
   * alliance's (99000000 to 99999999) nor faction's (IsFaction: minFaction 500000 to below maxFaction 599999).
   */
  function isCharacterContact(ownerID: number): boolean {
    return !((ownerID >= 1_000_000 && ownerID <= 1_999_999) || (ownerID >= 98_000_000 && ownerID <= 99_999_999) || (ownerID >= 500_000 && ownerID < 599_999));
  }

  /** A player corporation (IsCorporation and not IsNPC, as User.PreLoad asks, 139): 98000000 to 98999999. */
  const isPlayerCorporation = (ownerID: number): boolean => ownerID >= 98_000_000 && ownerID <= 98_999_999;

  // User.PreLoad (userentry.py 139 to 140): each player corporation's entry gets its ticker as it is loaded
  // (cfg.corptickernames.Get), each asking its own; one asked already is not asked again.
  const tickersAsked = new Set<number>();
  $effect(() => {
    if (tab !== "contacts") return;
    const corporations = shown.rows.map((row) => row.id).filter((id) => isPlayerCorporation(id) && !tickersAsked.has(id));
    if (corporations.length === 0) return;
    for (const id of corporations) tickersAsked.add(id);
    void flow.corpTickersEach(corporations);
  });

  /** LoadGroupFromEntry (345 to 354): another group from the first page, and kept as the one last viewed (424). */
  function choose(groupID: number | string): void {
    if (group !== groupID) {
      startPos = 0;
      group = groupID;
    }
    selectedIDs = [];
    menuFor = null;
    flow.keepContactsLastSelected(groupID, contactType);
  }

  /** BrowseContacts (554 to 558): a page back or on. */
  function browse(step: number): void {
    startPos = Math.max(0, startPos + MAX_CONTACTS_PER_PAGE * step);
    selectedIDs = [];
  }

  /** CheckBoxChange (523 to 526): "Online only" kept in the user's settings, and the form drawn again. */
  function onlineOnlyChanged(): void {
    flow.keepOnlineBuddyOnly(onlineOnly);
    selectedIDs = [];
  }

  function filterTyped(): void {
    if (filterTimer !== null) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      filterTimer = null;
      if (filtering !== filterText) {
        filtering = filterText;
        selectedIDs = [];
      }
    }, 400);
  }

  // ── The Notifications group ─────────────────────────────────────────────────

  /**
   * The group's entries (GetScrolllist, 462 to 469; addressbookService.py GetNotifications, 970 to 988): each
   * notification formatted as the client formats it (FormatNotifications) and shown by its body's first two parts,
   * newest first (SortListOfTuples by when it was made, reversed). A type the page cannot word yet says so.
   */
  const notificationEntries = $derived.by(() => {
    const templates = $words.templates;
    const nameOf = (kind: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, kind, id, "");
    return [...(notificationsHeld ?? [])]
      .sort((left, right) => (left.created === right.created ? 0 : left.created === null ? 1 : right.created === null ? -1 : left.created > right.created ? -1 : 1))
      .map((notification) => {
        const formatted = formatContactNotification(notification, templates, nameOf);
        const parts = formatted === null ? { label: "A notification the page cannot word yet", label2: "", hint: "" } : notificationEntryParts(formatted.body);
        return {
          notificationID: notification.notificationID,
          senderID: notification.senderID,
          senderName: resolvedName($names.resolved, "owner", notification.senderID, String(notification.senderID)),
          ...parts,
        };
      });
  });

  /** Delete notification (contactNotificationEntry.py DeleteNotifications, 72 to 73; notificationSvc.py 312 to 321): DeleteNotifications, and it let go of what the group holds. */
  function deleteNotification(notificationID: number): void {
    notificationMenuFor = null;
    notes = [];
    void run(async () => {
      await flow.deleteNotifications([notificationID]);
      notificationsHeld = (notificationsHeld ?? []).filter((notification) => notification.notificationID !== notificationID);
      drawnAgain();
    });
  }

  // ── The Agents tab ──────────────────────────────────────────────────────────

  /** The window's tab (its tab group, AutoSelect: the one last chosen, kept). */
  type AddressBookTab = "contacts" | "agents" | "search";
  // svelte-ignore state_referenced_locally
  const keptTab = flow.addressBookTab();
  // svelte-ignore state_referenced_locally
  /** On the play page the address book's tabs sit at the top, in the header as addressBookWindow's (ConstructTabs). */
  const retailChrome = getContext("retailChrome") === true;
  let tab = $state<AddressBookTab>(!organization && (keptTab === "agents" || keptTab === "search") ? keptTab : "contacts");
  /** What the Search tab's last search found, by kind; none before any. */
  let searchFound = $state<ReadonlyMap<number, readonly { readonly id: number; readonly name: string }[]> | null>(null);
  function chooseTab(chosen: AddressBookTab): void {
    tab = chosen;
    menuFor = null;
    agentMenuFor = null;
    groupMenuFor = null;
    notes = [];
    told = [];
    flow.keepAddressBookTab(chosen);
  }

  /** The pilot's folders and "All Agents" open or not, as the registry keeps them for the character. */
  // svelte-ignore state_referenced_locally
  let folders = $state<AgentFolders>(flow.agentFolders());
  function keepFolders(next: AgentFolders): void {
    folders = next;
    flow.keepAgentFolders(next);
  }
  /** The group whose menu is open, and the agent's (by its group and its ID). */
  let groupMenuFor = $state<string | null>(null);
  let agentMenuFor = $state<string | null>(null);
  /**
   * The entries chosen, each by its group and its agent (an entry is one agent in one group), as the window's scroll
   * chooses them (carbonui scroll.py: multiSelect by default, 64; SelectNode, 550 on); and the entry a later Shift goes
   * from.
   */
  let agentsChosen = $state<string[]>([]);
  let lastAgentRow = $state<number | null>(null);
  /** The name popup of Create Folder (registry.AddListGroup) or a folder's Change Label (GetNewGroupName). */
  let folderNaming = $state<{ readonly id: string | null; value: string } | null>(null);
  const ALL_AGENTS = "all";

  /** appConst.agentType*, as AgentEntry.GetAgentInfo tells the agents apart (userentry.py 750 to 766). */
  const AGENT_TYPE = Object.freeze({ genericStoryline: 6, storyline: 7, event: 8, epicArc: 10, aura: 11, career: 12, heraldry: 13 });
  /** appConst.rookieAgentList: 910 to 969. */
  const isRookieAgent = (agentID: number): boolean => agentID >= 910 && agentID <= 969;
  const isAgentOwner = (ownerID: number): boolean => ownerID >= 3_000_000 && ownerID < 4_000_000;

  /** A template filled with names: an agent's from the agents' names, a place's and others' by their kinds. */
  function filledNamed(label: string, own: string, args: TemplateArguments): string {
    return plainText(formatTemplate(word(label, own), args, {
      nameOf: (kind, id) => resolvedName($names.resolved, kind === "owner" && isAgentOwner(id) ? "agent" : kind, id, ""),
    }));
  }

  interface AgentLine {
    readonly agentID: number;
    readonly name: string;
    /** GetAgentNameAndLevel: its name and level. */
    readonly nameLine: string;
    /** GetAgentLocationText: where it is, where that is not the station the pilot is in. */
    readonly locationLine: string;
    /** Its mission in the journal, by its state (GetMissionStateTextColored), and whether it is offered or taken. */
    readonly missionState: { readonly text: string; readonly offered: boolean } | null;
    /** What kind of agent it is: its division, or the kind of agent before it. */
    readonly typeLine: string;
  }

  /** AgentEntry.Load and GetAgentInfo (userentry.py 743 to 812), from what the client's agents service and journal know. */
  function agentLineOf(agentID: number, name: string): AgentLine {
    const record = $agentsState.agentRecords[agentID] ?? null;
    const level = record?.level ?? null;
    const nameLine = level === null ? name : filledNamed(AGENT_WORDS.nameAndLevel, "{[character]ownerID.name}, level {level}", { ownerID: agentID, level });
    let typeLine = "";
    if (record !== null) {
      const divisionTemplate = record.divisionNameID === null ? undefined : $words.templates[`#${record.divisionNameID}`];
      const divisionName = typeof divisionTemplate === "string" ? plainText(divisionTemplate) : "";
      const byKind = (label: string, own: string) => filledNamed(label, own, { divisionName });
      if (isRookieAgent(agentID)) typeLine = byKind(AGENT_WORDS.tutorial, "Tutorial: {divisionName}");
      else if (record.agentTypeID === AGENT_TYPE.epicArc) typeLine = byKind(AGENT_WORDS.epicArc, "Epic arc: {divisionName}");
      else if (record.agentTypeID === AGENT_TYPE.genericStoryline || record.agentTypeID === AGENT_TYPE.storyline) typeLine = byKind(AGENT_WORDS.storyline, "Storyline: {divisionName}");
      else if (record.agentTypeID === AGENT_TYPE.event) typeLine = byKind(AGENT_WORDS.event, "Event: {divisionName}");
      else if (record.agentTypeID === AGENT_TYPE.career) typeLine = byKind(AGENT_WORDS.career, "Career: {divisionName}");
      else if (record.agentTypeID === AGENT_TYPE.heraldry) typeLine = word(AGENT_WORDS.heraldry, "Paragon agent");
      else if (record.agentTypeID === AGENT_TYPE.aura) typeLine = "";
      else typeLine = divisionName;
    }
    // Where it is (765 to 772; eveformat solar_system_with_security_and_jumps): the system of its station, its
    // security and the jumps to it, where its station is not the one the pilot is in; without the jumps where they
    // are not known.
    let locationLine = "";
    const here = $station.online;
    const solarSystemID = record?.solarSystemID ?? null;
    if (record !== null && record.stationID !== null && here?.stationID !== record.stationID && solarSystemID !== null) {
      const security = $names.systemSecurity[solarSystemID];
      const secStatus = typeof security === "number" ? shownSecurity(security).toFixed(1) : "";
      const jumps = here?.solarSystemID ? $names.autopilotJumps[`${here.solarSystemID}:${solarSystemID}`] : undefined;
      locationLine = typeof jumps === "number"
        ? filledNamed(AGENT_WORDS.locationAndJumps, "{[location]location.name} {secStatus}, {jumps}", { location: solarSystemID, secStatus, jumps: filledNamed(AGENT_WORDS.numJumps, "{[numeric]numJumps} jumps", { numJumps: jumps }) })
        : filledNamed(AGENT_WORDS.location, "{[location]location.name} {secStatus}", { location: solarSystemID, secStatus });
    }
    // journal.GetActiveMissionForAgent (journal.py 363 to 368): its first mission in the journal, by its state's
    // word (agentUtil.GetMissionStateText, 231 to 245: the expiry, a time, is never below nought there).
    const journal = $agentsState.journal;
    const mission = journal === null ? undefined : [...journal.active, ...journal.offered].find((each) => each.agentID === agentID);
    const state = mission?.missionState ?? null;
    const missionState = state === 0 || state === 1
      ? { text: word(AGENT_WORDS.stateOffered, "Offered"), offered: true }
      : state === 2 ? { text: word(AGENT_WORDS.stateAccepted, "Accepted"), offered: false }
      : state === 3 ? { text: word(AGENT_WORDS.stateFailed, "Failed"), offered: false } : null;
    return { agentID, name, nameLine, locationLine, missionState, typeLine };
  }

  /**
   * _GetAgentScrollData (220 to 237): "All Agents" first (its key "  1") with every agent of the address book, then
   * each folder by its name in lower case with those of its agents still in it; each group's agents by name.
   */
  const agentGroups = $derived.by(() => {
    const agents = book?.agents ?? [];
    const named = new Map(agents.map((agent) => [agent.agentID, agent.name]));
    const linesOf = (ids: readonly number[]) => ids
      .filter((id) => named.has(id))
      .map((id) => agentLineOf(id, named.get(id) ?? String(id)))
      .sort((left, right) => left.name.localeCompare(right.name));
    const groups = [
      { id: ALL_AGENTS, label: word(AGENT_WORDS.allAgents, "All Agents"), sortBy: "  1", locked: true, open: folders.allOpen, lines: linesOf(agents.map((agent) => agent.agentID)) },
      ...folders.folders.map((folder) => ({ id: folder.id, label: folder.label, sortBy: folder.label, locked: false, open: folder.open, lines: linesOf(folder.groupItems) })),
    ];
    return groups.sort((left, right) => {
      const a = left.sortBy.toLowerCase();
      const b = right.sortBy.toLowerCase();
      return a < b ? -1 : a > b ? 1 : 0;
    });
  });

  /** An entry's key: its group and its agent. */
  const agentKey = (groupID: string, agentID: number): string => `${groupID}|${agentID}`;
  /** An entry's group and agent, from its key. */
  function agentEntryOf(key: string): { readonly groupID: string; readonly agentID: number } {
    const at = key.lastIndexOf("|");
    return { groupID: key.slice(0, at), agentID: Number(key.slice(at + 1)) };
  }
  /**
   * The entries chosen, in the scroll's order (GetSelectedNodes, scroll.py 656 to 664: its nodes, those selected). An
   * entry of a closed group is no node of the scroll's, and is chosen no longer.
   */
  const chosenInOrder = $derived(agentGroups.flatMap((group) => (group.open ? group.lines.map((line) => agentKey(group.id, line.agentID)) : [])).filter((key) => agentsChosen.includes(key)));

  /**
   * An entry clicked (AgentEntry.OnClick, userentry.py 955 to 964: the scroll's SelectNode): alone; with Ctrl, added or
   * taken out; with Shift, the entries from the one last chosen to it; with both, those added.
   */
  function agentClick(event: MouseEvent, key: string): void {
    const entry = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const entries = entry === null ? [] : [...(entry.closest(".contacts-agents")?.querySelectorAll<HTMLElement>("[data-agent-key]") ?? [])];
    const at = entry === null ? -1 : entries.indexOf(entry);
    const control = event.ctrlKey || event.metaKey;
    const ranged = (): string[] => {
      const [from, to] = (lastAgentRow ?? at) < at ? [lastAgentRow ?? at, at] : [at, lastAgentRow ?? at];
      return entries.slice(from, to + 1).map((each) => each.dataset.agentKey ?? "").filter((each) => each !== "");
    };
    const anchored = event.shiftKey && lastAgentRow !== null && lastAgentRow !== at && at >= 0 && lastAgentRow < entries.length;
    if (event.shiftKey && control) {
      if (anchored) agentsChosen = [...new Set([...agentsChosen, ...ranged()])];
    } else if (event.shiftKey) {
      // The range from the entry last chosen; that entry stays the one a later Shift goes from.
      if (anchored) {
        agentsChosen = [...new Set(ranged())];
        return;
      }
      agentsChosen = [key];
    } else if (control) {
      agentsChosen = agentsChosen.includes(key) ? agentsChosen.filter((each) => each !== key) : [...agentsChosen, key];
    } else {
      agentsChosen = [key];
    }
    lastAgentRow = at;
  }

  /**
   * An entry double-clicked (AgentEntry.OnDblClick, 966 to 978): a conversation with the agent where the pilot is
   * docked in a station, else the agent's information.
   */
  function agentDoubleClick(agentID: number): void {
    const status = $flightState.status;
    const docked = status !== null ? (status.docked ? status.stationID : null) : ($station.online?.stationID ?? null);
    if (docked !== null && docked !== undefined) startConversation(agentID);
    else agentInfo(agentID);
  }

  /** An entry's menu (AgentEntry.GetMenu, 858 to 882), the entry chosen alone where it was not chosen (GetSelectedNodes). */
  function openAgentMenu(key: string): void {
    if (!chosenInOrder.includes(key)) agentsChosen = [key];
    agentMenuFor = agentMenuFor === key ? null : key;
  }

  /**
   * The menu of several (AgentEntry._GetMultiMenu, 884 to 939): menusvc.CharacterMenu of their agents, each one's menu
   * made as for several and the menus merged (menuMerge.py MergeMenus): Show Info where it is offered for one of them,
   * Remove from Addressbook (each is in the book: addressbookService IsInAddressBook, 'contact', holds the agents). Then,
   * where none of them is under "All Agents", their removal from their folders, the folder named where there is one.
   */
  const severalMenu = $derived.by(() => {
    const entries = chosenInOrder.map(agentEntryOf);
    const folderIDs = [...new Set(entries.map((entry) => entry.groupID))];
    const inFolders = entries.length > 0 && entries.every((entry) => entry.groupID !== ALL_AGENTS);
    const folder = folderIDs.length === 1 ? folders.folders.find((each) => each.id === folderIDs[0]) ?? null : null;
    return {
      entries,
      showInfo: entries.some((entry) => agentInfoOffered(entry.agentID)),
      removeFromFolders: inFolders ? filledWord(AGENT_WORDS.removeFromFolder, "Take {removecount} out of {foldername}", { foldername: folder?.label ?? "folders", removecount: String(entries.length) }) : null,
    };
  });

  /**
   * Show Info of several (menuMerge._ExecMulti: not one of menu/__init__.py's MULTI_FUNCTIONS, so each agent's own is
   * run): each request follows infosvc's reuse/new-window policy, in order.
   */
  function severalInfo(): void {
    agentMenuFor = null;
    for (const entry of severalMenu.entries) if (agentInfoOffered(entry.agentID)) showInfo({ kind: "character", characterID: entry.agentID });
  }

  /** Their removal from their folders (RemoveFromListGroup, 985 to 1000, with no list named): nothing asked of the server. */
  function severalOutOfFolders(): void {
    agentMenuFor = null;
    const out = severalMenu.entries;
    keepFolders({
      ...folders,
      folders: folders.folders.map((folder) => {
        const items = folder.groupItems.filter((id) => !out.some((entry) => entry.groupID === folder.id && entry.agentID === id));
        return items.length === folder.groupItems.length ? folder : { ...folder, groupItems: items };
      }),
    });
    agentsChosen = [];
  }

  /** What a dragged entry carries: the entries' keys. */
  const AGENTS_DRAG = "application/x-evejs-agents";

  /** AgentEntry.GetDragData (947 to 952): the entries chosen, the entry chosen alone where it was not chosen. */
  function agentDragStart(event: DragEvent, key: string): void {
    if (!chosenInOrder.includes(key)) agentsChosen = [key];
    const keys = chosenInOrder.includes(key) ? chosenInOrder : [key];
    if (event.dataTransfer === null) return;
    event.dataTransfer.setData(AGENTS_DRAG, JSON.stringify(keys));
    event.dataTransfer.effectAllowed = "move";
  }

  /**
   * What each agent's entry shown needs asked, on the Agents tab and among what the Search tab found: its record in
   * the agents service, its station's system's name, security and jumps, its division's name, and the journal.
   */
  const bookAgentIDs = $derived((book?.agents ?? []).map((agent) => agent.agentID));
  const shownAgentIDs = $derived(tab === "agents" ? bookAgentIDs : tab === "search" ? (searchFound?.get(1) ?? []).map((agent) => agent.id) : []);
  let journalAsked = false;
  $effect(() => {
    if (shownAgentIDs.length === 0) return;
    for (const agentID of shownAgentIDs) flow.requestAgentRecord(agentID);
    if (!journalAsked && $agentsState.journal === null) {
      journalAsked = true;
      void flow.loadJournal().catch(() => {});
    }
  });
  const agentPlaces = $derived.by(() => {
    const records = shownAgentIDs.map((agentID) => $agentsState.agentRecords[agentID] ?? null);
    return {
      systems: [...new Set(records.map((record) => record?.solarSystemID ?? null).filter((id): id is number => id !== null))],
      divisions: [...new Set(records.map((record) => record?.divisionNameID ?? null).filter((id): id is number => id !== null))],
    };
  });
  $effect(() => {
    const { systems, divisions } = agentPlaces;
    if (systems.length === 0 && divisions.length === 0) return;
    flow.requestWords(divisions.map((id) => `#${id}`));
    flow.requestNames(systems.map((id) => ({ kind: "system" as const, id })));
    flow.requestSystemSecurity(systems);
    const from = $station.online?.solarSystemID ?? null;
    if (from !== null && systems.length > 0) flow.requestAutopilotJumps(from, systems);
  });

  /** A group opened or closed (ListGroup Toggle), and kept so. */
  function toggleGroup(groupID: string): void {
    groupMenuFor = null;
    keepFolders(groupID === ALL_AGENTS
      ? { ...folders, allOpen: !folders.allOpen }
      : { ...folders, folders: folders.folders.map((folder) => (folder.id === groupID ? { ...folder, open: !folder.open } : folder)) });
  }

  /**
   * Create Folder (registry.AddListGroup, 466 to 480) and a folder's Change Label (scrollentries.py 876 to 899): the
   * client's name popup, refused where nothing but blanks is typed (namedPopup.py CheckName, 100 to 105); a new
   * folder is closed and empty, keyed by when it was made.
   */
  function confirmFolderName(): void {
    const held = folderNaming;
    if (held === null) return;
    if (held.value.trim().length < 1) {
      notes = [word(AGENT_WORDS.pleaseTypeSomething, "Type a name first.")];
      return;
    }
    notes = [];
    folderNaming = null;
    if (held.id === null) {
      keepFolders({ ...folders, folders: [...folders.folders, { id: String(Date.now()), label: held.value, groupItems: [], open: false }] });
    } else {
      keepFolders({ ...folders, folders: folders.folders.map((folder) => (folder.id === held.id ? { ...folder, label: held.value } : folder)) });
    }
  }

  /** DeleteFolder (scrollentries.py 901 to 918): the client's ConfirmDeleteFolder, then the folder let go; its agents stay in the address book. */
  function deleteFolder(folderID: string): void {
    groupMenuFor = null;
    question = {
      title: filledWord("dialog:ConfirmDeleteFolder/title", "Delete folder?", {}),
      body: filledWord("dialog:ConfirmDeleteFolder/body", "Delete this folder?", {}),
      answer: (yes) => {
        question = null;
        if (yes) keepFolders({ ...folders, folders: folders.folders.filter((folder) => folder.id !== folderID) });
      },
    };
  }

  /** AgentEntry.RemoveFromListGroup (userentry.py 985 to 1000): the agent out of the folder, and nothing asked of the server. */
  function removeFromFolder(folderID: string, agentID: number): void {
    agentMenuFor = null;
    keepFolders({ ...folders, folders: folders.folders.map((folder) => (folder.id === folderID ? { ...folder, groupItems: folder.groupItems.filter((id) => id !== agentID) } : folder)) });
  }

  /**
   * DropInBuddyGroup (addressbookService.py 553 to 568): the entries dropped on a group, each agent taken out of the
   * folder it came from and put in the one it was dropped on ("All Agents" keeps none of its own), in their order.
   */
  function dropAgent(event: DragEvent, groupID: string): void {
    if (event.dataTransfer === null || !event.dataTransfer.types.includes(AGENTS_DRAG)) return;
    event.preventDefault();
    let keys: unknown;
    try {
      keys = JSON.parse(event.dataTransfer.getData(AGENTS_DRAG));
    } catch {
      return;
    }
    if (!Array.isArray(keys)) return;
    const moved = keys
      .filter((key): key is string => typeof key === "string")
      .map(agentEntryOf)
      .filter((entry) => Number.isSafeInteger(entry.agentID) && entry.agentID > 0 && bookAgentIDs.includes(entry.agentID));
    if (moved.length === 0) return;
    let next = folders.folders;
    for (const entry of moved) {
      next = next.map((folder) => {
        let items = folder.id === entry.groupID ? folder.groupItems.filter((id) => id !== entry.agentID) : folder.groupItems;
        if (folder.id === groupID && !items.includes(entry.agentID)) items = [...items, entry.agentID];
        return items === folder.groupItems ? folder : { ...folder, groupItems: items };
      });
    }
    keepFolders({ ...folders, folders: next });
  }

  /**
   * The agent's place (characterCheckers.py GetAgentLocation, 432 to 440: its station, else its system), where the
   * map menu is offered for it (OfferMapMenu, 218 to 234: it has a system, and the place is a station or a system).
   */
  function agentPlace(agentID: number): number | null {
    const record = $agentsState.agentRecords[agentID] ?? null;
    if (record === null || record.solarSystemID == null) return null;
    return record.stationID ?? record.solarSystemID;
  }

  /** MapChecker.OfferSetDestination (mapCheckers.py 17 to 18): the place is not the station or structure the pilot is in. */
  function agentDestinationOffered(agentID: number): boolean {
    const place = agentPlace(agentID);
    if (place === null) return false;
    const status = $flightState.status;
    const docked = status !== null ? (status.docked ? status.stationID : null) : ($station.online?.stationID ?? null);
    const structure = status !== null ? status.structureID : ($station.online?.structureID ?? null);
    return place !== docked && place !== structure;
  }

  /** The bookmark window, open for an agent's place, or none. */
  let bookmarking = $state<BookmarkPlace | null>(null);

  /**
   * The map menu's Save Location... (_MapMenu, 183: Bookmark(itemID, typeSolarSystem, constellationID); infosvc.py
   * Bookmark, 3623 to 3625): the bookmark window for the agent's place, its popup asked with the solar system's type
   * (as the menu asks it for any place), and its default name GetDefaultLocationName's: "<place> ( <its type> )", or
   * the pilot's own spot where the place is the system the pilot is in space in.
   */
  function bookmarkAgentPlace(agentID: number): void {
    agentMenuFor = null;
    searchMenuFor = null;
    const place = agentPlace(agentID);
    if (place === null) return;
    const isStation = place >= 60_000_000;
    flow.requestNames(isStation
      ? [{ kind: "type", id: 5 }, { kind: "station", id: place }, { kind: "stationType", id: place }]
      : [{ kind: "type", id: 5 }, { kind: "system", id: place }]);
    const status = $flightState.status;
    const ownSystem = status !== null && status.inSpace && !status.docked && status.solarSystemID === place;
    const solarSystemType = (): string => resolvedName($names.resolved, "type", 5, "");
    bookmarking = {
      itemID: place,
      askIfKnown: !ownSystem,
      typeName: solarSystemType,
      name: () => ownSystem
        ? filledNamed(AGENT_WORDS.spot, "a spot in {solarSystemName}", { solarSystemName: resolvedName($names.resolved, "system", place, "") })
        : filledNamed(AGENT_WORDS.placeLabel, "{[location] loc.name} ( {group} )", { loc: place, group: isStation ? resolvedName($names.resolved, "stationType", place, "") : solarSystemType() }),
    };
  }

  /** The map menu's entries (_MapMenu, 176 to 181): Set Destination, and Remove Waypoint or Add Waypoint. */
  function agentRoute(agentID: number, how: "destination" | "add" | "remove"): void {
    agentMenuFor = null;
    searchMenuFor = null;
    const place = agentPlace(agentID);
    if (place === null) return;
    if (how === "destination") flow.setDestination(place);
    else if (how === "add") flow.addWaypoint(place);
    else flow.clearWaypoints(place);
  }

  /** OfferShowInfo (characterCheckers.py 350 to 353): an agent's, unless it is an aura agent. */
  function agentInfoOffered(agentID: number): boolean {
    return ($agentsState.agentRecords[agentID]?.agentTypeID ?? null) !== AGENT_TYPE.aura;
  }

  /** Show Info from an agent's menu (menusvc.py 579 to 580): the agent's information window. */
  function agentInfo(agentID: number): void {
    agentMenuFor = null;
    searchMenuFor = null;
    showInfo({ kind: "character", characterID: agentID });
  }

  /**
   * Dock in Station from an agent's menu (menusvc.py 619 to 624): where the pilot is in space in the agent's system,
   * not in a structure, and the agent has a station. The station the agent is in, else none.
   */
  function agentDockStation(agentID: number): number | null {
    const record = $agentsState.agentRecords[agentID] ?? null;
    // The client's session.solarsystemid, which it has in space alone, and its structureid: the flight's status as
    // the page last read it (the online pilot's station is the last one it docked in, kept after an undock).
    const flight = $flightState.status;
    if (record === null || record.stationID === null || flight === null) return null;
    if (!flight.inSpace || flight.docked || flight.structureID !== null) return null;
    return record.solarSystemID !== null && record.solarSystemID === flight.solarSystemID ? record.stationID : null;
  }

  /**
   * menusvc.Dock (2981 to 2997): the station docked at as the client's menu docks, closing the distance first
   * (DockStation's GetCloseAndTryCommand), which the page's dockAt does. It runs as the travel loop does, and says
   * its refusal here.
   */
  function dockAtAgent(agentID: number): void {
    agentMenuFor = null;
    searchMenuFor = null;
    const stationID = agentDockStation(agentID);
    if (stationID === null) return;
    error = "";
    void flow.dockAt(stationID).catch((cause) => {
      error = isSessionLost(cause) ? "Your session ended. Pick your character again." : cause instanceof Error ? cause.message : String(cause);
    });
  }

  /** agents.OpenDialogueWindow: the conversation, which the Agents & Missions window shows. */
  function startConversation(agentID: number): void {
    agentMenuFor = null;
    notes = [];
    void run(async () => {
      await flow.openConversation(agentID);
      showAgents?.();
    });
  }

  /**
   * DeleteEntryMulti with no contact type (addressbookService.py 870 to 891): the client's RemoveAgents once, then for
   * each agent in turn, the agent out of every folder and RemoveFromAddressBook's DeleteContacts([agentID]) (817 to
   * 823), one call each. Several come from the menu of several (Remove from Addressbook is one of menu/__init__.py's
   * MULTI_FUNCTIONS, so their agents go to the one DeleteEntryMulti: menuMerge._GetMergedMenuEntryArgs); an agent chosen
   * in two groups is removed once.
   */
  function removeAgents(agentIDs: readonly number[]): void {
    agentMenuFor = null;
    notes = [];
    const removed = [...new Set(agentIDs)];
    question = {
      title: filledWord("dialog:RemoveAgents/title", "Remove agents?", {}),
      body: filledWord("dialog:RemoveAgents/body", "Remove the agents chosen?", {}),
      answer: (yes) => {
        question = null;
        if (!yes) return;
        void run(async () => {
          for (const agentID of removed) {
            keepFolders({ ...folders, folders: folders.folders.map((folder) => (folder.groupItems.includes(agentID) ? { ...folder, groupItems: folder.groupItems.filter((id) => id !== agentID) } : folder)) });
            await flow.deleteContacts([agentID]);
            if (book !== null) {
              book = { ...book, agents: book.agents.filter((agent) => agent.agentID !== agentID) };
            }
          }
          agentsChosen = [];
        });
      },
    };
  }

  // ── The Search tab ──────────────────────────────────────────────────────────

  /** The Search tab's words, by their labels (addressBookWindow.py 263 to 381; searchUtil.py 21 to 54). */
  const SEARCH_WORDS = {
    search: "UI/Common/Search",
    settings: "UI/Common/Settings",
    searchType: "UI/Common/SearchType",
    searchBy: "UI/Common/SearchBy",
    any: "UI/Common/Any",
    character: "UI/Common/Character",
    corporation: "UI/Common/Corporation",
    alliance: "UI/Common/Alliance",
    agent: "UI/Agents/Agent",
    faction: "UI/Common/Faction",
    partialTerms: "UI/Search/UniversalSearch/PartialTerms",
    exactTerms: "UI/Search/UniversalSearch/ExactTerms",
    exactPhrase: "UI/Search/UniversalSearch/ExactPhrase",
    onlyExactPhrase: "UI/Search/UniversalSearch/OnlyExactPhrase",
    sectionHeader: "UI/Search/UniversalSearch/SectionHeader",
    agents: "UI/Search/UniversalSearch/Agents",
    characters: "UI/Search/UniversalSearch/Characters",
    factions: "UI/Search/UniversalSearch/Factions",
    corporations: "UI/Search/UniversalSearch/Corporations",
    alliances: "UI/Search/UniversalSearch/Alliances",
    tooLong: "UI/Common/SearchStringTooLong",
    addToAddressbook: "UI/PeopleAndPlaces/AddToAddressbook",
  } as const;
  /** search/const.py ResultType: the kinds of owner the tab finds. */
  const RESULT_TYPE = Object.freeze({ agent: 1, character: 2, corporation: 3, alliance: 4, faction: 5 });
  /** SearchType.as_result_type_list (283 to 296): what each Search Type asks, Any its five in the client's order. */
  const RESULT_TYPES_OF: Readonly<Record<number, readonly number[]>> = {
    0: [RESULT_TYPE.character, RESULT_TYPE.corporation, RESULT_TYPE.alliance, RESULT_TYPE.agent, RESULT_TYPE.faction],
    1: [RESULT_TYPE.character],
    2: [RESULT_TYPE.corporation],
    3: [RESULT_TYPE.alliance],
    4: [RESULT_TYPE.agent],
    5: [RESULT_TYPE.faction],
  };
  /** The settings menu's Search Type (SearchType, 263 to 310), in SORT_KEY_BY_SEARCH_TYPE's order (313 to 318), and its Search By (searchUtil.SEARCHBY_OPTIONS). */
  const SEARCH_TYPE_CHOICES: readonly (readonly [number, string, string])[] = [
    [0, SEARCH_WORDS.any, "Any"],
    [1, SEARCH_WORDS.character, "Character"],
    [4, SEARCH_WORDS.agent, "Agent"],
    [2, SEARCH_WORDS.corporation, "Corporation"],
    [3, SEARCH_WORDS.alliance, "Alliance"],
    [5, SEARCH_WORDS.faction, "Faction"],
  ];
  const SEARCH_BY_CHOICES: readonly (readonly [number, string, string])[] = [
    [MATCH_BY.partialTerms, SEARCH_WORDS.partialTerms, "Partial terms"],
    [MATCH_BY.exactTerms, SEARCH_WORDS.exactTerms, "Exact terms"],
    [MATCH_BY.exactPhrase, SEARCH_WORDS.exactPhrase, "Exact phrase"],
    [MATCH_BY.exactPhraseOnly, SEARCH_WORDS.onlyExactPhrase, "Only the exact phrase"],
  ];
  /** RESULT_ORDER and RESULT_LABELS (searchUtil.py 28 to 54): the kinds shown, in the order shown, each with its word. */
  const RESULT_GROUPS: readonly (readonly [number, string, string])[] = [
    [RESULT_TYPE.agent, SEARCH_WORDS.agents, "Agents"],
    [RESULT_TYPE.character, SEARCH_WORDS.characters, "Characters"],
    [RESULT_TYPE.faction, SEARCH_WORDS.factions, "Factions"],
    [RESULT_TYPE.corporation, SEARCH_WORDS.corporations, "Corporations"],
    [RESULT_TYPE.alliance, SEARCH_WORDS.alliances, "Alliances"],
  ];

  // svelte-ignore state_referenced_locally
  let searchSettings = $state(flow.contactsSearchSettings());
  let searchText = $state("");
  let searchSettingsOpen = $state(false);
  let searching = $state(false);
  /** The result groups closed, by kind, and the entry whose menu is open (its kind and owner). */
  let searchClosed = $state<readonly number[]>([]);
  let searchMenuFor = $state<string | null>(null);

  /** A setting chosen from the tab's menu, kept for the character, and the search made again (on_change, 342 to 348). */
  function chooseSearchSetting(next: { readonly searchType: number; readonly searchBy: number }): void {
    searchSettings = next;
    flow.keepContactsSearchSettings(next);
    runSearch();
  }

  /**
   * SearchPanel._search (351 to 363): nothing typed asks nothing; else GetResultsScrollList, the text's * taken out
   * and stripped (_FormatSearchInput, 304 to 307) and refused as _ValidateSearchInput refuses it (310 to 320: nothing
   * left, a hundred or more, or Partial Terms with no term of three); the kinds of the Search Type, and Search By.
   */
  function runSearch(): void {
    const typed = searchText.trim();
    if (typed === "") return;
    const text = typed.replace(/\*/g, "").trim();
    const matchBy = searchSettings.searchBy;
    notes = [];
    told = [];
    searchMenuFor = null;
    if ([...text].length < 1) {
      tell(filledWord("dialog:LookupStringMinimum/body", "Type at least {minimum} character.", { minimum: "1" }));
      return;
    }
    if ([...text].length >= 100) {
      notes = [word(SEARCH_WORDS.tooLong, "That is too long to search for.")];
      return;
    }
    if (matchBy === MATCH_BY.partialTerms && !text.split(/\s+/).some((term) => [...term].length >= MIN_WILDCARD_LENGTH)) {
      tell(filledWord("dialog:PartialSearchLessThanMinLength/body", "Partial terms need a word of {minChars} letters or more.", { minChars: String(MIN_WILDCARD_LENGTH) }));
      return;
    }
    searching = true;
    void run(async () => {
      try {
        searchFound = await flow.searchOwners(text, RESULT_TYPES_OF[searchSettings.searchType] ?? RESULT_TYPES_OF[0] ?? [], matchBy);
        for (const agent of searchFound.get(RESULT_TYPE.agent) ?? []) flow.requestAgentRecord(agent.id);
      } finally {
        searching = false;
      }
    });
  }

  /**
   * _GetResultsScrollList (87 to 97) by GetScrollEntryData (155 to 250): each kind in the client's order, a group
   * where any was found; an agent the agents service knows nothing of left out (its record answered none).
   */
  const searchGroups = $derived.by(() => {
    if (searchFound === null) return [];
    return RESULT_GROUPS.flatMap(([resultType, label, own]) => {
      const found = (searchFound?.get(resultType) ?? []).filter((owner) => resultType !== RESULT_TYPE.agent || $agentsState.agentRecords[owner.id] !== null);
      return found.length === 0 ? [] : [{ resultType, label: word(label, own), found }];
    });
  });
  const searchAgentIDs = $derived(new Set((book?.agents ?? []).map((agent) => agent.agentID)));

  /** AddToPersonal for an agent (addressbookService.py 626 to 643; AddToAddressBook, 705 to 735): AddContact with it alone, and it kept among the agents. */
  function addAgent(agentID: number, name: string): void {
    searchMenuFor = null;
    notes = [];
    if (searchAgentIDs.has(agentID)) {
      notes = [filledWord("UI/PeopleAndPlaces/AlreadyAContact", "{contactName} is in your address book already.", { contactName: name })];
      return;
    }
    void run(async () => {
      await flow.addAgentToAddressBook(agentID);
      if (book !== null && !book.agents.some((agent) => agent.agentID === agentID)) {
        book = { ...book, agents: [...book.agents, { agentID, name }] };
      }
    });
  }

  onMount(() => {
    flow.requestWords([
      ...Object.values(WORDS),
      "UI/PeopleAndPlaces/NoCorpContacts", "UI/PeopleAndPlaces/NoCorpContactsStanding",
      "UI/PeopleAndPlaces/NoAllianceContacts", "UI/PeopleAndPlaces/NoAllianceContactsStanding",
      ...Object.values(AGENT_WORDS),
      ...Object.values(FLEET_WORDS),
      ...Object.values(SEARCH_WORDS),
      "UI/PeopleAndPlaces/AlreadyAContact",
      ...Object.values(CONTACT_NOTIFICATION_LABELS),
      ...DIALOGS.flatMap((dialog) => [`dialog:${dialog}/title`, `dialog:${dialog}/body`]),
    ]);
    if (contactAction) {
      book = contactAction.book;
      if (contactAction.kind === "manage") manage(contactAction.ownerID, contactAction.name);
      else removeContacts([{ id: contactAction.ownerID, name: contactAction.name }]);
    } else void load();
    if (!contactAction && !organization) void flow.primeContactsOnline().catch(() => {});
    // The owner's menus' fleet entries go by the pilot's fleet, which the page reads where it has not yet.
    if (!contactAction && !organization && store.fleet.get().availability === "unknown") void flow.loadFleet(true).catch(() => {});
    return () => {
      disposed = true;
      ++readGeneration;
      if (filterTimer !== null) clearTimeout(filterTimer);
    };
  });
</script>

<section class="panel" class:ct-retail={retailChrome && !organization}>
  {#if !contactAction}
  <header class="panel-head">
    <h2 class="panel-title">{word(WORDS.title, "Contacts")}</h2>
  </header>
  {/if}

  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#each notes as said, place (place)}
    <p class="error">{said}</p>
  {/each}
  {#each told as said, place (place)}
    <p class="note">{said}</p>
  {/each}
  {#if renaming !== null}
    <!-- The rename's popup (utilWindows.NamePopup): its caption, the field's word, OK and Cancel. -->
    <section class="contacts-confirm" aria-label={word(WORDS.labelsLabelName, "Label Name")}>
      <h3>{word(WORDS.labelsLabelName, "Label Name")}</h3>
      <p class="controls">
        <label>
          {word(WORDS.labelsTypeNew, "New name")}
          <input type="text" maxlength={MAX_LABEL_NAME} bind:value={renaming.value} />
        </label>
        <button type="button" disabled={busy} onclick={confirmRename}>{word(WORDS.ok, "OK")}</button>
        <button type="button" class="minor" onclick={() => { renaming = null; notes = []; }}>{word(WORDS.cancel, "Cancel")}</button>
      </p>
    </section>
  {/if}
  {#if editingSeveral !== null}
    <!-- The window that edits several contacts (ContactManagementMultiEditWnd): their names, the standing chosen or
         "Select standing", the five standings, Edit Contact and Cancel. -->
    <section class="contacts-confirm" aria-label={word(WORDS.management, "Contact Management")}>
      <h3>{word(WORDS.management, "Contact Management")}</h3>
      <p><strong>{editingSeveral.names}</strong></p>
      <p>{editingSeveral.level === null ? word(WORDS.selectStanding, "Choose a standing") : word(LEVELS.find(([level]) => level === editingSeveral?.level)?.[1] ?? WORDS.neutral, LEVELS.find(([level]) => level === editingSeveral?.level)?.[2] ?? "Neutral Standing")}</p>
      {#if organization}
        <label>Standing <input type="range" aria-label="Standing" min="-10" max="10" step="0.1" value={editingSeveral.level ?? 0} oninput={(event) => { if (editingSeveral) editingSeveral.level = Number(event.currentTarget.value); }} /></label>
        {#if editingSeveral.level !== null}<span>{editingSeveral.level.toFixed(1)}</span>{/if}
      {/if}
      <p class="controls">
        {#each LEVELS as [level, label, own] (level)}
          <button type="button" class="minor" class:active={editingSeveral.level === level} aria-pressed={editingSeveral.level === level} title={word(label, own)} onclick={() => { if (editingSeveral) editingSeveral.level = level; }}>
            {level > 0 ? `+${level}` : String(level)}
          </button>
        {/each}
      </p>
      <p class="controls">
        <button type="button" class="primary" disabled={busy} onclick={confirmSeveral}>{word(WORDS.editContact, "Edit Contact")}</button>
        <button type="button" class="minor" onclick={() => { editingSeveral = null; notes = []; }}>{word(WORDS.cancel, "Cancel")}</button>
      </p>
    </section>
  {/if}
  {#if managingLabels && book !== null && book.labels !== null}
    <!-- Manage Labels (manageLabels.py on ManageLabelsBase): a new label by name, the labels to tick, each renamed or
         deleted from its own menu, and Assign Label and Remove Label for the entries selected. -->
    <section class="contacts-confirm" aria-label={filledWord(WORDS.manageLabelsWithType, "Manage Labels: {labelType}", { labelType: word(WORDS.mailContacts, "Contacts") })}>
      <h3>{filledWord(WORDS.manageLabelsWithType, "Manage Labels: {labelType}", { labelType: word(WORDS.mailContacts, "Contacts") })}</h3>
      <p class="controls">
        <label>
          {word(WORDS.labelName, "Label Name")}
          <input type="text" maxlength={MAX_LABEL_NAME} bind:value={newLabelName} />
        </label>
        <button type="button" disabled={busy} onclick={createLabel}>{word(WORDS.create, "Create")}</button>
      </p>
      <p class="note">{word(WORDS.labelsTextContacts, "These act on the contacts selected in the list.")}</p>
      <ul class="contacts-manage-labels">
        {#each labels as label (String(label.labelID))}
          <li>
            <label>
              <input
                type="checkbox"
                checked={checkedLabels.includes(String(label.labelID))}
                onchange={() => {
                  const key = String(label.labelID);
                  checkedLabels = checkedLabels.includes(key) ? checkedLabels.filter((each) => each !== key) : [...checkedLabels, key];
                }}
              />
              {label.name}
            </label>
            <button type="button" class="minor" disabled={busy} onclick={() => { notes = []; renaming = { labelID: label.labelID, value: "" }; }}>{word(WORDS.labelRename, "Rename")}</button>
            <button type="button" class="minor" disabled={busy} onclick={() => deleteLabel(label, label.name)}>{word(WORDS.mailDelete, "Delete")}</button>
          </li>
        {/each}
      </ul>
      {#if checkedLabels.length > 0}
        <p class="note">{filledWord(WORDS.labelsSelected, "{numSelected} ticked", { numSelected: String(checkedLabels.length) })}</p>
      {/if}
      <p class="controls">
        <button type="button" disabled={busy} onclick={() => manageLabel(true)}>{word(WORDS.assignLabel, "Assign Label")}</button>
        <button type="button" disabled={busy} onclick={() => manageLabel(false)}>{word(WORDS.removeLabel, "Remove Label")}</button>
        <!-- The window's own close, which the page has as a button. -->
        <button type="button" class="minor" onclick={() => (managingLabels = false)}>Close</button>
      </p>
    </section>
  {/if}
  {#if question !== null}
    <!-- The client's question (its dialog): its title, its body, yes and no. -->
    <div class="contacts-confirm" role="alertdialog" aria-label={question.title}>
      <strong>{question.title}</strong>
      <p>{question.body}</p>
      <p class="controls">
        <button type="button" onclick={() => question?.answer(true)}>{word(WORDS.yes, "Yes")}</button>
        <button type="button" class="minor" onclick={() => question?.answer(false)}>{word(WORDS.no, "No")}</button>
      </p>
    </div>
  {/if}
  {#if managing !== null}
    <!-- Contact Management (ContactManagementWnd): the name, the five standings and the one chosen, and for a
         character the buddy list's box, the notification's and the message; Add Contact or Edit Contact, and Cancel. -->
    <section class="contacts-confirm" aria-label={word(WORDS.management, "Contact Management")}>
      <h3>{word(WORDS.management, "Contact Management")}</h3>
      <p><strong>{managing.name}</strong></p>
      <p>{organization ? managing.level.toFixed(1) : word(LEVELS.find(([level]) => level === managing?.level)?.[1] ?? WORDS.neutral, LEVELS.find(([level]) => level === managing?.level)?.[2] ?? "Neutral Standing")}</p>
      {#if organization}<input type="range" aria-label="Standing" min="-10" max="10" step="0.1" bind:value={managing.level} />{/if}
      <p class="controls">
        {#each LEVELS as [level, label, own] (level)}
          <button type="button" class="minor" class:active={managing.level === level} aria-pressed={managing.level === level} title={word(label, own)} onclick={() => { if (managing) managing.level = level; }}>
            {level > 0 ? `+${level}` : String(level)}
          </button>
        {/each}
      </p>
      {#if !managing.isContact && labels.length > 0}
        <!-- The labels' combo (ConstructLabelsCombo, 98 to 117): "-- Assign Label --" first, then the labels by name. -->
        <p class="controls">
          <select aria-label={word(WORDS.assignLabel, "Assign Label")} bind:value={managing.labelKey}>
            <option value="">-- {word(WORDS.assignLabel, "Assign Label")} --</option>
            {#each labels as label (String(label.labelID))}
              <option value={String(label.labelID)}>{label.name}</option>
            {/each}
          </select>
        </p>
      {/if}
      {#if managing.isCharacter && !organization}
        <p class="controls">
          <label title={word(WORDS.buddyHint, "")}>
            <input type="checkbox" bind:checked={managing.inWatchlist} />
            {word(WORDS.toWatchlist, "Watch this contact")}
          </label>
        </p>
        <p class="controls">
          <label>
            <input type="checkbox" bind:checked={managing.notify} />
            {filledWord(WORDS.sendNotification, "Let {contactName} know", { contactName: managing.name })}
          </label>
        </p>
        <textarea rows="3" maxlength="120" disabled={!managing.notify} placeholder={filledWord(WORDS.messageTo, "A note for {charName}", { charName: managing.name })} bind:value={managing.message}></textarea>
      {/if}
      <p class="controls">
        <button type="button" class="primary" disabled={busy} onclick={confirmManagement}>{managing.isContact ? word(WORDS.editContact, "Edit Contact") : word(WORDS.addContact, "Add Contact")}</button>
        <button type="button" class="minor" onclick={cancelManagement}>{word(WORDS.cancel, "Cancel")}</button>
      </p>
    </section>
  {/if}

  {#if bookmarking !== null}
    <BookmarkWindow {store} {flow} place={bookmarking} onDone={() => (bookmarking = null)} />
  {/if}

  {#if folderNaming !== null}
    <!-- The name popup (utilWindows.NamePopup) of Create Folder or a folder's Change Label. -->
    <section class="contacts-confirm" aria-label={folderNaming.id === null ? word(AGENT_WORDS.typeName, "Folder name") : word(AGENT_WORDS.typeInNewName, "New name")}>
      <h3>{folderNaming.id === null ? word(AGENT_WORDS.typeName, "Folder name") : word(AGENT_WORDS.typeInNewName, "New name")}</h3>
      <p class="controls">
        <label>
          {folderNaming.id === null ? word(AGENT_WORDS.typeNameForFolder, "Name the folder.") : word(AGENT_WORDS.typeInNewFolderName, "Name the folder anew.")}
          <input type="text" bind:value={folderNaming.value} />
        </label>
        <button type="button" onclick={confirmFolderName}>{word(WORDS.ok, "OK")}</button>
        <button type="button" class="minor" onclick={() => { folderNaming = null; notes = []; }}>{word(WORDS.cancel, "Cancel")}</button>
      </p>
    </section>
  {/if}

  <!-- The window's tabs (ConstructTabs, 85 to 92): Contacts and Agents. -->
  {#if !contactAction}
  {#if !organization}
  <nav class="tabs">
    <button type="button" class:active={tab === "contacts"} aria-pressed={tab === "contacts"} onclick={() => chooseTab("contacts")}>{word(WORDS.contacts, "Contacts")}</button>
    <button type="button" class:active={tab === "agents"} aria-pressed={tab === "agents"} onclick={() => chooseTab("agents")}>{word(AGENT_WORDS.agents, "Agents")}</button>
    <button type="button" class:active={tab === "search"} aria-pressed={tab === "search"} onclick={() => chooseTab("search")}>{word(SEARCH_WORDS.search, "Search")}</button>
  </nav>
  {/if}

  {#if tab === "agents"}
    <div class="contacts-agents">
      {#if book === null}
        <p class="note">{busy ? "Reading…" : ""}</p>
      {:else}
        {#each agentGroups as group (group.id)}
          <!-- A group (ListGroup): opened or closed, with how many it holds; an agent dropped on it goes into it. -->
          <div class="agents-group" role="group" aria-label={group.label} ondragover={(event) => event.preventDefault()} ondrop={(event) => dropAgent(event, group.id)}>
            <p class="controls agents-group-head">
              <button type="button" class="minor" aria-expanded={group.open} onclick={() => toggleGroup(group.id)}>
                {group.open ? "▾" : "▸"} {filledWord(WORDS.withLength, "{label} [{length}]", { label: group.label, length: String(group.lines.length) })}
              </button>
              <button type="button" class="minor" aria-expanded={groupMenuFor === group.id} aria-label="Group menu" onclick={() => (groupMenuFor = groupMenuFor === group.id ? null : group.id)}>⋯</button>
            </p>
            {#if groupMenuFor === group.id}
              <!-- The group's menu (listgroup.py GetMenu, 284 to 311): Expand or Collapse, and for a folder Change Label and Delete Folder. -->
              <p class="controls contacts-menu">
                <button type="button" class="minor" onclick={() => toggleGroup(group.id)}>{group.open ? word(AGENT_WORDS.collapse, "Collapse") : word(AGENT_WORDS.expand, "Expand")}</button>
                {#if !group.locked}
                  <button type="button" class="minor" onclick={() => { groupMenuFor = null; notes = []; folderNaming = { id: group.id, value: "" }; }}>{word(AGENT_WORDS.changeLabel, "Rename")}</button>
                  <button type="button" class="minor" onclick={() => deleteFolder(group.id)}>{word(AGENT_WORDS.deleteFolder, "Delete")}</button>
                {/if}
              </p>
            {/if}
            {#if group.open}
              <ul class="agents-entries">
                {#each group.lines as line (line.agentID)}
                  {@const key = agentKey(group.id, line.agentID)}
                  <!-- An agent's entry (AgentEntry): its name and level, where it is, its mission's state and its kind;
                       chosen by a click, with Shift and Ctrl as the scroll chooses; dragged with the others chosen. -->
                  <li draggable="true" ondragstart={(event) => agentDragStart(event, key)}>
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <div
                      class="agents-entry"
                      class:selected={chosenInOrder.includes(key)}
                      role="option"
                      tabindex="-1"
                      aria-selected={chosenInOrder.includes(key)}
                      data-agent-key={key}
                      onclick={(event) => agentClick(event, key)}
                      ondblclick={() => agentDoubleClick(line.agentID)}
                    >
                      <div>
                        <strong>{line.nameLine}</strong>
                        {#if line.missionState !== null}
                          <span class="badge" class:accent={!line.missionState.offered}>{line.missionState.text}</span>
                        {/if}
                        {#if line.locationLine !== ""}<br /><small>{line.locationLine}</small>{/if}
                        {#if line.typeLine !== ""}<br /><small class="note">{line.typeLine}</small>{/if}
                      </div>
                      <div class="agents-entry-buttons">
                        <button type="button" class="minor" disabled={busy} aria-label={word(AGENT_WORDS.startConversation, "Talk")} title={word(AGENT_WORDS.startConversation, "Talk")} onclick={(event) => { event.stopPropagation(); startConversation(line.agentID); }}>💬</button>
                        <button type="button" class="minor" aria-expanded={agentMenuFor === key} aria-label="Menu" onclick={(event) => { event.stopPropagation(); openAgentMenu(key); }}>⋯</button>
                      </div>
                    </div>
                    {#if agentMenuFor === key && chosenInOrder.length > 1 && chosenInOrder.includes(key)}
                      <!-- The menu of several (userentry.py AgentEntry._GetMultiMenu, 884 to 939). -->
                      <p class="controls contacts-menu">
                        {#if severalMenu.showInfo}
                          <button type="button" class="minor" onclick={severalInfo}>{word(WORDS.showInfo, "Info")}</button>
                        {/if}
                        <button type="button" class="minor" disabled={busy} onclick={() => removeAgents(severalMenu.entries.map((entry) => entry.agentID))}>{word(AGENT_WORDS.removeFromAddressbook, "Remove")}</button>
                        {#if severalMenu.removeFromFolders !== null}
                          <button type="button" class="minor" onclick={severalOutOfFolders}>{severalMenu.removeFromFolders}</button>
                        {/if}
                      </p>
                    {:else if agentMenuFor === key}
                      <!-- The agent's menu (menusvc.py _CharacterMenu, 579 to 624; userentry.py AgentEntry.GetMenu, 858 to 882). -->
                      <p class="controls contacts-menu">
                        {#if agentInfoOffered(line.agentID)}
                          <button type="button" class="minor" onclick={() => agentInfo(line.agentID)}>{word(WORDS.showInfo, "Info")}</button>
                        {/if}
                        <button type="button" class="minor" disabled={busy} onclick={() => startConversation(line.agentID)}>{word(AGENT_WORDS.startConversation, "Talk")}</button>
                        <button type="button" class="minor" disabled={busy} onclick={() => removeAgents([line.agentID])}>{word(AGENT_WORDS.removeFromAddressbook, "Remove")}</button>
                        {#if agentPlace(line.agentID) !== null}
                          {@const place = agentPlace(line.agentID)}
                          {#if agentDestinationOffered(line.agentID)}
                            <button type="button" class="minor" onclick={() => agentRoute(line.agentID, "destination")}>{word(AGENT_WORDS.setDestination, "Head there")}</button>
                          {/if}
                          {#if place !== null && $waypointsState.includes(place)}
                            <button type="button" class="minor" onclick={() => agentRoute(line.agentID, "remove")}>{word(AGENT_WORDS.removeWaypoint, "Take off the route")}</button>
                          {:else}
                            <button type="button" class="minor" onclick={() => agentRoute(line.agentID, "add")}>{word(AGENT_WORDS.addWaypoint, "Put on the route")}</button>
                          {/if}
                          <button type="button" class="minor" disabled={bookmarking !== null} onclick={() => bookmarkAgentPlace(line.agentID)}>{word(AGENT_WORDS.bookmarkLocation, "Save the place")}</button>
                        {/if}
                        {#if agentDockStation(line.agentID) !== null}
                          <button type="button" class="minor" onclick={() => dockAtAgent(line.agentID)}>{word(AGENT_WORDS.dockInStation, "Dock there")}</button>
                        {/if}
                        {#if !group.locked}
                          <button type="button" class="minor" onclick={() => removeFromFolder(group.id, line.agentID)}>{filledWord(AGENT_WORDS.removeFromGroup, "Take out of {groupname}", { groupname: group.label })}</button>
                        {/if}
                      </p>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/each}
        <p class="controls">
          <button type="button" class="minor" onclick={() => { notes = []; folderNaming = { id: null, value: "" }; }}>{word(AGENT_WORDS.createFolder, "New Folder")}</button>
        </p>
      {/if}
    </div>
  {:else if tab === "search"}
    <!-- The Search tab (SearchPanel): the search's field, searched on Return, and its settings menu; what was found
         by kind, each kind a group with how many, its owners' entries and their menus. -->
    <div class="contacts-search">
      <p class="controls">
        <input
          type="search"
          maxlength="100"
          placeholder="Search"
          aria-label={word(SEARCH_WORDS.search, "Search")}
          bind:value={searchText}
          onkeydown={(event) => { if (event.key === "Enter") runSearch(); }}
        />
        <button type="button" class="minor" aria-expanded={searchSettingsOpen} title={word(SEARCH_WORDS.settings, "Settings")} aria-label={word(SEARCH_WORDS.settings, "Settings")} onclick={() => (searchSettingsOpen = !searchSettingsOpen)}>⚙</button>
      </p>
      {#if searchSettingsOpen}
        <!-- The settings menu (_get_search_settings_menu, 365 to 376): Search Type and Search By, one of each chosen. -->
        <div class="contacts-menu contacts-search-settings">
          <strong>{word(SEARCH_WORDS.searchType, "Search Type")}</strong>
          {#each SEARCH_TYPE_CHOICES as [searchType, label, own] (searchType)}
            <label>
              <input type="radio" name="contacts-search-type" checked={searchSettings.searchType === searchType} onchange={() => chooseSearchSetting({ ...searchSettings, searchType })} />
              {word(label, own)}
            </label>
          {/each}
          <strong>{word(SEARCH_WORDS.searchBy, "Search By")}</strong>
          {#each SEARCH_BY_CHOICES as [searchBy, label, own] (searchBy)}
            <label>
              <input type="radio" name="contacts-search-by" checked={searchSettings.searchBy === searchBy} onchange={() => chooseSearchSetting({ ...searchSettings, searchBy })} />
              {word(label, own)}
            </label>
          {/each}
        </div>
      {/if}
      {#if searching}
        <p class="note">Searching…</p>
      {:else if searchFound !== null && searchGroups.length === 0}
        <p class="note">No results</p>
      {/if}
      {#each searchGroups as group (group.resultType)}
        {@const open = !searchClosed.includes(group.resultType)}
        <!-- A kind's group (GetScrollListGroup: its SectionHeader, the kind and how many). -->
        <p class="controls agents-group-head">
          <button type="button" class="minor" aria-expanded={open} onclick={() => (searchClosed = open ? [...searchClosed, group.resultType] : searchClosed.filter((each) => each !== group.resultType))}>
            {open ? "▾" : "▸"} {filledWord(SEARCH_WORDS.sectionHeader, "{resultType} ({numberReturned})", { resultType: group.label, numberReturned: String(group.found.length) })}
          </button>
        </p>
        {#if open}
          <ul class="agents-entries">
            {#each group.found as owner (owner.id)}
              {@const menuKey = `${group.resultType}|${owner.id}`}
              <li>
                {#if group.resultType === RESULT_TYPE.agent}
                  {@const line = agentLineOf(owner.id, owner.name)}
                  <!-- An agent's entry (AgentEntry), as in the Agents tab. -->
                  <div class="agents-entry" role="group" aria-label={line.nameLine} ondblclick={event => { if (!(event.target as Element).closest("button,input,select,a")) agentDoubleClick(owner.id); }}>
                    <div>
                      <strong>{line.nameLine}</strong>
                      {#if line.missionState !== null}
                        <span class="badge" class:accent={!line.missionState.offered}>{line.missionState.text}</span>
                      {/if}
                      {#if line.locationLine !== ""}<br /><small>{line.locationLine}</small>{/if}
                      {#if line.typeLine !== ""}<br /><small class="note">{line.typeLine}</small>{/if}
                    </div>
                    <div class="agents-entry-buttons">
                      <button type="button" class="minor" disabled={busy} aria-label={word(AGENT_WORDS.startConversation, "Talk")} title={word(AGENT_WORDS.startConversation, "Talk")} onclick={() => startConversation(owner.id)}>💬</button>
                      <button type="button" class="minor" aria-expanded={searchMenuFor === menuKey} aria-label="Menu" onclick={() => (searchMenuFor = searchMenuFor === menuKey ? null : menuKey)}>⋯</button>
                    </div>
                  </div>
                  {#if searchMenuFor === menuKey}
                    <!-- An agent's menu (_CharacterMenu: Show Info, Start Conversation, Add to Addressbook or Remove from
                         Addressbook, and Dock in Station where the pilot is in space in its system). -->
                    <p class="controls contacts-menu">
                      {#if agentInfoOffered(owner.id)}
                        <button type="button" class="minor" onclick={() => agentInfo(owner.id)}>{word(WORDS.showInfo, "Info")}</button>
                      {/if}
                      <button type="button" class="minor" disabled={busy} onclick={() => { searchMenuFor = null; startConversation(owner.id); }}>{word(AGENT_WORDS.startConversation, "Talk")}</button>
                      {#if searchAgentIDs.has(owner.id)}
                        <button type="button" class="minor" disabled={busy} onclick={() => { searchMenuFor = null; removeAgents([owner.id]); }}>{word(AGENT_WORDS.removeFromAddressbook, "Remove")}</button>
                      {:else}
                        <button type="button" class="minor" disabled={busy} onclick={() => addAgent(owner.id, owner.name)}>{word(SEARCH_WORDS.addToAddressbook, "Add to address book")}</button>
                      {/if}
                      {#if agentPlace(owner.id) !== null}
                        {@const place = agentPlace(owner.id)}
                        {#if agentDestinationOffered(owner.id)}
                          <button type="button" class="minor" onclick={() => agentRoute(owner.id, "destination")}>{word(AGENT_WORDS.setDestination, "Head there")}</button>
                        {/if}
                        {#if place !== null && $waypointsState.includes(place)}
                          <button type="button" class="minor" onclick={() => agentRoute(owner.id, "remove")}>{word(AGENT_WORDS.removeWaypoint, "Take off the route")}</button>
                        {:else}
                          <button type="button" class="minor" onclick={() => agentRoute(owner.id, "add")}>{word(AGENT_WORDS.addWaypoint, "Put on the route")}</button>
                        {/if}
                        <button type="button" class="minor" disabled={bookmarking !== null} onclick={() => bookmarkAgentPlace(owner.id)}>{word(AGENT_WORDS.bookmarkLocation, "Save the place")}</button>
                      {/if}
                      {#if agentDockStation(owner.id) !== null}
                        <button type="button" class="minor" onclick={() => dockAtAgent(owner.id)}>{word(AGENT_WORDS.dockInStation, "Dock there")}</button>
                      {/if}
                    </p>
                  {/if}
                {:else}
                  {@const offers = offersOf(owner.id)}
                  <!-- An owner's entry (User): its name, and the address book's part of its menu. -->
                  <div class="agents-entry" role="group" aria-label={owner.name} ondblclick={event => { if (ownerSearchResult(group.resultType) && !(event.target as Element).closest("button,input,select,a")) void run(() => doubleClickOwner(flow, owner.id)); }}>
                    <div>
                      {owner.name}
                      {#if blockedIDs.has(owner.id)}<span class="badge">{word(WORDS.blocked, "Blocked")}</span>{/if}
                    </div>
                    <div class="agents-entry-buttons">
                      <button type="button" class="minor" aria-expanded={searchMenuFor === menuKey} aria-label="Menu" onclick={() => (searchMenuFor = searchMenuFor === menuKey ? null : menuKey)}>⋯</button>
                    </div>
                  </div>
                  {#if searchMenuFor === menuKey}
                    <p class="controls contacts-menu">
                      {#if offers.showInfo}
                        <button type="button" class="minor" disabled={busy} onclick={() => ownerInfo(owner.id)}>{word(WORDS.showInfo, "Info")}</button>
                      {/if}
                      {#if offers.mail && openMail}
                        <button type="button" class="minor" disabled={busy} onclick={() => mailOwner(owner.id, owner.name)}>{word(WORDS.sendMail, "Write a mail")}</button>
                      {/if}
                      {#if offers.add}
                        <button type="button" class="minor" disabled={busy} onclick={() => { searchMenuFor = null; manage(owner.id, owner.name); }}>{word(WORDS.addContact, "Add Contact")}</button>
                      {/if}
                      {#if offers.edit}
                        <button type="button" class="minor" disabled={busy} onclick={() => { searchMenuFor = null; manage(owner.id, owner.name); }}>{word(WORDS.editContact, "Edit Contact")}</button>
                        <button type="button" class="minor" disabled={busy} onclick={() => { searchMenuFor = null; removeContacts([owner]); }}>{word(WORDS.removeContact, "Remove Contact")}</button>
                      {/if}
                      {#if offers.unblock}
                        <button type="button" class="minor" disabled={busy} onclick={() => { searchMenuFor = null; unblock([owner.id]); }}>{word(WORDS.unblockContact, "Unblock")}</button>
                      {/if}
                      {#if offers.block}
                        <button type="button" class="minor" disabled={busy} onclick={() => { searchMenuFor = null; block(owner.id, owner.name); }}>{word(WORDS.blockContact, "Block")}</button>
                      {/if}
                      {#if offers.money}
                        <button type="button" class="minor" disabled={busy} onclick={() => giveMoneyTo(owner.id, owner.name)}>{word(WORDS.giveMoney, "Give ISK")}</button>
                      {/if}
                      {#if offers.inviteToFleet}
                        <span class="contacts-submenu">{word(WORDS.inviteToFleet, "Fleet invite")}:</span>
                        {@render memberPlaces(inviteMenuOf(owner.id), (place) => fleetInviteTo(owner.id, place))}
                      {/if}
                      <OwnerChatMenu {store} {flow} ownerID={owner.id} onDone={fleetDone} />
                      <OwnerMemberMenu {store} {flow} ownerID={owner.id} onDone={fleetDone} />
                      <OwnerQuitMenu {store} {flow} ownerIDs={[owner.id]} onDone={fleetDone} />
                      <OwnerExpelMenu {store} {flow} ownerIDs={[owner.id]} onDone={fleetDone} />
                      <OwnerCEOMenu {store} {flow} ownerIDs={[owner.id]} onDone={fleetDone} />
                      <OwnerDecorationMenu {store} {flow} ownerIDs={[owner.id]} onDone={fleetDone} />
                      {#if isCharacterContact(owner.id)}<OwnerCorporationInviteMenu {store} {flow} ownerIDs={[owner.id]} onDone={fleetDone} /><OwnerCorporationCashMenu {store} {flow} ownerIDs={[owner.id]} onDone={fleetDone} />{/if}
                      {#if fleetMenuOffered(owner.id)}
                        {@render fleetSubmenu(owner.id)}
                      {/if}
                      {#if offers.formFleetWith}
                        <button type="button" class="minor" disabled={busy} onclick={() => fleetInvite(owner.id, true)}>{word(WORDS.formFleetWith, "Start a fleet with")}</button>
                      {/if}
                    </p>
                  {/if}
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      {/each}
    </div>
  {:else}
  <div class="contacts-form" class:organization>
    <!-- The form's groups, each with how many it holds (ListGroup's LabelWithLength), and the labels under theirs. -->
    <ul class="contacts-groups">
      {#each GROUPS.filter(([id]) => !organization || id === CONTACT_GROUP.all || id <= 10) as [groupID, label, own] (groupID)}
        {#if groupID === CONTACT_GROUP.blocked}
          <li class="contacts-gap" aria-hidden="true"></li>
        {/if}
        <li>
          <button type="button" class="minor" class:active={group === groupID} onclick={() => choose(groupID)}>
            {filledWord(WORDS.withLength, "{label} [{length}]", { label: word(label, own), length: String(countOf(groupID)) })}
          </button>
        </li>
      {/each}
      {#if book !== null && book.labels !== null}
        <li class="contacts-gap" aria-hidden="true"></li>
        <!-- The Labels group, with its Manage Labels (LabelGroupMenu, 532 to 535; manage_labels_callback, 162). -->
        <li class="contacts-labels-head">
          {word(WORDS.labels, "Labels")}
          {#if canManage}<button type="button" class="minor" onclick={() => { notes = []; told = []; managingLabels = !managingLabels; }}>{word(WORDS.manageLabels, "Manage Labels")}</button>{/if}
        </li>
        <li>
          <button type="button" class="minor contacts-label" class:active={group === NO_LABEL} onclick={() => choose(NO_LABEL)}>
            {word(WORDS.noLabel, "No Label")} [{countOf(NO_LABEL)}]
          </button>
        </li>
        {#each labels as label (String(label.labelID))}
          <li class="contacts-label-row">
            <button type="button" class="minor contacts-label" class:active={group === labelGroup(label.labelID)} onclick={() => choose(labelGroup(label.labelID))}>
              {label.name} [{countOf(labelGroup(label.labelID))}]
            </button>
            {#if canManage}<button type="button" class="minor" aria-expanded={labelMenuFor === String(label.labelID)} aria-label="Label menu" onclick={() => (labelMenuFor = labelMenuFor === String(label.labelID) ? null : String(label.labelID))}>⋯</button>{/if}
          </li>
          {#if labelMenuFor === String(label.labelID)}
            <!-- A label's menu (GetLabelMenu, 226 to 233): Rename, and Delete with the entry's own words, its count with them. -->
            <li class="contacts-menu">
              <button type="button" class="minor" disabled={busy} onclick={() => { labelMenuFor = null; notes = []; renaming = { labelID: label.labelID, value: "" }; }}>{word(WORDS.labelsRename, "Rename")}</button>
              <button type="button" class="minor" disabled={busy} onclick={() => deleteLabel(label, `${label.name} [${countOf(labelGroup(label.labelID))}]`)}>{word(WORDS.labelsDelete, "Delete")}</button>
            </li>
          {/if}
        {/each}
      {/if}
    </ul>

    <div class="contacts-list">
      {#if organization && canManage}
        <div class="controls">
          <input type="search" aria-label="Find contact to add" placeholder="Find contact to add" bind:value={ownerQuery} onkeydown={(event) => { if (event.key === "Enter") void findCorporateOwner(); }} />
          <button type="button" disabled={busy || ownerQuery.trim().length < 3} onclick={() => void findCorporateOwner()}>{word(SEARCH_WORDS.search, "Search")}</button>
        </div>
        {#each ownerMatches as owner (owner.id)}<p><button type="button" onclick={() => { manage(owner.id, owner.name); ownerMatches = []; }}>{owner.name}</button></p>{/each}
      {/if}
      <p class="controls">
        {#if !organization}<label>
          <input type="checkbox" bind:checked={onlineOnly} onchange={onlineOnlyChanged} />
          {word(WORDS.onlineOnly, "Online only")}
        </label>{/if}
        <input type="search" maxlength="100" aria-label="Filter" bind:value={filterText} oninput={filterTyped} />
      </p>
      {#if book === null}
        <p class="note">{busy ? "Reading…" : ""}</p>
      {:else if group === CONTACT_GROUP.notifications && notificationEntries.length > 0}
        <!-- The Notifications group (GetScrolllist, 462 to 469): the contacts' notifications, newest first, each its
             body's first two parts and the whole as its hint (ContactNotificationEntry). -->
        <ul class="agents-entries">
          {#each notificationEntries.slice(startPos, startPos + MAX_CONTACTS_PER_PAGE) as entry (entry.notificationID)}
            <li title={entry.hint}>
              <div class="agents-entry">
                <div>
                  <strong>{entry.label}</strong>
                  {#if entry.label2 !== ""}<br /><small>{entry.label2}</small>{/if}
                </div>
                <div class="agents-entry-buttons">
                  <button type="button" class="minor" aria-expanded={notificationMenuFor === entry.notificationID} aria-label="Menu" onclick={() => (notificationMenuFor = notificationMenuFor === entry.notificationID ? null : entry.notificationID)}>⋯</button>
                </div>
              </div>
              {#if notificationMenuFor === entry.notificationID}
                <!-- Its menu (contactNotificationEntry.py GetMenu, 53 to 70): the sender's contact and block, and Delete notification. -->
                <p class="controls contacts-menu">
                  {#if contactIDs.has(entry.senderID)}
                    <button type="button" class="minor" disabled={busy} onclick={() => { notificationMenuFor = null; manage(entry.senderID, entry.senderName); }}>{word(WORDS.editContact, "Edit Contact")}</button>
                    <button type="button" class="minor" disabled={busy} onclick={() => { notificationMenuFor = null; removeContacts([{ id: entry.senderID, name: entry.senderName }]); }}>{word(WORDS.removeContact, "Remove Contact")}</button>
                  {:else}
                    <button type="button" class="minor" disabled={busy} onclick={() => { notificationMenuFor = null; manage(entry.senderID, entry.senderName); }}>{word(WORDS.addContact, "Add Contact")}</button>
                  {/if}
                  {#if blockedIDs.has(entry.senderID)}
                    <button type="button" class="minor" disabled={busy} onclick={() => { notificationMenuFor = null; unblock([entry.senderID]); }}>{word(WORDS.unblockContact, "Unblock")}</button>
                  {:else}
                    <button type="button" class="minor" disabled={busy} onclick={() => { notificationMenuFor = null; block(entry.senderID, entry.senderName); }}>{word(WORDS.blockContact, "Block")}</button>
                  {/if}
                  <button type="button" class="minor" disabled={busy} onclick={() => deleteNotification(entry.notificationID)}>{word(WORDS.deleteNotification, "Delete")}</button>
                </p>
              {/if}
            </li>
          {/each}
        </ul>
      {:else if shown.rows.length === 0}
        <p class="note">{shown.hint}</p>
      {:else}
        <table>
          <thead>
            <tr><th></th><th>{word(WORDS.name, "Name")}</th><th></th><th></th><th></th></tr>
          </thead>
          <tbody>
            {#each shown.rows as row (row.id)}
              <tr class:selected={selectedIDs.includes(row.id)} ondblclick={event => { if (!(event.target as Element).closest("button,input,select,a")) void run(() => doubleClickOwner(flow, row.id)); }}>
                <td>
                  <!-- The entry selected or not (the scroll's multiSelect), which the page has as a box. -->
                  <input type="checkbox" aria-label={`Select ${row.name}`} checked={selectedIDs.includes(row.id)} onchange={() => toggleSelected(row.id)} />
                </td>
                <td>
                  {row.name}
                  {#if row.labelNames.length > 0}
                    <!-- Its labels' names under its own (SetContactLabelText, 353 to 358), each in its colour. -->
                    <br /><small class="contacts-entry-labels">{#each row.labelNames as label, at (at)}{at > 0 ? ", " : ""}<span style:color={label.color}>{label.name}</span>{/each}</small>
                  {/if}
                </td>
                <td class="contacts-state">
                  {#if row.blocked}
                    <span class="badge">{word(WORDS.blocked, "Blocked")}</span>
                  {:else if row.online !== null}
                    <span class="badge" class:accent={row.online}>{row.online ? word(WORDS.online, "Online") : word(WORDS.offline, "Offline")}</span>
                  {/if}
                </td>
                <td class="contacts-standing">{row.standing === null ? "" : row.standing > 0 ? `+${row.standing}` : String(row.standing)}</td>
                <td>
                  <button type="button" class="minor" aria-expanded={menuFor === row.id} aria-label="Menu" onclick={() => (menuFor = menuFor === row.id ? null : row.id)}>⋯</button>
                </td>
              </tr>
              {#if canManage && menuFor === row.id && selectedRows.length > 1 && selectedIDs.includes(row.id)}
                {@const several = selectedRows}
                {@const masks = several.map((each) => each.labelMask)}
                {@const toAssign = labelsToAssign(masks, labels)}
                {@const toRemove = labelsToRemove(masks, labels)}
                <!-- The menu of several entries (userentry.py _GetMultiMenu, 508 to 541). -->
                <tr class="contacts-menu">
                  <td colspan="5">
                    <button type="button" class="minor" disabled={busy} onclick={() => editSeveral(several)}>{filledWord(WORDS.editContacts, "Edit {contactcount} contacts", { contactcount: String(several.length) })}</button>
                    <button type="button" class="minor" disabled={busy} onclick={() => removeContacts(several)}>{filledWord(WORDS.removeContacts, "Remove {contactcount} contacts", { contactcount: String(several.length) })}</button>
                    {#if several.every((each) => blockedIDs.has(each.id))}
                      <button type="button" class="minor" disabled={busy} onclick={() => unblock(several.map((each) => each.id))}>{filledWord(WORDS.unblockContacts, "Unblock {contactcount}", { contactcount: String(several.length) })}</button>
                    {/if}
                    {#if toAssign.length > 0}
                      <span class="contacts-submenu">{word(WORDS.addContactLabel, "Add Label")}:</span>
                      {#each toAssign as label (String(label.labelID))}
                        <button type="button" class="minor" disabled={busy} onclick={() => assignLabel(several.map((each) => each.id), label)}>{label.name}</button>
                      {/each}
                    {/if}
                    {#if toRemove.length > 0}
                      <span class="contacts-submenu">{word(WORDS.removeContactLabel, "Remove Label")}:</span>
                      {#each toRemove as label (String(label.labelID))}
                        <button type="button" class="minor" disabled={busy} onclick={() => removeLabel(several.map((each) => each.id), label)}>{label.name}</button>
                      {/each}
                    {/if}
                  </td>
                </tr>
              {:else if menuFor === row.id}
                {@const offers = offersOf(row.id)}
                {@const toAssign = canManage ? labelsToAssign([row.labelMask], labels) : []}
                {@const toRemove = canManage ? labelsToRemove([row.labelMask], labels) : []}
                <!-- The entry's menu of a contact (menusvc.py 590 to 602), and its labels' (userentry.py GetMenu, 444 to 452). -->
                <tr class="contacts-menu">
                  <td colspan="5">
                    {#if offers.showInfo}
                      <button type="button" class="minor" disabled={busy} onclick={() => ownerInfo(row.id)}>{word(WORDS.showInfo, "Info")}</button>
                    {/if}
                    {#if offers.mail && openMail}
                      <button type="button" class="minor" disabled={busy} onclick={() => mailOwner(row.id, row.name)}>{word(WORDS.sendMail, "Write a mail")}</button>
                    {/if}
                    {#if offers.add}
                      <button type="button" class="minor" disabled={busy} onclick={() => manage(row.id, row.name)}>{word(WORDS.addContact, "Add Contact")}</button>
                    {/if}
                    {#if offers.edit}
                      <button type="button" class="minor" disabled={busy} onclick={() => manage(row.id, row.name)}>{word(WORDS.editContact, "Edit Contact")}</button>
                      <button type="button" class="minor" disabled={busy} onclick={() => removeContacts([row])}>{word(WORDS.removeContact, "Remove Contact")}</button>
                    {/if}
                    {#if offers.unblock}
                      <button type="button" class="minor" disabled={busy} onclick={() => unblock([row.id])}>{word(WORDS.unblockContact, "Unblock")}</button>
                    {/if}
                    {#if offers.block}
                      <button type="button" class="minor" disabled={busy} onclick={() => block(row.id, row.name)}>{word(WORDS.blockContact, "Block")}</button>
                    {/if}
                    {#if offers.money}
                      <button type="button" class="minor" disabled={busy} onclick={() => giveMoneyTo(row.id, row.name)}>{word(WORDS.giveMoney, "Give ISK")}</button>
                    {/if}
                    {#if offers.inviteToFleet}
                      <span class="contacts-submenu">{word(WORDS.inviteToFleet, "Fleet invite")}:</span>
                      {@render memberPlaces(inviteMenuOf(row.id), (place) => fleetInviteTo(row.id, place))}
                    {/if}
                    {#if selectedRows.length <= 1}<OwnerChatMenu {store} {flow} ownerID={row.id} onDone={fleetDone} />{/if}
                    {#if selectedRows.length <= 1}<OwnerMemberMenu {store} {flow} ownerID={row.id} onDone={fleetDone} />{/if}
                    {#if selectedRows.length <= 1}<OwnerQuitMenu {store} {flow} ownerIDs={[row.id]} onDone={fleetDone} />{/if}
                    {#if selectedRows.length <= 1}<OwnerExpelMenu {store} {flow} ownerIDs={[row.id]} onDone={fleetDone} />{/if}
                    {#if selectedRows.length <= 1}<OwnerCEOMenu {store} {flow} ownerIDs={[row.id]} onDone={fleetDone} />{/if}
                    {#if selectedRows.length <= 1}<OwnerDecorationMenu {store} {flow} ownerIDs={[row.id]} onDone={fleetDone} />{/if}
                    {#if selectedRows.length <= 1 && isCharacterContact(row.id)}<OwnerCorporationInviteMenu {store} {flow} ownerIDs={[row.id]} onDone={fleetDone} /><OwnerCorporationCashMenu {store} {flow} ownerIDs={[row.id]} onDone={fleetDone} />{/if}
                    {#if fleetMenuOffered(row.id)}
                      {@render fleetSubmenu(row.id)}
                    {/if}
                    {#if offers.formFleetWith}
                      <button type="button" class="minor" disabled={busy} onclick={() => fleetInvite(row.id, true)}>{word(WORDS.formFleetWith, "Start a fleet with")}</button>
                    {/if}
                    {#if toAssign.length > 0}
                      <span class="contacts-submenu">{word(WORDS.assignLabel, "Assign Label")}:</span>
                      {#each toAssign as label (String(label.labelID))}
                        <button type="button" class="minor" disabled={busy} onclick={() => assignLabel([row.id], label)}>{label.name}</button>
                      {/each}
                    {/if}
                    {#if toRemove.length > 0}
                      <span class="contacts-submenu">{word(WORDS.removeLabel, "Remove Label")}:</span>
                      {#each toRemove as label (String(label.labelID))}
                        <button type="button" class="minor" disabled={busy} onclick={() => removeLabel([row.id], label)}>{label.name}</button>
                      {/each}
                    {/if}
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      {/if}
      {#if startPos > 0 || startPos + MAX_CONTACTS_PER_PAGE < shown.total}
        <!-- The form's pages (UpdatePaginationCont, 563 to 584): back and on, and which of how many. -->
        <p class="controls contacts-pages">
          <span>{Math.floor(startPos / MAX_CONTACTS_PER_PAGE) + 1}/{Math.ceil(shown.total / MAX_CONTACTS_PER_PAGE)}</span>
          <button type="button" class="minor" disabled={startPos === 0} aria-label={word(WORDS.previous, "Previous")} onclick={() => browse(-1)}>‹</button>
          <button type="button" class="minor" disabled={startPos + MAX_CONTACTS_PER_PAGE >= shown.total} aria-label={word(WORDS.next, "Next")} onclick={() => browse(1)}>›</button>
        </p>
      {/if}
    </div>
  </div>
  {/if}
  {/if}
</section>

{#snippet memberPlaces(entries: readonly MemberMenuEntry[], pick: (place: MemberMenuPlace) => void)}
  <!-- MemberMenu's places (evefleet/client/menu.py): ranks, then each wing with its wing commander's place and its
       squads, each squad with its places; the rank's word on each, the wing's and the squad's names before them. -->
  {#each entries as entry, index (index)}
    {#if entry.kind === "place"}
      <button type="button" class="minor" disabled={busy} onclick={() => pick(entry)}>{rankWord(entry.role)}</button>
    {:else}
      <span class="contacts-submenu" data-wing-id={entry.wingID}>{wingWord(entry)}:
        {#each entry.entries as inner, innerIndex (innerIndex)}
          {#if inner.kind === "place"}
            <button type="button" class="minor" disabled={busy} onclick={() => pick(inner)}>{rankWord(inner.role)}</button>
          {:else}
            <span class="contacts-submenu" data-squad-id={inner.squadID}>{squadWord(inner)}:
              {#each inner.places as place, placeIndex (placeIndex)}
                <button type="button" class="minor" disabled={busy} onclick={() => pick(place)}>{rankWord(place.role)}</button>
              {/each}
            </span>
          {/if}
        {/each}
      </span>
    {/if}
  {/each}
{/snippet}

{#snippet fleetSubmenu(ownerID: number)}
  <OwnerFleetMenu {store} {flow} {ownerID} {openWatchlist} onDone={fleetDone} />
{/snippet}

<style>
  .agents-group-head {
    margin: 0.25rem 0;
  }
  .agents-entries {
    list-style: none;
    margin: 0 0 0.5rem 1rem;
    padding: 0;
  }
  .agents-entries > li {
    padding: 0.25rem 0;
    border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent);
  }
  .agents-entry {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .agents-entry-buttons {
    display: flex;
    align-items: flex-start;
    gap: 0.25rem;
  }
  .contacts-form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .contacts-form.organization .contacts-groups { order: 2; }
  .contacts-form.organization .contacts-list table { width: 100%; }
  .contacts-groups {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 0 1 14rem;
  }
  .contacts-groups button {
    display: block;
    width: 100%;
    text-align: left;
  }
  /* The group shown, marked without colour alone. */
  .contacts-groups button.active {
    text-decoration: underline;
    font-weight: 600;
  }
  .contacts-gap {
    height: 0.75rem;
  }
  .contacts-labels-head {
    font-weight: 600;
  }
  .contacts-label {
    padding-left: 1rem;
  }
  .contacts-label-row {
    display: flex;
  }
  .contacts-groups .contacts-label-row button:last-child,
  .contacts-groups .contacts-labels-head button,
  .contacts-groups .contacts-menu button {
    display: inline-block;
    width: auto;
  }
  .contacts-submenu {
    font-weight: 600;
    margin-left: 0.5rem;
  }
  .contacts-entry-labels {
    opacity: 0.8;
  }
  .contacts-manage-labels {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  /* An entry selected, marked without colour alone. */
  tr.selected td {
    font-weight: 600;
  }
  .agents-entry.selected {
    font-weight: 600;
    outline: 1px dotted currentColor;
  }
  .contacts-list {
    flex: 1 1 18rem;
    min-width: 0;
  }
  .contacts-state {
    text-align: center;
  }
  .contacts-standing {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .contacts-pages {
    justify-content: flex-end;
  }
  .contacts-confirm {
    border: 1px solid currentColor;
    padding: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .contacts-confirm textarea {
    width: 100%;
    font: inherit;
  }
  /* The standing chosen, marked without colour alone. */
  .contacts-confirm button.active {
    text-decoration: underline;
    font-weight: 600;
  }
</style>
