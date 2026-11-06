// Real ship statistics for the fitting window (goal R21, slice B).
//
// WHERE THESE NUMBERS COME FROM
//
// Every value here is a pure function of the attribute map the SERVER already
// sends us in `dogmaIM.ShipGetInfo`. The browser does not simulate dogma and
// does not hold a second opinion about any of it: it promotes what the server
// computed (`1 − resonance`), or does arithmetic whose inputs are entirely
// server values (EHP from HP and resonances, align time from mass and inertia
// using the server's own formula).
//
// THE TRAP, AND WHY WE ARE NOT IN IT
//
// R20 found that `buildShipResourceState()` called bare applies only PASSIVE
// and ONLINE effects — every active module contributes nothing and nothing
// errors, which reads a Drake's EM resist as 20% instead of 61.3% and halves
// its EHP. That trap is real, but it is a trap for a caller INSIDE eve.js.
//
// `ShipGetInfo` is not such a caller. It goes
//   Handle_ShipGetInfo -> _buildShipAttributeDict -> getShipFittingSnapshot
//   -> buildFittingSnapshot -> buildSnapshotResourceState,
// and that last step re-solves with `collectAssumedActiveFittingEffects`
// through `additionalAttributeModifierEntries`, with `assumeActiveShipModules`
// defaulting to true. So the resonances that reach this module ALREADY have
// hardeners applied. `shipStats.test.ts` pins that with the real Drake numbers
// (0.387… not 0.8), so if that call path ever changes underneath us, the suite
// says so instead of the window quietly halving everyone's tank.
//
// WHAT WE DO NOT KNOW
//
// The web gateway allows exactly two fitting reads: `ShipGetInfo` (the SHIP's
// attributes) and `ShipOnlineModules` (which modules are on). Nothing returns
// per-MODULE effective attributes, so anything that must be summed over
// modules — DPS, volley, mining yield, repair rates, capacitor usage — cannot
// be computed here at all. Those are reported as unavailable WITH THE REASON,
// never as zero. A zero in a fitting window is a claim, and we are not
// entitled to make it.

/**
 * One statistic: either a number we actually computed, or an honest admission
 * that we could not, with the reason. There is deliberately no third state —
 * a caller cannot accidentally render a missing value as 0.
 */
export type Stat =
  | { readonly known: true; readonly value: number }
  | { readonly known: false; readonly why: string };

export function known(value: number): Stat {
  return { known: true, value };
}

export function unavailable(why: string): Stat {
  return { known: false, why };
}

/** The four damage types, in the order every EVE UI lists them. */
export interface DamageProfile {
  readonly em: number;
  readonly thermal: number;
  readonly kinetic: number;
  readonly explosive: number;
}

/**
 * The damage profile EHP is quoted against. Uniform 25/25/25/25 — the same
 * convention the R20 oracle's own `Ship::damage_profile` defaults to, which is
 * why our EHP reproduces its reference table exactly. The window states the
 * profile next to the number, because an EHP figure without one is meaningless.
 */
export const UNIFORM_DAMAGE_PROFILE: DamageProfile = {
  em: 0.25,
  thermal: 0.25,
  kinetic: 0.25,
  explosive: 0.25,
};

/**
 * Dogma attribute IDs, every one of them read out of THIS build's own
 * `typeDogma.attributeTypesByID` rather than assumed from a wiki.
 *
 * The hull row is the reason that matters: the hull resonances are 109 / 110 /
 * 111 / 113, and 112 is `energyDamageAbsorptionFactor` — NOT a resistance. A
 * contiguous 109-112 read looks obviously right and is wrong.
 */
