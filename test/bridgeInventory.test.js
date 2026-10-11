"use strict";

// Goal R3: the BFF Inventory & Ship routes drive the bound-object bridge. The
// browser addresses items/ships by their GAME IDs; the BFF holds the gateway's
// opaque bound-object handles server-side (never sent to the browser) and maps
// the game IDs to them: bind hangar/cargo/ship, then List/Add/StackAll/Board.
// Wire contract: docs/bridge-wire-contract.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const gatewayClient = require("../src/eveGatewayClient");
const { createApp } = require("../src/server");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const CHARACTERS = [{ characterID: 7, accountID: 4, characterName: "Test Pilot" }];
const BRIDGE_SESSION_ID = "opaque-gateway-minted-bridge-session-id";
const STATION_ID = 60003760;
const ACTIVE_SHIP_ID = 9001;
const SELECT_SESSION_ECHO = {
  userid: 4,
  characterID: 7,
  characterName: "Test Pilot",
  stationID: STATION_ID,
  structureID: null,
  solarSystemID: 30000142,
  corporationID: 98000000,
  shipID: ACTIVE_SHIP_ID,
};

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
    // The inventory route reads per-type VOLUME off the static tables to build
    // its `volumes` map (no bridge call). Tritanium's real 0.01 m³ stands in for
    // every type here; a double without this method 500s the whole route.
    getType(id) { return { typeID: id, volume: 0.01 }; },
  };
}

function packedRow(fields) {
  return { type: "packedrow", fields };
}

function keyVal(entries) {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries } };
}

// A fake gateway recording bind/bound-call traffic and answering List/Capacity
// with handler-shaped fixtures. Each bind returns a handle derived from its
// (service, method, args) so the test can assert which handle a bound call used.
function fakeGateway(overrides = {}) {
  const calls = { select: [], release: [], call: [], bind: [], boundCall: [] };
  const state = { activeShipID: ACTIVE_SHIP_ID };
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
        session: { ...SELECT_SESSION_ECHO },
      };
    },
    async releaseBridgeSession(bridgeSessionID, sessionFields) {
      calls.release.push({ bridgeSessionID, sessionFields });
      return { released: true, characterID: 7 };
    },
    async readFlightStatus(bridgeSessionID, sessionFields) {
      calls.flightStatus = calls.flightStatus || [];
      calls.flightStatus.push({ bridgeSessionID, sessionFields });
      // Docked at the same station: the station-sync keeps held.stationID here.
      return {
        flight: {
          docked: true,
          inSpace: false,
          stationID: STATION_ID,
          solarSystemID: 30000142,
          shipID: state.activeShipID,
        },
        notifications: [],
      };
    },
    async callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.call.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
      if (method === "LeaveShip" || method === "Eject" || method === "StoreVessel") {
        state.activeShipID = 9900;
      } else if (method === "CreateNewbieShip") {
        state.activeShipID = 9901;
      } else if (method === "BoardStoredShip") {
        state.activeShipID = Number(args[1]) || state.activeShipID;
      }
      return { service, method, result: method === "SafeLogoff" ? [] : null, notifications: [] };
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
      if (method === "Board") {
        state.activeShipID = Number(args[0]) || state.activeShipID;
      }
      let result = null;
      if (method === "List") {
        result = {
          type: "list",
          items: [packedRow({ itemID: 100, typeID: 34, categoryID: 4, flagID: args[0], quantity: 750, singleton: 0 })],
        };
      } else if (method === "GetCapacity") {
        result = keyVal([["capacity", 1000], ["used", 7.5]]);
      }
      return { service, method, result, notifications: [] };
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
  await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: 7 } });
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

test("GET /api/bridge/inventory binds hangar + cargo and lists both; no handle reaches the browser", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.stationID, STATION_ID);
  assert.equal(payload.activeShipID, ACTIVE_SHIP_ID);
  assert.ok(payload.hangar.list, "hangar list present");
  assert.ok(payload.cargo.list, "cargo list present");
  assert.equal(payload.hangar.error, null);

  // The bound OID / handle must never cross to the browser.
  assert.equal(JSON.stringify(payload).includes("handle:"), false);

  // Hangar bound via invbroker.GetInventory([stationID]); cargo via
  // invbroker.GetInventoryFromId([shipID]).
  assert.ok(gateway.calls.bind.some((b) => b.service === "invbroker" && b.method === "GetInventory" && b.args[0] === STATION_ID));
  assert.ok(gateway.calls.bind.some((b) => b.service === "invbroker" && b.method === "GetInventoryFromId" && b.args[0] === ACTIVE_SHIP_ID));
  // Every bound call rode the held bridge session and a hangar/cargo handle.
  for (const call of gateway.calls.boundCall) {
    assert.equal(call.bridgeSessionID, BRIDGE_SESSION_ID);
    assert.match(call.boundHandle, /^handle:invbroker:/);
  }
  // List(flag) and GetCapacity(flag) dispatched for both containers.
  const methods = gateway.calls.boundCall.map((c) => `${c.method}(${c.args[0]})`);
  assert.ok(methods.includes("List(4)") && methods.includes("GetCapacity(4)"));
  assert.ok(methods.includes("List(5)") && methods.includes("GetCapacity(5)"));
});

