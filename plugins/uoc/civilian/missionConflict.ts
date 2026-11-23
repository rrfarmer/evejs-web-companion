import type {PilotSession} from "../../../web/src/plugin-api/pilotSession.ts";
import {readDictPairs,unwrapLong,type JsonValue} from "../shared/wire.ts";
import {agentMission,missionLabel,referralAgent,type JournalRow,type MissionJournal,type conversation} from "../distribution/native.ts";
import {readAfterTimeout} from "../shared/progressDeadline.ts";

/** A missing Request button or a timeout does not identify a conflicting mission. */
export function existingMissionRefusal(words:string){
 return /\byou (?:already have (?:an? )?(?:outstanding |active |accepted |pending )?(?:mission|offer)|must (?:finish|complete|cancel|quit|decline) (?:your |the )?(?:existing |current |other )?(?:mission|offer))\b/i.test(words);
}

export function missionRefusalText(error:unknown):string|null {
 const e=error as {status?:number;message?:string;data?:{error?:string}}|null;
 return e?.status===409&&e.data?.error==="CALL_REFUSED"&&e.message?e.message:null;
}

export function conflictingMission(journal:MissionJournal,agentID:number,reason:string):JournalRow {
 const rows=[...journal.active,...journal.offered];
 const detail=rows.length?` Journal contains ${rows.map(missionLabel).join(", ")}.`:"";
 if(!existingMissionRefusal(reason)||agentMission(journal,agentID)||rows.length!==1)
  throw Error(`Agent ${agentID} refused Request: ${reason.replace(/\.$/,"")}.${detail}`);
 return rows[0]!;
}

// EveJS can turn in a referral just by opening the recipient's conversation.
export async function referralTargets(journal:MissionJournal,briefing:(id:number)=>Promise<{objective:unknown}>){
 const targets=new Map<number,JournalRow>();
 for(const row of journal.active){
  if(!/(?:TalkToAgent|AgentInteraction)$/.test(row.missionType??""))continue;
  const target=referralAgent((await readAfterTimeout(()=>briefing(row.agentID))).objective);
  if(!target||target<=0)throw Error(`${missionLabel(row)}: native referral destination is unreadable.`);
  targets.set(target,row);
 }
 return targets;
}
export function referralConflict(row:JournalRow,agentID:number){
 return `Agent ${agentID} would turn in ${missionLabel(row)} on contact. Choose a different agent or resolve that referral.`;
}

export class DeclineUnavailable extends Error {}

type Dialogue=(agentID:number,action?:number|null)=>Promise<NonNullable<ReturnType<typeof conversation>>>;
export async function clearBlockingMission(row:JournalRow, deps:{
 session:PilotSession;
 journal:()=>Promise<MissionJournal>;
 record:(agentID:number)=>Promise<{agentID:number;agentTypeID:number;stationID:number|null}>;
 briefing:(agentID:number)=>Promise<JsonValue|undefined>;
 dialogue:Dialogue;
 travel:(stationID:number)=>Promise<void>;
 guard:()=>void;
 dispatch:(kind:"decline"|"quit",write:()=>Promise<void>)=>Promise<void>;
 }){
 const {agentID}=row,kind=row.missionState===1?"decline":"quit",label=missionLabel(row);
 const agent=await deps.record(agentID);
 if(agent?.agentID!==agentID||agent.agentTypeID!==2||row.important!==false||
    kind==="quit"&&!/(?:^|\/)(?:Courier|Mining)$/.test(row.missionType??"")){
  const message=`${label} blocks Request. Automatic ${kind} is limited to ordinary missions.`;
  throw kind==="decline"?new DeclineUnavailable(message):Error(message);
 }
 if(kind==="quit"){
  if(!agent.stationID)throw Error(`${label} blocks Request. The issuing agent's station is unavailable for Quit.`);
  await deps.travel(agent.stationID);
 }else{
  const briefing=await deps.briefing(agentID);
  const ticks=unwrapLong(readDictPairs(briefing).find(([key])=>key==="Decline Time")?.[1]);
  if(ticks===null)throw new DeclineUnavailable(`${label} blocks Request. Native decline availability is unreadable.`);
  if(ticks>0n)throw new DeclineUnavailable(`${label} blocks Request. Native decline timer has ${(ticks+9_999_999n)/10_000_000n}s remaining.`);
 }
 const current=agentMission(await readAfterTimeout(deps.journal),agentID);
 if(current?.missionKey!==row.missionKey||current.missionState!==row.missionState)
  throw Error(`${label} changed before ${kind}.`);
 deps.guard();
 const dialogue=await deps.dialogue(agentID,null),button=dialogue.actions.find(a=>a.button===(kind==="decline"?9:11));
 if(!button){
  const message=`${label} blocks Request. The agent did not offer ${kind}: ${dialogue.says||"no matching native action"}.`;
  throw kind==="decline"?new DeclineUnavailable(message):Error(message);
 }
 try{
  await deps.dispatch(kind,async()=>{
   const {store,flow}=deps.session;
   const suppressID=kind==="decline"?"AgtDeclineMission":"AgtQuitMission";
   const original=new Set(store.live.get().questions.map(q=>q.id));
   let answered=false;
   const unsubscribe=store.live.subscribe(({questions})=>{
    if(answered)return;
    const pending=questions.find(q=>!original.has(q.id)&&q.kind==="yesNo"&&q.service==="agents"&&q.method==="YesNo"&&
     q.agentID===agentID&&q.suppressID===suppressID&&(kind==="decline"||q.contentID===row.missionID));
    if(!pending)return;
    answered=true;
    void flow.answerQuestion(pending.id,true).catch(()=>{ /* The native action result determines settlement. */ });
   });
   try{
    const result=await deps.dialogue(agentID,button.id);
    const confirmed=kind==="decline"?result.declined:result.quit;
    if(confirmed!==true)
     throw Object.assign(Error(result.says||"The native action was not confirmed."),{missionActionRefused:confirmed===false});
   }finally{unsubscribe();}
  });
 }catch(error){
  throw Error(`${label}: ${kind} did not settle: ${error instanceof Error?error.message:String(error)}`,{cause:error});
 }
}
