"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const v8 = require("node:v8");
const vm = require("node:vm");
const { createBotHost, MAX_ENDED_RUNS } = require("./botHost");

// The retention test needs a collector it can run on demand. Plain `node --test` has no --expose-gc, so turn it on
// here and take the function from a fresh context rather than skipping the test.
v8.setFlagsFromString("--expose-gc");
const collectGarbage = global.gc ?? vm.runInNewContext("gc");

// The host is exercised with a FAKE browser stack (the loadStack seam): the
// real one is the shipping web/src modules, proven live; these tests pin the
// host's own obligations — claims, refusals, lifecycle, release-on-end.

const IDLE_SLICE = Object.freeze({
  status: "idle",
  name: null,
  phase: null,
  why: null,
  stepPath: null,
  interruptID: null,
  pauseReason: null,
  note: null,
  startError: null,
});

function makeFakeStack(log, extendFlow = null) {
  return async () => ({
    decodeScriptValue: (doc) =>
      doc && doc.valid === true
        ? { ok: true, doc, warnings: [] }
        : { ok: false, refusal: "That bot could not be read." },
    analyzeBotRunPolicy: (doc) => ({
      riskClasses: Array.isArray(doc.riskClasses) ? doc.riskClasses : [],
      restartSafe: doc.restartSafe !== false,
    }),
    validateBotLaunchGrant: (grant, scriptRev, policy) => {
      if (!grant || Number(grant.scriptRev) !== scriptRev) {
        return { ok: false, code: "BOT_GRANT_REQUIRED", message: "Review this run." };
      }
      if (
        !Array.isArray(grant.riskClasses) ||
        grant.riskClasses.length !== policy.riskClasses.length ||
        policy.riskClasses.some((risk) => !grant.riskClasses.includes(risk))
      ) {
        return { ok: false, code: "BOT_GRANT_STALE", message: "Permissions changed." };
      }
      return {
        ok: true,
        grant: {
          scriptRev,
          riskClasses: [...policy.riskClasses],
          maxRuntimeMinutes: Number(grant.maxRuntimeMinutes),
        },
      };
    },
    // What a plugin's run is granted against: the real module's shape, so the
    // host's one grant check reads it as it does in production.
    PLUGIN_RUN_GRANT_REV: 1,
    pluginRunBotPolicy: (policy) => ({
      macroIDs: [],
      restartBlockers: [],
      containsSubBots: false,
      riskClasses: policy.riskClasses,
      restartSafe: policy.restartSafe === true,
    }),
    createClientStore: () => {
      const listeners = new Set();
      const state = {
        station: { online: null },
        customBot: { ...IDLE_SLICE },
        flight: { status: null },
        space: { snapshot: null },
        mining: { holds: [] },
      };
      const store = {
        _set(partial) {
          Object.assign(state, partial);
          for (const listener of listeners) {
            listener(state);
          }
        },
        station: { get: () => state.station },
        customBot: { get: () => state.customBot },
        flight: { get: () => state.flight },
        space: { get: () => state.space },
        mining: { get: () => state.mining },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      log.push(["_store", store]);
      return store;
    },
    createAppFlow: (store, options) => {
      log.push(["createAppFlow", options.baseUrl, options.perSessionToken, options.initialSessionToken]);
      const flow = {
        async selectCharacter(characterID) {
          log.push(["selectCharacter", characterID]);
          store._set({ station: { online: { characterID, characterName: "Test Pilot" } } });
        },
        async startCustomBot(doc) {
          log.push(["startCustomBot", doc]);
          store._set({ customBot: { ...IDLE_SLICE, status: "running", phase: "Working" } });
        },
        stopCustomBot() {
          log.push(["stopCustomBot"]);
        },
        heldPilot: () => ({ characterID: 140000002, character: { name: "Test Pilot" }, station: null }),
        autopilotSettings: () => ({}),
        async prepareHostedBotStop(kind) {
          log.push(["prepareHostedBotStop", kind]);
          this.stopCustomBot();
          // The fake has no drones; the real flow separately proves its
          // authoritative read/recall/return gate.
        },
        async logout() {
          log.push(["logout"]);
        },
        // The vitals sampler's reads: populate the slices like the real flow.
        async loadFlightStatus() {
          store._set({ flight: { status: { docked: false, stationID: null } } });
        },
        async loadSpaceSnapshot() {
          store._set({
            space: { snapshot: { ship: { shieldRatio: 0.9, armorRatio: 1, hullRatio: 1 } } },
          });
        },
        async loadMiningHolds() {
          store._set({
            mining: {
              holds: [
                { label: "Ore hold", present: true, capacity: { used: 6000, capacity: 8000 } },
                { label: "Fuel bay", present: false, capacity: null },
              ],
            },
          });
        },
      };
      return extendFlow ? extendFlow(flow, store, options) : flow;
    },
  });
}

// A plugin that accepts any run and flies nothing, recording what the host asks of it. The host's own
// obligations around a plugin's run are tested here; the plugin's process itself is test/pluginRuns.test.js.
function makeStubPlugins(log) {
  return {
    async checkRun(pluginID, run, setup) {
      log.push(["checkRun", pluginID, run]);
      return { ok: true, name: "Stub run", setup: setup ?? {}, policy: { riskClasses: ["combat"], restartSafe: true } };
    },
    async startRun(pluginID, run) {
      log.push(["startRun", pluginID, run.resumed]);
      return null;
    },
    async stopRun(pluginID, botID) {
      log.push(["stopRun", pluginID, botID]);
    },
    formerBotKind: () => null,
  };
}

function makeHost({ log = [], isCharacterHeld = () => false, ...extras } = {}) {
  const stubPlugins = makeStubPlugins(log);
  return createBotHost({
    webAuth: { createSessionToken: () => "bot-token" },
    baseUrl: "http://127.0.0.1:0",
    isCharacterHeld,
    errorLogger: () => {},
    loadStack: makeFakeStack(log),
    pluginProcess: () => stubPlugins,
    createClaimSecret: () => "private-claim-capability",
    ...extras,
  });
}

const ACCOUNT = { accountID: 7, username: "test" };
const START = {
  account: ACCOUNT,
  characterID: 140000001,
  scriptID: "s1",
  scriptName: "Miner",
  scriptRev: 1,
  doc: { valid: true },
  grant: { scriptRev: 1, riskClasses: [], maxRuntimeMinutes: 720 },
};

// A plugin's run has no revision series: its grant's `scriptRev` is always PLUGIN_RUN_GRANT_REV.
const PLUGIN_START = {
  account: ACCOUNT,
  characterID: 140000002,
  kind: "plugin",
  pluginID: "stub",
  pluginRun: "stub",
  request: Object.freeze({ n: 1 }),
  grant: { scriptRev: 1, riskClasses: ["combat"], maxRuntimeMinutes: 720 },
};

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test("start flies the character on its own session and lists it", async () => {
  const log = [];
  const host = makeHost({ log });
  const outcome = await host.start(START);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.bot.status, "running");
  assert.equal(outcome.bot.characterName, "Test Pilot");
  assert.equal(host.claimedBy(140000001), outcome.bot.botID);
  const listed = host.list(7);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].botID, outcome.bot.botID);
  // Another account sees nothing.
  assert.equal(host.list(8).length, 0);
  // The flow was seeded with the minted token — no password ever crossed.
  const flowCall = log.find((row) => row[0] === "createAppFlow");
  assert.deepEqual(flowCall.slice(2), [true, "bot-token"]);
});

