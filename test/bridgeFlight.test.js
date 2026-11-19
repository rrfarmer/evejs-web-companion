"use strict";

// Goal R5a: the BFF Flight routes drive manually-stepped space movement.
// ship.Undock is a top-level call on the held session; warp/jump/dock go
// through the beyonce remote-park bound-object two-step (the BFF holds the
// bound park handle server-side, keyed by solar system so a jump rebinds).
// A movement refusal passes through as the handler's own CALL_REFUSED message.
// Wire contract: docs/bridge-wire-contract.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");
const { PAGE_WRITE_PAIR_KEYS } = require("../src/bridgeCallPolicy");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const CHARACTERS = [{ characterID: 7, accountID: 4, characterName: "Test Pilot" }];
const BRIDGE_SESSION_ID = "opaque-gateway-minted-bridge-session-id";
const ORIGIN_STATION_ID = 60003760;
const ORIGIN_SYSTEM_ID = 30000142;
const DEST_SYSTEM_ID = 30000140;
const DEST_STATION_ID = 60003454;
const SHIP_ID = 9001;
const GATE_ID = 50001248;
const DEST_GATE_ID = 50000802;
const STRUCTURE_GATE_ID = 1030000000001;

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
  return { getStation() { return null; }, getTypeName(id) { return `Type ${id}`; } };
}

// A fake gateway whose flight state advances the way the real space handlers do:
// docked -> (undock) in space -> (jump) new system -> (dock) docked. Records the
// select/call/bind/boundCall traffic so the routes' behaviour is asserted.
function fakeGateway(overrides = {}) {
  const calls = { select: [], release: [], call: [], bind: [], boundCall: [], flightStatus: [] };
  const state = {
    inSpace: false,
    solarSystemID: ORIGIN_SYSTEM_ID,
    stationID: ORIGIN_STATION_ID,
    shipMode: null,
  };
  function flightSnapshot() {
    return {
      inSpace: state.inSpace,
      docked: !state.inSpace && state.stationID !== null,
      solarSystemID: state.solarSystemID,
      stationID: state.inSpace ? null : state.stationID,
      structureID: null,
      shipID: SHIP_ID,
      shipMode: state.inSpace ? state.shipMode : null,
      shipSpeedFraction: state.inSpace && state.shipMode === "WARP" ? 1 : 0,
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
    async releaseBridgeSession(bridgeSessionID, sessionFields) {
      calls.release.push({ bridgeSessionID, sessionFields });
      return { released: true, characterID: 7 };
    },
    async readFlightStatus(bridgeSessionID, sessionFields) {
      calls.flightStatus.push({ bridgeSessionID, sessionFields });
      return { flight: flightSnapshot(), notifications: [] };
    },
    async readSpaceSnapshot() {
      return { space: { inSpace: state.inSpace, solarSystemID: state.solarSystemID,
        ship: { itemID: SHIP_ID }, entities: [] }, notifications: [] };
    },
    async callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.call.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
      if (service === "ship" && method === "Undock") {
        state.inSpace = true;
        state.shipMode = "STOP";
      } else if (service === "beyonce" && method === "CmdStargateJump") {
        // The page's own jump, asked by name (the generic call), lands where the bound one did.
        state.solarSystemID = DEST_SYSTEM_ID;
        state.shipMode = "STOP";
      } else if (service === "beyonce" && method === "CmdDock") {
        // The page's own dock, asked by name (the generic call), seats the ship where the bound one did.
        state.inSpace = false;
        state.stationID = Number(args[0]);
        state.shipMode = null;
      } else if (service === "structureJumpBridgeMgr" && method === "GetJbStructureDestination") {
        return { service, method, result: DEST_SYSTEM_ID, notifications: [] };
      } else if (service === "structureJumpBridgeMgr" && method === "CmdJumpThroughStructureStargate") {
        state.solarSystemID = DEST_SYSTEM_ID;
        state.shipMode = "STOP";
      }
      return { service, method, result: null, notifications: [] };
    },
    async bindObject(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.bind.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
      return {
        boundHandle: `handle:${service}:${method}:${JSON.stringify(args)}`,
        service,
        method,
        notifications: [],
      };
    },
    async callBoundMethod(service, method, args, kwargs, sessionFields, bridgeSessionID, boundHandle) {
      calls.boundCall.push({ service, method, args, kwargs, sessionFields, bridgeSessionID, boundHandle });
      if (method === "CmdWarpToStuffAutopilot") {
        state.shipMode = "WARP";
      } else if (method === "CmdStargateJump") {
        state.solarSystemID = DEST_SYSTEM_ID;
        state.shipMode = "STOP";
      }
      return { service, method, result: null, notifications: [] };
    },
    ...overrides,
  };
  return gateway;
}

async function startTestServer(options = {}) {
  const app = createApp({
    eveStore: options.store || fakeStore(),
    eveGatewayClient: options.gateway || fakeGateway(),
    webAuth: fakeAuth(),
    staticData: fakeStaticData(),
    // No retail client to read, whatever this machine has: the words are this client's own unless a test says otherwise.
    clientWords: options.clientWords || { available: () => false, dialog: () => null },
    errorLogger() {},
    transitionReadyTimeoutMs: options.transitionReadyTimeoutMs,
    transitionPollMs: options.transitionPollMs,
    transitionSleep: options.transitionSleep,
    transitionNow: options.transitionNow,
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

async function selectOnServer(baseUrl) {
  const selected = await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: 7 } });
  assert.equal(selected.response.status, 200);
  const ready = await apiRequest(baseUrl, "/api/bridge/drone-recovery/ready", {
    method: "POST", body: { checkID: selected.payload.droneRecoveryCheckID },
  });
  assert.equal(ready.response.status, 200, JSON.stringify(ready.payload));
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

test("GET /api/bridge/flight/status returns the docked snapshot", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/status");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.flight.docked, true);
  assert.equal(payload.flight.stationID, ORIGIN_STATION_ID);
  assert.equal(gateway.calls.flightStatus[0].bridgeSessionID, BRIDGE_SESSION_ID);
});

