import test from 'node:test';import assert from 'node:assert/strict';
import {createFleetTelemetry,readFleetTelemetry} from './telemetry.ts';
import {operationAllowsFinish,registerRun} from '../runControl.ts';
import {createHaulerTelemetry} from './haulerTelemetry.ts';
test('last native hold read and exact target history survive a restart as inactive metadata',()=>{
 let row:unknown=null,now=100;const doc={read:()=>structuredClone(row),write:(v:unknown)=>{row=structuredClone(v);}};
 const telemetry=createFleetTelemetry(doc,'op','generation',()=>now),member={characterID:1,shipID:11,role:'MINER',botID:'host',active:true,phase:'Mining',reason:null,reportedAt:now,freight:{observedAt:90,source:'native-ship-holds'}};
 telemetry.target({kind:'BELT',systemID:300,name:'Belt'},{key:'belt'},{source:'native-belt-selection'});telemetry.persist(telemetry.sample([member]));
 now=200;telemetry.persist(telemetry.sample([{...member,freight:null}],true));const restored=readFleetTelemetry(doc,'op','generation')!;
 assert.equal(restored.members[0]?.active,false);assert.equal((restored.members[0]?.freight as any).observedAt,90);assert.equal(restored.startedAt,100);assert.equal(restored.stoppedAt,200);assert.equal(restored.history?.[0]?.kind,'TARGET_SELECTION');assert.equal(readFleetTelemetry(doc,'op','other'),null);
});
test('concurrent retained actors are admitted only alongside exact FINISH owners',()=>{
 const a=registerRun({botID:'telemetry-a',characterID:8001,setup:{operationID:'telemetry-op',operationRunID:'old'}},'a',()=>{});
 try{assert.equal(operationAllowsFinish('telemetry-op','old'),false);}finally{a();}
 const b=registerRun({botID:'telemetry-b',characterID:8001,setup:{operationID:'telemetry-op',operationRunID:'old'}},'a',()=>{},'mcc-finish');
 try{assert.equal(operationAllowsFinish('telemetry-op','old'),true);assert.equal(operationAllowsFinish('telemetry-op','new'),false);}finally{b();}
});
test('hauler readout conserves native quantities and refuses unknown types or stale capacity',()=>{
 let now=100;const t=createHaulerTelemetry(()=>now);t.capacity([{key:'ore',present:true,capacity:{capacity:100,used:0},error:null}],'ore');t.facts({30:{categoryID:25,unitVolumeM3:2,freightKind:'RAW',resourceFamily:'ore'}});
 t.cargo([{itemID:1,typeID:30,quantity:10,ownerID:7,locationID:17,flagID:134,categoryID:25}]);assert.equal(t.snapshot()?.holds[0]?.rawM3,20);assert.equal(t.snapshot()?.holds[0]?.rawQuantity,10);
 t.cargo([{itemID:1,typeID:999,quantity:10,ownerID:7,locationID:17,flagID:134,categoryID:25}]);assert.equal(t.snapshot(),null);now=70000;assert.equal(t.snapshot(),null);
});

test('fleet polling cannot rewrite a locality decision timestamp or evict history with repeated same-generation selections',()=>{
 let now=100;const t=createFleetTelemetry({read:()=>null,write(){}},'op','run',()=>now),target={kind:'BELT',systemID:300,name:'Native Belt'},claim={key:'BELT:300:Native Belt',generation:1},evidence={observedAt:90,policy:'PREFER_FLEET_LOCALITY'};
 t.target(target,claim,evidence);now=200;for(let i=0;i<150;i++)t.target(target,claim,evidence);let history=t.sample([]).history!;assert.equal(history.length,1);assert.equal(history[0]?.at,new Date(100).toISOString());
 t.target(target,{...claim,generation:2},{...evidence,observedAt:200});history=t.sample([]).history!;assert.equal(history.length,2);
});
