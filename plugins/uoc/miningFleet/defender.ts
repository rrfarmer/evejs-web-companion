import type {PluginRunContext} from "../../../web/src/plugin-api/backend.ts";
import type {PilotSession} from "../../../web/src/plugin-api/pilotSession.ts";
import {decidePropulsionModule,decodeFlightStatus,decodeSpaceSnapshot,getFlightStatus,getSpaceSnapshot,isHostile,scrammedByWarpScrambler} from "../../../web/src/plugin-api/flying.ts";
import {createPilotFighter,SecurityTargetUnobserved,type PilotFighterState} from "../combat/pilotFighter.ts";
import {createDefenderPreparation,type DefenderPreparation} from "../combat/defenderPreparation.ts";
import {boundedDroneWrite} from "../combat/droneAdapter.ts";
import {bridgeCallQueueTimeout} from "../shared/progressDeadline.ts";
import {assertFleetDroneDeparture,recallFleetDrones} from "./droneRecall.ts";
import {createNativeMiningNavigation} from "./nativeMember.ts";
import {targetKey,type Claim,type Target,type SynchronousStore} from "./targetBoard.ts";
import type {NativeSite} from "./siteDiscovery.ts";
import {rankEscortTargets,type ActiveJam} from "./defenderTargets.ts";
import {createBeltRepair,type RepairMember} from "./repair.ts";
import {fleetReadFailed,FleetObservationUnavailable} from "./stopSignal.ts";
import {timed,type MccTiming} from "./timing.ts";
type Scene=ReturnType<typeof decodeSpaceSnapshot>;
type Entity=Scene["entities"][number];
const ESCORT_RANGE=5000;
const ESCORT_LIMIT=120_000;
const MIN_APPROACH_PROGRESS=100;
const PROP_GAP_M=5000,PROP_CAP_FLOOR=.3;
type Position=Entity["position"];
const distance=(a:Entity["position"],b:Entity["position"])=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const surface=(a:{position:Entity["position"];radius:number},b:Entity)=>Math.max(0,distance(a.position,b.position)-a.radius-b.radius);
const inEscort=(point:Position,centers:readonly Position[])=>centers.some(center=>distance(point,center)<=ESCORT_LIMIT);
const following=(mode:string|null|undefined)=>mode?.toUpperCase()==="FOLLOW";
const followTarget=(view:Scene)=>following(view.ship?.mode)
 ?view.entities.find(e=>e.itemID===view.shipID)?.targetEntityID??null:null;
const followsAtRange=(view:Scene,targetID:number,range:number)=>followTarget(view)===targetID&&
 (view.ship!.followRange===null||view.ship!.followRange===range);

