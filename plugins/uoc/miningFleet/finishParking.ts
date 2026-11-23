import type {PluginRunContext} from '../../../web/src/plugin-api/backend.ts';
import type {PilotSession} from '../../../web/src/plugin-api/pilotSession.ts';
import {decodeFlightStatus,getFlightStatus} from '../../../web/src/plugin-api/flying.ts';
import {parkAtOperationHome,observeSettledInPlace} from './operationParking.ts';
import {unloadParkingFreight,type ParkingFreightRemaining} from './parkingUnload.ts';
import type {FleetSetup} from './runtime.ts';
import {hasHaulWork,type Member,type OperationRecord,type StopFreightMode} from './operation.ts';
import type {SynchronousStore} from './targetBoard.ts';
import type {ParkingOptions} from "../shared/parking.ts";
import {decodeFleetDelivery} from './delivery.ts';

export function retainedStopUnload(record:OperationRecord|null,setup:FleetSetup|null){
 const parking=setup?.parking;
 if(!record||!setup||record.operationID!==setup.operationID||record.runID!==setup.operationRunID||
    parking?.mode!=="RETURN_HOME_UNLOAD_DOCK"||record.stopFreight!=="RETURN_HOME"||!record.stopRequested||
    !["SETTLING","PARKING","DRAINING","STOPPED"].includes(record.state)||record.relocation||
    Object.keys(record.jetcanIntents).length||hasHaulWork(record))return null;
 const characterIDs=record.members.filter(m=>record.settled.includes(m.characterID)&&!record.parked.includes(m.characterID)&&
  !record.stayed?.includes(m.characterID)).map(m=>m.characterID);
 return {parking,characterIDs};
}

