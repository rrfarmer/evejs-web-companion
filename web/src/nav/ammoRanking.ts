// Ammo by target — the ranking and the swap gate behind §3 and §5.2 of the
// fleet companion combat plan.
//
// Today a gun is loaded with the largest compatible cargo stack, and only when
// it is empty. The operator agreed to rank charges against the target, with
// five rules, and this module is those rules and nothing else (it reads no
// store, no bridge and no clock; `nowMs` is passed in):
//
//   1. The pilot may not carry the right ammo. Then nothing changes: with one
//      type aboard, or with nothing better, the answer is "keep", and an empty
//      gun still gets the largest stack, which is today's rule.
//   2. Ammo changes RANGE as well as damage. A charge that takes the target out
//      of reach is worse than any that keeps it in reach, whatever its damage
//      type. Less damage applied beats none.
//   3. No flicker. A reload is seconds of zero damage per gun, so a rat
//      drifting x, x+1, x across a range edge must never toggle ammo.
//   4. Closing in beats reloading, whenever the ship can move (`canClose`).
//   5. Swap between targets, not mid-target: on the lock-ahead tick the ranking
//      is for the NEXT target and the gun can come up already loaded for it.
//
// ─── WHY EACH NUMBER IS THE NUMBER ───────────────────────────────────────────
//
// AMMO_RANGE_HYSTERESIS_M = 500 m, CAPPED AT A QUARTER OF THE CHARGE'S REACH.
// The same rule lives in the positioning module on the fight branch, so the
// ammo and the positioning agree about where a gun's edge is. The two copies
// are kept from drifting by an identical pinned test table (see
// "reach rule matches the positioning module's table" in the test file), which
// `inReach` below must satisfy exactly. ⚠ NOT kiteBand's 2 km: that number is
// for re-aiming a keep-at-range, and as a reach margin it would mean a charge
// reaching 1.5 km (blaster ammo) could never be counted as entering reach at all.
//
// AMMO_SWAP_PERSIST_TICKS = 5. The tree runs on a ~2 s cadence, so five
// consecutive ticks of the same verdict is ~10 s: longer than any wobble a rat
// makes around an edge, shorter than a fight worth swapping for.
//
// AMMO_SWAP_COOLDOWN_MS = 60 000. Persistence stops a flicker inside one
// verdict; the cooldown stops a SLOW flicker, a rat that crosses the edge every
// twenty seconds and would otherwise cost a reload each time. A minute is
// several reloads' worth of firing time.
//
// AMMO_RELOAD_PENDING_MS = 15 000. A swap or load is a request; the loaded
// charge only changes when the game finishes the reload, and the caller's
// loaded-charge facts refresh about every 10 s. Until the loaded type equals
// the one asked for, the gate says "keep" instead of asking again, or the
// lock-ahead tick (which has no persistence) would re-issue the reload on every
// tick. 15 s outlasts one fact refresh plus a reload; if it passes and the
// charge never changed, the request is presumed lost and the gate may decide
// again.
//
// AMMO_NEXT_TARGET_MIN_INTERVAL_MS = 20 000. The lock-ahead swap skips the
// 60 s cooldown (the target is changing anyway), but successive kills in a pack
// would otherwise swap A to B and back to A on each one. Twenty seconds is
// longer than a reload and the pending latch together, shorter than the
// cooldown, so a real change of target type still gets through.
//
// AMMO_SWAP_MIN_GAIN = 0.25. A reload throws away its seconds of silence, so a
// loaded charge that is hitting is only replaced for a clearly better one. Ten
// per cent more damage never pays back a reload on a target that dies in a
// minute; a quarter more usually does.
//
// ─── THE NON-OBVIOUS CHOICES ─────────────────────────────────────────────────
//
// ⚠ THE REACH EDGE IS STICKY FOR THE LOADED CHARGE ONLY. The loaded charge
// counts as in reach until the target is hysteresis BEYOND its reach; any other
// charge must have the target hysteresis INSIDE its reach before it counts.
// The two thresholds sit 2 x hysteresis apart, so a distance wobbling across
// either one can never make the ranking and the swap gate disagree about who is
// in reach, in both directions: leaving the loaded charge needs a clear
// departure, and entering another needs a clear arrival. Applying the sticky
// test to every charge would let two charges each "keep" the target in reach.
//
// ⚠ UNKNOWN DAMAGE NEVER TRIGGERS A SWAP WHILE THE LOADED CHARGE IS HITTING.
// A swap costs seconds of zero damage and the gain is a guess; a guess on
// either side of the comparison is not a reason to throw away a charge that is
// working. Unknown damage still RANKS (below any known figure), because an
// empty gun must load something, and an out-of-reach loaded charge still
// swaps: that case is about reach, not damage.
//
// ⚠ THE TWO UNKNOWNS FAIL IN OPPOSITE DIRECTIONS, ON PURPOSE. Unknown DAMAGE
// (either charge) blocks a swap; unknown `targetRemainingHp` or
// `damageLostToReload` lets one through. Damage is the core reason to swap: with
// it unknown there is no evidence the swap is better, and acting on no evidence
// throws away a charge that works. Remaining HP is only a refinement, a veto
// ("the target dies before the reload pays off") layered on a swap that the
// damage and reach tests have already shown to be worth making. Without the
// veto's inputs the swap is still the right call on the evidence we do have,
// and requiring them would stop swapping whenever the caller cannot read HP.
//
// ⚠ nextTargetMoment IS EXEMPT FROM PERSISTENCE, THE COOLDOWN, THE ONE-PER-TARGET
// LIMIT AND THE REMAINING-HP CHECK, AND FROM NOTHING ELSE. On the lock-ahead
// tick the current target is nearly dead and the ranking is for a different
// one, so there is no wobble to wait out, no fight being interrupted, and the
// "remaining HP versus the reload's silence" test would be asking about a target
// that is about to die anyway. The gain and reach tests still apply: a swap that
// is not better is not made better by timing. It is also still bound by the
// pending latch and by AMMO_NEXT_TARGET_MIN_INTERVAL_MS: with no persistence,
// the lock-ahead tick would otherwise return "swap" on every tick until the
// loaded charge changed, and swap back and forth across successive kills.
//
// ⚠ A SWAP IS NOT A LOAD. An empty gun is always loaded (nothing is thrown
// away), does not stamp the cooldown and does not count against the target.
// Both do set the pending latch: either is a reload in flight.
//
// ⚠ A DISTANCE OR REACH THAT IS NaN OR INFINITE IS TREATED AS UNKNOWN, and a
// stack that is empty or not a number is not a candidate at all. Unreadable
// facts must not rank, and must never make the comparator return NaN.
//
// The caller should include the loaded charge among the options it ranks (with
// the quantity it would have), so the sticky test and the comparison both have
// something to compare. If it is missing, a better charge simply wins the
// ranking and the gain gate compares against `loaded` directly.
//
// `why` strings are shown to the player: plain ASCII, no names (the caller
// words the names in).

