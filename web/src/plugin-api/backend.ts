// A plugin's backend: the part of a plugin the BFF runs, in a process of its own.
//
// The BFF forks the module a manifest names (`backend`) and talks to it over
// the process's message channel (src/pluginHost.js). This file is that
// channel's plugin side: a plugin calls `startBackend` once with its routes,
// and everything else - answering the watchdog, routing a request, turning a
// throw into a 500, deciding a block's next step for a hosted bot - is here.
//
// ⚠ A PROCESS OF ITS OWN, AND THAT IS THE POINT. A backend that throws, hangs
// or runs out of memory takes down itself, never the BFF: the BFF holds every
// pilot's connection, and a plugin holds none. A hung backend stops answering
// the watchdog and is killed and started again; its in-flight requests are
// answered 503 by the BFF.
//
// ⚠ IT SEES ONLY ITS OWN FOLDER. The BFF starts it under Node's permission
// model: it may read its plugin's folder, the plugin API and packages, and
// write only its data directory (`pluginDataDir`). The core database is out of
// reach. Node calls its model a seat belt for trusted code, not a sandbox
// against hostile code, and so does this file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PluginManifest } from "./index.ts";
import type { MacroStep } from "../bots/botScript.ts";
import type { PluginRunPolicy } from "../bots/runPolicy.ts";
import type { HeldPilot } from "../app/flow.ts";
import type { JsonValue } from "../bridge/wire.ts";
import type { ScriptObservation } from "../nav/scriptConditions.ts";
import type { MacroMemory, ScriptBoard } from "../nav/scriptDecide.ts";

/** The account a request was made as. The BFF checked the session; a plugin need not. */
export interface BackendAccount {
  readonly accountID: number;
  readonly username: string;
}

export interface BackendRequest {
  readonly method: string;
  /** The path under the plugin's own prefix: "/plans/7" for /api/plugins/<id>/plans/7. */
  readonly path: string;
  /** What the route's ":name" segments matched. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly account: BackendAccount;
}

export interface BackendResponse {
  /** 200 when absent. */
  readonly status?: number;
  readonly body: unknown;
}

export type BackendRoute = (request: BackendRequest) => BackendResponse | Promise<BackendResponse>;

/** What a plugin reads a run's setup as, and what running it risks. The setup comes from outside: this is its one gate. */
export type PluginRunCheck =
  | { readonly ok: true; readonly setup: JsonValue; readonly name: string; readonly policy: PluginRunPolicy }
  | { readonly ok: false; readonly refusal: string };

/** What a run is doing. Core shows it in the Bot Manager; `resumeData` comes back to `start` after a restart. */
export interface PluginRunReport {
  /** "stopped", "idle" or "error" is the run's end: core docks nothing, and logs the pilot off. */
  readonly status: "running" | "paused" | "idle" | "stopped" | "error";
  readonly phase?: string | null;
  readonly why?: string | null;
  readonly startError?: string | null;
  /** What this plugin's own windows show for the run. Core only carries it. */
  readonly readout?: JsonValue;
  /** What the plugin needs to carry on after a restart. Kept on disk; send it only when it changes. */
  readonly resumeData?: JsonValue;
}

/** A pilot core has selected and holds for this run. Its token and claim stay with core. */
export interface PluginRunContext {
  readonly botID: string;
  readonly characterID: number;
  readonly setup: JsonValue;
  /** True after a restart of this process or of the BFF: the pilot may be anywhere, and doing anything. */
  readonly resumed: boolean;
  readonly resumeData: JsonValue;
  readonly held: HeldPilot;
  /** How this pilot plans its routes, as its page set them. `createPilotSession` gives them to the flow. */
  readonly routeSettings: JsonValue;
  readonly baseUrl: string;
  /** The BFF, as this pilot's session. Core refuses a select, the session's end, and starting or stopping a bot. */
  readonly fetch: typeof fetch;
  report(report: PluginRunReport): void;
}

