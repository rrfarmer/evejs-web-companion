import test from "node:test";
import assert from "node:assert/strict";
import {createTargetBoard,type SynchronousStore,type Target} from "./targetBoard.ts";
import {createOperation} from "./operation.ts";
import {createRawMembers,createShipJettison,HaulStoppedBeforePickup,type RawMinerNative,type RawHaulerNative} from "./memberLoops.ts";
import {FleetObservationUnavailable} from "./stopSignal.ts";
import {createNativeRawObserver} from "./nativeMiner.ts";
import {memoryOperationStore} from "./operationStoreFixture.ts";
import {TransportQueueError} from "../../../web/src/app/transport.ts";
import {BridgeCallError} from "../../../web/src/bridge/callMethod.ts";
function memory():SynchronousStore{let data:unknown=null;return {read:()=>structuredClone(data),write:v=>{data=structuredClone(v)}};}
const now=()=>1000;
const target:Target={kind:"BELT",systemID:300,name:"belt"};
function fixture(haulerIDs:readonly number[]=[3]){let clock=1000;const time=()=>clock;const board=createTargetBoard(memory(),time);const store=memoryOperationStore(),op=createOperation(store,board,{operationID:"op",runID:"run",systemID:300,destinationID:600,members:[{characterID:1,shipID:11,role:"MINER"},{characterID:2,shipID:12,role:"MINER"},...haulerIDs.map(characterID=>({characterID,shipID:characterID+10,role:"HAULER" as const}))]},time);const claim=op.reserve(1,target)!;op.activate(1);const item={itemID:20,typeID:30,quantity:10,freightKind:"RAW" as const,unitVolumeM3:1};const facts={30:{categoryID:25,freightKind:"RAW" as const,unitVolumeM3:1}};
 const before={source:{source:"checked-ship-holds" as const,characterID:1,shipID:11,systemID:300,targetKey:claim.key,claimGeneration:claim.generation,observedAt:1000,items:[{...item,ownerID:1,locationID:11,flagID:5}]},items:[item],facts,capacityM3:100,existingContainerIDs:[99],sceneSampledAt:1000};
 const can={containerID:100,ownerID:1,shipID:11,systemID:300,targetKey:claim.key,claimGeneration:claim.generation,observedAt:1000,items:[item],sourceAfter:{...before.source,items:[]}};
 const miner:RawMinerNative={current(){},async navigate(){},async mineCycle(){return "hold-full"},async observeHolds(){return before},async jettison(){},async observeCreatedCan(){return can}};
 return {op,store,miner,before,can,setTime:(t:number)=>{clock=t}};}
