// The CLOSE-IN STALL rung — shared by every ladder that orders the hull to
// close on something and then waits for it to get there.
//
// ⚠ A CLOSE-IN ORDER THE SERVER ACCEPTS AND IGNORES LOOKS EXACTLY LIKE ONE IT
// IS FLYING. `Handle_CmdFollowBall` and `Handle_CmdOrbit` both throw away what
// `spaceRuntime.followBall` / `orbitShipEntity` returned and answer 200/null
// either way, so the bridge reports `ok` for an order that moved nothing — and
// `keepAtRange` is the same server method as approach, so it is the same story
// again. The ONLY honest evidence this client has is the hull's own movement
// mode, the same reading the autopilot's close-in ladder already decides on
// (autopilotLoop.ts `decideCloseIn`). A block that says "flying to the wreck"
// or "closing on the wave" for the rest of the night while the mode says
// otherwise is telling the operator something it has not checked.
//
// ⚠ THE STALL THIS EXISTS FOR, because a re-issued order alone does not always
// break it. An order the server accepted and dropped leaves the hull in STOP or
// GOTO with the block still believing it is closing; sending the order again is
// the cheap and usually sufficient answer, and cutting the engines first is the
// answer when it is not. That much the ladder below does, and does honestly.
//
// ⚠ WHAT IT CANNOT DO IS FREE A PENDING LANDING, AND AN EARLIER VERSION OF THIS
// NOTE CLAIMED OTHERWISE. eve.js marks a ship `landingPending` the moment a warp
// completes and retires it in a reconcile that wants the hull at STOP — but the
// same reconcile also wants the session to be ready for destiny, which is
// `initialStateSent` plus a live socket, and a session driven through the bridge
// does not reliably satisfy it. When the flag sticks, it sticks.
//
// And while it is set the pilot can issue NO movement at all. Checked command by
// command against the running server on 2026-09-14 — `gotoDirection`,
// `gotoPoint`, `alignTo`, `followBall`, `orbit`, `warpToEntity`, `warpToPoint`,
// `setSpeedFraction`, `stop` and `acceptDocking` every one of them opens by
// refusing on `hasPendingPilotWarpLanding`. The ungated variants that sit beside
// them (`stopShipEntity`, `followShipEntity`, `orbitShipEntity`) take an entity
// rather than a session and are reachable only from the server's own beacon,
// mining-NPC and fighter runtimes, never from a pilot command.
//
// So `CmdStop` is NOT the one order that gets through: `spaceRuntime.stop()`
// returns false on exactly the same test, and `Handle_CmdStop` answers 200/null
// regardless — the same accepted-and-ignored shape this file warns about above.
// It was watched failing: a stuck pilot was sent CmdStop four times in the three
// minutes before its warp home was refused, and again twenty minutes later, and
// never came free. There is no client-side cure, and this rung must not be read
// as one.
//
// That leaves the ladder worth keeping for what it genuinely does: it recovers a
// dropped order, and when nothing moves the hull it gives up QUICKLY and says
// the one true thing — this pilot's session has to be made again. What a caller
// does with that is its own call: a travelling block has nothing left and says
// so; a fighting block still has guns.
//
// ⚠ THIS IS WHY THE TEST IS ON MODES AND NOT ON DISTANCE. A hull under SOME
// target-relative order is closing on something, however slowly; STOP and GOTO
// are the two readings that prove nothing target-relative is running. The rung
// deliberately cannot tell "orbiting the WRONG rock" from "orbiting ours",
// because the ship's own row carries no `targetEntityID` on this server (see
// ui/shipHud.ts's note) — and a reading it cannot make is one it must not act
// on. Distance was the other candidate and is worse: a slow hull far out is
// indistinguishable from a stopped one for minutes at a time.

import type { SpaceSnapshot } from "../store/types.ts";
import type { MacroMemory } from "./scriptDecide.ts";

/** ~6 s of ordered-to-fly and demonstrably not flying. */
const STALL_TICKS = 3;

