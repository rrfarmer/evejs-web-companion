// The fleet companion in a fight: rung 8, `flight auto` combat positioning, and
// the range gate rung 7 puts on its guns (docs/fleet-companion-combat-plan.md
// §5.1, §5.3-§5.5).
//
// WHY A FILE OF ITS OWN. fleetCompanionLoop.ts is upstream's file, and every
// line this fork adds to it is a line every later upstream edit can conflict
// with. So the ladder keeps only what has to live there -- the call site, the
// memory fields, the `orbit` action and the wrapper that clears latches -- and
// everything the rung DECIDES lives here.
//
// ⚠ NO RUNTIME IMPORT FROM fleetCompanionLoop.ts, AND THAT IS DELIBERATE. That
// file imports this one, so a value import back would be a module cycle whose
// failure is an uninitialised binding at load time. Types cross freely; the
// helpers the ladder owns (`decideFollow`, the commander lookup, the drone bay,
// the order limits) arrive as a `CombatPositionLadder`, built once over there.
//
// WHERE TO BE is combatPosition.ts's arithmetic (`wantedHold`) and is not
// re-derived here; this file reads the grid into its inputs, decides whether the
// answer is worth a call, and keeps the order's record (orderLatch.ts).

import { measureSpace, type SpaceMeasurement } from "./autopilotLoop.ts";
import {
  holdNeedsReissue,
  inReach,
  MAX_CLOSE_TICKS,
  ratReachM,
  REACH_HYSTERESIS_M,
  wantedHold,
  type HeldOrder,
  type Hold,
  type HoldInputs,
  type HoldReason,
  type WeaponReach,
} from "./combatPosition.ts";
import type { CombatOutcome, CombatTrace, GunsTrace, LatchTrace } from "./companionTrace.ts";
import { RANGE_HYSTERESIS_M, type BandThreat } from "./kiteBand.ts";
import {
  isStanding,
  pendingLatch,
  settleLatch,
  stepLatch,
  type LatchWaitReason,
  type OrderLatch,
  type OrderLatchLimits,
  type OrderOutcome,
} from "./orderLatch.ts";
import { isHostile } from "../space/overview.ts";
import type { SpaceEntity, SpaceSnapshot } from "../store/types.ts";
import type {
  CompanionDecision,
  CompanionLadderMemory,
  FleetCompanionAction,
  FleetCompanionObservation,
  FleetCompanionRequest,
} from "./fleetCompanionLoop.ts";

/** How many refusals one positioning order may take before it backs off. As formation's. */
export const MAX_COMPANION_POSITION_REFUSALS = 3;

/** The positioning order rung 8 has sent (or is sending), with its outcome. */
export type CombatHoldRecord = HeldOrder & OrderLatch;

/**
 * What rung 8 remembers about the engaged target between ticks. Dropped when
 * the target changes and when the fight ends.
 */
export interface CombatTargetState {
  readonly targetID: number;
  /**
   * CONSECUTIVE ticks spent far from the hold. Reset to 0 the moment the ship is
   * in position, so the closing budget bounds one unbroken attempt, not the sum
   * of every drift across a long fight.
   */
  readonly farTicks: number;
  /**
   * The distance FROZEN when the closing budget ran out, handed to `wantedHold`
   * as `closingSpentAtM`; null while the budget is not spent.
   *
   * ⚠ FROZEN ONCE, NOT RE-READ. A hold that followed the live distance would
   * re-aim the ship every time the rat drifted past the hysteresis. Cleared on a
   * new target, at the end of the fight, and when the ship is back in position
   * for the hold it was originally after.
   */
  readonly spentAtM: number | null;
  /**
   * Last tick's answer: far from the hold, and still trying. Rung 3b reads it
   * (`closingOnTheHold`), a tick late because it runs first, to burn while
   * closing (plan §5.1).
   */
  readonly closing: boolean;
  /**
   * Past the leash: the target is further from the commander than this pilot can
   * lock. STICKY (see `pastTheLeash`), so a target wobbling across the edge does
   * not alternate an orbit with the formation order.
   */
  readonly leashed: boolean;
}

export interface CombatPositionMemory {
  /**
   * The positioning order on the engaged target, with its outcome.
   *
   * ⚠ IT IS A LATCH THAT SAYS "ALREADY IN POSITION", AND A STALE ONE IS THE BUG
   * IT HAS TO AVOID. The orbit is standing server-side, so the rung re-sends it
   * only when `holdNeedsReissue` says the hold moved. Any OTHER movement -- a
   * flee, an align, the formation order -- ends that orbit without telling this
   * record, so the ladder's wrapper drops it on every movement this rung did not
   * send, and on warp and dock (`withoutCombatHold`).
   */
  readonly hold: CombatHoldRecord | null;
  readonly target: CombatTargetState | null;
  /**
   * Our order was dropped and the pilot belongs back in formation, which is not
   * yet confirmed holding. While set, rung 9 is asked EVERY tick (its own
   * refusal, back-off and resend run), so one refused or unanswered formation
   * order cannot leave the pilot orbiting a rat for the rest of the fight.
   * Cleared when formation is confirmed (`formationHolding`), when positioning
   * resumes, by a `stop`, and when the fight ends.
   */
  readonly reform: boolean;
  /**
   * CONSECUTIVE ticks spent between targets: our hold stands, nothing is engaged,
   * and rats remain (`holdBetweenTargets`). Absent (not 0) when the pilot is not
   * between targets, so a fresh record stays `{ hold, target, reform }`. Cleared
   * by the next engagement and by every path that drops the hold.
   */
  readonly betweenTicks?: number;
}

