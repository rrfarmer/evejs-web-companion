"use strict";

// A pilot docked in a structure, on the game port.
//
// What the retail client does there (the recordings of a client docked in a citadel, in every folder that has one;
// eve/client/script/ui/services/structure/structureServices.py; structures/services.py):
//
//   its services    asked once as the pilot docks, structureSettings.CharacterGetServices(structureID), and kept:
//                   a dict of each service the structure has for the pilot to what it charges
//   what it holds   a service available where it is one a structure has for anyone docked in it (its docking,
//   available       which is its hangars, and its fitting: ONLINE_SERVICES_UNRESTRICTED_ACCESS), or is in that
//                   dict; and industry where any industry service is in it (IsServiceAvailableForCharacter, 37 to 46)
//   its hangars     the structure's own inventory, listed by the hangar's flag, with no service asked about
//
// The BFF's routes check a structure's service before they go on (assertStructureService). Through the stock web
// gateway there is no answer to check by, and each is refused, deliberately
// (docs/stock-evejs-integration-policy.md; test/bridgeInventory.test.js has that). On the game port the server's own
// answer is had as a client has it, and the check is the client's rule. The transport's keeping of the answer is
// test/gamePortPilots.test.js's.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const CHARACTER = { characterID: 7, accountID: 4, characterName: "Test Pilot" };
const STRUCTURE_ID = 1_030_000_000_011;
const ANOTHER_STRUCTURE_ID = 1_030_000_000_012;
const SYSTEM_ID = 30000142;
const SHIP_ID = 9001;
const FLAG_HANGAR = 4;
const FLAG_CARGO = 5;
const GAME_PORT_HANDLE = "gp:a-pilot-docked-in-a-structure";

const ORIGINAL_FETCH = global.fetch;
const activeServers = new Set();

const packedRow = (fields) => ({ type: "packedrow", fields });
const keyVal = (entries) => ({ type: "object", name: "util.KeyVal", args: { type: "dict", entries } });
/** CharacterGetServices' answer: each service's ID to what it charges. */
const services = (...ids) => ({ type: "dict", entries: ids.map((id) => [id, 0]) });

function fakeAuth() {
  return {
    createSessionToken: () => COOKIE_TOKEN,
    verifySessionToken: (token) => (token === COOKIE_TOKEN ? { username: ACCOUNT.username, accountID: ACCOUNT.accountID, sessionID: "a-web-session" } : null),
    countConfiguredUsers: () => 1,
  };
}

function fakeStore() {
  return {
    async getAccount(username) { return username === ACCOUNT.username ? { ...ACCOUNT } : null; },
    async getCharacterForAccount(accountID, characterID) {
      return Number(accountID) === ACCOUNT.accountID && Number(characterID) === CHARACTER.characterID ? { ...CHARACTER } : null;
    },
    async releaseCharacterControl() { return { controlState: "offline" }; },
  };
}

const fakeStaticData = () => ({
  getStation: () => null,
  getTypeName: (id) => `Type ${id}`,
  getType: (id) => ({ typeID: id, volume: 0.01 }),
  getSolarSystemName: () => "A System",
});

/**
 * A stand-in for a pilot's transport, its pilot docked in the structure: what is asked of it is listed, a hangar
 * and a cargo hold answer their Lists from `placement` and take an Add, and `answers` says what a call by name is
 * answered ("service.method": a value, or a function of its arguments).
 */
