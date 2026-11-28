import test from "node:test";
import assert from "node:assert/strict";
import {confirmFleetWipe, readShipLoss, type ShipLoss} from "./fleetWipe.ts";
import {createTargetBoard, targetKey, type BeltTarget} from "./targetBoard.ts";
import {searchTargetAvailable, canReleaseExpiredTarget} from "./runtime.ts";
import {createMiningOperationRoutes} from "../operations/miningRoutes.ts";
import type {Manifest,OperationRecord} from "./operation.ts";
import {createFleetTelemetry, type FleetTelemetry} from "./telemetry.ts";
import type {UocBackendRequest as BackendRequest} from "../shared/backendScope.ts";

// Nine synthetic kill records in the same operation generation.
const systemID = 30000021;
const operationID = "fixture-operation", runID = "fixture-run";
const startAt = Date.UTC(2025, 0, 1);
const losses = [0, 31_000, 62_000, 113_000, 138_000, 222_000, 252_000, 277_000, 420_000]
 .map((offset, index): ShipLoss => ({killID: 701 + index, characterID: 101 + index,
  shipID: 1001 + index, at: startAt + offset, systemID}));
const first=losses[0]!.at,last=losses.at(-1)!.at;
const belt:BeltTarget={kind:"BELT",systemID:30000021,name:"Fixture I - Asteroid Belt 1"};
const other={...belt,name:"Fixture XIII - Asteroid Belt 1"};
const key=targetKey(belt);
const history=(target:BeltTarget,at:number)=>({
 kind:"TARGET_SELECTION",at:new Date(at).toISOString(),
 target:{targetKey:targetKey(target),targetType:"BELT",systemID:target.systemID,targetName:target.name,claimedByOperationID:operationID},
 evidence:null,
});
const members=losses.map((l,i)=>({characterID:l.characterID,shipID:l.shipID,role:i===0?"MINER" as const:"HAULER" as const}));
const telemetry:FleetTelemetry={version:1,operationID,runID,startedAt:first-1_800_000,stoppedAt:null,
 observedAt:last+1000,history:[history(belt,first-1_700_000)],
 members:members.map((m,i)=>({...m,botID:"bot-"+i,active:false,phase:"Docked",reason:null,reportedAt:last+10,freight:null})),
};
const claim={key,operationID,runID,generation:8,expiresAt:last+1000};
const operation:OperationRecord={version:1,operationID,runID,systemID:belt.systemID,destinationID:60000021,members,
 state:"DRAINING",claim,manifests:[],haulGeneration:0,haulClaims:{},jetcanGeneration:0,jetcanIntents:{},
 settled:members.map(m=>m.characterID),settledAt:Object.fromEntries(members.map(m=>[String(m.characterID),last+10])),
 parked:members.map(m=>m.characterID),stopRequested:true,stopFreight:"RETURN_HOME",
};
function memory(){
 const values=new Map<string,unknown>();
 return (name:string)=>({read:()=>structuredClone(values.get(name)??null),write:(v:unknown)=>{values.set(name,structuredClone(v));}});
}
function row(fields:Record<string,unknown>){
 return {type:"object",name:"util.KeyVal",args:{type:"dict",entries:Object.entries(fields)}};
}
function kill(l:(typeof losses)[number],typeID:number){
 return row({killID:l.killID,victimCharacterID:l.characterID,victimShipTypeID:typeID,solarSystemID:l.systemID,
  killTime:{type:"long",value:String(BigInt(l.at)*10000n+116444736000000000n)}});
}

test("the held character's killmail confirms the assigned hull only inside its ship-to-capsule window",()=>{
 const loss=losses[0]!,ship={characterID:loss.characterID,shipID:loss.shipID,shipTypeID:597};
 const own=kill(loss,597),other=kill(losses[1]!,597),pod=kill(loss,670);
 assert.deepEqual(readShipLoss({type:"list",items:[other,pod,own]},ship,first-1000,first+1),loss);
 assert.equal(readShipLoss({type:"list",items:[own]},ship,first+1,first+1000),null);
 assert.equal(readShipLoss({type:"list",items:[own,kill({...loss,killID:900},597)]},ship,first-1,first+1),null);
 assert.equal(readShipLoss({type:"list",items:[other,pod]},ship,first-1000,first+1),null);
});

