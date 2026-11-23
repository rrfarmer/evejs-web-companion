import test from "node:test";
import assert from "node:assert/strict";
import {decodeSpaceSnapshot} from "../../../web/src/plugin-api/flying.ts";
import {createDistributionHost} from "../distribution/host.ts";
import {createDistributionFence} from "../distribution/fence.ts";
import {createCivilianDistributionRun} from "../distribution/backend.ts";
import {runControlRoutes} from "../runControl.ts";
import {bindCivilianScope,inspectCivilianOwner} from '../civilian/recovery.ts';
import {withCivilianPolicy} from "../shared/civilianReport.ts";
import type {MissionContinuation} from "../civilian/acceptedMission.ts";
const list=(...items:any[])=>({type:"list",items}), tuple=(...items:any[])=>({type:"tuple",items}), dict=(v:Record<string,any>)=>({type:"dict",entries:Object.entries(v)});
const keyval=(v:Record<string,any>)=>({type:"object",name:"util.KeyVal",args:dict(v)});
function fixture(lostAccept=false,lostComplete=false,holdAccept=false,holdTravel=false,expiryOffset=600000,wrongObjective=false,fault:"none"|"foreign"|"lost-transfer"|"preexisting-destination"="none",missionCount=1,auto=false,timed=false){
 let failParking=false, pauseInTransit=false, extraBots:any[]=[];
 let releaseAccept:()=>void=()=>{};const acceptGate=new Promise<void>(resolve=>{releaseAccept=resolve});
 let completed=0,station:number|null=600,state=0,cargo=0,pickup=10,dropoff=fault==="preexisting-destination"?2:0,cachedCargo=0,cachedHangar=10,storage:unknown=null;const events:string[]=[],reports:any[]=[],levels:number[]=[];
 const route={systemID:300,clockOffset:0,snapshot:null as ReturnType<typeof decodeSpaceSnapshot>|null,onObserve:undefined as (()=>void)|undefined,useShared:false,flightUnavailable:false,finderIncomplete:0,
  beforeStart:undefined as ((destination:number)=>{started:false;reason:string;cause?:unknown}|undefined)|undefined};
 let missionAgent=9,missionCorp=1,transport=true,completedRow=false,retainCompleted=false,blockCompletionRead=false,delayedReads=0,previousJournalState:number|null=null;
 const offerRoutes=new Map<number,number[]>(),requestedAgents:number[]=[],declinedAgents:number[]=[];
 const distances:Record<string,number>={};
 let offerJumps=0;
 let leftOffer:number|null=null;
 const offeredRow=(agent:number)=>tuple(1,false,"UI/Agents/MissionTypes/Courier",101,agent,123+completed,list(),false,false,900);
 const foreignAgent=3008740;
 let foreign:{state:0|1|2;blocks?:boolean;cooldown?:number;refusal?:string;referral?:boolean;lost?:boolean}={state:0};
 const objective=()=>dict({contentID:wrongObjective?901:900,missionState:state,objectives:transport?list(tuple("transport",tuple(1,dict({locationID:600,solarsystemID:300}),1,dict({locationID:601,solarsystemID:offerJumps?301:300}),dict({typeID:42,quantity:10,volume:1})))):list()});
 const conversation=(buttons:number[][],complete:boolean|null=null)=>tuple(tuple(tuple("agent",1),list(...buttons.map(([id,button])=>tuple(id,button)))),dict({missionCompleted:complete}));
 const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});
 const fetcher=async(input:any,init:any={})=>{const url=new URL(String(input)),p=url.pathname;
  if(p==="/api/bots")return response({ok:true,bots:[{botID:run.botID,characterID:2,expiresAt:new Date(Date.now()+expiryOffset).toISOString()},...extraBots]});
  if(p==="/api/pilot-training/characters")return response({ok:true,account:"tester",characters:[{characterID:2}]});
  if(p==="/api/plugins/uoc/world")return response({ok:true,worldID:"synthetic-distribution"});
  if(p==="/api/bridge/flight/status")return response({ok:true,flight:{docked:station!==null,shipID:3,stationID:station,solarSystemID:route.systemID}});
  if(p==="/api/map/system-stations/300")return response({ok:true,stations:[{stationID:602}]});
  if(p===`/api/bridge/agents/${foreignAgent}/record`)return response({ok:true,agent:{agentID:foreignAgent,divisionID:22,agentTypeID:2,stationID:602,solarSystemID:300,level:1,corporationID:1000084}});
  if(p===`/api/bridge/agents/${foreignAgent}/briefing`)return response({ok:true,
   briefing:dict({"Decline Time":foreign.cooldown??-1}),errors:{briefing:null},
   objective:foreign.referral?dict({objectives:list(tuple("agent",tuple(missionAgent,dict({locationID:600}))))}):null});
  const agentPath=/^\/api\/bridge\/agents\/(\d+)\/(record|briefing)$/.exec(p);
  if(agentPath&&(Number(agentPath[1])===missionAgent||offerRoutes.has(Number(agentPath[1])))){
   const agentID=Number(agentPath[1]);
   if(agentPath[2]==="record")return response({ok:true,agent:{agentID,divisionID:22,agentTypeID:2,stationID:600,solarSystemID:300,level:1,corporationID:missionCorp}});
   return response({ok:true,objective:objective(),briefing:dict({"Decline Time":declinedAgents.includes(agentID)?60_000_000:-1}),errors:{briefing:null,objective:null,location:null}});
  }
  if(p==="/api/bridge/inventory")return response({ok:true,stationID:station,activeShipID:3,
   cargo:{shipID:3,error:null,list:list(...(cargo?[{type:"packedrow",fields:{itemID:100,typeID:42,quantity:cargo}}]:[])),capacity:keyval({capacity:100,used:cargo/10})},
   hangar:{error:null,list:list(...((station===600?pickup:dropoff)?[{type:"packedrow",fields:{itemID:station===600?90:91,typeID:42,quantity:station===600?pickup:dropoff}}]:[]))}});
  if(p==="/api/bridge/inventory/transfer"){const b=JSON.parse(init.body);events.push(b.from.kind+"-"+b.to.kind);
   if(b.from.kind==="hangar"){pickup-=b.qty;cargo+=b.qty;}else{cargo-=b.qty;dropoff+=b.qty;}if(fault==="lost-transfer")throw Error("transfer response lost");return response({ok:true,applied:true});}
  if(p==="/api/bridge/call"){const b=JSON.parse(init.body);let result:any;
   if(b.service==="invCache"&&b.method==="InvalidateLocationCache"){
    assert.equal(b.confirm,true);if(b.args[0]===3)cachedCargo=cargo;else {assert.deepEqual(b.args,[[10004,null]]);cachedHangar=station===600?pickup:dropoff;}result=null;
   }else if(b.service==="invbroker"&&b.method==="List"){
    assert.ok((b.of===3&&b.args[0]===5)||(b.of==="hangar"&&b.args[0]===4));const isCargo=b.of===3,quantity=isCargo?cachedCargo:cachedHangar;
    result=list(...(quantity?[{type:"packedrow",fields:{itemID:isCargo?100:station===600?90:91,typeID:42,ownerID:fault==="foreign"?7:2,locationID:isCargo?3:station,flagID:isCargo?5:4,quantity}}]:[]));
   }else if(b.method==="GetMyJournalDetails"){
    const visible=previousJournalState??state;
    const number=previousJournalState===2&&state===0?completed-1:completed;
    if(previousJournalState!==null&&--delayedReads<=0)previousJournalState=null;
    result=tuple(list(...(visible===1||visible===2?[tuple(visible,false,"UI/Agents/MissionTypes/Courier",101,missionAgent,visible===1?123+number:456+number,list(),false,false,900)]:[]),
      ...(leftOffer===null?[]:[offeredRow(leftOffer)]),
      ...(foreign.state?[tuple(foreign.state,false,foreign.referral?"UI/Agents/MissionTypes/EpicArcTalkToAgent":"UI/Agents/MissionTypes/Courier","Corporate Documents",foreignAgent,999,list(),false,false,902)]:[]),
       ...(completedRow?[tuple(4,false,"UI/Agents/MissionTypes/Courier",102,8,457,list(),false,false,901)]:[]),
       ...(retainCompleted&&completed?[tuple(4,false,"UI/Agents/MissionTypes/Courier",101,missionAgent,455+completed,list(),false,false,900)]:[])),
      list(tuple(12,45,1,1,1,1,1)));
   }
   else if(b.method==="DoAction"){assert.equal(b.pilot,true);assert.equal(b.confirm,true);const id=b.args[0];
    if(b.of===foreignAgent){
      if(id===null)result=conversation(foreign.state===1?[[378,9]]:[[383,11]]);
      else {
       assert.equal(id,foreign.state===1?378:383);const kind=id===378?"decline":"quit";
       events.push(kind);if(kind==="quit")assert.equal(station,602);
       if(foreign.refusal)return response({ok:false,error:"CALL_REFUSED",message:foreign.refusal},409);
       if(foreign.lost)throw Error("response lost");
       questions=[{id:"native-confirmation",kind:"yesNo",service:"agents",method:"YesNo",agentID:foreignAgent,contentID:id===378?4802:902,suppressID:id===378?"AgtDeclineMission":"AgtQuitMission"}];
       const confirmed=new Promise<void>(resolve=>{confirm=resolve;});
       notify?.({questions});
       await confirmed;questions=[];
       foreign.state=0;
       result=tuple(tuple(tuple("agent",1),list()),dict({missionDeclined:id===378,missionQuit:id===383}));
      }
     }else if(id===null)result=conversation(state===0||b.of!==missionAgent?[[10,2]]:state===1?[[20,3],[378,9]]:blockCompletionRead&&dropoff>0?[]:[[30,6]]);
    else if(id===10){
     events.push("request");requestedAgents.push(b.of);
     if(foreign.state&&foreign.blocks)return response({ok:false,error:"CALL_REFUSED",message:"You already have an outstanding mission."},409);
     if(state===1&&b.of!==missionAgent)leftOffer=missionAgent;
     missionAgent=b.of;offerJumps=offerRoutes.get(b.of)?.shift()??0;
     state=1;result=conversation([[20,3],[378,9]]);
    }
    else if(id===378){
     assert.equal(state,1);assert.equal(b.of,missionAgent);declinedAgents.push(b.of);events.push("decline");
     questions=[{id:"native-confirmation",kind:"yesNo",service:"agents",method:"YesNo",agentID:b.of,contentID:4802,suppressID:"AgtDeclineMission"}];
     const confirmed=new Promise<void>(resolve=>{confirm=resolve;});
     notify?.({questions});await confirmed;questions=[];
     state=0;result=tuple(tuple(tuple("agent",1),list()),dict({missionDeclined:true}));
    }
    else if(id===20){events.push("accept");state=2;if(delayedReads>0)previousJournalState=1;if(holdAccept)await acceptGate;if(lostAccept)throw new Error("response lost");result=conversation([]);}
    else if(id===30){events.push("complete");state=0;completed++;pickup=10;dropoff=0;if(lostComplete)throw new Error("response lost");result=conversation([],true);}else throw Error("unexpected action");
   }else throw Error(`unexpected method ${b.method}`);
   return response({ok:true,service:b.service,method:b.method,result});
  }throw Error(`unexpected path ${p}`);
 };
 let finder:any={},questions:any[]=[],notify:((snapshot:{questions:any[]})=>void)|undefined,confirm:()=>void;
 const store={live:{get:()=>({questions}),subscribe:(fn:typeof notify)=>{notify=fn;return ()=>{notify=undefined;}}},
  names:{get:()=>({autopilotJumps:distances})},finder:{get:()=>finder},space:{get:()=>{route.onObserve?.();return {snapshot:route.snapshot};}},
  flight:{get:()=>({status:route.useShared&&!route.flightUnavailable?{shipID:3,solarSystemID:route.systemID,stationID:station,structureID:null,docked:station!==null,inSpace:station===null}:null})}};
 const flow={answerQuestion:async(id:string,yes:boolean)=>{assert.equal(id,"native-confirmation");assert.equal(yes,true);confirm();},startRoute:async(id:number)=>{const refused=route.beforeStart?.(id);if(refused)return refused;if(id===602&&failParking)return {started:false,reason:"unreachable"};if((holdTravel||pauseInTransit)&&id===601){events.push("flying");station=null;}else{events.push(`route-${id}`);station=id;}return {started:true}},abortRoute:()=>{},setLivePush:()=>{},
  flying:{autopilotProgress:()=>route.useShared?{status:station===null?"running":"arrived",currentSystemID:route.systemID}:null},
  requestAutopilotJumps:(from:number,to:number[])=>{for(const id of to)distances[`${from}:${id}`]=offerJumps;},findAgents:async({level}:{level:number})=>{
   levels.push(level);
   const agents=level===1?[...new Set([9,...offerRoutes.keys()])].map(agentID=>({agentID,level:1,stationID:600,solarSystemID:300,corporationID:missionCorp,jumps:0})):[];
   const incomplete=route.finderIncomplete>0;
   if(incomplete)route.finderIncomplete--;
   finder={loaded:true,error:null,capped:false,total:agents.length+(incomplete?1:0),agents};
  }};
 const fence=()=>createDistributionFence({storage:{read:()=>storage,write:v=>{storage=structuredClone(v)}}});
 const park=async(_run:any,_session:any,_progress:any,current:()=>void)=>{current();
  if(station===null){const result=await flow.startRoute(602);if(!result.started)throw new Error("unreachable");}
  return {destinationID:station!,kind:"station" as const,systemID:route.systemID};};
 const attached:unknown[]=[],timing:Readonly<Record<string,string|number|null>>[]=[];
 const host=createDistributionHost({attachPilot:async run=>{attached.push(run.held);return {store,flow:{...flow}} as any;},openFence:fence,park,now:()=>Date.now()+route.clockOffset+(timed&&completed>=2?61000:0),timing:record=>timing.push(record)});
 const backend=createCivilianDistributionRun(host);
 const run:any={botID:"bot",characterID:2,setup:{agent:auto?{mode:"auto",levelRule:"max",level:4,corporationID:null,maxJumps:10}:{mode:"manual",agentID:9,stationID:600},maxJumps:10,missionCount,...(timed?{durationMinutes:1}:{})},resumed:false,
  held:{characterID:2},baseUrl:"http://bff",fetch:fetcher,report:(r:any)=>reports.push(r)};
 const prepareOffer=()=>{const f=fence().open({accountID:1,characterID:2,runID:"old",current:()=>true});
  const evidence={journal:{active:[],offered:[]},shipID:3,stationID:600,typeID:null,cargoQuantity:null,hangarQuantity:null};
  f.dispatch({kind:"request",agentID:9},evidence);f.acknowledge();f.settle({...evidence,journal:{active:[],offered:[{agentID:9,missionKey:'[9,900,101,"123"]'}]}});state=1;run.botID="new";};
 return {backend,run,events,reports,fence,levels,attached,timing,route,releaseAccept,prepareOffer,
  offerRoutes,requestedAgents,declinedAgents,leftOffer:()=>leftOffer,distances,
  foreign:(row:typeof foreign)=>{foreign=row;missionCorp=1000064;if(auto)run.setup.agent.corporationID=missionCorp;},
  foreignState:()=>foreign.state,getStorage:()=>storage,restoreStorage:(v:unknown)=>{storage=v;},setExtraBots:(v:any[])=>{extraBots=v},setFailParking:(v:boolean)=>{failParking=v},setPauseInTransit:(v:boolean)=>{pauseInTransit=v},
  setCargo(value:{ship:number;source:number;destination:number}){cargo=value.ship;pickup=value.source;dropoff=value.destination;},
  retainCompleted(){retainCompleted=true;},
  existing:(v:{state:0|1|2;agent?:number;corporation?:number;transport?:boolean;aboard?:boolean;delivered?:boolean;station?:number|null;completedRow?:boolean;delayedReads?:number;jumps?:number})=>{
   state=v.state;offerJumps=v.jumps??0;missionAgent=v.agent??9;missionCorp=v.corporation??1;transport=v.transport??true;completedRow=v.completedRow??false;delayedReads=v.delayedReads??0;
   if(v.aboard){station=601;cargo=10;pickup=0;}
   if(v.delivered){station=601;cargo=0;pickup=0;dropoff=10;}
   if(v.station!==undefined)station=v.station;
  },blockCompletionRead:(block:boolean)=>{blockCompletionRead=block;}};
}
async function until(done:()=>boolean){for(let n=0;n<300&&!done();n++)await new Promise(r=>setTimeout(r,5));assert.equal(done(),true,"controller did not finish");}