import type { AmmoCode } from "./companionTrace.ts";

export const AMMO_RANGE_HYSTERESIS_M = 500;
export const AMMO_SWAP_PERSIST_TICKS = 5;
export const AMMO_SWAP_COOLDOWN_MS = 60_000;
export const AMMO_SWAP_MIN_GAIN = 0.25;
export const AMMO_RELOAD_PENDING_MS = 15_000;
export const AMMO_NEXT_TARGET_MIN_INTERVAL_MS = 20_000;

export interface ChargeOption {
  /** Cargo stack item id (tie-break: lower wins). */
  readonly itemID: number;
  readonly typeID: number;
  readonly quantity: number;
  /** The reach THIS gun would have with this charge loaded; null when unknown. */
  readonly reachM: number | null;
  /** Raw per-shot damage split; null when unknown. */
  readonly damage: {
    readonly em: number;
    readonly thermal: number;
    readonly kinetic: number;
    readonly explosive: number;
  } | null;
}

/** Damage multipliers (resonances, 0..1, 1 = no resist) of the layer being hit. */
export interface Resonances {
  readonly em: number;
  readonly thermal: number;
  readonly kinetic: number;
  readonly explosive: number;
}

/**
 * Which layer is being hit: the OUTERMOST of shield / armor / hull that still
 * has hit points left (ratio > 0). A stripped shield is not under fire. All
 * unknown (null or not finite) is shield: an unreadable ratio is not a damaged
 * one. Every known layer at 0 is hull, the last one standing.
 */
