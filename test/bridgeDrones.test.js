"use strict";

// Goal R25 slice A: the BFF's drone routes.
//
//   GET  /api/bridge/drones          bay (ListByFlags 87) + ShipGetInfo + snapshot
//   POST /api/bridge/drones/launch   ship.LaunchDrones
//   POST /api/bridge/drones/engage   entity.CmdEngage
//   POST /api/bridge/drones/mine     entity.CmdMineRepeatedly
//   POST /api/bridge/drones/recall   entity.CmdReturnBay
//
// ⚠ THE SERVICE SPLIT IS THE FIRST THING PINNED HERE. Launch is `ship`; every
// in-space order is `entity`. One feature, two services — and a reader who
// assumes drones live on one service wires half of it to the wrong place.
//
// ⚠ AND THE SECOND: NOT ONE of these four calls can be trusted on its return
// value. The server's LaunchDrones handler answers 200 with an EMPTY DICT when
// it refuses (bandwidth, the active-drone cap, a stack that moved), and the
// three entity orders answer an empty dict on SUCCESS. So every route re-reads
// the SPACE SNAPSHOT and reports what is actually out there — and when the
// re-read shows nothing changed, that is reported as such rather than dressed
// up as a launch.
//
// The limits (maxActiveDrones 352, droneBandwidth 1271) add NO allowlist pair:
// they are ordinary ship attributes and dogmaIM.ShipGetInfo already answers the
// whole attribute map. This file asserts that no new dogma call appears.
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
const CHARACTER_ID = 7;
const SHIP_ID = 9001;
const BAY_DRONE_ID = 7800001;
const SECOND_BAY_DRONE_ID = 7800002;
const RAT_ID = 50002001;
const ROCK_ID = 50001248;
// The bay's flagID. It appears in THIS FILE only to assert the BFF sends it —
// it must never reach the browser (R7d).
const DRONE_BAY_FLAG = 87;

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
  return { getStation() { return null; }, getTypeName(id) { return `Type ${id}`; },
    getTypeDogmaAttribute() { return null; } };
}

function packedRow(fields) {
  return { type: "packedrow", fields };
}

/**
 * A gateway with a real enough drone world to tell "launched" from
 * "answered 200 and did nothing".
 *
 * `bay` is what ListByFlags([87]) answers; `space` is what the snapshot
 * reports. `inertLaunch` reproduces the server's actual refusal shape: the call
 * succeeds, answers an empty dict, and NOTHING appears in space.
 */