const ATTR = {
  mass: 4,
  structureHP: 9,
  inertiaModifier: 70,
  maxVelocity: 37,
  capacitorCapacity: 482,
  /** A DOCKED ship reports its effective capacitor here instead (see R12). */
  capacitorCharge: 18,
  capacitorRechargeTime: 55,
  maxTargetRange: 76,
  maxLockedTargets: 192,
  scanResolution: 564,
  signatureRadius: 552,
  cargoCapacity: 38,
  droneCapacity: 283,
  droneBandwidth: 1271,
  droneControlRange: 458,
  baseWarpSpeed: 1281,
  warpSpeedMultiplier: 600,
  shieldHP: 263,
  armorHP: 265,
  shieldRechargeTime: 479,
} as const;

/** Resonances per layer, in EM / thermal / kinetic / explosive order. */
const RESONANCES = {
  shield: { em: 271, thermal: 274, kinetic: 273, explosive: 272 },
  armor: { em: 267, thermal: 270, kinetic: 269, explosive: 268 },
  hull: { em: 113, thermal: 110, kinetic: 109, explosive: 111 },
} as const;

const SENSORS: readonly { readonly attribute: number; readonly name: string }[] = [
  { attribute: 208, name: "Radar" },
  { attribute: 209, name: "Ladar" },
  { attribute: 210, name: "Magnetometric" },
  { attribute: 211, name: "Gravimetric" },
];

export type LayerName = "shield" | "armor" | "hull";
export const LAYERS: readonly LayerName[] = ["shield", "armor", "hull"];

/** One layer's four resistances, as FRACTIONS (0.613 = 61.3%). */
export interface LayerResistances {
  readonly em: Stat;
  readonly thermal: Stat;
  readonly kinetic: Stat;
  readonly explosive: Stat;
}

export interface LayerTank {
  readonly hp: Stat;
  readonly resistances: LayerResistances;
  readonly ehp: Stat;
}

export interface ShipStats {
  readonly tank: Readonly<Record<LayerName, LayerTank>>;
  readonly totalEhp: Stat;
  /**
   * The client's own defense panel figures (fittingUtil GetEffectiveHp, defensePanel.py: bridge/dogma/defense.ts),
   * where the figures are the page's own dogma's. Absent where they are the server's.
   */
  readonly defense?: import("./dogma/defense.ts").DefenseReading;
  /**
   * The client's own drone panel figures (shipfitting/droneUtil, clientDogmaLocation.GetActiveDrones:
   * bridge/dogma/drones.ts), where the figures are the page's own dogma's. Absent where they are the server's.
   */
  readonly drones?: import("./dogma/drones.ts").DroneReading;
  /**
   * Seconds for the shield to recharge from empty (attribute 479 / 1000). The
   * ship reports this directly, so it is sourced — unlike the ACTIVE repair
   * rates, which need per-module reads and stay unavailable.
   */
  readonly shieldRechargeSeconds: Stat;
  readonly damageProfile: DamageProfile;

  readonly capacitor: {
    readonly capacity: Stat;
    readonly rechargeSeconds: Stat;
    /** Needs per-module capacitor use, which no allowed read returns. */
    readonly deltaPerSecond: Stat;
    /** EveJS has no capacitor solver, and neither did the R20 oracle. */
    readonly stability: Stat;
    readonly lastsForSeconds: Stat;
    /**
     * The client's capacitor simulation (fittingDogmaLocationUtil.CapacitorSimulator, ghostControllerMixin
     * ._GetCapSimulatorValues), where the figures are the page's own dogma's: the spare recharge in GJ/s (two
     * places), its share of the peak recharge (one place), the share of the capacity it settles at (0 where it runs
     * out), and when it runs out, in 100ns ticks (null where it does not). Absent where the figures are the server's.
     */
    readonly simulator?: {
      readonly delta: number;
      readonly deltaPercentage: number;
      readonly loadBalance: number;
      readonly ttl: number | null;
    };
  };

  readonly firepower: {
    readonly dps: Stat;
    readonly volley: Stat;
    readonly droneDps: Stat;
    /**
     * The client's own reckoning of the weapons (fittingDogmaLocationUtil GetTurretMissileAndAoeDps and
     * GetAlphaStrike: bridge/dogma/offense.ts), where the figures are the page's own dogma's. Absent where they are
     * the server's.
     */
    readonly simulator?: import("./dogma/offense.ts").OffenseReading;
  };
  readonly mining: { readonly cubicMetresPerSecond: Stat };
  readonly repairs: Readonly<Record<LayerName, Stat>>;

