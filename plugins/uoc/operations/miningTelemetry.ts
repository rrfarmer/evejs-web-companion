import { haulOwner, type Manifest } from "../miningFleet/operation.ts";

/** Present durable native freight evidence; publication is never counted as delivery. */
export function miningFreightTelemetry(snapshot:any,board:Record<string,any>={}) {
 const manifests:readonly Manifest[]=Array.isArray(snapshot?.manifests)?snapshot.manifests:[];
 const claims=snapshot?.haulClaims??{};
 const groups=new Map<string,any[]>();
 for(const m of manifests)if(!m.delivered){const rows=groups.get(m.targetKey)??[];rows.push(m);groups.set(m.targetKey,rows);}
 const logisticsTail=[...groups].filter(([key])=>snapshot?.relocation||key!==snapshot?.claim?.key).map(([key,rows])=>({target:{targetKey:key,targetType:board[key]?.target?.kind??'BELT',systemID:rows[0].systemID,systemName:null,targetName:board[key]?.target?.name??key,state:'DRAINING',claimedByOperationID:snapshot.operationID},pendingHaulers:[...new Set(rows.map(m=>haulOwner({haulClaims:claims},m)?.characterID).filter(Boolean))]}));
 const history=manifests.flatMap(m=>{
  const deliveredAt=m.delivered&&Number.isFinite(m.deliveredAt)?m.deliveredAt:undefined;
  const receiptAvailable=deliveredAt!==undefined,at=deliveredAt??m.observedAt;
  return Number.isFinite(at)?[{at:new Date(at).toISOString(),target:null,kind:m.delivered?'FREIGHT_DELIVERED':'FREIGHT_PUBLISHED',evidence:{containerID:m.containerID,category:m.category,volumeM3:m.volumeM3,items:(m.items??[]).map(i=>({typeID:i.typeID,quantity:i.quantity})),receiptAvailable,timestampSource:m.delivered&&!receiptAvailable?'original-publication':'native-receipt'}}]:[];
 });
 for(const r of snapshot?.relocationHistory??[])if(Number.isFinite(r.completedAt))history.push({at:new Date(r.completedAt).toISOString(),kind:'TARGET_RELOCATED',target:{targetKey:r.newClaim.key,targetType:r.next.kind,systemID:r.next.systemID,systemName:null,targetName:r.next.name,state:'HISTORICAL',claimedByOperationID:snapshot.operationID},evidence:{oldClaim:r.oldClaim,newClaim:r.newClaim,proofs:r.proofs}} as any);
 history.sort((a:any,b:any)=>Date.parse(a.at)-Date.parse(b.at));
 return {logisticsTail,history};
}

/** Fit existence alone never becomes a green capability. Each active effect keeps its own observation age. */
export function miningSupportTelemetry(value:any,now=Date.now()) {
 if(!value)return undefined;
 const sample=value.observedSupport,at=sample?.observedAt;if(!Number.isFinite(at))return undefined;
 const fresh=value.active===true&&Number.isFinite(at)&&at<=now&&now-at<=60000;
 const capability=(name:string,modules:any[],active:(m:any)=>number|null)=>{
  const times=modules.map(active),qualified=modules.length>0&&times.every(t=>t!==null&&t<=now&&now-t<=60000)&&fresh;
  return {capability:name,state:qualified?'QUALIFIED':'PENDING',modules:modules.length,reason:qualified?'Native effect observed on the selected ship.':modules.length?'Current native effect is not confirmed.':'Not selected or not yet observed.'};
 };
 const bursts=capability('Bursts',value.bursts??[],m=>{const rows=m.controller?.history??[];const after=rows.at(-1)?.after;return after?.active===true?after.observedAt??null:null;});
 const core=capability('Industrial Core',value.core?[value.core]:[],m=>m.current?.shutdown?.inactive?null:value.coreObservation?(value.coreObservation.core?.active===true?value.coreObservation.effectObservedAt??null:null):m.current?.activation?.effect?.effectObservedAt??null);
 const compressor=capability('Compression',value.compressor?[value.compressor]:[],m=>m.current?.inactive?null:value.compressorObservation?(value.compressorObservation.module?.effects?.some((e:any)=>e.effectID===m.identity?.effectID)?value.compressorObservation.observedAt??null:null):m.current?.active?.observedAt??null);
 const tractor=capability('Tractor',value.tractor?[value.tractor]:[],m=>m.inactive?null:m.active?.observedAt??null);
 if(fresh&&core.state!=='QUALIFIED'&&value.coreObservation?.fuel?.availability==='available'&&value.coreObservation.fuel.sufficient===false&&Number.isFinite(value.coreObservation.effectObservedAt)&&now-value.coreObservation.effectObservedAt<=60000){core.state='MISSING_SUPPLIES';core.reason='The native Core fuel observation is below its effective cycle requirement. Optional support may degrade.';}
 if(fresh&&value.emptyBurstModules>0&&bursts.state!=='QUALIFIED'){bursts.state='MISSING_SUPPLIES';bursts.reason='Native burst-charge observation found an empty selected module; optional support may degrade.';}
 const inactive=value.core?.lastInactive?.effectObservedAt,mobile=fresh&&value.movementSuspended===false&&Number.isFinite(inactive)&&inactive<=now&&now-inactive<=60000;
 const mobility={capability:'Mobility',state:core.state==='QUALIFIED'?'BLOCKED':mobile?'QUALIFIED':'PENDING',modules:0,reason:core.state==='QUALIFIED'?'The native Industrial Core effect is active; movement waits for shutdown.':mobile?'Selected Core shutdown was observed; the movement controller still verifies flight and route eligibility.':'Current movement eligibility is not proven by a fitting or an old support receipt.'};
 return {state:value.active===false?sample.observation.state:fresh?sample.observation.state:'PENDING',core:fresh?sample.observation.core:'unknown',reason:value.active===false?'Historical '+sample.observation.state+' observation. '+(sample.observation.reason??'Current effects are not inferred.'):fresh?sample.observation.reason:'Current support observation is unavailable or stale.',observedAtMs:at,capabilities:[bursts,core,compressor,tractor,mobility]};
}

