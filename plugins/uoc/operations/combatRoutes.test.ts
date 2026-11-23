import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createCombatStore } from "./combatStore.ts";
import { createNativeSecurityRun } from "../combat/host.ts";
import { createCombatRoutes, combatLaunchCandidate } from "./combatRoutes.ts";
import type { BackendRequest } from "../../../web/src/plugin-api/backend.ts";
const require=createRequire(import.meta.url), Database=require("better-sqlite3");
const input={name:"Security",mode:"SECURITY_MISSION",systemID:null,homeStationID:null,durationMinutes:60,members:[{accountName:"Test47",characterID:47,role:"AUTO",required:true,preparation:{}}],objective:{ownerCharacterID:47,agentID:123,level:1,levelRule:"EXACT",stopRule:"COUNT",missionCount:2},parking:{mode:"NEAREST"}};

test("saved Security reward policy is reviewed and bound to the hosted setup", async () => {
 const store=createCombatStore(new Database(":memory:"));
 try {
  const {routes}=createCombatRoutes({store,getWorldScope:()=>"world-A"});
  const definition=store.save("world-A",47,{...input,objective:{...input.objective,rewardPolicy:"SHARE"}});
  const id=definition.operationID!, epoch="8c0a2466-0293-412e-a456-7217e0d81f17";
  const review:any=(await routes["POST /combat-operations/:id/review"]!(req(47,{},id))).body;
  assert.equal(review.review.definition.objective.rewardPolicy,"SHARE");
  const setup={...review.review.launchCandidate.setup,operationID:id,operationRunID:epoch};
  assert.equal(setup.rewardPolicy,"SHARE");
  const checked=await createNativeSecurityRun().check(setup);
  assert.ok(checked.ok);
  assert.equal(JSON.stringify(checked.setup),JSON.stringify(setup));
  const payload={confirm:true,reviewHash:review.review.reviewHash,operationRunID:epoch};
  const start=routes["POST /combat-operations/:id/start"]!;
  assert.equal((await start(req(47,{...payload,setup:{...setup,rewardPolicy:"KEEP"}},id))).status,409);
  const accepted=await start(req(47,{...payload,setup},id));
  assert.equal((accepted.body as any).ok,true);
  assert.equal(store.runs("world-A",id)[0].setup.rewardPolicy,"SHARE");
 } finally { store.close(); }
});

test('legacy member schema gains a required default without rewriting native owner, dispatch or receipt',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE combat_operation_members (world TEXT NOT NULL,operation_id TEXT NOT NULL,epoch TEXT NOT NULL,owner TEXT NOT NULL,character_id INTEGER NOT NULL,ship_id INTEGER NOT NULL,status TEXT NOT NULL,bot_id TEXT,receipt TEXT,PRIMARY KEY(world,operation_id,epoch,character_id))');
 db.prepare('INSERT INTO combat_operation_members VALUES(?,?,?,?,?,?,?,?,?)').run('world','op','old','pilot',1,11,'RUNNING','original-bot',JSON.stringify({phase:'COMBAT',native:'retained'}));
 const store=createCombatStore(db),row=store.members('world','op','old')[0];assert.equal(row.required,1);assert.equal(row.owner,'pilot');assert.equal(row.bot_id,'original-bot');assert.equal(row.status,'RUNNING');assert.deepEqual(row.receipt,{phase:'COMBAT',native:'retained'});store.close();
});

