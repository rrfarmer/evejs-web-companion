// Brackets as the client draws them: the icon of the thing's bracket, found by its type, else its group, else its
// category (bracketMgr.GetBracketDataByTypeID), from the client's own tables (brackets.json, written by
// tools/client-extract from res:/staticdata/brackets*.static). The icons are white; the client tints them by what
// the thing is to the pilot, and so does this, through a CSS mask.

interface BracketTables {
  byType: Record<string, number>;
  byGroup: Record<string, number>;
  byCategory: Record<string, number>;
  brackets: Record<string, { name: string | null; texturePath: string | null; texturePathEmpty?: string | null }>;
}

interface BracketType {
  typeID: number | null;
  groupID: number | null;
  categoryID: number | null;
  hackingSecurityState?: number;
  /** A wreck's slim isEmpty: bracketMgr._GetBracketIcon's texturePathEmpty where the bracket has one. */
  isEmpty?: boolean;
}

let tables: BracketTables | null = null;
let loading: Promise<void> | null = null;

/** Load the tables once; until they are here, bracketIcon answers null and the caller draws its own glyph. */
export function loadBrackets(): Promise<void> {
  loading ??= fetch("/client-assets/brackets.json").then((r) => (r.ok ? r.json() : null)).then((t) => { tables = t as BracketTables | null; }).catch(() => undefined);
  return loading;
}

function bracketEntry(thing: BracketType) {
  if (!tables) return null;
  const id = tables.byType[String(thing.typeID)] ?? tables.byGroup[String(thing.groupID)] ?? tables.byCategory[String(thing.categoryID)];
  return id === undefined ? null : tables.brackets[String(id)] ?? null;
}

/** Once the client table is available, only types with a bracket entry can show a bracket. */
export function hasBracketData(thing: BracketType): boolean {
  return !tables || thing.typeID === null || bracketEntry(thing) !== null;
}

/** The thing's bracket icon as a /client-res URL, or null. */
export function bracketIcon(thing: BracketType): string | null {
  // hacking_util.GetHackingIcon overrides the ordinary type lookup.
  const state = thing.hackingSecurityState;
  if (state !== undefined) {
    const texture = state === 0 ? "unopened" : state === 1 ? "beinghacked" : "empty";
    return `/client-res/ui/texture/shared/brackets/scattercontainer${texture}.png`;
  }
  const entry = bracketEntry(thing);
  const path = (thing.isEmpty && entry?.texturePathEmpty) || entry?.texturePath;
  return path ? `/client-res/${path.replace(/^res:\//i, "").toLowerCase()}` : null;
}
