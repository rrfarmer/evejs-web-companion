"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createBeltMemory } = require("../src/beltMemory");
const { createMiningOperationStore } = require("../src/miningOperationStore");
const { createMiningTargetBoard } = require("../src/miningTargetBoard");
const { createMiningOperations, auditMiningScript, operationRoutineCompatibility } = require("../src/miningOperations");

function clock(start = 1_000_000) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

function member(characterID, role, automationID = `script-${characterID}`) {
  return { characterID, characterName: `Pilot ${characterID}`, accountName: `account-${characterID}`, role, automationID };
}

function definition(operationID, members, unloadPolicy = "SELF_UNLOAD", targetClasses = ["BELT"]) {
  return {
    operationID,
    name: `Operation ${operationID}`,
    area: { anchorSystemID: 30000142, anchorSystemName: "Jita", reach: "CURRENT_SYSTEM", targetClasses },
    targetPolicy: "ANY_ELIGIBLE",
    unloadPolicy,
    members,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
const resolveSystem = (id) => Number(id) === 30000142 ? { solarSystemID: 30000142, solarSystemName: "Jita" } : null;

function harness(definitions, options = {}) {
  const byID = new Map(definitions.map((row) => [row.operationID, row]));
  const c = options.clock || clock();
  const board = createMiningTargetBoard({ now: c.now, leaseMs: options.leaseMs || 1_000 });
  const belts = createBeltMemory({ now: c.now, ttlMs: options.beltTtlMs || 10_000 });
  const operations = createMiningOperations({
    store: {
      get: (id) => byID.get(String(id)) || null,
      list: () => [...byID.values()],
      remove: (id) => byID.delete(String(id)),
    },
    targetBoard: board,
    beltMemory: belts,
    now: c.now,
  });
  return { operations, board, belts, clock: c };
}

function startAll(h, operationID, classes = ["BELT"]) {
  const def = h.operations.definition(operationID);
  assert.equal(h.operations.begin(operationID, classes).ok, true);
  for (const row of def.members) h.operations.memberStarted(operationID, row.characterID, `bot-${row.characterID}`);
  h.operations.finishLaunch(operationID);
}

function belt(name = "Asteroid Belt 1") {
  return { targetType: "BELT", systemID: 30000142, systemName: "Jita", targetName: name };
}

function anomaly(name = "ABC-123") {
  return { targetType: "ORE_ANOMALY", systemID: 30000142, systemName: "Jita", targetName: name };
}

test("unsupported Defender remains an operation failure without blocking executable-member preparation", () => {
  const h=harness([definition("prep-defender",[member(1,"MINER"),member(2,"DEFENDER")])]);
  startAll(h,"prep-defender");h.operations.memberFailed("prep-defender",2,{code:"MEMBER_NOT_EXECUTABLE",message:"Defender unsupported"});
  const projected=h.operations.list([{operationID:"prep-defender",characterID:1,botID:"bot-1",status:"running",endedAt:null,
    preparation:{state:"VERIFIED",equipment:"VERIFIED",supplies:"FULL",targets:[]}}])[0].runtime;
  assert.equal(projected.state,"DEGRADED");assert.equal(projected.members.find(row=>row.role==="DEFENDER").preparation.state,"BLOCKED");
  assert.equal(projected.preparation.state,"VERIFIED");assert.deepEqual(projected.preparation.members.map(row=>row.characterID),[1]);
});

test("aggregate preparation exposes PREPARING and respects recovery/blocked precedence over it", () => {
  for(const [states,expected] of [
    [["PREPARING","PENDING"],"PREPARING"], [["VERIFIED","PREPARING"],"PREPARING"],
    [["PREPARING","BLOCKED"],"BLOCKED"], [["PREPARING","RECOVERY_REQUIRED"],"RECOVERY_REQUIRED"],
    [["BLOCKED","RECOVERY_REQUIRED"],"RECOVERY_REQUIRED"], [["VERIFIED","PENDING"],"PENDING"],
    [["VERIFIED","DEGRADED"],"DEGRADED"], [["VERIFIED","VERIFIED"],"VERIFIED"],
  ]) {
    const h=harness([definition("prep-aggregate",[member(1,"MINER"),member(2,"MINER")])]);startAll(h,"prep-aggregate");
    const projected=h.operations.list(states.map((state,index)=>({operationID:"prep-aggregate",characterID:index+1,botID:`bot-${index+1}`,
      status:"starting",endedAt:null,preparation:{state,equipment:"UNKNOWN",supplies:"UNKNOWN",targets:[]}})))[0].runtime;
    assert.equal(projected.preparation.state,expected,states.join(" + "));assert.deepEqual(projected.preparation.members.map(row=>row.state),states);
  }
});

test("operation definitions save, reload, and retain stable automation references without copying scripts", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mining-operations-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createMiningOperationStore({ dataDir: dir, uuid: () => "op-1", now: () => "2026-01-01T00:00:00.000Z", resolveSystem });
  const saved = store.save(definition(undefined, [member(1, "MINER")], "SELF_UNLOAD"));
  assert.equal(saved.operationID, "op-1");
  assert.deepEqual(saved.members[0], { ...member(1, "MINER"), routineMode: "CUSTOM" });
  assert.equal(Object.hasOwn(saved.members[0], "script"), false);
  const reloaded = createMiningOperationStore({ dataDir: dir }).get("op-1");
  assert.deepEqual(reloaded, saved);
});

test("Standard member mode and canonical explicit unload destination persist without a saved script", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mining-standard-definition-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createMiningOperationStore({ dataDir: dir, resolveSystem,
    resolveStation: (id) => Number(id) === 60000004
      ? { stationID: 60000004, stationName: "Jita Station", solarSystemID: 30000142 } : null });
  const saved = store.save({ ...definition("standard", [
    { ...member(1, "MINER", ""), routineMode: "STANDARD" },
    { ...member(2, "HAULER", ""), routineMode: "STANDARD" },
  ], "HAULER_SERVICE"), unloadDestination: { stationID: 60000004, corporationDivision: 1, corporationID: 98000001 } });
  assert.deepEqual(saved.members.map((row) => [row.routineMode, row.automationID]), [["STANDARD", ""], ["STANDARD", ""]]);
  assert.deepEqual(saved.unloadDestination, { stationID: 60000004, stationName: "Jita Station", systemName: "Jita", corporationDivision: 1, corporationID: 98000001 });
  assert.deepEqual(createMiningOperationStore({ dataDir: dir }).get("standard"), saved);
  const personal = store.save({ ...saved, unloadDestination: { stationID: 60000004, corporationDivision: null } });
  assert.deepEqual(personal.unloadDestination, { stationID: 60000004, stationName: "Jita Station", systemName: "Jita", corporationDivision: null, corporationID: null });
  assert.deepEqual(createMiningOperationStore({ dataDir: dir }).get("standard"), personal);
  assert.throws(() => store.save({ ...saved, unloadDestination: { stationID: 60000004, stationName: "Wrong", corporationDivision: 1, corporationID: 98000001 } }), /name and ID do not match/);
});

