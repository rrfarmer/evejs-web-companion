import test from "node:test";
import assert from "node:assert/strict";
import type {PilotSession} from "../../../web/src/plugin-api/pilotSession.ts";
import {decodeFlightStatus} from "../../../web/src/plugin-api/flying.ts";
import {findMiningRallyPoint,reachMiningRallyPoint} from "./rallyPoint.ts";

const current=()=>{};

test("the rally uses a local NPC station before considering a celestial",async()=>{
 const point=await findMiningRallyPoint({characterID:1,baseUrl:"http://fixture",fetch:async input=>{
  assert.equal(new URL(String(input)).pathname,"/api/map/system-stations/300");
  return Response.json({ok:true,stations:[{stationID:602},{stationID:601}]});
 }},300,current);
 assert.deepEqual(point,{kind:"station",destinationID:601,systemID:300});
});

test("in a system without stations the rally waits for verified arrival at the sun",async t=>{
 t.mock.timers.enable({apis:["setTimeout"]});
 const sun=98,shipID=11;
 const orders:number[]=[];
 let atSun=false;
 const flight={shipID,solarSystemID:300,inSpace:true,docked:false,shipMode:"STOP",transition:{
  phase:"ready",sessionStable:true,locationReady:true,sceneReady:true,egoReady:true,shipReady:true,boundContextReady:true,
 }};
 const run={characterID:1,baseUrl:"http://fixture",fetch:async(input:unknown)=>{
  switch(new URL(String(input)).pathname){
  case "/api/map/system-stations/300":return Response.json({ok:true,stations:[]});
  case "/api/client-data/system-objects/300":return Response.json({ok:true,available:true,objects:[{itemID:sun,groupID:6}]});
  case "/api/bridge/flight/status":return Response.json({ok:true,flight});
  case "/api/bridge/space/snapshot":return Response.json({ok:true,space:{
   shipID,solarSystemID:300,inSpace:true,stateValid:true,sampledAtMs:Date.now(),
   ship:{itemID:shipID,characterID:1,position:{x:atSun?1000:1_000_000,y:0,z:0},radius:10,mode:"STOP"},
   entities:[{itemID:sun,groupID:6,position:{x:0,y:0,z:0},radius:500}],
  }});
  default:throw Error("Unexpected fixture request "+String(input));
  }
 }};
 const point=await findMiningRallyPoint(run,300,current);
 assert.deepEqual(point,{kind:"sun",destinationID:sun,systemID:300});
 const session={flow:{requestOptions:()=>({}),flying:{async warpAsTheAutopilot(id:number){orders.push(id);}}}} as unknown as PilotSession;
 let complete=false;
 const trip=reachMiningRallyPoint(run,session,point,shipID,decodeFlightStatus(flight),current,async()=>{})
  .then(()=>{complete=true;});
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.deepEqual(orders,[sun]);
 assert.equal(complete,false);
 atSun=true;
 t.mock.timers.tick(1500);
 await trip;
 assert.equal(complete,true);
 assert.deepEqual(orders,[sun]);
});