function continueCourier(f:ReturnType<typeof fixture>,botID:string,mission:MissionContinuation){
 f.run.botID=botID;
 f.run.setup={agent:{mode:"manual",agentID:9,stationID:600},maxJumps:10,missionCount:1,continuation:mission};
 return withCivilianPolicy(f.backend,"distribution",{write(){}});
}

function savedCourier(f:ReturnType<typeof fixture>){
 const botID="released-owner",key='[9,900,101,"456"]';
 const lease=f.fence().open({accountID:1,characterID:2,runID:botID,current:()=>true});
 lease.annotateCivilian({worldID:"synthetic-distribution",owner:"tester",characterID:2,botID,kind:"distribution",status:"stopped",
  phase:"Docked",pending:null,firstFailure:null,resolved:false,updatedAt:1});
 lease.bindMission(9,key,true);
 return {...lease,mission:{agentID:9,missionID:900,key,botID}};
}

test("Courier Continue after Stop and reload delivers cargo aboard exactly once",async()=>{
 const f=fixture(false,false,true);
 const backend=withCivilianPolicy(f.backend,"distribution",{write(){}});
 const first=await backend.start(f.run);
 await until(()=>f.events.includes("accept"));
 await runControlRoutes["POST /runs/:botID/stop"]({params:{botID:"bot"},account:{username:"tester",accountID:1},method:"POST",path:"",query:{},body:{}});
 f.releaseAccept();await until(()=>f.reports.at(-1)?.status==="stopped");await first.stop();
 const accepted=f.reports.at(-1).readout.acceptedMission;
 assert.deepEqual(accepted,{agentID:9,missionID:900,key:'[9,900,101,"456"]'});
 f.restoreStorage(JSON.parse(JSON.stringify(f.getStorage())));
 f.existing({state:2,aboard:true,station:null});f.route.systemID=301;f.reports.length=0;
 const second=await continueCourier(f,"continued",{...accepted,botID:"bot"}).start(f.run);
 try{
  await until(()=>f.reports.at(-1)?.status==="stopped");
  assert.equal(f.reports.at(-1).phase,"Completed");
  assert.deepEqual(f.events,["request","accept","route-601","cargo-hangar","complete"]);
 }finally{await second.stop();}
});