test("operation validation preserves all explicit roles and requires policy-compatible membership", () => {
  const value = definition("roles", [member(1, "MINER"), member(2, "HAULER"), member(3, "DEFENDER")], "HAULER_SERVICE");
  const normalized = require("../src/miningOperationStore").normalizeDefinition(value, null, () => "now", () => "roles", resolveSystem);
  assert.deepEqual(normalized.members.map((row) => row.role), ["MINER", "HAULER", "DEFENDER"]);
  const unassignedDefender = { ...value, members: value.members.map((row) => row.role === "DEFENDER" ? { ...row, automationID: "" } : row) };
  assert.equal(require("../src/miningOperationStore").normalizeDefinition(unassignedDefender, null, () => "now", () => "roles", resolveSystem).members[2].automationID, "");
  assert.throws(() => require("../src/miningOperationStore").normalizeDefinition(
    definition("bad", [member(1, "MINER")], "HAULER_SERVICE"), null, () => "now", () => "bad", resolveSystem,
  ), /HAULER/);
  assert.throws(() => require("../src/miningOperationStore").normalizeDefinition(
    { ...value, area: { ...value.area, anchorSystemName: "Wrong" } }, null, () => "now", () => "bad", resolveSystem,
  ), /name and ID/);
});

test("multiple independent operations share one target board and only one atomically reserves a target", () => {
  const a = definition("a", [member(1, "MINER")]);
  const b = definition("b", [member(2, "MINER")]);
  const h = harness([a, b]);
  startAll(h, "a");
  startAll(h, "b");
  assert.equal(h.operations.reserveCandidate("a", 1, belt()).acquired, true);
  const denied = h.operations.reserveCandidate("b", 2, belt());
  assert.equal(denied.acquired, false);
  assert.equal(denied.reason, "CLAIMED");
  assert.equal(h.board.list()[0].claimedByOperationID, "a");
});

test("one operation exposes exactly one current target to every member", () => {
  const def = definition("one", [member(1, "MINER"), member(2, "MINER")]);
  const h = harness([def]);
  startAll(h, "one");
  h.operations.reserveCandidate("one", 1, belt("Belt III"));
  assert.equal(h.operations.assignment("one", 1).currentTarget.targetName, "Belt III");
  assert.equal(h.operations.assignment("one", 2).currentTarget.targetName, "Belt III");
  assert.equal(h.operations.reserveCandidate("one", 2, belt("Belt IV")).target.targetName, "Belt III");
});

test("abandoned claims expire, while depleted evidence survives lease and claim release", () => {
  const c = clock();
  const board = createMiningTargetBoard({ now: c.now, leaseMs: 100 });
  const first = board.reserve("a", belt());
  c.advance(101);
  assert.equal(board.reserve("b", belt()).acquired, true);
  board.markDepleted("b", first.target.targetKey, { source: "scanner/grid" }, true);
  c.advance(101);
  const row = board.get(first.target.targetKey);
  assert.equal(row.state, "DEPLETED");
  assert.equal(row.claimedByOperationID, null);
  assert.deepEqual(row.depletionEvidence, { source: "scanner/grid" });
});

test("an operation that misses its heartbeat never keeps acting on a claim it lost", () => {
  const h = harness([definition("lost", [member(1, "MINER")])], { leaseMs: 100 });
  startAll(h, "lost");
  h.operations.reserveCandidate("lost", 1, belt());
  h.clock.advance(101);
  const assignment = h.operations.assignment("lost", 1);
  assert.equal(assignment.currentTarget, null);
  assert.equal(assignment.state, "DEGRADED");
  assert.equal(h.operations.runtimeFor("lost").history.at(-1).kind, "TARGET_CLAIM_LOST");
});