function fakeTransport({ handle, answers = {} }) {
  const calls = { call: [], bind: [], boundCall: [], fee: [] };
  const placement = new Map([[100, { flag: FLAG_HANGAR, quantity: 5, typeID: 34 }], [101, { flag: FLAG_CARGO, quantity: 3, typeID: 35 }]]);
  /** The methods on a bound object that are refused, each asking of one listed in `refusals`. */
  const refused = new Set();
  const refusals = [];
  return {
    calls,
    placement,
    refused,
    refusals,
    async selectCharacter() {
      return {
        bridgeSessionID: handle, service: "charUnboundMgr", method: "SelectCharacterID", result: null, notifications: [],
        session: { userid: 4, characterID: 7, characterName: "Test Pilot", stationID: null, structureID: STRUCTURE_ID, solarSystemID: SYSTEM_ID, corporationID: 98000000, shipID: SHIP_ID },
      };
    },
    async releaseBridgeSession() { return { released: true, characterID: 7 }; },
    /** The broker's fee rate where an order would be placed, as the game port's transport answers it: one percent, and the place asked for is listed. */
    async brokersFeeRate(placeID) { calls.fee.push(placeID); return 0.01; },
    async readFlightStatus() {
      return { flight: { docked: true, inSpace: false, stationID: null, structureID: STRUCTURE_ID, solarSystemID: SYSTEM_ID, shipID: SHIP_ID }, notifications: [] };
    },
    async callMethod(service, method, args, kwargs) {
      calls.call.push({ service, method, args, kwargs });
      const answer = answers[`${service}.${method}`];
      return { service, method, result: typeof answer === "function" ? answer(args, kwargs) : answer ?? null, notifications: [] };
    },
    async bindObject(service, method, args, kwargs) {
      calls.bind.push({ service, method, args, kwargs });
      return { boundHandle: `handle:${service}:${method}:${JSON.stringify(args)}`, service, method, notifications: [] };
    },
    async callBoundMethod(service, method, args, kwargs, sessionFields, bridgeSessionID, boundHandle) {
      if (refused.has(method)) {
        refusals.push(`${service}.${method}`);
        throw Object.assign(new Error("That container is locked."), { code: "CALL_REFUSED", statusCode: 409 });
      }
      calls.boundCall.push({ service, method, args, kwargs, boundHandle });
      if (method === "Add") placement.get(args[0]).flag = kwargs.flag;
      if (method === "List") {
        return { result: { type: "list", items: [...placement].filter(([, item]) => item.flag === args[0])
          .map(([itemID, item]) => packedRow({ itemID, typeID: item.typeID, groupID: 18, categoryID: 4, ownerID: 7, locationID: item.flag === FLAG_HANGAR ? STRUCTURE_ID : SHIP_ID, flagID: item.flag, quantity: item.quantity, stacksize: item.quantity, singleton: 0 })) }, notifications: [] };
      }
      if (method === "GetCapacity") return { result: keyVal([["capacity", 1000], ["used", 1]]), notifications: [] };
      return { result: null, notifications: [] };
    },
  };
}

/** A server whose pilot is on the game port (`onGamePort`), or through the gateway. The other transport is there too, and is asked nothing. */
async function startTestServer({ onGamePort, answers, miningOperations }) {
  const gateway = fakeTransport({ handle: "a-handle-the-gateway-made", answers });
  const gamePort = fakeTransport({ handle: GAME_PORT_HANDLE, answers });
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: gateway,
    webAuth: fakeAuth(),
    staticData: fakeStaticData(),
    gamePortPilots: gamePort,
    miningOperations,
    pilotTransportFor: () => (onGamePort ? "gameport" : "gateway"),
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const ask = async (path, options = {}) => {
    const response = await ORIGINAL_FETCH(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers: { "content-type": "application/json", cookie: `evejs_web_poc=${COOKIE_TOKEN}` },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return { status: response.status, payload: await response.json() };
  };
  await ask("/api/bridge/select", { method: "POST", body: { characterID: 7 } });
  return { ask, gateway, gamePort, botHost: app.locals.botHost, own: onGamePort ? gamePort : gateway, other: onGamePort ? gateway : gamePort };
}

const askedOf = (transport, service) => transport.calls.call.filter((call) => call.service === service).map((call) => [call.method, call.args, call.kwargs]);

test.afterEach(async () => {
  global.fetch = ORIGINAL_FETCH;
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    closing.push(new Promise((resolve, reject) => { server.close((error) => (error ? reject(error) : resolve())); }));
  }
  await Promise.all(closing);
});

test("on the game port a pilot docked in a structure has its hangar and its cargo, with nothing asked of the structure's services", async () => {
  // Its docking is a service a structure has for anyone docked in it: the client asks nothing before it lists a
  // hangar or moves a thing, and nor is anything asked here.
  const { ask, own, other } = await startTestServer({ onGamePort: true, answers: { "structureSettings.CharacterGetServices": () => assert.fail("nothing is asked for a hangar") } });
  const panel = await ask("/api/bridge/inventory");
  assert.equal(panel.status, 200, JSON.stringify(panel.payload));
  assert.deepEqual([panel.payload.stationID, panel.payload.structureID, panel.payload.activeShipID], [null, STRUCTURE_ID, SHIP_ID]);
  assert.deepEqual([panel.payload.hangar.error, panel.payload.cargo.error], [null, null]);
  assert.deepEqual(panel.payload.hangar.list.items.map((row) => [row.fields.itemID, row.fields.flagID]), [[100, FLAG_HANGAR]]);
  assert.deepEqual(panel.payload.cargo.list.items.map((row) => [row.fields.itemID, row.fields.flagID]), [[101, FLAG_CARGO]]);
  // The hangar is asked for as where the pilot is docked: the transport binds it as the client's inventory has it.
  assert.deepEqual(own.calls.bind.filter((bind) => bind.method === "GetInventory").map((bind) => bind.args), [[STRUCTURE_ID]]);
  // (A move each way went by the move route, which went on 2026-10-13: nothing of the page asked it.)
  assert.deepEqual(askedOf(own, "structureSettings"), []);
  // The pilot's other transport was asked nothing at all.
  assert.deepEqual([other.calls.call, other.calls.bind, other.calls.boundCall], [[], [], []]);
});

