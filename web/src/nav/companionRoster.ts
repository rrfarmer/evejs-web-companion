// THE FLEET COMPANIONS WINDOW'S OWN WORDS AND SUMS — pure, so they are testable
// without a DOM.
//
// The window is a roster: every pilot signed into this browser, plus every
// companion the SERVER is flying for this account. Two things about such a list
// are worth stating once rather than at each render — what a run's status is
// called, and what the list adds up to — and both are the kind of thing that
// quietly drifts when it lives inline in a component nobody can unit-test.
//
// ⚠ THIS IS NOT bots/pilotRoster.ts, AND IT MUST NOT GROW INTO IT. That module
// answers "what is flying this pilot's ship, and did the tab or the host start
// it" for the Bot Manager, where a run is a SCRIPT with a library row, a risk
// class and a runtime cap. A companion has none of those. The two lists look
// alike from a distance and are about different systems; merging them is how a
// fleet readout ended up inside a bot manager in the first place.

/**
 * What a companion's run state is called, in words a player can act on.
 *
 * ⚠ NEVER THE RAW STATE WORD (R9a), and "not running" is deliberately the
 * answer for both a companion that was never started and one that was stopped
 * cleanly. The finished run's own outcome is on the panel below; a roster row
 * restating it would be a second, staler version of the same sentence.
 */
export function companionStatusWords(status: string | null): string {
  if (status === "running") return "Running";
  if (status === "paused") return "Paused";
  if (status === "error") return "Stopped after a problem";
  return "Not running";
}

/**
 * The companions the SERVER is flying right now.
 *
 * ⚠ `endedAt`, NOT `status`. A finished run keeps being listed so its last
 * readout stays readable — bots/pilotRoster.ts's `serverBotFor` follows the
 * same rule for the same reason — so filtering on a status word would leave
 * yesterday's companion in a roster of who is flying.
 *
 * Structurally typed rather than taking `ServerBot`, so this module stays free
 * of the API layer and its decoders: what it needs is the two fields, and any
 * shape carrying them can be summed here.
 */
export function serverCompanions<T extends { readonly kind: string; readonly endedAt: string | null }>(
  bots: readonly T[],
): readonly T[] {
  return bots.filter((bot) => bot.kind === "companion" && bot.endedAt === null);
}

/** One row's contribution to the summary: is it flying, resting, or neither. */
export interface CompanionTally {
  readonly running: number;
  readonly paused: number;
  readonly idle: number;
}

/** Count a list of status words' worth of rows. */
export function tallyCompanions(statuses: readonly (string | null)[]): CompanionTally {
  let running = 0;
  let paused = 0;
  let idle = 0;
  for (const status of statuses) {
    if (status === "running") running += 1;
    else if (status === "paused") paused += 1;
    else idle += 1;
  }
  return { running, paused, idle };
}

/**
 * The one-line summary above the roster.
 *
 * ⚠ IT NEVER SAYS "0 RUNNING". A count of nothing is a number a player has to
 * read before they can dismiss it; the sentence that means the same thing is
 * shorter and lands faster. Paused is named separately from idle for the reason
 * `holdsTheShip` exists: a paused companion has not let go of the hull.
 *
 * ⚠ THE EMPTY SENTENCE IS ABOUT THE OP, NOT THE BROWSER. It used to read "No
 * pilots are signed in here", which was true when the window listed every
 * session automatically. The roster is now a list the player builds, so an
 * empty one means they have not added anybody — and telling somebody with four
 * pilots online that nobody is signed in is simply wrong.
 */
export function companionSummaryWords(tally: CompanionTally): string {
  const total = tally.running + tally.paused + tally.idle;
  if (total === 0) {
    return "No pilots in this op yet.";
  }
  if (tally.running === 0 && tally.paused === 0) {
    return "No pilot is flying as a companion.";
  }
  const parts: string[] = [];
  if (tally.running > 0) parts.push(`${tally.running} running`);
  if (tally.paused > 0) parts.push(`${tally.paused} paused`);
  if (tally.idle > 0) parts.push(`${tally.idle} idle`);
  return parts.join(", ");
}

