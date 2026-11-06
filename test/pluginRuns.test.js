"use strict";

// A run a plugin flies: the real bot host and plugin host against a real backend in
// a real child process, under Node's permission model. Only the flow the host holds
// the session with, and the BFF behind it, are stand-ins.

const test = require("node:test");
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { createBotHost } = require("../src/botHost");
const { createPluginHost } = require("../src/pluginHost");

const REPO = path.resolve(__dirname, "..");

const BACKEND = `
import { jsonStore, startBackend } from "../../web/src/plugin-api/backend.ts";

const heard = (name, value) => jsonStore(name).write(value);

startBackend({
  manifest: { id: "probe", name: "Probe", version: "1.0.0", apiVersion: 1, description: "Test." },
  routes: {
    "GET /crash": () => { process.exit(3); },
    "GET /hang": () => { setTimeout(() => { for (;;) {} }, 5); return { body: {} }; },
    "GET /heard/:name": (request) => ({ body: jsonStore(request.params.name + ".json").read() }),
    "POST /ask": async (request) => {
      const answer = await flying.fetch(request.body.url, { method: request.body.method ?? "GET" });
      return { body: { status: answer.status, answer: await answer.json() } };
    },
    "POST /ask-request": async (request) => {
      const answer = await flying.fetch(new Request(new URL(request.body.url, flying.baseUrl), { method: "POST", headers: { "x-from-request": "yes" }, body: "given" }));
      return { body: { status: answer.status } };
    },
    "POST /report-too-much": () => {
      for (let time = 0; time < 2; time += 1) flying.report({ status: "running", phase: "Probing", resumeData: "x".repeat(70 * 1024) });
      return { body: {} };
    },
    "POST /other-plugin-run": (request) => {
      process.send({ type: "runFetch", id: 999001, botID: request.body.botID, url: "/api/bridge/flight/status", method: "GET", headers: {} });
      return { body: {} };
    },
  },
  cleanup: () => {},
  runs: {
    probe: {
      check(setup) {
        if (setup?.bad === true) return { ok: false, refusal: "That setup is bad." };
        if (setup?.noPolicy === true) return { ok: true, name: "Probe run", setup: {} };
        return { ok: true, name: "Probe run", setup: { n: Number(setup?.n ?? 1), restartSafe: setup?.restartSafe !== false, endItself: setup?.endItself === true,
          ...(setup?.quietAfterRestart === true ? { quietAfterRestart: true } : {}), ...(setup?.slowStart === true ? { slowStart: true } : {}) },
          policy: { riskClasses: ["combat"], restartSafe: setup?.restartSafe !== false } };
      },
      async start(run) {
        flying = run;
        heard("started.json", { botID: run.botID, resumed: run.resumed, resumeData: run.resumeData, held: run.held, setup: run.setup, routeSettings: run.routeSettings });
        if (run.setup.slowStart) await new Promise((resolve) => setTimeout(resolve, 500));
        if (run.resumed && run.setup.quietAfterRestart) return { stop() {} };
        const status = await run.fetch("/api/bridge/flight/status");
        run.report({ status: "running", phase: "Probing", why: "Asked " + status.status, readout: { asked: status.status }, resumeData: { lap: run.setup.n } });
        if (run.setup.endItself) run.report({ status: "stopped", why: "Done by itself." });
        return { async stop() {
          const logged = await run.fetch("/api/bots/bot-log", { method: "POST", body: "{}" });
          const anySpelling = await run.fetch("/api/Bots/Bot-Log/", { method: "POST", body: "{}" });
          const flown = await run.fetch("/api/bridge/flight/status");
          const read = await run.fetch("/api/bots/bot-log");
          const otherBotRoute = await run.fetch("/api/bots/squad-board", { method: "POST", body: "{}" });
          heard("stopped.json", { botID: run.botID, logged: logged.status, anySpelling: anySpelling.status,
            flown: flown.status, read: read.status, otherBotRoute: otherBotRoute.status });
        } };
      },
    },
  },
});
let flying = null;
`;

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-runs-"));
  fs.mkdirSync(path.join(root, "plugins", "probe"), { recursive: true });
  fs.mkdirSync(path.join(root, "web", "src", "plugin-api"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "web", "src", "plugin-api", "backend.ts"), path.join(root, "web", "src", "plugin-api", "backend.ts"));
  fs.writeFileSync(path.join(root, "plugins", "probe", "backend.ts"), BACKEND);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  return root;
}

