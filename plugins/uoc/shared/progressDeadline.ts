import type {AutopilotProgress,decodeFlightStatus} from "../../../web/src/plugin-api/flying.ts";
import type {PilotSession} from "../../../web/src/plugin-api/pilotSession.ts";

type FlightStatus=ReturnType<typeof decodeFlightStatus>;

/** An existing action's idle limit, renewed by observed native progress. No RPC or dispatch lives here. */
export function progressDeadline(idleMs:number,now=Date.now){
 let last=now(),key:string|null=null;
 return (nativeFacts:unknown)=>{const next=JSON.stringify(nativeFacts);if(next!==key){key=next;last=now();}return now()-last<idleMs;};
}
/** Deliberately excludes sample times: a fresh read alone is not movement. */
export function travelFacts(f:any,p:any,position?:unknown){return [f.shipID,f.solarSystemID,f.stationID,f.structureID,f.shipMode,f.transition?.phase,p?.currentSystemID,p?.nextSystemID,p?.remainingJumps,position];}

/** Reuse the stock route's flight reads while it keeps publishing the held ship. */
export function routeFlightObservation(session:Pick<PilotSession,"store">,shipID:number){
 let last:FlightStatus|null=null,observedAt=-Infinity,nextRead=0;
 let lastSystem:number|null=null;
 return (progress:AutopilotProgress|null):{flight:FlightStatus|null;read:boolean}=>{
  if(progress?.status!=="running")return {flight:null,read:true};
  const status=session.store?.flight?.get().status;
  if(!status||status.shipID!==shipID||status.solarSystemID===null)return {flight:null,read:true};
  const now=performance.now();
  if(status!==last){last=status;observedAt=now;}
  const systemChanged=progress.currentSystemID!==lastSystem;
  lastSystem=progress.currentSystemID;
  const matchingSystem=lastSystem==null||status.solarSystemID===lastSystem;
  if(matchingSystem&&now-observedAt<=10_000)return {flight:status,read:false};
  const read=systemChanged||now>=nextRead;
  if(read)nextRead=now+10_000;
  return {flight:null,read};
 };
}
/** Retry a timed-out READ once against current state. Never pass a mutation here. No delay or transaction replay. */
export async function readAfterTimeout<T>(read:()=>Promise<T>):Promise<T>{try{return await read();}catch(error){const e=error as any;if(!/CALL_TIMEOUT|TRANSITION_TIMEOUT|EVE_GATEWAY_TIMEOUT|timed? ?out/i.test(String(e?.code??e?.data?.error??e?.message??'')))throw error;return read();}}

/** These failures authorize a fresh observation or movement replan, never a write replay. */
export function transientNativeRead(error:unknown):boolean {
 const e=error as {code?:unknown;name?:unknown;data?:{error?:unknown};status?:unknown}|null;
 return [502,503,504].includes(Number(e?.status)) ||
  e?.name==="TransportQueueError"||e?.name==="TimeoutError"||
  /^(?:CALL_TIMEOUT|TRANSITION_TIMEOUT|EVE_GATEWAY_TIMEOUT|EVE_GATEWAY_UNREACHABLE|TRANSPORT|SESSION_CHANGE_IN_PROGRESS|BRIDGE_NETWORK_ERROR|ECONNRESET|ETIMEDOUT)$/.test(String(e?.code??e?.data?.error??""));
}

/** A rejected lane admission proves the native command was never dispatched. */
export function bridgeCallQueueTimeout(error:unknown):boolean {
 const e=error as {name?:unknown;code?:unknown;status?:unknown;message?:unknown}|null;
 if(e?.name==="TransportQueueError")return true;
 if(e?.code!=="BRIDGE_NETWORK_ERROR"||e.status!==0||typeof e.message!=="string")return false;
 return /^\/api\/bridge\/call (?:never got a connection: it waited \d+s for one of the browser's \d+ request lanes\.|waited \d+s for a hosted request slot\.)/.test(e.message);
}
