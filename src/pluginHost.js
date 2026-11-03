"use strict";

// ── The plugin host: every plugin backend in a process of its own ────────────
//
// A plugin's backend (its manifest's `backend`, plugins/<id>/...) is forked as
// a child process and spoken to over its message channel (the plugin side is
// web/src/plugin-api/backend.ts). The BFF forwards the plugin's routes to it
// (/api/plugins/<id>/...), asks it a block's next step for a bot it hosts,
// and watches it.
//
// ⚠ A FAILED PLUGIN FAILS ONLY ITSELF. The BFF holds every pilot's connection
// and a plugin holds none, so a backend that throws, hangs or dies costs its
// own requests and nothing else:
//   - a request it does not answer in time is answered 504; one in flight when
//     it dies is answered 503;
//   - it is pinged every PING_MS and killed when a ping goes unanswered for
//     PING_MS, which is how a hung event loop is caught;
//   - a backend that exits is started again after a backoff, and one that has
//     failed MAX_FAILURES times in FAILURE_WINDOW_MS stays stopped, with its
//     last error, until the BFF restarts.
//
// ⚠ IT SEES ONLY ITS OWN FOLDER. Each backend runs under Node's permission
// model: it may read its plugin's folder, the web sources (the plugin API and
// what its blocks are built from) and node_modules, and write only
// data/plugins/<id>. The core database is out of reach. Node calls the model a
// seat belt for trusted code, not a sandbox against hostile code.

const { fork } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PING_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DECIDE_TIMEOUT_MS = 2_000;
const BACKOFF_MS = [1_000, 5_000, 30_000];
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 10 * 60_000;

