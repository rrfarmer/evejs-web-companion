import {summarizeFreight,selectFreight,type HoldCapacity} from "./freightPolicy.ts";
import {decodeSpaceSnapshot,getSpaceSnapshot} from "../../../web/src/plugin-api/flying.ts";
import type {PluginRunContext} from "../../../web/src/plugin-api/backend.ts";
import type {PilotSession} from "../../../web/src/plugin-api/pilotSession.ts";
import type {Claim,Target} from "./targetBoard.ts";
import type {RawCanObservation,RawHoldObservation} from "./memberLoops.ts";
import {checkedInventory,readNativeShipHolds} from "./nativeInventory.ts";
import {readJettisonCapacity} from "./canCapacity.ts";
import type {MiningReadiness} from "./nativeBelt.ts";
import {fleetReadFailed} from "./stopSignal.ts";

type Run=Pick<PluginRunContext,"characterID"|"baseUrl"|"fetch">;
type Fact={readonly categoryID:number;readonly freightKind:"RAW"|"COMPRESSED"|null;readonly unitVolumeM3:number;readonly resourceFamily?:"ore"|"ice"|null};
const positive=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>0;
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
/** Native pre/post observation for one whole-stack raw jettison. */
export function createNativeRawObserver(run:Run,session:PilotSession,config:{shipID:number;current:()=>void;
 assertAtTarget:(target:Target,claim:Claim)=>Promise<MiningReadiness|void>;typeFacts:(typeIDs:readonly number[])=>Promise<Readonly<Record<number,Fact>>>;
 capacityM3:number;oreLogistics?:{version:1;remoteCompression:boolean;compressedJettisonFraction:number};timeoutMs?:number;pollMs?:number}){
 const {shipID,current}=config;if(!positive(shipID)||!Number.isFinite(config.capacityM3)||config.capacityM3<=0)throw Error("Invalid miner ship or can capacity.");
 const opts={...session.flow.requestOptions(),baseUrl:run.baseUrl,fetch:run.fetch},f=session.flow.flying;
 const guard=()=>{current();if(session.store.station.get().online?.characterID!==run.characterID)throw Error("Miner pilot changed.");};
 const scene=async(target:Target,claim:Claim)=>{guard();const arrival=await config.assertAtTarget(target,claim);guard();const raw=arrival?.raw??(await getSpaceSnapshot(opts)).space;guard();
  const record=raw as {entities?:unknown}|null;if(!raw||typeof raw!=="object"||Array.isArray(raw)||!Array.isArray(record?.entities))throw Error("Miner scene entities are unreadable.");
  const containers=record.entities.filter((x:unknown)=>x&&typeof x==="object"&&!Array.isArray(x)&&(x as {kind?:unknown}).kind==="container") as {itemID?:unknown;ownerID?:unknown;typeID?:unknown}[];
  if(containers.some(x=>!positive(x.itemID)||!positive(x.ownerID))||new Set(containers.map(x=>x.itemID)).size!==containers.length)throw Error("Miner scene containers are ambiguous.");
  const x=decodeSpaceSnapshot(raw);if(x.stateValid===false||!x.inSpace||x.shipID!==shipID||x.ship?.itemID!==shipID||(x.ship.characterID!=null&&x.ship.characterID!==run.characterID)||x.solarSystemID!==target.systemID||!Number.isFinite(x.sampledAtMs))throw Error("Miner scene scope is uncertain.");
  return {sampledAt:x.sampledAtMs!,owned:containers.filter(x=>x.ownerID===run.characterID).map(x=>x.itemID as number),containers};};
 async function oreHolds(){
  guard();
  const response=await run.fetch(new URL("/api/bridge/ship/ore-hold",run.baseUrl)).catch(fleetReadFailed);
  const panel=await response.json().catch(error=>response.ok?fleetReadFailed(error):null);
  guard();
  if(!response.ok)fleetReadFailed(Object.assign(Error(panel?.message??"Freight holds are unavailable."),{code:panel?.error,status:response.status}));
  if(panel?.ok!==true||panel.activeShipID!==shipID||!Array.isArray(panel.holds))throw Error("Fresh freight holds are unavailable.");
  return panel.holds as (HoldCapacity&{items?:unknown})[];
 }
 async function holdEmpty(){
  const holds=await oreHolds();
  // The panel can prove an empty hold during cooldown. Any uncertainty goes
  // through the exact inventory read when a new Jettison is allowed.
  return ["cargo","ore","gas","ice","asteroid"].every(key=>{
   const matches=holds.filter(hold=>hold?.key===key);
   const hold=matches[0];
   return matches.length===1&&hold?.error===null&&hold.capacity?.used===0&&Array.isArray(hold.items)&&hold.items.length===0;
  });
 }
 async function observeHolds(target:Target,claim:Claim,flush=false):Promise<RawHoldObservation>{const s=await scene(target,claim),rows=await readNativeShipHolds(session,guard,run.characterID,shipID);
  const facts=await config.typeFacts([...new Set(rows.map(r=>r.typeID))]);guard();let items=rows.flatMap(r=>{const fact=facts[r.typeID];if(!fact||!positive(fact.categoryID)||r.categoryID!==null&&r.categoryID!==fact.categoryID)throw Error("Held item type is uncertain.");
   if(fact.categoryID!==25)return [];if((target.kind==="ICE"?fact.resourceFamily!=="ice":fact.resourceFamily!=null&&fact.resourceFamily!=="ore")||!(fact.freightKind==="RAW"||config.oreLogistics?.remoteCompression&&fact.freightKind==="COMPRESSED")||!Number.isFinite(fact.unitVolumeM3)||fact.unitVolumeM3<=0)throw Error("Only verified raw ore can be jettisoned.");return [{itemID:r.itemID,typeID:r.typeID,quantity:r.quantity,freightKind:fact.freightKind! as "RAW"|"COMPRESSED",unitVolumeM3:fact.unitVolumeM3}];});
  if(config.oreLogistics?.remoteCompression){const holds=await oreHolds();const summary=summarizeFreight(rows,holds,facts as any,target.kind==="ICE"?"ice":"ore"),selected=selectFreight(summary,{flush,compressedThreshold:config.oreLogistics.compressedJettisonFraction,canCapacityM3:config.capacityM3});if(selected?.oversize.length)throw Error("A freight stack exceeds physical can capacity; no split was sent.");items=selected?.items??[];}
  if(items.length){const capacity=await readJettisonCapacity(run,guard);if(config.capacityM3>capacity)throw Error("Configured can capacity exceeds the native Cargo Container capacity.");}
  const strictFacts=Object.fromEntries(items.map(i=>[i.typeID,{categoryID:25,freightKind:i.freightKind,unitVolumeM3:i.unitVolumeM3}]));
  return {source:{source:"checked-ship-holds",characterID:run.characterID,shipID,systemID:target.systemID,targetKey:claim.key,claimGeneration:claim.generation,observedAt:Date.now(),items:rows},items,facts:strictFacts,capacityM3:config.capacityM3,existingContainerIDs:s.owned,sceneSampledAt:s.sampledAt};}
 async function observeCreatedCan(before:RawHoldObservation,target:Target,claim:Claim):Promise<RawCanObservation>{const end=Date.now()+(config.timeoutMs??15000);const selected=new Set(before.items.map(i=>i.itemID));
  while(Date.now()<end){const s=await scene(target,claim);if(s.sampledAt<before.sceneSampledAt)throw Error("Miner scene went backwards.");const candidates=s.owned.filter(id=>!before.existingContainerIDs.includes(id));if(candidates.length>1)throw Error("More than one new owned can is visible.");
   const after=await readNativeShipHolds(session,guard,run.characterID,shipID);const untouched=before.source.items.filter(x=>!selected.has(x.itemID));
   // A mining cycle can grow a selected raw stack before native Jettison or
   // credit ore to the hold after it. Only the requested stack IDs move.
   const sourceVerified=before.miningContinues?!after.some(row=>selected.has(row.itemID)):
    after.length===untouched.length&&untouched.every(x=>after.some(y=>x.itemID===y.itemID&&x.typeID===y.typeID&&x.quantity===y.quantity&&x.ownerID===y.ownerID&&x.locationID===y.locationID&&x.flagID===y.flagID));
   if(candidates.length===1&&sourceVerified){const containerID=candidates[0]!;if(s.containers.find(c=>c.itemID===containerID)?.typeID!==23)throw Error("Created object is not the native Cargo Container type.");guard();await f.bridgeDo("invCache","InvalidateLocationCache",[containerID]);guard();const rows=checkedInventory(await f.bridgeAsk("invbroker","List",[],null,containerID));guard();
    if(rows.length!==before.items.length||rows.some(r=>r.locationID!==containerID||r.ownerID!==run.characterID||r.flagID!==0))throw Error("Created can content is uncertain.");
    const items=before.items.map(item=>{
     const row=rows.find(r=>r.itemID===item.itemID&&r.typeID===item.typeID);
     if(!row||(before.miningContinues&&item.freightKind==="RAW"?row.quantity<item.quantity:row.quantity!==item.quantity))throw Error("Created can content is uncertain.");
     return {...item,quantity:row.quantity};
    });
    return {containerID,ownerID:run.characterID,shipID,systemID:target.systemID,targetKey:claim.key,claimGeneration:claim.generation,observedAt:Date.now(),items,sourceAfter:{...before.source,observedAt:Date.now(),items:after}};
   }await sleep(config.pollMs??500);
  }throw Object.assign(Error("Created can or source removal was not confirmed; reconciliation is required."),{code:"JETCAN_OBSERVATION_PENDING"});}
 return {current:guard,observeHolds,observeCreatedCan,holdEmpty};
}
