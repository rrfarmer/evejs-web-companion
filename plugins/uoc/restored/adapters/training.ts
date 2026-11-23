import {trainingPlanTargets, trainingTargets} from '../../shared/trainingTargets.ts';
import {isListValue,readKeyVal} from '../../shared/wire.ts';
import {FITTING_TIERS,haulingSkillCandidates,legacyMasteryGoals,recommendFittingSkills,type PlanDepth,type SkillGoal,type FittingItem,type FittingDogma,type Recommendation} from '../training/planner.ts';
import {estimateAdditionalTraining,estimateTrainingFunding,type TrainingFundingEstimate} from '../training/estimate.ts';
import {isTrainingFundingPolicy,resolveTrainingFundingPolicy,type FundingPolicy} from '../../training/funding.ts';
import {fittingNames} from './fittingNames.ts';
import type {ApiOptions,JsonValue} from '../../../../web/src/plugin-api/index.ts';
import type {TrainingCharacter,TrainingQueue,AcquisitionReview,AcquisitionOutcome,FactoryFunding,QueueApplyOutcome,TrainingSheet} from '../training/types.ts';
import {expandTrainingInspection, queueIdentity, skillReviewKey, trainingSheetFromProof} from '../../training/queue.ts';
import type {TrainingSettingsContext,TrainingWallet} from '../training/settings.ts';
export type {ApiOptions};
export type TrainingEnrollment={state:string;enrollmentState?:string;recordedReason?:string|null;corporationID?:number;corporationName?:string|null;rights?:string;roleMasks?:Record<string,string>;reason?:string;message?:string};
export type TrainingAccountOutcome={status:'ACCOUNT_CREATED'|'ACCOUNT_RECOVERED'|'ACCOUNT_CONFIRMED'|'RECOVERY_REQUIRED';account:{username:string;accountID:number}|null;message?:string};
export type TrainingFitChoice={fittingID:number;name:string;shipTypeID:number;fingerprint:string;hullName:string;groupID:number|null;groupName:string;issue?:string|null};
type ReviewRecommendation=Recommendation & {name:string;enabled:boolean;bookNeeded:boolean;bookCostISK:number|null};
export type TrainingGoalOutcome={phase:string;requirements:{typeID:number;name:string;level:number;currentLevel:number;bookMissing:boolean;queuedLevel?:number;bookCostISK?:number;mandatoryLevel?:number;reviewState?:string}[];requirementsUnavailable?:boolean;totalISK?:string;fundedISK?:string;fundingSource?:string;fundingEstimate?:TrainingFundingEstimate;trainingTimeReason?:string|null;estimatedCost?:boolean;queueVerified?:boolean;remainingTrainingMs?:number|null;queue?:TrainingQueue;sheet?:TrainingSheet;additionalSP?:number|null;additionalTrainingMs?:number|null;recommendations?:ReviewRecommendation[];reviewKey?:string;blockers?:string[]};
export type HostedResult={botID:string;phase:string;status:string;why:string|null;readout:unknown};
export interface TrainingAdapterContext {authenticatedJson:(path:string,options:ApiOptions,body?:unknown)=>Promise<any>;runHosted:(characterID:number,kind:string,setup:JsonValue,options:ApiOptions)=>Promise<HostedResult>;worldID?:(options:ApiOptions)=>Promise<string|null>}
type FundingSetup = {corporationID?:number; corporateFunding?:true; fundingPolicy?:'CORPORATION_WALLET_ONLY'};
type FundingQuote = {corporationID:number; totalISK:number; balanceISK?:unknown; corporateWallet?:{balanceISK?:unknown;reason?:string|null}|null};
let context:TrainingAdapterContext|null=null;
const skillReviews=new Map<string,{characterID:number;typeID:number;level:number;token:string;kind:'queue'|'purchase';identity:string;totalISK:number;funding:FundingSetup;used:boolean}>();
const onboardingReviews=new Map<string,{traineeID:number;authorityID:number;corporationID:number;rights:'NONE'|'FULL_ACCESS_EXCEPT_CEO';authorityToken:string;traineeToken:string;worldID:string;used:boolean;existingMember:boolean}>();
export function installTrainingAdapter(value:TrainingAdapterContext|null){context=value;skillReviews.clear();onboardingReviews.clear();}
export function trainingAdapterContext(){if(!context)throw Error('Training adapter is not connected to the current pilot context.');return context;}
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const unsupported=(name:string):never=>{throw Error(`${name} is not connected to a supported UOC adapter.`);};
export async function loginFactoryAccount(username:string,options:ApiOptions={},password?:string):Promise<{account:string;token:string}>{const r=await trainingAdapterContext().authenticatedJson('/api/pilot-training/login',options,{username,password:password??''});if(typeof r?.account?.username!=='string'||typeof r.sessionToken!=='string'||!r.sessionToken)throw Error('Account authentication is unreadable.');return {account:r.account.username,token:r.sessionToken};}
export async function loadTrainingCharacters(options:ApiOptions={}):Promise<{account:string;characters:readonly TrainingCharacter[]}>{const r=await trainingAdapterContext().authenticatedJson('/api/pilot-training/characters',options);if(typeof r?.account!=='string'||!Array.isArray(r.characters)||r.characters.some((x:any)=>!positive(x?.characterID)||typeof x.name!=='string'))throw Error('Training roster is unreadable.');return {account:r.account,characters:r.characters};}
export async function readTrainingActiveShip(characterID:number,options:ApiOptions):Promise<string|null>{
 if(!positive(characterID))throw Error('Pilot identity unavailable.');
 const read=trainingAdapterContext().authenticatedJson;
 const {result}=await read('/api/roster/characters',options);
 const characters=Array.isArray(result)&&result.length===4?result[2]:null;
 if(!isListValue(characters))return null;
 const pilot=characters.items.find(row=>readKeyVal(row,'characterID')===characterID);
 const shipName=readKeyVal(pilot,'shipName');
 if(typeof shipName==='string'&&shipName.trim())return shipName.trim();
 const typeID=readKeyVal(pilot,'shipTypeID');
 if(!positive(typeID))return null;
 const {names}=await read('/api/names',options,{items:[{kind:'type',id:typeID}]});
 const typeName=names?.[`type:${typeID}`];
 return typeof typeName==='string'&&typeName.trim()?typeName.trim():null;
}
/** Restore the saved HR picker from account-level observations without a pilot session. */
export async function readSavedTrainingAuthority(options:ApiOptions,authorityID:number):Promise<TrainingSettingsContext>{
 const result=await trainingAdapterContext().authenticatedJson('/api/pilot-training/settings-context',options);
 if(!Array.isArray(result?.authorities)||!Array.isArray(result?.corporations))throw Error('Corporation authority is unreadable.');
 const authority=result.authorities.find((row:any)=>row?.characterID===authorityID);
 const corporation=result.corporations.find((row:any)=>row?.corporationID===authority?.corporationID);
 if(!authority||!corporation||!positive(corporation.corporationID)||typeof authority.name!=='string'||
    typeof authority.eligible!=='boolean'||typeof corporation.name!=='string'||!Array.isArray(corporation.divisions))
  throw Error('The saved HR pilot is missing from the verified corporation roster.');
 return {authorities:[authority],corporations:[corporation]};
}
export async function loadTrainingSettingsContext(options:ApiOptions, authorityID:number, rosterPilot?:TrainingCharacter):Promise<TrainingSettingsContext>{
 if(!positive(authorityID))throw Error('Choose an HR pilot from the authenticated roster.');
 const pilot=rosterPilot??(await loadTrainingCharacters(options)).characters.find(p=>p.characterID===authorityID);
 if(pilot?.characterID!==authorityID)throw Error('Choose an HR pilot from the authenticated roster.');
 const result=await trainingAdapterContext().runHosted(authorityID,'training-hr',{stage:'inspect',authorityID},options);
 const r=result.readout as any;
 if(result.phase!=='Corporation authority inspected'||r?.characterID!==authorityID||!positive(r.corporationID)||typeof r.eligible!=='boolean'||!r.roleMasks||typeof r.roleMasks!=='object'||!['roles','grantableRoles','rolesAtHQ','grantableRolesAtHQ','rolesAtBase','grantableRolesAtBase','rolesAtOther','grantableRolesAtOther'].every(k=>typeof r.roleMasks[k]==='string'&&/^\d+$/.test(r.roleMasks[k])))throw Error(result.why??'Corporation authority inspection is unverified.');
 return {corporations:[{corporationID:r.corporationID,name:typeof r.corporationName==='string'&&r.corporationName.trim()?r.corporationName:`Corporation ${r.corporationID}`,divisions:[{accountKey:1000,name:'Master Wallet'}]}],
  authorities:[{characterID:authorityID,name:pilot.name,corporationID:r.corporationID,eligible:r.eligible,reason:typeof r.reason==='string'?r.reason:undefined}]};
}
export async function trainingAccount(action:'create'|'recover',username:string,options:ApiOptions={}):Promise<TrainingAccountOutcome>{const r=await trainingAdapterContext().authenticatedJson(`/api/pilot-training/accounts/${action}`,{...options,token:null},{username,...(action==='create'?{confirm:true}:{})});if(!r||typeof r.status!=='string'||!Object.hasOwn(r,'account'))throw Error('Account creation outcome is unavailable.');return r as TrainingAccountOutcome;}
export function trainingWorldIdentity(value:unknown):string|null{
 return typeof value==='string'&&/^(?:wc-install:)?[a-f0-9]{64}$/.test(value)?value:null;
}
export async function readTrainingWorld(options:ApiOptions={}):Promise<{worldID:string|null}>{
 const id=context?.worldID?await context.worldID(options):(await trainingAdapterContext().authenticatedJson('/api/plugins/uoc/world',options)).worldID;
 return {worldID:trainingWorldIdentity(id)};
}
async function inspect(id:number,options:ApiOptions,selection:JsonValue={}){
 if(!positive(id))throw Error('Pilot identity unavailable.');
 const result=await trainingAdapterContext().runHosted(id,'training-inspect',selection,options),raw=result.readout as any;
 if(result.phase!=='Training inspected'||raw?.characterID!==id||!positive(raw.corporationID)||!Array.isArray(raw.choices))
  throw Error(result.why??'Training inspection is unverified.');
 const r=expandTrainingInspection(raw);
 if(!Array.isArray(r.skills)||!r.queue)throw Error('The native training sheet or queue is unreadable.');
 return {...r,characterID:id,corporationID:r.corporationID,choices:r.choices,skills:r.skills,queue:r.queue,
  balanceISK:r.balanceISK,corporateWallet:r.corporateWallet,characterAttributes:r.characterAttributes,cloneGrade:r.cloneGrade};
}
export async function readTrainingFittingGoals(id:number,options:ApiOptions):Promise<{
 corporationID:number;
 corporationName:string|null;
 choices:TrainingFitChoice[];
 unavailableFittingIDs:number[];
}>{
 if(!positive(id))throw Error('Pilot identity unavailable.');
 const api=trainingAdapterContext().authenticatedJson;
 const query=new URLSearchParams({characterID:String(id),providerCharacterID:String(id),fittingID:'0',sourceKind:'hangar',division:'1'});
 const {definitions}=await api(`/api/ship-provisioning/review?${query}`,options);
 if(definitions?.status!=='READY'||definitions.providerCharacterID!==id||!positive(definitions.corporationID)||!Array.isArray(definitions.contracts))
  throw Error('The corporation fitting library is unavailable.');
 const corporationID=definitions.corporationID;
 const fits=definitions.contracts.map((fit:any)=>{
  const def=fit?.definition;
  if(!positive(def?.fittingID)||def.characterID!==id||def.corporationID!==corporationID||!positive(fit.shipTypeID)||
     typeof fit.name!=='string'||typeof def.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(def.fingerprint))
   throw Error('The corporation fitting identity is unavailable.');
  return {corporationID,fittingID:def.fittingID,goalTypeID:fit.shipTypeID,name:fit.name,fingerprint:def.fingerprint};
 });
 const unavailableFittingIDs = Array.isArray(definitions.invalid)
  ? definitions.invalid.flatMap((row: { fittingID?: unknown } | null) =>
    positive(row?.fittingID) ? [row.fittingID] : [])
  : [];
 const choices=await fittingNames(fits,options,api);
 return {corporationID,corporationName:null,unavailableFittingIDs,choices:choices.map((x:any)=>({fittingID:x.fittingID,name:x.name,shipTypeID:x.goalTypeID,
  fingerprint:x.fingerprint,hullName:x.hullName,groupID:x.hullGroupID,groupName:x.hullGroupName??'Unknown ship group'}))};
}
function fittingRequirements(fit:any, prior:{skills:any[];queue:any}):TrainingGoalOutcome['requirements']|null {
 if(!Array.isArray(fit.prerequisites)||!Array.isArray(prior.skills)||!Array.isArray(prior.queue?.entries))return null;
 const learned=new Map<number,number>();for(const skill of prior.skills){if(!positive(skill?.typeID)||!Number.isInteger(skill.level)||skill.level<0||skill.level>5||learned.has(skill.typeID))return null;learned.set(skill.typeID,skill.level);}
 const targets=new Map<number,number>();for(const target of fit.prerequisites){if(!positive(target?.typeID)||!Number.isInteger(target.toLevel)||target.toLevel<1||target.toLevel>5)return null;targets.set(target.typeID,Math.max(targets.get(target.typeID)??0,target.toLevel));}
 return [...targets].map(([typeID,level])=>({typeID,name:`Skill ${typeID}`,level,currentLevel:learned.get(typeID)??0,bookMissing:!learned.has(typeID),...(prior.queue.entries.some((e:any)=>e?.typeID===typeID&&Number.isInteger(e.toLevel)&&e.toLevel>=level)?{reviewState:'ALREADY_QUEUED'}:{})}));
}
async function hullQuote(characterID:number,goalTypeID:number,options:ApiOptions,skillLevel?:number,skillReview:'queue'|'purchase'='queue',policy:FundingPolicy='CHARACTER_WALLET_ONLY'){
 if(!positive(goalTypeID))throw Error('Choose an exact ship type.');const api=trainingAdapterContext().authenticatedJson;
 const [hull,graph]=await Promise.all([api(`/api/client-data/type-prices?typeIDs=${goalTypeID}`,options),api(`/api/client-data/required-skills?typeIDs=${goalTypeID}`,options)]);
 if(hull?.available!==true||hull.categoryID?.[goalTypeID] !== (skillLevel===undefined?6:16)||hull.published?.[goalTypeID]!==true)throw Error('The selected ship type is unavailable or unpublished.');
 if(graph?.available!==true||!graph.required||typeof graph.required!=='object')throw Error('Required skill data is unavailable.');
 const r=skillLevel===undefined || (skillReview==='purchase' && policy!=='CHARACTER_WALLET_ONLY')
  ? await inspect(characterID,options) : await inspectIndependentSkill(characterID,options,skillReview);
 const targets=trainingTargets(goalTypeID,graph.required);
 if(skillLevel!==undefined){
  if(!positive(skillLevel)||skillLevel>5)throw Error('Choose a skill level from 1 to 5.');
  for(let n=1;n<=skillLevel;n++)targets.push({typeID:goalTypeID,toLevel:n});
 }
 return quoteTrainingTargets(targets,r,options);
}
async function directBookPrices(ids: number[], options: ApiOptions): Promise<Record<number, number>> {
 const api=trainingAdapterContext().authenticatedJson, result:Record<number,number>={};
 for(let at=0;at<ids.length;at+=50){
  const batch=ids.slice(at,at+50), query=batch.join(',');
  const [prices,lists]=await Promise.all([api(`/api/client-data/type-prices?typeIDs=${query}`,options),api(`/api/types/type-lists?typeIDs=${query}&listIDs=93`,options)]);
  if(prices?.available!==true||!prices.basePrice||!prices.published||!lists?.lists)throw Error('Skill prices are unavailable.');
  for(const id of batch){
   const base=prices.basePrice[id], value=typeof base==='number'?base*1.3:NaN, cents=Math.round(value*100);
   if(Number.isFinite(value)&&base>0&&prices.published[id]===true&&Array.isArray(lists.lists[id])&&lists.lists[id].includes(93)&&Number.isSafeInteger(cents)&&Math.abs(value*100-cents)<=.001)result[id]=cents/100;
  }
 }
 return result;
}
async function quoteTrainingTargets(targets:{typeID:number;toLevel:number}[],r:any,options:ApiOptions,allowUnquoted=false){
 const requirements=fittingRequirements({prerequisites:targets},r);
 if(requirements===null)throw Error('Pilot skill sheet is unreadable.');
 const missing=requirements.filter(x=>x.bookMissing).map(x=>x.typeID);
 if(!allowUnquoted&&missing.length>32)throw Error('The required skill list is too large to quote.');
 const pricesByType=await directBookPrices(missing,options),unpriced=missing.filter(id=>pricesByType[id]===undefined);
 if(!allowUnquoted&&unpriced.length)throw Error(`Required skillbook ${unpriced[0]} cannot be quoted for direct purchase.`);
 let total=0;
 for(const id of missing){
  const value=pricesByType[id];
  if(value!==undefined)total+=Math.round(value*100);
 }
 if(!Number.isSafeInteger(total))throw Error('The skillbook quote is not representable.');
 return {corporationID:r.corporationID,requirements,targets,totalISK:total/100,pricesByType,unpriced,missingCount:missing.length,skills:r.skills,queue:r.queue,balanceISK:r.balanceISK,corporateWallet:r.corporateWallet,characterAttributes:r.characterAttributes,cloneGrade:r.cloneGrade};
}
export function verifiedTrainingOutcome(readout:any,requirements:TrainingGoalOutcome['requirements'],totalISK:number):TrainingGoalOutcome {
 const q=readout?.queue,queue=q&&typeof q.active==='boolean'&&Number.isSafeInteger(q.maxEntries)&&Array.isArray(q.entries)&&q.entries.every((e:any)=>positive(e.typeID)&&positive(e.toLevel)&&e.toLevel<=5)?{active:q.active,maxEntries:q.maxEntries,entries:q.entries.map((e:any)=>({typeID:e.typeID,toLevel:e.toLevel,name:`Skill ${e.typeID}`,startTimeMs:e.startTimeMs??null,endTimeMs:e.endTimeMs??null}))}:undefined;
 const reconciledRequirements=requirements.map(r=>{const queued=queue?.entries.some((e:{typeID:number;toLevel:number})=>e.typeID===r.typeID&&e.toLevel>=r.level);return queued?{...r,bookMissing:false,reviewState:queue?.active&&queue.entries[0]?.typeID===r.typeID?"TRAINING":"ALREADY_QUEUED"}:r;});
 const sheet=trainingSheetFromProof(readout,readout?.characterID),receipt=readout?.transferReceipt,shortfall=receipt?.shortfall;return {phase:'QUEUE_VERIFIED',requirements:reconciledRequirements,queueVerified:true,totalISK:String(Number.isSafeInteger(readout?.totalCents)?readout.totalCents/100:totalISK),estimatedCost:!Number.isSafeInteger(readout?.totalCents),...(queue?{queue}:{}),...(sheet?{sheet}:{}),...(queue?.active&&typeof q.endTimeMs==='number'&&Number.isFinite(q.endTimeMs)&&q.endTimeMs>0?{remainingTrainingMs:Math.max(0,q.endTimeMs-Date.now())}:{}),...(Number.isSafeInteger(shortfall)&&shortfall>0&&positive(receipt?.personalTransactionID)&&positive(receipt?.corporateTransactionID)?{fundedISK:String(shortfall/100),fundingSource:'Corporation'}:{})};
}
function trainingWalletIssue(policy: FundingPolicy, corporationID: number, wallet?: TrainingWallet | null) {
 if (policy === 'CHARACTER_WALLET_ONLY' || wallet === undefined) return null;
 if (!wallet) return 'Configure the corporation Master Wallet in Corporation HR Pilot to fund skillbooks.';
 if (wallet.accountKey !== 1000 || wallet.corporationID !== corporationID)
  return 'The configured Master Wallet must be Division 1 of the trainee’s current corporation.';
 return null;
}

