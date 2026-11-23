import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {miningPreparationDraft,miningPreparationConfig,miningCommandFuelTarget} from "./miningPreparation.ts";
import {hostedDurationLabel} from "./hostedRunPolicy.ts";
import {createControlPlanePoll} from "./controlPlanePoll.ts";
import {miningUnloadPolicy,sharedPlayerCorporation} from "./miningSetup.ts";

test("a miner can plan corporate delivery and parking before any hauler is assigned",()=>{
 const miners=[{role:"MINER",corp:98000004}];
 assert.equal(miningUnloadPolicy(miners),"SELF_UNLOAD");
 assert.equal(sharedPlayerCorporation(miners.map(p=>p.corp)),98000004);
 assert.equal(miningUnloadPolicy([...miners,{role:"HAULER",corp:98000004}]),"HAULER_SERVICE");
});

test("original preparation draft retains exact corporate supply and bay settings",()=>{
 const draft=miningPreparationDraft();draft.sourceKind="corp";draft.corporationID=98000003;draft.division=3;draft.supplies=[{...miningCommandFuelTarget(),target:1000}];
 assert.deepEqual(miningPreparationConfig(draft),{source:{kind:"corp",corporationID:98000003,division:3},suppliesRequired:false,replenishSupplies:false,supplies:[{typeID:16272,target:1000,mode:"TOTAL_ABOARD",eligibleFlags:[5,133],required:false}]});
 draft.division=8;assert.throws(()=>miningPreparationConfig(draft),/division/);
});
test("host duration preserves original label",()=>{assert.equal(hostedDurationLabel(60),"1 hour");assert.equal(hostedDurationLabel(10080),"7 days");});
test("control-plane polling suspends on authentication loss and can reconnect",async()=>{
 let fail=true,received=0,failed=false;const poll=createControlPlanePoll({read:async()=>{if(fail)throw Object.assign(new Error("expired"),{status:401});return 3;},received:v=>{received=v;},failed:(_e,authLost)=>{failed=authLost;},schedule:()=>0,cancel:()=>{}});
 await poll.refresh();assert.equal(failed,true);await poll.refresh();assert.equal(received,0);fail=false;await poll.reconnect();assert.equal(received,3);poll.stop();
});

test("a poll that began before Delete cannot return the deleted operation to the UI",async()=>{
 let resolveOld!:(value:string[])=>void;
 const old=new Promise<string[]>(resolve=>{resolveOld=resolve;});
 let reads=0;
 const received:string[][]=[],delays:number[]=[];
 const poll=createControlPlanePoll({
  read:()=>++reads===1?old:Promise.resolve(["other"]),
  received:rows=>{received.push(rows);},failed:assert.fail,
  schedule:(_task,ms)=>{delays.push(ms);return 0;},cancel:()=>{},
 });
 const stale=poll.refresh();
 poll.invalidate();
 resolveOld(["deleted","other"]);
 await stale;
 assert.deepEqual(received,[]);
 assert.deepEqual(delays,[0]);
 await poll.refresh();
 assert.deepEqual(received,[["other"]]);
 poll.stop();
});

test("each MCC operation card renders Edit and Delete before applying runtime-state controls",()=>{
 const source=readFileSync(new URL("../ui/MiningOperations.svelte",import.meta.url),"utf8");
 const card=source.slice(source.indexOf('<article class="operation-card">'));
 const firstStateGate=card.indexOf('{#if ["DRAFT", "STOPPED"].includes(row.runtime.state)}');
 assert.ok(firstStateGate>0);
 assert.match(card.slice(0,firstStateGate),/onclick=\{\(\) => editOperation\(row\.definition\)\}>Edit/);
 assert.match(card.slice(0,firstStateGate),/onclick=\{\(\) => void remove\(row\.definition\.operationID\)\}>Delete/);
});

test("MCC Start dispatches from the card without a second confirmation",()=>{
 const source=readFileSync(new URL("../ui/MiningOperations.svelte",import.meta.url),"utf8");
 const start=source.slice(source.indexOf("  async function start("),source.indexOf("  async function stop("));
 assert.match(source,/onclick=\{\(\) => void start\(row\.definition\)\}>Start<\/button>/);
 assert.match(start,/await host\.prepare\(/);
 assert.match(start,/await host\.start\(reviewed, runtimeMinutes, cancellation\.signal\)/);
 assert.doesNotMatch(start,/\bconfirm\s*\(/);
});