  readonly navigation: {
    readonly maxVelocity: Stat;
    readonly alignTimeSeconds: Stat;
    readonly warpSpeedAuPerSecond: Stat;
    readonly signatureRadius: Stat;
    readonly mass: Stat;
    /** The agility (inertia modifier). */
    readonly inertiaModifier: Stat;
  };

  readonly targeting: {
    readonly maxTargetRange: Stat;
    readonly maxLockedTargets: Stat;
    readonly scanResolution: Stat;
    readonly sensorStrength: Stat;
    readonly sensorName: string | null;
  };

  readonly bays: {
    readonly cargoCapacity: Stat;
    readonly droneCapacity: Stat;
    readonly droneBandwidth: Stat;
    readonly droneControlRange: Stat;
  };
}

type Attributes = ReadonlyMap<number, number | null>;

/** Read an attribute as a finite number, or say why we could not. */
function read(attributes: Attributes, attribute: number, label: string): Stat {
  const value = attributes.get(attribute);
  if (typeof value === "number" && Number.isFinite(value)) {
    return known(value);
  }
  return unavailable(`your ship does not report ${label}`);
}

function readPositive(attributes: Attributes, attribute: number, label: string): Stat {
  const stat = read(attributes, attribute, label);
  if (stat.known && stat.value <= 0) {
    return unavailable(`your ship does not report ${label}`);
  }
  return stat;
}

/**
 * A resistance from its resonance. This is the whole conversion: EveJS holds
 * the resonance (the fraction of damage that gets THROUGH) and it is already
 * correct to fifteen significant figures — R20 checked it against an
 * independent engine and found zero disagreements. All that was ever missing
 * was `1 − resonance`.
 */
function resistanceFromResonance(attributes: Attributes, attribute: number): Stat {
  const value = attributes.get(attribute);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return unavailable("your ship does not report this resistance");
  }
  return known(1 - value);
}

function layerResistances(attributes: Attributes, layer: LayerName): LayerResistances {
  const ids = RESONANCES[layer];
  return {
    em: resistanceFromResonance(attributes, ids.em),
    thermal: resistanceFromResonance(attributes, ids.thermal),
    kinetic: resistanceFromResonance(attributes, ids.kinetic),
    explosive: resistanceFromResonance(attributes, ids.explosive),
  };
}

/**
 * Effective hit points for one layer against a damage profile.
 *
 *   EHP = HP / Σ(profileᵢ × resonanceᵢ)
 *
 * With the uniform profile the divisor is just the mean resonance. Verified
 * against every fit in the R20 corpus — a Drake comes out at 75 982 EHP, which
 * is the oracle's own figure to the unit.
 */
function layerEhp(
  attributes: Attributes,
  layer: LayerName,
  hp: Stat,
  profile: DamageProfile,
): Stat {
  if (!hp.known) {
    return unavailable(hp.why);
  }
  const ids = RESONANCES[layer];
  const terms: [number, number][] = [
    [profile.em, ids.em],
    [profile.thermal, ids.thermal],
    [profile.kinetic, ids.kinetic],
    [profile.explosive, ids.explosive],
  ];
  let divisor = 0;
  for (const [weight, attribute] of terms) {
    const resonance = attributes.get(attribute);
    if (typeof resonance !== "number" || !Number.isFinite(resonance)) {
      return unavailable("your ship does not report all four resistances for this layer");
    }
    divisor += weight * resonance;
  }
  if (divisor <= 0) {
    return unavailable("this layer takes no damage from the chosen profile");
  }
  return known(hp.value / divisor);
}

