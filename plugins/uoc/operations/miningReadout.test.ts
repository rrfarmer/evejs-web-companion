import test from "node:test";import assert from "node:assert/strict";import {projectFleetRun} from "./miningReadout.ts";import type {FleetLaunchReceipt} from "./miningLaunchJournal.ts";
const receipt:FleetLaunchReceipt={version:1,operationID:"op",operationRunID:"run",revision:1,planHash:"x",setupHash:"y",members:[{characterID:1,accountName:"a",role:"MINER",kind:"mcc-miner",beforeIDs:[],status:"ACCEPTED",botID:"b"}]};const bot={botID:"b",characterID:1,kind:"plugin",plugin:{pluginID:"uoc",run:"mcc-miner"},status:"running",phase:"Mining",why:null,startedAt:"2026-01-01",endedAt:null,expiresAt:"2026-01-02"};
test("only exact active owner and host row produce a running projection",()=>{const owner={botID:"b",characterID:1,operationID:"op",operationRunID:"run"};assert.equal(projectFleetRun(receipt,new Map([[1,{owners:[owner],bots:[bot]}]])).state,"RUNNING");const bad=projectFleetRun(receipt,new Map([[1,{owners:[{...owner,operationRunID:"other"}],bots:[bot]}]]));assert.equal(bad.state,"UNKNOWN");assert.equal(bad.recoveryRequired,true);});
test("missing or non-settled terminal evidence is never reported as stopped",()=>{assert.equal(projectFleetRun(receipt,new Map()).state,"UNKNOWN");const ended={...bot,endedAt:"2026-01-02",status:"stopped",phase:"Forced"};assert.equal(projectFleetRun(receipt,new Map([[1,{owners:[],bots:[ended]}]])).state,"UNKNOWN");assert.equal(projectFleetRun(receipt,new Map([[1,{owners:[],bots:[{...ended,phase:"Settled in place"}]}]])).state,"STOPPED");});

test("a refused Defender Start shows the pilot's actual error while the fleet assembles",()=>{
 const defender={...receipt.members[0]!,role:"DEFENDER" as const,kind:"mcc-defender" as const,
  status:"PREPARED" as const,botID:null,refusal:"The pilot account could not be connected."};
 const view=projectFleetRun({...receipt,members:[defender]},new Map(),[],"ASSEMBLING");
 assert.equal(view.members[0]?.phase,"Hosted Start refused");
 assert.equal(view.members[0]?.reason,defender.refusal);
 assert.equal(view.members[0]?.hosted,false);
});

test('preparation warnings come only from the exact operation run and remain visible during mining',()=>{
 const owner={botID:'b',characterID:1,operationID:'op',operationRunID:'run'},readout={characterID:1,operationID:'op',operationRunID:'run',state:'DEGRADED',equipment:'VERIFIED',supplies:'LOW',reason:'Optional fuel below target',observedAt:1};
 const prepared={...bot,botID:'prepare',endedAt:'2026-01-01',phase:'Mining member prepared',plugin:{pluginID:'uoc',run:'mcc-prepare',readout}};
 let r=projectFleetRun(receipt,new Map([[1,{owners:[owner],bots:[bot,prepared]}]]));assert.equal((r.members[0] as any)?.preparation?.reason,'Optional fuel below target');assert.equal(r.state,'RUNNING');
 r=projectFleetRun(receipt,new Map([[1,{owners:[owner],bots:[bot,{...prepared,plugin:{...prepared.plugin,readout:{...readout,operationRunID:'old'}}}]}]]));assert.equal((r.members[0] as any)?.preparation,undefined);
});

