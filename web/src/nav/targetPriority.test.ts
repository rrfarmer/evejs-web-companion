// The target-priority ladder: the game's ship-group name in, the job the hull
// was built for out, and the one ordering both combat call sites pick with.
// Pins the exact matching (a "Prototype Exploration Ship" is not a recon), the
// cannot-tell rule (an unresolved group is never promoted), and the ranking —
// NOT filtering — rule that keeps an unlisted class shootable.

import test from "node:test";
import assert from "node:assert/strict";

import { TARGET_CLASS_ARGS } from "../bots/botScript.ts";
import { UNKNOWN_THREAT, threatFromAttributes } from "./ratThreat.ts";
import {
  DEFAULT_TARGET_PRIORITY,
  fleetTagRank,
  pickPrimary,
  tackleSubRank,
  threatSubRank,
  targetClassForGroup,
  targetClassForThreat,
} from "./targetPriority.ts";

test("the game's own ship groups map to the jobs a fight is decided by", () => {
  for (const group of ["Interceptor", "Interdictor", "Heavy Interdiction Cruiser"]) {
    assert.equal(targetClassForGroup(group), "tackle", group);
  }
  for (const group of ["Electronic Attack Ship", "Force Recon Ship", "Combat Recon Ship"]) {
    assert.equal(targetClassForGroup(group), "ewar", group);
  }
  for (const group of ["Logistics", "Logistics Frigate", "Force Auxiliary"]) {
    assert.equal(targetClassForGroup(group), "logi", group);
  }
  assert.equal(targetClassForGroup("  interceptor  "), "tackle", "case and padding are not load-bearing");
});

test("every other hull is 'other' — still shot, just not first", () => {
  for (const group of ["Battleship", "Frigate", "Assault Frigate", "Command Ship", "Covert Ops", "Mining Barge"]) {
    assert.equal(targetClassForGroup(group), "other", group);
  }
});

test("the match is exact — hulls that merely read like a class do not qualify", () => {
  assert.equal(targetClassForGroup("Prototype Exploration Ship"), "other");
  assert.equal(targetClassForGroup("Industrial Command Ship"), "other");
  assert.equal(targetClassForGroup("Logistics Blueprint"), "other");
  assert.equal(targetClassForGroup("Heavy Assault Cruiser"), "other");
});

test("an unresolved group is NO class, not a guess", () => {
  assert.equal(targetClassForGroup(null), null);
  assert.equal(targetClassForGroup(undefined), null);
});

// ── the pick ─────────────────────────────────────────────────────────────────

interface Row {
  readonly id: number;
  readonly typeID: number | null;
  readonly distance: number | null;
  readonly tag?: string | null;
}

const GROUPS: Record<number, string> = {
  11176: "Interceptor", // a tackle hull
  11995: "Combat Recon Ship", // an ewar hull
  11985: "Logistics", // a logi hull
  645: "Battleship", // everything else
};

function pick(rows: readonly Row[], priority = DEFAULT_TARGET_PRIORITY): Row | null {
  return pickPrimary(
    rows,
    (row) => row.typeID,
    (row) => row.distance,
    (typeID) => GROUPS[typeID] ?? null,
    priority,
  );
}

// Same rows, but the fleet's tag is read too — the call path scriptMacros.ts
// will use once broadcasts feed pickPrimary a tag.
function pickTagged(rows: readonly Row[], priority = DEFAULT_TARGET_PRIORITY): Row | null {
  return pickPrimary(
    rows,
    (row) => row.typeID,
    (row) => row.distance,
    (typeID) => GROUPS[typeID] ?? null,
    priority,
    (row) => row.tag,
  );
}

test("class beats distance — the far tackle dies before the near battleship", () => {
  const battleship = { id: 1, typeID: 645, distance: 2_000 };
  const interceptor = { id: 2, typeID: 11176, distance: 40_000 };
  assert.equal(pick([battleship, interceptor])?.id, 2);
});