/**
 * Align time, using the SERVER's own formula — `calculateAlignTimeSecondsFrom
 * MassInertia` in `space/runtime.js`:
 *
 *   alignTime = ln(4) × mass × inertiaModifier / 1 000 000
 *
 * Reproduced here rather than invented, and pinned against the R20 reference
 * values (Rifter 3.20 s, Drake 8.21 s) in the tests.
 */
function alignTime(attributes: Attributes): Stat {
  const mass = attributes.get(ATTR.mass);
  const inertia = attributes.get(ATTR.inertiaModifier);
  if (
    typeof mass !== "number" ||
    typeof inertia !== "number" ||
    !Number.isFinite(mass) ||
    !Number.isFinite(inertia) ||
    mass <= 0 ||
    inertia <= 0
  ) {
    return unavailable("your ship does not report its mass and agility");
  }
  return known((Math.log(4) * mass * inertia) / 1_000_000);
}

/** Warp speed in AU/s: the hull's base warp speed times its multiplier. */
function warpSpeed(attributes: Attributes): Stat {
  const base = attributes.get(ATTR.baseWarpSpeed);
  const multiplier = attributes.get(ATTR.warpSpeedMultiplier);
  if (
    typeof base !== "number" ||
    typeof multiplier !== "number" ||
    !Number.isFinite(base) ||
    !Number.isFinite(multiplier)
  ) {
    return unavailable("your ship does not report its warp speed");
  }
  return known(base * multiplier);
}

/** The capacitor a DOCKED ship reports: capacity, or "charge" while docked. */
function capacitorCapacity(attributes: Attributes): Stat {
  const capacity = attributes.get(ATTR.capacitorCapacity);
  if (typeof capacity === "number" && Number.isFinite(capacity) && capacity > 0) {
    return known(capacity);
  }
  const charge = attributes.get(ATTR.capacitorCharge);
  if (typeof charge === "number" && Number.isFinite(charge) && charge > 0) {
    return known(charge);
  }
  return unavailable("your ship does not report its capacitor");
}

/** Which sensor this hull uses, and how strong it is. */
function sensor(attributes: Attributes): { strength: Stat; name: string | null } {
  let best: { strength: number; name: string } | null = null;
  for (const candidate of SENSORS) {
    const value = attributes.get(candidate.attribute);
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      if (best === null || value > best.strength) {
        best = { strength: value, name: candidate.name };
      }
    }
  }
  if (best === null) {
    return { strength: unavailable("your ship does not report a sensor strength"), name: null };
  }
  return { strength: known(best.strength), name: best.name };
}

/**
 * The reason every module-summed statistic is missing. Stated once, because it
 * is one cause: the bridge is allowed to read the SHIP's attributes and which
 * modules are online, and nothing else.
 */
const NEEDS_MODULE_READ =
  "we cannot read your individual modules' statistics yet, so this cannot be worked out";

/** EveJS has no capacitor solver, and R20 established the oracle has none either. */
const NO_CAP_SOLVER = "working out how long a capacitor lasts is not supported yet";

/**
 * How many targets this pilot can hold in this ship: the lower of the hull's limit and the pilot's own, from their
 * targeting skills (targetMgr.py 1181; the server refuses a lock past the same figure). The fitting window goes on
 * showing the hull's alone, as the client's does (ghostControllerMixin.GetMaxTargets). A pilot's limit not read, or not
 * positive, says nothing and the hull's stands. Null when the hull's was not read either.
 */
export function lockLimitOf(hull: Stat, pilot: number | null): number | null {
  if (!hull.known) return null;
  return pilot !== null && Math.trunc(pilot) >= 1 ? Math.min(hull.value, Math.trunc(pilot)) : hull.value;
}

/**
 * Derive everything the fitting window shows from the ship's attribute map. The drone control range is the pilot's
 * (ghostControllerMixin.GetDroneControlRange: the character's droneControlDistance), read from `pilotAttributes`
 * where they are given, else from the ship's map.
 */
