import {memoryFleetDocuments} from "./operationStoreFixture.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type {PluginRunContext} from "../../../web/src/plugin-api/backend.ts";
import {createMiningFleetRuntime,type FleetSetup} from "./runtime.ts";
import type {StopFreightMode} from "./operation.ts";
import type {RawHaulerNative,RawMinerNative} from "./memberLoops.ts";
import {createTravelAssist} from "./travelAssist.ts";
import {officeList,corporationRow} from "./corporateOfficeFixture.ts";
import {createFleetLaunchJournal} from "../operations/miningLaunchJournal.ts";

const storage=memoryFleetDocuments(),document=storage.document;
for(const mode of ["RETURN_HOME","COLLECT_FREIGHT"] as const satisfies readonly StopFreightMode[]){
 test(`${mode} settles miners, assigns only the selected freight work and verifies all three pilots park`,async t=>{
  t.mock.timers.enable({apis:["setInterval","Date"],now:Date.now()});
  const events:string[]=[];
  const docks=new Map<number,number>();
  const target={kind:"BELT" as const,systemID:300,name:mode};
  const setup:FleetSetup={operationID:mode,operationRunID:"run",systemID:300,beltID:99,beltName:target.name,
   destinationID:600,corporationID:77,division:1,canCapacityM3:100,
   members:[{characterID:1,shipID:11,role:"MINER"},{characterID:2,shipID:12,role:"DEFENDER"},{characterID:3,shipID:13,role:"HAULER"}]};
  const runtime=createMiningFleetRuntime({storage,createCycle:async()=>{throw Error("Unexpected start");},
   settle:async run=>{events.push(`settle:${run.characterID}`);return {modulesInactive:true,dronesSafe:true,observedAt:Date.now()};},
   park:async run=>{
    const id=(run as PluginRunContext).characterID;
    assert.ok(mode!=="COLLECT_FREIGHT"||id!==2,"Defender should park at the configured delivery station");
    events.push(`park:${id}`);return {destinationID:600,kind:"station",systemID:300};
   },
   createDefender:()=>assert.fail("Stop must not create an escort for freight"),
  });
  const group=runtime.getOrCreate(setup),claim=group.op.reserve(1,target);
  assert.ok(claim);assert.equal(group.op.activate(1),true);
  const ore={itemID:20,typeID:30,quantity:10,freightKind:"RAW" as const,unitVolumeM3:1};
  const facts={30:{categoryID:25,freightKind:"RAW" as const,unitVolumeM3:1}};
  const source={source:"checked-ship-holds" as const,characterID:1,shipID:11,systemID:300,targetKey:claim.key,claimGeneration:claim.generation,observedAt:Date.now(),
   items:[{...ore,ownerID:1,locationID:11,flagID:134}]};
  const original=group.op.prepareJetcan(1,[ore],100,facts,source);assert.ok(original);
  assert.equal(group.op.dispatchJetcan(1,original.generation),true);
  assert.equal(group.op.registerJetcan({operationID:mode,runID:"run",...source,
   containerID:100,capacityM3:100,intentGeneration:original.generation,items:[ore],source:"native-jetcan"},facts),true);
  let oreAboard=true,delivered=0,allowDelivery!:()=>void;
  const deliveryGate=new Promise<void>(resolve=>{allowDelivery=resolve;});
  t.after(allowDelivery);
  const miner:RawMinerNative={
   current(){},async navigate(){},async mineCycle(){throw Error("Productive mining must stop");},
   async observeHolds(){
    events.push("read-mining-hold");
    const items=oreAboard?[{...ore,itemID:21,quantity:3}]:[];
    return {source:{...source,observedAt:Date.now(),items:items.map(item=>({...item,ownerID:1,locationID:11,flagID:134}))},
     items,facts,capacityM3:100,existingContainerIDs:[100],sceneSampledAt:Date.now()};
   },
   async jettison(ids){assert.deepEqual(ids,[21]);oreAboard=false;events.push("jettison");},
   async observeCreatedCan(before){
    return {containerID:101,ownerID:1,shipID:11,systemID:300,targetKey:claim.key,claimGeneration:claim.generation,
     observedAt:Date.now(),items:before.items,sourceAfter:{...source,observedAt:Date.now(),items:[]}};
   },
  };
  const hauler:RawHaulerNative={
   current(){},async canCarryFreight(){return true;},
   async navigateAndVerify(manifest){
    events.push(`pickup:${manifest.containerID}`);
   },
   async transferAndDeliver(manifest,generation,destinationID){
    if(manifest.containerID===100){events.push("delivery-in-flight");await deliveryGate;}
    const before=delivered;delivered+=manifest.items.reduce((n,row)=>n+row.quantity,0);
    return {source:"native-transfer",operationID:mode,runID:"run",containerID:manifest.containerID,claimGeneration:generation,
     shipID:13,destinationID,sourceAfter:[],destinationBefore:before?[{typeID:30,quantity:before}]:[],
     destinationAfter:[{typeID:30,quantity:delivered}],observedAt:Date.now()};
   },
  };
  const kv=(entries:unknown[])=>({type:"object",name:"util.KeyVal",args:{type:"dict",entries}});
  const oreRow={itemID:21,typeID:30,ownerID:1,locationID:11,flagID:134,quantity:3,categoryID:25};
  const office:object[]=[];
  const inventory=(rows:object[])=>({type:"list",items:rows.map(fields=>({type:"packedrow",fields}))});
  for(const member of setup.members){
   const {characterID,shipID}=member;
   const session={store:{station:{get:()=>({online:{characterID,corporationID:77}})}},flow:{requestOptions:()=>({}),setLivePush(){},
    async startRoute(destinationID:number){
     assert.equal(destinationID,600);
     events.push(characterID===2?"defender-route:"+destinationID:"miner-route:"+destinationID);return {started:true};
    },
    flying:{sessionGeneration:()=>1,isSessionClosing:()=>false,autopilotProgress:()=>({status:"arrived"}),abortAutopilot(){},
     async dockStep(destinationID:number){docks.set(characterID,destinationID);events.push(`park:${characterID}`);},
     async bridgeAsk(service:string,method:string,_args:unknown[],kwargs:{flag:number},of:number){
      assert.equal(characterID,1);
      if(service==="corpRegistry")return corporationRow(method,characterID,77);
      if(service==="officeManager")return {list:[{fields:{stationID:600,officeID:700}}]};
      assert.equal(method,"List");
      return of===11?inventory(oreAboard&&kwargs.flag===134?[oreRow]:[]):inventory(office);
     },
     async bridgeDo(service:string,method:string){
      if(service==="invCache")return;
      assert.equal(method,"Add");events.push("unload:1");
      oreAboard=false;office.push({...oreRow,ownerID:77,locationID:700,flagID:115});
     }}}};
   const run={characterID,shipID,baseUrl:"http://bff",botID:`bot-${characterID}`,report(value:{status:string}){
    if(value.status==="stopped")events.push(`release:${characterID}`);
   },async fetch(input:URL|string){
    const path=new URL(input).pathname;
    if(path==="/api/bridge/flight/status"){
     const stationID=docks.get(characterID)??null;
     return Response.json({ok:true,flight:{shipID,inSpace:stationID===null,docked:stationID!==null,stationID,
      solarSystemID:300,shipMode:"STOP",transition:{phase:"ready"}}});
    }
    if(path==="/api/map/station/600")return Response.json({ok:true,station:{stationID:600}});
    if(path==="/api/map/resolve/600")return Response.json({ok:true,kind:"station",stationID:600,solarSystemID:300});
    if(path==="/api/bridge/corp-offices")return Response.json(officeList());
    if(path==="/api/mining-operations/resources")return Response.json({ok:true,resources:[{typeID:30,family:"ore",name:"Ore"}]});
    if(path==="/api/client-data/dogma-types")return Response.json({ok:true,available:true,types:{30:{categoryID:25}}});
    if(path==="/api/types/volumes")return Response.json({ok:true,volumes:{30:1},capped:false});
    assert.equal(path,"/api/bridge/bound-fleet");
    const remaining=setup.members.filter(m=>!events.includes(`release:${m.characterID}`));
    return Response.json({ok:true,fleetID:900,reads:{GetInitState:{result:kv([["fleetID",900],
     ["members",{type:"dict",entries:remaining.map(m=>[m.characterID,kv([["charID",m.characterID]])])}]])}}});
   }};
   group.entries.set(characterID,{member,session,run,native:characterID===1?miner:hauler,
    cycle:characterID===1?{stop:async()=>{events.push("mining-cycle-settled");},droneIDs:()=>[55]}:null,
    defender:characterID===2?{async tick(){assert.fail("Defender must not continue escort after Stop");},
     async stop(){events.push("defender-recall");},droneIDs:()=>[],warning:()=>null}:undefined,
    active:true,busy:false,failed:null,flushed:false,generation:1,expiry:Date.now()+600000,lease:null,unregister(){}} as any);
  }
  const identity={operationID:setup.operationID,operationRunID:setup.operationRunID};
  assert.deepEqual(runtime.requestOperationStop(identity,mode),{mode,live:true});
  if(mode==="COLLECT_FREIGHT"){
   for(let tick=0;tick<20&&!(events.includes("release:2")&&events.includes("delivery-in-flight"));tick++){
    t.mock.timers.tick(1500);
    await new Promise<void>(resolve=>setImmediate(resolve));
   }
   assert.ok(events.includes("delivery-in-flight"),JSON.stringify({events,telemetry:group.telemetrySnapshot().members.map(m=>[m.characterID,m.phase,m.reason])}));
   assert.equal(docks.get(2),600);
   assert.ok(events.includes("release:2"));
   assert.equal(group.entries.get(2)?.active,false);
   assert.ok(group.op.snapshot().parked.includes(2));
   assert.equal(group.op.snapshot().state,"DRAINING");
   assert.equal(group.entries.get(3)?.active,true);
   assert.equal(delivered,0);
   allowDelivery();
  }
  for(let tick=0;tick<24&&events.filter(e=>e.startsWith("release:")).length<3;tick++){
   t.mock.timers.tick(1500);
   await new Promise<void>(resolve=>setImmediate(resolve));
  }
  const result=group.op.snapshot();
  assert.equal(result.state,"STOPPED",JSON.stringify({events,status:group.telemetrySnapshot()}));
  assert.deepEqual([...result.parked].sort(),[1,2,3]);
  assert.deepEqual(events.filter(e=>e.startsWith("release:")).sort(),["release:1","release:2","release:3"]);
  const deliveries=result.manifests.map(m=>m.containerID);
  if(mode==="RETURN_HOME"){
   assert.equal(oreAboard,true);assert.deepEqual(deliveries,[]);
   assert.ok(!events.some(e=>e==="jettison"||e==="read-mining-hold"||e.startsWith("pickup:")));
  }else{
   assert.equal(oreAboard,false);assert.deepEqual(deliveries,[100]);assert.equal(delivered,10);
   assert.ok(!events.includes("jettison"));
   assert.ok(events.indexOf("mining-cycle-settled")<events.indexOf("unload:1"));
   assert.ok(events.indexOf("unload:1")<events.indexOf("release:1"));
   assert.ok(events.indexOf("defender-recall")<events.indexOf("defender-route:600"));
  }
 });
}

