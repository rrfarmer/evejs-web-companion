import {registerRun} from '../runControl.ts';
import type {PluginRunContext} from '../../../web/src/plugin-api/backend.ts';
const controls=new Map<string,{operationID:string;epoch:string;stopOperation:()=>void;snapshot?:()=>unknown}>();
/** Distinguish the original COC whole-operation Stop from one hosted member's
 * retirement. This registry carries no credentials and performs no native action. */
export function registerCombatRun(run:PluginRunContext,owner:string,retire:()=>void,stopOperation:()=>void,snapshot?:()=>unknown){
 const setup=run.setup as any;if(typeof setup?.operationID!=='string'||typeof setup.operationRunID!=='string')return registerRun(run,owner,retire);
 const unregister=registerRun(run,owner,retire),entry={operationID:setup.operationID,epoch:setup.operationRunID,stopOperation,snapshot};controls.set(run.botID,entry);
 return ()=>{if(controls.get(run.botID)===entry)controls.delete(run.botID);unregister();};
}
export function requestCombatOperationStop(operationID:string,epoch:string){const entries=[...controls.values()].filter(c=>c.operationID===operationID&&c.epoch===epoch);if(!entries.length)throw Error('The exact current COC controllers are unavailable; retained native journals require reconciliation. No new login or Stop was sent.');for(const c of entries)c.stopOperation();return entries.length;}

export function combatControlSnapshot(operationID:string,epoch:string){for(const c of controls.values())if(c.operationID===operationID&&c.epoch===epoch&&c.snapshot)try{return structuredClone(c.snapshot());}catch{}return null;}
