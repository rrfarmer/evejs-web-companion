import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { miningFreightTelemetry } from "../operations/miningTelemetry.ts";
import { deleteFleetExecution } from "./executionDocuments.ts";
import { createOperation, type DeliveryEvidence, type Manifest, type Member } from "./operation.ts";
import { deliveryReceiptIndex, fleetOperationStore, fleetRunResult } from "./operationStore.ts";
import { createMiningFleetRuntime } from "./runtime.ts";
import { createTargetBoard, type Target } from "./targetBoard.ts";

const { createDocumentStore } = createRequire(import.meta.url)("../documentStore.cjs") as {
  createDocumentStore(path: string): Parameters<typeof deleteFleetExecution>[0] & { close(): void };
};
const definition = {
  operationID: "fleet", runID: "run", systemID: 300, destinationID: 600,
  members: [{ characterID: 1, shipID: 11, role: "MINER" }, { characterID: 2, shipID: 12, role: "HAULER" }] as Member[],
};
const target: Target = { kind: "BELT", systemID: 300, name: "Ore" };
const stateKey = 'mining-fleet-operation:["fleet","run"]';
const item = { itemID: 21, typeID: 1230, quantity: 100, unitVolumeM3: 0.1, freightKind: "RAW" as const };
const receipt = (containerID: number, claimGeneration = 1): DeliveryEvidence => ({
  source: "native-transfer", operationID: "fleet", runID: "run", containerID, claimGeneration,
  shipID: 12, destinationID: 600, observedAt: 1100, sourceAfter: [],
  destinationBefore: [], destinationAfter: [{ typeID: item.typeID, quantity: item.quantity }],
});

function fixture() {
  const db = createDocumentStore(":memory:");
  const reads: string[] = [], writes: string[] = [];
  let failStateWrite = false, time = 1100;
  const storage = { ...db, document(name: string) {
    const document = db.document(name);
    return {
      read() { reads.push(name); return document.read(); },
      write(value: unknown) {
        writes.push(name);
        if (failStateWrite && name === stateKey) throw Error("operation write failed");
        document.write(value);
      },
    };
  } };
  const store = fleetOperationStore(storage, definition.operationID, definition.runID);
  const board = createTargetBoard(storage.document("mining-fleet-targets"), () => time);
  const open = () => createOperation(store, board, definition, () => time);
  const op = open(), claim = op.reserve(1, target)!;
  assert.ok(op.activate(1));
  const can = { containerID: 100, ownerID: 1, observedAt: 1000, capacityM3: 100, items: [item] };
  assert.ok(op.registerGridJetcan(2, claim, can));
  return { db, storage, store, open, op, reads, writes,
    advance: () => { time += 8000; }, now: () => time, failStateWrite: (fail: boolean) => { failStateWrite = fail; } };
}

