import { test } from "node:test";
import { createRequire } from "node:module";
import { createCombatStore } from "../../operations/combatStore.ts";
import { createCombatRoutes } from "../../operations/combatRoutes.ts";
import assert from "node:assert/strict";
import { installPageContext } from "../app/context.ts";
const controller = { token: "controller-token" };
import { listCombatOperations, saveCombatOperation, reviewCombatOperation, startCombatOperation } from "./combat.ts";

test("registry and hosted policy use the restored controller token",async()=>{
 const calls:{url:string;auth:string|null;method:string}[]=[];

 installPageContext({fetch:async(input,init)=>{
  const url=String(input),headers=new Headers(init?.headers);calls.push({url,auth:headers.get("authorization"),method:init?.method??"GET"});
  const data=url==="/api/bots"?{ok:true,hostedRunPolicy:{maxRuntimeMinutes:4320,defaultRuntimeMinutes:720,durationChoices:[60,720]}}:{ok:true,operations:[],hostedRunPolicy:null};
  return new Response(JSON.stringify(data),{status:200,headers:{"content-type":"application/json"}});
 }});
 try{
  const result=await listCombatOperations(controller);assert.equal(result.hostedRunPolicy?.maxRuntimeMinutes,4320);
  await saveCombatOperation({name:"Example",mode:"SECURITY_MISSION",systemID:null,homeStationID:null,durationMinutes:60,members:[]},controller);
  assert.deepEqual(calls.map(c=>c.url),["/api/plugins/uoc/combat-operations","/api/bots","/api/plugins/uoc/combat-operations"]);
  assert.ok(calls.every(c=>c.auth==="Bearer controller-token"));assert.equal(calls[2]?.method,"POST");
 }finally{installPageContext({});}
});

test('active Security progress uses only exact owner/run paged receipts and preserves unknown reward fields',async()=>{const originalFetch=globalThis.fetch,seen:string[]=[];const transport:typeof fetch=async(input)=>{const url=String(input);seen.push(url);let value:any;if(url==='/api/plugins/uoc/combat-operations')value={ok:true,hostedRunPolicy:{maxRuntimeMinutes:60,defaultRuntimeMinutes:60,durationChoices:[60]},operations:[{definition:{mode:'SECURITY_MISSION'},executions:[{status:'RUNNING',bot_id:'run-1',owner:'Test47',character_id:47,setup:{}}]}]};else if(url.startsWith('/api/pilot-training/ownership?'))value={ok:true,ownership:{characterID:Number(new URL(url,'http://fixture').searchParams.get('characterID')),owner:'OFF',online:false}};else if(url==='/api/pilot-training/characters')value={ok:true,account:'Test47',characters:[{characterID:47}]};else if(url==='/api/bots')value={ok:true,bots:[]};else if(url==='/api/plugins/uoc/security/47/progress?runID=run-1')value={ok:true,characterID:47,runID:'run-1',phase:'COMBAT',identity:{acceptedKey:'active-key'},readout:{completedCount:1}};else if(url==='/api/plugins/uoc/security/47/receipts?runID=run-1&offset=0')value={ok:true,characterID:47,runID:'run-1',completedCount:1,offset:0,nextOffset:null,entries:[{missionKey:'done-key',commandID:'done',confirmedIsk:'0.00',withheldIsk:'100.00',observedLpChange:null,observedCorporationLpChange:'12'}]};else throw Error(`Unexpected ${url}`);return Response.json(value);};installPageContext({fetch:transport,readAccounts:()=>[{accountID:47,username:'Test47',options:{token:'owner-token',fetch:transport}}]});globalThis.fetch=transport;try{const value=await listCombatOperations(controller),run=value.operations[0]!.run!;assert.equal(run.objective?.stage,'COMBAT');assert.equal(run.objective?.identity?.acceptedKey,'active-key');assert.deepEqual(run.objective?.completed?.[0]?.reward,{iskDelta:0,lpDelta:null,taxISK:100,corporationLpDelta:12});assert.ok(seen.includes('/api/plugins/uoc/security/47/receipts?runID=run-1&offset=0'));}finally{globalThis.fetch=originalFetch;installPageContext({});}});

