"use strict";

// The plugin host (src/pluginHost.js) against a real backend in a real child
// process, under Node's permission model: a failed plugin fails only itself.
//
// The backend is a fixture written into a temporary root laid out as the image
// is (plugins/<id>/, web/src/plugin-api/, data/), so the permission model's
// paths are the ones production grants.

const test = require("node:test");
const assert = require("node:assert/strict");
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
  fs.copyFileSync(path.join(REPO, "web", "src", "plugin-api", "backend.ts"), path.join(root, "web", "src", "plugin-api", "backend.ts"));
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
