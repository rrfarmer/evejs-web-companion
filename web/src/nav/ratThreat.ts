// What a RAT will do to you, read from the type's own dogma.
//
// ⚠ THIS EXISTS BECAUSE NO NAME AND NO GROUP CAN SEE THE DIFFERENCE. The
// classifier next door (`targetPriority.ts`) reads the game's ship-GROUP name,
// and every group it knows — Interceptor, Force Recon Ship, Logistics — is a
// PLAYER hull. An NPC's group is "Asteroid Serpentis Frigate" or "Deadspace
// Angel Cartel Cruiser", so every rat on the grid falls through to "other" and
// a ratting bot's target priority is inert: nearest-first no matter what the
// player picked. This module is the other half of the answer.
//
// The case that settles it, verified in the pinned SDE (`typeDogma.jsonl`):
//
//   Pithi Arrogator        504 = 0      103 = 0       20 = 0
//   Dire Pithi Arrogator   504 = 0.25   103 = 20000   20 = -50
//
// Same faction, same size, same words in the name bar. One of them will hold
// the ship on the field and web it down to a crawl and the other one will not,
// and ONLY the attribute says which. A name match, a regex, a group lookup —
// none of them can tell these two apart, which is the whole reason the dogma is
// read instead of the label.
//
// The attributes, and why each one and not a neighbouring one:
//
//   504 entityWarpScrambleChance  — will it actually TRY. This is the gate.
//   103 warpScrambleRange         — the reach it tries at (20 km on the common
//                                   tackle frigates above).
//    20 speedFactor               — < 0 means it webs. Not a guess: the
//                                   server's own hostile-module definition
//                                   (HOSTILE_FAMILY_WEB in the emulator's
//                                   `hostileModuleRuntime.js`) uses speedFactor
//                                   as the web's strength attribute, so this is
//                                   the number the fight is actually run on.
//   932 entitySensorDampenDurationChance
//   931 energyNeutralizerEntityChance
//   935 entityTargetPaintDurationChance
//                                 — the three ewar chances a rat can carry.
//   930 ECMEntityChance           — will it try to JAM. Read on its own as well
//                                   as inside the ewar group, because a jammer
//                                   is not the same worry as a damper: a jam
//                                   takes the lock away outright, so the kill
//                                   order ranks ECM ahead of the other ewar.
//                                   `Guristas Despoiler` carries 930 = 1 and
//                                   504 = 0 — a jammer that holds nobody.
//
// ⚠ THE CHANCE IS THE GATE, NOT THE RANGE AND NOT THE STRENGTH. `Pithum
// Silencer` carries warpScrambleRange 15000 and warpScrambleStrength 1 with
// entityWarpScrambleChance 0 — it has the numbers a scrambler would use and
// never uses them. Classifying it off the range instead of the chance makes a
// stand-off block flee from a rat that was never going to hold it, on a hull
// that is merely a normal thing to shoot. Read 504, and read it FIRST.
//
// Pure: attributes in, a verdict out. Nothing here knows about the store, a
// bot loop, or how the attributes were fetched.

/** What one rat type does to a ship it has decided to fight. */
export interface RatThreat {
  readonly scram: boolean;
  /** Metres it scrams at, null when unknown/not a scrammer. */
  readonly scramRangeM: number | null;
  readonly web: boolean;
  /** Any ewar at all, ECM included. */
  readonly ewar: boolean;
  /**
   * It will try to jam (ECMEntityChance > 0). A subset of `ewar`: an ECM rat is
   * always `ewar` too, so a caller that only knows the old flag still sees it.
   */
  readonly ecm: boolean;
}

/**
 * The attribute ids a caller must fetch to build a RatThreat.
 *
 * Named here rather than at the fetch site so the two can never drift: a
 * caller that asks for a subset silently gets a rat classified off half its
 * dogma, and nothing downstream can tell that apart from a harmless rat.
 */
export const THREAT_ATTRIBUTE_IDS: readonly number[] = Object.freeze([
  20, // speedFactor          — web (negative)
  103, // warpScrambleRange   — the scram's reach
  504, // entityWarpScrambleChance — the scram gate
  930, // ECMEntityChance — the ECM gate
  931, // energyNeutralizerEntityChance
  932, // entitySensorDampenDurationChance
  935, // entityTargetPaintDurationChance
]);

