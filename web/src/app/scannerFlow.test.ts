import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const emptyDict = { type: "dict", entries: [] } as const;
const SYSTEM_A = 30000142;
const SYSTEM_B = 30000144;

/** Where the page's own calls go. */
const CALL = "/api/bridge/call";
/**
 * sensorSuiteService (718, 722): scanSvc.GetScanMan().GetFullState(), as a pilot's read. It names no object: the
 * scan manager is the one for the system the session is in, and the BFF asks that one.
 */
const THE_SCAN = { service: "scanMgr", method: "GetFullState", args: [], kwargs: null, pilot: true };
/** The generic call's answer to it: the four parts, as the server sends them. */
function scanAnswer(result: unknown = [emptyDict, emptyDict, emptyDict, emptyDict]) {
  return { ok: true, service: "scanMgr", method: "GetFullState", result, notifications: [] };
}

function operationsEnvelope(solarSystemID = SYSTEM_A) {
  return {
    ok: true,
    scanner: {
      inSpace: true,
      solarSystemID,
      shipID: 9001,
      maxActiveProbes: 8,
      launcher: null,
      probes: [],
    },
  };
}

function flightIn(solarSystemID: number) {
  return {
    ok: true,
    flight: {
      inSpace: true,
      docked: false,
      solarSystemID,
      stationID: null,
      structureID: null,
      shipID: 9001,
      shipMode: "STOP",
      shipSpeedFraction: 0,
    },
    notifications: [],
  };
}

test("loadScanner asks the scan manager by the page's own call, and keeps a successful empty scan distinct from unavailable", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
    if (url === CALL) return json(scanAnswer());
    if (url === "/api/bridge/scanner/state") return json(operationsEnvelope());
    throw new Error(`unexpected fetch: ${url}`);
  };

  const store = createClientStore();
  await createAppFlow(store, { fetch }).loadScanner();

  // The one call and the probes' state, and nothing of the route that read the sites before.
  assert.deepEqual(calls.map((call) => call.url).sort(), [CALL, "/api/bridge/scanner/state"]);
  assert.deepEqual(calls.find((call) => call.url === CALL)!.body, THE_SCAN);
  const scanner = store.get().scanner;
  assert.equal(scanner.loaded, true);
  assert.equal(scanner.loading, false);
  assert.equal(scanner.solarSystemID, SYSTEM_A);
  assert.equal(scanner.scan.status, "ready");
  if (scanner.scan.status === "ready") {
    assert.deepEqual(scanner.scan.value.anomalies, []);
    assert.deepEqual(scanner.scan.value.signatures, []);
  }
  // The client's scanner asks nothing of the ballpark's formations, and neither does this: a request of the
  // route that read them, or a call for them, would have been an unexpected fetch above.
  assert.equal("formations" in scanner, false);
});

test("a scan the server refuses stays unavailable while the probes' state remains useful", async () => {
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === CALL) return json({ ok: false, error: "CALL_REFUSED", message: "scanner offline" }, 409);
    if (url === "/api/bridge/scanner/state") return json(operationsEnvelope());
    throw new Error(`unexpected fetch: ${url}`);
  };

  const store = createClientStore();
  await createAppFlow(store, { fetch }).loadScanner();

  const scanner = store.get().scanner;
  assert.deepEqual(scanner.scan, { status: "unavailable", reason: "Scanner data could not be read from the live session." });
  assert.equal(scanner.operations.status, "ready");
});

test("probe reconnect confirms the write and always follows it with authoritative reads", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: String(init.method ?? "GET"),
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    });
    if (url === "/api/bridge/scanner/reconnect") {
      return json({ ok: true, applied: true, result: null, notifications: [] });
    }
    if (url === CALL) return json(scanAnswer());
    if (url === "/api/bridge/scanner/state") return json(operationsEnvelope());
    throw new Error(`unexpected fetch: ${url}`);
  };

  const store = createClientStore();
  await createAppFlow(store, { fetch }).reconnectScannerProbes();

  assert.deepEqual(calls[0], {
    url: "/api/bridge/scanner/reconnect",
    method: "POST",
    body: { confirm: true },
  });
  assert.deepEqual(calls.slice(1).map((call) => call.url).sort(), [CALL, "/api/bridge/scanner/state"]);
  assert.deepEqual(calls.find((call) => call.url === CALL)!.body, THE_SCAN);
  assert.equal(store.get().scanner.scan.status, "ready");
});

