// WHICH combat drones to launch against a target, and WHEN swapping them is worth it.
//
// A drone's size decides whether it can hit at all. A Hobgoblin (light) tracks a
// frigate; an Ogre (heavy) fired at the same frigate misses nearly every shot --
// and a Hobgoblin fired at a battleship hits every shot for a fraction of the
// damage the Ogre would have done. The bay used to go out whole, whatever the
// target, so the fight was decided by what happened to be packed. This module
// is the arithmetic that picks the size, read from the SERVER's own hit rule.
//
// ─── THE SERVER MODEL (D:\evet\server\src, read 2026-10-12) ──────────────────
//
// Hit chance, space/combat/laserTurrets.js `resolveTurretShot` (drones call it
// through `droneInterop.resolveTurretShot`, droneRuntime.js ~L7060):
//
//   trackingTerm = (angVel * optimalSigRadius) / (trackingSpeed * max(targetSig, 1))
//   rangeTerm    = surfaceDistance > optimal ? (surfaceDistance - optimal) / falloff : 0
//   chance       = 0.5 ** (trackingTerm^2 + rangeTerm^2)
//
// Quality (damage multiplier) is a function of the SAME roll that decided the
// hit: a hit is `roll < chance`, wrecking if `roll < 0.01` (x3), otherwise the
// quality is `0.49 + roll`. So the quality is NOT independent of the chance --
// a low-chance shot that lands only ever drew a LOW roll, and so lands light.
// The expected damage multiplier per shot is therefore the integral of the
// quality over rolls [0, chance), not chance * mean(quality):
//
//   c <= 0.01 :  3c
//   c >  0.01 :  0.03 + 0.49 (c - 0.01) + (c^2 - 0.0001) / 2          (1.01505 at c = 1)
//
// That is `expectedShotMultiplier` below. (The server also has a config lean,
// `combat.turretHitChanceAdditive`, zero on a TQ-exact setup; it is not read
// here, so a server that sets it will hit slightly more than this predicts --
// the ranking between sizes is unaffected in practice.)
//
// The drone's weapon, droneDogma.js ~L940-1060 (`resolveDroneCombatSnapshot`):
// damage per type = (em|thermal|kinetic|explosive damage) * damageMultiplier;
// cycle = attribute 51 `speed` in ms; optimal = maxRange (54); falloff (158);
// trackingSpeed (160); optimalSigRadius (620) falling back to the drone's own
// signatureRadius (552) and then 25; attackRange = max(entityAttackRange, optimal).
//
// How a drone MOVES, droneRuntime.js:
//   • `resolveDroneMovementProfile` (~L3340): maxVelocity (37), entityCruiseSpeed
//     (508, absent = maxVelocity), entityChaseMaxDistance (665), fly range
//     (416, else orbitRange 157).
//   • `resolveDroneEngagementRanges` (~L3612): orbit = max(500, snapshot orbit),
//     engagement = attackRange if > 0 else orbit, and the drone orbits at
//     min(orbit, engagement). Every engagement is an ORBIT of the target (the
//     comment above `syncDronePursuitBehavior` says TQ never follows), at the
//     CRUISE fraction once on station.
//   • `shouldUseFastDronePropulsion` / `droneCruiseCanHoldStation` (~L3498-3545):
//     a drone with a chase distance goes to full speed when the target is faster
//     than its cruise speed; without one it stays at cruise.
//   • Launch rules, ~L4849-4900: one drone at a time, stopping when
//     `maxActiveDrones` (352) or the hull's `droneBandwidth` (1271) would be
//     exceeded by the NEXT one (each draws `droneBandwidthUsed`, 1272). A launch
//     is therefore partial, never refused whole.
//
// ─── THE ATTRIBUTES, VERIFIED AGAINST THE SDE ────────────────────────────────
//
// Checked in D:\evet\_local\sde\eve-online-static-data-3396210-jsonl\
// dogmaAttributes.jsonl (id -> name):
//
//    37 maxVelocity          51 speed (cycle, ms)       54 maxRange
//    64 damageMultiplier    114 emDamage               116 explosiveDamage
//   117 kineticDamage       118 thermalDamage          157 orbitRange
//   158 falloff             160 trackingSpeed          247 entityAttackRange
//   416 entityFlyRange      508 entityCruiseSpeed      552 signatureRadius
//   620 optimalSigRadius    665 entityChaseMaxDistance 1272 droneBandwidthUsed
//
// ⚠ 247, NOT 72. The server source writes `getAttributeIDByNames("entityAttackRange")
// || 72`, but 72 is `capacityBonus` in the SDE; the name lookup wins at run time
// and resolves to 247, which is what Hobgoblin I (2800 m) carries. Reading 72
// would hand every drone an attack range of 0.
//
// The hull's side (`droneBandwidth` 1271, `maxActiveDrones` 352) is a ship
// attribute, not a drone one, and comes in through `ShipLimits`.
//
// ─── THE ANGULAR VELOCITY, AND WHY THIS ESTIMATE ─────────────────────────────
//
// The server measures it from real positions every cycle
// (`getAngularVelocity`: the tangential part of the relative velocity over the
// centre distance). We have no positions for a drone that is not out yet, so
// the steady state is modelled instead: the drone orbits at radius R at speed
// vd, the target moves at vt. In the target's frame the drone's own motion is
// tangential, magnitude vd. The target's velocity is a fixed vector against a
// radial direction that turns once per lap, so on average HALF of its square is
// tangential. Hence
//
//   angVel = sqrt(vd^2 + vt^2 / 2) / R
//
// which is exact for vt = 0 and for vd = 0 (a sentry), and the RMS over a lap in
// between. A drone that cannot out-run the target (vt >= its maxVelocity)
// cannot hold the orbit at all and is scored 0: it trails behind a target that
// is leaving.
//
// ⚠ SENTRIES (maxVelocity ~1e-5) NEVER MOVE. They sit on the ship, so R is the
// target's distance from the SHIP and angVel comes from the target's speed alone.
// The range term is then the whole story: a Garde I (15 km + 25 km falloff)
// is deadly inside 15 km and nearly blind at 100 km.
//
// ─── WHAT "UNKNOWN" MEANS HERE ───────────────────────────────────────────────
//
// Same tri-state the rest of this tree keeps: NULL IS "NOBODY LOOKED", 0 IS "WE
// LOOKED, IT CANNOT HURT THIS TARGET". An unknown signature, speed or (for a
// sentry) distance makes the applied dps null rather than a guess, because a
// guessed 0 would send a good size away and a guessed number would pick a size
// off nothing. Unknown RESISTANCES are the one exception: they scale every
// drone by about the same, so they are read as "none" (1) and say so in
// `TargetFacts`.
//
// This module is PURE: numbers in, a verdict out. No store, no fetch, no clock
// (time is passed in).