test("operation can provenance records only current miners on a claimed target and clears on Stop", () => {
  const h = harness([definition("cans", [member(1, "MINER"), member(2, "HAULER")], "HAULER_SERVICE")]);
  startAll(h, "cans");
  h.operations.reserveCandidate("cans", 1, belt());
  assert.equal(h.operations.registerContainer("cans", 2, 500, 30000142), false);
  assert.equal(h.operations.registerContainer("cans", 1, 500, 30001401), false);
  assert.equal(h.operations.registerContainer("cans", 1, 500, 30000142), true);
  assert.deepEqual(h.operations.assignment("cans", 2).ownedContainerIDs, [500]);
  assert.deepEqual(h.operations.assignment("cans", 2).miningOwnerIDs, [1]);
  h.operations.blockContainerProvenance("cans");
  assert.equal(h.operations.assignment("cans", 2).containerProvenanceUnconfirmed, true);
  h.operations.beginStop("cans");
  h.operations.finishStop("cans", []);
  assert.equal(h.operations.runtimeFor("cans").ownedContainers.size, 0);
});

test("recovered proven can registration cannot attach to another target or reservation generation", () => {
  const h = harness([definition("custody", [member(1, "MINER"), member(2, "HAULER")], "HAULER_SERVICE")]);
  startAll(h, "custody"); h.operations.reserveCandidate("custody", 1, belt());
  const target = h.operations.assignment("custody", 1).currentTarget;
  assert.equal(h.operations.registerContainer("custody", 1, 500, 30000142, "another", target.claimedAt), false);
  assert.equal(h.operations.registerContainer("custody", 1, 500, 30000142, target.targetKey, target.claimedAt + 1), false);
  assert.equal(h.operations.registerContainer("custody", 1, 500, 30000142, target.targetKey, target.claimedAt), true);
  assert.equal(h.operations.registerContainer("custody", 1, 500, 30000142, target.targetKey, target.claimedAt), true);
  assert.deepEqual(h.operations.assignment("custody", 2).ownedContainerIDs, [500]);
});

test("a surviving hosted miner renews a degraded operation's claim despite failed fleet members", () => {
  const h = harness([definition("partial", [member(1, "MINER"), member(2, "MINER")])], { leaseMs: 100 });
  h.operations.begin("partial", ["BELT"]);
  h.operations.memberStarted("partial", 1, "bot-1");
  h.operations.memberFailed("partial", 2, { code: "BOT_START_FAILED", message: "Gateway refused selection" });
  h.operations.finishLaunch("partial");
  const target = h.operations.reserveCandidate("partial", 1, belt()).target;
  for (let i = 0; i < 3; i++) {
    h.clock.advance(75);
    h.operations.renewHostedClaims([{ operationID: "partial", characterID: 1, status: "running", endedAt: null }]);
    assert.equal(h.board.get(target.targetKey).claimedByOperationID, "partial");
  }
  assert.equal(h.operations.assignment("partial", 1).currentTarget.targetKey, target.targetKey);
  assert.equal(h.operations.runtimeFor("partial").state, "DEGRADED");
  assert.equal(h.operations.runtimeFor("partial").members.get(2).failureCode, "BOT_START_FAILED");
});

test("host heartbeat preserves an unclaimed depleted SELF_UNLOAD rendezvous", () => {
  const h = harness([definition("unload", [member(1, "MINER")])], { leaseMs: 100 });
  startAll(h, "unload");
  const target = h.operations.reserveCandidate("unload", 1, belt()).target;
  h.operations.depleteTarget("unload", 1, target.targetKey, { empty: true });
  assert.equal(h.board.get(target.targetKey).state, "DEPLETED");
  h.operations.renewHostedClaims([{ operationID: "unload", characterID: 1, status: "running", endedAt: null }]);
  assert.equal(h.operations.runtimeFor("unload").state, "UNLOADING");
  assert.equal(h.operations.assignment("unload", 1).currentTarget.state, "DEPLETED");
});

test("botHost lowercase running projection still counts miners and haulers for depletion", () => {
  const h = harness([definition("haul-live", [member(1, "MINER"), member(2, "HAULER")], "HAULER_SERVICE")]);
  startAll(h, "haul-live");
  const target = h.operations.reserveCandidate("haul-live", 1, belt()).target;
  h.operations.list([1, 2].map((id) => ({ operationID: "haul-live", characterID: id, botID: `bot-${id}`,
    status: "running", phase: "Mining", why: null, startedAt: "now", endedAt: null })));
  assert.equal(h.operations.depleteTarget("haul-live", 1, target.targetKey, { partialDumpConfirmed: true }), true);
  assert.equal(h.operations.runtimeFor("haul-live").drainingTargets.length, 1);
});

test("aggregate status follows active mining body, not a hauler's phase or an earlier transient", () => {
  const a = definition("a", [member(1, "MINER"), member(2, "MINER"), member(3, "HAULER")], "HAULER_SERVICE");
  const b = definition("b", [member(4, "MINER"), member(5, "HAULER")], "HAULER_SERVICE");
  const h = harness([a, b]);
  startAll(h, "a"); startAll(h, "b");
  const first = h.operations.reserveCandidate("a", 1, belt("Belt I")).target;
  const second = h.operations.reserveCandidate("b", 4, belt("Belt II")).target;
  h.operations.activateTarget("a", 1, first.targetKey);
  h.operations.activateTarget("b", 4, second.targetKey);
  h.operations.memberFailed("a", 2, { code: "TRANSIENT", message: "Earlier startup failure" });
  const bots = [
    [1, "a", "Mining"], [2, "a", "Mining"], [3, "a", "Unloading"],
    [4, "b", "Approaching a rock"], [5, "b", "Looting"],
  ].map(([id, operationID, phase]) => ({ operationID, characterID: id, botID: `bot-${id}`,
    status: "running", phase, why: null, startedAt: "now", endedAt: null }));
  let projected = h.operations.list(bots);
  assert.equal(projected.find((row) => row.definition.operationID === "a").runtime.state, "MINING");
  assert.equal(projected.find((row) => row.definition.operationID === "b").runtime.state, "MINING");
  assert.equal(h.operations.runtimeFor("a").members.get(2).failureCode, null);
  h.operations.memberFailed("a", 2, { code: "FAILED", message: "Actually unavailable" });
  projected = h.operations.list(bots.filter((bot) => bot.characterID !== 2));
  assert.equal(projected.find((row) => row.definition.operationID === "a").runtime.state, "DEGRADED");
  assert.match(projected.find((row) => row.definition.operationID === "a").runtime.statusReason, /Pilot 2.*Actually unavailable/);
  assert.equal(projected.find((row) => row.definition.operationID === "b").runtime.state, "MINING");
  h.operations.beginStop("a"); h.operations.finishStop("a", []);
  projected = h.operations.list(bots.filter((bot) => bot.operationID === "b"));
  assert.equal(projected.find((row) => row.definition.operationID === "a").runtime.state, "STOPPED");
  assert.equal(projected.find((row) => row.definition.operationID === "b").runtime.state, "MINING");
  assert.equal(h.board.get(second.targetKey).claimedByOperationID, "b");
});

