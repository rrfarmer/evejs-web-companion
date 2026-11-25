// The Locations window's list, as the client builds it (neocom/addressBook/bookmarksPanel.py, in the Locations
// window, neocom/locations/window.py; the bookmarks from bookmarkSvc.py):
//
//   "Locations in <system>": the bookmarks whose place is the pilot's solar system (GetLocalLocationsScrollList,
//   221 to 225; GetBookmarksForLocationID, bookmarkSvc.py 81 to 92);
//   "Personal Locations [n]" and "Shared Locations [n]", n the bookmarks in their active folders
//   (GetFolderSectionList, 173 to 219), each holding its active folders by name with their counts, then
//   "Offline Folders" where some are not active (GetLocationFolderScrollList, 227 to 279);
//   a folder holding its subfolders by name with their counts, then its bookmarks in no subfolder
//   (GetPlacesSubfolders, 391 to 406; GetSubfolderEntry, 340 to 380);
//   a bookmark's row: its label (the memo's first part, UnzipMemo), its type's group or "Coordinate", the jumps to
//   its system, its system, constellation and region (GetSolConReg), when it was made and when it expires, and who
//   made it (GetPlacesScrollList, 491 to 544).
//
// What the client draws in a list with headers the page draws as a table; the rows here are what each line holds.

import type { ActiveBookmarks, Bookmark, BookmarkFolder, Subfolder } from "./bookmarks.ts";

/**
 * A place the bookmark window is opened for (addressbookService.py BookmarkLocationPopup, 405 to 421): its number;
 * the name of the type its popup is asked with (the "already saved" question's), and its default name
 * (GetDefaultLocationName, 423 to 441), each read when the window shows them; and whether a place already bookmarked
 * is asked about (not the pilot's own spot or system).
 */
export interface BookmarkPlace {
  readonly itemID: number;
  readonly typeName: () => string;
  readonly name: () => string;
  readonly askIfKnown: boolean;
  readonly requiresSpace?: boolean;
}

/** The most of a group's bookmarks the client lists (bookmarksPanel.py 41: MAX_BOOKMARKS_DISPLAYED_IN_GROUP). */
export const MAX_PLACES_IN_GROUP = 3000;

/** invConst.ownerSystem: a subfolder the system made is named by a label, not a name (bookmarkUtil.py 128 to 133). */
const OWNER_SYSTEM = 1;
/** const.typeSolarSystem. */
const TYPE_SOLAR_SYSTEM = 5;

const isSolarSystemID = (id: number | null): id is number => id !== null && id >= 30_000_000 && id < 40_000_000;

/** bookmarkSvc.UnzipMemo (144 to 154): the label and the comment a memo holds. */
export function unzipMemo(memo: string): readonly [string, string] {
  const parts = memo.includes("\t") ? memo.split("\t") : memo.split("||").map((each) => each.replace(/\\\|/g, "|"));
  return parts.length === 1 ? [parts[0] ?? "", ""] : [parts[0] ?? "", parts[1] ?? ""];
}

/** bookmarkUtil.IsCoordinateBookmark (114 to 115): a spot in space rather than a thing. */
export function isCoordinateBookmark(bookmark: Bookmark): boolean {
  return (bookmark.itemID === bookmark.locationID || bookmark.typeID === TYPE_SOLAR_SYSTEM) && Boolean(bookmark.x);
}

/** The system the Jumps column counts to (GetPlacesScrollList, 508 to 515): the item's where it is one, else its place's. */
export function jumpsSystemOf(bookmark: Bookmark): number | null {
  if (isSolarSystemID(bookmark.itemID)) return bookmark.itemID;
  return isSolarSystemID(bookmark.locationID) ? bookmark.locationID : null;
}

/** The system the SOL, CON and REG columns name (GetSolConReg, 354 to 374): the place where it is a system. */
export function solSystemOf(bookmark: Bookmark): number | null {
  return isSolarSystemID(bookmark.locationID) ? bookmark.locationID : null;
}

/** A subfolder's name (ConvertSubfolderName): a label for the system's own, else its name. */
export function subfolderNameOf(subfolder: Subfolder, label: (path: string) => string): string {
  return subfolder.creatorID === OWNER_SYSTEM ? label(subfolder.subfolderName) : subfolder.subfolderName;
}

export interface SubfolderPlaces {
  readonly subfolder: Subfolder;
  readonly bookmarks: readonly Bookmark[];
}

