import type {boundDogma} from '../../../../web/src/plugin-api/flying.ts';
type Dogma=Awaited<ReturnType<typeof boundDogma>>;
type Flight={shipID:number|null;solarSystemID:number|null;inSpace:boolean;docked:boolean};
const id=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;
const sameID=(n:unknown,expected:number)=>n===expected||typeof n==='string'&&/^\d+$/.test(n)&&BigInt(n)===BigInt(expected);
/** Strict equivalent of WC's withDogmaCharges for one exact own-ship slot. */
export function resolveDogmaCharge(input:{before:Flight;after:Flight;dogma:Dogma;characterID:number;shipID:number;flagID:number}):{itemID:readonly [number,number,number];typeID:number;quantity:number}{
 const {before,after,dogma,characterID,shipID,flagID}=input;
 if(!id(characterID)||!id(shipID)||!id(flagID)||before.shipID!==shipID||after.shipID!==shipID||before.inSpace!==true||after.inSpace!==true||before.docked!==false||after.docked!==false||!id(before.solarSystemID)||after.solarSystemID!==before.solarSystemID)throw Error('Cached charge unavailable; commander flight scope changed.');
 const all=dogma?.allInfo;if(!all||all.error!==null||!all.value)throw Error('Cached charge unavailable; native dogma snapshot is unreadable.');const data=all.value;
 if(!sameID(data.activeShipID,shipID)||!sameID(data.characterID,characterID)||!Array.isArray(data.ships))throw Error('Cached charge unavailable; native dogma owner or ship differs.');
 const matches=data.ships.filter(item=>Array.isArray(item.sublocation)&&item.sublocation.length===3&&item.sublocation[0]===shipID&&item.sublocation[1]===flagID);
 if(matches.length!==1)throw Error('Cached charge unavailable; native dogma sublocation is missing or ambiguous.');
 const entry=matches[0]!,tuple=entry.sublocation!;if(!id(tuple[2])||entry.typeID!==tuple[2]||entry.locationID!==shipID&&!sameID(entry.locationID,shipID)||entry.flagID!==flagID)throw Error('Cached charge unavailable; native dogma sublocation identity differs.');
 if(!Array.isArray(entry.attributes))throw Error("Cached charge unavailable; native dogma attributes are unreadable.");
 const attrs=entry.attributes.filter((a:{attributeID:number;value:number})=>a.attributeID===805);if(attrs.length!==1||!Number.isSafeInteger(attrs[0]?.value)||attrs[0]!.value<0)throw Error('Cached charge unavailable; native dogma charge quantity is unreadable.');
 return {itemID:[shipID,flagID,tuple[2]],typeID:tuple[2],quantity:attrs[0]!.value};
}
