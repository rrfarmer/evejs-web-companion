import test from "node:test";
import assert from "node:assert/strict";
import {decodeSpaceSnapshot} from "../../../web/src/plugin-api/flying.ts";
import {createMinerDroneFlight} from "./minerDrones.ts";
import {FleetObservationUnavailable} from "./stopSignal.ts";

function pendingFlight(maxActive=1,controlRange:number|null=10_000){
 type Drone={itemID:number;typeID:number;activity:string|null;targetID:number|null;ownerID?:number;controllerID?:number|null};
 const bay=new Map([[7,{itemID:7,typeID:101,quantity:1}]]),out=new Map<number,Drone>([[8,{itemID:8,typeID:102,activity:"idle",targetID:null}]]);
 const calls:string[]=[];let heldMethod:string|null=null,failedMethod:string|null=null,release=()=>{},entered=()=>{},bayReads=0;
 const sentAt=new Map<string,number>();
 let rangeReads=0,snapshotReads=0,invalidations=0,limitReads=0,allowSnapshot=false,refuseRange=false;
 let stateValid=true,exposeDroneControl=true,reconnectRefused=false,combatTypeKnown=true,deferRecall=false;
 const returnDrone=(id:number)=>{const d=out.get(id)!;out.delete(id);bay.set(id,{itemID:id,typeID:d.typeID,quantity:1});};
 let secondHostileM:number|undefined;
 let nativeGrid:{hostile:boolean|number;sampledAtMs:number}|undefined;
 let latest:{space:ReturnType<typeof decodeSpaceSnapshot>;observedAt:number}|undefined;
 let gate=Promise.resolve();
  const space=(hostile:boolean|number,sampledAtMs=Date.now()):Parameters<typeof decodeSpaceSnapshot>[0]=>({stateValid,inSpace:true,shipID:11,solarSystemID:300,sampledAtMs,
  ship:{itemID:11,characterID:1,mode:"STOP",position:{x:0,y:0,z:0},radius:1},entities:[
   {itemID:77,typeID:30,categoryID:25,kind:"asteroid",position:{x:100,y:0,z:0},radius:1},
   ...[...out.values()].map(d=>({...d,kind:"drone",ownerID:d.ownerID??1,
    controllerID:exposeDroneControl&&d.controllerID!==null?d.controllerID??11:null,
    droneActivity:exposeDroneControl?d.activity:null,targetEntityID:exposeDroneControl?d.targetID:null,
    position:{x:0,y:0,z:0},radius:1})),
   ...(hostile?[{itemID:90,typeID:40,categoryID:11,kind:"ship",isNpc:true,npcEntityType:"npc",position:{x:typeof hostile==="number"?hostile:500,y:0,z:0},radius:1}]:[]),
   ...(secondHostileM===undefined?[]:[{itemID:91,typeID:40,categoryID:11,kind:"ship",isNpc:true,npcEntityType:"npc",position:{x:secondHostileM,y:0,z:0},radius:1}]),
  ]});
 const session:any={store:{names:{get:()=>({resolved:{"typeGroup:101":"Mining Drone",...(combatTypeKnown?{"typeGroup:102":"Combat Drone"}:{})}})},fitting:{get:()=>({})}},flow:{requestOptions:()=>({}),flying:{
   resolveNamesNow:async()=>{},
   resolveDroneControlRange:async()=>{
    rangeReads++;
    if(heldMethod==="Range"){entered();await gate;}
    return controlRange;
   },withPilotDroneCap:()=>({maxActiveDrones:maxActive}),attributesOfTypes:async()=>({101:{1272:5},102:{1272:5}}),
  bridgeAsk:async(_service:string,method:string)=>{
   if(method==="List"){bayReads++;if(heldMethod==="List"){entered();await gate;}
    return {type:"list",items:[...bay.values()].map(d=>({...d,ownerID:1,locationID:11,flagID:87,categoryID:18}))};}
     assert.equal(method,"QueryAllAttributesForItem");limitReads++;
     if(heldMethod===method){entered();await gate;}
     return {type:"dict",entries:[[352,maxActive],[1271,5*maxActive]]};
  },
  bridgeDo:async(_service:string,method:string,args:any[])=>{
    if(method==="InvalidateLocationCache"){invalidations++;return null;}calls.push(method);sentAt.set(method,performance.now());
   if(method===failedMethod){failedMethod=null;throw Error("Bridge response lost");}
   if(method==="CmdEngage"&&refuseRange){
    refuseRange=false;
    return {type:"dict",entries:args[0].map((id:number)=>[id,["CustomNotify",{type:"dict",entries:[
     ["notify","That target is out of drone control range."],
    ]}]])};
   }
   if(method==="LaunchDrones")for(const [id]of args[0]){const d=bay.get(id)!;bay.delete(id);out.set(id,{...d,activity:"idle",targetID:null});}
   if(method==="CmdReconnectToDrones"){
    assert.equal(_service,"entity");
    assert.ok(args[0].length>0&&args[0].length<=25);
    for(const id of args[0]){
     const d=out.get(id)!;
     assert.equal(d.ownerID??1,1,"never request control of another pilot's drone");
     if(reconnectRefused||d.controllerID!==null)continue;
     d.controllerID=11;d.activity="idle";d.targetID=null;
    }
   }
   if(method==="CmdReturnBay"&&!deferRecall)for(const id of args[0])returnDrone(id);
   if(method==="CmdEngage"||method==="CmdMineRepeatedly")for(const id of args[0]){const d=out.get(id)!;d.targetID=args[1];d.activity=method==="CmdEngage"?"fighting":"mining";}
   if(heldMethod===method){entered();await gate;}
   return method==="LaunchDrones"?{type:"dict",entries:args[0].map(([id]:number[])=>[id,{type:"list",items:[id]}])}:{type:"dict",entries:[]};
  },
 }}};
 const run:any={characterID:1,resumed:true,baseUrl:"http://fixture",fetch:async(input:unknown)=>{
  assert.ok(allowSnapshot,"No second drone/flight/snapshot read is needed");
  assert.equal(new URL(String(input)).pathname,"/api/bridge/space/snapshot");
  snapshotReads++;
  if(heldMethod==="Snapshot"){entered();await gate;}
  return Response.json({ok:true,space:space(nativeGrid?.hostile??false,nativeGrid?.sampledAtMs)});
 }};
 const flight=createMinerDroneFlight(run,session,11,()=>{},()=>{},()=>{});
  return {calls,sentAt,bay,out,reads:()=>bayReads,rangeReads:()=>rangeReads,snapshotReads:()=>snapshotReads,
   invalidations:()=>invalidations,limitReads:()=>limitReads,flight,
   observeMiningGrid(hostile:boolean|number){latest={space:decodeSpaceSnapshot(space(hostile)),observedAt:performance.now()};},
   setNativeGrid(hostile:boolean|number,sampledAtMs:number){allowSnapshot=true;nativeGrid={hostile,sampledAtMs};},
   setControlRange(meters:number|null){controlRange=meters;},
   showDroneControl(value:boolean){exposeDroneControl=value;},
   setSceneValid(value:boolean){stateValid=value;},
   deferRecall(){deferRecall=true;},
   returnDrone,
   showCombatType(value:boolean){combatTypeKnown=value;},
   refuseReconnect(){reconnectRefused=true;},
   addSecondHostile(meters:number){secondHostileM=meters;},
   refuseNextEngageForRange(){refuseRange=true;},
  failNext(method:string){failedMethod=method;},
  hold(method:string){heldMethod=method;gate=new Promise<void>(r=>{release=r;});const started=new Promise<void>(r=>{entered=r;});return {started,release(){heldMethod=null;release();}};},
  tick(hostile:boolean|number,stale=false){
   if(stale)allowSnapshot=true;
    const age=stale?2000:0;
    const s=decodeSpaceSnapshot(space(hostile,Date.now()-age));
    return flight.tick(s,flight.observeThreat(s),s.entities.find(d=>d.itemID===77)!,performance.now()-age,()=>latest);
  },
 };
}

