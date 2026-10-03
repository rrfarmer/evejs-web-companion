"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { registerProvisioningRoutes } = require("./provisioningRoutes");
const { createReplenishment } = require("./replenishment");
const { createPilotMutationFence } = require("./pilotMutationFence");
const types = { 1: { categoryID: 6, groupID: 25 }, 2: { categoryID: 7 }, 3: { categoryID: 8, groupID: 83, volume: .01 },
  4: { categoryID: 2, groupID: 12 }, 6: { categoryID: 4, groupID: 1136 } };
const data = { getType: id => types[id], getTypeName: id => `Type ${id}` };
const wireList = items => ({ type: "list", items });
const wireObject = fields => ({ type: "object", args: { type: "dict", entries: Object.entries(fields) } });
function fixture() {
  const routes = new Map(), operations = new Map();
  const held = { accountID: 7, characterID: 10, corporationID: 30, activeShipID: 50, stationID: 60, bridgeSessionID: "own-generation" };
  const state = { writes: [], date: "100", stock: 4000, aboard: 3200, take: true, query: true, incomplete: false,
    providerCalls: [], sourceReads: [], failAfter: false };
  const engine = createReplenishment({ operations, data });
  engine.withTemporaryControl = () => { throw new Error("Held provisioning must not acquire temporary Factory control."); };
  const mutationFence = createPilotMutationFence({ heldSessions: new Map([["tab", held]]), assertWritable: engine.assertWritable });
  const row = (itemID, typeID, quantity, locationID, flagID, ownerID = 10, singleton = 0) =>
    ({ itemID, typeID, quantity, locationID, flagID, ownerID, singleton });
  function items(key, flag) {
    if (key === "ship") return [row(70, 2, 1, 50, 27, 10, 1), row(90, 3, state.aboard, 50, 5), row(91, 6, 7, 50, 5)]
      .filter(r => flag === undefined || r.flagID === flag);
    if (key === "hangar") return [row(50, 1, 1, 60, 4, 10, 1), row(300, 4, -1, 60, 4, 10, 1),
      ...(state.stock ? [row(100, 3, state.stock, 60, 4)] : [])];
    if (key === "corp") return state.stock ? [row(100, 3, state.stock, 777, 115, 30)] : [];
    if (key === "container") return state.stock ? [row(100, 3, state.stock, 300, 0)] : [];
    throw new Error(`unexpected inventory ${key}`);
  }
  const gateway = mutationFence.wrap({
    selectFactoryCharacter() { throw new Error("Held provisioning must not select a Factory pilot."); },
    selectCharacter() { throw new Error("Held provisioning must not select or take over a pilot."); },
    releaseBridgeSession() { throw new Error("Held provisioning must keep the cockpit pilot selected."); },
    async callMethod(service, method, args, kwargs, fields, bridgeSessionID) {
      assert.equal(service, "corpFittingMgr"); assert.equal(method, "GetFittings"); assert.equal(bridgeSessionID, undefined);
      state.providerCalls.push(fields);
      return { result: { type: "dict", entries: [[4, wireObject({ fittingID: 4, ownerID: fields.corpid, shipTypeID: 1,
        name: "Exact", savedDate: { type: "long", value: state.date }, fitData: wireList([
          { type: "tuple", items: [2, 27, 1] }, { type: "tuple", items: [3, 5, 5000] }]) })]] } };
    },
    async callBoundMethod(service, method, args, kwargs, fields, bridgeSessionID, spec) {
      assert.equal(bridgeSessionID, held.bridgeSessionID);
      if (method === "GetCapacity") return { result: { capacity: args[0] === 5 ? 10000 : 0, used: 0 } };
      if (method === "ListByFlags") return { result: state.incomplete ? null : wireList(items("ship")) };
      if (method === "List") { state.sourceReads.push(spec.key); return { result: wireList(items(spec.key, args[0])) }; }
      assert.equal(method, "Add"); assert.equal(spec.expectedShipID, 50); assert.equal(spec.expectedDockedLocationID, 60);
      assert.equal(args.length, 2); assert.ok(Number.isSafeInteger(kwargs.qty) && kwargs.qty > 0);
      assert.equal(kwargs.flag, 5); state.writes.push([...args, kwargs.qty]);
      assert.throws(() => engine.assertWritable(10), { code: "REPLENISHMENT_CUSTODY" });
      state.stock -= kwargs.qty; state.aboard += kwargs.qty;
      if (state.failAfter) throw Object.assign(new Error("timeout after commit"), { code: "TIMEOUT" });
      return { result: null };
    },
  });
  const resolvePlace = async (_held, _session, descriptor) => {
    if (descriptor.kind === "hangar") return { spec: { key: "hangar" }, flag: 4, locationID: 60 };
    if (descriptor.kind === "cargo") return { spec: { key: "ship" }, flag: 5, locationID: 50 };
    if (descriptor.kind === "shipBay") return { spec: { key: "ship" }, flag: 143, locationID: 50 };
    if (descriptor.kind === "container") return { spec: { key: "container" }, flag: 0, locationID: descriptor.itemID };
    if (descriptor.kind === "corp") {
      assert.equal(descriptor.division, 1); return { spec: { key: "corp" }, flag: 115, locationID: null };
    }
    throw new Error("invalid descriptor");
  };
  const registered = registerProvisioningRoutes({ app: { get: (p, ...fns) => routes.set(`GET ${p}`, fns), post: (p, ...fns) => routes.set(`POST ${p}`, fns) },
    requireAuth: (_req, _res, next) => next(), requireHeld: () => held, engine, data, gateway,
    store: { listCharactersForAccount: async () => [{ accountID: 7, characterID: 10, corporationID: 30, characterName: "Current" },
      { accountID: 7, characterID: 11, corporationID: 20, characterName: "Provider" },
      { accountID: 7, characterID: 12, corporationID: 30, characterName: "Other cockpit pilot" }] },
    flight: async () => ({ flight: { docked: true, shipID: held.activeShipID, shipTypeID: 1 } }),
    currentHeld: () => {}, inventoryLocation: () => held.stationID, pendingRecovery: () => false,
    resolvePlace, cargoBindSpec: () => ({ key: "ship" }), slots: () => [27], shipBays: () => [{ key: "ammo", flag: 143, label: "Ammo" }],
    capacity: raw => raw, mutationFence,
    boundCall: (_held, _session, spec, method, args, kwargs) => gateway.callBoundMethod("invbroker", method, args, kwargs, {}, held.bridgeSessionID, spec),
    heldCall: async (_held, _session, _service, method) => ({ result: method === "GetMember" ? wireObject({ characterID: 10,
      corporationID: 30, roles: "0", rolesAtHQ: String((state.query ? 1048576 : 0) | (state.take ? 8192 : 0)), rolesAtBase: "0", rolesAtOther: "0", baseID: 0, titleMask: 0 }) :
      wireObject({ corporationID: 30, stationID: 60 }) }),
  });
  async function invoke(name, body = {}, method = "POST", query = {}) {
    const req = { body, query, webSessionID: "tab", account: { accountID: 7 } }, res = { json: value => { res.body = value; } };
    const fns = routes.get(`${method} /api/bridge/provisioning/${name}`);
    assert.ok(fns); await fns[0](req, res, error => { if (error) throw error; });
    await fns[1](req, res, error => { throw error; }); return res.body;
  }
  const input = { providerCharacterID: 11, corporationID: 20, fittingID: 4, source: { kind: "hangar" } };
  return { state, held, engine, operations, invoke, input,
    adapter: () => registered.adapter({ webSessionID: "tab", account: { accountID: 7 } }, held) };
}
test("route consumer separates provider from physical authority and routes deficits into ordinary cargo", async () => {
  const f = fixture();
  const options = await f.invoke("options", {}, "GET", { providerCharacterID: "11" });
  assert.equal(options.definitionCorporationID, 20); assert.equal(options.corporationID, 30);
  assert.deepEqual(options.containers, [{ itemID: 300, name: "Type 4", location: "Personal hangar" }]);
  const review = await f.invoke("review", f.input);
  assert.equal(review.status.equipment, "VERIFIED"); assert.equal(review.status.targets[0].deficit, 1800); assert.equal(f.state.writes.length, 0);
  const request = { reviewID: review.reviewID, reviewHash: review.reviewHash, confirm: true };
  const result = await f.invoke("replenish", request);
  assert.equal(result.state, "COMPLETE"); assert.equal(result.result.supplies, "FULL");
  assert.deepEqual(f.state.writes, [[100, 60, 1800]]);
  await f.invoke("replenish", request); assert.equal(f.state.writes.length, 1);
  assert.ok(f.state.providerCalls.every(fields => fields.characterID === 11 && fields.corpid === 20));
});

