import test from "node:test";import assert from "node:assert/strict";import {createFleetLaunchJournal} from "./miningLaunchJournal.ts";
function memory(){let value:unknown=null;return {read:()=>structuredClone(value),write:(v:unknown)=>{value=structuredClone(v);}};}
const input={operationID:"op",operationRunID:"run",revision:1,planHash:"hash",setupHash:"setup",members:[{characterID:1,accountName:"a",role:"MINER" as const,kind:"mcc-miner" as const,beforeIDs:["old"]},{characterID:2,accountName:"b",role:"HAULER" as const,kind:"mcc-hauler" as const,beforeIDs:[]}]};
test("fleet intent is durable before each host Start and an unknown dispatch is never replayed",()=>{const doc=memory(),j=createFleetLaunchJournal(doc);j.begin(input);j.dispatch(1);assert.throws(()=>createFleetLaunchJournal(doc).dispatch(1),/no replay/);assert.throws(()=>j.accept(1,"old"),/does not match/);j.accept(1,"new");assert.equal(j.read()?.members[0]?.botID,"new");assert.throws(()=>j.dispatch(1),/no replay/);j.dispatch(2);assert.throws(()=>j.accept(2,"new"),/does not match/);});
test("a changed roster or generation cannot adopt a retained launch",()=>{const j=createFleetLaunchJournal(memory());j.begin(input);assert.throws(()=>j.begin({...input,operationRunID:"other"}),/reconciliation/);assert.throws(()=>j.begin({...input,members:input.members.slice(0,1)}),/reconciliation/);});

test("a hosted resume can replace only its current accepted binding",()=>{
 const journal=createFleetLaunchJournal(memory());
 journal.begin(input);
 journal.dispatch(1);journal.accept(1,"original-1");
 journal.dispatch(2);journal.accept(2,"original-2");
 const original=journal.read();
 assert.throws(()=>journal.rebind("different-run",1,"original-1","restored"),/launch changed/);
 assert.throws(()=>journal.rebind("run",1,"stale","restored"),/launch changed/);
 for(const conflict of ["old","original-2"]){
  assert.throws(()=>journal.rebind("run",1,"original-1",conflict),/conflicts/);
 }
 assert.throws(()=>journal.accept(1,"restored"),/original dispatch/);
 assert.deepEqual(journal.read(),original);
 journal.rebind("run",1,"original-1","restored");
 journal.rebind("run",1,"restored","restored");
 assert.deepEqual(journal.read(),{...original,members:[
  {...original!.members[0],botID:"restored"},original!.members[1],
 ]});
});