test("a resumed Miner reconnects its loose Mining Drones and uses the existing flight",async t=>{
 t.mock.timers.enable({apis:["Date"]});
 const x=pendingFlight();
 x.bay.clear();
 x.out.set(8,{itemID:8,typeID:101,controllerID:null,activity:null,targetID:null});
 x.out.set(9,{itemID:9,typeID:101,ownerID:2,controllerID:null,activity:null,targetID:null});
 await assert.rejects(x.tick(false),FleetObservationUnavailable);
 assert.deepEqual(x.calls,["CmdReconnectToDrones"]);
 assert.equal(x.out.get(8)?.controllerID,11);
 assert.deepEqual(x.flight.launchedIDs,[],"submission alone does not confirm the flight");
 t.mock.timers.tick(1000);
 await x.tick(false);
 assert.deepEqual(x.calls,["CmdReconnectToDrones","CmdMineRepeatedly"]);
 assert.equal(x.out.get(8)?.activity,"mining");
 assert.equal(x.out.get(9)?.controllerID,null);
 assert.deepEqual(x.flight.launchedIDs,[8]);
 assert.equal(x.reads(),0);
 assert.equal(x.snapshotReads(),0);
});

test("an unreadable drone controller cannot authorize a replacement launch",async t=>{
 t.mock.timers.enable({apis:["Date"]});
 const x=pendingFlight();
 x.out.set(8,{itemID:8,typeID:101,controllerID:11,activity:"idle",targetID:null});
 x.showDroneControl(false);
 for(let i=0;i<3;i++){
  await assert.rejects(x.tick(false),FleetObservationUnavailable);
  t.mock.timers.tick(1000);
 }
 assert.deepEqual(x.calls,["CmdReconnectToDrones"],"a native no-op must not repeat on unchanged observations");
 assert.equal(x.bay.has(7),true);
 x.showDroneControl(true);
 await x.tick(false);
 assert.deepEqual(x.calls,["CmdReconnectToDrones","CmdMineRepeatedly"]);
});

