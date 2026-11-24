import {trainingTargets,trainingPlanTargets} from '../shared/trainingTargets.ts';
export {trainingTargets} from '../shared/trainingTargets.ts';
import { createHash, randomUUID } from "node:crypto";
import type { BackendRun, PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import { reconcile, preDispatchRefusal } from "./reconcile.ts";
import { trainingDocument } from "./hr.ts";
import { cents, fields, scalar, prepareTrainingTransfer, readTrainingTransfer, sendTrainingTransfer,
  isTrainingFundingPolicy, resolveTrainingFundingPolicy, trainingTransferAmount, readTrainingPersonalBalance, type FundingPolicy, type TrainingTransfer } from "./funding.ts";
import type { JsonValue } from "../../../web/src/plugin-api/index.ts";
import { readTrainingReviewInputs } from "./reviewInputs.ts";
import { clearNativeQueue, clearQueueSetup, compactTrainingInspection, skillReviewKey, skillSheetInspection, trainingQueueProof } from "./queue.ts";

type Setup = { goalTypeID: number; maxSpendISK: number; corporateFunding?: boolean; fundingPolicy?: FundingPolicy; corporationID?: number; fittingID?: number; fingerprint?: string; skillLevel?: number; skillAction?: "purchase-only" | "queue-only"; skillReviewKey?:string;skillGoals?:{typeID:number;level:number}[] };
type Entry = { typeID: number; toLevel: number; startTimeMs?:number|null; endTimeMs?:number|null };
type Skill = { typeID: number; level: number; skillPoints?: number };
type Sheet = { characterID: number; skills: Skill[]; queue: { active: boolean; entries: Entry[]; maxEntries: number; endTimeMs?:number|null; reckonedEndMs?:number|null } };
const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const object = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const signature = (q: readonly Entry[]) => JSON.stringify(q.map(x => [x.typeID, x.toLevel]));

export function trainingSetup(input: unknown): Setup | null {
  if (!object(input) || Object.keys(input).some(k => !["goalTypeID", "maxSpendISK", "corporateFunding", "fundingPolicy", "corporationID", "fittingID", "fingerprint", "skillLevel", "skillAction", "skillReviewKey", "skillGoals"].includes(k)) || !positive(input.goalTypeID) ||
      typeof input.maxSpendISK !== "number" || !Number.isFinite(input.maxSpendISK) || input.maxSpendISK < 0 ||
      input.maxSpendISK > 1_000_000_000) return null;
  if (input.corporateFunding !== undefined && typeof input.corporateFunding !== "boolean") return null;
  if (input.fundingPolicy !== undefined && (!isTrainingFundingPolicy(input.fundingPolicy) || input.corporateFunding !== undefined)) return null;
  const usesCorporation = resolveTrainingFundingPolicy(input.fundingPolicy, input.corporateFunding) !== "CHARACTER_WALLET_ONLY";
  if(input.skillGoals!==undefined&&(!Array.isArray(input.skillGoals)||input.skillGoals.length>128||input.skillGoals.some(g=>!object(g)||Object.keys(g).sort().join(',')!=='level,typeID'||!positive(g.typeID)||!positive(g.level)||g.level>5)||new Set(input.skillGoals.map(g=>g.typeID)).size!==input.skillGoals.length))return null;
  const independent = input.skillLevel !== undefined || input.skillAction !== undefined;
  if (independent && (!positive(input.skillLevel) || input.skillLevel > 5 || !["purchase-only", "queue-only"].includes(input.skillAction) || input.fittingID !== undefined || input.fingerprint !== undefined || (input.skillAction === "queue-only" && usesCorporation))) return null;
  if (input.skillReviewKey !== undefined && (!independent || typeof input.skillReviewKey !== "string" || !input.skillReviewKey.length || input.skillReviewKey.length > 16*1024)) return null;
  const fitting = input.fittingID !== undefined || input.fingerprint !== undefined;
  if ((usesCorporation || fitting) && !positive(input.corporationID)) return null;
  if (fitting && (!positive(input.fittingID) || typeof input.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.fingerprint))) return null;
  try { cents(input.maxSpendISK); } catch { return null; }
  return { goalTypeID: input.goalTypeID, maxSpendISK: input.maxSpendISK, ...(input.corporateFunding === true ? { corporateFunding: true } : {}),
    ...(input.fundingPolicy === undefined ? {} : { fundingPolicy: input.fundingPolicy }),
    ...(positive(input.corporationID) ? { corporationID: input.corporationID } : {}), ...(fitting ? { fittingID: input.fittingID, fingerprint: input.fingerprint } : {}), ...(independent ? { skillLevel: input.skillLevel, skillAction: input.skillAction, ...(input.skillReviewKey===undefined?{}:{skillReviewKey:input.skillReviewKey}) } : {}),...(input.skillGoals?{skillGoals:input.skillGoals.map((g:any)=>({typeID:g.typeID,level:g.level}))}:{}) };
}

