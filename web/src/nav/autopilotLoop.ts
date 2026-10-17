// Browser autopilot decide-loop (goal R5b, roadmap §7). A framework-agnostic
// port of the retail client's `autopilot.py` `AutoPilot.Update` tick loop: it
// SEQUENCES the R5a atomic calls (undock / warp / jump / dock) over a computed
// route, but never simulates or predicts position — each decision reads the
// authoritative `flight-status` and issues at most one atomic call, exactly as
// retail's client-side loop does.
//
// It runs in the BROWSER. Closing the tab is closing the client: the JS simply
// stops (no "stop" is sent), the ship completes whatever server-side command
// was last issued and then sits. The loop pauses (does not guess) on any
// unsafe/blocked condition, and after abort/pause it never calls the bridge.
//
// Truth model — MEASURE, don't guess (goal R13). Retail's autopilot measures
// `bp.GetSurfaceDist(ship, destination)` once per tick and picks the right call
// the first time. We now do the same: the R11 space snapshot reports every
// visible object's position and radius plus the ship's own, so the browser
// computes the identical surface distance and runs retail's threshold ladder,
// in retail's evaluation order:
//
//     < 2500 m   and the target is a gate     -> jump
//     < 50000 m  and the target is a station  -> dock
//     < 150000 m                              -> approach
//     otherwise                               -> warp
//
// The warp is the client's autopilot's own call (`CmdWarpToStuffAutopilot`), and
// the approach its own too (the throttle opened, then a follow at nought). This
// server stops that warp ten kilometres short and refuses it from nearer than
// about 160 km, so the loop approaches from under a floor that is further out
// than retail's 150 km: see the dead-band note below.
//
// A plan can be a pilot's own Dock or Jump instead (`navigation`). The client's
// menu flies those by its system navigation (autopilot.py, `NavigateSystemTo`):
// the menu's warp at nought from further than a warp's least distance, the
// menu's approach nearer (a follow at fifty metres, and no throttle), and the
// dock or the jump within 2,500 m. The autopilot asks that same Dock once it is
// under 50 km of its last station, so its approach there is the menu's too.
//
// Measurement is the PRIMARY path; the server's refusals remain as a backstop
// for the cycles where no snapshot is available (a slow read, a scene that has
// not caught up, a target the snapshot cannot see). When we cannot measure, the
// loop falls back to exactly the R5b mode-and-refusal behaviour it had before,
// including the verified approach-then-redock docking path. Either way, the
// browser only decides WHICH authoritative call to make — it never simulates or
// predicts position, and every move is still a server-side command.
//
// Three safety rules survive the rewrite unchanged:
//   - never act mid-warp (retail returns on DSTBALL_WARP);
//   - never re-issue a running approach (retail skips when already
//     DSTBALL_FOLLOW on that same target);
//   - pause rather than guess on an unexpected refusal.
//
// Retail's `ignoreTimerCycles` is mirrored by `settleTicks` for movement calls
// whose effects begin asynchronously (warp / approach) and for recoverable
// refusals. Session-changing BFF calls are different: undock, stargate jump,
// and dock do not resolve until the authoritative location and ship/scene
// readiness are visible, so adding fixed settle ticks after a successful return
// only hides state that is already safe to re-read.

import {
  isSessionChangeSettling,
  isTransitionTimeout,
  isTransportTransient,
  refusalWords,
} from "../bridge/refusals.ts";
import { surfaceDistanceMeters } from "../space/overview.ts";
import type { FlightStatus, SpaceSnapshot } from "../store/types.ts";
import type { RouteHop } from "./routeSolver.ts";

// --- Retail's thresholds (autopilot.py:274-404) -----------------------------

/** `maxStargateJumpingDistance` — inside this, jump instead of closing in. */
export const MAX_STARGATE_JUMPING_DISTANCE_M = 2_500;
/**
 * `maxDockingDistance` — retail's OUTER hand-off trigger only. Inside it the
 * long-haul autopilot stops routing and hands the last leg to the Dock command;
 * it is NOT the distance at which a station will actually take you.
 *
 * Kept exported because it names a real retail threshold, but the ladder no
 * longer decides on it — see STATION_DOCKING_RADIUS_M.
 */
export const MAX_DOCKING_DISTANCE_M = 50_000;

/**
 * R24 slice B — THE REAL DOCK GATE. `DEFAULT_STATION_DOCKING_RADIUS`
 * (runtime.js:700) is 2,500 m, tested by `canShipDockAtStation` (runtime.js:7563)
 * against `getShipDockingDistanceToStation` (runtime.js:7550):
 *
 *     distance(centres) - shipRadius - getStationInteractionRadius(station)
 *
 * and `getStationInteractionRadius` (runtime.js:7453) returns the station's own
 * radius whenever it has one — so that expression is exactly the SURFACE
 * distance this module already measures. 2,500 m surface, not 50,000.
 *
 * Firing `CmdDock` from further out is not harmless: `Handle_CmdDock`
 * (beyonceService.js:2994) both STARTS an approach and REFUSES with
 * `DockingApproach` (:3013-3025), and nothing auto-docks on arrival — so every
 * early Dock is a refusal the client has to absorb, and the client has to
 * re-issue anyway. Deciding on the server's own radius asks once, when it will
 * work.
 */
export const STATION_DOCKING_RADIUS_M = 2_500;
/** `minWarpDistance` — inside this, approach; beyond it, warp. */
export const MIN_WARP_DISTANCE_M = 150_000;

// --- R24 slice A: the warp DEAD BAND ----------------------------------------
//
// THE BUG THIS FIXED. R13 warped whenever the measured surface distance reached
// MIN_WARP_DISTANCE_M, but that is not the gate the server applies:
//
//   * the sim refuses when `totalDistance < MIN_WARP_DISTANCE_METERS`
//     (warpCommands.js, `WARP_DISTANCE_TOO_CLOSE`), where `totalDistance` is
//     measured to the WARP-IN POINT, not to the target's centre;
//   * and at the time it refused without a word: the browser saw `ok:true,
//     result:null` and a ship that had not moved. (Since eve.js `8d990c1c2`
//     the refusal is spoken, "You cannot warp there right now.", and the loop
//     waits such a one out: see `classifyWarpRefusal`.)
//
// So the loop re-measured, saw the same distance, decided "warp" again, and
// span. A decision that cannot make progress must pause with a reason, never
// repeat forever: hence the floor below, and the bound on the warp branch.
//
// THE FLOOR FOLLOWS THE CALL THAT WARPS. A warp that stops short of its target
// ends that much nearer the ship, so the server's gate for it is that much
// further out:
//
//   station  `getWarpStopDistanceForTarget` (warpState.js) gives
//            `targetRadius + range + 2*shipRadius` against the station CENTRE,
//            so accepted iff `surfaceDist >= 150000 + range + shipRadius`.
//   stargate `resolveStargateWarpTarget` (runtime.js) aims at a point on the
//            gate's near-side envelope, jittered by a RANDOM offset inside
//            `WARP_EXIT_VARIANCE_RADIUS_METERS` (2500), so accepted iff
//            `surfaceDist >= 150000 + range - shipRadius ± 2500`.
//
// The gate case is randomised, so no client can reproduce it exactly. What a
// client CAN do is never ask for a warp the server might refuse: take the
// worst case of both kinds. `max(shipRadius, 2500)` covers the station's
// `+shipRadius` and the gate's `+2500` at once.
//
// The page warps to a thing by two calls, and each has its range:
//
//   the client's autopilot's (`CmdWarpToStuffAutopilot`), which the travel
//   autopilot and the fleet companion make. It says no range; this server's
//   handler stops it 10 km short (`minimumRange: 10000`). Measured 2026-10-11
//   from a capsule: refused 160.0 km off a gate and taken at 160.5 km; refused
//   159.9 km off a station and taken at 160.1 km; the ship came out 10,022 to
//   11,850 m off.
//
//   the menu's at nought (`CmdWarpToStuff("item", id, minRange=0)`), which the
//   mining bot and the script bots make. Measured the same day: refused 151 km
//   off a gate and taken at 153 km; refused 149.9 km off a station and taken at
//   150.1 km; the ship came out 22 to 1,637 m off.
//
// Until 2026-10-11 the travel autopilot warped by the menu's call too, to be
// rid of the ten kilometres. It warps by the client's autopilot's now, as a
// client's autopilot does (autopilot.py, AP_WarpToDestID), and the ten
// kilometres are in its floor instead.
//
// The residual band (150 km → the floor) is not a spin: the ladder falls
// through to APPROACH there, which is what retail does below minWarpDistance
// and which actually closes the gap. (A client's autopilot asks for the warp in
// that band; this server refused it there when it was measured.)