test("an unconfirmed reconnect still in transport blocks a replacement launch",async t=>{
 t.mock.timers.enable({apis:["Date","setTimeout"]});
 const x=pendingFlight();
 x.out.set(8,{itemID:8,typeID:101,controllerID:null,activity:null,targetID:null});
 x.refuseReconnect();
 const command=x.hold("CmdReconnectToDrones"),first=x.tick(false);
 // Fail immediately when the implementation attempts a blind Launch instead.
 await Promise.race([command.started,first.then(()=>assert.fail("Expected a reconnect before any launch"))]);
 t.mock.timers.tick(12001);
 await assert.rejects(first,/still in flight/);
 x.out.clear();
 await assert.rejects(x.tick(false),FleetObservationUnavailable);
 assert.deepEqual(x.calls,["CmdReconnectToDrones"]);
 command.release();
 await new Promise<void>(resolve=>setImmediate(resolve));
 t.mock.timers.tick(1000);
 await x.tick(false);
 assert.deepEqual(x.calls,["CmdReconnectToDrones","LaunchDrones","CmdMineRepeatedly"]);
});

test("a resumed Miner launches from its bay only after a readable grid confirms an empty flight",async()=>{
 const x=pendingFlight();
 x.out.clear();
 x.setSceneValid(false);
 await x.tick(false);
 assert.deepEqual(x.calls,[]);
 x.setSceneValid(true);
 await x.tick(false);
 assert.deepEqual(x.calls,["LaunchDrones","CmdMineRepeatedly"]);
 assert.equal(x.out.get(7)?.activity,"mining");
});

test("a fresh grid showing a loose owned drone cancels a prepared replacement launch",async t=>{
 let now=1000;t.mock.method(performance,"now",()=>now);
 const x=pendingFlight();
 x.out.clear();
 const bay=x.hold("List"),work=x.tick(false);
 await bay.started;
 x.out.set(8,{itemID:8,typeID:101,controllerID:null,activity:null,targetID:null});
 now+=2000;x.observeMiningGrid(false);
 bay.release();
 await work;
 assert.deepEqual(x.calls,[]);
 assert.equal(x.bay.has(7),true);
 await assert.rejects(x.tick(false),FleetObservationUnavailable);
 assert.deepEqual(x.calls,["CmdReconnectToDrones"]);
});

test("a resumed Miner returns the recovered combat flight after the old hostile goes beyond 120 km",async t=>{
 t.mock.timers.enable({apis:["Date"]});
 const x=pendingFlight(1,250_000);
 x.out.set(8,{itemID:8,typeID:102,controllerID:null,activity:null,targetID:90});
 await assert.rejects(x.tick(200_000),FleetObservationUnavailable);
 for(let i=0;i<3;i++){
  t.mock.timers.tick(1000);
  await x.tick(200_000);
 }
 assert.deepEqual(x.calls,["CmdReconnectToDrones","CmdReturnBay","LaunchDrones","CmdMineRepeatedly"]);
 assert.equal(x.bay.has(8),true);
 assert.equal(x.out.get(7)?.activity,"mining");
});

test("a delayed spare bay read does not fetch another grid when the combat drones are already working",async t=>{
 let now=1000;t.mock.method(performance,"now",()=>now);
 const x=pendingFlight(2);
 x.out.set(8,{itemID:8,typeID:102,activity:"fighting",targetID:90});
 const bay=x.hold("List"),work=x.tick(true);
 await bay.started;
 now+=2000;bay.release();
 const result=await work;
 assert.equal(result.available,true);
 assert.equal(x.reads(),1);
 assert.equal(x.snapshotReads(),0);
 assert.deepEqual(x.calls,[]);
});

test("a timed-out Engage is read back and does not hold the next mining flight",async t=>{
 t.mock.timers.enable({apis:["Date","setTimeout"]});
 const x=pendingFlight(),pending=x.hold("CmdEngage"),first=x.tick(true);
 await pending.started;t.mock.timers.tick(12001);
 await assert.rejects(first,/still in flight/);
 await x.tick(false);await x.tick(false);
 assert.equal(x.calls.filter(m=>m==="CmdEngage").length,1);
 assert.equal(x.out.get(7)?.activity,"mining");
 pending.release();await new Promise<void>(resolve=>setImmediate(resolve));await x.flight.settle();
});

test("a timed-out Launch with drones already visible can engage without launching twice",async t=>{
 t.mock.timers.enable({apis:["Date","setTimeout"]});
 const x=pendingFlight();x.out.clear();x.bay.set(8,{itemID:8,typeID:102,quantity:1});
 const pending=x.hold("LaunchDrones"),first=x.tick(true);
 await pending.started;t.mock.timers.tick(12001);
 await assert.rejects(first,/still in flight/);
 await x.tick(true);
 assert.equal(x.calls.filter(m=>m==="LaunchDrones").length,1);
 assert.equal(x.out.get(8)?.targetID,90);
 pending.release();await new Promise<void>(resolve=>setImmediate(resolve));await x.flight.settle();
});

