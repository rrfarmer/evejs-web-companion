// Brackets as the client draws them: the icon of the thing's bracket, found by its type, else its group, else its
// category (bracketMgr.GetBracketDataByTypeID), from the client's own tables (brackets.json, written by
// tools/client-extract from res:/staticdata/brackets*.static). The icons are white; the client tints them by what
// the thing is to the pilot, and so does this, through a CSS mask.

interface BracketTables {
  byType: Record<string, number>;
  byGroup: Record<string, number>;
  byCategory: Record<string, number>;
  brackets: Record<string, { name: string | null; texturePath: string | null }>;
}

let tables: BracketTables | null = null;
let loading: Promise<void> | null = null;

/** Load the tables once; until they are here, bracketIcon answers null and the caller draws its own glyph. */
export function loadBrackets(): Promise<void> {
  loading ??= fetch("/client-assets/brackets.json").then((r) => (r.ok ? r.json() : null)).then((t) => { tables = t as BracketTables | null; }).catch(() => undefined);
  return loading;
}

/** The thing's bracket icon as a /client-res URL, or null. */
export function bracketIcon(thing: { typeID: number | null; groupID: number | null; categoryID: number | null }): string | null {
  if (!tables) return null;
  const id = (thing.typeID !== null ? tables.byType[String(thing.typeID)] : undefined)
    ?? (thing.groupID !== null ? tables.byGroup[String(thing.groupID)] : undefined)
    ?? (thing.categoryID !== null ? tables.byCategory[String(thing.categoryID)] : undefined);
  const path = id === undefined ? null : tables.brackets[String(id)]?.texturePath ?? null;
  return path ? `/client-res/${path.replace(/^res:\//i, "").toLowerCase()}` : null;
}
