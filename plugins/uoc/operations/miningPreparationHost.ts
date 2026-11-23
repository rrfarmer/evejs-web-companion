import {preparationEvidenceKey,retainPreparation} from './miningEvidence.ts';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pluginDataDir,type BackendRun,type PluginRunContext,type PluginRunReport} from '../../../web/src/plugin-api/backend.ts';
import {isPlayerCorporation} from '../../../web/src/plugin-api/index.ts';
import {miningSupplySourceLabel,type MiningSupplySource} from '../restored/mining/miningPreparation.ts';

type Document={read():any;write(value:unknown):void};
export type MiningPreparation={source:MiningSupplySource;providerCharacterID?:number;fittingID?:number;suppliesRequired:boolean;replenishSupplies?:boolean;supplies?:readonly {typeID:number;target:number;mode:'TOTAL_ABOARD'|'CARRIED_SPARES';eligibleFlags:readonly number[];required:boolean}[]};
type Setup={operationID:string;operationRunID:string;role:string;preparation:MiningPreparation;coreRequired?:boolean;reviewOnly?:boolean;verifyEquipment?:boolean};
type Documents={document?:(run:PluginRunContext,world:string)=>Document;evidenceDocument?:(run:PluginRunContext,world:string)=>Document};
const require=createRequire(import.meta.url),{createDocumentStore}=require('../documentStore.cjs');
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function decodeMiningPreparation(value:unknown):Setup|null {
 if(!object(value)||value.reviewOnly!==undefined&&typeof value.reviewOnly!=='boolean'||value.verifyEquipment!==undefined&&typeof value.verifyEquipment!=='boolean'||typeof value.operationID!=='string'||!value.operationID||typeof value.operationRunID!=='string'||!value.operationRunID||!['MINER','HAULER','COMMAND','DEFENDER','COMBAT'].includes(value.role)||!object(value.preparation))return null;
 const p=value.preparation,s=p.source;
 if(!object(s)||!['hangar','corp'].includes(s.kind)||s.kind==='corp'&&(s.corporationID!==undefined&&!positive(s.corporationID)||!positive(s.division)||s.division>7)||typeof p.suppliesRequired!=='boolean'||p.replenishSupplies!==undefined&&typeof p.replenishSupplies!=='boolean'||p.fittingID!==undefined&&!positive(p.fittingID)||p.providerCharacterID!==undefined&&!positive(p.providerCharacterID)||p.supplies!==undefined&&(!Array.isArray(p.supplies)||p.supplies.some((x:any)=>!object(x)||!positive(x.typeID)||!positive(x.target)||!['TOTAL_ABOARD','CARRIED_SPARES'].includes(x.mode)||!Array.isArray(x.eligibleFlags)||!x.eligibleFlags.length||x.eligibleFlags.some((f:unknown)=>![5,133,143].includes(Number(f)))||typeof x.required!=='boolean')))return null;
 return structuredClone(value) as Setup;
}
const policyKey=(x:any)=>JSON.stringify([x.typeID,x.target,x.mode,[...x.eligibleFlags].sort((a:number,b:number)=>a-b),x.required===true]);

function corporateStockWarning(read: {reason:string|null;code?:string}, sourceLabel:string) {
 const reason = read.code === "NO_CORP_OFFICE" ? "The corporation has no office at the pilot's preparation station." :
  read.code === "CORPORATION_QUERY_DENIED" ? "This pilot lacks Query access at the preparation station." :
  read.code === "CORPORATION_ACCESS_UNKNOWN" ? "The pilot's Query and Take rights could not be verified." :
  read.code === "CORPORATION_SOURCE_CHANGED" ? "The pilot's corporation differs from the selected supply corporation." :
  read.reason ?? "The selected source could not be inspected.";
 return sourceLabel + ": " + reason;
}

function stockShortages(review:any, sourceLabel:string):string | null {
 if (!Array.isArray(review.source?.available)) return null;
 const missing = review.status.targets.flatMap((target:any) => {
  if (!(target.deficit > 0)) return [];
  const available = review.source.available.find((row:any) => row.typeID === target.typeID)?.quantity;
  return Number.isSafeInteger(available) && available >= 0 && available < target.deficit
   ? [`${target.name ?? "Type " + target.typeID}: ${available} available, ${target.deficit} needed`] : [];
 });
 return missing.length ? sourceLabel + " is short of supplies (" + missing.join(", ") + ")." : null;
}

