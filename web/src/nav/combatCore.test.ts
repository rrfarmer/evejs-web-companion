import test from "node:test";
import assert from "node:assert/strict";
import { combatReload, compatibleAmmo, weaponUseful, type CombatWeapon } from "./combatWeapons.ts";
import { requireModuleOutcome, moduleSettlementNote } from "./moduleOutcome.ts";
import { issueCombatReload } from "./combatReloadIssue.ts";
import { combatFit, weaponHasCycle } from "./combatFit.ts";
import { settleCombat, ownCombatAction, type CombatOwnership } from "./combatOwnership.ts";
import { decideDroneBoat } from "./droneBoatLadder.ts";
import { decideScriptAction, initialMemory } from "./scriptDecide.ts";
import { SCRIPT_MACROS } from "./scriptMacros.ts";
import { modernDefenderCopy } from "../bots/defenderRoutine.ts";
import { decodeItemInfo } from "../bridge/boundDogma.ts";
import type { BotScript } from "../bots/botScript.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { SpaceSnapshot } from "../store/types.ts";

const weapon: CombatWeapon = { itemID: 11, typeID: 55, chargeTypeID: null, chargeQuantity: 0,
  acceptedGroups: [83], chargeSize: 1, reachM: 10_000, tracking: 1 };
const ammo = { itemID: 22, typeID: 222, groupID: 83, size: 1, quantity: 100 };
const owned: CombatOwnership = { shipID: 9001, modules: { 11: { typeID: 55 } }, locks: [1],
  drones: [71], initialDrones: [], launched: true, movement: false, fleetCall: false };
function obs(active: readonly number[] = [], over: Partial<ScriptObservation> = {}): ScriptObservation {
  return { inSpace: true, docked: false, inWarp: false, shieldRatio: 1, armorRatio: 1, hullRatio: 1,
    health: 1, oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    combatDroneIDs: [], myDrones: [], lockedTargetIDs: [], capacitorRatio: 1,
    snapshot: { inSpace: true, solarSystemID: 1, shipID: 9001, sampledAtMs: 1, entities: [],
      ship: { itemID: 9001, activeModuleIDs: active, weaponBanks: {}, position: { x: 0, y: 0, z: 0 } } } as unknown as SpaceSnapshot,
    ...over };
}
test("strict reload uses only the fitted weapon's proven group AND size", () => {
  assert.equal(compatibleAmmo(weapon, ammo), true);
  for (const bad of [{ ...ammo, groupID: 84 }, { ...ammo, size: 2 }, { ...ammo, size: null }])
    assert.equal(compatibleAmmo(weapon, bad), false);
  assert.equal(compatibleAmmo({ ...weapon, acceptedGroups: null }, ammo), false);
  assert.equal(compatibleAmmo({ ...weapon, chargeSize: null }, ammo), false);
  const facts = { shipID: 9001, weaponBanks: {}, weapons: [weapon], cargo: [ammo, { ...ammo, itemID: 99, size: 2, quantity: 9999 }] };
  let mem = {};
  for (let i = 0; i < 3; i++) {
    const tick = combatReload(facts, mem); assert.deepEqual(tick.action,
      { kind: "loadCombatAmmo", moduleID: 11, chargeItemID: 22, chargeTypeID: 222 }); mem = tick.memory;
  }
  assert.equal(combatReload(facts, mem).action, null);
  assert.equal(combatReload({ ...facts, cargo: [{ ...ammo, size: 2 }] }, {}).action, null);
  assert.equal(combatReload({ ...facts, cargo: [] }, {}).action, null);
  assert.equal(combatReload({ ...facts, cargo: null }, {}).action, null);
  assert.equal(combatReload({ ...facts, weaponBanks: { 11: [12] } }, {}).action, null);
  assert.equal(combatReload({ ...facts, weaponBanks: null }, {}).action, null);
});
test("per-weapon range neither invents reach nor makes the shortest gun move the ship", () => {
  const loaded = { ...weapon, chargeTypeID: 222, chargeQuantity: 10 };
  assert.equal(weaponUseful(loaded, 12_000), false);
  assert.equal(weaponUseful({ ...loaded, reachM: 20_000 }, 12_000), true);
  assert.equal(weaponUseful({ ...loaded, reachM: null }, 1), false);
  const world = obs([], { weaponModuleIDs: [11, 12], combatWeapons: { shipID: 9001, cargo: [],
    weapons: [loaded, { ...loaded, itemID: 12, reachM: 30_000 }] }, maxTargetRangeM: 40_000,
    droneControlRangeM: 45_000, lockedTargetIDs: [1] });
  const rat = { itemID: 1, typeID: 100, kind: "ship", isNpc: true, npcEntityType: "pirate",
    radius: 0, position: { x: 25_000, y: 0, z: 0 } };
  const snapshot = { ...world.snapshot!, entities: [rat] } as unknown as SpaceSnapshot;
  const input = { obs: { ...world, snapshot }, mem: { holdM: 37_000, anchorID: 1, targetID: 1, dronesOn: 1 },
    board: {}, targets: [], holdRangeM: 37_000, propMode: "off" as const, squad: "off" as const };
  const tick = decideDroneBoat(input);
  assert.equal(tick.action.kind, "activate");
  if (tick.action.kind === "activate") assert.equal(tick.action.moduleID, 12);
  const noGun = decideDroneBoat({ ...input, obs: { ...input.obs, combatWeapons: { ...world.combatWeapons!, weapons: [loaded] } } });
  assert.equal(noGun.action.kind, "wait");
});
test("reload rechecks authority after a delayed read and observes exact loaded charge", async () => {
  const action = { kind: "loadCombatAmmo" as const, moduleID: 11, chargeItemID: 22, chargeTypeID: 222 };
  const facts = { shipID: 9001, weaponBanks: {}, weapons: [weapon], cargo: [ammo] };
  let current = true, calls = 0;
  await assert.rejects(issueCombatReload(action, { read: async () => { current = false; return facts; },
    current: () => current, load: async () => { calls++; } }), { code: "CALL_REFUSED" });
  assert.equal(calls, 0);
  current = true; let reads = 0;
  await issueCombatReload(action, { read: async () => ++reads === 1 ? facts : { ...facts,
    weapons: [{ ...weapon, chargeTypeID: 222, chargeQuantity: 10 }] }, current: () => current,
    load: async () => { calls++; } });
  assert.equal(calls, 1);
  await assert.rejects(issueCombatReload(action, { read: async () => facts, current: () => true,
    load: async () => { calls++; } }), { code: "MODULE_ACTION_UNCERTAIN" });
  assert.equal(calls, 2, "an ambiguous read never sends a second load");
});