const ATTR_SPEED_FACTOR = 20;
const ATTR_WARP_SCRAMBLE_RANGE = 103;
const ATTR_ENTITY_WARP_SCRAMBLE_CHANCE = 504;
const ATTR_ECM_ENTITY_CHANCE = 930;
const ATTR_ENERGY_NEUTRALIZER_ENTITY_CHANCE = 931;
const ATTR_ENTITY_SENSOR_DAMPEN_DURATION_CHANCE = 932;
const ATTR_ENTITY_TARGET_PAINT_DURATION_CHANCE = 935;

const EWAR_CHANCE_ATTRIBUTES: readonly number[] = [
  ATTR_ECM_ENTITY_CHANCE,
  ATTR_ENTITY_SENSOR_DAMPEN_DURATION_CHANCE,
  ATTR_ENERGY_NEUTRALIZER_ENTITY_CHANCE,
  ATTR_ENTITY_TARGET_PAINT_DURATION_CHANCE,
];

/**
 * Nothing known: every flag false, range null.
 *
 * ⚠ THIS IS "NOT TOLD", NOT "HARMLESS". The attributes have not been fetched,
 * or the type resolved to nothing — same tri-state discipline the rest of this
 * codebase keeps (an unresolved group is never promoted into a class either).
 * A caller must read it as "the dogma said nothing, ask something else", which
 * is exactly what `targetClassForThreat` does by answering null so the group
 * classifier still gets its turn. Reading it as "this rat is safe" is the
 * failure mode: a tackle frigate whose attributes had not arrived yet would be
 * ranked as an ordinary hull and shot last.
 */
export const UNKNOWN_THREAT: RatThreat = Object.freeze({
  scram: false,
  scramRangeM: null,
  web: false,
  ewar: false,
  ecm: false,
});

/** A finite number for an attribute, or null — a missing or NaN value is not a fact. */
function attr(attributes: Readonly<Record<number, number>>, id: number): number | null {
  const value = attributes[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Classify one type from its raw dogma attributes (id -> value).
 *
 * A missing or empty map is UNKNOWN_THREAT — an empty map is what a caller
 * hands over before the fetch lands, and inventing "false" for a rat nobody
 * has read yet would be a guess wearing a fact's clothes.
 *
 * The three rules, each with the failure it prevents:
 *
 *  - `scram` needs chance > 0. Range and strength are what it does WHEN it
 *    fires, not whether it ever does (see the `Pithum Silencer` note above).
 *  - `scramRangeM` is reported only when `scram` is true, and null otherwise
 *    rather than 0 — "it scrams at zero metres" and "it does not scram" must
 *    not be the same number, or a stand-off block computes a keep-at-range
 *    band off a rat that has no reach at all. Null when the type scrams but
 *    the range attribute is missing: it will hold you, at a distance nobody
 *    told us.
 *  - `web` needs speedFactor STRICTLY < 0. Plenty of types carry the
 *    attribute at 0 (`Pithi Arrogator` does), which means it is listed and
 *    does nothing.
 */
export function threatFromAttributes(
  attributes: Readonly<Record<number, number>> | null | undefined,
): RatThreat {
  if (attributes === null || attributes === undefined) {
    return UNKNOWN_THREAT;
  }
  if (Object.keys(attributes).length === 0) {
    return UNKNOWN_THREAT;
  }

  const scrambleChance = attr(attributes, ATTR_ENTITY_WARP_SCRAMBLE_CHANCE) ?? 0;
  const scram = scrambleChance > 0;
  const range = attr(attributes, ATTR_WARP_SCRAMBLE_RANGE);
  // Only meaningful while `scram` holds, and a 0 (or negative) range is no
  // reach at all rather than a reach of nothing — report it as unknown.
  const scramRangeM = scram && range !== null && range > 0 ? range : null;

  const speedFactor = attr(attributes, ATTR_SPEED_FACTOR) ?? 0;
  const web = speedFactor < 0;

  const ewar = EWAR_CHANCE_ATTRIBUTES.some((id) => (attr(attributes, id) ?? 0) > 0);

  // Same gate as the scram: the chance, strictly above zero. ECMEntityChance
  // is also in EWAR_CHANCE_ATTRIBUTES, so `ecm` implies `ewar`.
  const ecm = (attr(attributes, ATTR_ECM_ENTITY_CHANCE) ?? 0) > 0;

  return { scram, scramRangeM, web, ewar, ecm };
}
