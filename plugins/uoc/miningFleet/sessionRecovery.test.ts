import {memoryFleetDocuments} from "./operationStoreFixture.ts";
import {fleetOperationStore} from "./operationStore.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {createMiningFleetRuntime,type FleetSetup} from "./runtime.ts";
import {createOperation} from "./operation.ts";
import {createTargetBoard} from "./targetBoard.ts";
import {createFleetLaunchJournal} from "../operations/miningLaunchJournal.ts";
import type {PluginRunContext,PluginRunHandle} from "../../../web/src/plugin-api/backend.ts";

const storage=memoryFleetDocuments(),document=storage.document;
const base:FleetSetup={
 operationID:"native-reconnect",operationRunID:"epoch",systemID:300,destinationID:600,corporationID:77,division:1,
 beltID:99,beltName:"Recovery Belt",canCapacityM3:100,members:[
  {characterID:1,shipID:11,role:"MINER"},{characterID:2,shipID:12,role:"MINER"},{characterID:3,shipID:13,role:"HAULER"},
 ],
};
const board=createTargetBoard(document("mining-fleet-targets"),()=>Date.now()-60000);
function seed(setup:FleetSetup){
 const op=createOperation(fleetOperationStore(storage,setup.operationID,setup.operationRunID),board,
  {operationID:setup.operationID,runID:setup.operationRunID,systemID:setup.systemID,destinationID:setup.destinationID,members:setup.members});
 assert.ok(op.reserve(1,{kind:"BELT",systemID:300,name:setup.beltName!}));
 assert.ok(op.activate(1));return op;
}
const original=seed(base), originalClaim=original.snapshot().claim!;
const mine=new Map<number,number>(),docked=new Set<number>(),reports:{characterID:number;status:string;phase?:string|null;why?:string|null}[]=[];
const inventoryCalls:string[]=[];
const defenderFitReads:number[]=[];
const nativeMembers=new Set([1,2,3]);
const invites=new Map<number,{fleetID:number;inviterID:number;receivedAtMs:number}>();
const fleetWrites:string[]=[];
const writes:string[]=[];
const launchJournal=(id:string,runID:string)=>createFleetLaunchJournal(document(`mining-launch:${JSON.stringify(["world",id,runID])}`));
const runtime=createMiningFleetRuntime({
 storage,
 launchJournal,
 attach:async run=>({
  store:{
   station:{get:()=>({online:{characterID:run.held.characterID,corporationID:77}})},
   fleet:{get:()=>({pendingInvite:invites.get(run.held.characterID)??null})},
   fitting:{get:()=>({activeShipID:run.held.characterID+10,slotsError:null,slots:[],
    stats:{targeting:{maxTargetRange:{known:true,value:20000}},bays:{droneCapacity:{known:true,value:0}}}})},
  },
  flow:{requestOptions:()=>({}),setLivePush(){},flying:{
   sessionGeneration:()=>1,isSessionClosing:()=>false,
   readFit:async()=>{defenderFitReads.push(run.held.characterID);return true;},
   resolveDefenseModuleIDs:()=>({weapons:[],shield:[],armor:[],hull:[],hardeners:[]}),
   resolveRemoteRepModuleIDs:()=>({shield:[],armor:[],hull:[],cap:[]}),
   bridgeDo:async(service:string,method:string,args:unknown[])=>{
    if(service==="ship"&&method==="Jettison")writes.push(method);
    if(service==="invCache")inventoryCalls.push(method);
    if(service==="fleetObjectHandler"&&method==="Invite"){
     const invited=Number(args[0]);fleetWrites.push("invite "+invited);
     invites.set(invited,{fleetID:900,inviterID:run.held.characterID,receivedAtMs:Date.now()});
    }
    if(service==="fleetObjectHandler"&&method==="AcceptInvite"){
     fleetWrites.push("accept "+run.held.characterID);nativeMembers.add(run.held.characterID);invites.delete(run.held.characterID);
    }
   },
   bridgeAsk:async(service:string,method:string)=>{if(service==="invbroker")inventoryCalls.push(method);return {type:"list",items:[]};},
  }},
 }) as any,
 createCycle:async run=>({tick:async()=>{mine.set(run.characterID,(mine.get(run.characterID)??0)+1);return "blocked" as const;},stop:async()=>{}}),
 settle:async()=>({modulesInactive:true,dronesSafe:true,observedAt:Date.now()}),
 park:async run=>{
  const roster=await (await run.fetch(new URL("/api/pilot-training/characters",run.baseUrl))).json();
  docked.add(roster.characters[0].characterID);
  return {destinationID:600,systemID:300,kind:"station"};
 },
});
function authorizeSetup(setup:FleetSetup){
 const check=runtime.runs.MINER.check(setup);
 assert.ok("ok" in check&&check.ok);
 document(`mining-fleet-index:${setup.operationID}`).write({runID:setup.operationRunID,signature:JSON.stringify(check.setup)});
 const journal=launchJournal(setup.operationID,setup.operationRunID);
 journal.begin({operationID:setup.operationID,operationRunID:setup.operationRunID,revision:1,planHash:"plan",setupHash:"setup",
  members:setup.members.map(({characterID,role})=>({characterID,role,accountName:`test${characterID}`,
   kind:`mcc-${role.toLowerCase()}` as "mcc-miner"|"mcc-hauler"|"mcc-command"|"mcc-defender",beforeIDs:[]}))});
 for(const {characterID} of setup.members){journal.dispatch(characterID);journal.accept(characterID,`bot-${characterID}`);}
 return journal;
}
function actor(setup:FleetSetup,id:number,resumed:boolean,botID=`bot-${id}`,expiresAt=new Date(Date.now()+600000).toISOString()):PluginRunContext{
 const member=setup.members.find(m=>m.characterID===id)!;
 const kv=(entries:unknown[])=>({type:"object",name:"util.KeyVal",args:{type:"dict",entries}});

 return {
  botID,characterID:id,setup:setup as any,held:{characterID:id} as any,baseUrl:"http://fixture",
  resumed,resumeData:null,routeSettings:null,report:r=>reports.push({characterID:id,...r}),
  fetch:async input=>{
   const path=new URL(String(input)).pathname;
   if(path==="/api/pilot-training/characters")return Response.json({ok:true,account:`test${id}`,characters:[{characterID:id}]});
   if(path==="/api/bots")return Response.json({ok:true,bots:[{botID,characterID:id,expiresAt,status:"starting",endedAt:null}]});
   if(path==="/api/bridge/bound-fleet"){
    if(!nativeMembers.has(id))return Response.json({ok:true,fleetID:null,membership:"none"});
    const fleet=kv([["fleetID",900],["members",{type:"dict",entries:[...nativeMembers].map(cid=>[cid,kv([["charID",cid],["job",cid===1?2:0]])])}]]);
    return Response.json({ok:true,fleetID:900,reads:{GetInitState:{result:fleet}}});
   }
   if(path==="/api/bridge/flight/status")return Response.json({ok:true,flight:{
    shipID:member.shipID,shipIsCapsule:false,solarSystemID:300,docked:docked.has(id),inSpace:!docked.has(id),stationID:docked.has(id)?600:null,shipMode:"STOP",
    transition:{phase:"ready",sessionStable:true,locationReady:true,sceneReady:true,egoReady:true,shipReady:true,boundContextReady:true},
   }});
   if(path==="/api/bridge/space/snapshot")return Response.json({ok:true,space:{
    inSpace:true,solarSystemID:300,shipID:member.shipID,sampledAtMs:Date.now(),
    ship:{itemID:member.shipID,characterID:id,mode:"STOP",radius:10,position:{x:0,y:0,z:0}},
    entities:[{itemID:99,kind:"celestial",groupID:9,name:setup.beltName,radius:10,position:{x:100,y:0,z:0}}],
   }});
   if(path==="/api/mining-operations/resources")return Response.json({ok:true,resources:[{typeID:30,family:"ore",name:"ore"}]});
   throw Error("Unexpected fake native request "+path);
  },
 };
}
async function until(predicate:()=>boolean){
 for(let i=0;i<150&&!predicate();i++)await new Promise(r=>setTimeout(r,100));
 assert.ok(predicate(),JSON.stringify(reports.slice(-8)));
}
test("saved ACTIVE fleet resumes, a reconnected miner produces again, and reconnect during Stop parks it",async()=>{
 authorizeSetup(base);
 const handles=new Map<number,PluginRunHandle>();
 try{
  for(const member of base.members)handles.set(member.characterID,await runtime.runs[member.role].start(actor(base,member.characterID,true)));
  const group=runtime.getOrCreate(base);
  await until(()=>[1,2].every(id=>(mine.get(id)??0)>0));
  assert.equal(group.op.snapshot().claim?.generation,originalClaim.generation);
  assert.ok((group.op.snapshot().claim?.expiresAt??0)>Date.now());
  assert.deepEqual(inventoryCalls,[]);
  await (handles.get(2)!.stop as (reason?: "reconnect")=>void|Promise<void>)("reconnect");
  nativeMembers.delete(2);
  const before=mine.get(2)!;
  assert.equal(group.op.snapshot().stopRequested,undefined);
  handles.set(2,await runtime.runs.MINER.start(actor(base,2,true)));
  await until(()=>(mine.get(2)??0)>before);
  assert.deepEqual(fleetWrites,["invite 2","accept 2"]);

  await (handles.get(2)!.stop as (reason?: "reconnect")=>void|Promise<void>)("reconnect");
  group.requestStop();
  assert.equal(group.op.snapshot().stopRequested,true);
  const stoppedAt=mine.get(2);
  handles.set(2,await runtime.runs.MINER.start(actor(base,2,true)));
  await until(()=>group.op.snapshot().state==="STOPPED"&&reports.filter(r=>r.status==="stopped").length===3);
  assert.deepEqual([...docked].sort(),[1,2,3]);
  assert.equal(mine.get(2),stoppedAt);
  assert.deepEqual(writes,[]);
 }finally{for(const h of handles.values())await h.stop();}
});

