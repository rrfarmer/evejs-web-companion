import test from 'node:test';import assert from 'node:assert/strict';
import {retainedMiningRecovery,dispatchFinish,acceptFinish,setupHash} from './miningRecovery.ts';
import {projectFleetRun} from './miningReadout.ts';
import type {FleetLaunchReceipt} from './miningLaunchJournal.ts';
const setup={operationID:'op',operationRunID:'old',members:[{characterID:1,shipID:11,role:'MINER'}]};
const receipt:FleetLaunchReceipt={version:1,operationID:'op',operationRunID:'old',revision:1,planHash:'p',setupHash:setupHash(setup),members:[{characterID:1,accountName:'a',role:'MINER',kind:'mcc-miner',beforeIDs:[],status:'ACCEPTED',botID:'original'}]};
function document(){let value:unknown=null;return {read:()=>structuredClone(value),write:(v:unknown)=>{value=structuredClone(v);}};}
test('retained FINISH pins original generation, survives a lost response and never dispatches twice',()=>{
 const doc=document(),review=retainedMiningRecovery(receipt,setup,structuredClone(setup),doc);
 dispatchFinish(review,doc,1,['old-finish']);
 const resumed=retainedMiningRecovery(receipt,setup,setup,doc);
 assert.equal(resumed.attempts[0]?.botID,null);assert.throws(()=>dispatchFinish(resumed,doc,1,[]),/differs from the retained attempt/);
 assert.throws(()=>acceptFinish(resumed,doc,1,'old-finish'),/receipt/);
 acceptFinish(resumed,doc,1,'finish');
 assert.equal(retainedMiningRecovery(receipt,setup,setup,doc).attempts[0]?.botID,'finish');
 assert.throws(()=>retainedMiningRecovery(receipt,{...setup,operationRunID:'new'},setup,doc),/original launch setup/);
 assert.throws(()=>retainedMiningRecovery(receipt,setup,{...setup,members:[]},doc),/original launch setup/);
});
test('a legacy generation is recoverable only when the literal retained setup proves its original hash',()=>{
 assert.equal(retainedMiningRecovery(receipt,null,setup,document()).operationRunID,'old');
 assert.throws(()=>retainedMiningRecovery({...receipt,setupHash:'missing'},null,setup,document()),/original launch setup/);
 const doc=document();doc.write({version:1,setupHash:receipt.setupHash,attempts:[{characterID:9,accountName:'other',beforeIDs:[],botID:null,dispatchedAt:1}]});
 assert.throws(()=>retainedMiningRecovery(receipt,setup,setup,doc),/journal/);
});
test('terminal host rows do not replace native group settlement and independent offline release',()=>{
 const terminal={botID:'original',characterID:1,kind:'plugin',plugin:{pluginID:'uoc',run:'mcc-miner'},status:'stopped',phase:'Docked',why:null,startedAt:'2026-01-01',endedAt:'2026-01-02',expiresAt:null};
 assert.equal(projectFleetRun(receipt,new Map([[1,{owners:[],bots:[terminal],offline:true}]]),[],'UNKNOWN').state,'UNKNOWN');
 assert.equal(projectFleetRun(receipt,new Map([[1,{owners:[],bots:[],offline:false}]]),[],'STOPPED').state,'UNKNOWN');
 assert.equal(projectFleetRun(receipt,new Map([[1,{owners:[],bots:[],offline:true}]]),[],'STOPPED').state,'STOPPED');
 const prepared={...receipt,members:receipt.members.map(m=>({...m,status:'PREPARED' as const,botID:null}))};
 assert.equal(projectFleetRun(prepared,new Map(),[],'UNKNOWN').members[0]?.runtimeState,'NOT_STARTED');
});
test('a pending FINISH receipt follows its exact current owner instead of the original mining bot',()=>{
 const attempt={characterID:1,accountName:'a',beforeIDs:['original'],dispatchedAt:1,botID:null},owner={botID:'finish',characterID:1,operationID:'op',operationRunID:'old'},bot={botID:'finish',characterID:1,kind:'plugin',plugin:{pluginID:'uoc',run:'mcc-finish'},status:'running',phase:'Reconciling',why:null,startedAt:'2026-11-08',endedAt:null,expiresAt:'2026-11-09',maxRuntimeMinutes:60};
 const p=projectFleetRun(receipt,new Map([[1,{owners:[owner],bots:[bot]}]]),[attempt],'UNKNOWN');assert.equal(p.state,'RUNNING');assert.equal(p.members[0]?.botID,'finish');assert.equal((p.members[0] as any).maxRuntimeMinutes,60);
});

test("explicit replacement retains original FINISH attempt and fences late acceptance",()=>{
 const doc=document(),review=()=>retainedMiningRecovery(receipt,setup,setup,doc);
 const first=dispatchFinish(review(),doc,1,[]);
 const second=dispatchFinish(review(),doc,1,[],{dispatchedAt:first.dispatchedAt,botID:null});
 assert.equal((doc.read() as any).priorAttempts[0].dispatchedAt,first.dispatchedAt);
 assert.throws(()=>acceptFinish(review(),doc,1,"obsolete",first.dispatchedAt),/receipt/);
 acceptFinish(review(),doc,1,"new-finish",second.dispatchedAt);
 assert.equal(review().attempts[0]?.botID,"new-finish");
});
