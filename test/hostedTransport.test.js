"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const { bridgeDo, jettisonItems, loadBoundFleet, getSpaceSnapshot } = require("../web/src/app/api.ts");
const {
  bridgeLane, hostedFetch, hostedLane, hostedRequestWaitsByDesign, HOSTED_MAX_IN_FLIGHT, HOSTED_PLACE_CHANGE_CALLS,
  MAX_IN_FLIGHT,
} = require("../web/src/app/transport.ts");
const { PAGE_PLACE_CHANGE_CALLS } = require("../src/bridgeCallPolicy");

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
  const cancelled = bridgeDo({ fetch, signal: abort.signal })("ship", "Jettison", [[1]]);
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

// The 2026-11-22 stall reproduction: the live server freezes for 20 s and more several times a day. The requests in
// the slots wait it out at the server; a stop queued behind them must not fail before they do.
test("a hosted stop queued through a 25 s server stall is sent when the server answers again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stall = Promise.withResolvers();
  const sent = [];
  const fetch = hostedFetch(async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const method = body.method ?? url;
    sent.push(method);
    if (method !== "CmdStop") await stall.promise;
    return Response.json({ ok: true, service: body.service, method, result: null });
  }, "pilot", () => true);
  const occupied = Array.from({ length: HOSTED_MAX_IN_FLIGHT }, () => fetch("/api/held"));
  const stop = bridgeDo({ fetch })("beyonce", "CmdStop", []);
  t.mock.timers.tick(25_000);
  stall.resolve();
  await Promise.all(occupied);
  assert.equal(await stop, null);
  assert.equal(sent.at(-1), "CmdStop");
});

test("place changes and the hosted jettison hold no hosted slot", { timeout: 2000 }, async () => {
  const jumps = Promise.withResolvers();
  const sent = [];
  const fetch = hostedFetch(async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    sent.push(body.method ?? new URL(url, "http://bff.test").pathname);
    if (body.method === "CmdStargateJump" || url.endsWith("/jettison")) await jumps.promise;
    return Response.json({ ok: true, service: body.service, method: body.method, result: null });
  }, "pilot", () => true);
  // A fleet jumps together, and more pilots jettison than there are slots.
  const before = hostedLane.inFlight();
  const held = [
    ...Array.from({ length: HOSTED_MAX_IN_FLIGHT }, (_, i) => bridgeDo({ fetch })("beyonce", "CmdStargateJump", [i, 100 + i, 9001])),
    ...Array.from({ length: HOSTED_MAX_IN_FLIGHT }, (_, i) => jettisonItems([i], { fetch })),
  ];
  try {
    assert.equal(hostedLane.inFlight(), before);
    assert.equal(await bridgeDo({ fetch })("beyonce", "CmdStop", []), null, "a stop is not held behind them");
  } finally {
    jumps.resolve();
    await Promise.allSettled(held);
  }
  assert.equal(sent.filter(method => method === "CmdStargateJump").length, HOSTED_MAX_IN_FLIGHT);
});

test("the hosted place changes are the BFF's own", () => {
  assert.deepEqual([...HOSTED_PLACE_CHANGE_CALLS].sort(), [...PAGE_PLACE_CHANGE_CALLS.keys()].sort());
  const call = (service, method, args) => ({ body: JSON.stringify({ service, method, args }) });
  assert.equal(hostedRequestWaitsByDesign("/api/bridge/call", call("beyonce", "CmdDock", [1, 2])), true);
  assert.equal(hostedRequestWaitsByDesign("/api/bridge/call", call("dogmaIM", "AddTarget", [1])), false);
  // A filament changes place in solo's game mode alone (bridgeCallPolicy.js placeChangeOf).
  assert.equal(hostedRequestWaitsByDesign("/api/bridge/call", call("abyssalMgr", "AbyssalEntranceDeployment", [1, 1])), true);
  assert.equal(hostedRequestWaitsByDesign("/api/bridge/call", call("abyssalMgr", "AbyssalEntranceDeployment", [1, 2])), false);
  assert.equal(hostedRequestWaitsByDesign("/api/bridge/call", { body: "not json" }), false);
  assert.equal(hostedRequestWaitsByDesign("http://bff.test/api/bridge/ship/jettison/reconcile", { body: "{}" }), true);
});

test("in a tab, a bot's confirmed write does not go ahead of the player's own read", { timeout: 2000 }, async () => {
  const held = Promise.withResolvers();
  const sent = [];
  // A fetch of the tab's own: no hosted route, so the tab's lane.
  const fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const name = body.method ?? new URL(url, "http://bff.test").pathname;
    sent.push(name);
    if (name === "/api/held") await held.promise;
    return Response.json({ ok: true, service: body.service, method: body.method, result: null });
  };
  const before = bridgeLane.inFlight();
  const occupied = Array.from({ length: MAX_IN_FLIGHT - before }, () => bridgeLane.run("read", "/api/held", () => fetch("/api/held")));
  const botWrite = bridgeDo({ fetch })("dogmaIM", "AddTarget", [1]);
  const playerRead = loadBoundFleet({ fetch, priority: "user" });
  held.resolve();
  await Promise.all([...occupied, botWrite, playerRead]);
  assert.deepEqual(sent.filter(name => name !== "/api/held"), ["/api/bridge/bound-fleet", "AddTarget"]);
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
      // The page's own jettison (bridge/shipWrites.ts): the generic call, which holds a slot like any command.
      // The hosted jettison route waits by design and holds none (see the tests below).
      const jettisonStart = performance.now();
      work.push(bridgeDo(options)("ship", "Jettison", [[pilot]]).then(() => latency.Jettison.push(performance.now() - jettisonStart)));
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
