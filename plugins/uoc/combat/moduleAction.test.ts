import test from 'node:test';
import assert from 'node:assert/strict';
import {executeCombatModuleAction,type CombatModuleAction,type CombatModuleActionDeps} from './moduleAction.ts';

const action:CombatModuleAction={key:'room-1/target-2/module-3',characterID:1,shipID:2,moduleID:3,typeID:4,targetID:5,kind:'weapon'};
function fixture(){let doc:unknown=null,clock=1,calls=0,active=false;const d:CombatModuleActionDeps={document:{read:()=>doc,write:v=>{doc=structuredClone(v);}},current:()=>{},fence:async()=>{},observed:async()=>active,activate:async()=>{calls++;active=true;},sleep:async ms=>{clock+=ms;},now:()=>clock};return {d,get calls(){return calls;},get doc(){return doc;},setActive(v:boolean){active=v;}};}
test('native effect confirms one dispatch, and a repeated tick does not dispatch again',async()=>{const f=fixture();await executeCombatModuleAction(action,f.d);await executeCombatModuleAction(action,f.d);assert.equal(f.calls,1);assert.equal((f.doc as any).entries[0].status,'CONFIRMED');});
test('unknown write remains durable and is never replayed without positive native effect',async()=>{const f=fixture();let calls=0;f.d.activate=async()=>{calls++;throw Error('transport lost');};await assert.rejects(executeCombatModuleAction(action,f.d),/transport lost/);await assert.rejects(executeCombatModuleAction(action,f.d),/unresolved/);assert.equal(calls,1);f.setActive(true);await executeCombatModuleAction(action,f.d);assert.equal((f.doc as any).entries[0].status,'CONFIRMED');assert.equal(calls,1);});
test('only exact pre-effect target-not-locked refusal permits another activation',async()=>{const f=fixture();let calls=0;f.d.activate=async()=>{calls++;if(calls===1)throw {code:'CALL_REFUSED',status:409,message:'That target is not locked.',refusal:{key:'CustomNotify',values:{type:'dict',entries:[['notify','That target is not locked.']]}}};f.setActive(true);};await executeCombatModuleAction(action,f.d);assert.equal(calls,2);});
test('foreign action using the same journal key and failed ownership fence cannot dispatch',async()=>{const f=fixture();await executeCombatModuleAction(action,f.d);await assert.rejects(executeCombatModuleAction({...action,targetID:6},f.d),/different identity/);const g=fixture();g.d.fence=async()=>{throw Error('owner changed');};await assert.rejects(executeCombatModuleAction(action,g.d),/owner changed/);assert.equal(g.calls,0);assert.equal(g.doc,null);});
test('an unresolved command blocks a different target for the same module',async()=>{const f=fixture();let calls=0;f.d.activate=async()=>{calls++;throw Error('unknown');};await assert.rejects(executeCombatModuleAction(action,f.d),/unknown/);await assert.rejects(executeCombatModuleAction({...action,key:'room-1/target-6/module-3',targetID:6},f.d),/another command/i);assert.equal(calls,1);});
test('a refused lock is not replayed after the original invocation ends',async()=>{const f=fixture();let calls=0;f.d.activate=async()=>{calls++;throw {code:'CALL_REFUSED',status:409,message:'That target is not locked.',refusal:{key:'CustomNotify',values:{type:'dict',entries:[['notify','That target is not locked.']]}}};};f.d.sleep=async()=>{throw Error('stopped');};await assert.rejects(executeCombatModuleAction(action,f.d),/stopped/);await assert.rejects(executeCombatModuleAction(action,f.d),/original target lock invocation ended/i);assert.equal(calls,1);});
test('an acknowledged fast disappearance is retired only by explicit inactive-module and same-room proof',async()=>{const f=fixture();let calls=0,read=0;f.d.activate=async()=>{calls++;};f.d.fence=async()=>{if(++read>1)throw Error('target absent');};f.d.targetAbsent=async(_a,e)=>e instanceof Error&&e.message==='target absent';assert.equal(await executeCombatModuleAction(action,f.d),'target-absent');assert.equal((f.doc as any).entries[0].status,'SETTLED_ABSENT');assert.equal(calls,1);assert.equal(await executeCombatModuleAction(action,f.d),'target-absent');assert.equal(calls,1);});
test('absence is never used to clear an unknown dispatch',async()=>{const f=fixture();let checks=0;f.d.activate=async()=>{throw Error('lost');};f.d.targetAbsent=async()=>{checks++;return true;};await assert.rejects(executeCombatModuleAction(action,f.d),/lost/);await assert.rejects(executeCombatModuleAction(action,f.d),/unresolved/);assert.equal(checks,0);});

