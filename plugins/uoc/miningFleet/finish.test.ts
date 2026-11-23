import type {BackendPilotObservation} from "../shared/backendScope.ts";
import {memoryFleetDocuments} from "./operationStoreFixture.ts";
import {fleetOperationStore,deliveryReceiptIndex} from "./operationStore.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {createFleetFinishRun,readRetainedFleetTarget,type FleetFinishDependencies} from "./finish.ts";
import {createOperation} from "./operation.ts";
import {createTargetBoard} from "./targetBoard.ts";
import type {FleetSetup} from "./runtime.ts";
import {runControlRoutes} from "../runControl.ts";
import {createMiningOperationRoutes} from "../operations/miningRoutes.ts";
import {projectFleetRun} from "../operations/miningReadout.ts";
import {setupHash} from "../operations/miningRecovery.ts";
import type {UocBackendRequest as BackendRequest} from "../shared/backendScope.ts";
import type {FleetLaunchReceipt} from "../operations/miningLaunchJournal.ts";

for(const problem of [null,"online","undocked","wrong account","dispatched haul","dispatched parking unload"] as const)
test("offline Return Home Finalize "+(problem?"refuses "+problem:"settles nine parked pilots without historical ship or fitting reads"),async()=>{
 const members:FleetSetup["members"]=Array.from({length:9},(_,i)=>({
  characterID:i+1,shipID:i+11,role:i===2?"HAULER":i<5?"MINER":"DEFENDER",
 }));
 const x=fixture(true,false,false,false,members),op=x.original,claim=op.snapshot().claim!;
 if(problem!=="dispatched haul")assert.ok(op.markDelivered(3,{
  source:"native-transfer",operationID:"op",runID:"old",containerID:100,claimGeneration:claim.generation,shipID:13,destinationID:600,
  observedAt:Date.now(),sourceAfter:[],destinationBefore:[],destinationAfter:[{typeID:30,quantity:10}],
 }));
 op.noteStopRequest("RETURN_HOME");
 op.requestStop();
 for(const m of members.slice(2)){
  if(m.characterID===3&&problem==="dispatched haul")continue;
  assert.ok(op.settleMember(m.characterID,{source:"native-settlement",runID:"old",shipID:m.shipID,
   modulesInactive:true,dronesSafe:true,observedAt:Date.now()}));
  assert.ok(op.parkMember(m.characterID,{source:"native-flight",runID:"old",shipID:m.shipID,locationID:600,docked:true,observedAt:Date.now()}));
 }
 const before=op.snapshot(),oldCycle=x.store("cycle:1").read();
 const successorBoard=createTargetBoard(x.store("board"),()=>Date.now()+60_000,30_000,()=>true);
 const successor=successorBoard.reserve("next","run",{kind:"BELT",systemID:300,name:"belt"})!;
 assert.ok(successorBoard.activate(successor));
 x.deps.board=successorBoard;
 if(problem==="dispatched parking unload")x.store('mining-fleet-finish-parking-unload:'+JSON.stringify(["op","old",2,12])).write({pending:{issuedAt:Date.now()}});
 const scope=JSON.stringify(["world"]),receipt={version:1,operationID:"op",operationRunID:"old",revision:1,
  planHash:"original",setupHash:setupHash(x.setup),members:members.map(m=>({
   characterID:m.characterID,accountName:"pilot"+m.characterID,role:m.role,kind:"mcc-"+m.role.toLowerCase(),
   status:"ACCEPTED",botID:"old-"+m.characterID,beforeIDs:[],
  }))};
 x.store("mining-definitions:"+scope).write({version:1,definitions:[{
  operationID:"op",revision:1,createdAt:"old",updatedAt:"old",name:"Mining fleet",
  area:{anchorSystemID:300,anchorSystemName:"Mining system",reach:"CURRENT_SYSTEM",targetClasses:["BELT"]},
  targetPolicy:"ANY_ELIGIBLE",unloadPolicy:"HAULER_SERVICE",
  unloadDestination:{stationID:600,stationName:"Home",corporationDivision:1,corporationID:77},
  members:receipt.members.map(m=>({characterID:m.characterID,characterName:m.accountName,accountName:m.accountName,role:m.role,
   routineMode:"STANDARD",automationID:""})),
  policies:{version:1,parking:{mode:"STAY_IN_PLACE",destination:null,corporationDivision:null,corporationID:null},
   travelAssist:{mode:"AUTO"},resourcePolicy:{mode:"ANY_ELIGIBLE",source:"MANUAL",typeIDs:[]}},
  preparation:{source:{kind:"hangar"},suppliesRequired:false},
  oreLogistics:{version:1,remoteCompression:false,compressedJettisonFraction:.5},
 }]});
 x.store("mining-launch:"+JSON.stringify([scope,"op"])).write(receipt);
 x.store("mining-launch-setup:"+JSON.stringify([scope,"op","old"])).write(x.setup);
 const routes=createMiningOperationRoutes({document:x.store,getWorldScope:()=>"world",isOperationActive:()=>false,
  operationSnapshot:()=>x.store(x.opKey).read(),retainedSetup:()=>x.setup,
  authorizeFinish:r=>x.store('mining-fleet-finish-authority:'+JSON.stringify(["op","old"])).write(r),finalizeRetainedStop:x.run.finalize});
 const request:BackendRequest={method:"GET",path:"",params:{operationID:"op"},query:{},body:null,account:{accountID:10,username:"commander"}};
 const {body:review}=await routes["GET /mining-operations/:operationID/recovery"]!(request) as any;
 assert.equal(review.ok,true,review.message);
 const {recovery}=review;
 assert.equal(recovery.observeOfflineParking,true);
 assert.ok(!recovery.completedMembers.includes(1)&&!recovery.completedMembers.includes(2));
 const proof:BackendPilotObservation[]=members.map(m=>({
  accountName:m.characterID===1&&problem==="wrong account"?"another": "pilot"+m.characterID,
  characterID:m.characterID,owner:m.characterID===1&&problem==="online"?"BOT":"OFF",
  online:m.characterID===1&&problem==="online",observedAt:Date.now(),
  dock:m.characterID===1&&problem==="undocked"?null:{
   shipID:m.characterID===1?901:m.shipID,stationID:m.characterID===2?602:600,
   structureID:null,systemID:m.characterID===2?302:300,
  },
 }));
 const finalize=routes["POST /mining-operations/:operationID/recovery/finalize"]!;
 const body={recoveryHash:recovery.recoveryHash};
 assert.equal((await finalize({...request,body:{...body,pilotObservations:proof}})).status,400,"client supplied evidence is ignored");
 const result=await finalize({...request,body,pilotObservations:proof} as BackendRequest);
 assert.equal(x.attachments(),0);
 assert.deepEqual(x.deposits,[]);
 assert.deepEqual(x.store("cycle:1").read(),oldCycle);
 const after=x.store(x.opKey).read() as ReturnType<typeof op.snapshot>;
 assert.deepEqual(after.manifests,before.manifests);
 assert.deepEqual(successorBoard.read(claim.key)?.claim,successor);
 if(problem){
  assert.equal(result.status,400);
  assert.deepEqual(after,before);
  return;
 }
 assert.deepEqual(result.body,{ok:true,state:"STOPPED"});
 assert.equal(after.state,"STOPPED");
 assert.equal(after.parked.length,9);
 assert.equal(after.offlineParking?.["1"]?.shipID,901);
 assert.equal(after.offlineParking?.["1"]?.atPlannedDock,true);
 assert.equal(after.offlineParking?.["2"]?.locationID,602);
 assert.equal(after.offlineParking?.["2"]?.atPlannedDock,false);
 assert.deepEqual(after.members,before.members);
 const {body:{operations}}=await routes["GET /mining-operations"]!(request) as any;
 const {runtime}=operations[0],released=new Map(members.map(m=>[m.characterID,{owners:[],bots:[],offline:true}]));
 const readout=projectFleetRun(receipt as FleetLaunchReceipt,released,[],runtime.state,runtime.members);
 assert.match(readout.members.find(m=>m.characterID===2)!.phase!,/602.*away from planned home/);
});