test("a slow bay read is reused after timeout instead of filling more transport lanes",async t=>{
 t.mock.timers.enable({apis:["Date","setTimeout"]});
 const x=pendingFlight();x.out.clear();const pending=x.hold("List"),first=x.tick(false);
 await pending.started;t.mock.timers.tick(12001);await assert.rejects(first,/observation timed out/);
 const next=x.tick(false);await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(x.reads(),1);
 pending.release();await next;
 assert.equal(x.reads(),1);assert.equal(x.out.get(7)?.activity,"mining");
});

test("a bay read that finished after timeout is not reused on the next pass",async t=>{
 t.mock.timers.enable({apis:["Date","setTimeout"]});
 const x=pendingFlight();x.out.clear();const pending=x.hold("List"),first=x.tick(false);
 await pending.started;t.mock.timers.tick(12001);await assert.rejects(first,/observation timed out/);
 pending.release();await new Promise<void>(resolve=>setImmediate(resolve));
 x.bay.clear();
 await x.tick(false);
 assert.equal(x.reads(),2);
 assert.deepEqual(x.calls,[]);
});

test("deployed idle Mining Drones get a mining order before an optional bay read",async()=>{
 const x=pendingFlight(2);
 x.out.set(8,{itemID:8,typeID:101,activity:"idle",targetID:null});
 await x.tick(false);
 assert.equal(x.reads(),0);
 assert.deepEqual(x.calls,["CmdMineRepeatedly"]);
 assert.equal(x.out.get(8)?.activity,"mining");

 await x.tick(false);
 assert.equal(x.reads(),1);
 assert.deepEqual(x.calls,["CmdMineRepeatedly","LaunchDrones","CmdMineRepeatedly"]);
});

test("a full working mining flight uses the existing grid and pilot cap without drone reads",async()=>{
 const x=pendingFlight();
 x.out.set(8,{itemID:8,typeID:101,activity:"mining",targetID:77});
 assert.equal((await x.tick(false,true)).available,true);
 assert.deepEqual([x.snapshotReads(),x.invalidations(),x.reads(),x.rangeReads(),x.limitReads()],[0,0,0,0,0]);
 assert.deepEqual(x.calls,[]);
});

test("working drones do not repeatedly scan a bay that has no spare mining drone",async t=>{
 t.mock.timers.enable({apis:["Date"]});
 const x=pendingFlight(2),spare=x.bay.get(7)!;
 x.bay.clear();
 x.out.set(8,{itemID:8,typeID:101,activity:"mining",targetID:77});
 for(let i=0;i<3;i++){
  assert.equal((await x.tick(false)).available,true);
  t.mock.timers.tick(1500);
 }
 assert.deepEqual([x.invalidations(),x.reads(),x.rangeReads(),x.limitReads()],[1,1,0,0]);

 x.bay.set(7,spare);
 t.mock.timers.tick(501);
 await x.tick(false);
 assert.deepEqual(x.calls,["LaunchDrones","CmdMineRepeatedly"]);
 assert.equal(x.out.get(7)?.activity,"mining");
});

test("a drone order reuses a fresh Miner observation instead of reading a second grid",async()=>{
 const x=pendingFlight();
 x.out.set(8,{itemID:8,typeID:101,activity:"mining",targetID:77});
 x.bay.set(9,{itemID:9,typeID:102,quantity:1});
 x.observeMiningGrid(true);
 await x.tick(true,true);
 assert.equal(x.snapshotReads(),0);
 assert.deepEqual(x.calls,["CmdReturnBay"]);
});

test("a reachable NPC is engaged after a delayed combat drone type lookup with the mining flight at cap",async()=>{
 const x=pendingFlight();
 x.out.set(8,{itemID:8,typeID:101,activity:"mining",targetID:77});
 x.bay.set(9,{itemID:9,typeID:102,quantity:1});
 x.showCombatType(false);
 const meters=500;
 await x.tick(meters);
 assert.equal(x.reads(),1);
 assert.deepEqual(x.calls,[]);

 x.showCombatType(true);
 await x.tick(meters);
 await x.tick(meters);
 assert.deepEqual(x.calls,["CmdReturnBay","LaunchDrones","CmdEngage"]);
 assert.equal(x.out.get(9)?.targetID,90);
 assert.equal(x.out.get(9)?.activity,"fighting");
 assert.equal(x.out.has(8),false);

 await x.tick(false);
 await x.tick(false);
 assert.deepEqual(x.calls.slice(3),["CmdReturnBay","LaunchDrones","CmdMineRepeatedly"]);
 assert.equal([...x.out.values()][0]?.typeID,101);
 assert.equal([...x.out.values()][0]?.targetID,77);
});

