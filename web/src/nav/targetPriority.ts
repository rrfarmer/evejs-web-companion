// Which hostile to shoot FIRST. A fight is decided by what dies in what order:
// the frigate holding you down is worth more dead than the battleship you could
// simply have warped away from. Every combat block until now shot whatever was
// NEAREST, which is the one ordering that ignores the question entirely.
//
// ⚠ HULL CLASS IS A PROXY, AND IT IS THE ONLY ONE THERE IS. Nothing in a grid
// read says what a ship has FITTED — a snapshot row carries position, health,
// owner and type, never modules — and no read tells this client "that one is
// pointing me". So a class here is the job the HULL was built for, read from
// the game's own group name: an Interceptor is tackle because that is what
// interceptors are for, not because this one was seen holding anybody. A
// battleship with a scrambler on it reads "other" and a Logistics hull with no
// reps fitted still reads "logi". Said plainly so nobody reads more into a
// class than it carries — this is a better opening guess than distance, not
// knowledge of the enemy fit.
//
// The group name is resolved through /api/names (`typeGroup`), the same
// resolve-then-judge pass nav/droneRoles.ts makes: the game says what a hull IS
// and this file only reads the answer. Matched EXACTLY (trimmed, lowercased)
// against the SDE's own ship-group names — verified against the local SDE
// (`groups.jsonl`, categoryID 6, the build src/config.js pins):
//
//   tackle  831 "Interceptor", 541 "Interdictor", 894 "Heavy Interdiction Cruiser"
//   ewar    893 "Electronic Attack Ship", 833 "Force Recon Ship", 906 "Combat Recon Ship"
//   logi    832 "Logistics", 1527 "Logistics Frigate", 1538 "Force Auxiliary"
//
// EXACT, never a loose /recon/i or /logi/i, for the same reason droneRoles.ts
// anchors its patterns: "Prototype Exploration Ship" and "Industrial Command
// Ship" are neither of those things, and a substring match against a localised
// name is how a hauler ends up primaried.
//
// ⚠ THE GROUP LIST ABOVE IS PLAYER HULLS, AND A RAT IS NOT ONE. Every NPC in
// the static data is an "Asteroid Serpentis Frigate" or a "Deadspace Angel
// Cartel Cruiser", so against rats the group classifier answers "other" for the
// whole grid and the player's ordering does nothing at all — nearest-first,
// wearing a priority list. That is what `targetClassForThreat` below is for: a
// rat's OWN dogma says what it does, and `nav/ratThreat.ts` reads it. The dogma
// is asked first and the group answers only when the dogma said nothing, so
// player hulls keep exactly the classification they had.

import type { TargetClassArg } from "../bots/botScript.ts";
import type { RatThreat } from "./ratThreat.ts";

/**
 * The job a hull was built for, as far as a grid read can tell. The vocabulary
 * itself belongs to the document format (a saved script carries the player's
 * ordering of it), so it is named there and only interpreted here.
 */
export type TargetClass = TargetClassArg;

/**
 * The shipped order, and the order unlisted classes keep among themselves.
 *
 * Tackle first because it is what stops the ship LEAVING — every other problem
 * on the grid has an exit while it is alive. Ewar second because it stops the
 * ship FIGHTING (a jammed hull cannot shoot the tackle either). Logi third
 * because it undoes damage rather than dealing it. Everything else last, which
 * is where the old nearest-first behaviour lives on: within one class the
 * nearest is still taken first.
 */
export const DEFAULT_TARGET_PRIORITY: readonly TargetClass[] = ["tackle", "ewar", "logi", "other"];

const TACKLE_GROUPS = new Set(["interceptor", "interdictor", "heavy interdiction cruiser"]);
const EWAR_GROUPS = new Set(["electronic attack ship", "force recon ship", "combat recon ship"]);
const LOGI_GROUPS = new Set(["logistics", "logistics frigate", "force auxiliary"]);

/**
 * The class for a resolved group name. `null` = the group has not resolved (or
 * could not be read) — cannot tell, which is NEVER promoted: an unclassified
 * hull is ranked with "other" rather than guessed into a class it may not be.
 */
export function targetClassForGroup(groupName: string | null | undefined): TargetClass | null {
  if (groupName === null || groupName === undefined) {
    return null;
  }
  const name = groupName.trim().toLowerCase();
  if (TACKLE_GROUPS.has(name)) {
    return "tackle";
  }
  if (EWAR_GROUPS.has(name)) {
    return "ewar";
  }
  if (LOGI_GROUPS.has(name)) {
    return "logi";
  }
  return "other";
}

// ── the rat's own dogma ──────────────────────────────────────────────────────

