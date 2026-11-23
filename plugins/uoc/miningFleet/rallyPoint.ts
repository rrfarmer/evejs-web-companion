import type {PluginRunContext} from "../../../web/src/plugin-api/backend.ts";
import type {PilotSession} from "../../../web/src/plugin-api/pilotSession.ts";
import {decodeFlightStatus,undock} from "../../../web/src/plugin-api/flying.ts";
import {parkWithPolicy,type ParkingDestination} from "../shared/parking.ts";
import {transientNativeRead} from "../shared/progressDeadline.ts";
import {readMiningReadiness} from "./nativeBelt.ts";
import {FleetObservationUnavailable} from "./stopSignal.ts";

type Run=Pick<PluginRunContext,"characterID"|"baseUrl"|"fetch">;
export type MiningRallyPoint=ParkingDestination|{kind:"sun";destinationID:number;systemID:number};
const valid=(id:unknown):id is number=>typeof id==="number"&&Number.isSafeInteger(id)&&id>0;

/** Prefer an NPC station that every selected hull can use. In a system
 * without one, the fleet holds at a common celestial away from the belts. */
export async function findMiningRallyPoint(run:Run,systemID:number,current:()=>void):Promise<MiningRallyPoint>{
 const read=async(path:string)=>{
  current();
  const response=await run.fetch(new URL(path,run.baseUrl)),body=await response.json();
  current();
  if(!response.ok||body?.ok!==true)throw new FleetObservationUnavailable("The mining system's map is unavailable.");
  return body;
 };
 const {stations}=await read(`/api/map/system-stations/${systemID}`);
 if(!Array.isArray(stations)||stations.some(row=>!valid(row?.stationID)))
  throw new FleetObservationUnavailable("Local stations could not be verified for the fleet rally.");
 if(stations.length)return {kind:"station",destinationID:Math.min(...stations.map(row=>row.stationID)),systemID};
 const {available,objects}=await read(`/api/client-data/system-objects/${systemID}`);
 const suns=available===true&&Array.isArray(objects)?objects.filter(row=>row?.groupID===6):[];
 if(suns.length!==1||!valid(suns[0]?.itemID))throw new FleetObservationUnavailable("No verified station or sun is available for the fleet rally.");
 return {kind:"sun",destinationID:suns[0].itemID,systemID};
}

export async function reachMiningRallyPoint(run:Run,session:PilotSession,point:MiningRallyPoint,shipID:number,
 flight:ReturnType<typeof decodeFlightStatus>,current:()=>void,beforeDeparture:()=>Promise<void>){
 const {destinationID,systemID}=point;
 if(point.kind!=="sun"){
  if(flight.docked&&flight.solarSystemID===systemID&&
     (point.kind==="station"?flight.stationID:flight.structureID)===destinationID&&
     (!flight.transition||flight.transition.phase==="ready"))return;
  if(flight.inSpace)await beforeDeparture();
  current();
  await parkWithPolicy(run,session,()=>{},current,{mode:"selected",...point},{expectedShipID:shipID});
  return;
 }
 const flying=session.flow.flying;
 if(flight.docked){
  current();
  await undock((...args)=>{current();return flying.bridgeDo(...args);},flying.readFlightNow,false);
 }
 const deadline=Date.now()+180_000;
 let ordered=false;
 while(Date.now()<deadline){
  const {ready,space}=await readMiningReadiness(run,session,shipID,systemID,current,undefined,"fleet-rally");
  const sun=space.entities.find(entity=>entity.itemID===destinationID&&entity.groupID===6&&entity.geometryAvailable);
  if(!sun)throw new FleetObservationUnavailable("The fleet rally celestial is missing from the native scene.");
  const {position,radius}=space.ship!;
  const distance=Math.hypot(position.x-sun.position.x,position.y-sun.position.y,position.z-sun.position.z)-radius-sun.radius;
  if(ready&&distance<=150_000)return;
  if(ready&&!ordered){
   if(flight.inSpace)await beforeDeparture();
   current();
   ordered=true;
   try{await flying.warpAsTheAutopilot(destinationID);}
   catch(error){if(!transientNativeRead(error))throw error;}
  }
  await new Promise(resolve=>setTimeout(resolve,1500));
 }
 throw Error("Warp to the fleet rally point did not confirm arrival.");
}
