import type {BackendPilotObservation} from "../shared/backendScope.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {createMiningOperationRoutes,findMiningLaunchJournal} from "./miningRoutes.ts";
import {createMiningDefinitionStore} from "./miningStore.ts";
import {createMiningFleetRuntime,type FleetSetup} from "../miningFleet/runtime.ts";
import {deleteFleetCycles,deleteFleetExecution} from "../miningFleet/executionDocuments.ts";
import {createTargetBoard} from "../miningFleet/targetBoard.ts";
import {operationHasController,registerRun} from "../runControl.ts";
import {setupHash} from "./miningRecovery.ts";
import type {BackendRequest,PluginRunContext} from "../../../web/src/plugin-api/backend.ts";

const {createDocumentStore}=createRequire(import.meta.url)("../documentStore.cjs");
const namespace=JSON.stringify(["world"]);
const members=[
 {characterID:1,accountName:"miner",characterName:"Miner",role:"MINER",automationID:""},
 {characterID:2,accountName:"hauler",characterName:"Hauler",role:"HAULER",automationID:""},
];
const definition={
 name:"Saved fleet",area:{anchorSystemID:300,anchorSystemName:"System",reach:"CURRENT_SYSTEM",targetClasses:["BELT"]},
 targetPolicy:"ANY_ELIGIBLE",unloadPolicy:"HAULER_SERVICE",
 unloadDestination:{stationID:600,stationName:"Home",corporationDivision:1,corporationID:77},members,
 policies:{version:1,parking:{mode:"RETURN_HOME_DOCK",destination:{stationID:600,stationName:"Home",systemName:"System"},corporationDivision:null,corporationID:null},
  travelAssist:{mode:"DISABLED"},resourcePolicy:{mode:"ANY_ELIGIBLE",source:"MANUAL",typeIDs:[]}},
};
const belt=(name:string)=>({kind:"BELT" as const,systemID:300,name});
const hostStatus=(characterID:number,owner:string,offset=0):BackendPilotObservation=>({
 characterID,accountName:characterID===1?"miner":"hauler",owner,online:owner!=="OFF",observedAt:Date.now()+offset,dock:null,
});
const setup=(operationID:string,operationRunID:string):FleetSetup=>({
 operationID,operationRunID,systemID:300,beltID:99,beltName:"Ore",destinationID:600,corporationID:77,division:1,canCapacityM3:100,
 members:[{characterID:1,shipID:11,role:"MINER"},{characterID:2,shipID:12,role:"HAULER"}],
 travelAssist:"DISABLED",parking:{mode:"RETURN_HOME_DOCK",kind:"station",destinationID:600,systemID:300},
});
const runtimeDocs=createDocumentStore(":memory:");
const launchDocs=createDocumentStore(":memory:");
const launchJournal=(id:string,runID:string)=>findMiningLaunchJournal(launchDocs,id,runID);
const launchReceipt=(id:string,runID:string)=>launchJournal(id,runID)?.read()??null;

function dispatchFixtureHaul(group:ReturnType<ReturnType<typeof createMiningFleetRuntime>["getOrCreate"]>){
 const {operationID,runID,claim}=group.op.snapshot();
 assert.ok(claim);
 const items=[{itemID:50,typeID:30,quantity:67090,freightKind:"RAW" as const,unitVolumeM3:.1}];
 const facts={30:{categoryID:25,freightKind:"RAW" as const,unitVolumeM3:.1}};
 const source={source:"checked-ship-holds" as const,characterID:1,shipID:11,systemID:300,
  targetKey:claim.key,claimGeneration:claim.generation,observedAt:Date.now(),
  items:items.map(i=>({...i,ownerID:1,locationID:11,flagID:5}))};
 const intent=group.op.prepareJetcan(1,items,100_000,facts,source);
 assert.ok(intent);assert.ok(group.op.dispatchJetcan(1,intent.generation));
 assert.ok(group.op.registerJetcan({source:"native-jetcan",operationID,runID,targetKey:claim.key,
  claimGeneration:claim.generation,characterID:1,shipID:11,systemID:300,containerID:55,
  intentGeneration:intent.generation,items,capacityM3:100_000,observedAt:Date.now()},facts));
 const freight=group.op.claimContainer(2,55);
 assert.ok(freight);assert.ok(group.op.dispatchHaul(2,55,freight.generation));
 return freight;
}