// The pilot's undock as the page makes it since 2026-10-14 (web/src/bridge/placeChanges.ts): ship.Undock(the
// pilot's ship, ignoreContraband, onlineModules=...) through the generic call, a pilot's write the page means, under
// the BFF's keeping of the session change (ui/station/base.py 488 to 521). Its route is gone.
const undockBody = (ignoreContraband) => ({ service: "ship", method: "Undock", args: [SHIP_ID, ignoreContraband], kwargs: { onlineModules: [] }, pilot: true, confirm: true });

test("the page's undock calls ship.Undock and is answered once the ship is in space", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: undockBody(false) });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal((await apiRequest(baseUrl, "/api/bridge/flight/status")).payload.flight.inSpace, true);
  const undock = gateway.calls.call.find((c) => c.service === "ship" && c.method === "Undock");
  assert.ok(undock, "ship.Undock dispatched");
  assert.equal(undock.args[0], SHIP_ID);
  assert.deepEqual(undock.kwargs, { onlineModules: [] });
  assert.equal(undock.bridgeSessionID, BRIDGE_SESSION_ID);
});

test("undock is refused when already in space", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: undockBody(false) });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "ALREADY_IN_SPACE");
});

test("POST /api/bridge/flight/warp binds the park and dispatches CmdWarpToStuffAutopilot; no handle reaches the browser", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/warp", {
    method: "POST",
    body: { destinationID: GATE_ID },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(JSON.stringify(payload).includes("handle:"), false, "bound handle must never reach the browser");

  // The park was bound as beyonce.MachoBindObject([[systemID, 5]]).
  const bind = gateway.calls.bind.find((b) => b.service === "beyonce" && b.method === "MachoBindObject");
  assert.ok(bind, "beyonce park bound");
  assert.deepEqual(bind.args, [[ORIGIN_SYSTEM_ID, 5]]);
  // Warp dispatched on the park handle, riding the held bridge session.
  const warp = gateway.calls.boundCall.find((c) => c.method === "CmdWarpToStuffAutopilot");
  assert.ok(warp, "CmdWarpToStuffAutopilot dispatched");
  assert.deepEqual(warp.args, [GATE_ID]);
  assert.equal(warp.bridgeSessionID, BRIDGE_SESSION_ID);
  assert.match(warp.boundHandle, /^handle:beyonce:MachoBindObject/);
  // The follow-up status shows the ship warping.
  assert.equal(payload.flight.shipMode, "WARP");
});

test("warp is refused when docked (NOT_IN_SPACE)", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/warp", {
    method: "POST",
    body: { destinationID: GATE_ID },
  });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "NOT_IN_SPACE");
  assert.equal(gateway.calls.boundCall.length, 0, "no movement dispatched when docked");
});

// The pilot's jump as the page makes it since 2026-10-14 (web/src/bridge/placeChanges.ts): beyonce.CmdStargateJump(the
// gate, its far gate, the pilot's ship) through the generic call, under the BFF's keeping of the session change, the
// park bound again in the new system before the answer (gateJumpSvc.py 98 to 127). Its route is gone: these tests
// ask the jump so, and watch the fake's call by name where they watched its bound call.
const jumpBody = { service: "beyonce", method: "CmdStargateJump", args: [GATE_ID, DEST_GATE_ID, SHIP_ID], kwargs: null, pilot: true, confirm: true };
const jumpsSent = (gateway) => gateway.calls.call.filter((call) => call.method === "CmdStargateJump");

test("the page's jump dispatches CmdStargateJump; the follow-up status shows the new system", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: jumpBody });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  const jump = jumpsSent(gateway)[0];
  assert.ok(jump, "CmdStargateJump dispatched");
  assert.deepEqual(jump.args, [GATE_ID, DEST_GATE_ID, SHIP_ID]);
  const after = (await apiRequest(baseUrl, "/api/bridge/flight/status")).payload.flight;
  assert.equal(after.solarSystemID, DEST_SYSTEM_ID);
  assert.equal(after.transition.phase, "ready");
  assert.equal(after.transition.locationReady, true);
  assert.equal(after.transition.sceneReady, true);
  assert.equal(after.transition.egoReady, true);
});

test("wormhole entry accepts one local endpoint and waits for the destination park", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const callMethod = gateway.callMethod.bind(gateway);
  const readSpaceSnapshot = gateway.readSpaceSnapshot.bind(gateway);
  let dispatched = false;
  let reads = 0;
  gateway.callMethod = async (...args) => {
    const reply = await callMethod(...args);
    if (args[0] === "wormholeMgr" && args[1] === "WormholeJump") {
      dispatched = true;
      gateway.state.solarSystemID = DEST_SYSTEM_ID;
    }
    return reply;
  };
  gateway.readSpaceSnapshot = async () => {
    if (dispatched && ++reads === 1) return { space: { inSpace: true, solarSystemID: DEST_SYSTEM_ID, ship: null } };
    return readSpaceSnapshot();
  };
  const { baseUrl } = await startTestServer({ gateway, transitionPollMs: 1 });
  await selectOnServer(baseUrl);
  const endpoint = 9920000043181;
  const body = { ...jumpBody, service: "wormholeMgr", method: "WormholeJump", args: [endpoint] };

  const malformed = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: { ...body, args: [endpoint, DEST_SYSTEM_ID] } });
  assert.equal(malformed.response.status, 400);
  assert.equal(dispatched, false);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(gateway.calls.call.filter(({ method }) => method === "WormholeJump").map(({ args }) => args), [[endpoint]]);
  assert.ok(reads >= 2, "waits until the new scene has the pilot's ship");
  const after = (await apiRequest(baseUrl, "/api/bridge/flight/status")).payload.flight;
  assert.equal(after.solarSystemID, DEST_SYSTEM_ID);
  assert.equal(after.transition.phase, "ready");
});

