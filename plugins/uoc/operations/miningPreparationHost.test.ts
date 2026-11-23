import test from 'node:test';import assert from 'node:assert/strict';
import {createMiningPreparationRun} from './miningPreparationHost.ts';
function fixture(options:{lost?:boolean;equipment?:string;dropPolicy?:boolean;unknownSupplies?:boolean;corporateError?:string;ambiguous?:boolean;unavailable?:boolean;pending?:boolean;unresolved?:boolean;surplus?:boolean;stock?:number;take?:boolean;wrongDivision?:boolean;wrongOfficeLocation?:boolean;stationID?:number}={}){
 const target={typeID:3,name:'Mining charge',target:4000,mode:'CARRIED_SPARES',eligibleFlags:[5,143],required:false};
 const locationID=options.stationID??600;
 let saved:any=null,aboard=3200,stock=options.stock??10000,transfers=0;let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});const reports:any[]=[],requests:string[]=[],sources:unknown[]=[];
 const {name:_,...extra}=target;
 const setup={operationID:'op',operationRunID:'generation',role:'MINER',preparation:{source:{kind:'hangar'},fittingID:4,suppliesRequired:true,replenishSupplies:true,supplies:[{...extra,required:true}]}};
 const run:any={botID:'prepare-native',characterID:10,held:{characterID:10},resumed:false,setup,baseUrl:'http://fixture',report:(r:any)=>{reports.push(r);if(['stopped','error','paused'].includes(r.status))finish();},fetch:async(input:any,init:any)=>{
  const p=new URL(input).pathname,b=init?.body?JSON.parse(init.body):null;requests.push(p);let body:any;
  if(p==='/api/plugins/uoc/world')body={worldID:'world'};
  else if(p==='/api/bridge/provisioning/options')body={corporationID:31,providerCharacterID:10,definitionCorporationID:30,definitionStatus:'READY',fittings:options.ambiguous?[{fittingID:4},{fittingID:4}]:[{fittingID:4}],pending:options.pending?[{operationID:'other'}]:[]};
  else if(p==='/api/bridge/provisioning/review'&&options.unavailable)return new Response(JSON.stringify({ok:false,error:'PROVISIONING_FITTING_UNAVAILABLE',message:'Native fitting read unavailable'}),{status:409});
  else if(p==='/api/bridge/provisioning/review'){
   sources.push(b.source);
   assert.equal(b.supplyPolicy.fittedMinimum,true);
   assert.equal(b.supplyPolicy.fittingDronesAsSupplies,setup.preparation.replenishSupplies===true);
   const corp=b.source.kind==='corp';
   if(corp&&options.corporateError)return Response.json({ok:false,error:options.corporateError},{status:403});
   if(corp){assert.equal(b.corporationID,30);assert.equal(b.source.corporationID,31);}
   const descriptor=options.wrongDivision?{...b.source,division:b.source.division===7?1:7}:b.source;
   body={reviewID:'review',reviewHash:'hash',context:{characterID:10,shipID:50,locationID},
    contract:{name:'Fit',definitionFingerprint:'exact-fit',definition:{characterID:10,fittingID:b.fittingID},supplies:options.dropPolicy?[]:[target]},
    status:{equipment:options.equipment??'VERIFIED',...(options.surplus?{equipmentMatch:'REQUIRED_WITH_SURPLUS_EQUIPMENT'}:{}),
     supplies:options.unknownSupplies?'UNKNOWN':aboard<4000?'LOW':'FULL',targets:[{...target,current:aboard,deficit:4000-aboard}]},
    canApply:true,source:{pin:{descriptor,ownerID:corp?31:10,dockedLocationID:options.wrongOfficeLocation?locationID+1:locationID,office:corp?'corpOffice:700':null},
     access:{query:true,take:options.take??true},available:[{typeID:3,quantity:stock}]}};
  }
  else if(p==='/api/bridge/provisioning/replenish'){
   assert.deepEqual(b,{reviewID:'review',reviewHash:'hash',confirm:true});
   transfers++;
   const quantity=Math.min(stock,4000-aboard);
   aboard+=quantity;stock-=quantity;
   if(options.lost)throw Error('lost acknowledgement');
   body={state:'COMPLETE'};
  }
  else if(p==='/api/bridge/provisioning/reconcile')body={state:options.unresolved?'PENDING':'COMPLETE'};
  else throw Error(p);return new Response(JSON.stringify({ok:true,...body}),{status:200});
 }};
 const definition=createMiningPreparationRun({document:()=>({read:()=>saved,write:v=>{saved=structuredClone(v);}})});
 return {definition,run,reports,requests,sources,done,get saved(){return saved;},get transfers(){return transfers;},get aboard(){return aboard;}};
}
test('MCC validates actual equipment and uses only shared native personal supply replenishment',async()=>{
 const f=fixture(),handle=await f.definition.start(f.run);await f.done;await handle.stop();
 assert.equal(f.transfers,1);
 assert.deepEqual(f.sources,[{kind:'hangar'},{kind:'hangar'}]);
 assert.equal(f.reports.at(-1).readout.state,'VERIFIED');
 assert.equal(f.reports.at(-1).readout.targets[0].current,4000);
 assert.ok(!f.requests.some(p=>/provision-ship/.test(p)));
 assert.equal(f.saved.phase,'COMPLETE');
});
test('lost replenishment ACK is reconciled without another inventory dispatch',async()=>{const f=fixture({lost:true}),handle=await f.definition.start(f.run);await f.done;await handle.stop();assert.equal(f.transfers,1);assert.ok(f.requests.includes('/api/bridge/provisioning/reconcile'));assert.equal(f.reports.at(-1).readout.state,'VERIFIED');});
test('a wrong fitting or omitted configured supply policy cannot authorize a write',async()=>{for(const options of [{equipment:'MODIFIED'},{dropPolicy:true},{unavailable:true},{ambiguous:true}]){const f=fixture(options),handle=await f.definition.start(f.run);await f.done;await handle.stop();assert.equal(f.transfers,0);assert.equal(f.reports.at(-1).status,'stopped');assert.equal(f.reports.at(-1).readout.state,'DEGRADED');}});
test('optional restocking defaults off and legacy required shortages do not block departure',async()=>{
 const f=fixture();delete (f.run.setup.preparation as any).replenishSupplies;
 const handle=await f.definition.start(f.run);await f.done;await handle.stop();
 assert.equal(f.transfers,0);assert.equal(f.reports.at(-1).readout.state,'DEGRADED');
 assert.match(f.reports.at(-1).readout.reason,/departure is permitted/);
});

