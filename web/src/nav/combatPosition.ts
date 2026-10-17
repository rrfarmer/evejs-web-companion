// Combat positioning — the arithmetic behind §2, §5.3 and §5.4 of
// docs/fleet-companion-combat-plan.md: where the ship should BE while it fights
// the engaged target, and when a gun counts as "in reach" of it.
//
// A hull is positioned by what it fights WITH, and the three answers are
// different enough that conflating them is the bug this module exists to avoid:
//
//     gun boat    (weapons non-empty)   guns decide; drones may ride along
//     drone boat  (no guns, drones)     kiteBand's stand-off band, unchanged
//     neither                           nothing to position for -> null
//
// ─── WHY EACH NUMBER IS THE NUMBER ───────────────────────────────────────────
//
// REACH OF A WEAPON — the distance its LOADED charge can hurt at. Supplied by the
// caller (`WeaponReach`), not derived here: reach depends on the fitted module,
// the charge in it and the pilot's skills, none of which belong in a pure
// positioning module.
//
// REACH OF A RAT — `max(entityAttackRange 247, optimal 54 + falloff 158)`. Two
// attributes because NPC profiles use one or the other: a rat with an attack
// range and no optimal is common, and taking only `optimal + falloff` would call
// it harmless. Anything unreadable contributes 0, so an unreadable rat is a rat
// whose reach we do not claim to know — see the kiting warning below.
//
// KITING — this fit out-ranges every rat on grid. `longest weapon reach >
// gridRatReachM + THREAT_BUFFER_M`, strictly: exactly AT the buffer is not
// kiting, because a margin of exactly the drift buffer is a margin the ship
// spends half its time outside of. Kiting holds `keepAtRange` at the rats' reach
// plus the buffer: outside their guns, inside ours, and speed is the tank.
//
// NOT KITING — ORBIT, at the optimal of the SHORTEST-reach weapon that has a
// reach. Not the longest: the fit must be able to fire everything it carries, so
// the hold is set by the weapon that gives out first. Optimal rather than raw
// reach because a gun at its maximum reach is hitting at the tail of its falloff
// curve; at optimal it is hitting at full.
//
// FLOOR — kiteBand's floor (largest scram reach on grid among hostiles that
// scram, plus THREAT_BUFFER_M; 0 when nothing scrams), for BOTH hull types. The
// caller passes the per-hostile `threats` and this module asks `kiteBand()` for
// `floorM`, so there is exactly one rule for "how far out does the thing that can
// hold me reach?" and a gun boat cannot drift from the drone boat's answer. For a
// gun boat only the floor is taken; kiteBand's hold and ceiling are about drone
// leashes and mean nothing to a turret fit.
//
// ⚠ A SCRAMMER WHOSE SCRAM RANGE IS UNKNOWN CONTRIBUTES NOTHING TO THE FLOOR.
// That is kiteBand's established rule (a row counts only when `scramRangeM` is a
// number) and it is inherited as it stands, not patched here. It is acceptable
// because the range is read from the same dogma that sets the scram flag, so
// "scrams but the range is unknown" is rare: the flag and the number arrive
// together or not at all. Do not special-case it here; fix it in kiteBand if it
// ever turns out to matter, so both hull types move together.
//
// CEILING — `min(longest weapon reach, lock range) - LEASH_BUFFER_M`. Lock range
// is also the leash (operator decision, plan §5.4): the FC must stay reachable
// and there is nothing to shoot past lock range anyway. A null ceiling means
// "neither bound is known"; it is never read as "no limit" for a number that is
// RETURNED, only as "nothing above clamps this".
//
// ⚠ A GUN BOAT NEVER STANDS STILL. Even when it is not kiting, the order is
// ORBIT and not keepAtRange. This is an operator rule and has a mechanical
// reason behind it: the server's turret formula includes transversal velocity
// and signature, so a ship holding position gives every turret rat its full hit
// chance for free, while an orbiting one drags that down to the 50 % floor. Only
// when kiting - when the ship is outside the rats' guns altogether - is
// keepAtRange (a straight line away) the right shape.
//
// ⚠ AN UNKNOWN GRID IS NEVER KITED - AND A PARTLY UNKNOWN GRID IS UNKNOWN.
// `gridRatReachM` is null when at least one hostile on grid has type facts that
// have not been read. The maximum over the rats we DID read is then a lower bound
// on the truth and nothing more: one known short-range frigate beside an unread
// battleship was being kited at the frigate's reach, i.e. inside the battleship's
// guns. Null means: orbit, never kite. A 0 is also never kited (a rat read with
// no reach attributes, or a grid with nothing on it): 0 + THREAT_BUFFER_M is below
// every gun in the game, so reading it literally would announce a kite at 5 km.
//
// ⚠ AN UNKNOWN REACH FAILS OPEN. `inReach` answers true when the reach is not
// known, because a gun that might hit beats a gun that certainly does not: the
// failure we are guarding against is a pilot that fires nothing because a
// module row was incomplete. The cost is a few wasted cycles of a gun that was
// out of range; the alternative cost is a silent ship.
//
// ⚠ A RAT THAT IS FASTER AND CLOSER-ORBITING THAN THE HOLD CANNOT BE HELD OFF.
// Rats orbit their target at a fixed per-profile distance whatever our guns
// want (plan §2). If the target is faster than we are and orbits inside the
// hold we wanted, no amount of burning closes the gap the OTHER way - it stays
// where it wants to be. So we ACCEPT its orbit distance (but never inside the
// floor) and let the guns that reach from there fire, rather than chase it for
// ever. `reason: "unreachable"` carries that sentence to the readout.
//
// ⚠ THE ACCEPTED DISTANCE IS A FIXED NUMBER, NOT THE LIVE ONE. Re-reading the
// current distance every tick would make the hold wobble with every metre the rat
// drifts, and each wobble past RANGE_HYSTERESIS_M re-aims the ship (stops it and
// turns it). The rat's own `orbitRangeM` is what it will keep, so that is the
// hold. (The orbit range is always known on this path: not knowing it is exactly
// what stops a rat being called unreachable in the first place.)
//
// ⚠ THE CLOSING BUDGET IS A BOUND ON TRYING, NOT A PROMISE OF ARRIVAL. A hold
// that is reachable but not yet reached gets `MAX_CLOSE_TICKS` ticks. When the
// caller says it is spent it passes `closingSpentAtM`, the distance FROZEN at the
// moment the budget ran out, and the hold becomes `max(closingSpentAtM, floor)`
// with `reason: "closing-spent"`. A frozen number and not the current distance,
// for the same reason as above: a drifting rat must not re-aim the ship every
// 2 km. Where the target is already unreachable by the rule above, "unreachable"
// is the better word - it names the cause, not the symptom - and wins.
//
// ⚠ AN EMPTY BAND (floor > ceiling) HOLDS AT THE CEILING, exactly as kiteBand
// does and for the same reason: the floor is a wish about what can grab you,
// the ceiling is the edge of what the ship can actually use. The readout says
// "no room", it does not fly to a distance that means nothing.
//
// ⚠ A GUN BOAT WITH NO KNOWN REACH ON ANY WEAPON IS NOT POSITIONED (null). A
// blaster boat with dry guns, or a fit that has not been read yet, has no reach
// to position for, and the old answer - orbit at half the lock range - sent it to
// circle at 25 km with guns that reach 2 km: a ship flying away from the only
// distance at which it can do anything. The pilot stays in formation until a
// reach is readable. There is deliberately no guess to fall back on here.
//
// This module is PURE. No store, no bridge, no loop, no clock - plain objects in,
// plain object out - so the whole thing is tested as arithmetic.