export interface PluginRunHandle {
  /** Stop the loop. Core then brings the drones home and logs the pilot off. */
  stop(): void | Promise<void>;
}

/** A kind of run this plugin flies: its own loop, on a pilot core holds for it. */
export interface BackendRun {
  check(setup: unknown): PluginRunCheck | Promise<PluginRunCheck>;
  start(run: PluginRunContext): PluginRunHandle | Promise<PluginRunHandle>;
}

export interface BackendDefinition {
  /** The plugin's manifest: its blocks are decided here for bots the BFF hosts. */
  readonly manifest: PluginManifest;
  /** "GET /plans", "POST /plans/:planID": a method, a space, and a path whose ":name" segments match anything. */
  readonly routes: Readonly<Record<string, BackendRoute>>;
  /** The kinds of run it flies (see docs/plugins.md, "A run"), by the name a start asks for. */
  readonly runs?: Readonly<Record<string, BackendRun>>;
  /**
   * Remove everything the plugin keeps, before it leaves the build. Required:
   * a plugin that cannot say how to clean up after itself is not finished.
   * What it leaves in its data directory the BFF deletes afterwards anyway.
   */
  readonly cleanup: () => void | Promise<void>;
  /**
   * Take over what core used to keep for this plugin, once (src/pluginHost.js
   * sends it at first start). Absent: core keeps nothing for it.
   */
  readonly adopt?: (records: unknown) => void | Promise<void>;
}

/** Where this plugin keeps its own data. The only place it may write. */
export function pluginDataDir(): string {
  const dir = process.env.EVEJS_PLUGIN_DATA_DIR;
  if (!dir) throw new Error("This backend was not started by the BFF's plugin host.");
  return dir;
}

/**
 * A JSON document in the plugin's data directory, written whole and atomically
 * (to a temporary file, then renamed over), so a crash mid-write leaves the
 * last good copy.
 */
export function jsonStore<T>(name: string): { read(): T | null; write(value: T): void } {
  const file = path.join(pluginDataDir(), name);
  return {
    read() {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as T;
      } catch {
        return null;
      }
    },
    write(value) {
      mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(value));
      renameSync(temporary, file);
    },
  };
}

// ─── The channel ─────────────────────────────────────────────────────────────

type Incoming =
  | { readonly type: "ping"; readonly id: number }
  | { readonly type: "request"; readonly id: number; readonly method: string; readonly path: string; readonly query: Record<string, string>; readonly body: unknown; readonly account: BackendAccount }
  | { readonly type: "decide"; readonly id: number; readonly macro: string; readonly step: MacroStep; readonly obs: ScriptObservation; readonly mem: MacroMemory; readonly board: ScriptBoard }
  | { readonly type: "cleanup"; readonly id: number }
  | { readonly type: "adopt"; readonly id: number; readonly records: unknown }
  | { readonly type: "runCheck"; readonly id: number; readonly run: string; readonly setup: unknown }
  | { readonly type: "runStart"; readonly id: number; readonly spec: RunSpec }
  | { readonly type: "runStop"; readonly id: number; readonly botID: string }
  | RunFetchAnswer;

interface RunSpec {
  readonly botID: string;
  readonly run: string;
  readonly characterID: number;
  readonly setup: JsonValue;
  readonly resumed: boolean;
  readonly resumeData: JsonValue;
  readonly held: HeldPilot;
  readonly routeSettings: JsonValue;
  readonly baseUrl: string;
}

type RunFetchAnswer =
  | { readonly type: "runFetchAnswer"; readonly part: "head"; readonly id: number; readonly status: number; readonly headers: Record<string, string> }
  | { readonly type: "runFetchAnswer"; readonly part: "chunk"; readonly id: number; readonly data: Uint8Array }
  | { readonly type: "runFetchAnswer"; readonly part: "end"; readonly id: number }
  | { readonly type: "runFetchAnswer"; readonly part: "error"; readonly id: number; readonly message: string };