test('readiness Review verifies the fit without restocking even when top-up is enabled',async()=>{
 const f=fixture();Object.assign(f.run.setup,{reviewOnly:true,verifyEquipment:true});
 const handle=await f.definition.start(f.run);await f.done;await handle.stop();
 assert.equal(f.transfers,0);assert.equal(f.saved,null);
 assert.equal(f.reports.at(-1).readout.equipment,'VERIFIED');
 assert.equal(f.reports.at(-1).readout.state,'DEGRADED');
});

test('as-is preparation skips fitting reads and transfers',async()=>{
 const f=fixture({equipment:'MODIFIED'});delete (f.run.setup.preparation as any).fittingID;
 const handle=await f.definition.start(f.run);await f.done;await handle.stop();
 assert.equal(f.transfers,0);assert.deepEqual(f.requests,['/api/plugins/uoc/world']);assert.equal(f.reports.at(-1).readout.equipment,'AS IS');
});

test('strict Combat fitting review and genuine pending custody remain fenced',async()=>{
 for(const [options,role,expected,reason] of [
  [{equipment:'MODIFIED'},'COMBAT','error',/differs/],
  [{pending:true},'MINER','error',/custody/],
  [{lost:true,unresolved:true},'MINER','paused',/PREPARATION_UNRESOLVED/],
 ] as const){
  const f=fixture(options);Object.assign(f.run.setup,{role,verifyEquipment:role==='COMBAT'});
  const handle=await f.definition.start(f.run);await f.done;await handle.stop();
  assert.equal(f.transfers,role==='MINER'&&expected==='paused'?1:0);
  assert.equal(f.reports.at(-1).status,expected);assert.match(f.reports.at(-1).why,reason);
  if(expected==='paused')assert.equal(f.saved.phase,'PENDING');
 }
});

test('unreadable optional supplies remain a warning without stock changes',async()=>{
 const f=fixture({unknownSupplies:true});delete f.run.setup.preparation.replenishSupplies;
 const handle=await f.definition.start(f.run);await f.done;await handle.stop();
 assert.equal(f.transfers,0);assert.equal(f.reports.at(-1).status,'stopped');assert.equal(f.reports.at(-1).readout.state,'DEGRADED');
});