/**
 * Whether a pilot is in a fleet, for the roster's own column.
 *
 * ⚠ TWO SOURCES, AND THE RUNNING ONE WINS. A companion that is flying reports
 * the fleet IT can see, which is the reading its own decisions are made on —
 * that is the answer worth showing about a run. An idle pilot has no companion
 * to ask, so the column falls back to the Fleet Center's availability, the same
 * read the panel's own checklist uses.
 *
 * ⚠ AND AN IDLE PILOT MUST NOT READ AS "no". Before anything has fetched a
 * roster the honest answer is "not known": `unavailable` means the read failed
 * and `unknown` means nobody has asked yet, and neither is a pilot who is out
 * of a fleet. Flattening either into a no is how a roster tells a player to go
 * join a fleet they are already in.
 */
export function inFleetFrom(
  availability: string | null,
  companionInFleet: boolean | null,
  companionHoldsTheShip: boolean,
): boolean | null {
  if (companionHoldsTheShip && companionInFleet !== null) {
    return companionInFleet;
  }
  if (availability === "ready") return true;
  if (availability === "not-in-fleet") return false;
  return null;
}

/**
 * The three columns that describe a RUN, blanked when there is no run.
 *
 * ⚠ THE SLICE OUTLIVES ITS RUN, AND A ROSTER THAT FORGETS THAT LIES QUIETLY.
 * A companion's store slice keeps its last readout after it stops, so a stopped
 * pilot went on reading "following its own judgement - can tag: no" across the
 * roster: three confident statements about a pilot that is doing nothing at
 * all, and "can tag: no" in particular reads as a standing fact about the pilot
 * rather than the last thing a finished run happened to see. Found by stopping
 * one and watching the row keep talking.
 *
 * ⚠ IN FLEET IS NOT IN HERE, deliberately. That column has a live source of its
 * own for an idle pilot (`inFleetFrom`, off the Fleet Center read), so blanking
 * it would throw away an answer that is still true.
 *
 * Paused counts as holding, by `holdsTheShip`'s rule: a paused companion has
 * not let go, and its last order is still the order it will act on when it
 * resumes.
 */
export interface CompanionRunFacts<T> {
  readonly followingOrderFrom: T | null;
  readonly lastOrderHeard: string | null;
  readonly targetMode: "called" | "all" | null;
  readonly canTag: boolean | null;
}

export function runFactsFor<T>(
  holding: boolean,
  facts: CompanionRunFacts<T> | null,
): CompanionRunFacts<T> {
  if (!holding || facts === null) {
    return { followingOrderFrom: null, lastOrderHeard: null, targetMode: null, canTag: null };
  }
  return {
    followingOrderFrom: facts.followingOrderFrom,
    lastOrderHeard: facts.lastOrderHeard,
    targetMode: facts.targetMode,
    canTag: facts.canTag,
  };
}

// --- Getting a companion back up --------------------------------------------
//
// ⚠ A COMPANION THAT WENT DOWN BY ITSELF COMES BACK BY ITSELF. Before this,
// every state but "running" was the operator's to leave: a read lost in a
// server stall, or a command whose answer the stall swallowed, parked the pilot
// until somebody noticed, opened its panel and pressed Start -- in the middle of
// the fight the stall happened in. The operator's rule is that their OWN Stop
// and Pause stay put; everything the companion did to itself is a condition to
// recover from, on a bound.
//
// Recoverable is exactly two things: "error" (a read or a decision failed) and
// a pause the run gave ITSELF (`selfPaused`). Never "stopped" -- that is the
// operator's Stop, another bot taking the ship, or one of the ladder's two
// deliberate endings (nobody came back in thirty minutes; nowhere safe to go),
// and each of those is an answer, not an accident.

