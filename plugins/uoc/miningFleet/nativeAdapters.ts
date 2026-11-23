import {getFlightStatus,getSpaceSnapshot,getDrones,loadBoundFleet,loadFitting} from "../../../web/src/plugin-api/flying.ts";
import type {PluginRunContext} from "../../../web/src/plugin-api/backend.ts";
import type {PilotSession} from "../../../web/src/plugin-api/pilotSession.ts";
import type {Claim} from "./targetBoard.ts";
import type {JetcanProof,Manifest,Member} from "./operation.ts";

/** Existing stock reads only. Raw results establish no fit, range, fleet or productive readiness. */
export function createStockPilotReads(run:Pick<PluginRunContext,"characterID"|"baseUrl"|"fetch">,session:PilotSession){
 const generation=session.flow.flying.sessionGeneration();
 const current=()=>{
  if(session.flow.flying.isSessionClosing()||session.flow.flying.sessionGeneration()!==generation||
    session.store.station.get().online?.characterID!==run.characterID)throw new Error("Mining pilot custody changed.");
 };
 const options=()=>({...session.flow.requestOptions(),baseUrl:run.baseUrl,fetch:run.fetch});
 async function read(){current();const [flight,space,fit,fleet,drones]=await Promise.all([
  getFlightStatus(options()),getSpaceSnapshot(options()),loadFitting(options()),loadBoundFleet(options()),getDrones(options())]);
  current();return {flight,space,fit,fleet,drones};}
 async function oreHolds(){current();const response=await run.fetch(new URL("/api/bridge/ship/ore-hold",run.baseUrl));
  const body=await response.json();current();if(!response.ok||body?.ok!==true)throw new Error("Native mining holds are unavailable.");return body;}
 async function container(containerID:number){
  if(!Number.isSafeInteger(containerID)||containerID<=0)throw new Error("Invalid container identity.");
  current();const response=await run.fetch(new URL(`/api/bridge/inventory/container/${containerID}`,run.baseUrl));
  const body=await response.json();current();if(!response.ok||body?.ok!==true)throw new Error("Native container is unavailable.");return body;
 }
 return {read,oreHolds,container,current};
}

/** Required implementations must durably fence each mutation before touching the bridge. */
export interface MiningFleetNativeActions {
 readonly member:Member;
 jettison(claim:Claim,intentGeneration:number):Promise<JetcanProof>;
 haul(claim:Claim,manifest:Manifest,haulGeneration:number,destinationID:number):Promise<{
  readonly source:"native-transfer";readonly operationID:string;readonly runID:string;readonly containerID:number;
  readonly claimGeneration:number;readonly shipID:number;readonly destinationID:number;
  readonly sourceAfter:readonly {typeID:number;quantity:number}[];
  readonly destinationBefore:readonly {typeID:number;quantity:number}[];
  readonly destinationAfter:readonly {typeID:number;quantity:number}[];readonly observedAt:number;
 }>;
}

/** Work not yet implemented by this foundation; no capability or launch readiness is implied. */
export const REQUIRED_NATIVE_ADAPTERS = Object.freeze([
 "ship.Jettison: durable invocation fence and exact created-container receipt from fresh owner/ship/target scene",
 "invCache container List and inventory transfer: exact claimed jetcan source and confirmed destination delta",
 "dogmaIM ItemGetInfo and QueryAttributeValue: per-instance mining range/cycle and active-target settlement",
 "fleetProxy.ApplyToJoinFleet and fleetObjectHandler.Invite/AcceptInvite/GetFleetComposition: verify roster and one live fleet",
 "dogmaIM.ItemGetInfo and QueryAttributeValue plus module activation: verify command burst effect, charge, range and cycle",
 "inSpaceCompressionMgr.CompressItemInSpace: fit-driven compatibility and exact resulting RAW/COMPRESSED inventory evidence (optional)",
 "drone and module shutdown plus exact dock observation for each member before releasing target or pilot custody",
] as const);