test("hosted pilots reach the in-process BFF while four other pilots are still waiting for replies", { timeout: 5000 }, async (t) => {
  const express = require("express");
  const { createInProcessFetch } = require("./inProcessFetch");
  const { loadBoundFleet } = await import("../web/src/app/api.ts");
  const { createAppFlow } = await import("../web/src/app/flow.ts");
  const { bridgeLane, hostedLane, MAX_IN_FLIGHT } = await import("../web/src/app/transport.ts");
  const { callMethod } = await import("../web/src/bridge/callMethod.ts");
  const { createClientStore } = await import("../web/src/store/clientStore.ts");
  const { promise: hold, resolve: release } = Promise.withResolvers();
  const received = [];
  const forwarded = [];
  const app = express();
  app.use(express.json());
  app.get("/api/bridge/bound-fleet", async (req, res) => {
    const token = req.get("authorization");
    received.push([req.path, token]);
    if (token !== `Bearer hosted-${MAX_IN_FLIGHT + 1}`) await hold;
    res.json({ ok: true });
  });
  app.post("/api/bridge/call", (req, res) => {
    received.push([req.path, req.get("authorization")]);
    res.json({ ok: true, service: req.body.service, method: req.body.method, result: 42 });
  });

  const baseUrl = "http://bff.test";
  const pilots = [];
  let tokenNumber = 0;
  const host = makeHost({
    baseUrl,
    fetch: createInProcessFetch(app, { baseUrl, fetch: async (input) => {
      forwarded.push(input);
      return Response.json({ ok: true });
    } }),
    webAuth: { createSessionToken: () => `hosted-${++tokenNumber}` },
    loadStack: makeFakeStack([], (flow, _store, options) => {
      pilots.push(createAppFlow(createClientStore(), options).requestOptions());
      return flow;
    }),
  });
  t.after(() => host.stopAll());
  for (let i = 0; i < MAX_IN_FLIGHT + 2; i += 1) {
    const started = await host.start({ ...START, characterID: START.characterID + i });
    assert.equal(started.ok, true);
  }

  const before = { http: bridgeLane.inFlight(), hosted: hostedLane.inFlight(), queued: hostedLane.queued() };
  const slow = pilots.slice(0, MAX_IN_FLIGHT).map(options => loadBoundFleet(options));
  const read = loadBoundFleet(pilots[MAX_IN_FLIGHT]);
  const call = callMethod("account", "GetCashBalance", [false], null, pilots[MAX_IN_FLIGHT + 1]);
  const requests = Promise.allSettled([...slow, read, call]);
  try {
    assert.equal(hostedLane.inFlight() - before.hosted, MAX_IN_FLIGHT + 2);
    assert.equal(hostedLane.queued(), before.queued);
    assert.equal(bridgeLane.inFlight(), before.http);
    assert.deepEqual(await read, { ok: true });
    assert.equal((await call).result, 42);
    assert.equal(hostedLane.inFlight() - before.hosted, MAX_IN_FLIGHT);

    const fallback = loadBoundFleet({ ...pilots[MAX_IN_FLIGHT], baseUrl: "http://elsewhere.test" });
    const fallbackInFlight = bridgeLane.inFlight();
    assert.deepEqual(await fallback, { ok: true });
    assert.equal(fallbackInFlight - before.http, 1);
    assert.deepEqual(forwarded, ["http://elsewhere.test/api/bridge/bound-fleet"]);

    const replaced = loadBoundFleet({ ...pilots[0], fetch: async () => Response.json({ ok: true }) });
    assert.equal(bridgeLane.inFlight() - before.http, 1);
    await replaced;
    await assert.rejects(callMethod("beyonce", "CmdStop", [], null, {
      ...pilots[MAX_IN_FLIGHT + 1], pilot: true, confirm: true,
      signal: AbortSignal.abort(new Error("command retired")),
    }), { code: "BRIDGE_NETWORK_ERROR", status: 0, message: /command retired.*Hosted BFF/ });
  } finally {
    release();
    await requests;
  }
  await Promise.all(slow);
  assert.deepEqual(received, pilots.map((options, i) => [
    i === MAX_IN_FLIGHT + 1 ? "/api/bridge/call" : "/api/bridge/bound-fleet", `Bearer ${options.token}`,
  ]));
  assert.equal(hostedLane.inFlight(), before.hosted);
});

test("unsafe browser handoff refuses before hosted selection and releases only its temporary claim", async () => {
  const log = [];
  const host = makeHost({ log });
  const outcome = await host.start({ ...START, beforeStart: async () => {
    throw Object.assign(new Error("Return controlled drones before handoff."), { code: "DRONE_HANDOFF_UNSAFE" });
  } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "DRONE_HANDOFF_UNSAFE");
  assert.equal(log.some(([name]) => name === "selectCharacter"), false);
  assert.equal(host.claimedBy(START.characterID), null);
});

test("the approved runtime deadline stops, logs out, and releases the character claim", async () => {
  const log = [];
  let deadline = null;
  const host = makeHost({
    log,
    now: () => 1_000,
    setDeadlineTimeout(callback, delayMs) {
      deadline = { callback, delayMs, unref() {} };
      return deadline;
    },
    clearDeadlineTimeout() {},
  });

  const started = await host.start({
    ...START,
    grant: { ...START.grant, maxRuntimeMinutes: 30 },
  });
  assert.equal(started.ok, true);
  assert.ok(deadline);
  assert.equal(deadline.delayMs, 30 * 60_000);

  deadline.callback();
  await settle();

  const [row] = host.list(ACCOUNT.accountID);
  assert.equal(row.status, "stopped");
  assert.match(row.why, /approved run time ended/i);
  assert.equal(host.claimedBy(START.characterID), null);
  assert.ok(log.some(([name]) => name === "stopCustomBot"));
  assert.ok(log.some(([name]) => name === "logout"));
});

// ── The deadline docks before it logs off ───────────────────────────────────
// A bot whose run time ran out used to go offline wherever it was. These pin
// the wind-down: fly in, dock, THEN release the pilot, bounded by a grace.

function deadlineHost(log, extendFlow) {
  let clock = 1_000;
  let deadline = null;
  const host = makeHost({
    log,
    loadStack: makeFakeStack(log, extendFlow),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    setDeadlineTimeout(callback, delayMs) {
      deadline = { callback, delayMs, unref() {} };
      return deadline;
    },
    clearDeadlineTimeout() {},
  });
  return { host, fire: () => deadline.callback(), advance: (ms) => (clock += ms) };
}

test("a script whose run time ends flies home, and logs off only once docked", async () => {
  const log = [];
  let docked = false;
  const { host, fire } = deadlineHost(log, (flow, store) => ({
    ...flow,
    headCustomBotHome(reason) {
      log.push(["headCustomBotHome", reason]);
      store._set({ customBot: { ...store.customBot.get(), phase: "Heading home", why: reason } });
      return true;
    },
    async loadFlightStatus() {
      store._set({ flight: { status: { docked, stationID: docked ? 60000001 : null } } });
    },
  }));
  const started = await host.start(START);
  assert.equal(started.ok, true);
  const store = log.find((row) => row[0] === "_store")[1];

  fire();
  await settle();
  // Still flying in: the pilot is held and nothing has logged it off.
  assert.ok(log.some(([name]) => name === "headCustomBotHome"));
  assert.equal(host.claimedBy(START.characterID), started.bot.botID);
  assert.equal(log.some(([name]) => name === "logout"), false);

  // The runner arrives and pauses docked, exactly as its own safe stop does.
  docked = true;
  store._set({ customBot: { ...store.customBot.get(), status: "paused" } });
  await settle();
  await settle();

  const [row] = host.list(ACCOUNT.accountID);
  assert.equal(row.status, "stopped");
  assert.match(row.why, /docked and logged off/i);
  assert.equal(host.claimedBy(START.characterID), null);
  assert.ok(log.some(([name]) => name === "logout"));
  assert.equal(log.some(([name]) => name === "panicRecallAndDock"), false);
});

test("a plugin's run whose run time ends stops its loop, recalls drones and docks before logging off", async () => {
  const log = [];
  let docked = false;
  const { host, fire } = deadlineHost(log, (flow, store) => ({
    ...flow,
    async panicRecallAndDock() {
      log.push(["panicRecallAndDock"]);
    },
    async loadFlightStatus() {
      log.push(["loadFlightStatus"]);
      store._set({ flight: { status: { docked, stationID: docked ? 60000001 : null } } });
    },
  }));
  const started = await host.start(PLUGIN_START);
  assert.equal(started.ok, true);

  fire();
  await settle();
  assert.ok(log.some(([name]) => name === "stopRun"), "the plugin's loop is told to stop first");
  assert.ok(log.some(([name]) => name === "panicRecallAndDock"));
  assert.equal(host.claimedBy(PLUGIN_START.characterID), started.bot.botID);
  assert.equal(log.some(([name]) => name === "logout"), false);

  docked = true;
  await settle();
  await settle();

  const [row] = host.list(ACCOUNT.accountID);
  assert.equal(row.status, "stopped");
  assert.match(row.why, /docked and logged off/i);
  assert.equal(host.claimedBy(PLUGIN_START.characterID), null);
  assert.ok(log.some(([name]) => name === "logout"));
});

test("a ship that cannot dock within the grace is still logged off, and says so", async () => {
  const log = [];
  const { host, fire } = deadlineHost(log, (flow) => ({
    ...flow,
    async panicRecallAndDock() {
      log.push(["panicRecallAndDock"]);
    },
  }));
  const started = await host.start(START);
  assert.equal(started.ok, true);

  fire();
  for (let i = 0; i < 400 && host.claimedBy(START.characterID) !== null; i += 1) {
    await settle();
  }

  const [row] = host.list(ACCOUNT.accountID);
  assert.equal(row.status, "stopped");
  assert.match(row.why, /could not dock in time/i);
  assert.equal(host.claimedBy(START.characterID), null);
  assert.ok(log.some(([name]) => name === "logout"));
});

test("a player's Stop during the wind-down logs off at once", async () => {
  const log = [];
  const { host, fire } = deadlineHost(log, (flow) => ({
    ...flow,
    async panicRecallAndDock() {
      log.push(["panicRecallAndDock"]);
    },
  }));
  const started = await host.start(START);
  fire();
  await settle();
  const stopped = await host.stop(started.bot.botID, ACCOUNT.accountID);
  assert.equal(stopped.ok, true);
  assert.equal(host.claimedBy(START.characterID), null);
  assert.equal(log.filter(([name]) => name === "logout").length, 1);
  assert.ok(log.some(([name]) => name === "stopCustomBot"), "the home runner is cancelled before manual finalization");
});

test("manual Stop cancels a pending deadline fallback before it can dock", async () => {
  const log = [];
  let enteredPanic;
  let finishRead;
  const entered = new Promise((resolve) => { enteredPanic = resolve; });
  const heldRead = new Promise((resolve) => { finishRead = resolve; });
  const { host, fire } = deadlineHost(log, (flow) => ({
    ...flow,
    async panicRecallAndDock(shouldAbort) {
      enteredPanic();
      await heldRead;
      if (!shouldAbort()) log.push(["dock-command"]);
    },
  }));
  const started = await host.start(START);
  fire();
  await entered;
  const stopped = host.stop(started.bot.botID, ACCOUNT.accountID);
  finishRead();
  assert.equal((await stopped).ok, true);
  assert.equal(log.some(([name]) => name === "dock-command"), false);
  assert.equal(log.filter(([name]) => name === "logout").length, 1);
});

test("manual Stop during the deadline home runner waits for its last issued action", async () => {
  const log = [];
  let enteredHome;
  let enteredCancellation;
  let settleIssuedAction;
  const homeEntered = new Promise((resolve) => { enteredHome = resolve; });
  const cancelEntered = new Promise((resolve) => { enteredCancellation = resolve; });
  const issuedAction = new Promise((resolve) => { settleIssuedAction = resolve; });
  const { host, fire } = deadlineHost(log, (flow, store) => ({
    ...flow,
    headCustomBotHome() { enteredHome(); return true; },
    cancelHostedHome() {
      store._set({ customBot: { ...store.customBot.get(), status: "paused" } });
      enteredCancellation();
      return issuedAction;
    },
  }));
  const started = await host.start(START);
  fire();
  await homeEntered;
  const manual = host.stop(started.bot.botID, ACCOUNT.accountID);
  await cancelEntered;
  assert.equal(host.claimedBy(START.characterID), started.bot.botID);
  assert.equal(log.some(([name]) => name === "logout"), false);
  settleIssuedAction();
  assert.equal((await manual).ok, true);
  assert.equal(log.filter(([name]) => name === "logout").length, 1);
});

test("an unconfirmed deadline home action blocks manual Stop without releasing control", async () => {
  const log = [];
  let enteredHome;
  let finishIssue;
  let attempts = 0;
  const homeEntered = new Promise((resolve) => { enteredHome = resolve; });
  const issueSettled = new Promise((resolve) => { finishIssue = resolve; });
  const { host, fire } = deadlineHost(log, (flow, store) => ({
    ...flow,
    headCustomBotHome() { enteredHome(); return true; },
    async cancelHostedHome() {
      store._set({ customBot: { ...store.customBot.get(), status: "paused" } });
      if (++attempts === 1) throw new Error("Home action still in flight");
      await issueSettled;
    },
  }));
  const started = await host.start(START);
  fire();
  await homeEntered;
  const blocked = await host.stop(started.bot.botID, ACCOUNT.accountID);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "CONTROL_SETTLEMENT_UNCONFIRMED");
  assert.equal(host.claimedBy(START.characterID), started.bot.botID);
  assert.equal(log.some(([name]) => name === "logout"), false);
  const retry = host.stop(started.bot.botID, ACCOUNT.accountID);
  await Promise.resolve();
  assert.equal(host.claimedBy(START.characterID), started.bot.botID);
  assert.equal(log.some(([name]) => name === "logout"), false);
  finishIssue();
  assert.equal((await retry).ok, true);
  assert.equal(attempts, 2);
  assert.equal(log.filter(([name]) => name === "logout").length, 1);
});

