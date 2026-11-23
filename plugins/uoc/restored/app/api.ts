// WC74 frontend request contracts, adapted to public WC APIs and UOC plugin routes.
import {checkPluginRun,createPluginRunGrant,startPluginRun,listServerBots as nativeBots,stopServerBot as nativeStop,type ServerBot as NativeBot,type JsonValue} from '../../../../web/src/plugin-api/index.ts';
import {civilianLocations,civilianReadout,earlierCivilianSnapshot} from './civilianReadout.ts';
import {readAcceptedMission} from '../../civilian/acceptedMission.ts';
import {authenticatedJson,cockpitSession,farmerAccounts,savedWorkspacePilots,workspaceAccounts,readAsFarmerAccount,ownerOptions,runHosted,accountUnauthorized,type ApiOptions} from './context.ts';
import type {FoundAgent,FindAgentsResult,MapLocation,FindMapLocationsResult,ResolvedDestination,VerifiedOperationPilot,MiningOperationDefinition,MiningOperationsPayload,OperationRoutineSummary,MiningResourceChoice,PveDedChoice} from './apiTypes.ts';
export type * from './apiTypes.ts';
export type {ApiOptions,JsonValue};
export {loadMiningOperations,saveMiningOperation,deleteMiningOperation,getMiningOperationLaunchPlan} from '../adapters/mining.ts';
export {loginFactoryAccount,loadTrainingCharacters,readTrainingWorld,loadTrainingSettingsContext,trainingOnboarding,verifyTrainingMembership,loadTrainingEnrollment,loadMinerTraining,reviewSkillAcquisition,acquireFactorySkills,applyTrainingQueue} from '../adapters/training.ts';
export type {TrainingEnrollment} from '../adapters/training.ts';
const plugin='/api/plugins/uoc',agentCache=new Map<number,FoundAgent>();
const fail=(message:string):never=>{throw Error(message);};
export function openRegisteredFarmerAccount(name:string){
 return readAsFarmerAccount(name,async options=>{
  const r=await authenticatedJson('/api/plugins/uoc/center/account',options);
  const account=r.account?.username,accountID=r.account?.accountID,worldID=r.worldID;
  if(typeof account!=='string'||account.toLowerCase()!==name.trim().toLowerCase()||
     !Number.isSafeInteger(accountID)||accountID<=0||typeof worldID!=='string'||!worldID||!options.token)
   throw Error('WC could not verify this account.');
  return {account,accountID,worldID,options:{...options,token:options.token}};
 });
}
export async function openDefaultFarmerAccount(preferred?:string|null){
 const names=workspaceAccounts();
 const preferredAccount=names.find(name=>name.toLowerCase()===preferred?.trim().toLowerCase());
 const ordered=[...new Set([...(preferredAccount?[preferredAccount]:[]),...farmerAccounts(),...names])];
 for (const name of ordered) {
  try { return await openRegisteredFarmerAccount(name); }
  catch (error) { if (!accountUnauthorized(error)) throw error; }
 }
 return null;
}
async function readOperationPilots(accountName:string,options:ApiOptions):Promise<VerifiedOperationPilot[]>{
 const roster=await authenticatedJson('/api/pilot-training/characters',options);
 if(roster.account?.toLowerCase()!==accountName.trim().toLowerCase()||!Array.isArray(roster.characters))throw Error('The selected account roster is unverified.');
 const active=(await nativeBots(options)).filter(row=>!row.endedAt);
 return Promise.all(roster.characters.map(async(p:any)=>{
  if(!Number.isSafeInteger(p.characterID)||typeof p.name!=='string')throw Error('Pilot roster is malformed.');
  const row:VerifiedOperationPilot={accountName:roster.account,characterID:p.characterID,characterName:p.name,corporationID:p.corporationID??null,corporationName:p.corporationName??null,shipName:p.shipName??p.shipTypeName??null,availability:'UNKNOWN',reason:'Native pilot control is not yet observed.'};
  try{
   const {ownership}=await authenticatedJson(`/api/pilot-training/ownership?characterID=${p.characterID}`,options);
   if(ownership?.characterID!==p.characterID)throw Error('Pilot identity changed.');
   const held=active.find((b)=>b.characterID===p.characterID),other=active.find((b)=>b.characterID!==p.characterID);
   let availability:VerifiedOperationPilot['availability']='UNKNOWN',reason='Native pilot control is unknown.';
   if(held||ownership.owner==='BOT'){availability='HOSTED';reason=held?.phase??'An existing hosted operation controls this pilot.';}
   else if(other){availability='ACCOUNT_BUSY';reason='Another pilot on this account has a hosted operation.';}
   else if(ownership.online===false&&ownership.owner==='OFF'){availability='AVAILABLE';reason='Verified on the current EveJS server.';}
   else if(ownership.online===true){
    const local=cockpitSession(p.characterID)?.store.get().session.username?.toLowerCase()===roster.account.toLowerCase();
    availability=local?'WC_SESSION':'IN_GAME';reason=local?'Open in this WC workspace.':'This pilot is already online.';
   }
   return {...row,availability,reason};
  }catch(e){return {...row,reason:e instanceof Error?e.message:String(e)};}
 }));
}
export function listVerifiedOperationPilots(accountName:string,options:ApiOptions={}):Promise<VerifiedOperationPilot[]>{
 return options.token?readOperationPilots(accountName,options):readAsFarmerAccount(accountName,access=>readOperationPilots(accountName,access));
}
/** Render saved characters without acquiring each account. A selected pilot is read from WC before use. */
export async function listWorkspaceOperationPilots() {
 const accounts=farmerAccounts();
 const results=await Promise.allSettled(accounts.map(account=>listVerifiedOperationPilots(account)));
 const pilots:VerifiedOperationPilot[]=[];
 const errors:string[]=[];
 const verifiedAccounts=new Set<string>();
 for (const [i,result] of results.entries()) {
  if (result.status==="fulfilled") {
   verifiedAccounts.add(accounts[i]!.toLowerCase());
   pilots.push(...result.value);
  } else errors.push(`${accounts[i]}: ${result.reason instanceof Error?result.reason.message:String(result.reason)}`);
 }
 const verifiedIDs=new Set(pilots.map(pilot=>pilot.characterID));
 for(const pilot of savedWorkspacePilots()){
  if(verifiedAccounts.has(pilot.accountName.toLowerCase())||verifiedIDs.has(pilot.characterID))continue;
  pilots.push({accountName:pilot.accountName,characterID:pilot.characterID,characterName:pilot.characterName,
   shipName:pilot.shipName,corporationName:null,availability:"UNCHECKED",reason:"Verify this pilot when selected."});
 }
 return {pilots,errors};
}
export async function findAgents(filters:{kind?:string;level?:number|null;systemID?:number|null;corporationID?:number|null;limit?:number}={},options:ApiOptions={}):Promise<FindAgentsResult>{const query=new URLSearchParams(Object.entries(filters).filter(([,v])=>v!=null).map(([k,v])=>[k,String(v)]));const r=await authenticatedJson(`/api/agents/find?${query}`,options);if(!Array.isArray(r.agents))throw Error('Agent directory is unreadable.');const missing=[...new Set<number>(r.agents.filter((a:any)=>a.corporationID&&!a.corporationName).map((a:any)=>a.corporationID))];const names:Record<string,string>={};for(let i=0;i<missing.length;i+=100){const x=await authenticatedJson('/api/names',options,{items:missing.slice(i,i+100).map(id=>({kind:'owner',id}))});Object.assign(names,x.names??{});}const agents=r.agents.map((a:FoundAgent)=>({...a,corporationName:a.corporationName??names[`owner:${a.corporationID}`]??null}));for(const a of agents)agentCache.set(a.agentID,a);return {...r,agents};}
export async function findMapLocations(q:string,kind:'system'|'station'|null=null,options:ApiOptions={}):Promise<FindMapLocationsResult>{const r=await authenticatedJson(`/api/map/find?${new URLSearchParams({q,...(kind?{kind}:{})})}`,options);if(!Array.isArray(r.matches))throw Error('Map search is unreadable.');return r;}
export async function resolveDestination(id:number,options:ApiOptions={}):Promise<ResolvedDestination>{return {...await authenticatedJson(`/api/map/resolve/${id}`,options),id};}
export async function findAccessibleStructures(q:string,options:ApiOptions={},characterID?:number,accountName?:string,_scope?:string):Promise<readonly MapLocation[]>{const actual=accountName?await ownerOptions(accountName):options;const r=await authenticatedJson(`/api/dockable-structures/find?${new URLSearchParams({q,...(characterID?{characterID:String(characterID)}:{})})}`,actual);if(!Array.isArray(r.matches))throw Error('Authorized Upwell search is unreadable.');return r.matches;}
export async function resolveAccessibleStructure(id:number,options:ApiOptions={},characterID?:number,accountName?:string):Promise<import('../mining/contracts.ts').DockableLocation>{const r=await authenticatedJson(`/api/dockable-structures/${id}${characterID?`?characterID=${characterID}`:''}`,accountName?await ownerOptions(accountName):options);if(r.location?.kind!=='structure'||r.location.id!==id)throw Error('Structure docking access is unverified.');return r.location;}
export async function listDockableAccessPilots(options:ApiOptions={}):Promise<readonly {characterID:number;characterName:string}[]>{const r=await authenticatedJson('/api/dockable-structures/pilots',options);if(!Array.isArray(r.pilots))throw Error('Docking access pilots are unreadable.');return r.pilots;}
export async function listMiningResources(options:ApiOptions={}):Promise<readonly MiningResourceChoice[]>{const r=await authenticatedJson('/api/mining-operations/resources',options);if(!Array.isArray(r.resources))throw Error('Mining resource catalogue is unreadable.');return r.resources;}
export async function getMiningPreparationOptions(account:string,characterID:number,provider:number|null=null,_options:ApiOptions={}):Promise<import('../mining/miningPreparation.ts').MiningPreparationOptions>{
 const options=await ownerOptions(account),providerID=provider??characterID,query=new URLSearchParams({characterID:String(characterID),providerCharacterID:String(providerID),fittingID:'0',sourceKind:'hangar',division:'1'});
 const r=await authenticatedJson('/api/ship-provisioning/review?'+query,options);
 if(r.pilot?.characterID!==characterID||r.definitions?.providerCharacterID!==providerID||r.definitions.status!=='READY'||!Array.isArray(r.definitions.contracts))throw Error('The selected pilot or corporate fitting provider is unavailable.');
 return {pilot:r.pilot,definitions:r.definitions,candidateSource:r.candidateSource};
}
export async function listOperationRoutines(classes:readonly string[],unloadPolicy:unknown,options:ApiOptions={}):Promise<OperationRoutineSummary[]>{
 const r=await authenticatedJson('/api/mining-operations/routines?'+new URLSearchParams({classes:classes.join(','),unloadPolicy:String(unloadPolicy)}),options);if(!Array.isArray(r.routines))throw Error('The saved Bot Builder routine directory is unreadable.');return r.routines;
}
export async function startMiningOperation(_id:string,_grants:unknown,_hash?:string|null,_options:ApiOptions={}):Promise<MiningOperationsPayload>{return fail('The restored MCC launch needs native member inspection and grant binding; no fleet was started.');}
export async function stopMiningOperation(_id:string,_options:ApiOptions={}):Promise<MiningOperationsPayload>{return fail('This saved operation has no verified current hosted-run binding; no unrelated pilot was stopped.');}
export async function relocateMiningOperation(id:string,runtime:any,options:ApiOptions={}):Promise<MiningOperationsPayload>{
 if(!runtime?.operationRunID||!runtime.currentTarget?.targetKey)throw Error('The current operation target is unavailable.');
 const before=await authenticatedJson(plugin+'/mining-operations/'+encodeURIComponent(id)+'/launch',options),receipt=before.receipt;if(receipt?.operationRunID!==runtime.operationRunID)throw Error('The current fleet launch generation changed.');
 const latest=await authenticatedJson(plugin+'/mining-operations',options),row=latest.operations?.find((r:any)=>r.definition.operationID===id),claim=row?.runtime?.currentTarget;
 if(row?.runtime.operationRunID!==runtime.operationRunID||claim?.targetKey!==runtime.currentTarget.targetKey)throw Error('The current mining target changed. Refresh before relocating.');
 await authenticatedJson(plugin+'/mining-operations/'+encodeURIComponent(id)+'/relocate',options,{operationRunID:runtime.operationRunID,claimKey:claim.targetKey,claimGeneration:claim.claimGeneration});
 return (await import('../adapters/mining.ts')).loadMiningOperations(options);
}
export async function extendMiningOperation(_id:string,_minutes:number,_options:ApiOptions={}):Promise<{payload:MiningOperationsPayload;extension:{ok:boolean;message?:string}}>{return fail('The current WC host explicitly does not support extending an existing hosted credential. The original expiry remains in force.');}
export async function readPveOptions(_options:ApiOptions={}):Promise<PveDedChoice[]>{return fail('DED operations remain disabled by operator decision.');}
export async function readCivilianParking(_account:string,_cid:number,destination:MapLocation,_options:ApiOptions={}):Promise<import('../nav/civilianParking.ts').CivilianParkingPolicy>{if((destination.kind!=='station'&&destination.kind!=='structure')||!Number.isSafeInteger(destination.solarSystemID)||!destination.solarSystemID)throw Error('Choose a verified docking destination.');return {mode:'SELECTED',destination:{...destination,kind:destination.kind,solarSystemID:destination.solarSystemID}};}
export type ServerBot=NativeBot & {parking?:{phase:string;reason:string;dock:{id:number;kind:string;name:string|null}};parkingProgress?:string;civilianCheckpointID?:string;ownerRelease?:string;missionRecovery?:string|null;civilianOwned?:boolean;civilianView?:'CURRENT'|'HISTORY'|'RECOVERY';civilianStatus?:string;civilianPresentation?:ReturnType<typeof civilianReadout>['civilianPresentation'];canContinue?:boolean;hasAcceptedMission?:boolean;missionID?:number;missionIssue?:{state:string;reason:string};missionProgress?:{agentName:string|null;corporationName:string|null;missionName:string|null;completedCount:number|null};lastMissionReward?:any;civilianSafetyReason?:string|null;civilianParkingMode?:'SELECTED'|'NEAREST';parkingDestination?:{id:number;name:string|null};pauseReason?:string|null;maxRuntimeMinutes:number};
export type MiningMissionRecovery={pin:string;characterID:number;idle:boolean;reason?:string;journalStatus?:'NONEMPTY'|'EMPTY'|'UNREADABLE';activeMissions?:number;offeredMissions?:number;scope?:string;nativeReconciled?:boolean;cycle?:string;objectiveState?:number;missionSettled?:boolean;pending?:string|null};
const civilianBots=new Set<string>();
const civilianDirectories=new Map<string,Promise<FoundAgent[]>>();
const civilianLocationNames=new Map<string,{value:Promise<ResolvedDestination|null>;retryAt:number}>();
function civilianLocation(world:string,account:string,id:number,options:ApiOptions){
 const key=JSON.stringify([world,account.toLowerCase(),id]);
 const current=civilianLocationNames.get(key);
 if(current&&Date.now()<current.retryAt)return current.value;
 const entry={retryAt:Infinity,value:resolveDestination(id,options).then(result=>{
  if(result.kind!=='unknown'&&(result.stationName||result.systemName))return result;
  return null;
 }).catch(()=>null)};
 civilianLocationNames.set(key,entry);
 void entry.value.then(value=>{if(!value)entry.retryAt=Date.now()+60_000;});
 return entry.value;
}
export async function listCivilianHosted(options:ApiOptions={}):Promise<{bots:ServerBot[];recovery:MiningMissionRecovery[];recoveryUnavailable:string;accountIdle:boolean}>{
 const [r,checkpoints,account,world]=await Promise.all([authenticatedJson('/api/bots',options),authenticatedJson(`${plugin}/civilian/checkpoints`,options),authenticatedJson('/api/pilot-training/characters',options),authenticatedJson('/api/plugins/uoc/world',options)]);
 if(!Array.isArray(r.bots)||!Array.isArray(checkpoints.recovery)||!Array.isArray(checkpoints.history)||!Array.isArray(account.characters)||typeof account.account!=='string'||typeof world.worldID!=='string')throw Error('Scoped Civilian workers or checkpoints are unreadable.');
 const history=checkpoints.history;for(const row of history)if(row.worldID!==world.worldID||row.owner!==account.account.toLowerCase()||!account.characters.some((p:any)=>p.characterID===row.characterID)||typeof row.botID!=='string'||!['mining','distribution'].includes(row.kind))throw Error('Civilian checkpoint world/account/pilot identity differs.');
 const raw:NativeBot[]=r.bots.filter((b:NativeBot)=>b.kind==='plugin'&&b.plugin?.pluginID==='uoc'&&['civilian-mining','civilian-distribution'].includes(b.plugin.run));
 for(const row of history)if(!raw.some(b=>b.botID===row.botID)){const snapshot=row.worker??{readout:{pending:row.pending,firstFailure:row.firstFailure,recoveryRequired:!row.resolved},characterName:null,why:row.firstFailure,startedAt:'',expiresAt:null};raw.push({botID:row.botID,characterID:row.characterID,characterName:snapshot.characterName,kind:'plugin',plugin:{pluginID:'uoc',run:'civilian-'+row.kind,readout:snapshot.readout},status:row.status,phase:row.phase,why:snapshot.why,startedAt:snapshot.startedAt,expiresAt:snapshot.expiresAt,endedAt:row.ownerAvailable?null:new Date(row.updatedAt).toISOString(),scriptName:'Civilian '+row.kind+' stored worker'} as NativeBot);}
 const release=new Map<number,boolean>();await Promise.all([...new Set(raw.map(b=>b.characterID))].map(async id=>{let verified=false;try{const proof=await authenticatedJson(`/api/pilot-training/ownership?characterID=${id}`,options);verified=proof.ownership?.characterID===id&&proof.ownership.owner==='OFF'&&proof.ownership.online===false&&!r.bots.some((b:any)=>b.characterID===id&&!b.endedAt)&&history.filter((h:any)=>h.characterID===id).every((h:any)=>h.ownerAvailable===false);}catch{}release.set(id,verified);}));
 const names=new Map<number,FoundAgent>();for(const kind of ['mining','distribution']){
  const selected=raw.filter(b=>b.plugin?.run==='civilian-'+kind&&Number.isSafeInteger((b.plugin.readout as any)?.agentID));if(!selected.length)continue;
  const key=JSON.stringify([world.worldID,account.account.toLowerCase(),kind]);let directory=civilianDirectories.get(key);if(!directory){directory=findAgents({kind:kind==='mining'?'mining':'courier',limit:5000},options).then(r=>[...r.agents]);civilianDirectories.set(key,directory);void directory.catch(()=>civilianDirectories.delete(key));}
  try{for(const a of await directory)names.set(a.agentID,a);}catch{/* Missing directory names never fabricate native progress. */}
 }
 const locations=new Map<number,ResolvedDestination>();
 const visible=raw.filter(b=>!b.endedAt||!earlierCivilianSnapshot(history.find((h:any)=>h.botID===b.botID),history));
 const locationIDs=new Set(visible.flatMap(b=>Object.values(civilianLocations(b))));
 await Promise.all([...locationIDs].map(async id=>{
  if(id===null)return;
  const found=await civilianLocation(world.worldID,account.account,id,options);
  if(found)locations.set(id,found);
 }));
 const accountIdle=!r.bots.some((b:NativeBot)=>!b.endedAt);
 const bots=raw.map(b=>{
  const row=history.find((h:any)=>h.botID===b.botID),v=b.plugin?.readout as any;
  const released=release.get(b.characterID)===true,owned=row?.ownerAvailable===true;
  const accepted=readAcceptedMission(row?.acceptedMission);
  const latest=!!row&&history.find((h:any)=>h.characterID===b.characterID&&h.kind===row.kind)?.botID===b.botID;
  const samePausedOwner=owned&&row.kind==='mining'&&b.status==='paused'&&!b.endedAt;
  const result:ServerBot={...b,...civilianReadout(b,names.get(v?.agentID),{releaseVerified:released,ownerAvailable:owned,missionUnresolved:row?row.resolved!==true:v?.recoveryRequired===true},locations),
   characterName:b.characterName??account.characters.find((p:any)=>p.characterID===b.characterID)?.name??null,
   ...(row?{civilianCheckpointID:row.botID}:{}),
   ...(Number.isSafeInteger(v?.mission)&&v.mission>0?{missionID:v.mission}:accepted?{missionID:accepted.missionID}:{}),
   hasAcceptedMission:latest&&row.resolved!==true&&!!accepted,
   canContinue:latest&&!!row.setup&&row.resolved!==true&&!!accepted&&(samePausedOwner||released&&accountIdle)};
  const failed=b.status==='error'||b.status==='paused'||b.phase==='Needs attention'||(b.endedAt&&v?.firstFailure);
  if(b.endedAt&&(b.phase==='Completed'||v?.missionSettled===true&&v?.completedCount>0))result.civilianStatus='Completed';
  else if(failed&&!(released&&accepted&&!v?.pending&&!v?.firstFailure&&b.phase==='Docked'))result.civilianStatus='Needs attention';
  else if(!b.endedAt)result.civilianStatus=v?.continuing||row?.setup?.continuation?'Continuing':'Running';
  else if(accepted&&latest)result.civilianStatus='Stopped · Mission accepted';
  else result.civilianStatus='Stopped';
  if(result.canContinue&&result.civilianStatus==='Stopped · Mission accepted')result.civilianView='CURRENT';
  if(earlierCivilianSnapshot(row,history)){
   result.civilianView='HISTORY';result.civilianOwned=false;
   result.missionRecovery='Historical interrupted run; use the latest worker for current mission state. Original evidence remains retained.';
  }
  if(result.civilianOwned)civilianBots.add(b.botID);
  return result;
 });
 return {bots,recovery:checkpoints.recovery.filter((row:any)=>!bots.some(b=>b.botID===(row.botID??row.pin))),recoveryUnavailable:checkpoints.legacyNotice??'',accountIdle};
}
export async function stopServerBot(botID:string,options:ApiOptions={}){if(civilianBots.has(botID))return authenticatedJson(`${plugin}/runs/${encodeURIComponent(botID)}/stop`,options,{});return nativeStop(botID,options);}
export async function checkMiningMissionRecovery(row:MiningMissionRecovery,finalize:boolean,options:ApiOptions={}):Promise<MiningMissionRecovery>{
 if(finalize)throw Error('This check reads the original checkpoint; it does not finalize a mission.');
 if(!row.pin)throw Error('The exact original checkpoint identity is required.');
 const result=await authenticatedJson(`${plugin}/civilian/checkpoints/${encodeURIComponent(row.pin)}/check`,options,{});
 if(result.recovery?.characterID!==row.characterID||result.recovery?.pin!==row.pin)throw Error('The exact Civilian recovery identity changed.');return {...row,...result.recovery};
}