const ACCOUNT = { accountID: 7, username: "tester" };
const CHARACTER = 90000001;
const GRANT = { scriptRev: 1, riskClasses: ["combat"], maxRuntimeMinutes: 60 };
const HELD = { characterID: CHARACTER, character: { name: "Stand-in" }, station: null };

async function until(check, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

let realPolicy = null;
async function makeStack(log) {
  realPolicy ??= await import(pathToFileURL(path.join(REPO, "web", "src", "bots", "runPolicy.ts")).href);
  return async () => ({
    createClientStore() {
      const state = { station: { online: null }, flight: { status: null }, space: { snapshot: null }, mining: { holds: [] }, customBot: { status: "idle" }, companion: { status: "idle" } };
      const listeners = new Set();
      return {
        get: () => state,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        station: { get: () => state.station }, flight: { get: () => state.flight }, space: { get: () => state.space },
        mining: { get: () => state.mining }, customBot: { get: () => state.customBot }, companion: { get: () => state.companion },
      };
    },
    createAppFlow(store) {
      const state = store.get();
      return {
        async selectCharacter(id) { log.push(["select", id]); state.station.online = { characterID: id, characterName: "Stand-in" }; state.flight.status = { docked: false }; },
        heldPilot: () => HELD,
        autopilotSettings: () => ({ pfRouteType: "shortest" }),
        async loadFlightStatus() {},
        async loadSpaceSnapshot() {},
        async loadMiningHolds() {},
        async panicRecallAndDock() { log.push(["panicRecallAndDock"]); state.flight.status = { docked: true }; },
        async prepareHostedBotStop() { log.push(["prepareHostedBotStop"]); },
        async cancelHostedHome() {},
        stopCustomBot() {},
        abortRoute() {},
        async logout() { log.push(["logout"]); },
      };
    },
    createHostedEventSource: () => ({ close() {} }),
    PLUGIN_RUN_GRANT_REV: realPolicy.PLUGIN_RUN_GRANT_REV,
    pluginRunBotPolicy: realPolicy.pluginRunBotPolicy,
    validateBotLaunchGrant: realPolicy.validateBotLaunchGrant,
  });
}

async function makeFixture(t, extra = {}) {
  const root = makeRoot();
  const log = [];
  const asked = [];
  const sentToPlugin = [];
  const stack = await makeStack(log);
  let plugins = null;
  const hostOptions = {
    webAuth: { createSessionToken: () => "core-only-token" },
    baseUrl: "http://bff.test",
    errorLogger: () => {},
    createClaimSecret: () => "core-only-claim",
    loadStack: stack,
    pluginProcess: () => plugins,
    persistPath: path.join(root, "data", "server-bots.json"),
    loadAccount: async () => ACCOUNT,
    fetch: async (input, init = {}) => {
      asked.push({ url: String(input), headers: new Headers(init.headers), method: init.method ?? "GET", body: init.body });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    },
    ...extra.bots,
  };
  const bots = createBotHost(hostOptions);
  const startPlugins = async (events = bots.pluginRunEvents) => {
    plugins = createPluginHost({
      rootDir: root,
      dataDir: path.join(root, "data"),
      manifests: [{ id: "probe", backend: "backend.ts", formerBotKinds: { "old-probe": "probe" } }],
      pingMs: 150,
      requestTimeoutMs: 2_000,
      backoffMs: [50],
      log: () => {},
      runEvents: events,
      fork: (...args) => {
        const child = fork(...args);
        const send = child.send.bind(child);
        child.send = (message, ...rest) => { sentToPlugin.push(JSON.stringify(message)); return send(message, ...rest); };
        return child;
      },
      ...extra.plugins,
    });
    await plugins.start();
    return plugins;
  };
  await startPlugins();
  t.after(() => plugins.stop());
  const request = (method, requestPath, body = null) => plugins.request("probe", { method, path: requestPath, query: {}, body, account: ACCOUNT });
  const heard = async (name) => (await request("GET", `/heard/${name}`)).body;
  const startRun = (setup = { n: 1 }) => bots.start({ account: ACCOUNT, characterID: CHARACTER, kind: "plugin", pluginID: "probe", pluginRun: "probe", request: setup, grant: GRANT });
  const row = () => bots.list(ACCOUNT.accountID)[0];
  return { root, bots, log, asked, sentToPlugin, request, heard, startRun, row, hostOptions, startPlugins, plugins: () => plugins };
}

test("a run is a bot like any other: claimed, listed, and flown from the plugin's process", async (t) => {
  const f = await makeFixture(t);
  const started = await f.startRun({ n: 4 });
  assert.equal(started.ok, true, started.message);
  assert.equal(f.bots.claimedBy(CHARACTER), started.bot.botID);
  assert.ok(await until(() => f.row().phase === "Probing"));
  const row = f.row();
  assert.equal(row.kind, "plugin");
  assert.equal(row.scriptName, "Probe run");
  assert.equal(row.status, "running");
  assert.deepEqual(row.plugin, { pluginID: "probe", run: "probe", readout: { asked: 200 } });
  assert.deepEqual(row.riskClasses, ["combat"]);
  const heard = await f.heard("started");
  assert.equal(heard.botID, started.bot.botID);
  assert.equal(heard.resumed, false);
  assert.deepEqual(heard.setup, { n: 4, restartSafe: true, endItself: false });
  assert.deepEqual(heard.held, HELD);
  assert.deepEqual(heard.routeSettings, { pfRouteType: "shortest" });
  await f.bots.stop(started.bot.botID, ACCOUNT.accountID);
});

test("⚠ the token and the claim are added by core and never reach the plugin", async (t) => {
  const f = await makeFixture(t);
  await f.startRun();
  assert.ok(await until(() => f.asked.length > 0));
  const asked = f.asked[0];
  assert.equal(asked.url, "http://bff.test/api/bridge/flight/status");
  assert.equal(asked.headers.get("authorization"), "Bearer core-only-token");
  assert.equal(asked.headers.get("x-evejs-bot-claim"), "core-only-claim");
  const sent = f.sentToPlugin.join("\n");
  assert.ok(sent.includes("runStart"));
  assert.equal(sent.includes("core-only-token"), false);
  assert.equal(sent.includes("core-only-claim"), false);
  const roster = fs.readFileSync(path.join(f.root, "data", "server-bots.json"), "utf8");
  assert.equal(roster.includes("core-only"), false);
  await f.bots.stop(f.row().botID, ACCOUNT.accountID);
});

test("⚠ a run may not choose another pilot, end its session, or leave the BFF's API", async (t) => {
  const f = await makeFixture(t);
  await f.startRun();
  assert.ok(await until(() => f.row().phase === "Probing"));
  for (const [url, method, error] of [
    ["/api/bridge/select", "POST", "PLUGIN_RUN_SESSION_IS_CORES"],
    ["/api/logout", "POST", "PLUGIN_RUN_SESSION_IS_CORES"],
    ["/api/bridge/release", "POST", "PLUGIN_RUN_SESSION_IS_CORES"],
    // The router ignores case and a trailing slash, so these reach the same routes.
    ["/api/LOGOUT", "POST", "PLUGIN_RUN_SESSION_IS_CORES"],
    ["/api/logout/", "POST", "PLUGIN_RUN_SESSION_IS_CORES"],
    ["/api/Bridge/Select", "POST", "PLUGIN_RUN_SESSION_IS_CORES"],
    ["/api/bridge/select/", "POST", "PLUGIN_RUN_SESSION_IS_CORES"],
    ["/api/bots/start", "POST", "PLUGIN_RUN_SESSION_IS_CORES"],
    ["/api/bots/another-bot/stop", "POST", "PLUGIN_RUN_SESSION_IS_CORES"],
    ["/api/bots/another-bot/reconnect", "POST", "PLUGIN_RUN_SESSION_IS_CORES"],
    ["/api/mining-operations/an-operation/start", "POST", "PLUGIN_RUN_SESSION_IS_CORES"],
    ["/api/mining-operations/an-operation/stop", "POST", "PLUGIN_RUN_SESSION_IS_CORES"],
    ["http://elsewhere.test/api/x", "GET", "PLUGIN_RUN_OUTSIDE_API"],
    ["/not-the-api", "GET", "PLUGIN_RUN_OUTSIDE_API"],
  ]) {
    const before = f.asked.length;
    const { body } = await f.request("POST", "/ask", { url, method });
    assert.equal(body.status, 403, url);
    assert.equal(body.answer.error, error);
    assert.equal(f.asked.length, before, `${url} reached the BFF`);
  }
  // What a flow reads about the bots stays open.
  const { body } = await f.request("POST", "/ask", { url: "/api/bots/active", method: "GET" });
  assert.equal(body.status, 200);
  await f.bots.stop(f.row().botID, ACCOUNT.accountID);
});

test("the flight recorder's route is a run's to use", async (t) => {
  const f = await makeFixture(t);
  await f.startRun();
  assert.ok(await until(() => f.row().phase === "Probing"));
  for (const method of ["POST", "GET"]) {
    const asked = await f.request("POST", "/ask", { url: "/api/bots/bot-log", method });
    assert.equal(asked.body.status, 200, method);
  }
});

test("a Request given to a run's fetch goes as what it says", async (t) => {
  const f = await makeFixture(t);
  await f.startRun();
  assert.ok(await until(() => f.row().phase === "Probing"));
  await f.request("POST", "/ask-request", { url: "/api/bridge/flight/status" });
  const asked = f.asked.at(-1);
  assert.equal(asked.method, "POST");
  assert.equal(asked.body, "given");
  assert.equal(asked.headers.get("x-from-request"), "yes");
  await f.bots.stop(f.row().botID, ACCOUNT.accountID);
});

test("what a run keeps is bounded, and going over the bound is said once", async (t) => {
  const said = [];
  const f = await makeFixture(t, { bots: { errorLogger: (error) => said.push(String(error.message)) } });
  await f.startRun({ n: 2 });
  assert.ok(await until(() => f.row().phase === "Probing"));
  await f.request("POST", "/report-too-much");
  assert.ok(await until(() => said.length > 0));
  assert.equal(said.filter((words) => words.includes("resumeData")).length, 1);
  assert.equal(fs.readFileSync(path.join(f.root, "data", "server-bots.json"), "utf8").includes("xxxx"), false);
  await f.bots.stop(f.row().botID, ACCOUNT.accountID);
});

test("a check that does not say what a setup risks is a refusal", async (t) => {
  const f = await makeFixture(t);
  const started = await f.startRun({ noPolicy: true });
  assert.equal(started.ok, false);
  assert.equal(started.code, "PLUGIN_RUN_INVALID");
  assert.equal(f.bots.claimedBy(CHARACTER), null);
});

test("⚠ a start that answers late is told to stop when it does come", async (t) => {
  const f = await makeFixture(t, { plugins: { requestTimeoutMs: 100 } });
  const started = await f.startRun({ slowStart: true });
  assert.equal(started.ok, false);
  assert.ok(await until(async () => (await f.heard("stopped"))?.botID !== undefined), "the plugin was told");
  assert.equal(f.bots.claimedBy(CHARACTER), null);
});

test("a run that says nothing after a restart does not go on saying its plugin stopped", async (t) => {
  const f = await makeFixture(t);
  const started = await f.startRun({ quietAfterRestart: true });
  assert.ok(await until(() => f.row().phase === "Probing"));
  await f.request("GET", "/crash");
  assert.ok(await until(() => f.row().phase === "Plugin stopped"));
  assert.ok(await until(() => f.row().status === "running"), "flying again");
  assert.equal(f.row().phase, null);
  assert.equal(f.row().why, null);
  await f.bots.stop(started.bot.botID, ACCOUNT.accountID);
});

test("⚠ a request naming a run of another plugin is refused", async () => {
  const log = [];
  const bots = createBotHost({
    webAuth: { createSessionToken: () => "core-only-token" }, baseUrl: "http://bff.test", errorLogger: () => {}, loadStack: await makeStack(log),
    pluginProcess: () => ({ checkRun: async () => ({ ok: true, setup: {}, name: "Run", policy: { riskClasses: ["combat"], restartSafe: true } }), startRun: async () => null, stopRun: async () => {} }),
    fetch: async () => { throw new Error("reached the BFF"); },
  });
  const started = await bots.start({ account: ACCOUNT, characterID: CHARACTER, kind: "plugin", pluginID: "probe", pluginRun: "probe", request: {}, grant: GRANT });
  assert.equal(started.ok, true, started.message);
  const answers = [];
  bots.pluginRunEvents.fetch("someone-else", (message) => answers.push(message), new Map(), { id: 1, botID: started.bot.botID, url: "/api/bridge/flight/status", method: "GET", headers: {} });
  assert.ok(await until(() => answers.some((answer) => answer.part === "end")));
  assert.equal(answers[0].status, 404);
});

test("the plugin says what a setup means and what it risks: a bad one, a wrong grant or a missing plugin never starts", async (t) => {
  const f = await makeFixture(t);
  const bad = await f.startRun({ bad: true });
  assert.deepEqual([bad.ok, bad.code, bad.message], [false, "PLUGIN_RUN_INVALID", "That setup is bad."]);
  const wrongGrant = await f.bots.start({ account: ACCOUNT, characterID: CHARACTER, kind: "plugin", pluginID: "probe", pluginRun: "probe", request: {}, grant: { ...GRANT, riskClasses: [] } });
  assert.equal(wrongGrant.ok, false);
  assert.equal(wrongGrant.code, "BOT_GRANT_STALE");
  const noSuchRun = await f.bots.start({ account: ACCOUNT, characterID: CHARACTER, kind: "plugin", pluginID: "probe", pluginRun: "nope", request: {}, grant: GRANT });
  assert.equal(noSuchRun.code, "PLUGIN_RUN_INVALID");
  const noPlugin = await f.bots.start({ account: ACCOUNT, characterID: CHARACTER, kind: "plugin", pluginID: "nobody", pluginRun: "probe", request: {}, grant: GRANT });
  assert.equal(noPlugin.code, "PLUGIN_RUN_UNAVAILABLE");
  assert.equal(f.bots.claimedBy(CHARACTER), null);
  assert.deepEqual(f.log, []);
});

test("Stop ends the plugin's loop before core brings the drones home and logs off", async (t) => {
  const f = await makeFixture(t);
  const started = await f.startRun();
  assert.ok(await until(() => f.row().phase === "Probing"));
  const stopped = await f.bots.stop(started.bot.botID, ACCOUNT.accountID);
  assert.equal(stopped.ok, true);
  const told = await f.heard("stopped");
  assert.deepEqual(told.botID, started.bot.botID);
  assert.equal(told.logged, 200, "a run being stopped can still write how it ended");
  assert.equal(told.anySpelling, 200, "the router ignores case and a trailing slash");
  assert.deepEqual([told.flown, told.read, told.otherBotRoute], [409, 409, 409], "and can do nothing else");
  assert.deepEqual(f.log.map(([name]) => name), ["select", "prepareHostedBotStop", "logout"]);
  assert.equal(f.bots.claimedBy(CHARACTER), null);
  const after = await f.request("POST", "/ask", { url: "/api/bridge/flight/status" });
  assert.equal(after.body.answer.error, "PLUGIN_RUN_ENDED");
});

test("a run that reaches its end by itself is released", async (t) => {
  const f = await makeFixture(t);
  await f.startRun({ endItself: true });
  const askedAtLogout = await new Promise((resolve) => {
    const look = setInterval(() => {
      if (!f.log.some(([name]) => name === "logout")) return;
      clearInterval(look);
      resolve(f.asked.filter((request) => request.url.endsWith("/api/bots/bot-log")).length);
    }, 1);
  });
  assert.ok(askedAtLogout > 0, "a run's last words come before its logoff");
  assert.ok(await until(() => f.bots.claimedBy(CHARACTER) === null));
  assert.equal(f.row().why, "Done by itself.");
  assert.equal((await f.heard("stopped")).logged, 200);
  assert.ok(f.asked.some((request) => request.url.endsWith("/api/bots/bot-log")), "its last words arrived before the logoff was asked for");
});

for (const [how, route] of [["killed", "/crash"], ["hung", "/hang"]]) {
  test(`⚠ a process ${how} mid-run comes back onto the pilot core still holds, with what it asked to keep`, async (t) => {
    const f = await makeFixture(t);
    const started = await f.startRun({ n: 9 });
    assert.ok(await until(() => f.row().phase === "Probing"));
    await f.request("GET", route);
    assert.ok(await until(() => f.row().phase === "Plugin stopped"), "the row says the plugin stopped");
    assert.ok(await until(async () => (await f.heard("started"))?.resumed === true), "the run was handed back");
    const heard = await f.heard("started");
    assert.equal(heard.botID, started.bot.botID);
    assert.deepEqual(heard.resumeData, { lap: 9 });
    assert.deepEqual(heard.routeSettings, { pfRouteType: "shortest" }, "a run that comes back still plans as its pilot does");
    assert.ok(await until(() => f.row().status === "running"));
    assert.equal(f.bots.claimedBy(CHARACTER), started.bot.botID);
    // No second select: it would drop the pilot from its fleet. And no recall.
    assert.deepEqual(f.log.map(([name]) => name), ["select"]);
    await f.bots.stop(started.bot.botID, ACCOUNT.accountID);
  });
}

test("⚠ a process that keeps dying gets its pilots recalled and docked, long before the host gives up on it", async (t) => {
  const f = await makeFixture(t);
  await f.startRun();
  for (let death = 1; death <= 2; death += 1) {
    assert.ok(await until(() => f.row().status === "running"));
    await f.request("GET", "/crash");
    assert.ok(await until(() => f.row().phase === "Plugin stopped"));
  }
  assert.ok(await until(() => f.row().status === "running"));
  await f.request("GET", "/crash");
  assert.ok(await until(() => f.log.some(([name]) => name === "logout")), "recalled and logged off");
  assert.deepEqual(f.log.map(([name]) => name), ["select", "panicRecallAndDock", "logout"]);
  assert.ok(await until(() => f.row().status === "error"));
  assert.match(f.row().why, /keeps stopping.*recalled, docked and logged off/);
  assert.equal(f.bots.claimedBy(CHARACTER), null);
  assert.notEqual(f.plugins().statuses()[0].state, "failed");
});

test("⚠ a process that does not come back in time gets its pilots recalled", async (t) => {
  const f = await makeFixture(t, { bots: { pluginDownRecallMs: 100 }, plugins: { backoffMs: [60_000] } });
  await f.startRun();
  assert.ok(await until(() => f.row().phase === "Probing"));
  await f.request("GET", "/crash");
  assert.ok(await until(() => f.log.some(([name]) => name === "logout")));
  assert.deepEqual(f.log.map(([name]) => name), ["select", "panicRecallAndDock", "logout"]);
  assert.match(f.row().why, /did not come back/);
});

test("⚠ a run the plugin says may not be restarted is recalled at once, not started again", async (t) => {
  const f = await makeFixture(t);
  await f.startRun({ restartSafe: false });
  assert.ok(await until(() => f.row().phase === "Probing"));
  await f.request("GET", "/crash");
  assert.ok(await until(() => f.log.some(([name]) => name === "logout")));
  assert.match(f.row().why, /cannot be restarted safely/);
  assert.equal((await f.heard("started")).resumed, false);
});

test("a bot saved under a kind core used to fly comes back as the plugin's run, with its saved row", async (t) => {
  const f = await makeFixture(t);
  await f.startRun({ n: 2 });
  const file = path.join(f.root, "data", "server-bots.json");
  assert.ok(await until(() => f.row().phase === "Probing"));
  assert.ok(await until(() => JSON.parse(fs.readFileSync(file, "utf8")).bots[0]?.resumeData?.lap === 2));
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const oldRow = { ...saved.bots[0], kind: "old-probe", scriptRev: 7, scriptHash: "a".repeat(64), abandonment: { since: 5 } };
  delete oldRow.pluginID;
  delete oldRow.pluginRun;
  delete oldRow.resumeData;

  const next = createBotHost(f.hostOptions);
  f.plugins().stop();
  await f.startPlugins(next.pluginRunEvents);
  fs.writeFileSync(file, JSON.stringify({ ...saved, bots: [oldRow] }));
  await next.resume();
  const back = next.list(ACCOUNT.accountID)[0];
  assert.equal(back?.kind, "plugin", JSON.stringify(back));
  assert.equal(back.plugin.pluginID, "probe");
  assert.ok(await until(async () => (await f.heard("started")).resumed === true));
  const heard = await f.heard("started");
  assert.equal(heard.resumeData.formerRow.kind, "old-probe");
  assert.deepEqual(heard.resumeData.formerRow.abandonment, { since: 5 });
  assert.deepEqual(heard.setup, { n: 2, restartSafe: true, endItself: false });
  await next.stop(back.botID, ACCOUNT.accountID);
});

test("a saved bot whose kind no plugin has taken over is reported, not flown", async (t) => {
  const f = await makeFixture(t);
  await f.startRun({ n: 2 });
  const file = path.join(f.root, "data", "server-bots.json");
  assert.ok(await until(() => f.row().phase === "Probing"));
  assert.ok(await until(() => JSON.parse(fs.readFileSync(file, "utf8")).bots[0]?.resumeData?.lap === 2));
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const next = createBotHost(f.hostOptions);
  f.plugins().stop();
  await f.startPlugins(next.pluginRunEvents);
  fs.writeFileSync(file, JSON.stringify({ ...saved, bots: [{ ...saved.bots[0], kind: "nobody-flies-this" }] }));
  await next.resume();
  assert.equal(next.list(ACCOUNT.accountID).some((row) => row.status === "running"), false);
});

test("a restart of the BFF brings the run back, checked again, with what the plugin asked to keep", async (t) => {
  const f = await makeFixture(t);
  await f.startRun({ n: 5 });
  assert.ok(await until(() => f.row().phase === "Probing"));
  assert.ok(await until(() => JSON.parse(fs.readFileSync(path.join(f.root, "data", "server-bots.json"), "utf8")).bots[0]?.resumeData?.lap === 5));
  const row = JSON.parse(fs.readFileSync(path.join(f.root, "data", "server-bots.json"), "utf8")).bots[0];
  assert.equal(row.kind, "plugin");
  assert.equal(row.pluginID, "probe");
  assert.equal(row.pluginRun, "probe");

  const next = createBotHost(f.hostOptions);
  // The old host's process is what the new host's plugin process replaces, as a restart of the BFF does.
  f.plugins().stop();
  await f.startPlugins(next.pluginRunEvents);
  await next.resume();
  assert.ok(await until(() => next.list(ACCOUNT.accountID)[0]?.phase === "Probing"));
  const resumed = next.list(ACCOUNT.accountID)[0];
  assert.equal(resumed.kind, "plugin");
  assert.deepEqual(resumed.plugin.readout, { asked: 200 });
  const heard = await f.heard("started");
  assert.equal(heard.resumed, true);
  assert.deepEqual(heard.resumeData, { lap: 5 });
  await next.stop(resumed.botID, ACCOUNT.accountID);
});