test("inside one class the nearest still wins, and ties keep the caller's order", () => {
  const near = { id: 1, typeID: 645, distance: 5_000 };
  const far = { id: 2, typeID: 645, distance: 30_000 };
  assert.equal(pick([far, near])?.id, 1);
  const tiedFirst = { id: 3, typeID: 645, distance: 5_000 };
  assert.equal(pick([near, tiedFirst])?.id, 1, "a tie is not a reshuffle");
});

test("the whole ladder is honoured, not just its first rung", () => {
  const battleship = { id: 1, typeID: 645, distance: 1_000 };
  const logi = { id: 2, typeID: 11985, distance: 50_000 };
  const recon = { id: 3, typeID: 11995, distance: 60_000 };
  assert.equal(pick([battleship, logi, recon])?.id, 3, "ewar outranks logi outranks the rest");
  assert.equal(pick([battleship, logi])?.id, 2);
});

test("a player's own order is followed", () => {
  const interceptor = { id: 1, typeID: 11176, distance: 30_000 };
  const logi = { id: 2, typeID: 11985, distance: 30_000 };
  assert.equal(pick([interceptor, logi], ["logi", "tackle", "ewar", "other"])?.id, 2);
});

test("a class left off the list is LAST, never unshootable", () => {
  // "Kill the tackle" alone: a lone battleship is still the primary, because a
  // block that refuses everything off its list just sits there and dies.
  const battleship = { id: 1, typeID: 645, distance: 10_000 };
  assert.equal(pick([battleship], ["tackle"])?.id, 1);
  // And it still loses to the class that WAS named.
  const interceptor = { id: 2, typeID: 11176, distance: 90_000 };
  assert.equal(pick([battleship, interceptor], ["tackle"])?.id, 2);
});

test("unlisted classes keep the shipped order among themselves", () => {
  const logi = { id: 1, typeID: 11985, distance: 40_000 };
  const battleship = { id: 2, typeID: 645, distance: 1_000 };
  assert.equal(pick([battleship, logi], ["tackle"])?.id, 1, "logi still outranks 'other'");
});

test("an unresolved hull is ranked with 'other' — never promoted, never dropped", () => {
  const unknown = { id: 1, typeID: 99999, distance: 1_000 };
  const interceptor = { id: 2, typeID: 11176, distance: 80_000 };
  assert.equal(pick([unknown, interceptor])?.id, 2, "a hull nobody could name never outranks known tackle");
  assert.equal(pick([unknown])?.id, 1, "and it is still a target when it is all there is");
  const noType = { id: 3, typeID: null, distance: 500 };
  assert.equal(pick([noType])?.id, 3);
});

test("an unmeasurable distance sorts last inside its class, not out of the fight", () => {
  const measured = { id: 1, typeID: 645, distance: 20_000 };
  const unmeasured = { id: 2, typeID: 645, distance: null };
  assert.equal(pick([unmeasured, measured])?.id, 1);
  assert.equal(pick([unmeasured])?.id, 2);
});

test("no rows, no primary", () => {
  assert.equal(pick([]), null);
});

test("the shipped order covers the format's whole vocabulary", () => {
  // Two lists on purpose — the codec's is the FORMAT vocabulary, this one is the
  // shipped ordering — so a class added to one and forgotten in the other would
  // rank as "unlisted" forever. This is the check that catches that.
  assert.deepEqual([...DEFAULT_TARGET_PRIORITY].sort(), [...TARGET_CLASS_ARGS].sort());
});

// ── fleet tags ───────────────────────────────────────────────────────────────

test("the stock menu's tags rank in the documented order: digits 1-9-0, then A-J, X, Y, Z", () => {
  const STOCK_ORDER = [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
    "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "X", "Y", "Z",
  ];
  for (let i = 1; i < STOCK_ORDER.length; i++) {
    assert.ok(
      fleetTagRank(STOCK_ORDER[i - 1]) < fleetTagRank(STOCK_ORDER[i]),
      `${STOCK_ORDER[i - 1]} should outrank ${STOCK_ORDER[i]}`,
    );
  }
  assert.ok(fleetTagRank("9") < fleetTagRank("0"), "0 sits after 9, keyboard-row order not numeric order");
  assert.ok(fleetTagRank("J") < fleetTagRank("X"), "the K-W gap does not break the letters' order");
});