import {
  LEASH_BUFFER_M,
  RANGE_HYSTERESIS_M,
  THREAT_BUFFER_M,
  kiteBand,
  type BandThreat,
} from "./kiteBand.ts";

/** Per NPC type, read from static type dogma. Every field null when unknown. */
export interface RatCombatFacts {
  readonly missile: boolean | null; // attribute 507 entityMissileTypeID present and > 0
  readonly optimalM: number | null; // 54
  readonly falloffM: number | null; // 158
  readonly trackingSpeed: number | null; // 160
  readonly attackRangeM: number | null; // 247 entityAttackRange
  readonly orbitRangeM: number | null; // 416 entityFlyRange
  readonly maxVelocity: number | null; // 37
}

/** The dogma attributes `ratCombatFromAttributes` reads, in no promised order. */
export const RAT_COMBAT_ATTRIBUTE_IDS: readonly number[] = Object.freeze([
  507, 54, 158, 160, 247, 416, 37,
]);

/** A finite number, or null: attribute rows off the wire may carry anything. */
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A metre count we may do arithmetic on: finite and non-negative, else null. */
function metres(value: unknown): number | null {
  const n = finite(value);
  return n === null ? null : n < 0 ? 0 : n;
}

/**
 * Rat facts from a type's dogma attributes, keyed by attribute id.
 *
 * ⚠ A MISSING 507 MEANS "NOT A MISSILE RAT" ONLY WHEN WE READ SOMETHING. An
 * empty or null attribute table is "the type was not readable" - and a rat
 * whose type was not readable is not thereby known to be a turret rat, so
 * `missile` stays null. With a non-empty table the absence of 507 IS the answer:
 * the server marks missile rats by carrying that attribute (plan §2).
 */