test("refresh retains independent dock and release when historical hosted receipts are gone",()=>{
 const retained={...receipt,members:[...receipt.members,{...receipt.members[0]!,characterID:2,botID:"b2"}]};
 const physical=[{characterID:1,parkingState:"DOCK_VERIFIED"},{characterID:2,parkingState:"UNVERIFIED",phase:"Final freight",reason:"Original Jettison has no container proof."}];
 const reads=new Map([[1,{owners:[],bots:[],offline:true}],[2,{owners:[],bots:[],offline:true}]]);
 const view=projectFleetRun(retained,reads,[],"UNKNOWN",physical);
 assert.equal(view.members[0]?.runtimeState,"STOPPED");
 assert.equal(view.members[1]?.runtimeState,"UNKNOWN");
 assert.equal(view.state,"UNKNOWN");
 assert.deepEqual(view.stopFailures.map(m=>m.characterID),[2]);
 assert.match(view.stopFailures[0]!.message,/Jettison.*Pilot is offline/);
});
test("missing history with an online pilot leaves parking and ownership unresolved",()=>{
 const v=projectFleetRun(receipt,new Map([[1,{owners:[],bots:[],online:true}]]),[],"UNKNOWN",
  [{characterID:1,parkingState:"UNVERIFIED",phase:"In space",reason:"Original flight did not confirm docking."}]);
 assert.equal(v.members[0]?.runtimeState,"UNKNOWN");
 assert.match(v.stopFailures[0]!.message,/flight did not confirm docking.*still online/);
});

test("native home dock displays incomplete unload separately from parking failure",()=>{
 const reads=new Map([[1,{owners:[],bots:[],offline:true,dockedForUnload:true}]]);
 const physical=[{characterID:1,parkingState:"SETTLED",phase:"Stop needs attention",reason:"The hosted pilot ended before physical settlement."}];
 const pending=projectFleetRun(receipt,reads,[],"WAITING_FOR_HOST",physical);
 assert.equal(pending.members[0]?.phase,"Docked at home · Unloading incomplete");
 assert.equal(pending.members[0]?.runtimeState,"UNKNOWN");
 assert.deepEqual(pending.stopFailures,[]);
 const owner={botID:"finish",characterID:1,operationID:"op",operationRunID:"run",purpose:"mcc-finish"};
 const finishing={...bot,botID:owner.botID,phase:"Unloading at home",plugin:{pluginID:"uoc",run:"mcc-finish"}};
 const live=projectFleetRun(receipt,new Map([[1,{owners:[owner],bots:[finishing]}]]),[],"STOPPING",physical);
 assert.equal(live.members[0]?.phase,"Unloading at home");
 assert.equal(live.members[0]?.hosted,true);
 const ended=projectFleetRun(receipt,reads,[],"STOPPED",[{...physical[0]!,parkingState:"DOCK_VERIFIED"}]);
 const released=ended.members[0];
 assert.ok(released&&"parkingState" in released);
 assert.equal(released.parkingState,"RELEASED");
 assert.equal(ended.state,"STOPPED");
});

test("only the current Hauler owner can offer Check and release in the operation", () => {
  const member = { ...receipt.members[0]!, role: "HAULER" as const, kind: "mcc-hauler" as const };
  const trip = { ...receipt, members: [member] };
  const hauler = { ...bot, phase: "Needs attention", plugin: { pluginID: "uoc", run: "mcc-hauler" } };
  const owner = { botID: "b", characterID: 1, operationID: "op", operationRunID: "run", canCheckUnload: true };
  function allowsCheck(controller: typeof owner, hosted = hauler) {
    const reads = new Map([[1, { owners: [controller], bots: [hosted] }]]);
    const pilot = projectFleetRun(trip, reads).members[0];
    return !!pilot && "canCheckUnload" in pilot && pilot.canCheckUnload === true;
  }
  assert.equal(allowsCheck(owner), true);
  assert.equal(allowsCheck({ ...owner, canCheckUnload: false }), false);
  assert.equal(allowsCheck({ ...owner, operationRunID: "previous" }), false);
  assert.equal(allowsCheck(owner, { ...hauler, botID: "replacement" }), false);
});
