import {lostLockTarget} from "../shared/targetEvents.ts";
import type {MiningTravelAssist} from "./travelAssist.ts";
import {summarizeFreight,selectFreight,RAW_JETTISON_THRESHOLD,COMPRESSED_JETTISON_THRESHOLD,type FreightStatus,type HoldCapacity} from "./freightPolicy.ts";
import {createCompressionController} from "./support/compressionController.ts";
import {createCompressionFacilityObserver} from "./support/compressionFacility.ts";
import type {CommandSupportView} from "./runtime.ts";
import {preferredQualifiedResources} from "./resourcePolicy.ts";
import path from "node:path";
import {createRequire} from "node:module";
import {pluginDataDir,type PluginRunContext} from "../../../web/src/plugin-api/backend.ts";
import type {PilotSession} from "../../../web/src/plugin-api/pilotSession.ts";
import {buildSlots,slotFlagOf,loadFitting,fetchTypeDogma,decodeTargetIDs,lockTarget,APPROACH_SETTLE_MS} from "../../../web/src/plugin-api/flying.ts";
import {miningMissionFit} from "../mining/miningMission.ts";
import {activateDuringOriginalLock,targetGoneRefusal} from "../mining/activation.ts";
import {decodeModuleObservation} from "../shared/moduleObservation.ts";
import {observeMiningCycle} from "../shared/miningCycle.ts";
import {readNativeShipHolds,type NativeInventoryRow} from "../shared/nativeInventory.ts";
import {createRawTypeFacts} from "./typeFacts.ts";
import {claimedBeltRocks} from "./beltRocks.ts";
import {readMiningReadiness,type MiningReadiness} from "./nativeBelt.ts";
import {isDefiniteWarpRefusal,reconcileDefiniteLockRefusal} from "./lockRefusal.ts";
import type {FleetSetup,MiningCycle} from "./runtime.ts";
import type {Claim,Target,SynchronousStore} from "./targetBoard.ts";
import {createMinerDroneFlight} from "./minerDrones.ts";
import {fleetReadFailed,FleetObservationUnavailable,FleetShipChanged,FleetStopBeforeDispatch} from "./stopSignal.ts";
import {createSiteDiscovery,claimedSiteRocks} from './siteDiscovery.ts';
import {targetKey} from './targetBoard.ts';
import {timed,type MccTiming} from "./timing.ts";
import {deleteFleetCycles} from "./executionDocuments.ts";
const require=createRequire(import.meta.url),{createDocumentStore}=require("../documentStore.cjs") as {createDocumentStore:(file:string)=>Parameters<typeof deleteFleetCycles>[0]};
let db:ReturnType<typeof createDocumentStore>|null=null;
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const valid=(n:unknown):n is number=>typeof n==="number"&&Number.isSafeInteger(n)&&n>0;
type CycleScope=Pick<FleetSetup,"operationID"|"operationRunID">;
function cycleStore(name:string){
 db??=createDocumentStore(path.join(pluginDataDir(),"mining-fleet-cycles.sqlite"));
 return db.document(name);
}
export function discardMiningCycles(operationID:string,runID:string){
 db??=createDocumentStore(path.join(pluginDataDir(),"mining-fleet-cycles.sqlite"));
 deleteFleetCycles(db,operationID,runID);
}
export function miningCycleDocument(characterID:number,scope:CycleScope,document=cycleStore):SynchronousStore{
 const {operationID,operationRunID}=scope;
 const scoped=document(`pilot-cycle:${JSON.stringify([operationID,operationRunID,characterID])}`);
 return {
  read(){
   const record=scoped.read();
   if(record!==null)return record;
   // Existing runs can still read their own pilot-keyed record after an upgrade.
   const legacy=document(`pilot:${characterID}`).read() as {identity?:unknown}|null;
   if(typeof legacy?.identity!=="string")return null;
   let identity:unknown;
   try{identity=JSON.parse(legacy.identity);}catch{return null;}
   return Array.isArray(identity)&&identity.length===7&&identity[0]===operationID&&
    identity[1]===operationRunID&&identity[2]===characterID?legacy:null;
  },
  write(value){scoped.write(value);},
 };
}
/** Exact activated target and native effect duration, not the unboosted type attribute. */
export function iceCycleTiming(active:Awaited<ReturnType<typeof decodeModuleObservation>>,after:Awaited<ReturnType<typeof decodeModuleObservation>>,targetID:number,gain:number){
 const matching=active.activeTargets.filter(e=>e.targetID===targetID);if(matching.length!==1||!Number.isSafeInteger(gain)||gain<=0||after.moduleID!==active.moduleID||after.typeID!==active.typeID||after.ownerID!==active.ownerID||after.shipID!==active.shipID||after.flagID!==active.flagID||after.activeTargets.length!==0)return null;
 const effect=matching[0]!;if(!Number.isFinite(effect.durationMs)||effect.durationMs<=0||!/^\d+$/.test(effect.startFiletime)||!/^\d+$/.test(after.timeFiletime))return null;
 if(BigInt(after.timeFiletime)-BigInt(effect.startFiletime)<BigInt(Math.ceil(effect.durationMs*10000)))return null;
 return {targetID,effectID:effect.effectID,startFiletime:effect.startFiletime,durationMs:effect.durationMs,afterTimeFiletime:after.timeFiletime,gain};
}
export function observedOreCycleSettled(active:ReturnType<typeof decodeModuleObservation>,after:ReturnType<typeof decodeModuleObservation>,targetID:number,gain:number){
 return Array.isArray(active.activeTargets)&&active.activeTargets.some(effect=>effect.targetID===targetID)&&
  after.moduleID===active.moduleID&&after.typeID===active.typeID&&after.ownerID===active.ownerID&&
  after.shipID===active.shipID&&after.flagID===active.flagID&&after.activeTargets.length===0&&
  /^\d+$/.test(active.timeFiletime)&&/^\d+$/.test(after.timeFiletime)&&BigInt(after.timeFiletime)>=BigInt(active.timeFiletime)&&
  Number.isSafeInteger(gain)&&gain>=0;
}
/** Belt and exact ore-site cycles share the qualified activation and observation machinery. */
export async function createFleetMiningCycle(run:PluginRunContext,session:PilotSession,current:()=>void,stopRequested:()=>boolean,
 injected?:{document?:SynchronousStore;wait?:(ms:number)=>Promise<void>;now?:()=>number;movementAdmission?:()=>Promise<void>;movementArrived?:()=>boolean;reportDrones?:(phase:string,why:string)=>void;travelAssist?:MiningTravelAssist;commandSupport?:()=>CommandSupportView|null;compressionDocument?:SynchronousStore;compressionFactory?:typeof createCompressionController;authority?:()=>{state:string;target:Target;claim:Claim|null}|null;timing?:MccTiming}):Promise<MiningCycle>{
 const setup=run.setup as unknown as FleetSetup,member=setup?.members?.find(m=>m.characterID===run.characterID&&(m.role==="MINER"||m.role==="COMMAND"&&setup.supportPolicy?.selfMining));
 if(!member||!valid(member.shipID)||(!setup.site&&!valid(setup.beltID))||typeof setup.operationRunID!=="string"||!setup.operationRunID)throw Error("Fleet mining identity is incomplete.");
 const family=setup.site?.target.kind==="ICE"?"ice":"ore";
 const timing=injected?.timing;
 const {shipID}=member,scope=[setup.operationID,setup.operationRunID,run.characterID,shipID,setup.systemID,setup.site?setup.site.target:setup.beltID];
 const identity=JSON.stringify([...scope,run.botID]);
 const discovery=setup.site?createSiteDiscovery(run,session,{shipID,systemID:setup.systemID,current}):null;
 const rocksAt=async(space:Awaited<ReturnType<typeof readMiningReadiness>>['space'])=>setup.site?claimedSiteRocks(space,setup.site,await discovery!.read(),shipID,run.characterID):claimedBeltRocks(space,{shipID,characterID:run.characterID,systemID:setup.systemID,beltID:setup.beltID!});
 const document=injected?.document??miningCycleDocument(run.characterID,setup),wait=injected?.wait??sleep,approachNow=injected?.now??Date.now,options={...session.flow.requestOptions(),baseUrl:run.baseUrl,fetch:run.fetch};
 let state:any=document.read();if(state&&(state.version!==1||typeof state.identity!=="string"||!Number.isSafeInteger(state.nextOrdinal)||state.nextOrdinal<=0||typeof state.closed!=="boolean"||!Array.isArray(state.retired)||state.retired.some((id:unknown)=>!valid(id))||new Set(state.retired).size!==state.retired.length||!(state.pending===null||typeof state.pending==="object"&&!Array.isArray(state.pending))))throw Error("Fleet mining cycle record is malformed.");
 let cycleOwner=run.botID;
 if(state&&state.identity!==identity&&!state.closed){
  let previous:unknown;
  try{previous=JSON.parse(state.identity);}catch{/* Reject an unreadable scope below. */}
  if(!run.resumed||!Array.isArray(previous)||previous.length!==7||typeof previous[6]!=="string"||!previous[6]||
     JSON.stringify(previous.slice(0,6))!==JSON.stringify(scope))
   throw Error("An open cycle in this fleet generation has a different mining identity; reconciliation is required.");
  cycleOwner=previous[6];
 }
 if(!state||state.closed&&state.identity!==identity)state={version:1,identity,nextOrdinal:1,pending:null,closed:false,retired:[]};
 if(state.approach!==undefined&&state.approach!==null&&(!state.approach||!["pending","acknowledged","observed","refused"].includes(state.approach.status)||![state.approach.targetID,state.approach.claimGeneration,state.approach.issuedAt].every(valid)||typeof state.approach.claimKey!=="string"||!Number.isFinite(state.approach.range)||state.approach.range<0||!Number.isFinite(state.approach.beforeSampledAt)))throw Error("Fleet approach journal is malformed.");
 if(state.pending&&!run.resumed)throw Error("A previous native mining mutation needs reconciliation; no replay.");if(state.closed)throw Error("This fleet mining cycle is already closed.");
 // Keep the issuing owner's scope intact while its native command outcome is unknown.
 if(!state.pending){state.identity=identity;cycleOwner=run.botID;}
 const save=()=>{current();document.write(state);};save();const f=session.flow.flying,typeFacts=createRawTypeFacts(run,current);
 if(setup.oreLogistics?.remoteCompression&&!injected?.compressionDocument)db??=createDocumentStore(path.join(pluginDataDir(),"mining-fleet-cycles.sqlite"));
 const compression=setup.oreLogistics?.remoteCompression?(injected?.compressionFactory??createCompressionController)({operationID:setup.operationID,runID:setup.operationRunID,run,session,shipID,systemID:setup.systemID,document:injected?.compressionDocument??db!.document(`compression:${identity}`),current,beforeDispatch:()=>beforeAction(),facility:async typeID=>{const support=injected?.commandSupport?.();if(!support)throw Error("Compression facility is temporarily unavailable.");const observe=createCompressionFacilityObserver({operationID:setup.operationID,runID:setup.operationRunID,systemID:setup.systemID,commander:support.commander,miner:{run,session,shipID,current},claim:()=>injected?.authority?.()?.claim??null,observeSupport:support.observeSupport});return observe(typeID);}}):null;
 const get=async(url:string)=>{current();const response=await run.fetch(new URL(url,run.baseUrl)),body=await response.json().catch(error=>{if(response.ok)throw error;return null;});current();if(!response.ok||body?.ok!==true)throw Object.assign(Error(body?.message??`Native mining read failed: ${url}`),{code:body?.error,status:response.status});return body;};
 let freightStatus:FreightStatus|null=null;const recordFreight=(summaries:ReturnType<typeof summarizeFreight>,observedAt:number)=>{if(summaries.some(h=>![h.raw.reduce((n,i)=>n+i.quantity,0),h.compressed.reduce((n,i)=>n+i.quantity,0)].every(Number.isSafeInteger))){freightStatus=null;return;}const snapshot=compression?.snapshot(),facility=snapshot?.receipts.at(-1)?.facility;const priority=family==="ice"?[181,134,5]:[182,134,5],primary=setup.haulMode==="SELF_UNLOAD"?priority.find(flag=>summaries.some(h=>h.flagID===flag))??null:summaries.length===1?summaries[0]!.flagID:null;freightStatus={source:"native-ship-holds",observedAt,primaryHoldFlagID:primary,holds:summaries.map(h=>({flagID:h.flagID,capacityM3:h.capacityM3,usedM3:h.usedM3,rawM3:h.rawM3,compressedM3:h.compressedM3,rawQuantity:h.raw.reduce((n,i)=>n+i.quantity,0),compressedQuantity:h.compressed.reduce((n,i)=>n+i.quantity,0)})),pendingCompression:snapshot?!!snapshot.pending:null,facility:facility?{fleetID:facility.fleetID,minerSessionGeneration:facility.minerSessionGeneration,commanderSessionGeneration:facility.commanderSessionGeneration,sourceTypeID:facility.sourceTypeID,compressedTypeID:facility.compressedTypeID,commanderCharacterID:facility.commanderCharacterID,commanderShipID:facility.commanderShipID,rangeMeters:facility.rangeMeters,surfaceDistanceMeters:facility.surfaceDistanceMeters,observedAt:facility.observedAt,sceneSampledAt:facility.sceneSampledAt,systemID:facility.systemID,claimKey:facility.claimKey,claimGeneration:facility.claimGeneration,coreModuleID:facility.coreModuleID,compressorModuleID:facility.compressorModuleID,compressorEffectID:facility.compressorEffectID,facilityTypeListIDs:[...facility.facilityTypeListIDs],matchingTypeListIDs:[...facility.matchingTypeListIDs]}:null};};
 let activeClaim:Claim|null=null;const beforeAction=()=>{current();if(stopRequested()){if(state.pending)throw Error("Fleet mining mutation requires reconciliation before Stop.");throw new FleetStopBeforeDispatch();}if(activeClaim&&(setup.site||injected?.authority)){const a=injected?.authority?.();if(!a||a.state!=="ACTIVE"||!a.claim||a.claim.key!==activeClaim.key||a.claim.generation!==activeClaim.generation||a.claim.operationID!==activeClaim.operationID||a.claim.runID!==activeClaim.runID||a.claim.expiresAt<=Date.now()||targetKey(a.target)!==activeClaim.key||setup.site&&JSON.stringify(a.target)!==JSON.stringify(setup.site.target))throw Error("Exact mining target claim was lost.");}};
 const droneFlight=member.role==="MINER"&&injected?.reportDrones
   ?createMinerDroneFlight(run,session,shipID,current,beforeAction,injected.reportDrones,timing):null;
 type DroneTarget=ReturnType<ReturnType<typeof createMinerDroneFlight>["observeThreat"]>;
 let droneScene:Pick<MiningReadiness,"space"|"observedAt">|undefined;
 async function optionalDroneStep(scene:MiningReadiness,threat:DroneTarget,rock:DroneTarget){
  if(!droneFlight)return null;
  try{return {...await droneFlight.tick(scene.space,threat,rock,scene.observedAt,()=>droneScene),degraded:false};}
  catch(error){
   beforeAction();
   injected?.reportDrones?.(error instanceof FleetObservationUnavailable?"Drone observation unavailable":"Drone flight degraded",
    error instanceof Error?error.message:String(error));
   return {available:false,controlRange:null,degraded:true,combat:droneFlight.combat};
  }
 }
 let droneWork:ReturnType<typeof optionalDroneStep>|null=null;
 let droneRock:DroneTarget=null;
 function serviceDrones(scene:MiningReadiness,threat:DroneTarget,rock:DroneTarget){
  if(!droneFlight)return null;
  // Stop already waits for this flight's current commands before departure.
  droneWork??=optionalDroneStep(scene,threat,rock).catch(()=>null).finally(()=>{droneWork=null;});
  return droneWork;
 }
 const observationUnavailable=(error:unknown):never=>{
  current();
  const {code,status}=(error as {code?:string;status?:number}|null)??{};
  if(error instanceof FleetShipChanged||error instanceof FleetObservationUnavailable||status===401||status===403||
   code==="SESSION_REQUEST_RETIRED"||code==="NO_LIVE_SESSION"||code==="SESSION_NOT_FOUND")throw error;
  throw new FleetObservationUnavailable(error instanceof Error?error.message:String(error),{cause:error});
 };
 let miningTypeData:{key:string;facts:Awaited<ReturnType<typeof fetchTypeDogma>>}|undefined;
 async function modules(){
  current();
  const raw=await loadFitting(options).catch(observationUnavailable);
  current();
  if(raw.activeShipID!==null&&raw.activeShipID!==shipID)throw Error("Fleet mining fitting belongs to another ship.");
  if(raw.activeShipID===null||[raw.errors.slots,raw.errors.shipInfo,raw.errors.online].some(v=>v!==null))
   throw new FleetObservationUnavailable("Fleet mining fitting is temporarily unreadable.");
  const slots=buildSlots(raw.slots,raw.shipInfo,raw.online),high=slots.flatMap(s=>s.family==="high"&&s.module?[s.module]:[]);
  const types=[...new Set(high.map(m=>m.typeID))].sort((a,b)=>a-b),key=types.join(",");
  const facts=miningTypeData?.key===key?miningTypeData.facts:
   await fetchTypeDogma(types,[73,77,182,183,184,1285,1289,1290],options).catch(fleetReadFailed);
  current();
  if(types.every(id=>Object.hasOwn(facts,id)))miningTypeData={key,facts};
  return miningMissionFit(high,facts).filter(m=>m.family===family).map(m=>{const slot=slots.find(s=>s.module?.itemID===m.itemID),flagID=slot?slotFlagOf(slot.family,slot.index):null;if(!flagID)throw Error("Mining module slot is unknown.");return {...m,flagID};});}
 async function moduleState(m:{itemID:number;typeID:number;flagID:number}){current();const raw=await f.bridgeAsk("dogmaIM","ItemGetInfo",[m.itemID]);current();return decodeModuleObservation(raw,{moduleID:m.itemID,typeID:m.typeID,ownerID:run.characterID,shipID,flagID:m.flagID});}
 type Laser=Awaited<ReturnType<typeof modules>>[number];
 type LaserRead={laser:Laser;state?:Awaited<ReturnType<typeof moduleState>>;running?:{targetID:number;rangeM:number}};
 let cachedFit:{modules:Laser[];at:number}|null=null,previousOre:number|null=null,emptyReads=0,lastEmptySample=-1;
 let timingOreBaseline:number|undefined;
 const activating=new Map<number,string>(),shuttingDown=new Set<number>();
 const lockRequests=new Map<number,number>(),refusedModules=new Map<number,number>(),refusedTargets=new Map<number,number>();
 const refusal=(error:unknown)=>{const r=error as {code?:string;status?:number;refusal?:{key?:string}};return r?.code==="CALL_REFUSED"&&r.status===409?r.refusal?.key??"CALL_REFUSED":null;};
 const reads=async(force=false,scene?:MiningReadiness)=>{
   if(force||!cachedFit||approachNow()-cachedFit.at>=5000)cachedFit={modules:await timed(timing,"mining-fitting",modules,undefined,15000),at:approachNow()};
  const ship=scene&&performance.now()-scene.observedAt<=1500?scene.space.ship:null;
  const observed=await Promise.all(cachedFit.modules.map(async (laser):Promise<LaserRead>=>{
   // The held scene publishes native Dogma effects and ranges for running lasers.
   // Missing effects never settle a command or authorize a new activation.
   if(ship&&!activating.has(laser.itemID)&&!shuttingDown.has(laser.itemID)){
    const targetID=ship.activeModuleTargets?.find(t=>t.moduleID===laser.itemID)?.targetID;
    const rangeM=ship.moduleRanges?.find(r=>r.moduleID===laser.itemID)?.rangeM;
    if(targetID!==undefined&&rangeM!==undefined)return {laser,running:{targetID,rangeM}};
   }
   try{return {laser,state:await timed(timing,"mining-module-read",()=>moduleState(laser),{moduleID:laser.itemID},15000)};}
   catch{current();return {laser};}
  }));
  for(const {laser,state,running} of observed){
   if(running)timing?.change("mining-module-active",running.targetID,{moduleID:laser.itemID,targetID:running.targetID},`mining-effect:${laser.itemID}`);
   if(!state)continue;
    if(state.activeTargets.length)timing?.change("mining-module-active",state.activeTargets[0]?.targetID??"unknown-target",
     {moduleID:laser.itemID,targetID:state.activeTargets[0]?.targetID,effectStartFiletime:state.activeTargets[0]?.startFiletime},`mining-effect:${laser.itemID}`);
    else timing?.change("mining-module-inactive","inactive",{moduleID:laser.itemID},`mining-effect:${laser.itemID}`);
   if(!state.activeTargets.length)shuttingDown.delete(laser.itemID);
   const prior=activating.get(laser.itemID);
   if(prior&&(state.activeTargets.length||BigInt(state.wallclockFiletime)>BigInt(prior)))activating.delete(laser.itemID);
  }
  return observed;
 };
 async function suspendBeltModules(force=false){
  const observed=await reads(force);let inactive=true,longest=0;
  for(const {laser,state} of observed){
   if(!state||activating.has(laser.itemID)){inactive=false;continue;}
   if(!state.activeTargets.length)continue;
   inactive=false;longest=Math.max(longest,...state.activeTargets.map(e=>e.durationMs));
   if(shuttingDown.has(laser.itemID)||(refusedModules.get(laser.itemID)??0)>approachNow())continue;
   current();shuttingDown.add(laser.itemID);
   try{await f.bridgeDo("dogmaIM","Deactivate",[laser.itemID,""]);current();}
   catch(error){
    current();
    // A lost reply is reconciled by subsequent effects; a definite rejection
    // can be reconsidered when the exact module is read again.
    if(refusal(error)){shuttingDown.delete(laser.itemID);refusedModules.set(laser.itemID,approachNow()+5000);}
   }
  }
  return {inactive,longest};
 }
 function resetEmpty(){emptyReads=0;lastEmptySample=-1;}
 function emptyBelt(sample:Awaited<ReturnType<typeof readMiningReadiness>>,rocks:ReturnType<typeof claimedBeltRocks>){
  if(rocks.length){resetEmpty();return false;}
  const rows=(sample.raw as {entities?:{itemID?:unknown}[]}|null)?.entities;
  if(!Array.isArray(rows)||rows.length!==sample.space.entities.length||rows.some(row=>!valid(row?.itemID))||
     sample.space.entities.some(e=>(e.kind==="asteroid"||e.categoryID===25)&&!e.geometryAvailable)){
   resetEmpty();throw new FleetObservationUnavailable("Asteroid grid is temporarily unreadable.");
  }
  const sampledAt=sample.space.sampledAtMs!;
  if(sampledAt>lastEmptySample){lastEmptySample=sampledAt;emptyReads++;}
  return emptyReads>=3;
 }
 async function runBeltModules(observed:Awaited<ReturnType<typeof reads>>,rocks:readonly {rock:{itemID:number;position:{x:number;y:number;z:number};radius:number}}[],
  ship:{position:{x:number;y:number;z:number};radius:number}){
  const now=approachNow();
  const idle=observed.flatMap(({laser,state})=>{
   const range=state?.attributes?.[54];
   if(!state?.online||state.activeTargets.length||activating.has(laser.itemID)||
      (refusedModules.get(laser.itemID)??0)>now||typeof range!=="number"||range<=0)return [];
   return [{laser,state,range}];
  });
  if(!idle.length)return;
  const targetRead=await timed(timing,"mining-targets-read",()=>get("/api/bridge/targets").catch(fleetReadFailed),undefined,15000);
   const locked=decodeTargetIDs(targetRead.targetIDs);
   if(Array.isArray(targetRead.notifications))for(const event of targetRead.notifications){
    if(typeof event?.method!=="string"||!Array.isArray(event.args))continue;
    const id=lostLockTarget(event.method,event.args);if(id!==null)lockRequests.delete(id);
   }
  if(!locked)throw new FleetObservationUnavailable("Native mining locks are unreadable.");
  const present=new Set(rocks.map(({rock})=>rock.itemID));
  for(const requests of [lockRequests,refusedTargets])for(const id of requests.keys())if(!present.has(id))requests.delete(id);
  const used=new Set(observed.flatMap(({running,state})=>running?[running.targetID]:state?.activeTargets.flatMap(e=>e.targetID===null?[]:[e.targetID])??[]));
  for(const {laser,state,range} of idle){
   const inRange=rocks.filter(({rock})=>(refusedTargets.get(rock.itemID)??0)<=now&&
    Math.hypot(rock.position.x-ship.position.x,rock.position.y-ship.position.y,rock.position.z-ship.position.z)-rock.radius-ship.radius<=range*.9);
   const lockedInRange=inRange.filter(({rock})=>locked.includes(rock.itemID));
   const pick=lockedInRange.find(({rock})=>!used.has(rock.itemID))??lockedInRange[0]??
    inRange.find(({rock})=>!used.has(rock.itemID))??inRange[0];
   if(!pick)continue;
   const id=pick.rock.itemID;used.add(id);
   if(!locked.includes(id)){
     if((lockRequests.get(id)??0)>now){
      timing?.change("mining-lock-wait",id,{reason:"awaiting-native-asteroid-lock",targetID:id,moduleID:laser.itemID},`mining-lock:${laser.itemID}`);
      continue;
     }
    beforeAction();lockRequests.set(id,now+15000);
     try{const reply=await timed(timing,"mining-add-target-rpc",()=>lockTarget(f.bridgeDo,id,null),{targetID:id,moduleID:laser.itemID});current();
      timing?.note("mining-lock-response",{targetID:id,moduleID:laser.itemID,pending:reply.pending});}
    catch(error){
     current();
     if(refusal(error)){lockRequests.delete(id);refusedTargets.set(id,now+5000);}
     else injected?.reportDrones?.("Checking target lock","Waiting for native lock readback for asteroid "+id+".");
    }
    continue;
   }
    timing?.change("mining-lock-confirmed","locked:"+id,{targetID:id,moduleID:laser.itemID},`mining-lock:${laser.itemID}`);
    lockRequests.delete(id);beforeAction();
   activating.set(laser.itemID,state.wallclockFiletime);
   try{
    // Farmer's repeatable-module sentinel is shaped to the native 1000, or
    // 0 for a non-repeatable effect, by GamePort's retail activation adapter.
     await timed(timing,"mining-activate-rpc",()=>f.bridgeDo("dogmaIM","Activate",[laser.itemID,"",id,-1]),{targetID:id,moduleID:laser.itemID});current();
   }catch(error){
    current();
    const rejected=refusal(error);
    if(rejected){
     activating.delete(laser.itemID);
     if(targetGoneRefusal(error))refusedTargets.set(id,now+5000);
     else refusedModules.set(laser.itemID,now+5000);
     injected?.reportDrones?.("Mining module unavailable","Module "+laser.itemID+": "+rejected);
    }else injected?.reportDrones?.("Checking mining module","Waiting for native effect readback for module "+laser.itemID+".");
   }
  }
 }
 const miningBays=family==="ice"?[["ice",181],["ore",134],["cargo",5]] as const:[["asteroid",182],["ore",134],["cargo",5]] as const;
 async function holds(){
  const panel=await timed(timing,"mining-hold-capacity",()=>get("/api/bridge/ship/ore-hold").catch(observationUnavailable),undefined,15000);
  if(valid(panel.activeShipID)&&panel.activeShipID!==shipID)throw new FleetShipChanged("Fleet mining hold belongs to another ship.");
  if(!valid(panel.activeShipID)||!Array.isArray(panel.holds)||!panel.holds.length)
   throw new FleetObservationUnavailable("Fleet mining hold is temporarily unreadable.");
  const rows:Pick<NativeInventoryRow,"itemID"|"typeID"|"quantity"|"categoryID"|"flagID">[]=[];
  const holds:HoldCapacity[]=[];
  let primary:HoldCapacity|null=null;
  for(const [key,flagID] of miningBays){
   const matches=panel.holds.filter((h:any)=>h?.key===key),hold=matches[0];
   if(matches.length===0)continue;
   const c=hold?.capacity;
   if(matches.length!==1||hold.error!=null||typeof hold.present!=="boolean"||!c||
      !Number.isFinite(c.capacity)||!Number.isFinite(c.used)||c.capacity<0||c.used<0||c.used>c.capacity||
      hold.present!==(c.capacity>0)||!Array.isArray(hold.items)||!hold.present&&hold.items.length||
      hold.items.some((item:any)=>!valid(item?.itemID)||!valid(item?.typeID)||!valid(item?.quantity))){
    if(!primary)throw new FleetObservationUnavailable("Fleet mining hold capacity is temporarily unreadable.");
    continue;
   }
   if(!hold.present)continue;
   const usable={key,present:true,capacity:{capacity:c.capacity,used:c.used}};
   primary??=usable;
   holds.push(usable);
   for(const item of hold.items)rows.push({itemID:item.itemID,typeID:item.typeID,quantity:item.quantity,categoryID:valid(item.categoryID)?item.categoryID:null,flagID});
  }
  if(!primary||new Set(rows.map(r=>r.itemID)).size!==rows.length)
   throw new FleetObservationUnavailable("Fleet mining hold contents are temporarily unreadable.");
  return {rows,observedAt:Date.now(),holds,primary};
 }
 const quantity=(rows:Awaited<ReturnType<typeof holds>>["rows"],typeID:number)=>{const n=rows.filter(r=>r.typeID===typeID).reduce((sum,r)=>sum+r.quantity,0);if(!Number.isSafeInteger(n))throw Error("Native ore quantity is invalid.");return n;};
 const intent=(kind:string,details:unknown)=>{beforeAction();if(state.pending)throw Error("A previous mining mutation needs reconciliation; no replay.");state.pending={kind,details,ownerRunID:run.botID,issuedAt:Date.now()};save();};
 const settled=()=>{state.pending=null;save();};
 const saveApproach=(approach:any)=>{current();const next={...state,approach};document.write(next);state=next;};
 function observeApproach(space:Awaited<ReturnType<typeof readMiningReadiness>>['space'],claim?:Claim){const a=state.approach;if(!a)return true;if(claim&&(a.claimKey!==claim.key||a.claimGeneration!==claim.generation))throw Error("Fleet approach claim changed; reconciliation is required.");const own=space.entities.filter(e=>e.itemID===shipID),targets=space.entities.filter(e=>e.itemID===a.targetID);if(own.length!==1||own[0]!.characterID!==run.characterID||!Number.isFinite(space.sampledAtMs))return false;
  const ship=own[0]!,mode=ship.mode?.toUpperCase(),matches=mode==="FOLLOW"&&ship.targetEntityID===a.targetID&&space.ship?.followRange===a.range;
  // Native scene time can lag WC's wall clock. Compare snapshots from the
  // same clock; issuedAt is only for the local settle and watchdog windows.
  const fresh=space.sampledAtMs!>a.beforeSampledAt;
  const target=targets.length===1?targets[0]:null,physical=!!target&&target.geometryAvailable&&!!space.ship?.geometryAvailable&&Math.max(0,Math.hypot(target.position.x-space.ship.position.x,target.position.y-space.ship.position.y,target.position.z-space.ship.position.z)-target.radius-space.ship.radius)<=a.range;
  if(fresh&&(matches||mode==="STOP"&&physical)){if(a.status!=="observed")saveApproach({...a,status:"observed",observedVia:matches?"follow":"within-range",observedSampledAt:space.sampledAtMs});return true;}
  if(a.status==="observed"&&mode==="STOP"&&space.sampledAtMs!>a.observedSampledAt){saveApproach(null);return true;}
  if(a.status!=="pending"&&a.status!=="observed"&&mode==="STOP"&&fresh&&approachNow()>=a.settleUntil){saveApproach({...a,status:"observed",observedVia:"stopped-after-settle",observedSampledAt:space.sampledAtMs});return true;}
  if(!setup.site&&fresh&&!target&&a.status!=="pending"&&(mode==="STOP"||matches)){
   saveApproach(null);return true;
  }
  if(approachNow()-a.issuedAt>30000)throw Error("Fleet approach outcome remains unresolved; no replay.");return false;
 }

 async function reconcileMiningEffect(){
  const pending=state.pending,details=pending.details,active=pending.activeProof as Awaited<ReturnType<typeof moduleState>>|undefined;
  if(!active||pending.ownerRunID!==cycleOwner||!details||
     ![details.moduleID,details.typeID,details.flagID,details.targetID,details.oreTypeID].every(valid)||
     !Number.isSafeInteger(details.before)||details.before<0||active.moduleID!==details.moduleID||
     active.typeID!==details.typeID||active.flagID!==details.flagID||active.ownerID!==run.characterID||active.shipID!==shipID)
   throw Error("Fleet mining mutation requires reconciliation before Stop.");
  const after=await moduleState({itemID:details.moduleID,typeID:details.typeID,flagID:details.flagID});
  const gain=quantity((await holds()).rows,details.oreTypeID)-details.before;
  const timing=family==="ice"?iceCycleTiming(active,after,details.targetID,gain):null;
  current();
  if(family==="ice"?!timing:!observedOreCycleSettled(active,after,details.targetID,gain))
   throw Error("Fleet mining mutation requires reconciliation before Stop.");
  const next={...state,identity,lastCycle:{...pending,activeObserved:true,gain,observedAt:Date.now(),
   ...(timing?{iceTiming:timing}:{}),reconciledReadOnly:true},pending:null};
  document.write(next);state=next;cycleOwner=run.botID;
 }

 return {droneIDs:()=>droneFlight?.launchedIDs??[],getFreightStatus:()=>freightStatus?structuredClone({...freightStatus,pendingCompression:compression?!!compression.snapshot().pending:null}):null,async quote(){current();const generation=f.sessionGeneration(),fit=await modules(),module=fit[0];if(!module)throw Error("The selected mining module is unavailable for a native quote.");const observed=await moduleState(module),cycleMs=observed.attributes?.[73],scene=await readMiningReadiness(run,session,shipID,setup.systemID,current);current();if(f.sessionGeneration()!==generation||!scene.ready||!Number.isSafeInteger(generation)||generation<0||typeof cycleMs!=="number"||!Number.isFinite(cycleMs)||cycleMs<=0||!Number.isFinite(scene.space.sampledAtMs))throw Error("The native mining quote is unavailable.");return {characterID:run.characterID,shipID,botID:run.botID,sessionGeneration:generation,moduleID:module.itemID,typeID:module.typeID,family,cycleMs,timeFiletime:observed.timeFiletime,sceneSampledAtMs:scene.space.sampledAtMs!,observedAt:Date.now()};},async tick(target,claim,jettisonReady=true,arrival?:MiningReadiness,jettison?:Parameters<MiningCycle["tick"]>[4]){freightStatus=null;activeClaim=claim;
  if(state.pending?.kind==="mining-cycle"&&state.pending.activeProof){
   await reconcileMiningEffect();
   return "blocked" as const;
  }
  beforeAction();if(state.pending)throw Error("A previous mining mutation needs reconciliation; no replay.");if(claim.generation<=0||claim.operationID!==setup.operationID||claim.runID!==setup.operationRunID||claim.key!==targetKey(target)||target.systemID!==setup.systemID||(setup.site?JSON.stringify(target)!==JSON.stringify(setup.site.target):target.kind!=="BELT"||target.name!==setup.beltName))throw Error("Fleet mining claim changed.");
   // Navigation validated the exact belt, pilot and flight just before this turn.
   // A delayed Travel Assist settlement or a different scene needs a fresh read.
   const recentArrival=!setup.site&&arrival?.ready&&arrival.space.shipID===shipID&&arrival.space.solarSystemID===setup.systemID&&
    performance.now()-arrival.observedAt<=1500;
   const initialScene=recentArrival?arrival:await readMiningReadiness(run,session,shipID,setup.systemID,current,timing,"mining-cycle",undefined,false)
    .catch(error=>{resetEmpty();return observationUnavailable(error);});
   if(droneFlight)droneScene=initialScene.ready?{space:initialScene.space,observedAt:initialScene.observedAt}:undefined;
   if(!initialScene.ready){resetEmpty();return "blocked" as const;}
  const space=initialScene.space,belt=!setup.site;
  const mineThroughJettison=belt&&member.role==="MINER"&&setup.haulMode!=="SELF_UNLOAD";
  const threat=droneFlight?.observeThreat(space)??null;
  const priorRock=family==="ore"&&droneRock?space.entities.find(r=>r.itemID===droneRock?.itemID&&r.typeID===droneRock.typeID)??null:null;
  const earlyDrones=threat||droneFlight?.combat?serviceDrones(initialScene,threat,priorRock):null;
  const beltRocks=belt?(await rocksAt(space).catch(error=>{resetEmpty();return observationUnavailable(error);})).filter(r=>r.remainingQuantity!==0):null;
  const depleted=beltRocks!==null&&emptyBelt(initialScene,beltRocks);
    if(depleted&&setup.haulMode!=="SELF_UNLOAD")return "depleted" as const;
   const fit=belt?[]:await modules(),module=fit[0];
  const currentHold=await holds();
   if(setup.haulMode==="SELF_UNLOAD"&&currentHold.primary.capacity.used>=currentHold.primary.capacity.capacity*.9)
    return belt&&!(await suspendBeltModules()).inactive?"blocked" as const:"hold-full" as const;
   if(depleted)return "depleted" as const;
   const approachWaiting=state.approach&&!observeApproach(space,claim);
   if(approachWaiting){
    timing?.change("mining-approach-wait",state.approach.issuedAt,{reason:"awaiting-native-approach",targetID:state.approach.targetID,
     commandAtMs:state.approach.issuedAt,sceneSampledAtMs:space.sampledAtMs});
    if(!mineThroughJettison||!jettison||!jettisonReady)return "blocked" as const;
   }
   if(compression?.snapshot().pending){
    if(!await compression.reconcile())throw Error("Compression outcome remains unknown; no replay.");
    return "blocked" as const;
   }
   const onGrid=beltRocks??await rocksAt(space).catch(observationUnavailable);
   const rocks=onGrid.filter(r=>belt||!state.retired.includes(r.itemID));
   const holdTypes=currentHold.rows.map(r=>r.typeID);
   const rockTypes=rocks.map(r=>r.miningYieldTypeID??r.typeID).filter(valid);
   const dropThreshold=compression?Math.min(RAW_JETTISON_THRESHOLD,setup.oreLogistics?.compressedJettisonFraction??COMPRESSED_JETTISON_THRESHOLD):RAW_JETTISON_THRESHOLD;
   const freightFirst=mineThroughJettison&&!!jettison&&jettisonReady&&currentHold.holds.some(({capacity})=>
    capacity.used+1e-9>=capacity.capacity*dropThreshold);
   let candidates=await typeFacts(freightFirst?holdTypes:[...new Set([...rockTypes,...holdTypes])]);
   let summaries:ReturnType<typeof summarizeFreight>=[];
   try{
    summaries=summarizeFreight(currentHold.rows,currentHold.holds,candidates,family);
    recordFreight(summaries,currentHold.observedAt);
   }catch(error){
    if(compression)throw error;
    freightStatus=null;
   }
   if(timing?.verbose&&belt){
    const quantity=currentHold.rows.filter(r=>candidates[r.typeID]?.freightKind==="RAW"&&candidates[r.typeID]?.resourceFamily==="ore")
     .reduce((total,r)=>total+r.quantity,0);
    if(timingOreBaseline===undefined||quantity>timingOreBaseline){
     const evidence={quantity,holdObservedAtMs:currentHold.observedAt,claimGeneration:claim.generation};
     if(timingOreBaseline===undefined)timing.note("mining-ore-baseline",evidence);
     else timing.change("mining-first-ore-increase",claim.generation,{...evidence,before:timingOreBaseline});
    }
    timingOreBaseline=quantity;
   }
   const dropSelection=(flush:boolean)=>{
    const selected=selectFreight(summaries,{flush,includeCompressed:!!compression,
     compressedThreshold:setup.oreLogistics?.compressedJettisonFraction,canCapacityM3:setup.canCapacityM3});
    if(selected?.oversize.length)throw Error("A freight stack exceeds the physical can capacity.");
    return selected?.items??[];
   };
    const drop=async(items:ReturnType<typeof dropSelection>)=>{
     if(!jettison)return true;
     const selectedAtMs=Date.now();
     const sources=new Map(currentHold.rows.map(row=>[row.itemID,row]));
     const flags=[...new Set(items.map(item=>sources.get(item.itemID)!.flagID))];
     const exact=await timed(timing,"mining-hold-rows",()=>readNativeShipHolds(session,current,run.characterID,shipID,flags).catch(observationUnavailable),undefined,15000);
     const byID=new Map(exact.map(row=>[row.itemID,row]));
     const refreshed:typeof items=[];
     let grew=false;
     for(const item of items){
      const row=byID.get(item.itemID);
      if(!row||row.typeID!==item.typeID||row.flagID!==sources.get(item.itemID)!.flagID||
         row.quantity<item.quantity||!mineThroughJettison&&row.quantity!==item.quantity)return false;
      if(row.quantity>item.quantity)grew=true;
      refreshed.push({...item,quantity:row.quantity});
     }
     // Laser or drone yield can land between the panel and the exact list.
     // Accept growth only if the original bay still holds at least the old stacks.
     if(grew&&(currentHold.rows.some(old=>{
      if(!flags.includes(old.flagID))return false;
      const row=byID.get(old.itemID);
      return !row||row.typeID!==old.typeID||row.flagID!==old.flagID||row.quantity<old.quantity;
     })||refreshed.reduce((volume,item)=>volume+item.quantity*item.unitVolumeM3,0)>setup.canCapacityM3+1e-9))return false;
     const hold=summaries.find(summary=>summary.flagID===flags[0]);
     beforeAction();
     return jettison(refreshed,{selectedAtMs,holdObservedAtMs:currentHold.observedAt,sceneSampledAtMs:space.sampledAtMs,
      holdUsedM3:hold?.usedM3,holdCapacityM3:hold?.capacityM3});
    };
   let consideredDrop=false;
   if(jettisonReady&&setup.haulMode!=="SELF_UNLOAD"&&summaries.some(h=>h.raw.length||compression&&h.compressed.length)){
    const items=dropSelection(false);
    consideredDrop=items.length>0;
     if(consideredDrop&&await drop(items)){
     return belt&&!mineThroughJettison&&!(await suspendBeltModules()).inactive?"blocked" as const:"hold-full" as const;
    }
   }
   if(approachWaiting)return "blocked" as const;
   if(compression&&injected?.commandSupport?.()){
    const largest=typeof state.maxRawIncrementM3==="number"&&Number.isFinite(state.maxRawIncrementM3)&&state.maxRawIncrementM3>0?state.maxRawIncrementM3:null;
    const candidate=summaries.flatMap(h=>h.raw.map(item=>({item,volume:item.quantity*item.unitVolumeM3,
     threshold:Math.max(.05*h.capacityM3,Math.min(.10*h.capacityM3,largest===null?.10*h.capacityM3:2*largest)),
    }))).find(x=>x.volume>=x.threshold);
    if(candidate){
     beforeAction();
     try{
      const result=await compression.compress(candidate.item.itemID);
      if(!result&&compression.snapshot().pending)throw Error("Compression outcome remains unknown; no replay.");
      if(result)return "blocked" as const;
     }catch(error){
      current();
      if(error instanceof FleetStopBeforeDispatch||compression.snapshot().pending)throw error;
     }
    }
   }
   if(!rocks.length){
    if(belt)return "blocked" as const;
    throw Error("No exact claimed-source asteroid is observable.");
   }
   if(rocks.some(r=>!r.geometryAvailable))throw Error("Asteroid geometry is unreadable.");
   if(freightFirst){
    const missing=[...new Set(rockTypes.filter(typeID=>!Object.hasOwn(candidates,typeID)))];
    if(missing.length)candidates={...candidates,...await typeFacts(missing)};
   }
   const ore=rocks.flatMap(r=>{const typeID=r.miningYieldTypeID??r.typeID,fact=typeID?candidates[typeID]:null;return typeID&&fact?.categoryID===25&&fact.freightKind==="RAW"&&fact.resourceFamily===family&&fact.unitVolumeM3>0?[{rock:r,typeID,volume:fact.unitVolumeM3}]:[];});
   if(!ore.length)throw Error("No source-qualified raw ore asteroid is visible.");
   // EveJS fills the first compatible mining bay. Ordinary cargo is only a fallback
   // for ships without a compatible mining bay.
    const {capacity,used}=currentHold.primary.capacity;
    const freeVolume=capacity-used;
   const eligible=ore.filter(x=>freeVolume>=x.volume);
   if(!eligible.length){
    if(jettison&&jettisonReady&&!consideredDrop){
     const items=dropSelection(true);
      if(items.length)await drop(items);
    }
    return belt&&!mineThroughJettison&&!(await suspendBeltModules()).inactive?"blocked" as const:"hold-full" as const;
   }
   const available=[...preferredQualifiedResources(eligible,setup.resourcePolicy)];
  const ship=space.ship;if(!ship)throw Error("Fleet mining ship is unavailable.");available.sort((a,b)=>{const d=(x:typeof a)=>Math.max(0,Math.hypot(x.rock.position.x-ship.position.x,x.rock.position.y-ship.position.y,x.rock.position.z-ship.position.z)-x.rock.radius-ship.radius);return d(a)-d(b);});
   const beltFit=belt?await reads(false,initialScene):[];
   const surfaceDistance=(rock:typeof available[number]["rock"])=>Math.max(0,Math.hypot(rock.position.x-ship.position.x,rock.position.y-ship.position.y,rock.position.z-ship.position.z)-rock.radius-ship.radius);
   const working=available.find(({rock})=>beltFit.some(({state,running})=>running?
    running.targetID===rock.itemID&&surfaceDistance(rock)<=running.rangeM:
    state?.activeTargets.some(effect=>effect.targetID===rock.itemID)&&typeof state.attributes?.[54]==="number"&&surfaceDistance(rock)<=state.attributes[54]));
   const chosen=working??available[0]!;
   const distance=surfaceDistance(chosen.rock);
   const beltRanges=beltFit.flatMap(({state,running})=>running?[running.rangeM]:state?.online&&typeof state.attributes?.[54]==="number"&&state.attributes[54]>0?[state.attributes[54]]:[]);
   if(beltFit.length&&beltFit.every(x=>!x.state&&!x.running))throw new FleetObservationUnavailable("Mining module effects are temporarily unreadable.");
   droneRock=family==="ore"?chosen.rock:null;
   const work=earlyDrones??(droneRock?serviceDrones(initialScene,threat,droneRock):null);
   const drones=beltRanges.length||module?null:await work;
   const range=beltRanges.length?Math.min(...beltRanges):module?(await moduleState(module)).attributes?.[54]:drones?.controlRange;
   if(!module&&!range){
   if(drones?.available||drones?.degraded||drones?.combat||!!threat)return "blocked" as const;
   throw Error(family==="ice"?"No online ice harvesting module is fitted.":"No online mining module or usable mining drone flight is available.");
  }
  if(typeof range!=="number"||range<=0)throw Error("Native mining range is unavailable.");
   const operatingRange=module||beltRanges.length?range*.9:range;
   timing?.change("mining-range",distance>operatingRange?"outside":"inside",{reason:distance>operatingRange?"outside":"inside",
    targetID:chosen.rock.itemID,meters:Math.round(distance),rangeM:operatingRange,sceneSampledAtMs:space.sampledAtMs});
  if(distance>operatingRange&&!working){
   if(beltRanges.some(value=>distance<=value*.9))await runBeltModules(beltFit,available,ship);
   const distanceToKeep=Math.max(50,range*.7),prior=state.approach;if(prior?.status==="observed"&&prior.targetID===chosen.rock.itemID&&prior.range===distanceToKeep&&prior.observedVia!=="stopped-after-settle")return "blocked" as const;if(prior?.status==="observed"&&prior.observedVia==="stopped-after-settle")saveApproach(null);
   if(prior&&prior.status!=="observed")return "blocked" as const;await injected?.movementAdmission?.();beforeAction();await injected?.travelAssist?.beforeApproach(`${claim.key}:${claim.generation}:${chosen.rock.itemID}`,distance,distanceToKeep,chosen.rock.itemID);beforeAction();const admitted=await readMiningReadiness(run,session,shipID,setup.systemID,current,timing,"asteroid-pre-approach");if(!admitted.ready)return "blocked" as const;const admittedRock=(await rocksAt(admitted.space)).find(r=>r.itemID===chosen.rock.itemID&&r.typeID===chosen.rock.typeID),admittedShip=admitted.space.ship;if(!admittedRock||!admittedShip)return "blocked" as const;const admittedDistance=Math.max(0,Math.hypot(admittedRock.position.x-admittedShip.position.x,admittedRock.position.y-admittedShip.position.y,admittedRock.position.z-admittedShip.position.z)-admittedRock.radius-admittedShip.radius);if(admittedDistance<=operatingRange){await injected?.travelAssist?.settle();return "blocked" as const;}beforeAction();const sampled=admitted.space.sampledAtMs;if(!Number.isFinite(sampled))throw Error("Native approach scene time is unavailable.");const issuedAt=approachNow(),attempt={targetID:chosen.rock.itemID,range:distanceToKeep,claimKey:claim.key,claimGeneration:claim.generation,issuedAt,beforeSampledAt:sampled,settleUntil:issuedAt+APPROACH_SETTLE_MS,status:"pending"};saveApproach(attempt);
   try{beforeAction();}catch(error){if(error instanceof FleetStopBeforeDispatch)saveApproach(null);throw error;}
   try{await timed(timing,"asteroid-approach-rpc",()=>f.approachShip(attempt.targetID,attempt.range),{targetID:attempt.targetID,rangeM:attempt.range});current();saveApproach({...attempt,status:"acknowledged"});}catch(error){current();const e=error as any;if(e?.code==="CALL_REFUSED"&&e.status===409&&e.refusal?.key==="ThrottleGeneric"){saveApproach({...attempt,status:"refused",refusal:{code:e.code,status:e.status,detail:structuredClone(e.refusal)}});return "blocked" as const;}throw error;}return "blocked" as const;}
   if(belt){
    await injected?.travelAssist?.settle();if(injected?.movementArrived?.())return "blocked" as const;
    await runBeltModules(beltFit,available,ship);
    const observed=currentHold.rows.filter(r=>candidates[r.typeID]?.freightKind==="RAW"&&candidates[r.typeID]?.resourceFamily==="ore").reduce((total,r)=>total+r.quantity,0);
    const gained=previousOre!==null&&observed>previousOre;previousOre=observed;
    return gained?"yield" as const:"blocked" as const;
   }
   if(!module)return "blocked" as const;
  const fresh=await readMiningReadiness(run,session,shipID,setup.systemID,current);if(!fresh.ready)return "blocked" as const;
  const refreshed=(await rocksAt(fresh.space)).find(r=>r.itemID===chosen.rock.itemID&&r.typeID===chosen.rock.typeID);
  if(!refreshed||!fresh.space.ship)return "blocked" as const;
  const freshDistance=Math.max(0,Math.hypot(refreshed.position.x-fresh.space.ship.position.x,refreshed.position.y-fresh.space.ship.position.y,refreshed.position.z-fresh.space.ship.position.z)-refreshed.radius-fresh.space.ship.radius);
  if(freshDistance>range*.9)return "blocked" as const;await injected?.travelAssist?.settle();if(injected?.movementArrived?.())return "blocked" as const;
  const scope=JSON.stringify([identity,claim.key,claim.generation,chosen.rock.itemID,chosen.typeID]);intent("target-lock",{scope,targetID:chosen.rock.itemID});
  try{const receipt=await lockTarget(f.bridgeDo,chosen.rock.itemID,null);current();state.pending.receipt=receipt;save();}catch(error){if(isDefiniteWarpRefusal(error)){current();const pending=state.pending;const next=reconcileDefiniteLockRefusal(state,{characterID:run.characterID,shipID,targetID:chosen.rock.itemID,runID:run.botID,issuedAt:pending.issuedAt,observedAt:Date.now(),error});current();document.write(next);state=next;return "blocked" as const;}if(!targetGoneRefusal(error))throw error;current();state.retired=[...state.retired,chosen.rock.itemID];state.lastRefusal={intent:state.pending,refusal:(error as any).refusal,observedAt:Date.now()};settled();return "blocked" as const;}
  const originalLock=structuredClone(state.pending);let locked=false;for(let i=0;i<5;i++){current();const ids=decodeTargetIDs((await get("/api/bridge/targets")).targetIDs);if(ids?.includes(chosen.rock.itemID)){locked=true;break;}await wait(1000);}
  if(locked)settled();if(stopRequested()){if(!locked)throw Error("Target lock remains unresolved during Stop.");return "blocked" as const;}
  const before=quantity((await holds()).rows,chosen.typeID),cycleMs=(await moduleState(module)).attributes?.[73];if(typeof cycleMs!=="number"||cycleMs<=0)throw Error("Native mining cycle duration is unavailable.");
  const activation=await activateDuringOriginalLock({characterID:run.characterID,shipID,moduleID:module.itemID,targetID:chosen.rock.itemID,mission:scope,lockOrdinal:originalLock.issuedAt,lockIssuedAt:originalLock.issuedAt},{current,nextOrdinal:state.nextOrdinal,wait,confirmLock:async()=>decodeTargetIDs((await get("/api/bridge/targets")).targetIDs)?.includes(chosen.rock.itemID)===true,
   savePending(attempt){beforeAction();state.nextOrdinal=attempt.ordinal+1;state.pending={kind:"mining-cycle",ownerRunID:run.botID,issuedAt:attempt.issuedAt,originalLock,attempt,details:{scope,moduleID:module.itemID,typeID:module.typeID,flagID:module.flagID,targetID:chosen.rock.itemID,oreTypeID:chosen.typeID,before,cycleMs}};save();},
   saveRefusal(refusal){current();state.lastActivationRefusal=refusal;state.pending=originalLock;save();},
   async native(id,opts){beforeAction();return f.bridgeDo("dogmaIM","Activate",[id,"",opts.targetID,opts.repeat]);}});
  state.pending.receipt=activation.result;save();const result=await observeMiningCycle({targetID:chosen.rock.itemID,cycleMs,before,current,module:()=>moduleState(module),quantity:async()=>quantity((await holds()).rows,chosen.typeID),
   onActive(observed){if(!state.pending.activeProof){state.pending.activeProof=observed;save();}},onProgress(){},wait});
  if(family==="ice"){const active=state.pending.activeProof as Awaited<ReturnType<typeof moduleState>>|undefined,after=await moduleState(module),timing=active&&iceCycleTiming(active,after,chosen.rock.itemID,result.gain);if(!timing)throw Error("Full native ice cycle is not proven; activation remains fenced.");state.pending.iceTiming=timing;}
  state.lastCycle={...state.pending,activeObserved:true,gain:result.gain,observedAt:result.observedAt};settled();return "yield" as const;
 },async stop(){current();await droneWork;current();if(compression?.snapshot().pending&&!await compression.reconcile())throw Error("Compression outcome remains unknown; Stop retains custody.");if(state.approach&&state.approach.status!=="observed"){const scene=await readMiningReadiness(run,session,shipID,setup.systemID,current);if(!scene.ready||!observeApproach(scene.space))throw Error("Fleet approach outcome remains unresolved; Stop retains custody.");}if(state.pending?.kind==="mining-cycle")await reconcileMiningEffect();
  if(state.pending?.kind==="target-lock"&&state.pending.ownerRunID===cycleOwner&&valid(state.pending.details?.targetID)){
  const locked=(await get("/api/bridge/targets")).targetIDs;
  if(!Array.isArray(locked)||locked.some(id=>!valid(id)))throw Error("Native target-lock readback is unavailable during Stop.");
  // A lock changes no cargo or module state. Preserve the exact attempt and the
  // observed lock list before proceeding with the independent native shutdown.
   const next={...state,identity,lastStoppedLock:{intent:state.pending,locked:locked.includes(state.pending.details.targetID),observedAt:Date.now()},pending:null};
   current();document.write(next);state=next;cycleOwner=run.botID;
 }
 if(state.pending)throw Error("Fleet mining mutation requires reconciliation before Stop.");
   if(!setup.site){
    const first=await suspendBeltModules(true),until=approachNow()+Math.min(305000,Math.max(10000,first.longest)+30000);
    for(let ready=first.inactive;!ready;){
     if(approachNow()>=until)throw Object.assign(Error("Mining modules have not confirmed native shutdown."),{code:"MCC_MODULE_SHUTDOWN_PENDING"});
     await wait(1500);current();ready=(await suspendBeltModules()).inactive;
    }
   }else for(const m of await modules()){const observed=await moduleState(m);if(observed.activeTargets.length)throw Error("A mining module remains active; Stop needs native settlement.");}
   await droneFlight?.settle();
 },async release(){current();if(compression?.snapshot().pending&&!await compression.reconcile())throw Error("Compression outcome remains unknown; release retains custody.");if(state.approach&&state.approach.status!=="observed")throw Error("Fleet approach outcome remains unresolved; no release.");if(state.pending)throw Error("Fleet mining mutation requires reconciliation before release.");state.closed=true;save();}};
}