test("a slow jump waits past the ten-second cooldown for observed readiness and dispatches once", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const callMethod = gateway.callMethod.bind(gateway);
  const readFlightStatus = gateway.readFlightStatus.bind(gateway);
  let pendingJump = false;
  let postJumpReads = 0;
  gateway.callMethod = async (...args) => {
    const outcome = await callMethod(...args);
    if (args[1] === "CmdStargateJump") {
      // The command was accepted, but the destination session is deliberately
      // not usable until 12.5 simulated seconds later.
      gateway.state.solarSystemID = ORIGIN_SYSTEM_ID;
      pendingJump = true;
    }
    return outcome;
  };
  gateway.readFlightStatus = async (...args) => {
    if (pendingJump) {
      postJumpReads += 1;
      if (postJumpReads >= 51) {
        gateway.state.solarSystemID = DEST_SYSTEM_ID;
        pendingJump = false;
      }
    }
    return readFlightStatus(...args);
  };

  let clockMs = 0;
  const { baseUrl } = await startTestServer({
    gateway,
    transitionReadyTimeoutMs: 20_000,
    transitionPollMs: 250,
    transitionNow: () => clockMs,
    transitionSleep: async (ms) => { clockMs += ms; },
  });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: jumpBody });

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal((await apiRequest(baseUrl, "/api/bridge/flight/status")).payload.flight.solarSystemID, DEST_SYSTEM_ID);
  assert.ok(clockMs > 10_000, `readiness took ${clockMs} simulated ms`);
  assert.equal(
    jumpsSent(gateway).length,
    1,
    "the session-changing command is never retried while readiness is pending",
  );
});

test("ordinary writes are blocked before transition readiness and allowed during the remaining cooldown", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const callMethod = gateway.callMethod.bind(gateway);
  const readFlightStatus = gateway.readFlightStatus.bind(gateway);
  let jumpPending = false;
  let signalJumpIssued;
  let releaseReadiness;
  const jumpIssued = new Promise((resolve) => { signalJumpIssued = resolve; });
  const readinessGate = new Promise((resolve) => { releaseReadiness = resolve; });

  gateway.callMethod = async (...args) => {
    const outcome = await callMethod(...args);
    if (args[1] === "CmdStargateJump") {
      gateway.state.solarSystemID = ORIGIN_SYSTEM_ID;
      jumpPending = true;
      signalJumpIssued();
    }
    return outcome;
  };
  gateway.readFlightStatus = async (...args) => {
    if (jumpPending) {
      await readinessGate;
    }
    return readFlightStatus(...args);
  };

  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const jumpRequest = apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: jumpBody });
  await jumpIssued;

  const allowedRead = await apiRequest(baseUrl, "/api/bridge/call", {
    method: "POST",
    body: { service: "charMgr", method: "GetPublicInfo3", args: [], kwargs: null },
  });
  assert.equal(allowedRead.response.status, 200, "read-only bridge calls remain available");

  const blockedWarp = await apiRequest(baseUrl, "/api/bridge/flight/warp", {
    method: "POST",
    body: { destinationID: GATE_ID },
  });
  assert.equal(blockedWarp.response.status, 409);
  assert.equal(blockedWarp.payload.error, "SESSION_CHANGE_IN_PROGRESS");
  assert.equal(
    gateway.calls.boundCall.filter((call) => call.method === "CmdWarpToStuffAutopilot").length,
    0,
    "the ordinary write must not dispatch before readiness",
  );

  gateway.state.solarSystemID = DEST_SYSTEM_ID;
  jumpPending = false;
  releaseReadiness();
  const completedJump = await jumpRequest;
  assert.equal(completedJump.response.status, 200, JSON.stringify(completedJump.payload));
  assert.equal((await apiRequest(baseUrl, "/api/bridge/flight/status")).payload.flight.transition.phase, "ready");

  // Readiness and the next-session-mutation timer are separate. A normal warp
  // is legal immediately after readiness even though another jump/dock/board
  // would still have to wait for the advertised ten-second timer.
  const allowedWarp = await apiRequest(baseUrl, "/api/bridge/flight/warp", {
    method: "POST",
    body: { destinationID: GATE_ID },
  });
  assert.equal(allowedWarp.response.status, 200, JSON.stringify(allowedWarp.payload));
  assert.equal(
    gateway.calls.boundCall.filter((call) => call.method === "CmdWarpToStuffAutopilot").length,
    1,
  );
});

