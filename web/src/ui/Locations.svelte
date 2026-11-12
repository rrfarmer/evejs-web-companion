<script lang="ts">
  // The client's Locations window (neocom/locations/window.py LocationsWindow): its Locations tab, the bookmarks
  // panel (neocom/addressBook/bookmarksPanel.py), as bridge/locationsList.ts builds the list from the pilot's
  // folders, bookmarks and subfolders (accessGroupBookmarkMgr.GetMyActiveBookmarks, the page's own read):
  //
  //   "Locations in <system>", "Personal Locations [n]" and "Shared Locations [n]", each group closed until it is
  //   opened, its open state kept for the pilot (the client's list registry keeps it); a section's folders, then its
  //   offline folders; a folder's subfolders, then its bookmarks; a bookmark's row under the client's nine headers
  //   (Label, Type, Jumps, SOL, CON, REG, Date, Expiry, Creator), its hint the label and its note's first fifty
  //   characters.
  //
  // Its bottom's Add Location (window.py 104 to 108: addressbookService.BookmarkCurrentLocation) opens the bookmark
  // window (BookmarkWindow.svelte) for the station the pilot is docked in, or the ship's spot in space; the list is
  // read again once a place is saved.
  //
  // A bookmark's row is chosen by a click (Ctrl adds to the choice or takes it out, Shift chooses the rows from the one
  // last chosen, as the client's scroll does), dragged (the rows chosen, where it is among them) onto a folder, a
  // subfolder or another bookmark's row to move them there, or copy them with Shift held (DropInPlacesFolder and
  // DropOnBookmark; bookmarkSvc.MoveOrCopyBookmarks: MoveBookmarksToFolderAndSubfolder or
  // CopyBookmarksToFolderAndSubfolder), edited by a double click (EditBookmark), and has
  // the part of the client's bookmark menu the page offers (PlaceEntry.GetMenu, addressBookEntries.py 123 to 141;
  // menusvc.py BookmarkMenu, 1437 to 1534, as BookmarkChecker offers each): Show Info, Dock, Warp to Within (at the
  // pilot's own warp distance, or one of the seven its submenu offers, which also sets that distance), Approach
  // Location, Align to, Set Destination, Add or Remove Waypoint, Edit Location and Remove Location; several chosen
  // have Remove Location alone. The ballpark's moves are offered as bridge/locationsList.ts spaceOffersOf reckons
  // them from the page's read of space, read again as the menu opens. Removing asks the client's RemoveLocation or
  // RemoveMultipleLocation, whose Yes may be kept (addressbookService.py DeleteBookmarks, 452 to 473).
  //
  // A folder's menu (bookmarksPanel.py BookmarkACLFolderMenu, 320 to 338), on an online folder and on an offline one,
  // has the part the page offers: Folder Information (FolderInfoWindow.svelte, on the folder as the window keeps it);
  // Edit Folder and Delete Folder for a personal folder or one the pilot administers (EditACLFolder reads the folder
  // afresh, GetFolderInfo, before the folder window opens on it; ConfirmDeleteFolder first); Disconnect from Folder for
  // a shared one (ConfirmForgetFolder first; bookmarkSvc.RemoveFromKnownFolders); Offline Folder or Online Folder (bookmarkSvc.UpdateFolderActiveState: TooManyActiveFolders where the
  // pilot has the most online of its kind already), and Create Subfolder on an online folder the pilot does more than
  // view. A subfolder's menu (BookmarkSubfolderMenu, 408 to 417), where the pilot may write to its folder and, using
  // it only, made the subfolder: Edit Subfolder (not one the system made) and Delete Subfolder (ConfirmDeleteSubfolder
  // first; CouldNotDeleteBookmarksInSubfolder where it holds another's bookmarks and the pilot only uses the folder).
  // The window's bottom (window.py 104 to 110): Add Location, Create Folder (the folder window, FolderWindow.svelte) and
  // Create Subfolder (_create_sub_folder, 149 to 157), which asks CreateBookmarkFolderAsNoneValid where no folder takes
  // one, its Yes the folder window. The subfolder window is SubfolderWindow.svelte.
  //
  // The shared section ends with Shared Folders With Admin Access (GetAdminFoldersScrollList): the folders the pilot
  // may administer (SearchFoldersWithAdminAccess), each with its state, Folder Information and Disconnect from Folder
  // for one it knows, Connect for another (Folder Information's connecting: AddToKnownFolders).
  //
  // The list ends with Agent Missions (GetAgentPlacesScrollList): the journal's missions that have bookmarks, each a
  // group by its name, its bookmarks' rows with the window's columns and a menu of the part of BookmarkMenu the page
  // offers for an agent's bookmark: Show Info, Dock, Warp to Within (Warp to Location for a deadspace site's) and
  // Approach Location asked of the agent (WarpToLocation and GotoLocation), Set Destination and the waypoints; no Align
  // to, no Edit or Remove, no drag.
  //
  // Not here yet: the Search tab, a structure's Add Location, an agent's home base's or objective's distance as the
  // client takes it (the agent's GetEntryPoint), the rest of a bookmark's menu (a gate's jumps, the fleet's warps and
  // broadcast, the map's and the camera's entries, avoiding a place), things from other windows dropped here (an
  // item's place saved), and a shared bookmark shown dim before its delay has passed. Show Info shows a thing the page
  // has read in space as that thing, and any other place by its type (the info window has no station or system of its
  // own).
  import { getContext, onMount } from "svelte";
  import { formatTemplate, plainText, templateNameRefs, type TemplateArguments } from "../bridge/clientWords.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import {
    isCoordinateBookmark,
    jumpsSystemOf,
    locationsSection,
    placesInSystem,
    solSystemOf,
    spaceOffersOf,
    subfolderNameOf,
    unzipMemo,
    type LocationsSection,
    type SpaceBall,
    type SpaceHere,
  } from "../bridge/locationsList.ts";
  import { fmtDist } from "../space/overview.ts";
  import { DISTANCE_WORD_LABELS, distanceSay } from "../space/distanceWords.ts";
  import { WARP_RANGES } from "./flyingDistances.ts";
  import { showInfo, type InfoSubject } from "./showInfo.ts";
  import type { ActiveBookmarks, Bookmark, BookmarkFolder, Subfolder } from "../bridge/bookmarks.ts";
  import type { JournalMission, MissionSpot } from "../store/types.ts";
  import type { BookmarkPlace } from "../bridge/locationsList.ts";
  import type { MovedOrCopied } from "../bridge/bookmarkWrites.ts";
  import BookmarkWindow from "./BookmarkWindow.svelte";
  import SubfolderWindow from "./SubfolderWindow.svelte";
  import FolderWindow from "./FolderWindow.svelte";
  import FolderInfoWindow from "./FolderInfoWindow.svelte";
  import { ASKED_KEEPING_YES, DO_NOT_ASK_AGAIN_LABEL, suppressableKey } from "../bridge/dialogSuppression.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const warpDistance = flow.warpDistance;

  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const waypointsState = flow.waypoints;
  // svelte-ignore state_referenced_locally
  const agentsState = store.agents;

  /** The window's words (window.py 22 to 37; bookmarksPanel.py 42 to 51, 173 to 300, 340 to 544). */
  const WORDS = {
    title: "UI/PeopleAndPlaces/Locations",
    label: "UI/PeopleAndPlaces/Label",
    type: "UI/Common/Type",
    jumps: "UI/PeopleAndPlaces/Jumps",
    sol: "UI/PeopleAndPlaces/Sol",
    con: "UI/PeopleAndPlaces/Con",
    reg: "UI/PeopleAndPlaces/Reg",
    date: "UI/Common/Date",
    expiry: "UI/AclBookmarks/Expiry",
    creator: "UI/PeopleAndPlaces/Creator",
    inSystem: "UI/AclBookmarks/LocationsInSystem",
    personal: "UI/PeopleAndPlaces/PersonalLocations",
    shared: "UI/PeopleAndPlaces/SharedLocations",
    inactive: "UI/AclBookmarks/InactiveFolders",
    folderName: "UI/PeopleAndPlaces/FolderName",
    coordinate: "UI/PeopleAndPlaces/Coordinate",
    unreachable: "UI/Common/unreachable",
    personalFolder: "UI/AclBookmarks/PersonalFolderType",
    sharedFolder: "UI/AclBookmarks/SharedFolderType",
    dateTime: "/Carbon/UI/Common/DateTime/DateLongShort",
    addBookmark: "UI/PeopleAndPlaces/AddBookmark",
    placeLabel: "UI/PeopleAndPlaces/NewBookmarkLocationLabel",
    spot: "UI/PeopleAndPlaces/SpotInSolarSystem",
    notHere: "dialog:HavetobeatstationOrinShip/body",
    showInfo: "UI/Commands/ShowInfo",
    dock: "UI/Inflight/DockInStation",
    warpToWithin: "UI/Inflight/Submenus/WarpToWithin",
    within: "UI/Inflight/WarpToWithin",
    setDefault: "UI/Inflight/Submenus/SetDefaultWarpRange",
    withDistance: "UI/Menusvc/MenuHints/SelectedItemActionWithDist",
    approachLocation: "UI/Inflight/ApproachLocationActionGroup",
    alignTo: "UI/Inflight/AlignTo",
    setDestination: "UI/Inflight/SetDestination",
    addWaypoint: "UI/Inflight/AddWaypoint",
    removeWaypoint: "UI/Inflight/RemoveWaypoint",
    editBookmark: "UI/Inflight/EditBookmark",
    removeBookmark: "UI/Inflight/RemoveBookmark",
    couldNotDelete: "dialog:CouldNotDeleteBookmark/body",
    yes: "UI/Common/Buttons/Yes",
    no: "UI/Common/Buttons/No",
    deleteFolder: "UI/AclBookmarks/DeleteBookmarkFolder",
    offlineFolder: "UI/AclBookmarks/MarkFolderAsInactive",
    onlineFolder: "UI/AclBookmarks/MarkFolderActive",
    createSubfolder: "UI/AclBookmarks/CreateSubfolder",
    createFolder: "UI/PeopleAndPlaces/CreateFolder",
    editFolder: "UI/AclBookmarks/EditBookmarkFolder",
    folderInformation: "UI/AclBookmarks/FolderInformation",
    forgetFolder: "UI/AclBookmarks/ForgetBookmarkFolder",
    adminFolders: "UI/AclBookmarks/FolderWithAdminAccess",
    adminFoldersHint: "UI/AclBookmarks/AdminFolderHint",
    subscribedActive: "UI/AclBookmarks/SubscribedActive",
    subscribedInactive: "UI/AclBookmarks/SubscribedInactive",
    notSubscribed: "UI/AclBookmarks/NotSubscribed",
    noAdminFolder: "UI/AclBookmarks/NoAdminFolderFound",
    connect: "UI/AclBookmarks/AddFolder",
    addedOffline: "UI/AclBookmarks/FolderAddedAsInactiveFolder",
    tooManyKnown: "dialog:TooManyKnownFolders/body",
    agentMissions: "UI/PeopleAndPlaces/AgentMissions",
    warpToBookmark: "UI/Inflight/WarpToBookmark",
    editSubfolder: "UI/AclBookmarks/EditSubfolder",
    deleteSubfolder: "UI/AclBookmarks/DeleteSubfolder",
    tooManyOnline: "dialog:TooManyActiveFolders/body",
    othersInSubfolder: "dialog:CouldNotDeleteBookmarksInSubfolder/body",
  } as const;
  /**
   * The client's questions: before a bookmark's removal (addressbookService.py DeleteBookmarks, 457 and 459), a
   * folder's and a subfolder's deletion (bookmarksPanel.py 435 to 487), and Create Subfolder with no folder to put it
   * in (window.py 152); each with the page's own words where the install's are not to hand.
   */
  const DIALOGS = ["RemoveLocation", "RemoveMultipleLocation", "ConfirmDeleteFolder", "ConfirmDeleteSubfolder", "CreateBookmarkFolderAsNoneValid", "ConfirmForgetFolder"] as const;
  const OWN_QUESTIONS: Readonly<Record<(typeof DIALOGS)[number], readonly [string, string]>> = {
    RemoveLocation: ["Take off?", "Take {locationName} off?"],
    RemoveMultipleLocation: ["Take off?", "Take {numLocations} places off?"],
    ConfirmDeleteFolder: ["Throw the folder away?", "Throw this folder away, with all it holds?"],
    ConfirmDeleteSubfolder: ["Throw the subfolder away?", "Throw this subfolder away, with all it holds?"],
    CreateBookmarkFolderAsNoneValid: ["No folder", "There is no folder to put it in. Make one?"],
    ConfirmForgetFolder: ["Let it go?", "Stop seeing this shared folder?"],
  };
  /** appConst: the access levels, and how many folders of each kind may be online at once. */
  const ACCESS_PERSONAL = 1;
  const ACCESS_VIEW = 2;
  const ACCESS_USE = 3;
  const ACCESS_MANAGE = 4;
  const ACCESS_ADMIN = 5;
  const MAX_ONLINE_PERSONAL = 5;
  const MAX_ONLINE_SHARED = 3;
  /** appConst.MAX_KNOWN_BOOKMARK_FOLDERS: the most folders the pilot may know. */
  const MAX_KNOWN_FOLDERS = 30;
  /** invConst.ownerSystem: a subfolder the system made. */
  const OWNER_SYSTEM = 1;

  /** The client's word for a label, from the player's install; the page's own where there is none to read. */
  function word(label: string, own: string): string {
    const template = $words.templates[label];
    return typeof template === "string" ? plainText(template) : own;
  }

  function filled(label: string, own: string, args: TemplateArguments): string {
    const template = $words.templates[label];
    return plainText(formatTemplate(typeof template === "string" ? template : own, args, {
      // A pilot's name is the owner's (cfg.eveowners, as the client's [character] tag reads it): the BFF's static
      // table of characters does not hold the players of the store.
      nameOf: (kind, id) => resolvedName($names.resolved, kind === "character" ? "owner" : kind, id, ""),
    }));
  }

  /** A system subfolder's name is a label (ConvertSubfolderName). */
  const label = (path: string): string => word(path, path);

  let active = $state<ActiveBookmarks | null>(null);
  let error = $state("");

  /** The client's session.solarsystemid2: the flight's system as last read, else the online pilot's. */
  const systemID = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const pilotID = $derived($station.online?.characterID ?? null);

  // The groups open (the list registry's open states, kept for the character): closed until opened.
  let open = $state<readonly string[]>([]);
  const openKey = (id: number | null): string => `evejs.locations.open.${id ?? 0}`;
  $effect(() => {
    try {
      const kept: unknown = JSON.parse(globalThis.localStorage?.getItem(openKey(pilotID)) ?? "[]");
      // The admin folders' group is closed whenever the window opens (bookmarksPanel.py ApplyAttributes).
      open = Array.isArray(kept) ? kept.filter((each): each is string => typeof each === "string" && each !== "adminFolders") : [];
    } catch {
      open = [];
    }
  });
  function isOpen(id: string): boolean {
    return open.includes(id);
  }
  function toggle(id: string): void {
    open = isOpen(id) ? open.filter((each) => each !== id) : [...open, id];
    try {
      globalThis.localStorage?.setItem(openKey(pilotID), JSON.stringify(open));
    } catch {
      // Not kept: the groups hold for this window's life.
    }
    // The admin folders are read as their group opens (GetSubContent: GetAdminFolders).
    if (id === "adminFolders" && isOpen(id)) readAdminFolders();
    // The missions' bookmarks are the journal's, read again as their group opens.
    if (id === "agentMissions" && isOpen(id)) void flow.loadJournal().catch(() => {});
  }

  const sections = $derived<readonly LocationsSection[]>(active === null ? [] : [locationsSection(active, true, label), locationsSection(active, false, label)]);
  const local = $derived(active === null ? [] : placesInSystem(active, systemID));

  /** The bookmark window, open for a place, or none. */
  let bookmarking = $state<BookmarkPlace | null>(null);

  /**
   * Add Location (BookmarkCurrentLocation, addressbookService.py 376 to 394): the station the pilot is docked in, by
   * its default name (GetDefaultLocationName: "<station> ( <its type> )"); else the ship's spot in space ("spot in
   * <system> solar system"); else the client's HavetobeatstationOrinShip.
   */
  function addLocation(): void {
    error = "";
    const status = $flight.status;
    const docked = status !== null ? (status.docked ? status.stationID : null) : ($station.online?.stationID ?? null);
    const structure = status !== null ? status.structureID : ($station.online?.structureID ?? null);
    if (docked !== null) {
      flow.requestNames([{ kind: "station", id: docked }, { kind: "stationType", id: docked }]);
      const typeName = (): string => resolvedName($names.resolved, "stationType", docked, "");
      bookmarking = {
        itemID: docked,
        askIfKnown: true,
        typeName,
        name: () => filled(WORDS.placeLabel, "{[location] loc.name} ( {group} )", { loc: docked, group: typeName() }),
      };
    } else if (structure !== null) {
      error = "Saving a structure's place is not here yet.";
    } else if (status !== null && status.inSpace && status.shipID !== null) {
      const solarSystemID = status.solarSystemID;
      bookmarking = {
        itemID: status.shipID,
        askIfKnown: false,
        typeName: () => "",
        name: () => filled(WORDS.spot, "a spot in {solarSystemName}", { solarSystemName: solarSystemID === null ? "" : resolvedName($names.resolved, "system", solarSystemID, "") }),
      };
    } else {
      error = word(WORDS.notHere, "Be docked, or in a ship, to save where you are.");
    }
  }

  function bookmarkDone(made: boolean): void {
    bookmarking = null;
    if (made) void load();
  }

  /** The bookmarks chosen (the scroll's selection), the one whose menu is open, and the one being edited. */
  let selected = $state<readonly number[]>([]);
  let menuFor = $state<number | null>(null);
  let editing = $state<Bookmark | null>(null);
  let busy = $state(false);

  /** A click chooses the row; with Ctrl it is added to the choice, or taken out of it. */
  /** The row last chosen by a click with no Shift (the scroll's lastSelected), by its place among the window's rows. */
  let lastSelectedRow: number | null = null;

  /**
   * The scroll's SelectNode (carbonui/control/scroll.py, as PlaceEntry.OnClick asks it): a click chooses the row;
   * Ctrl adds it to the choice or takes it out; Shift chooses the rows from the one last chosen to it, Ctrl and Shift
   * adds them. The rows go in the window's order, as the scroll's nodes do.
   */
  function rowClick(event: MouseEvent, bookmarkID: number): void {
    const row = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const rows = row === null ? [] : [...(row.closest("section.locations")?.querySelectorAll<HTMLElement>("tr[data-bookmark-id]") ?? [])];
    const at = row === null ? -1 : rows.indexOf(row);
    const control = event.ctrlKey || event.metaKey;
    const ranged = (): number[] => {
      const [from, to] = (lastSelectedRow ?? at) < at ? [lastSelectedRow ?? at, at] : [at, lastSelectedRow ?? at];
      return rows.slice(from, to + 1).map((each) => Number(each.dataset.bookmarkId)).filter((id) => Number.isSafeInteger(id) && id > 0);
    };
    const anchored = event.shiftKey && lastSelectedRow !== null && lastSelectedRow !== at && at >= 0 && lastSelectedRow < rows.length;
    if (event.shiftKey && control) {
      if (anchored) selected = [...new Set([...selected, ...ranged()])];
    } else if (event.shiftKey) {
      // The range from the row last chosen; that row stays the one a later Shift goes from.
      if (anchored) {
        selected = [...new Set(ranged())];
        return;
      }
      selected = [bookmarkID];
    } else if (control) {
      selected = selected.includes(bookmarkID) ? selected.filter((id) => id !== bookmarkID) : [...selected, bookmarkID];
    } else {
      selected = [bookmarkID];
    }
    lastSelectedRow = at;
  }

  /**
   * Agent Missions (bookmarksPanel.py GetAgentPlacesScrollList and its sub-contents, 113 to 170): the journal's missions
   * that have bookmarks (journal.GetMyAgentJournalBookmarks), each a group by its name, holding its bookmarks as
   * bookmarkSvc.GetAgentBookmarks makes them (121 to 137).
   */
  const AGENT_MISSIONS = "agentMissions";
  const missionGroups = $derived(($agentsState.journal === null ? [] : [...$agentsState.journal.active, ...$agentsState.journal.offered])
    .filter((mission) => (mission.bookmarks ?? []).length > 0));

  /** A mission's name: its message (GetByMessageID), or its text where the journal has text. */
  function missionName(mission: JournalMission): string {
    if (typeof mission.missionTitle === "string") return mission.missionTitle;
    return mission.missionTitleID !== null ? word(`#${mission.missionTitleID}`, "") : "";
  }

  /** A mission's group, as the client keys it (the name's number and the agent, 146). */
  const missionKey = (mission: JournalMission): string => `mission:${mission.missionTitleID ?? mission.missionTitle ?? ""}:${mission.agentID}`;
  /** A mission's bookmark, as the client numbers it ('agentmissions', agentID, locationType, locationNumber). */
  const spotKey = (spot: MissionSpot): string => `${spot.agentID}:${spot.locationType}:${spot.locationNumber}`;

  /**
   * A mission's bookmark's hint as the client's journal words it (journal.py _UpdateMissionDataFull, 313 to 317):
   * GetByLabel(hint, location=locationID, index=locationNumber + 1).
   */
  const hintArgs = (spot: MissionSpot): TemplateArguments => ({ location: spot.locationID ?? spot.solarSystemID ?? 0, index: spot.locationNumber + 1 });
  const missionHint = (spot: MissionSpot): string => (spot.hint ? filled(spot.hint, spot.hint, hintArgs(spot)) : "");

  /** GetAgentBookmarks (121 to 137): a mission's bookmark as the window lists it, its memo the hint, no expiry, nobody's. */
  function agentBookmarkOf(spot: MissionSpot): Bookmark {
    return {
      bookmarkID: 0,
      folderID: 0,
      itemID: spot.itemID ?? null,
      typeID: spot.typeID ?? 5,
      memo: `${missionHint(spot)}\t`,
      note: "",
      created: spot.created ?? null,
      expiry: null,
      x: spot.x ?? null,
      y: spot.y ?? null,
      z: spot.z ?? null,
      locationID: spot.locationID ?? spot.solarSystemID ?? 0,
      subfolderID: null,
      creatorID: null,
    };
  }

  let missionMenuFor = $state<string | null>(null);

  function openMissionMenu(key: string): void {
    missionMenuFor = missionMenuFor === key ? null : key;
    menuFor = null;
    warpOpen = false;
    defaultOpen = false;
    if (missionMenuFor !== null && $flight.status?.inSpace === true) void flow.loadSpaceSnapshot().catch(() => {});
  }

  /** A mission's bookmark's warp and approach, asked of its agent (movementFunctions.py 397 to 421). */
  function moveMission(how: "warp" | "approach", spot: MissionSpot, range = 0): void {
    missionMenuFor = null;
    error = "";
    const order = how === "warp" ? flow.warpToMissionBookmark(spot, range) : flow.approachMissionBookmark(spot);
    void order.catch((cause) => {
      error = isSessionLost(cause) ? "Your session ended. Pick your character again." : panelErrorWords(cause);
    });
  }

  /** What a dragged row carries: the bookmarks' numbers. */
  const BOOKMARK_DRAG = "application/x-evejs-bookmarks";
  /** The folder or subfolder a drag is over, for its mark. */
  let dropOver = $state<string | null>(null);

  /** GetDragData (addressBookEntries.py 110 to 121): the rows chosen where the one dragged is among them, else it alone. */
  function dragStart(event: DragEvent, bookmarkID: number): void {
    const ids = selected.includes(bookmarkID) ? selected : [bookmarkID];
    if (event.dataTransfer === null) return;
    event.dataTransfer.setData(BOOKMARK_DRAG, JSON.stringify(ids));
    event.dataTransfer.effectAllowed = "copyMove";
  }

  function dragOver(event: DragEvent, key: string): void {
    if (event.dataTransfer === null || !event.dataTransfer.types.includes(BOOKMARK_DRAG)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = event.shiftKey ? "copy" : "move";
    dropOver = key;
  }

  /** DropInPlacesFolder (bookmarksPanel.py 69 to 80): the dragged bookmarks moved there, or copied where Shift is held. */
  function dropOn(event: DragEvent, folderID: number, subfolderID: number | null): void {
    dropOver = null;
    const raw = event.dataTransfer?.getData(BOOKMARK_DRAG) ?? "";
    if (raw === "") return;
    event.preventDefault();
    let ids: number[] = [];
    try {
      const parsed: unknown = JSON.parse(raw);
      ids = Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : [];
    } catch {
      ids = [];
    }
    if (ids.length > 0) moveOrCopyBookmarks(folderID, subfolderID, ids, event.shiftKey);
  }

  /**
   * bookmarkSvc.MoveOrCopyBookmarks (678 to 711): each bookmark not already there is copied where Shift is held or its
   * folder is one the pilot may not move from (not its own, managed or administered), else moved; a source folder's at
   * once; a message the server answers is shown; and the list read again.
   */
  function moveOrCopyBookmarks(folderID: number, subfolderID: number | null, ids: readonly number[], forceCopy: boolean): void {
    if (active === null) return;
    const moves = new Map<number, number[]>();
    const copies = new Map<number, number[]>();
    for (const id of new Set(ids)) {
      const bookmark = active.bookmarks.find((each) => each.bookmarkID === id);
      if (bookmark === undefined) continue;
      if (bookmark.subfolderID === subfolderID && bookmark.folderID === folderID) continue;
      const source = active.folders.find((each) => each.folderID === bookmark.folderID);
      const movable = source !== undefined && [ACCESS_PERSONAL, ACCESS_MANAGE, ACCESS_ADMIN].includes(source.accessLevel);
      const into = forceCopy || !movable ? copies : moves;
      into.set(bookmark.folderID, [...(into.get(bookmark.folderID) ?? []), id]);
    }
    if (moves.size === 0 && copies.size === 0) return;
    notice = "";
    void runAct(async () => {
      const said: string[] = [];
      const tell = (message: MovedOrCopied["message"]): void => {
        if (message === null) return;
        flow.requestWords([`dialog:${message.dialog}/body`]);
        const values = message.values !== null && typeof message.values === "object" ? message.values as TemplateArguments : {};
        said.push(filled(`dialog:${message.dialog}/body`, message.dialog, values));
      };
      for (const [oldFolderID, list] of moves) tell((await flow.moveBookmarks(oldFolderID, folderID, subfolderID, list)).message);
      for (const [oldFolderID, list] of copies) tell((await flow.copyBookmarks(oldFolderID, folderID, subfolderID, list)).message);
      await load();
      if (said.length > 0) notice = said.join(" ");
    });
  }

  /** The warp's submenu open, and its Set Default's. */
  let warpOpen = $state(false);
  let defaultOpen = $state(false);

  function openMenu(bookmarkID: number): void {
    if (!selected.includes(bookmarkID)) selected = [bookmarkID];
    menuFor = menuFor === bookmarkID ? null : bookmarkID;
    missionMenuFor = null;
    warpOpen = false;
    defaultOpen = false;
    // The client builds the menu from its ballpark as it is: the page reads space again for it.
    if (menuFor !== null && $flight.status?.inSpace === true) void flow.loadSpaceSnapshot().catch(() => {});
  }

  /**
   * What the bookmark's menu reads of a pilot flying in space (the client's session and ballpark): the flight's system
   * and ship, and the page's read of space where it is of that system; none for a pilot docked, or one the page has
   * not read.
   */
  const here = $derived.by((): SpaceHere | null => {
    const status = $flight.status;
    const snapshot = $space.snapshot;
    if (status === null || !status.inSpace || status.docked || status.solarSystemID === null || status.shipID === null) return null;
    if (snapshot === null || !snapshot.inSpace || snapshot.solarSystemID !== status.solarSystemID) return null;
    const ship = snapshot.ship;
    if (ship === null || ship.geometryAvailable === false) return null;
    const balls = new Map<number, SpaceBall>();
    for (const entity of snapshot.entities) {
      if (entity.isSelf || entity.geometryAvailable === false) continue;
      balls.set(entity.itemID, { position: entity.position, radius: entity.radius, typeID: entity.typeID, categoryID: entity.categoryID });
    }
    return {
      solarSystemID: status.solarSystemID,
      shipID: status.shipID,
      warping: (ship.mode ?? "").trim().toUpperCase() === "WARP",
      shipPosition: ship.position,
      shipRadius: ship.radius,
      balls,
    };
  });

  /** The pilot's own warp distance (defaultRangeUtils' WarpTo), which Warp to Within warps at. */
  const defaultWarp = $derived($warpDistance);
  const say = $derived(distanceSay($words.templates));

  /** Show Info (_BookmarkMenu, 1446 to 1450): the thing as the ballpark holds it, a map place as itself, else the bookmark's type. */
  function infoOf(bookmark: Bookmark): InfoSubject {
    const item = bookmark.itemID ?? bookmark.locationID;
    const ball = here?.balls.get(item);
    if (ball !== undefined) return { kind: "spaceObject", itemID: item, typeID: ball.typeID };
    // _BookmarkMenu's ShowInfo(typeID, itemID): a region's, constellation's or solar system's bookmark opens the place.
    if (bookmark.typeID >= 3 && bookmark.typeID <= 5) return { kind: "mapLocation", typeID: bookmark.typeID, itemID: item };
    return { kind: "type", typeID: bookmark.typeID };
  }

  /** The bookmark's place on the map (BookmarkChecker.GetMapIDs, 176 to 185): a station or a system itself, else the system it is in. */
  function mapPlaceOf(bookmark: Bookmark): number {
    const item = bookmark.itemID ?? bookmark.locationID;
    const isPlace = (item >= 10_000_000 && item < 40_000_000) || (item >= 60_000_000 && item < 64_000_000);
    return isPlace ? item : bookmark.locationID;
  }

  /** The part of BookmarkMenu the page offers for one bookmark, as BookmarkChecker offers each. */
  function menuOf(bookmark: Bookmark): {
    readonly dock: number | null;
    readonly warp: boolean;
    readonly approach: boolean;
    readonly align: boolean;
    readonly destination: number | null;
    readonly addWaypoint: number | null;
    readonly removeWaypoint: number | null;
    readonly edit: boolean;
  } {
    const item = bookmark.itemID ?? bookmark.locationID;
    const mapPlace = mapPlaceOf(bookmark);
    // The ballpark's moves: Dock (a station in the system), Warp to Within, Approach Location and Align to.
    const offers = spaceOffersOf(bookmark, here);
    // OfferSetDestination (1354 to 1362): not the system the pilot is in, nor the route's last waypoint.
    const status = $flight.status;
    const pilotSystem = status?.solarSystemID ?? $station.online?.solarSystemID ?? null;
    const waypoints = $waypointsState;
    const destination = pilotSystem !== item && waypoints[waypoints.length - 1] !== item ? mapPlace : null;
    // OfferAddWaypoint (440 to 445), else Remove Waypoint where the item is one (BookmarkMenu, 1503 to 1506).
    const isWaypoint = waypoints.includes(item);
    // OfferEditBookmark (bookmarkChecker.py 65 to 70; IsEditableWithCharacterRoles, 107 to 113): the folder's own,
    // managed or administered, or used and the bookmark the pilot's.
    const folder = active?.folders.find((each) => each.folderID === bookmark.folderID);
    const edit = folder !== undefined && ([1, 4, 5].includes(folder.accessLevel) || (folder.accessLevel === 3 && bookmark.creatorID === pilotID));
    return {
      dock: offers.dock ? item : null,
      warp: offers.warp,
      approach: offers.approach,
      align: offers.align,
      destination,
      addWaypoint: isWaypoint ? null : mapPlace,
      removeWaypoint: isWaypoint ? mapPlace : null,
      edit,
    };
  }

  /** Warp to Within, Approach Location and Align to: the page's own calls, as flight steps. */
  function move(how: "warp" | "approach" | "align", bookmarkID: number, range = 0): void {
    menuFor = null;
    error = "";
    const order = how === "warp" ? flow.warpToBookmark(bookmarkID, range) : how === "approach" ? flow.approachBookmark(bookmarkID) : flow.alignToBookmark(bookmarkID);
    void order.catch((cause) => {
      error = isSessionLost(cause) ? "Your session ended. Pick your character again." : panelErrorWords(cause);
    });
  }

  /** WarpToMenu's Set Default (defaultRangeUtils.SetDefaultWarpToDist): the pilot's own warp distance. */
  function setDefaultWarp(metres: number): void {
    flow.keepWarpDistance(metres);
    defaultOpen = false;
  }

  function dockAt(stationID: number): void {
    menuFor = null;
    error = "";
    void flow.dockAt(stationID).catch((cause) => {
      error = isSessionLost(cause) ? "Your session ended. Pick your character again." : panelErrorWords(cause);
    });
  }

  function route(how: "destination" | "add" | "remove", placeID: number): void {
    menuFor = null;
    if (how === "destination") flow.setDestination(placeID);
    else if (how === "add") flow.addWaypoint(placeID);
    else flow.clearWaypoints(placeID);
  }

  /** Edit Location and a row's double click (EditBookmark): the bookmark window on the bookmark. */
  function editBookmark(bookmark: Bookmark): void {
    menuFor = null;
    if (!menuOf(bookmark).edit) return;
    editing = bookmark;
  }

  function editDone(made: boolean): void {
    editing = null;
    if (made) void load();
  }

  /** The client's question waiting for an answer, what it says, and the removal it holds back. */
  let confirming = $state<{ readonly dialog: (typeof DIALOGS)[number]; readonly args: TemplateArguments; readonly act: () => Promise<void> } | null>(null);
  let dontAskAgain = $state(false);

  async function runAct(act: () => Promise<void>): Promise<void> {
    busy = true;
    error = "";
    try {
      await act();
    } catch (cause) {
      error = isSessionLost(cause) ? "Your session ended. Pick your character again." : panelErrorWords(cause);
    } finally {
      busy = false;
    }
  }

  /**
   * Remove Location (DeleteBookmarks, 452 to 473): RemoveLocation for one, RemoveMultipleLocation for several, unless
   * Yes is kept; then the bookmarks deleted folder by folder and the list read again; none deleted is the client's
   * CouldNotDeleteBookmark.
   */
  function askRemove(bookmarks: readonly Bookmark[]): void {
    menuFor = null;
    if (bookmarks.length === 0) return;
    const dialog = bookmarks.length === 1 ? "RemoveLocation" : "RemoveMultipleLocation";
    const args: TemplateArguments = bookmarks.length === 1 ? { locationName: unzipMemo(bookmarks[0]?.memo ?? "")[0] } : { numLocations: bookmarks.length };
    const act = async (): Promise<void> => {
      const deleted = await flow.deleteBookmarks(bookmarks.map((bookmark) => ({ bookmarkID: bookmark.bookmarkID, folderID: bookmark.folderID })));
      selected = [];
      await load();
      if (deleted.length === 0) error = word(WORDS.couldNotDelete, "Nothing was removed.");
    };
    ask(dialog, args, act);
  }

  /** The client's question (prompt_player_fsd_dialog with suppress=ID_YES): its Yes kept, or asked. */
  function ask(dialog: (typeof DIALOGS)[number], args: TemplateArguments, act: () => Promise<void>): void {
    if (ASKED_KEEPING_YES.has(dialog) && flow.dialogYesKept(dialog)) {
      void runAct(act);
      return;
    }
    dontAskAgain = false;
    confirming = { dialog, args, act };
  }

  function confirmed(): void {
    const waiting = confirming;
    confirming = null;
    if (waiting === null) return;
    // _persist_prompt_suppress_choice: Yes kept where the box was ticked.
    if (dontAskAgain && ASKED_KEEPING_YES.has(waiting.dialog)) flow.keepDialogYes(waiting.dialog);
    void runAct(waiting.act);
  }

  /** The folder and the subfolder whose menus are open, and the subfolder window: for a folder, or a subfolder's edit. */
  let folderMenuFor = $state<number | null>(null);
  let subfolderMenuFor = $state<number | null>(null);
  let subfolderWindow = $state<{ readonly folderID: number | null; readonly subfolder: Subfolder | null } | null>(null);

  function toggleFolderMenu(folderID: number): void {
    folderMenuFor = folderMenuFor === folderID ? null : folderID;
    subfolderMenuFor = null;
  }

  function toggleSubfolderMenu(subfolderID: number): void {
    subfolderMenuFor = subfolderMenuFor === subfolderID ? null : subfolderID;
    folderMenuFor = null;
  }

  /** BookmarkACLFolderMenu (320 to 338): the part the page offers. */
  function folderMenuOf(folder: BookmarkFolder): { readonly edit: boolean; readonly remove: boolean; readonly forget: boolean; readonly offline: boolean; readonly online: boolean; readonly createSubfolder: boolean } {
    const owns = folder.accessLevel === ACCESS_PERSONAL || folder.accessLevel === ACCESS_ADMIN;
    return {
      edit: owns,
      remove: owns,
      forget: !folder.isPersonal,
      offline: folder.isActive,
      online: !folder.isActive,
      createSubfolder: folder.isActive && folder.accessLevel !== ACCESS_VIEW,
    };
  }

  /** The folder window: a new folder's, or on a folder as the server has it; and what it says once a shared folder is made. */
  let folderWindow = $state<{ readonly folder: BookmarkFolder | null } | null>(null);
  let notice = $state("");

  /** Create Folder (window.py _create_acl_folder, 143 to 146), and the Yes of CreateBookmarkFolderAsNoneValid. */
  function createFolder(): void {
    folderMenuFor = null;
    notice = "";
    folderWindow = { folder: null };
  }

  /**
   * Edit Folder (EditACLFolder, 428 to 433): the folder read afresh (bookmarkSvc.GetBookmarkFolder with refresh,
   * GetFolderInfo; its online state the one the pilot has), then the folder window on it.
   */
  function editFolder(folder: BookmarkFolder): void {
    folderMenuFor = null;
    notice = "";
    void runAct(async () => {
      const read = await flow.readFolderInfo(folder.folderID);
      folderWindow = { folder: { ...read, isActive: folder.isActive } };
    });
  }

  function folderDone(made: boolean, said?: string): void {
    folderWindow = null;
    if (said !== undefined) notice = said;
    if (made) void load();
  }

  /** Folder Information (ShowBookmarkFolderInfo, 424 to 426), open on a folder the pilot knows. */
  let folderInfo = $state<{ readonly folder: BookmarkFolder; readonly known: boolean } | null>(null);

  function showFolderInfo(folder: BookmarkFolder): void {
    folderMenuFor = null;
    adminMenuFor = null;
    folderInfo = { folder, known: true };
  }

  /** Its Online Folder and Offline Folder (linkedBookmarkFolderWindow.py 177 to 185), which close it. */
  function folderInfoOnline(isActive: boolean): void {
    const shown = folderInfo;
    folderInfo = null;
    if (shown !== null) setFolderOnline(shown.folder, isActive);
  }

  /**
   * Shared Folders With Admin Access (bookmarksPanel.py GetAdminFoldersScrollList and GetAdminFolders, 587 to 634): the
   * folders the pilot may administer, read as the group opens and kept two minutes (the search's Memoize(2)); closed
   * whenever the window opens (ApplyAttributes: SetListGroupOpenState(adminFolderId, 0)).
   */
  const ADMIN_FOLDERS = "adminFolders";
  const ADMIN_KEPT_MS = 2 * 60 * 1000;
  let adminFolders = $state<{ readonly at: number; readonly folders: readonly BookmarkFolder[] } | null>(null);
  let adminMenuFor = $state<number | null>(null);

  function readAdminFolders(): void {
    if (adminFolders !== null && Date.now() - adminFolders.at < ADMIN_KEPT_MS) return;
    void flow.readFoldersWithAdminAccess().then((folders) => {
      adminFolders = { at: Date.now(), folders };
    }).catch((cause) => {
      error = isSessionLost(cause) ? "Your session ended. Pick your character again." : panelErrorWords(cause);
    });
  }

  /** An entry's words (GetAdminFolders, 612 to 620): Connected - Online or Offline, or Disconnected. */
  function adminState(folder: BookmarkFolder): string {
    const known = active?.folders.find((each) => each.folderID === folder.folderID);
    if (known === undefined) return word(WORDS.notSubscribed, "Not joined");
    return known.isActive ? word(WORDS.subscribedActive, "Joined, online") : word(WORDS.subscribedInactive, "Joined, offline");
  }

  /** ShowBookmarkFolderInfo for a folder the pilot does not know (546 to 562): read of the server, then the window to connect. */
  function connectInfo(folderID: number): void {
    adminMenuFor = null;
    notice = "";
    void runAct(async () => {
      const read = await flow.readFolderInfo(folderID);
      folderInfo = { folder: read, known: false };
    });
  }

  /** An entry's double click (OnDblClickAdminFolder, 641 to 647): a known folder's Edit Folder, another's connecting. */
  function adminDoubleClick(folder: BookmarkFolder): void {
    const known = active?.folders.find((each) => each.folderID === folder.folderID);
    if (known !== undefined) editFolder(known);
    else connectInfo(folder.folderID);
  }

  /**
   * Connect (LinkedBookmarkFolderWindow.AddFolder; bookmarkSvc.AddToKnownFolders, 350 to 370): nothing for a folder
   * known already; TooManyKnownFolders past the most the pilot may know; then the folder added, online or offline, and
   * FolderAddedAsInactiveFolder where it was asked online and came offline.
   */
  function connectFolder(isActive: boolean): void {
    const shown = folderInfo;
    folderInfo = null;
    if (shown === null || active === null) return;
    if (active.folders.some((each) => each.folderID === shown.folder.folderID)) return;
    if (active.folders.length >= MAX_KNOWN_FOLDERS) {
      error = filled(WORDS.tooManyKnown, "You know as many folders as you may ({[numeric]maxKnownFolders}).", { maxKnownFolders: MAX_KNOWN_FOLDERS });
      return;
    }
    void runAct(async () => {
      const added = await flow.addToKnownFolders(shown.folder.folderID, isActive);
      await load();
      if (isActive && added !== null && !added.isActive) notice = word(WORDS.addedOffline, "It was joined offline: you have as many folders online as you may.");
    });
  }

  /** Disconnect from Folder (ForgetFolder, 444 to 447): ConfirmForgetFolder, then the folder no longer known and the list read again. */
  function askForgetFolder(folder: BookmarkFolder): void {
    folderMenuFor = null;
    ask("ConfirmForgetFolder", {}, async () => {
      await flow.removeFromKnownFolders(folder.folderID);
      selected = [];
      await load();
    });
  }

  /** DeleteACLFolder (435 to 441): ConfirmDeleteFolder, then the folder deleted and the list read again. */
  function askDeleteFolder(folder: BookmarkFolder): void {
    folderMenuFor = null;
    ask("ConfirmDeleteFolder", {}, async () => {
      await flow.deleteFolder(folder.folderID);
      selected = [];
      await load();
    });
  }

  /**
   * Offline Folder and Online Folder (bookmarkSvc.UpdateFolderActiveState, 479 to 503); online only where the pilot
   * has fewer online of its kind than it may (ValidateActiveFolderCount, 505 to 515: TooManyActiveFolders).
   */
  function setFolderOnline(folder: BookmarkFolder, isActive: boolean): void {
    folderMenuFor = null;
    error = "";
    if (isActive && active !== null) {
      const online = active.folders.filter((each) => each.isPersonal === folder.isPersonal && each.isActive).length;
      if (online >= (folder.isPersonal ? MAX_ONLINE_PERSONAL : MAX_ONLINE_SHARED)) {
        error = filled(WORDS.tooManyOnline, "You have as many folders online as you may: {[numeric]maxPersonalFolders} of your own and {[numeric]maxSharedFolders} shared.",
          { maxPersonalFolders: MAX_ONLINE_PERSONAL, maxSharedFolders: MAX_ONLINE_SHARED });
        return;
      }
    }
    void runAct(async () => {
      await flow.setFolderActive(folder.folderID, isActive);
      await load();
    });
  }

  /** The folders a subfolder may be put in (bookmarkSvc.GetFilteredFolders, 535 to 544): online, more than viewed. */
  const subfolderFolders = $derived(active === null ? [] : active.folders.filter((folder) => folder.accessLevel !== ACCESS_VIEW && folder.isActive));

  /** Create Subfolder: from a folder's menu (CreateSubFolderInFolder, 457 to 461), or the bottom's (window.py 149 to 157). */
  function createSubfolderIn(folderID: number | null): void {
    folderMenuFor = null;
    if (folderID === null && subfolderFolders.length === 0) {
      // Its Yes opens the folder window for a new folder.
      ask("CreateBookmarkFolderAsNoneValid", {}, async () => createFolder());
      return;
    }
    subfolderWindow = { folderID, subfolder: null };
  }

  /** BookmarkSubfolderMenu (408 to 417): where the pilot may write to the folder and, using it only, made the subfolder. */
  function subfolderMenuOf(subfolder: Subfolder): { readonly edit: boolean; readonly remove: boolean } {
    const folder = active?.folders.find((each) => each.folderID === subfolder.folderID);
    const may = folder !== undefined && folder.accessLevel !== ACCESS_VIEW && (folder.accessLevel !== ACCESS_USE || subfolder.creatorID === pilotID);
    return { edit: may && subfolder.creatorID !== OWNER_SYSTEM, remove: may };
  }

  function editSubfolder(subfolder: Subfolder): void {
    subfolderMenuFor = null;
    subfolderWindow = { folderID: subfolder.folderID, subfolder };
  }

  function subfolderDone(made: boolean): void {
    subfolderWindow = null;
    if (made) void load();
  }

  /**
   * DeleteSubfolder (481 to 487; bookmarkSvc.DeleteSubfolder, 579 to 597): ConfirmDeleteSubfolder, then the subfolder
   * deleted with its bookmarks; where the pilot only uses the folder and another's bookmark is in it, the client's
   * CouldNotDeleteBookmarksInSubfolder and nothing asked of the server.
   */
  function askDeleteSubfolder(subfolder: Subfolder): void {
    subfolderMenuFor = null;
    error = "";
    ask("ConfirmDeleteSubfolder", {}, async () => {
      const folder = active?.folders.find((each) => each.folderID === subfolder.folderID);
      if (folder?.accessLevel === ACCESS_USE && active !== null
        && active.bookmarks.some((bookmark) => bookmark.subfolderID === subfolder.subfolderID && bookmark.creatorID !== pilotID)) {
        error = word(WORDS.othersInSubfolder, "Others' places are in that subfolder: it stays.");
        return;
      }
      await flow.deleteSubfolder(subfolder.folderID, subfolder.subfolderID);
      selected = [];
      await load();
    });
  }

  const chosenBookmarks = $derived(active === null ? [] : active.bookmarks.filter((bookmark) => selected.includes(bookmark.bookmarkID)));

  async function load(): Promise<void> {
    error = "";
    try {
      active = await flow.readLocations();
    } catch (cause) {
      error = isSessionLost(cause) ? "Your session ended. Pick your character again." : cause instanceof Error ? cause.message : String(cause);
    }
  }

  onMount(() => {
    flow.requestWords([...Object.values(WORDS), ...DISTANCE_WORD_LABELS, DO_NOT_ASK_AGAIN_LABEL, ...DIALOGS.flatMap((name) => [`dialog:${name}/title`, `dialog:${name}/body`, suppressableKey(name)])]);
    void load();
    // The Agent Missions group's bookmarks are the journal's, as the window is built (GetAgentPlacesScrollList).
    void flow.loadJournal().catch(() => {});
  });

  // What the missions' groups and rows name: the missions' names, and their bookmarks' systems, constellations,
  // regions and types' groups, and the jumps to their systems.
  $effect(() => {
    const labels: string[] = [];
    const refs: NameRef[] = [];
    const systems = new Set<number>();
    for (const mission of missionGroups) {
      if (mission.missionTitleID !== null) labels.push(`#${mission.missionTitleID}`);
      for (const spot of mission.bookmarks ?? []) {
        // The hint's label, and what its words name once they are to hand.
        if (spot.hint) {
          labels.push(spot.hint);
          const template = $words.templates[spot.hint];
          if (typeof template === "string") refs.push(...templateNameRefs(template, hintArgs(spot)));
        }
        const bookmark = agentBookmarkOf(spot);
        const sol = solSystemOf(bookmark);
        if (sol !== null) refs.push({ kind: "system", id: sol }, { kind: "systemConstellation", id: sol }, { kind: "systemRegion", id: sol });
        const jumpsTo = jumpsSystemOf(bookmark);
        if (jumpsTo !== null) systems.add(jumpsTo);
        refs.push({ kind: "typeGroup", id: bookmark.typeID });
      }
    }
    if (labels.length > 0) flow.requestWords(labels);
    if (refs.length > 0) flow.requestNames(refs);
    if (systemID !== null && systems.size > 0) flow.requestAutopilotJumps(systemID, [...systems]);
  });

  // What the rows name: their systems, the systems' constellations and regions, their types' groups, their makers;
  // the jumps to their systems; and the system subfolders' labels.
  $effect(() => {
    if (active === null) return;
    const refs: NameRef[] = [];
    const systems = new Set<number>();
    for (const bookmark of active.bookmarks) {
      const sol = solSystemOf(bookmark);
      if (sol !== null) refs.push({ kind: "system", id: sol }, { kind: "systemConstellation", id: sol }, { kind: "systemRegion", id: sol });
      const jumpsTo = jumpsSystemOf(bookmark);
      if (jumpsTo !== null) systems.add(jumpsTo);
      refs.push({ kind: "typeGroup", id: bookmark.typeID });
      if (bookmark.creatorID !== null) refs.push({ kind: "owner", id: bookmark.creatorID });
    }
    for (const subfolder of active.subfolders) {
      if (subfolder.creatorID !== null && subfolder.creatorID !== 1) refs.push({ kind: "owner", id: subfolder.creatorID });
    }
    if (systemID !== null) refs.push({ kind: "system", id: systemID });
    if (refs.length > 0) flow.requestNames(refs);
    if (systemID !== null && systems.size > 0) flow.requestAutopilotJumps(systemID, [...systems]);
    const systemLabels = active.subfolders.filter((subfolder) => subfolder.creatorID === 1).map((subfolder) => subfolder.subfolderName);
    if (systemLabels.length > 0) flow.requestWords(systemLabels);
  });

  /** A subfolder's line (GetSubfolderEntry, 345 to 351): the system's by its label, another's with its maker. */
  function subfolderLine(subfolder: Subfolder): string {
    if (subfolder.creatorID === null || subfolder.creatorID === 1) return subfolderNameOf(subfolder, label);
    return filled(WORDS.folderName, "{folderName} ({[character]creator.name})", { folderName: subfolder.subfolderName, creator: subfolder.creatorID });
  }

  function dateText(filetime: bigint | null): string {
    return filetime === null ? "-" : filled(WORDS.dateTime, "{[datetime]datetime}", { datetime: String(filetime) });
  }

  /** A bookmark's line (GetPlacesScrollList, 502 to 528). */
  function rowOf(bookmark: Bookmark): { readonly cells: readonly string[]; readonly hint: string } {
    const [hint] = unzipMemo(bookmark.memo);
    const type = isCoordinateBookmark(bookmark) ? word(WORDS.coordinate, "Coordinate") : resolvedName($names.resolved, "typeGroup", bookmark.typeID, "");
    const jumpsTo = jumpsSystemOf(bookmark);
    let jumps = "0";
    if (jumpsTo !== null && systemID !== null) {
      const count = $names.autopilotJumps[`${systemID}:${jumpsTo}`];
      jumps = count === undefined ? "" : count === null ? word(WORDS.unreachable, "No route") : String(count);
    }
    const sol = solSystemOf(bookmark);
    const cells = [
      hint,
      type,
      jumps,
      sol === null ? "-" : resolvedName($names.resolved, "system", sol, "-"),
      sol === null ? "-" : resolvedName($names.resolved, "systemConstellation", sol, "-"),
      sol === null ? "-" : resolvedName($names.resolved, "systemRegion", sol, "-"),
      dateText(bookmark.created),
      bookmark.expiry === null ? "-" : dateText(bookmark.expiry),
      bookmark.creatorID === null ? "" : resolvedName($names.resolved, "owner", bookmark.creatorID, ""),
    ];
    const note = bookmark.note.length > 50 ? `${bookmark.note.slice(0, 50)}...` : bookmark.note;
    return { cells, hint: note === "" ? hint : `${hint}\n- ${note}` };
  }

  const HEADERS = [
    [WORDS.label, "Label"], [WORDS.type, "Type"], [WORDS.jumps, "Jumps"], [WORDS.sol, "SOL"], [WORDS.con, "CON"],
    [WORDS.reg, "REG"], [WORDS.date, "Date"], [WORDS.expiry, "Expiry"], [WORDS.creator, "Creator"],
  ] as const;
  /** On the play page the window as locations/window.py lays it out: the header's tabs, the buttons at the bottom right. */
  const retail = getContext("retailChrome") === true;
  let locTab = $state<"locations" | "search">("locations");
  $effect(() => { if (retail) flow.requestWords(["UI/Common/Search"]); });
</script>

{#snippet places(list: readonly Bookmark[], depth: number)}
  {#if list.length > 0}
    <div class="table-wrap overflow-x-auto" style={`padding-left: ${depth * 1.25}rem`}>
      <table class="guests locations-places">
        <thead>
          <tr>
            {#each HEADERS as [path, own] (path)}
              <th>{word(path, own)}</th>
            {/each}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each list as bookmark (bookmark.bookmarkID)}
            {@const row = rowOf(bookmark)}
            <tr
              title={row.hint}
              class:locations-chosen={selected.includes(bookmark.bookmarkID)}
              data-bookmark-id={bookmark.bookmarkID}
              draggable="true"
              class:locations-drop={dropOver === `row:${bookmark.bookmarkID}`}
              ondragstart={(event) => dragStart(event, bookmark.bookmarkID)}
              ondragover={(event) => dragOver(event, `row:${bookmark.bookmarkID}`)}
              ondragleave={() => { if (dropOver === `row:${bookmark.bookmarkID}`) dropOver = null; }}
              ondrop={(event) => dropOn(event, bookmark.folderID, bookmark.subfolderID)}
              onclick={(event) => rowClick(event, bookmark.bookmarkID)}
              ondblclick={() => editBookmark(bookmark)}
            >
              {#each row.cells as cell, at (at)}
                <td class:num={at === 2}>{cell}</td>
              {/each}
              <td>
                <button
                  type="button"
                  class="minor"
                  aria-label="Menu"
                  aria-expanded={menuFor === bookmark.bookmarkID}
                  onclick={(event) => { event.stopPropagation(); openMenu(bookmark.bookmarkID); }}
                >⋯</button>
              </td>
            </tr>
            {#if menuFor === bookmark.bookmarkID}
              <!-- The bookmark's menu (PlaceEntry.GetMenu): several chosen, Remove Location alone; one, the part of
                   BookmarkMenu the page offers, in its order. -->
              <tr class="locations-menu">
                <td colspan="10">
                  <p class="controls">
                    {#if selected.length > 1 && selected.includes(bookmark.bookmarkID)}
                      <button type="button" class="minor" disabled={busy} onclick={() => askRemove(chosenBookmarks)}>{word(WORDS.removeBookmark, "Take them off")}</button>
                    {:else}
                      {@const menu = menuOf(bookmark)}
                      <button type="button" class="minor" onclick={() => { menuFor = null; showInfo(infoOf(bookmark)); }}>{word(WORDS.showInfo, "About it")}</button>
                      {#if menu.dock !== null}
                        <button type="button" class="minor" onclick={() => menu.dock !== null && dockAt(menu.dock)}>{word(WORDS.dock, "Dock there")}</button>
                      {/if}
                      {#if menu.warp}
                        <!-- Warp to Within (WarpToMenuEntryData): at the pilot's own warp distance, shown beside it;
                             its submenu (WarpToMenu) the seven distances and Set Default. -->
                        <button type="button" class="minor" onclick={() => move("warp", bookmark.bookmarkID, defaultWarp)}>{filled(WORDS.withDistance, "{actionName} ({distanceString})", { actionName: word(WORDS.warpToWithin, "Warp there"), distanceString: fmtDist(defaultWarp, 2, say) })}</button>
                        <button type="button" class="minor" aria-label={word(WORDS.warpToWithin, "Warp there")} aria-expanded={warpOpen} onclick={() => { warpOpen = !warpOpen; defaultOpen = false; }}>{warpOpen ? "▾" : "▸"}</button>
                      {/if}
                      {#if menu.approach}
                        <button type="button" class="minor" onclick={() => move("approach", bookmark.bookmarkID)}>{word(WORDS.approachLocation, "Fly there")}</button>
                      {/if}
                      {#if menu.align}
                        <button type="button" class="minor" onclick={() => move("align", bookmark.bookmarkID)}>{word(WORDS.alignTo, "Line up with it")}</button>
                      {/if}
                      {#if menu.destination !== null}
                        <button type="button" class="minor" onclick={() => menu.destination !== null && route("destination", menu.destination)}>{word(WORDS.setDestination, "Head there")}</button>
                      {/if}
                      {#if menu.addWaypoint !== null}
                        <button type="button" class="minor" onclick={() => menu.addWaypoint !== null && route("add", menu.addWaypoint)}>{word(WORDS.addWaypoint, "Put on the route")}</button>
                      {:else if menu.removeWaypoint !== null}
                        <button type="button" class="minor" onclick={() => menu.removeWaypoint !== null && route("remove", menu.removeWaypoint)}>{word(WORDS.removeWaypoint, "Take off the route")}</button>
                      {/if}
                      {#if menu.edit}
                        <button type="button" class="minor" disabled={busy} onclick={() => editBookmark(bookmark)}>{word(WORDS.editBookmark, "Change it")}</button>
                        <button type="button" class="minor" disabled={busy} onclick={() => askRemove([bookmark])}>{word(WORDS.removeBookmark, "Take it off")}</button>
                      {/if}
                    {/if}
                  </p>
                  {#if warpOpen && !(selected.length > 1 && selected.includes(bookmark.bookmarkID)) && menuOf(bookmark).warp}
                    {@render warpSubmenu((range) => move("warp", bookmark.bookmarkID, range))}
                  {/if}
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/snippet}

{#snippet warpSubmenu(go: (range: number) => void)}
  <!-- WarpToMenu (menusvc.py 2254 to 2274): each of the seven distances, then Set Default's. -->
  <p class="controls locations-submenu" aria-label={word(WORDS.warpToWithin, "Warp there")}>
    {#each WARP_RANGES as choice (choice.metres)}
      <button type="button" class="minor" onclick={() => go(choice.metres)}>{filled(WORDS.within, "Stop {distance} short", { distance: fmtDist(choice.metres, 2, say) })}</button>
    {/each}
    <button type="button" class="minor" aria-expanded={defaultOpen} onclick={() => (defaultOpen = !defaultOpen)}>{word(WORDS.setDefault, "Usual distance")} {defaultOpen ? "▾" : "▸"}</button>
  </p>
  {#if defaultOpen}
    <p class="controls locations-submenu" aria-label={word(WORDS.setDefault, "Usual distance")}>
      {#each WARP_RANGES as choice (choice.metres)}
        <button type="button" class="minor" aria-pressed={choice.metres === defaultWarp} onclick={() => setDefaultWarp(choice.metres)}>{fmtDist(choice.metres, 2, say)}</button>
      {/each}
    </p>
  {/if}
{/snippet}

{#snippet missionPlaces(list: readonly MissionSpot[], depth: number)}
  <!-- A mission's bookmarks (GetPlacesSubContent_AgentMissions2 and GetPlacesScrollList): the window's columns, each
       row's menu the part of BookmarkMenu the page offers for an agent's bookmark (no Align to, no Edit or Remove;
       the warp and the approach asked of the agent). -->
  <div class="table-wrap overflow-x-auto" style={`padding-left: ${depth * 1.25}rem`}>
    <table class="guests locations-places">
      <thead>
        <tr>
          {#each HEADERS as [path, own] (path)}
            <th>{word(path, own)}</th>
          {/each}
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each list as spot (spotKey(spot))}
          {@const key = spotKey(spot)}
          {@const bookmark = agentBookmarkOf(spot)}
          {@const row = rowOf(bookmark)}
          <tr title={row.hint}>
            {#each row.cells as cell, at (at)}
              <td class:num={at === 2}>{cell}</td>
            {/each}
            <td>
              <button type="button" class="minor" aria-label="Menu" aria-expanded={missionMenuFor === key} onclick={() => openMissionMenu(key)}>⋯</button>
            </td>
          </tr>
          {#if missionMenuFor === key}
            {@const menu = menuOf(bookmark)}
            <tr class="locations-menu">
              <td colspan="10">
                <p class="controls">
                  <button type="button" class="minor" onclick={() => { missionMenuFor = null; showInfo(infoOf(bookmark)); }}>{word(WORDS.showInfo, "About it")}</button>
                  {#if menu.dock !== null}
                    <button type="button" class="minor" onclick={() => { missionMenuFor = null; if (menu.dock !== null) dockAt(menu.dock); }}>{word(WORDS.dock, "Dock there")}</button>
                  {/if}
                  {#if menu.warp}
                    {#if spot.deadspace}
                      <!-- A deadspace site's: Warp to Location, at the pilot's own warp distance (_BookmarkMenu, 1483). -->
                      <button type="button" class="minor" onclick={() => moveMission("warp", spot, defaultWarp)}>{word(WORDS.warpToBookmark, "Warp there")}</button>
                    {:else}
                      <button type="button" class="minor" onclick={() => moveMission("warp", spot, defaultWarp)}>{filled(WORDS.withDistance, "{actionName} ({distanceString})", { actionName: word(WORDS.warpToWithin, "Warp there"), distanceString: fmtDist(defaultWarp, 2, say) })}</button>
                      <button type="button" class="minor" aria-label={word(WORDS.warpToWithin, "Warp there")} aria-expanded={warpOpen} onclick={() => { warpOpen = !warpOpen; defaultOpen = false; }}>{warpOpen ? "▾" : "▸"}</button>
                    {/if}
                  {/if}
                  {#if menu.approach}
                    <button type="button" class="minor" onclick={() => moveMission("approach", spot)}>{word(WORDS.approachLocation, "Fly there")}</button>
                  {/if}
                  {#if menu.destination !== null}
                    <button type="button" class="minor" onclick={() => { missionMenuFor = null; if (menu.destination !== null) route("destination", menu.destination); }}>{word(WORDS.setDestination, "Head there")}</button>
                  {/if}
                  {#if menu.addWaypoint !== null}
                    <button type="button" class="minor" onclick={() => { missionMenuFor = null; if (menu.addWaypoint !== null) route("add", menu.addWaypoint); }}>{word(WORDS.addWaypoint, "Put on the route")}</button>
                  {:else if menu.removeWaypoint !== null}
                    <button type="button" class="minor" onclick={() => { missionMenuFor = null; if (menu.removeWaypoint !== null) route("remove", menu.removeWaypoint); }}>{word(WORDS.removeWaypoint, "Take off the route")}</button>
                  {/if}
                </p>
                {#if warpOpen && menu.warp && !spot.deadspace}
                  {@render warpSubmenu((range) => moveMission("warp", spot, range))}
                {/if}
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/snippet}

{#snippet folderMenuButton(folder: BookmarkFolder)}
  <button type="button" class="minor" aria-label="Folder menu" aria-expanded={folderMenuFor === folder.folderID} onclick={() => toggleFolderMenu(folder.folderID)}>⋯</button>
{/snippet}

{#snippet folderMenu(folder: BookmarkFolder, depth: number)}
  {#if folderMenuFor === folder.folderID}
    <!-- BookmarkACLFolderMenu, in its order: Folder Information, Edit Folder, Delete Folder, Disconnect from Folder,
         Offline Folder and Create Subfolder, or Online Folder. -->
    {@const menu = folderMenuOf(folder)}
    <p class="controls locations-submenu" style={`margin-left: ${depth * 1.25 + 1.5}rem`}>
      <button type="button" class="minor" onclick={() => showFolderInfo(folder)}>{word(WORDS.folderInformation, "About it")}</button>
      {#if menu.edit}
        <button type="button" class="minor" disabled={busy || folderWindow !== null} onclick={() => editFolder(folder)}>{word(WORDS.editFolder, "Change it")}</button>
      {/if}
      {#if menu.remove}
        <button type="button" class="minor" disabled={busy} onclick={() => askDeleteFolder(folder)}>{word(WORDS.deleteFolder, "Throw it away")}</button>
      {/if}
      {#if menu.forget}
        <button type="button" class="minor" disabled={busy} onclick={() => askForgetFolder(folder)}>{word(WORDS.forgetFolder, "Let it go")}</button>
      {/if}
      {#if menu.offline}
        <button type="button" class="minor" disabled={busy} onclick={() => setFolderOnline(folder, false)}>{word(WORDS.offlineFolder, "Take it offline")}</button>
      {/if}
      {#if menu.createSubfolder}
        <button type="button" class="minor" onclick={() => createSubfolderIn(folder.folderID)}>{word(WORDS.createSubfolder, "Make a subfolder")}</button>
      {/if}
      {#if menu.online}
        <button type="button" class="minor" disabled={busy} onclick={() => setFolderOnline(folder, true)}>{word(WORDS.onlineFolder, "Bring it online")}</button>
      {/if}
    </p>
  {/if}
{/snippet}

{#snippet subfolderMenu(subfolder: Subfolder, depth: number)}
  {@const menu = subfolderMenuOf(subfolder)}
  {#if menu.edit || menu.remove}
    <button type="button" class="minor" aria-label="Subfolder menu" aria-expanded={subfolderMenuFor === subfolder.subfolderID} onclick={() => toggleSubfolderMenu(subfolder.subfolderID)}>⋯</button>
  {/if}
  {#if subfolderMenuFor === subfolder.subfolderID}
    <!-- BookmarkSubfolderMenu: Edit Subfolder and Delete Subfolder. -->
    <p class="controls locations-submenu" style={`margin-left: ${depth * 1.25 + 1.5}rem`}>
      {#if menu.edit}
        <button type="button" class="minor" onclick={() => editSubfolder(subfolder)}>{word(WORDS.editSubfolder, "Rename it")}</button>
      {/if}
      {#if menu.remove}
        <button type="button" class="minor" disabled={busy} onclick={() => askDeleteSubfolder(subfolder)}>{word(WORDS.deleteSubfolder, "Throw it away")}</button>
      {/if}
    </p>
  {/if}
{/snippet}

{#snippet groupHead(id: string, line: string, count: number | null, depth: number, hint: string | null)}
  <button
    type="button"
    class="minor locations-group"
    style={`margin-left: ${depth * 1.25}rem`}
    aria-expanded={isOpen(id)}
    title={hint ?? undefined}
    onclick={() => toggle(id)}
  >
    {isOpen(id) ? "▾" : "▸"} {line}{#if count !== null}{" "}<span class="note">[{count}]</span>{/if}
  </button>
{/snippet}

<section class="panel locations" class:loc-retail={retail} class:loc-search={retail && locTab === "search"}>
  {#if retail}
    <!-- locations/window.py: the header's tabs Locations and Search -->
    <nav class="tabs loc-tabs">
      <button type="button" class:active={locTab === "locations"} onclick={() => (locTab = "locations")}>{word(WORDS.title, "Locations")}</button>
      <button type="button" class:active={locTab === "search"} onclick={() => (locTab = "search")}>{word("UI/Common/Search", "Search")}</button>
    </nav>
    {#if locTab === "search"}<p class="note">This panel is not on the play page yet.</p>{/if}
  {/if}
  <header class="panel-head">
    <h2 class="panel-title">{word(WORDS.title, "Locations")}</h2>
  </header>
  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if confirming !== null}
    <!-- The client's question before a removal: its title and body, the box that keeps Yes where the install lets it,
         Yes and No. -->
    {@const own = OWN_QUESTIONS[confirming.dialog]}
    <div class="bookmark-confirm" role="alertdialog" aria-label={filled(`dialog:${confirming.dialog}/title`, own[0], {})}>
      <strong>{filled(`dialog:${confirming.dialog}/title`, own[0], {})}</strong>
      <p>{filled(`dialog:${confirming.dialog}/body`, own[1], confirming.args)}</p>
      {#if $words.templates[suppressableKey(confirming.dialog)] === "1"}
        <label><input type="checkbox" bind:checked={dontAskAgain} /> {word(DO_NOT_ASK_AGAIN_LABEL, "Skip this question from now on")}</label>
      {/if}
      <p class="controls">
        <button type="button" disabled={busy} onclick={confirmed}>{word(WORDS.yes, "Yes")}</button>
        <button type="button" class="minor" onclick={() => (confirming = null)}>{word(WORDS.no, "No")}</button>
      </p>
    </div>
  {/if}
  {#if bookmarking !== null}
    <BookmarkWindow {store} {flow} place={bookmarking} onDone={bookmarkDone} onCreateFolder={active === null ? null : createFolder} />
  {/if}
  {#if editing !== null}
    <BookmarkWindow {store} {flow} editing={editing} onDone={editDone} />
  {/if}
  {#if subfolderWindow !== null && active !== null}
    <SubfolderWindow {store} {flow} {active} folderID={subfolderWindow.folderID} subfolder={subfolderWindow.subfolder} onDone={subfolderDone} />
  {/if}
  {#if folderWindow !== null && active !== null}
    <FolderWindow {store} {flow} {active} folder={folderWindow.folder} onDone={folderDone} />
  {/if}
  {#if folderInfo !== null && active !== null}
    {#key `${folderInfo.folder.folderID}:${folderInfo.known}`}
      <FolderInfoWindow {store} {flow} {active} folder={folderInfo.folder} known={folderInfo.known} onSetOnline={folderInfoOnline} onConnect={connectFolder} onClose={() => (folderInfo = null)} />
    {/key}
  {/if}
  {#if notice}
    <p class="note">{notice}</p>
  {/if}
  <!-- The window's bottom (window.py 104 to 110): Add Location, Create Folder and Create Subfolder. -->
  <p class="controls loc-bottom">
    <button type="button" class="minor" disabled={bookmarking !== null} onclick={addLocation}>{word(WORDS.addBookmark, "Save where I am")}</button>
    <button type="button" class="minor" disabled={folderWindow !== null || active === null} onclick={createFolder}>{word(WORDS.createFolder, "Make a folder")}</button>
    <button type="button" class="minor" disabled={subfolderWindow !== null || active === null} onclick={() => createSubfolderIn(null)}>{word(WORDS.createSubfolder, "Make a subfolder")}</button>
  </p>
  {#if active === null}
    {#if !error}<p class="note">…</p>{/if}
  {:else}
    <div class="locations-list">
      {@render groupHead("localLocations", filled(WORDS.inSystem, "Here in {system}", { system: systemID === null ? "" : resolvedName($names.resolved, "system", systemID, "") }), null, 0, null)}
      {#if isOpen("localLocations")}
        {@render places(local, 1)}
      {/if}
      {#each sections as section (section.isPersonal)}
        {@const sectionID = section.isPersonal ? "personalFolders" : "sharedFolders"}
        {@render groupHead(sectionID, section.isPersonal ? word(WORDS.personal, "My places") : word(WORDS.shared, "Places shared with me"), section.count, 0, null)}
        {#if isOpen(sectionID)}
          {#each section.folders as entry (entry.folder.folderID)}
            {@const folderKey = `folder:${entry.folder.folderID}`}
            <!-- A folder takes bookmarks dropped on it (its entry's DropData, DropInPlacesFolder). -->
            <div
              class="locations-head"
              class:locations-drop={dropOver === folderKey}
              role="group"
              ondragover={(event) => dragOver(event, folderKey)}
              ondragleave={() => { if (dropOver === folderKey) dropOver = null; }}
              ondrop={(event) => dropOn(event, entry.folder.folderID, null)}
            >
              {@render groupHead(folderKey, entry.folder.folderName, entry.count, 1, null)}
              {@render folderMenuButton(entry.folder)}
            </div>
            {@render folderMenu(entry.folder, 1)}
            {#if isOpen(folderKey)}
              {#each entry.subfolders as sub (sub.subfolder.subfolderID)}
                {@const subKey = `subfolder:${sub.subfolder.subfolderID}`}
                <!-- A subfolder takes them too (GetSubfolderEntry's DropData). -->
                <div
                  class="locations-head"
                  class:locations-drop={dropOver === subKey}
                  role="group"
                  ondragover={(event) => dragOver(event, subKey)}
                  ondragleave={() => { if (dropOver === subKey) dropOver = null; }}
                  ondrop={(event) => dropOn(event, sub.subfolder.folderID, sub.subfolder.subfolderID)}
                >
                  {@render groupHead(subKey, subfolderLine(sub.subfolder), sub.bookmarks.length, 2, null)}
                  {@render subfolderMenu(sub.subfolder, 2)}
                </div>
                {#if isOpen(subKey)}
                  {@render places(sub.bookmarks, 3)}
                {/if}
              {/each}
              {@render places(entry.loose, 2)}
            {/if}
          {/each}
          {#if section.inactive.length > 0}
            {@const inactiveKey = `inactive:${section.isPersonal ? "personal" : "shared"}`}
            {@render groupHead(inactiveKey, word(WORDS.inactive, "Folders offline"), null, 1, null)}
            {#if isOpen(inactiveKey)}
              <ul class="locations-inactive" style="padding-left: 2.5rem">
                {#each section.inactive as folder (folder.folderID)}
                  <li title={folder.isPersonal ? word(WORDS.personalFolder, "Yours") : word(WORDS.sharedFolder, "Shared")}>
                    {folder.folderName}
                    {@render folderMenuButton(folder)}
                    {@render folderMenu(folder, 0)}
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}
          {#if !section.isPersonal}
            <!-- Shared Folders With Admin Access (GetAdminFoldersScrollList): each folder by name and its state; a
                 known one's Folder Information and Disconnect from Folder, another's Connect (ShowMenuAdminFolders). -->
            {@render groupHead(ADMIN_FOLDERS, word(WORDS.adminFolders, "Shared folders you run"), null, 1, word(WORDS.adminFoldersHint, ""))}
            {#if isOpen(ADMIN_FOLDERS)}
              <ul class="locations-inactive" style="padding-left: 2.5rem">
                {#if adminFolders === null}
                  <li class="note">…</li>
                {:else if adminFolders.folders.length === 0}
                  <li>{word(WORDS.noAdminFolder, "None found")}</li>
                {:else}
                  {#each adminFolders.folders as folder (folder.folderID)}
                    {@const known = active?.folders.find((each) => each.folderID === folder.folderID)}
                    {@const state = adminState(folder)}
                    <li title={state} ondblclick={() => adminDoubleClick(folder)}>
                      {folder.folderName} <span class="note">[{state}]</span>
                      <button type="button" class="minor" aria-label="Folder menu" aria-expanded={adminMenuFor === folder.folderID}
                        onclick={() => { adminMenuFor = adminMenuFor === folder.folderID ? null : folder.folderID; folderMenuFor = null; }}>⋯</button>
                      {#if adminMenuFor === folder.folderID}
                        <p class="controls locations-submenu">
                          {#if known !== undefined}
                            <button type="button" class="minor" onclick={() => showFolderInfo(known)}>{word(WORDS.folderInformation, "About it")}</button>
                            <button type="button" class="minor" disabled={busy} onclick={() => { adminMenuFor = null; askForgetFolder(known); }}>{word(WORDS.forgetFolder, "Let it go")}</button>
                          {:else}
                            <button type="button" class="minor" disabled={busy} onclick={() => connectInfo(folder.folderID)}>{word(WORDS.connect, "Join")}</button>
                          {/if}
                        </p>
                      {/if}
                    </li>
                  {/each}
                {/if}
              </ul>
            {/if}
          {/if}
        {/if}
      {/each}
      <!-- Agent Missions (GetAgentPlacesScrollList): a group by each mission's name, holding its bookmarks. -->
      {@render groupHead(AGENT_MISSIONS, word(WORDS.agentMissions, "Mission places"), null, 0, null)}
      {#if isOpen(AGENT_MISSIONS)}
        {#each missionGroups as mission (missionKey(mission))}
          {@const key = missionKey(mission)}
          {@render groupHead(key, missionName(mission), null, 1, null)}
          {#if isOpen(key)}
            {@render missionPlaces(mission.bookmarks ?? [], 2)}
          {/if}
        {/each}
      {/if}
    </div>
  {/if}
</section>

<style>
  .locations-list {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.25rem;
  }
  .locations-group {
    text-align: left;
  }
  .locations-places td {
    white-space: nowrap;
  }
  /* A chosen row, marked by more than colour: its text is underlined. */
  .locations-chosen td {
    text-decoration: underline;
  }
  .locations-submenu {
    margin-left: 1.5rem;
  }
  /* A folder's or a subfolder's line, its menu's button beside it and the menu below. */
  .locations-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
  }
  .locations-head > .locations-submenu {
    flex-basis: 100%;
  }
  /* A folder or a subfolder a drag is over: outlined, not only coloured. */
  .locations-drop {
    outline: 2px dashed currentColor;
    outline-offset: 2px;
  }
  .bookmark-confirm {
    border: 1px solid currentColor;
    padding: 0.5rem;
    margin-bottom: 0.5rem;
  }
</style>
