import assert from "node:assert/strict";
import {mkdtempSync, renameSync, rmSync} from "node:fs";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import type {BackendRequest, PluginRunContext} from "../../../web/src/plugin-api/backend.ts";
import {createUocBackend} from "../backend.ts";
import {createDistributionHost} from "../distribution/host.ts";
import {miningCycleDocument} from "../miningFleet/miningCycle.ts";
import {createMiningFleetRuntime, type FleetSetup} from "../miningFleet/runtime.ts";
import {preparationEvidenceKey,readPreparationEvidence} from "../operations/miningEvidence.ts";
import {trainingDocument} from "../training/hr.ts";
import {uocStore} from "../backendStores.ts";
import {pilotServiceOwner,registerRun} from "../runControl.ts";
import type {DistributionView} from "../logistics/store.ts";

const account={accountID:1,username:"fixture"};
const request:BackendRequest={method:"GET",path:"/",params:{},query:{},account,body:null};
const character={characterID:3,characterName:"Carrier",corporationID:77,solarSystemID:300,stationID:null,structureID:null};
const setup:FleetSetup={operationID:"fixture",operationRunID:"epoch",systemID:300,destinationID:600,corporationID:77,
  division:1,beltID:99,beltName:"Belt",canCapacityM3:100,
  members:[{characterID:1,shipID:11,role:"MINER"},{characterID:2,shipID:12,role:"HAULER"}]};
const held={characterID:3,character,station:null} as PluginRunContext["held"];
const baseRun:PluginRunContext={botID:"fixture",characterID:3,setup:{},resumed:false,resumeData:null,held,routeSettings:null,
  baseUrl:"http://fixture.invalid",fetch:async()=>assert.fail("unexpected fixture request"),report(){}};
const ok=(data:object)=>Response.json({ok:true,...data});

function temporaryBackendData(t:TestContext,cleanup:()=>void|Promise<void>) {
  const directory=mkdtempSync(path.join(tmpdir(),"uoc-backend-lifecycle-"));
  const saved=process.env.EVEJS_PLUGIN_DATA_DIR;
  process.env.EVEJS_PLUGIN_DATA_DIR=directory;
  t.after(async()=>{
    try { await cleanup(); }
    finally {
      if(saved===undefined)delete process.env.EVEJS_PLUGIN_DATA_DIR;else process.env.EVEJS_PLUGIN_DATA_DIR=saved;
      rmSync(directory,{recursive:true,force:true});
    }
  });

  return directory;
}