test("reattachment retains an uncertain Jettison and never dispatches it again",async()=>{
 const setup={...base,operationID:"reconnect-jettison",beltName:"Uncertain Can Belt"};
 docked.clear();mine.clear();nativeMembers.clear();for(const m of setup.members)nativeMembers.add(m.characterID);
 reports.length=0;
 authorizeSetup(setup);
 const group=runtime.getOrCreate(setup),claim=group.op.reserve(1,{kind:"BELT",systemID:300,name:setup.beltName})!;
 assert.ok(claim&&group.op.activate(1));
 const item={itemID:20,typeID:30,quantity:10,freightKind:"RAW" as const,unitVolumeM3:1};
 const intent=group.op.prepareJetcan(1,[item],100,{30:{categoryID:25,freightKind:"RAW",unitVolumeM3:1}},
  {source:"checked-ship-holds",characterID:1,shipID:11,systemID:300,targetKey:claim.key,claimGeneration:claim.generation,observedAt:Date.now(),
   items:[{...item,ownerID:1,locationID:11,flagID:134}]});
 assert.ok(intent&&group.op.dispatchJetcan(1,intent.generation));
 const handles:PluginRunHandle[]=[];
 try{
  for(const member of setup.members)handles.push(await runtime.runs[member.role].start(actor(setup,member.characterID,true)));
  await until(()=>reports.some(r=>r.characterID===1&&/no replay/i.test(r.why??""))&&(mine.get(2)??0)>0);
  assert.equal(group.op.snapshot().jetcanIntents["1"]?.dispatched,true);
  assert.equal(mine.get(1),undefined);
  assert.deepEqual(writes,[]);
 }finally{for(const h of handles)await h.stop();group.retireGroup();}
});

