"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBotHost } = require("./botHost");

const account = { accountID: 7, username: "test" };
const doc = { valid: true };
const launch = { account, characterID: 140000001, scriptID: "mcc.test", scriptName: "Miner", scriptRev: 1, doc,
  grant: { scriptRev: 1, riskClasses: ["fleet"], maxRuntimeMinutes: 10 }, operationID: "op", operationRole: "MINER" };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function waitUntil(check) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail("Recovery did not reach its expected state."); }
function fixture(overrides = {}) {
  const log = []; let fetcher, secret = 0, selected = 0;
  const state = { station: { online: null }, flight: { status: { shipID: 9001 } }, space: { snapshot: null },
    customBot: { status: "idle" } };
  const listeners = new Set();
  const push = snapshot => { state.customBot = snapshot; for (const listener of listeners) listener(state); };
  const store = { station: { get: () => state.station }, flight: { get: () => state.flight }, space: { get: () => state.space },
    customBot: { get: () => state.customBot }, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  const flow = {
    async selectCharacter() { log.push("select"); selected++; await overrides.select?.(); state.station.online = { characterID: launch.characterID, characterName: "Test" }; },
    async startCustomBot() { log.push("start"); push({ status: "running", phase: "Mining" }); },
    suspendHostedSession() { log.push("suspend"); push({ status: "paused" }); return overrides.suspend?.() ?? Promise.resolve(); },
    async verifyHostedSessionRecovery(shipID) { log.push("verify"); assert.equal(shipID, 9001); await overrides.verify?.(); },
    resumeHostedSession() { log.push("resume"); push({ status: "running", phase: "Mining" }); },
    async prepareHostedBotStop() { log.push("settle-stop"); },
    async prepareCustomBotParking() { log.push("settle-parking"); },
    async parkCustomBot() { log.push("park"); },
    stopCustomBot() { log.push("stop"); }, abortRoute() {}, async logout() { log.push("logout"); },
  };
  const host = createBotHost({ baseUrl: "http://127.0.0.1:0", webAuth: { createSessionToken: () => "owned-token" },
    createClaimSecret: () => `generation-${++secret}`, loadAccount: async () => account,
    loadScript: () => overrides.saved ?? { scriptID: launch.scriptID, name: launch.scriptName, rev: 1, doc },
    disconnectOwnedSession: async authority => { log.push("disconnect"); assert.equal(authority.characterID, launch.characterID); await overrides.disconnect?.(); },
    loadStack: async () => ({ createClientStore: () => store, createAppFlow: (_store, options) => { fetcher = options.fetch; return flow; },
      decodeScriptValue: value => ({ ok: true, doc: value }), analyzeBotRunPolicy: () => ({ restartSafe: overrides.restartSafe !== false, riskClasses: ["fleet"] }),
      supportsHostedOreJettisonRecovery: () => overrides.jettisonEligible === true,
      validateBotLaunchGrant: grant => ({ ok: true, grant }) }), errorLogger() {}, ...overrides.host });
  return { host, log, push, state, fetch: (...args) => fetcher(...args), selected: () => selected };
}

test("same-process unissued ore profile recovers without changing restart safety or original expiry", async () => {
  const f = fixture({ restartSafe: false, jettisonEligible: true }); const started = await f.host.start(launch);
  assert.equal(started.bot.restartSafe, false); assert.equal(started.bot.jettisonCustody, null);
  assert.equal(f.host.reconnect(started.bot.botID, 7).ok, true);
  await waitUntil(() => f.host.list(7)[0].recovery?.state === "READY");
  assert.equal(f.host.list(7)[0].expiresAt, started.bot.expiresAt);
  assert.equal(f.log.filter(row => row === "start").length, 1);
});
test("other destructive profiles and roles cannot recover through ore custody eligibility", async () => {
  for (const [eligible, role] of [[false, "MINER"], [true, "HAULER"], [true, "COMMAND"]]) {
    const f = fixture({ restartSafe: false, jettisonEligible: eligible });
    const started = await f.host.start({ ...launch, operationRole: role });
    assert.equal(f.host.reconnect(started.bot.botID, 7).ok, false);
    assert.equal(f.selected(), 1);
  }
});
function hostedPending(f) {
  const m = require("./jettisonCustody"); const owner = f.host.jettisonOwnerForClaim(launch.characterID, "generation-1");
  const scope = { ...owner.scope, shipID: 9001, systemID: 3, targetKey: "belt", targetClaimedAt: 100 };
  const item = { itemID: 10, typeID: 1230, quantity: 10, ownerID: launch.characterID, locationID: 9001, flagID: 134, categoryID: 25 };
  const scene = { inSpace: true, shipID: 9001, solarSystemID: 3, sampledAtMs: 1,
    ship: { itemID: 9001, characterID: launch.characterID }, entities: [] };
  const prepared = m.prepare({ scope, invocation: { runID: "run", invocationID: 1, stepPath: "ore" }, scene, rows: [item], itemIDs: [10], nowMs: 101 });
  owner.begin(prepared); const pending = m.issued(prepared, 102); owner.markIssued(pending);
  return { owner, pending, item, scene, scope };
}
test("confirmed exact can remains in hosted custody through reconnect with same expiry", async () => {
  const f = fixture({ restartSafe: false, jettisonEligible: true }); const started = await f.host.start(launch);
  const p = hostedPending(f), m = require("./jettisonCustody");
  const confirmed = m.reconcile(p.pending, { scope: p.scope, scene: { ...p.scene, entities: [{ kind: "container", itemID: 99, ownerID: launch.characterID }] },
    rows: [], containers: [{ itemID: 99, ownerID: launch.characterID, items: [{ ...p.item, locationID: 99, flagID: 0 }] }], result: [[10], []], nowMs: 103 });
  p.owner.settle(confirmed); f.host.reconnect(started.bot.botID, 7);
  await waitUntil(() => f.host.list(7)[0].recovery?.state === "READY");
  const final = f.host.list(7)[0]; assert.equal(final.jettisonCustody.containerID, 99); assert.equal(final.expiresAt, started.bot.expiresAt);
  assert.throws(() => p.owner.begin({ ...confirmed, state: "not-issued" }), /generation or grant changed/);
});
test("ambiguous jettison retains hosted control, blocks resume/Stop, and cannot duplicate", async () => {
  const f = fixture({ restartSafe: false, jettisonEligible: true }); const started = await f.host.start(launch);
  const p = hostedPending(f); assert.throws(() => p.owner.begin({ ...p.pending, scope: { ...p.pending.scope, invocationID: 2 } }), /still owned/);
  p.owner.settle({ ...p.pending, state: "ambiguous", reason: "unknown" });
  f.host.reconnect(started.bot.botID, 7); await waitUntil(() => f.host.list(7)[0].recovery?.state === "BLOCKED");
  assert.equal(f.log.includes("resume"), false); assert.equal(f.host.claimedBy(launch.characterID), started.bot.botID);
  assert.equal(f.host.list(7)[0].expiresAt, started.bot.expiresAt);
  assert.equal((await f.host.prepareOperationStop(started.bot.botID, 7, "op")).ok, false);
  assert.equal(f.log.includes("logout"), false);
});

test("owned reconnect quiesces one run and preserves its original grant and pinned document", async () => {
  const gate = deferred(), f = fixture({ suspend: () => gate.promise });
  const started = await f.host.start(launch);
  assert.equal(f.host.reconnect(started.bot.botID, 8).ok, false);
  const result = f.host.reconnect(started.bot.botID, account.accountID);
  assert.equal(result.ok, true); assert.equal(result.bot.status, "paused");
  assert.equal(f.host.authorizesClaim(launch.characterID, "generation-1"), false);
  assert.equal(f.host.claimedBy(launch.characterID), started.bot.botID);
  assert.deepEqual(f.log, ["select", "start", "suspend"]);
  gate.resolve(); await waitUntil(() => f.host.list(7)[0].recovery?.state === "READY");
  const final = f.host.list(7)[0];
  assert.equal(final.botID, started.bot.botID); assert.equal(final.expiresAt, started.bot.expiresAt);
  assert.equal(final.scriptHash, started.bot.scriptHash); assert.equal(final.recovery.attempts, 1);
  assert.equal(f.log.filter(step => step === "start").length, 1, "reconnect resumes existing memory rather than starting the script again");
  assert.deepEqual(f.log.slice(-4), ["disconnect", "select", "verify", "resume"]);
});

test("typed lost read freezes before a terminal snapshot and recovers without inventing a disconnect", async t => {
  const original = global.fetch; t.after(() => { global.fetch = original; });
  global.fetch = async () => new Response(JSON.stringify({ error: "SESSION_NOT_FOUND" }), { status: 404 });
  const gate = deferred(), f = fixture({ suspend: () => gate.promise }); const started = await f.host.start(launch);
  await f.fetch("http://127.0.0.1:0/api/bridge/flight/status");
  f.push({ status: "error" });
  assert.equal(f.host.claimedBy(launch.characterID), started.bot.botID);
  assert.equal(f.log.includes("logout"), false);
  gate.resolve(); await waitUntil(() => f.host.list(7)[0].recovery?.state === "READY");
  assert.equal(f.log.includes("disconnect"), false);
});

test("non-session transport errors do not authorize a fresh select", async t => {
  const original = global.fetch; t.after(() => { global.fetch = original; });
  global.fetch = async () => new Response(JSON.stringify({ error: "EVE_GATEWAY_TIMEOUT" }), { status: 503 });
  const f = fixture(); await f.host.start(launch); await f.fetch("http://127.0.0.1:0/api/bridge/flight/status");
  assert.equal(f.selected(), 1); assert.equal(f.host.list(7)[0].recovery, null);
});

test("unresolved work or changed pinned script blocks resumption while retaining ownership", async () => {
  for (const overrides of [{ verify: async () => { throw new Error("unresolved transfer custody"); } },
    { saved: { rev: 2, doc } }, { disconnect: async () => { throw new Error("ambiguous release timeout"); } }]) {
    const f = fixture(overrides), started = await f.host.start(launch);
    f.host.reconnect(started.bot.botID, 7); await waitUntil(() => f.host.list(7)[0].recovery?.state === "BLOCKED");
    assert.equal(f.host.claimedBy(launch.characterID), started.bot.botID);
    assert.equal(f.log.includes("resume"), false); assert.equal(f.log.includes("logout"), false);
    if (overrides.saved || overrides.disconnect) assert.equal(f.selected(), 1);
  }
});

test("an unresolved lost write prevents Stop or Parking from reporting released custody", async t => {
  const original = global.fetch; t.after(() => { global.fetch = original; });
  global.fetch = async () => new Response(JSON.stringify({ error: "SESSION_NOT_FOUND" }), { status: 404 });
  const f = fixture(), started = await f.host.start(launch);
  await f.fetch("http://127.0.0.1:0/api/bridge/inventory/transfer", { method: "POST" });
  await waitUntil(() => f.host.list(7)[0].recovery?.state === "BLOCKED");
  const stop = await f.host.prepareOperationStop(started.bot.botID, 7, "op");
  assert.equal(stop.ok, false); assert.equal(f.host.claimedBy(launch.characterID), started.bot.botID);
  assert.equal(f.log.includes("logout"), false); assert.equal(f.log.includes("resume"), false);
});

test("manual Stop supersedes pending recovery before it can reselect or resume", async () => {
  const gate = deferred(), f = fixture({ suspend: () => gate.promise }); const started = await f.host.start(launch);
  f.host.reconnect(started.bot.botID, 7);
  await f.host.stop(started.bot.botID, 7); gate.resolve();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.selected(), 1); assert.equal(f.log.includes("resume"), false);
  assert.equal(f.host.list(7)[0].status, "stopped");
});

