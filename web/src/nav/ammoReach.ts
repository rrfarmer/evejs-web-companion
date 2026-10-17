// What a gun would reach with a charge it does not have loaded, and what a
// charge type says about itself -- the arithmetic behind ammo by target (plan
// §5.2). Pure: it reads no store and no bridge.
//
// ⚠ THE LOADED CHARGE'S MEASURED REACH IS THE ANCHOR, NEVER THE MODULE'S TYPE.
// `combatFit` reads the gun's reach off the bound (skilled, fitted, rigged)
// dogma with the loaded charge in it. Static type dogma knows none of that, so
// the candidate's reach is the measured one scaled by the RATIO of the two
// charges' own factors: everything else that multiplies range (skills, rigs,
// tracking computers, the hull bonus) cancels in the ratio.
//
//   turret:  base optimal = optimalM / mult120(loaded)
//            base falloff = (reachM - optimalM) / mult517(loaded)
//            reach(X)     = base optimal x mult120(X) + base falloff x mult517(X)
//   missile: reach(X)     = reachM x (v(X) x t(X)) / (v(loaded) x t(loaded))
//
// ⚠ AN UNKNOWN FACTOR IS AN UNKNOWN REACH (null), NEVER A GUESS. The ranking
// treats a null reach as "in reach" (fails open) and the swap gate never swaps
// on unknown damage, so a null here costs a ranking refinement and nothing more.
//
// Attribute ids, checked against the SDE build the server runs
// (dogmaAttributes.jsonl): 37 maxVelocity, 114 emDamage, 116 explosiveDamage,
// 117 kineticDamage, 118 thermalDamage, 120 weaponRangeMultiplier,
// 128 chargeSize, 281 explosionDelay (ms), 517 fallofMultiplier (sic).
//
// ⚠ ABSENT IS THE SDE DEFAULT ON A TYPE THE TABLES KNOW. The BFF's type dogma
// route answers only attributes a type CARRIES (`getTypeDogmaAttribute`, raw),
// and dogma resolves a missing one to the attribute's own default -- which is
// how the game treats Antimatter Charge S, a charge with no 517 at all. So on a
// row that has anything in it: 120 and 517 default to 1.0, a missing damage
// component is 0. A row that is EMPTY (the tables do not know the type) or
// missing (never answered) is unknown throughout. 37, 281 and 128 have no
// usable default (0 is "no reach" / "no size") and stay null when absent.

export const ATTR_MAX_VELOCITY = 37;
export const ATTR_EM_DAMAGE = 114;
export const ATTR_EXPLOSIVE_DAMAGE = 116;
export const ATTR_KINETIC_DAMAGE = 117;
export const ATTR_THERMAL_DAMAGE = 118;
export const ATTR_WEAPON_RANGE_MULTIPLIER = 120;
export const ATTR_CHARGE_SIZE = 128;
export const ATTR_EXPLOSION_DELAY = 281;
export const ATTR_FALLOFF_MULTIPLIER = 517;

/** Everything one read of a charge type asks for. */
export const CHARGE_ATTRIBUTE_IDS: readonly number[] = Object.freeze([
  ATTR_EM_DAMAGE, ATTR_EXPLOSIVE_DAMAGE, ATTR_KINETIC_DAMAGE, ATTR_THERMAL_DAMAGE,
  ATTR_WEAPON_RANGE_MULTIPLIER, ATTR_FALLOFF_MULTIPLIER, ATTR_MAX_VELOCITY, ATTR_EXPLOSION_DELAY,
  ATTR_CHARGE_SIZE,
]);

/** What a charge TYPE says about itself, from static dogma. */
export interface ChargeFacts {
  /** Raw per-shot damage; null when the type is unknown or carries no damage at all. */
  readonly damage: {
    readonly em: number;
    readonly thermal: number;
    readonly kinetic: number;
    readonly explosive: number;
  } | null;
  /** weaponRangeMultiplier (120): a turret charge's optimal factor. */
  readonly rangeMultiplier: number | null;
  /** fallofMultiplier (517): a turret charge's falloff factor. */
  readonly falloffMultiplier: number | null;
  /** maxVelocity (37): a missile's speed, m/s. */
  readonly maxVelocity: number | null;
  /** explosionDelay (281): a missile's flight time, ms. */
  readonly explosionDelayMs: number | null;
  /** chargeSize (128): 1 small, 2 medium, 3 large, 4 capital; null when not carried. */
  readonly size: number | null;
  /** The type's name for the readout; null when not resolved. */
  readonly name: string | null;
}