test("Courier Continue completes a partial delivery and reconciles a lost transfer response",async()=>{
 const f=fixture(false,false,false,false,600000,false,"lost-transfer"),old=savedCourier(f);
 f.existing({state:2,station:601});f.setCargo({ship:6,source:0,destination:4});
 const handle=await continueCourier(f,"continued",old.mission).start(f.run);
 try{
  await until(()=>f.reports.at(-1)?.status==="stopped");
  assert.equal(f.reports.at(-1).phase,"Completed");
  assert.deepEqual(f.events,["cargo-hangar","complete"]);
 }finally{await handle.stop();}
});

test("Courier Continue with a confirmed native Complete and lost reply stops without replay",async()=>{
 const f=fixture(false,true),old=savedCourier(f);
 f.existing({state:2,delivered:true});f.retainCompleted();
 const handle=await continueCourier(f,"continued",old.mission).start(f.run);
 try{
  await until(()=>f.reports.at(-1)?.status==="stopped");
  assert.equal(f.reports.at(-1).phase,"Completed");
  assert.deepEqual(f.events,["complete"]);
 }finally{await handle.stop();}
});

test("Courier Continue refuses an absent mission and reports missing cargo without accepting a replacement",async()=>{
 const absent=fixture(),old=savedCourier(absent);
 await assert.rejects(async()=>continueCourier(absent,"continued",old.mission).start(absent.run),/no longer accepted/);
 assert.deepEqual(absent.events,[]);
 const missing=fixture(),saved=savedCourier(missing);
 missing.existing({state:2,station:601});missing.setCargo({ship:0,source:0,destination:0});
 const handle=await continueCourier(missing,"continued",saved.mission).start(missing.run);
 try{
  await until(()=>missing.reports.at(-1)?.status==="stopped");
  assert.equal(missing.reports.at(-1).phase,"Needs attention");
  assert.match(missing.reports.at(-1).why,/cargo is missing/i);
  assert.deepEqual(missing.events,["route-600"]);
 }finally{await handle.stop();}
});

test("Courier remains eligible after Stop during Continue",async()=>{
 const f=fixture(),old=savedCourier(f);
 f.existing({state:2,aboard:true});const report=f.run.report;
 f.run.report=(r:any)=>{report(r);if(r.phase==="Delivering")void runControlRoutes["POST /runs/:botID/stop"]({
  params:{botID:f.run.botID},account:{username:"tester",accountID:1},method:"POST",path:"",query:{},body:{}});
 };
 const first=await continueCourier(f,"continued",old.mission).start(f.run);
 await until(()=>f.reports.at(-1)?.status==="stopped");await first.stop();
 assert.deepEqual(f.events,[]);
 assert.deepEqual(f.reports.at(-1).readout.acceptedMission,{agentID:9,missionID:900,key:old.mission.key});
 f.run.report=report;f.reports.length=0;
 const next=await continueCourier(f,"continued-again",{...old.mission,botID:"continued"}).start(f.run);
 try{await until(()=>f.reports.at(-1)?.phase==="Completed");assert.deepEqual(f.events,["cargo-hangar","complete"]);}
 finally{await next.stop();}
});

for(const stage of ["before load","in transit","after delivery","between missions"] as const)test(`hosted Courier resumes ${stage} on its original pilot`,async()=>{
 const inTransit=stage==="in transit",between=stage==="between missions";
 const f=fixture(false,false,false,false,600000,false,"none",inTransit?6:between?2:1);
 const backend=withCivilianPolicy(f.backend,"distribution",{write(){}});
 const checked=await backend.check(f.run.setup);
 assert.ok(checked.ok);
 assert.equal(checked.policy.restartSafe,true);
 const baseFetch=f.run.fetch,baseReport=f.run.report;
 f.run.report=(r:any)=>{
  baseReport(r);
  if(inTransit&&r.phase==="Mission completed"&&r.readout.completedCount===5)f.setPauseInTransit(true);
  if(between&&r.phase==="Mission completed")throw Error("Test child interrupted after persisting completion.");
 };
 f.run.fetch=async(input:unknown,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname,row=f.fence().inspect(1,2);
  if(stage==="before load"&&path==="/api/bridge/flight/status"&&f.events.at(-1)==="accept"&&!row?.pending ||
     inTransit&&path==="/api/bridge/flight/status"&&f.events.at(-1)==="flying" ||
     stage==="after delivery"&&path==="/api/bridge/agents/9/briefing"&&row?.unloaded)
   throw Error("Test child interrupted during mission.");
  return baseFetch(input,init);
 };
 const old=await backend.start(f.run);
 await until(()=>f.reports.at(-1)?.status==="paused");
 await old.stop();
 const before=f.events.length;
 f.reports.length=0;
 f.setPauseInTransit(false);
 let read502=0;
 const handle=await backend.start({...f.run,resumed:true,report:baseReport,fetch:async(input,init)=>{
  if(inTransit&&new URL(String(input)).pathname==="/api/bridge/flight/status"&&read502===0){
   read502++;
   return Response.json({ok:false,error:"EVE_GATEWAY_UNREACHABLE"},{status:502});
  }
  return baseFetch(input,init);
 }});
 try{
  assert.equal(f.attached.length,2);
  assert.equal(f.attached[0],f.run.held);
  assert.equal(f.attached[1],f.run.held);
  await until(()=>["stopped","paused"].includes(f.reports.at(-1)?.status));
  assert.equal(f.reports[0].status,"running");
  assert.equal(f.reports[0].phase,"Resuming");
  assert.equal(f.reports[0].readout.completedCount,inTransit?5:between?1:0);
  assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
  assert.equal(f.reports.at(-1).readout.completedCount,f.run.setup.missionCount);
  assert.equal(f.reports.at(-1).readout.receipt.runID,f.run.botID);
  assert.ok(!f.reports.some(r=>r.status==="paused"));
  assert.equal(read502,inTransit?1:0);
  assert.deepEqual(f.events.slice(before),stage==="before load"?["hangar-cargo","route-601","cargo-hangar","complete"]:
   inTransit?["route-601","cargo-hangar","complete"]:between?["route-600","request","accept","hangar-cargo","route-601","cargo-hangar","complete"]:["complete"]);
 }finally{await handle.stop();}
});

for(const action of ["accept","load","unload","acknowledged complete","unconfirmed complete"] as const)test(`hosted Courier checks ${action} after an interrupted command without replay`,async()=>{
 const complete=action.endsWith("complete");
 const f=fixture(action==="accept",false,false,false,600000,false,"none",complete?2:1);
 const backend=withCivilianPolicy(f.backend,"distribution",{write(){}});
 const baseFetch=f.run.fetch;
 f.run.fetch=async(input:unknown,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname;
  if(path==="/api/bridge/inventory/transfer"){
   const from=JSON.parse(String(init?.body)).from.kind;
   if(action==="load"&&from==="hangar"||action==="unload"&&from==="cargo"){
    await baseFetch(input,init);
    throw Error("Test child interrupted before receiving the transfer reply.");
   }
  }
  if(complete&&path==="/api/bridge/call"){
   const command=JSON.parse(String(init?.body));
   if(command.method==="DoAction"&&command.args[0]===30){
    await baseFetch(input,init);
    throw Error("Test child interrupted before receiving the Complete reply.");
   }
  }
  return baseFetch(input,init);
 };
 const old=await backend.start(f.run);
 await until(()=>f.reports.at(-1)?.status==="paused");
 await old.stop();
 const pending=f.fence().inspect(1,2)?.pending;
 assert.equal(pending?.intent.kind,complete?"complete":action);
 assert.equal(pending?.acknowledged,false);
 if(action==="acknowledged complete")
  f.fence().open({accountID:1,characterID:2,runID:f.run.botID,current:()=>true,resumed:true}).acknowledge();
 f.reports.length=0;
 const handle=await backend.start({...f.run,resumed:true,fetch:baseFetch});
 try{
  await until(()=>["stopped","paused"].includes(f.reports.at(-1)?.status));
  const result=f.reports.at(-1);
  assert.equal(result.status,"stopped",JSON.stringify(result));
  assert.equal(result.readout.completedCount,complete?2:1);
  assert.equal(result.readout.pending,null);
  const mission=["request","accept","hangar-cargo","route-601","cargo-hangar","complete"];
  assert.deepEqual(f.events,complete?[...mission,"route-600",...mission]:mission);
  if(complete){
   const reports=f.reports.filter(r=>r.phase==="Mission completed");
   assert.deepEqual(reports.map(r=>r.readout.completedCount),[1,2]);
   assert.equal(reports[0].why,"Mission left the journal after Complete was sent.");
   assert.equal(reports[0].readout.reward,null);
   const saved=f.fence().completed(1,2,f.run.botID);
   assert.equal(saved.length,2);
   assert.equal(saved[0]?.receipt.invocationID,pending?.intent.kind==="complete"?pending.intent.invocationID:0);
  }
 }finally{await handle.stop();}
});

