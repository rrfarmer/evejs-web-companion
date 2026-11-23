import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createDocumentStore } = require("../documentStore.cjs");
import { createSecurityCoordinator, type Observation, type Offer, type State } from "./security.ts";
import { createSecurityJournal } from "./journal.ts";

function initial(): State { return { version: 1, revision: 1, runID: "run", accountID: 1, characterID: 2, shipID: 3, agentID: 4, agentStationID: 5, agentSystemID: 6, deadlineMs: 100000, missionLimit: 2, phase: "AGENT", reason: null, offer: null, identity: null, pending: null, before: null, completed: [] }; }
function observation(): Observation { return { observedAt: 100, characterID: 2, shipID: 3, agentID: 4, agentLevel: 1, agentStationID: 5, agentSystemID: 6, dockedStationID: 5, systemID: 6, inSpace: false, inWarp: false, mission: null, buttons: { request: 10, accept: 11, complete: 12 }, routeReachable: true, entry: null, dungeon: null, objectiveComplete: false, dungeonObjectiveComplete: false, combatSettled: false, eligibleNpcIDs: [99], gates: [], wallet: 1000, lp: 10, credits: [] }; }
function offer(missionID: number, status: "offered" | "accepted"): Offer { return { agentID: 4, missionID, titleID: 12, expirationTime: `expiration-${missionID}`, key: JSON.stringify([4,missionID,12,`expiration-${missionID}`]), status, contentID: 2504, dungeonID: 875, dungeonCount: 1, otherObjectives: 0, shipRestricted: false, destinationSystemID: 6, locationNumber: 0, expectedISK: 100 }; }
function fixture() {
  const folder=mkdtempSync(path.join(tmpdir(),"uoc-security-"));
  const store=createDocumentStore(path.join(folder,"journal.sqlite")), storage=store.document("security:1:2");
  const journal=createSecurityJournal(storage,{accountID:1,characterID:2,runID:"run"});
  let now=100, obs=observation(), calls: string[] = [], throwIssue = false;
  const coordinator=createSecurityCoordinator({ journal, now:()=>now, observe:async()=>({...obs,observedAt:now}),
    execute:async (command, current)=>{ current(); calls.push(command.kind); if (throwIssue) throw new Error("uncertain"); return command.kind === "COMPLETE" ? {completed:true} : undefined; },
    combat:async (_id,current)=>{current();calls.push("combat");}, settle:async current=>{current();calls.push("settle");} });
  return { folder,store,storage,journal,coordinator,calls, set(patch:Partial<Observation>){obs={...obs,...patch};now++;}, fail(){throwIssue=true;}, now:()=>now };
}
test("two distinct missions count only after exact terminal and attributed rewards", async () => {
  const f=fixture(); try {
    await f.journal.save(null,initial());
    for(let n=1;n<=2;n++) {
      await f.coordinator.tick(); assert.equal(f.calls.at(-1),"REQUEST");
      f.set({mission:offer(100+n,"offered")}); await f.coordinator.tick(); await f.coordinator.tick(); assert.equal(f.calls.at(-1),"ACCEPT");
      f.set({mission:offer(100+n,"accepted")}); await f.coordinator.tick();
      await f.coordinator.tick(); assert.equal(f.calls.at(-1),"ROUTE_SYSTEM");
      f.set({inSpace:true,dockedStationID:null}); await f.coordinator.tick(); await f.coordinator.tick(); assert.equal(f.calls.at(-1),"MISSION_WARP");
      const entry={sequence:n,at:f.now()+1,characterID:2,shipID:3,dungeonID:875,instanceID:200+n,roomID:1,landed:true,onEntryGrid:true};
      f.set({entry,dungeon:{dungeonID:875,instanceID:200+n,roomID:1}}); await f.coordinator.tick(); await f.coordinator.tick(); assert.equal(f.calls.at(-1),"combat");
      f.set({objectiveComplete:true,dungeonObjectiveComplete:true}); await f.coordinator.tick();
      f.set({combatSettled:true}); await f.coordinator.tick(); await f.coordinator.tick(); assert.equal(f.calls.at(-1),"ROUTE_AGENT");
      f.set({dockedStationID:5,inSpace:false}); await f.coordinator.tick(); await f.coordinator.tick(); assert.equal(f.calls.at(-1),"COMPLETE");
      const before=await f.journal.read(); assert.equal(before?.completed.length,n-1);
      f.set({mission:null,wallet:1000+n*100,lp:10+n*5,credits:[{transactionID:300+n,kind:33,isk:100,taxISK:0,characterID:2,agentID:4,issuedAtOrAfter:true}]}); await f.coordinator.tick();
      assert.equal((await f.journal.read())?.completed.length,n);
      f.set({mission:null,objectiveComplete:false,dungeonObjectiveComplete:false,combatSettled:false,eligibleNpcIDs:[99],credits:[],entry:null,dungeon:null});
    }
    assert.equal((await f.journal.read())?.phase,"DONE");
  } finally { f.store.close();rmSync(f.folder,{recursive:true,force:true}); }
});
test("dispatch uncertainty persists and is never replayed", async () => {
 const f=fixture();try {await f.journal.save(null,initial());f.fail();await assert.rejects(f.coordinator.tick(),/uncertain/);await f.coordinator.tick();assert.deepEqual(f.calls,["REQUEST"]);assert.equal((await f.journal.read())?.pending?.status,"DISPATCHED");}finally{f.store.close();rmSync(f.folder,{recursive:true,force:true});}
});
test("owner mismatch blocks before mutation and corrupt journal retains evidence", async () => {
 const f=fixture();try{await f.journal.save(null,initial());f.set({characterID:9});await f.coordinator.tick();assert.equal((await f.journal.read())?.phase,"BLOCKED");assert.deepEqual(f.calls,[]);f.storage.write({broken:true});await assert.rejects(f.journal.read());assert.deepEqual(f.storage.read(),{broken:true});}finally{f.store.close();rmSync(f.folder,{recursive:true,force:true});}
});