function fakeGateway(overrides = {}) {
  const calls = { select: [], call: [], bind: [], boundCall: [], flightStatus: [], snapshot: [] };
  const state = {
    inSpace: true,
    bay: new Map([
      [BAY_DRONE_ID, { itemID: BAY_DRONE_ID, typeID: 2456, quantity: 1 }],
      [SECOND_BAY_DRONE_ID, { itemID: SECOND_BAY_DRONE_ID, typeID: 2456, quantity: 1 }],
    ]),
    // itemID -> the projected drone row the snapshot answers for it.
    space: new Map(),
    // Launch is accepted and does nothing — the server's real refusal shape.
    inertLaunch: false,
    // The snapshot read fails entirely, so "we could not look" can be tested.
    snapshotFails: false,
    // ShipGetInfo answers no attributes at all (a hull with no drone dogma).
    hideShipAttributes: false,
    // Extra non-drone entities the snapshot should carry.
    extraEntities: [],
    refuse: new Map(),
  };
  function droneRow(itemID) {
    return {
      kind: "drone",
      itemID,
      typeID: 2456,
      name: "Hobgoblin I",
      ownerID: CHARACTER_ID,
      controllerID: SHIP_ID,
      droneActivity: "idle",
      targetEntityID: null,
      shieldRatio: 1,
      armorRatio: 1,
      hullRatio: 1,
      isSelf: false,
    };
  }
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
    droneRow,
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
          characterID: CHARACTER_ID,
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
      return { released: true, characterID: CHARACTER_ID };
    },
    async readFlightStatus(bridgeSessionID, sessionFields) {
      calls.flightStatus.push({ bridgeSessionID, sessionFields });
      return { flight: flightSnapshot(), notifications: [] };
    },
    async readSpaceSnapshot(bridgeSessionID, sessionFields) {
      calls.snapshot.push({ bridgeSessionID, sessionFields });
      if (state.snapshotFails) {
        const error = new Error("the scene could not be read");
        error.code = "CALL_FAILED";
        throw error;
      }
      return {
        space: {
          inSpace: state.inSpace,
          shipID: SHIP_ID,
          entities: [...state.space.values(), ...state.extraEntities],
          ship: { itemID: SHIP_ID, typeID: 24700, name: "Test Pilot's ship" },
        },
        notifications: [],
      };
    },
    async callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.call.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
      const key = `${service}.${method}`;
      if (state.refuse.has(key)) {
        const error = new Error(state.refuse.get(key));
        error.code = "CALL_REFUSED";
        error.statusCode = 409;
        throw error;
      }
      switch (key) {
        case "ship.LaunchDrones": {
          // The server's own shape: a dict keyed by the bay itemID. It is
          // returned identically whether the launch worked or not.
          if (!state.inertLaunch) {
            for (const [itemID] of args[0] || []) {
              const numeric = Number(itemID);
              if (state.bay.has(numeric)) {
                state.bay.delete(numeric);
                state.space.set(numeric, droneRow(numeric));
              }
            }
          }
          return { service, method, result: { type: "dict", entries: [] }, notifications: [] };
        }
        case "entity.CmdEngage":
        case "entity.CmdMineRepeatedly": {
          const targetID = Number(args[1]) || 0;
          for (const droneID of args[0] || []) {
            const row = state.space.get(Number(droneID));
            if (row) {
              state.space.set(Number(droneID), {
                ...row,
                droneActivity: key === "entity.CmdEngage" ? "fighting" : "mining",
                targetEntityID: targetID,
              });
            }
          }
          // Empty dict on SUCCESS — the server really does answer this.
          return { service, method, result: { type: "dict", entries: [] }, notifications: [] };
        }
        case "entity.CmdReturnBay": {
          for (const droneID of args[0] || []) {
            const row = state.space.get(Number(droneID));
            if (row) {
              state.space.set(Number(droneID), { ...row, droneActivity: "returning" });
            }
          }
          return { service, method, result: { type: "dict", entries: [] }, notifications: [] };
        }
        case "dogmaIM.ShipGetInfo":
          return {
            service,
            method,
            result: state.hideShipAttributes
              ? { type: "object", args: [] }
              : {
                  type: "object",
                  args: [
                    [
                      ["attributes", { type: "dict", entries: [[352, 5], [1271, 50]] }],
                    ],
                  ],
                },
            notifications: [],
          };
        default:
          return { service, method, result: null, notifications: [] };
      }
    },
    async bindObject(service, method, args) {
      calls.bind.push({ service, method, args });
      return {
        boundHandle: `handle:${service}:${method}:${JSON.stringify(args)}`,
        service,
        method,
        notifications: [],
      };
    },
    async callBoundMethod(boundHandle, method, args, kwargs) {
      calls.boundCall.push({ boundHandle, method, args, kwargs });
      if (method === "ListByFlags") {
        return {
          method,
          result: {
            type: "list",
            items: [...state.bay.values()].map((row) =>
              packedRow({
                itemID: row.itemID,
                typeID: row.typeID,
                quantity: row.quantity,
                flagID: DRONE_BAY_FLAG,
                locationID: SHIP_ID,
              }),
            ),
          },
          notifications: [],
        };
      }
      return { method, result: null, notifications: [] };
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
    bridgeSessionStore: options.sessions,
    ...(options.botHost ? { botHost: options.botHost } : {}),
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
  await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: CHARACTER_ID },
  });
  return { gateway, baseUrl };
}

function callsOf(gateway, service, method) {
  return gateway.calls.call.filter((c) => c.service === service && c.method === method);
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

test("a pending recovery can reopen the same held pilot after a tab reload without selecting twice", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  const first = await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST", body: { characterID: CHARACTER_ID },
  });
  const again = await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST", body: { characterID: CHARACTER_ID },
  });
  assert.equal(first.response.status, 200);
  assert.equal(again.response.status, 200);
  assert.equal(again.payload.droneRecoveryCheckID, first.payload.droneRecoveryCheckID);
  assert.equal(again.payload.character.characterID, CHARACTER_ID);
  assert.equal(gateway.calls.select.length, 1, "the live owner is not disconnected or reselected");
  assert.equal(gateway.calls.flightStatus.length, 1, "the held gateway session is checked afresh");
  const ready = await apiRequest(baseUrl, "/api/bridge/drone-recovery/ready", {
    method: "POST", body: { checkID: again.payload.droneRecoveryCheckID },
  });
  assert.equal(ready.response.status, 200);
  assert.equal(ready.payload.ok, true);
});
test("operation-owned drone recovery acknowledges an empty flight without an unrelated location sample", async () => {
  const { baseUrl } = await startTestServer({ botHost: {
    operationForClaim: () => ({ operationID: "owned-operation", operationRole: "MINER" }),
    claimedBy: () => null, authorizesClaim: () => true, listAll: () => [],
    activeCharacterIDs: () => [], sampleAllVitals: async () => {}, stopAll: async () => {},
  } });
  const selected = await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: CHARACTER_ID } });
  assert.equal(selected.response.status, 200);
  const ready = await apiRequest(baseUrl, "/api/bridge/drone-recovery/ready", {
    method: "POST", body: { checkID: selected.payload.droneRecoveryCheckID }, headers: { "x-evejs-bot-claim": "owned-claim" },
  });
  assert.equal(ready.response.status, 200); assert.equal(ready.payload.ok, true);
});