for(const foreign of ["none","offer","blocking accepted","unrelated accepted"] as const)test(`hosted Courier skips a vanished mission before Complete with ${foreign}`,async()=>{
 const f=fixture(false,false,false,false,600000,false,"none",1,true);
 const backend=withCivilianPolicy(f.backend,"distribution",{write(){}});
 f.foreign({state:0});
 const baseFetch=f.run.fetch;
 f.run.fetch=async(input:unknown,init?:RequestInit)=>{
  if(new URL(String(input)).pathname==="/api/bridge/flight/status"&&f.events.at(-1)==="accept"&&!f.fence().inspect(1,2)?.pending)
   throw Error("Test child interrupted after accepting.");
  return baseFetch(input,init);
 };
 const old=await backend.start(f.run);
 await until(()=>f.reports.at(-1)?.status==="paused");
 await old.stop();
 assert.equal(f.fence().inspect(1,2)?.pending,null);
 assert.deepEqual(f.events,["request","accept"]);
 f.existing({state:0,station:foreign==="offer"?null:600});
 f.foreign({state:foreign==="none"?0:foreign==="offer"?1:2,blocks:foreign==="blocking accepted"});
 f.reports.length=0;
 const handle=await backend.start({...f.run,resumed:true,fetch:baseFetch});
 try{
  await until(()=>["stopped","paused"].includes(f.reports.at(-1)?.status));
  if(foreign==="blocking accepted"){
   assert.equal(f.reports.at(-1).status,"paused");
   assert.match(f.reports.at(-1).why,/accepted mission requires manual review/);
   assert.deepEqual(f.events.slice(2),["request"]);
   assert.equal(f.foreignState(),2);
   return;
  }
  assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
  assert.deepEqual(f.reports.filter(r=>r.phase==="Mission completed").map(r=>r.readout.completedCount),[1]);
  assert.equal(f.fence().completed(1,2,f.run.botID).length,1);
  const recovery=foreign==="offer"?["decline","route-600"]:[];
  assert.deepEqual(f.events.slice(2),[...recovery,"request","accept","hangar-cargo","route-601","cargo-hangar","complete"]);
 }finally{await handle.stop();}
});

test("hosted Courier checks the hand-in again when the same delivered mission is still accepted",async()=>{
 const f=fixture(),backend=withCivilianPolicy(f.backend,"distribution",{write(){}});
 const baseFetch=f.run.fetch;
 f.run.fetch=async(input:unknown,init?:RequestInit)=>{
  if(new URL(String(input)).pathname==="/api/bridge/call"){
   const command=JSON.parse(String(init?.body));
   if(command.method==="DoAction"&&command.args[0]===30)
    return Response.json({ok:false,error:"EVE_GATEWAY_UNREACHABLE"},{status:502});
  }
  return baseFetch(input,init);
 };
 const old=await backend.start(f.run);
 await until(()=>f.reports.at(-1)?.status==="paused");
 await old.stop();
 assert.equal(f.fence().inspect(1,2)?.pending?.intent.kind,"complete");
 const before=f.events.length;
 f.reports.length=0;
 const handle=await backend.start({...f.run,resumed:true,fetch:baseFetch});
 try{
  await until(()=>["stopped","paused"].includes(f.reports.at(-1)?.status));
  assert.deepEqual(f.events.slice(before),["complete"]);
  assert.equal(f.reports.at(-1).status,"stopped");
  assert.equal(f.reports.at(-1).readout.completedCount,1);
 }finally{await handle.stop();}
});

test("hosted Courier can resume its native flight even when no checkpoint was saved",async()=>{
 const f=fixture();
 f.existing({state:2,aboard:true,station:null});
 const handle=await f.backend.start({...f.run,resumed:true});
 try{
  await until(()=>f.reports.some(r=>r.readout?.completedCount===1));
  assert.deepEqual(f.events,["route-601","cargo-hangar","complete"]);
 }finally{await handle.stop();}
});

test("hosted Courier keeps its original time limit after restart",async()=>{
 const f=fixture(false,false,false,false,600000,false,"none",1,false,true);
 const backend=withCivilianPolicy(f.backend,"distribution",{write(){}});
 const baseFetch=f.run.fetch;
 f.run.fetch=async(input:unknown,init?:RequestInit)=>{
  if(new URL(String(input)).pathname==="/api/bridge/flight/status")throw Error("Test child interrupted before its first read.");
  return baseFetch(input,init);
 };
 const old=await backend.start(f.run);
 await until(()=>f.reports.at(-1)?.status==="paused");
 const resumeData=f.reports[0]?.resumeData;
 assert.ok(Number.isSafeInteger(resumeData?.deadlineMs));
 await old.stop();
 f.reports.length=0;
 const handle=await backend.start({...f.run,resumed:true,resumeData,fetch:baseFetch});
 try{
  await until(()=>["stopped","paused"].includes(f.reports.at(-1)?.status));
  assert.equal(f.reports[0].phase,"Resuming");
  assert.deepEqual(f.reports[0].resumeData,resumeData);
  assert.equal(f.reports.at(-1).status,"stopped");
  assert.equal(f.reports.at(-1).readout.completedCount,2);
 }finally{await handle.stop();}
});

test('same-owner Recovery reads an accepted journal but preserves an unacknowledged Accept without replay or completion',async()=>{const f=fixture(true),row={worldID:'synthetic-distribution',owner:'tester',characterID:2,botID:'bot',kind:'distribution' as const,status:'paused',phase:'Paused',pending:'accept',firstFailure:'response lost',resolved:false,updatedAt:1};bindCivilianScope(f.run,()=>row);const handle=await f.backend.start(f.run);await until(()=>f.reports.some(r=>r.status==='paused'));await new Promise(r=>setImmediate(r));const before=[...f.events],checked:any=await inspectCivilianOwner(row);assert.equal(checked.scope,'EXISTING_OWNER');assert.equal(checked.pending,'accept');assert.equal(checked.nativeReconciled,false);assert.equal(checked.missionSettled,false);assert.equal(checked.activeMissions,1);assert.deepEqual(f.events,before);assert.equal(f.reports.at(-1).status,'paused');assert.equal(f.reports.at(-1).phase,'Recovery reviewed');assert.equal(f.reports.at(-1).readout.completedCount,0);await handle.stop();});
test("standalone controller performs one exact courier mission with durable writes",async()=>{
 const f=fixture(),handle=await f.backend.start(f.run);
 try{
  await until(()=>f.reports.some(r=>r.status==="stopped"||r.status==="paused"));
 assert.deepEqual(f.events,["request","accept","hangar-cargo","route-601","cargo-hangar","complete"]);
  assert.deepEqual(f.timing.filter(r=>r.event==='phase').map(r=>r.phase),['Observing mission','Finding an agent','Requesting','Accepting','Loading','Traveling','Delivering','Completing']);
  assert.ok(f.timing.filter(r=>r.event==='phase').every(r=>Number(r.elapsedMs)>=0&&Number(r.reads)>=0&&Number(r.readMs)>=0));
  assert.ok(f.timing.some(r=>r.event==='route-started'&&r.destinationID===601&&r.started===1));
  assert.ok(f.timing.some(r=>r.event==='mission-confirmed'&&r.completedCount===1&&Number(r.elapsedMs)>=0));
 assert.equal(f.reports.at(-1).readout.completedCount,1);assert.equal(f.reports.at(-1).readout.agentID,9);assert.equal(f.reports.at(-1).readout.mission,900);assert.equal(f.reports.at(-1).readout.parking.destinationID,601);assert.equal(f.reports.at(-1).readout.pending,null);assert.ok(f.reports.at(-1).readout.reward);assert.equal(f.reports.at(-1).status,"stopped");
 }finally{await handle.stop();}
});

test("Courier reads one exact inventory pair per transfer and the capacity panel only for its offer",async()=>{
 const f=fixture(),fetch=f.run.fetch;
 let panels=0;
 const beforeLoad:string[]=[],beforeUnload:string[]=[];
 f.run.fetch=(input:URL,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname;
  if(path==="/api/bridge/inventory")panels++;
  if(path==="/api/bridge/call"){
   const {method,of}=JSON.parse(String(init?.body));
   const last=f.events.at(-1),reads=last==="accept"?beforeLoad:last==="route-601"?beforeUnload:null;
   if(method==="List"&&reads)reads.push(of==="hangar"?"hangar":"cargo");
  }
  return fetch(input,init);
 };
 const handle=await f.backend.start(f.run);
 try{
  await until(()=>f.reports.some(r=>r.status==="stopped"||r.status==="paused"));
  assert.deepEqual(f.events,["request","accept","hangar-cargo","route-601","cargo-hangar","complete"]);
  assert.equal(panels,1);
  assert.deepEqual(beforeLoad,["cargo","cargo","hangar"]);
  assert.deepEqual(beforeUnload,["cargo","hangar"]);
 }finally{await handle.stop();}
});

test("Courier replans a confirmed pre-start timeout in the same mission with a fresh flight read",{timeout:3000},async t=>{
 t.mock.timers.enable({apis:["setTimeout"]});
 const f=fixture(),cause=Object.assign(Error("flight origin timed out"),{code:"CALL_TIMEOUT"});
 let starts=0,readAfterRefusal=0;
 const fetch=f.run.fetch;
 f.run.fetch=async(input:URL,init?:RequestInit)=>{
  if(starts===1&&new URL(String(input)).pathname.endsWith("/flight/status"))readAfterRefusal++;
  return fetch(input,init);
 };
 let markRefused=()=>{};
 const refused=new Promise<void>(resolve=>{markRefused=resolve;});
 f.route.beforeStart=destination=>{
  assert.equal(destination,601);
  if(++starts===1){markRefused();return {started:false,reason:"Could not read your location",cause};}
  assert.ok(readAfterRefusal>0);
 };
 let finish=()=>{};
 const finished=new Promise<void>(resolve=>{finish=resolve;});
 const report=f.run.report;
 f.run.report=(r:any)=>{report(r);if(r.status==="stopped"||r.status==="paused")finish();};
 const handle=await f.backend.start(f.run);
 try{
  await refused;
  await new Promise<void>(resolve=>setImmediate(resolve));
  t.mock.timers.tick(2000);
  await finished;
  assert.equal(f.reports.at(-1)?.status,"stopped",JSON.stringify(f.reports.at(-1)));
  assert.equal(f.reports.at(-1)?.readout.completedCount,1);
  assert.deepEqual(f.events,["request","accept","hangar-cargo","route-601","cargo-hangar","complete"]);
  assert.deepEqual(f.timing.filter(r=>r.event==="route-started").map(r=>r.started),[0,1]);
  assert.equal(starts,2);
  assert.equal(f.attached.length,1);
 }finally{
  await handle.stop();
 }
});