test("claim loss invalidates current target, rejects stale reservation and depletion, and records history once", () => {
  const h = harness([definition("stale", [member(1, "MINER")])], { leaseMs: 100 });
  startAll(h, "stale");
  const target = h.operations.reserveCandidate("stale", 1, belt()).target;
  h.clock.advance(101);
  assert.equal(h.operations.reserveCandidate("stale", 1, belt("Belt II")).reason, "TARGET_CLAIM_LOST");
  assert.equal(h.operations.assignment("stale", 1).currentTarget, null);
  assert.equal(h.operations.depleteTarget("stale", 1, target.targetKey, { empty: true }), false);
  assert.deepEqual(h.belts.dryBelts("Jita"), []);
  assert.equal(h.operations.runtimeFor("stale").history.filter((row) => row.kind === "TARGET_CLAIM_LOST").length, 1);
  assert.equal(h.operations.reserveCandidate("stale", 1, belt("Belt II")).acquired, true);
  assert.equal(h.operations.runtimeFor("stale").state, "DEGRADED");
});

test("belt depletion is written through existing belt memory and its TTL clears the board projection", () => {
  const h = harness([definition("a", [member(1, "MINER")])], { beltTtlMs: 100 });
  startAll(h, "a");
  const reserved = h.operations.reserveCandidate("a", 1, belt());
  h.operations.activateTarget("a", 1, reserved.target.targetKey);
  h.operations.depleteTarget("a", 1, reserved.target.targetKey, { empty: true });
  h.operations.markReady("a", 1);
  assert.equal(h.belts.dryBelts("Jita")[0].beltName, "Asteroid Belt 1");
  assert.equal(h.board.get(reserved.target.targetKey).state, "DEPLETED");
  h.clock.advance(101);
  assert.equal(h.operations.reserveCandidate("a", 1, belt()).acquired, true, "belt memory's expiry owns respawn eligibility");
});

test("ore anomaly requires authoritative site identity; a label alone is not executable", () => {
  const def = definition("site", [member(1, "MINER")], "SELF_UNLOAD", ["ORE_ANOMALY"]);
  const h = harness([def]);
  assert.equal(h.operations.begin("site", ["ORE_ANOMALY"]).ok, true);
  assert.equal(h.operations.reserveCandidate("site", 1, anomaly()).acquired, false);
});

for (const family of ["ORE_ANOMALY", "ICE"]) {
  test(`${family}: atomic identity, clearance, same-family relocation, tail and scoped stop`, () => {
    const defs = [definition("a", [member(1, "MINER"), member(2, "MINER"), member(3, "HAULER")], "HAULER_SERVICE", [family]),
      definition("b", [member(4, "MINER"), member(5, "HAULER")], "HAULER_SERVICE", [family])];
    const h = harness(defs);
    startAll(h, "a", [family]); startAll(h, "b", [family]);
    const site = (instanceID = 101) => ({ targetType: family, targetName: "ABC-123", systemID: 30000142, systemName: "Jita",
      siteID: 100, instanceID, siteIdentity: `site:100:instance:${instanceID}`, position: { x: 1000, y: 0, z: 0 } });
    const first = h.operations.reserveCandidate("a", 1, site());
    assert.equal(first.acquired, true);
    assert.equal(h.operations.reserveCandidate("b", 4, { ...site(), targetName: "changed scanner label" }).acquired, false);
    assert.equal(h.operations.activateTarget("a", 1, first.target.targetKey), true);
    assert.equal(h.operations.depleteTarget("a", 1, first.target.targetKey, { scannerDisappeared: true, scannerMissingReads: 3 }), true);
    assert.equal(h.operations.runtimeFor("a").rendezvous.ready.length, 0, "disappearance does not prove partial-hold clearance");
    assert.equal(h.operations.finishDrain("a", 3, first.target.targetKey), false, "a tail cannot close while Ice cycles / partial dumps are pending");
    h.operations.depleteTarget("a", 1, first.target.targetKey, { partialDumpConfirmed: true });
    assert.notEqual(h.operations.runtimeFor("a").currentTarget, null);
    h.operations.depleteTarget("a", 2, first.target.targetKey, { partialDumpConfirmed: true });
    assert.equal(h.operations.runtimeFor("a").currentTarget, null);
    assert.equal(h.operations.reserveCandidate("a", 1, belt()).acquired, false);
    const next = h.operations.reserveCandidate("a", 1, site(102));
    assert.equal(next.acquired, true, "new instance with same display label is not poisoned");
    const tail = h.operations.assignment("a", 3);
    assert.equal(tail.logisticsTarget.targetKey, first.target.targetKey);
    assert.equal(tail.currentTarget.targetKey, next.target.targetKey);
    h.operations.finishDrain("a", 3, first.target.targetKey);
    assert.equal(h.operations.assignment("a", 3).logisticsTarget, null);
    const reappeared = h.operations.reserveCandidate("b", 4, { ...site(), position: { x: 5000, y: 0, z: 0 } });
    assert.equal(reappeared.acquired, true, "confirmed disappearance can reset a reappeared site");
    assert.equal(reappeared.target.position.x, 5000, "fresh scanner coordinates replace the previous incarnation");
    const other = h.operations.runtimeFor("b").currentTarget.targetKey;
    h.operations.beginStop("a");
    assert.equal(h.board.get(other).claimedByOperationID, "b");
    assert.equal(h.operations.runtimeFor("b").currentTarget.targetKey, other);
  });
}

