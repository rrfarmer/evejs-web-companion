import type {BackendRun,PluginRunContext} from '../../../web/src/plugin-api/backend.ts';
import {runOwner} from '../runControl.ts';
import {writeCivilianIndex,type CivilianIndexRow} from '../civilian/index.ts';
import {bindCivilianScope} from '../civilian/recovery.ts';
import {CivilianMissionCompleted,CivilianMissionMismatch,readAcceptedMission,sameAcceptedMission} from '../civilian/acceptedMission.ts';
/** Keep the checked parking policy and record only BFF-verified world/account ownership. */
export function withCivilianPolicy(executor:BackendRun,kind?:'mining'|'distribution',deps:{owner?:typeof runOwner;write?:(row:CivilianIndexRow)=>void}={}):BackendRun {
 return {check:value=>executor.check(value),async start(run:PluginRunContext){
  const checked=await executor.check(run.setup);if(!checked.ok)throw Error(checked.refusal);const setup=checked.setup as any;
  let indexed:CivilianIndexRow|null=null;
  // A failed connection has a Bot Host report, but does not take ownership
  // of the original executor's mission checkpoint.
  let publishCheckpoint=!setup.continuation;
  if(kind){const [owner,response]=await Promise.all([(deps.owner??runOwner)(run),run.fetch(new URL('/api/plugins/uoc/world',run.baseUrl))]);const body=await response.json();if(!response.ok||body?.ok!==true||typeof body.worldID!=='string'||!body.worldID||run.held.characterID!==run.characterID)throw Error('Civilian world identity unavailable.');
   const roster=await run.fetch(new URL('/api/bots',run.baseUrl)).then(r=>r.json()).catch(()=>null),bot=roster?.bots?.find((b:any)=>b.botID===run.botID&&b.characterID===run.characterID);
   indexed={worldID:body.worldID,owner:owner.toLowerCase(),characterID:run.characterID,botID:run.botID,kind,status:'starting',phase:null,pending:null,firstFailure:null,resolved:false,updatedAt:Date.now(),setup:checked.setup,worker:{startedAt:bot?.startedAt??'',expiresAt:bot?.expiresAt??null,characterName:bot?.characterName??null,why:null,readout:null}};
  }
  const wrapped:PluginRunContext={...run,report(value){
   if(indexed){
    const v=value.readout as any,old=indexed.worker!;
    publishCheckpoint ||= v?.continuationUnavailable===true || v?.missionSettled===true ||
     sameAcceptedMission(setup.continuation,readAcceptedMission(v?.acceptedMission));
    const next:CivilianIndexRow={...indexed,status:value.status,phase:typeof value.phase==='string'?value.phase:null,
     pending:typeof v?.pending==='string'||v?.pending===null?v.pending:indexed.pending,
     resolved:v&&Object.hasOwn(v,'missionSettled')?value.status==='stopped'&&v.missionSettled===true&&v.pending===null:indexed.resolved,
     firstFailure:typeof v?.firstFailure==='string'?v.firstFailure:indexed.firstFailure,updatedAt:Date.now(),
     worker:{...old,why:typeof value.why==='string'?value.why:old.why,readout:v&&typeof v==='object'?{...(old.readout as object??{}),...v,parkingPolicy:setup.parking??{mode:'nearest'}}:old.readout}};
    try{if(publishCheckpoint)(deps.write??writeCivilianIndex)(next);indexed=next;}
    catch{/* Retain prior durable evidence; never delay physical reporting. */}
   }
   if(value.readout&&typeof value.readout==='object'&&!Array.isArray(value.readout))run.report({...value,readout:{...value.readout,parkingPolicy:setup.parking??{mode:'nearest'}}});else run.report(value);
  }};if(indexed)bindCivilianScope(wrapped,()=>indexed!);
  try{return await executor.start(wrapped);}
  catch(error){
   if(setup.continuation){
    const reason=error instanceof Error?error.message:String(error);
    if(error instanceof CivilianMissionCompleted){
     wrapped.report({status:'stopped',phase:'Completed',why:reason,readout:{acceptedMission:null,missionSettled:true,pending:null,completedCount:1,agentID:setup.continuation.agentID,mission:setup.continuation.missionID}});
     return {stop(){}};
    }
    wrapped.report({status:'error',phase:'Needs attention',why:reason,readout:{
     ...(error instanceof CivilianMissionMismatch?{acceptedMission:null,continuationUnavailable:true}:{}),
     continuing:true,firstFailure:reason,agentID:setup.continuation.agentID,mission:setup.continuation.missionID}});
   }
   throw error;
  }
 }};
}