/** UI inventory values come from the existing native hold reads, not a second observer. */
export function miningMemberFreightTelemetry(value:any,operation:any,characterID:number,config:any,support?:any,now=Date.now()) {
 if(!value||value.source!=='native-ship-holds'||!Array.isArray(value.holds)||!value.holds.length||!Number.isFinite(value.observedAt)||new Set(value.holds.map((h:any)=>h.flagID)).size!==value.holds.length||value.holds.some((h:any)=>!h||!Number.isSafeInteger(h.flagID)||['rawM3','compressedM3','rawQuantity','compressedQuantity'].some(k=>!Number.isFinite(h[k])||h[k]<0)||!(h.capacityM3===null||Number.isFinite(h.capacityM3)&&h.capacityM3>=0)))return null;
 const primary=value.holds.find((h:any)=>h.flagID===value.primaryHoldFlagID),sum=(key:string)=>value.holds.reduce((n:number,h:any)=>n+h[key],0);
 const can=(operation?.manifests??[]).filter((m:any)=>m.characterID===characterID).at(-1);
 const f=value.facility,fresh=(at:unknown)=>typeof at==='number'&&Number.isFinite(at)&&at<=now&&now-at<=60000;
 const capabilities=miningSupportTelemetry(support,now)?.capabilities;
 const qualified=operation?.state==='ACTIVE'&&support?.active===true&&f&&f.claimKey===operation.claim?.key&&f.claimGeneration===operation.claim?.generation&&f.systemID===operation.systemID&&f.commanderCharacterID===support.characterID&&f.commanderShipID===support.shipID&&f.commanderSessionGeneration===support.sessionGeneration&&Number.isSafeInteger(f.minerSessionGeneration)&&f.minerSessionGeneration>=0&&Number.isSafeInteger(f.fleetID)&&f.fleetID>0&&fresh(f.observedAt)&&Number.isFinite(f.sceneSampledAt)&&fresh(value.observedAt)&&fresh(support.observedSupport?.observedAt)&&capabilities?.some(c=>c.capability==="Industrial Core"&&c.state==="QUALIFIED")&&capabilities?.some(c=>c.capability==="Compression"&&c.state==="QUALIFIED")&&support.core?.identity?.moduleID===f.coreModuleID&&support.compressor?.identity?.moduleID===f.compressorModuleID&&Array.isArray(f.matchingTypeListIDs)&&f.matchingTypeListIDs.length>0&&f.matchingTypeListIDs.every((n:any)=>Number.isSafeInteger(n)&&n>0)&&Number.isFinite(f.rangeMeters)&&Number.isFinite(f.surfaceDistanceMeters)&&f.surfaceDistanceMeters>=0&&f.surfaceDistanceMeters<=f.rangeMeters;
 return {enabled:config?.remoteCompression===true,rawM3:sum('rawM3'),compressedM3:sum('compressedM3'),rawUnits:sum('rawQuantity'),compressedUnits:sum('compressedQuantity'),capacityM3:primary?.capacityM3??null,holds:value.holds,
  observedAtMs:value.observedAt,jetcanCapacityM3:can?.capacityM3??null,facility:qualified?{shipID:f.commanderShipID,characterID:f.commanderCharacterID,fleetID:String(f.fleetID),sessionEpoch:String(f.minerSessionGeneration),typeListRanges:f.matchingTypeListIDs.map((typeListID:number)=>({typeListID,rangeMeters:f.rangeMeters})),distanceMeters:f.surfaceDistanceMeters}:null,facilityObservation:value.facility??null,compatibility:qualified&&Number.isSafeInteger(f.sourceTypeID)&&Number.isSafeInteger(f.compressedTypeID)?[{typeID:f.sourceTypeID,compressedTypeID:f.compressedTypeID,matchingTypeListIDs:f.matchingTypeListIDs,availability:'available'}]:null,
  pending:operation?.jetcanIntents?.[String(characterID)]?true:value.pendingCompression===true?true:value.pendingCompression===false?false:null,
  jettisonRetryAfterMs:operation?.jetcanCooldowns?.[String(characterID)]?.retryAt??0,fault:null};
}