function fittingRow(value: any, fittingID: number | undefined) {
  if (value?.type === "object" && String(scalar(value.name)).endsWith("objectCaching.CachedMethodCallResult")) value = value.args?.[1]?.value;
  if (value?.type !== "dict" || !Array.isArray(value.entries)) throw Error("Corporation fitting library is unreadable.");
  const matches = value.entries.filter((e: any) => Array.isArray(e) && Number(scalar(e[0])) === fittingID);
  if (matches.length !== 1) throw Error("The selected corporation fitting is unavailable.");
  return fields(matches[0][1]);
}

function fittingItems(value: any, setup: Setup): [number, number, number][] {
  const f = fittingRow(value, setup.fittingID);
  if (Number(scalar(f.fittingID)) !== setup.fittingID || Number(scalar(f.ownerID)) !== setup.corporationID || Number(scalar(f.shipTypeID)) !== setup.goalTypeID ||
      f.fitData?.type !== "list" || !Array.isArray(f.fitData.items) || !f.fitData.items.length) throw Error("The selected fitting identity changed.");
  const tuples: [number, number, number][] = f.fitData.items.map((row: any) => {
    const a = Array.isArray(row) ? row : row?.type === "tuple" ? row.items : null;
    if (!Array.isArray(a) || a.length !== 3 || !a.every(positive) ||
        !([5, 87, 158].includes(a[1]!) || ([[11,34],[92,99],[125,132],[164,171]] as [number, number][]).some(([lo,hi]) => a[1]! >= lo && a[1]! <= hi))) throw Error("Fitting contents are unreadable.");
    return a as [number, number, number];
  });
  const canonical = [...tuples].sort((a,b) => a[0]-b[0] || a[1]-b[1] || a[2]-b[2]);
  if (createHash("sha256").update(JSON.stringify([setup.goalTypeID, canonical])).digest("hex") !== setup.fingerprint) throw Error("The selected fitting changed; review again.");
  return tuples;
}

function fittingTypeIDs(hull: number, items: readonly [number, number, number][]): number[] {
  return [...new Set([hull, ...items.filter(([,flag]) => flag === 87 || ([[11,34],[92,99],[125,132],[164,171]] as [number, number][]).some(([lo,hi]) => flag >= lo && flag <= hi)).map(([id]) => id)])];
}

export function fitTypes(value: any, setup: Setup): number[] {
  return fittingTypeIDs(setup.goalTypeID, fittingItems(value, setup));
}

type FitChoice = { corporationID:number; fittingID:number; name:string; goalTypeID:number; fingerprint:string; estimatedCostISK:number|null; issue:string|null; prerequisites?:Entry[]; items?: [number, number, number][] };
/** Client required-skills table supplies the complete recursive dependency graph. */