test("a launch-limit timeout keeps the original Dogma request in flight",async t=>{
 t.mock.timers.enable({apis:["Date","setTimeout"]});
 const x=pendingFlight();x.out.clear();
 const pending=x.hold("QueryAllAttributesForItem"),first=x.tick(false);
 await pending.started;t.mock.timers.tick(12001);
 await assert.rejects(first,/observation timed out|launch capacity is temporarily unavailable/);
 const next=x.tick(false);
 try{
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(x.limitReads(),1);
  assert.deepEqual(x.calls,[]);
 }finally{pending.release();await next;}
 assert.equal(x.out.get(7)?.activity,"mining");
});

test("a timed-out drone grid refresh stays shared until the original read returns",async t=>{
 t.mock.timers.enable({apis:["Date","setTimeout"]});
 const x=pendingFlight();
 const pending=x.hold("Snapshot"),first=x.tick(false,true);
 await pending.started;
 t.mock.timers.tick(8001);
 await assert.rejects(first,/observation timed out/);

 const next=x.tick(false,true);
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(x.snapshotReads(),1);
 pending.release();
 await next;
 assert.equal(x.snapshotReads(),1);
});

test("a timed-out drone control range read is not queued again on the next pass",async t=>{
 t.mock.timers.enable({apis:["Date","setTimeout"]});
 const x=pendingFlight(2);
 x.out.set(8,{itemID:8,typeID:101,activity:"idle",targetID:null});
 const pending=x.hold("Range"),first=x.tick(false);
 await pending.started;
 t.mock.timers.tick(8001);
 await assert.rejects(first,/observation timed out/);

 const next=x.tick(false);
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(x.rangeReads(),1);
 pending.release();
 await next;
 assert.deepEqual(x.calls,["CmdMineRepeatedly"]);
});

test("an uncertain Recall is not replayed and a new grid can release it",async()=>{
 const x=pendingFlight();x.failNext("CmdReturnBay");
 await assert.rejects(x.tick(false),/Bridge response lost/);
 await x.tick(false);
 assert.deepEqual(x.calls,["CmdReturnBay"]);
 assert.equal(x.reads(),0);
 x.out.delete(8);
 x.bay.set(8,{itemID:8,typeID:102,quantity:1});
 await x.tick(false);
 assert.deepEqual(x.calls,["CmdReturnBay","LaunchDrones","CmdMineRepeatedly"]);
 assert.equal(x.out.get(7)?.activity,"mining");
});

test("combat drones launch on the first grid after Recall using the prepared bay and limits",async t=>{
 t.mock.timers.enable({apis:["Date"]});
 const x=pendingFlight();
 x.deferRecall();
 x.out.set(8,{itemID:8,typeID:101,activity:"mining",targetID:77});
 x.bay.set(9,{itemID:9,typeID:102,quantity:1});
 const limits=x.hold("QueryAllAttributesForItem");
 const first=x.tick(true);
 try{
  await Promise.race([limits.started,first.then(()=>assert.fail("The limit read must start during Recall"))]);
  await first;
  assert.deepEqual(x.calls,["CmdReturnBay"]);
  t.mock.timers.tick(2500);
  await x.tick(true); // The old sample still shows the full mining flight.
  assert.deepEqual(x.calls,["CmdReturnBay"],"Recall acknowledgement does not free launch slots or reissue the command");
 }finally{limits.release();}
 await new Promise<void>(resolve=>setImmediate(resolve));
 t.mock.timers.tick(15_500);
 x.returnDrone(8);
 const observedAt=performance.now();
 await x.tick(true);
 const since=(action:string)=>(x.sentAt.get(action)!-observedAt).toFixed(2);
 t.diagnostic(`Returned flight on grid → LaunchDrones +${since("LaunchDrones")} ms / CmdEngage +${since("CmdEngage")} ms`);
 assert.equal(x.reads(),1);
 assert.equal(x.invalidations(),1);
 assert.equal(x.limitReads(),1);
 assert.deepEqual(x.calls,["CmdReturnBay","LaunchDrones","CmdEngage"]);
 assert.equal(x.out.get(9)?.activity,"fighting");
 assert.equal(x.out.get(9)?.targetID,90);
 assert.equal(x.snapshotReads(),0);
 await x.tick(false);
 assert.equal(x.calls.at(-1),"CmdReturnBay");
 t.mock.timers.tick(1000);
 x.returnDrone(9);
 await x.tick(false);
 assert.deepEqual(x.calls.slice(3),["CmdReturnBay","LaunchDrones","CmdMineRepeatedly"]);
 assert.equal([...x.out.values()][0]?.typeID,101);
});