/** The waits before each successive restart, from when the pilot went down. */
export const COMPANION_RESTART_DELAYS_MS: readonly number[] = [10_000, 20_000, 40_000, 80_000, 120_000];
/** Restarts counted against the bound only while they are this recent. */
export const COMPANION_RESTART_WINDOW_MS = 10 * 60_000;
/**
 * Restarts inside the window before the watch gives up and leaves it to the
 * operator. A companion that falls over five times in ten minutes is not having
 * a bad moment; it has a cause a restart will not fix.
 */
export const COMPANION_RESTART_LIMIT = 5;

export interface CompanionRestartMemory {
  /** When this pilot was first seen down in its current outage, or null while it is up. */
  readonly downSinceMs: number | null;
  /** When each recent restart was made, oldest first. */
  readonly restartsAtMs: readonly number[];
  /** What the last restart recovered from, in the run's own words. */
  readonly lastReason: string | null;
}

export const EMPTY_RESTART_MEMORY: CompanionRestartMemory = Object.freeze({
  downSinceMs: null,
  restartsAtMs: Object.freeze([]) as readonly number[],
  lastReason: null,
});

export interface CompanionRestartInput {
  readonly status: string | null;
  readonly selfPaused: boolean;
  readonly failureReason: string | null;
  readonly why: string | null;
}

export interface CompanionRestartDecision {
  readonly restart: boolean;
  /** Down, recoverable, and out of restarts: the operator has to look. */
  readonly givenUp: boolean;
  readonly memory: CompanionRestartMemory;
}

/** The wait before restart number `n` (0-based) inside the window. */
export function companionRestartDelayMs(n: number): number {
  const last = COMPANION_RESTART_DELAYS_MS.length - 1;
  return COMPANION_RESTART_DELAYS_MS[Math.max(0, Math.min(n, last))] ?? 0;
}

/** Did this run go down by itself, in a way a fresh start can recover? */
export function isRecoverableDown(status: string | null, selfPaused: boolean): boolean {
  return status === "error" || (status === "paused" && selfPaused);
}

export function decideCompanionRestart(
  input: CompanionRestartInput,
  memory: CompanionRestartMemory,
  nowMs: number,
): CompanionRestartDecision {
  const recent = memory.restartsAtMs.filter((at) => nowMs - at < COMPANION_RESTART_WINDOW_MS);
  if (!isRecoverableDown(input.status, input.selfPaused)) {
    return { restart: false, givenUp: false, memory: { ...memory, downSinceMs: null, restartsAtMs: recent } };
  }
  const downSinceMs = memory.downSinceMs ?? nowMs;
  if (recent.length >= COMPANION_RESTART_LIMIT) {
    return { restart: false, givenUp: true, memory: { ...memory, downSinceMs, restartsAtMs: recent } };
  }
  if (nowMs - downSinceMs < companionRestartDelayMs(recent.length)) {
    return { restart: false, givenUp: false, memory: { ...memory, downSinceMs, restartsAtMs: recent } };
  }
  return {
    restart: true,
    givenUp: false,
    memory: {
      downSinceMs: null,
      restartsAtMs: [...recent, nowMs],
      lastReason: input.failureReason ?? input.why ?? null,
    },
  };
}

/**
 * The roster's note about restarts, or null when there is nothing to say.
 *
 * ⚠ SAID EVEN WHEN IT WORKED. A pilot that was restarted three times in ten
 * minutes and is flying now is still a pilot whose server is struggling, and
 * the player should be able to see that without having watched it happen.
 */
export function companionRestartWords(
  memory: CompanionRestartMemory,
  givenUp: boolean,
  nowMs: number,
): string | null {
  const recent = memory.restartsAtMs.filter((at) => nowMs - at < COMPANION_RESTART_WINDOW_MS).length;
  if (givenUp) {
    return `Restarted ${recent} times in ten minutes and still stopping, so it is waiting for you.`;
  }
  if (recent === 0) return null;
  const times = recent === 1 ? "once" : `${recent} times`;
  return memory.lastReason
    ? `Restarted by itself ${times} in ten minutes, last after: ${memory.lastReason}`
    : `Restarted by itself ${times} in ten minutes.`;
}
