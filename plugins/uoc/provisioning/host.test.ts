import {mkdtempSync,unlinkSync,rmdirSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {createRequire} from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createProvisioningRun,reviewedPlanFingerprint} from "./host.ts";
import type {ResourceQualification} from "./resourceQualification.ts";
const tuples=[[20,27,1],[30,87,2]],fingerprint=createHash("sha256").update(JSON.stringify([100,tuples])).digest("hex");
const setup={corporationID:98,fittingID:5,goalTypeID:100,fingerprint,division:1};
const physical=(applied=false,ship=9,stockID=1000)=>({reviewID:"review",reviewHash:"hash",expiresAt:Date.now()+30000,canApply:true,fittingService:"AVAILABLE",
 context:{characterID:7,corporationID:98,shipID:applied?55:ship,shipTypeID:applied?100:101,locationID:600},contract:{shipTypeID:100,structural:[[27,20,1]],equipment:[[27,20,1],[87,30,2]],definition:{characterID:7,corporationID:98,fittingID:5,fingerprint}},
 plan:{targetHullTypeID:100,targetHullID:null,hullQuantity:applied?0:1,hullSourceItemID:applied?null:stockID,requirements:[],supplies:[],optionalSavedCargo:[],shortages:[],unsupported:[],destructiveActions:[],mode:applied?"ALREADY_SATISFIED":"NEW_HULL"},
 source:{pin:{descriptor:{kind:"corp",corporationID:98,division:1},ownerID:98,locationID:800,flag:4,office:"corpOffice:800",dockedLocationID:600},access:{query:true,take:true},
 rows:[{itemID:stockID,typeID:100,ownerID:98,locationID:800,flagID:4,quantity:1,singleton:false}]},status:{equipment:applied?"VERIFIED":"MODIFIED"}});

