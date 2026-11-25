import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createDistributionFence} from "../distribution/fence.ts";
test("confirmed Courier missions retain completion and reward while dropping obsolete unload deltas",()=>{
 const completion={kind:"missionCompletion",runID:"old",invocationID:1,stepPath:"complete",agentID:10,missionKey:"mission",actionID:1,completed:true};
 const reward={confirmedIsk:"123.00"};
 const unloaded={kind:"unload",agentID:10,missionKey:"mission",shipID:3,stationID:4,typeID:5,itemID:6,
  itemQuantity:7,quantity:7,cargoBefore:7,hangarBefore:0};
 const old={accountID:1,characterID:2,runID:"old",done:true,mutated:true,mission:{agentID:10,missionKey:"mission"},
  pending:null,unloaded,completion,reward};
 const inFlight={...old,characterID:3,runID:"held",done:false,completion:undefined,reward:undefined};
 let data={version:1,records:{"1:2":old,"1:3":inFlight},history:[]} as any;
 const fence=createDistributionFence({storage:{read:()=>structuredClone(data),write:value=>{data=structuredClone(value);}}});
 assert.equal(fence.inspect(1,2)?.unloaded,undefined);
 assert.deepEqual(fence.completed(1,2,"old"),[{receipt:completion,reward}]);
 assert.deepEqual(fence.inspect(1,3)?.unloaded,unloaded);
 fence.open({accountID:1,characterID:2,runID:"new",current:()=>true});
 assert.equal(data.history[0].row.unloaded,undefined);
 assert.deepEqual(data.records["1:3"].unloaded,unloaded);
 assert.deepEqual(fence.completed(1,2,"old"),[{receipt:completion,reward}]);
});
test("durable Distribution intent blocks replay across process restart and rejects unproven settlement",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"uoc-dist-")),filePath=path.join(dir,"fence.json");
 try {const scope={accountID:1,characterID:2,runID:"bot",current:()=>true};const fence=createDistributionFence({filePath}).open(scope);
  const empty={journal:{active:[],offered:[]},shipID:null,stationID:null,typeID:null,cargoQuantity:null,hangarQuantity:null};
  fence.dispatch({kind:"request",agentID:99},empty);
  assert.throws(()=>fence.dispatch({kind:"request",agentID:99},empty),/no replay/);
  assert.throws(()=>createDistributionFence({filePath}).open({...scope,runID:"new"}),/RECOVERY_REQUIRED/);
  const offered={journal:{active:[],offered:[{agentID:99,missionKey:'[99,900,101,"123"]' }]},shipID:null,stationID:null,typeID:null,cargoQuantity:null,hangarQuantity:null};
  assert.throws(()=>fence.settle(offered));fence.acknowledge();fence.settle(offered);
  fence.dispatch({kind:"accept",agentID:99,missionKey:'[99,900,101,"123"]' },offered);
  assert.throws(()=>fence.acknowledge(),/acceptance time/);fence.acknowledge("1234");
  assert.throws(()=>fence.settle(offered));fence.settle({...offered,journal:{active:offered.journal.offered,offered:[]}});
  const load={kind:"load" as const,agentID:99,missionKey:'[99,900,101,"123"]' ,shipID:3,stationID:4,typeID:5,itemID:6,itemQuantity:10,quantity:7,cargoBefore:0,hangarBefore:10};
  const beforeCargo={journal:{active:[{agentID:99,missionKey:'[99,900,101,"123"]' }],offered:[]},shipID:3,stationID:4,typeID:5,cargoQuantity:0,hangarQuantity:10,sourceItem:{itemID:6,typeID:5,quantity:10}};
  fence.dispatch(load,beforeCargo);fence.acknowledge();
  const cargo={journal:{active:[{agentID:99,missionKey:'[99,900,101,"123"]' }],offered:[]},shipID:3,stationID:4,typeID:5,cargoQuantity:7,hangarQuantity:3};
  assert.throws(()=>fence.settle({...cargo,hangarQuantity:10}));assert.throws(()=>fence.settle({...cargo,shipID:9}));fence.settle(cargo);
  const complete={kind:"complete" as const,agentID:99,missionKey:'[99,900,101,"123"]' ,runnerID:"runner",invocationID:10,stepPath:"complete",actionID:8};
  fence.dispatch(complete,cargo);fence.acknowledge();
  const receipt={kind:"missionCompletion" as const,runID:"runner",invocationID:10,stepPath:"complete",agentID:99,actionID:8,missionKey:'[99,900,101,"123"]' ,completed:true as const};
  assert.throws(()=>fence.settle({...cargo,completed:{...receipt,invocationID:9}}));
  assert.throws(()=>fence.settle({...cargo,completed:receipt}));
  fence.settle({...cargo,journal:{active:[],offered:[]},completed:receipt});
  assert.doesNotThrow(()=>createDistributionFence({filePath}).open({...scope,runID:"new"}));
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test("a stopped but unfinished Distribution run cannot silently start again",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"uoc-dist-")),filePath=path.join(dir,"fence.json");
 try {const scope={accountID:1,characterID:2,runID:"bot",current:()=>true};createDistributionFence({filePath}).open(scope);
  assert.throws(()=>createDistributionFence({filePath}).open({...scope,runID:"next"}),/reconciliation/);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test("failure to persist a Distribution dispatch does not send or grant an intent",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"uoc-dist-")),filePath=path.join(dir,"fence.json");
 try {const scope={accountID:1,characterID:2,runID:"bot",current:()=>true};const f=createDistributionFence({filePath}).open(scope);
  fs.mkdirSync(`${filePath}.${process.pid}.tmp`);
  const before={journal:{active:[],offered:[]},shipID:null,stationID:null,typeID:null,cargoQuantity:null,hangarQuantity:null};
  assert.throws(()=>f.dispatch({kind:"request",agentID:99},before));assert.equal(f.read().pending,null);
  assert.throws(()=>createDistributionFence({filePath}).open({...scope,runID:"new"}),/reconciliation/);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test("injected durable storage preserves unknown Distribution intent across reconstruction",()=>{
 let data:unknown=null; const storage={read:()=>data,write:(value:unknown)=>{data=structuredClone(value)}};
 const scope={accountID:1,characterID:2,runID:"r",current:()=>true};
 const f=createDistributionFence({storage}).open(scope);
 const before={journal:{active:[],offered:[]},shipID:3,stationID:4,typeID:null,cargoQuantity:null,hangarQuantity:null};
 f.dispatch({kind:"request",agentID:9},before);
 assert.throws(()=>createDistributionFence({storage}).open({...scope,runID:"new"}),/RECOVERY_REQUIRED/);
});


test("the new held Courier observes the current journal without inheriting the old pending action",()=>{
 let data:unknown=null;
 const ledger=createDistributionFence({storage:{read:()=>data,write:v=>{data=structuredClone(v)}}});
 const scope={accountID:1,characterID:2,runID:"old",current:()=>true},old=ledger.open(scope);
 const empty={journal:{active:[],offered:[]},shipID:3,stationID:4,typeID:null,cargoQuantity:null,hangarQuantity:null};
 old.dispatch({kind:"request",agentID:9},empty);
 const offered={active:[],offered:[{agentID:9,missionKey:'[9,900,101,"123"]'}]};
 const next=ledger.continueMission({...scope,runID:"new",journal:offered});
 assert.equal(next.read().pending,null);
 assert.equal(next.read().mission,null);
 assert.throws(()=>old.read(),/stale/);
 assert.equal((data as any).history[0].row.pending.intent.kind,"request");
 assert.throws(()=>next.dispatch({kind:"request",agentID:9},{...empty,journal:offered}),/no replay/);
});

test("malformed persisted handoff history is rejected",()=>{
 for(const history of [[{}],[{oldRunStatus:"ended",row:{}}],[{oldRunStatus:"invented",row:{accountID:1,characterID:2,runID:"r",done:false,mutated:true,mission:null,pending:null}}]]){
  const storage={read:()=>({version:1,records:{},history}),write:(_v:unknown)=>{}};
  assert.throws(()=>createDistributionFence({storage}),/Invalid Distribution history/);
 }
});