// ─── A run's requests, over the channel ──────────────────────────────────────

interface FetchInFlight {
  readonly resolve: (response: Response) => void;
  readonly reject: (error: unknown) => void;
  body: ReadableStreamDefaultController<Uint8Array> | null;
}

const fetchesInFlight = new Map<number, FetchInFlight>();
let nextFetchID = 1;

function answerFetch(answer: RunFetchAnswer): void {
  const call = fetchesInFlight.get(answer.id);
  if (call === undefined) return;
  switch (answer.part) {
    case "head": {
      const empty = answer.status === 204 || answer.status === 205 || answer.status === 304;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { call.body = controller; },
        cancel() { send({ type: "runFetchAbort", id: answer.id }); fetchesInFlight.delete(answer.id); },
      });
      call.resolve(new Response(empty ? null : body, { status: answer.status, headers: answer.headers }));
      return;
    }
    case "chunk":
      call.body?.enqueue(new Uint8Array(answer.data));
      return;
    case "end":
      try { call.body?.close(); } catch { /* given up on */ }
      fetchesInFlight.delete(answer.id);
      return;
    case "error":
      if (call.body !== null) { try { call.body.error(new Error(answer.message)); } catch { /* given up on */ } }
      else call.reject(new TypeError("fetch failed", { cause: answer.message }));
      fetchesInFlight.delete(answer.id);
      return;
  }
}

/** `fetch`'s own shape, so a flow cannot tell: each request goes to core over the channel, as this run. */
function runFetch(botID: string): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    // A Request carries what `init` otherwise would, and `init` wins, as in fetch.
    const given = input instanceof Request ? input : null;
    const url = given?.url ?? String(input);
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? given?.headers ?? {}).forEach((value, name) => { headers[name] = value; });
    const method = init.method ?? given?.method ?? "GET";
    const redirect = init.redirect ?? given?.redirect;
    const body = init.body !== undefined ? init.body : given?.body ? await given.text() : undefined;
    const id = nextFetchID++;
    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal ?? given?.signal;
      if (signal?.aborted) { reject(signal.reason); return; }
      signal?.addEventListener("abort", () => {
        const call = fetchesInFlight.get(id);
        send({ type: "runFetchAbort", id });
        if (call?.body) { try { call.body.error(signal.reason); } catch { /* given up on */ } }
        else reject(signal.reason);
        fetchesInFlight.delete(id);
      }, { once: true });
      fetchesInFlight.set(id, { resolve, reject, body: null });
      send({ type: "runFetch", id, botID, url, method, headers, body, redirect });
    });
  }) as typeof fetch;
}

interface CompiledRoute {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handle: BackendRoute;
}

function compile(routes: Readonly<Record<string, BackendRoute>>): CompiledRoute[] {
  return Object.entries(routes).map(([key, handle]) => {
    const [method, route] = key.split(" ");
    if (!method || !route) throw new Error(`"${key}" is not a route: write "GET /path".`);
    return { method: method.toUpperCase(), segments: route.split("/").filter(Boolean), handle };
  });
}

