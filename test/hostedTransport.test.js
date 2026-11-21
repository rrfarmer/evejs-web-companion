"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const { bridgeDo, jettisonItems, loadBoundFleet, getSpaceSnapshot } = require("../web/src/app/api.ts");
const { hostedFetch, HOSTED_MAX_IN_FLIGHT } = require("../web/src/app/transport.ts");

test("a queued hosted command can retire without reaching the BFF", { timeout: 2000 }, async () => {
  const hold = Promise.withResolvers();
  let writes = 0;
  const fetch = hostedFetch(async url => {
    if (!url.endsWith("/held")) writes++;
    await hold.promise;
    return Response.json({ ok: true });
  }, "pilot", () => true);
  const occupied = Array.from({ length: HOSTED_MAX_IN_FLIGHT }, () => fetch("/api/held"));
  const abort = new AbortController();
  const cancelled = jettisonItems([1], { fetch, signal: abort.signal });
  const retired = bridgeDo({ fetch, beforeDispatch() { throw new Error("retired generation"); } })("dogmaIM", "AddTarget", [1]);
  try {
    abort.abort(new Error("pilot stopped"));
    await assert.rejects(cancelled, /pilot stopped.*Hosted BFF/);
  } finally {
    hold.resolve();
    await Promise.all(occupied);
  }
  await assert.rejects(retired, /retired generation.*Hosted BFF/);
  assert.equal(writes, 0);
});

for (const count of [5, 10, 20, 50]) {
  test(`a synchronous burst from ${count} pilots shares the hosted budget and turns`, { timeout: 5000 }, async t => {
    const order = [];
    const latency = { AddTarget: [], Jettison: [] };
    let active = 0;
    let peak = 0;
    const pilots = Array.from({ length: count }, (_, pilot) => {
      async function reply(url, init, priority) {
        const body = init.body ? JSON.parse(init.body) : {};
        const method = body.method ?? (url.endsWith("/jettison") ? "Jettison"
          : url.endsWith("/snapshot") ? "poll" : "fleet");
        order.push({ pilot, method, priority });
        peak = Math.max(peak, ++active);
        try {
          await delay(method === "fleet" ? 16 : 2);
          return Response.json({ ok: true, service: body.service, method, result: pilot });
        } finally {
          active--;
        }
      }
      return { baseUrl: "http://bff.test", fetch: hostedFetch(reply, String(pilot), () => true) };
    });
    // Queue background work first, then both writes of each pilot together, while slow reads occupy all slots.
    const work = pilots.flatMap(options => [loadBoundFleet(options), loadBoundFleet(options)]);
    work.push(...pilots.map(options => getSpaceSnapshot({ ...options, priority: "poll" })));
    for (const [pilot, options] of pilots.entries()) {
      const start = performance.now();
      work.push(bridgeDo(options)("dogmaIM", "AddTarget", [pilot]).then(result => {
        latency.AddTarget.push(performance.now() - start);
        assert.equal(result, pilot);
      }));
      const jettisonStart = performance.now();
      work.push(jettisonItems([pilot], options).then(() => latency.Jettison.push(performance.now() - jettisonStart)));
    }
    await Promise.all(work);
    assert.equal(peak, HOSTED_MAX_IN_FLIGHT);
    assert.equal(order.length, count * 5);
    const ids = pilots.map((_, pilot) => pilot);
    const afterFill = order.slice(peak);
    assert.deepEqual(afterFill.slice(0, 2 * count).map(({ pilot, method, priority }) => [pilot, method, priority]),
      ["AddTarget", "Jettison"].flatMap(method => ids.map(pilot => [pilot, method, "user"])));
    assert.ok(afterFill.slice(2 * count, -count).every(entry => entry.method === "fleet" && entry.priority === "read"));
    assert.deepEqual(afterFill.slice(-count).map(({ pilot, priority }) => [pilot, priority]), ids.map(pilot => [pilot, "poll"]));
    for (const [method, times] of Object.entries(latency)) {
      times.sort((a, b) => a - b);
      t.diagnostic(`${method} call to parsed reply, ms: p50 ${times[Math.ceil(count * .5) - 1].toFixed(1)}, p95 ${times[Math.ceil(count * .95) - 1].toFixed(1)}`);
    }
  });
}
