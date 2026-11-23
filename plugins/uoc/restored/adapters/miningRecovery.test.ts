import test from 'node:test';import assert from 'node:assert/strict';
import {recoverMiningOperation} from './miningRecovery.ts';import {installPageContext} from '../app/context.ts';
import type {MiningRecovery,StopUnload} from '../../operations/miningRecovery.ts';
let serial=0;
function fixture(lost=false,count=2){const name='recover-account-'+ ++serial,bots:any[]=[],attempts:any[]=[],calls:string[]=[],starts:number[]=[],stops:string[]=[];let offline=true,loseStart=lost,acquisitionConflict=false;const completedMembers:number[]=[];
 const members=Array.from({length:count},(_,index)=>({characterID:index+1,accountName:name+'-'+index,status:'ACCEPTED' as const,botID:'original-'+(index+1),role:'MINER' as const,kind:'mcc-miner' as const,beforeIDs:[]}));
 const review:MiningRecovery={operationID:'op',operationRunID:'old',setupHash:'h',recoveryHash:'r',members,attempts,completedMembers,observeOfflineParking:false};
 const elsewhere=new Set<number>(),busyAccounts=new Set<number>();
 let observedPilots:unknown;
 const transport:typeof fetch=async(input,init)=>{const p=new URL(String(input),'http://fixture').pathname,b=init?.body?JSON.parse(String(init.body)):null;calls.push(p);let body:any;
  const id=Number(new Headers(init?.headers).get("authorization")?.match(/member-(\d+)$/)?.[1]);
  const accountBots=review.stopUnload?bots.filter(b=>b.characterID===id):bots;
  if(p.endsWith('/recovery'))body={recovery:review};
  else if(p==='/api/bots')body={bots:busyAccounts.has(id)?[...accountBots,{botID:"other-role",characterID:99,kind:"plugin",plugin:{pluginID:"uoc",run:"distribution-carrier"},status:"running",endedAt:null}]:accountBots,hostedRunPolicy:{maxRuntimeMinutes:60}};
  else if(p==='/api/plugins/uoc/runs/current')body={runs:accountBots.filter(x=>!x.endedAt).map(x=>({botID:x.botID,characterID:x.characterID,operationID:'op',operationRunID:'old'}))};
  else if(p==='/api/roster/characters')body={result:[null,null,{type:"list",items:[{type:"object",name:"util.KeyVal",args:{type:"dict",entries:[
   ["characterID",id],["stationID",elsewhere.has(id)?601:600],["solarSystemID",300],
  ]}}]},null]};
  else if(p.endsWith('/ownership'))body={ownership:{characterID:Number(new URL(String(input),'http://fixture').searchParams.get('characterID')),owner:offline?'OFF':'UNKNOWN',online:!offline}};
  else if(p.endsWith('/check'))body={setup:b.setup,policy:{riskClasses:['inventory'],restartSafe:false}};
  else if(p.endsWith('/recovery/dispatch')){
   const i=attempts.findIndex(a=>a.characterID===b.characterID);
   if(i!==-1){assert.equal(b.retry.dispatchedAt,attempts[i].dispatchedAt);attempts.splice(i,1);}
   attempts.push({...b,botID:null,beforeIDs:b.beforeIDs,dispatchedAt:calls.length});body={recovery:review};
  }
  else if(p.endsWith('/recovery/finalize')){observedPilots=b.observePilots;body={state:"STOPPED"};}
  else if(p==='/api/bots/start'){starts.push(b.characterID);if(acquisitionConflict)return Response.json({ok:false,error:"CHARACTER_IN_USE",message:"Another session took this pilot before acquisition."},{status:409});if(loseStart)throw Error('lost FINISH response');const bot={botID:'finish-'+b.characterID,characterID:b.characterID,kind:'plugin',plugin:{pluginID:'uoc',run:'mcc-finish'},status:'running',endedAt:null};bots.push(bot);body={bot};}
  else if(p.endsWith('/recovery/accept')){attempts.find(x=>x.characterID===b.characterID).botID=b.botID;body={};}
  else if(p.endsWith('/stop')){stops.push(p.split('/').at(-2)!);body={state:'STOP_REQUESTED'};}else throw Error('Unexpected '+p);
  return Response.json({ok:true,...body});};
 const options={token:'owner',fetch:transport};installPageContext({readAccounts:()=>members.map(member=>({accountID:member.characterID,username:member.accountName,options:{...options,token:'member-'+member.characterID}}))});return {options,calls,attempts,bots,completedMembers,starts,stops,elsewhere,busyAccounts,review,setUnknown(){offline=false;},clearResponseLoss(){loseStart=false;},conflictAtStart(){acquisitionConflict=true;},observeOfflineParking(){review.observeOfflineParking=true;},observedPilots:()=>observedPilots};
}

const home:StopUnload["parking"]={mode:"RETURN_HOME_UNLOAD_DOCK",kind:"station",destinationID:600,systemID:300,corporationID:77,division:1};