test("tags are read case-insensitively — a hand-typed lowercase tag is the same instruction", () => {
  assert.equal(fleetTagRank("a"), fleetTagRank("A"));
  assert.equal(fleetTagRank("z"), fleetTagRank("Z"));
});

test("an unrecognised tag ranks last among tagged ships — never dropped", () => {
  // ⚠ There is no server-side allowlist: a non-stock client can broadcast any
  // string. This is the check that such a tag still gets a finite rank.
  const weird = fleetTagRank("!!custom-tag!!");
  assert.ok(Number.isFinite(weird), "an unrecognised tag must still rank, not vanish");
  assert.ok(weird > fleetTagRank("Z"), "it ranks worse than every stock tag");
  assert.ok(weird < fleetTagRank(null), "but it still beats having no tag at all");
});

test("an absent tag ranks below every tagged ship, recognised or not", () => {
  for (const empty of [null, undefined, "", "   "]) {
    assert.equal(fleetTagRank(empty), Number.POSITIVE_INFINITY, JSON.stringify(empty));
  }
});

test("a tagged ship beats an untagged one, regardless of class or distance", () => {
  const closeUntaggedTackle = { id: 1, typeID: 11176, distance: 1_000 };
  const farTaggedBattleship = { id: 2, typeID: 645, distance: 80_000, tag: "1" };
  assert.equal(pickTagged([closeUntaggedTackle, farTaggedBattleship])?.id, 2);
});

test("tag outranks class, deliberately — the FC's call beats this client's own guess", () => {
  const untaggedInterceptor = { id: 1, typeID: 11176, distance: 5_000 }; // best class, untagged
  const taggedBattleship = { id: 2, typeID: 645, distance: 90_000, tag: "5" }; // worst class, tagged
  assert.equal(pickTagged([untaggedInterceptor, taggedBattleship])?.id, 2);
});

test("among tagged ships, the documented tag order decides — not class or distance", () => {
  const tag2Interceptor = { id: 1, typeID: 11176, distance: 1_000, tag: "2" };
  const tag1Battleship = { id: 2, typeID: 645, distance: 90_000, tag: "1" };
  assert.equal(pickTagged([tag2Interceptor, tag1Battleship])?.id, 2, "1 outranks 2 regardless of class/distance");
});

test("distance still breaks ties within equal tag and equal class", () => {
  const near = { id: 1, typeID: 645, distance: 5_000, tag: "1" };
  const far = { id: 2, typeID: 645, distance: 30_000, tag: "1" };
  assert.equal(pickTagged([far, near])?.id, 1);
});

test("the no-tag-accessor call path is unchanged", () => {
  // pick() never passes a tagOf — every existing caller of pickPrimary looks
  // like this. Same rows through pick() and pickTagged() (where nothing on
  // the rows carries a `tag`) must land on the same primary.
  const battleship = { id: 1, typeID: 645, distance: 2_000 };
  const interceptor = { id: 2, typeID: 11176, distance: 40_000 };
  assert.equal(pick([battleship, interceptor])?.id, pickTagged([battleship, interceptor])?.id);
});

// ── the rat's own dogma ──────────────────────────────────────────────────────
//
// The NPC half of the ladder. The rows here are rats, whose GROUP is always
// something like "Asteroid Serpentis Frigate" — a name the group classifier has
// never heard of and answers "other" for — so every one of these tests would
// come out nearest-first without the dogma being read.

const SCRAM_RAT = 1; // entityWarpScrambleChance 0.25, warpScrambleRange 20 km
const WEB_RAT = 2; // speedFactor -50, no scramble chance
const DAMP_RAT = 3; // entitySensorDampenDurationChance 0.05
const PLAIN_RAT = 4; // carries the attributes, all of them zero

const RAT_ATTRIBUTES: Record<number, Record<number, number>> = {
  [SCRAM_RAT]: { 20: -50, 103: 20_000, 504: 0.25 },
  [WEB_RAT]: { 20: -50, 103: 0, 504: 0 },
  [DAMP_RAT]: { 20: 0, 103: 0, 504: 0, 932: 0.05 },
  [PLAIN_RAT]: { 20: 0, 103: 0, 504: 0 },
};

