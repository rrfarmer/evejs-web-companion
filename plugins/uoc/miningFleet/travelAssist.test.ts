import test from "node:test";
import assert from "node:assert/strict";
import {createNativeTravelAssist,createTravelAssist,TravelAssistPending} from "./travelAssist.ts";

const module={itemID:1,typeID:439,flagID:19,effectID:6731,effect:"moduleBonusAfterburner",kind:"afterburner" as const};
const identity={operationID:"op",runID:"run",characterID:4,shipID:5,botID:"bot"};
function fixture(){
 let active=false,enabled=true,lost=false,delayOff=false,unavailable=false,readUnavailable=false,capacitorRatio=1;
 let followingTargetID:number|null=null,refusal:Error|null=null,doc:unknown=null;
 const calls:string[]=[];
 const document={read:()=>doc,write:(v:unknown)=>{doc=structuredClone(v);}};
 const attach=()=>createTravelAssist({
  identity,document,current(){},beforeAction(){if(!enabled)throw Error("Stop");},enabled:()=>enabled,
  read:async()=>{if(readUnavailable)throw Error("Fit unavailable");return {modules:[{...module,active}],capacitorRatio,scrammed:false,followingTargetID};},
  observe:async()=>{if(unavailable)throw Error("Native module read unavailable");return active;},
  change:async(_m,on)=>{
   calls.push(on?"on":"off");
   if(refusal){active=true;throw refusal;}
   if(on||!delayOff)active=on;
   if(lost)throw Error("reply lost");
  },
 });
 return {controller:attach(),attach,calls,document,
  lost:(value:boolean)=>{lost=value;},delayOff:()=>{delayOff=true;},inactive:()=>{active=false;},
  noObservation:(value:boolean)=>{unavailable=value;},noFit:()=>{readUnavailable=true;},lowCap:()=>{capacitorRatio=.1;},
  follow:(targetID:number)=>{followingTargetID=targetID;},stop:()=>{enabled=false;},
  refuse:()=>{refusal=Object.assign(Error("EffectAlreadyActive2"),{code:"CALL_REFUSED",status:409});},
 };
}

test("travel assist observes activation and shuts down the exact owned module at arrival",async()=>{
 const x=fixture();
 await x.controller.beforeApproach("claim:1:777",25000,1000,777);
 assert.equal(x.controller.snapshot().owned?.scope,"claim:1:777");
 assert.equal(x.controller.snapshot().pending,null);
 await x.controller.beforeApproach("claim:1:777",25000,1000,777);
 await x.controller.settle();
 assert.deepEqual(x.calls,["on","off"]);
 assert.equal(x.controller.snapshot().owned,null);
});

test("lost activation reply remains fenced until the exact native effect becomes visible",async()=>{
 const x=fixture();x.lost(true);x.noObservation(true);
 await x.controller.beforeApproach("rock",25000,1000);
 await x.controller.beforeApproach("rock",25000,1000);
 assert.equal(x.controller.snapshot().pending?.acknowledged,false);
 assert.deepEqual(x.calls,["on"]);
 x.noObservation(false);
 await x.controller.beforeApproach("rock",25000,1000);
 assert.equal(x.controller.snapshot().pending,null);
 assert.equal(x.controller.snapshot().owned?.scope,"rock");
 assert.deepEqual(x.calls,["on"]);
});

test("an effect expired before readback settles from native inactivity without replaying the approach's activation",async()=>{
 const x=fixture();x.noObservation(true);
 await x.controller.beforeApproach("rock",25000,1000);
 assert.equal(x.controller.snapshot().pending?.acknowledged,true);
 x.inactive();x.noObservation(false);
 const restored=x.attach();
 await restored.beforeApproach("rock",25000,1000);
 await restored.settleForStop();
 assert.equal(restored.snapshot().pending,null);
 assert.equal(restored.snapshot().owned,null);
 assert.equal((restored.snapshot().history.at(-1) as {outcome:string}).outcome,"INACTIVE");
 assert.deepEqual(x.calls,["on"]);
});

test("already inactive owned propulsion needs no Deactivate call",async()=>{
 const x=fixture();
 await x.controller.beforeApproach("rock",25000,1000);
 x.inactive();
 await x.controller.settleForStop();
 assert.equal(x.controller.snapshot().owned,null);
 assert.deepEqual(x.calls,["on"]);
});

test("acknowledged shutdown remains observable across the current cycle and needs no second Deactivate",async()=>{
 const x=fixture();x.delayOff();
 await x.controller.beforeApproach("rock",25000,1000);
 await x.controller.settle();
 assert.equal(x.controller.snapshot().pending?.kind,"off");
 assert.equal(x.controller.snapshot().pending?.acknowledged,true);
 await x.controller.settle();
 await x.controller.beforeApproach("other-rock",25000,1000);
 assert.deepEqual(x.calls,["on","off"]);
 x.inactive();
 await x.controller.settle();
 assert.equal(x.controller.snapshot().pending,null);
 assert.equal(x.controller.snapshot().owned,null);
});

test("lost shutdown reply is settled by native inactivity without a second Deactivate",async()=>{
 const x=fixture();
 await x.controller.beforeApproach("rock",25000,1000);
 x.lost(true);x.delayOff();
 await x.controller.settle();
 assert.equal(x.controller.snapshot().pending?.acknowledged,false);
 await x.controller.settle();
 x.inactive();
 await x.controller.settleForStop();
 assert.equal(x.controller.snapshot().pending,null);
 assert.deepEqual(x.calls,["on","off"]);
});

