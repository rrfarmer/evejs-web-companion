import test from 'node:test';
import assert from 'node:assert/strict';
import {createMiningOperationRoutes} from '../../operations/miningRoutes.ts';
import {createRestoredMiningHost,getMiningOperationLaunchPlan} from './mining.ts';
import type {PilotSession} from '../../../../web/src/plugin-api/pilotSession.ts';
import type {PluginRunContext} from '../../../../web/src/plugin-api/backend.ts';
import {createMiningFleetRuntime} from '../../miningFleet/runtime.ts';
import {memoryFleetDocuments} from '../../miningFleet/operationStoreFixture.ts';
import {installPageContext} from '../app/context.ts';

// In-memory route + public host transport fixture. No socket, native login or game data.
let fixtureSerial=0;
function fixture(mixed=false){
 const world=`readiness-world-${++fixtureSerial}`;
 const docs=new Map<string,unknown>(),bots:any[]=[],calls:{run:string;id:number;token:string;setup:any}[]=[];
 let changedFit=false,unknownStart=false,denied=false,serial=0;
 const policy={maxRuntimeMinutes:720,defaultRuntimeMinutes:60,durationChoices:[60,720]};
 const routes=createMiningOperationRoutes({document:key=>({read:()=>docs.get(key)??null,write:v=>{docs.set(key,structuredClone(v));}}),
   getWorldScope:()=> world,isOperationActive:()=>false,targetSnapshot:()=>({}),
   checkSetup:setup=>({ok:true,setup:setup as any,name:'Fleet',policy:{riskClasses:['fleet'],restartSafe:false}})},
   {transaction:action=>action(),documentNames:prefix=>[...docs.keys()].filter(key=>key.startsWith(prefix)),
    deleteDocuments:names=>{for(const name of names)docs.delete(name);}},
   {discardGeneration:()=>true});
 const req=(body?:unknown)=>({account:{accountID:1,username:'controller'},params:{},query:{},body,method:'POST',path:''}) as any;
 const definition={name:'Original saved fleet',area:{anchorSystemID:300,anchorSystemName:'System',reach:'CURRENT_SYSTEM',targetClasses:['BELT']},
   targetPolicy:'ANY_ELIGIBLE',unloadPolicy:'HAULER_SERVICE',unloadDestination:{stationID:600,stationName:'Station',corporationDivision:null},
   members:[{characterID:801,characterName:'Miner',accountName:'readiness-miner',role:'MINER',automationID:'',preparation:{fittingID:4}},{characterID:802,characterName:'Hauler',accountName:'readiness-hauler',role:'HAULER',automationID:'',...(mixed?{}:{preparation:{fittingID:5}})}],
   preparation:{source:{kind:'hangar'},suppliesRequired:false,replenishSupplies:true}};
 const transport:typeof fetch=async(input,init)=>{
   const url=new URL(String(input),'http://fixture'),p=url.pathname,b=init?.body?JSON.parse(String(init.body)):undefined;
   const token=new Headers(init?.headers).get('authorization')??'';
   let body:any;
   if(p==='/api/plugins/uoc/world')body={worldID:world};
   else if(p.startsWith('/api/pilot-training/ownership'))body={ownership:{characterID:Number(url.searchParams.get('characterID')),owner:'OFF',online:false}};
   else if(p==='/api/map/resolve/600')body={kind:'station',stationID:600,solarSystemID:300};
   else if(p==='/api/bots')body={bots,hostedRunPolicy:policy};
   else if(p==='/api/plugins/uoc/runs/current')body={runs:bots.filter(x=>!x.endedAt).map(x=>({botID:x.botID,characterID:x.characterID,operationID:x.plugin.setup.operationID,operationRunID:x.plugin.setup.operationRunID}))};
   else if(p.match(/\/runs\/[^/]+\/stop$/)){const id=p.split('/').at(-2);const bot=bots.find(x=>x.botID===id);assert.ok(bot);bot.endedAt='fixture-stopped';body={};}
   else if(p.endsWith('/check'))body={setup:b.setup,name:'Member',policy:{riskClasses:['fleet'],restartSafe:false}};
   else if(p==='/api/bots/start'){
     assert.equal(token,`Bearer ${b.characterID===801?'miner':'hauler'}`);
     if(denied&&b.characterID===802)return new Response(JSON.stringify({ok:false,error:'OWNER_UNAVAILABLE',message:'Pilot owner is unavailable'}),{status:409});
     calls.push({run:b.run,id:b.characterID,token,setup:b.setup});
     if(unknownStart&&b.run==='mcc-miner')throw Error('Unknown native Start dispatch');
     const shipID=b.characterID+100;
     const readout=b.run==='mcc-prepare'?{characterID:b.characterID,operationID:b.setup.operationID,operationRunID:b.setup.operationRunID,shipID,
       definitionFingerprint:changedFit?'changed-fit':'exact-fit',fittingID:b.setup.preparation.fittingID,providerCharacterID:b.characterID,state:'DEGRADED',equipment:mixed?'MODIFIED':'VERIFIED',supplies:'LOW',targets:[],fittingName:'Pilot fitting '+b.setup.preparation.fittingID,reason:mixed?'Current equipment differs from the selected fitting.':'Optional fuel missing'}:
       {characterID:b.characterID,shipID,shipTypeName:'Inspected hull',systemID:300,stationID:600,corporationID:77,officeID:null,
        canCapacityM3:100,observedAt:Date.now(),belts:[{itemID:99,name:'Native belt'}],fleet:{state:'not-in-fleet'},
        fitHoldQualification:{ORE:{miner:!mixed,hauler:true},ICE:{miner:false,hauler:true}}};
     const inspection=['mcc-prepare','mcc-inspect'].includes(b.run);
     const bot={botID:`fixture-${++serial}`,characterID:b.characterID,kind:'plugin',status:inspection?'stopped':'running',
       phase:b.run==='mcc-prepare'?'Mining member prepared':inspection?'Fleet pilot inspected':'Mining',endedAt:inspection?'fixture-ended':null,
       plugin:{pluginID:'uoc',run:b.run,setup:b.setup,readout}};
     bots.push(bot);body={bot};
   }else if(p.startsWith('/api/plugins/uoc/mining-operations')){
     const relative=p.slice('/api/plugins/uoc'.length),parts=relative.split('/'),id=parts[2];
     const route=Object.entries(routes).find(([key])=>{
       const [method,path]=key.split(' ');return method===(init?.method??'GET')&&path!.replace(':operationID',id??'')===relative;
     });assert.ok(route,p);
     const response=await route[1]!({...req(b),params:{operationID:id}});return new Response(JSON.stringify(response.body),{status:response.status??200});
   }else throw Error('Unexpected request '+p);
   return new Response(JSON.stringify({ok:true,...body}),{status:200});
 };
 installPageContext({readAccounts:()=>definition.members.map(m=>({accountID:m.characterID,username:m.accountName,options:{token:m.role.toLowerCase(),fetch:transport}}))});
 return {calls,transport,world,async save(){const result=await routes['POST /mining-operations']!(req(definition));return (result.body as any).savedOperationID as string;},
   changeFit(){changedFit=true;},denyOwner(){denied=true;},loseStart(){unknownStart=true;}};
}