test('incomplete assembly excludes only never-dispatched members and never deposits pre-existing cargo',async()=>{
 const x=fixture(),row=x.store(x.opKey).read() as any;assert.ok(x.deps.board.drain(row.claim));assert.ok(x.deps.board.releaseDrained(row.claim,{allMembersParked:true,freightSettled:true}));x.store(x.opKey).write({...row,state:'READY',claim:null});const launch={version:1,operationID:'op',operationRunID:'old',setupHash:'original',members:x.setup.members.map(m=>({...m,kind:'mcc-'+m.role.toLowerCase(),accountName:'a'+m.characterID,beforeIDs:[],status:m.characterID===1?'ACCEPTED':'PREPARED',botID:m.characterID===1?'old-1':null}))};x.store('mining-fleet-finish-authority:'+JSON.stringify(['op','old'])).write(launch);
 x.store('cycle:1').write(null);x.store('cycle:2').write(null);await x.run.start(x.actor(1));const r=await outcome(x.reports,1);assert.equal(r.status,'stopped',r.why);assert.equal(r.readout.groupCompleted,true);assert.deepEqual(x.deposits,[]);const stopped=x.store(x.opKey).read() as any;assert.deepEqual(stopped.neverStarted,[2,3]);assert.deepEqual(stopped.settled,[1]);assert.equal(stopped.state,'STOPPED');assert.ok(x.holds.has(1));
});
test('FINISH after a recorded startup Stop parks held pilots without treating old cargo as fleet freight',async()=>{
 const x=fixture(),row=x.store(x.opKey).read() as any;
 assert.ok(x.deps.board.drain(row.claim));
 assert.ok(x.deps.board.releaseDrained(row.claim,{allMembersParked:true,freightSettled:true}));
 x.store(x.opKey).write({...row,state:'SETTLING',claim:null,stoppedBeforeWork:true});
 x.store('mining-fleet-finish-authority:'+JSON.stringify(['op','old'])).write({
  version:1,operationID:'op',operationRunID:'old',setupHash:'original',
  members:x.setup.members.map(m=>({...m,kind:'mcc-'+m.role.toLowerCase(),accountName:'a'+m.characterID,beforeIDs:[],status:'ACCEPTED',botID:'old-'+m.characterID}))
 });
 for(const id of [1,2,3]){
  x.store('cycle:'+id).write(null);
  await x.run.start(x.actor(id));const result=await outcome(x.reports,id);
  assert.equal(result.status,'stopped',result.why);
 }
 assert.equal((x.store(x.opKey).read() as any).state,'STOPPED');
 assert.deepEqual(x.deposits,[]);assert.ok(x.holds.has(1));
});
test("a docked historical hauler settles without adopting unassigned freight",async()=>{
 const x=fixture(true),row=x.store(x.opKey).read() as any,at=Date.now();
 assert.equal(x.deps.board.drain(row.claim),true);
 x.store(x.opKey).write({...row,state:"DRAINING",stopRequested:true,haulClaims:{},settled:[1,2],parked:[1,2],settledAt:{1:at,2:at}});
 await x.run.start(x.actor(3));
 const result=await outcome(x.reports,3),final=x.store(x.opKey).read() as any;
 assert.equal(result.status,"stopped",result.why);
 assert.equal(result.readout.groupCompleted,true);
 assert.equal(final.state,"STOPPED");assert.deepEqual(final.parked,[1,2,3]);
 assert.deepEqual(final.manifests,[]);assert.deepEqual(x.receipts(),[]);
 assert.deepEqual(x.deposits,[]);
});
test("Return Home parks the retained hauler at its configured dock without visiting the freight destination",async()=>{
 const x=fixture(true),options={inSpace:true,station:601};
 x.original.noteStopRequest("RETURN_HOME");x.original.requestStop();
 x.deps.deliveryPark=async()=>{throw Error("unexpected freight route");};
 x.deps.recoverHaul=async()=>{throw Error("unexpected freight recovery");};
 Object.assign(x.setup,{parking:{mode:"RETURN_HOME_DOCK",destinationID:601,kind:"station",systemID:300}});
 x.store("mining-fleet-index:op").write({runID:"old",signature:JSON.stringify(x.setup)});
 const destinations:number[]=[];
 x.deps.park=async(_run,_session,setup,shipID)=>{
  assert.equal(setup.parking?.mode,"RETURN_HOME_DOCK");
  const locationID=setup.parking!.destinationID;destinations.push(locationID);options.inSpace=false;
  return {kind:"dock",proof:{source:"native-flight",shipID,locationID,docked:true,observedAt:Date.now()}};
 };
 await x.run.start(x.actor(3,options));
 const result=await outcome(x.reports,3),final=x.store(x.opKey).read() as ReturnType<typeof x.original.snapshot>;
 assert.equal(result.status,"stopped",result.why);
 assert.deepEqual(destinations,[601]);
 assert.deepEqual(final.parked,[3]);
 assert.deepEqual(final.haulClaims,{});
 assert.deepEqual(x.receipts(),[]);
 assert.deepEqual(x.released,[3]);
});
test('configured different-home recovery completes from empty holds without delivery replay',async()=>{
 const x=fixture();Object.assign(x.setup,{parking:{mode:'RETURN_HOME_DOCK',destinationID:601,kind:'station',systemID:300}});x.store('mining-fleet-index:op').write({runID:'old',signature:JSON.stringify(x.setup)});x.holds.clear();for(const id of [1,2,3]){await x.run.start(x.actor(id,{station:601}));const r=await outcome(x.reports,id);assert.equal(r.status,'stopped',r.why);}assert.equal((x.store(x.opKey).read() as any).state,'STOPPED');assert.deepEqual(x.deposits,[]);
});
test('undocked STAY recovery uses native STOP and never invents docking',async()=>{
 const x=fixture();Object.assign(x.setup,{parking:{mode:'STAY_IN_PLACE'}});x.store('mining-fleet-index:op').write({runID:'old',signature:JSON.stringify(x.setup)});x.store(x.opKey).write({...x.store(x.opKey).read() as any,stopMode:'STAY_IN_PLACE'});x.holds.clear();for(const id of [1,2,3]){await x.run.start(x.actor(id,{inSpace:true}));const r=await outcome(x.reports,id);assert.equal(r.status,'stopped',r.why);assert.match(r.phase,/Settled in place/);}const stopped=x.store(x.opKey).read() as any;assert.equal(stopped.state,'STOPPED');assert.deepEqual(stopped.parked,[]);assert.deepEqual(stopped.stayed,[1,2,3]);assert.deepEqual(x.deposits,[]);
});
test('pending relocation cancels the next target and settles old custody without restarting production',async()=>{
 const x=fixture(),row=x.store(x.opKey).read() as any;x.store(x.opKey).write({...row,relocation:{phase:'PREPARING',oldClaim:row.claim,next:{kind:'BELT',systemID:300,name:'Unused Next'}}});for(const id of [1,2,3]){await x.run.start(x.actor(id));const r=await outcome(x.reports,id);assert.equal(r.status,'stopped',r.why);}const stopped=x.store(x.opKey).read() as any;assert.equal(stopped.state,'STOPPED');assert.equal(stopped.relocation,undefined);assert.equal(x.deps.board.read('BELT:300:Unused Next'),null);
});