function located(h, operationID, characterID, x, systemID = 30000142) {
  h.operations.observeMemberLocation(operationID, characterID, { solarSystemID: systemID, ship: { mode: "stop", position: { x, y: 0, z: 0 } } }, true);
}
const localBelts = () => [
  { ...belt("III"), position: { x: 0, y: 0, z: 0 } },
  { ...belt("IX"), position: { x: 1e9, y: 0, z: 0 } },
];

test("locality prefers the clustered main body, ignores hauler/failed miner, resists an outlier", () => {
  const h = harness([definition("a", [member(1, "MINER"), member(2, "MINER"), member(3, "MINER"), member(4, "MINER"), member(5, "HAULER")])]);
  startAll(h, "a");
  located(h, "a", 1, 1e9); located(h, "a", 2, 1e9); located(h, "a", 3, 0); located(h, "a", 4, 0); located(h, "a", 5, -1e12);
  h.operations.memberFailed("a", 4, "offline");
  const result = h.operations.reserveCandidates("a", 1, localBelts());
  assert.equal(result.target.targetName, "IX");
  const event = h.operations.runtimeFor("a").history.find(row => row.kind === "TARGET_SELECTION");
  assert.equal(event.evidence.candidates[0].reason, "MAIN_BODY_AT_TARGET");
  assert.equal(event.evidence.candidates[0].anchorCount, 3);
});

test("Standard receives resource policy, Custom does not; unknown target composition keeps locality", () => {
  const def = definition("a", [member(1, "MINER"), member(2, "MINER")]);
  def.members[0].routineMode = "STANDARD"; def.members[0].automationID = "";
  def.policies = { resourcePolicy: { mode: "PREFER_LIST", source: "MANUAL", typeIDs: [1230] } };
  const h = harness([def]); startAll(h, "a"); located(h, "a", 1, 1e9);
  assert.deepEqual(h.operations.assignment("a", 1).resourcePolicy.typeIDs, [1230]);
  assert.equal(h.operations.assignment("a", 2).resourcePolicy, null);
  // No caller-supplied guessed composition may bias remote target ranking.
  const candidates = localBelts(); candidates[0].resourceTypeIDs = [1230];
  assert.equal(h.operations.reserveCandidates("a", 1, candidates).target.targetName, "IX");
});

test("locality ignores claimed/depleted preferences and keeps reservation atomic across operations", () => {
  const h = harness([definition("a", [member(1, "MINER")]), definition("b", [member(2, "MINER")])]);
  startAll(h, "a"); startAll(h, "b"); located(h, "a", 1, 1e9); located(h, "b", 2, 1e9);
  assert.equal(h.operations.reserveCandidates("a", 1, localBelts()).target.targetName, "IX");
  assert.equal(h.operations.reserveCandidates("b", 2, localBelts()).target.targetName, "III");
  h.operations.beginStop("a"); h.operations.finishStop("a", []);
  h.operations.beginStop("b"); h.operations.finishStop("b", []);
  h.belts.markDry("Jita", "IX", null);
  startAll(h, "a"); located(h, "a", 1, 1e9);
  assert.equal(h.operations.reserveCandidates("a", 1, localBelts()).target.targetName, "III");
});

for (const mode of ["missing", "stale", "warp", "tie"]) test(`locality ${mode} uses deterministic identity ordering`, () => {
  const h = harness([definition("a", [member(1, "MINER")])]); startAll(h, "a");
  if (mode !== "missing") located(h, "a", 1, mode === "tie" ? 5e8 : 1e9);
  if (mode === "stale") h.clock.advance(15_001);
  if (mode === "warp") h.operations.observeMemberLocation("a", 1, { solarSystemID: 30000142, ship: { mode: "warp", position: { x: 1e9, y: 0, z: 0 } } }, true);
  assert.equal(h.operations.reserveCandidates("a", 1, localBelts().reverse()).target.targetName, "III");
});

for (const family of ["ORE_ANOMALY", "ICE"]) test(`${family} locality remains current-system and same-family only`, () => {
  const h = harness([definition("a", [member(1, "MINER")], "SELF_UNLOAD", [family])]); startAll(h, "a", [family]); located(h, "a", 1, 1e9);
  const sites = localBelts().map((b, i) => ({ ...b, targetType: family, siteID: i + 10, instanceID: i + 20, siteIdentity: `site:${i + 10}:instance:${i + 20}` }));
  const result = h.operations.reserveCandidates("a", 1, [...localBelts(), ...sites, { ...sites[0], systemID: 30000143 }, { ...sites[0], targetType: family === "ICE" ? "ORE_ANOMALY" : "ICE" }]);
  assert.equal(result.target.targetType, family); assert.equal(result.target.targetName, "IX");
});