/** A straight native approach must stay inside the union of the live escort areas. */
function coveredApproach(ship:NonNullable<Scene["ship"]>,target:Entity,range:number,centers:readonly Position[]){
 const start=ship.position,end=target.position,total=distance(start,end),travel=total-ship.radius-target.radius-range;
 if(travel<=0)return true;
 const direction={x:(end.x-start.x)/total,y:(end.y-start.y)/total,z:(end.z-start.z)/total};
 const intervals=centers.flatMap(center=>{
  const x=center.x-start.x,y=center.y-start.y,z=center.z-start.z;
  const projection=x*direction.x+y*direction.y+z*direction.z;
  const halfSquared=ESCORT_LIMIT**2-((x-direction.x*projection)**2+(y-direction.y*projection)**2+(z-direction.z*projection)**2);
  if(halfSquared<0)return [];
  const half=Math.sqrt(halfSquared);
  return [{enter:projection-half,exit:projection+half}];
 }).sort((a,b)=>a.enter-b.enter);
 let covered=0;
 for(const {enter,exit} of intervals){
  if(enter>covered)break;
  covered=Math.max(covered,exit);
  if(covered>=travel)return true;
 }
 return false;
}
/** WC74 Standard Defender uses the existing hostile overview predicate. Require a native NPC ship row as well. */
export function isMiningDefenderTarget(e:Entity){return e.kind==="ship"&&e.categoryID===11&&e.geometryAvailable===true&&Number.isSafeInteger(e.itemID)&&e.itemID>0&&isHostile(e)&&["npc","drifter"].includes(e.npcEntityType??"");}
export class DefenderStopBeforeAction extends Error {constructor(){super("Defender is stopping.");}}
function defenderAsk(run:PluginRunContext,session:PilotSession,current:()=>void){
 return async(service:string,method:string,args:unknown[]=[],of?:number)=>{
  current();
  const notifications=session.flow.requestOptions().captureNotificationSink?.();
  const response=await run.fetch(new URL("/api/bridge/call",run.baseUrl),{method:"POST",headers:{"content-type":"application/json"},
   body:JSON.stringify({service,method,args,pilot:true,confirm:true,...(of===undefined?{}:{of})})});
  const v=await response.json().catch(error=>{if(response.ok)throw error;return null;});current();
  if(Array.isArray(v?.notifications))notifications?.(v.notifications);
  if(!response.ok||v?.ok===false)throw Object.assign(Error(v?.message??v?.error??"Defender native call failed."),
   {code:v?.error,status:response.status,refusal:v?.refusal});
  return v.result;
 };
}
export function prepareHeldDefender(run:PluginRunContext,session:PilotSession,shipID:number,current:()=>void){
 return createDefenderPreparation({session,shipID,characterID:run.characterID,current,ask:defenderAsk(run,session,current),
  options:()=>({...session.flow.requestOptions(),baseUrl:run.baseUrl,fetch:run.fetch})});
}
/** Existing WC75 PilotFighter and mining navigation, scoped to one held ship and operation claim. */
export function createMiningDefender(config:{run:PluginRunContext;session:PilotSession;shipID:number;target:Target;claim:Claim;beltID?:number;site?:NativeSite;document:(key:string)=>SynchronousStore;current():void;stopRequested():boolean;timing?:MccTiming;observeFlight?:import("./nativeBelt.ts").FlightObservation;authority:()=>{state:string;target:Target;claim:Claim|null}|null;protectedShips?:readonly number[];threatJams?:()=>readonly ActiveJam[];fleetFocus?:()=>readonly number[];repairMembers?:readonly RepairMember[];repairEligible?:(member:RepairMember)=>boolean;escortEligible?:(member:RepairMember)=>boolean;wait?:(ms:number)=>Promise<void>;preparation?:DefenderPreparation}){
 const {run,session,shipID,target,claim}=config,generation=session.flow.flying.sessionGeneration(),identity={operationID:claim.operationID,runID:claim.runID,claimKey:claim.key,claimGeneration:claim.generation,characterID:run.characterID,shipID,botID:run.botID,sessionGeneration:generation};
 if(!run.botID||run.held.characterID!==run.characterID||!Number.isSafeInteger(generation)||generation<0||claim.key!==targetKey(target))throw Error("Defender held identity is unavailable.");
 let work:Promise<unknown>|null=null,stopping=false,deferRecall=false;const state:PilotFighterState<typeof identity>={currentIdentity:null,entryAnchor:null,droneUnresolved:false};
 const current=()=>{config.current();if(session.flow.flying.isSessionClosing()||session.flow.flying.sessionGeneration()!==generation||session.store.station.get().online?.characterID!==run.characterID)throw Error("Defender pilot ownership changed.");};
 const guard=()=>{current();if(stopping||config.stopRequested())throw new DefenderStopBeforeAction();const row=config.authority();if(!row||row.state!=="ACTIVE"||!row.claim||row.claim.operationID!==claim.operationID||row.claim.runID!==claim.runID||row.claim.key!==claim.key||row.claim.generation!==claim.generation||row.claim.expiresAt<=Date.now()||JSON.stringify(row.target)!==JSON.stringify(target))throw Error("Defender target authority changed.");};
 const options=()=>({...session.flow.requestOptions(),baseUrl:run.baseUrl,fetch:run.fetch}),navigation=createNativeMiningNavigation(run,session,{shipID,beltID:config.beltID,site:config.site,current:guard,authority:config.authority,document:config.document,timing:config.timing}),moduleKey=JSON.stringify([claim.operationID,claim.runID,run.botID,run.characterID,shipID,claim.key,claim.generation]);
 let warning:string|null=null;
 const diagnostic=(kind:string,data:unknown)=>{
  if(data&&typeof data==="object"){
   const details=data as {reason?:unknown;warning?:unknown};
   if(["weapon-unavailable","defense-unavailable","drone-engage-refused"].includes(kind)&&typeof details.reason==="string")
    warning=details.reason;
   if(kind==="drone-return-incomplete"&&typeof details.warning==="string")warning=details.warning;
  }
   if(config.timing&&["launch-confirmed","engage-confirmed","engage-not-dispatched","engage-target-absent"].includes(kind)){
    const detail=data as {target?:number|null;sampledAt?:number;sceneSampledAt?:number;drones?:unknown[];reason?:string};
    config.timing.change("defender-"+kind,detail.sampledAt??detail.reason+":"+detail.target,
     {targetID:detail.target,sceneSampledAtMs:detail.sampledAt??detail.sceneSampledAt,droneCount:detail.drones?.length,reason:detail.reason});
   }
 };
 const flight=async()=>{current();const startedAt=Date.now(),v=decodeFlightStatus((await getFlightStatus(options()).catch(fleetReadFailed)).flight);current();config.observeFlight?.(v,startedAt);if(v.shipID!==shipID||v.solarSystemID!==target.systemID)throw Error("Defender ship or system changed.");return v;};
 let observedNpcs=new Map<number,boolean>();
 let sceneWork:ReturnType<typeof getSpaceSnapshot>|undefined;
 const scene=async()=>{
  current();
  const work=sceneWork??=timed(config.timing,"defender-snapshot",()=>getSpaceSnapshot(options()).catch(fleetReadFailed),undefined,15000).finally(()=>{sceneWork=undefined;});
  const v=decodeSpaceSnapshot((await work).space);current();
  if(v.shipID!==null&&v.shipID!==shipID||v.solarSystemID!==null&&v.solarSystemID!==target.systemID||
     v.ship?.itemID!=null&&v.ship.itemID!==shipID||v.ship?.characterID!=null&&v.ship.characterID!==run.characterID)
   throw Error("Defender ship, pilot or system changed.");
  if(!v.inSpace||v.stateValid===false||v.shipID!==shipID||v.solarSystemID!==target.systemID||
     v.ship?.itemID!==shipID||!v.ship.geometryAvailable||v.ship.mode?.toUpperCase()==="WARP"||v.ship.warp||!Number.isFinite(v.sampledAtMs))
   throw new FleetObservationUnavailable("Defender scene is temporarily unavailable.");
  if(config.timing){
   const visible=new Map<number,boolean>();
   for(const row of v.entities){
    if(!row.isNpc||row.isSelf||row.kind!=="ship"||row.npcEntityType==="concord"||row.itemID<=0)continue;
    const wasEligible=observedNpcs.get(row.itemID);
    if(wasEligible===undefined)config.timing.note("defender-npc-observed",{targetID:row.itemID,sceneSampledAtMs:v.sampledAtMs},"essential");
    visible.set(row.itemID,wasEligible??false);
   }
   observedNpcs=visible;
  }
  return v;
 };
 const ask=defenderAsk(run,session,current),preparation=config.preparation??prepareHeldDefender(run,session,shipID,current);
 function escortScope(view:Scene){
  const roster=(config.repairMembers??[]).filter(m=>m.role==="MINER"&&
   config.repairEligible?.(m)!==false&&config.escortEligible?.(m)!==false);
  const peers=view.entities.filter(e=>e.kind==="ship"&&!e.isNpc&&e.geometryAvailable&&e.mode?.toUpperCase()!=="WARP"&&
   roster.some(m=>m.shipID===e.itemID&&(e.characterID??e.ownerID)===m.characterID));
  return {peers,centers:peers.map(peer=>peer.position)};
 }
 function eligibleHostile(row:Entity,centers:readonly Position[]){
  return isMiningDefenderTarget(row)&&row.hullRatio!==0&&row.mode?.toUpperCase()!=="WARP"&&inEscort(row.position,centers);
 }
 const fence=async(id:number|null,observed?:Scene)=>{
  guard();
  if(id===null)return;
  const view=observed??await scene();guard();
  const {centers}=escortScope(view);
  if(!centers.length)throw new FleetObservationUnavailable("Active escort positions are temporarily unavailable.");
  if(!inEscort(view.ship!.position,centers))throw new SecurityTargetUnobserved("Defender is outside the 120 km escort area.");
  const row=view.entities.find(e=>e.itemID===id);
  if(!row||!eligibleHostile(row,centers))
   throw new SecurityTargetUnobserved("Defender target is outside the current escort area or no longer eligible.");
 };
 let movement:{target:number;range:number;pursuit:boolean;accepted:boolean;issuedAt:number|null;
  progressAt:number;baseline:number;sampledAt:number}|null=null;
 let movementWarning:string|null=null;
 const moduleStops=new Set<number>();
 let propulsionWork:Promise<void>|undefined,propulsionStarting:number|undefined;
 function servicePropulsion(view:Scene,wantBurn:boolean){
  const ship=view.ship,modules=preparation.propulsion;
  if(!ship?.activeModuleIDs||!modules.length||propulsionWork)return;
  const activeModuleIDs=new Set(ship.activeModuleIDs);
  if(propulsionStarting!==undefined&&(activeModuleIDs.has(propulsionStarting)||
    !modules.some(module=>module.itemID===propulsionStarting)))propulsionStarting=undefined;
  for(const module of modules)if(!activeModuleIDs.has(module.itemID))moduleStops.delete(module.itemID);
  if(wantBurn&&(propulsionStarting!==undefined||modules.some(module=>activeModuleIDs.has(module.itemID))))return;
  const decision=decidePropulsionModule({modules,activeModuleIDs,capacitorRatio:ship.capacitorRatio,
   scrammed:scrammedByWarpScrambler(session.store.space?.get().jams??[],Date.now()),wantBurn,capFloor:PROP_CAP_FLOOR});
  if(decision.kind==="none")return;
  const module=modules.find(m=>m.itemID===decision.module.itemID);
  if(!module)return;
  const on=decision.kind==="light";
  if(!on&&moduleStops.has(module.itemID))return;
  guard();
  if(on)propulsionStarting=module.itemID;
  else moduleStops.add(module.itemID);
  propulsionWork=boundedDroneWrite(async()=>{
   await session.flow.flying.bridgeDo("dogmaIM",on?"Activate":"Deactivate",
    on?[module.itemID,module.effect,null,-1]:[module.itemID,module.effect]);
  },90_000,()=>{}).catch(error=>{
    const refusal=error as {code?:string;status?:number;message?:string}|null;
    if(refusal?.code==="CALL_REFUSED"&&refusal.status===409||bridgeCallQueueTimeout(error)){
     if(on)propulsionStarting=undefined;
     else moduleStops.delete(module.itemID);
    }
    movementWarning=refusal?.message??String(error);
   }).finally(()=>{propulsionWork=undefined;});
 }
 async function stopApproach(mode:string|null|undefined){
  if(following(mode)){guard();await session.flow.stopShip();guard();}
  movement=null;
  movementWarning=null;
 }
 async function approach(view:Scene,row:Entity,range:number,pursuit:boolean){
  guard();
  const meters=surface(view.ship!,row),now=Date.now(),sampledAt=view.sampledAtMs!;
  const regroupFollow=!pursuit&&followsAtRange(view,row.itemID,range);
  const openThrottle=!pursuit&&view.ship!.speedFraction===0;
  if(movement?.target===row.itemID&&movement.range===range&&movement.pursuit===pursuit){
   if(!pursuit&&sampledAt<=movement.sampledAt)return regroupFollow||movement.accepted;
   movement.sampledAt=sampledAt;
   if(meters<movement.baseline-MIN_APPROACH_PROGRESS){movement.baseline=meters;movement.progressAt=now;}
   // A Miner can move away. Count renewed closing from that distance.
   else if(!pursuit&&meters>movement.baseline+MIN_APPROACH_PROGRESS)movement.baseline=meters;
   if(now-movement.progressAt>=30000){
     config.timing?.change("defender-movement-wait","no-progress:"+row.itemID,{reason:"no-native-approach-progress",targetID:row.itemID,meters:Math.round(meters)});
     // Re-evaluate range and movement on the next scene, even for the same target.
     await stopApproach(view.ship?.mode);
    movementWarning="Approach to "+row.itemID+" has made no native progress.";
    return false;
   }
   if(pursuit?movement.accepted&&following(view.ship?.mode):regroupFollow&&!openThrottle)return true;
   if(movement.issuedAt!==null&&now-movement.issuedAt<5000)return regroupFollow||movement.accepted;
  }
  const prior=movement?.target===row.itemID&&movement.range===range&&movement.pursuit===pursuit?movement:null;
  const sendOrder=openThrottle||!regroupFollow;
  movement={target:row.itemID,range,pursuit,accepted:!sendOrder,issuedAt:sendOrder?now:null,
   progressAt:prior?.progressAt??now,baseline:prior?.baseline??meters,sampledAt};
  if(!sendOrder){movementWarning=null;return true;}
  try{
   await timed(config.timing,"defender-approach-rpc",async()=>{
    // A positive-range Follow on the game port leaves the throttle as it was.
    if(openThrottle){guard();await session.flow.flying.bridgeDo("beyonce","CmdSetSpeedFraction",[1]);}
    guard();if(!regroupFollow)await session.flow.approach(row.itemID,range);
   },{targetID:row.itemID,meters:Math.round(meters),rangeM:range,pursuit,openThrottle,sceneSampledAtMs:sampledAt});
   guard();movement.accepted=true;movementWarning=null;
  }
  catch(error){
   guard();
   const native=error as {code?:unknown;status?:unknown;message?:string};
   if(native?.code!=="CALL_REFUSED"||native.status!==409)throw error;
   movementWarning=native.message??"Native approach was refused.";
   return false;
  }
  return true;
 }
 let regrouping=false,clearCount=0,lastClearSample:number|null=null;
 async function regroup(view:Scene){
  const {peers}=escortScope(view),nativeTarget=followTarget(view);
  const assigned=movement?.pursuit===false?movement.target:null;
  const miner=peers.find(peer=>peer.itemID===assigned)??peers.find(peer=>peer.itemID===nativeTarget)??
   peers.sort((a,b)=>surface(view.ship!,a)-surface(view.ship!,b)||a.itemID-b.itemID)[0];
  if(!miner){
   if(movement)await stopApproach(view.ship?.mode);
   return "regroup-wait" as const;
  }
  // Native steering eases off near its standoff, before it reaches the exact number.
  const arrivedWithin=ESCORT_RANGE+(followsAtRange(view,miner.itemID,ESCORT_RANGE)?MIN_APPROACH_PROGRESS:0);
  if(surface(view.ship!,miner)>arrivedWithin){
   return await approach(view,miner,ESCORT_RANGE,false)?"regrouping" as const:"regroup-wait" as const;
  }
  if(movement&&movement.target!==miner.itemID&&nativeTarget!==miner.itemID)await stopApproach(view.ship?.mode);
  regrouping=false;movement=null;movementWarning=null;
  return null;
 }
 let repairStatus:string|null=null,repairWarning:string|null=null;
 async function settleOffense(view:Scene){
  if(!fighter.dirty)return;
  await fighter.settle(current,true,view);
 }
 const repair=config.repairMembers&&config.repairEligible?createBeltRepair({run,session,shipID,members:config.repairMembers,
   eligible:config.repairEligible,guard,fence:()=>fence(null),scene,readFit:preparation.readFit,canApproach:(view,peer)=>{
   if(config.repairMembers?.some(member=>member.role==="HAULER"&&member.shipID===peer.itemID))return false;
   const belt=target.kind==="BELT"?view.entities.find(e=>e.itemID===config.beltID&&e.groupID===9&&e.geometryAvailable):null;
   return !!belt&&inEscort(peer.position,escortScope(view).centers)&&distance(peer.position,belt.position)-belt.radius<=20000;
  }}):null;
 const defenderIDs=(config.repairMembers??[]).filter(member=>member.role==="DEFENDER")
  .map(member=>member.characterID).sort((a,b)=>a-b);
 const defenderIndex=defenderIDs.indexOf(run.characterID);
 const fighter=createPilotFighter<typeof identity>({moduleDocuments:{locks:config.document(`mining-fleet-defender-locks:${moduleKey}`),actions:config.document(`mining-fleet-defender-actions:${moduleKey}`),reloads:config.document(`mining-fleet-defender-reloads:${moduleKey}`)},moduleStops,run,session:()=>session,state,current,guard,flight,scene,ask,defender:{protectedShips:config.protectedShips??[],
    timing:config.timing,preparation,
  checkTarget:fence,
  rankTargets:input=>rankEscortTargets({...input,protectedShips:config.protectedShips??[],jams:config.threatJams?.()??[],
   fleetFocus:config.fleetFocus?.()??[],now:Date.now(),defenderIndex:defenderIDs.length>1&&defenderIndex>=0?defenderIndex:undefined}),
  filterTargets(view,candidates){
   const {centers}=escortScope(view);
   if(!centers.length)throw new FleetObservationUnavailable("Active escort positions are temporarily unavailable.");
   if(!inEscort(view.ship!.position,centers))throw new SecurityTargetUnobserved("Defender is outside the 120 km escort area.");
   const eligible=candidates.filter(row=>eligibleHostile(row,centers));
   if(config.timing)for(const row of eligible){
    if(observedNpcs.get(row.itemID)!==false)continue;
    observedNpcs.set(row.itemID,true);
    config.timing.note("defender-npc-eligible",{targetID:row.itemID,sceneSampledAtMs:view.sampledAtMs},"essential");
   }
   return eligible;
  },
  approach:async(id,range,view)=>{
   guard();const row=view.entities.find(e=>e.itemID===id);
   const {centers}=escortScope(view);
   if(!centers.length)throw new FleetObservationUnavailable("Active escort positions are temporarily unavailable.");
   if(!row||!eligibleHostile(row,centers)||!inEscort(view.ship!.position,centers))return false;
   if(!coveredApproach(view.ship!,row,range,centers)){
     config.timing?.change("defender-movement-wait","escort-boundary:"+id,{reason:"approach-would-cross-escort-boundary",targetID:id});
    movementWarning="Approach to "+id+" would leave the 120 km escort area.";return false;
   }
   return approach(view,row,range,true);
  },supportCapable:()=>repair?.capable()===true,recall:async ids=>{
  if(deferRecall)return false;
  const result=await recallFleetDrones(run,session,shipID,current,{pendingLaunch:ids});
  const warning=assertFleetDroneDeparture(result);
  if(warning)diagnostic("drone-return-incomplete",{warning,ids:result.unrecovered});
  return true;
 }},mission:async()=>{throw Error("Defender has no mission journal.");},dungeon:async()=>null,diagnostic,droneSample:(s,ids,id)=>({sampledAt:s.sampledAtMs,target:id,drones:ids.map(itemID=>s.entities.find(e=>e.itemID===itemID)??null)}),fenceCombat:fence,sleep:config.wait??(ms=>new Promise(r=>setTimeout(r,ms))),isQualifiedTarget:(_scope,e)=>isMiningDefenderTarget(e),confirmTargetAbsent:async({target:id,ids,preEngage,observed})=>{await fence(null);const fresh=observed??await scene();guard();if(!ids.length||!ids.every(drone=>fresh.entities.some(e=>e.itemID===drone&&e.kind==="drone"&&e.ownerID===run.characterID&&e.controllerID===shipID)))throw Error("Defender drone ownership is unreadable.");return preEngage.sampledAtMs!==null&&fresh.sampledAtMs!==null&&fresh.sampledAtMs>preEngage.sampledAtMs&&!fresh.entities.some(e=>e.itemID===id);}});
 function once<T>(action:()=>Promise<T>){if(stopping||work)throw Error("Defender action is already in flight or stopping.");const pending=action();work=pending;return pending.finally(()=>{if(work===pending)work=null;});}
 return {
  focus:fighter.focus,
  readyToEscort:()=>once(async()=>{
   guard();
   let offenseError:unknown;
   try{if(await fighter.readyToEscort()){guard();return true;}}catch(error){guard();offenseError=error;}
   if(await repair?.ready()){guard();return true;}
   if(offenseError)throw offenseError;
   return false;
  }),
  async navigate(){return once(async()=>{
   current();await propulsionWork;await fighter.settle(current);guard();state.entryAnchor=null;
   await navigation.navigate(target,claim);guard();
   state.entryAnchor={...(await scene()).ship!.position};guard();
  });},
  async tick(){return once(async()=>{
   guard();
   const s=await scene().catch(async error=>{
    if(error instanceof FleetObservationUnavailable&&movement?.pursuit){
     const observed=await flight().catch(()=>null);guard();
     if(observed?.inSpace)await stopApproach(observed.shipMode);
    }
    throw error;
    });guard();preparation.refresh(s);
   const {centers,peers}=escortScope(s);
   if(!state.entryAnchor){
    if(!centers.length){await navigation.assertAtTarget(target,claim);guard();}
    state.entryAnchor={...s.ship!.position};
   }
   repairStatus=null;repairWarning=null;
    if(config.timing?.verbose){
     const npc=s.entities.filter(e=>e.isNpc&&!e.isSelf&&e.npcEntityType!=="concord");
     const typed=npc.filter(isMiningDefenderTarget),qualified=typed.filter(e=>eligibleHostile(e,centers));
     const reason=!centers.length?"miner-positions-unavailable":qualified.length?"eligible-hostile":!npc.length?"no-hostile-in-native-scene":
      !typed.length?"native-npc-filtered":typed.some(e=>e.hullRatio!==0)?"outside-miner-escort-area":"only-destroyed-hostiles";
     const targetID=qualified[0]?.itemID??typed[0]?.itemID??npc[0]?.itemID;
     config.timing.change("defender-hostile-observation",reason+":"+targetID,
      {reason,targetID,visibleNpcCount:npc.length,qualifiedCount:qualified.length,minerCount:centers.length,sceneSampledAtMs:s.sampledAtMs});
    }
   const nativeFollow=followTarget(s);
   const followingMiner=peers.some(peer=>peer.itemID===nativeFollow);
   const nativeHostile=s.entities.find(e=>e.itemID===nativeFollow&&isMiningDefenderTarget(e));
   const chaseID=followingMiner?undefined:movement?.pursuit?movement.target:nativeHostile?.itemID;
   const chased=s.entities.find(e=>e.itemID===chaseID),outside=!inEscort(s.ship!.position,centers);
   const hostile=s.entities.some(e=>eligibleHostile(e,centers));
   const invalidPursuit=chaseID!==undefined&&(!chased||!eligibleHostile(chased,centers)||
    !coveredApproach(s.ship!,chased,movement?.pursuit?movement.range:s.ship!.followRange??0,centers));
   const closing=movement?.accepted&&followsAtRange(s,movement.target,movement.range)?movement:null;
   const destination=closing&&s.entities.find(row=>row.itemID===closing.target&&
    (closing.pursuit?row===chased&&!outside&&!invalidPursuit:peers.includes(row)));
   servicePropulsion(s,!!closing&&!!destination&&s.ship!.capacitorRatio!==null&&
    surface(s.ship!,destination)-closing.range>PROP_GAP_M);
   fighter.serviceDefense(identity,s,hostile&&!outside);
   if(!centers.length){
    if(movement||chaseID!==undefined)await stopApproach(s.ship?.mode);
    return "regroup-wait" as const;
   }
   if(invalidPursuit||outside&&!followingMiner&&movement?.pursuit!==false)await stopApproach(s.ship?.mode);
   if(outside||invalidPursuit&&!hostile){
    regrouping=true;
    const result=await regroup(s);
    await settleOffense(s);
    return result??"watching" as const;
   }
   const serviceRepair=async()=>{
    try{
     const support=await repair?.tick(s)??null;guard();
     repairStatus=support?.active?"Native "+support.active+" cycle observed.":support?.waiting??null;
     repairWarning=support?.warning??repairWarning;
     return support;
    }catch(error){guard();repairWarning=error instanceof Error?error.message:String(error);return null;}
   };
   const prioritizeRepair=!hostile||repair?.urgent(s)===true;
   const support=prioritizeRepair?await serviceRepair():null;
   const repairPhase=support?.active?"repairing":support?.waiting?"repair-wait":"logistics-watch";
   if(!hostile){
    const phase=repair?.capable()?repairPhase:"watching";
    if(!regrouping&&!fighter.dirty)return support?.urgent?phase:await regroup(s)??phase;
    const focus=s.entities.find(e=>e.itemID===fighter.focus());
    if(focus&&!eligibleHostile(focus,centers))clearCount=2;
    else if(s.sampledAtMs!==null&&(lastClearSample===null||s.sampledAtMs>lastClearSample)){
     lastClearSample=s.sampledAtMs;clearCount++;
    }
    if(clearCount<2)return "checking-grid" as const;
    const result=support?.urgent?phase:await regroup(s);
    await settleOffense(s);
    return result??phase;
   }
   clearCount=0;lastClearSample=null;regrouping=true;
    if(support?.urgent){
     config.timing?.change("defender-combat-decision","repair",{reason:"urgent-fleet-repair"});
     return repairPhase;
    }
   try{
     const result=await timed(config.timing,"defender-fighter-step",()=>fighter.tick(identity,guard,s),undefined,15000);guard();
     config.timing?.change("defender-combat-decision",result??"no-action",{reason:result??"no-action-after-combat-read"});
     if(!prioritizeRepair&&repair?.capable())await serviceRepair();
    return result==="engaged"?"responding" as const:result??(repair?.capable()?repairPhase:"watching");
   }catch(error){if(!(error instanceof SecurityTargetUnobserved))throw error;guard();return "waiting-lock" as const;}
  });},
  repairStatus:()=>repairStatus,warning:()=>[repairWarning,movementWarning,warning].filter(Boolean).join(" ")||null,droneIDs:fighter.droneIDs,
  async stop(allowDeferredRecall=false){
   stopping=true;deferRecall=allowDeferredRecall;
   if(work)try{await work;}catch{/* original outcome stays fenced in the fighter */}
   current();
   if(movement){
    const f=await flight();current();
    if(f.inSpace&&f.shipMode?.toUpperCase()==="FOLLOW"){
     try{await session.flow.stopShip();}catch(error){current();warning=error instanceof Error?error.message:String(error);}
    }
    movement=null;
   }
   await propulsionWork;await fighter.settle(current);current();
  },
 };
}