function fixture(withHaul=false,ice=false,command=false,personal=false,members?:FleetSetup["members"]){const docs=new Map<string,unknown>(),storage=memoryFleetDocuments(docs),store=storage.document;
 const operationStore=(id:string,run:string)=>fleetOperationStore(storage,id,run);
 const setup:FleetSetup={operationID:"op",operationRunID:"old",systemID:300,destinationID:600,corporationID:77,division:1,beltID:99,beltName:"belt",canCapacityM3:100,members:members??[{characterID:1,shipID:11,role:"MINER"},{characterID:2,shipID:12,role:"MINER"},{characterID:3,shipID:13,role:"HAULER"}]};
 if(personal){delete (setup as any).corporationID;delete (setup as any).division;(setup as any).delivery={kind:"structure",destinationID:600,systemID:300,corporationID:null,division:null};}
 const iceSite:any={scannerKey:5400003000000,instanceID:89,label:"ice",archetypeID:28,observedAt:100,sourceDungeonID:5497,siteFamily:"ICE",target:{kind:"ICE",systemID:300,name:"ice",siteID:5400003000000,instanceID:89,position:{x:1,y:2,z:3}}};if(ice){delete (setup as any).beltID;delete (setup as any).beltName;(setup as any).siteSearch={family:"ICE"};if(command){(setup as any).command={moduleID:60,typeID:61};(setup as any).members=[...setup.members,{characterID:4,shipID:14,role:"COMMAND"}];}}
 const board=createTargetBoard(store("board")),opKey=`mining-fleet-operation:${JSON.stringify(["op","old"])}`;docs.set("mining-fleet-index:op",{runID:"old",signature:JSON.stringify(setup)});
 const lead=setup.members.find(m=>m.role==="MINER")!.characterID;
 const original=createOperation(operationStore("op","old"),board,{operationID:"op",runID:"old",systemID:300,destinationID:600,...(setup.delivery?{delivery:setup.delivery}:{}),members:setup.members}),claim=original.reserve(lead,ice?iceSite.target:{kind:"BELT",systemID:300,name:"belt"})!;assert.ok(claim);assert.ok(original.activate(lead));
 if(withHaul){const item={itemID:20,typeID:30,quantity:10,freightKind:"RAW" as const,unitVolumeM3:1},facts={30:{categoryID:25,freightKind:"RAW" as const,unitVolumeM3:1}},at=Date.now();
  const intent=original.prepareJetcan(1,[item],100,facts,{source:"checked-ship-holds",characterID:1,shipID:11,systemID:300,targetKey:claim.key,claimGeneration:claim.generation,observedAt:at,items:[{...item,ownerID:1,locationID:11,flagID:134}]})!;assert.ok(intent);assert.ok(original.dispatchJetcan(1,intent.generation));
  assert.ok(original.registerJetcan({source:"native-jetcan",operationID:"op",runID:"old",targetKey:claim.key,claimGeneration:claim.generation,characterID:1,shipID:11,systemID:300,containerID:100,intentGeneration:intent.generation,observedAt:at,items:[item],capacityM3:100},facts));const haul=original.claimContainer(3,100)!;assert.ok(haul);assert.ok(original.dispatchHaul(3,100,haul.generation));}
 for(const m of setup.members.filter(m=>m.role==="MINER"))docs.set(`cycle:${m.characterID}`,{version:1,identity:JSON.stringify(["op","old",m.characterID,m.shipID,300,ice?iceSite.target:99,`old-${m.characterID}`]),nextOrdinal:5,pending:null,closed:false,retired:[777],history:["retained"]});
 if(ice)docs.set(`mining-fleet-site-search:${JSON.stringify(["op","old",1,11])}`,{version:1,identity:JSON.stringify(["old-1",1,11,300,0,"ICE"]),pending:null,history:[],site:iceSite});
 const reports:any[]=[],deposits:number[]=[],holds=new Set([1,2]),stops=new Map<string,()=>void>(),released:number[]=[];let attachments=0;const deps:FleetFinishDependencies={document:store,operationStore,cycleDocument:id=>store(`cycle:${id}`),board,decodeSetup:v=>JSON.stringify(v)===JSON.stringify(setup)?setup:null,assertNoLiveGroup(){},owner:async()=>"verified-account",register:(r,_owner,callback)=>{stops.set(r.botID,callback);return()=>stops.delete(r.botID);},
  attach:async r=>{attachments++;return {store:{station:{get:()=>({online:{characterID:r.held.characterID}})}},flow:{requestOptions:()=>({}),setLivePush(value:boolean){if(!value)released.push(r.held.characterID)},flying:{sessionGeneration:()=>1,isSessionClosing:()=>false,bridgeAsk:async()=>({type:"object",name:"util.KeyVal",args:{type:"dict",entries:[["itemID",55],["invItem",{type:"packedrow",fields:{itemID:55,typeID:483,ownerID:r.held.characterID,locationID:r.held.characterID===1?11:12,flagID:27}}],["activeEffects",{type:"dict",entries:[]}],["time",{type:"long",value:"134385165369240001"}],["wallclockTime",{type:"long",value:"134385165369240001"}]]}})}}} as any;},settle:async()=>({modulesInactive:true,dronesSafe:true,observedAt:Date.now()}),quiescence:async(r,_s,m)=>({source:"native-fitted-modules",characterID:r.characterID,shipID:m.shipID,observedAt:Date.now(),modules:[{moduleID:55,typeID:483,flagID:27}]}),
  readHolds:async(_session,_current,id,shipID)=>holds.has(id)?[{itemID:100+id,typeID:30,ownerID:id,locationID:shipID,flagID:134,quantity:5,categoryID:25}]:[],rawFacts:async()=>({30:{categoryID:25,freightKind:"RAW",unitVolumeM3:1,...(ice?{resourceFamily:"ice" as const}:{})}}),
  depositOwnedRaw:async(_run,_session,config)=>{const id=config.source.characterID;deposits.push(id);holds.delete(id);return {source:config.source,destinationID:600,corporationID:personal?null:77,division:personal?null:1,officeID:personal?600:700,...(personal?{delivery:setup.delivery}:{}),completedAt:Date.now(),batches:config.source.items.map(item=>({item,sourceBefore:[],sourceAfter:[],destinationBefore:[],destinationAfter:[],acknowledged:true}))};},
  recoverHaul:async(_run,_session,_setup,m,manifest,generation,_current,doc)=>{const at=Date.now(),proof={kind:"relocated-manifest-items" as const,items:manifest.items.map(i=>({...i,ownerID:m.characterID,locationID:m.shipID,flagID:134})),observedAt:at};doc.write({nativeRelocation:proof});return {source:"native-transfer",operationID:"op",runID:"old",containerID:manifest.containerID,claimGeneration:generation,shipID:m.shipID,destinationID:600,sourceProof:proof,destinationBefore:[],destinationAfter:[{typeID:30,quantity:10}],observedAt:at};}};
 const run=createFleetFinishRun(deps);
 const actor=(id:number,options:{extraOwner?:boolean;latePrior?:boolean;station?:number;corp?:number;status?:string;differentOwner?:boolean;targets?:unknown;priorTerminal?:boolean;inSpace?:boolean;systemID?:number}={})=>{const m=setup.members.find(x=>x.characterID===id)!;const botID=`finish-${id}`;const fetcher:typeof fetch=async input=>{const p=new URL(String(input)).pathname;let body:any;if(p==="/api/bots")body={bots:[{botID:options.differentOwner?"different":botID,characterID:id,status:options.status??"running",startedAt:"2026-01-01T00:00:00Z",endedAt:null},...(options.extraOwner?[{botID:"competing",characterID:id,status:"running",endedAt:null}]:[]),...(options.latePrior?[{botID:`old-${id}`,characterID:id,status:"stopped",endedAt:"2026-01-02T00:00:00Z"}]:options.priorTerminal?[{botID:`old-${id}`,characterID:id,status:"stopped",endedAt:"2025-12-31T00:00:00Z"}]:[])]};else if(p==="/api/bridge/targets")body={targetIDs:options.targets===undefined?[]:options.targets};else if(p==="/api/bridge/flight/status")body={flight:{docked:!options.inSpace,inSpace:options.inSpace===true,shipMode:"STOP",stationID:options.inSpace?null:personal?null:options.station??600,structureID:options.inSpace?null:personal?options.station??600:null,solarSystemID:options.systemID??300,shipID:m.shipID,transition:{phase:"ready"}}};else throw Error(`Unexpected ${p}`);return Response.json({ok:true,...body});};
  return {botID,characterID:id,setup:{operationID:"op",operationRunID:"old"},held:{characterID:id,character:{characterID:id,corporationID:options.corp??77}},resumed:false,baseUrl:"http://bff",fetch:fetcher,report:(r:any)=>reports.push({id,...r})} as any;};
 return {docs,store,setup,opKey,receipts:()=>deliveryReceiptIndex(storage,"op").map(({runID,containerID})=>operationStore("op",runID).readDelivery(containerID)?.receipt),original,run,actor,reports,deposits,deps,stops,released,holds,attachments:()=>attachments};}
async function outcome(reports:any[],id:number){for(let i=0;i<100&&!reports.some(x=>x.id===id);i++)await new Promise(resolve=>setTimeout(resolve,2));const r=reports.find(x=>x.id===id);assert.ok(r,"finish report missing");return r;}