// ⚠ THE REGRESSION THIS PINS COST FIVE PILOTS HALF AN HOUR IN SPACE.
// The bot used to be minted the plain web default (12h) at the same instant its
// 12h deadline clock started, so the credential died as the deadline fired:
// `finalize`'s logout could not be authenticated, no bridge session was
// released, and the characters stayed online until the gateway's idle sweep.
test("the bot's token outlives its own deadline, so the teardown can still authenticate", async () => {
  const minted = [];
  const host = makeHost({
    now: () => 1_000,
    webAuth: {
      createSessionToken: (account, options) => {
        minted.push(options);
        return "bot-token";
      },
    },
  });

  const started = await host.start({ ...START, grant: { ...START.grant, maxRuntimeMinutes: 30 } });
  assert.equal(started.ok, true);
  assert.equal(minted.length, 1);
  assert.ok(
    minted[0].ttlMs > 30 * 60_000,
    `a ${minted[0].ttlMs}ms token cannot end a ${30 * 60_000}ms run`,
  );
  assert.equal(minted[0].ttlMs, (30 + 3 + 15 + 5) * 60_000,
    "approved run plus controlled-drone, dock, and teardown bounds");
});

test("manual Stop retains claim and session until the controlled-flight gate settles", async () => {
  const log = [];
  let finishGate;
  const gate = new Promise((resolve) => { finishGate = resolve; });
  const host = makeHost({ log, loadStack: makeFakeStack(log, (flow) => ({
    ...flow,
    async prepareHostedBotStop() { log.push(["safety-gate"]); await gate; },
  })) });
  const started = await host.start(START);
  const pending = host.stop(started.bot.botID, ACCOUNT.accountID);
  assert.equal(host.claimedBy(START.characterID), started.bot.botID);
  assert.equal(log.some(([name]) => name === "logout"), false);
  const repeated = host.stop(started.bot.botID, ACCOUNT.accountID);
  finishGate();
  assert.equal((await pending).ok, true);
  assert.equal((await repeated).ok, true);
  assert.equal(log.filter(([name]) => name === "safety-gate").length, 1);
  assert.equal(log.filter(([name]) => name === "logout").length, 1);
  assert.equal(host.claimedBy(START.characterID), null);
});

test("unconfirmed controlled flight blocks Stop without logout and can be retried", async () => {
  const log = [];
  let attempts = 0;
  const host = makeHost({ log, loadStack: makeFakeStack(log, (flow) => ({
    ...flow,
    async prepareHostedBotStop() {
      if (++attempts === 1) throw new Error("Authoritative drone state unreadable");
    },
  })) });
  const started = await host.start(START);
  const blocked = await host.stop(started.bot.botID, ACCOUNT.accountID);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "DRONE_RETURN_UNCONFIRMED");
  assert.equal(host.claimedBy(START.characterID), started.bot.botID);
  assert.equal(log.some(([name]) => name === "logout"), false);
  assert.equal((await host.stop(started.bot.botID, ACCOUNT.accountID)).ok, true);
  assert.equal(log.filter(([name]) => name === "logout").length, 1);
});

test("unconfirmed session logout retains the claim and a retry can release it", async () => {
  const log = [];
  let attempts = 0;
  const host = makeHost({ log, loadStack: makeFakeStack(log, (flow) => ({
    ...flow,
    async logout() {
      log.push(["logout"]);
      if (++attempts === 1) throw new Error("Gateway release unknown");
    },
  })) });
  const started = await host.start(START);
  const blocked = await host.stop(started.bot.botID, ACCOUNT.accountID);
  assert.equal(blocked.code, "PILOT_RELEASE_UNVERIFIED");
  assert.equal(host.claimedBy(START.characterID), started.bot.botID);
  assert.equal(host.list(ACCOUNT.accountID)[0].status, "paused");
  const retried = await host.stop(started.bot.botID, ACCOUNT.accountID);
  assert.equal(retried.ok, true);
  assert.equal(host.claimedBy(START.characterID), null);
  assert.equal(attempts, 2);
  assert.equal(log.filter(([name]) => name === "prepareHostedBotStop").length, 1,
    "a lost logout response retries release without requiring a now-dead drone session read");
});

