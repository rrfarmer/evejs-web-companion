// A shared bookmark folder taken up and switched on by the page itself, as a pilot does in the client's Locations
// panel.
//
// A SHARED FOLDER A PILOT MAY USE IS NOT YET ONE IT SEES. The server lists a pilot's personal folders and the
// shared folders the pilot KNOWS (bookmarkRuntimeState.js, listFolderViews), and hands on the bookmarks of the
// known folders that are ACTIVE alone; a warp to a bookmark asks for an active folder too (beyonceService.js,
// resolveBookmarkAnyStore, requireActive). Access by the folder's groups only makes a folder one the pilot may
// take up.
//
// THE CALLS, as the client makes them:
//
//   self.accessGroupBookmarkMgr.SearchFoldersWithAdminAccess()            (bookmarkSvc.py 715)
//   self.accessGroupBookmarkMgr.AddToKnownFolders(folderID, isActive)     (bookmarkSvc.py 357)
//   self.accessGroupBookmarkMgr.UpdateKnownFolderState(folderID, isActive) (bookmarkSvc.py 483)
//   self.accessGroupBookmarkMgr.MoveBookmarksToFolderAndSubfolder(oldFolderID, folderID, subfolderID, bookmarkIDs)
//                                                                         (bookmarkSvc.py 691)
//
// by the manager's name. The search is how the client's panel finds a folder to add by its name
// (bookmarksPanel.py 638): it answers the pilot's personal folders and every shared folder the pilot administers.
// Adding a folder is linkedBookmarkFolderWindow.py 173.
//
// THE LIMITS. A pilot may have three shared folders active (appConst.MAX_ACTIVE_SHARED_BOOKMARK_FOLDERS), five
// personal ones (MAX_ACTIVE_PERSONAL_BOOKMARK_FOLDERS), and know thirty (MAX_KNOWN_BOOKMARK_FOLDERS). The client
// refuses one active past the limit itself before asking (bookmarkSvc.ValidateActiveFolderCount, 506); the server
// refuses it too (TooManyActiveFolders). Adding a folder as active past the limit is NOT refused by this server: it
// adds the folder not active and says nothing (bookmarkRuntimeState.js, addKnownFolder), so the caller reads the
// folders again rather than trust the ask.

import type { Ask } from "./ask.ts";
import { moveBookmarks as moveBookmarksInto } from "./bookmarkWrites.ts";

/** appConst.MAX_ACTIVE_SHARED_BOOKMARK_FOLDERS. */
export const MAX_ACTIVE_SHARED_FOLDERS = 3;
/** appConst.MAX_ACTIVE_PERSONAL_BOOKMARK_FOLDERS. */
export const MAX_ACTIVE_PERSONAL_FOLDERS = 5;
/** appConst.MAX_KNOWN_BOOKMARK_FOLDERS. */
export const MAX_KNOWN_FOLDERS = 30;

const anID = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/** The pilot's personal folders and the shared folders it administers, and a shared folder taken up: the Locations window's own read and write. */
export { readFoldersWithAdminAccess } from "./bookmarkReads.ts";
export { addToKnownFolders } from "./bookmarkWrites.ts";

/**
 * Moves the bookmarks `bookmarkIDs`, all in the folder `fromFolderID`, into the folder `toFolderID` (no subfolder):
 * the client's own move (bookmarkSvc.MoveOrCopyBookmarks, 691), which needs the pilot able to manage both folders,
 * made as the Locations window makes it. Fails as the call fails.
 */
export async function moveBookmarks(act: Ask, fromFolderID: number, toFolderID: number, bookmarkIDs: readonly number[]): Promise<void> {
  if (!anID(fromFolderID) || !anID(toFolderID)) {
    throw new Error("That is no bookmark folder.");
  }
  if (bookmarkIDs.length === 0 || !bookmarkIDs.every(anID)) {
    throw new Error("There is no bookmark to move.");
  }
  await moveBookmarksInto(act, fromFolderID, toFolderID, null, bookmarkIDs);
}

/** Switches the known folder `folderID` on or off: the Locations window's own write. Fails as the call fails (TooManyActiveFolders past the limit). */
export { setFolderActive as updateKnownFolderState } from "./bookmarkWrites.ts";