test("pending recovery still refuses another pilot and unreadable same-pilot reentry", async () => {
  const gateway = fakeGateway();
  const store = fakeStore();
  store.getCharacterForAccount = async (accountID, characterID) =>
    Number(accountID) === ACCOUNT.accountID && [CHARACTER_ID, 8].includes(Number(characterID))
      ? { characterID, accountID, characterName: `Pilot ${characterID}` } : null;
  const { baseUrl } = await startTestServer({ gateway, store });
  await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST", body: { characterID: CHARACTER_ID },
  });
  const other = await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST", body: { characterID: 8 },
  });
  assert.equal(other.response.status, 409);
  assert.equal(other.payload.error, "DRONE_RECOVERY_PENDING");
  gateway.readFlightStatus = async () => ({ flight: null, notifications: [] });
  const unreadable = await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST", body: { characterID: CHARACTER_ID },
  });
  assert.equal(unreadable.response.status, 409);
  assert.equal(unreadable.payload.error, "DRONE_RECOVERY_UNCONFIRMED");
  for (const shipID of [null, SHIP_ID + 1]) {
    gateway.readFlightStatus = async () => ({ flight: {
      inSpace: true, docked: false, shipID, solarSystemID: ORIGIN_SYSTEM_ID,
    }, notifications: [] });
    const changed = await apiRequest(baseUrl, "/api/bridge/select", {
      method: "POST", body: { characterID: CHARACTER_ID },
    });
    assert.equal(changed.response.status, 409);
    assert.equal(changed.payload.error, "DRONE_RECOVERY_UNCONFIRMED");
  }
  assert.equal(gateway.calls.select.length, 1);
});

// --- The panel read ---------------------------------------------------------

test("the drones read is the bay, the snapshot and ShipGetInfo — and no new call", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.space.set(9500001, gateway.droneRow(9500001));

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/drones");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);

  // The bay, by ITEM and TYPE only.
  assert.equal(payload.bay.length, 2);
  assert.deepEqual(Object.keys(payload.bay[0]).sort(), ["itemID", "quantity", "typeID"]);
  // R7d: the bay's flagID and the ship's locationID are on the decoded row and
  // NEITHER may leave the BFF.
  assert.equal(payload.bay[0].flagID, undefined, "the bay's flagID must not reach the browser");
  assert.equal(payload.bay[0].locationID, undefined);

  // What is in space, filtered to mine.
  assert.equal(payload.inSpace.length, 1);
  assert.equal(payload.inSpace[0].itemID, 9500001);
  assert.equal(payload.inSpace[0].activity, "idle", "a word, never the runtime enum");

  // The bay read is ListByFlags with the drone-bay flag, on the ship binding.
  const listed = gateway.calls.boundCall.filter((c) => c.method === "ListByFlags");
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].args, [[DRONE_BAY_FLAG]]);

  // ⚠ THE LIMITS ADD NO PAIR. ShipGetInfo was already allowlisted for the
  // fitting panel; nothing new is called for maxActiveDrones / droneBandwidth.
  assert.equal(callsOf(gateway, "dogmaIM", "ShipGetInfo").length, 1);
  const dogmaMethods = new Set(
    gateway.calls.call.filter((c) => c.service === "dogmaIM").map((c) => c.method),
  );
  assert.deepEqual([...dogmaMethods], ["ShipGetInfo"], "no new dogma call for the limits");
});

test("a failed snapshot answers inSpace: null — never an empty flight", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.snapshotFails = true;

  const { payload } = await apiRequest(baseUrl, "/api/bridge/drones");
  assert.equal(payload.ok, true);
  // ⚠ THE DISTINCTION THIS WHOLE FEATURE TURNS ON. `[]` would tell the player
  // they have nothing out and invite them to launch a SECOND flight on top of
  // the one already flying. null says "we could not look".
  assert.equal(payload.inSpace, null);
  assert.ok(payload.errors.inSpace, "and the read error is named");
  // The bay still answered, because the three reads are independent.
  assert.equal(payload.bay.length, 2);
});

test("a drone belonging to someone else is not reported as mine", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.space.set(9500001, gateway.droneRow(9500001));
  // Same kind, different owner AND different controller: another player's drone
  // parked in the same grid. It must not appear with a Recall button on it.
  gateway.state.extraEntities = [
    {
      kind: "drone",
      itemID: 9500999,
      typeID: 2456,
      name: "Hobgoblin I",
      ownerID: 424242,
      controllerID: 888888,
      droneActivity: "fighting",
      isSelf: false,
    },
  ];

  const { payload } = await apiRequest(baseUrl, "/api/bridge/drones");
  assert.deepEqual(payload.inSpace.map((d) => d.itemID), [9500001]);
});

// --- Launch -----------------------------------------------------------------

test("launch is ship.LaunchDrones, and the SNAPSHOT decides whether it worked", async () => {
  const { gateway, baseUrl } = await inSpace();

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/drones/launch", {
    method: "POST",
    body: { drones: [{ itemID: BAY_DRONE_ID }] },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);

  // ⚠ THE SERVICE SPLIT: launching is `ship`, not `entity`.
  const launches = callsOf(gateway, "ship", "LaunchDrones");
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0].args[0], [[BAY_DRONE_ID, 1]], "[[itemID, qty], …]");
  assert.equal(launches[0].args[1], CHARACTER_ID, "whoseBehalfID");
  assert.equal(launches[0].args[2], false, "ignoreWarning");
  assert.equal(callsOf(gateway, "entity", "LaunchDrones").length, 0);

  // The claim is made from the re-read, not from the 200.
  assert.deepEqual(payload.launched.map((d) => d.itemID), [BAY_DRONE_ID]);
  assert.deepEqual(payload.inSpace.map((d) => d.itemID), [BAY_DRONE_ID]);
  // Two snapshot reads: one before (to know what was already out) and one after.
  assert.ok(gateway.calls.snapshot.length >= 2, "the launch re-reads space");
});

