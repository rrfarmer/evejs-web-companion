import test from "node:test";
import assert from "node:assert/strict";
import { decodeSpaceSnapshot } from "../bridge/space.ts";
import { decodeFlightStatus } from "../bridge/flight.ts";
import { decodeFleetCenter } from "../bridge/fleetCenter.ts";
import type { BotScript, MacroStep } from "../bots/botScript.ts";
import type { JsonValue } from "../bridge/wire.ts";
import { decodeScriptText } from "../bots/scriptCodec.ts";
import { decideFleetMinerGeometry, fleetMiningPoint, type FleetMinerInput } from "./fleetMiner.ts";
import { observedSupportAnchorServices, type MiningSupportAnchorRead } from "./miningSupportAnchor.ts";
import { decideMiningSupportFleetMember, freshMiningSupportFleetMemory } from "./miningSupportFleet.ts";
import { SCRIPT_MACROS, scriptTravelHome } from "./scriptMacros.ts";
import { decideScriptAction, initialMemory, type MacroMemory } from "./scriptDecide.ts";
import type { ScriptObservation } from "./scriptConditions.ts";

const now = 100000, origin = { x: 0, y: 0, z: 0 };
const step: MacroStep = { id: "m", kind: "macro", macro: "fleet-mine", args: { support: { kind: "character", charID: 1, name: "Support" } }, until: { kind: "ore-hold-at-least", fraction: 0.9 } };
const script: BotScript = { format: "evejs-bot-script", version: 1, name: "Fleet test", notes: "", home: { entity: "station", id: 60000001, name: "Home", systemName: null }, interrupts: [], program: [step] };
function fixture(rockX = 15000, supportX = 0, minerX = 0): FleetMinerInput {
  const scene = decodeSpaceSnapshot({ inSpace: true, shipID: 1002, solarSystemID: 30000142, sampledAtMs: 1,
    ship: { itemID: 1002, characterID: 2, typeID: 99999, radius: 100, position: { x: minerX, y: 0, z: 0 }, velocity: origin, mode: "STOP", activeModuleIDs: [],
      coreMobilityFuel: { activeModuleIDs: [], modules: [], mobility: { movement: { verdict: "unrestricted", sources: [] }, warp: { verdict: "unrestricted", sources: [] } } },
      moduleReach: { shipID: 1002, sampledAtSimTimeMs: 1, availability: "available", modules: [{ moduleID: 42, typeID: 55, family: "mining", resourceFamily: "ore", availability: "available", maxRangeMeters: 19500 }] } },
    entities: [{ itemID: 1001, kind: "ship", characterID: 1, radius: 200, position: { x: supportX, y: 0, z: 0 } },
      { itemID: 2001, typeID: 1230, kind: "celestial", categoryID: 25, groupID: 450, radius: 10, position: { x: rockX, y: 0, z: 0 }, miningYieldTypeID: 1230, miningResourceFamily: "ore", remainingQuantity: 1000 }] });
  const support = decodeSpaceSnapshot({ inSpace: true, shipID: 1001, sampledAtMs: 1,
    ship: { itemID: 1001, characterID: 1, miningBurstServices: { activeModuleIDs: [71], bursts: [{ moduleID: 71, rangeMeters: 60000 }] } }, entities: [] });
  const anchors: MiningSupportAnchorRead = { availability: "available", reason: null, readAtMs: now,
    fleet: { fleetID: "999000001", readerCharacterID: 2, members: [{ characterID: 1, solarSystemID: 30000142 }, { characterID: 2, solarSystemID: 30000142 }], observedAtMs: now, expiresAtMs: now + 10000 },
    anchors: [{ characterID: 1, shipID: 1001, fleetID: "999000001", solarSystemID: 30000142, sessionEpoch: "support", sampledAtMs: 1,
      observedAtMs: now, publishedAtMs: now, expiresAtMs: now + 10000, ageMs: 0, freshness: "fresh", reason: null, services: observedSupportAnchorServices(support) }] };
  return { scene, anchors, sceneReceivedAtMs: now, nowMs: now, supportCharacterID: 1, requirements: { requireMiningBurst: true }, modules: [{ itemID: 42, typeID: 55, online: true }], resourceCandidates: scene.entities.filter(row => row.miningYieldTypeID !== null), preferredTargetID: null };
}
function observation(input = fixture()): ScriptObservation {
  const kv = (entries: [string | number, JsonValue][]): JsonValue => ({ type: "object", name: "util.KeyVal", args: { type: "dict", entries } });
  const fleet = decodeFleetCenter({ ok: true, characterID: 2, fleetID: 999000001, reads: {
    GetInitState: { result: kv([["fleetID", 999000001], ["members", { type: "dict", entries: [1, 2].map(id => [id, kv([["charID", id], ["role", 0], ["job", 0]])]) }]]) },
    GetWings: { result: { type: "dict", entries: [] } }, GetMotd: { result: "" }, GetJoinRequests: { result: { type: "dict", entries: [] } }, GetFleetComposition: { result: [] } } } as JsonValue);
  return { inSpace: true, docked: false, inWarp: false, shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1, oreHoldFraction: 0,
    holdEmpty: true, hostileOnGrid: false, dronesOut: false, snapshot: input.scene, lockedTargetIDs: [], miningModuleIDs: [42],
    miningDrones: { out: [], bay: [], maxActive: 5, roles: {} },
    fleetMining: { ...input, fleet: { scope: { characterID: 2, sessionEpoch: "miner" }, snapshot: fleet, receivedAtMs: now, join: { inviteKnown: false, invite: null, ads: null } } } };
}
const mine = (obs = observation(), mem: MacroMemory = {}) => SCRIPT_MACROS["fleet-mine"](step, obs, mem, {});