function sheetOf(value: unknown, characterID: number): Sheet {
  if (!object(value) || value.characterID !== characterID || !Array.isArray(value.skills) || !object(value.queue) ||
      typeof value.queue.active !== "boolean" || !Array.isArray(value.queue.entries) || !positive(value.queue.maxEntries))
    throw Error("The held pilot's skill sheet is unreadable.");
  const skills: Skill[] = value.skills.map((s: any) => {
    if (!positive(s.typeID) || !Number.isInteger(s.level) || s.level < 0 || s.level > 5) throw Error("Skill levels are unreadable.");
    return { typeID: s.typeID, level: s.level, ...(typeof s.skillPoints === "number" && Number.isFinite(s.skillPoints) && s.skillPoints >= 0 ? {skillPoints:s.skillPoints} : {}) };
  });
  if (new Set(skills.map(s => s.typeID)).size !== skills.length) throw Error("Duplicate skills are unreadable.");
  const entries: Entry[] = value.queue.entries.map((e: any) => {
    if (!positive(e.typeID) || !positive(e.toLevel) || e.toLevel > 5) throw Error("The skill queue is unreadable.");
    const time=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)&&v>0?v:null;
    return { typeID: e.typeID, toLevel: e.toLevel, startTimeMs:time(e.startTimeMs),endTimeMs:time(e.endTimeMs) };
  });
  const time=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)&&v>0?v:null;
  return { characterID, skills, queue: { active: value.queue.active, entries, maxEntries: value.queue.maxEntries,endTimeMs:time(value.queue.endTimeMs),reckonedEndMs:time(value.queue.reckonedEndMs) } };
}

