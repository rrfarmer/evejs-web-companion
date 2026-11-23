import {decodeModuleObservation,type ModuleObservation} from '../../shared/moduleObservation.ts';
import type {SynchronousStore} from '../targetBoard.ts';

type Point={x:number;y:number;z:number};
export type TractorIdentity={operationID:string;runID:string;botID:string;sessionGeneration:number;characterID:number;shipID:number;moduleID:number;typeID:number;flagID:number;canID:number;systemID:number;claimGeneration:number;targetGeneration:number};
/** Fresh client projection and native lock/module reads, all from the same held pilot. */
export type TractorRead={module:unknown;observedAt:number;shipID:number;systemID:number;canID:number;inSpace:true;shipPosition:Point;canPosition:Point;shipRadius:number;canRadius:number;lockedTargetIDs:readonly number[]};
export type TractorQualification={typeID:number;effectID:number;effectName:'tractorBeamCan'};
type Observation={at:number;module:ModuleObservation;shipPosition:Point;canPosition:Point;surfaceDistance:number;locked:boolean};
type Intent={issuedAt:number;acknowledged:boolean;error:string|null};
type State={version:1;identity:TractorIdentity;qualification:TractorQualification;lock:Intent|null;lockObserved:Observation|null;activation:Intent|null;active:Observation|null;movement:Observation|null;deactivation:Intent|null;inactive:Observation|null;inactiveHistory?:Observation[];ownActive?:{at:number;module:ModuleObservation};ownInactive?:{at:number;module:ModuleObservation};notDispatched?:{kind:'lock'|'activation';issuedAt:number;outcome:'PRE_DISPATCH_REFUSED'}[]};
const clone=<T>(v:T):T=>structuredClone(v),id=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const point=(p:Point)=>!!p&&[p.x,p.y,p.z].every(Number.isFinite);
/**
 * Drives only the exact operation-owned manifest can supplied by the caller.
 * `current` verifies held session and exclusive claim on every read/write/action;
 * the caller supplies the durable document scoped to this claim/generation.
 * No inventory transfer or delivery is performed here.
 */