test("a dock at a NEW station re-targets station-scoped reads (held station synced from live flight)", async () => {
  const NEW_STATION = 60011866;
  const gateway = fakeGateway({
    // The character has since docked at a different station (e.g. an autopilot
    // arrival) than the select-time one.
    async readFlightStatus() {
      return {
        flight: { docked: true, inSpace: false, stationID: NEW_STATION, solarSystemID: 30000144, shipID: ACTIVE_SHIP_ID },
        notifications: [],
      };
    },
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl); // select-time station is STATION_ID

  const { payload } = await apiRequest(baseUrl, "/api/bridge/inventory");
  assert.equal(payload.stationID, NEW_STATION, "inventory reflects the new docked station, not the select-time one");
  assert.ok(
    gateway.calls.bind.some((b) => b.method === "GetInventory" && b.args[0] === NEW_STATION),
    "hangar bound at the NEW station",
  );
  assert.ok(
    !gateway.calls.bind.some((b) => b.method === "GetInventory" && b.args[0] === STATION_ID),
    "hangar not bound at the stale select-time station",
  );
});

test("structure personal hangar stays unknown and load/unload refuse unavailable service authority", async () => {
  const structureID = 1_030_000_000_011;
  const FLAG_HANGAR = 4, FLAG_CARGO = 5;
  const placement = new Map([[100, { flag: FLAG_HANGAR, quantity: 5, typeID: 34 }],
    [101, { flag: FLAG_CARGO, quantity: 3, typeID: 35 }]]);
  let permitMove = true;
  const gateway = fakeGateway();
  const select = gateway.selectCharacter.bind(gateway);
  gateway.selectCharacter = async (...args) => {
    const result = await select(...args);
    return { ...result, session: { ...result.session, stationID: null, structureID } };
  };
  gateway.readFlightStatus = async () => ({ flight: { docked: true, inSpace: false, stationID: null,
    structureID, solarSystemID: 30000142, shipID: ACTIVE_SHIP_ID }, notifications: [] });
  gateway.callMethod = async (_service, method) => {
    if (method === "GetMyAccessibleStructureServices") assert.fail("Private service authority must not be called");
    return { result: { type: "list", items: method === "CheckMyDockingAccessToStructures" ? [structureID] : [] }, notifications: [] };
  };
  gateway.callBoundMethod = async (service, method, args, kwargs, sessionFields, bridgeSessionID, boundHandle) => {
    gateway.calls.boundCall.push({ service, method, args, kwargs, sessionFields, bridgeSessionID, boundHandle });
    if (method === "Add") {
      const item = placement.get(args[0]);
      assert.ok(item);
      assert.equal(args[1], item.flag === FLAG_HANGAR ? structureID : ACTIVE_SHIP_ID);
      if (permitMove) item.flag = kwargs.flag;
    }
    if (method === "List") return { result: { type: "list", items: [...placement].filter(([, item]) => item.flag === args[0])
      .map(([itemID, item]) => packedRow({ itemID, typeID: item.typeID, categoryID: 4, flagID: item.flag,
        quantity: item.quantity, singleton: 0 })) }, notifications: [] };
    if (method === "GetCapacity") return { result: keyVal([["capacity", 1000], ["used", 1]]), notifications: [] };
    return { result: null, notifications: [] };
  };
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const panel = await apiRequest(baseUrl, "/api/bridge/inventory");
  assert.equal(panel.response.status, 409);
  assert.equal(panel.payload.error, "STRUCTURE_SERVICE_AUTHORITY_UNAVAILABLE");
  assert.equal(gateway.calls.bind.some((bind) => bind.method === "GetInventory" && bind.args[0] === structureID), false);
  const scriptedFit = await apiRequest(baseUrl, "/api/bridge/inventory/fit-fitting", { method: "POST",
    body: { shipID: ACTIVE_SHIP_ID, sourceLocationID: structureID, modulesByFlag: {}, confirm: true } });
  assert.equal(scriptedFit.response.status, 409, "scripted fitting remains station-only");
  assert.equal(gateway.calls.boundCall.some((call) => call.method === "FitFitting"), false);
  const offline = await apiRequest(baseUrl, "/api/bridge/inventory/move", { method: "POST", body: { itemID: 100, direction: "toCargo" } });
  assert.equal(offline.response.status, 409);
  assert.equal(offline.payload.error, "STRUCTURE_SERVICE_AUTHORITY_UNAVAILABLE");
  for (const [itemID, direction] of [[100, "toCargo"], [101, "toHangar"]]) {
    const moved = await apiRequest(baseUrl, "/api/bridge/inventory/move", { method: "POST", body: { itemID, direction } });
    assert.equal(moved.response.status, 409, JSON.stringify(moved.payload));
    assert.equal(moved.payload.error, "STRUCTURE_SERVICE_AUTHORITY_UNAVAILABLE");
  }
  assert.equal(placement.get(100).flag, FLAG_HANGAR);
  assert.equal(placement.get(101).flag, FLAG_CARGO);
  assert.equal(gateway.calls.boundCall.some(call => call.method === "Add"), false);
});

test("ambiguous docked flight cannot reuse the previously held hangar location", async () => {
  const gateway = fakeGateway({
    async readFlightStatus() {
      return { flight: { docked: true, inSpace: false, stationID: null, structureID: null,
        solarSystemID: 30000142, shipID: ACTIVE_SHIP_ID }, notifications: [] };
    },
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl); // a valid station was present at select time
  const move = await apiRequest(baseUrl, "/api/bridge/inventory/move", {
    method: "POST", body: { itemID: 100, direction: "toCargo" },
  });
  assert.equal(move.response.status, 409);
  assert.equal(move.payload.error, "NOT_DOCKED");
  assert.equal(gateway.calls.boundCall.some((call) => call.method === "Add"), false);
});

test("a bind handle is reused across reads (cached per semantic key)", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  await apiRequest(baseUrl, "/api/bridge/inventory");
  await apiRequest(baseUrl, "/api/bridge/inventory");

  // Two panel loads (4 hangar + 4 cargo reads) but only one hangar bind and
  // one cargo bind: the handles are cached per semantic key.
  const hangarBinds = gateway.calls.bind.filter((b) => b.method === "GetInventory").length;
  const cargoBinds = gateway.calls.bind.filter((b) => b.method === "GetInventoryFromId").length;
  assert.equal(hangarBinds, 1);
  assert.equal(cargoBinds, 1);
});

test("move toCargo runs Add on the cargo binding with the source station and cargo flag", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/move", {
    method: "POST",
    body: { itemID: 100, direction: "toCargo", qty: 250 },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);

  const add = gateway.calls.boundCall.find((c) => c.method === "Add");
  assert.ok(add, "Add dispatched");
  assert.equal(add.service, "invbroker");
  assert.deepEqual(add.args, [100, STATION_ID]);
  assert.deepEqual(add.kwargs, { flag: 5, qty: 250 });
  // Dispatched on the cargo binding (GetInventoryFromId handle).
  assert.match(add.boundHandle, /GetInventoryFromId/);
});