export type CloseInStallStep =
  /** Under course (or still inside the grace window) — carry on waiting. */
  | "flying"
  /** The order did not take: send it again — approach, orbit or hold, the caller's own. */
  | "reorder"
  /**
   * It still did not take: cut the engines, then order again. This clears a hull
   * left in GOTO by a dropped order; it does NOT clear a pending landing, which
   * refuses the stop itself — see the header.
   */
  | "unstick"
  /** Stopped, re-ordered, and STILL not moving — the hull is not ours to fly. */
  | "stuck";

export interface CloseInStall {
  readonly step: CloseInStallStep;
  readonly mem: MacroMemory;
}

function num(mem: MacroMemory, key: string): number | null {
  const value = mem[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The two modes that PROVE no target-relative order is running. Everything else
 * — FOLLOW, ORBIT, WARP, or a mode this client has never seen — is read as "the
 * hull is doing something", never as a stall, because acting on a reading this
 * client cannot make is how a rung like this breaks working flights.
 */
export function isCourseStalled(mode: string): boolean {
  return /^(stop(ped)?|goto)$/i.test(mode.trim());
}

/**
 * The hull's own movement mode, read the way `measureSpace` reads it: the ship
 * block where it has one, else this pilot's own row in the entity list. Null is
 * "the snapshot did not say", which every caller must treat as unknown.
 */
export function hullMode(snapshot: SpaceSnapshot | null): string | null {
  return snapshot?.ship?.mode ?? snapshot?.entities.find((entity) => entity.isSelf)?.mode ?? null;
}

/**
 * One tick of the stall ladder. `mem` carries the two counters; a caller resets
 * them (`clearCloseInStall`) whenever it picks a NEW thing to close on, so a
 * fresh leg always starts with its full grace window. The caller owns the
 * re-order itself: a `"reorder"` step means "send YOUR order again", never
 * "send an approach".
 */
export function closeInStall(mode: string | null, mem: MacroMemory): CloseInStall {
  // ⚠ AN UNREADABLE MODE IS "I CANNOT TELL", NEVER "IT IS NOT MOVING". This
  // whole rung is built on one reading; a tick that did not get it is no
  // evidence at all, and stopping a hull on the strength of a missing field
  // would break far more flights than the deadlock it is here for.
  if (mode === null || !isCourseStalled(mode)) {
    return { step: "flying", mem: clearCloseInStall(mem) };
  }
  const ticks = (num(mem, "stallTicks") ?? 0) + 1;
  if (ticks <= STALL_TICKS) {
    // The bridge answers before the mode flips, so a mode that has not caught
    // up yet is not a stall.
    return { step: "flying", mem: { ...mem, stallTicks: ticks } };
  }
  const stage = num(mem, "stallStage") ?? 0;
  const next = (step: CloseInStallStep): CloseInStall => ({
    step,
    mem: { ...mem, stallTicks: 0, stallStage: stage + 1 },
  });
  if (stage === 0) {
    return next("reorder");
  }
  if (stage === 1) {
    return next("unstick");
  }
  if (stage === 2) {
    // The stop went out on the last pass; the order after it deserves its own
    // window before a caller calls the hull unflyable.
    return next("reorder");
  }
  return { step: "stuck", mem };
}

export function clearCloseInStall(mem: MacroMemory): MacroMemory {
  return { ...mem, stallTicks: 0, stallStage: 0 };
}

/** The line a block says while it is putting a refused close-in order back in. */
export const STALL_REORDER_WHY = "The course did not take — ordering it again.";
/** The line a block says on the tick it cuts the engines before ordering again. */
export const STALL_UNSTICK_WHY = "The ship is not flying the course — stopping it first.";
/** The line a travelling block says once it has given up on moving the hull. */
export const STALL_STUCK_WHY = "The ship will not move.";

/**
 * What a block says when it has stopped the hull, re-ordered it and watched it
 * sit there anyway. BLOCKED and not skipped: a ship that will not move under
 * sublight will not warp either, so every block after this one is in the same
 * trouble and finishing the program is not on offer.
 */
export const STALL_STUCK_REASON =
  "The ship takes move orders and does not move - the server still has it landing from its last warp, " +
  "and no order will clear that. Sign this pilot in again before running the bot.";