/**
 * The range the bots' own warps ask for (the mining bot's, a script bot's): the
 * menu's warp at nought, retail's `WarpToItem(warpRange=0)`.
 */
export const MENU_WARP_RANGE_M = 0;

/**
 * How far short of its target this server stops the client's autopilot's warp
 * (`Handle_CmdWarpToStuffAutopilot`, `minimumRange: 10000`). The call itself
 * says no range. It is part of the floor that warp is taken from.
 */
export const AUTOPILOT_WARP_STOPS_SHORT_M = 10_000;

/**
 * `WARP_EXIT_VARIANCE_RADIUS_METERS` (runtime.js:701) — the radius of the random
 * scatter the server applies to a stargate warp-in point. It is drawn per call,
 * so it is the irreducible uncertainty in any client-side prediction of the
 * server's warp gate.
 */
export const WARP_EXIT_VARIANCE_M = 2_500;

/**
 * The lowest SURFACE distance at which the server is guaranteed to accept a
 * warp that ends `stopsShortM` metres short of its target — i.e. the distance
 * at or above which "warp" is a decision that can actually make progress. Below
 * it the ladder approaches instead. Nought where none is said: the menu's warp
 * at nought.
 *
 * Never below `MIN_WARP_DISTANCE_M`: retail's ladder approaches under 150 km
 * regardless, and this only ever raises that floor to match the server.
 */
export function warpFloorMeters(
  shipRadius: number,
  stopsShortM: number = MENU_WARP_RANGE_M,
): number {
  const radius = Number.isFinite(shipRadius) ? Math.max(0, shipRadius) : 0;
  const range = Number.isFinite(stopsShortM) ? Math.max(0, stopsShortM) : 0;
  return MIN_WARP_DISTANCE_M + range + Math.max(radius, WARP_EXIT_VARIANCE_M);
}

/**
 * One tick's measurement of the space around the ship, derived from the R11
 * snapshot. `distances` holds SURFACE distances in metres, keyed by the
 * object's id; a target the snapshot cannot see is simply absent (and the loop
 * falls back to its refusal-driven path for that target).
 */
export interface SpaceMeasurement {
  readonly distances: ReadonlyMap<number, number>;
  /** The ship's movement mode as the server reports it ("FOLLOW", "WARP", …). */
  readonly shipMode: string | null;
  /**
   * The ship's own hull radius (metres). It is part of the server's warp gate,
   * so the decision cannot predict a refusal without it. 0 when the snapshot
   * did not carry one — that reads as the smallest possible hull, which keeps
   * the floor conservative rather than optimistic.
   */
  readonly shipRadius: number;
}

/**
 * Build a tick's measurement from a space snapshot: the surface distance from
 * the ship to every visible object, using the same formula the server uses.
 * Returns null when the snapshot cannot support a measurement (not in space, or
 * no ship position to measure from) — the caller then decides without it.
 */
export function measureSpace(snapshot: SpaceSnapshot | null): SpaceMeasurement | null {
  if (!snapshot || !snapshot.inSpace) {
    return null;
  }
  // The ship's own position and radius: the snapshot's `ship` block where it has
  // one, else the self row in the entity list (both carry them).
  const self = snapshot.entities.find((entity) => entity.isSelf) ?? null;
  const origin = snapshot.ship?.position ?? self?.position ?? null;
  if (!origin) {
    return null;
  }
  const originRadius = snapshot.ship?.radius ?? self?.radius ?? 0;

  const distances = new Map<number, number>();
  for (const entity of snapshot.entities) {
    if (entity.isSelf) {
      continue;
    }
    distances.set(
      entity.itemID,
      surfaceDistanceMeters(origin, originRadius, entity.position, entity.radius),
    );
  }
  return {
    distances,
    shipMode: snapshot.ship?.mode ?? self?.mode ?? null,
    shipRadius: originRadius,
  };
}

/** The loop's lifecycle status (mirrors the travel-panel states). */
export type AutopilotStatus =
  | "idle"
  | "running"
  | "paused"
  | "arrived"
  | "aborted"
  | "error";

/** A compiled travel plan the loop sequences. */
export interface RoutePlan {
  readonly destinationSystemID: number;
  /** The final dock target; null travels to the system only (no final dock). */
  readonly destinationStationID: number | null;
  /** Omitted legacy plans target an NPC station. */
  readonly destinationKind?: "station" | "structure" | null;
  readonly destinationName: string | null;
  readonly hops: readonly RouteHop[];
  /**
   * True where the plan is a pilot's own Dock or Jump (the client's system
   * navigation) and no autopilot's: every warp of it is the menu's at nought,
   * and every approach the menu's.
   */
  readonly navigation?: boolean;
}

/** The single atomic decision a tick produces. */
export type AutopilotAction =
  | { readonly kind: "undock" }
  | { readonly kind: "warp"; readonly destinationID: number; readonly label: string; readonly byMenu?: boolean }
  | { readonly kind: "approach"; readonly gateID: number; readonly label: string; readonly byMenu?: boolean }
  | { readonly kind: "jump"; readonly fromGateID: number; readonly toGateID: number; readonly label: string; readonly throughJumpGate?: boolean }
  | { readonly kind: "dock"; readonly stationID: number; readonly label: string }
  | { readonly kind: "wait"; readonly reason: string }
  | { readonly kind: "arrived" }
  | { readonly kind: "pause"; readonly reason: string }
  | { readonly kind: "aborted" };

/** The live readout the panel renders (pushed via `onProgress` each cycle). */
export interface AutopilotProgress {
  readonly status: AutopilotStatus;
  readonly action: string | null;
  readonly phase: string | null;
  readonly currentSystemID: number | null;
  readonly nextSystemID: number | null;
  readonly remainingJumps: number;
  readonly totalJumps: number;
  readonly failureReason: string | null;
}

