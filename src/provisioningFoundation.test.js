"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { fittingFingerprint } = require("./pilotTrainingFittings");
const { buildContract, inspectContract, matchFittings, inventoryRows, hash } = require("./provisioningContracts");
const { createReplenishment, verifyMovement } = require("./replenishment");
const { createPilotMutationFence } = require("./pilotMutationFence");
const { corporationAccess } = require("./provisioningRoutes");
const types = { 1: { categoryID: 6 }, 2: { categoryID: 7 }, 3: { categoryID: 8, groupID: 83, volume: .01 },
  4: { categoryID: 18 }, 5: { categoryID: 4, groupID: 423 }, 6: { categoryID: 4, groupID: 1136 } };
const data = { getType: id => types[id], getTypeName: id => `Type ${id}` };
const provider = { scope: "CORPORATION", accountID: 7, characterID: 11, corporationID: 20 };
function fitting(extra = []) {
  const items = [{ typeID: 2, flagID: 27, quantity: 1 }, { typeID: 3, flagID: 5, quantity: 5000 }, ...extra];
  return { fittingID: 4, ownerID: 20, shipTypeID: 1, name: "Exact", savedDate: "100", items, fingerprint: fittingFingerprint(1, items) };
}
function observed(qty = 3200) { return { complete: true, shipTypeID: 1, rows: [
  { typeID: 2, flagID: 27, quantity: 1 }, { typeID: 3, flagID: 5, quantity: qty } ] }; }
