import {progressDeadline,routeFlightObservation,travelFacts,transientNativeRead} from '../shared/progressDeadline.ts';
import path from "node:path";
import {createRequire} from "node:module";
import {pluginDataDir} from "../../../web/src/plugin-api/backend.ts";
import {createPilotSession} from "../../../web/src/plugin-api/pilotSession.ts";
import {completionReceipt,createDistributionFence,distributionAcceptedMission} from "./fence.ts";
import {createCivilianDistributionRun,type DistributionHost} from "./backend.ts";
import {decodeDistributionSetup} from "./plan.ts";
import {createNativeCourier} from "./client.ts";
import {parkWithPolicy} from "../shared/parking.ts";
import {captureReward,compareRewards} from "../shared/rewards/index.ts";
import type {DistributionEvidence,DistributionIntent} from "./fence.ts";
import type {DistributionCompletionReceipt} from "./progress.ts";
import {agentMission,missionLabel,type Courier,type JournalRow,type MissionJournal} from "./native.ts";
import {CivilianMissionCompleted,CivilianMissionMismatch} from '../civilian/acceptedMission.ts';
import {civilianProvenance} from '../civilian/recovery.ts';
import {DeclineUnavailable,clearBlockingMission,conflictingMission,existingMissionRefusal,missionRefusalText,referralConflict,referralTargets} from "../civilian/missionConflict.ts";
const require=createRequire(import.meta.url);
const {createDocumentStore}=require("../documentStore.cjs") as {createDocumentStore:(file:string)=>{document(name:string):{read():unknown|null;write(v:unknown):void};close():void}};
let db:ReturnType<typeof createDocumentStore>|null=null,journal:ReturnType<typeof createDistributionFence>|null=null;
function fences(){db??=createDocumentStore(path.join(pluginDataDir(),"distribution.sqlite"));return journal??=createDistributionFence({storage:db.document("distribution-missions")});}
const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function retryableCourierRead(error:unknown){
 const e=error as {name?:string;code?:string;cause?:{code?:string};status?:number;message?:string}|null;
 if(transientNativeRead(error))return true;
 if(e?.status&&e.status>=400&&e.status<500)return false;
 return e?.code==="ECONNRESET"||e?.cause?.code==="ECONNRESET"||e?.name==="TimeoutError"||/timed? ?out/i.test(e?.message??"");
}
const sameCourier=(a:Courier,b:Courier)=>{
 const {missionState:_a,...first}=a,{missionState:_b,...second}=b;return JSON.stringify(first)===JSON.stringify(second);
};
const journalEvidence=(journal:MissionJournal):DistributionEvidence=>
 ({journal,shipID:null,stationID:null,typeID:null,cargoQuantity:null,hangarQuantity:null});