// Every rat resolves to an NPC group name, exactly as the live read would —
// the point being that it tells the classifier nothing.
const RAT_GROUPS: Record<number, string> = {
  [SCRAM_RAT]: "Asteroid Guristas Frigate",
  [WEB_RAT]: "Asteroid Angel Cartel Frigate",
  [DAMP_RAT]: "Asteroid Serpentis Cruiser",
  [PLAIN_RAT]: "Asteroid Guristas Frigate",
};

function ratThreatOf(typeID: number) {
  const attributes = RAT_ATTRIBUTES[typeID];
  return attributes === undefined ? null : threatFromAttributes(attributes);
}

/** The full call: dogma, group fallback, and the live jam list. */
function pickRats(
  rows: readonly Row[],
  priority = DEFAULT_TARGET_PRIORITY,
  jamming?: ReadonlySet<number>,
): Row | null {
  return pickPrimary(
    rows,
    (row) => row.typeID,
    (row) => row.distance,
    (typeID) => RAT_GROUPS[typeID] ?? GROUPS[typeID] ?? null,
    priority,
    (row) => row.tag,
    ratThreatOf,
    jamming,
    (row) => row.id,
  );
}

test("a rat's dogma puts it in a class; nothing about it is a hull name", () => {
  assert.equal(targetClassForThreat(threatFromAttributes(RAT_ATTRIBUTES[SCRAM_RAT])), "tackle");
  assert.equal(targetClassForThreat(threatFromAttributes(RAT_ATTRIBUTES[WEB_RAT])), "tackle");
  assert.equal(targetClassForThreat(threatFromAttributes(RAT_ATTRIBUTES[DAMP_RAT])), "ewar");
});

test("a dogma that says nothing is NULL, not 'other' — the group classifier still gets its turn", () => {
  // ⚠ If this returned "other" it would win the fallback race in pickPrimary
  // and every player hull would flatten to "other" forever.
  assert.equal(targetClassForThreat(threatFromAttributes(RAT_ATTRIBUTES[PLAIN_RAT])), null);
  assert.equal(targetClassForThreat(UNKNOWN_THREAT), null, "'not told' is not 'ordinary'");
  assert.equal(targetClassForThreat(null), null);
  assert.equal(targetClassForThreat(undefined), null);
});

test("a scrammer sub-ranks ahead of a webber — a scram shuts the exit, a web only narrows it", () => {
  assert.equal(tackleSubRank(threatFromAttributes(RAT_ATTRIBUTES[SCRAM_RAT])), 0);
  assert.equal(tackleSubRank(threatFromAttributes(RAT_ATTRIBUTES[WEB_RAT])), 1);
  // Everything else ties at a finite rank, so the comparison never reorders
  // rows it has no opinion about.
  assert.equal(tackleSubRank(threatFromAttributes(RAT_ATTRIBUTES[DAMP_RAT])), 2);
  assert.equal(tackleSubRank(UNKNOWN_THREAT), 2);
  assert.equal(tackleSubRank(null), 2);
  assert.equal(tackleSubRank(undefined), 2);
});

test("the dogma beats the group for an NPC — the whole reason the classifier was split", () => {
  const tackleRat = { id: 11, typeID: SCRAM_RAT, distance: 50_000 };
  const plainRat = { id: 12, typeID: PLAIN_RAT, distance: 2_000 };
  // Both groups read "other". Nearest-first would take the plain one; the
  // dogma says the far one is holding the exit shut.
  assert.equal(pickRats([plainRat, tackleRat])?.id, 11);
  assert.equal(pick([plainRat, tackleRat])?.id, 12, "and without the dogma it is nearest-first, as before");
});

test("a scrammer dies before a webber, even when the webber is closer", () => {
  const webRat = { id: 21, typeID: WEB_RAT, distance: 3_000 };
  const scramRat = { id: 22, typeID: SCRAM_RAT, distance: 45_000 };
  assert.equal(pickRats([webRat, scramRat])?.id, 22);
});