test("held Ship Review no-ops exact equipment, then shared Replenish fills its LOW supplies without acquiring another hull", async () => {
  const f = fixture();
  const review = await f.invoke("ship-review", { ...f.input, characterID: 12, shipID: 999,
    stationID: 999, sessionGeneration: "browser-selected-generation" });
  assert.equal(review.context.characterID, f.held.characterID);
  assert.equal(review.context.shipID, f.held.activeShipID);
  assert.equal(review.context.locationID, f.held.stationID);
  assert.equal(review.contract.definition.characterID, 11);
  assert.equal(review.status.equipment, "VERIFIED");
  assert.equal(review.status.supplies, "LOW");
  assert.equal(review.plan.mode, "ALREADY_SATISFIED");
  assert.equal(review.plan.hullQuantity, 0);
  assert.deepEqual(review.plan.steps, []);
  assert.equal(review.canApply, true);
  await assert.rejects(f.invoke("replenish", { ...review, confirm: true }), { code: "REVIEW_REQUIRED" });
  const result = await f.invoke("provision-ship", { reviewID: review.reviewID, reviewHash: review.reviewHash, confirm: true });
  assert.equal(result.state, "COMPLETE");
  assert.equal(result.result.alreadySatisfied, true);
  assert.equal(result.result.supplies, "LOW");
  assert.equal(result.manifest.targetHullID, 50);
  const record = f.engine.journal.get(review.reviewID);
  assert.equal(record.kind, "SHIP_PROVISION");
  assert.deepEqual(record.input, f.input);
  assert.deepEqual(record.actions, []);
  assert.deepEqual(record.moves, []);
  assert.deepEqual(f.state.writes, []);
  assert.equal(f.operations.size, 0);
  assert.equal((await f.invoke("provision-ship", { ...review, confirm: true })).result.alreadySatisfied, true);
  assert.deepEqual(f.state.writes, []);

  const replenishReview = await f.invoke("review", f.input);
  await assert.rejects(f.invoke("provision-ship", { ...replenishReview, confirm: true }), { code: "REVIEW_REQUIRED" });
  await f.invoke("replenish", { ...replenishReview, confirm: true });
  assert.deepEqual(f.state.writes, [[100, 60, 1800]]);
  assert.equal(f.engine.journal.get(replenishReview.reviewID).result.supplies, "FULL");
  assert.equal(f.held.characterID, 10);
  assert.equal(f.held.activeShipID, 50);
  assert.equal(f.held.bridgeSessionID, "own-generation");
  const full = await f.invoke("ship-review", f.input);
  assert.equal(full.status.supplies, "FULL");
  assert.equal((await f.invoke("provision-ship", { ...full, confirm: true })).result.alreadySatisfied, true);
  assert.deepEqual(f.state.writes, [[100, 60, 1800]]);
});