test('canonical required flags survive durable member binding and cannot be changed by a launch body',async()=>{
 const store=createCombatStore(new Database(':memory:')),{routes}=createCombatRoutes({store,getWorldScope:()=> 'world-A'}),d=store.save('world-A',47,{...input,members:[...input.members,{accountName:'Test48',characterID:48,required:false,preparation:{}}]}),id=d.operationID!,epoch='8c0a2466-0293-412e-a456-7217e0d81f17',review:any=await routes['POST /combat-operations/:id/review']!(req(47,{},id)),c=review.body.review.launchCandidate;
 const actors=[{characterID:47,accountName:'Test47',shipID:101},{characterID:48,accountName:'Test48',shipID:102}],setup={operationID:id,operationRunID:epoch,missionOwnerID:47,...c.setup,anchorID:47,members:actors.map(a=>({characterID:a.characterID,shipID:a.shipID,required:a.characterID===47})),registry:true},start=routes['POST /combat-operations/:id/group/start']!;
 const wrong:any=await start(req(47,{confirm:true,reviewHash:review.body.review.reviewHash,operationRunID:epoch,actors,setup:{...setup,members:setup.members.map((m:any)=>({...m,required:false}))}},id));assert.equal(wrong.status,409);
 const ok:any=await start(req(47,{confirm:true,reviewHash:review.body.review.reviewHash,operationRunID:epoch,actors,setup},id));assert.equal(ok.body.ok,true);assert.deepEqual(store.members('world-A',id,epoch).map((m:any)=>m.required),[1,0]);store.close();
});