test("the rat ladder keeps the shipped order: tackle, then ewar, then the rest", () => {
  const plainRat = { id: 31, typeID: PLAIN_RAT, distance: 1_000 };
  const dampRat = { id: 32, typeID: DAMP_RAT, distance: 40_000 };
  const webRat = { id: 33, typeID: WEB_RAT, distance: 60_000 };
  assert.equal(pickRats([plainRat, dampRat, webRat])?.id, 33);
  assert.equal(pickRats([plainRat, dampRat])?.id, 32);
});

test("nearest still breaks the tie between rats the dogma reads the same way", () => {
  const far = { id: 41, typeID: SCRAM_RAT, distance: 30_000 };
  const near = { id: 42, typeID: SCRAM_RAT, distance: 6_000 };
  assert.equal(pickRats([far, near])?.id, 42);
  const tiedFirst = { id: 43, typeID: SCRAM_RAT, distance: 6_000 };
  assert.equal(pickRats([near, tiedFirst])?.id, 42, "a tie is not a reshuffle");
});

test("the group still decides when the dogma says nothing — no regression for player hulls", () => {
  // A player Interceptor has no entity dogma at all: ratThreatOf answers null
  // for it, and the group classifier must still call it tackle.
  const battleship = { id: 51, typeID: 645, distance: 2_000 };
  const interceptor = { id: 52, typeID: 11176, distance: 40_000 };
  assert.equal(pickRats([battleship, interceptor])?.id, 52);
  assert.equal(
    pickRats([battleship, interceptor])?.id,
    pick([battleship, interceptor])?.id,
    "the same answer the group classifier gave before the dogma existed",
  );
  // And the whole player ladder is unchanged through the new call path.
  const logi = { id: 53, typeID: 11985, distance: 50_000 };
  const recon = { id: 54, typeID: 11995, distance: 60_000 };
  assert.equal(pickRats([battleship, logi, recon])?.id, 54);
});

test("a rat whose dogma says 'ordinary' is ranked with 'other', never dropped", () => {
  const plainRat = { id: 61, typeID: PLAIN_RAT, distance: 9_000 };
  assert.equal(pickRats([plainRat])?.id, 61);
  const scramRat = { id: 62, typeID: SCRAM_RAT, distance: 90_000 };
  assert.equal(pickRats([plainRat, scramRat])?.id, 62);
});

// ── the live jam feed ────────────────────────────────────────────────────────

test("a rat the server says is holding us now outranks a statically-equal one", () => {
  // Same type, so the same dogma, the same class and the same sub-rank; the
  // only difference is OnJamStart naming this itemID. Ground truth beats the
  // static read.
  const holding = { id: 71, typeID: WEB_RAT, distance: 40_000 };
  const identical = { id: 72, typeID: WEB_RAT, distance: 3_000 };
  assert.equal(pickRats([identical, holding], DEFAULT_TARGET_PRIORITY, new Set([71]))?.id, 71);
  assert.equal(pickRats([identical, holding])?.id, 72, "without the live feed, nearest wins");
});

test("the live feed beats the dogma, including for a type this client read as harmless", () => {
  // The failure it exists for: a rat whose attributes we never fetched (or
  // read wrong) is actually pointing the ship. The server said so by name.
  const plainRat = { id: 81, typeID: PLAIN_RAT, distance: 20_000 };
  const scramRat = { id: 82, typeID: SCRAM_RAT, distance: 20_000 };
  assert.equal(pickRats([scramRat, plainRat], DEFAULT_TARGET_PRIORITY, new Set([81]))?.id, 81);
});

test("the FC's tag still beats the live feed — the human is looking at the fight", () => {
  const jamming = { id: 91, typeID: SCRAM_RAT, distance: 5_000 };
  const tagged = { id: 92, typeID: PLAIN_RAT, distance: 90_000, tag: "1" };
  assert.equal(pickRats([jamming, tagged], DEFAULT_TARGET_PRIORITY, new Set([91]))?.id, 92);
});

test("an empty jam list changes nothing, and an unknown source id is simply not there", () => {
  const near = { id: 101, typeID: PLAIN_RAT, distance: 4_000 };
  const far = { id: 102, typeID: PLAIN_RAT, distance: 40_000 };
  assert.equal(pickRats([far, near], DEFAULT_TARGET_PRIORITY, new Set())?.id, 101);
  assert.equal(pickRats([far, near], DEFAULT_TARGET_PRIORITY, new Set([999]))?.id, 101);
});

