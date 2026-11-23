import {createHash} from "node:crypto";
import {type BackendRun,type PluginRunContext} from "../../../web/src/plugin-api/backend.ts";
import type {JsonValue} from "../../../web/src/plugin-api/index.ts";
import {trainingTargets} from "../shared/trainingTargets.ts";
import {createPilotSession} from "../../../web/src/plugin-api/pilotSession.ts";
import {loadFitting,buildSlots,slotFlagOf} from "../../../web/src/plugin-api/flying.ts";
import {simulatePilotResources,decodeNativeFittingResources,nativeApplyBlockers,type ResourceQualification} from "./resourceQualification.ts";
import {decodeModuleObservation} from "../shared/moduleObservation.ts";
import {reviewPreviousShipStorage,storePreviousShip} from "./previousShip.ts";
import {applyExistingHull,reviewExistingHull,verifyPersonalHull,type ExistingHull} from "./existingHull.ts";

type Setup={corporationID:number;fittingID:number;goalTypeID:number;fingerprint:string;division:number;providerCharacterID?:number;sourceCorporationID?:number;sourceKind?:"hangar"|"corp";reviewedPlanFingerprint?:string;savedFittingSupplies?:true;hullItemID?:number;oldShipDivision?:number};
const positive=(x:unknown):x is number=>typeof x==="number"&&Number.isSafeInteger(x)&&x>0;
const object=(x:unknown):x is Record<string,any>=>!!x&&typeof x==="object"&&!Array.isArray(x);
function setupOf(value:unknown,mode:"inspect"|"apply"):Setup|null {
 if(!object(value)||Object.keys(value).some(k=>!["corporationID","division","fingerprint","fittingID","goalTypeID","reviewedPlanFingerprint","sourceKind","providerCharacterID","sourceCorporationID","savedFittingSupplies","hullItemID","oldShipDivision"].includes(k))|| (value.sourceKind!==undefined&&! ["hangar","corp"].includes(value.sourceKind)) || (value.providerCharacterID!==undefined&&!positive(value.providerCharacterID)) || (value.sourceCorporationID!==undefined&&!positive(value.sourceCorporationID)) || (mode==="inspect"&&value.reviewedPlanFingerprint!==undefined)||
 (value.hullItemID!==undefined&&!positive(value.hullItemID))||
 (value.oldShipDivision!==undefined&&(!positive(value.oldShipDivision)||value.oldShipDivision>7))||
 (value.savedFittingSupplies!==undefined&&value.savedFittingSupplies!==true)||
 !positive(value.corporationID)||!positive(value.fittingID)||!positive(value.goalTypeID)||!positive(value.division)||value.division>7||
 typeof value.fingerprint!=="string"||!/^[a-f0-9]{64}$/.test(value.fingerprint)||
 (mode==="apply"&&(typeof value.reviewedPlanFingerprint!=="string"||!/^[a-f0-9]{64}$/.test(value.reviewedPlanFingerprint))))return null;
 return {...(value.hullItemID?{hullItemID:value.hullItemID}:{}),...(value.oldShipDivision?{oldShipDivision:value.oldShipDivision}:{}),corporationID:value.corporationID,fittingID:value.fittingID,goalTypeID:value.goalTypeID,fingerprint:value.fingerprint,division:value.division,...(value.providerCharacterID!==undefined?{providerCharacterID:value.providerCharacterID}:{}),...(value.sourceCorporationID!==undefined?{sourceCorporationID:value.sourceCorporationID}:{}),...(value.sourceKind!==undefined?{sourceKind:value.sourceKind}:{}),...(value.savedFittingSupplies===true?{savedFittingSupplies:true}:{}),...(mode==="apply"?{reviewedPlanFingerprint:value.reviewedPlanFingerprint}:{})};
}