test("BELT, ORE_ANOMALY and ICE coexist without shared identity or scoped-stop collisions", () => {
  const families = ["BELT", "ORE_ANOMALY", "ICE"];
  const defs = families.map((family, index) => definition(family, [member(index + 1, "MINER")], "SELF_UNLOAD", [family]));
  const h = harness(defs);
  const keys = families.map((family, index) => {
    startAll(h, family, [family]);
    const result = h.operations.reserveCandidate(family, index + 1, family === "BELT" ? belt() : {
      targetType: family, targetName: "SITE-1", systemID: 30000142, systemName: "Jita",
      siteID: 100, instanceID: 101, siteIdentity: "site:100:instance:101", position: { x: 0, y: 0, z: 0 },
    });
    assert.equal(result.acquired, true);
    return result.target.targetKey;
  });
  assert.equal(new Set(keys).size, 3);
  h.operations.beginStop("ORE_ANOMALY");
  assert.equal(h.board.get(keys[0]).claimedByOperationID, "BELT");
  assert.equal(h.board.get(keys[2]).claimedByOperationID, "ICE");
});

test("launch waits for target selection, then travels; member failure is degraded", () => {
  const def = definition("launch", [member(1, "MINER"), member(2, "MINER")]);
  const h = harness([def]);
  assert.equal(h.operations.begin("launch", ["BELT"]).ok, true);
  h.operations.memberStarted("launch", 1, "bot-1");
  h.operations.memberStarted("launch", 2, "bot-2");
  assert.equal(h.operations.finishLaunch("launch").state, "SELECTING");
  h.operations.reserveCandidate("launch", 1, belt());
  assert.equal(h.operations.runtimeFor("launch").state, "TRAVELING");
  h.operations.memberFailed("launch", 2, "pilot already controlled");
  assert.equal(h.operations.list([{ operationID: "launch", characterID: 1, botID: "bot-1",
    status: "running", phase: "Traveling", startedAt: "now", endedAt: null }])[0].runtime.state, "DEGRADED");
  assert.equal(h.operations.runtimeFor("launch").members.get(2).reason, "pilot already controlled");
});

test("HAULER_SERVICE depletion waits for every miner dump but creates a normal logistics tail", () => {
  const def = definition("haul", [member(1, "MINER"), member(2, "MINER"), member(3, "HAULER"), member(4, "HAULER")], "HAULER_SERVICE");
  const h = harness([def]);
  startAll(h, "haul");
  const reserved = h.operations.reserveCandidate("haul", 1, belt());
  h.operations.activateTarget("haul", 1, reserved.target.targetKey);
  h.operations.depleteTarget("haul", 1, reserved.target.targetKey, { partialDumpConfirmed: true });
  let runtime = h.operations.runtimeFor("haul");
  assert.equal(runtime.currentTarget.state, "DRAINING");
  assert.deepEqual(runtime.rendezvous.ready, [1]);
  assert.deepEqual(runtime.drainingTargets[0].pendingHaulers, [3, 4]);
  assert.equal(h.operations.finishDrain("haul", 3, reserved.target.targetKey), false, "no hauler can finish before every miner's last dump");
  h.operations.depleteTarget("haul", 2, reserved.target.targetKey, { partialDumpConfirmed: true });
  runtime = h.operations.runtimeFor("haul");
  assert.equal(runtime.currentTarget, null, "main body may now select and relocate");
  assert.equal(runtime.drainingTargets.length, 1, "haulers remain behind independently");
});

test("haulers independently finish the old target then catch up to the new current target", () => {
  const def = definition("tail", [member(1, "MINER"), member(2, "HAULER"), member(3, "HAULER")], "HAULER_SERVICE");
  const h = harness([def]);
  startAll(h, "tail");
  const old = h.operations.reserveCandidate("tail", 1, belt("Belt I"));
  h.operations.depleteTarget("tail", 1, old.target.targetKey, { partialDumpConfirmed: true });
  assert.equal(h.operations.finishDrain("tail", 2, old.target.targetKey), true);
  assert.equal(h.board.get(old.target.targetKey).state, "DRAINING");
  assert.equal(h.operations.runtimeFor("tail").drainingTargets.length, 1);
  assert.equal(h.operations.finishDrain("tail", 2, old.target.targetKey), false, "duplicate completion does not remove another hauler");
  assert.equal(h.operations.finishDrain("tail", 3, old.target.targetKey), true);
  assert.equal(h.board.get(old.target.targetKey).state, "DEPLETED");
  assert.equal(h.operations.runtimeFor("tail").drainingTargets.length, 0);
  assert.equal(h.operations.finishDrain("tail", 3, old.target.targetKey), false);
  assert.equal(h.operations.runtimeFor("tail").history.filter(row => row.kind === "LOGISTICS_TAIL_COMPLETED").length, 1);
  const next = h.operations.reserveCandidate("tail", 1, belt("Belt II"));
  assert.equal(next.acquired, true);
  assert.equal(h.operations.assignment("tail", 2).logisticsTarget, null);
  assert.equal(h.operations.assignment("tail", 2).currentTarget.targetName, "Belt II");
});

test("SELF_UNLOAD rendezvous waits for required miners and a failed miner cannot deadlock it", () => {
  const def = definition("self", [member(1, "MINER"), member(2, "MINER"), member(3, "MINER")]);
  const h = harness([def]);
  startAll(h, "self");
  const target = h.operations.reserveCandidate("self", 1, belt()).target;
  h.operations.depleteTarget("self", 1, target.targetKey, { empty: true });
  h.operations.markReady("self", 1);
  h.operations.markReady("self", 2);
  assert.ok(h.operations.runtimeFor("self").rendezvous, "third miner is still unloading");
  h.operations.memberFailed("self", 3, "offline");
  assert.equal(h.operations.runtimeFor("self").rendezvous, null);
  assert.equal(h.operations.runtimeFor("self").currentTarget, null);
  assert.equal(h.operations.runtimeFor("self").state, "DEGRADED");
});