const assignment = (role: "MINER" | "COMMAND" = "MINER"): NonNullable<ScriptObservation["miningOperation"]> => ({
  operationID: "operation", operationName: "Operation", role, unloadPolicy: "SELF_UNLOAD", state: "MINING",
  area: { anchorSystemID: 30000142, anchorSystemName: "Jita", reach: "CURRENT_SYSTEM", targetClasses: ["BELT"] },
  currentTarget: { targetKey: "belt", targetType: "BELT", systemID: 30000142, systemName: "Jita", targetName: "Owned belt", state: "ACTIVE", claimedByOperationID: "operation" },
  logisticsTarget: null, rendezvous: null,
  support: { version: 1, characterID: 1, fleetPolicy: "MANAGED", maintainBursts: true, useIndustrialCore: false, coreRequirement: "continueWithoutCore",
    enableCompression: false, selfMining: false, tractor: false, collection: "TRACTOR_ONLY", compressCollectedOre: false, supportLoss: "PAUSE" },
});
function emptyOwnedBelt(minerX = 0): ScriptObservation {
  const base = observation(fixture(15000, 0, minerX));
  const support = base.snapshot!.entities[0]!;
  const belt = { ...support, itemID: 999, characterID: null, kind: "asteroidBelt" as const,
    name: "Owned belt", position: origin, radius: 111495 };
  return { ...base, miningOperation: assignment(),
    flightStatus: decodeFlightStatus({ inSpace: true, docked: false, shipID: 1002, solarSystemID: 30000142 }),
    snapshot: { ...base.snapshot!, entities: [support, belt] } };
}
test("an uncovered Fleet Miner cannot deplete a shared belt from its locally empty scene", () => {
  const obs = emptyOwnedBelt(110000);
  let memory: MacroMemory = { operationEmptyReads: 2 };
  for (let i = 0; i < 6; i++) {
    const result = mine(obs, memory);
    assert.equal(result.outcome.kind, "acting");
    assert.notEqual(result.action.kind, "depleteMiningTarget");
    assert.equal(result.nextMem["operationEmptyReads"], 0);
    memory = result.nextMem;
  }
});
test("lost support resets depletion evidence and settles active mining", () => {
  const base = emptyOwnedBelt();
  for (const obs of [
    { ...base, miningOperation: { ...assignment(), supportPolicy: { mode: "PAUSE" as const, reason: "relocating" } } },
    { ...base, fleetMining: { ...base.fleetMining!, anchors: null } },
    { ...base, fleetMining: { ...base.fleetMining!, nowMs: now + 10000 } },
  ]) {
    const result = mine({ ...obs, snapshot: { ...obs.snapshot!, ship: { ...obs.snapshot!.ship!, activeModuleIDs: [42] } } },
      { operationEmptyReads: 2 });
    assert.equal(result.action.kind, "deactivate");
    assert.equal(result.nextMem["operationEmptyReads"], 0);
    assert.equal(result.outcome.kind, "acting");
  }
});
test("covered belt-surface arrival cannot turn a distant locally empty scene into shared depletion", () => {
  const base = emptyOwnedBelt(50000);
  for (const obs of [base, { ...base, snapshot: { ...base.snapshot!, entities: base.snapshot!.entities.map(row => row.itemID === 999 ? { ...row, geometryAvailable: false } : row) } }]) {
    let memory: MacroMemory = { operationEmptyReads: 2 };
    for (let i = 0; i < 6; i++) {
      const result = mine(obs, memory);
      assert.equal(result.action.kind, "wait");
      assert.equal(result.phase, "Fleet Miner — field unobserved");
      assert.equal(result.nextMem["operationEmptyReads"], 0);
      assert.equal(result.settleDrones, true);
      memory = result.nextMem;
    }
  }
});
test("fresh covered empty-belt evidence still depletes, and classic mining keeps its semantics", () => {
  for (const [macro, obs] of [
    [step, emptyOwnedBelt()],
    [{ ...step, macro: "mine-at-belt" as const }, emptyOwnedBelt(110000)],
    [step, { ...emptyOwnedBelt(110000), miningOperation: { ...assignment(), supportPolicy: { mode: "FALLBACK" as const, reason: "explicit fallback" } } }],
  ] as const) {
    let memory: MacroMemory = {};
    for (let i = 0; i < 3; i++) {
      const result = SCRIPT_MACROS[macro.macro]!(macro, obs, memory, {});
      assert.equal(result.action.kind, i === 2 ? "depleteMiningTarget" : "wait");
      memory = result.nextMem;
    }
  }
});
test("MCC PAUSE settles miners; explicit FALLBACK uses ordinary mining; STOP uses the operation path", () => {
  const base = observation(), op = assignment();
  const obs = { ...base, flightStatus: decodeFlightStatus({ inSpace: true, docked: false, shipID: 1002, solarSystemID: 30000142 }),
    snapshot: { ...base.snapshot!, entities: [...base.snapshot!.entities, { ...base.snapshot!.entities[0]!, characterID: null, kind: "celestial" as const, itemID: 999,
      name: "Owned belt", position: origin }] } };
  const paused = { ...obs, miningOperation: { ...op, supportPolicy: { mode: "PAUSE" as const, reason: "recovery" } },
    snapshot: { ...obs.snapshot!, ship: { ...obs.snapshot!.ship!, activeModuleIDs: [42] } } };
  assert.equal(mine(paused).action.kind, "deactivate");
  assert.equal(mine({ ...obs, miningOperation: { ...op, supportPolicy: { mode: "FALLBACK", reason: "loss" } } }).nextMem["supportFallback"], true);
  const stop = decideScriptAction(script, { ...obs, miningOperation: { ...op, supportPolicy: { mode: "STOP", reason: "loss" } } }, initialMemory(script), SCRIPT_MACROS, scriptTravelHome);
  assert.equal(stop.action.kind, "stopMiningSupportOperation");
});
test("COMMAND target travel requires settlement AND fresh movement/warp permission", () => {
  const obs = observation(), op = assignment("COMMAND");
  const belt = { ...obs.snapshot!.entities[0]!, kind: "celestial" as const, characterID: null, itemID: 999, name: "Owned belt", position: { x: 500000, y: 0, z: 0 } };
  const commandStep: MacroStep = { id: "support", kind: "macro", macro: "mining-support", args: {} };
  const decide = (value: ScriptObservation) => SCRIPT_MACROS["mining-support"](commandStep, value, {}, {});
  const travelling = { ...obs, flightStatus: decodeFlightStatus({ inSpace: true, docked: false, shipID: 1002, solarSystemID: 30000142 }),
    miningOperation: op, snapshot: { ...obs.snapshot!, entities: [...obs.snapshot!.entities, belt] } };
  assert.equal(decide(travelling).action.kind, "maintainMiningSupport");
  const settled = { ...travelling, miningSupportWork: { readyForRelocation: true, phase: "settled", reason: null } };
  assert.equal(decide(settled).action.kind, "warp");
  const restricted = { ...settled, snapshot: { ...settled.snapshot!, ship: { ...settled.snapshot!.ship!, coreMobilityFuel: null } } };
  assert.equal(decide(restricted).action.kind, "maintainMiningSupport");
});