test("⚠ a launch the server SILENTLY REFUSED reports nothing launched", async () => {
  const { gateway, baseUrl } = await inSpace();
  // The real refusal shape: 200, an empty dict, and nothing in space. This is
  // what bandwidth and the active-drone cap actually look like on the wire.
  gateway.state.inertLaunch = true;

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/drones/launch", {
    method: "POST",
    body: { drones: [{ itemID: BAY_DRONE_ID }] },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(payload.launched, [], "nothing appeared in space, so nothing launched");
  assert.deepEqual(payload.inSpace, []);
});

test("a launch whose re-read failed says UNKNOWN, not success", async () => {
  const { gateway, baseUrl } = await inSpace();
  // The snapshot is down. The launch is still ATTEMPTED — refusing to try
  // because we cannot verify would be worse for a miner about to be shot — but
  // nothing is claimed about the outcome.
  gateway.state.snapshotFails = true;

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/drones/launch", {
    method: "POST",
    body: { drones: [{ itemID: BAY_DRONE_ID }] },
  });
  assert.equal(response.status, 200);
  assert.equal(callsOf(gateway, "ship", "LaunchDrones").length, 1, "the launch was still issued");
  assert.equal(payload.inSpace, null, "null = we could not check");
  assert.equal(payload.launched, null, "and no launch is claimed either way");
});

test("launch refuses an empty request and never reaches the server", async () => {
  const { gateway, baseUrl } = await inSpace();
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/drones/launch", {
    method: "POST",
    body: { drones: [] },
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "NOTHING_SELECTED");
  assert.equal(callsOf(gateway, "ship", "LaunchDrones").length, 0);
});

// --- The three in-space orders ----------------------------------------------

test("engage is entity.CmdEngage([droneIDs], targetID) and re-reads", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.space.set(9500001, gateway.droneRow(9500001));

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/drones/engage", {
    method: "POST",
    body: { droneIDs: [9500001], targetID: RAT_ID },
  });
  assert.equal(response.status, 200);

  // ⚠ THE SERVICE SPLIT again, in the other direction: orders are `entity`.
  const orders = callsOf(gateway, "entity", "CmdEngage");
  assert.equal(orders.length, 1);
  assert.deepEqual(orders[0].args, [[9500001], RAT_ID]);
  assert.equal(callsOf(gateway, "ship", "CmdEngage").length, 0);

  // The order returns an empty dict on SUCCESS, so the re-read is the answer.
  assert.equal(payload.inSpace[0].activity, "fighting");
  assert.equal(payload.inSpace[0].targetID, RAT_ID);
});

test("mine is entity.CmdMineRepeatedly and carries the rock", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.space.set(9500001, gateway.droneRow(9500001));

  const { payload } = await apiRequest(baseUrl, "/api/bridge/drones/mine", {
    method: "POST",
    body: { droneIDs: [9500001], targetID: ROCK_ID },
  });
  const orders = callsOf(gateway, "entity", "CmdMineRepeatedly");
  assert.equal(orders.length, 1);
  assert.deepEqual(orders[0].args, [[9500001], ROCK_ID]);
  assert.equal(payload.inSpace[0].activity, "mining");
});

test("recall is entity.CmdReturnBay and takes NO target", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.space.set(9500001, gateway.droneRow(9500001));

  const { payload } = await apiRequest(baseUrl, "/api/bridge/drones/recall", {
    method: "POST",
    body: { droneIDs: [9500001] },
  });
  const orders = callsOf(gateway, "entity", "CmdReturnBay");
  assert.equal(orders.length, 1);
  assert.deepEqual(orders[0].args, [[9500001]], "one argument: the drone list");
  assert.equal(payload.targetID, null);
  // A recalled drone stays in space, flying home, until the runtime scoops it
  // inside 2500 m. Reporting the bay as already full would be a lie.
  assert.equal(payload.inSpace[0].activity, "returning");
});

test("engage and mine require a target; recall does not", async () => {
  const { gateway, baseUrl } = await inSpace();
  for (const route of ["engage", "mine"]) {
    const { response, payload } = await apiRequest(baseUrl, `/api/bridge/drones/${route}`, {
      method: "POST",
      body: { droneIDs: [9500001] },
    });
    assert.equal(response.status, 400, route);
    assert.equal(payload.error, "INVALID_TARGET", route);
  }
  const { response } = await apiRequest(baseUrl, "/api/bridge/drones/recall", {
    method: "POST",
    body: { droneIDs: [9500001] },
  });
  assert.equal(response.status, 200, "recall needs no target");
  assert.equal(callsOf(gateway, "entity", "CmdEngage").length, 0);
});

