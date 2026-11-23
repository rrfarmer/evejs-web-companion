import type { SecurityStorage } from './journal.ts';
import type { State } from './security.ts';
/** Keep all completed receipts and the active journal in a single atomic document. */
export function securityHistory(document:SecurityStorage, accountID:string, characterID:number) {
 const raw=document.read() as any;
 const envelope=raw?.format==='security-history-v1'?raw:{format:'security-history-v1',history:[],active:raw};
 if(!Array.isArray(envelope.history))throw new Error('Security history is malformed.');
 const old=envelope.active as State|null;
 if(old&&(old.pending!==null||!Array.isArray(old.completed)||old.characterID!==characterID||old.accountID!==accountID||!(old.phase==='DONE'&&old.completed.length>0||old.phase==='COMBAT'&&old.identity&&old.offer)))throw new Error('A Security journal retains unfinished or foreign custody.');
 const storage:SecurityStorage={read:()=>envelope.active,write:v=>{envelope.active=v;document.write(envelope);}};
 return {storage,candidate:old?.phase==='COMBAT'?old:null,handoff(next:State){if(!old||old.phase!=='COMBAT'||old.pending!==null||next.runID===old.runID)throw new Error('Invalid Security handoff.');envelope.history.push(old);envelope.active=next;document.write(envelope);},rollover(docked:boolean){if(!old||old.phase==='COMBAT')return;if(!docked)throw new Error('Previous Security receipt requires docked custody before rollover.');envelope.history.push(old);envelope.active=null;document.write(envelope);}};
}
