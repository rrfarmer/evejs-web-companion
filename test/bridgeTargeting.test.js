"use strict";

// Goal R23 slice A: the BFF's GENERIC in-space action layer — locking a target
// and switching a module on.
//
// The point of this slice is that it is NOT a mining feature. Locking a ball
// and running a module are the two verbs behind every in-space action in the
// game: a mining laser, a turret, a launcher, a salvager, a remote repper and
// an ewar module are the same two calls with a different module itemID and a
// different effect name. So the routes below take a target and a module, the
// effect name is an OPTIONAL argument, and a later combat goal needs no new BFF
// surface at all. These tests assert that generality directly.
//
//   GET  /api/bridge/targets            dogmaIM.GetTargets()
//   POST /api/bridge/targets/lock       dogmaIM.AddTarget(targetID)
//   POST /api/bridge/targets/unlock     dogmaIM.CancelAddTarget + RemoveTarget
//   POST /api/bridge/modules/activate   dogmaIM.Activate(itemID, effect, target, repeat)
//   POST /api/bridge/modules/deactivate dogmaIM.Deactivate(itemID, effect)
//
// The other thing pinned here is the "a 200 is not proof" discipline. AddTarget
// answers 200 while the lock is still being ACQUIRED, RemoveTarget returns null
// whether or not it dropped anything, and Activate can be accepted and then
// quietly not run. So every mutating route RE-READS the authoritative state and
// reports what actually happened — and when the re-read shows nothing changed
// and the server gave no reason, that is reported as such and never dressed up
// as a cause.
//
// Wire contract: docs/bridge-wire-contract.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const CHARACTERS = [{ characterID: 7, accountID: 4, characterName: "Test Pilot" }];
const BRIDGE_SESSION_ID = "opaque-gateway-minted-bridge-session-id";
const ORIGIN_STATION_ID = 60003760;
const ORIGIN_SYSTEM_ID = 30000142;
const SHIP_ID = 9001;
const ROCK_ID = 50001248;
const OTHER_ROCK_ID = 50001249;
const MODULE_ID = 7700001;
const AFTERBURNER_TYPE_ID = 439;
const CORE_PROBE_LAUNCHER_TYPE_ID = 17938;

const ORIGINAL_FETCH = global.fetch;
const activeServers = new Set();

function fakeAuth() {
  return {
    createSessionToken() {
      return COOKIE_TOKEN;
    },
    verifySessionToken(token) {
      return token === COOKIE_TOKEN
        ? { username: ACCOUNT.username, accountID: ACCOUNT.accountID, sessionID: SESSION_ID }
        : null;
    },
    countConfiguredUsers() {
      return 1;
    },
  };
}

function fakeStore() {
  return {
    async getAccount(username) {
      return username === ACCOUNT.username ? { ...ACCOUNT } : null;
    },
    async getCharacterForAccount(accountID, characterID) {
      return Number(accountID) === ACCOUNT.accountID &&
        CHARACTERS.some((c) => c.characterID === Number(characterID))
        ? { ...CHARACTERS[0] }
        : null;
    },
    async releaseCharacterControl() {
      return { controlState: "offline" };
    },
  };
}

function fakeStaticData() {
  return {
    getStation() { return null; },
    getTypeName(id) { return `Type ${id}`; },
    // The prop-mod effect resolver the deactivate route consults when the
    // browser sends a typeID (the AB/MWD asymmetry — see that route).
    getPropulsionEffectName(typeID) {
      return Number(typeID) === AFTERBURNER_TYPE_ID ? "moduleBonusAfterburner" : null;
    },
    // The launcher effect resolver the activate route consults when the browser
    // sends a typeID (a probe launcher only launches on "useMissiles").
    getLauncherEffectName(typeID) {
      return Number(typeID) === CORE_PROBE_LAUNCHER_TYPE_ID ? "useMissiles" : null;
    },
  };
}

/**
 * A gateway whose dogma state is real enough to tell the difference between
 * "accepted", "landed" and "quietly did nothing".
 *
 * `locked` is what GetTargets answers. `acquiring` is a lock the server has
 * accepted but not finished — exactly the state that makes a 200 from AddTarget
 * meaningless on its own. `active` is what the space snapshot reports cycling.
 */
