import test from 'node:test';
import assert from 'node:assert/strict';
import {cockpitProvisioning} from './cockpitProvisioning.ts';
import type {Session} from '../../../../web/src/plugin-api/index.ts';
function fixture(active=false){
 const calls:string[]=[],options={token:'actual-page-token'};
 const session={id:'actual-page',store:{get:()=>({station:{online:{characterID:7}}})},flow:{sessionToken:()=>options.token,requestOptions:()=>options}} as unknown as Session;
 const read=async(path:string,asked:unknown)=>{assert.equal(asked,options);calls.push(path);
  if(path.includes('/ownership'))return {ownership:{characterID:7,owner:'BROWSER',online:true}};
  if(path==='/api/bots')return {bots:active?[{characterID:7,endedAt:null}]:[]};
  if(path==='/api/bridge/flight/status')return {flight:{docked:true}};
  if(path==='/api/bridge/provisioning/ship-review')throw Error('Native dock inspection unavailable');
  throw Error('Unexpected action or login: '+path);
 };return {session,read,calls};
}
test('online Provisioning sends the current inspection to the chosen Cockpit and preserves a native refusal',async()=>{
 const f=fixture(),selection={corporationID:5,fittingID:4,division:7};
 await assert.rejects(cockpitProvisioning(f.session,'provision-inspect',selection,f.read),/Native dock inspection unavailable/);
 assert.equal(f.calls.at(-1),'/api/bridge/provisioning/ship-review');
 assert.equal(f.calls.some(p=>/login|start|release|\/(options|reconcile)$/.test(p)),false);
});
test('a currently active operation cannot enter the native equipment executor',async()=>{
 const f=fixture(true);await assert.rejects(cockpitProvisioning(f.session,'provision-apply',{},f.read),/active operation/);
 assert.equal(f.calls.some(p=>p.includes('/provisioning/')),false);
});

