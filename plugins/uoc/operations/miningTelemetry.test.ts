import test from 'node:test';import assert from 'node:assert/strict';
import {miningFreightTelemetry,miningSupportTelemetry,miningMemberFreightTelemetry} from './miningTelemetry.ts';
test('old target freight remains a separate tail until native delivery, with separate categories',()=>{
 const raw={containerID:10,targetKey:'old',systemID:300,observedAt:1000,category:'RAW',volumeM3:40,items:[{typeID:1,quantity:400}],delivered:false};
 const compressed={...raw,containerID:11,category:'COMPRESSED',volumeM3:4,items:[{typeID:2,quantity:400}],delivered:true,deliveredAt:2000};
 const r=miningFreightTelemetry({operationID:'op',claim:{key:'new'},manifests:[raw,compressed],haulClaims:{'10':{characterID:7}}},{old:{target:{kind:'ORE_ANOMALY',name:'Prior site'}}});
 assert.equal(r.logisticsTail.length,1);assert.deepEqual(r.logisticsTail[0]!.pendingHaulers,[7]);
 assert.equal(r.history[0]!.kind,'FREIGHT_PUBLISHED');assert.equal(r.history[0]!.evidence.receiptAvailable,false);
 assert.equal(r.history[1]!.kind,'FREIGHT_DELIVERED');assert.equal(r.history[1]!.evidence.category,'COMPRESSED');
 assert.equal(r.history[1]!.at,new Date(2000).toISOString());
 assert.deepEqual(r.history[1]!.evidence,{containerID:11,category:'COMPRESSED',volumeM3:4,items:[{typeID:2,quantity:400}],receiptAvailable:true,timestampSource:'native-receipt'});
});
test('Mobility uses fresh Core effect and shutdown evidence independently of fitting presence',()=>{
 const v:any={active:true,movementSuspended:false,observedSupport:{observedAt:1000,observation:{state:'READY',core:'active',reason:null}},core:{current:{activation:{effect:{effectObservedAt:1000}}}}};
 let r=miningSupportTelemetry(v,1001)!;assert.equal(r.capabilities.find(x=>x.capability==='Mobility')?.state,'BLOCKED');v.core={lastInactive:{effectObservedAt:1000}};r=miningSupportTelemetry(v,1001)!;assert.equal(r.capabilities.find(x=>x.capability==='Mobility')?.state,'QUALIFIED');assert.equal(miningSupportTelemetry(v,65001)!.capabilities.find(x=>x.capability==='Mobility')?.state,'PENDING');
});
test('unknown hold quantities never become zero and relocation history keeps native proofs',()=>{
 assert.equal(miningMemberFreightTelemetry({source:'native-ship-holds',observedAt:1,holds:[{flagID:134,capacityM3:100,rawM3:undefined}]},null,1,{}),null);
 const r=miningFreightTelemetry({operationID:'op',manifests:[],relocationHistory:[{completedAt:1000,newClaim:{key:'new'},oldClaim:{key:'old'},next:{kind:'BELT',systemID:300,name:'Next'},proofs:[{source:'native-flight'}]}]});assert.equal(r.history[0]?.kind,'TARGET_RELOCATED');assert.equal((r.history[0]?.evidence as any).proofs[0].source,'native-flight');
});
test('current compression facility requires the same native claim, owner generation and fresh independent effects',()=>{
 const at=1000,op={state:'ACTIVE',systemID:300,claim:{key:'target',generation:2}},f={claimKey:'target',claimGeneration:2,systemID:300,commanderCharacterID:3,commanderShipID:13,commanderSessionGeneration:7,minerSessionGeneration:8,fleetID:900,observedAt:at,sceneSampledAt:at,coreModuleID:50,compressorModuleID:51,rangeMeters:1000,surfaceDistanceMeters:50,matchingTypeListIDs:[10],sourceTypeID:30,compressedTypeID:31},value={source:'native-ship-holds',observedAt:at,primaryHoldFlagID:134,holds:[{flagID:134,capacityM3:100,rawM3:50,compressedM3:0,rawQuantity:50,compressedQuantity:0}],facility:f};
 const support:any={active:true,characterID:3,shipID:13,sessionGeneration:7,movementSuspended:false,observedSupport:{observedAt:at,observation:{state:'READY',core:'active'}},core:{identity:{moduleID:50},current:{activation:{effect:{effectObservedAt:at}}}},compressor:{identity:{moduleID:51,effectID:99},current:{active:{observedAt:at}}}};
 assert.equal(miningMemberFreightTelemetry(value,op,1,{},support,1001)?.facility?.shipID,13);assert.equal(miningMemberFreightTelemetry(value,{...op,claim:{key:'other',generation:2}},1,{},support,1001)?.facility,null);assert.equal(miningMemberFreightTelemetry(value,op,1,{},support,65001)?.facility,null);
 // New native inactive observation outranks a still-recent original activation receipt.
 support.coreObservation={core:{active:false},effectObservedAt:at};assert.equal(miningMemberFreightTelemetry(value,op,1,{},support,1001)?.facility,null);
});
test('a fit or activation ACK never yields a qualified support effect; stale samples remain pending',()=>{
 const value={active:true,observedSupport:{observedAt:1000,observation:{state:'READY',core:'active',reason:null}},core:{current:{activation:{acknowledged:true,effect:null}}}};
 let r=miningSupportTelemetry(value,1001)!;assert.equal(r.capabilities[1]!.state,'PENDING');
 value.core.current.activation.effect={effectObservedAt:1000} as any;
 r=miningSupportTelemetry(value,1001)!;assert.equal(r.capabilities[1]!.state,'QUALIFIED');
 r=miningSupportTelemetry(value,65001)!;assert.equal(r.state,'PENDING');assert.equal(r.capabilities[1]!.state,'PENDING');
});