test("Retry Stop only releases the seven unfinished pilots once their original home unloads finish",async()=>{
 const members:FleetSetup["members"]=Array.from({length:15},(_,i)=>({
  characterID:i+1,shipID:i+11,role:i<6?"MINER":i===6?"HAULER":"DEFENDER",
 }));
 const x=fixture(false,false,false,false,members);
 x.deps.dockedUnloadsOnly=true;
 x.deps.settle=async()=>{assert.fail("Already settled pilots only need the docked unload.");};
 Object.assign(x.setup,{parking:{mode:"RETURN_HOME_UNLOAD_DOCK",kind:"station",destinationID:601,systemID:301,corporationID:77,division:1}});
 x.store("mining-fleet-index:op").write({runID:"old",signature:JSON.stringify(x.setup)});
 x.store('mining-fleet-finish-authority:'+JSON.stringify(['op','old'])).write({
  version:1,operationID:"op",operationRunID:"old",members:members.map(m=>({
   ...m,accountName:"verified-account",status:"ACCEPTED",botID:"old-"+m.characterID,
  })),
 });
 x.original.noteStopRequest("RETURN_HOME");x.original.requestStop();
 for(const m of members){
  assert.ok(x.original.settleMember(m.characterID,{source:"native-settlement",runID:"old",shipID:m.shipID,
   modulesInactive:true,dronesSafe:true,observedAt:Date.now()}));
  if(m.characterID>7)assert.ok(x.original.parkMember(m.characterID,{source:"native-flight",runID:"old",shipID:m.shipID,locationID:601,docked:true,observedAt:Date.now()}));
 }
 await assert.rejects(x.run.finalize({operationID:"op",operationRunID:"old"},[]),/Offline docking cannot confirm/);
 const unloaded:number[]=[];
 x.deps.park=async(run,_session,setup,shipID,_current,_document,options)=>{
  assert.equal(options?.dockedOnly,true);
  assert.deepEqual(setup.parking,x.setup.parking);
  unloaded.push(run.characterID);
  if(run.characterID===1&&unloaded.length===1){
   options.onUnloadRemaining?.({units:123,volumeM3:12.3});
   throw Error("Division 1 unavailable");
  }
  return {kind:"dock",proof:{source:"native-flight",shipID,locationID:601,docked:true,observedAt:Date.now()}};
 };
 const wrong=await x.run.start(x.actor(2,{station:601}));
 assert.match((await outcome(x.reports,2)).why,/configured home/);
 await wrong.stop();
 x.reports.length=0;
 await x.run.start(x.actor(1,{station:601,systemID:301}));
 const blocked=await outcome(x.reports,1);
 assert.match(blocked.why,/Division 1 unavailable/);
 assert.equal(blocked.readout.pendingUnloadUnits,123);
 assert.deepEqual(x.released,[2]);
 assert.equal((x.store(x.opKey).read() as any).parked.length,8);
 x.stops.get("finish-1")!();
 await waitTerminal(x,1);
 for(const m of members.slice(1,7)){
  await x.run.start(x.actor(m.characterID,{station:601,systemID:301}));
  const report=await outcome(x.reports,m.characterID);
  assert.equal(report.status,"stopped",report.why);
  assert.equal(report.readout.groupCompleted,m.characterID===7);
 }
 assert.deepEqual(unloaded,[1,1,2,3,4,5,6,7]);
 const finished=x.store(x.opKey).read() as ReturnType<typeof x.original.snapshot>;
 assert.equal(finished.parked.length,15);
 assert.equal(finished.state,"STOPPED");
});

test("released fleet cleanup drops a stale Finish group without native work",async()=>{
 const x=fixture(),actor=x.actor(1,{corp:99});
 const input={operationID:"op",operationRunID:"old"};
 actor.resumed=true;
 await assert.rejects(Promise.resolve(x.run.resumeHeld(actor,input)),/Finish pilot.*invalid/);
 assert.equal(x.run.ownsOperation("op"),true);
 assert.ok(x.run.discardReleased({...input,operationRunID:"unrelated"}));
 assert.equal(x.run.ownsOperation("op"),true);
 assert.ok(x.run.discardReleased(input));
 assert.equal(x.run.ownsOperation("op"),false);
 assert.equal(x.attachments(),0);
 assert.deepEqual(x.deposits,[]);
});
test("exact docked actors share operation authority; each finishes and last alone reports group completion",async()=>{const x=fixture();for(const id of [1,2,3]){await x.run.start(x.actor(id));const r=await outcome(x.reports,id);assert.equal(r.status,"stopped",r.why);assert.equal(r.readout.groupCompleted,id===3);assert.equal(x.run.ownsOperation("op"),id!==3);}assert.deepEqual(x.deposits,[1,2]);const c=x.store("cycle:1").read() as any;assert.equal(c.closed,true);assert.deepEqual(c.history,["retained"]);assert.equal((x.store(x.opKey).read() as any).state,"STOPPED");});
test("the core starting row is an eligible current exclusive held lease",async()=>{const x=fixture();await x.run.start(x.actor(1,{status:"starting"}));const r=await outcome(x.reports,1);assert.equal(r.status,"stopped",r.why);assert.deepEqual(x.deposits,[1]);});
test("a changed index cannot convert original hauler custody into self-unload",async()=>{const x=fixture();Object.assign(x.setup,{haulMode:"SELF_UNLOAD",members:x.setup.members.filter(m=>m.role==="MINER")});x.store("mining-fleet-index:op").write({runID:"old",signature:JSON.stringify(x.setup)});const before=structuredClone([...x.docs]);await assert.rejects(async()=>await x.run.start(x.actor(1)),/Operation custody requires reconciliation/);assert.equal(x.attachments(),0);assert.deepEqual(x.deposits,[]);assert.deepEqual([...x.docs],before);});
test("stopping, terminal or a different current owner never authorizes recovery",async()=>{for(const options of [{status:"stopping"},{status:"stopped"},{status:"error"},{status:"starting",differentOwner:true}]){const x=fixture();await x.run.start(x.actor(1,options));const r=await outcome(x.reports,1);assert.equal(r.status,"paused");assert.match(r.why,/exclusive hosted pilot lease/);assert.deepEqual(x.deposits,[]);}});
test("miners can finish before a legacy held haul; hauler settles exact manifest without pickup",async()=>{const x=fixture(true);for(const id of [1,2,3]){await x.run.start(x.actor(id));const r=await outcome(x.reports,id);assert.equal(r.status,"stopped",r.why);assert.equal(r.readout.groupCompleted,id===3);}const op=x.store(x.opKey).read() as any;assert.equal(op.state,"STOPPED");assert.equal(op.manifests[0].delivered,true);assert.equal(x.receipts()[0]?.sourceProof?.kind,"relocated-manifest-items");});
test("another miner pending action does not prevent this miner or hauler settling",async()=>{const x=fixture(),c=x.store("cycle:2").read() as any;c.pending={kind:"mining-cycle"};x.store("cycle:2").write(c);for(const id of [1,3]){await x.run.start(x.actor(id));const r=await outcome(x.reports,id);assert.equal(r.status,"stopped",r.why);assert.equal(r.readout.groupCompleted,false);}assert.deepEqual((x.store("cycle:2").read() as any).pending,{kind:"mining-cycle"});assert.notEqual((x.store(x.opKey).read() as any).state,"STOPPED");});
function targetLock(x:ReturnType<typeof fixture>,id:number){const c=x.store(`cycle:${id}`).read() as any,claim=(x.store(x.opKey).read() as any).claim;c.nextOrdinal=1;c.pending={kind:"target-lock",ownerRunID:`old-${id}`,issuedAt:1000,details:{scope:JSON.stringify([c.identity,claim.key,claim.generation,777,30]),targetID:777}};x.store(`cycle:${id}`).write(c);return c.pending;}
test("own unactivated target intent is retained as unknown after confirmed native dock and empty targets",async()=>{const x=fixture(),original=targetLock(x,1);targetLock(x,2);await x.run.start(x.actor(1));const r=await outcome(x.reports,1);assert.equal(r.status,"stopped",r.why);assert.equal(r.readout.groupCompleted,false);const c=x.store("cycle:1").read() as any;assert.equal(c.pending,null);assert.equal(c.nextOrdinal,1);assert.equal(c.retiredLocks.length,1);assert.deepEqual(c.retiredLocks[0].intent,original);assert.equal(c.retiredLocks[0].outcome,"RETIRED_AFTER_CONFIRMED_DOCK");assert.equal(c.retiredLocks[0].originalOutcome,"UNKNOWN");assert.deepEqual(c.retiredLocks[0].nativeEvidence.targetIDs,[]);assert.equal((x.store("cycle:2").read() as any).pending.kind,"target-lock");});
test("other pending kinds, activation history, wrong owner and unreadable targets are never retired",async()=>{for(const mode of ["cycle","ordinal","history","refusal","owner","targets","unreadable","scope"]){const x=fixture();targetLock(x,1);const c=x.store("cycle:1").read() as any;if(mode==="cycle")c.pending.kind="mining-cycle";if(mode==="ordinal")c.nextOrdinal=2;if(mode==="history")c.lastCycle={};if(mode==="refusal")c.lastActivationRefusal={};if(mode==="owner")c.pending.ownerRunID="foreign";if(mode==="scope")c.pending.details.scope="[]";x.store("cycle:1").write(c);await x.run.start(x.actor(1,{targets:mode==="targets"?[777]:mode==="unreadable"?null:[]}));const r=await outcome(x.reports,1);assert.equal(r.status,"paused",mode);assert.deepEqual((x.store("cycle:1").read() as any).pending,c.pending,mode);assert.deepEqual(x.deposits,[],mode);assert.equal((x.store(x.opKey).read() as any).state,"ACTIVE",mode);}});
test("pending jetcan and foreign cycle identity block recovery",async()=>{const a=fixture(),op=a.store(a.opKey).read() as any;op.jetcanIntents["1"]={generation:1,category:"RAW",items:[],capacityM3:100,dispatched:true};a.store(a.opKey).write(op);await assert.rejects(async()=>await a.run.start(a.actor(1)),/Operation evidence is malformed/);assert.deepEqual(a.deposits,[]);
 const b=fixture(),cycle=b.store("cycle:1").read() as any;cycle.identity=JSON.stringify(["op","foreign",1,11,300,99,"old-1"]);b.store("cycle:1").write(cycle);await b.run.start(b.actor(1));assert.match((await outcome(b.reports,1)).why,/another owner or operation/);assert.deepEqual(b.deposits,[]);});
