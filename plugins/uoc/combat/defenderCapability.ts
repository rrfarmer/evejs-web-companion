import type {PluginRunContext} from "../../../web/src/plugin-api/backend.ts";
import type {PilotSession} from "../../../web/src/plugin-api/pilotSession.ts";
import {decodeDroneBay,decodeFlightStatus,getFlightStatus} from "../../../web/src/plugin-api/flying.ts";
import {checkedInventory} from "../shared/nativeInventory.ts";
import {decodeNativeFittingResources} from "../provisioning/resourceQualification.ts";
import {decodeModuleObservation} from '../shared/moduleObservation.ts';
import {assertScopedWeaponCharge,combatFitModules,fleetRepairFitModules} from './moduleFit.ts';
const positive=(n:unknown):n is number=>typeof n==="number"&&Number.isSafeInteger(n)&&n>0;
/** Read-only qualification for the drone or fit-derived weapon path used by createPilotFighter. */
export async function inspectDefenderCapability(run:PluginRunContext,session:PilotSession,current:()=>void,capability:{weaponExecutionEnabled?:boolean;repairExecutionEnabled?:boolean}={}):Promise<{qualified:boolean;reason:string|null;evidence:unknown}>{
 try{
  current();const options={...session.flow.requestOptions(),baseUrl:run.baseUrl,fetch:run.fetch},raw=(await getFlightStatus(options)).flight;current();const f=decodeFlightStatus(raw);
  if(run.held.characterID!==run.characterID||!f.docked||f.inSpace||!positive(f.shipID)||!positive(f.shipTypeID)||!positive(f.solarSystemID)||!positive(f.stationID??f.structureID)||f.transition&&f.transition.phase!=="ready")throw Error("The exact held pilot, dock and ship are not verified.");
  const native=await session.flow.flying.bridgeAsk("dogmaIM","ItemGetInfo",[f.shipID]);current();const resources=decodeNativeFittingResources(native as any,{shipID:f.shipID,shipTypeID:f.shipTypeID,characterID:run.characterID});
  if(!resources||!resources.fits)throw Error("Native ship CPU and powergrid are unavailable or insufficient.");
  if(capability.repairExecutionEnabled)try{
   const flying=session.flow.flying;
   if(await flying.readFit()){
    current();const fit=session.store.fitting.get();
    if(fit.activeShipID===f.shipID&&fit.slotsError===null){
     const repairs=fleetRepairFitModules(fit.slots,flying.resolveRemoteRepModuleIDs(),m=>flying.fittedModuleActivation(m));
     for(const m of repairs){
      const observed=decodeModuleObservation(await flying.bridgeAsk("dogmaIM","ItemGetInfo",[m.itemID]),{moduleID:m.itemID,typeID:m.typeID,ownerID:run.characterID,shipID:f.shipID,flagID:m.flagID});current();
      const range=observed.attributes?.[54];
      if(observed.online&&typeof range==="number"&&range>0)
       return {qualified:true,reason:null,evidence:{characterID:run.characterID,shipID:f.shipID,resources,remoteRepair:{...m,range},observedAt:Date.now()}};
     }
    }
   }
  }catch{current();/* Weapon and drone qualifications remain independent. */}
  if(capability.weaponExecutionEnabled)try{const flying=session.flow.flying;if(await flying.readFit()){current();const fit=session.store.fitting.get();if(fit.activeShipID===f.shipID&&fit.slotsError===null){const modules=combatFitModules(fit.slots,flying.resolveDefenseModuleIDs(),flying.resolveRemoteRepModuleIDs(),m=>flying.fittedModuleActivation(m)).filter(m=>m.kind==='weapon');for(const m of modules){const slot=fit.slots.find(s=>s.module?.itemID===m.itemID),charge=slot?.module?.charge,info=decodeModuleObservation(await flying.bridgeAsk('dogmaIM','ItemGetInfo',[m.itemID]),{moduleID:m.itemID,typeID:m.typeID,ownerID:run.characterID,shipID:f.shipID,flagID:m.flagID});current();if(!info.online||!info.attributes)continue;const facts=charge?await flying.attributesOfTypes([charge.typeID],[1455,37,281]):{};current();assertScopedWeaponCharge(charge?.typeID??null,facts);const a=info.attributes,tracking=a[160],optimal=a[54],falloff=a[158],chargeFacts=charge?facts[charge.typeID]:undefined,velocity=chargeFacts?.[37],duration=chargeFacts?.[281],reach=typeof tracking==='number'&&tracking>0&&typeof optimal==='number'&&optimal>0&&typeof falloff==='number'&&falloff>=0?optimal+falloff:typeof velocity==='number'&&velocity>0&&typeof duration==='number'&&duration>0?velocity*duration/1000:null;if(reach!==null&&Number.isFinite(reach)&&reach>0&&(!charge||charge.quantity>0))return {qualified:true,reason:null,evidence:{characterID:run.characterID,shipID:f.shipID,shipTypeID:f.shipTypeID,systemID:f.solarSystemID,stationID:f.stationID??f.structureID,resources,weapon:{...m,range:reach,chargeTypeID:charge?.typeID??null},observedAt:Date.now()}};}}}}catch{current();/* Unreadable weapon facts cannot qualify a fit; still inspect drones. */}
  await session.flow.flying.bridgeDo("invCache","InvalidateLocationCache",[f.shipID]);current();const rows=checkedInventory(await session.flow.flying.bridgeAsk("invbroker","List",[87],undefined,f.shipID));current();
  if(rows.some(r=>r.ownerID!==run.characterID||r.locationID!==f.shipID||r.flagID!==87))throw Error("Drone bay ownership or location is unavailable.");
  const bay=decodeDroneBay(rows.map(r=>({itemID:r.itemID,typeID:r.typeID,quantity:r.quantity})));if(!bay)throw Error("The drone bay is unreadable.");
  const roles=await session.flow.flying.classifyDroneRoles(bay,null,f.shipID);current();if(!roles.bay?.combat.length)throw Error("No combat drones are verified in the owned drone bay; type metadata may be unavailable.");
  if(!await session.flow.flying.readFit())throw Error("The current fit is unavailable.");current();const range=await session.flow.flying.resolveDroneControlRange(session.store.fitting.get());current();if(typeof range!=="number"||!Number.isFinite(range)||range<=0)throw Error("Native drone control range is unavailable.");
  const verified=bay.filter(d=>roles.bay!.combat.includes(d.itemID));if(!verified.length)throw Error("Combat drone identities are unavailable.");
  return {qualified:true,reason:null,evidence:{characterID:run.characterID,shipID:f.shipID,shipTypeID:f.shipTypeID,systemID:f.solarSystemID,stationID:f.stationID??f.structureID,resources,droneControlRange:range,combatDrones:verified,observedAt:Date.now()}};
 }catch(e){current();return {qualified:false,reason:e instanceof Error?e.message:String(e),evidence:null};}
}