test("COMMAND already at its owned belt keeps mining drones while a changed target settles them", () => {
  const base = observation();
  const belt = { ...base.snapshot!.entities[0]!, kind: "celestial" as const, characterID: null,
    itemID: 999, name: "Owned belt", position: origin };
  const drone = { itemID: 201, typeID: 10250, name: null, activity: "mining", targetID: 2001,
    controlled: true, shieldRatio: 1, armorRatio: 1, hullRatio: 1 };
  const droneEntity = { ...base.snapshot!.entities[0]!, itemID: 201, typeID: 10250,
    kind: "drone" as const, controllerID: 1002, position: origin };
  const obs: ScriptObservation = { ...base, dronesOut: true, miningOperation: assignment("COMMAND"),
    flightStatus: decodeFlightStatus({ inSpace: true, docked: false, shipID: 1002, solarSystemID: 30000142 }),
    miningDrones: { bay: [], out: [drone], maxActive: 5, roles: { 10250: "mining" } },
    snapshot: { ...base.snapshot!, entities: [...base.snapshot!.entities, belt, droneEntity],
      ship: { ...base.snapshot!.ship!, coreMobilityFuel: null } } };
  const command: MacroStep = { id: "support", kind: "macro", macro: "mining-support", args: {} };
  const decide = (value: ScriptObservation, memory: MacroMemory = {}) => SCRIPT_MACROS["mining-support"](command, value, memory, {});
  let memory: MacroMemory = {};
  for (let i = 0; i < 3; i++) {
    const result = decide(obs, memory);
    assert.deepEqual(result.action, { kind: "maintainMiningSupport", relocating: false });
    memory = result.nextMem;
  }
  for (const changed of [
    { ...obs, snapshot: { ...obs.snapshot!, entities: [...base.snapshot!.entities, droneEntity, { ...belt, position: { x: 500000, y: 0, z: 0 } }] } },
    { ...obs, flightStatus: decodeFlightStatus({ inSpace: true, docked: false, shipID: 1002, solarSystemID: 30000143 }) },
    { ...obs, snapshot: { ...obs.snapshot!, ship: { ...obs.snapshot!.ship!, geometryAvailable: false } } },
    { ...obs, snapshot: { ...obs.snapshot!, entities: [...base.snapshot!.entities, droneEntity, { ...belt, geometryAvailable: false }] } },
    { ...obs, flightStatus: decodeFlightStatus({ inSpace: true, docked: false, shipID: 1003, solarSystemID: 30000142 }) },
    { ...obs, snapshot: null },
  ]) assert.deepEqual(decide(changed).action, { kind: "maintainMiningSupport", relocating: true });
});