test("Courier does not resend a route with an unknown result or a confirmed non-transient refusal",async()=>{
 for(const confirmedRefusal of [false,true]){
  const f=fixture(),cause=Object.assign(Error("route response lost"),{code:"CALL_TIMEOUT"});
  let starts=0;
  f.route.beforeStart=()=>{
   starts++;
   if(!confirmedRefusal)throw cause;
   return {started:false,reason:"No route to destination",cause:Object.assign(Error("No route"),{status:409})};
  };
  const handle=await f.backend.start(f.run);
  try{
   await until(()=>f.reports.some(r=>r.status==="paused"));
   assert.match(f.reports.at(-1).why,confirmedRefusal?/No route to destination/:/route response lost/);
   assert.equal(starts,1);
   assert.deepEqual(f.events,["request","accept","hangar-cargo"]);
  }finally{
   await handle.stop();
  }
 }
});
test("Courier declines an over-limit offer and completes the next fitting one",async()=>{
 const f=fixture();f.offerRoutes.set(9,[11,5]);
 const handle=await f.backend.start(f.run);
 try{
  await until(()=>["stopped","paused"].includes(f.reports.at(-1)?.status));
  assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
  assert.deepEqual(f.events,["request","decline","request","accept","hangar-cargo","route-601","cargo-hangar","complete"]);
  assert.equal(f.reports.at(-1).readout.completedCount,1);
  assert.equal(f.fence().completed(1,2,f.run.botID).length,1);
 }finally{await handle.stop();}
});

test("Courier tries another eligible agent after a repeated over-limit offer",async()=>{
 const f=fixture(false,false,false,false,600000,false,"none",1,true);
 f.offerRoutes.set(9,[11,11]);f.offerRoutes.set(10,[5]);
 const handle=await f.backend.start(f.run);
 try{
  await until(()=>["stopped","paused"].includes(f.reports.at(-1)?.status));
  assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
  assert.deepEqual(f.requestedAgents,[9,9,10]);
  assert.deepEqual(f.declinedAgents,[9]);
  assert.equal(f.leftOffer(),9);
  assert.equal(f.fence().completed(1,2,f.run.botID)[0]?.receipt.agentID,10);
 }finally{await handle.stop();}
});

test("Courier leaves an over-limit offer with a native decline timer and tries another agent",async()=>{
 const f=fixture(false,false,false,false,600000,false,"none",1,true);
 f.existing({state:1,jumps:11});
 f.declinedAgents.push(9);
 f.offerRoutes.set(10,[5]);
 const handle=await f.backend.start(f.run);
 try{
  await until(()=>["stopped","paused"].includes(f.reports.at(-1)?.status));
  assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
  assert.match(f.reports.find(r=>r.why?.includes("Offer left for review")).why,/6s remaining/);
  assert.deepEqual(f.requestedAgents,[10]);
  assert.deepEqual(f.declinedAgents,[9]);
  assert.equal(f.leftOffer(),9);
 }finally{await handle.stop();}
});

test("Courier pauses once when the selected agent has only over-limit offers",async()=>{
 const f=fixture();f.offerRoutes.set(9,[11,11,11]);
 const handle=await f.backend.start(f.run);
 try{
  await until(()=>f.reports.at(-1)?.status==="paused");
  assert.match(f.reports.at(-1).why,/selected agent.*11 jumps.*limit 10.*replacement offer/i);
  assert.deepEqual(f.events,["request","decline","request"]);
  assert.equal(f.fence().inspect(1,2)?.pending,null);
  assert.equal(f.fence().inspect(1,2)?.mission,null);
 }finally{await handle.stop();}
});

test("Courier and Continue finish an already accepted Delivery beyond the current limit",async()=>{
 for(const continuation of [false,true]){
  const f=fixture(),old=continuation?savedCourier(f):null;
  f.existing({state:2,aboard:true,jumps:11});
  const backend=old?continueCourier(f,"continued",old.mission):f.backend;
  const handle=await backend.start(f.run);
  try{
   await until(()=>["stopped","paused"].includes(f.reports.at(-1)?.status));
   assert.equal(f.reports.at(-1).phase,"Completed");
   assert.deepEqual(f.events,["cargo-hangar","complete"]);
   assert.deepEqual(f.distances,{});
  }finally{await handle.stop();}
 }
});

