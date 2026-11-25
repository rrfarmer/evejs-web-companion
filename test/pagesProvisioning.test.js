"use strict";

// Ready Fit reads its own held-pilot transfer and ship receipts through the real bridge routes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { once } = require("events");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-web-provisioning-"));
process.env.EVEJS_WEB_POC_DATA_DIR = DATA;

const { createApp } = require("../src/server");
const { dispatchInProcess } = require("../src/pilotSocket");
const { hash } = require("../src/provisioningContracts");

const activeServers = new Set();

const object = (fields) => ({ type: "object", args: { type: "dict", entries: Object.entries(fields) } });
const list = (items) => ({ type: "list", items });
const refused = (status, code) => (error) => error.status === status && error.code === code;
const TYPES = {
  1: { categoryID: 6, groupID: 25 }, // the fitting's hull, a frigate
  99: { categoryID: 6, groupID: 25 }, // the hull a pilot sits in before another is made
  2: { categoryID: 7, groupID: 54 }, // a module
  3: { categoryID: 8, groupID: 83, volume: 0.01 }, // a charge
};
const staticData = { getType: (id) => TYPES[id], getTypeName: (id) => `Type ${id}`, getStation: () => ({ stationName: "Test station" }) };
/** A corporation's saved fitting as the server answers one. */
const fitting = (fittingID, corporationID, name, items) => [fittingID, object({ fittingID, ownerID: corporationID, shipTypeID: 1, name,
  savedDate: { type: "long", value: "100" }, fitData: list(items.map((item) => ({ type: "tuple", items: item }))) })];

async function listening(app) {
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

/** The page's own request with a session's token: what it asked, with what, and what it was answered are kept. */
function asking(baseUrl, token) {
  const paths = [];
  const bodies = [];
  const options = {
    baseUrl,
    token,
    fetch: async (input, init) => {
      paths.push(`${(init && init.method) || "GET"} ${String(input).replace(/^https?:\/\/[^/]+/, "")}`);
      bodies.push(init && init.body ? JSON.parse(init.body) : null);
      return fetch(input, init);
    },
  };
  return { options, paths, bodies };
}

test.afterEach(async () => {
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    server.closeAllConnections();
    closing.push(new Promise((resolve) => { server.close(() => resolve()); }));
  }
  await Promise.all(closing);
});

// ---------------------------------------------------------------------------------------------------------------
// The cockpit's: POST /api/bridge/provisioning/reconcile
// ---------------------------------------------------------------------------------------------------------------

const COCKPIT = "cockpit-token";
const MATE = "mate-token";

/**
 * A BFF with pilot 10 held by one tab and pilot 11, of the same account, by another. `world.gateway` is the
 * server: what it has, and what it was sent that changes anything (`world.sent`).
 */
async function cockpit(world) {
  const held = { accountID: 7, characterID: 10, corporationID: 20, activeShipID: 50, stationID: 60,
    bridgeSessionID: "held-10", boundHandles: new Map(), streamSubscribers: new Set(), droneRecoveryReady: true };
  const mate = { accountID: 7, characterID: 11, corporationID: 20, activeShipID: 51, stationID: 60,
    bridgeSessionID: "held-11", boundHandles: new Map(), streamSubscribers: new Set(), droneRecoveryReady: true };
  const sessions = new Map([["tab", held], ["tab-2", mate]]);
  const app = createApp({
    eveGatewayClient: world.gateway,
    bridgeSessionStore: sessions,
    errorLogger() {},
    staticData,
    eveStore: {
      async getAccount() { return { accountID: 7, username: "test", banned: false }; },
      async getCharacterForAccount(accountID, characterID) { return { characterID, characterName: `Pilot ${characterID}` }; },
      async listCharactersForAccount() { return [10, 11].map((characterID) => ({ accountID: 7, characterID, corporationID: 20, characterName: `Pilot ${characterID}` })); },
    },
    webAuth: { verifySessionToken: (token) => (token === COCKPIT ? { accountID: 7, username: "test", sessionID: "tab" }
      : token === MATE ? { accountID: 7, username: "test", sessionID: "tab-2" } : null) },
  });
  const baseUrl = await listening(app);
  const api = await import("../web/src/app/api.ts");
  return { app, api, held, mate, sessions, page: asking(baseUrl, COCKPIT), other: asking(baseUrl, MATE) };
}