function fakeGateway(overrides = {}) {
  const calls = { select: [], call: [], bind: [], boundCall: [], flightStatus: [], snapshot: [] };
  const state = {
    inSpace: true,
    locked: new Set(),
    acquiring: new Set(),
    active: new Set(),
    // When true the snapshot answers without an activeModuleIDs field at all,
    // so the "unknown, not off" path can be exercised.
    hideActiveModules: false,
    hideWeaponBanks: false,
    // A dogma method name -> refusal, so a handler's OWN reason can be raised.
    refuse: new Map(),
    // Methods that should be accepted and then do nothing (a silent decline).
    inert: new Set(),
    // Weapon banking: slave module itemID -> the bank master that actually
    // cycles. Empty by default, because banking is NOT reachable from this
    // browser (banks are built only by dogmaIM.LinkWeapons, which is not
    // allowlisted) — but the server behaviour is real, so it is pinned here.
    bankMaster: new Map(),
  };
  function flightSnapshot() {
    return {
      inSpace: state.inSpace,
      docked: !state.inSpace,
      solarSystemID: ORIGIN_SYSTEM_ID,
      stationID: state.inSpace ? null : ORIGIN_STATION_ID,
      structureID: null,
      shipID: SHIP_ID,
      shipMode: state.inSpace ? "STOP" : null,
      shipSpeedFraction: 0,
    };
  }
  const gateway = {
    calls,
    state,
    async selectCharacter(args, kwargs, sessionFields) {
      calls.select.push({ args, kwargs, sessionFields });
      return {
        bridgeSessionID: BRIDGE_SESSION_ID,
        service: "charUnboundMgr",
        method: "SelectCharacterID",
        result: null,
        notifications: [],
        session: {
          userid: 4,
          characterID: 7,
          characterName: "Test Pilot",
          stationID: ORIGIN_STATION_ID,
          structureID: null,
          solarSystemID: ORIGIN_SYSTEM_ID,
          corporationID: 98000000,
          shipID: SHIP_ID,
        },
      };
    },
    async releaseBridgeSession() {
      return { released: true, characterID: 7 };
    },
    async readFlightStatus(bridgeSessionID, sessionFields) {
      calls.flightStatus.push({ bridgeSessionID, sessionFields });
      return { flight: flightSnapshot(), notifications: [] };
    },
    async readSpaceSnapshot(bridgeSessionID, sessionFields) {
      calls.snapshot.push({ bridgeSessionID, sessionFields });
      const ship = { itemID: SHIP_ID, typeID: 606, name: "Test Pilot's ship" };
      if (!state.hideWeaponBanks) {
        ship.weaponBanks = {};
        for (const [slave, master] of state.bankMaster) (ship.weaponBanks[master] ??= []).push(slave);
      }
      if (!state.hideActiveModules) {
        ship.activeModuleIDs = [...state.active];
      }
      return {
        space: { inSpace: state.inSpace, shipID: SHIP_ID, entities: [], ship },
        notifications: [],
      };
    },
    async callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.call.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
      if (state.refuse.has(method)) {
        const error = new Error(state.refuse.get(method));
        error.code = "CALL_REFUSED";
        error.statusCode = 409;
        throw error;
      }
      const inert = state.inert.has(method);
      switch (method) {
        case "AddTarget": {
          const targetID = Number(args[0]);
          if (!inert) {
            state.acquiring.add(targetID);
          }
          // The retail pair: [pendingFlag, targetIDList].
          return {
            service,
            method,
            result: [inert ? 0 : 1, { type: "list", items: [...state.locked] }],
            notifications: [],
          };
        }
        case "CancelAddTarget":
          if (!inert) {
            state.acquiring.delete(Number(args[0]));
          }
          return { service, method, result: null, notifications: [] };
        case "RemoveTarget":
          if (!inert) {
            state.locked.delete(Number(args[0]));
          }
          return { service, method, result: null, notifications: [] };
        case "GetTargets":
          return {
            service,
            method,
            result: { type: "list", items: [...state.locked] },
            notifications: [],
          };
        case "Activate":
          if (!inert) {
            // WEAPON BANKING, as dogmaService.js Handle_Activate really does
            // it: a banked weapon is silently redirected to its bank MASTER,
            // and the snapshot then reports the master's itemID — never the
            // slave's. `bankMaster` maps slave -> master when set.
            state.active.add(state.bankMaster.get(Number(args[0])) ?? Number(args[0]));
          }
          return { service, method, result: 1, notifications: [] };
        case "Deactivate":
          if (!inert) {
            state.active.delete(state.bankMaster.get(Number(args[0])) ?? Number(args[0]));
          }
          return { service, method, result: 1, notifications: [] };
        default:
          return { service, method, result: null, notifications: [] };
      }
    },
    async bindObject(service, method, args) {
      return { boundHandle: `handle:${service}:${method}:${JSON.stringify(args)}`, service, method, notifications: [] };
    },
    async callBoundMethod(service, method) {
      return { service, method, result: null, notifications: [] };
    },
    ...overrides,
  };
  return gateway;
}