// The page's own form of a write (the plan's Phase 6b) is by the generic call, which is no read for being one: the
// gate of a session's change takes it for the write it names.
test("a write by the generic call is blocked before transition readiness as a route's is, and a read by it is not", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const callMethod = gateway.callMethod.bind(gateway);
  const readFlightStatus = gateway.readFlightStatus.bind(gateway);
  let jumpPending = false;
  let signalJumpIssued;
  let releaseReadiness;
  const jumpIssued = new Promise((resolve) => { signalJumpIssued = resolve; });
  const readinessGate = new Promise((resolve) => { releaseReadiness = resolve; });
  gateway.callMethod = async (...args) => {
    const outcome = await callMethod(...args);
    if (args[1] === "CmdStargateJump") {
      gateway.state.solarSystemID = ORIGIN_SYSTEM_ID;
      jumpPending = true;
      signalJumpIssued();
    }
    return outcome;
  };
  gateway.readFlightStatus = async (...args) => {
    if (jumpPending) {
      await readinessGate;
    }
    return readFlightStatus(...args);
  };
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const byTheCall = (service, method, more) => apiRequest(baseUrl, "/api/bridge/call", {
    method: "POST",
    body: { service, method, args: [], kwargs: null, ...more },
  });
  const stopsSent = () => [...gateway.calls.call, ...gateway.calls.boundCall].filter((call) => call.method === "CmdStop").length;
  const jumpRequest = apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: jumpBody });
  await jumpIssued;

  let read;
  let blocked;
  let sentWhileBlocked;
  try {
    read = await byTheCall("charMgr", "GetPublicInfo3", {});
    blocked = await byTheCall("beyonce", "CmdStop", { pilot: true, confirm: true });
    sentWhileBlocked = stopsSent();
  } finally {
    // (Whatever was found, the jump is let finish: a request left waiting holds the server open.)
    gateway.state.solarSystemID = DEST_SYSTEM_ID;
    jumpPending = false;
    releaseReadiness();
  }
  assert.equal(read.response.status, 200, "a read by the call remains available");
  assert.deepEqual([blocked.response.status, blocked.payload.error], [409, "SESSION_CHANGE_IN_PROGRESS"]);
  assert.equal(sentWhileBlocked, 0, "the write by the call must not dispatch before readiness");

  const completedJump = await jumpRequest;
  assert.equal(completedJump.response.status, 200, JSON.stringify(completedJump.payload));
  const allowed = await byTheCall("beyonce", "CmdStop", { pilot: true, confirm: true });
  assert.equal(allowed.response.status, 200, JSON.stringify(allowed.payload));
  assert.equal(stopsSent(), 1, "and with the change done, it is sent");
});

// The flight routes' gate (src/server.js): no order to the ship while the pilot's login check for lost drones is
// unresolved, the stop excepted. The page orders its ship by the generic call now (the plan's Phase 6b).
test("an order to the ship by the generic call is held back while the pilot's lost drones are looked for, as a flight route's is, and the stop is not", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const { baseUrl } = await startTestServer({ gateway });
  const selected = await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: 7 } });
  assert.equal(selected.response.status, 200);
  const byTheCall = (service, method, args = [], more = { pilot: true, confirm: true }) => apiRequest(baseUrl, "/api/bridge/call", {
    method: "POST",
    body: { service, method, args, kwargs: null, ...more },
  });
  const sent = () => [...gateway.calls.call, ...gateway.calls.boundCall].map((call) => call.method);
  const before = sent().length;

  const route = await apiRequest(baseUrl, "/api/bridge/flight/warp", { method: "POST", body: { destinationID: GATE_ID } });
  assert.deepEqual([route.response.status, route.payload.error], [409, "DRONE_RECOVERY_PENDING"], "a flight route");
  // Every write of the page's own on beyonce was a flight route's (bridgeCallPolicy.js): each of them but the stop.
  const orders = [...PAGE_WRITE_PAIR_KEYS].filter((pair) => pair.startsWith("beyonce.") && pair !== "beyonce.CmdStop").map((pair) => pair.slice("beyonce.".length));
  assert.ok(orders.length >= 9 && ["CmdWarpToStuff", "CmdWarpToStuffAutopilot", "CmdFollowBall", "CmdOrbit", "CmdAlignTo", "CmdGotoPoint"].every((each) => orders.includes(each)), orders.join(", "));
  for (const method of orders) {
    const held = await byTheCall("beyonce", method);
    assert.deepEqual([held.response.status, held.payload.error], [409, "DRONE_RECOVERY_PENDING"], method);
  }
  assert.equal(sent().length, before, "nothing of them is sent");

  const read = await byTheCall("charMgr", "GetPublicInfo3", [], {});
  assert.equal(read.response.status, 200, "a read by the call is not held back");
  const stop = await byTheCall("beyonce", "CmdStop");
  assert.equal(stop.response.status, 200, JSON.stringify(stop.payload));
  assert.equal(sent().filter((method) => method === "CmdStop").length, 1, "the stop is sent");

  const ready = await apiRequest(baseUrl, "/api/bridge/drone-recovery/ready", { method: "POST", body: { checkID: selected.payload.droneRecoveryCheckID } });
  assert.equal(ready.response.status, 200, JSON.stringify(ready.payload));
  const after = await byTheCall("beyonce", "CmdSetSpeedFraction", [1]);
  assert.equal(after.response.status, 200, JSON.stringify(after.payload));
  assert.equal(sent().filter((method) => method === "CmdSetSpeedFraction").length, 1, "and with the check done, an order is");
});