/**
 * The attribute ids a caller must fetch (/api/types/dogma) to build `DroneFacts`.
 *
 * Named here, like `THREAT_ATTRIBUTE_IDS`, so the fetch and the reader cannot
 * drift: a caller asking for a subset gets drones that look like they have no
 * tracking, and no one downstream can tell that from a real, slow weapon.
 */
export const DRONE_SIZING_ATTRIBUTE_IDS: readonly number[] = Object.freeze([
  37, // maxVelocity
  51, // speed (rate of fire, ms per cycle)
  54, // maxRange (optimal)
  64, // damageMultiplier
  114, // emDamage
  116, // explosiveDamage
  117, // kineticDamage
  118, // thermalDamage
  157, // orbitRange (fly range fallback)
  158, // falloff
  160, // trackingSpeed
  247, // entityAttackRange
  416, // entityFlyRange (orbit radius)
  508, // entityCruiseSpeed
  552, // signatureRadius (optimalSigRadius fallback)
  620, // optimalSigRadius
  665, // entityChaseMaxDistance
  1272, // droneBandwidthUsed
]);

const ATTR_MAX_VELOCITY = 37;
const ATTR_SPEED = 51;
const ATTR_MAX_RANGE = 54;
const ATTR_DAMAGE_MULTIPLIER = 64;
const ATTR_EM = 114;
const ATTR_EXPLOSIVE = 116;
const ATTR_KINETIC = 117;
const ATTR_THERMAL = 118;
const ATTR_ORBIT_RANGE = 157;
const ATTR_FALLOFF = 158;
const ATTR_TRACKING_SPEED = 160;
const ATTR_ENTITY_ATTACK_RANGE = 247;
const ATTR_ENTITY_FLY_RANGE = 416;
const ATTR_ENTITY_CRUISE_SPEED = 508;
const ATTR_SIGNATURE_RADIUS = 552;
const ATTR_OPTIMAL_SIG_RADIUS = 620;
const ATTR_CHASE_MAX_DISTANCE = 665;
const ATTR_DRONE_BANDWIDTH_USED = 1272;