test("the services route says what the structure has for the pilot docked in it: the server's own answer, the two a structure has for anyone, and industry where any industry service is among them", async () => {
  const state = { answer: services(1, 2, 3, 8, 9, 22) };
  const { ask, own, other } = await startTestServer({ onGamePort: true, answers: {
    "structureSettings.CharacterGetServices": () => state.answer,
    "structureDirectory.CheckMyDockingAccessToStructures": (args) => ({ type: "list", items: args[0] }),
  } });
  const said = async (id = STRUCTURE_ID, query = "") => ask(`/api/dockable-structures/${id}/services${query}`);
  const first = await said();
  assert.deepEqual([first.status, first.payload], [200, { ok: true, structureID: STRUCTURE_ID, serviceIDs: [1, 2, 3, 8, 9, 20, 22] }]);
  // Asked as the client asks it, of the one structure, and nothing asked about its docking: the pilot is in it.
  assert.deepEqual(askedOf(own, "structureSettings"), [["CharacterGetServices", [STRUCTURE_ID], null]]);
  assert.deepEqual(askedOf(own, "structureDirectory"), []);
  // The two a structure has for anyone are said whatever the answer has; industry only for an industry service.
  for (const [answered, serviceIDs] of [
    [services(), [1, 2]],
    [services(3), [1, 2, 3]],
    [services(4, 5, 6), [1, 2, 4, 5, 6]],
    // (A repair shop and an insurer are no industry.)
    [services(8, 9), [1, 2, 8, 9]],
    [services(34), [1, 2, 20, 34]],
    [services(41, 8), [1, 2, 8, 20, 41]],
    [services(20), [1, 2, 20]],
  ]) {
    state.answer = answered;
    assert.deepEqual((await said()).payload.serviceIDs, serviceIDs, JSON.stringify(answered.entries));
  }
  // An answer that is no dict of services is no answer: nothing is said of the structure.
  for (const unreadable of [null, { type: "list", items: [1, 2] }, { type: "dict" }, { type: "dict", entries: [[0, 0]] }, { type: "dict", entries: [["8", 0]] }, { type: "dict", entries: [[1.5, 0]] }, { type: "dict", entries: [8] }]) {
    state.answer = unreadable;
    const refused = await said();
    assert.deepEqual([refused.status, refused.payload.error], [503, "STRUCTURE_SERVICE_UNREADABLE"], JSON.stringify(unreadable));
  }
  // A structure the pilot is not docked in, and an account's pilot who is not the held one, go as they went:
  // their docking is asked about, and there is no answer for the services.
  state.answer = services(1, 2, 3);
  const before = askedOf(own, "structureSettings").length;
  const elsewhere = await said(ANOTHER_STRUCTURE_ID);
  assert.deepEqual([elsewhere.status, elsewhere.payload.error], [409, "STRUCTURE_SERVICE_AUTHORITY_UNAVAILABLE"]);
  assert.deepEqual(askedOf(own, "structureDirectory"), [["CheckMyDockingAccessToStructures", [[ANOTHER_STRUCTURE_ID]], null]]);
  const another = await said(STRUCTURE_ID, "?characterID=7");
  assert.deepEqual([another.status, another.payload.error], [409, "STRUCTURE_SERVICE_AUTHORITY_UNAVAILABLE"]);
  assert.equal(askedOf(own, "structureSettings").length, before);
  assert.deepEqual(askedOf(other, "structureSettings"), []);
  // And what is no structure's ID is refused as it was.
  assert.equal((await said(60003760)).status, 400);
});