test("move toHangar runs Add on the hangar binding with the source ship and hangar flag", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  await apiRequest(baseUrl, "/api/bridge/inventory/move", {
    method: "POST",
    body: { itemID: 100, direction: "toHangar" },
  });
  const add = gateway.calls.boundCall.find((c) => c.method === "Add");
  assert.deepEqual(add.args, [100, ACTIVE_SHIP_ID]);
  assert.deepEqual(add.kwargs, { flag: 4 });
  assert.match(add.boundHandle, /GetInventory:/);
});

test("stack runs StackAll on the requested container", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  await apiRequest(baseUrl, "/api/bridge/inventory/stack", { method: "POST", body: { target: "cargo" } });
  const stack = gateway.calls.boundCall.find((c) => c.method === "StackAll");
  assert.ok(stack);
  assert.deepEqual(stack.args, [5]);
  assert.match(stack.boundHandle, /GetInventoryFromId/);
});

test("board binds ship, boards, and makes the boarded ship the new active ship for cargo", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/ship/board", {
    method: "POST",
    body: { shipID: 200 },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.activeShipID, 200);

  const board = gateway.calls.boundCall.find((c) => c.method === "Board");
  assert.equal(board.service, "ship");
  assert.deepEqual(board.args, [200, ACTIVE_SHIP_ID]);
  assert.ok(gateway.calls.bind.some((b) => b.service === "ship" && b.method === "MachoBindObject"));

  // A later cargo read binds against the newly boarded ship.
  await apiRequest(baseUrl, "/api/bridge/inventory");
  assert.ok(gateway.calls.bind.some((b) => b.method === "GetInventoryFromId" && b.args[0] === 200));
});

