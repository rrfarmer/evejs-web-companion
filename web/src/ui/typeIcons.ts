// The item-icon rules, shared by every panel that shows a thing (goal R27).
//
// This module is the pure half of `TypeIcon.svelte`: where an icon's picture
// comes from, and what stands in for it when there is no picture. It is
// deliberately dependency-free so the rules can be tested without a DOM.
//
// ---------------------------------------------------------------------------
// ICONS ARE LOCAL ONLY.
//
// `scripts/cache-icons.js` downloaded a set of type icons into
// `data/icon-cache/`, and the BFF serves that directory at
// `config.iconCacheUrlPath` (`/icon-cache`) with `fallthrough: false` mounted
// ABOVE the SPA catch-all — so a type we never cached returns a real 404 and
// the `<img onerror>` fires, instead of quietly receiving `index.html` with a
// 200 and rendering a broken image.
//
// We link there and NOWHERE else. The browser never touches an external image
// host, so the client keeps working offline and leaks nothing about what the
// player is flying. `staticData.js` also exports `getRemoteTypeIconUrl`
// (images.evetech.net); it is NOT wired to the browser and must not be without
// an explicit, off-by-default opt-in.
//
// ---------------------------------------------------------------------------
// THE FALLBACK IS THE COMMON CASE, NOT THE EDGE CASE.
//
// `data/` is gitignored. On a fresh clone, and in CI, `data/icon-cache` does
// not exist at all and EVERY icon 404s. Even on a machine that has it, the
// cache covers a few hundred types out of tens of thousands. So the named tile
// below is the design's default state and the picture is the bonus — not the
// other way around. Nothing in the UI may depend on an icon having loaded.

/** Where the BFF serves the cached type icons (src/config.js). */
const ICON_BASE = "/icon-cache/types/64/icon";

/** Tier markers ("Damage Control II"). Dropped when picking tile initials. */
const TIER_MARKER = /^(?:I{1,3}|IV|VI{0,3}|IX|XI{0,3}|X)$/i;

/**
 * The local URL for a type's icon, or `null` when there is no sensible one.
 *
 * This puts a typeID in an image URL, which is NOT an R7d violation: R7d bans
 * numeric IDs shown to the player AS DATA, and this one is never rendered — it
 * is an asset path, exactly like the name cache keying on an ID the player
 * never sees. The precedent was set in R21.
 */
export function typeIconUrl(typeID: number | null): string | null {
  if (typeID === null || !Number.isSafeInteger(typeID) || typeID <= 0) {
    return null;
  }
  return `${ICON_BASE}/${typeID}.png`;
}

/**
 * A type's picture from the client's own files, as evePhotosvc.GetIconByType finds it: a drone's, a ship's or a
 * structure's rendered ahead (its graphic's icon folder), any other type's icon file (the BFF's
 * /client-res/type-picture route; 404 where the client has none). No download from the image server.
 */
export function typePictureUrl(typeID: number | null, size: 64 | 128 = 64): string | null {
  if (typeID === null || !Number.isSafeInteger(typeID) || typeID <= 0) {
    return null;
  }
  return `/client-res/type-picture/${typeID}/${size}.png`;
}

/**
 * The one or two characters a fallback tile shows, derived from the item's
 * NAME — never from its ID.
 *
 *   "Veldspar"              -> "VE"
 *   "Damage Control II"     -> "DC"
 *   "425mm AutoCannon II"   -> "4A"
 *   "—" (name not resolved) -> "?"
 *
 * The tile is never the only way to read what something is: the full name is
 * always visible beside it, and the icon carries the name as its accessible
 * label. This is a visual anchor, not information.
 */
export function iconInitials(name: string): string {
  const trimmed = String(name ?? "").trim();
  if (trimmed === "") {
    return "?";
  }
  const words = trimmed.split(/\s+/);
  // Prefer the words that actually name the thing over the tier marker, but
  // never end up with nothing (a module literally called "II" keeps its "II").
  const named = words.filter((word) => !TIER_MARKER.test(word));
  const pool = named.length > 0 ? named : words;
  const clean = (word: string): string => word.replace(/[^\p{L}\p{N}]/gu, "");
  if (pool.length === 1) {
    return clean(pool[0]!).slice(0, 2).toUpperCase() || "?";
  }
  const initials = pool
    .slice(0, 2)
    .map((word) => clean(word).charAt(0))
    .join("");
  return initials.toUpperCase() || "?";
}
