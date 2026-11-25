// The market's quickbar, as the client keeps it: the user's setting 'quickbar' (settings.user.ui), a dict of entries by
// their numbers, each a KeyVal of its parent (0 for the top), its number and its label, a type's number for a type and
// a (unicode) name for a folder, with a type's extra text; and 'quickbar_lastid', the last number given.
//
// What changes it, each as the client's does:
//   addType       marketQuote.AddToQuickBar (quote.py 638 to 661): nothing where the folder holds the type already
//   addFolder     AddNewQuickbarFolder (664 to 682) and the market window's NewFolder (marketbase.py 1871 to 1886)
//   renameFolder  RenameFolder with the name given (1859 to 1869)
//   deleteFolder  GroupDeleteFolder (1888 to 1905): a folder and all it holds, its folders' too
//   removeType    menuFunctions.RemoveFromQuickBar (100 to 115): the first of the type in that folder, the dict's way
//   setExtraText  EditExtraText (597 to 605)
//   reset         ResetQuickbar (1598 to 1606)
// And what a folder's Buy All buys (marketutil/quickbarUtil.GetTypesUnderFolder).

import { intDictOrder } from "./py27DictOrder.ts";

export interface QuickbarEntry {
  readonly parent: number;
  readonly id: number;
  /** A type's number (Python's int) for a type; a folder's name (unicode) for a folder. */
  readonly label: number | string;
  /** A type's extra text: what was typed, or the quantity the multibuy put (an int). */
  readonly extraText?: string | number;
}

export interface Quickbar {
  /** The entries in the order they were put in (the dict iterates them by number, intDictOrder). */
  readonly entries: readonly QuickbarEntry[];
  readonly lastID: number;
}

export const EMPTY_QUICKBAR: Quickbar = Object.freeze({ entries: Object.freeze([]), lastID: 0 });

export const isFolder = (entry: QuickbarEntry): entry is QuickbarEntry & { readonly label: string } => typeof entry.label === "string";
export const isType = (entry: QuickbarEntry): entry is QuickbarEntry & { readonly label: number } => typeof entry.label === "number";

/** The entries in the order the client's dict iterates them (by number, as a dict of whole numbers does). */
function dictOrdered(quickbar: Quickbar): QuickbarEntry[] {
  const byID = new Map(quickbar.entries.map((entry) => [entry.id, entry]));
  return intDictOrder(quickbar.entries.map((entry) => entry.id)).map((id) => byID.get(id)!);
}

/** AddToQuickBar: the type put in the folder (0 for the top) with its extra text, unless the folder holds it already. */
export function addType(quickbar: Quickbar, typeID: number, parent = 0, extraText: string | number = ""): Quickbar {
  if (quickbar.entries.some((entry) => entry.parent === parent && entry.label === typeID)) return quickbar;
  const id = quickbar.lastID + 1;
  return { entries: [...quickbar.entries, { parent, id, label: typeID, extraText }], lastID: id };
}

/** AddNewQuickbarFolder and NewFolder: a folder of that name in the folder given (0 for the top), and its entry. */
export function addFolder(quickbar: Quickbar, name: string, parent = 0): { readonly quickbar: Quickbar; readonly folder: QuickbarEntry } {
  const folder: QuickbarEntry = { parent, id: quickbar.lastID + 1, label: name };
  return { quickbar: { entries: [...quickbar.entries, folder], lastID: folder.id }, folder };
}

export function renameFolder(quickbar: Quickbar, folderID: number, name: string): Quickbar {
  return { ...quickbar, entries: quickbar.entries.map((entry) => (entry.id === folderID ? { ...entry, label: name } : entry)) };
}

/** GroupDeleteFolder: the folder, what it holds, and its folders and what they hold. */
export function deleteFolder(quickbar: Quickbar, folderID: number): Quickbar {
  const gone = new Set<number>([folderID]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of quickbar.entries) {
      if (!gone.has(entry.id) && gone.has(entry.parent)) {
        gone.add(entry.id);
        grew = true;
      }
    }
  }
  return { ...quickbar, entries: quickbar.entries.filter((entry) => !gone.has(entry.id)) };
}