/**
 * How many consecutive ticks rung 8 holds its place between targets before it
 * lets go and re-forms on the commander (about 60 s at the 2 s cadence). Bounds
 * the one wait that would otherwise last as long as nobody broadcasts a target.
 */
export const MAX_BETWEEN_TARGET_TICKS = 30;

export const FRESH_COMBAT_POSITION: CombatPositionMemory = Object.freeze({ hold: null, target: null, reform: false });

/** Which guns the range gate last judged in and out of reach of `targetID`. */
export interface WeaponReachState {
  readonly targetID: number;
  readonly inReach: readonly number[];
  readonly outOfReach: readonly number[];
}

/**
 * What rung 8 needs from the ladder that owns it. See the header for why these
 * arrive as values rather than imports.
 */
export interface CombatPositionLadder {
  /** Rung 9, `decideFollow`: hold station on the fleet commander. */
  readonly follow: (obs: FleetCompanionObservation, memory: CompanionLadderMemory) => CompanionDecision | null;
  /** The first commander the roster names whose ship is on this grid -- rung 9's anchor. */
  readonly commanderShip: (obs: FleetCompanionObservation) => SpaceEntity | null;
  readonly hasCombatDrones: (obs: FleetCompanionObservation) => boolean;
  readonly metresBetween: (a: SpaceEntity, b: SpaceEntity) => number;
  readonly limits: OrderLatchLimits;
}

/** What rung 8 decided. `decision` null is a fall-through; a standing one is a readout. */
export interface CombatPositionStep {
  readonly decision: CompanionDecision | null;
  readonly memory: CompanionLadderMemory;
  /** What this tick decided, in codes and numbers: one outcome per return path. See companionTrace.ts. */
  readonly trace: CombatTrace;
}

// ─── Memory helpers the ladder's wrapper uses ────────────────────────────────

function withPosition(memory: CompanionLadderMemory, patch: Partial<CombatPositionMemory>): CompanionLadderMemory {
  return { ...memory, combatPosition: { ...memory.combatPosition, ...patch } };
}

/** The memory without the between-targets count (the key is removed, not zeroed). */
function withoutBetween(memory: CompanionLadderMemory): CompanionLadderMemory {
  if (memory.combatPosition.betweenTicks === undefined) {
    return memory;
  }
  const { betweenTicks: _gone, ...rest } = memory.combatPosition;
  return { ...memory, combatPosition: rest };
}

/**
 * The memory without rung 8's standing order and its closing budget: what any
 * movement this rung did not send leaves behind. The leash flag survives,
 * because it is about where the target is and not about what the ship was doing
 * -- dropping it on the formation order would undo its hysteresis.
 */
export function withoutCombatHold(memory: CompanionLadderMemory): CompanionLadderMemory {
  if (memory.combatPosition.hold !== null) {
    memory = withoutBetween(memory);
  }
  const { hold, target } = memory.combatPosition;
  const reset = target === null || (target.farTicks === 0 && target.spentAtM === null && !target.closing)
    ? target
    : { ...target, farTicks: 0, spentAtM: null, closing: false };
  return hold === null && reset === target ? memory : withPosition(memory, { hold: null, target: reset });
}

/** Is this action the positioning order rung 8 has just stamped as pending? */
export function isCombatHoldOrder(action: FleetCompanionAction, memory: CompanionLadderMemory): boolean {
  const hold = memory.combatPosition.hold;
  return hold !== null && hold.status === "pending" &&
    (action.kind === "orbit" || action.kind === "keepAtRange") &&
    action.kind === hold.order && action.targetID === hold.targetID && action.range === hold.rangeM;
}

/**
 * Rung 3b's question, answered from rung 8's last tick: closing on the hold in
 * `flight auto`. `propsHeld` is asked first by the caller and still wins.
 */
export function closingOnTheHold(memory: CompanionLadderMemory): boolean {
  return memory.flightMode === "auto" && memory.combatPosition.target?.closing === true;
}

/**
 * Rung 8's order, settled with what the controller learned, on `settleFollow`'s
 * terms: only its own pending record, and only while that exact record is still
 * the ladder's.
 */
export function settleCombatHold(
  decision: CompanionDecision,
  current: CompanionLadderMemory,
  outcome: OrderOutcome,
): CompanionLadderMemory {
  const pending = decision.memory.combatPosition.hold;
  if ((decision.action.kind !== "orbit" && decision.action.kind !== "keepAtRange") ||
    pending === null || pending.status !== "pending" || current.combatPosition.hold !== pending) {
    return current;
  }
  return withPosition(current, { hold: settleLatch(pending, outcome) });
}

// ─── Rung 7's range gate ─────────────────────────────────────────────────────

/**
 * The range gate (plan §5.3): which of this pilot's guns can reach `targetID`
 * with the charge they have LOADED, judged sticky per gun.
 *
 * ⚠ SURFACE DISTANCE, FROM THE TICK'S `measureSpace`, BECAUSE THAT IS WHAT REACH
 * IS MEASURED AGAINST. A weapon's optimal and falloff are surface-to-surface on
 * the server, so a centre-to-centre measure would call a battleship's own hull a
 * kilometre of range it has not got. The caller hands the measurement in; this
 * never measures the snapshot again.
 *
 * ⚠ EVERY UNKNOWN FAILS OPEN, and the gun fires as it did before this gate
 * existed: a gun missing from `combatWeapons` (the facts are throttled and may
 * be unread or stale), a gun whose reach was unreadable, and a target whose
 * distance cannot be measured. A gun that might hit beats a gun that certainly
 * does not; the failure being guarded against is a pilot firing nothing because
 * a module row was incomplete.
 *
 * ⚠ STICKY, PER GUN, PER TARGET (`inReach`, `weaponReach`). A rat drifting
 * across the edge must not toggle a gun on and off: every flip is a call and a
 * module cycle. A gun's state is only RECORDED from a real measurement, so an
 * unknown tick keeps the last answer rather than inventing one.
 *
 * ⚠ THIS GATES STARTING A GUN AND NOTHING ELSE. A gun already cycling on a
 * target that drifted out of reach is left running: no rung in this codebase
 * stops a weapon for range (the drone-boat ladder gates its activation the same
 * way and never deactivates), and a wasted cycle is cheaper than a stop and a
 * restart when the rat drifts back.
 */
