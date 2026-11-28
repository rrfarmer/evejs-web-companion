import test from 'node:test';import assert from 'node:assert/strict';
import {rankLocality,observeLocality,type LocalityRead} from './locality.ts';
import {createOperation} from './operation.ts';
import {memoryOperationStore} from './operationStoreFixture.ts';
import {createTargetBoard,type BeltTarget} from './targetBoard.ts';
const read=(id:number,x:number,role='MINER',observedAt=1000):LocalityRead=>({characterID:id,shipID:id+10,role,observedAt,systemID:300,position:{x,y:0,z:0},belts:[]});
const belt=(name:string,x:number|null)=>({target:{kind:'BELT' as const,systemID:300,name},position:x===null?null:{x,y:0,z:0}});
test('WC74 median main-body ranking excludes haulers and stale/future miner positions',()=>{
 const r=rankLocality([belt('Alpha',10000000),belt('Zulu',1000)],[read(1,0),read(2,2000),read(3,10000000),read(4,10000000,'HAULER'),read(5,10000000,'MINER',-20000),read(6,10000000,'MINER',2000)],1001);
 assert.equal(r.ranked[0]?.candidate.target.name,'Zulu');assert.equal(r.ranked[0]?.medianDistanceM,1000);assert.equal(r.ranked[0]?.anchorCount,3);assert.equal(r.evidence.anchors.length,3);assert.equal(r.evidence.policy,'PREFER_FLEET_LOCALITY');
});
test('one missing candidate position makes every score unknown and preserves name/key fallback',()=>{
 const r=rankLocality([belt('Zulu',0),belt('Alpha',null)],[read(1,0)],1001);assert.equal(r.ranked[0]?.candidate.target.name,'Alpha');assert.ok(r.ranked.every(x=>x.medianDistanceM===null&&x.reason==='DETERMINISTIC_NO_FRESH_LOCALITY'));
});
test('native held scene supplies positions; lagging simulation time is not an invented distance or wall age',async()=>{
 let mode='STOP';const transition={phase:'ready',sessionStable:true,locationReady:true,sceneReady:true,egoReady:true,shipReady:true,boundContextReady:true};
 const peer:any={shipID:11,role:'MINER',current(){},session:{flow:{requestOptions:()=>({})}},run:{characterID:1,baseUrl:'http://fixture',fetch:async(input:any)=>Response.json({ok:true,...(new URL(input).pathname.endsWith('/status')?{flight:{shipID:11,solarSystemID:300,inSpace:true,docked:false,shipMode:mode,transition}}:{space:{stateValid:true,inSpace:true,shipID:11,solarSystemID:300,sampledAtMs:1,ship:{itemID:11,characterID:1,mode,position:{x:5,y:6,z:7},radius:1},entities:[{itemID:900,kind:'celestial',groupID:9,name:'Native Belt',position:{x:8,y:9,z:10},radius:1}]}})})}};
 let r=await observeLocality(peer,300);assert.deepEqual(r.position,{x:5,y:6,z:7});assert.equal(r.belts[0]?.beltID,900);mode='WARP';r=await observeLocality(peer,300);assert.equal(r.position,null);assert.deepEqual(r.belts,[]);
});

test('fresh local ore restores a depleted belt and lets the same run select it again',async()=>{
 const oldBelt:BeltTarget={kind:'BELT',systemID:300,name:'Belt 1'};
 const currentBelt:BeltTarget={kind:'BELT',systemID:300,name:'Belt 2'};
 let document:unknown=null;
 const storage={read:()=>document,write:(value:unknown)=>{document=value;}};
 const board=createTargetBoard(storage);
 const op=createOperation(memoryOperationStore(),board,{operationID:'op',runID:'run',systemID:300,destinationID:600,
  members:[{characterID:1,shipID:11,role:'MINER'},{characterID:2,shipID:12,role:'HAULER'}]});
 const old=op.reserve(1,oldBelt)!;
 assert.ok(op.activate(1));
 const emptyAt=Date.now()-1000;
 assert.ok(board.noteDepletion(old,{source:'checked-empty-grid',key:old.key,observedAt:emptyAt}));
 assert.ok(op.prepareRelocation(1,old,currentBelt,900));
 assert.ok(op.drainRelocation(true));
 const minerProof={runID:'run',shipID:11,observedAt:Date.now()};
 assert.ok(op.settleMember(1,{...minerProof,source:'native-settlement',modulesInactive:true,dronesSafe:true}));
 assert.ok(op.relocateAfterSettlement([{...minerProof,source:'native-flight',characterID:1,systemID:300,inSpace:true,docked:false}]));
 assert.ok(op.activate(1));
 const current=op.snapshot().claim!;
 assert.ok(op.snapshot().relocatedKeys?.includes(old.key));
 assert.equal(board.read(old.key)?.state,'DRAINING');

 const position=(x:number)=>({x,y:0,z:0});
 let x=1_000_000,mode='STOP',quantity=20;
 const transition={phase:'ready',sessionStable:true,locationReady:true,sceneReady:true,egoReady:true,shipReady:true,boundContextReady:true};
 const peer={shipID:11,role:'MINER',current(){},session:{flow:{requestOptions:()=>({})}},run:{characterID:1,baseUrl:'http://fixture',async fetch(input:URL){
  if(new URL(input).pathname.endsWith('/status'))return Response.json({ok:true,flight:{shipID:11,solarSystemID:300,inSpace:true,docked:false,shipMode:mode,transition}});
  return Response.json({ok:true,space:{stateValid:true,inSpace:true,shipID:11,solarSystemID:300,sampledAtMs:1,
   ship:{itemID:11,characterID:1,position:position(x),radius:1,mode},entities:[
    {itemID:900,groupID:9,name:'Belt 1',position:position(0),radius:100},
    {itemID:901,groupID:9,name:'Belt 2',position:position(1_000_000),radius:100},
    {itemID:902,kind:'asteroid',categoryID:25,position:position(20),remainingQuantity:quantity,radius:1},
   ]}});
 }}} as Parameters<typeof observeLocality>[0];
 const observe=()=>observeLocality(peer,300,board);
 x=0;
 await observe();
 assert.equal(board.read(old.key)?.state,'DRAINING');
 assert.ok(op.finishFreightTailScan(2,old));
 assert.ok(op.heartbeat());
 assert.equal(board.read(old.key)?.state,'DEPLETED');
 assert.equal(op.prepareRelocation(1,current,oldBelt,901),false);
 assert.equal(board.observeRestoredBelt(oldBelt,emptyAt),false);
 x=1_000_000;await observe();
 x=0;mode='WARP';await observe();
 mode='STOP';quantity=0;await observe();
 assert.equal(board.read(old.key)?.state,'DEPLETED');
 quantity=20;await observe();
 assert.equal(createTargetBoard(storage).read(old.key)?.state,'AVAILABLE');
 assert.equal(board.read(current.key)?.state,'ACTIVE');
 assert.ok(op.heartbeat());
 assert.ok(op.prepareRelocation(1,current,oldBelt,901));
});
