import {projectFleetRun,type HostedRow,type RunOwner} from "../../operations/miningReadout.ts";
/** WC74 MCC API seam (original web/src/app/api.ts @ 213da333).
 * Saved definitions use the plugin control plane; native fleet services still
 * go through the shared facade and must report unsupported capabilities. */
import {authenticatedJson,type ApiOptions} from "../app/context.ts";
import type {MiningOperationDefinition,MiningOperationsPayload,MiningOperationLaunchPlan} from "../app/api.ts";
import type {StopFreightMode} from "../../miningFleet/operation.ts";
import {pilotDockedAtHome} from "./miningRecovery.ts";
export {
 extendMiningOperation,listMiningResources,findMapLocations,findAccessibleStructures,
 getMiningPreparationOptions,listVerifiedOperationPilots,listOperationRoutines,
 resolveDestination,resolveAccessibleStructure,startMiningOperation,stopMiningOperation,relocateMiningOperation,
} from "../app/api.ts";
export type {
 MiningResourceChoice,VerifiedOperationPilot,OperationPilotChoice,OperationRoutineSummary,MiningOperationDefinition,
 MiningOperationMemberDefinition,MiningOperationRuntime,MiningOperationsPayload,MiningOperationLaunchPlan,
} from "../app/api.ts";
const prefix="/api/plugins/uoc/mining-operations";
export async function requestMiningStop(operationID:string,operationRunID:string,mode:StopFreightMode,options:ApiOptions={}){
 const result=await authenticatedJson(`${prefix}/${encodeURIComponent(operationID)}/stop`,options,{operationRunID,mode});
 if((result.mode!=="RETURN_HOME"&&result.mode!=="COLLECT_FREIGHT")||typeof result.live!=="boolean")
  throw Error("The saved Stop choice could not be verified.");
 return {mode:result.mode as StopFreightMode,live:result.live as boolean,finishAtHome:result.finishAtHome===true};
}
function payload(value:unknown):MiningOperationsPayload {
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Mining operation response is unreadable.");
 const row=value as Record<string,unknown>;
 if(!Array.isArray(row.operations)||!Array.isArray(row.targetBoard)||!row.capabilities||typeof row.capabilities!=="object"||Array.isArray(row.capabilities))throw Error("Mining operation response is incomplete.");
 return value as MiningOperationsPayload;
}
export async function loadMiningOperations(options:ApiOptions={},
  closeOfflineStop?:{operationID:string;operationRunID:string}):Promise<MiningOperationsPayload>{
 const [rawOperations,bots]=await Promise.all([authenticatedJson(prefix,options),authenticatedJson("/api/bots",options)]);
 const result=payload(rawOperations),policy=bots?.hostedRunPolicy;
 if(!policy||typeof policy!=="object"||!Number.isSafeInteger(policy.maxRuntimeMinutes)||policy.maxRuntimeMinutes<=0||!Number.isSafeInteger(policy.defaultRuntimeMinutes)||policy.defaultRuntimeMinutes<=0||policy.defaultRuntimeMinutes>policy.maxRuntimeMinutes||!Array.isArray(policy.durationChoices)||!policy.durationChoices.length||policy.durationChoices.some((n:unknown)=>typeof n!=="number"||!Number.isSafeInteger(n)||n<=0||n>policy.maxRuntimeMinutes))throw Error("The current hosted run policy is unavailable.");
 if(closeOfflineStop){
  const selected=result.operations.find(row=>row.definition.operationID===closeOfflineStop.operationID)?.runtime;
  if(!selected?.operationRunID&&selected?.unverifiedStop?.operationRunID===closeOfflineStop.operationRunID)
   return {...result,capabilities:{...result.capabilities,hostedRunPolicy:policy}};
  if(selected?.operationRunID!==closeOfflineStop.operationRunID||!selected.canCloseOfflineStop)
   throw Error("This Stop has changed or still has an active controller. Refresh and check the fleet.");
 }
 type OwnershipCandidate={operationID:string;operationRunID:string;endStopped?:boolean;closeOfflineStop?:true};
 const candidates:OwnershipCandidate[]=[];
 const operations=await Promise.all(result.operations.map(async row=>{
  const runtime=row.runtime;
  if(!runtime.operationRunID||closeOfflineStop&&row.definition.operationID!==closeOfflineStop.operationID)return row;
  const launch=await authenticatedJson<{receipt:FleetLaunchReceipt|null}>(
   `${prefix}/${encodeURIComponent(row.definition.operationID)}/launch`,options).catch(()=>null);
  const receipt=launch?.receipt;
  if(!receipt||receipt.operationID!==row.definition.operationID||receipt.operationRunID!==runtime.operationRunID)
   return runtime.canCloseOfflineStop?{...row,runtime:{...runtime,canCloseOfflineStop:false}}:row;
  const reads=new Map<number,{owners:readonly RunOwner[];bots:readonly HostedRow[];offline?:boolean;dockedForUnload?:boolean} | null>();
  const accounts=new Map<number,ApiOptions>();
  const started=receipt.members.filter(member=>member.status!=="PREPARED");
  await Promise.all(started.map(async member=>{
   try{
    const owned=await ownerOptions(member.accountName);
    const [current,host]=await Promise.all([
     authenticatedJson('/api/plugins/uoc/runs/current',owned),
     authenticatedJson('/api/bots',owned),
    ]);
    if(!Array.isArray(current.runs)||!Array.isArray(host.bots)||
       host.bots.some((bot:HostedRow)=>typeof bot.botID!=="string"||!Number.isSafeInteger(bot.characterID)||
        bot.endedAt!==null&&typeof bot.endedAt!=="string"))throw Error("Current hosted owners are unreadable.");
    const owners:RunOwner[]=current.runs, bots:HostedRow[]=host.bots;
    reads.set(member.characterID,{owners,bots});
    accounts.set(member.characterID,owned);
   }catch{reads.set(member.characterID,null);}
  }));
  const hasHost=(characterID:number)=>{
   const read=reads.get(characterID);
   return !!read&&(read.owners.some(owner=>owner.characterID===characterID&&owner.operationRunID===receipt.operationRunID&&owner.operationID===receipt.operationID)||
    read.bots.some(bot=>bot.characterID===characterID&&bot.endedAt===null));
  };
  const canObserve=started.every(member=>!!accounts.get(member.characterID)?.token&&!hasHost(member.characterID));
  // Release remains observable after the last hosted controller has ended.
  await Promise.all(runtime.members.map(async member=>{
    const pending=runtime.stopUnload?.characterIDs.includes(member.characterID)?runtime.stopUnload.parking:undefined;
    if(hasHost(member.characterID)||!pending&&!canObserve&&!["DOCK_VERIFIED","SETTLED_IN_PLACE"].includes(member.parkingState??""))return;
    const read=reads.get(member.characterID),owned=accounts.get(member.characterID);
    if(!read||!owned)return;
    const [status,atHome]=await Promise.all([
     authenticatedJson(`/api/pilot-training/ownership?characterID=${member.characterID}`,owned).catch(()=>null),
     pending&&pending.kind==="station"?pilotDockedAtHome(member.characterID,pending,owned).catch(()=>false):false,
    ]);
    read.offline=status?.ownership?.characterID===member.characterID&&status.ownership.owner==="OFF"&&status.ownership.online===false;
    read.dockedForUnload=read.offline&&atHome;
  }));
  const offline=canObserve&&started.every(member=>reads.get(member.characterID)?.offline===true);
  if(closeOfflineStop&&!offline){
   const unverified=started.filter(member=>!reads.get(member.characterID)?.offline)
    .map(member=>runtime.members.find(pilot=>pilot.characterID===member.characterID)?.characterName??member.accountName);
   throw Error(`Offline release could not be verified for ${unverified.join(", ")}.`);
  }
  if(canObserve){
   candidates.push({operationID:receipt.operationID,operationRunID:receipt.operationRunID,
    ...(runtime.stopFreight&&offline?{endStopped:true}:{}),...(closeOfflineStop?{closeOfflineStop:true}:{})});
  }
  const projected=projectFleetRun(receipt,reads,[],runtime.state,runtime.members);
  const state=runtime.state==="STOPPED"?"PARKING":runtime.state;
  return {...row,runtime:{...runtime,state,
   ...(runtime.canCloseOfflineStop?{canCloseOfflineStop:offline}:{}),
   members:runtime.members.map(member=>{
    const observed=projected.members.find(m=>m.characterID===member.characterID);
    return {...member,...observed,phase:observed?.phase??member.phase,parkingState:observed&&"parkingState" in observed?observed.parkingState??member.parkingState:member.parkingState};
   }),
   startedAt:projected.startedAt??runtime.startedAt,
   preparation:retainedPreparation(runtime.preparation,projected.preparation,row.definition.members),
   stopFailures:projected.stopFailures,
  }};
 }));
 if(closeOfflineStop&&!candidates.length)throw Error("The exact offline Stop could not be verified.");
 if(candidates.length){
  const request=authenticatedJson(`${prefix}/observe`,options,{generations:candidates}).then(payload);
  const outcome=await (closeOfflineStop?request:request.catch(()=>null));
  if(closeOfflineStop){
   const selected=outcome?.operations.find(row=>row.definition.operationID===closeOfflineStop.operationID)?.runtime;
   if(selected?.operationRunID||selected?.unverifiedStop?.operationRunID!==closeOfflineStop.operationRunID)
    throw Error("The offline Stop could not be closed. A current owner or a changed fleet generation may still need attention.");
  }
  if(outcome){
   for(const [index,item] of operations.entries()){
    const updated=outcome.operations.find(row=>row.definition.operationID===item.definition.operationID);
    if(updated&&!updated.runtime.operationRunID&&item.runtime.operationRunID)
     operations[index]=updated;
   }
   return {...outcome,operations,capabilities:{...outcome.capabilities,hostedRunPolicy:policy}};
  }
 }
 return {...result,operations,capabilities:{...result.capabilities,hostedRunPolicy:policy}};
}
export async function markMiningBeltSafe(targetKey:string,options:ApiOptions={}):Promise<MiningOperationsPayload>{
 return payload(await authenticatedJson("/api/plugins/uoc/mining-targets/mark-safe",options,{targetKey}));
}
export async function resetDepletedMiningBelt(targetKey:string,options:ApiOptions={}):Promise<MiningOperationsPayload>{
 return payload(await authenticatedJson("/api/plugins/uoc/mining-targets/reset-depleted",options,{targetKey}));
}
export async function saveMiningOperation(definition:MiningOperationDefinition,options:ApiOptions={}):Promise<MiningOperationsPayload>{return payload(await authenticatedJson(prefix,options,definition));}
export async function deleteMiningOperation(operationID:string,revision:number,options:ApiOptions={}):Promise<MiningOperationsPayload>{
 if(!Number.isSafeInteger(revision)||revision<=0)throw Error("The saved operation revision is unavailable; reload before deleting.");
 return payload(await authenticatedJson(`${prefix}/${encodeURIComponent(operationID)}/delete`,options,{revision}));
}
export async function getMiningOperationLaunchPlan(operationID:string,options:ApiOptions={}):Promise<MiningOperationLaunchPlan>{
 const value=await authenticatedJson(`${prefix}/${encodeURIComponent(operationID)}/launch-plan`,options);
 if(!value||typeof value.planHash!=="string"||!Array.isArray(value.warnings)||!Array.isArray(value.members))throw Error("Mining launch review is incomplete.");
 return value as MiningOperationLaunchPlan;
}
import {checkPluginRun,createPluginRunGrant,startPluginRun,listServerBots,type JsonValue,type PluginRunPolicy} from "../../../../web/src/plugin-api/index.ts";
import {ownerOptions,runHosted} from "../app/context.ts";
import {createMiningFleetHost,type FleetHostServices,type CheckedFleetMember} from "../../operations/miningHosted.ts";
import type {SavedDefinition} from "../../operations/miningStore.ts";
import type {FleetInspection} from "../../operations/miningBind.ts";
import type {FleetLaunchReceipt} from "../../operations/miningLaunchJournal.ts";
import {jettisonCapacityFromDogma} from "../../miningFleet/canCapacity.ts";

