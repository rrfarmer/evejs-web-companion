import test from "node:test";
import assert from "node:assert/strict";
import type {PilotSession} from "../../../web/src/plugin-api/pilotSession.ts";
import type {PluginRunContext} from "../../../web/src/plugin-api/backend.ts";
import {memoryFleetDocuments} from "./operationStoreFixture.ts";
import {createMiningFleetRuntime,type FleetSetup} from "./runtime.ts";
import {createFleetMiningCycle} from "./miningCycle.ts";

test("real fleet bootstrap ranks held native scenes and pins its selected setup and full decision history",async t=>{
 t.mock.timers.enable({apis:["setInterval","Date"],now:100_000});
 const members=[{characterID:1,shipID:11,role:"MINER" as const},{characterID:2,shipID:12,role:"MINER" as const},
  {characterID:3,shipID:13,role:"HAULER" as const}];
 const setup:FleetSetup={operationID:"closure-native-locality",operationRunID:"epoch",systemID:300,destinationID:600,corporationID:77,
  division:1,beltID:90,beltName:"Alpha",beltCandidates:[{beltID:90,beltName:"Alpha"},{beltID:1,beltName:"Zulu"}],
  canCapacityM3:100,members,fleetPolicy:"EXISTING_ONLY"};
 const storage=memoryFleetDocuments(),cycles=new Map<number,number>(),reports:string[]=[];
 const runtime=createMiningFleetRuntime({storage,
  attach:async run=>({store:{station:{get:()=>({online:{characterID:run.held.characterID,corporationID:77}})}},
   flow:{requestOptions:()=>({}),setLivePush(){},flying:{sessionGeneration:()=>1,isSessionClosing:()=>false}}}) as unknown as PilotSession,
  createCycle:async(run,session,current,stopped,adapters)=>{
   const cycle=await createFleetMiningCycle(run,session,current,stopped,{...adapters,document:storage.document("cycle:"+run.characterID)});
   cycles.set(run.characterID,(run.setup as unknown as FleetSetup).beltID!);
   return cycle;
  },settle:async()=>({modulesInactive:true,dronesSafe:true,observedAt:Date.now()})});
 t.after(()=>runtime.shutdown());
 const kv=(entries:unknown[])=>({type:"object",name:"util.KeyVal",args:{type:"dict",entries}});
 const fleet=kv([["fleetID",900],["members",{type:"dict",entries:members.map(m=>[m.characterID,kv([["charID",m.characterID]])])}]]);
 const transition={phase:"ready",sessionStable:true,locationReady:true,sceneReady:true,egoReady:true,shipReady:true,boundContextReady:true};
 const point=(x:number)=>({x,y:0,z:0});
 const entities=[{itemID:80,groupID:6,name:"Sun",position:point(0)},{itemID:90,groupID:9,name:"Alpha",position:point(2_000_000)},
  {itemID:1,groupID:9,name:"Zulu",position:point(1000)}].map(row=>({...row,kind:"celestial",radius:10}));
 for(const {characterID,shipID,role} of members){
  const botID="native-"+characterID;
  await runtime.runs[role].start({characterID,botID,held:{characterID},resumed:false,setup,baseUrl:"http://fixture",
   report:(r:{phase?:string;why?:string})=>reports.push([r.phase,r.why].join(" ")),
   fetch:async(input:URL,init?:RequestInit)=>{
    assert.equal(init?.method??"GET","GET");
    let body:object;
    switch(new URL(input).pathname){
     case "/api/pilot-training/characters":body={account:"pilot-"+characterID,characters:[{characterID}]};break;
     case "/api/bots":body={bots:[{botID,characterID,expiresAt:new Date(Date.now()+600_000).toISOString()}]};break;
     case "/api/bridge/bound-fleet":body={fleetID:900,reads:{GetInitState:{result:fleet}}};break;
     case "/api/bridge/flight/status":body={flight:{shipID,solarSystemID:300,inSpace:true,docked:false,shipMode:"STOP",transition}};break;
     case "/api/map/system-stations/300":body={stations:[]};break;
     case "/api/client-data/system-objects/300":body={available:true,objects:[entities[0]]};break;
     case "/api/bridge/space/snapshot":body={space:{stateValid:true,inSpace:true,shipID,solarSystemID:300,sampledAtMs:Date.now(),
      ship:{itemID:shipID,characterID,mode:"STOP",position:point(0),radius:10},entities}};break;
     default:assert.fail("Unexpected read "+input);
    }
    return Response.json({ok:true,...body});
   }} as unknown as PluginRunContext);
 }
 const group=runtime.getOrCreate(setup);
 for(let n=0;n<20&&members.some(m=>m.role==="MINER"&&cycles.get(m.characterID)!==1);n++){t.mock.timers.tick(1500);await new Promise<void>(resolve=>setImmediate(resolve));}
 assert.equal(group.op.snapshot().claim?.key,"BELT:300:Zulu",reports.join("\n"));
 assert.equal(group.op.snapshot().state,"ACTIVE");
 assert.deepEqual([...cycles].sort(),[[1,1],[2,1]],reports.join("\n"));
 for(const id of cycles.keys()){
  const journal=storage.document("cycle:"+id).read() as {identity:string};
  assert.equal(JSON.parse(journal.identity)[5],1);
 }
 const retained=storage.document("mining-fleet-initial-target:"+JSON.stringify([setup.operationID,setup.operationRunID])).read() as
  {next:FleetSetup;decision:{policy:string;anchors:{characterID:number}[];candidates:{key:string;medianDistanceM:number}[]}};
 assert.equal(retained.next.beltID,1);
 assert.equal(retained.decision.policy,"PREFER_FLEET_LOCALITY");
 assert.deepEqual(retained.decision.candidates.map(c=>[c.key,c.medianDistanceM]),[["BELT:300:Zulu",1000],["BELT:300:Alpha",2_000_000]]);
 assert.equal(retained.decision.anchors.length,1);
 assert.ok(members.some(m=>m.characterID===retained.decision.anchors[0]?.characterID&&m.role==="MINER"));
 assert.deepEqual(group.telemetrySnapshot().history?.[0]?.evidence,retained.decision);
});
