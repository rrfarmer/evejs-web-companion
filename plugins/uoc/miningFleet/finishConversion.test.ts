import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompressionController} from './support/compressionController.ts';
import {recoverCollectedConversion} from './finishConversion.ts';

test('retained collection resolves the original pending conversion at delivery across systems without compression replay',async()=>{
 let state:unknown=null,converted=false,atDelivery=false,writes=0;
 const row={itemID:20,typeID:30,ownerID:3,locationID:13,flagID:134,quantity:10,categoryID:25};
 const document={read:()=>structuredClone(state),write:(value:unknown)=>{state=structuredClone(value);}};
 const list=(rows:unknown[])=>({type:'list',items:rows.map(fields=>({type:'packedrow',fields}))});
 const run:any={botID:'finish-new',characterID:3,baseUrl:'http://fixture',fetch:async(input:any)=>{
  const p=new URL(String(input)).pathname;let data:any;
  if(p.endsWith('/status'))data={flight:{shipID:13,solarSystemID:atDelivery?301:300,inSpace:!atDelivery,docked:atDelivery,stationID:atDelivery?600:null,shipMode:'STOP',transition:{phase:'ready'}}};
  else if(p==='/api/mining-operations/resources')data={resources:[{typeID:30,family:'ore',name:'raw'}]};
  else if(p==='/api/client-data/dogma-types')data={available:true,types:{30:{categoryID:25},31:{categoryID:25}}};
  else if(p==='/api/types/volumes')data={volumes:{30:1,31:.1},capped:false};
  else if(p==='/api/types/compressed')data={compressedTypeIDs:{30:31},capped:false};
  else throw Error(p);
  return Response.json({ok:true,...data});
 }};
 const session:any={flow:{requestOptions:()=>({}),flying:{
  bridgeAsk:async(_s:any,_m:any,_a:any,kw:any)=>list(kw.flag===134?[{...row,typeID:converted?31:30}]:[]),
  bridgeDo:async(service:string,method:string)=>{if(service==='invCache')return null;assert.equal(method,'CompressItemInSpace');writes++;throw Error('lost response before physical result became visible');}
 }}};
 const facility:any={operationID:'op',runID:'old',claimKey:'site',claimGeneration:1,commanderCharacterID:3,commanderShipID:13,minerCharacterID:3,minerShipID:13,systemID:300,observedAt:Date.now(),sceneSampledAt:1,facilityTypeListIDs:[5],matchingTypeListIDs:[5],rangeMeters:5000,surfaceDistanceMeters:500,sourceTypeID:30,compressedTypeID:31,coreModuleID:80,compressorModuleID:81,compressorEffectID:82};
 const controller=createCompressionController({operationID:'op',runID:'old',run,session,shipID:13,systemID:300,document,current(){},facility:async()=>facility});
 assert.equal(await controller.compress(20),null);assert.ok(controller.snapshot().pending);assert.equal(writes,1);
 converted=true;atDelivery=true;
 const setup:any={operationID:'op',operationRunID:'old',systemID:300,delivery:{systemID:301},supportPolicy:{compressCollectedOre:true}},member:any={characterID:3,shipID:13,role:'COMMAND'},manifest:any={operationID:'op',runID:'old',containerID:90};
 const doc=(key:string)=>{assert.equal(key,'mining-fleet-collection-compression:'+JSON.stringify(['op','old','original-command',3,13,90,7,20]));return document;};
 const receipt=await recoverCollectedConversion(run,session,setup,member,'original-command',{itemID:20,typeID:30,quantity:10,flagID:134},manifest,7,()=>{},doc);
 assert.equal(receipt?.output.typeID,31);assert.equal(receipt?.acknowledged,false);assert.equal((state as any).pending,null);assert.equal(writes,1);
 assert.deepEqual(await recoverCollectedConversion(run,session,setup,member,'original-command',{itemID:20,typeID:30,quantity:10,flagID:134},manifest,7,()=>{},doc),receipt);assert.equal(writes,1);
 await assert.rejects(createCompressionController({operationID:'op',runID:'old',run,session,shipID:13,systemID:300,reconcileSystemID:301,document,current(){},facility:async()=>facility}).compress(20),/cannot dispatch/);
});
