"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createStartupRuns } = require("./startupRuns");
const identity = { logicalRunID: "logical-member-run", accountID: 7, characterID: 10, scriptHash: "a".repeat(64), scriptRev: 1 };
const preparation = { ...identity, operationID: "operation", operationRunID: "operation-run",
  intent: { providerCharacterID: 11, fittingID: 4, source: { kind: "corp", corporationID: 20, division: 1 } } };
function disk(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-operation-startup-"));
  t.after(() => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true, force: true }); });
  return path.join(dir, "startup.json");
}

test("external preparation and ordinary Startup share one durable run without losing either writer's evidence", async () => {
  const runs = createStartupRuns(), prep = runs.openPreparation(preparation);
  const setup = { id: "undock", kind: "macro", macro: "undock", args: {} };
  const script = runs.open({ ...identity, steps: [setup], prefixLength: 1,
    program: [setup, { kind: "loop", body: [{ kind: "macro" }] }],
    adapters: { postcondition: () => true, actionSupported: () => true } });
  const memory = { position: { kind: "loop", node: 1, body: 0 }, board: {}, macroMem: {}, loopPass: 0,
    stepTicks: 0, cannotTellStreak: 0, latched: null };
  await assert.rejects(script.beforeIssue(setup, { kind: "undock" }, 1), /preparation is not ready/);
  await assert.rejects(script.checkpoint(memory), /preparation must complete before MAIN/);
  assert.equal(prep.begin({ before: 3200 }), 1);
  prep.update({ custodyOperationID: "shared-custody", requested: 1800 });
  prep.complete({ state: "VERIFIED", evidence: { after: 5000 } });
  assert.equal(await script.observe(setup, { flightStatus: { shipID: 50, docked: false } }), "COMPLETE");
  await script.checkpoint(memory);
  prep.enterMain();
  const row = runs.get(identity.logicalRunID);
  assert.equal(row.mainEntered, true); assert.equal(row.blocks.undock.state, "COMPLETE");
  assert.equal(row.preparation.mainEntered, true);
  assert.deepEqual(row.preparation.evidence, { before: 3200, custodyOperationID: "shared-custody", requested: 1800, after: 5000 });
  assert.throws(() => prep.begin(), /Completed preparation/);
  assert.throws(() => prep.update({ requested: 5000 }), /Only pending preparation/);
  assert.throws(() => prep.block({ reason: "Late old startup response" }), /stale startup response/);
});

test("pending preparation survives restart, pins accepted intent and requires reconciliation instead of another begin", t => {
  const filePath = disk(t), first = createStartupRuns({ filePath }).openPreparation(preparation);
  first.begin({ before: 3200 }); first.update({ custodyOperationID: "shared-transfer", requested: 1800 });
  const runs = createStartupRuns({ filePath }), restored = runs.openPreparation({ ...preparation, resumed: true });
  assert.throws(() => restored.begin(), /requires reconciliation/);
  assert.throws(() => restored.enterMain(), /must complete before MAIN/);
  restored.block({ state: "RECOVERY_REQUIRED", reason: "Readback remains ambiguous" });
  restored.update({ readback: "AMBIGUOUS" });
  assert.equal(restored.snapshot().invocation, 1);
  assert.throws(() => runs.openPreparation({ ...preparation, operationRunID: "replacement-run" }), /intent changed/);
  assert.throws(() => runs.openPreparation({ ...preparation, intent: { ...preparation.intent, fittingID: 5 } }), /intent changed/);
  assert.throws(() => runs.openPreparation({ ...preparation, logicalRunID: "new-member-run" }), /earlier operation preparation/);
  restored.complete({ state: "VERIFIED", evidence: { after: 5000, reconciled: true } });
  assert.equal(restored.snapshot().evidence.custodyOperationID, "shared-transfer");
  assert.equal(restored.snapshot().evidence.before, 3200);
  assert.equal(restored.snapshot().invocation, 1);
  restored.end();
  assert.throws(() => restored.complete({ state: "VERIFIED" }), /run ended/);
  const next = runs.openPreparation({ ...preparation, logicalRunID: "new-member-run", operationRunID: "new-operation-run" });
  assert.equal(next.snapshot().state, "PENDING");
});