test("wrong native entry dungeon blocks combat before commands", async () => {
 const f=fixture();try{
   const m=offer(101,"accepted"), identity={agentID:4,missionID:m.missionID,titleID:m.titleID,acceptedKey:m.key,contentID:2504,dungeonID:875,destinationSystemID:6,locationNumber:0,instanceID:201,roomID:1};
   await f.journal.save(null,{...initial(),phase:"COMBAT",identity,offer:offer(101,"offered")});
   f.set({mission:m,dockedStationID:null,inSpace:true,dungeon:{dungeonID:875,instanceID:201,roomID:1},entry:{sequence:1,at:100,characterID:2,shipID:3,dungeonID:999,instanceID:201,roomID:1,landed:true,onEntryGrid:true}});
   await f.coordinator.tick();assert.equal((await f.journal.read())?.phase,"BLOCKED");assert.deepEqual(f.calls,[]);
 }finally{f.store.close();rmSync(f.folder,{recursive:true,force:true});}
});
test("unattributed rewards do not block a proven completion", async () => {
 const f=fixture();try{
  const m=offer(101,"accepted"), identity={agentID:4,missionID:m.missionID,titleID:m.titleID,acceptedKey:m.key,contentID:2504,dungeonID:875,destinationSystemID:6,locationNumber:0,instanceID:201,roomID:1};
  const pending={id:"cmd",kind:"COMPLETE" as const,characterID:2,shipID:3,agentID:4,missionKey:m.key,targetID:null,actionID:12,issuedAt:100,afterSequence:1,fromRoomID:1,destinationSystemID:null,locationNumber:null,status:"ACKNOWLEDGED" as const,completionConfirmed:true};
  await f.journal.save(null,{...initial(),phase:"COMPLETE",identity,offer:offer(101,"offered"),pending,before:{wallet:1000,lp:10}});
  f.set({mission:null,wallet:1100,lp:15,credits:[{transactionID:301,kind:33,isk:100,taxISK:0,characterID:999,agentID:4,issuedAtOrAfter:true}]});await f.coordinator.tick();
  const saved=await f.journal.read();assert.equal(saved?.completed.length,1);assert.equal(saved?.completed[0]?.isk,null);assert.equal(saved?.pending,null);assert.deepEqual(f.calls,[]);
 }finally{f.store.close();rmSync(f.folder,{recursive:true,force:true});}
});

