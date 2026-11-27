// A "showinfo:" link, as the client reads and follows it (evelink/client/handlers/show_info: parse.py
// ShowInfoLinkData.parse, handler.py handle_show_info_link: the info service's ShowInfo(type_id, item_id)):
//
//   showinfo:{typeID}//{itemID}//...   the type a whole number (else the link is not followed); the item a whole number
//                                      where it reads as one, none where it does not or is nought; what follows the
//                                      item (a ship's owner, a blueprint's runs and levels) is the info window's
//
// The types the client's own consts name for an owner or a place (inventorycommon/const.py): a pilot (typeCharacter and
// the legacy ones), a corporation, an alliance, a faction, a region, a constellation and a solar system.

/** typeCharacter and typeCharacterLegacy1 to 14. */
export const CHARACTER_TYPES: ReadonlySet<number> = new Set([1373, 1374, 1375, 1376, 1377, 1378, 1379, 1380, 1381, 1382, 1383, 1384, 1385, 1386, 34574]);
/** typeCorporation, typeRegion, typeConstellation, typeSolarSystem, typeFaction, typeAlliance */
export const OWNER_AND_PLACE_TYPES: ReadonlySet<number> = new Set([2, 3, 4, 5, 30, 16159]);

/** Python's int() of a word: a whole number, signs and spaces about it allowed; else null. */
function pythonInt(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** ShowInfoLinkData.parse: the type and the item; null where the client's own parse raises (the type not a number). */
export function parseShowInfoUrl(url: string): { readonly typeID: number; readonly itemID: number | null } | null {
  const colon = url.indexOf(":");
  if (colon < 0) return null;
  const parts = url.slice(colon + 1).split("//");
  const typeID = pythonInt(parts[0] ?? "");
  if (typeID === null) return null;
  const item = parts.length > 1 ? pythonInt(parts[1]!) : null;
  return { typeID, itemID: item === null || item === 0 ? null : item };
}

/** The solar system in a dungeon bookmark link, rather than a plain Show Info link. */
export function dungeonBookmarkSystem(url: string): number | null {
  if (linkScheme(url) !== "showinfo") return null;
  const parts = url.slice(url.indexOf(":") + 1).split("//");
  if (parts.length !== 8 || parts[7] !== "dungeon") return null;
  const ids = parseShowInfoUrl(url);
  if (ids?.typeID !== 5 || ids.itemID === null || ids.itemID <= 0) return null;
  const coordinates = parts.slice(2, 5);
  if (coordinates.some(part => !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(part) || !Number.isFinite(Number(part)))) return null;
  if (!/^\d+(?:,\d+)?$/.test(parts[5]!) || pythonInt(parts[6]!) === null) return null;
  return ids.itemID;
}

/** The link's scheme as the registry keys it (normalize_scheme: lower case), or null where it has none. */
export function linkScheme(url: string): string | null {
  const colon = url.indexOf(":");
  return colon > 0 ? url.slice(0, colon).toLowerCase() : null;
}
