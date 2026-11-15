// A place in space bookmarked by the page itself (the plan's Phase 6b).
//
// Until 2026-10-11 it was one route of the BFF (POST /api/bridge/flight/bookmark-location).
//
// THE CALL, as the client makes it (bookmarkSvc.ACLBookmarkLocation, 609 to 620), from the bookmark's window
// (bookmarkLocationWindow.Confirm, 211: a name of nothing is refused there, and a tab in it is made a space):
//
//   bp = sm.StartService('michelle').GetRemotePark()
//   bp.BookmarkLocation(itemID, folderID, name, comment, expiry, subfolderID=subfolderID)
//
// on the ballpark's own object, the subfolder by keyword every time and None where there is none. With no
// ballpark the client says it must be in flight and asks nothing. A region, a constellation, a system, a station
// or a structure is not asked of the park at all: accessGroupBookmarkMgr's BookmarkStaticLocation is (613), which
// the page does not ask. The thing is the pilot's own ship for "save location"
// (addressbookService.BookmarkCurrentLocation, 394), or anything on the grid, from its menu. No Tranquility
// recording has a bookmark made.
//
// THE PAGE ASKS IT OF BEYONCE BY ITS NAME, as it asks the park's other calls: the game port makes it on the
// park's object, and refuses it for a pilot with none (src/gamePort/retailCalls.js, ON_THE_PARK).
//
// WHAT THE SERVER TAKES FROM THE CALLER: the thing, which it looks for in the session's own scene (the pilot's
// ship, or another thing there; BookmarkNotAvailable otherwise), and the folder, which the session's own
// character must be able to write to (BookmarkFolderNoLongerThere, FolderAccessDenied, FolderCapacityExceeded,
// BookmarkSubfolderNoLongerThere). It answers the bookmark as eight values, its number first.
//
// ⚠ THE ANSWER IS NOT WHAT A CALLER GOES BY. The page's one caller reads its bookmarks again and looks for the
// bookmark there (nav/siteLogisticsBookmark.ts).

import type { Ask } from "./ask.ts";
import { unwrapLong } from "./wire.ts";
import { decodeFolderInfo, type BookmarkFolder } from "./bookmarks.ts";

/** bookmarkConst: how long a bookmark is kept for. */
export const BOOKMARK_EXPIRY = Object.freeze({ none: 0, fourHours: 1, twoDays: 2, oneDay: 3 } as const);

const anID = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
/** idCheckers.IsRegion, IsConstellation, IsSolarSystem and IsStation, by the number alone. */
const isStaticPlace = (itemID: number): boolean => (itemID >= 10_000_000 && itemID <= 39_999_999) || (itemID >= 60_000_000 && itemID <= 63_999_999);

/**
 * Bookmarks where the thing `itemID` is in space, in the folder `folderID`, kept for `expiry` (one of
 * BOOKMARK_EXPIRY). Asks nothing for what the client asks nothing for. Answers the new bookmark's number, or null
 * where the answer names none. Fails as the call fails.
 */
export async function bookmarkLocation(act: Ask, itemID: number, folderID: number, name: string, comment: string, expiry: number, subfolderID: number | null = null): Promise<number | null> {
  if (anID(itemID) && isStaticPlace(itemID)) {
    throw new Error("A station, a system, a constellation or a region is not bookmarked this way.");
  }
  return bookmarkThing(act, "beyonce", "BookmarkLocation", itemID, folderID, name, comment, expiry, subfolderID);
}

/**
 * Bookmarks a probe result the sensor suite has no site of, as bookmarkSvc.ACLBookmarkScanResult does (623 to 631):
 * bp.BookmarkScanResult(locationID, name, comment, resultID, folderID, expiry, subfolderID=subfolderID), the system
 * the pilot is in and the result by its own ID, its label. Answers the new bookmark's number, or null where the answer
 * names none. Fails as the call fails, and before it for what the call could not be.
 */