test("through the web gateway a structure's services have no answer, and each of these is refused as it was", async () => {
  const { ask, own, other } = await startTestServer({ onGamePort: false, answers: {
    "structureSettings.CharacterGetServices": () => assert.fail("the gateway's list has nothing of the structure settings'"),
    "structureDirectory.CheckMyDockingAccessToStructures": (args) => ({ type: "list", items: args[0] }),
  } });
  for (const [path, options] of [
    [`/api/dockable-structures/${STRUCTURE_ID}/services`, {}],
    ["/api/bridge/inventory", {}],
  ]) {
    const refused = await ask(path, options);
    assert.deepEqual([refused.status, refused.payload.error], [409, "STRUCTURE_SERVICE_AUTHORITY_UNAVAILABLE"], path);
  }
  assert.deepEqual([askedOf(own, "structureSettings"), askedOf(own, "repairSvc"), own.calls.boundCall], [[], [], []]);
  assert.equal(own.placement.get(100).flag, FLAG_HANGAR);
  assert.deepEqual([other.calls.call, other.calls.bind, other.calls.boundCall], [[], [], []]);
});

test("on the game port the reprocessing plant's quote has the hangar listed for it first and the ship's holds for an item not in it, the reprocessing names each item's own place and its output, and in a structure both are held to its reprocessing service", async () => {
  const state = { answer: services(1, 2, 3, 4, 8) };
  const { ask, own, other } = await startTestServer({ onGamePort: true, answers: { "structureSettings.CharacterGetServices": () => state.answer } });
  const bound = (method) => own.calls.boundCall.filter((call) => call.method === method).map((call) => [call.service, call.args, call.kwargs, call.boundHandle]);
  const HANGAR = `handle:invbroker:GetInventory:[${STRUCTURE_ID}]`;
  const PLANT = `handle:reprocessingSvc:MachoBindObject:[${STRUCTURE_ID}]`;
  const SHIP = `handle:invbroker:GetInventoryFromId:[${SHIP_ID}]`;

  // The quote: the hangar's listing is read first (the transport hands the quote each item's row out of it), and
  // the plant is asked for the items by their IDs, on its own Moniker, which is for the structure.
  const quote = await ask("/api/bridge/reprocessing/quote?itemIDs=100");
  assert.equal(quote.status, 200, JSON.stringify(quote.payload));
  assert.deepEqual(own.calls.boundCall.map((call) => `${call.service}.${call.method}`), ["invbroker.List", "reprocessingSvc.GetQuotes"]);
  assert.deepEqual([bound("List"), bound("GetQuotes")], [[["invbroker", [FLAG_HANGAR], null, HANGAR]], [["reprocessingSvc", [[100]], null, PLANT]]]);
  // A listing that could not be read fails no quote.
  own.refused.add("List");
  const unlisted = await ask("/api/bridge/reprocessing/quote?itemIDs=100");
  assert.deepEqual([unlisted.status, own.refusals, bound("GetQuotes").length], [200, ["invbroker.List"], 2]);
  own.refused.delete("List");
  // An item that is not in the hangar: the ship's holds are listed for it too, down the ladder as far as the one it
  // is in (the cargo is the last), so that the transport holds its row for the quote.
  const asked = own.calls.boundCall.length;
  const ofTheCargo = await ask("/api/bridge/reprocessing/quote?itemIDs=101");
  assert.equal(ofTheCargo.status, 200, JSON.stringify(ofTheCargo.payload));
  assert.deepEqual(own.calls.boundCall.slice(asked).map((call) => [call.method, call.args, call.boundHandle]),
    [["List", [FLAG_HANGAR], HANGAR], ["List", [134], SHIP], ["List", [135], SHIP], ["List", [181], SHIP], ["List", [182], SHIP], ["List", [FLAG_CARGO], SHIP], ["GetQuotes", [[101]], PLANT]]);

  // The reprocessing, as the page makes it since 2026-10-14 (web/src/bridge/reprocessWrites.ts): each item as of
  // its own place (the structure's hangar; the ship), for the pilot, to the structure's hangar by name, on the plant.
  const refine = (itemIDs, place) => ask("/api/bridge/call", { method: "POST", body: { service: "reprocessingSvc", method: "Reprocess", args: [itemIDs, place, 7, STRUCTURE_ID, FLAG_HANGAR], kwargs: null, pilot: true, confirm: true } });
  for (const [itemIDs, place] of [[[100], STRUCTURE_ID], [[101], SHIP_ID]]) {
    const done = await refine(itemIDs, place);
    assert.equal(done.status, 200, JSON.stringify(done.payload));
  }
  assert.deepEqual(bound("Reprocess"), [
    ["reprocessingSvc", [[100], STRUCTURE_ID, 7, STRUCTURE_ID, FLAG_HANGAR], null, PLANT],
    ["reprocessingSvc", [[101], SHIP_ID, 7, STRUCTURE_ID, FLAG_HANGAR], null, PLANT],
  ]);

  // A structure with no reprocessing for the pilot: neither is asked of the plant.
  state.answer = services(1, 2, 3, 8);
  const before = own.calls.boundCall.length;
  const refusedQuote = await ask("/api/bridge/reprocessing/quote?itemIDs=100");
  assert.deepEqual([refusedQuote.status, refusedQuote.payload.error], [409, "STRUCTURE_SERVICE_UNAVAILABLE"]);
  const refusedRefining = await refine([100], STRUCTURE_ID);
  assert.deepEqual([refusedRefining.status, refusedRefining.payload.error], [409, "STRUCTURE_SERVICE_UNAVAILABLE"]);
  assert.equal(own.calls.boundCall.length, before);
  assert.deepEqual([other.calls.call, other.calls.bind, other.calls.boundCall], [[], [], []]);
});