export function layerUnderFire(
  shieldRatio: number | null,
  armorRatio: number | null,
  hullRatio: number | null,
): "shield" | "armor" | "hull" {
  const known = (r: number | null): r is number => r !== null && Number.isFinite(r);
  if (known(shieldRatio) && shieldRatio > 0) return "shield";
  if (known(armorRatio) && armorRatio > 0) return "armor";
  if (known(hullRatio) && hullRatio > 0) return "hull";
  if (!known(shieldRatio) && !known(armorRatio) && !known(hullRatio)) return "shield";
  return "hull";
}

/**
 * Sum of damage x resonance for one shot; null when the damage is unknown.
 * Unknown resonances (null) are treated as no resist at all (1 each), so the
 * ranking falls back to raw damage.
 */
export function appliedDamage(
  charge: ChargeOption,
  resonances: Resonances | null,
): number | null {
  const d = charge.damage;
  if (d === null) return null;
  const r = resonances ?? { em: 1, thermal: 1, kinetic: 1, explosive: 1 };
  const sum = d.em * r.em + d.thermal * r.thermal + d.kinetic * r.kinetic + d.explosive * r.explosive;
  // A NaN or infinite figure is unreadable damage, not a number to compare.
  return Number.isFinite(sum) ? sum : null;
}

/**
 * Is the target inside the reach? An unknown (null or not finite) reach is "in
 * reach": nothing is known to be wrong. An unknown distance keeps whatever the
 * charge already was (`wasInReach`), and counts as in reach when that is unknown
 * too. The margin is min(hysteresisM, reach / 4); `wasInReach` true is the loaded
 * charge's sticky test (reach + margin), false the candidate's (reach - margin),
 * null is the bare reach.
 *
 * ⚠ The same rule, with the same pinned test table, lives in the positioning
 * module on the fight branch. Change one and the table says so.
 */
export function inReach(
  distanceM: number | null,
  reachM: number | null,
  wasInReach: boolean | null,
  hysteresisM: number = AMMO_RANGE_HYSTERESIS_M,
): boolean {
  if (reachM === null || !Number.isFinite(reachM)) return true;
  if (distanceM === null) return wasInReach ?? true;
  const margin = Math.min(hysteresisM, reachM / 4);
  if (wasInReach === null) return distanceM <= reachM;
  return wasInReach ? distanceM <= reachM + margin : distanceM <= reachM - margin;
}

/** A distance the gate can use: null for missing, NaN or infinite. */
function usableDistance(distanceM: number | null): number | null {
  return distanceM !== null && Number.isFinite(distanceM) ? distanceM : null;
}

/** Can this stack be loaded and ranked at all? Quantity, reach and damage must be sane numbers. */
function isUsable(o: ChargeOption): boolean {
  if (!Number.isFinite(o.quantity) || o.quantity <= 0) return false;
  if (o.reachM !== null && (Number.isNaN(o.reachM) || o.reachM < 0)) return false;
  const d = o.damage;
  if (d !== null && !(Number.isFinite(d.em) && Number.isFinite(d.thermal) && Number.isFinite(d.kinetic) && Number.isFinite(d.explosive))) {
    return false;
  }
  return true;
}

/**
 * Rank the options, best first: (1) in reach (sticky for the loaded type only),
 * (2) higher applied damage, unknown below known, (3) larger quantity,
 * (4) lower item id. Stacks that cannot be used (quantity <= 0 or not a
 * number, a NaN or negative reach, a NaN damage component) are dropped.
 */
