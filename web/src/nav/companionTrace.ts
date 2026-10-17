// The fleet companion's decision trace: what each rung decided, in codes, and the
// numbers it decided on. Written on the flight recorder's `decide` lines so a
// fight can be reconstructed after the fact.
//
// ⚠ THIS FILE IS THE CONTRACT, AND EVERY RUNG FILLS ITS OWN SLICE. The rungs
// return a fragment (`combat`, `guns`, `props`, `ammo`, `util`, `cleared`) beside
// their decision; the ladder gathers them into one `CompanionTrace` per tick;
// the recorder writes it; the log viewer reads it. Nothing here decides anything.
//
// ⚠ CODES, NOT SENTENCES. The readout's `why` is for a player and several causes
// share one sentence ("Not chasing the target" was three of them). Every code
// below names exactly one cause, so a log line answers "which branch".
//
// ⚠ THE NUMBERS ARE WHAT THE RUNG ACTUALLY USED, `null` WHEN IT HAD NONE. A
// trace that guessed a missing input would make the log lie about the very
// thing it exists to show: whether the input was there.
//
// ⚠ `coarseTraceKey` IS CODES ONLY. The recorder writes a `decide` line when the
// readout OR this key changes; distances move every tick, so they must not be in
// the key or the log becomes one line per tick per pilot.

import type { HoldReason } from "./combatPosition.ts";

/** Rung 8 (positioning): one code per return path of `decideCombatPosition`. */
export type CombatOutcome =
  | HoldReason // a hold was computed: kite, orbit-optimal, drone-band, empty-band, unreachable, closing-spent
  | "no-target" // nothing engaged
  | "mode-follow" // `flight follow`: rung 8 inert
  | "stopped" // a chat `stop` holds (followHeld)
  | "holds-navigation" // a fleet order owns navigation
  | "not-in-space" // docked, in warp, or no snapshot
  | "target-off-grid"
  | "leashed" // the target is further from the commander than the lock range
  | "no-reach" // a gun boat with no readable reach, or nothing to position with
  | "between-targets" // our hold stands, the target died, rats remain: hold here until the next call
  | "reform" // re-forming on the commander after our own order was dropped
  | "reform-stop"; // re-form wanted, no commander on grid: one stopShip

/** The latch state of rung 8's own order (orderLatch.ts), as it stood this tick. */
export interface LatchTrace {
  readonly status: string;
  readonly refusals: number;
  readonly deferrals: number;
  readonly cooldown: number | null;
  /** Why it is waiting, when it is: `LatchWaitReason` from orderLatch.ts. */
  readonly wait: string | null;
}

export interface CombatTrace {
  readonly mode: "follow" | "auto";
  readonly outcome: CombatOutcome;
  readonly targetID: number | null;
  /** Surface distance to the engaged target, metres. */
  readonly distanceM: number | null;
  /** The hold this tick wanted. */
  readonly holdOrder: "orbit" | "keepAtRange" | null;
  readonly holdRangeM: number | null;
  /** The range of the order actually standing on the server (may differ by < the re-issue margin). */
  readonly standingRangeM: number | null;
  readonly floorM: number | null;
  readonly ceilingM: number | null;
  /** true: more than the margin from the hold (closing). */
  readonly far: boolean;
  readonly farTicks: number;
  readonly spentAtM: number | null;
  readonly leashed: boolean;
  /** Commander ship to target, metres; null when no commander on grid. */
  readonly leashApartM: number | null;
  /**
   * The leash would have tripped, but a gun measured in reach of the target kept the
   * ship on it. Present (true) only then, so a record that never met this is unchanged.
   */
  readonly leashOverridden?: boolean;
  /** At least one hostile on grid whose type facts are unread (so it was never kited). */
  readonly ratFactsMissing: boolean;
  /** A re-issue was suppressed because the hold moved less than the margin. */
  readonly reissueSuppressed: boolean;
  readonly latch: LatchTrace | null;
}

