import test from 'node:test';import assert from 'node:assert/strict';import {createCivilianIndex,createCivilianCheckpointsRoute} from './index.ts';
const row={worldID:'world-a',owner:'pilot',characterID:3,botID:'one',kind:'mining' as const,status:'paused',phase:'blocked',pending:'complete',firstFailure:null,resolved:false,updatedAt:1};
test('index filters verified world and owner and never promotes stored checkpoint to native proof',async()=>{let state:any=null;const doc={read:()=>state,write:(v:any)=>state=structuredClone(v)};createCivilianIndex(doc).put(row);const route=createCivilianCheckpointsRoute(()=>({doc,close(){}}));const result:any=await route({worldID:'world-a',account:{username:'PILOT'},params:{},query:{}} as any);assert.equal(result.body.recovery[0].scope,'STORED_ONLY');assert.equal(result.body.recovery[0].characterID,3);assert.equal((await route({worldID:'other',account:{username:'PILOT'},params:{},query:{}} as any) as any).body.recovery.length,0);assert.equal((await route({worldID:'world-a',account:{username:'OTHER'},params:{},query:{}} as any) as any).body.recovery.length,0);assert.throws(()=>createCivilianIndex(doc).put({...row,owner:'other'}),/identity changed/);});

test('lost index restores a proven orphan without replacing a newer indexed worker or inferring owner release',async()=>{let state:any=null;const doc={read:()=>state,write:(v:any)=>state=structuredClone(v)},route=createCivilianCheckpointsRoute(()=>({doc,close(){}}),()=>[row]);const request={worldID:'world-a',account:{username:'PILOT'},params:{},query:{}} as any;let result:any=await route(request);assert.equal(result.body.history[0].botID,'one');assert.equal(result.body.history[0].ownerAvailable,false);assert.equal(result.body.recovery.length,1);createCivilianIndex(doc).put({...row,phase:'newer evidence',updatedAt:2});result=await route(request);assert.equal(result.body.history[0].phase,'newer evidence');});

test('worker discovery includes completed history once and stays in the requested world', () => {
 let state: unknown = null;
 const index = createCivilianIndex({read: () => state, write: value => { state = structuredClone(value); }});
 const completed = {...row, status: 'stopped', phase: 'Completed', pending: null, resolved: true};
 index.put(completed);
 index.put({...completed, botID: 'previous'});
 index.put({...completed, worldID: 'world-b', owner: 'other-pilot', botID: 'other'});
 assert.deepEqual(index.workerAccounts('world-a'), ['pilot']);
 assert.deepEqual(index.workerAccounts('world-b'), ['other-pilot']);
 assert.deepEqual(index.workerAccounts('world-missing'), []);
});

test('durable accepted identity fills an older index row without overriding a fresh native refusal',async()=>{
 let state:any=null;
 const doc={read:()=>state,write:(v:any)=>state=structuredClone(v)},index=createCivilianIndex(doc);
 const acceptedMission={agentID:42,missionID:900,key:'accepted'};
 const worker={startedAt:'',expiresAt:null,characterName:null,why:null,readout:{acceptedMission}};
 const route=createCivilianCheckpointsRoute(()=>({doc,close(){}}),()=>[{...row,worker}]);
 const request={worldID:'world-a',account:{username:'PILOT'},params:{},query:{}} as any;
 index.put(row);
 assert.deepEqual((await route(request) as any).body.history[0].acceptedMission,acceptedMission);
 index.put({...row,status:'stopped',phase:'Docked',worker:{...worker,readout:{acceptedMission:null}},updatedAt:2});
 assert.deepEqual((await route(request) as any).body.history[0].acceptedMission,acceptedMission);
 index.put({...row,status:'error',phase:'Needs attention',worker:{...worker,readout:{acceptedMission:null}},updatedAt:3});
 assert.equal((await route(request) as any).body.history[0].acceptedMission,null);
});