export function createDistributionHost(deps:{attachPilot?:typeof createPilotSession;openFence?:typeof fences;park?:typeof parkWithPolicy;now?:()=>number;timing?:(record:Readonly<Record<string,string|number|null>>)=>void}={}):DistributionHost { return {
 async attach(run,options){
  const setup=decodeDistributionSetup(run.setup);if(!setup)throw new Error("Distribution setup is invalid.");
  const continuation=setup.continuation;
  let active=true,task:Promise<void>|null=null,stopping=false,stopRequested=false,parking=false,inMutation=false,actionSequence=0;
  let completedCount=0,workEnded=false,continuationUnavailable=false;
  let timingPhase="Starting",phaseSince=performance.now(),reads=0,readMs=0;
  const note=(event:string,fields:Record<string,string|number|null>)=>{
   try{
    const record={at:new Date().toISOString(),botID:run.botID,characterID:run.characterID,event,...fields};
    if(deps.timing)deps.timing(record);else console.log("[courier-timing] "+JSON.stringify(record));
   }catch{/* Diagnostic output must never affect the mission. */}
  };
  const observePhase=(phase:string)=>{
   const now=performance.now();
   note("phase",{phase,previous:timingPhase,elapsedMs:Math.round(now-phaseSince),reads,readMs:Math.round(readMs)});
   timingPhase=phase;phaseSince=now;reads=0;readMs=0;
  };
  class GracefulStop extends Error {}
  class AgentFinderUnavailable extends Error {}
  class NoCompletionAction extends Error {}
  const guardHeld=()=>{if(!active||stopping)throw new Error("Distribution run stopped.");};
  const guard=()=>{guardHeld();if(stopRequested&&!parking&&!inMutation)throw new GracefulStop();};
  const guardRead=()=>{if(workEnded)guardHeld();else guard();};
  const read=async<T>(request:()=>Promise<T>):Promise<T>=>{
   for(let attempt=0;;attempt++){
    guardRead();
    try{
     let result:T;const started=performance.now();
     try{result=await request();}finally{reads++;readMs+=performance.now()-started;}
     guardRead();return result;
    }catch(error){
     // Post-action settlement already retries fresh observations inside its own bounded loop.
     if(inMutation||attempt>=2||!retryableCourierRead(error))throw error;
     guardRead();
     await wait(250*(attempt+1));
    }
   }
  };
  // The held run owns this globally unique character; legacy records use account key 1.
  const ledger=(deps.openFence??fences)(),prior=ledger.inspect(1,run.characterID);
  const scope=civilianProvenance(run);
  const resumed=run.resumed&&prior?.runID===run.botID?prior:null;
  const owner={accountID:1,characterID:run.characterID,runID:run.botID,current:()=>active};
  const openMission=()=>{const next=ledger.open(owner);if(scope)next.annotateCivilian(scope);return next;};
  const session=await (deps.attachPilot??createPilotSession)(run);
  const {store,flow}=session,client=createNativeCourier(run,()=>active,read);
  let fence:ReturnType<typeof ledger.open>;
  try {
   if(resumed){
    if(resumed.civilian&&(!scope||resumed.civilian.worldID!==scope.worldID||resumed.civilian.owner!==scope.owner))
     throw Error("The original Distribution world/account could not be verified.");
    fence=ledger.open({...owner,resumed:true});
   }else if(continuation||prior&&!prior.done){
    const response=await run.fetch(new URL("/api/bots",run.baseUrl)),roster=await response.json();
    if(!response.ok||!Array.isArray(roster.bots))throw Error("Current hosted ownership is unavailable.");
    if(roster.bots.some((bot:any)=>bot.characterID===run.characterID&&bot.botID!==run.botID&&!bot.endedAt))
     throw Error("Another active hosted owner is already using this pilot.");
    const journal=await client.journal();
    if(continuation)fence=ledger.continueAccepted({...owner,mission:continuation,evidence:journalEvidence(journal),civilian:scope??undefined});
    else fence=ledger.continueMission({...owner,journal,civilian:scope??undefined});
   }else{
    fence=openMission();
   }
   for(const {receipt,reward} of ledger.completed(1,run.characterID,run.botID)){
    options.restoreCompleted(receipt,reward);
    completedCount++;
    actionSequence=Math.max(actionSequence,receipt.invocationID);
   }
  }catch(error){active=false;flow.setLivePush(false);throw error;}
  const phase=(label:string,why:string)=>{guard();observePhase(label);options.progress(label,why);};
  async function travel(station:number,returning=false){
   guard();let f=await client.flight();if(f.docked&&f.stationID===station)return;
   const travelStarted=performance.now();
   const description=`Flying to station ${station}.`;
   let reportedLocation:number|undefined;
   const reportLocation=()=>{
    const location=f.docked?f.stationID??f.structureID??f.systemID:f.systemID;
    if(reportedLocation===location)return;
    reportedLocation=location;
    options.progress("Traveling",description,{currentLocationID:location??undefined,destinationID:station,returning});
   };
   observePhase("Traveling");reportLocation();
   while(true){
    guard();const began=performance.now(),started=await flow.startRoute(station);guard();
    note("route-started",{destinationID:station,elapsedMs:Math.round(performance.now()-began),started:started.started?1:0});
    if(started.started)break;
    if(!retryableCourierRead(started.cause))throw new Error(started.reason,{cause:started.cause});
    await wait(2000);
    f=await client.flight();
    if(f.docked&&f.stationID===station)return;
   }
   const progressing=progressDeadline(3600000,deps.now??Date.now);
   const routeFlight=routeFlightObservation(session,f.shipID);
   let lastPosition:unknown;
   while(true){
    guard();
    const progress=flow.flying.autopilotProgress();
    const {flight:observed}=routeFlight(progress);
    // The running autopilot already reads flight on this session. Its own
    // pending read can outlive a stale store sample without needing a second read.
    if(progress?.status!=="running"||observed?.docked&&observed.stationID===station){
     const verifying=performance.now();
     f=await client.flight();
     if(f.docked&&f.stationID===station){
      note("route-arrived",{destinationID:station,jumps:progress?.totalJumps??null,
       elapsedMs:Math.round(performance.now()-travelStarted),verificationMs:Math.round(performance.now()-verifying)});
      options.progress("Arrived","Docked at the route destination.",{currentLocationID:station});
      return;
     }
    }else if(observed)f={docked:observed.docked,stationID:observed.stationID,structureID:observed.structureID,shipID:f.shipID,systemID:observed.solarSystemID!};
    if(progress&&["error","paused","aborted"].includes(progress.status))throw new Error(progress.failureReason??"Travel stopped.");
    reportLocation();
    // The native autopilot publishes its own measurements to the held pilot's store.
    const scene=f.docked?null:store.space.get().snapshot;
    if(scene?.inSpace&&scene.stateValid!==false&&scene.solarSystemID===f.systemID&&scene.shipID===f.shipID&&
       scene.ship?.itemID===f.shipID&&scene.ship.geometryAvailable)lastPosition=scene.ship.position;
    if(!progressing(travelFacts({...f,solarSystemID:f.systemID,shipMode:observed?.shipMode,transition:observed?.transition},progress,lastPosition)))throw Error("Travel made no observable native progress; inspect the current route.");
    await wait(2000);
   }
  }
  async function distance(from:number,to:number){
   if(from===to)return 0;flow.requestAutopilotJumps(from,[to]);const key=`${from}:${to}`;
   for(let i=0;i<40;i++){guard();const n=store.names.get().autopilotJumps[key];if(typeof n==="number"&&Number.isSafeInteger(n)&&n>=0)return n;await wait(250);}
   throw new Error("The route distance could not be verified.");
  }
  async function chooseAgent(journal:MissionJournal,excluded:ReadonlyMap<number,string>){
   const a=setup!.agent;
   if(a.mode==="manual"){
    const reason=excluded.get(a.agentID);
    if(reason)throw Error(`The selected agent has no eligible offer. ${reason}`);
    const r=await client.record(a.agentID);
    if(r.stationID!==a.stationID)throw new Error("Selected agent station changed.");
    return r;
   }
   const referrals=await referralTargets(journal,client.agentBriefing);
   let blocked:Awaited<ReturnType<typeof client.record>>|null=null,referralReason:string|undefined;
   for(let level=a.level;level>=(a.levelRule==="max"?1:a.level);level--){
    guard();await flow.findAgents({kind:"courier",level,limit:5000});guard();const result=store.finder.get();
     if(!result.loaded||result.error||result.capped||result.total!==result.agents.length||
        result.agents.some(agent=>agent.solarSystemID!==null)&&result.originSystemID===null)
      throw new AgentFinderUnavailable(result.error??"The agent directory or route distances are incomplete.");
    for(const candidate of result.agents){if(excluded.has(candidate.agentID)||candidate.level!==level||candidate.stationID===null||candidate.jumps===null||candidate.jumps>a.maxJumps||
       (a.corporationID!==null&&candidate.corporationID!==a.corporationID))continue;
     let record;try{record=await client.record(candidate.agentID);}catch(error){
      if((error as {code?:string}).code==="AGENT_NOT_ORDINARY")continue;throw error;}
     if(record.level!==level || record.stationID!==candidate.stationID || record.solarSystemID!==candidate.solarSystemID ||
        (a.corporationID!==null && record.corporationID!==a.corporationID))throw new Error("Agent directory identity changed.");
     const referral=referrals.get(record.agentID);
     if(referral&&!agentMission(journal,record.agentID)){referralReason=referralConflict(referral,record.agentID);continue;}
     const dialogue=await client.dialogue(record.agentID,null);
     if(/standings are not high enough|too low standings/i.test(dialogue.says))continue;
     if(dialogue.actions.some(x=>[1,2,3,5,6,7].includes(x.button)))return record;
     if(existingMissionRefusal(dialogue.says)){blocked??=record;continue;}
     throw new Error(`Agent ${record.agentID}: ${dialogue.says||"access could not be confirmed"}.`);
    }
   }
   if(blocked)return blocked;
   const reason=referralReason??"No eligible Distribution agent was found within the selected limit.";
   const lastExcluded=[...excluded.values()].at(-1);
   throw Error(lastExcluded?`${reason} Last excluded offer: ${lastExcluded}`:reason);
  }
  async function existingAgent(row:JournalRow,systemID:number){
   const a=setup!.agent;
   if(a.mode==="manual"&&row.agentID!==a.agentID)return null;
   const agent=await client.record(row.agentID).catch(error=>{
    if((error as {code?:string}).code!=="AGENT_NOT_ORDINARY")throw error;
    return null;
   });
   if(!agent)return null;
   if(a.mode==="manual"){
    if(agent.stationID!==a.stationID)return null;
   }else{
    if(a.corporationID!==null&&agent.corporationID!==a.corporationID)
     return null;
    if(a.levelRule==="exact"?agent.level!==a.level:agent.level>a.level)
     return null;
    if(row.missionState===1&&await distance(systemID,agent.solarSystemID)>a.maxJumps)
     return null;
   }
   return agent;
  }
  async function courierObjective(row:JournalRow){
   try{
    const objective=await client.briefing(row.agentID);
    if(objective.contentID!==row.missionID||objective.missionState!==row.missionState)
     throw new Error("Objective and journal mission identity differ.");
    return objective;
   }catch(error){throw new Error(`${missionLabel(row)}: ${error instanceof Error?error.message:String(error)} Review its briefing in the agent journal.`);}
  }
  async function settle(typeID?:number,receipt?:DistributionCompletionReceipt){let failure:unknown;
   for(let i=0;i<12;i++){guard();try{
    const proof=typeID===undefined?journalEvidence(await client.journal()):(await client.evidence(typeID)).proof;
    fence.settle({...proof,...(receipt?{completed:receipt}:{})});return;
   }catch(error){failure=error;await wait(500);}}
   throw new Error(`RECOVERY_REQUIRED: Native action has not settled: ${String(failure)}`);
  }
  function requireMissionStartTime(){
   if((deps.now??Date.now)()>=options.deadlineMs-180_000){stopRequested=true;throw new GracefulStop();}
  }
  async function clearMission(row:JournalRow){
   if(row.missionState!==1)throw Error(`${missionLabel(row)} blocks Request. An accepted mission requires manual review.`);
   await clearBlockingMission(row,{session,journal:client.journal,record:client.agentRecord,dialogue:client.dialogue,travel,guard,
    briefing:async id=>{const r=await client.agentBriefing(id);if(r.errors?.briefing)throw Error(r.errors.briefing);return r.briefing;},
    async dispatch(kind,write){
     const before=journalEvidence(await client.journal());
     guard();requireMissionStartTime();inMutation=true;
     try{
      fence.dispatch({kind,agentID:row.agentID,missionKey:row.missionKey},before);
      try{await write();}catch(error){
       if(missionRefusalText(error)||(error as {missionActionRefused?:boolean}).missionActionRefused)
        fence.refuse(journalEvidence(await client.journal()));
       throw error;
      }
      fence.acknowledge();
      await settle();
     }finally{inMutation=false;}
    },
   });
  }
  async function requestWithConflictHandling(agent:Awaited<ReturnType<typeof client.record>>,excluded:ReadonlyMap<number,string>){
   const reason=await press(agent.agentID,"request");
   if(typeof reason!=="string")return;
   const row=conflictingMission(await client.journal(),agent.agentID,reason);
   const exclusion=excluded.get(row.agentID);
   if(exclusion)throw Error(`Agent ${agent.agentID} is blocked by an excluded offer. ${exclusion}`);
   await clearMission(row);
   await travel(agent.stationID);
   const retry=await press(agent.agentID,"request");
   if(typeof retry==="string")throw Error(`Agent ${agent.agentID} still refuses Request: ${retry}`);
  }
  async function press(agentID:number,kind:"request"|"accept"|"complete",missionKey?:string,expected?:Courier,completionStation=expected?.destination){
   if(continuation&&kind!=="complete")throw Error("Continue can only complete its already accepted Delivery mission.");
   guard();if(kind!=="complete")requireMissionStartTime();
   const {proof}=await client.evidence(),selected=agentMission(proof.journal,agentID);
   if(kind==="request"){
    if(selected)throw new Error(`${missionLabel(selected)} appeared before Request. Review the current journal.`);
    const referral=(await referralTargets(proof.journal,client.agentBriefing)).get(agentID);
    if(referral)throw Error(referralConflict(referral,agentID));
   }
   if(kind!=="request"&&(!missionKey||selected?.missionKey!==missionKey||selected.agentID!==agentID||
     selected.missionState!==(kind==="accept"?1:2)))throw new Error("Mission identity changed before agent action.");
   if(kind==="complete"&&proof.stationID!==completionStation)throw new Error("The pilot is no longer at the verified station for this hand-in.");
   const dialogue=await client.dialogue(agentID,null);guard();
   const buttons=kind==="request"?[2]:kind==="accept"?[3]:[6,7];const action=dialogue.actions.find(a=>buttons.includes(a.button));
   if(!action){
    if(kind==="request")return dialogue.says||"no matching native Request action";
    if(continuation&&kind==="complete")throw new NoCompletionAction("The agent does not offer Complete at this station.");
    throw new Error("The agent has no matching fresh action.");
   }
   const sequence=++actionSequence;
   const intent:DistributionIntent=kind==="request"?{kind,agentID}:kind==="accept"?{kind,agentID,missionKey:missionKey!}:
    {kind,agentID,missionKey:missionKey!,runnerID:run.botID,invocationID:sequence,stepPath:"complete",actionID:action.id};
   if(expected){const fresh=await client.briefing(agentID);
    if(!sameCourier(fresh,expected)||fresh.contentID!==selected?.missionID || fresh.missionState!==selected.missionState)
      throw new Error("Mission objective changed before agent action.");}
   const refreshed=(await client.evidence()).proof;
   if(JSON.stringify(agentMission(refreshed.journal,agentID))!==JSON.stringify(selected)||refreshed.shipID!==proof.shipID||refreshed.stationID!==proof.stationID)
    throw new Error("Mission or pilot location changed before agent action.");
   if(kind!=="complete")requireMissionStartTime();
   if(missionKey)fence.bindMission(agentID,missionKey);
   if(kind==="complete")options.bindAccepted(run.botID,agentID,missionKey!);
   guard();inMutation=true;
   try {fence.dispatch(intent,refreshed);guard();
   let result;
   try{result=await client.dialogue(agentID,action.id);}catch(error){
    const refusal=kind==="request"?missionRefusalText(error):null;
    if(refusal){fence.refuse((await client.evidence()).proof);return refusal;}
    if(continuation&&intent.kind==="complete"){
     const journal=await client.journal().catch(()=>null);
     if(journal?.completed?.some(row=>row.agentID===agentID&&row.missionKey===missionKey))
      return fence.reconcile(journalEvidence(journal),continuation);
    }
    throw error;
   }
   guard();
   if(kind==="request"&&existingMissionRefusal(result.says)){
    fence.refuse((await client.evidence()).proof);
    return result.says;
   }
   if(intent.kind==="complete"){
    if(result.completed!==true)throw new Error("RECOVERY_REQUIRED: Native Complete was not positively confirmed.");
    const receipt=completionReceipt(intent);
    fence.acknowledge();await settle(undefined,receipt);return receipt;
   }
   fence.acknowledge();await settle();
   } finally {inMutation=false;}
  }
  async function move(agentID:number,missionKey:string,objective:Courier,fresh:Courier,
   {proof,cargo,hangar}:Awaited<ReturnType<typeof client.evidence>>,kind:"load"|"unload",quantity=objective.quantity){
   const typeID=objective.typeID;
   const source=kind==="load"?hangar:cargo;
   const item=source?.find(r=>r.typeID===typeID&&r.quantity>=quantity);if(!item)throw new Error("Exact mission cargo stack is unavailable.");
   const activeRow=agentMission(proof.journal,agentID);
   if(!sameCourier(fresh,objective)||fresh.missionState!==2||activeRow?.missionKey!==missionKey||fresh.contentID!==activeRow.missionID||
      proof.stationID!==(kind==="load"?objective.pickup:objective.destination)||
      (continuation
       ? proof.cargoQuantity===null||proof.hangarQuantity===null||(kind==="load"
        ? proof.cargoQuantity+quantity>objective.quantity
        : proof.cargoQuantity<quantity||proof.cargoQuantity+proof.hangarQuantity!==objective.quantity)
       : kind==="load"?proof.cargoQuantity!==0:proof.hangarQuantity!==0||proof.cargoQuantity!==quantity))
    throw new Error("Mission objective or destination changed before transfer.");
   fence.bindMission(agentID,missionKey);
   const intent:DistributionIntent={kind,agentID,missionKey,shipID:proof.shipID!,stationID:proof.stationID!,typeID,itemID:item.itemID,itemQuantity:item.quantity,
     quantity,cargoBefore:proof.cargoQuantity!,hangarBefore:proof.hangarQuantity!};
   guard();inMutation=true;
   try {fence.dispatch(intent,{...proof,sourceItem:item});guard();
   try{
    await client.transfer(item.itemID,kind==="load"?"hangar":"cargo",kind==="load"?"cargo":"hangar",quantity);
    guard();fence.acknowledge();await settle(typeID);
   }catch(error){
    if(!continuation)throw error;
    const observed=await client.evidence(typeID).catch(()=>null);
    if(!observed)throw error;
    fence.reconcile(observed.proof,continuation);
   }
   } finally {inMutation=false;}
  }
  async function continueCargo(agentID:number,missionKey:string,objective:Courier){
   const readCargo=async()=>{
    const evidence=await client.evidence(objective.typeID);
    const {cargoQuantity,hangarQuantity}=evidence.proof;
    if(cargoQuantity===null||hangarQuantity===null)throw Error("Delivery cargo or station inventory is unavailable.");
    return {...evidence,cargoQuantity,hangarQuantity};
   };
   await travel(objective.destination);
   let evidence=await readCargo();
   const delivered=evidence.hangarQuantity;
   if(delivered+evidence.cargoQuantity>objective.quantity)
    throw Error("Delivery cargo is ambiguous: ship and destination inventory exceed the mission quantity.");
   let missing=objective.quantity-delivered-evidence.cargoQuantity;
   if(missing>0){
    if(objective.pickup===objective.destination||fence.read().unloaded)
     throw Error(`Delivery cargo is missing. ${missing} units are unaccounted for after checking the ship and destination.`);
    await travel(objective.pickup);
    const aboard=evidence.cargoQuantity;
    evidence=await readCargo();
    if(evidence.cargoQuantity!==aboard||evidence.hangarQuantity<missing)
     throw Error(`Delivery cargo is missing or changed at pickup. ${missing} more units are required.`);
    phase("Loading","Collecting only the outstanding cargo for the accepted mission.");
    while(missing>0){
     const stack=evidence.hangar?.find(row=>row.typeID===objective.typeID);
     if(!stack)throw Error("The remaining mission cargo is missing at the pickup station.");
     const quantity=Math.min(stack.quantity,missing);
     await move(agentID,missionKey,objective,await client.briefing(agentID),evidence,"load",quantity);
     missing-=quantity;
     if(missing>0)evidence=await readCargo();
    }
    await travel(objective.destination);
    evidence=await readCargo();
   }
   if(evidence.hangarQuantity+evidence.cargoQuantity!==objective.quantity)
    throw Error("Delivery cargo does not match the accepted mission at the destination.");
   while(evidence.cargoQuantity>0){
    const stack=evidence.cargo?.find(row=>row.typeID===objective.typeID);
    if(!stack)throw Error("The remaining mission cargo is missing from the ship hold.");
    phase("Delivering","Unloading the remaining cargo for the accepted mission.");
    await move(agentID,missionKey,objective,await client.briefing(agentID),evidence,"unload",stack.quantity);
    evidence=await readCargo();
   }
   if(evidence.hangarQuantity!==objective.quantity)throw Error("The exact Delivery quantity is not present at the destination.");
  }
  async function oneMission(excluded:Map<number,string>,declined:Set<number>){
   const began=performance.now();observePhase("Observing mission");
   const flight=await client.flight(),journal=await client.journal(),boundMission=fence.read().mission;guard();
   options.progress("Checking mission","Reading the current agent journal.",{
    currentLocationID:(flight.docked?flight.stationID??flight.structureID??flight.systemID:flight.systemID)??undefined,
   });
   let initial:JournalRow|null=null,agent:Awaited<ReturnType<typeof client.record>>|null=null;
   if(boundMission){
    const row=agentMission(journal,boundMission.agentID);
    if(!row||row.missionKey!==boundMission.missionKey){
     if(continuation)throw new CivilianMissionMismatch("The selected Delivery mission is no longer accepted.");
     throw Error("The retained courier mission does not match this run's agent selection.");
    }
    agent=continuation?await client.record(row.agentID):await existingAgent(row,flight.systemID);
    if(!agent)throw Error("The retained courier mission does not match this run's agent selection.");
    initial=row;
   }else for(const row of [...journal.active,...journal.offered]){
    if(row.missionState===1&&excluded.has(row.agentID))continue;
    const candidate=await existingAgent(row,flight.systemID);
    if(candidate){initial=agentMission(journal,row.agentID);agent=candidate;break;}
   }
   if(continuation&&(!boundMission||initial?.missionState!==2||initial.missionID!==continuation.missionID||initial.missionKey!==continuation.key))
    throw new CivilianMissionMismatch("The selected Delivery mission is no longer accepted. Continue cannot request a replacement.");
   if(initial?.missionState!==2)requireMissionStartTime();
   const selection=setup!.agent;
   if(!boundMission&&initial?.missionState!==2&&selection.mode==="auto"&&selection.corporationID!==null){
    for(const offer of journal.offered){
     if(offer.important!==false||offer.agentID===initial?.agentID)continue;
     const issuer=await client.agentRecord(offer.agentID);
     if(issuer?.agentID===offer.agentID&&issuer.agentTypeID===2&&Number.isSafeInteger(issuer.corporationID)&&issuer.corporationID!==selection.corporationID)
      await clearMission(offer);
    }
   }
   if(!agent)phase("Finding an agent","Searching for an eligible mission agent.");
   agent??=await chooseAgent(journal,excluded);guard();
   // Read an inherited offer's briefing before moving; a non-courier offer needs review at its current location.
   const original=initial?await courierObjective(initial):null;guard();
   options.missionObserved?.(agent.agentID,initial?.missionID??null,initial?.missionName,original?.destination);
   if(!initial||initial.missionState===1)await travel(agent.stationID);
   if(!initial){phase("Requesting","Requesting one mission.");await requestWithConflictHandling(agent,excluded);}
   let row=agentMission(await client.journal(),agent.agentID);
   if(!row||row.agentID!==agent.agentID||initial&&(row.missionKey!==initial.missionKey||row.missionState!==initial.missionState))
    throw new Error("The existing agent mission changed before any action. Review the current journal.");
   let missionKey=row.missionKey,objective=original??await courierObjective(row);
   options.missionObserved?.(agent.agentID,objective.contentID,row.missionName,objective.destination);
   if(row.missionState===1){
    const {proof,hold,flight}=await client.evidence(objective.typeID,{includeCapacity:true});if(!hold||objective.volume>hold.capacity-hold.used||proof.cargoQuantity!==0)
     throw new Error("Mission cargo does not fit or existing cargo needs review.");
    const jumps=await distance(flight.systemID,objective.destinationSystem);
    if(jumps>setup!.maxJumps){
     const reason=`${missionLabel(row)} needs ${jumps} jumps (limit ${setup!.maxJumps}).`;
     let leaveReason="The replacement offer also exceeds the limit.";
     if(!declined.has(row.agentID)){
      try{
       await clearMission(row);
       declined.add(row.agentID);
       phase("Finding an agent",`${reason} Offer declined. Searching for another mission.`);
       return false;
      }catch(error){
       if(!(error instanceof DeclineUnavailable))throw error;
       leaveReason=error.message;
      }
     }
     fence.leaveOffered(row.agentID,missionKey,journalEvidence(await client.journal()));
     const excludedReason=`${reason} Offer left for review. ${leaveReason}`;
     excluded.set(row.agentID,excludedReason);
     phase("Finding an agent",excludedReason);
     return false;
    }
    phase("Accepting","Accepting the checked courier offer.");await press(agent.agentID,"accept",missionKey,objective);
   }
   row=agentMission(await client.journal(),agent.agentID);const bound=fence.read().mission;
   if(!row||row.missionState!==2||row.agentID!==agent.agentID||(bound?bound.missionKey:missionKey)!==row.missionKey)throw new Error("Accepted mission changed. Review the current journal.");
   missionKey=row.missionKey;
   const accepted=await courierObjective(row);if(!sameCourier(accepted,objective))throw new Error("Courier objective changed after acceptance.");objective=accepted;
   fence.bindMission(agent.agentID,missionKey,true);
   if(continuation)await continueCargo(agent.agentID,missionKey,objective);
   else {
   const unloaded=fence.read().unloaded;
   if(!unloaded){
    const currentFlight=await client.flight();
    const atDestination=currentFlight.docked&&currentFlight.stationID===objective.destination;
    const destinationProof=atDestination?(await client.evidence(objective.typeID)).proof:null;
    const currentCargo=destinationProof?.cargoQuantity??await client.shipCargoQuantity(currentFlight,objective.typeID);
    const delivered=atDestination&&objective.pickup!==objective.destination&&destinationProof?.hangarQuantity===objective.quantity;
    if(currentCargo===0&&!delivered){
     if(atDestination&&objective.pickup!==objective.destination&&destinationProof?.hangarQuantity)
      throw Error(`${missionLabel(row)}: matching cargo is in the destination hangar, but its quantity differs from the mission.`);
     await travel(objective.pickup);
     const fresh=await client.briefing(agent.agentID),evidence=await client.evidence(objective.typeID),{proof}=evidence;
     if(proof.cargoQuantity===0&&proof.hangarQuantity!==null&&proof.hangarQuantity>=objective.quantity){
      phase("Loading","Loading the verified mission cargo.");await move(agent.agentID,missionKey,objective,fresh,evidence,"load");
     }else if(proof.cargoQuantity!==0&&proof.cargoQuantity!==objective.quantity)throw new Error(`${missionLabel(row)}: existing mission cargo quantity is ambiguous. Check the ship hold.`);
    }else if(currentCargo!==0&&currentCargo!==objective.quantity)throw new Error(`${missionLabel(row)}: existing mission cargo quantity is ambiguous. Check the ship hold.`);
   }
   await travel(objective.destination);
   const fresh=await client.briefing(agent.agentID),evidence=await client.evidence(objective.typeID),{proof}=evidence;
   if(unloaded){
    if(unloaded.shipID!==proof.shipID||unloaded.stationID!==proof.stationID||unloaded.typeID!==objective.typeID||
      unloaded.quantity!==objective.quantity||proof.hangarQuantity!==unloaded.hangarBefore+unloaded.quantity||
      proof.cargoQuantity!==unloaded.cargoBefore-unloaded.quantity)
     throw new Error(`${missionLabel(row)}: the recorded delivery no longer matches native inventory. Review the destination hangar before completing.`);
   }else if(objective.pickup===objective.destination||proof.cargoQuantity!==0||proof.hangarQuantity!==objective.quantity){
    if(proof.hangarQuantity!==0||proof.cargoQuantity!==objective.quantity)
     throw new Error(`${missionLabel(row)}: destination or mission cargo is ambiguous before delivery. Review the ship hold and destination hangar.`);
    phase("Delivering","Transferring the verified mission cargo.");await move(agent.agentID,missionKey,objective,fresh,evidence,"unload");
   }
   if(!sameCourier(fresh,objective)||fresh.missionState!==2)throw new Error("Mission objective changed before completion.");
   }
   const rewardBefore=await captureReward(run,run.characterID,agent.agentID,agent.corporationID??null);guard();
   phase("Completing","Requesting native completion once.");
   let receipt;
   try{receipt=await press(agent.agentID,"complete",missionKey,objective);}
   catch(error){
    if(!continuation||!(error instanceof NoCompletionAction)||agent.stationID===objective.destination)throw error;
    await travel(agent.stationID,true);
    receipt=await press(agent.agentID,"complete",missionKey,objective,agent.stationID);
   }
   if(!receipt||typeof receipt==="string")throw new Error("Completion receipt is unavailable.");
   const rewardAfter=await captureReward(run,run.characterID,agent.agentID,agent.corporationID??null);
   const reward=compareRewards(rewardBefore,rewardAfter,missionKey);
   ledger.recordReward({accountID:1,characterID:run.characterID,runID:run.botID,current:()=>active,receipt,reward});
   completedCount++;options.confirmed(receipt,reward);
   note("mission-confirmed",{completedCount,elapsedMs:Math.round(performance.now()-began)});
   return true;
  }
  async function reconcileResumedMission(){
   const row=continuation?ledger.inspect(1,run.characterID):resumed;
   if(!row||row.done||(!row.mission&&!row.pending))return;
   const intent=row.pending?.intent,journal=await client.journal();
   if(continuation&&agentMission(journal,continuation.agentID)?.missionKey===continuation.key&&(intent?.kind==="load"||intent?.kind==="unload"))
    await travel(intent.stationID);
   const proof=(intent?.kind==="load"||intent?.kind==="unload")&&agentMission(journal,intent.agentID)?.missionKey===intent.missionKey?
    (await client.evidence(intent.typeID,{source:intent.kind==="load"?"hangar":"cargo",itemID:intent.itemID})).proof:journalEvidence(journal);
   const receipt=fence.reconcile(proof,continuation);
   if(receipt){
    actionSequence=Math.max(actionSequence,receipt.invocationID);
    options.bindAccepted(run.botID,receipt.agentID,receipt.missionKey);
    completedCount++;
    options.confirmed(receipt,null,"Mission left the journal after Complete was sent.");
   }
  }
  async function work(){
   await reconcileResumedMission();
   // Bound one search to one free decline per agent. Reset only after an actual hand-in.
   const excluded=new Map<number,string>(),declined=new Set<number>();
   while(continuation?completedCount===0:setup!.durationMinutes!==undefined || completedCount<setup!.missionCount){
    guard();
    if(ledger.inspect(1,run.characterID)?.done){
     if(continuation)break;
     fence=openMission();
    }
    try{
     if(await oneMission(excluded,declined)){
      excluded.clear();
      declined.clear();
     }
    }catch(error){
     if(!(error instanceof AgentFinderUnavailable))throw error;
     phase("Finding an agent",error.message);
     await wait(2000);
    }
   }
   await parkAfterStop(`Finished ${completedCount} Distribution mission(s).`);
  }
  async function parkAfterStop(reason?:unknown){
   if(parking || stopping)return;
   parking=true;
   try {flow.abortRoute();
     const target=await (deps.park??parkWithPolicy)(run,session,(phase,why)=>options.progress(phase,why),()=>{
       if(!active||stopping)throw new Error("Distribution custody retired during parking.");
     },setup!.parking??{mode:"nearest"});
     const parked=await client.flight();
     if(!parked.docked || parked.systemID!==target.systemID ||
        (target.kind==="station"?parked.stationID:parked.structureID)!==target.destinationID)
       throw new Error("Exact parking destination could not be verified.");
     const row=ledger.inspect(1,run.characterID);
     if(!row||row.runID!==run.botID)throw new Error("Distribution parking custody is unknown.");
     const pending=row.pending;
     if(pending){parking=false;options.stopped(continuation&&reason instanceof Error&&!(reason instanceof GracefulStop)
      ?reason.message:"Docked, but the last mission action is unresolved. Reconcile it before releasing custody.");return;}
     const failed=reason instanceof Error&&!(reason instanceof GracefulStop);
     options.parked(failed?reason.message:typeof reason==="string"?reason:"Stopped after docking at a verified station.",
      {destinationID:target.destinationID,systemID:target.systemID,kind:target.kind},failed);
   }catch(reason){parking=false;options.stopped(`Parking did not finish: ${String(reason)}`);}
  }
  const custody=()=>{const row=ledger.inspect(1,run.characterID);if(!row||row.runID!==run.botID)throw Error('The original Distribution journal owner changed.');return {pending:row.pending?.intent.kind??null,missionSettled:row.done&&row.pending===null,missionKey:row.mission?.missionKey??null,acceptedMission:continuationUnavailable?null:distributionAcceptedMission(row),continuationUnavailable};};
  return {custody,async inspectRecovery(){
   if(!active||stopping||!workEnded)throw Error('The original Distribution executor must finish its current work before read-only reconciliation.');
   const row=ledger.inspect(1,run.characterID);if(!row||row.runID!==run.botID)throw Error('The exact Distribution owner journal is unavailable.');
   const intent=row.pending?.intent,{proof}=await client.evidence(intent&&(intent.kind==='load'||intent.kind==='unload')?intent.typeID:undefined);
   let reconciled=false;if(row.pending?.acknowledged){fence.settle(proof);reconciled=true;}
   const after=custody(),f=await client.flight(),qualified=f.docked&&(setup!.parking?.mode!=='selected'||f.systemID===setup!.parking.systemID&&(setup!.parking.kind==='station'?f.stationID:f.structureID)===setup!.parking.destinationID);
   return {nativeReconciled:reconciled,...after,parking:qualified?{state:'DOCKED',destinationID:(f.stationID??f.structureID)!,systemID:f.systemID,kind:f.stationID?'station':'structure'}:null,journalStatus:proof.journal.active.length+proof.journal.offered.length?'NONEMPTY':'EMPTY',activeMissions:proof.journal.active.length,offeredMissions:proof.journal.offered.length,reason:after.pending?'The dispatched '+after.pending+' remains unknown; no replay.':after.missionSettled?'Original journal settlement is verified.':'Native mission/cargo remains unfinished; docking does not complete it.'};
  },async start(){task=work().catch(async error=>{
   if(stopping)return;
   if(error instanceof CivilianMissionCompleted||error instanceof CivilianMissionMismatch)continuationUnavailable=true;
   if(error instanceof GracefulStop || stopRequested){await parkAfterStop(error);return;}
   if(continuation){await parkAfterStop(error);return;}
   options.stopped(error instanceof Error?error.message:String(error));
  }).finally(()=>{workEnded=true;});},async requestStop(){stopRequested=true;await task;await parkAfterStop();},async stop(){
   if(stopping){await task;return;}stopping=true;flow.abortRoute();await task;
   try{fence.abandonUntouched();}catch{/* Preserve every dispatched action. */}active=false;flow.setLivePush(false);
  }};
 }
};}
export const distributionHost=createDistributionHost();
export const civilianDistributionRun=createCivilianDistributionRun(distributionHost);