test('same-operation fleet continuation pins the parked native owner, old bot, accepted key and exact ships',async()=>{
 const store=createCombatStore(new Database(':memory:')),{routes}=createCombatRoutes({store,getWorldScope:()=> 'world-A'}),d=store.save('world-A',47,{...input,members:[...input.members,{accountName:'Test48',characterID:48,required:true,preparation:{}}]}),id=d.operationID!,first='8c0a2466-0293-412e-a456-7217e0d81f17',second='8c0a2466-0293-412e-a456-7217e0d81f18',actors=[{characterID:47,accountName:'Test47',shipID:101},{characterID:48,accountName:'Test48',shipID:102}],start=routes['POST /combat-operations/:id/group/start']!;
 const make=(c:any,epoch:string)=>({operationID:id,operationRunID:epoch,missionOwnerID:47,...c.setup,anchorID:47,members:actors.map(a=>({characterID:a.characterID,shipID:a.shipID,required:true})),registry:true});
 let review:any=await routes['POST /combat-operations/:id/review']!(req(47,{},id));let setup=make(review.body.review.launchCandidate,first);assert.equal((await start(req(47,{confirm:true,reviewHash:review.body.review.reviewHash,operationRunID:first,actors,setup},id)) as any).body.ok,true);
 for(const a of actors){store.dispatchMember('world-A',id,first,a.accountName,a.characterID);store.bindMember('world-A',id,first,a.accountName,a.characterID,a.shipID,setup,'old-'+a.characterID);store.finishMember('world-A',id,first,a.accountName,a.characterID,'old-'+a.characterID,a.characterID===47?{phase:'COMBAT',identity:{acceptedKey:'native-key',agentID:123},completed:[],parking:{destinationID:600}}:{phase:'DONE',parking:{destinationID:600}});}
 review=await routes['POST /combat-operations/:id/review']!(req(47,{},id));const c=review.body.review.launchCandidate;assert.deepEqual(c.setup.resumeExpected,{runID:'old-47',acceptedKey:'native-key'});setup=make(c,second);
 const changedActors=actors.map(a=>({...a,shipID:a.shipID+100}));const wrong:any=await start(req(47,{confirm:true,reviewHash:review.body.review.reviewHash,operationRunID:second,actors:changedActors,setup:{...setup,members:setup.members.map((m:any)=>({...m,shipID:m.shipID+100}))}},id));assert.equal(wrong.status,409);
 assert.equal((await start(req(47,{confirm:true,reviewHash:review.body.review.reviewHash,operationRunID:second,actors,setup},id)) as any).body.ok,true);
 for(const a of actors){store.dispatchMember('world-A',id,second,a.accountName,a.characterID);store.bindMember('world-A',id,second,a.accountName,a.characterID,a.shipID,setup,'new-'+a.characterID);store.finishMember('world-A',id,second,a.accountName,a.characterID,'new-'+a.characterID,a.characterID===47?{phase:'DONE',completed:[{identity:{acceptedKey:'native-key'},commandID:'native-complete'}],parking:{destinationID:600}}:{phase:'DONE',parking:{destinationID:600}});}
 assert.equal(store.save('world-A',47,{...d,name:'Resolved by native completion'}).revision,2);store.close();
});
function req(accountID:number,body:unknown={},id=""):BackendRequest {return {method:"POST",path:"/",params:{id},query:{},body,account:{accountID,username:`Test${accountID}`}};}
test("shared verified world registry supports revisions across accounts and isolates worlds",async()=>{
 const store=createCombatStore(new Database(":memory:"));let world:string|null="world-A";
 const {routes}=createCombatRoutes({store,getWorldScope:()=>world});
 const create:any=await routes["POST /combat-operations"]!(req(1,input));assert.equal(create.body.definition.revision,1);
 const id=create.body.definition.operationID;
 const other:any=await routes["GET /combat-operations"]!(req(2));assert.equal(other.body.operations[0].definition.operationID,id);
 const updated:any=await routes["POST /combat-operations"]!(req(2,{...create.body.definition,name:"Updated"}));assert.equal(updated.body.definition.revision,2);
 const stale:any=await routes["POST /combat-operations"]!(req(1,create.body.definition));assert.equal(stale.status,409);
 const wrongDelete:any=await routes["POST /combat-operations/:id/delete"]!(req(1,{revision:1},id));assert.equal(wrongDelete.status,409);
 world="world-B";const isolated:any=await routes["GET /combat-operations"]!(req(1));assert.deepEqual(isolated.body.operations,[]);
 world=null;const missing:any=await routes["GET /combat-operations"]!(req(1));assert.equal(missing.status,503);
 world="world-A";const removed:any=await routes["POST /combat-operations/:id/delete"]!(req(2,{revision:2},id));assert.equal(removed.body.ok,true);store.close();
});
test("durable intent, exact host binding and terminal receipt fence duplicate starts",async()=>{
 const store=createCombatStore(new Database(":memory:"));const {routes}=createCombatRoutes({store,getWorldScope:()=>"world-A"});
 const saved:any=await routes["POST /combat-operations"]!(req(47,input));const d=saved.body.definition;
 const reviewed:any=await routes["POST /combat-operations/:id/review"]!(req(47,{},d.operationID));
 assert.equal(reviewed.body.review.canStart,false);assert.equal(reviewed.body.review.profile,null);
 const candidate=reviewed.body.review.launchCandidate,epoch="8c0a2466-0293-412e-a456-7217e0d81f17",setup={...candidate.setup,operationID:d.operationID,operationRunID:epoch};
 const payload={confirm:true,reviewHash:reviewed.body.review.reviewHash,operationRunID:epoch,setup};
 const wrongOwner:any=await routes["POST /combat-operations/:id/start"]!(req(1,payload,d.operationID));assert.equal(wrongOwner.status,409);
 const intent:any=await routes["POST /combat-operations/:id/start"]!(req(47,payload,d.operationID));assert.equal(intent.body.launchIntent.candidate.setup.missionCount,2);
 const duplicate:any=await routes["POST /combat-operations/:id/start"]!(req(47,payload,d.operationID));assert.equal(duplicate.status,409);
 assert.equal(store.runs('world-A',d.operationID)[0].status,'INTENT');
 const update:any=await routes["POST /combat-operations"]!(req(47,{...d,name:'No'}));assert.equal(update.status,409);
 assert.throws(()=>store.bind('world-A',d.operationID,epoch,'other',47,setup,'bot-1'),/does not match/);
 store.bind('world-A',d.operationID,epoch,'Test47',47,setup,'bot-1');assert.equal(store.runs('world-A',d.operationID)[0].bot_id,'bot-1');
 assert.throws(()=>store.finish('world-A',d.operationID,epoch,'Test47',47,'other',{}),/does not match/);
 store.finish('world-A',d.operationID,epoch,'Test47',47,'bot-1',{phase:'DONE',completed:[{identity:{acceptedKey:'key-1'},commandID:'complete-1'}],parking:{stationID:123}});
 const history=store.runs('world-A',d.operationID);assert.equal(history[0].status,'ENDED');assert.equal(history[0].receipt.completed[0].identity.acceptedKey,'key-1');
 const modified:any=await routes["POST /combat-operations"]!(req(47,{...d,name:'Changed'}));assert.equal(modified.body.definition.revision,2);
 const stale:any=await routes["POST /combat-operations/:id/start"]!(req(47,payload,d.operationID));assert.equal(stale.status,409);store.close();
});
test("unsupported modes, levels and time stops do not produce runnable candidates",()=>{
 for(const d of [{...input,mode:"DED_COMPLEX"},{...input,objective:{...input.objective,level:3}},{...input,objective:{...input.objective,stopRule:"UNKNOWN"}}]) {
  const result=combatLaunchCandidate(d as any);assert.equal(result.candidate,null);assert.ok(result.gaps.length>0);
 }
});
test('a selected fitting remains a launch candidate pending actual hosted preparation',()=>{const result=combatLaunchCandidate({...input,members:[{...input.members[0],preparation:{fittingID:4}}]} as any);assert.ok(result.candidate);assert.deepEqual(result.gaps,[]);});
test('cross-operation continuation binds the exact stopped owner, agent, bot and mission key',async()=>{const store=createCombatStore(new Database(':memory:')),{routes}=createCombatRoutes({store,getWorldScope:()=> 'world-A'}),source=store.save('world-A',47,input),sourceReview:any=await routes['POST /combat-operations/:id/review']!(req(47,{},source.operationID!)),epoch='8c0a2466-0293-412e-a456-7217e0d81f17',sourceSetup={...sourceReview.body.review.launchCandidate.setup,operationID:source.operationID,operationRunID:epoch};await routes['POST /combat-operations/:id/start']!(req(47,{confirm:true,reviewHash:sourceReview.body.review.reviewHash,operationRunID:epoch,setup:sourceSetup},source.operationID!));store.bind('world-A',source.operationID!,epoch,'Test47',47,sourceSetup,'old-bot');store.finish('world-A',source.operationID!,epoch,'Test47',47,'old-bot',{phase:'COMBAT',identity:{acceptedKey:'exact-key',agentID:123},completed:[],parking:{stationID:5}});
 const next=store.save('world-A',47,{...input,name:'Continue',objective:{...input.objective,resumeFromOperationID:source.operationID}}),review:any=await routes['POST /combat-operations/:id/review']!(req(47,{},next.operationID!));assert.deepEqual(review.body.review.resume,{sourceRunID:'old-bot',identity:{acceptedKey:'exact-key'}});assert.deepEqual(review.body.review.launchCandidate.setup.resumeExpected,{runID:'old-bot',acceptedKey:'exact-key'});const nextEpoch='9c0a2466-0293-412e-a456-7217e0d81f17',nextSetup={...review.body.review.launchCandidate.setup,operationID:next.operationID,operationRunID:nextEpoch};const checked:any=createNativeSecurityRun().check(nextSetup);assert.equal(checked.ok,true);assert.deepEqual(checked.setup,nextSetup);assert.equal(JSON.stringify(checked.setup),JSON.stringify(nextSetup));const started:any=await routes['POST /combat-operations/:id/start']!(req(47,{confirm:true,reviewHash:review.body.review.reviewHash,operationRunID:nextEpoch,setup:nextSetup},next.operationID!));assert.equal(started.body.ok,true);
 const wrong=store.save('world-A',47,{...input,name:'Wrong agent',objective:{...input.objective,agentID:124,resumeFromOperationID:source.operationID}}),bad:any=await routes['POST /combat-operations/:id/review']!(req(47,{},wrong.operationID!));assert.equal(bad.body.review.launchCandidate,null);assert.match(bad.body.review.blockers.join(' '),/exact safely stopped mission/);store.close();});