test("UOC cleanup drains the idle carrier and MCC timers, closes SQLite and reopens the same records",async t=>{
  let backend=createUocBackend();
  const directory=temporaryBackendData(t,()=>backend.cleanup());

  // Observe actual better-sqlite3 handles, including connections opened only for one read.
  type Connection={name:string;open:boolean};
  const sql=createRequire(import.meta.url)("better-sqlite3");
  const prepareSQL=sql.prototype.prepare;
  const connections=new Set<Connection>();
  t.mock.method(sql.prototype,"prepare",function(this:Connection,...args:unknown[]){
    connections.add(this);return Reflect.apply(prepareSQL,this,args);
  });
  const writers=()=>[...connections].filter(db=>db.open).map(db=>path.basename(db.name)).sort();
  const intervals=new Set<ReturnType<typeof setInterval>>();
  const interval=setInterval,clear=clearInterval;
  t.mock.method(globalThis,"setInterval",(...args:Parameters<typeof setInterval>)=>{
    const id=interval(...args);intervals.add(id);return id;
  });
  t.mock.method(globalThis,"clearInterval",(id:ReturnType<typeof setInterval>)=>{intervals.delete(id);clear(id);});
  const waits=new Set<ReturnType<typeof setTimeout>>();
  const timeout=setTimeout,clearWait=clearTimeout;
  t.mock.method(globalThis,"setTimeout",(...args:Parameters<typeof setTimeout>)=>{
    const id=timeout(...args);if(args[1]===3000)waits.add(id);return id;
  });
  t.mock.method(globalThis,"clearTimeout",(id:ReturnType<typeof setTimeout>)=>{waits.delete(id);clearWait(id);});

  const route=(name:string,body:unknown=null)=>backend.routes[name]!({...request,body});
  const world=(await route("GET /world")).body as {worldID:string};
  const profile={pilot:{accountName:"fixture",characterID:3,characterName:"Carrier"},mode:"mining",runtime:60,
    maxJumps:3,searchJumps:3,limit:1,policy:"COUNT",automatic:true,corporationID:null,agent:null,level:1,fallback:false,parking:{mode:"NEAREST"}};
  assert.equal((await route("POST /civilian/profiles",profile)).status,undefined);
  const profiles=(await route("GET /civilian/profiles")).body;
  assert.equal((await route("POST /logistics/roster",{characterID:3,name:"Carrier",account:"fixture",shipName:"Hauler",corporationID:77,corporationName:"Test corp"})).status,undefined);
  const roster=(await route("GET /logistics")).body as DistributionView;
  assert.equal(roster.roster[0]?.account,undefined);
  assert.equal((await route("GET /mining-operations")).status,undefined);
  const cycle=miningCycleDocument(3,setup);cycle.write({fixture:"existing cycle"});
  trainingDocument("funding:3").write({fixture:"existing funding"});
  readPreparationEvidence(world.worldID,setup.operationID,setup.operationRunID,3);

  const prepSetup={operationID:setup.operationID,operationRunID:setup.operationRunID,role:"MINER",reviewOnly:true,
    verifyEquipment:true,preparation:{source:{kind:"hangar"},suppliesRequired:false}};
  const prepare=async (characterID:number)=>backend.runs!["mcc-prepare"]!.start({
    ...baseRun,characterID,held:{...held,characterID},setup:prepSetup,
    fetch:async input=>{assert.ok(String(input).endsWith("/api/plugins/uoc/world"));return ok(world);}
  });
  const prepared=await Promise.all([prepare(1),prepare(2)]);
  await Promise.all(prepared.map(handle=>handle.stop()));
  assert.equal([...connections].filter(db=>path.basename(db.name)==="mining-preparation.sqlite").length,1);

  // An unsuccessful Courier attachment still opens its fence on the same file as the roster.
  const courier=createDistributionHost({attachPilot:async()=>{throw Error("Fixture refused attachment");}});
  const courierRun:PluginRunContext={...baseRun,botID:"courier",setup:{agent:{mode:"manual",agentID:9,stationID:600},maxJumps:10,missionCount:1}};
  await assert.rejects(courier.attach(courierRun,{} as Parameters<typeof courier.attach>[1]),/Fixture refused attachment/);
  assert.equal(writers().filter(file=>file==="distribution.sqlite").length,1);

  const mission=uocStore("missions.sqlite").document("native-mining:3");
  mission.write({version:1,characterID:3,completed:true,pending:null,history:[]});
  const checkpoint=await backend.runs!["civilian-checkpoint"]!.start({...courierRun,held,setup:{},report(){}});
  await checkpoint.stop();
  assert.equal([...connections].filter(db=>db.open&&db.name.endsWith("missions.sqlite")).length,1);
  const databases=["distribution.sqlite","mining-fleet.sqlite","mining-fleet-cycles.sqlite","mining-preparation.sqlite",
    "missions.sqlite","restored-mining-definitions.sqlite","training-onboarding.sqlite"].sort();
  assert.deepEqual(writers(),databases);

  let calls=0,idled=false,streamClosed=false,completedReadsAborted=0;
  const run:PluginRunContext={characterID:3,botID:"idle-carrier",held,routeSettings:null,setup:{characterID:3},
    baseUrl:"http://fixture.invalid",resumed:false,resumeData:null,report(report){if(report.phase==="Idle")idled=true;},
    async fetch(input,init){
      calls++;
      const url=new URL(String(input));
      if(new Headers(init?.headers).get("accept")==="text/event-stream")
        return new Response(new ReadableStream({cancel(){streamClosed=true;}}),{headers:{"content-type":"text/event-stream"}});
      if(url.pathname==="/api/pilot-training/characters")return ok({account:"fixture",characters:[character]});
      if(url.pathname==="/api/plugins/uoc/world"){
        init?.signal?.addEventListener("abort",()=>{completedReadsAborted++;},{once:true});
        return ok(world);
      }
      if(url.pathname==="/api/bridge/flight/status")return ok({flight:{shipID:13,shipTypeID:100,solarSystemID:300,inSpace:true,docked:false}});
      if(url.pathname==="/api/bridge/call"){const {service,method}=JSON.parse(String(init?.body));return ok({service,method,result:null});}
      return ok({});
    }};
  const carrier=backend.runs!["distribution-carrier"]!;
  await assert.rejects(Promise.resolve(carrier.start({...run,fetch:async input=>{
    const path=new URL(String(input)).pathname;
    if(path==="/api/pilot-training/characters")return ok({account:"other",characters:[{characterID:7}]});
    assert.equal(path,"/api/plugins/uoc/world");return ok(world);
  }})),/account identity could not be verified/);
  assert.deepEqual((await route("GET /logistics")).body,roster);
  const driver=await carrier.start(run);
  await new Promise<void>(r=>setImmediate(r));
  assert.ok(idled);assert.ok(waits.size>0,"idle carrier is waiting for its next pass");
  const runtime=createMiningFleetRuntime({createCycle:async()=>assert.fail("no pilot"),settle:async()=>assert.fail("no pilot")});
  const group=runtime.getOrCreate(setup);
  const fleetBefore=group.op.snapshot();
  assert.ok(intervals.size>=2,"MCC tick and heartbeat are active");

  await Promise.all([backend.cleanup(),backend.cleanup()]);
  assert.deepEqual(writers(),[]);assert.equal(intervals.size,0);assert.equal(waits.size,0);
  assert.ok(streamClosed,"the carrier's held event stream was released");
  assert.equal(completedReadsAborted,0,"cleanup only cancels outstanding hosted reads");
  await driver.stop(); // A late host runStop is idempotent.
  assert.equal((await route("GET /logistics")).status,503);
  const lastCall=calls;await new Promise<void>(r=>setImmediate(r));assert.equal(calls,lastCall);
  // On Windows an open database or WAL would prevent renaming it in the same process.
  const file=path.join(directory,"mining-fleet.sqlite");
  renameSync(file,file+".closed");renameSync(file+".closed",file);

  backend=createUocBackend();
  assert.deepEqual((await route("GET /civilian/profiles")).body,profiles);
  assert.deepEqual((await route("GET /logistics")).body,{
    ...roster,roster:roster.roster.map(row=>({...row,account:"fixture"})),
  });
  await route("GET /mining-operations");
  const restarted=createMiningFleetRuntime({createCycle:async()=>assert.fail(),settle:async()=>assert.fail()});
  assert.deepEqual(restarted.operationSnapshot(setup.operationID,setup.operationRunID),fleetBefore);
  assert.deepEqual(trainingDocument("funding:3").read(),{fixture:"existing funding"});
  assert.deepEqual(miningCycleDocument(3,setup).read(),{fixture:"existing cycle"});
  assert.deepEqual(uocStore("missions.sqlite").document("native-mining:3").read(),{version:1,characterID:3,completed:true,pending:null,history:[]});
  const secondGroup=restarted.getOrCreate(setup,true);
  await runtime.shutdown(); // An obsolete reference cannot retire the new generation.
  assert.ok(intervals.size>=2);
  assert.equal(restarted.getOrCreate(setup,true),secondGroup);
  const second=await backend.runs!["distribution-carrier"]!.start({...run,botID:"new-carrier"});
  await second.stop();await backend.cleanup();assert.deepEqual(writers(),[]);assert.equal(waits.size,0);assert.equal(intervals.size,0);
});