test("mobile core excludes burst hardeners on a same-tick transition from Undock", () => {
  const world = obs([], { weaponModuleIDs: [11], hardenerModuleIDs: [99], combatHardenerModuleIDs: [],
    combatWeapons: {shipID:9001,cargo:[],weapons:[{...weapon,chargeTypeID:222,chargeQuantity:10}]},
    maxTargetRangeM:40_000,droneControlRangeM:45_000 });
  const rat = {itemID:1,typeID:100,kind:"ship",isNpc:true,npcEntityType:"pirate",radius:0,position:{x:5000,y:0,z:0}};
  const doc: BotScript = {format:"evejs-bot-script",version:1,name:"transition",notes:"",home:{entity:"station",id:9,name:"home",systemName:"test"},interrupts:[],
    program:[{id:"undock",kind:"macro",macro:"undock",args:{}},{id:"fight",kind:"macro",macro:"fight-with-drones",args:{}}]};
  const tick = decideScriptAction(doc,{...world,flightStatus:{inSpace:true,docked:false} as import("../store/types.ts").FlightStatus,
    snapshot:{...world.snapshot!,entities:[rat]} as unknown as SpaceSnapshot},initialMemory(doc),SCRIPT_MACROS,()=>{throw new Error("no retreat expected");});
  assert.equal(tick.stepPath,"fight");
  assert.notDeepEqual(tick.action,{kind:"activate",moduleID:99,targetID:0});
});
test("reload observes a deferred cycle with one dispatch and cancels retired authority", async () => {
  const action = { kind: "loadCombatAmmo" as const, moduleID: 11, chargeItemID: 22, chargeTypeID: 222 };
  const facts = { shipID: 9001, weaponBanks: {}, weapons: [weapon], cargo: [ammo] };
  let reads = 0, loads = 0;
  await issueCombatReload(action, { current: () => true, load: async () => { loads++; }, sleep: async () => {},
    read: async () => ++reads < 4 ? facts : { ...facts, weapons: [{ ...weapon, chargeTypeID: 222, chargeQuantity: 10 }] } });
  assert.equal(loads, 1); assert.equal(reads, 4);
  let current = true;
  await assert.rejects(issueCombatReload(action, { current: () => current, load: async () => { loads++; },
    read: async () => facts, sleep: async () => { current = false; } }), { code: "MODULE_ACTION_UNCERTAIN" });
  assert.equal(loads, 2, "no load is replayed after authority retires during reconciliation");
});

