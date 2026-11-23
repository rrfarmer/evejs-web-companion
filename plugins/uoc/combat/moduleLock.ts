import type {SecurityStorage} from './journal.ts';
export type CombatTargetLock={key:string;characterID:number;shipID:number;targetID:number};
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
/** One original AddTarget per scoped target. A response loss remains unknown;
 * caller must retain custody and may not issue another AddTarget. A definitive
 * native refusal retires only that exact attempt for callers that support it. */
export async function executeCombatTargetLock(identity:CombatTargetLock,deps:{document:SecurityStorage;current():void;receiptCurrent?():void;fence():Promise<void>;lock():Promise<unknown>;definiteRefusal?(error:unknown):boolean;now():number}):Promise<void|'refused'>{
 if(typeof identity.key!=='string'||!identity.key||![identity.characterID,identity.shipID,identity.targetID].every(positive))throw Error('Combat target lock identity is incomplete.');
 type Entry={identity:CombatTargetLock;status:'DISPATCHED'|'ACKNOWLEDGED'|'REFUSED';issuedAt:number};
 const raw=deps.document.read(),doc=raw===null?{version:1,entries:[] as Entry[]}:raw as {version:1;entries:Entry[]};
 if(!doc||doc.version!==1||!Array.isArray(doc.entries)||doc.entries.some(e=>!e||!e.identity||typeof e.identity.key!=='string'||!e.identity.key||![e.identity.characterID,e.identity.shipID,e.identity.targetID].every(positive)||!['DISPATCHED','ACKNOWLEDGED','REFUSED'].includes(e.status)||!Number.isSafeInteger(e.issuedAt))||new Set(doc.entries.map(e=>e.identity.key)).size!==doc.entries.length)throw Error('Combat target lock journal is unreadable.');
 const entry=doc.entries.find(e=>e.identity.key===identity.key);if(entry&&JSON.stringify(entry.identity)!==JSON.stringify(identity))throw Error('Combat target lock key belongs to another identity.');
 if(doc.entries.some(e=>e.identity.key!==identity.key&&e.identity.characterID===identity.characterID&&e.identity.shipID===identity.shipID&&e.status==='DISPATCHED'))throw Error('Another combat target lock remains unresolved; custody retained.');
 if(entry?.status==='ACKNOWLEDGED')return;if(entry?.status==='REFUSED')return 'refused';if(entry)throw Error('Combat target lock dispatch is unresolved; no replay.');
 deps.current();await deps.fence();deps.current();const next:Entry={identity,status:'DISPATCHED',issuedAt:deps.now()};doc.entries.push(next);deps.document.write(doc);deps.current();
 try{await deps.lock();}
 catch(error){
  if(!deps.definiteRefusal?.(error))throw error;
  (deps.receiptCurrent??deps.current)();next.status='REFUSED';deps.document.write(doc);return 'refused';
 }
 (deps.receiptCurrent??deps.current)();next.status='ACKNOWLEDGED';deps.document.write(doc);
}
