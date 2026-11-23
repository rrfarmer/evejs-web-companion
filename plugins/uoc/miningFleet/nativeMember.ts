import type {MiningTravelAssist} from "./travelAssist.ts";
import type {PluginRunContext} from "../../../web/src/plugin-api/backend.ts";
import type {PilotSession} from "../../../web/src/plugin-api/pilotSession.ts";
import {createNativeBeltNavigation,type FlightObservation} from "./nativeBelt.ts";
import {createNativeRawObserver} from "./nativeMiner.ts";
import {createShipJettison,type RawMinerNative} from "./memberLoops.ts";
import {createSiteDiscovery,type NativeSite} from './siteDiscovery.ts';
import {createSiteNavigation} from './siteNavigation.ts';
import {decodeFlightStatus,getFlightStatus,undock} from '../../../web/src/plugin-api/flying.ts';
import type {Claim,Target,SynchronousStore} from './targetBoard.ts';
import {fleetReadFailed,FleetShipChanged} from './stopSignal.ts';
import type {MccTiming} from "./timing.ts";
/** Shared exact target navigation for fleet members. */
export function createNativeMiningNavigation(run:Pick<PluginRunContext,"characterID"|"baseUrl"|"fetch">,session:PilotSession,
 options:{shipID:number;current:()=>void;movementAdmission?:()=>Promise<void>;beforeDeparture?:()=>Promise<void>;travelAssist?:MiningTravelAssist;beltID?:number;site?:NativeSite;allowDraining?:boolean;authority?:()=>{state:string;target:Target;claim:Claim|null}|null;document?:(key:string)=>SynchronousStore;timing?:MccTiming;observeFlight?:FlightObservation}){
 return options.site?(()=>{const site=options.site!,discovery=createSiteDiscovery(run,session,{shipID:options.shipID,systemID:site.target.systemID,current:options.current});let nav:ReturnType<typeof createSiteNavigation>|null=null,key='';
  const selected=(target:Target,claim:Claim)=>{if(JSON.stringify(target)!==JSON.stringify(site.target)||!options.authority||!options.document)throw Error('Exact anomaly navigation scope is unavailable.');const next=JSON.stringify([claim.operationID,claim.runID,claim.generation]);if(!nav||next!==key){key=next;nav=createSiteNavigation(run,session,{shipID:options.shipID,site,claim,allowDraining:options.allowDraining,authority:options.authority as any,readSites:discovery.read,current:options.current,movementAdmission:async()=>{await options.movementAdmission?.();await options.beforeDeparture?.();},document:options.document(`mining-fleet-site-navigation:${JSON.stringify([run.characterID,options.shipID,site.scannerKey,site.instanceID,claim.operationID,claim.runID,claim.generation])}`)});}return nav;};
  return {async navigate(target:Target,claim:Claim){options.current();const startedAt=Date.now(),f=decodeFlightStatus((await getFlightStatus({...session.flow.requestOptions(),baseUrl:run.baseUrl,fetch:run.fetch}).catch(fleetReadFailed)).flight);options.current();options.observeFlight?.(f,startedAt);if(f.shipID&&f.shipID!==options.shipID)throw new FleetShipChanged("Mining ship changed.",f.shipIsCapsule===true);if(!f.shipID||f.solarSystemID!==site.target.systemID)throw Error('Anomaly flight scope changed.');if(f.docked){await options.movementAdmission?.();options.current();await undock(session.flow.flying.bridgeDo,session.flow.flying.readFlightNow,false);options.current();}await selected(target,claim).navigate();},async assertAtTarget(target:Target,claim:Claim){if(!await selected(target,claim).observeArrival())throw Error('Exact anomaly arrival is not confirmed.');}};})():createNativeBeltNavigation(run,session,{...options,beltID:options.beltID!});
}
/** Compose real navigation, physical inventory evidence and the caller's native mining cycle. */
export function createNativeMiner(run:Pick<PluginRunContext,"characterID"|"baseUrl"|"fetch">,session:PilotSession,
 options:Omit<Parameters<typeof createNativeRawObserver>[2],"assertAtTarget"> & Pick<Parameters<typeof createNativeMiningNavigation>[2],"movementAdmission"|"beforeDeparture"|"travelAssist"|"beltID"|"site"|"authority"|"document"|"timing"|"observeFlight"> & {mineCycle:RawMinerNative["mineCycle"]}):RawMinerNative{
 const navigation=createNativeMiningNavigation(run,session,options);
 const observer=createNativeRawObserver(run,session,{...options,assertAtTarget:navigation.assertAtTarget});
 return {current:observer.current,navigate:navigation.navigate,mineCycle:options.mineCycle,observeHolds:observer.observeHolds,holdEmpty:observer.holdEmpty,
  jettison:createShipJettison(session,observer.current,options.timing),observeCreatedCan:observer.observeCreatedCan};
}