test("the jam promotion reads the row's own itemID when no accessor is handed in", () => {
  // ⚠ The gap `defaultItemIDOf` covers: `jammingSources` holds item ids and
  // pickPrimary is generic over the row. Every call site in this tree names the
  // field `itemID`, and a caller that forgets the accessor must not silently
  // lose the live feed.
  const rows = [
    { itemID: 111, typeID: WEB_RAT, distance: 3_000 },
    { itemID: 112, typeID: WEB_RAT, distance: 40_000 },
  ];
  const picked = pickPrimary(
    rows,
    (row) => row.typeID,
    (row) => row.distance,
    (typeID) => RAT_GROUPS[typeID] ?? null,
    DEFAULT_TARGET_PRIORITY,
    () => null,
    ratThreatOf,
    new Set([112]),
  );
  assert.equal(picked?.itemID, 112);
});

test("a class left off the list is STILL last-not-filtered when the dogma named it", () => {
  // ⚠ The ranking-not-filtering rule, restated for the NPC half: "kill the
  // ewar" alone does not make a scrambling rat unshootable, it makes it last.
  // A block that refused everything off its list would sit there being held.
  const scramRat = { id: 121, typeID: SCRAM_RAT, distance: 10_000 };
  assert.equal(pickRats([scramRat], ["ewar"])?.id, 121, "the only rat on the grid is still the primary");
  const dampRat = { id: 122, typeID: DAMP_RAT, distance: 90_000 };
  assert.equal(pickRats([scramRat, dampRat], ["ewar"])?.id, 122, "but the listed class goes first");
  // Unlisted classes keep the shipped order among themselves: tackle still
  // outranks the plain rat even though neither was named.
  const plainRat = { id: 123, typeID: PLAIN_RAT, distance: 1_000 };
  assert.equal(pickRats([plainRat, scramRat], ["ewar"])?.id, 121);
});

test("the player's own order is followed for rats too", () => {
  const scramRat = { id: 131, typeID: SCRAM_RAT, distance: 30_000 };
  const dampRat = { id: 132, typeID: DAMP_RAT, distance: 30_000 };
  assert.equal(pickRats([scramRat, dampRat], ["ewar", "tackle", "logi", "other"])?.id, 132);
});

test("passing the dogma reader alone leaves every old call path where it was", () => {
  // No jam list, no tags: the (class, distance) answer for player hulls must be
  // bit-for-bit what the four-argument call gave.
  const rows: Row[] = [
    { id: 141, typeID: 645, distance: 2_000 },
    { id: 142, typeID: 11176, distance: 40_000 },
    { id: 143, typeID: 11985, distance: 10_000 },
    { id: 144, typeID: 99999, distance: 500 },
    { id: 145, typeID: null, distance: 100 },
  ];
  const withDogma = pickPrimary(
    rows,
    (row) => row.typeID,
    (row) => row.distance,
    (typeID) => GROUPS[typeID] ?? null,
    DEFAULT_TARGET_PRIORITY,
    () => null,
    ratThreatOf,
  );
  assert.equal(withDogma?.id, pick(rows)?.id);
});

// ── ECM and the size chain ───────────────────────────────────────────────────
//
// The operator's kill order: tacklers (scram, then web), then ECM, then up the
// size chain, smallest first. Size is the target's signature radius in metres.

const ECM_RAT = 5; // ECMEntityChance 1 (a Guristas Despoiler carries it), nothing holding
const NEUT_RAT = 6; // energyNeutralizerEntityChance 0.1
const PAINT_RAT = 7; // entityTargetPaintDurationChance 0.1
const ECM_SCRAM_RAT = 8; // jams and scrams

const ECM_ATTRIBUTES: Record<number, Record<number, number>> = {
  [ECM_RAT]: { 20: 0, 103: 0, 504: 0, 930: 1 },
  [NEUT_RAT]: { 20: 0, 103: 0, 504: 0, 931: 0.1 },
  [PAINT_RAT]: { 20: 0, 103: 0, 504: 0, 935: 0.1 },
  [ECM_SCRAM_RAT]: { 20: 0, 103: 20_000, 504: 0.25, 930: 1 },
};