test("a 12-hour shift starts home 15 minutes early and retains a docked pilot through a late unload",async t=>{
 const shiftEndsAt=new Date("2026-11-22T11:27:00Z").getTime(),returnAt=shiftEndsAt-15*60_000;
 t.mock.timers.enable({apis:["setInterval","Date"],now:returnAt-3_000});
 const setup:FleetSetup={operationID:"timed-parking",operationRunID:"run",systemID:300,beltID:99,beltName:"Belt",
  destinationID:600,corporationID:77,division:1,canCapacityM3:100,
  parking:{mode:"RETURN_HOME_UNLOAD_DOCK",kind:"station",destinationID:600,systemID:300,corporationID:77,division:1},
  members:[{characterID:1,shipID:11,role:"MINER"},{characterID:3,shipID:13,role:"HAULER"},
   {characterID:4,shipID:14,role:"DEFENDER"}]};
 const journal=createFleetLaunchJournal(document("timed-launch"));
 journal.begin({operationID:setup.operationID,operationRunID:setup.operationRunID,revision:1,planHash:"plan",setupHash:"setup",
  shiftEndsAt,members:[{characterID:1,role:"MINER",kind:"mcc-miner",accountName:"miner",beforeIDs:[]},
   {characterID:3,role:"HAULER",kind:"mcc-hauler",accountName:"hauler",beforeIDs:[]},
   {characterID:4,role:"DEFENDER",kind:"mcc-defender",accountName:"defender",beforeIDs:[]}]});
 const runtime=createMiningFleetRuntime({storage,launchJournal:()=>journal,createCycle:async()=>{throw Error("Unexpected cycle initialization");},
  settle:async()=>({modulesInactive:true,dronesSafe:true,observedAt:Date.now()})});
 const group=runtime.getOrCreate(setup);
 const claim=group.op.reserve(1,{kind:"BELT",systemID:300,name:"Belt"});
 assert.ok(claim);
 assert.ok(group.op.activate(1));
 const docked=new Set<number>(),released=new Set<number>();
 const ore={itemID:20,typeID:30,ownerID:1,locationID:11,flagID:134,quantity:40_882,categoryID:25};
 let hold=[ore],division:typeof hold=[],unloadStarted=false,unblock!:()=>void;
 const delayedUnload=new Promise<void>(resolve=>{unblock=resolve;});
 let dismissEscort!:()=>void,covered=false,defenderRecalled=false;
 const miningRecall=new Promise<void>(resolve=>{dismissEscort=resolve;});
 t.after(()=>{unblock();dismissEscort();});
 const inventory=(rows:typeof hold)=>({type:"list",items:rows.map(fields=>({type:"packedrow",fields}))});
 for(const member of setup.members){
  const {characterID,shipID}=member;
  const session={store:{station:{get:()=>({online:{characterID,corporationID:77}})}},flow:{requestOptions:()=>({}),setLivePush(){},
   async startRoute(dest:number){assert.equal(dest,600);return {started:true};},
   flying:{sessionGeneration:()=>1,isSessionClosing:()=>false,autopilotProgress:()=>({status:"arrived"}),abortAutopilot(){},
    async dockStep(dest:number){assert.equal(dest,600);docked.add(characterID);},
    async bridgeAsk(service:string,method:string,_args:unknown[],kwargs:{flag:number},of:number){
     if(service==="corpRegistry")return corporationRow(method,characterID,77);
     if(service==="officeManager")return {list:[{fields:{stationID:600,officeID:700}}]};
     assert.equal(method,"List");
     return inventory(of===700?division:characterID===1&&kwargs.flag===134?hold:[]);
    },
    async bridgeDo(service:string,method:string,args:unknown[]){
     if(service==="invCache")return;
     assert.equal(method,"Add");assert.deepEqual(args,[20,11]);
     assert.equal(characterID,1);assert.ok(docked.has(1));unloadStarted=true;
     await delayedUnload;
     hold=[];division=[{...ore,ownerID:77,locationID:700,flagID:115}];
    }}}};
  const run={characterID,botID:`timed-${characterID}`,baseUrl:"http://bff",report(value:{status:string}){
   if(value.status==="stopped"){
    assert.ok(docked.has(characterID));
    if(characterID===1)assert.equal(division[0]?.quantity,40_882);
    released.add(characterID);
   }
  },async fetch(input:URL|string){
   const path=new URL(input).pathname;
   if(path==="/api/bridge/flight/status")return Response.json({ok:true,flight:{shipID,inSpace:!docked.has(characterID),
    docked:docked.has(characterID),stationID:docked.has(characterID)?600:null,solarSystemID:300,shipMode:"STOP",transition:{phase:"ready"}}});
   if(path==="/api/map/station/600")return Response.json({ok:true,station:{stationID:600}});
   if(path==="/api/map/resolve/600")return Response.json({ok:true,kind:"station",stationID:600,solarSystemID:300});
   if(path==="/api/bridge/corp-offices")return Response.json(officeList());
   if(path==="/api/mining-operations/resources")return Response.json({ok:true,resources:[{typeID:30,family:"ore",name:"Ore"}]});
   if(path==="/api/client-data/dogma-types")return Response.json({ok:true,available:true,types:{30:{categoryID:25}}});
   if(path==="/api/types/volumes")return Response.json({ok:true,volumes:{30:0.35},capped:false});
   throw Error("Unexpected request "+path);
  }};
  group.entries.set(characterID,{member,session,run,cycle:characterID===1?{stop:()=>miningRecall,droneIDs:()=>[]}:null,native:{},
   ...(characterID===4?{escortGeneration:claim.generation,defender:{
    async tick(){covered=true;return "watch";},async stop(){defenderRecalled=true;},droneIDs:()=>[],warning:()=>null,repairStatus:()=>null,
   }}:{}),
   active:true,busy:true,failed:null,flushed:false,generation:1,expiry:shiftEndsAt+15*60_000,lease:null,unregister(){}} as any);
 }
 async function tick(){t.mock.timers.tick(1_500);await new Promise<void>(resolve=>setImmediate(resolve));}
 await tick();
 assert.equal(group.op.snapshot().state,"ACTIVE");
 assert.equal(group.op.snapshot().stopRequested,undefined);
 for(const entry of group.entries.values())entry.busy=false;
 await tick();
 assert.equal(Date.now(),returnAt);
 assert.equal(group.op.snapshot().stopFreight,"RETURN_HOME");
 assert.equal(covered,true);
 assert.equal(defenderRecalled,false);
 dismissEscort();
 for(let i=0;i<10&&!unloadStarted;i++)await tick();
 assert.equal(unloadStarted,true,JSON.stringify(group.telemetrySnapshot().members));
 assert.ok(docked.has(1));
 assert.equal(group.op.snapshot().parked.includes(1),false);
 assert.equal(released.has(1),false);
 t.mock.timers.setTime(shiftEndsAt+1_500);
 await tick();
 assert.equal(group.entries.get(1)?.active,true);
 assert.equal(released.has(1),false);
 unblock();
 for(let i=0;i<10&&released.size<setup.members.length;i++)await tick();
 assert.deepEqual([...released].sort(),[1,3,4],JSON.stringify({
  state:group.op.snapshot(),time:Date.now(),members:group.telemetrySnapshot().members,
  busy:[...group.entries.values()].map(e=>[e.member.characterID,e.busy,e.failed]),
 }));
 assert.equal(defenderRecalled,true);
 assert.equal(group.op.snapshot().state,"STOPPED");
 assert.equal(group.hasTargetOwner(),false);
 assert.ok(group.telemetrySnapshot().stoppedAt!>shiftEndsAt);
});

