"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wc-ship-http-"));
process.env.EVEJS_WEB_POC_DATA_DIR = root;
const { createApp } = require("./server");
const object = fields => ({ type: "object", args: { type: "dict", entries: Object.entries(fields) } });
const list = items => ({ type: "list", items });
test("HTTP new-hull plan, board fence and partial fitting readback use the shared custody engine", { timeout: 5000 }, async t => {
  const journal = path.join(root, "custody.json"); let server, releaseBoard, boardStarted;
  const dispatched = new Promise(r => { boardStarted = r; }), boardGate = new Promise(r => { releaseBoard = r; });
  t.after(async () => { releaseBoard(); if (server?.listening) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const held = { accountID: 7, characterID: 10, corporationID: 20, activeShipID: 50, stationID: 60,
    bridgeSessionID: "held-1", boundHandles: new Map(), streamSubscribers: new Set(), droneRecoveryReady: true };
  const item = (itemID, typeID, quantity, locationID, flagID, singleton = 0) => ({ itemID, typeID, quantity, locationID, flagID, singleton, ownerID: 10 });
  const hangar = [item(50, 99, 1, 60, 4, 1), item(70, 1, 3, 60, 4), item(80, 2, 2, 60, 4)], fitted = [];
  let currentShip = 50, fittings = 0;
  const pending = kind => { const row = Object.values(JSON.parse(fs.readFileSync(journal)).records).find(r => r.state === "PENDING");
    assert.equal(row.actions.at(-1).kind, kind); assert.equal(row.actions.at(-1).state, "PENDING"); };
  const gateway = {
    selectFactoryCharacter() { throw new Error("Held Provision Ship must never select a Factory pilot."); },
    selectCharacter() { throw new Error("Held Provision Ship must never select or take over a pilot."); },
    releaseBridgeSession() { throw new Error("Held Provision Ship must retain the cockpit session."); },
    async readFlightStatus() { return { flight: { docked: true, stationID: 60, shipID: currentShip, shipTypeID: currentShip === 50 ? 99 : 1 }, notifications: [] }; },
    async callMethod(service, method, args) {
      if (method === "AssembleShip") { pending("ASSEMBLE_HULL"); assert.deepEqual(args, [[70], "", null]); hangar[1].quantity--; hangar.push(item(71, 1, 1, 60, 4, 1)); return { result: null, notifications: [] }; }
      assert.equal(service, "corpFittingMgr"); assert.equal(method, "GetFittings");
      return { result: { type: "dict", entries: [[4, object({ fittingID: 4, ownerID: 20, shipTypeID: 1, name: "Strict new hull", savedDate: "100",
        fitData: list([{ type: "tuple", items: [2, 27, 1] }]) })]] }, notifications: [] };
    },
    async bindObject(service, method, args) { return { boundHandle: method === "MachoBindObject" ? service === "ship" ? "ship" : "manager" : String(args[0]), notifications: [] }; },
    async callBoundMethod(service, method, args, kwargs, fields, sessionID, handle) {
      if (method === "List") return { result: list(handle === "60" ? hangar : []), notifications: [] };
      if (method === "ListByFlags") return { result: list(handle === "71" ? fitted : []), notifications: [] };
      if (method === "Board") { pending("BOARD_HULL"); assert.deepEqual(args, [71, 50]); boardStarted(); await boardGate; currentShip = 71; return { result: null, notifications: [] }; }
      assert.equal(method, "FitFitting"); pending("FIT_ITEM");
      assert.deepEqual(args, [71, null, { 2: [80] }, 60, { 27: 2 }, {}, false]);
      hangar.find(r => r.itemID === 80).quantity--; fitted.push(item(81, 2, 1, 71, 27, 1)); fittings++;
      throw Object.assign(new Error("Failure after fitting committed"), { code: "TEST_PARTIAL_FITTING" });
    } };
  const heldSessions = new Map([["tab", held]]);
  const app = createApp({ eveGatewayClient: gateway, replenishmentJournalPath: journal, bridgeSessionStore: heldSessions, errorLogger: () => {},
    eveStore: { getAccount: async () => ({ accountID: 7, username: "test", banned: false }),
      listCharactersForAccount: async () => [10, 11].map(characterID => ({ accountID: 7, characterID, corporationID: 20 })) },
    webAuth: { verifySessionToken: token => token === "test-token" ? { accountID: 7, username: "test", sessionID: "tab" } : null },
    staticData: { getType: id => ({ 1: { categoryID: 6, groupID: 25 }, 99: { categoryID: 6, groupID: 25 }, 2: { categoryID: 7 } })[id], getTypeName: id => `Type ${id}` } });
  server = http.createServer(app); await new Promise(r => server.listen(0, "127.0.0.1", r));
  const request = async (route, body) => { const res = await fetch(`http://127.0.0.1:${server.address().port}/api/bridge/${route}`, { method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json", connection: "close" }, body: JSON.stringify(body) }); return { status: res.status, ...await res.json() }; };
  const review = await request("provisioning/ship-review", { providerCharacterID: 11, corporationID: 20, fittingID: 4, source: { kind: "hangar" } });
  assert.equal(review.canApply, true, JSON.stringify(review)); assert.equal(review.plan.hullQuantity, 1);
  const applyBody = { confirm: true, reviewID: review.reviewID, reviewHash: review.reviewHash };
  const initialHangar = structuredClone(hangar);
  held.bridgeSessionID = "held-2";
  const changedGeneration = await request("provisioning/provision-ship", applyBody);
  assert.equal(changedGeneration.status, 409); assert.equal(changedGeneration.error, "REVIEW_REQUIRED");
  held.bridgeSessionID = "held-1";
  heldSessions.set("tab", { ...held, characterID: 11, bridgeSessionID: "other-pilot" });
  const changedPilot = await request("provisioning/provision-ship", applyBody);
  assert.equal(changedPilot.status, 409); assert.equal(changedPilot.error, "SOURCE_IDENTITY_UNKNOWN");
  heldSessions.delete("tab");
  const noHeld = await request("provisioning/provision-ship", applyBody);
  assert.equal(noHeld.status, 409); assert.equal(noHeld.error, "NO_LIVE_SESSION");
  heldSessions.set("tab", held);
  assert.deepEqual(hangar, initialHangar); assert.deepEqual(fitted, []);
  assert.equal(currentShip, 50); assert.equal(fittings, 0); assert.equal(fs.existsSync(journal), false);
  const applying = request("provisioning/provision-ship", applyBody);
  await Promise.race([dispatched, applying.then(r => { throw new Error(`Board did not dispatch: ${JSON.stringify(r)}`); })]);
  assert.equal((await request("inventory/stack", { target: "hangar" })).error, "REPLENISHMENT_CUSTODY");
  releaseBoard(); const result = await applying; assert.equal(result.state, "COMPLETE", JSON.stringify(result));
  assert.equal(result.result.equipment, "VERIFIED"); assert.equal(currentShip, 71); assert.equal(fittings, 1);
  const record = JSON.parse(fs.readFileSync(journal)).records[review.reviewID]; assert.equal(record.actions[2].error, "TEST_PARTIAL_FITTING");
  assert.ok(record.actions.every(a => a.state === "VERIFIED"));
});