test("a fleet wipe is confirmed at seven of nine exact deployed hulls",()=>{
 const enough=losses.slice(0,7);
 const wipe=confirmFleetWipe(operation,telemetry,losses);
 assert.deepEqual(wipe,{target:belt,operationID,runID,lostAt:enough.at(-1)!.at});
 assert.equal(last-first,420_000);
 assert.equal(confirmFleetWipe(operation,telemetry,enough.slice(1)),null);
 assert.equal(confirmFleetWipe(operation,telemetry,[...enough.slice(1),{...enough[0]!,shipID:42}]),null);
 assert.equal(confirmFleetWipe(operation,telemetry,[...enough.slice(1),{...enough[0]!,killID:enough[1]!.killID}]),null);
 assert.equal(confirmFleetWipe(operation,{...telemetry,runID:"other"},enough),null);
 assert.equal(confirmFleetWipe(operation,telemetry,[...enough.slice(1),{...enough[0]!,systemID:999}]),null);
 assert.equal(confirmFleetWipe(operation,{...telemetry,members:telemetry.members.slice(1)},enough),null);
 assert.equal(confirmFleetWipe(operation,telemetry,[]),null);
});

test("the old belt tail requires a confirmed delivery before the first loss",()=>{
 const oldClaim={...claim,key:targetKey(other),generation:claim.generation-1};
 const relocationHistory=[{oldClaim,oldBeltID:99,next:belt,newClaim:claim,proofs:[],completedAt:first-1000}];
 const observed={...telemetry,history:[history(other,first-2000),history(belt,first-1000)]};
 const manifest:Manifest={
  source:"observed-jetcan",operationID,runID,systemID,targetKey:oldClaim.key,claimGeneration:oldClaim.generation,
  characterID:members[0]!.characterID,shipID:null,intentGeneration:null,containerID:999,observedAt:first-2000,
  items:[{itemID:1,typeID:30,quantity:10,freightKind:"RAW",unitVolumeM3:1}],
  capacityM3:100,volumeM3:10,category:"RAW",delivered:true,
 };
 const snapshot={...operation,relocationHistory};
 const window=losses.slice(0,7);
 assert.equal(confirmFleetWipe({...snapshot,manifests:[manifest]},observed,window),null);
 assert.equal(confirmFleetWipe({...snapshot,manifests:[{...manifest,deliveredAt:first}]},observed,window),null);
 assert.ok(confirmFleetWipe({...snapshot,manifests:[{...manifest,deliveredAt:first-1}]},observed,window));
});

test("the first qualifying set of losses must fit within the same twenty-minute window",()=>{
 const cutoff=first+20*60_000;
 const extended={...operation,settledAt:{}};
 const observed={...telemetry,observedAt:cutoff+2};
 const atCutoff=[...losses.slice(0,6),{...losses[6]!,at:cutoff}];
 assert.equal(confirmFleetWipe(extended,observed,atCutoff)?.lostAt,cutoff);
 assert.equal(confirmFleetWipe(extended,observed,[...atCutoff.slice(0,-1),{...atCutoff.at(-1)!,at:cutoff+1}]),null);
 const outside=[...losses.slice(0,6),{...losses[6]!,at:cutoff+1},{...losses[7]!,at:cutoff+2}];
 assert.equal(confirmFleetWipe(extended,observed,outside.reverse())?.lostAt,cutoff+2);
});

test("thirteen deployed members need ten losses and losing every Defender alone is insufficient",()=>{
 const defenders=Array.from({length:4},(_,index)=>({characterID:index+1,shipID:index+11,role:"DEFENDER" as const}));
 const all=[...members,...defenders];
 const fleet={...operation,members:all};
 const observed={...telemetry,members:all.map((m,i)=>({...m,botID:"bot-"+i,active:false,phase:null,reason:null,reportedAt:last,freight:null}))};
 const defenderLosses=defenders.map((m,i)=>({...m,killID:900+i,systemID:belt.systemID,at:first+i}));
 assert.equal(confirmFleetWipe(fleet,observed,defenderLosses),null);
 assert.equal(confirmFleetWipe(fleet,observed,losses),null);
 assert.equal(confirmFleetWipe(fleet,observed,[...losses,...defenderLosses.slice(0,1)])?.lostAt,last);

 const neverStarted=defenders.slice(-2).map(m=>m.characterID);
 const deployed={...observed,members:observed.members.slice(0,-2)};
 assert.equal(confirmFleetWipe({...fleet,neverStarted},deployed,losses.slice(0,7)),null);
 assert.equal(confirmFleetWipe({...fleet,neverStarted},deployed,losses.slice(0,8))?.lostAt,losses[7]!.at);
});

