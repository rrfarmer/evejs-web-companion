"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHostedEventSource } = require("../web/src/app/hostedEventSource.ts");
const settle = () => new Promise(resolve => setImmediate(resolve));
const encoder = new TextEncoder();
function fixture() {
  let writer, cancelled = false, timer = null, cleared = false, requests = [];
  const body = new ReadableStream({ start(controller) { writer = controller; }, cancel() { cancelled = true; } });
  const source = createHostedEventSource("http://127.0.0.1/api/bridge/events?token=private", {
    fetch: async (url, init) => { requests.push({url,init}); return new Response(body, {headers:{"content-type":"text/event-stream"}}); },
    setTimeout(callback, delay) { timer = { callback, delay, unref() {} }; return timer; },
    clearTimeout(handle) { assert.equal(handle, timer); cleared = true; },
  });
  return {source,write: value => writer.enqueue(typeof value === "string" ? encoder.encode(value) : value),
    end: () => writer.close(), get cancelled(){return cancelled;}, get timer(){return timer;}, get cleared(){return cleared;},requests};
}
test("hosted events decode split UTF-8, CRLF and multiline data on the ordinary BFF channel", async () => {
  const f=fixture(), messages=[];let opens=0;
  f.source.onmessage=event=>messages.push(event.data);f.source.onopen=()=>opens++;
  await settle();
  const text=encoder.encode('data: {"pilot":"Пилот"}\r\n\r\n');
  const split=text.indexOf(0xd0)+1;
  f.write(text.slice(0,split));f.write(text.slice(split));
  f.write(': heartbeat\n\ndata: one\ndata: two\n\n');await settle();
  assert.deepEqual(messages,['{"pilot":"Пилот"}','one\ntwo']);assert.equal(opens,1);
  assert.equal(f.requests[0].init.redirect,"error");
  assert.equal(f.requests[0].init.headers.accept,"text/event-stream");
  f.source.close();await settle();assert.equal(f.cancelled,true);
});
test("an ended stream reports degradation and schedules a bounded reconnect that Stop cancels", async () => {
  const f=fixture();let errors=0;f.source.onerror=()=>errors++;await settle();f.end();await settle();
  assert.equal(errors,1);assert.equal(f.timer.delay,3000);
  f.source.close();assert.equal(f.cleared,true);
  f.timer.callback();await settle();assert.equal(f.requests.length,1);
});
test("close cancels a blocked stream, aborts its request and emits no late event or retry", async () => {
  const f=fixture();let events=0;f.source.onmessage=()=>events++;f.source.onerror=()=>events++;
  await settle();f.source.close();await settle();
  assert.equal(f.requests[0].init.signal.aborted,true);assert.equal(f.cancelled,true);
  assert.equal(events,0);assert.equal(f.timer,null);
});
test("oversized or unterminated frames fail closed without passing partial data", async () => {
  const f=fixture();let events=0,errors=0;f.source.onmessage=()=>events++;f.source.onerror=()=>errors++;
  await settle();f.write('data: '+ 'x'.repeat(1024*1024+1));await settle();
  assert.equal(events,0);assert.equal(errors,1);assert.equal(f.cancelled,true);f.source.close();
});
test("empty data lines consume the frame budget too", async () => {
  const f=fixture();let errors=0;f.source.onerror=()=>errors++;await settle();
  for(let i=0;i<23;i++)f.write('data:\n'.repeat(8192));
  await settle();assert.equal(errors,1);assert.equal(f.cancelled,true);f.source.close();
});
test("closing from onopen does not leave a reader or reconnect behind", async () => {
  const f=fixture();f.source.onopen=()=>f.source.close();await settle();
  assert.equal(f.cancelled,true);assert.equal(f.timer,null);
});