/**
 * The class a rat's own dogma puts it in, or null when the dogma says nothing.
 *
 * ⚠ NULL IS NOT "other". "other" is a verdict — this hull was read and it is an
 * ordinary thing to shoot. Null is "the dogma did not classify it", which is
 * what a caller needs in order to fall back to `targetClassForGroup` for a
 * PLAYER hull, whose threat map is empty for a reason that has nothing to do
 * with being harmless. Answering "other" here would win that fallback race and
 * flatten every player hull to "other" — the old classifier would never be
 * asked again.
 *
 * Scram and web both land in `tackle` because the class vocabulary is the
 * player's and it is closed: both of them are the thing that stops the ship
 * leaving. `tackleSubRank` is where the two are separated.
 *
 * A rat that both holds and damps is tackle, not ewar — the worse of the two
 * jobs decides, the same way the shipped order puts tackle above ewar.
 */
export function targetClassForThreat(threat: RatThreat | null | undefined): TargetClass | null {
  if (threat === null || threat === undefined) {
    return null;
  }
  if (threat.scram || threat.web) {
    return "tackle";
  }
  if (threat.ewar) {
    return "ewar";
  }
  return null;
}

/**
 * Within `tackle`: a scrammer dies before a webber. 0 = first.
 *
 * ⚠ A SCRAM STOPS YOU LEAVING; A WEB ONLY SLOWS YOU DOWN. That is the whole of
 * the reason this sub-rank exists. A webbed ship can still align out, still
 * warp, still leave a fight it is losing — slowly, and it still leaves. A
 * scrammed one cannot, so every other problem on the grid is survivable while
 * the scrammer is not. Killing the webber first is the ordering that gets a
 * ship killed with its exit still shut.
 *
 * Anything that is not tackle (and anything unknown) answers 2: a finite rank
 * that ties every non-tackle row against every other, so this can be compared
 * unconditionally without reordering rows it has no opinion about.
 */
export function tackleSubRank(threat: RatThreat | null | undefined): number {
  if (threat === null || threat === undefined) {
    return 2;
  }
  if (threat.scram) {
    return 0;
  }
  if (threat.web) {
    return 1;
  }
  return 2;
}

/**
 * The sub-rank `pickPrimary` compares: `tackleSubRank` inside tackle, and inside
 * ewar a jammer before every other kind. 0 = first.
 *
 * ⚠ A JAM TAKES THE LOCK; A DAMP, A NEUT AND A PAINT ONLY DEGRADE IT. A jammed
 * ship cannot shoot anything at all until the cycle ends, which is the same
 * argument that puts ewar above logi, one level down: the ewar that switches the
 * ship off outright dies before the ewar that merely makes it worse.
 *
 * ONE NUMBER SERVES BOTH CLASSES because it is only ever compared between rows
 * of the same class rank. A tackle row and an ewar row never meet in this
 * comparison (class decides first), so scram 0 / web 1 and ECM 0 / other ewar 1
 * can share the scale without one meaning the other. A rat that is both tackle
 * and ECM is a tackle row and takes its tackle sub-rank; the worse job decides,
 * as it does for the class.
 *
 * Anything with no opinion (no threat, nothing flagged) answers 2, the same
 * finite tie rank `tackleSubRank` uses, so the comparison is unconditional.
 */
export function threatSubRank(threat: RatThreat | null | undefined): number {
  if (threat === null || threat === undefined) {
    return 2;
  }
  if (threat.scram || threat.web) {
    return tackleSubRank(threat);
  }
  if (threat.ecm) {
    return 0;
  }
  if (threat.ewar) {
    return 1;
  }
  return 2;
}

/**
 * Where a class sits in one player's ordering.
 *
 * ⚠ A PRIORITY LIST IS A RANKING, NOT A FILTER. This is the one place it
 * differs from the mine block's ore list, which mines ONLY what it names and
 * blocks when none is left: a combat block that refused to shoot anything off
 * its list would sit there being killed by the battleship it had no line for.
 * So a class the player left out ranks AFTER every class they listed, in the
 * shipped default order — last in line, never unshootable.
 */
function rankOf(cls: TargetClass | null, priority: readonly TargetClass[]): number {
  const known: TargetClass = cls ?? "other";
  const listed = priority.indexOf(known);
  return listed >= 0 ? listed : priority.length + DEFAULT_TARGET_PRIORITY.indexOf(known);
}