test("automatic up-to-four selects an eligible level-one Distribution agent",async()=>{
 const f=fixture(false,false,false,false,600000,false,"none",1,true),handle=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.status==="stopped"||r.status==="paused"));
 assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
 assert.deepEqual(f.levels,[4,3,2,1]);assert.equal(f.events.filter(x=>x==="request").length,1);await handle.stop();
});
test("an incomplete Finder read retries the same run, then requests and accepts once",{timeout:5000},async t=>{
 t.mock.timers.enable({apis:["setTimeout"]});
 const f=fixture(false,false,false,false,600000,false,"none",1,true);
 f.route.finderIncomplete=1;
 let onRetry!:()=>void,onFinish!:()=>void;
 const retrying=new Promise<void>(resolve=>{onRetry=resolve;}),finished=new Promise<void>(resolve=>{onFinish=resolve;});
 const report=f.run.report;
 f.run.report=(r:any)=>{
  report(r);
  if(r.why==="The agent directory or route distances are incomplete."||r.status==="paused")onRetry();
  if(r.status==="stopped"||r.status==="paused")onFinish();
 };
 const handle=await f.backend.start(f.run);
 try{
  await retrying;
  assert.equal(f.reports.at(-1).phase,"Finding an agent");
  t.mock.timers.tick(2000);
  await finished;
  assert.equal(f.reports.at(-1).status,"stopped");
  assert.deepEqual(f.levels,[4,4,3,2,1]);
  assert.equal(f.events.filter(e=>e==="accept").length,1);
  assert.equal(f.events.filter(e=>e==="request").length,1);
 }finally{await handle.stop();}
});
test("a complete Finder reply with no eligible corporation remains a confirmed no-agent outcome",async()=>{
 const f=fixture(false,false,false,false,600000,false,"none",1,true);
 f.run.setup.agent.corporationID=999;
 const handle=await f.backend.start(f.run);
 try{
  await until(()=>f.reports.some(r=>r.status==="paused"));
  assert.match(f.reports.at(-1).why,/No eligible Distribution agent/);
  assert.deepEqual(f.levels,[4,3,2,1]);
  assert.deepEqual(f.events,[]);
 }finally{await handle.stop();}
});
test("auto mode uses the compatible existing offer before agent search and continues toward 40",async()=>{
 const f=fixture(false,false,false,false,600000,false,"none",40,true);
 // Agent 9 is not the next automatic discovery result; finishing the inherited
 // offer must happen before that search. The completed journal row is historical.
 f.existing({state:1,completedRow:true,delayedReads:2});
 const handle=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.readout?.completedCount===2||r.status==="paused"));
 assert.ok(f.reports.some(r=>r.readout?.completedCount===2),JSON.stringify(f.reports.at(-1)));
 assert.deepEqual(f.events.slice(0,5),["accept","hangar-cargo","route-601","cargo-hangar","complete"]);
 assert.equal(f.events.filter(x=>x==="request").length,f.events.filter(x=>x==="accept").length-1);
 assert.ok(f.reports.filter(r=>r.phase==="Mission completed").slice(0,2).every((r,i)=>r.readout.completedCount===i+1));
 const stop=await runControlRoutes["POST /runs/:botID/stop"]({params:{botID:"bot"},account:{username:"tester",accountID:1},method:"POST",path:"",query:{},body:{}});
 assert.equal(stop.status,202);await until(()=>f.reports.some(r=>r.status==="stopped"));await handle.stop();
});
test("an accepted courier with the exact load aboard resumes at destination without accepting or reloading",async()=>{
 const f=fixture();f.existing({state:2,aboard:true,completedRow:true});f.foreign({state:1});
 const handle=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.status==="stopped"||r.status==="paused"));
 assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
 assert.deepEqual(f.events,["cargo-hangar","complete"]);
 assert.equal(f.reports.at(-1).readout.completedCount,1);await handle.stop();
});
test("an accepted courier with the exact load aboard in space flies directly to delivery",async()=>{
 const f=fixture();f.existing({state:2,aboard:true,station:null});
 const handle=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.status==="stopped"||r.status==="paused"));
 assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
 assert.deepEqual(f.events,["route-601","cargo-hangar","complete"]);await handle.stop();
});
test("Courier observes a jump and docks on the original route without a second snapshot poll",{timeout:3000},async t=>{
 t.mock.timers.enable({apis:["setTimeout"]});
 const f=fixture(false,false,false,true,7_200_000);
 f.route.useShared=true;
 f.existing({state:2,aboard:true,station:null});
 f.route.systemID=301;
 f.route.snapshot=decodeSpaceSnapshot({inSpace:true,stateValid:true,shipID:3,solarSystemID:301,
  ship:{itemID:3,position:{x:10,y:20,z:30},radius:1}});
  let extraGridReads=0,routeFlightReads=0,arrivalRead=false;
 const fetch=f.run.fetch;
 f.run.fetch=async(input:URL,init?:RequestInit)=>{
   const path=new URL(String(input)).pathname,response=await fetch(input,init);
   if(path==="/api/bridge/space/snapshot")extraGridReads++;
   if(path==="/api/bridge/flight/status"&&f.events.includes("flying")&&!arrivalRead){
    routeFlightReads++;
    arrivalRead=(await response.clone().json()).flight.stationID===601;
   }
   return response;
 };
 const report=f.run.report;
 const finished=new Promise<void>(resolve=>{f.run.report=(r:any)=>{
  report(r);if(r.status==="stopped"||r.status==="paused")resolve();
 };});
 const initialGrid=new Promise<void>(resolve=>{f.route.onObserve=resolve;});
 const handle=await f.backend.start(f.run);
 try{
  await initialGrid;
  f.route.systemID=300;
  // Crossing the prior idle limit on the new system must still count as progress.
  f.route.clockOffset=3_600_001;
  const postJumpGrid=new Promise<void>(resolve=>{f.route.onObserve=resolve;});
  t.mock.timers.tick(2000);
  await postJumpGrid;
  f.existing({state:2,aboard:true,station:601});
  t.mock.timers.tick(2000);
  await finished;
  assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
  assert.deepEqual(f.events,["flying","cargo-hangar","complete"]);
  assert.equal(extraGridReads,0);
   assert.equal(routeFlightReads,1);
 }finally{await handle.stop();}
});
test("Courier lets the stock route read a temporarily unavailable flight during a jump",{timeout:3000},async t=>{
 t.mock.timers.enable({apis:["setTimeout"]});
 const f=fixture(false,false,false,true,7_200_000);
 f.route.useShared=true;f.route.flightUnavailable=true;
 f.existing({state:2,aboard:true,station:null});
 let routeReads=0;
 const fetch=f.run.fetch;
 f.run.fetch=(input:URL,init?:RequestInit)=>{
  if(f.events.includes("flying")&&new URL(String(input)).pathname.endsWith("/flight/status"))routeReads++;
  return fetch(input,init);
 };
 const firstPass=new Promise<void>(resolve=>{f.route.onObserve=resolve;});
 const report=f.run.report;
 const finished=new Promise<void>(resolve=>{f.run.report=(row:any)=>{
  report(row);if(row.status==="stopped"||row.status==="paused")resolve();
 };});
 const handle=await f.backend.start(f.run);
 try{
  await firstPass;
  f.route.systemID=302;
  const afterJump=new Promise<void>(resolve=>{f.route.onObserve=resolve;});
  t.mock.timers.tick(2000);await afterJump;
  const extraFlightReads=routeReads;
  f.route.systemID=300;
  f.existing({state:2,aboard:true,station:601});
  t.mock.timers.tick(2000);
  await finished;
  assert.equal(extraFlightReads,0);
  assert.ok(f.timing.some(record=>record.event==="route-arrived"));
  assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
  assert.deepEqual(f.events,["flying","cargo-hangar","complete"]);
 }finally{await handle.stop();}
});
test("an accepted courier docked at an empty destination can still go to pickup",async()=>{
 const f=fixture();f.existing({state:2,station:601});
 const handle=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.status==="stopped"||r.status==="paused"));
 assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
 assert.deepEqual(f.events,["route-600","hangar-cargo","route-601","cargo-hangar","complete"]);await handle.stop();
});
test("an accepted courier with partial destination stock pauses without transferring again",async()=>{
 const f=fixture(false,false,false,false,600000,false,"preexisting-destination");
 f.existing({state:2,station:601});
 const handle=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.status==="paused"));
 assert.match(f.reports.at(-1).why,/matching cargo is in the destination hangar/);
 assert.equal(f.reports.at(-1).readout.completedCount,0);assert.deepEqual(f.events,[]);await handle.stop();
});
for(const status of [1,2] as const)test(`Carthum courier work ${status===1?"declines an Amarr Navy offer":"keeps an unrelated Amarr Navy accepted mission"}`,async()=>{
 const f=fixture(false,false,false,false,600000,false,"none",2,true);
 f.foreign({state:status});
 const handle=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.status==="stopped"||r.status==="paused"));
 try{
  assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
  assert.equal(f.reports.at(-1).readout.completedCount,2);
  assert.equal(f.reports.at(-1).readout.agentID,9);
  const actions=["request","accept","complete","request","accept","complete"];
  assert.deepEqual(f.events.filter(x=>["request","accept","complete","decline","quit"].includes(x)),status===1?["decline",...actions]:actions);
  assert.equal(f.foreignState(),status===1?0:2);
 }finally{await handle.stop();}
});
for(const state of [1,2] as const)test(`an explicitly blocking foreign ${state===1?"offer is declined once":"accepted courier stays accepted"}`,async()=>{
 const f=fixture();
 f.foreign({state,blocks:true});
 const handle=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.status==="stopped"||r.status==="paused"));
 try{
  const actions=f.events.filter(x=>["request","accept","complete","decline","quit"].includes(x));
  if(state===2){
   assert.equal(f.reports.at(-1).status,"paused");
   assert.match(f.reports.at(-1).why,/accepted mission requires manual review/);
   assert.deepEqual(actions,["request"]);
   assert.equal(f.foreignState(),2);
  }else{
   assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
   assert.deepEqual(actions,["request","decline","request","accept","complete"]);
   assert.equal(f.reports.at(-1).readout.completedCount,1);
   assert.equal(f.foreignState(),0);
  }
 }finally{await handle.stop();}
});
test("native decline timer prevents dispatch and reports the remaining time",async()=>{
 const f=fixture();f.foreign({state:1,blocks:true,cooldown:50_000_000});
 const handle=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.status==="paused"));
 try{
  assert.match(f.reports.at(-1).why,/Corporate Documents.*agent 3008740.*5s remaining/);
  assert.deepEqual(f.events,["request"]);
  assert.equal(f.foreignState(),1);
 }finally{await handle.stop();}
});
test("a native decline refusal is reported once and the run can still Stop",async()=>{
 const f=fixture();f.foreign({state:1,blocks:true,refusal:"Declining is currently disabled."});
 const handle=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.status==="paused"));
 try{
  assert.match(f.reports.at(-1).why,/Declining is currently disabled/);
  assert.deepEqual(f.events,["request","decline"]);
  assert.equal(f.foreignState(),1);
  assert.equal(f.fence().inspect(1,2)?.pending,null);
  const stop=await runControlRoutes["POST /runs/:botID/stop"]({params:{botID:"bot"},account:{username:"tester",accountID:1},method:"POST",path:"",query:{},body:{}});
  assert.equal(stop.status,202);
  await until(()=>f.reports.some(r=>r.status==="stopped"));
 }finally{await handle.stop();}
});
test("after a lost Decline response a fresh Courier uses the current journal without replaying it",async()=>{
 const f=fixture();f.foreign({state:1,blocks:true,lost:true});
 const handle=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.status==="paused"));
 await handle.stop();
 assert.deepEqual(f.events,["request","decline"]);
 f.foreign({state:0});
 f.run.botID="after-decline";
 const fresh=await f.backend.start(f.run);
 try{
  await until(()=>f.reports.some(r=>r.readout?.completedCount===1));
  assert.deepEqual(f.events.filter(x=>["request","decline","accept","complete"].includes(x)),
    ["request","decline","request","accept","complete"]);
 }finally{await fresh.stop();}
});
test("a foreign accepted referral cannot be turned in by a courier Request",async()=>{
 const f=fixture(false,false,false,false,600000,false,"none",1,true);
 f.foreign({state:2,referral:true});
 const handle=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.status==="paused"));
 try{
  assert.match(f.reports.at(-1).why,/Agent 9 would turn in Corporate Documents/);
  assert.deepEqual(f.events,[]);
  assert.equal(f.foreignState(),2);
 }finally{await handle.stop();}
});
test("an unfinished run with a verified unload continues at hand-in without another transfer",async()=>{
 const f=fixture();f.existing({state:2});f.blockCompletionRead(true);
 const old=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.status==="paused"));
 assert.deepEqual(f.events,["hangar-cargo","route-601","cargo-hangar"]);
 assert.equal(f.reports.at(-1).readout.completedCount,0);await old.stop();
 f.run.botID="new";f.blockCompletionRead(false);
 const continued=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.status==="stopped"));
 assert.deepEqual(f.events,["hangar-cargo","route-601","cargo-hangar","complete"]);
 assert.equal(f.reports.at(-1).readout.completedCount,1);await continued.stop();
});
test("an ended run that made no mission mutation leaves an inheritable empty checkpoint",async()=>{
 const f=fixture();f.existing({state:1,agent:8});
 const old=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.status==="paused"));
 // Simulate process/owner loss after the recorded pause. The old host did not
 // run its Stop cleanup, so the original untouched record stays on disk.
 const saved=structuredClone(f.getStorage()) as any;
 assert.equal(saved.records["1:2"].mutated,false);assert.equal(saved.records["1:2"].done,false);
 await old.stop();
 f.reports.length=0;f.restoreStorage(saved);f.run.botID="new";f.run.setup.agent.agentID=8;
 const continued=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.status==="stopped"));
 assert.deepEqual(f.events,["accept","hangar-cargo","route-601","cargo-hangar","complete"]);
 assert.equal(f.reports.at(-1).readout.completedCount,1);await continued.stop();
});
test("time mode continues past count one and stops at the duration boundary",async()=>{
 const f=fixture(false,false,false,false,600000,false,"none",1,false,true),handle=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.status==="stopped"||r.status==="paused"));
 assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));assert.equal(f.reports.at(-1).readout.completedCount,2);assert.equal(f.events.filter(x=>x==="complete").length,2);await handle.stop();
});
test("two missions retain both native completion receipts before parking",async()=>{
 const f=fixture(false,false,false,false,600000,false,"none",2),handle=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.status==="stopped"||r.status==="paused"));
 assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
 assert.equal(f.reports.at(-1).readout.completedCount,2);
 assert.equal(f.events.filter(x=>x==="request").length,2);
 assert.equal(f.events.filter(x=>x==="accept").length,2);
 assert.equal(f.events.filter(x=>x==="complete").length,2);
 const saved:any=f.getStorage();assert.equal(saved.history.length,1);
 assert.equal(saved.history[0].row.completion.completed,true);assert.ok(saved.history[0].row.reward);
 assert.equal(saved.records["1:2"].completion.completed,true);assert.ok(saved.records["1:2"].reward);
 await handle.stop();
});
test("Courier retries a Gateway reset and keeps progress through the next mission in the same hosted run",async()=>{
 const f=fixture(false,false,false,false,600000,false,"none",2),baseFetch=f.run.fetch;
 let failures=0;
 f.run.fetch=async(input:unknown,init?:RequestInit)=>{
  if(new URL(String(input)).pathname==="/api/bridge/flight/status"&&f.reports.some(r=>r.readout?.completedCount===1)&&failures<2){
   if(++failures===1)throw new TypeError("fetch failed",{cause:{code:"ECONNRESET"}});
   return Response.json({ok:false,error:"EVE_GATEWAY_UNREACHABLE",message:"EveJS gateway is unreachable."},{status:502});
  }
  return baseFetch(input,init);
 };
 const handle=await f.backend.start(f.run);
 try{
  await until(()=>f.reports.some(r=>r.status==="stopped"||r.status==="paused"));
  assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
  assert.equal(failures,2);
  assert.deepEqual(f.reports.filter(r=>r.phase==="Mission completed").map(r=>[r.readout.completedCount,r.readout.receipt.runID]),[[1,"bot"],[2,"bot"]]);
  for(const event of ["request","accept","hangar-cargo","cargo-hangar","complete"])
   assert.equal(f.events.filter(x=>x===event).length,2,event);
 }finally{await handle.stop();}
});
test("Courier bounds repeated Gateway read errors and reports the final failure",async()=>{
 const f=fixture();
 let reads=0;
 const baseFetch=f.run.fetch;
 f.run.fetch=async(input:unknown,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname,method=init?.body?JSON.parse(String(init.body)).method:null;
  if(path!=="/api/bridge/call"||method!=="GetMyJournalDetails")return baseFetch(input,init);
  reads++;
  return Response.json({ok:false,error:"EVE_GATEWAY_UNREACHABLE",message:"EveJS gateway is unreachable."},{status:502});
 };
 const handle=await f.backend.start(f.run);
 try{
  await until(()=>f.reports.some(r=>r.status==="paused"));
  assert.equal(reads,3);
  assert.equal(f.reports.at(-1).why,"EveJS gateway is unreachable.");
  assert.deepEqual(f.events,[]);
 }finally{await handle.stop();}
});
test("Courier reports lost authorization immediately without retrying the read",async()=>{
 const f=fixture(),baseFetch=f.run.fetch;
 let reads=0;
 f.run.fetch=async(input:unknown,init?:RequestInit)=>{
  if(new URL(String(input)).pathname!=="/api/bridge/flight/status")return baseFetch(input,init);
  reads++;
  return Response.json({ok:false,error:"AUTH_REQUIRED"},{status:401});
 };
 const handle=await f.backend.start(f.run);
 try{
  await until(()=>f.reports.some(r=>r.status==="paused"));
  assert.equal(reads,1);
  assert.equal(f.reports.at(-1).why,"AUTH_REQUIRED");
  assert.deepEqual(f.events,[]);
 }finally{await handle.stop();}
});
for(const mode of ["operator Stop","host stop"] as const)test(`Courier ${mode} cancels the next productive read during Gateway backoff`,async()=>{
 const f=fixture(),baseFetch=f.run.fetch;
 let reads=0;
 f.run.fetch=async(input:unknown,init?:RequestInit)=>{
  if(new URL(String(input)).pathname==="/api/bridge/flight/status"&&++reads===1)
   return Response.json({ok:false,error:"EVE_GATEWAY_UNREACHABLE",message:"EveJS gateway is unreachable."},{status:502});
  return baseFetch(input,init);
 };
 const handle=await f.backend.start(f.run);
 try{
  await until(()=>reads===1);
  await new Promise(resolve=>setTimeout(resolve,25));
  if(mode==="operator Stop"){
   const stop=await runControlRoutes["POST /runs/:botID/stop"]({params:{botID:"bot"},account:{username:"tester",accountID:1},method:"POST",path:"",query:{},body:{}});
   assert.equal(stop.status,202);
   await until(()=>f.reports.some(r=>r.status==="stopped"));
   assert.equal(reads,2,"Only the original read and the docking verification should run");
  }else{
   await handle.stop();
   assert.equal(reads,1);
  }
  assert.deepEqual(f.events,[]);
  assert.ok(!f.reports.some(r=>r.status==="paused"));
 }finally{await handle.stop();}
});
for(const action of ["accept","transfer","complete"] as const)test(`Courier never retries a dispatched ${action} on Gateway 502`,async()=>{
 const f=fixture(),baseFetch=f.run.fetch;
 let writes=0;
 f.run.fetch=async(input:unknown,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname;
  const body=init?.body?JSON.parse(String(init.body)):null;
  if(action==="transfer"?path==="/api/bridge/inventory/transfer":
   path==="/api/bridge/call"&&body?.method==="DoAction"&&body.args[0]===(action==="accept"?20:30)){
   writes++;
   await baseFetch(input,init);
   return Response.json({ok:false,error:"EVE_GATEWAY_UNREACHABLE",message:"EveJS gateway is unreachable."},{status:502});
  }
  return baseFetch(input,init);
 };
 const handle=await f.backend.start(f.run);
 try{
  await until(()=>f.reports.some(r=>r.status==="paused"));
  assert.equal(writes,1);
  assert.equal(f.fence().inspect(1,2)?.pending?.intent.kind,action==="transfer"?"load":action);
  assert.equal(f.reports.at(-1).readout.completedCount,0);
 }finally{await handle.stop();}
});
test("lost Accept response is fenced and cannot be replayed by a new run",async()=>{
 const f=fixture(true),handle=await f.backend.start(f.run);await until(()=>f.reports.some(r=>r.status==="paused"));
 assert.deepEqual(f.events,["request","accept"]);await handle.stop();
 assert.throws(()=>f.fence().open({accountID:1,characterID:2,runID:"new",current:()=>true}),/RECOVERY_REQUIRED/);
});

 test("lost Complete response never reports completion or replays",async()=>{
 const f=fixture(false,true),handle=await f.backend.start(f.run);await until(()=>f.reports.some(r=>r.status==="paused"));
 assert.deepEqual(f.events,["request","accept","hangar-cargo","route-601","cargo-hangar","complete"]);
 assert.equal(f.reports.at(-1).readout.completedCount,0);await handle.stop();
 assert.throws(()=>f.fence().open({accountID:1,characterID:2,runID:"new",current:()=>true}),/RECOVERY_REQUIRED/);
});

 test("plugin stop settles the in-flight action and reports stopped only after docking",async()=>{
 const f=fixture(false,false,true),handle=await f.backend.start(f.run);await until(()=>f.events.includes("accept"));
 const response=await runControlRoutes["POST /runs/:botID/stop"]({params:{botID:"bot"},account:{username:"tester",accountID:1},method:"POST",path:"",query:{},body:{}});
 assert.equal(response.status,202);assert.ok(!f.reports.some(r=>r.status==="stopped"));f.releaseAccept();
 await until(()=>f.reports.some(r=>r.status==="stopped"));
 assert.deepEqual(f.events,["request","accept"]);assert.equal(f.reports.at(-1).phase,"Docked");assert.equal(f.reports.at(-1).readout.completedCount,0);
 await handle.stop();assert.throws(()=>f.fence().open({accountID:1,characterID:2,runID:"new",current:()=>true}),/RECOVERY_REQUIRED/);
});

 test("plugin stop while flying routes to a local station before terminal status",async()=>{
 const f=fixture(false,false,false,true),handle=await f.backend.start(f.run);await until(()=>f.events.includes("flying"));
 const response=await runControlRoutes["POST /runs/:botID/stop"]({params:{botID:"bot"},account:{username:"tester",accountID:1},method:"POST",path:"",query:{},body:{}});
 assert.equal(response.status,202);assert.ok(!f.reports.some(r=>r.status==="stopped"));
 await new Promise(r=>setTimeout(r,2100));await until(()=>f.reports.some(r=>r.status==="stopped"));
 assert.ok(f.events.includes("route-602"));assert.equal(f.reports.at(-1).phase,"Docked");assert.equal(f.reports.at(-1).readout.completedCount,0);await handle.stop();
});

 test("verified runtime winddown parks before issuing a new mission",async()=>{
 const f=fixture(false,false,false,false,120000),handle=await f.backend.start(f.run);
 await until(()=>f.reports.some(r=>r.status==="stopped"||r.status==="paused"));
 assert.deepEqual(f.events,[]);assert.equal(f.reports.at(-1).phase,"Docked");assert.equal(f.reports.at(-1).readout.completedCount,0);await handle.stop();
});

 test("failed parking remains paused and a later Stop retries",async()=>{
 const f=fixture(false,false,false,true);f.setFailParking(true);const handle=await f.backend.start(f.run);await until(()=>f.events.includes("flying"));
 const request={params:{botID:"bot"},account:{username:"tester",accountID:1},method:"POST",path:"",query:{},body:{}};
 await runControlRoutes["POST /runs/:botID/stop"](request);await new Promise(r=>setTimeout(r,2100));await until(()=>f.reports.some(r=>r.status==="paused"));
 assert.ok(!f.reports.some(r=>r.status==="stopped"));f.setFailParking(false);await runControlRoutes["POST /runs/:botID/stop"](request);
 await until(()=>f.reports.some(r=>r.status==="stopped"));assert.ok(f.events.includes("route-602"));await handle.stop();
});

 test("objective identity mismatch blocks before Accept",async()=>{
 const f=fixture(false,false,false,false,600000,true),handle=await f.backend.start(f.run);await until(()=>f.reports.some(r=>r.status==="paused"));
 assert.deepEqual(f.events,["request"]);assert.match(f.reports.at(-1).why,/identity/);await handle.stop();
});
 test("unresolved action stays paused even after a verified dock",async()=>{
 const f=fixture(true),handle=await f.backend.start(f.run);await until(()=>f.reports.some(r=>r.status==="paused"));
 await runControlRoutes["POST /runs/:botID/stop"]({params:{botID:"bot"},account:{username:"tester",accountID:1},method:"POST",path:"",query:{},body:{}});
 await new Promise(r=>setTimeout(r,30));assert.ok(!f.reports.some(r=>r.status==="stopped"));
 await handle.stop();
});