/** Bind the normal hosted executor to one accepted mission from the selected checkpoint. */
export async function continueCivilianMission(bot:ServerBot,options:ApiOptions){
 const kind=bot.plugin?.run==='civilian-mining'?'mining':bot.plugin?.run==='civilian-distribution'?'distribution':null;
 const [data,bots,account]=await Promise.all([authenticatedJson(`${plugin}/civilian/checkpoints`,options),authenticatedJson('/api/bots',options),authenticatedJson('/api/pilot-training/characters',options)]);
 const rows=data.history,original=rows?.find((r:any)=>r.botID===(bot.civilianCheckpointID??bot.botID));
 if(!kind||!original||original.kind!==kind||original.characterID!==bot.characterID||!original.setup||
    !account.characters?.some((p:any)=>p.characterID===bot.characterID)||original.owner!==account.account?.toLowerCase())
  throw Error('The original Civilian mission setup is unavailable for this pilot.');
 if(rows.find((r:any)=>r.characterID===bot.characterID&&r.kind===kind)?.botID!==original.botID)throw Error('A newer Civilian run exists. Use its current controls.');
 const accepted=readAcceptedMission(original.acceptedMission);
 if(!accepted||original.resolved===true)throw Error('No confirmed unfinished accepted mission is available.');
 if(!Array.isArray(bots.bots))throw Error('Current hosted ownership is unavailable.');
 if(original.ownerAvailable&&kind==='mining'&&bots.bots.some((b:NativeBot)=>b.botID===original.botID&&b.characterID===bot.characterID&&!b.endedAt&&b.status==='paused'))
  return authenticatedJson(`${plugin}/civilian/checkpoints/${encodeURIComponent(original.botID)}/continue`,options,{});
 const ownership=(await authenticatedJson(`/api/pilot-training/ownership?characterID=${bot.characterID}`,options)).ownership;
 if(original.ownerAvailable||ownership?.characterID!==bot.characterID||ownership.owner!=='OFF'||ownership.online!==false||bots.bots.some((b:NativeBot)=>!b.endedAt))
  throw Error('This pilot or account already has an owner. Use its current operation controls.');
 const {durationMinutes:_duration,...retained}=original.setup;
 const setup={...retained,missionCount:1,continuation:{...accepted,botID:original.botID}},maximum=bots.hostedRunPolicy?.maxRuntimeMinutes;
 if(!Number.isSafeInteger(maximum)||maximum<1)throw Error('Hosted operation duration is unavailable.');
 const run='civilian-'+kind,check=await checkPluginRun('uoc',run,setup,options);
 return startPluginRun(bot.characterID,'uoc',run,check.setup,createPluginRunGrant(check.policy,maximum),options);
}