for (const [reviewRoute, applyRoute] of [["review", "replenish"], ["ship-review", "provision-ship"]]) {
  for (const change of ["generation", "hosted claim", "pilot", "ship", "station"])
    test(`held ${applyRoute} rejects ${change} drift after ${reviewRoute} with no mutation or custody`, async () => {
      const f = fixture(), review = await f.invoke(reviewRoute, f.input);
      if (change === "generation") f.held.bridgeSessionID = "replacement-generation";
      if (change === "hosted claim") f.held.botClaimSecret = "replacement-hosted-claim";
      if (change === "pilot") f.held.characterID = 12;
      if (change === "ship") f.held.activeShipID = 51;
      if (change === "station") f.held.stationID = 61;
      const refusal = applyRoute === "provision-ship" ?
        { pilot: "SOURCE_IDENTITY_UNKNOWN", station: "HANGAR_IDENTITY_UNKNOWN" }[change] : null;
      await assert.rejects(f.invoke(applyRoute, { reviewID: review.reviewID, reviewHash: review.reviewHash, confirm: true }),
        { code: refusal || "REVIEW_REQUIRED" });
      assert.deepEqual(f.state.writes, []);
      assert.equal(f.engine.journal.list().length, 0);
      assert.equal(f.operations.size, 0);
    });
}