function createPluginHost(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, "..");
  const dataDir = options.dataDir || path.join(rootDir, "data");
  const permission = options.permission !== false;
  const log = options.log || ((line) => console.log(`[plugins] ${line}`));
  const forkProcess = options.fork || fork;
  // The clocks, shortened by the tests that kill and restart backends on purpose.
  const pingMs = options.pingMs || PING_MS;
  const requestTimeoutMs = options.requestTimeoutMs || REQUEST_TIMEOUT_MS;
  const decideTimeoutMs = options.decideTimeoutMs || DECIDE_TIMEOUT_MS;
  const backoffMs = options.backoffMs || BACKOFF_MS;
  /** id -> the backend's state */
  const backends = new Map();
  let nextMessageID = 1;
  let stopping = false;

  async function loadManifests() {
    if (options.manifests) return options.manifests;
    const list = await import(pathToFileURL(path.join(rootDir, "plugins", "index.ts")).href);
    return Array.isArray(list.PLUGINS) ? list.PLUGINS : [];
  }

  function status(entry) {
    return { id: entry.id, state: entry.state, restarts: entry.restarts, error: entry.error };
  }

  function failPending(entry, statusCode, message) {
    for (const [, pending] of entry.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ type: "failed", status: statusCode, message });
    }
    entry.pending.clear();
  }

  function spawn(entry) {
    const pluginDataDir = path.join(dataDir, "plugins", entry.id);
    fs.mkdirSync(pluginDataDir, { recursive: true });
    const execArgv = permission
      ? [
          "--permission",
          `--allow-fs-read=${path.join(rootDir, "plugins")}`,
          `--allow-fs-read=${path.join(rootDir, "web", "src")}`,
          `--allow-fs-read=${path.join(rootDir, "node_modules")}`,
          `--allow-fs-read=${pluginDataDir}`,
          `--allow-fs-write=${pluginDataDir}`,
        ]
      : [];
    entry.state = entry.restarts === 0 ? "starting" : "restarting";
    const child = forkProcess(entry.entry, [], {
      execArgv,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: process.env.NODE_ENV,
        EVEJS_PLUGIN_ID: entry.id,
        EVEJS_PLUGIN_DATA_DIR: pluginDataDir,
        EVEJS_PLUGIN_MANIFEST: path.join(rootDir, "plugins", entry.id, "plugin.ts"),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      // Structured clone, so an observation's Maps and Sets reach a decider whole.
      serialization: "advanced",
    });
    entry.child = child;
    entry.lastPong = Date.now();
    const prefix = (stream, write) => stream?.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) if (line.trim()) write(`[plugin ${entry.id}] ${line}`);
    });
    prefix(child.stdout, (line) => console.log(line));
    prefix(child.stderr, (line) => console.error(line));
    child.on("message", (message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "ready") {
        entry.state = "running";
        entry.error = null;
        entry.readyWaiters.splice(0).forEach((resolve) => resolve(true));
        return;
      }
      if (message.type === "pong") {
        entry.lastPong = Date.now();
        return;
      }
      const pending = entry.pending.get(message.id);
      if (!pending) return;
      entry.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
    });
    child.on("exit", (code, signal) => {
      if (entry.child !== child) return;
      entry.child = null;
      failPending(entry, 503, "The plugin's server part stopped. Try again in a moment.");
      entry.readyWaiters.splice(0).forEach((resolve) => resolve(false));
      if (stopping || entry.state === "stopped") {
        entry.state = "stopped";
        return;
      }
      const now = Date.now();
      entry.failures = entry.failures.filter((at) => now - at < FAILURE_WINDOW_MS).concat(now);
      entry.error = entry.error || `Its process ended (${signal || `exit code ${code}`}).`;
      if (entry.failures.length >= MAX_FAILURES) {
        entry.state = "failed";
        log(`${entry.id}: stopped after ${entry.failures.length} failures. ${entry.error}`);
        return;
      }
      entry.state = "restarting";
      const delay = backoffMs[Math.min(entry.failures.length - 1, backoffMs.length - 1)];
      log(`${entry.id}: ${entry.error} Starting again in ${delay / 1000} s.`);
      entry.restartTimer = setTimeout(() => {
        entry.restartTimer = null;
        if (!stopping) {
          entry.restarts += 1;
          spawn(entry);
        }
      }, delay);
      entry.restartTimer.unref?.();
    });
  }

  function watch() {
    const timer = setInterval(() => {
      for (const entry of backends.values()) {
        const child = entry.child;
        if (!child || entry.state !== "running") continue;
        if (Date.now() - entry.lastPong > pingMs * 2) {
          entry.error = "It stopped answering, so it was stopped.";
          child.kill("SIGKILL");
          continue;
        }
        try {
          child.send({ type: "ping", id: nextMessageID++ });
        } catch {
          // The exit handler deals with a channel that has gone.
        }
      }
    }, pingMs);
    timer.unref?.();
    return timer;
  }

  let watchTimer = null;

  // The plugins as they loaded into this BFF's copy of the bot code.
  let webStatuses = [];

  /**
   * Load the build's plugins: their bot blocks into this BFF's copy of the bot
   * code (so a saved script using one is read, priced and run here, with each
   * block's next step asked of its plugin's process), and a process for each
   * plugin with a backend or a block. Resolves once the blocks are in, which is
   * before any bot is resumed; the processes come up on their own time.
   */
  async function start() {
    stopping = false;
    let manifests;
    try {
      manifests = await loadManifests();
    } catch (error) {
      log(`The build's plugin list could not be read: ${error && error.message}`);
      return;
    }
    if (options.activateWebStack) {
      try {
        const web = (relative) => import(pathToFileURL(path.join(rootDir, "web", "src", relative)).href);
        const [loader, blocks] = await Promise.all([web("plugins/pluginHost.ts"), web("bots/pluginMacros.ts")]);
        webStatuses = loader.activatePlugins(manifests, null);
        for (const status of webStatuses) if (status.error) log(`${status.id}: ${status.error}`);
        blocks.setRemotePluginDecider((macro, step, obs, mem, board) =>
          decide(blocks.pluginOfMacro(macro), macro, step, obs, mem, board));
      } catch (error) {
        log(`The plugins' bot blocks could not be loaded: ${error && error.message}`);
      }
    }
    for (const manifest of manifests) {
      if (!manifest || backends.has(manifest.id)) continue;
      const hasBackend = typeof manifest.backend === "string";
      const hasBlocks = Array.isArray(manifest.macros) && manifest.macros.length > 0;
      if (!hasBackend && !hasBlocks) continue;
      if (options.activateWebStack && webStatuses.find((status) => status.id === manifest.id)?.state !== "active") continue;
      const entry = {
        id: manifest.id,
        // A plugin with blocks and no backend of its own still decides them in a
        // process of its own: the plugin API's, which loads its manifest.
        entry: hasBackend
          ? path.join(rootDir, "plugins", manifest.id, manifest.backend)
          : path.join(rootDir, "web", "src", "plugin-api", "deciderProcess.ts"),
        state: "starting",
        restarts: 0,
        failures: [],
        error: null,
        child: null,
        lastPong: 0,
        pending: new Map(),
        readyWaiters: [],
        restartTimer: null,
      };
      backends.set(manifest.id, entry);
      spawn(entry);
    }
    if (backends.size > 0 && watchTimer === null) watchTimer = watch();
  }

  /** Stop every backend; used when the server closes. */
  function stop() {
    stopping = true;
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
    for (const entry of backends.values()) {
      if (entry.restartTimer) clearTimeout(entry.restartTimer);
      entry.state = "stopped";
      failPending(entry, 503, "The server is stopping.");
      entry.child?.kill("SIGTERM");
    }
  }

  function whenReady(entry, timeoutMs) {
    if (entry.state === "running") return Promise.resolve(true);
    if (entry.state === "failed" || entry.state === "stopped") return Promise.resolve(false);
    return new Promise((resolve) => {
      entry.readyWaiters.push(resolve);
      setTimeout(() => resolve(entry.state === "running"), timeoutMs).unref?.();
    });
  }

  /** Send one message and wait for its answer; never throws. */
  async function ask(id, message, timeoutMs) {
    const entry = backends.get(id);
    if (!entry) return { type: "failed", status: 404, message: "No plugin with a server part is called that." };
    if (!(await whenReady(entry, timeoutMs))) {
      return { type: "failed", status: 503, message: entry.error || "The plugin's server part is not running." };
    }
    const messageID = nextMessageID++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.pending.delete(messageID);
        resolve({ type: "failed", status: 504, message: "The plugin's server part did not answer in time." });
      }, timeoutMs);
      timer.unref?.();
      entry.pending.set(messageID, { resolve, timer });
      try {
        entry.child.send({ ...message, id: messageID });
      } catch {
        entry.pending.delete(messageID);
        clearTimeout(timer);
        resolve({ type: "failed", status: 503, message: "The plugin's server part stopped. Try again in a moment." });
      }
    });
  }

  /** One of a plugin's routes, as the BFF received it. Resolves to { status, body }. */
  async function request(id, { method, path: requestPath, query, body, account }) {
    const answer = await ask(id, { type: "request", method, path: requestPath, query, body, account }, requestTimeoutMs);
    if (answer.type === "failed") return { status: answer.status, body: { ok: false, error: "PLUGIN_UNAVAILABLE", message: answer.message } };
    return { status: answer.status || 200, body: answer.body };
  }

  /** A plugin block's next step, decided in the plugin's process. Resolves to { tick } or { error }. */
  async function decide(id, macro, step, obs, mem, board) {
    const answer = await ask(id, { type: "decide", macro, step, obs, mem, board }, decideTimeoutMs);
    if (answer.type === "failed") return { error: answer.message };
    return answer.error ? { error: answer.error } : { tick: answer.tick };
  }

  /** Hand a plugin what core used to keep for it. Resolves to an error sentence or null. */
  async function adopt(id, records) {
    const answer = await ask(id, { type: "adopt", records }, requestTimeoutMs);
    return answer.type === "failed" ? answer.message : answer.error || null;
  }

  /**
   * Remove everything a plugin keeps, before it leaves the build: its own
   * cleanup first, then its data directory whatever that left behind.
   */
  async function uninstall(id) {
    const entry = backends.get(id);
    let error = null;
    if (entry) {
      const answer = await ask(id, { type: "cleanup" }, requestTimeoutMs);
      error = answer.type === "failed" ? answer.message : answer.error || null;
      entry.state = "stopped";
      entry.child?.kill("SIGTERM");
    }
    fs.rmSync(path.join(dataDir, "plugins", id), { recursive: true, force: true });
    return { cleaned: error === null, error };
  }

  return {
    start,
    stop,
    request,
    decide,
    adopt,
    uninstall,
    statuses: () => [...backends.values()].map(status),
    webStatuses: () => webStatuses,
    has: (id) => backends.has(id),
  };
}

module.exports = { createPluginHost, PING_MS, REQUEST_TIMEOUT_MS, DECIDE_TIMEOUT_MS };
