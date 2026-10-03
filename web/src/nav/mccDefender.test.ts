import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { decodeScriptValue } from "../bots/scriptCodec.ts";
import { analyzeBotRunPolicy } from "../bots/runPolicy.ts";
import { SCRIPT_MACROS } from "./scriptMacros.ts";
import { decideScriptAction, initialMemory } from "./scriptDecide.ts";
import { createScriptRunner } from "./scriptRunner.ts";
import { defenderSiteIdentity, defenderActionCurrent } from "./operationDefender.ts";
import type { ScriptObservation, MiningOperationAssignment } from "./scriptConditions.ts";
import type { SpaceSnapshot } from "../store/types.ts";
const require=createRequire(import.meta.url);
const {buildStandardProfile,standardProfileFor}=require("../../../src/miningOperationProfiles.js");
const {auditMiningScript,operationRoutineCompatibility}=require("../../../src/miningOperations.js");
const definition={area:{targetClasses:["BELT"]},unloadPolicy:"SELF_UNLOAD",unloadDestination:{stationID:99,stationName:"Home",systemName:"System"},
  members:[{role:"MINER",routineMode:"STANDARD"},{role:"DEFENDER",routineMode:"STANDARD"}]};
const member=definition.members[1];
const profile=()=>buildStandardProfile(definition,member);
const doc=()=>{const d=decodeScriptValue(profile().doc);assert.ok(d.ok);return d.doc;};
const step={id:"defend",kind:"macro" as const,macro:"fight-with-drones" as const,args:{}};
const operation:MiningOperationAssignment={operationID:"op",operationRunID:"run-1",operationName:"Op",role:"DEFENDER",state:"MINING",
  area:{anchorSystemID:30,anchorSystemName:"System",targetClasses:["BELT"],reach:"CURRENT_SYSTEM"},unloadPolicy:"SELF_UNLOAD",
  currentTarget:{targetKey:"belt-1",targetType:"BELT",systemID:30,systemName:"System",targetName:"Belt 1",state:"ACTIVE",claimedByOperationID:"op"},
  logisticsTarget:null,rendezvous:null};