function ecmThreatOf(typeID: number) {
  const attributes = ECM_ATTRIBUTES[typeID] ?? RAT_ATTRIBUTES[typeID];
  return attributes === undefined ? null : threatFromAttributes(attributes);
}

interface SizedRow extends Row {
  readonly size: number | null;
}

function pickSized(
  rows: readonly SizedRow[],
  jamming?: ReadonlySet<number>,
  withSize = true,
): SizedRow | null {
  return pickPrimary(
    rows,
    (row) => row.typeID,
    (row) => row.distance,
    (typeID) => RAT_GROUPS[typeID] ?? GROUPS[typeID] ?? null,
    DEFAULT_TARGET_PRIORITY,
    (row) => row.tag,
    ecmThreatOf,
    jamming,
    (row) => row.id,
    withSize ? (row) => row.size : undefined,
  );
}

test("an ECM rat is the ewar class, and a plain ewar rat is not ECM", () => {
  assert.equal(targetClassForThreat(ecmThreatOf(ECM_RAT)), "ewar");
  assert.equal(threatFromAttributes({ 930: 0 }).ecm, false);
  assert.equal(threatFromAttributes({ 20: 0 }).ecm, false, "a missing attribute is not a jam");
  // Tackle still beats ewar when a rat is both.
  assert.equal(targetClassForThreat(ecmThreatOf(ECM_SCRAM_RAT)), "tackle");
});

test("within ewar a jammer sub-ranks ahead of damp, neut and paint", () => {
  assert.equal(threatSubRank(ecmThreatOf(ECM_RAT)), 0);
  assert.equal(threatSubRank(ecmThreatOf(NEUT_RAT)), 1);
  assert.equal(threatSubRank(ecmThreatOf(PAINT_RAT)), 1);
  assert.equal(threatSubRank(ecmThreatOf(DAMP_RAT)), 1);
  // Tackle keeps its own scale, and everything else ties at 2.
  assert.equal(threatSubRank(ecmThreatOf(SCRAM_RAT)), tackleSubRank(ecmThreatOf(SCRAM_RAT)));
  assert.equal(threatSubRank(ecmThreatOf(WEB_RAT)), 1);
  assert.equal(threatSubRank(ecmThreatOf(ECM_SCRAM_RAT)), 0, "a scrammer that jams ranks as the scrammer");
  assert.equal(threatSubRank(ecmThreatOf(PLAIN_RAT)), 2);
  assert.equal(threatSubRank(UNKNOWN_THREAT), 2);
  assert.equal(threatSubRank(null), 2);
  assert.equal(threatSubRank(undefined), 2);
});

test("the jammer dies before the damper, neut and painter, even when it is farther", () => {
  const neut = { id: 1, typeID: NEUT_RAT, distance: 2_000, size: 30 };
  const paint = { id: 2, typeID: PAINT_RAT, distance: 3_000, size: 30 };
  const damp = { id: 3, typeID: DAMP_RAT, distance: 4_000, size: 30 };
  const ecm = { id: 4, typeID: ECM_RAT, distance: 60_000, size: 400 };
  assert.equal(pickSized([neut, paint, damp, ecm])?.id, 4);
});

test("tackle is still before ECM", () => {
  const ecm = { id: 1, typeID: ECM_RAT, distance: 1_000, size: 30 };
  const web = { id: 2, typeID: WEB_RAT, distance: 90_000, size: 400 };
  assert.equal(pickSized([ecm, web])?.id, 2);
  const scram = { id: 3, typeID: SCRAM_RAT, distance: 90_000, size: 400 };
  assert.equal(pickSized([web, ecm, scram])?.id, 3, "scram, web, then ECM");
});

test("inside one class the smaller signature dies first, however far", () => {
  const cruiser = { id: 1, typeID: PLAIN_RAT, distance: 1_000, size: 130 };
  const frigate = { id: 2, typeID: PLAIN_RAT, distance: 60_000, size: 35 };
  const battleship = { id: 3, typeID: PLAIN_RAT, distance: 500, size: 400 };
  assert.equal(pickSized([cruiser, battleship, frigate])?.id, 2);
  assert.equal(pickSized([battleship, cruiser])?.id, 1);
});