test('belt and gate patrol candidates use the same hosted fleet contract',()=>{for(const mode of ['BELT_PATROL','GATE_PATROL']){const result=combatLaunchCandidate({...input,mode,systemID:30000143,observationSeconds:30} as any),candidate=result.candidate as any;assert.equal(candidate.runName,'combat-patrol-member');assert.equal(candidate.setup.mode,mode);assert.equal(candidate.setup.systemID,30000143);assert.equal(candidate.setup.observationSeconds,30);assert.equal(candidate.members[0].required,true);}});

test("Security host checks exact operation identity as a pair",()=>{
 const host=createNativeSecurityRun();const setup={agentID:123,missionCount:2,operationID:"8c0a2466-0293-412e-a456-7217e0d81f17",operationRunID:"9c0a2466-0293-412e-a456-7217e0d81f17"};
 assert.equal((host.check(setup) as any).ok,true);
 assert.equal((host.check({...setup,operationRunID:undefined}) as any).ok,false);
 assert.equal((host.check({...setup,operationID:'other'}) as any).ok,false);
});

test("accepted mission continuity cannot change its exact setup or delete its receipt",async()=>{
 const store=createCombatStore(new Database(':memory:'));const {routes}=createCombatRoutes({store,getWorldScope:()=>"world-A"});
 const d=store.save('world-A',47,input),id=d.operationID!,epoch='8c0a2466-0293-412e-a456-7217e0d81f17';
 const review:any=await routes['POST /combat-operations/:id/review']!(req(47,{},id));const setup={...review.body.review.launchCandidate.setup,operationID:id,operationRunID:epoch};
 await routes['POST /combat-operations/:id/start']!(req(47,{confirm:true,reviewHash:review.body.review.reviewHash,operationRunID:epoch,setup},id));
 store.bind('world-A',id,epoch,'Test47',47,setup,'bot');store.finish('world-A',id,epoch,'Test47',47,'bot',{phase:'COMBAT',identity:{acceptedKey:'same-key'},completed:[],parking:{stationID:9}});
 const edit:any=await routes['POST /combat-operations']!(req(47,{...d,name:'Changed'}));assert.equal(edit.status,409);
 const remove:any=await routes['POST /combat-operations/:id/delete']!(req(47,{revision:d.revision},id));assert.equal(remove.status,409);
 const nextReview:any=await routes['POST /combat-operations/:id/review']!(req(47,{},id)),epoch2='9c0a2466-0293-412e-a456-7217e0d81f17';
 const changed={...setup,agentID:999,operationRunID:epoch2};
 const wrong:any=await routes['POST /combat-operations/:id/start']!(req(47,{confirm:true,reviewHash:nextReview.body.review.reviewHash,operationRunID:epoch2,setup:changed},id));assert.equal(wrong.status,409);
 const same={...setup,operationRunID:epoch2};const ok:any=await routes['POST /combat-operations/:id/start']!(req(47,{confirm:true,reviewHash:nextReview.body.review.reviewHash,operationRunID:epoch2,setup:same},id));assert.equal(ok.body.ok,true);store.close();
});
test("selected parking preserves destination and rejects missing solar system",async()=>{
 const store=createCombatStore(new Database(':memory:'));const {routes}=createCombatRoutes({store,getWorldScope:()=>"world-A"});
 const d=store.save('world-A',47,{...input,homeStationID:6001,parking:{mode:'SELECTED'}}),id=d.operationID!;
 const r:any=await routes['POST /combat-operations/:id/review']!(req(47,{},id)),epoch='8c0a2466-0293-412e-a456-7217e0d81f17',candidate=r.body.review.launchCandidate;
 const unresolved={...candidate.setup,operationID:id,operationRunID:epoch};const bad:any=await routes['POST /combat-operations/:id/start']!(req(47,{confirm:true,reviewHash:r.body.review.reviewHash,operationRunID:epoch,setup:unresolved},id));assert.equal(bad.status,409);
 const setup={...unresolved,parking:{...unresolved.parking,systemID:3001}};const good:any=await routes['POST /combat-operations/:id/start']!(req(47,{confirm:true,reviewHash:r.body.review.reviewHash,operationRunID:epoch,setup},id));assert.equal(good.body.launchIntent.candidate.setup.parking.destinationID,6001);store.close();
});

