// Which scanner sites a site-warp block may fly to, by NAME — the matching half
// of the `siteList` block argument (bots/botScript.ts).
//
// ── Why the faction word comes off ──────────────────────────────────────────
// A combat anomaly's name is "<faction> <site>": "Angel Haven", "Serpentis
// Haven", "Blood Raider Forlorn Den". What a player means by a site is the
// second half — Haven is the same rung of the ladder whoever runs it — and no
// id the scanner row carries says that, because each faction's Haven is its own
// dungeon with its own name message. So both sides of every comparison lose
// their leading faction word first, and then compare WHOLE, ignoring case.
//
// ⚠ WHOLE, NEVER A SUBSTRING. "Sanctum" is inside "Forsaken Sanctum" and "Den"
// is inside "Hidden Den", "Forsaken Den" and "Forlorn Den" — each a different
// and much harder site. A player who lists Den for a weak ship must not be sent
// into a Forlorn Den.
//
// ⚠ THE SAME FUNCTION ON BOTH SIDES. A player who types the full "Angel Haven"
// gets "Haven" too, which is the rule they chose: the faction never decides.
// Rogue drone sites have no faction word ("Drone Patrol") and are compared as
// they are.

import type { SiteListMode } from "../bots/botScript.ts";

/**
 * The pirate factions a combat anomaly's name starts with, longest first so
 * "Blood Raider Forlorn Den" loses both words rather than just "Blood".
 * Taken from the server's own combat-anomaly site pack, where every one of the
 * 176 sites starts with exactly one of these.
 */
const FACTION_WORDS: readonly string[] = Object.freeze(["Blood Raider", "Guristas", "Serpentis", "Angel", "Sansha", "Blood"]);

function tidy(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * A site name with its leading faction word taken off, lower case — the form
 * every comparison is made in. A name that IS only a faction word is kept
 * whole: there is no site called "Angel", and emptying it would match nothing
 * the player could see.
 */
export function siteBaseName(name: string): string {
  const whole = tidy(name);
  const lower = whole.toLowerCase();
  for (const word of FACTION_WORDS) {
    const prefix = `${word.toLowerCase()} `;
    if (lower.startsWith(prefix) && lower.length > prefix.length) {
      return lower.slice(prefix.length);
    }
  }
  return lower;
}

/** A site list as a block reads it: the mode, and the names to compare. */
export interface SiteNameList {
  readonly mode: SiteListMode;
  readonly names: readonly string[];
}

/**
 * Whether a site may be flown to under `list`:
 *
 *   • `true`  — yes;
 *   • `false` — the list rules it out;
 *   • `null`  — the site has no name to compare. With a list set this is never
 *     flown to, in either mode: an unnamed site could be the one the player
 *     ruled out, and this block does not warp on a guess (the same rule as an
 *     unreadable site kind).
 *
 * A list with no names is no list at all.
 */
export function siteNameAllowed(name: string | null, list: SiteNameList | null): boolean | null {
  if (list === null || list.names.length === 0) {
    return true;
  }
  if (name === null || tidy(name).length === 0) {
    return null;
  }
  const base = siteBaseName(name);
  const listed = list.names.some((entry) => siteBaseName(entry) === base);
  return list.mode === "only" ? listed : !listed;
}

/**
 * The list in words, for a sentence: "only Haven or Sanctum", "except Den and
 * Hub". The player's own spelling, not the compared form.
 */
export function siteListWords(list: SiteNameList): string {
  const names =
    list.names.length === 1
      ? list.names[0]!
      : `${list.names.slice(0, -1).join(", ")} ${list.mode === "only" ? "or" : "and"} ${list.names.at(-1)!}`;
  return list.mode === "only" ? `only ${names}` : `except ${names}`;
}

/**
 * A list as the run's board carries it, so a block that tours sites on its own
 * (Mine-at-a-belt on an ore site) keeps to the list the warp block was given.
 * The empty string is "no list".
 */
export function encodeSiteList(list: SiteNameList | null): string {
  return list === null || list.names.length === 0 ? "" : JSON.stringify({ mode: list.mode, names: list.names });
}

/** The board's copy read back; null for none, or for anything that is not one. */
export function decodeSiteList(value: unknown): SiteNameList | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as { mode?: unknown; names?: unknown };
    if ((parsed.mode !== "only" && parsed.mode !== "skip") || !Array.isArray(parsed.names)) {
      return null;
    }
    const names = parsed.names.filter((name): name is string => typeof name === "string" && name.trim().length > 0);
    return names.length === 0 ? null : { mode: parsed.mode, names };
  } catch {
    return null;
  }
}