test("every order refuses an empty drone list before touching the server", async () => {
  const { gateway, baseUrl } = await inSpace();
  for (const route of ["engage", "mine", "recall"]) {
    const { response, payload } = await apiRequest(baseUrl, `/api/bridge/drones/${route}`, {
      method: "POST",
      body: { droneIDs: [], targetID: RAT_ID },
    });
    assert.equal(response.status, 400, route);
    assert.equal(payload.error, "NO_DRONES", route);
  }
  assert.equal(gateway.calls.call.filter((c) => c.service === "entity").length, 0);
});

// --- Docked -----------------------------------------------------------------

test("nothing drone-related is issued while docked", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.inSpace = false;

  for (const [route, body] of [
    ["launch", { drones: [{ itemID: BAY_DRONE_ID }] }],
    ["engage", { droneIDs: [9500001], targetID: RAT_ID }],
    ["mine", { droneIDs: [9500001], targetID: ROCK_ID }],
    ["recall", { droneIDs: [9500001] }],
  ]) {
    const { response } = await apiRequest(baseUrl, `/api/bridge/drones/${route}`, {
      method: "POST",
      body,
    });
    assert.equal(response.status, 409, route);
  }
  assert.equal(callsOf(gateway, "ship", "LaunchDrones").length, 0);
  assert.equal(gateway.calls.call.filter((c) => c.service === "entity").length, 0);
});

// --- R34: the per-drone reason the route used to throw away ------------------
//
// ⚠ THIS IS A DATA LOSS, NOT A MISSING FEATURE. `droneRuntime.js` refuses a
// drone order one drone at a time and writes a plain-language sentence for each
// into the call RESULT dict, keyed by droneID — thirteen distinct sentences,
// every one of them already player-ready. `droneOrderRoute` forwarded
// `outcome.notifications` alone and dropped `outcome.result` on the floor, so
// all thirteen died in this file. These tests pin the forwarding.
//
// ⚠ AND THEY PIN THAT IT IS FORWARDED RAW. The BFF does not decode, translate,
// rank or reword it (R31: the browser is the only place a refusal becomes
// words). A BFF that started interpreting this would put the wording out of
// reach of the tests that hold it to R9a.

/** A gateway whose drone orders refuse, exactly as `appendDroneError` writes it. */
function refusingGateway(refusals) {
  return fakeGateway({
    async callMethod(service, method, args, kwargs, context, sessionID) {
      const base = fakeGateway();
      const outcome = await base.callMethod(service, method, args, kwargs, context, sessionID);
      if (service !== "entity") {
        return outcome;
      }
      return {
        ...outcome,
        result: {
          type: "dict",
          entries: refusals.map(([droneID, message]) => [
            droneID,
            ["CustomNotify", { type: "dict", entries: [["notify", message]] }],
          ]),
        },
      };
    },
  });
}

test("R34: a refused order forwards the server's own per-drone reason", async () => {
  const gateway = refusingGateway([
    [9988400023314, "That drone is not currently under this ship's control."],
  ]);
  const { baseUrl } = await startTestServer({ gateway });
  await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: CHARACTER_ID },
  });

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/drones/recall", {
    method: "POST",
    body: { droneIDs: [9988400023314] },
  });
  assert.equal(response.status, 200);
  // ⚠ A 200 IS NOT PROOF, and this is the case that shows why: the route
  // answers 200 and the drone did not move. The reason is in `result`.
  assert.deepEqual(payload.result.entries, [
    [
      9988400023314,
      ["CustomNotify", { type: "dict", entries: [["notify", "That drone is not currently under this ship's control."]] }],
    ],
  ]);
});

test("R34: EVERY refused drone is forwarded — the route collapses nothing", async () => {
  // R30's finding: a fan-out reported through one slot loses all but the last
  // answer. The route must hand over the whole dict, untouched.
  const gateway = refusingGateway([
    [9500001, "That target cannot be engaged by drones."],
    [9500002, "That drone has no supported engage profile."],
  ]);
  const { baseUrl } = await startTestServer({ gateway });
  await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: CHARACTER_ID },
  });

  const { payload } = await apiRequest(baseUrl, "/api/bridge/drones/engage", {
    method: "POST",
    body: { droneIDs: [9500001, 9500002], targetID: RAT_ID },
  });
  assert.equal(payload.result.entries.length, 2);
  assert.deepEqual(
    payload.result.entries.map((entry) => entry[0]),
    [9500001, 9500002],
  );
});

test("R34: all three orders forward it, and a SUCCESS forwards an empty dict", async () => {
  for (const [route, body] of [
    ["engage", { droneIDs: [9500001], targetID: RAT_ID }],
    ["mine", { droneIDs: [9500001], targetID: ROCK_ID }],
    ["recall", { droneIDs: [9500001] }],
  ]) {
    const { gateway, baseUrl } = await inSpace();
    gateway.state.space.set(9500001, gateway.droneRow(9500001));
    const { payload } = await apiRequest(baseUrl, `/api/bridge/drones/${route}`, {
      method: "POST",
      body,
    });
    // The empty dict the runtime really answers on success. It must arrive as
    // an empty dict rather than as an absent field, so the browser can tell
    // "nothing was refused" from "the route does not send this".
    assert.deepEqual(payload.result, { type: "dict", entries: [] }, `${route} must forward result`);
  }
});