const positiveID=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>0;
type AccountPilot={
 characterID:unknown;corporationID?:unknown;solarSystemID?:unknown;stationID?:unknown;
 raw?:{shipID?:unknown;structureID?:unknown;shipName?:unknown};
};
/** The account roster identifies the expected hull. Bot Host verifies the active hull before running it. */
function planningPilot(row:AccountPilot|null,characterID:number,systemID:number):Omit<FleetInspection,"belts"|"canCapacityM3"> {
 const raw=row?.raw;
 const shipID=raw?.shipID,corporationID=row?.corporationID,solarSystemID=row?.solarSystemID;
 if(row?.characterID!==characterID||!positiveID(shipID)||!positiveID(corporationID)||!positiveID(solarSystemID))
  throw Error("The account roster has no exact active ship Item ID. Use Review member readiness to inspect this pilot.");
 const dock=positiveID(raw?.structureID)?{stationID:raw.structureID,dockKind:"structure" as const}:
  positiveID(row.stationID)?{stationID:row.stationID,dockKind:"station" as const}:{stationID:null,inSpace:true};
 return {characterID,shipID,corporationID,systemID:solarSystemID,targetSystemID:systemID,...dock,
  shipTypeName:typeof raw?.shipName==="string"?raw.shipName:null,officeID:null,fleet:null,observedAt:Date.now()};
}

