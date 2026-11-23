import {memoryFleetDocuments} from "./operationStoreFixture.ts";
import {officeList,corporationRow} from "./corporateOfficeFixture.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import type {PluginRunContext} from "../../../web/src/plugin-api/backend.ts";
import type {PilotSession} from "../../../web/src/plugin-api/pilotSession.ts";
import {createRawMembers,type RawHaulerNative} from "./memberLoops.ts";
import type {Manifest} from "./operation.ts";
import type {Claim} from "./targetBoard.ts";
import {createMiningFleetRuntime,type FleetSetup} from "./runtime.ts";

const {createLootMemory}=createRequire(import.meta.url)("../../../src/lootMemory.js");

const storage=memoryFleetDocuments(),document=storage.document;
const scenarios=[
 {kind:"stop",title:"hosted hauling returns without the producers, preserves Collect on restart, and forgets only verified absent freight"},
 {kind:"relocate",title:"Miners relocate to Belt B while the Hauler batches and delivers the old tail before picking up at Belt B"},
 {kind:"no-replacement",title:"depletion reports that no replacement belt exists without dispatching travel"},
 {kind:"stop-during-relocation",title:"Stop cancels the pending automatic belt relocation before departure"},
] as const;
for(const scenario of scenarios)test(scenario.title,async t=>{
 t.mock.timers.enable({apis:scenario.kind==="stop"?["setInterval"]:["setInterval","setTimeout"]});
 const miningSystem=30003484+scenarios.indexOf(scenario)*10,deliverySystem=30003486,beltID=99,stationID=60006292,officeID=700;
 const characterID=3,shipID=13,corporationID=77,botID="haul-run-"+scenario.kind,oreType=30;
 const target={kind:"BELT" as const,systemID:miningSystem,name:"Original belt"};
 const nextBeltID=199,nextBeltName="Replacement belt";
 const relocating=scenario.kind!=="stop";
 const hauler={characterID,shipID,role:"HAULER" as const};
 const setup:FleetSetup={
  operationID:"hauling-trips-"+scenario.kind,operationRunID:"original-run",systemID:miningSystem,
  beltID,beltName:target.name,destinationID:stationID,corporationID,division:1,canCapacityM3:100,
  delivery:{kind:"station",destinationID:stationID,systemID:deliverySystem,corporationID,division:1},
  members:[{characterID:1,shipID:11,role:"MINER"},{characterID:2,shipID:12,role:"MINER"},hauler,...(relocating?[{characterID:4,shipID:14,role:"DEFENDER" as const}]:[])],
 };
 const transition={phase:"ready",sessionStable:true,locationReady:true,sceneReady:true,egoReady:true,shipReady:true,boundContextReady:true};
 let systemID=miningSystem,docked=false,atBelt=true,haulerBeltID=beltID,sample=0,gridReadFails=false;
 const point=(x:number)=>({x,y:0,z:0});
 const rows=[scenario.kind==="relocate"?90:10,10,10,10].map((quantity,i)=>({itemID:20+i,typeID:oreType,quantity,ownerID:i>=2?2:1,locationID:100+i,flagID:0}));
 const cans=new Map(rows.map(row=>[row.locationID,row]));
 const sourceBelt=(containerID:number)=>containerID===104?nextBeltID:beltID;
 let held:typeof rows=[];
 const destination:typeof rows=[];
 const events:string[]=[],readout:string[]=[];
 let releaseOldPickup!:()=>void;
 const oldPickupGate=new Promise<void>(resolve=>{releaseOldPickup=resolve;});
 t.after(releaseOldPickup);
 const locations=new Map([[1,beltID],[2,beltID],[4,beltID]]),emptySamples=new Map<number,number>();
 let originalDepleted=false;
 const droneInSpace=new Set([1]);
 const beltRows=[{kind:"celestial",itemID:beltID,groupID:9,name:target.name,position:point(0),radius:100},
  ...(scenario.kind==="no-replacement"?[]:[{kind:"celestial",itemID:nextBeltID,groupID:9,name:nextBeltName,position:point(500000),radius:100}])];
 const kv=(entries:unknown[])=>({type:"object",name:"util.KeyVal",args:{type:"dict",entries}});
 const fleet=kv([["fleetID",900],["members",{type:"dict",entries:setup.members.map(m=>[m.characterID,kv([["charID",m.characterID]])])}]]);
 const boundFleet={fleetID:900,reads:{GetInitState:{result:fleet}}};
 const localScene=(id:number,ship:number)=>{
  const site=locations.get(id),x=site===nextBeltID?500000:0,own={itemID:ship,characterID:id,mode:"STOP",position:point(x),radius:10};
  return {stateValid:true,inSpace:true,solarSystemID:miningSystem,shipID:ship,sampledAtMs:++sample,ship:own,
   entities:[own,...beltRows,...(site===nextBeltID||!originalDepleted?[{itemID:site===nextBeltID?778:777,categoryID:25,beltID:site,position:point(x+100),radius:10}]:[])]};
 };
 const pump=async(until:()=>boolean)=>{
  for(let i=0;i<30&&!until();i++){
   t.mock.timers.tick(1500);
   await new Promise<void>(resolve=>setImmediate(resolve));
  }
  assert.ok(until(),readout.filter(r=>!r.includes("on watch")).slice(-18).join("\n")+"\n"+events.slice(-16).join(" "));
 };
 async function advance<T>(work:Promise<T>){
  let settled=false;
  void work.then(()=>{settled=true;},()=>{settled=true;});
  await pump(()=>settled);
  return work;
 }
 const loot=createLootMemory();
 const list=(inventory:typeof rows)=>({type:"list",items:structuredClone(inventory).map(fields=>({type:"packedrow",fields}))});
 const status=()=>({inSpace:!docked,docked,solarSystemID:systemID,stationID:docked?stationID:null,shipID,shipMode:"STOP",transition});
 const session={
  store:{station:{get:()=>({online:{characterID,corporationID}})}},
  flow:{
   requestOptions:()=>({}),setLivePush(){},
   async startRoute(id:number){
    events.push(`route:${id}`);atBelt=false;
    if(id===miningSystem)systemID=miningSystem;
    else{assert.equal(id,stationID);systemID=deliverySystem;docked=true;}
    return {started:true};
   },
   flying:{
    sessionGeneration:()=>1,isSessionClosing:()=>false,readFlightNow:async()=>status(),
    autopilotProgress:()=>({status:"arrived"}),abortAutopilot(){},
    async warpAsTheAutopilot(id:number){
     assert.ok(beltRows.some(row=>row.itemID===id));assert.equal(systemID,miningSystem);assert.equal(docked,false);
     events.push("warp:"+id);atBelt=true;haulerBeltID=id;
    },
    async bridgeAsk(service:string,method:string,_args:unknown,kwargs:{flag?:number}|null,of:number){
     if(service==="corpRegistry")return corporationRow(method,characterID,corporationID);
     if(service==="officeManager")return {list:[{fields:{stationID,officeID}}]};
     assert.equal(service,"invbroker");
     if(method==="ListByFlags"&&of===shipID){
      assert.deepEqual(_args,[[5,134,135,181,182]]);return list(held);
     }
     assert.equal(method,"List");
     if(of===shipID)return list(held.filter(row=>row.flagID===kwargs?.flag));
     if(of===officeID){assert.equal(docked,true);return list(destination);}
     assert.ok(atBelt&&systemID===miningSystem&&!docked&&haulerBeltID===sourceBelt(of));
     events.push(`read:${of}`);
     const row=cans.get(of);return list(row?[row]:[]);
    },
    async bridgeDo(service:string,method:string,args:number[],kwargs:{qty?:number;flag?:number},of:number){
     if(service==="invCache")return;
     if(service==="ship"&&method==="Undock"){assert.equal(docked,true);docked=false;return;}
     assert.equal(service,"invbroker");assert.equal(method,"Add");
     const [itemID,sourceID]=args;
     if(of===shipID){
      assert.ok(atBelt&&systemID===miningSystem&&!docked&&haulerBeltID===sourceBelt(sourceID!));
       assert.ok(loot.claimedItemIDs(miningSystem,"other-session","other-run").includes(sourceID!));
      const row=cans.get(sourceID!);assert.ok(row);assert.equal(itemID,row.itemID);assert.equal(kwargs.qty,row.quantity);
      if(scenario.kind==="relocate"&&sourceID===101){
       events.push("old-pickup-in-flight");
       await oldPickupGate;
      }
      events.push(`pickup:${sourceID}`);cans.delete(sourceID!);
      held.push({...row,ownerID:characterID,locationID:shipID,flagID:5});
     }else{
      assert.equal(of,officeID);assert.equal(sourceID,shipID);assert.equal(kwargs.flag,115);
      const row=held.find(r=>r.itemID===itemID);
      assert.ok(docked&&systemID===deliverySystem&&row);assert.equal(kwargs.qty,row.quantity);
      events.push("deposit:"+itemID);
      destination.push({...row,ownerID:corporationID,locationID:officeID,flagID:115});held=held.filter(r=>r!==row);
     }
    },
   },
  },
 } as unknown as PilotSession;
 const fetcher:typeof fetch=async(input,init)=>{
  const path=new URL(String(input)).pathname;
  let body:object;
  switch(path){
   case "/api/pilot-training/characters":body={account:"test-hauler",characters:[{characterID}]};break;
   case "/api/bridge/bound-fleet":body=boundFleet;break;
   case "/api/bots":body={bots:[{botID,characterID,expiresAt:new Date(Date.now()+600000).toISOString()}]};break;
   case "/api/bridge/flight/status":body={flight:status()};break;
   case "/api/bridge/space/snapshot":
    if(gridReadFails)return Response.json({ok:false,error:"CALL_TIMEOUT"},{status:504});
    body={space:{inSpace:!docked,solarSystemID:systemID,shipID,sampledAtMs:++sample,
     ship:{itemID:shipID,characterID,mode:"STOP",position:point(0),radius:10},
     entities:[...beltRows.map(row=>({...row,position:point(atBelt&&haulerBeltID===row.itemID?0:500000)})),
      ...(atBelt?[...cans.values()].filter(row=>sourceBelt(row.locationID)===haulerBeltID).map(row=>({kind:"container",
       itemID:row.locationID,ownerID:row.ownerID,position:point(100),radius:10})):[])]}};
    break;
   case "/api/bots/loot-memory/claim":{
    const {system,itemID,renewOnly}=JSON.parse(String(init?.body));
     events.push(`claim:${itemID}`);
    if(system!==systemID)return Response.json({ok:false,error:"CLAIM_SCOPE_UNKNOWN"},{status:409});
    assert.equal(atBelt,true);
     const claimed=loot.claimContainer("hauler-session",botID,system,itemID,renewOnly);
     if(claimed)events.push(`claimed:${itemID}`);
     body={claimed};break;
   }
   case "/api/bots/loot-memory/release":loot.releaseClaims("hauler-session",botID);body={};break;
   case "/api/bots/loot-memory":body={};break;
   case "/api/bridge/corp-offices":body=officeList([stationID]);break;
   case "/api/client-data/dogma-types":body={available:true,types:{30:{categoryID:25}}};break;
   case "/api/mining-operations/resources":body={resources:[{typeID:oreType,family:"ore",name:"Ore"}]};break;
   case "/api/types/compressed":body={compressedTypeIDs:{},capped:false};break;
   case "/api/types/volumes":body={volumes:{30:1},capped:false};break;
   case "/api/bridge/ship/ore-hold":body={activeShipID:shipID,holds:[
    {key:"ore",present:false,error:null,capacity:{capacity:0,used:0}},
    {key:"cargo",present:true,error:null,capacity:{capacity:scenario.kind==="relocate"?100:10,used:held.reduce((sum,row)=>sum+row.quantity,0)}},
   ]};break;
   default:throw Error(`Unexpected request ${path}`);
  }
  return Response.json({ok:true,...body});
 };
 const deps={
  storage,
  attach:async()=>session,
  createCycle:async(run:PluginRunContext)=>{
   assert.ok(relocating);
   const id=run.characterID;
   const cycleSetup=run.setup as unknown as FleetSetup;
   return {
    async tick(_target:unknown,claim:{key:string}){
     const read=await run.fetch(new URL("/api/bridge/space/snapshot",run.baseUrl));
     const {space}=await read.json() as {space:ReturnType<typeof localScene>};
     const observed=space.entities.find(e=>"categoryID" in e&&e.categoryID===25);
     if(observed&&"beltID" in observed){
      assert.equal(locations.get(id),cycleSetup.beltID);
      assert.equal(observed.beltID,cycleSetup.beltID);
      assert.ok(claim.key.endsWith(cycleSetup.beltName!));
      events.push("mining:"+id+":"+cycleSetup.beltID);
      return "yield" as const;
     }
     const count=(emptySamples.get(id)??0)+1;emptySamples.set(id,count);
     return count>=3?"depleted" as const:"blocked" as const;
    },
    droneIDs:()=>[],
    async stop(){events.push("lasers-settled:"+id);},
    async release(){},
   };
  },
  createDefender(config:any){
   return {
    async navigate(){locations.set(4,config.beltID);events.push("defender-arrived:"+config.beltID);},
    async tick(){
     assert.equal(config.stopRequested(),false);
     assert.equal(config.authority()?.target.name,config.target.name);
     if(config.beltID===nextBeltID&&atBelt&&haulerBeltID===beltID&&events.includes("old-pickup-in-flight")){
      assert.ok([1,2,4].every(id=>locations.get(id)===nextBeltID));
      events.push("defender-escorting-belt-b-during-pickup");
     }
     return "watching";
    },
    async stop(){events.push("defender-recalled");},
    repairStatus(){return null;},warning(){return null;},
   } as any;
  },
  settle:async(run:PluginRunContext)=>{
   if(droneInSpace.delete(run.characterID))events.push("miner-recalled:"+run.characterID);
   return {modulesInactive:true as const,dronesSafe:true as const,observedAt:Date.now()};
  },
 };
 const runtime=createMiningFleetRuntime(deps);
 let group=runtime.getOrCreate(setup);
 const context={botID,characterID,setup,held:{characterID},baseUrl:"http://bff",fetch:fetcher,report(){}} as unknown as PluginRunContext;
 const handle=await group.add(context,hauler);
 t.after(()=>handle.stop());
 const claim=group.op.reserve(1,target);assert.ok(claim);assert.equal(group.op.activate(1),true);
 const facts={30:{categoryID:25,freightKind:"RAW" as const,unitVolumeM3:1}};
 function publish(row:typeof rows[number],claim:Claim){
  const producerShip=row.ownerID+10;
  const item={itemID:row.itemID,typeID:row.typeID,quantity:row.quantity,freightKind:"RAW" as const,unitVolumeM3:1};
  const scope:Pick<Extract<Manifest,{source:"native-jetcan"}>,"operationID"|"runID"|"characterID"|"shipID"|"systemID"|"targetKey"|"claimGeneration"|"observedAt">={
   operationID:setup.operationID,runID:setup.operationRunID,characterID:row.ownerID,shipID:producerShip,
   systemID:miningSystem,targetKey:claim.key,claimGeneration:claim.generation,observedAt:Date.now()};
  const intent=group.op.prepareJetcan(row.ownerID,[item],100,facts,
   {...scope,source:"checked-ship-holds",items:[{...item,ownerID:row.ownerID,locationID:producerShip,flagID:5}]});
  assert.ok(intent);assert.equal(group.op.dispatchJetcan(row.ownerID,intent.generation),true);
  assert.equal(group.op.registerJetcan({...scope,source:"native-jetcan",items:[item],intentGeneration:intent.generation,
   containerID:row.locationID,capacityM3:100},facts),true);
 }
 for(const row of rows)publish(row,claim);
 assert.deepEqual([...group.entries.keys()],[characterID]);
 const haul=()=>createRawMembers(group.op).hauler(characterID,group.entries.get(characterID)!.native as RawHaulerNative);
 assert.equal(await haul(),"delivered");
 assert.equal(group.op.snapshot().manifests.filter(m=>!m.delivered).length,3);

 if(relocating){
  // Keep the real Hauler idle during belt selection, then run its existing
  // native-shaped inventory and navigation path against the old claim.
  const haulerEntry=group.entries.get(characterID)!;
  haulerEntry.busy=true;
  const peers=setup.members.filter(m=>m.role!=="HAULER");
  for(const member of peers){
   const id=member.characterID;
   const pilot={
    store:{station:{get:()=>({online:{characterID:id,corporationID}})}},
    flow:{requestOptions:()=>({}),setLivePush(){},flying:{
     sessionGeneration:()=>1,isSessionClosing:()=>false,
     async warpAsTheAutopilot(destination:number){
      assert.equal(droneInSpace.has(id),false);
      assert.equal(destination,nextBeltID);
      events.push("miner-warp:"+id);locations.set(id,destination);
     },
     async bridgeDo(service:string,method:string){
      if(service==="invCache")return;
      assert.equal(method,"CmdReturnBay");
      droneInSpace.delete(id);events.push("miner-recalled:"+id);
     },
    }},
   } as unknown as PilotSession;
   const pilotRun={...context,characterID:id,botID:"belt-peer-"+id,held:{characterID:id},report(r:any){readout.push(id+" "+r.phase+" "+r.why);},
    fetch:async(input:unknown)=>{
     const path=new URL(String(input)).pathname;
     let body:object;
     switch(path){
      case "/api/bridge/bound-fleet":body=boundFleet;break;
      case "/api/bridge/flight/status":body={flight:{inSpace:true,docked:false,shipID:member.shipID,solarSystemID:miningSystem,shipMode:"STOP",transition}};break;
      case "/api/bridge/space/snapshot":body={space:localScene(id,member.shipID)};break;
      case "/api/client-data/system-objects/"+miningSystem:body={available:true,objects:beltRows};break;
      case "/api/names":body={names:Object.fromEntries(beltRows.map(b=>["evelocation:"+b.itemID,b.name])),capped:false};break;
      case "/api/bridge/drones":body={activeShipID:member.shipID,bay:id===1&&!droneInSpace.has(id)?[{itemID:701,typeID:102,quantity:1}]:[],
       inSpace:droneInSpace.has(id)?[{itemID:701,typeID:102,controlled:true,activity:"idle"}]:[],errors:{bay:null,shipInfo:null,inSpace:null}};break;
      default:throw Error("Unexpected relocation request "+path);
     }
     return Response.json({ok:true,...body});
    },
   } as unknown as PluginRunContext;
   const cycle=member.role==="MINER"?await deps.createCycle(pilotRun):null;
   group.entries.set(id,{run:pilotRun,session:pilot,member,cycle,native:{current(){},navigate:async()=>{},mineCycle:cycle?.tick,observeHolds:async()=>({items:[],source:{},facts:{},existingContainerIDs:[],sceneSampledAt:Date.now(),capacityM3:100})},selfUnload:null,
    generation:1,active:true,busy:false,failed:null,flushed:false,unregister(){},expiry:Date.now()+600000,lease:null} as any);

  }
  t.after(()=>{for(const entry of group.entries.values()){entry.active=false;entry.busy=false;}});
  await pump(()=>[1,2].every(id=>events.includes("mining:"+id+":"+beltID))&&events.includes("defender-arrived:"+beltID));
  originalDepleted=true;
  if(scenario.kind==="no-replacement"){
   await pump(()=>readout.some(row=>row.includes("No eligible replacement belt")));
   assert.equal(group.op.snapshot().claim?.key,claim.key);
   assert.equal(group.op.snapshot().relocation,undefined);
   assert.equal(events.some(e=>e.startsWith("miner-warp")),false);
   return;
  }
  if(scenario.kind==="stop-during-relocation"){
   await pump(()=>group.op.snapshot().state==="PARKING"&&!!group.op.snapshot().relocation);
   assert.equal(runtime.requestOperationStop({operationID:setup.operationID,operationRunID:setup.operationRunID},"RETURN_HOME")?.mode,"RETURN_HOME");
   await pump(()=>!group.op.snapshot().relocation);
   assert.equal(group.op.snapshot().stopFreight,"RETURN_HOME");
   assert.equal(group.op.snapshot().state,"SETTLING");
   assert.equal(events.some(e=>e.startsWith("miner-warp")),false);
   assert.deepEqual(events.filter(e=>e.startsWith("pickup:")),["pickup:100"]);
   return;
  }
  await pump(()=>[1,2].every(id=>events.includes("mining:"+id+":"+nextBeltID))&&events.includes("defender-arrived:"+nextBeltID));
  assert.ok(events.indexOf("miner-recalled:1")<events.indexOf("miner-warp:1"));
  assert.ok(events.includes("defender-recalled"));
  assert.ok(group.op.snapshot().claim?.key.endsWith(nextBeltName));
  assert.equal(Object.values(runtime.targetSnapshot()).find(r=>r.claim?.key===claim.key)?.state,"DRAINING");
  assert.equal(group.op.snapshot().manifests.filter(m=>!m.delivered).length,3);
  const nextClaim=group.op.snapshot().claim;assert.ok(nextClaim);
  const nextCan={...rows[0]!,itemID:24,locationID:104,quantity:10};
  cans.set(nextCan.locationID,nextCan);publish(nextCan,nextClaim);

  const oldTail=haul();
  await pump(()=>events.includes("defender-escorting-belt-b-during-pickup"));
  assert.equal(cans.has(101),true);
  releaseOldPickup();
  assert.equal(await advance(oldTail),"delivered");
  assert.deepEqual(events.filter(e=>e.startsWith("pickup:")),["pickup:100","pickup:101","pickup:102","pickup:103"]);
  assert.ok(events.indexOf("pickup:103")<events.indexOf("deposit:21"));
  assert.deepEqual(destination.map(row=>row.quantity),[90,10,10,10]);
  assert.equal(held.length,0);
  assert.equal(cans.size,1);
  assert.equal(group.op.heartbeat(),true);
  assert.ok(Object.values(runtime.targetSnapshot()).some(row=>row.target.name===target.name&&row.state==="DEPLETED"));

  assert.equal(await advance(haul()),"waiting");
  assert.ok(events.indexOf("pickup:104")>events.indexOf("deposit:23"));
  for(const id of [101,102,103,104])assert.ok(events.indexOf("read:"+id)<events.indexOf("claim:"+id));
  assert.deepEqual(events.filter(e=>e.startsWith("warp:")),["warp:"+beltID,"warp:"+nextBeltID]);
  assert.deepEqual(events.filter(e=>e==="route:"+stationID),["route:"+stationID,"route:"+stationID]);
  assert.deepEqual(held.map(row=>row.quantity),[10]);
  assert.equal(cans.size,0);
  haulerEntry.busy=false;
  return;
 }


  for(const id of [101,102,103])assert.equal(loot.claimContainer("other-session","other-run-"+id,miningSystem,id),true);
 await assert.rejects(haul(),/Another bot holds the container claim/);
 assert.equal(cans.get(101)?.quantity,10);
 assert.deepEqual(group.op.snapshot().haulClaims,{});
 assert.deepEqual(events.filter(e=>e.startsWith("pickup:")),["pickup:100"]);
  loot.releaseClaims("other-session","other-run-101");
  assert.equal(await haul(),"delivered");
  for(const id of [102,103])loot.releaseClaims("other-session","other-run-"+id);
 const identity={operationID:setup.operationID,operationRunID:setup.operationRunID};
 assert.deepEqual(runtime.requestOperationStop(identity,"COLLECT_FREIGHT"),{mode:"COLLECT_FREIGHT",live:true});
 await handle.stop("reconnect");
 assert.equal(group.retireStoppedGroup(),true);
 const restarted=createMiningFleetRuntime(deps);
 const resumed=await restarted.runs.HAULER.start({...context,resumed:true});
 t.after(()=>resumed.stop());
 group=restarted.getOrCreate(setup);
 assert.equal(group.op.snapshot().stopFreight,"COLLECT_FREIGHT");
 assert.deepEqual(restarted.requestOperationStop(identity,"RETURN_HOME"),{mode:"COLLECT_FREIGHT",live:true});
 cans.delete(102);
 gridReadFails=true;
  await assert.rejects(haul(),/local grid is unreadable|Pickup grid could not be read/);
 assert.ok(group.op.snapshot().manifests.some(m=>m.containerID===102));
 assert.deepEqual(group.op.snapshot().haulClaims,{});
 gridReadFails=false;
 assert.equal(await haul(),"delivered");
 assert.equal(group.op.snapshot().manifests.some(m=>m.containerID===102),false);
 assert.equal(await haul(),"idle");

 assert.deepEqual(events.filter(e=>e.startsWith("route:")),
  [`route:${stationID}`,`route:${miningSystem}`,`route:${stationID}`,`route:${miningSystem}`,`route:${stationID}`]);
 assert.deepEqual(events.filter(e=>e.startsWith("warp:")),[`warp:${beltID}`,`warp:${beltID}`]);
 for(const id of [100,101,103])assert.ok(events.indexOf(`read:${id}`)<events.indexOf(`claim:${id}`));
  assert.ok(!events.includes("claimed:102"));
 assert.deepEqual(events.filter(e=>e.startsWith("pickup:")),["pickup:100","pickup:101","pickup:103"]);
 assert.deepEqual(destination.map(row=>[row.itemID,row.quantity,row.ownerID,row.locationID,row.flagID]),
  [[20,10,corporationID,officeID,115],[21,10,corporationID,officeID,115],[23,10,corporationID,officeID,115]]);
 assert.equal(cans.size,0);assert.deepEqual(held,[]);
 const sum=(inventory:readonly {quantity:number}[])=>inventory.reduce((total,row)=>total+row.quantity,0);
 const result=group.op.snapshot();
 assert.deepEqual(result.manifests.map(row=>row.delivered),[true,true,true]);
 const receipts=runtime.deliveryReceiptIndex(result.operationID).map(({runID,containerID})=>
  runtime.deliveryReceipt(result.operationID,runID,containerID)!.receipt);
 assert.deepEqual(receipts.map(receipt=>[receipt.containerID,sum(receipt.destinationBefore),sum(receipt.destinationAfter)]),
  [[100,0,10],[101,10,20],[103,20,30]]);
});
