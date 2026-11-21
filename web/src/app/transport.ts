// The client's request lane: a concurrency cap, and evidence when it fails
// (goal R92).
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// A browser opens about SIX connections per origin over HTTP/1.1 and shares
// them across everything the tab does. Exceeding that does not fail loudly — it
// QUEUES, silently, inside the browser, where this code cannot see it. A queued
// request looks exactly like a slow one from the outside, with one cruel
// difference: the server never receives it, so nothing appears in any log, and
// `AbortSignal.timeout()` counts the queued time and eventually reports a
// timeout against a server that was never asked anything.
//
// That is the failure this module is built around. `skipWhileBusy` removed the
// known cause (five pollers stacking up on a slow server); this is the
// structural guarantee, so the next burst of requests — a bot loop, a panel
// opened during a stall, code not written yet — cannot recreate it.
//
// TWO JOBS, and they are the same bookkeeping:
//
//   1. CAP OUR OWN CONCURRENCY BELOW THE BROWSER'S. If we never have more than
//      MAX_IN_FLIGHT requests outstanding, the browser never has to queue one,
//      so we always know what is happening to every request we made.
//   2. SAY WHAT ACTUALLY HAPPENED WHEN ONE FAILS. Because the queue is ours, we
//      know whether a failed request waited for a connection or was sent and
//      ignored — the single most useful fact about a transport failure, and the
//      one no field report has ever contained.
//
// ⚠ PRIORITY IS NOT A NICETY. Without it, a click waits behind whatever polls
// happen to be in the lane. The player's own action is the one request whose
// latency they can feel, so it goes first, always.

/** What kind of request this is. Lower sorts first. */
export type RequestPriority = "user" | "read" | "poll";

const PRIORITY_ORDER: Record<RequestPriority, number> = { user: 0, read: 1, poll: 2 };

/**
 * How many requests we allow to be outstanding at once.
 *
 * ⚠ FOUR, NOT SIX. The browser's ~6 per-origin budget is not ours alone: the
 * live event stream (EventSource, `/api/bridge/events`) pins one for its entire
 * life, and the page still has to fetch its own assets, icons and portraits.
 * Sitting at the limit would mean the FIRST thing to exceed it is something we
 * do not control and cannot see queue. Four leaves the margin deliberately.
 */
export const MAX_IN_FLIGHT = 4;

/**
 * The longest a request may wait for a free lane before we give up on it.
 *
 * ⚠ SEPARATE FROM THE REQUEST DEADLINE, AND SHORTER, ON PURPOSE. They are
 * different failures with different fixes: "the server did not answer" is the
 * server's problem, "we could not get a connection for twenty seconds" is ours.
 * Collapsing them into one number is how the original report came to say
 * "timed out" about a request that never left the browser.
 */
export const QUEUE_DEADLINE_MS = 20_000;

/**
 * How long a request has to be outstanding before it counts as evidence that
 * the lane is jammed rather than merely busy. A healthy read is tens of
 * milliseconds; anything still open after five seconds is stuck on something.
 */
const STUCK_MS = 5_000;

export interface TransportDiagnosis {
  /** How many requests were outstanding, including the one that failed. */
  readonly inFlight: number;
  /** How many were still queued, waiting for a lane. */
  readonly queued: number;
  /** Age of the longest outstanding request, in ms. */
  readonly oldestOutstandingMs: number;
  /**
   * Plain language, written to be READ BY A PLAYER IN A BUG REPORT. This is the
   * whole point of the module: a screenshot of this sentence is worth more than
   * the stack trace it replaces.
   */
  readonly verdict: string;
}