test("legacy freight publishes a checked raw can and delivers only the claimed manifest",async()=>{const {op,miner}=fixture();const loops=createRawMembers(op);assert.equal(await loops.flush(1,miner),"published");
 const hauler:RawHaulerNative={current(){},async navigateAndVerify(m){assert.equal(m.containerID,100)},async transferAndDeliver(m,g,d){return {source:"native-transfer",operationID:"op",runID:"run",containerID:m.containerID,claimGeneration:g,shipID:13,destinationID:d,sourceAfter:[],destinationBefore:[{typeID:30,quantity:2}],destinationAfter:[{typeID:30,quantity:12}],observedAt:1000}}};
 assert.equal(await loops.hauler(3,hauler),"delivered");assert.equal(op.snapshot().manifests[0]?.delivered,true);
});
test("Return Home abandons the unissued remainder of a haul but keeps an ambiguous write",async()=>{
 for(const uncertain of [false,true]){
  const {op,miner,store}=fixture(),loops=createRawMembers(op);
  assert.equal(await loops.flush(1,miner),"published");
  const haul=loops.hauler(3,{
   current(){},async navigateAndVerify(){},
   async transferAndDeliver(){
    op.noteStopRequest("RETURN_HOME");
    if(uncertain)throw Error("Pickup response lost");
    throw new HaulStoppedBeforePickup();
   },
  });
  if(uncertain)await assert.rejects(haul,/response lost/);
  else assert.equal(await haul,"idle");
  assert.equal(op.snapshot().haulClaims["100"]?.dispatched,uncertain?true:undefined);
  assert.equal(op.snapshot().manifests.length,uncertain?1:0);
  assert.equal(store.readDelivery(100),null);
 }
});
async function twoHaulerFixture(){
 const f=fixture([3,4]),loops=createRawMembers(f.op);assert.equal(await loops.flush(1,f.miner),"published");
 const item={...f.before.items[0]!,itemID:21};
 const before={...f.before,existingContainerIDs:[99,100],items:[item],source:{...f.before.source,characterID:2,shipID:12,items:[{...item,ownerID:2,locationID:12,flagID:5}]}};
 const second:RawMinerNative={...f.miner,observeHolds:async()=>before,observeCreatedCan:async()=>({...f.can,containerID:101,ownerID:2,shipID:12,items:[item],sourceAfter:{...before.source,items:[]}})};
 assert.equal(await loops.flush(2,second),"published");return {...f,loops};
}
function delivered(manifest:Parameters<RawHaulerNative["transferAndDeliver"]>[0],generation:number,shipID:number){return {source:"native-transfer" as const,operationID:"op",runID:"run",containerID:manifest.containerID,claimGeneration:generation,shipID,destinationID:600,sourceAfter:[],destinationBefore:[{typeID:30,quantity:100}],destinationAfter:[{typeID:30,quantity:110}],observedAt:1000};}
test("two concurrent haulers claim distinct cans before either moves",async()=>{
 const {op,loops}=await twoHaulerFixture();let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve});const moved:number[]=[];
 const native=(characterID:number):RawHaulerNative=>({current(){},async navigateAndVerify(m){assert.equal(op.snapshot().haulClaims[String(m.containerID)]?.characterID,characterID);moved.push(m.containerID);if(characterID===3)await waiting;},async transferAndDeliver(m,g){return delivered(m,g,characterID+10);}});
 const first=loops.hauler(3,native(3));assert.equal(op.claimContainer(4,100),null);assert.equal(op.claimContainer(3,101),null);
 assert.equal(await loops.hauler(4,native(4)),"delivered");assert.deepEqual(moved,[100,101]);release();assert.equal(await first,"delivered");
 assert.equal(op.snapshot().manifests.every(m=>m.delivered),true);assert.deepEqual(op.snapshot().haulClaims,{});
});
test("a second hauler waits without movement when the sole can is claimed",async()=>{
 const {op,miner}=fixture([3,4]),loops=createRawMembers(op);await loops.flush(1,miner);assert.ok(op.claimContainer(3,100));let calls=0;
 const native:RawHaulerNative={current(){},async navigateAndVerify(){calls++},async transferAndDeliver(){calls++;throw Error("must not transfer another hauler's freight")}};
 assert.equal(await loops.hauler(4,native),"idle");assert.equal(calls,0);assert.equal(op.snapshot().haulClaims['100']?.characterID,3);
});
test("retained dispatched custody is reconciled before claiming earlier free freight",async()=>{
 const {op,loops}=await twoHaulerFixture(),claim=op.claimContainer(3,101)!;assert.ok(claim);assert.equal(op.dispatchHaul(3,101,claim.generation),true);let reads=0;
 const native:RawHaulerNative={current(){},async navigateAndVerify(){throw Error("must reconcile before new movement")},async transferAndDeliver(){throw Error("must not repeat pickup")},async recoverHeldAndDeliver(m,g){reads++;assert.equal(m.containerID,101);assert.equal(op.snapshot().haulClaims['100'],undefined);return delivered(m,g,13);}};
 assert.equal(await loops.hauler(3,native,async()=>{throw Error("retained freight must bypass fresh selection")}),"delivered");assert.equal(reads,1);assert.equal(op.snapshot().manifests.find(m=>m.containerID===100)?.delivered,false);assert.equal(op.snapshot().haulClaims['100'],undefined);
});
test("the selected physical-dispatch can is claimed before movement without claiming another",async()=>{
 const {op,loops}=await twoHaulerFixture();let choices=0,movements=0;
 const native:RawHaulerNative={current(){},async navigateAndVerify(m){movements++;assert.equal(m.containerID,101);assert.equal(op.snapshot().haulClaims['101']?.characterID,4);assert.equal(op.snapshot().haulClaims['100'],undefined)},async transferAndDeliver(m,g){return delivered(m,g,14)}};
 assert.equal(await loops.hauler(4,native,async(id,manifests)=>{choices++;assert.equal(id,4);assert.deepEqual(manifests.map(m=>m.containerID),[100,101]);return 101}),"delivered");
 assert.equal(choices,1);assert.equal(movements,1);assert.equal(op.snapshot().manifests.find(m=>m.containerID===100)?.delivered,false);
});
test("no dispatch winner or a stale selection causes no claim or native movement",async()=>{
 const {op,loops}=await twoHaulerFixture();const native:RawHaulerNative={current(){},async navigateAndVerify(){throw Error("no dispatch winner")},async transferAndDeliver(){throw Error("no dispatch winner")}};
 for(const winner of [null,999])assert.equal(await loops.hauler(3,native,async()=>winner),"idle");assert.deepEqual(op.snapshot().haulClaims,{});
});
test("a retired Hauler cannot claim a can after an outstanding selection returns",async()=>{
 const {op,loops}=await twoHaulerFixture();
 let active=true,finishSelection!:()=>void,selecting!:()=>void;
 const entered=new Promise<void>(resolve=>{selecting=resolve;});
 const waiting=new Promise<void>(resolve=>{finishSelection=resolve;});
 const trip:RawHaulerNative={current(){if(!active)throw Error("Held pilot ended.");},
  async navigateAndVerify(){assert.fail("Unused legacy approach");},async transferAndDeliver(){assert.fail("Unexpected write");},
  async haulTrip(_owned,next){
   await next(async()=>true,async manifests=>{selecting();await waiting;return manifests;});
   return "idle";
  }};
 const work=loops.hauler(3,trip);
 await entered;
 active=false;finishSelection();
 await assert.rejects(work,/Held pilot ended/);
 assert.equal(op.snapshot().haulClaims["100"],undefined);
 assert.ok(op.claimContainer(4,100));
});