function world(over:Partial<ScriptObservation>={}):ScriptObservation {
  return {inSpace:true,docked:false,inWarp:false,shieldRatio:1,armorRatio:1,hullRatio:1,health:1,oreHoldFraction:0,holdEmpty:true,
    hostileOnGrid:false,dronesOut:false,lockedTargetIDs:[],droneBayItemIDs:[],miningModuleIDs:[],holds:[],startingStationID:null,systemName:"System",
    miningOperationRequired:true,miningOperation:operation,
    flightStatus:{inSpace:true,docked:false,solarSystemID:30,shipID:9,shipMode:"stop"} as ScriptObservation["flightStatus"],
    snapshot:{shipID:9,solarSystemID:30,inSpace:true,entities:[],ship:{itemID:9,typeID:1,position:{x:0,y:0,z:0},radius:10,
      activeModuleIDs:[],weaponBanks:{},geometryAvailable:true,velocity:{x:0,y:0,z:0}}} as unknown as SpaceSnapshot,...over};
}
test("Standard Defender profile uses accepted mobile combat with safety first and idle yield",()=>{
  const p=profile(),d=doc();assert.equal(p.scriptID,"mcc.standard.defender");assert.equal(d.interrupts[0]!.respond,"dock-and-pause");
  assert.ok(analyzeBotRunPolicy(d).riskClasses.includes("combat"));
  assert.deepEqual(p.doc.program[0].body.map((n:{macro:string})=>n.macro),["undock","fight-with-drones","wait"]);
  assert.equal(p.doc.program[0].body[2].args.seconds.value,4);
  assert.equal(operationRoutineCompatibility(definition,"DEFENDER",auditMiningScript(p.doc),["BELT"]),null);
});
test("custom Defender and unsupported target families remain fail closed",()=>{
  assert.equal(standardProfileFor(definition,{...member,routineMode:"CUSTOM"}),null);
  assert.equal(standardProfileFor({...definition,area:{targetClasses:["GAS"]}},member),null);
  assert.match(operationRoutineCompatibility({...definition,members:[{...member,routineMode:"CUSTOM"}]},"DEFENDER",auditMiningScript(profile().doc),["BELT"]),/Standard Defender/);
});
test("operation destination is used directly; Defender cannot reserve its own target",()=>{
  const obs=world(); const belt={itemID:11,typeID:1,kind:"celestial",name:"Belt 1",radius:10,position:{x:1e9,y:0,z:0},geometryAvailable:true};
  const result=SCRIPT_MACROS["fight-with-drones"](step,{...obs,snapshot:{...obs.snapshot!,entities:[belt]} as unknown as SpaceSnapshot},{},{});
  assert.deepEqual(result.action,{kind:"warp",targetID:11});
  assert.equal(SCRIPT_MACROS["fight-with-drones"](step,world({miningOperation:{...operation,currentTarget:null}}),{},{}).action.kind,"wait");
});
test("relocation settles only old owned combat modules before new travel",()=>{
  const obs=world(),identity=defenderSiteIdentity(operation)!;
  const combatOwned={shipID:9,modules:{71:{}},locks:[],drones:[],initialDrones:[],launched:false,movement:false,fleetCall:false};
  const next={...operation,currentTarget:{...operation.currentTarget!,targetKey:"belt-2",targetName:"Belt 2"}};
  const result=SCRIPT_MACROS["fight-with-drones"](step,{...obs,miningOperation:next,snapshot:{...obs.snapshot!,ship:{...obs.snapshot!.ship!,activeModuleIDs:[71,99]}}},
    {operationDefender:true,defenderSiteIdentity:identity,combatOwned},{});
  assert.deepEqual(result.action,{kind:"deactivate",moduleID:71,settlement:true});assert.equal(result.phase,"Settling combat");
  const clear={...obs,miningOperation:next,snapshot:{...obs.snapshot!,ship:{...obs.snapshot!.ship!,activeModuleIDs:[99]}}};
  const retired=SCRIPT_MACROS["fight-with-drones"](step,clear,result.nextMem!,{});
  assert.equal(retired.action.kind,"wait");assert.equal(retired.nextMem?.defenderSiteIdentity,undefined);
  const belt={itemID:22,name:"Belt 2",kind:"celestial",position:{x:1e9,y:0,z:0},radius:10,geometryAvailable:true};
  const following=SCRIPT_MACROS["fight-with-drones"](step,{...clear,snapshot:{...clear.snapshot!,entities:[belt]} as unknown as SpaceSnapshot},retired.nextMem!,{});
  assert.deepEqual(following.action,{kind:"warp",targetID:22});
});
test("missing target authority settles old owned state then waits without guessing",()=>{
  const obs=world({miningOperation:null});
  const combatOwned={shipID:9,modules:{71:{}},locks:[],drones:[],initialDrones:[],launched:false,movement:false,fleetCall:false};
  const result=SCRIPT_MACROS["fight-with-drones"](step,{...obs,snapshot:{...obs.snapshot!,ship:{...obs.snapshot!.ship!,activeModuleIDs:[71]}}},
    {operationDefender:true,defenderSiteIdentity:"old",combatOwned},{});
  assert.equal(result.action.kind,"deactivate");
});
test("operation adapter delegates arrived combat to the existing shared core",()=>{
  const obs=world();const direct=SCRIPT_MACROS["fight-with-drones"](step,{...obs,miningOperation:null,miningOperationRequired:false},{},{});
  const hosted=SCRIPT_MACROS["fight-with-drones"](step,obs,{operationDefender:true,defenderSiteIdentity:defenderSiteIdentity(operation)},{});
  assert.deepEqual(hosted.action,direct.action);assert.deepEqual(hosted.outcome,direct.outcome);
});
test("idle Defender loops through WAIT without movement spam or no-progress death",()=>{
  let memory=initialMemory(doc());const obs=world();
  const belt={itemID:11,name:"Belt 1",kind:"celestial",position:{x:0,y:0,z:0},radius:10,geometryAvailable:true};
  for(let i=0;i<350;i++) {
    const result=decideScriptAction(doc(),{...obs,snapshot:{...obs.snapshot!,entities:[belt]} as unknown as SpaceSnapshot},memory,SCRIPT_MACROS,()=>{throw Error("idle must not retreat");});
    assert.equal(result.action.kind,"wait");assert.equal(result.status,"running");memory=result.memory;
  }
});
test("fresh run/site fences reject old work, but allow owned cleanup after relocation/Stop",()=>{
  for(const current of [null,{...operation,operationRunID:"run-2"},{...operation,currentTarget:{...operation.currentTarget!,targetKey:"belt-2"}},
    {...operation,stopRequested:true},{...operation,currentTarget:{...operation.currentTarget!,claimedByOperationID:"peer"}}]) {
    assert.equal(defenderActionCurrent(operation,current,{kind:"lock",targetID:12}),false);
    assert.equal(defenderActionCurrent(operation,current,{kind:"deactivate",moduleID:71}),true);
  }
});
test("runner rereads target immediately before dispatch and discards stale decision",async()=>{
  let issues=0;const runner=createScriptRunner({observe:async()=>world(),readOperationAssignment:async()=>({...operation,operationRunID:"run-2"}),
    issue:async()=>{issues++;},sleep:async()=>{},onProgress:()=>{},isSessionLost:()=>false,refusalReason:String,
    registry:{...SCRIPT_MACROS,"fight-with-drones":(_s,_o,m)=>({action:{kind:"lock",targetID:12},why:"combat",phase:"combat",armed:true,outcome:{kind:"acting"},nextMem:m})},
    travelHome:()=>{throw Error("unexpected retreat");}});
  runner.start(doc());await runner.tick();assert.equal(issues,0);assert.match(runner.snapshot().why!,/target changed/);runner.stop();
});
test("retired runner generation cannot issue after delayed operation read",async()=>{
  let release!:(value:MiningOperationAssignment)=>void,entered!:()=>void,issues=0;
  const ready=new Promise<void>(r=>{entered=r;});
  const runner=createScriptRunner({observe:async()=>world(),readOperationAssignment:()=>{entered();return new Promise(r=>{release=r;});},
    issue:async()=>{issues++;},sleep:async()=>{},onProgress:()=>{},isSessionLost:()=>false,refusalReason:String,
    registry:{...SCRIPT_MACROS,"fight-with-drones":(_s,_o,m)=>({action:{kind:"lock",targetID:12},why:"combat",phase:"combat",armed:true,outcome:{kind:"acting"},nextMem:m})},
    travelHome:()=>{throw Error("unexpected retreat");}});
  runner.start(doc());const pending=runner.tick();await ready;runner.stop();release(operation);await pending;assert.equal(issues,0);
});