export function createTractorController(config:{identity:TractorIdentity;qualification:TractorQualification;document:SynchronousStore;current:()=>void;heldCurrent?:()=>void;readOwn?:()=>Promise<{module:unknown;observedAt:number}>;beforeAction?:()=>void;read:()=>Promise<TractorRead>;lock:(targetID:number)=>Promise<unknown>;activate:(moduleID:number,targetID:number)=>Promise<unknown>;deactivate:(moduleID:number)=>Promise<unknown>;now?:()=>number}){
 const {identity:i,qualification:q,document,current}=config,now=config.now??Date.now;
 if(!i.operationID||!i.runID||!i.botID||![i.characterID,i.shipID,i.moduleID,i.typeID,i.flagID,i.canID,i.systemID,i.claimGeneration,i.targetGeneration].every(id)||!Number.isSafeInteger(i.sessionGeneration)||i.sessionGeneration<0||!q||q.typeID!==i.typeID||!id(q.effectID)||q.effectName!=='tractorBeamCan')throw Error('Tractor identity or native type/effect qualification is invalid.');
 const initial:State={version:1,identity:clone(i),qualification:clone(q),lock:null,lockObserved:null,activation:null,active:null,movement:null,deactivation:null,inactive:null};
 const raw=document.read();let state:State;
 if(raw===null||raw===undefined)state=initial;
 else {const r=raw as State;if(!r||r.version!==1||JSON.stringify(r.identity)!==JSON.stringify(i)||JSON.stringify(r.qualification)!==JSON.stringify(q)||!['lock','lockObserved','activation','active','movement','deactivation','inactive'].every(k=>Object.hasOwn(r,k)))throw Error('Retained tractor custody has another or unreadable identity.');state=clone(r);}
 const save=(next:State)=>{current();document.write(clone(next));state=next;};
 const intent=():Intent=>{const issuedAt=now();if(!id(issuedAt))throw Error('Tractor command time is unavailable.');return {issuedAt,acknowledged:false,error:null};};
 async function observed():Promise<Observation>{current();const startedAt=now(),r=await config.read();current();const finishedAt=now();
  if(!id(startedAt)||!id(finishedAt)||finishedAt<startedAt||finishedAt-startedAt>90000||!r||r.inSpace!==true||r.shipID!==i.shipID||r.systemID!==i.systemID||r.canID!==i.canID||!id(r.observedAt)||r.observedAt<startedAt||r.observedAt>finishedAt||!point(r.shipPosition)||!point(r.canPosition)||![r.shipRadius,r.canRadius].every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0)||!Array.isArray(r.lockedTargetIDs)||r.lockedTargetIDs.some(x=>!id(x))||new Set(r.lockedTargetIDs).size!==r.lockedTargetIDs.length)throw Error('Tractor native observation is incomplete or changed.');
  const module=decodeModuleObservation(r.module,{moduleID:i.moduleID,typeID:i.typeID,ownerID:i.characterID,shipID:i.shipID,flagID:i.flagID});
  return {at:r.observedAt,module,shipPosition:clone(r.shipPosition),canPosition:clone(r.canPosition),surfaceDistance:Math.max(0,Math.hypot(r.shipPosition.x-r.canPosition.x,r.shipPosition.y-r.canPosition.y,r.shipPosition.z-r.canPosition.z)-r.shipRadius-r.canRadius),locked:r.lockedTargetIDs.includes(i.canID)};
 }
 const active=(o:Observation)=>o.module.activeTargets.length===1&&o.module.activeTargets[0]?.effectID===q.effectID&&o.module.activeTargets[0]?.targetID===i.canID;
 const inactive=(o:Observation)=>o.module.activeTargets.length===0&&!o.module.effects.some(e=>e.effectID===q.effectID);
 const clean=(o:Observation)=>o.module.online&&inactive(o)&&typeof o.module.attributes?.[54]==='number'&&Number.isFinite(o.module.attributes[54])&&o.module.attributes[54]>0;
 async function command(kind:'lock'|'activation'|'deactivation',fn:()=>Promise<unknown>){if(kind!=='deactivation')config.beforeAction?.();const next=clone(state);next[kind]=intent();save(next);current();if(kind!=='deactivation'){try{config.beforeAction?.();}catch(error){const restored=clone(state),prior=restored[kind];if(prior){restored[kind]=null;restored.notDispatched=[...(restored.notDispatched??[]),{kind,issuedAt:prior.issuedAt,outcome:'PRE_DISPATCH_REFUSED' as const}].slice(-32);save(restored);}throw error;}}try{await fn();}catch(e){current();const after=clone(state);after[kind]!.error=e instanceof Error?e.message:String(e);save(after);return;}current();const after=clone(state);after[kind]!.acknowledged=true;save(after);}
 async function reconcileInternal(){current();if(!state.lock&&!state.activation&&!state.deactivation)return clone(state);const o=await observed(),next=clone(state);
  if(next.lock&&!next.lockObserved&&o.at>=next.lock.issuedAt&&o.locked)next.lockObserved=clone(o);
  if(next.activation&&!next.active&&o.at>=next.activation.issuedAt&&active(o))next.active=clone(o);
  if(next.active&&!next.movement&&o.at>next.active.at&&active(o)){
   const a=next.active,displacement=Math.hypot(o.canPosition.x-a.canPosition.x,o.canPosition.y-a.canPosition.y,o.canPosition.z-a.canPosition.z);
   if(displacement>0.1&&o.surfaceDistance<a.surfaceDistance-0.1)next.movement=clone(o);
  }
  if(next.deactivation&&o.at>=next.deactivation.issuedAt){
   if(inactive(o)&&(!next.inactive||o.at>next.inactive.at)){if(next.inactive)next.inactiveHistory=[...(next.inactiveHistory??[]),clone(next.inactive)].slice(-16);next.inactive=clone(o);}
   else if(!inactive(o)&&next.inactive&&o.at>next.inactive.at){next.inactiveHistory=[...(next.inactiveHistory??[]),clone(next.inactive)].slice(-16);next.inactive=null;}
  }
  if(JSON.stringify(next)!==JSON.stringify(state))save(next);return clone(state);
 }
 async function advanceInternal(){current();if(state.deactivation)throw Error('Tractor shutdown already owns this claim; no new activation.');
  if(state.activation)return reconcileInternal();
  if(!state.lock){const o=await observed();if(!clean(o)||o.surfaceDistance>o.module.attributes![54]!)throw Error('Online inactive tractor, native range or exact can is unavailable.');
   if(o.locked){const next=clone(state);next.lockObserved=clone(o);save(next);}else {await command('lock',()=>config.lock(i.canID));return clone(state);}}
  if(state.lock&&!state.lockObserved){await reconcileInternal();if(!state.lockObserved)return clone(state);}
  const before=await observed();if(!clean(before)||!before.locked||before.surfaceDistance>before.module.attributes![54]!)throw Error('Tractor preflight changed; no activation dispatched.');
  await command('activation',()=>config.activate(i.moduleID,i.canID));return clone(state);
 }
 async function stopInternal(){current();if(state.deactivation)return reconcileInternal();const o=await observed();
  if(inactive(o)){if(state.activation&&!state.activation.acknowledged&&!state.active)throw Error('Tractor activation outcome remains unknown; inactive sample cannot settle it.');const next=clone(state);next.inactive=clone(o);save(next);return clone(state);}
  if(!active(o))throw Error('The active module effect is not the exact claimed tractor target.');
  const next=clone(state);if(next.activation&&!next.active&&o.at>=next.activation.issuedAt)next.active=clone(o);save(next);
  await command('deactivation',()=>config.deactivate(i.moduleID));return clone(state);
 }
 async function stopOwnInternal(){if(!config.heldCurrent||!config.readOwn)throw Error("Own tractor settlement is unavailable.");const held=config.heldCurrent,saveHeld=(next:State)=>{held();document.write(clone(next));state=next;},readOwn=async()=>{held();const x=await config.readOwn!();held();if(!x||!id(x.observedAt)||x.observedAt>now()||now()-x.observedAt>90000)throw Error("Own tractor observation is stale.");return {at:x.observedAt,module:decodeModuleObservation(x.module,{moduleID:i.moduleID,typeID:i.typeID,ownerID:i.characterID,shipID:i.shipID,flagID:i.flagID})};};let observed=await readOwn();const active=observed.module.effects.some(e=>e.effectID===q.effectID);if(!active){if(state.activation&&!state.activation.acknowledged&&!state.active&&!state.ownActive)throw Error("Tractor activation outcome remains unknown; no replay.");if(state.deactivation&&observed.at<state.deactivation.issuedAt)throw Error("Own inactive observation predates shutdown.");saveHeld({...state,ownInactive:observed});return clone(state);}if(state.deactivation){if(state.ownInactive)saveHeld({...state,ownInactive:undefined});return clone(state);}saveHeld({...state,ownInactive:undefined,ownActive:observed,deactivation:intent()});held();try{await config.deactivate(i.moduleID);}catch(error){held();const next=clone(state);next.deactivation!.error=error instanceof Error?error.message:String(error);saveHeld(next);return clone(state);}held();const next=clone(state);next.deactivation!.acknowledged=true;saveHeld(next);observed=await readOwn();if(!observed.module.effects.some(e=>e.effectID===q.effectID)&&observed.at>=next.deactivation!.issuedAt)saveHeld({...state,ownInactive:observed});return clone(state);}
 let tail:Promise<unknown>=Promise.resolve();const serial=<T>(fn:()=>Promise<T>):Promise<T>=>{const r=tail.then(fn);tail=r.then(()=>undefined,()=>undefined);return r;};
 return {snapshot:()=>clone(state),advance:()=>serial(advanceInternal),reconcile:()=>serial(reconcileInternal),stop:()=>serial(stopInternal),stopOwn:()=>serial(stopOwnInternal)};
}