function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-provisioning-"));
  t.after(() => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true, force: true }); });
  return path.join(dir, "journal.json");
}
test("equipment equality is independent of supply quantity and unrelated cargo", () => {
  const contract = buildContract(fitting(), provider, data);
  const obs = observed(); obs.rows.push({ typeID: 6, flagID: 5, quantity: 70 });
  const result = inspectContract(contract, obs, data);
  assert.equal(result.equipment, "VERIFIED"); assert.equal(result.supplies, "LOW"); assert.equal(result.targets[0].deficit, 1800);
  obs.rows[0].flagID = 28; assert.equal(inspectContract(contract, obs, data).equipment, "MODIFIED");
});
test("stack identity does not affect matching; identical definitions expose alternatives", () => {
  const one = buildContract(fitting(), provider, data), two = { ...one, name: "Another", definition: { ...one.definition, fittingID: 5 } };
  const obs = observed(1000); obs.rows.push({ itemID: 999, typeID: 3, flagID: 5, quantity: 2200 });
  assert.equal(inspectContract(one, obs, data).targets[0].current, 3200);
  assert.equal(matchFittings([one], obs, data).state, "MATCH");
  assert.equal(matchFittings([one, two], obs, data).state, "AMBIGUOUS");
  assert.equal(matchFittings([one], { ...obs, complete: false }, data).state, "UNKNOWN");
});
test("unknown observation never becomes empty, missing or verified", () => {
  const result = inspectContract(buildContract(fitting(), provider, data), { complete: false, rows: [] }, data);
  assert.equal(result.equipment, "UNKNOWN"); assert.equal(result.targets[0].current, null);
  assert.throws(() => inventoryRows(null), { code: "OBSERVATION_INCOMPLETE" });
  assert.throws(() => inventoryRows({ type: "list", items: [{}] }), { code: "OBSERVATION_INCOMPLETE" });
});
test("strict rows normalize singleton and virtual loaded-charge identities", () => {
  const rows = inventoryRows({ type: "list", items: [
    { itemID: 44, typeID: 2, flagID: 27, locationID: 50, ownerID: 10, singleton: 1, quantity: -1 },
    { itemID: { type: "tuple", items: [50, 27, 3] }, typeID: 3, flagID: 27, locationID: 50, quantity: 200, ownerID: 10 } ] });
  assert.equal(rows[0].quantity, 1); assert.equal(rows[1].loaded, true);
  assert.throws(() => inventoryRows({ type: "list", items: [
    { itemID: 45, typeID: 3, flagID: 27, locationID: 50, quantity: 200, ownerID: 10 },
    { itemID: { type: "tuple", items: [50, 27, 3] }, typeID: 3, flagID: 27, locationID: 50, quantity: 200, ownerID: 10 },
  ] }), { code: "OBSERVATION_INCOMPLETE" });
  const fit = fitting(); fit.items = [fit.items[0], { typeID: 3, flagID: 27, quantity: 5000 }]; fit.fingerprint = fittingFingerprint(1, fit.items);
  const result = inspectContract(buildContract(fit, provider, data), { complete: true, shipTypeID: 1, rows }, data);
  assert.equal(result.targets[0].current, 200);
});
test("loaded charges and spare stacks of the same type count exactly once under an explicit total-aboard policy", () => {
  const fit = fitting([{ typeID: 3, flagID: 27, quantity: 200 }]);
  const contract = buildContract(fit, provider, data), obs = observed(3200);
  obs.rows.push({ typeID: 3, flagID: 27, quantity: 100 });
  assert.equal(contract.supplies.length, 1); assert.equal(contract.supplies[0].mode, "TOTAL_ABOARD");
  assert.equal(contract.supplies[0].target, 5200);
  assert.equal(inspectContract(contract, obs, data).targets[0].current, 3300);
  obs.rows[0].quantity = NaN;
  assert.equal(inspectContract(contract, obs, data).equipment, "UNKNOWN");
  assert.equal(matchFittings([contract], obs, data).state, "UNKNOWN");
});
test("explicit required carried equipment affects equipment identity independently of supply targets", () => {
  const contract = buildContract(fitting(), provider, data, { requiredCarried: [{ typeID: 6, flagID: 5, quantity: 2 }] });
  const obs = observed(); assert.equal(inspectContract(contract, obs, data).equipment, "MODIFIED");
  obs.rows.push({ typeID: 6, flagID: 5, quantity: 2 });
  assert.equal(inspectContract(contract, obs, data).equipment, "VERIFIED");
  assert.throws(() => buildContract(fitting(), provider, data, { supplies: [{ typeID: 6, target: 10, mode: "CARRIED_SPARES", eligibleFlags: [133] }] }), { code: "INVALID_SUPPLY_POLICY" });
});
test("invalid definitions, duplicate slots and incorrect provider fail closed", () => {
  assert.throws(() => buildContract({ ...fitting(), fingerprint: "bad" }, provider, data), { code: "INVALID_FIT" });
  assert.throws(() => buildContract(fitting([{ typeID: 2, flagID: 27, quantity: 1 }]), provider, data), { code: "INVALID_FIT" });
  assert.throws(() => buildContract(fitting(), { ...provider, corporationID: 30 }, data), { code: "INVALID_FIT" });
  const before = buildContract(fitting(), provider, data), after = buildContract({ ...fitting(), savedDate: "101" }, provider, data);
  assert.notEqual(before.definitionFingerprint, after.definitionFingerprint); assert.equal(before.equipmentFingerprint, after.equipmentFingerprint);
  const renamed = buildContract({ ...fitting(), name: "Renamed" }, provider, data);
  assert.notEqual(before.definitionFingerprint, renamed.definitionFingerprint);
  assert.equal(before.supplyPolicyFingerprint, renamed.supplyPolicyFingerprint);
  assert.throws(() => buildContract(fitting([{ typeID: 6, flagID: 28, quantity: 1 }]), provider, data), { code: "INVALID_FIT" });
});
test("fuel blocks are unrelated unless explicitly declared by policy, never ship-fuel targets", () => {
  const contract = buildContract(fitting([{ typeID: 5, flagID: 5, quantity: 100 }, { typeID: 6, flagID: 5, quantity: 20 }]), provider, data);
  assert.deepEqual(contract.supplies.find(t => t.typeID === 5).eligibleFlags, [5, 133]);
  assert.equal(contract.supplies.some(t => t.typeID === 6), false);
});
test("corporation Query and location-specific Take remain independent", () => {
  const member = { roles: "0", rolesAtHQ: String(1048576 | 8192), rolesAtBase: "0", rolesAtOther: "1048576", baseID: 2, titleMask: 0 };
  const query = corporationAccess(member, { stationID: 1 }, 3, 1);
  assert.equal(query.query, true); assert.equal(query.take, false);
  assert.equal(corporationAccess(member, { stationID: 1 }, 1, 1).take, true);
  assert.throws(() => corporationAccess({ ...member, rolesAtOther: null }, { stationID: 1 }, 3, 1), { code: "CORPORATION_ACCESS_UNKNOWN" });
  assert.throws(() => corporationAccess({ ...member, titleMask: 1 }, { stationID: 1 }, 3, 1), { code: "CORPORATION_ACCESS_UNKNOWN" });
});
test("missing or malformed corporation title evidence remains UNKNOWN even with direct Take roles", () => {
  const member = { roles: "1", rolesAtHQ: "0", rolesAtBase: "0", rolesAtOther: "0", baseID: 2 };
  for (const titleMask of [undefined, null, "", "invalid", -1, 0.5, {}])
    assert.throws(() => corporationAccess({ ...member, titleMask }, { stationID: 1 }, 3, 1), { code: "CORPORATION_ACCESS_UNKNOWN" });
  assert.equal(corporationAccess({ ...member, titleMask: "0" }, { stationID: 1 }, 3, 1).take, true);
});