test("launch, analyze, and recover use no-input product routes and re-read afterward", async () => {
  const actions = [
    ["launchScannerProbes", "/api/bridge/scanner/launch"],
    ["analyzeScannerSignatures", "/api/bridge/scanner/analyze"],
    ["recoverScannerProbes", "/api/bridge/scanner/recover"],
  ] as const;
  for (const [method, expectedPath] of actions) {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetch: typeof globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      calls.push({
        url,
        method: String(init.method ?? "GET"),
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      });
      if (url === expectedPath) return json({ ok: true, applied: true });
      if (url === CALL) return json(scanAnswer());
      if (url === "/api/bridge/scanner/state") return json(operationsEnvelope());
      throw new Error(`unexpected fetch: ${url}`);
    };
    const flow = createAppFlow(createClientStore(), { fetch });
    await flow[method]();
    assert.deepEqual(calls[0], {
      url: expectedPath,
      method: "POST",
      body: { confirm: true },
    });
    assert.deepEqual(calls.slice(1).map((call) => call.url).sort(), [CALL, "/api/bridge/scanner/state"], "one write, then the scanner's two reads");
  }
});

test("a system change clears the old scan and automatically reads the new system", async () => {
  let solarSystemID = SYSTEM_A;
  let scanReads = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === CALL) {
      scanReads += 1;
      return json(scanAnswer());
    }
    if (url === "/api/bridge/formations") return json({ ok: true, formations: null });
    if (url === "/api/bridge/scanner/state") return json(operationsEnvelope(solarSystemID));
    if (url === "/api/bridge/flight/status") return json(flightIn(solarSystemID));
    if (url === "/api/names") return json({ ok: true, names: {} });
    throw new Error(`unexpected fetch: ${url}`);
  };

  const store = createClientStore();
  const flow = createAppFlow(store, { fetch });
  await flow.loadFlightStatus();
  await flow.loadScanner();
  assert.equal(store.get().scanner.solarSystemID, SYSTEM_A);

  solarSystemID = SYSTEM_B;
  await flow.loadFlightStatus();
  for (let attempt = 0; attempt < 20 && store.get().scanner.solarSystemID !== SYSTEM_B; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(store.get().scanner.solarSystemID, SYSTEM_B);
  assert.equal(store.get().scanner.scan.status, "ready");
  assert.equal(scanReads, 2, "the old system and the new system are each read once");
});

test("sites asked for in one system are not shown as another's: the page pairs the answer with the system it was in when it asked", async () => {
  // sensorSuiteService (718): OnSignalTrackerFullState(session.solarsystemid2, ...GetFullState(), ...), the
  // session's system read before the call is made. The route said the BFF's word for the system beside the
  // sites; the page's own call has only the page's.
  let probesIn = SYSTEM_A;
  let refused = false;
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === CALL) return refused ? json({ ok: false, error: "CALL_REFUSED", message: "scanner offline" }, 409) : json(scanAnswer());
    if (url === "/api/bridge/scanner/state") return json(operationsEnvelope(probesIn));
    if (url === "/api/bridge/flight/status") return json(flightIn(SYSTEM_A));
    if (url === "/api/names") return json({ ok: true, names: {} });
    throw new Error(`unexpected fetch: ${url}`);
  };

  const store = createClientStore();
  const flow = createAppFlow(store, { fetch });
  await flow.loadFlightStatus();
  await flow.loadScanner();
  assert.deepEqual([store.get().scanner.solarSystemID, store.get().scanner.scan.status], [SYSTEM_A, "ready"]);

  // The ship jumps while the page still has it in the system before: the probes' state is the new system's.
  probesIn = SYSTEM_B;
  await flow.loadScanner();
  assert.deepEqual(store.get().scanner.scan, { status: "unavailable", reason: "The ship changed systems while scanner data was refreshing." });
  assert.equal(store.get().scanner.solarSystemID, SYSTEM_B);

  // A read that failed is a read that failed, there too: nothing was answered to pair with a system.
  refused = true;
  await flow.loadScanner();
  assert.deepEqual(store.get().scanner.scan, { status: "unavailable", reason: "Scanner data could not be read from the live session." });
});

test("with the pilot's flight not read yet, the sites go with the system the probes' state names", async () => {
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === CALL) return json(scanAnswer());
    if (url === "/api/bridge/scanner/state") return json(operationsEnvelope(SYSTEM_B));
    throw new Error(`unexpected fetch: ${url}`);
  };

  const store = createClientStore();
  await createAppFlow(store, { fetch }).loadScanner();

  assert.deepEqual([store.get().scanner.solarSystemID, store.get().scanner.scan.status], [SYSTEM_B, "ready"]);
});