test("after WC restart fourteen new hosted IDs take over and only Defenders prepare combat fittings",async()=>{
 const roles=[...Array(8).fill("MINER"),...Array(4).fill("DEFENDER"),"HAULER","HAULER"] as FleetSetup["members"][number]["role"][];
 const members=roles.map((role,index)=>({characterID:index+1,shipID:index+11,role}));
 const setup={...base,operationID:"reconnect-fourteen",beltName:"Parallel Recovery Belt",members};
 docked.clear();
 const journal=authorizeSetup(setup);
 const oldGroup=runtime.getOrCreate(setup);
 const claim=oldGroup.op.reserve(1,{kind:"BELT",systemID:setup.systemID,name:setup.beltName});
 assert.ok(claim&&oldGroup.op.activate(1));
 const item={itemID:20,typeID:30,quantity:10,freightKind:"RAW" as const,unitVolumeM3:1};
 for(const containerID of [99_001,99_002]){
  assert.ok(oldGroup.op.registerGridJetcan(14,claim,{containerID,ownerID:1,
   observedAt:Date.now(),items:[{...item,itemID:containerID+100}],capacityM3:100}));
 }
 const issued=oldGroup.op.claimContainer(14,99_001)!;
 assert.ok(oldGroup.op.dispatchHaul(14,99_001,issued.generation));
 assert.ok(oldGroup.op.claimContainer(14,99_002,"haul",undefined,true));
 assert.ok(oldGroup.retireGroup());
 const attached:PluginRunHandle[]=[];
 const calls:string[]=[];
 const expiresAt=new Date(Date.now()+480000).toISOString();
 inventoryCalls.length=0;
 defenderFitReads.length=0;
 try{
  await Promise.all(members.map(async member=>{
   const run=actor(setup,member.characterID,true,`restored-${member.characterID}`,expiresAt);
   const fetch=run.fetch;
   const tracked={...run,fetch:async (input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    calls.push(new URL(String(input)).pathname);
    return fetch(input,init);
   }};
   attached.push(await runtime.runs[member.role].start(tracked));
  }));
  const group=runtime.getOrCreate(setup);
  const restoredIDs=members.map(m=>`restored-${m.characterID}`);
  assert.deepEqual(runtime.memberSnapshot(setup.operationID,setup.operationRunID)?.filter(p=>p.active).map(p=>p.botID).sort(),[...restoredIDs].sort());
  assert.deepEqual(journal.read()?.members.map(m=>m.botID),restoredIDs);
  assert.equal(group.op.snapshot().runID,setup.operationRunID);
  assert.equal(group.op.snapshot().claim?.generation,claim.generation);
  assert.deepEqual([...group.entries.values()].map(e=>e.expiry),Array(14).fill(Date.parse(expiresAt)));
  assert.deepEqual(group.op.snapshot().haulClaims,{"99001":{...issued,dispatched:true}});
  assert.equal(group.op.snapshot().manifests.length,2);
  assert.equal(calls.filter(path=>path==="/api/bridge/flight/status").length,14);
  assert.equal(calls.filter(path=>path==="/api/pilot-training/characters").length,14);
  assert.equal(calls.filter(path=>path==="/api/bots").length,14);
  assert.deepEqual(inventoryCalls,[]);
  assert.deepEqual(defenderFitReads.slice().sort((a,b)=>a-b),[9,10,11,12]);
  for(const botID of ["restored-1","competing-1"])
   await assert.rejects(async()=>runtime.runs.MINER.start(actor(setup,1,true,botID)),/already active/);
 }finally{
  for(const handle of attached)await handle.stop();
  runtime.getOrCreate(setup,true).retireGroup();
 }
});

