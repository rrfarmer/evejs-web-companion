// The fleet companion's flight recorder: the same per-character log the script
// runner writes (nav/botLog.ts, `data/bot-logs/<characterID>.jsonl` on the
// BFF), fed from the companion loop's own seams.
//
// WHY THIS EXISTS. "It takes seconds to switch to the next rat" could only be
// answered from the game server's log on 2026-10-12, which names calls by bound
// object and never says which pilot or which target -- the companion computed
// every decision and threw it away. With this, each pilot's log says what it
// decided, what it sent, how long its reads and its call took, and what came
// back, with a timestamp on every line.
//
// ⚠ THE SAME FOUR RULES AS botLog.ts, with one difference. The action is
// logged verbatim (rule 1) and the recorder never breaks the run (rule 4: every
// write is wrapped here, not by the caller). But `describeCompanionAction` is
// GENERIC rather than an exhaustive switch: the companion's action union grows
// on several branches at once, and an exhaustive switch here would turn every
// one of them into a compile error at merge time. Its line is the kind plus the
// action's own fields, which says everything the verbatim action does.
//
// ⚠ IT WRITES ON CHANGE, NOT ON EVERY TICK. A companion ticks every 0.35-2 s;
// a `decide` line is written only when the status, phase, sentence or the
// trace's CODES change (`coarseTraceKey`: never the metres, which move every
// tick). Every call it sends gets an `issue` and a `result` line regardless, and
// a tick that sends one always writes its `decide` line too (`force`), so the
// three lines of one `seq` are always all there.
//
// ⚠ AND A HEARTBEAT WHEN NOTHING CHANGES. A running pilot that has written no
// `decide` line for `COMPANION_LOG_HEARTBEAT_MS` writes the same one again with
// `heartbeat: true`, so a pilot waiting on something reads as waiting and not
// as a hole in the log.

import type { BotLogDraft, BotLogSink } from "./botLog.ts";
import { newRunID } from "./botLog.ts";
import { coarseTraceKey } from "./companionTrace.ts";
import type { FleetCompanionAction, FleetCompanionProgress } from "./fleetCompanionLoop.ts";

/** How long a running pilot may go without a `decide` line before it writes a heartbeat. */
export const COMPANION_LOG_HEARTBEAT_MS = 30_000;

/** How the ladder classed a failed call (the controller's settle functions act on the same). */
export type CompanionCallVerdict = "refused" | "uncertain" | "deferred";

/** One line for an action: its kind, then each field as `name=value`. */
export function describeCompanionAction(action: FleetCompanionAction): string {
  const fields = Object.entries(action)
    .filter(([name]) => name !== "kind")
    .map(([name, value]) => `${name}=${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`);
  return fields.length === 0 ? action.kind : `${action.kind} ${fields.join(" ")}`;
}

export interface CompanionRecorder {
  /** A run began: mint its id and write the `start` line. */
  start(): void;
  /** The tick's reads took `ms`; carried on the next `issue` line. */
  observed(ms: number): void;
  /**
   * The readout changed (or may have): a `decide` line when it did, or when
   * `force` says this tick issues, or as a heartbeat; `end` when the run did.
   * `seq` is the controller's tick number, written on the line.
   */
  progress(progress: FleetCompanionProgress, tick?: { readonly seq?: number; readonly force?: boolean }): void;
  /** About to send `action`. Written BEFORE the call, like the runner's. */
  issue(action: FleetCompanionAction, phase: string | null, why: string | null, seq?: number): void;
  /** How that call came back, how long it took, and (failed) how the ladder classed it. */
  result(ok: boolean, error?: unknown, tick?: { readonly seq?: number; readonly verdict?: CompanionCallVerdict }): void;
}

const TERMINAL = new Set(["stopped", "error"]);

/**
 * The recorder over `sink`. A null sink records nothing and costs nothing, so a
 * test or a host without a log needs no stub.
 */
export function createCompanionRecorder(
  sink: BotLogSink | null | undefined,
  now: () => number = Date.now,
): CompanionRecorder {
  let run: string | null = null;
  let lastKey: string | null = null;
  let lastStatus: string | null = null;
  let observeMs: number | null = null;
  let issued: { says: string; atMs: number } | null = null;
  /** When the last `decide` line was written, for the heartbeat. */
  let lastDecideAtMs: number | null = null;

  function write(draft: Omit<BotLogDraft, "t" | "run">): void {
    if (!sink || run === null) return;
    try {
      sink.write({ t: new Date(now()).toISOString(), run, ...draft } as BotLogDraft);
    } catch {
      // Rule 4: a recorder that cannot write loses lines, never a ship.
    }
  }

  return {
    start(): void {
      run = newRunID(now());
      lastKey = null;
      lastStatus = null;
      observeMs = null;
      issued = null;
      lastDecideAtMs = null;
      write({ kind: "start", script: "fleet companion" });
    },
    observed(ms: number): void {
      observeMs = ms;
    },
    progress(progress: FleetCompanionProgress, tick?: { readonly seq?: number; readonly force?: boolean }): void {
      const key = `${progress.status}|${progress.phase ?? ""}|${progress.why ?? ""}|${coarseTraceKey(progress.trace)}`;
      const nowMs = now();
      const heartbeat = key === lastKey && tick?.force !== true && progress.status === "running" &&
        lastDecideAtMs !== null && nowMs - lastDecideAtMs >= COMPANION_LOG_HEARTBEAT_MS;
      if (key !== lastKey || tick?.force === true || heartbeat) {
        lastKey = key;
        lastDecideAtMs = nowMs;
        write({
          kind: "decide",
          ...(tick?.seq === undefined ? {} : { seq: tick.seq }),
          status: progress.status,
          phase: progress.phase,
          why: progress.why,
          reason: progress.failureReason,
          ...(progress.trace === undefined ? {} : { trace: progress.trace }),
          ...(heartbeat ? { heartbeat: true } : {}),
        });
      }
      if (progress.status !== lastStatus) {
        if (TERMINAL.has(progress.status) && lastStatus !== null && !TERMINAL.has(lastStatus)) {
          write({ kind: "end", status: progress.status, reason: progress.failureReason });
        }
        lastStatus = progress.status;
      }
    },
    issue(action: FleetCompanionAction, phase: string | null, why: string | null, seq?: number): void {
      const says = describeCompanionAction(action);
      issued = { says, atMs: now() };
      write({
        kind: "issue",
        ...(seq === undefined ? {} : { seq }),
        action,
        says,
        phase,
        why,
        ...(observeMs === null ? {} : { observeMs }),
      });
    },
    result(ok: boolean, error?: unknown, tick?: { readonly seq?: number; readonly verdict?: CompanionCallVerdict }): void {
      const call = issued;
      issued = null;
      write({
        kind: "result",
        ...(tick?.seq === undefined ? {} : { seq: tick.seq }),
        ok,
        says: call?.says,
        ...(call === null ? {} : { callMs: now() - call.atMs }),
        ...(ok ? {} : { refusal: error instanceof Error ? error.message : String(error) }),
        ...(ok || tick?.verdict === undefined ? {} : { verdict: tick.verdict }),
      });
    },
  };
}
