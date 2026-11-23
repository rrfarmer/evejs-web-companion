import type {Session,ApiOptions} from '../../../../web/src/plugin-api/index.ts';
import {trainingTargets} from '../../shared/trainingTargets.ts';
import { cents, fields, scalar, prepareTrainingTransfer, readTrainingTransfer, sendTrainingTransfer,
 resolveTrainingFundingPolicy, trainingTransferAmount, readTrainingPersonalBalance, type WalletCall } from '../../training/funding.ts';
import { reconcile } from '../../training/reconcile.ts';
import { readTrainingReviewInputs } from '../../training/reviewInputs.ts';
import { clearNativeQueue, clearQueueSetup, skillReviewKey, skillSheetInspection, trainingQueueProof } from '../../training/queue.ts';
type Read=(path:string,options:ApiOptions,body?:unknown)=>Promise<any>;
const signature=(v:any[])=>JSON.stringify(v.map(x=>[x.typeID,x.toLevel]));
/** Page-owned Cockpit only. Uses its real flow and native RPC; no PluginRunContext, login or backend executor. */
export async function cockpitTraining(session:Session,kind:string,setup:any,read:Read){
 const id=session.store.get().station.online?.characterID,options=session.flow.requestOptions(),generation=session.flow.flying.sessionGeneration();
 if(!id)throw Error('The Cockpit pilot is offline.');
 if(kind!=='training'&&kind!=='training-inspect')throw Error('This Training action is unavailable through the selected Cockpit session.');
 const current=()=>{if(session.store.get().station.online?.characterID!==id||session.flow.flying.sessionGeneration()!==generation)throw Error('The Cockpit pilot changed.');};
 const ownership=await read(`/api/pilot-training/ownership?characterID=${id}`,options);current();
 if(ownership.ownership?.characterID!==id||ownership.ownership.owner!=='BROWSER'||ownership.ownership.online!==true)throw Error('This is not the page-owned Cockpit session; use the actual hosted owner.');
 const native=async()=>{current();const r=(await read('/api/bridge/skills',options)).skills;current();if(r?.characterID!==id||!Array.isArray(r.skills)||!Array.isArray(r.queue?.entries)||typeof r.queue.active!=='boolean')throw Error('Current native skills or queue are unavailable.');return r;};
 const finish=(phase:string,readout:unknown)=>({botID:session.id,status:'stopped',phase,why:null,readout});
 const clear = kind === 'training' && clearQueueSetup(setup);
 if (clear) {
  const cleared = await clearNativeQueue(clear.clearQueue, native, async () => {
   current();
   const answer = await read('/api/bridge/skills/queue', options, {entries:[]});
   current();
   if (answer.skills?.characterID !== id) throw Error('The native clear returned a different pilot.');
   return answer.skills;
  });
  return finish('Training queue cleared', trainingQueueProof(cleared));
 }
 const sheetOnly=kind==='training-inspect'&&skillSheetInspection(setup);
 if(sheetOnly){
  const [sheet,corporation,cash]=await Promise.all([
   native(),
   sheetOnly.skillReview?session.flow.flying.bridgeAsk('corpRegistry','GetCorporation',[]):null,
   sheetOnly.skillReview==='purchase'?session.flow.flying.bridgeAsk('account','GetCashBalance',[0]):null,
  ]);
  current();
  const corporationID=sheetOnly.skillReview?Number(scalar(fields(corporation).corporationID)):null;
  const balance=scalar(cash);
  return finish('Training skills read',{...trainingQueueProof(sheet),
   ...(sheetOnly.skillReview?{corporationID}:{}),
   ...(sheetOnly.skillReview==='purchase'?{balanceISK:typeof balance==='number'&&balance>=0?cents(balance)/100:null}:{}),
  });
 }
 const [sheet,account]=await Promise.all([native(),read('/api/pilot-training/characters',options)]);
 const pilot=account.characters?.find((p:any)=>p.characterID===id);current();
 if(!Number.isSafeInteger(pilot?.corporationID))throw Error('The Cockpit corporation is unreadable.');
 const targets=async(types:number[])=>{const r=await read(`/api/client-data/required-skills?typeIDs=${types.join(',')}`,options);current();if(r.available!==true)throw Error('Native prerequisites are unavailable.');return trainingTargets(types,r.required);};
 const quote=async(entries:{typeID:number;toLevel:number}[])=>{let total=0;for(const typeID of new Set(entries.filter(e=>!sheet.skills.some((s:any)=>s.typeID===e.typeID)).map(e=>e.typeID))){const q=await session.flow.skillPurchaseOffer(typeID);current();if(!q?.sold||typeof q.price!=='number'||!Number.isFinite(q.price))throw Error('A required skillbook cannot be quoted.');total+=Math.round(q.price*100);}return total;};
 const choices:any[]=[];
 if(setup.fittingID){await session.flow.loadSavedFittings();current();for(const f of session.flow.savedFittings.get()??[]){if(f.source!=='corporation'||f.ownerID!==pilot.corporationID||f.fittingID!==setup.fittingID)continue;
  const tuples=f.modules.map(m=>[m.typeID,m.flagID,m.quantity]).sort((a,b)=>a[0]!-b[0]!||a[1]!-b[1]!||a[2]!-b[2]!);
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([f.shipTypeID,tuples]))),fingerprint=Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
  const fit={corporationID:pilot.corporationID,fittingID:f.fittingID,goalTypeID:f.shipTypeID,name:f.name,fingerprint};
  try{const prerequisites=await targets([f.shipTypeID,...f.modules.filter(m=>m.flagID!==5).map(m=>m.typeID)]);choices.push({...fit,items:tuples,prerequisites,estimatedCostISK:await quote(prerequisites)/100,issue:null});}catch(e){choices.push({...fit,estimatedCostISK:null,issue:String(e)});}
 }}
 if(kind==='training-inspect'){
  const review=await readTrainingReviewInputs((service,method,args=[])=>session.flow.flying.bridgeAsk(service,method,args),id,pilot.corporationID);current();
  return finish('Training inspected',{...sheet,characterID:id,corporationID:pilot.corporationID,...review,choices});
 }
 const fit=setup.fittingID?choices.find(f=>f.fittingID===setup.fittingID&&f.fingerprint===setup.fingerprint&&f.corporationID===setup.corporationID):null;
 if(setup.fittingID&&fit?.goalTypeID!==setup.goalTypeID)throw Error('The current Cockpit fitting differs from the reviewed goal.');
 const required: {typeID:number;toLevel:number}[]=fit?.prerequisites??await targets([setup.goalTypeID]);
 if(setup.skillGoals?.length){
  if(!Array.isArray(setup.skillGoals)||setup.skillGoals.length>128||setup.skillGoals.some((g:any)=>!Number.isSafeInteger(g.typeID)||g.typeID<=0||!Number.isInteger(g.level)||g.level<1||g.level>5))throw Error('Reviewed skill goals are invalid.');
  for(let at=0;at<setup.skillGoals.length;at+=50){const goals=setup.skillGoals.slice(at,at+50),ids=goals.map((g:any)=>g.typeID),meta=await read(`/api/client-data/type-prices?typeIDs=${ids.join(',')}`,options);current();if(meta.available!==true||ids.some((id:number)=>meta.categoryID?.[id]!==16))throw Error('Reviewed skill-goal types are unavailable.');required.push(...await targets(ids));for(const g of goals)for(let level=1;level<=g.level;level++)required.push({typeID:g.typeID,toLevel:level});}
 }
 if(setup.skillLevel)for(let n=1;n<=setup.skillLevel;n++)required.push({typeID:setup.goalTypeID,toLevel:n});
 const total=await quote(required);if(total>cents(setup.maxSpendISK))throw Error('The current book quote exceeds the reviewed limit.');
 if(setup.skillReviewKey!==undefined&&skillReviewKey(pilot.corporationID,required,sheet,total)!==setup.skillReviewKey)
  throw Error('The skill sheet, queue or quote changed; review again.');
 let purchasedSheet=sheet;
 let transferReceipt: Awaited<ReturnType<typeof readTrainingTransfer>> = null;
 let totalCents: number | undefined;
 if(total>0){
  if(setup.skillAction==='queue-only')throw Error('Purchase the missing skillbooks before editing the queue.');
  const missing = [...new Set(required.map(e=>e.typeID))].filter(typeID=>!sheet.skills.some((s:any)=>s.typeID===typeID));
  const call: WalletCall = async (service, method, args = [], kwargs = null, write = false, of) => {
   current();
   const ask = write ? session.flow.flying.bridgeDo : session.flow.flying.bridgeAsk;
   const result = await ask(service, method, args, kwargs ?? undefined, of);
   current();
   return result;
  };
  const startingBalance = await readTrainingPersonalBalance(call);
  const policy = resolveTrainingFundingPolicy(setup.fundingPolicy, setup.corporateFunding);
  const corporateOnly = policy === "CORPORATION_WALLET_ONLY";
  const amount = trainingTransferAmount(policy, total, startingBalance);
  let available = startingBalance;
  if(policy !== "CHARACTER_WALLET_ONLY"){
   if(setup.corporationID!==pilot.corporationID)throw Error('The reviewed funding corporation differs from the Cockpit pilot’s current corporation.');
   if(amount>0){
    const transfer=await prepareTrainingTransfer(call,id,pilot.corporationID,startingBalance,amount,`UOC Training ${crypto.randomUUID()}`);
    if(await readTrainingPersonalBalance(call)!==startingBalance)throw Error('The personal wallet changed. Review the book cost again.');
    try{await sendTrainingTransfer(call,id,transfer);}
    catch(error){if((error as any)?.status===400 && (error as any)?.code==='INVALID_REQUEST')throw error;}
    transferReceipt=await reconcile(()=>readTrainingTransfer(call,id,transfer),current,'The current corporation transfer could not be verified.');
    available=await readTrainingPersonalBalance(call);
   }
  }
  if(available<total)throw Error("INSUFFICIENT_PERSONAL_FUNDS: The trainee's personal wallet cannot cover the skillbooks.");
  if(corporateOnly){
   if(available!==startingBalance+total)throw Error('The verified corporate funding no longer covers the purchase. The skillbooks were not purchased.');
   try{await call("skillHandler", "PurchaseSkills", [missing], null, true);}
   catch(error){if((error as any)?.status===400 && (error as any)?.code==='INVALID_REQUEST')throw error;}
   purchasedSheet=await reconcile(async()=>{
    const after=await native();
    return missing.every(id=>after.skills.some((skill:any)=>skill.typeID===id))?after:null;
   },current,'The purchased skillbooks are not visible in the current skill sheet.');
  }else{
   for(const typeID of missing){
    purchasedSheet=await native();
    if(purchasedSheet.skills.some((s:any)=>s.typeID===typeID))continue;
    current();
    await session.flow.buySkillFromOverlay(typeID,null);
    current();
    purchasedSheet=await native();
    if(!purchasedSheet.skills.some((s:any)=>s.typeID===typeID))throw Error('The purchased skillbook is not visible in the current skill sheet.');
   }
  }
  const afterBalance=await readTrainingPersonalBalance(call);
  if(corporateOnly&&afterBalance!==startingBalance)
   throw Error("The skillbooks are present, but the corporate payment does not reconcile with the trainee's original wallet balance.");
  const paid=available-afterBalance;
  if(paid===total)totalCents=paid;
 }
 if(setup.skillAction==='purchase-only')return finish('Skillbooks verified',{...trainingQueueProof(purchasedSheet),purchaseVerified:true,purchased:required.filter((e:any)=>!sheet.skills.some((s:any)=>s.typeID===e.typeID)).map((e:any)=>e.typeID),scope:'COCKPIT_NATIVE',transferReceipt,totalCents});
 const fresh=await native(),queue=[...fresh.queue.entries],covered=new Map<number,number>(fresh.skills.map((s:any)=>[s.typeID,s.level]));for(const e of queue)covered.set(e.typeID,Math.max(covered.get(e.typeID)??0,e.toLevel));
 for(const e of required)if(e.toLevel>(covered.get(e.typeID)??0)){queue.push(e);covered.set(e.typeID,e.toLevel);}
 if(queue.length>fresh.queue.maxEntries)throw Error('The skill queue has insufficient capacity.');
 if(signature(queue)!==signature(fresh.queue.entries)){current();await session.flow.saveSkillQueue(queue,'UOC training queue','reviewed skills',fresh.queue.entries.length===0);current();}
 const after=await native();if(signature(after.queue.entries)!==signature(queue))throw Error('The current native queue differs; inspect it before another edit.');
 return finish('Training queued',{...trainingQueueProof(after),queueVerified:true,scope:'COCKPIT_NATIVE',transferReceipt,totalCents});
}
