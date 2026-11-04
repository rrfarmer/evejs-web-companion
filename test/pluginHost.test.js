"use strict";

// The plugin host (src/pluginHost.js) against a real backend in a real child
// process, under Node's permission model: a failed plugin fails only itself.
//
// The backend is a fixture written into a temporary root laid out as the image
// is (plugins/<id>/, web/src/plugin-api/, data/), so the permission model's
// paths are the ones production grants.

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createPluginHost } = require("../src/pluginHost");

const REPO = path.resolve(__dirname, "..");

const BACKEND = `
import { readFileSync } from "node:fs";
import path from "node:path";
import { jsonStore, pluginDataDir, startBackend } from "../../web/src/plugin-api/backend.ts";

startBackend({
  manifest: {
    id: "echo", name: "Echo", version: "1.0.0", apiVersion: 1, description: "Test.",
    macros: [{ id: "echo:count", decide: (step, obs, mem) => ({ action: { kind: "wait" }, why: "counted " + obs.n, phase: "Counting", armed: false, outcome: { kind: "done" }, nextMem: mem }) }],
  },
  routes: {
    "GET /hello/:name": (request) => ({ body: { hi: request.params.name, as: request.account.username, q: request.query.x ?? null } }),
    "POST /save": (request) => { jsonStore("saved.json").write(request.body); return { status: 201, body: { ok: true } }; },
    "GET /saved": () => ({ body: jsonStore("saved.json").read() }),
    "GET /throw": () => { throw new Error("boom"); },
    "GET /crash": () => { process.exit(3); },
    "GET /hang": () => { for (;;) {} },
    "GET /core-db": () => {
      try { readFileSync(path.join(pluginDataDir(), "..", "..", "companion.sqlite")); return { body: { read: true } }; }
      catch (error) { return { body: { read: false, code: error.code } }; }
    },
  },
  cleanup: () => { jsonStore("cleanup.json").write(true); },
  adopt: (records) => { jsonStore("adopted.json").write(records); },
});
`;

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-host-"));
  fs.mkdirSync(path.join(root, "plugins", "echo"), { recursive: true });
  fs.mkdirSync(path.join(root, "web", "src", "plugin-api"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  for (const file of ["backend.ts", "deciderProcess.ts"]) {
    fs.copyFileSync(path.join(REPO, "web", "src", "plugin-api", file), path.join(root, "web", "src", "plugin-api", file));
  }
  fs.writeFileSync(path.join(root, "plugins", "echo", "backend.ts"), BACKEND);
  fs.writeFileSync(path.join(root, "data", "companion.sqlite"), "core data");
  // The plugin side's own package scope, as the image has none for it.
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  return root;
}

const ACCOUNT = { accountID: 1, username: "tester" };

function host(root, extra = {}) {
  return createPluginHost({
    rootDir: root,
    dataDir: path.join(root, "data"),
    manifests: [{ id: "echo", backend: "backend.ts" }],
    pingMs: 150,
    requestTimeoutMs: 1_500,
    decideTimeoutMs: 1_500,
    backoffMs: [100],
    log: () => {},
    ...extra,
  });
}

async function until(check, ms = 8_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("a plugin's routes are answered in its own process, with the account and the route's names", async (t) => {
  const root = makeRoot();
  const plugins = host(root);
  t.after(() => plugins.stop());
  await plugins.start();
  const hello = await plugins.request("echo", { method: "GET", path: "/hello/world", query: { x: "1" }, body: null, account: ACCOUNT });
  assert.deepEqual(hello, { status: 200, body: { hi: "world", as: "tester", q: "1" } });
  assert.equal((await plugins.request("echo", { method: "POST", path: "/save", query: {}, body: { a: 1 }, account: ACCOUNT })).status, 201);
  assert.deepEqual((await plugins.request("echo", { method: "GET", path: "/saved", query: {}, body: null, account: ACCOUNT })).body, { a: 1 });
  assert.equal((await plugins.request("echo", { method: "GET", path: "/nowhere", query: {}, body: null, account: ACCOUNT })).status, 404);
  assert.equal((await plugins.request("nobody", { method: "GET", path: "/x", query: {}, body: null, account: ACCOUNT })).status, 404);
  assert.deepEqual(plugins.statuses().map((s) => [s.id, s.state]), [["echo", "running"]]);
});

test("⚠ a throw is that request's 500; a crash is that request's 503, and the backend comes back", async (t) => {
  const root = makeRoot();
  const plugins = host(root);
  t.after(() => plugins.stop());
  await plugins.start();
  const thrown = await plugins.request("echo", { method: "GET", path: "/throw", query: {}, body: null, account: ACCOUNT });
  assert.equal(thrown.status, 500);
  assert.match(thrown.body.message, /boom/);
  const crashed = await plugins.request("echo", { method: "GET", path: "/crash", query: {}, body: null, account: ACCOUNT });
  assert.equal(crashed.status, 503);
  assert.ok(await until(() => plugins.statuses()[0].state === "running" && plugins.statuses()[0].restarts === 1), "it was started again");
  assert.equal((await plugins.request("echo", { method: "GET", path: "/hello/again", query: {}, body: null, account: ACCOUNT })).status, 200);
});

test("⚠ a hung backend is answered 504, killed by the watchdog and started again", async (t) => {
  const root = makeRoot();
  const plugins = host(root);
  t.after(() => plugins.stop());
  await plugins.start();
  const hung = await plugins.request("echo", { method: "GET", path: "/hang", query: {}, body: null, account: ACCOUNT });
  assert.ok([503, 504].includes(hung.status), `a hang costs only its own request (${hung.status})`);
  assert.ok(await until(() => plugins.statuses()[0].restarts >= 1 && plugins.statuses()[0].state === "running"), "the watchdog killed and restarted it");
  assert.equal((await plugins.request("echo", { method: "GET", path: "/hello/back", query: {}, body: null, account: ACCOUNT })).status, 200);
});

test("⚠ a backend cannot read the core database: only its own folder", async (t) => {
  const root = makeRoot();
  const plugins = host(root);
  t.after(() => plugins.stop());
  await plugins.start();
  const answer = await plugins.request("echo", { method: "GET", path: "/core-db", query: {}, body: null, account: ACCOUNT });
  assert.deepEqual(answer.body, { read: false, code: "ERR_ACCESS_DENIED" });
});

test("a block's next step is decided in the plugin's process", async (t) => {
  const root = makeRoot();
  const plugins = host(root);
  t.after(() => plugins.stop());
  await plugins.start();
  const decided = await plugins.decide("echo", "echo:count", { id: "s" }, { n: 3 }, {}, {});
  assert.equal(decided.tick.why, "counted 3");
  assert.match((await plugins.decide("echo", "echo:nothing", {}, {}, {}, {})).error, /no block called/);
});

test("what core kept is handed over, and uninstalling runs the plugin's cleanup, then deletes its data", async (t) => {
  const root = makeRoot();
  const plugins = host(root);
  t.after(() => plugins.stop());
  await plugins.start();
  assert.equal(await plugins.adopt("echo", { plans: [1, 2] }), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "data", "plugins", "echo", "adopted.json"), "utf8")), { plans: [1, 2] });
  const outcome = await plugins.uninstall("echo");
  assert.deepEqual(outcome, { cleaned: true, error: null });
  assert.equal(fs.existsSync(path.join(root, "data", "plugins", "echo")), false);
});