test("pending logout retains a durable stop row and repeated Stop cannot report completion early", async () => {
  const log = [];
  const rosterPath = tempRosterPath();
  let beginLogout;
  let finishLogout;
  const entered = new Promise((resolve) => { beginLogout = resolve; });
  const held = new Promise((resolve) => { finishLogout = resolve; });
  const host = makeHost({ log, persistPath: rosterPath, loadStack: makeFakeStack(log, (flow) => ({
    ...flow,
    async logout() { beginLogout(); await held; log.push(["logout"]); },
  })) });
  const started = await host.start(START);
  const first = host.stop(started.bot.botID, ACCOUNT.accountID);
  await entered;
  assert.equal(host.claimedBy(START.characterID), started.bot.botID);
  assert.equal(readRosterFile(rosterPath)[0].stopRequested, true);
  let repeatedResolved = false;
  const repeated = host.stop(started.bot.botID, ACCOUNT.accountID).then((outcome) => {
    repeatedResolved = true;
    return outcome;
  });
  await Promise.resolve();
  assert.equal(repeatedResolved, false);
  finishLogout();
  assert.equal((await first).ok, true);
  assert.equal((await repeated).ok, true);
  assert.equal(readRosterFile(rosterPath).length, 0);
  assert.equal(log.filter(([name]) => name === "logout").length, 1);
});

test("deadline and manual Stop share one pending drone gate before logout", async () => {
  const log = [];
  let finishGate;
  const gate = new Promise((resolve) => { finishGate = resolve; });
  const { host, fire } = deadlineHost(log, (flow) => ({
    ...flow,
    async prepareHostedBotStop() { log.push(["safety-gate"]); await gate; },
  }));
  const started = await host.start(START);
  fire();
  const manual = host.stop(started.bot.botID, ACCOUNT.accountID);
  assert.equal(host.claimedBy(START.characterID), started.bot.botID);
  assert.equal(log.some(([name]) => name === "logout"), false);
  finishGate();
  assert.equal((await manual).ok, true);
  assert.equal(log.filter(([name]) => name === "safety-gate").length, 1);
  assert.equal(log.filter(([name]) => name === "logout").length, 1);
});

test("a resumed bot's token covers what its ORIGINAL grant has left, not a fresh run", async () => {
  const minted = [];
  const host = makeHost({
    now: () => 1_000,
    webAuth: {
      createSessionToken: (account, options) => {
        minted.push(options);
        return "bot-token";
      },
    },
  });

  // Ten minutes left of a twelve-hour grant: the token is minted for those ten
  // minutes, never for another twelve hours.
  const started = await host.start({
    ...START,
    resumed: true,
    expectedExpiresAt: new Date(1_000 + 10 * 60_000).toISOString(),
  });
  assert.equal(started.ok, true);
  assert.ok(minted[0].ttlMs > 10 * 60_000, "still enough to log out with");
  assert.ok(minted[0].ttlMs < 60 * 60_000, "but nowhere near a fresh grant");
});

test("a run's flow is given its pilot's route settings, where the host has them", async () => {
  const log = [];
  let given;
  const storage = { getItem: () => null, setItem: () => {} };
  const host = makeHost({
    log,
    loadStack: makeFakeStack(log, (flow, _store, options) => { given = options.storage; return flow; }),
    settingsStorageFor: (characterID) => (characterID === 140000001 ? storage : null),
  });
  assert.equal((await host.start(START)).ok, true);
  assert.equal(given, storage);

  // A host without them leaves the flow to its default, as before.
  let unset = "never built";
  const plain = makeHost({ loadStack: makeFakeStack([], (flow, _store, options) => { unset = options.storage; return flow; }) });
  assert.equal((await plain.start(START)).ok, true);
  assert.equal(unset, undefined);
});

test("a second bot may not take a claimed character", async () => {
  const host = makeHost();
  assert.equal((await host.start(START)).ok, true);
  const second = await host.start(START);
  assert.equal(second.ok, false);
  assert.equal(second.code, "BOT_ALREADY_RUNNING");
});

test("one client per account: a run on another pilot of the account is refused, naming the pilot flying", async () => {
  const log = [];
  const asked = [];
  const host = makeHost({ log, oneClientPerAccount: (who) => { asked.push(who); return true; } });
  assert.equal((await host.start(START)).ok, true);
  const second = await host.start({ ...START, characterID: 140000003 });
  assert.equal(second.ok, false);
  assert.equal(second.code, "ACCOUNT_IN_USE_BY_BOT");
  assert.match(second.message, /^Test Pilot is flying a server run/);
  assert.deepEqual(asked.at(-1), { accountID: 7, characterID: 140000003, userName: "test" });
  assert.equal(host.claimedBy(140000003), null);
  assert.equal(log.filter((row) => row[0] === "selectCharacter").length, 1, "the refused start never selects");
  // Another account is not this one's to wait on.
  const other = await host.start({ ...START, account: { accountID: 8, username: "other" }, characterID: 140000004 });
  assert.equal(other.ok, true);
});

test("one client per account: once the account's run ends, another pilot of it may start", async () => {
  const log = [];
  const host = makeHost({ log, oneClientPerAccount: () => true });
  await host.start(START);
  lastStore(log)._set({ customBot: { ...IDLE_SLICE, status: "stopped", phase: "Done" } });
  await settle();
  assert.equal((await host.start({ ...START, characterID: 140000003 })).ok, true);
});

test("an account whose pilots are not one client each may fly two runs at once", async () => {
  const host = makeHost({ oneClientPerAccount: () => false });
  assert.equal((await host.start(START)).ok, true);
  assert.equal((await host.start({ ...START, characterID: 140000003 })).ok, true);
});

test("only the private per-run capability authorizes a claimed character", async () => {
  const host = makeHost();
  const started = await host.start(START);
  assert.equal(started.ok, true);
  assert.equal(host.authorizesClaim(140000001, "private-claim-capability"), true);
  assert.equal(host.authorizesClaim(140000001, started.bot.botID), false, "the public bot ID is not authority");
  assert.equal(host.authorizesClaim(140000001, "bogus"), false);
  assert.equal(host.authorizesClaim(140000002, "private-claim-capability"), false);
});

test("a character a web session holds is refused", async () => {
  const host = makeHost({ isCharacterHeld: (characterID) => characterID === 140000001 });
  const outcome = await host.start(START);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "CHARACTER_IN_USE");
  assert.equal(host.claimedBy(140000001), null);
});

test("an undecodable doc is refused before any session exists", async () => {
  const log = [];
  const host = makeHost({ log });
  const outcome = await host.start({ ...START, doc: { valid: false } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "BOTSCRIPT_INVALID");
  assert.equal(log.some((row) => row[0] === "selectCharacter"), false);
});

test("a server run requires an exact revision-and-risk grant", async () => {
  const host = makeHost();
  assert.equal((await host.start({ ...START, grant: null })).code, "BOT_GRANT_REQUIRED");
  assert.equal(
    (await host.start({ ...START, grant: { ...START.grant, scriptRev: 2 } })).code,
    "BOT_GRANT_REQUIRED",
  );
  const risky = { ...START, doc: { valid: true, riskClasses: ["financial"] } };
  assert.equal((await host.start(risky)).code, "BOT_GRANT_STALE");
  assert.equal(
    (
      await host.start({
        ...risky,
        grant: { scriptRev: 1, riskClasses: ["financial"], maxRuntimeMinutes: 30 },
      })
    ).ok,
    true,
  );
});

test("stop releases the claim and the character", async () => {
  const log = [];
  const host = makeHost({ log });
  const started = await host.start(START);
  const stopped = await host.stop(started.bot.botID, 7);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.bot.status, "stopped");
  assert.notEqual(stopped.bot.endedAt, null);
  assert.equal(host.claimedBy(140000001), null);
  assert.equal(log.some((row) => row[0] === "logout"), true);
  // The record remains listable for inspection.
  assert.equal(host.list(7).length, 1);
});

test("activeCharacterIDs names exactly the characters bots are flying", async () => {
  const host = makeHost();
  assert.deepEqual(host.activeCharacterIDs(), []);
  const started = await host.start(START);
  assert.deepEqual(host.activeCharacterIDs(), [140000001]);
  await host.stop(started.bot.botID, 7);
  assert.deepEqual(host.activeCharacterIDs(), []);
});

test("stop is scoped to the owning account", async () => {
  const host = makeHost();
  const started = await host.start(START);
  const outcome = await host.stop(started.bot.botID, 8);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "BOT_NOT_FOUND");
  assert.notEqual(host.claimedBy(140000001), null);
});