test("an ordinary script strictly unloads ice into its Upwell corporation division without an operation", async () => {
  const officeID = 7000001;
  const { ask, own } = await startTestServer({ onGamePort: true, answers: {
    "structureSettings.CharacterGetServices": services(3),
    "officeManager.GetMyCorporationsOffices": { list: [packedRow({ officeID, stationID: STRUCTURE_ID })] },
  } });
  own.placement.set(102, { flag: 181, quantity: 10, typeID: 16264 });
  const result = await ask("/api/bridge/ship/ore-hold/unload", {
    method: "POST", body: { itemIDs: [102], division: 1, strictCorp: true, expectedDestination: { kind: "structure", id: STRUCTURE_ID } },
  });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.deepEqual(result.payload.movedToCorp, [102]);
  assert.equal(result.payload.fellBack, null);
  assert.equal(own.placement.get(102).flag, 115);
  const adds = own.calls.boundCall.filter(call => call.method === "Add");
  assert.deepEqual(adds.map(call => [call.args, call.kwargs, call.boundHandle]), [
    [[102, SHIP_ID], { flag: 115 }, `handle:invbroker:GetInventoryFromId:[${officeID}]`],
  ]);
  const divisionReads = own.calls.boundCall.filter(call => call.method === "List" && call.args[0] === 115);
  assert.equal(divisionReads.length, 2, "the corporation division is read before and after the move");
});

for (const expectedDestination of [undefined, { kind: "structure", id: "1030000000011" },
  { kind: "structure", id: ANOTHER_STRUCTURE_ID }, { kind: "station", id: STRUCTURE_ID }]) {
  test(`strict unload rejects a missing, invalid or stale destination: ${JSON.stringify(expectedDestination)}`, async () => {
    const { ask, own } = await startTestServer({ onGamePort: true, answers: {
      "structureSettings.CharacterGetServices": services(3),
      "officeManager.GetMyCorporationsOffices": { list: [packedRow({ officeID: 7000001, stationID: STRUCTURE_ID })] },
    } });
    const result = await ask("/api/bridge/ship/ore-hold/unload", {
      method: "POST", body: { itemIDs: [101], division: 1, strictCorp: true, expectedDestination },
    });
    assert.equal(result.status, !expectedDestination || typeof expectedDestination.id !== "number" ? 400 : 409);
    assert.equal(own.calls.boundCall.some(call => call.method === "Add"), false);
    assert.equal(own.placement.get(101).flag, FLAG_CARGO);
  });
}

test("strict unload refuses a location change after inventory reads but before Add", async () => {
  const { ask, own } = await startTestServer({ onGamePort: true, answers: {
    "structureSettings.CharacterGetServices": services(3),
    "officeManager.GetMyCorporationsOffices": { list: [packedRow({ officeID: 7000001, stationID: STRUCTURE_ID })] },
  } });
  let changed = false;
  const read = own.readFlightStatus.bind(own);
  own.readFlightStatus = async (...args) => {
    const result = await read(...args);
    if (changed) result.flight.structureID = ANOTHER_STRUCTURE_ID;
    return result;
  };
  const call = own.callBoundMethod.bind(own);
  own.callBoundMethod = async (service, method, args, ...rest) => {
    const result = await call(service, method, args, ...rest);
    if (method === "List" && args[0] === 115) changed = true;
    return result;
  };
  const result = await ask("/api/bridge/ship/ore-hold/unload", { method: "POST",
    body: { itemIDs: [101], division: 1, strictCorp: true, expectedDestination: { kind: "structure", id: STRUCTURE_ID } } });
  assert.equal(result.status, 409, JSON.stringify(result.payload));
  assert.equal(own.calls.boundCall.some(call => call.method === "Add"), false);
  assert.equal(own.placement.get(101).flag, FLAG_CARGO);
});

