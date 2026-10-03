"use strict";

// Real public routes + real botHost + its production ownership probe. Only the
// gameplay/browser stack and gateway are fake. Older route tests fake the host
// and therefore never probe the reservation created by the route itself.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { once } = require("node:events");
process.env.EVEJS_WEB_POC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-start-ownership-"));
const replenishment = require("../src/replenishment");
const makeReplenishment = replenishment.createReplenishment;
let operations;
// Capture the EXISTING private map at its constructor seam, never a replacement
// ownership registry. This permits fault-injected stale/foreign reservations.
replenishment.createReplenishment = options => {
  operations = options.operations;
  return makeReplenishment(options);
};
const { createApp } = require("../src/server");
replenishment.createReplenishment = makeReplenishment;
const hostModule = require("../src/botHost"), webAuth = require("../src/webAuth");
const account = { username: "Test05", accountID: 44, role: "0", banned: false };
const characterID = 140000045;
const doc = { format: "evejs-bot-script", version: 1, program: [] };
const script = { scriptID: "test-patrol", name: "Test patrol", rev: 1, doc };
const grant = { scriptRev: 1, riskClasses: [], maxRuntimeMinutes: 10 };
const idle = { status: "idle", phase: null, why: null, startError: null };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function harness(t) {
  const calls = [], sessions = new Map(), probes = [], starts = [];
  let baseUrl, serial = 0, ownershipProbe, probeHook = null;
  const behavior = { selectFailure: false, releaseUncertain: false, startFailure: false, retailBusy: false };
  const gateway = {
    async getCharacterStatus(_accountID, id) {
      if (behavior.statusHook) await behavior.statusHook();
      return { characterID: id, online: behavior.retailBusy || sessions.size > 0,
        controlState: behavior.retailBusy ? "retail_client" : sessions.size ? "browser_pilot" : "offline" };
    },
    async readFlightStatus() { return { flight: { docked: true, inSpace: false, shipID: 9001, stationID: 60000004 } }; },
    async selectCharacter(args) {
      calls.push(["select", args[0]]);
      if (behavior.selectFailure) throw Object.assign(new Error("Selection refused."), { code: "CALL_REFUSED" });
      const bridgeSessionID = `test-bridge-${++serial}`;
      const outcome = { bridgeSessionID, session: { characterID: args[0], shipID: 9001, stationID: 60000004, solarSystemID: 30000001 }, notifications: [] };
      sessions.set(bridgeSessionID, outcome);
      return outcome;
    },
    async selectFactoryCharacter(_accountID, id) {
      calls.push(["free-select", id]);
      if (behavior.retailBusy || sessions.size) throw Object.assign(new Error("PILOT_BUSY"), { code: "CALL_REFUSED" });
      return this.selectCharacter([id]);
    },
    async releaseBridgeSession(id) {
      calls.push(["release", id]);
      if (behavior.releaseUncertain) return { released: false };
      sessions.delete(id); return { released: true, offline: sessions.size === 0 };
    },
    async callMethod() { return { result: {}, notifications: [] }; },
    openSessionEventStream() { return { close() {} }; },
  };
  const loadStack = async () => ({
    decodeScriptValue: value => ({ ok: true, doc: value }),
    analyzeBotRunPolicy: () => ({ riskClasses: [], restartSafe: true }),
    decodeCompanionSetupValue: value => ({ ok: true, setup: value }),
    analyzeCompanionRunPolicy: () => ({ riskClasses: [], restartSafe: true }),
    COMPANION_GRANT_SCRIPT_REV: 1,
    validateBotLaunchGrant: value => ({ ok: true, grant: value }),
    createClientStore() {
      const listeners = new Set(), state = { station: { online: null }, flight: { status: null }, space: { snapshot: null },
        mining: { holds: [] }, customBot: { ...idle }, companion: { ...idle } };
      return { ...Object.fromEntries(Object.keys(state).map(key => [key, { get: () => state[key] }])),
        set(key, value) { state[key] = value; for (const listener of listeners) listener(state); },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
    },
    createAppFlow(store, options) {
      async function request(route, body) {
        const response = await options.fetch(`${baseUrl}${route}`, { method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.initialSessionToken}` }, body: JSON.stringify(body || {}) });
        const value = await response.json();
        if (!response.ok) throw Object.assign(new Error(value.message || value.error), { code: value.error });
        return value;
      }
      return {
        async selectCharacter(id) { const selected = await request("/api/bridge/select", { characterID: id }); store.set("station", { online: selected.character }); },
        async startCustomBot() {
          if (behavior.startFailure) throw new Error("Injected start failure.");
          calls.push(["run"]); store.set("customBot", { ...idle, status: "running" });
        },
        stopCustomBot() { calls.push(["cancel"]); },
        async startFleetCompanion() { store.set("companion", { ...idle, status: "running" }); },
        stopFleetCompanion() {},
        async prepareHostedBotStop() {},
        async logout() { await request("/api/logout"); store.set("station", { online: null }); },
        async loadFlightStatus() { store.set("flight", { status: { docked: true } }); },
        async loadSpaceSnapshot() {}, async loadMiningHolds() {},
      };
    },
  });
  const makeHost = hostModule.createBotHost;
  hostModule.createBotHost = options => {
    ownershipProbe = options.isCharacterHeld;
    return makeHost({ ...options, persistPath: null, loadStack,
      isCharacterHeld: async (...args) => { probes.push(args); if (probeHook) await probeHook(args); return ownershipProbe(...args); } });
  };
  let app;
  try {
    app = createApp({ webAuth, eveGatewayClient: gateway, errorLogger() {},
      eveStore: { getAccount: async name => name === account.username ? account : null,
        getCharacterForAccount: async (id, pilot) => id === account.accountID && pilot === characterID ? { characterID, characterName: "Test Pilot" } : null,
        listCharactersForAccount: async () => [{ characterID, characterName: "Test Pilot" }] },
      botScriptStore: { get: id => id === script.scriptID ? script : null, list: () => [script] } });
  } finally { hostModule.createBotHost = makeHost; }
  const reservationMap = operations;
  const originalStart = app.locals.botHost.start;
  app.locals.botHost.start = input => { starts.push(input); return originalStart(input); };
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const token = webAuth.createSessionToken(account), caller = webAuth.verifySessionToken(token).sessionID;
  async function post(route, body, credential = token) {
    const response = await fetch(`${baseUrl}${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential}` }, body: JSON.stringify(body || {}) });
    return { status: response.status, body: await response.json() };
  }
  t.after(async () => {
    behavior.releaseUncertain = false; behavior.retailBusy = false; probeHook = null;
    await app.locals.botHost.stopAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  return { app, calls, sessions, probes, starts, behavior, reservations: reservationMap, caller, token,
    async browser(credential = token) {
      const selected = await post("/api/bridge/select", { characterID }, credential);
      assert.equal(selected.status, 200);
      const ready = await post("/api/bridge/drone-recovery/ready", { checkID: selected.body.droneRecoveryCheckID }, credential);
      assert.equal(ready.status, 200);
    },
    probe: (...args) => ownershipProbe(...args), hook: fn => { probeHook = fn; }, post,
    start: credential => post("/api/bots/start", { characterID, scriptID: script.scriptID, grant }, credential),
    stop: botID => post(`/api/bots/${botID}/stop`) };
}

test("public Start permits its exact private reservation through the real host ownership probe", async t => {
  const h = await harness(t), result = await h.start();
  assert.equal(h.probes.length, 1, "the production host probed ownership");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.bot.status, "running");
  assert.equal(h.app.locals.botHost.claimedBy(characterID), result.body.bot.botID);
  assert.equal(h.reservations.size, 0, "the temporary reservation transferred into one hosted claim");
  assert.equal(h.app.locals.bridgeSessions.size, 1);
  assert.equal(h.calls.filter(([name]) => name === "free-select").length, 1);
  assert.equal("probeReservation" in result.body.bot, false);
  assert.equal((await h.stop(result.body.bot.botID)).status, 200);
  assert.equal(h.sessions.size, 0); assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
});

test("exact identity in both maps is required, never a name, character or session alone", async t => {
  const h = await harness(t), entered = deferred(), release = deferred();
  h.hook(async args => { entered.resolve(args); await release.promise; });
  const pending = h.start(), args = await entered.promise, own = h.reservations.get(characterID);
  try {
    assert.equal(typeof own, "symbol");
    assert.equal(args[3], own);
    assert.equal(await h.probe(characterID, h.caller, null, own), false);
    for (const impostor of [Symbol("bot-handoff"), "bot-handoff", characterID, { kind: "bot-handoff" }])
      assert.equal(await h.probe(characterID, h.caller, null, impostor), true);
    assert.equal(await h.probe(characterID, "different-session", null, own), true);
    assert.equal(await h.probe(characterID + 1, h.caller, null, own), true);
  } finally { release.resolve(); }
  const result = await pending; assert.equal(result.status, 200);
  assert.equal(await h.probe(characterID, h.caller, null, own), true, "a retired reservation is not authority even on a free map");
});

test("fresh restart uses a new reservation, bot and logical generation; stale callbacks cannot steal it", async t => {
  const h = await harness(t), first = await h.start(), previous = h.starts[0];
  assert.equal(first.status, 200); assert.equal((await h.stop(first.body.bot.botID)).status, 200);
  const second = await h.start(); assert.equal(second.status, 200);
  assert.notEqual(h.starts[1].probeReservation, previous.probeReservation);
  assert.notEqual(second.body.bot.botID, first.body.bot.botID);
  assert.notEqual(second.body.bot.logicalRunID, first.body.bot.logicalRunID);
  const before = h.calls.length;
  await assert.rejects(previous.beforeStart(), error => error.code === "CHARACTER_IN_USE");
  assert.equal(await h.probe(characterID, h.caller, null, previous.probeReservation), true);
  assert.equal(h.calls.length, before);
  assert.equal(h.app.locals.botHost.claimedBy(characterID), second.body.bot.botID);
  assert.equal(h.sessions.size, 1);
});

for (const kind of ["factory", "temporary-provisioning", "hosted-other", "mining-operation-handoff"])
  test(`public Start cannot replace or clean another ${kind} reservation`, async t => {
    const h = await harness(t), foreign = { kind, operationID: "other", operationRunID: "other-generation" };
    h.reservations.set(characterID, foreign);
    try {
      const result = await h.start(); assert.equal(result.status, 409);
      assert.equal(h.reservations.get(characterID), foreign); assert.equal(h.calls.length, 0);
    } finally { h.reservations.delete(characterID); }
  });

test("another browser owner is never released by a refused Start", async t => {
  const h = await harness(t), other = webAuth.createSessionToken(account);
  await h.browser(other); const owner = [...h.app.locals.bridgeSessions.values()][0], before = h.calls.length;
  const result = await h.start(); assert.equal(result.status, 409); assert.equal(result.body.error, "CHARACTER_IN_USE");
  assert.equal([...h.app.locals.bridgeSessions.values()][0], owner); assert.equal(h.calls.length, before);
  await h.post("/api/logout", {}, other);
});

test("retail owner is refused before a hosted claim or selection", async t => {
  const h = await harness(t); h.behavior.retailBusy = true;
  const result = await h.start(); assert.equal(result.status, 409);
  assert.equal(h.calls.length, 0); assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
  assert.equal(h.reservations.size, 0); assert.equal(h.behavior.retailBusy, true);
});

test("an external owner appearing after the probe is protected by atomic free-only selection", async t => {
  const h = await harness(t), makeFlowGate = deferred(), release = deferred();
  // beforeStart is called after the ownership probe and claim; simulate a
  // retail login during that gap without a fake client's takeover authority.
  const original = h.app.locals.botHost.start;
  h.app.locals.botHost.start = input => original({ ...input, beforeStart: async owner => {
    makeFlowGate.resolve(); await release.promise; return input.beforeStart(owner);
  } });
  const pending = h.start(); await makeFlowGate.promise; h.behavior.retailBusy = true; release.resolve();
  const result = await pending; assert.notEqual(result.status, 200);
  assert.equal(h.calls.some(([name]) => name === "select"), false);
  assert.equal(h.behavior.retailBusy, true); assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
});

test("another running hosted bot remains the sole owner after a second Start", async t => {
  const h = await harness(t), first = await h.start(); assert.equal(first.status, 200);
  const before = h.calls.length, refused = await h.start();
  assert.equal(refused.status, 409); assert.equal(refused.body.error, "BOT_ALREADY_RUNNING");
  assert.equal(h.calls.length, before); assert.equal(h.app.locals.botHost.claimedBy(characterID), first.body.bot.botID);
  assert.equal(h.reservations.size, 0); assert.equal(h.sessions.size, 1);
});

test("unresolved custody still blocks an exact self-reservation", async t => {
  const h = await harness(t); h.app.locals.replenishment.unresolved = () => [{ key: "unresolved-write" }];
  const result = await h.start(); assert.equal(result.status, 409);
  assert.equal(h.calls.length, 0); assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
});

test("existing MCC same-run handoff exception is unchanged and excludes other generations", async t => {
  const h = await harness(t), own = { kind: "mining-operation-handoff", operationID: "operation", operationRunID: "generation-1" };
  h.reservations.set(characterID, own);
  try {
    const intent = { operationRunID: "generation-1", operationPreparation: { operationID: "operation" } };
    assert.equal(await h.probe(characterID, null, intent), false);
    assert.equal(await h.probe(characterID, null, { ...intent, operationRunID: "generation-2" }), true);
    assert.equal(await h.probe(characterID, null, { ...intent, operationPreparation: { operationID: "other" } }), true);
    assert.equal((await h.start()).status, 409);
  } finally { h.reservations.delete(characterID); }
});

for (const failure of ["selectFailure", "startFailure"])
  test(`${failure} retires only this Start and allows a fresh attempt`, async t => {
    const h = await harness(t); h.behavior[failure] = true;
    assert.notEqual((await h.start()).status, 200);
    assert.equal(h.sessions.size, 0); assert.equal(h.reservations.size, 0);
    assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
    assert.equal(h.app.locals.botHost.list(account.accountID).some(row => row.status === "running"), false);
    h.behavior[failure] = false; assert.equal((await h.start()).status, 200);
  });

test("a failure after caller handoff restores only the released caller", async t => {
  const h = await harness(t); await h.browser(); h.behavior.startFailure = true;
  const old = h.app.locals.bridgeSessions.get(h.caller), result = await h.start();
  assert.notEqual(result.status, 200);
  const restored = h.app.locals.bridgeSessions.get(h.caller);
  assert.equal(restored?.characterID, characterID); assert.notEqual(restored, old);
  assert.equal(h.sessions.size, 1); assert.equal(h.reservations.size, 0);
  assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
  await h.post("/api/logout");
});

test("unconfirmed browser release preserves the original owner and does not run the bot", async t => {
  const h = await harness(t); await h.browser(); h.behavior.releaseUncertain = true;
  const owner = h.app.locals.bridgeSessions.get(h.caller), result = await h.start();
  assert.equal(result.status, 409); assert.equal(result.body.error, "PILOT_RELEASE_UNVERIFIED");
  assert.equal(h.app.locals.bridgeSessions.get(h.caller), owner); assert.equal(h.sessions.size, 1);
  assert.equal(h.calls.some(([name]) => name === "run"), false); assert.equal(h.reservations.size, 0);
  h.behavior.releaseUncertain = false; await h.post("/api/logout");
});

test("unconfirmed acquired-session cleanup retains hosted ownership until a proven Stop", async t => {
  const h = await harness(t); h.behavior.startFailure = true; h.behavior.releaseUncertain = true;
  assert.notEqual((await h.start()).status, 200);
  const botID = h.app.locals.botHost.claimedBy(characterID); assert.ok(botID);
  assert.equal(h.app.locals.botHost.list(account.accountID)[0].status, "paused");
  assert.equal((await h.start()).status, 409); assert.equal(h.sessions.size, 1);
  h.behavior.releaseUncertain = false;
  assert.equal((await h.stop(botID)).status, 200); assert.equal(h.sessions.size, 0);
  assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
});

test("two concurrent Starts have one winner and no duplicate ownership", async t => {
  const h = await harness(t), entered = deferred(), release = deferred();
  h.hook(async () => { entered.resolve(); await release.promise; });
  const first = h.start(); await entered.promise;
  const second = await h.start(webAuth.createSessionToken(account)); assert.equal(second.status, 409);
  release.resolve(); assert.equal((await first).status, 200);
  assert.equal(h.starts.length, 1); assert.equal(h.sessions.size, 1); assert.equal(h.reservations.size, 0);
  assert.equal(h.calls.filter(([name]) => name === "run").length, 1);
});

test("a stale late probe cannot claim or remove a replacement reservation", async t => {
  const h = await harness(t), entered = deferred(), release = deferred(), foreign = Symbol("replacement-owner");
  h.behavior.statusHook = async () => { entered.resolve(); await release.promise; };
  const pending = h.start(); await entered.promise; h.reservations.set(characterID, foreign); release.resolve();
  try {
    const result = await pending; assert.equal(result.status, 409);
    assert.equal(h.reservations.get(characterID), foreign); assert.equal(h.calls.length, 0);
    assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
  } finally { h.reservations.delete(characterID); }
});

test("public companion Start passes the same exact reservation contract", async t => {
  const h = await harness(t), result = await h.post("/api/bots/start", { characterID, kind: "companion", request: {}, grant });
  assert.equal(result.status, 200); assert.equal(result.body.bot.kind, "companion");
  assert.equal(typeof h.starts[0].probeReservation, "symbol");
  assert.equal(h.reservations.size, 0); assert.equal((await h.stop(result.body.bot.botID)).status, 200);
});