test("effective turret attributes and loaded missile sublocation authorize reach", () => {
  const wire = { type: "object", name: "util.KeyVal", args: { type: "dict", entries: [
    ["itemID", [9001, 27, 222]], ["invItem", null],
    ["attributes", { type: "dict", entries: [[37, 2000], [281, 5000]] }],
  ] } };
  const charge = decodeItemInfo(wire)!;
  assert.deepEqual(charge.sublocation, [9001, 27, 222]);
  const module = { ...charge, itemID: 11, typeID: 55, sublocation: null, attributes: [
    { attributeID: 54, value: 8000 }, { attributeID: 158, value: 2000 }, { attributeID: 160, value: 1 }] };
  const dogma = { activeShipID: 9001, ships: [module, charge] } as unknown as Parameters<typeof combatFit>[4];
  assert.equal(weaponHasCycle(dogma, 11), false);
  assert.equal(weaponHasCycle({ ...dogma!, ships: [{ ...module, attributes: [{attributeID:51,value:3000}] }] }, 11), true);
  const slots = [{ family: "high" as const, index: 0, module: { itemID: 11, typeID: 55,
    groupID: 74, online: true, charge: { itemID: 33, typeID: 222, quantity: 10 } } }];
  assert.equal(combatFit(9001, slots, [11], { 55: { size: 1, groups: [83] } }, dogma, []).weapons[0]?.reachM, 10_000);
  assert.equal(combatFit(9002, slots, [11], {}, dogma, []).weapons[0]?.reachM, null);
  const missile = { ...dogma!, ships: [{ ...module, attributes: [] }, charge] };
  assert.equal(combatFit(9001, slots, [11], {}, missile, []).weapons[0]?.reachM, 10_000);
});
test("requested module postconditions distinguish confirmed/refused/uncertain", () => {
  requireModuleOutcome({ itemID: 11, active: true, stopped: null }, 11, "activate");
  assert.throws(() => requireModuleOutcome({ itemID: 11, active: false, stopped: null }, 11, "activate"), { code: "CALL_REFUSED" });
  for (const result of [{ itemID: 12, active: true, stopped: true }, { itemID: 11, active: null, stopped: false }])
    assert.throws(() => requireModuleOutcome(result, 11, "activate"), { code: "MODULE_ACTION_UNCERTAIN" });
  assert.throws(() => requireModuleOutcome({ itemID: 11, active: true, stopped: false }, 11, "deactivate"), { code: "MODULE_ACTION_UNCERTAIN" });
});
test("settlement recalls owned drones once and waits for observed disposition", () => {
  const world = obs([11, 99]);
  const drone = { itemID: 71, kind: "drone", controllerID: 9001 };
  const inSpace = { ...world, combatDroneIDs: [71], myDrones: [{ itemID: 71, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
    snapshot: { ...world.snapshot!, entities: [drone] } as unknown as SpaceSnapshot };
  const recall = settleCombat(inSpace, { combatOwned: owned });
  assert.deepEqual(recall.action, { kind: "recallDrones", droneIDs: [71] });
  assert.equal(settleCombat(inSpace, recall.nextMem).action.kind, "wait");
  const off = settleCombat(world, recall.nextMem);
  assert.deepEqual(off.action, { kind: "deactivate", moduleID: 11, typeID: 55, settlement: true });
  assert.match(moduleSettlementNote({itemID:11,stopped:false},11)!, /UNCERTAIN/);
  const deferred = settleCombat(world, off.nextMem);
  assert.notEqual(deferred.outcome.kind, "done", "a deferred stop cannot become DONE");
  const clear = settleCombat(obs([99]), deferred.nextMem);
  assert.equal(clear.outcome.kind, "done", "unrelated active module 99 is left alone");
});
test("ownership records only new activation and locks; unrelated flight survives clear", () => {
  assert.equal(ownCombatAction(owned, { kind: "activate", moduleID: 99, targetID: 0 }, obs([99])).modules[99], undefined);
  assert.deepEqual(ownCombatAction(owned, { kind: "lock", targetID: 2 }, obs([], { lockedTargetIDs: [2] })).locks, [1]);
  const tick = settleCombat(obs([99]), { combatOwned: { ...owned, modules: {}, drones: [], launched: false, locks: [] } });
  assert.equal(tick.outcome.kind, "done");
});
test("modern standalone copy removes raw launch watch and uses mobile combat with hull first", () => {
  const historical: BotScript = { format: "evejs-bot-script", version: 1, name: "Belt Defender", notes: "",
    home: { entity: "station", id: 1, name: "Test home", systemName: "Test system" },
    interrupts: [{ id: "old", when: { kind: "hostile-on-grid" }, respond: "launch-drones" }],
    program: [{ id: "fight", kind: "macro", macro: "fight-the-rats", args: {} }] };
  const copy = modernDefenderCopy(historical);
  assert.equal(historical.program[0]?.kind === "macro" && historical.program[0].macro, "fight-the-rats");
  assert.equal(copy.interrupts[0]?.when.kind, "hull-below");
  assert.equal(copy.interrupts.some(row => row.respond === "launch-drones"), false);
  assert.equal(copy.program[0]?.kind === "macro" && copy.program[0].macro, "fight-with-drones");
});