function trainingFundingEstimate(quote: FundingQuote, policy: FundingPolicy, wallet?: TrainingWallet | null) {
 const reason = trainingWalletIssue(policy, quote.corporationID, wallet);
 return estimateTrainingFunding(quote.totalISK, quote.balanceISK, policy, reason ? {reason} : quote.corporateWallet ?? undefined);
}

function trainingFundingSetup(quote: FundingQuote, policy: FundingPolicy, wallet?: TrainingWallet | null): FundingSetup {
 if (policy === 'CHARACTER_WALLET_ONLY') return {};
 const reason = trainingWalletIssue(policy, quote.corporationID, wallet);
 if (reason && quote.totalISK > 0) throw Error(reason);
 return policy === 'CORPORATION_WALLET_ONLY'
  ? {corporationID:quote.corporationID,fundingPolicy:policy} : {corporationID:quote.corporationID,corporateFunding:true};
}

export async function runTrainingGoal(body:{characterID:number;goalTypeID:number;mode:'PREVIEW'|'START';planDepth?:PlanDepth|'MASTERY';excludedOptionalTypeIDs?:number[];reviewKey?:string;goalFitting?:{corporationID:number;fittingID:number;fingerprint:string};corporateFundingEnabled?:boolean;fundingPolicy?:FundingPolicy;worldID?:string|null;trainingWallet?:TrainingWallet|null},options:ApiOptions):Promise<{outcome:TrainingGoalOutcome}>{
 const policy=resolveTrainingFundingPolicy(body.fundingPolicy,body.corporateFundingEnabled), wallet=body.trainingWallet;
 if(!body.goalFitting){
  const quote=await hullQuote(body.characterID,body.goalTypeID,options);
  if(body.mode==='PREVIEW')return {outcome:await planOutcome(quote,options,policy,wallet)};
  const setup={goalTypeID:body.goalTypeID,maxSpendISK:quote.totalISK,...trainingFundingSetup(quote,policy,wallet)};
  const result=await trainingAdapterContext().runHosted(body.characterID,'training',setup,options);
  if(result.phase!=='Training queued'||(result.readout as any)?.queueVerified!==true)throw Error(result.why??'Training outcome needs reconciliation.');
  return {outcome:verifiedTrainingOutcome(result.readout,quote.requirements,quote.totalISK)};
 }
 const prior=await inspect(body.characterID,options,{...body.goalFitting,goalTypeID:body.goalTypeID});const fit=prior.choices.find((x:any)=>x.fittingID===body.goalFitting!.fittingID&&x.goalTypeID===body.goalTypeID&&x.corporationID===body.goalFitting!.corporationID&&x.fingerprint===body.goalFitting!.fingerprint);if(!fit||typeof fit.estimatedCostISK!=='number'||!Number.isFinite(fit.estimatedCostISK)||fit.estimatedCostISK<0)throw Error(fit?.issue??'The exact fitting or book quote is unavailable.');
 if(body.planDepth){
  const quote=await fittingDepthQuote(fit,prior,body.planDepth,body.excludedOptionalTypeIDs??[],options,policy,wallet);
  if(body.mode==='PREVIEW')return {outcome:quote.outcome};
  if(quote.outcome.blockers?.length)throw Error(quote.outcome.blockers.join(' '));
  if(body.planDepth!=='MASTERY'&&body.reviewKey!==quote.outcome.reviewKey)throw Error('The fitting plan or funding quote changed. Review the current selection before starting training.');
  const setup={goalTypeID:fit.goalTypeID,maxSpendISK:quote.totalISK,corporationID:fit.corporationID,fittingID:fit.fittingID,fingerprint:fit.fingerprint,...(quote.skillGoals.length?{skillGoals:quote.skillGoals}:{}),...trainingFundingSetup(quote,policy,wallet)};
  const result=await trainingAdapterContext().runHosted(body.characterID,'training',setup,options);
  if(result.phase!=='Training queued'||(result.readout as any)?.queueVerified!==true)throw Error(result.why??'The reviewed training queue remains unverified.');
  return {outcome:verifiedTrainingOutcome(result.readout,quote.outcome.requirements,quote.totalISK)};
 }
 const requirements=fittingRequirements(fit,prior);
 if(body.mode==='PREVIEW')return {outcome:requirements
  ? await planOutcome({...prior,requirements,totalISK:fit.estimatedCostISK,pricesByType:{}},options,policy,wallet)
  : {phase:'PREVIEW',requirements:[],requirementsUnavailable:true,totalISK:String(fit.estimatedCostISK),estimatedCost:true,
    trainingTimeReason:'Native fitting prerequisites are unavailable.'}};
 const setup={goalTypeID:fit.goalTypeID,maxSpendISK:fit.estimatedCostISK,corporationID:fit.corporationID,fittingID:fit.fittingID,fingerprint:fit.fingerprint,
  ...trainingFundingSetup({corporationID:fit.corporationID,totalISK:fit.estimatedCostISK},policy,wallet)};
 const result=await trainingAdapterContext().runHosted(body.characterID,'training',setup,options);
 if(result.phase!=='Training queued'||(result.readout as any)?.queueVerified!==true)throw Error(result.why??'Training outcome needs reconciliation.');
 return {outcome:{...verifiedTrainingOutcome(result.readout,requirements??[],fit.estimatedCostISK),requirementsUnavailable:requirements===null}};
}
export async function readTrainingHullGoals(query:string,options:ApiOptions):Promise<{goals:{typeID:number;name:string}[]}>{const q=query.trim();if(q.length<2)return {goals:[]};const api=trainingAdapterContext().authenticatedJson,data=await api(`/api/market/find?q=${encodeURIComponent(q)}&limit=100`,options);if(!Array.isArray(data?.matches)||data.matches.some((x:any)=>!positive(x?.typeID)||typeof x.name!=='string'||!x.name.trim())||new Set(data.matches.map((x:any)=>x.typeID)).size!==data.matches.length)throw Error('Ship catalogue is unreadable.');if(data.capped===true)throw Error('Too many market matches; refine the ship search.');const goals:{typeID:number;name:string}[]=[];for(let i=0;i<data.matches.length;i+=50){const batch=data.matches.slice(i,i+50),meta=await api(`/api/client-data/type-prices?typeIDs=${batch.map((x:any)=>x.typeID).join(',')}`,options);if(meta?.available!==true||!meta.categoryID||!meta.published||batch.some((x:any)=>meta.categoryID[x.typeID]==null||typeof meta.published[x.typeID]!=='boolean'))throw Error('Ship catalogue qualification is unavailable.');goals.push(...batch.filter((x:any)=>meta.categoryID[x.typeID]===6&&meta.published[x.typeID]===true).map((x:any)=>({typeID:x.typeID,name:x.name})));}return {goals};}
export async function trainingOnboarding(action:'review'|'apply',body:any,options:ApiOptions):Promise<Record<string,any>>{
 if(action==='review'){
  const traineeID=body?.characterID,authorityID=body?.authority?.characterID,corporationID=body?.corporationID,authorityToken=body?.authority?.token,traineeToken=options.token,rights=body?.rights;
  if(body?.enabled!==true||!positive(traineeID)||!positive(authorityID)||traineeID===authorityID||!positive(corporationID)||typeof authorityToken!=='string'||!authorityToken||typeof traineeToken!=='string'||!traineeToken||(rights!=='NONE'&&rights!=='FULL_ACCESS_EXCEPT_CEO'))throw Error('The exact trainee, director, corporation and permissions are required.');
  if(!positive(body.currentCorporationID))throw Error('The trainee corporation is unavailable.');
  const existingMember=body.currentCorporationID===corporationID;if(existingMember)await verifyTrainingMembership(traineeID,corporationID,options);
  const worldID=(await readTrainingWorld(options)).worldID;if(!worldID||body.worldID!==worldID)throw Error('Current world identity is unavailable or changed.');
  const reviewID=crypto.randomUUID();onboardingReviews.set(reviewID,{traineeID,authorityID,corporationID,rights,authorityToken,traineeToken,worldID,used:false,existingMember});return {reviewID};
 }
 const r=onboardingReviews.get(body?.reviewID);if(!r||r.used||body?.confirm!==true||body?.authority?.characterID!==r.authorityID||body?.authority?.token!==r.authorityToken||options.token!==r.traineeToken)throw Error('Onboarding review is unavailable, changed or already dispatched.');
 if(body?.worldID!==r.worldID||(await readTrainingWorld(options)).worldID!==r.worldID)throw Error('Current world identity changed after review.');
 if(r.used)throw Error('Onboarding review was already dispatched.');r.used=true;const setup={traineeID:r.traineeID,authorityID:r.authorityID,corporationID:r.corporationID};
 const stage=async(actor:number,kind:string,name:string,credential:ApiOptions,accepted:readonly string[])=>{const result=await trainingAdapterContext().runHosted(actor,kind,{...setup,stage:name} as JsonValue,credential),proof=result.readout as any;if(!accepted.includes(result.phase)||proof?.traineeID!==r.traineeID||proof?.corporationID!==r.corporationID)throw Error(result.why??`Onboarding ${name} needs reconciliation.`);return result;};
 if(r.existingMember){if(r.rights==='NONE')return {verified:true,rights:'NONE'};const granted=await stage(r.authorityID,'training-hr','grant-existing',{token:r.authorityToken},['Onboarding verified']);if((granted.readout as any)?.roleMasksVerified!==true)throw Error('Role masks are unverified.');return {verified:true,rights:r.rights};}
 await stage(r.authorityID,'training-hr','invite',{token:r.authorityToken},['Invitation verified']);
 const joined=await stage(r.traineeID,'training-join','join',options,['Membership verified','Membership check needed']);
 if(r.rights==='NONE'){if(joined.phase!=='Membership verified')throw Error('Membership needs read-only reconciliation.');return {verified:true,rights:'NONE'};}
 const grant=await stage(r.authorityID,'training-hr','grant',{token:r.authorityToken},['Onboarding verified']);if((grant.readout as any)?.roleMasksVerified!==true)throw Error('Role masks are unverified.');return {verified:true,rights:r.rights};
}
export async function loadTrainingEnrollment(id:number,options:ApiOptions):Promise<TrainingEnrollment>{if(!positive(id))throw Error('Pilot identity unavailable.');const result=await trainingAdapterContext().runHosted(id,'training-hr',{stage:'member-inspect',authorityID:id},options),r=result.readout as any;const world=await readTrainingWorld(options);if(result.phase!=='Training membership inspected'||r?.characterID!==id||!positive(r.corporationID)||!world.worldID||r.worldID!==world.worldID||!r.roleMasks||!['roles','grantableRoles','rolesAtHQ','grantableRolesAtHQ','rolesAtBase','grantableRolesAtBase','rolesAtOther','grantableRolesAtOther'].every(k=>typeof r.roleMasks[k]==='string'&&/^\d+$/.test(r.roleMasks[k]))||!['FULL_ACCESS_EXCEPT_CEO','OTHER','UNKNOWN'].includes(r.rights)||typeof r.enrollmentState!=='string')throw Error(result.why??'Training membership is unavailable.');return {state:'READY',corporationID:r.corporationID,corporationName:typeof r.corporationName==='string'?r.corporationName:null,rights:r.rights,roleMasks:r.roleMasks,enrollmentState:r.enrollmentState};}
export async function verifyTrainingMembership(id:number,corp:number,options:ApiOptions):Promise<TrainingEnrollment>{if(!positive(corp))throw Error('Corporation identity is unavailable.');const r=await inspect(id,options);if(r.corporationID!==corp)throw Error('The pilot is not in the selected corporation.');return {state:'READY',corporationID:corp};}
export async function loadMinerTraining(..._args:any[]):Promise<any>{return unsupported('Miner training plan');}
async function inspectSkillSheet(id:number,options:ApiOptions,skillReview?:'queue'|'purchase'){
 const result=await trainingAdapterContext().runHosted(id,'training-inspect',{skillSheetOnly:true,...(skillReview?{skillReview}:{})},options);
 const sheet=trainingSheetFromProof(result.readout,id);
 if(result.phase!=='Training skills read'||!sheet)throw Error(result.why??'Native skills and queue are unavailable.');
 return {sheet,readout:result.readout as {corporationID?:unknown;balanceISK?:unknown}};
}
async function inspectIndependentSkill(id:number,options:ApiOptions,skillReview:'queue'|'purchase'){
 const {sheet,readout}=await inspectSkillSheet(id,options,skillReview);
 if(!positive(readout.corporationID))throw Error('The pilot corporation is unavailable.');
 return {...sheet,corporationID:readout.corporationID,balanceISK:readout.balanceISK,
  corporateWallet:null,characterAttributes:null,cloneGrade:null};
}
export async function readTrainingProgress(id:number,options:ApiOptions):Promise<TrainingSheet>{
 return (await inspectSkillSheet(id,options)).sheet;
}
export async function readTrainingSkillSheet(id:number,options:ApiOptions){
 const readCatalogue=async()=>{let catalog:{typeID:number;name:string;groupID:number;groupName:string;published:boolean}[]=[];let catalogUnavailable=true;
 try{const data=await trainingAdapterContext().authenticatedJson('/api/static/skill-catalogue',options);if(!Array.isArray(data?.skills)||data.skills.some((x:any)=>!positive(x?.typeID)||typeof x.name!=='string'||!x.name.trim()||!Number.isInteger(x.groupID)||typeof x.groupName!=='string'||typeof x.published!=='boolean')||new Set(data.skills.map((x:any)=>x.typeID)).size!==data.skills.length)throw Error('Skill catalogue is unreadable.');catalog=data.skills.filter((x:any)=>x.published);catalogUnavailable=false;}catch{/* Keep native skill sheet usable when static metadata is unavailable. */}
 return {catalog,catalogUnavailable};};
 const [sheet,catalogue]=await Promise.all([readTrainingProgress(id,options),readCatalogue()]);
 return {sheet,...catalogue};
}