test("a script that ends on its own releases the character", async () => {
  const log = [];
  const host = makeHost({ log });
  const started = await host.start(START);
  const record = host.list(7)[0];
  assert.equal(record.status, "running");
  // The runner lets go: the store reports the terminal status.
  const store = lastStore(log);
  store._set({ customBot: { ...IDLE_SLICE, status: "stopped", phase: "Done" } });
  await settle();
  assert.equal(host.claimedBy(140000001), null);
  assert.equal(log.some((row) => row[0] === "logout"), true);
  const after = host.list(7)[0];
  assert.equal(after.botID, started.bot.botID);
  assert.equal(after.status, "stopped");
  assert.notEqual(after.endedAt, null);
});

test("a pilot the game server closed mid-run ends the run as an error, never as finished", async () => {
  const log = [];
  const host = makeHost({
    log,
    closedByServer: (characterID) => characterID === 140000001
      ? { reasonCode: "CLIENTDISCONNECTED", reason: "Another client logged in to this account" }
      : null,
  });
  await host.start(START);
  const store = lastStore(log);
  store._set({ customBot: { ...IDLE_SLICE, status: "running", phase: "Collecting", stepPath: "collect-1" } });
  // Losing the session resets every slice to its start: offline, and an idle bot slice.
  store._set({ station: { online: null }, customBot: { ...IDLE_SLICE } });
  await settle();
  const after = host.list(7)[0];
  assert.equal(after.status, "error");
  assert.equal(after.why, "The game server closed this pilot's connection: Another client logged in to this account.");
  assert.equal(after.stepPath, "collect-1", "the last readout is kept, not the reset slice's");
  assert.notEqual(after.endedAt, null);
  assert.equal(host.claimedBy(140000001), null);
});

test("a pilot that went offline for no reason the server gave still ends as an error", async () => {
  const log = [];
  const host = makeHost({ log });
  await host.start(START);
  lastStore(log)._set({ station: { online: null }, customBot: { ...IDLE_SLICE } });
  await settle();
  const after = host.list(7)[0];
  assert.equal(after.status, "error");
  assert.equal(after.why, "The pilot went offline, so the run stopped.");
});

test("a fresh start on the character keeps the finished record — the ring replaces per-character pruning", async () => {
  const host = makeHost();
  const first = await host.start(START);
  await host.stop(first.bot.botID, 7);
  const second = await host.start(START);
  assert.equal(second.ok, true);
  const listed = host.list(7);
  assert.equal(listed.length, 2, "the finished run must not be dropped just because the character restarted");
  assert.ok(listed.some((row) => row.botID === first.bot.botID && row.status === "stopped"));
  assert.ok(listed.some((row) => row.botID === second.bot.botID && row.status === "running"));
});

// The fake stack hands each start a fresh store; tests that poke the store
// after start need the one the LAST start used. Cheapest honest way: capture
// it off the subscribe seam — the host subscribes exactly once per start.
function lastStore(log) {
  const call = [...log].reverse().find((row) => row[0] === "_store");
  assert.notEqual(call, undefined, "no store was captured — did start() succeed?");
  return call[1];
}

// ── Durability: the running roster survives a restart ───────────────────────

function tempRosterPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bot-host-")), "server-bots.json");
}

function readRosterFile(rosterPath) {
  return JSON.parse(fs.readFileSync(rosterPath, "utf8")).bots;
}

test("the running roster is mirrored to disk and cleared when the bot ends", async () => {
  const rosterPath = tempRosterPath();
  const host = makeHost({ persistPath: rosterPath });
  const started = await host.start(START);
  const persisted = readRosterFile(rosterPath);
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0], {
    kind: "script",
    accountID: 7,
    username: "test",
    characterID: 140000001,
    scriptID: "s1",
    scriptName: "Miner",
    scriptRev: 1,
    scriptHash: started.bot.scriptHash,
    logicalRunID: started.bot.logicalRunID,
    restartSafe: true,
    riskClasses: [],
    maxRuntimeMinutes: 720,
    expiresAt: started.bot.expiresAt,
    startedAt: started.bot.startedAt,
    stopRequested: false,
    stopBlocked: false,
  });
  assert.match(persisted[0].scriptHash, /^[a-f0-9]{64}$/);
  await host.stop(started.bot.botID, 7);
  assert.equal(readRosterFile(rosterPath).length, 0);
});

test("resume restarts a persisted bot on a fresh host (the restart path)", async () => {
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(START);
  // "The BFF restarted": a brand-new host, same file, no in-memory state.
  const after = makeHost({
    persistPath: rosterPath,
    loadAccount: async (username) => (username === "test" ? { ...ACCOUNT } : null),
    loadScript: (scriptID) =>
      scriptID === "s1" ? { scriptID: "s1", name: "Miner", rev: 1, doc: { valid: true } } : null,
  });
  await after.resume();
  const listed = after.list(7);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "running");
  assert.notEqual(listed[0].resumedAt, null);
  assert.equal(after.claimedBy(140000001), listed[0].botID);
  // The file now names the NEW run.
  const persisted = readRosterFile(rosterPath);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].startedAt, listed[0].startedAt);
});

test("resume looks up the script by ID alone — authorship is not account-scoped", async () => {
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(START);
  // The saved bot library is platform-wide: this script's record was authored
  // by a DIFFERENT account (99) than the one flying it (7, from ACCOUNT/START).
  // loadScript takes scriptID alone and must not be asked to filter by account.
  const after = makeHost({
    persistPath: rosterPath,
    loadAccount: async (username) => (username === "test" ? { ...ACCOUNT } : null),
    loadScript: (scriptID) =>
      scriptID === "s1"
        ? { scriptID: "s1", name: "Miner", rev: 1, doc: { valid: true }, authorAccountID: 99 }
        : null,
  });
  await after.resume();
  const listed = after.list(7);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "running");
  // Authority over the running bot stays with the flying account (7), not the
  // script's author (99): visible to 7, invisible and unstoppable by 99.
  assert.equal(after.list(99).length, 0);
  const stoppedByAuthor = await after.stop(listed[0].botID, 99);
  assert.equal(stoppedByAuthor.ok, false);
  assert.equal(stoppedByAuthor.code, "BOT_NOT_FOUND");
  assert.notEqual(after.claimedBy(140000001), null);
});

test("resume refuses a script whose saved revision changed after launch", async () => {
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(START);
  const after = makeHost({
    persistPath: rosterPath,
    loadAccount: async () => ({ ...ACCOUNT }),
    loadScript: () => ({ scriptID: "s1", name: "Miner", rev: 2, doc: { valid: true, edited: true } }),
  });
  await after.resume();
  const [row] = after.list(7);
  assert.equal(row.status, "error");
  assert.match(String(row.why), /changed after this run was authorized/i);
  assert.equal(after.claimedBy(140000001), null);
  assert.equal(readRosterFile(rosterPath).length, 0);
});

test("resume never replays a consequential script without a fresh start", async () => {
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start({
    ...START,
    doc: { valid: true, restartSafe: false, riskClasses: ["financial"] },
    grant: { ...START.grant, riskClasses: ["financial"] },
  });
  const after = makeHost({
    persistPath: rosterPath,
    loadAccount: async () => ({ ...ACCOUNT }),
    loadScript: () => ({
      scriptID: "s1",
      name: "Miner",
      rev: 1,
      doc: { valid: true, restartSafe: false, riskClasses: ["financial"] },
    }),
  });
  await after.resume();
  const [row] = after.list(7);
  assert.equal(row.status, "error");
  assert.match(String(row.why), /consequential action/i);
  assert.equal(after.claimedBy(140000001), null);
  assert.equal(readRosterFile(rosterPath).length, 0);
});

test("legacy unpinned roster rows require a manual start", async () => {
  const rosterPath = tempRosterPath();
  fs.writeFileSync(
    rosterPath,
    JSON.stringify({
      version: 1,
      bots: [
        {
          accountID: 7,
          username: "test",
          characterID: 140000001,
          scriptID: "s1",
          scriptName: "Miner",
          startedAt: new Date().toISOString(),
        },
      ],
    }),
    "utf8",
  );
  const host = makeHost({
    persistPath: rosterPath,
    loadAccount: async () => ({ ...ACCOUNT }),
    loadScript: () => ({ scriptID: "s1", name: "Miner", rev: 1, doc: { valid: true } }),
  });
  await host.resume();
  const [row] = host.list(7);
  assert.equal(row.status, "error");
  assert.match(String(row.why), /no pinned script revision/i);
  assert.equal(host.claimedBy(140000001), null);
});