test("cleanup cancels a carrier still acquiring its scope before it can open storage or start a timer",async()=>{
  const backend=createUocBackend();
  let entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const run:PluginRunContext={...baseRun,setup:{characterID:3},
    fetch:async(_input,init)=>{
      entered();
      const signal=init!.signal!;
      return new Promise<Response>((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));
    }};
  const starting=backend.runs!["distribution-carrier"]!.start(run);
  await started;
  await Promise.all([assert.rejects(Promise.resolve(starting),/backend has stopped/),backend.cleanup()]);
});

test("shutting down during a Civilian Mining read preserves the original mission checkpoint",async t=>{
  const backend=createUocBackend();
  temporaryBackendData(t,()=>backend.cleanup());
  let ready!:()=>void;
  const inFlight=new Promise<void>(resolve=>{ready=resolve;});
  const doc=uocStore("missions.sqlite").document("native-mining:3");
  const missionSetup={agent:{mode:"manual",agentID:9},missionCount:1};
  const run:PluginRunContext={...baseRun,setup:missionSetup,async fetch(input,init){
    const url=new URL(String(input));
    if(url.pathname==="/api/plugins/uoc/world")return ok({worldID:"fixture"});
    if(url.pathname==="/api/pilot-training/characters")return ok({account:"fixture",characters:[character]});
    if(url.pathname==="/api/bots")return ok({bots:[{...character,botID:baseRun.botID,expiresAt:new Date(Date.now()+3600000).toISOString()}]});
    if(url.pathname==="/api/bridge/flight/status"){
      const signal=init!.signal!;
      return new Response(new ReadableStream({start(body){
        ready();signal.addEventListener("abort",()=>body.error(signal.reason),{once:true});
      }}));
    }
    if(new Headers(init?.headers).get("accept")==="text/event-stream")
      return new Response(new ReadableStream(),{headers:{"content-type":"text/event-stream"}});
    if(url.pathname==="/api/bridge/call"){const {service,method}=JSON.parse(String(init?.body));return ok({service,method,result:null});}
    return ok({});
  }};
  const {rolloverMiningState}=await import("../mining/history.ts");
  const {createHash}=await import("node:crypto");
  const key=createHash("sha256").update(JSON.stringify(missionSetup)).digest("hex");
  const initial=rolloverMiningState(null,null,3,key);
  doc.write(initial);
  await backend.runs!["civilian-mining"]!.start(run);
  await inFlight;
  const before=doc.read();
  await backend.cleanup();
  const reopened=createUocBackend();
  try{assert.deepEqual(uocStore("missions.sqlite").document("native-mining:3").read(),before);}
  finally{await reopened.cleanup();}
});

