"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMiningPreparation, readiness } = require("./miningPreparation");
const { createReplenishment } = require("./replenishment");
const { createStartupRuns } = require("./startupRuns");
const { buildContract, inspectContract, fail } = require("./provisioningContracts");
const { fittingFingerprint } = require("./pilotTrainingFittings");

// Only the authoritative world adapter is fake. Contract inspection, custody,
// restart reconciliation and durable logical-run fencing use production code.
function world(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcc-preparation-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = { getType: id => ({ 100:{categoryID:6},200:{categoryID:7},300:{categoryID:8},16272:{categoryID:4} })[id], getTypeName: id => `Type ${id}` };
  const fit = { fittingID:1,ownerID:900,shipTypeID:100,name:"Exact miner",savedDate:"123",items:[{typeID:200,flagID:27,quantity:1},{typeID:300,flagID:options.loadedQuantity != null?27:5,quantity:10}] };
  fit.fingerprint = fittingFingerprint(fit.shipTypeID,fit.items);
  const provider = { scope:"CORPORATION",corporationID:900,accountID:1,characterID:11 };
  const states = new Map([11,12].map(id => [id,{ generation:"owner-1",equipment:200,cargo:options.cargo ?? 0,loaded:options.loadedQuantity ?? 0 }]));
  let stock=options.stock ?? 30, secondStock=options.stock ?? 30, run="operation-run-1", now=1000, dispatches=0, reads=0;
  const bots=[];
  const source=options.personalSource?{kind:"hangar"}:{kind:"corp",corporationID:900,division:2};
  const policy={source,suppliesRequired:options.required === true,...(options.supplies ? {supplies:options.supplies} : {})};
  const definition={operationID:"operation-1",preparation:policy,members:[{characterID:11,accountName:"owned",role:"MINER"}],...(options.support ? {support:options.support} : {})};
  const contract = input => buildContract(fit,provider,data,input.supplyPolicy);
  const row=(id,typeID,ownerID,locationID,flagID,quantity,singleton=false)=>({itemID:id,typeID,ownerID,locationID,flagID,quantity,singleton});
  const separate=id=>options.splitSources && id===12;
  const sourceRows=id=>{
    const quantity=separate(id)?secondStock:stock;
    return quantity ? [row(separate(id)?801:800,300,options.personalSource?id:900,separate(id)?702:700,options.personalSource?4:116,quantity)] : [];
  };
  const destination=id=>states.get(id).cargo ? [row(9000+id,300,id,1000+id,5,states.get(id).cargo)] : [];
  const context=id=>({accountID:1,characterID:id,corporationID:900,locationID:600,shipID:1000+id,shipTypeID:100,sessionGeneration:states.get(id).generation,recoveryReady:true});
  const adapterFor=record=>{
    const id=record.characterID;
    return {
      context:async()=>context(id),
      read:async input=>{
        reads++;
        if (options.onRead) await options.onRead({id,reads,states,fit,setRun:value=>{run=value;}});
        const c=contract(input), rows=[row(5000+id,states.get(id).equipment,id,1000+id,27,1,true),...destination(id)];
        if(states.get(id).loaded) rows.push({...row(null,300,id,1000+id,27,states.get(id).loaded),loaded:true,identity:JSON.stringify([1000+id,27,300])});
        return {context:context(id),contract:c,contracts:[c],observation:{complete:options.selectedComplete !== false,shipTypeID:100,rows},target:{complete:true},source:{rows:sourceRows(id),access:{query:true,take:options.take ?? true},pin:{descriptor:source,ownerID:options.personalSource?id:900,locationID:separate(id)?702:700,flag:options.personalSource?4:116,dockedLocationID:600,office:options.personalSource?null:separate(id)?"corpOffice:703":"corpOffice:701"}}};
      },
      plan:async targets=>{
        const target=targets.find(t=>t.typeID===300 && t.deficit>0);
        const available=separate(id)?secondStock:stock;
        return target && available ? {itemID:separate(id)?801:800,typeID:300,quantity:Math.min(available,target.deficit),shipID:1000+id,flagID:5} : null;
      },
      validateMove:async()=>{},
      readMovement:async()=>{
        if (options.movementReadFailure?.(dispatches)) throw new Error("authoritative movement read unavailable");
        return {source:sourceRows(id),destination:destination(id)};
      },
      dispatch:async move=>{dispatches++;if(separate(id))secondStock-=move.quantity;else stock-=move.quantity;states.get(id).cargo+=move.quantity;if(options.onDispatch)await options.onDispatch({states,setRun:value=>{run=value;}});},
    };
  };
  const custodyFile=path.join(dir,"custody.json"),startupFile=path.join(dir,"startup.json");
  let engine, startup, preparation;
  function restart() {
    engine=createReplenishment({filePath:custodyFile,operations:new Map(),data,now:()=>now++});
    startup=createStartupRuns({filePath:startupFile,now:()=>now++});
    preparation=createMiningPreparation({store:{getAccount:async()=>({accountID:1}),getCharacterForAccount:async(_,id)=>states.has(id)},
      readReview:async(_,input)=>{
        const read=await adapterFor(input).read(input);
        const observed={...read.observation,complete:options.offlineComplete !== false,rows:read.observation.rows.map(r=>options.offlineLoadedReal && r.loaded?{...r,itemID:6000+input.characterID,loaded:false,identity:String(6000+input.characterID)}:r).concat(options.offlineRows || [])};
        const sourceStock=[...read.source.rows];
        if(options.offlineCurrentHull)sourceStock.push(row(read.context.shipID,100,options.personalSource?input.characterID:900,read.source.pin.locationID,read.source.pin.flag,1,true));
        if(options.offlineOtherHull)sourceStock.push(row(99001,100,options.personalSource?input.characterID:900,read.source.pin.locationID,read.source.pin.flag,1,true));
        return {selected:read.contract,status:inspectContract(read.contract,observed,data),pilot:{...read.context,quality:"COMPLETE",dockState:"DOCKED",observation:observed,control:{state:"FREE"},revision:"world-1"},
          candidateSource:{...source,quality:"COMPLETE",query:"ALLOWED",take:options.take===false?"DENIED":"ALLOWED",officeID:options.personalSource?null:separate(input.characterID)?703:701,contentsLocationID:separate(input.characterID)?702:700,dockedLocationID:600,flag:options.personalSource?4:116,rows:sourceStock}};
      },engine,adapterFor,bots:()=>bots,currentRun:()=>run,data,now:()=>now++,fault:options.fault});
  }
  function record(intent,resumed=false) {
    const value={accountID:1,characterID:intent.characterID,operationID:"operation-1",operationRunID:"operation-run-1",logicalRunID:`logical-${intent.characterID}`,operationPreparation:intent,
      assertPreparationCurrent:()=>{if(run!=="operation-run-1")fail("OPERATION_RUN_CHANGED");}};
    value.preparationCheckpoint=startup.openPreparation({...value,scriptHash:"script-1",scriptRev:1,intent,resumed,assertCurrent:value.assertPreparationCurrent});
    return value;
  }
  restart();
  return {definition,states,bots,record,restart,get preparation(){return preparation;},get engine(){return engine;},get startup(){return startup;},get dispatches(){return dispatches;},get stock(){return stock;},setStock:value=>{stock=value;},setRun:value=>{run=value;},fit};
}
async function accepted(w) { const plan=await w.preparation.plan(w.definition);assert.equal(plan.state,"READY");return plan.members[0].intent; }