export function gunsInReach(
  targetID: number,
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  measurement: SpaceMeasurement | null,
): GunsGate {
  const weapons = request.weaponModuleIDs;
  const facts = obs.combatWeapons?.weapons ?? null;
  const distance = measurement?.distances.get(targetID) ?? null;
  if (weapons.length === 0) {
    return {
      inReach: [], assumed: [], memory,
      trace: { targetID, distanceM: distance, inReach: [], assumed: [], outOfReach: [] },
    };
  }
  const previous = memory.weaponReach?.targetID === targetID ? memory.weaponReach : null;
  const nowIn: number[] = [];
  const nowOut: number[] = [];
  const reaching: number[] = [];
  // The trace's three disjoint lists: judged in reach by a measurement, let through
  // WITHOUT one (reach or distance unknown), and held back.
  const measuredIn: number[] = [];
  const assumed: number[] = [];
  const held: number[] = [];
  for (const moduleID of weapons) {
    const fact = facts?.find((weapon) => weapon.itemID === moduleID) ?? null;
    const was = previous === null ? null
      : previous.inReach.includes(moduleID) ? true
        : previous.outOfReach.includes(moduleID) ? false : null;
    const reachM = fact?.reachM ?? null;
    const ok = fact === null ? true : inReach(distance, reachM, was);
    if (ok) {
      reaching.push(moduleID);
    }
    // Recorded only from a measurement; otherwise the previous state stands.
    const measured = fact !== null && reachM !== null && distance !== null;
    const state = measured ? ok : was;
    if (state === true) nowIn.push(moduleID);
    if (state === false) nowOut.push(moduleID);
    if (!ok) held.push(moduleID);
    else if (measured) measuredIn.push(moduleID);
    else assumed.push(moduleID);
  }
  const trace: GunsTrace = { targetID, distanceM: distance, inReach: measuredIn, assumed, outOfReach: held };
  const same = (a: readonly number[], b: readonly number[]): boolean =>
    a.length === b.length && a.every((id, index) => b[index] === id);
  if (previous === null ? nowIn.length === 0 && nowOut.length === 0
    : same(previous.inReach, nowIn) && same(previous.outOfReach, nowOut)) {
    return { inReach: reaching, assumed, memory, trace };
  }
  return {
    inReach: reaching,
    assumed,
    memory: { ...memory, weaponReach: { targetID, inReach: nowIn, outOfReach: nowOut } },
    trace,
  };
}

/**
 * What the range gate hands back. `inReach` is every gun that MAY START (the
 * measured ones and the assumed ones); `assumed` is the subset let through on an
 * unknown reach or distance; `trace` separates the three groups for the recorder.
 */
export interface GunsGate {
  readonly inReach: readonly number[];
  readonly assumed: readonly number[];
  readonly memory: CompanionLadderMemory;
  readonly trace: GunsTrace;
}

/**
 * The end of rung 7's "locked" sentence for a pilot with guns picked.
 *
 * ⚠ A RACK PARTLY OUT OF REACH SAYS SO. A pilot whose guns cannot reach the
 * called target is still engaged -- rung 8 is what fixes that, and the drones
 * fight meanwhile -- but "firing on it" would be false for the guns that are
 * holding. Plain ASCII: player-facing.
 *
 * ⚠ `inReach` COUNTS MEASURED GUNS. `assumed` is how many more were let through on
 * an unknown reach or distance, said aloud so "2 of 2 in reach" is never read as a
 * measurement that was not made.
 */
export function gunsInReachWords(inReach: number, picked: number, assumed: number = 0): string {
  const note = assumed > 0 ? ` (${assumed} assumed)` : "";
  return inReach + assumed === 0
    ? " Locked, but none of my guns reach it from here."
    : inReach + assumed < picked || assumed > 0
      ? ` Locked, and firing on it: ${inReach} of ${picked} guns in reach${note}.`
      : " Locked, and firing on it.";
}

// ─── Rung 8 ──────────────────────────────────────────────────────────────────

/** A distance for a player: "12 km", "2.5 km". */
function kmWords(metres: number): string {
  return `${Math.round(metres / 100) / 10} km`;
}

/** What a hold sentence needs beside the hold itself. */
interface HoldWords {
  /** The range to SAY: the standing order's when a re-issue was suppressed, else the hold's. */
  readonly rangeM: number;
  /** An orbit that wanted the guns' optimal but was held to the floor or the ceiling. */
  readonly clamp: "floor" | "ceiling" | null;
  /** The grid had a hostile whose type facts are unread, so nothing was kited. */
  readonly ratFactsMissing: boolean;
}