test("stock Retry Stop admits only unfinished home unloads and retires the verified generation",async()=>{
 const operationID="retry-parked",operationRunID="old",scope={operationID,operationRunID};
 const old=setup(operationID,operationRunID),parking={mode:"RETURN_HOME_UNLOAD_DOCK" as const,kind:"station" as const,
  destinationID:600,systemID:300,corporationID:77,division:1};
 Object.assign(old,{parking});
 createMiningDefinitionStore(launchDocs.document("mining-definitions:"+namespace),()=>"saved",()=>operationID).save(definition);
 const receipt={version:1,revision:1,...scope,planHash:"original",setupHash:setupHash(old),members:members.map(m=>({
  ...m,kind:"mcc-"+m.role.toLowerCase(),beforeIDs:[],status:"ACCEPTED",botID:"original-"+m.characterID,
 }))};
 launchDocs.document("mining-launch:"+JSON.stringify([namespace,operationID])).write(receipt);
 launchDocs.document("mining-launch-setup:"+JSON.stringify([namespace,operationID,operationRunID])).write(old);
 const life=createMiningFleetRuntime({storage:runtimeDocs,launchJournal,dockedUnloadsOnly:true,
  createCycle:async()=>{throw Error("No productive work");},settle:async()=>{throw Error("No native work in the HTTP route");}});
 const group=life.getOrCreate(old);
 assert.ok(group.op.reserve(1,belt("Ore")));assert.ok(group.op.activate(1));
 group.requestStop("RETURN_HOME");group.op.requestStop();
 for(const m of old.members)assert.ok(group.op.settleMember(m.characterID,{source:"native-settlement",runID:operationRunID,
  shipID:m.shipID,modulesInactive:true,dronesSafe:true,observedAt:Date.now()}));
 const dock=(shipID:number)=>({source:"native-flight" as const,runID:operationRunID,shipID,locationID:600,docked:true,observedAt:Date.now()});
 assert.ok(group.op.parkMember(2,dock(12)));
 const routes=createMiningOperationRoutes({document:launchDocs.document,getWorldScope:()=>"world",
  requestStop:life.requestOperationStop,isOperationActive:()=>false,canFinish:()=>true,
  operationSnapshot:life.operationSnapshot,retainedSetup:life.retainedSetup,
  authorizeFinish:life.authorizeFinish,finalizeRetainedStop:life.finalizeRetainedStop,
 },launchDocs,{discardGeneration:life.discardGeneration});
 const call=(route:string,body:unknown=null)=>routes[route]!({
  account:{accountID:1,username:"operator"},method:route.startsWith("GET")?"GET":"POST",path:"",params:{operationID},query:{},body,
 } as BackendRequest);
 assert.deepEqual((await call("POST /mining-operations/:operationID/stop",{operationRunID,mode:"RETURN_HOME"})).body,
  {ok:true,mode:"RETURN_HOME",live:false,finishAtHome:true});
 const {recovery}=((await call("GET /mining-operations/:operationID/recovery")).body as any);
 assert.deepEqual(recovery.stopUnload,{parking,characterIDs:[1]});
 assert.deepEqual(recovery.completedMembers,[2]);
 const proof={recoveryHash:recovery.recoveryHash};
 assert.equal((await call("POST /mining-operations/:operationID/recovery/finalize",proof)).status,400);
 assert.equal((await call("POST /mining-operations/:operationID/recovery/dispatch",{...proof,characterID:2,beforeIDs:[]})).status,400);
 const dispatched=await call("POST /mining-operations/:operationID/recovery/dispatch",{...proof,characterID:1,beforeIDs:[]});
 assert.equal((dispatched.body as any).recovery.attempts[0].characterID,1);
 assert.ok(group.op.parkMember(1,dock(11)));
 const ended=await call("POST /mining-operations/observe",{generations:[scope]});
 const {runtime}=((ended.body as any).operations.find((r:any)=>r.definition.operationID===operationID));
 assert.equal(runtime.state,"DRAFT");
 assert.equal(runtime.operationRunID,null);
 assert.equal(runtime.stopUnload,undefined);
});