test("zero deficit verifies once without apply, journal transfer or startup replay",async t=>{
  const w=world(t,{cargo:10}),r=w.record(await accepted(w));
  assert.equal((await w.preparation.prepare(r)).state,"VERIFIED");
  assert.equal(w.dispatches,0);assert.equal(w.engine.journal.list().length,0);
  r.preparationCheckpoint.enterMain();
  assert.equal((await w.preparation.prepare(r)).state,"VERIFIED");
  assert.equal(w.dispatches,0);assert.equal(w.startup.get(r.logicalRunID).preparation.invocation,1);
});
for(const required of [false,true]) test(`real replenishment partial stock is ${required?"BLOCKED required":"DEGRADED optional"}`,async t=>{
  const w=world(t,{stock:4,required}),r=w.record(await accepted(w)),result=await w.preparation.prepare(r);
  assert.equal(result.state,required?"BLOCKED":"DEGRADED");assert.equal(result.targets[0].current,4);assert.equal(result.targets[0].deficit,6);
  assert.equal(w.dispatches,1);assert.equal(w.stock,0);assert.equal(w.engine.journal.list()[0].state,"COMPLETE");
  if(required)assert.throws(()=>r.preparationCheckpoint.enterMain(),/must complete/);else r.preparationCheckpoint.enterMain();
});
test("deficit replenishes then proves final full equipment and supply observation",async t=>{
  const w=world(t,{cargo:3,stock:9,required:true}),r=w.record(await accepted(w));
  const result=await w.preparation.prepare(r);assert.equal(result.state,"VERIFIED");assert.equal(result.targets[0].current,10);
  assert.equal(w.stock,2);assert.equal(w.dispatches,1);assert.equal(w.engine.journal.list()[0].moves[0].state,"VERIFIED");
});
test("wrong equipment blocks read-only plan and mutation after accepted equipment drifts",async t=>{
  const w=world(t),intent=await accepted(w);w.states.get(11).equipment=300;
  assert.equal((await w.preparation.plan(w.definition)).state,"BLOCKED");
  assert.equal((await w.preparation.prepare(w.record(intent))).state,"BLOCKED");assert.equal(w.dispatches,0);
});
test("corporation Take refusal never falls back to personal stock",async t=>{
  const w=world(t,{take:false}),plan=await w.preparation.plan(w.definition);
  assert.equal(plan.state,"BLOCKED");assert.equal(plan.members[0].state,"BLOCKED");
  assert.equal(w.dispatches,0);assert.equal(w.stock,30);
});
test("Take authority drift is refused under final owner without transfer",async t=>{
  const options={take:true},w=world(t,options),intent=await accepted(w);options.take=false;
  assert.equal((await w.preparation.prepare(w.record(intent))).reason,"SOURCE_TAKE_DENIED");assert.equal(w.dispatches,0);
});
test("pending custody restart reconciles authoritative after-state without resend",async t=>{
  let unreadable=true;const w=world(t,{movementReadFailure:count=>unreadable && count>0}),intent=await accepted(w),r=w.record(intent);
  assert.equal((await w.preparation.prepare(r)).state,"RECOVERY_REQUIRED");assert.equal(w.dispatches,1);
  const custody=w.engine.unresolved(11)[0];assert.equal(custody.moves[0].state,"PENDING");
  unreadable=false;w.states.get(11).generation="owner-2";w.restart();
  const resumed=w.record(intent,true),result=await w.preparation.prepare(resumed);
  assert.equal(result.state,"VERIFIED");assert.equal(result.ownerGeneration,"owner-2");assert.equal(w.dispatches,1);
  assert.equal(w.engine.journal.get(custody.key).state,"RECONCILED");assert.equal(w.engine.unresolved(11).length,0);
});
test("unproven pending outcome stays recovery required after restart without resend",async t=>{
  let unreadable=true;const w=world(t,{movementReadFailure:count=>unreadable && count>0}),intent=await accepted(w);
  await w.preparation.prepare(w.record(intent));unreadable=false;w.states.get(11).cargo=0;w.restart();
  assert.equal((await w.preparation.prepare(w.record(intent,true))).state,"RECOVERY_REQUIRED");assert.equal(w.dispatches,1);
});
test("durable custody evidence before engine call fences restart even without a journal row",async t=>{
  let interrupt=true;const w=world(t,{fault:name=>{if(name==="BEFORE_REPLENISH" && interrupt)throw new Error("process interrupted");}}),intent=await accepted(w),r=w.record(intent);
  assert.equal((await w.preparation.prepare(r)).state,"BLOCKED");assert.equal(w.dispatches,0);
  assert.ok(w.startup.get(r.logicalRunID).preparation.evidence.custodyOperationID);assert.equal(w.engine.journal.list().length,0);
  interrupt=false;w.restart();const resumed=w.record(intent,true),result=await w.preparation.prepare(resumed);
  assert.equal(result.state,"DEGRADED");assert.equal(w.dispatches,0);assert.equal(w.startup.get(r.logicalRunID).preparation.invocation,1);
});
test("definition drift refuses final-owner preparation before dispatch",async t=>{
  const w=world(t),intent=await accepted(w);w.fit.savedDate="124";
  assert.equal((await w.preparation.prepare(w.record(intent))).reason,"REVIEW_STALE");assert.equal(w.dispatches,0);
});
test("unrelated source depletion refuses accepted stock pin",async t=>{
  const w=world(t),intent=await accepted(w);w.setStock(29);
  assert.equal((await w.preparation.prepare(w.record(intent))).reason,"SOURCE_CHANGED");assert.equal(w.dispatches,0);
});
for(const [change,reason] of [["source","SOURCE_CHANGED"],["cargo","REVIEW_STALE"]])
  test(`${change} drift after initial selected revalidation cannot become a newly accepted Review`,async t=>{
    let w;
    w=world(t,{onRead:({reads,states})=>{
      if(reads===3) {
        if(change==="source")w.setStock(29);
        else states.get(11).cargo=1;
      }
    }});
    const intent=await accepted(w),result=await w.preparation.prepare(w.record(intent));
    assert.equal(result.state,"BLOCKED");assert.equal(result.reason,reason);
    assert.equal(w.dispatches,0);assert.deepEqual(w.engine.journal.list(),[]);
    assert.equal(w.startup.get("logical-11").preparation.mainEntered,false);
  });
