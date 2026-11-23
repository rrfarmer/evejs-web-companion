"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { registerProvisioningRoutes } = require("./provisioningRoutes");
const { createReplenishment } = require("./replenishment");
const { createPilotMutationFence } = require("./pilotMutationFence");
const types = { 1: { categoryID: 6, groupID: 25 }, 2: { categoryID: 7 }, 3: { categoryID: 8, groupID: 83, volume: .01 },
  4: { categoryID: 2, groupID: 12 }, 5: { categoryID: 18, volume: 5 }, 6: { categoryID: 4, groupID: 1136 },
  7: { categoryID: 7 }, 8: { categoryID: 32 } };
const wireList = items => ({ type: "list", items });
const wireObject = fields => ({ type: "object", args: { type: "dict", entries: Object.entries(fields) } });
function fixture(hull = null) {
  const routes = new Map(), operations = new Map();
  const held = { accountID: 7, characterID: 10, corporationID: 30, activeShipID: 50, stationID: 60, bridgeSessionID: "own-generation" };
  const division = hull ? 7 : 1, divisionFlag = 114 + division;
  const data = {
    getType: id => id === hull?.typeID ? { categoryID: 6, groupID: hull.groupID, published: hull.published ?? true } : types[id],
    getTypeDogmaAttribute: (id, attribute, fallback) => hull?.attributes?.[id]?.[attribute] ?? fallback,
    getTypeName: id => id === hull?.typeID ? hull.name : `Type ${id}`,
  };
  const state = { writes: [], date: "100", stock: 4000, aboard: 3200, take: true, query: true, incomplete: false,
    providerCalls: [], sourceReads: [], failAfter: false, duplicateFit: false, heldFittingCalls: [], heldFittingError: null,
    assembled: [], shipRows: [], shipActions: [], fitted: [] };
  const fitItems = hull ? [[2, 27, 1], [7, 92, 1], [3, 27, 1], ...(hull.subsystem ? [[8, 125, 1]] : []), ...(hull.spares ? [[3, 5, hull.spares]] : []), ...(hull.drones ? [[5, 87, hull.drones]] : [])]
    : [[2, 27, 1], [3, 5, 5000]];
  const library = owner => { const fit = id => [id, wireObject({ fittingID: id, ownerID: owner, shipTypeID: hull?.typeID ?? 1,
    name: "Exact", savedDate: { type: "long", value: state.date },
    fitData: wireList(fitItems.map(items => ({ type: "tuple", items }))) })];
    return { type: "dict", entries: [fit(4), ...(state.duplicateFit ? [fit(5)] : [])] }; };
  const engine = createReplenishment({ operations, data });
  engine.withTemporaryControl = () => { throw new Error("Held provisioning must not acquire temporary Factory control."); };
  const mutationFence = createPilotMutationFence({ heldSessions: new Map([["tab", held]]), assertWritable: engine.assertWritable });
  const row = (itemID, typeID, quantity, locationID, flagID, ownerID = 10, singleton = 0) =>
    ({ itemID, typeID, quantity, locationID, flagID, ownerID, singleton });
  const provisionStock = hull ? [
    row(101, hull.typeID, 1, 777, divisionFlag, 30),
    row(102, 2, 1, 777, divisionFlag, 30),
    row(103, 7, 1, 777, divisionFlag, 30),
    ...(hull.drones ? [row(104, 5, hull.drones, 777, divisionFlag, 30)] : []),
  ] : [];
  function withdrawStock(id, sourceID, quantity) {
    assert.equal(sourceID, 777);
    const index = provisionStock.findIndex(item => item.itemID === id);
    assert.ok(index >= 0, "the transfer uses exact reviewed corporate stock");
    const [item] = provisionStock.splice(index, 1);
    assert.equal(item.quantity, quantity);
    return item;
  }
  function items(key, flag, shipID) {
    if (hull && key === "ship" && shipID !== 50) {
      return state.shipRows.filter(r => r.locationID === shipID && (flag === undefined || r.flagID === flag));
    }
    if (key === "ship") return [row(70, 2, 1, 50, 27, 10, 1), row(90, 3, state.aboard, 50, 5), row(91, 6, 7, 50, 5)]
      .filter(r => flag === undefined || r.flagID === flag);
    if (key === "hangar") return [row(50, 1, 1, 60, 4, 10, 1), row(300, 4, -1, 60, 4, 10, 1),
      ...(state.stock ? [row(100, 3, state.stock, 60, 4)] : []), ...state.assembled];
    if (key === "corp") return [...(state.stock ? [row(100, 3, state.stock, 777, divisionFlag, 30)] : []), ...provisionStock];
    if (key === "container") return state.stock ? [row(100, 3, state.stock, 300, 0)] : [];
    throw new Error(`unexpected inventory ${key}`);
  }
  const gateway = mutationFence.wrap({
    async getSkills() { return { skills: [] }; },
    selectFactoryCharacter() { throw new Error("Held provisioning must not select a Factory pilot."); },
    selectCharacter() { throw new Error("Held provisioning must not select or take over a pilot."); },
    releaseBridgeSession() { throw new Error("Held provisioning must keep the cockpit pilot selected."); },
    async callMethod(service, method, args, kwargs, fields, bridgeSessionID) {
      assert.equal(service, "corpFittingMgr"); assert.equal(method, "GetFittings"); assert.equal(bridgeSessionID, undefined);
      state.providerCalls.push(fields);
      return { result: library(fields.corpid) };
    },
    async callBoundMethod(service, method, args, kwargs, fields, bridgeSessionID, spec) {
      assert.equal(bridgeSessionID, held.bridgeSessionID);
      if (method === "GetCapacity") return { result: { capacity: args[0] === 5 ? 10000 : 0, used: 0 } };
      if (method === "ListByFlags") return { result: state.incomplete ? null
        : wireList(items("ship", undefined, spec.shipID).filter(item => args[0].includes(item.flagID))) };
      if (method === "List") { state.sourceReads.push(spec.key); return { result: wireList(items(spec.key, args[0], spec.shipID)) }; }
      if (hull && method === "FitFitting") {
        const [shipID, , selected, sourceID, slots, , fitRigs] = args;
        const [[flag, typeID]] = Object.entries(slots);
        assert.equal(spec.key, "inventory-manager");
        assert.equal(spec.expectedShipID, held.activeShipID);
        assert.equal(spec.expectedDockedLocationID, held.stationID);
        assert.equal(shipID, held.activeShipID);
        assert.deepEqual(Object.keys(selected), [String(typeID)]);
        const [itemID] = selected[typeID];
        assert.deepEqual(selected[typeID], [itemID]);
        const item = withdrawStock(itemID, sourceID, 1);
        assert.equal(item.typeID, typeID);
        state.fitted.push({ flagID: Number(flag), typeID, fitRigs });
        state.shipRows.push(row(itemID, typeID, 1, shipID, Number(flag), 10, 1));
        return { result: null };
      }
      if (hull && method === "Add" && kwargs.flag === 5) {
        assert.equal(args[0], 100);
        state.stock -= kwargs.qty;
        state.shipRows.push(row(500, 3, kwargs.qty, held.activeShipID, 5));
        return { result: null };
      }
      if (hull && method === "Add" && [4, 87].includes(kwargs.flag)) {
        const item = withdrawStock(args[0], args[1], kwargs.qty);
        if (kwargs.flag === 4) {
          state.assembled.push(row(item.itemID, item.typeID, 1, held.stationID, 4));
          state.shipActions.push("withdraw hull");
        } else {
          assert.equal(spec.expectedShipID, held.activeShipID);
          state.shipRows.push(row(item.itemID, item.typeID, item.quantity, held.activeShipID, 87));
          state.shipActions.push("load drones");
        }
        return { result: null };
      }
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
    if (descriptor.kind === "shipBay") return { spec: { key: "ship", shipID: held.activeShipID },
      flag: descriptor.bay === "drone" ? 87 : 143, locationID: held.activeShipID };
    if (descriptor.kind === "container") return { spec: { key: "container" }, flag: 0, locationID: descriptor.itemID };
    if (descriptor.kind === "corp") {
      assert.equal(descriptor.division, division); return { spec: { key: "corp" }, flag: divisionFlag, locationID: null };
    }
    throw new Error("invalid descriptor");
  };
  const registered = registerProvisioningRoutes({ app: { get: (p, ...fns) => routes.set(`GET ${p}`, fns), post: (p, ...fns) => routes.set(`POST ${p}`, fns) },
    requireAuth: (_req, _res, next) => next(), requireHeld: () => held, engine, data, gateway,
    store: { listCharactersForAccount: async () => [{ accountID: 7, characterID: 10, corporationID: 30, characterName: "Current" },
      { accountID: 7, characterID: 11, corporationID: 20, characterName: "Provider" },
      { accountID: 7, characterID: 12, corporationID: 30, characterName: "Other cockpit pilot" }] },
    flight: async () => ({ flight: { docked: true, shipID: held.activeShipID,
      shipTypeID: (hull && state.assembled.find(item => item.itemID === held.activeShipID)?.typeID) ?? 1 } }),
    currentHeld: () => {}, inventoryLocation: () => held.stationID, pendingRecovery: () => false,
    resolvePlace, cargoBindSpec: (_held, shipID) => ({ key: "ship", shipID }),
    inventoryManagerBindSpec: () => ({ key: "inventory-manager" }), slots: () => [27, 92],
    shipBays: () => [{ key: "ammo", flag: 143, label: "Ammo" }],
    capacity: raw => raw, mutationFence,
    boundCall: (_held, _session, spec, method, args, kwargs) => gateway.callBoundMethod("invbroker", method, args, kwargs, {}, held.bridgeSessionID, spec),
    heldCall: async (asked, session, service, method, args, kwargs) => {
      if (hull && service === "ship" && method === "AssembleShip") {
        const item = state.assembled.find(row => row.itemID === args[0][0]);
        assert.equal(item?.singleton, 0);
        item.singleton = 1;
        state.shipActions.push("assemble hull");
        return { result: null };
      }
      if (service !== "corpFittingMgr") return memberOrCorporation(method);
      // The held pilot's own read of its corporation's fittings, as its client makes it.
      assert.equal(asked, held); assert.equal(session, "tab"); assert.equal(method, "GetFittings"); assert.equal(kwargs, null);
      state.heldFittingCalls.push(args);
      if (state.heldFittingError) throw Object.assign(new Error(state.heldFittingError), { code: state.heldFittingError });
      return { result: library(args[0]) };
    },
    boardShip: async (_held, _session, shipID, revalidate) => {
      await revalidate();
      assert.ok(state.assembled.some(item => item.itemID === shipID && item.singleton === 1));
      held.activeShipID = shipID;
      state.shipActions.push("board hull");
    },
  });
  function memberOrCorporation(method) {
    return ({ result: method === "GetMember" ? wireObject({ characterID: 10,
      corporationID: 30, roles: "0", rolesAtHQ: String(((state.query ? 1048576 : 0) | (state.take ? 8192 : 0)) << (division - 1)), rolesAtBase: "0", rolesAtOther: "0", baseID: 0, titleMask: 0 }) :
      wireObject({ corporationID: 30, stationID: 60 }) });
  }
  async function invoke(name, body = {}, method = "POST", query = {}) {
    const req = { body, query, webSessionID: "tab", account: { accountID: 7 } }, res = { json: value => { res.body = value; } };
    const fns = routes.get(`${method} /api/bridge/provisioning/${name}`);
    assert.ok(fns); await fns[0](req, res, error => { if (error) throw error; });
    await fns[1](req, res, error => { throw error; }); return res.body;
  }
  const input = { providerCharacterID: 11, corporationID: 20, fittingID: 4,
    source: hull ? { kind: "corp", corporationID: 30, division } : { kind: "hangar" } };
  return { state, held, engine, operations, invoke, input,
    adapter: () => registered.adapter({ webSessionID: "tab", account: { accountID: 7 } }, held) };
}

for (const hull of [
  { name: "Pioneer", typeID: 89240, groupID: 420, drones: 2 },
  { name: "Omen", typeID: 2006, groupID: 26, drones: 2 },
  { name: "Covetor", typeID: 17476, groupID: 463, drones: 2 },
]) test(`${hull.name} reviews and applies from Division 7 with rigs and the selected drone bay load`, async () => {
  const f = fixture(hull);
  const plan = await f.invoke("ship-review", f.input);
  assert.equal(plan.canApply, true);
  assert.equal(plan.plan.targetHullTypeID, hull.typeID);
  assert.equal(plan.plan.mode, "NEW_HULL");
  assert.equal(plan.plan.targetHullID, null, "a provisioning client can preview the reviewed packaged hull");
  assert.deepEqual(plan.plan.unsupported, []);
  assert.deepEqual(plan.plan.shortages, []);
  assert.deepEqual(f.state.shipActions, []);
  const request = { reviewID: plan.reviewID, reviewHash: plan.reviewHash };
  await assert.rejects(f.invoke("provision-ship", request), { code: "CONFIRMATION_REQUIRED" });
  const result = await f.invoke("provision-ship", { ...request, confirm: true });
  assert.equal(result.state, "COMPLETE");
  assert.equal(result.result.equipment, "VERIFIED");
  assert.equal(result.result.targets[0].current, 0, "optional saved charge in a module slot is not ordered as cargo");
  assert.equal(result.manifest.targetHullID, f.held.activeShipID);
  assert.deepEqual(f.state.shipActions, ["withdraw hull", "assemble hull", "board hull", ...(hull.drones ? ["load drones"] : [])]);
  assert.deepEqual(f.state.fitted, [
    { flagID: 92, typeID: 7, fitRigs: true },
    { flagID: 27, typeID: 2, fitRigs: false },
  ]);
  assert.equal(f.state.shipRows.find(item => item.flagID === 87)?.quantity ?? 0, hull.drones);
});

test("a published non-frigate still needs authority to take the reviewed stock", async () => {
  const f = fixture({ name: "Covetor", typeID: 17476, groupID: 463, drones: 2 });
  f.state.take = false;
  const plan = await f.invoke("ship-review", f.input);
  assert.equal(plan.canApply, false);
  await assert.rejects(f.invoke("provision-ship", { ...plan, confirm: true }), { code: "REVIEW_REQUIRED" });
  assert.deepEqual(f.state.shipActions, []);
});

test("an unpublished hull cannot be assembled by Provision Ship", async () => {
  const f = fixture({ name: "Covetor", typeID: 17476, groupID: 463, published: false, drones: 2 });
  const plan = await f.invoke("ship-review", f.input);
  assert.equal(plan.canApply, false);
  assert.match(plan.plan.unsupported.join(" "), /usable ship hull/);
  await assert.rejects(f.invoke("provision-ship", { ...plan, confirm: true }), { code: "REVIEW_REQUIRED" });
  assert.deepEqual(f.state.shipActions, []);
});
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

test("final selected MCC adapter resolves a unique exact fit but refuses ambiguous or incomplete equipment", async () => {
  const f = fixture(), input = { ...f.input, fittingID: 0 };
  const unique = await f.adapter().readPreparation(input);
  assert.equal(unique.contract.definition.fittingID, 4);
  assert.equal(unique.observation.complete, true);
  assert.equal(unique.context.characterID, 10);
  assert.equal(unique.source.pin.locationID, 60);
  f.state.duplicateFit = true;
  await assert.rejects(f.adapter().readPreparation(input), { code: "EQUIPMENT_NOT_READY" });
  assert.equal((await f.adapter().readPreparation(f.input)).contract.definition.fittingID, 4,
    "an explicit exact fitting remains usable when definitions share equipment");
  f.state.incomplete = true;
  await assert.rejects(f.adapter().readPreparation(input), { code: "EQUIPMENT_NOT_READY" });
  assert.equal((await f.adapter().readPreparation(f.input)).observation.complete, false,
    "explicit selection never manufactures complete inventory evidence");
  assert.deepEqual(f.state.writes, []);
  assert.equal(f.engine.journal.list().length, 0);
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

test("the held pilot as its own provider is asked for its corporation's fittings on its own session", async () => {
  const f = fixture();
  // No provider named: the pilot that is held.
  const options = await f.invoke("options", {}, "GET");
  assert.equal(options.providerCharacterID, 10); assert.equal(options.definitionCorporationID, 30); assert.equal(options.definitionStatus, "READY");
  assert.deepEqual(options.fittings.map(fit => fit.fittingID), [4]);
  assert.deepEqual(f.state.heldFittingCalls, [[30]]);
  const input = { providerCharacterID: 10, corporationID: 30, fittingID: 4, source: { kind: "hangar" } };
  const review = await f.invoke("review", input);
  assert.equal(review.status.equipment, "VERIFIED"); assert.equal(review.contract.definition.characterID, 10);
  const result = await f.invoke("replenish", { reviewID: review.reviewID, reviewHash: review.reviewHash, confirm: true });
  assert.equal(result.state, "COMPLETE"); assert.equal(result.result.supplies, "FULL");
  assert.deepEqual(f.state.writes, [[100, 60, 1800]]);
  // Every read of the library, through the whole operation, was the pilot's own: the gateway was never asked to stand in for it.
  assert.ok(f.state.heldFittingCalls.length > 2); assert.ok(f.state.heldFittingCalls.every(args => args.length === 1 && args[0] === 30));
  assert.deepEqual(f.state.providerCalls, []);
});

test("another character as provider is still read without a session, and the held pilot's is never borrowed for it", async () => {
  const f = fixture();
  await f.invoke("options", {}, "GET", { providerCharacterID: "11" });
  await f.invoke("review", f.input);
  assert.deepEqual(f.state.heldFittingCalls, []);
  assert.ok(f.state.providerCalls.length >= 2); assert.ok(f.state.providerCalls.every(fields => fields.characterID === 11 && fields.corpid === 20));
});

test("the held pilot's session going while its fittings are read surfaces; a refusal is an unavailable library", async () => {
  const f = fixture();
  const input = { providerCharacterID: 10, corporationID: 30, fittingID: 4, source: { kind: "hangar" } };
  f.state.heldFittingError = "SESSION_NOT_FOUND";
  await assert.rejects(f.invoke("options", {}, "GET"), { code: "SESSION_NOT_FOUND" });
  await assert.rejects(f.invoke("review", input), { code: "SESSION_NOT_FOUND" });
  f.state.heldFittingError = "CALL_REFUSED";
  assert.equal((await f.invoke("options", {}, "GET")).definitionStatus, "CORP_UNAVAILABLE");
  await assert.rejects(f.invoke("review", input), { code: "FITTING_SOURCE_CHANGED" });
  assert.deepEqual(f.state.providerCalls, [], "and the gateway is not tried in its place");
});

test("a loaded charge and five spares require five confirmed charges in cargo", async () => {
  const f = fixture({ name: "Omen", typeID: 2006, groupID: 26, spares: 5 });
  const review = await f.invoke("ship-review", f.input);
  assert.equal(review.canApply, true);
  const result = await f.invoke("provision-ship", { reviewID: review.reviewID, reviewHash: review.reviewHash, confirm: true });
  assert.equal(result.state, "COMPLETE");
  assert.equal(f.state.shipRows.find(row => row.typeID === 3 && row.flagID === 5)?.quantity, 5);
});

for (const [name, attributes, groupID, reason] of [
  ["rig size", { 2006: { 1547: 2 }, 7: { 1547: 1 } }, 26, /rig size/],
  ["calibration", { 2006: { 1132: 100 }, 7: { 1153: 150 } }, 26, /calibration/],
  ["skills", { 7: { 182: 42, 277: 3 } }, 26, /skill 42/],
  ["capsule", {}, 29, /usable ship/], ["strategic cruiser", {}, 963, /usable ship/],
]) test(`Review refuses ${name} before assembly`, async () => {
  const f = fixture({ name, typeID: 2006, groupID, attributes });
  const review = await f.invoke("ship-review", f.input);
  assert.equal(review.canApply, false);
  assert.match(review.plan.unsupported.join(" "), reason);
  assert.deepEqual(f.state.shipActions, []);
});

test("a subsystem on an otherwise supported hull is refused before taking it", async () => {
  const f = fixture({ name: "Probe hull", typeID: 2006, groupID: 26, subsystem: true });
  const review = await f.invoke("ship-review", f.input);
  assert.equal(review.canApply, false);
  assert.match(review.plan.unsupported.join(" "), /slot\/type 125\/8/);
  assert.deepEqual(f.state.shipActions, []);
});

test("mixed ammunition cannot complete with missing cargo stock", async () => {
  const f = fixture({ name: "Omen", typeID: 2006, groupID: 26, spares: 5 });
  f.state.stock = 4;
  const review = await f.invoke("ship-review", f.input);
  assert.equal(review.canApply, false);
  assert.match(review.plan.shortages.join(" "), /cargo spares/);
  await assert.rejects(f.invoke("provision-ship", { ...review, confirm: true }), { code: "REVIEW_REQUIRED" });
  assert.deepEqual(f.state.shipActions, []);
});