test("an explicit Retry Stop closes an offline freight tail and retains the original unresolved transfer",async()=>{
 const operationID="offline-freight-stop",operationRunID="old",scope={operationID,operationRunID};
 const old=setup(operationID,operationRunID);
 const saved=createMiningDefinitionStore(launchDocs.document("mining-definitions:"+namespace),()=>"saved",()=>operationID).save(definition);
 const launchKey="mining-launch:"+JSON.stringify([namespace,operationID]);
 const historyKey="mining-launch-history:"+JSON.stringify([namespace,operationID,operationRunID]);
 const receipt={version:1,revision:1,...scope,planHash:"original",setupHash:setupHash(old),members:members.map(m=>({
  ...m,kind:"mcc-"+m.role.toLowerCase(),beforeIDs:[],status:"ACCEPTED",botID:"original-"+m.characterID,
 }))};
 launchDocs.document(launchKey).write(receipt);
 const life=createMiningFleetRuntime({storage:runtimeDocs,launchJournal,dockedUnloadsOnly:true,
  createCycle:async()=>assert.fail("Stop must not acquire a productive controller"),
  attach:async()=>assert.fail("Closing an offline run must not select a pilot"),
  settle:async()=>assert.fail("Closing an offline run must not perform game actions"),
 });
 const group=life.getOrCreate(old);
 const claim=group.op.reserve(1,belt("Ore"))!;
 assert.ok(group.op.activate(1));
 const haul=dispatchFixtureHaul(group);
 assert.ok(group.op.closePickup(2,55,haul.generation));
 group.requestStop("COLLECT_FREIGHT");
 group.op.requestStop();
 assert.ok(group.op.settleMember(1,{source:"native-settlement",runID:operationRunID,shipID:11,
  modulesInactive:true,dronesSafe:true,observedAt:Date.now()}));
 assert.ok(group.op.parkMember(1,{source:"native-flight",runID:operationRunID,shipID:11,
  locationID:600,docked:true,observedAt:Date.now()}));
 const original=group.op.snapshot();
 assert.equal(original.state,"DRAINING");
 assert.deepEqual(original.parked,[1]);
 const execution=runtimeDocs.document("mining-fleet-operation:"+JSON.stringify([operationID,operationRunID]));
 const pending=runtimeDocs.document("mining-fleet-haul:"+JSON.stringify([operationID,operationRunID,55,haul.generation,2,12]));
 const transfer={pending:{kind:"delivery",acknowledged:false,before:{requestedIDs:[50],quantity:67090}}};
 pending.write(transfer);
 const routes=createMiningOperationRoutes({
  document:launchDocs.document,getWorldScope:()=>"world",isOperationActive:operationHasController,
  operationSnapshot:life.operationSnapshot,retainedSetup:life.retainedSetup,
  requestStop:life.requestOperationStop,checkSetup:life.runs.MINER.check,
  telemetrySnapshot:()=>({members:[{characterID:2,shipID:12,botID:"original-2",active:false,
   phase:"Stop needs attention",reason:"Raw deposit outcome remains unknown; no replay."}]}),
 },launchDocs,{discardGeneration:life.discardGeneration});
 const call=(route:string,body:unknown=null,pilotObservations?:BackendPilotObservation[])=>routes[route]!({
  account:{accountID:1,username:"operator"},method:route.startsWith("GET")?"GET":"POST",path:"",params:{operationID},query:{},body,pilotObservations,
 } as BackendRequest);
 const runtime=(response:Awaited<ReturnType<typeof call>>)=>(response.body as any).operations
  .find((row:any)=>row.definition.operationID===operationID).runtime;
 const observe=(closeOfflineStop?:true,pilotObservations?:BackendPilotObservation[],endStopped=true)=>call("POST /mining-operations/observe",
  {generations:[{...scope,endStopped,...(closeOfflineStop?{closeOfflineStop}:{})}]},pilotObservations);
 const before=runtime(await call("GET /mining-operations"));
 assert.equal(before.state,"PARKING_FAILED");
 assert.equal(before.canCloseOfflineStop,true);
 assert.equal(runtime(await observe()).state,"PARKING_FAILED","refresh alone cannot close an unverified Stop");
 assert.equal(runtime(await observe(true,undefined,false)).operationRunID,operationRunID);
 assert.equal(runtime(await observe(true,[hostStatus(1,"OFF"),hostStatus(2,"BROWSER")])).operationRunID,operationRunID);
 const unregister=registerRun({botID:"original-2",characterID:2,setup:old as any},"hauler",()=>assert.fail("An active owner may not be closed here"));
 try {
  assert.equal(runtime(await observe(true)).operationRunID,operationRunID);
 } finally {
  unregister();
 }
 const closed=runtime(await observe(true));
 assert.equal(closed.state,"DRAFT");
 assert.equal(closed.operationRunID,null);
 assert.deepEqual(closed.unverifiedStop,{operationRunID,closedAt:closed.unverifiedStop.closedAt,
  unconfirmedDeliveries:1,unverifiedPilots:[2]});
 assert.ok(Number.isFinite(closed.unverifiedStop.closedAt));
 assert.deepEqual(execution.read(),original);
 assert.deepEqual(pending.read(),transfer);
 assert.deepEqual(launchDocs.document(historyKey).read(),receipt);
 assert.equal(launchDocs.document(launchKey).read(),null);
 assert.equal(life.targetSnapshot()[claim.key],undefined);
 assert.equal(runtime(await observe(true)).unverifiedStop.closedAt,closed.unverifiedStop.closedAt);
 const fresh=setup(operationID,"fresh");
 const plan=await call("POST /mining-operations/:operationID/launch-plan",{revision:saved.revision,setup:fresh});
 const began=await call("POST /mining-operations/:operationID/launch/begin",{revision:saved.revision,setup:fresh,
  planHash:(plan.body as any).planHash,members:receipt.members.map(({status,botID,...member})=>member)});
 assert.equal((began.body as any).receipt?.operationRunID,"fresh",JSON.stringify(began.body));
 assert.equal(runtime(await observe(true)).operationRunID,"fresh","a stale close cannot retire the replacement run");
 assert.deepEqual(pending.read(),transfer);
});