test("an uncertain jump timeout stays latched and blocks a repeated write", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const callMethod = gateway.callMethod.bind(gateway);
  gateway.callMethod = async (...args) => {
    const outcome = await callMethod(...args);
    if (args[1] === "CmdStargateJump") {
      gateway.state.solarSystemID = ORIGIN_SYSTEM_ID;
    }
    return outcome;
  };

  let clockMs = 0;
  const { baseUrl } = await startTestServer({
    gateway,
    transitionReadyTimeoutMs: 1_000,
    transitionPollMs: 250,
    transitionNow: () => clockMs,
    transitionSleep: async (ms) => { clockMs += ms; },
  });
  await selectOnServer(baseUrl);

  const first = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: jumpBody });
  assert.equal(first.response.status, 504);
  assert.equal(first.payload.error, "TRANSITION_TIMEOUT");
  assert.equal(first.payload.transition.phase, "failed");

  const second = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: jumpBody });
  assert.equal(second.response.status, 409);
  assert.equal(second.payload.error, "SESSION_CHANGE_IN_PROGRESS");
  assert.equal(
    jumpsSent(gateway).length,
    1,
    "an uncertain write is never repeated",
  );
});

test("a warp that succeeded is not reported failed because the after-read timed out", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const readFlightStatus = gateway.readFlightStatus.bind(gateway);
  let warped = false;
  const callBoundMethod = gateway.callBoundMethod.bind(gateway);
  gateway.callBoundMethod = async (...args) => {
    const outcome = await callBoundMethod(...args);
    if (args[1] === "CmdWarpToStuffAutopilot") {
      warped = true;
    }
    return outcome;
  };
  gateway.readFlightStatus = async (...args) => {
    if (warped) {
      // The gateway is busiest right after a movement command: the follow-up
      // snapshot aborts the way a 10 s AbortError surfaces.
      const error = new Error("EveJS gateway timed out.");
      error.code = "EVE_GATEWAY_TIMEOUT";
      throw error;
    }
    return readFlightStatus(...args);
  };

  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/warp", {
    method: "POST",
    body: { destinationID: GATE_ID },
  });
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.ok, true);
  // The flight degrades to the before-snapshot rather than failing the command.
  assert.equal(payload.flight.inSpace, true);
  assert.equal(
    gateway.calls.boundCall.filter((call) => call.method === "CmdWarpToStuffAutopilot").length,
    1,
  );
});

test("a latched transition heals on the next authoritative status read", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const callMethod = gateway.callMethod.bind(gateway);
  let jumps = 0;
  gateway.callMethod = async (...args) => {
    const outcome = await callMethod(...args);
    if (args[1] === "CmdStargateJump") {
      jumps += 1;
      if (jumps === 1) {
        // The first jump never lands: the readiness wait must time out.
        gateway.state.solarSystemID = ORIGIN_SYSTEM_ID;
      }
    }
    return outcome;
  };

  let clockMs = 0;
  const { baseUrl } = await startTestServer({
    gateway,
    transitionReadyTimeoutMs: 1_000,
    transitionPollMs: 250,
    transitionNow: () => clockMs,
    transitionSleep: async (ms) => { clockMs += ms; },
  });
  await selectOnServer(baseUrl);

  const first = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: jumpBody });
  assert.equal(first.response.status, 504);
  assert.equal(first.payload.transition.phase, "failed");

  // The recovery is NOT a character re-select: the very next authoritative
  // flight read shows the ship stable in the origin system — the write never
  // took — and releases the latch.
  const statusRead = await apiRequest(baseUrl, "/api/bridge/flight/status");
  assert.equal(statusRead.response.status, 200);
  assert.equal(statusRead.payload.flight.transition.phase, "ready");
  assert.equal(statusRead.payload.flight.transition.sessionStable, true);

  const second = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: jumpBody });
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  const healed = (await apiRequest(baseUrl, "/api/bridge/flight/status")).payload.flight;
  assert.equal(healed.solarSystemID, DEST_SYSTEM_ID);
  assert.equal(healed.transition.phase, "ready");
  assert.equal(
    jumpsSent(gateway).length,
    2,
    "the retry dispatches once the read resolved the uncertainty",
  );
});

// The pilot's dock as the page makes it (web/src/bridge/placeChanges.ts; a station's since 2026-10-14, a structure's
// since the dock route went the same day): beyonce.CmdDock(the station, the pilot's ship) through the generic call,
// under the BFF's keeping of the session change (movementFunctions.RealDock). Its route is gone: these tests ask the
// dock so, and watch the fake's call by name where they watched its bound call.
const dockBody = (stationID) => ({ service: "beyonce", method: "CmdDock", args: [stationID, SHIP_ID], kwargs: null, pilot: true, confirm: true });
const docksSent = (gateway) => gateway.calls.call.filter((call) => call.method === "CmdDock");

test("a silently declined dock answers in-space instead of burning the barrier, and the retry is legal", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const callMethod = gateway.callMethod.bind(gateway);
  let docks = 0;
  gateway.callMethod = async (...args) => {
    if (args[1] === "CmdDock") {
      docks += 1;
      if (docks === 1) {
        // R24's measured silent decline: 200/null and the ship never seats.
        gateway.calls.call.push({ service: args[0], method: args[1], args: args[2] });
        return { service: args[0], method: args[1], result: null, notifications: [] };
      }
    }
    return callMethod(...args);
  };

  let clockMs = 0;
  const { baseUrl } = await startTestServer({
    gateway,
    transitionReadyTimeoutMs: 1_000,
    transitionPollMs: 250,
    transitionNow: () => clockMs,
    transitionSleep: async (ms) => { clockMs += ms; },
  });
  await selectOnServer(baseUrl);

  const first = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: dockBody(ORIGIN_STATION_ID) });
  // Not a 504, not a latch: the probe ends with the ship still in space and
  // hands the decision back to the client's silent-dock ladder.
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.ok, true);
  const afterFirst = (await apiRequest(baseUrl, "/api/bridge/flight/status")).payload.flight;
  assert.equal(afterFirst.inSpace, true);
  assert.equal(afterFirst.transition.phase, "ready");

  const second = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: dockBody(ORIGIN_STATION_ID) });
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  const afterSecond = (await apiRequest(baseUrl, "/api/bridge/flight/status")).payload.flight;
  assert.equal(afterSecond.docked, true);
  assert.equal(afterSecond.transition.phase, "ready");
  assert.equal(
    docksSent(gateway).length,
    2,
    "the ladder's re-issued dock is not blocked by the declined one",
  );
});