test("a large legacy archive migrates once and stays out of snapshots, claim renewal and status", t => {
  const f = fixture();
  t.after(() => f.db.close());
  const snapshot = f.op.snapshot(), pending = snapshot.manifests[0]!;
  const manifests: Manifest[] = Array.from({ length: 77 }, (_, index) => ({
    ...pending, containerID: 100 + index, delivered: true, volumeM3: 40.6, items: Array.from({ length: 4 }, (_, stack) => ({
      ...item, itemID: item.itemID + index * 10 + stack, quantity: item.quantity + stack,
    })),
  }));
  const inventory = Array.from({ length: 1250 }, (_, index) => ({
    itemID: 9123400000100 + index, typeID: 1230, ownerID: 98000001, locationID: 66000001,
    flagID: 115, quantity: 2000 + index, categoryID: 25,
  }));
  const stock = inventory.reduce((units, stack) => units + stack.quantity, 0);
  const receipts = manifests.slice(0, 76).map((manifest, index): DeliveryEvidence => {
    const moved = manifest.items.map(({ itemID, typeID, quantity }) => ({ itemID, typeID, quantity }));
    return {
      ...receipt(manifest.containerID, index + 1), observedAt: 1100 + index,
      destinationBefore: [{ typeID: item.typeID, quantity: stock }],
      destinationAfter: [{ typeID: item.typeID, quantity: stock + moved.reduce((units, row) => units + row.quantity, 0) }],
      deliveryBatches: [{
        item: moved[0]!, items: moved, sourceAfter: [],
        sourceBefore: moved.map(row => ({ ...row, ownerID: 2, locationID: 12, flagID: 134, categoryID: 25 })),
        destinationBefore: inventory,
        destinationAfter: [...inventory, ...moved.map(row => ({ ...row, ownerID: 98000001, locationID: 66000001, flagID: 115, categoryID: 25 }))],
      }],
    };
  });
  const legacy = { ...snapshot, manifests, deliveryReceipts: receipts };
  const json = JSON.stringify(legacy);
  const oldBytes = Buffer.byteLength(json);
  assert.ok(oldBytes > 23_000_000);
  f.db.document(stateKey).write(legacy);

  const runtime = createMiningFleetRuntime({
    storage: f.storage, async createCycle() { assert.fail("status acquired a pilot"); },
    async settle() { assert.fail("status attempted settlement"); },
  });
  const migrated = runtime.operationSnapshot(definition.operationID, definition.runID)!;
  assert.equal(Object.hasOwn(migrated, "deliveryReceipts"), false);
  const newBytes = Buffer.byteLength(JSON.stringify(migrated));
  assert.ok(newBytes < 100_000);
  assert.equal(f.writes.filter(name => name.startsWith("mining-delivery-receipt:")).length, receipts.length);

  const active = f.open();
  const quantity = (rows: readonly Manifest[]) => rows.filter(m => m.delivered)
    .reduce((total, manifest) => total + manifest.items.reduce((units, stack) => units + stack.quantity, 0), 0);
  f.reads.length = 0;
  f.writes.length = 0;
  for (let pass = 0; pass < 3; pass++) {
    f.advance();
    assert.ok(active.assignment(1)?.targetGranted);
    assert.equal(quantity(active.snapshot().manifests), quantity(manifests));
    assert.ok(active.heartbeat());
    const status = runtime.operationSnapshot(definition.operationID, definition.runID);
    assert.deepEqual(status, active.snapshot());
    const { history } = miningFreightTelemetry(status);
    assert.equal(history.length, manifests.length);
    assert.equal(history.filter(h => h.evidence.receiptAvailable).length, receipts.length);
    assert.ok(Buffer.byteLength(JSON.stringify(history)) < 50_000);
    assert.equal(history[0]!.evidence.timestampSource, "original-publication");
  }
  assert.equal(f.writes.filter(name => name === stateKey).length, 3);
  assert.ok([...f.reads, ...f.writes].every(name => !name.startsWith("mining-delivery-receipt:")));
  assert.ok(Buffer.byteLength(JSON.stringify(f.db.document(stateKey).read())) < 100_000);

  const newContainer = 200;
  assert.ok(active.registerGridJetcan(2, active.snapshot().claim!, {
    containerID: newContainer, ownerID: 1, observedAt: f.now(), capacityM3: 100, items: [item],
  }));
  const pickup = active.claimContainer(2, newContainer)!;
  assert.ok(active.dispatchHaul(2, newContainer, pickup.generation));
  const newReceipt = { ...receipt(newContainer, pickup.generation), observedAt: f.now() };
  f.reads.length = 0;
  f.writes.length = 0;
  assert.ok(active.markDelivered(2, newReceipt));
  assert.deepEqual(f.writes, ['mining-delivery-receipt:["fleet","run",200]', stateKey]);
  assert.ok(f.reads.every(name => !name.startsWith("mining-delivery-receipt:")));

  const keys = runtime.deliveryReceiptIndex(definition.operationID);
  assert.equal(keys.length, receipts.length + 1);
  for (const expected of [...receipts, newReceipt])
    assert.deepEqual(runtime.deliveryReceipt(definition.operationID, definition.runID, expected.containerID)?.receipt, expected);
  assert.equal(runtime.deliveryReceipt(definition.operationID, definition.runID, 176), null);
  const oldRunID = "previous";
  const oldProof = { ...receipts[0]!, runID: oldRunID };
  const oldKey = 'mining-delivery-receipt:["fleet","previous",100]';
  f.db.document(oldKey).write({ manifest: { ...manifests[0]!, runID: oldRunID }, receipt: oldProof });
  assert.deepEqual(runtime.completedFleetResult(definition.operationID), {
    runID: oldRunID, observedAt: oldProof.observedAt, deliveredContainers: 1, deliveredUnits: 406,
    deliveredVolumeM3: 40.6, unitsByType: { "1230": 406 }, trips: null,
  });
  assert.equal(f.db.document(oldKey).read(), null);
  assert.ok(runtime.deliveryReceipt(definition.operationID, definition.runID, newContainer));

  if (process.env.WC76_ARCHIVE_BENCHMARK === "1") {
    const before = JSON.parse(json), after = migrated;
    const median = (value: unknown, iterations: number) => {
      const times: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        structuredClone(value);
        times.push(performance.now() - start);
      }
      return times.sort((a, b) => a - b)[Math.floor(iterations / 2)]!.toFixed(3);
    };
    t.diagnostic(`state bytes ${oldBytes} -> ${newBytes}, structuredClone median ${median(before, 7)} -> ${median(after, 101)} ms`);
  }
});