test("R34: the BFF forwards the reason RAW — it does not translate it", async () => {
  // The sentence arrives exactly as the server wrote it, with no BFF-side
  // rewording, prefixing or code mapping. R31's seam is in the browser.
  const sentence = "That target cannot be mined or salvaged by drones.";
  const gateway = refusingGateway([[9500001, sentence]]);
  const { baseUrl } = await startTestServer({ gateway });
  await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: CHARACTER_ID },
  });
  const { payload } = await apiRequest(baseUrl, "/api/bridge/drones/mine", {
    method: "POST",
    body: { droneIDs: [9500001], targetID: ROCK_ID },
  });
  const carried = JSON.stringify(payload.result);
  assert.ok(carried.includes(sentence), "the server's sentence must survive the BFF unchanged");
});

// --- The verbs that are NOT here --------------------------------------------

test("⚠ there is NO assist, guard, unanchor or abandon route", async () => {
  const { baseUrl } = await inSpace();
  // CmdAssist / CmdGuard / CmdUnanchor have NO server handler at all (they are
  // client-only verbs), and CmdAbandonDrone permanently DISOWNS a player's
  // drones. None of the four is allowlisted on the gateway, and none has a BFF
  // route either — so a stray POST cannot reach any of them.
  for (const route of ["assist", "guard", "unanchor", "abandon", "scoop"]) {
    // Raw fetch: an unknown path falls through to the SPA's HTML, which is not
    // JSON, and the point here is only that no drone route answers it.
    const response = await ORIGINAL_FETCH(`${baseUrl}/api/bridge/drones/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `evejs_web_poc=${COOKIE_TOKEN}` },
      body: JSON.stringify({ droneIDs: [9500001] }),
    });
    assert.notEqual(response.status, 200, `/api/bridge/drones/${route} must not exist`);
  }
});

test("script observation reads one fresh scene for space and owned drone projection", async () => {
  const { gateway, baseUrl } = await inSpace();
  await apiRequest(baseUrl, "/api/bridge/space/snapshot");
  await apiRequest(baseUrl, "/api/bridge/drones");
  assert.equal(gateway.calls.snapshot.length, 2, "the previous paired routes acquire twice");
  gateway.calls.snapshot.length = 0;
  gateway.state.space.set(81, { ...gateway.droneRow(81), droneActivity: "mining", targetEntityID: ROCK_ID });
  gateway.state.extraEntities = [
    { itemID: ROCK_ID, kind: "asteroid", radius: 100, position: { x: 6000, y: 0, z: 0 } },
    { itemID: 99, kind: "container", radius: 10, position: { x: 1500, y: 0, z: 0 } },
    { ...gateway.droneRow(82), controllerID: null },
    { ...gateway.droneRow(83), ownerID: 123, controllerID: 123 },
  ];
  const read = gateway.readSpaceSnapshot.bind(gateway);
  gateway.readSpaceSnapshot = async (...args) => {
    const outcome = await read(...args);
    return { space: { ...outcome.space, sampledAtMs: gateway.calls.snapshot.length },
      notifications: [{ event: "sample", args: [gateway.calls.snapshot.length] }] };
  };
  const first = await apiRequest(baseUrl, "/api/bridge/script/observation");
  assert.equal(first.response.status, 200);
  assert.equal(gateway.calls.snapshot.length, 1);
  assert.equal(first.payload.space.sampledAtMs, 1);
  assert.deepEqual(first.payload.inSpace.map((d) => [d.itemID, d.controlled]), [[81, true], [82, false]]);
  assert.equal(first.payload.inSpace[0].targetID, ROCK_ID);
  assert.ok(first.payload.space.entities.some((e) => e.itemID === ROCK_ID));
  assert.ok(first.payload.space.entities.some((e) => e.itemID === 99));
  assert.deepEqual(first.payload.notifications, [{ event: "sample", args: [1] }]);
  assert.equal(first.payload.bay.length, 2);
  assert.ok(first.payload.shipInfo);
  const second = await apiRequest(baseUrl, "/api/bridge/script/observation");
  assert.equal(second.payload.space.sampledAtMs, 2, "no cross-tick cache");
  assert.equal(gateway.calls.snapshot.length, 2);
});

test("script observation keeps unreadable drone state unknown and rejects failed scene authority", async () => {
  const { gateway, baseUrl } = await inSpace();
  const read = gateway.readSpaceSnapshot.bind(gateway);
  gateway.readSpaceSnapshot = async (...args) => {
    const outcome = await read(...args);
    return { ...outcome, space: { ...outcome.space, entities: null } };
  };
  const unreadable = await apiRequest(baseUrl, "/api/bridge/script/observation");
  assert.equal(unreadable.response.status, 200);
  assert.equal(unreadable.payload.inSpace, null);
  gateway.readSpaceSnapshot = read;
  gateway.state.snapshotFails = true;
  const failed = await apiRequest(baseUrl, "/api/bridge/script/observation");
  assert.notEqual(failed.response.status, 200);
  assert.equal(failed.payload.ok, false);
  gateway.state.snapshotFails = false;
  gateway.readSpaceSnapshot = async () => ({ space: null, notifications: [] });
  const missing = await apiRequest(baseUrl, "/api/bridge/script/observation");
  assert.notEqual(missing.response.status, 200, "a missing full scene must not decode as empty space");
});

test("a pilot or scene transition cannot reuse an in-flight script observation", async () => {
  const sessions = new Map();
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway, sessions });
  await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: CHARACTER_ID } });
  const read = gateway.readSpaceSnapshot.bind(gateway);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  gateway.readSpaceSnapshot = async (...args) => {
    started();
    await pending;
    return read(...args);
  };
  const request = apiRequest(baseUrl, "/api/bridge/script/observation");
  await entered;
  sessions.get(SESSION_ID).transitionEpoch += 1;
  release();
  const result = await request;
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.error, "OBSERVATION_SCOPE_CHANGED");
  assert.equal(gateway.calls.snapshot.length, 1);
});

test("drone mutation and later confirmation never reuse the script observation", async () => {
  const { gateway, baseUrl } = await inSpace();
  await apiRequest(baseUrl, "/api/bridge/script/observation");
  assert.equal(gateway.calls.snapshot.length, 1);
  await apiRequest(baseUrl, "/api/bridge/drones/launch", {
    method: "POST", body: { drones: [{ itemID: BAY_DRONE_ID }] },
  });
  assert.equal(gateway.calls.snapshot.length, 3, "launch retains before/after authority reads");
  await apiRequest(baseUrl, "/api/bridge/drones");
  assert.equal(gateway.calls.snapshot.length, 4, "later confirmation reads afresh");
});

test("drone and script observations retain an invitation drained by any constituent read", async () => {
  const invitation = { method: "OnFleetInvite", args: [654500150000, 140000044, "FleetInvitation", {}] };
  const sources = ["readFlightStatus", "bindObject", "callBoundMethod", "callMethod", "readSpaceSnapshot"];
  for (const route of ["/api/bridge/drones", "/api/bridge/script/observation"]) {
    for (const source of sources) {
      const { gateway, baseUrl } = await inSpace();
      const read = gateway[source].bind(gateway);
      let drained = false;
      gateway[source] = async (...args) => {
        const outcome = await read(...args);
        if (drained) return outcome;
        drained = true;
        return { ...outcome, notifications: [invitation] };
      };
      const result = await apiRequest(baseUrl, route);
      assert.equal(result.response.status, 200, `${route}: ${source}`);
      assert.deepEqual(result.payload.notifications, [invitation], `${route}: ${source} is forwarded once`);
      const next = await apiRequest(baseUrl, route);
      assert.deepEqual(next.payload.notifications, [], "a drained invitation is not replayed by the BFF");
    }
  }
});

test("partial drone reads preserve other successful notification drains", async () => {
  const invitation = { method: "OnFleetInvite", args: [654500150000, 140000044, "FleetInvitation", {}] };
  for (const route of ["/api/bridge/drones", "/api/bridge/script/observation"]) {
    for (const failed of ["bay", "shipInfo"]) {
      const { gateway, baseUrl } = await inSpace();
      const bind = gateway.bindObject.bind(gateway);
      gateway.bindObject = async (...args) => ({ ...await bind(...args), notifications: [invitation] });
      gateway[failed === "bay" ? "callBoundMethod" : "callMethod"] = async () => {
        throw Object.assign(new Error("Unreadable component"), { code: "CALL_REFUSED", statusCode: 409 });
      };
      const result = await apiRequest(baseUrl, route);
      assert.equal(result.response.status, 200);
      assert.equal(result.payload[failed], null, `${failed} remains unknown`);
      assert.equal(result.payload.errors[failed], "CALL_REFUSED");
      assert.deepEqual(result.payload.notifications, [invitation], "the successful bind drain survives a component refusal");
    }
  }
});

// ── a launch on the game port ────────────────────────────────────────────────
//
// The gateway's snapshot is the server's own scene, where a launched drone already is when LaunchDrones answers.
// A pilot on the game port sees its own park, and the drone is a ball the next ballpark update brings (seen live
// 2026-10-10: the launch's answer listed nothing launched, and four seconds on both transports listed the two).
// The page reads "nothing launched" as a launch that failed.

/** A pilot in space on a game port whose park shows a launched drone only at the read numbered `arrivesAt` after the launch (1 is the first). */
async function inSpaceOnTheGamePort({ arrivesAt = 1, inertLaunch = false } = {}) {
  const gamePort = fakeGateway();
  gamePort.state.inertLaunch = inertLaunch;
  const [select, call, snapshot] = [gamePort.selectCharacter, gamePort.callMethod, gamePort.readSpaceSnapshot];
  let readsSinceLaunch = null;
  gamePort.selectCharacter = async (...args) => ({ ...(await select(...args)), bridgeSessionID: "gp:a-game-port-session" });
  gamePort.callMethod = async (service, method, ...rest) => {
    const answer = await call(service, method, ...rest);
    if (service === "ship" && method === "LaunchDrones") readsSinceLaunch = 0;
    return answer;
  };
  gamePort.readSpaceSnapshot = async (...args) => {
    const read = await snapshot(...args);
    if (readsSinceLaunch === null) return read;
    readsSinceLaunch += 1;
    return readsSinceLaunch >= arrivesAt ? read : { ...read, space: { ...read.space, entities: read.space.entities.filter((row) => row.kind !== "drone") } };
  };
  const slept = [];
  const gateway = fakeGateway();
  const app = createApp({
    eveStore: fakeStore(), eveGatewayClient: gateway, gamePortPilots: gamePort, pilotTransportFor: () => "gameport",
    webAuth: fakeAuth(), staticData: fakeStaticData(), transitionSleep: async (ms) => { slept.push(ms); }, errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: CHARACTER_ID } });
  return { gamePort, gateway, baseUrl, slept };
}
const launchOf = (baseUrl) => apiRequest(baseUrl, "/api/bridge/drones/launch", { method: "POST", body: { drones: [{ itemID: BAY_DRONE_ID }] } });

test("on the game port a launched drone comes with the next ballpark update: the launch waits for it, and says it launched", async () => {
  // The drone is in the park at the third look after the launch.
  const { gamePort, gateway, baseUrl, slept } = await inSpaceOnTheGamePort({ arrivesAt: 3 });
  const { response, payload } = await launchOf(baseUrl);
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.deepEqual([payload.launched.map((drone) => drone.itemID), payload.inSpace.map((drone) => drone.itemID)], [[BAY_DRONE_ID], [BAY_DRONE_ID]]);
  // Two waits of a quarter of a second, and no more once it had come.
  assert.deepEqual(slept, [250, 250]);
  // The launch was the game port's, once; the gateway heard nothing of it.
  assert.deepEqual([callsOf(gamePort, "ship", "LaunchDrones").length, callsOf(gateway, "ship", "LaunchDrones").length, gateway.calls.snapshot.length], [1, 0, 0]);
  // A drone that is there at the first look is waited for not at all.
  const prompt = await inSpaceOnTheGamePort({ arrivesAt: 1 });
  assert.deepEqual([(await launchOf(prompt.baseUrl)).payload.launched.map((drone) => drone.itemID), prompt.slept], [[BAY_DRONE_ID], []]);
});

test("on the game port a launch the server did nothing with is said to have launched nothing, once the wait is over", async () => {
  const { baseUrl, slept } = await inSpaceOnTheGamePort({ inertLaunch: true });
  const { response, payload } = await launchOf(baseUrl);
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.deepEqual([payload.launched, payload.inSpace], [[], []]);
  // Three seconds in all, a quarter at a time.
  assert.deepEqual([slept.length, slept.reduce((sum, ms) => sum + ms, 0), new Set(slept).size], [12, 3000, 1]);
  // A drone that comes later than the wait is not said to have launched: the page reads the drones again.
  const late = await inSpaceOnTheGamePort({ arrivesAt: 20 });
  assert.deepEqual([(await launchOf(late.baseUrl)).payload.launched, late.slept.length], [[], 12]);
});

test("a gateway pilot's launch is answered from the first look, with no waiting", async () => {
  const slept = [];
  const gateway = fakeGateway();
  gateway.state.inertLaunch = true;
  const app = createApp({ eveStore: fakeStore(), eveGatewayClient: gateway, webAuth: fakeAuth(), staticData: fakeStaticData(), transitionSleep: async (ms) => { slept.push(ms); }, errorLogger() {} });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: CHARACTER_ID } });
  const { payload } = await launchOf(baseUrl);
  assert.deepEqual([payload.launched, slept], [[], []]);
});

// ── a drone just landed ──────────────────────────────────────────────────────
//
// dronesUtil.GetDroneIDsInSpace (32 to 35): the client's drones in space are the ones it knows of that are NOT in
// the bay. A landed drone is in the bay at once and its ball leaves the scene a moment later; on the game port the
// scene is the pilot's own ballpark, and asked in between it still has the ball. Seen in the tab on 2026-10-10: the
// page's two reads after a landing, half a second and a second on, were each answered with the drone in the bay AND
// "returning" in space, and the window went on saying so.

test("a drone the bay holds is not said to be in space as well", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.space.set(BAY_DRONE_ID, gateway.droneRow(BAY_DRONE_ID));
  gateway.state.space.set(9500001, gateway.droneRow(9500001));

  const { payload } = await apiRequest(baseUrl, "/api/bridge/drones");

  assert.deepEqual(payload.bay.map((row) => row.itemID).sort(), [BAY_DRONE_ID, SECOND_BAY_DRONE_ID]);
  assert.deepEqual(payload.inSpace.map((drone) => drone.itemID), [9500001]);
});

test("with the bay unread, the drones in space are said as the scene has them", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.space.set(BAY_DRONE_ID, gateway.droneRow(BAY_DRONE_ID));
  gateway.callBoundMethod = async () => {
    throw Object.assign(new Error("Unreadable component"), { code: "CALL_REFUSED", statusCode: 409 });
  };

  const { payload } = await apiRequest(baseUrl, "/api/bridge/drones");

  assert.equal(payload.bay, null);
  assert.deepEqual(payload.inSpace.map((drone) => drone.itemID), [BAY_DRONE_ID]);
});