// ── fleet tags ───────────────────────────────────────────────────────────────
//
// ⚠ THE ALPHABET IS OURS, AND THE READER MUST TOLERATE ANYTHING. There is NO
// tag vocabulary on the server — the broadcast decoder trims and accepts any
// non-empty string, no allowlist and no ordering exists there. STOCK_TAG_ORDER
// below is this client's OWN opinion about the stock game client's tag menu
// (the only tags a human FC clicking through that menu can actually send), not
// a protocol constraint. A non-stock client, or a hand-typed broadcast, can
// carry any string at all, and fleetTagRank MUST still return a finite rank
// for it (see the fallback below) — never treat "not in our list" as "drop
// it", or a tag this code has not heard of silently stops being a target the
// fleet singled out.
//
// Digits before letters: a digit tag reads as an ordinal kill order (1st,
// 2nd, ...) — the most explicit "shoot this now" a human can send — so the
// whole digit group outranks the whole letter group, which carries no
// inherent order of its own. Within digits, keyboard-row order (1-9 then 0)
// rather than numeric order: these are quick-select hotkeys, and 0 sits after
// 9 on every keyboard row they'd be bound to. Within letters, the menu's own
// listed order (A-J, then the classic K-W gap, then X Y Z) — there is no
// other signal to rank them by, so the order the menu presents them in is the
// order kept.
const STOCK_TAG_ORDER: readonly string[] = [
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "X", "Y", "Z",
];

const STOCK_TAG_RANK: ReadonlyMap<string, number> = new Map(
  STOCK_TAG_ORDER.map((tag, index) => [tag, index]),
);

/**
 * Where a fleet-assigned tag sits in the kill order. Lower ranks first, same
 * convention as `rankOf`.
 *
 * An absent tag (null, undefined, or all-whitespace) ranks below every real
 * tag — POSITIVE_INFINITY, so it only wins when nothing tagged is on the
 * grid. A tag outside STOCK_TAG_ORDER — ⚠ which the server tolerates and this
 * function must too — ranks at STOCK_TAG_ORDER.length: worse than every
 * recognised tag, but still finite, so it is never mistaken for "no tag" and
 * never dropped. Matched case-insensitively: a hand-typed "a" and the menu's
 * "A" are the same instruction.
 */