/** The route that matches, and what its ":name" segments matched; null when none does. */
export function matchRoute(
  routes: readonly CompiledRoute[],
  method: string,
  requestPath: string,
): { route: CompiledRoute; params: Record<string, string> } | null {
  const parts = requestPath.split("/").filter(Boolean);
  for (const route of routes) {
    if (route.method !== method.toUpperCase() || route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const fits = route.segments.every((segment, index) => {
      if (segment.startsWith(":")) {
        params[segment.slice(1)] = decodeURIComponent(parts[index]!);
        return true;
      }
      return segment === parts[index];
    });
    if (fits) return { route, params };
  }
  return null;
}

function send(message: unknown): void {
  process.send?.(message);
}

function errorWords(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "The plugin failed.";
}

/** Start answering the BFF. Call once, at the top of the backend module. */
export function startBackend(definition: BackendDefinition): void {
  if (typeof process.send !== "function") throw new Error("This backend was not started by the BFF's plugin host.");
  const routes = compile(definition.routes);
  const deciders = new Map((definition.manifest.macros ?? []).map((macro) => [macro.id as string, macro.decide]));
  const runsFlying = new Map<string, Promise<PluginRunHandle>>();
  process.on("message", (raw: Incoming) => {
    void (async () => {
      switch (raw.type) {
        case "ping":
          send({ type: "pong", id: raw.id });
          return;
        case "request": {
          const found = matchRoute(routes, raw.method, raw.path);
          if (found === null) {
            send({ type: "response", id: raw.id, status: 404, body: { ok: false, error: "NOT_FOUND", message: "This plugin has no such route." } });
            return;
          }
          try {
            const answer = await found.route.handle({
              method: raw.method,
              path: raw.path,
              params: found.params,
              query: raw.query,
              body: raw.body,
              account: raw.account,
            });
            send({ type: "response", id: raw.id, status: answer.status ?? 200, body: answer.body });
          } catch (error) {
            send({ type: "response", id: raw.id, status: 500, body: { ok: false, error: "PLUGIN_ERROR", message: errorWords(error) } });
          }
          return;
        }
        case "decide": {
          const decide = deciders.get(raw.macro);
          try {
            if (decide === undefined) throw new Error(`This plugin has no block called "${raw.macro}".`);
            send({ type: "decided", id: raw.id, tick: decide(raw.step, raw.obs, raw.mem, raw.board) });
          } catch (error) {
            send({ type: "decided", id: raw.id, error: errorWords(error) });
          }
          return;
        }
        case "cleanup":
          try {
            await definition.cleanup();
            send({ type: "done", id: raw.id });
          } catch (error) {
            send({ type: "done", id: raw.id, error: errorWords(error) });
          }
          return;
        case "adopt":
          try {
            await definition.adopt?.(raw.records);
            send({ type: "done", id: raw.id });
          } catch (error) {
            send({ type: "done", id: raw.id, error: errorWords(error) });
          }
          return;
        case "runFetchAnswer":
          answerFetch(raw);
          return;
        case "runCheck": {
          try {
            const run = definition.runs?.[raw.run];
            if (run === undefined) throw new Error(`This plugin has no run called "${raw.run}".`);
            send({ ...(await run.check(raw.setup)), type: "runChecked", id: raw.id });
          } catch (error) {
            send({ type: "runChecked", id: raw.id, ok: false, refusal: errorWords(error) });
          }
          return;
        }
        case "runStart": {
          const { spec } = raw;
          try {
            const run = definition.runs?.[spec.run];
            if (run === undefined) throw new Error(`This plugin has no run called "${spec.run}".`);
            if (!runsFlying.has(spec.botID)) {
              const flying = Promise.resolve(run.start({
                botID: spec.botID,
                characterID: spec.characterID,
                setup: spec.setup,
                resumed: spec.resumed,
                resumeData: spec.resumeData,
                held: spec.held,
                routeSettings: spec.routeSettings ?? {},
                baseUrl: spec.baseUrl,
                fetch: runFetch(spec.botID),
                report: (report) => send({ type: "runReport", botID: spec.botID, report }),
              }));
              runsFlying.set(spec.botID, flying);
              flying.catch(() => runsFlying.delete(spec.botID));
            }
            await runsFlying.get(spec.botID);
            send({ type: "done", id: raw.id });
          } catch (error) {
            send({ type: "done", id: raw.id, error: errorWords(error) });
          }
          return;
        }
        case "runStop": {
          const flying = runsFlying.get(raw.botID);
          runsFlying.delete(raw.botID);
          try {
            await (await flying)?.stop();
            send({ type: "done", id: raw.id });
          } catch (error) {
            send({ type: "done", id: raw.id, error: errorWords(error) });
          }
          return;
        }
      }
    })();
  });
  send({ type: "ready" });
}