/** Collect Freight sends Miners to unload their own holds and Defenders to dock. */
export function stopParkingSetup(setup:FleetSetup,choice:StopFreightMode|undefined,role?:Member["role"]):FleetSetup{
 if(choice==="COLLECT_FREIGHT"&&role==="MINER"){
  const savedDock=setup.parking?.mode!=="STAY_IN_PLACE"&&setup.parking?.destinationID===setup.destinationID?setup.parking:null;
  const delivery=setup.delivery??decodeFleetDelivery({destinationID:setup.destinationID,kind:savedDock?.kind??"station",
   systemID:savedDock?.systemID??setup.systemID,corporationID:setup.corporationID,division:setup.division});
  if(!delivery)throw Error("Collect Freight requires a configured delivery dock and hangar for this Miner.");
  return {...setup,parking:{mode:"RETURN_HOME_UNLOAD_DOCK",...delivery}};
 }
 const deliveryDock=choice==="COLLECT_FREIGHT"&&role==="DEFENDER"||!!choice&&setup.parking?.mode==="STAY_IN_PLACE";
 if(!deliveryDock)return setup;
 return {...setup,parking:{mode:"RETURN_HOME_DOCK",destinationID:setup.destinationID,
  kind:setup.delivery?.kind??"station",systemID:setup.delivery?.systemID??setup.systemID}};
}
/** Replan movement from native flight; keep an exact durable fence for a Dock with unknown outcome. */
export async function finishParking(run:PluginRunContext,session:PilotSession,setup:FleetSetup,shipID:number,current:()=>void,document:(name:string)=>SynchronousStore,options:ParkingOptions & {preserveCargo?:boolean;forDelivery?:boolean;dockedOnly?:boolean;onUnloadRemaining?:(freight:ParkingFreightRemaining)=>void}={}){
 const base=JSON.stringify([setup.operationID,setup.operationRunID,run.characterID,shipID]);
 const selected=setup.parking??{mode:'RETURN_HOME_DOCK',destinationID:setup.destinationID,kind:setup.delivery?.kind??'station',systemID:setup.delivery?.systemID??setup.systemID};
 if(selected.mode==='STAY_IN_PLACE'){
  const doc=document('mining-fleet-finish-stay:'+base),retained=doc.read() as {identity?:unknown}|null;
  let botID=run.botID;
  if(retained!==null){let parts:unknown;try{parts=JSON.parse(String(retained.identity));}catch{throw Error('Original FINISH in-place intent is malformed.');}
   if(!Array.isArray(parts)||parts.length!==5||parts[0]!==setup.operationID||parts[1]!==setup.operationRunID||typeof parts[2]!=='string'||!parts[2]||parts[3]!==run.characterID||parts[4]!==shipID)throw Error('Original FINISH in-place intent belongs to another pilot or generation.');botID=parts[2];}
  // Only the movement-journal identity is retained. All native reads and the
  // held-session guard still belong to the newly authorized exclusive actor.
  return {kind:'stay' as const,proof:await observeSettledInPlace({...run,botID},session,shipID,current,doc,{operationID:setup.operationID,runID:setup.operationRunID})};
 }
 const doc=document((options.forDelivery?'mining-fleet-finish-delivery-dock:':'mining-fleet-finish-parking:')+base),identity=JSON.stringify(selected);let state=doc.read() as {version:number;identity:string;pending:null|{kind:'route'|'dock';destinationID:number};history:unknown[]}|null;
 if(state!==null&&(state.version!==1||state.identity!==identity||!Array.isArray(state.history)||state.pending!==null&&(!['route','dock'].includes(state.pending.kind)||state.pending.destinationID!==selected.destinationID)))throw Error('Original FINISH Parking intent requires reconciliation.');
 state??={version:1,identity,pending:null,history:[]};const save=()=>{current();doc.write(structuredClone(state));};
 const f=decodeFlightStatus((await getFlightStatus({...session.flow.requestOptions(),baseUrl:run.baseUrl,fetch:run.fetch})).flight);current();
 if(f.shipID!==shipID||f.inSpace===f.docked)throw Error("Original Parking ship or native location is unverified.");
 const locationID=f.stationID??f.structureID;
 if(options.dockedOnly&&(!f.docked||f.solarSystemID!==selected.systemID||
    (selected.kind==="station"?f.stationID:f.structureID)!==selected.destinationID))
  throw Error("The original ship must be docked at its configured home to finish unloading.");
 if(!setup.parking&&!state.pending&&f.docked&&locationID&&(!f.transition||f.transition.phase==="ready"))
  return {kind:'dock' as const,proof:{source:'native-flight' as const,shipID,locationID,docked:true,observedAt:Date.now()}};
 const dock=await parkAtOperationHome(run,session,selected,(phase,why)=>run.report({status:'paused',phase,why}),current,{
  ...options,expectedShipID:shipID,observeDockOnly:options.dockedOnly||state.pending?.kind==="dock",
  beforeDock:()=>{
   current();state!.pending={kind:"dock",destinationID:selected.destinationID};save();
  },
  refusedDock:()=>{
   current();state!.pending=null;save();
  },
 });
 if(state.pending){state.history.push({intent:state.pending,outcome:'NATIVE_DOCK_OBSERVED',observedAt:Date.now()});state.pending=null;save();}
 if(selected.mode==='RETURN_HOME_UNLOAD_DOCK'&&!options.preserveCargo){
  const original=document('mining-fleet-parking-unload:'+base),retained=document('mining-fleet-finish-parking-unload:'+base);
  const hasOriginal=original.read()!==null;
  if(hasOriginal&&retained.read()!==null)throw Error('Both original and FINISH parking-unload receipts exist. Inspect the exact deposit before continuing.');
  run.report({status:"paused",phase:"Unloading at home",why:"Checking the docked holds and verifying delivery."});
  await unloadParkingFreight(run,session,{operationID:setup.operationID,runID:setup.operationRunID,shipID,
   delivery:{kind:selected.kind,systemID:selected.systemID,destinationID:selected.destinationID,corporationID:selected.corporationID,division:selected.division},
   document:hasOriginal?original:retained,current,wholeStacks:selected.corporationID!==null,reconcileParking:true,onRemaining:options.onUnloadRemaining});
 }
 return {kind:'dock' as const,proof:{source:'native-flight' as const,shipID,locationID:dock.destinationID,docked:true,observedAt:Date.now()}};
}