export interface FolderPlaces {
  readonly folder: BookmarkFolder;
  /** Every bookmark in the folder, in a subfolder or not. */
  readonly count: number;
  readonly subfolders: readonly SubfolderPlaces[];
  /** Its bookmarks in no subfolder. */
  readonly loose: readonly Bookmark[];
}

export interface LocationsSection {
  readonly isPersonal: boolean;
  /** The bookmarks in its active folders. */
  readonly count: number;
  readonly folders: readonly FolderPlaces[];
  /** Its folders that are not active, by name. */
  readonly inactive: readonly BookmarkFolder[];
}

const byLower = (a: string, b: string): number => a.toLowerCase().localeCompare(b.toLowerCase());

/** The bookmarks of a group, by their labels, as many as the client lists. */
export function placesInOrder(bookmarks: readonly Bookmark[]): readonly Bookmark[] {
  return [...bookmarks].sort((a, b) => byLower(unzipMemo(a.memo)[0], unzipMemo(b.memo)[0])).slice(0, MAX_PLACES_IN_GROUP);
}

/** GetLocalLocationsScrollList: the bookmarks whose place is the system. */
export function placesInSystem(active: ActiveBookmarks, solarSystemID: number | null): readonly Bookmark[] {
  return solarSystemID === null ? [] : placesInOrder(active.bookmarks.filter((bookmark) => bookmark.locationID === solarSystemID));
}

/** A folder's subfolders and bookmarks (GetPlacesSubfolders), the subfolders by their names. */
function folderPlaces(active: ActiveBookmarks, folder: BookmarkFolder, label: (path: string) => string): FolderPlaces {
  const inFolder = active.bookmarks.filter((bookmark) => bookmark.folderID === folder.folderID);
  const subfolders = active.subfolders
    .filter((subfolder) => subfolder.folderID === folder.folderID)
    .sort((a, b) => byLower(subfolderNameOf(a, label), subfolderNameOf(b, label)))
    .map((subfolder) => ({ subfolder, bookmarks: placesInOrder(inFolder.filter((bookmark) => bookmark.subfolderID === subfolder.subfolderID)) }));
  return { folder, count: inFolder.length, subfolders, loose: placesInOrder(inFolder.filter((bookmark) => bookmark.subfolderID === null)) };
}

/** GetFolderSectionList and GetLocationFolderScrollList: the personal or the shared locations. */
export function locationsSection(active: ActiveBookmarks, isPersonal: boolean, label: (path: string) => string): LocationsSection {
  const own = active.folders.filter((folder) => folder.isPersonal === isPersonal);
  const folders = own.filter((folder) => folder.isActive).sort((a, b) => byLower(a.folderName, b.folderName)).map((folder) => folderPlaces(active, folder, label));
  return {
    isPersonal,
    count: folders.reduce((sum, each) => sum + each.count, 0),
    folders,
    inactive: own.filter((folder) => !folder.isActive).sort((a, b) => byLower(a.folderName, b.folderName)),
  };
}

/** A point in space, in metres. */
export interface SpacePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A thing of the pilot's ballpark, as the page last read it. */
export interface SpaceBall {
  readonly position: SpacePoint;
  readonly radius: number;
  readonly typeID: number | null;
  readonly categoryID: number | null;
}

/**
 * What a bookmark's menu reads of a pilot flying in space: the client's session (its system and ship, whether the
 * ship is in warp) and its ballpark (the ship's own ball and the things around it), as the page last read them.
 */
export interface SpaceHere {
  readonly solarSystemID: number;
  readonly shipID: number;
  readonly warping: boolean;
  readonly shipPosition: SpacePoint;
  readonly shipRadius: number;
  readonly balls: ReadonlyMap<number, SpaceBall>;
}

/** appConst.minWarpDistance: a warp's least distance (sessionChecker.isInWarpRange). */
export const MIN_WARP_DISTANCE_M = 150_000;
/** appConst.maxApproachDistance: the farthest a place is approached from (OfferApproachLocation). */
export const MAX_APPROACH_DISTANCE_M = 10_000_000;