test("an operation claim still cannot strictly unload outside its configured destination", async () => {
  const { ask, own, botHost } = await startTestServer({ onGamePort: true,
    miningOperations: { definition: () => ({ unloadDestination: { kind: "structure", id: ANOTHER_STRUCTURE_ID,
      corporationDivision: 1, corporationID: 98000000 } }) }, answers: {
    "structureSettings.CharacterGetServices": services(3),
  } });
  botHost.operationForClaim = () => ({ operationID: "00000000-0000-4000-8000-000000000000" });
  const result = await ask("/api/bridge/ship/ore-hold/unload", {
    method: "POST", body: { itemIDs: [101], division: 1, strictCorp: true, expectedDestination: { kind: "structure", id: STRUCTURE_ID } },
  });
  assert.deepEqual([result.status, result.payload.error], [409, "STRICT_CORP_DESTINATION_MISMATCH"]);
  assert.equal(own.calls.boundCall.some(call => call.method === "Add"), false);
});

for (const failure of ["refused", "ignored", "missing office", "missing service"]) {
  test(`strict Upwell unloading fails closed for ${failure} without a personal fallback`, async () => {
    const { ask, own } = await startTestServer({ onGamePort: true, answers: {
      "structureSettings.CharacterGetServices": services(...(failure === "missing service" ? [] : [3])),
      "officeManager.GetMyCorporationsOffices": { list: failure === "missing office" ? [] : [packedRow({ officeID: 7000001, stationID: STRUCTURE_ID })] },
    } });
    own.placement.set(102, { flag: 181, quantity: 10, typeID: 16264 });
    if (failure === "refused") own.refused.add("Add");
    if (failure === "ignored") {
      const call = own.callBoundMethod.bind(own);
      own.callBoundMethod = async (service, method, ...args) => method === "Add"
        ? { result: null, notifications: [] } : call(service, method, ...args);
    }
    const result = await ask("/api/bridge/ship/ore-hold/unload", {
      method: "POST", body: { itemIDs: [102], division: 1, strictCorp: true, expectedDestination: { kind: "structure", id: STRUCTURE_ID } },
    });
    assert.equal(result.status, 409, JSON.stringify(result.payload));
    assert.equal(result.payload.error, failure === "missing office" ? "CORP_OFFICE_UNAVAILABLE"
      : failure === "missing service" ? "STRUCTURE_SERVICE_UNAVAILABLE" : "CORP_TRANSFER_UNCONFIRMED");
    assert.equal(own.placement.get(102).flag, 181);
    assert.equal(own.calls.boundCall.some(call => call.method === "Add" && call.kwargs.flag === FLAG_HANGAR), false);
  });
}

test("the Market read names the structure the pilot is docked in, and on the game port its rate is the one asked for the structure", async () => {
  // The read is held to no service of the structure's: a client reads a region's market wherever it is.
  const onGamePort = await startTestServer({ onGamePort: true, answers: { "structureSettings.CharacterGetServices": () => assert.fail("nothing is asked of the structure's services for a read") } });
  const read = await onGamePort.ask("/api/bridge/market");
  assert.equal(read.status, 200, JSON.stringify(read.payload));
  assert.deepEqual([read.payload.stationID, read.payload.structureID, read.payload.brokersFeeRate], [null, STRUCTURE_ID, 0.01]);
  assert.deepEqual([onGamePort.own.calls.fee, onGamePort.other.calls.fee], [[STRUCTURE_ID], []]);
  // Through the gateway the read stands too, with the structure named and no rate.
  const throughGateway = await startTestServer({ onGamePort: false });
  const gatewayRead = await throughGateway.ask("/api/bridge/market");
  assert.deepEqual([gatewayRead.status, gatewayRead.payload.stationID, gatewayRead.payload.structureID, gatewayRead.payload.brokersFeeRate], [200, null, STRUCTURE_ID, null]);
  assert.deepEqual([throughGateway.own.calls.fee, throughGateway.other.calls.fee], [[], []]);
});