test("a delayed retired-generation write loss is retained after a read already began recovery", async t => {
  const original = global.fetch; t.after(() => { global.fetch = original; });
  const write = deferred();
  global.fetch = async (_input, init) => init?.method === "POST" ? write.promise
    : new Response(JSON.stringify({ error: "SESSION_NOT_FOUND" }), { status: 404 });
  const f = fixture(), started = await f.host.start(launch);
  const issued = f.fetch("http://127.0.0.1:0/api/bridge/inventory/transfer", { method: "POST" });
  await f.fetch("http://127.0.0.1:0/api/bridge/flight/status");
  assert.equal(f.host.authorizesClaim(launch.characterID, "generation-1"), false);
  write.resolve(new Response(JSON.stringify({ error: "SESSION_NOT_FOUND" }), { status: 404 })); await issued;
  await waitUntil(() => f.host.list(7)[0].recovery?.state === "BLOCKED");
  assert.match(f.host.list(7)[0].why, /write outcome/);
  assert.equal(f.log.includes("resume"), false); assert.equal(f.host.claimedBy(launch.characterID), started.bot.botID);
});

test("repeated reconnects share the lifetime retry budget instead of renewing it", async () => {
  const f = fixture(), started = await f.host.start(launch);
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(f.host.reconnect(started.bot.botID, 7).ok, true);
    await waitUntil(() => f.host.list(7)[0].recovery?.state === "READY" && f.host.list(7)[0].recovery.attempts === attempt);
    assert.equal(f.host.list(7)[0].expiresAt, started.bot.expiresAt);
  }
  assert.equal(f.host.reconnect(started.bot.botID, 7).ok, false);
  assert.equal(f.selected(), 4);
});