test('patrol review chooses the largest inspected hull before its hosted policy checks',async()=>{const originalFetch=globalThis.fetch,bots=new Map<number,any[]>(),checked:any[]=[];const definition={durationMinutes:60,members:[{accountName:'Test61',characterID:61,required:true,preparation:{}},{accountName:'Test62',characterID:62,required:true,preparation:{}}]},candidate={runName:'combat-patrol-member',characterID:61,accountName:'Test61',members:definition.members.map(m=>({accountName:m.accountName,characterID:m.characterID,required:true})),setup:{leaderID:61,systemID:300,mode:'GATE_PATROL',observationSeconds:10,parking:{mode:'nearest'}}};const transport:typeof fetch=async(input,init)=>{const url=String(input),body=init?.body?JSON.parse(String(init.body)):{},token=new Headers(init?.headers).get('authorization'),who=token==='Bearer Test62-token'?62:61;let value:any;if(url.endsWith('/review'))value={ok:true,review:{reviewHash:'review',definition,launchCandidate:candidate}};else if(url.startsWith('/api/pilot-training/ownership?'))value={ok:true,ownership:{characterID:Number(new URL(url,'http://fixture').searchParams.get('characterID')),owner:'OFF',online:false}};else if(url==='/api/pilot-training/characters')value={ok:true,account:`Test${who}`,characters:[{characterID:who}]};else if(url==='/api/plugins/uoc/world')value={ok:true,worldID:'world-X'};else if(url==='/api/bots')value={ok:true,bots:bots.get(who)??[],hostedRunPolicy:{maxRuntimeMinutes:60,defaultRuntimeMinutes:60,durationChoices:[60]}};else if(url.startsWith('/api/plugins/uoc/runs/')&&url.endsWith('/check')){if(url.includes('combat-patrol-member'))checked.push(body.setup);value={ok:true,setup:body.setup,name:'run',policy:{riskClasses:[],restartSafe:false}};}else if(url==='/api/bots/start'){const bot={botID:`inspect-${who}`,characterID:who,kind:'plugin',plugin:{pluginID:'uoc',run:'coc-fleet-inspect',readout:{characterID:who,shipID:100+who,shipClass:who===61?3:5,stationID:5,systemID:300,fleet:{state:'not-in-fleet'},observedAt:Date.now()}},phase:'Fleet Security pilot inspected',status:'stopped',endedAt:new Date().toISOString()};bots.set(who,[bot]);value={ok:true,bot};}else throw Error(`Unexpected ${url}`);return Response.json(value);};installPageContext({fetch:transport,readAccounts:()=>[61,62].map(id=>({accountID:id,username:`Test${id}`,options:{token:`Test${id}-token`,fetch:transport}}))});globalThis.fetch=transport;try{const review=await reviewCombatOperation('operation',controller);assert.equal(review.canStart,true,JSON.stringify(review.blockers));assert.ok(checked.length>=2);assert.ok(checked.every(s=>s.leaderID===62));}finally{globalThis.fetch=originalFetch;installPageContext({});}});

