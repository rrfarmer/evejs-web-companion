import test from "node:test";import assert from "node:assert/strict";import {createHaulJournal} from "./haulJournal.ts";
const manifest:any={operationID:"o",runID:"r",containerID:3,items:[{itemID:9,typeID:4,quantity:6}]};
test("haul journal persists pre-action intent and never repeats unknown writes",()=>{let v:unknown=null;const d={read:()=>v,write:(x:unknown)=>{v=structuredClone(x)}},j=createHaulJournal(d,manifest,5,1);j.begin("pickup",{source:6,quantity:6});assert.throws(()=>j.begin("pickup",{}),/no replay/);const after=createHaulJournal(d,manifest,5,1);assert.throws(()=>after.begin("delivery",{}),/no replay/);after.reconcilePickup({kind:"relocated-manifest-items"});after.begin("delivery",{destinationBefore:0});assert.throws(()=>after.settle({}),/acknowledged/);after.acknowledge();after.settle({destinationAfter:6});assert.equal(after.snapshot().events.length,2);});

test("durable relocation remains reusable with a newer observation of the same exact items",()=>{let v:unknown=null;const d={read:()=>v,write:(x:unknown)=>{v=structuredClone(x)}},j=createHaulJournal(d,manifest,5,1);const p={kind:"relocated-manifest-items",items:[{itemID:9,typeID:4,quantity:6}],observedAt:10};assert.deepEqual(j.recordRelocation(p),p);assert.deepEqual(j.recordRelocation({...p,observedAt:20}),p);assert.throws(()=>j.recordRelocation({...p,items:[{itemID:10,typeID:4,quantity:6}]}),/changed/);});

test("definite delivery refusal clears only the current unacknowledged delivery",()=>{
 let data:unknown=null;
 const doc={read:()=>data,write:(value:unknown)=>{data=structuredClone(value)}};
 const manifest={operationID:"op",runID:"run",containerID:100,items:[]} as any;
 const journal=createHaulJournal(doc,manifest,13,1);
 journal.begin("delivery",{itemID:20});
 journal.refuseDelivery();
 assert.equal(journal.snapshot().pending,null);
 assert.deepEqual(journal.snapshot().events,[]);
 journal.begin("pickup",{itemID:20});
 assert.throws(()=>journal.refuseDelivery(),/No refused delivery intent/);
 journal.acknowledge();
 journal.settle({moved:true});
 journal.begin("delivery",{itemID:20});
 journal.acknowledge();
 assert.throws(()=>journal.refuseDelivery(),/No refused delivery intent/);
 assert.equal(journal.snapshot().pending?.acknowledged,true);
});