/**
 * Pilot 10 in a fitted frigate with 3,200 of the 5,000 charges its saved fitting carries, and 4,000 more in its
 * hangar (`world.stock`, one stack; `world.second` is another, where a test has one). The move the BFF asks is
 * 1,800 of them into the hold. `world.add` says what becomes of it, or of each sending in turn.
 */
function suppliesWorld() {
  const world = { stock: 4000, second: 0, aboard: 3200, shipOf: { "held-10": 50, "held-11": 51 }, add: "lands", sent: [] };
  const row = (itemID, typeID, quantity, locationID, flagID, singleton = 0) => ({ type: "packedrow",
    fields: { itemID, typeID, quantity, ownerID: 10, locationID, flagID, singleton } });
  world.gateway = {
    async readFlightStatus(handle) {
      return { flight: { shipID: world.shipOf[handle], shipTypeID: 1, docked: true, stationID: 60, structureID: null }, notifications: [] };
    },
    async callMethod(service, method) {
      assert.deepEqual([service, method], ["corpFittingMgr", "GetFittings"]);
      return { result: { type: "dict", entries: [fitting(4, 20, "Exact", [[2, 27, 1], [3, 5, 5000]])] } };
    },
    async bindObject(service, method, args) { return { boundHandle: args[0], notifications: [] }; },
    async callBoundMethod(service, method, args, kwargs, fields, bridgeSessionID, handle) {
      if (method === "GetCapacity") return { result: object({ capacity: args[0] === 5 ? 10000 : 0, used: 0 }) };
      if (method === "ListByFlags") return { result: list([row(70, 2, -1, 50, 27, 1), row(90, 3, world.aboard, 50, 5)]) };
      if (method === "List") return { result: list(handle === 60
        ? [...(world.stock ? [row(100, 3, world.stock, 60, 4)] : []), ...(world.second ? [row(101, 3, world.second, 60, 4)] : [])]
        : args[0] === 5 ? [row(90, 3, world.aboard, 50, 5)] : []) };
      world.sent.push([method, args, kwargs]);
      assert.equal(method, "Add");
      const how = Array.isArray(world.add) ? world.add.shift() : world.add;
      if (how === "lands") world.land(kwargs.qty, args[0]);
      if (how === "in part") world.land(1000, args[0]);
      if (how !== "lands") throw Object.assign(new Error("the answer was lost"), { code: "TEST_ANSWER_LOST" });
      return { result: null, notifications: [] };
    },
  };
  world.land = (quantity, itemID = 100) => { world[itemID === 100 ? "stock" : "second"] -= quantity; world.aboard += quantity; };
  return world;
}

const SUPPLIES = { providerCharacterID: 11, corporationID: 20, fittingID: 4, source: { kind: "hangar" } };

/** The Provisioning panel's Review and Replenish, by its own askers: what the replenishing was answered. */
async function replenish(api, options) {
  const review = await api.reviewProvisioning(SUPPLIES, options);
  assert.equal(review.canApply, true, JSON.stringify(review));
  return api.replenishProvisioning(review.reviewID, review.reviewHash, options);
}

test("supplies whose move was not proven: the page posts the operation's own id, the BFF looks again and sends nothing, and says the custody settled once the move is there", { timeout: 20000 }, async () => {
  const world = suppliesWorld();
  const { api, page } = await cockpit(world);
  // The move is asked, its answer is lost, and at the look after it nothing has moved: the custody is blocked.
  world.add = "lost";
  const blocked = await replenish(api, page.options);
  assert.deepEqual([blocked.state, blocked.result], ["BLOCKED", null]);
  assert.deepEqual(world.sent, [["Add", [100, 60], { flag: 5, qty: 1800 }]]);
  // The panel lists what is pending from its options, and asks about one by the id it reads there.
  const pending = (await api.provisioningOptions(null, page.options)).pending;
  assert.deepEqual(pending, [{ operationID: blocked.operationID, state: "BLOCKED", kind: "REPLENISHMENT", input: SUPPLIES }]);

  // Looked at while the move is still not there: blocked still.
  page.paths.length = 0;
  page.bodies.length = 0;
  assert.deepEqual(await api.reconcileProvisioning(pending[0].operationID, page.options),
    { ok: true, operationID: blocked.operationID, state: "BLOCKED", result: null });
  assert.deepEqual([page.paths, page.bodies], [["POST /api/bridge/provisioning/reconcile"], [{ operationID: blocked.operationID }]]);
  assert.equal((await api.provisioningOptions(null, page.options)).pending[0].state, "BLOCKED");

  // The server made the move after all. Looked at again, it is proven, and the custody is over.
  world.land(1800);
  assert.deepEqual(await api.reconcileProvisioning(pending[0].operationID, page.options),
    { ok: true, operationID: blocked.operationID, state: "RECONCILED", result: null });
  assert.deepEqual((await api.provisioningOptions(null, page.options)).pending, []);
  // Asked again of what is settled, it is settled still.
  assert.equal((await api.reconcileProvisioning(pending[0].operationID, page.options)).state, "RECONCILED");
  // Nothing was sent by any of the looks: the one move asked is the one there is.
  assert.equal(world.sent.length, 1);
  assert.deepEqual([world.stock, world.aboard], [2200, 5000]);
});

