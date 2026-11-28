import test from 'node:test';import assert from 'node:assert/strict';import {finishParking} from './finishParking.ts';
function fixture(){let docked=false,routes=0,docks=0,time=0;const docs=new Map<string,unknown>(),document=(key:string)=>({read:()=>docs.get(key)??null,write:(v:unknown)=>{docs.set(key,structuredClone(v));}}),setup:any={operationID:'op',operationRunID:'old',systemID:300,destinationID:600,parking:{mode:'RETURN_HOME_DOCK',destinationID:601,kind:'station',systemID:300}};
 const run:any={botID:'finish',characterID:1,baseUrl:'http://fixture',report(){},fetch:async(input:any)=>{const p=new URL(String(input)).pathname;return Response.json({ok:true,...(p.endsWith('/status')?{flight:{shipID:11,solarSystemID:300,inSpace:!docked,docked,stationID:docked?601:null,shipMode:'STOP',transition:{phase:'ready'}}}:p==='/api/map/station/601'?{station:{stationID:601}}:{kind:'station',stationID:601,solarSystemID:300})});}};
 const session:any={store:{station:{get:()=>({online:{characterID:1}})}},flow:{requestOptions:()=>({}),startRoute:async()=>{routes++;return {started:true};},flying:{abortAutopilot(){},autopilotProgress:()=>({status:'arrived'}),dockStep:async()=>{docks++;docked=true;}}}};
 return {run,session,setup,document,options:{now:()=>time,wait:async(ms:number)=>{time+=ms;}},arrive(){docked=true;},counts:()=>({routes,docks})};}
const key='mining-fleet-finish-parking:'+JSON.stringify(['op','old',1,11]);
const park=(f:ReturnType<typeof fixture>)=>finishParking(f.run,f.session,f.setup,11,()=>{},f.document,f.options);
test('F5 restored Parking replans an old interrupted route from fresh flight',async()=>{
 const f=fixture();
 f.document(key).write({version:1,identity:JSON.stringify(f.setup.parking),pending:{kind:'route',destinationID:601},history:[]});
 assert.equal((await park(f)).kind,'dock');
 assert.deepEqual(f.counts(),{routes:1,docks:1});
 assert.equal((f.document(key).read() as any).pending,null);
});
test('F6 lost Dock response settles from late native docking with one Dock order',async()=>{
 const f=fixture(),dock=f.session.flow.flying.dockStep,wait=f.options.wait;
 let pending=false;
 f.session.flow.flying.dockStep=async()=>{pending=true;throw Object.assign(Error('Dock response timed out'),{code:'CALL_TIMEOUT'});};
 f.options.wait=async ms=>{await wait(ms);if(pending){pending=false;await dock();}};
 assert.equal((await park(f)).kind,'dock');
 assert.equal((await park(f)).kind,'dock');
 assert.deepEqual(f.counts(),{routes:1,docks:1});
});
test('F6 uncertain Dock survives a restart and only fresh arrival clears it',async()=>{
 const f=fixture(),original=f.session.flow.flying.dockStep;let writes=0;
 f.session.flow.flying.dockStep=async()=>{writes++;throw Object.assign(Error('timed out'),{code:'CALL_TIMEOUT'});};
 await assert.rejects(park(f),/no Dock replay/);
 await assert.rejects(park(f),/no Dock replay/);
 f.session.flow.flying.dockStep=original;f.arrive();
 assert.equal((await park(f)).kind,'dock');
 assert.equal(writes,1);
 assert.deepEqual(f.counts(),{routes:1,docks:0});
});
test('F5 route replan waits for the actual position after a temporary transport failure',async()=>{
 const f=fixture(),start=f.session.flow.startRoute;let attempts=0;
 f.session.flow.startRoute=async()=>{if(++attempts===1)return {started:false,reason:'GamePort timeout',cause:{code:'CALL_TIMEOUT'}};return start();};
 assert.equal((await park(f)).kind,'dock');
 assert.equal(attempts,2);
 assert.deepEqual(f.counts(),{routes:1,docks:1});
});

test('a replacement FINISH actor reconciles the original STAY intent from physical STOP without sending another stop',async()=>{
 const f=fixture();f.setup.parking={mode:'STAY_IN_PLACE'};const key='mining-fleet-finish-stay:'+JSON.stringify(['op','old',1,11]);
 f.document(key).write({version:1,identity:JSON.stringify(['op','old','previous-finish',1,11]),pending:{issuedAt:Date.now()-5000,acknowledged:false},history:[]});
 f.session.flow.stopShip=async()=>{throw Error('a second stop was dispatched');};
 const r=await finishParking(f.run,f.session,f.setup,11,()=>{},f.document);assert.equal(r.kind,'stay');assert.equal((f.document(key).read() as any).pending,null);assert.equal((f.document(key).read() as any).history.length,1);
});

test("flight identity changing after a temporary refusal forbids a second route",async()=>{
 const f=fixture(),fetch=f.run.fetch;
 let changed=false,starts=0;
 f.run.fetch=async(input:unknown)=>{
  if(changed&&String(input).endsWith("/status"))return Response.json({ok:true,flight:{shipID:12,solarSystemID:300,inSpace:true,docked:false,shipMode:"STOP"}});
  return fetch(input);
 };
 f.session.flow.startRoute=async()=>{
  starts++;changed=true;
  return {started:false,reason:"temporary GamePort failure",cause:{code:"CALL_TIMEOUT"}};
 };
 await assert.rejects(park(f),/Held ship or native flight state changed/);
 assert.equal(starts,1);
 assert.deepEqual(f.counts(),{routes:0,docks:0});
});