test("an uncertain launch from the prepared bay is checked against current combat stacks before retrying",async t=>{
 t.mock.timers.enable({apis:["Date"]});
 const x=pendingFlight();
 x.deferRecall();
 x.out.set(8,{itemID:8,typeID:101,activity:"mining",targetID:77});
 x.bay.set(9,{itemID:9,typeID:102,quantity:1});
 await x.tick(true);
 t.mock.timers.tick(1000);
 x.returnDrone(8);
 x.failNext("LaunchDrones");
 await assert.rejects(x.tick(true),/Bridge response lost/);
 assert.equal(x.reads(),1);

 t.mock.timers.tick(1000);
 await x.tick(true);
 assert.equal(x.reads(),2);
 assert.deepEqual(x.calls,["CmdReturnBay","LaunchDrones","LaunchDrones","CmdEngage"]);
 assert.equal(x.out.get(9)?.targetID,90);
});

test("a new mining grid received during Recall is used within the same combat pass",async t=>{
 t.mock.timers.enable({apis:["Date"]});
 const x=pendingFlight();
 x.deferRecall();
 x.out.set(8,{itemID:8,typeID:101,activity:"returning",targetID:null});
 x.bay.set(9,{itemID:9,typeID:102,quantity:1});
 await x.tick(true); // Identify the combat flight in the bay before Recall.
 x.out.get(8)!.activity="mining";
 const recall=x.hold("CmdReturnBay"),pass=x.tick(true);
 await recall.started;
 x.returnDrone(8);
 t.mock.timers.tick(1000);
 x.observeMiningGrid(true);
 recall.release();
 await pass;
 assert.deepEqual(x.calls,["CmdReturnBay","LaunchDrones","CmdEngage"]);
 assert.equal(x.snapshotReads(),0);
});

test("an uncertain combat Recall does not block a separate mining drone",async()=>{
 const x=pendingFlight(2);
 x.bay.delete(7);
 x.out.set(7,{itemID:7,typeID:101,activity:"idle",targetID:null});
 x.failNext("CmdReturnBay");
 await assert.rejects(x.tick(false),/Bridge response lost/);
 await x.tick(false);
 assert.deepEqual(x.calls,["CmdReturnBay","CmdMineRepeatedly"]);
 assert.equal(x.out.get(7)?.targetID,77);
 assert.equal(x.out.get(8)?.activity,"idle");
});

test("a target moving from 43 km to 200 km releases the mining flight and can engage again on return",async()=>{
 const x=pendingFlight(1,220_000);
 await x.tick(43_000);
 assert.deepEqual(x.calls,["CmdEngage"]);
 assert.equal(x.out.get(8)?.targetID,90);

 await x.tick(200_000);
 await x.tick(200_000);
 assert.deepEqual(x.calls,["CmdEngage","CmdReturnBay","LaunchDrones","CmdMineRepeatedly"]);
 assert.equal(x.out.get(7)?.targetID,77);
 assert.equal(x.flight.combat,false);

 await x.tick(43_000);
 await x.tick(43_000);
 assert.deepEqual(x.calls.slice(4),["CmdReturnBay","LaunchDrones","CmdEngage"]);
 assert.equal(x.out.get(8)?.targetID,90);
});

test("a visible hostile inside the escort area but outside native control range releases combat drones",async()=>{
 const x=pendingFlight(1,50_000);
 await x.tick(43_000);
 await x.tick(60_000);
 await x.tick(60_000);
 assert.deepEqual(x.calls,["CmdEngage","CmdReturnBay","LaunchDrones","CmdMineRepeatedly"]);
 assert.equal(x.out.get(7)?.activity,"mining");
 assert.equal(x.flight.combat,false);
});

test("a confirmed range refusal requires a newer grid and leaves a stationary target ineligible",async t=>{
 t.mock.timers.enable({apis:["Date","setTimeout"]});
 const x=pendingFlight(1,50_000);
 x.refuseNextEngageForRange();
 await assert.rejects(x.tick(43_000),/out of drone control range/);

 x.setNativeGrid(43_000,Date.now());
 await assert.rejects(x.tick(43_000),/grid is temporarily unreadable/);
 assert.equal(x.snapshotReads(),1);
 assert.deepEqual(x.calls,["CmdEngage"]);

 t.mock.timers.tick(1);
 await x.tick(43_000);
 await x.tick(43_000);
 t.mock.timers.tick(6000);
 await x.tick(43_000);
 assert.deepEqual(x.calls,["CmdEngage","CmdReturnBay","LaunchDrones","CmdMineRepeatedly"]);
 assert.equal(x.rangeReads(),2);
 assert.equal(x.out.get(7)?.activity,"mining");

 await x.tick(40_000);
 await x.tick(40_000);
 assert.deepEqual(x.calls.slice(4),["CmdReturnBay","LaunchDrones","CmdEngage"]);
 assert.equal(x.out.get(8)?.targetID,90);
});

