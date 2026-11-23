import test from 'node:test';import assert from 'node:assert/strict';
import {provesHaulSource} from './haulEvidence.ts';import type {Manifest} from './operation.ts';import type {NativeHaulSourceProof} from './nativeHauler.ts';
const manifest:Manifest={source:'native-jetcan',operationID:'op',runID:'epoch',targetKey:'BELT:300:belt',claimGeneration:1,characterID:1,shipID:11,systemID:300,containerID:900,intentGeneration:1,observedAt:1000,capacityM3:100,category:'RAW',volumeM3:10,delivered:false,items:[{itemID:100,typeID:30,quantity:10,freightKind:'RAW',unitVolumeM3:1}]};
const source=(quantity:number)=>({itemID:100,typeID:30,quantity,ownerID:1,locationID:900,flagID:5,categoryID:25});
const cargo=(itemID:number,quantity:number)=>({itemID,typeID:30,quantity,ownerID:3,locationID:13,flagID:134,categoryID:25});
const relocated:NativeHaulSourceProof={kind:'relocated-manifest-items',items:[cargo(100,10)],observedAt:1500};
test('whole original native item identity proves relocation without claiming an empty can',()=>{assert.equal(provesHaulSource(manifest,3,13,relocated,2000),true);for(const patch of [{itemID:101},{ownerID:4},{locationID:14},{quantity:9},{flagID:87}])assert.equal(provesHaulSource(manifest,3,13,{...relocated,items:[{...cargo(100,10),...patch}]},2000),false);assert.equal(provesHaulSource(manifest,3,13,{...relocated,observedAt:2001},2000),false);});
const absence={kind:'can-absent' as const,containerID:900,systemID:300,shipID:13,canOwnerID:1,canKind:'container' as const,transferCan:{position:{x:0,y:0,z:0},radius:100},transferShip:{position:{x:1000,y:0,z:0},radius:100},transferSampledAt:1100,postShip:{position:{x:1000,y:0,z:0},radius:100},postSampledAt:1200};
const batches:NativeHaulSourceProof={kind:'native-batches',batches:[{sourceBefore:[source(10)],itemID:100,typeID:30,quantity:7,sourceAfter:[source(3)],canAbsence:null,shipBefore:[],shipAfter:[cargo(101,7)]},{sourceBefore:[source(3)],itemID:100,typeID:30,quantity:3,sourceAfter:null,canAbsence:absence,shipBefore:[],shipAfter:[cargo(100,3)]}]};
test('partial batches conserve the complete source and each actual hold delta',()=>{assert.equal(provesHaulSource(manifest,3,13,batches,2000),true);const x:Extract<NativeHaulSourceProof,{kind:'native-batches'}>=structuredClone(batches);x.batches[1]!.shipAfter=[cargo(100,2)];assert.equal(provesHaulSource(manifest,3,13,x,2000),false);assert.equal(provesHaulSource(manifest,3,13,{kind:'native-batches',batches:batches.batches.slice(0,1)},2000),false);});
test('unmoved same-type cargo in another hold does not invalidate the transferred batch',()=>{
 const x=structuredClone(batches);
 assert.equal(x.kind,'native-batches');
 const outside={...cargo(105,12),flagID:181};
 const first=x.batches[0]!;
 const withBaseline={...x,batches:[{...first,shipBefore:[outside],shipAfter:[...first.shipAfter,outside]},x.batches[1]!]};
 assert.equal(provesHaulSource(manifest,3,13,withBaseline,2000),true);
 const tampered={...withBaseline,batches:[{...withBaseline.batches[0]!,shipAfter:[cargo(101,6),{...outside,quantity:13}]},x.batches[1]!]};
 assert.equal(provesHaulSource(manifest,3,13,tampered,2000),false);
});
test('can absence needs a newer same-grid observation after consuming the full source',()=>{for(const patch of [{shipID:14},{canOwnerID:2},{systemID:301},{postSampledAt:1100},{postShip:{position:{x:100000,y:0,z:0},radius:100}}]){const x:Extract<NativeHaulSourceProof,{kind:'native-batches'}>=structuredClone(batches);x.batches[1]!.canAbsence={...absence,...patch};assert.equal(provesHaulSource(manifest,3,13,x,2000),false);}const x:Extract<NativeHaulSourceProof,{kind:'native-batches'}>=structuredClone(batches);x.batches[1]!.sourceBefore=[{...source(3),itemID:999}];assert.equal(provesHaulSource(manifest,3,13,x,2000),false);});

test("ice-specific hold relocation requires an ICE target and exact whole-item quantities",()=>{const ice={...manifest,targetKey:"ICE:300:site:55:instance:89"},proof={...relocated,items:[{...cargo(100,10),flagID:181}]};assert.equal(provesHaulSource(ice,3,13,proof,2000),true);assert.equal(provesHaulSource(manifest,3,13,proof,2000),false);assert.equal(provesHaulSource(ice,3,13,{...proof,items:[{...proof.items[0]!,quantity:9}]},2000),false);});