test("level 2 and up-to level 2 preserve the actual rule in the candidate",()=>{
 for(const levelRule of ["EXACT","UP_TO"]){const r=combatLaunchCandidate({...input,objective:{...input.objective,level:2,levelRule}} as any);assert.equal((r.candidate as any).setup.level,2);assert.equal((r.candidate as any).setup.levelRule,levelRule);}
});

test("manual agent preserves requested corporation, system and jump constraints",()=>{const value={...input,systemID:300,objective:{...input.objective,corporationID:42,maxJumps:3}},r=combatLaunchCandidate(value as any),s=(r.candidate as any).setup;assert.deepEqual(s.agentScope,{systemID:300,corporationID:42,maxJumps:3});});
test("automatic agent without jump limit is not silently limited to ten jumps",()=>{const value={...input,objective:{...input.objective,agentID:null}},r=combatLaunchCandidate(value as any);assert.equal((r.candidate as any).setup.agent.maxJumps,null);});

test("time stopping uses explicit timer without an invented mission count",()=>{const r=combatLaunchCandidate({...input,durationMinutes:60,objective:{...input.objective,stopRule:"TIME"}} as any);assert.equal((r.candidate as any).setup.missionCount,null);assert.equal((r.candidate as any).setup.stopAfterMinutes,60);});