export async function bookmarkScanResult(act: Ask, solarSystemID: number, resultID: string, folderID: number, name: string, comment: string, expiry: number, subfolderID: number | null = null): Promise<number | null> {
  if (!anID(solarSystemID)) {
    throw new Error("The pilot is in no system to bookmark a result of.");
  }
  if (resultID.trim() === "") {
    throw new Error("That is no scan result.");
  }
  if (!anID(folderID)) {
    throw new Error("That is no bookmark folder.");
  }
  const label = name.replace(/\t/g, " ");
  if (label.trim() === "") {
    throw new Error("A bookmark needs a name.");
  }
  if (!(Object.values(BOOKMARK_EXPIRY) as number[]).includes(expiry)) {
    throw new Error("That is no time to keep a bookmark for.");
  }
  if (subfolderID !== null && !anID(subfolderID)) {
    throw new Error("That is no bookmark subfolder.");
  }
  const answer = await act("beyonce", "BookmarkScanResult", [solarSystemID, label, comment, resultID, folderID, expiry], { subfolderID });
  const made = Array.isArray(answer) ? unwrapLong(answer[0]) : null;
  return made !== null && made > 0n && made <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(made) : null;
}

/**
 * Bookmarks the place `itemID` (a region, a constellation, a system or a station) as bookmarkSvc.ACLBookmarkLocation
 * asks for one (609 to 613): accessGroupBookmarkMgr.BookmarkStaticLocation(itemID, folderID, name, comment, expiry,
 * subfolderID=subfolderID). Answers the new bookmark's number, or null where the answer names none. Fails as the
 * call fails.
 */
export async function bookmarkStaticLocation(act: Ask, itemID: number, folderID: number, name: string, comment: string, expiry: number, subfolderID: number | null = null): Promise<number | null> {
  if (anID(itemID) && !isStaticPlace(itemID)) {
    throw new Error("Only a station, a system, a constellation or a region is bookmarked this way.");
  }
  return bookmarkThing(act, "accessGroupBookmarkMgr", "BookmarkStaticLocation", itemID, folderID, name, comment, expiry, subfolderID);
}

/**
 * Edits the bookmark `bookmarkID`, as the bookmark window's Submit edits one (bookmarkLocationWindow.py
 * _ConfirmAclBookmark, 219 to 220; bookmarkSvc.UpdateACLBookmark, 642 to 646):
 * 24.02 sends editExpiry and a mode. A null expiryMode leaves the existing deadline untouched.
 */
export async function updateBookmark(act: Ask, bookmarkID: number, folderID: number, name: string, note: string, subfolderID: number | null, newFolderID: number, expiryMode: number | null): Promise<void> {
  if (!anID(bookmarkID)) {
    throw new Error("That is no bookmark.");
  }
  if (!anID(folderID) || !anID(newFolderID)) {
    throw new Error("That is no bookmark folder.");
  }
  if (subfolderID !== null && !anID(subfolderID)) {
    throw new Error("That is no bookmark subfolder.");
  }
  const label = name.replace(/\t/g, " ");
  if (label.trim() === "") {
    throw new Error("A bookmark needs a name.");
  }
  if (expiryMode !== null && !(Object.values(BOOKMARK_EXPIRY) as number[]).includes(expiryMode)) {
    throw new Error("Choose a bookmark expiry option.");
  }
  await act("accessGroupBookmarkMgr", "UpdateBookmark", [bookmarkID, folderID, label, note, subfolderID, newFolderID, expiryMode !== null, expiryMode]);
}

/**
 * Deletes bookmarks of the folder `folderID`, as bookmarkSvc.DeleteBookmarks asks it for each folder (656 to 668):
 * accessGroupBookmarkMgr.DeleteBookmarks(folderID, bookmarks), the bookmarks a set. Answers the ones the server
 * deleted. Fails as the call fails.
 */
export async function deleteBookmarks(act: Ask, folderID: number, bookmarkIDs: readonly number[]): Promise<readonly number[]> {
  if (!anID(folderID)) {
    throw new Error("That is no bookmark folder.");
  }
  const ids = bookmarkIDs.filter(anID);
  if (ids.length === 0) {
    return [];
  }
  return idsOf(await act("accessGroupBookmarkMgr", "DeleteBookmarks", [folderID, ids]));
}

/** The bookmarks an answer names: a list of their numbers. */
function idsOf(answer: unknown): readonly number[] {
  const items = Array.isArray(answer) ? answer : answer !== null && typeof answer === "object" && Array.isArray((answer as { items?: unknown }).items) ? (answer as { items: unknown[] }).items : [];
  return items.map((item) => unwrapLong(item as never)).filter((id): id is bigint => id !== null && id > 0n && id <= BigInt(Number.MAX_SAFE_INTEGER)).map(Number);
}

/** appConst.MAX_FOLDER_NAME_LENGTH: the most a folder's or a subfolder's name holds (bookmarkSubfolderWindow.py 52). */
export const MAX_FOLDER_NAME_LENGTH = 40;