test("a confirmed native approach in progress does not start another assist",async()=>{
 const x=fixture();x.follow(777);
 await x.controller.beforeApproach("rock",25000,1000,777);
 assert.deepEqual(x.calls,[]);
});

test("unavailable fitting and insufficient capacitor permit an unassisted approach",async()=>{
 const x=fixture();x.noFit();
 await x.controller.beforeApproach("rock",25000,1000);
 assert.deepEqual(x.calls,[]);
 const y=fixture();y.lowCap();
 await y.controller.beforeApproach("rock",25000,1000);
 assert.deepEqual(y.calls,[]);
});

test("a definite already-active refusal does not adopt or deactivate somebody else's propulsion effect",async()=>{
 const x=fixture();x.refuse();
 await x.controller.beforeApproach("rock",25000,1000);
 await x.controller.beforeApproach("rock",25000,1000);
 await x.controller.settleForStop();
 assert.equal(x.controller.snapshot().pending,null);
 assert.equal(x.controller.snapshot().owned,null);
 assert.deepEqual(x.calls,["on"]);
});

test("Stop keeps an unreadable assist intent local, then observes and settles the original shutdown",async()=>{
 const x=fixture();x.delayOff();
 await x.controller.beforeApproach("rock",25000,1000);
 x.noObservation(true);x.stop();
 await assert.rejects(x.controller.settleForStop(),(error:unknown)=>error instanceof TravelAssistPending&&/unreadable/.test(error.message));
 assert.deepEqual(x.calls,["on"]);
 x.noObservation(false);
 await assert.rejects(x.controller.settleForStop(),(error:unknown)=>error instanceof TravelAssistPending&&/still active/.test(error.message));
 assert.deepEqual(x.calls,["on","off"]);
 x.noObservation(true);x.inactive();
 await assert.rejects(x.controller.settleForStop(),TravelAssistPending);
 assert.equal(x.controller.snapshot().pending?.kind,"off");
 x.noObservation(false);
 await x.controller.settleForStop();
 assert.equal(x.controller.snapshot().pending,null);
 assert.deepEqual(x.calls,["on","off"]);
});

test("Stop between durable intent and dispatch records a negative receipt and sends nothing",async()=>{
 const x=fixture();let checks=0;
 const controller=createTravelAssist({identity,document:x.document,current(){},
  beforeAction(){if(++checks===2)throw Error("Stop");},
  read:async()=>({modules:[{...module,active:false}],capacitorRatio:1,scrammed:false}),
  observe:async()=>false,change:async()=>{x.calls.push("on");}});
 await assert.rejects(controller.beforeApproach("rock",30000,1000),/Stop/);
 assert.deepEqual(x.calls,[]);
 assert.equal(controller.snapshot().pending,null);
 assert.equal((controller.snapshot().history[0] as {outcome:string}).outcome,"NOT_DISPATCHED");
});

test("a retained acknowledged shutdown uses exact ItemGetInfo outside the mining system",async()=>{
 const prior={module,scope:"BELT:300:belt:3:777",kind:"off",issuedAt:1000,acknowledged:true};
 let doc:unknown={version:1,identity:JSON.stringify(identity),pending:prior,owned:{module,scope:prior.scope},history:[]};
 const paths:string[]=[],reads:number[]=[],clock={type:"long",value:"134385165369180001"};
 let active=true;
 const run={botID:"bot",characterID:4,baseUrl:"http://bff",fetch:async(input:URL)=>{
  paths.push(input.pathname);throw Error("The retained effect must not depend on the mining grid.");
 }};
 const session={store:{station:{get:()=>({online:{characterID:4}})}},flow:{requestOptions:()=>({}),flying:{
  sessionGeneration:()=>1,isSessionClosing:()=>false,bridgeDo:async()=>{throw Error("No second shutdown");},
  bridgeAsk:async(service:string,method:string,args:number[])=>{
   assert.deepEqual([service,method],["dogmaIM","ItemGetInfo"]);reads.push(args[0]!);
   return {type:"object",name:"util.KeyVal",args:{type:"dict",entries:[
    ["itemID",1],["invItem",{type:"packedrow",fields:{itemID:1,typeID:439,ownerID:4,locationID:5,flagID:19}}],
    ["activeEffects",{type:"dict",entries:active?[[6731,[1,4,5,null,null,[],6731,clock,10000,1]]]:[]}],
    ["time",clock],["wallclockTime",clock],
   ]}};
  },
 }}};
 const controller=createNativeTravelAssist(run as any,session as any,{operationID:"op",runID:"run",shipID:5,systemID:300,
  document:{read:()=>doc,write:v=>{doc=structuredClone(v);}},current(){},beforeAction(){}});
 await controller.settle("BELT:300:belt:3:99");
 assert.deepEqual(reads,[]);
 await assert.rejects(controller.settleForStop(),TravelAssistPending);
 active=false;
 await controller.settleForStop();
 assert.equal(controller.snapshot().pending,null);
 assert.deepEqual(reads,[1,1]);
 assert.deepEqual(paths,[]);
});