test("held Ship Review preserves denied corporation source authority while exact equipment remains a no-op", async () => {
  const f = fixture();
  f.input.source = { kind: "corp", corporationID: 30, division: 1 };
  f.state.take = false;
  const review = await f.invoke("ship-review", f.input);
  assert.equal(review.plan.mode, "ALREADY_SATISFIED");
  assert.equal(review.source.access.take, false);
  const result = await f.invoke("provision-ship", { ...review, confirm: true });
  assert.equal(result.result.alreadySatisfied, true);
  assert.deepEqual(f.state.writes, []);
  assert.equal(f.engine.journal.get(review.reviewID).sourcePin.locationID, 777);
  // Ship Review also reads personal hangar to validate hull candidates. It must
  // not replace the explicitly selected corporation source with those rows.
  assert.equal(f.engine.journal.get(review.reviewID).sourcePin.descriptor.kind, "corp");
  f.state.query = false;
  await assert.rejects(f.invoke("ship-review", f.input), { code: "CORPORATION_QUERY_DENIED" });
  assert.deepEqual(f.state.writes, []);
});
test("strict corporation source pins real office row location and Query never implies Take or personal fallback", async () => {
  const f = fixture(); f.input.source = { kind: "corp", corporationID: 30, division: 1 }; f.state.take = false;
  const review = await f.invoke("review", f.input); assert.equal(review.canApply, false);
  await assert.rejects(f.invoke("replenish", { ...review, confirm: true }), { code: "SOURCE_TAKE_DENIED" });
  const refused = f.engine.journal.get(review.reviewID);
  assert.equal(refused.state, "REFUSED"); assert.equal(refused.reason, "SOURCE_TAKE_DENIED");
  assert.deepEqual(refused.moves, []); assert.equal(refused.sourcePin.locationID, 777);
  assert.equal(f.state.writes.length, 0); assert.ok(f.state.sourceReads.every(key => key !== "hangar"));
  f.state.take = true;
  const accepted = await f.invoke("review", f.input);
  await f.invoke("replenish", { ...accepted, confirm: true }); assert.deepEqual(f.state.writes, [[100, 777, 1800]]);
  f.input.source.corporationID = 20;
  await assert.rejects(f.invoke("review", f.input), { code: "CORPORATION_SOURCE_CHANGED" });
});
test("Review stores only the declared contract fields, excluding browser credential additions", async () => {
  const f = fixture();
  const review = await f.invoke("review", { ...f.input, sessionToken: "browser-secret", password: "password-secret",
    source: { ...f.input.source, authorization: "source-secret", sessionGeneration: "browser-generation" } });
  await f.invoke("replenish", { ...review, confirm: true });
  const persisted = f.engine.journal.get(review.reviewID);
  assert.deepEqual(persisted.input, f.input);
  assert.deepEqual(persisted.sourcePin.descriptor, f.input.source);
  assert.equal(/browser-secret|password-secret|source-secret|browser-generation/.test(JSON.stringify(persisted)), false);
});
test("selected local owned container is revalidated; foreign or non-container IDs are refused", async () => {
  const f = fixture(); f.input.source = { kind: "container", itemID: 300 };
  const review = await f.invoke("review", f.input);
  await f.invoke("replenish", { ...review, confirm: true }); assert.deepEqual(f.state.writes, [[100, 300, 1800]]);
  f.input.source.itemID = 100;
  await assert.rejects(f.invoke("review", f.input), { code: "CONTAINER_NOT_LOCAL_OWNED" });
});
test("empty corporate stock after a partial transfer retains the pinned contents location and reports LOW", async () => {
  const f = fixture(); f.state.stock = 1000; f.input.source = { kind: "corp", corporationID: 30, division: 1 };
  const review = await f.invoke("review", f.input);
  const result = await f.invoke("replenish", { ...review, confirm: true });
  assert.equal(result.state, "COMPLETE"); assert.equal(result.result.equipment, "VERIFIED");
  assert.equal(result.result.targets[0].deficit, 800); assert.equal(result.result.supplies, "LOW");
});

