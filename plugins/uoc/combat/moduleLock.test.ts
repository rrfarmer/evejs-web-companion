import test from 'node:test';import assert from 'node:assert/strict';import {executeCombatTargetLock} from './moduleLock.ts';
test('one acknowledged native lock is shared by module actions for the exact scoped target',async()=>{let document:unknown=null,calls=0;const deps={document:{read:()=>document,write:(v:unknown)=>{document=structuredClone(v);}},current:()=>{},fence:async()=>{},lock:async()=>{calls++;},now:()=>1},id={key:'room/target',characterID:1,shipID:2,targetID:3};await executeCombatTargetLock(id,deps);await executeCombatTargetLock(id,deps);assert.equal(calls,1);await assert.rejects(executeCombatTargetLock({...id,targetID:4},deps),/another identity/);});
test('unknown lock dispatch is retained without replay',async()=>{let document:unknown=null,calls=0;const deps={document:{read:()=>document,write:(v:unknown)=>{document=structuredClone(v);}},current:()=>{},fence:async()=>{},lock:async()=>{calls++;throw Error('timeout');},now:()=>1},id={key:'room/target',characterID:1,shipID:2,targetID:3};await assert.rejects(executeCombatTargetLock(id,deps),/timeout/);await assert.rejects(executeCombatTargetLock(id,deps),/unresolved/);assert.equal(calls,1);});

test("a definitive native targeting cancellation allows a fresh scoped attempt",async()=>{
 let document:unknown=null,calls=0;
 const cancelled=Object.assign(Error("TargetingAttemptCancelled"),{code:"CALL_REFUSED",status:409,refusal:{key:"TargetingAttemptCancelled"}});
 const deps={document:{read:()=>document,write:(v:unknown)=>{document=structuredClone(v);}},
  current:()=>{},fence:async()=>{},lock:async()=>{if(++calls===1)throw cancelled;},now:()=>1,
  definiteRefusal:(error:unknown)=>error===cancelled};
 const id={key:"target/1",characterID:1,shipID:2,targetID:3};
 assert.equal(await executeCombatTargetLock(id,deps),"refused");
 assert.equal(await executeCombatTargetLock(id,deps),"refused");
 await executeCombatTargetLock({...id,key:"target/2"},deps);
 assert.equal(calls,2);
 assert.deepEqual((document as {entries:{status:string}[]}).entries.map(e=>e.status),["REFUSED","ACKNOWLEDGED"]);
});