/** appConst.MAX_FOLDER_DESCRIPTION_LENGTH: the most a folder's notes hold (bookmarkContainerWindow.py 94). */
export const MAX_FOLDER_DESCRIPTION_LENGTH = 3900;

/** A folder's four access lists, as the folder window sends them; none of them for a personal folder. */
export interface FolderAccess {
  readonly adminGroupID: number | null;
  readonly manageGroupID: number | null;
  readonly useGroupID: number | null;
  readonly viewGroupID: number | null;
}

/** The access lists sent (Confirm, 203 to 219): None for a personal folder; a shared one's admins' list, then the others or None. */
function accessSent(isPersonal: boolean, access: FolderAccess): readonly (number | null)[] {
  if (isPersonal) {
    return [null, null, null, null];
  }
  const groups = [access.adminGroupID, access.manageGroupID, access.useGroupID, access.viewGroupID];
  if (groups.some((id) => id !== null && !anID(id))) {
    throw new Error("That is no access list.");
  }
  if (access.adminGroupID === null) {
    throw new Error("A shared folder needs an access list for its admins.");
  }
  return groups;
}

/** A folder's name as the folder window sends it (Confirm, 197 to 201): stripped, and never nothing. */
function folderNameOf(folderName: string): string {
  const name = folderName.trim();
  if (name === "") {
    throw new Error("A folder needs a name.");
  }
  return name;
}

/**
 * Makes a folder, as the folder window's Submit does (bookmarkContainerWindow.py Confirm, 197 to 242;
 * bookmarkSvc.CreateBookmarkFolder, 425 to 430): accessGroupBookmarkMgr.AddFolder(isPersonal, folderName,
 * description, adminGroupID, manageGroupID, useGroupID, viewGroupID). Answers the new folder, or null where the answer
 * is none. Fails as the call fails, and before it for no name and a shared folder with no admins' list.
 */
export async function addFolder(act: Ask, isPersonal: boolean, folderName: string, description: string, access: FolderAccess): Promise<BookmarkFolder | null> {
  const name = folderNameOf(folderName);
  return decodeFolderInfo(await act("accessGroupBookmarkMgr", "AddFolder", [isPersonal, name, description, ...accessSent(isPersonal, access)]));
}

/**
 * Changes the folder `folderID`'s name, notes and access lists, as the folder window's Submit in its edit does
 * (bookmarkSvc.UpdateBookmarkFolder, 437 to 450): accessGroupBookmarkMgr.UpdateFolder(folderID, folderName,
 * description, adminGroupID, manageGroupID, useGroupID, viewGroupID). Answers the pilot's access to it after, or null
 * where the answer is no number. Fails as the call fails, and before it as the making does.
 */
export async function updateFolder(act: Ask, folderID: number, isPersonal: boolean, folderName: string, description: string, access: FolderAccess): Promise<number | null> {
  if (!anID(folderID)) {
    throw new Error("That is no bookmark folder.");
  }
  const name = folderNameOf(folderName);
  const answer = await act("accessGroupBookmarkMgr", "UpdateFolder", [folderID, name, description, ...accessSent(isPersonal, access)]);
  return typeof answer === "number" && Number.isSafeInteger(answer) ? answer : null;
}

/** A subfolder's name as the subfolder window sends it (Confirm, 104 to 107): stripped, and never nothing. */
function subfolderNameOf(subfolderName: string): string {
  const name = subfolderName.trim();
  if (name === "") {
    throw new Error("A subfolder needs a name.");
  }
  return name;
}

/**
 * Makes a subfolder of the folder `folderID`, as the subfolder window's Submit does (bookmarkSubfolderWindow.py
 * Confirm, 104 to 122; bookmarkSvc.CreateSubfolder, 564 to 569): accessGroupBookmarkMgr.CreateSubfolder(folderID,
 * subfolderName). Fails as the call fails, and before it for what is no folder and for no name.
 */
export async function createSubfolder(act: Ask, folderID: number, subfolderName: string): Promise<void> {
  if (!anID(folderID)) {
    throw new Error("That is no bookmark folder.");
  }
  await act("accessGroupBookmarkMgr", "CreateSubfolder", [folderID, subfolderNameOf(subfolderName)]);
}