test("stop is idempotent, releases live claims, and never erases depletion", () => {
  const def = definition("stop", [member(1, "MINER")]);
  const h = harness([def]);
  startAll(h, "stop");
  const target = h.operations.reserveCandidate("stop", 1, belt()).target;
  h.operations.depleteTarget("stop", 1, target.targetKey, {});
  h.operations.beginStop("stop");
  assert.equal(h.operations.finishStop("stop", []).state, "STOPPED");
  assert.equal(h.operations.finishStop("stop", []).state, "STOPPED");
  assert.equal(h.board.get(target.targetKey).state, "DEPLETED");
});

test("blocked graceful stop remains STOPPING and is never reported STOPPED", () => {
  const def = definition("blocked", [member(1, "MINER")]);
  const h = harness([def]);
  startAll(h, "blocked");
  h.operations.beginStop("blocked");
  const runtime = h.operations.finishStop("blocked", [{ characterID: 1, message: "Drone return not confirmed" }]);
  assert.equal(runtime.state, "STOPPING");
  assert.equal(runtime.stopFailures.length, 1);
});

test("reload reconciliation trusts botHost association but not a stale current target", () => {
  const def = definition("recover", [member(1, "MINER")]);
  const h = harness([def]);
  h.operations.list([{ operationID: "recover", characterID: 1, botID: "bot-1", status: "running", phase: "Mining", why: null, startedAt: "now", endedAt: null }]);
  const runtime = h.operations.runtimeFor("recover");
  assert.equal(runtime.state, "DEGRADED");
  assert.equal(runtime.currentTarget, null);
  assert.equal(runtime.history[0].kind, "RECOVERED_UNKNOWN");
});

for (const family of ["BELT", "ORE_ANOMALY", "ICE"]) test(`${family} Self-Unload rendezvous releases only ready/healthy miners and keeps target family`, () => {
  const h = harness([definition("self", [member(1, "MINER"), member(2, "MINER"), member(3, "MINER")], "SELF_UNLOAD", [family])]);
  startAll(h, "self", [family]);
  const candidate = index => family === "BELT" ? belt(`Belt ${index}`) : { targetType: family, targetName: `Site ${index}`, systemID: 30000142, systemName: "Jita",
    siteID: 100, instanceID: index, siteIdentity: `site:100:instance:${index}`, position: { x: 1000, y: 0, z: 0 } };
  const old = h.operations.reserveCandidate("self", 1, candidate(1)).target;
  h.operations.depleteTarget("self", 1, old.targetKey, { emptyGridReads: 3 });
  h.operations.markReady("self", 1);
  assert.equal(h.operations.reserveCandidate("self", 1, candidate(2)).acquired, false);
  h.operations.markReady("self", 2);
  h.operations.memberFailed("self", 3, "offline");
  assert.equal(h.operations.runtimeFor("self").rendezvous, null);
  assert.equal(h.operations.runtimeFor("self").state, "DEGRADED");
  assert.equal(h.operations.reserveCandidate("self", 1, { ...candidate(2), targetType: "GAS" }).acquired, false);
  assert.equal(h.operations.reserveCandidate("self", 1, candidate(2)).target.targetType, family);
});

test("accumulated logistics tails remain ordered and complete independently", () => {
  const h = harness([definition("tails", [member(1, "MINER"), member(2, "HAULER")], "HAULER_SERVICE")]);
  startAll(h, "tails");
  const old = h.operations.reserveCandidate("tails", 1, belt("Belt I")).target;
  h.operations.depleteTarget("tails", 1, old.targetKey, { partialDumpConfirmed: true });
  const second = h.operations.reserveCandidate("tails", 1, belt("Belt II")).target;
  h.operations.depleteTarget("tails", 1, second.targetKey, { partialDumpConfirmed: true });
  const latest = h.operations.reserveCandidate("tails", 1, belt("Belt III")).target;
  assert.equal(h.operations.assignment("tails", 2).logisticsTarget.targetKey, old.targetKey);
  h.operations.finishDrain("tails", 2, old.targetKey);
  assert.equal(h.operations.assignment("tails", 2).logisticsTarget.targetKey, second.targetKey);
  h.operations.finishDrain("tails", 2, second.targetKey);
  assert.equal(h.operations.assignment("tails", 2).logisticsTarget, null);
  assert.equal(h.operations.assignment("tails", 2).currentTarget.targetKey, latest.targetKey);
});

test("runtime timing is a fresh server projection of matching hosted grants, never a browser clock", () => {
  const h = harness([definition("timing", [member(1, "MINER"), member(2, "HAULER")], "HAULER_SERVICE")]);
  startAll(h, "timing");
  const start = new Date(h.clock.now()).toISOString();
  const bots = [1, 2].map(characterID => ({ operationID: "timing", characterID, botID: `bot-${characterID}`, status: "running",
    startedAt: start, expiresAt: new Date(h.clock.now() + characterID * 3_600_000).toISOString(), maxRuntimeMinutes: characterID * 60, endedAt: null }));
  const first = h.operations.list(bots)[0].runtime;
  h.clock.advance(60_000);
  const reload = h.operations.list(bots)[0].runtime;
  assert.equal(reload.startedAt, first.startedAt);
  assert.equal(Date.parse(reload.observedAt) - Date.parse(first.observedAt), 60_000);
  assert.equal(reload.members[0].expiresAt, bots[0].expiresAt); assert.equal(reload.members[0].hostStartedAt, start);
  assert.equal(reload.members[0].hosted, true);
  bots[0].endedAt = reload.observedAt;
  const ended = h.operations.list(bots)[0].runtime.members[0];
  assert.equal(ended.hosted, false); assert.equal(ended.expiresAt, null, "old expiry must not masquerade as an active grant");
});

