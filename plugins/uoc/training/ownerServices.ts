import {worldForRequest} from "../shared/backendScope.ts";
import {randomUUID} from 'node:crypto';
import {type BackendRoute,type BackendRun,type PluginRunContext,type PluginRunReport} from '../../../web/src/plugin-api/backend.ts';
import {pilotServiceOwner} from '../runControl.ts';
import {wrapRunFetch} from '../shared/runFetch.ts';
type Domain='training'|'provisioning';
type Task={taskID:string;worldID:string;owner:string;domain:Domain;characterID:number;ownerBotID:string;kind:string;setup:unknown;status:'running'|'stopped'|'error';phase:string;why:string|null;readout:unknown;startedAt:number;endedAt:number|null};
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;

/** One serialized service lane on an existing authorized UOC owner. It starts
 * existing adapters only, never acquires/releases a pilot or reports to its run.
 * Provisioning has read-only inspection here; Apply needs another contract. */
export function createOwnerTrainingServices(deps:{owner:typeof pilotServiceOwner;training?:BackendRun;inspect?:BackendRun;provisionInspect?:BackendRun;hr?:BackendRun}){
 const tasks=new Map<number,Task>();
 const read=(domain:Domain):BackendRoute=>request=>{
  const cid=Number(request.params.characterID),world=worldForRequest(request),user=request.account.username.toLowerCase();
  if(!positive(cid)||!world)return {status:503,body:{ok:false,error:'SERVICE_SCOPE_UNAVAILABLE'}};
  const owner=deps.owner(cid,user);
  const current=tasks.get(cid);
  const task=current?.worldID===world&&current.owner===user&&current.domain===domain?current:null;
  return {body:{ok:true,available:owner!==null,ownerBotID:owner?.run.botID??null,access:domain==='provisioning'?'READ_ONLY_ACTIVE_UOC':'COMPATIBLE_TRAINING',task}};
 };
 const start=(domain:Domain):BackendRoute=>async request=>{
  const cid=Number(request.params.characterID),world=worldForRequest(request),user=request.account.username.toLowerCase(),body=request.body as any;
  if(!positive(cid)||!world||!body)return {status:400,body:{ok:false,error:'INVALID_OWNER_SERVICE'}};
  const allowed=domain==='training'?['inspect','train','member-inspect','hr-inspect']:['inspect'];
  if(!allowed.includes(body.kind))return {status:409,body:{ok:false,error:'OWNER_SERVICE_NOT_AUTHORIZED',message:'This owner lane does not authorize equipment Apply or corporation membership changes.'}};
  const owner=deps.owner(cid,user);if(!owner)return {status:409,body:{ok:false,error:'TRAINING_OWNER_UNAVAILABLE',message:'No compatible exact UOC owner is available; existing pilot control is preserved.'}};
  owner.current();const response=await owner.run.fetch(new URL('/api/plugins/uoc/world',owner.run.baseUrl)),native=await response.json();owner.current();
  if(!response.ok||native?.ok!==true||native.worldID!==world)return {status:409,body:{ok:false,error:'SERVICE_WORLD_CHANGED'}};
  const kind=body.kind as string;
  let definition:BackendRun;
  if(domain==='provisioning')definition=deps.provisionInspect??(await import('../provisioning/host.ts')).provisioningInspectRun;
  else if(kind==='member-inspect'||kind==='hr-inspect'){
   if(body.setup?.stage!==(kind==='member-inspect'?'member-inspect':'inspect')||body.setup?.authorityID!==cid)return {status:400,body:{ok:false,error:'INVALID_READ_ONLY_HR_SERVICE'}};
   definition=deps.hr??(await import('./hr.ts')).trainingHRRun;
  }else if(kind==='inspect')definition=deps.inspect??(await import('./host.ts')).trainingInspectRun;
  else definition=deps.training??(await import('./host.ts')).trainingRun;
  const checked=await definition.check(body.setup??{});if(!checked.ok)return {status:400,body:{ok:false,error:'TRAINING_SETUP_INVALID',message:checked.refusal}};
  const previous=tasks.get(cid);if(previous?.ownerBotID===owner.run.botID&&previous.endedAt===null){
   if(previous.worldID!==world||previous.owner!==user||previous.ownerBotID!==owner.run.botID||previous.domain!==domain||previous.kind!==kind||JSON.stringify(previous.setup)!==JSON.stringify(checked.setup))return {status:409,body:{ok:false,error:'TRAINING_ALREADY_RUNNING',message:'The exact current service must settle before another task or goal starts.'}};
   return {status:202,body:{ok:true,task:structuredClone(previous)}};
  }
  owner.current();const task:Task={taskID:randomUUID(),worldID:world,owner:user,domain,characterID:cid,ownerBotID:owner.run.botID,kind,setup:checked.setup,status:'running',phase:'Reading current pilot',why:null,readout:null,startedAt:Date.now(),endedAt:null};
  tasks.set(cid,task);
  const report=(value:PluginRunReport)=>{
   try{owner.current();}catch{value={status:'error',phase:'Pilot service ended',why:'The pilot session ended.'};}
   if(domain==='provisioning'&&value.readout&&typeof value.readout==='object'&&!Array.isArray(value.readout))value={...value,readout:{...value.readout,canApply:false,equipmentMutation:'DENIED_ACTIVE_OPERATION',applyBlockers:['The active UOC owner permits read-only inspection. Equipment Apply requires an authorized exclusive idle-owner lease.']}};
   task.phase=value.phase??task.phase;task.why=value.why??null;task.readout=value.readout??task.readout;
   if(['stopped','idle','error'].includes(value.status)){task.status=value.status==='error'?'error':'stopped';task.endedAt=Date.now();}
  };
  const fetch=wrapRunFetch(owner.run.fetch, send => async (input, init, priority) => {
   owner.current();
   const result=await send(input,init,priority);
   owner.current();
   return result;
  });
  const borrowed:PluginRunContext={...owner.run,setup:checked.setup,resumed:false,resumeData:null,report,fetch};
  void Promise.resolve().then(()=>{owner.current();return definition.start(borrowed);}).catch((error:unknown)=>{report({status:'error',phase:'Owner service needs attention',why:error instanceof Error?error.message:String(error)});});
  return {status:202,body:{ok:true,task:structuredClone(task)}};
 };
 const account:BackendRoute=request=>({body:{ok:true,account:{accountID:request.account.accountID,username:request.account.username},worldID:worldForRequest(request)??null}});
 return {'GET /center/account':account,'POST /training/:characterID/service':start('training'),'GET /training/:characterID/service':read('training'),'POST /provisioning/:characterID/service':start('provisioning'),'GET /provisioning/:characterID/service':read('provisioning')};
}
export const ownerTrainingRoutes=createOwnerTrainingServices({owner:pilotServiceOwner});