test("lost Start response leaves durable intent and does not dispatch again",async()=>{
 const require=createRequire(import.meta.url),Database=require('better-sqlite3'),store=createCombatStore(new Database(':memory:'));
 const definition=store.save('world-X',48,{name:'Security',mode:'SECURITY_MISSION',systemID:null,homeStationID:null,durationMinutes:60,members:[{accountName:'Test48',characterID:48,role:'AUTO',required:true,preparation:{}}],objective:{ownerCharacterID:48,agentID:123,level:1,levelRule:'EXACT',stopRule:'COUNT',missionCount:1},parking:{mode:'NEAREST'}});
 const {routes}=createCombatRoutes({store,getWorldScope:()=>"world-X"});let starts=0;const originalFetch=globalThis.fetch;
 const transport:typeof fetch=async(input,init)=>{
  const url=String(input),body=init?.body?JSON.parse(String(init.body)):{};let data:any;

  if(url==='/api/pilot-training/characters')data={ok:true,account:'Test48',characters:[{characterID:48,name:'Pilot'}]};
  else if(url.startsWith('/api/pilot-training/ownership?'))data={ok:true,ownership:{characterID:Number(new URL(url,'http://fixture').searchParams.get('characterID')),owner:'OFF',online:false}};
  else if(url==='/api/bots')data={ok:true,bots:[],hostedRunPolicy:{maxRuntimeMinutes:4320,defaultRuntimeMinutes:720,durationChoices:[60]}};
  else if(url==='/api/plugins/uoc/runs/coc-security/check')data={ok:true,setup:body.setup,name:'Security',policy:{riskClasses:['combat','mission'],restartSafe:false}};
  else if(url==='/api/bots/start'){starts++;throw Error('connection lost after dispatch');}
  else if(url.endsWith('/review')||url.endsWith('/start')){
   const action=url.endsWith('/review')?'review':'start',handler=routes[`POST /combat-operations/:id/${action}`]!;
   const result=await handler({method:'POST',path:'/',params:{id:definition.operationID!},query:{},body,account:{accountID:48,username:'Test48'}});return new Response(JSON.stringify(result.body),{status:result.status??200});
  }else throw Error(`Unexpected ${url}`);
  return new Response(JSON.stringify(data),{status:200});
 };
 installPageContext({fetch:transport,readAccounts:()=>[{accountID:48,username:'Test48',options:{token:'pilot-token',fetch:transport}}]});globalThis.fetch=transport;
 try{
  const review=await reviewCombatOperation(definition.operationID!,controller);assert.equal(review.canStart,true);
  await assert.rejects(startCombatOperation(definition.operationID!,review.reviewHash),/requires reconciliation/);
  assert.equal(starts,1);assert.equal(store.runs('world-X',definition.operationID!)[0].status,'INTENT');
  await assert.rejects(startCombatOperation(definition.operationID!,review.reviewHash),/Review this exact operation again/);
  const again=await reviewCombatOperation(definition.operationID!,controller);assert.equal(again.canStart,false);assert.equal(starts,1);
 }finally{globalThis.fetch=originalFetch;installPageContext({});store.close();}
});