/**
 * Renames the subfolder `subfolderID` of the folder `folderID`, as the subfolder window's Submit in its edit does
 * (bookmarkSvc.UpdateSubfolder, 571 to 577): accessGroupBookmarkMgr.UpdateSubfolder(folderID, subfolderID,
 * subfolderName). Answers whether the server had it; one it had not is the client's BookmarkSubfolderNoLongerThere,
 * which the caller says. Fails as the call fails.
 */
export async function updateSubfolder(act: Ask, folderID: number, subfolderID: number, subfolderName: string): Promise<boolean> {
  if (!anID(folderID) || !anID(subfolderID)) {
    throw new Error("That is no bookmark subfolder.");
  }
  const answer = await act("accessGroupBookmarkMgr", "UpdateSubfolder", [folderID, subfolderID, subfolderNameOf(subfolderName)]);
  return answer === true || answer === 1;
}

/**
 * Deletes the subfolder `subfolderID` of the folder `folderID` and the bookmarks in it, as Delete Subfolder does
 * (bookmarkSvc.DeleteSubfolder, 579 to 597): accessGroupBookmarkMgr.DeleteSubfolder(folderID, subfolderID). Answers
 * the bookmarks the server deleted with it. Fails as the call fails.
 */
export async function deleteSubfolder(act: Ask, folderID: number, subfolderID: number): Promise<readonly number[]> {
  if (!anID(folderID) || !anID(subfolderID)) {
    throw new Error("That is no bookmark subfolder.");
  }
  return idsOf(await act("accessGroupBookmarkMgr", "DeleteSubfolder", [folderID, subfolderID]));
}

/**
 * Puts the folder `folderID` online or offline for the pilot, as Online Folder and Offline Folder do
 * (bookmarkSvc.UpdateFolderActiveState, 479 to 503): accessGroupBookmarkMgr.UpdateKnownFolderState(folderID,
 * isActive). The server answers the folder with its bookmarks and subfolders; the caller reads the list again.
 * Fails as the call fails.
 */
export async function setFolderActive(act: Ask, folderID: number, isActive: boolean): Promise<void> {
  if (!anID(folderID)) {
    throw new Error("That is no bookmark folder.");
  }
  await act("accessGroupBookmarkMgr", "UpdateKnownFolderState", [folderID, isActive]);
}

/** What a move or a copy answers (bookmarkSvc.MoveOrCopyBookmarks, 690 to 705): how many it did, and the server's message, if any. */
export interface MovedOrCopied {
  readonly count: number;
  /** A dialog's name and its values, which the client shows (prompt_player_fsd_dialog(*message)); null for none. */
  readonly message: { readonly dialog: string; readonly values: unknown } | null;
}

function movedOrCopiedOf(answer: unknown, counted: (first: unknown) => number): MovedOrCopied {
  const parts = Array.isArray(answer) ? answer : [];
  const raw = parts[1];
  const said = Array.isArray(raw) && typeof raw[0] === "string" ? { dialog: raw[0], values: raw[1] ?? null } : null;
  return { count: counted(parts[0]), message: said };
}

async function moveOrCopy(act: Ask, method: string, oldFolderID: number, folderID: number, subfolderID: number | null, bookmarkIDs: readonly number[]): Promise<unknown> {
  if (!anID(oldFolderID) || !anID(folderID)) {
    throw new Error("That is no bookmark folder.");
  }
  if (subfolderID !== null && !anID(subfolderID)) {
    throw new Error("That is no bookmark subfolder.");
  }
  const ids = bookmarkIDs.filter(anID);
  if (ids.length === 0) {
    throw new Error("No bookmark is chosen.");
  }
  return act("accessGroupBookmarkMgr", method, [oldFolderID, folderID, subfolderID, ids]);
}

/**
 * Moves bookmarks of the folder `oldFolderID` into the folder `folderID` and its subfolder `subfolderID` (null for the
 * folder itself), as bookmarkSvc.MoveOrCopyBookmarks moves a source folder's (690):
 * accessGroupBookmarkMgr.MoveBookmarksToFolderAndSubfolder(oldFolderID, folderID, subfolderID, bookmarks), the
 * bookmarks a set. Answers how many rows came back moved, and the server's message. Fails as the call fails.
 */
