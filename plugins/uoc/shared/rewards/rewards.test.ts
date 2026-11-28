import test from "node:test";
import assert from "node:assert/strict";
import { captureReward, compareRewards } from "./index.ts";
import { captureMissionRewards } from "./compare.ts";
import type { JsonValue } from "../wire.ts";
const lp=(value:number)=>({type:"objectex2",list:[{type:"packedrow",fields:{issuerCorpID:44,loyaltyPoints:value}}]}) as JsonValue;
const journal=(rows: readonly JsonValue[])=>({type:"list",items:rows}) as JsonValue;
const credit=(id:number,kind:number,amount:number,description:string|null,owner=9)=>({type:"packedrow",fields:{transactionID:id,transactionDate:999,referenceID:7,entryTypeID:kind,ownerID1:7,ownerID2:owner,amount,balance:500,description}}) as JsonValue;
const snapshot=(rows:readonly JsonValue[], cash:JsonValue=100, points=0, corpPoints=0)=>captureMissionRewards({characterID:9,agentID:7,corporationID:44,cash,lp:lp(points),journal:journal(rows),memberCorporationID:99_000_001,corporationLp:lp(corpPoints)});
test("taxed and 100-percent-tax payouts use exact new agent rows and observed LP",()=>{
 const before=snapshot([],100,5,10), after=snapshot([credit(1,33,0,'93: [99000001, 100]'),credit(2,34,5,null),credit(3,33,900,null,123)],105,12,13);
 const r=compareRewards(before,after,"mission-1");
 assert.equal(r.confirmedIsk,"5.00");assert.equal(r.withheldIsk,"100.00");assert.equal(r.observedCashChange,"5.00");assert.equal(r.observedLpChange,"7");assert.equal(r.observedCorporationLpChange,"3");
 const fullyTaxed=compareRewards(before,snapshot([credit(1,33,0,'93: [99000001, 100]')],100,5,10),"mission-fully-taxed");
 assert.equal(fullyTaxed.confirmedIsk,"0.00");assert.equal(fullyTaxed.withheldIsk,"100.00");
});
test("unreadable, duplicate and unrelated reward data never invents zero payouts",()=>{
 const before=snapshot([]), unrelated=snapshot([credit(1,33,10,null,11)]);
 assert.equal(compareRewards(before,unrelated,"m").confirmedIsk,null);
 const duplicate=snapshot([credit(2,33,10,null),credit(3,33,20,null)]);
 assert.equal(compareRewards(before,duplicate,"m").confirmedIsk,null);
 const corrupt=captureMissionRewards({characterID:9,agentID:7,corporationID:44,cash:null,lp:null,journal:null});
 const r=compareRewards(corrupt,unrelated,"m");assert.equal(r.confirmedIsk,null);assert.equal(r.observedLpChange,null);assert.equal(r.observedCashChange,null);
 assert.equal(compareRewards(before,unrelated,"").confirmedIsk,null);
});

function walletRows(newest:number,count:number,kind=33){
 return Array.from({length:count},(_,i)=>credit(newest-i,kind,900,null));
}

test("wallet journal grows from 99 to 100 and retains both fully taxed mission credits",()=>{
 const rows=walletRows(100,99);
 const before=snapshot(rows,100,0,10);
 const after=snapshot([credit(102,34,0,"94: [99000001, 528000]"),credit(101,33,0,"93: [99000001, 429000]"),...rows.slice(0,98)],100,0,2044);
 const reward=compareRewards(before,after,"mission");
 assert.equal(reward.confirmedIsk,"0.00");
 assert.equal(reward.withheldIsk,"957000.00");
 assert.equal(reward.observedCashChange,"0.00");
 assert.equal(reward.observedLpChange,"0");
 assert.equal(reward.observedCorporationLpChange,"2034");
});

test("full wallet journal attributes only new mission credits after multiple insertions",()=>{
 const rows=walletRows(100,100);
 const before=snapshot(rows,100,5,10);
 const after=snapshot([credit(103,33,900,null,123),credit(102,34,5,null),credit(101,33,10,"93: [99000001, 6]"),...rows.slice(0,97)],115,12,13);
 const reward=compareRewards(before,after,"mission");
 assert.equal(reward.confirmedIsk,"15.00");
 assert.equal(reward.withheldIsk,"6.00");
 assert.equal(reward.observedLpChange,"7");
 assert.equal(reward.observedCorporationLpChange,"3");
 assert.equal(compareRewards(after,after,"repeated-read").confirmedIsk,null);
});

test("a replaced wallet journal without a shared transaction stays unverified",()=>{
 const before=snapshot(walletRows(100,100));
 const after=snapshot([credit(201,33,50,null),...walletRows(200,99,1)],150);
 const reward=compareRewards(before,after,"mission");
 assert.equal(reward.confirmedIsk,null);
 assert.equal(reward.withheldIsk,null);
 assert.equal(reward.observedCashChange,"50.00");
 assert.equal(compareRewards(snapshot([]),after,"full-window-after-empty").confirmedIsk,null);
});