export interface TransportLane {
  /**
   * Run `task` when a lane is free. The task's own clock — its deadline
   * included — should start inside it, NOT when this is called, or a request
   * that waited for a lane arrives at the server with its budget already spent.
   */
  run<T>(priority: RequestPriority, path: string, task: () => Promise<T>, how?: RunHow): Promise<T>;
  /** What the lane looked like at `nowMs`. */
  diagnose(nowMs?: number): TransportDiagnosis;
  /** In-flight count, for tests and diagnostics. */
  inFlight(): number;
  /** Queued (not yet started) count. */
  queued(): number;
  /** Outstanding requests that hold no lane, because they use none of the browser's connections. */
  carried(): number;
}

/**
 * How a request is to be run.
 *
 * `carried`: the request uses the tab's open socket or dispatches inside the BFF. It starts at once and
 * uses none of the browser's HTTP connections. It is still counted and has its own deadline inside the task.
 */
export interface RunHow {
  readonly carried?: boolean;
}

/** Thrown when a request never got a lane. Distinct so callers can word it. */
export class TransportQueueError extends Error {
  readonly diagnosis: TransportDiagnosis;
  constructor(path: string, waitedMs: number, diagnosis: TransportDiagnosis) {
    super(
      `${path} never got a connection: it waited ${Math.round(waitedMs / 1000)}s ` +
        `for one of the browser's ${MAX_IN_FLIGHT} request lanes. ${diagnosis.verdict}`,
    );
    this.name = "TransportQueueError";
    this.diagnosis = diagnosis;
  }
}

interface Waiting {
  readonly priority: RequestPriority;
  readonly path: string;
  readonly queuedAtMs: number;
  readonly start: () => void;
  readonly giveUp: () => void;
  timer: unknown;
}

export interface TransportLaneDeps {
  readonly maxInFlight?: number;
  readonly queueDeadlineMs?: number;
  readonly now?: () => number;
  readonly setTimeout?: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

export function createTransportLane(deps: TransportLaneDeps = {}): TransportLane {
  const limit = deps.maxInFlight ?? MAX_IN_FLIGHT;
  const queueDeadlineMs = deps.queueDeadlineMs ?? QUEUE_DEADLINE_MS;
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimer =
    deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  /** Started, not yet settled: path -> when it started. */
  const running = new Map<symbol, { path: string; startedAtMs: number }>();
  /** Outstanding requests that use no HTTP lane. */
  let carrying = 0;
  const waiting: Waiting[] = [];

  function diagnose(atMs?: number): TransportDiagnosis {
    const nowMs = atMs ?? now();
    let oldest = 0;
    for (const entry of running.values()) {
      oldest = Math.max(oldest, nowMs - entry.startedAtMs);
    }
    const inFlight = running.size;
    const queued = waiting.length;
    let verdict: string;
    if (inFlight >= limit && oldest >= STUCK_MS) {
      // ⚠ The state the field reports were made in. Say so explicitly: the
      // request that failed is a bystander, and looking at what it asked for
      // will not explain anything.
      verdict =
        `All ${limit} request lanes were busy and the oldest had been waiting ` +
        `${Math.round(oldest / 1000)}s, so the server is not answering. Requests ` +
        `made during this are held up behind that, whatever they asked for.`;
    } else if (oldest >= STUCK_MS) {
      verdict =
        `${inFlight} request(s) were outstanding and the oldest had been waiting ` +
        `${Math.round(oldest / 1000)}s — the server is answering slowly or not at all.`;
    } else if (inFlight >= limit) {
      verdict = `All ${limit} request lanes were busy, but each was moving — the client is simply asking for a lot at once.`;
    } else {
      verdict = `${inFlight} request(s) were outstanding and none were stuck, so the connection itself failed rather than the server being busy.`;
    }
    return { inFlight, queued, oldestOutstandingMs: oldest, verdict };
  }

  function pump(): void {
    while (running.size < limit && waiting.length > 0) {
      // Stable within a priority: the queue is built in arrival order and this
      // picks the first of the best priority, so equal work stays FIFO.
      let best = 0;
      for (let index = 1; index < waiting.length; index += 1) {
        const candidate = waiting[index];
        const incumbent = waiting[best];
        if (
          candidate &&
          incumbent &&
          PRIORITY_ORDER[candidate.priority] < PRIORITY_ORDER[incumbent.priority]
        ) {
          best = index;
        }
      }
      const next = waiting.splice(best, 1)[0];
      if (!next) {
        return;
      }
      if (next.timer !== null) {
        clearTimer(next.timer);
      }
      next.start();
    }
  }

  /** Hold a lane for the length of `task`, then hand it on. */
  async function occupy<T>(ticket: symbol, task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } finally {
      running.delete(ticket);
      pump();
    }
  }

