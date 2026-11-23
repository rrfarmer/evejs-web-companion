import test from "node:test";import assert from "node:assert/strict";import {ensureMiningAnchor} from "./anchorTravel.ts";
const transition={phase:"ready",sessionStable:true,locationReady:true,sceneReady:true,egoReady:true,shipReady:true,boundContextReady:true};
function fixture(){let system=301,clock=1000,commands=0,saved:unknown=null,fail=false,stop=false,onWait:()=>void=()=>{};const doc={read:()=>structuredClone(saved),write:(v:unknown)=>{saved=structuredClone(v)}},run:any={botID:"b",characterID:1,baseUrl:"http://bff",fetch:async()=>Response.json({ok:true,flight:{shipID:11,solarSystemID:system,docked:false,inSpace:true,shipMode:"STOP",transition}})},session:any={store:{station:{get:()=>({online:{characterID:1}})}},flow:{requestOptions:()=>({}),startRoute:async()=>{commands++;if(fail)throw Error("network unknown");return {started:true};},flying:{sessionGeneration:()=>1,abortAutopilot(){},autopilotProgress:()=>null}}};return {run,session,doc,now:()=>clock,wait:async()=>{clock+=1000;onWait()},arrive:()=>{system=300},stop:()=>{stop=true},stopped:()=>stop,fail:()=>{fail=true},onWait:(v:()=>void)=>{onWait=v},commands:()=>commands};}
test("remote pilot journals one native route and requires exact anchor arrival",async()=>{const f=fixture();f.onWait(()=>f.arrive());assert.equal(await ensureMiningAnchor(f.run,f.session,{shipID:11,systemID:300,current(){},stopRequested:f.stopped,document:f.doc,now:f.now,wait:f.wait}),"arrived");assert.equal(f.commands(),1);assert.equal((f.doc.read() as any).pending,null);});
test("lost route reply is never replayed and Stop reconciles current native flight without forcing anchor arrival",async()=>{const f=fixture();f.fail();f.onWait(()=>{f.stop();if(f.now()>4000)f.arrive()});assert.equal(await ensureMiningAnchor(f.run,f.session,{shipID:11,systemID:300,current(){},stopRequested:f.stopped,document:f.doc,now:f.now,wait:f.wait}),"stopped");assert.equal(f.commands(),1);assert.equal((f.doc.read() as any).history[0].intent.acknowledged,false);assert.equal((f.doc.read() as any).history[0].systemID,301);});
test("Stop before dispatch sends no route",async()=>{const f=fixture();f.stop();assert.equal(await ensureMiningAnchor(f.run,f.session,{shipID:11,systemID:300,current(){},stopRequested:f.stopped,document:f.doc,now:f.now,wait:f.wait}),"stopped");assert.equal(f.commands(),0);});

test("anchor route reuses stock observations and reads flight only at system change and arrival",async()=>{
 const f=fixture();
 let step=0,routed=false,flightReads=0,gridReads=0;
 const systems=[301,301,302,300] as const;
 const flight=(system:number)=>({shipID:11,solarSystemID:system,docked:false,inSpace:true,shipMode:"STOP",transition});
 f.session.flow.startRoute=async()=>{routed=true;return {started:true};};
 f.session.flow.flying.autopilotProgress=()=>({status:"running",currentSystemID:systems[step]});
 f.session.store.flight={get:()=>({status:flight(step===2?301:systems[step]!)})};
 f.run.fetch=async(input:URL)=>{
  const path=new URL(String(input)).pathname;
  if(path.endsWith("/space/snapshot")){gridReads++;return Response.json({ok:true,space:{}});}
  assert.ok(path.endsWith("/flight/status"));
  if(routed)flightReads++;
  return Response.json({ok:true,flight:flight(systems[step]!)});
 };
 f.onWait(()=>{assert.ok(++step<systems.length);});
 assert.equal(await ensureMiningAnchor(f.run,f.session,{shipID:11,systemID:300,current(){},stopRequested:f.stopped,document:f.doc,now:f.now,wait:f.wait}),"arrived");
 assert.deepEqual({flightReads,gridReads},{flightReads:2,gridReads:0});
});
