// Bookmark reads decoded to plain rows (goal R65, PLUMBING ONLY — no UI).
//
// GET /api/bridge/bookmarks batches three accessGroupBookmarkMgr reads. Their
// retail wire shapes, captured live from Farmer (character 140000005) 2026-07-22:
//   • GetMyActiveBookmarks() -> a 3-element ARRAY: [ {list of folder util.KeyVals},
//       {list of bookmark util.KeyVals}, {list of subfolder util.KeyVals} ].
//   • SearchFoldersWithAdminAccess() -> {type:"list", items:[folder KeyVal, …]}.
//   • GetFolderInfo(folderID) -> one folder KeyVal (a folder the char cannot access
//       is refused server-side, never returned).
//
// Field shapes seen live: folderName / description / memo / note are wstring
// wrappers; created / expiry are long FILETIMEs; x / y / z are floats; every id
// is a bare number; adminGroupID/manage/use/view and itemID/subfolderID/expiry are
// null when absent.
//
// R7d: folderID / bookmarkID / itemID / typeID / locationID / creatorID / group
// ids stay numeric fields for a future UI to resolve; the decoder renders nothing.

import {
  readKeyVal,
  readPlainJsonField,
  readRowField,
  unwrapLong,
  type JsonValue,
} from "./wire.ts";

export interface BookmarkFolder {
  readonly folderID: number;
  readonly folderName: string;
  readonly description: string;
  readonly creatorID: number | null;
  readonly isPersonal: boolean;
  readonly isActive: boolean;
  readonly accessLevel: number;
  readonly adminGroupID: number | null;
  readonly manageGroupID: number | null;
  readonly useGroupID: number | null;
  readonly viewGroupID: number | null;
}

export interface Bookmark {
  readonly bookmarkID: number;
  readonly folderID: number;
  readonly itemID: number | null;
  readonly typeID: number;
  readonly memo: string;
  readonly note: string;
  /** created / expiry as FILETIME bigints (they exceed 2^53); null if absent. */
  readonly created: bigint | null;
  readonly expiry: bigint | null;
  readonly x: number | null;
  readonly y: number | null;
  readonly z: number | null;
  readonly locationID: number;
  readonly subfolderID: number | null;
  readonly creatorID: number | null;
}

export interface Subfolder {
  readonly subfolderID: number;
  readonly folderID: number;
  readonly subfolderName: string;
  readonly creatorID: number | null;
}

export interface ActiveBookmarks {
  readonly folders: readonly BookmarkFolder[];
  readonly bookmarks: readonly Bookmark[];
  readonly subfolders: readonly Subfolder[];
}

/** A string/wstring/rawstr/token wrapper's text, or a bare string; "" otherwise. */
function toText(value: JsonValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string") {
      return inner;
    }
  }
  return "";
}