export async function clearTrainingQueue(sheet:TrainingSheet,options:ApiOptions):Promise<TrainingSheet>{
 const result=await trainingAdapterContext().runHosted(sheet.characterID,'training',{clearQueue:queueIdentity(sheet.queue)},options);
 const observed=trainingSheetFromProof(result.readout,sheet.characterID);
 if(result.phase!=='Training queue cleared'||!observed||observed.queue.entries.length||observed.queue.active)
  throw Error(result.why??'Native readback did not verify that the training queue stopped.');
 return observed;
}
function skillReviewRecord(id:number,typeID:number,level:number,options:ApiOptions,kind:'queue'|'purchase',q:Awaited<ReturnType<typeof hullQuote>>,funding:FundingSetup={}){
 if(typeof options.token!=='string'||!options.token)throw Error('Authenticated pilot account is required.');
 const reviewID=crypto.randomUUID(),identity=skillReviewKey(q.corporationID,q.targets,q,Math.round(q.totalISK*100));
 skillReviews.set(reviewID,{characterID:id,typeID,level,token:options.token,kind,identity,totalISK:q.totalISK,funding,used:false});
 return reviewID;
}
export async function reviewIndependentSkill(id:number,typeID:number,level:number,options:ApiOptions):Promise<any>{
 const q=await hullQuote(id,typeID,options,level);if(!Number.isInteger(q.queue?.maxEntries)||q.queue.maxEntries<1||typeof q.queue.active!=='boolean'||!Array.isArray(q.queue.entries))throw Error('The native queue is unreadable.');
 const covered=new Map<number,number>(q.skills.map((s:any)=>[s.typeID,s.level]));for(const e of q.queue.entries){if(!positive(e.typeID)||!positive(e.toLevel)||e.toLevel!==(covered.get(e.typeID)??0)+1)throw Error('Existing queue order is not verifiable.');covered.set(e.typeID,e.toLevel);}
 const blockers=q.requirements.filter(x=>x.bookMissing).map(x=>({code:'SKILLBOOK_REQUIRED',message:`Skillbook required: ${x.name}`,typeID:x.typeID}));const additions:{typeID:number;name:string;toLevel:number}[]=[];for(const target of q.targets){if(target.toLevel>(covered.get(target.typeID)??0)){if(target.toLevel!==(covered.get(target.typeID)??0)+1)throw Error("Skill prerequisite order is not verifiable.");additions.push({typeID:target.typeID,name:`Skill ${target.typeID}`,toLevel:target.toLevel});covered.set(target.typeID,target.toLevel);}}
 if(q.queue.entries.length+additions.length>q.queue.maxEntries)blockers.push({code:'QUEUE_FULL',message:'The skill queue has insufficient capacity.',typeID:null as any});const canApply=blockers.length===0&&additions.length>0;return {reviewID:canApply?skillReviewRecord(id,typeID,level,options,'queue',q):null,expiresAt:0,canApply,existing:q.queue.entries,additions,blockers};
}
export async function reviewSkillAcquisition(body:unknown,options:ApiOptions):Promise<AcquisitionReview>{
 const b=body as any;
 if(!positive(b?.characterID)||!positive(b?.typeID)||!positive(b?.level)||b.level>5||b.independent!==true||!isTrainingFundingPolicy(b.policy))
  throw Error('Choose an exact pilot, skill and funding policy.');
 const q=await hullQuote(b.characterID,b.typeID,options,b.level,'purchase',b.policy);
 const fundingEstimate=trainingFundingEstimate(q,b.policy,b.trainingWallet);
 const skills=q.requirements.filter(x=>x.bookMissing).map(x=>({typeID:x.typeID,name:x.name,price:String(q.pricesByType[x.typeID])}));
 const canAcquire=skills.length>0&&fundingEstimate.reason===null;
 const reviewID=canAcquire?skillReviewRecord(b.characterID,b.typeID,b.level,options,'purchase',q,trainingFundingSetup(q,b.policy,b.trainingWallet)):null;
 return {reviewID,expiresAt:0,canAcquire,mode:'INDEPENDENT',stage:'SKILL',characterID:b.characterID,skills,
  total:String(q.totalISK),personalBalance:String(q.balanceISK??'Unavailable'),shortfall:String(fundingEstimate.shortfallISK??'Unavailable'),
  policy:b.policy,blockers:fundingEstimate.reason?[fundingEstimate.reason]:[],funding:null,fundingEstimate,cleanup:[]};
}
async function executeSkillReview(id:string,options:ApiOptions,kind:'queue'|'purchase'){
 const r=skillReviews.get(id);
 if(!r||r.used||r.token!==options.token||r.kind!==kind)throw Error('The skill review is unavailable or already dispatched.');
 r.used=true;
 const result=await trainingAdapterContext().runHosted(r.characterID,'training',{
  goalTypeID:r.typeID,maxSpendISK:kind==='purchase'?r.totalISK:0,skillLevel:r.level,
  skillAction:kind==='purchase'?'purchase-only':'queue-only',skillReviewKey:r.identity,...r.funding,
 },options);
 const readout=result.readout as any;
 if(kind==='purchase'?(result.phase!=='Skillbooks verified'||readout?.purchaseVerified!==true):(result.phase!=='Training queued'||readout?.queueVerified!==true))
  throw Error(result.why??'The original skill action needs reconciliation.');
 return {readout,sheet:trainingSheetFromProof(readout,r.characterID)};
}
export async function acquireFactorySkills(id:string,funding:FactoryFunding|null,options:ApiOptions):Promise<AcquisitionOutcome>{
 if(funding)throw Error('Independent skill purchases use the wallet selected during the review.');
 const {readout,sheet}=await executeSkillReview(id,options,'purchase');
 return {status:'ACQUIRED',verified:true,message:'Skillbooks were verified on the pilot.',mode:'INDEPENDENT',stage:'SKILL',
  at:Date.now(),purchased:readout.purchased,cleanup:[],fresh:null,sheet};
}
export async function applyTrainingQueue(id:string,options:ApiOptions):Promise<QueueApplyOutcome>{
 const {sheet}=await executeSkillReview(id,options,'queue');
 return {status:'APPLIED',verified:true,mode:'FAST',stage:'SKILL',at:Date.now(),added:null,attemptedAdditions:0,code:null,message:'The native training queue was verified.',fresh:null,queue:sheet?.queue??null,sheet};
}