test("fleet review checks each inspected ship and a lost second Start is never replayed",async()=>{
 const require=createRequire(import.meta.url),Database=require('better-sqlite3'),store=createCombatStore(new Database(':memory:'));
 const definition=store.save('world-X',61,{name:'Fleet',mode:'SECURITY_MISSION',systemID:null,homeStationID:null,durationMinutes:60,members:[{accountName:'Test61',characterID:61,role:'AUTO',required:true,preparation:{fittingID:17}},{accountName:'Test62',characterID:62,role:'AUTO',required:true,preparation:{}},{accountName:'Test63',characterID:63,role:'AUTO',required:false,preparation:{}}],objective:{ownerCharacterID:61,agentID:123,level:1,levelRule:'EXACT',stopRule:'COUNT',missionCount:1},parking:{mode:'NEAREST'}});
 const {routes}=createCombatRoutes({store,getWorldScope:()=>"world-X"}),bots=new Map<number,any[]>(),calls:string[]=[];let fleetStarts=0,changeFit=false;const originalFetch=globalThis.fetch;
 const transport:typeof fetch=async(input,init)=>{const url=String(input),body=init?.body?JSON.parse(String(init.body)):{},headers=new Headers(init?.headers),token=headers.get('authorization'),who=token==='Bearer Test62-token'?62:61;let data:any;

  if(url==='/api/pilot-training/characters')data={ok:true,account:`Test${who}`,characters:[{characterID:who,name:`Pilot${who}`}]};
  else if(url==='/api/plugins/uoc/world')data={ok:true,worldID:'world-X'};
  else if(url.startsWith('/api/pilot-training/ownership?'))data={ok:true,ownership:{characterID:Number(new URL(url,'http://fixture').searchParams.get('characterID')),owner:'OFF',online:false}};
  else if(url==='/api/bots')data={ok:true,bots:bots.get(who)??[],hostedRunPolicy:{maxRuntimeMinutes:4320,defaultRuntimeMinutes:720,durationChoices:[60]}};
  else if(url.startsWith('/api/plugins/uoc/runs/')&&url.endsWith('/check')){const run=url.split('/')[5];calls.push(`check:${who}:${run}`);data={ok:true,setup:body.setup,name:run,policy:{riskClasses:[],restartSafe:false}};}
  else if(url==='/api/bots/start'){
   const run=body.run;calls.push(`start:${who}:${run}`);const inspect=run==='coc-fleet-inspect',prep=run==='mcc-prepare',finished=inspect||prep,bot={botID:`${run}-${who}-${calls.length}`,characterID:who,kind:'plugin',plugin:{pluginID:'uoc',run,readout:inspect?{characterID:who,shipID:100+who,shipClass:who===61?5:3,stationID:5,systemID:6,fleet:who===62?{state:'ready',fleetID:77,memberIDs:[62]}:{state:'not-in-fleet'},observedAt:Date.now()}:prep?{characterID:who,operationID:definition.operationID,operationRunID:body.setup.operationRunID,equipment:'VERIFIED',state:'VERIFIED',shipID:100+who,definitionFingerprint:(changeFit?'changed-fit-':'native-fit-')+who,fittingName:'Verified fit'}:{}},phase:inspect?'Fleet Security pilot inspected':prep?'Mining member prepared':'Waiting',status:finished?'stopped':'running',endedAt:finished?new Date().toISOString():null};
   bots.set(who,[...(bots.get(who)??[]),bot]);if(!finished){fleetStarts++;store.bindMember('world-X',definition.operationID!,body.setup.operationRunID,`Test${who}`,who,100+who,body.setup,bot.botID);if(who===62)throw Error('response lost after Start');}data={ok:true,bot};
  }else if(url.endsWith('/group/start')||url.endsWith('/review')||url.endsWith('/dispatch')){
   const dispatch=url.match(/\/group\/([^/]+)\/(\d+)\/dispatch$/),key=dispatch?'POST /combat-operations/:id/group/:epoch/:characterID/dispatch':url.endsWith('/group/start')?'POST /combat-operations/:id/group/start':'POST /combat-operations/:id/review';
   const result=await routes[key]!({method:'POST',path:'/',params:{id:definition.operationID!,...(dispatch?{epoch:dispatch[1]!,characterID:dispatch[2]!}:{})},query:{},body,account:{accountID:who,username:`Test${who}`}});return new Response(JSON.stringify(result.body),{status:result.status??200});
  }else if(url.includes('/combat-operations/')&&url.endsWith('/stop')){calls.push(`stop-operation:${who}`);data={ok:true};}
  else throw Error(`Unexpected ${url}`);
  return new Response(JSON.stringify(data),{status:200});
 };
 installPageContext({fetch:transport,readAccounts:()=>[61,62].map(id=>({accountID:id,username:`Test${id}`,options:{token:`Test${id}-token`,fetch:transport}}))});globalThis.fetch=transport;
 try{let review=await reviewCombatOperation(definition.operationID!,controller);assert.equal(review.canStart,true,JSON.stringify(review.blockers));assert.equal(review.preparation.members.length,3);assert.equal(review.preparation.members[0]?.fittingName,'Verified fit');assert.match(review.preparation.members[2]?.reason??'',/Optional pilot omitted/);assert.ok(calls.includes('start:61:mcc-prepare'));assert.equal(review.fleetMoves?.[0]?.characterID,62);
  await assert.rejects(startCombatOperation(definition.operationID!,review.reviewHash),/Explicit approval/);assert.equal(fleetStarts,0);changeFit=true;await assert.rejects(startCombatOperation(definition.operationID!,review.reviewHash,{fleetMovesApproved:true}),/fitting or ship changed/);assert.equal(fleetStarts,0);changeFit=false;review=await reviewCombatOperation(definition.operationID!,controller);assert.equal(review.canStart,true,JSON.stringify(review.blockers));
  await assert.rejects(startCombatOperation(definition.operationID!,review.reviewHash,{fleetMovesApproved:true}),/no member Start was replayed/);assert.equal(fleetStarts,2);assert.ok(calls.includes('stop-operation:61'));
  const members=store.members('world-X',definition.operationID!,store.runs('world-X',definition.operationID!)[0].epoch);assert.deepEqual(members.map(m=>m.status),['RUNNING','RUNNING']);
  const again=await reviewCombatOperation(definition.operationID!,controller);assert.equal(again.canStart,false);assert.equal(fleetStarts,2);
 }finally{globalThis.fetch=originalFetch;installPageContext({});store.close();}
});
