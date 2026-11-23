import type { BackendRun, PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import type { BotScript } from "../../../web/src/plugin-api/index.ts";
import {civilianDistributionPlan,decodeDistributionSetup,distributionSetupJson} from "./plan.ts";
import {runOwner, runExpiry, registerRun} from "../runControl.ts";
import {createDistributionProgress, type DistributionCompletionReceipt} from "./progress.ts";
import type {MissionRewardReadout} from "../shared/rewards/index.ts";
import {registerCivilianRecovery} from '../civilian/recovery.ts';
import type {AcceptedMission} from '../civilian/acceptedMission.ts';

/** Implemented only by a host that durably fences unresolved mission and cargo mutations
 * across stop/restart, binds strict journal identity, enforces admission, and passes
 * only a receipt validated against the active native runner invocation. */
export interface DistributionHost {
 attach(run:PluginRunContext, options:{deadlineMs:number;bindAccepted:(runID:string,agentID:number,missionKey:string)=>void;
  restoreCompleted:(receipt:DistributionCompletionReceipt,reward:MissionRewardReadout|null)=>void;
  confirmed:(receipt:DistributionCompletionReceipt,reward:MissionRewardReadout|null,why?:string)=>void; stopped:(reason:string)=>void; parked:(reason:string,dock?:{destinationID:number;systemID:number;kind:'station'|'structure'},failed?:boolean)=>void; missionObserved?:(agentID:number,contentID:number|null,missionName?:string,destinationID?:number)=>void;
  progress:(phase:string|null,why:string|null,location?:{currentLocationID?:number;destinationID?:number;returning?:boolean})=>void}):Promise<{
   start(plan:BotScript):Promise<void>; stop():Promise<void>; requestStop?():Promise<void>;custody?():{pending:string|null;missionSettled:boolean;missionKey:string|null;acceptedMission?:AcceptedMission|null};inspectRecovery?():Promise<unknown>;
  }>;
}
/** No host means disabled: an ordinary ScriptRunner alone does not prove mission completion. */
export function createCivilianDistributionRun(host:DistributionHost|null=null):BackendRun {
 return {
  check(input) {
   const setup=decodeDistributionSetup(input);
   if(!setup)return {ok:false,refusal:"Choose one Distribution mission, a known agent and station or valid search, and delivery limits."};
   if(!host)return {ok:false,refusal:"Distribution requires native mission admission and completion verification before it can run."};
   return {ok:true,setup:distributionSetupJson(setup),name:"Civilian distribution",policy:{riskClasses:["inventory","mission"],restartSafe:true}};
  },
  async start(run) {
   const setup=decodeDistributionSetup(run.setup);
   if(!host||!setup||!Number.isSafeInteger(run.characterID)||run.characterID<=0||run.held.characterID!==run.characterID)throw new Error("Distribution run requires current pilot custody and verified mission hooks.");
   const username=await runOwner(run), expiry=await runExpiry(run);
   const data=run.resumed?run.resumeData:null;
   const savedDeadline=data&&typeof data==="object"&&"deadlineMs" in data?data.deadlineMs:null;
   const deadlineMs=Math.min(expiry,setup.durationMinutes===undefined?Infinity:
    typeof savedDeadline==="number"&&Number.isSafeInteger(savedDeadline)&&savedDeadline>0?savedDeadline:
    Date.now()+setup.durationMinutes*60000+180000);
   const progress=createDistributionProgress();
   let stopping=false,parking=false,terminal=false,firstFailure:string|null=null,mission:{agentID:number;contentID:number|null;missionName?:string;destinationID?:number}|null=null,dock:{destinationID:number;systemID:number;kind:'station'|'structure'}|null=null;
   let currentLocationID:number|undefined,travel:{destinationID?:number;returning?:boolean}|undefined;
   let session:Awaited<ReturnType<DistributionHost['attach']>>|null=null;
   const readout=()=>{const custody=session?.custody?.();return {...progress.snapshot(),agentID:mission?.agentID??setup.continuation?.agentID??null,mission:mission?.contentID??setup.continuation?.missionID??null,missionName:mission?.missionName??null,currentLocationID:dock?.destinationID??currentLocationID??null,missionDestinationID:mission?.destinationID??null,travel:travel??null,firstFailure,pending:custody?custody.pending:'UNKNOWN',missionSettled:custody?.missionSettled??false,recoveryRequired:!custody?.missionSettled,acceptedMission:custody?.acceptedMission??null,continuing:!!setup.continuation,parking:dock?{state:'DOCKED',...dock,release:'PENDING_CORE'}:null};};
   const park=(reason:string)=>{if(stopping||parking)return;parking=true;
    terminal=false;firstFailure??=reason;
    run.report({status:terminal ? "stopped" : "paused",phase:terminal ? "Completed" : "Paused",why:reason,readout:readout() as any});};
   session=await host.attach(run,{deadlineMs,bindAccepted:(runnerID,id,key)=>progress.bindAccepted(runnerID,id,key),
     restoreCompleted:(receipt,reward)=>{progress.bindAccepted(run.botID,receipt.agentID,receipt.missionKey);progress.confirm(receipt,reward);},
     confirmed:(receipt,reward,why="Native completion confirmed.")=>{travel=undefined;progress.confirm(receipt,reward);run.report({status:"running",phase:"Mission completed",why,readout:readout() as any});},stopped:park,
     missionObserved:(agentID,contentID,missionName,destinationID)=>{mission={agentID,contentID,missionName,destinationID};},
     parked:(reason,observedDock,failed)=>{if(!stopping&&!terminal){parking=true;terminal=true;dock=observedDock??null;if(failed)firstFailure??=reason;run.report({status:"stopped",phase:progress.snapshot().completedCount>=setup.missionCount?"Completed":failed?"Needs attention":"Docked",why:reason,readout:readout() as any});}},
     progress:(phase,why,location)=>{
      currentLocationID=location?.currentLocationID??currentLocationID;
      travel=location?.destinationID===undefined?undefined:{destinationID:location.destinationID,returning:location.returning??false};
      if(!stopping&&!parking)run.report({status:"running",phase,why,readout:readout() as any});
     }});
   const unregisterRecovery=registerCivilianRecovery(run,async()=>{if(!session?.inspectRecovery)throw Error('The original Distribution controller has no qualified native recovery reader.');const checked:any=await session.inspectRecovery();dock=checked.parking?{destinationID:checked.parking.destinationID,systemID:checked.parking.systemID,kind:checked.parking.kind}:null;run.report({status:'paused',phase:'Recovery reviewed',why:checked.reason,readout:readout() as any});return checked;});
   let unregister:()=>void;
   try {unregister=registerRun(run,username,()=>{
     if(!session.requestStop){run.report({status:"paused",phase:"Stop blocked",why:"The controller cannot verify a safe stop."});return;}
     void session.requestStop().catch(error=>run.report({status:"paused",phase:"Stop blocked",why:String(error)}));
   });} catch(error){unregisterRecovery();await session.stop();throw error;}
   try {
     if(run.resumed||setup.durationMinutes!==undefined)run.report({
       status:"running",phase:run.resumed?"Resuming":"Starting",readout:readout() as any,
       ...(setup.durationMinutes!==undefined?{resumeData:{deadlineMs}}:{})
     });
     await session.start(civilianDistributionPlan(setup));
   }
   catch(error){stopping=true;unregisterRecovery();unregister();await session.stop();throw error;}
   let timer:ReturnType<typeof setTimeout>|null=null;
   const windDown=()=>{
     if(stopping||terminal)return;
     const remaining=deadlineMs-Date.now()-180_000;
     if(remaining>0){timer=setTimeout(windDown,Math.min(remaining,2_147_000_000));timer.unref?.();return;}
     if(!session.requestStop){run.report({status:"paused",phase:"Stop blocked",why:"The controller cannot verify a safe stop."});return;}
     void session.requestStop().catch(error=>run.report({status:"paused",phase:"Stop blocked",why:String(error)}));
   };
   windDown();
   let stop:Promise<void>|null=null;
   return {stop(){if(stop)return stop;stopping=true;if(timer)clearTimeout(timer);unregisterRecovery();unregister();stop=session!.stop().then(()=>{if(!terminal&&session?.custody?.().missionSettled)run.report({status:'stopped',phase:'Stopped',why:'Original native custody is settled; session release still requires independent readback.',readout:readout() as any});}).catch(error=>{stop=null;throw error;});return stop;}};
  },
 };
}