test("Collect Freight rechecks an already dispatched Jettison without replay",async()=>{
 const {op,miner,can}=fixture();let calls=0,readable=false;
 miner.jettison=async()=>{calls++;throw Error("lost response");};
 miner.observeCreatedCan=async()=>{if(!readable)throw Object.assign(Error("EveJS gateway is unreachable."),{code:"EVE_GATEWAY_UNREACHABLE",status:502});return can;};
 const loops=createRawMembers(op);
 await assert.rejects(loops.flush(1,miner),{constructor:FleetObservationUnavailable,message:/Jettison 1: EveJS gateway is unreachable.*No replay/});
 op.noteStopRequest("COLLECT_FREIGHT");
 await assert.rejects(loops.flush(1,miner),/No replay/);
 assert.equal(op.snapshot().jetcanIntents["1"]?.dispatched,true);
 assert.equal(op.snapshot().manifests.length,0);
 readable=true;
 assert.equal(await createRawMembers(op).flush(1,miner),"published");
 assert.equal(calls,1);
 assert.equal(op.snapshot().manifests[0]?.containerID,can.containerID);
});
test("Collect Freight arriving during the hold read prevents a new Miner Jettison",async()=>{
 const {op,miner,before}=fixture();
 miner.mineCycle=async(_target,_claim,_ready,_arrival,jettison)=>{
  op.noteStopRequest("COLLECT_FREIGHT");
  assert.equal(await jettison!(before.items),false);
  return "blocked";
 };
 miner.jettison=async()=>assert.fail("Do not jettison ore the Miner now needs to deliver");
 assert.equal(await createRawMembers(op).miner(1,miner),"blocked");
 assert.deepEqual(op.snapshot().jetcanIntents,{});
});
test("Miner retries Jettison on the next observation only after a definite lane refusal",async()=>{
 const diagnosis={inFlight:4,queued:1,oldestOutstandingMs:6000,verdict:"All 4 request lanes were busy."};
 const queued=new TransportQueueError("/api/bridge/call",20_000,diagnosis);
 for(const error of [new BridgeCallError("BRIDGE_NETWORK_ERROR",queued.message,0,diagnosis.verdict),
  new BridgeCallError("BRIDGE_NETWORK_ERROR","Bridge call ship.Jettison could not reach the BFF: reset",0)]){
  const {op,miner,before}=fixture();
  const triesNewPass=error.message===queued.message;
  let calls=0;
  miner.mineCycle=async(_target,_claim,_ready,_arrival,jettison)=>await jettison!(before.items)?"hold-full":"blocked";
  miner.jettison=async()=>{if(++calls===1)throw error;};
  const loops=createRawMembers(op);
  assert.equal(await loops.miner(1,miner),triesNewPass?"blocked":"hold-full");
  assert.equal(await loops.miner(1,miner),triesNewPass?"hold-full":"blocked");
  assert.equal(calls,triesNewPass?2:1);
 }
});
test("Collect Freight bypasses the cooldown returned by an in-flight Jettison",async()=>{
 const {op,miner}=fixture();
 miner.jettison=async()=>{
  op.noteStopRequest("COLLECT_FREIGHT");
  throw Object.assign(Error("cooldown"),{code:"CALL_REFUSED",status:409,refusal:{key:"ShpJettisonPending"}});
 };
 assert.equal(await createRawMembers(op).flush(1,miner),"empty");
 assert.ok(op.jetcanCooldownRemaining(1)>0);
 assert.deepEqual(op.snapshot().jetcanIntents,{});
});
test("lost Jettison ACK is superseded by exact fresh can and source-hold proof",async()=>{
 const {op,miner,can}=fixture();let calls=0,inventoryUpdated=false;
 miner.jettison=async()=>{calls++;inventoryUpdated=true;await Promise.resolve();throw Object.assign(Error("lost response"),{code:"CALL_TIMEOUT"});};
 miner.observeCreatedCan=async()=>{assert.ok(inventoryUpdated);return can;};
 assert.equal(await createRawMembers(op).flush(1,miner),"published");
 assert.equal(op.snapshot().manifests[0]?.containerID,can.containerID);
 assert.equal(op.snapshot().jetcanIntents["1"],undefined);
 assert.equal(calls,1);
});
test("native cooldown delays Jettison while the operation is active",async()=>{const {op,miner}=fixture();let calls=0;miner.jettison=async()=>{calls++;throw Object.assign(Error("cooldown"),{code:"CALL_REFUSED",status:409,refusal:{key:"ShpJettisonPending"}})};const loops=createRawMembers(op);assert.equal(await loops.flush(1,miner),"waiting");assert.equal(await loops.flush(1,miner),"waiting");assert.equal(calls,1);assert.equal(op.snapshot().jetcanIntents["1"],undefined);assert.equal(op.snapshot().jetcanCooldowns?.["1"]?.outcome,"NATIVE_COOLDOWN");});