test("foreign native inventory identity blocks before mission cargo transfer",async()=>{
 const f=fixture(false,false,false,false,600000,false,"foreign"),handle=await f.backend.start(f.run);await until(()=>f.reports.some(r=>r.status==="paused"));
 assert.deepEqual(f.events,["request"]);assert.match(f.reports.at(-1).why,/identity changed/);await handle.stop();
});
test("lost transfer acknowledgement retains its intent and never retries",async()=>{
 const f=fixture(false,false,false,false,600000,false,"lost-transfer"),handle=await f.backend.start(f.run);await until(()=>f.reports.some(r=>r.status==="paused"));
 assert.deepEqual(f.events,["request","accept","hangar-cargo"]);assert.match(f.reports.at(-1).why,/transfer response lost/);await handle.stop();
 assert.throws(()=>f.fence().open({accountID:1,characterID:2,runID:"new",current:()=>true}),/RECOVERY_REQUIRED/);
});

test("pre-existing same-type destination stock is never treated as delivered mission cargo",async()=>{
 const f=fixture(false,false,false,false,600000,false,"preexisting-destination"),handle=await f.backend.start(f.run);await until(()=>f.reports.some(r=>r.status==="paused"));
 assert.deepEqual(f.events,["request","accept","hangar-cargo","route-601"]);assert.match(f.reports.at(-1).why,/ambiguous before delivery/);assert.equal(f.reports.at(-1).readout.completedCount,0);await handle.stop();
});

