import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pluginDataDir} from '../../../web/src/plugin-api/backend.ts';
import {validCivilianRow,type CivilianIndexRow} from './index.ts';
import {miningAcceptedMission,rolloverMiningState} from '../mining/history.ts';
import {distributionAcceptedMission} from '../distribution/fence.ts';
const Database=createRequire(import.meta.url)('better-sqlite3');

/** Diagnostics do not retire custody. A parked accepted mission is still unfinished. */
export function civilianRecordEvidence(value:any,kind:'mining'|'distribution'){
 if(!value||typeof value!=='object')throw Error('The original Civilian checkpoint is unreadable.');
 if(kind==='mining'){
  const legacy=value.version===2?value:value.legacy,cycle=value.pending?.kind==='mining-cycle'||!!legacy?.cycle;
  const objective=value.mission??legacy?.objective,pending=value.pending?.kind??legacy?.pending?.kind??null;
  let completed=false;if(value.version===1&&value.completed===true){rolloverMiningState(value,null,value.characterID,value.setupKey);completed=true;}
  return {pending,legacyCycle:!!legacy?.cycle,cycle:cycle?'UNKNOWN':'NO_PENDING_CYCLE',missionSettled:completed,recoveryRequired:!completed,acceptedMission:miningAcceptedMission(value),
   agentID:value.agentID??legacy?.agentID??null,mission:objective?.content?.contentID??null,objectiveState:objective?.completionStatus??null,
   quantity:value.quantity??legacy?.shipQuantity??null,banked:legacy?.banked??null,firstFailure:value.lastFailure??null,
   reason:cycle?'Accepted mining cycle remains unresolved; docking and session release do not settle its outcome. No Activate replay.':pending?'The dispatched '+pending+' remains unresolved; no replay.':completed?'Native completion receipt is retained.':'The stored mission/cargo state is not proven complete.'};
 }
 const pending=value.pending?.intent?.kind??null,receipt=value.completion;
 const completed=value.done===true&&pending===null&&(value.mutated===false&&value.mission===null||receipt?.kind==='missionCompletion'&&receipt.completed===true&&receipt.runID===value.runID&&receipt.missionKey===value.mission?.missionKey&&receipt.agentID===value.mission?.agentID&&Number.isSafeInteger(receipt.invocationID)&&receipt.invocationID>0&&Number.isSafeInteger(receipt.actionID)&&receipt.actionID>0&&receipt.stepPath==='complete');
 return {pending,missionSettled:completed,recoveryRequired:!completed,acceptedMission:distributionAcceptedMission(value),agentID:value.mission?.agentID??null,missionKey:value.mission?.missionKey??null,
  reason:pending?'The dispatched '+pending+' requires exact native journal/cargo evidence; no replay.':completed?'Native completion or untouched-run retirement is retained.':'Accepted Distribution mission or cargo remains unresolved.'};
}

/** Only provenance written by the authorized original executor can restore an
 * orphan. Character IDs, file names and current login alone are insufficient. */
export function civilianOrphans(records:readonly {value:any;kind:'mining'|'distribution'}[],worldID:string,owner:string):CivilianIndexRow[]{
 const rows=new Map<string,CivilianIndexRow>(),completed=new Map<string,Set<string>>();
 const expanded=records.flatMap(r=>r.kind==='mining'?[r,...(r.value.history??[]).map((value:any)=>({value,kind:r.kind}))]:[r]);
 for(const {value,kind} of expanded){const row=value?.civilian;if(!validCivilianRow(row)||row.worldID!==worldID||row.owner!==owner.toLowerCase()||row.characterID!==value.characterID||row.kind!==kind||kind==='distribution'&&value.runID!==row.botID)continue;
  const evidence=civilianRecordEvidence(value,kind),key=kind==='mining'?value.completionReceipt?.mission:value.completion?.missionKey;
  if(evidence.missionSettled&&typeof key==='string'){const keys=completed.get(row.botID)??new Set<string>();keys.add(key);completed.set(row.botID,keys);}
  if(!rows.has(row.botID))rows.set(row.botID,{...row,pending:evidence.pending,resolved:evidence.missionSettled,worker:row.worker?{...row.worker,readout:{...(row.worker.readout as object??{}),...evidence,firstFailure:'firstFailure' in evidence?evidence.firstFailure??row.firstFailure:row.firstFailure,...(evidence.missionSettled&&value.reward?{reward:value.reward}:{})}}:undefined});
 }
 for(const [id,row] of rows)if(row.worker&&completed.has(id)){const v=row.worker.readout as any;row.worker.readout={...v,completedCount:Math.max(Number.isSafeInteger(v?.completedCount)?v.completedCount:0,completed.get(id)!.size)};}
 return [...rows.values()];
}
export function readCivilianOrphans(worldID:string,owner:string){
 const records:{value:any;kind:'mining'|'distribution'}[]=[];
 for(const file of ['missions.sqlite','distribution.sqlite']){
  const filename=path.join(pluginDataDir(),file);if(!fs.existsSync(filename))continue;
  const db=new Database(filename,{readonly:true,fileMustExist:true});try{
   if(file==='missions.sqlite')for(const row of db.prepare("SELECT value FROM documents WHERE name LIKE 'native-mining:%'").all())records.push({value:JSON.parse(row.value),kind:'mining'});
   else {const row=db.prepare('SELECT value FROM documents WHERE name=?').get('distribution-missions');if(row){const doc=JSON.parse(row.value);if(doc.version!==1||!doc.records)throw Error('Distribution recovery journal is unreadable.');for(const v of [...Object.values(doc.records),...(doc.history??[]).map((h:any)=>h.row)])records.push({value:v,kind:'distribution'});}}
  }finally{db.close();}
 }return civilianOrphans(records,worldID,owner);
}