test("an on-disk roster row with no `kind` field resumes exactly as a script always has", async () => {
  // A real pre-existing roster file, written by a version of this module that
  // had no `kind` field at all — the compatibility requirement decision 3
  // (docs/fleet-companion-handoff.md) names explicitly: an old row must still
  // resume exactly as it does today, not be refused for the field it lacks.
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(START);
  const raw = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  for (const row of raw.bots) {
    delete row.kind;
  }
  fs.writeFileSync(rosterPath, JSON.stringify(raw), "utf8");

  const after = makeHost({
    persistPath: rosterPath,
    loadAccount: async () => ({ ...ACCOUNT }),
    loadScript: (scriptID) =>
      scriptID === "s1" ? { scriptID: "s1", name: "Miner", rev: 1, doc: { valid: true } } : null,
  });
  await after.resume();
  const listed = after.list(7);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].kind, "script");
  assert.equal(listed[0].status, "running");
  assert.notEqual(listed[0].resumedAt, null);
  assert.equal(after.claimedBy(140000001), listed[0].botID);
});

test("resume skips retired MCC pilots and keeps ordinary scripts and UOC on the same roster", async () => {
  const persistPath = tempRosterPath();
  const before = makeHost({ persistPath });
  assert.equal((await before.start(START)).ok, true);
  assert.equal((await before.start({ ...PLUGIN_START, pluginID: "uoc", pluginRun: "mcc-miner",
    request: { operationID: "fleet" } })).ok, true);
  const roster = JSON.parse(fs.readFileSync(persistPath, "utf8"));
  const script = roster.bots.find(row => row.kind === "script");
  const custom = { ...script, characterID: 140000004, operationID: "old-fleet" };
  delete custom.kind;
  roster.bots.unshift({ ...script, characterID: 140000003, scriptID: "mcc.belt.hauler-service.miner" }, custom);
  fs.writeFileSync(persistPath, JSON.stringify(roster));

  const loaded = [];
  const after = makeHost({ persistPath, loadAccount: async () => ACCOUNT, loadScript(scriptID) {
    loaded.push(scriptID);
    return { scriptID, name: START.scriptName, rev: START.scriptRev, doc: START.doc };
  } });
  await after.resume();
  assert.deepEqual(loaded, [START.scriptID]);
  const rows = after.list(ACCOUNT.accountID);
  assert.deepEqual(rows.map(row => row.characterID).sort(), [START.characterID, PLUGIN_START.characterID]);
  assert.ok(rows.every(row => row.status === "running" && row.resumedAt != null));
  assert.equal(rows.find(row => row.kind === "plugin").plugin.run, "mcc-miner");
  assert.deepEqual(readRosterFile(persistPath).map(row => row.characterID).sort(), [START.characterID, PLUGIN_START.characterID]);
});

test("vitals sampling projects ship health, hold fill and the bot's words", async () => {
  const host = makeHost();
  await host.start(START);
  // The start's own first sample is still running: the tick waits for it.
  await host.sampleAllVitals();
  const rows = host.activeBots();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].characterID, 140000001);
  assert.equal(rows[0].status, "running");
  assert.equal(rows[0].phase, "Working");
  // The step id, so a board that started the run can draw how far it is.
  assert.equal("stepPath" in rows[0], true);
  const vitals = rows[0].vitals;
  assert.equal(vitals.docked, false);
  assert.equal(vitals.shield, 0.9);
  assert.equal(vitals.armor, 1);
  assert.equal(vitals.hull, 1);
  // Only PRESENT holds are reported.
  assert.deepEqual(vitals.holds, [{ label: "Ore hold", used: 6000, capacity: 8000 }]);
  // Nothing controllable or identifying rides on the unauthenticated rows.
  assert.equal("botID" in rows[0], false);
  assert.equal("accountID" in rows[0], false);
  assert.equal("scriptID" in rows[0], false);
});

test("vitals ticks skip a busy pilot and recover after completion or error", { timeout: 5000 }, async (t) => {
  const slowPilot = START.characterID;
  const fastPilot = slowPilot + 1;
  const sceneReads = new Map();
  const { promise: hold, resolve: release } = Promise.withResolvers();
  let holdNextScene = false;
  let failNextScene = false;
  let clock = 1_000;
  const host = makeHost({
    now: () => clock,
    loadStack: makeFakeStack([], (flow, store) => ({
      ...flow,
      async loadSpaceSnapshot() {
        const characterID = store.station.get().online.characterID;
        sceneReads.set(characterID, (sceneReads.get(characterID) ?? 0) + 1);
        if (characterID === slowPilot && holdNextScene) {
          holdNextScene = false;
          await hold;
        }
        if (characterID === slowPilot && failNextScene) {
          failNextScene = false;
          throw new Error("Space snapshot unavailable");
        }
        await flow.loadSpaceSnapshot();
      },
    })),
  });
  t.after(() => {
    release();
    return host.stopAll();
  });

  assert.equal((await host.start(START)).ok, true);
  assert.equal((await host.start({ ...START, characterID: fastPilot })).ok, true);
  await new Promise(setImmediate);
  const vitalsFor = (characterID) => host.activeBots().find((bot) => bot.characterID === characterID).vitals;
  const initialVitals = vitalsFor(slowPilot);

  clock += 15_000;
  holdNextScene = true;
  const pending = host.sampleAllVitals();
  let overlapping = Promise.resolve();
  try {
    await new Promise(setImmediate);
    assert.equal(sceneReads.get(slowPilot), 2);
    clock += 15_000;
    overlapping = host.sampleAllVitals();
    await new Promise(setImmediate);
    assert.equal(sceneReads.get(slowPilot), 2, "no second scene read while the first is pending");
    assert.equal(sceneReads.get(fastPilot), 3);
    assert.equal(vitalsFor(fastPilot).sampledAt, new Date(clock).toISOString());
    assert.deepEqual(vitalsFor(slowPilot), initialVitals);
  } finally {
    release();
    await pending;
  }
  // The overlapping tick waited for the slow pilot's sample rather than starting its own.
  await overlapping;
  assert.equal(sceneReads.get(slowPilot), 2, "skipped ticks are not replayed");
  assert.equal(vitalsFor(slowPilot).sampledAt, new Date(clock).toISOString());

  clock += 15_000;
  await host.sampleAllVitals();
  assert.equal(sceneReads.get(slowPilot), 3);
  const lastVitals = vitalsFor(slowPilot);
  assert.equal(lastVitals.sampledAt, new Date(clock).toISOString());

  clock += 15_000;
  failNextScene = true;
  await host.sampleAllVitals();
  assert.equal(sceneReads.get(slowPilot), 4);
  assert.deepEqual(vitalsFor(slowPilot), lastVitals);
  clock += 15_000;
  await host.sampleAllVitals();
  assert.equal(sceneReads.get(slowPilot), 5);
  assert.equal(vitalsFor(slowPilot).sampledAt, new Date(clock).toISOString());
});

test("stopping a pilot leaves a pending vitals read with no follow-up work", { timeout: 5000 }, async (t) => {
  const { promise: hold, resolve: release } = Promise.withResolvers();
  let sceneReads = 0;
  let holdReads = 0;
  const host = makeHost({
    loadStack: makeFakeStack([], (flow) => ({
      ...flow,
      async loadSpaceSnapshot() {
        if (++sceneReads === 2) await hold;
        await flow.loadSpaceSnapshot();
      },
      async loadMiningHolds() {
        holdReads += 1;
        await flow.loadMiningHolds();
      },
    })),
  });
  t.after(() => {
    release();
    return host.stopAll();
  });

  const started = await host.start(START);
  assert.equal(started.ok, true);
  await new Promise(setImmediate);
  const previousVitals = host.list(ACCOUNT.accountID)[0].vitals;
  const pending = host.sampleAllVitals();
  try {
    await new Promise(setImmediate);
    assert.equal(sceneReads, 2);
    assert.equal(holdReads, 1);
    assert.equal((await host.stop(started.bot.botID, ACCOUNT.accountID)).ok, true);
    assert.equal(host.claimedBy(START.characterID), null);

    const restarted = await host.start(START);
    assert.equal(restarted.ok, true);
    await new Promise(setImmediate);
    assert.equal(holdReads, 2);
    assert.ok(host.activeBots()[0].vitals);
  } finally {
    release();
    await pending;
  }
  assert.equal(holdReads, 2, "the stopped run must not read holds after the scene returns");
  const ended = host.list(ACCOUNT.accountID).find((bot) => bot.botID === started.bot.botID);
  assert.ok(ended.endedAt);
  assert.deepEqual(ended.vitals, previousVitals);
});

