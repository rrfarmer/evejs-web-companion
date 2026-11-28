import test from "node:test";
import assert from "node:assert/strict";
import {bridgeDo} from "../../../web/src/app/api.ts";
import {bridgeLane,hostedFetch,hostedLane,HOSTED_MAX_IN_FLIGHT,MAX_IN_FLIGHT} from "../../../web/src/app/transport.ts";
import {createPilotTiming} from "./timing.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return {promise, resolve};
}

test("command timing separates a previous pass, lane admission and the native reply", {timeout:1500}, async t => {
  t.mock.timers.enable({apis:["Date"], now:1_000});
  const events: Record<string, unknown>[] = [];
  const timing = createPilotTiming({operationID:"op",operationRunID:"run",characterID:1,shipID:11,role:"DEFENDER"},
    line => events.push(JSON.parse(line.slice("[mcc-timing] ".length))), false);
  timing.beginPass();
  t.mock.timers.tick(200);
  timing.endPass();
  t.mock.timers.tick(300);
  timing.beginPass();
  timing.note("verbose-only");
  const blocked = deferred<void>(), received = deferred<void>();
  const reply = deferred<Response>();
  const occupied = Array.from({length:4}, (_, i) => bridgeLane.run("read", "/mock/" + i, () => blocked.promise));
  const send = bridgeDo({baseUrl:"http://mock", token:"", fetch:timing.wrapFetch(async () => {
    received.resolve();
    return reply.promise;
  })});
  t.mock.timers.tick(200);
  const attempt = timing.command("AddTarget", {targetID:901, selectedAtMs:1_600}, () => send("dogmaIM", "AddTarget", [901]));
  try {
    t.mock.timers.tick(6_000);
    blocked.resolve();
    await received.promise;
    assert.equal(events.length,0);
    t.mock.timers.tick(20);
  } finally {
    blocked.resolve();
    reply.resolve(Response.json({ok:true,service:"dogmaIM",method:"AddTarget",result:null}));
    await Promise.all([...occupied, attempt]);
  }
  assert.equal(events.length,1);
  assert.deepEqual({...events[0], at:undefined}, {
    at:undefined, operationID:"op",operationRunID:"run",characterID:1,shipID:11,role:"DEFENDER",
    event:"command-timing", command:"AddTarget", targetID:901, passStartedAtMs:1_500, priorPassStartedAtMs:1_000,
    priorPassFinishedAtMs:1_200, selectedAtMs:1_600, submittedAtMs:1_700, admittedAtMs:7_700,
    transportWaitMs:6_000, finishedAtMs:7_720, outcome:"replied",
  });
});

test("pickup timing counts lane admission for the exact source can and ship",async t=>{
 t.mock.timers.enable({apis:["Date"],now:1000});
 const events:Record<string,unknown>[]=[];
 const timing=createPilotTiming({operationID:"op",operationRunID:"run",characterID:3,shipID:13,role:"HAULER"},
  line=>events.push(JSON.parse(line.slice("[mcc-timing] ".length))));
 const fetch=timing.wrapFetch(async()=>Response.json({ok:true}));
 const request=(of:number,containerID:number)=>fetch("http://mock/api/bridge/call",{
  method:"POST",body:JSON.stringify({service:"invbroker",method:"MultiAdd",of,args:[[50,51],containerID]}),
 });
 await timing.command("MultiAdd",{containerID:100},async()=>{
  t.mock.timers.tick(100);await request(700,100);
  t.mock.timers.tick(300);await request(13,99);
  t.mock.timers.tick(600);await request(13,100);
  t.mock.timers.tick(15);
 });
 assert.equal(events[0]?.transportWaitMs,1000);
 assert.equal(events[0]?.finishedAtMs,2015);
});

test("timing keeps the hosted slot and write priority while every browser slot is busy", {timeout:1500}, async t => {
  t.mock.timers.enable({apis:["Date"], now:1_000});
  const events:Record<string,unknown>[]=[];
  const timing=createPilotTiming({operationID:"op",operationRunID:"run",characterID:7,shipID:11,role:"DEFENDER"},
    line=>events.push(JSON.parse(line.slice("[mcc-timing] ".length))));
  const browser=deferred<void>(), hosted=deferred<void>();
  const browserCalls=Array.from({length:MAX_IN_FLIGHT},()=>bridgeLane.run("read","/browser",()=>browser.promise));
  const hostedCalls=Array.from({length:HOSTED_MAX_IN_FLIGHT},()=>hostedLane.run("read","/hosted",()=>hosted.promise));
  const seen:unknown[]=[];
  const fetch=hostedFetch(async (_url,_init,priority)=>{
    seen.push(priority);
    return Response.json({ok:true,service:"dogmaIM",method:"AddTarget",result:null});
  },"7",()=>true);
  const send=bridgeDo({baseUrl:"http://mock",token:"",fetch:timing.wrapFetch(fetch)});
  const command=timing.command("AddTarget",{targetID:901},()=>send("dogmaIM","AddTarget",[901]));
  try {
    assert.equal(hostedLane.queued(),1);
    assert.equal(bridgeLane.queued(),0);
    t.mock.timers.tick(35);
    hosted.resolve();
    await command;
    assert.deepEqual(seen,["user"]);
    assert.equal(events[0]?.transportWaitMs,35);
    assert.equal(bridgeLane.inFlight(),MAX_IN_FLIGHT);
  } finally {
    browser.resolve();
    hosted.resolve();
    await Promise.allSettled([...browserCalls,...hostedCalls,command]);
  }
});
