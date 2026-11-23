import type {PluginRunContext} from "../../../web/src/plugin-api/backend.ts";
import {fleetReadFailed} from "./stopSignal.ts";
/** The native jettison service creates type 23 Cargo Container; type attribute 38 is its world capacity. */
export async function readJettisonCapacity(run:Pick<PluginRunContext,"baseUrl"|"fetch">,current:()=>void):Promise<number>{
 current();const response=await run.fetch(new URL("/api/client-data/dogma-types?typeIDs=23",run.baseUrl));const body=await response.json();current();
 if(!response.ok||body?.ok!==true)return fleetReadFailed(Object.assign(Error(body?.message??"Jettison container type capacity is unavailable."),{code:body?.error,status:response.status}));
 return jettisonCapacityFromDogma(body);
}
export function jettisonCapacityFromDogma(body:any):number{
 const row=body?.types?.["23"];if(body?.available!==true||!row||!Array.isArray(row.attributes))throw Error("Jettison container type capacity is unavailable.");
 const values=row.attributes.filter((pair:unknown)=>Array.isArray(pair)&&pair.length===2&&pair[0]===38).map((pair:unknown[])=>pair[1]);
 if(values.length!==1||typeof values[0]!=="number"||!Number.isFinite(values[0])||values[0]<=0)throw Error("Jettison container capacity is unknown.");return values[0];
}