export async function moveBookmarks(act: Ask, oldFolderID: number, folderID: number, subfolderID: number | null, bookmarkIDs: readonly number[]): Promise<MovedOrCopied> {
  const answer = await moveOrCopy(act, "MoveBookmarksToFolderAndSubfolder", oldFolderID, folderID, subfolderID, bookmarkIDs);
  return movedOrCopiedOf(answer, (rows) => (Array.isArray(rows) ? rows.length : rows !== null && typeof rows === "object" && Array.isArray((rows as { items?: unknown }).items) ? (rows as { items: unknown[] }).items.length : 0));
}

/**
 * Copies bookmarks of the folder `oldFolderID` into the folder `folderID` and its subfolder `subfolderID`, as
 * bookmarkSvc.MoveOrCopyBookmarks copies a source folder's (701):
 * accessGroupBookmarkMgr.CopyBookmarksToFolderAndSubfolder(oldFolderID, folderID, subfolderID, bookmarks). Answers
 * how many new bookmarks came back, and the server's message. Fails as the call fails.
 */
export async function copyBookmarks(act: Ask, oldFolderID: number, folderID: number, subfolderID: number | null, bookmarkIDs: readonly number[]): Promise<MovedOrCopied> {
  const answer = await moveOrCopy(act, "CopyBookmarksToFolderAndSubfolder", oldFolderID, folderID, subfolderID, bookmarkIDs);
  return movedOrCopiedOf(answer, (made) => {
    if (made === null || typeof made !== "object") return 0;
    const entries = (made as { entries?: unknown }).entries;
    return Array.isArray(entries) ? entries.length : Object.keys(made).length;
  });
}

/**
 * Adds the folder `folderID` to those the pilot knows, online or offline, as Folder Information's Add Folder does
 * (bookmarkSvc.AddToKnownFolders, 350 to 370): accessGroupBookmarkMgr.AddToKnownFolders(folderID, isActive). Answers
 * the folder as the server answers it (its online state may not be the one asked for), or null where the answer is
 * none. Fails as the call fails.
 */
export async function addToKnownFolders(act: Ask, folderID: number, isActive: boolean): Promise<BookmarkFolder | null> {
  if (!anID(folderID)) {
    throw new Error("That is no bookmark folder.");
  }
  const answer = await act("accessGroupBookmarkMgr", "AddToKnownFolders", [folderID, isActive]);
  return decodeFolderInfo(Array.isArray(answer) ? answer[0] ?? null : null);
}

/**
 * Disconnects the pilot from the shared folder `folderID`, as Disconnect from Folder does (bookmarkSvc.RemoveFromKnownFolders,
 * 459 to 464): accessGroupBookmarkMgr.RemoveFromKnownFolders(folderID). The folder stays; the pilot no longer knows it.
 * Fails as the call fails.
 */
export async function removeFromKnownFolders(act: Ask, folderID: number): Promise<void> {
  if (!anID(folderID)) {
    throw new Error("That is no bookmark folder.");
  }
  await act("accessGroupBookmarkMgr", "RemoveFromKnownFolders", [folderID]);
}

/**
 * Deletes the folder `folderID` and everything in it, as Delete Folder does (bookmarkSvc.DeleteBookmarkFolder, 452 to
 * 457): accessGroupBookmarkMgr.DeleteFolder(folderID). Fails as the call fails.
 */
export async function deleteFolder(act: Ask, folderID: number): Promise<void> {
  if (!anID(folderID)) {
    throw new Error("That is no bookmark folder.");
  }
  await act("accessGroupBookmarkMgr", "DeleteFolder", [folderID]);
}

async function bookmarkThing(act: Ask, service: string, method: string, itemID: number, folderID: number, name: string, comment: string, expiry: number, subfolderID: number | null): Promise<number | null> {
  if (!anID(itemID)) {
    throw new Error("There is nothing there to bookmark.");
  }
  if (!anID(folderID)) {
    throw new Error("That is no bookmark folder.");
  }
  const label = name.replace(/\t/g, " ");
  if (label.trim() === "") {
    throw new Error("A bookmark needs a name.");
  }
  if (!(Object.values(BOOKMARK_EXPIRY) as number[]).includes(expiry)) {
    throw new Error("That is no time to keep a bookmark for.");
  }
  if (subfolderID !== null && !anID(subfolderID)) {
    throw new Error("That is no bookmark subfolder.");
  }
  const answer = await act(service, method, [itemID, folderID, label, comment, expiry], { subfolderID });
  const made = Array.isArray(answer) ? unwrapLong(answer[0]) : null;
  return made !== null && made > 0n && made <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(made) : null;
}
