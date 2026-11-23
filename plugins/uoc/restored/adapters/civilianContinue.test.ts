import test from 'node:test';import assert from 'node:assert/strict';
import {continueCivilianMission,type ServerBot} from '../app/api.ts';

function fixture(kind:'mining'|'distribution',flags:{owned?:boolean;busy?:boolean;missing?:boolean;resolved?:boolean}={}){
 const calls:string[]=[],run='civilian-'+kind,agent={mode:'manual',agentID:42};
 const accepted={agentID:42,missionID:901,key:'native-key'};
 const bot={botID:'old-run',characterID:7,civilianCheckpointID:'old-run',plugin:{pluginID:'uoc',run}} as ServerBot;
 const row={botID:bot.botID,characterID:7,kind,owner:'test',ownerAvailable:!!flags.owned,resolved:!!flags.resolved,
  setup:{agent,missionCount:5,durationMinutes:180},acceptedMission:flags.missing?null:accepted};
 const oneShot={agent,missionCount:1,continuation:{...accepted,botID:bot.botID}};
 const fetcher:typeof fetch=async(input,init)=>{
  const p=String(input);calls.push(p);
  let body:object;
  if(p.endsWith('/civilian/checkpoints'))body={history:[row]};
  else if(p.endsWith('/old-run/continue'))body={continued:true};
  else if(p.includes('/ownership'))body={ownership:{characterID:7,owner:'OFF',online:false}};
  else if(p.endsWith('/characters'))body={account:'Test',characters:[{characterID:7}]};
  else if(p==='/api/bots')body={bots:flags.owned?[{...bot,status:'paused',endedAt:null}]:flags.busy?[{botID:'other',characterID:8,endedAt:null}]:[],hostedRunPolicy:{maxRuntimeMinutes:60}};
  else if(p.endsWith('/check')){
   assert.ok(p.includes(run));assert.deepEqual(JSON.parse(String(init?.body)).setup,oneShot);
   body={setup:oneShot,name:'Continue',policy:{riskClasses:['mission','inventory'],restartSafe:false}};
  }else if(p==='/api/bots/start'){
   assert.deepEqual(JSON.parse(String(init?.body)).setup,oneShot);
   body={bot:{botID:'new-run',characterID:7,kind:'plugin',plugin:{pluginID:'uoc',run},status:'starting'}};
  }else throw Error(p);
  return Response.json({ok:true,...body});
 };
 return {bot,calls,options:{token:'synthetic',fetch:fetcher}};
}

for(const kind of ['distribution','mining'] as const)test(`offline ${kind} Continue starts the existing engine for one saved accepted mission`,async()=>{
 const f=fixture(kind);
 await continueCivilianMission(f.bot,f.options);
 assert.equal(f.calls.filter(p=>p==='/api/bots/start').length,1);
 assert.equal(f.calls.some(p=>/Activate|DoAction|login/.test(p)),false);
});

test('paused Mining continues in place and another hosted owner prevents dispatch',async()=>{
 const held=fixture('mining',{owned:true});await continueCivilianMission(held.bot,held.options);
 assert.ok(held.calls.some(p=>p.endsWith('/old-run/continue')));
 assert.ok(!held.calls.includes('/api/bots/start'));
 const busy=fixture('distribution',{busy:true});
 await assert.rejects(continueCivilianMission(busy.bot,busy.options),/already has an owner/);
 assert.ok(!busy.calls.includes('/api/bots/start'));
});

test('missing or completed acceptance evidence cannot start a new job',async()=>{
 for(const flags of [{missing:true},{resolved:true}]){
  const f=fixture('distribution',flags);
  await assert.rejects(continueCivilianMission(f.bot,f.options),/No confirmed unfinished accepted mission/);
  assert.ok(!f.calls.includes('/api/bots/start'));
 }
});