test("cleanup during open reads preserves the saved Distribution trip and MCC preparation evidence",async t=>{
  let backend=createUocBackend();
  temporaryBackendData(t,()=>backend.cleanup());
  const {worldID}=(await backend.routes["GET /world"]!(request)).body as {worldID:string};
  const tripKey="routes:"+worldID, evidenceKey=preparationEvidenceKey(worldID,"fixture","epoch",3);
  const original={
    roster:[{characterID:3,name:"Carrier",verifiedAccount:"fixture"}],operations:[],
    trips:[{operationID:"delivery",executionID:"previous",characterID:3,shipID:13,
      cargo:[{itemID:9,typeID:10,quantity:60,bay:"cargo",singleton:false}],pending:null,issue:"Awaiting destination",delivered:false}]
  };
  const evidence={version:1,world:worldID,botID:"previous",readout:{equipment:"VERIFIED",observedAt:12}};
  uocStore("distribution.sqlite").document(tripKey).write(original);
  uocStore("mining-preparation.sqlite").document(evidenceKey).write(evidence);
  let readingFlight!:()=>void,readingFit!:()=>void;
  const flight=new Promise<void>(r=>{readingFlight=r;}),fit=new Promise<void>(r=>{readingFit=r;});
  const fetch:PluginRunContext["fetch"]=async(input,init)=>{
    const url=new URL(String(input));
    if(url.pathname==="/api/plugins/uoc/world")return ok({worldID});
    if(url.pathname==="/api/pilot-training/characters")return ok({account:"fixture",characters:[character]});
    if(url.pathname==="/api/bridge/flight/status"||url.pathname==="/api/bridge/provisioning/options"){
      if(url.pathname.endsWith("status"))readingFlight();else readingFit();
      const signal=init!.signal!;
      return new Promise<Response>((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));
    }
    if(new Headers(init?.headers).get("accept")==="text/event-stream")
      return new Response(new ReadableStream(),{headers:{"content-type":"text/event-stream"}});
    if(url.pathname==="/api/bridge/call"){const {service,method}=JSON.parse(String(init?.body));return ok({service,method,result:null});}
    return ok({});
  };
  await Promise.all([
    backend.runs!["distribution-carrier"]!.start({...baseRun,botID:"carrier",setup:{characterID:3},fetch}),
    backend.runs!["mcc-prepare"]!.start({...baseRun,botID:"prepare",fetch,setup:{operationID:"fixture",operationRunID:"epoch",
      role:"MINER",reviewOnly:true,preparation:{source:{kind:"hangar"},fittingID:2,suppliesRequired:false}}}),
    flight,fit,
  ]);
  await backend.cleanup();
  backend=createUocBackend();
  assert.deepEqual([
    uocStore("distribution.sqlite").document(tripKey).read(),
    uocStore("mining-preparation.sqlite").document(evidenceKey).read()
  ],[original,evidence]);
});

test("cleanup drains Training started by an owner-service route without stopping the parent pilot",async t=>{
  const backend=createUocBackend();
  let entered!:()=>void,aborted=false,parentStops=0;
  const reading=new Promise<void>(resolve=>{entered=resolve;});
  const run:PluginRunContext={...baseRun,async fetch(input,init){
    if(String(input).endsWith("/world"))return ok({worldID:"fixture-world"});
    entered();
    return new Promise<Response>((_,reject)=>init!.signal!.addEventListener("abort",()=>{
      aborted=true;reject(init!.signal!.reason);
    },{once:true}));
  }};
  const unregister=registerRun(run,account.username,()=>{parentStops++;});
  t.after(unregister);
  const req={...request,worldID:"fixture-world",params:{characterID:"3"},body:{kind:"inspect",setup:{}}};
  assert.equal((await backend.routes["POST /training/:characterID/service"]!(req)).status,202);
  await reading;await backend.cleanup();
  assert.ok(aborted);assert.equal(parentStops,0);
  assert.ok(pilotServiceOwner(3,account.username));
});