test("the page's dock dispatches CmdDock; the follow-up status shows the ship docked", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.solarSystemID = DEST_SYSTEM_ID;
  gateway.state.shipMode = "STOP";
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: dockBody(DEST_STATION_ID) });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  const dock = docksSent(gateway)[0];
  assert.ok(dock, "CmdDock dispatched");
  assert.deepEqual(dock.args, [DEST_STATION_ID, SHIP_ID]);
  const after = (await apiRequest(baseUrl, "/api/bridge/flight/status")).payload.flight;
  assert.equal(after.docked, true);
  assert.equal(after.stationID, DEST_STATION_ID);
});

// (The route's check of a structure's docking access before its CmdDock, structureDirectory.
// CheckMyDockingAccessToStructures, went with the route on 2026-10-14: the client asks structureDocking.Dock without
// it (structureDocking.py 64 to 80), and the server's handler checks the access itself.)

test("a movement refusal passes through as the handler's own CALL_REFUSED message", async () => {
  const gateway = fakeGateway({
    async callBoundMethod(service, method) {
      if (method === "CmdWarpToStuffAutopilot") {
        const error = new Error("You are warp scrambled.");
        error.code = "CALL_REFUSED";
        error.statusCode = 409;
        throw error;
      }
      return { service, method, result: null, notifications: [] };
    },
  });
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/warp", {
    method: "POST",
    body: { destinationID: GATE_ID },
  });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "CALL_REFUSED");
  assert.match(payload.message, /warp scrambled/i);
});

test("flight routes require a live session (409 NO_LIVE_SESSION with no character online)", async () => {
  const { baseUrl } = await startTestServer();
  // No select: no held bridge session.
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/status");
  assert.equal(response.status, 409);
  assert.equal(payload.error, "NO_LIVE_SESSION");
});

// ── Re-parking beyonce on arrival ────────────────────────────────────────────
//
// THE TESTS THAT WOULD HAVE CAUGHT THE 2026-09-09/10 LOSSES. EveJS clears the
// session's beyonce bind on stargate arrival and will not send the ship destiny
// state until the CLIENT re-binds — roughly twelve seconds, after which it
// force-runs the bootstrap itself. Until then the hull is inert while every
// other call still answers ok, so nothing downstream can notice. The real
// client re-parks on the arrival edge for exactly this reason (michelle.py
// `UpdateBallpark` -> `AddBallpark` -> `Park`, driven by the session change),
// and so does the BFF.

/** Park binds are keyed by system: parkBindSpec puts [[systemID, 5]] in args. */
function parkBindsFor(gateway, systemID) {
  return gateway.calls.bind.filter(
    (c) =>
      c.service === "beyonce" &&
      c.method === "MachoBindObject" &&
      Array.isArray(c.args) &&
      Array.isArray(c.args[0]) &&
      Number(c.args[0][0]) === systemID,
  );
}

test("a jump re-parks beyonce for the system it ARRIVED in, not the one it left", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  // One shared list, so the assertion is about real interleaving rather than
  // the order two separate call logs happen to be concatenated in.
  const order = [];
  const bindObject = gateway.bindObject.bind(gateway);
  const callMethod = gateway.callMethod.bind(gateway);
  gateway.bindObject = async (service, method, args, ...rest) => {
    order.push(`bind:${Number(args?.[0]?.[0])}`);
    return bindObject(service, method, args, ...rest);
  };
  gateway.callMethod = async (service, method, ...rest) => {
    order.push(`call:${method}`);
    return callMethod(service, method, ...rest);
  };
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response } = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: jumpBody });

  assert.equal(response.status, 200);
  assert.equal(
    parkBindsFor(gateway, DEST_SYSTEM_ID).length,
    1,
    "the destination park is minted eagerly — waiting for the next flight command is what left ships inert",
  );
  const jumpAt = order.indexOf("call:CmdStargateJump");
  const destBindAt = order.indexOf(`bind:${DEST_SYSTEM_ID}`);
  assert.ok(jumpAt >= 0, "the jump was dispatched");
  assert.ok(
    destBindAt > jumpAt,
    `the destination park is minted AFTER the jump, not before it: ${order.join(" -> ")}`,
  );
});

test("a re-park that is refused is retried rather than abandoned", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const bindObject = gateway.bindObject.bind(gateway);
  let refusals = 0;
  gateway.bindObject = async (service, method, args, ...rest) => {
    if (method === "MachoBindObject" && Number(args?.[0]?.[0]) === DEST_SYSTEM_ID && refusals < 2) {
      refusals += 1;
      gateway.calls.bind.push({ service, method, args });
      throw Object.assign(new Error("FakeItemNotFound"), { code: "CALL_REFUSED" });
    }
    return bindObject(service, method, args, ...rest);
  };
  const { baseUrl } = await startTestServer({ gateway, transitionSleep: async () => {} });
  await selectOnServer(baseUrl);

  const { response } = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: jumpBody });

  assert.equal(response.status, 200);
  assert.equal(refusals, 2, "both refusals were taken");
  assert.equal(
    parkBindsFor(gateway, DEST_SYSTEM_ID).length,
    3,
    "and it kept asking until one landed — one attempt silently reverts to the fatal lazy bind",
  );
});