async function startTestServer(options = {}) {
  const app = createApp({
    moduleReconcileMs: 20,
    eveStore: options.store || fakeStore(),
    eveGatewayClient: options.gateway || fakeGateway(),
    webAuth: fakeAuth(),
    staticData: fakeStaticData(),
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}` };
}

async function apiRequest(baseUrl, path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (options.authenticated !== false) {
    headers.cookie = `evejs_web_poc=${COOKIE_TOKEN}`;
  }
  const response = await ORIGINAL_FETCH(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, payload: await response.json() };
}

async function inSpace(overrides) {
  const gateway = fakeGateway(overrides);
  const { baseUrl } = await startTestServer({ gateway });
  await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: 7 } });
  return { gateway, baseUrl };
}

function dogmaCallsOf(gateway, method) {
  return gateway.calls.call.filter((c) => c.service === "dogmaIM" && c.method === method);
}

test.afterEach(async () => {
  global.fetch = ORIGINAL_FETCH;
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    closing.push(new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }));
  }
  await Promise.all(closing);
});

// --- Reading what is locked -------------------------------------------------

test("the targets read is dogmaIM.GetTargets and answers plain itemIDs", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.locked.add(ROCK_ID);
  gateway.state.locked.add(OTHER_ROCK_ID);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/targets");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.targetIDs, [ROCK_ID, OTHER_ROCK_ID]);

  const reads = dogmaCallsOf(gateway, "GetTargets");
  assert.equal(reads.length, 1, "one GetTargets");
  assert.deepEqual(reads[0].args, [], "GetTargets takes no arguments");
});

// --- Locking ----------------------------------------------------------------

test("target reads preserve malformed authority as unknown and accept an actual empty list", async () => {
  let result = null;
  const { baseUrl } = await inSpace({ async callMethod(service, method) {
    return { service, method, result, notifications: [] };
  } });
  for (const raw of [null, {}, { type: "list" }, { type: "list", items: [ROCK_ID, null] },
    { type: "list", items: [{ value: ROCK_ID }] }, { type: "list", items: [0] },
    { type: "list", items: [Number.MAX_SAFE_INTEGER + 1] }, { type: "list", items: [{ type: "long", value: "1e3" }] }]) {
    result = raw;
    assert.equal((await apiRequest(baseUrl, "/api/bridge/targets")).payload.targetIDs, null);
  }
  result = { type: "list", items: [] };
  assert.deepEqual((await apiRequest(baseUrl, "/api/bridge/targets")).payload.targetIDs, []);
  result = { type: "list", items: [ROCK_ID, { type: "long", value: String(OTHER_ROCK_ID) }] };
  assert.deepEqual((await apiRequest(baseUrl, "/api/bridge/targets")).payload.targetIDs, [ROCK_ID, OTHER_ROCK_ID]);
});

test("lock sends AddTarget(targetID) and RE-READS rather than trusting the 200", async () => {
  const { gateway, baseUrl } = await inSpace();
  // The server accepts the attempt and finishes acquiring it before the re-read.
  gateway.state.locked.add(ROCK_ID);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/targets/lock", {
    method: "POST",
    body: { targetID: ROCK_ID },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.locked, true, "the re-read says it is locked");
  assert.equal(payload.acquiring, false);
  assert.deepEqual(payload.targetIDs, [ROCK_ID]);

  const adds = dogmaCallsOf(gateway, "AddTarget");
  assert.equal(adds.length, 1);
  assert.deepEqual(adds[0].args, [ROCK_ID], "AddTarget takes the target positionally");
  assert.equal(
    dogmaCallsOf(gateway, "GetTargets").length,
    1,
    "a lock must verify itself with a GetTargets re-read",
  );
});

test("a lock the server is still ACQUIRING is reported as acquiring, not as locked", async () => {
  const { baseUrl } = await inSpace();
  // The fake never moves the target into `locked`, so the re-read finds nothing —
  // exactly the real acquisition window.
  const { payload } = await apiRequest(baseUrl, "/api/bridge/targets/lock", {
    method: "POST",
    body: { targetID: ROCK_ID },
  });
  assert.equal(payload.locked, false, "it has NOT landed yet");
  assert.equal(payload.acquiring, true, "but the server accepted the attempt");
  assert.deepEqual(payload.targetIDs, []);
});

test("a lock the server neither accepts nor lands is reported as neither", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.inert.add("AddTarget");

  const { payload } = await apiRequest(baseUrl, "/api/bridge/targets/lock", {
    method: "POST",
    body: { targetID: ROCK_ID },
  });
  assert.equal(payload.ok, true, "the call itself succeeded");
  assert.equal(payload.locked, false);
  assert.equal(payload.acquiring, false, "a silent decline is not dressed up as progress");
});

test("a lock refusal carries the SERVER's own reason, untouched", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.refuse.set("AddTarget", "TargetTooFar");

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/targets/lock", {
    method: "POST",
    body: { targetID: ROCK_ID },
  });
  assert.equal(response.status, 409);
  assert.equal(payload.ok, false);
  assert.equal(payload.message, "TargetTooFar", "the handler's reason is passed through verbatim");
});

// --- Unlocking --------------------------------------------------------------

test("unlock cancels a pending acquisition AND removes a landed lock, then re-reads", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.locked.add(ROCK_ID);
  gateway.state.locked.add(OTHER_ROCK_ID);

  const { payload } = await apiRequest(baseUrl, "/api/bridge/targets/unlock", {
    method: "POST",
    body: { targetID: ROCK_ID },
  });
  assert.equal(payload.released, true);
  assert.deepEqual(payload.targetIDs, [OTHER_ROCK_ID], "only the one lock went");

  // One button, both states: CancelAddTarget abandons a lock still being
  // acquired, RemoveTarget drops one that landed.
  assert.deepEqual(dogmaCallsOf(gateway, "CancelAddTarget")[0].args, [ROCK_ID]);
  assert.deepEqual(dogmaCallsOf(gateway, "RemoveTarget")[0].args, [ROCK_ID]);
  assert.equal(dogmaCallsOf(gateway, "GetTargets").length, 1, "unlock verifies itself too");
});

test("unlock NEVER uses the bulk verbs — one lock at a time", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.locked.add(ROCK_ID);
  gateway.state.locked.add(OTHER_ROCK_ID);

  await apiRequest(baseUrl, "/api/bridge/targets/unlock", {
    method: "POST",
    body: { targetID: ROCK_ID },
  });
  // RemoveTargets / ClearTargets are not on the gateway allowlist at all, and
  // the BFF must not reach for them either: a stray click can only cost one lock.
  assert.equal(dogmaCallsOf(gateway, "RemoveTargets").length, 0);
  assert.equal(dogmaCallsOf(gateway, "ClearTargets").length, 0);
});

test("an unlock the server ignores reports that it is still locked", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.locked.add(ROCK_ID);
  gateway.state.inert.add("RemoveTarget");

  const { payload } = await apiRequest(baseUrl, "/api/bridge/targets/unlock", {
    method: "POST",
    body: { targetID: ROCK_ID },
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.released, false, "the re-read still shows the lock, so say so");
});

// --- Module activation ------------------------------------------------------

test("activate is GENERIC: module, OPTIONAL effect name, optional target, repeat", async () => {
  const { gateway, baseUrl } = await inSpace();

  // The plain form: no effect name at all. An empty effect makes the SERVER
  // resolve the module's own default activation effect from its typeID, so the
  // browser never has to know — or guess — what kind of module this is. That is
  // precisely what makes this route reusable for combat unchanged.
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/modules/activate", {
    method: "POST",
    body: { itemID: MODULE_ID },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.active, true);

  const activations = dogmaCallsOf(gateway, "Activate");
  assert.equal(activations.length, 1);
  assert.deepEqual(
    activations[0].args,
    [MODULE_ID, "", null, -1],
    "module, empty effect (server resolves it), no target, continuous cycle",
  );
});

test("activate passes a named effect, a target and a single-cycle repeat through", async () => {
  const { gateway, baseUrl } = await inSpace();

  await apiRequest(baseUrl, "/api/bridge/modules/activate", {
    method: "POST",
    body: { itemID: MODULE_ID, effect: "miningLaser", targetID: ROCK_ID, repeat: 0 },
  });
  assert.deepEqual(
    dogmaCallsOf(gateway, "Activate")[0].args,
    [MODULE_ID, "miningLaser", ROCK_ID, 0],
    "all four arguments survive the trip, positionally",
  );

  // The very same route, the very same shape, with a combat module and effect.
  // No new BFF surface — this is the whole point of slice A.
  await apiRequest(baseUrl, "/api/bridge/modules/activate", {
    method: "POST",
    body: { itemID: MODULE_ID, effect: "useMissiles", targetID: ROCK_ID },
  });
  assert.deepEqual(dogmaCallsOf(gateway, "Activate")[1].args, [
    MODULE_ID,
    "useMissiles",
    ROCK_ID,
    -1,
  ]);
});

test("⚠ activating a LAUNCHER by typeID names useMissiles", async () => {
  const { gateway, baseUrl } = await inSpace();

  await apiRequest(baseUrl, "/api/bridge/modules/activate", {
    method: "POST",
    body: { itemID: MODULE_ID, typeID: CORE_PROBE_LAUNCHER_TYPE_ID },
  });
  assert.deepEqual(
    dogmaCallsOf(gateway, "Activate")[0].args,
    [MODULE_ID, "useMissiles", null, -1],
    "without the name the server cycles a probe launcher and launches nothing",
  );
});

test("activating a NON-launcher by typeID keeps the empty effect, and a named one wins", async () => {
  const { gateway, baseUrl } = await inSpace();

  await apiRequest(baseUrl, "/api/bridge/modules/activate", {
    method: "POST",
    body: { itemID: MODULE_ID, typeID: AFTERBURNER_TYPE_ID },
  });
  assert.deepEqual(dogmaCallsOf(gateway, "Activate")[0].args, [MODULE_ID, "", null, -1]);

  gateway.state.active.delete(MODULE_ID);
  await apiRequest(baseUrl, "/api/bridge/modules/activate", {
    method: "POST",
    body: { itemID: MODULE_ID, typeID: CORE_PROBE_LAUNCHER_TYPE_ID, effect: "online" },
  });
  assert.deepEqual(dogmaCallsOf(gateway, "Activate")[1].args, [MODULE_ID, "online", null, -1]);
});

test("activate verifies against the SERVER's cycling list, not its own 200", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.inert.add("Activate");

  const { payload } = await apiRequest(baseUrl, "/api/bridge/modules/activate", {
    method: "POST",
    body: { itemID: MODULE_ID },
  });
  assert.equal(payload.ok, true, "the call succeeded");
  assert.equal(payload.active, false, "but nothing is running, and the re-read says so");
  assert.ok(gateway.calls.snapshot.length >= 1, "the verification is a snapshot read");
});

test("when the server cannot say what is running, the answer is UNKNOWN — never 'off'", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.hideActiveModules = true;

  const { payload } = await apiRequest(baseUrl, "/api/bridge/modules/activate", {
    method: "POST",
    body: { itemID: MODULE_ID },
  });
  assert.equal(payload.active, null, "null is 'not known', which is not the same as false");
  assert.equal(payload.activeModuleIDs, null);
});

test("a module refusal carries the SERVER's own reason, untouched", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.refuse.set("Activate", "You must be targeting something to activate that module.");

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/modules/activate", {
    method: "POST",
    body: { itemID: MODULE_ID },
  });
  assert.equal(response.status, 409);
  assert.equal(payload.message, "You must be targeting something to activate that module.");
});

test("deactivate is the same seam, and verifies the module actually stopped", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.active.add(MODULE_ID);

  const { payload } = await apiRequest(baseUrl, "/api/bridge/modules/deactivate", {
    method: "POST",
    body: { itemID: MODULE_ID },
  });
  assert.equal(payload.stopped, true);
  assert.deepEqual(dogmaCallsOf(gateway, "Deactivate")[0].args, [MODULE_ID, ""]);

  // And a deactivate the server ignores is reported honestly.
  gateway.state.active.add(MODULE_ID);
  gateway.state.inert.add("Deactivate");
  const second = await apiRequest(baseUrl, "/api/bridge/modules/deactivate", {
    method: "POST",
    body: { itemID: MODULE_ID },
  });
  assert.equal(second.payload.stopped, false, "it is still running, so say so");
});

// The AB/MWD asymmetry: the eve.js handler only routes a prop mod to its
// propulsion stop when the effect argument NAMES it — an empty effect takes the
// generic path, which answers success while the burner keeps cycling (observed
// live on a 1MN Civilian Afterburner). The browser sends the module's typeID
// and the BFF resolves the effect name from the SDE.
test("⚠ deactivating a PROP MOD by typeID names its propulsion effect", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.active.add(MODULE_ID);

  await apiRequest(baseUrl, "/api/bridge/modules/deactivate", {
    method: "POST",
    body: { itemID: MODULE_ID, typeID: AFTERBURNER_TYPE_ID },
  });
  assert.deepEqual(
    dogmaCallsOf(gateway, "Deactivate")[0].args,
    [MODULE_ID, "moduleBonusAfterburner"],
    "the resolved propulsion effect must reach dogmaIM.Deactivate",
  );
});

test("deactivating a NON-prop module by typeID keeps the empty effect", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.active.add(MODULE_ID);

  await apiRequest(baseUrl, "/api/bridge/modules/deactivate", {
    method: "POST",
    body: { itemID: MODULE_ID, typeID: 3634 },
  });
  assert.deepEqual(dogmaCallsOf(gateway, "Deactivate")[0].args, [MODULE_ID, ""]);
});

test("an explicit effect wins over the typeID resolution", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.active.add(MODULE_ID);

  await apiRequest(baseUrl, "/api/bridge/modules/deactivate", {
    method: "POST",
    body: { itemID: MODULE_ID, typeID: AFTERBURNER_TYPE_ID, effect: "online" },
  });
  assert.deepEqual(dogmaCallsOf(gateway, "Deactivate")[0].args, [MODULE_ID, "online"]);
});

// --- weapon banking (goal R29) ----------------------------------------------
//
// dogmaService.js Handle_Activate silently redirects a BANKED weapon to its
// bank master, and the space snapshot reports the MASTER's itemID only. So a
// weapon can start cycling without its own id ever appearing in the running
// set, and `activeModuleIDs.includes(itemID)` — which is what these two routes
// used to ask — would call a successful shot a failure and then report the gun
// as stopped while it was still firing.
//
// R29 measured that banking is NOT reachable from this browser today: banks are
// created only by dogmaIM.LinkWeapons, which is not allowlisted, and two
// same-type turrets fired together each reported their OWN itemID. These tests
// therefore pin a guard against a real server behaviour the client cannot yet
// trigger, so that opening LinkWeapons later cannot silently break the rack.

const SLAVE_MODULE_ID = 7700002;

test("a BANKED weapon reports active even though the snapshot names its master", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.locked.add(ROCK_ID);
  // The second gun is a slave of the first: activating it cycles the master.
  gateway.state.bankMaster.set(SLAVE_MODULE_ID, MODULE_ID);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/modules/activate", {
    method: "POST",
    body: { itemID: SLAVE_MODULE_ID, targetID: ROCK_ID },
  });

  assert.equal(response.status, 200);
  assert.equal(
    payload.active,
    true,
    "the running set GREW, so the activation landed — even under another id",
  );
  assert.deepEqual(
    payload.activeModuleIDs,
    [MODULE_ID],
    "and the ids are reported verbatim, never rewritten to flatter the caller",
  );
});

test("a banked weapon that is genuinely declined is still reported as not running", async () => {
  // The set-delta must not turn every activation into a success: when the
  // server accepts the call and cycles NOTHING, the set does not grow.
  const { gateway, baseUrl } = await inSpace();
  gateway.state.locked.add(ROCK_ID);
  gateway.state.bankMaster.set(SLAVE_MODULE_ID, MODULE_ID);
  gateway.state.inert.add("Activate");

  const { payload } = await apiRequest(baseUrl, "/api/bridge/modules/activate", {
    method: "POST",
    body: { itemID: SLAVE_MODULE_ID, targetID: ROCK_ID },
  });

  assert.equal(payload.active, false, "nothing started, so say so");
  assert.deepEqual(payload.activeModuleIDs, []);
});

test("an unavailable bank map remains unknown over an already-running rack", async () => {
  // The master is already cycling, so activating the slave changes the running
  // set not at all. From outside, with no bank map, that is indistinguishable
  // from the server ignoring the call outright — and this bridge does not get
  // to guess between "your gun is firing" and "your gun is not". It says so.
  const { gateway, baseUrl } = await inSpace();
  gateway.state.locked.add(ROCK_ID);
  gateway.state.bankMaster.set(SLAVE_MODULE_ID, MODULE_ID);
  gateway.state.active.add(MODULE_ID);
  gateway.state.hideWeaponBanks = true;

  const { payload } = await apiRequest(baseUrl, "/api/bridge/modules/activate", {
    method: "POST",
    body: { itemID: SLAVE_MODULE_ID, targetID: ROCK_ID },
  });

  assert.equal(
    payload.active,
    null,
    "unknowable from here: null, never a confident 'off' over a firing gun",
  );
  assert.deepEqual(payload.activeModuleIDs, [MODULE_ID], "the ids are still reported verbatim");
});

test("deactivating a banked weapon reports stopped when the master stops", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.bankMaster.set(SLAVE_MODULE_ID, MODULE_ID);
  gateway.state.active.add(MODULE_ID);

  const { payload } = await apiRequest(baseUrl, "/api/bridge/modules/deactivate", {
    method: "POST",
    body: { itemID: SLAVE_MODULE_ID },
  });

  assert.equal(payload.stopped, true, "the master left the running set");
  assert.deepEqual(payload.activeModuleIDs, []);
});

test("an unknown running set stays UNKNOWN rather than collapsing to off", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.locked.add(ROCK_ID);
  gateway.state.hideActiveModules = true;

  const { payload } = await apiRequest(baseUrl, "/api/bridge/modules/activate", {
    method: "POST",
    body: { itemID: MODULE_ID, targetID: ROCK_ID },
  });

  assert.equal(payload.active, null, "the snapshot could not answer: null, never false");
});

// --- Guards -----------------------------------------------------------------

test("every action refuses while docked, and refuses a missing target or module", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.inSpace = false;

  for (const [path, body] of [
    ["/api/bridge/targets/lock", { targetID: ROCK_ID }],
    ["/api/bridge/targets/unlock", { targetID: ROCK_ID }],
    ["/api/bridge/modules/activate", { itemID: MODULE_ID }],
    ["/api/bridge/modules/deactivate", { itemID: MODULE_ID }],
  ]) {
    const { response, payload } = await apiRequest(baseUrl, path, { method: "POST", body });
    assert.equal(response.status, 409, path);
    assert.equal(payload.error, "NOT_IN_SPACE", path);
  }

  gateway.state.inSpace = true;
  for (const [path, error] of [
    ["/api/bridge/targets/lock", "INVALID_TARGET"],
    ["/api/bridge/targets/unlock", "INVALID_TARGET"],
    ["/api/bridge/modules/activate", "INVALID_MODULE"],
    ["/api/bridge/modules/deactivate", "INVALID_MODULE"],
  ]) {
    const { response, payload } = await apiRequest(baseUrl, path, { method: "POST", body: {} });
    assert.equal(response.status, 400, path);
    assert.equal(payload.error, error, path);
  }
});

test("every action requires the web login session", async () => {
  const { baseUrl } = await inSpace();
  for (const path of [
    "/api/bridge/targets",
    "/api/bridge/targets/lock",
    "/api/bridge/targets/unlock",
    "/api/bridge/modules/activate",
    "/api/bridge/modules/deactivate",
  ]) {
    const { response } = await apiRequest(baseUrl, path, {
      method: path === "/api/bridge/targets" ? "GET" : "POST",
      body: path === "/api/bridge/targets" ? undefined : {},
      authenticated: false,
    });
    assert.equal(response.status, 401, path);
  }
});