test("fresh selected adapter retains an accepted physical corporation source when another member emptied its stock", async () => {
  const f = fixture(); f.input.source = { kind: "corp", corporationID: 30, division: 1 };
  const accepted = (await f.adapter().read(f.input)).source.pin;
  assert.equal(accepted.locationID, 777);
  f.state.stock = 0;
  assert.equal((await f.adapter().read(f.input)).source.pin.locationID, null, "a fresh adapter has no earlier listed location");
  const selected = f.adapter();
  const read = await selected.read(f.input, accepted);
  assert.deepEqual(read.source.rows, []);
  assert.deepEqual(read.source.pin, accepted);
  const review = await f.engine.review({ ...selected, read: input => selected.read(input, accepted) }, f.input);
  assert.equal(review.status.equipment, "VERIFIED"); assert.equal(review.status.supplies, "LOW");
  assert.equal(review.source.pin.locationID, 777); assert.equal(review.source.access.take, true);
  assert.ok(f.state.sourceReads.every(key => key === "corp"));
  assert.deepEqual(f.state.writes, []); assert.deepEqual(f.engine.journal.list(), []);

  for (const change of [{ office: "another-office" }, { descriptor: { kind: "hangar" } },
    { descriptor: { ...accepted.descriptor, division: 2 } }, { ownerID: 10 }, { flag: 116 }, { dockedLocationID: 61 }]) {
    const wrong = await f.adapter().read(f.input, { ...accepted, ...change });
    assert.equal(wrong.source.pin.locationID, null, `foreign physical source must not prime: ${JSON.stringify(change)}`);
  }
  f.state.query = false;
  await assert.rejects(f.adapter().read(f.input, accepted), { code: "CORPORATION_QUERY_DENIED" });
  assert.deepEqual(f.state.writes, []);
});
test("unknown inventory, changed generation/date and other operation prevent route mutation", async () => {
  const f = fixture(); f.state.incomplete = true;
  const unknown = await f.invoke("review", f.input); assert.equal(unknown.status.equipment, "UNKNOWN"); assert.equal(unknown.canApply, false);
  f.state.incomplete = false;
  let review = await f.invoke("review", f.input); f.state.date = "101";
  await assert.rejects(f.invoke("replenish", { ...review, confirm: true }), { code: "REVIEW_REQUIRED" });
  review = await f.invoke("review", f.input); f.held.bridgeSessionID = "new-generation";
  await assert.rejects(f.invoke("replenish", { ...review, confirm: true }), { code: "REVIEW_REQUIRED" });
  review = await f.invoke("review", f.input); f.operations.set(10, Symbol("other operation"));
  await assert.rejects(f.invoke("replenish", { ...review, confirm: true }), { code: "CHARACTER_IN_USE" });
  assert.equal(f.state.writes.length, 0);
});
test("route error after commit is proven by exact readback; structures and foreign providers refuse", async () => {
  const f = fixture(); f.state.failAfter = true;
  await f.invoke("replenish", { ...await f.invoke("review", f.input), confirm: true });
  assert.equal(f.state.writes.length, 1);
  f.held.structureID = 999;
  await assert.rejects(f.invoke("review", f.input), { code: "PROVISIONING_STATION_ONLY" });
  delete f.held.structureID; f.input.providerCharacterID = 12;
  await assert.rejects(f.invoke("review", f.input), { code: "FITTING_SOURCE_CHANGED" });
});