  function run<T>(priority: RequestPriority, path: string, task: () => Promise<T>, how: RunHow = {}): Promise<T> {
    if (how.carried === true) {
      // No lane to take and none to hand on: started in this tick, like a request that found a lane free.
      carrying += 1;
      let started: Promise<T>;
      try {
        started = task();
      } catch (cause) {
        carrying -= 1;
        return Promise.reject(cause);
      }
      return started.finally(() => {
        carrying -= 1;
      });
    }
    const queuedAtMs = now();
    const ticket = Symbol(path);

    // ⚠ THE FREE LANE IS TAKEN SYNCHRONOUSLY, IN THIS TICK. Going through the
    // queue unconditionally would be simpler, but it would put a microtask
    // between every call and its own `fetch` — so a caller that fires a request
    // without awaiting it would no longer have started one when it returns.
    // That is a behaviour change for the whole client in the common case, in
    // exchange for nothing: when a lane is free there is nothing to wait for.
    if (running.size < limit && waiting.length === 0) {
      running.set(ticket, { path, startedAtMs: queuedAtMs });
      try {
        return occupy(ticket, task);
      } catch (cause) {
        // A task that threw synchronously never became a promise; the lane must
        // still come back.
        running.delete(ticket);
        pump();
        return Promise.reject(cause);
      }
    }

    return queueThenRun(priority, path, task, ticket, queuedAtMs);
  }

  async function queueThenRun<T>(
    priority: RequestPriority,
    path: string,
    task: () => Promise<T>,
    ticket: symbol,
    queuedAtMs: number,
  ): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      const entry: Waiting = {
        priority,
        path,
        queuedAtMs,
        // ⚠ THE LANE IS TAKEN HERE, SYNCHRONOUSLY — not after the `await` below
        // settles. Resolving a promise only schedules a microtask, so several
        // callers in the same tick would all look at an empty `running` map,
        // all decide a lane was free, and all start: a cap that holds only when
        // requests happen to be spaced out is not a cap at all.
        start: () => {
          running.set(ticket, { path, startedAtMs: now() });
          resolve();
        },
        giveUp: () => {
          const index = waiting.indexOf(entry);
          if (index >= 0) {
            waiting.splice(index, 1);
          }
          reject(new TransportQueueError(path, now() - queuedAtMs, diagnose()));
        },
        timer: null,
      };
      waiting.push(entry);
      pump();
      if (waiting.includes(entry)) {
        // Still queued, so it can starve: arm the give-up timer. A request that
        // got a lane immediately never arms one at all.
        entry.timer = setTimer(() => entry.giveUp(), queueDeadlineMs);
      }
    });

    return occupy(ticket, task);
  }

  return {
    run,
    diagnose,
    inFlight: () => running.size,
    queued: () => waiting.length,
    carried: () => carrying,
  };
}

/**
 * The lane every BFF request in this client shares.
 *
 * ⚠ ONE PER TAB, NOT ONE PER SESSION. The browser's connection budget is
 * per-ORIGIN, so a multibox roster of pilots is still drawing on the same six
 * sockets. A lane per session would cap each pilot at four and the tab at
 * four-times-the-roster, which is the exact problem this exists to prevent.
 */
export const bridgeLane: TransportLane = createTransportLane();