type ShipStorageFixture = {requestedDivision:number;outcome?:"declined"|"lost"|"wrong-item"|"wrong-fit"|"no-office"};
function fixture({lost=false,lostAfterCommit=false,badReceipt=false,ambiguous=false,wrongFit=false,missing=false,offline=false,personal=false,provider=false,largeStock=false,division=1,shortage=false,nativeRefusal,hullName="Test Hull",fittingService="AVAILABLE",shipStorage,existing=false,resources={state:"SIMULATED",characterID:7,shipTypeID:100,cpu:{used:20,total:100},powergrid:{used:10,total:50},fits:true,source:"PILOT_BRAIN_CLIENT_SIMULATION"}}: {lost?:boolean;lostAfterCommit?:boolean;badReceipt?:boolean;ambiguous?:boolean;wrongFit?:boolean;missing?:boolean;offline?:boolean;personal?:boolean;provider?:boolean;largeStock?:boolean;division?:number;shortage?:boolean;nativeRefusal?:string;hullName?:string;fittingService?:"AVAILABLE"|"UNAVAILABLE"|null;shipStorage?:ShipStorageFixture;existing?:boolean;resources?:ResourceQualification}={}){
 const makePhysical=(applied=false,ship=9,stockID=1000)=>{const r=physical(applied,ship,stockID);
  r.source.pin.descriptor.division=division;
  r.source.pin.flag=114+division;
  r.source.rows[0]!.flagID=r.source.pin.flag;
  Object.assign(r.plan,{targetHullName:hullName});
  if(wrongFit)r.contract.definition.fingerprint="c".repeat(64);
  if(shortage){r.canApply=false;Object.assign(r.plan,{requirements:[{typeID:20,name:"Module",flag:27,kind:"FITTED",quantity:1}],shortages:["Module x1"]});}
  if(nativeRefusal){r.canApply=false;Object.assign(r.plan,{unsupported:[nativeRefusal]});}
  if(largeStock){r.source.rows.push(...Array.from({length:900},(_,i)=>({...r.source.rows[0]!,itemID:10000+i,quantity:3})));(r.plan as any).hullCandidates=Array.from({length:200},(_,i)=>({itemID:20000+i,typeID:100,name:"Assembled ship"}));}if(provider){r.contract.definition.characterID=8;r.contract.definition.corporationID=99;}if(personal){r.source.pin={descriptor:{kind:"hangar"} as any,ownerID:7,locationID:600,flag:4,office:null as any,dockedLocationID:600};r.source.rows=r.source.rows.map(x=>({...x,ownerID:7,locationID:600,flagID:4}));}
  if(existing)Object.assign(r.plan,{requirements:[{flag:27,typeID:20,quantity:1,kind:"FITTED"},{flag:87,typeID:30,quantity:2,kind:"LOADED"}]});
  return {...r,fittingService:fittingService??undefined};
 };
 let applied=false,moved=false,ship=9,stockID=1000,newModuleID=200,selectedPlan=reviewedPlanFingerprint(makePhysical());
 const reports:any[]=[],writes:string[]=[],rechecked:string[]=[],reviews:any[]=[],transfers:any[]=[];
 const row=(fields:Record<string,number>)=>({type:"packedrow",fields:{quantity:-1,singleton:1,stacksize:1,...fields}});
 const oldHull=()=>row({itemID:ship,typeID:101,categoryID:6,ownerID:moved?98:7,locationID:moved?800:600,flagID:moved?114+shipStorage!.requestedDivision:4});
 const oldFit=(itemID:number)=>row({itemID,typeID:itemID===201?20:21,categoryID:7,locationID:ship,
  ownerID:moved&&!(shipStorage?.outcome==="wrong-fit"&&itemID===202)?98:7,flagID:itemID===201?27:92});
 const existingHull=()=>row({itemID:55,typeID:100,categoryID:6,ownerID:7,locationID:600,flagID:4});
 const existingFit=()=>[row({itemID:newModuleID,typeID:20,categoryID:7,ownerID:7,locationID:55,flagID:27}),
  row({itemID:301,typeID:30,categoryID:18,ownerID:7,locationID:55,flagID:87,quantity:2,stacksize:2,singleton:0})];
 const fetcher=async(url:any,init:any)=>{const u=new URL(String(url)),body=init?.body?JSON.parse(init.body):null;let data:any;
  if(u.pathname==="/api/bridge/call"){
   const dict=(entries:any[])=>({type:"dict",entries}),long=(value:string)=>({type:"long",value});
   if(body.method==="ItemGetInfo"){
    if(body.args[0]===55)data={result:{type:"object",name:"util.KeyVal",args:dict([["itemID",55],["invItem",{type:"packedrow",fields:{itemID:55,typeID:100,ownerID:7}}],["time",long("134385165369180001")],["wallclockTime",long("134385165369179999")],["attributes",dict([[49,20],[48,100],[15,10],[11,50]])]])}};
    else {assert.equal(body.args[0],200);const effect=[200,7,55,null,null,[],16,long("134385165369120001"),-1,1];data={result:{type:"object",name:"util.KeyVal",args:dict([["itemID",200],["invItem",{type:"packedrow",fields:{itemID:200,typeID:20,ownerID:7,locationID:55,flagID:27}}],["activeEffects",dict(offline?[]:[[16,effect]])],["time",long("134385165369180001")],["wallclockTime",long("134385165369179999")]])}};}
   }else if(body.method==="GetMyCorporationsOffices"){
    data={result:{list:shipStorage?.outcome==="no-office"?[]:[row({officeID:800,stationID:600})]}};
   }else if(body.method==="InvalidateLocationCache"){
    assert.equal(body.confirm,true);
    data={result:null};
   }else if(body.method==="GetSelfInvItem"){
    assert.ok(applied||existing&&body.of===55);
    data={result:body.of===55?existingHull():body.of===ship?oldHull():oldFit(body.of)};
   }else if(body.method==="Board"){
    assert.ok(existing);
    assert.deepEqual(body.args,[55,ship]);
    assert.equal(body.confirm,true);
    writes.push("Board");applied=true;data={result:null};
   }else if(body.method==="List"){
    if(body.of==="hangar")data={result:{type:"list",items:existing?[existingHull()]:[]}};
    else if(existing&&body.of===55)data={result:{type:"list",items:existingFit()}};
    else if(body.of===ship&&applied)data={result:{type:"list",items:[oldFit(201),oldFit(202)]}};
    else{
     assert.equal(applied,true);
     assert.equal(body.of,800);
     assert.deepEqual(body.args,[114+shipStorage!.requestedDivision]);
     const decoy=row({itemID:91,typeID:101,categoryID:6,ownerID:98,locationID:800,flagID:body.args[0]});
     data={result:{type:"list",items:[decoy,...(moved?[oldHull()]:[])]}};
    }
   }else throw Error("Unexpected bridge method "+body.method);
  }
  else if(u.pathname==="/api/bridge/fitting")data={activeShipID:55,slots:{type:"list",items:[{type:"packedrow",fields:{itemID:200,typeID:20,groupID:54,categoryID:7,flagID:27,quantity:1,singleton:1}}]},shipInfo:{type:"dict",entries:[[55,{type:"object",name:"util.KeyVal",args:{type:"dict",entries:[["itemID",55],["attributes",{type:"dict",entries:[[14,1],[13,0],[12,0],[1137,0]]}]]}}]]},online:{type:"list",items:[200]},errors:{slots:null,shipInfo:null,online:null,chargeFits:null},chargeFits:null};
  else if(u.pathname==="/api/client-data/type-prices")data={available:true,categoryID:{100:6,20:7,30:18},published:{100:true}};
  else if(u.pathname==="/api/client-data/required-skills")data={available:true,required:{100:{10:1},20:{},30:{},10:{}}};
  else if(u.pathname==="/api/bridge/skills")data={skills:{characterID:7,skills:missing?[]:[{typeID:10,level:1}]}};
  else if(u.pathname==="/api/bridge/flight/status")data={flight:{docked:true,stationID:600,shipID:applied?55:ship}};
  else if(u.pathname==="/api/bridge/provisioning/ship-review"){assert.equal(body.source.kind,personal?"hangar":"corp");if(!personal)assert.equal(body.source.division,division);assert.equal(body.oldShipDivision,undefined);reviews.push(body);data=makePhysical(applied,ship,stockID);}
  else if(u.pathname==="/api/bridge/provisioning/reconcile"){assert.deepEqual(body,{operationID:"review"});rechecked.push(body.operationID);if(lost)throw Error("Receipt temporarily unavailable");data=applied?{operationID:"review",state:"COMPLETE",result:{equipment:"VERIFIED"},manifest:{targetHullID:55,originalShipID:badReceipt?10:9}}:{operationID:"review",state:"BLOCKED",reason:"OUTCOME_AMBIGUOUS",manifest:{originalShipID:9}};}
  else if(u.pathname==="/api/bridge/provisioning/provision-ship"){writes.push(u.pathname);assert.deepEqual(body,{reviewID:"review",reviewHash:"hash",confirm:true});if(lost)throw Error("response lost");if(ambiguous)return Response.json({ok:true,operationID:"review",state:"BLOCKED",reason:"OUTCOME_AMBIGUOUS",manifest:{originalShipID:9}});applied=true;if(lostAfterCommit)throw Error("response lost after commit");data={operationID:"review",state:"COMPLETE",result:{equipment:"VERIFIED"},manifest:{targetHullID:55,originalShipID:9}};}
  else if(u.pathname==="/api/bridge/inventory/transfer"){
   assert.equal(applied,true);
   transfers.push(body);
   assert.deepEqual(body,{itemIDs:[ship],from:{kind:"hangar"},to:{kind:"corp",division:shipStorage?.requestedDivision}});
   if(shipStorage?.outcome==="declined")data={applied:false,moved:[],declined:[ship]};
   else if(shipStorage?.outcome==="wrong-item")data={applied:true,moved:[91],declined:[]};
   else{
    moved=true;
    if(shipStorage?.outcome==="lost")throw Error("transfer response lost");
    data={applied:true,moved:[ship],declined:[]};
   }
  }
  else throw Error(`Unexpected ${u.pathname}`);
  return Response.json({ok:true,...data});};
 const run:any={characterID:7,held:{characterID:7},setup,baseUrl:"http://test",fetch:fetcher,report:(r:any)=>reports.push(r)};
 async function execute(mode:"inspect"|"apply"){
  reports.length=0;
  const selected=provider?{...setup,division,corporationID:99,providerCharacterID:8,sourceCorporationID:98,sourceKind:"hangar"}:personal?{...setup,division,sourceKind:"hangar"}:{...setup,division};
  const input={...selected,...(shipStorage?.requestedDivision?{oldShipDivision:shipStorage.requestedDivision}:{})};
  run.setup=mode==="inspect"?input:{...input,reviewedPlanFingerprint:selectedPlan};
  await createProvisioningRun(mode,{projection:async()=>resources}).start(run);
  for(let i=0;i<100&&(!reports.length||reports.at(-1).status==="running");i++)await new Promise(r=>setTimeout(r,1));
  assert.ok(reports.length&&reports.at(-1).status!=="running");
  return reports.at(-1);
 }
 return {execute,writes,rechecked,reviews,transfers,reports,selectPlan:(v:string)=>selectedPlan=v,changeShip:()=>ship=10,changeStock:()=>stockID=1001,changeModule:()=>newModuleID=203};
}
test("inspection uses native exact fit and skill read, without applying",async()=>{const f=fixture(),r=await f.execute("inspect");assert.equal(r.phase,"Provisioning inspected");assert.equal(r.readout.canApply,true);assert.equal(r.readout.skills.resourceQualification,"NATIVE_FITTING_REQUIRED");assert.equal(r.readout.sourceRead.access.query,true);assert.equal(r.readout.sourceRead.rows[0].itemID,1000);assert.match(r.readout.reviewedPlanFingerprint,/^[a-f0-9]{64}$/);assert.deepEqual(f.writes,[]);});
test("applies one reviewed native operation and independently verifies the fitted new hull",async()=>{const f=fixture(),r=await f.execute("apply");assert.equal(r.phase,"Provisioning verified");assert.equal(r.readout.originalShipID,9);assert.equal(r.readout.shipID,55);assert.equal(r.readout.nativeResources.state,"NATIVE");assert.equal(r.readout.nativeResources.allModulesOnline,true);assert.deepEqual(r.readout.nativeResources.cpu,{used:20,total:100});assert.equal(f.writes.length,1);});

