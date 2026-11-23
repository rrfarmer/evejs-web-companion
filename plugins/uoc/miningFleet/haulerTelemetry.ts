import {summarizeFreight,type FreightFact,type FreightStatus,type HoldCapacity} from './freightPolicy.ts';
import type {NativeInventoryRow} from './nativeInventory.ts';
/** Consume reads already made by the haul controller. No UI inventory poll or authority. */
export function createHaulerTelemetry(now=Date.now){
 let rows:readonly NativeInventoryRow[]|null=null,holds:readonly HoldCapacity[]|null=null,at=0,holdAt=0,family:'ore'|'ice'='ore';const facts:Record<number,FreightFact>={};
 return {cargo(value:readonly NativeInventoryRow[]){rows=structuredClone(value);at=now();},capacity(value:readonly HoldCapacity[],resource:'ore'|'ice'){holds=structuredClone(value);holdAt=now();family=resource;},facts(value:Readonly<Record<number,FreightFact>>){Object.assign(facts,value);},snapshot():FreightStatus|null {
  if(!rows||!holds||now()-at>60000||now()-holdAt>60000)return null;
  try{if(rows.some(r=>facts[r.typeID]?.categoryID===25&&facts[r.typeID]?.resourceFamily!==family))return null;
   if(rows.some(r=>!facts[r.typeID]||!Number.isFinite(facts[r.typeID]!.unitVolumeM3)||facts[r.typeID]!.unitVolumeM3<=0))return null;
   const flags:Record<string,number>={cargo:5,ore:134,ice:181,asteroid:182};
   const nativeRows=rows;const effective=holds.map(h=>({...h,capacity:{...h.capacity,used:nativeRows.filter(r=>r.flagID===flags[h.key]).reduce((n,r)=>n+r.quantity*facts[r.typeID]!.unitVolumeM3,0)}}));
   const summaries=summarizeFreight(rows,effective,facts,family),primary=summaries.length===1?summaries[0]!.flagID:null;
   if(!summaries.length)return null;
   return {source:'native-ship-holds',observedAt:Math.min(at,holdAt),primaryHoldFlagID:primary,holds:summaries.map(h=>({flagID:h.flagID,capacityM3:h.capacityM3,usedM3:h.usedM3,rawM3:h.rawM3,compressedM3:h.compressedM3,rawQuantity:h.raw.reduce((n,i)=>n+i.quantity,0),compressedQuantity:h.compressed.reduce((n,i)=>n+i.quantity,0)})),pendingCompression:null,facility:null};
  }catch{return null;}
 }};
}