/** The range gate: which guns may start on the engaged target, and on what basis. */
export interface GunsTrace {
  readonly targetID: number | null;
  readonly distanceM: number | null;
  /** Measured in reach (sticky margin). */
  readonly inReach: readonly number[];
  /** Let through because reach or distance was unknown (fail open). */
  readonly assumed: readonly number[];
  readonly outOfReach: readonly number[];
  /**
   * Guns still cycling on the ship the call moved off, which rung 7 has stopped
   * (once each) to turn onto this one. Absent when there are none. A gun that is
   * cycling is never re-activated: this server refuses it (`EffectAlreadyActive2`).
   */
  readonly switching?: readonly number[];
}

export type PropsBecause =
  | "held-on" // chat `props on`
  | "held-off" // chat `props off`
  | "closing" // rung 8 closing on its hold
  | "missile-orbit" // auto orbit with a known missile rat on grid
  | "travel" // isUnderWay: GOTO, own route, or FOLLOW that is not formation
  | "none"; // nothing wants a burn

export type PropsWithheld =
  | "cap-floor" // wanted, but the capacitor is below the floor
  | "mwd-banned" // hostiles on grid and only a microwarpdrive (or unread kind) is fitted
  | "unreadable-rack" // activeModuleIDs could not be read
  | "stop-latched" // a deactivate is already outstanding
  | "scrammed"; // a microwarpdrive under a scram

export interface PropsTrace {
  readonly want: boolean;
  readonly because: PropsBecause;
  readonly withheld: PropsWithheld | null;
  /** The two inputs the formation rule turns on, as the rung read them this tick. */
  readonly hostiles?: boolean | null;
  readonly formation?: boolean;
  /** The ship's movement mode this tick (GOTO, FOLLOW, ORBIT, ...), null when unread. */
  readonly mode?: string | null;
}

/** Why the ammo step looked at no gun at all this tick. */
export type AmmoSkip = "no-weapons" | "no-cargo" | "no-snapshot" | "no-target" | "not-engaged";

/** One code per return of `decideSwap` (ammoRanking.ts) plus the step's own. */
export type AmmoCode =
  | "swap"
  | "load"
  | "reload-pending"
  | "nothing-compatible"
  | "nothing-to-change-to"
  | "already-best"
  | "persisting" // waiting for the verdict to hold for AMMO_SWAP_PERSIST_TICKS
  | "cooldown"
  | "swapped-this-target"
  | "next-target-interval"
  | "closing-instead"
  | "none-reaches"
  | "better-out-of-reach"
  | "gain-too-small"
  | "damage-unknown"
  | "target-dies-first"
  | "gun-unread" // no reach facts for this gun
  | "gun-empty" // handled by the reload rung, not here
  | "other-stack-chosen"; // another unit already took this tick's one call

export interface AmmoUnitTrace {
  /** The bank master, or the gun. */
  readonly leadID: number;
  readonly code: AmmoCode;
  readonly loadedTypeID: number | null;
  readonly wantedTypeID: number | null;
  readonly wantedTicks: number;
  readonly pending: boolean;
}

export interface AmmoTrace {
  readonly skipped: AmmoSkip | null;
  readonly targetID: number | null;
  readonly distanceM: number | null;
  readonly nextTargetMoment: boolean;
  readonly canClose: boolean;
  readonly units: readonly AmmoUnitTrace[];
}

export type UtilitySkip =
  | "no-rack" // activeModuleIDs unreadable
  | "no-facts" // utility facts unread or for another ship
  | "cap-floor"
  | "cap-need" // below this module's own activation cost
  | "mode-unknown"
  | "not-locked"
  | "optimal-unknown"
  | "out-of-optimal"
  | "no-damage" // painter with no guns and no combat drones out
  | "no-turrets" // tracking computer without turrets
  | "attempts-spent"
  | "stop-retry-wait"
  | "grace-dropped"; // an activation that never showed as running

export interface UtilityTrace {
  readonly skipped: readonly { readonly moduleID: number; readonly family: string; readonly code: UtilitySkip }[];
  readonly gaveUp: readonly { readonly moduleID: number; readonly family: string; readonly what: "start" | "stop" }[];
}

/** Which movement latches an order dropped (`clearMovementLatches`). */
export interface ClearedTrace {
  readonly by: string; // the action kind that cleared them
  readonly follow: boolean;
  readonly hold: boolean;
}