test("Retry Stop starts only the seven offline pilots with a pending unload and reuses their current FINISH owners",async()=>{
 const f=fixture(false,15),pending=[1,2,3,4,5,6,7];
 f.completedMembers.push(8,9,10,11,12,13,14,15);
 f.review.stopUnload={parking:home,characterIDs:pending};
 await assert.rejects(recoverMiningOperation("op",f.options,undefined,"another run"),/home unload changed/);
 await recoverMiningOperation("op",f.options,undefined,"old");
 assert.deepEqual(f.starts,pending);
 assert.equal(f.calls.filter(p=>p==="/api/roster/characters").length,7);
 await recoverMiningOperation("op",f.options,undefined,"old");
 assert.deepEqual(f.starts,pending);
 assert.deepEqual(f.stops,pending.map(id=>"finish-"+id));
 assert.ok(f.stops.every(id=>!id.startsWith("original")));
});

test("Retry Stop respects another operation on the account and skips a pilot away from the home dock",async()=>{
 const f=fixture(false,3);
 f.review.stopUnload={parking:home,characterIDs:[1,2,3]};
 f.busyAccounts.add(1);f.elsewhere.add(2);
 const messages=await recoverMiningOperation("op",f.options,undefined,"old");
 assert.deepEqual(f.starts,[3]);
 assert.deepEqual(f.stops,[]);
 assert.match(messages.join(" "),/already hosting another pilot.*not confirmed docked/);
});
test('November 11 retained generation retries its hosted hauler and starts FINISH for all six independent offline members',async()=>{
 const f=fixture(false,7),progress:string[]=[];
 f.attempts.push({characterID:1,botID:'finish-1',beforeIDs:[],dispatchedAt:1});
 f.bots.push({botID:'finish-1',characterID:1,kind:'plugin',plugin:{pluginID:'uoc',run:'mcc-finish'},status:'paused',endedAt:null,maxRuntimeMinutes:60});
 await recoverMiningOperation('op',f.options,message=>progress.push(message));
 assert.deepEqual(f.stops,['finish-1']);
 assert.deepEqual(f.starts,[2,3,4,5,6,7]);
 assert.equal(f.attempts.length,7);
 assert.match(progress[0]!,/Pilot 1.*existing FINISH owner/);
 assert.match(progress.at(-1)!,/Pilot 7.*Waiting for native settlement/);
 assert.ok(!f.calls.some(p=>p.endsWith('/recovery/finalize')));
});
test('a lost FINISH response permits explicit replacement only after fresh offline release',async()=>{
 const f=fixture(true);
 await assert.rejects(recoverMiningOperation('op',f.options),/lost FINISH/);
 assert.equal(f.calls.filter(p=>p==='/api/bots/start').length,1);
 f.clearResponseLoss();
 await recoverMiningOperation('op',f.options);
 assert.deepEqual(f.starts,[1,1,2]);
 assert.equal(f.attempts[0].botID,'finish-1');
});
test('unknown pilot ownership cannot dispatch or acquire a FINISH session',async()=>{const f=fixture();f.setUnknown();await assert.rejects(recoverMiningOperation('op',f.options),/offline free owner/);assert.equal(f.attempts.length,0);assert.equal(f.calls.includes('/api/bots/start'),false);});
test('an ended exact native FINISH receipt can bind a lost acceptance without replaying that pilot',async()=>{const f=fixture();await recoverMiningOperation('op',f.options);f.attempts[0].botID=null;f.completedMembers.push(1);Object.assign(f.bots[0],{endedAt:'2026-11-08',status:'stopped',phase:'Docked; retained freight settled',plugin:{pluginID:'uoc',run:'mcc-finish',readout:{operationID:'op',operationRunID:'old',characterID:1}}});await recoverMiningOperation('op',f.options);assert.equal(f.attempts[0].botID,'finish-1');assert.deepEqual(f.bots.map(b=>b.characterID),[1,2]);});

test("already parked offline pilots with no historical host row require no replacement session",async()=>{
 const f=fixture();
 f.completedMembers.push(1,2);
 const messages=await recoverMiningOperation("op",f.options);
 assert.equal(f.calls.filter(p=>p==='/api/bots/start').length,0);
 assert.equal(f.calls.filter(p=>p.endsWith('/recovery/finalize')).length,1);
 assert.ok(messages.some(x=>/finalized/.test(x)));
});

test("Return Home reconciles nine docks through Finalize without requesting FINISH",async()=>{
 const f=fixture(false,9);
 f.observeOfflineParking();
 f.completedMembers.push(3,4,5,6,7,8,9);
 const messages=await recoverMiningOperation("op",f.options);
 assert.deepEqual(f.calls,["/api/plugins/uoc/mining-operations/op/recovery","/api/plugins/uoc/mining-operations/op/recovery/finalize"]);
 assert.deepEqual(f.observedPilots(),Array.from({length:9},(_,i)=>({characterID:i+1,token:`member-${i+1}`})));
 assert.match(messages[0]!,/finalized from verified docks/);
});

test("F9 ownership changes between the offline observation and the host claim",async()=>{
 const f=fixture();f.conflictAtStart();
 await assert.rejects(recoverMiningOperation("op",f.options),/Another session took this pilot/);
 assert.equal(f.bots.length,0);
 assert.equal(f.calls.filter(p=>p==="/api/bots/start").length,1);
 assert.equal(f.calls.filter(p=>p.endsWith("/recovery/accept")).length,0);
});