/** Everything the loop needs from the outside — all injectable for tests. */
export interface AutopilotDeps {
  getStatus(): Promise<FlightStatus>;
  /**
   * R13 — read what is around the ship so the tick can MEASURE surface
   * distances (the R11 snapshot). Optional and best-effort: a null return (or a
   * rejection the caller swallows) simply means this cycle decides from ship
   * mode and refusals, exactly as the loop did before measurement existed.
   */
  getSpaceSnapshot?(): Promise<SpaceSnapshot | null>;
  undock(): Promise<void>;
  /**
   * Warp to a gate or a station: as the client's autopilot does
   * (CmdWarpToStuffAutopilot, which this server stops ten kilometres short), or
   * with `byMenu` as its menu does (a warp at nought), for a pilot's own Dock or
   * Jump.
   */
  warp(destinationID: number, byMenu?: boolean): Promise<void>;
  /**
   * Approach a gate or a station: as the client's autopilot does (the throttle
   * opened, then a follow at nought), or with `byMenu` as its menu does (a
   * follow at fifty metres), for a pilot's own Dock or Jump and for the
   * autopilot's last station under fifty kilometres.
   */
  approach(destinationID: number, byMenu?: boolean): Promise<void>;
  /**
   * Jump through a stargate, or with `throughJumpGate` through an Ansiblex jump gate (`fromGateID` the Ansiblex):
   * structureJumpBridgeMgr.CmdJumpThroughStructureStargate, as the client's autopilot jumps one (autopilot.py 349).
   */
  jump(fromGateID: number, toGateID: number, throughJumpGate?: boolean): Promise<void>;
  dock(stationID: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  onProgress(progress: AutopilotProgress): void;
  /** True when an error means the live session is gone (unwind to offline). */
  isSessionLost(error: unknown): boolean;
  /** The handler's own user-facing refusal text (for pause/failure reasons). */
  refusalReason(error: unknown): string;
}

export interface AutopilotController {
  /**
   * Initialise the plan + memory into the running state (does not drive the
   * loop itself — the caller drives with `run()`; keeps `tick()` unit-testable
   * without a background driver racing it).
   */
  start(plan: RoutePlan): void;
  pause(): void;
  resume(): void;
  abort(): void;
  /** One decision cycle: poll status, decide, issue at most one atomic call. */
  tick(): Promise<AutopilotAction>;
  /**
   * Drive the loop until it leaves the running state (production driver). Safe
   * to call after start()/resume(); a stale driver from a prior run exits via
   * the run-token guard.
   */
  run(): Promise<void>;
  snapshot(): AutopilotProgress;
}

export const AUTOPILOT_CADENCE_MS = 2000;
const SETTLE_WARP = 2;
const SETTLE_APPROACH = 2;
const SETTLE_DOCK_REFUSAL = 2;
/**
 * How long to sit STILL after a warp refusal that did not name a blocker.
 *
 * ⚠ LONGER THAN THE OTHER SETTLES, AND THE REASON IS NOT POLITENESS. The
 * condition this waits out — the pilot warp visibility handoff still holding
 * `landingPending` — is retired by a reconcile that only considers a ship whose
 * mode is already STOP. Re-issuing straight away is worse than doing nothing,
 * because the ship is moving again (or being aligned by the block above this
 * one) on the very tick the server was willing to let go, and the flag survives
 * another lap. Waiting is the active part of this retry.
 */
const SETTLE_WARP_REFUSAL = 3;
/**
 * How many unnamed warp refusals to sit through before calling it.
 *
 * Four at SETTLE_WARP_REFUSAL is a little under half a minute of patience —
 * generous for a handoff that normally retires in a tick or two, and cheap for
 * the fatal half of that bucket (TARGET_NOT_FOUND and friends), which pays the
 * same half-minute once and then pauses with the server's own words.
 */
const MAX_WARP_REFUSALS = 4;
const MAX_DOCK_ATTEMPTS = 30;
const MAX_JUMP_ATTEMPTS = 6;
// R24 slice A — BOUND THE WARP BRANCH. The jump branch has had a counter since
// R5b; warp had none, which is why a silently-refused warp (200/null, ship
// stationary) could repeat forever. Counted per destination and reset the
// moment any other move is issued, so a normal route — warp, land, approach,
// jump — never accumulates. Only a warp that changes nothing does. Three
// consecutive warps to the same target with the ship not warping in between is
// already well past "the last one did not take": SETTLE_WARP covers the two
// ticks it takes to start, and a warp in progress is caught by the mid-warp
// wait long before this.
export const MAX_WARP_ATTEMPTS = 3;
// R24 slice B — the SAME hole on the dock branch. `MAX_DOCK_ATTEMPTS` above
// only counts REFUSALS, so it never fired for the other failure mode this
// server has: `Handle_CmdDock` returning 200/null without docking
// (beyonceService.js:3031-3042 — WARP_LANDING_PENDING, STATION_NOT_FOUND,
// SHIP_IMMOBILE, DOCKING_APPROACH_REQUIRED all arrive as `ok:true`). In range
// and never docking, the ladder would choose dock every tick forever. Counted
// like the warp branch: consecutive dock decisions for the same station, reset
// by any other move. Generous, because the honest case — dock, wait for the sim
// to seat the ship — legitimately takes a few ticks.
export const MAX_SILENT_DOCK_ATTEMPTS = 10;
// The THIRD instance of the same hole, on approach. `followBall` declines
// silently too (a pending pilot warp-landing handoff, a pending dock, mode
// still WARP, a cloaked/moribund target, a different bubble): the route
// answers ok, the ship never enters FOLLOW, the next tick measures the same
// in-band distance and issues approach again — every ~6 s, forever. That is
// the reported "hangs waiting to approach". Counted per target like the warp
// bound; reset by an OBSERVED follow (the "Closing in" wait) or any other
// move. Generous, because a warp-landing handoff legitimately declines a few.
export const MAX_APPROACH_ISSUE_ATTEMPTS = 5;
// A flight-status read can time out transiently while the server loads a
// system scene during a jump handoff — the ship is fine, so retry a few cycles
// before pausing rather than giving up on the first slow read.
const MAX_STATUS_READ_FAILURES = 5;
// The SAME tolerance for issued ACTIONS. A gateway timeout on a warp/jump/dock
// call says nothing about what the game decided — the command may have landed
// an instant after the abort — so it is never read as a refusal. The loop
// settles, re-reads authoritative state, and lets the decision re-issue if the
// world says the move did not take; only a STREAK of unanswered actions pauses.
// Reset the moment any action reaches the server and answers.
export const MAX_ACTION_TRANSPORT_FAILURES = 3;
// Give a busy gateway a breath before the re-read (same window as a move).
const SETTLE_TRANSPORT = 2;
// Commands turned back with 409 SESSION_CHANGE_IN_PROGRESS while a previous
// transition settles. Transient BY DESIGN and legitimately slow: the barrier
// deadline plus the ten-second next-mutation cooldown is close to a minute, so
// this bound is far more generous than the transport one — at the 2 s cadence
// with the settle window, twelve strikes is roughly seventy seconds.
export const MAX_SESSION_CHANGE_WAITS = 12;
// A gate approach from an autopilot-warp landing point can take many ticks to
// close into jump range; bound it generously (separate from MAX_JUMP_ATTEMPTS,
// which guards genuinely-fatal jump refusals).
const MAX_APPROACH_CYCLES = 45;
// When we MEASURE, a running approach is waited on rather than re-issued, so the
// wait can be long: closing 150 km at a cruiser's speed is minutes. Bound it far
// more generously than the refusal-driven counter above (at the 2s cadence this
// is ~20 minutes) so a ship that genuinely cannot close still stops guessing.
const MAX_APPROACH_WAIT_CYCLES = 600;

interface CompiledPlan extends RoutePlan {
  readonly hopsByFromSystem: ReadonlyMap<number, RouteHop>;
  readonly totalJumps: number;
}

interface LoopMemory {
  status: AutopilotStatus;
  warpedInSystem: number | null;
  jumpedFromSystem: number | null;
  /** Set when a jump refused NotWithinMaxJumpDist: approach this gate, then retry the jump. */
  pendingApproachGate: number | null;
  /**
   * The target of the approach WE issued, so a running approach is never
   * re-issued (retail skips when already DSTBALL_FOLLOW on the same target).
   * Cleared whenever we issue any other move.
   */
  approachingTargetID: number | null;
  /** Whether that approach was the menu's (a follow at fifty metres), and not the autopilot's own. */
  approachingByMenu: boolean;
  approachCycles: number;
  /** Consecutive ticks spent waiting on a measured, already-running approach. */
  approachWaitCycles: number;
  /** The gate `approachIssueAttempts` counts against (null = none pending). */
  approachIssueTargetID: number | null;
  /** Consecutive ISSUED approaches on that target with FOLLOW never observed. */
  approachIssueAttempts: number;
  completedHops: number;
  dockAttempts: number;
  jumpAttempts: number;
  /** The destination `warpAttempts` is counting against (null = none pending). */
  warpTargetID: number | null;
  /** Consecutive warp decisions for `warpTargetID` with nothing in between. */
  warpAttempts: number;
  /**
   * Consecutive warp REFUSALS that named no blocker — the retry budget spent
   * against `warpTargetID`. Separate from `warpAttempts`, which counts warps
   * the server ACCEPTED (200) and then quietly did not fly; these are the ones
   * it turned down out loud. A route that mixes the two should not have one
   * bound eat the other's budget.
   */
  warpRefusals: number;
  /** Consecutive dock decisions with nothing in between (the silent-decline bound). */
  silentDockAttempts: number;
  statusReadFailures: number;
  /** Consecutive issued actions whose call never got an answer (transport). */
  actionTransportFailures: number;
  /** Consecutive commands turned back while a session change was settling. */
  sessionChangeWaits: number;
  settleTicks: number;
  action: string | null;
  phase: string | null;
  currentSystemID: number | null;
  nextSystemID: number | null;
  failureReason: string | null;
}

function freshMemory(): LoopMemory {
  return {
    status: "idle",
    warpedInSystem: null,
    jumpedFromSystem: null,
    pendingApproachGate: null,
    approachingTargetID: null,
    approachingByMenu: false,
    approachCycles: 0,
    approachWaitCycles: 0,
    approachIssueTargetID: null,
    approachIssueAttempts: 0,
    completedHops: 0,
    dockAttempts: 0,
    jumpAttempts: 0,
    warpTargetID: null,
    warpAttempts: 0,
    warpRefusals: 0,
    silentDockAttempts: 0,
    statusReadFailures: 0,
    actionTransportFailures: 0,
    sessionChangeWaits: 0,
    settleTicks: 0,
    action: null,
    phase: null,
    currentSystemID: null,
    nextSystemID: null,
    failureReason: null,
  };
}

function compilePlan(plan: RoutePlan): CompiledPlan {
  const hopsByFromSystem = new Map<number, RouteHop>();
  for (const hop of plan.hops) {
    hopsByFromSystem.set(hop.fromSystemID, hop);
  }
  return { ...plan, hopsByFromSystem, totalJumps: plan.hops.length };
}

function isWarping(shipMode: string | null): boolean {
  return shipMode !== null && /warp/i.test(shipMode);
}

function isAtDestination(status: FlightStatus, plan: CompiledPlan): boolean {
  if (!status.docked || status.solarSystemID !== plan.destinationSystemID) {
    return false;
  }
  return plan.destinationStationID === null ||
    (plan.destinationKind === "structure" ? status.structureID : status.stationID) === plan.destinationStationID;
}

/**
 * Memory the decision reads (it never mutates it — the controller does that).
 * `approachingTargetID` is optional because only the MEASURED path consults it;
 * omitting it reads as "no approach of ours is running", which is the safe
 * default (the decision then issues an approach rather than wrongly skipping
 * one).
 */
type DecisionMemory = Pick<
  LoopMemory,
  "warpedInSystem" | "jumpedFromSystem" | "pendingApproachGate"
> &
  Partial<Pick<LoopMemory, "approachingTargetID" | "approachingByMenu">>;

/**
 * How long a freshly sent approach is believed regardless of the ship's mode:
 * about two ticks.
 *
 * ⚠ THE FIRST SNAPSHOT AFTER AN APPROACH OFTEN STILL READS GOTO (or the STOP of
 * a ship that had come to rest). The gateway opens the throttle BEFORE it sends
 * the follow, and a ship coasting after its orbit target died is in GOTO too, so
 * the mode turns FOLLOW one tick after the order. A rung that trusted the mode
 * alone re-sent the same approach on that tick and the server refused it
 * (observed live: "ThrottleGeneric"). Inside the window the order is trusted;
 * after it, the mode decides again, so an approach that genuinely did not take
 * is still re-sent. Shared by `decideCloseIn` and the companion's loot and
 * salvage rungs.
 */
export const APPROACH_SETTLE_MS = 4000;

/** True when the server says the ship is currently following/approaching. */
export function isFollowing(shipMode: string | null): boolean {
  return shipMode !== null && /follow|approach/i.test(shipMode);
}

/**
 * ONE RUNG OF THE MEASURED LADDER: how do I close on that object?
 *
 * Extracted so it can be REUSED rather than re-derived. `decideFromDistance`
 * below is this plus "and what do I do once I am there" (jump a gate, dock a
 * station); R26's mining bot is the same three rungs plus "and what do I do
 * once I am there" (mine the belt, dock the station). The distance thresholds,
 * the R24 warp dead band and the never-restart-a-running-approach rule are
 * therefore stated exactly once, and any correction to them corrects every
 * caller at the same time.
 *
 * `interactionRadiusM` is the SURFACE distance at which the caller's own
 * business becomes possible — the server's 2,500 m stargate jump range, the
 * server's 2,500 m station docking radius, or a bot's own "the warp has
 * landed" test. It is the caller's number, not this function's.
 *
 * `warpStopsShortM` is how far short of the target the CALLER'S warp ends,
 * which is the caller's too: nought for the menu's warp at nought (and where
 * none is said), `AUTOPILOT_WARP_STOPS_SHORT_M` for the client's autopilot's.
 * The floor under which a warp is not asked for is that much further out.
 *
 * `issuedAtMs` and `nowMs` are OPTIONAL and a caller that omits them gets exactly
 * the mode-only behaviour: when both are given and the approach was sent less
 * than `APPROACH_SETTLE_MS` ago, a GOTO or STOP reading still counts as closing.
 *
 * Returns null when the target is not measurable this tick, which sends the
 * caller back to whatever refusal-driven fallback it has.
 */
export type CloseInStep =
  /** Inside `interactionRadiusM` — do the thing. */
  | { readonly kind: "arrive" }
  /** Our own approach is already running on this target: wait, do not restart. */
  | { readonly kind: "closing" }
  /** Too close for the SERVER to accept a warp: close the gap under sublight. */
  | { readonly kind: "approach" }
  /** Far enough that the server will take a warp. */
  | { readonly kind: "warp" };

export function decideCloseIn(
  targetID: number,
  interactionRadiusM: number,
  measurement: SpaceMeasurement | null,
  approachingTargetID: number | null = null,
  warpStopsShortM: number = MENU_WARP_RANGE_M,
  issuedAtMs?: number | null,
  nowMs?: number,
): CloseInStep | null {
  const distance = measurement?.distances.get(targetID);
  if (!measurement || distance === undefined) {
    return null;
  }
  if (distance < interactionRadiusM) {
    return { kind: "arrive" };
  }
  if (distance < warpFloorMeters(measurement.shipRadius, warpStopsShortM)) {
    const settling =
      issuedAtMs !== undefined && issuedAtMs !== null && nowMs !== undefined &&
      nowMs - issuedAtMs < APPROACH_SETTLE_MS &&
      /^(goto|stop)$/i.test(measurement.shipMode ?? "");
    if (approachingTargetID === targetID && (isFollowing(measurement.shipMode) || settling)) {
      return { kind: "closing" };
    }
    return { kind: "approach" };
  }
  return { kind: "warp" };
}

/**
 * Retail's threshold ladder for ONE target, measured once (autopilot.py:274-404).
 * `kind` picks which of the two close-range rules applies — a gate jumps, a
 * station docks — and both fall through to approach and then warp, in retail's
 * evaluation order. Returns null when the target is not measurable this tick,
 * which sends the caller back to the refusal-driven fallback.
 */
function decideFromDistance(
  targetID: number,
  kind: "gate" | "station",
  measurement: SpaceMeasurement | null,
  memory: DecisionMemory,
  labels: { readonly jumpOrDock: string; readonly approach: string; readonly warp: string },
  hop: RouteHop | null,
  navigation: boolean,
): AutopilotAction | null {
  // The shared three rungs — arrive / closing / approach / warp. The close-range
  // radius is the one the SERVER applies to this kind of target:
  //   gate     `maxStargateJumpingDistance`, 2,500 m (retail checks it first,
  //            and also takes it for Upwell jump gates);
  //   station  `DEFAULT_STATION_DOCKING_RADIUS`, 2,500 m SURFACE — R24 slice B's
  //            correction from the 50 km `maxDockingDistance`, which is only
  //            retail's outer hand-off trigger (see STATION_DOCKING_RADIUS_M).
  const step = decideCloseIn(
    targetID,
    kind === "gate" ? MAX_STARGATE_JUMPING_DISTANCE_M : STATION_DOCKING_RADIUS_M,
    measurement,
    memory.approachingTargetID ?? null,
    // The floor is the call's that warps: the menu's at nought for a pilot's own
    // Dock or Jump, and the client's autopilot's for the autopilot.
    navigation ? MENU_WARP_RANGE_M : AUTOPILOT_WARP_STOPS_SHORT_M,
  );
  if (step === null) {
    return null;
  }
  // The approach is the menu's for a navigation, and for the autopilot under
  // `maxDockingDistance` of its last station, where a client's autopilot asks
  // the menu's Dock (autopilot.py 394 to 399). Else it is the autopilot's own.
  const distance = measurement?.distances.get(targetID) ?? Number.POSITIVE_INFINITY;
  const menusApproach = navigation || (kind === "station" && distance < MAX_DOCKING_DISTANCE_M);
  const approach: AutopilotAction = menusApproach
    ? { kind: "approach", gateID: targetID, label: labels.approach, byMenu: true }
    : { kind: "approach", gateID: targetID, label: labels.approach };

  switch (step.kind) {
    case "arrive":
      if (kind === "gate") {
        return hop
          ? {
              kind: "jump",
              fromGateID: targetID,
              toGateID: hop.jumpToGateID,
              label: labels.jumpOrDock,
              ...(hop.throughJumpGate === true ? { throughJumpGate: true } : {}),
            }
          : null;
      }
      return { kind: "dock", stationID: targetID, label: labels.jumpOrDock };
    case "closing":
      // The follow that is running is the autopilot's own, begun further out,
      // and the menu's is wanted here: the client's Dock makes its own follow
      // then (ShipApproach asks unless the ship follows at its own range).
      if (menusApproach && memory.approachingByMenu !== true) {
        return approach;
      }
      return { kind: "wait", reason: "Closing in" };
    case "approach":
      return approach;
    case "warp":
      return navigation
        ? { kind: "warp", destinationID: targetID, label: labels.warp, byMenu: true }
        : { kind: "warp", destinationID: targetID, label: labels.warp };
  }
}

/**
 * The pure decision: given the current flight status, the plan, the loop memory
 * and (R13) this tick's MEASUREMENT of the space around the ship, choose the
 * next atomic action. Reads memory but does not mutate it (the controller
 * reconciles memory against observed transitions and records what it issues).
 * Exported for direct unit assertions.
 *
 * `measurement` is optional: with it, the decision runs retail's distance ladder
 * and gets the call right first time; without it (a snapshot read that failed,
 * or a target the ship cannot see) the decision falls back to the R5b path that
 * drives off ship mode and learns range from the server's refusals.
 */
export function decideAutopilotAction(
  status: FlightStatus,
  plan: CompiledPlan,
  memory: DecisionMemory,
  measurement: SpaceMeasurement | null = null,
): AutopilotAction {
  // Docked: arrival check, else leave the station.
  if (status.docked) {
    if (isAtDestination(status, plan)) {
      return { kind: "arrived" };
    }
    return { kind: "undock" };
  }

  // In space and warping: never act mid-warp (retail returns on DSTBALL_WARP).
  if (isWarping(status.shipMode)) {
    return { kind: "wait", reason: "In warp" };
  }

  const sys = status.solarSystemID;
  if (sys === null) {
    return { kind: "pause", reason: "No solar system in flight status." };
  }
  // A pilot's own Dock or Jump warps and approaches as the menu does.
  const navigation = plan.navigation === true;
  const byMenu = navigation ? { byMenu: true } : {};

  // Jump handoff: while the status still shows the system we jumped FROM, the
  // session hasn't handed off yet — wait (the controller clears this once the
  // system changes).
  if (memory.jumpedFromSystem !== null && sys === memory.jumpedFromSystem) {
    return { kind: "wait", reason: "Jump handoff" };
  }

  // At the destination system: close on the station and dock.
  if (sys === plan.destinationSystemID) {
    if (plan.destinationStationID === null) {
      return { kind: "arrived" };
    }
    const stationID = plan.destinationStationID;
    const targetLabel = plan.destinationKind === "structure" ? "structure" : "station";
    // MEASURED path: dock inside 50 km, approach inside 150 km, warp beyond.
    const measured = decideFromDistance(
      stationID,
      "station",
      measurement,
      memory,
      {
        jumpOrDock: `Dock at ${targetLabel} ${stationID}`,
        approach: `Approach ${targetLabel} ${stationID}`,
        warp: `Warp to ${targetLabel} ${stationID}`,
      },
      null,
      navigation,
    );
    if (measured) {
      return measured;
    }
    // FALLBACK (no measurement): warp once, then re-issue dock through the
    // server's own DockingApproach refusal until the status shows docked.
    if (memory.warpedInSystem === sys) {
      return {
        kind: "dock",
        stationID,
        label: `Dock at ${targetLabel} ${stationID}`,
      };
    }
    return {
      kind: "warp",
      destinationID: stationID,
      label: `Warp to ${targetLabel} ${stationID}`,
      ...byMenu,
    };
  }

  // A routed system: close on its outbound gate, then jump through it.
  const hop = plan.hopsByFromSystem.get(sys);
  if (!hop) {
    return { kind: "pause", reason: `Off route: no planned hop from system ${sys}.` };
  }
  // MEASURED path: jump inside 2.5 km, approach inside 150 km, warp beyond.
  const measured = decideFromDistance(
    hop.gateToWarpID,
    "gate",
    measurement,
    memory,
    {
      jumpOrDock: `Jump to system ${hop.toSystemID}`,
      approach: `Approach gate ${hop.gateToWarpID}`,
      warp: `Warp to gate ${hop.gateToWarpID}`,
    },
    hop,
    navigation,
  );
  if (measured) {
    return measured;
  }
  // FALLBACK (no measurement): warp once, then jump — and if the jump refuses
  // for range, approach and retry (the pendingApproachGate handshake).
  if (memory.warpedInSystem === sys) {
    if (memory.pendingApproachGate === hop.gateToWarpID) {
      return {
        kind: "approach",
        gateID: hop.gateToWarpID,
        label: `Approach gate ${hop.gateToWarpID}`,
        ...byMenu,
      };
    }
    return {
      kind: "jump",
      fromGateID: hop.gateToWarpID,
      toGateID: hop.jumpToGateID,
      label: `Jump to system ${hop.toSystemID}`,
      ...(hop.throughJumpGate === true ? { throughJumpGate: true } : {}),
    };
  }
  return {
    kind: "warp",
    destinationID: hop.gateToWarpID,
    label: `Warp to gate ${hop.gateToWarpID}`,
    ...byMenu,
  };
}

/** Classify a jump refusal into a recovery path. */
function classifyJumpRefusal(reason: string): "approach" | "pause" {
  // The ship is near the gate but outside jump range — close in with an
  // approach, then retry. EveJS/retail phrase this as `NotWithinMaxJumpDist`
  // (client hint `UI/Menusvc/MenuHints/NotWithingMaxJumpDist`, sic) or
  // `NotCloseEnoughToJump`. Everything else `_HandleJumpUserErrors` treats as
  // fatal (Stuck, StandingsTooLow, gate restricted, no link, too heavy, no
  // charge) → pause and show why.
  return /close enough|not close|notcloseenough|within.?max.?jump|max.?jump.?dist|jump.?dist/i.test(
    reason,
  )
    ? "approach"
    : "pause";
}

/**
 * How to answer a warp the server turned down.
 *
 * ⚠ THE RETRYABLE CASE HAS NO WORDING OF ITS OWN, AND THAT IS THE WHOLE
 * DIFFICULTY. `_throwWarpFailureUserError` gives CRIMINAL_TIMER_ACTIVE,
 * WARP_DISRUPTED_BY_BUBBLE, WARP_SCRAMBLED, WARP_BLOCKED_BY_CLOAK,
 * SHIP_IMMOBILE and DUNGEON_INSTANCE_NOT_AUTHORIZED a sentence each, and drops
 * EVERY other reason into one generic "You cannot warp there right now." So the
 * transient one we actually care about — WARP_LANDING_PENDING, the previous
 * warp's visibility handoff not yet retired (see the runtime's
 * `hasPendingPilotWarpLanding`) — arrives wearing the same words as the fatal
 * ones it shares that bucket with: TARGET_NOT_FOUND, SHIP_NOT_FOUND,
 * WARP_ACTIVATION_FAILED, UNSUPPORTED_WARP_TARGET.
 *
 * Matching the generic sentence is therefore NOT "this is landing-pending" — it
 * is only "the server did not name a blocker it knows how to name". That is
 * still the right thing to retry on, because the named blockers are exactly the
 * ones no amount of waiting fixes, and the bound below is what keeps the fatal
 * half of the bucket from costing more than a few seconds.
 *
 * `retry` deliberately does NOT re-issue at once — see SETTLE_WARP_REFUSAL.
 */
function classifyWarpRefusal(reason: string): "arrived" | "retry" | "pause" {
  // Already inside warp distance of the target: not a failure at all — the
  // ladder should treat the hop as flown and move on to approach/jump.
  if (/already within warp|within warp distance|already in warp|too close to warp/i.test(reason)) {
    return "arrived";
  }
  // A blocker the server was willing to name. None of these clear by waiting:
  // they need the pilot to do something (decloak, wait out a timer, break the
  // scram, scan the site down), so stopping and saying so is the honest move.
  if (
    /scrambl|disrupt|bubble|criminal|cloak|immobile|cannot move|scanned that site|within complex/i.test(
      reason,
    )
  ) {
    return "pause";
  }
  // Everything else, generic sentence included.
  return "retry";
}

/** True when a dock refusal is the normal out-of-range docking-approach. */
function isDockingApproach(reason: string): boolean {
  return /dockingapproach|docking approach|approach|not in range|too far|range/i.test(reason);
}

export function createAutopilot(deps: AutopilotDeps): AutopilotController {
  let memory = freshMemory();
  let plan: CompiledPlan | null = null;
  // Bumped on pause/abort/start so a stale in-flight run() loop stops driving.
  let runToken = 0;

  function remainingJumps(): number {
    if (!plan) {
      return 0;
    }
    return Math.max(0, plan.totalJumps - memory.completedHops);
  }

  function snapshot(): AutopilotProgress {
    return {
      status: memory.status,
      action: memory.action,
      phase: memory.phase,
      currentSystemID: memory.currentSystemID,
      nextSystemID: memory.nextSystemID,
      remainingJumps: remainingJumps(),
      totalJumps: plan ? plan.totalJumps : 0,
      failureReason: memory.failureReason,
    };
  }

  function emit(): void {
    deps.onProgress(snapshot());
  }

  function setPause(reason: string): void {
    memory.status = "paused";
    memory.failureReason = reason;
    memory.phase = "Paused";
    memory.action = null;
    runToken += 1;
  }

  function setError(reason: string): void {
    memory.status = "error";
    memory.failureReason = reason;
    memory.phase = "Stopped";
    memory.action = null;
    runToken += 1;
  }

  // Update memory from the observed status BEFORE deciding: detect the jump
  // handoff completing (system changed) and refresh the readout fields.
  function reconcile(status: FlightStatus): void {
    memory.currentSystemID = status.solarSystemID;
    if (
      memory.jumpedFromSystem !== null &&
      status.solarSystemID !== null &&
      status.solarSystemID !== memory.jumpedFromSystem
    ) {
      // Handed off into the next system: one hop done, reset per-system memory.
      memory.completedHops += 1;
      memory.jumpedFromSystem = null;
      memory.warpedInSystem = null;
      memory.jumpAttempts = 0;
      memory.warpTargetID = null;
      memory.warpAttempts = 0;
      memory.warpRefusals = 0;
      memory.pendingApproachGate = null;
      memory.approachingTargetID = null;
      memory.approachCycles = 0;
      memory.approachWaitCycles = 0;
      memory.approachIssueTargetID = null;
      memory.approachIssueAttempts = 0;
    }
    if (plan) {
      const hop =
        status.solarSystemID !== null ? plan.hopsByFromSystem.get(status.solarSystemID) : undefined;
      memory.nextSystemID = hop
        ? hop.toSystemID
        : status.solarSystemID === plan.destinationSystemID
          ? null
          : memory.nextSystemID;
    }
  }

  // Issue at most one atomic call and record its effect on memory. Every bridge
  // call is preceded by a running-state guard so nothing is issued after
  // pause/abort. Refusals are classified: recoverable ones adjust memory and
  // retry; unsafe ones pause with the handler's reason.
  function isCurrent(token: number): boolean {
    return token === runToken && memory.status === "running";
  }

  async function issue(action: AutopilotAction, sys: number, token: number): Promise<void> {
    if (!isCurrent(token)) {
      return;
    }
    try {
      switch (action.kind) {
        case "undock":
          await deps.undock();
          if (!isCurrent(token)) return;
          // The BFF resolves only after the undocked location/scene/ego is
          // authoritative. The next tick can decide from that ready state.
          memory.settleTicks = 0;
          break;
        case "warp":
          await deps.warp(action.destinationID, action.byMenu === true);
          if (!isCurrent(token)) return;
          memory.warpedInSystem = sys;
          memory.pendingApproachGate = null;
          memory.approachingTargetID = null;
          memory.approachCycles = 0;
          memory.approachWaitCycles = 0;
          memory.settleTicks = SETTLE_WARP;
          break;
        case "approach":
          await deps.approach(action.gateID, action.byMenu === true);
          if (!isCurrent(token)) return;
          // Approached; clear the pending flag so the next decision retries the
          // jump (which will re-request an approach if still short of range).
          memory.pendingApproachGate = null;
          // Remember WHAT we are approaching, so a measured tick waits on the
          // running approach instead of restarting it every cycle. A RE-ISSUE
          // to the same target keeps the closing-wait count — zeroing it on
          // every re-issue would let a mode flicker (one re-approach every few
          // minutes) reset the twenty-minute stall bound forever.
          if (memory.approachingTargetID !== action.gateID) {
            memory.approachWaitCycles = 0;
          }
          memory.approachingTargetID = action.gateID;
          memory.approachingByMenu = action.byMenu === true;
          memory.settleTicks = SETTLE_APPROACH;
          break;
        case "jump":
          await deps.jump(action.fromGateID, action.toGateID, action.throughJumpGate === true);
          if (!isCurrent(token)) return;
          memory.jumpedFromSystem = sys;
          memory.pendingApproachGate = null;
          memory.approachingTargetID = null;
          memory.approachCycles = 0;
          memory.approachWaitCycles = 0;
          // The BFF has already observed the destination system and ready ship.
          memory.settleTicks = 0;
          break;
        case "dock":
          await deps.dock(action.stationID);
          if (!isCurrent(token)) return;
          memory.approachingTargetID = null;
          // A successful return includes authoritative docked location state.
          memory.settleTicks = 0;
          break;
        default:
          return;
      }
      // The call reached the server and answered: the transport and
      // session-change streaks are over.
      memory.actionTransportFailures = 0;
      memory.sessionChangeWaits = 0;
    } catch (error) {
      if (!isCurrent(token)) return;
      handleActionError(action, error, sys);
    }
  }

  function handleActionError(action: AutopilotAction, error: unknown, sys: number): void {
    if (deps.isSessionLost(error)) {
      setError("The live session ended (idle timeout or another client took over).");
      return;
    }
    // A command turned back while a previous session change settles is not a
    // refusal either — the barrier either becomes ready or its latch heals on
    // the status polls this loop already makes. Wait it out generously; the
    // whole window (barrier + cooldown) is legitimately close to a minute.
    if (isSessionChangeSettling(error)) {
      memory.sessionChangeWaits += 1;
      if (memory.sessionChangeWaits > MAX_SESSION_CHANGE_WAITS) {
        setPause(
          `${labelFor(action)} kept being turned back while a session change was finishing: ${refusalWords(deps.refusalReason(error))}`,
        );
        return;
      }
      if (action.kind === "warp") {
        memory.warpAttempts = Math.max(0, memory.warpAttempts - 1);
      } else if (action.kind === "dock") {
        memory.silentDockAttempts = Math.max(0, memory.silentDockAttempts - 1);
      } else if (action.kind === "approach") {
        memory.approachIssueAttempts = Math.max(0, memory.approachIssueAttempts - 1);
      }
      memory.settleTicks = SETTLE_TRANSPORT;
      return;
    }
    // A transport failure is NOT a refusal — the wire did not answer, and the
    // command may have landed an instant after the abort. Reads already get
    // this tolerance (MAX_STATUS_READ_FAILURES); an issued action gets the
    // same: settle, re-read authoritative state, and only a STREAK of
    // unanswered actions pauses the flight. A barrier that timed out
    // (TRANSITION_TIMEOUT) carries the same "outcome unknown" semantics — the
    // command was issued once and the next authoritative read settles what it
    // did — so it rides the same bounded path.
    if (isTransportTransient(error) || isTransitionTimeout(error)) {
      memory.actionTransportFailures += 1;
      if (memory.actionTransportFailures > MAX_ACTION_TRANSPORT_FAILURES) {
        setPause(
          `${labelFor(action)} got no answer from the server after ${memory.actionTransportFailures} tries: ${refusalWords(deps.refusalReason(error))}`,
        );
        return;
      }
      // The command never reached the game, so it must not count against the
      // silent-decline bounds — those measure commands the server SAW and
      // quietly ignored, and this one was seen by nobody. (The decision
      // counters increment before issue().)
      if (action.kind === "warp") {
        memory.warpAttempts = Math.max(0, memory.warpAttempts - 1);
      } else if (action.kind === "dock") {
        memory.silentDockAttempts = Math.max(0, memory.silentDockAttempts - 1);
      } else if (action.kind === "approach") {
        memory.approachIssueAttempts = Math.max(0, memory.approachIssueAttempts - 1);
      }
      memory.settleTicks = SETTLE_TRANSPORT;
      return;
    }
    // ⚠ TWO STRINGS, AND THEY ARE NOT INTERCHANGEABLE (R31).
    //
    // `reason` is the server's RAW text and every classification below reads
    // it — classifyJumpRefusal() looks for `NotWithingMaxJumpDist` to decide
    // approach-and-retry rather than pause, isDockingApproach() decides whether
    // docking is merely out of range, and the undock/warp guards match on the
    // handler's own wording. Those regexes are written against the SERVER's
    // vocabulary, so classifying on translated prose would silently turn a
    // recoverable refusal into a dead stop.
    //
    // `words` is the same refusal in player language and is the ONLY one that
    // may reach a pause message, because failureReason renders in the cockpit
    // strip (R30 slice C) where R9a applies.
    const reason = deps.refusalReason(error);
    const words = refusalWords(reason);

    if (action.kind === "undock" && /already in space|already_in_space/i.test(reason)) {
      // Benign: we wanted to be in space and we are. Continue.
      memory.settleTicks = 0;
      return;
    }

    if (action.kind === "jump") {
      if (classifyJumpRefusal(reason) === "approach") {
        // Near the gate but outside jump range: approach (CmdFollowBall) to
        // close in, then retry the jump. Bounded by MAX_APPROACH_CYCLES (an
        // approach from an autopilot-warp landing takes many ticks).
        memory.approachCycles += 1;
        if (memory.approachCycles > MAX_APPROACH_CYCLES) {
          setPause(`Could not close to jump range after ${memory.approachCycles} approach cycles: ${words}`);
          return;
        }
        memory.pendingApproachGate = action.fromGateID;
        memory.settleTicks = 1;
        return;
      }
      // A genuinely fatal jump refusal (stuck, standings, restricted, ...).
      memory.jumpAttempts += 1;
      if (memory.jumpAttempts > MAX_JUMP_ATTEMPTS) {
        setPause(`Could not jump after ${memory.jumpAttempts} attempts: ${words}`);
        return;
      }
      setPause(`Jump refused: ${words}`);
      return;
    }

    if (action.kind === "approach") {
      // Approach itself refusing is unusual (scrambled / can't move): pause.
      setPause(`Approach refused: ${words}`);
      return;
    }

    if (action.kind === "dock") {
      if (isDockingApproach(reason)) {
        // The server REFUSED and said why, so this is not the silent-decline
        // case: hand the counting back to MAX_DOCK_ATTEMPTS, which is bounded
        // far more generously because closing the last stretch legitimately
        // takes many re-issues on the unmeasured fallback path.
        memory.silentDockAttempts = 0;
        memory.dockAttempts += 1;
        if (memory.dockAttempts > MAX_DOCK_ATTEMPTS) {
          setPause(`Could not reach docking range after ${memory.dockAttempts} attempts.`);
          return;
        }
        // Approach-then-redock: the ship is now approaching; re-issue dock.
        memory.settleTicks = SETTLE_DOCK_REFUSAL;
        return;
      }
      setPause(`Dock refused: ${words}`);
      return;
    }

    if (action.kind === "warp") {
      const verdict = classifyWarpRefusal(reason);
      if (verdict === "arrived") {
        // Already within warp range of the target gate (e.g. sitting near it):
        // treat as arrived at the gate and proceed to approach/jump.
        memory.warpedInSystem = sys;
        memory.settleTicks = SETTLE_APPROACH;
        return;
      }
      if (verdict === "retry") {
        // ⚠ THIS BRANCH EXISTS BECAUSE THE SHIP USED TO DIE HERE. Every warp
        // refusal paused the run outright — alone among the four move kinds,
        // where jump, approach and dock have each had a bound since R5b/R24 —
        // so one unnamed refusal on the trip home left the pilot stopped in the
        // site it had just cleared: drones in, engines off, nothing running,
        // indefinitely. Resume could not help, because resuming re-entered the
        // same step and met the same refusal on the next tick.
        // The server REFUSED and said so, which is not the silent-decline case
        // MAX_WARP_ATTEMPTS exists for — and slice A counts DECISIONS, so a
        // refusal we intend to retry would otherwise trip that bound (at three)
        // before this one (at four) and pause with the wrong sentence entirely.
        // Hand the counting over, exactly as the dock branch hands it from
        // `silentDockAttempts` to `dockAttempts` above.
        memory.warpAttempts = 0;
        memory.warpRefusals += 1;
        if (memory.warpRefusals > MAX_WARP_REFUSALS) {
          setPause(
            `The warp was turned down ${memory.warpRefusals} times running and the ship has not moved: ${words}`,
          );
          return;
        }
        // Sit still and let it retire. No pause: the run stays live, and the
        // ladder re-decides the same warp once the settle runs out.
        memory.settleTicks = SETTLE_WARP_REFUSAL;
        return;
      }
      setPause(`Warp refused: ${words}`);
      return;
    }

    // Any other refusal — scrambled/disrupted/invalid target/lost control:
    // pause and show the handler's own reason. Don't guess.
    setPause(`${labelFor(action)} refused: ${words}`);
  }

  function labelFor(action: AutopilotAction): string {
    switch (action.kind) {
      case "warp":
        return "Warp";
      case "approach":
        return "Approach";
      case "jump":
        return "Jump";
      case "dock":
        return "Dock";
      case "undock":
        return "Undock";
      default:
        return "Action";
    }
  }

  async function tick(): Promise<AutopilotAction> {
    if (memory.status !== "running" || !plan) {
      const kind: AutopilotAction =
        memory.status === "arrived"
          ? { kind: "arrived" }
          : memory.status === "aborted"
            ? { kind: "aborted" }
            : { kind: "wait", reason: memory.failureReason ?? "Not running" };
      return kind;
    }

    const token = runToken;
    const stopped = (): AutopilotAction =>
      memory.status === "aborted"
        ? { kind: "aborted" }
        : { kind: "wait", reason: "stopped" };

    let status: FlightStatus;
    try {
      status = await deps.getStatus();
      if (!isCurrent(token)) return stopped();
      memory.statusReadFailures = 0;
    } catch (error) {
      if (!isCurrent(token)) return stopped();
      if (deps.isSessionLost(error)) {
        setError("The live session ended (idle timeout or another client took over).");
        emit();
        return { kind: "pause", reason: memory.failureReason ?? "session lost" };
      }
      // A transient status-read timeout (e.g. the heavy system-scene load during
      // a jump handoff) is not fatal — the ship is fine. Retry a few cycles
      // before pausing; issue nothing this cycle.
      memory.statusReadFailures += 1;
      if (memory.statusReadFailures > MAX_STATUS_READ_FAILURES) {
        setPause(
          `Could not read flight status after ${memory.statusReadFailures} tries: ${refusalWords(deps.refusalReason(error))}`,
        );
        emit();
        return { kind: "pause", reason: memory.failureReason ?? "status read failed" };
      }
      memory.phase = "Reconnecting";
      memory.action = "Waiting for flight status";
      emit();
      return { kind: "wait", reason: "status read retry" };
    }

    // Abort/pause may have fired during the status await: never issue after it.
    if (!isCurrent(token)) return stopped();

    reconcile(status);

    // Settle window after asynchronous movement or a recoverable refusal: let
    // it begin before re-deciding (retail's ignoreTimerCycles). Successful
    // BFF session changes never enter this branch because their return already
    // includes authoritative ready state. Status is still polled for readout.
    if (memory.settleTicks > 0) {
      memory.settleTicks -= 1;
      memory.phase = "Settling";
      memory.action = "Waiting for the last move to take effect";
      emit();
      return { kind: "wait", reason: "settling" };
    }

    // R13 — MEASURE before deciding. The snapshot read is best-effort: it is a
    // read, it starts nothing, and a failure just costs us measurement for this
    // cycle (the decision then falls back to mode + refusals). It is never
    // allowed to fail the tick or to issue a move.
    let measurement: SpaceMeasurement | null = null;
    if (deps.getSpaceSnapshot && !status.docked) {
      try {
        measurement = measureSpace(await deps.getSpaceSnapshot());
      } catch {
        measurement = null;
      }
      // Abort/pause may have fired during that await, like the status read.
      if (!isCurrent(token)) return stopped();
    }

    const action = decideAutopilotAction(status, plan, memory, measurement);

    // A measured approach that is already running is waited on, not re-issued.
    // Bound the wait so a ship that can never close still stops rather than
    // waiting forever.
    if (action.kind === "wait" && action.reason === "Closing in") {
      // "Closing in" is only decided off an OBSERVED follow, so the issued
      // approach demonstrably took: the silent-decline streak is over.
      memory.approachIssueTargetID = null;
      memory.approachIssueAttempts = 0;
      memory.approachWaitCycles += 1;
      if (memory.approachWaitCycles > MAX_APPROACH_WAIT_CYCLES) {
        setPause("The ship is not getting any closer. Autopilot stopped.");
        emit();
        return { kind: "pause", reason: memory.failureReason ?? "approach stalled" };
      }
    } else if (action.kind !== "wait") {
      memory.approachWaitCycles = 0;
    }

    // The approach bound — the third silent-decline hole, closed the same way
    // as warp (slice A) and dock (slice B). See MAX_APPROACH_ISSUE_ATTEMPTS.
    if (action.kind === "approach") {
      if (memory.approachIssueTargetID === action.gateID) {
        memory.approachIssueAttempts += 1;
      } else {
        memory.approachIssueTargetID = action.gateID;
        memory.approachIssueAttempts = 1;
      }
      if (memory.approachIssueAttempts > MAX_APPROACH_ISSUE_ATTEMPTS) {
        setPause(
          `The approach was sent ${MAX_APPROACH_ISSUE_ATTEMPTS} times and the ship never started moving toward it. Autopilot stopped.`,
        );
        emit();
        return { kind: "pause", reason: memory.failureReason ?? "approach not starting" };
      }
    } else if (action.kind !== "wait") {
      memory.approachIssueTargetID = null;
      memory.approachIssueAttempts = 0;
    }

    // R24 slice A — BOUND THE WARP BRANCH. A warp that is answered fine and
    // never begins (as WARP_DISTANCE_TOO_CLOSE once was — see the dead-band note
    // at the top) leaves the ship exactly where it was, so the next tick
    // measures the same distance and decides "warp" again. Counting consecutive
    // warps to the SAME destination catches precisely that and nothing else: a
    // warp that is actually running shows up as mid-warp and never reaches
    // here, and any other move resets the counter.
    if (action.kind === "warp") {
      if (memory.warpTargetID === action.destinationID) {
        memory.warpAttempts += 1;
      } else {
        memory.warpTargetID = action.destinationID;
        memory.warpAttempts = 1;
      }
      if (memory.warpAttempts > MAX_WARP_ATTEMPTS) {
        setPause(
          `The warp did not start after ${MAX_WARP_ATTEMPTS} tries and the ship has not moved. Autopilot stopped.`,
        );
        emit();
        return { kind: "pause", reason: memory.failureReason ?? "warp not starting" };
      }
    } else if (action.kind !== "wait") {
      memory.warpTargetID = null;
      memory.warpAttempts = 0;
      // Any other move getting issued means the last warp is behind us — either
      // it flew, or the ladder has moved on — so the refusal budget starts over.
      // `wait` is excluded for the same reason it is above: the settle this
      // very branch schedules must not clear the count it is settling for.
      memory.warpRefusals = 0;
    }

    // R24 slice B — and the same bound on dock, for the same reason. Arrival is
    // decided by `isAtDestination` reading `docked` back out of FLIGHT STATUS,
    // so a Dock that answers 200 and seats nobody simply never ends the loop.
    if (action.kind === "dock") {
      memory.silentDockAttempts += 1;
      if (memory.silentDockAttempts > MAX_SILENT_DOCK_ATTEMPTS) {
        setPause(
          "The station accepted the request but has not taken the ship. Autopilot stopped.",
        );
        emit();
        return { kind: "pause", reason: memory.failureReason ?? "not docking" };
      }
    } else if (action.kind !== "wait") {
      memory.silentDockAttempts = 0;
    }

    memory.action = actionText(action);
    memory.phase = phaseText(action, status);

    switch (action.kind) {
      case "arrived":
        memory.status = "arrived";
        memory.failureReason = null;
        runToken += 1;
        emit();
        return action;
      case "pause":
        setPause(action.reason);
        emit();
        return action;
      case "wait":
        emit();
        return action;
      default:
        break;
    }

    emit();
    if (!isCurrent(token)) return stopped();
    await issue(action, status.solarSystemID as number, token);
    if (token === runToken) emit();
    return action;
  }

  function actionText(action: AutopilotAction): string {
    switch (action.kind) {
      case "undock":
        return "Undocking";
      case "warp":
        return action.label;
      case "approach":
        return action.label;
      case "jump":
        return action.label;
      case "dock":
        return action.label;
      case "wait":
        // A measured approach already under way reads as what it is, not as a
        // parenthesised internal reason (R9a plain player language).
        return action.reason === "Closing in" ? "Closing in" : `Waiting (${action.reason})`;
      case "arrived":
        return "Arrived";
      case "pause":
        return "Paused";
      case "aborted":
        return "Aborted";
    }
  }

  function phaseText(action: AutopilotAction, status: FlightStatus): string {
    if (action.kind === "undock") {
      return "Undocking";
    }
    if (action.kind === "warp") {
      return "Warping";
    }
    if (action.kind === "approach") {
      return "Approaching gate";
    }
    if (action.kind === "jump") {
      return "Jumping";
    }
    if (action.kind === "dock") {
      return "Docking";
    }
    if (action.kind === "wait") {
      if (action.reason === "Closing in") {
        return "Closing in";
      }
      return isWarping(status.shipMode) ? "In warp" : "Working";
    }
    return status.docked ? "Docked" : "In space";
  }

  async function run(): Promise<void> {
    const token = runToken;
    while (token === runToken && memory.status === "running") {
      try {
        await tick();
      } catch (error) {
        if (!isCurrent(token)) return;
        // The backstop: tick() handles its own read/decide/issue failures, so
        // reaching here means something truly unexpected threw. Never die
        // silently with the panel still saying "running" — and never leave
        // the mission bot riding a driver that no longer exists.
        setError(
          `The autopilot hit an unexpected error and stopped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        try {
          emit();
        } catch {
          // The subscriber may be the very thing that is broken.
        }
        return;
      }
      if (token !== runToken || memory.status !== "running") {
        break;
      }
      await deps.sleep(AUTOPILOT_CADENCE_MS);
    }
  }

  return {
    start(nextPlan: RoutePlan): void {
      plan = compilePlan(nextPlan);
      memory = freshMemory();
      memory.status = "running";
      memory.phase = "Starting";
      runToken += 1;
      emit();
    },
    pause(): void {
      if (memory.status === "running") {
        memory.status = "paused";
        memory.phase = "Paused";
        memory.action = null;
        runToken += 1;
        emit();
      }
    },
    resume(): void {
      if (memory.status === "paused") {
        memory.status = "running";
        memory.failureReason = null;
        memory.phase = "Resuming";
        // A resume is CONSENT TO TRY AGAIN: the spent bound that paused the
        // flight must not re-trip on the first post-resume decision with the
        // identical message. Route progress (hops completed) is kept.
        memory.dockAttempts = 0;
        memory.jumpAttempts = 0;
        memory.warpTargetID = null;
        memory.warpAttempts = 0;
        memory.warpRefusals = 0;
        memory.silentDockAttempts = 0;
        memory.approachCycles = 0;
        memory.approachWaitCycles = 0;
        memory.approachIssueTargetID = null;
        memory.approachIssueAttempts = 0;
        memory.statusReadFailures = 0;
        memory.actionTransportFailures = 0;
        memory.sessionChangeWaits = 0;
        runToken += 1;
        emit();
      }
    },
    abort(): void {
      if (memory.status === "running" || memory.status === "paused") {
        memory.status = "aborted";
        memory.phase = "Aborted";
        memory.action = null;
        runToken += 1;
        emit();
      }
    },
    tick,
    run,
    snapshot,
  };
}