for(const mode of ["RETURN_HOME","COLLECT_FREIGHT"] as const)test(mode+": the backend protects the definition until the last pilot finishes, without a page",async t=>{
 const operationID="edit-after-"+mode,operationRunID="shift",fleet=setup(operationID,operationRunID);
 const store=createMiningDefinitionStore(launchDocs.document("mining-definitions:"+namespace),()=>"saved",()=>operationID);
 const saved=store.save(definition),launch=launchDocs.document("mining-launch:"+JSON.stringify([namespace,operationID]));
 const life=createMiningFleetRuntime({storage:runtimeDocs,launchJournal,dockedUnloadsOnly:true,
  createCycle:async()=>assert.fail("No live mining"),settle:async()=>assert.fail("No game session")});
 const group=life.getOrCreate(fleet);
 t.after(()=>{group.retireGroup();});
 const routes=createMiningOperationRoutes({document:launchDocs.document,getWorldScope:()=>"world",isOperationActive:operationHasController,
  operationSnapshot:life.operationSnapshot,requestStop:life.requestOperationStop,checkSetup:value=>life.runs.MINER.check(value)},launchDocs,{discardGeneration:life.discardGeneration});
 const call=(route:string,body:unknown)=>routes[route]!({account:{accountID:1,username:"owner"},method:"POST",
  path:"",params:{operationID},query:{},body});
 const save=()=>call("POST /mining-operations",{...saved,name:"Next shift"});
 const remove=(revision:number)=>call("POST /mining-operations/:operationID/delete",{revision});
 const blocked=async()=>{
  const prior=launch.read();
  assert.equal((await save()).status,409);assert.equal((await remove(1)).status,409);
  assert.deepEqual(store.get(operationID),saved);assert.deepEqual(launch.read(),prior);
 };
 const launchIntent={revision:1,setup:fleet,members:members.map(m=>({...m,kind:"mcc-"+m.role.toLowerCase(),beforeIDs:[]}))};
 const plan=await call("POST /mining-operations/:operationID/launch-plan",launchIntent);
 assert.equal((await call("POST /mining-operations/:operationID/launch/begin",{...launchIntent,planHash:(plan.body as any).planHash})).status,undefined);
 await blocked(); // Launch is open, before the first dispatch.
 for(const m of members){
  const member={operationRunID,characterID:m.characterID};
  assert.equal((await call("POST /mining-operations/:operationID/launch/dispatch",member)).status,undefined);
  if(m.characterID===1)await blocked(); // Dispatched, with no controller yet.
  assert.equal((await call("POST /mining-operations/:operationID/launch/accept",{...member,botID:m.accountName+"-"+mode})).status,undefined);
 }
 // The page can disappear without sending launch/end or observe.

 const releases=members.map(m=>registerRun({botID:m.accountName+"-"+mode,characterID:m.characterID,
  setup:{operationID,operationRunID}},m.accountName,()=>{}));
 t.after(()=>{for(const release of releases)release();});
 assert.ok(group.op.reserve(1,belt("Ore")));assert.ok(group.op.activate(1));
 await blocked();
 const stop=()=>call("POST /mining-operations/:operationID/stop",{operationRunID,mode});
 assert.equal((await stop()).status,202);assert.equal(group.op.snapshot().stopFreight,mode);
 assert.equal((await stop()).status,202); // Retry Stop still reaches the original run.
 group.op.requestStop();
 for(const member of fleet.members){
  assert.ok(group.op.settleMember(member.characterID,{source:"native-settlement",runID:operationRunID,shipID:member.shipID,modulesInactive:true,dronesSafe:true,observedAt:Date.now()}));
  assert.ok(group.op.parkMember(member.characterID,{source:"native-flight",runID:operationRunID,shipID:member.shipID,locationID:600,docked:true,observedAt:Date.now()}));
 }
 assert.equal(group.op.snapshot().state,"STOPPED");
 releases[0]!();
 await blocked(); // The physical work has ended, but the last hosted controller still owns the run.
 releases[1]!();
 if(mode==="COLLECT_FREIGHT"){
  assert.equal(((await save()).body as any).ok,true);assert.equal(store.get(operationID)?.name,"Next shift");
  const next={...launchIntent,revision:2,setup:{...fleet,operationRunID:"next-shift"}};
  const reviewed=await call("POST /mining-operations/:operationID/launch-plan",next);
  const begun=await call("POST /mining-operations/:operationID/launch/begin",{...next,planHash:(reviewed.body as any).planHash});
  assert.equal((begun.body as any).receipt.operationRunID,"next-shift");
  assert.equal((await remove(2)).status,409);
  await call("POST /mining-operations/:operationID/launch/end",{operationRunID:"next-shift"});
 }
 assert.equal(((await remove(mode==="COLLECT_FREIGHT"?2:1)).body as any).ok,true);
 assert.equal(store.get(operationID),null);assert.equal(launch.read(),null);
 assert.equal(runtimeDocs.document("mining-fleet-index:"+operationID).read(),null);
});