/** invConst's categories the warp's check names: asteroid, structure, orbital, sovereignty structure. */
const CATEGORY_ASTEROID = 25;
const CATEGORY_STRUCTURE = 65;
const CATEGORY_ORBITAL = 46;
const CATEGORY_SOVEREIGNTY_STRUCTURE = 40;
/**
 * The things a ballpark holds that move (a ball's isFree): ships, drones, fighters and the server's own pilots. The
 * page's read of space carries no ball's flag, so it goes by the thing's category.
 */
const MOVING_CATEGORIES: ReadonlySet<number> = new Set([6, 18, 87, 11]);

function metresBetween(from: SpacePoint, to: SpacePoint): number {
  return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
}

/**
 * BookmarkChecker.getDistanceToActiveShip (bookmarkChecker.py 117 to 151): none where the place is not in the
 * pilot's system; a coordinate's, from the ship to its point; a thing's in the ballpark, from surface to surface; a
 * structure's or an orbital's elsewhere, from the ship to its point; and nought for any other (a station or a
 * celestial the ballpark does not hold).
 *
 * The client takes an agent's home base and objective from the agent (GetEntryPoint): those are no bookmarks the
 * Locations window lists. A structure's or an orbital's bookmark is told by the thing's category in the page's read
 * of space; one the page has not read is measured as nought, as any place the client cannot tell apart is.
 */
export function bookmarkDistance(bookmark: Bookmark, here: SpaceHere): number | null {
  if (bookmark.locationID !== here.solarSystemID) return null;
  const point = bookmark.x === null ? null : { x: bookmark.x, y: bookmark.y ?? 0, z: bookmark.z ?? 0 };
  if ((bookmark.typeID === TYPE_SOLAR_SYSTEM || bookmark.itemID === bookmark.locationID) && point !== null) {
    return metresBetween(here.shipPosition, point);
  }
  const ball = bookmark.itemID === null ? undefined : here.balls.get(bookmark.itemID);
  if (ball !== undefined) {
    return Math.max(0, metresBetween(here.shipPosition, ball.position) - ball.radius - here.shipRadius);
  }
  return 0;
}

/** What of a bookmark's menu a pilot in space is offered of the ballpark's moves. */
export interface SpaceOffers {
  readonly distance: number | null;
  readonly warp: boolean;
  readonly approach: boolean;
  readonly align: boolean;
  readonly dock: boolean;
}

const NOTHING_IN_SPACE: SpaceOffers = Object.freeze({ distance: null, warp: false, approach: false, align: false, dock: false });

/**
 * The ballpark's moves of a bookmark's menu (menusvc.py _BookmarkMenu, 1459 to 1500), as BookmarkChecker offers each
 * to a pilot flying in the bookmark's system and not in warp:
 *
 *   Warp to Within (OfferWarpTo, _CanWarpToItem, celestialCheckers.py 2186 to 2209): farther off than a warp's least
 *   distance, and not the pilot's own ship; a thing that moves only where it is an asteroid, a structure or an
 *   orbital (a fleet member's ship besides, which no bookmark the window lists is);
 *   Approach Location (OfferApproachLocation, bookmarkChecker.py 30 to 45): nearer than the farthest approach;
 *   Align to (OfferAlignTo, 47 to 61): where Approach Location is not offered, and farther off than a warp's least
 *   distance;
 *   Dock (OfferDock, celestialCheckers.py 752 to 765): a station in the system.
 *
 * None of them for a pilot with no ballpark (docked, or not read).
 */
export function spaceOffersOf(bookmark: Bookmark, here: SpaceHere | null): SpaceOffers {
  if (here === null || here.warping) return NOTHING_IN_SPACE;
  const distance = bookmarkDistance(bookmark, here);
  if (distance === null) return NOTHING_IN_SPACE;
  const item = bookmark.itemID ?? bookmark.locationID;
  const ball = here.balls.get(item);
  const category = ball?.categoryID ?? null;
  const warpable = category === null || !MOVING_CATEGORIES.has(category)
    || [CATEGORY_ASTEROID, CATEGORY_STRUCTURE, CATEGORY_ORBITAL, CATEGORY_SOVEREIGNTY_STRUCTURE].includes(category);
  const inWarpRange = distance > MIN_WARP_DISTANCE_M;
  const approach = item > 0 && distance < MAX_APPROACH_DISTANCE_M;
  return {
    distance,
    warp: item !== here.shipID && inWarpRange && warpable,
    approach,
    align: !approach && item > 0 && inWarpRange,
    dock: item >= 60_000_000 && item < 64_000_000,
  };
}
