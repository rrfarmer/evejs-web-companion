import test from 'node:test';import assert from 'node:assert/strict';
import {civilianRecordEvidence,civilianOrphans} from './records.ts';
import {bindCivilianScope,registerCivilianRecovery} from './recovery.ts';
import {createCivilianRecoveryRoute} from './index.ts';

// Synthetic accepted-cycle checkpoint with no native dispatch receipt.
const checkpoint={version:2,characterID:31,agentID:51,shipID:71,phase:'mining',pending:null,banked:10000,shipQuantity:1200,
 objective:{content:{contentID:92,quantity:16000},missionState:2,completionStatus:0},
 cycle:{status:'accepted',moduleID:72,targetID:73,quantityBefore:1200,observedAtMs:1000,deadlineMs:46000}};
test('docking and release do not settle an accepted mining cycle with no dispatch receipt',()=>{
 const unchanged=structuredClone(checkpoint),park={state:'PARKED',dockedAt:'2025-01-01T00:00:01Z',releasedAt:'2025-01-01T00:00:02Z'};
 const result=civilianRecordEvidence({...checkpoint,parking:park},'mining');assert.equal(result.cycle,'UNKNOWN');assert.equal(result.pending,null);assert.equal(result.legacyCycle,true);assert.equal(result.missionSettled,false);assert.equal(result.objectiveState,0);assert.equal(result.banked,10000);assert.equal(result.quantity,1200);assert.match(result.reason,/No Activate replay/);assert.deepEqual(checkpoint,unchanged);
});
const row={worldID:'world-a',owner:'owner',characterID:3,botID:'original',kind:'mining' as const,status:'paused',phase:'Docked',pending:'mining-cycle',firstFailure:'cycle unresolved',resolved:false,updatedAt:1};
test('orphan restoration requires exact durable world/account/pilot provenance; anonymous and foreign records stay withheld',()=>{
 const value={version:1,characterID:3,completed:false,pending:{kind:'mining-cycle'},civilian:row};
 assert.equal(civilianOrphans([{value,kind:'mining'}],'world-a','OWNER').length,1);
 for(const [world,owner] of [['world-b','owner'],['world-a','other']])assert.deepEqual(civilianOrphans([{value,kind:'mining'}],world!,owner!),[]);
 assert.deepEqual(civilianOrphans([{value:{...value,civilian:undefined},kind:'mining'}],'world-a','owner'),[]);
 assert.throws(()=>civilianRecordEvidence({version:1,completed:true,characterID:3,pending:null},'mining'),/identity|setup|receipt|custody|history|state/i);
});
test('read-only Recovery addresses only the exact existing owner; missing owner never logs in or dispatches',async()=>{
 let inspected=0;const run={botID:'original',characterID:3} as any;bindCivilianScope(run,()=>row);const unregister=registerCivilianRecovery(run,async()=>{inspected++;return {nativeReconciled:false,cycle:'UNKNOWN',reason:'Exact Activate remains unknown.'};});
 const doc={read:()=>({version:1,rows:[row]}),write(){throw Error('No index mutation expected');}},route=createCivilianRecoveryRoute(()=>({doc,close(){}}));
 const request={worldID:'world-a',account:{username:'OWNER'},params:{botID:'original'}} as any;
 assert.equal(((await route(request)) as any).body.recovery.scope,'EXISTING_OWNER');assert.equal(inspected,1);
 assert.equal(((await route({...request,worldID:'other'})) as any).status,404);assert.equal(inspected,1);
 unregister();const result:any=await route(request);assert.equal(result.body.recovery.scope,'STORED_ONLY');assert.equal(result.body.recovery.nativeReconciled,false);assert.equal(inspected,1);
});

test('orphan History counts distinct exact native completion receipts, never done flags or duplicate archive entries',()=>{
 const civilian={...row,kind:'distribution' as const,worker:{startedAt:'2026-11-08T00:00:00Z',expiresAt:null,characterName:null,why:null,readout:{completedCount:0}}};
 const record=(key:string)=>({characterID:3,runID:'original',done:true,mutated:true,pending:null,mission:{agentID:4,missionKey:key},civilian,completion:{kind:'missionCompletion',completed:true,runID:'original',agentID:4,missionKey:key,invocationID:1,actionID:6,stepPath:'complete'},reward:{confirmedIsk:'0.00',withheldIsk:'100.00'}});
 const a=record('a'),b=record('b');const restored=civilianOrphans([a,b,a].map(value=>({value,kind:'distribution'})),'world-a','owner');assert.equal(restored.length,1);assert.equal((restored[0]!.worker!.readout as any).completedCount,2);assert.equal((restored[0]!.worker!.readout as any).reward.withheldIsk,'100.00');assert.equal(civilianRecordEvidence({...a,completion:undefined},'distribution').missionSettled,false);
});