function fixture(filePath = null, stock = 4000) {
  let saved = fitting(), aboard = 3200;
  const operations = new Map();
  const state = { stock, writes: 0, failAfter: false, failRead: false };
  const context = { accountID: 7, characterID: 10, shipID: 50, locationID: 60, corporationID: 30, sessionGeneration: "g" };
  const origin = () => state.stock ? [{ itemID: 80, typeID: 3, quantity: state.stock, flagID: 4, locationID: 60 }] : [];
  const destination = () => [{ itemID: 90, typeID: 3, quantity: aboard, flagID: 5, locationID: 50 }, { itemID: 91, typeID: 6, quantity: 7 }];
  const adapter = { context: async () => ({ ...context }), read: async () => {
    const contract = buildContract(saved, provider, data);
    return { context: { ...context }, contract, contracts: [contract], observation: observed(aboard),
      source: { rows: origin(), pin: { locationID: 60 }, access: { query: true, take: true } } };
  }, plan: async targets => state.stock && targets[0].deficit ? { itemID: 80, typeID: 3, quantity: Math.min(state.stock, targets[0].deficit), shipID: 50 } : null,
    validateMove: async () => {}, readMovement: async () => {
      if (state.failRead) throw new Error("unreadable"); return { source: origin(), destination: destination() };
    }, dispatch: async move => {
      state.writes++; state.stock -= move.quantity; aboard += move.quantity;
      if (state.afterDispatch) await state.afterDispatch();
      if (state.failAfter) throw Object.assign(new Error("after commit"), { code: "TIMEOUT" });
    } };
  const engine = createReplenishment({ filePath, operations, data });
  return { engine, adapter, state, operations, context, changeDefinition: () => { saved = { ...saved, savedDate: "101" }; } };
}
test("deficit-only transfer persists a dispatch fence and preserves cargo; repeat requests do not resend", async t => {
  const file = tempFile(t), f = fixture(file);
  const review = await f.engine.review(f.adapter, {});
  f.state.afterDispatch = async () => {
    const persisted = JSON.parse(fs.readFileSync(file)); const row = persisted.records[review.reviewID];
    assert.equal(row.state, "PENDING"); assert.equal(row.moves[0].quantity, 1800);
  };
  const result = await f.engine.apply(f.adapter, review);
  assert.equal(result.state, "COMPLETE"); assert.equal(result.result.targets[0].current, 5000);
  assert.equal(f.state.writes, 1);
  await f.engine.apply(f.adapter, review); assert.equal(f.state.writes, 1);
  const next = await f.engine.review(f.adapter, {}); await f.engine.apply(f.adapter, next); assert.equal(f.state.writes, 1);
});
test("partial available stock remains LOW with verified equipment", async () => {
  const f = fixture(null, 1000), review = await f.engine.review(f.adapter, {});
  const result = await f.engine.apply(f.adapter, review);
  assert.equal(result.result.equipment, "VERIFIED"); assert.equal(result.result.supplies, "LOW");
  assert.equal(result.result.targets[0].deficit, 800); assert.equal(f.state.writes, 1);
});

