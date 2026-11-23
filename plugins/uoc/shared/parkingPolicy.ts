const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
export type ParkingPolicy = { readonly mode:"nearest" } | { readonly mode:"selected"; readonly destinationID:number; readonly kind:"station"|"structure"; readonly systemID:number };
export function decodeParkingPolicy(value:unknown):ParkingPolicy|null {
 if(value===undefined)return {mode:"nearest"};
 const v=record(value);if(!v)return null;
 if(v.mode==="nearest"&&Object.keys(v).length===1)return {mode:"nearest"};
 if(v.mode==="selected"&&Object.keys(v).length===4&&positive(v.destinationID)&&positive(v.systemID)&&(v.kind==="station"||v.kind==="structure"))return {mode:"selected",destinationID:v.destinationID,kind:v.kind,systemID:v.systemID};
 return null;
}
