import type {SynchronousStore} from "./targetBoard.ts";
export type DefiniteWarpRefusal={code:"CALL_REFUSED";status:409;refusal:{key:"DeniedTargetSelfWarping"}};
export type LockRefusalEvidence={characterID:number;shipID:number;targetID:number;runID:string;issuedAt:number;observedAt:number;error:DefiniteWarpRefusal};
export function isDefiniteWarpRefusal(error:unknown):error is DefiniteWarpRefusal{const e=error as any;return !!e&&typeof e==="object"&&e.code==="CALL_REFUSED"&&e.status===409&&e.refusal?.key==="DeniedTargetSelfWarping";}
/** Pure reconciliation: the supplied structured receipt must identify the exact original locked scope. */
export function reconcileDefiniteLockRefusal<T extends {identity:string;pending:any;lockRefusals?:readonly unknown[]}>(state:T,e:LockRefusalEvidence):T{
 let identity:any,scope:any;try{identity=JSON.parse(state.identity);scope=JSON.parse(state.pending?.details?.scope);}catch{throw Error("Lock refusal identity is unreadable.");}
 const pending=state.pending;
 if(!Array.isArray(identity)||identity.length!==7||identity[2]!==e.characterID||identity[3]!==e.shipID||identity[6]!==e.runID||!Array.isArray(scope)||scope.length!==5||scope[0]!==state.identity||scope[3]!==e.targetID||
  pending?.kind!=="target-lock"||pending.ownerRunID!==e.runID||pending.details?.targetID!==e.targetID||pending.issuedAt!==e.issuedAt||pending.receipt!==undefined||
  !Number.isSafeInteger(e.issuedAt)||e.issuedAt<=0||!Number.isSafeInteger(e.observedAt)||e.observedAt<e.issuedAt||e.observedAt>Date.now()||!isDefiniteWarpRefusal(e.error))throw Error("Lock refusal does not match the exact original native attempt.");
 if(state.lockRefusals!==undefined&&!Array.isArray(state.lockRefusals))throw Error("Lock refusal history is unreadable.");
 return {...state,pending:null,lockRefusals:[...(state.lockRefusals??[]),{intent:structuredClone(pending),evidence:{...e,error:{code:"CALL_REFUSED",status:409,refusal:structuredClone(e.error.refusal)}}}]};
}
/** Explicit commit seam for a caller that already holds an exact native receipt; never extracts or fabricates one. */
export function persistDefiniteLockRefusal(document:SynchronousStore,e:LockRefusalEvidence){const state=document.read() as Parameters<typeof reconcileDefiniteLockRefusal>[0];if(!state)throw Error("Lock journal is unavailable.");const next=reconcileDefiniteLockRefusal(state,e);document.write(next);return next;}