export function rankCharges(
  options: readonly ChargeOption[],
  targetDistanceM: number | null,
  resonances: Resonances | null,
  loadedTypeID: number | null,
): readonly ChargeOption[] {
  const distanceM = usableDistance(targetDistanceM);
  const keyed = options.filter(isUsable).map((o) => ({
    o,
    reach: inReach(distanceM, o.reachM, loadedTypeID !== null && o.typeID === loadedTypeID),
    dmg: appliedDamage(o, resonances),
  }));
  keyed.sort((a, b) => {
    if (a.reach !== b.reach) return a.reach ? -1 : 1;
    if (a.dmg !== b.dmg) {
      if (a.dmg === null) return 1;
      if (b.dmg === null) return -1;
      return b.dmg > a.dmg ? 1 : -1;
    }
    if (a.o.quantity !== b.o.quantity) return b.o.quantity > a.o.quantity ? 1 : -1;
    if (a.o.itemID === b.o.itemID) return 0;
    return a.o.itemID < b.o.itemID ? -1 : 1;
  });
  return keyed.map((k) => k.o);
}

/**
 * Rank the options by VERSATILITY, best first: the charge to load when nobody
 * knows where the next target will be.
 *
 * ⚠ VERSATILITY IS RAW DAMAGE x REACH, and that product is not arbitrary. With
 * no target there is no distance and no resist, so the honest question is "what
 * does this charge deal to a target somewhere inside the envelope I carry for?"
 * Take that target's distance as equally likely anywhere out to the longest
 * reach aboard: a charge reaching R hits it with probability R / longest, so its
 * expected damage per shot is damage x R / longest, and `longest` is the same
 * for every option. Maximising damage x reach is maximising that expectation.
 * It is why neither end wins by default: the short, heavy charge loses on reach
 * and the long, light one on damage, and the middle charge that keeps most of
 * both comes out on top -- the operator's "the one which is most versatile"
 * (2026-10-14), read as a number.
 *
 * Ties and unknowns, in order: (1) a known score above an unknown one (reach or
 * damage unknown), (2) higher raw damage, unknown below known, (3) larger
 * quantity, (4) lower item id. Unknown never wins over known and never makes the
 * comparator NaN; with every score unknown it degrades to "most damage, then the
 * biggest stack". Stacks that `rankCharges` would drop are dropped here too.
 */
export function rankByVersatility(options: readonly ChargeOption[]): readonly ChargeOption[] {
  const keyed = options.filter(isUsable).map((o) => {
    const dmg = appliedDamage(o, null);
    const reach = o.reachM !== null && Number.isFinite(o.reachM) ? o.reachM : null;
    const score = dmg === null || reach === null ? null : dmg * reach;
    return { o, dmg, score: score !== null && Number.isFinite(score) ? score : null };
  });
  const higherFirst = (a: number | null, b: number | null): number => {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return b > a ? 1 : -1;
  };
  keyed.sort((a, b) =>
    higherFirst(a.score, b.score) ||
    higherFirst(a.dmg, b.dmg) ||
    higherFirst(a.o.quantity, b.o.quantity) ||
    (a.o.itemID === b.o.itemID ? 0 : a.o.itemID < b.o.itemID ? -1 : 1));
  return keyed.map((k) => k.o);
}

/** Per-gun memory the caller stores between ticks. */
export interface SwapMemory {
  readonly wantedTypeID: number | null;
  readonly wantedTicks: number;
  readonly lastSwapAtMs: number | null;
  readonly swappedForTargetID: number | null;
  /** Type id of a swap or load in flight (the reload is under way); null when none. */
  readonly pendingTypeID: number | null;
  /** When that swap or load was decided; null when none. */
  readonly pendingSinceMs: number | null;
}

export const FRESH_SWAP_MEMORY: SwapMemory = {
  wantedTypeID: null,
  wantedTicks: 0,
  lastSwapAtMs: null,
  swappedForTargetID: null,
  pendingTypeID: null,
  pendingSinceMs: null,
};