test("fleet member dispatch and host binding retain custody until every exact actor parks",async()=>{
 const store=createCombatStore(new Database(':memory:')), {routes}=createCombatRoutes({store,getWorldScope:()=>"world-A"});
 const d=store.save('world-A',47,{...input,members:[...input.members,{accountName:'Test48',characterID:48,role:'AUTO',required:true,preparation:{}}]}),id=d.operationID!,epoch='8c0a2466-0293-412e-a456-7217e0d81f17';
 const review:any=await routes['POST /combat-operations/:id/review']!(req(47,{},id)),candidate=review.body.review.launchCandidate;
 const actors=[{accountName:'Test47',characterID:47,shipID:101},{accountName:'Test48',characterID:48,shipID:102}],setup={operationID:id,operationRunID:epoch,missionOwnerID:47,...candidate.setup,anchorID:47,members:actors.map(a=>({characterID:a.characterID,shipID:a.shipID,required:true})),registry:true};
 const started:any=await routes['POST /combat-operations/:id/group/start']!(req(47,{confirm:true,reviewHash:review.body.review.reviewHash,operationRunID:epoch,setup,actors},id));assert.equal(started.body.ok,true);
 const dispatchRoute=routes['POST /combat-operations/:id/group/:epoch/:characterID/dispatch']!,dispatchReq=(accountID:number,characterID:number)=>({...req(accountID,{},id),params:{id,epoch,characterID:String(characterID)}});
 const denied:any=await dispatchRoute(dispatchReq(47,48));assert.equal(denied.status,409);assert.equal(store.members('world-A',id,epoch)[1].status,'PLANNED');
 await dispatchRoute(dispatchReq(47,47));assert.throws(()=>store.bindMember('world-A',id,epoch,'Test47',47,999,setup,'bot-47'),/does not match/);store.bindMember('world-A',id,epoch,'Test47',47,101,setup,'bot-47');
 const repeated:any=await dispatchRoute(dispatchReq(47,47));assert.equal(repeated.status,409);
 await dispatchRoute(dispatchReq(48,48));store.bindMember('world-A',id,epoch,'Test48',48,102,setup,'bot-48');
 store.finishMember('world-A',id,epoch,'Test47',47,'bot-47',{phase:'DONE',completed:[{identity:{acceptedKey:'mission-1'},commandID:'complete-1'}],parking:{stationID:9}});
 assert.equal(store.runs('world-A',id)[0].status,'GROUP_INTENT');assert.throws(()=>store.finishMember('world-A',id,epoch,'Test48',48,'wrong',{}),/does not match/);
 store.finishMember('world-A',id,epoch,'Test48',48,'bot-48',{parking:{stationID:9}});const result=store.runs('world-A',id)[0];assert.equal(result.status,'ENDED');assert.equal(result.bot_id,'bot-47');assert.equal(result.receipt.completed[0].identity.acceptedKey,'mission-1');store.close();
});