test("supplies whose move was not proven: a look is let through where every other write of the pilot's is held back, and the pilot writes again once it is settled", { timeout: 20000 }, async () => {
  const world = suppliesWorld();
  const { api, page } = await cockpit(world);
  world.add = "lost";
  const blocked = await replenish(api, page.options);
  assert.equal(blocked.state, "BLOCKED");
  // The custody holds the pilot's writes back, the same replenishing among them; a review is a read, and says why.
  await assert.rejects(api.replenishProvisioning(blocked.operationID, "any", page.options), refused(409, "REPLENISHMENT_CUSTODY"));
  // (The page's own stacking since 2026-10-14, the client's StackAll on the hangar's own inventory.)
  await assert.rejects(api.bridgeDo(page.options)("invbroker", "StackAll", [4], null, "hangar"), refused(409, "REPLENISHMENT_CUSTODY"));
  const review = await api.reviewProvisioning(SUPPLIES, page.options);
  assert.deepEqual([review.canApply, review.pending], [false, [{ operationID: blocked.operationID, state: "BLOCKED" }]]);
  assert.equal(world.sent.length, 1);

  world.land(1800);
  assert.equal((await api.reconcileProvisioning(blocked.operationID, page.options)).state, "RECONCILED");
  const after = await api.reviewProvisioning(SUPPLIES, page.options);
  assert.deepEqual([after.canApply, after.pending, after.status.supplies], [true, [], "FULL"]);
  assert.equal((await api.replenishProvisioning(after.reviewID, after.reviewHash, page.options)).state, "COMPLETE");
  assert.equal(world.sent.length, 1);
});

test("supplies whose move landed in part: looked at again it is not proven, and stays blocked", { timeout: 20000 }, async () => {
  const world = suppliesWorld();
  const { api, page } = await cockpit(world);
  world.add = "in part";
  const blocked = await replenish(api, page.options);
  assert.equal(blocked.state, "BLOCKED");
  assert.deepEqual([world.stock, world.aboard], [3000, 4200]);
  assert.equal((await api.reconcileProvisioning(blocked.operationID, page.options)).state, "BLOCKED");
  // The rest of it arriving is what proves it.
  world.land(800);
  assert.equal((await api.reconcileProvisioning(blocked.operationID, page.options)).state, "RECONCILED");
  assert.equal(world.sent.length, 1);
});

test("supplies moved in two sendings, the second not proven: the one that was proven does not settle the custody, and the second arriving does", { timeout: 20000 }, async () => {
  const world = suppliesWorld();
  const { api, page } = await cockpit(world);
  // Two stacks in the hangar, the first too small for what is wanted: it is moved whole, and the rest asked of the second.
  [world.stock, world.second, world.add] = [1000, 3000, ["lands", "lost"]];
  const blocked = await replenish(api, page.options);
  assert.equal(blocked.state, "BLOCKED");
  assert.deepEqual(world.sent, [["Add", [100, 60], { flag: 5, qty: 1000 }], ["Add", [101, 60], { flag: 5, qty: 800 }]]);
  assert.equal((await api.reconcileProvisioning(blocked.operationID, page.options)).state, "BLOCKED");
  world.land(800, 101);
  assert.equal((await api.reconcileProvisioning(blocked.operationID, page.options)).state, "RECONCILED");
  assert.deepEqual([world.stock, world.second, world.aboard, world.sent.length], [0, 2200, 5000, 2]);
});

