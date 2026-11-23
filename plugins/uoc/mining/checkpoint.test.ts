import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMiningMissionRuns } from "./checkpoint.ts";
import type { MiningMissionState } from "./miningMission.ts";

test("dispatch survives restart and fences replay, stale custody, epoch and revision", async () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"uoc-mining-")), filePath=path.join(dir,"checkpoint.json");
 try {
  let current=true;
  const scope={accountID:1,characterID:2,scriptHash:"script-a",epoch:"epoch-a",assertCurrent:()=>current};
  const state={version:2,revision:1,epoch:scope.epoch,characterID:2,phase:"request",pending:{id:"op-1",kind:"request"}} as MiningMissionState;
  const run=createMiningMissionRuns({filePath}).open(scope);
  await run.save(state); await run.dispatch("op-1");
  const restarted=createMiningMissionRuns({filePath});
  const resumed=restarted.open(scope);
  assert.equal(resumed.read().receipt?.acknowledged,false);
  await assert.rejects(resumed.dispatch("op-1"),/no replay/);
  assert.throws(()=>restarted.open({...scope,scriptHash:"script-b"}).read(),/RECOVERY_REQUIRED/);
  await assert.rejects(restarted.open({...scope,epoch:"epoch-b"}).dispatch("op-1"),/no replay/);
  await assert.rejects(resumed.save({...state,revision:3}),/Stale/);
  current=false; assert.throws(()=>resumed.read(),/custody changed/);
  current=true; await resumed.acknowledge("op-1"); assert.equal(resumed.read().receipt?.acknowledged,true);
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test("corrupt checkpoint refuses to replace recovery evidence",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"uoc-mining-")),filePath=path.join(dir,"checkpoint.json");
 try {fs.writeFileSync(filePath,JSON.stringify({version:1,records:{"1:2":{}}}));
  assert.throws(()=>createMiningMissionRuns({filePath}),/Invalid Mining Mission record/);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test("failed durable dispatch does not grant a receipt", async () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"uoc-mining-")),filePath=path.join(dir,"checkpoint.json");
 try {
  const scope={accountID:1,characterID:2,scriptHash:"a",epoch:"e",assertCurrent:()=>true};
  const run=createMiningMissionRuns({filePath}).open(scope);
  await run.save({version:2,revision:1,epoch:"e",characterID:2,phase:"request",pending:{id:"op",kind:"request"}} as MiningMissionState);
  fs.mkdirSync(`${filePath}.${process.pid}.tmp`);
  await assert.rejects(run.dispatch("op"));
  assert.equal(run.read().receipt,null);
  assert.equal(createMiningMissionRuns({filePath}).open(scope).read().receipt,null);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