/** Validate equipment and replenish supplies on the pilot already held by Bot Host. */
async function miningPreparationTask(run:PluginRunContext,setup:Setup,deps:Documents,held?:{shipID:number;current:()=>void;stopRequested:()=>boolean}){
  let active=true,stopping=false;
  const current=()=>{if(!active)throw Error('Mining preparation session ended.');held?.current();};
  const json=async(url:string,body?:unknown)=>{current();const response=await run.fetch(new URL(url,run.baseUrl),body===undefined?undefined:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json();current();if(!response.ok||result?.ok!==true)throw Object.assign(Error(result?.message??result?.error??'Mining preparation read failed.'),{code:result?.error,status:response.status});return result;};
  const world=(await json('/api/plugins/uoc/world')).worldID;if(typeof world!=='string'||!world)throw Error('Mining preparation world is unavailable.');
  const db=deps.document?null:createDocumentStore(path.join(pluginDataDir(),'mining-preparation.sqlite'));
  const document:Document=deps.document?.(run,world)??db.document(`member:${world}:${run.characterID}`);
  const pending=document.read();if(pending!==null&&(!object(pending)||pending.characterID!==run.characterID||pending.world!==world||!['COMPLETE','PENDING'].includes(pending.phase)))throw Error('The retained preparation record is unreadable.');
  const save=(v:unknown)=>{current();document.write(v);};
  const strict=setup.role==='COMBAT'&&setup.verifyEquipment===true;
  const sourceLabel=miningSupplySourceLabel(setup.preparation.source);
  const report=(detail:Record<string,unknown>):PluginRunReport=>{
   const readout={role:setup.role,characterID:run.characterID,operationID:setup.operationID,operationRunID:setup.operationRunID,observedAt:Date.now(),...detail};
   try{const evidence=deps.evidenceDocument?.(run,world)??db?.document(preparationEvidenceKey(world,setup.operationID,setup.operationRunID,run.characterID));if(evidence)retainPreparation(evidence,world,run.botID,readout);}catch{/* Display evidence never grants inventory authority. */}
   return {status:'stopped',phase:'Mining member prepared',readout:readout as any};
  };
  const warn=(reason:string,detail:Record<string,unknown>={})=>{
   if(strict)throw Error(reason);
   return report({state:'DEGRADED',equipment:'UNKNOWN',supplies:'UNKNOWN',targets:[],sourceLabel,
    ...(held?{shipID:held.shipID}:{}),...detail,reason});
  };
  const optionalRead=async(url:string,body?:unknown)=>{
   try{return {result:await json(url,body),reason:null};}catch(error){
    current();
    const {status,code}=(error??{}) as {status?:number;code?:string};
    if(strict||status===401||/SESSION|OWNER|CUSTODY|PENDING|UNRESOLVED|CONTEXT_CHANGED/.test(code??''))throw error;
    return {result:null,reason:error instanceof Error?error.message:String(error),code};
   }
  };
  const work=(async()=>{
   if(pending?.phase==='PENDING'){
    const receipt=await json('/api/bridge/provisioning/reconcile',{operationID:pending.reviewID});
    if(!['COMPLETE','RECONCILED'].includes(receipt.state))throw Error(`PREPARATION_UNRESOLVED: ${String(receipt.state)}; the original inventory action was not repeated.`);
    save({...pending,phase:'COMPLETE',receipt,reconciledAt:Date.now()});
   }
   if(held?.stopRequested())return {status:'stopped',phase:'Mining preparation settled'} as const;
   const p=setup.preparation,fittingID=p.fittingID,provider=p.providerCharacterID??run.characterID;
   if(!fittingID){
    if(strict)throw Error('Select a saved fitting for verification.');
    return report({state:'VERIFIED',equipment:'AS IS',supplies:'NOT APPLICABLE',targets:[],reason:null});
   }
   if(p.source.kind==='corp'&&!p.source.corporationID&&p.replenishSupplies===true&&!setup.reviewOnly)
    return warn(sourceLabel+": No shared player corporation was verified for the pilots with selected fittings.");
   const {result:options,reason:optionsError}=await optionalRead(`/api/bridge/provisioning/options?providerCharacterID=${provider}`);
   if(!options)return warn(`Saved fitting inspection is unavailable: ${optionsError}`);
   if(!Array.isArray(options.pending)||options.pending.length)throw Error('The current inventory custody is unresolved or unreadable.');
   if(options.providerCharacterID!==provider)throw Error('The fitting provider identity changed.');
   if(options.definitionStatus!=='READY'||!positive(options.definitionCorporationID)||!Array.isArray(options.fittings))return warn(`The saved fitting library is unavailable (${options.definitionStatus??'unknown status'}).`);
   const matches=options.fittings.filter((x:any)=>x.fittingID===fittingID&&!x.invalid);
   if(matches.length!==1)return warn(matches.length?'The selected saved fitting is ambiguous.':'The selected saved fitting is unavailable.');
   let source=p.source;
   if(source.kind==='corp'){
    const corporationID=source.corporationID??options.corporationID;
    if(!isPlayerCorporation(corporationID))return warn(sourceLabel+": The pilot's player corporation could not be verified.");
    if(options.corporationID!==corporationID)return warn(sourceLabel+": The pilot belongs to a different corporation from the selected supply source.");
    source={...source,corporationID};
   }
   const input={providerCharacterID:provider,corporationID:options.definitionCorporationID,fittingID,source,
    supplyPolicy:{fittedMinimum:true,fittingDronesAsSupplies:p.replenishSupplies===true,supplies:(p.supplies??[]).map(t=>({...t,required:false}))}};
   const review=await optionalRead('/api/bridge/provisioning/review',input);
   let r=review.result;
   if(!r)return warn(source.kind==='corp'?corporateStockWarning(review,sourceLabel):`Equipment inspection is unavailable: ${review.reason}`);
   if(Array.isArray(r.pending)&&r.pending.length)throw Error('The current inventory custody is unresolved.');
   if(r.context&&r.context.characterID!==run.characterID||r.contract?.definition&&
      (r.contract.definition.characterID!==provider||r.contract.definition.fittingID!==fittingID))throw Error('The equipment review returned a different pilot or fitting identity.');
   const originalShipID=r.context?.shipID,definitionFingerprint=r.contract?.definitionFingerprint;
   if(!positive(originalShipID)||!r.contract?.definition||!Array.isArray(r.status?.targets))return warn('The native equipment read did not return a verifiable fitting comparison.');
   if(held&&originalShipID!==held.shipID)throw Error('The active ship changed before equipment preparation.');
   let sourceWarning:string|null=null;
   if(source.kind==='corp'){
    const pin=r.source?.pin;
    if(pin?.descriptor?.kind!=='corp'||pin.descriptor.division!==source.division||
       pin.descriptor.corporationID!==source.corporationID||pin.ownerID!==source.corporationID||
       !positive(r.context.locationID)||pin.dockedLocationID!==r.context.locationID||typeof pin.office!=='string'||!pin.office)
     return warn(sourceLabel+": The reviewed office or division does not match the selected local source.",{shipID:originalShipID});
    if(r.source.access?.query!==true)sourceWarning=sourceLabel+": Query access is unavailable at the preparation station.";
    else if(r.source.access.take!==true)sourceWarning=sourceLabel+": Take access is unavailable at the preparation station.";
   }
   if(r.status.equipment!=='VERIFIED'){
    const mismatch=r.status.equipment==='MODIFIED';
    return warn([mismatch?'Current equipment differs from the selected fitting.':'The native equipment read did not verify the selected fitting.',sourceWarning].filter(Boolean).join(' '),
     {shipID:originalShipID,equipment:mismatch?'MODIFIED':'UNKNOWN',fittingName:r.contract.name??null,supplies:r.status.supplies??'UNKNOWN',targets:r.status.targets});
   }
   if(strict&&(typeof definitionFingerprint!=='string'||!definitionFingerprint))throw Error('The selected fitting fingerprint is unavailable.');
   if(p.supplies?.some(t=>!r.contract.supplies?.some((actual:any)=>policyKey(actual)===policyKey({...t,required:false})))){
    if(strict)throw Error('The public review API did not retain the configured supply targets.');
    sourceWarning=sourceWarning??'The public fitting review did not confirm the configured extra supply targets.';
   }
   const sourceAvailable=sourceWarning===null&&typeof r.reviewID==='string'&&typeof r.reviewHash==='string';
   if(!setup.reviewOnly&&sourceAvailable&&p.replenishSupplies===true&&r.canApply===true&&r.status.targets.some((x:any)=>x.deficit>0)){
    if(stopping||held?.stopRequested())throw Error('Preparation stopped before inventory dispatch.');
    save({version:1,phase:'PENDING',world,characterID:run.characterID,setup,reviewID:r.reviewID,reviewHash:r.reviewHash,input,shipID:originalShipID,issuedAt:Date.now()});
    let receipt:any;try{receipt=await json('/api/bridge/provisioning/replenish',{reviewID:r.reviewID,reviewHash:r.reviewHash,confirm:true});}catch{/* A lost response is reconciled, never repeated. */}
    if(!receipt||!['COMPLETE','RECONCILED'].includes(receipt.state))receipt=await json('/api/bridge/provisioning/reconcile',{operationID:r.reviewID});
    if(!['COMPLETE','RECONCILED'].includes(receipt.state))throw Error(`PREPARATION_UNRESOLVED: ${String(receipt.state)}; no replenishment replay.`);
    save({version:1,phase:'COMPLETE',world,characterID:run.characterID,setup,receipt,verifiedAt:Date.now()});
    const post=await optionalRead('/api/bridge/provisioning/review',input);
    if(!post.result)return warn(`Replenishment receipt settled; the follow-up equipment inspection is unavailable: ${post.reason}`,{shipID:originalShipID});
    r=post.result;
   }
   if(r.context?.characterID!==run.characterID||r.context?.shipID!==originalShipID)throw Error('The pilot or ship changed during preparation.');
   if(r.status?.equipment!=='VERIFIED'||strict&&r.contract?.definitionFingerprint!==definitionFingerprint||!Array.isArray(r.status?.targets))
    return warn('Physical equipment or supply readback could not be verified.',{shipID:originalShipID,fittingName:r.contract?.name??null});
   const short=r.status.targets.some((t:any)=>t.deficit>0)||['LOW','MISSING'].includes(r.status.supplies);
   const notes=[sourceWarning,p.replenishSupplies===true?stockShortages(r,sourceLabel):null,
    !strict&&r.status.equipmentMatch?'The fitting requirements are present with additional modules or rigs.':null,
    r.status.supplies==='UNKNOWN'?'Optional consumable supply is unverified; departure is permitted.':short?'Optional consumable reserves are below target; departure is permitted.':null].filter(Boolean);
   return report({shipID:originalShipID,definitionFingerprint,fittingID:r.contract?.definition?.fittingID,providerCharacterID:provider,state:notes.length?'DEGRADED':'VERIFIED',
    equipment:r.status.equipment,supplies:r.status.supplies,targets:r.status.targets,fittingName:r.contract?.name??null,source:r.source??null,sourceLabel,context:r.context,reason:notes.join(' ')||null});
  })().catch((error):PluginRunReport=>{const pending=document.read()?.phase==='PENDING';
   return {status:pending?'paused':'error',phase:pending?'Preparation unresolved':'Preparation blocked',why:error instanceof Error?error.message:String(error),readout:{characterID:run.characterID,operationID:setup.operationID,operationRunID:setup.operationRunID,pending} as any};});
  return {work,async stop(){stopping=true;try{await work;}finally{active=false;db?.close();}}};
}
export function createMiningPreparationRun(deps:Documents={}):BackendRun {
 return {check(value){const setup=decodeMiningPreparation(value);return setup?{ok:true,setup:setup as any,name:'Prepare mining member',policy:{riskClasses:['inventory'],restartSafe:false}}:{ok:false,refusal:'Choose an exact mining member preparation policy.'};},async start(run){
  const setup=decodeMiningPreparation(run.setup);
  if(!setup||run.resumed||run.held.characterID!==run.characterID)throw Error('Mining preparation owner is unavailable.');
  const task=await miningPreparationTask(run,setup,deps);
  void task.work.then(result=>run.report(result));
  return {stop:task.stop};
 }};
}
export async function prepareHeldMiningMember(run:PluginRunContext,setup:Setup,held:{shipID:number;current:()=>void;stopRequested:()=>boolean}){
 const task=await miningPreparationTask(run,setup,{},held);
 try{return await task.work;}finally{await task.stop();}
}
export const miningPreparationRun=createMiningPreparationRun();