test('original Review uses authorized member evidence; Start revalidates and Stop retains exact owners',async()=>{
 const f=fixture(),id=await f.save(),options={token:'controller',fetch:f.transport};
 const preflight=await getMiningOperationLaunchPlan(id,options);
 assert.equal(preflight.members.length,2);assert.equal(preflight.preparation?.members?.length,2);
 assert.ok(preflight.preparation?.members?.every(m=>m.equipment==='UNKNOWN'&&m.observedAt===null));assert.equal(f.calls.length,0);
 const host=createRestoredMiningHost(options,async()=>true),review=await host.prepare(id,'reviewed-run');
 assert.equal(review.launchPlan.preparation?.state,'DEGRADED');
 assert.ok(review.launchPlan.preparation?.members?.every(m=>m.equipment==='VERIFIED'&&m.fittingName?.startsWith('Pilot fitting ')&&m.observedAt));
 assert.ok(f.calls.filter(x=>x.run==='mcc-prepare').every(x=>x.setup.reviewOnly===true&&x.setup.verifyEquipment===undefined));
 assert.equal(f.calls.filter(x=>['mcc-miner','mcc-hauler'].includes(x.run)).length,0);
 await host.start(review,60);
 const productive=f.calls.filter(x=>['mcc-miner','mcc-hauler'].includes(x.run));
 assert.deepEqual(productive.map(x=>[x.id,x.token]),[[801,'Bearer miner'],[802,'Bearer hauler']]);
 assert.deepEqual(f.calls.filter(x=>x.run==='mcc-prepare').map(x=>[x.id,x.setup.reviewOnly]),[[801,true],[802,true]]);
 for(const call of productive){
  assert.deepEqual(call.setup.startupPreparation.map((p:any)=>[p.characterID,p.preparation.fittingID,p.preparation.providerCharacterID]),
   [[801,4,801],[802,5,802]]);
 }
 await host.stop(id);
 const count=f.calls.filter(x=>['mcc-miner','mcc-hauler'].includes(x.run)).length;
 await host.start(review,60);
 assert.equal(f.calls.filter(x=>['mcc-miner','mcc-hauler'].includes(x.run)).length,count);
});

