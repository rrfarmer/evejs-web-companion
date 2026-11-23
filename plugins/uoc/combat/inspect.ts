import type { BackendRun, PluginRunContext } from '../../../web/src/plugin-api/backend.ts';
import { decodeFlightStatus, loadBoundFleet } from '../../../web/src/plugin-api/flying.ts';
import { inspectFleet } from '../miningFleet/inspect.ts';
import {readCombatShipClass} from './anchor.ts';
const positive=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;
/** A short hosted read, scoped to the held pilot; no fit or flight mutations. */
export const combatFleetInspectRun:BackendRun={
 check(input){return input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===0?{ok:true,setup:{},name:'Inspect Security fleet pilot',policy:{riskClasses:[],restartSafe:false}}:{ok:false,refusal:'Pilot inspection does not accept a setup.'};},
 async start(run:PluginRunContext){
  if(run.resumed||!positive(run.characterID)||run.held.characterID!==run.characterID||run.held.character.characterID!==run.characterID)throw Error('Pilot inspection ownership is unavailable.');
  let active=true;
  const work=(async()=>{const response=await run.fetch(new URL('/api/bridge/flight/status',run.baseUrl));const data=await response.json();if(!active)return;if(!response.ok||data?.ok!==true)throw Error('Pilot flight is unavailable.');const flight=decodeFlightStatus(data.flight);
   if(!flight.docked||flight.inSpace||!positive(flight.shipID)||!positive(flight.solarSystemID)||!positive(flight.stationID??flight.structureID)||flight.transition&&flight.transition.phase!=='ready')throw Error('The pilot must be docked in a known ship.');
   let fleet:ReturnType<typeof inspectFleet>|null=null;try{fleet=inspectFleet(await loadBoundFleet({baseUrl:run.baseUrl,fetch:run.fetch}),run.characterID);}catch{/* An unreadable fleet is not an empty fleet. */}let shipClass:number|null=null;try{shipClass=await readCombatShipClass(run,flight.shipTypeID??0,()=>{if(!active)throw Error('Pilot inspection ended.');});}catch{if(!active)return;}
   run.report({status:'stopped',phase:'Fleet Security pilot inspected',readout:{characterID:run.characterID,shipID:flight.shipID,shipTypeID:flight.shipTypeID,shipClass,stationID:flight.stationID??flight.structureID,systemID:flight.solarSystemID,fleet,observedAt:Date.now()}});
  })().catch(e=>{if(active)run.report({status:'error',phase:'Fleet Security inspection failed',why:e instanceof Error?e.message:String(e)});});
  return {async stop(){active=false;await work;}};
 }
};
