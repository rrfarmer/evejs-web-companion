"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBotHost, MAX_ENDED_RUNS } = require("./botHost");

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

// FleetCompanionState's shape (web/src/store/clientStore.ts) — deliberately
// missing stepPath/pauseReason/note/lastAlert, which IDLE_SLICE above has and
// the companion slice never will. See applySnapshot()'s comment in botHost.js.
const IDLE_COMPANION_SLICE = Object.freeze({
  status: "idle",
  phase: null,
  action: null,
  why: null,
  inFleet: null,
  followingOrderFrom: null,
  lastOrderHeard: null,
  canTag: null,
  abandonment: null,
  startedAt: null,
  startError: null,
  failureReason: null,
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
    // The companion's own risk-derivation and codec door — a plain fake of
    // companionRunPolicy.ts, not the real module (that module is proven live
    // on its own; these tests pin the HOST's obligations around it).
    //
    // The sentinel is part of that module's contract too, so the fake carries
    // it the way the real stack does: the host reads the revision off the stack
    // rather than holding a second copy of a bare 1 of its own.
    COMPANION_GRANT_SCRIPT_REV: 1,
    // ⚠ COMBAT IS UNCONDITIONAL NOW, matching the real derivation. A grant is
    // built before the fit has been read, and a hull nobody has looked at may
    // hold anything -- so there is no longer a setting that could withhold it.
    analyzeCompanionRunPolicy: (setup) => ({
      riskClasses:
        setup && setup.repairsAtStation === true
          ? ["fleet", "social", "combat", "financial", "inventory"]
          : ["fleet", "social", "combat"],
      restartSafe: true,
    }),
    // A plain fake of the real codec door. The real one refuses any key outside
    // the stored set and forgives the fifteen RETIRED ones; all this fake needs
    // to reproduce is "a setup with the required numbers is ok, anything else
    // is refused", which is what the host's own branches turn on.
    decodeCompanionSetupValue: (value) => {
      if (!value || typeof value !== "object" || typeof value.fleeHealthFloor !== "number") {
        return { ok: false, refusal: "That companion setup could not be read." };
      }
      return { ok: true, setup: value };
    },
    // Decision 5's persisted clock gets the same treatment as the request: a
    // plain fake of the real codec door, refusing anything without a usable
    // timestamp so the host's own DROP-don't-refuse behaviour can be pinned.
    decodeCompanionAbandonmentValue: (value) =>
      value && typeof value === "object" && Number.isSafeInteger(value.abandonedAtMs)
        ? {
            ok: true,
            abandonment: {
              abandonedAtMs: value.abandonedAtMs,
              supervisorCharacterIDs: Array.isArray(value.supervisorCharacterIDs)
                ? value.supervisorCharacterIDs
                : [],
            },
          }
        : { ok: false, refusal: "That saved supervision state could not be read." },
    createClientStore: () => {
      const listeners = new Set();
      const state = {
        station: { online: null },
        customBot: { ...IDLE_SLICE },
        companion: { ...IDLE_COMPANION_SLICE },
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
        companion: { get: () => state.companion },
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
        async startFleetCompanion(request, resuming = null) {
          log.push(["startFleetCompanion", request, resuming]);
          store._set({
            companion: { ...IDLE_COMPANION_SLICE, status: "running", phase: "Flying", role: request.role },
          });
        },
        stopFleetCompanion() {
          log.push(["stopFleetCompanion"]);
        },
        async prepareHostedBotStop(kind) {
          log.push(["prepareHostedBotStop", kind]);
          if (kind === "companion") this.stopFleetCompanion();
          else this.stopCustomBot();
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

function makeHost({ log = [], isCharacterHeld = () => false, ...extras } = {}) {
  return createBotHost({
    webAuth: { createSessionToken: () => "bot-token" },
    baseUrl: "http://127.0.0.1:0",
    isCharacterHeld,
    errorLogger: () => {},
    loadStack: makeFakeStack(log),
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

// A companion request has no revision series (see COMPANION_GRANT_SCRIPT_REV's
// comment in botHost.js) — its grant's `scriptRev` is always the sentinel `1`.
// ⚠ A SETUP, NOT A REQUEST, SINCE 2026-09-11. The eight module lists, the role
// and every channel toggle are gone: a companion reads its own fit at start and
// listens to everything. What is persisted is only what cannot be read off a
// ship. See docs/fleet-companion-simplification.md.
const COMPANION_REQUEST = Object.freeze({
  fleeHealthFloor: 0.3,
  capacitorFloor: 0.2,
  maxFleeAttempts: 3,
  repairsAtStation: false,
  droneHealthFloor: 0.5,
  droneRedeployHoldOffSeconds: 10,
});
const COMPANION_START = {
  account: ACCOUNT,
  characterID: 140000002,
  kind: "companion",
  request: COMPANION_REQUEST,
  // ⚠ `combat` IS UNCONDITIONAL NOW: a grant is built before the fit is read,
  // and a hull nobody has looked at may hold anything.
  grant: { scriptRev: 1, riskClasses: ["fleet", "social", "combat"], maxRuntimeMinutes: 720 },
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

test("operation expiry delegates before individual wind-down or ownership release", async () => {
  const log = [], deadlines = [], calls = [];
  const host = makeHost({ log, onOperationDeadline: async id => { calls.push(id); },
    setDeadlineTimeout(callback) { deadlines.push(callback); return { unref() {} }; }, clearDeadlineTimeout() {} });
  const started = await host.start({ ...START, operationID: "operation", operationRole: "COMMAND" });
  deadlines[0](); await settle();
  assert.deepEqual(calls, ["operation"]);
  assert.equal(host.claimedBy(START.characterID), started.bot.botID);
  assert.equal(log.some(([name]) => name === "logout" || name === "prepareHostedBotStop"), false);
  await host.stop(started.bot.botID, ACCOUNT.accountID);
});

test("operation expiry coordination failure settles the loop and retains pilot control", async () => {
  const log = [], deadlines = [];
  const host = makeHost({ log, loadStack: makeFakeStack(log, flow => ({ ...flow,
    async prepareCustomBotParking() { this.stopCustomBot(); } })),
    onOperationDeadline: async () => { throw new Error("definition unavailable"); },
    setDeadlineTimeout(callback) { deadlines.push(callback); return { unref() {} }; }, clearDeadlineTimeout() {} });
  const started = await host.start({ ...START, operationID: "operation", operationRole: "COMMAND" });
  deadlines[0](); await settle();
  const bot = host.list(ACCOUNT.accountID)[0];
  assert.equal(bot.phase, "Operation deadline blocked");
  assert.equal(host.claimedBy(START.characterID), started.bot.botID);
  assert.equal(log.some(([name]) => name === "logout"), false);
  assert.ok(log.some(([name]) => name === "stopCustomBot"));
  await host.stop(started.bot.botID, ACCOUNT.accountID);
});

test("settled operation deadline docks through the existing host owner and records Parking", async () => {
  const log = [];
  const host = makeHost({ log, loadStack: makeFakeStack(log, (flow, store) => ({ ...flow,
    async prepareCustomBotParking() { this.stopCustomBot(); },
    async loadFlightStatus() { store._set({ flight: { status: { docked: true } } }); }
  })) });
  const started = await host.start({ ...START, operationID: "operation", operationRole: "COMMAND" });
  assert.equal((await host.endOperationDeadline(started.bot.botID, ACCOUNT.accountID, "operation")).ok, false);
  assert.equal((await host.prepareOperationStop(started.bot.botID, ACCOUNT.accountID, "operation")).ok, true);
  assert.equal((await host.endOperationDeadline(started.bot.botID, ACCOUNT.accountID, "operation")).ok, true);
  const bot = host.list(ACCOUNT.accountID)[0];
  assert.equal(bot.parking.state, "PARKED");
  assert.match(bot.why, /approved run time ended/);
  assert.equal(host.claimedBy(START.characterID), null);
});

test("configured deadline Parking cannot turn unconfirmed final docking into success", async () => {
  const log = [];
  const host = makeHost({ log, loadStack: makeFakeStack(log, flow => ({ ...flow,
    async prepareCustomBotParking() { this.stopCustomBot(); },
    async parkCustomBot() { /* final flight read still proves undocked */ }
  })) });
  const started = await host.start({ ...START, operationID: "operation", operationRole: "COMMAND" });
  await host.prepareOperationStop(started.bot.botID, ACCOUNT.accountID, "operation");
  const result = await host.parkOperationMember(started.bot.botID, ACCOUNT.accountID, "operation",
    { mode: "RETURN_HOME_DOCK" }, "deadline");
  assert.equal(result.ok, false);
  assert.equal(host.list(ACCOUNT.accountID)[0].parking.state, "PARKING_FAILED");
});

test("callback failure cannot overwrite a concurrent manual finalization", async () => {
  const log = [], deadlines = [];
  let finishPrepare, entered;
  const gate = new Promise(resolve => { finishPrepare = resolve; });
  const preparing = new Promise(resolve => { entered = resolve; });
  const host = makeHost({ log, loadStack: makeFakeStack(log, flow => ({ ...flow,
    async prepareCustomBotParking() { this.stopCustomBot(); entered(); await gate; }
  })), onOperationDeadline: async () => { throw new Error("definition unavailable"); },
    setDeadlineTimeout(callback) { deadlines.push(callback); return { unref() {} }; }, clearDeadlineTimeout() {} });
  const started = await host.start({ ...START, operationID: "operation", operationRole: "COMMAND" });
  deadlines[0](); await preparing;
  await host.stop(started.bot.botID, ACCOUNT.accountID);
  finishPrepare(); await settle();
  const bot = host.list(ACCOUNT.accountID)[0];
  assert.equal(bot.status, "stopped");
  assert.notEqual(bot.phase, "Operation deadline blocked");
  assert.equal(host.claimedBy(START.characterID), null);
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

test("a companion whose run time ends recalls drones and docks before logging off", async () => {
  const log = [];
  let docked = false;
  const { host, fire } = deadlineHost(log, (flow, store) => ({
    ...flow,
    stopFleetCompanion() {
      log.push(["stopFleetCompanion"]);
      // The real stop pushes a stopped slice; mid-wind-down it must NOT end the run.
      store._set({ companion: { ...store.companion.get(), status: "stopped" } });
    },
    async panicRecallAndDock() {
      log.push(["panicRecallAndDock"]);
    },
    async loadFlightStatus() {
      log.push(["loadFlightStatus"]);
      store._set({ flight: { status: { docked, stationID: docked ? 60000001 : null } } });
    },
  }));
  const started = await host.start(COMPANION_START);
  assert.equal(started.ok, true);

  fire();
  await settle();
  assert.ok(log.some(([name]) => name === "panicRecallAndDock"));
  assert.equal(host.claimedBy(COMPANION_START.characterID), started.bot.botID);
  assert.equal(log.some(([name]) => name === "logout"), false);

  docked = true;
  await settle();
  await settle();

  const [row] = host.list(ACCOUNT.accountID);
  assert.equal(row.status, "stopped");
  assert.match(row.why, /docked and logged off/i);
  assert.equal(host.claimedBy(COMPANION_START.characterID), null);
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

test("a second bot may not take a claimed character", async () => {
  const host = makeHost();
  assert.equal((await host.start(START)).ok, true);
  const second = await host.start(START);
  assert.equal(second.ok, false);
  assert.equal(second.code, "BOT_ALREADY_RUNNING");
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

test("vitals sampling projects ship health, hold fill and the bot's words", async () => {
  const host = makeHost();
  await host.start(START);
  await host.sampleAllVitals();
  const rows = host.activeBots();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].characterID, 140000001);
  assert.equal(rows[0].status, "running");
  assert.equal(rows[0].phase, "Working");
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

// ── Fleet companion (kind: "companion") ──────────────────────────────────────
// A companion has no saved-script library entry: its request travels with the
// start call, or (on resume) IS the persisted roster row itself — see
// persistRoster's comment in botHost.js. These pin the kind branch through
// start(), persistRoster(), resume(), applySnapshot(), and the two-switch stop
// distinction (stopFleetCompanion vs stopCustomBot) in stop()/finalize().

test("a companion flies on its own session, through startFleetCompanion, never startCustomBot", async () => {
  const log = [];
  const host = makeHost({ log });
  const outcome = await host.start(COMPANION_START);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.bot.kind, "companion");
  assert.equal(outcome.bot.status, "running");
  // Reused roster slots (docs/fleet-companion-handoff.md, "3. Extend
  // botHost"): a fixed scriptID literal (no library entry exists to name),
  // and a scriptName derived from the request's role.
  assert.equal(outcome.bot.scriptID, "companion");
  assert.equal(outcome.bot.scriptName, "Fleet companion");
  assert.ok(log.some((row) => row[0] === "startFleetCompanion"));
  assert.equal(log.some((row) => row[0] === "startCustomBot"), false);
});

test("stopping a companion calls stopFleetCompanion, never stopCustomBot", async () => {
  const log = [];
  const host = makeHost({ log });
  const started = await host.start(COMPANION_START);
  const stopped = await host.stop(started.bot.botID, 7);
  assert.equal(stopped.ok, true);
  assert.ok(log.some((row) => row[0] === "stopFleetCompanion"), "the companion's own stop switch must fire");
  assert.equal(log.some((row) => row[0] === "stopCustomBot"), false, "the wrong switch is a silent no-op");
  assert.equal(host.claimedBy(140000002), null);
});

test("a companion that ends on its own (the companion slice, not customBot) releases the character", async () => {
  const log = [];
  const host = makeHost({ log });
  await host.start(COMPANION_START);
  const store = lastStore(log);
  store._set({ companion: { ...IDLE_COMPANION_SLICE, status: "stopped", why: "Fleet gone." } });
  await settle();
  assert.equal(host.claimedBy(140000002), null);
  assert.ok(log.some((row) => row[0] === "logout"));
  const after = host.list(7)[0];
  assert.equal(after.status, "stopped");
  assert.equal(after.why, "Fleet gone.");
});

test("a companion's progress maps status/phase/why honestly, and leaves script-shaped fields null", async () => {
  const log = [];
  const host = makeHost({ log });
  await host.start(COMPANION_START);
  const store = lastStore(log);
  store._set({
    companion: {
      ...IDLE_COMPANION_SLICE,
      status: "running",
      phase: "Escorting",
      action: "wait",
      why: "Waiting on the fleet.",
    },
  });
  await settle();
  const row = host.list(7)[0];
  assert.equal(row.status, "running");
  assert.equal(row.phase, "Escorting");
  assert.equal(row.why, "Waiting on the fleet.");
  // FleetCompanionState (web/src/store/clientStore.ts) has no stepPath,
  // pauseReason, or note — applySnapshot() must leave these at their initial
  // null rather than inventing a value for a column the companion has no
  // honest answer to.
  assert.equal(row.stepPath, null);
  assert.equal(row.pauseReason, null);
  assert.equal(row.note, null);
});

test("a companion's badge facts reach the wire, and a script's stay null", async () => {
  const log = [];
  const host = makeHost({ log });
  await host.start(COMPANION_START);
  const store = lastStore(log);
  store._set({
    companion: {
      ...IDLE_COMPANION_SLICE,
      status: "running",
      phase: "Obeying fleet",
      why: "The fleet broadcast a target on this grid.",
      inFleet: true,
      followingOrderFrom: "broadcast",
      lastOrderHeard: "the fleet's target call",
      canTag: false,
      fitWarnings: ["One weapon has nothing loaded. It will not fire until you load it."],
    },
  });
  await settle();
  const row = host.list(7)[0];
  assert.equal(row.kind, "companion");
  assert.deepEqual(row.companion, {
    inFleet: true,
    followingOrderFrom: "broadcast",
    lastOrderHeard: "the fleet's target call",
    canTag: false,
    // ⚠ THE ONLY ROUTE THESE HAVE TO A PLAYER ON A HEADLESS RUN. No panel is
    // open for a bot on the host, and a squad start is the case they exist for.
    fitWarnings: ["One weapon has nothing loaded. It will not fire until you load it."],
  });

  // ⚠ FALSE AND NULL ARE DIFFERENT ANSWERS HERE. `canTag: false` means the
  // server would drop this pilot's tag write; null means the roster has not
  // been read yet. A headless companion is the ONLY place a player can see
  // that distinction, so the wire must not flatten it.
  assert.equal(row.companion.canTag, false);
  assert.notEqual(row.companion.canTag, null);
});

test("a script run carries no companion readout at all", async () => {
  const host = makeHost();
  const started = await host.start(START);
  const row = host.list(7).find((entry) => entry.botID === started.bot.botID);
  assert.equal(row.kind, "script");
  assert.equal(row.companion, null, "a script must not grow a companion badge");
});

test("the companion readout is a READOUT and never reaches the disk", async () => {
  // ⚠ THE DURABILITY BOUNDARY, AND IT IS LOAD-BEARING. `abandonment` is
  // persisted because it is a thirty-minute clock that must survive a restart.
  // These five are what a pilot is doing this second: a resumed run re-derives
  // them on its first tick, and writing them down would let a restart hand the
  // player a confident readout of a fleet the pilot may since have left.
  const rosterPath = tempRosterPath();
  const host = makeHost({ persistPath: rosterPath, log: [] });
  await host.start({ ...COMPANION_START, persistPath: rosterPath });
  const persisted = readRosterFile(rosterPath);
  assert.equal(persisted.length, 1);
  for (const key of ["companion", "role", "inFleet", "followingOrderFrom", "lastOrderHeard", "canTag", "companionReadout"]) {
    assert.ok(!(key in persisted[0]), `the roster row must not carry ${key}`);
  }
  // The one companion field that IS durable is still there to prove the test
  // is looking at a companion row at all.
  assert.ok("request" in persisted[0]);
});

test("the persisted roster row for a companion carries kind, the flat request, and its hash — not a script doc", async () => {
  const rosterPath = tempRosterPath();
  const host = makeHost({ persistPath: rosterPath });
  const started = await host.start(COMPANION_START);
  const persisted = readRosterFile(rosterPath);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].kind, "companion");
  assert.equal(persisted[0].scriptID, "companion");
  assert.equal(persisted[0].scriptName, "Fleet companion");
  // A companion request has no revision series — this is the sentinel
  // COMPANION_GRANT_SCRIPT_REV, never a real revision (see its comment).
  assert.equal(persisted[0].scriptRev, 1);
  assert.deepEqual(persisted[0].request, COMPANION_REQUEST);
  assert.match(persisted[0].scriptHash, /^[a-f0-9]{64}$/);
  assert.equal(persisted[0].scriptHash, started.bot.scriptHash);
  assert.deepEqual(persisted[0].riskClasses, ["fleet", "social", "combat"]);
});

test("resume rebuilds a companion from its persisted request alone — no library lookup", async () => {
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(COMPANION_START);
  const after = makeHost({
    persistPath: rosterPath,
    loadAccount: async (username) => (username === "test" ? { ...ACCOUNT } : null),
    // A companion resume must never consult the saved-script library — there
    // is nothing there for it to find.
    loadScript: () => {
      throw new Error("a companion resume must not look up a saved script");
    },
  });
  await after.resume();
  const listed = after.list(7);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].kind, "companion");
  assert.equal(listed[0].status, "running");
  assert.notEqual(listed[0].resumedAt, null);
  assert.equal(after.claimedBy(140000002), listed[0].botID);
});

test("resume refuses a persisted companion request that no longer decodes", async () => {
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(COMPANION_START);
  const raw = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  raw.bots[0].request = { role: "not-a-real-role" };
  fs.writeFileSync(rosterPath, JSON.stringify(raw), "utf8");

  const after = makeHost({
    persistPath: rosterPath,
    loadAccount: async () => ({ ...ACCOUNT }),
  });
  await after.resume();
  const [row] = after.list(7);
  assert.equal(row.status, "error");
  assert.match(String(row.why), /restarted/);
  assert.equal(after.claimedBy(140000002), null);
  // The failure is dropped from the roster file — it must not retry forever.
  assert.equal(readRosterFile(rosterPath).length, 0);
});

test("an undecodable companion request is refused before any session exists", async () => {
  const log = [];
  const host = makeHost({ log });
  const outcome = await host.start({ ...COMPANION_START, request: { role: "not-a-real-role" } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "BOTCOMPANION_INVALID");
  assert.equal(log.some((row) => row[0] === "selectCharacter"), false);
});

test("a companion whose persisted request re-derives DIFFERENT risk classes than its grant is refused on resume", async () => {
  // The check decision 4 says must still earn its place: re-derive risk
  // classes from the persisted request (never trust the stored riskClasses
  // column) and compare against what the grant carries via
  // validateBotLaunchGrant — unchanged.
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(COMPANION_START);
  const raw = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  // The request on disk now asks for drones — analyzeCompanionRunPolicy would
  // add "combat" — but the persisted grant's riskClasses were pinned to the
  // ORIGINAL (drone-less) request and were never updated to match.
  raw.bots[0].request = { ...COMPANION_REQUEST, useDrones: true };
  fs.writeFileSync(rosterPath, JSON.stringify(raw), "utf8");

  const after = makeHost({
    persistPath: rosterPath,
    loadAccount: async () => ({ ...ACCOUNT }),
  });
  await after.resume();
  const [row] = after.list(7);
  assert.equal(row.status, "error");
  assert.match(String(row.why), /restarted/);
  assert.equal(after.claimedBy(140000002), null);
});

// ── Decision 5: the abandonment clock is durable ────────────────────────────
//
// A companion with nobody in its fleet this host is not flying gets safe, drops
// fleet and waits a bounded thirty minutes before releasing the hull. The bound
// is only a bound if its start time outlives a restart — otherwise every
// restart hands it a fresh thirty minutes, which is an unbounded wait assembled
// out of bounded ones.

const ABANDONED = Object.freeze({ abandonedAtMs: 1_700_000_000_000, supervisorCharacterIDs: [90000001] });

test("an abandonment pushed by the companion loop is written into the roster row", async () => {
  const log = [];
  const rosterPath = tempRosterPath();
  const host = makeHost({ log, persistPath: rosterPath });
  await host.start(COMPANION_START);
  assert.equal(readRosterFile(rosterPath)[0].abandonment, null);
  lastStore(log)._set({
    companion: {
      ...IDLE_COMPANION_SLICE,
      status: "running",
      phase: "Abandoned",
      abandonment: ABANDONED,
    },
  });
  assert.deepEqual(readRosterFile(rosterPath)[0].abandonment, ABANDONED);
});

test("the roster is NOT rewritten on every tick — only when the abandonment changes", async () => {
  // applySnapshot runs on every store push, roughly once every two seconds per
  // bot. An abandonment changes at most twice in a run, so the write is gated
  // on a real change rather than on the push.
  const log = [];
  const rosterPath = tempRosterPath();
  const host = makeHost({ log, persistPath: rosterPath });
  await host.start(COMPANION_START);
  const store = lastStore(log);
  const running = { ...IDLE_COMPANION_SLICE, status: "running", phase: "Abandoned", abandonment: ABANDONED };
  store._set({ companion: running });
  const afterFirst = fs.statSync(rosterPath).mtimeMs;
  for (let tick = 0; tick < 5; tick += 1) {
    store._set({ companion: { ...running, why: `tick ${tick}` } });
  }
  assert.equal(fs.statSync(rosterPath).mtimeMs, afterFirst);
});

test("supervision returning clears the persisted clock too", async () => {
  const log = [];
  const rosterPath = tempRosterPath();
  const host = makeHost({ log, persistPath: rosterPath });
  await host.start(COMPANION_START);
  const store = lastStore(log);
  store._set({
    companion: { ...IDLE_COMPANION_SLICE, status: "running", abandonment: ABANDONED },
  });
  assert.notEqual(readRosterFile(rosterPath)[0].abandonment, null);
  store._set({ companion: { ...IDLE_COMPANION_SLICE, status: "running", abandonment: null } });
  assert.equal(readRosterFile(rosterPath)[0].abandonment, null);
});

test("resume hands the ORIGINAL clock back to the loop, not a fresh one", async () => {
  const log = [];
  const rosterPath = tempRosterPath();
  const before = makeHost({ log, persistPath: rosterPath });
  await before.start(COMPANION_START);
  lastStore(log)._set({
    companion: { ...IDLE_COMPANION_SLICE, status: "running", abandonment: ABANDONED },
  });

  const resumeLog = [];
  const after = makeHost({
    log: resumeLog,
    persistPath: rosterPath,
    loadAccount: async (username) => (username === "test" ? { ...ACCOUNT } : null),
  });
  await after.resume();
  const call = resumeLog.find((row) => row[0] === "startFleetCompanion");
  assert.notEqual(call, undefined);
  assert.deepEqual(call[2], ABANDONED, "the resumed run must continue the same thirty minutes");
});

test("an undecodable persisted clock is DROPPED, never fatal to the start", async () => {
  // A row that cannot be trusted starts a fresh thirty minutes, which is still
  // bounded and still safe. Refusing the whole start would instead leave a
  // pilot flying with no host to stop it.
  const rosterPath = tempRosterPath();
  const before = makeHost({ persistPath: rosterPath });
  await before.start(COMPANION_START);
  const raw = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  raw.bots[0].abandonment = { abandonedAtMs: "the other day" };
  fs.writeFileSync(rosterPath, JSON.stringify(raw), "utf8");

  const resumeLog = [];
  const after = makeHost({
    log: resumeLog,
    persistPath: rosterPath,
    loadAccount: async (username) => (username === "test" ? { ...ACCOUNT } : null),
  });
  await after.resume();
  assert.equal(after.list(7).length, 1, "the companion must still come back");
  const call = resumeLog.find((row) => row[0] === "startFleetCompanion");
  assert.equal(call[2], null);
});

test("a script row never grows an abandonment field", async () => {
  // It is companion-shaped state; a script has no supervision gate at all.
  const rosterPath = tempRosterPath();
  const host = makeHost({ persistPath: rosterPath });
  await host.start(START);
  assert.equal("abandonment" in readRosterFile(rosterPath)[0], false);
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

test("owned hosted observation reads actual flow state without returning control capabilities", async () => {
  const log = [], scene = { shipID: 1001, ship: { characterID: START.characterID, position: { x: 1, y: 2, z: 3 } } };
  const fleetWork = { state: "inviting", lastCall: { outcome: "unknown", code: "CALL_REFUSED", httpStatus: 409 } };
  let reads = 0;
  const host = makeHost({ loadStack: makeFakeStack(log, (flow, store) => ({ ...flow,
    async loadFleet() { reads++; },
    async loadSpaceSnapshot() { reads++; store._set({ space: { snapshot: scene } }); },
    readMiningSupportFleet() { return { scope: { characterID: START.characterID }, snapshot: { availability: "not-in-fleet" } }; },
    readMiningSupportWork() { return { selfMining: { evaluated: true, reason: "target-change", targetID: 2001 } }; },
    readMiningSupportFleetDiagnostic() { return fleetWork; },
  })) });
  const started = await host.start(START);
  await settle();
  const before = reads;
  assert.equal(await host.readOwnedObservation(START.characterID, ACCOUNT.accountID + 1), null);
  assert.equal(reads, before);
  const observed = await host.readOwnedObservation(START.characterID, ACCOUNT.accountID);
  assert.deepEqual(observed.space, scene);
  assert.equal(observed.fleet.snapshot.availability, "not-in-fleet");
  assert.equal(observed.characterID, START.characterID);
  assert.equal(observed.supportWork.selfMining.reason, "target-change");
  assert.deepEqual(observed.fleetWork, fleetWork);
  observed.fleetWork.lastCall.httpStatus = 0;
  assert.equal(fleetWork.lastCall.httpStatus, 409);
  assert.equal(/private-claim|bot-token|web-session/.test(JSON.stringify(observed)), false);
  observed.space.ship.position.x = 99;
  assert.equal(scene.ship.position.x, 1);
  await host.stop(started.bot.botID, ACCOUNT.accountID);
  assert.equal(await host.readOwnedObservation(START.characterID, ACCOUNT.accountID), null);
});

test("hosted observation is discarded if ownership ends during its awaited read", async () => {
  let finish, pending = false;
  const host = makeHost({ loadStack: makeFakeStack([], flow => ({ ...flow,
    async loadFleet() { if (pending) await new Promise(resolve => { finish = resolve; }); },
    readMiningSupportFleet() { return null; },
  })) });
  const started = await host.start(START);
  pending = true;
  const read = host.readOwnedObservation(START.characterID, ACCOUNT.accountID);
  await settle();
  await host.stop(started.bot.botID, ACCOUNT.accountID);
  finish();
  assert.equal(await read, null);
});

test("hosted scene diagnostics retain failed-read unknown instead of presenting cached geometry", async () => {
  const host = makeHost({ loadStack: makeFakeStack([], (flow, store) => ({ ...flow,
    async loadFleet() {},
    async loadSpaceSnapshot() { store._set({ space: { snapshot: { shipID: 1001 }, error: "View unreadable" } }); },
    readMiningSupportFleet() { return null; },
  })) });
  await host.start(START);
  const observed = await host.readOwnedObservation(START.characterID, ACCOUNT.accountID);
  assert.equal(observed.space, null);
  assert.equal(observed.spaceError, "View unreadable");
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

const PREPARED_OPERATION = { ...START, operationID: "mining-op", operationRole: "MINER", operationRunID: "operation-run-1",
  operationPreparation: { providerCharacterID: 140000002, corporationID: 20, fittingID: 4, source: { kind: "hangar" } }, deferMain: true };

test("final hosted selection precedes preparation, and required members open MAIN together exactly once", async () => {
  const log = []; let releasePreparation;
  const preparationGate = new Promise(resolve => { releasePreparation = resolve; });
  let host;
  host = makeHost({ log, webAuth: { createSessionToken: () => "owned-token",
    verifySessionToken: () => ({ sessionID: "owned-web-session" }) },
    prepareOperation: async record => {
      assert.equal(log.at(-1)[0], "selectCharacter");
      assert.equal(record.webSessionID, "owned-web-session");
      assert.equal(host.authorizesClaim(record.characterID, record.claimSecret), true);
      record.assertPreparationCurrent(); log.push(["prepare", record.characterID]);
      await preparationGate;
      return { state: "VERIFIED", evidence: { equipment: "VERIFIED", supplies: "FULL", transfers: 0 } };
    },
    operationBarrierReady: () => host.list(7).length === 2 && host.list(7).every(row => row.preparation.state === "VERIFIED") });
  const pending = host.start(PREPARED_OPERATION);
  await settle(); assert.equal(host.list(7)[0].preparation.state, "PREPARING");
  assert.equal(log.some(row => row[0] === "startCustomBot"), false);
  releasePreparation(); const first = await pending;
  assert.equal(first.ok, true); assert.equal(first.bot.status, "paused");
  assert.equal((await host.activateOperationMember(first.bot.botID, 7, "mining-op", "operation-run-1")).code, "OPERATION_NOT_READY");
  const second = await host.start({ ...PREPARED_OPERATION, characterID: START.characterID + 1 });
  assert.equal(log.some(row => row[0] === "startCustomBot"), false);
  for (const bot of [first.bot, second.bot]) {
    assert.equal((await host.activateOperationMember(bot.botID, 7, "mining-op", "retired-run")).code, "OPERATION_PREPARATION_STALE");
    assert.equal((await host.activateOperationMember(bot.botID, 7, "mining-op", "operation-run-1")).ok, true);
    assert.equal((await host.activateOperationMember(bot.botID, 7, "mining-op", "operation-run-1")).ok, true);
  }
  assert.equal(log.filter(row => row[0] === "prepare").length, 2);
  assert.equal(log.filter(row => row[0] === "startCustomBot").length, 2);
  assert.equal(log.findIndex(row => row[0] === "startCustomBot") > log.findLastIndex(row => row[0] === "prepare"), true);
  await host.stop(first.bot.botID, 7); await host.stop(second.bot.botID, 7);
});

test("an asynchronous aggregate predicate cannot authorize deferred MAIN", async () => {
  const log = [], host = makeHost({ log,
    prepareOperation: async () => ({ state: "VERIFIED", evidence: { supplies: "FULL" } }),
    operationBarrierReady: async () => true });
  const started = await host.start(PREPARED_OPERATION);
  const result = await host.activateOperationMember(started.bot.botID, 7, "mining-op", "operation-run-1");
  assert.equal(result.ok, false); assert.equal(result.code, "OPERATION_NOT_READY");
  assert.equal(host.preparationForRun(started.bot.logicalRunID).mainEntered, false);
  assert.equal(host.list(7)[0].deferMain, true);
  assert.equal(log.some(row => row[0] === "startCustomBot"), false);
  assert.equal(host.claimedBy(START.characterID), started.bot.botID);
  await host.stop(started.bot.botID, 7);
});

for (const state of ["BLOCKED", "DEGRADED"]) test(`${state} preparation retains final owner and only operationally ready members activate`, async () => {
  const log = [], host = makeHost({ log, prepareOperation: async () => ({ state, reason: "Controlled shortage", evidence: { supplies: "LOW" } }),
    operationBarrierReady: () => true });
  const result = await host.start(PREPARED_OPERATION);
  assert.equal(result.ok, true); assert.equal(result.bot.preparation.state, state);
  assert.equal(host.claimedBy(START.characterID), result.bot.botID);
  assert.equal(log.some(row => row[0] === "logout"), false);
  const activation = await host.activateOperationMember(result.bot.botID, 7, "mining-op", "operation-run-1");
  assert.equal(activation.ok, state === "DEGRADED");
  assert.equal(log.filter(row => row[0] === "startCustomBot").length, state === "DEGRADED" ? 1 : 0);
  assert.equal((await host.stop(result.bot.botID, 7)).ok, true);
});

test("blocked preparation and its deferred peer park through the hosted safety gate without creating MAIN", async () => {
  const log = [], policy = { mode: "RETURN_HOME_DOCK", destination: { kind: "station", id: 60000649 } };
  const host = makeHost({ log, preparationUnresolved: () => false,
    prepareOperation: async record => ({ state: record.characterID === START.characterID ? "BLOCKED" : "VERIFIED",
      reason: "Required member shortage", evidence: { supplies: "LOW" } }),
    operationBarrierReady: () => false,
    loadStack: makeFakeStack(log, (flow, store) => {
      let runnerCreated = false;
      return { ...flow,
        async startCustomBot(doc) { runnerCreated = true; await flow.startCustomBot(doc); },
        async prepareCustomBotParking() {
          log.push(["runnerParking"]);
          if (!runnerCreated) throw new Error("operation runner unavailable; parking cannot take over a different controller");
        },
        async prepareHostedBotStop(kind, until) {
          assert.equal(kind, "script"); assert.equal(runnerCreated, false);
          assert.ok(Number.isFinite(until) && until > Date.now());
          log.push(["deferredSafety", store.station.get().online.characterID]);
          await flow.prepareHostedBotStop(kind);
        },
        async parkCustomBot(received, until) {
          assert.equal(runnerCreated, false); assert.deepEqual(received, policy);
          const characterID = store.station.get().online.characterID;
          assert.ok(host.claimedBy(characterID)); assert.ok(Number.isFinite(until));
          log.push(["deferredPark", characterID]);
          store._set({ flight: { status: { docked: true, stationID: policy.destination.id } } });
        },
      };
    }) });
  const blocked = await host.start(PREPARED_OPERATION);
  const peer = await host.start({ ...PREPARED_OPERATION, characterID: START.characterID + 1 });
  assert.equal(blocked.bot.preparation.state, "BLOCKED"); assert.equal(peer.bot.preparation.state, "VERIFIED");
  for (const member of [blocked.bot, peer.bot]) {
    assert.equal(host.preparationForRun(member.logicalRunID).mainEntered, false);
    assert.equal((await host.prepareOperationStop(member.botID, 7, "mining-op")).ok, true);
    assert.equal((await host.parkOperationMember(member.botID, 7, "mining-op", policy)).ok, true);
    const final = host.list(7).find(row => row.botID === member.botID);
    assert.equal(final.parking.state, "PARKED"); assert.equal(final.status, "stopped");
    assert.equal(host.claimedBy(member.characterID), null);
    assert.equal(host.preparationForRun(member.logicalRunID).mainEntered, false);
  }
  assert.equal(log.filter(row => row[0] === "deferredSafety").length, 2);
  assert.equal(log.filter(row => row[0] === "deferredPark").length, 2);
  assert.equal(log.filter(row => row[0] === "logout").length, 2);
  assert.equal(log.some(row => ["startCustomBot", "runnerParking"].includes(row[0])), false);
});

test("pending preparation blocks Stop/parking release; shared custody proof permits safe Stop and a fresh run", async () => {
  let pending = true, attempts = 0;
  const log = [], host = makeHost({ log, preparationUnresolved: () => pending,
    prepareOperation: async record => {
      attempts++; record.preparationCheckpoint.begin({ custodyOperationID: `transfer-${attempts}` });
      throw new Error("Transfer outcome requires exact reconciliation.");
    }, operationBarrierReady: () => true });
  const first = await host.start(PREPARED_OPERATION);
  assert.equal(first.bot.preparation.state, "RECOVERY_REQUIRED");
  assert.equal(first.bot.preparation.evidence.custodyOperationID, "transfer-1");
  assert.equal((await host.prepareOperationStop(first.bot.botID, 7, "mining-op")).ok, false);
  assert.equal(log.some(row => row[0] === "prepareHostedBotStop"), false, "unresolved custody cannot enter the deferred parking safety gate");
  assert.equal((await host.stop(first.bot.botID, 7)).ok, false);
  assert.equal(host.claimedBy(START.characterID), first.bot.botID);
  assert.equal(log.some(row => row[0] === "logout"), false);
  pending = false;
  assert.equal((await host.stop(first.bot.botID, 7)).ok, true);
  const next = await host.start({ ...PREPARED_OPERATION, operationRunID: "operation-run-2" });
  assert.notEqual(next.bot.logicalRunID, first.bot.logicalRunID);
  assert.equal(attempts, 2); assert.equal(log.some(row => row[0] === "startCustomBot"), false);
  await host.stop(next.bot.botID, 7);
});

test("a stopped preparation invocation cannot complete or activate a newer operation run", async () => {
  const log = []; let release, captured;
  const gate = new Promise(resolve => { release = resolve; });
  let attempts = 0;
  const host = makeHost({ log, prepareOperation: async record => {
    if (++attempts === 1) { captured = record; await gate; }
    return { state: "VERIFIED", evidence: { supplies: "FULL" } };
  }, operationBarrierReady: () => true, preparationUnresolved: () => false });
  const oldStart = host.start(PREPARED_OPERATION); await settle();
  const old = host.list(7)[0]; assert.equal((await host.stop(old.botID, 7)).ok, true);
  const next = await host.start({ ...PREPARED_OPERATION, operationRunID: "operation-run-2" });
  assert.throws(() => captured.preparationCheckpoint.complete({ state: "VERIFIED", evidence: {} }), { code: "OPERATION_PREPARATION_STALE" });
  release(); await oldStart;
  assert.equal(host.list(7).find(row => row.botID === next.bot.botID).preparation.state, "VERIFIED");
  assert.equal((await host.activateOperationMember(old.botID, 7, "mining-op", "operation-run-1")).ok, false);
  assert.equal(log.some(row => row[0] === "startCustomBot"), false);
  await host.stop(next.bot.botID, 7);
});

test("restart reconciles durable pending preparation before MAIN without replaying an unsafe productive script", async t => {
  const rosterPath = tempRosterPath();
  t.after(() => fs.rmSync(path.dirname(rosterPath), { recursive: true, force: true }));
  const launch = { ...PREPARED_OPERATION, doc: { valid: true, restartSafe: false } };
  let issued = 0, reconciled = 0;
  const before = makeHost({ persistPath: rosterPath, prepareOperation: async record => {
    record.preparationCheckpoint.begin({ before: 3200 });
    record.preparationCheckpoint.update({ custodyOperationID: "shared-transfer", reviewHash: "a".repeat(64), requested: 1800 });
    issued++; throw new Error("Lost result after shared transfer committed.");
  } });
  const started = await before.start(launch);
  assert.equal(started.bot.preparation.state, "RECOVERY_REQUIRED");
  const disk = readRosterFile(rosterPath)[0];
  assert.equal(disk.deferMain, true); assert.equal(disk.restartSafe, false);
  assert.equal(/private-claim-capability|bot-token/.test(fs.readFileSync(rosterPath, "utf8")), false);
  let after;
  const log = [];
  after = makeHost({ log, persistPath: rosterPath, createClaimSecret: () => "restored-private-generation",
    loadAccount: async () => ACCOUNT, loadScript: () => ({ scriptID: "s1", name: "Miner", rev: 1, doc: launch.doc }),
    isCharacterHeld: (_pilot, _caller, intent) => {
      assert.equal(intent.resumed, true); assert.equal(intent.logicalRunID, started.bot.logicalRunID); return false;
    }, prepareOperation: async record => {
      const pending = record.preparationCheckpoint.snapshot();
      assert.equal(pending.state, "RECOVERY_REQUIRED");
      assert.equal(pending.invocation, 1); assert.equal(pending.evidence.custodyOperationID, "shared-transfer");
      assert.throws(() => record.preparationCheckpoint.begin(), /requires reconciliation/);
      reconciled++; return { state: "VERIFIED", evidence: { after: 5000, reconciled: true } };
    }, operationBarrierReady: () => true,
    onOperationResume: async () => {
      const row = after.list(7)[0]; assert.equal(log.some(row => row[0] === "startCustomBot"), false);
      assert.equal(row.preparation.evidence.custodyOperationID, "shared-transfer");
      await after.activateOperationMember(row.botID, 7, "mining-op", "operation-run-1");
    } });
  await after.resume(); const restored = after.list(7)[0];
  assert.equal(restored.status, "running"); assert.equal(restored.logicalRunID, started.bot.logicalRunID);
  assert.equal(restored.preparation.evidence.before, 3200); assert.equal(restored.preparation.evidence.after, 5000);
  assert.equal(issued, 1); assert.equal(reconciled, 1); assert.equal(log.filter(row => row[0] === "startCustomBot").length, 1);
  await after.stop(restored.botID, 7);
});

test("restart restores completed preparation without another preparation call and waits for the aggregate callback", async t => {
  const rosterPath = tempRosterPath();
  t.after(() => fs.rmSync(path.dirname(rosterPath), { recursive: true, force: true }));
  let prepared = 0;
  const before = makeHost({ persistPath: rosterPath, prepareOperation: async () => {
    prepared++; return { state: "VERIFIED", evidence: { supplies: "FULL" } };
  }, operationBarrierReady: () => true });
  const first = await before.start(PREPARED_OPERATION);
  await before.activateOperationMember(first.bot.botID, 7, "mining-op", "operation-run-1");
  const log = []; let after;
  after = makeHost({ log, persistPath: rosterPath, loadAccount: async () => ACCOUNT,
    loadScript: () => ({ scriptID: "s1", name: "Miner", rev: 1, doc: START.doc }),
    prepareOperation: async () => { prepared++; assert.fail("Completed logical run must not top up again."); },
    operationBarrierReady: () => true, onOperationResume: async () => {
      const row = after.list(7)[0]; assert.equal(row.deferMain, true);
      assert.equal(log.some(row => row[0] === "startCustomBot"), false);
      await after.activateOperationMember(row.botID, 7, "mining-op", "operation-run-1");
    } });
  await after.resume(); const row = after.list(7)[0];
  assert.equal(row.logicalRunID, first.bot.logicalRunID); assert.equal(row.operationRunID, "operation-run-1");
  assert.equal(row.status, "running"); assert.equal(prepared, 1);
  await after.stop(row.botID, 7);
});

test("operation preparation refuses credential additions before final pilot selection", async () => {
  const log = [], host = makeHost({ log, prepareOperation: async () => assert.fail("Unauthorized intent reached preparation") });
  const result = await host.start({ ...PREPARED_OPERATION, operationPreparation: { ...PREPARED_OPERATION.operationPreparation,
    source: { kind: "hangar", claimSecret: "browser-secret" } } });
  assert.equal(result.code, "OPERATION_PREPARATION_INVALID");
  assert.equal(log.some(row => row[0] === "selectCharacter"), false);
  assert.equal(host.claimedBy(START.characterID), null);
});

test("productive fitting refusal remains blocked and cannot become success through repeated activation", async () => {
  const log = [];
  let validations = 0;
  const host = makeHost({ log, loadStack: makeFakeStack(log, flow => ({ ...flow, async startCustomBot() {
    validations++; throw Object.assign(new Error("ICE_EQUIPMENT_REQUIRED: fit lacks supported ice equipment"), { code: "ICE_EQUIPMENT_REQUIRED" });
  } })), prepareOperation: async () => ({ state: "VERIFIED", evidence: { supplies: "FULL" } }), operationBarrierReady: () => true });
  const started = await host.start(PREPARED_OPERATION);
  const activate = () => host.activateOperationMember(started.bot.botID, 7, "mining-op", "operation-run-1");
  assert.equal((await activate()).code, "ICE_EQUIPMENT_REQUIRED");
  assert.equal((await activate()).ok, false);
  assert.equal(validations, 1);
  assert.equal(host.list(7)[0].status, "paused");
  assert.match(host.list(7)[0].why, /ICE_EQUIPMENT_REQUIRED/);
  assert.equal(host.claimedBy(START.characterID), started.bot.botID);
  await host.stop(started.bot.botID, 7);
});

test("an unavailable resumed owner retains pending evidence without inventing a hosted claim", async t => {
  const rosterPath = tempRosterPath();
  t.after(() => fs.rmSync(path.dirname(rosterPath), { recursive: true, force: true }));
  const before = makeHost({ persistPath: rosterPath, prepareOperation: async record => {
    record.preparationCheckpoint.begin({ custodyOperationID: "shared-pending" }); throw new Error("Pending shared custody");
  } });
  const started = await before.start(PREPARED_OPERATION), log = [];
  const after = makeHost({ log, persistPath: rosterPath, isCharacterHeld: () => true, loadAccount: async () => ACCOUNT,
    loadScript: () => ({ scriptID: "s1", name: "Miner", rev: 1, doc: START.doc }), prepareOperation: async () => assert.fail("Unavailable owner cannot prepare") });
  await after.resume(); const retained = after.list(7)[0];
  assert.equal(retained.status, "paused"); assert.equal(retained.endedAt, null);
  assert.equal(retained.preparation.state, "RECOVERY_REQUIRED"); assert.equal(retained.preparationOwnerAvailable, false);
  assert.equal(retained.logicalRunID, started.bot.logicalRunID);
  assert.equal(after.claimedBy(START.characterID), null);
  assert.equal((await after.activateOperationMember(retained.botID, 7, "mining-op", "operation-run-1")).ok, false);
  const durable = after.preparationForRun(started.bot.logicalRunID);
  assert.equal(durable.evidence.custodyOperationID, "shared-pending");
  durable.evidence.custodyOperationID = "browser-addition";
  assert.equal(after.preparationForRun(started.bot.logicalRunID).evidence.custodyOperationID, "shared-pending");
  await after.stopAll();
  assert.equal(readRosterFile(rosterPath).length, 1);
  assert.equal(log.some(row => row[0] === "selectCharacter" || row[0] === "startCustomBot"), false);
});