export interface SwapInputs {
  /** From rankCharges. */
  readonly ranked: readonly ChargeOption[];
  /** What is in the gun now; null = empty (a load is always allowed, not a swap). */
  readonly loaded: ChargeOption | null;
  readonly targetDistanceM: number | null;
  readonly resonances: Resonances | null;
  readonly targetID: number | null;
  /** Effective HP left on the target; null unknown. */
  readonly targetRemainingHp: number | null;
  /**
   * Damage (not DPS) the gun would deal to the target during the reload's
   * silence if it kept firing; compared with `targetRemainingHp`. Null unknown.
   */
  readonly damageLostToReload: number | null;
  /** The ship can still close the range instead (positioning rung not exhausted). */
  readonly canClose: boolean;
  /** Lock-ahead tick: the ranking is for the NEXT target; the current one is nearly dead. */
  readonly nextTargetMoment: boolean;
  readonly nowMs: number;
  readonly memory: SwapMemory;
}

/**
 * `code` names exactly one return path of `decideSwap` (see `AmmoCode` in
 * companionTrace.ts); `why` is the sentence for a player, several paths of which
 * could share one.
 */
export type SwapDecision =
  | { readonly kind: "load"; readonly code: AmmoCode; readonly charge: ChargeOption; readonly memory: SwapMemory; readonly why: string }
  | { readonly kind: "swap"; readonly code: AmmoCode; readonly charge: ChargeOption; readonly memory: SwapMemory; readonly why: string }
  | { readonly kind: "keep"; readonly code: AmmoCode; readonly memory: SwapMemory; readonly why: string };

/**
 * One tick of the swap gate for one gun: load, swap or keep, with a `why` the
 * player can read and the memory to store for next tick. The ranking is passed
 * in (see `rankCharges`); this function only decides whether acting on it is
 * worth a reload.
 *
 * WHY: a reload is seconds of zero damage per gun, so the answer is "keep"
 * unless the loaded charge is out of reach or clearly worse, the verdict has
 * held for a while, and the swap has not been made too recently, or for this
 * target already (see the numbers at the top). A reload already in flight is
 * never asked for twice.
 *
 * ⚠ THE PENDING LATCH COMES FIRST. After any load or swap the gate answers
 * "keep" until the loaded type equals the one asked for, or
 * AMMO_RELOAD_PENDING_MS passes. The caller's loaded-charge facts lag the
 * game's by seconds; without the latch the lock-ahead tick (no persistence)
 * would say "swap" on every tick until the facts caught up.
 *
 * ⚠ THE TWO UNKNOWNS FAIL IN OPPOSITE DIRECTIONS. Unknown damage on either
 * charge blocks a swap; unknown `targetRemainingHp` or `damageLostToReload`
 * does not. Damage is the reason to swap at all, and acting on a guess throws
 * away a working charge. Remaining HP is only a veto on a swap the damage and
 * reach tests have already justified, so its absence leaves that case intact.
 *
 * ⚠ AN EMPTY GUN IS LOADED, NOT SWAPPED. It skips every timing gate except the
 * latch, and stamps neither the cooldown nor the per-target limit.
 */
