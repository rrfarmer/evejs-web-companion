import test from 'node:test';
import assert from 'node:assert/strict';
import {activateDuringOriginalLock,targetNotLockedRefusal,targetGoneRefusal} from './activation.ts';
const identity={characterID:1,shipID:2,moduleID:3,targetID:4,mission:'exact-mission',lockOrdinal:5,lockIssuedAt:1000};
const refusal=()=>Object.assign(new Error('That target is not locked.'),{code:'CALL_REFUSED',status:409,refusal:{key:'CustomNotify',values:{type:'dict',entries:[['notify','That target is not locked.']]}}});
function fixture(){let t=1000,calls=0,retired=false;const log:any[]=[];
 const deps={current:()=>{if(retired)throw Error('retired');},savePending:(x:any)=>{log.push(['pending',x]);},saveRefusal:(x:any)=>{log.push(['refused',x]);},native:async(m:number,o:any)=>{calls++;log.push(['native',m,o]);if(calls<=2)throw refusal();return {active:null};},wait:async(ms:number)=>{log.push(['wait',ms]);t+=ms;},now:()=>t,nextOrdinal:11};
 return {deps,log,get calls(){return calls;},retire:()=>{retired=true;}};}
test('two exact native refusals are recorded before a new attempt; acknowledgement is not yield proof',async()=>{
 const f=fixture(),r=await activateDuringOriginalLock(identity,f.deps);assert.equal(f.calls,3);assert.equal(r.attempt.ordinal,13);assert.equal(r.result.active,null);assert.deepEqual(f.log.map(x=>x[0]),['pending','native','refused','wait','pending','native','refused','wait','pending','native']);assert.ok(f.log.filter(x=>x[0]==='pending').every(x=>x[1].lockOrdinal===5&&x[1].targetID===4&&x[1].mission==='exact-mission'));assert.deepEqual(f.log.filter(x=>x[0]==='native').map(x=>x.slice(1)),Array(3).fill([3,{targetID:4,repeat:0}]));
});
test('unknown dispatch or post-ack error remains pending and is never retried',async()=>{const f=fixture();let calls=0;f.deps.native=async()=>{calls++;throw Error('network lost');};await assert.rejects(activateDuringOriginalLock(identity,f.deps),/network lost/);assert.equal(calls,1);assert.deepEqual(f.log.map(x=>x[0]),['pending']);});
test('spoofed message without exact structured native refusal is never retried',async()=>{const f=fixture();let calls=0;f.deps.native=async()=>{calls++;throw Object.assign(new Error('That target is not locked.'),{code:'CALL_REFUSED',status:409});};await assert.rejects(activateDuringOriginalLock(identity,f.deps));assert.equal(calls,1);assert.equal(targetNotLockedRefusal({message:'That target is not locked.'}),false);});
test('retired owner is checked after waiting before next intent or call',async()=>{const f=fixture();f.deps.wait=async()=>{f.retire();};await assert.rejects(activateDuringOriginalLock(identity,f.deps),/retired/);assert.equal(f.calls,1);assert.deepEqual(f.log.map(x=>x[0]),['pending','native','refused']);});
test('expired original lock never dispatches',async()=>{const f=fixture();f.deps.now=()=>201000;await assert.rejects(activateDuringOriginalLock(identity,f.deps),/bounded window/);assert.equal(f.calls,0);assert.equal(f.log.length,0);});
test('only structured native TARGET_NOT_FOUND retires a lock target',()=>{
 assert.equal(targetGoneRefusal({code:'CALL_REFUSED',status:409,refusal:{key:'TargetingAttemptCancelled'}}),true);
 assert.equal(targetGoneRefusal(new Error('TargetingAttemptCancelled')),false);
 assert.equal(targetGoneRefusal({code:'TIMEOUT',status:409,refusal:{key:'TargetingAttemptCancelled'}}),false);
 assert.equal(targetGoneRefusal({code:'CALL_REFUSED',status:409,refusal:{key:'TargetingSystemsAlreadyFullyUtilized'}}),false);
});


test('a current native lock arriving after the wall retry window is checked before declaring failure',async()=>{let reads=0,writes=0;const result=await activateDuringOriginalLock({characterID:1,shipID:2,moduleID:3,targetID:4,mission:'same',lockOrdinal:1,lockIssuedAt:1},{current(){},nextOrdinal:1,savePending(){},saveRefusal(){},now:()=>300001,wait:async()=>{},confirmLock:async()=>{reads++;return true;},native:async()=>{writes++;return null;}});assert.equal(result.result,null);assert.equal(reads,1);assert.equal(writes,1);});