test('a mixed fleet starts with a mismatch and an as-is pilot, including changed fitting evidence',async()=>{
 const f=fixture(true),id=await f.save(),host=createRestoredMiningHost({token:'controller',fetch:f.transport},async()=>true);
 const review=await host.prepare(id,'mixed-run'),members=review.launchPlan.preparation?.members;
 assert.deepEqual(members?.map(x=>x.equipment),['MODIFIED','AS IS']);
 assert.match(members?.[0]?.reason??'',/differs.*online mining module/);
 assert.equal(members?.[1]?.supplies,'NOT APPLICABLE');
 f.changeFit();
 const updated=await host.prepare(id,'new-fit-evidence');
 assert.equal(review.inspections.find(x=>x.characterID===801)?.preparation?.definitionFingerprint,'exact-fit');
 assert.equal(updated.inspections.find(x=>x.characterID===801)?.preparation?.definitionFingerprint,'changed-fit');
 const before=f.calls.length;
 const receipt=await host.start(review,60);
 assert.deepEqual(receipt?.members.map(x=>x.status),['ACCEPTED','ACCEPTED']);
 const starts=f.calls.slice(before);
 assert.deepEqual(starts.map(x=>[x.run,x.id]),[['mcc-miner',801],['mcc-hauler',802]]);
 for(const start of starts){
  assert.deepEqual(start.setup.startupPreparation.map((p:any)=>[p.characterID,p.preparation.fittingID]),[[801,4]]);
 }
 assert.ok(f.calls.filter(x=>x.id===802&&x.run==='mcc-inspect').every(x=>x.setup.equipmentReview===false&&x.setup.commandModules===false&&!x.setup.supplies));
});

test('an unavailable owner blocks Review and only its own dispatch during Start',async()=>{
 const f=fixture(true),id=await f.save(),host=createRestoredMiningHost({token:'controller',fetch:f.transport},async()=>true);
 const review=await host.prepare(id,'prior-valid-run');f.denyOwner();
 await assert.rejects(host.start(review,60),/owner is unavailable/);
 const other=fixture(true),otherID=await other.save();other.denyOwner();
 await assert.rejects(createRestoredMiningHost({token:'controller',fetch:other.transport},async()=>true).prepare(otherID,'denied-run'),/owner is unavailable/);
 assert.ok(!other.calls.some(x=>['mcc-miner','mcc-hauler'].includes(x.run)));
 assert.deepEqual(f.calls.filter(x=>['mcc-miner','mcc-hauler'].includes(x.run)).map(x=>x.run),['mcc-miner']);
});