/** One rung of the combat-site ladder, as the picker offers it. */
export interface SiteLadderRung {
  /** The pirate site, faction word left off. */
  readonly pirate: string;
  /** The rogue drone site of the same difficulty. */
  readonly drone: string;
}

/**
 * The combat anomaly ladder, easiest first, pirate and rogue drone side by side
 * (the order the issue that asked for this set out, which is EVE University's
 * Combat site table). The last rung is the two sites a level-10 fleet means:
 * both are "level 10" on the wiki and far harder than the rung before.
 */
export const COMBAT_SITE_LADDER: readonly SiteLadderRung[] = Object.freeze([
  { pirate: "Hideaway", drone: "Drone Cluster" },
  { pirate: "Burrow", drone: "Drone Collection" },
  { pirate: "Refuge", drone: "Drone Assembly" },
  { pirate: "Den", drone: "Drone Gathering" },
  { pirate: "Yard", drone: "Drone Surveillance" },
  { pirate: "Rally Point", drone: "Drone Menagerie" },
  { pirate: "Port", drone: "Drone Herd" },
  { pirate: "Hub", drone: "Drone Squad" },
  { pirate: "Haven", drone: "Drone Patrol" },
  { pirate: "Sanctum", drone: "Drone Horde" },
  { pirate: "Forsaken Sanctum", drone: "Teeming Drone Horde" },
]);

/**
 * The harder variants four of the pirate sites come in. Each is its own site to
 * the matcher: listing "Den" never takes in a "Forlorn Den".
 */
export const COMBAT_SITE_VARIANTS: readonly string[] = Object.freeze(
  ["Hideaway", "Den", "Rally Point", "Hub"].flatMap((site) => ["Hidden", "Forsaken", "Forlorn"].map((variant) => `${variant} ${site}`)),
);

/** One name the site picker offers, with a few words on where it sits. */
export interface SiteSuggestion {
  readonly name: string;
  readonly note: string;
}

/** Every combat site the picker knows, ladder first (easiest first), then the variants. */
const COMBAT_SITE_SUGGESTIONS: readonly SiteSuggestion[] = Object.freeze([
  ...COMBAT_SITE_LADDER.flatMap((rung, index) => {
    const level = index === COMBAT_SITE_LADDER.length - 1 ? `${index}+` : String(index + 1);
    return [
      { name: rung.pirate, note: `level ${level} pirate site` },
      { name: rung.drone, note: `level ${level} rogue drone site` },
    ];
  }),
  ...COMBAT_SITE_VARIANTS.map((name) => ({ name, note: "harder variant" })),
]);

/** How many suggestions the picker shows under the search box. */
const MAX_SITE_SUGGESTIONS = 8;

/**
 * The combat sites whose name contains `query` (ignoring case), leaving out any
 * the list already holds as compared — so "Angel Haven" already listed hides
 * "Haven". Nothing for an empty query: the box suggests as the player types.
 */
export function combatSiteSuggestions(query: string, chosen: readonly string[]): readonly SiteSuggestion[] {
  const q = tidy(query).toLowerCase();
  if (q.length === 0) {
    return [];
  }
  const taken = new Set(chosen.map(siteBaseName));
  return COMBAT_SITE_SUGGESTIONS.filter((entry) => entry.name.toLowerCase().includes(q) && !taken.has(siteBaseName(entry.name))).slice(
    0,
    MAX_SITE_SUGGESTIONS,
  );
}

/** Is `name` already on the list, compared the way the block compares? */
export function siteListHas(chosen: readonly string[], name: string): boolean {
  const base = siteBaseName(name);
  return chosen.some((entry) => siteBaseName(entry) === base);
}
