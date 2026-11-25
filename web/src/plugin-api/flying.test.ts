import assert from "node:assert/strict";
import test from "node:test";
import { createAppFlow } from "../app/flow.ts";
import { bridgeLane, hostedFetch, hostedLane, HOSTED_MAX_IN_FLIGHT, MAX_IN_FLIGHT } from "../app/transport.ts";
import { BridgeCallError } from "../bridge/callMethod.ts";
import { createClientStore } from "../store/clientStore.ts";
import type { PilotFlying } from "./flying.ts";

const baseUrl = "http://bff.test";
const observationPath = "/api/bridge/script/observation";
const callPath = "/api/bridge/call";

function pilot(characterID: number, send: Parameters<typeof hostedFetch>[0], store = createClientStore(),
  fetch: typeof globalThis.fetch = hostedFetch(send, String(characterID), () => true)) {
  const character = { characterID, characterName: "Pilot " + characterID, stationID: null,
    structureID: null, solarSystemID: 7, corporationID: 11 };
  store.apply({ type: "character/online", character, station: null });
  return createAppFlow(store, { baseUrl, livePush: false, perSessionToken: true,
    initialSessionToken: "pilot-" + characterID, fetch });
}

/** Requests from another pilot fill the real hosted lane until the test releases them. */
function occupySlots() {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const fetch = hostedFetch(async () => { await hold; return new Response(); }, "other", () => true);
  const requests = Array.from({ length: HOSTED_MAX_IN_FLIGHT }, () => fetch(baseUrl + "/api/held"));
  assert.equal(hostedLane.inFlight(), HOSTED_MAX_IN_FLIGHT);
  return async () => { release(); await Promise.all(requests); };
}

