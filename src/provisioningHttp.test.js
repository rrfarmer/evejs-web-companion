"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http"), net = require("node:net");
// Importing server creates its non-listening default app. Isolate all WC data;
// every gateway method used below is a fake, with no EveJS network access.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wc-provision-http-"));
process.env.EVEJS_WEB_POC_DATA_DIR = scratch;
const { createApp } = require("./server");
const object = fields => ({ type: "object", args: { type: "dict", entries: Object.entries(fields) } });
const list = items => ({ type: "list", items });

test("authenticated HTTP Review/Replenish uses real parsers, bindings and pilot fence; task listener is released", { timeout: 5000 }, async t => {
  let server, finishWrite, finishStack;
  t.after(async () => {
    finishWrite?.();
    finishStack?.();
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert.equal(server?.listening, false);
    assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const held = { accountID: 7, characterID: 10, corporationID: 20, activeShipID: 50, stationID: 60,
    bridgeSessionID: "test-only-held", boundHandles: new Map(), streamSubscribers: new Set(), droneRecoveryReady: true };
  const state = { stock: 4000, aboard: 3200, writes: 0, releases: 0, free: false, guardedSelections: 0 };
  const journalFile = path.join(scratch, "custody.json");
  let sent;
  const dispatched = new Promise(resolve => { sent = resolve; });
  const waitForFinish = new Promise(resolve => { finishWrite = resolve; });
  let stackSent;
  const stacking = new Promise(resolve => { stackSent = resolve; });
  const waitForStack = new Promise(resolve => { finishStack = resolve; });
  const row = (itemID, typeID, qty, locationID, flagID, singleton = 0) => ({ type: "packedrow",
    fields: { itemID, typeID, quantity: qty, ownerID: 10, locationID, flagID, singleton } });
  const gateway = {
    async selectFactoryCharacter(accountID, characterID) {
      assert.equal(accountID, 7); assert.equal(characterID, 10); state.guardedSelections++;
      if (!state.free) throw Object.assign(new Error("busy pilot; no takeover"), { code: "CHARACTER_IN_USE", statusCode: 409 });
      return { bridgeSessionID: "restored-generation", session: { characterID: 10, characterName: "Pilot 10", corporationID: 20,
        stationID: 60, shipID: 50 }, notifications: [] };
    },
    selectCharacter() { throw new Error("Custody recovery must never fall back to takeover selection."); },
    async readFlightStatus() { return { flight: { shipID: 50, shipTypeID: 1, docked: true, stationID: 60, structureID: null }, notifications: [] }; },
    async callMethod(service, method, args, kwargs, fields, bridgeSessionID) {
      assert.equal(service, "corpFittingMgr"); assert.equal(method, "GetFittings"); assert.equal(fields.characterID, 11);
      assert.equal(bridgeSessionID, undefined);
      return { result: { type: "dict", entries: [[4, object({ fittingID: 4, ownerID: 20, shipTypeID: 1,
        name: "Exact", savedDate: { type: "long", value: "100" }, fitData: list([
          { type: "tuple", items: [2, 27, 1] }, { type: "tuple", items: [3, 5, 5000] }]) })]] } };
    },
    async bindObject(service, method, args) {
      assert.equal(service, "invbroker");
      assert.ok(["GetInventory", "GetInventoryFromId"].includes(method));
      return { boundHandle: args[0], notifications: [] };
    },
    async callBoundMethod(service, method, args, kwargs, fields, bridgeSessionID, handle) {
      assert.equal(service, "invbroker"); assert.ok([held.bridgeSessionID, "restored-generation"].includes(bridgeSessionID));
      if (method === "GetCapacity") return { result: object({ capacity: args[0] === 5 ? 10000 : 0, used: 0 }) };
      if (method === "ListByFlags") return { result: list([row(70, 2, -1, 50, 27, 1), row(90, 3, state.aboard, 50, 5)]) };
      if (method === "List") return { result: list(handle === 60 ? (state.stock ? [row(100, 3, state.stock, 60, 4)] : []) :
        args[0] === 5 ? [row(90, 3, state.aboard, 50, 5)] : []) };
      if (method === "StackAll") { stackSent(); await waitForStack; return { result: null, notifications: [] }; }
      assert.equal(method, "Add"); assert.deepEqual(args, [100, 60]); assert.deepEqual(kwargs, { flag: 5, qty: 1800 });
      assert.equal(Object.values(JSON.parse(fs.readFileSync(journalFile)).records)[0].state, "PENDING");
      state.stock -= kwargs.qty; state.aboard += kwargs.qty; state.writes++;
      sent(); await waitForFinish; return { result: null, notifications: [] };
    },
    async releaseBridgeSession() { state.releases++; return { released: true }; },
  };
  const appOptions = { eveStore: { getAccount: async () => ({ accountID: 7, username: "test", banned: false }),
    getCharacterForAccount: async () => ({ characterID: 10, characterName: "Pilot 10" }),
    listCharactersForAccount: async () => [10, 11].map(characterID => ({ accountID: 7, characterID, corporationID: 20, characterName: `Pilot ${characterID}` })) },
    eveGatewayClient: gateway, replenishmentJournalPath: journalFile, errorLogger: () => {},
    webAuth: { verifySessionToken: token => token === "test-token" ? { accountID: 7, username: "test", sessionID: "tab" } : null },
    staticData: { getType: id => ({ 1: { categoryID: 6 }, 2: { categoryID: 7 }, 3: { categoryID: 8, groupID: 83, volume: .01 } })[id],
      getTypeName: id => `Type ${id}`, getStation: () => ({ stationName: "Test station" }) },
  };
  const app = createApp({ ...appOptions, bridgeSessionStore: new Map([["tab", held]]) });
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  t.diagnostic(`Task-owned mock HTTP PID ${process.pid}, port ${port}; no gameplay gateway.`);
  const request = async (url, body, auth = true) => {
    const response = await fetch(base + url, { method: body ? "POST" : "GET", headers: {
      "content-type": "application/json", connection: "close", ...(auth ? { authorization: "Bearer test-token" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request("/api/bridge/provisioning/options", null, false)).status, 401);
  const options = await request("/api/bridge/provisioning/options?providerCharacterID=11");
  assert.equal(options.status, 200, JSON.stringify(options.body));
  const review = await request("/api/bridge/provisioning/review", { providerCharacterID: 11, corporationID: 20, fittingID: 4, source: { kind: "hangar" } });
  assert.equal(review.status, 200, JSON.stringify(review.body)); assert.equal(review.body.status.targets[0].deficit, 1800);
  const applyBody = { reviewID: review.body.reviewID, reviewHash: review.body.reviewHash, confirm: true };
  held.transition = { phase: "requested", kind: "dock" };
  assert.equal((await request("/api/bridge/provisioning/replenish", applyBody)).body.error, "SESSION_CHANGE_IN_PROGRESS");
  assert.equal(state.writes, 0); delete held.transition;
  const earlierWrite = request("/api/bridge/inventory/stack", { target: "hangar" });
  await Promise.race([stacking, earlierWrite.then(result => { throw new Error(`Stack returned before dispatch: ${JSON.stringify(result)}`); })]);
  const busy = await request("/api/bridge/provisioning/replenish", applyBody);
  assert.equal(busy.status, 409); assert.equal(busy.body.error, "CHARACTER_IN_USE"); assert.equal(state.writes, 0);
  finishStack(); assert.equal((await earlierWrite).status, 200);
  const pending = request("/api/bridge/provisioning/replenish", applyBody);
  await Promise.race([dispatched, pending.then(result => { throw new Error(`Apply returned before dispatch: ${JSON.stringify(result)}`); })]);
  const conflict = await request("/api/bridge/release", {});
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error, "REPLENISHMENT_CUSTODY"); assert.equal(state.releases, 0);
  finishWrite(); const result = await pending;
  assert.equal(result.status, 200); assert.equal(result.body.result.supplies, "FULL");
  assert.equal((await request("/api/bridge/provisioning/replenish", applyBody)).status, 200); assert.equal(state.writes, 1);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  // Simulate process death after commit, before observation/persistence of its
  // result. A fresh app has no held pilot and must reopen only a free one.
  const disk = JSON.parse(fs.readFileSync(journalFile));
  const custody = disk.records[review.body.reviewID]; custody.state = "PENDING"; delete custody.result;
  custody.moves[0].state = "PENDING"; delete custody.moves[0].after;
  fs.writeFileSync(journalFile, JSON.stringify(disk));
  const restored = createApp({ ...appOptions, bridgeSessionStore: new Map() });
  server = http.createServer(restored); await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  assert.equal((await request("/api/bridge/select", { characterID: 10 })).body.error, "CHARACTER_IN_USE");
  state.free = true;
  assert.equal((await request("/api/bridge/select", { characterID: 10 })).status, 200);
  const recoveryOptions = await request("/api/bridge/provisioning/options?providerCharacterID=11");
  assert.equal(recoveryOptions.body.pending[0].operationID, review.body.reviewID);
  assert.equal((await request("/api/bridge/inventory/stack", { target: "hangar" })).body.error, "REPLENISHMENT_CUSTODY");
  const reconciled = await request("/api/bridge/provisioning/reconcile", { operationID: review.body.reviewID });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body)); assert.equal(reconciled.body.state, "RECONCILED");
  assert.equal(state.writes, 1); assert.equal(state.guardedSelections, 2);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await new Promise((resolve, reject) => {
    const probe = net.connect({ host: "127.0.0.1", port });
    probe.once("connect", () => { probe.destroy(); reject(new Error("Task listener was not released")); });
    probe.once("error", error => { if (error.code === "ECONNREFUSED") resolve(); else reject(error); });
  });
  t.diagnostic(`Task-owned port ${port} released.`);
});