test("narrow fleet content policy blocks an unsupported offered mission before Accept",async()=>{const f=fixture();try{await f.journal.save(null,initial());let obs=observation(),calls:string[]=[];const c=createSecurityCoordinator({journal:f.journal,now:()=>100,observe:async()=>obs,allowOffer:m=>m.contentID===2925&&m.dungeonID===1940||m.contentID===13735&&m.dungeonID===3030,execute:async cmd=>{calls.push(cmd.kind)},combat:async()=>{},settle:async()=>{}});await c.tick();obs={...obs,mission:offer(101,"offered")};await c.tick();assert.equal((await f.journal.read())?.phase,"BLOCKED");assert.deepEqual(calls,["REQUEST"]);}finally{f.store.close();rmSync(f.folder,{recursive:true,force:true});}});

test("a third distinct acknowledged completion meets a count of three",async()=>{
 const f=fixture();try{
  const m=offer(103,"accepted"),identity={agentID:4,missionID:m.missionID,titleID:m.titleID,acceptedKey:m.key,contentID:2504,dungeonID:875,destinationSystemID:6,locationNumber:0,instanceID:203,roomID:1};
  const completed=[101,102].map((n)=>({identity:{...identity,missionID:n,acceptedKey:offer(n,"accepted").key},commandID:`old-${n}`,expectedISK:100,isk:null,taxISK:null,lp:null,transactionIDs:[]}));
  const pending={id:"third",kind:"COMPLETE" as const,characterID:2,shipID:3,agentID:4,missionKey:m.key,targetID:null,actionID:12,issuedAt:100,afterSequence:1,fromRoomID:1,destinationSystemID:null,locationNumber:null,status:"ACKNOWLEDGED" as const,completionConfirmed:true};
  await f.journal.save(null,{...initial(),missionLimit:3,phase:"COMPLETE",identity,offer:offer(103,"offered"),pending,before:null,completed});
  f.set({mission:null});await f.coordinator.tick();const saved=await f.journal.read();assert.equal(saved?.completed.length,3);assert.equal(saved?.phase,"DONE");assert.equal(saved?.completed[2]?.commandID,"third");assert.deepEqual(f.calls,[]);
 }finally{f.store.close();rmSync(f.folder,{recursive:true,force:true});}
});

test("a timed run continues after a confirmed mission until its time fence",async()=>{const f=fixture();try{const m=offer(101,"accepted"),identity={agentID:4,missionID:m.missionID,titleID:m.titleID,acceptedKey:m.key,contentID:2504,dungeonID:875,destinationSystemID:6,locationNumber:0,instanceID:201,roomID:1},pending={id:"timed-complete",kind:"COMPLETE" as const,characterID:2,shipID:3,agentID:4,missionKey:m.key,targetID:null,actionID:12,issuedAt:100,afterSequence:1,fromRoomID:1,destinationSystemID:null,locationNumber:null,status:"ACKNOWLEDGED" as const,completionConfirmed:true};await f.journal.save(null,{...initial(),missionLimit:null,phase:"COMPLETE",identity,offer:offer(101,"offered"),pending,before:null});f.set({mission:null});await f.coordinator.tick();const saved=await f.journal.read();assert.equal(saved?.completed.length,1);assert.equal(saved?.phase,"AGENT");assert.equal(saved?.pending,null);}finally{f.store.close();rmSync(f.folder,{recursive:true,force:true});}});

test("acknowledged Request resolves only from an exact positively observed unqualified offer",async()=>{const f=fixture();try{await f.journal.save(null,initial());await f.coordinator.tick();f.set({mission:null,unqualifiedOffer:{agentID:4,missionID:4901,missionKey:'[4,4901,70,"123"]'}});await f.coordinator.tick();const state=await f.journal.read();assert.equal(state?.pending,null);assert.equal(state?.phase,'BLOCKED');assert.equal(state?.unqualifiedOffer?.missionID,4901);assert.deepEqual(f.calls,['REQUEST']);}finally{f.store.close();rmSync(f.folder,{recursive:true,force:true});}});
test("unacknowledged Request and preexisting unqualified offer never cause a second Request",async()=>{const f=fixture();try{await f.journal.save(null,initial());f.fail();await assert.rejects(f.coordinator.tick());f.set({unqualifiedOffer:{agentID:4,missionID:4901,missionKey:'exact'}});await f.coordinator.tick();assert.equal((await f.journal.read())?.pending?.status,'DISPATCHED');assert.deepEqual(f.calls,['REQUEST']);}finally{f.store.close();rmSync(f.folder,{recursive:true,force:true});}});