/** Hash only stable, operator-reviewed physical inputs; session review handles never enter it. */
export function reviewedPlanFingerprint(r:any,storage?:{officeID:number;division:number}|null,existing?:ExistingHull|null):string {
 const pin=r?.source?.pin,plan=r?.plan;
 if(!positive(r?.context?.characterID)||!positive(r?.context?.shipID)||!positive(r?.context?.locationID)||
    !positive(pin?.ownerID)||!(pin?.locationID===null||positive(pin?.locationID))||!Number.isSafeInteger(pin?.flag)||!object(pin?.descriptor)||!(typeof pin?.office==="string"||(pin?.descriptor?.kind==="hangar"&&pin?.office===null))||
    !Array.isArray(r?.source?.rows)||!Array.isArray(plan?.requirements)||!Array.isArray(plan?.supplies)||!Array.isArray(plan?.optionalSavedCargo)||
    !Array.isArray(plan?.destructiveActions)||typeof plan?.mode!=="string"||!positive(plan?.targetHullTypeID)||!Number.isSafeInteger(plan?.hullQuantity)||
    !(plan?.hullSourceItemID===null||positive(plan?.hullSourceItemID))||!(plan?.targetHullID===null||positive(plan?.targetHullID))||
    typeof r?.contract?.definition?.fingerprint!=="string")throw Error("Physical provisioning plan is incomplete.");
 const normalize=(value:any):any=>Array.isArray(value)?value.map(normalize):object(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,normalize(value[k])])):value;
 const rows=r.source.rows.map((row:any)=>{
   if(!positive(row.itemID)||!positive(row.typeID)||!positive(row.ownerID)||!positive(row.locationID)||!Number.isSafeInteger(row.flagID)||!positive(row.quantity)||typeof row.singleton!=="boolean")throw Error("Physical provisioning source is incomplete.");
   return [row.itemID,row.typeID,row.ownerID,row.locationID,row.flagID,row.quantity,row.singleton];
 }).sort((a:any[],b:any[])=>a[0]-b[0]);
 if(new Set(rows.map((row:any[])=>row[0])).size!==rows.length)throw Error("Physical provisioning source is ambiguous.");
 const stable={characterID:r.context.characterID,shipID:r.context.shipID,locationID:r.context.locationID,fitFingerprint:r.contract.definition.fingerprint,fitProvider:r.contract.definition.characterID,fitCorporation:r.contract.definition.corporationID,
  source:{descriptor:pin.descriptor,ownerID:pin.ownerID,locationID:pin.locationID,flag:pin.flag,office:pin.office,dockedLocationID:pin.dockedLocationID??null,rows},
  ...(storage?{previousShipStorage:{officeID:storage.officeID,division:storage.division}}:{}),
  ...(existing?{existing}:{}),
  plan:{mode:plan.mode,targetHullTypeID:plan.targetHullTypeID,targetHullID:plan.targetHullID,hullQuantity:plan.hullQuantity,hullSourceItemID:plan.hullSourceItemID,
   requirements:plan.requirements,candidateEquipment:plan.candidateEquipment??null,oldShipDestination:plan.oldShipDestination??null,oldShipContents:plan.oldShipContents??null,supplies:plan.supplies,optionalSavedCargo:plan.optionalSavedCargo,destructiveActions:plan.destructiveActions,
   ...(Array.isArray(r.contract.charges)?{charges:r.contract.charges}:{})}};
 return createHash("sha256").update(JSON.stringify(normalize(stable))).digest("hex");
}

// The full native snapshot remains the input to the review hash and executor.
function reviewPresentation(r:any) {
 const {candidateEquipment,oldShipContents,hullCandidates=[],optionalSavedCargo,...plan}=r.plan;
 const rows=r.source.rows;
 const types=new Set<number>([plan.targetHullTypeID,...plan.requirements.map((row:any)=>row.typeID)]);
 const quantities:Record<number,number>={},packagedQuantity=rows.reduce((total:number,row:any)=>{
  if(types.has(row.typeID))quantities[row.typeID]=(quantities[row.typeID]??0)+row.quantity;
  return total+(row.typeID===plan.targetHullTypeID&&!row.singleton?row.quantity:0);
 },0);
 const visibleHulls=hullCandidates.filter((h:any)=>h.itemID===plan.targetHullID);
 for(const hull of hullCandidates)if(visibleHulls.length<24&&!visibleHulls.includes(hull))visibleHulls.push(hull);
 return {
  plan:{...plan,hullCandidates:visibleHulls,hullCandidateCount:hullCandidates.length},
  sourceRead:{pin:r.source.pin,access:r.source.access,rows:rows.slice(0,12),rowCount:rows.length,quantities,packagedQuantity},
  rawReview:{reviewID:r.reviewID,context:{shipID:r.context.shipID},candidateEquipmentCount:candidateEquipment?.length??null,oldShipContentsCount:oldShipContents?.length??null,optionalSavedCargoCount:optionalSavedCargo?.length??null},
 };
}