export function fleetTagRank(tag: string | null | undefined): number {
  if (tag === null || tag === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const trimmed = tag.trim();
  if (trimmed.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const known = STOCK_TAG_RANK.get(trimmed.toUpperCase());
  return known ?? STOCK_TAG_ORDER.length;
}

/**
 * The itemID a row carries when the caller did not say how to read one.
 *
 * ⚠ A GAP IN THE SHAPE, NOT A CONVENTION TO LEAN ON. `pickPrimary` is generic
 * over the row on purpose — the caller hands in how to read a type and a
 * distance — but `jammingSources` is a set of ITEM ids, and there was no
 * accessor for a row's identity to match them against. Every call site in this
 * tree (overview rows and snapshot entities alike) names that field `itemID`,
 * so that is what this reads, and a caller whose row calls it something else
 * passes `itemIDOf` explicitly. The alternative was to have the live jam feed
 * silently do nothing for a caller that forgot an accessor, which is the worst
 * failure available here: the server told us which rat is holding this ship and
 * we ignored it.
 */
function defaultItemIDOf<T>(row: T): number | null {
  const id = (row as { readonly itemID?: unknown }).itemID;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

/**
 * The row to shoot first: the fleet's tag wins, the live jam feed breaks that,
 * class breaks that, and nearest breaks what's left.
 *
 * Shaped like `splitDroneRoles` — the caller hands in how to read a row's type
 * and distance and how to resolve a group name, so this stays pure and both
 * combat call sites (overview rows with a measured distance, snapshot entities
 * measured against the ship) can use the one ordering.
 *
 * ⚠ TAG OUTRANKS EVERYTHING, DELIBERATELY. Class priority is this client's own
 * guess at what matters most on a grid it cannot see modules on (see the
 * file-header note). A tag is not a guess — it is the fleet commander looking
 * at the fight and saying "this one, now". When the two disagree the human
 * wins, so tag is compared FIRST.
 *
 * ⚠ A LIVE JAM SOURCE IS NOT A GUESS EITHER, SO IT OUTRANKS THE CLASS. A
 * typeID in `threat` is a statement about what a hull of that type CAN do; an
 * itemID in `jammingSources` is the server's own `OnJamStart` push naming THIS
 * specific rat as holding THIS specific ship right now. Ground truth beats the
 * static read, including for a type whose dogma this client read wrong or
 * never fetched — so a jamming row is promoted above every row it is not
 * already ahead of on tag, class or dogma alike. It still loses to the FC's
 * tag, for the same reason class does: the human is looking at the fight.
 *
 * The class itself comes from the rat's dogma FIRST (`targetClassForThreat`)
 * and falls back to the group name (`targetClassForGroup`) when the dogma said
 * nothing — the NPC half and the player half of the same ladder, in the one
 * order that lets each answer the rows it can actually see.
 *
 * ⚠ AND IT IS STILL A RANKING, NOT A FILTER. None of the four comparisons ever
 * removes a row: a class the player left off ranks last, a rat nobody could
 * classify ranks with "other", and an unmeasurable distance sorts last inside
 * its group. The worst thing that happens to any row here is being shot second.
 *
 * SIZE IS THE LAST THING BEFORE DISTANCE: up the chain, smallest hull first.
 * Once tag, live jam, class and sub-rank are level, the small hull dies before
 * the big one - frigates track and hit hardest at close range and are the
 * quickest to remove, so every kill thins the damage taken fastest. `sizeOf`
 * reads the target's SIGNATURE RADIUS in metres, not a group-name size word:
 * radius is the number the server's turret and drone hit formula runs on, and it
 * exists for every rat type, where "Frigate" / "Cruiser" in a name is missing
 * for officers, haulers and rogue drones. A size that cannot be read (null) sorts
 * AFTER every known size - not-told is never "smallest" - and then distance
 * decides, so an unreadable row is still a target.
 *
 * Every new parameter is optional and defaults to "nothing is known", which
 * collapses the ordering back to exactly the old (class, distance) behaviour —
 * `tagOf` to "nothing is tagged", `threat` to "no dogma was read" (so the group
 * classifier decides alone, as it did), `jammingSources` to "nothing is holding
 * us", `sizeOf` to "every size is unknown" (all rows tie on size, so distance
 * decides as before). Every existing caller keeps its current result unchanged.
 *
 * A row whose distance is unreadable sorts last WITHIN its tag-and-class
 * group rather than being dropped: an unmeasurable ship is still a ship, and
 * dropping it would hand the fight to whatever the measurement happened to
 * miss. Ties keep the order the caller passed, so a nearest-first list stays
 * nearest-first.
 */
export function pickPrimary<T>(
  rows: readonly T[],
  typeIDOf: (row: T) => number | null,
  distanceOf: (row: T) => number | null,
  groupOf: (typeID: number) => string | null,
  priority: readonly TargetClass[] = DEFAULT_TARGET_PRIORITY,
  tagOf: (row: T) => string | null | undefined = () => null,
  threat?: (typeID: number) => RatThreat | null,
  jammingSources?: ReadonlySet<number>,
  itemIDOf: (row: T) => number | null = defaultItemIDOf,
  sizeOf?: (row: T) => number | null,
): T | null {
  let best: T | null = null;
  let bestTagRank = Number.POSITIVE_INFINITY;
  let bestJamRank = Number.POSITIVE_INFINITY;
  let bestClassRank = Number.POSITIVE_INFINITY;
  let bestSubRank = Number.POSITIVE_INFINITY;
  let bestSize = Number.POSITIVE_INFINITY;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const typeID = typeIDOf(row);
    // The dogma answers for rats, the group name for player hulls, and the
    // dogma is asked first — a rat has no group this file knows, and a player
    // hull has no entity dogma to read, so the two never argue in practice.
    const rowThreat = threat !== undefined && typeID !== null ? threat(typeID) : null;
    const cls =
      targetClassForThreat(rowThreat) ?? targetClassForGroup(typeID === null ? null : groupOf(typeID));
    const classRank = rankOf(cls, priority);
    const subRank = threatSubRank(rowThreat);
    // An unreadable (or non-finite) size is the largest possible one, so it
    // sorts after every known size and ties with other unknowns.
    const rawSize = sizeOf === undefined ? null : sizeOf(row);
    const size = rawSize !== null && Number.isFinite(rawSize) ? rawSize : Number.POSITIVE_INFINITY;
    const tagRank = fleetTagRank(tagOf(row));
    const itemID = jammingSources === undefined ? null : itemIDOf(row);
    const jamRank = itemID !== null && jammingSources?.has(itemID) === true ? 0 : 1;
    const distance = distanceOf(row) ?? Number.POSITIVE_INFINITY;
    const better =
      tagRank < bestTagRank ||
      (tagRank === bestTagRank &&
        (jamRank < bestJamRank ||
          (jamRank === bestJamRank &&
            (classRank < bestClassRank ||
              (classRank === bestClassRank &&
                (subRank < bestSubRank ||
                  (subRank === bestSubRank &&
                    (size < bestSize || (size === bestSize && distance < bestDistance)))))))));
    if (better) {
      best = row;
      bestTagRank = tagRank;
      bestJamRank = jamRank;
      bestClassRank = classRank;
      bestSubRank = subRank;
      bestSize = size;
      bestDistance = distance;
    }
  }
  return best;
}