test("a re-park that never lands still lets the jump succeed — an arrival has arrived", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const bindObject = gateway.bindObject.bind(gateway);
  gateway.bindObject = async (service, method, args, ...rest) => {
    if (method === "MachoBindObject" && Number(args?.[0]?.[0]) === DEST_SYSTEM_ID) {
      gateway.calls.bind.push({ service, method, args });
      throw Object.assign(new Error("FakeItemNotFound"), { code: "CALL_REFUSED" });
    }
    return bindObject(service, method, args, ...rest);
  };
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(" ")); };
  try {
    const { baseUrl } = await startTestServer({ gateway, transitionSleep: async () => {} });
    await selectOnServer(baseUrl);
    const { response } = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: jumpBody });
    assert.equal(response.status, 200, "the re-park is never load-bearing");
    assert.equal((await apiRequest(baseUrl, "/api/bridge/flight/status")).payload.flight.solarSystemID, DEST_SYSTEM_ID);
  } finally {
    console.warn = warn;
  }
  assert.equal(parkBindsFor(gateway, DEST_SYSTEM_ID).length, 4, "bounded — it does not retry forever");
  assert.ok(
    warnings.some((w) => /gave up re-parking/i.test(w)),
    "and it says so: a silent give-up is the fatal behaviour returning unannounced",
  );
});

test("a re-park is not retried into a session that no longer exists", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const bindObject = gateway.bindObject.bind(gateway);
  gateway.bindObject = async (service, method, args, ...rest) => {
    if (method === "MachoBindObject" && Number(args?.[0]?.[0]) === DEST_SYSTEM_ID) {
      gateway.calls.bind.push({ service, method, args });
      throw Object.assign(new Error("no live session"), { code: "SESSION_NOT_FOUND" });
    }
    return bindObject(service, method, args, ...rest);
  };
  const { baseUrl } = await startTestServer({ gateway, transitionSleep: async () => {} });
  await selectOnServer(baseUrl);

  await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: jumpBody });

  assert.equal(
    parkBindsFor(gateway, DEST_SYSTEM_ID).length,
    1,
    "there is nothing to re-park into, so it stops at the first answer",
  );
});

// ── undocking with contraband aboard ─────────────────────────────────────────

/** A retail client whose dialog table has the undock warning, with `body` for its text. */
const clientWithWarning = (body) => {
  const asked = [];
  return {
    asked,
    available: () => true,
    dialog(name) {
      asked.push(name);
      return name === "ShipContrabandWarningUndock" ? { type: "question", suppressable: true, title: "A made-up title", body } : null;
    },
  };
};
const namedRefusal = () => refusal({
  message: "ShipContrabandWarningUndock",
  refusal: { key: "ShipContrabandWarningUndock", values: { type: "dict", entries: [["item", [4, 34]]] } },
});

test("with a retail client to read, the warning is that client's own dialog, its item filled in and its markup taken out", async () => {
  // A made-up body in the dialog's shape: one parameter, {item}, here twice, and the client's markup.
  const clientWords = clientWithWarning("A made-up warning about <b>{item}</b>.<br><color=0xffff0000>Leave with {item}?</color>");
  const { baseUrl } = await startTestServer({ gateway: gatewayWithContraband(namedRefusal), clientWords });
  await selectOnServer(baseUrl);
  const warned = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: undockBody(false) });
  assert.equal(warned.response.status, 409);
  assert.equal(warned.payload.error, "CONTRABAND_WARNING");
  assert.equal(warned.payload.message, "A made-up warning about Type 34.\nLeave with Type 34?");
  assert.deepEqual(clientWords.asked, ["ShipContrabandWarningUndock"]);
});

test("a client's dialog that cannot be filled whole is not used: this client's own words stand in", async () => {
  const OWN = "Your ship is carrying contraband (Type 34). Undock anyway?";
  // Another parameter than the one the dialog is known to carry; a typed one; no body at all.
  for (const body of ["About {item}, says {empire}.", "About {[item]item.name}.", null, 7]) {
    const { baseUrl } = await startTestServer({ gateway: gatewayWithContraband(namedRefusal), clientWords: clientWithWarning(body) });
    await selectOnServer(baseUrl);
    const warned = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: undockBody(false) });
    assert.equal(warned.payload.message, OWN, String(body));
  }
  // The item is not known (the gateway's wording carries no values): the client's sentence has nothing to name.
  const unnamed = gatewayWithContraband(() => refusal({ message: "ship.Undock was refused: ShipContrabandWarningUndock" }));
  const { baseUrl } = await startTestServer({ gateway: unnamed, clientWords: clientWithWarning("About {item}.") });
  await selectOnServer(baseUrl);
  const warned = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: undockBody(false) });
  assert.equal(warned.payload.message, "Your ship is carrying contraband. Undock anyway?");
  // A body with nothing to fill is the client's all the same.
  const plain = await startTestServer({ gateway: gatewayWithContraband(namedRefusal), clientWords: clientWithWarning("A made-up warning.") });
  await selectOnServer(plain.baseUrl);
  assert.equal((await apiRequest(plain.baseUrl, "/api/bridge/call", { method: "POST", body: undockBody(false) })).payload.message, "A made-up warning.");
});
//
// The retail client's undock catches a refusal named ShipContrabandWarningUndock, asks OK / Cancel, and undocks
// again with ignoreContraband set (eve/client/script/ui/station/base.py, _DoUndockAttempt).

