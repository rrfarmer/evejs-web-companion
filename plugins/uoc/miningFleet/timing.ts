import { existsSync } from "node:fs";
import path from "node:path";
import { bridgeCallQueueTimeout } from "../shared/progressDeadline.ts";
import { wrapRunFetch } from "../shared/runFetch.ts";

type Fields = Record<string, string | number | boolean | null | undefined>;
type Scope = {
  operationID: string;
  operationRunID: string;
  characterID: number;
  shipID: number;
  role: string;
};
type Command = "AddTarget" | "Jettison" | "Add" | "MultiAdd";
type Detail = "verbose" | "essential";

export function createPilotTiming(
  scope: Scope,
  write = (line: string) => console.log(line),
  verbose = true,
) {
  const last = new Map<string, string | number>();
  const samples = new Map<
    string,
    { nextAt: number; calls: number; totalMs: number; maxMs: number; errors: number }
  >();
  const note = (event: string, fields?: Fields) => {
    // Timing evidence must never affect the hosted run if the log sink fails.
    try {
      write(
        "[mcc-timing] " +
          JSON.stringify({ ...scope, at: new Date().toISOString(), event, ...fields }),
      );
    } catch {
      /* best-effort output */
    }
  };
  let passStartedAtMs: number | undefined,
    priorPassStartedAtMs: number | undefined,
    lastPassFinishedAtMs: number | undefined;
  let command:
    | {
        method: Command;
        targetID: Fields[string];
        containerID: Fields[string];
        admittedAtMs: number | null;
      }
    | undefined;
  return {
    verbose,
    note(event: string, fields?: Fields, detail: Detail = "verbose") {
      if (verbose || detail === "essential") note(event, fields);
    },
    change(
      event: string,
      value: string | number,
      fields?: Fields,
      key = event,
      detail: Detail = "verbose",
    ) {
      if ((!verbose && detail === "verbose") || last.get(key) === value) return;
      last.set(key, value);
      note(event, fields);
    },
    beginPass() {
      priorPassStartedAtMs = passStartedAtMs;
      passStartedAtMs = Date.now();
    },
    endPass() {
      lastPassFinishedAtMs = Date.now();
    },
    wrapFetch(send: typeof fetch): typeof fetch {
      return wrapRunFetch(send, (dispatch) => (input, init, priority) => {
        const active = command;
        if (
          active &&
          active.admittedAtMs === null &&
          typeof input === "string" &&
          input.endsWith("/api/bridge/call") &&
          init?.method === "POST" &&
          typeof init.body === "string"
        ) {
          // Farmer calls the supplied fetch only after admission to its request lane.
          try {
            const body = JSON.parse(init.body);
            if (
              body?.method === active.method &&
              (active.method === "AddTarget"
                ? body.service === "dogmaIM" && body.args?.[0] === active.targetID
                : active.method === "Jettison"
                  ? body.service === "ship"
                  : body.service === "invbroker" &&
                    body.of === scope.shipID &&
                    body.args?.[1] === active.containerID)
            ) {
              active.admittedAtMs = Date.now();
            }
          } catch {
            /* Ignore an unrelated request body. */
          }
        }
        return dispatch(input, init, priority);
      });
    },
    async command<T>(method: Command, fields: Fields, action: () => Promise<T>): Promise<T> {
      const pass = {
        passStartedAtMs,
        priorPassStartedAtMs,
        priorPassFinishedAtMs: lastPassFinishedAtMs,
      };
      const submittedAtMs = Date.now();
      const active = {
        method,
        targetID: fields.targetID,
        containerID: fields.containerID,
        admittedAtMs: null as number | null,
      };
      command = active;
      let outcome = "replied",
        code: string | undefined;
      try {
        return await action();
      } catch (error) {
        outcome = bridgeCallQueueTimeout(error) ? "queue-timeout" : "error";
        const value = (error as { code?: unknown } | null)?.code;
        if (typeof value === "string" && /^[a-z0-9_-]{1,80}$/i.test(value)) code = value;
        throw error;
      } finally {
        if (command === active) command = undefined;
        const { admittedAtMs } = active;
        note("command-timing", {
          command: method,
          ...pass,
          ...fields,
          submittedAtMs,
          admittedAtMs,
          transportWaitMs: admittedAtMs === null ? undefined : admittedAtMs - submittedAtMs,
          finishedAtMs: Date.now(),
          outcome,
          code,
        });
      }
    },
    async measure<T>(
      event: string,
      action: () => Promise<T>,
      fields?: Fields,
      sampleMs = 0,
      detail: Detail = "verbose",
    ): Promise<T> {
      if (!verbose && detail === "verbose") return action();
      const startedAtMs = Date.now(),
        start = performance.now();
      const record = (extra: Fields) => {
        const now = performance.now(),
          elapsedMs = Math.round(now - start);
        if (!sampleMs) return note(event, { ...fields, startedAtMs, elapsedMs, ...extra });
        const prior = samples.get(event) ?? {
          nextAt: 0,
          calls: 0,
          totalMs: 0,
          maxMs: 0,
          errors: 0,
        };
        prior.calls++;
        prior.totalMs += elapsedMs;
        prior.maxMs = Math.max(prior.maxMs, elapsedMs);
        if (extra.outcome === "error") prior.errors++;
        if (now >= prior.nextAt) {
          note(event, {
            ...fields,
            startedAtMs,
            elapsedMs,
            ...extra,
            calls: prior.calls,
            totalMs: prior.totalMs,
            maxMs: prior.maxMs,
            errors: prior.errors,
          });
          samples.set(event, { nextAt: now + sampleMs, calls: 0, totalMs: 0, maxMs: 0, errors: 0 });
        } else samples.set(event, prior);
      };
      try {
        const result = await action();
        record({ outcome: "returned" });
        return result;
      } catch (error) {
        const e = error as { code?: unknown; status?: unknown; refusal?: { key?: unknown } } | null;
        const code = (value: unknown) =>
          typeof value === "string" && /^[a-z0-9_-]{1,80}$/i.test(value) ? value : undefined;
        record({
          outcome: "error",
          code: code(e?.code),
          status: typeof e?.status === "number" ? e.status : undefined,
          refusal: code(e?.refusal?.key),
        });
        throw error;
      }
    },
  };
}

export type MccTiming = ReturnType<typeof createPilotTiming>;

export function timed<T>(
  timing: MccTiming | undefined,
  event: string,
  action: () => Promise<T>,
  fields?: Fields,
  sampleMs?: number,
  detail?: Detail,
): Promise<T> {
  return timing ? timing.measure(event, action, fields, sampleMs, detail) : action();
}

/** The plugin host passes only its own environment. Read the marker once per generation. */
export function mccTimingEnabled(): boolean {
  const dir = process.env.EVEJS_PLUGIN_DATA_DIR;
  return !!dir && existsSync(path.join(dir, "mcc-timing.enabled"));
}