test("accepted source remains pinned through the shared Apply reads before its first dispatch",async t=>{
  let w;
  w=world(t,{onRead:({reads})=>{if(reads===4)w.setStock(29);}});
  const result=await w.preparation.prepare(w.record(await accepted(w)));
  assert.equal(result.state,"BLOCKED");assert.equal(result.reason,"SOURCE_CHANGED");
  assert.equal(w.dispatches,0);assert.deepEqual(w.engine.journal.list(),[]);
});
test("generation drift between read-only revalidation and review refuses dispatch",async t=>{
  let flip=false;const w=world(t,{onRead:({states})=>{if(flip){states.get(11).generation="changed";flip=false;}},fault:name=>{if(name==="REVALIDATED")flip=true;}}),r=w.record(await accepted(w));
  assert.equal((await w.preparation.prepare(r)).state,"BLOCKED");assert.equal(w.dispatches,0);
});
test("late old-run response cannot update durable checkpoint or enter MAIN",async t=>{
  let release,entered;const waiting=new Promise(resolve=>{entered=resolve;});
  let pause=false;const w=world(t,{onRead:async()=>{if(pause){pause=false;entered();await new Promise(resolve=>{release=resolve;});}}}),r=w.record(await accepted(w));
  pause=true;const pending=w.preparation.prepare(r);await waiting;w.setRun("operation-run-2");release();
  await assert.rejects(pending,/OPERATION_RUN_CHANGED/);assert.equal(w.dispatches,0);
  assert.equal(w.startup.get(r.logicalRunID).preparation.state,"PREPARING");assert.throws(()=>r.preparationCheckpoint.enterMain(),/OPERATION_RUN_CHANGED/);
});
test("own-run shared source depletion adjusts only verified sibling custody",async t=>{
  const w=world(t,{stock:15});w.definition.members.push({characterID:12,accountName:"owned",role:"MINER"});
  const plan=await w.preparation.plan(w.definition);assert.equal(plan.state,"READY");
  const first=w.record(plan.members[0].intent);const a=await w.preparation.prepare(first);assert.equal(a.state,"VERIFIED");
  w.bots.push({characterID:11,operationID:first.operationID,operationRunID:first.operationRunID,preparation:first.preparationCheckpoint.snapshot()});
  const second=w.record(plan.members[1].intent),b=await w.preparation.prepare(second);
  assert.equal(b.state,"DEGRADED");assert.equal(b.targets[0].current,5);assert.equal(w.dispatches,2);assert.equal(w.stock,0);
});
test("existing Core requirement makes Heavy Water critical only when requireCore",()=>{
  const status={equipment:"VERIFIED",supplies:"LOW",targets:[{typeID:16272,state:"LOW",required:true},{typeID:300,state:"FULL"}]};
  assert.equal(readiness(status,{suppliesRequired:true},{useIndustrialCore:true,coreRequirement:"continueWithoutCore"}).state,"DEGRADED");
  assert.equal(readiness(status,{suppliesRequired:false},{useIndustrialCore:true,coreRequirement:"requireCore"}).state,"BLOCKED");
  assert.equal(readiness({...status,targets:[]},{},{useIndustrialCore:true,coreRequirement:"continueWithoutCore"}).state,"BLOCKED");
});
test("required Core fuel keeps its effective required label when Take denial blocks preflight",async t=>{
  const w=world(t,{take:false,cargo:10,supplies:[{typeID:16272,target:100,mode:"TOTAL_ABOARD",eligibleFlags:[5],required:false}],
    support:{characterID:11,useIndustrialCore:true,coreRequirement:"requireCore"}});
  const plan=await w.preparation.plan(w.definition);
  assert.equal(plan.state,"BLOCKED");assert.equal(plan.members[0].state,"BLOCKED");
  assert.equal(plan.members[0].reason,"SOURCE_TAKE_DENIED");
  assert.equal(plan.members[0].targets.find(target=>target.typeID===16272).required,true);
  assert.equal(w.dispatches,0);
});
for(const coreRequirement of ["continueWithoutCore","requireCore"])test(`real shared engine keeps existing ${coreRequirement} fuel criticality`,async t=>{
  const w=world(t,{cargo:10,supplies:[{typeID:16272,target:100,mode:"TOTAL_ABOARD",eligibleFlags:[5],required:true}],support:{characterID:11,useIndustrialCore:true,coreRequirement}});
  const result=await w.preparation.prepare(w.record(await accepted(w)));
  assert.equal(result.state,coreRequirement==="requireCore"?"BLOCKED":"DEGRADED");
  assert.equal(result.targets.find(target=>target.typeID===16272).deficit,100);assert.equal(w.dispatches,0);
});
test("same corporation division at distinct physical offices does not adjust another inventory",async t=>{
  const w=world(t,{splitSources:true});w.definition.members.push({characterID:12,accountName:"owned",role:"MINER"});
  const plan=await w.preparation.plan(w.definition),first=w.record(plan.members[0].intent);
  assert.equal((await w.preparation.prepare(first)).state,"VERIFIED");
  w.bots.push({characterID:11,operationID:first.operationID,operationRunID:first.operationRunID,preparation:first.preparationCheckpoint.snapshot()});
  assert.equal((await w.preparation.prepare(w.record(plan.members[1].intent))).state,"VERIFIED");assert.equal(w.dispatches,2);
});
test("offline unrelated ore and other excluded holds do not create false selected-observation drift",async t=>{
  const w=world(t,{cargo:10,offlineRows:[
    {itemID:7001,typeID:16272,ownerID:11,locationID:1011,flagID:134,quantity:42,singleton:false},
    {itemID:7002,typeID:16272,ownerID:11,locationID:1011,flagID:146,quantity:7,singleton:false},
  ]}),intent=await accepted(w);
  const result=await w.preparation.prepare(w.record(intent));
  assert.equal(result.state,"VERIFIED");assert.equal(result.targets[0].current,10);assert.equal(w.dispatches,0);
});
test("loaded charges with offline real IDs and selected virtual identities have equal semantic quantities",async t=>{
  const w=world(t,{loadedQuantity:10,offlineLoadedReal:true}),intent=await accepted(w),result=await w.preparation.prepare(w.record(intent));
  assert.equal(result.state,"VERIFIED");assert.equal(result.targets[0].current,10);assert.equal(w.dispatches,0);
});
test("loaded charge quantity drift still refuses accepted observation without replenishment",async t=>{
  const w=world(t,{loadedQuantity:10,offlineLoadedReal:true}),intent=await accepted(w);w.states.get(11).loaded=9;
  assert.equal((await w.preparation.prepare(w.record(intent))).reason,"REVIEW_STALE");assert.equal(w.dispatches,0);
});
test("incomplete offline observation is refused even when equipment rows look exact",async t=>{
  const w=world(t,{cargo:10,offlineComplete:false});assert.equal((await w.preparation.plan(w.definition)).state,"BLOCKED");assert.equal(w.dispatches,0);
});
test("incomplete selected observation stays refused rather than becoming normalized complete",async t=>{
  const options={cargo:10},w=world(t,options),intent=await accepted(w);options.selectedComplete=false;
  assert.equal((await w.preparation.prepare(w.record(intent))).reason,"REVIEW_STALE");assert.equal(w.dispatches,0);
});
test("current held hull appearing only in offline personal hangar is not consumable-source drift",async t=>{
  const w=world(t,{cargo:10,personalSource:true,offlineCurrentHull:true}),intent=await accepted(w);
  assert.equal((await w.preparation.prepare(w.record(intent))).state,"VERIFIED");assert.equal(w.dispatches,0);
});
test("another hull disappearing from physical source remains genuine stock drift",async t=>{
  const w=world(t,{cargo:10,personalSource:true,offlineOtherHull:true}),intent=await accepted(w);
  assert.equal((await w.preparation.prepare(w.record(intent))).reason,"SOURCE_CHANGED");assert.equal(w.dispatches,0);
});
test("personal-source custody restart also excludes offline active hull before movement-pin adjustment",async t=>{
  let unreadable=true;const w=world(t,{personalSource:true,offlineCurrentHull:true,movementReadFailure:count=>unreadable && count>0}),intent=await accepted(w);
  assert.equal((await w.preparation.prepare(w.record(intent))).state,"RECOVERY_REQUIRED");assert.equal(w.dispatches,1);
  unreadable=false;w.restart();assert.equal((await w.preparation.prepare(w.record(intent,true))).state,"VERIFIED");assert.equal(w.dispatches,1);
});
test("global required supplies project saved-fitting targets as required in preflight and final facts",async t=>{
  const w=world(t,{required:true,stock:0}),plan=await w.preparation.plan(w.definition);
  assert.equal(plan.members[0].targets[0].required,true);
  const result=await w.preparation.prepare(w.record(plan.members[0].intent));
  assert.equal(result.state,"BLOCKED");assert.equal(result.targets[0].required,true);assert.equal(w.dispatches,0);
  assert.equal(result.finalReview.targets[0].required,false,"raw shared fitting policy stays distinct from effective MCC criticality");
});
for(const scenario of [
  {coreRequirement:"continueWithoutCore",globalRequired:true,rawRequired:true,effectiveRequired:false,state:"DEGRADED"},
  {coreRequirement:"requireCore",globalRequired:false,rawRequired:false,effectiveRequired:true,state:"BLOCKED"},
])test(`Core ${scenario.coreRequirement} projects effective Heavy Water criticality`,async t=>{
  const w=world(t,{cargo:10,required:scenario.globalRequired,supplies:[{typeID:16272,target:100,mode:"TOTAL_ABOARD",eligibleFlags:[5],required:scenario.rawRequired}],
    support:{characterID:11,useIndustrialCore:true,coreRequirement:scenario.coreRequirement}}),plan=await w.preparation.plan(w.definition);
  assert.equal(plan.members[0].targets.find(target=>target.typeID===16272).required,scenario.effectiveRequired);
  const result=await w.preparation.prepare(w.record(plan.members[0].intent));
  assert.equal(result.state,scenario.state);assert.equal(result.targets.find(target=>target.typeID===16272).required,scenario.effectiveRequired);
  assert.equal(result.finalReview.targets.find(target=>target.typeID===16272).required,scenario.rawRequired);assert.equal(w.dispatches,0);
});