test('group intent may omit an uninspected optional pilot but never a required one',async()=>{const store=createCombatStore(new Database(':memory:')),{routes}=createCombatRoutes({store,getWorldScope:()=> 'world-A'}),d=store.save('world-A',47,{...input,members:[...input.members,{accountName:'Test48',characterID:48,role:'AUTO',required:true,preparation:{}},{accountName:'Test49',characterID:49,role:'AUTO',required:false,preparation:{}}]}),id=d.operationID!,epoch='8c0a2466-0293-412e-a456-7217e0d81f17',review:any=await routes['POST /combat-operations/:id/review']!(req(47,{},id)),candidate=review.body.review.launchCandidate;
 const actor47={accountName:'Test47',characterID:47,shipID:101},actor48={accountName:'Test48',characterID:48,shipID:102},setup=(actors:any[])=>({operationID:id,operationRunID:epoch,missionOwnerID:47,...candidate.setup,anchorID:47,members:actors.map(a=>({characterID:a.characterID,shipID:a.shipID,required:true})),registry:true}),start=routes['POST /combat-operations/:id/group/start']!;
 const missing:any=await start(req(47,{confirm:true,reviewHash:review.body.review.reviewHash,operationRunID:epoch,setup:setup([actor47]),actors:[actor47]},id));assert.equal(missing.status,409);
 const accepted:any=await start(req(47,{confirm:true,reviewHash:review.body.review.reviewHash,operationRunID:epoch,setup:setup([actor47,actor48]),actors:[actor47,actor48]},id));assert.equal(accepted.body.ok,true);assert.deepEqual(store.members('world-A',id,epoch).map((m:any)=>m.character_id),[47,48]);store.close();});

test("saved anomaly supports a solo held owner, multiple sites and an exact cross-system return",async()=>{const store=createCombatStore(new Database(":memory:")),{routes}=createCombatRoutes({store,getWorldScope:()=>"world-A"});const d=store.save("world-A",47,{...input,mode:"COMBAT_ANOMALY",systemID:300,homeStationID:6001,objective:{ownerCharacterID:47,agentID:null,maxSites:3,discoveryWaitMinutes:2,maxDifficulty:1}}),id=d.operationID!,r:any=await routes["POST /combat-operations/:id/review"]!(req(47,{},id)),candidate=r.body.review.launchCandidate,epoch="8c0a2466-0293-412e-a456-7217e0d81f17",actors=[{accountName:"Test47",characterID:47,shipID:101}];assert.equal(candidate.runName,"anomaly-fleet-member");assert.equal(candidate.setup.siteSearch.maxSites,3);const setup={operationID:id,operationRunID:epoch,...candidate.setup,parking:{...candidate.setup.parking,systemID:301},members:[{characterID:47,shipID:101,required:true}],registry:true};const start:any=await routes["POST /combat-operations/:id/group/start"]!(req(47,{confirm:true,reviewHash:r.body.review.reviewHash,operationRunID:epoch,setup,actors},id));assert.equal(start.body.ok,true);store.dispatchMember("world-A",id,epoch,"Test47",47);store.bindMember("world-A",id,epoch,"Test47",47,101,setup,"bot");store.finishMember("world-A",id,epoch,"Test47",47,"bot",{phase:"DONE",completed:[{identity:{instanceID:9},receipt:{source:"native-dungeon-completed"}}],parking:{destinationID:6001,systemID:301}});assert.equal(store.runs("world-A",id)[0].receipt.completed[0].identity.instanceID,9);store.close();});