for(const [existing,corporate] of [[false,false],[false,true],[true,false],[true,true]])test(`Cockpit verifies the ${existing?'assembled':'new'} Covetor with ${corporate?'corporate':'personal'} storage of the previous ship`,async()=>{
 const {session,read:ownerRead}=fixture();
 const selection={goalTypeID:17476,corporationID:5,fittingID:4,division:7,fingerprint:'fit',reviewedPlanFingerprint:'review'};
 const equipment=[[27,20,1],[92,21,1],[87,2203,5]];
 const modules=[{itemID:501,typeID:20,flagID:27},{itemID:502,typeID:21,flagID:92}];
 const calls:string[]=[],reviewInputs:unknown[]=[];
 const dict=(entries:unknown[][])=>({type:'dict',entries});
 const keyval=(entries:unknown[][])=>({type:'object',name:'util.KeyVal',args:dict(entries)});
 const time={type:'long',value:'134385165369180001'};
 let applied=false,moved=false;
 let simulation:unknown;
 Object.assign(session.flow.requestOptions(),{
  baseUrl:'http://test',
  fetch:async(url:string)=>{
   if(url==='http://test/api/bridge/ship/55/bays?keys=drone')return Response.json({ok:true,shipID:55,bays:[]});
   assert.equal(url,'http://test/api/bridge/fitting');
   return Response.json({ok:true,activeShipID:55,
    slots:{type:'list',items:modules.map(module=>({type:'packedrow',fields:{...module,quantity:1,singleton:1,categoryID:7}}))},
    shipInfo:dict([[55,keyval([['itemID',55],['attributes',dict([[14,1],[13,0],[12,0],[1137,1]])]])]]),
    online:{type:'list',items:modules.map(module=>module.itemID)},errors:{slots:null,shipInfo:null,online:null,chargeFits:null},
   });
  },
 });
 Object.assign(session.store,{
  dogma:{get:()=>({allInfo:{characterID:7,character:{typeID:1373},charBrain:[1,[],[],[]]}})},
  fitting:{get:()=>({simulation})},
 });
 Object.assign(session.flow,{
  loadFitting:async()=>{},loadDogma:async()=>{},
  loadInventory:async()=>{},openShipBays:async()=>{},loadFlightStatus:async()=>{},
  flying:{bridgeAsk:async(service:string,method:string,[itemID]:number[])=>{
   assert.deepEqual([service,method],['dogmaIM','ItemGetInfo']);
   assert.equal(applied,true);
   const module=modules.find(row=>row.itemID===itemID);
   if(itemID===55)return keyval([
    ['itemID',55],['invItem',{type:'packedrow',fields:{itemID:55,typeID:17476,ownerID:7}}],
    ['time',time],['wallclockTime',time],['attributes',dict([[49,10],[48,20],[15,1],[11,3]])],
   ]);
   assert.ok(module);
   return keyval([
    ['itemID',itemID],['invItem',{type:'packedrow',fields:{...module,ownerID:7,locationID:55}}],
    ['time',time],['wallclockTime',time],['activeEffects',dict([[16,[itemID,7,55,null,null,[],16,time,-1,1]]])],
   ]);
  }},
  simulateFitting:async(fit:{shipTypeID:number;fitData:unknown[]})=>{
   assert.equal(fit.shipTypeID,17476);
   assert.deepEqual(fit.fitData,[{flagID:27,typeID:20,quantity:1},{flagID:92,typeID:21,quantity:1}]);
   simulation={shipTypeID:17476,slots:[{family:'high',index:0,module:{typeID:20}},{family:'rig',index:0,module:{typeID:21}}],
    moduleStates:{27:1,92:1},
    resources:{cpu:{known:true,used:10,total:20},powergrid:{known:true,used:1,total:3}},
    stats:{bays:{droneCapacity:{known:true,value:50}}}};
  },
 });
 const read=async(path:string,options:unknown,body?:unknown)=>{
  const packed=(fields:Record<string,number>)=>({type:'packedrow',fields:{singleton:1,quantity:-1,stacksize:1,...fields}});
  const oldHull=packed({itemID:9,typeID:1,categoryID:6,ownerID:moved?5:7,locationID:moved?800:600,flagID:moved?121:4});
  const oldRig=packed({itemID:61,typeID:21,categoryID:7,ownerID:moved?5:7,locationID:9,flagID:92});
  const selectedHull=packed({itemID:55,typeID:17476,categoryID:6,ownerID:7,locationID:600,flagID:4});
  if(path==='/api/bridge/call'){
   const rpc=body as {method:string;of?:number|"hangar";args?:number[];confirm?:boolean};
   if(rpc.method==='GetMyCorporationsOffices')return {result:{list:[packed({officeID:800,stationID:600})]}};
   if(rpc.method==='InvalidateLocationCache')return {result:null};
   if(rpc.method==='List'&&rpc.of==='hangar')return {result:{type:'list',items:existing?[selectedHull]:[]}};
   if(rpc.method==='List'&&rpc.of===55)return {result:{type:'list',items:[
    ...modules.map(row=>packed({...row,categoryID:7,ownerID:7,locationID:55})),
    packed({itemID:61+500,typeID:2203,categoryID:18,ownerID:7,locationID:55,flagID:87,quantity:5,stacksize:5,singleton:0}),
   ]}};
   if(rpc.method==='GetSelfInvItem'&&rpc.of===55)return {result:selectedHull};
   if(rpc.method==='Board'){
    assert.equal(existing,true);
    assert.deepEqual(rpc.args,[55,9]);
    assert.equal(rpc.confirm,true);
    calls.push('Board');applied=true;return {result:null};
   }
   assert.equal(applied,true);
   if(rpc.method==='GetSelfInvItem')return {result:rpc.of===9?oldHull:oldRig};
   if(rpc.method==='List')return {result:{type:'list',items:rpc.of===9?[oldRig]:[oldHull]}};
   assert.fail(`Unexpected bridge method ${rpc.method}`);
  }
  if(path==='/api/bridge/flight/status')return {flight:{docked:true,stationID:600,shipID:applied?55:9}};
  if(path==='/api/bridge/provisioning/ship-review'){
   reviewInputs.push(body);
   return {
    context:{characterID:7,corporationID:5,shipID:applied?55:9,shipTypeID:applied?17476:1,locationID:600},
    contract:{definition:{fingerprint:'fit'},shipTypeID:17476,equipment,structural:equipment.slice(0,2)},
    canApply:true,plan:{mode:applied?'ALREADY_SATISFIED':'NEW_HULL',targetHullTypeID:17476,targetHullID:null,shortages:[],unsupported:[],destructiveActions:[],
     requirements:equipment.map(([flag,typeID,quantity])=>({flag,typeID,quantity,kind:flag===87?'LOADED':'FITTED'}))},
    source:{pin:{descriptor:{kind:'corp',corporationID:5,division:7},ownerID:5,locationID:800,flag:121,office:'corpOffice:800',dockedLocationID:600},
     access:{query:true,take:true},rows:[]},
    reviewID:'native-review',reviewHash:'review',expiresAt:Date.now()+30000,status:{equipment:applied?'VERIFIED':'MODIFIED'},
   };
  }
  if(path==='/api/bridge/provisioning/provision-ship'){
   assert.equal(existing,false);
   assert.deepEqual(body,{reviewID:'native-review',reviewHash:'review',confirm:true});
   calls.push(path);
   applied=true;
   return {state:'COMPLETE',operationID:'native-review',result:{equipment:'VERIFIED'},manifest:{targetHullID:55,originalShipID:9}};
  }
  if(path==='/api/bridge/inventory/transfer'){
   assert.equal(applied,true);
   assert.deepEqual(body,{itemIDs:[9],from:{kind:'hangar'},to:{kind:'corp',division:7}});
   calls.push(path);
   moved=true;
   return {applied:true,moved:[9]};
  }
  if(path==='/api/bridge/skills')return {skills:{characterID:7,skills:[]}};
  if(path==='/api/client-data/required-skills?typeIDs=17476,20,21,2203')return {available:true,required:{17476:{},20:{},21:{},2203:{}}};
  if(path==='/api/types/volumes?typeIDs=2203')return {volumes:{2203:5}};
  if(path==='/api/client-data/dogma-types?typeIDs=17476,1373,20,21')return {
   available:true,types:Object.fromEntries([17476,1373,20,21].map(id=>[id,{attributes:[],effects:[]}])),effects:{},
  };
  return ownerRead(path,options);
 };
 const preview=await cockpitProvisioning(session,'provision-inspect',selection,read);
 assert.deepEqual(preview.readout.resources.droneBay,{required:25,capacity:50,reason:null,simulated:true});
 assert.equal(preview.readout.fittingService,'UNKNOWN');
 assert.equal(preview.readout.canApply,true);
 assert.deepEqual(preview.readout.applyBlockers,[]);
 assert.deepEqual(calls,[]);

 const reviewed={...selection,reviewedPlanFingerprint:preview.readout.reviewedPlanFingerprint};
 const corporateStorage={...reviewed,oldShipDivision:7};
 await assert.rejects(cockpitProvisioning(session,'provision-apply',corporateStorage,read),/Inspect the exact native plan/);
 let accepted=reviewed;
 if(corporate){
  const inspected=await cockpitProvisioning(session,'provision-inspect',corporateStorage,read);
  assert.equal(inspected.readout.canApply,true);
  assert.equal((reviewInputs.at(-1) as any).oldShipDivision,undefined);
  assert.deepEqual(calls,[]);
  accepted={...corporateStorage,reviewedPlanFingerprint:inspected.readout.reviewedPlanFingerprint};
 }

 const result=await cockpitProvisioning(session,'provision-apply',accepted,read);
 assert.equal(result.phase,'Provisioning verified');
 assert.equal(result.readout.shipID,55);
 assert.equal(result.readout.nativeResources.allModulesOnline,true);
 assert.deepEqual(result.readout.previousShipStorage,corporate?{itemID:9,location:800,division:7,contentsCount:1}:null);
 assert.deepEqual(calls,[existing?'Board':'/api/bridge/provisioning/provision-ship',...(corporate?['/api/bridge/inventory/transfer']:[])]);
});