test("recovered miner stays DRAFT; hosted hauler and exact failed recovery reason are visible without trusting target", () => {
  const h = harness([definition("recover", [member(1, "MINER"), member(2, "HAULER")], "HAULER_SERVICE")]);
  const rows = [{ operationID: "recover", characterID: 1, botID: "failed", endedAt: "2026-09-27T00:00:00Z", why: "Restart policy requires manual approval" },
    { operationID: "recover", characterID: 2, botID: "hauler", status: "running", endedAt: null, startedAt: "2026-09-27T00:00:00Z", resumedAt: "2026-09-27T00:00:00Z" }];
  const runtime = h.operations.list(rows)[0].runtime;
  assert.equal(runtime.recoveryRequired, true); assert.equal(runtime.state, "DEGRADED"); assert.equal(runtime.currentTarget, null);
  assert.equal(runtime.members[0].runtimeState, "DRAFT"); assert.equal(runtime.members[0].hosted, false);
  assert.equal(runtime.members[0].lastHostReason, rows[0].why);
  assert.equal(runtime.members[1].hosted, true); assert.equal(runtime.members[1].hostResumedAt, rows[1].resumedAt);
  assert.equal(h.board.list().length, 0);
});

test("adjacent and unsupported target candidates are modeled but never invented or reserved", () => {
  const def = definition("area", [member(1, "MINER")], "SELF_UNLOAD", ["BELT", "ICE", "GAS"]);
  const h = harness([def]);
  assert.equal(h.operations.begin("area", ["BELT"]).code, "NO_EXECUTABLE_TARGET_CLASS");
  def.area.targetClasses = ["BELT"];
  startAll(h, "area", ["BELT"]);
  assert.equal(h.operations.reserveCandidate("area", 1, { ...belt(), systemID: 30000144 }).reason, "OUTSIDE_EXECUTABLE_AREA");
  assert.equal(h.operations.reserveCandidate("area", 1, { ...belt(), targetType: "ICE" }).reason, "TARGET_CLASS_NOT_EXECUTABLE");
  assert.equal(h.board.list().length, 0);
});

test("saved automation audit detects executable target seams and rejects resource preferences", () => {
  const macro = (id, args = {}) => ({ kind: "macro", id, macro: id, args });
  const beltDoc = { program: [macro("mine-at-belt", { belt: { kind: "belt", belt: { mode: "nearest" } } }), macro("jettison-ore")] };
  const siteDoc = { program: [macro("warp-to-ore-anomaly"), macro("mine-at-belt", { belt: { kind: "belt", belt: { mode: "site" } }, ores: { kind: "oreList", ores: [{ groupID: 1 }] } })] };
  assert.deepEqual(auditMiningScript(beltDoc).targetClasses, ["BELT"]);
  assert.deepEqual(auditMiningScript(siteDoc).targetClasses, ["ORE_ANOMALY"]);
  assert.equal(auditMiningScript(siteDoc).hasOrePreference, true);
});

test("operation routine contract rejects pinned and independent resource travel but permits delivery destinations", () => {
  const macro = (name, args = {}) => ({ kind: "macro", id: name, macro: name, args });
  const normal = { program: [
    macro("mine-at-belt", { belt: { kind: "belt", belt: { mode: "nearest" } } }),
    macro("travel-to-station", { station: { kind: "station", ref: { kind: "starting" } } }),
    macro("deliver-ore"),
  ] };
  const definition = { unloadPolicy: "SELF_UNLOAD" };
  assert.equal(operationRoutineCompatibility(definition, "MINER", auditMiningScript(normal), ["BELT"]), null);
  const pinned = { program: [macro("mine-at-belt", { belt: { kind: "belt", belt: { mode: "chosen", name: "Belt I" } } }), macro("deliver-ore")] };
  assert.match(operationRoutineCompatibility(definition, "MINER", auditMiningScript(pinned), ["BELT"]), /pinned belt/);
  const independent = { program: [...normal.program, macro("travel-to-system", { system: { kind: "system", id: 123 } })] };
  assert.match(operationRoutineCompatibility(definition, "MINER", auditMiningScript(independent), ["BELT"]), /not operation-target-aware/);
  const contradictory = { program: [...normal.program, macro("warp-to-ore-anomaly")] };
  assert.match(operationRoutineCompatibility(definition, "MINER", auditMiningScript(contradictory), ["BELT"]), /cannot compete/);
  const composed = { program: [...normal.program, { kind: "sub-bot", id: "hidden", scriptID: "other" }] };
  assert.match(operationRoutineCompatibility(definition, "MINER", auditMiningScript(composed), ["BELT"]), /Unsupported program node/);
  const hauler = { program: [macro("travel-to-belt", { belt: { kind: "belt", belt: { mode: "nearest" } } }), macro("loot-containers"), macro("deliver-ore")] };
  assert.equal(operationRoutineCompatibility({ unloadPolicy: "HAULER_SERVICE" }, "HAULER", auditMiningScript(hauler), ["BELT"]), null);
  assert.match(operationRoutineCompatibility(definition, "DEFENDER", auditMiningScript(normal), ["BELT"]), /not supported/);
});