test("a board that fails after the server accepted it passes that failure on, and not one of its own", async () => {
  // The answer cannot be put together (its notifications are missing), which is found only after the
  // boarding itself went through. From 2026-07-28 until 2026-10-08 a misplaced branch in this route's
  // error handling threw "kind is not defined" here instead.
  const gateway = fakeGateway();
  const callBoundMethod = gateway.callBoundMethod.bind(gateway);
  gateway.callBoundMethod = async (service, method, ...rest) => {
    const outcome = await callBoundMethod(service, method, ...rest);
    return method === "Board" ? { ...outcome, notifications: undefined } : outcome;
  };
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/ship/board", { method: "POST", body: { shipID: 200 } });
  assert.equal(response.status, 500);
  assert.equal(payload.ok, false);
  assert.doesNotMatch(JSON.stringify(payload), /kind is not defined/);
  assert.equal(gateway.calls.boundCall.filter((call) => call.method === "Board").length, 1);
});

test("alternate hull-swap writes wait for the authoritative active ship before answering", async () => {
  const gateway = fakeGateway();
  let clockMs = 0;
  const { baseUrl } = await startTestServer({
    gateway,
    transitionNow: () => clockMs,
    transitionSleep: async (ms) => { clockMs += ms; },
  });
  await selectOnServer(baseUrl);

  const left = await apiRequest(baseUrl, "/api/bridge/ship/leave", {
    method: "POST",
    body: { shipID: ACTIVE_SHIP_ID, confirm: true },
  });
  assert.equal(left.response.status, 200);
  assert.equal(left.payload.activeShipID, 9900);
  assert.equal(left.payload.transition.phase, "ready");
  assert.equal(gateway.calls.call.filter((call) => call.method === "LeaveShip").length, 1);

  const stored = await apiRequest(baseUrl, "/api/bridge/ship/board-stored", {
    method: "POST",
    body: { structureID: 1_000_000_001, shipID: 2200, confirm: true },
  });
  assert.equal(stored.response.status, 200);
  assert.equal(stored.payload.activeShipID, 2200);
  assert.equal(stored.payload.transition.shipID, 2200);
  assert.equal(gateway.calls.call.filter((call) => call.method === "BoardStoredShip").length, 1);
  assert.equal(clockMs, 10_000, "the next hull swap waits out the retail session timer");
});

test("leaving the ship is a write of the page's own, made under the BFF's own watch of the swap: it answers once the pilot is in the capsule", async () => {
  const gateway = fakeGateway();
  let clockMs = 0;
  const { baseUrl } = await startTestServer({
    gateway,
    transitionNow: () => clockMs,
    transitionSleep: async (ms) => { clockMs += ms; },
  });
  await selectOnServer(baseUrl);
  const call = (more) => apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: { service: "ship", method: "LeaveShip", args: [ACTIVE_SHIP_ID], kwargs: null, ...more } });
  const left = () => gateway.calls.call.filter((each) => each.method === "LeaveShip");
  for (const more of [{}, { pilot: true }, { confirm: true }]) {
    const refused = await call(more);
    assert.deepEqual([refused.response.status, refused.payload.error], [403, "BRIDGE_WRITE_REQUIRES_DEDICATED_ROUTE"], JSON.stringify(more));
  }
  assert.equal(left().length, 0);

  const made = await call({ pilot: true, confirm: true });
  // The generic call's own answer, and none of the route's: the page reads its ship again for itself.
  assert.deepEqual([made.response.status, made.payload.ok, made.payload.service, made.payload.method, Array.isArray(made.payload.notifications)], [200, true, "ship", "LeaveShip", true]);
  assert.deepEqual([made.payload.applied, made.payload.activeShipID, made.payload.flight, made.payload.transition], [undefined, undefined, undefined, undefined]);
  // station.TryLeaveShip (236 to 251): GetShipAccess().LeaveShip(shipid), once.
  assert.deepEqual(left().map((each) => [each.service, each.args, each.kwargs]), [["ship", [ACTIVE_SHIP_ID], null]]);
  // The BFF's own word for the pilot's ship is the capsule from then on, as after the route's.
  const inventory = await apiRequest(baseUrl, "/api/bridge/inventory");
  assert.equal(inventory.payload.activeShipID, 9900);
  // And the next swap waits out the session's timer, as it does after the route's.
  const stored = await apiRequest(baseUrl, "/api/bridge/ship/board-stored", { method: "POST", body: { structureID: 1_000_000_001, shipID: 2200, confirm: true } });
  assert.deepEqual([stored.response.status, stored.payload.activeShipID, clockMs], [200, 2200, 10_000]);
});