function receiptPresentation(receipt:any) {
 const {originalShipID,targetHullID}=receipt.manifest;
 return {operationID:receipt.operationID,state:receipt.state,result:{equipment:receipt.result.equipment},
  manifest:{originalShipID,targetHullID}};
}

/** One selected pilot, one exact corporation fitting, one existing local stock source. */
export function createProvisioningRun(mode:"inspect"|"apply",
 deps:{projection?:(run:PluginRunContext,review:any)=>Promise<ResourceQualification>}={}):BackendRun {
 return {
  check(input){const setup=setupOf(input,mode==="inspect"?"inspect":"apply");return setup?{ok:true,setup:setup as unknown as JsonValue,name:mode==="inspect"?"Inspect ship provision":"Provision ship",policy:{riskClasses:mode==="inspect"?[]:["inventory"],restartSafe:false}}:{ok:false,refusal:"Choose one exact corporation fitting and stock division."};},
  async start(run:PluginRunContext){
   const setup=setupOf(run.setup,mode==="inspect"?"inspect":"apply");if(!setup||run.resumed||!positive(run.characterID)||run.held.characterID!==run.characterID)throw Error("Provisioning pilot or selection changed.");
   let active=true,stopping=false;
   const current=()=>{if(!active)throw Error("Provisioning owner ended.");};
   const json=async(route:string,body?:unknown)=>{
    current();const response=await run.fetch(`${run.baseUrl}${route}`,body===undefined?undefined:{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const data=await response.json() as any;current();if(!response.ok||data?.ok!==true)throw Error(data?.message||data?.error||"Provisioning read failed.");return data;
   };
   const ask=async(service:string,method:string,args:unknown[]=[]) => (await json("/api/bridge/call",{service,method,args,kwargs:null,pilot:true})).result;
   const provider=setup.providerCharacterID??run.characterID,sourceCorp=setup.sourceCorporationID??setup.corporationID;
   const input={providerCharacterID:provider,corporationID:setup.corporationID,fittingID:setup.fittingID,source:setup.sourceKind==="hangar"?{kind:"hangar"}:{kind:"corp",corporationID:sourceCorp,division:setup.division},
    ...(setup.savedFittingSupplies===true?{supplyPolicy:{supplies:[],savedFittingSupplies:true}}:{})};
   const verifyReview=(r:any)=>{
    const context=r.context,definition=r.contract?.definition,pin=r.source?.pin,plan=r.plan;
    if(context?.characterID!==run.characterID||context?.corporationID!==sourceCorp||!positive(context?.shipID)||!positive(context?.locationID))
      throw Error("The native review does not match the selected pilot, corporation, active ship and dock.");
    if(definition?.characterID!==provider||definition?.corporationID!==setup.corporationID||definition?.fittingID!==setup.fittingID||
      definition?.fingerprint!==setup.fingerprint||r.contract?.shipTypeID!==setup.goalTypeID||plan?.targetHullTypeID!==setup.goalTypeID)
      throw Error("The native fitting definition differs from the selected catalogue entry. Refresh the fitting list and inspect again.");
    const exactSource=setup.sourceKind==="hangar"
      ? pin?.descriptor?.kind==="hangar"&&pin.ownerID===run.characterID&&pin.flag===4&&pin.locationID===context.locationID&&pin.dockedLocationID===context.locationID&&pin.office===null
      : pin?.descriptor?.kind==="corp"&&pin.descriptor.corporationID===sourceCorp&&pin.descriptor.division===setup.division;
    if(!exactSource)throw Error("The native review does not match the selected equipment source and division.");
    if(!Array.isArray(plan?.requirements)||!Array.isArray(plan?.shortages)||!Array.isArray(plan?.unsupported)||!Array.isArray(plan?.destructiveActions)||plan.destructiveActions.length)
      throw Error("The native review lacks a complete, non-destructive equipment plan.");
   };
   const review=async(final=false)=>{
    const request=final?input:{...input,...(setup.hullItemID?{hullItemID:setup.hullItemID}:{})};
    const result=await json("/api/bridge/provisioning/ship-review",request);verifyReview(result);return result;};
   const projection=async(r:any):Promise<ResourceQualification>=>{
    if(deps.projection)return deps.projection(run,r);
    let session:Awaited<ReturnType<typeof createPilotSession>>|null=null;
    try{session=await createPilotSession(run);return await simulatePilotResources({session,characterID:run.characterID,shipTypeID:setup.goalTypeID,
      fitData:[...r.contract.equipment.map(([flagID,typeID,quantity]:[number,number,number])=>({flagID,typeID,quantity})), ...(r.plan.retainedRigs??[])],current,
      review:r,read:json});
    }catch(error){return {state:"UNKNOWN" as const,reason:error instanceof Error?error.message:"Pilot simulation is unavailable."};}
    finally{session?.flow.setLivePush(false);}
   };
   const physicalResources=async(r:any)=>{
    if(r.context.shipTypeID!==setup.goalTypeID||r.status?.equipment!=="VERIFIED")return null;
    try{
     const measured=decodeNativeFittingResources(await ask("dogmaIM","ItemGetInfo",[r.context.shipID]),{
      shipID:r.context.shipID,shipTypeID:setup.goalTypeID,characterID:run.characterID});
     if(!measured)return {state:"UNKNOWN" as const,reason:"Native CPU and Powergrid are unreadable."};
     const f=await loadFitting({baseUrl:run.baseUrl,fetch:run.fetch});
     if(f.activeShipID!==r.context.shipID||Object.values(f.errors).some(e=>e!==null))throw Error("Native fitted module identities are unreadable.");
     const slots=buildSlots(f.slots,f.shipInfo,f.online),offlineSlots:number[]=[];
     for(const [flagID,typeID] of r.contract.structural){const slot=slots.find(s=>slotFlagOf(s.family,s.index)===flagID);
      if(!slot?.module||slot.module.typeID!==typeID)throw Error("The physical module fit changed during CPU/PG verification.");
      const state=decodeModuleObservation(await ask("dogmaIM","ItemGetInfo",[slot.module.itemID]),{
       moduleID:slot.module.itemID,typeID,ownerID:run.characterID,shipID:r.context.shipID,flagID});
      if(!state.online)offlineSlots.push(flagID);
     }
     return {...measured,allModulesOnline:offlineSlots.length===0,offlineSlots};
    }catch(error){return {state:"UNKNOWN" as const,reason:error instanceof Error?error.message:"Native fitting resources are unavailable."};}
   };
   const qualify=async(review:any)=>{
    if(!Array.isArray(review.contract?.equipment)||review.contract.equipment.some((x:any)=>!Array.isArray(x)||x.length!==3||!x.every(positive)))
     throw Error("Fitting equipment is unreadable.");
    const types=[...new Set<number>([setup.goalTypeID,...review.contract.equipment.map((x:number[])=>x[1]!)])];
    if(types.length>50)throw Error("The fitting exceeds the supported qualification size.");
    const metadata=await json(`/api/client-data/type-prices?typeIDs=${types.join(",")}`);
    if(metadata.available!==true||!object(metadata.categoryID)||metadata.categoryID[setup.goalTypeID]!==6||metadata.published?.[setup.goalTypeID]!==true||types.some(id=>!positive(metadata.categoryID[id])))throw Error("Fitting type qualification is incomplete.");
    const relevant=types.filter(id=>id===setup.goalTypeID||[7,18,32].includes(metadata.categoryID[id]));
    const requirements=await json(`/api/client-data/required-skills?typeIDs=${relevant.join(",")}`);
    if(requirements.available!==true)throw Error("Required skills are unavailable.");
    const target=trainingTargets(relevant,requirements.required),sheet=(await json("/api/bridge/skills")).skills;
    if(sheet?.characterID!==run.characterID||!Array.isArray(sheet.skills)||sheet.skills.some((s:any)=>!positive(s.typeID)||!Number.isInteger(s.level)||s.level<0||s.level>5))throw Error("Pilot skills are unreadable.");
    const levels=new Map<number,number>(sheet.skills.map((s:any)=>[s.typeID,s.level]));
    return {missing:target.filter(t=>(levels.get(t.typeID)??0)<t.toLevel),resourceQualification:"NATIVE_FITTING_REQUIRED"};
   };
   function reportUnfinished(operationID:string,result:any,originalShipID:number){
    const reason=result.reason||"The original equipment operation requires reconciliation.";
    run.report({status:"error",phase:"Provisioning blocked",why:reason,readout:{characterID:run.characterID,
      operationID,originalShipID,nativeState:result.state,nativeReason:reason,targetHullID:result.manifest?.targetHullID??null} as JsonValue});
   }
   const work=async()=>{
    const {review:r,selection}=await reviewExistingHull(json,await review());
    const replacing=r.plan.mode==="NEW_HULL"||selection!==null&&selection.itemID!==r.context.shipID;
    const storage=await reviewPreviousShipStorage(json,r.context,replacing,setup.oldShipDivision);
    const skills=await qualify(r),planFingerprint=reviewedPlanFingerprint(r,storage.plan,selection),resources=await projection(r),nativeResources=await physicalResources(r);
    const candidateReady=resources.state==='SIMULATED'&&resources.characterID===run.characterID&&resources.shipTypeID===setup.goalTypeID&&resources.source==='PILOT_BRAIN_CLIENT_SIMULATION'&&resources.fits;
    const capacityReady=candidateReady||r.plan.mode==='ALREADY_SATISFIED'&&nativeResources?.state==='NATIVE'&&nativeResources.fits&&nativeResources.allModulesOnline;
    const droneBayReason=r.plan.mode==='ALREADY_SATISFIED'?null:resources.droneBay?.reason;
    const applyBlockers=[
     ...nativeApplyBlockers(r),
     ...(storage.reason?[storage.reason]:[]),
     ...(!capacityReady?["Exact pilot-specific candidate CPU/PG is not verified."]:[]),
     ...(droneBayReason?[droneBayReason]:[]),
     ...(skills.missing.length?["The pilot is missing required skills."]:[]),
    ];
    const readout={characterID:run.characterID,corporationID:setup.corporationID,fittingID:setup.fittingID,fingerprint:setup.fingerprint,
      shipID:r.context.shipID,currentShipTypeID:r.context.shipTypeID,stationID:r.context.locationID,fittingService:r.fittingService??"UNKNOWN",skills,...reviewPresentation(r),reviewedPlanFingerprint:planFingerprint,
      resources,nativeResources,applyBlockers,status:r.status??null,canApply:applyBlockers.length===0};
    if(mode==="inspect"){run.report({status:"stopped",phase:"Provisioning inspected",readout:readout as unknown as JsonValue});return;}
    if(stopping)throw Error("Provisioning stopped before dispatch.");
    if(setup.reviewedPlanFingerprint!==planFingerprint)throw Error("ReviewChanged: The physical provisioning plan changed; inspect again.");
    if(resources.state==="SIMULATED"&&!resources.fits)throw Error(`Provisioning blocked: CPU requires ${resources.cpu.used} tf / ${resources.cpu.total} available; Powergrid requires ${resources.powergrid.used} MW / ${resources.powergrid.total} available.`);
    if(droneBayReason)throw Error(droneBayReason);
    if(applyBlockers.length)throw Error(`Provisioning blocked: ${applyBlockers.join(" ")}`);
    if((!selection||selection.requiresTake)&&r.source?.access?.take!==true||
      !["NEW_HULL","ALREADY_SATISFIED","EXISTING_HULL"].includes(r.plan.mode)||
      typeof r.reviewID!=="string"||typeof r.reviewHash!=="string"||!Number.isFinite(r.expiresAt)||Date.now()>=r.expiresAt)
      throw Error("Provisioning plan is blocked; inspect the exact fitting and stock.");
    let result:any=null,targetHullID:number;
    if(selection){
     targetHullID=selection.itemID;
     const applied=await applyExistingHull(json,r,selection,()=>{
      if(stopping)throw Error("Provisioning stopped before the next equipment change.");
     });
     if(!applied.ok){
      run.report({status:"error",phase:"Existing ship Apply incomplete",why:applied.reason,readout:{
       operationID:r.reviewID,characterID:run.characterID,originalShipID:r.context.shipID,targetHullID,activeShipID:applied.activeShipID}});
      return;
     }
    }else{
     try {
       const answer=await json("/api/bridge/provisioning/provision-ship",{reviewID:r.reviewID,reviewHash:r.reviewHash,confirm:true});
       result=answer.operationID===r.reviewID&&answer.manifest?.originalShipID===r.context.shipID&&answer.state==="BLOCKED"&&answer.reason==="OUTCOME_AMBIGUOUS"
         ? await json("/api/bridge/provisioning/reconcile",{operationID:r.reviewID}).catch(()=>answer)
         : answer;
     } catch(error) {
       // Query the original native operation after a lost response.
       result=await json("/api/bridge/provisioning/reconcile",{operationID:r.reviewID}).catch(()=>{throw error;});
     }
     if(result.operationID!==r.reviewID||result.manifest?.originalShipID!==r.context.shipID)
       throw Error("PROVISIONING_RECOVERY_REQUIRED: The native receipt identity could not be verified.");
     if(result.state!=="COMPLETE"){
       reportUnfinished(r.reviewID,result,r.context.shipID);
       return;
     }
     if(result.result?.equipment!=="VERIFIED"||!positive(result.manifest?.targetHullID))
       throw Error("PROVISIONING_RECOVERY_REQUIRED: Native equipment completion is unverified.");
     targetHullID=result.manifest.targetHullID;
    }
    const final=await review(true);
    if(final.context.shipID!==targetHullID||final.context.locationID!==r.context.locationID||final.status?.equipment!=="VERIFIED"||final.plan?.mode!=="ALREADY_SATISFIED")
      throw Error("PROVISIONING_RECOVERY_REQUIRED: Final equipment readback is not verified.");
    const finalResources=await physicalResources(final);if(finalResources?.state!=='NATIVE'||!finalResources.fits||!finalResources.allModulesOnline)throw Error('PROVISIONING_RECOVERY_REQUIRED: Exact final native CPU/PG and online equipment are not verified. No Apply replay.');
    const completed={characterID:run.characterID,shipID:final.context.shipID,originalShipID:r.context.shipID,operationID:r.reviewID,
      equipment:"VERIFIED",...(selection?{existingHull:true}:{nativeReceipt:receiptPresentation(result)}),finalStatus:final.status,nativeResources:finalResources};
    if(storage.plan)run.report({status:"running",phase:"Storing previous ship",readout:completed as unknown as JsonValue});
    const stored=storage.plan?await storePreviousShip(json,storage.plan,final.context.shipID,()=>{
      if(stopping)throw Error("Provisioning stopped before transferring the previous ship.");
    }):selection&&replacing?await verifyPersonalHull(json,r.context,r.context.shipID,r.context.shipTypeID)
      .then(()=>null,error=>({proof:null,reason:String(error?.message??error)})):null;
    run.report({status:stored?.reason?"error":"stopped",phase:stored?.reason?"Previous ship storage incomplete":"Provisioning verified",
      ...(stored?.reason?{why:stored.reason}:{}),
      readout:{...completed,previousShipStorage:stored?.proof??null,previousShipStorageReason:stored?.reason??null} as unknown as JsonValue});
   };
   const running=work().catch(error=>{if(active)run.report({status:"error",phase:"Provisioning blocked",why:String(error?.message||error)});});
   return {async stop(){stopping=true;await running;active=false;}};
  },
 };
}
export const provisioningInspectRun=createProvisioningRun("inspect");
export const provisioningApplyRun=createProvisioningRun("apply");