test("hosted Review and Apply board an exact assembled hull and store the old fitted ship in Division 7",async()=>{
 const f=fixture({existing:true,shipStorage:{requestedDivision:7}});
 const checked=await f.execute("inspect");
 assert.equal(checked.phase,"Provisioning inspected");
 assert.equal(checked.readout.plan.mode,"EXISTING_HULL");
 assert.equal(checked.readout.plan.targetHullID,55);
 assert.equal(checked.readout.canApply,true);
 f.selectPlan(checked.readout.reviewedPlanFingerprint);
 const result=await f.execute("apply");
 assert.equal(result.phase,"Provisioning verified");
 assert.equal(result.readout.shipID,55);
 assert.equal(result.readout.existingHull,true);
 assert.deepEqual(result.readout.previousShipStorage,{itemID:9,location:800,division:7,contentsCount:2});
 assert.deepEqual(f.writes,["Board"]);
 assert.equal(f.transfers.length,1);
});

test("a replaced fitted item invalidates Review before a hosted Apply dispatches anything",async()=>{
 const f=fixture({existing:true});
 const checked=await f.execute("inspect");
 f.selectPlan(checked.readout.reviewedPlanFingerprint);
 f.changeModule();
 const result=await f.execute("apply");
 assert.match(result.why,/ReviewChanged/);
 assert.deepEqual(f.writes,[]);
});