test("final Jettison cooldown checks only for a proven empty hold",async()=>{
 const {op,miner,before}=fixture(),loops=createRawMembers(op);
 let panels=0,exactReads=0,navigations=0,admissions=0,jettisons=0;
 let empty=false,unreadable=false;
 const run={characterID:1,baseUrl:"http://bff",fetch:async(input:URL)=>{
  assert.equal(new URL(String(input)).pathname,"/api/bridge/ship/ore-hold");
  panels++;
  return Response.json({ok:true,activeShipID:11,holds:["ore","ice","gas","asteroid","cargo"].map(key=>({
   key,error:key==="ore"&&unreadable?"CALL_TIMEOUT":null,
   capacity:{capacity:100,used:key==="ore"&&!empty?10:0},items:key==="ore"&&!empty?before.items:[]
  }))});
 }};
 const native=createNativeRawObserver(run as any,{store:{station:{get:()=>({online:{characterID:1}})}},flow:{flying:{},requestOptions:()=>({})}} as any,
  {shipID:11,capacityM3:100,current(){},assertAtTarget:async()=>{},typeFacts:async()=>({})});
 miner.holdEmpty=native.holdEmpty;
 miner.navigate=async()=>{navigations++;};
 miner.observeHolds=async()=>{exactReads++;return empty&&!unreadable?{...before,items:[]}:before;};
 miner.jettison=async()=>{
  jettisons++;
  throw Object.assign(Error("cooldown"),{code:"CALL_REFUSED",status:409,refusal:{key:"ShpJettisonPending"}});
 };
 const admit=async()=>{admissions++;return true;};
 assert.equal(await loops.flush(1,miner,admit),"waiting");
 assert.equal(await loops.flush(1,miner,admit),"waiting");
 assert.deepEqual({panels,exactReads,navigations,admissions,jettisons},{panels:1,exactReads:1,navigations:1,admissions:1,jettisons:1});
 empty=true;unreadable=true;
 assert.equal(await loops.flush(1,miner,admit),"waiting");
 unreadable=false;
 assert.equal(await loops.flush(1,miner,admit),"empty");
 assert.deepEqual({panels,exactReads,navigations,admissions,jettisons},{panels:3,exactReads:1,navigations:1,admissions:1,jettisons:1});
});
test("cooldown expiry uses a fresh hold observation and a new intent",async()=>{const {op,miner,before,can,setTime}=fixture();let calls=0,reads=0;miner.observeHolds=async()=>{reads++;return {...before,source:{...before.source,observedAt:181001}}};miner.observeCreatedCan=async()=>({...can,observedAt:181001,sourceAfter:{...can.sourceAfter,observedAt:181001}});miner.jettison=async()=>{if(++calls===1)throw Object.assign(Error("cooldown"),{code:"CALL_REFUSED",status:409,refusal:{key:"ShpJettisonPending"}})};const loops=createRawMembers(op);miner.observeHolds=async()=>{reads++;return reads===1?before:{...before,source:{...before.source,observedAt:181001}}};assert.equal(await loops.flush(1,miner),"waiting");for(let t=11000;t<=181000;t+=10000){setTime(t);assert.equal(op.heartbeat(),true);}setTime(181001);assert.equal(await loops.flush(1,miner),"published");assert.equal(calls,2);assert.equal(reads,2);assert.equal(op.snapshot().manifests[0]?.intentGeneration,2);assert.equal(op.snapshot().jetcanRefusals?.length,1);});
test("message-only cooldown cannot clear an unknown dispatched intent",async()=>{const {op,miner}=fixture();miner.jettison=async()=>{throw Error("ShpJettisonPending")};miner.observeCreatedCan=async()=>{throw Error("Can not verified");};await assert.rejects(createRawMembers(op).flush(1,miner));assert.equal(op.snapshot().jetcanIntents["1"]?.dispatched,true);});
test("previously visible can is not treated as newly created for legacy freight",async()=>{const {op,miner,can}=fixture();miner.observeCreatedCan=async()=>({...can,containerID:99});await assert.rejects(createRawMembers(op).flush(1,miner),/identity or source removal is uncertain/);assert.equal(op.snapshot().manifests.length,0);});
test("real jettison adapter sends the current stack IDs once without needing an item list in the answer",async()=>{const calls:unknown[]=[];const session:any={flow:{flying:{bridgeDo:async(...args:unknown[])=>{calls.push(args);return null;}}}};const jet=createShipJettison(session,()=>{});await jet([20,21]);assert.deepEqual(calls,[["ship","Jettison",[[20,21]]]]);});


test("pre-dispatch qualification failure releases only that hauler's unmutated claim",async()=>{
 const {op,miner}=fixture([3,4]),loops=createRawMembers(op);
 await loops.flush(1,miner);
 const first:RawHaulerNative={current(){},async navigateAndVerify(){throw Error("Source observation unavailable");},
  async transferAndDeliver(){throw Error("must not reach pickup");}};
 await assert.rejects(loops.hauler(3,first),/Source observation unavailable/);
 assert.equal(op.snapshot().haulClaims["100"],undefined);
 const second:RawHaulerNative={current(){},async navigateAndVerify(){},
  async transferAndDeliver(m,g){return delivered(m,g,14);}};
 assert.equal(await loops.hauler(4,second),"delivered");
});

test("a late Stop retry keeps cargo aboard when all original haulers have released",async()=>{
 const {op,miner}=fixture();
 let calls=0;miner.jettison=async()=>{calls++;};
 await assert.rejects(createRawMembers(op).flush(1,miner,false),/No original hauler.*Keep this ore aboard/);
 assert.equal(calls,0);
 assert.deepEqual(op.snapshot().jetcanIntents,{});
});