test("an incomplete native deposit receipt cannot close a cycle",async()=>{const x=fixture();x.deps.depositOwnedRaw=async(_r,_s,c)=>({source:c.source,destinationID:600,corporationID:77,division:1,officeID:700,completedAt:Date.now(),batches:[]});await x.run.start(x.actor(1));assert.match((await outcome(x.reports,1)).why,/receipt is incomplete/);assert.equal((x.store("cycle:1").read() as any).closed,false);});
test("native effects not proven inactive prevent claim transition and deposit",async()=>{const x=fixture();x.deps.quiescence=async()=>{throw Error("native active effect")};await x.run.start(x.actor(1));assert.match((await outcome(x.reports,1)).why,/active effect/);assert.deepEqual(x.deposits,[]);assert.equal((x.store(x.opKey).read() as any).state,"ACTIVE");});
test("real docked module observation rejects a native active effect",async()=>{const x=fixture();x.deps.quiescence=undefined;const dict=(value:Record<string,unknown>)=>({type:"dict",entries:Object.entries(value)}),long=(value:string)=>({type:"long",value}),effect=(id:number,target:number|null)=>[55,1,11,target,null,[],id,long("134385165369120001"),id===16?-1:10,1];
 const info={type:"object",name:"util.KeyVal",args:dict({itemID:55,invItem:{type:"packedrow",fields:{itemID:55,typeID:483,ownerID:1,locationID:11,flagID:27}},activeEffects:{type:"dict",entries:[[16,effect(16,null)],[67,effect(67,777)]]},time:long("134385165369180001"),wallclockTime:long("134385165369179999")})};
 const shipInfo={type:"dict",entries:[[11,{type:"object",name:"util.KeyVal",args:dict({itemID:11,attributes:{type:"dict",entries:[[14,1],[13,0],[12,0],[1137,0]]}})}]]};
 const a=x.actor(1),upstream=a.fetch;a.fetch=async(input:unknown,init:unknown)=>new URL(String(input)).pathname==="/api/bridge/fitting"?Response.json({ok:true,activeShipID:11,slots:{type:"list",items:[{type:"packedrow",fields:{itemID:55,typeID:483,groupID:54,categoryID:7,flagID:27,quantity:1,singleton:1}}]},shipInfo,online:{type:"list",items:[55]},errors:{slots:null,shipInfo:null,online:null,chargeFits:null},chargeFits:null}):upstream(input,init);
 x.deps.attach=async()=>({store:{station:{get:()=>({online:{characterID:1}})}},flow:{requestOptions:()=>({}),setLivePush(){},flying:{bridgeAsk:async()=>info,sessionGeneration:()=>1,isSessionClosing:()=>false}}}) as any;await x.run.start(a);assert.match((await outcome(x.reports,1)).why,/remains active/);assert.deepEqual(x.deposits,[]);});
