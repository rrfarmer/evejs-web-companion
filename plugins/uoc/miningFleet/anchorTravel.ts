import {progressDeadline,routeFlightObservation,travelFacts,readAfterTimeout} from '../shared/progressDeadline.ts';
import {decodeFlightStatus,getFlightStatus} from "../../../web/src/plugin-api/flying.ts";
import type {PluginRunContext} from "../../../web/src/plugin-api/backend.ts";
import type {PilotSession} from "../../../web/src/plugin-api/pilotSession.ts";
import type {SynchronousStore} from "./targetBoard.ts";
const positive=(x:unknown):x is number=>typeof x==="number"&&Number.isSafeInteger(x)&&x>0;
type Intent={issuedAt:number;originSystemID:number;acknowledged:boolean};
type State={version:1;identity:string;pending:Intent|null;history:{intent:Intent;outcome:"arrived"|"stopped"|"not-dispatched";observedAt:number;systemID:number}[]};
/** One held pilot and one anchor. An unknown route is read-only reconciled and never resent. */
export async function ensureMiningAnchor(run:Pick<PluginRunContext,"botID"|"characterID"|"baseUrl"|"fetch">,session:PilotSession,config:{shipID:number;systemID:number;current:()=>void;stopRequested:()=>boolean;document:SynchronousStore;beforeDeparture?:()=>Promise<void>;now?:()=>number;wait?:(ms:number)=>Promise<void>}){
 const {shipID,systemID,current,stopRequested,document}=config,now=config.now??Date.now,wait=config.wait??(ms=>new Promise<void>(r=>setTimeout(r,ms))),f=session.flow.flying,generation=f.sessionGeneration();
 if(!run.botID||!positive(run.characterID)||!positive(shipID)||!positive(systemID)||!Number.isSafeInteger(generation)||generation<0)throw Error("Anchor travel identity is invalid.");
 const identity=JSON.stringify([run.botID,run.characterID,shipID,systemID,generation]),saved=document.read() as State|null,validIntent=(v:Intent)=>!!v&&Number.isSafeInteger(v.issuedAt)&&v.issuedAt>0&&positive(v.originSystemID)&&typeof v.acknowledged==="boolean";
 if(saved!==null&&(!saved||saved.version!==1||saved.identity!==identity||!(saved.pending===null||validIntent(saved.pending))||!Array.isArray(saved.history)||saved.history.some(h=>!h||!validIntent(h.intent)||!["arrived","stopped","not-dispatched"].includes(h.outcome)||!Number.isFinite(h.observedAt)||!positive(h.systemID))))throw Error("Anchor travel journal requires reconciliation.");
 let state=saved??{version:1 as const,identity,pending:null,history:[]};const guard=()=>{current();if(f.sessionGeneration()!==generation||session.store.station.get().online?.characterID!==run.characterID)throw Error("Anchor travel held pilot changed.");};const save=(next:State)=>{guard();document.write(structuredClone(next));state=next;};
 const status=async()=>{guard();const value=decodeFlightStatus((await readAfterTimeout(()=>getFlightStatus({...session.flow.requestOptions(),baseUrl:run.baseUrl,fetch:run.fetch}))).flight);guard();if(value.shipID!==shipID||!positive(value.solarSystemID)||value.inSpace===value.docked)throw Error("Anchor flight identity is unavailable.");return value;};
 const ready=(v:Awaited<ReturnType<typeof status>>)=>v.transition?.phase==="ready"&&(v.docked||v.inSpace&&typeof v.shipMode==="string"&&v.shipMode.toUpperCase()!=="WARP");const finish=(outcome:"arrived"|"stopped"|"not-dispatched",system:number)=>{const pending=state.pending;if(pending)save({...state,pending:null,history:[...state.history,{intent:pending,outcome,observedAt:now(),systemID:system}]});};
 let flight=await status();if(flight.solarSystemID===systemID&&ready(flight)){finish("arrived",systemID);return "arrived" as const;}
 if(stopRequested()&&!state.pending)return "stopped" as const;
 if(!state.pending){await config.beforeDeparture?.();guard();if(stopRequested())return "stopped" as const;const issuedAt=now();if(!Number.isSafeInteger(issuedAt)||issuedAt<=0)throw Error("Anchor travel clock is invalid.");save({...state,pending:{issuedAt,originSystemID:flight.solarSystemID!,acknowledged:false}});if(stopRequested()){finish("not-dispatched",flight.solarSystemID!);return "stopped" as const;}
  try{guard();const result=await session.flow.startRoute(systemID);guard();if(!result.started){finish("not-dispatched",flight.solarSystemID!);throw Error(`Anchor route refused: ${result.reason}`);}save({...state,pending:{...state.pending!,acknowledged:true}});}catch(error){guard();if(!state.pending)throw error;/* The original route can only be reconciled by physical reads. */}}
 const progressing=progressDeadline(1800000,now),observe=routeFlightObservation(session,shipID);
 let lastPosition:unknown;
 while(true){
  guard();
  const progress=f.autopilotProgress(),{flight:observed,read}=observe(progress);
  const verify=read||stopRequested()||observed&&(observed.inSpace===observed.docked||
   observed.solarSystemID!==flight.solarSystemID||observed.solarSystemID===systemID&&ready(observed));
  if(verify)flight=await status();
  else if(observed)flight=observed;
  if(stopRequested()&&ready(flight)){f.abortAutopilot();finish("stopped",flight.solarSystemID!);return "stopped" as const;}
  if(ready(flight)&&flight.solarSystemID===systemID){f.abortAutopilot();finish("arrived",systemID);return "arrived" as const;}
  if(progress?.status==="error"||progress?.status==="paused"||progress?.status==="aborted")
   throw Error("Anchor route remains unresolved; no second route will be sent.");
  const snapshot=flight.inSpace?session.store.space?.get().snapshot:null;
  if(snapshot?.inSpace&&snapshot.stateValid!==false&&snapshot.solarSystemID===flight.solarSystemID&&
     snapshot.ship?.itemID===shipID&&snapshot.ship.geometryAvailable)lastPosition=snapshot.ship.position;
  if(!progressing(travelFacts(flight,progress,lastPosition)))throw Error("Anchor route made no observable native progress; current state was rechecked.");
  await wait(1000);
 }

}