test("resume needs the original launch, exclusive owner and ship and keeps the normal deadline Stop",async t=>{
 const setup={...base,operationID:"reconnect-grant",beltName:"Grant Belt"};
 const journal=authorizeSetup(setup);
 const previous=runtime.getOrCreate(setup);
 assert.ok(previous.op.reserve(1,{kind:"BELT",systemID:setup.systemID,name:setup.beltName}));
 assert.ok(previous.op.activate(1));
 assert.ok(previous.retireGroup());

 const otherSetup={...setup,destinationID:601};
 await assert.rejects(async()=>runtime.runs.MINER.start(actor(otherSetup,1,true,"different-setup")),/launch has ended or changed/);
 const badRun=actor(setup,1,true,"expired",new Date(Date.now()-1).toISOString());
 await assert.rejects(async()=>runtime.runs.MINER.start(badRun),/expiry could not be verified/);
 for(const [path,patch,reason] of [
  ["/api/bots",(body:any)=>body.bots.push({...body.bots[0],botID:"bot-1",status:"running"}),/exclusive hosted pilot lease/],
  ["/api/pilot-training/characters",(body:any)=>{body.account="unrelated";},/differs from the accepted fleet member/],
  ["/api/bridge/flight/status",(body:any)=>{body.flight.shipID=111;},/original ship or its current location/],
 ] as const){
  const run=actor(setup,1,true,"unverified-owner");
  const fetcher:typeof fetch=async input=>{
   const response=await run.fetch(input);
   if(new URL(String(input)).pathname!==path)return response;
   const body=await response.json();patch(body);return Response.json(body);
  };
  await assert.rejects(async()=>runtime.runs.MINER.start({...run,fetch:fetcher}),reason);
  assert.equal(journal.read()?.members[0]?.botID,"bot-1");
 }

 const group=runtime.getOrCreate(setup,true);
 assert.ok(group.retireGroup());
 t.mock.timers.enable({apis:["Date","setInterval"],now:Date.now()});
 const originalExpiry=Date.now()+181_000;
 const run=actor(setup,1,true,"verified-owner",new Date(originalExpiry).toISOString());
 const handle=await runtime.runs.MINER.start(run);
 try{
  const restored=runtime.getOrCreate(setup);
  assert.equal(restored.entries.get(1)?.expiry,originalExpiry);
  assert.equal(restored.op.snapshot().stopRequested,undefined);
  t.mock.timers.tick(1_500);
  assert.equal(restored.op.snapshot().stopRequested,true);
  assert.equal(restored.op.snapshot().stopFreight,"RETURN_HOME");
  assert.equal(restored.entries.get(1)?.expiry,originalExpiry);
 }finally{
  await handle.stop();
  await new Promise<void>(resolve=>setImmediate(resolve));
  runtime.getOrCreate(setup,true).retireGroup();
 }
});