/**
 * A hold that turns on this ship's health, or a move made under the return mark:
 * one code per branch of the rejoin's health gate and of the flee's safe-spot
 * hold (fleetCompanionLoop.ts).
 */
export type HealthCode =
  | "rejoin-unread" // rejoin held: no tank layer could be read
  | "rejoin-below-floor" // rejoin held: the tank is below the flee floor
  | "rejoin-under-mark" // rejoining while still under the return mark (an idle rejoin never waits for it)
  | "flee-unread" // flee's safe-spot hold: no tank layer could be read
  | "flee-recovering" // flee's safe-spot hold: under the mark, and the tank rose inside the stall window
  | "flee-stalled-floor" // stalled, and still below the floor: staying out
  | "flee-stalled-dock" // stalled: off to a station on grid to pay for repairs
  | "flee-stalled-return"; // stalled: the hold is given up and the pilot goes back as it is

/**
 * The numbers a health hold decided on. Seen live 2026-10-14: a pilot read "not
 * well enough yet" for 52 minutes and no log line said how well it was, or what
 * "well enough" meant.
 */
export interface HealthTrace {
  readonly code: HealthCode;
  /** The tank reading the rung used (worst counted layer), 0-1; null when unread. */
  readonly tank: number | null;
  /** The layer that reading came from, the one that gates; null when unread. */
  readonly layer: "shield" | "armor" | "hull" | null;
  readonly floor: number;
  /** The return mark (floor + margin, capped at 1). */
  readonly mark: number;
  /**
   * A self-repairer for `layer`: none fitted, fitted and idle, cycling, or fitted
   * with the active-module read missing.
   */
  readonly repairer: "none" | "fitted" | "running" | "unread";
  /** Flee hold only: how long since the tank last rose, ms. */
  readonly stalledMs?: number;
}

export interface CompanionTrace {
  readonly combat?: CombatTrace;
  readonly guns?: GunsTrace;
  readonly props?: PropsTrace;
  readonly ammo?: AmmoTrace;
  readonly util?: UtilityTrace;
  readonly cleared?: ClearedTrace;
  readonly health?: HealthTrace;
}

/**
 * The trace's identity for the recorder's "has anything changed" test: codes and
 * booleans only, never metres or counters, so a pilot holding one decision writes
 * one line, not one per tick. See the header.
 */
export function coarseTraceKey(trace: CompanionTrace | null | undefined): string {
  if (trace == null) {
    return "";
  }
  const parts: string[] = [];
  const c = trace.combat;
  if (c !== undefined) {
    parts.push(`c:${c.mode}/${c.outcome}/${c.targetID ?? "-"}/${c.holdOrder ?? "-"}/${c.far ? 1 : 0}/${c.leashed ? 1 : 0}${c.leashOverridden === true ? "o" : ""}/${c.latch?.status ?? "-"}`);
  }
  const g = trace.guns;
  if (g !== undefined) {
    // The switch count only when there is one, so a key without it is unchanged.
    const switching = g.switching === undefined || g.switching.length === 0 ? "" : `/s${g.switching.length}`;
    parts.push(`g:${g.targetID ?? "-"}/${g.inReach.length}/${g.assumed.length}/${g.outOfReach.length}${switching}`);
  }
  const p = trace.props;
  if (p !== undefined) {
    parts.push(`p:${p.want ? 1 : 0}/${p.because}/${p.withheld ?? "-"}`);
  }
  const a = trace.ammo;
  if (a !== undefined) {
    parts.push(`a:${a.skipped ?? "-"}/${a.nextTargetMoment ? 1 : 0}/` + a.units.map((u) => `${u.leadID}=${u.code}`).join(","));
  }
  const u = trace.util;
  if (u !== undefined) {
    parts.push(`u:` + u.skipped.map((s) => `${s.moduleID}=${s.code}`).join(",") + `|` + u.gaveUp.map((s) => `${s.moduleID}=${s.what}`).join(","));
  }
  if (trace.cleared !== undefined) {
    parts.push(`x:${trace.cleared.by}`);
  }
  // The code and the repairer's state only: the tank moves every tick.
  if (trace.health !== undefined) {
    parts.push(`h:${trace.health.code}/${trace.health.repairer}`);
  }
  return parts.join(";");
}