test("⚠ a plugin that throws while its module loads costs the BFF only that plugin", async (t) => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "web", "src", "plugins"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "web", "src", "plugins", "loadPlugins.ts"), path.join(root, "web", "src", "plugins", "loadPlugins.ts"));
  fs.mkdirSync(path.join(root, "plugins", "broken"), { recursive: true });
  fs.writeFileSync(path.join(root, "plugins", "broken", "plugin.ts"), `throw new Error("boom at load");`);
  fs.writeFileSync(path.join(root, "plugins", "echo", "plugin.ts"), `export default { id: "echo", backend: "backend.ts" };`);
  fs.writeFileSync(path.join(root, "plugins", "index.ts"), `export const PLUGINS = [
  { id: "broken", load: () => import("./broken/plugin.ts") },
  { id: "echo", load: () => import("./echo/plugin.ts") },
];`);
  const lines = [];
  const plugins = host(root, { manifests: undefined, log: (line) => lines.push(line) });
  t.after(() => plugins.stop());
  await plugins.start();
  assert.deepEqual(plugins.statuses().map((s) => s.id), ["echo"]);
  assert.ok(lines.some((line) => /broken: .*boom at load/.test(line)), lines.join("\n"));
  assert.equal((await plugins.request("echo", { method: "GET", path: "/hello/world", query: {}, body: null, account: ACCOUNT })).status, 200);
});

test("a plugin with blocks and no backend still decides them in a process of its own", async (t) => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "plugins", "counter"), { recursive: true });
  fs.writeFileSync(path.join(root, "plugins", "counter", "plugin.ts"), `
export default {
  id: "counter", name: "Counter", version: "1.0.0", apiVersion: 1, description: "Test.",
  macros: [{ id: "counter:count", decide: (step, obs, mem) => ({ action: { kind: "wait" }, why: "seen " + obs.seen.size, phase: "p", armed: false, outcome: { kind: "done" }, nextMem: mem }) }],
};
`);
  const plugins = host(root, { manifests: [{ id: "counter", macros: [{ id: "counter:count" }] }] });
  t.after(() => plugins.stop());
  await plugins.start();
  // A Set reaches the decider whole: the channel carries structured clones.
  const decided = await plugins.decide("counter", "counter:count", { id: "s" }, { seen: new Set([1, 2]) }, {}, {});
  assert.equal(decided.tick?.why, "seen 2", decided.error);
  assert.equal((await plugins.request("counter", { method: "GET", path: "/x", query: {}, body: null, account: ACCOUNT })).status, 404);
});