const undockCalls = (gateway) => gateway.calls.call.filter((call) => call.service === "ship" && call.method === "Undock");

// (The route read the flag off its body, true only where the body said true. The page names the client's flag
// itself, false and then true once the pilot has said to go on (ui/station/base.py 506 to 511), and the test of
// the route's reading of its body is gone with the route.)

/** A gateway whose first ship.Undock without ignoreContraband is refused as `refuse` builds it. */
function gatewayWithContraband(refuse) {
  const gateway = fakeGateway();
  const callMethod = gateway.callMethod.bind(gateway);
  gateway.callMethod = async (service, method, args, ...rest) => {
    if (service === "ship" && method === "Undock" && args[1] !== true) {
      gateway.calls.call.push({ service, method, args });
      throw refuse();
    }
    return callMethod(service, method, args, ...rest);
  };
  return gateway;
}
const refusal = (extra) => Object.assign(new Error(extra.message), { code: "CALL_REFUSED", statusCode: 409 }, extra);

test("an undock refused for contraband is a warning, with the item named, and the ship can still undock on a second ask", async () => {
  // As the game-port transport hands it on: the refusal by name, with the dialog's one parameter, item =
  // (UE_TYPEID, typeID). Something else first, so the item is found by name and not by place.
  const gateway = gatewayWithContraband(() => refusal({
    message: "ShipContrabandWarningUndock",
    refusal: { key: "ShipContrabandWarningUndock", values: { type: "dict", entries: [["other", [4, 35]], ["item", [4, 34]]] } },
  }));
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const warned = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: undockBody(false) });
  assert.equal(warned.response.status, 409);
  assert.equal(warned.payload.ok, false);
  assert.equal(warned.payload.error, "CONTRABAND_WARNING");
  // With no retail client to read, this client's own words, the item by the name the static data gives it
  // (the test's own: "Type <id>").
  assert.equal(warned.payload.message, "Your ship is carrying contraband (Type 34). Undock anyway?");

  // Still docked, and not left half-way through an undock: the same pilot goes out when it says so.
  const status = await apiRequest(baseUrl, "/api/bridge/flight/status");
  assert.equal(status.payload.flight.docked, true);
  const again = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: undockBody(true) });
  assert.equal(again.response.status, 200, JSON.stringify(again.payload));
  assert.equal((await apiRequest(baseUrl, "/api/bridge/flight/status")).payload.flight.inSpace, true);
  assert.deepEqual(undockCalls(gateway).map((call) => call.args[1]), [false, true]);
});

test("the warning is known by its name alone, and then names no item; any other refusal is passed on as it is", async () => {
  // As the gateway words it: no values, the name in the message.
  const worded = gatewayWithContraband(() => refusal({ message: "ship.Undock was refused: ShipContrabandWarningUndock" }));
  const first = await startTestServer({ gateway: worded });
  await selectOnServer(first.baseUrl);
  const warned = await apiRequest(first.baseUrl, "/api/bridge/call", { method: "POST", body: undockBody(false) });
  assert.equal(warned.response.status, 409);
  assert.equal(warned.payload.error, "CONTRABAND_WARNING");
  const UNNAMED = "Your ship is carrying contraband. Undock anyway?";
  assert.equal(warned.payload.message, UNNAMED);

  // An item that is not a type by its ID names nothing either.
  for (const item of [[2, 34], [4, "34"], [4], 34, null]) {
    const odd = gatewayWithContraband(() => refusal({
      message: "ShipContrabandWarningUndock",
      refusal: { key: "ShipContrabandWarningUndock", values: { type: "dict", entries: [["item", item]] } },
    }));
    const second = await startTestServer({ gateway: odd });
    await selectOnServer(second.baseUrl);
    const plain = await apiRequest(second.baseUrl, "/api/bridge/call", { method: "POST", body: undockBody(false) });
    assert.equal(plain.payload.message, UNNAMED, JSON.stringify(item));
  }

  // Another refusal is not a warning.
  const other = gatewayWithContraband(() => refusal({ message: "ShipNotInHangar", refusal: { key: "ShipNotInHangar", values: null } }));
  const third = await startTestServer({ gateway: other });
  await selectOnServer(third.baseUrl);
  const refused = await apiRequest(third.baseUrl, "/api/bridge/call", { method: "POST", body: undockBody(false) });
  assert.equal(refused.response.status, 409);
  assert.equal(refused.payload.error, "CALL_REFUSED");
  assert.match(refused.payload.message, /ShipNotInHangar/);
  // And something that only looks like it, without being a refusal, is not one either.
  const failed = gatewayWithContraband(() => Object.assign(new Error("ShipContrabandWarningUndock"), { code: "CALL_FAILED", statusCode: 502 }));
  const fourth = await startTestServer({ gateway: failed });
  await selectOnServer(fourth.baseUrl);
  assert.equal((await apiRequest(fourth.baseUrl, "/api/bridge/call", { method: "POST", body: undockBody(false) })).payload.error, "CALL_FAILED");
});

// (The warps to a fleet member, a launch, a scan result and a bookmark, and the structure gate's jump: their routes
// went on 2026-10-14 with the plumbing's other unasked writes (the loop's item 62), and their tests here with them. The page warps by its own calls: web/src/bridge/movementWrites.ts.)
