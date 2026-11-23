import {randomUUID} from "node:crypto";
import type {MiningTravelAssist} from "./travelAssist.ts";
import {createHaulerTelemetry} from './haulerTelemetry.ts';
import {provesHaulSource} from "./haulEvidence.ts";
import type {CompressionReceipt} from "./support/compressionController.ts";
import {decodeFleetDelivery,type FleetDelivery} from "./delivery.ts";
import {decodeFlightStatus,decodeSpaceSnapshot,getFlightStatus,getSpaceSnapshot,moveItems,undock} from "../../../web/src/plugin-api/flying.ts";
import type {PluginRunContext} from "../../../web/src/plugin-api/backend.ts";
import type {PilotSession} from "../../../web/src/plugin-api/pilotSession.ts";
import type {GridJetcan,Manifest,ManifestItem} from "./operation.ts";
import type {Target,Claim} from "./targetBoard.ts";
import {checkedInventory,readNativeShipHolds,type NativeInventoryRow} from "./nativeInventory.ts";
import {createRawTypeFacts} from "./typeFacts.ts";
import { isLootableContainer, lootRightsGrant } from "../compat/flying.ts";
import {readJettisonCapacity} from "./canCapacity.ts";
import {unloadParkingFreight} from "./parkingUnload.ts";
import {createHaulJournal,type HaulDocument} from "./haulJournal.ts";
import {createDockedRawDepositIO,readDepositInventory} from "./dockedRawDeposit.ts";
import {readMiningReadiness,type FlightObservation} from "./nativeBelt.ts";
import {FreightGridUnavailable,GlobalLootClaimHeld,HaulStoppedBeforePickup,type HaulWork,type PickupGridObservation} from "./memberLoops.ts";
import {bridgeCallQueueTimeout,readAfterTimeout,transientNativeRead,progressDeadline,routeFlightObservation,travelFacts} from "../shared/progressDeadline.ts";
import {fleetReadFailed,FleetObservationUnavailable,FleetShipChanged} from "./stopSignal.ts";
import {timed,type MccTiming} from "./timing.ts";
import {createHaulerModules} from "../logistics/haulerModules.ts";

export type NativePoint={x:number;y:number;z:number};
export type RelocatedSourceProof={kind:"relocated-manifest-items";items:readonly {itemID:number;typeID:number;quantity:number;ownerID:number;locationID:number;flagID:number}[];observedAt:number};
export type CanAbsenceProof={kind:"can-absent";containerID:number;systemID:number;shipID:number;canOwnerID:number;canKind:"container";transferCan:{position:NativePoint;radius:number};transferShip:{position:NativePoint;radius:number};transferSampledAt:number;postShip:{position:NativePoint;radius:number};postSampledAt:number};
type PickupItem={itemID:number;typeID:number;quantity:number};
export type HaulBatchProof={sourceBefore:readonly NativeInventoryRow[];shipBefore:readonly NativeInventoryRow[];shipAfter:readonly NativeInventoryRow[];itemID:number;typeID:number;quantity:number;items?:readonly PickupItem[];flagID?:number;sourceAfter:readonly NativeInventoryRow[]|null;canAbsence:CanAbsenceProof|null};
export type NativeHaulSourceProof=RelocatedSourceProof|{kind:"native-batches";batches:readonly HaulBatchProof[]};
export type NativeDeliveryBatch={tripID?:string;conversion?:CompressionReceipt;item:PickupItem;items?:readonly PickupItem[];sourceBefore:readonly NativeInventoryRow[];sourceAfter:readonly NativeInventoryRow[];destinationBefore:readonly NativeInventoryRow[];destinationAfter:readonly NativeInventoryRow[]};
export type NativeHaulDelivery={source:"native-transfer";operationID:string;runID:string;containerID:number;claimGeneration:number;shipID:number;destinationID:number;
 sourceProof:NativeHaulSourceProof;destinationBefore:readonly NativeInventoryRow[];destinationAfter:readonly NativeInventoryRow[];deliveryBatches?:readonly NativeDeliveryBatch[];observedAt:number};
export type RelocatedDelivery=NativeHaulDelivery & {sourceProof:RelocatedSourceProof};
export const HAULER_OWN_DEPOSIT_PREFIX="mining-fleet-haul-own-freight:";
type Run=Pick<PluginRunContext,"characterID"|"baseUrl"|"fetch">;
const positive=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>0;
const totals=(rows:readonly {typeID:number;quantity:number}[])=>{const out=new Map<number,number>();for(const r of rows){const n=(out.get(r.typeID)??0)+r.quantity;if(!positive(r.typeID)||!positive(r.quantity)||!Number.isSafeInteger(n))throw Error("Freight quantities are invalid.");out.set(r.typeID,n);}return out;};
const equal=(a:Map<number,number>,b:Map<number,number>)=>a.size===b.size&&[...a].every(([id,q])=>b.get(id)===q);
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export const HAULER_DELIVERY_FRACTION=0.90;
const sameRows=(a:readonly NativeInventoryRow[],b:readonly NativeInventoryRow[])=>a.length===b.length&&a.every(r=>
 b.some(x=>x.itemID===r.itemID&&x.typeID===r.typeID&&x.quantity===r.quantity&&x.flagID===r.flagID&&x.ownerID===r.ownerID&&x.locationID===r.locationID));
