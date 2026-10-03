// B2 — the script runner controller: the fourth instance of the proven loop
// shape (autopilot / mining / mission), driving the pure `decideScriptAction`
// tick. It owns the run lifecycle and NOTHING about the world — every read, every
// world call, the sleep, and the session-loss test are injected, so the runner
// is the same discipline the three shipping bots already follow and is testable
// with fakes.
//
// ⚠ THE DISCIPLINE, UNCHANGED FROM THE OTHER LOOPS:
//   • ONE call per tick, at most. `decideScriptAction` returns one action.
//   • A `runToken`, bumped on every start/pause/resume/stop, so a stale `run()`
//     that was mid-await when the player pressed pause stops driving.
//   • STATUS IS RE-CHECKED AFTER EVERY await — pause/stop can fire during a read
//     or an issue, and nothing may be issued afterwards.
//   • SETTLE TICKS after a world call — ticks of not-deciding so asynchronous
//     movement/writes can become observable (a 200 is not proof). HOW MANY is
//     per action kind, and scriptDecide's `settleTicksFor` carries the argument
//     for every reduction; a kind it does not name pays DEFAULT_SETTLE_TICKS,
//     which is the flat number this loop used to charge for everything. Ready-
//     returning session changes pay nothing, because their BFF promise resolves
//     only after authoritative location + ship/scene readiness can be re-read.
//     ⚠ A settle tick returns BEFORE observe, so it buys no read either — which
//     is why cutting one is worth the care taken over each entry in that table.
//   • Session loss is the one error allowed to end the run; any other failed read
//     becomes a wait, never a confident empty.

import type { BotScript, ProgramNode, SquadRoleArg } from "../bots/botScript.ts";
import { startupSteps, type StartupCheckpoint, type StartupState } from "../bots/startup.ts";
import { resolveStationRef } from "./scriptMacros.ts";
import {
  activeMacroID,
  currentStepID,
  activeStepNeedsTypeNames,
  activeStepToursOreSites,
  activeSquadRole,
  watchSquadRole,
  decideScriptAction,
  describeBoard,
  initialMemory,
  isWorldCall,
  settleTicksFor,
  DEFAULT_SETTLE_TICKS,
  type HomeTravelDecider,
  type MacroRegistry,
  type MacroDecider,
  type ScriptAction,
  type ScriptBoard,
  type ScriptMemory,
} from "./scriptDecide.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import { describeAction, newRunID, type BotLogDraft, type BotLogSink } from "./botLog.ts";
import {
  createRefusalLedger,
  MAX_CONSECUTIVE_REFUSALS,
  refusalKey,
  settleTicksForRefusals,
  type RefusalLedger,
  type RefusalRecord,
} from "./refusalLedger.ts";
import { isSessionChangeSettling, isTransportTransient, isTransitionTimeout, refusalWords } from "../bridge/refusals.ts";
import { createTravelAssist, type TravelAssistDeps } from "./travelAssist.ts";
import { settleCombat } from "./combatOwnership.ts";

/**
 * What the next decide will look at — so `observe` reads ONLY what that macro
 * needs (a mining block never pays for an agent-conversation read, and the
 * agent id the mission reads need rides in on the board).
 */
export interface ObserveHint {
  readonly activeMacro: string | null;
  /** A decide tick can advance several nodes before selecting mobile combat. */
  readonly needsMobileCombat?: boolean;
  /**
   * Whether the active block matches items by NAME, and so needs the type names
   * resolved for what it is looking at. Optional: a caller that does not say
   * means "no", which is what every block but a name-matching one wants.
   */
  readonly needsTypeNames?: boolean;
  /**
   * Whether the active block is a mining block touring ORE SITES, and so needs
   * the onboard scanner read that only the fly-to-an-anomaly blocks otherwise
   * pay for (see activeStepToursOreSites). Optional: a caller that does not say
   * means "no", which is what every block but a site-mode mining one wants.
   */
  readonly needsOreSites?: boolean;
  /** Whether that block follows the fleet's called primary (see activeSquadRole). */
  readonly squadRole: SquadRoleArg;
  /**
   * Whether a fight-back WATCH follows one (see watchSquadRole). Read on every
   * tick, so the flow pairs it with hostiles actually being on grid before it
   * pays for a board read.
   */
  readonly watchSquadRole: SquadRoleArg;
  readonly board: ScriptBoard;
}

export const SCRIPT_CADENCE_MS = 2000;
export function needsMobileCombat(nodes: readonly ProgramNode[]): boolean {
  return nodes.some(node => node.kind === "macro" ? node.macro === "fight-with-drones" :
    node.kind === "loop" ? needsMobileCombat(node.body) : node.kind === "branch" ?
      needsMobileCombat(node.then) || needsMobileCombat(node.else) : false);
}
/**
 * The settle a world call costs unless `settleTicksFor` knows it can cost less.
 *
 * ⚠ KEPT UNDER ITS OLD NAME ON PURPOSE. This is the number `refusalLedger.ts`
 * means by "Base settle, matching the runner's own SETTLE_TICKS", and the number
 * the runner's own tests import to assert that an ordinary write still settles.
 * It is an alias now rather than a definition — the per-kind table in
 * scriptDecide.ts owns the reasoning — but the name has to go on meaning the
 * default, or both of those become quietly wrong.
 */
export const SETTLE_TICKS = DEFAULT_SETTLE_TICKS;
export const MAX_READ_FAILURES = 5;

/**
 * Actions that put items somewhere else, so a hold which had no room may have
 * room now. Their success is the signal that expires every `refused` streak —
 * see `forgetRefused`, without which a can set aside for a full hold would
 * never be tried again after the hold was emptied.
 */
function freesHoldSpace(action: ScriptAction): boolean {
  return action.kind === "unloadOre"
    || action.kind === "unloadHolds"
    || action.kind === "unloadMissionCargo"
    || action.kind === "moveItems"
    || action.kind === "jettison"
    || action.kind === "reprocessOre";
}

/** Only these successful actions prove that ship capacity was recovered. */
function recoversHoldSpace(action: ScriptAction): boolean {
  return action.kind === "unloadOre"
    || action.kind === "unloadHolds"
    || action.kind === "unloadMissionCargo"
    || action.kind === "jettison"
    || (action.kind === "moveItems" &&
      (action.from === "cargo" || action.from === "ore") && action.to === "hangar");
}

/** These contracts retain completion/counts or verify a pending manifest first. */
function canRecoverConfirmedProgress(action: ScriptAction): boolean {
  return action.kind === "placeBuyOrder" || action.kind === "applyFitting"
    || action.kind === "scannerAnalyze" || action.kind === "moveItems"
    || action.kind === "haulTransfer";
}