export function ratCombatFromAttributes(
  attrs: Readonly<Record<number, number>> | null,
): RatCombatFacts {
  const none: RatCombatFacts = {
    missile: null,
    optimalM: null,
    falloffM: null,
    trackingSpeed: null,
    attackRangeM: null,
    orbitRangeM: null,
    maxVelocity: null,
  };
  if (attrs === null || typeof attrs !== "object") return none;
  if (Object.keys(attrs).length === 0) return none;
  const missileType = finite(attrs[507]);
  return {
    missile: missileType !== null && missileType > 0,
    optimalM: metres(attrs[54]),
    falloffM: metres(attrs[158]),
    trackingSpeed: finite(attrs[160]),
    attackRangeM: metres(attrs[247]),
    orbitRangeM: metres(attrs[416]),
    maxVelocity: finite(attrs[37]),
  };
}

/** How far this rat can hurt: max(attackRangeM, optimalM + falloffM). 0 when nothing is known. */
export function ratReachM(facts: RatCombatFacts | null): number {
  if (facts === null || typeof facts !== "object") return 0;
  const attack = metres(facts.attackRangeM) ?? 0;
  const optimal = metres(facts.optimalM);
  const falloff = metres(facts.falloffM);
  const gun = (optimal ?? 0) + (falloff ?? 0);
  return Math.max(attack, gun);
}

export interface WeaponReach {
  readonly moduleID: number;
  /** Reach with the LOADED charge; null when unreadable. */
  readonly reachM: number | null;
  readonly optimalM: number | null;
}

/**
 * How far the in-reach gate moves before it flips: gentler than
 * RANGE_HYSTERESIS_M, which is sized for a 20 km hold and would swallow a
 * 1 km blaster whole. Both `reach - hysteresis` (entering) and
 * `reach + hysteresis` (staying) have to mean something for short guns, so the
 * effective value is further capped at a quarter of the reach.
 */
export const REACH_HYSTERESIS_M = 500;

/**
 * Sticky in-reach test: entering needs distance <= reach - hysteresis, staying
 * needs distance <= reach + hysteresis.
 *
 * ⚠ THE STICKINESS IS THE POINT. Distance wobbles by hundreds of metres a tick
 * on a moving ship; a plain `distance <= reach` flips the gun on and off at the
 * edge, and every flip is an action (activate / deactivate) that costs the tick
 * and cycles the module. The band between the two thresholds keeps the state it
 * had.
 *
 * ⚠ FAILS OPEN: reach null -> true (a gun that might hit beats one that
 * certainly does not); distance null -> keep the previous answer, true when
 * there was none. `wasInReach` null with a known distance has no state to keep,
 * so the plain edge applies.
 */
export function inReach(
  distanceM: number | null,
  reachM: number | null,
  wasInReach: boolean | null,
  hysteresisM: number = REACH_HYSTERESIS_M,
): boolean {
  const reach = metres(reachM);
  if (reach === null) return true;
  const distance = metres(distanceM);
  if (distance === null) return wasInReach ?? true;
  const hysteresis = Math.min(metres(hysteresisM) ?? 0, reach / 4);
  if (wasInReach === null) return distance <= reach;
  return wasInReach ? distance <= reach + hysteresis : distance <= reach - hysteresis;
}