async function expandedGoals(types:number[],goals:SkillGoal[],options:ApiOptions){
 const all=[...new Set([...types,...goals.map(g=>g.typeID)])],required:Record<string,unknown>={},api=trainingAdapterContext().authenticatedJson;
 for(let at=0;at<all.length;at+=50){const r=await api(`/api/client-data/required-skills?typeIDs=${all.slice(at,at+50).join(',')}`,options);if(r.available!==true)throw Error('Native prerequisites are unavailable.');Object.assign(required,r.required);}
 return trainingPlanTargets(types,required,goals);
}
async function planOutcome(quote:Pick<Awaited<ReturnType<typeof quoteTrainingTargets>>,
 'requirements'|'totalISK'|'pricesByType'|'queue'|'skills'|'balanceISK'|'corporateWallet'|'characterAttributes'|'cloneGrade'|'corporationID'>,
 options:ApiOptions,policy:FundingPolicy,wallet?:TrainingWallet|null):Promise<TrainingGoalOutcome>{
 const requirements=quote.requirements,api=trainingAdapterContext().authenticatedJson;
 try{const names=await api('/api/names',options,{items:requirements.map(r=>({kind:'type',id:r.typeID}))});for(const r of requirements)r.name=names.names?.[`type:${r.typeID}`]??r.name;}catch{}
 const targets=requirements.map(r=>{
  const queuedLevel=Math.max(0,...quote.queue.entries.filter((e:any)=>e.typeID===r.typeID).map((e:any)=>e.toLevel));
  const head=quote.queue.entries[0];
  r.reviewState=r.currentLevel>=r.level?'TRAINED':queuedLevel>=r.level?quote.queue.active&&head?.typeID===r.typeID&&head.toLevel>=r.level?'TRAINING':'ALREADY_QUEUED':'MISSING';
  if(queuedLevel)r.queuedLevel=queuedLevel;
  const bookCost=quote.pricesByType[r.typeID];
  if(bookCost!==undefined)r.bookCostISK=bookCost;
  return {...r,queuedLevel};
 });
 const uncovered=targets.filter(r=>r.level>Math.max(r.queuedLevel,r.currentLevel)).map(r=>r.typeID);
 let metadata:Record<number,Record<number,number>>={};
 if(uncovered.length)try{
  for(let at=0;at<uncovered.length;at+=500){
   const reply=await api('/api/types/dogma',options,{typeIDs:uncovered.slice(at,at+500),attributeIDs:[275,180,181]});
   Object.assign(metadata,reply.attributes);
  }
 }catch{/* Per-skill missing native data is reported by the estimate. */}
 return {phase:'PREVIEW',requirements,requirementsUnavailable:false,totalISK:String(quote.totalISK),estimatedCost:true,queue:quote.queue,
  fundingEstimate:trainingFundingEstimate(quote,policy,wallet),
  ...estimateAdditionalTraining(targets,quote.skills,quote.cloneGrade,quote.characterAttributes??{},metadata)};
}
async function readFittingDogma(ids: number[], options: ApiOptions): Promise<FittingDogma> {
 const api=trainingAdapterContext().authenticatedJson, result:FittingDogma={types:{},effects:{}};
 for(let at=0;at<ids.length;at+=50){
  const native=await api(`/api/client-data/dogma-types?typeIDs=${ids.slice(at,at+50).join(',')}`,options);
  if(native.available!==true||!native.types||!native.effects)throw Error('Effective fitting Dogma is unavailable.');
  Object.assign(result.types,native.types);
  Object.assign(result.effects,native.effects);
 }
 return result;
}
async function fittingDepthQuote(fit:any,prior:any,depth:PlanDepth|'MASTERY',excluded:number[],options:ApiOptions,policy:FundingPolicy,wallet?:TrainingWallet|null){
 if((depth!=='MASTERY'&&!FITTING_TIERS.includes(depth))||!Array.isArray(fit.prerequisites))throw Error('Inspect the selected fitting requirements.');
 const hard:{typeID:number;toLevel:number}[]=fit.prerequisites;
 let recommendations:Recommendation[]=[], skillGoals:SkillGoal[]=[];
 if(depth==='MASTERY'){
  const native=await readFittingDogma([fit.goalTypeID],options), attributes=native.types[fit.goalTypeID]?.attributes;
  if(!attributes)throw Error('The selected hull support attributes are unavailable.');
  skillGoals=legacyMasteryGoals(hard,attributes);
 } else if(depth!=='FAST'){
  const items:FittingItem[]=fit.items;
  if(!Array.isArray(items)||!items.length||items.some(i=>!Array.isArray(i)||i.length!==3||!i.every(positive)))throw Error('The selected fitting equipment could not be verified.');
  const ids=[...new Set([fit.goalTypeID,...items.filter(i=>i[1]!==5).map(i=>i[0])])], native=await readFittingDogma(ids,options);
  if(ids.some(id=>!native.types[id]||!Array.isArray(native.types[id]!.effects)||!Array.isArray(native.types[id]!.requiredSkills)||!Array.isArray(native.types[id]!.attributes)))
   throw Error('The selected fitting contains equipment without effective Dogma metadata.');
  const hullSkills=haulingSkillCandidates(fit.goalTypeID,native).filter(id=>!Object.hasOwn(native.types,id));
  if(hullSkills.length){
   const skillDogma=await readFittingDogma(hullSkills,options);
   Object.assign(native.types,skillDogma.types);Object.assign(native.effects,skillDogma.effects);
  }
  recommendations=recommendFittingSkills(fit.goalTypeID,items,hard,depth,native);
 }
 if(!Array.isArray(excluded)||new Set(excluded).size!==excluded.length||excluded.some(id=>!recommendations.some(r=>r.typeID===id)))
  throw Error('The optional fitting recommendations changed. Review the fitting again.');
 const ignored=new Set(excluded);
 if(depth!=='MASTERY')skillGoals=recommendations.filter(r=>!ignored.has(r.typeID)).map(({typeID,level})=>({typeID,level}));
 const targets=skillGoals.length?await expandedGoals([],skillGoals,options):[];
 const quote=await quoteTrainingTargets([...hard,...targets],prior,options,depth!=='MASTERY');
 const outcome=await planOutcome(quote,options,policy,wallet);
 const floors=new Map<number,number>();
 for(const {typeID,toLevel} of hard)floors.set(typeID,Math.max(floors.get(typeID)??0,toLevel));
 for(const row of outcome.requirements)row.mandatoryLevel=floors.get(row.typeID)??0;
 if(quote.unpriced.length){
  const books=outcome.requirements.filter(r=>quote.unpriced.includes(r.typeID)).map(r=>r.name);
  outcome.blockers=[`No direct purchase quote for ${books.join(', ')}. Remove optional goals requiring those books or inject them first.`];
  delete outcome.totalISK;
  delete outcome.fundingEstimate;
 }
 if(quote.missingCount>32)(outcome.blockers??=[]).push('The hosted purchase can cover 32 skillbooks in one reviewed plan. Remove optional goals or inject some books first.');
 if(recommendations.length){
  const names=await trainingAdapterContext().authenticatedJson('/api/names',options,{items:recommendations.map(r=>({kind:'type',id:r.typeID}))});
  const known=new Set(prior.skills.map((s:{typeID:number})=>s.typeID));
  const extraPrices=await directBookPrices(recommendations.filter(r=>!known.has(r.typeID)&&quote.pricesByType[r.typeID]===undefined).map(r=>r.typeID),options);
  outcome.recommendations=recommendations.map(r=>({...r,name:names.names?.[`type:${r.typeID}`]??`Skill ${r.typeID}`,
   enabled:!ignored.has(r.typeID),bookNeeded:!known.has(r.typeID),bookCostISK:known.has(r.typeID)?0:quote.pricesByType[r.typeID]??extraPrices[r.typeID]??null}));
 }
 outcome.reviewKey=JSON.stringify([prior.characterID,fit.corporationID,fit.fittingID,fit.fingerprint,depth,skillGoals,policy,wallet,quote.totalISK,outcome.fundingEstimate,
  outcome.requirements.map(r=>[r.typeID,r.level]).sort((a,b)=>a[0]!-b[0]!)]);
 return {...quote,skillGoals,outcome};
}
export async function reviewShipMastery(characterID:number,shipTypeID:number,level:number,options:ApiOptions,policy:FundingPolicy='CHARACTER_WALLET_ONLY',wallet?:TrainingWallet|null){
 const data=await trainingAdapterContext().authenticatedJson(`/api/client-data/ship-mastery?typeID=${shipTypeID}`,options);
 if(data.available!==true)throw Error(data.reason??'Native Ship Mastery definitions are unavailable.');
 const profile=data.levels.find((r:any)=>r.level===level);if(!profile||!Array.isArray(profile.skillGoals))throw Error('Select a native Mastery level I–V.');
 const prior=await inspect(characterID,options),targets=await expandedGoals([shipTypeID],profile.skillGoals,options),quote=await quoteTrainingTargets(targets,prior,options);
 return {characterID,shipTypeID,level,corporationID:prior.corporationID,source:data.source,definitionTypeID:data.definitionTypeID,certificates:profile.certificates,skillGoals:profile.skillGoals as SkillGoal[],totalISK:quote.totalISK,policy,wallet,outcome:await planOutcome(quote,options,policy,wallet)};
}
export async function applyShipMastery(review:Awaited<ReturnType<typeof reviewShipMastery>>,options:ApiOptions){
 const data=await trainingAdapterContext().authenticatedJson(`/api/client-data/ship-mastery?typeID=${review.shipTypeID}`,options),profile=data.levels?.find((r:any)=>r.level===review.level);
 if(data.available!==true||JSON.stringify(profile?.skillGoals)!==JSON.stringify(review.skillGoals))throw Error('The native Mastery definition changed. Review again.');
 const result=await trainingAdapterContext().runHosted(review.characterID,'training',{goalTypeID:review.shipTypeID,maxSpendISK:review.totalISK,skillGoals:review.skillGoals,...trainingFundingSetup(review,review.policy,review.wallet)},options);
 if(result.phase!=='Training queued'||(result.readout as any)?.queueVerified!==true)throw Error(result.why??'The native queue is not verified.');
 return verifiedTrainingOutcome(result.readout,review.outcome.requirements,review.totalISK);
}