/** The server's floor on a drone's orbit radius (`resolveDroneEngagementRanges`). */
const MIN_ORBIT_RADIUS_M = 500;

/** Below this a drone does not move (a sentry's maxVelocity is 1e-5). */
const STATIONARY_BELOW_MS = 1;

/** The server's fallback when neither optimalSigRadius nor signatureRadius is set. */
const DEFAULT_OPTIMAL_SIG_RADIUS = 25;

export interface DamageVector {
  readonly em: number;
  readonly thermal: number;
  readonly kinetic: number;
  readonly explosive: number;
}

/** One combat drone type, as much of it as the hit rule and the launch rule read. */
export interface DroneFacts {
  readonly typeID: number;
  /** Raw damage of one shot, damageMultiplier already applied. */
  readonly shotDamage: DamageVector;
  readonly cycleSeconds: number;
  readonly optimalM: number;
  readonly falloffM: number;
  readonly trackingSpeed: number;
  readonly optimalSigRadius: number;
  readonly maxVelocityMs: number;
  /** entityCruiseSpeed, or null when the type carries none (it then cruises at maxVelocity). */
  readonly cruiseSpeedMs: number | null;
  /** entityChaseMaxDistance, 0 when absent. */
  readonly chaseM: number;
  /** Where it orbits its target, as the server works it out. */
  readonly orbitRadiusM: number;
  readonly bandwidthMbit: number;
  /** True for a sentry: it stays at the ship. */
  readonly stationary: boolean;
}

export interface TargetFacts {
  /** null = nobody looked. */
  readonly signatureRadius: number | null;
  /** m/s; null = nobody looked. */
  readonly speed: number | null;
  /** From the ship, in metres; only a sentry needs it. null = nobody looked. */
  readonly distanceFromShipM: number | null;
  /**
   * Resonance multipliers (1 = no resist). Omitted or null is read as 1 on every
   * channel: resists scale all of a hull's drones about alike, so a missing one
   * must not make the whole target unknown.
   */
  readonly resonance?: DamageVector | null;
}