/**
 * The world object an action addresses, when it addresses one.
 *
 * Only the loot pair, deliberately. A per-target streak earns its keep where a
 * block walks a LIST of interchangeable objects — one jetcan that will not give
 * up its contents must not spend the budget belonging to the next can, and must
 * not be hidden by it either. Everything else is keyed by step + action kind,
 * which is identity enough for a block that addresses one thing at a time.
 */
function actionTargetID(action: ScriptAction): number | null {
  if (action.kind === "lootWreck") {
    return action.wreckID;
  }
  if (action.kind === "lootContainer" || action.kind === "collectLaunch") {
    return action.containerID;
  }
  // An office is walked in a list exactly as a can is: one that will not give
  // up its contents must not spend the next office's budget.
  if (action.kind === "collectCustoms") {
    return action.officeID;
  }
  return null;
}

export type ScriptRunnerStatus = "idle" | "running" | "paused" | "stopped" | "error";

/** The readout pushed to the store every tick. */
export interface ScriptRunnerSnapshot {
  readonly status: ScriptRunnerStatus;
  readonly phase: string | null;
  readonly why: string | null;
  readonly stepPath: string | null;
  readonly interruptID: string | null;
  readonly pauseReason: string | null;
  /** The run board as one line ("Working with <agent>"), or null. */
  readonly note: string | null;
  /**
   * What the server is currently turning down, worst first. Empty on a healthy
   * run. This is the readout whose ABSENCE let a bot answer 227 refusals over
   * twelve hours while its status line said "Taking what's inside."
   */
  readonly refusals: readonly RefusalRecord[];
}

/**
 * Everything the runner needs from the outside. `observe` builds a fresh
 * observation from live reads (B3); `issue` performs one world call (a wait is a
 * no-op it is never asked to perform); `registry` and `travelHome` are the macro
 * deciders (B1). All injected so the loop itself touches no globals.
 */
export interface ScriptRunnerDeps {
  readonly travelAssist?: Pick<TravelAssistDeps, "change">;
  observe(hint: ObserveHint): Promise<ScriptObservation>;
  /**
   * Perform one world call.
   *
   * A returned STRING is a note: the call landed, but not entirely as the
   * action asked — a corporation hangar that refused a delivery, say, with the
   * load put ashore in the pilot's own hangar instead. It goes on the result
   * line and nowhere else: it is not a refusal (nothing to retry, no streak to
   * count) and it must never change what the run does next. Returning nothing,
   * which is what every performer did before this existed and what nearly all
   * still do, means "exactly as asked".
   */
  issue(action: ScriptAction, claimRunID?: string, invocation?: { readonly runID: string; readonly invocationID: number; readonly stepPath: string }): Promise<void | string | null | { readonly launchedDroneIDs: readonly number[] }>;
  readonly mutationCustody?: () => boolean;
  readonly startup?: StartupCheckpoint;
  /** Optional for pure tests; a live loot-containers step requires it. */
  readonly claims?: {
    read(runID: string, systemID: number): Promise<readonly number[]>;
    acquire(runID: string, systemID: number, itemID: number, renewOnly: boolean): Promise<boolean>;
    release(runID: string): Promise<void>;
  };
  sleep(ms: number): Promise<void>;
  onProgress(snapshot: ScriptRunnerSnapshot): void;
  isSessionLost(error: unknown): boolean;
  /**
   * The RAW wire text behind a failed `issue`, code prefix and all — NOT player
   * language. The ledger words it through `describeRefusal` and classifies on
   * the code, so both need the untranslated form. Injected because extracting it
   * from a transport error is the app layer's business, not the runner's.
   */
  refusalReason(error: unknown): string;
  readonly registry: MacroRegistry;
  readonly travelHome: HomeTravelDecider;
  /**
   * The flight recorder (nav/botLog.ts). OPTIONAL: a runner with no sink runs
   * exactly as it always did, which is what keeps every existing caller and
   * every pure test unchanged.
   */
  readonly log?: BotLogSink;
}

export interface ScriptRunnerController {
  travelAssistPending?(): boolean;
  confirmTravelAssistStopped?(activeModuleIDs: readonly number[] | null): void;
  start(script: BotScript): void;
  pause(): void;
  resume(): void;
  stop(): void;
  /** Stop new decisions and wait for the tick already observing/issuing. */
  beginGracefulStop(): Promise<void>;
  /** Called only after decisions and the in-flight issue have been retired. */
  settleCombatStop?(deadlineMs: number): Promise<void>;
  combatDronesForStop?(): readonly number[] | null;
  /** Freeze transport without issuing cleanup or surrendering custody. */
  suspendTransport(): Promise<void>;
  transportCustody(): boolean;
  resumeTransport(): void;
  /** Resume only the latched home flight after hosted safety settlement. */
  resumeHeadHome(reason: string): boolean;
  /**
   * End the run DOCKED: latch `reason` exactly as the runner's own faults do
   * (`stopOrHeadHome`), so the decider flies the ship home and the run pauses
   * on arrival with that reason. True when a running script is now heading
   * home (or already was); false when there is no running script to send.
   */
  headHome(reason: string): boolean;
  tick(): Promise<void>;
  run(): Promise<void>;
  snapshot(): ScriptRunnerSnapshot;
  getStatus(): ScriptRunnerStatus;
}

const IDLE_SNAPSHOT: ScriptRunnerSnapshot = {
  status: "idle",
  phase: null,
  why: null,
  stepPath: null,
  interruptID: null,
  pauseReason: null,
  note: null,
  refusals: [],
};

const SETTLING = "Waiting between actions — watching your ship.";
const READ_RETRY = "Could not read your ship just now — waiting to try again.";
const READ_GAVE_UP = "Could not read your ship for several tries, so the bot stopped.";
const READ_GAVE_UP_SENT_HOME =
  "Could not read your ship for several tries, so the bot sent it to a station and stopped.";
const SESSION_LOST = "Lost the connection to your ship, so the bot stopped.";
const DECIDE_FAILED = "The bot hit an unexpected problem working out its next move, so it stopped.";
const IN_A_CAPSULE = "Your ship is gone and you are in a capsule, so the bot stopped flying the script.";
// Commands turned back with 409 SESSION_CHANGE_IN_PROGRESS while a previous
// transition settles. The same bound and the same reasoning as the autopilot's
// MAX_SESSION_CHANGE_WAITS: the barrier deadline plus the ten-second
// next-mutation cooldown is close to a minute, so this is far more generous
// than any refusal budget. Kept local rather than imported so the script
// runner does not depend on the autopilot's module.
const MAX_SESSION_CHANGE_WAITS = 12;
// A breath before the re-issue, matching the autopilot's SETTLE_TRANSPORT.
const SETTLE_AFTER_SESSION_CHANGE = 2;

