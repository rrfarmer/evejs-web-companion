"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createProvisioningCenterApply } = require("./provisioningCenterApply");
const { createFactorySessions } = require("./factorySessions");
const { createReplenishment } = require("./replenishment");
const { buildContract, hash, inspectContract } = require("./provisioningContracts");
const { fittingFingerprint } = require("./pilotTrainingFittings");
function fixture(t, corp = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-center-apply-"));
  t.after(() => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true }); });
  const filePath = path.join(dir,"control.json"), custody = path.join(dir,"custody.json"), account = { accountID:7 }, operations = new Map(), heldSessions = new Map();
  const data = { getType:id=>({categoryID:id===2?7:id===3?8:6,groupID:25}),getTypeName:id=>`Type ${id}` };
  const items = [{typeID:2,flagID:27,quantity:1},{typeID:3,flagID:5,quantity:5}];
  const fitting = { fittingID:4,ownerID:20,shipTypeID:1,name:"Exact",savedDate:"100",items,fingerprint:fittingFingerprint(1,items) };
  const provider = {scope:"CORPORATION",accountID:7,characterID:11,corporationID:20};
  const contract = buildContract(fitting,provider,data);
  const item=(itemID,typeID,quantity,locationID=corp?601:600,flagID=corp?115:4,singleton=false,ownerID=corp?20:11)=>({itemID,identity:String(itemID),typeID,quantity,locationID,flagID,singleton,ownerID,loaded:false});
  const world={context:{accountID:7,characterID:11,corporationID:20,locationID:600,shipID:50,shipTypeID:99,recoveryReady:true,sessionGeneration:null},
    online:false, selections:0,releases:0,mutations:[],source:[item(70,1,3),item(80,2,3),item(90,3,3)],
    hangar:[item(50,99,1,600,4,true,11)],fitted:[],serial:100,access:{query:true,take:true},contract,
    selectionRace:false,releaseUncertain:false,statusUncertain:false,acquired:null};
  if(!corp)world.hangar.push(...world.source);
  const input={characterID:11,providerCharacterID:11,corporationID:20,fittingID:4,source:corp?{kind:"corp",corporationID:20,division:1}:{kind:"hangar"}};
  const sourcePin={descriptor:input.source,ownerID:corp?20:11,locationID:corp?601:600,flag:corp?115:4,office:corp?"corpOffice:273":null,dockedLocationID:600};
  const source=()=>corp?world.source:world.hangar;
  const offline=async()=>({pilot:{...world.context,accountID:7,name:"QA",quality:"COMPLETE",dockState:"DOCKED",revision:"read-revision",control:{state:world.online?"BUSY":"FREE"},
    observation:{complete:true,shipTypeID:world.context.shipTypeID,rows:structuredClone(world.fitted)}},selected:world.contract,
    status:inspectContract(world.contract,{complete:true,shipTypeID:world.context.shipTypeID,rows:world.fitted},data),
    candidateSource:{kind:input.source.kind,quality:"COMPLETE",query:"ALLOWED",corporationID:corp?20:null,division:corp?1:null,
      officeID:corp?273:null,contentsLocationID:corp?601:600,dockedLocationID:600,flag:corp?115:4,rows:structuredClone(source())},evidence:{stable:true}});
  const gateway={
    async getCharacterStatus(){if(world.statusUncertain)throw new Error("read unavailable");return{characterID:11,online:world.online,controlState:world.online?"browser_pilot":"offline"};},
    async selectFactoryCharacter(){assert.equal(Object.values(JSON.parse(fs.readFileSync(filePath)).records).at(-1).state,"ACQUIRING_CONTROL");
      world.selections++;if(world.online||world.selectionRace){world.online=true;throw Object.assign(new Error("busy/no takeover"),{code:"PILOT_BUSY"});}
      world.online=true;world.context.sessionGeneration=hash(["private-session",null]);
      return{bridgeSessionID:"private-session",session:{characterID:11,shipID:world.context.shipID,stationID:600,corporationID:20}};},
    async releaseBridgeSession(){assert.equal(Object.values(JSON.parse(fs.readFileSync(filePath)).records).at(-1).state,"RELEASING");world.releases++;world.online=false;
      if(world.releaseUncertain){world.statusUncertain=true;throw Object.assign(new Error("response lost"),{code:"TIMEOUT"});}return{released:true,offline:true};}
  };
  const store={listCharactersForAccount:async()=>[{characterID:11}]},botHost={claimedBy:()=>null};
  const adapter={context:async()=>structuredClone(world.context),
    async readShip(_,target=null){return structuredClone({context:world.context,contract:world.contract,contracts:[world.contract],source:{pin:sourcePin,rows:source(),access:world.access},
      observation:{complete:true,shipTypeID:world.context.shipTypeID,rows:world.fitted},hangar:world.hangar,target:{complete:true,shipID:target,shipTypeID:1,rows:target?world.fitted:[]}});},
    async plan(targets,read){const wanted=targets.find(t=>t.deficit>0),r=read.source.rows.find(r=>r.typeID===wanted?.typeID);
      return r?{itemID:r.itemID,typeID:r.typeID,quantity:Math.min(r.quantity,wanted.deficit),sourceLocationID:r.locationID,shipID:read.context.shipID,destination:{kind:"cargo"}}:null;},
    async dispatchShip(action){world.mutations.push(action.kind);const m=action.move;
      if(action.kind==="BOARD_HULL"){world.context.shipID=m.itemID;world.context.shipTypeID=1;return;}
      const list=action.kind==="ASSEMBLE_HULL"?world.hangar:source(),r=list.find(r=>r.itemID===m.itemID);r.quantity-=m.quantity;
      if(!r.quantity)list.splice(list.indexOf(r),1);
      if(action.kind==="ASSEMBLE_HULL"||action.kind==="WITHDRAW_HULL")world.hangar.push(item(++world.serial,1,1,600,4,action.kind==="ASSEMBLE_HULL",11));
      else world.fitted.push(item(++world.serial,m.typeID,m.quantity,m.shipID,m.flag,action.kind==="FIT_ITEM",11));
    }};
  let fault=null,service,engine;
  const restart=()=>{operations.clear();heldSessions.clear();engine=createReplenishment({filePath:custody,operations,data});
    const sessions=createFactorySessions({store,gateway,operations,heldSessions,botHost});
    service=createProvisioningCenterApply({sessions,gateway,engine,operations,data,readReview:offline,selectedAdapter:()=>adapter,filePath,
      attach(_a,_c,selected){world.acquired={held:{bridgeSessionID:selected.bridgeSessionID}};return world.acquired;},detach(){},
      fault:async(name)=>{if(fault===name){fault=null;throw Object.assign(new Error("controlled WC interruption"),{code:"QA_INTERRUPTION"});}} });};
  restart();
  return{world,operations,input,account,filePath,adapter,gateway,offline,fitting,provider,data,engine:()=>engine,service:()=>service,restart,fault:name=>{fault=name;},
    review:async()=>service.prepare(await offline(),input),apply:r=>service.apply(account,{confirm:true,reviewID:r.reviewID,reviewHash:r.reviewHash})};
}
test("FREE is observation: only free-only acquisition, generation and fresh barrier may call the shared Phase 5 engine",async t=>{
  const f=fixture(t),r=await f.review();assert.equal(r.canApply,true);assert.equal(f.world.selections,0);assert.equal(f.world.mutations.length,0);
  const out=await f.apply(r);assert.equal(out.state,"COMPLETE",JSON.stringify(out));assert.equal(out.finalReview.status.equipment,"VERIFIED");assert.equal(out.finalReview.status.supplies,"LOW");
  assert.equal(out.control.generation,hash(["private-session",null]));assert.equal(out.revalidation.state,"VERIFIED");assert.equal(out.release.state,"VERIFIED_OFFLINE");
  assert.equal(f.world.selections,1);assert.equal(f.world.online,false);assert.equal(f.operations.size,0);assert.ok(f.engine().journal.get(out.provisioning.operationID));
  assert.equal(f.world.hangar.find(r=>r.itemID===70).quantity,2);assert.equal(f.world.mutations.filter(k=>k==="ASSEMBLE_HULL").length,1);
  assert.doesNotMatch(fs.readFileSync(f.filePath,"utf8"),/private-session|bridgeSessionID/);
});
for(const mode of ["busy","race","reserved"])test(`${mode} refuses without takeover or provisioning`,async t=>{
  const f=fixture(t),r=await f.review();if(mode==="busy")f.world.online=true;if(mode==="race")f.world.selectionRace=true;if(mode==="reserved")f.operations.set(11,Symbol("another-owner"));
  const out=await f.apply(r);assert.equal(out.state,"REFUSED");assert.equal(out.reason,"PILOT_BUSY");assert.equal(f.world.mutations.length,0);
  assert.equal(f.world.selections,mode==="race"?1:0);assert.equal(f.world.releases,mode==="race"?0:0);
  if(mode==="reserved")assert.ok(f.operations.has(11));else assert.equal(f.world.online,true);
});
test("A3: same selected fitting ID with changed content/date is refused by production accepted-intent revalidation",async t=>{
  const f=fixture(t,true),before=structuredClone(f.world.contract),r=await f.review();
  assert.equal(r.canApply,true);
  const changed=structuredClone(f.fitting);changed.savedDate="101";changed.items[0].flagID=28;
  changed.fingerprint=fittingFingerprint(changed.shipTypeID,changed.items);
  f.world.contract=buildContract(changed,f.provider,f.data);
  assert.equal(f.world.contract.definition.fittingID,before.definition.fittingID);
  assert.notEqual(f.world.contract.definition.savedDate,before.definition.savedDate);
  assert.notEqual(f.world.contract.definition.fullFingerprint,before.definition.fullFingerprint);
  assert.notEqual(f.world.contract.definitionFingerprint,before.definitionFingerprint);
  assert.notEqual(f.world.contract.equipmentFingerprint,before.equipmentFingerprint);
  let engineReviews=0;const reviewShip=f.engine().reviewShip;
  f.engine().reviewShip=async(...args)=>{engineReviews++;return reviewShip(...args);};
  const out=await f.apply(r),record=f.service().journal.get(r.reviewID);
  assert.equal(out.state,"REFUSED");assert.equal(out.reason,"REVIEW_STALE");
  assert.deepEqual(record.pin.definition,before.definition);assert.equal(record.reviewHash,r.reviewHash);
  assert.equal(f.world.selections,1);assert.equal(engineReviews,0);assert.equal(f.world.mutations.length,0);
  assert.equal(f.engine().journal.list().length,0);assert.equal(out.provisioning,null);
  assert.equal(out.release.state,"VERIFIED_OFFLINE");assert.equal(f.world.releases,1);
  assert.equal(f.world.online,false);assert.equal(f.operations.size,0);assert.equal(f.world.context.shipID,50);
});
for(const mode of ["stock","take","ship"])test(`${mode} drift refuses after acquisition before mutation, with no fallback`,async t=>{
  const f=fixture(t,true),r=await f.review();
  if(mode==="stock")f.world.source[0].quantity--;
  if(mode==="take")f.world.access.take=false;
  if(mode==="ship")f.world.context.shipID=51;
  const out=await f.apply(r);assert.equal(out.state,"REFUSED");assert.equal(out.reason,mode==="take"?"SOURCE_TAKE_DENIED":"REVIEW_STALE");
  assert.equal(f.world.selections,1);assert.equal(f.world.mutations.length,0);assert.equal(out.release.state,"VERIFIED_OFFLINE");
});
test("corp source executes shared engine and repeat/fresh already-satisfied Apply do not overfill or duplicate",async t=>{
  const f=fixture(t,true),r=await f.review(),out=await f.apply(r);assert.equal(out.state,"COMPLETE",JSON.stringify(out));assert.equal(f.world.source[0].quantity,2);
  assert.equal(out.revalidation.source.pin.locationID,601);assert.equal(out.revalidation.source.access.take,true);
  const count=f.world.mutations.length;assert.equal((await f.apply(r)).state,"COMPLETE");assert.equal(f.world.selections,1);
  const again=await f.review();assert.equal(again.plan.mode,"ALREADY_SATISFIED");assert.equal((await f.apply(again)).state,"ALREADY_SATISFIED");
  assert.equal(f.world.mutations.length,count);assert.equal(f.world.fitted.find(r=>r.typeID===3).quantity,3);
});
test("WC restart after acquisition retains recovery fence; observes release without a second acquisition",async t=>{
  const f=fixture(t),r=await f.review();f.fault("ACQUIRED");const out=await f.apply(r);assert.equal(out.state,"BLOCKED");assert.equal(f.world.mutations.length,0);
  f.restart();assert.throws(()=>f.engine().assertSelectable(11),/CHARACTER_IN_USE/);assert.equal((await f.service().recover(f.account,r.reviewID)).state,"BLOCKED");
  assert.equal(f.world.selections,1);assert.equal((await f.apply(r)).state,"BLOCKED");
  f.world.online=false;const released=await f.service().recover(f.account,r.reviewID);assert.equal(released.state,"REFUSED");assert.equal(released.release.state,"VERIFIED_OFFLINE");assert.equal(f.operations.size,0);
});
test("ambiguous release keeps successful provisioning distinct and cannot reacquire/replay",async t=>{
  const f=fixture(t),r=await f.review();f.world.releaseUncertain=true;const out=await f.apply(r);assert.equal(out.state,"BLOCKED");assert.equal(out.provisioning.state,"COMPLETE");assert.equal(out.release.state,"UNKNOWN");
  const mutations=f.world.mutations.length;f.world.statusUncertain=false;f.restart();assert.equal((await f.apply(r)).state,"BLOCKED");
  const resolved=await f.service().recover(f.account,r.reviewID);assert.equal(resolved.state,"COMPLETE");assert.equal(resolved.release.state,"VERIFIED_OFFLINE");assert.equal(f.world.selections,1);assert.equal(f.world.mutations.length,mutations);
});
test("late acquired-generation result is refused before provisioning",async t=>{
  const f=fixture(t),r=await f.review(),read=f.adapter.readShip;f.adapter.readShip=async(...args)=>{const value=await read(...args);value.context.sessionGeneration="another";return value;};
  const out=await f.apply(r);assert.equal(out.state,"REFUSED");assert.equal(out.reason,"PROVISIONING_GENERATION_CHANGED");assert.equal(f.world.mutations.length,0);
});
test("selected-session planning drift cannot silently replace an accepted offline plan",async t=>{
  const f=fixture(t),r=await f.review(),read=f.adapter.readShip;let reads=0;
  f.adapter.readShip=async(...args)=>{if(++reads===2)f.world.hangar.find(r=>r.itemID===70).quantity--;return read(...args);};
  const out=await f.apply(r);assert.equal(out.state,"REFUSED");assert.equal(out.reason,"SOURCE_CHANGED");assert.equal(f.world.mutations.length,0);
});
test("reservation delegation is server scoped; other writes and selections remain refused throughout",async t=>{
  const f=fixture(t),reservation={kind:"temporary-provisioning",characterID:11,id:"operation"};f.operations.set(11,reservation);
  assert.throws(()=>f.engine().assertWritable(11),/CHARACTER_IN_USE/);assert.throws(()=>f.engine().assertSelectable(11),/CHARACTER_IN_USE/);
  const r=await f.engine().reviewShip(f.adapter,f.input);
  await assert.rejects(f.engine().applyShip(f.adapter,r),/CHARACTER_IN_USE/);
  // The generation must come from real acquisition; the engine's own context
  // test fixture uses one here to isolate parent/child reservation semantics.
  f.world.context.sessionGeneration="fixture";const refreshed=await f.engine().reviewShip(f.adapter,f.input);
  assert.equal((await f.engine().withTemporaryControl(reservation,()=>f.engine().applyShip(f.adapter,refreshed))).state,"COMPLETE");
  assert.equal(f.operations.get(11),reservation);assert.throws(()=>f.engine().assertWritable(11),/CHARACTER_IN_USE/);
});
test("ordinary Training Factory remains free-only and cleanup-compatible without provisioning hooks",async()=>{
  const operations=new Map(),account={accountID:1};let online=false;
  const factory=createFactorySessions({store:{listCharactersForAccount:async()=>[{characterID:10}]},operations,heldSessions:new Map(),botHost:{claimedBy:()=>null},
    gateway:{getCharacterStatus:async()=>({characterID:10,online,controlState:online?"browser_pilot":"offline"}),selectFactoryCharacter:async()=>{online=true;return{bridgeSessionID:"training",session:{characterID:10}};},releaseBridgeSession:async()=>{online=false;return{released:true,offline:true};}}});
  const result=await factory.withSessions([{account,characterID:10}],async([lease])=>{assert.deepEqual(Object.keys(lease),["userid","characterID","bridgeSessionID"]);return"training";});
  assert.equal(result.value,"training");assert.equal(result.cleanup[0].released,true);assert.equal(operations.size,0);
});
test("release proof drops only temporary control fencing; unresolved Phase 5 custody retains its own fence",async t=>{
  const f=fixture(t),r=await f.review();f.fault("ACQUIRED");await f.apply(r);f.world.online=false;
  const unresolved=f.engine().unresolved;f.engine().unresolved=()=>[{key:"shared-pending"}];
  assert.equal((await f.service().recover(f.account,r.reviewID)).state,"BLOCKED");assert.equal(f.operations.size,0);
  f.engine().unresolved=unresolved;
});
test("a changed corporation office binding refuses despite identical visible stock",async t=>{
  const f=fixture(t,true),r=await f.review(),read=f.adapter.readShip;
  f.adapter.readShip=async(...args)=>{const value=await read(...args);value.source.pin.office="corpOffice:999";return value;};
  const out=await f.apply(r);assert.equal(out.state,"REFUSED");assert.equal(out.reason,"SOURCE_CHANGED");assert.equal(f.world.mutations.length,0);
});
test("Review IDs are account-bound intent, not client-supplied authority or restart capabilities",async t=>{
  const f=fixture(t),r=await f.review();
  await assert.rejects(f.service().apply({accountID:8},{confirm:true,reviewID:r.reviewID,reviewHash:r.reviewHash}),/REVIEW_REQUIRED/);
  await assert.rejects(f.apply({...r,reviewHash:"tampered"}),/REVIEW_REQUIRED/);
  f.restart();await assert.rejects(f.apply(r),/REVIEW_REQUIRED/);
  assert.equal(f.world.selections,0);assert.equal(f.world.mutations.length,0);
});
test("failed durable preparation cannot acquire control or mutate; corrupt recovery state fails closed",async t=>{
  const f=fixture(t),r=await f.review();fs.mkdirSync(f.filePath);
  await assert.rejects(f.apply(r));assert.equal(f.world.selections,0);assert.equal(f.world.mutations.length,0);
  fs.rmdirSync(f.filePath);fs.writeFileSync(f.filePath,"{partial");assert.throws(()=>f.restart());
});