for(const mode of ["RETURN_HOME","COLLECT_FREIGHT","watchdog","stock-host","stock-offline"] as const)test(mode+": confirmed termination frees the saved configuration for a fresh Start",async()=>{
 const definitions=launchDocs,cycles=createDocumentStore(":memory:");
 const operationID="lifecycle-"+mode,old=setup(operationID,"old"),suffix=JSON.stringify([operationID,"old"]);
 const launchKeyFor=(scope:string)=>"mining-launch:"+JSON.stringify([scope,operationID]);
 const launchSetupFor=(scope:string)=>"mining-launch-setup:"+JSON.stringify([scope,operationID,"old"]);
 const originalScope=mode==="watchdog"?JSON.stringify(["world","owner"]):namespace;
 const launchKey=launchKeyFor(originalScope),launchSetup=launchSetupFor(originalScope);
 const formation="mining-fleet-site-navigation:"+JSON.stringify([1,11,150,200,operationID,"old",1]);
 const haul="mining-fleet-haul:"+JSON.stringify([operationID,"old",55,1,2,12]);
 const index="mining-fleet-index:"+operationID;
 const snapshotKey="mining-fleet-operation:"+suffix;
 const doc=runtimeDocs.document;
 const life=createMiningFleetRuntime({
  storage:runtimeDocs,createCycle:async()=>{throw Error("No gameplay in lifecycle cleanup");},
  settle:async()=>{throw Error("No native settlement in lifecycle cleanup");},
  launchJournal,attach:async()=>{assert.fail("Lifecycle cleanup must never acquire pilot access.");},
  discardExecution(id,runID){deleteFleetCycles(cycles,id,runID);deleteFleetExecution(runtimeDocs,id,runID);},
 });
 const launchMembers=members.map(m=>({...m,kind:"mcc-"+m.role.toLowerCase(),beforeIDs:[]}));
 const name=mode==="watchdog"?"2nd Mining Fleet":definition.name;
 const saved=createMiningDefinitionStore(definitions.document("mining-definitions:"+namespace),()=> "saved",()=>operationID).save({...definition,name});
 let active=false;
 const routes=createMiningOperationRoutes({
  document:definitions.document,getWorldScope:req=>req.account.username==="other-world"?"other-world":"world",isOperationActive:()=>active,requestStop:life.requestOperationStop,
  operationSnapshot:life.operationSnapshot,targetSnapshot:life.targetSnapshot,checkSetup:value=>life.runs.MINER.check(value),
  telemetrySnapshot:(id,runID)=>doc("mining-fleet-telemetry:"+JSON.stringify([id,runID])).read(),
  deliveryReceiptIndex:life.deliveryReceiptIndex,deliveryReceipt:life.deliveryReceipt,completedFleetResult:life.completedFleetResult,
 },definitions,{discardGeneration:life.discardGeneration});
 const call=(route:string,body:unknown=null,pilotObservations?:readonly BackendPilotObservation[],accountName="owner",query:Record<string,string>={})=>routes[route]!({
  account:{accountID:1,username:accountName},method:route.startsWith("GET")?"GET":"POST",path:"",params:{operationID},query,body,pilotObservations,
 } as BackendRequest);
 const observe=(pilotObservations:readonly BackendPilotObservation[]|undefined,runID="old",owner="owner")=>
  call("POST /mining-operations/observe",{generations:[{operationID,operationRunID:runID}]},pilotObservations,owner);
 async function begin(candidate:FleetSetup){
  const plan=(await call("POST /mining-operations/:operationID/launch-plan",{revision:1,setup:candidate})).body as any;
  assert.equal(plan.ok,true,JSON.stringify(plan));
  return call("POST /mining-operations/:operationID/launch/begin",{revision:1,setup:candidate,planHash:plan.planHash,members:launchMembers,
   ...(mode==="stock-host"?{durationMinutes:720}:{})});
 }
 const begun=await begin(old);assert.equal((begun.body as any).ok,true,JSON.stringify(begun.body));
 if(mode==="stock-host"){
  const end=(begun.body as any).receipt.shiftEndsAt;
  assert.ok(end-Date.now()<=720*60_000&&end-Date.now()>719*60_000);
 }
 for(const member of members){
  assert.equal((await call("POST /mining-operations/:operationID/launch/dispatch",{characterID:member.characterID,operationRunID:"old"})).status,undefined);
  assert.equal((await call("POST /mining-operations/:operationID/launch/accept",{characterID:member.characterID,operationRunID:"old",botID:"old-"+member.characterID})).status,undefined);
 }
 if(originalScope!==namespace){
  // Put the definition and receipts back under the pre-upgrade keys.
  definitions.document("mining-definitions:"+originalScope).write({version:1,definitions:[saved]});
  const worldDefinitions=definitions.document("mining-definitions:"+namespace);
  const envelope=worldDefinitions.read();
  worldDefinitions.write({...envelope,definitions:envelope.definitions.filter((row:any)=>row.operationID!==operationID)});
  for(const [canonical,legacy] of [[launchKeyFor(namespace),launchKey],[launchSetupFor(namespace),launchSetup]] as const){
   definitions.document(legacy).write(definitions.document(canonical).read());
   definitions.deleteDocuments([canonical],[]);
  }
 }
 assert.equal(launchReceipt(operationID,"old")?.members[1]?.status,"ACCEPTED");
 const checked=await life.runs.MINER.check(old);
 assert.ok(checked.ok);assert.equal(checked.policy.restartSafe,true);
 const group=life.getOrCreate(old);
 const claim=group.op.reserve(1,belt("Ore"));assert.ok(claim);assert.ok(group.op.activate(1));
 active=true;
 const beforeSwitch=definitions.document(launchKey).read();
 const listed=(await call("GET /mining-operations",null,undefined,"other-account")).body as any;
 const activeCard=listed.operations.find((row:any)=>row.definition.operationID===operationID);
 assert.equal(activeCard.runtime.state,"ACTIVE");
 assert.equal(activeCard.runtime.operationRunID,"old");
 assert.deepEqual(activeCard.definition,saved);
 assert.deepEqual(definitions.document(launchKey).read(),beforeSwitch);
 if(originalScope!==namespace)assert.equal(definitions.document("mining-definitions:"+originalScope).read(),null);
 assert.deepEqual((await call("GET /mining-operations/:operationID/launch",null,undefined,"other-account")).body,
  {ok:true,receipt:beforeSwitch});
 active=false;
 const freight=mode==="COLLECT_FREIGHT"||mode==="watchdog"||mode==="stock-offline"?dispatchFixtureHaul(group):null;
 const other=life.getOrCreate(setup("other-"+mode,"old"));
 const otherClaim=other.op.reserve(1,belt("Neighbor "+mode));assert.ok(otherClaim);
 const independent="mining-fleet-haul:"+JSON.stringify([operationID,"old-extension",55,1,2,12]);
 for(const key of [haul,formation,independent])doc(key).write({pending:{kind:"moveItems",quantity:67090}});
 const cycleKey="pilot-cycle:"+JSON.stringify([operationID,"old",1]);
 cycles.document(cycleKey).write({pending:true});
 cycles.document("pilot:1").write({identity:JSON.stringify([operationID,"old",1,11,300,99,"old-1"])});
 cycles.document("pilot:2").write({identity:JSON.stringify(["another","old",2,12,300,99,"another-2"])});
 cycles.document("compression:"+JSON.stringify([operationID,"old",1])).write({pending:true});
 if(mode==="stock-offline"){
  const beforeStop=group.op.snapshot();
  assert.equal(beforeStop.state,"ACTIVE");
  assert.equal(beforeStop.stopRequested,undefined);
  assert.ok(group.retireGroup(),"the restarted WC has only retained execution, with no group");
  const stopRoute="POST /mining-operations/:operationID/stop";
  assert.equal((await call(stopRoute,{operationRunID:"another",mode:"COLLECT_FREIGHT"})).status,400);
  assert.deepEqual(doc(snapshotKey).read(),beforeStop);
  const accepted={status:202,body:{ok:true,mode:"COLLECT_FREIGHT",live:false}};
  assert.deepEqual(await call(stopRoute,{operationRunID:"old",mode:"COLLECT_FREIGHT"}),accepted);
  assert.deepEqual(doc(snapshotKey).read(),{...beforeStop,stopRequested:true,stopFreight:"COLLECT_FREIGHT",offlineStopRequested:true});
  assert.deepEqual(await call(stopRoute,{operationRunID:"old",mode:"RETURN_HOME"}),accepted);
 }else if(mode!=="watchdog"){
  group.requestStop(mode==="stock-host"?"RETURN_HOME":mode);
 }
 const before=doc(snapshotKey).read();
 // Farmer may have received none of the requests while the browser is launching.
 await observe([hostStatus(1,"OFF"),hostStatus(2,"OFF")]);
 if(mode==="stock-host")await observe(undefined);
 if(mode==="stock-offline")await call("POST /mining-operations/observe",{generations:[{operationID,operationRunID:"old",endStopped:true}]});
 assert.deepEqual(doc(snapshotKey).read(),before);
 await call("POST /mining-operations/:operationID/launch/end",{operationRunID:"old"});
 const unregister=registerRun({botID:"held-hauler",characterID:2,setup:old as any},"hauler",()=>{});
 await observe([hostStatus(1,"OFF"),hostStatus(2,"BOT")]);
 assert.deepEqual(doc(haul).read(),{pending:{kind:"moveItems",quantity:67090}});
 unregister();
 await observe([hostStatus(1,"OFF"),hostStatus(2,"BOT")]);
 await observe([hostStatus(1,"OFF"),hostStatus(2,"TRANSITION")]);
 if(mode==="stock-offline")await observe([hostStatus(1,"OFF"),hostStatus(2,"BROWSER")]);
 await observe([hostStatus(1,"OFF")]);
 await observe([hostStatus(1,"OFF"),hostStatus(2,"OFF",-30_000)]);
 await observe([hostStatus(1,"OFF"),hostStatus(2,"OFF")],"different");
 await observe([hostStatus(1,"OFF"),{...hostStatus(2,"OFF"),accountName:"unrelated-pilot"}],"old","other-account");
 assert.deepEqual(doc(snapshotKey).read(),before);
 assert.equal((await begin(setup(operationID,"fresh"))).status,400);
 if(mode==="watchdog"||mode==="stock-offline"){
  active=mode==="stock-offline";
  await call("POST /mining-operations/observe",{generations:[{operationID,operationRunID:"old",endStopped:true}]});
  assert.deepEqual(doc(snapshotKey).read(),before,"active owners or a run without Stop cannot be retired");
  active=false;
 }
 if(mode!=="watchdog"&&mode!=="stock-offline"){
  if(mode==="COLLECT_FREIGHT"){
   assert.ok(freight);assert.ok(group.op.snapshot().haulClaims["55"]?.dispatched);
   assert.ok(group.op.markDelivered(2,{source:"native-transfer",operationID,runID:"old",
    containerID:55,claimGeneration:freight.generation,shipID:12,destinationID:600,observedAt:Date.now(),
    sourceAfter:[],destinationBefore:[{typeID:30,quantity:3008}],destinationAfter:[{typeID:30,quantity:70098}]}));
   const payload=(await call("GET /mining-operations")).body as any;
   const delivery=payload.operations.find((row:any)=>row.definition.operationID===operationID)
    .runtime.history.find((event:any)=>event.kind==="FREIGHT_DELIVERED");
   assert.equal(delivery.evidence.receiptAvailable,true);
   assert.equal(Object.hasOwn(delivery.evidence,"deliveryReceipt"),false);
   const proof=(await call("GET /mining-operations/:operationID/delivery-receipts",null,undefined,"owner",
    {runID:"old",containerID:"55"})).body as any;
   assert.deepEqual(proof.receipt.destinationAfter,[{typeID:30,quantity:70098}]);
   const summary=await call("GET /mining-operations/:operationID/delivery-receipts",null,undefined,"owner",{runID:"old"});
   assert.equal((summary.body as any).result.deliveredUnits,67090);
  }
  group.op.requestStop();
  if(mode==="stock-host"){
   const observed=await call("POST /mining-operations/observe",{
    generations:[{operationID,operationRunID:"old",endStopped:true}],
   });
   const interrupted=(observed.body as any).operations.find((row:any)=>row.definition.operationID===operationID);
   assert.equal(interrupted.runtime.state,"WAITING_FOR_HOST");
   assert.equal(interrupted.runtime.operationRunID,"old");
   assert.equal(interrupted.runtime.lastRun,null);
   assert.equal(interrupted.runtime.shiftEndsAt,new Date(launchReceipt(operationID,"old")!.shiftEndsAt!).toISOString());
   assert.deepEqual(doc(haul).read(),{pending:{kind:"moveItems",quantity:67090}});
   const reason="Hosted grant ended before unload. Last verified aboard: 10 ore units.";
   doc("mining-fleet-telemetry:"+suffix).write({members:[{
    characterID:1,shipID:11,botID:"old-1",phase:"Stop needs attention",active:false,reason,
   }]});
   const failed=await observe(undefined);
   const retained=(failed.body as any).operations.find((row:any)=>row.definition.operationID===operationID);
   assert.equal(retained.runtime.state,"PARKING_FAILED");
   assert.equal(retained.runtime.members.find((m:any)=>m.characterID===1).reason,reason);
   assert.equal(retained.runtime.operationRunID,"old");
  }
  for(const member of old.members){
   assert.ok(group.op.settleMember(member.characterID,{source:"native-settlement",runID:"old",
    shipID:member.shipID,observedAt:Date.now(),modulesInactive:true,dronesSafe:true}));
   assert.ok(group.op.parkMember(member.characterID,{source:"native-flight",runID:"old",shipID:member.shipID,
    locationID:600,docked:true,observedAt:Date.now()}));
  }
  doc(haul).write({pending:null});
  assert.equal(group.op.snapshot().state,"STOPPED");
  await observe([hostStatus(1,"OFF"),hostStatus(2,"BOT")]);
  assert.equal((doc(snapshotKey).read() as any)?.state,"STOPPED","farmer still owns the last pilot");
 }else{
  assert.equal(group.op.snapshot().state,"ACTIVE");assert.ok(group.op.snapshot().haulClaims["55"]?.dispatched);
 }
 const cleared=(await (mode==="stock-offline"?
  call("POST /mining-operations/observe",{generations:[{operationID,operationRunID:"old",endStopped:true}]},undefined,"other-account"):
  observe(mode==="stock-host"?undefined:[hostStatus(1,"OFF"),hostStatus(2,"OFF")],"old","other-account"))).body as any;
 const row=cleared.operations.find((operation:any)=>operation.definition.operationID===operationID);
 assert.equal(row.runtime.state,"DRAFT");
 assert.equal(row.runtime.operationRunID,null);
 assert.deepEqual(row.definition,saved);
 assert.equal(doc(index).read(),null);
 if(mode==="stock-offline"||mode==="watchdog"){
  assert.deepEqual(doc(snapshotKey).read(),before,"unresolved freight is retained without fictional settlement");
  assert.deepEqual(doc(haul).read(),{pending:{kind:"moveItems",quantity:67090}});
  assert.ok(doc(formation).read());assert.ok(definitions.document(launchSetup).read());assert.ok(cycles.document(cycleKey).read());
  if(mode==="stock-offline"){
   assert.equal(row.runtime.lastRun,null);
   const retried=await call("POST /mining-operations/:operationID/stop",{operationRunID:"old",mode:"RETURN_HOME"});
   assert.deepEqual(retried,{status:202,body:{ok:true,mode:"COLLECT_FREIGHT",live:false}});
   assert.deepEqual(doc(snapshotKey).read(),before);
  }
 }else{
  for(const key of [snapshotKey,haul,formation])assert.equal(doc(key).read(),null,key);
  assert.equal(definitions.document(launchSetup).read(),null);
  for(const key of [cycleKey,"pilot:1","compression:"+JSON.stringify([operationID,"old",1])])assert.equal(cycles.document(key).read(),null,key);
 }
 assert.equal(definitions.document(launchKey).read(),null);
 if(mode==="COLLECT_FREIGHT"){
  const archive="GET /mining-operations/:operationID/delivery-receipts",query={runID:"old",containerID:"55"};
  const result={runID:"old",observedAt:row.runtime.lastRun.observedAt,deliveredContainers:1,deliveredUnits:67090,
   deliveredVolumeM3:6709,unitsByType:{"30":67090},trips:null};
  assert.ok(Number.isFinite(result.observedAt));
  assert.deepEqual(row.runtime.lastRun,result);
  assert.deepEqual((await call(archive)).body,{ok:true,receipts:[],lastRun:result});
  assert.deepEqual((await call(archive,null,undefined,"owner",{runID:"old"})).body,{ok:true,result});
  assert.equal((await call(archive,null,undefined,"owner",query)).status,404);
  assert.deepEqual(runtimeDocs.documentNames('mining-delivery-receipt:'+suffix.slice(0,-1)+','),[]);
  assert.equal((await call(archive,null,undefined,"other-world",query)).status,404);
  assert.equal((await call(archive,null,undefined,"owner",{...query,runID:"fresh"})).status,404);
 }
 assert.ok(cycles.document("pilot:2").read());assert.ok(doc(independent).read());
 assert.ok(life.targetSnapshot()[otherClaim.key]);
 assert.equal(life.targetSnapshot()[claim.key],undefined);
 assert.equal(routes["POST /mining-operations/:operationID/recovery/dispatch"],undefined);
 assert.equal(launchReceipt(operationID,"old"),null);
 for(const resumed of [false,true]){
  const ctx={setup:old,characterID:2,held:{characterID:2},resumed} as unknown as PluginRunContext;
  await assert.rejects(Promise.resolve(life.runs.HAULER.start(ctx)),/fleet launch has ended/);
 }
 assert.equal((await begin(setup(operationID,"fresh"))).status,undefined);
 const fresh=life.getOrCreate(setup(operationID,"fresh"));
 assert.equal(fresh.op.snapshot().state,"READY");assert.deepEqual(fresh.op.snapshot().haulClaims,{});
 assert.equal((await call("POST /mining-operations/:operationID/stop",{operationRunID:"old",mode:"RETURN_HOME"})).status,400);
 assert.equal(fresh.op.snapshot().stopRequested,undefined);
 assert.equal((await call("POST /mining-operations/:operationID/launch/accept",{characterID:2,operationRunID:"old",botID:"late"})).status,400);
 assert.ok(life.discardGeneration(operationID,"fresh"));
 assert.ok(life.discardGeneration("other-"+mode,"old"));
 cycles.close();
});