test("a look at custody is refused by name: an operation that is another pilot's or nobody's, a pilot in another ship, a session changing place, and no pilot at all", { timeout: 20000 }, async () => {
  const world = suppliesWorld();
  const { api, page, other, held, sessions } = await cockpit(world);
  world.add = "lost";
  const blocked = await replenish(api, page.options);
  world.land(1800);
  const stillBlocked = async () => (await api.provisioningOptions(null, page.options)).pending.map((each) => each.state);

  // Another pilot of the same account, held by another tab; and an id the BFF has not.
  await assert.rejects(api.reconcileProvisioning(blocked.operationID, other.options), refused(409, "OPERATION_NOT_OWNED"));
  await assert.rejects(api.reconcileProvisioning("no-such-operation", page.options), refused(409, "OPERATION_NOT_OWNED"));
  // The pilot has boarded another ship since: what its hold has says nothing of the move.
  world.shipOf["held-10"] = 52;
  held.activeShipID = 52;
  await assert.rejects(api.reconcileProvisioning(blocked.operationID, page.options), refused(409, "RECONCILIATION_SCOPE_CHANGED"));
  world.shipOf["held-10"] = 50;
  held.activeShipID = 50;
  // While the session changes place there is no place to look from.
  held.transition = { phase: "requested", kind: "undock" };
  await assert.rejects(api.reconcileProvisioning(blocked.operationID, page.options), refused(409, "PROVISIONING_CONTEXT_UNAVAILABLE"));
  delete held.transition;
  assert.deepEqual(await stillBlocked(), ["BLOCKED"]);

  // Nobody held by the tab that asks.
  sessions.delete("tab");
  await assert.rejects(api.reconcileProvisioning(blocked.operationID, page.options), refused(409, "NO_LIVE_SESSION"));
  sessions.set("tab", held);
  // None of the refusals settled it or sent anything, and it is settled when asked as it should be.
  assert.equal(world.sent.length, 1);
  assert.equal((await api.reconcileProvisioning(blocked.operationID, page.options)).state, "RECONCILED");
});

/**
 * Pilot 10 in a hull that is not the fitting's, with three packaged hulls of the fitting's and two of its module in
 * the hangar. A ship is made in three sendings (assemble, board, fit); `world.assemble` says what becomes of the first.
 */
function hullWorld() {
  const item = (itemID, typeID, quantity, locationID, flagID, singleton = 0) => ({ itemID, typeID, quantity, locationID, flagID, singleton, ownerID: 10 });
  const world = { ship: 50, assemble: "lands", sent: [], fitted: [],
    hangar: [item(50, 99, 1, 60, 4, 1), item(70, 1, 3, 60, 4), item(80, 2, 2, 60, 4)] };
  world.assembleNow = () => { world.hangar[1].quantity -= 1; world.hangar.push(item(71, 1, 1, 60, 4, 1)); };
  world.gateway = {
    async readFlightStatus(handle) {
      const shipID = handle === "held-11" ? 51 : world.ship;
      return { flight: { docked: true, stationID: 60, shipID, shipTypeID: shipID === 50 ? 99 : 1 }, notifications: [] };
    },
    async callMethod(service, method, args) {
      if (method === "AssembleShip") {
        world.sent.push([`${service}.${method}`, args]);
        if (world.assemble !== "lands") throw Object.assign(new Error("the answer was lost"), { code: "TEST_ANSWER_LOST" });
        world.assembleNow();
        return { result: null, notifications: [] };
      }
      assert.deepEqual([service, method], ["corpFittingMgr", "GetFittings"]);
      return { result: { type: "dict", entries: [fitting(4, 20, "Strict new hull", [[2, 27, 1]])] }, notifications: [] };
    },
    async bindObject(service, method, args) {
      return { boundHandle: method === "MachoBindObject" ? (service === "ship" ? "ship" : "manager") : String(args[0]), notifications: [] };
    },
    async callBoundMethod(service, method, args, kwargs, fields, sessionID, handle) {
      if (method === "List") return { result: list(handle === "60" ? world.hangar : []), notifications: [] };
      if (method === "ListByFlags") return { result: list(handle === "71" ? world.fitted : []), notifications: [] };
      world.sent.push([`${service}.${method}`, args]);
      if (method === "Board") { world.ship = 71; return { result: null, notifications: [] }; }
      assert.equal(method, "FitFitting");
      world.hangar.find((each) => each.itemID === 80).quantity -= 1;
      world.fitted.push(item(81, 2, 1, 71, 27, 1));
      return { result: null, notifications: [] };
    },
  };
  return world;
}