export interface HoldInputs {
  /** Fitted guns/launchers with their LOADED-charge reach. */
  readonly weapons: readonly WeaponReach[];
  readonly hasCombatDrones: boolean;
  readonly droneControlRangeM: number | null;
  /** Also the leash (operator decision). */
  readonly lockRangeM: number | null;
  /**
   * Max ratReachM over the hostiles on grid; null when at least one hostile's
   * type facts have not been read (a gun boat never kites then).
   */
  readonly gridRatReachM: number | null;
  /** Every hostile on grid; kiteBand derives the scram floor from these. */
  readonly threats: readonly BandThreat[];
  /** Surface distance to the engaged target. */
  readonly targetDistanceM: number | null;
  readonly target: RatCombatFacts | null;
  readonly ownMaxVelocity: number | null;
  /**
   * The distance FROZEN when the closing budget for this target ran out; null
   * while it is not spent.
   */
  readonly closingSpentAtM: number | null;
}

export type HoldReason =
  | "kite"
  | "orbit-optimal"
  | "drone-band"
  | "empty-band"
  | "unreachable"
  | "closing-spent";

export interface Hold {
  readonly order: "orbit" | "keepAtRange";
  readonly rangeM: number;
  /** True only for a real kite: keepAtRange outside every rat's reach. */
  readonly kiting: boolean;
  readonly reason: HoldReason;
  /** Always known now (a gun boat needs one reach, a drone boat has a leash); typed nullable for callers. */
  readonly ceilingM: number | null;
  readonly floorM: number;
}

/** ~2 min at the 2 s cadence; same value and reason as droneBoatLadder.ts. */
export const MAX_CLOSE_TICKS = 60;

/** v clamped into [floor, ceiling]; an empty band (floor > ceiling) yields the ceiling. */
function clampBand(v: number, floorM: number, ceilingM: number): number {
  const lifted = Math.max(v, floorM);
  return Math.max(0, Math.min(lifted, ceilingM));
}