test("Fleet Miner is an additive valid script; selected support and until are required", () => {
  assert.equal(decodeScriptText(JSON.stringify(script)).ok, true);
  for (const invalid of [{ ...step, args: {} }, { ...step, until: undefined }]) assert.equal(decodeScriptText(JSON.stringify({ ...script, program: [invalid] })).ok, false);
});
test("effective fitted 19.5km reach permits mining beyond the classic 10km", () => {
  const result = decideFleetMinerGeometry(fixture());
  assert.equal(result.state, "MINE"); assert.equal(result.rangeMeters, 19500); assert.equal(result.targetID, 2001);
  const selected = mine(); assert.equal(selected.action.kind, "wait"); assert.equal(selected.nextMem["rockID"], 2001);
  const locked = mine({ ...observation(), lockedTargetIDs: [2001] }, selected.nextMem);
  assert.deepEqual(locked.action, { kind: "activate", moduleID: 42, targetID: 2001 });
});
test("intersection movement is inside both measured surface constraints, deterministic and never an orbit", () => {
  const input = fixture(70000);
  const result = decideFleetMinerGeometry(input);
  assert.equal(result.state, "REPOSITION"); assert.ok(result.position);
  assert.ok(result.position.x <= 60300 && result.position.x >= 70000 - 19610);
  assert.deepEqual(result, decideFleetMinerGeometry(input));
  assert.equal(mine(observation(input)).action.kind, "gotoPoint");
});
test("impossible/off-grid/unknown/stale support cannot invent a destination", () => {
  assert.equal(decideFleetMinerGeometry(fixture(90000)).state, "REPOSITION_NEEDED");
  const input = fixture();
  for (const changed of [{ ...input, anchors: null }, { ...input, nowMs: now + 10000, sceneReceivedAtMs: now + 9000 },
    { ...input, scene: { ...input.scene!, entities: input.resourceCandidates } }]) {
    const result = decideFleetMinerGeometry(changed); assert.equal(result.state, "SUPPORT_UNAVAILABLE"); assert.equal(result.position, null);
  }
});
test("depleted target is replaced only after its modules and controlled flight settle", () => {
  const input = fixture(), replacement = { ...input.resourceCandidates[0]!, itemID: 2002 };
  const obs = observation({ ...input, scene: { ...input.scene!, entities: [input.scene!.entities[0]!, replacement] }, resourceCandidates: [replacement] });
  const changed = mine(obs, { rockID: 2001 });
  assert.equal(changed.action.kind, "wait"); assert.equal(changed.settleDrones, true); assert.equal(changed.nextMem["rockID"], null);
  const selected = mine(obs, changed.nextMem); assert.equal(selected.nextMem["rockID"], 2002);
});
test("missing, mismatched and incoherent reach never fall back to 10km or fitted base attributes", () => {
  const input = fixture();
  for (const modules of [null, [], [{ itemID: 43, typeID: 55, online: true }], [{ itemID: 42, typeID: 56, online: true }], [{ itemID: 42, typeID: 55, online: false }]]) assert.equal(decideFleetMinerGeometry({ ...input, modules }).state, "UNKNOWN");
  assert.equal(decideFleetMinerGeometry({ ...input, scene: { ...input.scene!, sampledAtMs: 2 } }).state, "UNKNOWN");
});
test("resource family must match every online miner; offline modules are not activated", () => {
  const input = fixture();
  assert.equal(decideFleetMinerGeometry({ ...input, resourceCandidates: input.resourceCandidates.map(row => ({ ...row, miningResourceFamily: "ice" })) }).state, "REPOSITION_NEEDED");
  assert.equal(decideFleetMinerGeometry({ ...input, modules: [...input.modules!, { itemID: 88, typeID: 99, online: false }] }).state, "MINE");
});
test("current covered target wins over preferred target requiring unnecessary movement", () => {
  const input = fixture(), other = { ...input.resourceCandidates[0]!, itemID: 2002, position: { x: 70000, y: 0, z: 0 } };
  assert.equal(decideFleetMinerGeometry({ ...input, preferredTargetID: 2002, resourceCandidates: [other, ...input.resourceCandidates] }).targetID, 2001);
});
test("two-ball projection handles containment, coincidence, tangency and disjoint balls", () => {
  assert.deepEqual(fleetMiningPoint({ x: 20, y: 0, z: 0 }, origin, 10, origin, 5), { x: 5, y: 0, z: 0 });
  assert.deepEqual(fleetMiningPoint(origin, origin, 5, { x: 10, y: 0, z: 0 }, 5), { x: 5, y: 0, z: 0 });
  assert.equal(fleetMiningPoint(origin, origin, 5, { x: 11, y: 0, z: 0 }, 5), null);
  const lens = fleetMiningPoint({ x: 4, y: 20, z: 0 }, origin, 5, { x: 8, y: 0, z: 0 }, 5)!;
  assert.ok(Math.hypot(lens.x, lens.y, lens.z) <= 5.000001 && Math.hypot(lens.x - 8, lens.y, lens.z) <= 5.000001);
});
test("support loss and target change settle turrets before productive actions", () => {
  const obs = observation(), snapshot = { ...obs.snapshot!, ship: { ...obs.snapshot!.ship!, activeModuleIDs: [42] } };
  const lost = mine({ ...obs, snapshot, fleetMining: { ...obs.fleetMining!, anchors: null } }, { rockID: 2001 });
  assert.equal(lost.nextMem["fleetMinerState"], "SUPPORT_UNAVAILABLE"); assert.deepEqual(lost.action, { kind: "deactivate", moduleID: 42 }); assert.equal(lost.settleDrones, true);
  assert.equal(mine({ ...obs, snapshot }, { rockID: 999 }).action.kind, "deactivate");
});
test("initial adoption settles already active miners and controlled drones on a different target", () => {
  const obs = observation(), snapshot = { ...obs.snapshot!, ship: { ...obs.snapshot!.ship!, activeModuleIDs: [42] } };
  assert.equal(mine({ ...obs, snapshot }).action.kind, "deactivate");
  assert.equal(mine({ ...obs, miningDrones: null }).action.kind, "wait");
  const settled = mine(obs); assert.equal(settled.nextMem["rockID"], 2001);
});
test("lost/stale support or an impossible intersection brakes an issued movement after settlement", () => {
  for (const input of [{ ...fixture(), anchors: null }, fixture(90000)]) {
    const obs = observation(input), snapshot = { ...obs.snapshot!, ship: { ...obs.snapshot!.ship!, mode: "GOTO", velocity: { x: 100, y: 0, z: 0 } } };
    assert.equal(mine({ ...obs, snapshot }, { fleetMoveTargetID: 2001 }).action.kind, "stopShip");
    assert.equal(mine({ ...obs, snapshot, miningDrones: null }, { fleetMoveTargetID: 2001 }).action.kind, "wait");
  }
});
test("Core restriction, unknown motion and unknown drone return prohibit movement", () => {
  const obs = observation(fixture(70000));
  assert.equal(mine({ ...obs, miningDrones: null }).action.kind, "wait");
  assert.equal(mine({ ...obs, snapshot: { ...obs.snapshot!, ship: { ...obs.snapshot!.ship!, motionAvailable: false } } }).action.kind, "wait");
  assert.equal(mine({ ...obs, snapshot: { ...obs.snapshot!, ship: { ...obs.snapshot!.ship!, coreMobilityFuel: null } } }).action.kind, "wait");
});
test("moving into coverage brakes and waits for observed STOP before mining", () => {
  const obs = observation(), moving = { ...obs, snapshot: { ...obs.snapshot!, ship: { ...obs.snapshot!.ship!, mode: "GOTO", velocity: { x: 100, y: 0, z: 0 } } } };
  assert.equal(mine(moving).action.kind, "stopShip");
  assert.equal(mine(obs).action.kind, "wait");
});
test("one movement order waits for observation and has bounded retries", () => {
  const obs = observation(fixture(70000)), first = mine(obs);
  assert.equal(first.action.kind, "gotoPoint"); assert.equal(mine(obs, first.nextMem).action.kind, "wait");
  const stalled = mine({ ...obs, fleetMining: { ...obs.fleetMining!, nowMs: now + 9000 } }, { ...first.nextMem, fleetMoveAttempts: 3, fleetMoveIssuedAtMs: now - 10000 });
  assert.equal(stalled.action.kind, "wait"); assert.match(stalled.why, /could not be confirmed/);
});
test("real joined roster confirms EXISTING_ONLY membership without fabricating a support GetInitState", () => {
  const obs = observation(), read = obs.fleetMining!;
  const decide = (roster = read.anchors!.fleet) => decideMiningSupportFleetMember({ own: read.fleet, supportCharacterID: 1, support: null, supportRoster: roster, nowMs: now }, freshMiningSupportFleetMemory());
  assert.equal(decide().state, "ready"); assert.equal(decide().action, null);
  for (const changed of [{ ...read.anchors!.fleet!, readerCharacterID: 3 }, { ...read.anchors!.fleet!, fleetID: "111" }, { ...read.anchors!.fleet!, expiresAtMs: now }, { ...read.anchors!.fleet!, members: [{ characterID: 2, solarSystemID: null }] }]) assert.equal(decide(changed).state, "waiting");
});
test("accepted drone wrapper recalls and confirms home before any Fleet Miner movement", () => {
  const obs = observation(fixture(70000));
  const drone = { itemID: 77, typeID: 10250, controlled: true, activity: "mining", targetID: 2001, controllerID: 1002,
    name: "Mining drone", shieldRatio: 1, armorRatio: 1, hullRatio: 1 };
  const state = { bay: [], out: [drone], maxActive: 5, roles: { 10250: "mining" } } as NonNullable<ScriptObservation["miningDrones"]>;
  const first = decideScriptAction(script, { ...obs, miningDrones: state }, initialMemory(script), SCRIPT_MACROS, scriptTravelHome);
  assert.equal(first.action.kind, "recallDrones");
  const returning = decideScriptAction(script, { ...obs, miningDrones: { ...state, out: [{ ...state.out![0]!, activity: "returning" }] } }, first.memory, SCRIPT_MACROS, scriptTravelHome);
  assert.equal(returning.action.kind, "wait");
  const home = decideScriptAction(script, obs, returning.memory, SCRIPT_MACROS, scriptTravelHome);
  assert.equal(home.action.kind, "gotoPoint");
});
