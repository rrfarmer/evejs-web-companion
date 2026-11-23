/** Fit-derived module identities used by the existing fighter. IDs come from
 * PilotFlying's warmed native group classifier, never from an operator role. */
export type ModuleSlot={family:'high'|'mid'|'low'|'rig'|'subsystem';index:number;module:{itemID:number;typeID:number;online:boolean}|null};
export type ClassifiedModules={weapons:readonly number[];shield:readonly number[];armor:readonly number[];hull:readonly number[];hardeners:readonly number[]};
export type RemoteModules={shield:readonly number[];armor:readonly number[];hull:readonly number[];cap:readonly number[]};
export type CombatFitModule={itemID:number;typeID:number;flagID:number;kind:'weapon'|'shield'|'armor'|'hull'|'hardener'|'remote-shield'|'remote-armor'|'remote-hull'|'remote-cap'};
export type RemoteRepairModule=CombatFitModule & {kind:'remote-shield'|'remote-armor'|'remote-hull'};
export function isRemoteRepair(module:CombatFitModule):module is RemoteRepairModule {
 return module.kind==='remote-shield'||module.kind==='remote-armor'||module.kind==='remote-hull';
}
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const bases={high:27,mid:19,low:11,rig:92,subsystem:125} as const;
/** Server auto-targeting missiles can replace the supplied target before the
 * lock check. A present type row with no 1455 attribute means the SDE has no
 * such attribute; an absent row means the read failed and cannot qualify. */
export function assertScopedWeaponCharge(chargeTypeID:number|null,known:Readonly<Record<number,Readonly<Record<number,number>>>>):void{
 if(chargeTypeID===null)return;
 if(!positive(chargeTypeID)||!Object.hasOwn(known,chargeTypeID))throw Error('Weapon charge targeting facts are unavailable.');
 const value=known[chargeTypeID]![1455];if(value!==undefined&&(!Number.isFinite(value)||value>0))throw Error('Auto-targeting or unreadable weapon charge cannot be scoped to the selected target.');
}
/** Reject inconsistent or ambiguous classifications rather than silently
 * choosing between hostile and friendly effects. A module appears once. */
export function combatFitModules(slots:readonly ModuleSlot[],defense:ClassifiedModules,remote:RemoteModules,activation:(module:{itemID:number;typeID:number})=>'activatable'|'passive'|'unknown'):CombatFitModule[]{
 const groups:[CombatFitModule['kind'],readonly number[]][]=[['weapon',defense.weapons],['shield',defense.shield],['armor',defense.armor],['hull',defense.hull],['hardener',defense.hardeners],['remote-shield',remote.shield],['remote-armor',remote.armor],['remote-hull',remote.hull],['remote-cap',remote.cap]];
 const byID=new Map<number,CombatFitModule['kind']>();for(const [kind,ids] of groups)for(const id of ids){if(!positive(id)||byID.has(id))throw Error('Combat module classification is ambiguous.');byID.set(id,kind);}
 const result:CombatFitModule[]=[],seen=new Set<number>(),seenSlots=new Set<string>();
 for(const slot of slots){if(!slot||!Object.hasOwn(bases,slot.family)||!Number.isSafeInteger(slot.index)||slot.index<0||slot.index>=8)throw Error('Combat fitting slot is invalid.');const key=slot.family+':'+slot.index;if(seenSlots.has(key))throw Error('Combat fitting slot is duplicated.');seenSlots.add(key);
  const m=slot.module;if(!m)continue;if(!positive(m.itemID)||!positive(m.typeID)||seen.has(m.itemID))throw Error('Combat fitted module identity is invalid.');seen.add(m.itemID);const kind=byID.get(m.itemID);if(!kind)continue;if(!m.online||activation(m)==='passive')throw Error('Classified combat module is offline or passive.');
  if(kind==='weapon'&&slot.family!=='high')throw Error('Combat weapon is not in a high slot.');result.push({itemID:m.itemID,typeID:m.typeID,flagID:bases[slot.family]+slot.index,kind});byID.delete(m.itemID);
 }
 if(byID.size)throw Error('Classified combat module is absent from the held fitting.');return result;
}
export function fleetRepairFitModules(slots:readonly ModuleSlot[],remote:RemoteModules,activation:Parameters<typeof combatFitModules>[3]):RemoteRepairModule[]{
 return combatFitModules(slots,{weapons:[],shield:[],armor:[],hull:[],hardeners:[]},remote,activation).filter(isRemoteRepair);
}