test("the ship's other swaps are their routes' alone, whatever the generic call is told", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const before = gateway.calls.call.length;
  for (const [service, method, args] of [["ship", "Eject", []], ["ship", "BoardStoredShip", [1_000_000_001, 2200]], ["ship", "StoreVessel", [1, 2]], ["dogmaIM", "CreateNewbieShip", []]]) {
    const refused = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: { service, method, args, kwargs: null, pilot: true, confirm: true } });
    assert.deepEqual([refused.response.status, refused.payload.error], [403, "BRIDGE_WRITE_REQUIRES_DEDICATED_ROUTE"], `${service}.${method}`);
  }
  assert.equal(gateway.calls.call.length, before);
});

test("a ship left with no pilot held is refused as its route refused it", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  const refused = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: { service: "ship", method: "LeaveShip", args: [ACTIVE_SHIP_ID], kwargs: null, pilot: true, confirm: true } });
  assert.deepEqual([refused.response.status, refused.payload.error], [409, "NO_LIVE_SESSION"]);
  assert.equal(gateway.calls.call.filter((each) => each.method === "LeaveShip").length, 0);
});

test("a successful safe logoff drops the BFF's held session immediately", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const loggedOut = await apiRequest(baseUrl, "/api/bridge/ship/safe-logoff", {
    method: "POST",
    body: { confirm: true },
  });
  assert.equal(loggedOut.response.status, 200);
  assert.equal(loggedOut.payload.applied, true);
  assert.equal(loggedOut.payload.loggedOff, true);
  assert.equal(gateway.calls.call.filter((call) => call.method === "SafeLogoff").length, 1);

  const status = await apiRequest(baseUrl, "/api/bridge/flight/status");
  assert.equal(status.response.status, 409);
  assert.equal(status.payload.error, "NO_LIVE_SESSION");
});

test("inventory routes require a live session and pass gateway refusals through", async () => {
  const { baseUrl } = await startTestServer({ gateway: fakeGateway() });

  // No character online yet.
  const noSession = await apiRequest(baseUrl, "/api/bridge/inventory");
  assert.equal(noSession.response.status, 409);
  assert.equal(noSession.payload.error, "NO_LIVE_SESSION");

  // A refused bound method passes through with its gateway status.
  const refusingGateway = fakeGateway({
    async callBoundMethod() {
      throw new gatewayClient.EveGatewayError("not allowed", { code: "CALL_NOT_ALLOWED", statusCode: 403 });
    },
  });
  const refused = await startTestServer({ gateway: refusingGateway });
  await selectOnServer(refused.baseUrl);
  const move = await apiRequest(refused.baseUrl, "/api/bridge/inventory/move", {
    method: "POST",
    body: { itemID: 100, direction: "toCargo" },
  });
  assert.equal(move.response.status, 403);
  assert.equal(move.payload.error, "CALL_NOT_ALLOWED");
});

test("a lost persistent session during an inventory read drops the held handle", async () => {
  const gateway = fakeGateway({
    async callBoundMethod() {
      throw new gatewayClient.EveGatewayError("gone", { code: "SESSION_NOT_FOUND", statusCode: 404 });
    },
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const move = await apiRequest(baseUrl, "/api/bridge/inventory/move", {
    method: "POST",
    body: { itemID: 100, direction: "toCargo" },
  });
  assert.equal(move.response.status, 404);
  assert.equal(move.payload.error, "SESSION_NOT_FOUND");

  // The stale handle was dropped: releasing now reports nothing held.
  const { payload } = await apiRequest(baseUrl, "/api/bridge/release", { method: "POST", body: {} });
  assert.deepEqual(payload, { ok: true, released: false });
});
