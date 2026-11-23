import {decodeFlightStatus,getFlightStatus,undock} from '../../../web/src/plugin-api/flying.ts';
import type {PluginRunContext} from '../../../web/src/plugin-api/backend.ts';
import type {PilotSession} from '../../../web/src/plugin-api/pilotSession.ts';
import {readMiningReadiness} from './nativeBelt.ts';
import {createSiteDiscovery,type NativeSite} from './siteDiscovery.ts';
import {validSavedSiteClassification,sameSiteClassification} from './siteSelection.ts';
import type {SynchronousStore} from './targetBoard.ts';
export type SiteSearchFamily='ORE'|'MOON'|'ICE';
export type SiteSearchResult=NativeSite|{kind:'NO_SITE_OBSERVED';family:SiteSearchFamily;observedAt:number;scans:number}|{kind:'STOPPED';observedAt:number};
type Intent={issuedAt:number;fromID:number;acknowledged:boolean};
type Evidence={intent:Intent;outcome:'undocked'|'not-dispatched';observedAt:number;sceneSampledAtMs:number|null;refusal?:{code:'SESSION_CHANGE_IN_PROGRESS';message:string}};
type State={version:1;identity:string;pending:Intent|null;history:Evidence[];site:NativeSite|null};
const id=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const waitDefault=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const clone=<T>(x:T):T=>structuredClone(x);
const sameSite=(a:NativeSite,b:NativeSite)=>a.scannerKey===b.scannerKey&&a.instanceID===b.instanceID&&a.label===b.label&&a.archetypeID===b.archetypeID&&JSON.stringify(a.target)===JSON.stringify(b.target)&&sameSiteClassification(a,b);
/** Held pilot only. The one possible undock is journaled before the stock native call. */
export async function resolveMiningSite(run:PluginRunContext,session:PilotSession,config:{shipID:number;systemID:number;family:SiteSearchFamily;current:()=>void;stopRequested:()=>boolean;document:SynchronousStore;available?:(site:NativeSite)=>boolean;select?:(sites:readonly NativeSite[])=>Promise<NativeSite>;now?:()=>number;wait?:(ms:number)=>Promise<void>}):Promise<SiteSearchResult>{
 const {shipID,systemID,family,current,stopRequested,document}=config,now=config.now??Date.now,wait=config.wait??waitDefault,f=session.flow.flying;
 if(!id(run.characterID)||typeof run.botID!=='string'||!run.botID||!id(shipID)||!id(systemID)||!['ORE','MOON','ICE'].includes(family)||!document||typeof document.read!=='function'||typeof document.write!=='function')throw Error('Site search scope is invalid.');
 const generation=f.sessionGeneration();if(!Number.isSafeInteger(generation)||generation<0)throw Error('Site search session generation is invalid.');
 const guard=()=>{current();if(f.sessionGeneration()!==generation||session.store.station.get().online?.characterID!==run.characterID)throw Error('Site search held owner or session changed.');};
 const identity=JSON.stringify([run.botID,run.characterID,shipID,systemID,generation,family]),raw=document.read() as State|null;let state:State;
 const validIntent=(x:Intent)=>!!x&&Number.isSafeInteger(x.issuedAt)&&x.issuedAt>0&&id(x.fromID)&&typeof x.acknowledged==='boolean';
 const validSite=(x:NativeSite)=>!!x&&x.siteFamily===family&&id(x.scannerKey)&&id(x.instanceID)&&x.target?.systemID===systemID&&x.target.siteID===x.scannerKey&&x.target.instanceID===x.instanceID&&validSavedSiteClassification(x);
 if(raw===null)state={version:1,identity,pending:null,history:[],site:null};else{if(!raw||raw.version!==1||raw.identity!==identity||!Array.isArray(raw.history)||raw.history.some(h=>!h||!validIntent(h.intent)||!['undocked','not-dispatched'].includes(h.outcome)||!Number.isFinite(h.observedAt)||h.observedAt<h.intent.issuedAt||!(h.outcome==='undocked'?Number.isFinite(h.sceneSampledAtMs)&&h.sceneSampledAtMs!>=h.intent.issuedAt:h.sceneSampledAtMs===null)||!(h.refusal===undefined||h.outcome==='not-dispatched'&&h.refusal.code==='SESSION_CHANGE_IN_PROGRESS'&&typeof h.refusal.message==='string'))||!(raw.pending===null||validIntent(raw.pending))||!(raw.site===null||validSite(raw.site)))throw Error('Site search journal requires reconciliation.');state=clone(raw);}
 const save=(next:State)=>{guard();document.write(clone(next));state=clone(next);};
 const options={...session.flow.requestOptions(),baseUrl:run.baseUrl,fetch:run.fetch};
 const status=async()=>{guard();const x=decodeFlightStatus((await getFlightStatus(options)).flight);guard();if(x.shipID!==shipID||x.solarSystemID!==systemID||(x.inSpace&&x.docked))throw Error('Site search physical scope is uncertain.');return x;};
 const started=now(),deadline=started+120000;if(!Number.isFinite(started)||started<=0)throw Error('Site search clock is invalid.');
 let flight=await status();
 if(flight.docked&&!state.pending){if(state.history.some(h=>h.outcome==='undocked'||h.refusal?.code==='SESSION_CHANGE_IN_PROGRESS')||state.site)throw Error('Previously undocked search is docked; no undock replay.');if(stopRequested())return {kind:'STOPPED',observedAt:now()};const fromID=flight.stationID??flight.structureID;if(!id(fromID)||flight.transition&&flight.transition.phase!=='ready')throw Error('Docked origin is not ready for site search.');const issuedAt=now();if(!Number.isSafeInteger(issuedAt)||issuedAt<=0)throw Error('Site search intent clock is invalid.');const intent={issuedAt,fromID,acknowledged:false};save({...state,pending:intent});
  if(stopRequested()){save({...state,pending:null,history:[...state.history,{intent,outcome:'not-dispatched',observedAt:now(),sceneSampledAtMs:null}]});return {kind:'STOPPED',observedAt:now()};}
  try{guard();await undock(f.bridgeDo,async()=>{const fresh=await status();if(!fresh.docked||(fresh.stationID??fresh.structureID)!==intent.fromID)throw Error('Undock origin changed.');return fresh;},false);guard();save({...state,pending:{...intent,acknowledged:true}});}catch(error){guard();if(!state.pending)throw error;if(error&&typeof error==='object'&&(error as {code?:unknown}).code==='SESSION_CHANGE_IN_PROGRESS'){const fresh=await status();if(fresh.docked&&(fresh.stationID??fresh.structureID)===intent.fromID){save({...state,pending:null,history:[...state.history,{intent,outcome:'not-dispatched',observedAt:now(),sceneSampledAtMs:null,refusal:{code:'SESSION_CHANGE_IN_PROGRESS',message:error instanceof Error?error.message:'SESSION_CHANGE_IN_PROGRESS'}}]});throw Error('Undock was not dispatched: SESSION_CHANGE_IN_PROGRESS.');}}/* Reconcile the original undock from held native reads only. */}
 }
 while(true){guard();flight=await status();if(flight.inSpace){let ready:Awaited<ReturnType<typeof readMiningReadiness>>|null=null;try{ready=await readMiningReadiness(run,session,shipID,systemID,guard);}catch{guard();}if(ready?.ready&&Number.isFinite(ready.space.sampledAtMs)&&ready.space.sampledAtMs!>0&&(!state.pending||ready.space.sampledAtMs!>=state.pending.issuedAt)){if(state.pending){const intent=state.pending;save({...state,pending:null,history:[...state.history,{intent,outcome:'undocked',observedAt:now(),sceneSampledAtMs:ready.space.sampledAtMs!}]});}break;}}
  if(now()>=deadline)throw Error(state.pending?'Undock outcome remains unknown; no replay.':'Site search flight readiness remains unknown.');await wait(1000);
 }
 if(stopRequested())return {kind:'STOPPED',observedAt:now()};
 const discovery=createSiteDiscovery(run,session,{shipID,systemID,current:guard,now});let scans=0;const scanDeadline=now()+120000;
 while(now()<scanDeadline){guard();if(stopRequested())return {kind:'STOPPED',observedAt:now()};const rows=await discovery.read();guard();scans++;if(stopRequested())return {kind:'STOPPED',observedAt:now()};
  if(state.site){const fresh=rows.filter(x=>sameSite(state.site!,x));if(fresh.length!==1)throw Error('The previously resolved site is missing or changed.');if(config.available&&config.available(fresh[0]!)!==true)throw Error('The previously resolved site is no longer available.');return clone(fresh[0]!);}
  const eligible=rows.filter(x=>validSite(x)&&(!config.available||config.available(x)===true)).sort((a,b)=>a.scannerKey-b.scannerKey||a.instanceID-b.instanceID);
  if(eligible.length){const site=config.select?await config.select(eligible):eligible[0]!;guard();if(!eligible.some(s=>sameSite(s,site))||config.available&&config.available(site)!==true)throw Error('Site selection changed during native locality observation.');save({...state,site});return clone(site);}await wait(Math.min(1000,Math.max(0,scanDeadline-now())));
 }
 if(!scans)throw Error('Site scanner was not observed before the deadline.');return {kind:'NO_SITE_OBSERVED',family,observedAt:now(),scans};
}