test("a range refusal on the first target allows a different reachable target on the next grid",async t=>{
 t.mock.timers.enable({apis:["Date","setTimeout"]});
 const x=pendingFlight(1,50_000);
 x.refuseNextEngageForRange();
 await assert.rejects(x.tick(43_000),/out of drone control range/);

 t.mock.timers.tick(1);
 x.addSecondHostile(45_000);
 await x.tick(43_000);
 assert.deepEqual(x.calls,["CmdEngage","CmdEngage"]);
 assert.equal(x.out.get(8)?.targetID,91);
 assert.equal(x.flight.combat,true);
});

test("combat drones do not get an Engage order when the target leaves control range during Launch",async t=>{
 let now=1000;t.mock.method(performance,"now",()=>now);
 const x=pendingFlight(1,50_000);
 x.out.clear();x.bay.set(8,{itemID:8,typeID:102,quantity:1});
 const launch=x.hold("LaunchDrones"),work=x.tick(43_000);
 await launch.started;
 now+=2000;x.observeMiningGrid(60_000);launch.release();
 await work;
 assert.deepEqual(x.calls,["LaunchDrones"]);
 assert.equal(x.out.get(8)?.targetID,null);
 assert.equal(x.snapshotReads(),0);
 await x.tick(60_000);
 await x.tick(60_000);
 assert.deepEqual(x.calls,["LaunchDrones","CmdReturnBay","LaunchDrones","CmdMineRepeatedly"]);
});

test("a missing control range observation does not clear the combat flight",async t=>{
 t.mock.timers.enable({apis:["Date","setTimeout"]});
 const x=pendingFlight(1,50_000);
 await x.tick(43_000);
 t.mock.timers.tick(15_001);
 x.setControlRange(null);
 await assert.rejects(x.tick(60_000),/drone control range is unavailable/);
 assert.deepEqual(x.calls,["CmdEngage"]);
 assert.equal(x.flight.combat,true);
 assert.equal(x.out.get(8)?.targetID,90);

 x.setControlRange(50_000);
 await x.tick(60_000);
 assert.deepEqual(x.calls,["CmdEngage","CmdReturnBay"]);
});

