/** Exact native destination selected for this operation. Null corporation and division select the pilot's personal hangar. */
export type FleetDelivery = {readonly kind:"station"|"structure";readonly destinationID:number;readonly systemID:number;readonly corporationID:number|null;readonly division:number|null};
const positive=(x:unknown):x is number=>typeof x==="number"&&Number.isSafeInteger(x)&&x>0;
export function decodeFleetDelivery(value:unknown):FleetDelivery|null {
 const x=value as FleetDelivery;
 if(!x||typeof x!=="object"||Array.isArray(x)||Object.keys(x).sort().join(",")!=="corporationID,destinationID,division,kind,systemID"||!["station","structure"].includes(x.kind)||!positive(x.destinationID)||!positive(x.systemID))return null;
 if(!(x.corporationID===null&&x.division===null)&&!(positive(x.corporationID)&&positive(x.division)&&x.division<=7))return null;
 return {kind:x.kind,destinationID:x.destinationID,systemID:x.systemID,corporationID:x.corporationID,division:x.division};
}