test('fresh fleet starts from its saved definition after stale browser inspections outlive the previous generation',async t=>{
 const f=fixture(true),id=await f.save(),storage=new Map<string,string>();
 const old=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{
  getItem:(key:string)=>storage.get(key)??null,
  setItem:(key:string,value:string)=>{storage.set(key,value);},
  removeItem:(key:string)=>{storage.delete(key);},
 }});
 t.after(()=>{if(old)Object.defineProperty(globalThis,'sessionStorage',old);else Reflect.deleteProperty(globalThis,'sessionStorage');});
 for(const characterID of [801,802]){
  const key=`uoc:restored:hosted:${encodeURIComponent(f.world)}:${characterID}:mcc-inspect`;
  storage.set(key,JSON.stringify({characterID,kind:'mcc-inspect',issuedAt:Date.now()-60000,setup:JSON.stringify({
   systemID:300,equipmentReview:characterID===801,commandModules:false,
  }),beforeIDs:[],botID:characterID===801?null:'forgotten-inspection'}));
 }
 const host=createRestoredMiningHost({token:'controller',fetch:f.transport},async()=>true);
 const review=await host.prepare(id,'fresh-run');
 const launch=await host.start(review,60);
 assert.equal(launch?.operationRunID,'fresh-run');
 assert.equal(review.definition.name,'Original saved fleet');
 const productive=f.calls.filter(x=>x.run==='mcc-miner'||x.run==='mcc-hauler');
 assert.deepEqual(productive.map(x=>[x.id,x.setup.operationID,x.setup.operationRunID,x.setup.beltID]),[
  [801,id,'fresh-run',99],[802,id,'fresh-run',99],
 ]);
 assert.equal(storage.size,0);
});

test('a changed ship blocks productive Start and unknown Start is not inspected or dispatched twice',async t=>{
 const f=fixture(),id=await f.save(),host=createRestoredMiningHost({token:'controller',fetch:f.transport},async()=>true);
 const review=await host.prepare(id,'changed-run');
 await host.start(review,60);
 const miner=f.calls.find(call=>call.run==='mcc-miner')!;
 const pilot=miner.setup.members.find((m:{characterID:number})=>m.characterID===miner.id);
 assert.equal(pilot.shipID,901);
 // Start forwards the reviewed hull. The held runner checks the actual flight before creating a mining cycle.
 const runtime=createMiningFleetRuntime({storage:memoryFleetDocuments(),
  attach:async()=>({store:{station:{get:()=>({online:{characterID:miner.id}})}},
   flow:{setLivePush(){},requestOptions:()=>({}),flying:{sessionGeneration:()=>1,isSessionClosing:()=>false}}}) as unknown as PilotSession,
  createCycle:async()=>assert.fail('Mining must not start on a different hull'),
  settle:async()=>assert.fail('No pilot joined the operation')});
 t.after(()=>runtime.shutdown());
 const held={characterID:miner.id,botID:'changed-hull',setup:miner.setup,held:{characterID:miner.id},
  baseUrl:'http://fixture',resumed:false,report(){},fetch:async(input:URL)=>{
   switch(new URL(input).pathname){
    case '/api/pilot-training/characters':return Response.json({ok:true,account:'readiness-miner',characters:[{characterID:miner.id}]});
    case '/api/bots':return Response.json({bots:[{botID:'changed-hull',characterID:miner.id,expiresAt:new Date(Date.now()+600_000).toISOString()}]});
    case '/api/bridge/flight/status':return Response.json({ok:true,flight:{shipID:902,solarSystemID:300,inSpace:false,docked:true,stationID:600}});
    default:assert.fail('Unexpected held pilot request '+input);
   }
  }} as unknown as PluginRunContext;
 await assert.rejects(async()=>runtime.runs.MINER.start(held),/active ship or location does not match the Start plan/);
 assert.equal(runtime.getOrCreate(miner.setup).entries.size,0);

 const lost=fixture(),lostID=await lost.save(),lostHost=createRestoredMiningHost({token:'controller',fetch:lost.transport},async()=>true);
 const lostReview=await lostHost.prepare(lostID,'lost-run');
 lost.loseStart();
 await assert.rejects(lostHost.start(lostReview,60),/Unknown native Start/);
 const before=lost.calls.length;
 await assert.rejects(lostHost.start(lostReview,60),/previous fleet Start/);
 assert.equal(lost.calls.length,before);
});