test("MCC Stop keeps retrying its Travel Assist observation while an independent pilot parks",async t=>{
 t.mock.timers.enable({apis:["setInterval","Date"],now:Date.now()});
 const setup:FleetSetup={operationID:"travel-assist-stop",operationRunID:"run",systemID:300,beltID:99,beltName:"Belt",
  destinationID:600,corporationID:77,division:1,canCapacityM3:100,members:[
   {characterID:1,shipID:11,role:"MINER"},{characterID:3,shipID:13,role:"HAULER"}]};
 const target={kind:"BELT" as const,systemID:300,name:setup.beltName!};
 const reports:string[]=[],parked:number[]=[],writes:boolean[]=[];
 const runtime=createMiningFleetRuntime({storage,createCycle:async()=>{throw Error("Unexpected start");},
  settle:async()=>({modulesInactive:true,dronesSafe:true,observedAt:Date.now()}),
  park:async run=>{parked.push((run as PluginRunContext).characterID);return {destinationID:600,kind:"station",systemID:300};},
 });
 const group=runtime.getOrCreate(setup);
 assert.ok(group.op.reserve(1,target));assert.ok(group.op.activate(1));
 const module={itemID:50,typeID:439,flagID:19,effectID:6731,effect:"moduleBonusAfterburner",kind:"afterburner" as const};
 let active=false,readable=true;
 const assist=createTravelAssist({identity:{operationID:setup.operationID,runID:setup.operationRunID,characterID:1,shipID:11,botID:"bot-1"},
  document:document("stop-prop"),current(){},beforeAction(){},
  read:async()=>({modules:[{...module,active}],capacitorRatio:1,scrammed:false}),
  observe:async()=>{if(!readable)throw Error("Native effect observation unavailable");return active;},
  change:async(_module,on)=>{writes.push(on);if(on)active=true;},
 });
 await assist.beforeApproach("rock",25000,1000);
 await assist.settle();
 readable=false;
 for(const member of setup.members){
  const {characterID,shipID}=member;
  const session={store:{station:{get:()=>({online:{characterID,corporationID:77}})}},flow:{requestOptions:()=>({}),setLivePush(){},
   flying:{sessionGeneration:()=>1,isSessionClosing:()=>false}}};
  const run={characterID,botID:"bot-"+characterID,baseUrl:"http://bff",report(r:{phase:string}){reports.push(r.phase);},
   async fetch(input:URL|string){
    assert.equal(new URL(input).pathname,"/api/bridge/flight/status");
    return Response.json({ok:true,flight:{shipID,inSpace:true,docked:false,solarSystemID:300}});
   }};
  group.entries.set(characterID,{member,session,run,travel:characterID===1?assist:undefined,
   cycle:characterID===1?{stop:async()=>{},droneIDs:()=>[]}:null,
   active:true,busy:false,failed:null,flushed:false,generation:1,expiry:Date.now()+600000,lease:null,unregister(){}} as any);
 }
 group.requestStop("RETURN_HOME");
 async function ticks(n:number){for(let i=0;i<n;i++){t.mock.timers.tick(1500);await new Promise<void>(r=>setImmediate(r));}}
 await ticks(24);
 assert.ok(reports.filter(p=>p==="Settling Travel Assist").length>3);
 assert.deepEqual(parked,[3]);
 assert.equal(group.entries.get(1)?.failed,null);
 assert.equal(assist.snapshot().pending?.kind,"off");
 active=false;readable=true;
 await ticks(8);
 assert.equal(group.op.snapshot().state,"STOPPED");
 assert.deepEqual(parked,[3,1]);
 assert.equal(assist.snapshot().pending,null);
 assert.deepEqual(writes,[true,false]);
});