// ─── The host's own bookkeeping, against a stand-in process ──────────────────

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A process that answers pings and says it is ready when the test tells it to. */
function fakeProcess({ pid = 1234 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = [];
  child.kill = (signal) => {
    child.killed.push(signal);
    setImmediate(() => child.emit("exit", null, signal));
  };
  child.send = (message) => {
    if (message.type === "ping") setImmediate(() => child.emit("message", { type: "pong", id: message.id }));
    if (message.type === "decide") setImmediate(() => child.emit("message", { type: "decided", id: message.id, tick: "answered" }));
    if (message.type === "adopt") setImmediate(() => child.emit("message", { type: "done", id: message.id }));
    return true;
  };
  child.ready = () => child.emit("message", { type: "ready" });
  return child;
}

function fakeHost(t, children, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-host-fake-"));
  const plugins = createPluginHost({
    rootDir: root,
    dataDir: path.join(root, "data"),
    manifests: [{ id: "echo", backend: "backend.ts" }],
    fork: () => {
      const child = children.next();
      return child;
    },
    pingMs: 40,
    backoffMs: [20],
    log: () => {},
    ...extra,
  });
  t.after(() => plugins.stop());
  return { plugins, root };
}

function processes() {
  const made = [];
  return { made, next: () => { const child = fakeProcess(); made.push(child); return child; } };
}

test("⚠ an error from the process, a send on a closed channel for one, does not reach the BFF", async (t) => {
  const children = processes();
  const { plugins } = fakeHost(t, children);
  await plugins.start();
  // With no listener this event is an uncaught exception, and the BFF ends.
  children.made[0].emit("error", new Error("Channel closed"));
  assert.equal(children.made.length, 1, "a process still running is not started again");
});

test("⚠ a process that could not start is that plugin's failure, and it is tried again", async (t) => {
  const failing = fakeProcess({ pid: null });
  delete failing.pid;
  const working = fakeProcess();
  const queue = [failing, working];
  const { plugins } = fakeHost(t, { next: () => queue.shift() });
  await plugins.start();
  failing.emit("error", new Error("spawn ENOENT"));
  assert.equal(plugins.statuses()[0].state, "restarting");
  assert.match(plugins.statuses()[0].error, /spawn ENOENT/);
  assert.ok(await until(() => plugins.statuses()[0].restarts === 1), "it was tried again");
});

test("⚠ a data folder that cannot be made is that plugin's failure, and the others still start", async (t) => {
  const children = processes();
  const { plugins, root } = fakeHost(t, children, { manifests: [{ id: "first", backend: "backend.ts" }, { id: "second", backend: "backend.ts" }] });
  fs.mkdirSync(path.join(root, "data", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "plugins", "first"), "a file where its folder belongs");
  await plugins.start();
  const [first, second] = plugins.statuses();
  assert.match(first.error, /could not be started/);
  assert.equal(second.state, "starting");
  assert.equal(children.made.length, 1);
});

test("⚠ the time a backend took to start is not silence: the watchdog leaves it be", async (t) => {
  const children = processes();
  const { plugins } = fakeHost(t, children);
  await plugins.start();
  await wait(150); // Longer than the two ping periods a silent backend is allowed.
  children.made[0].ready();
  await wait(100);
  assert.deepEqual(children.made[0].killed, []);
  assert.equal(plugins.statuses()[0].state, "running");
});

test("⚠ a backend that hangs before it is ready is killed and started again", async (t) => {
  const children = processes();
  const { plugins } = fakeHost(t, children, { startTimeoutMs: 100 });
  await plugins.start();
  assert.ok(await until(() => children.made[0].killed.length > 0), "it was killed");
  assert.ok(await until(() => plugins.statuses()[0].restarts === 1), "it was started again");
});

test("⚠ a decide waits for a backend still starting, past its own short answer timeout", async (t) => {
  const children = processes();
  const { plugins } = fakeHost(t, children, { decideTimeoutMs: 30 });
  await plugins.start();
  const decided = plugins.decide("echo", "echo:count", {}, {}, {}, {});
  await wait(100);
  children.made[0].ready();
  assert.deepEqual(await decided, { tick: "answered" });
});

test("⚠ a handover whose note cannot be written is logged, never fatal", async (t) => {
  const children = processes();
  const lines = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-host-marker-"));
  const { plugins } = fakeHost(t, children, {
    handoffs: { echo: () => ({ plans: [] }) },
    // A folder where the note's file belongs, so writing it throws.
    handoffMarkerPath: root,
    log: (line) => lines.push(line),
  });
  await plugins.start();
  children.made[0].ready();
  assert.ok(await until(() => lines.some((line) => /could not be noted/.test(line))), lines.join("\n"));
});
