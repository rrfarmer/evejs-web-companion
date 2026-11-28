import test from 'node:test';import assert from 'node:assert/strict';
import {preparationEvidence,retainPreparation} from './miningEvidence.ts';
test('durable native preparation survives loss of host rows but never crosses world/run/ship scope',()=>{
 let stored:any=null;const doc={read:()=>stored,write:(v:unknown)=>{stored=structuredClone(v);}},scope={world:'world',operationID:'op',operationRunID:'run',characterID:1,shipID:11,role:'MINER'};
 retainPreparation(doc,'world','prepare-original',{...scope,state:'DEGRADED',equipment:'VERIFIED',supplies:'LOW',targets:[],observedAt:1000,fittingName:'Exact fit'});
 const projected=preparationEvidence(doc.read(),scope)!;assert.equal(projected.fittingName,'Exact fit');assert.equal(projected.historical,true);for(const change of [{world:'other'},{operationRunID:'other'},{shipID:12},{characterID:2}])assert.equal(preparationEvidence(stored,{...scope,...change}),null);
});