test('Defender observes a lost response on its own module without replaying it or blocking another weapon',async()=>{
 const f=fixture(),writes:number[]=[];
 f.d.observeWeapon=async()=> 'inactive';
 f.d.activate=async a=>{writes.push(a.moduleID);if(a.moduleID===3)throw Error('response lost');f.setActive(true);};
 assert.equal(await executeCombatModuleAction(action,f.d),'pending');
 assert.equal(await executeCombatModuleAction(action,f.d),'pending');
 assert.equal(await executeCombatModuleAction({...action,key:'next-hostile',targetID:6},f.d),'pending');
 let reads=0;
 f.d.observeWeapon=async a=>{reads++;return a.moduleID===7?'active':'inactive';};
 const other={...action,key:'other-weapon',moduleID:7,targetID:6};
 assert.equal(await executeCombatModuleAction(other,f.d),'pending');
 assert.equal(reads,0);
 assert.deepEqual((f.doc as any).entries.map((e:any)=>e.status),['DISPATCHED','ACKNOWLEDGED']);
 assert.equal(await executeCombatModuleAction(other,f.d),undefined);
 assert.equal(reads,1);
 assert.deepEqual(writes,[3,7]);
 assert.deepEqual((f.doc as any).entries.map((e:any)=>e.status),['DISPATCHED','CONFIRMED']);
});

test('a definite already-active refusal is resolved by the matching native effect even after Stop',async()=>{
 const f=fixture();let stopped=false,writes=0;
 f.d.reacquireLock=true;f.d.current=()=>{if(stopped)throw Error('Stop');};f.d.receiptCurrent=()=>{};
 f.d.activate=async()=>{writes++;f.setActive(true);stopped=true;throw {status:409,code:'CALL_REFUSED',refusal:{key:'EffectAlreadyActive2'}};};
 assert.equal(await executeCombatModuleAction(action,f.d),undefined);
 assert.equal((f.doc as any).entries[0].status,'CONFIRMED');assert.equal(writes,1);
});
test('Defender requires a fresh lock generation after a definite lock refusal',async()=>{
 const f=fixture();let writes=0;
 f.d.reacquireLock=true;
 f.d.activate=async()=>{writes++;if(writes===1)throw {code:'CALL_REFUSED',status:409,message:'That target is not locked.',refusal:{key:'CustomNotify',values:{type:'dict',entries:[['notify','That target is not locked.']]}}};f.setActive(true);};
 assert.equal(await executeCombatModuleAction(action,f.d),'lock-lost');
 assert.equal(await executeCombatModuleAction(action,f.d),'lock-lost');
 assert.equal(await executeCombatModuleAction({...action,key:action.key+'/reacquired'},f.d),undefined);
 assert.equal(writes,2);assert.deepEqual((f.doc as any).entries.map((e:any)=>e.status),['LOCK_REFUSED','CONFIRMED']);
});

test("a confirmed optional refusal retires only the affected module action",async()=>{
 const f=fixture();let calls=0;
 const refusal={code:"CALL_REFUSED",status:409,refusal:{key:"NoCharges"}};
 f.d.optionalRefusal=error=>error===refusal?"NoCharges":null;
 f.d.activate=async()=>{if(++calls===1)throw refusal;f.setActive(true);};
 assert.equal(await executeCombatModuleAction(action,f.d),"unavailable");
 assert.equal(await executeCombatModuleAction(action,f.d),"unavailable");
 assert.equal(await executeCombatModuleAction({...action,key:"other-weapon",moduleID:6},f.d),undefined);
 assert.equal(calls,2);
 assert.deepEqual((f.doc as any).entries.map((e:any)=>e.status),["REFUSED","CONFIRMED"]);
});
