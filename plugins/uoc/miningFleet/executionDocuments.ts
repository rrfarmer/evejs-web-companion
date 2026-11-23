import {finishedFleetExecution,retainFleetRunResult,savedFleetExecution,unusedFleetExecution,type FleetOperationDocuments} from "./operationStore.ts";
import {readSelfUnloadTotals} from "./selfUnload.ts";

function generationIn(key:string,position:number,operationID:string,runID:string){
 try{
  const parts=JSON.parse(key);
  return Array.isArray(parts)&&parts[position]===operationID&&parts[position+1]===runID;
 }catch{return false;}
}

const inventoryWrites=["mining-fleet-haul:","mining-fleet-haul-own-freight:","mining-fleet-parking-unload:",
 "mining-fleet-finish-parking-unload:","mining-fleet-finish-deposit:","mining-fleet-self-unload-trip:"];

/** Delete the generation's journals through their existing keys, keeping shared board state. */
export function deleteFleetExecution(store:FleetOperationDocuments,operationID:string,runID:string){
 store.transaction(()=>{
  const record=savedFleetExecution(store,operationID,runID);
  if(record&&!unusedFleetExecution(record)&&!finishedFleetExecution(record))
   throw Error("Unfinished fleet execution still needs its freight evidence.");
  const telemetry=store.document(`mining-fleet-telemetry:${JSON.stringify([operationID,runID])}`).read() as {stoppedAt?:number}|null;
  const lastSettlement=record?.settledAt?Math.max(0,...Object.values(record.settledAt)):0;
  const index=`mining-fleet-index:${operationID}`;
  const keys=store.documentNames("mining-fleet-").filter(key=>{
   const colon=key.indexOf(":");
   if(colon<0)return false;
   const position=key.startsWith("mining-fleet-site-navigation:")?4:0;
   return generationIn(key.slice(colon+1),position,operationID,runID);
  });
  for(const name of keys){
   if(inventoryWrites.some(prefix=>name.startsWith(prefix))&&
      (store.document(name).read() as {pending?:unknown}|null)?.pending!=null)
    throw Error("An unconfirmed inventory transfer still needs its freight evidence.");
  }
  if(record?.state!=="READY"){
   const prefix="mining-fleet-self-unload:";
   const selfUnloads=keys.filter(name=>name.startsWith(prefix)).map(name=>{
    const trip=store.document(name).read() as {pending?:unknown}|null;
    if(!trip||trip.pending!==null)throw Error("Unfinished self-unload still needs its freight evidence.");
    return readSelfUnloadTotals(trip,name.slice(prefix.length));
   });
   retainFleetRunResult(store,operationID,runID,record,telemetry?.stoppedAt??(lastSettlement||null),selfUnloads);
  }
  if((store.document(index).read() as {runID?:string}|null)?.runID===runID)keys.push(index);
  store.deleteDocuments(keys,[]);
 });
}

export function deleteFleetCycles(store:FleetOperationDocuments,operationID:string,runID:string){
 store.transaction(()=>{
  const legacy=store.documentNames("pilot:").filter(name=>{
   const identity=(store.document(name).read() as {identity?:unknown}|null)?.identity;
   return typeof identity==="string"&&generationIn(identity,0,operationID,runID);
  });
  const scope=JSON.stringify([operationID,runID]).slice(0,-1)+",";
  store.deleteDocuments(legacy,[`pilot-cycle:${scope}`,`compression:${scope}`]);
 });
}
