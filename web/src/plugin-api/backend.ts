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

export interface BackendDefinition {
  /** The plugin's manifest: its blocks are decided here for bots the BFF hosts. */
  readonly manifest: PluginManifest;
  /** "GET /plans", "POST /plans/:planID": a method, a space, and a path whose ":name" segments match anything. */
  readonly routes: Readonly<Record<string, BackendRoute>>;
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
  | { readonly type: "adopt"; readonly id: number; readonly records: unknown };

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
      }
    })();
  });
  send({ type: "ready" });
}