test("visible corporation stock without Take persists a refusal that cannot become an acquisition after restart", async t => {
  const file = tempFile(t), f = fixture(file), read = f.adapter.read;
  let take = false;
  f.adapter.read = async () => {
    const current = await read();
    current.source.pin = { descriptor: { kind: "corp", corporationID: 30, division: 1 },
      ownerID: 30, locationID: 777, flag: 115, office: "corpOffice:888", dockedLocationID: 60 };
    current.source.access = { query: true, take, authorityFingerprint: hash(["direct-division-1", take]) };
    return current;
  };
  const review = await f.engine.review(f.adapter, {});
  assert.equal(review.source.access.query, true); assert.equal(review.canApply, false);
  await assert.rejects(f.engine.apply(f.adapter, review), { code: "SOURCE_TAKE_DENIED" });
  const persisted = JSON.parse(fs.readFileSync(file)).records[review.reviewID];
  assert.equal(persisted.state, "REFUSED"); assert.equal(persisted.reason, "SOURCE_TAKE_DENIED");
  assert.deepEqual(persisted.moves, []); assert.equal(f.state.writes, 0);
  assert.equal(persisted.sourcePin.locationID, 777); assert.equal(persisted.access.take, false);
  const restored = createReplenishment({ filePath: file, operations: new Map(), data });
  take = true;
  const retry = await restored.apply(f.adapter, review);
  assert.equal(retry.state, "REFUSED"); assert.equal(retry.result, null); assert.equal(f.state.writes, 0);
  const fresh = await restored.review(f.adapter, {});
  assert.equal((await restored.apply(f.adapter, fresh)).state, "COMPLETE"); assert.equal(f.state.writes, 1);
});
test("error after commit is reconciled using exact deltas, including stack merge", async () => {
  const f = fixture(); f.state.failAfter = true;
  const result = await f.engine.apply(f.adapter, await f.engine.review(f.adapter, {}));
  assert.equal(result.state, "COMPLETE"); assert.equal(f.state.writes, 1);
});
test("definition or source stock changes invalidate Review before dispatch", async () => {
  for (const mutate of [f => f.changeDefinition(), f => { f.state.stock--; }, f => { f.context.shipID++; }]) {
    const f = fixture(), review = await f.engine.review(f.adapter, {}); mutate(f);
    await assert.rejects(f.engine.apply(f.adapter, review), { code: "REVIEW_REQUIRED" }); assert.equal(f.state.writes, 0);
  }
});
test("shared pilot reservation and final gateway dispatch gate reject conflicting controllers", async () => {
  const f = fixture();
  const held = new Map([["tab", { characterID: 10, bridgeSessionID: "held" }]]);
  const fence = createPilotMutationFence({ heldSessions: held, assertWritable: f.engine.assertWritable });
  let sends = 0;
  const gateway = fence.wrap({ callBoundMethod: () => { sends++; } });
  f.state.afterDispatch = async () => {
    assert.throws(() => gateway.callBoundMethod("oid", "Add", [], null, {}, "held"), { code: "REPLENISHMENT_CUSTODY" });
    assert.throws(() => f.engine.assertWritable(10), { code: "REPLENISHMENT_CUSTODY" });
  };
  await f.engine.apply(f.adapter, await f.engine.review(f.adapter, {})); assert.equal(sends, 0);
});
test("an already dispatched bridge write reserves the same pilot map until settlement", async () => {
  const f = fixture(), held = new Map([["tab", { characterID: 10, bridgeSessionID: "held" }]]);
  const fence = createPilotMutationFence({ heldSessions: held, assertWritable: f.engine.assertWritable, enterWrite: f.engine.enterWrite });
  let finish; const waiting = new Promise(resolve => { finish = resolve; });
  const gateway = fence.wrap({ callBoundMethod: () => waiting });
  const pending = gateway.callBoundMethod("invbroker", "StackAll", [], null, {}, "held");
  assert.equal(f.operations.get(10).kind, "bridge-write");
  await assert.rejects(f.engine.apply(f.adapter, await f.engine.review(f.adapter, {})), { code: "CHARACTER_IN_USE" });
  finish(); await pending; assert.equal(f.operations.has(10), false);
  await f.engine.apply(f.adapter, await f.engine.review(f.adapter, {})); assert.equal(f.state.writes, 1);
});
test("persistence failure prevents dispatch and malformed custody evidence fails closed", async t => {
  const file = tempFile(t), f = fixture(file), review = await f.engine.review(f.adapter, {});
  fs.mkdirSync(file);
  await assert.rejects(f.engine.apply(f.adapter, review)); assert.equal(f.state.writes, 0);
  fs.rmdirSync(file);
  fs.writeFileSync(file, JSON.stringify({ version: 1, records: { broken: { accountID: 7, characterID: 10, state: "COMPLETE", moves: [] } } }));
  assert.throws(() => createReplenishment({ filePath: file, operations: new Map(), data }), { code: "CUSTODY_JOURNAL_INVALID" });
});
test("WC restart restores pending custody and cannot replay; read-only reconciliation unlocks a fresh Review", async t => {
  const file = tempFile(t), f = fixture(file), review = await f.engine.review(f.adapter, {});
  f.state.afterDispatch = async () => { f.state.failRead = true; };
  await assert.rejects(f.engine.apply(f.adapter, review));
  const restored = createReplenishment({ filePath: file, operations: new Map(), data });
  assert.throws(() => restored.assertWritable(10), { code: "REPLENISHMENT_CUSTODY" });
  const repeat = await restored.apply(f.adapter, review); assert.equal(repeat.state, "BLOCKED"); assert.equal(f.state.writes, 1);
  f.state.failRead = false;
  assert.equal((await restored.reconcile(f.adapter, review.reviewID)).state, "RECONCILED");
  await restored.apply(f.adapter, await restored.review(f.adapter, {})); assert.equal(f.state.writes, 1);
});
test("unchanged or partial deltas are ambiguous, never proof of refusal", () => {
  const before = { source: [{ itemID: 1, typeID: 3, quantity: 20 }], destination: [{ itemID: 2, typeID: 3, quantity: 10 }] };
  assert.equal(verifyMovement(before, before, { itemID: 1, typeID: 3, quantity: 5 }), "AMBIGUOUS");
  assert.equal(verifyMovement(before, { source: [{ itemID: 1, typeID: 3, quantity: 18 }], destination: [{ itemID: 2, typeID: 3, quantity: 12 }] }, { itemID: 1, typeID: 3, quantity: 5 }), "AMBIGUOUS");
});