export async function inspectMiningOffice(members: readonly {accountName:string;characterName:string;characterID:number}[], locationID:number, corporationID:number) {
 const available = new Map(Array.from({length:7}, (_, i) => [i + 1, null as string | null]));
 for (const member of members) {
  const options = await ownerOptions(member.accountName);
  const {ownership} = await authenticatedJson(`/api/pilot-training/ownership?characterID=${member.characterID}`,options);
  if (ownership?.characterID !== member.characterID || ownership.owner !== "OFF" || ownership.online !== false)
   throw Error(`${member.characterName}: an offline, free pilot is required for the temporary office check.`);
  const result = await runHosted(member.characterID,"mcc-inspect",{officeLocationID:locationID},options);
  const proof = result.readout as {characterID:number;locationID:number;corporationID:number;officeAvailable:boolean;divisions:{division:number;query:boolean;name:string|null}[]} | null;
  if (result.phase !== "Corporate delivery access inspected" || proof?.characterID !== member.characterID ||
      proof.locationID !== locationID || proof.corporationID !== corporationID || typeof proof.officeAvailable !== "boolean" ||
      !Array.isArray(proof.divisions)) throw Error(result.why ?? `${member.characterName}: office access was not verified.`);
  if (!proof.officeAvailable) return [];
  if (proof.divisions.length !== 7 || new Set(proof.divisions.map(row => row.division)).size !== 7 ||
      proof.divisions.some(row => !Number.isInteger(row.division) || row.division < 1 || row.division > 7 || typeof row.query !== "boolean"))
   throw Error(`${member.characterName}: division access is unreadable.`);
  for (const row of proof.divisions) {
   if (!row.query) available.delete(row.division);
   else if (available.has(row.division)) available.set(row.division, row.name || available.get(row.division) || null);
  }
 }
 return Array.from(available, ([division,name]) => ({division,name}));
}