test('saved fitting tops up only the deficit from the selected division at each preparation station',async()=>{
 for(const [stationID,division] of [[600,1],[601,7]] as const){
  const f=fixture({stationID}),source={kind:'corp',corporationID:31,division};
  f.run.setup.preparation.source=source;delete f.run.setup.preparation.supplies;
  const handle=await f.definition.start(f.run);await f.done;await handle.stop();
  assert.equal(f.transfers,1);
  assert.equal(f.aboard,4000);
  assert.deepEqual(f.sources,[source,source]);
  assert.equal(f.reports.at(-1).readout.context.locationID,stationID);
  assert.equal(f.reports.at(-1).readout.state,'VERIFIED');
 }
});

test('read-only readiness resolves a saved division and reports how much stock is missing',async()=>{
 const f=fixture({stock:150});
 f.run.setup.reviewOnly=true;
 f.run.setup.preparation.source={kind:'corp',division:7};delete f.run.setup.preparation.supplies;
 const handle=await f.definition.start(f.run);await f.done;await handle.stop();
 assert.deepEqual(f.sources,[{kind:'corp',corporationID:31,division:7}]);
 assert.equal(f.transfers,0);
 assert.match(f.reports.at(-1).readout.reason,/Corporation Division 7.*Mining charge: 150 available, 800 needed/);
});

test('unavailable office, rights or wrong division cannot lead to personal fallback or a transfer',async()=>{
 for(const [options,reason] of [
  [{corporateError:'NO_CORP_OFFICE'},/no office at the pilot's preparation station/],
  [{corporateError:'CORPORATION_QUERY_DENIED'},/lacks Query access/],
  [{take:false},/Take access is unavailable/],
  [{wrongDivision:true},/office or division does not match/],
  [{wrongOfficeLocation:true},/office or division does not match/],
 ] as const){
  const f=fixture(options),source={kind:'corp',corporationID:31,division:7};
  f.run.setup.preparation.source=source;
  const handle=await f.definition.start(f.run);await f.done;await handle.stop();
  assert.deepEqual(f.sources,[source]);
  assert.equal(f.transfers,0);
  assert.equal(f.reports.at(-1).readout.state,'DEGRADED');
  assert.equal(f.reports.at(-1).readout.sourceLabel,'Corporation Division 7');
  assert.match(f.reports.at(-1).readout.reason,reason);
 }
});

test('unresolved fleet corporation and a changed pilot corporation leave corporate top-up disabled',async()=>{
 for(const source of [{kind:'corp',division:7},{kind:'corp',corporationID:32,division:7}]){
  const f=fixture();f.run.setup.preparation.source=source;
  const handle=await f.definition.start(f.run);await f.done;await handle.stop();
  assert.equal(f.transfers,0);
  assert.deepEqual(f.sources,[]);
  assert.match(f.reports.at(-1).readout.reason,/No shared player corporation|belongs to a different corporation/);
 }
});

test('compatible additional modules are reported as an advisory',async()=>{
 const f=fixture({surplus:true});Object.assign(f.run.setup,{reviewOnly:true});
 const handle=await f.definition.start(f.run);await f.done;await handle.stop();
 assert.equal(f.transfers,0);assert.equal(f.reports.at(-1).status,'stopped');
 assert.equal(f.reports.at(-1).readout.equipment,'VERIFIED');assert.match(f.reports.at(-1).readout.reason,/additional modules or rigs/);
});

test('verified Review retains scoped historical preparation without overwriting the native mutation journal',async()=>{
 const f=fixture();Object.assign(f.run.setup,{reviewOnly:true,verifyEquipment:true});let evidence:any=null;
 const definition=createMiningPreparationRun({document:()=>({read:()=>null,write(){throw Error('Review must not replace the inventory journal');}}),evidenceDocument:()=>({read:()=>evidence,write:v=>{evidence=structuredClone(v);}})});
 const handle=await definition.start(f.run);await f.done;await handle.stop();
 assert.equal(f.transfers,0);assert.equal(evidence.world,'world');assert.equal(evidence.botID,'prepare-native');assert.equal(evidence.readout.role,'MINER');assert.equal(evidence.readout.shipID,50);assert.equal(evidence.readout.equipment,'VERIFIED');assert.equal(evidence.readout.state,'DEGRADED');
});