/** A number tolerant of a {type:"long"} wrapper and a numeric string; 0 otherwise. */
function toNumber(value: JsonValue | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const long = unwrapLong(value);
  if (long !== null) {
    return Number(long);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return 0;
}

/** A positive-int id as a number, or null when absent / zero (never a substituted 0). */
function toOptionalID(value: JsonValue | undefined): number | null {
  const numeric = toNumber(value);
  return numeric > 0 ? numeric : null;
}

/** A finite coordinate as a number, or null when absent / non-finite. */
function toOptionalNumber(value: JsonValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

/** A FILETIME as a bigint (it exceeds 2^53); null when absent or a zero sentinel. */
function toFiletime(value: JsonValue | undefined): bigint | null {
  const long =
    typeof value === "string" && /^-?\d+$/.test(value) ? BigInt(value) : unwrapLong(value);
  return long !== null && long > 0n ? long : null;
}

/** The items of a marshaled list wrapper, or a bare array; [] otherwise. */
function listItems(value: JsonValue | undefined): readonly JsonValue[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    const candidate = value as { type?: unknown; items?: unknown };
    if (candidate.type === "list" && Array.isArray(candidate.items)) {
      return candidate.items as readonly JsonValue[];
    }
  }
  return [];
}

/** True when the value is a util.KeyVal-shaped row (not a bare number/null). */
function isRow(value: JsonValue): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeFolderRow(row: JsonValue): BookmarkFolder | null {
  if (!isRow(row)) {
    return null;
  }
  const folderID = toNumber(readRowField(row, "folderID"));
  if (folderID <= 0) {
    return null;
  }
  return {
    folderID,
    folderName: toText(readRowField(row, "folderName")),
    description: toText(readRowField(row, "description")),
    creatorID: toOptionalID(readRowField(row, "creatorID")),
    isPersonal: readRowField(row, "isPersonal") === true,
    isActive: readRowField(row, "isActive") === true,
    accessLevel: toNumber(readRowField(row, "accessLevel")),
    adminGroupID: toOptionalID(readRowField(row, "adminGroupID")),
    manageGroupID: toOptionalID(readRowField(row, "manageGroupID")),
    useGroupID: toOptionalID(readRowField(row, "useGroupID")),
    viewGroupID: toOptionalID(readRowField(row, "viewGroupID")),
  };
}

function decodeBookmarkRow(row: JsonValue): Bookmark | null {
  if (!isRow(row)) {
    return null;
  }
  const bookmarkID = toNumber(readRowField(row, "bookmarkID"));
  if (bookmarkID <= 0) {
    return null;
  }
  return {
    bookmarkID,
    folderID: toNumber(readRowField(row, "folderID")),
    itemID: toOptionalID(readRowField(row, "itemID")),
    typeID: toNumber(readRowField(row, "typeID")),
    memo: toText(readRowField(row, "memo")),
    note: toText(readRowField(row, "note")),
    created: toFiletime(readRowField(row, "created")),
    expiry: toFiletime(readRowField(row, "expiry")),
    x: toOptionalNumber(readRowField(row, "x")),
    y: toOptionalNumber(readRowField(row, "y")),
    z: toOptionalNumber(readRowField(row, "z")),
    locationID: toNumber(readRowField(row, "locationID")),
    subfolderID: toOptionalID(readRowField(row, "subfolderID")),
    creatorID: toOptionalID(readRowField(row, "creatorID")),
  };
}

function decodeSubfolderRow(row: JsonValue): Subfolder | null {
  if (!isRow(row)) {
    return null;
  }
  const subfolderID = toNumber(readRowField(row, "subfolderID"));
  if (subfolderID <= 0) {
    return null;
  }
  return {
    subfolderID,
    folderID: toNumber(readRowField(row, "folderID")),
    subfolderName: toText(readRowField(row, "subfolderName")),
    creatorID: toOptionalID(readRowField(row, "creatorID")),
  };
}

function decodeFolders(value: JsonValue | undefined): BookmarkFolder[] {
  const rows: BookmarkFolder[] = [];
  for (const item of listItems(value)) {
    const row = decodeFolderRow(item);
    if (row) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Decode GetMyActiveBookmarks (the [folders, bookmarks, subfolders] 3-array) into
 * three plain-row lists. Any list may be empty — a real "none active" answer.
 */
export function decodeActiveBookmarks(result: JsonValue): ActiveBookmarks {
  const parts = Array.isArray(result) ? result : listItems(result);
  const folders = decodeFolders(parts[0]);
  const bookmarks: Bookmark[] = [];
  for (const item of listItems(parts[1])) {
    const row = decodeBookmarkRow(item);
    if (row) {
      bookmarks.push(row);
    }
  }
  const subfolders: Subfolder[] = [];
  for (const item of listItems(parts[2])) {
    const row = decodeSubfolderRow(item);
    if (row) {
      subfolders.push(row);
    }
  }
  return { folders, bookmarks, subfolders };
}

/** Decode a folder-list read (SearchFoldersWithAdminAccess) into folder rows. */
export function decodeFolderList(result: JsonValue): BookmarkFolder[] {
  return decodeFolders(result);
}

/** Decode GetFolderInfo: one folder, or null when the value is not a folder row. */
export function decodeFolderInfo(result: JsonValue): BookmarkFolder | null {
  if (result === null || result === undefined) {
    return null;
  }
  return decodeFolderRow(result);
}

/** An access list returned by ownerGroupManager. */
export interface AccessGroup {
  readonly groupID: number;
  readonly creatorID: number | null;
  readonly name: string;
  readonly description: string;
  readonly membershipType: number;
}

/**
 * Decode ownerGroupManager.GetMyGroups (accessGroupsController.GetMyGroups, 102 to 109): the groups' KeyVals, each
 * with groupID, creatorID, name, description, membershipType and admins. A row with no number is none.
 */
export function decodeAccessGroups(result: JsonValue): AccessGroup[] {
  const groups: AccessGroup[] = [];
  for (const item of listItems(result)) {
    const group = decodeAccessGroup(item);
    if (group !== null) {
      groups.push(group);
    }
  }
  return groups;
}

/** Decode one access list's KeyVal (ownerGroupManager.GetGroup), or null where it is none. */
export function decodeAccessGroup(result: JsonValue): AccessGroup | null {
  if (result === null || result === undefined || !isRow(result)) {
    return null;
  }
  const groupID = toNumber(readRowField(result, "groupID"));
  if (groupID <= 0) {
    return null;
  }
  return {
    groupID,
    creatorID: toOptionalID(readRowField(result, "creatorID")),
    name: toText(readRowField(result, "name")),
    description: toText(readRowField(result, "description")),
    membershipType: toNumber(readRowField(result, "membershipType")),
  };
}

// --- R87 write acks ---------------------------------------------------------
//
// The Phase-3 accessGroupBookmarkMgr WRITES (folder + bookmark CRUD; reads were
// wired R65). FAST-MODE educated-guess decoders reading the small JSON ack the
// confirm-gated BFF route emits. AddFolder carries the new folder payload,
// UpdateFolder carries the resulting access-level int; BookmarkStaticLocation
// carries the new bookmark tuple, DeleteBookmarks the deleted-id list; the rest
// answer null (the panel re-reads to prove the mutation). Every write is scoped
// to the SESSION character's folder access server-side. EDUCATED GUESSES from
// the client + server code, not captured bytes.

/** The uniform ack every confirm-gated bookmark write returns. */
export interface BookmarkWriteAck {
  readonly ok: boolean;
  readonly applied: boolean;
}

function bookmarkAckTruthy(value: JsonValue | undefined): boolean {
  return value === true;
}

/** Decode a plain bookmark write ack (DeleteFolder / UpdateBookmark / DeleteBookmarks / Move / …). */
export function decodeBookmarkWriteAck(response: JsonValue): BookmarkWriteAck {
  return {
    ok: bookmarkAckTruthy(readPlainJsonField(response, "ok")),
    applied: bookmarkAckTruthy(readPlainJsonField(response, "applied")),
  };
}

/** An UpdateFolder ack: `applied` plus the resulting access-level int. */
export interface BookmarkFolderUpdatedAck extends BookmarkWriteAck {
  readonly accessLevel: number;
}

export function decodeBookmarkFolderUpdatedAck(response: JsonValue): BookmarkFolderUpdatedAck {
  return {
    ok: bookmarkAckTruthy(readPlainJsonField(response, "ok")),
    applied: bookmarkAckTruthy(readPlainJsonField(response, "applied")),
    accessLevel: toNumber(readPlainJsonField(response, "accessLevel")),
  };
}