test("ambiguous target history, completed parking before a loss, and later deployments do not establish a wipe",()=>{
 const enough=losses.slice(0,7);
 const historyWithMove=[...telemetry.history!,history(other,first+10)];
 assert.equal(confirmFleetWipe({...operation,claim:{...claim,key:targetKey(other)}},{...telemetry,history:historyWithMove},enough),null);
 assert.equal(confirmFleetWipe(operation,{...telemetry,history:[history(belt,first+1)]},enough),null);
 assert.equal(confirmFleetWipe({...operation,settledAt:{...operation.settledAt,[losses[0]!.characterID]:first-1}},telemetry,enough),null);
 assert.equal(confirmFleetWipe(operation,{...telemetry,members:telemetry.members.map(m=>m.characterID===losses[0]!.characterID?
  {...m,deployedAt:first+1}:m)},enough),null);
});

test("persistent danger excludes the belt, preserves leases and depletion, and can only be cleared for the chosen belt",async()=>{
 let now=last+100;
 const document=memory();
 const store=document("board"),next={...belt,name:"Other belt"};
 let board=createTargetBoard(store,()=>now,100,c=>canReleaseExpiredTarget(c,operation));
 const lease=board.reserve(operationID,runID,belt)!;
 assert.ok(board.activate(lease));
 assert.ok(board.markDangerous(confirmFleetWipe(operation,telemetry,losses)!));
 assert.ok(board.markDangerous({target:other,operationID,runID:"later",lostAt:last+1}));
 assert.equal(board.read(key)?.state,"ACTIVE");
 assert.ok(board.heartbeat(lease));
 assert.equal(searchTargetAvailable(board,belt,"new","run",now),false);
 assert.equal(board.reserve("new","run",belt),null);
 assert.ok(board.reserve("new","run",next));
 assert.ok(board.drain(lease));
 assert.ok(board.releaseDrained(lease,{allMembersParked:true,freightSettled:true}));
 now+=365*24*60*60_000;
 board=createTargetBoard(store,()=>now);
 assert.equal(board.isDangerous(key),true);
 assert.equal(board.reserve("replacement","run",belt),null);
 const route=createMiningOperationRoutes({document,getWorldScope:req=>req.worldID??null,markTargetSafe:board.markSafe});
 const request:BackendRequest={worldID:"world",method:"POST",path:"/mining-targets/mark-safe",params:{},query:{},
  body:{targetKey:key},account:{accountID:1,username:"operator"}};
 assert.equal((await route["POST /mining-targets/mark-safe"]!({...request,worldID:null} as BackendRequest)).status,400);
 assert.equal(board.isDangerous(key),true);
 assert.equal((await route["POST /mining-targets/mark-safe"]!(request)).status??200,200);
 board=createTargetBoard(store,()=>now);
 assert.equal(board.isDangerous(key),false);
 assert.equal(board.isDangerous(targetKey(other)),true);
 assert.equal(board.markDangerous(confirmFleetWipe(operation,telemetry,losses)!),false,"historical evidence cannot reapply after manual clear");
 assert.ok(board.reserve("replacement","run",belt));
 assert.equal(board.dangerousTargets().length,1);
});

test("manual reset reopens only the chosen depleted belt and survives reloading the board",async()=>{
 const document=memory(),store=document("board");
 const now=()=>1000;
 let board=createTargetBoard(store,now);
 const reset={...belt,name:"Reset"},other={...belt,name:"Other depleted"},dangerous={...belt,name:"Dangerous"},
  active={...belt,name:"Active"},draining={...belt,name:"Draining"};
 const anomaly={kind:"ORE_ANOMALY" as const,systemID:belt.systemID,name:"Ore site",siteID:55,instanceID:89,position:{x:1,y:2,z:3}};
 function deplete(claim:NonNullable<ReturnType<typeof board.reserve>>){
  assert.ok(board.activate(claim));
  assert.ok(board.noteDepletion(claim,{source:"checked-empty-grid",key:claim.key,observedAt:now()}));
  assert.ok(board.drain(claim));
  assert.ok(board.finish(claim,undefined,true));
 }
 for(const target of [reset,other,dangerous,anomaly])deplete(board.reserve("op","run",target)!);
 const activeClaim=board.reserve("op","run",active)!,drainingClaim=board.reserve("op","run",draining)!;
 assert.ok(board.activate(activeClaim));
 assert.ok(board.activate(drainingClaim));assert.ok(board.drain(drainingClaim));
 assert.ok(board.markDangerous({target:dangerous,operationID:"op",runID:"run",lostAt:now()}));
 const before=board.snapshot(),key=targetKey(reset);
 const routes=createMiningOperationRoutes({document,getWorldScope:req=>req.worldID??null,
  resetDepletedBelt:board.resetDepletedBelt,targetSnapshot:board.snapshot});
 const route="POST /mining-targets/reset-depleted";
 const request:BackendRequest={worldID:"world",method:"POST",path:"/mining-targets/reset-depleted",params:{},query:{},
  body:{targetKey:key},account:{accountID:1,username:"operator"}};
 const call=(targetKey:string)=>routes[route]!({...request,body:{targetKey}});
 for(const protectedTarget of [dangerous,active,draining,anomaly,{...belt,name:"Missing"}]){
  assert.equal((await call(targetKey(protectedTarget))).status,400);
 }
 assert.equal((await routes[route]!({...request,worldID:null} as BackendRequest)).status,400);
 assert.deepEqual(board.snapshot(),before);
 const reply=await call(key);
 assert.equal(reply.status??200,200);
 assert.ok((reply.body as {targetBoard:{targetKey:string;state:string}[]}).targetBoard.some(row=>row.targetKey===key&&row.state==="AVAILABLE"));
 assert.equal((await call(key)).status,400);
 board=createTargetBoard(store,now);
 assert.deepEqual(board.snapshot(),{...before,[key]:{...before[key],state:"AVAILABLE",depletion:null}});
 assert.ok(board.isDangerous(targetKey(dangerous)));
 assert.ok(board.availableForRelocation(key,true));
 assert.ok(searchTargetAvailable(board,reset,"next","run",now()));
 deplete(board.reserve("next","run",reset)!);
 assert.equal(board.read(key)?.state,"DEPLETED");
});

