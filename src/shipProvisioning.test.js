"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createReplenishment } = require("./replenishment");
const { buildContract } = require("./provisioningContracts");
const { fittingFingerprint } = require("./pilotTrainingFittings");
const data = { getType: id => ({ 1: { categoryID: 6, groupID: 25 }, 2: { categoryID: 7 }, 3: { categoryID: 8 },
  4: { categoryID: 18 }, 99: { categoryID: 6, groupID: 25 } })[id], getTypeName: id => `Type ${id}` };
const clone = x => structuredClone(x);
function fixture(t, corp = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-ship-"));
  t.after(() => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true }); });
  const filePath = path.join(dir, "journal.json"), operations = new Map();
  const items = [{ typeID: 2, flagID: 19, quantity: 1 }, { typeID: 2, flagID: 27, quantity: 1 },
    { typeID: 4, flagID: 87, quantity: 2 }, { typeID: 3, flagID: 5, quantity: 5 }];
  const contract = buildContract({ fittingID: 4, ownerID: 20, shipTypeID: 1, name: "Exact", savedDate: "100", items,
    fingerprint: fittingFingerprint(1, items) }, { scope: "CORPORATION", accountID: 7, characterID: 11, corporationID: 20 }, data);
  const row = (itemID, typeID, quantity, locationID = corp ? 601 : 600, flagID = corp ? 115 : 4, ownerID = corp ? 20 : 11, singleton = false) =>
    ({ itemID, identity: String(itemID), typeID, quantity, locationID, flagID, ownerID, singleton, loaded: false });
  const world = { context: { accountID: 7, characterID: 11, corporationID: 20, shipID: 50, shipTypeID: 99, locationID: 600,
      sessionGeneration: "generation-1", recoveryReady: true }, contract, source: [row(70, 1, 3), row(80, 2, 8), row(90, 4, 8), row(100, 3, 20)],
    hangar: [row(50, 99, 1, 600, 4, 11, true)], targetRows: {}, serial: 110, dispatched: [], fault: null, unreadable: false, ackOnly: false, ambiguous: false,
    access: { query: true, take: true } };
  if (!corp) world.hangar.push(...world.source);
  const input = { providerCharacterID: 11, corporationID: 20, fittingID: 4, source: corp ? { kind: "corp", corporationID: 20, division: 1 } : { kind: "hangar" } };
  const sourcePin = { descriptor: input.source, locationID: corp ? 601 : 600, ownerID: corp ? 20 : 11, flag: corp ? 115 : 4, office: corp ? "corpOffice:273" : null, dockedLocationID: 600 };
  const adapter = { context: async () => clone(world.context),
    async readShip(_, targetID = null) {
      if (world.unreadable) throw Object.assign(new Error("Uncertain outcome"), { code: "TEST_READ_INTERRUPTED" });
      const observation = { complete: true, shipTypeID: world.context.shipTypeID, rows: world.targetRows[world.context.shipID] || [] };
      return clone({ context: world.context, contract: world.contract, contracts: [world.contract], observation,
        source: { pin: sourcePin, access: world.access, rows: corp ? world.source : world.hangar }, hangar: world.hangar,
        target: { complete: true, shipID: targetID, shipTypeID: 1, rows: world.targetRows[targetID] || [] } });
    },
    async plan(targets, read) {
      const target = targets.find(r => r.deficit > 0), source = read.source.rows.find(r => r.typeID === target?.typeID);
      return source ? { itemID: source.itemID, typeID: source.typeID, quantity: Math.min(source.quantity, target.deficit),
        sourceLocationID: source.locationID, shipID: read.context.shipID, destination: { kind: "cargo" } } : null;
    },
    async dispatchShip(action) {
      world.dispatched.push(clone(action));
      assert.equal(JSON.parse(fs.readFileSync(filePath)).records[operationID].actions.at(-1).state, "PENDING");
      if (world.ackOnly) return;
      const move = action.move;
      if (action.kind === "ASSEMBLE_HULL") {
        const source = world.hangar.find(r => r.itemID === move.itemID); source.quantity--;
        if (!source.quantity) world.hangar.splice(world.hangar.indexOf(source), 1);
        world.hangar.push(row(world.preserveSingletonID && !source.quantity ? move.itemID : ++world.serial, 1, 1, 600, 4, 11, true));
        if (world.ambiguous) world.hangar.push(row(++world.serial, 1, 1, 600, 4, 11, true));
      } else if (action.kind === "BOARD_HULL") Object.assign(world.context, { shipID: move.itemID, shipTypeID: 1 });
      else {
        const sourceRows = corp ? world.source : world.hangar, source = sourceRows.find(r => r.itemID === move.itemID);
        source.quantity -= move.quantity;
        if (!source.quantity) sourceRows.splice(sourceRows.indexOf(source), 1);
        if (action.kind === "WITHDRAW_HULL") world.hangar.push(row(world.preserveSingletonID && !source.quantity ? move.itemID : ++world.serial, 1, 1, 600, 4, 11));
        else {
          const rows = world.targetRows[move.shipID] ||= [], existing = rows.find(r => r.typeID === move.typeID && r.flagID === move.flag);
          if (existing) existing.quantity += move.quantity;
          else rows.push(row(++world.serial, move.typeID, move.quantity, move.shipID, move.flag, 11, action.kind === "FIT_ITEM"));
        }
      }
      if (world.fault === action.kind) { world.fault = null; world.unreadable = true; throw new Error("Dispatch response lost after commit"); }
    } };
  let engine = createReplenishment({ filePath, operations, data }), operationID;
  return { world, adapter, input, filePath, operations, engine: () => engine,
    async review(id = null) { const review = await engine.reviewShip(adapter, input, id); operationID = id || review.reviewID; return review; },
    apply: review => engine.applyShip(adapter, review), restart() { operations.clear(); engine = createReplenishment({ filePath, operations, data }); } };
}
test("personal packaged stack consumes one, uniquely boards, fits, loads, verifies and repeats without dispatch", async t => {
  const f = fixture(t), review = await f.review(); assert.equal(review.plan.hullQuantity, 1);
  const result = await f.apply(review); assert.equal(result.state, "COMPLETE"); assert.equal(result.result.equipment, "VERIFIED");
  assert.equal(result.result.supplies, "FULL"); assert.equal(f.world.hangar.find(r => r.itemID === 70).quantity, 2);
  assert.notEqual(result.manifest.targetHullID, 70); assert.equal(f.world.context.shipID, result.manifest.targetHullID);
  const count = f.world.dispatched.length;
  assert.equal((await f.apply(review)).state, "COMPLETE");
  const again = await f.review(); assert.equal(again.plan.mode, "ALREADY_SATISFIED"); assert.equal(again.plan.hullQuantity, 0);
  assert.equal((await f.apply(again)).result.alreadySatisfied, true); assert.equal(f.world.dispatched.length, count);
  f.restart(); assert.equal(f.engine().unresolved(11).length, 0);
});
for (const fault of ["WITHDRAW_HULL", "ASSEMBLE_HULL", "FIT_ITEM"]) test(`${fault}: persisted fence, restart, reread and explicit continuation do not duplicate`, async t => {
  const f = fixture(t, fault === "WITHDRAW_HULL"); f.world.fault = fault;
  const review = await f.review(); await assert.rejects(f.apply(review), { code: "TEST_READ_INTERRUPTED" });
  assert.equal(f.engine().journal.get(review.reviewID).state, "BLOCKED");
  assert.throws(() => f.engine().assertWritable(11), { code: "REPLENISHMENT_CUSTODY" });
  f.world.unreadable = false; f.world.context.sessionGeneration = "generation-2"; f.restart();
  const reconciled = await f.engine().reconcileShip(f.adapter, review.reviewID); assert.equal(reconciled.state, "READY");
  const continued = await f.review(review.reviewID); assert.equal(continued.canApply, true);
  assert.equal((await f.apply(continued)).result.equipment, "VERIFIED");
  assert.equal(f.world.dispatched.filter(a => a.kind === "ASSEMBLE_HULL").length, 1);
  assert.equal(f.world.dispatched.filter(a => a.kind === "WITHDRAW_HULL").length, fault === "WITHDRAW_HULL" ? 1 : 0);
  assert.equal(f.world.dispatched.filter(a => a.kind === "FIT_ITEM").length, 2);
  f.restart(); assert.equal(f.engine().unresolved(11).length, 0);
});
for (const mode of ["ackOnly", "ambiguous"]) test(`assembly ${mode} cannot prove a resulting singleton`, async t => {
  const f = fixture(t); f.world[mode] = true;
  const review = await f.review(), outcome = await f.apply(review);
  assert.equal(outcome.state, "BLOCKED"); assert.equal(outcome.manifest.targetHullID, null);
  assert.equal(f.world.dispatched.length, 1); f.restart();
  assert.equal((await f.engine().reconcileShip(f.adapter, review.reviewID)).state, "BLOCKED");
  assert.equal(f.world.dispatched.length, 1);
});
for (const changed of ["definition", "authority", "generation", "ship", "inventory"]) test(`${changed} after Review refuses before dispatch`, async t => {
  const f = fixture(t), review = await f.review();
  if (changed === "definition") f.world.contract.name = "Changed definition";
  if (changed === "authority") f.world.access.take = false;
  if (changed === "generation") f.world.context.sessionGeneration = "another";
  if (changed === "ship") f.world.context.shipID = 51;
  if (changed === "inventory") f.world.hangar.find(r => r.itemID === 70).quantity--;
  await assert.rejects(f.apply(review), { code: "REVIEW_REQUIRED" }); assert.equal(f.world.dispatched.length, 0);
});
test("corrupted VERIFIED action proof fails closed on restart", async t => {
  const f = fixture(t), review = await f.review(); await f.apply(review);
  const journal = JSON.parse(fs.readFileSync(f.filePath)); journal.records[review.reviewID].actions[0].proof.targetHullID = 999;
  fs.writeFileSync(f.filePath, JSON.stringify(journal)); assert.throws(() => f.restart(), { code: "CUSTODY_JOURNAL_INVALID" });
});
test("partial supplies finish with equipment VERIFIED / LOW", async t => {
  const f = fixture(t); f.world.hangar.find(r => r.typeID === 3).quantity = 3;
  const result = await f.apply(await f.review()); assert.equal(result.state, "COMPLETE");
  assert.equal(result.result.equipment, "VERIFIED"); assert.equal(result.result.supplies, "LOW");
  assert.equal(result.result.targets[0].current, 3); assert.equal(result.result.targets[0].deficit, 2);
});
test("rig requirements refuse new-hull Apply visibly", async t => {
  const f = fixture(t); const c = f.world.contract;
  c.structural.push([92, 2, 1]); c.equipment.push([92, 2, 1]);
  const review = await f.review(); assert.equal(review.canApply, false); assert.match(review.plan.unsupported.join(" "), /rigs/);
  await assert.rejects(f.apply(review), { code: "REVIEW_REQUIRED" }); assert.equal(f.world.dispatched.length, 0);
});
test("late result from a changed generation remains fenced until readonly reconciliation", async t => {
  const f = fixture(t), dispatch = f.adapter.dispatchShip;
  f.adapter.dispatchShip = async action => { await dispatch(action); f.world.context.sessionGeneration = "new-generation"; };
  const review = await f.review(); await assert.rejects(f.apply(review), { code: "PROVISIONING_GENERATION_CHANGED" });
  const record = f.engine().journal.get(review.reviewID); assert.equal(record.state, "BLOCKED"); assert.equal(record.actions[0].state, "PENDING");
  assert.throws(() => f.engine().assertWritable(11), { code: "REPLENISHMENT_CUSTODY" });
  assert.equal((await f.engine().reconcileShip(f.adapter, review.reviewID)).state, "READY"); assert.equal(f.world.dispatched.length, 1);
});
test("completed request rereads the actual target and refuses a different current ship", async t => {
  const f = fixture(t), review = await f.review(); await f.apply(review);
  f.world.context.shipID = 50; f.world.context.shipTypeID = 99;
  await assert.rejects(f.apply(review), { code: "COMPLETED_SHIP_CHANGED" });
});
test("already-exact equipment is a zero-dispatch no-op even with denied Take", async t => {
  const f = fixture(t); await f.apply(await f.review()); const count = f.world.dispatched.length;
  f.world.access.take = false;
  const review = await f.review(); assert.equal(review.plan.mode, "ALREADY_SATISFIED"); assert.equal(review.canApply, true);
  assert.equal((await f.apply(review)).result.alreadySatisfied, true); assert.equal(f.world.dispatched.length, count); f.restart();
});
test("journal persistence failure prevents the first assembly dispatch", async t => {
  const f = fixture(t), review = await f.review(); fs.mkdirSync(f.filePath);
  await assert.rejects(f.apply(review)); assert.equal(f.world.dispatched.length, 0);
});
test("a corrupted manifest cannot override the singleton proven by assembly", async t => {
  const f = fixture(t), review = await f.review(); await f.apply(review);
  const journal = JSON.parse(fs.readFileSync(f.filePath)); journal.records[review.reviewID].manifest.targetHullID = 999;
  fs.writeFileSync(f.filePath, JSON.stringify(journal)); assert.throws(() => f.restart(), { code: "CUSTODY_JOURNAL_INVALID" });
});
test("a one-unit corporation hull may retain its item ID through withdrawal and assembly", async t => {
  const f = fixture(t, true); f.world.preserveSingletonID = true; f.world.source.find(r => r.itemID === 70).quantity = 1;
  const result = await f.apply(await f.review()); assert.equal(result.state, "COMPLETE"); assert.equal(result.manifest.targetHullID, 70);
  assert.equal(f.world.source.filter(r => r.typeID === 1).length, 0); assert.equal(f.world.context.shipID, 70); f.restart();
});
test("the same hull type with different equipment acquires a new hull without changing the original", async t => {
  const f = fixture(t); f.world.context.shipTypeID = 1; f.world.hangar[0].typeID = 1;
  const original = structuredClone(f.world.hangar[0]), review = await f.review();
  assert.equal(review.status.equipment, "MODIFIED"); assert.equal(review.plan.mode, "NEW_HULL");
  const result = await f.apply(review); assert.notEqual(result.manifest.targetHullID, 50);
  assert.deepEqual(f.world.hangar.find(r => r.itemID === 50), original); assert.equal(result.result.equipment, "VERIFIED"); f.restart();
});
test("unqualified singleton equipment is rejected in the plan before any hull mutation", async t => {
  const f = fixture(t); const source = f.world.hangar.find(r => r.typeID === 2); source.singleton = true; source.quantity = 1;
  const review = await f.review(); assert.equal(review.canApply, false); assert.match(review.plan.shortages.join(" "), /Singleton equipment sources are not qualified/);
  await assert.rejects(f.apply(review), { code: "REVIEW_REQUIRED" }); assert.equal(f.world.dispatched.length, 0);
});