export function createScriptRunner(deps: ScriptRunnerDeps): ScriptRunnerController {
  let status: ScriptRunnerStatus = "idle";
  let runToken = 0;
  let activeTick: Promise<void> | null = null;
  let script: BotScript | null = null;
  let memory: ScriptMemory | null = null;
  let settle = 0;
  let readFailures = 0;
  // Consecutive 409s while a session change settles. Reset the moment ANY call
  // gets through, so a jump's ten-second cooldown never leaves a budget spent
  // for the rest of the run.
  let sessionChangeWaits = 0;
  // ⚠ PER RUN, AND THAT IS THE POINT. A macro's own attempt counter lives in
  // step memory, which scriptDecide drops every time the step is left, so a
  // forever-loop hands the same failing target a fresh budget on every lap. This
  // one is replaced only by `start`, so its bound is the one that binds.
  let ledger: RefusalLedger = createRefusalLedger();
  let last: ScriptRunnerSnapshot = IDLE_SNAPSHOT;
  /**
   * The last observation that actually arrived. Kept for ONE reason: when reads
   * stop working there is nothing to decide with, but a station id read a few
   * seconds ago is still a station id — see `sendToStationThenStop`.
   */
  let lastObs: ScriptObservation | null = null;
  /** This run's id, minted by `start` — what groups a log's lines. */
  let runID = "";
  let actionInvocation = 0;
  // A dispatched action owns its outcome even if Pause/Stop fires while it is
  // awaiting the wire. A fresh Start cannot replace that pending transaction.
  let issuePending = false;
  let uncertainAction: ScriptAction | null = null;
  let combatStopCustody = false;
  // Recovery must not erase an accepted write's completion or quantity. Track
  // whole records, never private macro keys; an unclassified contract pauses.
  const retainedProgress = new Map<string, { visit: string; recoverable: boolean; action: ScriptAction }>();
  let recoveryBlocked = false;
  const visitKey = (mem: ScriptMemory) => JSON.stringify([mem.position, mem.loopPass]);
  function retainActionProgress(before: ScriptMemory, next: ScriptMemory, action: ScriptAction, startupFenced = false): void {
    const visit = visitKey(next);
    for (const [key, record] of Object.entries(next.macroMem)) {
      if (record === before.macroMem[key]) continue;
      const previous = retainedProgress.get(key);
      retainedProgress.set(key, { visit,
        action: previous?.visit === visit && !previous.recoverable ? previous.action : action,
        // A dispatched Startup step has its own durable postcondition gate.
        // Only that exact fenced step may resume observation without resetting
        // progress; unrelated MAIN/interrupt contracts retain Farmer's policy.
        recoverable: (canRecoverConfirmedProgress(action) || startupFenced) && (previous?.visit !== visit || previous.recoverable) });
    }
  }
  function activeProgress(): readonly { recoverable: boolean; action: ScriptAction }[] {
    for (const [key, progress] of retainedProgress) {
      if (!memory || !(key in memory.macroMem) || progress.visit !== visitKey(memory)) retainedProgress.delete(key);
    }
    return [...retainedProgress.values()];
  }
  let claim: { runID: string; systemID: number; itemID: number } | null = null;
  let transportSuspended = false;
  const travelAssist = deps.travelAssist ? createTravelAssist({ ...deps.travelAssist,
    log: why => record({ t: now(), kind: "decide", run: runID, says: "travel assist", why }),
  }) : null;
  const claimOwner = () => `${runID}:${runToken}`;
  async function releaseOwned(owned: { runID: string } | null): Promise<void> {
    if (owned && deps.claims) await deps.claims.release(owned.runID).catch(() => {});
  }
  async function releaseClaim(): Promise<void> {
    const owned = claim;
    claim = null;
    await releaseOwned(owned);
  }
  function releaseAfterIssue(): void {
    const owned = claim;
    claim = null;
    const pending = activeTick;
    if (pending) void pending.finally(() => releaseOwned(owned)).catch(() => {});
    else void releaseOwned(owned);
  }
  /** The last decision actually written, so a quiet bot writes nothing. */
  let loggedDecision = "";
  /**
   * Whether this run's end line is already written. A run ends ONCE: stopping a
   * bot that has already finished emits another terminal snapshot, and a log
   * that says a run ended twice is a log nobody can count runs in.
   */
  let loggedEnd = false;

  /**
   * ⚠ RULE 4: THE RECORDER NEVER BREAKS THE RUN. A sink that throws — a full
   * disk, a dead route, a bug of its own — loses its line and nothing else. It
   * is never awaited either: a slow writer must not add latency to a tick that
   * is flying a ship.
   */
  function record(draft: BotLogDraft): void {
    const sink = deps.log;
    if (sink === undefined) {
      return;
    }
    try {
      sink.write(draft);
    } catch {
      // A line lost is the correct price; a ship stopped is not.
    }
  }

  function now(): string {
    return new Date().toISOString();
  }

  /**
   * One line per CHANGE, not per tick. At a two-second cadence a verbatim log is
   * an hour of "Mining / Mining / Mining"; what a reader wants is the moments it
   * became something else. A run that ends writes its end line instead.
   */
  function recordProgress(next: ScriptRunnerSnapshot): void {
    if (deps.log === undefined) {
      return;
    }
    if (next.status === "stopped" || next.status === "error") {
      if (loggedEnd) {
        return;
      }
      loggedEnd = true;
      record({
        t: now(), kind: "end", run: runID, status: next.status,
        reason: next.pauseReason ?? next.why ?? null,
      });
      loggedDecision = "";
      return;
    }
    const key = [next.status, next.phase, next.why, next.stepPath, next.interruptID].join(" | ");
    if (key === loggedDecision) {
      return;
    }
    loggedDecision = key;
    record({
      t: now(), kind: "decide", run: runID, status: next.status,
      phase: next.phase, why: next.why, stepPath: next.stepPath, interruptID: next.interruptID,
      reason: next.pauseReason ?? null,
    });
  }

  function emit(next: ScriptRunnerSnapshot): void {
    last = next;
    recordProgress(next);
    deps.onProgress(next);
  }

  function setError(reason: string): void {
    runToken += 1;
    status = "error";
    emit({ ...last, status: "error", why: reason, pauseReason: reason });
    releaseAfterIssue();
  }

  async function tickBody(): Promise<void> {
    const token = runToken;
    if (status !== "running" || script === null || memory === null) {
      return;
    }

    // Settle: let a just-issued action land before deciding again.
    if (settle > 0) {
      if (claim && deps.claims) {
        try {
          if (!await deps.claims.acquire(claim.runID, claim.systemID, claim.itemID, true)) {
            pauseWith("The container claim expired or changed owner.");
            return;
          }
        } catch {
          pauseWith("Container claim authority is unreadable.");
          return;
        }
      }
      if (token !== runToken || status !== "running") return;
      settle -= 1;
      emit({ ...last, status: "running", phase: SETTLING });
      return;
    }

    let obs: ScriptObservation;
    try {
      obs = await deps.observe({
        activeMacro: activeMacroID(script, memory),
        needsMobileCombat: needsMobileCombat(script.program),
        needsTypeNames: activeStepNeedsTypeNames(script, memory),
        needsOreSites: activeStepToursOreSites(script, memory),
        squadRole: activeSquadRole(script, memory),
        watchSquadRole: watchSquadRole(script),
        board: memory.board,
      });
    } catch (error) {
      // Preserve the failed observation at the same recorder seam as actions.
      // Retry/give-up copy cannot identify a refused read or a projection bug.
      record({ t: now(), kind: "result", run: runID, phase: READ_RETRY,
        says: "observe ship state", ok: false, refusal: deps.refusalReason(error) });
      if (token !== runToken || status !== "running") return;
      if (deps.isSessionLost(error)) {
        setError(SESSION_LOST);
        return;
      }
      readFailures += 1;
      if (readFailures >= MAX_READ_FAILURES) {
        await sendToStationThenStop();
        return;
      }
      emit({ ...last, status: "running", phase: READ_RETRY, why: READ_RETRY });
      return;
    }
    if (token !== runToken || status !== "running") {
      return; // pause/stop fired during the read
    }
    readFailures = 0;
    lastObs = obs;
    const operation = obs.miningOperation;
    const ownedTarget = operation?.role === "HAULER" ? operation.logisticsTarget ?? operation.currentTarget : operation?.currentTarget;
    const travelAuthority = operation?.travelAssist === "AUTO" && !operation.stopRequested &&
      !!ownedTarget && ownedTarget.claimedByOperationID === operation.operationID &&
      ["RESERVED", "ACTIVE", "DRAINING"].includes(ownedTarget.state);
    if (travelAssist?.pending() && !travelAuthority) {
      await travelAssist.beforeAction({ enabled: false, scope: null, action: { kind: "wait" },
        snapshot: obs.snapshot ?? null, inWarp: obs.inWarp ?? null, docked: obs.docked ?? null,
        modules: [], scrammed: obs.scrammed ?? null });
      if (travelAssist.pending()) { pauseWith("Travel assist shutdown is unconfirmed; operation movement is blocked."); return; }
      if (token !== runToken || status !== "running") return;
    }
    if (activeMacroID(script, memory) === "loot-containers") {
      const systemID = obs.flightStatus?.solarSystemID ?? null;
      if (!deps.claims || !systemID) {
        pauseWith("Container claim authority is unavailable.");
        return;
      }
      try {
        obs = { ...obs, claimedContainerIDs: await deps.claims.read(claimOwner(), systemID) };
      } catch {
        pauseWith("Container claim authority is unreadable.");
        return;
      }
      if (token !== runToken || status !== "running") {
        if (!transportSuspended) await releaseClaim();
        return;
      }
    }

    // ⚠ THE HULL IS GONE. A destroyed ship does not end the run on its own: the
    // session survives, the reads keep working, and the decider happily goes on
    // mining — in a pod, which has no miner, no hold and no tank. Three ships
    // were lost on 2026-09-09/10 and every one of them kept "flying the script"
    // for another 10-12 minutes afterwards, one of them warping the capsule back
    // to the belt it had just died on. It only ever stopped by tripping some
    // unrelated guard (ten refusals of a module that no longer exists), which is
    // the bot noticing by accident.
    //
    // TRI-STATE, AND ONLY `true` DECIDES. `null` is "the gateway did not say"
    // (an older BFF omits the field) and must never stop a healthy run — the
    // same null-is-not-a-verdict rule the conditions follow.
    //
    // HEADING HOME, NOT PAUSING. A pod parked in a belt is still a target, and
    // stopping where it floats is what the four-ships rule in `stopOrHeadHome`
    // exists to prevent. The capsule can dock; let it.
    // ⚠ ONCE. `stopOrHeadHome` latches the first time and PAUSES the second, so
    // firing this every tick would pause the pod where it floats — the exact
    // outcome the latch exists to avoid. Once latched, fall through and let the
    // decider fly the thing home.
    if (obs.flightStatus?.shipIsCapsule === true && memory !== null && memory.latched === null) {
      stopOrHeadHome(IN_A_CAPSULE);
      return;
    }

    let registry = deps.registry;
    if (deps.startup && startupSteps(script).length) {
      try {
        const states = new Map<string, StartupState>();
        const currentID = currentStepID(script, memory);
        const current = startupSteps(script).find(step => step.id === currentID);
        if (current) states.set(current.id, await deps.startup.observe(current, obs));
        if (token !== runToken || status !== "running") return;
        registry = Object.fromEntries(Object.entries(deps.registry).map(([id, decider]) => [id,
          ((step, facts, mem, board) => {
            if (!startupSteps(script!).some(candidate => candidate.id === step.id)) return decider!(step, facts, mem, board);
            const state = states.get(step.id) ?? "PENDING";
            const base = { action: { kind: "wait" } as const, phase: "Startup", armed: false, nextMem: mem };
            if (state === "COMPLETE") return { ...base, why: "Startup postcondition verified.", outcome: { kind: "done" } as const };
            if (state === "BLOCKED") return { ...base, why: "Startup requires reconciliation.",
              outcome: { kind: "blocked", reason: "Startup outcome is unknown or its adapter is unsupported; MAIN is blocked." } as const };
            if (state === "PENDING") return { ...base, why: "Verifying startup outcome.", outcome: { kind: "acting" } as const };
            const tick = decider!(step, facts, mem, board);
            // The independent observer owns completion. Macro done/skipped and
            // its until condition cannot open the main barrier.
            return { ...tick, armed: false, outcome: tick.outcome.kind === "done" || tick.outcome.kind === "skipped"
              ? { kind: "acting" } as const : tick.outcome };
          }) as MacroDecider]));
      } catch (error) { pauseWith(`Startup checkpoint failed: ${String(error)}`); return; }
    }

    // Deciding is pure and total BY DESIGN, but a macro adapter reaching into a
    // live snapshot could still throw on a shape the tests never saw. If it does,
    // an unwrapped throw would reject run() and kill the loop SILENTLY — the ship
    // freezes mid-task with no reason on screen. So a throw here becomes a plain
    // pause the player can read and recover from, never a dead loop.
    let result: ReturnType<typeof decideScriptAction>;
    try {
      // ⚠ THE LEDGER RIDES IN ON THE OBSERVATION. A decider's whole interface is
      // "here are the facts, choose" — and "this can has refused me nine times
      // running, across four laps" is a fact about the world exactly like a
      // distance is. Handing it over here rather than as a fifth argument keeps
      // every macro reading one thing, and keeps `decideScriptAction` pure.
      result = decideScriptAction(
        script,
        { ...obs, refusals: ledger.records() },
        memory,
        registry,
        deps.travelHome,
      );
    } catch (error) {
      stopOrHeadHome(`${DECIDE_FAILED} (${String(error)})`);
      return;
    }
    if (travelAssist) {
      const movementMacro = activeMacroID(script, memory);
      const consumed = await travelAssist.beforeAction({
        enabled: travelAuthority && result.status === "running" && result.memory.latched === null &&
          ["mine-at-belt", "fleet-mine", "loot-containers"].includes(movementMacro ?? ""),
        scope: ownedTarget ? `${ownedTarget.targetKey}:${result.stepPath}` : null,
        action: result.action, snapshot: obs.snapshot ?? null, inWarp: obs.inWarp ?? null,
        docked: obs.docked ?? null, modules: obs.travelPropulsionModules ?? [], scrammed: obs.scrammed ?? null,
      });
      if (consumed || token !== runToken || status !== "running") return;
    }
    if (deps.startup?.checkpoint) {
      // The decider may advance a proven Startup prefix and select MAIN in
      // this same tick. Persist that cursor, never unconfirmed action progress.
      const cursor = isWorldCall(result.action)
        ? { ...memory, position: result.memory.position, loopPass: result.memory.loopPass }
        : result.memory;
      try { await deps.startup.checkpoint(cursor); }
      catch (error) { pauseWith(`Startup checkpoint failed: ${String(error)}`); return; }
      if (token !== runToken || status !== "running") return;
    }
    const selected = result.containerTargetID;
    if (claim && (selected !== claim.itemID || obs.flightStatus?.solarSystemID !== claim.systemID)) {
      await releaseClaim();
    }
    if (selected !== undefined) {
      const systemID = obs.flightStatus?.solarSystemID ?? null;
      if (!systemID || !deps.claims) {
        pauseWith("Container claim authority is unavailable.", result);
        return;
      }
      const owner = claim?.runID ?? claimOwner();
      try {
        const acquired = await deps.claims.acquire(owner, systemID, selected, claim !== null);
        if (acquired) claim = { runID: owner, systemID, itemID: selected };
        if (token !== runToken || status !== "running") {
          if (acquired && !transportSuspended) await releaseClaim();
          return;
        }
        if (!acquired) {
          emit({ ...last, status: "running", phase: "Looting", why: "Another hauler has claimed this container." });
          return;
        }
      } catch {
        if (token !== runToken || status !== "running") return;
        pauseWith("Container claim authority is unreadable.", result);
        return;
      }
      if (token !== runToken || status !== "running") {
        if (!transportSuspended) await releaseClaim();
        return;
      }
    }

    if (result.status === "paused") {
      memory = result.memory;
      pauseWith(result.pauseReason ?? result.why, result);
      return;
    }
    if (result.status === "done") {
      memory = result.memory;
      runToken += 1;
      status = "stopped";
      emit(toSnapshot(result, "stopped"));
      releaseAfterIssue();
      return;
    }

    if (isWorldCall(result.action)) {
      const beforeAction = memory;
      // A safety watch's home destination is intent, not action completion:
      // keep that latch even when this first movement request is refused.
      memory = { ...memory, latched: memory.latched ?? result.memory.latched };
      const targetID = actionTargetID(result.action);
      const key = refusalKey(result.stepPath, result.action.kind, targetID);
      let issuedSuccessfully = false;
      // Set only by a refusal, so a healthy call keeps the ordinary settle.
      let backoffTicks: number | null = null;
      // ⚠ WRITTEN BEFORE THE CALL, DELIBERATELY. A line after the fact says
      // nothing when the process dies mid-action; this is the one that tells
      // you what the ship was about to do when everything stopped.
      record({
        t: now(), kind: "issue", run: runID, action: result.action, says: describeAction(result.action),
        stepPath: result.stepPath, interruptID: result.interruptID, phase: result.phase, why: result.why,
      });
      const startupStep = startupSteps(script).find(step => step.id === result.stepPath);
      if (startupStep && deps.startup) {
        try { await deps.startup.beforeIssue(startupStep, result.action, actionInvocation + 1); }
        catch (error) { pauseWith(`Startup dispatch blocked: ${String(error)}`); return; }
        if (token !== runToken || status !== "running") return;
      }
      issuePending = true;
      try {
        const note = await deps.issue(result.action, result.action.kind === "lootContainer" ? claim?.runID : undefined,
          { runID, invocationID: ++actionInvocation, stepPath: result.stepPath ?? "" });
        issuePending = false;
        // Completion belongs to the confirmed action, including one that
        // finished while paused. Preserve a concurrently requested home trip.
        memory = { ...result.memory, latched: memory?.latched ?? result.memory.latched };
        if (result.action.kind === "launchDrones" && note && typeof note === "object" && result.stepPath) {
          const state = memory.macroMem[result.stepPath];
          const owned = state?.combatOwned as import("./combatOwnership.ts").CombatOwnership | undefined;
          if (owned) memory = { ...memory, macroMem: { ...memory.macroMem, [result.stepPath]: {
            ...state, combatOwned: { ...owned, pendingLaunch: false,
              drones: [...new Set([...owned.drones, ...note.launchedDroneIDs])] },
          } } };
        }
        retainActionProgress(beforeAction, memory, result.action, !!startupStep && !!deps.startup);
        issuedSuccessfully = true;
        sessionChangeWaits = 0;
        record({
          t: now(), kind: "result", run: runID, ok: !(typeof note === "string" && note.startsWith("UNCERTAIN")), says: describeAction(result.action),
          status: typeof note === "string" && note.length > 0 ? note : undefined,
        });
        // It worked: the streak is over. Without this a key that failed twice
        // and then recovered would carry those two forever and stop the run
        // early on an unrelated blip much later.
        ledger.clear(key);
        if (freesHoldSpace(result.action)) {
          ledger.forgetRefused(recoversHoldSpace(result.action));
        }
        if (result.action.kind === "lootContainer" && !transportSuspended) await releaseClaim();
      } catch (error) {
        issuePending = false;
        // A failed response after dispatch cannot prove that the mutation did
        // not land. Do not commit its completion or let Resume replay it.
        // Corporate transfers have their own observed-manifest reconciliation.
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        const acceptedDroneIDs = error && typeof error === "object" && "acceptedDroneIDs" in error
          ? error.acceptedDroneIDs : null;
        if (result.action.kind === "engageDrones" && code === "CALL_REFUSED" && Array.isArray(acceptedDroneIDs) && acceptedDroneIDs.length > 0) {
          // A partial refusal proves some orders landed. Rolling back the full
          // flight would resend those accepted orders; neither completion nor
          // a whole-flight retry is valid without observing each recipient.
          uncertainAction = result.action;
          const reason = deps.refusalReason(error);
          record({ t: now(), kind: "result", run: runID, ok: false, refusal: reason,
            says: describeAction(result.action), stepPath: result.stepPath });
          pauseWith(`Some drones accepted the engagement order and others refused it. Verify their targets in the game, then Stop before starting a new run. ${refusalWords(reason)}`, result);
          return;
        }
        if (result.action.kind !== "haulTransfer" && !(result.action.kind === "unloadOre" && result.action.strictCorp === true) &&
            !(result.action.kind === "jettison" && deps.mutationCustody?.()) &&
            code !== "EDGE_OWNER_OVERLOADED" &&
            (isTransportTransient(error) || isTransitionTimeout(error) || code === "BRIDGE_BAD_RESPONSE" ||
             code === "MODULE_ACTION_UNCERTAIN")) {
          // Preserve possible ownership for observed Stop reconciliation, not step completion.
          if (memory) {
            const macroMem = { ...memory.macroMem };
            for (const [path, state] of Object.entries(result.memory.macroMem)) {
              if (state.combatOwned) macroMem[path] = { ...macroMem[path], combatOwned: state.combatOwned };
            }
            memory = { ...memory, macroMem };
          }
          uncertainAction = result.action;
          const reason = deps.refusalReason(error);
          record({ t: now(), kind: "result", run: runID, ok: false, refusal: reason,
            says: describeAction(result.action), stepPath: result.stepPath });
          pauseWith(`The outcome of ${describeAction(result.action)} could not be confirmed. Verify it in the game, then Stop before starting a new run. ${refusalWords(reason)}`, result);
          return;
        }
        if (result.action.kind === "haulTransfer" || (result.action.kind === "unloadOre" && result.action.strictCorp === true)) {
          // The result owns the exact pre-transfer manifest even when transport
          // suspension retired this tick. Its next observation reconciles it.
          memory = { ...result.memory, latched: memory?.latched ?? result.memory.latched };
          retainActionProgress(beforeAction, memory, result.action);
          if (token !== runToken || status !== "running") return;
        }
        if (token !== runToken || status !== "running") return;
        if (result.action.kind === "jettison" && deps.mutationCustody?.()) {
          memory = result.memory;
          pauseWith("Jettison needs reconciliation; mutation custody is retained and no duplicate will be issued.", result);
          return;
        }
        if (deps.isSessionLost(error)) {
          setError(SESSION_LOST);
          return;
        }
        if (result.action.kind === "haulTransfer" || (result.action.kind === "unloadOre" && result.action.strictCorp === true)) {
          memory = result.memory;
          // A transport error can arrive after an inventory mutation. Do not
          // retry or even auto-reconcile a route-owned transfer on the next
          // tick. Keep its pending manifest and require an explicit resume,
          // whose first fresh observation verifies both sides before new work.
          const reason = deps.refusalReason(error);
          record({
            t: now(), kind: "result", run: runID, ok: false, refusal: reason,
            says: describeAction(result.action), stepPath: result.stepPath,
          });
          pauseWith(`Corporate transfer needs reconciliation before the route continues: ${refusalWords(reason)}`, result);
          return;
        }
        // ⚠ A SETTLING SESSION CHANGE IS NOT A REFUSAL, AND COUNTING IT AS ONE
        // COST THREE SHIPS. For ten seconds after a jump the BFF turns every
        // mutation back with 409 — including the FIRST thing a ship does on
        // arrival, which is put its hardeners up. Booked as an ordinary refusal
        // that press is spent: the ledger takes it, the macro's own attempt
        // budget takes it, and the block moves on to shooting. On 2026-09-09/10
        // all three lost ships fought a gate spawn with their resists down, and
        // in every one of the three logs the hardener was asked for exactly once
        // and never again.
        //
        // So it is not booked at all. The ledger never sees it, no attempt is
        // consumed, and the next tick asks for the same thing — which is what
        // the two loops that already handle this do (nav/autopilotLoop
        // `handleActionError`, nav/missionBotLoop) and what bridge/refusals
        // `isSessionChangeSettling` says in as many words: "a loop must wait
        // this out generously, never pause on the first one".
        //
        // BOUNDED ANYWAY. Waiting forever on a barrier that never clears is its
        // own way to lose a ship, so a streak still ends the run — and ends it
        // by heading home, not by parking where it floats.
        if (isSessionChangeSettling(error)) {
          sessionChangeWaits += 1;
          record({
            t: now(), kind: "result", run: runID, ok: false,
            refusal: deps.refusalReason(error),
            says: describeAction(result.action), stepPath: result.stepPath,
          });
          if (sessionChangeWaits > MAX_SESSION_CHANGE_WAITS) {
            stopOrHeadHome(
              `The ship kept being turned back while a session change finished: ${refusalWords(deps.refusalReason(error))}`,
              result,
            );
            return;
          }
          backoffTicks = SETTLE_AFTER_SESSION_CHANGE;
        } else {
        // A refusal is not a crash — but it is not nothing either, which is what
        // it used to be. It gets counted, worded, slowed down, and eventually
        // acted on rather than retried at full speed until somebody notices.
        //
        // `stillOnGrid` separates a target that has DESPAWNED from one that is
        // merely out of range: both arrive as the same FakeItemNotFound, and an
        // unreadable grid is evidence of neither (see classifyRefusal).
        const snapshot = obs.snapshot ?? null;
        const stillOnGrid =
          targetID === null || snapshot === null
            ? null
            : snapshot.entities.some((entity) => entity.itemID === targetID);
        const reason = deps.refusalReason(error);
        record({
          t: now(), kind: "result", run: runID, ok: false, refusal: reason,
          says: describeAction(result.action), stepPath: result.stepPath,
        });
        const record_ = ledger.note(key, reason, Date.now(), stillOnGrid);
        if (record_.count >= MAX_CONSECUTIVE_REFUSALS) {
          stopOrHeadHome(
            `Stopped after ${record_.count} refusals in a row. ${record_.words}`,
            result,
          );
          return;
        }
        backoffTicks = settleTicksForRefusals(record_.count);
        }
      }
      if (token !== runToken || status !== "running") {
        return;
      }
      // ⚠ THE SETTLE IS PER ACTION KIND NOW, and `settleTicksFor` is where the
      // whole argument lives — every entry there names the thing that stops the
      // runner re-issuing on a read that has not caught up yet. It is an
      // ALLOWLIST OF REDUCTIONS: an action kind it has never heard of gets
      // DEFAULT_SETTLE_TICKS, which is the flat number this line used to apply
      // to everything. The four ready-returning session changes (undock, dock,
      // jump, boardShip) are the table's first four entries and carry the
      // reasoning that used to sit in this file.
      //
      // A REFUSAL IS UNTOUCHED BY ANY OF THAT. A call that did not land settles
      // on the GROWN backoff the ledger worked out, or on the default when there
      // is none — a failed call is not evidence about how fast its kind may be
      // repeated, it is evidence the world said no.
      settle = issuedSuccessfully
        ? settleTicksFor(result.action)
        : (backoffTicks ?? DEFAULT_SETTLE_TICKS);
    } else {
      memory = result.memory;
    }

    emit(toSnapshot(result, "running", ledger.records()));
  }

  function tick(): Promise<void> {
    if (activeTick !== null) return activeTick;
    const pending = tickBody();
    const owned = pending.finally(() => {
      if (activeTick === owned) activeTick = null;
    });
    activeTick = owned;
    return owned;
  }

  /**
   * The station to send a blind ship to, best first.
   *
   * The script's OWN configured home comes first and needs no reads at all: it
   * is a setting the player pinned, resolved here exactly the way flow.ts
   * resolves it every tick (a fixed id, "where the ship started", or a station an
   * earlier block published on the board). The observation-derived ids are only
   * fallbacks for a home that resolves to nothing.
   *
   * ⚠ IT WILL NOT MOVE A SHIP IT HAS NEVER SEEN. With no observation at all
   * there is no evidence the ship is even in space, and undocking a safe ship to
   * fly it somewhere blind is a worse outcome than stopping and saying so. Same
   * for one last seen docked: it is already where this would send it.
   */
  function stationToSendTo(): number | null {
    const seen = lastObs;
    if (seen === null || seen.flightStatus?.docked === true) {
      return null;
    }
    const configured =
      script === null
        ? null
        : resolveStationRef(script.home, seen.startingStationID ?? null, memory?.board ?? {});
    return configured ?? seen.homeStationID ?? seen.startingStationID ?? seen.flightStatus?.stationID ?? null;
  }

  /**
   * READS HAVE GIVEN UP — and a blind ship still must not be left floating.
   *
   * Nothing can be decided here: there is no observation, so no grid, no health,
   * no target. But the autopilot is not driven by these reads — it runs its own
   * loop with its own reads and its own bounds — so handing it a station id the
   * bot knew a few seconds ago gets the ship moving toward a station even though
   * this runner can no longer see it do so.
   *
   * Then it stops, and says which of the two things happened. It cannot report
   * arrival: watching the ship dock is exactly the thing it has lost the ability
   * to do, and claiming a ship is safe without seeing it is the lie this file
   * avoids everywhere else.
   *
   * ⚠ THE SHIP IS NOT SAVED BY THIS, only pointed the right way. If it is held,
   * the autopilot will be refused and will pause too — blind, there is no
   * fighting free (nav/scriptMacros `fightTheWayOut` needs a grid to read).
   */
  async function sendToStationThenStop(): Promise<void> {
    const stationID = stationToSendTo();
    if (stationID === null) {
      pauseWith(READ_GAVE_UP);
      return;
    }
    const homeRoute = { kind: "startRoute", stationID } as const;
    record({ t: now(), kind: "issue", run: runID, action: homeRoute, says: describeAction(homeRoute), why: "sending the ship home" });
    try {
      await deps.issue(homeRoute);
    } catch {
      pauseWith(READ_GAVE_UP); // could not even ask — say the plain thing
      return;
    }
    pauseWith(READ_GAVE_UP_SENT_HOME);
  }

  /**
   * The runner's OWN faults stop the bot too — a decider that threw, an order the
   * world keeps refusing — and they must not leave the ship parked in space any
   * more than the decider's faults may (nav/scriptDecide `stopSafely`, same rule
   * and the same reason: four ships).
   *
   * So the first one LATCHES instead of pausing: the loop keeps ticking, the
   * decider sees the latch and flies the ship home, and the pause happens on
   * arrival carrying this reason. The flight issues different orders from the
   * one that was being refused, which is usually the whole problem.
   *
   * ⚠ ONLY ONCE. A second fault while already heading home means the way out is
   * failing too, and that is a real stop — otherwise a ship that cannot fly
   * anywhere would loop here forever, never pausing and never telling anyone.
   */
  function stopOrHeadHome(reason: string, result?: ReturnType<typeof decideScriptAction>): void {
    if (memory !== null && memory.latched === null) {
      memory = { ...memory, latched: { interruptID: null, reason } };
      emit({ ...last, status: "running", phase: "Heading home", why: reason, pauseReason: null });
      return;
    }
    pauseWith(reason, result);
  }

  function pauseWith(reason: string, result?: ReturnType<typeof decideScriptAction>): void {
    runToken += 1;
    status = "paused";
    // ⚠ THE REASON MUST SURVIVE THE RESULT. `toSnapshot` words the snapshot from
    // the DECIDER's tick, which knows nothing about a refusal the issue then
    // hit — so passing `result` alone would pause the run and show the cheerful
    // "Taking what's inside." that the decider had chosen. The reason is put
    // back on top, which is the whole point of pausing.
    emit(
      result !== undefined
        ? { ...toSnapshot(result, "paused", ledger.records()), why: reason, pauseReason: reason }
        : { ...last, status: "paused", why: reason, pauseReason: reason, phase: "Stopped" },
    );
    releaseAfterIssue();
  }

  async function run(): Promise<void> {
    const token = runToken;
    while (runToken === token && status === "running") {
      try {
        await tick();
      } catch (error) {
        // The backstop: tick() handles its own read/decide/issue failures, so
        // reaching here means something truly unexpected threw (a store push,
        // say). Pause with a reason rather than let `void run()` die silently.
        pauseWith(`${DECIDE_FAILED} (${String(error)})`);
        return;
      }
      if (runToken !== token || status !== "running") {
        break;
      }
      await deps.sleep(SCRIPT_CADENCE_MS);
    }
  }

  return {
    start(next: BotScript): void {
      if (issuePending) throw new Error("The previous script action is still awaiting its outcome.");
      if (uncertainAction) throw new Error("Verify the previous action's outcome, then Stop before starting a new run.");
      if (combatStopCustody) throw new Error("Combat Stop still owns unresolved settlement; reconcile Stop before restarting.");
      if (recoveryBlocked) throw new Error("Verify the preserved step's state, then Stop before starting a new run.");
      if (deps.mutationCustody?.()) throw new Error("Jettison mutation custody still owns unresolved work.");
      transportSuspended = false;
      releaseAfterIssue();
      runToken += 1;
      script = next;
      memory = deps.startup?.restoreMemory?.() ?? initialMemory(next);
      retainedProgress.clear();
      recoveryBlocked = false;
      // A fresh run id BEFORE the first emit, so every line of this run —
      // starting with its own header — is grouped under it. The header is also
      // what tells a store to rotate the previous run's log out.
      runID = deps.startup?.logicalRunID ?? newRunID(Date.now());
      actionInvocation = 0;
      loggedDecision = "";
      loggedEnd = false;
      record({ t: now(), kind: "start", run: runID, script: next.name, status: "running" });
      settle = 0;
      readFailures = 0;
      lastObs = null;
      // A new run does not inherit the last one's grudges.
      ledger = createRefusalLedger();
      status = "running";
      emit({ status: "running", phase: "Starting", why: null, stepPath: null, interruptID: null, pauseReason: null, note: null, refusals: [] });
    },
    pause(): void {
      if (status === "running") {
        runToken += 1;
        status = "paused";
        emit({ ...last, status: "paused" });
        // Pausing abandons the owned approach. Keep shutdown custody if the
        // off command is ambiguous; graceful Stop checks pending() again.
        void travelAssist?.requestStop();
        releaseAfterIssue();
      }
    },
    resume(): void {
      if (transportSuspended || issuePending || uncertainAction || combatStopCustody || deps.mutationCustody?.()) return;
      if (status === "paused") {
        transportSuspended = false;
        runToken += 1;
        status = "running";
        emit({ ...last, status: "running" });
      }
    },
    stop(): void {
      uncertainAction = null;
      recoveryBlocked = false;
      runToken += 1;
      status = "stopped";
      emit({ ...last, status: "stopped" });
      releaseAfterIssue();
    },
    beginGracefulStop(): Promise<void> {
      if (status === "running") {
        runToken += 1;
        status = "paused";
        emit({ ...last, status: "paused", phase: "Recalling drones", why: "Stopping after controlled drones return." });
      }
      return (activeTick ?? Promise.resolve()).then(async () => {
        await travelAssist?.requestStop();
        await releaseClaim();
      });
    },
    async settleCombatStop(deadlineMs: number): Promise<void> {
      if (status === "running" || activeTick !== null || memory === null) throw new Error("Combat decisions are not retired.");
      const token = runToken;
      combatStopCustody = true;
      issuePending = true;
      try {
        for (const [path, original] of Object.entries(memory.macroMem)) {
          if (!original.combatOwned) continue;
          let state = original;
          for (;;) {
            if (token !== runToken || Date.now() >= deadlineMs) throw new Error("Combat Stop lost generation or exceeded its settlement deadline.");
            const obs = await deps.observe({ activeMacro: "fight-with-drones", squadRole: "off", watchSquadRole: "off", board: memory.board });
            if (token !== runToken) throw new Error("Combat Stop generation changed during observation.");
            const result = settleCombat(obs, state);
            if (result.outcome.kind === "blocked") throw new Error(result.outcome.reason);
            if (result.outcome.kind === "done") break;
            // Preserve pending cleanup intent before dispatch: an uncertain response
            // must not make a later Stop replay the same module/drone/order mutation.
            const beforeCleanup = state;
            state = result.nextMem;
            memory = { ...memory, macroMem: { ...memory.macroMem, [path]: state } };
            if (result.action.kind !== "wait") {
              try { await deps.issue(result.action); }
              catch (error) {
                const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
                if (code === "CALL_REFUSED" && token === runToken) {
                  state = beforeCleanup;
                  memory = { ...memory, macroMem: { ...memory.macroMem, [path]: state } };
                }
                throw error;
              }
            }
            if (token !== runToken) throw new Error("Combat Stop generation changed during settlement.");
            await deps.sleep(SCRIPT_CADENCE_MS);
          }
          const macroMem: Record<string, import("./scriptDecide.ts").MacroMemory> = { ...memory.macroMem }; delete macroMem[path];
          memory = { ...memory, macroMem };
        }
        combatStopCustody = false;
      } finally { issuePending = false; }
    },
    combatDronesForStop(): readonly number[] | null {
      const states = Object.values(memory?.macroMem ?? {}).filter(state => state.combatOwned != null);
      return states.length === 0 ? null : [...new Set(states.flatMap(state =>
        (state.combatOwned as import("./combatOwnership.ts").CombatOwnership).drones))];
    },
    suspendTransport(): Promise<void> {
      transportSuspended = true;
      runToken += 1;
      status = "paused";
      emit({ ...last, status: "paused", phase: "Session recovery", why: "Waiting for current pilot authority." });
      return activeTick ?? Promise.resolve();
    },
    transportCustody(): boolean {
      return issuePending || uncertainAction !== null || combatStopCustody || claim !== null || travelAssist?.pending() === true || deps.mutationCustody?.() === true;
    },
    resumeTransport(): void {
      if (!transportSuspended || status !== "paused" || issuePending || uncertainAction || combatStopCustody || claim || travelAssist?.pending() || deps.mutationCustody?.())
        throw new Error("Transport recovery still owns unresolved work.");
      const progress = activeProgress();
      const unverified = progress.find(entry => !entry.recoverable);
      if (unverified) {
        recoveryBlocked = true;
        const reason = `Session recovered, but ${describeAction(unverified.action)} left step state that cannot be reset safely. Progress has been preserved. Verify it in the game, then Stop before restarting.`;
        emit({ ...last, status: "paused", phase: "Recovery needs verification", why: reason, pauseReason: reason });
        throw new Error(reason);
      }
      // Untouched steps can re-derive transient state. Confirmed progress stays
      // intact: clearing all memory would buy twice or reset a partial quantity.
      if (memory && progress.length === 0) memory = { ...memory, macroMem: {}, miningFlight: undefined, terminalDroneTicks: undefined };
      lastObs = null; settle = 0; readFailures = 0;
      transportSuspended = false; runToken += 1; status = "running";
      emit({ ...last, status: "running", phase: "Session recovered", why: null, pauseReason: null });
    },
    resumeHeadHome(reason: string): boolean {
      if (transportSuspended || status !== "paused" || memory === null || script === null || issuePending || uncertainAction || deps.mutationCustody?.()) return false;
      runToken += 1;
      if (memory.latched === null) memory = { ...memory, latched: { interruptID: null, reason } };
      status = "running";
      emit({ ...last, status: "running", phase: "Heading home", why: reason, pauseReason: null });
      return true;
    },
    headHome(reason: string): boolean {
      if (status !== "running" || memory === null) {
        return false;
      }
      // Unlike stopOrHeadHome, an existing latch is NOT a second fault here:
      // the ship is already on its way in, which is all this asks for.
      if (memory.latched === null) {
        memory = { ...memory, latched: { interruptID: null, reason } };
        emit({ ...last, status: "running", phase: "Heading home", why: reason, pauseReason: null });
      }
      return true;
    },
    tick,
    run,
    snapshot(): ScriptRunnerSnapshot {
      return last;
    },
    getStatus(): ScriptRunnerStatus {
      return status;
    },
    travelAssistPending: () => travelAssist?.pending() ?? false,
    confirmTravelAssistStopped: ids => travelAssist?.confirmStopped(ids),
  };
}

function toSnapshot(
  result: ReturnType<typeof decideScriptAction>,
  status: ScriptRunnerStatus,
  refusals: readonly RefusalRecord[] = [],
): ScriptRunnerSnapshot {
  return {
    status,
    phase: result.phase,
    why: result.why,
    stepPath: result.stepPath,
    interruptID: result.interruptID,
    pauseReason: result.pauseReason,
    note: describeBoard(result.memory.board),
    refusals,
  };
}