test("a new delivery writes its exact receipt and compact state in one SQLite commit", t => {
  const f = fixture();
  t.after(() => f.db.close());
  const claim = f.op.claimContainer(2, 100)!;
  assert.ok(f.op.dispatchHaul(2, 100, claim.generation));
  const before = f.op.snapshot(), proof = receipt(100, claim.generation);
  assert.equal(f.op.markDelivered(2, { ...proof, destinationAfter: [] }), false);

  f.failStateWrite(true);
  assert.throws(() => f.op.markDelivered(2, proof), /operation write failed/);
  assert.deepEqual(f.op.snapshot(), before);
  assert.deepEqual(f.db.document(stateKey).read(), before);
  assert.deepEqual(deliveryReceiptIndex(f.storage, definition.operationID), []);

  f.failStateWrite(false);
  assert.ok(f.op.markDelivered(2, proof));
  const after = f.open().snapshot();
  assert.equal(Object.hasOwn(after, "deliveryReceipts"), false);
  assert.equal(after.haulClaims["100"], undefined);
  assert.deepEqual(after.manifests[0], { ...before.manifests[0], delivered: true, deliveredAt: proof.observedAt });
  assert.deepEqual(f.store.readDelivery(100), { manifest: after.manifests[0], receipt: proof });
  assert.equal(f.op.markDelivered(2, proof), false);
  assert.equal(deliveryReceiptIndex(f.storage, definition.operationID).length, 1);
});

test("legacy cleanup waits for Stop and an exact transfer outcome, then retains only totals", t => {
  const f = fixture();
  t.after(() => f.db.close());
  const active = f.op.snapshot(), proof = receipt(100);
  const manifest = { ...active.manifests[0]!, delivered: true };
  const legacy = { ...active, manifests: [manifest], deliveryReceipts: [proof] };
  f.db.document(stateKey).write(legacy);
  f.failStateWrite(true);
  assert.throws(() => f.store.read(), /operation write failed/);
  assert.deepEqual(f.db.document(stateKey).read(), legacy);
  assert.deepEqual(f.db.documentNames("mining-delivery-receipt:"), []);

  f.failStateWrite(false);
  assert.throws(() => deleteFleetExecution(f.storage, definition.operationID, definition.runID), /Unfinished fleet/);
  const finished = { ...legacy, state: "STOPPED", claim: null, settled: [1, 2], parked: [1, 2], settledAt: { 1: 1200, 2: 1300 } };
  f.db.document(stateKey).write(finished);
  const pending = f.db.document('mining-fleet-haul:["fleet","run",101,2,2,12]');
  pending.write({ pending: { kind: "delivery" } });
  assert.throws(() => deleteFleetExecution(f.storage, definition.operationID, definition.runID), /unconfirmed inventory transfer/);
  assert.deepEqual(f.db.document(stateKey).read(), finished);
  assert.deepEqual(pending.read(), { pending: { kind: "delivery" } });
  pending.write({ pending: null });
  deleteFleetExecution(f.storage, definition.operationID, definition.runID);
  assert.equal(f.db.document(stateKey).read(), null);
  assert.deepEqual(deliveryReceiptIndex(f.storage, definition.operationID), []);
  assert.equal(f.store.readDelivery(100), null);
  const totals = { runID: "run", observedAt: 1300, deliveredContainers: 1, deliveredUnits: 100,
    deliveredVolumeM3: 10, unitsByType: { "1230": 100 }, trips: null };
  assert.deepEqual(fleetRunResult(f.storage, definition.operationID), totals);
  deleteFleetExecution(f.storage, definition.operationID, definition.runID);
  assert.deepEqual(fleetRunResult(f.storage, definition.operationID, definition.runID), totals);
});

test("completed runs count a shared Hauler trip once and include verified Self Unload totals", t => {
  const f = fixture();
  t.after(() => f.db.close());
  const active = f.op.snapshot(), trips = [["visit-one"], ["visit-one", "visit-two"], ["visit-two"]];
  const manifests = trips.map((_, i)=>({ ...active.manifests[0]!, containerID: 100 + i, delivered: true }));
  const stopped = { ...active, state: "STOPPED" as const, claim: null, manifests,
    settled: [1, 2], parked: [1, 2], settledAt: { 1: 1200, 2: 1300 } };
  for (const [i, manifest] of manifests.entries()) {
    const deliveryBatches = trips[i]!.map(tripID => ({
      tripID, item, sourceBefore: [], sourceAfter: [], destinationBefore: [], destinationAfter: [],
    }));
    f.store.recordDelivery(stopped, { manifest, receipt: { ...receipt(manifest.containerID), deliveryBatches } });
  }
  const identity = '["fleet","run",1,11]';
  f.db.document("mining-fleet-self-unload:" + identity).write({version:1,identity,nextOrdinal:2,pending:null,
    totals:{trips:1,unitsByType:{"1230":7},volumeM3:.7}});
  deleteFleetExecution(f.storage, definition.operationID, definition.runID);
  assert.deepEqual(fleetRunResult(f.storage, definition.operationID), {
    runID: "run", observedAt: 1300, deliveredContainers: 3, deliveredUnits: 307,
    deliveredVolumeM3: 30.7, unitsByType: { "1230": 307 }, trips: 3,
  });
  assert.deepEqual(f.db.documentNames("mining-delivery-receipt:"), []);
});