test("miner drones use native engagement range and return to mining when clear",async t=>{
  t.mock.timers.enable({apis:["Date","setTimeout"]});
  const calls:string[]=[],bay=new Map([[7,{itemID:7,typeID:101,quantity:1}],[8,{itemID:8,typeID:102,quantity:1}]]);
  const out=new Map<number,{itemID:number;typeID:number;controlled:true;activity:string;targetID:number|null}>();
  let refuseLaunch=false,refuseEngage=false,rangeReads=0;
  let gridRefreshes=0,dronePanels=0;
  const run={characterID:1,baseUrl:"http://fixture",fetch:async(input:unknown)=>{
    const route=new URL(String(input)).pathname;
    if(route==="/api/bridge/space/snapshot"){
      gridRefreshes++;
      return Response.json({ok:true,space:grid(false)});
    }
    assert.equal(route,"/api/bridge/drones");
    dronePanels++;
    return Response.json({ok:true,activeShipID:11,bay:[...bay.values()],
      inSpace:[...out.values()],errors:{bay:null,inSpace:null,shipInfo:null}});
  }} as any;
  const session={store:{names:{get:()=>({resolved:{"typeGroup:101":"Mining Drone","typeGroup:102":"Combat Drone"}})},fitting:{get:()=>({})}},flow:{requestOptions:()=>({}),flying:{
    resolveNamesNow:async()=>{},resolveDroneControlRange:async()=>{rangeReads++;return 16000;},withPilotDroneCap:()=>({maxActiveDrones:5}),
    attributesOfTypes:async()=>({101:{1272:5},102:{1272:5}}),
    bridgeAsk:async(_service:string,method:string)=>{
      if(method==="List"){dronePanels++;return {type:"list",items:[...bay.values()].map(d=>({...d,quantity:Math.abs(d.quantity),ownerID:1,locationID:11,flagID:87,categoryID:18}))};}
      assert.equal(method,"QueryAllAttributesForItem");
      return {type:"dict",entries:[[352,1],[1271,5]]};
    },
    bridgeDo:async(_service:string,method:string,args:any[])=>{
      if(method==="InvalidateLocationCache")return null;
      calls.push(method);
      assert.notEqual(method,"AddTarget");
      if(method==="LaunchDrones"){
        const [[id]]=args[0],d=bay.get(id)!;
        if(refuseLaunch){refuseLaunch=false;throw Object.assign(Error("Launch refused"),{code:"CALL_REFUSED",status:409});}
        bay.delete(id);
        out.set(id,{itemID:id,typeID:d.typeID,controlled:true,activity:"idle",targetID:null});
        return {type:"dict",entries:[[id,{type:"list",items:[id]}]]};
      }
      if(method==="CmdReturnBay"){
        for(const id of args[0]){const d=out.get(id)!;out.delete(id);bay.set(id,{itemID:id,typeID:d.typeID,quantity:-1});}
      }
      if(method==="CmdEngage"&&refuseEngage){refuseEngage=false;throw Object.assign(Error("Engage refused"),{code:"CALL_REFUSED",status:409});}
      if(method==="CmdMineRepeatedly"||method==="CmdEngage")for(const id of args[0]){
        const d=out.get(id)!;d.activity=method==="CmdEngage"?"fighting":"mining";d.targetID=args[1];
      }
      return {type:"dict",entries:[]};
    },
  }}} as any;
  const grid=(hostile:boolean,meters=300)=>{
    const entities:NonNullable<Parameters<typeof decodeSpaceSnapshot>[0]>[]=[
      ...[...out.values()].map(d=>({itemID:d.itemID,typeID:d.typeID,kind:"drone",ownerID:1,controllerID:11,
        droneActivity:d.activity,targetEntityID:d.targetID,position:{x:0,y:0,z:0},radius:1})),
      {itemID:77,kind:"asteroid",position:{x:200,y:0,z:0},radius:1},
      {itemID:91,kind:"ship",categoryID:11,isNpc:true,npcEntityType:"concord",targetEntityID:11,
        position:{x:100,y:0,z:0},radius:1},
      ...(hostile?[{itemID:90,kind:"ship",categoryID:11,isNpc:true,npcEntityType:"npc",
        position:{x:meters,y:0,z:0},radius:1}]:[]),
    ];
    return {stateValid:true,inSpace:true,shipID:11,solarSystemID:300,sampledAtMs:Date.now(),
      ship:{itemID:11,characterID:1,mode:"STOP",position:{x:0,y:0,z:0},radius:1},entities};
  };
  const scene=(hostile:boolean,meters=300)=>decodeSpaceSnapshot(grid(hostile,meters));
  const flight=createMinerDroneFlight(run,session,11,()=>{},()=>{},()=>{});
  const work=async(attacking:boolean,meters=300)=>{
    const s=scene(attacking,meters);
    try{return await flight.tick(s,flight.observeThreat(s),s.entities.find(e=>e.itemID===77)!);}
    finally{
      await new Promise<void>(resolve=>setImmediate(resolve));
      t.mock.timers.tick(1000);
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
  };
  assert.equal(await flight.observeThreat(scene(false)),null);
  const selected=await flight.observeThreat(scene(true));
  assert.equal(selected?.itemID,90);
  assert.equal(selected?.targetEntityID,null);
  await work(false);
  assert.deepEqual(calls,["LaunchDrones","CmdMineRepeatedly"]);
  const miningRangeReads=rangeReads;
  assert.equal(flight.observeThreat(scene(true,25000))?.itemID,90);
  await work(true,25000);
  assert.deepEqual(calls,["LaunchDrones","CmdMineRepeatedly"]);
  assert.equal(rangeReads,miningRangeReads);
  const recallStart=calls.length;
  await work(true,12000);
  assert.deepEqual(calls.slice(recallStart),["CmdReturnBay"]);
  assert.ok(bay.has(7));
  refuseLaunch=true;
  await assert.rejects(work(true,12000),/Launch refused/);
  t.mock.timers.tick(6000);
  const launchStart=calls.length;
  refuseEngage=true;
  await assert.rejects(work(true,12000),/Engage refused/);
  assert.ok(out.has(8));
  assert.deepEqual(calls.slice(launchStart),["LaunchDrones","CmdEngage"]);
  await work(true,12000);
  assert.equal(calls.filter(x=>x==="CmdEngage").length,1);
  assert.equal(out.get(8)?.targetID,null);
  t.mock.timers.tick(6000);
  await work(true,12000);
  assert.equal(out.get(8)?.targetID,90);
  assert.equal(calls.filter(x=>x==="AddTarget").length,0);
  const clearStart=calls.length,readsBeforeClear=dronePanels;
  await flight.tick({...scene(false),stateValid:false},null,null);
  assert.equal(flight.combat,true);
  assert.ok(out.has(8));
  assert.equal(calls.length,clearStart);
  await work(false);
  assert.deepEqual(calls.slice(clearStart),["CmdReturnBay"]);
  await work(false);
  assert.deepEqual(calls.slice(clearStart),["CmdReturnBay","LaunchDrones","CmdMineRepeatedly"]);
  assert.equal(dronePanels-readsBeforeClear,1);
  assert.equal(gridRefreshes,0);
  assert.equal(out.get(7)?.targetID,77);
  assert.equal(flight.combat,false);
  const stale=scene(true),beforeStale=calls.length;
  await flight.tick(stale,flight.observeThreat(stale),stale.entities.find(e=>e.itemID===77)!,performance.now()-2000);
  assert.equal(gridRefreshes,1);
  assert.equal(calls.length,beforeStale);
  assert.equal(out.get(7)?.targetID,77);
  const recalls=calls.filter(x=>x==="CmdReturnBay").length;
  bay.delete(8);
  for(let i=0;i<5;i++)await work(true);
  assert.equal(out.get(7)?.activity,"mining");
  assert.equal(calls.filter(x=>x==="CmdReturnBay").length,recalls);
  assert.equal(flight.combat,false);
});