test("unknown recovered haul remains dispatched and prevents group completion",async()=>{const x=fixture(true);x.deps.recoverHaul=async()=>{throw Error("pending delivery unknown")};await x.run.start(x.actor(3));assert.match((await outcome(x.reports,3)).why,/pending delivery unknown/);const op=x.store(x.opKey).read() as any;assert.equal(op.state,"DRAINING");assert.equal(op.haulClaims["100"].dispatched,true);assert.equal(op.manifests[0].delivered,false);});
test("unknown Add retains held owner; normal Stop reconciles on the same session without another Add",async()=>{const x=fixture();let calls=0,nativeAdds=0;
 x.deps.depositOwnedRaw=async(_run,_session,c)=>{calls++;if(calls===1){nativeAdds++;c.document.write({identity:JSON.stringify([c.source,600,77,1,700]),pending:{kind:"delivery"}});x.holds.delete(1);throw Error("unknown Add");}
  assert.ok(c.document.read());return {source:c.source,destinationID:600,corporationID:77,division:1,officeID:700,completedAt:Date.now(),batches:c.source.items.map(item=>({item,sourceBefore:[],sourceAfter:[],destinationBefore:[],destinationAfter:[],acknowledged:false}))};};
 const handle=await x.run.start(x.actor(1)),first=await outcome(x.reports,1);assert.equal(first.status,"paused");assert.match(first.why,/unknown Add/);assert.deepEqual(x.released,[]);assert.equal(x.attachments(),1);assert.equal(x.run.ownsOperation("op"),true);
 x.stops.get("finish-1")!();x.stops.get("finish-1")!();for(let i=0;i<100&&!x.reports.some(r=>r.id===1&&r.status==="stopped");i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(x.reports.filter(r=>r.id===1&&r.status==="stopped").length,1);assert.equal(nativeAdds,1);assert.equal(calls,2);assert.equal(x.attachments(),1);assert.deepEqual(x.released,[1]);await handle.stop();});
test("retired session generation pauses before any native deposit and retains custody",async()=>{const x=fixture();let n=0;x.deps.attach=async()=>({store:{station:{get:()=>({online:{characterID:1}})}},flow:{requestOptions:()=>({}),setLivePush(){},flying:{sessionGeneration:()=>++n,isSessionClosing:()=>false}}}) as any;const handle=await x.run.start(x.actor(1));const report=await outcome(x.reports,1);assert.equal(report.status,"paused");assert.match(report.why,/session changed/);assert.deepEqual(x.deposits,[]);await handle.stop();assert.equal(x.run.ownsOperation("op"),false);
 assert.deepEqual((x.store(x.opKey).read() as any).parked,[]);
});
test("the real account-scoped normal Stop route retries the paused owner",async()=>{const x=fixture();x.deps.owner=undefined;x.deps.register=undefined;let reads=0;x.deps.quiescence=async()=>{if(++reads===1)throw Error("temporary native read failure")};const a=x.actor(1),original=a.fetch;a.fetch=async(input:unknown,init:unknown)=>new URL(String(input)).pathname==="/api/pilot-training/characters"?Response.json({ok:true,account:"pilot1",characters:[{characterID:1}]}):original(input,init);const handle=await x.run.start(a);assert.equal((await outcome(x.reports,1)).status,"paused");
 const response=await runControlRoutes["POST /runs/:botID/stop"]({method:"POST",path:"/runs/finish-1/stop",params:{botID:"finish-1"},query:{},body:{},account:{accountID:1,username:"pilot1"}});assert.equal(response.status,202);for(let i=0;i<100&&!x.reports.some(r=>r.id===1&&r.status==="stopped");i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(x.reports.filter(r=>r.id===1&&r.status==="stopped").length,1);assert.equal(x.attachments(),1);await handle.stop();});
test("finish cannot start a route even if the recovered hauler asks to travel",async()=>{const x=fixture(true);x.deps.recoverHaul=async(_r,session)=>{await session.flow.startRoute(600);throw Error("route unexpectedly started")};await x.run.start(x.actor(3));assert.match((await outcome(x.reports,3)).why,/never starts a route/);const op=x.store(x.opKey).read() as any;assert.equal(op.haulClaims["100"].dispatched,true);assert.equal(op.manifests[0].delivered,false);});
test("competing current owner, overlapping prior owner or wrong dock prevents deposit and operation transition",async()=>{for(const options of [{extraOwner:true},{latePrior:true},{station:601}]){const x=fixture();await x.run.start(x.actor(1,options));assert.equal((await outcome(x.reports,1)).status,"paused");assert.deepEqual(x.deposits,[]);assert.equal((x.store(x.opKey).read() as any).state,"ACTIVE");}});
function pendingIce(x:ReturnType<typeof fixture>,id:number){const c=x.store(`cycle:${id}`).read() as any,claim=(x.store(x.opKey).read() as any).claim,scope=JSON.stringify([c.identity,claim.key,claim.generation,777,30]),issuedAt=1000,effect={effectID:67,targetID:777,startFiletime:'134385165369120001',durationMs:10,repeat:0};c.nextOrdinal=2;c.pending={kind:'mining-cycle',ownerRunID:`old-${id}`,issuedAt,details:{scope,moduleID:55,typeID:483,flagID:27,targetID:777,oreTypeID:30,before:0,cycleMs:20},originalLock:{kind:'target-lock',ownerRunID:`old-${id}`,issuedAt:999,details:{scope,targetID:777}},attempt:{characterID:id,shipID:id===1?11:12,moduleID:55,targetID:777,mission:scope,issuedAt,ordinal:1},receipt:1,activeProof:{moduleID:55,typeID:483,ownerID:id,shipID:id===1?11:12,flagID:27,timeFiletime:'134385165369130001',wallclockFiletime:'134385165369130001',online:true,effects:[effect],activeTargets:[effect],attributes:{73:20}}};x.store(`cycle:${id}`).write(c);return structuredClone(c.pending);}
test('absent terminal roster history after restart does not block exact physical ICE reconciliation',async()=>{const x=fixture(false,true);const original=pendingIce(x,1);await x.run.start(x.actor(1));const r=await outcome(x.reports,1);assert.equal(r.status,'stopped',r.why);const c=x.store('cycle:1').read() as any;assert.equal(c.pending,null);assert.deepEqual(c.lastCycle.originalLock,original.originalLock);assert.equal(c.lastCycle.recovery.oldBotID,'old-1');assert.deepEqual(x.deposits,[1]);});
test("a second restart uses the original site search after the mining cycle has a new owner",()=>{
 const x=fixture(false,true),input={operationID:x.setup.operationID,operationRunID:x.setup.operationRunID};
 const document=x.store("cycle:1"),record=document.read() as {identity:string};
 const identity=JSON.parse(record.identity);
 identity[6]="restored-1";
 document.write({...record,identity:JSON.stringify(identity)});
 const retained=readRetainedFleetTarget(x.setup,x.original.snapshot(),input,false,x.deps);
 assert.deepEqual(retained.site?.target,identity[5]);
 identity[3]=123;
 document.write({...record,identity:JSON.stringify(identity)});
 assert.throws(()=>readRetainedFleetTarget(x.setup,x.original.snapshot(),input,false,x.deps),/site search identity/);
});
test('FINISH restores exact saved auto ICE site and reconciles original positive native cycle before deposit',async()=>{const x=fixture(false,true);const original=pendingIce(x,1);await x.run.start(x.actor(1,{priorTerminal:true}));const r=await outcome(x.reports,1);assert.equal(r.status,'stopped',r.why);const c=x.store('cycle:1').read() as any;assert.equal(c.closed,true);assert.equal(c.pending,null);assert.equal(c.lastCycle.reconciledReadOnly,true);assert.deepEqual(c.lastCycle.originalLock,original.originalLock);assert.equal(c.lastCycle.gain,5);assert.deepEqual(x.deposits,[1]);});
test('auto ICE recovery rejects competing current owner, tampered site, gain, target and incomplete timing without deposit',async()=>{for(const mode of ['owner','site','gain','target','time']){const x=fixture(false,true);pendingIce(x,1);if(mode==='gain')x.holds.delete(1);if(mode==='site'){const key=`mining-fleet-site-search:${JSON.stringify(['op','old',1,11])}`,v=x.store(key).read() as any;v.site.instanceID=90;x.store(key).write(v);}if(mode==='target'||mode==='time'){const c=x.store('cycle:1').read() as any;if(mode==='target')c.pending.activeProof.activeTargets[0].targetID=778;else c.pending.activeProof.activeTargets[0].durationMs=100000;x.store('cycle:1').write(c);}if(mode==='site'){await assert.rejects(async()=>await x.run.start(x.actor(1,{priorTerminal:true})),/site search identity/);continue;}await x.run.start(x.actor(1,{priorTerminal:true,extraOwner:mode==='owner'}));const r=await outcome(x.reports,1);assert.equal(r.status,'paused',mode);assert.ok((x.store('cycle:1').read() as any).pending,mode);assert.deepEqual(x.deposits,[],mode);}});
test('NPC corporation COMMAND can finish owned docked ship with settlement but no deposit authority',async()=>{const x=fixture(false,true,true);await x.run.start(x.actor(4,{corp:999}));const r=await outcome(x.reports,4);assert.equal(r.status,'stopped',r.why);assert.deepEqual(x.deposits,[]);assert.equal(r.readout.groupCompleted,false);});

test("retained personal Upwell finish accepts each exact owned actor independently of corporation",async()=>{const x=fixture(false,false,false,true);for(const id of [1,2,3]){await x.run.start(x.actor(id,{corp:99}));const r=await outcome(x.reports,id);assert.equal(r.status,"stopped",r.why);}assert.deepEqual(x.deposits,[1,2]);assert.equal((x.store(x.opKey).read() as any).state,"STOPPED");});

test('retained docked self-unload members reconcile original trips before independent settlement and release',async()=>{
 const x=fixture();Object.assign(x.setup,{haulMode:'SELF_UNLOAD',members:x.setup.members.filter(m=>m.role==='MINER')});
 x.store('mining-fleet-index:op').write({runID:'old',signature:JSON.stringify(x.setup)});
 const original=x.store(x.opKey).read() as any;x.store(x.opKey).write({...original,haulMode:'SELF_UNLOAD',members:x.setup.members});
 const recovered:number[]=[];x.deps.recoverSelfUnload=async(_run,_session,setup,member,current)=>{current();assert.equal(setup.operationRunID,'old');recovered.push(member.characterID);x.holds.delete(member.characterID);return {rawRemaining:[],observedAt:Date.now()};};
 for(const id of [1,2]){await x.run.start(x.actor(id));const r=await outcome(x.reports,id);assert.equal(r.status,'stopped',r.why);assert.equal(r.readout.groupCompleted,id===2);}
 const stopped=x.store(x.opKey).read() as any;assert.equal(stopped.state,'STOPPED');assert.deepEqual(stopped.parked,[1,2]);assert.equal(stopped.claim,null);assert.deepEqual(recovered,[1,2]);assert.deepEqual(x.deposits,[]);
});
test('an unresolved original self-unload trip retains its owner and cannot mark an empty hold or parked pilot',async()=>{
 const x=fixture();Object.assign(x.setup,{haulMode:'SELF_UNLOAD',members:x.setup.members.filter(m=>m.role==='MINER')});x.store('mining-fleet-index:op').write({runID:'old',signature:JSON.stringify(x.setup)});
 x.store(x.opKey).write({...x.store(x.opKey).read() as any,haulMode:'SELF_UNLOAD',members:x.setup.members});
 x.deps.recoverSelfUnload=async()=>{throw Error('original trip outcome unknown; no replay');};await x.run.start(x.actor(1));const r=await outcome(x.reports,1);assert.equal(r.status,'paused');assert.match(r.why,/original trip/);assert.equal(x.run.ownsOperation('op'),true);assert.deepEqual(x.released,[]);assert.deepEqual((x.store(x.opKey).read() as any).parked,[]);assert.equal((x.store(x.opKey).read() as any).selfUnloadFinal,undefined);
});
test('FINISH preserves the original in-place policy without rejecting exact docked recovery',async()=>{
 const x=fixture();Object.assign(x.setup,{parking:{mode:'STAY_IN_PLACE'}});x.store('mining-fleet-index:op').write({runID:'old',signature:JSON.stringify(x.setup)});x.store(x.opKey).write({...x.store(x.opKey).read() as any,stopMode:'STAY_IN_PLACE'});
 for(const id of [1,2,3]){await x.run.start(x.actor(id));assert.equal((await outcome(x.reports,id)).status,'stopped');}assert.equal((x.store(x.opKey).read() as any).stopMode,'STAY_IN_PLACE');
});
test('retained FINISH follows the exact completed relocation while pinning the original equipment and destination',async()=>{
 const x=fixture(),original=x.store(x.opKey).read() as any,old=original.claim,next={kind:'BELT' as const,systemID:300,name:'Next Belt'},setup={...x.setup,beltID:199,beltName:next.name};
 assert.ok(x.deps.board.drain(old));assert.ok(x.deps.board.releaseDrained(old,{allMembersParked:true,freightSettled:true}));const claim=x.deps.board.reserve('op','old',next)!;assert.ok(x.deps.board.activate(claim));
 x.store(x.opKey).write({...original,claim,relocationHistory:[{oldClaim:old,newClaim:claim,next,completedAt:Date.now(),proofs:x.setup.members.map(m=>({characterID:m.characterID,shipID:m.shipID,source:'native-flight',systemID:300,inSpace:true,docked:false,observedAt:Date.now()}))}]});
 x.store('mining-fleet-relocation:'+JSON.stringify(['op','old'])).write({version:1,operationID:'op',runID:'old',oldClaim:old,next:setup});const decode=x.deps.decodeSetup;x.deps.decodeSetup=v=>JSON.stringify(v)===JSON.stringify(setup)?setup:decode(v);
 for(const id of [1,2]){const cycle=x.store('cycle:'+id).read() as any,identity=JSON.parse(cycle.identity);identity[5]=199;x.store('cycle:'+id).write({...cycle,identity:JSON.stringify(identity)});}
 for(const id of [1,2,3]){await x.run.start(x.actor(id));assert.equal((await outcome(x.reports,id)).status,'stopped');}assert.equal((x.store(x.opKey).read() as any).state,'STOPPED');
});
test('COMMAND own mining freight closes its own cycle before fleet settlement',async()=>{
 const x=fixture(false,true,true);Object.assign(x.setup,{supportPolicy:{maintainBursts:true,useIndustrialCore:false,coreRequirement:'continueWithoutCore',enableCompression:false,selfMining:true,tractor:false,collection:'TRACTOR_ONLY',compressCollectedOre:false,supportLoss:'PAUSE'}});
 x.store('mining-fleet-index:op').write({runID:'old',signature:JSON.stringify(x.setup)});x.store(x.opKey).write({...x.store(x.opKey).read() as any,commandCapabilities:{characterID:4,selfMining:true,tractor:false,collect:false}});
 const cycle=x.store('cycle:1').read() as any,identity=JSON.parse(cycle.identity);identity[2]=4;identity[3]=14;identity[6]='old-4';x.store('cycle:4').write({...cycle,identity:JSON.stringify(identity)});x.holds.add(4);
 for(const id of [1,2,3,4]){await x.run.start(x.actor(id));const r=await outcome(x.reports,id);assert.equal(r.status,'stopped',r.why);}assert.equal((x.store('cycle:4').read() as any).closed,true);assert.ok(x.deposits.includes(4));assert.equal((x.store(x.opKey).read() as any).state,'STOPPED');
});

test("missing historical owner still parks an independent miner while another Jettison remains unknown",async()=>{
 const x=fixture(),original=x.store(x.opKey).read() as any;
 x.store(x.opKey).write({...original,jetcanGeneration:1,jetcanIntents:{"1":{generation:1,dispatched:true,
  category:"RAW",items:[{itemID:71,typeID:30,quantity:10,freightKind:"RAW",unitVolumeM3:1}],capacityM3:100}}});
 x.store("cycle:1").write(null);
 await x.run.start(x.actor(2));
 const released=await outcome(x.reports,2);
 assert.equal(released.status,"stopped",released.why);
 const saved=x.store(x.opKey).read() as any;
 assert.deepEqual(saved.parked,[2]);assert.equal(saved.jetcanIntents["1"].dispatched,true);
 assert.notEqual(saved.state,"STOPPED");
});

test("a docked replacement FINISH reconciles the exact original ore cycle without a historical bot row",async()=>{
 const x=fixture();
 x.deps.rawFacts=async()=>({30:{categoryID:25,freightKind:"RAW",unitVolumeM3:1,resourceFamily:"ore"}});
 const original=pendingIce(x,1);
 await x.run.start(x.actor(1));
 const report=await outcome(x.reports,1),cycle=x.store("cycle:1").read() as any;
 assert.equal(report.status,"stopped",report.why);
 assert.equal(cycle.pending,null);
 assert.deepEqual(cycle.lastCycle.originalLock,original.originalLock);
 assert.equal(cycle.lastCycle.gain,5);
 assert.deepEqual(x.deposits,[1]);
});
test("a retained pilot still in space is not parked by a lost historical receipt",async()=>{
 const x=fixture();
 pendingIce(x,1);
 x.deps.deliveryPark=async()=>{throw Object.assign(Error("The native route to the original delivery dock is unavailable."),{code:"CALL_REFUSED"});};
 await x.run.start(x.actor(1,{inSpace:true}));
 const report=await outcome(x.reports,1);
 assert.equal(report.status,"paused");
 assert.match(report.why,/in space.*native route to the original delivery dock is unavailable/);
 assert.deepEqual((x.store(x.opKey).read() as any).parked,[]);
 assert.deepEqual(x.deposits,[]);
});

test("a member with durable settlement resumes only Parking, bypassing a new raw deposit",async()=>{
 const x=fixture(),saved=x.store(x.opKey).read() as any;
 x.store(x.opKey).write({...saved,state:"SETTLING",settled:[1],settledAt:{"1":Date.now()}});
 const parking:number[]=[];
 x.deps.park=async(run,_session,setup,shipID)=>{
  parking.push(run.characterID);
  return {kind:"dock",proof:{source:"native-flight",shipID,locationID:setup.destinationID,docked:true,observedAt:Date.now()}};
 };
 await x.run.start(x.actor(1));
 const report=await outcome(x.reports,1);
 assert.equal(report.status,"stopped",report.why);
 assert.deepEqual(parking,[1]);
 assert.deepEqual(x.deposits,[]);
 assert.deepEqual((x.store(x.opKey).read() as any).parked,[1]);
});

function flightFixture(x:ReturnType<typeof fixture>,id:number,botID:string,resumed:boolean,station:number|null=null){
 const actor=x.actor(id,{inSpace:station===null});
 actor.botID=botID;actor.resumed=resumed;
 if(resumed)actor.setup=x.setup;
 let flightReads=0,failedReads=0;
 const routes:number[]=[],docks:number[]=[],baseFetch=actor.fetch,attach=x.deps.attach!;
 actor.fetch=async(input:unknown,init:unknown)=>{
  const path=new URL(String(input)).pathname;
  if(path==="/api/bots")return Response.json({ok:true,bots:[{botID,characterID:id,status:"running",endedAt:null}]});
  if(path==="/api/bridge/flight/status"){
   flightReads++;
   if(failedReads>0){failedReads--;return Response.json({ok:false,error:"EVE_GATEWAY_UNREACHABLE",message:"GamePort unavailable"},{status:503});}
   return Response.json({ok:true,flight:{shipID:10+id,solarSystemID:300,docked:station!==null,inSpace:station===null,stationID:station,shipMode:"STOP",transition:{phase:"ready"}}});
  }
  if(path.startsWith("/api/map/station/"))return Response.json({ok:true,station:{stationID:Number(path.split("/").at(-1))}});
  if(path.startsWith("/api/map/resolve/"))return Response.json({ok:true,kind:"station",stationID:Number(path.split("/").at(-1)),solarSystemID:300});
  return baseFetch(input,init);
 };
 x.deps.attach=async r=>{
  const session=await attach(r);
  session.flow.startRoute=async destination=>{routes.push(destination);station=destination;return {started:true};};
  session.flow.flying.abortAutopilot=()=>{};
  session.flow.flying.autopilotProgress=()=>null;
  session.flow.flying.dockStep=async id=>{docks.push(id);throw Error("The existing route already docked.");};
  return session;
 };
 return {actor,routes,docks,station:()=>station,failReads:(n:number)=>{failedReads=n;},flightReads:()=>flightReads};
}
async function waitTerminal(x:ReturnType<typeof fixture>,id:number){
 for(let i=0;i<130&&!x.reports.some(r=>r.id===id&&["stopped","error"].includes(r.status));i++)await new Promise(r=>setTimeout(r,2));
 const result=x.reports.find(r=>r.id===id&&["stopped","error"].includes(r.status));
 assert.ok(result,JSON.stringify(x.reports));return result;
}
test("F7 exclusive authorized FINISH brings a stranded miner to delivery, then its configured home",async()=>{
 const x=fixture();
 (x.setup as any).parking={mode:"RETURN_HOME_DOCK",kind:"station",destinationID:601,systemID:300};
 x.store("mining-fleet-index:op").write({runID:"old",signature:JSON.stringify(x.setup)});
 const f=flightFixture(x,1,"finish-1",false);
 const handle=await x.run.start(f.actor);
 const result=await waitTerminal(x,1);
 assert.equal(result.status,"stopped");assert.equal(f.station(),601);
 assert.deepEqual(f.routes,[600,601]);assert.deepEqual(f.docks,[]);
 assert.deepEqual(x.deposits,[1]);assert.deepEqual(x.released,[1]);
 assert.deepEqual((x.store(x.opKey).read() as any).parked,[1]);
 await handle.stop();
});
test("F11 held runner restart resumes persisted Stop, survives a GamePort outage and parks without productive work",async()=>{
 const x=fixture();
 x.store(x.opKey).write({...x.store(x.opKey).read() as any,stopRequested:true});
 x.holds.clear();
 x.deps.retryDelay=1;
 const f=flightFixture(x,1,"old-1",true);f.failReads(1);
 const handle=await x.run.resumeHeld(f.actor,{operationID:"op",operationRunID:"old"});
 const result=await waitTerminal(x,1);
 assert.equal(result.status,"stopped");assert.equal(f.station(),600);
 assert.ok(x.reports.some(r=>r.phase==="Retrying retained Parking"));
 assert.deepEqual(f.routes,[600]);assert.deepEqual(x.deposits,[]);assert.deepEqual(x.released,[1]);
 assert.equal((x.store("cycle:1").read() as any).closed,true);
 assert.ok((x.store(x.opKey).read() as any).stopRequested);
 await handle.stop();
});
test("F8 restarted held owner confirms the already docked pilot without a route or another unload",async()=>{
 const x=fixture(),row=x.store(x.opKey).read() as any;
 x.store(x.opKey).write({...row,state:"SETTLING",stopRequested:true,settled:[1],settledAt:{"1":Date.now()},parked:[1]});
 const f=flightFixture(x,1,"old-1",true,600);
 const handle=await x.run.resumeHeld(f.actor,{operationID:"op",operationRunID:"old"});
 assert.equal((await waitTerminal(x,1)).status,"stopped");
 assert.deepEqual(f.routes,[]);assert.deepEqual(x.deposits,[]);assert.deepEqual(x.released,[1]);
 await handle.stop();
});

test("F10 a new FINISH owner with uncertain cargo docks and releases while the exact Jettison stays unresolved",async()=>{
 const x=fixture(),claim=x.original.snapshot().claim!,item={itemID:20,typeID:30,quantity:10,freightKind:"RAW" as const,unitVolumeM3:1};
 const intent=x.original.prepareJetcan(1,[item],100,{30:{categoryID:25,freightKind:"RAW",unitVolumeM3:1}},
  {source:"checked-ship-holds",characterID:1,shipID:11,systemID:300,targetKey:claim.key,claimGeneration:claim.generation,observedAt:Date.now(),
   items:[{...item,ownerID:1,locationID:11,flagID:134}]});
 assert.ok(intent);assert.ok(x.original.dispatchJetcan(1,intent.generation));
 const f=flightFixture(x,1,"finish-1",false);
 const handle=await x.run.start(f.actor);
 const result=await waitTerminal(x,1),retained=x.store(x.opKey).read() as any;
 assert.equal(result.status,"error");assert.match(result.why,/docked at 600.*Original Jettison was dispatched/);
 assert.deepEqual(f.routes,[600]);assert.deepEqual(x.released,[1]);assert.deepEqual(x.deposits,[]);
 assert.equal(retained.jetcanIntents["1"].dispatched,true);assert.deepEqual(retained.parked,[]);assert.notEqual(retained.state,"STOPPED");
 await handle.stop();
});

test("November 11 retained FINISH uses the held hauler and settles seven members from fresh native observations",async t=>{
 const roles=["HAULER","MINER","MINER","MINER","MINER","DEFENDER","DEFENDER"] as const;
 const members=roles.map((role,index)=>({characterID:index+1,shipID:index+11,role}));
 const x=fixture(false,false,false,false,members);
 x.holds.delete(1);
 x.deps.settle=undefined;
 x.deps.quiescence=undefined;
 x.deps.retryDelay=1000;
 const launch={version:1,operationID:"op",operationRunID:"old",members:members.map(m=>({
  ...m,accountName:"pilot-"+m.characterID,kind:"mcc-"+m.role.toLowerCase(),status:"ACCEPTED",botID:"original-"+m.characterID,beforeIDs:[],
 }))};
 x.store('mining-fleet-finish-authority:'+JSON.stringify(['op','old'])).write(launch);
 const oldDroneReport={members:[6,7].map(characterID=>({characterID,reason:"A drone command remains in flight; custody is retained."}))};
 x.store("original-telemetry").write(oldDroneReport);
 const hauler=flightFixture(x,1,"finish-1",false);
 const dict=(entries:unknown[])=>({type:"dict",entries}),kv=(entries:unknown[])=>({type:"object",name:"util.KeyVal",args:dict(entries)});
 const long={type:"long",value:"134385165369180001"};
 const module={itemID:55,typeID:483,ownerID:1,locationID:11,flagID:27,categoryID:7,groupID:54,quantity:1,singleton:1};
 const info=(shipID:number)=>dict([[shipID,kv([["itemID",shipID],["attributes",dict([[14,1],[1271,0]])]])]]);
 let active=true,shutdowns=0;
 const attach=x.deps.attach!;
 x.deps.attach=async run=>{
  const session=await attach(run);
  Object.assign(session.flow.flying,{
   async bridgeAsk(){
    assert.equal(run.held.characterID,1);
    return kv([["itemID",55],["invItem",{type:"packedrow",fields:module}],["time",long],["wallclockTime",long],
     ["activeEffects",dict(active?[[67,[55,1,11,null,null,[],67,long,1000,1]]]:[])]]);
   },
   async switchModuleOff(id:number){assert.equal(id,55);shutdowns++;throw Error("lost native Deactivate reply");},
  });
  return session;
 };
 const observed=(actor:any,id:number)=>{const fetch=actor.fetch,shipID=10+id;
  actor.fetch=async(input:unknown,init:unknown)=>{
   const path=new URL(String(input)).pathname;
   if(path==="/api/bridge/fitting")return Response.json({ok:true,activeShipID:shipID,shipInfo:info(shipID),
    slots:{type:"list",items:id===1?[{type:"packedrow",fields:module}]:[]},
    online:{type:"list",items:id===1?[55]:[]},errors:{slots:null,shipInfo:null,online:null,chargeFits:null}});
   if(path==="/api/bridge/drones"||path==="/api/bridge/script/observation")return Response.json({ok:true,activeShipID:shipID,
    bay:[],inSpace:[],shipInfo:info(shipID),errors:{bay:null,shipInfo:null,inSpace:null},
    space:{inSpace:true,shipID,solarSystemID:300,ship:null,entities:[],stateValid:false}});
   return fetch(input,init);
  };
  return actor;
 };
 const handle=await x.run.start(observed(hauler.actor,1));
 t.after(()=>handle.stop());
 const blocked=await outcome(x.reports,1);
 assert.match(blocked.why,/Module 55, effects 67.*lost native Deactivate reply/);
 assert.deepEqual(hauler.routes,[]);
 assert.equal((x.store(x.opKey).read() as any).stopRequested,true);
 // The other six are physically inspected while the hauler's exact owner remains held.
 for(const id of [2,3,4,5,6,7]){
  const member=await x.run.start(observed(x.actor(id),id));t.after(()=>member.stop());
  assert.equal((await waitTerminal(x,id)).status,"stopped");
 }
 assert.deepEqual((x.store(x.opKey).read() as any).parked,[2,3,4,5,6,7]);
 assert.deepEqual(x.store("original-telemetry").read(),oldDroneReport);
 assert.equal(x.run.ownsOperation("op"),true);
 // Fresh native inactivity settles the lost reply without another Deactivate or login.
 active=false;
 x.stops.get("finish-1")!();
 const recovered=await waitTerminal(x,1);
 assert.equal(recovered.status,"stopped");
 assert.equal(recovered.readout.groupCompleted,true);
 assert.equal(shutdowns,1);
 assert.deepEqual(hauler.routes,[600]);
 assert.equal(hauler.station(),600);
 assert.equal((x.store(x.opKey).read() as any).state,"STOPPED");
 assert.deepEqual(x.released,[2,3,4,5,6,7,1]);
});