/** A rangeM we will hand to a world call: finite and >= 0. */
function safeRange(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Where to be. `null` = nothing to position for: no guns and no combat drones,
 * or a gun boat with no weapon whose reach is known.
 *
 * Pure: call it every tick. Whether to ACT on the answer is `holdNeedsReissue`'s
 * question, and the closing budget's bookkeeping lives with the caller
 * (`closingSpentAtM`), because a counter is state and this module has none.
 */
export function wantedHold(inputs: HoldInputs): Hold | null {
  const weapons = Array.isArray(inputs?.weapons) ? inputs.weapons : [];
  const lockM = metres(inputs?.lockRangeM);
  const distanceM = metres(inputs?.targetDistanceM);
  const spentAtM = metres(inputs?.closingSpentAtM);

  // The floor for BOTH hull types comes from kiteBand's own rule; see the header.
  const band = kiteBand({
    threats: Array.isArray(inputs?.threats) ? inputs.threats : [],
    droneControlRangeM: inputs?.droneControlRangeM ?? null,
    maxTargetRangeM: lockM,
    overrideHoldM: null,
  });
  const floorM = band.floorM;

  if (weapons.length === 0) {
    if (inputs?.hasCombatDrones !== true) return null;
    return droneBoatHold(band, spentAtM);
  }

  // ─── GUN BOAT ─────────────────────────────────────────────────────────────
  const reachable = weapons.filter((w) => metres(w?.reachM) !== null);
  // No weapon will say how far it reaches: nothing to position for. See the header.
  if (reachable.length === 0) return null;
  const longestM = Math.max(...reachable.map((w) => metres(w.reachM) as number));

  const edgeM = Math.min(longestM, lockM ?? Number.POSITIVE_INFINITY);
  const ceilingM = Math.max(0, edgeM - LEASH_BUFFER_M);
  const empty = floorM > ceilingM;

  const gridReachM = metres(inputs?.gridRatReachM);
  const kiting = gridReachM !== null && gridReachM > 0 && longestM > gridReachM + THREAT_BUFFER_M;

  let order: Hold["order"];
  let wantM: number;
  let reason: HoldReason;
  if (kiting) {
    order = "keepAtRange";
    wantM = clampBand((gridReachM as number) + THREAT_BUFFER_M, floorM, ceilingM);
    reason = "kite";
  } else {
    order = "orbit";
    // Shortest reach first; ties go to the lowest moduleID so the answer does
    // not flicker between two identical guns.
    const shortest = [...reachable].sort(
      (a, b) =>
        (metres(a.reachM) as number) - (metres(b.reachM) as number) ||
        a.moduleID - b.moduleID,
    )[0];
    const optimal = metres(shortest.optimalM) ?? (metres(shortest.reachM) as number);
    wantM = clampBand(optimal, floorM, ceilingM);
    reason = "orbit-optimal";
  }
  if (empty) reason = "empty-band";

  let hold: Hold = {
    order,
    rangeM: safeRange(wantM),
    kiting: kiting && !empty,
    reason,
    ceilingM,
    floorM,
  };

  // ─── CAN IT BE HELD? ──────────────────────────────────────────────────────
  const target = inputs?.target ?? null;
  const targetSpeed = finite(target?.maxVelocity);
  const ownSpeed = finite(inputs?.ownMaxVelocity);
  const targetOrbit = metres(target?.orbitRangeM);
  if (
    targetSpeed !== null &&
    ownSpeed !== null &&
    targetSpeed > ownSpeed &&
    targetOrbit !== null &&
    targetOrbit < hold.rangeM
  ) {
    // The rat's own orbit range, a fixed number. It is always known on this path
    // (the condition above needs it), so there is no live distance to fall back to.
    hold = {
      ...hold,
      rangeM: safeRange(Math.max(targetOrbit, floorM)),
      kiting: false,
      reason: "unreachable",
    };
  } else if (spentAtM !== null) {
    hold = {
      ...hold,
      rangeM: safeRange(Math.max(spentAtM, floorM)),
      kiting: false,
      reason: "closing-spent",
    };
  }
  return hold;
}

/**
 * The drone-boat hold: kiteBand's holdM, as a keepAtRange.
 *
 * kiteBand already holds at its ceiling when nothing on grid scrams ("no-tackle")
 * and at the floor when something does; the anchor is irrelevant here because the
 * engaged target is always the anchor (plan §5.4), so only the band's numbers are
 * used.
 */
function droneBoatHold(band: ReturnType<typeof kiteBand>, spentAtM: number | null): Hold {
  let hold: Hold = {
    order: "keepAtRange",
    rangeM: safeRange(band.holdM),
    kiting: false,
    reason: band.empty ? "empty-band" : "drone-band",
    ceilingM: band.ceilingM,
    floorM: band.floorM,
  };
  if (spentAtM !== null) {
    hold = {
      ...hold,
      rangeM: safeRange(Math.max(spentAtM, hold.floorM)),
      reason: "closing-spent",
    };
  }
  return hold;
}

export interface HeldOrder {
  readonly order: "orbit" | "keepAtRange";
  readonly targetID: number;
  readonly rangeM: number;
}

/**
 * Is the wanted order different enough from the standing one to spend an action?
 *
 * ⚠ EVERY RE-AIM STOPS THE SHIP AND TURNS IT, so a wobble must not re-aim. The
 * anchor (target) or the order kind changing always counts - the standing order
 * is measured against a different object or keeps a different shape - and a
 * range moves only when it moves by MORE than RANGE_HYSTERESIS_M. `current` null
 * means no standing order is ours to assume: issue it. An unreadable wanted
 * range alone is not a reason to fire a call with it.
 */
export function holdNeedsReissue(current: HeldOrder | null, wanted: HeldOrder): boolean {
  if (current === null) return true;
  if (current.order !== wanted.order || current.targetID !== wanted.targetID) return true;
  const a = metres(current.rangeM);
  const b = metres(wanted.rangeM);
  if (a === null) return b !== null;
  if (b === null) return false;
  return Math.abs(a - b) > RANGE_HYSTERESIS_M;
}