test("wallet overlap must preserve the retained transactions and their order",()=>{
 const rows=walletRows(100,100);
 const before=snapshot(rows);
 const added=credit(101,33,50,null);
 const changed=snapshot([added,credit(100,33,901,null),...rows.slice(1,99)]);
 const gap=snapshot([added,...rows.slice(0,10),...rows.slice(11)]);
 assert.equal(compareRewards(before,changed,"changed").confirmedIsk,null);
 assert.equal(compareRewards(before,gap,"gap").confirmedIsk,null);
});

test("native held reward reads use exact calls and only stable non-NPC corporation LP",async()=>{
 const calls:string[]=[];
 const run={characterID:9,held:{characterID:9,character:{characterID:9,corporationID:99_000_001}},baseUrl:"http://held.test",fetch:async (_:unknown,init:RequestInit)=>{
  const body=JSON.parse(String(init.body)); calls.push(`${body.service}.${body.method}:${JSON.stringify(body.args)}`);assert.equal(body.pilot,true);
  const result=body.method==="GetCashBalance"?100:body.method==="GetAllMyCharacterWalletLPBalances"?lp(5):body.method==="GetTransactions"?journal([]):body.method==="GetAllMyCorporationWalletLPBalances"?lp(10):{type:"object",name:"util.KeyVal",args:{type:"dict",entries:[["corporationID",99_000_001]]}};
  return Response.json({ok:true,result}); }};
 const s=await captureReward(run as never,9,7,44);
 assert.equal(s.cash,"100");assert.equal(s.lp,"5");assert.equal(s.memberCorporationID,99_000_001);assert.equal(s.corporationLp,"10");
 assert.ok(calls.includes('account.GetTransactions:[1000,null,null,false]'));assert.ok(calls.includes('account.GetCashBalance:[0]'));
 assert.equal(calls.filter(c=>c==='corpRegistry.GetCorporation:[]').length,2);
 const mismatch=await captureReward(run as never,10,7,44);assert.equal(mismatch.cash,null);assert.equal(calls.length,6);
});
test("corporation change and read failures preserve unknown attribution",async()=>{
 let corpReads=0;
 const run={characterID:9,held:{characterID:9,character:{characterID:9,corporationID:99_000_001}},baseUrl:"http://held.test",fetch:async (_:unknown,init:RequestInit)=>{
  const body=JSON.parse(String(init.body)); if(body.method==="GetCashBalance") throw Error("unavailable");
  let result:unknown=null; if(body.method==="GetCorporation") {corpReads++; result={type:"object",name:"util.KeyVal",args:{type:"dict",entries:[["corporationID",corpReads===1?99_000_001:99_000_002]]}};}
  if(body.method==="GetAllMyCorporationWalletLPBalances"||body.method==="GetAllMyCharacterWalletLPBalances") result=lp(3);
  if(body.method==="GetTransactions") result=journal([]);
  return Response.json({ok:true,result}); }};
 const s=await captureReward(run as never,9,7,44); assert.equal(s.cash,null);assert.equal(s.memberCorporationID,null);assert.equal(s.corporationLp,null);assert.equal(s.lp,"3");
});
test("a stalled native read respects the shared 3.5-second bound",async()=>{
 const run={characterID:9,held:{characterID:9,character:{characterID:9,corporationID:1_000_001}},baseUrl:"http://held.test",fetch:async (_:unknown,init:RequestInit)=>{
  const body=JSON.parse(String(init.body));if(body.method==="GetTransactions") return new Promise<Response>(()=>{});
  return Response.json({ok:true,result:body.method==="GetCashBalance"?100:body.method==="GetAllMyCharacterWalletLPBalances"?lp(2):null}); }};
 const start=Date.now(), result=await captureReward(run as never,9,7,44);
 assert.ok(Date.now()-start<4500);assert.equal(result.cash,"100");assert.equal(result.lp,"2");assert.equal(result.journal,null);
});
test("native corporation brackets LP when held presentation omits its corporation",async()=>{
 const corp={type:"object",name:"util.Row",args:{type:"dict",entries:[["header",{type:"list",items:["corporationID","corporationName"]}],["line",{type:"list",items:[99_000_001,"Own corporation"]}]]}};
 let reads=0;const run={characterID:9,held:{characterID:9,character:{characterID:9}},baseUrl:"http://held.test",fetch:async(_:unknown,init:RequestInit)=>{
  const b=JSON.parse(String(init.body));if(b.method==="GetCorporation")reads++;
  const result=b.method==="GetCorporation"?corp:b.method==="GetAllMyCorporationWalletLPBalances"?lp(270):b.method==="GetAllMyCharacterWalletLPBalances"?lp(0):b.method==="GetTransactions"?journal([]):100;
  return Response.json({ok:true,result});
 }};
 const result=await captureReward(run as never,9,7,44);assert.equal(result.memberCorporationID,99_000_001);assert.equal(result.corporationLp,"270");assert.equal(reads,2);
});