export function deriveShipStats(
  attributes: Attributes,
  profile: DamageProfile = UNIFORM_DAMAGE_PROFILE,
  pilotAttributes: Attributes | null = null,
): ShipStats {
  const hp: Record<LayerName, Stat> = {
    shield: readPositive(attributes, ATTR.shieldHP, "its shield strength"),
    armor: readPositive(attributes, ATTR.armorHP, "its armor strength"),
    hull: readPositive(attributes, ATTR.structureHP, "its structure strength"),
  };

  const tank = {} as Record<LayerName, LayerTank>;
  let total = 0;
  let anyLayerKnown = false;
  for (const layer of LAYERS) {
    const ehp = layerEhp(attributes, layer, hp[layer], profile);
    tank[layer] = { hp: hp[layer], resistances: layerResistances(attributes, layer), ehp };
    if (ehp.known) {
      total += ehp.value;
      anyLayerKnown = true;
    }
  }
  // A total that silently omits a layer would understate the ship, so it is
  // only offered when all three layers actually came out.
  const everyLayerKnown = LAYERS.every((layer) => tank[layer].ehp.known);
  const totalEhp = everyLayerKnown
    ? known(total)
    : unavailable(
        anyLayerKnown
          ? "one of your ship's layers did not report enough to total this up"
          : "your ship does not report enough to work this out",
      );

  const sensorReading = sensor(attributes);
  const rechargeMs = readPositive(attributes, ATTR.capacitorRechargeTime, "its capacitor recharge");
  const shieldRechargeMs = readPositive(
    attributes,
    ATTR.shieldRechargeTime,
    "its shield recharge",
  );

  return {
    tank,
    totalEhp,
    shieldRechargeSeconds: shieldRechargeMs.known
      ? known(shieldRechargeMs.value / 1000)
      : shieldRechargeMs,
    damageProfile: profile,

    capacitor: {
      capacity: capacitorCapacity(attributes),
      rechargeSeconds: rechargeMs.known ? known(rechargeMs.value / 1000) : rechargeMs,
      deltaPerSecond: unavailable(NEEDS_MODULE_READ),
      stability: unavailable(NO_CAP_SOLVER),
      lastsForSeconds: unavailable(NO_CAP_SOLVER),
    },

    firepower: {
      dps: unavailable(NEEDS_MODULE_READ),
      volley: unavailable(NEEDS_MODULE_READ),
      droneDps: unavailable(NEEDS_MODULE_READ),
    },
    mining: { cubicMetresPerSecond: unavailable(NEEDS_MODULE_READ) },
    repairs: {
      shield: unavailable(NEEDS_MODULE_READ),
      armor: unavailable(NEEDS_MODULE_READ),
      hull: unavailable(NEEDS_MODULE_READ),
    },

    navigation: {
      maxVelocity: read(attributes, ATTR.maxVelocity, "its speed"),
      alignTimeSeconds: alignTime(attributes),
      warpSpeedAuPerSecond: warpSpeed(attributes),
      signatureRadius: readPositive(attributes, ATTR.signatureRadius, "its signature radius"),
      mass: readPositive(attributes, ATTR.mass, "its mass"),
      inertiaModifier: readPositive(attributes, ATTR.inertiaModifier, "its inertia modifier"),
    },

    targeting: {
      maxTargetRange: readPositive(attributes, ATTR.maxTargetRange, "its targeting range"),
      maxLockedTargets: readPositive(attributes, ATTR.maxLockedTargets, "how many targets it can lock"),
      scanResolution: readPositive(attributes, ATTR.scanResolution, "its scan resolution"),
      sensorStrength: sensorReading.strength,
      sensorName: sensorReading.name,
    },

    bays: {
      cargoCapacity: read(attributes, ATTR.cargoCapacity, "its cargo space"),
      droneCapacity: read(attributes, ATTR.droneCapacity, "its drone bay"),
      droneBandwidth: read(attributes, ATTR.droneBandwidth, "its drone bandwidth"),
      droneControlRange: readPositive(pilotAttributes ?? attributes, ATTR.droneControlRange, "its drone control range"),
    },
  };
}