/** Connect the preserved operation editor to the existing hosted fleet runs.
 * The caller displays/approves every exact selected-pilot fleet move. */
export function createRestoredMiningHost(options:ApiOptions,confirmMoves:FleetHostServices["confirmMoves"]){
 let settlementRead:Promise<MiningOperationsPayload>|null=null;
 const withSignal=(access:ApiOptions,signal?:AbortSignal)=>signal?{
  ...access,signal:access.signal?AbortSignal.any([access.signal,signal]):signal,
 }:access;
 const journal:FleetHostServices["journal"]=async(id,command,body,signal)=>{
  const path=`${prefix}/${encodeURIComponent(id)}/launch${command==="read"?"":`/${command}`}`;
  const v=await authenticatedJson(path,withSignal(options,signal),command==="read"?undefined:body);
  if(!v||!Object.hasOwn(v,"receipt"))throw Error("The fleet launch journal is unavailable.");
  return v.receipt as FleetLaunchReceipt|null;
 };
 const account=async(m:{accountName:string})=>ownerOptions(m.accountName);
 const services:FleetHostServices={
  async readDefinition(id){const all=payload(await authenticatedJson(prefix,options)),matches=all.operations.filter(r=>r.definition.operationID===id);if(matches.length!==1)throw Error("The exact saved operation is unavailable.");return matches[0]!.definition as unknown as SavedDefinition;},
  async inspect(member,definition,operationRunID){
   const owned=await account(member),common=definition.preparation??{source:{kind:'hangar'},suppliesRequired:false};
   const fittingID=member.preparation?.fittingID;
   let prepared:FleetInspection['preparation'];
   if(fittingID){
    const preparation={...common,fittingID,providerCharacterID:member.preparation?.providerCharacterID??member.characterID};
    const result=await runHosted(member.characterID,'mcc-prepare',{operationID:definition.operationID,operationRunID,role:member.role,
     preparation,reviewOnly:true} as JsonValue,owned),readout=result.readout as any;
    if(result.status!=='stopped'||result.phase!=='Mining member prepared'||readout?.characterID!==member.characterID||
       readout.operationID!==definition.operationID||readout.operationRunID!==operationRunID||!['VERIFIED','DEGRADED'].includes(readout.state))
      throw Error(result.why??'The pilot preparation outcome could not be confirmed.');
    prepared=readout;
   }
   const delivery=definition.unloadDestination, parking=definition.policies?.parking;
   const self=definition.unloadPolicy==="SELF_UNLOAD";
   const delivers=member.role===(self?"MINER":"HAULER")||member.role==="COMMAND"&&
    (self?definition.support?.selfMining:definition.support?.collection==="TRACTOR_AND_COLLECT");
   const corporateDestinations=[];
   if(delivers&&delivery&&delivery.corporationDivision!=null)corporateDestinations.push({
    locationID:delivery.kind==="structure"?delivery.id:delivery.stationID,corporationID:delivery.corporationID,division:delivery.corporationDivision});
   if(member.role!=="DEFENDER"&&parking?.mode==="RETURN_HOME_UNLOAD_DOCK"&&parking.destination&&parking.corporationDivision!=null)corporateDestinations.push({
    locationID:parking.destination.kind==="structure"?parking.destination.id:parking.destination.stationID,corporationID:parking.corporationID,division:parking.corporationDivision});
   const support=definition.support;
   const commandModules=member.role==='COMMAND'&&!!support&&(support.maintainBursts||support.useIndustrialCore||support.enableCompression||support.tractor);
   const result=await runHosted(member.characterID,'mcc-inspect',{systemID:definition.area.anchorSystemID,equipmentReview:!!fittingID,commandModules,
    ...(corporateDestinations.length?{corporateDestinations}:{})} as JsonValue,owned);
   if(result.status!=='stopped'||result.phase!=='Fleet pilot inspected'||!result.readout||typeof result.readout!=='object')
    throw Error(result.why??('Pilot '+member.characterID+' inspection was not completed.'));
   return {botID:result.botID,readout:{...result.readout as unknown as FleetInspection,...(prepared?{preparation:prepared}:{})}};
  },
  async planMember(member,definition,operationRunID,catalogue){
   const support=definition.support;
   if(member.role==="COMMAND"&&support&&(support.maintainBursts||support.useIndustrialCore||support.enableCompression||support.tractor)){
    // The account roster has no fitted module Item IDs for the command plan.
    const {readout}=await services.inspect({...member,preparation:undefined},definition,operationRunID);
    return {...readout,...catalogue};
   }
   const owned=await account(member);
   const accountRead=await authenticatedJson<{sessionToken?:unknown;account?:{username?:unknown};characters?:AccountPilot[]}>(
    "/api/pilot-training/login",{...owned,token:null},{username:member.accountName});
   const token=accountRead.sessionToken;
   if(typeof token!=="string"||!token||token===owned.token)throw Error("The fresh account roster is unreadable.");
   try{
    const name=accountRead.account?.username;
    if(typeof name!=="string"||name.toLowerCase()!==member.accountName.toLowerCase()||!Array.isArray(accountRead.characters))
     throw Error("The account roster did not identify the selected pilot.");
    const rows=accountRead.characters.filter(c=>c?.characterID===member.characterID);
    return {...planningPilot(rows.length===1?rows[0]!:null,member.characterID,definition.area.anchorSystemID),...catalogue};
   }finally{
    await authenticatedJson("/api/logout",{...owned,token},{}).catch(()=>{});
   }
  },
  async catalogue(definition,operationRunID){
   const systemID=definition.area.anchorSystemID;
   const [map,dogma]=await Promise.all([
    definition.area.targetClasses[0]==="BELT"?authenticatedJson(`/api/client-data/system-objects/${systemID}`,options):null,
    authenticatedJson("/api/client-data/dogma-types?typeIDs=23",options),
   ]);
   if(map&&(map.available!==true||!Array.isArray(map.objects)))throw Error("System belt catalogue is unavailable.");
   const belts=(map?.objects??[]).filter((row:any)=>row?.groupID===9&&positiveID(row.itemID)).map((row:any)=>({itemID:row.itemID as number,name:typeof row.name==="string"?row.name.trim():""}));
   const unnamed=belts.filter((row:{name:string})=>!row.name);
   for(let offset=0;offset<unnamed.length;offset+=50){
    const batch=unnamed.slice(offset,offset+50);
    const reply=await authenticatedJson("/api/names",options,{items:batch.map((row:{itemID:number})=>({kind:"evelocation",id:row.itemID}))});
    if(!reply.names||reply.capped===true)throw Error("Native belt names are unavailable.");
    for(const row of batch){const name=reply.names[`evelocation:${row.itemID}`];if(typeof name==="string")row.name=name.trim();}
   }
   const unresolved=unnamed.filter((row:{name:string})=>!row.name);
   if(unresolved.length){
    // The static map omits generated names. Resolving cfg.evelocations needs a held pilot.
    const leader=definition.members.find(member=>member.role==="MINER");
    if(!leader)throw Error("The operation has no mining leader.");
    const {readout}=await services.inspect({...leader,preparation:undefined},definition,operationRunID);
    if(readout.characterID!==leader.characterID||readout.targetSystemID!==systemID||!Array.isArray(readout.belts))
     throw Error("Native belt names do not match the selected system.");
    const names=new Map(readout.belts.map(belt=>[belt.itemID,belt.name]));
    for(const belt of unresolved){
     const name=names.get(belt.itemID);
     if(typeof name==="string")belt.name=name.trim();
    }
   }
   const named=belts.filter((row:{name:string})=>row.name);
   if(belts.length&&!named.length)throw Error("Native belt names are unavailable.");
   return {belts:named,canCapacityM3:jettisonCapacityFromDogma(dogma)};
  },
  async board(){const result=await loadMiningOperations(options),raw=result as unknown as {targetBoardAvailable?:boolean;targetBoard:readonly {targetKey:string;state:string}[]};return {available:raw.targetBoardAvailable===true,targets:raw.targetBoard};},
  async delivery(d){const dest=d.unloadDestination;if(!dest)throw Error('Choose a delivery destination.');const actors=d.members.filter(m=>(d.unloadPolicy==='SELF_UNLOAD'?m.role==='MINER':m.role==='HAULER')||m.role==='COMMAND'&&(d.unloadPolicy==='SELF_UNLOAD'?d.support?.selfMining:d.support?.collection==='TRACTOR_AND_COLLECT'));let systemID:number;if(dest.kind==='structure'){for(const actor of actors){const r=await authenticatedJson(`/api/dockable-structures/${dest.id}?characterID=${actor.characterID}`,await account(actor));if(r.location?.id!==dest.id||r.location?.kind!=='structure'||r.location.solarSystemID!==dest.solarSystemID)throw Error('A delivery pilot does not have verified access to the selected structure.');}systemID=dest.solarSystemID as number;}else{const r=await authenticatedJson(`/api/map/resolve/${dest.stationID}`,options);if(r.kind!=='station'||r.stationID!==dest.stationID||!Number.isSafeInteger(r.solarSystemID)||r.solarSystemID<=0)throw Error('Delivery station is unverified.');systemID=r.solarSystemID;}return {kind:dest.kind==='structure'?'structure':'station',destinationID:(dest.kind==='structure'?dest.id:dest.stationID) as number,systemID,corporationID:dest.corporationDivision==null?null:dest.corporationID as number,division:dest.corporationDivision==null?null:dest.corporationDivision as number};},
  async parking(d){const p=d.policies?.parking;if(!p||p.mode==='STAY_IN_PLACE')return undefined;const target=p.destination;if(!target)throw Error('Select the parking destination.');if(target.kind==='structure'){for(const member of d.members){const r=await authenticatedJson(`/api/dockable-structures/${target.id}?characterID=${member.characterID}`,await account(member));if(r.location?.id!==target.id||r.location.kind!=='structure'||r.location.solarSystemID!==target.solarSystemID)throw Error('A pilot cannot use the selected parking structure.');}return {destinationID:target.id,kind:'structure',systemID:target.solarSystemID};}const v=await authenticatedJson(`/api/map/resolve/${target.stationID}`,options);if(v.kind!=='station'||v.stationID!==target.stationID||!Number.isSafeInteger(v.solarSystemID)||v.solarSystemID<=0)throw Error('The saved parking station is not verified.');return {destinationID:v.stationID,kind:'station',systemID:v.solarSystemID};},
  confirmMoves,
  async check(member,kind,setup){return checkPluginRun("uoc",kind,setup as unknown as JsonValue,await account(member));},
  async review(d,setup){const v=await authenticatedJson(`${prefix}/${encodeURIComponent(d.operationID)}/launch-plan`,options,{revision:d.revision,setup});if(typeof v.planHash!=="string"||typeof v.candidateSupported!=="boolean")throw Error("The current fleet review is incomplete.");return {planHash:v.planHash,candidateSupported:v.candidateSupported};},
  async before(member){return (await listServerBots(await account(member))).map(b=>b.botID);},
  journal,
  async finishLaunch(operationID,operationRunID){
   await authenticatedJson(`${prefix}/${encodeURIComponent(operationID)}/launch/end`,options,{operationRunID});
  },
  async start(member,setup,minutes){const bot=await startPluginRun(member.characterID,"uoc",member.kind,setup as unknown as JsonValue,createPluginRunGrant(member.policy as PluginRunPolicy,minutes),await account(member));if(bot.kind!=="plugin"||bot.plugin?.pluginID!=="uoc"||bot.plugin.run!==member.kind)throw Error("The returned host run identity is unreadable.");return {botID:bot.botID,characterID:bot.characterID,kind:bot.plugin.run};},
  async current(member,signal){const value=await authenticatedJson("/api/plugins/uoc/runs/current",withSignal(await account(member),signal));if(!Array.isArray(value.runs))throw Error("The account's current run owners are unreadable.");return value.runs;},
  async isSettled(operationID,operationRunID,characterID,botID){
    // Missing owners arrive together during Stop; share this pending read only.
    const read=settlementRead??=loadMiningOperations(options);
    let state:MiningOperationsPayload;
    try{state=await read;}finally{if(settlementRead===read)settlementRead=null;}
    const operation=state.operations.find(o=>o.definition.operationID===operationID);
    if(operation?.runtime.state==='DRAFT'&&!operation.runtime.operationRunID)return true;
    if(operation?.runtime.operationRunID!==operationRunID)return false;
   return operation.runtime.members.some(m=>m.characterID===characterID&&m.botID===botID&&
    m.runtimeState==='STOPPED'&&m.parkingState==='RELEASED');
  },
  async stop(member,botID){await authenticatedJson(`/api/plugins/uoc/runs/${encodeURIComponent(botID)}/stop`,await account(member),{});},
 };
 return createMiningFleetHost(services);
}
export type {ReviewedFleet,CheckedFleetMember} from "../../operations/miningHosted.ts";

/** Merge display evidence without losing durable pilots when host history is partial. */
function retainedPreparation(native:any,host:any,roster:readonly {characterID:number}[]){
 const rows=new Map<number,any>();for(const p of [...(host?.members??[]),...(native?.members??[])])if(roster.some(m=>m.characterID===p.characterID))rows.set(p.characterID,p);
 if(!rows.size)return undefined;
 return {historical:true,state:rows.size!==roster.length?'PENDING' as const:[...rows.values()].some(p=>p.state==='DEGRADED')?'DEGRADED' as const:'VERIFIED' as const,members:[...rows.values()]};
}
