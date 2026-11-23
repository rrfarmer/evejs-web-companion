import {unresolvedCombatRuns} from './combatCustody.ts';
import {preparationEvidence} from './miningEvidence.ts';
import {requestCombatOperationStop,combatControlSnapshot} from '../combat/control.ts';
import { createHash } from "node:crypto";
import type { BackendRequest, BackendRoute } from "../../../web/src/plugin-api/backend.ts";
import type { CombatDefinition } from "../restored/app/combatOperations.ts";
import { openCombatStore } from "./combatStore.ts";
import { operationHasController } from "../runControl.ts";

type Store = ReturnType<typeof openCombatStore>;
export type CombatWorldScope = (request: BackendRequest) => string | null | Promise<string | null>;
const positive = (n:unknown):n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
function scopeOK(s:unknown):s is string { return typeof s === "string" && s.length>0 && s.length<=200 && s.trim()===s; }
function fingerprint(world:string,d:CombatDefinition) { return createHash("sha256").update(JSON.stringify([world,d])).digest("hex"); }
/** Only a candidate: the browser must still inspect custody, check the actual run and obtain its grant. */
export function combatLaunchCandidate(d:CombatDefinition):{candidate:unknown|null; gaps:string[]} {
 const gaps:string[]=[]; const o=d.objective; const m=d.members;if(d.mode==='DED_COMPLEX')return {candidate:null,gaps:['DED execution is disabled by operator decision.']};
 if(d.mode==='BELT_PATROL'||d.mode==='GATE_PATROL'){
  const leader=m[0];if(!leader)gaps.push('Choose a patrol pilot.');if(!positive(d.systemID))gaps.push('Select a patrol system.');if(m.some(p=>p.role!==undefined&&p.role!=='AUTO'))gaps.push('Explicit legacy roles are not connected.');if(d.preparation)gaps.push('Operation-wide supply preparation is not connected.');if(d.observationSeconds!==undefined&&(!Number.isSafeInteger(d.observationSeconds)||d.observationSeconds<5||d.observationSeconds>120))gaps.push('Patrol observation time is invalid.');if(d.parking?.mode&&!['NEAREST','SELECTED','RETURN_HOME_DOCK'].includes(d.parking.mode))gaps.push('Parking policy is unsupported.');const selected=d.parking?.mode==='SELECTED'||d.parking?.mode==='RETURN_HOME_DOCK';if(selected&&!positive(d.homeStationID)||!selected&&d.homeStationID!==null)gaps.push('Select an exact parking destination.');if(gaps.length||!leader)return {candidate:null,gaps};
  return {candidate:{runName:'combat-patrol-member',characterID:leader.characterID,accountName:leader.accountName,members:m.map(p=>({characterID:p.characterID,accountName:p.accountName,required:p.required!==false})),setup:{leaderID:leader.characterID,systemID:d.systemID,mode:d.mode,observationSeconds:d.observationSeconds??10,parking:selected?{mode:'selected',kind:d.homeKind??'station',destinationID:d.homeStationID,systemID:null}:{mode:'nearest'}}},gaps};
 }
 if(d.mode==="COMBAT_ANOMALY"){
  if(m.length<1||!o||!m.some(p=>p.characterID===o.ownerCharacterID))gaps.push("Choose an anomaly pilot and leader.");
  if(m.some(p=>p.role!==undefined&&p.role!=="AUTO"))gaps.push("Explicit legacy roles are not connected.");
  if(d.preparation)gaps.push("Operation-wide supply preparation is not connected.");
  if(!positive(d.systemID)||!positive(d.homeStationID))gaps.push("Select an operation system and return dock.");
  if(o?.maxSites!==undefined&&!positive(o.maxSites))gaps.push("Enter a positive site count.");
  if(o?.maxDifficulty!==undefined&&(!Number.isSafeInteger(o.maxDifficulty)||o.maxDifficulty<1||o.maxDifficulty>5))gaps.push("Select an authored difficulty from 1 to 5.");
  if(o?.siteID!==undefined&&o.siteID!==null&&!positive(o.siteID))gaps.push("The selected scanner site identity is invalid.");
  if(o?.discoveryWaitMinutes!==undefined&&(!positive(o.discoveryWaitMinutes)||o.discoveryWaitMinutes>4320))gaps.push("The discovery wait is invalid.");
  const owner=m.find(p=>p.characterID===o?.ownerCharacterID);if(gaps.length||!owner||!o)return {candidate:null,gaps};
  return {candidate:{runName:"anomaly-fleet-member",characterID:owner.characterID,accountName:owner.accountName,members:m.map(p=>({characterID:p.characterID,accountName:p.accountName,required:p.required!==false})),setup:{leaderID:owner.characterID,systemID:d.systemID,siteSearch:{kind:"COMBAT_ANOMALY",...(o.siteID?{siteID:o.siteID}:{}),maxDifficulty:o.maxDifficulty??1,searchMs:(o.discoveryWaitMinutes??2)*60000,maxSites:o.maxSites??1},parking:{mode:"selected",kind:d.homeKind??"station",destinationID:d.homeStationID,systemID:null}}},gaps};
 }
 if(d.durationMinutes<4) gaps.push("Security requires at least four minutes of hosted runtime.");
 if(m.some(v=>v.role!==undefined&&v.role!=="AUTO")) gaps.push("Selected combat roles are not connected.");
 if(d.preparation) gaps.push("Operation-wide supply preparation is not connected.");
 if(!o || !m.some(v=>v.characterID===o.ownerCharacterID)) gaps.push("Choose the mission owner.");
 if(o && (o.level!==undefined&&o.level!==1&&o.level!==2 || o.levelRule!==undefined&&o.levelRule!=="EXACT"&&o.levelRule!=="UP_TO")) gaps.push("Select Security level 1 or 2 and an exact or up-to rule.");
 if(o && (o.stopRule!==undefined && o.stopRule!=="ONE_MISSION" && o.stopRule!=="COUNT" && o.stopRule!=="TIME" || o.stopRule==="COUNT" && !positive(o.missionCount))) gaps.push("A positive confirmed mission count is required.");
 if(o?.repeat===true) gaps.push("Unbounded mission repeat is not connected.");

 if((o?.resume||o?.resumeFromOperationID)&&m.length>1)gaps.push("Cross-operation fleet continuation is not qualified; use exact same-operation parked-mission continuation.");
 if(d.parking?.mode && !["NEAREST","SELECTED","RETURN_HOME_DOCK"].includes(d.parking.mode)) gaps.push("Parking policy is unsupported.");
 const selected=d.parking?.mode==="SELECTED"||d.parking?.mode==="RETURN_HOME_DOCK";
 if(selected&&!positive(d.homeStationID) || !selected&&d.homeStationID!==null) gaps.push("Select an exact parking destination.");
 if(o && o.agentID!==null && !positive(o.agentID)) gaps.push("Agent identity is invalid.");
 const jumps=o?.maxJumps??null;
 if(jumps!==null&&(!Number.isSafeInteger(jumps)||jumps<0)) gaps.push("Agent search jumps are invalid.");
 if(o?.corporationID!==undefined&&!positive(o.corporationID)) gaps.push("NPC corporation identity is invalid.");
 if(gaps.length || !o || !m[0]) return {candidate:null,gaps};
 const owner=m.find(p=>p.characterID===o.ownerCharacterID);if(!owner)return {candidate:null,gaps:["Choose the mission owner."]};
 const agent=o.agentID ? {agentID:o.agentID} : {agent:{mode:"auto",maxJumps:jumps,corporationID:o.corporationID??null}};
 const agentScope={...(d.systemID?{systemID:d.systemID}:{}),...(o.corporationID?{corporationID:o.corporationID}:{}),...(jumps!==null?{maxJumps:jumps}:{})};
 return {candidate:{runName:m.length===1?"coc-security":"security-fleet-owner",characterID:o.ownerCharacterID,accountName:owner.accountName,...(m.length>1?{members:m.map(p=>({characterID:p.characterID,accountName:p.accountName,required:p.required!==false||p.characterID===o.ownerCharacterID}))}:{}),setup:{...agent,missionCount:o.stopRule==="TIME"?null:o.stopRule==="COUNT"?o.missionCount:1,...(o.rewardPolicy!==undefined?{rewardPolicy:o.rewardPolicy}:{}),...(o.stopRule==="TIME"?{stopAfterMinutes:d.durationMinutes}:{}),...(o.level===2||o.levelRule==="UP_TO"?{level:o.level??1,levelRule:o.levelRule??"EXACT"}:{}),...(Object.keys(agentScope).length?{agentScope}:{}),parking:selected?{mode:"selected",kind:d.homeKind??"station",destinationID:d.homeStationID,systemID:null}:{mode:"nearest"}}},gaps};
}
export function createCombatRoutes(options:{getWorldScope:CombatWorldScope;store?:Store;preparationSnapshot?:(world:string,id:string,run:string,char:number)=>unknown}) {
 let opened=options.store;
 const store=()=>opened??=openCombatStore();
 async function run(req:BackendRequest, fn:(world:string)=>unknown) {
  if(!positive(req.account?.accountID)) return {status:401,body:{ok:false,error:"ACCOUNT_REQUIRED"}};
  let world:string|null; try {world=await options.getWorldScope(req);}catch{return {status:503,body:{ok:false,error:"WORLD_SCOPE_UNAVAILABLE"}};}
  if(!scopeOK(world)) return {status:503,body:{ok:false,error:"WORLD_SCOPE_UNAVAILABLE"}};
  try{return {body:fn(world)};}catch(e){return {status:409,body:{ok:false,error:e instanceof Error?e.message:"COMBAT_OPERATION_UNAVAILABLE"}};}
 }
 function mustRead(world:string,id:string|undefined){if(!id)throw Error("Operation is unavailable.");const d=store().read(world,id);if(!d)throw Error("Operation is unavailable.");return d;}
 function review(world:string,d:CombatDefinition){const result=combatLaunchCandidate(d),latest=store().runs(world,d.operationID!)[0];let candidate=result.candidate;const gaps=[...result.gaps];
  if(latest&&latest.status!=="ENDED"){candidate=null;gaps.push("The previous Start or hosted run still retains custody; reconcile it before starting again.");}
  else if(latest&&unresolvedCombatRuns(store().runs(world,d.operationID!),d.mode).some(r=>r.epoch===latest.epoch)&&!(result.candidate&&["coc-security","security-fleet-owner"].includes((result.candidate as any).runName)&&latest.receipt?.phase==="COMBAT"&&latest.receipt?.identity?.acceptedKey)){candidate=null;gaps.push("The prior Security mission requires exact custody reconciliation.");}
  const sourceID=d.objective?.resumeFromOperationID??d.objective?.resume?.sourceOperationID;if(sourceID&&candidate){const source=store().read(world,sourceID),prior=source?store().runs(world,sourceID)[0]:null,candidateRow=candidate as any,id=prior?.receipt?.identity,key=id?.acceptedKey,completed=prior?.receipt?.completed;
   if(!source||source.mode!=='SECURITY_MISSION'||prior?.status!=='ENDED'||prior.setup?.registry===true||prior.receipt?.phase!=='COMBAT'||typeof prior.bot_id!=='string'||!prior.bot_id||typeof key!=='string'||!key||!Array.isArray(completed)||completed.some((r:any)=>r?.identity?.acceptedKey===key)||prior.character_id!==candidateRow.characterID||prior.owner!==candidateRow.accountName.toLowerCase()||!positive(candidateRow.setup.agentID)||id.agentID!==candidateRow.setup.agentID){candidate=null;gaps.push('The source operation has no exact safely stopped mission for this owner and agent.');}
   else candidate={...candidateRow,setup:{...candidateRow.setup,resumeExpected:{runID:prior.bot_id,acceptedKey:key}}};}
  if(candidate&&(candidate as any).runName==='security-fleet-owner'&&!sourceID&&latest?.status==='ENDED'&&latest.receipt?.phase==='COMBAT'){
   const row=candidate as any,id=latest.receipt.identity;if(latest.owner!==row.accountName.toLowerCase()||latest.character_id!==row.characterID||!positive(id?.agentID)||typeof latest.bot_id!=='string'||latest.revision!==d.revision||!store().members(world,d.operationID!,latest.epoch).every((m:any)=>m.status==='PARKED')){candidate=null;gaps.push('The original fleet/mission owner has no exact parked continuation authority.');}
   else {const {agent,...rest}=row.setup;candidate={...row,setup:{...rest,agentID:id.agentID,resumeExpected:{runID:latest.bot_id,acceptedKey:id.acceptedKey}}};}
  }
  const resumeExpected=(candidate as any)?.setup?.resumeExpected,resume=resumeExpected?{sourceRunID:resumeExpected.runID,identity:{acceptedKey:resumeExpected.acceptedKey}}:candidate&&(candidate as any).runName==='coc-security'&&latest?.status==='ENDED'&&latest.revision===d.revision&&latest.receipt?.phase==='COMBAT'&&typeof latest.bot_id==='string'&&typeof latest.receipt?.identity?.acceptedKey==='string'?{sourceRunID:latest.bot_id,identity:{acceptedKey:latest.receipt.identity.acceptedKey}}:null;
  return {reviewHash:fingerprint(world,d),definition:d,profile:null,canStart:false,staging:null,preparation:{state:"UNVERIFIED",members:d.members.map(m=>({characterID:m.characterID,state:"UNVERIFIED",fittingName:null,reason:"Pilot, ship and hosted control must be inspected in the browser."}))},...(resume?{resume}:{}),blockers:[...gaps,...(candidate?["Hosted-run inspection and per-pilot approval are required."]:[])],launchCandidate:candidate};}
 const routes:Record<string,BackendRoute>={
  "GET /combat-operations":req=>run(req,w=>({ok:true,operations:store().list(w).map(definition=>({definition,run:null,executions:store().runs(w,definition.operationID!).map((x:any)=>({...x,...(x.status==="GROUP_INTENT"||x.setup?.registry===true?{nativeStatus:combatControlSnapshot(definition.operationID!,x.epoch),members:store().members(w,definition.operationID!,x.epoch).map((m:any)=>({...m,preparation:preparationEvidence(options.preparationSnapshot?.(w,definition.operationID!,x.epoch,m.character_id),{world:w,operationID:definition.operationID!,operationRunID:x.epoch,characterID:m.character_id,shipID:m.ship_id,role:"COMBAT"})}))}:{})}))})),hostedRunPolicy:null})),
  "POST /combat-operations":req=>run(req,w=>{const id=(req.body as any)?.operationID;if(typeof id==='string'&&operationHasController(id))throw Error("This operation still has a hosted controller.");return {ok:true,definition:store().save(w,req.account.accountID,req.body)};}),
  "POST /combat-operations/:id/review":req=>run(req,w=>({ok:true,review:review(w,mustRead(w,req.params.id))})),
  "POST /combat-operations/:id/start":req=>run(req,w=>{const d=mustRead(w,req.params.id),body=req.body as any;if(!body||body.confirm!==true||body.reviewHash!==fingerprint(w,d))throw Error("The operation changed; review it again.");const result=review(w,d),candidate=result.launchCandidate as any;if(!candidate||candidate.runName!=="coc-security")throw Error(result.blockers.join(" ")||"Use the fleet launch path.");if(req.account.username.toLowerCase()!==candidate.accountName.toLowerCase())throw Error("The selected pilot account must authorize this launch.");const parking=candidate.setup.parking;
  if(parking.mode==="selected"&&(!positive(body.setup?.parking?.systemID)||body.setup.parking.mode!=="selected"||body.setup.parking.destinationID!==parking.destinationID||body.setup.parking.kind!==parking.kind))throw Error("The selected parking destination was not resolved.");
  const expected={...candidate.setup,parking:parking.mode==="selected"?{...parking,systemID:body.setup.parking.systemID}:parking,operationID:d.operationID,operationRunID:body.operationRunID};if(JSON.stringify(body.setup)!==JSON.stringify(expected))throw Error("Reviewed Security setup changed.");
  const prior=store().runs(w,d.operationID!)[0];if(prior?.status==="ENDED"&&prior.receipt?.phase!=="DONE"){
   const oldSetup={...prior.setup,operationRunID:body.operationRunID};
   if(prior.receipt?.phase!=="COMBAT"||!prior.receipt?.identity?.acceptedKey||prior.owner!==candidate.accountName.toLowerCase()||prior.revision!==d.revision||JSON.stringify(oldSetup)!==JSON.stringify(expected))throw Error("The prior Security mission requires exact custody reconciliation before another Start.");
  }
  store().begin(w,d.operationID!,body.operationRunID,candidate.accountName,candidate.characterID,d.revision!,result.reviewHash,expected);return {ok:true,launchIntent:{reviewHash:result.reviewHash,definitionRevision:d.revision,operationRunID:body.operationRunID,candidate:{...candidate,setup:expected}}};}),
  "POST /combat-operations/:id/group/start":req=>run(req,w=>{const d=mustRead(w,req.params.id),body=req.body as any,result=review(w,d),candidate=result.launchCandidate as any;
   if(!body||body.confirm!==true||body.reviewHash!==fingerprint(w,d)||!candidate||!["security-fleet-owner","anomaly-fleet-member","combat-patrol-member"].includes(candidate.runName))throw Error("Fleet operation changed; review again.");
   if(candidate.runName==="security-fleet-owner"&&req.account.username.toLowerCase()!==candidate.accountName.toLowerCase())throw Error("The mission owner account must authorize the fleet.");
   const actors=body.actors;if(!Array.isArray(actors)||!actors.length||new Set(actors.map((a:any)=>a?.characterID)).size!==actors.length||actors.some((a:any)=>!a||!candidate.members.some((m:any)=>m.characterID===a.characterID&&m.accountName.toLowerCase()===a.accountName?.toLowerCase())||!positive(a.shipID))||candidate.members.some((m:any)=>m.required&&!actors.some((a:any)=>a.characterID===m.characterID))||actors.some((a:any,i:number)=>i>0&&candidate.members.findIndex((m:any)=>m.characterID===actors[i-1].characterID)>=candidate.members.findIndex((m:any)=>m.characterID===a.characterID)))throw Error("The inspected fleet roster changed or a required pilot is missing.");
   const p=candidate.setup.parking;if(p.mode==="selected"&&(!positive(body.setup?.parking?.systemID)||body.setup.parking.destinationID!==p.destinationID||body.setup.parking.kind!==p.kind))throw Error("The selected parking destination was not resolved.");
   if(['combat-patrol-member','anomaly-fleet-member'].includes(candidate.runName)&&(!positive(body.setup?.leaderID)||!actors.some((a:any)=>a.characterID===body.setup.leaderID)))throw Error('The inspected fleet anchor is unavailable.');
   if(candidate.runName==='security-fleet-owner'&&(!positive(body.setup?.anchorID)||!actors.some((a:any)=>a.characterID===body.setup.anchorID)))throw Error('The inspected Security anchor is unavailable.');
   const expected={operationID:d.operationID,operationRunID:body.operationRunID,...(candidate.runName==="security-fleet-owner"?{missionOwnerID:candidate.characterID}:{}),...candidate.setup,...(['combat-patrol-member','anomaly-fleet-member'].includes(candidate.runName)?{leaderID:body.setup.leaderID}:{}),...(candidate.runName==='security-fleet-owner'?{anchorID:body.setup.anchorID}:{}),parking:p.mode==="selected"?{...p,systemID:body.setup.parking.systemID}:p,...(body.setup.fleetMoves!==undefined?{fleetMoves:body.setup.fleetMoves}:{}),members:actors.map((a:any)=>({characterID:a.characterID,shipID:a.shipID,required:candidate.members.find((m:any)=>m.characterID===a.characterID).required})),registry:true};
   if(body.setup.fleetMoves!==undefined&&(!Array.isArray(body.setup.fleetMoves)||body.setup.fleetMoves.some((v:any)=>!v||!positive(v.characterID)||!positive(v.shipID)||!positive(v.fromFleetID)||!actors.some((a:any)=>a.characterID===v.characterID&&a.shipID===v.shipID))||new Set(body.setup.fleetMoves.map((v:any)=>v.characterID)).size!==body.setup.fleetMoves.length))throw Error("Fleet move approval is invalid.");
   if(JSON.stringify(expected)!==JSON.stringify(body.setup))throw Error("The inspected fleet setup changed.");
   const priorRuns=store().runs(w,d.operationID!),unresolved=unresolvedCombatRuns(priorRuns,d.mode),resume=candidate.setup.resumeExpected;
   if(resume){const sourceID=d.objective?.resumeFromOperationID??d.objective?.resume?.sourceOperationID??d.operationID!,source=store().runs(w,sourceID).find((r:any)=>r.bot_id===resume.runID);if(!source||source.status!=='ENDED'||source.receipt?.phase!=='COMBAT'||source.receipt?.identity?.acceptedKey!==resume.acceptedKey||source.character_id!==candidate.characterID||!Array.isArray(source.setup?.members)||source.setup.members.length!==expected.members.length||source.setup.members.some((m:any)=>!expected.members.some((n:any)=>m.characterID===n.characterID&&m.shipID===n.shipID&&(m.required!==false)===(n.required!==false)))||!store().members(w,sourceID,source.epoch).every((m:any)=>m.status==='PARKED')||unresolved.some((r:any)=>r.epoch!==source.epoch||r.operation_id!==source.operation_id))throw Error('Exact original fleet continuation roster or parked native custody differs.');}
   else if(unresolved.length)throw Error("A previous fleet or mission requires custody reconciliation.");
   const controlID=candidate.runName==='security-fleet-owner'?candidate.characterID:body.setup.leaderID,controlActor=actors.find((a:any)=>a.characterID===controlID);if(!controlActor||controlActor.accountName.toLowerCase()!==req.account.username.toLowerCase())throw Error('The selected combat controller account must authorize this exact launch.');store().beginGroup(w,d.operationID!,body.operationRunID,controlActor.accountName,controlID,d.revision!,result.reviewHash,expected,actors);return {ok:true,operationRunID:body.operationRunID};}),
  "POST /combat-operations/:id/group/:epoch/:characterID/dispatch":req=>run(req,w=>{mustRead(w,req.params.id);const id=Number(req.params.characterID),epoch=req.params.epoch;if(!positive(id)||!epoch)throw Error("Fleet member identity is unavailable.");store().dispatchMember(w,req.params.id!,epoch,req.account.username,id);return {ok:true};}),
  "POST /combat-operations/:id/stop":req=>run(req,w=>{const d=mustRead(w,req.params.id),latest=store().runs(w,d.operationID!)[0],body=req.body as any;if(!latest||latest.epoch!==body?.operationRunID||latest.owner!==req.account.username.toLowerCase()||latest.status==='ENDED')throw Error('The exact active combat generation and controlling account are required.');return {ok:true,state:'STOP_REQUESTED',controllers:requestCombatOperationStop(d.operationID!,latest.epoch)};}),
  "POST /combat-operations/:id/delete":req=>run(req,w=>{const d=mustRead(w,req.params.id),body=req.body as any,prior=store().runs(w,d.operationID!);if(operationHasController(d.operationID!))throw Error("This operation still has a hosted controller.");if(unresolvedCombatRuns(prior,d.mode).length)throw Error("An unfinished or unreconciled Security run retains its history.");if(!body||body.revision!==d.revision||!store().remove(w,d.operationID!,body.revision))throw Error("Operation changed; refresh before deleting.");return {ok:true};}),
 };
 return {routes,close:()=>opened?.close()};
}