export function pickupItems(batch:PickupItem&{items?:readonly PickupItem[]}){
 return batch.items??[{itemID:batch.itemID,typeID:batch.typeID,quantity:batch.quantity}];
}
function pickupRemainder<T extends PickupItem>(rows:readonly T[],batch:Parameters<typeof pickupItems>[0]):T[]{
 const items=pickupItems(batch),deductions=new Map(items.map(i=>[i.itemID,i]));
 if(!items.length||deductions.size!==items.length||items.some(i=>!positive(i.quantity)||
  !rows.some(r=>r.itemID===i.itemID&&r.typeID===i.typeID&&r.quantity>=i.quantity)))throw Error("Recorded pickup quantity is invalid.");
 return rows.flatMap(r=>{
  const i=deductions.get(r.itemID);
  return !i?[r]:r.quantity===i.quantity?[]:[{...r,quantity:r.quantity-i.quantity}];
 });
}
export function pickupHoldMatches(batch:HaulBatchProof,flagID:number){
 const inHold=(rows:readonly NativeInventoryRow[])=>rows.filter(r=>r.flagID===flagID);
 const expected=totals([...inHold(batch.shipBefore),...pickupItems(batch)]);
 return sameRows(batch.shipBefore.filter(r=>r.flagID!==flagID),batch.shipAfter.filter(r=>r.flagID!==flagID))&&
  equal(expected,totals(inHold(batch.shipAfter)));
}
function subtractDelivery(aboard:NativeInventoryRow[],before:{item:PickupItem;sourceBefore:readonly NativeInventoryRow[]}){
 const {item}=before,flag=before.sourceBefore.find(r=>r.itemID===item.itemID&&r.typeID===item.typeID)?.flagID;
 let left=item.quantity;
 for(let i=0;i<aboard.length&&left;){
  const row=aboard[i]!;
  if(row.typeID!==item.typeID||row.flagID!==flag){i++;continue;}
  const used=Math.min(left,row.quantity);left-=used;
  if(used===row.quantity)aboard.splice(i,1);
  else aboard[i++]={...row,quantity:row.quantity-used};
 }
 if(left)throw Error("Recorded delivery does not match a collected batch.");
}
function pickedStack(batch:HaulBatchProof){
 const before=new Map(batch.shipBefore.map(r=>[r.itemID,r]));
 const gained=batch.shipAfter.filter(r=>r.quantity!==(before.get(r.itemID)?.quantity??0));
 const row=gained[0],prior=row&&before.get(row.itemID);
 if(gained.length!==1||!row||row.typeID!==batch.typeID||row.quantity-(prior?.quantity??0)!==batch.quantity||
   prior&&(prior.typeID!==row.typeID||prior.flagID!==row.flagID||prior.ownerID!==row.ownerID||prior.locationID!==row.locationID)||
   !sameRows(batch.shipBefore.filter(r=>r.itemID!==row.itemID),batch.shipAfter.filter(r=>r.itemID!==row.itemID)))
  throw Error("The exact cargo stack changed during pickup.");
 return {...row,quantity:batch.quantity};
}
/** Reconcile a dock already observed at the exact destination without sending commands. */
export async function waitForHaulerDockSettlement<T extends {docked:boolean;stationID?:number|null;structureID?:number|null;transition?:{phase:string}|null}>(initial:T,destinationID:number,read:()=>Promise<T|null>,options:{timeoutMs:number;pollMs:number;now?:()=>number;wait?:(ms:number)=>Promise<void>}):Promise<T>{
 const now=options.now??Date.now,wait=options.wait??delay,end=now()+options.timeoutMs;let status:T|null=initial,sawPending=false;
 while(true){if(status){if(!status.docked||(status.stationID??status.structureID)!==destinationID)throw Error('Destination dock identity is uncertain.');if(status.transition?.phase==='ready'||!sawPending&&!status.transition)return status;sawPending=true;}
  if(now()>=end)throw new FleetObservationUnavailable('Destination dock transition remains unknown.');await wait(options.pollMs);status=await read();}
}
/** Held-session freight adapter for hauling trips and single-can command collection. */
type PickupClaimScope=Pick<Manifest,"containerID"|"systemID">;
export function createNativeHauler(run:Run,session:PilotSession,config:{shipID:number;corporationID?:number;division?:number;delivery?:FleetDelivery;travelAssist?:MiningTravelAssist;localDefense?:boolean;convertFreight?:(item:{itemID:number;typeID:number;quantity:number;flagID:number},manifest:Manifest,generation:number)=>Promise<CompressionReceipt|null>;recoverConversion?:(item:{itemID:number;typeID:number;quantity:number;flagID:number},manifest:Manifest,generation:number)=>Promise<CompressionReceipt|null>;current:()=>void;observeFlight?:FlightObservation;navigateToTarget?:(target:Target,claim:Claim,current?:()=>void)=>Promise<void>;claimPickup?:(manifest:PickupClaimScope)=>Promise<void>;pickupClaimCurrent?:(manifest:PickupClaimScope)=>boolean;stopBeforePickup?:()=>boolean;returnHome?:()=>boolean;afterPickup?:(manifest:Manifest)=>Promise<void>;releasePickup?:(manifest:Pick<Manifest,"containerID"|"systemID">)=>Promise<void>;deliveryFraction?:number;gridLootFleet?:()=>{fleetID?:number;memberIDs?:readonly number[]};ownFreight?:{operationID:string;runID:string;document:HaulDocument};timeoutMs?:number;pollMs?:number;timing?:MccTiming;tripDocument?:(manifest:Manifest,generation:number)=>HaulDocument}){
 const {shipID,corporationID,division,current,timing}=config;const delivery=config.delivery===undefined?null:decodeFleetDelivery(config.delivery);if(!positive(shipID)||config.delivery!==undefined&&(!delivery||delivery.corporationID===null&&(corporationID!==undefined||division!==undefined)||delivery.corporationID!==null&&(corporationID!==delivery.corporationID||division!==delivery.division))||!(delivery?.corporationID===null)&&(!positive(corporationID)||!positive(division)||division>7))throw Error("Hauler identity or corporation division is invalid.");
 const options={...session.flow.requestOptions(),baseUrl:run.baseUrl,fetch:run.fetch},f=session.flow.flying;
 const poll=config.pollMs??1500,timeout=config.timeoutMs??180000,deliveryFraction=config.deliveryFraction??HAULER_DELIVERY_FRACTION;
 if(!Number.isFinite(deliveryFraction)||deliveryFraction<=0||deliveryFraction>1)throw Error("Invalid haul delivery threshold.");
 const guard=()=>{current();if(session.store.station.get().online?.characterID!==run.characterID)throw Error("Hauler pilot changed.");};
 const freightCurrent=()=>{guard();if(config.returnHome?.())throw new HaulStoppedBeforePickup();};
 const modules=config.localDefense?createHaulerModules(session,run.characterID):undefined;
 const serviceRouteModules=(status:{inSpace:boolean;solarSystemID:number|null})=>{
  const sample=modules&&status.inSpace?session.store.space.get().snapshot:null;
  if(sample?.shipID===shipID&&sample.solarSystemID===status.solarSystemID)modules?.(sample,null,freightCurrent);
 };
  const flight=async()=>{guard();const startedAt=Date.now(),x=decodeFlightStatus((await getFlightStatus(options).catch(fleetReadFailed)).flight);guard();config.observeFlight?.(x,startedAt);if(!positive(x.shipID))throw new FleetObservationUnavailable("Hauler ship is temporarily unreadable.");if(x.shipID!==shipID)throw new FleetShipChanged("Hauler ship changed.",x.shipIsCapsule===true);return x;};
  const routeStopped=(label:string,progress:ReturnType<typeof f.autopilotProgress>)=>{
   if(!progress||!["error","paused","aborted"].includes(progress.status))return;
   const reason=progress.failureReason??"Autopilot stopped.";
   if(progress.status==="paused"&&reason.startsWith("Could not read flight status after "))
    throw new FleetObservationUnavailable(`${label}: ${reason}`);
   throw Error(`${label}: ${reason}`);
  };
 const settledDock=async(status:Awaited<ReturnType<typeof flight>>,destinationID:number)=>waitForHaulerDockSettlement(status,destinationID,async()=>{guard();let raw;try{raw=await getFlightStatus(options);}catch{guard();return null;}guard();let x;try{x=decodeFlightStatus(raw.flight);}catch{return null;}guard();if(x.shipID!==shipID)throw Error("Hauler ship changed.");return x;},{timeoutMs:Math.min(timeout,90000),pollMs:poll});
 let pickupBelt:Claim|null=null,dockTripID:string|undefined;
 const destination=async(destinationID:number,retainedTripID?:string)=>{freightCurrent();pickupBelt=null;await config.travelAssist?.settle();let status=await flight();freightCurrent();if(status.docked&&(status.stationID??status.structureID)===destinationID){await settledDock(status,destinationID);return dockTripID??=retainedTripID??randomUUID();}
  dockTripID=undefined;
  if(status.shipMode?.toUpperCase()==="WARP")throw new FleetObservationUnavailable("Delivery warp is still in progress; checking the current ship on the next pass.");
  const progressing=progressDeadline(timeout);progressing(travelFacts(status,null));
   const route=await session.flow.startRoute(destinationID);
   if(!route.started)fleetReadFailed(new Error(`Delivery route refused: ${route.reason}`,{cause:route.cause}));
   const observe=routeFlightObservation(session,shipID),arrived=(s:typeof status)=>s.docked&&(s.stationID??s.structureID)===destinationID;
   let dockAsked=false;
   try{while(true){
    freightCurrent();const progress=f.autopilotProgress(),shared=observe(progress);
    status=shared.read||shared.flight&&arrived(shared.flight)?await flight():shared.flight??status;
    freightCurrent();if(arrived(status)){await settledDock(status,destinationID);return dockTripID=randomUUID();}
    serviceRouteModules(status);
    routeStopped("Delivery route stopped",progress);
    if(!progressing(travelFacts(status,progress)))throw new FleetObservationUnavailable("Delivery route made no observable progress; rechecking the ship before replanning.");
    if(progress?.status==="arrived"&&!dockAsked){dockAsked=true;await f.dockStep(destinationID);freightCurrent();}
    await delay(poll);
   }}catch(error){f.abortAutopilot();throw error;}};
 const scene=async(complete=false)=>{guard();const raw=(await getSpaceSnapshot(options).catch(fleetReadFailed)).space;guard();
 const entities=(raw as {entities?:{itemID?:unknown}[]}|null)?.entities;
 if(complete&&(!Array.isArray(entities)||entities.some(e=>!positive(e?.itemID))))throw Error("Hauler grid is incomplete.");
 const x=decodeSpaceSnapshot(raw);if(x.stateValid===false||!x.inSpace||x.shipID!==shipID||x.ship?.itemID!==shipID||(x.ship.characterID!=null&&x.ship.characterID!==run.characterID)||!x.ship.geometryAvailable||!Number.isFinite(x.sampledAtMs))throw Error("Hauler scene is uncertain.");
 modules?.(x,null,freightCurrent);return x;};
 const read=async(id:number,flag:number|null)=>{guard();await f.bridgeDo("invCache","InvalidateLocationCache",[id]).catch(fleetReadFailed);guard();const raw=await f.bridgeAsk("invbroker","List",[],flag===null?null:{flag},id).catch(fleetReadFailed);guard();const rows=checkedInventory(raw);if(rows.some(r=>r.locationID!==id||(flag!==null&&r.flagID!==flag)))throw Error("Inventory location or flag is uncertain.");return rows;};
 const telemetry=createHaulerTelemetry();
 const cargo=async():Promise<readonly NativeInventoryRow[]>=>{
  const rows=await readNativeShipHolds(session,guard,run.characterID,shipID).catch(fleetReadFailed);
  telemetry.cargo(rows);return rows;
 };
 const expected=(manifest:Manifest)=>totals(manifest.items);
 const lootable=(can:Awaited<ReturnType<typeof scene>>["entities"][number])=>{
  const online=session.store.station.get().online;
  const fleet=config.gridLootFleet?.();
  const who={characterID:run.characterID,corporationID:online?.corporationID??null,fleetID:fleet?.fleetID,fleetMemberIDs:fleet?.memberIDs};
  return isLootableContainer(can,who)||lootRightsGrant(can,who);
 };
 const canRows=async(manifest:Manifest)=>{const rows=await read(manifest.containerID,null);if(rows.some(r=>r.ownerID!==manifest.characterID)||!equal(totals(rows),expected(manifest)))throw Error("Claimed container differs from its published manifest.");return rows;};
 const exactSceneCan=(s:Awaited<ReturnType<typeof scene>>,m:Pick<Manifest,"source"|"containerID"|"systemID"|"characterID">)=>{if(s.solarSystemID!==m.systemID)throw Error("Hauler is outside the claimed system.");const matches=s.entities.filter(e=>e.itemID===m.containerID);if(matches.length!==1)return null;const can=matches[0]!;if(can.kind!=="container"||can.ownerID!==m.characterID||!can.geometryAvailable||m.source==="observed-jetcan"&&can.typeID!==23)throw Error("Claimed container identity or position is uncertain.");const p=can.position,q=s.ship!.position;return Math.max(0,Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)-can.radius-s.ship!.radius);};
 type Grid=Awaited<ReturnType<typeof scene>>;
 type PickupObservation=PickupGridObservation&{flight?:Awaited<ReturnType<typeof flight>>};
 type ReachedCan={grid:Grid;local:boolean;observedAt:number};
 const followTarget=(grid:Grid)=>grid.ship?.mode?.toUpperCase()==="FOLLOW"?
  grid.entities.find(entity=>entity.itemID===shipID)?.targetEntityID:null;
 const freshRange=(arrival:PickupGridObservation)=>performance.now()-arrival.observedAt<=1500;
  let scannedPickup:{scope:PickupClaimScope&{characterID:number;targetKey:string;claimGeneration:number};rows:readonly NativeInventoryRow[];observedAt:number;arrival:ReachedCan;pendingPickup?:boolean}|undefined;
  const claimCurrent=(scope:PickupClaimScope)=>config.pickupClaimCurrent?.(scope)!==false;
  const releasePickup=async(scope:PickupClaimScope)=>{
   try{await config.releasePickup?.(scope);}catch{/* The existing WC lease can expire; no ore outcome depends on release. */}
  };
 const reach=async(manifest:Pick<Manifest,"source"|"containerID"|"systemID"|"characterID"|"targetKey"|"claimGeneration">,target:Target,claim:Claim,allowMissing=false,observation?:PickupObservation,stillDiscovering?:()=>boolean):Promise<ReachedCan|"missing">=>{
  const current=()=>{freightCurrent();if(stillDiscovering&&!stillDiscovering())throw new HaulStoppedBeforePickup();};
  let status=observation&&freshRange(observation)&&observation.flight?observation.flight:await flight();current();
  const flightAt=performance.now();
  const alreadyLocal=status.inSpace&&!status.docked&&status.solarSystemID===manifest.systemID;
  if(status.docked){await undock(f.bridgeDo,f.readFlightNow,false);freightCurrent();status=await flight();}
  if(!status.inSpace)throw Error("Hauler is not ready in space.");
  if(status.solarSystemID!==manifest.systemID){freightCurrent();
   if(status.shipMode?.toUpperCase()==="WARP")throw new FleetObservationUnavailable("Hauler warp is still in progress; checking the current ship before replanning.");
   const progressing=progressDeadline(timeout);progressing(travelFacts(status,null));
    const route=await session.flow.startRoute(manifest.systemID);
    if(!route.started)fleetReadFailed(new Error(`Mining-system route refused: ${route.reason}`,{cause:route.cause}));
    const observe=routeFlightObservation(session,shipID),arrived=(s:typeof status)=>s.inSpace&&s.solarSystemID===manifest.systemID;
    try{while(true){
     freightCurrent();const progress=f.autopilotProgress(),shared=observe(progress);
     status=shared.read||shared.flight&&arrived(shared.flight)?await flight():shared.flight??status;
     freightCurrent();if(arrived(status)){f.abortAutopilot();break;}
     serviceRouteModules(status);
     routeStopped("Mining-system route stopped",progress);
     if(!progressing(travelFacts(status,progress)))throw new FleetObservationUnavailable("Mining-system route made no observable progress; rechecking the ship before replanning.");
     await delay(poll);
    }}
   catch(error){f.abortAutopilot();throw error;}}
  const readGrid=async<T>(read:()=>Promise<T>)=>{try{return await read();}catch(error){
   guard();if(!allowMissing)throw error;
   throw new FreightGridUnavailable("Pickup grid could not be read. Checking again before judging the can absent.",{cause:error});
  }};
  const sample=observation&&freshRange(observation)&&observation.grid.solarSystemID===status.solarSystemID?
   observation:{grid:await readGrid(scene),observedAt:performance.now()};
  const s=sample.grid;
  const distance=exactSceneCan(s,manifest);
  const inRange=async(grid:Grid,meters:number,observedAt:number):Promise<ReachedCan>=>{
   timing?.change("hauler-pickup-range",manifest.containerID,{containerID:manifest.containerID,meters:Math.round(meters),sceneSampledAtMs:grid.sampledAtMs});
   await config.travelAssist?.settle();current();
   return {local:alreadyLocal&&distance!==null,grid,observedAt};
  };
  const transition=status.transition;
  if(alreadyLocal&&distance!==null&&distance<=2000&&performance.now()-flightAt<=1500&&
     transition?.phase==="ready"&&transition.sessionStable&&transition.locationReady&&transition.sceneReady&&
     transition.egoReady&&transition.shipReady&&transition.boundContextReady&&
     status.shipMode&&status.shipMode.toUpperCase()!=="WARP"&&s.ship?.mode&&s.ship.mode.toUpperCase()!=="WARP"&&!s.ship.warp)
   return inRange(s,distance,sample.observedAt);
  let readyAtSite:Awaited<ReturnType<typeof readMiningReadiness>>|undefined;
  if(distance===null){
   if(stillDiscovering)return "missing" as const;
   if(!config.navigateToTarget)throw Error("Saved freight target navigation is unavailable.");
   pickupBelt=null;await config.travelAssist?.settle();freightCurrent();
   try{await config.navigateToTarget(target,claim);}catch(error){
    guard();
    if(allowMissing&&transientNativeRead(error))throw new FreightGridUnavailable("Waiting to recheck the saved pickup grid.",{cause:error});
    throw error;
   }
   freightCurrent();
   if(allowMissing){
    const arrived=await readGrid(()=>readMiningReadiness(run,session,shipID,manifest.systemID,guard));
    const raw=arrived.raw as {entities?:{itemID?:unknown}[]}|null;
    if(!arrived.ready||arrived.space.sampledAtMs!<=s.sampledAtMs!||!Array.isArray(raw?.entities)||raw.entities.some(row=>!positive(row?.itemID)))
     throw new FreightGridUnavailable("Waiting for a fresh, complete pickup grid.");
    if(!raw.entities.some(row=>row.itemID===manifest.containerID))return "missing" as const;
    readyAtSite=arrived;
   }
  }
  let end=Date.now()+timeout,approached=false;
  for(;;){
   const ready=readyAtSite??await readGrid(()=>readMiningReadiness(run,session,shipID,manifest.systemID,guard,timing,"hauler-pickup-flight"));current();
   readyAtSite=undefined;
   if(ready.ready){
    modules?.(ready.space,null,current);
    const checked=exactSceneCan(ready.space,manifest);
    if(checked===null&&stillDiscovering)return "missing" as const;
    if(checked===null&&allowMissing)throw new FreightGridUnavailable("The can left the pickup scene. Checking the saved grid again.");
    if(checked!==null&&checked<=2000)return inRange(ready.space,checked,ready.observedAt);
    if(Date.now()<end&&checked!==null&&!approached&&followTarget(ready.space)!==manifest.containerID){
     await config.travelAssist?.beforeApproach(`${manifest.targetKey}:${manifest.claimGeneration}:${manifest.containerID}`,checked,1000,manifest.containerID);
     current();await timed(timing,"hauler-pickup-approach",()=>f.approachShip(manifest.containerID,1000),{containerID:manifest.containerID,meters:Math.round(checked)});
     guard();approached=true;end=Date.now()+timeout;
    }
   }
   if(Date.now()>=end)throw new FleetObservationUnavailable("Waiting for the claimed container to reach transfer range.");
   await delay(poll);
  }};
 const readFacts=createRawTypeFacts(run,guard);
 const facts:typeof readFacts=async ids=>{
  const value=await readFacts(ids);
  telemetry.facts(value);return value;
 };
 const readHoldPanel=async()=>{guard();const response=await run.fetch(new URL("/api/bridge/ship/ore-hold",run.baseUrl)).catch(fleetReadFailed);
  const panel=await response.json().catch(error=>response.ok?fleetReadFailed(error):null);guard();
  if(!response.ok)fleetReadFailed(Object.assign(Error(panel?.message??"Hauler holds are unreadable."),{code:panel?.error,status:response.status}));
  if(panel?.ok!==true||panel.activeShipID!==shipID||!Array.isArray(panel.holds))throw Error("Hauler holds are unreadable.");
  return panel;
 };
 const chooseHold=async(manifest:Pick<Manifest,"items"|"category">&Partial<Pick<Manifest,"targetKey">>,afterUnload=false,requiredFlag?:number)=>
  holdFromPanel(manifest,(await readHoldPanel()).holds,afterUnload,requiredFlag);
 const holdFromPanel=async(manifest:Pick<Manifest,"items"|"category">&Partial<Pick<Manifest,"targetKey">>,holds:any[],afterUnload=false,requiredFlag?:number)=>{
  const types=await facts(manifest.items.map(i=>i.typeID));guard();
  for(const i of manifest.items){const t=types[i.typeID];if(!t||t.categoryID!==25||t.freightKind!==manifest.category||i.freightKind!==manifest.category||t.unitVolumeM3!==i.unitVolumeM3)throw Error("Freight is not verified raw ore.");}
  const families=new Set(manifest.items.map(i=>types[i.typeID]?.resourceFamily));if(families.size!==1||(!families.has("ore")&&!families.has("ice"))||
   manifest.targetKey!==undefined&&!families.has(manifest.targetKey.startsWith("ICE:")?"ice":"ore"))
   throw Error("Freight resource family is ambiguous or differs from the pickup site.");const choices:readonly (readonly ["ore"|"ice"|"asteroid"|"cargo",number])[]=families.has("ice")?[["ice",181],["ore",134],["cargo",5]]:[["asteroid",182],["ore",134],["cargo",5]];
  telemetry.capacity(holds,families.has("ice")?"ice":"ore");
  let unreadable: string|undefined;
  for(const [key,flag] of choices){
   if(requiredFlag!==undefined&&flag!==requiredFlag)continue;
   const found=holds.filter(h=>h?.key===key);
   if(found.length===0&&requiredFlag===undefined&&(key==="ice"||key==="asteroid"))continue;
   if(found.length!==1){unreadable??="Hauler hold identity is unreadable.";continue;}
   const h=found[0];
   if(h.error!==null||typeof h.present!=="boolean"||!h.capacity||!Number.isFinite(h.capacity.capacity)||!Number.isFinite(h.capacity.used)||h.capacity.capacity<0||h.capacity.used<0||h.capacity.used>h.capacity.capacity){
    unreadable??="Hauler hold capacity is unreadable.";
    continue;
   }
   const free=afterUnload?h.capacity.capacity:h.capacity.capacity-h.capacity.used;
   if(h.present&&manifest.items.some(i=>i.unitVolumeM3<=free+1e-9))return {key,flag,free,used:Number(h.capacity.used),capacity:Number(h.capacity.capacity)};}
  if(unreadable)throw new FleetObservationUnavailable(unreadable);
  return null;};
 const journal=(m:Manifest,generation:number)=>{if(!config.tripDocument)throw Error("Durable haul journal is required before inventory mutation.");return createHaulJournal(config.tripDocument(m,generation),m,shipID,generation);};
 const verifyRaw=async(m:Manifest)=>{const types=await facts(m.items.map(i=>i.typeID));guard();for(const i of m.items){const t=types[i.typeID];if(i.freightKind!==m.category||!t||t.categoryID!==25||t.freightKind!==m.category||t.resourceFamily!==(m.targetKey.startsWith("ICE:")?"ice":"ore")||t.unitVolumeM3!==i.unitVolumeM3)throw Error("Freight is not verified raw ore or ice for the claimed target.");}};
 async function recovery(manifest:Manifest,generation:number,destinationID:number):Promise<NativeHaulDelivery>{
  if(!["RAW","COMPRESSED"].includes(manifest.category)||!positive(generation)||!positive(destinationID)||!manifest.items.length||new Set(manifest.items.map(i=>i.itemID)).size!==manifest.items.length)throw Error("Relocated haul scope is invalid.");
  const j=journal(manifest,generation),pending=j.snapshot().pending;if(pending&&pending.kind!=="pickup")throw Error("Unresolved delivery mutation; no replay.");
  await verifyRaw(manifest);const rawFacts=await facts(manifest.items.map(i=>i.typeID));
  const events=j.snapshot().events,pickups=events.filter(e=>e.kind==="pickup"),deliveries=events.filter(e=>e.kind==="delivery");if(!pending&&config.recoverConversion&&pickups.length===1&&!deliveries.length){const pickup=(pickups[0]!.after as any)?.batch as HaulBatchProof|undefined,proof:NativeHaulSourceProof={kind:"native-batches",batches:pickup?[pickup]:[]};if(pickup&&provesHaulSource(manifest,run.characterID,shipID,proof,Date.now())){const taken=pickup.shipAfter.filter(r=>r.typeID===pickup.typeID&&!pickup.shipBefore.some(b=>b.itemID===r.itemID));if(taken.length===1){const conversion=await config.recoverConversion(taken[0]!,manifest,generation);guard();if(conversion){const held=await cargo(),row=held.find(r=>r.itemID===conversion.output.itemID);if(!row||row.ownerID!==run.characterID||row.locationID!==shipID||row.typeID!==conversion.output.typeID||row.quantity!==conversion.output.quantity||row.flagID!==conversion.output.flagID)throw Error("Converted retained freight is not physically verified.");const tripID=await destination(destinationID);const io=await createDockedRawDepositIO(run,session,{characterID:run.characterID,shipID,destinationID,...(corporationID===undefined?{}:{corporationID}),...(division===undefined?{}:{division}),...(delivery?{delivery}:{}),freightKind:"COMPRESSED",current:guard}),batch=await io.deposit(row,taggedDeposit(j,tripID));return {source:"native-transfer",operationID:manifest.operationID,runID:manifest.runID,containerID:manifest.containerID,claimGeneration:generation,shipID,destinationID,sourceProof:proof,destinationBefore:batch.destinationBefore,destinationAfter:batch.destinationAfter,deliveryBatches:[{...batch,conversion,tripID}],observedAt:Date.now()};}}}}
  const initial=await cargo(),byId=new Map(initial.map(x=>[x.itemID,x]));
  if(manifest.items.some(i=>{const r=byId.get(i.itemID);return !r||r.ownerID!==run.characterID||r.locationID!==shipID||!(r.flagID===5||r.flagID===134&&["ore","ice"].includes(rawFacts[i.typeID]?.resourceFamily??"")||r.flagID===181&&rawFacts[i.typeID]?.resourceFamily==="ice")||r.typeID!==i.typeID||r.quantity!==i.quantity;}))throw Error("Exact full manifest items are not proven in the hauler hold.");
  const relocated=manifest.items.map(i=>{const r=byId.get(i.itemID)!;return {itemID:r.itemID,typeID:r.typeID,quantity:r.quantity,ownerID:r.ownerID,locationID:r.locationID,flagID:r.flagID};});
  let proof:RelocatedSourceProof={kind:"relocated-manifest-items",items:relocated,observedAt:Date.now()};if(pending)j.reconcilePickup(proof);else proof=j.recordRelocation(proof) as RelocatedSourceProof;
  const tripID=await destination(destinationID);
  const io=await createDockedRawDepositIO(run,session,{characterID:run.characterID,shipID,destinationID,...(corporationID===undefined?{}:{corporationID}),...(division===undefined?{}:{division}),...(delivery?{delivery}:{}),freightKind:manifest.category,current:guard});
  let first:readonly NativeInventoryRow[]|null=null,last:readonly NativeInventoryRow[]|null=null;const deliveryBatches:NativeDeliveryBatch[]=[];
  for(const item of relocated){const batch=await io.deposit(item,taggedDeposit(j,tripID));deliveryBatches.push({...batch,tripID});first??=batch.destinationBefore;last=batch.destinationAfter;}
  if(!first||!last)throw Error("Relocated delivery evidence is unavailable.");

  return {source:"native-transfer",operationID:manifest.operationID,runID:manifest.runID,containerID:manifest.containerID,claimGeneration:generation,shipID,destinationID,sourceProof:proof,destinationBefore:first,destinationAfter:last,deliveryBatches,observedAt:Date.now()};
 }
 type Journal=ReturnType<typeof journal>;
 type Hold=NonNullable<Awaited<ReturnType<typeof chooseHold>>>;
 type PickupBefore={items?:readonly PickupItem[];containerID:number;sourceBefore:readonly NativeInventoryRow[];shipBefore:readonly NativeInventoryRow[];
  itemID:number;typeID:number;quantity:number;shipID:number;flagID:number;
  scene?:Pick<CanAbsenceProof,"transferCan"|"transferShip"|"transferSampledAt">};
 type DepositBefore=Parameters<Awaited<ReturnType<typeof createDockedRawDepositIO>>["reconcileDelivery"]>[0]&{tripID?:string};
 const taggedDeposit=(journal:Journal,tripID:string,current?:()=>void)=>({...journal,
  begin(kind:"delivery",before:unknown){current?.();journal.begin(kind,{...(before as DepositBefore),tripID});},
 });
 const requirePickup=()=>{freightCurrent();if(config.stopBeforePickup?.())throw new HaulStoppedBeforePickup();};
 const sourceBelongsToCan=(manifest:Manifest,rows:readonly NativeInventoryRow[])=>rows.every(r=>
  r.ownerID===manifest.characterID&&r.locationID===manifest.containerID&&r.flagID===0);
 const matchesSource=(manifest:Manifest,rows:readonly NativeInventoryRow[],items:readonly ManifestItem[])=>
  rows.length===items.length&&sourceBelongsToCan(manifest,rows)&&rows.every(r=>
   items.some(i=>i.itemID===r.itemID&&i.typeID===r.typeID&&i.quantity===r.quantity));
 const checkSource=(manifest:Manifest,rows:readonly NativeInventoryRow[],items:readonly ManifestItem[])=>{
  if(!matchesSource(manifest,rows,items))
   throw Error("Claimed container differs from its recorded freight.");
 };
 async function observePickup(manifest:Manifest,before:PickupBefore,acknowledged:boolean):Promise<HaulBatchProof>{
  const {sourceBefore,shipBefore,itemID,typeID,quantity,flagID}=before;
  if(before.containerID!==manifest.containerID||before.shipID!==shipID)throw Error("Original pickup scope is invalid.");
  const expected=pickupRemainder(sourceBefore,before);
  let sourceAfter:NativeInventoryRow[]|null=null,canAbsence:CanAbsenceProof|null=null,sourceError:unknown;
  // The native inventory normally removes a completely emptied can.
  // Use the same full-grid absence proof before trying to reopen it.
  let firstPost:Grid|null=null;
  if(!expected.length&&before.scene){
   const observed=await scene(true).catch(()=>null);guard();
   if(observed&&observed.solarSystemID===manifest.systemID&&observed.sampledAtMs!>before.scene.transferSampledAt&&
      !observed.entities.some(e=>e.itemID===manifest.containerID))firstPost=observed;
  }
  if(!firstPost)try{sourceAfter=await readAfterTimeout(()=>read(manifest.containerID,null));}
  catch(error){sourceError=error;if(expected.length||!before.scene)throw error;}
  const makeBatchEvidence=(shipAfter:readonly NativeInventoryRow[]):HaulBatchProof=>({sourceBefore,shipBefore,shipAfter,itemID,typeID,quantity,sourceAfter,canAbsence,...(before.items?{items:before.items,flagID}:{})});
  const makeBatch=(shipAfter:readonly NativeInventoryRow[]):HaulBatchProof=>{
   const batch=makeBatchEvidence(shipAfter);
   if(before.items){if(!pickupHoldMatches(batch,flagID))throw Error("Hauler hold conservation is uncertain.");}
   else if(pickedStack(batch).flagID!==flagID)throw Error("Hauler hold conservation is uncertain.");
   return batch;
  };
  if(sourceAfter!==null){
   const shipAfter=await readAfterTimeout(cargo);
   if(sameRows(sourceAfter,expected))return makeBatch(shipAfter);
   if(acknowledged&&before.items&&before.items.length>1){
    // MultiAdd may skip individual stacks. Only the matching native source
    // and hold deltas can retire the original request.
    const moved=before.items.flatMap(item=>{
     const prior=sourceBefore.find(r=>r.itemID===item.itemID)!;
     const after=sourceAfter!.find(r=>r.itemID===item.itemID);
     const quantity=prior.quantity-(after?.quantity??0);
     return quantity>0&&quantity<=item.quantity?[{...item,quantity}]:[];
    });
    if(moved.length&&sameRows(sourceAfter,pickupRemainder(sourceBefore,{...before,items:moved}))){
     const first=moved[0]!;
     const batch={...makeBatchEvidence(shipAfter),...first,items:moved,flagID};
     if(pickupHoldMatches(batch,flagID))return batch;
    }
   }
   throw Error("Can-to-ship transfer is uncertain; reconciliation is required.");
  }
  const origin=before.scene!,deadline=Date.now()+10000;
  while(Date.now()<deadline){
   const post=firstPost??await scene(true),ship=post.ship!;firstPost=null;
   if(post.solarSystemID!==manifest.systemID)throw sourceError??Error("Pickup grid changed before source confirmation.");
   if(post.sampledAtMs!<=origin.transferSampledAt){await delay(poll);continue;}
   const can=origin.transferCan;
   const distance=Math.hypot(ship.position.x-can.position.x,ship.position.y-can.position.y,ship.position.z-can.position.z)-ship.radius-can.radius;
   if(distance>2000)throw Error("Hauler left the transfer grid before source confirmation.");
   if(!post.entities.some(e=>e.itemID===manifest.containerID)){
    const shipAfter=await readAfterTimeout(cargo),final=await scene(true),finalShip=final.ship!;
    if(final.solarSystemID!==manifest.systemID||final.sampledAtMs!<post.sampledAtMs!||final.entities.some(e=>e.itemID===manifest.containerID)||
       Math.hypot(finalShip.position.x-can.position.x,finalShip.position.y-can.position.y,finalShip.position.z-can.position.z)-finalShip.radius-can.radius>2000)
     throw Error("Source absence or transfer grid changed during hold read.");
    canAbsence={kind:"can-absent",containerID:manifest.containerID,systemID:manifest.systemID,shipID,
     canOwnerID:manifest.characterID,canKind:"container",...origin,postShip:{position:finalShip.position,radius:finalShip.radius},postSampledAt:final.sampledAtMs!};
    return makeBatch(shipAfter);
   }
   await delay(poll);
  }
  throw sourceError??Error("Source disappearance was not confirmed after pickup.");
 }
 async function loadStack(manifest:Manifest,rows:readonly NativeInventoryRow[],shipBefore:readonly NativeInventoryRow[],hold:Hold,j:Journal,
  grid:Awaited<ReturnType<typeof scene>>,dispatch?:HaulWork["dispatch"]){
  const distance=exactSceneCan(grid,manifest);
   if(distance===null||distance>2000||grid.ship?.warp||grid.ship?.mode?.toUpperCase()==="WARP")throw new FreightGridUnavailable("Claimed container is no longer in transfer range.");
  const volume=(id:number)=>manifest.items.find(i=>i.itemID===id)!.unitVolumeM3;
  let free=hold.free;
  const whole=dispatch?rows.filter(r=>{
   const size=r.quantity*volume(r.itemID);if(size>free+1e-9)return false;
   free-=size;return true;
  }):[];
  const selected=whole.length?whole:rows.filter(r=>volume(r.itemID)<=hold.free+1e-9).slice(0,1);
  const row=selected[0];
  if(!row)throw Error("No whole ore unit fits the selected hold.");
  const quantity=Math.min(row.quantity,Math.floor((hold.free+1e-9)/volume(row.itemID)));
  const items=dispatch?selected.map(r=>({itemID:r.itemID,typeID:r.typeID,quantity:whole.length?r.quantity:quantity})):undefined;
   const can=grid.entities.find(e=>e.itemID===manifest.containerID)!,ship=grid.ship!;
   if(manifest.source==="observed-jetcan"&&!lootable(can))throw Error("Loot rights changed for Jettison can "+manifest.containerID+".");
   const before:PickupBefore={containerID:manifest.containerID,sourceBefore:rows,shipBefore,itemID:row.itemID,typeID:row.typeID,
    quantity,items,shipID,flagID:hold.flag,scene:{transferCan:{position:can.position,radius:can.radius},
     transferShip:{position:ship.position,radius:ship.radius},transferSampledAt:grid.sampledAtMs!}};
   requirePickup();
    // The exclusive claim was acquired before the current source read.
    if(!claimCurrent(manifest))throw new GlobalLootClaimHeld("The current container claim expired. Checking the grid again.");
    if(dispatch&&!dispatch())throw new FreightGridUnavailable("Haul claim changed before pickup. Checking the current assignment.");
   j.begin("pickup",before);
   guard();
   const bay=hold.key==="cargo"?{kind:"cargo" as const}:{kind:"shipBay" as const,bay:hold.key};
   const moved=selected.map(r=>({...r,singleton:false}));
   try{
    const transfer=()=>moveItems(f.bridgeDo,shipID,bay,manifest.containerID,moved,selected.length>1?null:quantity);
    const evidence={containerID:manifest.containerID,stackCount:selected.length,sceneSampledAtMs:grid.sampledAtMs};
    await timed(timing,"hauler-pickup-transfer",()=>timing?.verbose?
     timing.command(selected.length>1?"MultiAdd":"Add",evidence,transfer):transfer(),evidence);
   }catch(error){
    guard();
    if(!bridgeCallQueueTimeout(error))throw error;
    j.refusePickup();
    throw new FleetObservationUnavailable("Pickup did not enter the transport. Rechecking the can.",{cause:error});
   }
   guard();j.acknowledge();
   const batch=await observePickup(manifest,before,true);
   j.settle({batch,shipAfter:batch.shipAfter});
   timing?.note("hauler-pickup-verified",{containerID:manifest.containerID,stackCount:pickupItems(batch).length});
   return {batch,partialBatch:!!items&&pickupItems(batch).length!==items.length};
 }
 function tripProgress(m:Manifest,j:Journal){
  const sourceBatches:HaulBatchProof[]=[],deliveryBatches:NativeDeliveryBatch[]=[];
  let remaining=[...m.items];
   let lastTripID:string|undefined;
  const aboard:NativeInventoryRow[]=[];
  for(const event of j.snapshot().events){
   if(event.kind==="pickup"){
    lastTripID=undefined;
    const batch=(event.after as {batch?:HaulBatchProof})?.batch;
    if(!batch)throw Error("Recorded pickup requires exact reconciliation.");
    checkSource(m,batch.sourceBefore,remaining);
    const left=pickupRemainder(remaining,batch);
    checkSource(m,batch.sourceAfter??[],left);
    remaining=left;
    if(batch.items){
     const flag=batch.flagID;
     if(flag===undefined||!pickupHoldMatches(batch,flag))throw Error("Recorded pickup has no verified hold delta.");
     aboard.push(...batch.items.map(item=>({...item,flagID:flag,ownerID:run.characterID,locationID:shipID,categoryID:25})));
    }else aboard.push(pickedStack(batch));
    sourceBatches.push(batch);
   }else if(event.kind==="delivery"){
    const {item,sourceBefore,destinationBefore,tripID}=event.before as DepositBefore;
    const {sourceAfter,destinationAfter,items}=event.after as Pick<NativeDeliveryBatch,"sourceAfter"|"destinationAfter"|"items">;
    for(const credit of items??[item])subtractDelivery(aboard,{item:credit,sourceBefore});
    lastTripID=tripID;
    if(!items||items.length)deliveryBatches.push({item:items?.[0]??item,sourceBefore,sourceAfter,destinationBefore,destinationAfter,...(items?{items}:{}),...(tripID?{tripID}:{})});
   }else throw Error("Relocated freight requires its existing reconciliation path.");
  }
  return {remaining,aboard,sourceBatches,deliveryBatches,lastTripID};
 }
 function verifyOnboard(aboard:readonly NativeInventoryRow[],actual:readonly NativeInventoryRow[]){
  for(const flag of new Set(aboard.map(r=>r.flagID))){
   const expected=totals(aboard.filter(r=>r.flagID===flag)),physical=totals(actual.filter(r=>r.flagID===flag));
   if([...expected].some(([type,quantity])=>(physical.get(type)??0)<quantity))
    throw Error("Recorded undelivered freight is not proven in the hauler hold.");
  }
 }
 const depositIO=(category:Manifest["category"]|"ANY",destinationID:number)=>createDockedRawDepositIO(run,session,{
  characterID:run.characterID,shipID,destinationID,...(corporationID===undefined?{}:{corporationID}),...(division===undefined?{}:{division}),
  ...(delivery?{delivery}:{}),freightKind:category,current:guard,
 });
 async function reconcileTransfer(manifest:Manifest,j:Journal,destinationID:number){
  const pending=j.snapshot().pending;
  if(!pending)return null;
  const progress=tripProgress(manifest,j);
  if(pending.kind==="pickup"){
   const before=pending.before as PickupBefore;
   checkSource(manifest,before.sourceBefore,progress.remaining);
   const batch=await observePickup(manifest,before,pending.acknowledged);
   guard();j.reconcile("pickup",{batch,shipAfter:batch.shipAfter});
  }else if(pending.kind==="delivery"){
   const before=pending.before as DepositBefore;
   for(const item of before.items??[before.item])subtractDelivery(progress.aboard,{item,sourceBefore:before.sourceBefore});
   const io=await depositIO(manifest.category,destinationID),after=await io.reconcileDelivery(before);
   guard();j.reconcile("delivery",after);
  }else throw Error("Original freight mutation requires reconciliation; no replay.");
  return pending.kind;
 }
 async function reconcileReturnHome(manifest:Manifest,generation:number,destinationID:number){
  guard();
  // A dispatched claim is not a pending inventory mutation. Keep the trip
  // history and leave any physical cargo for the selected parking policy.
  try{await reconcileTransfer(manifest,journal(manifest,generation),destinationID);}
  catch(error){
   const message=`Return Home cannot reconcile the transfer for can ${manifest.containerID}: ${error instanceof Error?error.message:String(error)}`;
   if(error instanceof FleetObservationUnavailable)throw new FleetObservationUnavailable(message,{cause:error});
   const native=error as {code?:unknown;status?:unknown;data?:{error?:unknown}}|null;
   throw Object.assign(Error(message,{cause:error}),
    {code:native?.code??native?.data?.error,status:native?.status});
  }
 }
 const ownFreight=config.ownFreight;
 let initialFreightChecked=false;
 const ownJournal=()=>ownFreight?.document.read() as {receipt:unknown;identity:string;officeID:number;pending:(Omit<DepositBefore,"officeID"|"flag">&{acknowledged:boolean})|null;batches:unknown[]}|null|undefined;
 const hasPendingOwnFreight=()=>!!ownJournal()?.pending;
 const hasUnfinishedOwnFreight=()=>{const saved=ownJournal();return !!saved&&!saved.receipt;};
 async function reconcileOwnFreight(destinationID:number){
  const saved=ownJournal();
  if(!ownFreight||!saved?.pending)return;
  const io=await depositIO("ANY",destinationID);
  const pending=saved.pending;
  const after=await io.reconcileDelivery({...pending,officeID:saved.officeID,flag:io.flag,...(pending.items?{requestedIDs:pending.items.map(i=>i.itemID)}:{})});
  const items="items" in after?after.items:undefined;
  const batches=items&&!items.length?saved.batches:[...saved.batches,{...pending,...after,item:items?.[0]??pending.item}];
  guard();ownFreight.document.write({...saved,pending:null,batches});
 }
 async function depositOwnFreight(destinationID:number){
  if(!ownFreight)throw Error("The deposit journal for ore already aboard is unavailable.");
  // Older saved operations may specify a station and corporation without a delivery object.
  let dock=delivery;
  if(!dock){
   const status=await flight();
   dock=decodeFleetDelivery({kind:"station",systemID:status.solarSystemID,destinationID,corporationID,division});
  }
  if(!dock)throw Error("The delivery dock for ore already aboard is unavailable.");
  freightCurrent();if(ownJournal()?.receipt)ownFreight.document.write(null);
  await unloadParkingFreight(run,session,{...ownFreight,shipID,delivery:dock,current:freightCurrent,wholeStacks:true});
 }
 const containsOre=async(rows:readonly NativeInventoryRow[])=>{
  if(rows.some(r=>r.categoryID===25))return true;
  const unknown=rows.filter(r=>r.categoryID===null);
  return unknown.length>0&&Object.values(await facts(unknown.map(r=>r.typeID))).some(r=>r.categoryID===25);
 };
 async function unloadInitialFreight(destinationID:number){
  if(!ownFreight||initialFreightChecked||config.stopBeforePickup?.())return false;
  // A newly hosted ship may already be full before the first current can.
  // Use the hold panel first so an empty ship needs no item inventory read.
  const {holds}=await readHoldPanel();
  const flags=new Map([["cargo",5],["ore",134],["ice",181],["asteroid",182]]);
  const fullHolds=new Set<number>();
  for(const hold of holds){
   const flag=flags.get(hold?.key),capacity=hold?.capacity;
   if(flag!==undefined&&hold.present===true&&hold.error===null&&Number.isFinite(capacity?.capacity)&&
      capacity.capacity>0&&Number.isFinite(capacity.used)&&capacity.used<=capacity.capacity&&
      capacity.used+1e-9>=capacity.capacity*deliveryFraction)fullHolds.add(flag);
  }
  const loaded=fullHolds.size>0&&await containsOre((await cargo()).filter(row=>fullHolds.has(row.flagID)));
  if(loaded){
   if(config.stopBeforePickup?.())return false;
   await destination(destinationID);
   await depositOwnFreight(destinationID);
  }
  initialFreightChecked=true;
  return loaded;
 }
 async function haulTrip(owned:readonly HaulWork[],next:(eligible:(m:Manifest)=>Promise<boolean>,
  rank?:(manifests:readonly Manifest[])=>Promise<readonly Manifest[]>)=>Promise<HaulWork|null>,
  destinationID:number,collectingFinalFreight=false):Promise<"idle"|"waiting"|"missing"|"delivered">{
  const openJob=(work:HaulWork)=>({work,j:journal(work.manifest,work.generation),sourceClosed:!!work.manifest.closedPickup});
  type Job=ReturnType<typeof openJob>;
  const jobs=owned.map(openJob);
  const open=(job:Job)=>tripProgress(job.work.manifest,job.j);
  const aboard=()=>jobs.flatMap(job=>open(job).aboard);
  let result:"idle"|"missing"|"delivered"="idle";
  function closeSource(job:Job){
   if(job.sourceClosed)return;
   job.work.closePickup();
   job.sourceClosed=true;
  }
  function complete(job:Job){
   const {work}=job,m=work.manifest,p=open(job);
   if(p.aboard.length)return false;
   if(p.remaining.length){
    if(!job.sourceClosed)return false;
    work.missing();
    if(result==="idle")result="missing";
    return true;
   }
   const first=p.deliveryBatches[0],last=p.deliveryBatches.at(-1);
   if(!first||!last)throw Error("Freight delivery still requires verified readback.");
   work.complete({source:"native-transfer",operationID:m.operationID,runID:m.runID,containerID:m.containerID,
    claimGeneration:work.generation,shipID,destinationID,sourceProof:{kind:"native-batches",batches:p.sourceBatches},
    deliveryBatches:p.deliveryBatches,destinationBefore:first.destinationBefore,destinationAfter:last.destinationAfter,observedAt:Date.now()});
   result="delivered";
   return true;
  }
  const pickupCargo=()=>timed(timing,"hauler-pickup-cargo",cargo,undefined,15000);
  const initial=jobs.length?await pickupCargo():null;
  const interruptedStackIDs=new Set<number>();
  let cargoChanged=false;
  for(const job of [...jobs]){
   freightCurrent();
   const {work,j}=job,m=work.manifest,{pending,events}=j.snapshot();
   const originalAboard=m.items.every(i=>initial?.some(r=>r.itemID===i.itemID&&r.typeID===i.typeID&&r.quantity===i.quantity));
   if(work.dispatched&&(events.some(e=>e.kind==="relocation"||e.kind==="pickup"&&(e.after as {kind?:unknown})?.kind==="relocated-manifest-items")||
     originalAboard&&!events.length&&(!pending||pending.kind==="pickup"&&!(pending.before as PickupBefore).scene))){
    work.complete(await recovery(m,work.generation,destinationID));cargoChanged=true;jobs.splice(jobs.indexOf(job),1);result="delivered";continue;
   }
   if(pending?.kind==="delivery")for(const itemID of (pending.before as DepositBefore).requestedIDs??[])interruptedStackIDs.add(itemID);
   const reconciled=await reconcileTransfer(m,j,destinationID);
   const progress=open(job);
   if(!job.sourceClosed&&!progress.remaining.length&&progress.sourceBatches.length){
    closeSource(job);
    await releasePickup(m);
   }else if(reconciled==="pickup")await releasePickup(m);
   if(job.sourceClosed&&!progress.sourceBatches.length)throw Error("Closed pickup has no verified transfer in its original journal.");
  }
  freightCurrent();
  let cargoNow=!cargoChanged&&initial?initial:await pickupCargo();
  const resumingCorpUnload=cargoNow.some(row=>interruptedStackIDs.has(row.itemID));
  if(!resumingCorpUnload)for(let i=jobs.length-1;i>=0;i--)if(complete(jobs[i]!))jobs.splice(i,1);
  const depositCorpFreight=async(tripID:string)=>{
   const io=await depositIO("ANY",destinationID);
   await io.withDestination(async()=>{
    let sourceBefore=await readDepositInventory(io.cargo);
    const candidates=sourceBefore.filter(r=>r.categoryID===null||r.categoryID===25);
    const types=candidates.length?await readDepositInventory(()=>facts(candidates.map(r=>r.typeID))):{};
    const freight=candidates.filter(r=>{
     const type=types[r.typeID];
     if(!type||r.categoryID!==null&&r.categoryID!==type.categoryID)throw Error("Hauler hold type is unknown.");
     if(type.categoryID!==25)return false;
     if(!(type.freightKind==="RAW"||type.freightKind==="COMPRESSED")||type.unitVolumeM3<=0||
       !(r.flagID===5||r.flagID===134||r.flagID===181&&type.resourceFamily==="ice"||r.flagID===182&&type.resourceFamily==="ore"))throw Error("Hauler freight is not qualified for unload.");
     return true;
    });
    const freightIDs=new Set(freight.map(r=>r.itemID));
    verifyOnboard(aboard(),freight);
    if(!freight.length){telemetry.cargo(sourceBefore);return;}
    let destinationBefore=await readDepositInventory(io.corp);
    while(sourceBefore.some(r=>freightIDs.has(r.itemID))){
     freightCurrent();
     const rows=sourceBefore.filter(r=>freightIDs.has(r.itemID));
     const available=new Map(rows.map(r=>[r.itemID,r.quantity]));
     const allocations=jobs.map(job=>{
      const items=new Map<number,PickupItem>();
      for(const cargo of open(job).aboard){
       let left=cargo.quantity;
       for(const row of rows){
        if(row.typeID!==cargo.typeID||row.flagID!==cargo.flagID)continue;
        const quantity=Math.min(left,available.get(row.itemID)!);
        if(!quantity)continue;
        items.set(row.itemID,{itemID:row.itemID,typeID:row.typeID,quantity:(items.get(row.itemID)?.quantity??0)+quantity});
        available.set(row.itemID,available.get(row.itemID)!-quantity);
        left-=quantity;if(!left)break;
       }
       if(left)throw Error("Verified freight is no longer available in the Hauler hold.");
      }
      return {journal:job.j,items:[...items.values()]};
     }).filter(a=>a.items.length);
     // Several cans can contribute to the same native stack. Keep their shares in
     // the existing trip journals while moving each physical stack only once.
     const requestedIDs=rows.map(r=>r.itemID);
     if(!allocations.length)allocations.push({journal:jobs[0]!.j,items:[]});
     for(const {journal,items} of allocations)journal.begin("delivery",{item:items[0]??rows[0],items,requestedIDs,sourceBefore,destinationBefore,officeID:io.officeID,flag:io.flag,tripID});
     const {movedIDs,sourceAfter,destinationAfter,acknowledged}=await io.depositWhole(rows,sourceBefore,destinationBefore,()=>{
      for(const {journal} of allocations)journal.refuseDelivery();
     });
     for(const {journal,items} of allocations){
      if(acknowledged)journal.acknowledge();
      journal.reconcile("delivery",{items:items.filter(r=>movedIDs.has(r.itemID)),sourceAfter,destinationAfter});
     }
     sourceBefore=sourceAfter;destinationBefore=destinationAfter;
    }
    if(aboard().length)throw Error("Collected ore remains in the Hauler hold.");
    telemetry.cargo(sourceBefore);
   });
  };
  if(hasUnfinishedOwnFreight()){
   await destination(destinationID);
   await depositOwnFreight(destinationID);
   cargoNow=await readAfterTimeout(cargo);
   result="delivered";
  }
  verifyOnboard(aboard(),cargoNow);
  const visited=new Set<number>();
  let competingClaim:GlobalLootClaimHeld|undefined;
  let unfitContainer:number|undefined;
  let loadFlag=aboard()[0]?.flagID,readyToUnload=resumingCorpUnload;
  const resumedLoad=jobs.find(job=>open(job).aboard.length);
  if(!readyToUnload&&resumedLoad&&!config.stopBeforePickup?.()){
   const status=await flight();
   // A resumed load already at its delivery dock can finish there.
   readyToUnload=status.docked&&(status.stationID??status.structureID)===destinationID;
   if(!readyToUnload){
     const hold=await chooseHold(resumedLoad.work.manifest,true,loadFlag);
    if(!hold)throw Error("Loaded freight hold capacity is unavailable.");
    readyToUnload=hold.used+1e-9>=hold.capacity*deliveryFraction;
   }
  }
  while(!readyToUnload&&!config.stopBeforePickup?.()){
   const loaded=jobs.find(job=>open(job).aboard.length)?.work.manifest;
   const sameSite=(m:Manifest)=>!loaded||m.targetKey===loaded.targetKey&&m.claimGeneration===loaded.claimGeneration;
   const ownedJob=jobs.find(job=>!job.sourceClosed&&sameSite(job.work.manifest)&&!visited.has(job.work.manifest.containerID)&&open(job).remaining.length);
   const carried=aboard();
   let ranked:PickupObservation|undefined,holds:Awaited<ReturnType<typeof readHoldPanel>>|undefined,capacityBlocked=false;
   const inspected=new Map<number,Hold>();
   const tripHolds=async(containerID:number)=>holds??=await timed(timing,"hauler-pickup-hold",readHoldPanel,{containerID},15000);
   // Reuse this pass's capacity read while choosing among cans. The ship hold
   // contents themselves come from the initial or last verified transfer read.
   const fresh=ownedJob?null:await next(async m=>{
    if(!sameSite(m)||visited.has(m.containerID))return false;
    const panel=await tripHolds(m.containerID);
    const primary=await holdFromPanel(m,panel.holds,true,loadFlag);
    if(primary&&primary.used+1e-9>=primary.capacity*deliveryFraction&&await containsOre(cargoNow.filter(r=>r.flagID===primary.flag))){
     capacityBlocked=true;return false;
    }
    const selectedHold=await holdFromPanel(m,panel.holds,false,loadFlag);
    if(selectedHold)inspected.set(m.containerID,selectedHold);
    else if(!capacityBlocked){
     capacityBlocked=!!primary&&await containsOre(cargoNow.filter(r=>r.flagID===primary.flag));
     if(!capacityBlocked)unfitContainer=m.containerID;
    }
    return !!selectedHold;
   },async manifests=>{
    const candidates=manifests.filter(m=>sameSite(m)&&!visited.has(m.containerID));
    if(candidates.length<2)return candidates;
    const status=await flight();
    if(!status.inSpace||status.solarSystemID!==candidates[0]!.systemID||status.shipMode?.toUpperCase()==="WARP"||
       status.transition&&status.transition.phase!=="ready")return candidates;
    try{ranked={grid:await scene(),flight:status,observedAt:performance.now()};}
    catch(error){freightCurrent();throw new FreightGridUnavailable("Cannot rank freight while the local grid is unreadable.",{cause:error});}
    const {grid}=ranked;
    const following=followTarget(grid);
    // Retain the previous site's freight tail. Within a site, finish the
    // closest visible cans before choosing cans outside this ship's scene.
    const distance=(m:Manifest)=>{
     const can=grid.entities.find(e=>e.itemID===m.containerID&&e.kind==="container"&&e.ownerID===m.characterID&&e.geometryAvailable);
     return can&&grid.solarSystemID===m.systemID?exactSceneCan(grid,m)??Infinity:Infinity;
    };
    const sites=[...new Set(candidates.map(m=>m.targetKey))];
    return candidates.map(m=>({m,distance:distance(m)})).sort((a,b)=>
     sites.indexOf(a.m.targetKey)-sites.indexOf(b.m.targetKey)||
     Number(b.m.containerID===following)-Number(a.m.containerID===following)||(a.distance-b.distance)||0).map(row=>row.m);
   });
   const job=ownedJob??(fresh?openJob(fresh):null);
   if(!job){readyToUnload=capacityBlocked;break;}
   const {work,j}=job,m=work.manifest;
   if(fresh)jobs.push(job);
   visited.add(m.containerID);
   const progress=open(job);
   const freight={category:m.category,targetKey:m.targetKey,items:progress.remaining};
   let hold=fresh?inspected.get(m.containerID)??null:await holdFromPanel(freight,(await tripHolds(m.containerID)).holds,false,loadFlag);
   if(!hold){
    if(fresh)work.cancel();
    const emptied=await holdFromPanel(freight,(await tripHolds(m.containerID)).holds,true,loadFlag);
    if(!emptied||!await containsOre(cargoNow.filter(r=>r.flagID===emptied.flag)))throw Error("No whole ore unit fits the eligible hold.");
    readyToUnload=true;
    continue;
   }
   const holdFlag=hold.flag;
   if(hold.used+1e-9>=hold.capacity*deliveryFraction&&await containsOre(cargoNow.filter(r=>r.flagID===holdFlag))){
    if(fresh)work.cancel();readyToUnload=true;break;
   }
    const sample=scannedPickup;
    const sameScan=sample?.scope.containerID===m.containerID&&sample.scope.systemID===m.systemID&&
     sample.scope.characterID===m.characterID&&sample.scope.targetKey===m.targetKey&&sample.scope.claimGeneration===m.claimGeneration;
    const continuousClaim=sameScan&&claimCurrent(m);
    let claimed=continuousClaim;
    const claimSource=async()=>{
     if(!claimed){await config.claimPickup?.(m);claimed=true;}
     if(!claimCurrent(m))throw new GlobalLootClaimHeld("The current container claim expired. Checking the grid again.");
    };
   try{
    requirePickup();
    let arrival=continuousClaim&&freshRange(sample.arrival)?sample.arrival:undefined;
    // Discovery has already navigated on this claim. Renew its range observation if it aged.
    const grid=continuousClaim?arrival?.grid??await scene():
     ranked?.grid??(m.source==="observed-jetcan"?await scene().catch(()=>null):null);
    const local=continuousClaim?arrival??(grid?{grid,observedAt:performance.now()}:undefined):
     ranked??(grid?{grid,observedAt:performance.now()}:undefined);
    const localGrid=local?.grid;
    if(!arrival&&continuousClaim&&local&&localGrid?.solarSystemID===m.systemID&&
       localGrid.sampledAtMs!>=sample.arrival.grid.sampledAtMs!&&
       localGrid.ship?.mode&&localGrid.ship.mode.toUpperCase()!=="WARP"&&!localGrid.ship.warp){
     const meters=exactSceneCan(localGrid,m);
     if(meters!==null&&meters<=2000)arrival={grid:localGrid,local:true,observedAt:local.observedAt};
    }
     if(m.source==="observed-jetcan"&&localGrid&&exactSceneCan(localGrid,m)!==null)await claimSource();
    // The trip reads this ship's hold after the scan has reached the can.
    const reached=arrival?{...arrival,local:true}:await reach(m,work.target,work.claim,!!config.navigateToTarget,local);
    requirePickup();
    if(reached==="missing"){
     if(!progress.aboard.length){work.missing();jobs.splice(jobs.indexOf(job),1);result="missing";}
     else closeSource(job);
     await releasePickup(m);
     continue;
    }
     await claimSource();
     const reusedSample=continuousClaim&&reached.local&&!work.dispatched&&performance.now()-sample.observedAt<=1500&&claimCurrent(m);
     let rows=reusedSample?sample.rows:await timed(timing,"hauler-pickup-source",()=>read(m.containerID,null),{containerID:m.containerID,recheck:true},15000);
    if(!matchesSource(m,rows,progress.remaining)){
     if(sourceBelongsToCan(m,rows)){
      // A fresh read supersedes the old contents once all earlier writes and
      // the ore attributed to this job are accounted for.
      if(!progress.aboard.length){work.missing();jobs.splice(jobs.indexOf(job),1);result="missing";continue;}
      if(!rows.length){closeSource(job);continue;}
     }
     throw Error("Claimed container differs from its recorded freight.");
    }
    // A local follow can use the verified hold from this trip. Refresh it
    // after navigation to a site that was not in the ship's original scene.
    if(!reached.local){
     cargoNow=await pickupCargo();verifyOnboard(carried,cargoNow);
    }
    requirePickup();
    // A delayed source read needs a fresh range check before the write.
    let pickupGrid=freshRange(reached)?reached.grid:await scene();
    while(rows.length){
     const {batch,partialBatch}=await loadStack(m,rows,cargoNow,hold,j,pickupGrid,work.dispatch);
     cargoNow=batch.shipAfter;verifyOnboard(aboard(),cargoNow);
     rows=[...(batch.sourceAfter??[])];
     loadFlag=hold.flag;
     const filled:number=hold.used+pickupItems(batch).reduce((sum,i)=>sum+i.quantity*m.items.find(row=>row.itemID===i.itemID)!.unitVolumeM3,0);
     readyToUnload=filled+1e-9>=hold.capacity*deliveryFraction;
       if(!rows.length){
        closeSource(job);
        try{await config.afterPickup?.(m);}catch{/* The empty source and loaded hold were already verified. */}
        break;
       }
     if(readyToUnload||partialBatch||config.stopBeforePickup?.())break;
     hold={...hold,used:filled,free:Math.max(0,hold.capacity-filled)};
     const free=hold.free;
     if(!rows.some(row=>m.items.some(i=>i.itemID===row.itemID&&i.unitVolumeM3<=free+1e-9))){readyToUnload=true;break;}
     pickupGrid=await scene();
    }
   }catch(error){
    work.cancel();
    if(j.snapshot().pending)throw error;
     if(error instanceof GlobalLootClaimHeld){
      competingClaim=error;
      if(!work.dispatched)jobs.splice(jobs.indexOf(job),1);
     }else if(!(error instanceof HaulStoppedBeforePickup))throw error;
   }finally{
     const pending=!!j.snapshot().pending;
     if(sameScan&&pending)sample.pendingPickup=true;
     if(claimed&&!sameScan&&!pending)await releasePickup(m);
   }
  }
  const progress=jobs.map(open),carried=progress.flatMap(job=>job.aboard);
  if(carried.length||readyToUnload){
   freightCurrent();
   if(!readyToUnload&&!config.stopBeforePickup?.()&&jobs.filter(job=>open(job).aboard.length).every(job=>job.work.waitForMore()))
    return "waiting";
   const tripID=await destination(destinationID,progress.find(job=>job.lastTripID)?.lastTripID);
   if((carried.length||resumingCorpUnload)&&corporationID!==undefined)await depositCorpFreight(tripID);
   else {
    for(const job of jobs){
     const carried=open(job).aboard;
     if(!carried.length)continue;
     const io=await depositIO(job.work.manifest.category,destinationID);
     const fence=taggedDeposit(job.j,tripID,freightCurrent);
     for(const row of carried){
      let left=row.quantity;
      for(const stack of cargoNow.filter(r=>r.typeID===row.typeID&&r.flagID===row.flagID)){
       const batch=await io.deposit({itemID:stack.itemID,typeID:stack.typeID,quantity:Math.min(left,stack.quantity)},fence,true);
       cargoNow=batch.sourceAfter;
       left-=batch.item.quantity;
       if(!left)break;
      }
      if(left)throw Error("Verified freight is no longer available in the Hauler hold.");
     }
    }
    if(await containsOre(cargoNow.filter(r=>[5,134,181,182].includes(r.flagID))))
     await depositOwnFreight(destinationID);
   }
   result="delivered";
  }
  freightCurrent();
  for(const job of jobs)complete(job);
  if(result==="idle"&&competingClaim)throw competingClaim;
  if(collectingFinalFreight&&result==="idle"&&unfitContainer!==undefined)
   throw Error("No whole ore unit from can "+unfitContainer+" fits an eligible Hauler hold.");
  return result;
 }
 let ready:{containerID:number;target:Target;claim:Claim}|null=null;
 async function canCarryFreight(items:readonly ManifestItem[]){
  if(!items[0])return false;
   try{return !!await chooseHold({items,category:items[0].freightKind},true);}
   catch(error){if(error instanceof FleetObservationUnavailable)throw error;return false;}
 }
 let lastGridScan=-Infinity,nativeCanCapacity:number|undefined;
 const scanCooldown=new Map<number,number>();
 async function observeGridJetcans(target:Target,claim:Claim,excluded:ReadonlySet<number>,pendingOwners:ReadonlySet<number>,available:(canID:number,ownerID:number)=>boolean,publish:(can:GridJetcan)=>unknown,final=false,arrival?:PickupGridObservation|void){
  if(config.stopBeforePickup?.()||!final&&Date.now()-lastGridScan<5000)return;
  lastGridScan=Date.now();
  let observation:PickupGridObservation;
  try{observation=!final&&arrival&&freshRange(arrival)?arrival:{grid:await scene(final),observedAt:performance.now()};}catch(error){
   freightCurrent();
   if(final)throw new FreightGridUnavailable("The final pickup grid is unreadable.",{cause:error});
   return;
  }
  freightCurrent();
  const {grid}=observation;
  if(grid.solarSystemID!==target.systemID){
   if(final)throw new FreightGridUnavailable("The Hauler has not reached the final pickup system.");
   return;
  }
  const candidates=grid.entities.filter(can=>can.kind==="container"&&can.typeID===23&&positive(can.ownerID)&&can.geometryAvailable&&
   !excluded.has(can.itemID)&&!pendingOwners.has(can.ownerID)&&lootable(can));
  const candidateIDs=new Set(candidates.map(can=>can.itemID));
  for(const id of scanCooldown.keys())if(!candidateIDs.has(id))scanCooldown.delete(id);
  const following=followTarget(grid);
  const sorted=candidates.map(can=>({can,scope:{source:"observed-jetcan" as const,containerID:can.itemID,systemID:target.systemID,
   characterID:can.ownerID!,targetKey:claim.key,claimGeneration:claim.generation}}))
   .sort((a,b)=>Number(b.can.itemID===following)-Number(a.can.itemID===following)||
    (exactSceneCan(grid,a.scope)??Infinity)-(exactSceneCan(grid,b.scope)??Infinity));
  for(const {can,scope} of sorted){
   if(!final&&(scanCooldown.get(can.itemID)??0)>Date.now())continue;
   const stillDiscovering=()=>available(can.itemID,scope.characterID);
   freightCurrent();if(config.stopBeforePickup?.())return;
   if(!stillDiscovering())continue;
    let claimed=false,observed:GridJetcan|undefined,source:typeof scannedPickup;
   try{
    await config.claimPickup?.(scope);claimed=true;
    if(!stillDiscovering())continue;
    // EveJS requires container interaction range even for an inventory read.
    const reached=await reach(scope,target,claim,true,observation,stillDiscovering);
    if(reached==="missing")continue;
    if(!stillDiscovering())continue;
    const entity=reached.grid.entities.find(e=>e.itemID===can.itemID);
    if(!entity||!lootable(entity))continue;
    const rows=await timed(timing,"hauler-pickup-source",()=>read(can.itemID,null),{containerID:can.itemID,recheck:false},15000);
     const observedAt=performance.now();
    scanCooldown.set(can.itemID,Date.now()+30000);
    if(!rows.length||rows.some(r=>r.ownerID!==can.ownerID||r.flagID!==0||r.categoryID!==null&&r.categoryID!==25))continue;
    const types=await facts(rows.map(r=>r.typeID)),category=types[rows[0]!.typeID]?.freightKind;
    if(!category||rows.some(r=>types[r.typeID]?.freightKind!==category||types[r.typeID]?.resourceFamily!==(target.kind==="ICE"?"ice":"ore")||
      !(types[r.typeID]!.unitVolumeM3>0)))continue;
    nativeCanCapacity??=await readJettisonCapacity(run,guard);
    freightCurrent();
    const items=rows.map(r=>({itemID:r.itemID,typeID:r.typeID,quantity:r.quantity,freightKind:category,unitVolumeM3:types[r.typeID]!.unitVolumeM3}));
    observed={containerID:can.itemID,ownerID:can.ownerID!,observedAt:Date.now(),capacityM3:nativeCanCapacity,items};
     if(!final&&config.claimPickup)source={scope,rows,observedAt,arrival:reached};
   }catch(error){
    freightCurrent();
    if(error instanceof FleetObservationUnavailable||error instanceof FreightGridUnavailable&&!(error instanceof GlobalLootClaimHeld)||transientNativeRead(error))
     throw new FreightGridUnavailable(final?"Waiting to finish the final pickup scan.":"Waiting to recheck the selected can.",{cause:error});
    continue;
   }finally{
     try{
      if(observed&&stillDiscovering()){
       scannedPickup=source;
       await publish(observed);
      }
     }finally{scannedPickup=undefined;if(claimed&&!source?.pendingPickup)await releasePickup(scope);}
   }
   if(!final)return;
  }
 }
 const navigateToTarget=config.navigateToTarget;
 const waitAtBelt=navigateToTarget?async(target:Target,claim:Claim,current:()=>void)=>{
  guard();current();
  if(target.kind==="BELT"&&pickupBelt?.key===claim.key&&pickupBelt.generation===claim.generation){
   const grid=await scene().catch(error=>{if(error instanceof FleetObservationUnavailable)throw error;return null;});guard();current();
   if(grid?.solarSystemID===target.systemID&&grid.ship?.mode?.toUpperCase()!=="WARP"&&!grid.ship?.warp&&
      grid.entities.some(e=>e.groupID===9&&e.name===target.name&&e.geometryAvailable))return {grid,observedAt:performance.now()};
  }
  await navigateToTarget(target,claim,current);guard();current();pickupBelt=claim;
 }:undefined;
 return {getFreightStatus:()=>telemetry.snapshot(),current:guard,recoverHeldAndDeliver:recovery,reconcileReturnHome,hasPendingOwnFreight,hasUnfinishedOwnFreight,unloadInitialFreight,reconcileOwnFreight,canCarryFreight,haulTrip,waitAtBelt,observeGridJetcans,async navigateAndVerify(manifest:Manifest,target:Target,claim:Claim,allowMissing=false){ready=null;if(!["RAW","COMPRESSED"].includes(manifest.category)||manifest.operationID!==claim.operationID||manifest.runID!==claim.runID||manifest.targetKey!==claim.key||manifest.claimGeneration!==claim.generation||manifest.systemID!==target.systemID)throw Error("Freight claim is out of scope.");
  await verifyRaw(manifest);if(await reach(manifest,target,claim,allowMissing)==="missing")return "missing" as const;
  await canRows(manifest);
  const hold=await chooseHold(manifest);if(!hold)throw Error("Cargo capacity is insufficient or unknown.");
  // Farmer scopes this claim to the held pilot's current system.
  await config.claimPickup?.(manifest);guard();ready={containerID:manifest.containerID,target,claim};
 },async transferAndDeliver(manifest:Manifest,haulGeneration:number,destinationID:number):Promise<NativeHaulDelivery>{if(ready?.containerID!==manifest.containerID)throw Error("Container was not verified for this haul.");const {target,claim}=ready;ready=null;
  const j=journal(manifest,haulGeneration);if(j.snapshot().pending)throw Error("Unresolved haul mutation; no replay.");
  const requirePickup=()=>{guard();if(config.stopBeforePickup?.())throw new HaulStoppedBeforePickup();};
  requirePickup();
  const batches:HaulBatchProof[]=[],deliveryBatches:NativeDeliveryBatch[]=[];const wanted=expected(manifest);
  let remaining:readonly NativeInventoryRow[]=await canRows(manifest),firstDestination:NativeInventoryRow[]|null=null,lastDestination:NativeInventoryRow[]|null=null;
  const delivered=new Map<number,number>();let pickupReleased=false;
  while(remaining.length){
   const s=await scene(),distance=exactSceneCan(s,manifest);if(distance===null||distance>2000)throw Error("Claimed container is no longer in transfer range.");
   const initial=await cargo();
   const hold=await chooseHold(manifest);
   if(!hold)throw Error("Cargo capacity is insufficient or unknown.");
   requirePickup();
   const {batch}=await loadStack(manifest,remaining,initial,hold,j,s);
   batches.push(batch);
   const taken=new Map([[batch.typeID,batch.quantity]]),sourceAfter=batch.sourceAfter;
   remaining=sourceAfter??[];if(!remaining.length&&config.afterPickup){await config.afterPickup(manifest);guard();pickupReleased=true;}
   const original=pickedStack(batch);
   // Compression transforms the whole native stack; it is only safe for an unmerged pickup.
   const conversion=manifest.category==="RAW"&&config.convertFreight&&!initial.some(r=>r.itemID===original.itemID)?await config.convertFreight(original,manifest,haulGeneration):null;guard();if(conversion&&(conversion.item.itemID!==original.itemID||conversion.item.typeID!==original.typeID||conversion.item.quantity!==original.quantity||conversion.output.itemID!==original.itemID||conversion.output.quantity!==original.quantity))throw Error("Collected compression identity is uncertain.");
   const tripID=await destination(destinationID);
  const io=await createDockedRawDepositIO(run,session,{characterID:run.characterID,shipID,destinationID,...(corporationID===undefined?{}:{corporationID}),...(division===undefined?{}:{division}),...(delivery?{delivery}:{}),freightKind:conversion?"COMPRESSED":manifest.category,current:guard});
  const shipBeforeAll=await io.cargo(),item=shipBeforeAll.find(r=>r.itemID===original.itemID),expectedShipBefore=totals(initial);for(const [type,q] of taken)expectedShipBefore.set(type,(expectedShipBefore.get(type)??0)+q);if(conversion){const n=(expectedShipBefore.get(original.typeID)??0)-original.quantity;if(n)expectedShipBefore.set(original.typeID,n);else expectedShipBefore.delete(original.typeID);expectedShipBefore.set(conversion.output.typeID,(expectedShipBefore.get(conversion.output.typeID)??0)+original.quantity);}
  if(!equal(totals(shipBeforeAll),expectedShipBefore)||!item||item.typeID!==(conversion?.output.typeID??original.typeID)||item.quantity<original.quantity||item.flagID!==hold.flag)throw Error("Ship freight changed before delivery.");
  const depositBatch=await io.deposit({itemID:item.itemID,typeID:item.typeID,quantity:original.quantity},taggedDeposit(j,tripID),true);
  deliveryBatches.push({...depositBatch,tripID,...(conversion?{conversion}:{})});
  for(const [type,q] of taken)delivered.set(type,(delivered.get(type)??0)+q);
  firstDestination??=depositBatch.destinationBefore;lastDestination=depositBatch.destinationAfter;
   if(remaining.length){
    requirePickup();await reach(manifest,target,claim);requirePickup();
    const check=await read(manifest.containerID,null);
    if(!equal(totals(check),totals(remaining))||check.some(r=>r.ownerID!==manifest.characterID))throw Error("Remaining can custody changed.");
    requirePickup();try{await config.claimPickup?.(manifest);}catch(error){requirePickup();throw error;}
    remaining=check;
   }
  }
  if(!equal(delivered,wanted)||!firstDestination||!lastDestination||config.afterPickup&&!pickupReleased)throw Error("Full freight delivery is uncertain.");
  return {source:"native-transfer",operationID:manifest.operationID,runID:manifest.runID,containerID:manifest.containerID,claimGeneration:haulGeneration,shipID,destinationID,sourceProof:{kind:"native-batches" as const,batches},destinationBefore:firstDestination,destinationAfter:lastDestination,deliveryBatches,observedAt:Date.now()};
 }};
}
