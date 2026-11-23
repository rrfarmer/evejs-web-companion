import type {MiningTravelAssist} from "./travelAssist.ts";
import {decodeFlightStatus,decodeSpaceSnapshot,getFlightStatus,getSpaceSnapshot,undock} from "../../../web/src/plugin-api/flying.ts";
import type {PluginRunContext} from "../../../web/src/plugin-api/backend.ts";
import type {PilotSession} from "../../../web/src/plugin-api/pilotSession.ts";
import type {Claim,Target} from "./targetBoard.ts";
import {fleetReadFailed,FleetObservationUnavailable,FleetShipChanged} from "./stopSignal.ts";
import {timed,type MccTiming} from "./timing.ts";
import {travelToMiningSystem} from "./transitScript.ts";
type Run=Pick<PluginRunContext,"characterID"|"baseUrl"|"fetch">;
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
/** Movement uses bracketed reads. A working pass can reuse its matching flight and scene. */
export async function readMiningReadiness(run:Run,session:PilotSession,shipID:number,systemID:number,current:()=>void,timing?:MccTiming,stage="mining",initialFlight?:Parameters<typeof decodeFlightStatus>[0],confirmFlight=true){
 const options={...session.flow.requestOptions(),baseUrl:run.baseUrl,fetch:run.fetch};
 const flight=async(provided?:Parameters<typeof decodeFlightStatus>[0])=>{current();const raw=provided??(await getFlightStatus(options).catch(fleetReadFailed)).flight;const x=decodeFlightStatus(raw);current();if(x.shipID&&x.shipID!==shipID)throw new FleetShipChanged("Mining ship changed.",x.shipIsCapsule===true);if(!x.shipID)throw new FleetObservationUnavailable("Native active ship is temporarily unreadable.");if(!x.inSpace||x.docked||x.solarSystemID!==systemID)throw Error("Mining flight identity is uncertain.");const transition=(raw as any)?.transition;return {x,transitionReady:!!transition&&typeof transition==="object"&&!Array.isArray(transition)&&transition.phase==="ready"&&["sessionStable","locationReady","sceneReady","egoReady","shipReady","boundContextReady"].every(k=>transition[k]===true)};};
 const first=await timed(timing,stage+".flight-before",()=>flight(initialFlight),undefined,15000);current();
 const flightObservedAt=performance.now();
 const raw=(await timed(timing,stage+".snapshot",()=>getSpaceSnapshot(options).catch(fleetReadFailed),undefined,15000)).space;
 const observedAt=performance.now();
 current();const space=decodeSpaceSnapshot(raw);
 if(space.stateValid===false||!space.inSpace||space.shipID!==shipID||space.solarSystemID!==systemID||space.ship?.itemID!==shipID||(space.ship.characterID!=null&&space.ship.characterID!==run.characterID)||!space.ship.geometryAvailable||!Number.isFinite(space.sampledAtMs)){
  timing?.change(stage+".readiness","scene-unverified",{reason:"scene-unverified",sceneSampledAtMs:space.sampledAtMs});
  throw new FleetObservationUnavailable("Mining scene identity is temporarily unreadable.");
 }
 const last=confirmFlight||observedAt-flightObservedAt>1500?await timed(timing,stage+".flight-after",flight,undefined,15000):first;
 const readyFlight=(v:typeof first)=>v.transitionReady&&typeof v.x.shipMode==="string"&&v.x.shipMode.toUpperCase()!=="WARP"&&(!v.x.transition||v.x.transition.phase==="ready");
 const mode=space.ship.mode;const ready=readyFlight(first)&&readyFlight(last)&&typeof mode==="string"&&mode.toUpperCase()!=="WARP"&&!space.ship.warp;
 if(timing){
  const reason=ready?"ready":!first.transitionReady||!last.transitionReady?"session-transition":first.x.shipMode?.toUpperCase()==="WARP"||last.x.shipMode?.toUpperCase()==="WARP"||mode?.toUpperCase()==="WARP"||space.ship.warp?"warp":"flight-mode-unavailable";
  timing.change(stage+".readiness",reason,{reason,sceneSampledAtMs:space.sampledAtMs});
 }
 return {ready,space,raw,observedAt};
}
export type MiningReadiness=Awaited<ReturnType<typeof readMiningReadiness>>;
export type FlightObservation=(status:ReturnType<typeof decodeFlightStatus>,startedAt:number)=>void;
/** Exact native belt ID is supplied by the operation's selector, never guessed from a name. */
export function createNativeBeltNavigation(run:Run,session:PilotSession,config:{shipID:number;beltID:number;current:()=>void;movementAdmission?:()=>Promise<void>;beforeDeparture?:()=>Promise<void>;travelAssist?:MiningTravelAssist;pollMs?:number;timeoutMs?:number;timing?:MccTiming;observeFlight?:FlightObservation}){
 const {shipID,beltID,current,timing}=config;if(![shipID,beltID].every(x=>Number.isSafeInteger(x)&&x>0))throw Error("Invalid belt or ship identity.");
 const f=session.flow.flying,options={...session.flow.requestOptions(),baseUrl:run.baseUrl,fetch:run.fetch},poll=config.pollMs??1500,timeout=config.timeoutMs??180000;
 const guard=()=>{current();if(session.store.station.get().online?.characterID!==run.characterID)throw Error("Mining pilot changed.");};
 const status=async()=>{guard();const startedAt=Date.now(),raw=(await getFlightStatus(options).catch(fleetReadFailed)).flight,x=decodeFlightStatus(raw);guard();config.observeFlight?.(x,startedAt);if(!x.shipID)throw new FleetObservationUnavailable("Native active ship is temporarily unreadable.");if(x.shipID!==shipID)throw new FleetShipChanged("Mining ship changed.",x.shipIsCapsule===true);return {...x,raw};};
 const checkTarget=(target:Target,claim:Claim)=>{if(target.kind!=="BELT"||claim.key!==`BELT:${target.systemID}:${target.name.trim()}`)throw Error("Only the exact claimed belt is supported.");};
 const distance=async(target:Target,claim:Claim,stage:string,firstFlight?:Parameters<typeof decodeFlightStatus>[0],confirmFlight=true)=>{checkTarget(target,claim);
  const observed=await readMiningReadiness(run,session,shipID,target.systemID,guard,timing,stage,firstFlight,confirmFlight),raw=observed.raw;const record=raw as {entities?:unknown}|null;
  if(!raw||typeof raw!=="object"||Array.isArray(raw)||!Array.isArray(record?.entities)||record.entities.filter((v:any)=>v?.itemID===beltID).length!==1)throw new FleetObservationUnavailable("Claimed belt is absent or ambiguous in the current scene.");
  const space=observed.space,belt=space.entities.find(x=>x.itemID===beltID);
  if(!belt||!belt.geometryAvailable||belt.radius<=0)throw new FleetObservationUnavailable("Claimed belt geometry is temporarily unreadable.");
  if(belt.groupID===null)throw new FleetObservationUnavailable("Claimed belt type is temporarily unreadable.");
  if(belt.groupID!==9)throw Error("The claimed object is not an asteroid belt.");
  const ship=space.ship!,p=belt.position,q=ship.position;return {observed,ready:observed.ready,meters:Math.max(0,Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)-belt.radius-ship.radius),shipRadius:ship.radius,beltRadius:belt.radius,sceneSampledAtMs:space.sampledAtMs};};
 async function assertAtTarget(target:Target,claim:Claim){const d=await distance(target,claim,"belt-assert");if(!d.ready)throw new FleetObservationUnavailable("Miner has not safely reached the claimed belt yet.");if(d.meters>20000)throw Error("Miner has not safely reached the claimed belt.");return d.observed;}
 const beltArrived=(claim:Claim,d:Awaited<ReturnType<typeof distance>>)=>timing?.change("belt-arrival",claim.generation,
  {beltID,claimGeneration:claim.generation,meters:Math.round(d.meters),sceneSampledAtMs:d.sceneSampledAtMs});
 async function navigate(target:Target,claim:Claim,onArrival?:(observed:MiningReadiness)=>void){checkTarget(target,claim);let end=Date.now()+timeout,state=await status();
  const settledHere=state.inSpace&&!state.docked&&state.solarSystemID===target.systemID&&state.transition?.phase==="ready"&&state.shipMode?.toUpperCase()!=="WARP";
  if(state.docked){await config.movementAdmission?.();guard();await undock(f.bridgeDo,f.readFlightNow,false);guard();state=await status();}if(!state.inSpace)throw Error("Miner is not ready in space.");
  if(state.solarSystemID!==target.systemID){
   await config.movementAdmission?.();await config.beforeDeparture?.();
   const transit=await travelToMiningSystem(session,target.systemID,end,guard);
   state=await status();
   if(!state.inSpace||state.solarSystemID!==target.systemID){
    if(transit==="timed-out")throw new FleetObservationUnavailable("Mining-system route timed out before arrival was confirmed.");
    throw Error("Mining-system arrival was not confirmed.");
   }
   // The intersystem leg has finished. It cannot consume the belt warp's time.
   end=Date.now()+timeout;
  }
  const scope=claim.key+":"+claim.generation+":"+beltID;
  const arrived=async(d:Awaited<ReturnType<typeof distance>>)=>{beltArrived(claim,d);await config.travelAssist?.settle(scope);onArrival?.(d.observed);};
  let ordered=false,firstFlight:Parameters<typeof decodeFlightStatus>[0]|undefined=state.raw;
  for(;;){
   const d=await distance(target,claim,"belt-navigation",firstFlight,!(firstFlight&&settledHere));firstFlight=undefined;
   if(d.ready&&d.meters<=20000){timing?.change("belt-navigation-wait","arrived",{reason:"arrived",beltID,sceneSampledAtMs:d.sceneSampledAtMs});await arrived(d);return;}
   if(Date.now()>=end)throw new FleetObservationUnavailable("Waiting for confirmed arrival at the claimed belt.");
   if(timing){
    const reason=!d.ready?"flight-not-ready":ordered?"movement-in-progress":"outside-belt-envelope";
    timing.change("belt-navigation-wait",reason,{reason,beltID,meters:Math.round(d.meters),sceneSampledAtMs:d.sceneSampledAtMs});
   }
   if(d.ready&&!ordered){
    await config.movementAdmission?.();guard();
    const admitted=await distance(target,claim,"belt-pre-movement");
    if(!admitted.ready){await pause(poll);continue;}
    if(admitted.meters<=20000){await arrived(admitted);return;}
    await config.beforeDeparture?.();guard();
    if(admitted.meters<Math.max(0,152500+admitted.shipRadius-admitted.beltRadius)){
     await config.travelAssist?.beforeApproach(scope,admitted.meters,10000,beltID);guard();
     await timed(timing,"belt-approach-rpc",()=>f.approachShip(beltID,10000),{beltID});
    }else await timed(timing,"belt-warp-rpc",()=>f.warpAsTheAutopilot(beltID),{beltID});
    guard();ordered=true;end=Date.now()+timeout;
   }
   await pause(poll);
  }
 }
 return {navigate,assertAtTarget};
}