function knownMetres(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Why an orbit-optimal hold is NOT at the guns' optimal: it was held to the floor
 * (the rats' tackle) or the ceiling (lock range and gun reach). Mirrors
 * `wantedHold`'s pick of the shortest gun -- it is a clamp test, not a re-derivation
 * of where to be -- and is null for every other reason.
 */
function clampedBy(hold: Hold, weapons: readonly WeaponReach[]): "floor" | "ceiling" | null {
  if (hold.reason !== "orbit-optimal") {
    return null;
  }
  const reachable = weapons.filter((weapon) => knownMetres(weapon.reachM) !== null);
  const shortest = [...reachable].sort(
    (a, b) => (a.reachM as number) - (b.reachM as number) || a.moduleID - b.moduleID,
  )[0];
  if (shortest === undefined) {
    return null;
  }
  const wantM = knownMetres(shortest.optimalM) ?? (shortest.reachM as number);
  if (wantM < hold.floorM) return "floor";
  if (hold.ceilingM !== null && wantM > hold.ceilingM) return "ceiling";
  return null;
}

/** The sentence that says why the pilot holds where it holds. Plain ASCII. */
function holdSentence(hold: Hold, words: HoldWords): string {
  const at = kmWords(words.rangeM);
  const reason: HoldReason = hold.reason;
  switch (reason) {
    case "kite":
      return `Holding ${at} off the target: my guns out-range everything here.`;
    case "orbit-optimal": {
      // ⚠ "MY SHORTEST GUNS REACH THERE" IS ONLY TRUE UNCLAMPED, and an unread rat
      // is a different story from a read one: both are said, not implied.
      const clamp = words.clamp === "floor" ? "Held off the rats' tackle."
        : words.clamp === "ceiling" ? "Held at my lock range and gun reach." : null;
      if (words.ratFactsMissing) {
        const lead = `Some rats here are not identified yet: orbiting at ${at} rather than kiting.`;
        return clamp === null ? lead : `${lead} ${clamp}`;
      }
      return words.clamp === "floor"
        ? `Orbiting the target at ${at}: as close as I dare with the rats' tackle here.`
        : words.clamp === "ceiling"
          ? `Orbiting the target at ${at}: as far out as my lock range and gun reach allow.`
          : `Orbiting the target at ${at}: my shortest guns reach there.`;
    }
    case "drone-band":
      return `Keeping ${at} off the target while my drones fight it.`;
    case "empty-band":
      return `No room to kite here, fighting at ${at}.`;
    case "unreachable":
      return "The target is faster than me; fighting from where it is.";
    case "closing-spent":
      return `Could not close in, so fighting from ${at}.`;
  }
  // A new reason added to `HoldReason` fails to compile here until it has words.
  const unhandled: never = reason;
  return unhandled;
}

/** The order record's waits, as the readout says them. Exhaustive by type. */
const LATCH_WORDS: Readonly<Record<LatchWaitReason, string>> = Object.freeze({
  cooldown: "Waiting a moment before sending the positioning order again.",
  "session-change-cap": "A session change kept blocking the positioning order. Trying again shortly.",
  "session-change": "Waiting for the session change to clear before positioning.",
  unanswered: "The positioning order got no answer. Sending it again in a moment.",
  refused: "The positioning order was refused repeatedly. Trying again shortly.",
});

/** The engaged decision's authority, carried onto whatever this rung returns. */
function authorityOf(engaged: CompanionDecision): Pick<CompanionDecision, "followingOrderFrom" | "lastOrderHeard"> {
  return {
    ...(engaged.followingOrderFrom === undefined ? {} : { followingOrderFrom: engaged.followingOrderFrom }),
    ...(engaged.lastOrderHeard === undefined ? {} : { lastOrderHeard: engaged.lastOrderHeard }),
  };
}

/** Formation confirmed holding: rung 9's anchor set, and its order taken by the server. */
function formationHolding(memory: CompanionLadderMemory): boolean {
  const order = memory.followOrder;
  return memory.followAnchorID !== null && order !== null && order.status === "issued" &&
    order.targetID === memory.followAnchorID;
}

/**
 * Past the leash, stickily: leave when the commander-to-target distance passes
 * the lock range, come back only once it is inside the lock range by
 * `RANGE_HYSTERESIS_M`. No commander on grid, or an unknown lock range, is no
 * leash -- the same fail-open the free-fire pick makes with it.
 */
function pastTheLeash(
  commander: SpaceEntity | null,
  target: SpaceEntity,
  lockRangeM: number | null,
  wasLeashed: boolean,
  ladder: CombatPositionLadder,
): boolean {
  if (commander === null || lockRangeM === null) {
    return false;
  }
  const apart = ladder.metresBetween(commander, target);
  return wasLeashed ? apart >= lockRangeM - RANGE_HYSTERESIS_M : apart > lockRangeM;
}

/** The readout when guns on the target override the leash. Plain ASCII: player-facing. */
const LEASH_OVERRIDDEN_WORDS = "Guns on the target: staying on it although it is past my leash.";

/**
 * Is at least one of this pilot's guns MEASURED in reach of the engaged target
 * right now? The range gate's own test (`gunsInReach`: the loaded charge's reach,
 * the sticky per-gun margin), read and not stored.
 *
 * ⚠ ONLY A MEASUREMENT COUNTS. `gunsInReach` lets a gun with an unknown reach (or
 * an unmeasurable distance) through so it may start; that is the gate failing
 * open, and it is not "hitting". Those are `assumed`, and are left out here, so
 * the leash is only overridden by a gun known to reach. A drone boat has no guns
 * and so never overrides: its drones have their own leash.
 */
function gunsHitting(
  targetID: number,
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  measurement: SpaceMeasurement | null,
): boolean {
  return gunsInReach(targetID, request, obs, memory, measurement).trace.inReach.length > 0;
}

/**
 * The grid, read into `wantedHold`'s inputs (less the closing budget, which the
 * caller adds).
 *
 * ⚠ `gridRatReachM` IS NULL WHEN ANY HOSTILE ON GRID IS UNREAD, and `threats` is
 * built as the drone-boat ladder's `bandThreats` builds it -- one row per hostile
 * ON GRID, a scram reach only for a type that actually scrams -- so kiteBand
 * derives the floor for both hull types from one rule. See combatPosition.ts.
 */
function holdInputs(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  snapshot: SpaceSnapshot,
  target: SpaceEntity,
  measurement: SpaceMeasurement | null,
  lockRangeM: number | null,
  ladder: CombatPositionLadder,
): Omit<HoldInputs, "closingSpentAtM"> {
  const facts = obs.combatWeapons?.weapons ?? null;
  const weapons: WeaponReach[] = request.weaponModuleIDs.map((moduleID) => {
    const fact = facts?.find((weapon) => weapon.itemID === moduleID) ?? null;
    return { moduleID, reachM: fact?.reachM ?? null, optimalM: fact?.optimalM ?? null };
  });
  const ratFacts = obs.ratCombatByTypeID ?? null;
  const threatByType = obs.threatByTypeID ?? null;
  let gridRatReachM: number | null = 0;
  const threats: BandThreat[] = [];
  for (const rat of snapshot.entities.filter(isHostile)) {
    const typeID = rat.typeID ?? null;
    const known = typeID === null ? null : (ratFacts?.[typeID] ?? null);
    gridRatReachM = known === null || gridRatReachM === null ? null : Math.max(gridRatReachM, ratReachM(known));
    const threat = typeID === null ? null : (threatByType?.[typeID] ?? null);
    threats.push({
      itemID: rat.itemID,
      // Only the floor is read from these, and it does not depend on distance.
      distanceM: measurement?.distances.get(rat.itemID) ?? Number.POSITIVE_INFINITY,
      scramRangeM: threat !== null && threat.scram ? threat.scramRangeM : null,
      webs: threat?.web === true,
    });
  }
  const targetType = target.typeID ?? null;
  return {
    weapons,
    hasCombatDrones: ladder.hasCombatDrones(obs),
    droneControlRangeM: obs.droneControlRangeM ?? null,
    lockRangeM,
    gridRatReachM,
    threats,
    targetDistanceM: measurement?.distances.get(target.itemID) ?? null,
    target: targetType === null ? null : (ratFacts?.[targetType] ?? null),
    ownMaxVelocity: snapshot.ship?.maxVelocity ?? null,
  };
}

/** Far from a hold: further from its range than the reach hysteresis. Unknown is not far. */
function farFrom(distanceM: number | null, hold: Hold): boolean {
  return distanceM !== null && Math.abs(distanceM - Math.round(hold.rangeM)) > REACH_HYSTERESIS_M;
}

/** Why rung 8 is handing the pilot back to formation. One readout sentence each. */
type FormationCause = "follow" | "leash" | "no-reach";

const FORMATION_WORDS: Readonly<Record<FormationCause, string>> = Object.freeze({
  leash: "Target is past my leash from the commander: holding station.",
  follow: "Flight follow: holding station on the commander.",
  "no-reach": "Cannot read my guns' reach: holding station on the commander.",
});

/** `backToFormation`'s answer: a step without a trace, and whether it acted. */
interface FormationStep {
  readonly decision: CompanionDecision | null;
  readonly memory: CompanionLadderMemory;
  readonly outcome: "reform" | "reform-stop" | null;
}

/**
 * Back to formation: rung 9, asked from here because the fight stands, so the
 * standing readout would end the ladder before rung 9 ran.
 *
 * ⚠ ASKED EVERY TICK WHILE `reform` IS PENDING, not once. A refused or
 * unanswered formation order, or a tick on which rung 9 had nothing to say,
 * would otherwise leave the pilot on our orbit until the fight ended. Rung 9's
 * own refusal, back-off and resend run each time; its waits are not returned
 * (the fight's readout stands) but its memory is kept, so they count down.
 *
 * ⚠ NO COMMANDER ON GRID: ONE `stopShip`. A pilot told to follow with nobody to
 * follow must at least stop orbiting the rat; then the flag clears, because
 * there is no formation to confirm.
 *
 * `askAnyway` is the leash: a target past it is never chased, so rung 9 is asked
 * whether or not an order of ours was standing -- a pilot already in formation
 * gets rung 9's "already holding" wait, which is ignored.
 *
 * `because` picks the sentence: three causes used to share one, and a log line
 * could not say which. `outcome` is the trace's code when this rung ACTED
 * (`reform`, or `reform-stop` for the lone stopShip) and null when it did not --
 * the caller then keeps its own cause as the code.
 */
function backToFormation(
  engaged: CompanionDecision,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  askAnyway: boolean,
  because: FormationCause,
  ladder: CombatPositionLadder,
): FormationStep {
  const pending = memory.combatPosition.reform;
  if (!pending && !askAnyway) {
    return { decision: null, memory, outcome: null };
  }
  if (ladder.commanderShip(obs) === null) {
    if (!pending) {
      return { decision: null, memory, outcome: null };
    }
    const next = withPosition(memory, { reform: false });
    return {
      decision: {
        action: { kind: "stopShip" },
        phase: engaged.phase,
        why: "Not chasing the target, and no fleet commander here to hold station on. Stopping the ship.",
        memory: next,
        ...authorityOf(engaged),
      },
      memory: next,
      outcome: "reform-stop",
    };
  }
  const reforming = ladder.follow(obs, memory);
  if (reforming === null) {
    return { decision: null, memory, outcome: null };
  }
  if (reforming.action.kind !== "wait") {
    return {
      decision: {
        ...reforming,
        why: FORMATION_WORDS[because],
        ...authorityOf(engaged),
      },
      memory: reforming.memory,
      outcome: "reform",
    };
  }
  const after = reforming.memory;
  return { decision: null, memory: withPosition(after, { reform: pending && !formationHolding(after) }), outcome: null };
}

/**
 * The snapshot itself shows no hostile on grid. `hostileOnGrid` may be null (or
 * absent) when the overview could not say, but a readable snapshot with no
 * hostile in it is a clear grid: re-form rather than wait for a call that has
 * nothing to be aimed at. No snapshot is "cannot say", which holds.
 */
function gridShowsNoHostile(obs: FleetCompanionObservation): boolean {
  const snapshot = obs.snapshot ?? null;
  return snapshot !== null && !snapshot.entities.some(isHostile);
}

/** The readout while holding between targets. Plain ASCII: player-facing. */
const BETWEEN_TARGETS_WORDS = "Between targets: holding here until the next call.";

/**
 * Between targets: the engaged target is gone (it died, or left the grid), our
 * own hold still stands, and rats remain. Hold here instead of re-forming, so
 * the next call starts from the fight and not from the commander's side.
 *
 * ⚠ IT SENDS NOTHING. The dead rat's orbit has ended server-side and the ship
 * coasts where it is, which is near the fight; a new order would be a trip for
 * nothing. The decision is a STANDING readout that HOLDS NAVIGATION: rung 9 does
 * not run (the ladder returns the readout before it), and loot and salvage do
 * not move the ship.
 *
 * ⚠ BOUNDED, so it can never become a stuck path. It applies only in
 * `flight auto`, in space, not in warp, with no `stop` and no fleet order that
 * holds navigation, and only while `hostileOnGrid` is not `false` (grid
 * confirmed clear re-forms at once, whether `hostileOnGrid` says so or the
 * snapshot shows no hostile; `null`, cannot say, holds). After
 * `MAX_BETWEEN_TARGET_TICKS` consecutive ticks it returns null and the caller
 * drops the hold exactly as before. A new engagement resets the count.
 */
function holdBetweenTargets(
  obs: FleetCompanionObservation,
  engaged: CompanionDecision | null,
  memory: CompanionLadderMemory,
): CombatPositionStep | null {
  const hold = memory.combatPosition.hold;
  if (hold === null || memory.flightMode !== "auto" || memory.followHeld ||
    engaged?.holdsNavigation === true || obs.inSpace !== true || obs.inWarp === true ||
    obs.hostileOnGrid === false || gridShowsNoHostile(obs)) {
    return null;
  }
  const ticks = (memory.combatPosition.betweenTicks ?? 0) + 1;
  if (ticks > MAX_BETWEEN_TARGET_TICKS) {
    return null;
  }
  const next = withPosition(memory, { target: null, betweenTicks: ticks });
  return {
    decision: {
      action: { kind: "wait" },
      phase: engaged?.phase ?? "Obeying fleet",
      why: BETWEEN_TARGETS_WORDS,
      memory: next,
      standing: true,
      holdsNavigation: true,
      ...(engaged === null ? {} : authorityOf(engaged)),
    },
    memory: next,
    trace: combatTrace(memory.flightMode, "between-targets", null, {
      standingRangeM: standingRangeM(hold),
      latch: latchTrace(hold, null),
    }),
  };
}

/**
 * Rung 8, `flight auto`: be where the engaged target can be shot (plan §5.4).
 * `engaged` is rung 7's decision (null when it had none); the step's `memory`
 * is what the rungs beneath carry, whatever it decides.
 *
 * ⚠ IT ACTS ONLY IN `flight auto`. In "follow", the default, the fleet
 * commander leads and this rung never positions anything: today's behaviour is
 * the default and positioning is a mode the commander switches on (operator,
 * 2026-10-13). It only undoes an order of its own making (`backToFormation`).
 * The range gate on the guns is rung 7's and applies either way.
 *
 * ⚠ NOT WHILE `stop` HOLDS. `stop` suspends the standing follow
 * (`followHeld`), and a rung that re-orbited the rat on the next tick would undo
 * it. `follow N km` or `flight auto` lifts it.
 *
 * ⚠ IT SITS BELOW THE FLEET ORDERS AND THE LOCK-AHEAD AND ABOVE SALVAGE AND
 * LOOT. Everything a human ordered (align, travel, warp) is above it, so an
 * order is never fought by the autopilot; a fleet-order decision that holds
 * navigation is a fall-through here for the same reason. And it is the one
 * self-move that may act while a target call stands, which is why its every
 * decision HOLDS NAVIGATION: salvage and loot must not drag the ship off its
 * hold mid-fight.
 *
 * ⚠ THE LEASH IS THE LOCK RANGE, AND PAST IT THIS RUNG DOES NOT CHASE. When a
 * commander is on grid and the target is further from the commander's ship than
 * this pilot can lock, the pilot stays in formation (rung 9) and fights with
 * whatever reaches from there. Sticky: see `pastTheLeash`.
 *
 * ⚠ THE LEASH ONLY STOPS A CHASE; IT NEVER PULLS A SHIP OFF A TARGET IT IS HITTING.
 * Seen live: a pilot orbiting a rat with all four guns in reach (`guns 4/0a/0o`)
 * tripped the leash because the commander had moved away, and turned from a
 * target it was hitting to fly back to the commander. Operator decision: a
 * companion whose guns already reach its engaged target keeps it until the target
 * dies or leaves gun reach. So when the leash would trip but at least one gun is
 * MEASURED in reach (`gunsHitting`: the range gate's sticky test; an unknown
 * reach does not count), the leash is not applied and not recorded as tripped,
 * the rung holds as normal, and the trace says so (`leashOverridden`). Once no
 * gun reaches any more the leash applies again, fresh. A drone boat has no guns,
 * so for it nothing changes.
 *
 * ⚠ A GUN BOAT WITH NO KNOWN REACH IS NOT POSITIONED (`wantedHold` null): it
 * stays in formation until a reach is readable.
 *
 * ⚠ THE ORDER IS RE-SENT ONLY WHEN `holdNeedsReissue` SAYS THE HOLD MOVED, and
 * its outcomes are tracked as the formation order's are (orderLatch.ts): every
 * wait is bounded and standing, so a positioning back-off never starves the
 * rungs beneath of a non-moving job.
 *
 * ⚠ THE CLOSING BUDGET BOUNDS THE ONE WAIT THAT COULD OTHERWISE BE ENDLESS. A
 * hold the ship cannot reach (a rat that keeps its own orbit) would read
 * "Closing" for ever; after `MAX_CLOSE_TICKS` CONSECUTIVE far ticks the current
 * distance is frozen as the hold, and the readout says so. See
 * `CombatTargetState`.
 */
export function decideCombatPosition(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  engaged: CompanionDecision | null,
  memory: CompanionLadderMemory,
  ladder: CombatPositionLadder,
): CombatPositionStep {
  const mode = memory.flightMode;
  const targetID = engaged?.engagedTargetID;
  if (engaged === null || targetID === undefined) {
    const between = holdBetweenTargets(obs, engaged, memory);
    if (between !== null) {
      return between;
    }
    // ⚠ THE FIGHT HAS ENDED (or never began): nothing of it is kept, so nothing
    // believes the ship is still "in position", still closing (the burner), or
    // still owed a formation order on a later fight. Rung 9 brings it home.
    return {
      decision: null,
      memory: { ...memory, combatPosition: FRESH_COMBAT_POSITION },
      trace: combatTrace(mode, "no-target", null, {}),
    };
  }
  // A new engagement ends any between-targets wait, so its count starts again.
  memory = withoutBetween(memory);
  const position = memory.combatPosition;
  const ours = position.hold !== null;
  const state = position.target?.targetID === targetID ? position.target : null;
  // The order on this target as the tick began, for every trace that stops early.
  const standing = position.hold !== null && position.hold.targetID === targetID ? position.hold : null;
  // The trace of a path that returns before a hold is computed. What is remembered
  // of the closing budget is reported as it stands; a path that drops it says so.
  const early = (outcome: CombatOutcome, fields: Partial<CombatTrace> = {}): CombatTrace =>
    combatTrace(mode, outcome, targetID, {
      standingRangeM: standingRangeM(standing),
      latch: latchTrace(standing, null),
      farTicks: state?.farTicks ?? 0,
      spentAtM: state?.spentAtM ?? null,
      leashed: state?.leashed === true,
      ...fields,
    });
  const dropped: Partial<CombatTrace> = { farTicks: 0, spentAtM: null, leashed: false };
  // Not positioning this tick: whatever is remembered of the target stays, but
  // the burner's question is answered "not closing".
  const idle = (next: CombatTargetState | null): CompanionLadderMemory =>
    withPosition(memory, { target: next === null || !next.closing ? next : { ...next, closing: false } });
  // Our order goes, and formation is owed if it was ours.
  const standDown = (next: CombatTargetState | null): CompanionLadderMemory =>
    withPosition(memory, { hold: null, target: next, reform: position.reform || ours });
  // The way back to formation, with the code of whatever sent it there unless it acted.
  const toFormation = (
    next: CompanionLadderMemory,
    askAnyway: boolean,
    cause: CombatOutcome,
    because: FormationCause,
    fields: Partial<CombatTrace>,
  ): CombatPositionStep => {
    const back = backToFormation(engaged, obs, next, askAnyway, because, ladder);
    return { decision: back.decision, memory: back.memory, trace: early(back.outcome ?? cause, fields) };
  };

  if (memory.followHeld) {
    return { decision: null, memory: withPosition(idle(state), { reform: false }), trace: early("stopped") };
  }
  if (memory.flightMode !== "auto") {
    // The FC leads. Only an order of OUR making needs undoing.
    return toFormation(standDown(null), false, "mode-follow", "follow", dropped);
  }
  const snapshot = obs.snapshot ?? null;
  if (engaged.holdsNavigation === true) {
    return { decision: null, memory: idle(state), trace: early("holds-navigation") };
  }
  if (obs.inSpace !== true || obs.inWarp === true || snapshot === null) {
    return { decision: null, memory: idle(state), trace: early("not-in-space") };
  }
  const target = snapshot.entities.find((entity) => entity.itemID === targetID) ?? null;
  if (target === null) {
    return { decision: null, memory: idle(state), trace: early("target-off-grid") };
  }
  const lockRangeM = obs.maxTargetRangeM ?? null;
  const commander = ladder.commanderShip(obs);
  const leashApartM = commander === null ? null : ladder.metresBetween(commander, target);
  // ⚠ THE ONE MEASUREMENT THIS RUNG MAKES. The leash's override and everything
  // below read it.
  const measurement = measureSpace(snapshot);
  let leashOverridden = false;
  if (pastTheLeash(commander, target, lockRangeM, state?.leashed === true, ladder)) {
    if (!gunsHitting(targetID, request, obs, memory, measurement)) {
      const leashed: CombatTargetState = { targetID, farTicks: 0, spentAtM: null, closing: false, leashed: true };
      return toFormation(standDown(leashed), true, "leashed", "leash", { ...dropped, leashed: true, leashApartM });
    }
    leashOverridden = true;
  }
  // The readout sentence in front of whatever this tick says, when the leash was overridden.
  const withLeashWords = (why: string): string => leashOverridden ? `${LEASH_OVERRIDDEN_WORDS} ${why}` : why;

  // ─── Where to be ──────────────────────────────────────────────────────────
  const inputs = holdInputs(request, obs, snapshot, target, measurement, lockRangeM, ladder);
  const distanceM = inputs.targetDistanceM;
  // ⚠ NULL ONLY FOR AN UNREAD HOSTILE: an empty grid reads 0. See `holdInputs`.
  const ratFactsMissing = inputs.gridRatReachM === null;
  const natural = wantedHold({ ...inputs, closingSpentAtM: null });
  if (natural === null) {
    // Nothing this fit can position for: formation, if we had broken it.
    return toFormation(standDown(null), false, "no-reach", "no-reach", {
      ...dropped, distanceM, leashApartM, ratFactsMissing,
    });
  }
  const holdAt = (spentAtM: number | null): Hold =>
    spentAtM === null ? natural : (wantedHold({ ...inputs, closingSpentAtM: spentAtM }) ?? natural);
  // Back in position for the hold it was originally after: the frozen one goes.
  let spentAtM = state?.spentAtM ?? null;
  if (spentAtM !== null && !farFrom(distanceM, natural)) {
    spentAtM = null;
  }
  let hold = holdAt(spentAtM);
  let far = farFrom(distanceM, hold);
  const farBefore = state?.farTicks ?? 0;
  let farTicks = far ? farBefore + 1 : 0;
  if (far && farBefore >= MAX_CLOSE_TICKS && distanceM !== null) {
    // The budget is spent: freeze where the ship is, once.
    spentAtM = distanceM;
    hold = holdAt(spentAtM);
    far = farFrom(distanceM, hold);
    farTicks = 0;
  }
  memory = withPosition(memory, {
    target: { targetID, farTicks, spentAtM, closing: far, leashed: false },
    reform: false,
  });

  const rangeM = Math.round(hold.rangeM);
  const wanted: HeldOrder = { order: hold.order, targetID, rangeM };
  const clamp = clampedBy(hold, inputs.weapons);
  // The numbers this tick's hold was decided on; each return adds its latch's.
  const decided = (fields: Partial<CombatTrace>): CombatTrace =>
    combatTrace(mode, hold.reason, targetID, {
      distanceM,
      holdOrder: hold.order,
      holdRangeM: rangeM,
      floorM: hold.floorM,
      ceilingM: hold.ceilingM,
      far,
      farTicks,
      spentAtM,
      leashed: false,
      leashApartM,
      ratFactsMissing,
      ...(leashOverridden ? { leashOverridden: true } : {}),
      ...fields,
    });
  const readout = (why: string, next: CompanionLadderMemory, trace: CombatTrace): CombatPositionStep => ({
    decision: { ...engaged, action: { kind: "wait" }, standing: true, holdsNavigation: true, why, memory: next },
    memory: next,
    trace,
  });

  // ─── Whether it is worth a call ───────────────────────────────────────────
  const current = memory.combatPosition.hold;
  const step = stepLatch(current?.targetID === targetID ? current : null, ladder.limits);
  if (step.kind === "wait") {
    return readout(
      withLeashWords(`${engaged.why} ${LATCH_WORDS[step.reason]}`),
      withPosition(memory, { hold: step.latch }),
      decided({ standingRangeM: standingRangeM(step.latch), latch: latchTrace(step.latch, step.reason) }),
    );
  }
  const previous = step.latch;
  if (previous !== null && isStanding(previous) && !holdNeedsReissue(previous, wanted)) {
    // ⚠ THE ORDER ON THE SERVER IS THE STANDING ONE, so its range is the one said:
    // the hold may have moved by less than the re-issue margin, and "in position at
    // 8 km" must not name a range nobody ordered.
    const sentence = holdSentence(hold, { rangeM: previous.rangeM, clamp, ratFactsMissing });
    return readout(
      withLeashWords(`${engaged.why} ${far ? "Closing in." : "In position."} ${sentence}`),
      memory,
      decided({ standingRangeM: previous.rangeM, reissueSuppressed: true, latch: latchTrace(previous, null) }),
    );
  }
  const next = withPosition(memory, { hold: { ...wanted, ...pendingLatch(previous) } });
  return {
    decision: {
      action: { kind: hold.order, targetID, range: rangeM },
      phase: engaged.phase,
      why: withLeashWords(holdSentence(hold, { rangeM: hold.rangeM, clamp, ratFactsMissing })),
      memory: next,
      holdsNavigation: true,
      ...authorityOf(engaged),
    },
    memory: next,
    trace: decided({ standingRangeM: standingRangeM(previous), latch: latchTrace(next.combatPosition.hold, null) }),
  };
}

/** A trace with nothing read: the base every path fills what it actually used into. */
function combatTrace(
  mode: "follow" | "auto",
  outcome: CombatOutcome,
  targetID: number | null,
  fields: Partial<CombatTrace>,
): CombatTrace {
  return {
    mode,
    outcome,
    targetID,
    distanceM: null,
    holdOrder: null,
    holdRangeM: null,
    standingRangeM: null,
    floorM: null,
    ceilingM: null,
    far: false,
    farTicks: 0,
    spentAtM: null,
    leashed: false,
    leashApartM: null,
    ratFactsMissing: false,
    reissueSuppressed: false,
    latch: null,
    ...fields,
  };
}

/** The latch record as the trace carries it; null when there is none. */
function latchTrace(record: OrderLatch | null, wait: LatchWaitReason | null): LatchTrace | null {
  return record === null ? null : {
    status: record.status,
    refusals: record.refusals,
    deferrals: record.deferrals,
    cooldown: record.cooldown ?? null,
    wait,
  };
}

/** The range of the order actually standing on the server; null unless the record says one is. */
function standingRangeM(record: CombatHoldRecord | null): number | null {
  return record !== null && isStanding(record) ? record.rangeM : null;
}