test("a ship being made whose step was not proven: the page's look answers READY once the step is there, with the hull it proved, and the page goes on from it to the finished ship", { timeout: 20000 }, async () => {
  const world = hullWorld();
  const { api, page } = await cockpit(world);
  world.assemble = "lost";
  const review = await api.reviewShipProvisioning(SUPPLIES, null, page.options);
  assert.equal(review.canApply, true, JSON.stringify(review.plan));
  const blocked = await api.provisionShip(review.reviewID, review.reviewHash, page.options);
  assert.deepEqual([blocked.state, blocked.reason, blocked.manifest.targetHullID], ["BLOCKED", "OUTCOME_AMBIGUOUS", null]);
  assert.deepEqual(world.sent, [["ship.AssembleShip", [[70], "", null]]]);
  const row = (await api.provisioningOptions(null, page.options)).pending[0];
  assert.deepEqual(row, { operationID: blocked.operationID, state: "BLOCKED", kind: "SHIP_PROVISION", input: SUPPLIES });

  // Looked at while no hull has been assembled: blocked still, and the panel goes no further (it wants READY).
  page.paths.length = 0;
  page.bodies.length = 0;
  const still = await api.reconcileProvisioning(row.operationID, page.options);
  assert.deepEqual([still.operationID, still.state, still.reason, still.result, still.manifest.targetHullID],
    [blocked.operationID, "BLOCKED", "OUTCOME_AMBIGUOUS", null, null]);
  assert.deepEqual([page.paths, page.bodies], [["POST /api/bridge/provisioning/reconcile"], [{ operationID: blocked.operationID }]]);

  // The server assembled it after all. Looked at again: the new hull is the one proven, and the ship may go on.
  world.assembleNow();
  const ready = await api.reconcileProvisioning(row.operationID, page.options);
  assert.deepEqual([ready.operationID, ready.state, ready.reason, ready.result, ready.manifest.targetHullID, ready.manifest.originalShipID],
    [blocked.operationID, "READY", null, null, 71, 50]);
  // Looked at again while nothing has changed, it is ready still.
  assert.deepEqual(await api.reconcileProvisioning(row.operationID, page.options), ready);
  assert.equal(world.sent.length, 1);

  // As the panel goes on (continueShip): its options for the row's provider, the plan asked again for the same
  // operation, and the plan applied. The hull is boarded and fitted, and nothing is assembled a second time.
  const options = await api.provisioningOptions(row.input.providerCharacterID, page.options);
  assert.equal(options.pending[0].state, "READY");
  const plan = await api.reviewShipProvisioning({ providerCharacterID: row.input.providerCharacterID, corporationID: options.definitionCorporationID,
    fittingID: row.input.fittingID, source: row.input.source }, row.operationID, page.options);
  assert.deepEqual([plan.canApply, plan.plan.mode, plan.plan.targetHullID], [true, "CONTINUE", 71]);
  const done = await api.provisionShip(plan.reviewID, plan.reviewHash, page.options);
  assert.deepEqual([done.operationID, done.state, done.result.equipment, done.manifest.targetHullID], [blocked.operationID, "COMPLETE", "VERIFIED", 71]);
  assert.deepEqual(world.sent.map(([name]) => name), ["ship.AssembleShip", "ship.Board", "invbroker.FitFitting"]);
  assert.deepEqual((await api.provisioningOptions(null, page.options)).pending, []);
});

test("a ship being made: a look at one that is another pilot's is refused, and one the world no longer agrees with is refused and blocked by name", { timeout: 20000 }, async () => {
  const world = hullWorld();
  const { api, page, other } = await cockpit(world);
  world.assemble = "lost";
  const review = await api.reviewShipProvisioning(SUPPLIES, null, page.options);
  const blocked = await api.provisionShip(review.reviewID, review.reviewHash, page.options);
  assert.equal(blocked.state, "BLOCKED");
  await assert.rejects(api.reconcileProvisioning(blocked.operationID, other.options), refused(409, "OPERATION_NOT_OWNED"));
  // The hull was assembled, and a module was put in it by another hand before the look: a new hull is to be empty.
  world.assembleNow();
  world.fitted.push({ itemID: 81, typeID: 2, quantity: 1, locationID: 71, flagID: 27, singleton: 1, ownerID: 10 });
  await assert.rejects(api.reconcileProvisioning(blocked.operationID, page.options), refused(409, "ASSEMBLED_HULL_NOT_EMPTY"));
  assert.deepEqual((await api.provisioningOptions(null, page.options)).pending.map((each) => each.state), ["BLOCKED"]);
  assert.equal(world.sent.length, 1);
});