export function decideSwap(inputs: SwapInputs): SwapDecision {
  const { ranked, loaded, nowMs, nextTargetMoment } = inputs;
  const distanceM = usableDistance(inputs.targetDistanceM);

  // A reload in flight: resolved once the loaded type is the one asked for,
  // lost once it has been pending for AMMO_RELOAD_PENDING_MS.
  let memory = inputs.memory;
  if (memory.pendingTypeID !== null) {
    const arrived = loaded !== null && loaded.typeID === memory.pendingTypeID;
    const expired = memory.pendingSinceMs === null || nowMs - memory.pendingSinceMs >= AMMO_RELOAD_PENDING_MS;
    if (!arrived && !expired) {
      return { kind: "keep", code: "reload-pending", memory, why: "reload under way, waiting for the new charge to load" };
    }
    memory = { ...memory, pendingTypeID: null, pendingSinceMs: null };
  }
  const cleared: SwapMemory = { ...memory, wantedTypeID: null, wantedTicks: 0 };

  // Empty gun: a load, not a swap. Nothing is thrown away, nothing is stamped.
  if (loaded === null) {
    const best = ranked[0];
    if (best === undefined) {
      return { kind: "keep", code: "nothing-compatible", memory: cleared, why: "nothing compatible aboard" };
    }
    return {
      kind: "load",
      code: "load",
      charge: best,
      memory: { ...cleared, pendingTypeID: best.typeID, pendingSinceMs: nowMs },
      why: "loading the best charge aboard into the empty gun",
    };
  }

  const best = ranked[0];
  if (best === undefined) {
    return { kind: "keep", code: "nothing-to-change-to", memory: cleared, why: "nothing compatible aboard to change to" };
  }
  if (best.typeID === loaded.typeID) {
    const onlyOne = ranked.every((c) => c.typeID === loaded.typeID);
    return {
      kind: "keep",
      code: "already-best",
      memory: cleared,
      why: onlyOne ? "only one ammo type aboard" : "keeping the loaded charge: it is still the best choice",
    };
  }

  // The verdict differs from what is loaded: count how long it has held.
  const ticks = best.typeID === memory.wantedTypeID ? memory.wantedTicks + 1 : 1;
  const counting: SwapMemory = { ...memory, wantedTypeID: best.typeID, wantedTicks: ticks };
  const keep = (code: AmmoCode, why: string): SwapDecision => ({ kind: "keep", code, memory: counting, why });

  const loadedApplies = inReach(distanceM, loaded.reachM, true);
  const bestReaches = inReach(distanceM, best.reachM, false);
  const bestDamage = appliedDamage(best, inputs.resonances);
  const loadedDamage = appliedDamage(loaded, inputs.resonances);

  // Is the swap worth making at all? (reach and damage, before any timing.)
  let reason: string;
  if (!loadedApplies) {
    if (inputs.canClose) return keep("closing-instead", "closing in instead of reloading");
    if (!bestReaches) return keep("none-reaches", "no charge aboard reaches the target");
    reason = "loading the longer-range charge: the target is out of reach and the ship cannot close";
  } else {
    if (bestDamage === null || loadedDamage === null) {
      return keep("damage-unknown", "keeping the loaded charge: it still reaches and the damage of the other is unknown");
    }
    if (!(bestDamage > 0 && bestDamage >= loadedDamage * (1 + AMMO_SWAP_MIN_GAIN))) {
      return keep("gain-too-small", "keeping the loaded charge: it still reaches and the other is not enough better");
    }
    if (!bestReaches) return keep("better-out-of-reach", "keeping the loaded charge: the better one would not reach");
    if (
      !nextTargetMoment &&
      inputs.targetRemainingHp !== null &&
      inputs.damageLostToReload !== null &&
      !(inputs.targetRemainingHp > inputs.damageLostToReload)
    ) {
      return keep("target-dies-first", "keeping the loaded charge: the target will die before a reload pays off");
    }
    reason = nextTargetMoment
      ? "loading the better charge for the next target"
      : "loading the charge that does clearly more damage to this target";
  }

  // Timing: persistence, cooldown, one swap per target. The lock-ahead tick is
  // exempt from those, but not from a short minimum interval since the last swap.
  if (nextTargetMoment) {
    if (memory.lastSwapAtMs !== null && nowMs - memory.lastSwapAtMs < AMMO_NEXT_TARGET_MIN_INTERVAL_MS) {
      return keep("next-target-interval", "not swapping again so soon, even for the next target");
    }
  } else {
    if (ticks < AMMO_SWAP_PERSIST_TICKS) {
      return keep("persisting", "waiting to be sure the other charge stays the better one");
    }
    if (memory.lastSwapAtMs !== null && nowMs - memory.lastSwapAtMs < AMMO_SWAP_COOLDOWN_MS) {
      return keep("cooldown", "not swapping again so soon after the last swap");
    }
    if (inputs.targetID !== null && memory.swappedForTargetID === inputs.targetID) {
      return keep("swapped-this-target", "already swapped once for this target");
    }
  }

  return {
    kind: "swap",
    code: "swap",
    charge: best,
    memory: {
      wantedTypeID: null,
      wantedTicks: 0,
      lastSwapAtMs: nowMs,
      swappedForTargetID: inputs.targetID,
      pendingTypeID: best.typeID,
      pendingSinceMs: nowMs,
    },
    why: reason,
  };
}
