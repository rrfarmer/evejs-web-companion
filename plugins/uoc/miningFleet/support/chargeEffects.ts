/** Native chargeBonusWarfareCharge (SDE effect 6737): the charge's 2596–2599
 * multipliers modify the fitted module's 2469/2471/2473/2537 values. These
 * are charge qualification facts, not the final effective burst strength. */
export function chargeEffectCollections(type:unknown):number[]{
 const data=type as {groupID?:unknown;defaultEffectID?:unknown;attributes?:unknown}|null;
 if(!data||data.groupID!==1771||data.defaultEffectID!==6737||!Array.isArray(data.attributes))throw Error('Burst charge group or attributes are unreadable.');
 const relevant=new Set([2468,2470,2472,2536,2596,2597,2598,2599]),attrs=new Map<number,unknown>();
 for(const row of data.attributes){if(!Array.isArray(row)||row.length!==2||!Number.isSafeInteger(row[0]))throw Error('Burst charge attribute row is malformed.');if(relevant.has(row[0])){if(attrs.has(row[0]))throw Error('Burst charge attributes are repeated.');attrs.set(row[0],row[1]);}}
 const result:number[]=[];for(const [idKey,multiplierKey] of [[2468,2596],[2470,2597],[2472,2598],[2536,2599]] as const){
  const collection=attrs.get(idKey),multiplier=attrs.get(multiplierKey);
  if(typeof collection!=='number'||!Number.isSafeInteger(collection)||collection<0||typeof multiplier!=='number'||!Number.isFinite(multiplier))throw Error('Burst charge benefit facts are incomplete.');
  if(collection>0){if(multiplier===0)throw Error('Burst charge benefit multiplier is zero.');result.push(collection);}
 }
 if(!result.length||new Set(result).size!==result.length)throw Error('Burst charge benefit collections are unreadable.');return result;
}