test("retiring a target owner preserves depletion, danger and Mark safe acknowledgement",()=>{
 let saved:unknown=null,now=1000;
 const board=createTargetBoard({read:()=>saved,write:v=>{saved=structuredClone(v);}},()=>now,10);
 const danger=belt("Danger"),safe=belt("Safe"),depleted=belt("Depleted");
 const old=board.reserve("op","old",danger)!;
 assert.ok(board.activate(old));assert.ok(board.markDangerous({target:danger,operationID:"op",runID:"old",lostAt:900}));
 assert.ok(board.markDangerous({target:safe,operationID:"op",runID:"old",lostAt:901}));
 assert.ok(board.markSafe("BELT:300:Safe"));
 const exhausted=board.reserve("op","old",depleted)!;
 assert.ok(board.activate(exhausted));assert.ok(board.drain(exhausted));
 assert.ok(board.finish(exhausted,{source:"checked-empty-grid",key:exhausted.key,observedAt:now},true));
 const observed=board.reserve("op","old",belt("Confirmed empty"))!;
 assert.ok(board.activate(observed));assert.ok(board.noteDepletion(observed,{source:"checked-empty-grid",key:observed.key,observedAt:now}));
 now+=20;assert.equal(board.read(old.key)?.state,"QUARANTINED");
 board.releaseGeneration("op","old");
 assert.equal(board.read(old.key),null);assert.ok(board.isDangerous(old.key));
 assert.equal(board.read(exhausted.key)?.state,"DEPLETED");
 assert.equal(board.read(observed.key)?.state,"DEPLETED");
 assert.equal(board.markDangerous({target:safe,operationID:"op",runID:"old",lostAt:901}),false);
 assert.equal(board.isDangerous("BELT:300:Safe"),false);
});