test("a bot whose script vanished leaves a visible error record, not silence", async () => {
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(START);
  const after = makeHost({
    persistPath: rosterPath,
    loadAccount: async () => ({ ...ACCOUNT }),
    loadScript: () => null,
  });
  await after.resume();
  const listed = after.list(7);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "error");
  assert.match(String(listed[0].why), /restarted/);
  assert.equal(after.claimedBy(140000001), null);
  // The failure is dropped from the roster file — it must not retry forever.
  assert.equal(readRosterFile(rosterPath).length, 0);
});

// A server bot has no browser to notify, so the "alert me" watch reaches the
// player ONLY through the record -> /api/bots -> the Server Bots readout. These
// pin that path, including that a later progress tick cannot erase an alert the
// player has not seen yet.

test("an alert on the store slice lands on the bot record and on the public row", async () => {
  const log = [];
  const host = makeHost({ log });
  await host.start(START);
  const store = lastStore(log);
  assert.equal(host.list(7)[0].lastAlert, null, "no alert before one fires");

  store._set({
    customBot: {
      ...IDLE_SLICE,
      status: "running",
      phase: "Working",
      lastAlert: { message: "Your bot noticed: another player locks onto your ship.", atMs: 1_700_000_000_000 },
    },
  });
  await settle();

  const row = host.list(7)[0];
  assert.deepEqual(row.lastAlert, {
    message: "Your bot noticed: another player locks onto your ship.",
    atMs: 1_700_000_000_000,
  });
});

test("a later progress tick with no alert does NOT clear one already recorded", async () => {
  const log = [];
  const host = makeHost({ log });
  await host.start(START);
  const store = lastStore(log);
  store._set({
    customBot: { ...IDLE_SLICE, status: "running", lastAlert: { message: "Trouble.", atMs: 5 } },
  });
  await settle();
  // The next ordinary tick carries no alert at all (the slice is rebuilt).
  store._set({ customBot: { ...IDLE_SLICE, status: "running", phase: "Mining" } });
  await settle();
  const row = host.list(7)[0];
  assert.equal(row.lastAlert && row.lastAlert.message, "Trouble.", "an unseen alert must not be erased");
  assert.equal(row.phase, "Mining", "while the rest of the readout still updates");
});

// ── The ended-run ring (M4: a bounded memory-only history, not a log) ──────

test("more than MAX_ENDED_RUNS ended runs keeps exactly MAX_ENDED_RUNS, evicting the oldest first", async () => {
  const clock = { value: 0 };
  const host = makeHost({ now: () => clock.value });
  const botIDs = [];
  for (let i = 0; i < MAX_ENDED_RUNS + 5; i++) {
    clock.value = i + 1;
    const started = await host.start({ ...START, characterID: 900_100_000 + i });
    const stopped = await host.stop(started.bot.botID, 7);
    botIDs.push(stopped.bot.botID);
  }
  const listed = host.list(7);
  assert.equal(listed.length, MAX_ENDED_RUNS);
  const survivingIDs = new Set(listed.map((row) => row.botID));
  for (let i = 0; i < 5; i++) {
    assert.equal(survivingIDs.has(botIDs[i]), false, `run ${i} (the oldest) should have aged out`);
  }
  for (let i = 5; i < botIDs.length; i++) {
    assert.equal(survivingIDs.has(botIDs[i]), true, `run ${i} should still be in the ring`);
  }
});

test("eviction picks the globally oldest endedAt, not the oldest by start (Map insertion) order", async () => {
  const clock = { value: 0 };
  const host = makeHost({ now: () => clock.value });

  // This bot STARTS first (first into the records Map) but is stopped LAST,
  // so it ends up with the NEWEST endedAt of anyone here. If eviction ever
  // regressed to Map/insertion order it would pick this one to evict; sorting
  // by endedAt must spare it instead.
  clock.value = 0;
  const lateFinisher = await host.start({ ...START, characterID: 900_150_000 });
  assert.equal(lateFinisher.ok, true);

  // Fill the ring to capacity with runs that both start AND end after
  // lateFinisher started, but whose endedAt values are all earlier than the
  // one lateFinisher will get.
  let oldestBotID = null;
  for (let i = 0; i < MAX_ENDED_RUNS; i++) {
    clock.value = i + 1;
    const started = await host.start({ ...START, characterID: 900_150_001 + i });
    const stopped = await host.stop(started.bot.botID, 7);
    if (i === 0) {
      oldestBotID = stopped.bot.botID;
    }
  }

  // Now finalize lateFinisher with the largest endedAt of the batch — its
  // finish pushes the ended count past the cap and forces an eviction.
  clock.value = 1000;
  await host.stop(lateFinisher.bot.botID, 7);

  const listed = host.list(7);
  assert.equal(listed.length, MAX_ENDED_RUNS);
  const survivingIDs = new Set(listed.map((row) => row.botID));
  assert.equal(survivingIDs.has(oldestBotID), false, "the run with the oldest endedAt is evicted");
  assert.equal(
    survivingIDs.has(lateFinisher.bot.botID),
    true,
    "the run that started earliest but ENDED latest must survive",
  );
});

test("a running bot is never evicted, even once the ring is full", async () => {
  const clock = { value: 0 };
  const host = makeHost({ now: () => clock.value });
  for (let i = 0; i < MAX_ENDED_RUNS; i++) {
    clock.value = i + 1;
    const started = await host.start({ ...START, characterID: 900_200_000 + i });
    await host.stop(started.bot.botID, 7);
  }
  assert.equal(host.list(7).length, MAX_ENDED_RUNS);

  clock.value = 1000;
  const running = await host.start({ ...START, characterID: 900_299_000 });
  assert.equal(running.ok, true);

  // One more finalized run pushes the ended count past the cap, forcing an
  // eviction while `running` is still in flight.
  clock.value = 1001;
  const another = await host.start({ ...START, characterID: 900_299_001 });
  await host.stop(another.bot.botID, 7);

  const listed = host.list(7);
  const runningRows = listed.filter((row) => row.status === "running");
  const endedRows = listed.filter((row) => row.status !== "running");
  assert.equal(runningRows.length, 1);
  assert.equal(runningRows[0].botID, running.bot.botID, "the ring's cap never touches a running record");
  assert.equal(endedRows.length, MAX_ENDED_RUNS, "the ended-only ring still holds exactly the cap");
});

test("two ended runs for the SAME character both survive (the old one-per-character rule would have dropped one)", async () => {
  const host = makeHost();
  const first = await host.start(START);
  await host.stop(first.bot.botID, 7);
  const second = await host.start(START);
  await host.stop(second.bot.botID, 7);
  const listed = host.list(7);
  assert.equal(listed.length, 2);
  assert.ok(listed.some((row) => row.botID === first.bot.botID && row.status === "stopped"));
  assert.ok(listed.some((row) => row.botID === second.bot.botID && row.status === "stopped"));
});

test("list(accountID) stays account-filtered, ended runs included", async () => {
  const host = makeHost();
  const ownedByOwner = await host.start(START);
  await host.stop(ownedByOwner.bot.botID, 7);
  const other = { accountID: 8, username: "other" };
  const ownedByOther = await host.start({ ...START, account: other, characterID: 140_099_999 });
  await host.stop(ownedByOther.bot.botID, 8);

  const ownerRows = host.list(7);
  assert.equal(ownerRows.length, 1);
  assert.equal(ownerRows[0].botID, ownedByOwner.bot.botID);

  const otherRows = host.list(8);
  assert.equal(otherRows.length, 1);
  assert.equal(otherRows[0].botID, ownedByOther.bot.botID);
});

// ── A saved row of a kind core no longer flies ──────────────────────────────
// Fleet companions used to be a kind of their own. A roster written then, read
// where no plugin has taken the kind over, is reported and not flown.

test("a saved row of kind \"companion\" with no plugin to take it over is reported, not flown", async () => {
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(START);
  const raw = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  raw.bots[0].kind = "companion";
  fs.writeFileSync(rosterPath, JSON.stringify(raw), "utf8");

  const log = [];
  const after = makeHost({
    log,
    persistPath: rosterPath,
    loadAccount: async () => ({ ...ACCOUNT }),
    loadScript: () => null,
  });
  await after.resume();
  // A kind no plugin has taken over: not a script, so it is not looked up as one.
  const [row] = after.list(ACCOUNT.accountID);
  assert.equal(row.kind, "script");
  assert.equal(row.status, "error");
  assert.match(row.why, /plugin that flew it is not running/);
  assert.equal(after.claimedBy(START.characterID), null);
  assert.equal(log.some(([event]) => event === "selectCharacter"), false);
});