/** A finite number for an attribute, or null: a missing or NaN value is not a fact. */
function attr(attrs: Readonly<Record<number, number>>, id: number): number | null {
  const value = attrs[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Build one drone's facts from its raw dogma (id -> value), or null.
 *
 * Null when an essential is missing: the cycle, the optimal range, the
 * tracking speed, the bandwidth, the top speed, or any damage at all. Those
 * have no server default that is not a lie (a missing trackingSpeed is "never
 * hits" to the server, but here it is far likelier to be an unfetched
 * attribute). The ones the server itself defaults are defaulted the same way:
 * damageMultiplier 1, falloff 0, optimalSigRadius -> signatureRadius -> 25.
 */
export function droneFactsFromAttributes(
  typeID: number,
  attrs: Readonly<Record<number, number>> | null | undefined,
): DroneFacts | null {
  if (attrs === null || attrs === undefined) {
    return null;
  }
  const cycleMs = attr(attrs, ATTR_SPEED);
  const optimal = attr(attrs, ATTR_MAX_RANGE);
  const tracking = attr(attrs, ATTR_TRACKING_SPEED);
  const bandwidth = attr(attrs, ATTR_DRONE_BANDWIDTH_USED);
  const maxVelocity = attr(attrs, ATTR_MAX_VELOCITY);
  if (cycleMs === null || cycleMs <= 0 || optimal === null || tracking === null || bandwidth === null) {
    return null;
  }
  if (maxVelocity === null || bandwidth < 0) {
    return null;
  }
  const multiplier = Math.max(0, attr(attrs, ATTR_DAMAGE_MULTIPLIER) ?? 1);
  const dmg = (id: number): number => Math.max(0, attr(attrs, id) ?? 0) * multiplier;
  const shotDamage: DamageVector = {
    em: dmg(ATTR_EM),
    thermal: dmg(ATTR_THERMAL),
    kinetic: dmg(ATTR_KINETIC),
    explosive: dmg(ATTR_EXPLOSIVE),
  };
  if (shotDamage.em + shotDamage.thermal + shotDamage.kinetic + shotDamage.explosive <= 0) {
    return null;
  }

  const falloff = Math.max(0, attr(attrs, ATTR_FALLOFF) ?? 0);
  const optimalSig = Math.max(
    1,
    attr(attrs, ATTR_OPTIMAL_SIG_RADIUS) ?? attr(attrs, ATTR_SIGNATURE_RADIUS) ?? DEFAULT_OPTIMAL_SIG_RADIUS,
  );
  const optimalM = Math.max(0, optimal);
  const attackRange = Math.max(attr(attrs, ATTR_ENTITY_ATTACK_RANGE) ?? 0, optimalM);
  const flyRange = Math.max(0, attr(attrs, ATTR_ENTITY_FLY_RANGE) ?? attr(attrs, ATTR_ORBIT_RANGE) ?? 0);
  const orbit = Math.max(MIN_ORBIT_RADIUS_M, flyRange);
  const engagement = attackRange > 0 ? attackRange : orbit;
  const cruise = attr(attrs, ATTR_ENTITY_CRUISE_SPEED);

  return {
    typeID,
    shotDamage,
    cycleSeconds: cycleMs / 1000,
    optimalM,
    falloffM: falloff,
    trackingSpeed: Math.max(0, tracking),
    optimalSigRadius: optimalSig,
    maxVelocityMs: Math.max(0, maxVelocity),
    cruiseSpeedMs: cruise === null ? null : Math.max(0, cruise),
    chaseM: Math.max(0, attr(attrs, ATTR_CHASE_MAX_DISTANCE) ?? 0),
    orbitRadiusM: Math.min(orbit, engagement),
    bandwidthMbit: bandwidth,
    stationary: maxVelocity < STATIONARY_BELOW_MS,
  };
}

/**
 * Expected damage multiplier of one shot at hit chance `c`: the integral of the
 * server's quality over the rolls that hit (see the header). 0 at c = 0.
 */
export function expectedShotMultiplier(chance: number): number {
  const c = Math.min(1, Math.max(0, Number.isFinite(chance) ? chance : 0));
  if (c <= 0.01) {
    return 3 * c;
  }
  return 0.03 + 0.49 * (c - 0.01) + (c * c - 0.0001) / 2;
}

/** The speed a mobile drone holds while orbiting a target moving at `targetSpeed`. */
function orbitSpeedMs(drone: DroneFacts, targetSpeed: number): number {
  const cruise = drone.cruiseSpeedMs ?? drone.maxVelocityMs;
  // Full speed only for a drone that has a chase distance AND cannot hold
  // station at cruise (shouldUseFastDronePropulsion / droneCruiseCanHoldStation).
  if (drone.chaseM > 0 && cruise > 0 && targetSpeed > cruise) {
    return drone.maxVelocityMs;
  }
  return Math.min(cruise, drone.maxVelocityMs);
}

/**
 * The chance one shot lands, or null when the target's facts are not all known.
 * 0 means the drone cannot keep up with, or reach, this target.
 */
export function hitChanceAgainst(drone: DroneFacts, target: TargetFacts): number | null {
  const sig = target.signatureRadius;
  const speed = target.speed;
  if (sig === null || speed === null || !Number.isFinite(sig) || !Number.isFinite(speed)) {
    return null;
  }
  let radius: number;
  let droneSpeed: number;
  if (drone.stationary) {
    const dist = target.distanceFromShipM;
    if (dist === null || !Number.isFinite(dist)) {
      return null;
    }
    radius = Math.max(dist, 1);
    droneSpeed = 0;
  } else {
    if (speed >= drone.maxVelocityMs) {
      return 0;
    }
    radius = Math.max(drone.orbitRadiusM, 1);
    droneSpeed = orbitSpeedMs(drone, speed);
  }
  if (drone.trackingSpeed <= 0) {
    return 0;
  }
  const angVel = Math.sqrt(droneSpeed * droneSpeed + (speed * speed) / 2) / radius;
  const trackingTerm = (angVel * drone.optimalSigRadius) / (drone.trackingSpeed * Math.max(sig, 1));
  let rangeTerm = 0;
  if (radius > drone.optimalM) {
    if (drone.falloffM <= 0) {
      return 0;
    }
    rangeTerm = (radius - drone.optimalM) / drone.falloffM;
  }
  return 0.5 ** (trackingTerm * trackingTerm + rangeTerm * rangeTerm);
}

/**
 * Damage per second ONE drone of this type is expected to apply to this target,
 * resistances included. null = the target's facts are not all known (see the
 * header); 0 = it cannot hurt it.
 */
export function expectedAppliedDps(drone: DroneFacts, target: TargetFacts): number | null {
  const chance = hitChanceAgainst(drone, target);
  if (chance === null) {
    return null;
  }
  const r = target.resonance ?? { em: 1, thermal: 1, kinetic: 1, explosive: 1 };
  const shot =
    drone.shotDamage.em * r.em +
    drone.shotDamage.thermal * r.thermal +
    drone.shotDamage.kinetic * r.kinetic +
    drone.shotDamage.explosive * r.explosive;
  return (shot * expectedShotMultiplier(chance)) / drone.cycleSeconds;
}

/**
 * One drone's score across several targets: the MEAN of the known per-target
 * applied dps, null when none is known.
 *
 * ⚠ MEAN, NOT SUM, NOT MIN. With no call yet the companion cannot know which of
 * the hostiles will be shot first, so each is as likely as the next. Sum would
 * rank types identically (the count of targets is the same for every type) but
 * lose the unit; min would let one stray frigate decide a battleship fight.
 * A target whose facts are unknown is left out rather than counted as zero.
 */
export function scoreAgainst(drone: DroneFacts, targets: TargetFacts | readonly TargetFacts[]): number | null {
  const list: readonly TargetFacts[] = Array.isArray(targets) ? targets : [targets as TargetFacts];
  let sum = 0;
  let known = 0;
  for (const target of list) {
    const dps = expectedAppliedDps(drone, target);
    if (dps !== null) {
      sum += dps;
      known += 1;
    }
  }
  return known === 0 ? null : sum / known;
}

export interface ShipLimits {
  /** droneBandwidth (1271) of the hull, Mbit/s. */
  readonly bandwidthMbit: number;
  /** maxActiveDrones (352) of the pilot. */
  readonly maxActive: number;
}

export interface BayStack {
  readonly itemID: number;
  readonly typeID: number;
  readonly quantity: number;
}

export interface LaunchPlan {
  /** The bay stacks to launch, in launch order (primary first), with how many of each. */
  readonly stacks: { readonly itemID: number; readonly quantity: number }[];
  /** The type chosen first, or null when there is no choice to make (see below). */
  readonly primaryTypeID: number | null;
  /**
   * Summed expected dps of everything in `stacks`. ⚠ null = the target (or the
   * drones' facts) were not known, and `stacks` is EMPTY: the caller keeps
   * whatever it did before this module existed. 0 with a null primary = every
   * drone in the bay is useless against this target.
   */
  readonly expectedDps: number | null;
}

/** Applied dps per drone below this is nothing: a slot it would only hold. */
const USELESS_DPS = 0.01;

const NO_PLAN_UNKNOWN: LaunchPlan = Object.freeze({ stacks: [], primaryTypeID: null, expectedDps: null });

interface TypeBucket {
  readonly facts: DroneFacts;
  readonly stacks: BayStack[];
  total: number;
  score: number | null;
}

/** How many of this type fit in what is left. */
function fitCount(bucket: TypeBucket, bwLeft: number, slotsLeft: number): number {
  const per = bucket.facts.bandwidthMbit;
  const byBandwidth = per > 0 ? Math.floor((bwLeft + 1e-9) / per) : slotsLeft;
  return Math.max(0, Math.min(bucket.total, slotsLeft, byBandwidth));
}

/**
 * Decide the launch.
 *
 * The operator's rule: the best-scoring type goes out FIRST, then leftover
 * bandwidth and active slots are filled with the next size DOWN (strictly
 * lower bandwidth per drone), never up.
 *
 * "Best" is judged per FLIGHT and not per drone: each type is tried as the
 * primary, with its fill, as many as bay, bandwidth and slots allow, and the
 * highest total expected dps wins. Per drone, a heavy always beats a light on a
 * big target while the hull might carry three of them and five of the other;
 * the flight is what shoots. Ties go to the lower bandwidth, which leaves room
 * to fill.
 *
 * Launch order matters because the server launches one drone at a time and
 * stops at the first that does not fit (~L4849-4900): primary stacks first,
 * then the fill, largest remaining size first. Fill types that score exactly 0
 * are skipped: a sentry that cannot reach the target only holds a slot.
 */
export function planLaunch(
  bay: readonly BayStack[],
  facts: ReadonlyMap<number, DroneFacts>,
  ship: ShipLimits,
  target: TargetFacts | readonly TargetFacts[],
): LaunchPlan {
  const buckets = new Map<number, TypeBucket>();
  for (const stack of bay) {
    const f = facts.get(stack.typeID);
    // Inventory represents a recovered singleton with quantity -1. It is one
    // available drone, just as in the supply and rearm counts.
    const quantity = Number.isFinite(stack.quantity)
      ? stack.quantity < 0 ? 1 : Math.floor(stack.quantity)
      : 0;
    if (f === undefined || quantity <= 0) {
      continue;
    }
    const bucket = buckets.get(stack.typeID) ?? { facts: f, stacks: [], total: 0, score: null };
    bucket.stacks.push({ ...stack, quantity });
    bucket.total += quantity;
    buckets.set(stack.typeID, bucket);
  }
  if (buckets.size === 0) {
    return NO_PLAN_UNKNOWN;
  }
  for (const bucket of buckets.values()) {
    bucket.score = scoreAgainst(bucket.facts, target);
  }
  const scored = [...buckets.values()].filter((b) => b.score !== null);
  if (scored.length === 0) {
    return NO_PLAN_UNKNOWN;
  }
  const slots0 = Math.max(0, Math.floor(ship.maxActive));
  const bw0 = Math.max(0, ship.bandwidthMbit);

  // Every candidate primary is tried WITH its fill, and the best total wins: a
  // bay holding two heavies and a pile of mediums is judged on the flight it
  // can actually field, not on the heavy alone.
  const build = (primary: TypeBucket): { out: { itemID: number; quantity: number }[]; dps: number } => {
    const out: { itemID: number; quantity: number }[] = [];
    let bwLeft = bw0;
    let slotsLeft = slots0;
    let dps = 0;
    const take = (bucket: TypeBucket): void => {
      let n = fitCount(bucket, bwLeft, slotsLeft);
      for (const stack of bucket.stacks) {
        if (n <= 0) {
          break;
        }
        const q = Math.min(stack.quantity, n);
        out.push({ itemID: stack.itemID, quantity: q });
        n -= q;
        bwLeft -= q * bucket.facts.bandwidthMbit;
        slotsLeft -= q;
        dps += q * (bucket.score ?? 0);
      }
    };
    take(primary);
    const fillers = scored
      .filter(
        (b) =>
          b !== primary && b.facts.bandwidthMbit < primary.facts.bandwidthMbit && (b.score ?? 0) >= USELESS_DPS,
      )
      .sort((a, b) => b.facts.bandwidthMbit - a.facts.bandwidthMbit);
    for (const bucket of fillers) {
      take(bucket);
    }
    return { out, dps };
  };

  let best: { bucket: TypeBucket; out: { itemID: number; quantity: number }[]; dps: number } | null = null;
  for (const bucket of scored) {
    if ((bucket.score ?? 0) < USELESS_DPS) {
      continue;
    }
    const built = build(bucket);
    if (built.out.length === 0) {
      continue;
    }
    const better =
      best === null ||
      built.dps > best.dps + 1e-9 ||
      (Math.abs(built.dps - best.dps) <= 1e-9 && bucket.facts.bandwidthMbit < best.bucket.facts.bandwidthMbit);
    if (better) {
      best = { bucket, ...built };
    }
  }
  if (best === null) {
    return { stacks: [], primaryTypeID: null, expectedDps: 0 };
  }
  return { stacks: best.out, primaryTypeID: best.bucket.facts.typeID, expectedDps: best.dps };
}

// ─── WHEN TO SWITCH ──────────────────────────────────────────────────────────

/**
 * Least time between two switches.
 *
 * 20 s: a switch is a recall, a launch and a flight out (the cost helper below
 * puts that near 10-30 s), so a second one inside that window swaps drones that
 * have not yet fired a cycle (4 s) at the target; and the inputs that drive the
 * choice (the target's speed and the in-flight survivors) move around by the
 * tick, so with no floor a number sitting on the line would flip every tick.
 */
export const MIN_SWITCH_INTERVAL_MS = 20_000;

/**
 * A drone going to a size too SMALL is only worth it when the saved time beats
 * the cost by this factor: it is a long fight, not a marginal one. 3 so that a
 * ~20 s switch needs a minute of saving before the lights are given up on.
 */
export const UP_SWITCH_SAVING_FACTOR = 3;

/**
 * Without a known remaining EHP, the too-BIG case switches only on a gain this
 * large (a big drone missing a small target is lopsided, not marginal).
 */
export const DOWN_SWITCH_UNKNOWN_EHP_RATIO = 2;

/** Recall: the scoop and the server's handling, past the flight home. An estimate. */
export const RECALL_OVERHEAD_S = 2;

/** Launch: the request and the new drones settling, past their flight out. An estimate. */
export const LAUNCH_OVERHEAD_S = 2;

/**
 * Seconds a switch costs.
 *
 * `distanceM` is how far the target is from the ship (the drones fly that far
 * home and the replacements that far out). A drone that does not move (a
 * sentry, maxVelocity ~0) is scooped on the spot and contributes no flight.
 * Flight speed is each flight's slowest member, passed in by the caller.
 */
export function switchCostSeconds(input: {
  readonly distanceM: number;
  /** Slowest top speed in the flight now out, m/s; 0 for stationary/none. */
  readonly currentMaxVelocityMs: number;
  /** Slowest top speed in the flight to launch, m/s; 0 for stationary. */
  readonly newMaxVelocityMs: number;
}): number {
  const dist = Math.max(0, Number.isFinite(input.distanceM) ? input.distanceM : 0);
  const leg = (v: number): number => (v >= STATIONARY_BELOW_MS ? dist / v : 0);
  return RECALL_OVERHEAD_S + leg(input.currentMaxVelocityMs) + LAUNCH_OVERHEAD_S + leg(input.newMaxVelocityMs);
}

export interface SwitchInput {
  /** The flight out now, summed expected dps on the target; null = unknown. */
  readonly currentDps: number | null;
  /** The best alternative's expected dps; null = unknown. */
  readonly bestDps: number | null;
  /** Is the best alternative a SMALLER drone ("down": the current one is too big) or a bigger one ("up")? */
  readonly direction: "down" | "up";
  /** Target remaining effective HP; null = nobody looked. */
  readonly remainingEhp: number | null;
  readonly switchCostS: number;
  /** null = never switched. */
  readonly lastSwitchAtMs: number | null;
  readonly nowMs: number;
}

/**
 * Whether to recall and relaunch, and why in one short player-facing sentence
 * (plain ASCII).
 *
 * ⚠ THE ASYMMETRY IS DELIBERATE. Heavies on a fast frigate miss almost every
 * shot and keep missing for as long as the fight lasts, so the move to lights
 * is made as soon as the saved time beats the cost (or, with the EHP unknown,
 * on a lopsided gain). Lights on a battleship still HIT: they are only slow,
 * so giving them up costs a certain 10-30 s against a gain that exists only if
 * the fight is long, and it is made only when the saving beats the cost
 * `UP_SWITCH_SAVING_FACTOR` times over. An unknown EHP never justifies that
 * one.
 *
 * Saved time = EHP/current - EHP/best (0 current dps = never, so any positive
 * best wins outright).
 */
export function shouldSwitch(input: SwitchInput): { switch: boolean; why: string } {
  const no = (why: string) => ({ switch: false, why });
  const { currentDps, bestDps } = input;
  if (currentDps === null || bestDps === null) {
    return no("Not switching drones, the target is not known well enough.");
  }
  if (input.lastSwitchAtMs !== null && input.nowMs - input.lastSwitchAtMs < MIN_SWITCH_INTERVAL_MS) {
    return no("Not switching drones again so soon.");
  }
  if (!(bestDps > currentDps)) {
    return no("The drones out are as good as any in the bay.");
  }
  const ehp = input.remainingEhp;
  const cost = Math.max(0, Number.isFinite(input.switchCostS) ? input.switchCostS : 0);

  if (currentDps <= 0) {
    return { switch: true, why: "Switching drones, the ones out cannot hurt this target." };
  }

  if (input.direction === "down") {
    if (ehp === null) {
      return bestDps >= currentDps * DOWN_SWITCH_UNKNOWN_EHP_RATIO
        ? { switch: true, why: "Switching to smaller drones, the big ones are missing." }
        : no("Not switching drones, the gain is small.");
    }
    const saved = ehp / currentDps - ehp / bestDps;
    return saved > cost
      ? { switch: true, why: "Switching to smaller drones, the big ones are missing." }
      : no("Not switching drones, it would not pay back.");
  }

  if (ehp === null) {
    return no("Not switching to bigger drones, the fight length is not known.");
  }
  const saved = ehp / currentDps - ehp / bestDps;
  return saved > cost * UP_SWITCH_SAVING_FACTOR
    ? { switch: true, why: "Switching to bigger drones, this will be a long fight." }
    : no("Keeping the small drones, the fight is too short to swap.");
}

// ── the two questions a companion asks ───────────────────────────────────────
//
// Everything above answers "how good is this drone on that target". The fleet
// companion asks two narrower things, once per tick: WHAT goes out when no
// combat drone is out, and whether the flight that IS out should come home for
// a better one. Both answer `null` for "cannot judge" -- an unread bay, an
// unread hull limit, a drone type whose dogma has not landed, a target with no
// signature -- and the caller then does exactly what it did before this module
// existed. Sizing is an improvement on the old launch, never a new way to sit
// on a full bay.

/**
 * The launch for these targets, or null when it cannot be judged OR when
 * nothing in the bay can hurt them (the caller's old whole-bay launch is no
 * worse than an empty one in that case, and it still defends the ship).
 */
export function sizedLaunch(
  bay: readonly BayStack[] | null,
  facts: ReadonlyMap<number, DroneFacts>,
  limits: ShipLimits | null,
  targets: readonly TargetFacts[],
): LaunchPlan | null {
  if (bay === null || limits === null || targets.length === 0) {
    return null;
  }
  const plan = planLaunch(bay, facts, limits, targets.length === 1 ? targets[0]! : targets);
  if (plan.expectedDps === null || plan.primaryTypeID === null || plan.stacks.length === 0) {
    return null;
  }
  return plan;
}

export interface SwitchQuestion {
  /** The typeID of every combat drone of this ship's out in space, one per drone. */
  readonly flightTypeIDs: readonly (number | null)[];
  /** What is still in the bay. The flight out joins it in the comparison. */
  readonly bay: readonly BayStack[] | null;
  readonly facts: ReadonlyMap<number, DroneFacts>;
  readonly limits: ShipLimits | null;
  readonly target: TargetFacts;
  readonly remainingEhp: number | null;
  readonly lastSwitchAtMs: number | null;
  readonly nowMs: number;
}

/**
 * Should the flight out come home for a better one against this target?
 *
 * The comparison is against the best flight the WHOLE pool could make -- the
 * bay plus the drones out, since they are coming home if this says yes -- so a
 * bay holding nothing better can never trigger a recall. A best flight of the
 * same size as the one out (same largest bandwidth per drone) is no switch: a
 * size switch is what this rule prices, and shuffling equals buys nothing.
 */
export function sizeSwitchVerdict(q: SwitchQuestion): { switch: boolean; why: string } | null {
  if (q.bay === null || q.limits === null || q.flightTypeIDs.length === 0) {
    return null;
  }
  const flight: DroneFacts[] = [];
  for (const typeID of q.flightTypeIDs) {
    const f = typeID === null ? undefined : q.facts.get(typeID);
    if (f === undefined) {
      return null;
    }
    flight.push(f);
  }
  let currentDps = 0;
  for (const f of flight) {
    const dps = expectedAppliedDps(f, q.target);
    if (dps === null) {
      return null;
    }
    currentDps += dps;
  }
  // The flight joins the pool under stand-in ids: only the plan's choice and
  // its dps are read here, never which stack it would launch.
  const counts = new Map<number, number>();
  for (const f of flight) {
    counts.set(f.typeID, (counts.get(f.typeID) ?? 0) + 1);
  }
  const pool: BayStack[] = [...q.bay];
  for (const [typeID, quantity] of counts) {
    pool.push({ itemID: -typeID, typeID, quantity });
  }
  const best = planLaunch(pool, q.facts, q.limits, q.target);
  if (best.expectedDps === null || best.primaryTypeID === null) {
    return null;
  }
  const primary = q.facts.get(best.primaryTypeID);
  if (primary === undefined) {
    return null;
  }
  const flightBandwidth = Math.max(...flight.map((f) => f.bandwidthMbit));
  if (primary.bandwidthMbit === flightBandwidth) {
    return { switch: false, why: "These drones are the right size for this target." };
  }
  const moving = flight.filter((f) => !f.stationary).map((f) => f.maxVelocityMs);
  const switchCostS = switchCostSeconds({
    distanceM: q.target.distanceFromShipM ?? 0,
    currentMaxVelocityMs: moving.length === 0 ? 0 : Math.min(...moving),
    newMaxVelocityMs: primary.stationary ? 0 : primary.maxVelocityMs,
  });
  return shouldSwitch({
    currentDps,
    bestDps: best.expectedDps,
    direction: primary.bandwidthMbit < flightBandwidth ? "down" : "up",
    remainingEhp: q.remainingEhp,
    switchCostS,
    lastSwitchAtMs: q.lastSwitchAtMs,
    nowMs: q.nowMs,
  });
}