type FundingAttempt = {books:number[]; total:number; policy:FundingPolicy; transfer:TrainingTransfer};
function readFundingAttempt(doc:ReturnType<typeof trainingDocument>): FundingAttempt | null {
  const value=doc.read();
  if (value === null) return null;
  if (!object(value) || !Array.isArray(value.books) || !value.books.length || !value.books.every(positive) ||
      !positive(value.total) || !isTrainingFundingPolicy(value.policy) || value.policy === "CHARACTER_WALLET_ONLY" || !object(value.transfer) ||
      !positive(value.transfer.corporationID) || !positive(value.transfer.shortfall) ||
      !Number.isSafeInteger(value.transfer.balance) || value.transfer.balance < 0 ||
      typeof value.transfer.reason !== "string" || !value.transfer.reason.startsWith("UOC Training "))
    throw Error("The original training funding reference could not be read.");
  return value as FundingAttempt;
}
/** Train the selected pilot using the current skill sheet and wallet. */
export function createTrainingRun(options: {reconcileDelayMs?:number; fundingDocument?:(characterID:number)=>ReturnType<typeof trainingDocument>} = {}): BackendRun {
  return {
    check(input) {
      const clear = clearQueueSetup(input);
      if (clear) return { ok: true, setup: clear, name: "Clear skill queue", policy: { riskClasses: [], restartSafe: false } };
      const setup = trainingSetup(input);
      return setup ? { ok: true, setup: setup as unknown as JsonValue, name: "Ship training", policy: { riskClasses: ["financial"], restartSafe: false } }
        : { ok: false, refusal: "Choose a training goal and a spending limit up to one billion ISK." };
    },
    async start(run: PluginRunContext) {
      const setup = trainingSetup(run.setup);
      const clear = clearQueueSetup(run.setup);
      if ((!setup && !clear) || run.resumed || !positive(run.characterID) || run.held.characterID !== run.characterID) throw Error("Training ownership or setup is invalid.");
      if (clear) {
        const native = async (write = false) => {
          const response = await run.fetch(new URL(write ? "/api/bridge/skills/queue" : "/api/bridge/skills", run.baseUrl),
            write ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries: [] }) } : undefined);
          const body = await response.json();
          if (!response.ok || body?.ok === false) throw Error(body?.message || body?.error || "Native skill queue is unavailable.");
          return sheetOf(body.skills, run.characterID);
        };
        const work = clearNativeQueue(clear.clearQueue, () => native(), () => native(true)).then(sheet => {
          run.report({ status: "stopped", phase: "Training queue cleared", readout: trainingQueueProof(sheet) as unknown as JsonValue });
        }).catch(error => run.report({ status: "error", phase: "Training queue clear failed", why: error.message }));
        return { async stop() { await work; } };
      }
      if (!setup) throw Error("Training setup is invalid.");
      const fundingPolicy = resolveTrainingFundingPolicy(setup.fundingPolicy, setup.corporateFunding);
      const corporateOnly = fundingPolicy === "CORPORATION_WALLET_ONLY";
      let active = true, phase = "Checking skills";
      let transferReceipt: Awaited<ReturnType<typeof readTrainingTransfer>> = null;
      let totalCents: number | undefined;
      const current = () => { if (!active) throw Error("Training ownership ended."); };
      const fetchJSON = async (route: string, body?: unknown) => {
        current(); const response = await run.fetch(`${run.baseUrl}${route}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const data = await response.json() as any; current(); if (!response.ok || data?.ok === false) { const error=Error(data?.message || data?.error || `Read failed (${response.status}).`); if(preDispatchRefusal(response.status,data))Object.assign(error,{preDispatch:true}); throw error; } return data;
      };
      const call = async (service: string, method: string, args: unknown[] = [], kwargs: unknown = null, write = false, of?: number) =>
        (await fetchJSON("/api/bridge/call", { service, method, args, kwargs, pilot: true, ...(write ? { confirm: true } : {}), ...(of ? { of } : {}) })).result;
      const readSheet = async () => sheetOf((await fetchJSON("/api/bridge/skills")).skills, run.characterID);
      const readFit = async () => {
        const before = fields(await call("corpRegistry", "GetCorporation"));
        if (Number(scalar(before.corporationID)) !== setup.corporationID) throw Error("The pilot's corporation changed; review the fitting again.");
        const types = fitTypes(await call("corpFittingMgr", "GetFittings", [setup.corporationID]), setup);
        const after = fields(await call("corpRegistry", "GetCorporation"));
        if (Number(scalar(after.corporationID)) !== setup.corporationID) throw Error("The pilot's corporation changed; review the fitting again.");
        return types;
      };
      const verifyFit = async () => { if (setup.fittingID) await readFit(); };
      const work = async () => {
        const hull = await fetchJSON(`/api/client-data/type-prices?typeIDs=${setup.goalTypeID}`);
        if (hull.available !== true || hull.categoryID?.[setup.goalTypeID] !== (setup.skillAction ? 16 : 6) || hull.published?.[setup.goalTypeID] !== true)
          throw Error("The selected goal type is unavailable or unpublished.");
        let goalTypes = [setup.goalTypeID];
        if (setup.fittingID) {
          const fit = await readFit();
          if (fit.length > 50) throw Error("The selected fitting exceeds the supported review size.");
          const types = await fetchJSON(`/api/client-data/type-prices?typeIDs=${fit.join(",")}`);
          if (types.available !== true || !object(types.categoryID)) throw Error("Fitting type categories are unavailable.");
          if (fit.some(id => !positive(types.categoryID[id]))) throw Error("Fitting type categories are incomplete.");
          goalTypes = fit.filter(id => id === setup.goalTypeID || [7, 18, 32].includes(types.categoryID[id]));
        }
        const all=[...new Set([...goalTypes,...(setup.skillGoals??[]).map(g=>g.typeID)])],required:Record<string,unknown>={};
        for(let at=0;at<all.length;at+=50){const ids=all.slice(at,at+50),req=await fetchJSON(`/api/client-data/required-skills?typeIDs=${ids.join(',')}`);if(req.available!==true)throw Error('Required skill data is unavailable.');Object.assign(required,req.required);}
        if(setup.skillGoals?.length)for(let at=0;at<setup.skillGoals.length;at+=50){const ids=setup.skillGoals.slice(at,at+50).map(g=>g.typeID),meta=await fetchJSON(`/api/client-data/type-prices?typeIDs=${ids.join(',')}`);if(meta.available!==true||ids.some(id=>meta.categoryID?.[id]!==16))throw Error('Reviewed skill-goal types are unavailable.');}
        const targets = trainingPlanTargets(goalTypes, required,setup.skillGoals); if(setup.skillAction)for(let n=1;n<=setup.skillLevel!;n++)targets.push({typeID:setup.goalTypeID,toLevel:n});
        let sheet = await readSheet();
        const known = new Map(sheet.skills.map(s => [s.typeID, s.level]));
        const missing = [...new Set(targets.filter(t => !known.has(t.typeID)).map(t => t.typeID))];
        if (missing.length > 32) throw Error("The skill purchase exceeds the supported review size.");
        if (missing.length && setup.skillAction === "queue-only") throw Error("SKILLBOOK_REQUIRED: Purchase the missing skillbooks before queueing.");
        let total = 0;
        if (missing.length) {
          const [prices, lists] = await Promise.all([
            fetchJSON(`/api/client-data/type-prices?typeIDs=${missing.join(",")}`),
            fetchJSON(`/api/types/type-lists?typeIDs=${missing.join(",")}&listIDs=93`),
          ]);
          if (prices.available !== true || !object(prices.basePrice) || !object(prices.published) || !object(lists.lists)) throw Error("Skill price or sale eligibility is unavailable.");
          for (const id of missing) {
            const base = prices.basePrice[id];
            if (!(typeof base === "number" && base > 0) || prices.published[id] !== true || !Array.isArray(lists.lists[id]) || !lists.lists[id].includes(93)) throw Error("A required skill is not available for direct purchase.");
            total += cents(base * 1.3);
          }
          if (!Number.isSafeInteger(total) || total > cents(setup.maxSpendISK)) throw Error("Required books exceed the reviewed spending limit.");
        }
        if (setup.skillReviewKey) {
          const corporationID = Number(scalar(fields(await call("corpRegistry", "GetCorporation")).corporationID));
          if (!positive(corporationID) || skillReviewKey(corporationID, targets, sheet, total) !== setup.skillReviewKey)
            throw Error("The skill sheet, queue or quote changed; review again.");
        }
        if (missing.length) {
          let startingBalance = await readTrainingPersonalBalance(call);
          let balance = startingBalance;
          const funds = fundingPolicy === "CHARACTER_WALLET_ONLY" ? null :
            options.fundingDocument?.(run.characterID) ?? trainingDocument("funding:" + run.characterID);
          let prior = funds && readFundingAttempt(funds);
          if (funds && prior && prior.books.every(id => known.has(id))) {
            const earlier = prior.transfer;
            await reconcile(() => readTrainingTransfer(call, run.characterID, earlier), current,
              "The earlier corporation transfer could not be verified.", options.reconcileDelayMs);
            funds.write(null);
            prior = null;
          }
          const books = [...missing].sort((a,b)=>a-b);
          if (prior && (prior.transfer.corporationID !== setup.corporationID || prior.policy !== fundingPolicy ||
              prior.total !== total || JSON.stringify(prior.books) !== JSON.stringify(books)))
            throw Error("An earlier corporation transfer is still assigned to another skillbook purchase. Check the original purchase first.");
          if (prior) startingBalance = prior.transfer.balance;
          const amount = trainingTransferAmount(fundingPolicy, total, startingBalance);
          if (funds && (prior || amount > 0)) {
            if (!setup.corporationID) throw Error("The training corporation Master Wallet is not configured.");
            const transfer = prior?.transfer ?? await prepareTrainingTransfer(call, run.characterID, setup.corporationID,
              startingBalance, amount, `UOC Training ${randomUUID()}`);
            if (transfer.shortfall !== amount) throw Error("The original training funding amount differs from the current purchase.");
            phase = "Funding skillbooks";
            if (!prior) {
              await verifyFit();
              if (corporateOnly && await readTrainingPersonalBalance(call) !== startingBalance)
                throw Error("The trainee's wallet changed before corporate funding. Review the skillbooks again.");
              current();
              if (funds.read() !== null) throw Error("Another training purchase already has a funding reference.");
              funds.write({books,total,policy:fundingPolicy,transfer} satisfies FundingAttempt);
              try { await sendTrainingTransfer(call, run.characterID, transfer); }
              catch (error) { if ((error as any)?.preDispatch) { funds.write(null); throw error; } }
            }
            transferReceipt = await reconcile(() => readTrainingTransfer(call, run.characterID, transfer), current,
              "The current corporation transfer could not be verified.", options.reconcileDelayMs);
            if (!corporateOnly) balance = await readTrainingPersonalBalance(call);
          }
          if (!corporateOnly && balance < total) throw Error("INSUFFICIENT_PERSONAL_FUNDS: The trainee's personal wallet cannot cover the skillbooks.");
          await verifyFit();
          if (corporateOnly) {
            // EveJS debits the trainee. Their original funds and the verified transfer must both still be present.
            balance = await readTrainingPersonalBalance(call);
            if (balance !== startingBalance + total)
              throw Error("The verified corporate funding no longer covers the purchase. The skillbooks were not purchased.");
          }
          phase = "Purchasing skillbooks";
          try { await call("skillHandler", "PurchaseSkills", [missing], null, true); }
          catch (error) { if ((error as any)?.preDispatch) throw error; }
          sheet = await reconcile(async () => {
            const after = await readSheet();
            return missing.every(id => after.skills.some(s => s.typeID === id)) ? after : null;
          }, current, "The purchased skillbooks are not visible in the current skill sheet.", options.reconcileDelayMs);
          const afterBalance = await readTrainingPersonalBalance(call).catch(() => null);
          if (corporateOnly && afterBalance !== startingBalance)
            throw Error("The skillbooks are present, but the corporate payment does not reconcile with the trainee's original wallet balance.");
          if (afterBalance !== null && balance - afterBalance === total) totalCents = total;
          if (funds && transferReceipt) funds.write(null);
        }
        if (setup.skillAction === "purchase-only") {
          run.report({ status: "stopped", phase: "Skillbooks verified", why: "Skillbooks are present in the held pilot's skill sheet.",
            readout: { goalTypeID: setup.goalTypeID, purchaseVerified: true, purchased: missing, transferReceipt, totalCents: totalCents ?? null, ...trainingQueueProof(sheet) } as unknown as JsonValue });
          return;
        }
        const covered = new Map(sheet.skills.map(s => [s.typeID, s.level]));
        for (const e of sheet.queue.entries) {
          if (e.toLevel !== (covered.get(e.typeID) ?? 0) + 1) throw Error("Existing queue order is not verifiable.");
          covered.set(e.typeID, e.toLevel);
        }
        const additions = targets.filter(t => t.toLevel > (covered.get(t.typeID) ?? 0));
        const merged = [...sheet.queue.entries, ...additions];
        if (merged.length > sheet.queue.maxEntries) throw Error("The skill queue has insufficient capacity.");
        let verifiedSheet = sheet;
        if (additions.length) {
          const last = await readSheet();
          if (signature(last.queue.entries) !== signature(sheet.queue.entries) || signature(last.skills.map(s => ({typeID:s.typeID,toLevel:s.level}))) !== signature(sheet.skills.map(s => ({typeID:s.typeID,toLevel:s.level})))) throw Error("The queue or skills changed before submission.");
          await verifyFit();
          const activate = sheet.queue.entries.length ? sheet.queue.active : true;
          phase = "Submitting skill queue";
          try { await call("skillHandler", "SaveNewQueue", [{ type: "dict", entries: merged.map((e, i) => [i, [e.typeID, e.toLevel]]) }], { activate }, true); } catch (error) { if ((error as any)?.preDispatch) throw error; /* no replay */ }
          verifiedSheet = await reconcile(async()=>{ const after=await readSheet(); return signature(after.queue.entries)===signature(merged) && after.queue.active===activate ? after : null; },current,"The submitted skill queue is not verified.",options.reconcileDelayMs);
        }
        run.report({ status: "stopped", phase: "Training queued", why: "The required skill queue was verified; training may still be in progress.", readout: { goalTypeID: setup.goalTypeID, queueVerified: true, ...trainingQueueProof(verifiedSheet),transferReceipt,totalCents:totalCents??null } as unknown as JsonValue });
      };
      const running = work().catch(error => {
        if (!active) return;
        const funded = corporateOnly && transferReceipt ? " Verified corporation transfer: " + transferReceipt.shortfall / 100 + " ISK." : "";
        run.report({ status: "error", phase, why: String(error?.message || error) + funded });
      });
      return { async stop() { active = false; await running; } };
    },
  };
}

export const trainingRun = createTrainingRun();

/** A temporary, read-only inspection of the selected pilot's own corporation and fitting library. */
export const trainingInspectRun: BackendRun = {
  check(input) {
    const exact = object(input) && Object.keys(input).sort().join(",") === "corporationID,fingerprint,fittingID,goalTypeID"
      ? trainingSetup({ ...input, maxSpendISK: 0 }) : null;
    const sheetOnly = skillSheetInspection(input);
    return exact || sheetOnly || (object(input) && Object.keys(input).length === 0)
      ? {ok:true,setup:exact || sheetOnly ? input as JsonValue : {},name:"Inspect training",policy:{riskClasses:[],restartSafe:false}}
      : {ok:false,refusal:"Choose the exact corporation fitting or inspect the skill sheet."};
  },
  async start(run) {
    if (run.resumed || !positive(run.characterID) || run.held.characterID!==run.characterID) throw Error("Inspection pilot identity is unavailable.");
    let active=true;
    const json=async(route:string,body?:unknown)=>{
      if(!active)throw Error("Inspection stopped.");
      const res=await run.fetch(`${run.baseUrl}${route}`,body===undefined?undefined:{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      const data=await res.json() as any;
      if(!active)throw Error("Inspection stopped.");
      if(!res.ok||data?.ok===false)throw Error(data?.message||data?.error||"Inspection read failed.");
      return data;
    };
    const ask=async(service:string,method:string,args:unknown[]=[]) => (await json("/api/bridge/call",{service,method,args,kwargs:null,pilot:true})).result;
    const work=async()=>{
      const sheetOnly = skillSheetInspection(run.setup);
      if (sheetOnly) {
        const [native, corporation, cash] = await Promise.all([
          json("/api/bridge/skills"),
          sheetOnly.skillReview ? ask("corpRegistry", "GetCorporation") : null,
          sheetOnly.skillReview === "purchase" ? ask("account", "GetCashBalance", [0]) : null,
        ]);
        const sheet = sheetOf(native.skills, run.characterID);
        const corporationID = sheetOnly.skillReview ? Number(scalar(fields(corporation).corporationID)) : null;
        const balance = scalar(cash);
        const readout = { ...trainingQueueProof(sheet),
          ...(sheetOnly.skillReview ? { corporationID } : {}),
          ...(sheetOnly.skillReview === "purchase" ? { balanceISK: typeof balance === "number" && balance >= 0 ? cents(balance) / 100 : null } : {}),
        };
        run.report({status:"stopped",phase:"Training skills read",readout:readout as unknown as JsonValue});
        return;
      }
      const corporationID=Number(scalar(fields(await ask("corpRegistry","GetCorporation")).corporationID));
      if(!positive(corporationID))throw Error("The pilot's corporation is unavailable.");
      const sheet=sheetOf((await json("/api/bridge/skills")).skills,run.characterID);
      const review=await readTrainingReviewInputs(ask,run.characterID,corporationID);
      const choices:FitChoice[]=[];
      const setup=object(run.setup) && Object.keys(run.setup).length ? trainingSetup({...run.setup,maxSpendISK:0}) : null;
      if(setup?.fittingID && setup.fingerprint){
        if(setup.corporationID!==corporationID)throw Error("The selected fitting corporation changed.");
        const raw=await ask("corpFittingMgr","GetFittings",[corporationID]);
        const row=fittingRow(raw,setup.fittingID);
        const fit={corporationID,fittingID:setup.fittingID,goalTypeID:setup.goalTypeID,fingerprint:setup.fingerprint,name:row.name};
        const items=fittingItems(raw,setup),types=fittingTypeIDs(setup.goalTypeID,items);
        if(typeof fit.name!=="string"||!fit.name.trim())throw Error("The selected fitting name is unavailable.");
        try{
          if(types.length>50)throw Error("Fitting is too large to inspect.");
          const metadata=await json(`/api/client-data/type-prices?typeIDs=${types.join(",")}`);
          if(metadata.available!==true||!object(metadata.categoryID)||metadata.categoryID[fit.goalTypeID]!==6||metadata.published?.[fit.goalTypeID]!==true||types.some(id=>!positive(metadata.categoryID[id])))
            throw Error("Fitting type data is unavailable.");
          const relevant=types.filter(id=>id===fit.goalTypeID||[7,18,32].includes(metadata.categoryID[id]));
          const req=await json(`/api/client-data/required-skills?typeIDs=${relevant.join(",")}`);
          if(req.available!==true)throw Error("Required skill data is unavailable.");
          const target=trainingTargets(relevant,req.required), known=new Set(sheet.skills.map(s=>s.typeID));
          const missing=[...new Set(target.filter(s=>!known.has(s.typeID)).map(s=>s.typeID))];
          if(missing.length>32)throw Error("The required skill list is too large to quote.");
          let total=0;
          if(missing.length){
            const [prices,lists]=await Promise.all([
              json(`/api/client-data/type-prices?typeIDs=${missing.join(",")}`),
              json(`/api/types/type-lists?typeIDs=${missing.join(",")}&listIDs=93`),
            ]);
            if(prices.available!==true||!object(prices.basePrice)||!object(prices.published)||!object(lists.lists))throw Error("Skill prices are unavailable.");
            for(const id of missing){const base=prices.basePrice[id];if(typeof base!=="number"||base<=0||prices.published[id]!==true||!Array.isArray(lists.lists[id])||!lists.lists[id].includes(93))throw Error("A required book cannot be purchased directly.");total+=cents(base*1.3);}
            if(!Number.isSafeInteger(total))throw Error("Skill price is not representable.");
          }
          // Return one maximum requirement per skill. Execution expands native levels afresh.
          const levels=new Map<number,number>();for(const t of target)levels.set(t.typeID,Math.max(levels.get(t.typeID)??0,t.toLevel));
          choices.push({...fit,items,estimatedCostISK:total/100,issue:null,prerequisites:[...levels].map(([typeID,toLevel])=>({typeID,toLevel}))});
        }catch(error){choices.push({...fit,estimatedCostISK:null,issue:error instanceof Error?error.message:"Fitting inspection failed."});}
      }
      const after=Number(scalar(fields(await ask("corpRegistry","GetCorporation")).corporationID));
      if(after!==corporationID)throw Error("The pilot's corporation changed during inspection.");
      const readout = {characterID:run.characterID,corporationID,...review,...compactTrainingInspection(sheet),choices};
      if(Buffer.byteLength(JSON.stringify(readout))>16*1024)throw Error("The native training sheet and fitting exceed the hosted inspection response budget.");
      run.report({status:"stopped",phase:"Training inspected",why:"Native skill sheet and queue read.",readout:readout as unknown as JsonValue});
    };
    const running=work().catch(error=>{if(active)run.report({status:"error",phase:"Inspection failed",why:String(error?.message||error)});});
    return {async stop(){active=false;await running;}};
  },
};