test("size is below tag, live jam, class and sub-rank - it never overrides them", () => {
  const smallPlain = { id: 1, typeID: PLAIN_RAT, distance: 1_000, size: 20 };
  const bigScram = { id: 2, typeID: SCRAM_RAT, distance: 1_000, size: 500 };
  assert.equal(pickSized([smallPlain, bigScram])?.id, 2, "class beats size");

  const smallWeb = { id: 3, typeID: WEB_RAT, distance: 1_000, size: 20 };
  const bigScram2 = { id: 4, typeID: SCRAM_RAT, distance: 1_000, size: 500 };
  assert.equal(pickSized([smallWeb, bigScram2])?.id, 4, "sub-rank beats size");

  const smallPlain2 = { id: 5, typeID: PLAIN_RAT, distance: 1_000, size: 20 };
  const bigPlain = { id: 6, typeID: PLAIN_RAT, distance: 1_000, size: 500 };
  assert.equal(pickSized([smallPlain2, bigPlain], new Set([6]))?.id, 6, "a live jam beats size");

  const smallUntagged = { id: 7, typeID: PLAIN_RAT, distance: 1_000, size: 20 };
  const bigTagged = { id: 8, typeID: PLAIN_RAT, distance: 1_000, size: 500, tag: "3" };
  assert.equal(pickSized([smallUntagged, bigTagged])?.id, 8, "the FC's tag beats size");
});

test("an unreadable size sorts after every known size, and is still a target", () => {
  const unknown = { id: 1, typeID: PLAIN_RAT, distance: 100, size: null };
  const huge = { id: 2, typeID: PLAIN_RAT, distance: 90_000, size: 9_000 };
  assert.equal(pickSized([unknown, huge])?.id, 2);
  assert.equal(pickSized([unknown])?.id, 1);
  const farUnknown = { id: 3, typeID: PLAIN_RAT, distance: 50_000, size: null };
  assert.equal(pickSized([farUnknown, unknown])?.id, 1, "distance breaks a tie between unknowns");
  const nan = { id: 4, typeID: PLAIN_RAT, distance: 1, size: Number.NaN };
  assert.equal(pickSized([nan, huge])?.id, 2, "a non-finite size is not a size");
});

test("equal sizes fall through to distance", () => {
  const far = { id: 1, typeID: PLAIN_RAT, distance: 30_000, size: 35 };
  const near = { id: 2, typeID: PLAIN_RAT, distance: 4_000, size: 35 };
  assert.equal(pickSized([far, near])?.id, 2);
});

test("without sizeOf the result is exactly the old (tag, jam, class, sub-rank, distance) order", () => {
  const rows: SizedRow[] = [
    { id: 1, typeID: PLAIN_RAT, distance: 9_000, size: 20 },
    { id: 2, typeID: PLAIN_RAT, distance: 2_000, size: 900 },
    { id: 3, typeID: DAMP_RAT, distance: 50_000, size: 900 },
    { id: 4, typeID: PLAIN_RAT, distance: null, size: 5 },
  ];
  // Size on the rows is ignored when nothing reads it: nearest within class.
  assert.equal(pickSized(rows, undefined, false)?.id, 3);
  assert.equal(pickSized(rows.filter((r) => r.id !== 3), undefined, false)?.id, 2);
  // A sizeOf that knows nothing is the same as none at all.
  const unknownSizes = pickPrimary(
    rows,
    (row) => row.typeID,
    (row) => row.distance,
    (typeID) => RAT_GROUPS[typeID] ?? GROUPS[typeID] ?? null,
    DEFAULT_TARGET_PRIORITY,
    (row) => row.tag,
    ecmThreatOf,
    undefined,
    (row) => row.id,
    () => null,
  );
  assert.equal(unknownSizes?.id, 3);
  // And the existing seven-argument call path still lands where it always did.
  assert.equal(pickRats(rows.filter((r) => r.id !== 3))?.id, 2);
});