test("credentials, missing restart checkpoint and failed durable begin cannot authorize preparation", t => {
  const filePath = disk(t), runs = createStartupRuns({ filePath });
  assert.throws(() => runs.openPreparation({ ...preparation, resumed: true }), /checkpoint is missing/);
  assert.throws(() => runs.openPreparation({ ...preparation, intent: { source: { kind: "corp", authorization: "browser-secret" } } }), /checkpoint is invalid/);
  const checkpoint = runs.openPreparation(preparation);
  assert.throws(() => checkpoint.begin({ claimSecret: "private-generation" }), /checkpoint is invalid/);
  assert.equal(checkpoint.snapshot().state, "PENDING");
  fs.mkdirSync(`${filePath}.${process.pid}.tmp`);
  assert.throws(() => checkpoint.begin({ custodyOperationID: "not-issued" }));
  assert.equal(checkpoint.snapshot().state, "PENDING");
  assert.equal(checkpoint.snapshot().invocation, 0);
});

test("blocked issued preparation preserves its durable custody fence through read-only recovery and another restart", t => {
  const filePath = disk(t), checkpoint = createStartupRuns({ filePath }).openPreparation(preparation);
  assert.throws(() => checkpoint.recover(), /Only an issued preparation/);
  checkpoint.begin({ before: 3200 });
  checkpoint.update({ custodyOperationID: "verified-partial-transfer", reviewHash: "b".repeat(64), ownerGeneration: "owner-1" });
  checkpoint.block({ reason: "Authoritative read failed after partial transfer" });
  const original = checkpoint.snapshot();
  const restored = createStartupRuns({ filePath }).openPreparation({ ...preparation, resumed: true });
  const recovering = restored.recover({ reconciliation: "READ_ONLY" });
  assert.equal(recovering.state, "RECOVERY_REQUIRED");
  assert.equal(recovering.invocation, 1); assert.equal(recovering.issuedAt, original.issuedAt);
  assert.deepEqual(recovering.evidence, { ...original.evidence, reconciliation: "READ_ONLY" });
  assert.throws(() => restored.begin(), /requires reconciliation/);
  const again = createStartupRuns({ filePath }).openPreparation({ ...preparation, resumed: true });
  assert.equal(again.snapshot().evidence.custodyOperationID, "verified-partial-transfer");
  again.recover({ ownerGeneration: "owner-2" });
  assert.equal(again.snapshot().invocation, 1);
  assert.equal(again.snapshot().evidence.reviewHash, original.evidence.reviewHash);
  assert.throws(() => again.recover({ claimSecret: "private" }), /checkpoint is invalid/);
  assert.equal(again.snapshot().evidence.ownerGeneration, "owner-2");
  again.complete({ state: "VERIFIED", evidence: { reconciled: true } });
  assert.throws(() => again.recover(), /Only an issued preparation/);
  again.enterMain();
  assert.throws(() => again.recover(), /Only an issued preparation/);
  assert.equal(again.snapshot().evidence.custodyOperationID, "verified-partial-transfer");
});

test("begin retains earlier credential-free observation evidence rather than replacing it", () => {
  const checkpoint = createStartupRuns().openPreparation(preparation);
  checkpoint.block({ evidence: { sourceObservation: "authoritative-empty-division" } });
  assert.throws(() => checkpoint.recover(), /Only an issued preparation/);
  checkpoint.begin({ ownerGeneration: "owner-1" });
  assert.deepEqual(checkpoint.snapshot().evidence, { sourceObservation: "authoritative-empty-division", ownerGeneration: "owner-1" });
  checkpoint.recover({ observed: true });
  assert.equal(checkpoint.snapshot().invocation, 1);
});

test("corrupt preparation readiness cannot survive journal validation", t => {
  const filePath = disk(t), runs = createStartupRuns({ filePath });
  runs.openPreparation(preparation);
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  value.records[identity.logicalRunID].preparation.mainEntered = true;
  fs.writeFileSync(filePath, JSON.stringify(value));
  assert.throws(() => createStartupRuns({ filePath }), /checkpoint is invalid/);
});