test("generic consumer policy runs only after acquisition and fresh barrier, cannot bypass release or substitute consumers", async t => {
  const f = fixture(t), input = { ...f.input, consumer: "READ_POLICY" };
  let checks = 0;
  const review = f.service().prepare(await f.offline(), input, { revalidate: async owner => {
    assert.equal(owner.accountID, f.account.accountID);
    assert.equal(f.world.online, true);
    checks++;
    throw Object.assign(new Error("Policy changed"), { code: "REVIEW_STALE" });
  } });
  const request = { confirm: true, reviewID: review.reviewID, reviewHash: review.reviewHash };
  await assert.rejects(f.service().apply(f.account, request, "OTHER_CONSUMER"), /REVIEW_REQUIRED/);
  assert.equal(f.world.selections, 0);
  const outcome = await f.service().apply(f.account, request, "READ_POLICY");
  assert.equal(checks, 1);
  assert.equal(outcome.state, "REFUSED");
  assert.equal(outcome.reason, "REVIEW_STALE");
  assert.equal(outcome.release.state, "VERIFIED_OFFLINE");
  assert.equal(f.world.mutations.length, 0);
});

function trainingFixture(t, corp = false) {
  const f = fixture(t, corp), { createTrainingEquipment, acceptedDefinition } = require("./trainingEquipment");
  const config = { configurationID: "exact", roleID: "GUARD", order: 0, corporationOwnerID: 20,
    fittingID: 4, hullTypeID: 1, acceptedSavedDate: f.fitting.savedDate, acceptedFingerprint: f.fitting.fingerprint };
  let skills = "READY", reads = 0;
  const service = createTrainingEquipment({ center: { readReview: f.offline, applyService: f.service() },
    async readQualification() {
      reads++;
      return { report: { role: "GUARD", pilot: { characterID: 11 }, stages: [{ id: "exact", skillQualification: skills,
        fitting: { status: acceptedDefinition(config, await f.offline()) ? "READY" : "REVIEW_REQUIRED" } }] } };
    } });
  return { ...f, training: service, config, request: { characterID: 11, role: "GUARD", configurationID: "exact", configurations: [config], source: f.input.source },
    skill: value => { skills = value; }, reads: () => reads,
    trainingApply: r => service.apply(f.account, { confirm: true, reviewID: r.applyReview.reviewID, reviewHash: r.applyReview.reviewHash }) };
}
test("Phase 8: Training reuses shared Phase 5 custody, fresh barrier and release; repeat does not acquire another hull or supplies", async t => {
  const f = trainingFixture(t), r = await f.training.review(f.account, f.request);
  assert.equal(r.applyReview.plan.mode, "NEW_HULL"); assert.equal(f.world.selections, 0);
  const out = await f.trainingApply(r);
  assert.equal(out.state, "COMPLETE"); assert.equal(out.release.state, "VERIFIED_OFFLINE");
  assert.equal(out.finalReview.status.equipment, "VERIFIED"); assert.equal(out.finalReview.status.supplies, "LOW");
  assert.equal(f.reads(), 2, "skills re-read after acquisition, before shared engine");
  assert.ok(f.engine().journal.get(out.provisioning.operationID));
  const again = await f.training.review(f.account, f.request), before = f.world.mutations.length;
  const stage = again.fresh.report.stages[0];
  assert.equal(stage.dutyReadiness, "READY"); assert.equal(stage.equipment.status.supplies, "LOW");
  assert.equal(again.applyReview.plan.hullQuantity, 0);
  const repeated = await f.trainingApply(again);
  assert.equal(repeated.state, "ALREADY_SATISFIED"); assert.equal(f.world.mutations.length, before);
});
test("Phase 8: skills NOT READY plus exact equipment remains NOT DUTY READY; observation never acquires control", async t => {
  const f = trainingFixture(t); await f.trainingApply(await f.training.review(f.account, f.request));
  f.skill("NOT_READY"); const mutations = f.world.mutations.length, selections = f.world.selections;
  const base = { report: { role: "GUARD", pilot: { characterID: 11 }, stages: [{ id: "exact", fitting: { status: "READY" }, skillQualification: "NOT_READY" }] } };
  const read = await f.training.enrich(f.account, base, [f.config]);
  assert.equal(read.report.stages[0].equipmentReadiness, "VERIFIED"); assert.equal(read.report.stages[0].dutyReadiness, "NOT_READY");
  await assert.rejects(f.training.review(f.account, f.request), { code: "SKILLS_NOT_READY" });
  assert.equal(f.world.selections, selections); assert.equal(f.world.mutations.length, mutations);
});
test("Phase 8: Training policy drift after Review refuses before provisioning and safely releases temporary control", async t => {
  const f = trainingFixture(t), r = await f.training.review(f.account, f.request); f.skill("NOT_READY");
  const out = await f.trainingApply(r);
  assert.equal(out.state, "REFUSED"); assert.equal(out.reason, "SKILLS_NOT_READY");
  assert.equal(f.world.mutations.length, 0); assert.equal(out.release.state, "VERIFIED_OFFLINE");
});
test("Phase 8: accepted fitting drift invalidates equipment and refuses through production Center barrier", async t => {
  const f = trainingFixture(t), r = await f.training.review(f.account, f.request);
  const changed = { ...f.fitting, savedDate: "101" }; f.world.contract = buildContract(changed, f.provider, f.data);
  const out = await f.trainingApply(r);
  assert.equal(out.reason, "REVIEW_STALE"); assert.equal(f.world.mutations.length, 0); assert.equal(out.release.state, "VERIFIED_OFFLINE");
  const read = await f.training.enrich(f.account, r.fresh, [f.config]);
  assert.equal(read.report.stages[0].equipmentReadiness, "UNKNOWN"); assert.equal(read.report.stages[0].dutyReadiness, "NOT_READY");
});
test("Phase 8: busy Training pilot cannot receive a mutation-capable Review or takeover", async t => {
  const f = trainingFixture(t); f.world.online = true;
  const r = await f.training.review(f.account, f.request); assert.equal(r.applyReview.canApply, false);
  await assert.rejects(f.trainingApply(r), /REVIEW_REQUIRED/);
  assert.equal(f.world.selections, 0); assert.equal(f.world.mutations.length, 0); assert.equal(f.world.online, true);
});
test("Phase 8: corporation source drift uses shared refusal, never personal fallback", async t => {
  const f = trainingFixture(t, true), r = await f.training.review(f.account, f.request); f.world.source[0].quantity--;
  const out = await f.trainingApply(r);
  assert.equal(out.reason, "REVIEW_STALE"); assert.equal(f.world.mutations.length, 0); assert.equal(out.release.state, "VERIFIED_OFFLINE");
});
test("Phase 8: incomplete observation cannot inherit a VERIFIED classification", async t => {
  const f = trainingFixture(t), { createTrainingEquipment } = require("./trainingEquipment");
  const service = createTrainingEquipment({ center: { async readReview() {
    const detail = await f.offline(); detail.pilot.quality = "PARTIAL"; detail.pilot.observation.complete = false;
    detail.status = { equipment: "VERIFIED", supplies: "FULL", targets: [] }; return detail;
  } } });
  const base = { report: { role: "GUARD", pilot: { characterID: 11 }, stages: [{ id: "exact", fitting: { status: "READY" }, skillQualification: "READY" }] } };
  const read = await service.enrich(f.account, base, [f.config]);
  assert.equal(read.report.stages[0].equipmentReadiness, "UNKNOWN"); assert.equal(read.report.stages[0].equipment.status.supplies, "UNKNOWN");
  assert.equal(read.report.stages[0].dutyReadiness, "NOT_READY"); assert.equal(f.world.selections, 0);
});
test("Phase 8: generation drift during the additional Training read cannot command the replacement session", async t => {
  const f = trainingFixture(t), { createTrainingEquipment } = require("./trainingEquipment"); let reads = 0;
  const service = createTrainingEquipment({ center: { readReview: f.offline, applyService: f.service() }, async readQualification() {
    if (++reads === 2) f.world.context.sessionGeneration = "replacement-generation";
    return { report: { role: "GUARD", pilot: { characterID: 11 }, stages: [{ id: "exact", fitting: { status: "READY" }, skillQualification: "READY" }] } };
  } });
  const r = await service.review(f.account, f.request);
  const out = await service.apply(f.account, { confirm: true, reviewID: r.applyReview.reviewID, reviewHash: r.applyReview.reviewHash });
  assert.equal(out.reason, "PROVISIONING_GENERATION_CHANGED"); assert.equal(f.world.mutations.length, 0);
  assert.equal(out.release.state, "VERIFIED_OFFLINE");
});