test("a verified offered mission continues without requesting another offer",async()=>{
 const f=fixture();f.prepareOffer();const handle=await f.backend.start(f.run);await until(()=>f.reports.some(r=>r.status==="stopped"||r.status==="paused"));
 assert.deepEqual(f.events,["accept","hangar-cargo","route-601","cargo-hangar","complete"]);
 assert.equal(f.reports.at(-1).readout.completedCount,1);const archive=(f.getStorage() as any).history;
 assert.equal(archive.length,1);assert.equal(archive[0].row.runID,"old");assert.equal(archive[0].row.done,false);assert.equal(archive[0].oldRunStatus,"retired");await handle.stop();
});
test("a second active hosted owner blocks offered handoff before any action",async()=>{
 const f=fixture();f.prepareOffer();f.setExtraBots([{botID:"other",characterID:2}]);
 await assert.rejects(async()=>await f.backend.start(f.run),/hosted owner/);assert.deepEqual(f.events,[]);assert.equal((f.getStorage() as any).records["1:2"].runID,"old");
});
test("an active old run blocks offered handoff before any action",async()=>{
 const f=fixture();f.prepareOffer();f.setExtraBots([{botID:"old",characterID:2}]);
 await assert.rejects(async()=>await f.backend.start(f.run),/hosted owner/);assert.deepEqual(f.events,[]);
});

test("a fresh hosted Courier after a full WC restart delivers the sixth mission and takes the next",async()=>{
 const f=fixture(false,false,false,false,600000,false,"none",6);
 const backend=withCivilianPolicy(f.backend,"distribution",{write(){}});
 const fetch=f.run.fetch, report=f.run.report;
 f.run.report=(event:any)=>{
  report(event);
  if(event.phase==="Mission completed"&&event.readout.completedCount===5)f.setPauseInTransit(true);
 };
 f.run.fetch=async(input:any,init:any)=>{
  if(new URL(String(input)).pathname==="/api/bridge/flight/status"&&f.events.at(-1)==="flying")
   throw Error("The first WC process stopped in transit.");
  return fetch(input,init);
 };
 const old=await backend.start(f.run);
 await until(()=>f.reports.at(-1)?.status==="paused");
 await old.stop();
 assert.equal(f.events.filter((event:string)=>event==="accept").length,6);
 assert.equal(f.events.filter((event:string)=>event==="hangar-cargo").length,6);
 const before=f.events.length;
 f.setPauseInTransit(false);
 f.reports.length=0;
 f.run.botID="second-wc-bot";
 f.run.held={characterID:2};
 f.run.setup={...f.run.setup,missionCount:2};
 f.run.report=report;
 f.run.fetch=fetch;
 const next=await backend.start(f.run);
 try {
  await until(()=>f.reports.at(-1)?.status==="stopped"||f.reports.at(-1)?.status==="paused");
  assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
  assert.equal(f.reports.at(-1).readout.completedCount,2);
  assert.deepEqual(f.events.slice(before),["route-601","cargo-hangar","complete","route-600","request","accept","hangar-cargo","route-601","cargo-hangar","complete"]);
 } finally { await next.stop(); }
});

test("a new Courier completes already delivered cargo without a retained unload",async()=>{
 const f=fixture();
 const old=f.fence().open({accountID:1,characterID:2,runID:"old-wc-bot",current:()=>true});
 old.bindMission(9,'[9,900,101,"123"]');
 f.existing({state:2,delivered:true});
 const handle=await f.backend.start(f.run);
 try {
  await until(()=>f.reports.at(-1)?.status==="stopped"||f.reports.at(-1)?.status==="paused");
  assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
  assert.deepEqual(f.events,["complete"]);
 } finally { await handle.stop(); }
});

test("a fresh hosted Courier counts a vanished mission with a sent Complete once",async()=>{
 const f=fixture(false,false,false,false,600000,false,"none",2);
 const key='[9,900,101,"old-expiry"]';
 const previous=f.fence().open({accountID:1,characterID:2,runID:"old-wc-bot",current:()=>true});
 previous.bindMission(9,key);
 previous.dispatch({kind:"complete",agentID:9,missionKey:key,runnerID:"old-wc-bot",invocationID:3,stepPath:"complete",actionID:30},
  {journal:{active:[{agentID:9,missionKey:key}],offered:[]},shipID:3,stationID:601,typeID:null,cargoQuantity:null,hangarQuantity:null});
 const handle=await f.backend.start(f.run);
 try {
  await until(()=>f.reports.at(-1)?.status==="stopped"||f.reports.at(-1)?.status==="paused");
  assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
  assert.equal(f.reports.at(-1).readout.completedCount,2);
  assert.equal(f.events.filter((event:string)=>event==="complete").length,1);
 } finally { await handle.stop(); }
});

test("a fresh hosted Courier ignores a pending load once the current hold contains the full cargo",async()=>{
 const f=fixture(),key='[9,900,101,"123"]';
 const old=f.fence().open({accountID:1,characterID:2,runID:"old-wc-bot",current:()=>true});
 old.bindMission(9,key);
 old.dispatch({kind:"load",agentID:9,missionKey:key,shipID:3,stationID:600,typeID:42,itemID:4,itemQuantity:10,
  quantity:10,cargoBefore:0,hangarBefore:10},{journal:{active:[{agentID:9,missionKey:key}],offered:[]},
   shipID:3,stationID:600,typeID:42,cargoQuantity:0,hangarQuantity:10,sourceItem:{itemID:4,typeID:42,quantity:10}});
 f.existing({state:2,aboard:true,station:null});
 const handle=await f.backend.start(f.run);
 try {
  await until(()=>f.reports.at(-1)?.status==="stopped"||f.reports.at(-1)?.status==="paused");
  assert.equal(f.reports.at(-1).status,"stopped",JSON.stringify(f.reports.at(-1)));
  assert.deepEqual(f.events,["route-601","cargo-hangar","complete"]);
 } finally { await handle.stop(); }
});