// THE PI BOARD'S CORP READ: a read-only route may look up the session a running
// bot holds, and only the bot's OWN account may. Nothing else leaves the host.
function makeReadableHost() {
  return makeHost({
    webAuth: {
      createSessionToken: () => "bot-token",
      verifySessionToken: (token) => (token === "bot-token" ? { sessionID: "bot-web-session" } : null),
    },
  });
}

test("a running bot's session is readable by its own account", async () => {
  const host = makeReadableHost();
  assert.equal((await host.start(START)).ok, true);
  assert.equal(host.readableSessionOf(START.characterID, ACCOUNT.accountID), "bot-web-session");
});

test("another account's bot session is never handed out", async () => {
  const host = makeReadableHost();
  await host.start(START);
  assert.equal(host.readableSessionOf(START.characterID, ACCOUNT.accountID + 1), null);
});

test("a character no bot claims has no readable session", () => {
  const host = makeReadableHost();
  assert.equal(host.readableSessionOf(START.characterID, ACCOUNT.accountID), null);
});

test("a stopped bot's session is no longer readable", async () => {
  const host = makeReadableHost();
  const started = await host.start(START);
  await host.stop(started.bot.botID, ACCOUNT.accountID);
  assert.equal(host.readableSessionOf(START.characterID, ACCOUNT.accountID), null);
});

test("the readable session never reaches the public rows", async () => {
  const host = makeReadableHost();
  await host.start(START);
  const text = JSON.stringify([host.list(ACCOUNT.accountID), host.activeBots()]);
  assert.equal(text.includes("bot-web-session"), false);
});

test("hosted attachment keeps one logical run and WC restart restores its startup evidence with a fresh claim", async t => {
  const rosterPath = tempRosterPath(), dir = path.dirname(rosterPath);
  t.after(() => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true, force: true }); });
  const setup = { id: "setup", kind: "macro", macro: "undock", args: {} };
  const doc = { valid: true, program: [setup, { id: "main", kind: "loop", repeat: { kind: "forever" },
    body: [{ id: "work", kind: "macro", macro: "wait", args: {} }] }] };
  let beforeCheckpoint, afterCheckpoint, flows = 0;
  const before = makeHost({ persistPath: rosterPath, loadStack: makeFakeStack([], (flow, store, options) => {
    beforeCheckpoint = options.hostedStartup; flows++; return flow;
  }) });
  const started = await before.start({ ...START, doc }); assert.equal(started.ok, true);
  await beforeCheckpoint.observe(setup, { flightStatus: { shipID: 50, docked: false } });
  const logicalRunID = started.bot.logicalRunID;
  for (let refresh = 0; refresh < 3; refresh++) {
    assert.equal(before.list(7)[0].logicalRunID, logicalRunID);
    assert.equal(before.list(7)[0].botID, started.bot.botID);
  }
  assert.equal(flows, 1, "F5 reads the hosted roster without starting another flow");
  const after = makeHost({ persistPath: rosterPath, loadAccount: async () => ACCOUNT,
    loadScript: () => ({ scriptID: "s1", name: "Miner", rev: 1, doc }),
    createClaimSecret: () => "new-process-claim",
    loadStack: makeFakeStack([], (flow, store, options) => { afterCheckpoint = options.hostedStartup; return flow; }) });
  await after.resume(); const restored = after.list(7)[0];
  assert.equal(restored.status, "running"); assert.equal(restored.logicalRunID, logicalRunID);
  assert.notEqual(restored.botID, started.bot.botID);
  assert.equal(await afterCheckpoint.observe(setup, { flightStatus: { shipID: 50, docked: true } }), "COMPLETE");
  assert.equal(readRosterFile(rosterPath)[0].logicalRunID, logicalRunID);
  await after.stop(restored.botID, 7);
});

test("finished bot history releases pilot flows, stores, and their data", async (t) => {
  const log = [], references = [];
  const host = makeHost({
    log,
    webAuth: { createSessionToken: () => "owned-token", verifySessionToken: () => ({ sessionID: "owned-web-session" }) },
    loadStack: makeFakeStack(log, (flow, store) => {
      const routeGraph = { systems: Array(2 ** 20).fill(42) };
      const names = { entries: Array(2 ** 20).fill(43) };
      const hostedFlow = { ...flow, routeGraph };
      store._set({ names });
      references.push([hostedFlow, store, routeGraph, names].map(value => new WeakRef(value)));
      return hostedFlow;
    }),
  });
  t.after(() => host.stopAll());

  const started = [];
  for (const launch of [START, PLUGIN_START, { ...START, characterID: START.characterID + 2 }]) {
    const result = await host.start(launch);
    assert.equal(result.ok, true);
    started.push(result.bot);
  }
  await new Promise(setImmediate);
  // The fake stack normally logs a strong reference so other tests can drive its store.
  log.length = 0;
  for (const bot of started) {
    const first = await host.stop(bot.botID, ACCOUNT.accountID);
    const again = await host.stop(bot.botID, ACCOUNT.accountID);
    assert.equal(first.ok, true);
    assert.ok(first.bot.endedAt);
    assert.deepEqual(again, first);
    assert.equal(host.claimedBy(bot.characterID), null);
  }
  assert.equal(log.filter(row => row[0] === "logout").length, started.length);
  assert.equal(host.list(ACCOUNT.accountID).length, started.length);

  for (let turn = 0; turn < 4; turn++) {
    await new Promise(setImmediate);
    collectGarbage();
  }
  assert.deepEqual(references.map(run => run.map(ref => ref.deref() !== undefined)), [
    [false, false, false, false],
    [false, false, false, false],
    [false, false, false, false],
  ], "ended rows still retain flow, store, graph, or names");

  assert.equal((await host.start(START)).ok, true);
  const history = host.list(ACCOUNT.accountID).filter(bot => bot.endedAt);
  assert.deepEqual(new Set(history.map(bot => bot.botID)), new Set(started.map(bot => bot.botID)));
});

test("a bot ending during startup does not leave a deadline timer behind", async (t) => {
  const log = [];
  const logoutStarted = Promise.withResolvers();
  const finishLogout = Promise.withResolvers();
  let deadline = null;
  const host = makeHost({
    log,
    loadStack: makeFakeStack(log, (flow, store) => ({
      ...flow,
      async startCustomBot(doc) {
        await flow.startCustomBot(doc);
        store._set({ customBot: { ...IDLE_SLICE, status: "stopped" } });
        await logoutStarted.promise;
      },
      async logout() {
        logoutStarted.resolve();
        await finishLogout.promise;
      },
    })),
    setDeadlineTimeout(callback) {
      deadline = callback;
      return {};
    },
  });
  t.after(() => host.stopAll());
  const started = await host.start(START);
  finishLogout.resolve();
  assert.equal(started.ok, true);
  assert.ok((await host.stop(started.bot.botID, ACCOUNT.accountID)).bot.endedAt);
  assert.equal(deadline, null);
});

test("a Stop that begins while the character is being selected starts no work and keeps no store listener", async (t) => {
  const log = [];
  const selecting = Promise.withResolvers();
  const finishSelect = Promise.withResolvers();
  const logoutStarted = Promise.withResolvers();
  const finishLogout = Promise.withResolvers();
  let listeners = 0;
  const host = makeHost({
    log,
    loadStack: makeFakeStack(log, (flow, store) => {
      const subscribe = store.subscribe;
      store.subscribe = (listener) => {
        listeners++;
        const unsubscribe = subscribe(listener);
        return () => { listeners--; unsubscribe(); };
      };
      return {
        ...flow,
        async selectCharacter(characterID) {
          selecting.resolve();
          await finishSelect.promise;
          await flow.selectCharacter(characterID);
        },
        async logout() {
          logoutStarted.resolve();
          await finishLogout.promise;
          await flow.logout();
        },
      };
    }),
  });
  t.after(() => host.stopAll());
  const starting = host.start(START);
  await selecting.promise;
  const botID = host.claimedBy(START.characterID);
  assert.ok(botID);
  const stopping = host.stop(botID, ACCOUNT.accountID);
  await logoutStarted.promise;
  finishSelect.resolve();
  const started = await starting;
  finishLogout.resolve();
  const stopped = await stopping;
  assert.equal(started.ok, true);
  assert.ok(stopped.bot.endedAt);
  assert.equal(log.some(row => row[0] === "startCustomBot"), false);
  assert.equal(listeners, 0);
});