test("personal storage of the previous ship is independent from the corporate stock division",async()=>{
 const f=fixture({division:7}),inspection=await f.execute("inspect");
 assert.equal(inspection.readout.canApply,true);
 assert.equal(f.reviews[0].source.division,7);
 assert.equal(f.reviews[0].oldShipDivision,undefined);
 const applied=await f.execute("apply");
 assert.equal(applied.phase,"Provisioning verified");
 assert.equal(applied.readout.nativeReceipt.manifest.originalShipID,9);
 assert.equal(applied.readout.previousShipStorage,null);
 assert.deepEqual(f.transfers,[]);
 assert.equal(f.writes.length,1);
});

test("corporate storage cannot authorize Apply without a local office",async()=>{
 const f=fixture({shipStorage:{requestedDivision:7,outcome:"no-office"}});
 const inspection=await f.execute("inspect");
 assert.equal(inspection.readout.canApply,false);
 assert.match(inspection.readout.applyBlockers.join(" "),/no verified office at this dock/);
 const blocked=await f.execute("apply");
 assert.match(blocked.why,/no verified office at this dock/);
 assert.deepEqual(f.writes,[]);
 assert.deepEqual(f.transfers,[]);
});

test("the transfer never replays and storage completes only for the exact fitted old hull",async()=>{
 const exact={itemID:9,location:800,division:7,contentsCount:2};
 for(const outcome of [undefined,"lost","declined","wrong-item","wrong-fit"] as const){
  const f=fixture({shipStorage:{requestedDivision:7,outcome}});
  const inspection=await f.execute("inspect");
  assert.equal(inspection.readout.canApply,true);
  if(outcome===undefined){
   assert.match((await f.execute("apply")).why,/ReviewChanged/);
   assert.deepEqual(f.writes,[]);
  }
  f.selectPlan(inspection.readout.reviewedPlanFingerprint);
  const result=await f.execute("apply");
  assert.equal(f.writes.length,1);
  assert.deepEqual(f.transfers,[{itemIDs:[9],from:{kind:"hangar"},to:{kind:"corp",division:7}}]);
  assert.equal(f.reports[0].phase,"Storing previous ship");
  assert.equal(result.readout.shipID,55);
  assert.equal(result.readout.equipment,"VERIFIED");
  if(outcome===undefined||outcome==="lost"){
   assert.equal(result.phase,"Provisioning verified");
   assert.deepEqual(result.readout.previousShipStorage,exact);
   assert.equal(result.readout.previousShipStorageReason,null);
  }else{
   assert.equal(result.phase,"Previous ship storage incomplete");
   assert.match(result.why,outcome==="wrong-fit"?/Installed item #202 could not be verified/:/Previous ship #9 is still in the personal hangar/);
   assert.equal(result.readout.previousShipStorage,null);
   assert.equal(result.readout.previousShipStorageReason,result.why);
  }
 }
});
test("a lost Apply response fails without replaying the native mutation",async()=>{
 const f=fixture({lost:true});
 assert.match((await f.execute("apply")).why,/response lost/);
 assert.equal(f.writes.length,1);
});
test("changed fitting and missing skills block mutation",async()=>{const f=fixture({wrongFit:true});assert.match((await f.execute("apply")).why,/fitting definition differs/);assert.equal(f.writes.length,0);const g=fixture({missing:true});assert.match((await g.execute("apply")).why,/blocked/);assert.equal(g.writes.length,0);});

test("lost completion response reconciles in the same hosted Apply without another mutation",async()=>{
 const f=fixture({lostAfterCommit:true}),result=await f.execute("apply");
 assert.equal(result.phase,"Provisioning verified");
 assert.equal(result.readout.operationID,"review");
 assert.equal(f.writes.length,1);
});

test("reconciliation cannot verify a result for a different original hull",async()=>{
 const f=fixture({lostAfterCommit:true,badReceipt:true}),r=await f.execute("apply");
 assert.match(r.why,/receipt identity/);
 assert.equal(f.writes.length,1);
});

test("reacquired session uses stable reviewed plan despite changed review handles",async()=>{const f=fixture(),inspected=await f.execute("inspect");f.selectPlan(inspected.readout.reviewedPlanFingerprint);const r=await f.execute("apply");assert.equal(r.phase,"Provisioning verified");assert.equal(f.writes.length,1);});
test("changed current ship or source stock invalidates the reviewed physical plan",async()=>{for(const change of ["changeShip","changeStock"] as const){const f=fixture(),r=await f.execute("inspect");f.selectPlan(r.readout.reviewedPlanFingerprint);f[change]();const failed=await f.execute("apply");assert.match(failed.why,/ReviewChanged/);assert.equal(f.writes.length,0);}});
test("plan digest does not contain session-specific review data",()=>{const a=physical(),b={...physical(),reviewID:"different",reviewHash:"other",expiresAt:1,context:{...a.context,sessionGeneration:"new"}};assert.equal(reviewedPlanFingerprint(a),reviewedPlanFingerprint(b));});

for(const [label,cpu,powergrid] of [["CPU",{used:101,total:100},{used:10,total:50}],["powergrid",{used:20,total:100},{used:51,total:50}]] as const){
 test(`${label} shortage blocks native Apply`,async()=>{
  const resources:ResourceQualification={state:"SIMULATED",characterID:7,shipTypeID:100,cpu,powergrid,fits:false,source:"PILOT_BRAIN_CLIENT_SIMULATION"};
  const f=fixture({resources}),inspection=await f.execute("inspect");assert.equal(inspection.readout.canApply,false);assert.deepEqual(inspection.readout.resources,resources);
  const failed=await f.execute("apply");assert.match(failed.why,/blocked/);assert.equal(f.writes.length,0);
 });
}
test("unknown candidate remains visible and cannot authorize equipment mutation",async()=>{
 const resources:ResourceQualification={state:"UNKNOWN",reason:"Unsupported modifier"},f=fixture({resources}),inspection=await f.execute("inspect");
 assert.deepEqual(inspection.readout.resources,resources);assert.equal(inspection.readout.canApply,false);assert.equal("fits" in inspection.readout.resources,false);
 const result=await f.execute("apply");assert.match(result.why,/blocked/);assert.equal(f.writes.length,0);
});
test("native drone storage can block Apply without hiding verified candidate CPU/PG",async()=>{
 const reason="Native drone bay capacity is unavailable for the reviewed hull.";
 const resources:ResourceQualification={state:"SIMULATED",characterID:7,shipTypeID:100,cpu:{used:20,total:100},powergrid:{used:10,total:50},
  fits:true,source:"PILOT_BRAIN_CLIENT_SIMULATION",droneBay:{required:100,capacity:null,reason}};
 const f=fixture({resources}),inspection=await f.execute("inspect");
 assert.deepEqual(inspection.readout.resources,resources);
 assert.deepEqual(inspection.readout.applyBlockers,[reason]);
 assert.equal(inspection.readout.canApply,false);
 const failed=await f.execute("apply");
 assert.equal(failed.why,reason);
 assert.deepEqual(f.writes,[]);
});

test("an offline final module prevents a verified result after the native Apply",async()=>{
 const f=fixture({offline:true}),r=await f.execute("apply");
 assert.match(r.why,/online equipment/);
 assert.equal(f.writes.length,1);
});

test("personal hangar is pinned to exact pilot and dock and differs from corporation source",async()=>{const f=fixture({personal:true}),r=await f.execute("inspect");assert.equal(r.phase,"Provisioning inspected");assert.equal(r.readout.canApply,true);assert.notEqual(r.readout.reviewedPlanFingerprint,reviewedPlanFingerprint(physical()));assert.deepEqual(f.writes,[]);f.selectPlan(reviewedPlanFingerprint(physical()));const blocked=await f.execute("apply");assert.match(blocked.why,/ReviewChanged/);assert.equal(f.writes.length,0);});


test("same-account provider fitting is revalidated without impersonation and pilot corp stays separate",async()=>{const f=fixture({provider:true,personal:true}),result=await f.execute("inspect");assert.equal(result.phase,"Provisioning inspected");assert.equal(result.readout.corporationID,99);assert.equal(result.readout.canApply,true);assert.deepEqual(f.writes,[]);});

test("successful NPC-station review exposes fitting service",async()=>{const f=fixture(),r=await f.execute("inspect");assert.equal(r.phase,"Provisioning inspected");assert.equal(r.readout.fittingService,"AVAILABLE");});
test('inspect preserves the native review without claiming complete onboard rows',async()=>{const f=fixture(),r=await f.execute('inspect');assert.equal(r.readout.rawReview.reviewID,'review');assert.equal(r.readout.rawReview.context.shipID,9);assert.equal(r.readout.rawReview.observation,undefined);});

test("large division inventory is summarized without changing physical review or Apply",async()=>{
 const f=fixture({largeStock:true}),r=await f.execute("inspect");
 assert.equal(r.phase,"Provisioning inspected");
 assert.ok(Buffer.byteLength(JSON.stringify(r.readout))<16384);
 assert.equal(r.readout.sourceRead.rowCount,901);
 assert.equal(r.readout.sourceRead.quantities[100],2701);
 assert.equal(r.readout.sourceRead.packagedQuantity,2701);
 assert.equal(r.readout.plan.hullCandidateCount,200);
 assert.equal(r.readout.plan.hullCandidates.length,24);
 f.selectPlan(r.readout.reviewedPlanFingerprint);
 assert.equal((await f.execute("apply")).phase,"Provisioning verified");
 assert.equal(f.writes.length,1);
});

for (const {label,hullName,archiveScope} of [
 {label:"FixtureFight1 with Corp Omen T1",hullName:"Omen",archiveScope:{worldID:"current",owner:"current",characterID:41}},
 {label:"FixtureMiner1 with a saved Pioneer fit",hullName:"Pioneer",archiveScope:{worldID:"old-world",owner:"other-account",characterID:7}},
 {label:"same pilot after a prior Apply",hullName:"Omen",archiveScope:{worldID:"current",owner:"current",characterID:7}},
]) {
 test(label+" inspects live stock and applies Division 7 independently of the old archive",async()=>{
  const directory=mkdtempSync(path.join(tmpdir(),"uoc-provisioning-test-"));
  const file=path.join(directory,"provisioning.sqlite");
  const {createDocumentStore}=createRequire(import.meta.url)("../documentStore.cjs");
  const archive=createDocumentStore(file);
  const oldDirectory=process.env.EVEJS_PLUGIN_DATA_DIR;
  process.env.EVEJS_PLUGIN_DATA_DIR=directory;
  try {
   const doc=archive.document("pilot:7");
   const prior={version:1,characterID:archiveScope.characterID,ownerScope:archiveScope,
    phase:"APPLY_PENDING",reviewID:"unrelated-review",originalShipID:999};
   doc.write(prior);
   const f=fixture({division:7,hullName});
   const checked=await f.execute("inspect");
   assert.equal(checked.phase,"Provisioning inspected");
   assert.equal(checked.readout.shipID,9);
   assert.equal(checked.readout.plan.targetHullName,hullName);
   assert.equal(checked.readout.sourceRead.rows[0].itemID,1000);
   assert.equal(checked.readout.sourceRead.pin.flag,121);
   assert.equal(checked.readout.canApply,true);
   f.selectPlan(checked.readout.reviewedPlanFingerprint);
   const result=await f.execute("apply");
   assert.equal(result.phase,"Provisioning verified");
   assert.equal(result.readout.operationID,"review");
   assert.equal(f.writes.length,1);
   assert.ok(f.reviews.every(r=>r.source.division===7));
   assert.deepEqual(doc.read(),prior);
  } finally {
   if(oldDirectory===undefined)delete process.env.EVEJS_PLUGIN_DATA_DIR;
   else process.env.EVEJS_PLUGIN_DATA_DIR=oldDirectory;
   archive.close();
   unlinkSync(file);
   rmdirSync(directory);
  }
 });
}
test("missing stock is shown and an unresolved native plan still governs Apply",async()=>{
 for(const [fixtureOptions,field,reason] of [
  [{shortage:true},"shortages","Module x1"],
  [{nativeRefusal:"This pilot has unresolved custody."},"unsupported","This pilot has unresolved custody."],
 ] as const) {
  const f=fixture(fixtureOptions),checked=await f.execute("inspect");
  assert.equal(checked.phase,"Provisioning inspected");
  assert.equal(checked.readout.canApply,false);
  assert.deepEqual(checked.readout.plan[field],[reason]);
  assert.deepEqual(checked.readout.applyBlockers,[reason]);
  assert.equal((await f.execute("apply")).why,`Provisioning blocked: ${reason}`);
  assert.equal(f.writes.length,0);
 }
});

test("an omitted fitting-service status does not gate an authorized Apply",async()=>{
 const f=fixture({fittingService:null}),inspection=await f.execute("inspect");
 assert.equal(inspection.readout.fittingService,"UNKNOWN");
 assert.equal(inspection.readout.canApply,true);
 assert.deepEqual(inspection.readout.applyBlockers,[]);
 assert.equal((await f.execute("apply")).phase,"Provisioning verified");
 assert.equal(f.writes.length,1);
});

test("confirmed fitting-service denial blocks Apply",async()=>{
 const f=fixture({fittingService:"UNAVAILABLE"}),inspection=await f.execute("inspect");
 assert.equal(inspection.readout.canApply,false);
 assert.deepEqual(inspection.readout.applyBlockers,["Fitting service is unavailable at this dock."]);
 assert.match((await f.execute("apply")).why,/Fitting service is unavailable/);
 assert.deepEqual(f.writes,[]);
});

test("qualified resources do not override an authoritative WC Apply refusal",async()=>{
 const reason="Unsupported native fitting slot/type 92/21.";
 for(const hullName of ["Pioneer","Hauler (FixtureHauler)","Omen","Covetor"]){
  const f=fixture({hullName,division:7,nativeRefusal:reason,fittingService:null});
  const inspection=await f.execute("inspect");
  assert.equal(inspection.readout.plan.targetHullName,hullName);
  assert.equal(inspection.readout.resources.fits,true);
  assert.equal(inspection.readout.canApply,false);
  assert.deepEqual(inspection.readout.applyBlockers,[reason]);
  assert.equal((await f.execute("apply")).why,`Provisioning blocked: ${reason}`);
  assert.deepEqual(f.writes,[]);
 }
});

test("a native ambiguous Apply rechecks this operation once and reports the refusal without replay",async()=>{
 const f=fixture({ambiguous:true});
 const result=await f.execute("apply");
 assert.equal(result.phase,"Provisioning blocked");
 assert.equal(result.readout.nativeReason,"OUTCOME_AMBIGUOUS");
 assert.deepEqual(f.rechecked,["review"]);
 assert.equal(f.writes.length,1);
});