test("danger marks retain the exact anomaly instance and existing belt records",()=>{
 const site={kind:"ORE_ANOMALY" as const,systemID:belt.systemID,name:"Ore site",siteID:55,instanceID:89,position:{x:1,y:2,z:3}};
 const laterInstance={...site,instanceID:90};
 const siteKey=targetKey(site);
 const observed={...telemetry,history:[{
  ...history(belt,first-10),target:{...history(belt,first-10).target,targetKey:siteKey,targetType:site.kind,targetName:site.name},
 }]};
 const fleet={...operation,claim:{...claim,key:siteKey}};
 const wipe=confirmFleetWipe(fleet,observed,losses,site);
 assert.deepEqual(wipe,{target:site,operationID,runID,lostAt:losses[6]!.at});
 assert.equal(confirmFleetWipe(fleet,observed,losses,laterInstance),null);
 assert.equal(confirmFleetWipe(fleet,observed,losses),null);

 const store=memory()("board");
 const legacy={belt,operationID,runID,lostAt:first},cleared={...legacy,belt:other,cleared:true};
 store.write({version:1,generation:0,entries:{},danger:{[key]:legacy,[targetKey(other)]:cleared}});
 let board=createTargetBoard(store,()=>last+1000);
 assert.ok(board.markDangerous(wipe!));
 board=createTargetBoard(store,()=>last+1000);
 assert.deepEqual(board.dangerousTargets(),[belt,site]);
 assert.equal(board.reserve("next","run",site),null);
 assert.ok(board.reserve("next","run",laterInstance));
 assert.ok(board.markSafe(siteKey));
 assert.ok(board.reserve("next","run",site));
 assert.deepEqual(board.dangerousTargets(),[belt]);
 const saved=(store.read() as {danger:Record<string,unknown>}).danger;
 assert.deepEqual(saved[key],legacy);
 assert.deepEqual(saved[targetKey(other)],cleared);
});

test("manual clearance leaves the underlying depletion rule in effect",()=>{
 const now=last+100,board=createTargetBoard(memory()("board"),()=>now);
 const lease=board.reserve(operationID,runID,belt)!;
 assert.ok(board.activate(lease));
 assert.ok(board.noteDepletion(lease,{source:"checked-empty-grid",key,observedAt:now}));
 assert.ok(board.drain(lease));
 assert.ok(board.finish(lease,undefined,true));
 assert.ok(board.markDangerous(confirmFleetWipe(operation,telemetry,losses)!));
 assert.ok(board.markSafe(key));
 assert.equal(board.read(key)?.state,"DEPLETED");
 assert.equal(board.reserve("new","run",belt),null);
});

test("recorded loss evidence and target history survive runtime reconstruction",()=>{
 let now=first,document=memory()("telemetry");
 const a=createFleetTelemetry(document,operationID,runID,()=>now);
 a.target(belt,claim,null);
 a.recordLoss(losses[0]!);
 a.persist(a.sample(telemetry.members));
 now=last+100;
 const b=createFleetTelemetry(document,operationID,runID,()=>now);
 for(const loss of losses.slice(1))b.recordLoss(loss);
 const sample=b.sample([]);
 assert.equal(sample.history?.[0]?.target.targetKey,key);
 assert.equal(sample.startedAt,first);
 assert.ok(confirmFleetWipe(operation,sample,sample.shipLosses!));
});