test("the account catalog reads the provider's fittings without selecting or reserving the pilot", async () => {
  const reads = [];
  const pilots = [
    { accountID: 7, characterID: 10, characterName: "Hauler", corporationID: 20 },
    { accountID: 7, characterID: 11, characterName: "Provider", corporationID: 30 },
  ];
  const app = createApp({
    eveStore: { getAccount: async () => ({ username: "owner", accountID: 7 }),
      listCharactersForAccount: async id => pilots.filter(pilot => pilot.accountID === id) },
    webAuth: { verifySessionToken: token => token === COCKPIT ? { username: "owner", accountID: 7, sessionID: "tab" } : null },
    staticData, eveGatewayClient: {
      async callMethod(service, method, args, kwargs, fields, handle) {
        reads.push([service, method, fields.userid, fields.characterID, fields.corpid, handle]);
        return { result: { type: "dict", entries: [fitting(4, fields.corpid, "Fleet fit", [[2, 27, 1]])] } };
      },
    },
  });
  const route = (pilot, provider) => "/api/ship-provisioning/review?characterID=" + pilot + "&providerCharacterID=" + provider + "&fittingID=0";
  const read = path => dispatchInProcess(app, { path, headers: { authorization: "Bearer " + COCKPIT } });
  const result = await read(route(10, 11));
  assert.equal(result.status, 200, result.body);
  const catalog = JSON.parse(result.body);
  const { pilot, candidateSource, definitions } = catalog;
  assert.equal(catalog.ok, true);
  assert.equal(Object.hasOwn(catalog, "applyReview"), false);
  assert.equal(Object.hasOwn(catalog, "pendingApply"), false);
  assert.deepEqual(pilot, { characterID: 10, name: "Hauler", corporationID: 20 });
  assert.deepEqual(candidateSource, { kind: "hangar", quality: "PENDING_SELECTED", query: "UNKNOWN", take: "UNKNOWN" });
  assert.equal(definitions.status, "READY");
  assert.equal(definitions.providerCharacterID, 11);
  assert.equal(definitions.corporationID, 30);
  assert.equal(definitions.contracts[0].name, "Fleet fit");
  assert.equal(definitions.contracts[0].definition.fittingID, 4);
  assert.match(definitions.contracts[0].definition.fingerprint, /^[0-9a-f]{64}$/);

  assert.equal((await read(route(10, 11).replace("fittingID=0", "fittingID=4"))).status, 404);
  const foreignPilot = await read(route(21, 11));
  assert.equal(foreignPilot.status, 409);
  assert.equal(JSON.parse(foreignPilot.body).error, "CHARACTER_NOT_FOUND");
  const foreignProvider = JSON.parse((await read(route(10, 21))).body).definitions;
  assert.equal(foreignProvider.status, "NOT_OWNED");
  assert.deepEqual(foreignProvider.contracts, []);
  assert.equal((await dispatchInProcess(app, { path: route(10, 11) })).status, 401);
  assert.deepEqual(reads, [["corpFittingMgr", "GetFittings", 7, 11, 30, undefined]]);
  assert.equal(app.locals.bridgeSessions.size, 0);
});

test("retired Center endpoints return 404 and an interrupted Center journal leaves the pilot free on restart", async t => {
  const journal = path.join(DATA, "provisioning-center-control.json");
  const pin = { accountID: 7, characterID: 11 };
  const saved = JSON.stringify({ version: 1, records: { old: {
    kind: "CENTER_APPLY", ...pin, state: "RELEASING", pin, reviewHash: hash(pin), input: {}, release: { state: "UNVERIFIED" },
  } } });
  fs.writeFileSync(journal, saved, { flag: "wx" });
  t.after(() => fs.unlinkSync(journal));
  const app = createApp({ eveGatewayClient: {} });
  const engine = app.locals.replenishment;
  const finish = engine.enterWrite(pin.characterID);
  assert.throws(() => engine.assertSelectable(pin.characterID), { code: "CHARACTER_IN_USE" });
  finish();
  engine.assertSelectable(pin.characterID);
  assert.equal(fs.readFileSync(journal, "utf8"), saved);
  assert.equal(app.locals.provisioningCenterApply, undefined);

  const paths = [
    ["GET", "/ship-provisioning"], ["GET", "/ship-provisioning/"], ["GET", "/ship-provisioning/old"],
    ["GET", "/api/ship-provisioning/roster"], ["GET", "/api/ship-provisioning/operation?operationID=old"],
    ["POST", "/api/ship-provisioning/login"], ["POST", "/api/ship-provisioning/apply"], ["POST", "/api/ship-provisioning/recover"],
  ];
  for (const [method, path] of paths) {
    assert.equal((await dispatchInProcess(app, { method, path })).status, 404, method + " " + path);
  }
});