function waitForAbort(signal: AbortSignal) {
  return new Promise<Response>((_, reject) => {
    signal.throwIfAborted();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

test("the two reads use their pilot's session and the normal observation and bridge envelopes", async () => {
  const calls: { path: string; method?: string; token: string | null; body: unknown }[] = [];
  const send: Parameters<typeof hostedFetch>[0] = async (url, init, priority) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    assert.equal(priority, "read");
    assert.equal(init?.credentials, "omit");
    calls.push({ path, method: init?.method, token: new Headers(init?.headers).get("authorization"), body });
    return path === observationPath
      ? Response.json({ ok: true, space: { shipID: 41 }, activeShipID: 41, bay: [12], inSpace: [13] })
      : Response.json({ ok: true, service: body.service, method: body.method, result: [17] });
  };
  const first = pilot(1, send), second = pilot(2, send);
  const scene = await first.flying.readObservation();
  assert.deepEqual([scene.space, scene.activeShipID, scene.bay, scene.inSpace], [{ shipID: 41 }, 41, [12], [13]]);
  assert.deepEqual(await second.flying.bridgeAsk("invbroker", "List", [], { flag: 5 }, 52), [17]);
  // An ApiOptions value kept by a plugin is structurally compatible. Only its signal is accepted.
  const otherPilotOptions = { ...first.requestOptions(), signal: new AbortController().signal };
  await second.flying.readObservation(otherPilotOptions);
  await second.flying.bridgeAsk("charMgr", "GetRecentShipKillsAndLosses", [25, null], undefined, undefined, otherPilotOptions);
  assert.deepEqual(calls, [
    { path: observationPath, method: "GET", token: "Bearer pilot-1", body: null },
    { path: callPath, method: "POST", token: "Bearer pilot-2",
      body: { service: "invbroker", method: "List", args: [], kwargs: { flag: 5 }, of: 52, pilot: true } },
    { path: observationPath, method: "GET", token: "Bearer pilot-2", body: null },
    { path: callPath, method: "POST", token: "Bearer pilot-2",
      body: { service: "charMgr", method: "GetRecentShipKillsAndLosses", args: [25, null], kwargs: null, pilot: true } },
  ]);
});

test("every kind of cancelled read rejects the same way", async () => {
  const kinds: ((flying: PilotFlying, signal: AbortSignal) => Promise<unknown>)[] = [
    (flying, signal) => flying.readObservation({ signal }),
    (flying, signal) => flying.bridgeAsk("charMgr", "GetRecentShipKillsAndLosses", [25, null], undefined, undefined, { signal }),
    (flying, signal) => flying.bridgeAsk("invbroker", "List", [5], null, 41, { signal }),
  ];
  for (const read of kinds) {
    const caller = new AbortController();
    const request = read(pilot(1, async (_, init) => waitForAbort(init!.signal!)).flying, caller.signal);
    caller.abort(new Error("given up on"));
    await assert.rejects(request, error => error instanceof BridgeCallError && error.code === "BRIDGE_NETWORK_ERROR"
      && /given up on/.test(error.message));
  }
});

const reads: Record<string, (flying: PilotFlying, signal?: AbortSignal) => Promise<unknown>> = {
  readObservation: (flying, signal) => flying.readObservation({ signal }),
  bridgeAsk: (flying, signal) => flying.bridgeAsk("charMgr", "GetRecentShipKillsAndLosses", [25, null],
    undefined, undefined, { signal }),
};

test("a loss-history bridge read uses the caller's own deadline", async t => {
  const caller = new AbortController();
  const timeout = t.mock.method(AbortSignal, "timeout");
  const flow = pilot(1, async (_url, init) => waitForAbort(init!.signal!));
  const request = flow.flying.bridgeAsk("charMgr", "GetRecentShipKillsAndLosses", [25, null],
    undefined, undefined, { signal: caller.signal });
  caller.abort(new Error("loss-history deadline"));
  await assert.rejects(request, /loss-history deadline/);
  assert.deepEqual(timeout.mock.calls.map(call => call.arguments), [[65_000]], "the default timeout stays beside the caller's signal");
});

test("a read of a locked container is given up on at its password prompt", async () => {
  const caller = new AbortController();
  const calls: string[] = [];
  const flow = pilot(1, async (url, init) => {
    if (new URL(String(url)).pathname !== callPath) return Response.json({ ok: true });
    const { service, method } = JSON.parse(String(init?.body));
    calls.push(service + "." + method);
    return Response.json({ ok: false, error: "CALL_REFUSED", refusal: { key: "SCGeneralPasswordRequired" } }, { status: 409 });
  });
  const asked = () => new Promise<void>(resolve => {
    const stop = flow.inventoryPasswordAsked.subscribe(ask => { if (ask !== null) { resolve(); queueMicrotask(() => stop()); } });
  });
  const request = flow.flying.bridgeAsk("invbroker", "List", [5], null, 41, { signal: caller.signal });
  const rejected = assert.rejects(request, { code: "BRIDGE_NETWORK_ERROR", message: /container deadline/ });
  await asked();
  caller.abort(new Error("container deadline"));
  await rejected;
  assert.equal(flow.inventoryPasswordAsked.get(), null, "the prompt closes with the read that asked");
  assert.deepEqual(calls, ["invbroker.List"]);
});

test("a read given up on at a password prompt leaves the prompt to the read it took it from", async () => {
  const caller = new AbortController();
  const entered: unknown[] = [];
  let locked = true;
  const flow = pilot(1, async (url, init) => {
    if (new URL(String(url)).pathname !== callPath) return Response.json({ ok: true });
    const { service, method, args, of } = JSON.parse(String(init?.body));
    if (method === "EnterPassword") { entered.push([of, args]); locked = false; }
    else if (locked) return Response.json({ ok: false, error: "CALL_REFUSED", refusal: { key: "SCGeneralPasswordRequired" } }, { status: 409 });
    return Response.json({ ok: true, service, method, result: [17] });
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  const kept = flow.flying.bridgeAsk("invbroker", "List", [5], null, 41);
  await settle();
  const prompt = flow.inventoryPasswordAsked.get();
  assert.notEqual(prompt, null);
  const rejected = assert.rejects(flow.flying.bridgeAsk("invbroker", "List", [5], null, 42, { signal: caller.signal }),
    { code: "BRIDGE_NETWORK_ERROR" });
  await settle();
  caller.abort(new Error("cancelled"));
  await rejected;
  assert.equal(flow.inventoryPasswordAsked.get(), prompt);
  flow.answerInventoryPassword(prompt!.n, "open");
  assert.deepEqual(await kept, [17]);
  assert.deepEqual(entered, [[41, [1, "open"]]]);
});

test("the scoped bridge read keeps bound inventory's password challenge handling", async () => {
  const calls: string[] = [];
  const flow = pilot(1, async (_, init) => {
    const { service, method, args, confirm } = JSON.parse(String(init?.body));
    calls.push(service + "." + method);
    if (service === "invbroker") return Response.json({ ok: false, error: "CALL_REFUSED",
      refusal: { key: "PasswordProtectedCacheInvalid" } }, { status: 409 });
    assert.deepEqual(args, [21]);
    assert.equal(confirm, true);
    return Response.json({ ok: true, service, method, result: null });
  });
  await assert.rejects(flow.flying.bridgeAsk("invbroker", "List", [5, 21], null, 41,
    { signal: new AbortController().signal }), { message: "SCGeneralPasswordRequired" });
  assert.deepEqual(calls, ["invbroker.List", "invCache.InvalidateLocationCache"]);
});

for (const [method, read] of Object.entries(reads)) {
  test(method + " starts the default timeout when the local hosted lane admits the read", async t => {
    const deadline = new AbortController();
    const timer = t.mock.method(AbortSignal, "timeout", () => deadline.signal);
    let sent = 0;
    const flow = pilot(1, async (_, init) => { sent++; return waitForAbort(init!.signal!); });
    const release = occupySlots();
    const request = read(flow.flying);
    t.after(() => deadline.abort());
    try {
      assert.equal(hostedLane.queued(), 1);
      assert.equal(sent, 0);
      assert.equal(timer.mock.callCount(), 0);
    } finally { await release(); }
    assert.equal(sent, 1);
    assert.deepEqual(timer.mock.calls.map(call => call.arguments), [[65_000]]);
    deadline.abort(new Error("response deadline"));
    await assert.rejects(request, /response deadline/);
  });

  test(method + " discards a queued read when its pilot logs out", async () => {
    const sent: string[] = [];
    const flow = pilot(1, async url => {
      sent.push(new URL(String(url)).pathname);
      return Response.json({ ok: true });
    });
    const release = occupySlots();
    const rejected = assert.rejects(read(flow.flying),
      error => error instanceof BridgeCallError && error.code === "SESSION_REQUEST_RETIRED");
    const logout = flow.logout();
    try {
      assert.equal(flow.flying.isSessionClosing(), true);
      assert.deepEqual(sent, []);
    } finally { await release(); }
    await Promise.all([logout, rejected]);
    assert.deepEqual(sent, ["/api/logout"]);
    assert.equal(flow.sessionToken(), null);
  });

  test(method + " sends no queued read after Web Companion observes the pilot offline", async () => {
    let sent = 0;
    const store = createClientStore();
    const flow = pilot(1, async () => { sent++; return Response.json({ ok: true }); }, store);
    const release = occupySlots();
    const rejected = assert.rejects(read(flow.flying), { code: "SESSION_REQUEST_RETIRED" });
    try {
      assert.equal(hostedLane.queued(), 1);
      store.apply({ type: "character/offline" });
    } finally { await release(); }
    await rejected;
    assert.equal(sent, 0);
  });

  test(method + " discards an in-flight reply after the pilot goes offline", async () => {
    const store = createClientStore();
    let deliver!: (response: Response) => void;
    const flow = pilot(1, () => new Promise<Response>(resolve => { deliver = resolve; }), store);
    const request = read(flow.flying);
    store.apply({ type: "character/offline" });
    deliver(Response.json({ ok: true, space: {}, service: "charMgr", method: "GetRecentShipKillsAndLosses", result: [] }));
    await assert.rejects(request, { code: "SESSION_REQUEST_RETIRED" });
  });

  test(method + " can be cancelled while it waits for a lane of the page's own", async () => {
    let sent = 0;
    const flow = pilot(1, async () => Response.json({ ok: true }), createClientStore(),
      async () => { sent++; return Response.json({ ok: true }); });
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const held = Array.from({ length: MAX_IN_FLIGHT }, () => bridgeLane.run("read", "/api/held", () => hold));
    try {
      const caller = new AbortController(), request = read(flow.flying, caller.signal);
      assert.equal(bridgeLane.queued(), 1);
      caller.abort(new Error("cancelled before dispatch"));
      assert.equal(bridgeLane.queued(), 0);
      await assert.rejects(request, { code: "BRIDGE_NETWORK_ERROR", message: /cancelled before dispatch/ });
      assert.equal(sent, 0);
    } finally { release(); await Promise.all(held); }
  });

  test(method + " cancelled while its answer is read does not say the answer was bad", async () => {
    const caller = new AbortController();
    const flow = pilot(1, async (_, init) => new Response(new ReadableStream({
      pull(body) {
        init!.signal!.addEventListener("abort", () => body.error(init!.signal!.reason), { once: true });
        queueMicrotask(() => caller.abort(new Error("cancelled in the answer")));
        return new Promise<void>(() => {});
      },
    }, { highWaterMark: 0 })));
    await assert.rejects(read(flow.flying, caller.signal), { code: "BRIDGE_NETWORK_ERROR", message: /cancelled in the answer/ });
  });

  test(method + " still says an answer that is not JSON is a bad one", async () => {
    const flow = pilot(1, async () => new Response("<html>"));
    await assert.rejects(read(flow.flying, new AbortController().signal), { code: "BRIDGE_BAD_RESPONSE" });
  });

  test(method + " can be cancelled in the queue and after dispatch", async () => {
    let sent = 0;
    const flow = pilot(1, async (_, init) => { sent++; return waitForAbort(init!.signal!); });
    const release = occupySlots();
    try {
      const queued = new AbortController(), request = read(flow.flying, queued.signal);
      assert.equal(hostedLane.queued(), 1);
      queued.abort(new Error("cancelled before dispatch"));
      await assert.rejects(request, /cancelled before dispatch/);
      assert.equal(hostedLane.queued(), 0);
      assert.equal(sent, 0);
    } finally { await release(); }
    const active = new AbortController(), request = read(flow.flying, active.signal);
    assert.equal(sent, 1);
    active.abort(new Error("cancelled after dispatch"));
    await assert.rejects(request, /cancelled after dispatch/);
    assert.equal(hostedLane.inFlight(), 0);
  });
}