test("operation expiry remains active while recovery is frozen", async () => {
  let deadline;
  const gate = deferred(); let f;
  f = fixture({ suspend: () => gate.promise, host: {
    setDeadlineTimeout: callback => { deadline = callback; return {}; }, clearDeadlineTimeout() {},
    onOperationDeadline: () => f.host.prepareOperationStop(f.host.list(7)[0].botID, 7, "op"),
  } });
  const started = await f.host.start(launch); f.host.reconnect(started.bot.botID, 7);
  deadline(); await waitUntil(() => f.log.includes("settle-parking")); gate.resolve();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.selected(), 1); assert.equal(f.log.includes("resume"), false);
  assert.equal(f.host.claimedBy(launch.characterID), started.bot.botID);
});

async function fleetFixture(overrides = {}) {
  const supportFleet = await import("../web/src/nav/miningSupportFleet.ts");
  const states = [], log = []; let sequence = 0;
  const supportID = launch.characterID, memberID = supportID + 1;
  const assignment = { operationID: "op", role: "COMMAND", stopRequested: false,
    support: { characterID: supportID, fleetPolicy: "MANAGED" }, intendedFleetCharacterIDs: [supportID, memberID] };
  const host = createBotHost({ baseUrl: "http://127.0.0.1:0", webAuth: { createSessionToken: () => "owned-token" },
    createClaimSecret: () => `fleet-generation-${++sequence}`, loadAccount: async () => account,
    loadScript: () => ({ rev: 1, doc }), disconnectOwnedSession: async () => {}, errorLogger() {}, sleep: async () => { log.push("tick"); },
    loadStack: async () => ({ supportFleet, decodeScriptValue: value => ({ ok: true, doc: value }),
      analyzeBotRunPolicy: () => ({ restartSafe: true, riskClasses: overrides.noFleetGrant ? [] : ["fleet"] }),
      validateBotLaunchGrant: grant => ({ ok: true, grant }), createClientStore() {
        const state = { characterID: null, fleetID: null, suspended: false, custom: { status: "idle" }, listeners: new Set() };
        states.push(state);
        const store = { station: { get: () => ({ online: { characterID: state.characterID } }) },
          flight: { get: () => ({ status: { shipID: 9001 } }) }, space: { get: () => ({ snapshot: null }) },
          fleet: { get: () => ({ actionError: null }) }, customBot: { get: () => state.custom },
          subscribe: listener => { state.listeners.add(listener); return () => state.listeners.delete(listener); } };
        state.push = custom => { state.custom = custom; for (const listener of state.listeners) listener({ customBot: custom }); };
        store.state = state; return store;
      }, createAppFlow(store, flowOptions) {
        const state = store.state;
        return { async selectCharacter(id) { state.characterID = id; state.selects = (state.selects || 0) + 1;
            state.fleetID = overrides.hauler ? id === supportID || state.selects === 1 ? 700 : null : id === memberID ? 700 : null; },
          async startCustomBot() { state.push({ status: "running" }); },
          async suspendHostedSession() { state.suspended = true; state.push({ status: "paused" }); },
          async verifyHostedSessionRecovery() {}, resumeHostedSession() { log.push("resume"); state.push({ status: "running" }); },
          async readMiningOperationAssignment() { const own = { ...assignment, role: overrides.hauler && state.characterID === memberID ? "HAULER" : assignment.role };
            if (overrides.stopDuringReads && log.includes("peer-read")) return { ...own, stopRequested: true }; return own; },
          async loadFleet() { if (state.characterID === memberID) { log.push("peer-read"); await overrides.peerRead?.(); } },
          readMiningSupportFleet(epoch) { return { scope: { characterID: state.characterID, sessionEpoch: epoch }, receivedAtMs: Date.now(),
            snapshot: { availability: state.fleetID === null ? "not-in-fleet" : "ready", fleet: { characterID: state.characterID,
              initState: { error: null, value: { fleetID: state.fleetID, members: [{ charID: state.characterID }] } } } },
            join: { inviteKnown: state.invited === true || !overrides.hauler, invite: state.invited ? { fleetID: 700, receivedAtMs: Date.now(), inviterID: supportID } : null, ads: [] } }; },
          async inviteFleetMember(id, assertCurrent, expectedFleetID) { assertCurrent(); log.push(["invite", state.characterID, id, expectedFleetID]);
            if (overrides.hauler) states.find(row => row.characterID === id).invited = true; },
          async acceptFleetInvite(id) { log.push(["accept", state.characterID, id]);
            if (overrides.acceptGate) { log.push("accept-queued"); await overrides.acceptGate;
              await flowOptions.fetch("http://127.0.0.1:0/api/bridge/fleet/invite/accept", { method: "POST", body: JSON.stringify({ fleetID: id, confirm: true }) }); }
            if (!overrides.unconfirmedAcceptance) state.fleetID = id; },
          async prepareHostedBotStop() {}, async prepareCustomBotParking() {}, stopCustomBot() {}, abortRoute() {}, async logout() {},
        };
      } }),
  });
  const support = await host.start({ ...launch, operationRole: "COMMAND" });
  const member = await host.start({ ...launch, characterID: memberID, operationRole: overrides.hauler ? "HAULER" : "MINER" });
  return { host, support, member, log, states };
}