/** RemoveFromQuickBar: the first entry of the type in that folder, in the dict's order, taken out. */
export function removeType(quickbar: Quickbar, parent: number, typeID: number): Quickbar {
  const found = dictOrdered(quickbar).find((entry) => entry.parent === parent && isType(entry) && entry.label === typeID);
  return found === undefined ? quickbar : { ...quickbar, entries: quickbar.entries.filter((entry) => entry.id !== found.id) };
}

export function setExtraText(quickbar: Quickbar, entryID: number, extraText: string): Quickbar {
  return { ...quickbar, entries: quickbar.entries.map((entry) => (entry.id === entryID ? { ...entry, extraText } : entry)) };
}

/** GetItems(parent): the folder's own entries. */
export function childrenOf(quickbar: Quickbar, parent: number): QuickbarEntry[] {
  return quickbar.entries.filter((entry) => entry.parent === parent);
}

/** int(extraText) in Python: a whole number, spaces about it allowed; a whole number given as such; else null (ValueError). */
export function quickbarQuantity(extraText: string | number | undefined): number | null {
  if (typeof extraText === "number") return Math.trunc(extraText);
  const text = extraText ?? "";
  return /^\s*[+-]?\d+\s*$/.test(text) ? Number.parseInt(text.trim(), 10) : null;
}

/**
 * GetTypesUnderFolder (quickbarUtil.py 10 to 52): the types in the folder and in its folders, a breadth at a time, and
 * how many of each (its extra text as a whole number, else one; added where a type is in several), by type in the order
 * the client's dict holds them (first met first, as the dicts and sets of whole numbers it is walked through iterate:
 * by number). Empty where the folder holds no type.
 */
export function typesUnderFolder(quickbar: Quickbar, folderID: number): Map<number, number> {
  const foldersByParent = new Map<number, number[]>();
  const typesByParent = new Map<number, (readonly [number, string | number | undefined])[]>();
  for (const entry of dictOrdered(quickbar)) {
    if (isFolder(entry)) foldersByParent.set(entry.parent, [...(foldersByParent.get(entry.parent) ?? []), entry.id]);
    else typesByParent.set(entry.parent, [...(typesByParent.get(entry.parent) ?? []), [entry.label as number, entry.extraText] as const]);
  }
  const counted = new Map<number, number>();
  const add = (inFolder: readonly (readonly [number, string | number | undefined])[]): void => {
    for (const [typeID, extraText] of inFolder) counted.set(typeID, (counted.get(typeID) ?? 0) + (quickbarQuantity(extraText) ?? 1));
  };
  add(typesByParent.get(folderID) ?? []);
  let current = intDictOrder(foldersByParent.get(folderID) ?? []);
  while (current.length > 0) {
    const next: number[] = [];
    for (const id of current) {
      next.push(...(foldersByParent.get(id) ?? []));
      add(typesByParent.get(id) ?? []);
    }
    current = intDictOrder(next);
  }
  const order = intDictOrder([...counted.keys()]);
  return new Map(order.map((typeID) => [typeID, counted.get(typeID)!]));
}

/** The quickbar as kept (JSON of the entries and the last number); EMPTY_QUICKBAR for anything else. */
export function quickbarFromJson(text: string | null): Quickbar {
  if (text === null) return EMPTY_QUICKBAR;
  try {
    const kept = JSON.parse(text) as { entries?: unknown; lastID?: unknown };
    const entries = (Array.isArray(kept.entries) ? kept.entries : []).flatMap((each): QuickbarEntry[] => {
      const row = each as Record<string, unknown>;
      const id = Number(row.id);
      const parent = Number(row.parent);
      const label = typeof row.label === "string" || typeof row.label === "number" ? row.label : null;
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(parent) || label === null) return [];
      const extraText = typeof row.extraText === "string" || typeof row.extraText === "number" ? row.extraText : undefined;
      return [{ id, parent, label, ...(extraText === undefined ? {} : { extraText }) }];
    });
    const lastID = Number(kept.lastID);
    return { entries, lastID: Number.isSafeInteger(lastID) && lastID >= 0 ? lastID : entries.reduce((most, entry) => Math.max(most, entry.id), 0) };
  } catch {
    return EMPTY_QUICKBAR;
  }
}