export const UNKNOWN_CHARGE: ChargeFacts = Object.freeze({
  damage: null, rangeMultiplier: null, falloffMultiplier: null,
  maxVelocity: null, explosionDelayMs: null, size: null, name: null,
});

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positive(value: unknown): number | null {
  const n = finite(value);
  return n !== null && n > 0 ? n : null;
}

/**
 * One charge type's facts from its static dogma row (`fetchTypeDogma` shape).
 * `undefined` (never answered) and `{}` (the tables do not know it) are both
 * unknown throughout; see the header for the defaults applied otherwise.
 */
export function chargeFactsFromAttributes(
  row: Readonly<Record<number, number>> | undefined,
  name: string | null = null,
): ChargeFacts {
  if (row === undefined || Object.keys(row).length === 0) {
    return { ...UNKNOWN_CHARGE, name };
  }
  const damageIDs = [ATTR_EM_DAMAGE, ATTR_THERMAL_DAMAGE, ATTR_KINETIC_DAMAGE, ATTR_EXPLOSIVE_DAMAGE];
  const anyDamage = damageIDs.some((id) => finite(row[id]) !== null);
  const component = (id: number): number => Math.max(0, finite(row[id]) ?? 0);
  const multiplier = (id: number): number | null => (row[id] === undefined ? 1 : positive(row[id]));
  return {
    damage: anyDamage
      ? {
          em: component(ATTR_EM_DAMAGE),
          thermal: component(ATTR_THERMAL_DAMAGE),
          kinetic: component(ATTR_KINETIC_DAMAGE),
          explosive: component(ATTR_EXPLOSIVE_DAMAGE),
        }
      : null,
    rangeMultiplier: multiplier(ATTR_WEAPON_RANGE_MULTIPLIER),
    falloffMultiplier: multiplier(ATTR_FALLOFF_MULTIPLIER),
    maxVelocity: positive(row[ATTR_MAX_VELOCITY]),
    explosionDelayMs: positive(row[ATTR_EXPLOSION_DELAY]),
    size: positive(row[ATTR_CHARGE_SIZE]),
    name,
  };
}

/** The loaded gun as `combatFit` measured it. */
export interface LoadedGunReach {
  /** Reach with the loaded charge: optimal + falloff (turret) or velocity x flight time (missile). */
  readonly reachM: number | null;
  /** A turret's optimal with the loaded charge; null for launchers and when unread. */
  readonly optimalM: number | null;
  /** True for a turret, false for a launcher, null when it cannot be told. */
  readonly turret: boolean | null;
}

/**
 * The reach the gun would have with `candidate` loaded instead of `loaded`.
 * Null whenever a factor the formula needs is unknown, zero or not finite. The
 * same type as the loaded one is the measured reach itself, not a round trip
 * through the arithmetic.
 */
export function candidateReachM(
  gun: LoadedGunReach,
  loadedTypeID: number | null,
  loaded: ChargeFacts | null,
  candidateTypeID: number,
  candidate: ChargeFacts | null,
): number | null {
  const reachM = positive(gun.reachM);
  if (reachM === null) {
    return null;
  }
  if (loadedTypeID !== null && candidateTypeID === loadedTypeID) {
    return reachM;
  }
  if (loaded === null || candidate === null || gun.turret === null) {
    return null;
  }
  if (gun.turret) {
    const optimalM = positive(gun.optimalM);
    const m120L = positive(loaded.rangeMultiplier);
    const m517L = positive(loaded.falloffMultiplier);
    const m120X = positive(candidate.rangeMultiplier);
    const m517X = positive(candidate.falloffMultiplier);
    if (optimalM === null || m120L === null || m517L === null || m120X === null || m517X === null) {
      return null;
    }
    const falloffM = Math.max(0, reachM - optimalM);
    const result = (optimalM / m120L) * m120X + (falloffM / m517L) * m517X;
    return Number.isFinite(result) && result > 0 ? result : null;
  }
  const vL = positive(loaded.maxVelocity);
  const tL = positive(loaded.explosionDelayMs);
  const vX = positive(candidate.maxVelocity);
  const tX = positive(candidate.explosionDelayMs);
  if (vL === null || tL === null || vX === null || tX === null) {
    return null;
  }
  const result = reachM * (vX * tX) / (vL * tL);
  return Number.isFinite(result) && result > 0 ? result : null;
}