test("owned managed support resumes reconciliation after a real surviving member's single normal invite", async () => {
  const f = await fleetFixture(); f.host.reconnect(f.support.bot.botID, 7);
  await waitUntil(() => f.host.list(7).find(row => row.botID === f.support.bot.botID).recovery?.state === "READY");
  assert.deepEqual(f.log.filter(row => Array.isArray(row)), [["invite", launch.characterID + 1, launch.characterID, 700]]);
  assert.equal(f.host.list(7).find(row => row.botID === f.support.bot.botID).expiresAt, f.support.bot.expiresAt);
});
test("a hauler suspended inside loot rejoins surviving support before READY, one action per tick", async () => {
  const f = await fleetFixture({ hauler: true }); f.host.reconnect(f.member.bot.botID, 7);
  await waitUntil(() => f.host.list(7).find(row => row.botID === f.member.bot.botID).recovery?.state === "READY");
  assert.deepEqual(f.log.filter(Array.isArray), [["invite", launch.characterID, launch.characterID + 1, 700], ["accept", launch.characterID + 1, 700]]);
  const invite = f.log.findIndex(row => Array.isArray(row) && row[0] === "invite"), accept = f.log.findIndex(row => Array.isArray(row) && row[0] === "accept");
  assert.ok(f.log.slice(invite + 1, accept).includes("tick"));
  assert.equal(f.states[1].fleetID, 700);
  assert.equal(f.host.list(7).find(row => row.botID === f.member.bot.botID).expiresAt, f.member.bot.expiresAt);
});
test("hauler invitation ACK without observed membership remains BLOCKED and retains control", async () => {
  const f = await fleetFixture({ hauler: true, unconfirmedAcceptance: true }); f.host.reconnect(f.member.bot.botID, 7);
  await waitUntil(() => f.host.list(7).find(row => row.botID === f.member.bot.botID).recovery?.state === "BLOCKED");
  assert.equal(f.log.includes("resume"), false);
  assert.equal(f.host.claimedBy(launch.characterID + 1), f.member.bot.botID);
  assert.equal(f.log.filter(row => Array.isArray(row) && row[0] === "accept").length, 1);
});
test("a hauler cannot restore membership without the original fleet grant", async () => {
  const f = await fleetFixture({ hauler: true, noFleetGrant: true }); f.host.reconnect(f.member.bot.botID, 7);
  await waitUntil(() => f.host.list(7).find(row => row.botID === f.member.bot.botID).recovery?.state === "BLOCKED");
  assert.equal(f.log.some(Array.isArray), false); assert.equal(f.log.includes("resume"), false);
});
test("queued hauler acceptance is fenced at actual dispatch after Stop or COMMAND retirement", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const retirePeer of [false, true]) {
      let mutations = 0;
      globalThis.fetch = async () => { mutations++; return new Response("{}", { status: 200 }); };
      const gate = deferred(), f = await fleetFixture({ hauler: true, acceptGate: gate.promise });
      f.host.reconnect(f.member.bot.botID, 7);
      await waitUntil(() => f.log.includes("accept-queued"));
      if (retirePeer) await f.host.stop(f.support.bot.botID, 7);
      else await f.host.prepareOperationStop(f.member.bot.botID, 7, "op");
      gate.resolve();
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(mutations, 0);
      assert.equal(f.log.includes("resume"), false);
      assert.equal(f.host.claimedBy(launch.characterID + 1), f.member.bot.botID);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("changed operation Stop, missing peer fleet grant and retired peer custody forbid recovery invitations", async () => {
  for (const overrides of [{ stopDuringReads: true }, { noFleetGrant: true }, { stopPeer: true }]) {
    const gate = deferred(); const f = await fleetFixture({ ...overrides, peerRead: overrides.stopPeer ? () => gate.promise : undefined });
    f.host.reconnect(f.support.bot.botID, 7);
    if (overrides.stopPeer) { await waitUntil(() => f.log.includes("peer-read")); await f.host.stop(f.member.bot.botID, 7); gate.resolve(); }
    await waitUntil(() => f.host.list(7).find(row => row.botID === f.support.bot.botID).recovery?.state === "BLOCKED");
    assert.equal(f.log.some(row => Array.isArray(row)), false); assert.equal(f.log.includes("resume"), false);
    assert.equal(f.host.claimedBy(launch.characterID), f.support.bot.botID);
  }
});

test("operation fleet reads discard a peer retired while its read was pending", async () => {
  const gate = deferred(), f = await fleetFixture({ peerRead: () => gate.promise });
  const read = f.host.readOperationFleets("op"); await waitUntil(() => f.log.includes("peer-read"));
  await f.host.stop(f.member.bot.botID, 7); gate.resolve();
  const rows = await read; assert.deepEqual(rows.map(row => row.scope.characterID), [launch.characterID]);
});

for (const active of [false, true]) test(`hosted reconnect retains completed preparation ${active ? "after" : "before"} MAIN activation`, async () => {
  let prepared = 0;
  const f = fixture({ host: { prepareOperation: async record => {
    prepared++; record.assertPreparationCurrent(); return { state: "VERIFIED", evidence: { supplies: "FULL" } };
  }, operationBarrierReady: () => true } });
  const started = await f.host.start({ ...launch, operationRunID: "operation-run", operationPreparation: { source: { kind: "hangar" }, fittingID: 4 }, deferMain: true });
  const activate = () => f.host.activateOperationMember(started.bot.botID, 7, "op", "operation-run");
  if (active) assert.equal((await activate()).ok, true);
  assert.equal(f.host.reconnect(started.bot.botID, 7).ok, true);
  await waitUntil(() => f.host.list(7)[0].recovery?.state === "READY");
  const ready = f.host.list(7)[0];
  assert.equal(ready.logicalRunID, started.bot.logicalRunID);
  assert.equal(ready.operationRunID, "operation-run");
  assert.equal(ready.preparation.state, "VERIFIED");
  assert.equal(prepared, 1);
  if (active) assert.equal(f.log.filter(row => row === "resume").length, 1);
  else {
    assert.equal(f.log.includes("resume"), false);
    assert.equal(f.log.includes("start"), false);
    assert.equal((await activate()).ok, true);
  }
  assert.equal(f.log.filter(row => row === "start").length, 1);
  await f.host.stop(started.bot.botID, 7);
});

test("deferred MAIN stays fenced during reconnect verification and activates only after aggregate recovery callback", async () => {
  const gate = deferred(); let prepared = 0, aggregates = 0, activation;
  const f = fixture({ verify: () => gate.promise, host: {
    prepareOperation: async () => { prepared++; return { state: "VERIFIED", evidence: { supplies: "FULL" } }; },
    operationBarrierReady: () => true,
    onOperationResume: async () => {
      aggregates++;
      const bot = f.host.list(7)[0];
      assert.equal(bot.preparationOwnerAvailable, true);
      activation = await f.host.activateOperationMember(bot.botID, 7, "op", "operation-run");
    },
  } });
  const started = await f.host.start({ ...launch, operationRunID: "operation-run",
    operationPreparation: { source: { kind: "hangar" }, fittingID: 4 }, deferMain: true });
  assert.equal(started.bot.preparationOwnerAvailable, true);
  assert.equal(f.host.reconnect(started.bot.botID, 7).ok, true);
  await waitUntil(() => f.log.includes("verify"));
  const pending = f.host.list(7)[0];
  assert.equal(pending.preparation.state, "VERIFIED");
  assert.equal(pending.preparationOwnerAvailable, false);
  assert.equal((await f.host.activateOperationMember(pending.botID, 7, "op", "operation-run")).ok, false);
  assert.equal(f.host.preparationForRun(pending.logicalRunID).mainEntered, false);
  assert.equal(f.log.includes("start"), false);
  assert.equal(aggregates, 0);
  gate.resolve();
  await waitUntil(() => activation?.ok === true);
  assert.equal(aggregates, 1); assert.equal(prepared, 1);
  assert.equal(f.log.filter(row => row === "start").length, 1);
  assert.equal(f.host.preparationForRun(pending.logicalRunID).mainEntered, true);
  await f.host.stop(started.bot.botID, 7);
});

test("ready preparation cannot activate after reconnect owner verification fails", async () => {
  let aggregates = 0;
  const f = fixture({ verify: async () => { throw new Error("owner observation unknown"); }, host: {
    prepareOperation: async () => ({ state: "VERIFIED", evidence: { supplies: "FULL" } }),
    operationBarrierReady: () => true, onOperationResume: async () => { aggregates++; },
  } });
  const started = await f.host.start({ ...launch, operationRunID: "operation-run",
    operationPreparation: { source: { kind: "hangar" }, fittingID: 4 }, deferMain: true });
  f.host.reconnect(started.bot.botID, 7);
  await waitUntil(() => f.host.list(7)[0].recovery?.state === "BLOCKED");
  const blocked = f.host.list(7)[0];
  assert.equal(blocked.preparation.state, "VERIFIED"); assert.equal(blocked.preparationOwnerAvailable, false);
  assert.equal((await f.host.activateOperationMember(blocked.botID, 7, "op", "operation-run")).ok, false);
  assert.equal(f.host.preparationForRun(blocked.logicalRunID).mainEntered, false);
  assert.equal(f.host.claimedBy(launch.characterID), blocked.botID);
  assert.equal(f.log.includes("start"), false); assert.equal(aggregates, 0);
  await f.host.stop(started.bot.botID, 7);
});

test("successful same-run restart retires an unowned failed recovery report without ending custody or blocking Stop", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-recovery-report-"));
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const persistPath = path.join(dir, "roster.json");
  const readRoster = () => JSON.parse(fs.readFileSync(persistPath, "utf8")).bots;
  const readRun = logicalRunID => JSON.parse(fs.readFileSync(`${persistPath}.startup.json`, "utf8")).records[logicalRunID];
  let issued = 0, reconciled = 0;
  const first = fixture({ host: { persistPath, prepareOperation: async record => {
    record.preparationCheckpoint.begin({ before: 3200 });
    record.preparationCheckpoint.update({ custodyOperationID: "committed-transfer", requested: 1800 });
    issued++;
    throw new Error("Shared Add committed but its response was lost.");
  } } });
  const started = await first.host.start({ ...launch, operationRunID: "operation-run",
    operationPreparation: { accountID: 7, characterID: launch.characterID, operationID: "op" }, deferMain: true });
  assert.equal(started.bot.preparation.state, "RECOVERY_REQUIRED");

  const failed = fixture({ select: async () => { throw new Error("Recovery selector unavailable."); }, host: {
    persistPath, preparationUnresolved: () => true,
    prepareOperation: async () => assert.fail("Failed selection cannot reach preparation."),
  } });
  await failed.host.resume();
  const duplicateRows = readRoster();
  assert.equal(duplicateRows.length, 2);
  assert.equal(duplicateRows[0].stopBlocked, true);
  assert.ok(duplicateRows.every(row => row.logicalRunID === started.bot.logicalRunID));
  assert.equal(readRun(started.bot.logicalRunID).ended, false);

  const restored = fixture({ host: { persistPath, prepareOperation: async record => {
    const pending = record.preparationCheckpoint.snapshot();
    assert.equal(pending.invocation, 1);
    assert.equal(pending.evidence.custodyOperationID, "committed-transfer");
    assert.throws(() => record.preparationCheckpoint.begin(), /requires reconciliation/);
    reconciled++;
    return { state: "VERIFIED", evidence: { after: 5000, reconciled: true } };
  }, operationBarrierReady: () => true } });
  await restored.host.resume();
  const rows = restored.host.list(7), active = rows.filter(row => !row.endedAt);
  assert.equal(active.length, 1);
  const owner = active[0], report = rows.find(row => row.botID !== owner.botID);
  assert.equal(restored.host.claimedBy(launch.characterID), owner.botID);
  assert.equal(owner.logicalRunID, started.bot.logicalRunID);
  assert.equal(owner.preparationOwnerAvailable, true);
  assert.equal(report.status, "error");
  assert.equal(report.phase, "Superseded recovery report");
  assert.ok(report.endedAt);
  assert.match(report.why, /graceful Stop was blocked/);
  assert.equal(report.preparation.evidence.custodyOperationID, "committed-transfer");
  assert.equal(readRoster().length, 1);
  assert.equal(readRun(owner.logicalRunID).ended, false);
  assert.equal(readRun(owner.logicalRunID).preparation.invocation, 1);
  assert.equal(issued, 1); assert.equal(reconciled, 1);
  assert.equal(restored.log.includes("start"), false);
  assert.equal(restored.log.includes("logout"), false);
  assert.equal((await restored.host.activateOperationMember(owner.botID, 7, "op", "operation-run")).ok, true);
  assert.equal((await restored.host.prepareOperationStop(owner.botID, 7, "op")).ok, true);
  assert.equal((await restored.host.parkOperationMember(owner.botID, 7, "op", { mode: "RETURN_HOME_DOCK" })).ok, true);
  assert.equal(restored.host.claimedBy(launch.characterID), null);
  assert.equal(restored.log.filter(step => step === "start").length, 1);
  assert.equal(restored.log.filter(step => step === "logout").length, 1);
  assert.equal(readRun(owner.logicalRunID).ended, true);
  assert.equal(readRoster().length, 0);
});
