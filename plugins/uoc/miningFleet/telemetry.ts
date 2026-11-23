import type {ShipLoss} from "./fleetWipe.ts";
import type {SynchronousStore} from './targetBoard.ts';

type Member={characterID:number;shipID:number;deployedAt?:number;lastShip?:{shipTypeID:number;at:number}|null;role:string;botID:string;active:boolean;phase:string|null;reason:string|null;reportedAt:number|null;freight:unknown};
export type FleetTelemetry={version:1;operationID:string;runID:string;startedAt:number;stoppedAt:number|null;observedAt:number;stopRequested?:boolean;operationWarning?:string|null;members:Member[];shipLosses?:ShipLoss[];history?:{kind:string;at:string;target:any;evidence:unknown}[]};
/** Retained target and member observations, including confirmed ship losses. */
export function readFleetTelemetry(document:SynchronousStore,operationID:string,runID:string):FleetTelemetry|null {
 try {const v=document.read() as FleetTelemetry|null;
  if(!v||v.version!==1||v.operationID!==operationID||v.runID!==runID||!Number.isFinite(v.startedAt)||!Number.isFinite(v.observedAt)||!(v.stoppedAt===null||Number.isFinite(v.stoppedAt))||!Array.isArray(v.members)||
   (v.history!==undefined&&!Array.isArray(v.history))||(v.shipLosses!==undefined&&!Array.isArray(v.shipLosses))||new Set(v.members.map(m=>m.characterID)).size!==v.members.length||v.members.some(m=>!m||![m.characterID,m.shipID].every(n=>Number.isSafeInteger(n)&&n>0)||typeof m.botID!=='string'||!['MINER','HAULER','COMMAND','DEFENDER'].includes(m.role)))return null;
  return {...structuredClone(v),members:v.members.map(m=>({...structuredClone(m),active:false}))};
 } catch{return null;}
}
export function createFleetTelemetry(document:SynchronousStore,operationID:string,runID:string,now=Date.now){
 const prior=readFleetTelemetry(document,operationID,runID);
 const startedAt=prior?.startedAt??now(),history=prior?.history??[];
 const observed=new Map(prior?.members.map(m=>[m.characterID,m]));
 const losses=prior?.shipLosses??[];
 let stoppedAt=prior?.stoppedAt??null,lastTarget:string|null=null;
 return {target(target:any,claim:any,evidence:unknown){const key=JSON.stringify([claim.key,claim.generation]);if(key===lastTarget)return;lastTarget=key;history.push({kind:'TARGET_SELECTION',at:new Date(now()).toISOString(),target:{targetKey:claim.key,targetType:target.kind,systemID:target.systemID,systemName:null,targetName:target.name,state:'HISTORICAL',claimedByOperationID:operationID},evidence});if(history.length>128)history.shift();},
 recordLoss(loss:ShipLoss){if(!losses.some(row=>row.killID===loss.killID))losses.push(loss);},
 sample(members:Member[],stopped=false):FleetTelemetry {
  if(stopped)stoppedAt??=now();
  for(const m of members){
   const previous=observed.get(m.characterID);
   observed.set(m.characterID,{...m,deployedAt:previous?.deployedAt??m.deployedAt,freight:structuredClone(m.freight??previous?.freight??null)});
  }
  return {version:1,operationID,runID,startedAt,stoppedAt,observedAt:now(),history:structuredClone(history),members:structuredClone([...observed.values()]),
   ...(losses.length?{shipLosses:structuredClone(losses)}:{})};
 },persist(value:FleetTelemetry){try{document.write(value);}catch{/* Metadata failure must not change native custody. */}}};
}
